/**
 * A1: ліміт вартості одного запиту GraphQL Admin API. shopify.dev (rate limits): «A single query may not exceed a cost
 * of 1,000 points, regardless of plan limits. This limit is enforced before a query is executed based on the query's
 * requested cost.» Перевищення — помилка MAX_COST_EXCEEDED до виконання: синхронізація товару / імпорт замовлень
 * на робочому магазині не виконувались би.
 *
 * Тест рахує консервативну запитувану вартість (tests/helpers/shopify-query-cost.ts) КОЖНОГО експортованого запиту й
 * мутації з app/integrations/shopify/*.ts із фактичними розмірами сторінок застосунку й вимагає ≤ 950. Новий запит без
 * рядка в SIZES — помилка тесту (потрібно вказати, з якими розмірами його викликають).
 */
import { describe, expect, it, vi } from "vitest";
import { operationNameOf, wrapAdminGraphql, ShopifyApiError, QUERY_COST_WARN_THRESHOLD } from "~/integrations/shopify/admin-client.server";
import {
  ORDER_LINE_ITEMS_PAGE_SIZE,
  ORDER_LINE_ITEMS_PAGE_QUERY,
  ORDER_QUERY,
  ORDERS_PAGE_LINE_ITEMS,
  ORDERS_PAGE_QUERY,
  ORDERS_PAGE_SIZE,
  PRODUCT_QUERY,
  PRODUCT_VARIANTS_MAX_PAGES,
  PRODUCT_VARIANTS_PAGE_QUERY,
  PRODUCT_VARIANTS_PAGE_SIZE,
  PRODUCTS_PAGE_QUERY,
  PRODUCTS_PAGE_SIZE,
  PRODUCTS_PAGE_VARIANTS,
} from "~/integrations/shopify/graphql";
import { LOCATIONS_PAGE_SIZE, RECONCILE_PAGE_SIZE } from "~/integrations/shopify/inventory-graphql";
import {
  COLLECTION_PRODUCTS_PAGE_SIZE,
  COLLECTIONS_PAGE_SIZE,
  MEMBERSHIP_COLLECTIONS_FIRST,
  MEMBERSHIP_PRODUCTS_PAGE_SIZE,
  PRODUCT_COLLECTIONS_PAGE_SIZE,
} from "~/modules/shopify-sync/collections.server";
import { logger } from "~/lib/logger.server";
import { QUERY_COST_BUDGET, SHOPIFY_SINGLE_QUERY_LIMIT, operationName, parseOperation, requestedQueryCost } from "../helpers/shopify-query-cost";

const GID = "gid://shopify/Order/1";

/** Змінні, з якими застосунок виконує кожну операцію (розміри — ті самі константи, що й у викликах). */
const SIZES: Record<string, Record<string, unknown>> = {
  OtOrder: { id: GID },
  OtOrderLineItems: { id: GID, first: ORDER_LINE_ITEMS_PAGE_SIZE, after: "c1" },
  OtOrders: { first: ORDERS_PAGE_SIZE, after: null, query: "created_at:>=2026-01-01" },
  OtProduct: { id: GID },
  OtProductVariants: { id: GID, first: PRODUCT_VARIANTS_PAGE_SIZE, after: "c1" },
  OtProducts: { first: PRODUCTS_PAGE_SIZE, after: null },
  OtProductCollections: { id: GID, first: PRODUCT_COLLECTIONS_PAGE_SIZE, after: null },
  OtCollections: { first: COLLECTIONS_PAGE_SIZE, after: null },
  OtCollection: { id: GID, first: COLLECTION_PRODUCTS_PAGE_SIZE, after: null },
  OtProductMemberships: { first: MEMBERSHIP_PRODUCTS_PAGE_SIZE, after: null, collectionsFirst: MEMBERSHIP_COLLECTIONS_FIRST },
  OtInventoryItem: { id: GID },
  OtOrderUpdate: { input: {} },
  OtOrderAddressState: { id: GID },
  OtShopShipping: {},
  OtShop: {},
  OtInventoryAdjust: { input: {}, idempotencyKey: "k" },
  OtLocations: { first: LOCATIONS_PAGE_SIZE, after: null },
  // nodes(ids:) — розмір за кількістю id (звірка читає сторінками по RECONCILE_PAGE_SIZE).
  OtInventoryLevels: { ids: Array.from({ length: RECONCILE_PAGE_SIZE }, (_, i) => `gid://shopify/InventoryItem/${i}`), locationId: "gid://shopify/Location/1" },
  OtOrderFulfillmentState: { id: GID, after: null },
  OtFulfillmentCreate: { fulfillment: {} },
  OtCarrierServices: {},
  OtShopShippingFeatures: {},
  OtCarrierServiceCreate: { input: {} },
  OtCarrierServiceUpdate: { input: {} },
  OtCarrierServiceDelete: { id: GID },
};

const modules = import.meta.glob("/app/integrations/shopify/*.ts", { eager: true }) as Record<string, Record<string, unknown>>;
const documents = Object.entries(modules).flatMap(([file, mod]) =>
  Object.entries(mod)
    .filter((e): e is [string, string] => typeof e[1] === "string" && /^\s*#graphql\b/.test(e[1]))
    .map(([exportName, document]) => ({ file: file.split("/").pop()!, exportName, document })),
);

describe("estimator (tests/helpers/shopify-query-cost.ts)", () => {
  it("matches the documented example", () => {
    expect(requestedQueryCost("query Q { products(first: 1) { edges { node { title } } } }")).toBe(3);
  });

  it("aliases are costed as their field; comments are ignored", () => {
    const doc = `# коментар
      query Q { a: product(id: "1") { id } b: product(id: "2") { id title } }`;
    expect(requestedQueryCost(doc)).toBe(2);
    expect(parseOperation(doc).selections.map((s) => (s.kind === "field" ? s.alias : null))).toEqual(["a", "b"]);
  });

  it("substitutes variables (and defaults); a missing size variable is an error, not a guess", () => {
    const doc = "query Q($n: Int!, $m: Int = 4) { products(first: $n) { nodes { id variants(first: $m) { nodes { id } } } } }";
    // products: 2 + 5 × (вузол 1 + variants (2 + 4 × 1)) = 37
    expect(requestedQueryCost(doc, { n: 5 })).toBe(37);
    expect(requestedQueryCost(doc, { n: 5, m: 10 })).toBe(2 + 5 * (1 + 2 + 10));
    expect(() => requestedQueryCost(doc)).toThrow(/\$n not provided/);
  });

  it("skips directives (mutation @idempotent) and adds the mutation cost", () => {
    const doc = `mutation M($input: In!, $key: String!) {
      adjust(input: $input) @idempotent(key: $key) { group { id } userErrors { field message } }
    }`;
    expect(requestedQueryCost(doc, { input: {}, key: "k" })).toBe(10 + 1 + 1 + 1);
  });

  it("interface: shared fields + the most expensive inline fragment; nodes(ids:) sized by the number of ids", () => {
    const doc = `query Q($ids: [ID!]!) { nodes(ids: $ids) { id ... on A { x { y } } ... on B { z { w { v } } } ... on A { q { r } } } }`;
    // Вузол: 1 + max(A: x 1 + q 1 = 2, B: z 2) = 3; список: 2 + 3 id × 3 = 11.
    expect(requestedQueryCost(doc, { ids: ["1", "2", "3"] })).toBe(11);
    expect(requestedQueryCost(doc, { ids: Array(50).fill("x") })).toBe(2 + 50 * 3);
    expect(() => requestedQueryCost(doc)).toThrow(/ids/);
  });

  it("a plain sized list costs its elements as objects; pageInfo inside a connection is multiplied (conservative)", () => {
    expect(requestedQueryCost("query { order(id: 1) { fulfillments(first: 10) { id trackingInfo(first: 5) { number } } } }")).toBe(1 + 2 + 10 * (1 + 2 + 5));
    expect(requestedQueryCost("query { products(first: 10) { pageInfo { hasNextPage } nodes { id } } }")).toBe(2 + 10 * 2);
  });

  it("rejects named fragments instead of under-counting them", () => {
    expect(() => requestedQueryCost("query { shop { ...F } } fragment F on Shop { name }")).toThrow(/fragment/);
  });
});

describe("every Admin API document of the app stays under the single-query limit", () => {
  it("finds the app's documents", () => {
    expect(documents.length).toBeGreaterThanOrEqual(20);
    for (const f of ["graphql.ts", "inventory-graphql.ts", "fulfillment-graphql.ts", "carrier-service-graphql.ts"]) {
      expect(documents.some((d) => d.file === f)).toBe(true);
    }
  });

  it.each(documents.map((d) => [`${d.file} ${d.exportName}`, d] as const))("%s ≤ budget", (_label, d) => {
    const name = operationName(d.document);
    expect(name, `${d.exportName}: operation must be named`).toBeTruthy();
    // Назва операції в журналі вартості (admin-client) — та сама, що розбирає оцінка.
    expect(operationNameOf(d.document)).toBe(name);
    const vars = SIZES[name!];
    expect(vars, `${name}: add the page sizes it is called with to SIZES`).toBeDefined();
    const cost = requestedQueryCost(d.document, vars);
    expect(cost).toBeGreaterThan(0);
    expect(cost, `${name} requested cost`).toBeLessThanOrEqual(QUERY_COST_BUDGET);
  });

  it("the most expensive documents: exact estimates (catch silent growth)", () => {
    const cost = (doc: string) => requestedQueryCost(doc, SIZES[operationName(doc)!]);
    // Ціни позицій з discountedUnitPriceAfterAllDiscountsSet (A2) враховано.
    expect(cost(ORDER_QUERY)).toBe(11 + 9 * ORDER_LINE_ITEMS_PAGE_SIZE);
    expect(cost(ORDER_LINE_ITEMS_PAGE_QUERY)).toBe(3 + 9 * ORDER_LINE_ITEMS_PAGE_SIZE);
    expect(cost(ORDERS_PAGE_QUERY)).toBe(2 + ORDERS_PAGE_SIZE * (12 + 9 * ORDERS_PAGE_LINE_ITEMS));
    expect(cost(PRODUCT_QUERY)).toBe(9 + 7 * PRODUCT_VARIANTS_PAGE_SIZE);
    expect(cost(PRODUCT_VARIANTS_PAGE_QUERY)).toBe(3 + 7 * PRODUCT_VARIANTS_PAGE_SIZE);
    expect(cost(PRODUCTS_PAGE_QUERY)).toBe(2 + PRODUCTS_PAGE_SIZE * (10 + 7 * PRODUCTS_PAGE_VARIANTS));
    for (const doc of [ORDER_QUERY, ORDER_LINE_ITEMS_PAGE_QUERY, ORDERS_PAGE_QUERY, PRODUCT_QUERY, PRODUCT_VARIANTS_PAGE_QUERY, PRODUCTS_PAGE_QUERY]) {
      expect(cost(doc)).toBeLessThan(SHOPIFY_SINGLE_QUERY_LIMIT);
    }
  });

  it("previous page sizes exceeded the limit (regression guard for the estimator)", () => {
    // Розміри до A1: товар — 200 варіантів, список товарів 10 × 30, замовлень 10 × 15 (тепер ще й ціна після знижок).
    expect(requestedQueryCost(PRODUCT_QUERY.replace(`variants(first: ${PRODUCT_VARIANTS_PAGE_SIZE})`, "variants(first: 200)"), { id: GID })).toBeGreaterThan(1000);
    expect(requestedQueryCost(PRODUCTS_PAGE_QUERY.replace(`variants(first: ${PRODUCTS_PAGE_VARIANTS})`, "variants(first: 30)"), { first: 10 })).toBeGreaterThan(1000);
    expect(requestedQueryCost(ORDERS_PAGE_QUERY, { first: 10 })).toBeGreaterThan(1000);
  });

  it("2048 variants (Shopify maximum per product) fit into the variant page limit", () => {
    expect(PRODUCT_VARIANTS_PAGE_SIZE * PRODUCT_VARIANTS_MAX_PAGES).toBeGreaterThanOrEqual(2048);
  });
});

describe("admin client: cost visibility and GraphQL error classification", () => {
  const response = (body: unknown, headers: Record<string, string> = {}) => ({
    json: async () => body,
    headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  });

  it("warns (operation name and numbers only) when the requested cost is above the threshold", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const high = wrapAdminGraphql(async () =>
        response({ data: { ok: true }, extensions: { cost: { requestedQueryCost: QUERY_COST_WARN_THRESHOLD + 50, actualQueryCost: 42 } } }),
      );
      await high(PRODUCT_QUERY, { id: "gid://shopify/Product/1" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("shopify.query_cost_high", { operation: "OtProduct", requested: QUERY_COST_WARN_THRESHOLD + 50, actual: 42, limit: 1000 });
      // Без змінних запиту в журналі.
      expect(JSON.stringify(warn.mock.calls)).not.toContain("Product/1");

      const low = wrapAdminGraphql(async () => response({ data: { ok: true }, extensions: { cost: { requestedQueryCost: 300, actualQueryCost: 12 } } }));
      await low(PRODUCT_QUERY, { id: "x" });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("MAX_COST_EXCEEDED thrown by the Shopify library is a non-retryable error with the Shopify code (not a network error)", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      // Форма GraphqlQueryError (@shopify/shopify-api): відповідь 200 з errors → кидається з body.errors.graphQLErrors.
      const thrown = Object.assign(new Error("GraphQL query returned errors"), {
        response: { status: 200 },
        body: {
          errors: {
            networkStatusCode: 200,
            message: "GraphQL Client: An error occurred while fetching from the API. Review 'graphQLErrors' for details.",
            graphQLErrors: [
              {
                message: "Query cost is 2003, which exceeds the single query max cost limit (1000).",
                extensions: { code: "MAX_COST_EXCEEDED", cost: 2003, maxCost: 1000 },
              },
            ],
          },
        },
      });
      const admin = wrapAdminGraphql(async () => {
        throw thrown;
      });
      const err = await admin(PRODUCTS_PAGE_QUERY, { first: 10 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShopifyApiError);
      expect(err).toMatchObject({ code: "MAX_COST_EXCEEDED", retryable: false });
      expect((err as Error).message).toContain("exceeds the single query max cost limit");
      expect(warn).toHaveBeenCalledWith("shopify.query_cost_exceeded", { operation: "OtProducts", requested: 2003, limit: 1000 });
    } finally {
      warn.mockRestore();
    }
  });

  it("THROTTLED thrown by the library stays retryable; a real network failure stays NETWORK", async () => {
    const throttled = wrapAdminGraphql(async () => {
      throw Object.assign(new Error("x"), { body: { errors: { graphQLErrors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] } } });
    });
    await expect(throttled(ORDER_QUERY, { id: GID })).rejects.toMatchObject({ code: "THROTTLED", retryable: true });
    const network = wrapAdminGraphql(async () => {
      throw new Error("fetch failed");
    });
    await expect(network(ORDER_QUERY, { id: GID })).rejects.toMatchObject({ code: "NETWORK", retryable: true });
  });

  it("X-Request-Id: from the response headers or from the headers the library puts into the JSON body", async () => {
    const direct = wrapAdminGraphql(async () => response({ data: {} }, { "x-request-id": "req-1" }));
    await direct(ORDER_QUERY, { id: GID });
    expect(direct.lastRequestId).toBe("req-1");
    const viaBody = wrapAdminGraphql(async () => response({ data: {}, headers: { "X-Request-Id": ["req-2"] } }));
    await viaBody(ORDER_QUERY, { id: GID });
    expect(viaBody.lastRequestId).toBe("req-2");
  });
});

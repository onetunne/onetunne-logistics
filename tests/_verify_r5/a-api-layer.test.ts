/**
 * TEMPORARY adversarial checks of group A (R5) — independent reviewer. Delete after the review.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
const fetchBox = vi.hoisted(() => {
  const box: { impl: (...a: unknown[]) => Promise<Response> } = { impl: async () => { throw new Error("no stub"); } };
  (globalThis as { fetch: unknown }).fetch = (...a: unknown[]) => box.impl(...a);
  return box;
});
import "@shopify/shopify-api/adapters/node";
import { eq } from "drizzle-orm";
import { shopifyApi, Session, ApiVersion, LogSeverity } from "@shopify/shopify-api";
import { graphqlClientFactory } from "../../node_modules/@shopify/shopify-app-react-router/dist/esm/server/clients/admin/graphql.mjs";
import { wrapAdminGraphql, ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import * as G from "~/integrations/shopify/graphql";
import * as I from "~/integrations/shopify/inventory-graphql";
import * as F from "~/integrations/shopify/fulfillment-graphql";
import * as C from "~/modules/shopify-sync/collections.server";
import { requestedQueryCost } from "../helpers/shopify-query-cost";
import { customsUnitValues, shippedInvoiceLines } from "~/modules/customs/invoice";
import { readAllLineItems, readAllVariants, syncProduct } from "~/modules/shopify-sync/sync.server";
import { productVariants, products } from "~/db/schema";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { openTestDatabase } from "../helpers";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";
import { logger } from "~/lib/logger.server";

const GID = "gid://shopify/Order/1";

describe("hand-computed requested costs (reviewer arithmetic)", () => {
  // LINE: money 2 + money 2 + image 1 + variant{product} 2 = 7; node 8; pageInfo 1 → 9 per line.
  // ORDER fields: 3 money × 2 + shippingAddress 1 + billingAddress 1 = 8.
  it.each([
    ["OtOrder", G.ORDER_QUERY, { id: GID }, 1 + 8 + 2 + 50 * 9],
    ["OtOrderLineItems", G.ORDER_LINE_ITEMS_PAGE_QUERY, { id: GID, first: 50, after: "x" }, 1 + 2 + 50 * 9],
    ["OtOrders", G.ORDERS_PAGE_QUERY, { first: 5, after: null, query: "q" }, 2 + 5 * (1 + 1 + 8 + 2 + 15 * 9)],
    // VARIANT: selectedOptions 1 + image 1 + inventoryItem{measurement{weight}} 3 = 5; node 6; pageInfo 1 → 7.
    // PRODUCT: featuredMedia{preview{image}} 3 + 3 metafields = 6.
    ["OtProduct", G.PRODUCT_QUERY, { id: GID }, 1 + 6 + 2 + 100 * 7],
    ["OtProductVariants", G.PRODUCT_VARIANTS_PAGE_QUERY, { id: GID, first: 100, after: "x" }, 1 + 2 + 100 * 7],
    ["OtProducts", G.PRODUCTS_PAGE_QUERY, { first: 5, after: null }, 2 + 5 * (1 + 1 + 6 + 2 + 20 * 7)],
    ["OtProductMemberships", G.PRODUCT_MEMBERSHIPS_PAGE_QUERY, { first: 20, after: null, collectionsFirst: 15 }, 2 + 20 * (1 + 1 + 2 + 15 * 2)],
    ["OtCollection", G.COLLECTION_PRODUCTS_QUERY, { id: GID, first: 250, after: null }, 1 + 2 + 250 * 2],
    ["OtCollections", G.COLLECTIONS_PAGE_QUERY, { first: 100, after: null }, 2 + 100 * 2],
    ["OtProductCollections", G.PRODUCT_COLLECTIONS_QUERY, { id: GID, first: 50, after: null }, 1 + 2 + 50 * 2],
    ["OtInventoryLevels", I.INVENTORY_LEVELS_QUERY, { ids: Array(50).fill("x"), locationId: "l" }, 2 + 50 * (1 + 1 + 2 + 3)],
    ["OtLocations", I.LOCATIONS_QUERY, { first: 50, after: null }, 2 + 50 * 2],
    ["OtOrderFulfillmentState", F.ORDER_FULFILLMENT_STATE_QUERY, { id: GID, after: null }, 1 + (2 + 10 * (1 + 2 + 5)) + (2 + 10 * (1 + 1 + 1 + 2 + (2 + 20 * 2)))],
  ])("%s", (_n, doc, vars, expected) => {
    expect(requestedQueryCost(doc as string, vars as Record<string, unknown>)).toBe(expected);
    expect(expected).toBeLessThanOrEqual(950);
  });

  it("constants used by the callers are the ones costed", () => {
    expect([G.ORDER_LINE_ITEMS_PAGE_SIZE, G.ORDERS_PAGE_SIZE, G.ORDERS_PAGE_LINE_ITEMS, G.PRODUCT_VARIANTS_PAGE_SIZE, G.PRODUCTS_PAGE_SIZE, G.PRODUCTS_PAGE_VARIANTS]).toEqual([50, 5, 15, 100, 5, 20]);
    expect([C.MEMBERSHIP_PRODUCTS_PAGE_SIZE, C.MEMBERSHIP_COLLECTIONS_FIRST, C.COLLECTION_PRODUCTS_PAGE_SIZE, C.COLLECTIONS_PAGE_SIZE, C.PRODUCT_COLLECTIONS_PAGE_SIZE]).toEqual([20, 15, 250, 100, 50]);
    expect([I.RECONCILE_PAGE_SIZE, I.LOCATIONS_PAGE_SIZE]).toEqual([50, 50]);
  });
});

describe("real @shopify/shopify-api error path through wrapAdminGraphql", () => {
  const api = shopifyApi({
    apiKey: "k",
    apiSecretKey: "s",
    hostName: "localhost",
    apiVersion: ApiVersion.October26,
    isEmbeddedApp: true,
    scopes: [],
    logger: { level: LogSeverity.Error, log: () => undefined },
  });
  const session = new Session({ id: "offline_x", shop: "x.myshopify.com", state: "", isOnline: false, accessToken: "t" });
  const query = graphqlClientFactory({ params: { api } as never, session } as never) as never;

  function stubFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
    fetchBox.impl = async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  }

  it("MAX_COST_EXCEEDED from a real library throw is non-retryable with the Shopify code and logged", async () => {
    stubFetch(200, {
      errors: [{ message: "Query cost is 2003, which exceeds the single query max cost limit (1000).", extensions: { code: "MAX_COST_EXCEEDED", cost: 2003, maxCost: 1000 } }],
    }, { "x-request-id": "rid-1" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const admin = wrapAdminGraphql(query);
      const err = await admin(G.PRODUCTS_PAGE_QUERY, { first: 10, after: null }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ShopifyApiError);
      expect(err).toMatchObject({ code: "MAX_COST_EXCEEDED", retryable: false });
      expect(warn).toHaveBeenCalledWith("shopify.query_cost_exceeded", { operation: "OtProducts", requested: 2003, limit: 1000 });
    } finally {
      warn.mockRestore();
    }
  });

  it("THROTTLED from a real library throw stays retryable", async () => {
    stubFetch(200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    const admin = wrapAdminGraphql(query);
    await expect(admin(G.ORDER_QUERY, { id: GID })).rejects.toMatchObject({ code: "THROTTLED", retryable: true });
  });

  it("success: cost warning from real extensions and request id from canonicalized body headers", async () => {
    stubFetch(200, { data: { shop: { currencyCode: "EUR" } }, extensions: { cost: { requestedQueryCost: 900, actualQueryCost: 10 } } }, { "x-request-id": "rid-2" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      const admin = wrapAdminGraphql(query);
      await admin(G.SHOP_CURRENCY_QUERY);
      expect(admin.lastRequestId).toBe("rid-2");
      expect(warn).toHaveBeenCalledWith("shopify.query_cost_high", { operation: "OtShop", requested: 900, actual: 10, limit: 1000 });
    } finally {
      warn.mockRestore();
    }
  });

  it("5xx stays a retryable HTTP error", async () => {
    stubFetch(502, { errors: "Bad gateway" });
    const admin = wrapAdminGraphql(query);
    await expect(admin(G.ORDER_QUERY, { id: GID })).rejects.toMatchObject({ retryable: true });
  });
});

describe("pagination limits at the edges", () => {
  function variants(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      id: `gid://shopify/ProductVariant/9${i}`,
      title: `V${i}`,
      sku: `S${i}`,
      barcode: null,
      price: "1.00",
      inventoryQuantity: 0,
      selectedOptions: [],
      image: null,
      inventoryItem: { id: `gid://shopify/InventoryItem/9${i}`, tracked: true, harmonizedSystemCode: null, countryCodeOfOrigin: null, measurement: { weight: { unit: "GRAMS", value: 1 } } },
    }));
  }
  function pagedVariantsAdmin(all: ReturnType<typeof variants>, opts: { nullAt?: number } = {}) {
    let calls = 0;
    const admin = (async (_q: string, v?: Record<string, unknown>) => {
      calls++;
      const start = Number(v?.after ?? 0);
      if (opts.nullAt !== undefined && calls >= opts.nullAt) return { product: null };
      const size = Number(v?.first);
      return {
        product: {
          id: "gid://shopify/Product/77",
          updatedAt: "2026-11-20T10:00:00Z",
          variants: { nodes: all.slice(start, start + size), pageInfo: { hasNextPage: start + size < all.length, endCursor: start + size < all.length ? String(start + size) : null } },
        },
      };
    }) as never;
    return { admin, calls: () => calls };
  }
  const first = (all: ReturnType<typeof variants>) =>
    gqlProduct(77, { variants: { nodes: all.slice(0, 100), pageInfo: { hasNextPage: all.length > 100, endCursor: all.length > 100 ? "100" : null } } as never });

  it("exactly 2048 variants → complete", async () => {
    const all = variants(2048);
    const a = pagedVariantsAdmin(all);
    const r = await readAllVariants(a.admin, first(all));
    expect(r.complete).toBe(true);
    expect(r.product.variants.nodes).toHaveLength(2048);
    expect(a.calls()).toBe(20);
  });

  it("2201 variants (beyond the page cap) → incomplete, not silently complete", async () => {
    const all = variants(2201);
    const a = pagedVariantsAdmin(all);
    const r = await readAllVariants(a.admin, first(all));
    expect(r.complete).toBe(false);
    expect(r.product.variants.nodes.length).toBeLessThan(2201);
  });

  it("product disappears between variant pages → incomplete", async () => {
    const all = variants(250);
    const a = pagedVariantsAdmin(all, { nullAt: 2 });
    const r = await readAllVariants(a.admin, first(all));
    expect(r.complete).toBe(false);
  });

  it("exactly 1000 lines → read completely; 1001 → tooManyLineItems", async () => {
    const mk = (n: number) => Array.from({ length: n }, (_, i) => ({ ...gqlOrder(1).lineItems.nodes[0]!, id: `gid://shopify/LineItem/${i}` }));
    for (const [n, ok] of [[1000, true], [1001, false]] as const) {
      const all = mk(n);
      const admin = (async (_q: string, v?: Record<string, unknown>) => {
        const start = Number(v?.after);
        const size = Number(v?.first);
        return { order: { id: GID, updatedAt: "2026-11-20T10:00:00Z", lineItems: { nodes: all.slice(start, start + size), pageInfo: { hasNextPage: start + size < all.length, endCursor: String(start + size) } } } };
      }) as never;
      const o = gqlOrder(1, { id: GID, lineItems: { nodes: all.slice(0, 50), pageInfo: { hasNextPage: true, endCursor: "50" } } });
      const res = readAllLineItems(admin, o);
      if (ok) expect((await res).lineItems.nodes).toHaveLength(1000);
      else await expect(res).rejects.toMatchObject({ code: "shopify.tooManyLineItems" });
    }
  });
});

describe("A2 customs unit value edges", () => {
  it("any line without the Shopify price → allocation for all lines (no mixing)", () => {
    const items = [
      { unitPrice: "100.00", quantity: 1, discountedUnitPrice: "50.00" },
      { unitPrice: "100.00", quantity: 1, discountedUnitPrice: null },
    ];
    expect(customsUnitValues(items, "150.00")).toEqual(["75.00", "75.00"]);
  });
  it("Shopify price used even if subtotal disagrees; removed units not declared", () => {
    const items = [
      { unitPrice: "100.00", quantity: 3, currentQuantity: 1, discountedUnitPrice: "80.00", title: "a", sku: null, currency: "EUR", variant: null },
    ];
    const lines = shippedInvoiceLines(items as never, "10.00");
    expect(lines).toEqual([expect.objectContaining({ quantity: 1, unitValue: "80.00" })]);
  });
});

describe("A4 removed_at with a variant that reappears via a list page", () => {
  let h: DatabaseHandle;
  beforeAll(async () => {
    h = await openTestDatabase();
    await seedReferenceData(h.db, DEMO_SETTINGS);
  });
  afterAll(async () => h.close());

  it("removed variant reappears on complete re-read; incomplete read clears marks", async () => {
    const two = gqlProduct(88, {
      variants: {
        nodes: [gqlProduct(88).variants.nodes[0]!, { ...gqlProduct(88).variants.nodes[0]!, id: "gid://shopify/ProductVariant/8802", sku: "S-8802" }],
      },
    });
    const one = { ...two, updatedAt: "2026-11-21T10:00:00Z", variants: { nodes: [two.variants.nodes[0]!] } };
    let current: unknown = two;
    const admin = (async () => ({ product: current })) as never;
    await syncProduct(h.db, admin, two.id, "EUR");
    current = one;
    await syncProduct(h.db, admin, two.id, "EUR");
    const rows = async () =>
      h.db
        .select({ gid: productVariants.shopifyVariantId, removedAt: productVariants.removedAt })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(eq(products.shopifyProductId, two.id));
    expect((await rows()).filter((r) => r.removedAt).map((r) => r.gid)).toEqual(["gid://shopify/ProductVariant/8802"]);
    current = { ...two, updatedAt: "2026-11-22T10:00:00Z" };
    await syncProduct(h.db, admin, two.id, "EUR");
    expect((await rows()).every((r) => r.removedAt === null)).toBe(true);
  });
});

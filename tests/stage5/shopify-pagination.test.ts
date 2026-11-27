/**
 * A1: після зменшення розмірів сторінок (ліміт вартості одного запиту — 1000 балів) нічого не обрізається мовчки.
 * - Варіанти товару (до 2048 на товар — «If querying a single product at the root, you can fetch up to 2048 variants»,
 *   Product.variants, 2026-10) дочитуються сторінками (PRODUCT_VARIANTS_PAGE_QUERY); variantsComplete — лише коли
 *   прочитано всі сторінки одного стану товару.
 * - Позиції замовлення дочитуються сторінками (ORDER_LINE_ITEMS_PAGE_QUERY); неповне читання — помилка, часткові
 *   позиції не зберігаються.
 * Кожен виклик імітації Admin API оцінюється з ФАКТИЧНИМИ змінними (costCheckedAdmin) і не перевищує 950 балів; лише
 * читання (жодних мутацій).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { orderLineItems, orders, productVariants, products } from "~/db/schema";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import {
  ORDER_LINE_ITEMS_MAX_PAGES,
  ORDER_LINE_ITEMS_PAGE_SIZE,
  ORDERS_PAGE_LINE_ITEMS,
  ORDERS_PAGE_SIZE,
  PRODUCT_VARIANTS_PAGE_SIZE,
  PRODUCTS_PAGE_SIZE,
  PRODUCTS_PAGE_VARIANTS,
  type GqlOrder,
  type GqlProduct,
  type GqlVariant,
} from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { importOrdersPage, syncOrder, syncProduct, syncProductsPage } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { QUERY_COST_BUDGET, costCheckedAdmin, operationName } from "../helpers/shopify-query-cost";
import { OWNER, openTestDatabase } from "../helpers";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";

const SHOP = "ot-paging.myshopify.com";
const READ_OPERATIONS = new Set(["OtShop", "OtProduct", "OtProductVariants", "OtProducts", "OtOrder", "OtOrderLineItems", "OtOrders"]);

let h: DatabaseHandle;
let ctx: ServiceContext;
beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = {
    mode: "production",
    db: h.db,
    actor: OWNER,
    carriers: createDemoCarriers(h.db),
    shopify: new QueueingShopifyGateway(h.db, async () => SHOP),
    now: () => new Date(),
  };
});
afterAll(async () => {
  await h.close();
});

function variant(productN: number, i: number): GqlVariant {
  const id = `${productN}${String(i).padStart(4, "0")}`;
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: `V${i}`,
    sku: `P${productN}-${i}`,
    barcode: null,
    price: "10.00",
    inventoryQuantity: 1,
    selectedOptions: [],
    image: null,
    inventoryItem: {
      id: `gid://shopify/InventoryItem/${id}`,
      tracked: true,
      harmonizedSystemCode: "871410",
      countryCodeOfOrigin: "UA",
      measurement: { weight: { unit: "GRAMS", value: 100 } },
    },
  };
}

function bigProduct(n: number, count: number): GqlProduct {
  return gqlProduct(n, { variants: { nodes: Array.from({ length: count }, (_, i) => variant(n, i + 1)) } });
}

type Line = GqlOrder["lineItems"]["nodes"][number];
function line(orderN: number, i: number, v: GqlVariant | null, productGid: string | null): Line {
  return {
    id: `gid://shopify/LineItem/${orderN}${String(i).padStart(4, "0")}`,
    title: `Item ${i}`,
    variantTitle: null,
    sku: v?.sku ?? `L-${i}`,
    quantity: 1,
    currentQuantity: 1,
    originalUnitPriceSet: { shopMoney: { amount: "10.00", currencyCode: "EUR" } },
    discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: "9.00", currencyCode: "EUR" } },
    image: null,
    variant: v ? { id: v.id, product: productGid ? { id: productGid } : null } : null,
  };
}

function bigOrder(n: number, count: number, product?: GqlProduct): GqlOrder {
  const nodes = Array.from({ length: count }, (_, i) => {
    const v = product?.variants.nodes[i % product.variants.nodes.length] ?? null;
    return line(n, i + 1, v, product?.id ?? null);
  });
  return gqlOrder(n, { lineItems: { nodes } });
}

/** Імітація Admin API з посторінковими з'єднаннями (курсор — позиція наступного елемента). */
function pagedShopify() {
  const productStore = new Map<string, GqlProduct>();
  const orderStore = new Map<string, GqlOrder>();
  const calls: Array<{ op: string | null; variables?: Record<string, unknown> }> = [];
  const hooks: { onVariantsPage?: (p: GqlProduct) => void; onLinesPage?: (o: GqlOrder) => void } = {};
  const page = <T>(all: readonly T[], start: number, size: number) => ({
    nodes: all.slice(start, start + size),
    pageInfo: { hasNextPage: start + size < all.length, endCursor: start + size < all.length ? String(start + size) : null },
  });
  const raw = async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
    const op = operationName(query);
    calls.push({ op, variables });
    const id = String(variables?.id ?? "");
    const after = variables?.after ? Number(variables.after) : 0;
    switch (op) {
      case "OtShop":
        return { shop: { currencyCode: "EUR" } };
      case "OtProduct": {
        const p = productStore.get(id);
        return { product: p ? { ...p, variants: page(p.variants.nodes, 0, PRODUCT_VARIANTS_PAGE_SIZE) } : null };
      }
      case "OtProductVariants": {
        const before = productStore.get(id);
        if (before) hooks.onVariantsPage?.(before);
        const p = productStore.get(id);
        return { product: p ? { id: p.id, updatedAt: p.updatedAt, variants: page(p.variants.nodes, after, Number(variables?.first)) } : null };
      }
      case "OtProducts": {
        const list = page([...productStore.values()], after, Number(variables?.first));
        return { products: { ...list, nodes: list.nodes.map((p) => ({ ...p, variants: page(p.variants.nodes, 0, PRODUCTS_PAGE_VARIANTS) })) } };
      }
      case "OtOrder": {
        const o = orderStore.get(id);
        return { order: o ? { ...o, lineItems: page(o.lineItems.nodes, 0, ORDER_LINE_ITEMS_PAGE_SIZE) } : null };
      }
      case "OtOrderLineItems": {
        const before = orderStore.get(id);
        if (before) hooks.onLinesPage?.(before);
        const o = orderStore.get(id);
        return { order: o ? { id: o.id, updatedAt: o.updatedAt, lineItems: page(o.lineItems.nodes, after, Number(variables?.first)) } : null };
      }
      case "OtOrders": {
        const list = page([...orderStore.values()], after, Number(variables?.first));
        return { orders: { ...list, nodes: list.nodes.map((o) => ({ ...o, lineItems: page(o.lineItems.nodes, 0, ORDERS_PAGE_LINE_ITEMS) })) } };
      }
      default:
        throw new Error(`unexpected operation ${op}`);
    }
  };
  const admin = costCheckedAdmin(raw as <T>(q: string, v?: Record<string, unknown>) => Promise<T>);
  return { productStore, orderStore, calls, hooks, admin };
}

async function variantsOf(productGid: string) {
  return h.db
    .select({ gid: productVariants.shopifyVariantId, removedAt: productVariants.removedAt })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(products.shopifyProductId, productGid));
}

async function storedLines(orderGid: string) {
  const [o] = await h.db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyOrderId, orderGid));
  if (!o) return null;
  return h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id)).orderBy(orderLineItems.position);
}

function expectReadOnlyWithinBudget(s: ReturnType<typeof pagedShopify>) {
  expect(s.calls.every((c) => READ_OPERATIONS.has(c.op ?? ""))).toBe(true);
  expect(s.admin.costs.length).toBe(s.calls.length);
  expect(Math.max(...s.admin.costs.map((c) => c.cost))).toBeLessThanOrEqual(QUERY_COST_BUDGET);
}

describe("product variants are read completely", () => {
  it("250 variants over three pages are all saved; a later complete read marks only the variant Shopify removed", async () => {
    const s = pagedShopify();
    const p = bigProduct(31, 250);
    s.productStore.set(p.id, p);
    expect(await syncProduct(h.db, s.admin, p.id, "EUR")).toBe("saved");
    expect(s.calls.map((c) => [c.op, c.variables?.after ?? null])).toEqual([
      ["OtProduct", null],
      ["OtProductVariants", String(PRODUCT_VARIANTS_PAGE_SIZE)],
      ["OtProductVariants", String(2 * PRODUCT_VARIANTS_PAGE_SIZE)],
    ]);
    expect(s.calls.filter((c) => c.op === "OtProductVariants").every((c) => c.variables?.first === PRODUCT_VARIANTS_PAGE_SIZE)).toBe(true);
    const saved = await variantsOf(p.id);
    expect(saved).toHaveLength(250);
    expect(saved.every((v) => v.removedAt === null)).toBe(true);
    expectReadOnlyWithinBudget(s);

    // Shopify видалив варіант №230 (третя сторінка): повне читання позначає лише його.
    const removed = p.variants.nodes[229]!.id;
    s.productStore.set(p.id, { ...p, updatedAt: "2026-11-21T10:00:00Z", variants: { nodes: p.variants.nodes.filter((v) => v.id !== removed) } });
    expect(await syncProduct(h.db, s.admin, p.id, "EUR")).toBe("saved");
    const after = await variantsOf(p.id);
    expect(after.filter((v) => v.removedAt !== null).map((v) => v.gid)).toEqual([removed]);
  });

  it("the product changes between variant pages → the list is incomplete: nothing is marked removed", async () => {
    const s = pagedShopify();
    const p = bigProduct(32, 150);
    s.productStore.set(p.id, p);
    await syncProduct(h.db, s.admin, p.id, "EUR");
    // Варіант №120 (друга сторінка) видалено, і під час читання товар знову змінюється (updatedAt) — сторінки з різних станів.
    const gone = p.variants.nodes[119]!.id;
    const edited = { ...p, updatedAt: "2026-11-22T10:00:00Z", variants: { nodes: p.variants.nodes.filter((v) => v.id !== gone) } };
    s.productStore.set(p.id, edited);
    s.hooks.onVariantsPage = (cur) => s.productStore.set(cur.id, { ...cur, updatedAt: "2026-11-22T10:05:00Z" });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      expect(await syncProduct(h.db, s.admin, p.id, "EUR")).toBe("saved");
      expect(warn).toHaveBeenCalledWith("shopify.product_variants_incomplete", expect.objectContaining({ product: p.id }));
    } finally {
      warn.mockRestore();
    }
    const after = await variantsOf(p.id);
    expect(after).toHaveLength(150);
    expect(after.every((v) => v.removedAt === null)).toBe(true);
  });

  it("a page without a cursor ends the read as incomplete (no endless loop)", async () => {
    const p = bigProduct(33, 3);
    const calls: string[] = [];
    const admin = costCheckedAdmin((async (q: string) => {
      calls.push(operationName(q) ?? "");
      return { product: { ...p, id: p.id, variants: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: p.variants.nodes } } };
    }) as <T>(q: string) => Promise<T>);
    expect(await syncProduct(h.db, admin, p.id, "EUR")).toBe("saved");
    expect(calls).toEqual(["OtProduct"]);
  });

  it("full product sync: the list page uses PRODUCTS_PAGE_SIZE; a product with more variants than fit is re-read in full", async () => {
    const s = pagedShopify();
    const small = bigProduct(34, 3);
    const large = bigProduct(35, PRODUCTS_PAGE_VARIANTS + 15);
    s.productStore.set(small.id, small);
    s.productStore.set(large.id, large);
    await syncProductsPage(h.db, s.admin, SHOP, null, "EUR");
    expect(s.calls[0]).toMatchObject({ op: "OtProducts", variables: { first: PRODUCTS_PAGE_SIZE } });
    expect(s.calls.filter((c) => c.op === "OtProduct").map((c) => c.variables?.id)).toEqual([large.id]);
    expect(await variantsOf(small.id)).toHaveLength(3);
    expect(await variantsOf(large.id)).toHaveLength(PRODUCTS_PAGE_VARIANTS + 15);
    expectReadOnlyWithinBudget(s);
  });
});

describe("order line items are never truncated", () => {
  it("an order with 120 lines (three pages) is stored with all 120 lines in Shopify order", async () => {
    const s = pagedShopify();
    const p = bigProduct(36, 120);
    s.productStore.set(p.id, p);
    const o = bigOrder(9101, 120, p);
    s.orderStore.set(o.id, o);
    const r = await syncOrder(ctx, s.admin, o.id, "import");
    expect(r.result).toBe("created");
    const lines = await storedLines(o.id);
    expect(lines).toHaveLength(120);
    expect(lines!.map((l) => l.shopifyLineItemId)).toEqual(o.lineItems.nodes.map((n) => n.id));
    expect(lines!.every((l) => l.variantId !== null)).toBe(true);
    expect(s.calls.filter((c) => c.op === "OtOrderLineItems").map((c) => [c.variables?.after, c.variables?.first])).toEqual([
      [String(ORDER_LINE_ITEMS_PAGE_SIZE), ORDER_LINE_ITEMS_PAGE_SIZE],
      [String(2 * ORDER_LINE_ITEMS_PAGE_SIZE), ORDER_LINE_ITEMS_PAGE_SIZE],
    ]);
    expectReadOnlyWithinBudget(s);
  });

  it("the order changes between line pages → retryable error, nothing stored (no partial lines)", async () => {
    const s = pagedShopify();
    const o = bigOrder(9102, 70);
    s.orderStore.set(o.id, o);
    s.hooks.onLinesPage = (cur) => s.orderStore.set(cur.id, { ...cur, updatedAt: "2026-11-20T10:30:00Z" });
    const err = await syncOrder(ctx, s.admin, o.id, "import").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err).toMatchObject({ code: "ORDER_CHANGED_DURING_READ", retryable: true });
    expect(await storedLines(o.id)).toBeNull();
  });

  it("more lines than the read limit → shopify.tooManyLineItems, nothing stored", async () => {
    const s = pagedShopify();
    const limit = ORDER_LINE_ITEMS_MAX_PAGES * ORDER_LINE_ITEMS_PAGE_SIZE;
    const o = bigOrder(9103, limit + 1);
    s.orderStore.set(o.id, o);
    const err = await syncOrder(ctx, s.admin, o.id, "import").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DomainError);
    expect(err).toMatchObject({ code: "shopify.tooManyLineItems", params: { order: o.name, max: limit } });
    expect(s.calls.filter((c) => c.op === "OtOrderLineItems")).toHaveLength(ORDER_LINE_ITEMS_MAX_PAGES - 1);
    expect(await storedLines(o.id)).toBeNull();
  });

  it("import: the orders page uses ORDERS_PAGE_SIZE; a listed order with more lines than the list shows is re-read with all lines", async () => {
    const s = pagedShopify();
    const short = bigOrder(9104, 2);
    const long = bigOrder(9105, ORDERS_PAGE_LINE_ITEMS + ORDER_LINE_ITEMS_PAGE_SIZE + 5);
    s.orderStore.set(short.id, short);
    s.orderStore.set(long.id, long);
    const state = await importOrdersPage(ctx, s.admin, { shop: SHOP, since: "2026-01-01" });
    expect(state).toMatchObject({ imported: 2, failed: [] });
    expect(s.calls[0]).toMatchObject({ op: "OtOrders", variables: { first: ORDERS_PAGE_SIZE } });
    expect(s.calls.filter((c) => c.op === "OtOrder").map((c) => c.variables?.id)).toEqual([long.id]);
    expect(await storedLines(short.id)).toHaveLength(2);
    expect(await storedLines(long.id)).toHaveLength(ORDERS_PAGE_LINE_ITEMS + ORDER_LINE_ITEMS_PAGE_SIZE + 5);
    expectReadOnlyWithinBudget(s);
  });
});

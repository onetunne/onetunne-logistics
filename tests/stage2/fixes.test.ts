/** Регресійні тести за результатами ручного тестування етапу 2 у реальному магазині. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, jobs, orders, productVariants, shopInstallations } from "~/db/schema";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { buildOrderUpdateInput, fieldFromShopify, recordInstallation, startOrdersImport } from "~/modules/shopify-sync/sync.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { updateOrderData } from "~/modules/orders/workflow.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import type { ServiceContext } from "~/server/types";
import { openTestDatabase, OWNER } from "../helpers";
import { fakeAdmin, gqlOrder, gqlProduct } from "./fixtures";

const SHOP = "ot-test.myshopify.com";
let h: DatabaseHandle;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let handlers: ReturnType<typeof createSyncHandlers>;
const run = () => runJobsOnce(h.db, handlers, { limit: 100 });
let n = 0;
const paid = (gid: string) => handleShopifyWebhook(h.db, { topic: "ORDERS_PAID", shop: SHOP, webhookId: `fx-${++n}`, payload: { admin_graphql_api_id: gid } });
const row = async (gid: string) => (await h.db.select().from(orders).where(eq(orders.shopifyOrderId, gid)))[0]!;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map([["gid://shopify/Product/1", gqlProduct(1)]]) };
  fake = fakeAdmin(store);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new QueueingShopifyGateway(h.db, async () => SHOP), now: () => new Date() };
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
  await recordInstallation(h.db, SHOP, "write_orders,read_products,read_inventory");
  await run();
});
afterAll(async () => {
  await h.close();
});

describe("international address push to Shopify", () => {
  it("sends every address field explicitly so stale region/zip of the old country are cleared", () => {
    const input = buildOrderUpdateInput({
      shopifyOrderId: "gid://shopify/Order/1", email: null, contactPhone: null,
      shipFirstName: "A", shipLastName: "B", shipCompany: null, shipAddress1: "Rua 1", shipAddress2: null,
      shipCity: "Lisboa", shipProvince: "Lisboa", shipPostalCode: "1100-148", shipCountryCode: "PT", shipPhone: null,
    } as never);
    expect(input.shippingAddress).toMatchObject({ provinceCode: null, company: null, zip: "1100-148", countryCode: "PT" });
    expect(Object.values(input.shippingAddress).includes(undefined as never)).toBe(false);
  });

  it("maps Shopify userErrors to form fields", () => {
    expect(fieldFromShopify(["input", "shippingAddress", "zip"])).toBe("shipping.postalCode");
    expect(fieldFromShopify(["shippingAddress", "countryCode"])).toBe("shipping.countryCode");
    expect(fieldFromShopify(["shippingAddress", "phone"])).toBe("shipping.phone");
    expect(fieldFromShopify(["phone"])).toBe("contactPhone");
    expect(fieldFromShopify(null)).toBeNull();
  });

  it("Shopify rejection → problem next to the field; after a fix the problem and dead job are cleared", async () => {
    store.orders.set("gid://shopify/Order/7001", gqlOrder(7001));
    await paid("gid://shopify/Order/7001");
    await run();
    let o = await row("gid://shopify/Order/7001");
    fake.failUpdatesWith([{ field: ["shippingAddress", "zip"], message: "Enter a valid postal code for Portugal" }]);
    await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { countryCode: "PT", city: "Lisboa", postalCode: "1100-148" } });
    await run();
    const open = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_SYNC_FAILED")));
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ field: "shipping.postalCode", params: { message: "Enter a valid postal code for Portugal" } });
    const dead = await h.db.select().from(jobs).where(eq(jobs.status, "dead"));
    expect(dead).toHaveLength(1);

    fake.failUpdatesWith([]);
    o = await row("gid://shopify/Order/7001");
    const res = await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { postalCode: "1100-149" } });
    expect(res.sync).toEqual({ status: "queued" });
    await run();
    const stillOpen = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_SYNC_FAILED")));
    expect(stillOpen).toHaveLength(0);
    expect(await h.db.select().from(jobs).where(eq(jobs.status, "dead"))).toHaveLength(0);
  });

  it("an address with known validation errors is not sent to Shopify", async () => {
    const o = await row("gid://shopify/Order/7001");
    const before = fake.calls.filter((c) => c.op === "OtOrderUpdate").length;
    const res = await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { postalCode: "ABC" } });
    expect(res.sync).toEqual({ status: "skipped", reason: "invalid_data" });
    await run();
    expect(fake.calls.filter((c) => c.op === "OtOrderUpdate").length).toBe(before);
  });
});

describe("stock", () => {
  it("untracked inventory is null, not zero", () => {
    const p = gqlProduct(3);
    p.variants.nodes[0]!.inventoryItem!.tracked = false;
    expect(mapProduct(p).variants[0]?.inventoryAvailable).toBeNull();
  });

  it("products with more variants than a page are re-read in full", async () => {
    const big = gqlProduct(9);
    big.variants.pageInfo = { hasNextPage: true };
    const full = gqlProduct(9, { variants: { pageInfo: { hasNextPage: false }, nodes: [
      gqlProduct(9).variants.nodes[0]!,
      { ...gqlProduct(9).variants.nodes[0]!, id: "gid://shopify/ProductVariant/902", sku: "SKU-9B" },
    ] } });
    store.products.clear();
    store.products.set(big.id, big);
    const origAdmin = fake.admin;
    handlers = createSyncHandlers({
      db: h.db,
      serviceContext: () => ctx,
      admin: async () => (async (q: string, v?: Record<string, unknown>) =>
        /query OtProduct\b/.test(q) ? { product: full } : origAdmin(q, v)) as typeof origAdmin,
    });
    await h.db.update(shopInstallations).set({ productsSyncedAt: null });
    await recordInstallation(h.db, SHOP, null);
    await run();
    const skus = (await h.db.select().from(productVariants)).map((v) => v.sku);
    expect(skus).toContain("SKU-9B");
    handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
  });
});

describe("import robustness", () => {
  it("one failing order does not stop the import; missing orders are created", async () => {
    store.orders.clear();
    const broken = gqlOrder(8002);
    broken.lineItems.pageInfo = { hasNextPage: true }; // і повторне читання теж неповне → помилка цього замовлення
    store.orders.set("gid://shopify/Order/8001", gqlOrder(8001));
    store.orders.set("gid://shopify/Order/8002", broken);
    store.orders.set("gid://shopify/Order/8003", gqlOrder(8003));
    await startOrdersImport(h.db, SHOP, "2026-01-01");
    await runJobsOnce(h.db, handlers, { limit: 10 });
    expect(await row("gid://shopify/Order/8001")).toBeTruthy();
    expect(await row("gid://shopify/Order/8003")).toBeTruthy();
    const [inst] = await h.db.select().from(shopInstallations).where(eq(shopInstallations.shop, SHOP));
    expect(inst?.importState).toMatchObject({ status: "done", imported: 2, failed: ["#8002"] });
  });
});

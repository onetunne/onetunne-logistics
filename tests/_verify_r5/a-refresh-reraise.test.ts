/** TEMPORARY reviewer check (group A, A3): periodic refresh vs DB≠Shopify contact data on shipped orders. Delete after review. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orders, shipments } from "~/db/schema";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { recordInstallation } from "~/modules/shopify-sync/sync.server";
import { runFulfillmentRefresh } from "~/modules/shopify-sync/fulfillment-refresh.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { openTestDatabase, OWNER } from "../helpers";
import type { ServiceContext } from "~/server/types";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { fakeAdmin, gqlOrder, gqlProduct } from "../stage2/fixtures";

const SHOP = "ot-rr.myshopify.com";
let h: DatabaseHandle;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let handlers: ReturnType<typeof createSyncHandlers>;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map() };
  fake = fakeAdmin(store);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new QueueingShopifyGateway(h.db, async () => SHOP), now: () => new Date() };
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
});
afterAll(async () => h.close());

const run = () => runJobsOnce(h.db, handlers, { limit: 100 });

describe("refresh re-reads shipped orders whose contact data differs from Shopify", () => {
  it("auto-fixed phone (not pushed) → every refresh re-opens SHOPIFY_ORDER_CHANGED after it was resolved", async () => {
    store.products.set("gid://shopify/Product/1", gqlProduct(1));
    await recordInstallation(h.db, SHOP, "read_orders,read_products");
    await run();
    const gid = "gid://shopify/Order/7001";
    // Local German number (auto-fix → E.164) — Shopify keeps the original.
    store.orders.set(gid, gqlOrder(7001, { shippingAddress: { ...gqlOrder().shippingAddress!, phone: "015123456789" } }));
    await handleShopifyWebhook(h.db, { topic: "ORDERS_PAID", shop: SHOP, webhookId: "w-7001", payload: { admin_graphql_api_id: gid } });
    await run();
    let [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, gid));
    console.log("status", o!.status, "shipPhone", o!.shipPhone);
    if (o!.status !== "waybill_created") expect((await createWaybill(ctx, o!.id)).kind).toBe("created");
    // Handed over 3 days ago; Shopify still unfulfilled (fulfillment webhook missed / push failed).
    const past = new Date(Date.now() - 3 * 24 * 3600_000);
    await h.db.update(shipments).set({ handedOverAt: past }).where(eq(shipments.orderId, o!.id));
    await h.db.update(orders).set({ status: "handed_to_carrier" }).where(eq(orders.id, o!.id));
    [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, gid));
    console.log("phone in DB", o!.shipPhone);

    const openChanged = () =>
      h.db.select().from(issues).where(and(eq(issues.orderId, o!.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED"), eq(issues.status, "open")));
    const before = await openChanged();
    console.log("open SHOPIFY_ORDER_CHANGED before refresh", before.length, "pushes", fake.calls.filter((c) => c.op === "OtOrderUpdate").length);
    await handleShopifyWebhook(h.db, { topic: "ORDERS_UPDATED", shop: SHOP, webhookId: "w-7001-u", payload: { admin_graphql_api_id: gid } });
    await run();
    console.log("open after plain webhook re-read (pre-existing path)", (await openChanged()).length);
    await h.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(and(eq(issues.orderId, o!.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED")));

    console.log("refresh 1", await runFulfillmentRefresh(h.db, new Date()));
    await run();
    const after1 = await openChanged();
    console.log("open after refresh 1", after1.length, after1.map((i) => i.params));
    await h.db.update(issues).set({ status: "resolved", resolvedAt: new Date() }).where(and(eq(issues.orderId, o!.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED")));
    console.log("refresh 2 (+25h)", await runFulfillmentRefresh(h.db, new Date(Date.now() + 25 * 3600_000)));
    await runJobsOnce(h.db, handlers, { limit: 100, now: new Date(Date.now() + 25 * 3600_000) } as never);
    const after2 = await openChanged();
    console.log("open after refresh 2", after2.length);
    const all = await h.db.select({ s: issues.status }).from(issues).where(and(eq(issues.orderId, o!.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED")));
    console.log("total SHOPIFY_ORDER_CHANGED rows", all.length);
  });
});

/**
 * Етап 4: стан передачі виправлених контактів/адреси в Shopify і «Повторно надіслати в Shopify».
 * Стан виводиться з черги (shopify.push_order, dedupeKey push:<shopifyOrderId>) і відкритих проблем
 * SHOPIFY_SYNC_FAILED / SHOPIFY_COUNTRY_NOT_SHIPPED. Admin API — імітація (tests/stage2/fixtures.ts).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { issues, jobs, orders } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { updateOrderData } from "~/modules/orders/workflow.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import {
  JOB,
  derivePushState,
  loadShopifyPushState,
  pushDedupeKey,
  recordInstallation,
  resendOrderToShopify,
} from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, openTestDatabase } from "../helpers";
import { fakeAdmin, gqlOrder, gqlProduct } from "../stage2/fixtures";

describe("derivePushState (pure)", () => {
  const t0 = new Date("2026-11-20T10:00:00Z");
  const t1 = new Date("2026-11-20T11:00:00Z");
  const base = { gateway: "admin_api" as const, shopifyOrderId: "gid://shopify/Order/1", lastConfirmedChangeAt: t0, jobs: [], failures: [] };
  const failure = { code: "SHOPIFY_SYNC_FAILED" as const, field: "shipping.postalCode", message: "Zip is invalid", params: { message: "Zip is invalid" } };

  it("demo and not linked come first", () => {
    expect(derivePushState({ ...base, gateway: "demo" })).toEqual({ state: "demo", hasChanges: true });
    expect(derivePushState({ ...base, gateway: "demo", lastConfirmedChangeAt: null })).toEqual({ state: "demo", hasChanges: false });
    expect(derivePushState({ ...base, shopifyOrderId: null })).toEqual({ state: "not_linked", hasChanges: true });
  });

  it("no changes and no jobs → none; changes without a job → not_sent", () => {
    expect(derivePushState({ ...base, lastConfirmedChangeAt: null })).toEqual({ state: "none" });
    expect(derivePushState(base)).toEqual({ state: "not_sent", lastChangeAt: t0 });
  });

  it("queued/running wins (with retry info and previous failures); superseded jobs are ignored", () => {
    expect(
      derivePushState({
        ...base,
        jobs: [
          { status: "queued", attempts: 2, lastError: "HTTP 502", updatedAt: t1 },
          { status: "failed", attempts: 1, lastError: "superseded", updatedAt: new Date("2026-11-20T12:00:00Z") },
        ],
        failures: [failure],
      }),
    ).toEqual({ state: "queued", at: t1, retrying: true, lastError: "HTTP 502", failures: [failure] });
    expect(derivePushState({ ...base, jobs: [{ status: "running", attempts: 1, lastError: null, updatedAt: t1 }] })).toMatchObject({
      state: "queued",
      retrying: false,
    });
  });

  it("dead job or open failure → failed with Shopify's message", () => {
    expect(derivePushState({ ...base, jobs: [{ status: "dead", attempts: 6, lastError: "Zip is invalid", updatedAt: t1 }] })).toEqual({
      state: "failed",
      at: t1,
      lastError: "Zip is invalid",
      failures: [],
    });
    expect(derivePushState({ ...base, failures: [failure] })).toEqual({ state: "failed", at: null, lastError: null, failures: [failure] });
  });

  it("succeeded after the last change → synced; a newer change → not_sent", () => {
    expect(derivePushState({ ...base, jobs: [{ status: "succeeded", attempts: 1, lastError: null, updatedAt: t1 }] })).toEqual({
      state: "synced",
      at: t1,
    });
    const later = new Date("2026-11-20T13:00:00Z");
    expect(
      derivePushState({ ...base, lastConfirmedChangeAt: later, jobs: [{ status: "succeeded", attempts: 1, lastError: null, updatedAt: t1 }] }),
    ).toEqual({ state: "not_sent", lastChangeAt: later });
  });
});

describe("resendOrderToShopify with the queueing gateway", () => {
  const SHOP = "ot-test.myshopify.com";
  const GID = "gid://shopify/Order/7001";
  let h: DatabaseHandle;
  let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
  let fake: ReturnType<typeof fakeAdmin>;
  let ctx: ServiceContext;
  let handlers: ReturnType<typeof createSyncHandlers>;
  let orderId: string;
  const run = () => runJobsOnce(h.db, handlers, { limit: 100 });
  const pushJobs = () => h.db.select().from(jobs).where(and(eq(jobs.type, JOB.pushOrder), eq(jobs.dedupeKey, pushDedupeKey(GID))));
  const state = async () => loadShopifyPushState(h.db, ctx.shopify.kind, (await h.db.select().from(orders).where(eq(orders.id, orderId)))[0]!);
  const order = async () => (await h.db.select().from(orders).where(eq(orders.id, orderId)))[0]!;

  beforeAll(async () => {
    h = await openTestDatabase();
    await seedReferenceData(h.db, DEMO_SETTINGS);
    store = { orders: new Map(), products: new Map([["gid://shopify/Product/1", gqlProduct(1)]]) };
    fake = fakeAdmin(store);
    ctx = {
      mode: "production",
      db: h.db,
      actor: OWNER,
      carriers: createDemoCarriers(h.db),
      shopify: new QueueingShopifyGateway(h.db, async () => SHOP),
      now: () => new Date(),
    };
    handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
    await recordInstallation(h.db, SHOP, "read_orders,write_orders");
    await run();
    store.orders.set(GID, gqlOrder(7001));
    await handleShopifyWebhook(h.db, { topic: "ORDERS_PAID", shop: SHOP, webhookId: "wh-7001", payload: { admin_graphql_api_id: GID } });
    await run();
    const [row] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, GID));
    orderId = row!.id;
  });
  afterAll(async () => {
    await h.close();
  });

  it("no confirmed changes → none; a manual correction queues one push job", async () => {
    expect(await state()).toEqual({ state: "none" });
    const o = await order();
    const res = await updateOrderData(ctx, orderId, { expectedVersion: o.version, shipping: { address1: "Neue Straße 7" } });
    expect(res.sync).toEqual({ status: "queued" });
    expect(await state()).toMatchObject({ state: "queued", retrying: false });
  });

  it("re-sending while a push is queued does not duplicate the job (dedupe)", async () => {
    expect(await resendOrderToShopify(ctx, orderId)).toEqual({ status: "queued" });
    expect(await resendOrderToShopify(ctx, orderId)).toEqual({ status: "queued" });
    expect((await pushJobs()).filter((j) => j.status === "queued")).toHaveLength(1);
    await run();
    expect((await pushJobs()).filter((j) => j.status === "queued")).toHaveLength(0);
    expect(await state()).toMatchObject({ state: "synced" });
  });

  it("Shopify rejection → failed with Shopify's own message; re-send queues again and success clears it", async () => {
    fake.failUpdatesWith([{ field: ["shippingAddress", "zip"], message: "Zip is invalid" }]);
    const o = await order();
    await updateOrderData(ctx, orderId, { expectedVersion: o.version, shipping: { address2: "Hinterhaus" } });
    await run();
    const failed = await state();
    expect(failed).toMatchObject({
      state: "failed",
      failures: [{ code: "SHOPIFY_SYNC_FAILED", field: "shipping.postalCode", message: "Zip is invalid" }],
    });

    fake.failUpdatesWith([]);
    expect(await resendOrderToShopify(ctx, orderId)).toEqual({ status: "queued" });
    expect(await state()).toMatchObject({ state: "queued", failures: [{ message: "Zip is invalid" }] });
    await run();
    expect(await state()).toMatchObject({ state: "synced" });
    const open = await h.db.select().from(issues).where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_SYNC_FAILED")));
    expect(open).toHaveLength(0);
  });

  it("data with validation errors is not sent; permission is checked on the server", async () => {
    const [issue] = await h.db
      .insert(issues)
      .values({ orderId, code: "CITY_MISSING", severity: "error", field: "shipping.city", params: {}, fingerprint: `${orderId}:CITY_MISSING:test` })
      .returning();
    const before = (await pushJobs()).length;
    expect(await resendOrderToShopify(ctx, orderId)).toEqual({ status: "skipped", reason: "invalid_data" });
    expect(await pushJobs()).toHaveLength(before);
    await h.db.delete(issues).where(eq(issues.id, issue!.id));

    const viewer = makeActor({ id: "test-viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["orders.edit"] } });
    await expect(resendOrderToShopify({ ...ctx, actor: viewer }, orderId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("demo gateway: nothing is queued, state 'demo'", async () => {
    const demo: ServiceContext = { ...ctx, mode: "demo", shopify: new DemoShopifyGateway() };
    const before = (await pushJobs()).length;
    expect(await resendOrderToShopify(demo, orderId)).toEqual({ status: "skipped", reason: "demo_mode" });
    expect(await pushJobs()).toHaveLength(before);
    expect(await loadShopifyPushState(h.db, "demo", await order())).toEqual({ state: "demo", hasChanges: true });
  });

  it("an order without a Shopify link is reported as not linked", async () => {
    await h.db.update(orders).set({ shopifyOrderId: null }).where(eq(orders.id, orderId));
    try {
      expect(await resendOrderToShopify(ctx, orderId)).toEqual({ status: "skipped", reason: "not_linked" });
      expect(await state()).toEqual({ state: "not_linked", hasChanges: true });
    } finally {
      await h.db.update(orders).set({ shopifyOrderId: GID }).where(eq(orders.id, orderId));
    }
  });
});

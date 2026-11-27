/**
 * A3: застарілий статус виконання відправлених застосунком замовлень (webhook міг загубитися) → планове повторне читання
 * замовлення через звичайний шлях синхронізації (shopify.sync_order; лише читання Shopify).
 * Ланцюжок: одне очікуване завдання (dedupe), перезапуск сервера його не переносить; пропуск без встановлення / дозволу
 * читати замовлення; не більше FULFILLMENT_REFRESH_BATCH замовлень за перевірку; кожне — не частіше ніж раз на добу.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { issues, jobs, orderChanges, orders, shipments, shopInstallations } from "~/db/schema";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { enqueueOrderResync } from "~/modules/shopify-sync/pending-lines.server";
import { orderRefreshDedupeKey } from "~/modules/shopify-sync/jobs";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import {
  FULFILLMENT_RECHECK_MS,
  FULFILLMENT_REFRESH_BATCH,
  FULFILLMENT_REFRESH_DEDUPE_KEY,
  FULFILLMENT_REFRESH_INTERVAL_MS,
  ORDERS_DEFAULT_READ_WINDOW_MS,
  STALE_FULFILLMENT_AFTER_MS,
  runFulfillmentRefresh,
  scheduleFulfillmentRefreshCheck,
} from "~/modules/shopify-sync/fulfillment-refresh.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { JOB, upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, openTestDatabase } from "../helpers";
import { fakeAdmin, gqlOrder, gqlProduct } from "../stage2/fixtures";

const SHOP = "ot-refresh.myshopify.com";
const DAY = 24 * 60 * 60_000;
let h: DatabaseHandle;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
let fake: ReturnType<typeof fakeAdmin>;
let handlers: ReturnType<typeof createSyncHandlers>;
let ctx: ServiceContext;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map() };
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
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  fake.calls.length = 0;
  await h.db.delete(jobs);
});

let seq = 0;
/** Замовлення Shopify, передане перевізнику застосунком handedDaysAgo днів тому. */
async function shippedOrder(o: {
  handedDaysAgo: number;
  placedDaysAgo?: number;
  fulfillment?: string | null;
  shippable?: boolean | null;
  status?: "handed_to_carrier" | "delivered" | "packed";
  checkedAt?: Date | null;
  withShipment?: boolean;
}) {
  seq++;
  const gid = `gid://shopify/Order/6${String(seq).padStart(4, "0")}`;
  const now = Date.now();
  const [row] = await h.db
    .insert(orders)
    .values({
      source: "shopify",
      shopifyOrderId: gid,
      orderNumber: `#R-${seq}`,
      status: o.status ?? "handed_to_carrier",
      currency: "EUR",
      subtotal: "10.00",
      total: "10.00",
      fulfillmentStatus: o.fulfillment === undefined ? "unfulfilled" : o.fulfillment,
      shopifyShippableFulfilled: o.shippable ?? null,
      placedAt: new Date(now - (o.placedDaysAgo ?? o.handedDaysAgo + 1) * DAY),
      shopifyUpdatedAt: new Date("2026-11-20T10:00:00Z"),
      shopifyFulfillmentCheckedAt: o.checkedAt ?? null,
    })
    .returning({ id: orders.id });
  if (o.withShipment !== false) {
    await h.db.insert(shipments).values({
      orderId: row!.id,
      carrierCode: "nova_post",
      mode: "live",
      status: "created",
      carrierReference: `OT-R${seq}-1`,
      waybillNumber: `2045${String(seq).padStart(10, "0")}`,
      createdBy: "test",
      handedOverAt: new Date(now - o.handedDaysAgo * DAY),
    });
  }
  return { id: row!.id, gid };
}

async function install(scopes: string | null) {
  await h.db.delete(shopInstallations);
  await h.db.insert(shopInstallations).values({ shop: SHOP, scopes });
}

async function queuedSyncs(): Promise<string[]> {
  const rows = await h.db.select({ payload: jobs.payload }).from(jobs).where(and(eq(jobs.type, JOB.syncOrder), eq(jobs.status, "queued")));
  return rows.map((r) => String((r.payload as Record<string, unknown>).orderGid)).sort();
}

async function scheduledChecks() {
  return h.db.select({ runAt: jobs.runAt }).from(jobs).where(and(eq(jobs.type, JOB.fulfillmentRefresh), eq(jobs.status, "queued")));
}

describe("stale fulfillment refresh", () => {
  it("not installed → nothing read; the next check is still scheduled (the chain never breaks)", async () => {
    await h.db.delete(shopInstallations);
    await shippedOrder({ handedDaysAgo: 5 });
    const now = new Date();
    expect(await runFulfillmentRefresh(h.db, now)).toEqual({ status: "not_installed" });
    expect(await queuedSyncs()).toEqual([]);
    const [next] = await scheduledChecks();
    expect(next!.runAt.getTime()).toBe(now.getTime() + FULFILLMENT_REFRESH_INTERVAL_MS);
  });

  it("without a scope that reads orders → skipped", async () => {
    await install("read_products,read_inventory");
    expect(await runFulfillmentRefresh(h.db)).toEqual({ status: "missing_scope" });
    expect(await queuedSyncs()).toEqual([]);
  });

  it("queues a read-only re-read only for shipped orders still unfulfilled in the DB after N days; the sync applies Shopify's status", async () => {
    await install("write_orders,read_products");
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" }); // попередні тести
    const stale = await shippedOrder({ handedDaysAgo: 3 });
    // Часткове виконання лише позицій без доставки (цифрова картка) — фізичні одиниці ще «в дорозі» (orderTiming).
    const partial = await shippedOrder({ handedDaysAgo: 4, status: "delivered", fulfillment: "partially_fulfilled", shippable: false });
    const fresh = await shippedOrder({ handedDaysAgo: STALE_FULFILLMENT_AFTER_MS / DAY / 4 });
    const done = await shippedOrder({ handedDaysAgo: 5, fulfillment: "fulfilled" });
    const notShipped = await shippedOrder({ handedDaysAgo: 5, status: "packed" });
    const outsideApp = await shippedOrder({ handedDaysAgo: 0, placedDaysAgo: 6, withShipment: false, fulfillment: null });
    const now = new Date();
    expect(await runFulfillmentRefresh(h.db, now)).toEqual({ status: "queued", orders: 3 });
    expect(await queuedSyncs()).toEqual([stale.gid, partial.gid, outsideApp.gid].sort());
    const checked = await h.db.select({ id: orders.id, at: orders.shopifyFulfillmentCheckedAt }).from(orders).where(inArray(orders.id, [stale.id, fresh.id, done.id, notShipped.id]));
    expect(Object.fromEntries(checked.map((c) => [c.id, c.at?.getTime() ?? null]))).toEqual({
      [stale.id]: now.getTime(),
      [fresh.id]: null,
      [done.id]: null,
      [notShipped.id]: null,
    });

    // Shopify уже виконав замовлення (webhook загубився) → повторне читання оновлює статус; у Shopify нічого не пишеться.
    for (const o of [stale, partial, outsideApp]) {
      store.orders.set(o.gid, gqlOrder(Number(o.gid.split("/").pop()), { id: o.gid, updatedAt: "2026-11-24T10:00:00Z", displayFulfillmentStatus: "FULFILLED" }));
    }
    await runJobsOnce(h.db, handlers, { limit: 20 });
    const after = await h.db.select({ id: orders.id, fs: orders.fulfillmentStatus, status: orders.status }).from(orders).where(inArray(orders.id, [stale.id, partial.id, outsideApp.id]));
    expect(after.every((o) => o.fs === "fulfilled")).toBe(true);
    expect(after.find((o) => o.id === partial.id)?.status).toBe("delivered");
    expect(fake.calls.map((c) => c.op).filter((op) => /Update|Create|Adjust|Delete/.test(op))).toEqual([]);
    expect(fake.calls.some((c) => c.op === "OtOrder")).toBe(true);
    // Оновлені замовлення більше не застарілі; через 2 дні застарілим стає лише «свіже» (тепер передане понад N днів тому).
    await h.db.delete(jobs);
    expect(await runFulfillmentRefresh(h.db, new Date(now.getTime() + 2 * FULFILLMENT_RECHECK_MS))).toEqual({ status: "queued", orders: 1 });
    expect(await queuedSyncs()).toEqual([fresh.gid]);
  });

  it("each order at most once per recheck interval; batch-limited, oldest-checked first", async () => {
    await install("write_orders");
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" });
    const many = [];
    for (let i = 0; i < FULFILLMENT_REFRESH_BATCH + 3; i++) many.push(await shippedOrder({ handedDaysAgo: 10 }));
    const now = new Date();
    expect(await runFulfillmentRefresh(h.db, now)).toEqual({ status: "queued", orders: FULFILLMENT_REFRESH_BATCH });
    // Наступна перевірка того ж дня бере лише ще не перевірені.
    const soon = new Date(now.getTime() + FULFILLMENT_REFRESH_INTERVAL_MS);
    expect(await runFulfillmentRefresh(h.db, soon)).toEqual({ status: "queued", orders: 3 });
    expect(await runFulfillmentRefresh(h.db, new Date(soon.getTime() + 60_000))).toEqual({ status: "nothing_stale" });
    // Через інтервал повторної перевірки (Shopify так і не виконав) — знову, найдавніше перевірені першими.
    const nextDay = new Date(now.getTime() + FULFILLMENT_RECHECK_MS + 60_000);
    expect(await runFulfillmentRefresh(h.db, nextDay)).toEqual({ status: "queued", orders: FULFILLMENT_REFRESH_BATCH });
    const [first] = await h.db.select({ at: orders.shopifyFulfillmentCheckedAt }).from(orders).where(eq(orders.id, many[0]!.id));
    expect(first!.at?.getTime()).toBe(nextDay.getTime());
  });

  it("orders older than 60 days are re-read only with read_all_orders", async () => {
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" });
    const old = await shippedOrder({ handedDaysAgo: 50, placedDaysAgo: ORDERS_DEFAULT_READ_WINDOW_MS / DAY + 5 });
    await install("write_orders");
    expect(await runFulfillmentRefresh(h.db)).toEqual({ status: "nothing_stale" });
    await install("write_orders,read_all_orders");
    expect(await runFulfillmentRefresh(h.db)).toEqual({ status: "queued", orders: 1 });
    expect(await queuedSyncs()).toEqual([old.gid]);
  });

  it("one queued check at a time; a server restart does not postpone it; the job handler runs it", async () => {
    await install("write_orders");
    const t0 = new Date("2026-11-27T08:00:00Z");
    expect(await scheduleFulfillmentRefreshCheck(h.db, { now: t0, delayMs: 30 * 60_000 })).toBe(true);
    // Перезапуск сервера: нове планування не переносить уже заплановану перевірку.
    expect(await scheduleFulfillmentRefreshCheck(h.db, { now: new Date(t0.getTime() + 10 * 60_000), delayMs: 30 * 60_000 })).toBe(false);
    const [only] = await scheduledChecks();
    expect(only!.runAt.toISOString()).toBe(new Date(t0.getTime() + 30 * 60_000).toISOString());
    const [job] = await h.db.select({ dedupeKey: jobs.dedupeKey }).from(jobs).where(eq(jobs.type, JOB.fulfillmentRefresh));
    expect(job!.dedupeKey).toBe(FULFILLMENT_REFRESH_DEDUPE_KEY);
    // Обробник (час перевірки настав): ланцюжок продовжується одним новим завданням.
    await h.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.type, JOB.fulfillmentRefresh));
    await runJobsOnce(h.db, { [JOB.fulfillmentRefresh]: handlers[JOB.fulfillmentRefresh]! }, { limit: 1 });
    const queued = await scheduledChecks();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now() + FULFILLMENT_REFRESH_INTERVAL_MS - 60_000);
  });
});

describe("the refresh re-read applies only what the app missed (A3-R1)", () => {
  async function queuedSyncModes(orderGid: string): Promise<string[]> {
    const rows = await h.db.select({ payload: jobs.payload }).from(jobs).where(and(eq(jobs.type, JOB.syncOrder), eq(jobs.status, "queued")));
    return rows
      .map((r) => r.payload as Record<string, unknown>)
      .filter((p) => p.orderGid === orderGid)
      .map((p) => String(p.mode))
      .sort();
  }

  it("candidates follow the reconcile in-flight rule: restocked and physical partial fulfilment are not re-read", async () => {
    await install("write_orders");
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" });
    const unfulfilled = await shippedOrder({ handedDaysAgo: 5 });
    const digitalOnly = await shippedOrder({ handedDaysAgo: 5, fulfillment: "partially_fulfilled", shippable: false });
    await shippedOrder({ handedDaysAgo: 5, fulfillment: "partially_fulfilled", shippable: true });
    await shippedOrder({ handedDaysAgo: 5, fulfillment: "partially_fulfilled", shippable: null });
    await shippedOrder({ handedDaysAgo: 5, fulfillment: "restocked" });
    expect(await runFulfillmentRefresh(h.db)).toEqual({ status: "queued", orders: 2 });
    expect(await queuedSyncs()).toEqual([unfulfilled.gid, digitalOnly.gid].sort());
  });

  it("an unchanged shipped order is not re-applied: one read, the order row untouched, no problems or history rows (auto-fixed phone)", async () => {
    await install("write_orders");
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" });
    await upsertProduct(h.db, mapProduct(gqlProduct(1)), "EUR");
    const n = 69001;
    const shopify = gqlOrder(n, { shippingAddress: { ...gqlOrder(n).shippingAddress!, phone: "015123456789" } });
    store.orders.set(shopify.id, shopify);
    const { orderId } = await upsertOrder(ctx, mapOrder(shopify), "live");
    expect((await createWaybill(ctx, orderId!)).kind).toBe("created");
    const [shipment] = await h.db.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, orderId!));
    await markHandedOver(ctx, shipment!.id);
    await h.db.update(shipments).set({ handedOverAt: new Date(Date.now() - 3 * DAY) }).where(eq(shipments.id, shipment!.id));
    await h.db.delete(jobs);
    const before = (await h.db.select().from(orders).where(eq(orders.id, orderId!)))[0]!;
    expect(before).toMatchObject({ status: "handed_to_carrier", shipPhone: "+4915123456789", fulfillmentStatus: "unfulfilled" });
    const historyBefore = (await h.db.select({ id: orderChanges.id }).from(orderChanges).where(eq(orderChanges.orderId, orderId!))).length;

    const now = new Date();
    for (const at of [now, new Date(now.getTime() + FULFILLMENT_RECHECK_MS + 60 * 60_000)]) {
      fake.calls.length = 0;
      expect(await runFulfillmentRefresh(h.db, at)).toEqual({ status: "queued", orders: 1 });
      await runJobsOnce(h.db, { [JOB.syncOrder]: handlers[JOB.syncOrder]! }, { limit: 5 });
      expect(fake.calls.map((c) => c.op)).toEqual(["OtOrder"]);
    }
    const after = (await h.db.select().from(orders).where(eq(orders.id, orderId!)))[0]!;
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(after.version).toBe(before.version);
    expect((await h.db.select({ id: orderChanges.id }).from(orderChanges).where(eq(orderChanges.orderId, orderId!))).length).toBe(historyBefore);
    expect(await h.db.select().from(issues).where(and(eq(issues.orderId, orderId!), eq(issues.code, "SHOPIFY_ORDER_CHANGED")))).toEqual([]);
  });

  it("the same updatedAt but a different fulfillment status in Shopify is still applied", async () => {
    await install("write_orders");
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" });
    const o = await shippedOrder({ handedDaysAgo: 5 });
    store.orders.set(o.gid, gqlOrder(Number(o.gid.split("/").pop()), { id: o.gid, updatedAt: "2026-11-20T10:00:00Z", displayFulfillmentStatus: "FULFILLED" }));
    expect(await runFulfillmentRefresh(h.db)).toEqual({ status: "queued", orders: 1 });
    await runJobsOnce(h.db, { [JOB.syncOrder]: handlers[JOB.syncOrder]! }, { limit: 5 });
    const [row] = await h.db.select({ fs: orders.fulfillmentStatus }).from(orders).where(eq(orders.id, o.id));
    expect(row!.fs).toBe("fulfilled");
  });

  it("a queued refresh read does not swallow a regular re-read of the same order", async () => {
    await install("write_orders");
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" });
    const o = await shippedOrder({ handedDaysAgo: 5 });
    expect(await runFulfillmentRefresh(h.db)).toEqual({ status: "queued", orders: 1 });
    expect(await queuedSyncModes(o.gid)).toEqual(["refresh"]);
    expect(await enqueueOrderResync(h.db, { source: "shopify", shopifyOrderId: o.gid })).toBe("queued");
    expect(await queuedSyncModes(o.gid)).toEqual(["live", "refresh"]);
  });

  it("a refresh read never creates an order the app does not have", async () => {
    await install("write_orders");
    const unknown = gqlOrder(69002);
    store.orders.set(unknown.id, unknown);
    await enqueueJob(h.db, JOB.syncOrder, { shop: SHOP, orderGid: unknown.id, mode: "refresh" }, { dedupeKey: orderRefreshDedupeKey(unknown.id) });
    await runJobsOnce(h.db, { [JOB.syncOrder]: handlers[JOB.syncOrder]! }, { limit: 5 });
    expect(await h.db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyOrderId, unknown.id))).toEqual([]);
    expect(fake.calls.map((c) => c.op)).toEqual(["OtOrder"]);
  });
});

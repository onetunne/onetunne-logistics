/**
 * Етап 6 (WP3): завдання синхронізації фінансів (docs/stage6-design.md §16.3, §16.4): реєстр ядра підхоплює обробники
 * пакета; finance.reconcile_scheduled → finance.reconcile (водяний знак − 1 год, ≤ 20 сторінок, продовження курсором);
 * finance.backfill_orders (одноразово, курсор, старші 60 днів → order_unreadable без запиту, початковий водяний знак);
 * webhook REFUNDS_CREATE → finance.sync_order → факти; повтор webhook — без нових рядків. Вигадані дані.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { financeDiscrepancies, financeState, jobs, orders, orderShopifyFinance, shopInstallations } from "~/db/schema";
import { createFinanceJobHandlers, ensureFinanceSchedules } from "~/modules/finance/jobs.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING } from "~/modules/finance/jobs";
import { BACKFILL_PAGE_SIZE, RECONCILE_OVERLAP_MS, runFinanceBackfill, runFinanceReconcile, runReconcileScheduled } from "~/modules/finance-sync/scheduled.server";
import { handlers as financeSyncHandlers } from "~/modules/finance-sync/jobs.server";
import { getFinanceSyncStatus, requestFinanceBackfill } from "~/modules/finance-sync/facts-view.server";
import { claimJob, completeJob } from "~/modules/jobs/queue.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { agreement, bag, financeNode, g2Fixture, refund, refundLine, sale, transaction, SHOP } from "../fixtures/shopify-finance";
import { factCounts, openFinanceSyncEnv, osfOf, type FinanceSyncEnv } from "./helpers";

vi.mock("~/modules/order-finance/sync.server", () => ({ syncOrderFinance: async () => undefined }));

let env: FinanceSyncEnv;
beforeAll(async () => {
  env = await openFinanceSyncEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await env.db.delete(jobs);
});

const gid = (n: number) => `gid://shopify/Order/${n}`;
const deps = () => ({ db: env.db, serviceContext: () => env.ctx, admin: async () => env.fake.admin });
const queued = async (type: string) => env.db.select().from(jobs).where(and(eq(jobs.type, type), eq(jobs.status, "queued")));

/** Виконати одне завдання вказаного типу через обробники реєстру ядра (час — у майбутньому, щоб узяти відкладене). */
async function runOne(type: string, at = new Date(Date.now() + 2 * 24 * 3600_000)) {
  const h = createFinanceJobHandlers(deps());
  // Інші завдання не беремо: позначаємо їх «у майбутньому» на час виконання.
  const others = (await env.db.select().from(jobs).where(eq(jobs.status, "queued"))).filter((j) => j.type !== type);
  for (const o of others) await env.db.update(jobs).set({ runAt: new Date(at.getTime() + 3600_000) }).where(eq(jobs.id, o.id));
  const job = await claimJob(env.db, "test", at);
  if (!job) throw new Error(`no ${type} job`);
  expect(job.type).toBe(type);
  await h[job.type]!.run(job);
  await completeJob(env.db, job);
  for (const o of others) await env.db.update(jobs).set({ runAt: o.runAt }).where(eq(jobs.id, o.id));
  return job;
}

describe("registry and schedules", () => {
  it("the core registry exposes exactly the four WP3 handlers", () => {
    const own = Object.keys(financeSyncHandlers(deps())).sort();
    expect(own).toEqual([FINANCE_JOB.backfillOrders, FINANCE_JOB.reconcile, FINANCE_JOB.reconcileScheduled, FINANCE_JOB.syncOrder].sort());
    const all = createFinanceJobHandlers(deps());
    for (const name of own) expect(all[name]).toBeDefined();
  });

  it("ensureFinanceSchedules: reconcile chain in 10 min (not moved later), backfill while backfilled_at is empty", async () => {
    const t = Date.now();
    await ensureFinanceSchedules(env.db);
    const [chain] = await queued(FINANCE_JOB.reconcileScheduled);
    expect(chain!.runAt.getTime() - t).toBeGreaterThanOrEqual(FINANCE_JOB_TIMING.reconcileFirstDelayMs - 5_000);
    expect(chain!.runAt.getTime() - t).toBeLessThan(FINANCE_JOB_TIMING.reconcileFirstDelayMs + 60_000);
    expect(await queued(FINANCE_JOB.backfillOrders)).toHaveLength(1);
    await ensureFinanceSchedules(env.db);
    expect(await queued(FINANCE_JOB.reconcileScheduled)).toHaveLength(1);
    expect(await queued(FINANCE_JOB.backfillOrders)).toHaveLength(1);
    // Після заповнення — більше не ставиться.
    await env.db.update(financeState).set({ backfilledAt: new Date() });
    await env.db.delete(jobs);
    await ensureFinanceSchedules(env.db);
    expect(await queued(FINANCE_JOB.backfillOrders)).toHaveLength(0);
    await env.db.update(financeState).set({ backfilledAt: null, backfillCursor: null, reconcileWatermark: null });
  });
});

describe("finance.backfill_orders (one-off, §16.3)", () => {
  it("queues finance.sync_order for stored non-test orders without facts, spaced; old ones → order_unreadable without a request", async () => {
    const recent = await env.createOrder(9301, { createdAt: new Date().toISOString(), processedAt: new Date().toISOString() });
    const old = await env.createOrder(9302, { createdAt: "2026-01-10T10:00:00Z", processedAt: "2026-01-10T10:00:00Z" });
    const testOrder = await env.createOrder(9303, { test: true, createdAt: new Date().toISOString(), processedAt: new Date().toISOString() });
    env.fake.calls.length = 0;
    const t = new Date();
    const out = await runFinanceBackfill(env.db, t);
    expect(out).toMatchObject({ status: "page", queued: 1, unreadable: 1, done: true });
    expect(env.fake.calls).toEqual([]); // заповнення саме нічого не читає з Shopify
    const q = await queued(FINANCE_JOB.syncOrder);
    expect(q.map((j) => (j.payload as { orderGid: string }).orderGid)).toEqual([gid(9301)]);
    expect((await osfOf(env.db, old))!.flags).toEqual(["order_unreadable"]);
    expect(await osfOf(env.db, testOrder)).toBeUndefined();
    expect(await osfOf(env.db, recent)).toBeUndefined();
    const [state] = await env.db.select().from(financeState);
    expect(state!.backfilledAt?.getTime()).toBe(t.getTime());
    expect(state!.reconcileWatermark?.getTime()).toBe(t.getTime()); // початковий водяний знак = старт заповнення
    expect(await runFinanceBackfill(env.db)).toEqual({ status: "already_done" });
  });

  it("pages by id with a cursor (next page is a separate, spaced job)", async () => {
    await env.db.update(financeState).set({ backfilledAt: null, backfillCursor: null });
    const now = new Date().toISOString();
    for (let i = 0; i < BACKFILL_PAGE_SIZE; i++) await env.createOrder(9400 + i, { createdAt: now, processedAt: now });
    const first = await runFinanceBackfill(env.db);
    expect(first).toMatchObject({ status: "page", done: false });
    const [state] = await env.db.select().from(financeState);
    expect(state!.backfillCursor).toBeTruthy();
    expect(await queued(FINANCE_JOB.backfillOrders)).toHaveLength(1);
    const second = await runFinanceBackfill(env.db);
    expect(second).toMatchObject({ status: "page", done: true });
    const all = await queued(FINANCE_JOB.syncOrder);
    // Кожне замовлення без фактів — рівно один раз (dedupe), рознесено в часі.
    expect(new Set(all.map((j) => j.dedupeKey)).size).toBe(all.length);
    expect(all.length).toBe(BACKFILL_PAGE_SIZE + 1);
    const times = all.map((j) => j.runAt.getTime()).sort((a, b) => a - b);
    expect(times[times.length - 1]! - times[0]!).toBeGreaterThan(60_000);
  });
});

describe("finance.backfill_orders — review round", () => {
  const syncQueuedFor = async (orderGid: string) => {
    const [job] = (await queued(FINANCE_JOB.syncOrder)).filter((j) => (j.payload as { orderGid: string }).orderGid === orderGid);
    return job;
  };

  it("§2.5: a test order stored before stage 6 (shopify_test = false) is read once by the backfill and then marked test", async () => {
    await env.db.update(financeState).set({ backfilledAt: null, backfillCursor: null });
    const now = new Date().toISOString();
    const id = await env.createOrder(9330, { test: true, createdAt: now, processedAt: now });
    await env.db.update(orders).set({ shopifyTest: false }).where(eq(orders.id, id)); // стовпець міграції — типово false
    const fx = g2Fixture(gid(9330), "gid://shopify/LineItem/93301");
    fx.finance.test = true;
    env.store.set(gid(9330), fx);
    for (let i = 0; i < 10 && !(await env.db.select().from(financeState))[0]!.backfilledAt; i++) await runFinanceBackfill(env.db);
    expect(await syncQueuedFor(gid(9330))).toBeTruthy();
    await env.sync(gid(9330));
    expect((await env.db.select({ t: orders.shopifyTest }).from(orders).where(eq(orders.id, id)))[0]!.t).toBe(true);
    // Повторне заповнення без includeTestOrders його більше не бере (тестове, факти є).
    await env.db.delete(jobs);
    await env.db.update(financeState).set({ backfilledAt: null, backfillCursor: null });
    for (let i = 0; i < 10 && !(await env.db.select().from(financeState))[0]!.backfilledAt; i++) await runFinanceBackfill(env.db);
    expect(await syncQueuedFor(gid(9330))).toBeUndefined();
  });

  it("§16.4: after the owner grants read_all_orders, requestFinanceBackfill re-reads orders marked order_unreadable (never-read and later-change)", async () => {
    await env.db.update(financeState).set({ backfilledAt: null, backfillCursor: null });
    const oldId = await env.createOrder(9331, { createdAt: "2026-01-12T10:00:00Z", processedAt: "2026-01-12T10:00:00Z" });
    // Без дозволу: заповнення позначає давнє замовлення без запиту.
    let unreadable = 0;
    for (let i = 0; i < 10 && !(await env.db.select().from(financeState))[0]!.backfilledAt; i++) {
      const r = await runFinanceBackfill(env.db);
      if (r.status === "page") unreadable += r.unreadable;
    }
    expect(unreadable).toBe(1);
    expect((await osfOf(env.db, oldId))!.flags).toEqual(["order_unreadable"]);
    // Давнє замовлення З фактами, пізню зміну якого Shopify не віддав (повернення без дозволу).
    const laterId = await env.createOrder(9332, { createdAt: "2026-01-13T10:00:00Z", processedAt: "2026-01-13T10:00:00Z" });
    const laterFx = g2Fixture(gid(9332), "gid://shopify/LineItem/93321");
    env.store.set(gid(9332), laterFx);
    await env.sync(gid(9332));
    env.store.delete(gid(9332));
    expect(await env.sync(gid(9332))).toMatchObject({ status: "unreadable", factsKept: true });
    let status = await getFinanceSyncStatus(env.ctx);
    expect(status).toMatchObject({ allOrdersScope: false });
    expect(status.ordersUnreadable).toBeGreaterThanOrEqual(1);
    const withoutFacts = status.ordersWithoutFacts;
    expect(withoutFacts).toBeGreaterThanOrEqual(1); // давнє недоступне — без фактів продажів
    // Повторне заповнення БЕЗ дозволу не ставить його (марний запит).
    await env.db.delete(jobs);
    await env.db.update(financeState).set({ backfilledAt: null, backfillCursor: null });
    for (let i = 0; i < 10 && !(await env.db.select().from(financeState))[0]!.backfilledAt; i++) await runFinanceBackfill(env.db);
    expect(await syncQueuedFor(gid(9331))).toBeUndefined();

    // Власник надав read_all_orders → «Перечитати фінанси з Shopify» → давнє замовлення в черзі → факти, позначку знято.
    await env.db.update(shopInstallations).set({ scopes: "write_orders,read_products,read_inventory,read_all_orders" });
    try {
      status = await getFinanceSyncStatus(env.ctx);
      expect(status.allOrdersScope).toBe(true);
      await env.db.delete(jobs);
      expect(await requestFinanceBackfill(env.ctx)).toEqual({ status: "queued" });
      await runOne(FINANCE_JOB.backfillOrders); // перша сторінка — через обробник реєстру
      for (let i = 0; i < 10 && !(await env.db.select().from(financeState))[0]!.backfilledAt; i++) await runFinanceBackfill(env.db);
      expect(await syncQueuedFor(gid(9331))).toBeTruthy();
      expect(await syncQueuedFor(gid(9332))).toBeTruthy();
      env.store.set(gid(9332), laterFx);
      laterFx.finance.updatedAt = "2026-11-20T10:00:00Z";
      expect(await env.sync(gid(9332))).toMatchObject({ status: "synced", flags: [] });
      env.store.set(gid(9331), g2Fixture(gid(9331), "gid://shopify/LineItem/93311"));
      expect(await env.sync(gid(9331))).toMatchObject({ status: "synced", flags: [] });
      expect((await osfOf(env.db, oldId))!.flags).toEqual([]);
      const ds = await env.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.orderId, oldId));
      expect(ds.map((d) => [d.type, d.status, d.resolutionCode])).toEqual([["order_unreadable", "resolved", "auto_resolved"]]);
      status = await getFinanceSyncStatus(env.ctx);
      expect(status.ordersWithoutFacts).toBe(withoutFacts - 1);
    } finally {
      await env.db.update(shopInstallations).set({ scopes: "write_orders,read_products,read_inventory" });
    }
  });
});

describe("finance.reconcile (§16.3)", () => {
  it("reads updated orders from watermark − 1 h and queues only stored orders with older facts; completed pass moves the watermark", async () => {
    const id = await env.createOrder(9310);
    const fx = g2Fixture(gid(9310), "gid://shopify/LineItem/93101");
    fx.finance.updatedAt = "2026-11-20T10:00:00Z";
    env.store.set(gid(9310), fx);
    await env.sync(gid(9310));
    expect((await osfOf(env.db, id))!.shopifyUpdatedAt?.toISOString()).toBe("2026-11-20T10:00:00.000Z");
    // Не збережене в застосунку (неоплачене) і тестове — не ставляться.
    env.store.set(gid(9311), { finance: financeNode(gid(9311), { updatedAt: "2026-11-21T10:00:00Z" }), agreements: [], refunds: [] });
    const testId = await env.createOrder(9312, { test: true });
    env.store.set(gid(9312), { finance: financeNode(gid(9312), { test: true, updatedAt: "2026-11-21T10:00:00Z" }), agreements: [], refunds: [] });

    const watermark = new Date("2026-11-21T00:00:00Z");
    await env.db.update(financeState).set({ reconcileWatermark: watermark });
    env.fake.calls.length = 0;
    const started = new Date("2026-11-28T12:00:00Z");
    let out = await runFinanceReconcile({ db: env.db, admin: env.fake.admin, now: () => started }, { shop: SHOP, after: null });
    expect(env.fake.calls[0]!.variables).toMatchObject({ query: `updated_at:>='${new Date(watermark.getTime() - RECONCILE_OVERLAP_MS).toISOString().replace(".000Z", "Z")}'` });
    expect(out).toMatchObject({ pages: 1, queued: 0, done: true }); // 9310 оновлено 20.11 < вікна; 9312 — тестове
    expect((await env.db.select().from(financeState))[0]!.reconcileWatermark?.toISOString()).toBe(started.toISOString());

    // Замовлення змінилося після фінансової синхронізації → ставиться.
    fx.finance.updatedAt = "2026-11-28T13:00:00Z";
    out = await runFinanceReconcile({ db: env.db, admin: env.fake.admin, now: () => new Date("2026-11-28T14:00:00Z") }, { shop: SHOP, after: null });
    expect(out).toMatchObject({ queued: 1, done: true });
    expect((await queued(FINANCE_JOB.syncOrder)).map((j) => (j.payload as { orderGid: string }).orderGid)).toEqual([gid(9310)]);
    expect(await osfOf(env.db, testId)).toBeUndefined();
  });

  it("≤ 20 pages per run; the rest continues with the same query and cursor; the watermark moves only at the end", async () => {
    await env.db.update(financeState).set({ reconcileWatermark: new Date("2026-12-01T00:00:00Z") });
    // 21 сторінка по 50 вузлів (не збережені — лише для пагінації).
    for (let i = 0; i < 20 * 50 + 1; i++) {
      env.store.set(gid(100000 + i), { finance: financeNode(gid(100000 + i), { updatedAt: "2026-12-02T10:00:00Z" }), agreements: [], refunds: [] });
    }
    const started = new Date("2026-12-03T00:00:00Z");
    const first = await runFinanceReconcile({ db: env.db, admin: env.fake.admin, now: () => started }, { shop: SHOP, after: null });
    expect(first).toMatchObject({ pages: 20, done: false });
    expect((await env.db.select().from(financeState))[0]!.reconcileWatermark?.toISOString()).toBe("2026-12-01T00:00:00.000Z");
    const [next] = await queued(FINANCE_JOB.reconcile);
    expect(next!.payload).toMatchObject({ shop: SHOP, after: "1000", startedAt: started.toISOString() });
    const p = next!.payload as { after: string; query: string; startedAt: string };
    const second = await runFinanceReconcile({ db: env.db, admin: env.fake.admin, now: () => new Date("2026-12-03T01:00:00Z") }, { shop: SHOP, ...p });
    expect(second).toMatchObject({ pages: 1, done: true });
    expect((await env.db.select().from(financeState))[0]!.reconcileWatermark?.toISOString()).toBe(started.toISOString());
    for (let i = 0; i < 20 * 50 + 1; i++) env.store.delete(gid(100000 + i));
  });

  it("finance.reconcile_scheduled schedules the next link first, then the reconcile", async () => {
    const t = new Date();
    expect(await runReconcileScheduled(env.db, t)).toEqual({ status: "queued" });
    const [chain] = await queued(FINANCE_JOB.reconcileScheduled);
    expect(chain!.runAt.getTime() - t.getTime()).toBe(FINANCE_JOB_TIMING.reconcileIntervalMs);
    expect((await queued(FINANCE_JOB.reconcile)).map((j) => j.payload)).toEqual([{ shop: SHOP, after: null }]);
  });
});

describe("webhook → jobs → facts; a repeated webhook adds no rows", () => {
  it("REFUNDS_CREATE queues finance.sync_order; running it stores the refund; the same webhook id again is a duplicate; a new delivery re-reads without new rows", async () => {
    const orderId = await env.createOrder(9320);
    const ref = refund({ amount: "10.00", lines: [refundLine("gid://shopify/LineItem/93201", 1, "RETURN", true, "10.00")] });
    env.store.set(gid(9320), {
      finance: financeNode(gid(9320), {
        updatedAt: "2026-11-04T10:05:00Z",
        transactions: [transaction({ amount: "29.90" }), transaction({ kind: "REFUND", amount: "10.00" })],
        totals: { currentTotalPriceSet: bag("19.90"), netPaymentSet: bag("19.90"), totalRefundedSet: bag("10.00") },
      }),
      agreements: [
        agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "29.90", lineItem: "gid://shopify/LineItem/93201" })]),
        agreement("RefundAgreement", "2026-11-04T10:00:00Z", [sale({ total: "-10.00", quantity: -1, actionType: "RETURN", lineItem: "gid://shopify/LineItem/93201" })], { refund: { id: ref.id } }),
      ],
      refunds: [ref],
    });
    const hook = (id: string) => handleShopifyWebhook(env.db, { topic: "refunds/create", shop: SHOP, webhookId: id, payload: { id: 1, order_id: 9320 } });
    expect(await hook("wh-refund-1")).toBe("queued");
    expect(await hook("wh-refund-1")).toBe("duplicate");
    await runOne(FINANCE_JOB.syncOrder);
    const after = await factCounts(env.db, orderId);
    expect(after).toMatchObject({ osf: 1, sales: 2, transactions: 2, refunds: 1, refundLines: 1 });
    expect(await hook("wh-refund-2")).toBe("queued"); // нова доставка тієї самої події
    await runOne(FINANCE_JOB.syncOrder);
    expect(await factCounts(env.db, orderId)).toEqual(after);
  });

  it("invalid payloads fail the job without retries (DomainError), not silently", async () => {
    const h = createFinanceJobHandlers(deps());
    await expect(h[FINANCE_JOB.syncOrder]!.run({ payload: { orderGid: "gid://shopify/Refund/1" } } as never)).rejects.toMatchObject({ code: "job.invalidPayload" });
  });

  it("finance.sync_order for an order deleted from the app does nothing (no rows)", async () => {
    const id = await env.createOrder(9321);
    await env.db.delete(orders).where(eq(orders.id, id));
    env.fake.calls.length = 0;
    const h = createFinanceJobHandlers(deps());
    await h[FINANCE_JOB.syncOrder]!.run({ payload: { shop: SHOP, orderGid: gid(9321) } } as never);
    expect(env.fake.calls).toEqual([]);
    expect(await env.db.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, id))).toEqual([]);
  });
});

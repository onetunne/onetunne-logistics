/**
 * Етап 6, WP4: паралельність фінансів замовлення на справжньому PostgreSQL (§17.8, §20.3; лише з TEST_DATABASE_URL):
 * - паралельні syncOrderFinance одного замовлення з новими фактами серіалізуються FINANCE_ORDER_LOCK: усі завершуються,
 *   результат — той самий, що послідовний (кортежі = модель), без подвійних записів і дублів ключів;
 * - дві паралельні дії власника з тією самою версією (CAS order_finance.version) → рівно одна успішна, інша — конфлікт;
 * - дві паралельні передачі (consume_sale) замовлень з одним варіантом + зміна вартості партії → без взаємоблокувань
 *   (40P01); кожне замовлення визнане з однією собівартістю на оцінку;
 * - кілька замовлень в одній транзакції (resyncTestOrders → syncOrderFinanceMany) паралельно з синхронізацією одного з
 *   них, обидві утримують завдання перерахунку розподілу (§10.3) → без взаємоблокування: FINO усіх замовлень пакета
 *   береться ОДНИМ упорядкованим набором ДО першого утримання рядка jobs (§17.8).
 */
import { randomUUID } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, jobs, orderLineItems, orders, productionBatchLines, productionBatches } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { applyMovements } from "~/modules/inventory/ledger.server";
import { createExpense } from "~/modules/expenses/expenses.server";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { resyncTestOrders, setOrderFinanceFlag } from "~/modules/order-finance/actions.server";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import { createBatch, receiveProduction, startProduction, updateBatchCosts } from "~/modules/production/batches.server";
import * as G from "../reference/golden";
import { activeEntries, postOrder, type RefOrderFacts } from "../reference/model";
import { OWNER } from "../../helpers";
import { ACTOR, stockItemFor } from "../../stage5/helpers";
import { GoldenOrder, openGoldenEnv, prodCtx, tuples, type GoldenEnv } from "./golden-helpers";

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL: order finance concurrency", () => {
  let env: GoldenEnv;
  beforeAll(async () => {
    env = await openGoldenEnv(G.G1_RATES);
  });
  afterAll(async () => {
    await env?.close();
  });

  it("8 parallel syncs of one order with new facts (carrier invoice) → serialised, the same entries as sequential (= model), no duplicates", async () => {
    const o = await new GoldenOrder(env, { ...G.G1_ORDER, id: "ord-pg-par" }, { partnerCode: "PGPAR" }).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z", G.G1_AS_OF_BEFORE_IMPORT]) await o.advance(t);
    await o.advance(G.G1_AS_OF_AFTER_IMPORT, { sync: false });
    const now = new Date(G.G1_AS_OF_AFTER_IMPORT);
    const runs = await Promise.allSettled(Array.from({ length: 8 }, () => env.db.transaction((tx) => syncOrderFinanceAt(tx, SYSTEM_ACTOR, o.orderId, { now }))));
    for (const r of runs) expect(r.status, r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : "").toBe("fulfilled");
    const app = await o.entries();
    expect(tuples(app)).toEqual(tuples(activeEntries(postOrder(G.G1_ORDER, G.G1_AS_OF_AFTER_IMPORT).entries)));
    const all = await env.db.select({ key: financeEntries.idempotencyKey }).from(financeEntries).where(eq(financeEntries.orderId, o.orderId));
    expect(new Set(all.map((e) => e.key)).size).toBe(all.length);
    expect(app.filter((e) => e.category === "shipping_cost")).toHaveLength(1);
    expect((await o.finance()).profitState).toBe("final");
  });

  it("two owner marks with the same expected version in parallel → exactly one succeeds, the other is a conflict", async () => {
    const o = await new GoldenOrder(env, { ...G.G8B_ORDER_NOTHING, id: "ord-pg-cas" }).create();
    await o.advance("2026-10-05T12:00:00Z");
    const v = (await o.finance()).version;
    const ctx = prodCtx(env, "2026-11-30T12:00:00Z", OWNER);
    const runs = await Promise.allSettled([
      setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "no_shipping_cost", active: true, reason: "A", expectedVersion: v }),
      setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "recipient_pays", active: true, reason: "B", expectedVersion: v }),
    ]);
    expect(runs.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const rejected = runs.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "error.conflict" });
  });

  it("two orders with the same variant handed over in parallel + a batch cost change → no deadlock; each order recognized, one COGS per valuation", async () => {
    const ctx = prodCtx(env, "2026-10-05T12:00:00Z", OWNER);
    const a = await new GoldenOrder(env, { ...G.G1B_ORDER, id: "ord-pg-a", valuations: [], handedOverAt: undefined }).create();
    await a.advance("2026-10-05T08:00:00Z");
    const variantId = a.variantIds.get("prod-a")!;
    // Позиція відкрита для обліку (етап 5: продаж невідкритого товару заборонено).
    const stockItemId = await stockItemFor(env.db, variantId);
    // Друге замовлення з тим самим варіантом.
    const b = await new GoldenOrder(env, { ...G.G1B_ORDER, id: "ord-pg-b", valuations: [], handedOverAt: undefined }).create();
    const [lineB] = await env.db.select({ id: orderLineItems.id }).from(orderLineItems).where(eq(orderLineItems.orderId, b.orderId));
    await env.db.update(orderLineItems).set({ variantId }).where(eq(orderLineItems.id, lineB!.id));
    await b.advance("2026-10-05T08:00:00Z");
    const { batchId } = await createBatch(ctx, { title: "PG WP4 batch", costCurrency: "UAH", lines: [{ variantId, quantity: 10, unitCost: "100.00" }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    await receiveProduction(ctx, batchId, { idempotencyKey: randomUUID(), lines: "remaining" });
    const [batchLine] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    for (const o of [a, b]) await env.db.update(orders).set({ status: "delivered" }).where(eq(orders.id, o.orderId));
    const line = async (o: GoldenOrder) => (await env.db.select({ id: orderLineItems.id }).from(orderLineItems).where(eq(orderLineItems.orderId, o.orderId)))[0]!.id;
    const runs = await Promise.allSettled([
      ...[a, b].map(async (o) => {
        const lineId = await line(o);
        return env.db.transaction((tx) =>
          applyMovements(tx, ACTOR, [{ warehouseId: env.warehouseId, stockItemId, type: "consume_sale", onHandDelta: -1, orderId: o.orderId, orderLineItemId: lineId, idempotencyKey: `pg-wp4:sale:${o.orderId}` }]),
        );
      }),
      version().then((v) => updateBatchCosts(ctx, batchId, v, { extraCost: null, costCurrency: "UAH", lines: [{ batchLineId: batchLine!.id, unitCost: "110.00" }] })),
    ]);
    for (const r of runs) expect(r.status, r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : "").toBe("fulfilled");
    for (const o of [a, b]) {
      const f = await o.finance();
      expect(f.state).toBe("recognized");
      expect(f.recognitionBasis).toBe("consume");
      const cogs = await env.db
        .select({ key: financeEntries.idempotencyKey })
        .from(financeEntries)
        .where(and(eq(financeEntries.orderId, o.orderId), eq(financeEntries.category, "cogs"), isNull(financeEntries.reversesEntryId)));
      expect(cogs.filter((c) => c.key.startsWith("cogs:"))).toHaveLength(1);
    }
  });

  it("resyncTestOrders (кілька замовлень в одній транзакції) ‖ синхронізація одного з них; обидві утримують завдання перерахунку → без 40P01", async () => {
    const NOW = "2026-11-28T10:00:00Z";
    const paypal = (id: string, total: string, placedAt: string, handedOverAt: string, extra: Partial<RefOrderFacts> = {}): RefOrderFacts => ({
      id,
      currency: "EUR",
      country: "DE",
      placedAt,
      handedOverAt,
      lines: [{ id: `li-${id}`, productId: "prod-a", quantity: 1 }],
      sales: [{ id: `s-${id}`, agreement: "order", lineType: "PRODUCT", lineId: `li-${id}`, productId: "prod-a", quantity: 1, totalAmount: total, taxAmount: "0.00", happenedAt: placedAt }],
      transactions: [{ id: `t-${id}`, kind: "SALE", status: "SUCCESS", amount: total, processedAt: placedAt, gateway: "paypal", fees: [] }],
      valuations: [],
      waybills: [],
      invoiceLines: [],
      shippingOwnerMark: "no_shipping_cost",
      ...extra,
    });
    await saveFinanceSettings(env.ctx(OWNER), { includeTestOrders: true });
    const first = await new GoldenOrder(env, paypal("pg-dl-a", "300.00", "2026-11-05T07:00:00Z", "2026-11-06T12:00:00Z", { feeRule: { kind: "percent", percentBp: 100 } })).create();
    await first.advance("2026-11-06T12:00:00Z");
    // Сума періоду PayPal листопада — розподілена на перше замовлення.
    const { id: expenseId } = await createExpense(prodCtx(env, NOW), { operationId: randomUUID(), category: "payment_fees", amount: "7.00", currency: "EUR", dateMode: "single", expenseDate: "2026-11-27", gateway: "paypal" });
    // Два тестові замовлення того самого виміру, оформлені після розподілу → awaiting_reallocation, завдання в черзі.
    const late: GoldenOrder[] = [];
    for (const id of ["pg-dl-x", "pg-dl-y"]) {
      const o = await new GoldenOrder(env, { ...paypal(id, "100.00", "2026-11-20T07:00:00Z", "2026-11-21T12:00:00Z"), test: true }).create();
      await o.advance(NOW);
      expect((await o.finance()).componentsParsed.fees).toMatchObject({ state: "missing", reason: "awaiting_reallocation" });
      late.push(o);
    }
    const queued = await env.db.select().from(jobs).where(and(eq(jobs.type, "finance.expense_reallocate"), eq(jobs.status, "queued")));
    expect(queued.map((j) => (j.payload as { expenseId?: string }).expenseId)).toContain(expenseId);
    const [, hi] = [...late].sort((a, b) => (a.orderId < b.orderId ? -1 : 1));
    const waitingAdvisory = async () => {
      const r = (await env.db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted`)) as unknown as { rows: Array<{ n: number }> };
      return Number(r.rows[0]?.n ?? 0) > 0;
    };
    let locked!: () => void;
    const hiLocked = new Promise<void>((resolve) => (locked = resolve));
    // T2: FINO(hi), дочекатися, поки T1 чекає advisory-блокування, потім синхронізація hi (утримує рядок jobs).
    const t2 = env.db.transaction(async (tx) => {
      await lockFinanceOrder(tx, hi!.orderId);
      locked();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline && !(await waitingAdvisory())) await new Promise((r) => setTimeout(r, 25));
      await syncOrderFinanceAt(tx, SYSTEM_ACTOR, hi!.orderId, { now: new Date(NOW) });
    });
    // T1: власник перераховує тестові замовлення (обидва в одній транзакції).
    const t1 = hiLocked.then(() => resyncTestOrders(prodCtx(env, NOW)));
    const runs = await Promise.allSettled([t1, t2]);
    for (const r of runs) expect(r.status, r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : "").toBe("fulfilled");
    expect((runs[0] as PromiseFulfilledResult<{ orders: number }>).value.orders).toBe(2);
  });
});

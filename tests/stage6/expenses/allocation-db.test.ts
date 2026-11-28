/**
 * Етап 6, WP6: сума періоду замість прогнозу (§10.3; золотий G13; інваріант I16).
 * - G13: три замовлення PayPal листопада з прогнозами комісій 3,00 / 2,00 / 1,00 EUR; сума за листопад 7,00 EUR →
 *   частки 3,50 / 2,33 / 1,17 (Σ = 7,00) — фактичні записи замовлень (alloc:<id>:<orderId>:v1), окремого запису суми
 *   немає.
 * - Розподіл — лише між замовленнями виміру (шлюз / перевізник), оформленими в місяці, без фактичного складника, не
 *   скасованими й не тестовими; замовлення без прогнозу не отримують частки (лишаються «Немає даних»); без прогнозів
 *   у всіх — за виручкою; без кандидатів — один запис періоду.
 * - I16: жоден (вимір, місяць) не має водночас прогнозу замовлення й суми періоду без позначки «окрема»: кожне
 *   замовлення з прогнозом виміру покрите часткою поточної версії; нове замовлення → «Перерахувати розподіл» (сторно +
 *   нова версія).
 * - Частка невизнаного замовлення чекає визнання (syncOrderExpenseEntries, WP4).
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeExpenseAllocations, financeExpenses, orderFinanceForecasts } from "~/db/schema";
import { postEntries } from "~/modules/finance/core/entries.server";
import { coverageWarnings, createExpense, getExpense, recalculateAllocation, voidExpense, type ExpenseInput } from "~/modules/expenses/expenses.server";
import { syncOrderExpenseEntries } from "~/modules/expenses/posting.server";
import type { TestEnv } from "../../helpers";
import { activeEntriesOf, ctxAt, entriesOf, insertOrder, op, openEnv, rate, recognize, sumMinor } from "./helpers";

let env: TestEnv;
const NOW = "2026-12-03T10:00:00Z";

beforeAll(async () => {
  env = await openEnv();
});
afterAll(async () => {
  await env.close();
});

const fees = (over: Partial<ExpenseInput>): ExpenseInput => ({
  operationId: op(),
  category: "payment_fees",
  amount: "7,00",
  currency: "EUR",
  dateMode: "single",
  expenseDate: "2026-11-30",
  gateway: "paypal",
  ...over,
});

async function allocationRows(expenseId: string) {
  return env.handle.db.select().from(financeExpenseAllocations).where(eq(financeExpenseAllocations.expenseId, expenseId));
}

describe("G13 — the period sum replaces forecasts", () => {
  let a = "";
  let b = "";
  let c = "";
  let expenseId = "";

  it("3,00 / 2,00 / 1,00 EUR forecasts + 7,00 EUR for November → 3,50 / 2,33 / 1,17 actual shares, no separate entry", async () => {
    const db = env.handle.db;
    a = await insertOrder(db, { placedOn: "2026-11-03", gateway: "paypal", state: "recognized", recognizedOn: "2026-11-04", forecasts: [{ component: "fees", amount: "3.00" }] });
    b = await insertOrder(db, { placedOn: "2026-11-10", gateway: "paypal", state: "recognized", recognizedOn: "2026-11-12", forecasts: [{ component: "fees", amount: "2.00" }] });
    c = await insertOrder(db, { placedOn: "2026-11-20", gateway: "paypal", state: "open", forecasts: [{ component: "fees", amount: "1.00" }] });
    // Не кандидати: інший шлюз, інший місяць, тестове, скасоване до відвантаження, уже фактична комісія Shopify.
    await insertOrder(db, { placedOn: "2026-11-05", gateway: "shopify_payments", state: "recognized", forecasts: [{ component: "fees", amount: "5.00" }] });
    await insertOrder(db, { placedOn: "2026-10-31", gateway: "paypal", state: "recognized", forecasts: [{ component: "fees", amount: "5.00" }] });
    await insertOrder(db, { placedOn: "2026-11-06", gateway: "paypal", shopifyTest: true, state: "open", forecasts: [{ component: "fees", amount: "5.00" }] });
    await insertOrder(db, { placedOn: "2026-11-07", gateway: "paypal", state: "closed_unrecognized", forecasts: [{ component: "fees", amount: "5.00" }] });
    const actual = await insertOrder(db, { placedOn: "2026-11-08", gateway: "paypal", state: "recognized", recognizedOn: "2026-11-09" });
    await db.transaction((tx) =>
      postEntries(tx, { id: "test" }, [
        { idempotencyKey: `fee:test-${actual}`, category: "payment_fees", recognizedOn: "2026-11-09", fxOn: "2026-11-09", amount: "-4.00", currency: "EUR", orderId: actual, sourceType: "shopify_fee", sourceId: "fee-test" },
      ]),
    );
    const r = await createExpense(ctxAt(env, NOW), fees({}));
    expenseId = r.id;
    expect(r).toMatchObject({ allocatedOrders: 3, weightBasis: "forecast", posted: 2, awaiting: 1 });
    const rows = await allocationRows(r.id);
    const share = new Map(rows.map((x) => [x.orderId, x.amount]));
    expect(Object.fromEntries([a, b, c].map((id) => [id, share.get(id)]))).toEqual({ [a]: "3.50", [b]: "2.33", [c]: "1.17" });
    expect(rows.every((x) => x.expenseVersion === 1 && x.weightBasis === "forecast" && x.currency === "EUR")).toBe(true);
    expect(sumMinor(rows)).toBe(700n);
    const es = await entriesOf(db, r.id);
    // Частки визнаних замовлень — фактичні записи замовлень; сама сума запису не має.
    expect(es.map((e) => [e.idempotencyKey, e.amount, e.recognizedOn, e.orderId]).sort()).toEqual(
      [
        [`alloc:${r.id}:${a}:v1`, "-3.50", "2026-11-04", a],
        [`alloc:${r.id}:${b}:v1`, "-2.33", "2026-11-12", b],
      ].sort(),
    );
    expect(es.every((e) => e.sourceType === "allocation" && e.category === "payment_fees")).toBe(true);
    expect(es.some((e) => e.idempotencyKey.startsWith(`exp:${r.id}`))).toBe(false);
    expect(es[0]!.details).toMatchObject({ kind: "allocation", weightBasis: "forecast", gateway: "paypal" });
    const [row] = await db.select().from(financeExpenses).where(eq(financeExpenses.id, r.id));
    expect(row).toMatchObject({ coversForecast: true, separateFromForecast: false });
  });

  it("the unrecognized order's share waits for recognition and is posted by syncOrderExpenseEntries (WP4)", async () => {
    const db = env.handle.db;
    await recognize(db, c, "2026-12-01");
    const r1 = await db.transaction((tx) => syncOrderExpenseEntries(tx, { id: "system" }, c));
    expect(r1).toMatchObject({ posted: 1, reversed: 0, awaiting: 0 });
    const share = (await entriesOf(db, expenseId)).find((e) => e.orderId === c)!;
    expect(share).toMatchObject({ amount: "-1.17", recognizedOn: "2026-12-01", idempotencyKey: `alloc:${expenseId}:${c}:v1` });
    const r2 = await db.transaction((tx) => syncOrderExpenseEntries(tx, { id: "system" }, c));
    expect(r2).toMatchObject({ posted: 0, reversed: 0 });
    const detail = await getExpense(ctxAt(env, NOW), expenseId);
    expect(detail.shares.every((s) => s.posted)).toBe(true);
    expect(detail.allocation).toMatchObject({ orders: 3, withShare: 3, awaiting: 0, weightBasis: "forecast" });
  });

  it("I16: a new order of the dimension → the allocation is stale → recalculation covers it (reversal + version 2)", async () => {
    const db = env.handle.db;
    const d = await insertOrder(db, { placedOn: "2026-11-25", gateway: "paypal", state: "recognized", recognizedOn: "2026-11-26", forecasts: [{ component: "fees", amount: "1.00" }] });
    const w = await coverageWarnings(ctxAt(env, NOW), "2026-11-01");
    expect(w.stale).toEqual([{ expenseId, category: "payment_fees", current: 3, next: 4 }]);
    const r = await recalculateAllocation(ctxAt(env, NOW), { expenseId, expectedVersion: 1 });
    expect(r).toMatchObject({ changed: true, version: 2, allocatedOrders: 4 });
    const v2 = (await allocationRows(expenseId)).filter((x) => x.expenseVersion === 2);
    expect(Object.fromEntries(v2.map((x) => [x.orderId, x.amount]))).toEqual({ [a]: "3.00", [b]: "2.00", [c]: "1.00", [d]: "1.00" });
    const active = await activeEntriesOf(db, expenseId);
    expect(active.map((e) => e.idempotencyKey).sort()).toEqual([a, b, c, d].map((o) => `alloc:${expenseId}:${o}:v2`).sort());
    expect(sumMinor(active)).toBe(-700n);
    // Усі записи разом (v1 + сторно + v2) = −7,00.
    expect(sumMinor(await entriesOf(db, expenseId))).toBe(-700n);
    // I16: кожне замовлення виміру з прогнозом покрите поточною версією.
    const forecastOrders = await db.select({ orderId: orderFinanceForecasts.orderId }).from(orderFinanceForecasts).where(eq(orderFinanceForecasts.component, "fees"));
    const covered = new Set(v2.map((x) => x.orderId));
    for (const id of [a, b, c, d]) expect(covered.has(id)).toBe(true);
    expect(forecastOrders.length).toBeGreaterThan(4);
    expect((await coverageWarnings(ctxAt(env, NOW), "2026-11-01")).stale).toEqual([]);
    const again = await recalculateAllocation(ctxAt(env, NOW), { expenseId, expectedVersion: 2 });
    expect(again).toMatchObject({ changed: false, version: 2 });
  });

  it("a second covering sum of the same dimension does not double-cover orders: no candidates → one period entry", async () => {
    const r = await createExpense(ctxAt(env, NOW), fees({ amount: "1,00" }));
    expect(r).toMatchObject({ allocatedOrders: 0 });
    const es = await entriesOf(env.handle.db, r.id);
    expect(es.map((e) => [e.idempotencyKey, e.amount, e.recognizedOn, e.orderId])).toEqual([[`exp:${r.id}:v1`, "-1.00", "2026-11-30", null]]);
    expect(es[0]!.details).toMatchObject({ kind: "period_total" });
    const w = await coverageWarnings(ctxAt(env, NOW), "2026-11-01");
    expect(w.periodTotals.map((p) => p.expenseId)).toContain(r.id);
  });

  it("voiding the covering sum reverses every share", async () => {
    await voidExpense(ctxAt(env, NOW), { expenseId, reason: "Неправильна виписка", expectedVersion: 2 });
    expect(await activeEntriesOf(env.handle.db, expenseId)).toHaveLength(0);
    expect(sumMinor(await entriesOf(env.handle.db, expenseId))).toBe(0n);
  });
});

describe("weights and dimensions", () => {
  it("orders without a forecast get no share (stay «no data», never 0) when others have forecasts", async () => {
    const db = env.handle.db;
    const withF = await insertOrder(db, { placedOn: "2026-09-03", gateway: "stripe", state: "recognized", forecasts: [{ component: "fees", amount: "2.00" }] });
    const noF = await insertOrder(db, { placedOn: "2026-09-04", gateway: "stripe", state: "recognized" });
    const r = await createExpense(ctxAt(env, NOW), fees({ gateway: "stripe", amount: "5,00", expenseDate: "2026-09-30" }));
    const rows = await allocationRows(r.id);
    expect(rows.map((x) => [x.orderId, x.amount])).toEqual([[withF, "5.00"]]);
    expect(rows.some((x) => x.orderId === noF)).toBe(false);
  });

  it("no forecasts at all → by order revenue (largest remainder; equal weights if all zero)", async () => {
    const db = env.handle.db;
    const o1 = await insertOrder(db, { placedOn: "2026-08-03", gateway: "liqpay", total: "100.00" });
    const o2 = await insertOrder(db, { placedOn: "2026-08-04", gateway: "liqpay", total: "200.00" });
    const r = await createExpense(ctxAt(env, NOW), fees({ gateway: "liqpay", amount: "10,00", expenseDate: "2026-08-15" }));
    expect(r.weightBasis).toBe("revenue");
    const rows = await allocationRows(r.id);
    expect(Object.fromEntries(rows.map((x) => [x.orderId, x.amount]))).toEqual({ [o1]: "3.33", [o2]: "6.67" });
    // Невизнані → частки чекають визнання.
    expect(r).toMatchObject({ posted: 0, awaiting: 2 });
  });

  it("forecasts in different currencies are weighted in hryvnias at the order date", async () => {
    const db = env.handle.db;
    await rate(db, "EUR", "2026-07-10", "45.0000");
    await rate(db, "USD", "2026-07-11", "40.0000");
    const eur = await insertOrder(db, { placedOn: "2026-07-10", gateway: "wise", forecasts: [{ component: "fees", amount: "1.00", currency: "EUR" }] });
    const usd = await insertOrder(db, { placedOn: "2026-07-11", currency: "USD", gateway: "wise", forecasts: [{ component: "fees", amount: "1.00", currency: "USD" }] });
    const r = await createExpense(ctxAt(env, NOW), fees({ gateway: "wise", amount: "850", currency: "UAH", expenseDate: "2026-07-31" }));
    const rows = await allocationRows(r.id);
    expect(Object.fromEntries(rows.map((x) => [x.orderId, x.amount]))).toEqual({ [eur]: "450.00", [usd]: "400.00" });
  });

  it("shipping sum by carrier covers only that carrier's orders; packaging has no dimension", async () => {
    const db = env.handle.db;
    const np = await insertOrder(db, { placedOn: "2026-06-03", carrier: "nova_post", forecasts: [{ component: "shipping_cost", amount: "500.00", currency: "UAH" }] });
    await insertOrder(db, { placedOn: "2026-06-04", carrier: "ukrposhta", forecasts: [{ component: "shipping_cost", amount: "500.00", currency: "UAH" }] });
    const ship = await createExpense(ctxAt(env, NOW), fees({ category: "shipping_cost", gateway: null, carrierCode: "nova_post", amount: "600", currency: "UAH", expenseDate: "2026-06-30" }));
    expect((await allocationRows(ship.id)).map((x) => [x.orderId, x.amount])).toEqual([[np, "600.00"]]);
    const p1 = await insertOrder(db, { placedOn: "2026-06-05", forecasts: [{ component: "packaging", amount: "20.00", currency: "UAH" }] });
    const pack = await createExpense(ctxAt(env, NOW), fees({ category: "packaging", gateway: null, amount: "30", currency: "UAH", expenseDate: "2026-06-30" }));
    expect((await allocationRows(pack.id)).map((x) => [x.orderId, x.amount])).toEqual([[p1, "30.00"]]);
  });

  it("«Окрема витрата, не замінює прогноз» — only with a reason; posted as a period entry, no allocation", async () => {
    const db = env.handle.db;
    await insertOrder(db, { placedOn: "2026-05-03", gateway: "paypal", forecasts: [{ component: "fees", amount: "2.00" }] });
    const r = await createExpense(ctxAt(env, NOW), fees({ amount: "9,00", expenseDate: "2026-05-31", coverage: "separate", separateReason: "Річна плата PayPal, не комісії замовлень" }));
    expect(r.allocatedOrders).toBeNull();
    expect(await allocationRows(r.id)).toHaveLength(0);
    expect((await entriesOf(db, r.id)).map((e) => e.amount)).toEqual(["-9.00"]);
    const [row] = await db.select().from(financeExpenses).where(and(eq(financeExpenses.id, r.id)));
    expect(row).toMatchObject({ coversForecast: false, separateFromForecast: true, separateReason: "Річна плата PayPal, не комісії замовлень" });
  });
});

/**
 * Етап 6, WP9: статистика з покриттям і суми лише власнику (docs/stage6-design.md §11, §2.6, §14.2, F1, F4).
 * - частка повернень: визнані в періоді замовлення з відомими даними (без order_unreadable) — знаменник; з поверненням
 *   коштів після визнання (активний запис refund_*; сторнований не рахується) або надходженням-поверненням — чисельник;
 *   покриття «за N з M»; порожньо — null («—»), не 0;
 * - причини (покриття — з відомою причиною), модель, колір, товар, країна, одиниці (поповнено / не поповнено /
 *   пошкоджено), дні «вручення → повернення» (лише з датою вручення), до / після відвантаження;
 * - суми (повернено, зворотна доставка, обробка, витрати на повернення, сторно собівартості, утримані збори) —
 *   агрегати журналу, кожен запис за курсом свого fx_on; без курсу — окремо, не 0; немає записів — null, не 0;
 * - працівник і підроблений актор (дозвіл без ролі owner) → ForbiddenError на кожному грошовому сервісі.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeExpenses, fxRates, inventoryValuations, orderFinance, orderRefunds, orderReturns, orderSales, orders } from "~/db/schema";
import { ForbiddenError, makeActor, SYSTEM_ACTOR } from "~/domain/permissions";
import { activeEntryRefs, postEntries, reverseEntry, type EntryInput } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { loadReturnAmounts } from "~/modules/returns/amounts.server";
import { updateReturnCase } from "~/modules/returns/cases.server";
import { returnExportRows } from "~/modules/returns/export.server";
import { returnMoneyStats, returnRate, returnStats } from "~/modules/returns/stats.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { addRefund, addShipment, ctxAt, insertOrder, makeVariant, receiveReturn, syncCases, type TestOrder } from "./helpers";

let env: TestEnv;
const NOW = "2026-11-28T10:00:00Z";
const FORGED = makeActor({
  id: "forged",
  displayName: "F",
  role: "staff",
  overrides: { grant: ["finance.view", "finance.manage"] },
});
const OCT = { from: "2026-10-01", to: "2026-10-31" };
const WIDE = { from: "2026-11-01", to: "2030-12-31" };
let a: TestOrder;
let d: TestOrder;
let aCase = "";
let dCase = "";

async function recognize(order: TestOrder, on: string, components: Record<string, unknown> = {}) {
  await env.handle.db.insert(orderFinance).values({
    orderId: order.orderId,
    state: "recognized",
    recognizedOn: on,
    recognizedAt: new Date(`${on}T08:00:00Z`),
    shopCurrency: "EUR",
    components: components as never,
  });
}

async function post(order: TestOrder | null, e: Partial<EntryInput>) {
  const input = makeEntryInput({ orderId: order?.orderId ?? null, ...e });
  await env.handle.db.transaction((tx) => postEntries(tx, SYSTEM_ACTOR, [input]));
  return input.idempotencyKey;
}

/** Продаж угоди повернення (як WP3: order_sales.refund_id = gid повернення коштів) — джерело запису refund_*. */
async function refundSale(order: TestOrder, refundId: string, amount: string): Promise<Pick<EntryInput, "sourceType" | "sourceId">> {
  const db = env.handle.db;
  const [r] = await db.select({ gid: orderRefunds.shopifyRefundId }).from(orderRefunds).where(eq(orderRefunds.id, refundId));
  const [sale] = await db
    .insert(orderSales)
    .values({
      orderId: order.orderId,
      shopifySaleId: `gid://shopify/Sale/${randomUUID()}`,
      agreementId: `gid://shopify/RefundAgreement/${randomUUID()}`,
      agreementKind: "refund",
      happenedAt: new Date("2026-11-04T09:00:00Z"),
      refundId: r!.gid,
      actionType: "RETURN",
      lineType: "PRODUCT",
      totalAmount: amount,
      totalTax: "0.00",
      currency: "EUR",
      pTotalAmount: amount,
      pTotalTax: "0.00",
      pCurrency: "EUR",
      source: "shopify",
    })
    .returning({ id: orderSales.id });
  return { sourceType: "shopify_sale", sourceId: sale!.id };
}

/** Ручна витрата, прив'язана до випадку (finance_expenses.return_id) — джерело запису return_*. */
async function caseExpense(order: TestOrder, returnId: string | null, category: "return_handling" | "return_shipping_cost", amount: string, currency = "UAH") {
  const [e] = await env.handle.db
    .insert(financeExpenses)
    .values({
      category,
      amount,
      currency,
      expenseDate: "2026-11-10",
      orderId: order.orderId,
      returnId,
      operationId: randomUUID(),
      createdBy: OWNER.id,
    })
    .returning({ id: financeExpenses.id });
  return { sourceType: "expense" as const, sourceId: e!.id };
}

/** Оцінка складу руху надходження (WP2 створює її одразу в applyMovements) — джерело запису cogs_return. */
async function receiptValuation(movementId: string): Promise<Pick<EntryInput, "sourceType" | "sourceId">> {
  const [v] = await env.handle.db.select({ id: inventoryValuations.id }).from(inventoryValuations).where(eq(inventoryValuations.movementId, movementId));
  expect(v, "valuation of the receipt movement").toBeTruthy();
  return { sourceType: "valuation", sourceId: v!.id };
}

const caseOf = async (order: TestOrder) =>
  (await env.handle.db.select({ id: orderReturns.id }).from(orderReturns).where(eq(orderReturns.orderId, order.orderId))).map((r) => r.id);

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  const db = env.handle.db;
  await db.insert(fxRates).values([
    {
      source: "demo",
      currency: "EUR",
      effectiveDate: "2026-10-05",
      rate: "48.5",
      units: 1,
      ratePerUnit: "48.5000000000",
    },
    {
      source: "demo",
      currency: "EUR",
      effectiveDate: "2026-11-04",
      rate: "48.8",
      units: 1,
      ratePerUnit: "48.8000000000",
    },
  ]);
  const holder = await makeVariant(db, { model: "Тримач", color: "Чорний" });
  const plain = await makeVariant(db);

  // A (DE): відвантажено 05.10, вручено 12.10, повернення коштів 04.11 (RETURN), надходження придатного.
  a = await insertOrder(db, {
    variants: [{ variantId: holder.variantId, quantity: 2 }],
    country: "DE",
  });
  await addShipment(db, a, {
    handedOverAt: "2026-10-05T08:00:00Z",
    deliveredAt: "2026-10-12T08:00:00Z",
  });
  const aRefund = await addRefund(db, a, {
    at: "2026-11-04T09:00:00Z",
    lines: [{ line: 0, quantity: 1, restockType: "RETURN" }],
  });
  await recognize(a, "2026-10-05");
  await syncCases(env, a.orderId);
  const aReceipt = await receiveReturn(env, ctxAt(env, NOW, STAFF), {
    orderId: a.orderId,
    stockItemId: holder.stockItemId,
    good: 1,
  });
  await syncCases(env, a.orderId);
  [aCase] = (await caseOf(a)) as [string];
  // Записи з джерелами випадку (як їх проводять WP4 / WP5 / WP6): продаж угоди повернення, оцінка надходження, ручні
  // витрати з return_id; утримана комісія — запис замовлення без випадку.
  await post(a, {
    category: "refund_product",
    amount: "-45.00",
    currency: "EUR",
    fxOn: "2026-11-04",
    recognizedOn: "2026-11-04",
    ...(await refundSale(a, aRefund, "-45.00")),
  });
  await post(a, {
    category: "cogs_return",
    amount: "400.00",
    currency: "UAH",
    fxOn: "2026-11-06",
    recognizedOn: "2026-11-06",
    ...(await receiptValuation(aReceipt.movementId)),
  });
  await post(a, {
    category: "return_shipping_cost",
    amount: "-300.00",
    currency: "UAH",
    fxOn: "2026-11-10",
    recognizedOn: "2026-11-10",
    ...(await caseExpense(a, aCase, "return_shipping_cost", "300.00")),
  });
  await post(a, {
    category: "return_handling",
    amount: "-50.00",
    currency: "UAH",
    fxOn: "2026-11-10",
    recognizedOn: "2026-11-10",
    ...(await caseExpense(a, aCase, "return_handling", "50.00")),
  });
  await post(a, {
    category: "return_handling",
    amount: "-20.00",
    currency: "PLN",
    fxOn: "2026-11-10",
    recognizedOn: "2026-11-10",
    ...(await caseExpense(a, aCase, "return_handling", "20.00", "PLN")),
  });
  await post(a, {
    category: "payment_fees",
    amount: "-4.04",
    currency: "EUR",
    fxOn: "2026-10-05",
    recognizedOn: "2026-10-05",
    sourceType: "shopify_fee",
    sourceId: "gid://shopify/TransactionFee/1",
  });

  // B (PL): визнано, повернення коштів проведено й сторновано — не повернення.
  const b = await insertOrder(db, {
    variants: [{ variantId: plain.variantId }],
    country: "PL",
  });
  await recognize(b, "2026-10-10");
  const key = await post(b, {
    category: "refund_product",
    amount: "-10.00",
    currency: "EUR",
    fxOn: "2026-10-12",
    recognizedOn: "2026-10-12",
  });
  await db.transaction(async (tx) => {
    const [ref] = await activeEntryRefs(tx, { keyPrefix: key });
    await reverseEntry(tx, SYSTEM_ACTOR, ref!.id);
  });

  // C: визнано, але дані замовлення не прочитано — поза знаменником.
  const c = await insertOrder(db, {
    variants: [{ variantId: plain.variantId }],
    country: "PL",
  });
  await recognize(c, "2026-10-15", {
    revenue: {
      state: "missing",
      reason: "order_unreadable",
      basis: null,
      hasForecast: false,
      actual: [],
      required: true,
    },
  });

  // D (UA): визнано, лише надходження повернення (1 придатна + 1 пошкоджена), без вручення.
  d = await insertOrder(db, {
    variants: [{ variantId: plain.variantId, quantity: 2 }],
    country: "UA",
  });
  await recognize(d, "2026-10-20");
  await receiveReturn(env, ctxAt(env, NOW, STAFF), {
    orderId: d.orderId,
    stockItemId: plain.stockItemId,
    good: 1,
    damaged: 1,
  });
  await syncCases(env, d.orderId);
  [dCase] = (await db.select({ id: orderReturns.id }).from(orderReturns).where(eq(orderReturns.orderId, d.orderId))).map((r) => r.id) as [string];
  await updateReturnCase(ctxAt(env, NOW, STAFF), {
    id: dCase,
    expectedVersion: 1,
    reasonCode: "size_or_fit",
  });

  // Поза періодом визнання (листопад) — не входить у когорту жовтня.
  const late = await insertOrder(db, {
    variants: [{ variantId: plain.variantId }],
  });
  await recognize(late, "2026-11-02");
});
afterAll(async () => {
  await env.close();
});

describe("return rate (§2.6 completeness rule)", () => {
  it("returned / recognized orders with known return data, the same set of orders; coverage shown", async () => {
    expect(await returnRate(ctxAt(env, NOW, STAFF), OCT)).toEqual({
      returned: 2,
      known: 3,
      recognized: 4,
      percent: "66.7",
    });
  });

  it("an empty period gives null («—»), never 0 %", async () => {
    expect(
      await returnRate(ctxAt(env, NOW, STAFF), {
        from: "2025-01-01",
        to: "2025-01-31",
      }),
    ).toEqual({ returned: 0, known: 0, recognized: 0, percent: null });
  });
});

describe("case statistics (counts only — staff may read them)", () => {
  it("reasons with coverage, models, colours, products, countries, units, days with coverage, before / after shipment", async () => {
    const s = await returnStats(ctxAt(env, NOW, STAFF), { range: WIDE });
    expect(s.cases).toBe(2);
    expect(s.reasonCoverage).toEqual({ n: 1, m: 2 });
    expect(s.byReason.map((r) => [r.key, r.cases])).toEqual([
      ["size_or_fit", 1],
      ["unknown", 1],
    ]);
    expect(s.units).toEqual({
      total: 3,
      restocked: 2,
      notRestocked: 1,
      damaged: 1,
      uncertain: 0,
      uncertainCases: 0,
    });
    expect(s.awaitingReceipt).toBe(0);
    expect(s.includesTestOrders).toBe(false);
    expect(s.byModel).toEqual([
      { key: "__none__", label: null, cases: 1, units: 2 },
      { key: "Тримач", label: "Тримач", cases: 1, units: 1 },
    ]);
    expect(s.byColor.map((r) => r.label)).toEqual([null, "Чорний"]);
    expect(s.byProduct.every((r) => r.label?.startsWith("Тестовий товар"))).toBe(true);
    expect(s.byCountry.map((r) => r.key).sort()).toEqual(["DE", "UA"]);
    expect(s.days).toEqual({ average: "23.0", n: 1, m: 2 });
    expect(s.timing).toEqual({ beforeShipment: 0, afterShipment: 2 });
    expect(s.byKind).toEqual([{ key: "customer_return", cases: 2, units: 3 }]);
    expect(s.rate.recognized).toBe(1); // визнано в листопаді — лише «late»
    expect(JSON.stringify(s)).not.toMatch(/(profit|прибут|cogs|собіварт|margin|rentab|рентаб|revenue|оборот|turnover)/i);
  });

  it("no cases in the period → zeros for counts, null for averages (no fabricated values)", async () => {
    const s = await returnStats(ctxAt(env, NOW, STAFF), {
      range: { from: "2025-01-01", to: "2025-01-31" },
    });
    expect(s).toMatchObject({
      cases: 0,
      days: { average: null, n: 0, m: 0 },
      byReason: [],
      reasonCoverage: { n: 0, m: 0 },
    });
  });
});

describe("amounts — owner only (requireFinance view)", () => {
  it("staff and a forged staff actor with finance permissions are refused on every money service", async () => {
    for (const actor of [STAFF, FORGED]) {
      const c = ctxAt(env, NOW, actor);
      await expect(loadReturnAmounts(c, aCase)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(returnMoneyStats(c, { range: WIDE })).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("case amounts: journal entries of the order, each converted at its own fx_on; no rate → listed apart, not 0", async () => {
    const m = await loadReturnAmounts(ctxAt(env, NOW, OWNER), aCase);
    expect(m.currency).toBe("UAH");
    expect(m.groups.refunds).toMatchObject({
      total: "-2196.00",
      entries: 1,
      original: [{ amount: "-45.00", currency: "EUR" }],
      unconverted: [],
    });
    expect(m.groups.returnShipping.total).toBe("-300.00");
    expect(m.groups.returnHandling).toMatchObject({
      total: "-50.00",
      entries: 2,
      unconverted: [{ currency: "PLN", amount: "-20.00", entries: 1 }],
    });
    expect(m.groups.cogsReturn.total).toBe("400.00");
    expect(m.groups).not.toHaveProperty("retainedFees");
    expect(m.orderLevel.groups.retainedFees.total).toBe("-195.94");
    expect(m.orderLevel.entries).toBe(1);
    expect(m.orderCases).toBe(1);
    expect(m.returnCosts).toMatchObject({ total: "-350.00", entries: 3 });
    expect(m.expenses).toEqual([
      expect.objectContaining({ category: "return_shipping_cost", amount: "300.00", currency: "UAH", date: "2026-11-10", status: "active" }),
      expect.objectContaining({ category: "return_handling", amount: "50.00", currency: "UAH", date: "2026-11-10", status: "active" }),
      expect.objectContaining({ category: "return_handling", amount: "20.00", currency: "PLN" }),
    ]);
    expect(m.refunds).toEqual([expect.objectContaining({ amount: "45.00", currency: "EUR", scope: "case" })]);
    expect(m.damagedUnits).toBe(0);
    const eur = await loadReturnAmounts(ctxAt(env, NOW, OWNER), aCase, {
      currency: "EUR",
    });
    expect(eur.groups.refunds.total).toBe("-45.00");
    expect(eur.groups.returnShipping.total).toBe("-6.15"); // 300 / 48,8 (запасний курс 04.11 для 10.11)
    expect(
      (
        await loadReturnAmounts(ctxAt(env, NOW, OWNER), aCase, {
          currency: "XXX",
        })
      ).currency,
    ).toBe("UAH");
  });

  it("a case whose order has no entries: totals are null («—»), never 0; damaged units are reported for reference", async () => {
    const m = await loadReturnAmounts(ctxAt(env, NOW, OWNER), dCase);
    for (const g of Object.values(m.groups)) expect(g).toMatchObject({ total: null, entries: 0, original: [] });
    for (const g of Object.values(m.orderLevel.groups)) expect(g).toMatchObject({ total: null, entries: 0, original: [] });
    expect(m.orderLevel.entries).toBe(0);
    expect(m.returnCosts.total).toBeNull();
    expect(m.damagedUnits).toBe(1);
  });

  it("period amounts by recognised date: refunds, return shipping + handling, cost reversal; unconverted apart", async () => {
    const m = await returnMoneyStats(ctxAt(env, NOW, OWNER), {
      range: { from: "2026-11-01", to: "2026-11-30" },
    });
    expect(m.refunds.total).toBe("-2196.00");
    expect(m.returnShipping.total).toBe("-300.00");
    expect(m.returnHandling).toMatchObject({
      total: "-50.00",
      unconverted: [{ currency: "PLN", amount: "-20.00", entries: 1 }],
    });
    expect(m.returnCosts.total).toBe("-350.00");
    expect(m.cogsReturn.total).toBe("400.00");
    // Сторноване повернення B (жовтень) дає 0 — оригінал + сторно; поза листопадом не рахується.
    const oct = await returnMoneyStats(ctxAt(env, NOW, OWNER), { range: OCT });
    expect(oct.refunds).toMatchObject({ total: "0.00", entries: 2 });
    expect(oct.returnCosts).toMatchObject({ total: null, entries: 0 });
  });
});

describe("export rows for the «returns» dataset (§13.2, no free text)", () => {
  it("owner only; codes, Kyiv dates, country and units — the case note never leaves", async () => {
    await updateReturnCase(ctxAt(env, NOW, STAFF), {
      id: aCase,
      expectedVersion: 2,
      note: "Покупець пише на test@example.com",
    });
    for (const actor of [STAFF, FORGED]) await expect(returnExportRows(ctxAt(env, NOW, actor), WIDE)).rejects.toBeInstanceOf(ForbiddenError);
    const r = await returnExportRows(ctxAt(env, NOW, OWNER), WIDE);
    expect(r.truncated).toBe(false);
    expect(r.rows.map((x) => x.caseId).sort()).toEqual([aCase, dCase].sort());
    const row = r.rows.find((x) => x.caseId === aCase)!;
    expect(row).toMatchObject({
      orderNumber: a.orderNumber,
      kind: "customer_return",
      status: "received",
      reasonCode: "unknown",
      firstSignalOn: "2026-11-04",
      countryCode: "DE",
      units: 1,
      restockedUnits: 1,
      damagedUnits: 0,
    });
    expect(JSON.stringify(r.rows)).not.toMatch(/Покупець|example\.com|reasonNote/);
    expect((await returnExportRows(ctxAt(env, NOW, OWNER), WIDE, 1)).truncated).toBe(true);
  });
});

describe("review round: amounts per case, order-level remainder, test orders, uncertain quantities", () => {
  // Ревізія WP9 №2: суми випадку — лише записи, віднесені до ЦЬОГО випадку; решта записів замовлення — окремим блоком.
  it("two cases on one order: each case shows only its own refund and expenses; the rest is «order level»; nothing doubles", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const o = await insertOrder(db, { variants: [{ variantId: v.variantId, quantity: 3 }], country: "DE" });
    await addShipment(db, o, { handedOverAt: "2027-01-05T08:00:00Z" });
    const r1 = await addRefund(db, o, { at: "2027-02-01T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "RETURN" }] });
    await syncCases(env, o.orderId);
    const [case1] = (await caseOf(o)) as [string];
    await updateReturnCase(ctxAt(env, NOW, OWNER), { id: case1, expectedVersion: 1, status: "closed" });
    const r2 = await addRefund(db, o, { at: "2027-02-10T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "RETURN" }] });
    const r3 = await addRefund(db, o, { at: "2027-02-12T09:00:00Z", total: "5.00", lines: [] }); // жест доброї волі — без позицій
    await syncCases(env, o.orderId);
    const case2 = (await caseOf(o)).find((id) => id !== case1)!;
    expect((await caseOf(o)).length).toBe(2);
    const eur = { currency: "EUR", fxOn: "2027-02-10", recognizedOn: "2027-02-10" };
    await post(o, { ...eur, category: "refund_product", amount: "-45.00", ...(await refundSale(o, r1, "-45.00")) });
    await post(o, { ...eur, category: "refund_product", amount: "-45.00", ...(await refundSale(o, r2, "-45.00")) });
    await post(o, { ...eur, category: "refund_adjustment", amount: "-5.00", ...(await refundSale(o, r3, "-5.00")) });
    await post(o, { ...eur, category: "return_handling", amount: "-3.00", ...(await caseExpense(o, case2, "return_handling", "3.00", "EUR")) });
    // Рядок рахунку перевізника (WP5) — з замовленням, без випадку.
    await post(o, { ...eur, category: "return_shipping_cost", amount: "-10.00", sourceType: "invoice_line", sourceId: randomUUID() });
    const load = (id: string) => loadReturnAmounts(ctxAt(env, NOW, OWNER), id, { currency: "EUR" });
    const m1 = await load(case1);
    const m2 = await load(case2);
    expect(m1.groups.refunds).toMatchObject({ total: "-45.00", entries: 1 });
    expect(m2.groups.refunds).toMatchObject({ total: "-45.00", entries: 1 });
    expect(m1.groups.returnHandling).toMatchObject({ total: null, entries: 0 });
    expect(m2.groups.returnHandling).toMatchObject({ total: "-3.00", entries: 1 });
    expect(m2.returnCosts).toMatchObject({ total: "-3.00", entries: 1 });
    for (const m of [m1, m2]) {
      expect(m.orderCases).toBe(2);
      expect(m.orderLevel.entries).toBe(2);
      expect(m.orderLevel.groups.refunds).toMatchObject({ total: "-5.00", entries: 1 });
      expect(m.orderLevel.groups.returnShipping).toMatchObject({ total: "-10.00", entries: 1 });
      expect(m.orderLevel.returnCosts).toMatchObject({ total: "-10.00", entries: 1 });
    }
    expect(m1.refunds.map((r) => [r.refundId, r.scope])).toEqual([
      [r1, "case"],
      [r3, "order"],
    ]);
    expect(m2.refunds.map((r) => [r.refundId, r.scope])).toEqual([
      [r2, "case"],
      [r3, "order"],
    ]);
    // Сума за випадками + не прив'язане = усі повернення коштів замовлення (−95.00), без подвійного рахунку.
    const minor = (x: string | null) => BigInt(Math.round(Number(x ?? "0") * 100));
    expect(minor(m1.groups.refunds.total) + minor(m2.groups.refunds.total) + minor(m1.orderLevel.groups.refunds.total)).toBe(-9500n);
  });

  // Ревізія WP9 №5 (§2.5): тестові замовлення Shopify не враховуються без finance.includeTestOrders.
  it("Shopify test orders are left out of statistics and the export unless the owner includes test orders", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db);
    const o = await insertOrder(db, { variants: [{ variantId: v.variantId }], country: "PL" });
    await db.update(orders).set({ shopifyTest: true }).where(eq(orders.id, o.orderId));
    await addRefund(db, o, { at: "2027-03-04T09:00:00Z", lines: [{ line: 0, quantity: 1, restockType: "RETURN" }] });
    await syncCases(env, o.orderId);
    const MAR = { from: "2027-03-01", to: "2027-03-31" };
    const s = await returnStats(ctxAt(env, NOW, STAFF), { range: MAR });
    expect(s).toMatchObject({ cases: 0, byCountry: [], includesTestOrders: false });
    expect((await returnExportRows(ctxAt(env, NOW, OWNER), MAR)).rows).toEqual([]);
    await saveFinanceSettings(ctxAt(env, NOW, OWNER), { includeTestOrders: true });
    try {
      const inc = await returnStats(ctxAt(env, NOW, STAFF), { range: MAR });
      expect(inc).toMatchObject({ cases: 1, includesTestOrders: true });
      expect(inc.byCountry.map((r) => r.key)).toEqual(["PL"]);
      expect((await returnExportRows(ctxAt(env, NOW, OWNER), MAR)).rows).toEqual([expect.objectContaining({ orderId: o.orderId, testOrder: true })]);
    } finally {
      await saveFinanceSettings(ctxAt(env, NOW, OWNER), { includeTestOrders: false });
    }
  });

  // Ревізія WP9 №1 і №3 у статистиці: неточні одиниці (MIXED) — окремо, не в точних; «очікує надходження» — лічильник.
  it("statistics: MIXED units are reported apart as uncertain; awaiting stock receipt is counted; export carries both", async () => {
    const db = env.handle.db;
    const v = await makeVariant(db, { model: "Чохол" });
    const o = await insertOrder(db, { variants: [{ variantId: v.variantId, quantity: 3 }], country: "SK" });
    await addShipment(db, o, { handedOverAt: "2027-04-01T08:00:00Z" });
    await addRefund(db, o, { at: "2027-04-04T09:00:00Z", lines: [{ line: 0, quantity: 3, restockType: "MIXED" }] });
    await syncCases(env, o.orderId);
    const APR = { from: "2027-04-01", to: "2027-04-30" };
    const s = await returnStats(ctxAt(env, NOW, STAFF), { range: APR });
    expect(s.cases).toBe(1);
    expect(s.byKind).toEqual([{ key: "customer_return", cases: 1, units: 0 }]);
    expect(s.units).toEqual({ total: 0, restocked: 0, notRestocked: 0, damaged: 0, uncertain: 3, uncertainCases: 1 });
    expect(s.awaitingReceipt).toBe(1);
    expect(s.byModel).toEqual([{ key: "Чохол", label: "Чохол", cases: 1, units: 0 }]);
    expect((await returnExportRows(ctxAt(env, NOW, OWNER), APR)).rows).toEqual([
      expect.objectContaining({ kind: "customer_return", units: 0, uncertainUnits: 3, awaitingReceipt: true, testOrder: false }),
    ]);
  });
});

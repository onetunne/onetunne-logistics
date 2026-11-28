/**
 * Етап 6, WP6: сума періоду замість прогнозу — межі застосування (§10.3, §8.1, §3.3, I16; регресії огляду WP6).
 * - Розподіляється лише ДОДАТНА сума з виміром: рахунок Shopify за тариф і застосунки (`platform_fees` без шлюзу) і
 *   «Доставка (інше)» без перевізника — звичайні витрати періоду (прогнози замовлень не зникають); кредит (від'ємна
 *   сума) — запис періоду «+», не «замінює» і не блокує справжню суму (G13 після кредиту — 3,50 / 2,33 / 1,17).
 * - Складник «уже фактичний» — і коли факт джерела ще не проведений (R1: чекає визнання): комісія Shopify
 *   (`order_transaction_fees`), упаковка (`material_consume`), зіставлений рядок рахунку перевізника.
 * - I16 після збереження суми: пізнє замовлення того самого виміру й місяця — `awaiting_reallocation` для WP4
 *   (coveringStatusForOrder), після «Перерахувати розподіл» — `allocated`.
 * - Дата курсу частки — дата документа суми (R3), дата періоду — дата визнання замовлення.
 * - Попередження «загальна сума упаковки поряд із прогнозами» зникає після анулювання суми (діючі записи).
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  carrierInvoiceLines,
  carrierInvoices,
  financeExpenseAllocations,
  inventoryValuations,
  orderTransactionFees,
  orderTransactions,
  packagingMaterials,
  stockItems,
  warehouses,
} from "~/db/schema";
import type { Db } from "~/db/client.server";
import { coveringStatusForOrder } from "~/modules/expenses/allocation.server";
import { coverageWarnings, createExpense, recalculateAllocation, voidExpense, type ExpenseInput } from "~/modules/expenses/expenses.server";
import type { TestEnv } from "../../helpers";
import { activeEntriesOf, ctxAt, entriesOf, insertOrder, op, openEnv, rate, recognize, sumMinor, sumUah } from "./helpers";

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

const sharesOf = (expenseId: string) => env.handle.db.select().from(financeExpenseAllocations).where(eq(financeExpenseAllocations.expenseId, expenseId));

async function shopifyFee(db: Db, orderId: string, amount: string): Promise<void> {
  const [t] = await db
    .insert(orderTransactions)
    .values({ orderId, shopifyTransactionId: `gid://shopify/OrderTransaction/${randomUUID()}`, kind: "SALE", status: "SUCCESS", gateway: "shopify_payments", amount: "100.00", currency: "EUR", processedAt: new Date() })
    .returning();
  await db.insert(orderTransactionFees).values({ transactionId: t!.id, orderId, shopifyFeeId: `gid://shopify/TransactionFee/${randomUUID()}`, amount, currency: "EUR", type: "payment" });
}

async function packagingConsumed(db: Db, orderId: string, on: string): Promise<void> {
  const [wh] = await db.insert(warehouses).values({ name: "Тестовий склад", countryCode: "UA", city: "Київ" }).returning();
  const [m] = await db.insert(packagingMaterials).values({ code: `box-${randomUUID().slice(0, 8)}`, name: "Коробка", kind: "box" }).returning();
  const [item] = await db.insert(stockItems).values({ kind: "material", materialId: m!.id }).returning();
  await db.insert(inventoryValuations).values({
    eventKey: `test:${randomUUID()}`,
    movementId: randomUUID(),
    warehouseId: wh!.id,
    stockItemId: item!.id,
    currency: "UAH",
    kind: "outflow",
    qty: 1,
    knownQty: 1,
    value: "12.00",
    valueSource: "pool_average",
    orderId,
    occurredOn: on,
    details: { movementType: "material_consume" },
  });
}

async function invoiceLine(db: Db, orderId: string, matchStatus: "matched" | "unmatched"): Promise<void> {
  const [inv] = await db
    .insert(carrierInvoices)
    .values({
      carrierCode: "nova_post",
      documentKind: "invoice",
      invoiceNumber: `INV-${randomUUID().slice(0, 8)}`,
      invoiceNumberNorm: randomUUID(),
      fileSha256: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      fileSize: 10,
      fileKind: "csv",
      operationId: randomUUID(),
      importedBy: "test",
    })
    .returning();
  await db.insert(carrierInvoiceLines).values({ invoiceId: inv!.id, rowNumber: 1, lineKind: "charge", chargeType: "delivery", amount: "480.00", currency: "UAH", orderId, matchStatus });
}

describe("a sum replaces forecasts only with its dimension and a positive amount (§10.3, §8.1)", () => {
  it("the Shopify plan + apps bill (platform_fees, no gateway) is a period expense: no shares, the orders keep their fee forecasts for the real statement", async () => {
    const db = env.handle.db;
    const a = await insertOrder(db, { placedOn: "2026-04-03", gateway: "paypal", state: "recognized", forecasts: [{ component: "fees", amount: "3.49" }, { component: "shipping_cost", amount: "12.00" }] });
    const b = await insertOrder(db, { placedOn: "2026-04-10", gateway: "shopify_payments", state: "recognized", forecasts: [{ component: "fees", amount: "2.90" }, { component: "shipping_cost", amount: "15.00" }] });
    // Форма надсилає типове «замінює прогноз» — для суми без шлюзу воно не застосовується.
    const plan = await createExpense(ctxAt(env, NOW), fees({ category: "platform_fees", gateway: "", amount: "39,00", expenseDate: "2026-04-30", coverage: "covers", description: "Shopify plan + apps" }));
    expect(plan).toMatchObject({ allocatedOrders: null, coverageNote: "no_dimension" });
    expect(await sharesOf(plan.id)).toHaveLength(0);
    expect((await entriesOf(db, plan.id)).map((e) => [e.idempotencyKey, e.amount, e.orderId])).toEqual([[`exp:${plan.id}:v1`, "-39.00", null]]);
    // «Доставка (інше)» без перевізника — так само.
    const pickup = await createExpense(ctxAt(env, NOW), fees({ category: "shipping_cost", gateway: null, amount: "5,00", expenseDate: "2026-04-30", coverage: "covers", description: "courier pickup fee" }));
    expect(pickup).toMatchObject({ allocatedOrders: null, coverageNote: "no_dimension" });
    expect(await sharesOf(pickup.id)).toHaveLength(0);
    for (const id of [a, b]) expect(await coveringStatusForOrder(db, id, { mode: "demo" })).toEqual([]);
    // Справжня виписка PayPal за квітень (зі шлюзом) — розподіляється як звичайно.
    const pp = await createExpense(ctxAt(env, NOW), fees({ amount: "3,60", expenseDate: "2026-04-30" }));
    expect((await sharesOf(pp.id)).map((s) => [s.orderId, s.amount])).toEqual([[a, "3.60"]]);
  });

  it("a credit never covers: G13 forecasts + credit −1,00 → a +1,00 period entry; the real 7,00 sum is still allocated 3,50 / 2,33 / 1,17", async () => {
    const db = env.handle.db;
    const ids: string[] = [];
    for (const [d, f] of [["03", "3.00"], ["10", "2.00"], ["20", "1.00"]] as const) {
      ids.push(await insertOrder(db, { placedOn: `2026-03-${d}`, gateway: "credit-gw", state: "recognized", recognizedOn: `2026-03-${d}`, forecasts: [{ component: "fees", amount: f }] }));
    }
    const credit = await createExpense(ctxAt(env, NOW), fees({ gateway: "credit-gw", amount: "-1,00", expenseDate: "2026-03-31", coverage: "covers" }));
    expect(credit).toMatchObject({ allocatedOrders: null, coverageNote: "credit" });
    expect(await sharesOf(credit.id)).toHaveLength(0);
    expect((await entriesOf(db, credit.id)).map((e) => [e.amount, e.orderId])).toEqual([["1.00", null]]);
    const real = await createExpense(ctxAt(env, NOW), fees({ gateway: "credit-gw", amount: "7,00", expenseDate: "2026-03-31" }));
    expect(real).toMatchObject({ allocatedOrders: 3, weightBasis: "forecast", coverageNote: null });
    const share = new Map((await sharesOf(real.id)).map((s) => [s.orderId, s.amount]));
    expect(ids.map((id) => share.get(id))).toEqual(["3.50", "2.33", "1.17"]);
    expect(sumMinor(await activeEntriesOf(db, real.id))).toBe(-700n);
  });
});

describe("a component already actual in the source (not yet posted) gets no share (§10.3, R1)", () => {
  it("open orders with a Shopify fee, a packaging consumption or a matched carrier invoice line are not candidates", async () => {
    const db = env.handle.db;
    const fee = await insertOrder(db, { placedOn: "2026-02-10", gateway: "shopify_payments", state: "open", forecasts: [{ component: "fees", amount: "2.90" }] });
    await shopifyFee(db, fee, "2.90");
    const feeless = await insertOrder(db, { placedOn: "2026-02-11", gateway: "shopify_payments", state: "open", forecasts: [{ component: "fees", amount: "1.00" }] });
    const r = await createExpense(ctxAt(env, NOW), fees({ gateway: "shopify_payments", amount: "10,00", expenseDate: "2026-02-28" }));
    expect((await sharesOf(r.id)).map((s) => [s.orderId, s.amount])).toEqual([[feeless, "10.00"]]);

    const packed = await insertOrder(db, { placedOn: "2026-02-12", currency: "UAH", state: "open", forecasts: [{ component: "packaging", amount: "20.00", currency: "UAH" }] });
    await packagingConsumed(db, packed, "2026-02-13");
    const unpacked = await insertOrder(db, { placedOn: "2026-02-14", currency: "UAH", state: "open", forecasts: [{ component: "packaging", amount: "20.00", currency: "UAH" }] });
    const pkg = await createExpense(ctxAt(env, NOW), fees({ category: "packaging", gateway: null, amount: "30", currency: "UAH", expenseDate: "2026-02-28" }));
    expect((await sharesOf(pkg.id)).map((s) => [s.orderId, s.amount])).toEqual([[unpacked, "30.00"]]);

    const invoiced = await insertOrder(db, { placedOn: "2026-02-15", currency: "UAH", carrier: "nova_post", state: "open", forecasts: [{ component: "shipping_cost", amount: "500.00", currency: "UAH" }] });
    await invoiceLine(db, invoiced, "matched");
    const notMatched = await insertOrder(db, { placedOn: "2026-02-16", currency: "UAH", carrier: "nova_post", state: "open", forecasts: [{ component: "shipping_cost", amount: "500.00", currency: "UAH" }] });
    await invoiceLine(db, notMatched, "unmatched");
    const ship = await createExpense(ctxAt(env, NOW), fees({ category: "shipping_cost", gateway: null, carrierCode: "nova_post", amount: "600", currency: "UAH", expenseDate: "2026-02-28" }));
    expect((await sharesOf(ship.id)).map((s) => [s.orderId, s.amount])).toEqual([[notMatched, "600.00"]]);
  });

  it("a fact arriving after the allocation makes it stale (warning + recalculation drops the order)", async () => {
    const db = env.handle.db;
    const a = await insertOrder(db, { placedOn: "2026-01-05", gateway: "stale-gw", state: "open", forecasts: [{ component: "fees", amount: "2.00" }] });
    const b = await insertOrder(db, { placedOn: "2026-01-06", gateway: "stale-gw", state: "open", forecasts: [{ component: "fees", amount: "2.00" }] });
    const r = await createExpense(ctxAt(env, NOW), fees({ gateway: "stale-gw", amount: "4,00", expenseDate: "2026-01-31" }));
    expect(await sharesOf(r.id)).toHaveLength(2);
    await shopifyFee(db, a, "1.90");
    expect((await coverageWarnings(ctxAt(env, NOW), "2026-01-01")).stale).toEqual([{ expenseId: r.id, category: "payment_fees", current: 2, next: 1 }]);
    const re = await recalculateAllocation(ctxAt(env, NOW), { expenseId: r.id });
    expect(re).toMatchObject({ changed: true, version: 2, allocatedOrders: 1 });
    expect((await sharesOf(r.id)).filter((s) => s.expenseVersion === 2).map((s) => [s.orderId, s.amount])).toEqual([[b, "4.00"]]);
  });
});

describe("correction from an order-linked fee to a period sum", () => {
  it("the replaced expense's own (still unreversed) entry does not make the order «already actual»: the new sum covers it", async () => {
    const db = env.handle.db;
    const x = await insertOrder(db, { placedOn: "2026-05-04", gateway: "fix-gw", state: "recognized", recognizedOn: "2026-05-05", forecasts: [{ component: "fees", amount: "2.00" }] });
    const y = await insertOrder(db, { placedOn: "2026-05-06", gateway: "fix-gw", state: "recognized", recognizedOn: "2026-05-07", forecasts: [{ component: "fees", amount: "2.00" }] });
    const linked = await createExpense(ctxAt(env, NOW), fees({ gateway: "", amount: "4,00", expenseDate: "2026-05-20", order: x }));
    expect((await activeEntriesOf(db, linked.id)).map((e) => e.orderId)).toEqual([x]);
    const { replaceExpense } = await import("~/modules/expenses/expenses.server");
    const r = await replaceExpense(ctxAt(env, NOW), { ...fees({ gateway: "fix-gw", amount: "4,00", expenseDate: "2026-05-31" }), expenseId: linked.id, reason: "Це виписка за місяць, а не комісія замовлення" });
    expect(r).toMatchObject({ allocatedOrders: 2, reversed: 1 });
    expect((await sharesOf(r.id)).map((s) => [s.orderId, s.amount]).sort()).toEqual([[x, "2.00"], [y, "2.00"]].sort());
    expect(await activeEntriesOf(db, linked.id)).toHaveLength(0);
    expect(sumMinor(await activeEntriesOf(db, r.id))).toBe(-400n);
  });
});

describe("I16 after the sum was saved (coveringStatusForOrder for WP4)", () => {
  it("an order placed later in the covered (gateway, month) is «awaiting reallocation» (its forecast must not count), then «allocated» after recalculation", async () => {
    const db = env.handle.db;
    const a = await insertOrder(db, { placedOn: "2026-08-03", gateway: "late-gw", state: "recognized", recognizedOn: "2026-08-04", forecasts: [{ component: "fees", amount: "3.00" }] });
    const r = await createExpense(ctxAt(env, "2026-08-15T10:00:00Z"), fees({ gateway: "late-gw", amount: "7,00", expenseDate: "2026-08-15" }));
    expect(await coveringStatusForOrder(db, a, { mode: "demo" })).toEqual([{ component: "fees", category: "payment_fees", expenseId: r.id, expenseVersion: 1, state: "allocated" }]);
    const late = await insertOrder(db, { placedOn: "2026-08-25", gateway: "late-gw", state: "open", forecasts: [{ component: "fees", amount: "4.00" }] });
    expect(await coveringStatusForOrder(db, late, { mode: "demo" })).toEqual([{ component: "fees", category: "payment_fees", expenseId: r.id, expenseVersion: 1, state: "awaiting_reallocation" }]);
    // Як викликає WP4 (режим і includeTestOrders — з бази й налаштувань).
    expect(await coveringStatusForOrder(db, late)).toMatchObject([{ expenseId: r.id, state: "awaiting_reallocation" }]);
    // Без прогнозу (частку за прогнозом не отримає) — подвійного обліку немає, не позначається; інший шлюз / місяць — теж.
    const noForecast = await insertOrder(db, { placedOn: "2026-08-26", gateway: "late-gw", state: "open" });
    const otherGw = await insertOrder(db, { placedOn: "2026-08-26", gateway: "other-gw", state: "open", forecasts: [{ component: "fees", amount: "4.00" }] });
    const otherMonth = await insertOrder(db, { placedOn: "2026-09-01", gateway: "late-gw", state: "open", forecasts: [{ component: "fees", amount: "4.00" }] });
    for (const id of [noForecast, otherGw, otherMonth]) expect(await coveringStatusForOrder(db, id, { mode: "demo" })).toEqual([]);
    expect((await coverageWarnings(ctxAt(env, NOW), "2026-08-01")).stale.map((s) => s.expenseId)).toEqual([r.id]);
    await recalculateAllocation(ctxAt(env, NOW), { expenseId: r.id, expectedVersion: 1 });
    expect(await coveringStatusForOrder(db, late, { mode: "demo" })).toEqual([{ component: "fees", category: "payment_fees", expenseId: r.id, expenseVersion: 2, state: "allocated" }]);
    expect(await coveringStatusForOrder(db, a, { mode: "demo" })).toMatchObject([{ state: "allocated", expenseVersion: 2 }]);
    // Анульована сума нічого не покриває.
    await voidExpense(ctxAt(env, NOW), { expenseId: r.id, reason: "тест" });
    expect(await coveringStatusForOrder(db, late, { mode: "demo" })).toEqual([]);
  });
});

describe("rate date of a share (§3.3 R3)", () => {
  it("a 30.11 EUR sum on an order recognized 02.12: recognized_on = 02.12, fx_on = 30.11 (the document date) — Σ shares in UAH = the sum at its own rate", async () => {
    const db = env.handle.db;
    await rate(db, "EUR", "2026-11-30", "50.0000");
    await rate(db, "EUR", "2026-12-02", "40.0000");
    const o1 = await insertOrder(db, { placedOn: "2026-11-27", gateway: "fx-gw", state: "recognized", recognizedOn: "2026-12-02", forecasts: [{ component: "fees", amount: "1.00" }] });
    const o2 = await insertOrder(db, { placedOn: "2026-11-28", gateway: "fx-gw", state: "open", forecasts: [{ component: "fees", amount: "2.00" }] });
    const r = await createExpense(ctxAt(env, NOW), fees({ gateway: "fx-gw", amount: "3,00" }));
    expect((await activeEntriesOf(db, r.id)).map((e) => [e.orderId, e.amount, e.recognizedOn, e.fxOn])).toEqual([[o1, "-1.00", "2026-12-02", "2026-11-30"]]);
    await recognize(db, o2, "2026-12-05");
    const { syncOrderExpenseEntries } = await import("~/modules/expenses/posting.server");
    await db.transaction((tx) => syncOrderExpenseEntries(tx, { id: "system" }, o2));
    const all = await activeEntriesOf(db, r.id);
    expect(all.map((e) => e.fxOn)).toEqual(["2026-11-30", "2026-11-30"]);
    expect(sumUah(all, { EUR: { "2026-11-30": "50.0000" } })).toBe("-150.00");
  });
});

describe("packaging double-count warning (§10.3) counts only active totals", () => {
  it("after voiding the month's only packaging total the warning disappears", async () => {
    const db = env.handle.db;
    await insertOrder(db, { placedOn: "2026-06-03", currency: "UAH", state: "recognized", recognizedOn: "2026-06-04", forecasts: [{ component: "packaging", amount: "20.00", currency: "UAH" }] });
    const r = await createExpense(ctxAt(env, NOW), fees({ category: "packaging", gateway: null, amount: "50.00", currency: "UAH", expenseDate: "2026-06-10", coverage: "separate", separateReason: "Коробки на місяць" }));
    expect((await coverageWarnings(ctxAt(env, NOW), "2026-06-01")).packaging).toMatchObject({ month: "2026-06-01", totals: 1, ordersWithForecast: 1 });
    await voidExpense(ctxAt(env, NOW), { expenseId: r.id, reason: "Помилка" });
    expect(await entriesOf(db, r.id)).toHaveLength(2);
    expect((await coverageWarnings(ctxAt(env, NOW), "2026-06-01")).packaging).toBeNull();
  });
});

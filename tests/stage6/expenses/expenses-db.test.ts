/**
 * Етап 6, WP6: ручні витрати й доходи на БД (§10.1, §10.2, §3.3, §3.4, F2; золоті G7, G11b; I12, I14).
 * - G7: 1 000,00 UAH реклами за 01–30.11 → 10 × −33,34 + 20 × −33,33, по запису на день, ключ exp:<id>:v1:<день>.
 * - Знак запису: витрата → −сума, кредит (від'ємна витрата) → +, дохід → +.
 * - Той самий operationId — одна витрата; редагування = новий рядок (supersedes_id) + анулювання старого (сторно).
 * - G11b: реклама 100,00 EUR 20.10 (48,50) → виправлено на 90,00 EUR 06.11 → жовтень −4 365,00 UAH, листопад 0.
 * - Закритий місяць: створення, виправлення й анулювання, датовані ним, — відмова.
 * - Витрати на повернення — з обов'язковим замовленням; випадок повернення — того самого замовлення; запис — після
 *   визнання замовлення (R2: max(дата, визнання)).
 * - Анулювання рядка «Списати невикористані витрати партії» (WP2) — сторно.
 * - Працівник (і підроблений актор із дозволами) — 403.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeEntries, financeExpenses, orderReturns, productionBatches } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { writeOffBatchCosts } from "~/modules/costing/batch-writeoff.server";
import { createExpense, getExpense, listExpenses, replaceExpense, voidExpense, type ExpenseInput } from "~/modules/expenses/expenses.server";
import { syncOrderExpenseEntries } from "~/modules/expenses/posting.server";
import type { TestEnv } from "../../helpers";
import { STAFF } from "../../helpers";
import { activeEntriesOf, closeMonthRow, ctxAt, entriesOf, insertOrder, op, openEnv, OWNER, rate, recognize, sumMinor, sumUah } from "./helpers";

let env: TestEnv;
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const NOW = "2026-11-28T10:00:00Z";

beforeAll(async () => {
  env = await openEnv();
});
afterAll(async () => {
  await env.close();
});

const base = (over: Partial<ExpenseInput>): ExpenseInput => ({
  operationId: op(),
  category: "advertising",
  amount: "100,00",
  currency: "UAH",
  dateMode: "single",
  expenseDate: "2026-11-10",
  ...over,
});

const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof ForbiddenError) return "forbidden";
    throw e;
  }
  return "ok";
};

describe("G7 — daily allocation of a service period", () => {
  it("1 000,00 UAH for 01–30.11 → 10 × 33,34 + 20 × 33,33 (one entry per day, earlier days take the remainder)", async () => {
    const r = await createExpense(ctxAt(env, NOW), base({ amount: "1 000,00", dateMode: "period", periodFrom: "2026-11-01", periodTo: "2026-11-30", channel: "meta" }));
    const es = await entriesOf(env.handle.db, r.id);
    expect(es).toHaveLength(30);
    expect(es.filter((e) => e.amount === "-33.34")).toHaveLength(10);
    expect(es.filter((e) => e.amount === "-33.33")).toHaveLength(20);
    expect(sumMinor(es)).toBe(-100000n);
    const first = es.find((e) => e.recognizedOn === "2026-11-01")!;
    expect(first).toMatchObject({ amount: "-33.34", fxOn: "2026-11-01", idempotencyKey: `exp:${r.id}:v1:2026-11-01`, category: "advertising", sourceType: "expense", orderId: null, postedBy: OWNER.id });
    expect(es.find((e) => e.recognizedOn === "2026-11-10")!.amount).toBe("-33.34");
    expect(es.find((e) => e.recognizedOn === "2026-11-11")!.amount).toBe("-33.33");
    expect(first.details).toMatchObject({ kind: "manual", channel: "meta", periodFrom: "2026-11-01", periodTo: "2026-11-30" });
  });

  it("a 0-decimal currency is split in whole units (1 000 JPY over 3 days → 334 / 333 / 333)", async () => {
    const r = await createExpense(ctxAt(env, NOW), base({ amount: "1000", currency: "JPY", dateMode: "period", periodFrom: "2026-11-01", periodTo: "2026-11-03" }));
    const es = await entriesOf(env.handle.db, r.id);
    expect(es.map((e) => e.amount)).toEqual(["-334.00", "-333.00", "-333.00"]);
  });
});

describe("signs, idempotency, validation", () => {
  it("expense → −amount, credit (negative expense) → +, income → +", async () => {
    const a = await createExpense(ctxAt(env, NOW), base({ category: "rent", amount: "500" }));
    const c = await createExpense(ctxAt(env, NOW), base({ category: "services", amount: "-120" }));
    const i = await createExpense(ctxAt(env, NOW), base({ category: "other_income", amount: "300,50" }));
    expect((await entriesOf(env.handle.db, a.id)).map((e) => e.amount)).toEqual(["-500.00"]);
    expect((await entriesOf(env.handle.db, c.id)).map((e) => e.amount)).toEqual(["120.00"]);
    expect((await entriesOf(env.handle.db, i.id)).map((e) => e.amount)).toEqual(["300.50"]);
    const [row] = await env.handle.db.select().from(financeExpenses).where(eq(financeExpenses.id, c.id));
    expect(row).toMatchObject({ amount: "-120.00", status: "active", version: 1, createdBy: OWNER.id });
  });

  it("the same operationId twice → one expense and one entry", async () => {
    const input = base({ category: "salaries", amount: "2000" });
    const first = await createExpense(ctxAt(env, NOW), input);
    const again = await createExpense(ctxAt(env, NOW), input);
    expect(again).toMatchObject({ id: first.id, duplicate: true });
    const [n] = await env.handle.db.select({ c: count() }).from(financeExpenses).where(eq(financeExpenses.operationId, input.operationId));
    expect(Number(n!.c)).toBe(1);
    expect(await entriesOf(env.handle.db, first.id)).toHaveLength(1);
  });

  it("refuses: zero amount, forbidden order, required order, production costs, period > 366 days, separate without reason", async () => {
    const orderId = await insertOrder(env.handle.db, { placedOn: "2026-11-02" });
    const [o] = await env.handle.db.select().from(financeExpenses).limit(0);
    void o;
    const ctx = ctxAt(env, NOW);
    expect(await codeOf(createExpense(ctx, base({ amount: "0" })))).toBe("financeExpenses.error.amountZero");
    expect(await codeOf(createExpense(ctx, base({ order: orderId })))).toBe("financeExpenses.error.orderForbidden");
    expect(await codeOf(createExpense(ctx, base({ category: "return_handling" })))).toBe("financeExpenses.error.orderRequired");
    expect(await codeOf(createExpense(ctx, base({ category: "inventory_loss" })))).toBe("financeExpenses.error.batchOnly");
    expect(await codeOf(createExpense(ctx, base({ dateMode: "period", periodFrom: "2026-01-01", periodTo: "2027-01-02" })))).toBe("financeExpenses.error.periodInvalid");
    expect(await codeOf(createExpense(ctx, base({ category: "payment_fees", gateway: "paypal", coverage: "separate" })))).toBe("financeExpenses.error.separateReasonRequired");
    expect(await codeOf(createExpense(ctx, base({ category: "partner_fixed_fee" })))).toBe("financeExpenses.error.partnerRequired");
    expect(await codeOf(createExpense(ctx, base({ amount: "12,50", currency: "JPY" })))).toBe("finance.error.amountWholeUnits");
    expect(await codeOf(createExpense(ctx, base({ amount: "1,5,0" })))).toBe("finance.error.amountAmbiguous");
    expect(await codeOf(createExpense(ctx, base({ currency: "KWD" })))).toBe("finance.error.unsupportedCurrency");
    expect(await codeOf(createExpense(ctx, base({ order: "#NOPE" , category: "return_handling" })))).toBe("financeExpenses.error.orderNotFound");
  });

  it("staff and a forged staff actor with finance permissions get 403; owner reads", async () => {
    expect(await codeOf(createExpense(ctxAt(env, NOW, STAFF), base({})))).toBe("forbidden");
    expect(await codeOf(createExpense(ctxAt(env, NOW, FORGED), base({})))).toBe("forbidden");
    expect(await codeOf(listExpenses(ctxAt(env, NOW, STAFF)))).toBe("forbidden");
    expect(await codeOf(listExpenses(ctxAt(env, NOW, FORGED)))).toBe("forbidden");
    const list = await listExpenses(ctxAt(env, NOW), { month: "2026-11-01" });
    expect(list.total).toBeGreaterThan(0);
  });
});

describe("G11b — correction posts the reversal at the original date and rate", () => {
  it("100,00 EUR on 20.10 (48,50) corrected to 90,00 EUR on 06.11 → October −4 365,00 UAH, November 0", async () => {
    const db = env.handle.db;
    await rate(db, "EUR", "2026-10-20", "48.5000");
    const created = await createExpense(ctxAt(env, "2026-10-21T10:00:00Z"), base({ currency: "EUR", amount: "100,00", expenseDate: "2026-10-20" }));
    expect(sumUah(await entriesOf(db, created.id), { EUR: { "2026-10-20": "48.5000" } })).toBe("-4850.00");
    const replaced = await replaceExpense(ctxAt(env, "2026-11-06T10:00:00Z"), {
      ...base({ currency: "EUR", amount: "90,00", expenseDate: "2026-10-20" }),
      expenseId: created.id,
      expectedVersion: 1,
      reason: "Рахунок Meta уточнено",
    });
    expect(replaced.replacedId).toBe(created.id);
    const oldEntries = await entriesOf(db, created.id);
    expect(oldEntries).toHaveLength(2);
    const reversal = oldEntries.find((e) => e.reversesEntryId)!;
    expect(reversal).toMatchObject({ amount: "100.00", recognizedOn: "2026-10-20", fxOn: "2026-10-20", isLate: false, idempotencyKey: `exp:${created.id}:v1:rev` });
    const newEntries = await entriesOf(db, replaced.id);
    expect(newEntries.map((e) => [e.amount, e.recognizedOn, e.fxOn])).toEqual([["-90.00", "2026-10-20", "2026-10-20"]]);
    const all = [...oldEntries, ...newEntries];
    const rates = { EUR: { "2026-10-20": "48.5000" } };
    expect(sumUah(all.filter((e) => e.recognizedOn.startsWith("2026-10")), rates)).toBe("-4365.00");
    expect(all.filter((e) => e.recognizedOn.startsWith("2026-11"))).toHaveLength(0);
    // I14: оригінал + сторно = 0 у валюті показу (той самий fx_on).
    expect(sumUah([oldEntries[0]!, reversal], rates)).toBe("0.00");
    const [oldRow] = await db.select().from(financeExpenses).where(eq(financeExpenses.id, created.id));
    expect(oldRow).toMatchObject({ status: "voided", version: 2, voidReason: "Рахунок Meta уточнено" });
    const [newRow] = await db.select().from(financeExpenses).where(eq(financeExpenses.id, replaced.id));
    expect(newRow).toMatchObject({ status: "active", supersedesId: created.id, amount: "90.00" });
    const logs = await db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, created.id));
    expect(logs.map((l) => l.action).sort()).toEqual(["create", "replace"]);
    const replaceLog = logs.find((l) => l.action === "replace")!;
    expect(replaceLog.before).toMatchObject({ amount: "100.00", currency: "EUR", status: "active" });
    expect(replaceLog.after).toMatchObject({ status: "voided" });
    const detail = await getExpense(ctxAt(env, NOW), created.id);
    expect(detail.supersededById).toBe(replaced.id);
  });

  it("a stale version (another user edited) → conflict; replacing a voided row → refused", async () => {
    const created = await createExpense(ctxAt(env, NOW), base({ category: "bank_fees", amount: "15" }));
    const input = { ...base({ category: "bank_fees", amount: "16" }), expenseId: created.id, reason: "fix" };
    expect(await codeOf(replaceExpense(ctxAt(env, NOW), { ...input, expectedVersion: 7 }))).toBe("error.conflict");
    await voidExpense(ctxAt(env, NOW), { expenseId: created.id, reason: "дубль", expectedVersion: 1 });
    expect(await codeOf(replaceExpense(ctxAt(env, NOW), { ...input, operationId: op(), expectedVersion: 2 }))).toBe("financeExpenses.error.alreadyVoided");
    expect(await codeOf(voidExpense(ctxAt(env, NOW), { expenseId: created.id, reason: "" }))).toBe("financeExpenses.error.reasonRequired");
  });
});

describe("closed month (§3.4, I12)", () => {
  it("creating, correcting or voiding an expense dated in a closed month is refused; system facts go late", async () => {
    const db = env.handle.db;
    const sept = await createExpense(ctxAt(env, "2026-09-25T10:00:00Z"), base({ amount: "70", expenseDate: "2026-09-15" }));
    const spanning = await createExpense(ctxAt(env, "2026-09-25T10:00:00Z"), base({ amount: "61", dateMode: "period", periodFrom: "2026-08-31", periodTo: "2026-09-01" }));
    await closeMonthRow(db, "2026-09-01");
    const ctx = ctxAt(env, NOW);
    expect(await codeOf(createExpense(ctx, base({ expenseDate: "2026-09-20" })))).toBe("finance.error.monthClosed");
    expect(await codeOf(createExpense(ctx, base({ dateMode: "period", periodFrom: "2026-09-30", periodTo: "2026-10-05" })))).toBe("finance.error.monthClosed");
    expect(await codeOf(voidExpense(ctx, { expenseId: sept.id, reason: "x" }))).toBe("finance.error.monthClosed");
    expect(await codeOf(voidExpense(ctx, { expenseId: spanning.id, reason: "x" }))).toBe("finance.error.monthClosed");
    expect(await codeOf(replaceExpense(ctx, { ...base({ expenseDate: "2026-10-02" }), expenseId: sept.id, reason: "move" }))).toBe("finance.error.monthClosed");
    // Нічого не змінилося.
    expect((await activeEntriesOf(db, sept.id)).map((e) => e.amount)).toEqual(["-70.00"]);
    // I12: жоден новий запис не має recognized_on у закритому місяці.
    const sepEntries = await db.select().from(financeEntries).where(and(eq(financeEntries.recognizedOn, "2026-09-20")));
    expect(sepEntries).toHaveLength(0);
  });
});

describe("return costs (§10.1, §11) and order-linked expenses (§3.3)", () => {
  it("require an order; a return case must belong to it; the entry waits for recognition and then uses max(date, recognition)", async () => {
    const db = env.handle.db;
    const orderId = await insertOrder(db, { placedOn: "2026-11-03", currency: "EUR" });
    const otherOrder = await insertOrder(db, { placedOn: "2026-11-03" });
    const [ret] = await db.insert(orderReturns).values({ orderId, kind: "customer_return", source: "manual", sourceKey: `ret:manual:${op()}`, createdBy: "test" }).returning();
    const ctx = ctxAt(env, NOW);
    expect(await codeOf(createExpense(ctx, base({ category: "return_shipping_cost", order: otherOrder, returnId: ret!.id })))).toBe("financeExpenses.error.returnOtherOrder");
    expect(await codeOf(createExpense(ctx, base({ category: "advertising", returnId: ret!.id })))).toBe("financeExpenses.error.orderForbidden");
    const r = await createExpense(ctx, base({ category: "return_shipping_cost", amount: "250", order: orderId, returnId: ret!.id, expenseDate: "2026-11-12", carrierCode: "nova_post" }));
    expect(r).toMatchObject({ posted: 0, awaiting: 1 });
    expect(await entriesOf(db, r.id)).toHaveLength(0);
    const listed = (await listExpenses(ctx, { month: "2026-11-01" })).items.find((i) => i.id === r.id)!;
    expect(listed).toMatchObject({ awaitingOrder: true, returnId: ret!.id, carrierCode: "nova_post" });
    // Визнання 05.11 (раніше за витрату 12.11) → R2: max(12.11, 05.11) = 12.11.
    await recognize(db, orderId, "2026-11-05");
    await db.transaction((tx) => syncOrderExpenseEntries(tx, { id: "system" }, orderId));
    const es = await entriesOf(db, r.id);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ amount: "-250.00", recognizedOn: "2026-11-12", fxOn: "2026-11-12", orderId, category: "return_shipping_cost", carrierCode: "nova_post" });
    expect(es[0]!.details).toMatchObject({ returnId: ret!.id });
    // Повтор — без нових записів (ідемпотентно).
    await db.transaction((tx) => syncOrderExpenseEntries(tx, { id: "system" }, orderId));
    expect(await entriesOf(db, r.id)).toHaveLength(1);
  });

  it("an order component (manual shipping cost) uses the recognition date (R1/R3, late completion) and the expense date for the rate", async () => {
    const db = env.handle.db;
    const orderId = await insertOrder(db, { placedOn: "2026-11-01", state: "recognized", recognizedOn: "2026-11-02" });
    const r = await createExpense(ctxAt(env, NOW), base({ category: "shipping_cost", amount: "540", order: orderId, expenseDate: "2026-11-20" }));
    const es = await entriesOf(db, r.id);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({ recognizedOn: "2026-11-02", fxOn: "2026-11-20", isLateCompletion: true, orderId, amount: "-540.00" });
  });

  it("an order cancelled before shipping → the expense is a period cost with order_id at its own date (R5)", async () => {
    const db = env.handle.db;
    const orderId = await insertOrder(db, { placedOn: "2026-11-01", state: "closed_unrecognized" });
    const r = await createExpense(ctxAt(env, NOW), base({ category: "payment_fees", amount: "3,10", currency: "EUR", order: orderId, expenseDate: "2026-11-04" }));
    expect((await entriesOf(db, r.id)).map((e) => [e.recognizedOn, e.orderId, e.amount])).toEqual([["2026-11-04", orderId, "-3.10"]]);
  });
});

describe("G10 — a manual chargeback fee is a later event (R2, §8.2 «датою комісії»)", () => {
  it("15,00 EUR on 12.11 for an order recognized 05.10 → recognized on 12.11 (not October), fx_on 12.11, no late-completion flag", async () => {
    const db = env.handle.db;
    const orderId = await insertOrder(db, { placedOn: "2026-10-04", state: "recognized", recognizedOn: "2026-10-05" });
    const r = await createExpense(ctxAt(env, NOW), base({ category: "chargeback_fees", amount: "15.00", currency: "EUR", order: orderId, expenseDate: "2026-11-12" }));
    const es = await activeEntriesOf(db, r.id);
    expect(es.map((e) => ({ key: e.idempotencyKey, recognizedOn: e.recognizedOn, fxOn: e.fxOn, late: e.isLateCompletion, amount: e.amount, orderId: e.orderId }))).toEqual([
      { key: `exp:${r.id}:v1`, recognizedOn: "2026-11-12", fxOn: "2026-11-12", late: false, amount: "-15.00", orderId },
    ]);
    // Дата комісії раніша за визнання (рідко) — max(дата, визнання) = дата визнання.
    const early = await createExpense(ctxAt(env, NOW), base({ category: "chargeback_fees", amount: "5.00", currency: "EUR", order: orderId, expenseDate: "2026-10-01" }));
    expect((await activeEntriesOf(db, early.id)).map((e) => [e.recognizedOn, e.fxOn])).toEqual([["2026-10-05", "2026-10-01"]]);
  });
});

describe("voiding any finance_expenses row (F2)", () => {
  it("voids the WP2 batch write-off (inventory_loss) with a reversal; the form cannot create or edit inventory_loss", async () => {
    const db = env.handle.db;
    const [batch] = await db.insert(productionBatches).values({ number: `PB-T-${op().slice(0, 8)}`, title: "Тестова партія", status: "cancelled", createdBy: "test" }).returning();
    const w = await writeOffBatchCosts(ctxAt(env, NOW), { operationId: op(), batchId: batch!.id, amount: "1200.00", currency: "UAH", date: "2026-11-15", reason: "Аванс виробнику за скасовану партію" });
    expect((await entriesOf(db, w.expenseId)).map((e) => e.amount)).toEqual(["-1200.00"]);
    expect(await codeOf(replaceExpense(ctxAt(env, NOW), { ...base({}), expenseId: w.expenseId, reason: "x" }))).toBe("financeExpenses.error.batchOnly");
    const v = await voidExpense(ctxAt(env, NOW), { expenseId: w.expenseId, reason: "Виробник повернув аванс" });
    expect(v).toEqual({ voided: true, reversed: 1 });
    const es = await entriesOf(db, w.expenseId);
    expect(es.map((e) => e.amount)).toEqual(["-1200.00", "1200.00"]);
    expect(es[1]).toMatchObject({ recognizedOn: "2026-11-15", fxOn: "2026-11-15", category: "inventory_loss" });
    expect(await activeEntriesOf(db, w.expenseId)).toHaveLength(0);
    expect(await voidExpense(ctxAt(env, NOW), { expenseId: w.expenseId, reason: "ще раз" })).toEqual({ voided: false, reversed: 0 });
  });
});

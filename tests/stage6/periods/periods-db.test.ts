/**
 * Етап 6, WP6: закриття місяця (§3.4, §2.7, §13.1; золотий G11 у частині закриття; I12).
 * - ■: замовлення місяця не final або запис без курсу для будь-якої валюти показу → закрити не можна; лише повністю
 *   минулий місяць.
 * - Закриття: остаточні знімки (is_final, source close) у КОЖНІЙ валюті показу через buildReportData +
 *   saveReportSnapshot; status closed; net_profit_eligible лише з усіма ☐ (податки — «внесено» або «немає»);
 *   «Чистий прибуток» — лише для цього місяця (profitLabelFor).
 * - Після закриття: ручна витрата, датована місяцем, — відмова; повернення Shopify з датою в закритому місяці →
 *   recognized_on = дата проведення, «Пізній запис», fx_on = справжня дата (I12).
 * - Валюта, додана до показу після закриття, — «Живий перерахунок, не знімок».
 * - Повторне відкриття — лише з причиною; повторне закриття — нова версія знімка.
 * - Підтвердження ☐ узгоджуються з записами; закритий місяць не змінюється; заглушка buildReportData (WP8) → 501.
 * - Працівник (і підроблений актор) — 403.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeEntries, financePeriods, financeReportSnapshots } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { postEntries } from "~/modules/finance/core/entries.server";
import { emptyReportData, fakeBuildReportData } from "~/modules/finance/core/fakes";
import { loadProfitLabel } from "~/modules/finance/core/profit-label.server";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { coverageWarnings, createExpense, voidExpense } from "~/modules/expenses/expenses.server";
import { closeMonth, confirmMonthItems, getMonthOverview, isPackagingAccountedInTotal, listFinanceMonths, reopenMonth } from "~/modules/finance/periods/periods.server";
import type { TestEnv } from "../../helpers";
import { STAFF } from "../../helpers";
import { ctxAt, insertOrder, op, openEnv, OWNER, rate } from "../expenses/helpers";

let env: TestEnv;
/** ☐ «за місяць немає» для всіх, крім податків (задаються в тесті). */
const NONE_EXCEPT_TAXES = {
  advertising: "none_this_month",
  payment_fees: "none_this_month",
  platform_fees: "none_this_month",
  salaries: "none_this_month",
  rent_services: "none_this_month",
  other_expenses: "none_this_month",
} as const;
/** Найбільший seq журналу на момент закриття жовтня (I12: пізніші записи не мають recognized_on у жовтні). */
let seqAtClose = 0;
const NOW = "2026-11-06T10:00:00Z";
const OCT = "2026-10-01";
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const build = fakeBuildReportData((input) => ({ ...emptyReportData(input), metrics: { turnover: input.reportingCurrency === "UAH" ? "6256.50" : null } }));

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    if (e instanceof ForbiddenError) return "forbidden";
    throw e;
  }
};

beforeAll(async () => {
  env = await openEnv();
  // Валюти показу: UAH (звітність) + EUR.
  await saveFinanceSettings(ctxAt(env, NOW), { displayCurrencies: ["UAH", "EUR"], reportingCurrency: "UAH" }, { reason: "test" });
});
afterAll(async () => {
  await env.close();
});

describe("checklist and close (G11)", () => {
  let orderId = "";

  it("empty month: nothing blocks; confirmations pending; current month cannot be closed", async () => {
    const o = await getMonthOverview(ctxAt(env, NOW), "2026-08-01");
    expect(o).toMatchObject({ status: "open", version: 0, fullyPast: true, netProfitEligible: false, snapshots: [], liveCurrencies: [] });
    expect(o.checklist.canClose).toBe(true);
    expect(o.checklist.items.find((i) => i.item === "orders_final")).toMatchObject({ status: "ok", count: 0 });
    expect(o.checklist.items.find((i) => i.item === "packaging_total_accounted")).toMatchObject({ status: "not_needed" });
    expect(o.checklist.pendingConfirmations).toBe(7);
    expect(await code(closeMonth(ctxAt(env, NOW), { month: "2026-11-01" }, { buildReportData: build }))).toBe("financeExpenses.error.monthNotPast");
    expect(await code(closeMonth(ctxAt(env, NOW), { month: "2026-11-15" }, { buildReportData: build }))).toBe("financeExpenses.error.monthInvalid");
  });

  it("■ blocks: a non-final order of the month and an entry without a rate for a display currency", async () => {
    const db = env.handle.db;
    orderId = await insertOrder(db, { placedOn: "2026-10-04", state: "recognized", recognizedOn: "2026-10-05", profitState: "preliminary", needsReview: true });
    await db.transaction((tx) =>
      postEntries(tx, { id: "test" }, [
        { idempotencyKey: `sale:g11-${orderId}:net`, category: "sales_product", recognizedOn: "2026-10-05", fxOn: "2026-10-05", amount: "129.00", currency: "EUR", orderId, sourceType: "demo", sourceId: "g11" },
      ]),
    );
    const o = await getMonthOverview(ctxAt(env, NOW), OCT);
    expect(o.checklist.items.find((i) => i.item === "orders_final")).toMatchObject({ status: "blocked", count: 1 });
    expect(o.checklist.items.find((i) => i.item === "rates_for_display_currencies")).toMatchObject({ status: "blocked", count: 2, details: { UAH: 1, EUR: 1, entries: 1 } });
    expect(o.checklist.items.find((i) => i.item === "orders_need_review")).toMatchObject({ status: "warning", count: 1 });
    expect(o.checklist.canClose).toBe(false);
    expect(await code(closeMonth(ctxAt(env, NOW), { month: OCT }, { buildReportData: build }))).toBe("financeExpenses.error.checklistBlocked");
    // Курс з'явився, замовлення остаточне → ■ виконано.
    await rate(db, "EUR", "2026-10-05", "48.5000");
    await db.execute(`update order_finance set profit_state = 'final', needs_review = false where order_id = '${orderId}'`);
    const after = await getMonthOverview(ctxAt(env, NOW), OCT);
    expect(after.checklist.blockingFailures).toBe(0);
    expect(after.checklist.canClose).toBe(true);
  });

  it("☐ confirmations agree with the month's entries; taxes «entered» or «none»", async () => {
    const ctx = ctxAt(env, NOW);
    expect(await code(confirmMonthItems(ctx, { month: OCT, values: { advertising: "entered" } }))).toBe("financeExpenses.error.confirmEnteredWithoutEntries");
    await createExpense(ctx, { operationId: op(), category: "advertising", amount: "100,00", currency: "EUR", dateMode: "single", expenseDate: "2026-10-20", channel: "meta" });
    await rate(env.handle.db, "EUR", "2026-10-20", "48.5000");
    // Податок у гривнях 31.10 потребує курсу EUR на 31.10 (валюта показу EUR; запасний курс — до 7 днів).
    await rate(env.handle.db, "EUR", "2026-10-31", "48.5000");
    await createExpense(ctx, { operationId: op(), category: "taxes_company", amount: "1 500", currency: "UAH", dateMode: "single", expenseDate: "2026-10-31", description: "Єдиний податок" });
    expect(await code(confirmMonthItems(ctx, { month: OCT, values: { taxes_company: "none_this_month" } }))).toBe("financeExpenses.error.confirmNoneWithEntries");
    expect(await code(confirmMonthItems(ctx, { month: OCT, values: { taxes_company: "not_needed" } }))).toBe("financeExpenses.error.confirmValueInvalid");
    const r = await confirmMonthItems(ctx, {
      month: OCT,
      values: {
        advertising: "entered",
        payment_fees: "none_this_month",
        platform_fees: "none_this_month",
        salaries: "none_this_month",
        rent_services: "none_this_month",
        taxes_company: "entered",
        other_expenses: "none_this_month",
      },
      expectedVersion: 0,
      reason: "Перевірено виписки",
    });
    expect(r).toMatchObject({ version: 1, resynced: 0 });
    expect(r.changed).toHaveLength(7);
    const o = await getMonthOverview(ctx, OCT);
    expect(o.checklist.allConfirmed).toBe(true);
    expect(o.history.map((h) => h.action)).toEqual(["confirm"]);
    expect(await code(confirmMonthItems(ctx, { month: OCT, values: { salaries: "none_this_month" }, expectedVersion: 0 }))).toBe("error.conflict");
  });

  it("close → final snapshots in every display currency, closed, eligible; «Чистий прибуток» only for October", async () => {
    const db = env.handle.db;
    const closed = await closeMonth(ctxAt(env, NOW), { month: OCT, expectedVersion: 1 }, { buildReportData: build });
    expect(closed).toMatchObject({ month: OCT, version: 2, netProfitEligible: true });
    seqAtClose = Math.max(0, ...(await db.select({ seq: financeEntries.seq }).from(financeEntries)).map((e) => e.seq));
    expect(closed.snapshots.map((s) => [s.currency, s.version])).toEqual([
      ["UAH", 1],
      ["EUR", 1],
    ]);
    const snaps = await db.select().from(financeReportSnapshots).where(eq(financeReportSnapshots.periodFrom, OCT));
    expect(snaps).toHaveLength(2);
    for (const s of snaps) {
      expect(s).toMatchObject({ kind: "month", periodTo: "2026-10-31", source: "close", isFinal: true, generatedBy: OWNER.id });
      expect(s.data).toMatchObject({ profitLabel: "net_profit", completeness: { netProfitEligible: true, closedMonths: [OCT] } });
    }
    const [period] = await db.select().from(financePeriods).where(eq(financePeriods.month, OCT));
    expect(period).toMatchObject({ status: "closed", netProfitEligible: true, closedBy: OWNER.id, snapshotId: closed.snapshots[0]!.id });
    expect((period!.checklist as { closing: Record<string, unknown> }).closing).toMatchObject({ orders_final: 0, rates_for_display_currencies: 0, taxes_company: "entered" });
    expect(await loadProfitLabel(db, { from: OCT, to: "2026-10-31" })).toBe("net_profit");
    expect(await loadProfitLabel(db, { from: OCT, to: "2026-11-05" })).toBe("profit_after_recorded_costs");
    const log = await db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "period"), eq(financeChangeLog.action, "close")));
    expect(log[0]!.after).toMatchObject({ status: "closed", netProfitEligible: true, snapshots: 2 });
    expect(await code(closeMonth(ctxAt(env, NOW), { month: OCT }, { buildReportData: build }))).toBe("financeExpenses.error.alreadyClosed");
  });

  it("after closing: manual entry dated October refused; a Shopify refund dated 31.10 is posted late on 06.11 with fx_on 31.10 (I12)", async () => {
    const db = env.handle.db;
    const ctx = ctxAt(env, NOW);
    expect(await code(createExpense(ctx, { operationId: op(), category: "advertising", amount: "50", currency: "UAH", dateMode: "single", expenseDate: "2026-10-20" }))).toBe("finance.error.monthClosed");
    expect(await code(confirmMonthItems(ctx, { month: OCT, values: { salaries: "" } }))).toBe("finance.error.monthClosed");
    const r = await db.transaction((tx) =>
      postEntries(
        tx,
        { id: "system" },
        [{ idempotencyKey: `sale:g11-refund-${orderId}:net`, category: "refund_product", recognizedOn: "2026-10-31", fxOn: "2026-10-31", amount: "-45.00", currency: "EUR", orderId, sourceType: "demo", sourceId: "g11" }],
        { now: new Date(NOW) },
      ),
    );
    expect(r.late).toBe(1);
    const [late] = await db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, `sale:g11-refund-${orderId}:net`));
    expect(late).toMatchObject({ recognizedOn: "2026-11-06", originalOn: "2026-10-31", fxOn: "2026-10-31", isLate: true });
    // I12: жоден запис, проведений після закриття, не має recognized_on у жовтні.
    const all = await db.select().from(financeEntries).where(and(eq(financeEntries.storeId, "default")));
    expect(all.filter((e) => e.seq > seqAtClose && e.recognizedOn >= OCT && e.recognizedOn <= "2026-10-31")).toHaveLength(0);
    expect(all.filter((e) => e.seq > seqAtClose).length).toBeGreaterThan(0);
  });

  it("a currency added to the display list after closing → «live recalculation, not a snapshot»", async () => {
    await saveFinanceSettings(ctxAt(env, NOW), { displayCurrencies: ["UAH", "EUR", "USD"] }, { reason: "USD" });
    const o = await getMonthOverview(ctxAt(env, NOW), OCT);
    expect(o).toMatchObject({ status: "closed", liveCurrencies: ["USD"] });
    expect(o.snapshots.map((s) => s.reportingCurrency).sort()).toEqual(["EUR", "UAH"]);
  });

  it("reopen requires a reason; the old snapshot stays; closing again writes version 2 of each snapshot", async () => {
    const db = env.handle.db;
    const ctx = ctxAt(env, NOW);
    expect(await code(reopenMonth(ctx, { month: OCT, reason: "  " }))).toBe("financeExpenses.error.reasonRequired");
    expect(await code(reopenMonth(ctx, { month: "2026-08-01", reason: "x" }))).toBe("financeExpenses.error.notClosed");
    const re = await reopenMonth(ctx, { month: OCT, reason: "Знайдено рахунок за рекламу", expectedVersion: 2 });
    expect(re.version).toBe(3);
    const [p] = await db.select().from(financePeriods).where(eq(financePeriods.month, OCT));
    expect(p).toMatchObject({ status: "open", netProfitEligible: false, reopenReason: "Знайдено рахунок за рекламу", reopenedBy: OWNER.id });
    expect(await loadProfitLabel(db, { from: OCT, to: "2026-10-31" })).toBe("profit_after_recorded_costs");
    // Тепер можна внести витрату жовтня.
    await createExpense(ctx, { operationId: op(), category: "advertising", amount: "50", currency: "UAH", dateMode: "single", expenseDate: "2026-10-21" });
    await rate(db, "USD", "2026-10-05", "41.0000");
    await rate(db, "USD", "2026-10-20", "41.0000");
    await rate(db, "USD", "2026-10-31", "41.0000");
    const again = await closeMonth(ctx, { month: OCT }, { buildReportData: build });
    expect(again.snapshots.map((s) => [s.currency, s.version])).toEqual([
      ["UAH", 2],
      ["EUR", 2],
      ["USD", 1],
    ]);
    const all = await db.select().from(financeReportSnapshots).where(eq(financeReportSnapshots.periodFrom, OCT));
    expect(all).toHaveLength(5);
    const months = await listFinanceMonths(ctx);
    expect(months.find((m) => m.month === OCT)).toMatchObject({ status: "closed", netProfitEligible: true, finalSnapshots: 5 });
    expect(months[0]!.month).toBe("2026-11-01");
  });

  it("closing with the WP8 stub buildReportData is refused (501) and changes nothing", async () => {
    const before = await env.handle.db.select().from(financePeriods).where(eq(financePeriods.month, "2026-09-01"));
    expect(await code(closeMonth(ctxAt(env, NOW), { month: "2026-09-01" }))).toBe("finance.error.notImplemented");
    expect(await env.handle.db.select().from(financePeriods).where(eq(financePeriods.month, "2026-09-01"))).toEqual(before);
    expect(await env.handle.db.select().from(financeReportSnapshots).where(eq(financeReportSnapshots.periodFrom, "2026-09-01"))).toHaveLength(0);
  });

  it("packaging total confirmation is offered only with a packaging total; resyncs the month's orders", async () => {
    const ctx = ctxAt(env, NOW);
    const SEP = "2026-09-01";
    expect(await code(confirmMonthItems(ctx, { month: SEP, values: { packaging_total_accounted: "entered" } }))).toBe("financeExpenses.error.confirmEnteredWithoutEntries");
    await insertOrder(env.handle.db, { placedOn: "2026-09-10", state: "recognized", recognizedOn: "2026-09-11", forecasts: [{ component: "packaging", amount: "20.00", currency: "UAH" }] });
    await createExpense(ctx, { operationId: op(), category: "packaging", amount: "400", currency: "UAH", dateMode: "single", expenseDate: "2026-09-30", coverage: "separate", separateReason: "Пакети для історичних замовлень" });
    const before = await getMonthOverview(ctx, SEP);
    expect(before.checklist.packagingNeeded).toBe(true);
    expect(before.checklist.items.find((i) => i.item === "packaging_forecast_with_total")).toMatchObject({ status: "warning", count: 1 });
    expect(await isPackagingAccountedInTotal(env.handle.db, SEP)).toBe(false);
    // Те саме попередження — на сторінці витрат (§10.3).
    expect((await coverageWarnings(ctx, SEP)).packaging).toEqual({ month: SEP, totals: 1, ordersWithForecast: 1 });
    const r = await confirmMonthItems(ctx, { month: SEP, values: { packaging_total_accounted: "entered" }, reason: "Упаковку історичних замовлень обліковано загальною сумою" });
    expect(r.resynced).toBe(1);
    expect(await isPackagingAccountedInTotal(env.handle.db, "2026-09-15")).toBe(true);
    expect((await coverageWarnings(ctx, SEP)).packaging).toBeNull();
    const after = await getMonthOverview(ctx, SEP);
    expect(after.checklist.items.find((i) => i.item === "packaging_forecast_with_total")).toMatchObject({ status: "ok" });
  });

  it("a confirmation that no longer matches the ledger is «stale» at close: «entered» taxes voided → no «Net profit» (§2.7)", async () => {
    const ctx = ctxAt(env, NOW);
    const MAY = "2026-05-01";
    // Валюти показу на цей момент — UAH, EUR і USD (додана попереднім тестом).
    for (const c of ["EUR", "USD"]) await rate(env.handle.db, c, "2026-05-15", "45.0000");
    const tax = await createExpense(ctx, { operationId: op(), category: "taxes_company", amount: "100,00", currency: "UAH", dateMode: "single", expenseDate: "2026-05-15" });
    await confirmMonthItems(ctx, { month: MAY, values: { ...NONE_EXCEPT_TAXES, taxes_company: "entered" } });
    expect((await getMonthOverview(ctx, MAY)).checklist).toMatchObject({ allConfirmed: true, staleConfirmations: 0 });
    await voidExpense(ctx, { expenseId: tax.id, reason: "Помилка в даті" });
    const o = await getMonthOverview(ctx, MAY);
    expect(o.checklist).toMatchObject({ allConfirmed: false, staleConfirmations: 1, canClose: true });
    expect(o.checklist.items.find((i) => i.item === "taxes_company")).toMatchObject({ status: "stale", value: "entered", count: 0 });
    const closed = await closeMonth(ctx, { month: MAY }, { buildReportData: build });
    expect(closed.netProfitEligible).toBe(false);
    const [snap] = await env.handle.db.select().from(financeReportSnapshots).where(and(eq(financeReportSnapshots.periodFrom, MAY), eq(financeReportSnapshots.reportingCurrency, "UAH")));
    expect(snap!.data).toMatchObject({ profitLabel: "profit_after_recorded_costs", completeness: { netProfitEligible: false } });
    const [period] = await env.handle.db.select().from(financePeriods).where(eq(financePeriods.month, MAY));
    expect((period!.checklist as { closing: Record<string, unknown> }).closing).toMatchObject({ taxes_company: "stale" });
    expect(await loadProfitLabel(env.handle.db, { from: MAY, to: "2026-05-31" })).toBe("profit_after_recorded_costs");
  });

  it("«none this month» and an expense added later → stale → closed without «Net profit»", async () => {
    const ctx = ctxAt(env, NOW);
    const APR = "2026-04-01";
    for (const c of ["EUR", "USD"]) for (const d of ["2026-04-15", "2026-04-30"]) await rate(env.handle.db, c, d, "44.0000");
    await createExpense(ctx, { operationId: op(), category: "taxes_company", amount: "1 500", currency: "UAH", dateMode: "single", expenseDate: "2026-04-15" });
    await confirmMonthItems(ctx, { month: APR, values: { ...NONE_EXCEPT_TAXES, taxes_company: "entered" } });
    await createExpense(ctx, { operationId: op(), category: "salaries", amount: "9 000", currency: "UAH", dateMode: "single", expenseDate: "2026-04-30" });
    const o = await getMonthOverview(ctx, APR);
    expect(o.checklist.items.find((i) => i.item === "salaries")).toMatchObject({ status: "stale", value: "none_this_month", count: 1, staleReason: "financeExpenses.error.confirmNoneWithEntries" });
    expect((await closeMonth(ctx, { month: APR }, { buildReportData: build })).netProfitEligible).toBe(false);
  });

  it("«entered» counts period sums dated in the month even when their shares are recognized in the next month", async () => {
    const ctx = ctxAt(env, NOW);
    const MAR = "2026-03-01";
    await insertOrder(env.handle.db, { placedOn: "2026-03-28", gateway: "pp-mar", state: "recognized", recognizedOn: "2026-04-02", forecasts: [{ component: "fees", amount: "3.00" }] });
    const e = await createExpense(ctx, { operationId: op(), category: "payment_fees", amount: "3,00", currency: "EUR", dateMode: "single", expenseDate: "2026-03-31", gateway: "pp-mar" });
    const es = await env.handle.db.select().from(financeEntries).where(eq(financeEntries.sourceId, e.id));
    // Частка — датою визнання замовлення (квітень; квітень уже закрито попереднім тестом → пізній запис): у березні записів немає.
    expect(es.map((x) => x.originalOn)).toEqual(["2026-04-02"]);
    expect(es.every((x) => x.recognizedOn >= "2026-04-01")).toBe(true);
    expect(await code(confirmMonthItems(ctx, { month: MAR, values: { payment_fees: "none_this_month" } }))).toBe("financeExpenses.error.confirmNoneWithEntries");
    expect(await confirmMonthItems(ctx, { month: MAR, values: { payment_fees: "entered" } })).toMatchObject({ changed: ["payment_fees"] });
    const item = (await getMonthOverview(ctx, MAR)).checklist.items.find((i) => i.item === "payment_fees");
    expect(item).toMatchObject({ status: "confirmed", count: 0, details: { expenses: 1 } });
  });

  it("voiding the month's only packaging total makes «accounted in the total» stale and WP4's predicate false", async () => {
    const ctx = ctxAt(env, NOW);
    const JUL = "2026-07-01";
    await insertOrder(env.handle.db, { placedOn: "2026-07-10", state: "recognized", recognizedOn: "2026-07-11", forecasts: [{ component: "packaging", amount: "20.00", currency: "UAH" }] });
    const pkg = await createExpense(ctx, { operationId: op(), category: "packaging", amount: "400", currency: "UAH", dateMode: "single", expenseDate: "2026-07-30", coverage: "separate", separateReason: "Пакети" });
    await confirmMonthItems(ctx, { month: JUL, values: { packaging_total_accounted: "entered" } });
    expect(await isPackagingAccountedInTotal(env.handle.db, JUL)).toBe(true);
    await voidExpense(ctx, { expenseId: pkg.id, reason: "Помилка" });
    expect(await isPackagingAccountedInTotal(env.handle.db, JUL)).toBe(false);
    expect((await getMonthOverview(ctx, JUL)).checklist.items.find((i) => i.item === "packaging_total_accounted")).toMatchObject({ status: "stale" });
  });

  it("staff and a forged staff actor get 403 on every period service", async () => {
    for (const actor of [STAFF, FORGED]) {
      const ctx = ctxAt(env, NOW, actor);
      expect(await code(getMonthOverview(ctx, OCT))).toBe("forbidden");
      expect(await code(listFinanceMonths(ctx))).toBe("forbidden");
      expect(await code(confirmMonthItems(ctx, { month: "2026-08-01", values: {} }))).toBe("forbidden");
      expect(await code(closeMonth(ctx, { month: "2026-08-01" }, { buildReportData: build }))).toBe("forbidden");
      expect(await code(reopenMonth(ctx, { month: OCT, reason: "x" }))).toBe("forbidden");
    }
  });
});

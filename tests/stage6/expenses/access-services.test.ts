/**
 * Етап 6, WP6: §14.1 / §14.2 / §20.4 — requireFinance у КОЖНІЙ функції сервісів витрат, правил комісій і місяців (не
 * лише в loader): працівник і підроблений актор (роль staff з наданими finance.view / finance.manage) → ForbiddenError,
 * навіть із справжнім id (перевірка — до будь-якого пошуку й запису). Таблиця охоплює кожен експорт-сервіс модулів:
 * новий сервіс без рядка тут — тест падає (внутрішні функції — у явному переліку INTERNAL).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeExpenses, financeFeeRules, financePeriods } from "~/db/schema";
import { ForbiddenError, makeActor, type Actor } from "~/domain/permissions";
import * as expenses from "~/modules/expenses/expenses.server";
import * as feeRules from "~/modules/expenses/fee-rules.server";
import { emptyReportData, fakeBuildReportData } from "~/modules/finance/core/fakes";
import * as periods from "~/modules/finance/periods/periods.server";
import type { TestEnv } from "../../helpers";
import { STAFF } from "../../helpers";
import { closeMonthRow, ctxAt, insertOrder, op, openEnv } from "./helpers";

const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const NOW = "2026-11-28T10:00:00Z";
const build = fakeBuildReportData((input) => emptyReportData(input));

/** Внутрішні функції (без актора; сторінки їх не викликають) — поза таблицею. */
const INTERNAL = new Set([
  "resolveOrderRef",
  "loadFeeRules",
  "storedChecklist",
  "loadPeriodRow",
  "isPackagingAccountedInTotal",
  "confirmItemEntries",
  "confirmItemExpenses",
  "displayCurrenciesOf",
  "computeChecklistFacts",
]);

let env: TestEnv;
let expenseId = "";
let coveringId = "";
let ruleId = "";
let orderNumber = "";

beforeAll(async () => {
  env = await openEnv();
  const owner = ctxAt(env, NOW);
  const orderId = await insertOrder(env.handle.db, { placedOn: "2026-11-03", gateway: "paypal", state: "recognized", forecasts: [{ component: "fees", amount: "1.00" }] });
  const [o] = await env.handle.db.query.orders.findMany({ where: (t, { eq: e }) => e(t.id, orderId) });
  orderNumber = o!.orderNumber;
  expenseId = (await expenses.createExpense(owner, { operationId: op(), category: "rent", amount: "1000", currency: "UAH", dateMode: "single", expenseDate: "2026-11-05" })).id;
  coveringId = (await expenses.createExpense(owner, { operationId: op(), category: "payment_fees", amount: "2,00", currency: "EUR", dateMode: "single", expenseDate: "2026-11-30", gateway: "paypal" })).id;
  ruleId = (await feeRules.saveFeeRule(owner, { gateway: "paypal", kind: "payment", percent: "3,49", noFees: false, appliesFrom: "2026-11-01" })).id;
  await closeMonthRow(env.handle.db, "2026-09-01");
});
afterAll(async () => {
  await env.close();
});

type Call = (actor: Actor) => Promise<unknown>;

/** Кожен сервіс → виклик зі справжніми id і коректними даними (для власника кожен виклик мав би пройти перевірку доступу). */
function calls(): Record<string, Call> {
  const c = (actor: Actor) => ctxAt(env, NOW, actor);
  return {
    // expenses.server
    createExpense: (a) => expenses.createExpense(c(a), { operationId: op(), category: "rent", amount: "1", currency: "UAH", dateMode: "single", expenseDate: "2026-11-06" }),
    replaceExpense: (a) =>
      expenses.replaceExpense(c(a), { operationId: op(), category: "rent", amount: "2", currency: "UAH", dateMode: "single", expenseDate: "2026-11-06", expenseId, reason: "x" }),
    voidExpense: (a) => expenses.voidExpense(c(a), { expenseId, reason: "x" }),
    recalculateAllocation: (a) => expenses.recalculateAllocation(c(a), { expenseId: coveringId }),
    listExpenses: (a) => expenses.listExpenses(c(a), {}),
    getExpense: (a) => expenses.getExpense(c(a), expenseId),
    orderForExpenseForm: (a) => expenses.orderForExpenseForm(c(a), orderNumber),
    partnerOptions: (a) => expenses.partnerOptions(c(a)),
    coverageWarnings: (a) => expenses.coverageWarnings(c(a), "2026-11-01"),
    carrierCodeOptions: (a) => expenses.carrierCodeOptions(c(a)),
    // fee-rules.server
    saveFeeRule: (a) => feeRules.saveFeeRule(c(a), { gateway: "stripe", kind: "payment", percent: "1", noFees: false, appliesFrom: "2026-11-02" }),
    endFeeRule: (a) => feeRules.endFeeRule(c(a), { ruleId, appliesTo: "2026-11-30" }),
    listFeeRules: (a) => feeRules.listFeeRules(c(a)),
    listSeenGateways: (a) => feeRules.listSeenGateways(c(a)),
    feeForecastVsActual: (a) => feeRules.feeForecastVsActual(c(a), {}),
    // periods.server
    getMonthOverview: (a) => periods.getMonthOverview(c(a), "2026-10-01"),
    listFinanceMonths: (a) => periods.listFinanceMonths(c(a), {}),
    confirmMonthItems: (a) => periods.confirmMonthItems(c(a), { month: "2026-10-01", values: { salaries: "none_this_month" } }),
    closeMonth: (a) => periods.closeMonth(c(a), { month: "2026-10-01" }, { buildReportData: build }),
    reopenMonth: (a) => periods.reopenMonth(c(a), { month: "2026-09-01", reason: "x" }),
  };
}

const serviceNames = (mod: Record<string, unknown>) =>
  Object.entries(mod)
    .filter(([name, v]) => typeof v === "function" && !INTERNAL.has(name))
    .map(([name]) => name);

describe("requireFinance in every expense / fee-rule / period service (§14.1, §14.2, §20.4)", () => {
  it("the table covers every exported service of the three modules", () => {
    const names = [...serviceNames(expenses), ...serviceNames(feeRules), ...serviceNames(periods)].sort();
    expect(Object.keys(calls()).sort()).toEqual(names);
  });

  it.each([
    ["staff", STAFF],
    ["forged staff with finance permissions", FORGED],
  ] as const)("%s → ForbiddenError from each service, before any lookup or write", async (_label, actor) => {
    const before = {
      expenses: await env.handle.db.select().from(financeExpenses),
      rules: await env.handle.db.select().from(financeFeeRules),
      periods: await env.handle.db.select().from(financePeriods),
    };
    for (const [name, call] of Object.entries(calls())) {
      const outcome = await call(actor).then(
        () => "ok",
        (e: unknown) => (e instanceof ForbiddenError ? "forbidden" : `other: ${String((e as Error)?.message ?? e)}`),
      );
      expect(outcome, name).toBe("forbidden");
    }
    // Нічого не змінено.
    expect(await env.handle.db.select().from(financeExpenses)).toEqual(before.expenses);
    expect(await env.handle.db.select().from(financeFeeRules)).toEqual(before.rules);
    expect(await env.handle.db.select().from(financePeriods)).toEqual(before.periods);
    const [row] = await env.handle.db.select().from(financeExpenses).where(eq(financeExpenses.id, expenseId));
    expect(row).toMatchObject({ status: "active", version: 1 });
  });
});

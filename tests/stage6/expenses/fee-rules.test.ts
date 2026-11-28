/**
 * Етап 6, WP6: правила комісій шлюзів (§8.1, §4 «Комісії»). Чисті: розбір відсотка, прогноз (відсоток від бази +
 * фіксована частина в її валюті, цілі одиниці для валют з 0 знаками; «Без комісії» → zero_confirmed; немає правила →
 * «немає даних», не 0). На БД: рядки незмінні — нове правило закриває чинне днем раніше; повтор того самого — без
 * змін; дата не пізніша за останнє правило / у закритому місяці — відмова; «Завершити»; історія змін; прогноз vs факт
 * за шлюзом (порожня база — порожньо, суми — null, не 0); працівник — 403.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeFeeRules } from "~/db/schema";
import { ForbiddenError } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { postEntries } from "~/modules/finance/core/entries.server";
import { bpToPercent, feeForecast, feeRuleShapeError, parsePercentToBp, type FeeRuleLike } from "~/modules/expenses/fee-rules";
import { createExpense, voidExpense } from "~/modules/expenses/expenses.server";
import { endFeeRule, feeForecastVsActual, listFeeRules, listSeenGateways, loadFeeRules, saveFeeRule } from "~/modules/expenses/fee-rules.server";
import type { TestEnv } from "../../helpers";
import { STAFF } from "../../helpers";
import { activeEntriesOf, closeMonthRow, ctxAt, entriesOf, insertOrder, op, openEnv } from "./helpers";

const rule = (over: Partial<FeeRuleLike>): FeeRuleLike => ({
  id: "r1",
  gateway: "paypal",
  kind: "payment",
  percentBp: 349,
  fixedAmount: "0.35",
  fixedCurrency: "EUR",
  noFees: false,
  appliesFrom: "2026-01-01",
  appliesTo: null,
  ...over,
});

describe("pure fee rules", () => {
  it("parses percents into basis points", () => {
    expect(parsePercentToBp("3,49")).toBe(349);
    expect(parsePercentToBp("3.4 %")).toBe(340);
    expect(parsePercentToBp("")).toBe(0);
    expect(parsePercentToBp("100")).toBe(10000);
    expect(parsePercentToBp("100,01")).toBeNull();
    expect(parsePercentToBp("1,234")).toBeNull();
    expect(parsePercentToBp("-1")).toBeNull();
    expect(bpToPercent(349)).toBe("3.49");
    expect(bpToPercent(5)).toBe("0.05");
  });

  it("forecast = round(base × bp) + fixed, per kind and currency; no rule → none (not 0); no_fees → zero_confirmed", () => {
    const rules = [rule({}), rule({ id: "r2", kind: "platform", percentBp: 200, fixedAmount: null, fixedCurrency: null })];
    expect(feeForecast(rules, { gateway: "paypal", date: "2026-11-05", base: { amount: "129.00", currency: "EUR" } })).toEqual({
      state: "forecast",
      ruleIds: ["r1", "r2"],
      lines: [
        { kind: "payment", ruleId: "r1", amount: "4.85", currency: "EUR" },
        { kind: "platform", ruleId: "r2", amount: "2.58", currency: "EUR" },
      ],
    });
    // Фіксована частина в іншій валюті — окремим рядком.
    expect(feeForecast([rule({ fixedCurrency: "USD", fixedAmount: "0.30" })], { gateway: "paypal", date: "2026-11-05", base: { amount: "100.00", currency: "EUR" } })).toMatchObject({
      lines: [
        { amount: "3.49", currency: "EUR" },
        { amount: "0.30", currency: "USD" },
      ],
    });
    // Валюта з 0 знаками — цілі одиниці.
    expect(feeForecast([rule({ fixedAmount: null, fixedCurrency: null })], { gateway: "paypal", date: "2026-11-05", base: { amount: "1050.00", currency: "JPY" } })).toMatchObject({
      lines: [{ amount: "37.00", currency: "JPY" }],
    });
    expect(feeForecast(rules, { gateway: "stripe", date: "2026-11-05", base: { amount: "10.00", currency: "EUR" } })).toEqual({ state: "none" });
    expect(feeForecast(rules, { gateway: "paypal", date: "2025-12-31", base: { amount: "10.00", currency: "EUR" } })).toEqual({ state: "none" });
    expect(feeForecast([rule({ noFees: true, percentBp: 0, fixedAmount: null, fixedCurrency: null })], { gateway: "paypal", date: "2026-11-05", base: null })).toEqual({ state: "zero_confirmed", ruleIds: ["r1"] });
    // Відсоток без бази — невідомо (не 0).
    expect(feeForecast([rule({})], { gateway: "paypal", date: "2026-11-05", base: null })).toEqual({ state: "none" });
    // Пізніше правило того самого виду перекриває раніше.
    const later = [rule({ appliesTo: "2026-10-31" }), rule({ id: "r3", percentBp: 300, fixedAmount: null, fixedCurrency: null, appliesFrom: "2026-11-01" })];
    expect(feeForecast(later, { gateway: "paypal", date: "2026-11-02", base: { amount: "100.00", currency: "EUR" } })).toMatchObject({ lines: [{ ruleId: "r3", amount: "3.00" }] });
    expect(feeForecast(later, { gateway: "paypal", date: "2026-10-31", base: { amount: "100.00", currency: "EUR" } })).toMatchObject({ lines: [{ ruleId: "r1", amount: "3.84" }] });
  });

  it("rule shape: 0 % without a fixed part must be «no fees»; «no fees» cannot carry amounts", () => {
    expect(feeRuleShapeError({ gateway: "paypal", kind: "payment", percentBp: 0, fixedMinor: null, fixedCurrency: null, noFees: false })).toBe("financeExpenses.error.feeRuleEmpty");
    expect(feeRuleShapeError({ gateway: "paypal", kind: "payment", percentBp: 100, fixedMinor: null, fixedCurrency: null, noFees: true })).toBe("financeExpenses.error.noFeesWithAmounts");
    expect(feeRuleShapeError({ gateway: null, kind: "payment", percentBp: 100, fixedMinor: null, fixedCurrency: null, noFees: false })).toBe("financeExpenses.error.gatewayRequired");
    expect(feeRuleShapeError({ gateway: "paypal", kind: "other", percentBp: 100, fixedMinor: null, fixedCurrency: null, noFees: false })).toBe("financeExpenses.error.feeKindInvalid");
    expect(feeRuleShapeError({ gateway: "paypal", kind: "platform", percentBp: 200, fixedMinor: null, fixedCurrency: null, noFees: false })).toBeNull();
  });
});

describe("fee rule services", () => {
  let env: TestEnv;
  const NOW = "2026-11-28T10:00:00Z";
  beforeAll(async () => {
    env = await openEnv();
  });
  afterAll(async () => {
    await env.close();
  });
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

  it("empty database: no rules, no gateways, no comparison rows (no data, not zeros)", async () => {
    const ctx = ctxAt(env, NOW);
    expect(await listFeeRules(ctx)).toEqual([]);
    expect(await listSeenGateways(ctx)).toEqual([]);
    const cmp = await feeForecastVsActual(ctx);
    expect(cmp.rows).toEqual([]);
    expect(cmp.months).toEqual(["2026-09-01", "2026-10-01", "2026-11-01"]);
  });

  it("a new rule closes the current one the day before; identical repeat is a no-op; earlier date refused", async () => {
    const ctx = ctxAt(env, NOW);
    const first = await saveFeeRule(ctx, { gateway: "paypal", kind: "payment", percent: "3,49", fixedAmount: "0,35", fixedCurrency: "EUR", noFees: false, appliesFrom: "2026-10-01", reason: "Тариф PayPal" });
    expect(first).toMatchObject({ duplicate: false, closedRuleId: null });
    const repeat = await saveFeeRule(ctx, { gateway: "paypal", kind: "payment", percent: "3.49", fixedAmount: "0.35", fixedCurrency: "eur", noFees: false, appliesFrom: "2026-10-01" });
    expect(repeat).toMatchObject({ id: first.id, duplicate: true });
    const second = await saveFeeRule(ctx, { gateway: "paypal", kind: "payment", percent: "2,99", fixedAmount: "", noFees: false, appliesFrom: "2026-11-15", reason: "Новий тариф" });
    expect(second.closedRuleId).toBe(first.id);
    const rows = await env.handle.db.select().from(financeFeeRules).where(eq(financeFeeRules.gateway, "paypal"));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(first.id)).toMatchObject({ appliesFrom: "2026-10-01", appliesTo: "2026-11-14", percentBp: 349, fixedAmount: "0.35", fixedCurrency: "EUR" });
    expect(byId.get(second.id)).toMatchObject({ appliesFrom: "2026-11-15", appliesTo: null, percentBp: 299, fixedAmount: null });
    expect(await code(saveFeeRule(ctx, { gateway: "paypal", kind: "payment", percent: "1", noFees: false, appliesFrom: "2026-11-15" }))).toBe("financeExpenses.error.feeRuleNotAfterLatest");
    // Інший вид того самого шлюзу — незалежний.
    const platform = await saveFeeRule(ctx, { gateway: "paypal", kind: "platform", percent: "2", noFees: false, appliesFrom: "2026-10-01" });
    expect(platform.closedRuleId).toBeNull();
    const logs = await env.handle.db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, first.id));
    expect(logs.map((l) => l.action).sort()).toEqual(["create", "update"]);
    expect(logs.find((l) => l.action === "update")!.after).toMatchObject({ appliesTo: "2026-11-14" });
    const loaded = await loadFeeRules(env.handle.db, { gateways: ["paypal"] });
    expect(feeForecast(loaded, { gateway: "paypal", date: "2026-11-20", base: { amount: "100.00", currency: "EUR" } })).toMatchObject({
      state: "forecast",
      lines: [
        { kind: "payment", amount: "2.99" },
        { kind: "platform", amount: "2.00" },
      ],
    });
    const listed = await listFeeRules(ctx);
    expect(listed.find((r) => r.id === second.id)).toMatchObject({ current: true, percent: "2.99" });
    expect(listed.find((r) => r.id === first.id)).toMatchObject({ current: false });
  });

  it("«no fees» rule, end a rule, closed-month and staff refusals", async () => {
    const ctx = ctxAt(env, NOW);
    const nf = await saveFeeRule(ctx, { gateway: "Bank transfer", kind: "payment", percent: "", noFees: true, appliesFrom: "2026-11-01" });
    expect((await env.handle.db.select().from(financeFeeRules).where(eq(financeFeeRules.id, nf.id)))[0]).toMatchObject({ noFees: true, percentBp: 0 });
    expect(await endFeeRule(ctx, { ruleId: nf.id, appliesTo: "2026-11-30", reason: "Більше не приймаємо" })).toMatchObject({ ended: true });
    expect(await endFeeRule(ctx, { ruleId: nf.id, appliesTo: "2026-12-31" })).toMatchObject({ ended: false });
    expect(await code(endFeeRule(ctx, { ruleId: nf.id, appliesTo: "2026-10-01" }))).toBe("financeExpenses.error.feeRuleEndBeforeStart");
    await closeMonthRow(env.handle.db, "2026-09-01");
    expect(await code(saveFeeRule(ctx, { gateway: "stripe", kind: "payment", percent: "1,5", noFees: false, appliesFrom: "2026-09-10" }))).toBe("finance.error.monthClosed");
    expect(await code(saveFeeRule(ctxAt(env, NOW, STAFF), { gateway: "stripe", kind: "payment", percent: "1,5", noFees: false, appliesFrom: "2026-11-10" }))).toBe("forbidden");
    expect(await code(listFeeRules(ctxAt(env, NOW, STAFF)))).toBe("forbidden");
    expect(await code(feeForecastVsActual(ctxAt(env, NOW, STAFF)))).toBe("forbidden");
  });

  it("forecast vs actual compares the gateway rule's forecast with the actual fees of the SAME orders (§8.1, reporting currency, facts are positive costs)", async () => {
    const db = env.handle.db;
    const ctx = ctxAt(env, NOW);
    await saveFeeRule(ctx, { gateway: "liqpay", kind: "payment", percent: "3", noFees: false, appliesFrom: "2026-10-01" });
    // Прогноз правила: 3 % від суми замовлення (демо: без угод — від суми замовлення) на дату оплати.
    const o1 = await insertOrder(db, { placedOn: "2026-11-05", currency: "UAH", total: "1000.00", gateway: "liqpay", state: "recognized" });
    // Без факту комісії — не порівнюється (його прогноз не стоїть поряд із фактом іншого замовлення).
    await insertOrder(db, { placedOn: "2026-11-06", currency: "UAH", total: "500.00", gateway: "liqpay", forecasts: [{ component: "fees", amount: "15.00" }] });
    await db.transaction((tx) =>
      postEntries(tx, { id: "test" }, [
        { idempotencyKey: `fee:cmp-${o1}`, category: "payment_fees", recognizedOn: "2026-11-05", fxOn: "2026-11-05", amount: "-28.50", currency: "UAH", orderId: o1, sourceType: "shopify_fee", sourceId: "x" },
      ]),
    );
    const cmp = await feeForecastVsActual(ctx);
    expect(cmp.reportingCurrency).toBe("UAH");
    expect(cmp.rows.find((r) => r.gateway === "liqpay")).toEqual({
      gateway: "liqpay",
      month: "2026-11-01",
      orders: 2,
      ordersWithActual: 1,
      compared: 1,
      noRule: 0,
      ordersUnconverted: 0,
      forecast: "30.00",
      actual: "28.50",
      unconverted: [],
    });
    // Факт без чинного правила — поза порівнянням (not 0).
    const o2 = await insertOrder(db, { placedOn: "2026-11-07", currency: "UAH", total: "100.00", gateway: "no-rule-gw", state: "recognized" });
    await db.transaction((tx) =>
      postEntries(tx, { id: "test" }, [
        { idempotencyKey: `fee:cmp-${o2}`, category: "payment_fees", recognizedOn: "2026-11-07", fxOn: "2026-11-07", amount: "-1.00", currency: "UAH", orderId: o2, sourceType: "shopify_fee", sourceId: "x" },
      ]),
    );
    expect((await feeForecastVsActual(ctx)).rows.find((r) => r.gateway === "no-rule-gw")).toMatchObject({ ordersWithActual: 1, compared: 0, noRule: 1, forecast: null, actual: null });
  });

  it("a reversed (voided) actual fee is not an actual: «no data» (null), not 0,00 (F4)", async () => {
    const db = env.handle.db;
    const ctx = ctxAt(env, NOW);
    await saveFeeRule(ctx, { gateway: "void-gw", kind: "payment", percent: "3", noFees: false, appliesFrom: "2026-10-01" });
    const o = await insertOrder(db, { placedOn: "2026-10-03", currency: "UAH", total: "100.00", gateway: "void-gw", state: "recognized", recognizedOn: "2026-10-04", forecasts: [{ component: "fees", amount: "3.00", currency: "UAH" }] });
    const e = await createExpense(ctx, { operationId: op(), category: "payment_fees", amount: "3,00", currency: "UAH", dateMode: "single", expenseDate: "2026-10-31", gateway: "void-gw" });
    expect((await activeEntriesOf(db, e.id)).map((x) => x.orderId)).toEqual([o]);
    expect((await feeForecastVsActual(ctx)).rows.find((r) => r.gateway === "void-gw")).toMatchObject({ ordersWithActual: 1, compared: 1, forecast: "3.00", actual: "3.00" });
    await voidExpense(ctx, { expenseId: e.id, reason: "Неправильна виписка" });
    expect(await entriesOf(db, e.id)).toHaveLength(2);
    expect((await feeForecastVsActual(ctx)).rows.find((r) => r.gateway === "void-gw")).toEqual({
      gateway: "void-gw",
      month: "2026-10-01",
      orders: 1,
      ordersWithActual: 0,
      compared: 0,
      noRule: 0,
      ordersUnconverted: 0,
      forecast: null,
      actual: null,
      unconverted: [],
    });
  });

  it("values without a rate for the reporting currency are outside the sums and listed as currency + amount + count; the order is not «covered»", async () => {
    const db = env.handle.db;
    const ctx = ctxAt(env, NOW);
    await saveFeeRule(ctx, { gateway: "eur-gw", kind: "payment", percent: "3", noFees: false, appliesFrom: "2026-10-01" });
    const uah = await insertOrder(db, { placedOn: "2026-11-09", currency: "UAH", total: "200.00", gateway: "eur-gw", state: "recognized" });
    // Курсу EUR на 10.11 немає (демо-курсів у цій базі немає).
    const eur = await insertOrder(db, { placedOn: "2026-11-10", currency: "EUR", total: "100.00", gateway: "eur-gw", state: "recognized" });
    await db.transaction((tx) =>
      postEntries(tx, { id: "test" }, [
        { idempotencyKey: `fee:cmp-${uah}`, category: "payment_fees", recognizedOn: "2026-11-09", fxOn: "2026-11-09", amount: "-6.10", currency: "UAH", orderId: uah, sourceType: "shopify_fee", sourceId: "x" },
        { idempotencyKey: `fee:cmp-${eur}`, category: "payment_fees", recognizedOn: "2026-11-10", fxOn: "2026-11-10", amount: "-2.90", currency: "EUR", orderId: eur, sourceType: "shopify_fee", sourceId: "x" },
      ]),
    );
    expect((await feeForecastVsActual(ctx)).rows.find((r) => r.gateway === "eur-gw")).toEqual({
      gateway: "eur-gw",
      month: "2026-11-01",
      orders: 2,
      ordersWithActual: 2,
      compared: 1,
      noRule: 0,
      ordersUnconverted: 1,
      forecast: "6.00",
      actual: "6.10",
      unconverted: [
        { kind: "forecast", currency: "EUR", amount: "3.00", entries: 1 },
        { kind: "actual", currency: "EUR", amount: "2.90", entries: 1 },
      ],
    });
    expect(await listSeenGateways(ctxAt(env, NOW))).toEqual(expect.arrayContaining(["liqpay", "paypal", "Bank transfer"]));
  });
});

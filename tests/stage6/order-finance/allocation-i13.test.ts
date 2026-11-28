/**
 * Етап 6, WP4 — сума періоду, що замінює прогнози (§10.3, G13, I16) і I13 (§2.6, §20.2) через СПРАВЖНІ сервіси й
 * синхронізації (WP4 + WP6), без вставлених вручну прогнозів:
 *  - прогнози комісій WP4 (правило PayPal 1 %) 3,00 / 2,00 / 1,00 EUR — ваги розподілу суми 7,00 EUR «пропорційно
 *    їхнім прогнозам» → 3,50 / 2,33 / 1,17 (weightBasis forecast, G13_EXPECTED);
 *  - після збереження суми фінанси КОЖНОГО замовлення-частки оновлено в тій самій транзакції: комісії actual / allocated,
 *    прогноз не рахується (I16), замовлення final, картка «Факт» = Σ записів (I4);
 *  - пізнє замовлення того самого виміру й місяця → missing awaiting_reallocation, прибуток не показується, і в черзі є
 *    finance.expense_reallocate (WP4 ставить завдання останнім записом) → «Перерахувати розподіл» → частка, final;
 *  - анулювання суми → частки сторновано, комісії знову прогноз за правилом, прибуток «≈ Прогноз» без частки;
 *  - I13: Σ прибутку замовлень списку за станами (final — «Факт», preliminary — «≈ Прогноз») + записи періоду = прибуток
 *    НЕЗАЛЕЖНОЇ моделі (pnlReport) за тим самим правилом повноти; incomplete не входять у жоден прибуток.
 * Усі ідентифікатори, коди й суми вигадані.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, isNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { financeEntries, financeExpenseAllocations, jobs, orderFinance, orderFinanceForecasts } from "~/db/schema";
import { affectsProfit, isFinanceCategory } from "~/domain/finance";
import { fromMinor, toMinor } from "~/lib/decimal";
import { createExpense, recalculateAllocation, voidExpense } from "~/modules/expenses/expenses.server";
import { parseOrderComponents } from "~/modules/finance/core/states";
import { loadOrderFinanceCard } from "~/modules/order-finance/card.server";
import { isForecastCounted } from "~/modules/order-finance/components";
import { listOrderFinance } from "~/modules/order-finance/list.server";
import * as G from "../reference/golden";
import { activeEntries, pnlReport, postOrder, profitByStates, sumConverted, type RefEntry, type RefForecast, type RefOrderFacts, type RefOrderMeta, type RefRate } from "../reference/model";
import { GoldenOrder, openGoldenEnv, prodCtx, type GoldenEnv } from "./golden-helpers";

const RATES: readonly RefRate[] = [...G.G1_RATES, { currency: "EUR", date: "2026-11-02", rate: "48.8000", source: "nbu" }, { currency: "EUR", date: "2026-11-20", rate: "48.9000", source: "nbu" }];

/** Замовлення PayPal без накладної (доставка «Без витрат на доставку»), собівартість і упаковка оцінені. */
function paypal(id: string, total: string, placedAt: string, handedOverAt: string, withRule = false): RefOrderFacts {
  return {
    id,
    currency: "EUR",
    country: "DE",
    placedAt,
    handedOverAt,
    lines: [{ id: `li-${id}`, productId: "prod-a", quantity: 1 }],
    sales: [{ id: `s-${id}`, agreement: "order", lineType: "PRODUCT", lineId: `li-${id}`, productId: "prod-a", quantity: 1, totalAmount: total, taxAmount: "0.00", happenedAt: placedAt }],
    transactions: [{ id: `t-${id}`, kind: "SALE", status: "SUCCESS", amount: total, processedAt: placedAt, gateway: "paypal", fees: [] }],
    valuations: [
      { id: `v-${id}`, kind: "consume", lineId: `li-${id}`, productId: "prod-a", quantity: 1, value: "400.00", currency: "UAH", occurredAt: handedOverAt },
      { id: `v-${id}-p`, kind: "material", quantity: 1, value: "10.00", currency: "UAH", occurredAt: handedOverAt },
    ],
    waybills: [],
    invoiceLines: [],
    shippingOwnerMark: "no_shipping_cost",
    ...(withRule ? { feeRule: { kind: "percent" as const, percentBp: 100 } } : {}),
  };
}

const NOW = "2026-11-28T10:00:00Z";

describe("G13 / I16 / §10.3 — сума періоду PayPal 7,00 EUR через справжні прогнози WP4", () => {
  let env: GoldenEnv;
  const os: GoldenOrder[] = [];
  let expenseId = "";
  beforeAll(async () => {
    env = await openGoldenEnv(RATES);
    for (const [i, total] of ["300.00", "200.00", "100.00"].entries()) {
      const o = await new GoldenOrder(env, paypal(`g13-${i}`, total, "2026-11-05T07:00:00Z", "2026-11-06T12:00:00Z", i === 0)).create();
      await o.advance("2026-11-06T12:00:00Z");
      await o.advance("2026-11-07T00:00:00Z");
      os.push(o);
    }
  });
  afterAll(async () => {
    await env?.close();
  });

  const fees = async (o: GoldenOrder) => (await o.finance()).componentsParsed.fees;
  const activeAlloc = async (orderId: string) => {
    const rev = alias(financeEntries, "g13_rev");
    return env.db
      .select({ amount: financeEntries.amount, key: financeEntries.idempotencyKey })
      .from(financeEntries)
      .where(
        and(
          eq(financeEntries.orderId, orderId),
          eq(financeEntries.sourceType, "allocation"),
          isNull(financeEntries.reversesEntryId),
          notExists(env.db.select({ one: sql`1` }).from(rev).where(eq(rev.reversesEntryId, financeEntries.id))),
        ),
      );
  };

  it("до суми: комісії — прогноз за правилом −3,00 / −2,00 / −1,00 EUR (рахується), preliminary", async () => {
    for (const [i, o] of os.entries()) {
      expect(await fees(o)).toMatchObject({ state: "forecast", basis: "fee_rule", hasForecast: true });
      expect((await o.forecasts()).filter((f) => f.component === "fees").map((f) => f.amount)).toEqual([["-3.00", "-2.00", "-1.00"][i]]);
      expect((await o.finance()).profitState).toBe("preliminary");
    }
  });

  it("createExpense 7,00 EUR PayPal → ваги — прогнози (forecast): 3,50 / 2,33 / 1,17; кожне замовлення — actual allocated, final, прогноз не рахується", async () => {
    const r = await createExpense(prodCtx(env, NOW), { operationId: randomUUID(), category: "payment_fees", amount: "7.00", currency: "EUR", dateMode: "single", expenseDate: "2026-11-27", gateway: "paypal" });
    expenseId = r.id;
    expect(r.weightBasis).toBe("forecast");
    const shares = await env.db.select().from(financeExpenseAllocations).where(eq(financeExpenseAllocations.expenseId, expenseId)).orderBy(asc(financeExpenseAllocations.amount));
    expect(os.map((o) => shares.find((s) => s.orderId === o.orderId)?.amount)).toEqual([...G.G13_EXPECTED]);
    for (const [i, o] of os.entries()) {
      expect(await fees(o)).toMatchObject({ state: "actual", basis: "allocated", actual: [{ currency: "EUR", amount: `-${G.G13_EXPECTED[i]}` }] });
      const f = await o.finance();
      expect(f.profitState).toBe("final");
      // Прогноз лишається вагою (перерахунок), але НЕ рахується (I16).
      expect(await o.forecasts()).toEqual([]);
      const card = (await loadOrderFinanceCard(prodCtx(env, NOW), o.orderId, { currency: "EUR" }))!;
      expect(card.profit.kind).toBe("fact");
      expect(card.components.find((c) => c.component === "fees")!.forecast).toBeNull();
      const total = card.entries.filter((e) => !e.reversal && !e.reversed && isFinanceCategory(e.category) && affectsProfit(e.category)).reduce((a, e) => a + toMinor(e.converted!), 0n);
      expect(fromMinor(total)).toBe(card.profit.value);
      const row = (await listOrderFinance(prodCtx(env, NOW), { currency: "EUR" })).rows.find((x) => x.orderId === o.orderId)!;
      expect(row).toMatchObject({ profitKind: "fact", profit: card.profit.value });
    }
  });

  it("частки = модель за кортежем із fx_on (дата документа суми 27.11, R3) і позначкою, і в гривнях (картка = модель)", async () => {
    for (const [i, o] of os.slice(0, 3).entries()) {
      const ref: RefOrderFacts = {
        ...paypal(`g13-${i}`, ["300.00", "200.00", "100.00"][i]!, "2026-11-05T07:00:00Z", "2026-11-06T12:00:00Z", i === 0),
        feeAllocations: [{ expenseId, amount: G.G13_EXPECTED[i]!, currency: "EUR", knownAt: NOW, expenseDate: "2026-11-27" }],
      };
      const model = activeEntries(postOrder(ref, NOW).entries).filter((e) => e.category === "payment_fees");
      const app = (await o.entries()).filter((e) => e.category === "payment_fees");
      const tuple = (e: RefEntry) => `${e.amount}|${e.currency}|${e.recognizedOn}|${e.fxOn}|lc=${e.isLateCompletion}`;
      expect(app.map(tuple)).toEqual(model.map(tuple));
      expect(app.map((e) => e.fxOn)).toEqual(["2026-11-27"]);
      const card = (await loadOrderFinanceCard(prodCtx(env, NOW), o.orderId, { currency: "UAH" }))!;
      expect(card.rows.fees.net.converted).toBe(sumConverted(model, "UAH", { rates: RATES }).total);
      expect(card.rows.fees.net.converted).toBe(["-171.15", "-113.94", "-57.21"][i]);
    }
  });

  it("пізнє замовлення того самого виміру й місяця → missing awaiting_reallocation (прогноз не рахується, прибуток не показано) + у черзі finance.expense_reallocate", async () => {
    const late = await new GoldenOrder(env, paypal("g13-late", "100.00", "2026-11-20T07:00:00Z", "2026-11-21T12:00:00Z")).create();
    // Одна синхронізація (передача вже відбулась): прогнозу-ваги до неї ще немає — покриття перевіряється ПІСЛЯ запису.
    await late.advance(NOW);
    os.push(late);
    expect(await fees(late)).toMatchObject({ state: "missing", reason: "awaiting_reallocation" });
    const f = await late.finance();
    expect(f.profitState).toBe("incomplete");
    const card = (await loadOrderFinanceCard(prodCtx(env, NOW), late.orderId, { currency: "EUR" }))!;
    expect(card.profit).toMatchObject({ kind: "hidden", value: null });
    expect(card.profit.missing).toContainEqual({ component: "fees", reason: "awaiting_reallocation" });
    // Прогноз-вага лишився в таблиці (§10.3 «пропорційно їхнім прогнозам»), але не рахується.
    const weights = await env.db.select().from(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, late.orderId), eq(orderFinanceForecasts.component, "fees")));
    expect(weights.map((w) => w.amount)).toEqual(["-1.00"]);
    const queued = await env.db.select().from(jobs).where(and(eq(jobs.type, "finance.expense_reallocate"), eq(jobs.status, "queued")));
    expect(queued.map((j) => (j.payload as { expenseId?: string }).expenseId)).toContain(expenseId);
  });

  it("«Перерахувати розподіл» → частка пізнього замовлення (ваги 3 : 2 : 1 : 1), фінанси всіх замовлень оновлено: actual allocated, final", async () => {
    const r = await recalculateAllocation(prodCtx(env, NOW), { expenseId });
    expect(r.allocatedOrders).toBe(4);
    const late = os[3]!;
    expect((await activeAlloc(late.orderId)).map((e) => e.amount)).toEqual(["-1.00"]);
    for (const [i, o] of os.entries()) {
      expect(await fees(o)).toMatchObject({ state: "actual", basis: "allocated", actual: [{ currency: "EUR", amount: ["-3.00", "-2.00", "-1.00", "-1.00"][i] }] });
      expect((await o.finance()).profitState).toBe("final");
    }
  });

  it("voidExpense → частки сторновано; комісії знову прогноз за правилом (рахується), preliminary; картка без частки", async () => {
    await voidExpense(prodCtx(env, NOW), { expenseId, reason: "Помилка введення" });
    for (const [i, o] of os.entries()) {
      expect(await activeAlloc(o.orderId)).toEqual([]);
      expect(await fees(o)).toMatchObject({ state: "forecast", basis: "fee_rule", hasForecast: true, actual: [] });
      expect((await o.finance()).profitState).toBe("preliminary");
      expect((await o.forecasts()).filter((f) => f.component === "fees").map((f) => f.amount)).toEqual([["-3.00", "-2.00", "-1.00", "-1.00"][i]]);
      const card = (await loadOrderFinanceCard(prodCtx(env, NOW), o.orderId, { currency: "EUR" }))!;
      expect(card.profit.kind).toBe("forecast");
      expect(card.rows.fees.net.entries).toBe(0);
    }
  });
});

describe("I13 — Σ прибутку замовлень за станами + записи періоду = прибуток моделі (те саме правило повноти)", () => {
  let env: GoldenEnv;
  beforeAll(async () => {
    env = await openGoldenEnv(G.G1_RATES);
  });
  afterAll(async () => {
    await env?.close();
  });

  it("final (G1), preliminary (G2, G8b таблиця), incomplete (G8b без даних) + витрата періоду: список ↔ pnlReport (UAH і EUR)", async () => {
    const at = G.G1_AS_OF_AFTER_IMPORT;
    const steps = ["2026-10-05T12:00:00Z", "2026-10-06T09:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z", at];
    const refs: RefOrderFacts[] = [
      { ...G.G1_ORDER, partner: undefined },
      { ...G.G2_ORDER, partner: undefined },
      { ...G.G8B_ORDER_TABLE, id: "i13-g8b-table" },
      // Інша країна: таблиця власника (DE з G8b) не діє, середньої немає → доставка без прогнозу → incomplete.
      { ...G.G8B_ORDER_NOTHING, id: "i13-g8b-nothing", country: "PL", noWaybillForecast: undefined },
    ];
    const orders: GoldenOrder[] = [];
    for (const ref of refs) {
      const o = await new GoldenOrder(env, ref).create();
      for (const t of steps) await o.advance(t);
      orders.push(o);
    }
    const states = await Promise.all(orders.map(async (o) => (await o.finance()).profitState));
    expect(states).toEqual(["final", "preliminary", "preliminary", "incomplete"]);
    await createExpense(prodCtx(env, at), { operationId: randomUUID(), category: "advertising", amount: "500.00", currency: "UAH", dateMode: "single", expenseDate: "2026-10-20" });

    // Журнал застосунку → вхід моделі (index.ts: finance_entries → RefEntry, order_finance → RefOrderMeta, прогнози, що
    // рахуються → RefForecast з датою курсу за правилом WP4).
    const rev = alias(financeEntries, "i13_rev");
    const rows = await env.db
      .select()
      .from(financeEntries)
      .where(and(isNull(financeEntries.reversesEntryId), notExists(env.db.select({ one: sql`1` }).from(rev).where(eq(rev.reversesEntryId, financeEntries.id)))));
    const entries: RefEntry[] = rows.map((r) => ({
      key: r.idempotencyKey,
      orderId: r.orderId,
      category: r.category as RefEntry["category"],
      amount: r.amount,
      currency: r.currency.trim(),
      recognizedOn: r.recognizedOn,
      fxOn: r.fxOn,
      originalOn: r.originalOn,
      isLate: r.isLate,
      isLateCompletion: r.isLateCompletion,
      reversesKey: null,
    }));
    const fins = await env.db.select().from(orderFinance);
    const metas: RefOrderMeta[] = fins.map((f) => ({ orderId: f.orderId, state: f.state === "recognized" ? (f.profitState as RefOrderMeta["state"]) : f.state, recognizedOn: f.recognizedOn }));
    const forecasts: RefForecast[] = [];
    for (const f of fins) {
      const comps = parseOrderComponents(f.components) ?? {};
      const fc = await env.db.select().from(orderFinanceForecasts).where(eq(orderFinanceForecasts.orderId, f.orderId));
      for (const r of fc) {
        if (!isForecastCounted(r.component, comps[r.component])) continue;
        // Комісії — дата курсу виручки (D-25, дата оплати 05.10), інше — дата визнання.
        forecasts.push({ orderId: f.orderId, component: r.component as RefForecast["component"], amount: r.amount, currency: r.currency.trim(), fxOn: r.component === "fees" ? "2026-10-05" : f.recognizedOn!, recognizedOn: f.recognizedOn!, basis: r.basis });
      }
    }
    for (const currency of ["UAH", "EUR"]) {
      const list = await listOrderFinance(prodCtx(env, at), { currency });
      const sum = (kind: "fact" | "forecast") => list.rows.filter((r) => r.profitKind === kind).reduce((a, r) => a + toMinor(r.profit!), 0n);
      const j = { entries, orders: metas, forecasts };
      const opts = { from: "2026-01-01", to: "2026-12-31", currency, ctx: { rates: G.G1_RATES } };
      const model = pnlReport(j, opts);
      expect(model.unconverted).toEqual([]);
      const byState = profitByStates(j, opts);
      const period = toMinor(byState.period);
      // Σ записів final-замовлень моделі = Σ «Факт» списку (кожне замовлення — свої записи за курсами своїх дат).
      expect(byState.final).toBe(fromMinor(sum("fact")));
      // Записи періоду: реклама −500,00 + загальні суми упаковки двох місяців G8b (packaging_unlinked −50,00 × 2).
      expect(currency === "UAH" ? period : null).toBe(currency === "UAH" ? -60000n : null);
      // «Факт» = Σ final + Σ записів періоду; «≈ Прогноз» = Факт + Σ preliminary (записи + прогнози, що рахуються).
      expect(fromMinor(sum("fact") + period)).toBe(model.profit.fact);
      expect(fromMinor(sum("fact") + sum("forecast") + period)).toBe(model.profit.forecast);
      // incomplete — у жодному прибутку (список не показує, модель — «Не враховано в прибутку»).
      const inc = list.rows.find((r) => r.orderId === orders[3]!.orderId)!;
      expect(inc).toMatchObject({ profitKind: "hidden", profit: null });
      expect(model.notCounted.orders).toBe(1);
    }
  });
});

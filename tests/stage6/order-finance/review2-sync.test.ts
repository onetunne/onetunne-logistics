/**
 * Етап 6, WP4 — регресії другого раунду огляду (PGlite / PostgreSQL), застосунок проти НЕЗАЛЕЖНОЇ моделі (WP12a), де модель
 * описує випадок; кортеж порівняння — з original_on і `is_late_completion` (WP12b порівнює без позначки):
 *  - chargeback: перенесення дати рішення між відкритими місяцями / у межах місяця — записи датою й курсом нової дати;
 *  - комісії по транзакції (§8.1): Shopify Payments + PayPal без комісій, дві оплати (CAPTURE) з одним порожнім `fees`;
 *  - відкрите замовлення з ручною витратою чи часткою суми періоду — не «Факт» (записів до визнання немає, §3.3);
 *  - документ рахунку, замінений до визнання, не є першим документом: пізніший перший — R3 (= модель);
 *  - перемикання includeTestOrders: рахунок виключеного (R5) → врахованого (R3, пізнє завершення) — навіть коли дата
 *    послуги збігається з датою визнання (= модель);
 *  - перші продажі, що стали відомими після визнання, — R3 з позначкою (= модель, виправлену в цьому раунді).
 * Усі ідентифікатори, коди й суми вигадані.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { carrierInvoiceLines, carrierInvoices, financeExpenseAllocations, orderFinanceForecasts, orderTransactions } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { createExpense } from "~/modules/expenses/expenses.server";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { resyncTestOrders, saveOrderChargeback } from "~/modules/order-finance/actions.server";
import { isForecastCounted } from "~/modules/order-finance/components";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import * as G from "../reference/golden";
import { activeEntries, postOrder, type RefEntry, type RefOrderFacts } from "../reference/model";
import { OWNER } from "../../helpers";
import { GoldenOrder, openGoldenEnv, prodCtx, tupleOf, type GoldenEnv } from "./golden-helpers";

let env: GoldenEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const G1NR: RefOrderFacts = { ...G.G1_ORDER_NO_RETURN, partner: undefined };

/** Кортеж із original_on і позначкою пізнього завершення. */
const lcTuples = (entries: readonly Pick<RefEntry, "category" | "amount" | "currency" | "recognizedOn" | "fxOn" | "originalOn" | "isLateCompletion">[]) =>
  entries.map((e) => `${tupleOf(e)}|orig=${e.originalOn}|lc=${e.isLateCompletion}`).sort();

describe("chargeback (§8.2 R2): перенесення дати рішення переносить записи", () => {
  const cbOf = async (o: GoldenOrder) =>
    (await o.entries())
      .filter((e) => e.category === "chargeback_loss" || e.category === "chargeback_fees")
      .map((e) => `${e.category}|${e.amount}|${e.recognizedOn}|${e.fxOn}`)
      .sort();

  it("12.11 → 03.12 (обидва місяці відкриті): старі записи сторновано, нові — 03.12 з курсом 03.12; повторне збереження — без змін", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G1NR).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance(G.G1_AS_OF_AFTER_IMPORT);
    const ctx = prodCtx(env, "2026-12-05T10:00:00Z");
    const input = { orderId: o.orderId, amount: "129.00", recovered: "0.00", currency: "EUR", fee: "15.00", feeCurrency: "EUR", outcome: "lost", vatReducible: false, fullPartnerCancellation: false };
    const first = await saveOrderChargeback(ctx, { ...input, operationId: randomUUID(), decidedOn: "2026-11-12" });
    expect(await cbOf(o)).toEqual(["chargeback_fees|-15.00|2026-11-12|2026-11-12", "chargeback_loss|-129.00|2026-11-12|2026-11-12"]);
    const moved = await saveOrderChargeback(ctx, { ...input, operationId: randomUUID(), disputeId: first.disputeId, decidedOn: "2026-12-03" });
    expect(await cbOf(o)).toEqual(["chargeback_fees|-15.00|2026-12-03|2026-12-03", "chargeback_loss|-129.00|2026-12-03|2026-12-03"]);
    const count = (await o.entries()).length;
    // Нова версія з тією самою датою й сумами — без сторно й нових записів.
    await saveOrderChargeback(ctx, { ...input, operationId: randomUUID(), disputeId: first.disputeId, decidedOn: "2026-12-03", expectedVersion: moved.version });
    expect((await o.entries()).length).toBe(count);
    expect(await cbOf(o)).toEqual(["chargeback_fees|-15.00|2026-12-03|2026-12-03", "chargeback_loss|-129.00|2026-12-03|2026-12-03"]);
  });

  it("12.11 → 20.11 (той самий місяць): fx_on переходить на 20.11", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G1NR).create();
    await o.advance("2026-10-05T12:00:00Z");
    const ctx = prodCtx(env, "2026-11-25T10:00:00Z");
    const input = { orderId: o.orderId, amount: "129.00", recovered: "0.00", currency: "EUR", fee: null, feeCurrency: null, outcome: "lost", vatReducible: false, fullPartnerCancellation: false };
    const first = await saveOrderChargeback(ctx, { ...input, operationId: randomUUID(), decidedOn: "2026-11-12" });
    await saveOrderChargeback(ctx, { ...input, operationId: randomUUID(), disputeId: first.disputeId, decidedOn: "2026-11-20" });
    expect(await cbOf(o)).toEqual(["chargeback_loss|-129.00|2026-11-20|2026-11-20"]);
  });
});

describe("комісії по транзакції (§8.1): порожній `fees` оплати — немає даних, НІКОЛИ не 0", () => {
  const split: RefOrderFacts = {
    ...G1NR,
    id: "ord-split",
    transactions: [
      { id: "t-sp-1", kind: "SALE", status: "SUCCESS", amount: "79.00", processedAt: "2026-10-05T07:00:00Z", gateway: "shopify_payments", fees: [{ id: "fee-sp", amount: "2.50", currency: "EUR" }] },
      { id: "t-sp-2", kind: "SALE", status: "SUCCESS", amount: "50.00", processedAt: "2026-10-05T07:00:00Z", gateway: "paypal", fees: [] },
    ],
  };
  const run = async (ref: RefOrderFacts) => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance(G.G1_AS_OF_AFTER_IMPORT);
    return { o, model: postOrder(ref, G.G1_AS_OF_AFTER_IMPORT) };
  };

  it("Shopify Payments (комісія 2,50) + PayPal без комісій, правило 3 % → partial, прогноз −1,50 (PayPal), preliminary; = модель", async () => {
    const ref: RefOrderFacts = { ...split, feeRule: { kind: "percent", percentBp: 300 } };
    const { o, model } = await run(ref);
    const f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "partial", hasForecast: true, basis: "fee_rule", actual: [{ currency: "EUR", amount: "-2.50" }] });
    expect(f.profitState).toBe("preliminary");
    expect((await o.forecasts()).filter((x) => x.component === "fees")).toEqual([{ component: "fees", amount: "-1.50", currency: "EUR", basis: "fee_rule" }]);
    expect(lcTuples(await o.entries())).toEqual(lcTuples(activeEntries(model.entries)));
    expect(model.order.components?.fees).toMatchObject({ state: "partial", hasForecast: true });
    expect(model.forecasts.filter((x) => x.component === "fees").map((x) => x.amount)).toEqual(["-1.50"]);
    expect(model.order.state).toBe("preliminary");
  });

  it("без правила для PayPal → partial без прогнозу, incomplete (прибуток не показується); = модель", async () => {
    const { o, model } = await run(split);
    const f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "partial", hasForecast: false, reason: "no_fee_data" });
    expect(f.profitState).toBe("incomplete");
    expect(model.order.state).toBe("incomplete");
  });

  it("дві оплати CAPTURE одного шлюзу, друга без комісій, правило 3 % → partial з прогнозом −1,50", async () => {
    const ref: RefOrderFacts = {
      ...split,
      id: "ord-captures",
      feeRule: { kind: "percent", percentBp: 300 },
      transactions: split.transactions.map((t) => ({ ...t, kind: "CAPTURE" as const, gateway: "shopify_payments" })),
    };
    const { o, model } = await run(ref);
    expect((await o.finance()).componentsParsed.fees).toMatchObject({ state: "partial", hasForecast: true });
    expect((await o.forecasts()).filter((x) => x.component === "fees").map((x) => x.amount)).toEqual(["-1.50"]);
    expect(model.forecasts.filter((x) => x.component === "fees").map((x) => x.amount)).toEqual(["-1.50"]);
  });

  it("комісія на авторизації (AUTHORIZATION → CAPTURE без комісій) покриває її списання → actual, final; без зв'язку — прогноз; = модель", async () => {
    const auth: RefOrderFacts = {
      ...split,
      id: "ord-auth",
      feeRule: { kind: "percent", percentBp: 300 },
      transactions: [
        { id: "t-auth", kind: "AUTHORIZATION", status: "SUCCESS", amount: "129.00", processedAt: "2026-10-05T07:00:00Z", gateway: "shopify_payments", fees: [{ id: "fee-auth", amount: "4.04", currency: "EUR" }] },
        { id: "t-cap", kind: "CAPTURE", status: "SUCCESS", amount: "129.00", processedAt: "2026-10-05T08:00:00Z", gateway: "shopify_payments", fees: [], parentId: "t-auth" },
      ],
    };
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, auth).create();
    await o.advance("2026-10-05T12:00:00Z", { sync: false });
    // Без зв'язку з авторизацією єдина оплата (CAPTURE) не має даних про комісію — не «Факт»: прогноз за правилом.
    await env.db.transaction((tx) => syncOrderFinanceAt(tx, SYSTEM_ACTOR, o.orderId, { now: new Date("2026-10-05T12:00:00Z") }));
    expect((await o.finance()).componentsParsed.fees).toMatchObject({ state: "forecast", basis: "fee_rule", hasForecast: true });
    // WP3 записує батьківську транзакцію (gid авторизації).
    await env.db
      .update(orderTransactions)
      .set({ parentTransactionId: `gid://shopify/OrderTransaction/t-auth-${o.orderId}` })
      .where(and(eq(orderTransactions.orderId, o.orderId), eq(orderTransactions.kind, "CAPTURE")));
    await o.advance(G.G1_AS_OF_AFTER_IMPORT);
    const f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "actual", basis: "shopify" });
    expect(f.profitState).toBe("final");
    const model = postOrder(auth, G.G1_AS_OF_AFTER_IMPORT);
    expect(model.order.state).toBe("final");
    expect(lcTuples(await o.entries())).toEqual(lcTuples(activeEntries(model.entries)));
  });

  it("правило «без комісії» для PayPal → комісії actual (Shopify), final", async () => {
    const ref: RefOrderFacts = { ...split, feeRule: { kind: "no_fees" } };
    const { o, model } = await run(ref);
    // Правило «без комісії» вставлено для обох шлюзів: оплата Shopify Payments має факт, PayPal — підтверджений нуль.
    expect((await o.finance()).componentsParsed.fees).toMatchObject({ state: "actual", basis: "shopify" });
    expect((await o.finance()).profitState).toBe("final");
    expect(model.order.state).toBe("final");
  });
});

describe("відкрите замовлення (§3.3): ручна витрата й частка суми періоду — прогноз, не «Факт»", () => {
  it("ручна доставка 300 грн до передачі → forecast (manual), рядок −300,00, записів немає; після передачі — actual manual, запис −300,00", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G1NR, invoiceLines: [] };
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T10:00:00Z");
    expect((await o.finance()).state).toBe("open");
    await createExpense(prodCtx(env, "2026-10-05T10:30:00Z"), { operationId: randomUUID(), category: "shipping_cost", amount: "300.00", currency: "UAH", dateMode: "single", expenseDate: "2026-10-05", order: o.orderId });
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "forecast", basis: "manual", hasForecast: true, actual: [] });
    expect((await o.forecasts()).filter((x) => x.component === "shipping_cost").map((x) => [x.amount, x.basis])).toEqual([["-300.00", "manual"]]);
    expect((await o.entries()).filter((e) => e.category === "shipping_cost")).toEqual([]);
    await o.advance("2026-10-05T12:00:00Z");
    const g = await o.finance();
    expect(g.componentsParsed.shipping_cost).toMatchObject({ state: "actual", basis: "manual", actual: [{ currency: "UAH", amount: "-300.00" }] });
    expect((await o.entries()).filter((e) => e.category === "shipping_cost").map((e) => e.amount)).toEqual(["-300.00"]);
  });

  it("сума періоду PayPal розподілена на відкриті замовлення → комісії forecast (allocated), без записів і без «≈»; після передачі — actual allocated, частки ті самі", async () => {
    env = await openGoldenEnv([...G.G1_RATES, { currency: "EUR", date: "2026-11-20", rate: "48.9000", source: "nbu" }]);
    const os: GoldenOrder[] = [];
    for (const [i, total] of ["300.00", "200.00", "100.00"].entries()) {
      const ref: RefOrderFacts = {
        id: `open-pp-${i}`,
        currency: "EUR",
        country: "DE",
        placedAt: "2026-11-05T07:00:00Z",
        handedOverAt: "2026-11-26T12:00:00Z",
        lines: [{ id: `li-open-pp-${i}`, productId: "prod-a", quantity: 1 }],
        sales: [{ id: `s-open-pp-${i}`, agreement: "order", lineType: "PRODUCT", lineId: `li-open-pp-${i}`, productId: "prod-a", quantity: 1, totalAmount: total, taxAmount: "0.00", happenedAt: "2026-11-05T07:00:00Z" }],
        transactions: [{ id: `t-open-pp-${i}`, kind: "SALE", status: "SUCCESS", amount: total, processedAt: "2026-11-05T07:00:00Z", gateway: "paypal", fees: [] }],
        valuations: [],
        waybills: [],
        invoiceLines: [],
        shippingOwnerMark: "no_shipping_cost",
        ...(i === 0 ? { feeRule: { kind: "percent" as const, percentBp: 100 } } : {}),
      };
      const o = await new GoldenOrder(env, ref).create();
      await o.advance("2026-11-10T00:00:00Z");
      os.push(o);
    }
    for (const o of os) expect((await o.finance()).componentsParsed.fees).toMatchObject({ state: "forecast", basis: "fee_rule", hasForecast: true });
    const r = await createExpense(prodCtx(env, "2026-11-25T10:00:00Z"), { operationId: randomUUID(), category: "payment_fees", amount: "7.00", currency: "EUR", dateMode: "single", expenseDate: "2026-11-24", gateway: "paypal" });
    expect(r.weightBasis).toBe("forecast");
    const shares = async () =>
      (await env!.db.select().from(financeExpenseAllocations).where(eq(financeExpenseAllocations.expenseId, r.id))).map((s) => `${s.orderId}|${s.amount}`).sort();
    const before = await shares();
    expect(before).toHaveLength(3);
    for (const o of os) {
      const f = await o.finance();
      expect(f.state).toBe("open");
      expect(f.componentsParsed.fees).toMatchObject({ state: "forecast", basis: "allocated", hasForecast: false });
      expect((await o.entries()).filter((e) => e.category === "payment_fees")).toEqual([]);
      // Рядок прогнозу лишається вагою розподілу (§10.3), але в «≈ Прогноз» не рахується (isForecastCounted).
      const weights = await env.db.select().from(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, o.orderId), eq(orderFinanceForecasts.component, "fees")));
      expect(weights.length).toBe(1);
      expect(isForecastCounted("fees", f.componentsParsed.fees)).toBe(false);
    }
    for (const o of os) await o.advance("2026-11-26T12:00:00Z");
    for (const [i, o] of os.entries()) {
      expect((await o.finance()).componentsParsed.fees).toMatchObject({ state: "actual", basis: "allocated", actual: [{ currency: "EUR", amount: `-${G.G13_EXPECTED[i]}` }] });
    }
    expect(await shares()).toEqual(before);
  });
});

describe("перший документ накладної (§3.3 R3): документ, замінений до визнання, не проводився", () => {
  const ref: RefOrderFacts = {
    ...G1NR,
    id: "ord-replaced",
    handedOverAt: "2026-10-31T10:00:00Z",
    invoiceLines: [
      { id: "il-v1", waybillId: "wb-g1", documentId: "inv-v1", chargeType: "delivery", amount: "540.00", currency: "UAH", serviceDate: "2026-10-29", importedAt: "2026-10-30T08:00:00Z", reversedAt: "2026-10-30T12:00:00Z" },
      { id: "il-v2", waybillId: "wb-g1", documentId: "inv-v2", chargeType: "delivery", amount: "530.00", currency: "UAH", serviceDate: "2026-11-02", importedAt: "2026-11-05T09:00:00Z" },
    ],
  };
  it("v1 (30.10) замінено 30.10, визнання 31.10, v2 імпортовано 05.11 → v2: 31.10, fx 02.11, пізнє завершення; = модель", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-30T08:00:00Z");
    // Документ v1 замінено (WP5: status = replaced) ще до визнання.
    const [v1] = await env.db
      .select({ id: carrierInvoices.id })
      .from(carrierInvoices)
      .innerJoin(carrierInvoiceLines, eq(carrierInvoiceLines.invoiceId, carrierInvoices.id))
      .where(and(eq(carrierInvoiceLines.orderId, o.orderId), eq(carrierInvoiceLines.amount, "540.00")));
    await env.db.update(carrierInvoices).set({ status: "replaced" }).where(eq(carrierInvoices.id, v1!.id));
    await o.advance("2026-10-30T12:00:00Z");
    await o.advance("2026-10-31T10:00:00Z");
    expect((await o.finance()).componentsParsed.shipping_cost).toMatchObject({ state: "forecast", basis: "carrier_reported" });
    const at = "2026-11-05T10:00:00Z";
    await o.advance(at);
    const ship = (await o.entries()).filter((e) => e.category === "shipping_cost");
    expect(ship.map((e) => [e.amount, e.recognizedOn, e.fxOn, e.isLateCompletion])).toEqual([["-530.00", "2026-10-31", "2026-11-02", true]]);
    expect(lcTuples(await o.entries())).toEqual(lcTuples(activeEntries(postOrder(ref, at).entries)));
  });
});

describe("includeTestOrders (§2.5): рахунок тестового замовлення R5 → R3 з позначкою пізнього завершення", () => {
  it("G1 без повернення, test: excluded 05.10 / 30.11 → увімкнено → resyncTestOrders: рахунок 10.11 (послуга 05.10 = дата визнання) — lc = true; = модель", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G1NR, id: "ord-test-toggle", test: true };
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance(G.G1_AS_OF_AFTER_IMPORT);
    expect((await o.finance()).state).toBe("excluded");
    const excluded = (await o.entries()).filter((e) => e.category === "shipping_cost");
    expect(excluded.map((e) => [e.recognizedOn, e.isLateCompletion])).toEqual([["2026-10-05", false]]);
    await saveFinanceSettings(env.ctx(OWNER), { includeTestOrders: true }, { reason: "test" });
    await resyncTestOrders(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT));
    expect((await o.finance()).state).toBe("recognized");
    const ship = (await o.entries()).filter((e) => e.category === "shipping_cost");
    expect(ship.map((e) => [e.amount, e.recognizedOn, e.fxOn, e.isLateCompletion])).toEqual([["-540.00", "2026-10-05", "2026-10-05", true]]);
    const model = postOrder(ref, G.G1_AS_OF_AFTER_IMPORT, { includeTestOrders: true });
    expect(lcTuples((await o.entries()).filter((e) => e.category === "shipping_cost"))).toEqual(lcTuples(activeEntries(model.entries).filter((e) => e.category === "shipping_cost")));
    // Назад (вимкнено): R5 без позначки.
    await saveFinanceSettings(env.ctx(OWNER), { includeTestOrders: false }, { reason: "test" });
    await resyncTestOrders(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT));
    expect((await o.entries()).filter((e) => e.category === "shipping_cost").map((e) => [e.recognizedOn, e.isLateCompletion])).toEqual([["2026-10-05", false]]);
  });
});

describe("перші продажі, відомі після визнання (§3.3 R3) — застосунок = модель з позначкою", () => {
  it("G1b: продаж відомий 10.10 (визнання 05.10) → sales_product 05.10, fx 01.10, is_late_completion = true в обох", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G.G1B_ORDER, sales: G.G1B_ORDER.sales.map((s) => ({ ...s, knownAt: "2026-10-10T00:00:00Z" })) };
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T12:00:00Z");
    const at = "2026-10-10T00:00:00Z";
    await o.advance(at);
    const sale = (await o.entries()).filter((e) => e.category === "sales_product");
    expect(sale.map((e) => [e.amount, e.recognizedOn, e.fxOn, e.isLateCompletion])).toEqual([["100.00", "2026-10-05", "2026-10-01", true]]);
    const model = activeEntries(postOrder(ref, at).entries).filter((e) => e.category === "sales_product");
    expect(lcTuples(sale)).toEqual(lcTuples(model));
  });
});

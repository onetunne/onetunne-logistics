/**
 * Етап 6, WP4 — регресії огляду синхронізації (PGlite / PostgreSQL), застосунок проти НЕЗАЛЕЖНОЇ моделі там, де модель
 * описує випадок:
 *  - прогноз доставки country_average — ДОДАТНА вартість (як carrier_reported / owner_table), рядок прогнозу «−»; картка
 *    «≈ Прогноз» зменшується на середню (§7.1, §4) — раніше знак був подвійно обернений і прогноз збільшував прибуток;
 *  - RC2 (Σ платежів ≠ netPaymentSet) → комісії partial, замовлення не final, «Оплачено покупцем» не підтверджено (§16.5);
 *  - chargeback JPY: збереження спору власником і синхронізація проводять цілі єни (§5.1, §8.2);
 *  - перші продажі після визнання (виручка «немає даних» при визнанні) — R3 «пізнє завершення» (§3.3);
 *  - відкрите замовлення: оцінена упаковка й рахунок до передачі — прогноз, записів немає (§3.3);
 *  - тестове замовлення (excluded): справжні витрати упаковки й рахунку лишаються (R5), як у моделі (§2.5);
 *  - DDP: лише мито — доставка не фактична; мито раніше за доставку — перша доставка R3 (§3.3, §7.2).
 * Усі ідентифікатори, коди й суми вигадані.
 */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { financeDiscrepancies, orderShopifyFinance, shippingForecastSnapshots } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { toMinorForCurrency } from "~/lib/decimal";
import { reconciliationKeyPrefix, unknownReconciliation } from "~/modules/finance-sync/reconcile";
import { emptySnapshot } from "~/modules/finance-sync/snapshot";
import { openDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { loadOrderFinanceCard } from "~/modules/order-finance/card.server";
import { saveOrderChargeback } from "~/modules/order-finance/actions.server";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import * as G from "../reference/golden";
import { activeEntries, postOrder, type RefOrderFacts } from "../reference/model";
import { GoldenOrder, openGoldenEnv, prodCtx, tuples, type GoldenEnv } from "./golden-helpers";

let env: GoldenEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/** G1 без повернення й без партнера (партнера в цих випадках не створюємо — модель так само без винагороди). */
const G1NR: RefOrderFacts = { ...G.G1_ORDER_NO_RETURN, partner: undefined };

const sync = (o: GoldenOrder, at: string) => env!.db.transaction((tx) => syncOrderFinanceAt(tx, SYSTEM_ACTOR, o.orderId, { now: new Date(at) }));

describe("country_average (§7.1): заморожена середня — додатна вартість, прогноз зменшує прибуток", () => {
  it("3 накладні DE з фактом 500 / 600 / 701 → 4-те замовлення: знімок +600,33, рядок прогнозу −600,33; картка «≈ Прогноз» 4 389,23 · 70,2 %", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const il = G1NR.invoiceLines[0]!;
    for (const [i, amount] of ["500.00", "600.00", "701.00"].entries()) {
      const ref: RefOrderFacts = { ...G1NR, id: `ca-${i}`, invoiceLines: [{ ...il, id: `il-ca-${i}`, amount, importedAt: "2026-10-06T09:00:00Z" }] };
      const o = await new GoldenOrder(env, ref).create();
      await o.advance("2026-10-05T12:00:00Z");
      await o.advance("2026-10-07T00:00:00Z");
      expect((await o.finance()).componentsParsed.shipping_cost).toMatchObject({ state: "actual", basis: "invoice" });
    }
    const ref4: RefOrderFacts = {
      ...G1NR,
      id: "ca-4",
      handedOverAt: "2026-10-20T12:00:00Z",
      waybills: [{ ...G1NR.waybills[0]!, frozenForecast: { basis: "country_average", amount: "600.33", currency: "UAH" } }],
      invoiceLines: [],
    };
    const o4 = await new GoldenOrder(env, ref4).create();
    const at = "2026-10-21T00:00:00Z";
    await o4.advance("2026-10-20T12:00:00Z");
    await o4.advance(at);
    const [snap] = await env.db.select().from(shippingForecastSnapshots).where(eq(shippingForecastSnapshots.orderId, o4.orderId));
    expect(snap).toMatchObject({ basis: "country_average", amount: "600.33", currency: "UAH" });
    expect(snap!.basisDetails).toMatchObject({ samples: 3, country: "DE" });
    // Модель: та сама основа й той самий знак прогнозу (витрата «−»).
    const model = postOrder(ref4, at);
    expect(tuples(await o4.entries())).toEqual(tuples(activeEntries(model.entries)));
    const fc = (await o4.forecasts()).filter((f) => f.component === "shipping_cost");
    expect(fc).toEqual(model.forecasts.filter((f) => f.component === "shipping_cost").map((f) => ({ component: f.component, amount: f.amount, currency: f.currency, basis: f.basis })));
    expect(fc.map((f) => f.amount)).toEqual(["-600.33"]);
    const card = (await loadOrderFinanceCard(prodCtx(env, at), o4.orderId, { currency: "UAH" }))!;
    // 6 256,50 − 1 050,00 − 21,00 − 195,94 − 600,33 = 4 389,23.
    expect(card.profit).toMatchObject({ kind: "forecast", value: "4389.23", margin: "70.2" });
    expect(card.components.find((c) => c.component === "shipping_cost")!.forecast?.original).toEqual([{ amount: "-600.33", currency: "UAH" }]);
  });
});

describe("RC2 (§16.5): відкрита розбіжність платежів → комісії partial, не final; розв'язано → final", () => {
  it("G1 30.11 final → RC2 mismatch + відкрита розбіжність → fees partial (reconciliation_mismatch), preliminary; картка: «Оплачено» не підтверджено", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G.G1_ORDER).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z", G.G1_AS_OF_AFTER_IMPORT]) await o.advance(t);
    expect((await o.finance()).profitState).toBe("final");
    const rec = unknownReconciliation();
    for (const c of Object.keys(rec.checks) as Array<keyof typeof rec.checks>) rec.checks[c] = { ...rec.checks[c], status: "ok", reason: undefined };
    rec.checks.RC2 = { status: "mismatch", candidate: false, expected: "84.00", actual: "129.00", currency: "EUR" };
    await env.db.update(orderShopifyFinance).set({ reconciliation: rec as unknown as Record<string, unknown> }).where(eq(orderShopifyFinance.orderId, o.orderId));
    const key = `${reconciliationKeyPrefix(o.orderId, "RC2")}84.00:129.00`;
    await env.db.transaction((tx) => openDiscrepancy(tx, SYSTEM_ACTOR, { type: "reconciliation_mismatch", dedupeKey: key, orderId: o.orderId, details: { check: "RC2" } }));
    await sync(o, G.G1_AS_OF_AFTER_IMPORT);
    let f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "partial", reason: "reconciliation_mismatch", basis: "shopify" });
    expect(f.profitState).toBe("preliminary");
    const card = (await loadOrderFinanceCard(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT), o.orderId, { currency: "UAH" }))!;
    expect(card.paid).toMatchObject({ reconciliationMismatch: true, complete: false });
    // Власник розв'язав розбіжність → комісії знову фактичні, замовлення final.
    await env.db.update(financeDiscrepancies).set({ status: "resolved", resolutionCode: "accepted" }).where(eq(financeDiscrepancies.dedupeKey, key));
    await sync(o, G.G1_AS_OF_AFTER_IMPORT);
    f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "actual", basis: "shopify" });
    expect(f.profitState).toBe("final");
    const after = (await loadOrderFinanceCard(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT), o.orderId, { currency: "UAH" }))!;
    expect(after.paid).toMatchObject({ reconciliationMismatch: false, complete: true });
  });

  it("змінений незмінний TransactionFee (розбіжність `fee`) → комісії partial", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G1NR).create();
    for (const t of ["2026-10-05T12:00:00Z", G.G1_AS_OF_AFTER_IMPORT]) await o.advance(t);
    expect((await o.finance()).profitState).toBe("final");
    await env.db.transaction((tx) =>
      openDiscrepancy(tx, SYSTEM_ACTOR, { type: "reconciliation_mismatch", dedupeKey: `${reconciliationKeyPrefix(o.orderId, "fee")}fee-x:abc`, orderId: o.orderId, details: { check: "fee" } }),
    );
    await sync(o, G.G1_AS_OF_AFTER_IMPORT);
    const f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "partial", reason: "reconciliation_mismatch" });
    expect(f.profitState).not.toBe("final");
  });
});

describe("chargeback JPY (§5.1, §8.2): цілі одиниці, синхронізація не падає", () => {
  const JPY_ORDER: RefOrderFacts = {
    ...G.G2_ORDER,
    id: "ord-jpy",
    currency: "JPY",
    sales: [
      { id: "s-jpy-p", agreement: "order", lineType: "PRODUCT", lineId: G.G2_ORDER.lines[0]!.id, productId: G.G2_ORDER.lines[0]!.productId, quantity: 1, totalAmount: "5950", taxAmount: "950", happenedAt: G.G2_ORDER.placedAt },
      { id: "s-jpy-s", agreement: "order", lineType: "SHIPPING", totalAmount: "1000", taxAmount: "160", happenedAt: G.G2_ORDER.placedAt },
    ],
    transactions: [{ id: "t-jpy", kind: "SALE", status: "SUCCESS", amount: "6950", processedAt: G.G2_ORDER.placedAt, gateway: "shopify_payments", fees: [] }],
    partner: undefined,
  };
  it("saveOrderChargeback(6 950 / повернено 2 000, lost) → chargeback_loss 4 159 + 791 JPY; повторна синхронізація без змін", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, JPY_ORDER).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance("2026-10-10T00:00:00Z");
    const ctx = prodCtx(env, "2026-11-20T10:00:00Z");
    const r = await saveOrderChargeback(ctx, { orderId: o.orderId, operationId: randomUUID(), amount: "6950", recovered: "2000", currency: "JPY", fee: null, feeCurrency: null, outcome: "lost", decidedOn: "2026-11-12", vatReducible: false, fullPartnerCancellation: false });
    expect(r.created).toBe(true);
    const cb = (await o.entries()).filter((e) => e.category === "chargeback_loss");
    expect(cb.map((e) => e.amount).sort()).toEqual(["-4159.00", "-791.00"]);
    expect(cb.every((e) => toMinorForCurrency(e.amount, "JPY") % 100n === 0n)).toBe(true);
    const before = (await o.entries()).length;
    await sync(o, "2026-11-21T10:00:00Z");
    expect((await o.entries()).length).toBe(before);
  });
});

describe("перші продажі після визнання (§3.3 R3)", () => {
  it("угоди не прочитано при визнанні 05.10 (виручка missing) → прочитано 07.10: продаж — дата визнання, is_late_completion", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G.G1B_ORDER).create();
    const snap = emptySnapshot();
    snap.status = { sales: "not_read", transactions: "complete", fees: "complete", refunds: "complete" };
    await env.db.update(orderShopifyFinance).set({ snapshot: snap as unknown as Record<string, unknown> }).where(eq(orderShopifyFinance.orderId, o.orderId));
    await o.advance("2026-10-05T12:00:00Z");
    expect((await o.finance()).componentsParsed.revenue).toMatchObject({ state: "missing" });
    expect((await o.entries()).filter((e) => e.category === "sales_product")).toEqual([]);
    snap.status.sales = "complete";
    await env.db.update(orderShopifyFinance).set({ snapshot: snap as unknown as Record<string, unknown> }).where(eq(orderShopifyFinance.orderId, o.orderId));
    await sync(o, "2026-10-07T10:00:00Z");
    const sale = (await o.entries()).filter((e) => e.category === "sales_product");
    expect(sale.map((e) => [e.amount, e.recognizedOn, e.fxOn, e.isLateCompletion])).toEqual([["100.00", "2026-10-05", "2026-10-01", true]]);
    // Повтор — без нових записів (прапорець не змінює ідентичність факту).
    await sync(o, "2026-10-08T10:00:00Z");
    expect((await o.entries()).filter((e) => e.category === "sales_product")).toHaveLength(1);
  });
});

describe("відкрите замовлення: факти до визнання — прогноз (§3.3, §4)", () => {
  it("G1 запаковано (упаковка оцінена) і рахунок перевізника до передачі → упаковка й доставка forecast, записів немає; після передачі — actual", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G1NR, id: "ord-open", invoiceLines: [{ ...G1NR.invoiceLines[0]!, importedAt: "2026-10-05T09:30:00Z" }] };
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T10:00:00Z");
    const f = await o.finance();
    expect(f.state).toBe("open");
    expect(f.componentsParsed.packaging).toMatchObject({ state: "forecast", basis: "valuation", hasForecast: true });
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "forecast", basis: "invoice", hasForecast: true });
    expect(await o.entries()).toEqual([]);
    const fc = await o.forecasts();
    expect(fc.filter((x) => x.component === "packaging").map((x) => x.amount)).toEqual(["-21.00"]);
    expect(fc.filter((x) => x.component === "shipping_cost").map((x) => x.amount)).toEqual(["-540.00"]);
    await o.advance("2026-10-05T12:00:00Z");
    const g = await o.finance();
    expect(g.componentsParsed.packaging).toMatchObject({ state: "actual", basis: "valuation" });
    expect(g.componentsParsed.shipping_cost).toMatchObject({ state: "actual", basis: "invoice" });
    expect(tuples(await o.entries())).toEqual(tuples(activeEntries(postOrder(ref, "2026-10-05T12:00:00Z").entries)));
  });
});

describe("тестове замовлення excluded (§2.5): справжні витрати лишаються (R5), як у моделі", () => {
  it("G1 без повернення, test → inventory_loss test_order + упаковка −21,00 + доставка −540,00 (дата події / послуги, order_id); виручки й комісій немає", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G1NR, id: "ord-test", test: true, invoiceLines: [{ ...G1NR.invoiceLines[0]!, importedAt: "2026-10-08T09:00:00Z" }] };
    const o = await new GoldenOrder(env, ref).create();
    const at = "2026-10-10T00:00:00Z";
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance(at);
    expect((await o.finance()).state).toBe("excluded");
    const app = await o.entries();
    expect(tuples(app)).toEqual(tuples(activeEntries(postOrder(ref, at).entries)));
    expect(app.map((e) => e.category).sort()).toEqual(["inventory_loss", "inventory_loss", "packaging", "shipping_cost"]);
  });
});

describe("DDP (§2.6, §7.2): мито — окремий складник", () => {
  const ddp: RefOrderFacts = {
    ...G1NR,
    id: "ord-ddp",
    ddp: true,
    invoiceLines: [{ id: "il-ddp-duty", waybillId: "wb-g1", documentId: "inv-duty", chargeType: "customs_duty", amount: "120.00", currency: "UAH", serviceDate: "2026-10-06", importedAt: "2026-10-08T09:00:00Z" }],
  };
  it("лише рядок мита → доставка forecast carrier_reported (не actual), preliminary; записи = модель", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, ddp).create();
    const at = "2026-10-10T00:00:00Z";
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance(at);
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "forecast", basis: "carrier_reported" });
    expect(f.componentsParsed.duties_paid).toMatchObject({ state: "actual", basis: "invoice" });
    expect(f.profitState).toBe("preliminary");
    const model = postOrder(ddp, at);
    expect(tuples(await o.entries())).toEqual(tuples(activeEntries(model.entries)));
    expect(model.order.state).toBe("preliminary");
  });
  it("мито 08.10, перша доставка 10.11 (послуга 07.10) → доставка R3: 05.10, fx 07.10, пізнє завершення; = модель", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = {
      ...ddp,
      invoiceLines: [...ddp.invoiceLines, { id: "il-ddp-del", waybillId: "wb-g1", documentId: "inv-del", chargeType: "delivery", amount: "540.00", currency: "UAH", serviceDate: "2026-10-07", importedAt: "2026-11-10T09:00:00Z" }],
    };
    const o = await new GoldenOrder(env, ref).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-10-10T00:00:00Z", "2026-11-11T00:00:00Z"]) await o.advance(t);
    const ship = (await o.entries()).filter((e) => e.category === "shipping_cost");
    expect(ship.map((e) => [e.amount, e.recognizedOn, e.fxOn, e.isLateCompletion])).toEqual([["-540.00", "2026-10-05", "2026-10-07", true]]);
    expect(tuples(await o.entries())).toEqual(tuples(activeEntries(postOrder(ref, "2026-11-11T00:00:00Z").entries)));
    expect((await o.finance()).profitState).toBe("final");
  });
});

/**
 * Етап 6, WP4 — регресії огляду (чисті правила, без бази):
 *  - chargeback у валюті з 0 знаками (JPY, KRW): нетто / податок — цілими одиницями, та сама функція, що база партнера
 *    WP7 (chargebackNetPart), §5.1 / §8.2;
 *  - RC2 / змінений TransactionFee → комісії `partial (reconciliation_mismatch)`, замовлення не `final` (§16.5, §2.6);
 *  - відкрите замовлення: оцінена упаковка й рахунок до передачі — прогноз, а не «Факт» без записів (§3.3, §4);
 *  - DDP: документ лише з митом не є першою фактичною доставкою — пізніша перша доставка R3, не R2 (§3.3, §7.2);
 *  - перші продажі після визнання з виручкою «немає даних» — R3 «пізнє завершення» (§3.3).
 */
import { describe, expect, it } from "vitest";
import { profitStateOf, type OrderComponents } from "~/modules/finance/core/states";
import { feesComponent, packagingComponent, shippingComponent, type FeesInput, type PackagingInput, type ShippingInput } from "~/modules/order-finance/components";
import { chargebackEntries, invoiceLineEntries, saleEntries, type DisputeFact, type InvoiceLineFact, type PlanContext, type SaleFact } from "~/modules/order-finance/plan";
import { chargebackNetPart } from "~/modules/partners/commission";
import { toMinorForCurrency } from "~/lib/decimal";

const ORDER = "11111111-1111-4111-8111-111111111111";
const ctx = (over: Partial<PlanContext> = {}): PlanContext => ({
  orderId: ORDER,
  storeId: "default",
  state: "recognized",
  recognizedOn: "2026-10-05",
  recognizedAt: new Date("2026-10-05T12:00:00Z"),
  revenueFxOn: "2026-10-05",
  newlyCounted: true,
  countryCode: "DE",
  ...over,
});

const sale = (over: Partial<SaleFact>): SaleFact => ({
  id: "sale-1",
  agreementKind: "order",
  happenedAt: new Date("2026-10-05T07:00:00Z"),
  actionType: "ORDER",
  lineType: "PRODUCT",
  quantity: 1,
  orderLineItemId: null,
  totalAmount: "0.00",
  totalTax: "0.00",
  discountBeforeTax: null,
  currency: "JPY",
  pTotalAmount: "0.00",
  pTotalTax: "0.00",
  pCurrency: "JPY",
  source: "shopify",
  ...over,
});

const dispute = (over: Partial<DisputeFact>): DisputeFact => ({
  id: "d-1",
  version: 1,
  outcome: "lost",
  amount: null,
  recoveredAmount: null,
  currency: "JPY",
  fee: null,
  feeCurrency: null,
  decidedOn: "2026-11-12",
  vatReducible: false,
  source: "manual",
  ...over,
});

const whole = (amount: string, currency: string) => toMinorForCurrency(amount, currency) % 100n === 0n;

describe("chargeback у валюті з 0 знаками (JPY / KRW) — цілими одиницями (§5.1, §8.2)", () => {
  const opts = { shopifyDisputeFee: false, keepBothFeeDisputeIds: new Set<string>() };

  it("JPY: товар 5 950 (податок 950) + доставка 1 000 (податок 160); спір 6 950, повернено 2 000 → нетто / податок у цілих єнах, Σ = 4 950", () => {
    const sales = [sale({ id: "s-p", totalAmount: "5950", totalTax: "950" }), sale({ id: "s-s", lineType: "SHIPPING", totalAmount: "1000", totalTax: "160" })];
    const r = chargebackEntries([dispute({ amount: "6950", recoveredAmount: "2000" })], sales, { ...ctx(), shopCurrency: "JPY" }, opts);
    const amounts = r.entries.map((e) => e.amount);
    expect(r.entries.every((e) => whole(e.amount, "JPY"))).toBe(true);
    expect(amounts.reduce((a, x) => a + toMinorForCurrency(x, "JPY"), 0n)).toBe(-495000n);
    // Та сама частка, що й у бази партнера WP7 (одна функція).
    const p = chargebackNetPart(495000n, 584000n, 111000n, "JPY");
    expect(amounts).toEqual([`-${p.net / 100n}.00`, `-${p.tax / 100n}.00`]);
    expect(amounts).toEqual(["-4159.00", "-791.00"]);
  });

  it("JPY: продаж 1 100 (податок 100), програний спір 1 000 → 909 / 91 (як WP7 chargebackNetPart)", () => {
    const r = chargebackEntries([dispute({ amount: "1000" })], [sale({ totalAmount: "1100", totalTax: "100" })], { ...ctx(), shopCurrency: "JPY" }, opts);
    expect(r.entries.map((e) => [e.category, e.amount, e.currency])).toEqual([
      ["chargeback_loss", "-909.00", "JPY"],
      ["chargeback_loss", "-91.00", "JPY"],
    ]);
  });

  it("KRW: спір 12 345 при нетто 30 000 / податок 3 000 → цілі воні, Σ = втрата", () => {
    const r = chargebackEntries([dispute({ amount: "12345", currency: "KRW" })], [sale({ totalAmount: "33000", totalTax: "3000", currency: "KRW", pCurrency: "KRW" })], { ...ctx(), shopCurrency: "KRW" }, opts);
    expect(r.entries.every((e) => whole(e.amount, "KRW"))).toBe(true);
    expect(r.entries.reduce((a, e) => a + toMinorForCurrency(e.amount, "KRW"), 0n)).toBe(-1234500n);
  });

  it("EUR (2 знаки) не змінився: G10b 49,50 за 58,40 : 11,10 → 41,59 / 7,91", () => {
    const sales = [sale({ id: "s-p", totalAmount: "59.50", totalTax: "9.50", currency: "EUR", pCurrency: "EUR" }), sale({ id: "s-s", lineType: "SHIPPING", totalAmount: "10.00", totalTax: "1.60", currency: "EUR", pCurrency: "EUR" })];
    const r = chargebackEntries([dispute({ amount: "69.50", recoveredAmount: "20.00", currency: "EUR" })], sales, { ...ctx(), shopCurrency: "EUR" }, opts);
    expect(r.entries.map((e) => e.amount)).toEqual(["-41.59", "-7.91"]);
  });
});

describe("RC2 / змінений TransactionFee → комісії partial (reconciliation_mismatch), не final (§16.5)", () => {
  const base: FeesInput = { state: "recognized", shopifyFees: [{ amount: "4.04", currency: "EUR" }], feesComplete: true, shopifyFacts: true, manual: false, covering: null, ownerZero: false, rule: { state: "none" } };
  it("без розбіжності — actual; з відкритою підтвердженою розбіжністю — partial reconciliation_mismatch (basis лишається), прибуток не final", () => {
    expect(feesComponent(base).value).toMatchObject({ state: "actual", basis: "shopify" });
    const r = feesComponent({ ...base, reconciliationPartial: true });
    expect(r.value).toMatchObject({ state: "partial", reason: "reconciliation_mismatch", basis: "shopify", hasForecast: false });
    const settled: NonNullable<OrderComponents["fees"]> = { state: "actual", reason: null, basis: "shopify", hasForecast: false, required: true, actual: [] };
    const comps: OrderComponents = { revenue: settled, cogs: settled, packaging: settled, shipping_cost: settled, fees: { ...r.value, actual: [] } };
    expect(profitStateOf(comps)).toBe("preliminary");
    expect(profitStateOf({ ...comps, fees: settled })).toBe("final");
  });
  it("«без комісії» (zero_confirmed) і ручна комісія теж стають partial; відкрите замовлення — без змін (прогноз)", () => {
    expect(feesComponent({ ...base, shopifyFees: [], ownerZero: true, reconciliationPartial: true }).value).toMatchObject({ state: "partial", reason: "reconciliation_mismatch" });
    expect(feesComponent({ ...base, manual: true, reconciliationPartial: true }).value).toMatchObject({ state: "partial", basis: "manual" });
    expect(feesComponent({ ...base, state: "open", reconciliationPartial: true }).value).toMatchObject({ state: "forecast", hasForecast: true });
  });
});

describe("відкрите замовлення: факти до визнання — прогноз, не «Факт» без записів (§3.3, §4)", () => {
  const pkg: PackagingInput = { state: "open", hasValuedFacts: true, unvaluedUnits: 0, unvaluedForecast: null, manual: false, covering: null, accountedInTotal: false, kitForecast: null, pendingValued: [{ amount: "21.00", currency: "UAH" }] };
  it("упаковка оцінена, замовлення не передано → forecast (basis valuation) з рядком −21,00; після визнання → actual", () => {
    const r = packagingComponent(pkg);
    expect(r.value).toMatchObject({ state: "forecast", basis: "valuation", hasForecast: true });
    expect(r.forecasts).toEqual([{ component: "packaging", currency: "UAH", basis: "valuation", amount: "-21.00" }]);
    expect(packagingComponent({ ...pkg, state: "recognized" }).value).toMatchObject({ state: "actual", basis: "valuation" });
  });
  it("частина одиниць без вартості й без прогнозу → missing no_cost (не «Факт»)", () => {
    expect(packagingComponent({ ...pkg, unvaluedUnits: 1 }).value).toMatchObject({ state: "missing", reason: "no_cost" });
    expect(packagingComponent({ ...pkg, unvaluedUnits: 1, unvaluedForecast: [{ amount: "5.00", currency: "UAH" }] }).forecasts).toEqual([{ component: "packaging", currency: "UAH", basis: "valuation", amount: "-26.00" }]);
  });
  const ship: ShippingInput = {
    state: "open",
    needsShipping: true,
    override: null,
    manual: false,
    covering: null,
    waybills: [{ key: "shipment:a", hasActual: true, payerRecipient: false, forecast: { basis: "carrier_reported", amount: "520.00", currency: "UAH" }, invoiced: [{ amount: "540.00", currency: "UAH" }] }],
    orderForecast: null,
  };
  it("рахунок перевізника до передачі → forecast (basis invoice) −540,00; після визнання → actual без прогнозу", () => {
    const r = shippingComponent(ship);
    expect(r.value).toMatchObject({ state: "forecast", basis: "invoice", hasForecast: true });
    expect(r.forecasts).toEqual([{ component: "shipping_cost", currency: "UAH", basis: "invoice", amount: "-540.00" }]);
    expect(shippingComponent({ ...ship, state: "recognized" })).toMatchObject({ value: { state: "actual", basis: "invoice" }, forecasts: [] });
  });
});

describe("DDP: мито — окремий складник; перша доставка після документа мита — R3 (§3.3, §7.2)", () => {
  const line = (over: Partial<InvoiceLineFact>): InvoiceLineFact => ({
    id: "l",
    invoiceId: "i",
    importedAt: new Date("2026-10-08T09:00:00Z"),
    chargeType: "delivery",
    serviceDate: "2026-10-07",
    amount: "540.00",
    amountExclVat: null,
    currency: "UAH",
    carrierCode: "test",
    shipmentId: "22222222-2222-4222-8222-222222222222",
    externalWaybillId: null,
    matchVersion: 1,
    active: true,
    ...over,
  });
  it("мито 08.10, доставка 10.11 → доставка: дата визнання 05.10, fx 07.10, is_late_completion; мито — R3 свого складника", () => {
    const lines = [line({ id: "duty", chargeType: "customs_duty", amount: "120.00", serviceDate: "2026-10-06" }), line({ id: "del", importedAt: new Date("2026-11-10T09:00:00Z") })];
    const out = invoiceLineEntries(lines, ctx(), { vatPayer: false });
    const del = out.find((e) => e.sourceId === "del")!;
    expect(del).toMatchObject({ category: "shipping_cost", recognizedOn: "2026-10-05", fxOn: "2026-10-07", isLateCompletion: true });
    const duty = out.find((e) => e.sourceId === "duty")!;
    expect(duty).toMatchObject({ category: "duties_paid", recognizedOn: "2026-10-05", fxOn: "2026-10-06", isLateCompletion: true });
  });
  it("друга доставка (новий документ) лишається R2: max(дата послуги, дата визнання)", () => {
    const lines = [line({ id: "a" }), line({ id: "b", importedAt: new Date("2026-11-12T09:00:00Z"), serviceDate: "2026-11-11" })];
    const b = invoiceLineEntries(lines, ctx(), { vatPayer: false }).find((e) => e.sourceId === "b")!;
    expect(b).toMatchObject({ recognizedOn: "2026-11-11", fxOn: "2026-11-11" });
    expect(b.isLateCompletion).toBeUndefined();
  });
});

describe("перші продажі після визнання з виручкою «немає даних» — R3 (§3.3)", () => {
  const s = sale({ totalAmount: "100.00", currency: "EUR", pCurrency: "EUR", happenedAt: new Date("2026-10-01T08:00:00Z") });
  it("визнання без угод (revenueLate) → продаж до визнання: дата визнання, fx за D-25, is_late_completion; при першому визнанні — ні", () => {
    const late = saleEntries([s], ctx({ newlyCounted: false, revenueLate: true, revenueFxOn: "2026-10-01" })).entries[0]!;
    expect(late).toMatchObject({ recognizedOn: "2026-10-05", fxOn: "2026-10-01", isLateCompletion: true });
    const first = saleEntries([s], ctx({ newlyCounted: true, revenueLate: true, revenueFxOn: "2026-10-01" })).entries[0]!;
    expect(first.isLateCompletion).toBeUndefined();
    const known = saleEntries([s], ctx({ newlyCounted: false, revenueLate: false, revenueFxOn: "2026-10-01" })).entries[0]!;
    expect(known.isLateCompletion).toBeUndefined();
  });
});

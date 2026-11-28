/**
 * Етап 6, WP4 — регресії другого раунду огляду (чисті функції):
 *  - chargeback: перенесення дати рішення — сторно + новий запис датою й курсом нової дати (§8.2 R2, F2); нова версія з
 *    тими самими сумами й датами — без змін;
 *  - рахунки `inv:`: інша позначка пізнього завершення (визнане R3 ↔ виключене R5) — інший факт (§2.5, §3.3);
 *  - перший документ накладної — лише діючі або вже проведені рядки (документ, замінений до визнання, не проводився);
 *  - комісії по транзакції (§8.1): оплата з порожнім `fees` поряд з оплатою, що має комісії Shopify, — невідома частина;
 *  - відкрите замовлення: ручна витрата чи частка суми періоду — НЕ «Факт» (записів до визнання немає, §3.3).
 * Усі ідентифікатори й суми вигадані.
 */
import { describe, expect, it } from "vitest";
import { profitStateOf } from "~/modules/finance/core/states";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { feesComponent, packagingComponent, shippingComponent, type FeesInput, type PackagingInput, type ShippingInput } from "~/modules/order-finance/components";
import { diffEntries, type ActiveEntry } from "~/modules/order-finance/diff";
import { invoiceLineEntries, type InvoiceLineFact, type PlanContext } from "~/modules/order-finance/plan";

const entry = (key: string, extra: Partial<EntryInput> = {}): EntryInput => ({
  idempotencyKey: key,
  category: "chargeback_loss",
  amount: "-129.00",
  currency: "EUR",
  recognizedOn: "2026-11-12",
  fxOn: "2026-11-12",
  orderId: "o1",
  sourceType: "chargeback",
  sourceId: "d1",
  ...extra,
});
const active = (id: string, key: string, extra: Partial<ActiveEntry> = {}): ActiveEntry => ({
  id,
  idempotencyKey: key,
  category: "chargeback_loss",
  amount: "-129.00",
  currency: "EUR",
  orderId: "o1",
  originalOn: "2026-11-12",
  fxOn: "2026-11-12",
  ...extra,
});

describe("diffEntries: chargeback — дата рішення редагована (§8.2 R2)", () => {
  it("інша дата рішення (між відкритими місяцями) → сторно старого + новий запис; та сама дата з новою версією → без змін", () => {
    const moved = diffEntries([entry("cb:d1:loss:v2", { recognizedOn: "2026-12-03", fxOn: "2026-12-03" })], [active("a", "cb:d1:loss:v1")]);
    expect(moved).toMatchObject({ keep: [], reverse: ["a"], post: [{ idempotencyKey: "cb:d1:loss:v2", recognizedOn: "2026-12-03", fxOn: "2026-12-03" }] });
    expect(diffEntries([entry("cb:d1:loss:v2")], [active("a", "cb:d1:loss:v1")])).toEqual({ keep: ["a"], reverse: [], post: [] });
  });

  it("у межах місяця змінився лише курс (fx_on 12.11 → 20.11) → новий запис; визнане пізніше (recognized_on = max) — так само", () => {
    expect(diffEntries([entry("cb:d1:fee:v2", { category: "chargeback_fees", amount: "-15.00", recognizedOn: "2026-11-20", fxOn: "2026-11-20" })], [active("a", "cb:d1:fee:v1", { category: "chargeback_fees", amount: "-15.00" })]).reverse).toEqual(["a"]);
    // Рішення до дати визнання (05.10): recognized_on = max(рішення, визнання) не змінюється, змінюється лише курс (fx_on).
    expect(diffEntries([entry("cb:d1:loss:v2", { recognizedOn: "2026-10-05", fxOn: "2026-10-03" })], [active("a", "cb:d1:loss:v1", { originalOn: "2026-10-05", fxOn: "2026-10-01" })]).reverse).toEqual(["a"]);
    // Запис у закритому місяці: recognized_on — дата проведення, original_on — справжня дата: порівнюється original_on.
    expect(diffEntries([entry("cb:d1:loss:v1", { recognizedOn: "2026-10-05", fxOn: "2026-10-02" })], [active("a", "cb:d1:loss:v1", { originalOn: "2026-10-05", fxOn: "2026-10-02" })]).keep).toEqual(["a"]);
  });

  it("продажі угод (`sale:`): позначка пізнього завершення НЕ змінює ідентичність (без повторних проведень)", () => {
    const sale = (lc: boolean) => entry("sale:s1:net", { category: "sales_product", amount: "100.00", recognizedOn: "2026-10-05", fxOn: "2026-10-01", isLateCompletion: lc });
    expect(diffEntries([sale(false)], [active("a", "sale:s1:net", { category: "sales_product", amount: "100.00", originalOn: "2026-10-05", fxOn: "2026-10-01", isLateCompletion: true })]).keep).toEqual(["a"]);
  });
});

describe("diffEntries: рахунок `inv:` — позначка пізнього завершення детермінована (R3 ↔ R5)", () => {
  const inv = (lc: boolean) => entry("inv:l1:m1", { category: "shipping_cost", amount: "-540.00", currency: "UAH", recognizedOn: "2026-10-05", fxOn: "2026-10-05", sourceType: "invoice_line", isLateCompletion: lc });
  const act = (lc: boolean) => active("a", "inv:l1:m1", { category: "shipping_cost", amount: "-540.00", currency: "UAH", originalOn: "2026-10-05", fxOn: "2026-10-05", isLateCompletion: lc });
  it("та сама дата послуги й визнання, інша позначка → сторно + новий запис; та сама позначка → без змін", () => {
    expect(diffEntries([inv(true)], [act(false)])).toMatchObject({ keep: [], reverse: ["a"], post: [{ isLateCompletion: true }] });
    expect(diffEntries([inv(false)], [act(true)]).reverse).toEqual(["a"]);
    expect(diffEntries([inv(true)], [act(true)])).toEqual({ keep: ["a"], reverse: [], post: [] });
    expect(diffEntries([entry("inv:l1:m1", { category: "shipping_cost", amount: "-540.00", currency: "UAH", recognizedOn: "2026-10-05", fxOn: "2026-10-05" })], [act(false)]).keep).toEqual(["a"]);
  });
});

describe("invoiceLineEntries: перший документ накладної — лише діючі або проведені рядки (§3.3 R3)", () => {
  const ctx: PlanContext = {
    orderId: "o1",
    storeId: "s",
    state: "recognized",
    recognizedOn: "2026-10-31",
    recognizedAt: new Date("2026-10-31T10:00:00Z"),
    revenueFxOn: "2026-10-05",
    newlyCounted: false,
    countryCode: "DE",
  };
  const line = (id: string, extra: Partial<InvoiceLineFact>): InvoiceLineFact => ({
    id,
    invoiceId: `doc-${id}`,
    importedAt: new Date("2026-11-05T09:00:00Z"),
    chargeType: "delivery",
    serviceDate: "2026-11-02",
    amount: "530.00",
    amountExclVat: null,
    currency: "UAH",
    carrierCode: "test",
    shipmentId: "sh1",
    externalWaybillId: null,
    matchVersion: 1,
    active: true,
    ...extra,
  });
  const v1 = line("v1", { importedAt: new Date("2026-10-30T08:00:00Z"), serviceDate: "2026-10-29", amount: "540.00", active: false });
  it("v1 замінено ДО визнання (ніколи не проводився) → v2 — перший документ: R3 (дата визнання, fx — дата послуги, is_late_completion)", () => {
    const [e] = invoiceLineEntries([v1, line("v2", {})], ctx, { vatPayer: false });
    expect(e).toMatchObject({ idempotencyKey: "inv:v2:m1", amount: "-530.00", recognizedOn: "2026-10-31", fxOn: "2026-11-02", isLateCompletion: true });
  });
  it("v1 проводився (замінено ПІСЛЯ визнання, запис сторновано) → v2 — нова версія: R2 (max(послуга, визнання))", () => {
    const [e] = invoiceLineEntries([{ ...v1, posted: true }, line("v2", {})], ctx, { vatPayer: false });
    expect(e).toMatchObject({ idempotencyKey: "inv:v2:m1", recognizedOn: "2026-11-02", fxOn: "2026-11-02" });
    expect(e!.isLateCompletion).toBeUndefined();
  });
});

describe("feesComponent: комісії по транзакції (§8.1 «порожній fees — немає даних, НІКОЛИ не 0»)", () => {
  const base: FeesInput = {
    state: "recognized",
    shopifyFees: [{ amount: "2.50", currency: "EUR" }],
    feesComplete: true,
    shopifyFacts: true,
    manual: false,
    covering: null,
    ownerZero: false,
    rule: { state: "none" },
    knownFees: true,
    uncoveredPayments: 1,
  };
  it("Shopify Payments (комісія 2,50) + PayPal без комісій, правило 3 % → partial з прогнозом −1,50 (не «Факт»), preliminary", () => {
    const r = feesComponent({ ...base, rule: { state: "forecast", lines: [{ amount: "1.50", currency: "EUR" }] } });
    expect(r.value).toMatchObject({ state: "partial", reason: "no_fee_data", hasForecast: true, basis: "fee_rule" });
    expect(r.forecasts).toEqual([{ component: "fees", amount: "-1.50", currency: "EUR", basis: "fee_rule" }]);
    expect(profitStateOf({ fees: { ...r.value, actual: [] } })).toBe("preliminary");
  });
  it("без правила для оплати без комісій → partial без прогнозу → incomplete (невідоме не стає 0)", () => {
    const r = feesComponent(base);
    expect(r.value).toMatchObject({ state: "partial", reason: "no_fee_data", hasForecast: false });
    expect(r.forecasts).toEqual([]);
    expect(profitStateOf({ fees: { ...r.value, actual: [] } })).toBe("incomplete");
  });
  it("правило «без комісії» для решти / позначка власника «Шлюз без комісії» / усі оплати з комісіями → actual (Shopify)", () => {
    expect(feesComponent({ ...base, rule: { state: "zero_confirmed" } }).value).toMatchObject({ state: "actual", basis: "shopify" });
    expect(feesComponent({ ...base, ownerZero: true }).value).toMatchObject({ state: "actual", basis: "shopify" });
    expect(feesComponent({ ...base, uncoveredPayments: 0 }).value).toMatchObject({ state: "actual", basis: "shopify" });
    // Типові значення (без полів по транзакції) — як раніше: є комісії Shopify → actual.
    const { knownFees: _k, uncoveredPayments: _u, ...legacy } = base;
    expect(feesComponent(legacy).value).toMatchObject({ state: "actual", basis: "shopify" });
  });
  it("відкрите змішане: прогноз = комісії Shopify + правило; без правила — missing", () => {
    const r = feesComponent({ ...base, state: "open", rule: { state: "forecast", lines: [{ amount: "1.50", currency: "EUR" }] } });
    expect(r.value).toMatchObject({ state: "forecast", hasForecast: true });
    expect(r.forecasts.map((f) => [f.amount, f.basis])).toEqual([
      ["-2.50", "shopify"],
      ["-1.50", "fee_rule"],
    ]);
    expect(feesComponent({ ...base, state: "open" }).value).toMatchObject({ state: "missing", reason: "no_fee_data" });
  });
  it("сума періоду ще не розподілена на замовлення (I16) → missing awaiting_reallocation, прогноз-вага не рахується", () => {
    const r = feesComponent({ ...base, covering: "awaiting_reallocation", rule: { state: "forecast", lines: [{ amount: "1.50", currency: "EUR" }] } });
    expect(r.value).toMatchObject({ state: "missing", reason: "awaiting_reallocation", hasForecast: false });
  });
});

describe("відкрите замовлення (§3.3): ручна витрата й частка суми періоду — не «Факт» без записів", () => {
  const ship: ShippingInput = { state: "open", needsShipping: true, override: null, manual: false, covering: null, waybills: [], orderForecast: { basis: "owner_table", amount: "500.00", currency: "UAH" } };
  const fees: FeesInput = { state: "open", shopifyFees: [], feesComplete: true, shopifyFacts: true, manual: false, covering: null, ownerZero: false, rule: { state: "forecast", lines: [{ amount: "1.00", currency: "EUR" }] } };
  const pack: PackagingInput = { state: "open", hasValuedFacts: false, unvaluedUnits: 0, unvaluedForecast: null, manual: false, covering: null, accountedInTotal: false, kitForecast: [{ amount: "12.00", currency: "UAH" }] };
  const pending = [{ amount: "300.00", currency: "UAH" }];
  it("ручна витрата (доставка / комісія / упаковка) → forecast з основою manual, рядок — відома сума; визнане — actual manual", () => {
    expect(shippingComponent({ ...ship, manual: true, pendingManual: pending })).toEqual({
      value: expect.objectContaining({ state: "forecast", basis: "manual", hasForecast: true }),
      forecasts: [{ component: "shipping_cost", amount: "-300.00", currency: "UAH", basis: "manual" }],
    });
    expect(feesComponent({ ...fees, manual: true, pendingManual: [{ amount: "2.00", currency: "EUR" }] }).value).toMatchObject({ state: "forecast", basis: "manual" });
    expect(packagingComponent({ ...pack, manual: true, pendingManual: [{ amount: "15.00", currency: "UAH" }] }).forecasts).toEqual([{ component: "packaging", amount: "-15.00", currency: "UAH", basis: "manual" }]);
    expect(shippingComponent({ ...ship, state: "recognized", manual: true }).value).toMatchObject({ state: "actual", basis: "manual" });
    // Сума ручної витрати невідома (валюта, що не проводиться) → «немає даних», не 0.
    expect(shippingComponent({ ...ship, manual: true, pendingManual: [] }).value).toMatchObject({ state: "missing", reason: "no_invoice" });
  });
  it("частка суми періоду (allocated) → forecast з основою allocated, прогноз — вага розподілу, у «≈ Прогноз» не входить; визнане — actual", () => {
    for (const r of [shippingComponent({ ...ship, covering: "allocated" }), feesComponent({ ...fees, covering: "allocated" }), packagingComponent({ ...pack, covering: "allocated" })]) {
      expect(r.value).toMatchObject({ state: "forecast", basis: "allocated", hasForecast: false });
      expect(r.forecasts.length).toBe(1);
    }
    expect(feesComponent({ ...fees, state: "recognized", covering: "allocated" }).value).toMatchObject({ state: "actual", basis: "allocated" });
  });
  it("оцінена упаковка + ручна витрата упаковки → прогноз обох (основа valuation), не actual", () => {
    const r = packagingComponent({ ...pack, hasValuedFacts: true, pendingValued: [{ amount: "21.00", currency: "UAH" }], manual: true, pendingManual: [{ amount: "15.00", currency: "UAH" }] });
    expect(r.value).toMatchObject({ state: "forecast", basis: "valuation" });
    expect(r.forecasts).toEqual([{ component: "packaging", amount: "-36.00", currency: "UAH", basis: "valuation" }]);
  });
  it("жодна комбінація ручної / частки / оцінених фактів відкритого замовлення не дає state actual", () => {
    for (const manual of [false, true])
      for (const covering of [null, "allocated", "awaiting_reallocation"] as const)
        for (const hasValuedFacts of [false, true]) {
          const states = [
            shippingComponent({ ...ship, manual, covering, pendingManual: pending }).value.state,
            feesComponent({ ...fees, manual, covering, pendingManual: pending }).value.state,
            packagingComponent({ ...pack, manual, covering, hasValuedFacts, pendingValued: hasValuedFacts ? pending : [], pendingManual: pending }).value.state,
          ];
          expect(states.filter((s) => s === "actual")).toEqual([]);
        }
  });
});

/**
 * Етап 6, WP4: чисті правила фінансів замовлення (без бази) — правила «МАЄ / НІКОЛИ» docs/stage6-design.md:
 * визнання (§3.2: пріоритет доказів, одна дата назавжди, дата Києва, тестові, скасовані), дата курсу виручки (D-25),
 * різниця бажаних і діючих записів (F2/F6: заморожені родини, покоління ключів), складники (§2.6: факт замінює прогноз,
 * I16 — прогноз-вага не рахується, «Оцінка» виручки ніколи не в прибутку), прибуток картки (I4, «немає даних» — ніколи
 * 0), позначки власника (zod), параметри списку.
 */
import { describe, expect, it } from "vitest";
import { ratePerUnitScaled } from "~/lib/decimal";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { cardAmount, cardProfit, cardRows } from "~/modules/order-finance/card";
import { feesComponent, isForecastCounted, shippingComponent, type ShippingInput } from "~/modules/order-finance/components";
import { baseKeyOf, diffEntries, type ActiveEntry } from "~/modules/order-finance/diff";
import { orderFinanceListParamsOf, orderFinancePageHref } from "~/modules/order-finance/list-params";
import { isFlagOverride, parseOrderOverrides, shippingOverrideOf } from "~/modules/order-finance/overrides";
import { paymentDateOf, recognizeOrder, recognitionEvidence, revenueFxDateOf } from "~/modules/order-finance/recognition";

const d = (iso: string) => new Date(iso);

describe("recognition (§3.2)", () => {
  const base = { handoverAt: null, consumeAt: null, placedAt: d("2026-10-01T08:00:00Z") };

  it("evidence priority: handover → consume_sale → placed_at (fallback); not shipped → none", () => {
    expect(recognitionEvidence("delivered", { ...base, handoverAt: d("2026-10-05T12:00:00Z"), consumeAt: d("2026-10-04T12:00:00Z") })).toEqual({ at: d("2026-10-05T12:00:00Z"), basis: "handover" });
    expect(recognitionEvidence("in_transit", { ...base, consumeAt: d("2026-10-04T12:00:00Z") })).toEqual({ at: d("2026-10-04T12:00:00Z"), basis: "consume" });
    expect(recognitionEvidence("delivered", base)).toEqual({ at: base.placedAt, basis: "placed_fallback" });
    expect(recognitionEvidence("packed", { ...base, handoverAt: d("2026-10-05T12:00:00Z") })).toBeNull();
    expect(recognitionEvidence("paid", base)).toBeNull();
  });

  it("the date is the Kyiv date of the evidence (30.10 23:30 UTC = 31.10)", () => {
    const r = recognizeOrder({ ...base, status: "delivered", handoverAt: d("2026-10-30T23:30:00Z"), test: false, includeTestOrders: false, fullyRefunded: false, existing: null });
    expect(r).toMatchObject({ state: "recognized", recognizedOn: "2026-10-31", basis: "handover" });
  });

  it("recognized_on is set once: a later (earlier-dated) evidence never moves it", () => {
    const r = recognizeOrder({
      ...base,
      status: "delivered",
      handoverAt: d("2026-09-01T10:00:00Z"),
      test: false,
      includeTestOrders: false,
      fullyRefunded: false,
      existing: { recognizedOn: "2026-10-05", recognizedAt: d("2026-10-05T12:00:00Z"), basis: "consume" },
    });
    expect(r).toMatchObject({ recognizedOn: "2026-10-05", basis: "consume", state: "recognized" });
  });

  it("test orders: excluded unless includeTestOrders; cancelled / fully refunded before shipping → closed_unrecognized; else open", () => {
    const common = { ...base, test: false, includeTestOrders: false, fullyRefunded: false, existing: null } as const;
    expect(recognizeOrder({ ...common, status: "delivered", test: true }).state).toBe("excluded");
    expect(recognizeOrder({ ...common, status: "delivered", test: true, includeTestOrders: true }).state).toBe("recognized");
    expect(recognizeOrder({ ...common, status: "cancelled" }).state).toBe("closed_unrecognized");
    expect(recognizeOrder({ ...common, status: "paid", fullyRefunded: true }).state).toBe("closed_unrecognized");
    expect(recognizeOrder({ ...common, status: "paid" })).toEqual({ state: "open", recognizedOn: null, recognizedAt: null, basis: null });
  });

  it("payment date (D-25): first SUCCESS SALE/CAPTURE that is not a test; otherwise placed_at; policy picks the revenue fx date", () => {
    const placed = d("2026-10-01T08:00:00Z");
    const tx = [
      { kind: "AUTHORIZATION", status: "SUCCESS", test: false, processedAt: d("2026-09-30T08:00:00Z") },
      { kind: "SALE", status: "FAILURE", test: false, processedAt: d("2026-09-30T09:00:00Z") },
      { kind: "SALE", status: "SUCCESS", test: true, processedAt: d("2026-09-30T10:00:00Z") },
      { kind: "CAPTURE", status: "SUCCESS", test: false, processedAt: d("2026-10-02T21:30:00Z") },
    ];
    expect(paymentDateOf(tx, placed)).toBe("2026-10-03");
    expect(paymentDateOf([], placed)).toBe("2026-10-01");
    expect(revenueFxDateOf("payment_date", "2026-10-01", "2026-10-05")).toBe("2026-10-01");
    expect(revenueFxDateOf("recognition_date", "2026-10-01", "2026-10-05")).toBe("2026-10-05");
    expect(revenueFxDateOf("recognition_date", "2026-10-01", null)).toBe("2026-10-01");
  });
});

describe("diffEntries (F2 / F6: desired state vs active entries)", () => {
  const entry = (key: string, extra: Partial<EntryInput> = {}): EntryInput => ({
    idempotencyKey: key,
    category: "sales_product",
    amount: "10.00",
    currency: "EUR",
    recognizedOn: "2026-10-05",
    fxOn: "2026-10-05",
    orderId: "o1",
    sourceType: "shopify_sale",
    sourceId: "s1",
    ...extra,
  });
  const active = (id: string, key: string, extra: Partial<ActiveEntry> = {}): ActiveEntry => ({
    id,
    idempotencyKey: key,
    category: "sales_product",
    amount: "10.00",
    currency: "EUR",
    orderId: "o1",
    originalOn: "2026-10-05",
    fxOn: "2026-10-05",
    ...extra,
  });

  it("an unchanged fact is kept (also under a generation suffix :g1); nothing is posted twice (I3)", () => {
    expect(baseKeyOf("sale:s1:net:g2")).toBe("sale:s1:net");
    const r = diffEntries([entry("sale:s1:net")], [active("a", "sale:s1:net:g1")]);
    expect(r).toEqual({ keep: ["a"], reverse: [], post: [] });
  });

  it("a changed amount or category → reverse + post; a fact that disappeared → reverse only", () => {
    expect(diffEntries([entry("sale:s1:net", { amount: "12.00" })], [active("a", "sale:s1:net")])).toMatchObject({ keep: [], reverse: ["a"], post: [{ idempotencyKey: "sale:s1:net" }] });
    expect(diffEntries([entry("sale:s1:net", { category: "sales_other" })], [active("a", "sale:s1:net")])).toMatchObject({ reverse: ["a"] });
    expect(diffEntries([], [active("a", "sale:s1:net")])).toEqual({ keep: [], reverse: ["a"], post: [] });
  });

  it("dated families: a moved original date re-posts (inventory dates moved); invoice lines keep their frozen amount (VAT setting at posting)", () => {
    expect(diffEntries([entry("cogs:v1", { category: "cogs", amount: "-400.00", currency: "UAH", recognizedOn: "2026-10-06" })], [active("a", "cogs:v1", { category: "cogs", amount: "-400.00", currency: "UAH" })]).reverse).toEqual(["a"]);
    const inv = diffEntries(
      [entry("inv:l1:m1", { category: "shipping_cost", amount: "-450.00", currency: "UAH" })],
      [active("a", "inv:l1:m1", { category: "shipping_cost", amount: "-540.00", currency: "UAH" })],
    );
    expect(inv).toEqual({ keep: ["a"], reverse: [], post: [] });
  });

  it("versioned facts (chargeback cb:…:v<n>, standard COGS stdcogs:…:v<n>) are compared without the version", () => {
    expect(diffEntries([entry("cb:d1:loss:v2", { category: "chargeback_loss", amount: "-129.00" })], [active("a", "cb:d1:loss:v1", { category: "chargeback_loss", amount: "-129.00" })]).keep).toEqual(["a"]);
    expect(diffEntries([entry("stdcogs:l1:v2", { category: "cogs", amount: "-999.00", currency: "UAH" })], [active("a", "stdcogs:l1:v1", { category: "cogs", amount: "-210.00", currency: "UAH" })]).keep).toEqual(["a"]);
  });
});

describe("components (§2.6): fact replaces forecast; I16; revenue estimate never counts", () => {
  const ship = (extra: Partial<ShippingInput>): ShippingInput => ({
    state: "recognized",
    needsShipping: true,
    override: null,
    manual: false,
    covering: null,
    waybills: [{ key: "s1", hasActual: false, payerRecipient: false, forecast: { basis: "carrier_reported", amount: "520.00", currency: "UAH" } }],
    orderForecast: null,
    ...extra,
  });

  it("shipping: forecast → counted; invoice → actual (no forecast rows); recipient pays → n/a; no shippable lines → n/a", () => {
    const f = shippingComponent(ship({}));
    expect(f.value).toMatchObject({ state: "forecast", hasForecast: true, basis: "carrier_reported" });
    expect(f.forecasts).toEqual([{ component: "shipping_cost", amount: "-520.00", currency: "UAH", basis: "carrier_reported" }]);
    expect(isForecastCounted("shipping_cost", f.value)).toBe(true);
    const a = shippingComponent(ship({ waybills: [{ key: "s1", hasActual: true, payerRecipient: false, forecast: { basis: "carrier_reported", amount: "520.00", currency: "UAH" } }] }));
    expect(a).toEqual({ value: expect.objectContaining({ state: "actual", basis: "invoice" }), forecasts: [] });
    expect(shippingComponent(ship({ override: "recipient_pays" })).value).toMatchObject({ state: "not_applicable", reason: "recipient_pays" });
    expect(shippingComponent(ship({ needsShipping: false })).value).toMatchObject({ state: "not_applicable", reason: "no_shippable_lines" });
  });

  it("shipping without waybill and without forecast → missing no_waybill (never 0); owner table → missing with a counted forecast", () => {
    expect(shippingComponent(ship({ waybills: [], orderForecast: null })).value).toMatchObject({ state: "missing", reason: "no_waybill", hasForecast: false });
    const t = shippingComponent(ship({ waybills: [], orderForecast: { basis: "owner_table", amount: "300.00", currency: "UAH" } }));
    expect(t.value).toMatchObject({ state: "missing", reason: "no_waybill", hasForecast: true, basis: "owner_table" });
    expect(isForecastCounted("shipping_cost", t.value)).toBe(true);
  });

  it("I16: awaiting reallocation → missing (forecast kept as a weight but NOT counted); allocated → actual (weights kept, not counted)", () => {
    const w = shippingComponent(ship({ covering: "awaiting_reallocation" }));
    expect(w.value).toMatchObject({ state: "missing", reason: "awaiting_reallocation", hasForecast: false });
    expect(w.forecasts).toHaveLength(1);
    expect(isForecastCounted("shipping_cost", w.value)).toBe(false);
    const al = shippingComponent(ship({ covering: "allocated" }));
    expect(al.value).toMatchObject({ state: "actual", basis: "allocated" });
    expect(isForecastCounted("shipping_cost", al.value)).toBe(false);
  });

  it("fees: Shopify fees complete → actual; incomplete → partial awaiting_shopify; rule «no fees» → zero_confirmed; nothing → missing", () => {
    const fee = { state: "recognized" as const, shopifyFees: [], feesComplete: true, shopifyFacts: true, manual: false, covering: null, ownerZero: false, rule: { state: "none" as const } };
    expect(feesComponent({ ...fee, shopifyFees: [{ amount: "-4.04", currency: "EUR" }] }).value).toMatchObject({ state: "actual", basis: "shopify" });
    expect(feesComponent({ ...fee, shopifyFees: [{ amount: "-4.04", currency: "EUR" }], feesComplete: false }).value).toMatchObject({ state: "partial", reason: "awaiting_shopify" });
    expect(feesComponent({ ...fee, rule: { state: "zero_confirmed" } }).value).toMatchObject({ state: "zero_confirmed", reason: "fee_rule_no_fees" });
    expect(feesComponent({ ...fee, shopifyFacts: false }).value).toMatchObject({ state: "missing", reason: "no_fee_data" });
    expect(feesComponent({ ...fee, state: "excluded" }).value).toMatchObject({ state: "not_applicable", required: false });
  });

  it("the revenue estimate («Оцінка») is never counted in profit", () => {
    expect(isForecastCounted("revenue", { state: "forecast", hasForecast: true })).toBe(false);
    expect(isForecastCounted("fees", null)).toBe(false);
  });
});

describe("card (I4): profit = Σ entries (each at its own rate) + counted forecasts; no data → hidden, never 0", () => {
  const RATES: Record<string, string> = { "EUR|2026-10-05": "48.5000", "EUR|2026-11-04": "48.8000" };
  const rateOf = (c: string, on: string) => (RATES[`${c}|${on}`] ? ratePerUnitScaled(RATES[`${c}|${on}`]!, 1) : null);
  const entries = [
    { category: "sales_product", amount: "117.00", currency: "EUR", fxOn: "2026-10-05" },
    { category: "refund_product", amount: "-45.00", currency: "EUR", fxOn: "2026-11-04" },
    { category: "cogs", amount: "-1050.00", currency: "UAH", fxOn: "2026-10-05" },
    { category: "tax_collected_memo", amount: "9.50", currency: "EUR", fxOn: "2026-10-05" },
  ];

  it("cardAmount converts each entry at its own fx date; missing rate → reported unconverted, not 0", () => {
    const a = cardAmount([entries[0]!, entries[1]!], "UAH", rateOf);
    expect(a.converted).toBe("3478.50"); // 117 × 48,50 − 45 × 48,80
    const b = cardAmount([{ amount: "10.00", currency: "EUR", fxOn: "2026-12-01" }], "UAH", rateOf);
    expect(b.converted).toBeNull();
    expect(b.unconverted).toEqual([{ currency: "EUR", amount: "10.00", entries: 1 }]);
  });

  it("rows: net products = sold + returned; memo tax is not revenue", () => {
    const r = cardRows(entries, "UAH", rateOf);
    expect(r.products.net.original).toEqual([{ amount: "72.00", currency: "EUR" }]);
    expect(r.products.sold.original).toEqual([{ amount: "117.00", currency: "EUR" }]);
    expect(r.products.returned.original).toEqual([{ amount: "-45.00", currency: "EUR" }]);
    expect(r.taxCollected.original).toEqual([{ amount: "9.50", currency: "EUR" }]);
    expect(r.netRevenue.converted).toBe("3478.50");
  });

  it("final → «Факт» Σ entries; preliminary → «≈ Прогноз» adds counted forecasts (never the revenue estimate); incomplete → hidden; open → n/a", () => {
    const common = { orderState: "recognized" as const, entries, missing: [], currency: "UAH", rateOf };
    expect(cardProfit({ ...common, profitState: "final", forecasts: [] })).toMatchObject({ kind: "fact", value: "2428.50" });
    const fc = [
      { component: "shipping_cost" as const, amount: "-520.00", currency: "UAH", fxOn: "2026-10-05", basis: "carrier_reported" },
      { component: "revenue" as const, amount: "999.00", currency: "UAH", fxOn: "2026-10-05", basis: "order_snapshot" },
    ];
    expect(cardProfit({ ...common, profitState: "preliminary", forecasts: fc })).toMatchObject({ kind: "forecast", value: "1908.50", margin: "54.9" });
    const hidden = cardProfit({ ...common, profitState: "incomplete", forecasts: fc, missing: [{ component: "cogs", reason: "no_cost" }] });
    expect(hidden).toMatchObject({ kind: "hidden", value: null, margin: null, missing: [{ component: "cogs", reason: "no_cost" }] });
    expect(cardProfit({ ...common, orderState: "open", profitState: "n/a", forecasts: fc })).toMatchObject({ kind: "not_applicable", value: null });
  });
});

describe("owner overrides (zod) and list params", () => {
  it("unknown or malformed overrides are dropped; recipient_pays and no_shipping_cost map to the shipping component", () => {
    expect(parseOrderOverrides(null)).toEqual({});
    expect(parseOrderOverrides({ recipient_pays: { at: "x" } })).toEqual({});
    const o = parseOrderOverrides({ no_shipping_cost: { at: "2026-10-01T00:00:00Z", by: "owner" } });
    expect(shippingOverrideOf(o)).toBe("no_shipping_cost");
    expect(isFlagOverride("fees_zero_confirmed")).toBe(true);
    expect(isFlagOverride("confirmed_amounts")).toBe(false);
  });

  it("list params: defaults, validation of every value, pagination keeps the other params", () => {
    const p = orderFinanceListParamsOf(new URLSearchParams("q=%20%231001%20&state=final&country=de&partner=nope&review=1&loss=1&sort=profit_asc&page=3&currency=eur"), "2026-11-28");
    expect(p.preset).toBe("last30");
    expect(p.filter).toMatchObject({ q: "#1001", state: "final", country: "DE", partnerId: null, needsReview: true, lossOnly: true, sort: "profit_asc", page: 3, currency: "EUR" });
    const bad = orderFinanceListParamsOf(new URLSearchParams("period=custom&from=2026-11-10&to=2026-11-01&state=x&sort=y&page=-1"), "2026-11-28");
    expect(bad.preset).toBe("last30");
    expect(bad.filter).toMatchObject({ state: null, sort: "recognized_desc", page: 1 });
    expect(orderFinancePageHref("/demo/finance/orders", "?state=final&page=2", 3)).toBe("/demo/finance/orders?state=final&page=3");
    expect(orderFinancePageHref("/demo/finance/orders", "?page=2", 1)).toBe("/demo/finance/orders");
  });
});

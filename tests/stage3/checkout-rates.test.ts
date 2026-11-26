import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseHandle } from "~/db/client.server";
import { products, productVariants, settings, settingsHistory } from "~/db/schema";
import { ForbiddenError } from "~/domain/permissions";
import { createCarrierRegistry } from "~/integrations/carriers/registry";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierCallOptions,
  type RateQuote,
  type RateRequest,
} from "~/integrations/carriers/types";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { logger } from "~/lib/logger.server";
import {
  CHECKOUT_RATES_CACHE_TTL_MS,
  checkoutRatesCacheSize,
  clearCheckoutRatesCache,
  computeCheckoutRates,
  parseRateRequest,
  previewCheckoutRates,
  shopifyServiceCode,
  shopifyTotalPrice,
  type ShopifyRateRequest,
} from "~/modules/rates/checkout-rates.server";
import {
  applyRounding,
  conversionFactor,
  currencyMinorDigits,
  markupFixedToCents,
  markupPercentToBasisPoints,
  parseDecimal,
  priceCheckoutRate,
  subunitsToDecimal,
  type PricingSettings,
} from "~/modules/rates/pricing";
import { DEFAULT_SETTINGS, type AllSettings } from "~/modules/settings/schema";
import { updateSetting } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, STAFF, openTestDatabase } from "../helpers";

// ---------------------------------------------------------------------------
// pricing.ts
// ---------------------------------------------------------------------------

const P = (over: Partial<PricingSettings> = {}): PricingSettings => ({
  markupPercent: 0,
  markupFixed: "0.00",
  rounding: "none",
  fxRates: [],
  ...over,
});

const price = (amount: string, currency = "UAH") => ({ amount, currency });

function ok(result: ReturnType<typeof priceCheckoutRate>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
  return result.price;
}

describe("pricing: conversion", () => {
  it("same currency → no conversion, no rate needed", () => {
    const p = ok(priceCheckoutRate(price("100.00"), "UAH", P()));
    expect(p).toMatchObject({ currency: "UAH", cents: 10000n, amount: "100.00", convertedAmount: "100.00" });
  });

  it("divides by the rate (carrier units per 1 target unit) and rounds UP to cents", () => {
    const p = ok(priceCheckoutRate(price("910"), "EUR", P({ fxRates: [{ currency: "EUR", rate: "41.5" }] })));
    // 910 / 41.5 = 21.9277… → 21.93
    expect(p.cents).toBe(2193n);
    expect(p.amount).toBe("21.93");
  });

  it("rate with 6 decimals is exact", () => {
    const p = ok(priceCheckoutRate(price("1000"), "EUR", P({ fxRates: [{ currency: "EUR", rate: "41.123456" }] })));
    // 1000 / 41.123456 = 24.31699… → 24.32
    expect(p.cents).toBe(2432n);
  });

  it("never undercharges: 1 UAH at rate 3 → 0.34, not 0.33", () => {
    expect(ok(priceCheckoutRate(price("1"), "EUR", P({ fxRates: [{ currency: "EUR", rate: "3" }] }))).cents).toBe(34n);
  });

  it("missing rate or zero rate → no_fx_rate", () => {
    expect(priceCheckoutRate(price("10"), "USD", P({ fxRates: [{ currency: "EUR", rate: "41" }] }))).toEqual({ ok: false, reason: "no_fx_rate" });
    expect(priceCheckoutRate(price("10"), "USD", P({ fxRates: [{ currency: "USD", rate: "0.000000" }] }))).toEqual({
      ok: false,
      reason: "no_fx_rate",
    });
  });

  it("currency codes are case-insensitive", () => {
    const p = ok(priceCheckoutRate(price("83", "uah"), "eur", P({ fxRates: [{ currency: "eur", rate: "41.5" }] })));
    expect(p).toMatchObject({ currency: "EUR", cents: 200n });
  });

  it("cross rate via the base currency of the FX table", () => {
    const fxRates = [
      { currency: "EUR", rate: "45" },
      { currency: "USD", rate: "41.5" },
    ];
    // 10 EUR × 45 UAH/EUR ÷ 41.5 UAH/USD = 10.843… → 10.85
    expect(ok(priceCheckoutRate(price("10", "EUR"), "USD", P({ fxRates }), { fxBaseCurrency: "UAH" })).cents).toBe(1085n);
    // quote in base currency
    expect(ok(priceCheckoutRate(price("83"), "USD", P({ fxRates }), { fxBaseCurrency: "UAH" })).cents).toBe(200n);
    // quote currency neither base nor in the table → cannot price
    expect(priceCheckoutRate(price("10", "PLN"), "USD", P({ fxRates }), { fxBaseCurrency: "UAH" })).toEqual({
      ok: false,
      reason: "no_fx_rate",
    });
    expect(conversionFactor("EUR", "EUR", [], "UAH")).toEqual({ num: 1n, den: 1n });
  });

  it("invalid carrier price → invalid_price", () => {
    for (const bad of ["abc", "-5", "1e3", "", "1.2.3", " 1 0"]) {
      expect(priceCheckoutRate(price(bad), "UAH", P())).toEqual({ ok: false, reason: "invalid_price" });
    }
  });

  it("3-decimal and malformed currencies are not supported", () => {
    expect(priceCheckoutRate(price("10"), "KWD", P({ fxRates: [{ currency: "KWD", rate: "130" }] }))).toEqual({
      ok: false,
      reason: "unsupported_currency",
    });
    expect(priceCheckoutRate(price("10"), "EURO", P())).toEqual({ ok: false, reason: "unsupported_currency" });
  });

  it("zero-decimal currency: whole units, total = amount × 100", () => {
    const p = ok(priceCheckoutRate(price("910"), "JPY", P({ fxRates: [{ currency: "JPY", rate: "0.27" }] })));
    // 910 / 0.27 = 3370.37 → 3371 JPY → 337100
    expect(p.cents).toBe(337100n);
    expect(shopifyTotalPrice(p.cents)).toBe("337100");
    // X.99 is meaningless for JPY → whole unit
    const p99 = ok(priceCheckoutRate(price("910"), "JPY", P({ rounding: "up_99", fxRates: [{ currency: "JPY", rate: "0.27" }] })));
    expect(p99.cents).toBe(337100n);
  });

  it("big values stay exact (BigInt)", () => {
    const p = ok(priceCheckoutRate(price("999999999999.99"), "EUR", P({ fxRates: [{ currency: "EUR", rate: "0.000001" }] })));
    expect(p.cents).toBe(99999999999999000000n);
    expect(shopifyTotalPrice(p.cents)).toBe("99999999999999000000");
  });

  it("zero price stays zero for every rounding mode", () => {
    for (const rounding of ["none", "up_whole", "up_99"] as const) {
      expect(ok(priceCheckoutRate(price("0"), "UAH", P({ rounding }))).cents).toBe(0n);
    }
  });
});

describe("pricing: markup and rounding", () => {
  it("percent markup then fixed markup", () => {
    expect(ok(priceCheckoutRate(price("100"), "UAH", P({ markupPercent: 12.5 }))).amount).toBe("112.50");
    // 10.00 × 1.1 + 2.50
    expect(ok(priceCheckoutRate(price("10"), "UAH", P({ markupPercent: 10, markupFixed: "2.50" }))).amount).toBe("13.50");
    // fixed markup alone on a zero price
    expect(ok(priceCheckoutRate(price("0"), "UAH", P({ markupFixed: "1.00", rounding: "up_99" }))).amount).toBe("1.99");
  });

  it("single rounding step: conversion + percent rounded once (no double ceil)", () => {
    // 1 UAH / 3 = 0.3333…; ×1.5 = 0.5 exactly → 0.50 (double ceil would give 0.51)
    const p = ok(priceCheckoutRate(price("1"), "EUR", P({ markupPercent: 50, fxRates: [{ currency: "EUR", rate: "3" }] })));
    expect(p.cents).toBe(50n);
    expect(p.convertedAmount).toBe("0.34");
  });

  it("percent → basis points without float noise, fractions rounded up", () => {
    expect(markupPercentToBasisPoints(12.34)).toBe(1234n);
    expect(markupPercentToBasisPoints(12.345)).toBe(1235n);
    expect(markupPercentToBasisPoints(0.1 + 0.2)).toBe(30n);
    expect(markupPercentToBasisPoints(0)).toBe(0n);
    expect(markupPercentToBasisPoints(200)).toBe(20000n);
    expect(markupPercentToBasisPoints(33.333333333)).toBe(3334n);
  });

  it("rejects NaN / Infinity / negative markup", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => markupPercentToBasisPoints(bad)).toThrow(RangeError);
      expect(() => priceCheckoutRate(price("1"), "UAH", P({ markupPercent: bad }))).toThrow(RangeError);
    }
    expect(() => markupFixedToCents("-1")).toThrow(RangeError);
    expect(() => markupFixedToCents("1.234")).toThrow(RangeError);
    expect(markupFixedToCents("7")).toBe(700n);
  });

  it("rounding boundaries", () => {
    expect(applyRounding(1300n, "up_whole", 2)).toBe(1300n);
    expect(applyRounding(1301n, "up_whole", 2)).toBe(1400n);
    expect(applyRounding(1300n, "up_99", 2)).toBe(1399n);
    expect(applyRounding(1398n, "up_99", 2)).toBe(1399n);
    expect(applyRounding(1399n, "up_99", 2)).toBe(1399n);
    expect(applyRounding(1400n, "up_99", 2)).toBe(1499n);
    expect(applyRounding(1n, "up_99", 2)).toBe(99n);
    expect(applyRounding(1n, "up_whole", 2)).toBe(100n);
    expect(applyRounding(1234n, "none", 2)).toBe(1234n);
    expect(applyRounding(1234n, "none", 0)).toBe(1300n);
    expect(applyRounding(0n, "up_99", 2)).toBe(0n);
  });

  it("helpers", () => {
    expect(parseDecimal("12.345")).toEqual({ num: 12345n, den: 1000n });
    expect(parseDecimal("-1")).toBeNull();
    expect(currencyMinorDigits("jpy")).toBe(0);
    expect(currencyMinorDigits("KWD")).toBe(3);
    expect(currencyMinorDigits("EUR")).toBe(2);
    expect(subunitsToDecimal(1999n, "USD")).toBe("19.99");
    expect(subunitsToDecimal(1000n, "JPY")).toBe("1000.00");
    expect(subunitsToDecimal(1234n, "KWD")).toBe("1.24");
    expect(subunitsToDecimal(0n, "EUR")).toBe("0.00");
  });
});

describe("Shopify response helpers", () => {
  it("total_price is a string of integer subunits", () => {
    expect(shopifyTotalPrice(1295n)).toBe("1295");
    expect(() => shopifyTotalPrice(-1n)).toThrow(RangeError);
  });

  it("service_code is stable, sanitized and ≤ 64 chars", () => {
    expect(shopifyServiceCode("nova_post", "Standard Express!")).toBe("nova_post_standard_express");
    expect(shopifyServiceCode("nova_post", "")).toBe("nova_post_default");
    const uuid = "3f1c2a7e-9b1d-4c8e-a1f0-0123456789ab";
    expect(shopifyServiceCode("nova_post", uuid)).toBe("nova_post_3f1c2a7e_9b1d_4c8e_a1f0_0123456789ab");
    const long = shopifyServiceCode("nova_post", "x".repeat(200));
    expect(long.length).toBeLessThanOrEqual(64);
    expect(shopifyServiceCode("nova_post", "x".repeat(200))).toBe(long);
    expect(shopifyServiceCode("nova_post", "x".repeat(201))).not.toBe(long);
  });
});

// ---------------------------------------------------------------------------
// parseRateRequest
// ---------------------------------------------------------------------------

/** Приклад запиту з документації Shopify (DeliveryCarrierService), вигадані дані. */
function docExample(): Record<string, any> {
  return {
    rate: {
      origin: {
        country: "CA", postal_code: "K2P1L4", province: "ON", city: "Ottawa", name: null, address1: "150 Elgin St.",
        address2: "", address3: null, phone: null, fax: null, email: null, address_type: null, company_name: "Jamie D's Emporium",
      },
      destination: {
        country: "CA", postal_code: "K1M1M4", province: "ON", city: "Ottawa", name: "Bob Norman", address1: "24 Sussex Dr.",
        address2: "", address3: null, phone: null, fax: null, email: null, address_type: null, company_name: null,
      },
      items: [
        {
          name: "Short Sleeve T-Shirt", sku: "", quantity: 1, grams: 1000, price: 1999, vendor: "Jamie D's Emporium",
          requires_shipping: true, taxable: true, fulfillment_service: "manual", properties: null,
          product_id: 48447225880, variant_id: 258644705304,
        },
      ],
      currency: "USD",
      locale: "en",
      order_totals: { subtotal_price: 1999, total_price: 1849, discount_amount: 150 },
      customer: { id: 207119551, tags: ["VIP", "wholesale"] },
    },
  };
}

describe("parseRateRequest", () => {
  it("accepts the documented example and drops unknown keys", () => {
    const r = parseRateRequest(docExample());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.rate.currency).toBe("USD");
    expect(r.request.rate.items[0]).toMatchObject({ quantity: 1, grams: 1000, price: 1999, variant_id: "258644705304", product_id: "48447225880" });
    expect(r.request.rate.order_totals?.total_price).toBe(1849);
    expect(r.request.rate.destination).not.toHaveProperty("name");
    expect(r.request.rate.destination).not.toHaveProperty("phone");
    expect(r.request.rate).not.toHaveProperty("customer");
  });

  it("is lenient: nulls, missing optionals, numeric strings, zip instead of postal_code, lowercase currency", () => {
    const r = parseRateRequest({
      rate: {
        destination: { country: "DE", zip: "10115", city: null, province: null },
        items: [{ quantity: "2", grams: "250", price: null, requires_shipping: null, variant_id: null }],
        currency: "eur",
        order_totals: null,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.request.rate.currency).toBe("EUR");
    expect(r.request.rate.items[0]).toMatchObject({ quantity: 2, grams: 250, price: null, variant_id: null });
    expect(r.request.rate.destination.zip).toBe("10115");
  });

  it("rejects structurally invalid input", () => {
    const cases: unknown[] = [
      null,
      "x",
      {},
      { rate: null },
      { rate: { ...docExample().rate, items: "nope" } },
      { rate: { ...docExample().rate, destination: undefined } },
      { rate: { ...docExample().rate, currency: "US" } },
      { rate: { ...docExample().rate, items: [{ quantity: -1, grams: 1 }] } },
      { rate: { ...docExample().rate, items: [{ quantity: 1, grams: 1.5 }] } },
      { rate: { ...docExample().rate, items: [{ grams: 1 }] } },
      { rate: { ...docExample().rate, items: [{ quantity: 1, requires_shipping: "yes" }] } },
    ];
    for (const c of cases) {
      const r = parseRateRequest(c);
      expect(r.ok, JSON.stringify(c)?.slice(0, 80)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// computeCheckoutRates / previewCheckoutRates
// ---------------------------------------------------------------------------

type QuoteImpl = (req: RateRequest, opts?: CarrierCallOptions) => Promise<RateQuote[]>;

function fakeCarrier(impl: QuoteImpl, over: Partial<CarrierAdapter> = {}) {
  const calls: RateRequest[] = [];
  const adapter: CarrierAdapter = {
    code: "fake_post",
    displayName: "Fake Post",
    mode: "test",
    capabilities: {
      rates: true,
      availability: false,
      createShipment: false,
      updateShipment: false,
      cancelShipment: false,
      documents: false,
      tracking: false,
      returns: false,
      findByReference: false,
      referenceLookupAuthoritative: false,
    },
    createShipment: async () => {
      throw new Error("not used");
    },
    findShipmentByReference: async () => ({ found: false, authoritative: false }),
    cancelShipment: async () => ({ cancelled: false }),
    quoteRates: async (req, opts) => {
      calls.push(structuredClone(req));
      return impl(req, opts);
    },
    ...over,
  };
  return { adapter, calls, registry: createCarrierRegistry([adapter], adapter.code) };
}

const quote = (over: Partial<RateQuote> = {}): RateQuote => ({
  serviceCode: "standard",
  serviceName: "Standard",
  price: { amount: "900.00", currency: "UAH" },
  minDeliveryDays: 5,
  maxDeliveryDays: 9,
  ...over,
});

function request(over: Record<string, any> = {}, items?: Record<string, any>[]): ShopifyRateRequest {
  const base = docExample();
  base.rate.destination = { ...base.rate.destination, country: "DE", postal_code: "10115", city: "Berlin", province: null };
  base.rate.currency = "EUR";
  base.rate.items = items ?? [{ ...base.rate.items[0], grams: 500, quantity: 2, price: 2500 }];
  base.rate.order_totals = { subtotal_price: 5000, total_price: 5000, discount_amount: 0 };
  Object.assign(base.rate, over);
  const r = parseRateRequest(base);
  if (!r.ok) throw new Error(r.issues.join(", "));
  return r.request;
}

let handle: DatabaseHandle;

async function setCheckout(over: Partial<AllSettings["checkoutRates"]>) {
  const r = await updateSetting(handle.db, OWNER, "checkoutRates", { ...DEFAULT_SETTINGS.checkoutRates, ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.fieldErrors));
}

const ENABLED = {
  enabled: true,
  markupPercent: 10,
  markupFixed: "1.00",
  rounding: "up_99" as const,
  fxRates: [{ currency: "EUR", rate: "45.000000" }],
  serviceName: "",
};

beforeAll(async () => {
  handle = await openTestDatabase();
  const [product] = await handle.db
    .insert(products)
    .values({ shopifyProductId: "gid://shopify/Product/77", title: "Scooter grip" })
    .returning({ id: products.id });
  await handle.db.insert(productVariants).values({
    productId: product!.id,
    shopifyVariantId: "gid://shopify/ProductVariant/777",
    title: "Black",
    price: "25.00",
    currency: "EUR",
    weightGrams: 300,
    hsCode: "871410",
  });
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  clearCheckoutRatesCache();
  vi.restoreAllMocks();
  await handle.db.delete(settingsHistory);
  await handle.db.delete(settings);
});

const deps = (registry: ReturnType<typeof fakeCarrier>["registry"], over: Partial<Parameters<typeof computeCheckoutRates>[0]> = {}) => ({
  db: handle.db,
  carriers: registry,
  now: () => new Date("2026-11-26T10:00:00Z"),
  ...over,
});

describe("computeCheckoutRates", () => {
  it("disabled → 200 with no rates, carrier not called", async () => {
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(deps(c.registry), request());
    expect(r).toEqual({ status: 200, body: { rates: [] } });
    expect(c.calls).toHaveLength(0);
  });

  it("success: FX conversion + markup + rounding, parcel and declared value", async () => {
    await setCheckout(ENABLED);
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(deps(c.registry), request());
    // 900 UAH / 45 = 20.00 EUR → ×1.10 = 22.00 → +1.00 = 23.00 → up_99 = 23.99
    expect(r).toEqual({
      status: 200,
      body: {
        rates: [
          {
            service_name: "Standard",
            description: "Fake Post · Standard",
            service_code: "fake_post_standard",
            currency: "EUR",
            total_price: "2399",
          },
        ],
      },
    });
    expect(c.calls).toHaveLength(1);
    const req = c.calls[0]!;
    // 500 g × 2 + 70 g тари (mailer_m) = 1070 → 1100; об'ємна 35×25×8/5000 = 1.4 кг
    expect(req.parcels).toEqual([
      {
        packageCode: "mailer_m",
        lengthCm: 35,
        widthCm: 25,
        heightCm: 8,
        actualWeightGrams: 1100,
        volumetricWeightGrams: 1400,
        chargeableWeightGrams: 1400,
      },
    ]);
    expect(req.declaredValue).toEqual({ amount: "50.00", currency: "EUR" });
    expect(req.destination).toMatchObject({ countryCode: "DE", postalCode: "10115", city: "Berlin", province: null });
    expect(req.origin.countryCode).toBe("UA");
    expect(req.items).toEqual([{ hsCode: null, quantity: 2, unitValue: { amount: "25.00", currency: "EUR" }, weightGrams: 500 }]);
    expect(req.incoterm).toBe("DAP");
  });

  it("declared value falls back to Σ price × quantity without order_totals", async () => {
    await setCheckout(ENABLED);
    const c = fakeCarrier(async () => [quote()]);
    await computeCheckoutRates(deps(c.registry), request({ order_totals: null }));
    expect(c.calls[0]!.declaredValue).toEqual({ amount: "50.00", currency: "EUR" });
  });

  it("several quotes: sorted by price, custom service name disambiguated, duplicate codes keep the cheapest", async () => {
    await setCheckout({ ...ENABLED, rounding: "none", markupPercent: 0, markupFixed: "0.00", serviceName: "Доставка ONE TUNNE" });
    const c = fakeCarrier(async () => [
      quote({ serviceCode: "express", serviceName: "Express", price: { amount: "1800", currency: "UAH" } }),
      quote({ serviceCode: "standard", serviceName: "Standard", price: { amount: "900", currency: "UAH" } }),
      quote({ serviceCode: "Standard", serviceName: "Standard (dup)", price: { amount: "990", currency: "UAH" } }),
    ]);
    const r = await computeCheckoutRates(deps(c.registry), request());
    expect(r.body.rates.map((x) => [x.service_code, x.total_price, x.service_name])).toEqual([
      ["fake_post_standard", "2000", "Доставка ONE TUNNE — Standard"],
      ["fake_post_express", "4000", "Доставка ONE TUNNE — Express"],
    ]);
  });

  it("single quote uses the custom service name as is", async () => {
    await setCheckout({ ...ENABLED, serviceName: "Міжнародна доставка" });
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(deps(c.registry), request());
    expect(r.body.rates[0]).toMatchObject({ service_name: "Міжнародна доставка", description: "Fake Post · Standard" });
  });

  it("non-shippable items are ignored (weight, declared value)", async () => {
    await setCheckout(ENABLED);
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(
      deps(c.registry),
      request({ order_totals: null }, [
        { quantity: 1, grams: 2000, price: 1000, requires_shipping: true, variant_id: 1 },
        { quantity: 1, grams: 0, price: 9999, requires_shipping: false, variant_id: 2 },
      ]),
    );
    expect(r.status).toBe(200);
    expect(r.body.rates).toHaveLength(1);
    expect(c.calls[0]!.items).toHaveLength(1);
    expect(c.calls[0]!.parcels[0]!.actualWeightGrams).toBe(2100); // 2000 + 70 → 2100
    expect(c.calls[0]!.declaredValue.amount).toBe("10.00");
  });

  it("no shippable items → empty rates", async () => {
    await setCheckout(ENABLED);
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(deps(c.registry), request({}, [{ quantity: 1, grams: 100, price: 1, requires_shipping: false }]));
    expect(r).toEqual({ status: 200, body: { rates: [] } });
    expect(c.calls).toHaveLength(0);
  });

  it("item without grams → weight (and HS code) of our DB variant", async () => {
    await setCheckout(ENABLED);
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(deps(c.registry), request({}, [{ quantity: 3, grams: 0, price: 2500, variant_id: 777 }]));
    expect(r.status).toBe(200);
    expect(r.body.rates).toHaveLength(1);
    expect(c.calls[0]!.items).toEqual([{ hsCode: "871410", quantity: 3, unitValue: { amount: "25.00", currency: "EUR" }, weightGrams: 300 }]);
    // 300 × 3 + 70 = 970 → 1000 (крок 100 г); об'ємна 1400
    expect(c.calls[0]!.parcels[0]!.actualWeightGrams).toBe(1000);
  });

  it("an item with no weight anywhere → empty rates and a logged reason", async () => {
    await setCheckout(ENABLED);
    const info = vi.spyOn(logger, "info");
    const c = fakeCarrier(async () => [quote()]);
    const r = await computeCheckoutRates(
      deps(c.registry),
      request({}, [
        { quantity: 1, grams: 500, price: 100, variant_id: 777 },
        { quantity: 1, grams: null, price: 100, variant_id: 123456 },
      ]),
    );
    expect(r).toEqual({ status: 200, body: { rates: [] } });
    expect(c.calls).toHaveLength(0);
    const entry = info.mock.calls.find((call) => call[0] === "checkout_rates.request");
    expect(entry?.[1]).toMatchObject({ outcome: "missing_weight", missingWeightItems: 1 });
  });

  it("carrier timeout → 503 (Shopify backup rates), even if the adapter ignores the signal", async () => {
    await setCheckout(ENABLED);
    let signal: AbortSignal | undefined;
    const c = fakeCarrier((_req, opts) => {
      signal = opts?.signal;
      return new Promise<RateQuote[]>(() => undefined);
    });
    const info = vi.spyOn(logger, "info");
    const started = Date.now();
    const r = await computeCheckoutRates(deps(c.registry, { timeoutMs: 30 }), request());
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r).toEqual({ status: 503, body: { rates: [] } });
    expect(signal?.aborted).toBe(true);
    expect(info.mock.calls.find((x) => x[0] === "checkout_rates.request")?.[1]).toMatchObject({
      outcome: "carrier_timeout",
      errorKind: "timeout",
    });
  });

  it("carrier error → 503; errors are not cached", async () => {
    await setCheckout(ENABLED);
    let fail = true;
    const c = fakeCarrier(async () => {
      if (fail) throw new CarrierError("unavailable", "fake_post", "down");
      return [quote()];
    });
    expect(await computeCheckoutRates(deps(c.registry), request())).toEqual({ status: 503, body: { rates: [] } });
    expect(checkoutRatesCacheSize()).toBe(0);
    fail = false;
    const r = await computeCheckoutRates(deps(c.registry), request());
    expect(r.status).toBe(200);
    expect(c.calls).toHaveLength(2);
  });

  it("cart currency without an FX rate → empty rates; 3-decimal currency → empty rates", async () => {
    await setCheckout(ENABLED);
    const c = fakeCarrier(async () => [quote()]);
    expect(await computeCheckoutRates(deps(c.registry), request({ currency: "USD" }))).toEqual({ status: 200, body: { rates: [] } });
    expect(await computeCheckoutRates(deps(c.registry), request({ currency: "KWD" }))).toEqual({ status: 200, body: { rates: [] } });
  });

  it("only unpriceable quotes are dropped", async () => {
    await setCheckout({ ...ENABLED, rounding: "none", markupPercent: 0, markupFixed: "0.00" });
    const c = fakeCarrier(async () => [
      quote({ serviceCode: "a", price: { amount: "450", currency: "UAH" } }),
      quote({ serviceCode: "b", price: { amount: "10", currency: "PLN" } }),
      quote({ serviceCode: "c", price: { amount: "oops", currency: "UAH" } }),
    ]);
    const r = await computeCheckoutRates(deps(c.registry), request());
    expect(r.body.rates.map((x) => [x.service_code, x.total_price])).toEqual([["fake_post_a", "1000"]]);
  });

  it("carrier without rates capability, empty quote list, unknown destination → empty rates", async () => {
    await setCheckout(ENABLED);
    const noRates = fakeCarrier(async () => [quote()]);
    noRates.adapter.capabilities.rates = false;
    expect((await computeCheckoutRates(deps(noRates.registry), request())).body.rates).toEqual([]);
    expect(noRates.calls).toHaveLength(0);

    const empty = fakeCarrier(async () => []);
    expect(await computeCheckoutRates(deps(empty.registry), request())).toEqual({ status: 200, body: { rates: [] } });

    const c = fakeCarrier(async () => [quote()]);
    const noCountry = request({ destination: { country: null, city: "X" } });
    expect(await computeCheckoutRates(deps(c.registry), noCountry)).toEqual({ status: 200, body: { rates: [] } });
    expect(c.calls).toHaveLength(0);

    const noDefault = createCarrierRegistry([c.adapter]);
    expect((await computeCheckoutRates({ ...deps(c.registry), carriers: noDefault }, request())).body.rates).toEqual([]);
  });

  it("cache: same destination/weight bucket/value → one carrier call; TTL and clear", async () => {
    await setCheckout(ENABLED);
    let now = new Date("2026-11-26T10:00:00Z").getTime();
    const c = fakeCarrier(async () => [quote()]);
    const d = deps(c.registry, { now: () => new Date(now) });
    const first = await computeCheckoutRates(d, request());
    const second = await computeCheckoutRates(d, request());
    expect(second).toEqual(first);
    expect(c.calls).toHaveLength(1);

    // інша вага всередині того самого кроку 100 г і в межах об'ємної ваги → той самий запит до перевізника
    await computeCheckoutRates(d, request({}, [{ quantity: 2, grams: 510, price: 2500, variant_id: 1 }]));
    expect(c.calls).toHaveLength(1);

    // інший ваговий крок → новий запит
    await computeCheckoutRates(d, request({}, [{ quantity: 2, grams: 900, price: 2500, variant_id: 1 }]));
    expect(c.calls).toHaveLength(2);

    // інша оголошена вартість → новий запит
    await computeCheckoutRates(d, request({ order_totals: { total_price: 7000 } }));
    expect(c.calls).toHaveLength(3);

    // markup змінюється без нового запиту до перевізника (кешуються ціни перевізника, не Checkout)
    await setCheckout({ ...ENABLED, markupPercent: 0, markupFixed: "0.00", rounding: "none" });
    const repriced = await computeCheckoutRates(d, request());
    expect(repriced.body.rates[0]!.total_price).toBe("2000");
    expect(c.calls).toHaveLength(3);

    now += CHECKOUT_RATES_CACHE_TTL_MS + 1;
    await computeCheckoutRates(d, request());
    expect(c.calls).toHaveLength(4);

    clearCheckoutRatesCache();
    await computeCheckoutRates(d, request());
    expect(c.calls).toHaveLength(5);
  });

  it("logs no personal data", async () => {
    await setCheckout(ENABLED);
    const spies = [vi.spyOn(logger, "info"), vi.spyOn(logger, "warn"), vi.spyOn(logger, "error"), vi.spyOn(logger, "debug")];
    const pii = ["Bob Norman", "24 Sussex Dr.", "K1M1M4", "Ottawa", "+16135550100", "bob@example.com", "Apt 5"];
    const base = docExample();
    base.rate.destination = {
      ...base.rate.destination,
      phone: "+16135550100",
      email: "bob@example.com",
      address2: "Apt 5",
    };
    const parsed = parseRateRequest(base);
    if (!parsed.ok) throw new Error("parse");
    await setCheckout({ ...ENABLED, fxRates: [{ currency: "USD", rate: "41" }] });

    const okCarrier = fakeCarrier(async () => [quote()]);
    expect((await computeCheckoutRates(deps(okCarrier.registry), parsed.request)).body.rates).toHaveLength(1);
    const failing = fakeCarrier(async () => {
      throw new Error("boom for Bob Norman at 24 Sussex Dr.");
    });
    clearCheckoutRatesCache();
    expect((await computeCheckoutRates(deps(failing.registry), parsed.request)).status).toBe(503);

    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    expect(logged).toContain("checkout_rates.request");
    expect(logged).toContain('"destinationCountry":"CA"');
    for (const value of pii) expect(logged).not.toContain(value);
    // адреса доходить до перевізника (для розрахунку), але не до журналу
    expect(okCarrier.calls[0]!.destination).toMatchObject({ postalCode: "K1M1M4", city: "Ottawa", address1: "24 Sussex Dr." });
  });
});

describe("previewCheckoutRates (owner test calculation)", () => {
  const ctx = (registry: ReturnType<typeof fakeCarrier>["registry"], actor = OWNER): ServiceContext => ({
    mode: "demo",
    db: handle.db,
    actor,
    carriers: registry,
    shopify: new DemoShopifyGateway(),
    now: () => new Date("2026-11-26T10:00:00Z"),
  });
  const input = { countryCode: "de", postalCode: "10115", city: "Berlin", province: "", weightGrams: 800, value: "49.90", currency: "EUR" };

  it("owner only", async () => {
    const c = fakeCarrier(async () => [quote()]);
    await expect(previewCheckoutRates(ctx(c.registry, STAFF), input)).rejects.toBeInstanceOf(ForbiddenError);
    expect(c.calls).toHaveLength(0);
  });

  it("works while checkout rates are disabled; shows carrier and checkout prices; bypasses the cache", async () => {
    await setCheckout({ ...ENABLED, enabled: false });
    const c = fakeCarrier(async () => [quote({ estimatedDeliveryDate: "2026-12-03" })]);
    const r = await previewCheckoutRates(ctx(c.registry), input);
    expect(r.enabled).toBe(false);
    expect(r.reason).toBeNull();
    expect(r.carrier).toEqual({ code: "fake_post", displayName: "Fake Post", mode: "test" });
    // 800 + 70 = 870 → 900; об'ємна 1400
    expect(r.parcel).toMatchObject({ actualWeightGrams: 900, chargeableWeightGrams: 1400 });
    expect(r.quotes).toEqual([
      {
        serviceCode: "standard",
        serviceName: "Standard",
        shopifyServiceCode: "fake_post_standard",
        carrierPrice: { amount: "900.00", currency: "UAH" },
        convertedPrice: { amount: "20.00", currency: "EUR" },
        checkoutPrice: { amount: "23.99", currency: "EUR" },
        failure: null,
        minDeliveryDays: 5,
        maxDeliveryDays: 9,
        estimatedDeliveryDate: "2026-12-03",
      },
    ]);
    expect(r.rates[0]).toMatchObject({ total_price: "2399", currency: "EUR" });
    expect(c.calls[0]!.destination.countryCode).toBe("DE");
    expect(c.calls[0]!.declaredValue).toEqual({ amount: "49.90", currency: "EUR" });
    await previewCheckoutRates(ctx(c.registry), input);
    expect(c.calls).toHaveLength(2);
  });

  it("explains why nothing can be priced", async () => {
    await setCheckout({ ...ENABLED, fxRates: [] });
    const c = fakeCarrier(async () => [quote()]);
    const r = await previewCheckoutRates(ctx(c.registry), input);
    expect(r.reason).toBe("no_priced_quotes");
    expect(r.quotes[0]).toMatchObject({ failure: "no_fx_rate", checkoutPrice: null, carrierPrice: { amount: "900.00", currency: "UAH" } });
    expect(r.rates).toEqual([]);

    const failing = fakeCarrier(async () => {
      throw new CarrierError("auth", "fake_post", "bad key");
    });
    expect(await previewCheckoutRates(ctx(failing.registry), input)).toMatchObject({ reason: "carrier_error", errorKind: "auth" });

    const none = fakeCarrier(async () => []);
    none.adapter.capabilities.rates = false;
    expect(await previewCheckoutRates(ctx(none.registry), input)).toMatchObject({ reason: "no_rates_carrier", carrier: null });
  });

  it("rejects invalid input", async () => {
    const c = fakeCarrier(async () => [quote()]);
    await expect(previewCheckoutRates(ctx(c.registry), { ...input, countryCode: "Germany" })).rejects.toThrow();
    await expect(previewCheckoutRates(ctx(c.registry), { ...input, weightGrams: 0 })).rejects.toThrow();
    await expect(previewCheckoutRates(ctx(c.registry), { ...input, value: "1,5" })).rejects.toThrow();
    expect(c.calls).toHaveLength(0);
  });
});

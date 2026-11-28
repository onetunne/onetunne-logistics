/**
 * Етап 6, WP1: чисті правила — ручний курс з форми («1 EUR = … грн», масштаби), код валюти, показ курсу без float,
 * курсова різниця обміну (G4), генератор демо-курсів (§5.8: детермінований, ±1,2 %, вихідні = п'ятниця, 4 знаки,
 * [сьогодні − 420, сьогодні + 7], дві ручні версії EUR).
 */
import { describe, expect, it } from "vitest";
import { ratePerUnitScaled } from "~/lib/decimal";
import { addDays, daysBetween, isoWeekday } from "~/lib/periods";
import { conversionDifference } from "~/modules/fx/conversion-calc";
import { DEMO_RATE_SPECS, demoManualEurVersions, demoRateOn, generateDemoRates, sinMilli } from "~/modules/fx/demo-rates";
import { formatRate } from "~/modules/fx/display";
import { parseRateCurrency, parseRateInput } from "~/modules/fx/rate-input";
import { UAH_SCALED_RATE } from "~/modules/fx/convert";

describe("parseRateInput", () => {
  it("accepts comma or dot, thousands spaces, up to 6 decimals; per-unit rate is exact", () => {
    expect(parseRateInput("49,4942")).toEqual({ ok: true, rate: "49.4942", units: 1, ratePerUnit: "49.4942" });
    expect(parseRateInput(" 49.494200 ")).toEqual({ ok: true, rate: "49.4942", units: 1, ratePerUnit: "49.4942" });
    expect(parseRateInput("2,818", "10")).toEqual({ ok: true, rate: "2.818", units: 10, ratePerUnit: "0.2818" });
    expect(parseRateInput("1,7505", 1000)).toEqual({ ok: true, rate: "1.7505", units: 1000, ratePerUnit: "0.0017505" });
    expect(parseRateInput("2 687,2573", 100)).toEqual({ ok: true, rate: "2687.2573", units: 100, ratePerUnit: "26.872573" });
    expect(parseRateInput("0,000001", 10000)).toEqual({ ok: true, rate: "0.000001", units: 10000, ratePerUnit: "0.0000000001" });
  });

  it("rejects empty, ambiguous, too precise, non-positive, garbage and unsupported scales", () => {
    expect(parseRateInput("")).toEqual({ ok: false, error: "financeFx.error.rateEmpty" });
    expect(parseRateInput("1.234,5")).toEqual({ ok: false, error: "financeFx.error.rateAmbiguous" });
    expect(parseRateInput("1,2,3")).toEqual({ ok: false, error: "financeFx.error.rateAmbiguous" });
    expect(parseRateInput("49,1234567")).toEqual({ ok: false, error: "financeFx.error.rateTooPrecise" });
    expect(parseRateInput("0")).toEqual({ ok: false, error: "financeFx.error.rateInvalid" });
    expect(parseRateInput("-49")).toEqual({ ok: false, error: "financeFx.error.rateInvalid" });
    expect(parseRateInput("4.9e1")).toEqual({ ok: false, error: "financeFx.error.rateInvalid" });
    expect(parseRateInput("1234567890123")).toEqual({ ok: false, error: "financeFx.error.rateInvalid" });
    expect(parseRateInput("49", 5)).toEqual({ ok: false, error: "financeFx.error.unitsInvalid" });
    // Курс за одиницю > 10 цілих розрядів (numeric(20,10)).
    expect(parseRateInput("123456789012", 1)).toEqual({ ok: false, error: "financeFx.error.rateInvalid" });
  });

  it("currency: ISO code with 0 or 2 decimals, not the hryvnia", () => {
    expect(parseRateCurrency(" eur ")).toEqual({ ok: true, currency: "EUR" });
    expect(parseRateCurrency("JPY")).toEqual({ ok: true, currency: "JPY" });
    expect(parseRateCurrency("UAH")).toEqual({ ok: false, error: "financeFx.error.currencyBase" });
    expect(parseRateCurrency("KWD")).toEqual({ ok: false, error: "finance.error.unsupportedCurrency" });
    expect(parseRateCurrency("EU")).toEqual({ ok: false, error: "financeFx.error.currencyInvalid" });
  });
});

describe("formatRate (no float)", () => {
  it("uses the app separators and keeps every significant digit", () => {
    expect(formatRate("49.4942000000", "uk")).toBe("49,4942");
    expect(formatRate("49.4942", "en")).toBe("49.4942");
    expect(formatRate("0.0017505", "uk")).toBe("0,0017505");
    expect(formatRate("2687.2573", "uk")).toBe("2 687,2573");
    expect(formatRate("2687.2573", "en")).toBe("2,687.2573");
    expect(formatRate("123456.1234567891", "en")).toBe("123,456.1234567891");
    expect(formatRate("1.000000", "uk")).toBe("1");
    expect(formatRate(null, "uk")).toBe("—");
    expect(formatRate("abc", "uk")).toBe("—");
  });
});

describe("conversionDifference (§5.7, G4)", () => {
  it("1 000,00 EUR → 48 650,00 UAH on 27.11.2026 at NBU 49,4942 → expected 49 494,20, difference −844,20 UAH", () => {
    expect(
      conversionDifference({
        soldAmount: "1000.00",
        soldCurrency: "EUR",
        boughtAmount: "48650.00",
        boughtCurrency: "UAH",
        soldRate: ratePerUnitScaled("49.4942", 1),
        boughtRate: UAH_SCALED_RATE,
      }),
    ).toEqual({ expected: "49494.20", difference: "-844.20" });
  });

  it("cross pairs without a pre-rounded cross rate; 0-decimal targets round once to whole units", () => {
    const EUR = ratePerUnitScaled("49.5335", 1);
    const USD = ratePerUnitScaled("45.0532", 1);
    const JPY = ratePerUnitScaled("2.818", 10);
    expect(conversionDifference({ soldAmount: "123456.78", soldCurrency: "EUR", boughtAmount: "135700.00", boughtCurrency: "USD", soldRate: EUR, boughtRate: USD })).toEqual({
      expected: "135733.90",
      difference: "-33.90",
    });
    expect(conversionDifference({ soldAmount: "100.00", soldCurrency: "EUR", boughtAmount: "17600.00", boughtCurrency: "JPY", soldRate: EUR, boughtRate: JPY })).toEqual({
      expected: "17578.00",
      difference: "22.00",
    });
    expect(conversionDifference({ soldAmount: "1000.00", soldCurrency: "JPY", boughtAmount: "281.80", boughtCurrency: "UAH", soldRate: JPY, boughtRate: UAH_SCALED_RATE })).toEqual({
      expected: "281.80",
      difference: "0.00",
    });
    expect(() => conversionDifference({ soldAmount: "1.00", soldCurrency: "EUR", boughtAmount: "1.00", boughtCurrency: "EUR", soldRate: EUR, boughtRate: EUR })).toThrow(RangeError);
  });
});

describe("demo rates generator (§5.8)", () => {
  it("integer sine approximation is within 0.2 % of sin and symmetric", () => {
    for (let t = 0; t < 360; t += 5) {
      expect(Math.abs(sinMilli(t) - Math.round(Math.sin((t * Math.PI) / 180) * 1000))).toBeLessThanOrEqual(2);
      expect(sinMilli(t + 180)).toBe(-sinMilli(t));
    }
    expect(sinMilli(90)).toBe(1000);
    expect(sinMilli(0)).toBe(0);
  });

  it("deterministic rows for [today − 420, today + 7] × EUR, USD, GBP, PLN; 4 decimals; ±1,2 % of the base; weekends repeat Friday", () => {
    const today = "2026-11-28";
    const rows = generateDemoRates(today);
    expect(rows).toHaveLength(428 * 4);
    expect(new Set(rows.map((r) => r.currency))).toEqual(new Set(["EUR", "USD", "GBP", "PLN"]));
    expect(rows.map((r) => r.effectiveDate).sort()[0]).toBe(addDays(today, -420));
    expect(rows.map((r) => r.effectiveDate).sort().at(-1)).toBe(addDays(today, 7));
    // Той самий день — ті самі значення незалежно від «сьогодні» (повторне заповнення в інший день).
    const again = new Map(generateDemoRates("2026-12-15").map((r) => [`${r.currency}|${r.effectiveDate}`, r.rate]));
    for (const r of rows) {
      const other = again.get(`${r.currency}|${r.effectiveDate}`);
      if (other) expect(other).toBe(r.rate);
    }
    for (const spec of DEMO_RATE_SPECS) {
      const base = spec.base4;
      for (const r of rows.filter((x) => x.currency === spec.currency)) {
        expect(r.rate).toMatch(/^\d+\.\d{4}$/);
        const v = Number(r.rate.replace(".", ""));
        expect(Math.abs(v - base)).toBeLessThanOrEqual(Math.ceil(base * 0.0121));
        const wd = isoWeekday(r.effectiveDate);
        if (wd === 6) expect(r.rate).toBe(demoRateOn(spec, addDays(r.effectiveDate, -1)));
        if (wd === 7) expect(r.rate).toBe(demoRateOn(spec, addDays(r.effectiveDate, -2)));
      }
      // Плавно: сусідні робочі дні відрізняються не більше ніж на 0,15 % за календарний день між ними.
      const weekdays = rows.filter((x) => x.currency === spec.currency && isoWeekday(x.effectiveDate) <= 5);
      for (let i = 1; i < weekdays.length; i++) {
        const a = Number(weekdays[i - 1]!.rate.replace(".", ""));
        const b = Number(weekdays[i]!.rate.replace(".", ""));
        const days = daysBetween(weekdays[i - 1]!.effectiveDate, weekdays[i]!.effectiveDate);
        expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.ceil(base * 0.0015 * days));
      }
    }
    expect(demoRateOn(DEMO_RATE_SPECS[0]!, "2026-11-20")).toBe(demoRateOn(DEMO_RATE_SPECS[0]!, "2026-11-20"));
  });

  it("two manual EUR versions 14 days back (v2 is the correction)", () => {
    const v = demoManualEurVersions("2026-11-28");
    expect(v.map((x) => [x.currency, x.effectiveDate, x.version])).toEqual([
      ["EUR", "2026-11-14", 1],
      ["EUR", "2026-11-14", 2],
    ]);
    const base = Number(demoRateOn(DEMO_RATE_SPECS[0]!, "2026-11-14").replace(".", ""));
    expect(Number(v[0]!.rate.replace(".", ""))).toBe(base + 1000);
    expect(Number(v[1]!.rate.replace(".", ""))).toBe(base + 500);
    expect(v.every((x) => x.reason.length > 0)).toBe(true);
  });
});

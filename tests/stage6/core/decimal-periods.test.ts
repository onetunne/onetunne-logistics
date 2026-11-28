/**
 * Етап 6 (WP0): точні допоміжні функції app/lib/decimal.ts (§5.9), відрізки app/lib/periods.ts (§3.1, §12.1) і
 * форматування відсотків/коротких сум app/lib/format.ts.
 */
import { describe, expect, it } from "vitest";
import {
  allocateMinor,
  assertSupportedCurrency,
  convertMinor,
  currencyMinorDigits,
  divideMinorHalfUp,
  isSupportedCurrency,
  marginPercent,
  minorDigits,
  mulDivHalfAwayFromZero,
  parseDecimalStrict,
  parseOwnerAmount,
  percentOfMinor,
  ratePerUnitScaled,
  scaledRateToDecimal,
  toMinorForCurrency,
} from "~/lib/decimal";
import { formatCompactMoney, formatPercent } from "~/lib/format";
import { currencyMinorDigits as pricingDigits } from "~/modules/rates/pricing";
import { divideMinorHalfUp as calcDivide } from "~/modules/production/calc";
import {
  addMonths,
  autoGranularity,
  bucketsFor,
  comparisonRange,
  isAllowedCustomRange,
  isFullyPastMonth,
  isoWeekOf,
  isoWeekStart,
  monthEnd,
  monthsInRange,
  resolvePreset,
} from "~/lib/periods";

describe("decimal.ts", () => {
  it("currencyMinorDigits moved from rates/pricing.ts without behaviour change; 0/2-decimal currencies supported", () => {
    for (const c of ["UAH", "EUR", "JPY", "KRW", "KWD", "CLF", "jpy"]) expect(currencyMinorDigits(c)).toBe(pricingDigits(c));
    expect(minorDigits("JPY")).toBe(0);
    expect(assertSupportedCurrency("JPY")).toBe(0);
    expect(assertSupportedCurrency("EUR")).toBe(2);
    expect(isSupportedCurrency("KWD")).toBe(false);
    expect(isSupportedCurrency("eur")).toBe(false);
    expect(() => assertSupportedCurrency("BHD")).toThrow();
    expect(divideMinorHalfUp).toBe(calcDivide);
  });

  it("0-decimal currency amounts with non-zero hundredths are a parse error, not rounding", () => {
    expect(toMinorForCurrency("1000.00", "JPY")).toBe(100000n);
    expect(() => toMinorForCurrency("12.50", "JPY")).toThrow();
    expect(toMinorForCurrency("12.50", "EUR")).toBe(1250n);
  });

  it("parseDecimalStrict: sign, no exponent, scale limit", () => {
    expect(parseDecimalStrict("-12.345", 3)).toEqual({ num: -12345n, den: 1000n });
    expect(parseDecimalStrict("1e3", 5)).toBeNull();
    expect(parseDecimalStrict("1.2345", 3)).toBeNull();
    expect(parseDecimalStrict(" 1", 2)).toBeNull();
  });

  it("ratePerUnitScaled: exact rate / units × 10^10 (NBU scales)", () => {
    expect(ratePerUnitScaled("49.5335", 1)).toBe(495335000000n);
    expect(ratePerUnitScaled("13.4308", 100)).toBe(1343080000n);
    expect(ratePerUnitScaled("2.818", 10)).toBe(2818000000n);
    expect(scaledRateToDecimal(1343080000n)).toBe("0.134308");
    expect(() => ratePerUnitScaled("0", 1)).toThrow();
  });

  it("mulDivHalfAwayFromZero and percentOfMinor are signed half-away-from-zero", () => {
    expect(mulDivHalfAwayFromZero(5n, 1n, 2n)).toBe(3n);
    expect(mulDivHalfAwayFromZero(-5n, 1n, 2n)).toBe(-3n);
    expect(mulDivHalfAwayFromZero(4n, 1n, 3n)).toBe(1n);
    expect(mulDivHalfAwayFromZero(5n, 1n, -2n)).toBe(-3n);
    expect(percentOfMinor(11700n, 1000)).toBe(1170n);
    expect(percentOfMinor(-12345n, 250)).toBe(-309n);
  });

  it("convertMinor: one rounding per entry straight to target minor units (G3)", () => {
    const EUR = ratePerUnitScaled("49.5335", 1);
    const USD = ratePerUnitScaled("45.0532", 1);
    const JPY = ratePerUnitScaled("2.818", 10);
    const UAH = 10n ** 10n;
    expect(convertMinor(10000n, EUR, UAH, 2)).toBe(495335n); // 4 953,35 UAH
    expect(convertMinor(10000n, EUR, USD, 2)).toBe(10994n); // 109,94 USD
    expect(convertMinor(12345678n, EUR, USD, 2)).toBe(13573390n); // 135 733,90 USD — без попереднього округлення кросу
    expect(convertMinor(10000n, EUR, JPY, 0)).toBe(1757800n); // 17 578 JPY (17 578,00)
    expect(convertMinor(64n, EUR, JPY, 0)).toBe(11200n); // 112 JPY, не 113
    expect(convertMinor(100000n, JPY, UAH, 2)).toBe(28180n); // 1 000 JPY → 281,80 UAH
    expect(convertMinor(-64n, EUR, JPY, 0)).toBe(-11200n);
  });

  it("allocateMinor: largest remainders, ties to the lower index, exact sum, negative totals (G7, I7)", () => {
    const days = allocateMinor(100000n, Array(30).fill(1n));
    expect(days.slice(0, 10).every((d) => d === 3334n)).toBe(true);
    expect(days.slice(10).every((d) => d === 3333n)).toBe(true);
    expect(days.reduce((a, b) => a + b, 0n)).toBe(100000n);
    expect(allocateMinor(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocateMinor(10n, [0n, 1n, 3n])).toEqual([0n, 3n, 7n]);
    expect(() => allocateMinor(1n, [0n, 0n])).toThrow();
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let i = 0; i < 500; i++) {
      const total = BigInt(Math.floor((rnd() - 0.5) * 1e9));
      const weights = Array.from({ length: 1 + Math.floor(rnd() * 12) }, () => BigInt(Math.floor(rnd() * 1000)) + 1n);
      expect(allocateMinor(total, weights).reduce((a, b) => a + b, 0n)).toBe(total);
    }
  });

  it("marginPercent: 1 decimal half away from zero; base ≤ 0 → null", () => {
    expect(marginPercent(568n, 1000n)).toBe("56.8");
    expect(marginPercent(5685n, 10000n)).toBe("56.9");
    expect(marginPercent(-30n, 1000n)).toBe("-3.0");
    expect(marginPercent(10n, 0n)).toBeNull();
    expect(marginPercent(10n, -5n)).toBeNull();
  });

  it("parseOwnerAmount: «1 234,50», «1234,50», «1234.50»; comma and dot → ambiguous; > 2 decimals → error", () => {
    expect(parseOwnerAmount("1 234,50")).toEqual({ ok: true, value: "1234.50" });
    expect(parseOwnerAmount("1 234,5")).toEqual({ ok: true, value: "1234.50" });
    expect(parseOwnerAmount("1234.50")).toEqual({ ok: true, value: "1234.50" });
    expect(parseOwnerAmount("-120")).toEqual({ ok: true, value: "-120.00" });
    expect(parseOwnerAmount("1,234.50")).toEqual({ ok: false, error: "finance.error.amountAmbiguous" });
    expect(parseOwnerAmount("1.234,50")).toEqual({ ok: false, error: "finance.error.amountAmbiguous" });
    expect(parseOwnerAmount("12,345")).toEqual({ ok: false, error: "finance.error.amountTooPrecise" });
    expect(parseOwnerAmount("")).toEqual({ ok: false, error: "finance.error.amountEmpty" });
    expect(parseOwnerAmount("abc")).toEqual({ ok: false, error: "finance.error.amountInvalid" });
    expect(parseOwnerAmount("1234567890123")).toEqual({ ok: false, error: "finance.error.amountInvalid" });
  });
});

describe("periods.ts", () => {
  it("ISO weeks Mon–Sun, the week with Thursday belongs to its year", () => {
    expect(isoWeekOf("2026-11-28")).toEqual({ year: 2026, week: 48 });
    expect(isoWeekStart("2026-11-28")).toBe("2026-11-23");
    expect(isoWeekOf("2027-01-01")).toEqual({ year: 2026, week: 53 });
    expect(isoWeekOf("2024-12-30")).toEqual({ year: 2025, week: 1 });
  });

  it("months, buckets clipped to the range, auto granularity", () => {
    expect(monthEnd("2024-02-10")).toBe("2024-02-29");
    expect(addMonths("2026-01-01", -2)).toBe("2025-11-01");
    expect(monthsInRange({ from: "2026-10-15", to: "2026-12-01" })).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
    const weeks = bucketsFor({ from: "2026-11-01", to: "2026-11-28" }, "week");
    expect(weeks[0]).toMatchObject({ key: "2026-W44", from: "2026-11-01", to: "2026-11-01", isoWeek: 44 });
    expect(weeks.at(-1)).toMatchObject({ key: "2026-W48", from: "2026-11-23", to: "2026-11-28" });
    expect(bucketsFor({ from: "2026-01-01", to: "2026-12-31" }, "month")).toHaveLength(12);
    expect(autoGranularity({ from: "2026-11-01", to: "2026-11-30" })).toBe("day");
    expect(autoGranularity({ from: "2026-06-02", to: "2026-11-30" })).toBe("week");
    expect(autoGranularity({ from: "2026-06-01", to: "2026-11-30" })).toBe("month");
    expect(autoGranularity({ from: "2025-01-01", to: "2026-11-30" })).toBe("month");
    expect(autoGranularity({ from: "2020-01-01", to: "2026-11-30" })).toBe("year");
    expect(() => bucketsFor({ from: "2025-01-01", to: "2026-12-31" }, "day")).toThrow();
    expect(isAllowedCustomRange({ from: "2025-01-01", to: "2026-12-31" }, "day")).toBe(false);
    expect(isAllowedCustomRange({ from: "2022-01-01", to: "2026-12-31" }, "month")).toBe(true);
  });

  it("presets, comparison, fully past month", () => {
    expect(resolvePreset("lastMonth", "2026-11-28")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(resolvePreset("last7", "2026-11-28")).toEqual({ from: "2026-11-22", to: "2026-11-28" });
    expect(comparisonRange({ from: "2026-11-01", to: "2026-11-28" }, "previous")).toEqual({ from: "2026-10-04", to: "2026-10-31" });
    expect(comparisonRange({ from: "2024-02-29", to: "2024-03-01" }, "lastYear")).toEqual({ from: "2023-02-28", to: "2023-03-01" });
    expect(isFullyPastMonth("2026-10-01", "2026-11-01")).toBe(true);
    expect(isFullyPastMonth("2026-11-01", "2026-11-28")).toBe(false);
  });
});

describe("format.ts additions", () => {
  it("formatPercent / formatCompactMoney are deterministic; missing → «—»", () => {
    expect(formatPercent("56.8", "uk")).toBe("56,8 %");
    expect(formatPercent("56.8", "en")).toBe("56.8%");
    expect(formatPercent("-3.0", "uk")).toBe("-3,0 %");
    expect(formatPercent(null, "uk")).toBe("—");
    expect(formatCompactMoney("12345.00", "UAH", "uk")).toBe("12,3 тис. грн");
    expect(formatCompactMoney("1250000.00", "EUR", "en")).toBe("€1.3m");
    expect(formatCompactMoney("-999.40", "USD", "en")).toBe("-US$999");
    expect(formatCompactMoney(null, "UAH", "uk")).toBe("—");
    // Межі одиниць — за округленим значенням (не «1 000 тис.» / «1,000k»).
    expect(formatCompactMoney("999950.00", "EUR", "en")).toBe("€1m");
    expect(formatCompactMoney("999950.00", "UAH", "uk")).toBe("1\u00a0млн\u00a0грн");
    expect(formatCompactMoney("999999999.95", "UAH", "uk")).toBe("1\u00a0млрд\u00a0грн");
    expect(formatCompactMoney("999999999.95", "USD", "en")).toBe("US$1bn");
    expect(formatCompactMoney("999.50", "EUR", "en")).toBe("€1k");
    expect(formatCompactMoney("999.49", "EUR", "en")).toBe("€999");
    expect(formatCompactMoney("-999949.99", "EUR", "en")).toBe("-€999.9k");
    expect(formatCompactMoney("1234567890123.00", "EUR", "en")).toBe("€1,234.6bn");
  });
});

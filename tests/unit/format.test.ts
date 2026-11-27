import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime, formatDecimal, formatIsoDate, formatMoney, formatNumber, formatWeight } from "~/lib/format";
import { formatMoney as formatMoneyExact } from "~/lib/money";
import { formatCost } from "~/modules/production/calc";

/**
 * Детерміновані форматери (ui-1/e2e-1): рядки зафіксовано точно, без залежності від ICU рушія.
 * Раніше formatMoney використовував Intl style:"currency": Node давав «1 234,50 ₴», Chrome — «1 234,50 грн»
 * → помилки гідратації React #418/#425 на «Аналітиці складу» й сторінках замовлень у гривні.
 */
const NB = " ";

describe("formatMoney (deterministic, SSR = browser)", () => {
  it.each([
    ["1234.50", "UAH", "uk", `1${NB}234,50${NB}грн`],
    ["1234.50", "EUR", "uk", `1${NB}234,50${NB}EUR`],
    ["1234.50", "USD", "uk", `1${NB}234,50${NB}USD`],
    ["-1234567.5", "UAH", "uk", `-1${NB}234${NB}567,50${NB}грн`],
    ["1000000", "EUR", "uk", `1${NB}000${NB}000,00${NB}EUR`],
    ["0", "UAH", "uk", `0,00${NB}грн`],
    ["-0.00", "UAH", "uk", `0,00${NB}грн`],
    ["999.99", "UAH", "uk", `999,99${NB}грн`],
    ["1234.50", "UAH", "en", `UAH${NB}1,234.50`],
    ["1234.50", "EUR", "en", "€1,234.50"],
    ["1234.50", "USD", "en", "US$1,234.50"],
    ["1234.50", "GBP", "en", "£1,234.50"],
    ["-1234567.5", "EUR", "en", "-€1,234,567.50"],
    ["-1234567.5", "PLN", "en", `-PLN${NB}1,234,567.50`],
    ["12345678901234.99", "UAH", "uk", `12${NB}345${NB}678${NB}901${NB}234,99${NB}грн`],
  ] as const)("%s %s %s", (amount, currency, locale, expected) => {
    expect(formatMoneyExact(amount, currency, locale)).toBe(expected);
    expect(formatMoney(amount, currency, locale)).toBe(expected);
  });

  it("never uses the runtime ICU currency symbol (no ₴ for UAH)", () => {
    expect(formatMoney("6480", "UAH", "uk")).toBe(`6${NB}480,00${NB}грн`);
    expect(formatMoney("6480", "UAH", "uk")).not.toContain("₴");
  });

  it("production formatCost uses the same formatter as other warehouse pages", () => {
    expect(formatCost("21600", "UAH", "uk")).toBe(formatMoney("21600", "UAH", "uk"));
    expect(formatCost("21600", "UAH", "en")).toBe(`UAH${NB}21,600.00`);
    expect(formatCost(null, "UAH", "uk")).toBe("—");
  });

  it("missing amount or currency → dash", () => {
    expect(formatMoney(null, "UAH", "uk")).toBe("—");
    expect(formatMoney("1.00", null, "uk")).toBe("—");
  });
});

describe("formatDecimal / formatNumber", () => {
  it.each([
    [1234, "uk", {}, `1${NB}234`],
    [1234, "en", {}, "1,234"],
    [-1234.5678, "uk", {}, `-1${NB}234,568`],
    [-1234.5678, "en", {}, "-1,234.568"],
    [0.733, "uk", {}, "0,733"],
    [0.78, "uk", { maximumFractionDigits: 2 }, "0,78"],
    [12.5, "uk", { maximumFractionDigits: 1 }, "12,5"],
    [12, "uk", { minimumFractionDigits: 1, maximumFractionDigits: 1 }, "12,0"],
    [-0, "uk", {}, "0"],
    [-0.0001, "en", {}, "0"],
    [1e6, "en", {}, "1,000,000"],
  ] as const)("%s %s %j", (value, locale, options, expected) => {
    expect(formatDecimal(value, locale, options)).toBe(expected);
  });

  it("formatNumber = formatDecimal with up to 3 fraction digits; non-finite → dash", () => {
    expect(formatNumber(1234567, "uk")).toBe(`1${NB}234${NB}567`);
    expect(formatNumber(Number.NaN, "uk")).toBe("—");
    expect(formatWeight(1500, "uk")).toBe("1,5 кг");
    expect(formatWeight(1500, "en")).toBe("1.5 kg");
    expect(formatWeight(250, "en")).toBe("250 g");
  });
});

describe("dates (Europe/Kyiv, fixed punctuation)", () => {
  it("formats date and date-time with fixed separators", () => {
    // 2026-11-27T07:19Z = 09:19 у Києві (UTC+2, зимовий час).
    expect(formatDateTime("2026-11-27T07:19:00Z", "uk")).toBe("27.11.2026, 09:19");
    expect(formatDateTime("2026-11-27T07:19:00Z", "en")).toBe("27/11/2026, 09:19");
    expect(formatDate("2026-11-27T07:19:00Z", "uk")).toBe("27.11.2026");
    expect(formatDate("2026-11-27T07:19:00Z", "en")).toBe("27/11/2026");
  });

  it("uses the Kyiv calendar day near midnight and in summer time", () => {
    expect(formatDateTime("2026-11-26T22:00:00Z", "uk")).toBe("27.11.2026, 00:00");
    expect(formatDateTime("2026-07-01T21:30:00Z", "uk")).toBe("02.07.2026, 00:30");
  });

  it("ISO calendar dates are not shifted by time zone", () => {
    expect(formatIsoDate("2026-12-11", "uk")).toBe("11.12.2026");
    expect(formatIsoDate("2026-12-11", "en")).toBe("11/12/2026");
    expect(formatIsoDate(null, "uk")).toBe("—");
  });

  it("empty or invalid values → dash", () => {
    expect(formatDateTime(null, "uk")).toBe("—");
    expect(formatDate("not a date", "uk")).toBe("—");
  });
});

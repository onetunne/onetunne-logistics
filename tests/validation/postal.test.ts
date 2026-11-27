import { describe, expect, it } from "vitest";
import { buildCountryRuleMap, DEFAULT_COUNTRY_RULES, type CountryRule } from "~/modules/validation";
import { compilePostalPattern, isFormatOnlyPostalChange, normalizePostalCode } from "~/modules/validation/postal";

const RULES = buildCountryRuleMap(DEFAULT_COUNTRY_RULES);
const rule = (code: string): CountryRule => {
  const r = RULES.get(code);
  if (!r) throw new Error(`no default rule for ${code}`);
  return r;
};

// BR немає серед типових правил — окреме тестове правило.
const BR_RULE: CountryRule = {
  countryCode: "BR",
  nameEn: "Brazil",
  nameUk: "Бразилія",
  shippingEnabled: true,
  postalCodeRequired: true,
  postalCodePattern: "^\\d{5}-\\d{3}$",
  postalCodeExample: "01310-100",
  provinceRequired: false,
  phoneRequired: true,
};

describe("normalizePostalCode — reformatters", () => {
  const cases: Array<[string, string, string]> = [
    ["GB", "sw1a1aa", "SW1A 1AA"],
    ["GB", "EC1A1BB", "EC1A 1BB"],
    ["GB", "M11AE", "M1 1AE"],
    ["GB", "  cr2   6xh ", "CR2 6XH"],
    ["GB", "W1A-0AX", "W1A 0AX"],
    ["CA", "k1a0b1", "K1A 0B1"],
    ["CA", "K1A-0B1", "K1A 0B1"],
    ["NL", "1011AB", "1011 AB"],
    ["NL", "1011ab", "1011 AB"],
    ["PL", "00950", "00-950"],
    ["PL", "00 950", "00-950"],
    ["PT", "1000001", "1000-001"],
    ["JP", "1000001", "100-0001"],
    ["IE", "d02x285", "D02 X285"],
    ["IE", "D6WK2A4", "D6W K2A4"],
    ["SE", "11455", "114 55"],
    ["CZ", "11000", "110 00"],
    ["SK", "81101", "811 01"],
  ];

  it.each(cases)("%s: %j -> %j", (country, raw, expected) => {
    const r = rule(country);
    const result = normalizePostalCode(raw, r);
    expect(result).toEqual({ value: expected, changed: true });
    expect(compilePostalPattern(r.postalCodePattern ?? "")?.test(result.value)).toBe(true);
    expect(isFormatOnlyPostalChange(raw, result.value)).toBe(true);
  });

  it("BR: 12345678 -> 12345-678", () => {
    expect(normalizePostalCode("01310100", BR_RULE)).toEqual({ value: "01310-100", changed: true });
  });

  it("is idempotent and leaves already normalized values unchanged", () => {
    for (const [country, , expected] of cases) {
      expect(normalizePostalCode(expected, rule(country))).toEqual({ value: expected, changed: false });
    }
    expect(normalizePostalCode("01310-100", BR_RULE)).toEqual({ value: "01310-100", changed: false });
  });

  it("only uppercases and trims for countries without a reformatter", () => {
    expect(normalizePostalCode(" 10115 ", rule("DE"))).toEqual({ value: "10115", changed: true });
    expect(normalizePostalCode("lt-01100", rule("LT"))).toEqual({ value: "LT-01100", changed: true });
    expect(normalizePostalCode("10115", rule("DE"))).toEqual({ value: "10115", changed: false });
  });
});

describe("normalizePostalCode — never adds or removes characters", () => {
  const rejected: Array<[string, string]> = [
    ["PL", "1234"], // не доповнюємо нулем до 01-234
    ["PL", "123456"],
    ["PL", "12.345"],
    ["GB", "SW1A1A"],
    ["GB", "SW1A.1AA"],
    ["GB", "SW1A1AAA"],
    ["CA", "K1A0B"],
    ["CA", "K1A0B12"],
    ["NL", "1011A"],
    ["NL", "1011ABC"],
    ["PT", "100001"],
    ["JP", "10000001"],
    ["IE", "D02X28"],
    ["SE", "SE-11455"],
    ["CZ", "1100"],
    ["SK", "811011"],
  ];

  it.each(rejected)("%s: %j stays as typed (uppercased)", (country, raw) => {
    const result = normalizePostalCode(raw, rule(country));
    expect(result.value).toBe(raw.trim().toUpperCase());
  });

  it("BR: wrong length is not reformatted", () => {
    expect(normalizePostalCode("0131010", BR_RULE).value).toBe("0131010");
  });

  it("isFormatOnlyPostalChange detects added or removed characters", () => {
    expect(isFormatOnlyPostalChange("12345", "12-345")).toBe(true);
    expect(isFormatOnlyPostalChange("sw1a1aa", "SW1A 1AA")).toBe(true);
    expect(isFormatOnlyPostalChange("1234", "01-234")).toBe(false);
    expect(isFormatOnlyPostalChange("123456", "12-345")).toBe(false);
    expect(isFormatOnlyPostalChange("12.345", "12-345")).toBe(false);
  });
});

describe("countries without postcodes", () => {
  it("leaves any value untouched for AE and HK", () => {
    for (const country of ["AE", "HK"]) {
      expect(normalizePostalCode("  po box 123 ", rule(country))).toEqual({ value: "  po box 123 ", changed: false });
      expect(normalizePostalCode("", rule(country))).toEqual({ value: "", changed: false });
    }
  });
});

describe("DEFAULT_COUNTRY_RULES postal data", () => {
  it("every example matches its own pattern and is already normalized", () => {
    for (const r of DEFAULT_COUNTRY_RULES) {
      if (r.postalCodePattern === null) {
        expect(r.postalCodeRequired).toBe(false);
        expect(r.postalCodeExample).toBeNull();
        continue;
      }
      const re = compilePostalPattern(r.postalCodePattern);
      expect(re, r.countryCode).not.toBeNull();
      expect(r.postalCodePattern.startsWith("^") && r.postalCodePattern.endsWith("$"), r.countryCode).toBe(true);
      expect(re?.test(r.postalCodeExample ?? ""), r.countryCode).toBe(true);
      expect(normalizePostalCode(r.postalCodeExample ?? "", r), r.countryCode).toEqual({
        value: r.postalCodeExample,
        changed: false,
      });
    }
  });

  it("country codes are unique uppercase ISO2", () => {
    const codes = DEFAULT_COUNTRY_RULES.map((r) => r.countryCode);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[A-Z]{2}$/);
  });
});

describe("owner-entered postal patterns are safe (stage 4, ReDoS)", () => {
  it("all default country patterns are allowed", async () => {
    const { DEFAULT_COUNTRY_RULES } = await import("~/modules/validation");
    const { isSafePostalPattern, compilePostalPattern } = await import("~/modules/validation/postal");
    for (const r of DEFAULT_COUNTRY_RULES) {
      if (r.postalCodePattern) {
        expect(isSafePostalPattern(r.postalCodePattern), r.countryCode).toBe(true);
        expect(compilePostalPattern(r.postalCodePattern), r.countryCode).not.toBeNull();
      }
    }
  });

  it("rejects unbounded repetition, backreferences and lookarounds; long values are not matched", async () => {
    const { isSafePostalPattern, compilePostalPattern, matchesPostalPattern } = await import("~/modules/validation/postal");
    for (const p of ["(\\d+)+", "\\d*", "(a|aa)+", "\\d{2,}", "(\\d)\\1", "(?=\\d)\\d{5}", "(?<!x)\\d"]) {
      expect(isSafePostalPattern(p), p).toBe(false);
      expect(compilePostalPattern(p), p).toBeNull();
    }
    expect(isSafePostalPattern("[+*]\\d{5}")).toBe(true);
    expect(isSafePostalPattern("\\d{4,5}( [A-Z]{2})?")).toBe(true);
    const rule = { countryCode: "XX", postalCodePattern: "\\d{5}" } as Parameters<typeof matchesPostalPattern>[1];
    const started = Date.now();
    expect(matchesPostalPattern("1".repeat(5000), rule)).toBe(false);
    expect(Date.now() - started).toBeLessThan(50);
  });
});

import { describe, expect, it } from "vitest";
import { parsePhoneNumberFromString } from "libphonenumber-js/max";
import { isDigitPreserving, normalizePhone } from "~/modules/validation/phone";

// Лише вигадані/зразкові номери (UK Ofcom drama range, US 555-01xx, AU ACMA fictional range).

describe("normalizePhone — formatting", () => {
  it("removes spaces, dashes, dots, brackets, slashes and NBSP from international numbers", () => {
    for (const raw of ["+49 151 2345-6789", "+49.151.23456789", "+49 (151) 23456789", "+49/151/23456789", "+49 151 23456789"]) {
      expect(normalizePhone(raw, null)).toEqual({ status: "valid", e164: "+4915123456789", ruleId: "phone.normalize_format" });
    }
  });

  it("returns ruleId null when the number is already E.164", () => {
    expect(normalizePhone("+4915123456789", "DE")).toEqual({ status: "valid", e164: "+4915123456789", ruleId: null });
  });

  it("drops a bracketed trunk prefix after the country code without changing other digits", () => {
    expect(normalizePhone("+49 (0)151 23456789", null)).toEqual({
      status: "valid",
      e164: "+4915123456789",
      ruleId: "phone.normalize_format",
    });
  });
});

describe("normalizePhone — prefixes", () => {
  it("replaces the 00 international prefix with +", () => {
    expect(normalizePhone("0049 151 23456789", null)).toEqual({
      status: "valid",
      e164: "+4915123456789",
      ruleId: "phone.international_prefix_00",
    });
    expect(normalizePhone("0044 20 7946 0123", "DE")).toEqual({
      status: "valid",
      e164: "+442079460123",
      ruleId: "phone.international_prefix_00",
    });
  });

  it("adds a missing plus when the digits already contain the country code", () => {
    expect(normalizePhone("33 6 12 34 56 78", "FR")).toEqual({ status: "valid", e164: "+33612345678", ruleId: "phone.add_plus" });
    expect(normalizePhone("442079460123", null)).toEqual({ status: "valid", e164: "+442079460123", ruleId: "phone.add_plus" });
  });

  it("converts a national number to international using the shipping country", () => {
    expect(normalizePhone("0151 23456789", "DE")).toEqual({
      status: "valid",
      e164: "+4915123456789",
      ruleId: "phone.national_to_international",
    });
    expect(normalizePhone("020 7946 0123", "GB")).toEqual({
      status: "valid",
      e164: "+442079460123",
      ruleId: "phone.national_to_international",
    });
    expect(normalizePhone("(202) 555-0123", "US")).toEqual({
      status: "valid",
      e164: "+12025550123",
      ruleId: "phone.national_to_international",
    });
    expect(normalizePhone("0491 570 156", "AU")).toEqual({
      status: "valid",
      e164: "+61491570156",
      ruleId: "phone.national_to_international",
    });
  });

  it("does not use a national interpretation without a (supported) shipping country", () => {
    expect(normalizePhone("0151 23456789", null)).toEqual({ status: "invalid", reason: "unparseable" });
    expect(normalizePhone("0151 23456789", "ZZ")).toEqual({ status: "invalid", reason: "unparseable" });
  });
});

describe("normalizePhone — ambiguity and invalid input", () => {
  it("reports ambiguity when digits are valid both as +<digits> and as a national number", () => {
    // "4915123456789": +49 151 23456789 (country code without plus) АБО німецький місцевий номер 4915123456789.
    const digits = "4915123456789";
    expect(parsePhoneNumberFromString(`+${digits}`)?.isValid()).toBe(true);
    expect(parsePhoneNumberFromString(digits, "DE")?.isValid()).toBe(true);
    expect(normalizePhone("49 151 23456789", "DE")).toEqual({
      status: "ambiguous",
      // Тлумачення за країною доставки — першим.
      candidates: ["+494915123456789", "+4915123456789"],
    });
  });

  it("rejects letters and other characters", () => {
    for (const raw of ["+49 151 CALL ME", "0151-2345678 ext. 12", "+49 151 2345678#", "++4915123456789", "0151+23456789", "0151–23456789"]) {
      expect(normalizePhone(raw, "DE")).toEqual({ status: "invalid", reason: "characters" });
    }
  });

  it("rejects numbers that do not parse to a valid number (never guesses)", () => {
    for (const raw of ["", "   ", "+", "+49 12", "+0049 151 23456789", "0049 12", "123"]) {
      expect(normalizePhone(raw, "DE")).toEqual({ status: "invalid", reason: "unparseable" });
    }
  });

  it("treats a libphonenumber result that alters digits as invalid", () => {
    // Для AR libphonenumber перетворює мобільний префікс "15" на "9" — це зміна цифр, тому відхиляємо.
    const parsed = parsePhoneNumberFromString("0341 15 234 5678", "AR");
    expect(parsed?.isValid()).toBe(true);
    expect(normalizePhone("0341 15 234 5678", "AR")).toEqual({ status: "invalid", reason: "unparseable" });
  });
});

describe("isDigitPreserving", () => {
  it("accepts dropping a prefix and adding a country code", () => {
    expect(isDigitPreserving("015123456789", { number: "+4915123456789", countryCallingCode: "49", nationalNumber: "15123456789" }, false)).toBe(true);
    expect(isDigitPreserving("49015123456789", { number: "+4915123456789", countryCallingCode: "49", nationalNumber: "15123456789" }, true)).toBe(true);
  });

  it("rejects altered, inserted or inconsistent digits", () => {
    expect(isDigitPreserving("0341152345678", { number: "+5493412345678", countryCallingCode: "54", nationalNumber: "93412345678" }, false)).toBe(false);
    expect(isDigitPreserving("15123456789", { number: "+4915123456780", countryCallingCode: "49", nationalNumber: "15123456780" }, false)).toBe(false);
    expect(isDigitPreserving("4815123456789", { number: "+4915123456789", countryCallingCode: "49", nationalNumber: "15123456789" }, true)).toBe(false);
    expect(isDigitPreserving("15123456789", { number: "+4915123456781", countryCallingCode: "49", nationalNumber: "15123456789" }, false)).toBe(false);
  });
});

describe("never-invent-digits invariant", () => {
  const inputs: Array<[string, string | null]> = [
    ["0151 23456789", "DE"],
    ["49 151 23456789", "DE"],
    ["+49 (0)151 23456789", null],
    ["0049 151 23456789", "PL"],
    ["020 7946 0123", "GB"],
    ["07700 900123", "GB"],
    ["(202) 555-0123", "US"],
    ["1 202 555 0123", "US"],
    ["011 49 151 23456789", "US"],
    ["0491 570 156", "AU"],
    ["06 12 34 56 78", "FR"],
    ["612 345 678", "ES"],
    ["06 1234 5678", "IT"],
    ["0612345678", "NL"],
    ["050 123 4567", "UA"],
    ["0341 15 234 5678", "AR"],
    ["011 15 2345 6789", "AR"],
    ["044 55 1234 5678", "MX"],
    ["0 15 21 98765 4321", "BR"],
    ["15282400135", "DE"],
    ["390703975", "PL"],
    ["+33612345678", "FR"],
  ];

  it.each(inputs)("%s (%s): every result is a suffix-preserving reading of the input digits", (raw, country) => {
    const inputDigits = raw.replace(/\D/g, "");
    const result = normalizePhone(raw, country);
    const outputs = result.status === "valid" ? [result.e164] : result.status === "ambiguous" ? result.candidates : [];
    for (const e164 of outputs) {
      const parsed = parsePhoneNumberFromString(e164);
      expect(parsed?.isValid()).toBe(true);
      expect(parsed?.number).toBe(e164);
      expect(inputDigits.endsWith(parsed?.nationalNumber ?? "\u0000")).toBe(true);
    }
    if (result.status === "ambiguous") expect(new Set(result.candidates).size).toBe(result.candidates.length);
  });
});

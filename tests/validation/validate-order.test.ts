import { describe, expect, it } from "vitest";
import {
  applyAutoFixes,
  buildCountryRuleMap,
  DEFAULT_COUNTRY_RULES,
  ISSUE_CODES,
  issueFingerprint,
  validateOrder,
  type CountryRule,
  type IssueCode,
  type LineItemInput,
  type OrderValidationInput,
  type ValidationIssue,
  type VariantInput,
} from "~/modules/validation";
import { normalizeHsCode } from "~/modules/validation/products";

// Лише вигадані тестові дані (Max Mustermann, example.com, вигадані SKU).
const RULES = buildCountryRuleMap(DEFAULT_COUNTRY_RULES);

function variant(overrides: Partial<VariantInput> = {}): VariantInput {
  return {
    variantId: "var-1",
    sku: "TEST-TEE-M",
    weightGrams: 180,
    hsCode: "6109.10",
    countryOfOrigin: "UA",
    customsDescription: "Cotton T-shirt",
    ...overrides,
  };
}

function item(overrides: Partial<LineItemInput> = {}): LineItemInput {
  return { lineItemId: "li-1", title: "Demo T-shirt", quantity: 1, unitPrice: "24.90", variant: variant(), ...overrides };
}

function order(overrides: Partial<Omit<OrderValidationInput, "shipping">> & { shipping?: Partial<OrderValidationInput["shipping"]> } = {}): OrderValidationInput {
  const { shipping, ...rest } = overrides;
  return {
    orderId: "order-1001",
    email: "max.mustermann@example.com",
    contactPhone: "+4915123456789",
    items: [item()],
    ...rest,
    shipping: {
      firstName: "Max",
      lastName: "Mustermann",
      company: null,
      address1: "Musterstraße 1",
      address2: null,
      city: "Berlin",
      province: null,
      postalCode: "10115",
      countryCode: "DE",
      phone: "+4915123456789",
      ...shipping,
    },
  };
}

const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);
const find = (issues: ValidationIssue[], code: IssueCode) => issues.find((i) => i.code === code);

describe("validateOrder — clean order", () => {
  it("returns no issues, no autofixes and is not blocking", () => {
    expect(validateOrder(order(), RULES)).toEqual({ issues: [], autoFixes: [], blocking: false });
  });

  it("does not mutate the input", () => {
    const input = order({ shipping: { countryCode: " de ", phone: "0151 23456789", postalCode: " 10115 " } });
    const snapshot = structuredClone(input);
    validateOrder(input, RULES);
    expect(input).toEqual(snapshot);
  });
});

describe("validateOrder — autofixes", () => {
  it("emits exactly one fix per field with the most significant rule", () => {
    const input = order({
      email: "  max.mustermann@example.com ",
      contactPhone: " 0049 151 2345 6789 ",
      shipping: {
        firstName: "  Max   ",
        lastName: "Mustermann",
        city: " Berlin\t",
        countryCode: " de ",
        postalCode: " 10115 ",
        phone: "  0151 23456789 ",
      },
    });
    const result = validateOrder(input, RULES);
    expect(result.issues).toEqual([]);
    expect(result.autoFixes).toEqual([
      { field: "shipping.firstName", from: "  Max   ", to: "Max", ruleId: "text.trim_whitespace" },
      { field: "shipping.city", from: " Berlin\t", to: "Berlin", ruleId: "text.trim_whitespace" },
      { field: "shipping.postalCode", from: " 10115 ", to: "10115", ruleId: "text.trim_whitespace" },
      { field: "shipping.countryCode", from: " de ", to: "DE", ruleId: "country.uppercase" },
      { field: "shipping.phone", from: "  0151 23456789 ", to: "+4915123456789", ruleId: "phone.national_to_international" },
      { field: "email", from: "  max.mustermann@example.com ", to: "max.mustermann@example.com", ruleId: "text.trim_whitespace" },
      { field: "contactPhone", from: " 0049 151 2345 6789 ", to: "+4915123456789", ruleId: "phone.international_prefix_00" },
    ]);
    const fields = result.autoFixes.map((f) => f.field);
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("uses postal.normalize_format over whitespace and country rules", () => {
    const result = validateOrder(order({ shipping: { countryCode: "pl", postalCode: "  00950 ", phone: "+48 600 000 000" } }), RULES);
    expect(result.autoFixes).toContainEqual({ field: "shipping.postalCode", from: "  00950 ", to: "00-950", ruleId: "postal.normalize_format" });
    expect(result.autoFixes).toContainEqual({ field: "shipping.countryCode", from: "pl", to: "PL", ruleId: "country.uppercase" });
  });

  it("copies the contact phone into an empty shipping phone", () => {
    const result = validateOrder(order({ contactPhone: "0151 23456789", shipping: { phone: null } }), RULES);
    expect(result.autoFixes).toEqual([
      { field: "shipping.phone", from: null, to: "+4915123456789", ruleId: "phone.copy_contact_phone" },
      { field: "contactPhone", from: "0151 23456789", to: "+4915123456789", ruleId: "phone.national_to_international" },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("whitespace-only value becomes empty; null never becomes an empty-string fix", () => {
    const result = validateOrder(order({ shipping: { company: "   ", address2: null } }), RULES);
    expect(result.autoFixes).toEqual([{ field: "shipping.company", from: "   ", to: "", ruleId: "text.trim_whitespace" }]);
  });

  it("does not autofix an ambiguous phone (only trims it) and suggests candidates", () => {
    const result = validateOrder(order({ contactPhone: null, shipping: { phone: " 49 151 23456789" } }), RULES);
    expect(result.autoFixes).toEqual([
      { field: "shipping.phone", from: " 49 151 23456789", to: "49 151 23456789", ruleId: "text.trim_whitespace" },
    ]);
    expect(find(result.issues, "PHONE_AMBIGUOUS")).toEqual({
      code: "PHONE_AMBIGUOUS",
      severity: "error",
      field: "shipping.phone",
      params: {},
      suggestion: { field: "shipping.phone", candidates: ["+494915123456789", "+4915123456789"] },
    });
    expect(result.blocking).toBe(true);
  });

  it("never autofixes product data", () => {
    const input = order({ items: [item({ variant: variant({ hsCode: " 6109.10 ", countryOfOrigin: " ua ", customsDescription: "  Cotton   T-shirt " }) })] });
    const result = validateOrder(input, RULES);
    expect(result.autoFixes).toEqual([]);
    expect(result.issues).toEqual([]);
    const applied = applyAutoFixes(input, [
      { field: "variant.var-1.hsCode", from: " 6109.10 ", to: "610910", ruleId: "text.trim_whitespace" },
      { field: "lineItem.li-1", from: null, to: "x", ruleId: "text.trim_whitespace" },
    ]);
    expect(applied).toEqual(input);
  });

  it("applyAutoFixes then re-validate yields no autofixes (idempotent)", () => {
    const input = order({
      email: " max.mustermann@example.com",
      contactPhone: "0151 23456789",
      shipping: { firstName: " Max ", countryCode: "gb", city: "London", postalCode: "sw1a1aa", phone: "", address1: " 10  Downing-Test Street " },
    });
    const first = validateOrder(input, RULES);
    expect(first.autoFixes.length).toBeGreaterThan(0);
    const fixed = applyAutoFixes(input, first.autoFixes);
    expect(fixed.shipping.postalCode).toBe("SW1A 1AA");
    expect(fixed.shipping.countryCode).toBe("GB");
    const second = validateOrder(fixed, RULES);
    expect(second.autoFixes).toEqual([]);
    expect(second.issues).toEqual(first.issues);
    expect(applyAutoFixes(fixed, first.autoFixes)).toEqual(fixed);
  });

  it("applyAutoFixes skips stale fixes and does not mutate the input", () => {
    const input = order({ shipping: { city: "Hamburg" } });
    const out = applyAutoFixes(input, [{ field: "shipping.city", from: " Berlin ", to: "Berlin", ruleId: "text.trim_whitespace" }]);
    expect(out.shipping.city).toBe("Hamburg");
    const out2 = applyAutoFixes(input, [{ field: "shipping.city", from: "Hamburg", to: "HAMBURG", ruleId: "text.trim_whitespace" }]);
    expect(out2.shipping.city).toBe("HAMBURG");
    expect(input.shipping.city).toBe("Hamburg");
  });
});

describe("validateOrder — issues", () => {
  it("every validator issue code is reachable", () => {
    const seen = new Set<IssueCode>();
    const collect = (input: OrderValidationInput, rules = RULES) => {
      for (const i of validateOrder(input, rules).issues) seen.add(i.code);
    };

    collect(order({ contactPhone: null, email: "not-an-email", shipping: { phone: null, firstName: null, lastName: " ", address1: null, city: "" } }));
    collect(order({ shipping: { phone: "+49 151 CALL ME" } }));
    collect(order({ contactPhone: null, shipping: { phone: "49 151 23456789" } }));
    collect(order({ shipping: { countryCode: null } }));
    collect(order({ shipping: { countryCode: "ZZ" } }));
    collect(order({ shipping: { countryCode: "RU", postalCode: "101000" } }));
    collect(order({ shipping: { postalCode: null } }));
    collect(order({ shipping: { postalCode: "1011" } }));
    collect(order({ shipping: { countryCode: "US", postalCode: "10001", province: null, phone: "+1 202 555 0123" } }));
    collect(order({ items: [] }));
    collect(
      order({
        items: [
          item({ lineItemId: "li-1", variant: null, unitPrice: "0.00" }),
          item({ lineItemId: "li-2", variant: variant({ weightGrams: null, hsCode: null, countryOfOrigin: "Ukraine", customsDescription: " " }) }),
          item({ lineItemId: "li-3", variant: variant({ variantId: "var-3", hsCode: "61.09" }) }),
        ],
      }),
    );

    const validatorCodes = ISSUE_CODES.filter(
      (c) => !c.startsWith("CARRIER_") && !c.startsWith("SHOPIFY_") && c !== "DELIVERY_PROBLEM", // відстеження, не валідатор
    );
    expect([...seen].sort()).toEqual([...validatorCodes].sort());
  });

  it("missing name/address/city/phone are blocking errors on the right fields", () => {
    const result = validateOrder(order({ contactPhone: null, shipping: { firstName: null, lastName: null, address1: " ", city: null, phone: null } }), RULES);
    expect(result.issues.map((i) => [i.code, i.field, i.severity])).toEqual([
      ["NAME_MISSING", "shipping.lastName", "error"],
      ["ADDRESS_MISSING", "shipping.address1", "error"],
      ["CITY_MISSING", "shipping.city", "error"],
      ["PHONE_MISSING", "shipping.phone", "error"],
    ]);
    expect(result.blocking).toBe(true);
  });

  it("PHONE_MISSING is a warning when the country does not require a phone", () => {
    const relaxed: CountryRule = { ...(RULES.get("DE") as CountryRule), phoneRequired: false };
    const rules = buildCountryRuleMap([relaxed]);
    const result = validateOrder(order({ contactPhone: null, shipping: { phone: null } }), rules);
    expect(result.issues).toEqual([{ code: "PHONE_MISSING", severity: "warning", field: "shipping.phone", params: {}, suggestion: null }]);
    expect(result.blocking).toBe(false);
  });

  it("invalid phone is an error with a reason", () => {
    const result = validateOrder(order({ shipping: { phone: "+49 12" } }), RULES);
    expect(find(result.issues, "PHONE_INVALID")).toMatchObject({ severity: "error", field: "shipping.phone", params: { reason: "unparseable" } });
  });

  it("contactPhone problems are never reported", () => {
    const result = validateOrder(order({ contactPhone: "call me maybe" }), RULES);
    expect(result.issues).toEqual([]);
    expect(result.autoFixes).toEqual([]);
  });

  it("invalid email is only a warning", () => {
    const result = validateOrder(order({ email: "max.mustermann@example" }), RULES);
    expect(result.issues).toEqual([{ code: "EMAIL_INVALID", severity: "warning", field: "email", params: {}, suggestion: null }]);
    expect(result.blocking).toBe(false);
    expect(validateOrder(order({ email: null }), RULES).issues).toEqual([]);
    expect(validateOrder(order({ email: "  " }), RULES).issues).toEqual([]);
  });

  it("disabled country RU blocks shipping", () => {
    const result = validateOrder(order({ shipping: { countryCode: "ru", postalCode: "101000", phone: "+4915123456789" } }), RULES);
    expect(find(result.issues, "COUNTRY_SHIPPING_DISABLED")).toEqual({
      code: "COUNTRY_SHIPPING_DISABLED",
      severity: "error",
      field: "shipping.countryCode",
      params: { country: "RU" },
      suggestion: null,
    });
    expect(result.blocking).toBe(true);
  });

  it("unknown country is unsupported and phone is required", () => {
    const result = validateOrder(order({ contactPhone: null, shipping: { countryCode: "ZZ", postalCode: "anything", phone: null } }), RULES);
    expect(result.issues).toEqual([
      { code: "COUNTRY_UNSUPPORTED", severity: "error", field: "shipping.countryCode", params: { country: "ZZ" }, suggestion: null },
      { code: "PHONE_MISSING", severity: "error", field: "shipping.phone", params: {}, suggestion: null },
    ]);
    // Формат індексу невідомої країни не змінюється.
    expect(result.autoFixes).toEqual([]);
  });

  it("missing country skips country-dependent checks", () => {
    const result = validateOrder(order({ shipping: { countryCode: "  ", postalCode: null } }), RULES);
    expect(codes(result.issues)).toEqual(["COUNTRY_MISSING"]);
  });

  it("postal code missing / invalid carry the example and no suggestion", () => {
    const missing = validateOrder(order({ shipping: { postalCode: "" } }), RULES);
    expect(find(missing.issues, "POSTAL_CODE_MISSING")).toEqual({
      code: "POSTAL_CODE_MISSING",
      severity: "error",
      field: "shipping.postalCode",
      params: { example: "10115" },
      suggestion: null,
    });
    const invalid = validateOrder(order({ shipping: { postalCode: "1011" } }), RULES);
    expect(find(invalid.issues, "POSTAL_CODE_INVALID")).toMatchObject({ field: "shipping.postalCode", params: { example: "10115" }, suggestion: null });
    expect(invalid.autoFixes).toEqual([]);
  });

  it("countries without postcodes accept empty and leave given values untouched", () => {
    const ae = validateOrder(order({ shipping: { countryCode: "AE", city: "Dubai", postalCode: null, phone: "+971 50 123 4567" } }), RULES);
    expect(ae.issues).toEqual([]);
    const hk = validateOrder(order({ shipping: { countryCode: "HK", city: "Hong Kong", postalCode: "box 12", phone: "+85251234567" } }), RULES);
    expect(hk.issues).toEqual([]);
    expect(hk.autoFixes).toEqual([]);
  });

  it("Eircode is optional for IE but validated when given", () => {
    const base = { countryCode: "IE", city: "Dublin", phone: "+353 85 123 4567" };
    expect(validateOrder(order({ shipping: { ...base, postalCode: null } }), RULES).issues).toEqual([]);
    const fixed = validateOrder(order({ shipping: { ...base, postalCode: "d02x285" } }), RULES);
    expect(fixed.issues).toEqual([]);
    expect(fixed.autoFixes).toContainEqual({ field: "shipping.postalCode", from: "d02x285", to: "D02 X285", ruleId: "postal.normalize_format" });
    const invalid = validateOrder(order({ shipping: { ...base, phone: "+353851234567", postalCode: " Dublin 2" } }), RULES);
    expect(codes(invalid.issues)).toEqual(["POSTAL_CODE_INVALID"]);
    // Невалідний індекс лише обрізається, але не переформатовується і не переводиться у верхній регістр.
    expect(invalid.autoFixes).toEqual([{ field: "shipping.postalCode", from: " Dublin 2", to: "Dublin 2", ruleId: "text.trim_whitespace" }]);
  });

  it("province is required for US/CA/AU", () => {
    const us = validateOrder(order({ shipping: { countryCode: "US", postalCode: "10001", province: "", phone: "+1 202 555 0123" } }), RULES);
    expect(codes(us.issues)).toEqual(["PROVINCE_MISSING"]);
    const ok = validateOrder(order({ shipping: { countryCode: "US", postalCode: "10001-1234", province: "NY", phone: "+1 202 555 0123" } }), RULES);
    expect(ok.issues).toEqual([]);
  });
});

describe("validateOrder — products", () => {
  it("reports variant problems once per distinct variant", () => {
    const broken = variant({ variantId: "var-9", sku: "TEST-MUG", weightGrams: 0, hsCode: "", countryOfOrigin: null, customsDescription: null });
    const result = validateOrder(
      order({
        items: [
          item({ lineItemId: "li-1", title: "Demo mug", variant: broken }),
          item({ lineItemId: "li-2", title: "Demo mug", variant: broken }),
          item({ lineItemId: "li-3", title: "Demo mug", variant: { ...broken } }),
        ],
      }),
      RULES,
    );
    expect(result.issues.map((i) => [i.code, i.field])).toEqual([
      ["PRODUCT_WEIGHT_MISSING", "variant.var-9.weightGrams"],
      ["PRODUCT_HS_CODE_MISSING", "variant.var-9.hsCode"],
      ["PRODUCT_ORIGIN_MISSING", "variant.var-9.countryOfOrigin"],
      ["PRODUCT_CUSTOMS_DESCRIPTION_MISSING", "variant.var-9.customsDescription"],
    ]);
    for (const i of result.issues) {
      expect(i.params).toEqual({ title: "Demo mug", sku: "TEST-MUG" });
      expect(i.severity).toBe("error");
    }
  });

  it("line item problems are reported per line item", () => {
    const result = validateOrder(
      order({
        items: [
          item({ lineItemId: "li-1", title: "Unlinked", variant: null }),
          item({ lineItemId: "li-2", title: "Free", unitPrice: "0" }),
          item({ lineItemId: "li-3", title: "Bad price", unitPrice: "abc" }),
          item({ lineItemId: "li-4", title: "Negative", unitPrice: "-5.00" }),
        ],
      }),
      RULES,
    );
    expect(result.issues.map((i) => [i.code, i.field, i.params.title])).toEqual([
      ["PRODUCT_NOT_LINKED", "lineItem.li-1", "Unlinked"],
      ["PRODUCT_PRICE_INVALID", "lineItem.li-2", "Free"],
      ["PRODUCT_PRICE_INVALID", "lineItem.li-3", "Bad price"],
      ["PRODUCT_PRICE_INVALID", "lineItem.li-4", "Negative"],
    ]);
  });

  it("no items -> ORDER_NO_ITEMS on the order", () => {
    expect(validateOrder(order({ items: [] }), RULES).issues).toEqual([
      { code: "ORDER_NO_ITEMS", severity: "error", field: "order", params: {}, suggestion: null },
    ]);
  });

  it("normalizeHsCode keeps 6-10 digits only", () => {
    expect(normalizeHsCode("6109.10")).toBe("610910");
    expect(normalizeHsCode(" 6109 10 00 ")).toBe("61091000");
    expect(normalizeHsCode("6109100000")).toBe("6109100000");
    expect(normalizeHsCode("61.09")).toBeNull();
    expect(normalizeHsCode("61091000001")).toBeNull();
    expect(normalizeHsCode("6109-10")).toBeNull();
    expect(normalizeHsCode(null)).toBeNull();
  });
});

describe("fingerprints and rule map", () => {
  it("issueFingerprint has a stable format", () => {
    expect(issueFingerprint("order-1001", { code: "PHONE_MISSING", field: "shipping.phone" })).toBe("order-1001:PHONE_MISSING:shipping.phone");
    expect(issueFingerprint("order-1001", { code: "ORDER_NO_ITEMS", field: null })).toBe("order-1001:ORDER_NO_ITEMS:");
  });

  it("fingerprints are stable across runs and unique within a result", () => {
    const input = order({ contactPhone: null, shipping: { phone: null, city: null, postalCode: "12" }, items: [item({ variant: variant({ hsCode: null }) })] });
    const fp = (r: ReturnType<typeof validateOrder>) => r.issues.map((i) => issueFingerprint(input.orderId, i));
    const a = fp(validateOrder(input, RULES));
    const b = fp(validateOrder(structuredClone(input), RULES));
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
    expect(a).toContain("order-1001:PRODUCT_HS_CODE_MISSING:variant.var-1.hsCode");
  });

  it("buildCountryRuleMap uppercases keys", () => {
    const de = RULES.get("DE") as CountryRule;
    const map = buildCountryRuleMap([{ ...de, countryCode: " de " }]);
    expect([...map.keys()]).toEqual(["DE"]);
    expect(map.get("DE")?.countryCode).toBe("DE");
    expect(RULES.size).toBe(DEFAULT_COUNTRY_RULES.length);
  });
});

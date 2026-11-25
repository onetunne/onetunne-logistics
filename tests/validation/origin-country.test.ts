import { describe, expect, it } from "vitest";
import { buildCountryRuleMap, DEFAULT_COUNTRY_RULES, normalizePhone, validateOrder } from "~/modules/validation";
import type { OrderValidationInput } from "~/modules/validation/types";

const rules = buildCountryRuleMap(DEFAULT_COUNTRY_RULES);

function order(phone: string, countryCode = "FR"): OrderValidationInput {
  return {
    orderId: "o1",
    email: null,
    contactPhone: null,
    shipping: {
      firstName: "Test",
      lastName: "Customer",
      company: null,
      address1: "1 Example Street",
      address2: null,
      city: "Lyon",
      province: null,
      postalCode: "69001",
      countryCode,
      phone,
    },
    items: [
      {
        lineItemId: "l1",
        title: "Item",
        quantity: 1,
        unitPrice: "10.00",
        variant: { variantId: "v1", sku: "S", weightGrams: 100, hsCode: "871410", countryOfOrigin: "UA", customsDescription: "Part" },
      },
    ],
  };
}

describe("local numbers that are also valid in the origin country (UA)", () => {
  it("are ambiguous and require a manager decision", () => {
    const r = normalizePhone("067 123 45 67", "FR", ["UA"]);
    expect(r.status).toBe("ambiguous");
    if (r.status === "ambiguous") expect(r.candidates.sort()).toEqual(["+33671234567", "+380671234567"]);
    const v = validateOrder(order("067 123 45 67"), rules, { originCountry: "UA" });
    expect(v.autoFixes.find((f) => f.field === "shipping.phone")).toBeUndefined();
    expect(v.issues.map((i) => i.code)).toContain("PHONE_AMBIGUOUS");
  });

  it("stay unambiguous when only one country reading is valid", () => {
    const r = normalizePhone("0151 23456789", "DE", ["UA"]);
    expect(r).toMatchObject({ status: "valid", e164: "+4915123456789" });
    const intl = normalizePhone("+33 6 71 23 45 67", "FR", ["UA"]);
    expect(intl).toMatchObject({ status: "valid", e164: "+33671234567" });
  });

  it("accepts the official L- prefix for Luxembourg", () => {
    const v = validateOrder({ ...order("+352 621 123 456", "LU"), shipping: { ...order("", "LU").shipping, postalCode: "L-1009", phone: "+352 621 123 456", city: "Luxembourg" } }, rules, { originCountry: "UA" });
    expect(v.issues.map((i) => i.code)).not.toContain("POSTAL_CODE_INVALID");
  });
});

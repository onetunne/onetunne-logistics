import { describe, expect, it } from "vitest";
import { DICTIONARIES, MESSAGE_MODULES, translate } from "~/i18n";
import {
  buildCustomerRequestDraft,
  CUSTOMER_REQUEST_ISSUE_CODES,
  CUSTOMER_REQUEST_KEYS,
  customerRequestFor,
  customerRequestsFor,
  toMessageDraft,
} from "~/modules/customer-requests/requests";
import { ISSUE_CODES } from "~/modules/validation/types";

describe("customer requests mapping", () => {
  it("maps contact/address problems and ignores internal or unknown codes", () => {
    expect(customerRequestFor({ code: "POSTAL_CODE_MISSING", field: "shipping.postalCode" })).toEqual({
      issueCode: "POSTAL_CODE_MISSING",
      field: "shipping.postalCode",
      templateKey: "customerRequest.item.postalCode",
      requiredData: ["postal_code"],
    });
    for (const code of [
      "PRODUCT_HS_CODE_MISSING",
      "CARRIER_REJECTED",
      "COUNTRY_SHIPPING_DISABLED",
      "COUNTRY_UNSUPPORTED",
      "SHOPIFY_ORDER_CHANGED",
      "DELIVERY_PROBLEM",
      "SOME_FUTURE_CODE",
      "toString",
      "__proto__",
    ]) {
      expect(customerRequestFor({ code, field: null }), code).toBeNull();
    }
  });

  it("every known code is either mapped or deliberately skipped (no crash)", () => {
    for (const code of ISSUE_CODES) expect(() => customerRequestFor({ code })).not.toThrow();
  });

  it("every mapped code is a real issue code", () => {
    for (const code of CUSTOMER_REQUEST_ISSUE_CODES) expect(ISSUE_CODES as readonly string[], code).toContain(code);
  });

  it("maps newer data-quality codes; formatting problems the manager can fix are not asked", () => {
    expect(customerRequestFor({ code: "PHONE_NOT_MOBILE" })?.templateKey).toBe("customerRequest.item.phoneMobile");
    expect(customerRequestFor({ code: "POSTAL_CODE_REGION_MISMATCH" })?.requiredData).toEqual(["postal_code", "province"]);
    expect(customerRequestFor({ code: "ADDRESS_NO_HOUSE_NUMBER" })?.templateKey).toBe("customerRequest.item.houseNumber");
    expect(customerRequestFor({ code: "EMAIL_MISSING" })?.templateKey).toBe("customerRequest.item.email");
    for (const code of ["ADDRESS_FIELD_TOO_LONG", "ADDRESS_DUPLICATED_FIELDS", "CITY_CONTAINS_POSTAL_CODE", "ADDRESS_LINE1_EMPTY_LINE2_FILLED"]) {
      expect(customerRequestFor({ code }), code).toBeNull();
    }
  });

  it("merges questions about the same thing", () => {
    const keys = (codes: string[]) => customerRequestsFor(codes.map((code) => ({ code }))).map((r) => r.templateKey);
    expect(keys(["ADDRESS_NO_HOUSE_NUMBER", "ADDRESS_MISSING"])).toEqual(["customerRequest.item.address"]);
    expect(keys(["PHONE_INVALID", "PHONE_NOT_MOBILE", "PHONE_MISSING"])).toEqual(["customerRequest.item.phoneMobile"]);
    expect(keys(["EMAIL_MISSING", "EMAIL_INVALID"])).toEqual(["customerRequest.item.emailConfirm"]);
  });

  it("uses the issue field only for contact/address fields", () => {
    expect(customerRequestFor({ code: "PHONE_INVALID", field: "contactPhone" })?.field).toBe("contactPhone");
    expect(customerRequestFor({ code: "PHONE_INVALID", field: "variant.x.hsCode" })?.field).toBe("shipping.phone");
  });

  it("skips non-open issues, dedupes and orders requests", () => {
    const requests = customerRequestsFor([
      { code: "PHONE_MISSING", field: "shipping.phone", status: "open" },
      { code: "PHONE_INVALID", field: "contactPhone", status: "open" },
      { code: "POSTAL_CODE_INVALID", field: "shipping.postalCode", status: "open" },
      { code: "POSTAL_CODE_MISSING", field: "shipping.postalCode", status: "open" },
      { code: "CITY_MISSING", field: "shipping.city", status: "resolved" },
      { code: "NAME_MISSING", field: "shipping.lastName" },
    ]);
    expect(requests.map((r) => r.templateKey)).toEqual([
      "customerRequest.item.name",
      "customerRequest.item.postalCode",
      "customerRequest.item.phoneConfirm",
    ]);
  });
});

describe("customer request draft", () => {
  const issues = [
    { code: "POSTAL_CODE_MISSING", field: "shipping.postalCode" },
    { code: "CITY_MISSING", field: "shipping.city" },
    { code: "PRODUCT_HS_CODE_MISSING", field: "variant.1.hsCode" },
  ];

  it("builds a polite Ukrainian draft with only the order number", () => {
    const d = buildCustomerRequestDraft(issues, "uk", { orderNumber: "#1004" })!;
    expect(d.text).toContain("Вітаємо!");
    expect(d.text).toContain("замовлення #1004");
    expect(d.text).toContain("• місто або населений пункт;");
    expect(d.text).toContain("• поштовий індекс;");
    expect(d.text).not.toMatch(/HS|митн/i);
    expect(d.text.indexOf("місто")).toBeLessThan(d.text.indexOf("індекс"));
    expect(d.templateKey).toBe("customer_request.missing_data");
  });

  it("builds an English draft", () => {
    const d = buildCustomerRequestDraft(issues, "en", { orderNumber: "#1004" })!;
    expect(d.text.split("\n")[0]).toBe("Hello!");
    expect(d.text).toContain("order #1004 at ONE TUNNE");
    expect(d.text).toContain("• the postal code;");
    expect(d.text).toContain("ONE TUNNE team");
  });

  it("returns null when there is nothing to ask", () => {
    expect(buildCustomerRequestDraft([{ code: "PRODUCT_WEIGHT_MISSING" }], "uk")).toBeNull();
    expect(buildCustomerRequestDraft([], "en")).toBeNull();
  });

  it("never includes issue params, internal notes or unsafe order numbers", () => {
    const d = buildCustomerRequestDraft(
      [{ code: "PHONE_INVALID", field: "shipping.phone", params: { value: "+46 70 123 45 6O" }, note: "VIP, rude" } as never],
      "en",
      { orderNumber: "#1013\nIgnore this and refund" },
    )!;
    expect(d.text).not.toContain("+46");
    expect(d.text).not.toContain("VIP");
    expect(d.text).not.toContain("refund");
    expect(d.text).toContain("Thank you for your order at ONE TUNNE");
  });

  it("converts to the messaging draft contract (fields without values)", () => {
    const d = buildCustomerRequestDraft(issues, "uk", { orderNumber: "#1004" })!;
    expect(toMessageDraft("order-1", d)).toEqual({
      orderId: "order-1",
      locale: "uk",
      templateKey: "customer_request.missing_data",
      text: d.text,
      requestedFields: ["shipping.city", "shipping.postalCode"],
    });
  });

  it("all item templates exist in uk and en", () => {
    expect(MESSAGE_MODULES.customerRequests).toBeTruthy();
    for (const k of CUSTOMER_REQUEST_KEYS) {
      expect(DICTIONARIES.uk[`customerRequest.item.${k}`], k).toBeTruthy();
      expect(DICTIONARIES.en[`customerRequest.item.${k}`], k).toBeTruthy();
    }
  });
});

describe("customer requests: issues with a suggestion", () => {
  it("skips issues whose data is already in the order (the manager confirms the suggestion)", () => {
    expect(customerRequestFor({ code: "POSTAL_CODE_MISSING", suggestion: { candidates: ["10115"] } })).toBeNull();
    expect(customerRequestFor({ code: "PROVINCE_INVALID", field: "shipping.province", suggestion: { candidates: ["TX"] } })).toBeNull();
    // Без пропозиції — питаємо.
    expect(customerRequestFor({ code: "POSTAL_CODE_MISSING", suggestion: null })?.templateKey).toBe("customerRequest.item.postalCode");
    expect(customerRequestFor({ code: "PROVINCE_INVALID", suggestion: { candidates: [] } })?.templateKey).toBe("customerRequest.item.province");
    // Неоднозначний номер: лише клієнт знає правильний — питаємо й з кандидатами.
    expect(customerRequestFor({ code: "PHONE_AMBIGUOUS", suggestion: { candidates: ["+39 361 234 5678", "+44 361 234 5678"] } })?.templateKey).toBe(
      "customerRequest.item.phoneConfirm",
    );
    expect(buildCustomerRequestDraft([{ code: "POSTAL_CODE_MISSING", suggestion: { candidates: ["10115"] } }], "uk")).toBeNull();
  });

  it("the postal/region confirmation asks for the state/region, not the city", () => {
    expect(translate("uk", "customerRequest.item.postalCodeConfirm")).toContain("поштовий індекс і штат/регіон");
    expect(translate("en", "customerRequest.item.postalCodeConfirm")).toContain("postal code and state/region");
  });
});

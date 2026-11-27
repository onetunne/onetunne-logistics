import { describe, expect, it } from "vitest";
import messages from "~/i18n/messages/validation";
import { AUTO_FIX_RULES, ISSUE_CODES, SHIPPING_FIELDS, VARIANT_CUSTOMS_FIELDS } from "~/modules/validation/types";

const requiredKeys = [
  ...ISSUE_CODES.flatMap((code) => [`issue.${code}.title`, `issue.${code}.help`]),
  ...AUTO_FIX_RULES.map((rule) => `autofix.${rule}`),
  ...SHIPPING_FIELDS.map((field) => `field.shipping.${field}`),
  "field.email",
  "field.contactPhone",
  ...VARIANT_CUSTOMS_FIELDS.map((field) => `field.variant.${field}`),
  "field.lineItem",
  "field.order",
];

const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe("validation i18n messages", () => {
  it.each(["uk", "en"] as const)("%s has every required key with a non-empty value", (locale) => {
    for (const key of requiredKeys) {
      const value = messages[locale][key];
      expect(value, `${locale}:${key}`).toBeTypeOf("string");
      expect(value?.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  it("uk and en have identical key sets and no empty strings", () => {
    expect(Object.keys(messages.uk).sort()).toEqual(Object.keys(messages.en).sort());
    for (const locale of ["uk", "en"] as const) {
      for (const [key, value] of Object.entries(messages[locale])) expect(value.trim(), `${locale}:${key}`).not.toBe("");
    }
  });

  it("uk and en use the same placeholders", () => {
    for (const key of Object.keys(messages.uk)) {
      expect(placeholders(messages.en[key] ?? ""), key).toEqual(placeholders(messages.uk[key] ?? ""));
    }
  });

  it("help texts use only params that validators provide", () => {
    const allowed = new Set(["country", "example", "title", "sku", "max", "phoneCountry", "prefix", "province", "expected"]);
    for (const locale of ["uk", "en"] as const) {
      for (const [key, value] of Object.entries(messages[locale])) {
        // Проблеми синхронізації Shopify створює сервіс синхронізації з власними параметрами.
        const extra = key.startsWith("issue.SHOPIFY_")
          ? ["fields", "message", "reason", "shipsTo"]
          : key.startsWith("issue.DELIVERY_PROBLEM") || key.startsWith("issue.CARRIER_SHIPMENT_DELETED")
            ? ["carrier", "code", "status", "waybill"] // створюються сервісом відстеження, не валідатором
            : [];
        for (const p of placeholders(value)) expect(allowed.has(p ?? "") || extra.includes(p ?? ""), `${locale}:${key} {${p}}`).toBe(true);
      }
    }
  });
});

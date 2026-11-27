import { describe, expect, it } from "vitest";
import { makeT } from "~/i18n";
import { localizeCountry, localizeParams } from "~/i18n/localize";

const uk = makeT("uk");
const en = makeT("en");

describe("localizeParams", () => {
  it("country codes in `country` / `phoneCountry` become country names (code kept)", () => {
    const p = localizeParams({ country: "US", phoneCountry: "ua" }, uk, "uk");
    expect(p?.country).toMatch(/^Сполучені Штати.* \(US\)$/);
    expect(p?.phoneCountry).toBe("Україна (UA)");
    const text = uk("issue.PHONE_COUNTRY_MISMATCH.help", p);
    expect(text).toContain("Номер належить країні Україна (UA)");
    expect(text).not.toMatch(/країні UA,/);
    expect(localizeParams({ country: "DE" }, en, "en")?.country).toBe("Germany (DE)");
  });

  it("non-ISO values stay as they are", () => {
    expect(localizeCountry("Germany", "uk")).toBe("Germany");
    expect(localizeCountry("", "uk")).toBe("");
    expect(localizeParams({ country: 5 }, uk, "uk")?.country).toBe(5);
  });

  it("field lists use field.* labels (order fields) and shipper labels, unknown fields raw", () => {
    expect(localizeParams({ fields: "shipping.address1, shipping.city, email" }, uk, "uk")?.fields).toBe(
      `${uk("field.shipping.address1")}, Місто, Email`,
    );
    expect(localizeParams({ fields: "companyName,phone" }, uk, "uk")?.fields).toBe("назва компанії, телефон");
    expect(localizeParams({ fields: "shipping.unknownThing" }, en, "en")?.fields).toBe("shipping.unknownThing");
  });

  it("status and service codes are still localized", () => {
    expect(localizeParams({ status: "awaiting_review" }, uk, "uk")?.status).toBe("Очікує перевірки");
    expect(localizeParams(undefined, uk, "uk")).toBeUndefined();
  });
});

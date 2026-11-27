import { describe, expect, it } from "vitest";
import {
  applyAutoFixes,
  buildCountryRuleMap,
  checkPostalRegion,
  DEFAULT_COUNTRY_RULES,
  describePhone,
  extractPostalFromCity,
  findRegionByCode,
  ISSUE_CATEGORIES,
  ISSUE_CODES,
  issueCategory,
  isIssueCategory,
  regionCandidates,
  REGIONS,
  regionsOf,
  validateOrder,
  type IssueCode,
  type OrderValidationInput,
  type ValidationIssue,
  type ValidationOptions,
} from "~/modules/validation";
import { regionNameKey } from "~/modules/validation/regions";

// Лише вигадані тестові дані (example.com, шаблонні імена, вигадані адреси).
const RULES = buildCountryRuleMap(DEFAULT_COUNTRY_RULES);
const UA: ValidationOptions = { originCountry: "UA" };

type ShippingOverrides = Partial<OrderValidationInput["shipping"]>;

function order(shipping: ShippingOverrides = {}, rest: Partial<Omit<OrderValidationInput, "shipping">> = {}): OrderValidationInput {
  return {
    orderId: "order-2001",
    email: "max.mustermann@example.com",
    contactPhone: null,
    items: [
      {
        lineItemId: "li-1",
        title: "Demo T-shirt",
        quantity: 1,
        unitPrice: "24.90",
        variant: { variantId: "var-1", sku: "TEST-1", weightGrams: 180, hsCode: "610910", countryOfOrigin: "UA", customsDescription: "Cotton T-shirt" },
      },
    ],
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

const US = { countryCode: "US", city: "New York", postalCode: "10001", province: "NY", phone: "+1 202 555 0123", address1: "1 Example Ave" };
const CA = { countryCode: "CA", city: "Ottawa", postalCode: "K1A 0B1", province: "ON", phone: "+1 613 555 0199", address1: "100 Example Rd" };
const AU = { countryCode: "AU", city: "Sydney", postalCode: "2000", province: "NSW", phone: "+61 412 345 678", address1: "1 Example St" };

const codes = (issues: ValidationIssue[]) => issues.map((i) => i.code);
const find = (issues: ValidationIssue[], code: IssueCode, field?: string) =>
  issues.find((i) => i.code === code && (field === undefined || i.field === field));
const run = (shipping: ShippingOverrides = {}, rest: Partial<Omit<OrderValidationInput, "shipping">> = {}, options: ValidationOptions = UA) =>
  validateOrder(order(shipping, rest), RULES, options);

describe("baseline", () => {
  it("clean DE / US / CA / AU orders have no issues and no autofixes, also with an origin country", () => {
    for (const shipping of [{}, US, CA, AU]) {
      expect(run(shipping), JSON.stringify(shipping)).toMatchObject({ issues: [], blocking: false });
    }
    expect(run(US).autoFixes.filter((f) => f.field !== "shipping.phone")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1. Регіони
// ---------------------------------------------------------------------------

describe("regions dataset", () => {
  it("covers every default country that requires a region", () => {
    const required = DEFAULT_COUNTRY_RULES.filter((r) => r.provinceRequired).map((r) => r.countryCode);
    expect(required.sort()).toEqual(["AU", "CA", "US"]);
    for (const c of required) expect(regionsOf(c), c).not.toBeNull();
  });

  it("has the expected number of unique codes and names", () => {
    expect(REGIONS.US).toHaveLength(62); // 50 штатів + DC + 5 територій + 3 вільно асоційовані + 3 військові
    expect(REGIONS.CA).toHaveLength(13);
    expect(REGIONS.AU).toHaveLength(8);
    for (const [country, list] of Object.entries(REGIONS)) {
      const codes = list.map((r) => r.code);
      expect(new Set(codes).size, country).toBe(codes.length);
      for (const code of codes) expect(code, `${country}:${code}`).toMatch(/^[A-Z]{2,3}$/);
      const names = list.flatMap((r) => [r.name, ...(r.aliases ?? [])].map(regionNameKey));
      expect(new Set(names).size, country).toBe(names.length);
    }
    expect(REGIONS.US?.filter((r) => r.kind === "state")).toHaveLength(50);
    expect(findRegionByCode("US", "UM")).toBeNull(); // не код USPS — свідомо не включено
    expect(findRegionByCode("AU", "TAS")?.name).toBe("Tasmania");
    expect(findRegionByCode("CA", "QC")?.name).toBe("Quebec");
  });

  it("lookups are exact and case-sensitive; unknown country has no dataset", () => {
    expect(findRegionByCode("US", "NY")?.name).toBe("New York");
    expect(findRegionByCode("US", "ny")).toBeNull();
    expect(findRegionByCode("us", "NY")?.code).toBe("NY");
    expect(findRegionByCode("DE", "BY")).toBeNull();
    expect(findRegionByCode(null, "NY")).toBeNull();
    expect(regionsOf("DE")).toBeNull();
  });

  it("regionCandidates matches only whole names, aliases or a full ISO 3166-2 code", () => {
    expect(regionCandidates("US", "New York")).toEqual(["NY"]);
    expect(regionCandidates("US", "  new   york ")).toEqual(["NY"]);
    expect(regionCandidates("CA", "Québec")).toEqual(["QC"]);
    expect(regionCandidates("CA", "QUEBEC")).toEqual(["QC"]);
    expect(regionCandidates("US", "Washington")).toEqual(["WA"]);
    expect(regionCandidates("US", "Washington, D.C.")).toEqual(["DC"]);
    expect(regionCandidates("US", "U.S. Virgin Islands")).toEqual(["VI"]);
    expect(regionCandidates("US", "Virgin Islands, U.S.")).toEqual(["VI"]);
    expect(regionCandidates("US", "US-NY")).toEqual(["NY"]);
    expect(regionCandidates("AU", "au-nsw")).toEqual(["NSW"]);
    expect(regionCandidates("AU", "Northern Territory")).toEqual(["NT"]);
    // Без вгадування: частковий збіг, чужа країна, скорочення з крапками.
    expect(regionCandidates("US", "New")).toEqual([]);
    expect(regionCandidates("US", "York")).toEqual([]);
    expect(regionCandidates("US", "Ontario")).toEqual([]);
    expect(regionCandidates("US", "CA-ON")).toEqual([]);
    expect(regionCandidates("US", "N.Y.")).toEqual([]);
    expect(regionCandidates("US", "")).toEqual([]);
    expect(regionCandidates("DE", "Bayern")).toEqual([]);
  });
});

describe("province validation", () => {
  it("auto-fixes a lowercase / padded known code to upper case (province.uppercase)", () => {
    const us = run({ ...US, province: " ny " });
    expect(us.autoFixes).toContainEqual({ field: "shipping.province", from: " ny ", to: "NY", ruleId: "province.uppercase" });
    expect(us.issues).toEqual([]);
    const ca = run({ ...CA, province: "Qc", postalCode: "H2X 1Y4", city: "Montréal", phone: "+1 514 555 0100" });
    expect(ca.autoFixes).toContainEqual({ field: "shipping.province", from: "Qc", to: "QC", ruleId: "province.uppercase" });
    expect(ca.issues).toEqual([]);
    const au = run({ ...AU, province: "nsw" });
    expect(au.autoFixes).toContainEqual({ field: "shipping.province", from: "nsw", to: "NSW", ruleId: "province.uppercase" });
  });

  it("an already upper-case code with spaces only gets trimmed", () => {
    const r = run({ ...US, province: " NY" });
    expect(r.autoFixes).toContainEqual({ field: "shipping.province", from: " NY", to: "NY", ruleId: "text.trim_whitespace" });
  });

  it("autofix is idempotent", () => {
    const input = order({ ...US, province: "tx", postalCode: "73301", city: "Austin" });
    const first = validateOrder(input, RULES, UA);
    const fixed = applyAutoFixes(input, first.autoFixes);
    expect(fixed.shipping.province).toBe("TX");
    expect(validateOrder(fixed, RULES, UA).autoFixes).toEqual([]);
  });

  it("a full name is NOT auto-applied: error with a single suggested code", () => {
    const r = run({ ...US, province: "New York" });
    expect(r.autoFixes.find((f) => f.field === "shipping.province")).toBeUndefined();
    expect(find(r.issues, "PROVINCE_INVALID")).toEqual({
      code: "PROVINCE_INVALID",
      severity: "error",
      field: "shipping.province",
      params: { country: "US" },
      suggestion: { field: "shipping.province", candidates: ["NY"] },
    });
    expect(r.blocking).toBe(true);
  });

  it("diacritics/case-insensitive name match for Canada", () => {
    const r = run({ ...CA, province: "québec", postalCode: "H2X 1Y4", city: "Montréal", phone: "+1 514 555 0100" });
    expect(find(r.issues, "PROVINCE_INVALID")?.suggestion).toEqual({ field: "shipping.province", candidates: ["QC"] });
  });

  it("unknown value → error without a suggestion; lowercase unknown code is not upper-cased", () => {
    const r = run({ ...US, province: "zz" });
    expect(r.autoFixes.find((f) => f.field === "shipping.province")).toBeUndefined();
    expect(find(r.issues, "PROVINCE_INVALID")).toMatchObject({ severity: "error", suggestion: null, params: { country: "US" } });
    // Код іншої країни не є кодом цієї.
    expect(find(run({ ...US, province: "ON" }).issues, "PROVINCE_INVALID")?.suggestion).toBeNull();
  });

  it("countries without a region dataset are not checked and never changed", () => {
    const r = run({ province: "by" });
    expect(r.issues).toEqual([]);
    expect(r.autoFixes).toEqual([]);
  });

  it("an empty province still gives PROVINCE_MISSING only", () => {
    expect(codes(run({ ...US, province: null }).issues)).toEqual(["PROVINCE_MISSING"]);
  });
});

// ---------------------------------------------------------------------------
// 2. Індекс ↔ регіон
// ---------------------------------------------------------------------------

describe("postal code ↔ region consistency", () => {
  it("Canada: first letter must match the province", () => {
    const table: Record<string, string[]> = {
      A: ["NL"], B: ["NS"], C: ["PE"], E: ["NB"], G: ["QC"], H: ["QC"], J: ["QC"], K: ["ON"], L: ["ON"], M: ["ON"],
      N: ["ON"], P: ["ON"], R: ["MB"], S: ["SK"], T: ["AB"], V: ["BC"], X: ["NT", "NU"], Y: ["YT"],
    };
    const all = REGIONS.CA?.map((r) => r.code) ?? [];
    for (const [letter, ok] of Object.entries(table)) {
      for (const province of all) {
        const result = checkPostalRegion("CA", `${letter}1A 1A1`, province);
        if (ok.includes(province)) expect(result, `${letter}/${province}`).toBeNull();
        else expect(result, `${letter}/${province}`).toEqual({ prefix: letter, expected: ok });
      }
    }
  });

  it("Canada mismatch is a warning with params and never changes data", () => {
    const r = run({ ...CA, province: "QC" });
    expect(r.autoFixes.filter((f) => f.field !== "shipping.phone")).toEqual([]);
    expect(r.issues).toEqual([
      {
        code: "POSTAL_CODE_REGION_MISMATCH",
        severity: "warning",
        field: "shipping.postalCode",
        params: { prefix: "K", province: "QC", expected: "ON" },
        suggestion: null,
      },
    ]);
    expect(r.blocking).toBe(false);
    expect(find(run({ ...CA, province: "YT", postalCode: "X0A 0H0" }).issues, "POSTAL_CODE_REGION_MISMATCH")?.params).toEqual({
      prefix: "X",
      province: "YT",
      expected: "NT, NU",
    });
    expect(run({ ...CA, province: "NU", postalCode: "X0A 0H0" }).issues).toEqual([]);
    expect(run({ ...CA, province: "NT", postalCode: "X1A 2P8" }).issues).toEqual([]);
  });

  it("US: first ZIP digit must match the state's national area", () => {
    expect(run({ ...US, province: "NJ" }).issues).toEqual([
      {
        code: "POSTAL_CODE_REGION_MISMATCH",
        severity: "warning",
        field: "shipping.postalCode",
        params: { prefix: "1", province: "NJ", expected: "DE, NY, PA" },
        suggestion: null,
      },
    ]);
    const ok: Array<[string, string]> = [
      ["07001", "NJ"], ["00901", "PR"], ["00802", "VI"], ["02108", "MA"], ["19901", "DE"], ["20001", "DC"],
      ["33101", "FL"], ["60601", "IL"], ["73301", "TX"], ["75201", "TX"], ["80202", "CO"], ["90001", "CA"],
      ["96701", "HI"], ["99501", "AK"], ["96910", "GU"], ["96950", "MP"], ["96799", "AS"], ["96941", "FM"],
      ["96960", "MH"], ["96940", "PW"], ["09001", "AE"], ["34001", "AA"], ["96201", "AP"],
    ];
    for (const [zip, state] of ok) expect(checkPostalRegion("US", zip, state), `${zip}/${state}`).toBeNull();
    expect(checkPostalRegion("US", "90001", "NY")).toMatchObject({ prefix: "9" });
    expect(checkPostalRegion("US", "30301", "AE")).toMatchObject({ prefix: "3" });
  });

  it("US: documented cross-area exceptions are accepted (NY 005/06390, TX 885, DC 569)", () => {
    expect(checkPostalRegion("US", "00501", "NY")).toBeNull();
    expect(checkPostalRegion("US", "06390", "NY")).toBeNull();
    expect(checkPostalRegion("US", "88510", "TX")).toBeNull();
    expect(checkPostalRegion("US", "56901", "DC")).toBeNull();
    // Але не для інших штатів і не для сусідніх префіксів.
    expect(checkPostalRegion("US", "06391", "NY")).not.toBeNull();
    expect(checkPostalRegion("US", "88510", "OK")).not.toBeNull();
    expect(checkPostalRegion("US", "56901", "VA")).not.toBeNull();
    expect(run({ ...US, postalCode: "88510-1234", province: "TX", city: "El Paso" }).issues).toEqual([]);
  });

  it("is skipped when postal code is invalid, the region unknown, or the country has no table", () => {
    expect(codes(run({ ...US, postalCode: "1000", province: "NJ" }).issues)).toEqual(["POSTAL_CODE_INVALID"]);
    expect(codes(run({ ...US, province: "New Jersey" }).issues)).toEqual(["PROVINCE_INVALID"]);
    expect(run({ ...AU, province: "VIC" }).issues).toEqual([]); // для AU таблиці немає
    expect(checkPostalRegion("DE", "10115", "BE")).toBeNull();
    expect(checkPostalRegion("US", "", "NY")).toBeNull();
    expect(checkPostalRegion("US", "10001", "ZZ")).toBeNull();
  });

  it("is checked after autofixes (lowercase CA postal + lowercase province)", () => {
    const r = run({ ...CA, postalCode: "k1a0b1", province: "qc" });
    expect(r.autoFixes).toContainEqual({ field: "shipping.postalCode", from: "k1a0b1", to: "K1A 0B1", ruleId: "postal.normalize_format" });
    expect(r.autoFixes).toContainEqual({ field: "shipping.province", from: "qc", to: "QC", ruleId: "province.uppercase" });
    expect(codes(r.issues)).toEqual(["POSTAL_CODE_REGION_MISMATCH"]);
  });
});

// ---------------------------------------------------------------------------
// 3. Індекс у полі «Місто»
// ---------------------------------------------------------------------------

describe("postal code inside the city field", () => {
  const de = RULES.get("DE");
  const nl = RULES.get("NL");
  const gb = RULES.get("GB");

  it("extractPostalFromCity finds a leading or trailing code that matches the country format", () => {
    expect(extractPostalFromCity("10115 Berlin", de)).toEqual([{ city: "Berlin", postalCode: "10115" }]);
    expect(extractPostalFromCity("Berlin 10115", de)).toEqual([{ city: "Berlin", postalCode: "10115" }]);
    expect(extractPostalFromCity("Berlin, 10115", de)).toEqual([{ city: "Berlin", postalCode: "10115" }]);
    expect(extractPostalFromCity("Berlin,10115", de)).toEqual([{ city: "Berlin", postalCode: "10115" }]);
    expect(extractPostalFromCity("10115 - Berlin", de)).toEqual([{ city: "Berlin", postalCode: "10115" }]);
    expect(extractPostalFromCity("Frankfurt am Main 60311", de)).toEqual([{ city: "Frankfurt am Main", postalCode: "60311" }]);
    expect(extractPostalFromCity("1011 AB Amsterdam", nl)).toEqual([{ city: "Amsterdam", postalCode: "1011 AB" }]);
    expect(extractPostalFromCity("Amsterdam 1011ab", nl)).toEqual([{ city: "Amsterdam", postalCode: "1011 AB" }]);
    expect(extractPostalFromCity("London SW1A 1AA", gb)).toEqual([{ city: "London", postalCode: "SW1A 1AA" }]);
  });

  it("never treats other numbers as a postal code and never invents one", () => {
    expect(extractPostalFromCity("Berlin", de)).toEqual([]);
    expect(extractPostalFromCity("10115", de)).toEqual([]); // лише індекс — це не «місто з індексом»
    expect(extractPostalFromCity("Berlin 1011", de)).toEqual([]);
    expect(extractPostalFromCity("Berlin 101155", de)).toEqual([]);
    expect(extractPostalFromCity("Dublin 2", RULES.get("IE"))).toEqual([]);
    expect(extractPostalFromCity("Paris 8", RULES.get("FR"))).toEqual([]);
    expect(extractPostalFromCity("Dubai 12345", RULES.get("AE"))).toEqual([]); // країна без індексів
    expect(extractPostalFromCity("Amsterdam 1011", nl)).toEqual([]);
    expect(extractPostalFromCity(null, de)).toEqual([]);
    expect(extractPostalFromCity("10115 Berlin", undefined)).toEqual([]);
    // Кандидати — лише частини введеного тексту.
    for (const e of extractPostalFromCity("Hamburg 20095", de)) {
      expect("Hamburg 20095").toContain(e.city);
      expect("Hamburg 20095".replace(/\s/g, "")).toContain(e.postalCode.replace(/\s/g, ""));
    }
  });

  it("several readings are all returned for a manager decision", () => {
    expect(extractPostalFromCity("10115 Berlin 10117", de)).toEqual([
      { city: "Berlin 10117", postalCode: "10115" },
      { city: "10115 Berlin", postalCode: "10117" },
    ]);
  });

  it("same postal code in both fields → warning with the city suggestion; city is not auto-changed", () => {
    const r = run({ city: "10115 Berlin" });
    expect(r.autoFixes).toEqual([]);
    expect(r.issues).toEqual([
      {
        code: "CITY_CONTAINS_POSTAL_CODE",
        severity: "warning",
        field: "shipping.city",
        params: {},
        suggestion: { field: "shipping.city", candidates: ["Berlin"] },
      },
    ]);
    expect(r.blocking).toBe(false);
  });

  it("empty postal code → POSTAL_CODE_MISSING suggests the code from the city (not auto-applied)", () => {
    const r = run({ city: "Berlin 10115", postalCode: null });
    expect(r.autoFixes).toEqual([]);
    expect(find(r.issues, "POSTAL_CODE_MISSING")).toEqual({
      code: "POSTAL_CODE_MISSING",
      severity: "error",
      field: "shipping.postalCode",
      params: { example: "10115" },
      suggestion: { field: "shipping.postalCode", candidates: ["10115"] },
    });
    expect(find(r.issues, "CITY_CONTAINS_POSTAL_CODE")?.suggestion).toEqual({ field: "shipping.city", candidates: ["Berlin"] });
    const nl = run({ countryCode: "NL", city: "1011ab Amsterdam", postalCode: "", address1: "Voorbeeldstraat 7", phone: "+31 6 12345678" });
    expect(find(nl.issues, "POSTAL_CODE_MISSING")?.suggestion?.candidates).toEqual(["1011 AB"]);
  });

  it("a different postal code in the postal field → warning only, no suggestion", () => {
    const r = run({ city: "10115 Berlin", postalCode: "10117" });
    expect(r.issues).toEqual([
      { code: "CITY_CONTAINS_POSTAL_CODE", severity: "warning", field: "shipping.city", params: {}, suggestion: null },
    ]);
  });

  it("postal field in another format but same code still counts as the same code", () => {
    const r = run({ countryCode: "PL", city: "Warszawa 00-950", postalCode: "00950", address1: "ul. Przykładowa 5", phone: "+48 512 345 678" });
    expect(find(r.issues, "CITY_CONTAINS_POSTAL_CODE")?.suggestion?.candidates).toEqual(["Warszawa"]);
  });

  it("countries without postcodes are not checked", () => {
    const r = run({ countryCode: "AE", city: "Dubai 00000", postalCode: null, address1: "Example Tower 1", phone: "+971 50 123 4567" });
    expect(r.issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Рядки адреси
// ---------------------------------------------------------------------------

describe("address lines", () => {
  it("empty line 1 with filled line 2 → blocking error suggesting the line-2 value (replaces ADDRESS_MISSING)", () => {
    const r = run({ address1: null, address2: "  Musterstraße   1 " });
    expect(r.autoFixes.find((f) => f.field === "shipping.address1")).toBeUndefined();
    expect(r.issues).toEqual([
      {
        code: "ADDRESS_LINE1_EMPTY_LINE2_FILLED",
        severity: "error",
        field: "shipping.address1",
        params: {},
        suggestion: { field: "shipping.address1", candidates: ["Musterstraße 1"] },
      },
    ]);
    expect(r.blocking).toBe(true);
    expect(codes(run({ address1: " ", address2: "" }).issues)).toEqual(["ADDRESS_MISSING"]);
  });

  it("no digit in either line → warning ADDRESS_NO_HOUSE_NUMBER", () => {
    const r = run({ address1: "Musterstraße" });
    expect(r.issues).toEqual([{ code: "ADDRESS_NO_HOUSE_NUMBER", severity: "warning", field: "shipping.address1", params: {}, suggestion: null }]);
    expect(r.blocking).toBe(false);
    expect(run({ address1: "Musterstraße", address2: "Wohnung 3" }).issues).toEqual([]);
    expect(run({ address1: "Musterstraße 1a" }).issues).toEqual([]);
  });

  it("house number warning is skipped where addresses without numbers are common", () => {
    expect(run({ countryCode: "IE", city: "Dublin", postalCode: null, address1: "Main Street", phone: "+353 85 123 4567" }).issues).toEqual([]);
    expect(run({ countryCode: "AE", city: "Dubai", postalCode: null, address1: "Example Tower", phone: "+971 50 123 4567" }).issues).toEqual([]);
    expect(run({ countryCode: "HK", city: "Hong Kong", postalCode: null, address1: "Example Building", phone: "+85251234567" }).issues).toEqual([]);
  });

  it("fields over the carrier limits → error with {field, max}", () => {
    expect(run({ address1: `Musterstraße 1 ${"x".repeat(85)}` }).issues).toEqual([]); // ровно 100
    const r = run({
      address1: `Musterstraße 1 ${"x".repeat(86)}`,
      address2: "y".repeat(101),
      city: "Z".repeat(101),
    });
    expect(r.issues.filter((i) => i.code === "ADDRESS_FIELD_TOO_LONG")).toEqual([
      { code: "ADDRESS_FIELD_TOO_LONG", severity: "error", field: "shipping.address1", params: { field: "address1", max: 100 }, suggestion: null },
      { code: "ADDRESS_FIELD_TOO_LONG", severity: "error", field: "shipping.address2", params: { field: "address2", max: 100 }, suggestion: null },
      { code: "ADDRESS_FIELD_TOO_LONG", severity: "error", field: "shipping.city", params: { field: "city", max: 100 }, suggestion: null },
    ]);
    expect(r.blocking).toBe(true);
    const province = run({ ...US, province: "P".repeat(101) });
    expect(find(province.issues, "ADDRESS_FIELD_TOO_LONG")).toMatchObject({ field: "shipping.province", params: { field: "province", max: 100 } });
    const postal = run({ postalCode: "12345678901" });
    expect(find(postal.issues, "ADDRESS_FIELD_TOO_LONG")).toMatchObject({ field: "shipping.postalCode", params: { field: "postalCode", max: 10 } });
    expect(codes(postal.issues)).toContain("POSTAL_CODE_INVALID");
    // Символи, а не байти: 100 літер з діакритикою — у межах ліміту.
    expect(run({ address1: `Straße 1 ${"ü".repeat(91)}` }).issues).toEqual([]);
    // Довжина — після обрізання пробілів (автовиправлення).
    expect(run({ address1: `  Musterstraße 1 ${"x".repeat(85)}   ` }).issues).toEqual([]);
  });

  it("city equal to address line 1, or line 2 equal to line 1 → warnings (case-insensitive)", () => {
    const city = run({ address1: "Berlin 1", city: "berlin 1" });
    expect(find(city.issues, "ADDRESS_DUPLICATED_FIELDS", "shipping.city")).toEqual({
      code: "ADDRESS_DUPLICATED_FIELDS",
      severity: "warning",
      field: "shipping.city",
      params: { field: "city" },
      suggestion: null,
    });
    const line2 = run({ address2: "MUSTERSTRASSE 1", address1: "Musterstrasse 1" });
    expect(line2.issues).toEqual([
      { code: "ADDRESS_DUPLICATED_FIELDS", severity: "warning", field: "shipping.address2", params: { field: "address2" }, suggestion: null },
    ]);
    expect(run({ address2: "Hinterhaus", address1: "Musterstraße 1" }).issues).toEqual([]);
    expect(run({ address2: "", address1: "Musterstraße 1" }).issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Телефон
// ---------------------------------------------------------------------------

describe("phone quality", () => {
  it("describePhone reports country and type from max metadata", () => {
    expect(describePhone("+4915123456789")).toEqual({ country: "DE", type: "MOBILE" });
    expect(describePhone("+493012345678")).toEqual({ country: "DE", type: "FIXED_LINE" });
    expect(describePhone("+12025550123")).toEqual({ country: "US", type: "FIXED_LINE_OR_MOBILE" });
    expect(describePhone("+4912")).toEqual({ country: null, type: null });
  });

  it("landline → PHONE_NOT_MOBILE warning; the number is kept as is", () => {
    const r = run({ phone: "+493012345678" });
    expect(r.autoFixes).toEqual([]);
    expect(r.issues).toEqual([{ code: "PHONE_NOT_MOBILE", severity: "warning", field: "shipping.phone", params: {}, suggestion: null }]);
    expect(r.blocking).toBe(false);
    // Місцевий стаціонарний номер переводиться в E.164 як раніше, і лише потім попередження.
    const local = run({ phone: "030 12345678" });
    expect(local.autoFixes).toEqual([
      { field: "shipping.phone", from: "030 12345678", to: "+493012345678", ruleId: "phone.national_to_international" },
    ]);
    expect(codes(local.issues)).toEqual(["PHONE_NOT_MOBILE"]);
  });

  it("MOBILE and FIXED_LINE_OR_MOBILE are fine", () => {
    expect(run({ phone: "+49 151 23456789" }).issues).toEqual([]);
    expect(run(US).issues).toEqual([]);
    expect(run(CA).issues).toEqual([]);
  });

  it("phone of another country → PHONE_COUNTRY_MISMATCH with {phoneCountry, country}", () => {
    const r = run({ phone: "+380 67 123 4567" });
    expect(r.issues).toEqual([
      {
        code: "PHONE_COUNTRY_MISMATCH",
        severity: "warning",
        field: "shipping.phone",
        params: { phoneCountry: "UA", country: "DE" },
        suggestion: null,
      },
    ]);
    // Обидва попередження одночасно.
    expect(codes(run({ phone: "+39 06 1234 5678" }).issues)).toEqual(["PHONE_NOT_MOBILE", "PHONE_COUNTRY_MISMATCH"]);
    // Канадський номер для США — інша країна, хоча код +1 той самий.
    expect(find(run({ ...US, phone: "+1 613 555 0199" }).issues, "PHONE_COUNTRY_MISMATCH")?.params).toEqual({ phoneCountry: "CA", country: "US" });
  });

  it("numbers of the same numbering area / postal system are not a mismatch", () => {
    expect(run({ ...US, phone: "+1 787 555 1234" }).issues).toEqual([]); // Пуерто-Рико
    expect(run({ ...US, phone: "+1 671 555 1234" }).issues).toEqual([]); // Гуам
    expect(run({ countryCode: "GB", city: "London", postalCode: "SW1A 1AA", address1: "1 Example St", phone: "+44 7797 123456" }).issues).toEqual([]); // Джерсі
  });

  it("no extra phone warnings for missing, invalid or ambiguous numbers, or unknown countries", () => {
    expect(codes(run({ phone: null }).issues)).toEqual(["PHONE_MISSING"]);
    expect(codes(run({ phone: "+49 12" }).issues)).toEqual(["PHONE_INVALID"]);
    expect(codes(run({ phone: "49 151 23456789" }).issues)).toEqual(["PHONE_AMBIGUOUS"]);
    expect(codes(run({ countryCode: "ZZ", phone: "+380 67 123 4567" }).issues)).toEqual(["COUNTRY_UNSUPPORTED"]);
    expect(codes(run({ countryCode: null, phone: "+380 67 123 4567" }).issues)).toEqual(["COUNTRY_MISSING"]);
  });
});

// ---------------------------------------------------------------------------
// 6–7. Ім'я та email
// ---------------------------------------------------------------------------

describe("recipient name", () => {
  it("only one part present → NAME_INCOMPLETE warning on the missing field", () => {
    expect(run({ firstName: null }).issues).toEqual([
      { code: "NAME_INCOMPLETE", severity: "warning", field: "shipping.firstName", params: {}, suggestion: null },
    ]);
    expect(run({ lastName: "  " }).issues).toEqual([
      { code: "NAME_INCOMPLETE", severity: "warning", field: "shipping.lastName", params: {}, suggestion: null },
    ]);
    expect(run({ lastName: null }).blocking).toBe(false);
  });

  it("both missing → NAME_MISSING only; never splits or invents names", () => {
    expect(codes(run({ firstName: null, lastName: null }).issues)).toEqual(["NAME_MISSING"]);
    const r = run({ firstName: "Max Mustermann", lastName: null });
    expect(r.autoFixes).toEqual([]);
    expect(find(r.issues, "NAME_INCOMPLETE")?.suggestion).toBeNull();
  });
});

describe("recipient email", () => {
  it("missing email for an international shipment → EMAIL_MISSING warning", () => {
    const r = run({}, { email: null });
    expect(r.issues).toEqual([{ code: "EMAIL_MISSING", severity: "warning", field: "email", params: {}, suggestion: null }]);
    expect(r.blocking).toBe(false);
    expect(codes(run({}, { email: "   " }).issues)).toEqual(["EMAIL_MISSING"]);
  });

  it("no warning for a domestic shipment, without an origin country, or with unknown/missing destination", () => {
    expect(codes(run({}, { email: null }, { originCountry: "DE" }).issues)).toEqual([]);
    expect(codes(run({}, { email: null }, { originCountry: " de " }).issues)).toEqual([]);
    expect(run({}, { email: null }, {}).issues).toEqual([]);
    expect(run({}, { email: null }, { originCountry: null }).issues).toEqual([]);
    expect(codes(run({ countryCode: "ZZ" }, { email: null }).issues)).toEqual(["COUNTRY_UNSUPPORTED"]);
    expect(codes(run({ countryCode: null }, { email: null }).issues)).toEqual(["COUNTRY_MISSING"]);
  });

  it("an invalid email stays EMAIL_INVALID (not EMAIL_MISSING)", () => {
    expect(codes(run({}, { email: "max@example" }).issues)).toEqual(["EMAIL_INVALID"]);
  });
});

// ---------------------------------------------------------------------------
// Загальні гарантії
// ---------------------------------------------------------------------------

describe("never invents data", () => {
  it("every suggestion candidate comes from the order's own text or the region dataset", () => {
    const inputs: OrderValidationInput[] = [
      order({ city: "Berlin 10115", postalCode: null }),
      order({ city: "10115 Berlin" }),
      order({ address1: null, address2: "Musterstraße 1" }),
      order({ ...US, province: "New York" }),
      order({ ...CA, province: "Québec", postalCode: "H2X 1Y4", city: "Montréal", phone: "+1 514 555 0100" }),
    ];
    const datasetCodes = new Set(Object.values(REGIONS).flatMap((list) => list.map((r) => r.code)));
    for (const input of inputs) {
      const text = JSON.stringify(input.shipping).replace(/\s/g, "").toUpperCase();
      for (const issue of validateOrder(input, RULES, UA).issues) {
        for (const c of issue.suggestion?.candidates ?? []) {
          const fromText = text.includes(c.replace(/\s/g, "").toUpperCase());
          const fromDataset = issue.code === "PROVINCE_INVALID" && datasetCodes.has(c);
          expect(fromText || fromDataset, `${issue.code}: ${c}`).toBe(true);
        }
      }
    }
  });

  it("new checks add no autofixes beyond province.uppercase", () => {
    const r = run({
      firstName: null,
      address1: null,
      address2: "Musterstraße",
      city: "10115 Berlin",
      postalCode: null,
      phone: "+380441234567",
    }, { email: null });
    expect(r.autoFixes).toEqual([]);
    expect(codes(r.issues).sort()).toEqual(
      ["NAME_INCOMPLETE", "ADDRESS_LINE1_EMPTY_LINE2_FILLED", "POSTAL_CODE_MISSING", "CITY_CONTAINS_POSTAL_CODE", "PHONE_NOT_MOBILE", "PHONE_COUNTRY_MISMATCH", "EMAIL_MISSING"].sort(),
    );
  });

  it("issues of one order have unique fingerprints (code + field)", () => {
    const r = run({ address1: "Berlin", city: "Berlin", address2: "berlin", firstName: null, phone: "+39 06 1234 5678" }, { email: null });
    const keys = r.issues.map((i) => `${i.code}:${i.field}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("issueCategory", () => {
  it("maps every issue code to a known category", () => {
    for (const code of ISSUE_CODES) expect(ISSUE_CATEGORIES, code).toContain(issueCategory(code));
  });

  it("assigns the expected categories", () => {
    expect(issueCategory("PHONE_AMBIGUOUS")).toBe("phone");
    expect(issueCategory("PHONE_COUNTRY_MISMATCH")).toBe("phone");
    expect(issueCategory("EMAIL_MISSING")).toBe("contact");
    expect(issueCategory("NAME_INCOMPLETE")).toBe("contact");
    expect(issueCategory("PROVINCE_INVALID")).toBe("address");
    expect(issueCategory("CITY_CONTAINS_POSTAL_CODE")).toBe("address");
    expect(issueCategory("COUNTRY_SHIPPING_DISABLED")).toBe("address");
    expect(issueCategory("PRODUCT_HS_CODE_MISSING")).toBe("customs");
    expect(issueCategory("ORDER_NO_ITEMS")).toBe("customs");
    expect(issueCategory("CARRIER_REJECTED")).toBe("carrier");
    expect(issueCategory("CARRIER_SHIPMENT_DELETED")).toBe("carrier");
    expect(issueCategory("SHOPIFY_SYNC_FAILED")).toBe("shopify");
    expect(issueCategory("DELIVERY_PROBLEM")).toBe("delivery");
    for (const code of ISSUE_CODES) {
      if (code.startsWith("SHOPIFY_")) expect(issueCategory(code), code).toBe("shopify");
      if (code.startsWith("PRODUCT_")) expect(issueCategory(code), code).toBe("customs");
      if (code.startsWith("PHONE_")) expect(issueCategory(code), code).toBe("phone");
    }
  });

  it("isIssueCategory guards URL input", () => {
    expect(isIssueCategory("address")).toBe(true);
    expect(isIssueCategory("Address")).toBe(false);
    expect(isIssueCategory(null)).toBe(false);
    expect(isIssueCategory("other")).toBe(false);
  });
});

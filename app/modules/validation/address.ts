import { extractPostalFromCity } from "./city-postal";
import { checkPostalRegion } from "./postal-region";
import { countryHasNoPostalCodes, matchesPostalPattern, normalizePostalCode } from "./postal";
import { findRegionByCode, regionCandidates, regionsOf } from "./regions";
import type { AddressInput, CountryRule, CountryRules, IssueCode, IssueSeverity, Suggestion, ValidationIssue } from "./types";

/** Обрізає краї та згортає послідовності пробілів в один пробіл. */
export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim() === "";
}

/** Код країни з адреси у вигляді для пошуку правила (верхній регістр) або null. */
export function countryKey(value: string | null): string | null {
  if (isBlank(value)) return null;
  return collapseWhitespace(value ?? "").toUpperCase();
}

function issue(
  code: IssueCode,
  field: string,
  params: Record<string, string | number> = {},
  severity: IssueSeverity = "error",
  suggestion: Suggestion | null = null,
): ValidationIssue {
  return { code, severity, field, params, suggestion };
}

/**
 * Обмеження довжини полів адреси (символів). Документовані ліміти перевізника Nova Post:
 * addressParts — до 100 символів, postCode — до 10.
 */
export const ADDRESS_FIELD_LIMITS = { address1: 100, address2: 100, city: 100, province: 100, postalCode: 10 } as const;

/**
 * Країни, де адреси без номера будинку звичні (назви будівель, сільські адреси), —
 * попередження ADDRESS_NO_HOUSE_NUMBER не показується. Плюс країни без поштових індексів (AE, HK тощо).
 */
const HOUSE_NUMBER_OPTIONAL = new Set(["IE"]);

const sameText = (a: string | null, b: string | null) =>
  !isBlank(a) && !isBlank(b) && collapseWhitespace(a ?? "").normalize("NFC").toLowerCase() === collapseWhitespace(b ?? "").normalize("NFC").toLowerCase();

const length = (value: string | null) => (value === null ? 0 : Array.from(value).length);

/** Перевірки, що не залежать від правил країни: одержувач, рядки адреси, довжина, дублікати. */
function validateNameAndLines(shipping: AddressInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const noFirst = isBlank(shipping.firstName);
  const noLast = isBlank(shipping.lastName);
  if (noFirst && noLast) issues.push(issue("NAME_MISSING", "shipping.lastName"));
  else if (noFirst || noLast) issues.push(issue("NAME_INCOMPLETE", noFirst ? "shipping.firstName" : "shipping.lastName", {}, "warning"));

  if (isBlank(shipping.address1)) {
    if (isBlank(shipping.address2)) issues.push(issue("ADDRESS_MISSING", "shipping.address1"));
    else {
      // Адресу записано в другий рядок — пропонуємо перенести її в перший (підтверджує менеджер).
      const line2 = collapseWhitespace(shipping.address2 ?? "");
      issues.push(
        issue("ADDRESS_LINE1_EMPTY_LINE2_FILLED", "shipping.address1", {}, "error", { field: "shipping.address1", candidates: [line2] }),
      );
    }
  }
  if (isBlank(shipping.city)) issues.push(issue("CITY_MISSING", "shipping.city"));

  for (const [field, max] of Object.entries(ADDRESS_FIELD_LIMITS) as [keyof typeof ADDRESS_FIELD_LIMITS, number][]) {
    if (length(shipping[field]) > max) issues.push(issue("ADDRESS_FIELD_TOO_LONG", `shipping.${field}`, { field, max }));
  }

  if (sameText(shipping.city, shipping.address1)) {
    issues.push(issue("ADDRESS_DUPLICATED_FIELDS", "shipping.city", { field: "city" }, "warning"));
  }
  if (sameText(shipping.address2, shipping.address1)) {
    issues.push(issue("ADDRESS_DUPLICATED_FIELDS", "shipping.address2", { field: "address2" }, "warning"));
  }
  return issues;
}

function validateHouseNumber(shipping: AddressInput, country: string, rule: CountryRule): ValidationIssue[] {
  if (isBlank(shipping.address1)) return []; // порожню адресу вже повідомлено
  if (HOUSE_NUMBER_OPTIONAL.has(country) || countryHasNoPostalCodes(rule)) return [];
  const hasDigit = /\d/.test(shipping.address1 ?? "") || /\d/.test(shipping.address2 ?? "");
  return hasDigit ? [] : [issue("ADDRESS_NO_HOUSE_NUMBER", "shipping.address1", {}, "warning")];
}

/** Регіон: відомий код країни; назва регіону → пропозиція коду (без автозаміни). */
function validateProvince(shipping: AddressInput, country: string, rule: CountryRule): ValidationIssue[] {
  if (isBlank(shipping.province)) {
    return rule.provinceRequired ? [issue("PROVINCE_MISSING", "shipping.province")] : [];
  }
  if (!regionsOf(country)) return []; // довідника регіонів немає — перевірити неможливо
  const value = collapseWhitespace(shipping.province ?? "");
  if (findRegionByCode(country, value)) return [];
  const candidates = regionCandidates(country, value);
  const suggestion = candidates.length > 0 ? { field: "shipping.province", candidates } : null;
  return [issue("PROVINCE_INVALID", "shipping.province", { country }, "error", suggestion)];
}

/** Перевірка адреси доставки (на ВЖЕ виправленій копії). */
export function validateAddress(shipping: AddressInput, rules: CountryRules): ValidationIssue[] {
  const issues = validateNameAndLines(shipping);

  const country = countryKey(shipping.countryCode);
  if (country === null) {
    issues.push(issue("COUNTRY_MISSING", "shipping.countryCode"));
    return issues;
  }

  const rule = rules.get(country);
  if (!rule) {
    issues.push(issue("COUNTRY_UNSUPPORTED", "shipping.countryCode", { country }));
    return issues;
  }
  if (!rule.shippingEnabled) {
    issues.push(issue("COUNTRY_SHIPPING_DISABLED", "shipping.countryCode", { country }));
  }

  issues.push(...validateHouseNumber(shipping, country, rule));
  issues.push(...validateProvince(shipping, country, rule));

  const example = rule.postalCodeExample ?? "—";
  const rawPostal = shipping.postalCode ?? "";
  const fromCity = extractPostalFromCity(shipping.city, rule);
  let postal: string | null = null;
  if (isBlank(rawPostal)) {
    if (rule.postalCodeRequired) {
      // Індекс знайдено в полі «Місто» — пропонуємо його (підтверджує менеджер).
      const codes = [...new Set(fromCity.map((e) => e.postalCode))];
      const suggestion = codes.length > 0 ? { field: "shipping.postalCode", candidates: codes } : null;
      issues.push(issue("POSTAL_CODE_MISSING", "shipping.postalCode", { example }, "error", suggestion));
    }
  } else {
    const { value } = normalizePostalCode(rawPostal, rule);
    const valid = matchesPostalPattern(value, rule);
    if (valid === false) issues.push(issue("POSTAL_CODE_INVALID", "shipping.postalCode", { example }));
    if (valid === true) postal = value;
  }

  if (fromCity.length > 0) {
    // Місто без індексу пропонується, лише якщо в полі «Індекс» той самий індекс. Порожній індекс — спершу
    // застосовують пропозицію індексу (POSTAL_CODE_MISSING), інакше прийняте місто без індексу втратило б код.
    // Інший індекс — дані суперечливі. В обох випадках — лише попередження без пропозиції.
    const consistent = isBlank(rawPostal) ? [] : fromCity.filter((e) => e.postalCode === postal);
    const cities = [...new Set(consistent.map((e) => e.city))];
    const suggestion = cities.length > 0 ? { field: "shipping.city", candidates: cities } : null;
    issues.push(issue("CITY_CONTAINS_POSTAL_CODE", "shipping.city", {}, "warning", suggestion));
  }

  const province = collapseWhitespace(shipping.province ?? "");
  if (postal !== null && findRegionByCode(country, province)) {
    const mismatch = checkPostalRegion(country, postal, province);
    if (mismatch) {
      issues.push(
        issue("POSTAL_CODE_REGION_MISMATCH", "shipping.postalCode", { prefix: mismatch.prefix, province, expected: mismatch.expected.join(", ") }, "warning"),
      );
    }
  }

  return issues;
}

import { matchesPostalPattern, normalizePostalCode } from "./postal";
import type { AddressInput, CountryRules, IssueCode, ValidationIssue } from "./types";

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

function issue(code: IssueCode, field: string, params: Record<string, string | number> = {}): ValidationIssue {
  return { code, severity: "error", field, params, suggestion: null };
}

/** Перевірка адреси доставки (на ВЖЕ виправленій копії). Усі проблеми — рівня error. */
export function validateAddress(shipping: AddressInput, rules: CountryRules): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (isBlank(shipping.firstName) && isBlank(shipping.lastName)) issues.push(issue("NAME_MISSING", "shipping.lastName"));
  if (isBlank(shipping.address1)) issues.push(issue("ADDRESS_MISSING", "shipping.address1"));
  if (isBlank(shipping.city)) issues.push(issue("CITY_MISSING", "shipping.city"));

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

  if (rule.provinceRequired && isBlank(shipping.province)) issues.push(issue("PROVINCE_MISSING", "shipping.province"));

  const example = rule.postalCodeExample ?? "—";
  const rawPostal = shipping.postalCode ?? "";
  if (isBlank(rawPostal)) {
    // Пошук індексу за адресою — запланована інтеграція (етап 4), тому без suggestion.
    if (rule.postalCodeRequired) issues.push(issue("POSTAL_CODE_MISSING", "shipping.postalCode", { example }));
  } else {
    const { value } = normalizePostalCode(rawPostal, rule);
    if (matchesPostalPattern(value, rule) === false) {
      issues.push(issue("POSTAL_CODE_INVALID", "shipping.postalCode", { example }));
    }
  }

  return issues;
}

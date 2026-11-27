import { collapseWhitespace, countryKey, isBlank, validateAddress } from "./address";
import { normalizePhone, validateShippingPhone } from "./phone";
import { matchesPostalPattern, normalizePostalCode } from "./postal";
import { validateProducts } from "./products";
import { findRegionByCode } from "./regions";
import {
  SHIPPING_FIELDS,
  type AutoFix,
  type AutoFixRuleId,
  type CountryRule,
  type CountryRules,
  type FieldPath,
  type OrderValidationInput,
  type ShippingField,
  type ValidationIssue,
  type ValidationResult,
} from "./types";

export * from "./types";
export { normalizePhone, isDigitPreserving, type PhoneNormalization } from "./phone";
export { normalizePostalCode, isFormatOnlyPostalChange, type PostalNormalization } from "./postal";
export { normalizeHsCode } from "./products";
export { DEFAULT_COUNTRY_RULES, type DefaultCountryRule, type DutyPayer } from "./default-country-rules";
export { issueCategory, isIssueCategory, ISSUE_CATEGORIES, type IssueCategory } from "./categories";
export { REGIONS, regionsOf, findRegionByCode, regionCandidates, type Region, type RegionKind } from "./regions";
export { checkPostalRegion, type PostalRegionCheck } from "./postal-region";
export { extractPostalFromCity, type CityPostalExtraction } from "./city-postal";
export { ADDRESS_FIELD_LIMITS } from "./address";
export { describePhone } from "./phone";

/** Важливість правил автовиправлення: для поля зберігається найважливіше з застосованих. */
export const AUTO_FIX_SIGNIFICANCE: readonly AutoFixRuleId[] = [
  "phone.copy_contact_phone",
  "phone.national_to_international",
  "phone.international_prefix_00",
  "phone.add_plus",
  "phone.normalize_format",
  "postal.normalize_format",
  "country.uppercase",
  "province.uppercase",
  "text.trim_whitespace",
];

/** Поля замовлення, які дозволено автовиправляти (дані товарів — ніколи). */
type FixableField = `shipping.${ShippingField}` | "email" | "contactPhone";

const FIXABLE_FIELDS: readonly FixableField[] = [
  ...SHIPPING_FIELDS.map((f) => `shipping.${f}` as const),
  "email",
  "contactPhone",
];

function isFixableField(field: FieldPath): field is FixableField {
  return (FIXABLE_FIELDS as readonly string[]).includes(field);
}

function readField(order: OrderValidationInput, field: FixableField): string | null {
  if (field === "email") return order.email;
  if (field === "contactPhone") return order.contactPhone;
  return order.shipping[field.slice("shipping.".length) as ShippingField];
}

function cloneOrder(order: OrderValidationInput): OrderValidationInput {
  return {
    ...order,
    shipping: { ...order.shipping },
    items: order.items.map((item) => ({ ...item, variant: item.variant ? { ...item.variant } : null })),
  };
}

function writeField(order: OrderValidationInput, field: FixableField, value: string): void {
  if (field === "email") order.email = value;
  else if (field === "contactPhone") order.contactPhone = value;
  else order.shipping[field.slice("shipping.".length) as ShippingField] = value;
}

interface FieldState {
  original: string | null;
  value: string | null;
  applied: Set<AutoFixRuleId>;
}

/** Обчислює однозначні автовиправлення на копії замовлення. Вхід не змінюється. */
export interface ValidationOptions {
  /**
   * Країна відправлення (з налаштувань відправника, зараз UA). Місцевий номер телефону, дійсний і в цій країні,
   * і в країні доставки, вважається неоднозначним (рішення менеджера).
   */
  originCountry?: string | null;
}

function alternateCountries(options: ValidationOptions): string[] {
  return options.originCountry ? [options.originCountry] : [];
}

export function computeAutoFixes(
  input: OrderValidationInput,
  rules: CountryRules,
  options: ValidationOptions = {},
): { fixed: OrderValidationInput; autoFixes: AutoFix[] } {
  const states = new Map<FixableField, FieldState>();
  for (const field of FIXABLE_FIELDS) {
    const original = readField(input, field);
    states.set(field, { original, value: original, applied: new Set() });
  }
  const state = (field: FixableField): FieldState => states.get(field) as FieldState;
  const apply = (field: FixableField, next: string, ruleId: AutoFixRuleId) => {
    const s = state(field);
    if (s.value === next) return;
    s.value = next;
    s.applied.add(ruleId);
  };

  // 1. Пробіли (усі поля) та код країни.
  for (const field of FIXABLE_FIELDS) {
    const current = state(field).value;
    if (current === null) continue;
    const cleaned = collapseWhitespace(current);
    if (field === "shipping.countryCode") {
      // Верхній регістр лише для дволітерного коду — інші значення не «вгадуємо».
      apply(field, /^[a-z]{2}$/i.test(cleaned) ? cleaned.toUpperCase() : cleaned, "country.uppercase");
    } else {
      apply(field, cleaned, "text.trim_whitespace");
    }
  }

  const country = countryKey(state("shipping.countryCode").value);

  // Код регіону: верхній регістр, лише якщо результат — точний відомий код країни ("ny" → "NY").
  // Назви регіонів ("New York") не замінюються автоматично — це пропозиція для менеджера.
  const province = state("shipping.province").value;
  if (province !== null && province !== "") {
    const upper = province.toUpperCase();
    if (upper !== province && findRegionByCode(country, upper)) apply("shipping.province", upper, "province.uppercase");
  }

  // 2. Телефон одержувача: копія з контактного телефону, якщо порожній.
  const contact = state("contactPhone").value;
  if (isBlank(state("shipping.phone").value) && !isBlank(contact) && contact !== null) {
    apply("shipping.phone", contact, "phone.copy_contact_phone");
  }

  // 3. Нормалізація телефонів — лише однозначні валідні результати.
  for (const field of ["shipping.phone", "contactPhone"] as const) {
    const current = state(field).value;
    if (current === null || current === "") continue;
    const result = normalizePhone(current, country, alternateCountries(options));
    if (result.status === "valid" && result.ruleId !== null) apply(field, result.e164, result.ruleId);
  }

  // 4. Поштовий індекс: лише для відомої країни і лише якщо результат відповідає її формату.
  const postal = state("shipping.postalCode").value;
  const postalRule = country ? rules.get(country) : undefined;
  if (postal !== null && postal !== "" && postalRule) {
    const result = normalizePostalCode(postal, postalRule);
    if (matchesPostalPattern(result.value, postalRule) !== false) {
      apply("shipping.postalCode", result.value, "postal.normalize_format");
    }
  }

  const fixed = cloneOrder(input);
  const autoFixes: AutoFix[] = [];
  for (const field of FIXABLE_FIELDS) {
    const s = state(field);
    if (s.value === null || s.value === s.original) continue;
    if (s.original === null && s.value === "") continue;
    const ruleId = AUTO_FIX_SIGNIFICANCE.find((r) => s.applied.has(r));
    if (!ruleId) continue;
    writeField(fixed, field, s.value);
    autoFixes.push({ field, from: s.original, to: s.value, ruleId });
  }
  return { fixed, autoFixes };
}

/**
 * Застосовує автовиправлення до копії замовлення (чиста функція).
 * Лише поля замовлення (shipping.*, email, contactPhone); виправлення, чиє `from`
 * не збігається з поточним значенням (застаріле), пропускається.
 */
export function applyAutoFixes(input: OrderValidationInput, fixes: readonly AutoFix[]): OrderValidationInput {
  const out = cloneOrder(input);
  for (const fix of fixes) {
    if (!isFixableField(fix.field)) continue;
    const current = readField(out, fix.field);
    if ((current ?? "") !== (fix.from ?? "")) continue;
    writeField(out, fix.field, fix.to);
  }
  return out;
}

const EMAIL_PATTERN = /^[^\s@]+@(?:[^\s@.]+\.)+[^\s@.]{2,}$/;

/**
 * Email: некоректний формат — попередження. Порожній email для міжнародного відправлення
 * (країна доставки ≠ країна відправлення) — попередження EMAIL_MISSING: перевізникам і митниці
 * потрібен email одержувача. Без відомої країни відправлення порожній email не повідомляється.
 */
function validateEmail(email: string | null, country: string | null, rules: CountryRules, options: ValidationOptions): ValidationIssue[] {
  if (isBlank(email) || email === null) {
    const origin = countryKey(options.originCountry ?? null);
    if (origin && country && rules.has(country) && country !== origin) {
      return [{ code: "EMAIL_MISSING", severity: "warning", field: "email", params: {}, suggestion: null }];
    }
    return [];
  }
  if (EMAIL_PATTERN.test(email.trim())) return [];
  return [{ code: "EMAIL_INVALID", severity: "warning", field: "email", params: {}, suggestion: null }];
}

/**
 * Перевірка замовлення: (1) автовиправлення на копії, (2) перевірка ВИПРАВЛЕНОЇ копії,
 * (3) blocking = є хоча б одна проблема рівня error.
 */
export function validateOrder(
  input: OrderValidationInput,
  rules: CountryRules,
  options: ValidationOptions = {},
): ValidationResult {
  const { fixed, autoFixes } = computeAutoFixes(input, rules, options);
  const country = countryKey(fixed.shipping.countryCode);
  const issues: ValidationIssue[] = [
    ...validateAddress(fixed.shipping, rules),
    ...validateShippingPhone(fixed.shipping.phone, country, rules, alternateCountries(options)),
    ...validateEmail(fixed.email, country, rules, options),
    ...validateProducts(fixed.items),
  ];
  return { issues, autoFixes, blocking: issues.some((i) => i.severity === "error") };
}

/** Стабільний відбиток проблеми для дедуплікації між перевірками. */
export function issueFingerprint(orderId: string, issue: Pick<ValidationIssue, "code" | "field">): string {
  return `${orderId}:${issue.code}:${issue.field ?? ""}`;
}

/** Мапа правил країн; ключі — ISO2 у верхньому регістрі. При дублікатах перемагає останнє. */
export function buildCountryRuleMap(rules: readonly CountryRule[]): CountryRules {
  const map = new Map<string, CountryRule>();
  for (const rule of rules) {
    const key = rule.countryCode.trim().toUpperCase();
    map.set(key, { ...rule, countryCode: key });
  }
  return map;
}

/**
 * Контракт модуля перевірки даних замовлення.
 *
 * Правила:
 * - Модуль є чистим (без БД/мережі): вхід → результат. Детермінований.
 * - Автовиправлення (AutoFix) — лише однозначні зміни формату/копіювання наявних даних.
 *   Модуль НІКОЛИ не вигадує цифри телефону, адреси, індекси, митні коди чи вартість.
 * - Якщо можливих варіантів кілька — це ValidationIssue з suggestion.candidates (потрібне підтвердження).
 */

export const ISSUE_CODES = [
  // Контакт / телефон
  "PHONE_MISSING",
  "PHONE_INVALID",
  "PHONE_AMBIGUOUS",
  "EMAIL_INVALID",
  // Адреса
  "NAME_MISSING",
  "ADDRESS_MISSING",
  "CITY_MISSING",
  "COUNTRY_MISSING",
  "COUNTRY_UNSUPPORTED",
  "COUNTRY_SHIPPING_DISABLED",
  "POSTAL_CODE_MISSING",
  "POSTAL_CODE_INVALID",
  "PROVINCE_MISSING",
  // Товари / митниця
  "ORDER_NO_ITEMS",
  "PRODUCT_NOT_LINKED",
  "PRODUCT_WEIGHT_MISSING",
  "PRODUCT_HS_CODE_MISSING",
  "PRODUCT_HS_CODE_INVALID",
  "PRODUCT_ORIGIN_MISSING",
  "PRODUCT_CUSTOMS_DESCRIPTION_MISSING",
  "PRODUCT_PRICE_INVALID",
  // Перевізник (створюються сервісом накладних, не валідатором)
  "CARRIER_REJECTED",
  "CARRIER_RESULT_UNKNOWN",
  "CARRIER_UNAVAILABLE",
] as const;

export type IssueCode = (typeof ISSUE_CODES)[number];
export type IssueSeverity = "error" | "warning";

/** Поля адреси доставки, які можна редагувати вручну. */
export const SHIPPING_FIELDS = [
  "firstName",
  "lastName",
  "company",
  "address1",
  "address2",
  "city",
  "province",
  "postalCode",
  "countryCode",
  "phone",
] as const;
export type ShippingField = (typeof SHIPPING_FIELDS)[number];

/** Поля варіанта товару, потрібні для митного оформлення. */
export const VARIANT_CUSTOMS_FIELDS = ["weightGrams", "hsCode", "countryOfOrigin", "customsDescription"] as const;
export type VariantCustomsField = (typeof VARIANT_CUSTOMS_FIELDS)[number];

/**
 * Шлях до поля:
 * - `shipping.<ShippingField>` — адреса доставки;
 * - `email`, `contactPhone` — контакти замовлення;
 * - `variant.<variantId>.<VariantCustomsField>` — дані товару;
 * - `lineItem.<lineItemId>` — позиція замовлення в цілому;
 * - `order` — замовлення в цілому.
 */
export type FieldPath = string;

export type AddressInput = Record<ShippingField, string | null>;

export interface VariantInput {
  variantId: string;
  sku: string | null;
  weightGrams: number | null;
  hsCode: string | null;
  countryOfOrigin: string | null;
  customsDescription: string | null;
}

export interface LineItemInput {
  lineItemId: string;
  title: string;
  quantity: number;
  /** Десятковий рядок, напр. "24.90". */
  unitPrice: string;
  variant: VariantInput | null;
}

export interface OrderValidationInput {
  orderId: string;
  email: string | null;
  contactPhone: string | null;
  shipping: AddressInput;
  items: LineItemInput[];
}

export interface CountryRule {
  countryCode: string;
  nameEn: string;
  nameUk: string;
  shippingEnabled: boolean;
  postalCodeRequired: boolean;
  /** Регулярний вираз (без прапорців), що перевіряє ВЖЕ нормалізований індекс. null — формат не перевіряється. */
  postalCodePattern: string | null;
  postalCodeExample: string | null;
  provinceRequired: boolean;
  phoneRequired: boolean;
}

export type CountryRules = ReadonlyMap<string, CountryRule>;

export interface Suggestion {
  field: FieldPath;
  /** 1 кандидат — запропоноване виправлення (потребує підтвердження); >1 — вибір менеджера. */
  candidates: string[];
}

export interface ValidationIssue {
  code: IssueCode;
  severity: IssueSeverity;
  field: FieldPath | null;
  /** Параметри для i18n-повідомлення (без зайвих персональних даних). */
  params: Record<string, string | number>;
  suggestion: Suggestion | null;
}

export const AUTO_FIX_RULES = [
  "text.trim_whitespace",
  "country.uppercase",
  "phone.normalize_format",
  "phone.international_prefix_00",
  "phone.add_plus",
  "phone.national_to_international",
  "phone.copy_contact_phone",
  "postal.normalize_format",
] as const;
export type AutoFixRuleId = (typeof AUTO_FIX_RULES)[number];

export interface AutoFix {
  field: FieldPath;
  from: string | null;
  to: string;
  ruleId: AutoFixRuleId;
}

export interface ValidationResult {
  /** Проблеми, знайдені ПІСЛЯ застосування автовиправлень. */
  issues: ValidationIssue[];
  /** Однозначні виправлення, які слід зберегти з історією. */
  autoFixes: AutoFix[];
  /** true, якщо є хоча б одна проблема рівня error. */
  blocking: boolean;
}

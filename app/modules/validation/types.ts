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
  "PHONE_NOT_MOBILE",
  "PHONE_COUNTRY_MISMATCH",
  "EMAIL_INVALID",
  "EMAIL_MISSING",
  // Адреса
  "NAME_MISSING",
  "NAME_INCOMPLETE",
  "ADDRESS_MISSING",
  "ADDRESS_LINE1_EMPTY_LINE2_FILLED",
  "ADDRESS_NO_HOUSE_NUMBER",
  "ADDRESS_FIELD_TOO_LONG",
  "ADDRESS_DUPLICATED_FIELDS",
  "CITY_CONTAINS_POSTAL_CODE",
  "CITY_MISSING",
  "COUNTRY_MISSING",
  "COUNTRY_UNSUPPORTED",
  "COUNTRY_SHIPPING_DISABLED",
  "POSTAL_CODE_MISSING",
  "POSTAL_CODE_INVALID",
  "POSTAL_CODE_REGION_MISMATCH",
  "PROVINCE_MISSING",
  "PROVINCE_INVALID",
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
  /** Скасування накладної: відповіді перевізника немає (тайм-аут/збій) — чи скасовано, невідомо. */
  "CARRIER_CANCEL_UNKNOWN",
  /** Перевізник СКАСУВАВ накладну, але передачу посилки зафіксовано під час скасування. */
  "CARRIER_CANCEL_CONFLICT",
  // Синхронізація з Shopify (створюються сервісом синхронізації)
  "SHOPIFY_ORDER_CHANGED",
  "SHOPIFY_SYNC_FAILED",
  "SHOPIFY_CANCELLED_AFTER_SHIPMENT",
  "SHOPIFY_COUNTRY_NOT_SHIPPED",
  "SHOPIFY_FULFILLMENT_FAILED",
  // Відстеження (створюються сервісом відстеження)
  "DELIVERY_PROBLEM",
  "CARRIER_SHIPMENT_DELETED",
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
  "province.uppercase",
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

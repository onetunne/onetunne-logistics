import type { IssueCode } from "./types";

/**
 * Категорії проблем для фільтрів розділу «Проблеми».
 * Таблиця вичерпна: новий код у ISSUE_CODES без категорії не пройде перевірку типів.
 */

export const ISSUE_CATEGORIES = ["address", "phone", "contact", "customs", "carrier", "shopify", "delivery", "warehouse"] as const;
export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

const CATEGORY_BY_CODE = {
  // Телефон одержувача
  PHONE_MISSING: "phone",
  PHONE_INVALID: "phone",
  PHONE_AMBIGUOUS: "phone",
  PHONE_NOT_MOBILE: "phone",
  PHONE_COUNTRY_MISMATCH: "phone",
  // Контакти й одержувач
  EMAIL_INVALID: "contact",
  EMAIL_MISSING: "contact",
  NAME_MISSING: "contact",
  NAME_INCOMPLETE: "contact",
  // Адреса доставки
  ADDRESS_MISSING: "address",
  ADDRESS_LINE1_EMPTY_LINE2_FILLED: "address",
  ADDRESS_NO_HOUSE_NUMBER: "address",
  ADDRESS_FIELD_TOO_LONG: "address",
  ADDRESS_DUPLICATED_FIELDS: "address",
  CITY_MISSING: "address",
  CITY_CONTAINS_POSTAL_CODE: "address",
  COUNTRY_MISSING: "address",
  COUNTRY_UNSUPPORTED: "address",
  COUNTRY_SHIPPING_DISABLED: "address",
  POSTAL_CODE_MISSING: "address",
  POSTAL_CODE_INVALID: "address",
  POSTAL_CODE_REGION_MISMATCH: "address",
  PROVINCE_MISSING: "address",
  PROVINCE_INVALID: "address",
  // Товари та митні дані
  ORDER_NO_ITEMS: "customs",
  PRODUCT_NOT_LINKED: "customs",
  PRODUCT_WEIGHT_MISSING: "customs",
  PRODUCT_HS_CODE_MISSING: "customs",
  PRODUCT_HS_CODE_INVALID: "customs",
  PRODUCT_ORIGIN_MISSING: "customs",
  PRODUCT_CUSTOMS_DESCRIPTION_MISSING: "customs",
  PRODUCT_PRICE_INVALID: "customs",
  // Перевізник і накладні
  CARRIER_REJECTED: "carrier",
  CARRIER_RESULT_UNKNOWN: "carrier",
  CARRIER_UNAVAILABLE: "carrier",
  CARRIER_CANCEL_UNKNOWN: "carrier",
  CARRIER_CANCEL_CONFLICT: "carrier",
  CARRIER_SHIPMENT_DELETED: "carrier",
  // Синхронізація з Shopify
  SHOPIFY_ORDER_CHANGED: "shopify",
  SHOPIFY_SYNC_FAILED: "shopify",
  SHOPIFY_CANCELLED_AFTER_SHIPMENT: "shopify",
  SHOPIFY_COUNTRY_NOT_SHIPPED: "shopify",
  SHOPIFY_FULFILLMENT_FAILED: "shopify",
  SHOPIFY_FULFILLED_OUTSIDE_APP: "shopify",
  // Доставка (після передачі перевізнику)
  DELIVERY_PROBLEM: "delivery",
  // Склад: попередження пакування (розібрати скасовану посилку, перевірити посилку, передану без «Запаковано»)
  ORDER_CANCELLED_AFTER_PACKING: "warehouse",
  PACKING_SKIPPED_AT_HANDOVER: "warehouse",
} as const satisfies Record<IssueCode, IssueCategory>;

/** Категорія проблеми за кодом (чиста функція). */
export function issueCategory(code: IssueCode): IssueCategory {
  return CATEGORY_BY_CODE[code];
}

/** true, якщо рядок — відома категорія (для розбору параметрів фільтра з URL). */
export function isIssueCategory(value: unknown): value is IssueCategory {
  return typeof value === "string" && (ISSUE_CATEGORIES as readonly string[]).includes(value);
}

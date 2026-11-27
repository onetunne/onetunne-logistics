import { ISSUE_CODES } from "~/modules/validation/types";

/**
 * Категорії та джерела проблем для розділу «Проблеми» (чисті функції, без БД).
 *
 * TODO(stage-4): після появи `issueCategory(code)` у `~/modules/validation/categories.ts` замінити тіло
 * `problemCategory` на:
 *   const c = issueCategory(code as never); return isProblemCategory(c) ? c : "other";
 * і видалити TEMP_CATEGORY_BY_CODE. Решта коду (фільтри SQL, лічильники) користується лише `problemCategory`.
 */
export const PROBLEM_CATEGORIES = ["address", "phone", "contact", "customs", "carrier", "shopify", "delivery", "other"] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

/** Хто створив проблему: перевірка даних, сервіс накладних (перевізник), синхронізація Shopify, відстеження. */
export const PROBLEM_SOURCES = ["validation", "carrier", "shopify", "tracking"] as const;
export type ProblemSource = (typeof PROBLEM_SOURCES)[number];

export function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === "string" && (PROBLEM_CATEGORIES as readonly string[]).includes(value);
}

export function isProblemSource(value: unknown): value is ProblemSource {
  return typeof value === "string" && (PROBLEM_SOURCES as readonly string[]).includes(value);
}

/** Тимчасова відповідність (див. TODO вище). Невідомі коди → "other". */
const TEMP_CATEGORY_BY_CODE: Readonly<Record<string, ProblemCategory>> = {
  PHONE_MISSING: "phone",
  PHONE_INVALID: "phone",
  PHONE_AMBIGUOUS: "phone",
  EMAIL_INVALID: "contact",
  NAME_MISSING: "contact",
  ADDRESS_MISSING: "address",
  CITY_MISSING: "address",
  COUNTRY_MISSING: "address",
  COUNTRY_UNSUPPORTED: "address",
  COUNTRY_SHIPPING_DISABLED: "address",
  POSTAL_CODE_MISSING: "address",
  POSTAL_CODE_INVALID: "address",
  PROVINCE_MISSING: "address",
  PRODUCT_NOT_LINKED: "customs",
  PRODUCT_WEIGHT_MISSING: "customs",
  PRODUCT_HS_CODE_MISSING: "customs",
  PRODUCT_HS_CODE_INVALID: "customs",
  PRODUCT_ORIGIN_MISSING: "customs",
  PRODUCT_CUSTOMS_DESCRIPTION_MISSING: "customs",
  PRODUCT_PRICE_INVALID: "customs",
  CARRIER_REJECTED: "carrier",
  CARRIER_RESULT_UNKNOWN: "carrier",
  CARRIER_UNAVAILABLE: "carrier",
  SHOPIFY_ORDER_CHANGED: "shopify",
  SHOPIFY_SYNC_FAILED: "shopify",
  SHOPIFY_CANCELLED_AFTER_SHIPMENT: "shopify",
  SHOPIFY_COUNTRY_NOT_SHIPPED: "shopify",
  SHOPIFY_FULFILLMENT_FAILED: "shopify",
  DELIVERY_PROBLEM: "delivery",
  CARRIER_SHIPMENT_DELETED: "delivery",
};

export function problemCategory(code: string): ProblemCategory {
  return Object.hasOwn(TEMP_CATEGORY_BY_CODE, code) ? TEMP_CATEGORY_BY_CODE[code]! : "other";
}

/** Коди, що створює сервіс відстеження (мають префікс CARRIER_/DELIVERY_, але джерело — відстеження). */
export const TRACKING_CODES: readonly string[] = ["DELIVERY_PROBLEM", "CARRIER_SHIPMENT_DELETED"];

export function problemSource(code: string): ProblemSource {
  if (TRACKING_CODES.includes(code)) return "tracking";
  if (code.startsWith("CARRIER_")) return "carrier";
  if (code.startsWith("SHOPIFY_")) return "shopify";
  return "validation";
}

/**
 * Відомі коди категорії (для фільтра SQL). Для "other" повертає `excluded` — коди всіх ІНШИХ категорій:
 * до "other" належать і коди, яких ще немає в ISSUE_CODES.
 */
export function categoryCodeFilter(
  category: ProblemCategory,
  knownCodes: readonly string[] = ISSUE_CODES,
): { include: string[] } | { exclude: string[] } {
  if (category === "other") return { exclude: knownCodes.filter((c) => problemCategory(c) !== "other") };
  return { include: knownCodes.filter((c) => problemCategory(c) === category) };
}

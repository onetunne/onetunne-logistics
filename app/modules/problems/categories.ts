import { issueCategory } from "~/modules/validation/categories";
import { ISSUE_CODES, type IssueCode } from "~/modules/validation/types";

/**
 * Категорії та джерела проблем для розділу «Проблеми» (чисті функції, без БД).
 * Категорія коду визначається валідатором (`issueCategory`, app/modules/validation/categories.ts);
 * тут додано лише "other" для кодів, яких валідатор ще не знає. Решта коду (фільтри SQL, лічильники)
 * користується лише `problemCategory`.
 */
export const PROBLEM_CATEGORIES = ["address", "phone", "contact", "customs", "carrier", "shopify", "delivery", "warehouse", "other"] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];

/**
 * Хто створив проблему: перевірка даних, сервіс накладних (перевізник), синхронізація Shopify, відстеження,
 * склад (пакування — modules/packing/lifecycle.server.ts).
 */
export const PROBLEM_SOURCES = ["validation", "carrier", "shopify", "tracking", "warehouse"] as const;
export type ProblemSource = (typeof PROBLEM_SOURCES)[number];

export function isProblemCategory(value: unknown): value is ProblemCategory {
  return typeof value === "string" && (PROBLEM_CATEGORIES as readonly string[]).includes(value);
}

export function isProblemSource(value: unknown): value is ProblemSource {
  return typeof value === "string" && (PROBLEM_SOURCES as readonly string[]).includes(value);
}

const KNOWN_CODES: ReadonlySet<string> = new Set(ISSUE_CODES);

/** Категорія за кодом (валідатор — `issueCategory`); невідомі коди (напр. нові, ще без категорії) → "other". */
export function problemCategory(code: string): ProblemCategory {
  if (!KNOWN_CODES.has(code)) return "other";
  const category: unknown = issueCategory(code as IssueCode);
  return isProblemCategory(category) ? category : "other";
}

/**
 * Помилки перевізника, які закриває менеджер після перевірки в кабінеті перевізника (застосунок сам не може
 * дізнатися результат): відмова створення (свідомий повтор без змін) і невідомий/конфліктний результат скасування.
 */
export const MANUALLY_CLOSABLE_ISSUE_CODES: readonly string[] = ["CARRIER_REJECTED", "CARRIER_CANCEL_UNKNOWN", "CARRIER_CANCEL_CONFLICT"];

/** Коди, що створює сервіс відстеження (мають префікс CARRIER_/DELIVERY_, але джерело — відстеження). */
export const TRACKING_CODES: readonly string[] = ["DELIVERY_PROBLEM", "CARRIER_SHIPMENT_DELETED"];

/**
 * Коди складу (категорія warehouse): попередження пакування без спільного префікса (ORDER_CANCELLED_AFTER_PACKING,
 * PACKING_SKIPPED_AT_HANDOVER — PACKING_ISSUE_CODES модуля пакування). Джерело — склад, не перевірка даних.
 */
export const WAREHOUSE_CODES: readonly string[] = ISSUE_CODES.filter((c) => issueCategory(c) === "warehouse");

export function problemSource(code: string): ProblemSource {
  if (TRACKING_CODES.includes(code)) return "tracking";
  if (WAREHOUSE_CODES.includes(code)) return "warehouse";
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

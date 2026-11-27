/**
 * CSV для експорту складських даних (чисті функції).
 *
 * Формат (docs/telegram-warehouse-readiness.md, розділ «Експорт CSV»):
 * - UTF-8 з BOM (Excel правильно відкриває кирилицю), рядки — CRLF (RFC 4180);
 * - роздільник: «;» за замовчуванням (Excel з українськими/європейськими регіональними налаштуваннями) або «,»;
 * - числа — з крапкою як десятковим роздільником, дати — ISO 8601; заголовки — стабільні англійські snake_case
 *   (для програм: майбутній фінансовий модуль, ШІ);
 * - значення з роздільником, лапками, переносом рядка або пробілом на краю — у лапках (лапки подвоюються);
 * - захист від CSV-ін'єкцій: текст, що починається з = + - @ або табуляції/CR, отримує префікс «'»
 *   (Excel/Sheets не виконає його як формулу). Числа (тип number) не змінюються.
 */

export const CSV_SEPARATORS = { semicolon: ";", comma: "," } as const;
export type CsvSeparatorKey = keyof typeof CSV_SEPARATORS;
export const DEFAULT_CSV_SEPARATOR: CsvSeparatorKey = "semicolon";
export const CSV_BOM = "﻿";
export const CSV_CONTENT_TYPE = "text/csv; charset=utf-8";

export function isCsvSeparatorKey(value: unknown): value is CsvSeparatorKey {
  return value === "semicolon" || value === "comma";
}

export type CsvValue = string | number | boolean | null | undefined;

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => CsvValue;
}

const FORMULA_START = /^[=+\-@\t\r]/;

/** Одна комірка CSV. */
export function csvCell(value: CsvValue, separator: string): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "number") {
    text = Number.isFinite(value) ? String(value) : "";
  } else if (typeof value === "boolean") {
    text = value ? "true" : "false";
  } else {
    text = FORMULA_START.test(value) ? `'${value}` : value;
  }
  const needsQuotes = text.includes(separator) || /["\r\n]/.test(text) || /^\s|\s$/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Повний CSV: заголовок + рядки. */
export function buildCsv<T>(
  columns: ReadonlyArray<CsvColumn<T>>,
  rows: readonly T[],
  opts: { separator?: CsvSeparatorKey; bom?: boolean } = {},
): string {
  const sep = CSV_SEPARATORS[opts.separator ?? DEFAULT_CSV_SEPARATOR];
  const lines = [columns.map((c) => csvCell(c.header, sep)).join(sep)];
  for (const row of rows) lines.push(columns.map((c) => csvCell(c.value(row), sep)).join(sep));
  return `${opts.bom === false ? "" : CSV_BOM}${lines.join("\r\n")}\r\n`;
}

/** Десяткове число для CSV (крапка, фіксована кількість знаків) або порожньо. */
export function csvDecimal(value: number | null | undefined, digits: number): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value.toFixed(digits);
}

/** Безпечне ім'я файлу: [a-z0-9._-], без «..» і без крапки/дефіса на початку. */
export function csvFileName(...parts: string[]): string {
  const base = parts
    .join("_")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 120);
  return `${base || "export"}.csv`;
}

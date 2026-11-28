/**
 * Етап 6: нормалізація номерів накладних (docs/stage6-design.md §7.4) — та сама для зовнішніх номерів
 * (recordExternalWaybills), рядків рахунків (імпорт, WP5) і пошуку відправлень застосунку (вираз-індекс
 * shipments_waybill_norm_idx: upper(regexp_replace(waybill_number, '\s', '', 'g'))).
 * Текст → NFKC → обрізати → прибрати пробіли/NBSP → верхній регістр; ДЕФІСИ зберігаються. Ціла числова клітинка XLSX →
 * точні цифри; експоненційний текст (`2.0451E+13`) або дробове → invalid_number («Excel пошкодив число…»).
 */
import type { WaybillNumberClass } from "~/domain/finance";

export type WaybillNormalization =
  | { ok: true; norm: string; numberClass: WaybillNumberClass }
  | { ok: false; error: "empty" | "invalid_number" };

const EXPONENT_RE = /^[+-]?\d+(?:[.,]\d+)?E[+-]?\d+$/;
const FRACTION_RE = /^\d+[.,]\d+$/;

export function classifyWaybillNumber(norm: string): WaybillNumberClass {
  if (/^TEST\d{10}$/.test(norm)) return "test";
  if (/^\d{14}$/.test(norm)) return "ua14";
  if (/^[A-Z]{4}\d{10}$/.test(norm)) return "eu";
  return "unrecognized";
}

/** Нормалізує номер (рядок клітинки/форми або ціле число клітинки XLSX). */
export function normalizeWaybillNumber(raw: string | number | null | undefined): WaybillNormalization {
  if (raw === null || raw === undefined) return { ok: false, error: "empty" };
  if (typeof raw === "number") {
    if (!Number.isSafeInteger(raw) || raw < 0) return { ok: false, error: "invalid_number" };
    const norm = String(raw);
    return { ok: true, norm, numberClass: classifyWaybillNumber(norm) };
  }
  const norm = raw.normalize("NFKC").trim().replace(/[\s   ﻿]+/g, "").toUpperCase();
  if (norm === "") return { ok: false, error: "empty" };
  if (EXPONENT_RE.test(norm) || FRACTION_RE.test(norm)) return { ok: false, error: "invalid_number" };
  if (norm.length > 64) return { ok: false, error: "invalid_number" };
  return { ok: true, norm, numberClass: classifyWaybillNumber(norm) };
}

/** Нормалізація номера рахунку (§7.6): обрізати, верхній регістр, без внутрішніх пробілів. */
export function normalizeInvoiceNumber(raw: string): string {
  return raw.normalize("NFKC").trim().replace(/[\s   ﻿]+/g, "").toUpperCase();
}

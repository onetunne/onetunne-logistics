/**
 * Етап 6, WP7: коди партнерів (docs/stage6-design.md §9.1). Чисті функції.
 * - code_norm = обрізаний код у верхньому регістрі (коди знижок Shopify нечутливі до регістру; реферальний `?ref=` —
 *   так само), однаковий для кодів партнерів і кодів замовлень;
 * - код — без пробілів усередині й без «@» (не email), 1…64 символи: код не є персональними даними й іде в історію змін;
 * - дійсність на дату замовлення: valid_from ≤ дата ≤ valid_to (межі включно; null — без межі).
 */
import { parseIsoDate } from "~/lib/periods";

export const PARTNER_CODE_MAX_LENGTH = 64;
const CODE_RE = /^[^\s@]{1,64}$/u;

export type CodeError = "partners.error.codeEmpty" | "partners.error.codeInvalid";

/** Нормалізований код (для порівняння й унікального індексу). Порожнє → "". */
export function normalizeCode(raw: string | null | undefined): string {
  return (raw ?? "").normalize("NFC").trim().toUpperCase();
}

/** Код із форми власника: обрізаний (регістр як введено) + нормалізований. */
export function parsePartnerCode(raw: string | null | undefined): { ok: true; code: string; norm: string } | { ok: false; error: CodeError } {
  const code = (raw ?? "").normalize("NFC").trim();
  if (!code) return { ok: false, error: "partners.error.codeEmpty" };
  if (!CODE_RE.test(code)) return { ok: false, error: "partners.error.codeInvalid" };
  return { ok: true, code, norm: normalizeCode(code) };
}

export interface CodeValidity {
  validFrom: string | null;
  validTo: string | null;
}

/** Чи дійсний код на дату (YYYY-MM-DD, Київ). */
export function isCodeValidOn(code: CodeValidity, date: string): boolean {
  if (code.validFrom && date < code.validFrom) return false;
  if (code.validTo && date > code.validTo) return false;
  return true;
}

/** Перевірка меж дійсності з форми: обидві необов'язкові, from ≤ to. */
export function parseValidity(from: string | null | undefined, to: string | null | undefined): { ok: true; validFrom: string | null; validTo: string | null } | { ok: false } {
  const f = from ? parseIsoDate(from) : null;
  const t = to ? parseIsoDate(to) : null;
  if ((from && !f) || (to && !t)) return { ok: false };
  if (f && t && f > t) return { ok: false };
  return { ok: true, validFrom: f, validTo: t };
}

/** Унікальні нормалізовані коди замовлення в порядку Shopify (перший — перший застосований). */
export function normalizeOrderCodes(codes: readonly string[]): string[] {
  const out: string[] = [];
  for (const c of codes) {
    const n = normalizeCode(c);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

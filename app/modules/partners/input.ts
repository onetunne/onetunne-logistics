/**
 * Етап 6, WP7: розбір полів форм партнерів (чисті функції, без float). Відсоток «10», «10,5», «8 %» → базисні пункти
 * (1000, 1050, 800); 0…100 %, до 2 знаків. Дні утримання — ціле 0…365.
 */
export function parsePercentBp(input: string | null | undefined): number | null {
  const raw = (input ?? "").replace(/[\s  %]/g, "").replace(",", ".");
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(raw);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

/** Базисні пункти → десятковий рядок відсотка для показу («10», «10.5», «8.25»). */
export function bpToPercent(bp: number): string {
  const int = Math.trunc(bp / 100);
  const frac = String(bp % 100).padStart(2, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : String(int);
}

export function parseHoldDays(input: string | number | null | undefined): number | null {
  const raw = typeof input === "number" ? String(input) : (input ?? "").trim();
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 365 ? n : null;
}

export const PARTNER_NAME_MAX = 120;
export const PARTNER_REFERENCE_MAX = 100;
export const PARTNER_NOTE_MAX = 300;

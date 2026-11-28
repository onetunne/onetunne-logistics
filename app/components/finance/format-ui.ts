/**
 * Етап 6, WP0-UI: чисті помічники показу для фінансових компонентів. Числа й дати форматуються лише через
 * app/lib/format.ts (детерміновано для SSR і браузера); гроші — десяткові рядки, розбір і порівняння — BigInt
 * (app/lib/money.ts). Відсутнє (null, порожнє, пошкоджене) — «—», ніколи не 0.
 */
import type { Locale } from "~/i18n";
import { formatDecimal, formatIsoDate, formatMoney, formatPercent } from "~/lib/format";
import { toMinor } from "~/lib/money";
import type { DateRange } from "~/lib/periods";

export const DASH = "—";

/** Десятковий рядок → мінорні одиниці; null/порожнє/пошкоджене → null (не 0). */
export function parseMinor(value: string | null | undefined): bigint | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  try {
    return toMinor(trimmed);
  } catch {
    return null;
  }
}

/** Знак десяткового рядка (суми або відсотка): 1 / 0 / −1; невідоме → null. */
export function signOf(value: string | null | undefined): -1 | 0 | 1 | null {
  const m = /^([+-])?(\d+)(?:\.(\d+))?$/.exec((value ?? "").trim());
  if (!m) return null;
  if (!/[1-9]/.test(`${m[2]}${m[3] ?? ""}`)) return 0;
  return m[1] === "-" ? -1 : 1;
}

/** Сума з валютою або «—» (відсутнє / пошкоджене значення). */
export function moneyText(amount: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  if (!currency || parseMinor(amount) === null) return DASH;
  return formatMoney(amount!.trim().replace(/^\+/, ""), currency, locale);
}

/** Сума зі знаком «+» для додатних (зміна до періоду порівняння); «—», якщо невідома. */
export function signedMoneyText(amount: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  const text = moneyText(amount, currency, locale);
  return text !== DASH && signOf(amount) === 1 ? `+${text}` : text;
}

/** Відсоток зі знаком «+» для додатних («+12,0 %»); невідомий → «—». */
export function signedPercentText(value: string | null | undefined, locale: Locale): string {
  const text = formatPercent(value ? value.trim().replace(/^\+/, "") : value, locale);
  return text !== DASH && signOf(value) === 1 ? `+${text}` : text;
}

/** Ціле число з групуванням розрядів (кількості, лічильники). */
export function countText(n: number, locale: Locale): string {
  return formatDecimal(n, locale, { maximumFractionDigits: 0 });
}

/**
 * Відрізок дат стисло (§18.3 «01–27.11.2026»): той самий місяць — «01–27.11.2026», той самий рік — «01.10–27.11.2026»,
 * інакше дві повні дати; один день — одна дата. Роздільники — formatIsoDate (uk «.», en «/»).
 */
export function formatDateRange(range: DateRange, locale: Locale): string {
  const from = formatIsoDate(range.from, locale);
  const to = formatIsoDate(range.to, locale);
  if (range.from === range.to) return from;
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  const sameMonth = sameYear && range.from.slice(5, 7) === range.to.slice(5, 7);
  if (sameMonth) return `${from.slice(0, 2)}–${to}`;
  if (sameYear) return `${from.slice(0, 5)}–${to}`;
  return `${from} – ${to}`;
}

/** Місяць "YYYY-MM-01" → «10.2026» (uk) / «10/2026» (en); інше — як є. */
export function formatMonth(month: string, locale: Locale): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(month)) return month;
  return formatIsoDate(`${month.slice(0, 7)}-01`, locale).slice(3);
}

/** Частка value / total × 100 з 1 знаком (половина від нуля), BigInt; total ≤ 0 або невідоме → null. */
export function sharePercent(value: string | null | undefined, total: string | null | undefined): string | null {
  const v = parseMinor(value);
  const t = parseMinor(total);
  if (v === null || t === null || t <= 0n) return null;
  const n = v * 1000n;
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const tenths = (2n * abs + t) / (2n * t);
  const signed = negative && tenths !== 0n ? -tenths : tenths;
  const sign = signed < 0n ? "-" : "";
  const a = signed < 0n ? -signed : signed;
  return `${sign}${a / 10n}.${a % 10n}`;
}

/** Ціла частка (0–100) |value| / max для ширини смуги; невідоме або max = 0 → 0. */
export function barPercent(value: bigint | null, max: bigint): number {
  if (value === null || max <= 0n) return 0;
  const abs = value < 0n ? -value : value;
  const pct = Number((abs * 1000n + max / 2n) / max) / 10;
  if (abs > 0n && pct < 1) return 1;
  return Math.min(100, pct);
}

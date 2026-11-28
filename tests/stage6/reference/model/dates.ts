/**
 * Еталонна модель (WP12a): дати Києва й відрізки (§3.1, §12.1) — власна реалізація без Intl і без app/.
 * Київ: EET (UTC+2), літній час EEST (UTC+3) з останньої неділі березня 01:00 UTC до останньої неділі жовтня
 * 01:00 UTC (правило ЄС, чинне для України).
 */

const DAY_MS = 86_400_000;

function lastSundayUtc(year: number, month0: number): number {
  const lastDay = new Date(Date.UTC(year, month0 + 1, 0));
  const back = lastDay.getUTCDay();
  return Date.UTC(year, month0, lastDay.getUTCDate() - back, 1, 0, 0);
}

/** Зсув Києва від UTC у годинах для моменту `ms`. */
export function kyivOffsetHours(ms: number): 2 | 3 {
  const year = new Date(ms).getUTCFullYear();
  return ms >= lastSundayUtc(year, 2) && ms < lastSundayUtc(year, 9) ? 3 : 2;
}

/** Дата Києва (YYYY-MM-DD) моменту ISO з зоною («2026-10-30T23:30:00Z» → «2026-10-31»). */
export function kyivDate(instant: string): string {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms) || !/(Z|[+-]\d{2}:\d{2})$/.test(instant)) throw new RangeError(`reference: bad instant ${instant}`);
  return new Date(ms + kyivOffsetHours(ms) * 3_600_000).toISOString().slice(0, 10);
}

/** Момент → мс (для порівнянь «відомо на момент»). */
export function instantMs(instant: string): number {
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError(`reference: bad instant ${instant}`);
  return ms;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function dayNumber(date: string): number {
  if (!DATE_RE.test(date)) throw new RangeError(`reference: bad date ${date}`);
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

export function fromDayNumber(n: number): string {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** Кількість днів від a до b (b − a). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

/** Дні [from, to] включно. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = dayNumber(from); d <= dayNumber(to); d++) out.push(fromDayNumber(d));
  return out;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function monthStart(month: string): string {
  return `${month}-01`;
}

export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

export function daysInMonth(month: string): number {
  return Number(monthEnd(month).slice(8, 10));
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Місяці (YYYY-MM), які перетинає [from, to]. */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let m = monthOf(from); m <= monthOf(to); m = addMonths(m, 1)) out.push(m);
  return out;
}

export function inRange(date: string, from: string, to: string): boolean {
  return date >= from && date <= to;
}

/** ISO-тиждень (пн–нд): «2026-W47». */
export function isoWeek(date: string): string {
  const n = dayNumber(date);
  const dow = (new Date(n * DAY_MS).getUTCDay() + 6) % 7; // 0 = пн
  const thursday = n - dow + 3;
  const year = new Date(thursday * DAY_MS).getUTCFullYear();
  const jan1 = dayNumber(`${year}-01-01`);
  const week = Math.floor((thursday - jan1) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export type Granularity = "day" | "week" | "month" | "year";

export function bucketKey(date: string, g: Granularity): string {
  if (g === "day") return date;
  if (g === "week") return isoWeek(date);
  if (g === "month") return monthOf(date);
  return date.slice(0, 4);
}

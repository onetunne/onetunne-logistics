/**
 * Етап 6: календарні відрізки для фінансів і аналітики (docs/stage6-design.md §3.1, §12.1). Чисті функції над датами
 * "YYYY-MM-DD" — датами Києва (бізнес-дата моменту — `businessDate` з app/modules/warehouse/dates.ts).
 * Відрізки: день; ISO-тиждень пн–нд («Тиж. 47 · 2026»); календарний місяць; рік. Календарна арифметика — у UTC над
 * опівночами (без часових поясів і переходів на літній час).
 */
import { businessDate, parseIsoDate } from "~/modules/warehouse/dates";

export { businessDate, parseIsoDate };

export const GRANULARITIES = ["day", "week", "month", "year"] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export const PERIOD_PRESETS = ["today", "yesterday", "last7", "last30", "thisMonth", "lastMonth", "thisYear", "lastYear", "custom"] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const COMPARE_MODES = ["none", "previous", "lastYear"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];

/** Обмеження довільного періоду (§12.1): ≤ 366 днів для днів/тижнів, ≤ 5 років для місяців/років; ≤ 400 відрізків. */
export const MAX_CUSTOM_DAYS_FINE = 366;
export const MAX_CUSTOM_YEARS_COARSE = 5;
export const MAX_BUCKETS = 400;

export interface DateRange {
  /** Включно. */
  from: string;
  /** Включно. */
  to: string;
}

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const iso = parseIsoDate(date);
  if (!iso) throw new RangeError(`invalid date ${date}`);
  return Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10)));
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD" ± n днів. */
export function addDays(date: string, n: number): string {
  return fromUtc(toUtc(date) + n * DAY_MS);
}

/** Кількість днів від a до b (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS);
}

/** Кількість днів відрізка включно. */
export function rangeLength(range: DateRange): number {
  return daysBetween(range.from, range.to) + 1;
}

export function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isDateInRange(date: string, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

/** Усі дні відрізка (включно). */
export function eachDay(range: DateRange): string[] {
  const out: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push(d);
  return out;
}

// --- Місяці -----------------------------------------------------------------

/** Перший день місяця дати ("2026-11-28" → "2026-11-01"). */
export function monthStart(date: string): string {
  toUtc(date);
  return `${date.slice(0, 7)}-01`;
}

/** Останній день місяця. */
export function monthEnd(date: string): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(5, 7));
  return fromUtc(Date.UTC(y, m, 0));
}

/** Перший день місяця зі зсувом на n місяців. */
export function addMonths(month: string, n: number): string {
  const y = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7)) - 1 + n;
  return fromUtc(Date.UTC(y + Math.floor(m / 12), ((m % 12) + 12) % 12, 1));
}

/** Місяці (перші дні), що перетинають відрізок. */
export function monthsInRange(range: DateRange): string[] {
  const out: string[] = [];
  for (let m = monthStart(range.from); m <= range.to; m = addMonths(m, 1)) out.push(m);
  return out;
}

/** Місяць повністю минув на дату today (Київ): закрити можна лише такий (§3.4). */
export function isFullyPastMonth(month: string, today: string): boolean {
  return monthEnd(month) < today;
}

export function isMonthStart(date: string): boolean {
  return parseIsoDate(date) !== null && date.endsWith("-01");
}

// --- ISO-тижні ----------------------------------------------------------------

/** День тижня ISO: 1 — понеділок … 7 — неділя. */
export function isoWeekday(date: string): number {
  const d = new Date(toUtc(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Понеділок ISO-тижня дати. */
export function isoWeekStart(date: string): string {
  return addDays(date, 1 - isoWeekday(date));
}

/** ISO-рік і номер тижня (тиждень із четвергом належить його року). */
export function isoWeekOf(date: string): { year: number; week: number } {
  const thursday = addDays(date, 4 - isoWeekday(date));
  const year = Number(thursday.slice(0, 4));
  const jan1 = `${year}-01-01`;
  return { year, week: Math.floor(daysBetween(jan1, thursday) / 7) + 1 };
}

// --- Роки -------------------------------------------------------------------

export function yearStart(date: string): string {
  toUtc(date);
  return `${date.slice(0, 4)}-01-01`;
}
export function yearEnd(date: string): string {
  toUtc(date);
  return `${date.slice(0, 4)}-12-31`;
}

// --- Відрізки ----------------------------------------------------------------

export interface Bucket {
  /** Стабільний ключ: "2026-11-28" | "2026-W48" | "2026-11" | "2026". */
  key: string;
  granularity: Granularity;
  /** Межі відрізка, обрізані до запитаного діапазону (включно). */
  from: string;
  to: string;
  /** Для тижня — ISO-рік і номер (підпис «Тиж. 47 · 2026» — i18n finance.period.weekLabel). */
  isoYear?: number;
  isoWeek?: number;
}

/** Ключ відрізка дати. */
export function bucketKey(date: string, granularity: Granularity): string {
  switch (granularity) {
    case "day":
      return date;
    case "week": {
      const { year, week } = isoWeekOf(date);
      return `${year}-W${String(week).padStart(2, "0")}`;
    }
    case "month":
      return date.slice(0, 7);
    case "year":
      return date.slice(0, 4);
  }
}

function bucketStart(date: string, granularity: Granularity): string {
  return granularity === "day" ? date : granularity === "week" ? isoWeekStart(date) : granularity === "month" ? monthStart(date) : yearStart(date);
}

function bucketEnd(start: string, granularity: Granularity): string {
  return granularity === "day" ? start : granularity === "week" ? addDays(start, 6) : granularity === "month" ? monthEnd(start) : yearEnd(start);
}

/** Відрізки діапазону (перший і останній обрізано до діапазону). Більше MAX_BUCKETS → RangeError. */
export function bucketsFor(range: DateRange, granularity: Granularity): Bucket[] {
  if (range.from > range.to) throw new RangeError("range.from after range.to");
  const out: Bucket[] = [];
  for (let start = bucketStart(range.from, granularity); start <= range.to; start = addDays(bucketEnd(start, granularity), 1)) {
    const end = bucketEnd(start, granularity);
    const from = start < range.from ? range.from : start;
    const to = end > range.to ? range.to : end;
    const b: Bucket = { key: bucketKey(from, granularity), granularity, from, to };
    if (granularity === "week") {
      const w = isoWeekOf(from);
      b.isoYear = w.year;
      b.isoWeek = w.week;
    }
    out.push(b);
    if (out.length > MAX_BUCKETS) throw new RangeError(`more than ${MAX_BUCKETS} buckets`);
  }
  return out;
}

/** Автовідрізок (§12.1): ≤ 31 д → день, ≤ 26 тижнів → тиждень, ≤ 3 роки → місяць, інакше рік. */
export function autoGranularity(range: DateRange): Granularity {
  const days = rangeLength(range);
  if (days <= 31) return "day";
  if (days <= 26 * 7) return "week";
  if (days <= 3 * 366) return "month";
  return "year";
}

/** Чи дозволено довільний період для відрізка (§12.1). */
export function isAllowedCustomRange(range: DateRange, granularity: Granularity): boolean {
  if (range.from > range.to) return false;
  if (granularity === "day" || granularity === "week") return rangeLength(range) <= MAX_CUSTOM_DAYS_FINE;
  return range.from >= addMonths(monthStart(range.to), -12 * MAX_CUSTOM_YEARS_COARSE);
}

/** Період за шаблоном (§12.1). today — дата Києва. custom — from/to (перевіряються викликачем). */
export function resolvePreset(preset: Exclude<PeriodPreset, "custom">, today: string): DateRange {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDays(today, -1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: addDays(today, -6), to: today };
    case "last30":
      return { from: addDays(today, -29), to: today };
    case "thisMonth":
      return { from: monthStart(today), to: today };
    case "lastMonth": {
      const m = addMonths(monthStart(today), -1);
      return { from: m, to: monthEnd(m) };
    }
    case "thisYear":
      return { from: yearStart(today), to: today };
    case "lastYear": {
      const y = `${Number(today.slice(0, 4)) - 1}-01-01`;
      return { from: y, to: yearEnd(y) };
    }
  }
}

/** Той самий день торік (29.02 → 28.02). */
export function sameDayLastYear(date: string): string {
  const y = Number(date.slice(0, 4)) - 1;
  const md = date.slice(5);
  const candidate = `${y}-${md}`;
  return parseIsoDate(candidate) ?? `${y}-02-28`;
}

/** Період порівняння (§12.1): попередній тієї самої довжини або той самий торік. */
export function comparisonRange(range: DateRange, mode: Exclude<CompareMode, "none">): DateRange {
  if (mode === "previous") {
    const len = rangeLength(range);
    return { from: addDays(range.from, -len), to: addDays(range.from, -1) };
  }
  return { from: sameDayLastYear(range.from), to: sameDayLastYear(range.to) };
}

/** Дата Києва моменту (скорочення для сервісів: `todayKyiv(ctx.now())`). */
export function todayKyiv(now: Date): string {
  return businessDate(now);
}

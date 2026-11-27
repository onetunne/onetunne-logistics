/**
 * Межі календарного дня в часовому поясі бізнесу (Europe/Kyiv) для фільтрів за датою (чисті функції).
 * «З 01.11» — від 00:00 за Києвом, «по 30.11» — до кінця дня за Києвом (з урахуванням переходу на літній час).
 */
import { BUSINESS_TIME_ZONE } from "~/lib/format";

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

/** Зсув часового поясу бізнесу (мс) у момент instant: місцевий час − UTC. */
function zoneOffsetMs(instant: number): number {
  const parts = partsFormatter.formatToParts(new Date(instant));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** "YYYY-MM-DD" → та сама дата, якщо вона існує в календарі; інакше null. */
export function parseIsoDate(value: string | null | undefined): string | null {
  const m = ISO_DATE_RE.exec((value ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Початок дня (00:00 Europe/Kyiv) як момент UTC. */
export function businessDayStart(isoDate: string): Date {
  const m = ISO_DATE_RE.exec(isoDate);
  if (!m) throw new RangeError("invalid date");
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  let ts = guess - zoneOffsetMs(guess);
  // Уточнення, якщо зсув у знайдений момент інший (перехід на літній/зимовий час).
  const corrected = guess - zoneOffsetMs(ts);
  if (corrected !== ts) ts = corrected;
  return new Date(ts);
}

/** Останній момент дня (включно): початок наступного дня − 1 мс. */
export function businessDayEnd(isoDate: string): Date {
  const start = businessDayStart(isoDate);
  const next = new Date(start.getTime() + 36 * 3600 * 1000);
  const nextIso = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(next);
  return new Date(businessDayStart(nextIso).getTime() - 1);
}

/** Дата (YYYY-MM-DD) моменту в часовому поясі бізнесу. */
export function businessDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    value,
  );
}

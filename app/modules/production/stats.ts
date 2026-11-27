/**
 * Статистика виробництва за період (чисті функції, без БД): період, момент завершення партії, вчасність відносно
 * планової дати готовності, брак за моделлю/кольором. Запити — stats.server.ts.
 *
 * Визначення:
 * - «Отримано» — надходження з виробництва (production_receipts.received_at) у межах періоду (дати за Києвом):
 *   якісні й браковані одиниці рядків надходжень.
 * - Частка браку — брак / (якісні + брак), %, один знак (defectRatePercent, як у картці партії).
 * - Партія «завершена» — стан «Отримано» або «Закрито» з надходженнями; момент завершення — надходження, після якого
 *   КОЖНА позиція виготовлена (якісні + брак) не менше, ніж замовлено (як стан «Отримано» — statusAfterReceipt);
 *   надлишок однієї позиції не завершує партію, поки інша відкрита. Якщо партію закрили раніше — останнє надходження.
 *   Партія входить у період, якщо момент завершення (дата за Києвом) у межах періоду.
 * - «Вчасно» — дата завершення не пізніше planned_ready_date; без планової дати — окремо (не входить у частку).
 */
import { defectRatePercent } from "./calc";

export const STATS_PERIODS = ["30", "90", "365"] as const;
export type StatsPeriodKey = (typeof STATS_PERIODS)[number];
export const DEFAULT_STATS_PERIOD: StatsPeriodKey = "90";

export function isStatsPeriod(value: unknown): value is StatsPeriodKey {
  return typeof value === "string" && (STATS_PERIODS as readonly string[]).includes(value);
}

export interface StatsPeriod {
  key: StatsPeriodKey;
  days: number;
  /** YYYY-MM-DD включно (за Києвом). */
  from: string;
  to: string;
}

/** "YYYY-MM-DD" + n днів (календарна дата). */
export function addIsoDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Останні N днів до сьогодні включно. */
export function statsPeriod(key: StatsPeriodKey, today: string): StatsPeriod {
  const days = Number(key);
  return { key, days, from: addIsoDays(today, -(days - 1)), to: today };
}

export interface BatchLineOrdered {
  lineId: string;
  /** Замовлено за позицією. */
  ordered: number;
}

export interface LineReceiptPoint {
  /** Позиція партії (production_batch_lines.id). */
  lineId: string;
  receivedAt: Date;
  /** Якісні + брак цієї позиції в надходженні. */
  produced: number;
}

/**
 * Момент завершення партії — перше надходження (за часом), після якого кожна позиція виготовлена ≥ замовлено (той самий
 * критерій, що й перехід у стан «Отримано»: statusAfterReceipt). Надлишок однієї позиції (allowOverReceipt) не
 * зараховується іншій. Якщо якась позиція так і не виготовлена повністю (партію закрили раніше) — останнє надходження;
 * без надходжень — null.
 */
export function batchCompletionTime(lines: readonly BatchLineOrdered[], receipts: readonly LineReceiptPoint[]): Date | null {
  if (receipts.length === 0) return null;
  const sorted = [...receipts].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  const last = sorted[sorted.length - 1]!.receivedAt;
  // Як statusAfterReceipt: партія без позицій «Отримано» не стає.
  if (lines.length === 0) return last;
  const ordered = new Map<string, number>();
  for (const l of lines) ordered.set(l.lineId, (ordered.get(l.lineId) ?? 0) + l.ordered);
  // Позиції, яким ще бракує одиниць (замовлено 0 — уже виготовлена).
  const open = new Set([...ordered].filter(([, qty]) => qty > 0).map(([id]) => id));
  if (open.size === 0) return sorted[0]!.receivedAt;
  const produced = new Map<string, number>();
  for (const r of sorted) {
    if (!open.has(r.lineId)) continue;
    const total = (produced.get(r.lineId) ?? 0) + Math.max(0, r.produced);
    produced.set(r.lineId, total);
    if (total >= ordered.get(r.lineId)!) {
      open.delete(r.lineId);
      if (open.size === 0) return r.receivedAt;
    }
  }
  return last;
}

export type Timeliness = "onTime" | "late" | "noDate";

/** Вчасність за датою завершення (YYYY-MM-DD за Києвом) і плановою датою готовності. */
export function timelinessOf(completedOn: string, plannedReadyDate: string | null): Timeliness {
  if (!plannedReadyDate) return "noDate";
  return completedOn <= plannedReadyDate ? "onTime" : "late";
}

export interface TimelinessSummary {
  /** Завершено в періоді (усі). */
  completed: number;
  onTime: number;
  late: number;
  withoutDate: number;
  /** onTime / (onTime + late), %, один знак; null — немає завершених партій із плановою датою. */
  onTimeRate: number | null;
}

export function summarizeTimeliness(values: readonly Timeliness[]): TimelinessSummary {
  const onTime = values.filter((v) => v === "onTime").length;
  const late = values.filter((v) => v === "late").length;
  const dated = onTime + late;
  return {
    completed: values.length,
    onTime,
    late,
    withoutDate: values.length - dated,
    onTimeRate: dated > 0 ? Math.round((onTime * 1000) / dated) / 10 : null,
  };
}

export interface DefectGroup {
  /** Модель або колір; null — варіанти без моделі (кольору). */
  value: string | null;
  good: number;
  defective: number;
  produced: number;
  defectRate: number | null;
}

/**
 * Підсумок за значенням (модель або колір): якісні, брак, частка браку. Порядок: більше виготовлено ↑ вище, далі
 * назва; «без значення» — останнім.
 */
export function groupDefects(rows: ReadonlyArray<{ value: string | null; good: number; defective: number }>): DefectGroup[] {
  const acc = new Map<string | null, { good: number; defective: number }>();
  for (const r of rows) {
    const value = r.value?.trim() ? r.value.trim() : null;
    const g = acc.get(value) ?? { good: 0, defective: 0 };
    g.good += r.good;
    g.defective += r.defective;
    acc.set(value, g);
  }
  const collator = new Intl.Collator("uk");
  return [...acc]
    .map(([value, g]) => ({ value, ...g, produced: g.good + g.defective, defectRate: defectRatePercent(g.defective, g.good + g.defective) }))
    .filter((g) => g.produced > 0)
    .sort((a, b) => {
      if ((a.value === null) !== (b.value === null)) return a.value === null ? 1 : -1;
      return b.produced - a.produced || collator.compare(a.value ?? "", b.value ?? "");
    });
}

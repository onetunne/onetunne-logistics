/**
 * Еталонна модель (WP12a): закриття місяця й остаточні знімки звіту (§3.4, §13.1, §2.6 «Діапазон із закритими
 * місяцями», I15).
 *
 *  - Закриття: лише повністю минулий місяць (Київ, на момент закриття). Блокує: замовлення, визнані в місяці, не `final`;
 *    записи місяця без курсу для КОЖНОЇ валюти показу (запасний курс ≤ 7 днів — курс є). Закриття → незмінний
 *    остаточний знімок у кожній валюті показу (звіт місяця + денні рядки); після повторного відкриття наступне
 *    закриття — нова версія, старі зберігаються.
 *  - Звіт закритого місяця = його знімок у валюті показу: курси, отримані пізніше, і пізні записи (вони проводяться
 *    в інші місяці, I12) його не змінюють. Валюта без знімка (додана до показу після закриття) — живий перерахунок
 *    з позначкою `liveNotSnapshot` («Живий перерахунок, не знімок»). Відкритий місяць — наживо.
 *  - Діапазон: закриті місяці дають денні рядки свого знімка, відкриті — живі; рядки й прибуток діапазону = Σ днів =
 *    Σ місяців (I15). Правило «—» (є замовлення, але жодне не final) — до суми діапазону.
 */
import { cents, str, type Cents } from "./money";
import { eachDay, instantMs, kyivDate, monthEnd, monthOf, monthsBetween, monthStart } from "./dates";
import type { ConvertContext } from "./fx";
import { isMonthClosedAt, type RefMonthClosure } from "./journal";
import { COLUMNS, pnlReport, type Column, type PnlResult, type RefJournal } from "./pnl";

export type RowColumns = Record<Column | "total", Record<string, string>>;

/** Денний рядок знімка (лише агрегати, без ідентифікаторів замовлень). */
export interface DayRow {
  date: string;
  columns: RowColumns;
  factValue: string;
  forecastValue: string;
  /** Покриття дня (для правила «—» діапазону). */
  orders: number;
  final: number;
  preliminary: number;
}

export interface RefReportSnapshot {
  month: string;
  currency: string;
  version: number;
  isFinal: true;
  takenAt: string;
  report: PnlResult;
  days: DayRow[];
}

const ALL_COLUMNS: ReadonlyArray<Column | "total"> = [...COLUMNS, "total"];

/** Денні рядки P&L (кожен день — окремий звіт; сума днів = звіт діапазону). */
export function dayRows(j: RefJournal, from: string, to: string, currency: string, ctx: ConvertContext): DayRow[] {
  return eachDay(from, to).map((date) => {
    const r = pnlReport(j, { from: date, to: date, currency, ctx });
    return {
      date,
      columns: r.columns,
      factValue: r.raw.factValue,
      forecastValue: r.raw.forecastValue,
      orders: r.completeness.orders,
      final: r.completeness.final,
      preliminary: r.completeness.preliminary,
    };
  });
}

export type CloseBlocker = { code: "month_not_past" } | { code: "order_not_final"; orderId: string } | { code: "missing_rate"; currency: string; entries: number };

export interface CloseMonthInput {
  month: string;
  closedAt: string;
  displayCurrencies: readonly string[];
  ctx: ConvertContext;
  /** Чек-лист: усі категорії витрат і податки підтверджено (§2.7). */
  allConfirmedWithTaxes: boolean;
  /** Наявні знімки (після повторного відкриття — нова версія). */
  previous?: readonly RefReportSnapshot[];
}

export type CloseMonthResult = { ok: true; closure: RefMonthClosure; snapshots: RefReportSnapshot[] } | { ok: false; blockers: CloseBlocker[] };

/** Закриття місяця (§3.4): блокери чек-листа → знімки в кожній валюті показу. */
export function closeMonth(j: RefJournal, i: CloseMonthInput): CloseMonthResult {
  const from = monthStart(i.month);
  const to = monthEnd(i.month);
  const blockers: CloseBlocker[] = [];
  if (!(to < kyivDate(i.closedAt))) blockers.push({ code: "month_not_past" });
  for (const m of j.orders) {
    if (m.recognizedOn !== null && monthOf(m.recognizedOn) === i.month && (m.state === "preliminary" || m.state === "incomplete")) blockers.push({ code: "order_not_final", orderId: m.orderId });
  }
  const reports = i.displayCurrencies.map((currency) => ({ currency, report: pnlReport(j, { from, to, currency, ctx: i.ctx }) }));
  for (const { currency, report } of reports) {
    const n = report.unconverted.reduce((a, u) => a + u.entries, 0);
    if (n > 0) blockers.push({ code: "missing_rate", currency, entries: n });
  }
  if (blockers.length > 0) return { ok: false, blockers };
  const snapshots = reports.map(({ currency, report }) => {
    const prev = (i.previous ?? []).filter((s) => s.month === i.month && s.currency === currency);
    return {
      month: i.month,
      currency,
      version: prev.reduce((a, s) => Math.max(a, s.version), 0) + 1,
      isFinal: true as const,
      takenAt: i.closedAt,
      report,
      days: dayRows(j, from, to, currency, i.ctx),
    };
  });
  return { ok: true, closure: { month: i.month, closedAt: i.closedAt, allConfirmedWithTaxes: i.allConfirmedWithTaxes }, snapshots };
}

export interface ReportSources {
  /** Поточний журнал (живий перерахунок). */
  journal: RefJournal;
  /** Поточні курси (зокрема отримані після закриття). */
  ctx: ConvertContext;
  snapshots: readonly RefReportSnapshot[];
  closures: readonly RefMonthClosure[];
  /** Момент показу звіту. */
  at: string;
}

function latestSnapshot(s: ReportSources, month: string, currency: string): RefReportSnapshot | null {
  const xs = s.snapshots.filter((x) => x.month === month && x.currency === currency && instantMs(x.takenAt) <= instantMs(s.at));
  return xs.reduce<RefReportSnapshot | null>((a, x) => (a === null || x.version > a.version ? x : a), null);
}

export interface MonthReport {
  month: string;
  source: "snapshot" | "live";
  /** «Живий перерахунок, не знімок» — місяць закрито, але знімка у цій валюті немає. */
  liveNotSnapshot: boolean;
  version: number | null;
  report: PnlResult;
}

/** Звіт місяця у валюті показу: закритий — знімок (або живий з позначкою), відкритий — наживо. */
export function monthReport(month: string, currency: string, s: ReportSources): MonthReport {
  const closed = isMonthClosedAt(s.closures, month, s.at);
  const snap = closed ? latestSnapshot(s, month, currency) : null;
  if (snap) return { month, source: "snapshot", liveNotSnapshot: false, version: snap.version, report: snap.report };
  return { month, source: "live", liveNotSnapshot: closed, version: null, report: pnlReport(s.journal, { from: monthStart(month), to: monthEnd(month), currency, ctx: s.ctx }) };
}

export interface RangeReport {
  parts: Array<{ month: string; from: string; to: string; source: "snapshot" | "live"; liveNotSnapshot: boolean; version: number | null }>;
  columns: RowColumns;
  profit: { fact: string | null; forecast: string | null };
  raw: { factValue: string; forecastValue: string };
}

/** Діапазон (зокрема неповні місяці): денні рядки знімків закритих місяців + живі рядки відкритих; Σ — точно (I15). */
export function rangeReport(from: string, to: string, currency: string, s: ReportSources): RangeReport {
  const parts: RangeReport["parts"] = [];
  const rows: DayRow[] = [];
  for (const month of monthsBetween(from, to)) {
    const pf = from > monthStart(month) ? from : monthStart(month);
    const pt = to < monthEnd(month) ? to : monthEnd(month);
    const closed = isMonthClosedAt(s.closures, month, s.at);
    const snap = closed ? latestSnapshot(s, month, currency) : null;
    if (snap) rows.push(...snap.days.filter((d) => d.date >= pf && d.date <= pt));
    else rows.push(...dayRows(s.journal, pf, pt, currency, s.ctx));
    parts.push({ month, from: pf, to: pt, source: snap ? "snapshot" : "live", liveNotSnapshot: closed && !snap, version: snap?.version ?? null });
  }
  const acc = Object.fromEntries(ALL_COLUMNS.map((c) => [c, new Map<string, Cents>()])) as Record<Column | "total", Map<string, Cents>>;
  let fact = 0n;
  let fc = 0n;
  let orders = 0;
  let final = 0;
  let prelim = 0;
  for (const d of rows) {
    for (const c of ALL_COLUMNS) for (const [k, v] of Object.entries(d.columns[c])) acc[c].set(k, (acc[c].get(k) ?? 0n) + cents(v));
    fact += cents(d.factValue);
    fc += cents(d.forecastValue);
    orders += d.orders;
    final += d.final;
    prelim += d.preliminary;
  }
  const columns = Object.fromEntries(ALL_COLUMNS.map((c) => [c, Object.fromEntries([...acc[c].entries()].map(([k, v]) => [k, str(v)]))])) as RowColumns;
  return {
    parts,
    columns,
    profit: { fact: orders > 0 && final === 0 ? null : str(fact), forecast: orders > 0 && final + prelim === 0 ? null : str(fc) },
    raw: { factValue: str(fact), forecastValue: str(fc) },
  };
}

/**
 * Еталонна модель (WP12a): агрегатор журналу — P&L зі стовпцями за станами, правило повноти, валовий прибуток,
 * рентабельності (поріг 90 %), середній чек, середній прибуток замовлення, порівняння (§2.2, §2.3, §2.6, §12.1–§12.2).
 *
 * Тлумачення, зафіксовані моделлю (і передані WP8/WP12b):
 *  - «Облік періоду»: записи з recognized_on ∈ P; стовпець запису — стан ЙОГО замовлення (final / preliminary /
 *    incomplete); записи без order_id і записи замовлень closed_unrecognized / excluded — «Витрати періоду».
 *  - Прибуток «Факт» = Σ final + Σ періоду; «—» (null), якщо в періоді є замовлення, але жодне не final.
 *    «≈ Прогноз» = Факт + Σ (записи + прогнози) preliminary; null, якщо замовлення є, але жодне не final/preliminary.
 *  - Рентабельність періоду = прибуток / NR ТОГО САМОГО набору замовлень (правило «чисельник і знаменник — той самий
 *    набір»), лише якщо NR набору ≥ 90 % NR усіх визнаних замовлень періоду; інакше null + покриття у %.
 *  - Середній чек і середній прибуток — «замовлення періоду» (визнані в P, усі їхні записи).
 */
import { cents, divRound, percent1, str, sum, type Cents } from "./money";
import { affectsProfit, isNetRevenue, kindOf, lineOf, PNL_LINE_KEYS, type PnlLineKey, type RefCategory, type RefComponent } from "./categories";
import { convert, type ConvertContext } from "./fx";
import type { RefEntry } from "./journal";
import type { ComponentState, OrderState, RefForecast } from "./order-posting";

export interface RefOrderMeta {
  orderId: string;
  state: OrderState;
  recognizedOn: string | null;
  country?: string;
  components?: Partial<Record<RefComponent, { state: ComponentState; basis?: string | null }>>;
  missing?: readonly RefComponent[];
}

export interface RefJournal {
  entries: readonly RefEntry[];
  orders: readonly RefOrderMeta[];
  forecasts: readonly RefForecast[];
}

export interface ReportOptions {
  from: string;
  to: string;
  currency: string;
  ctx: ConvertContext;
}

export type Column = "final" | "preliminary" | "incomplete" | "period";
export const COLUMNS: readonly Column[] = ["final", "preliminary", "incomplete", "period"];

export interface ColumnSums {
  lines: Record<PnlLineKey, Cents>;
  memo: Partial<Record<RefCategory, Cents>>;
  T: Cents;
  NR: Cents;
  GP: Cents;
  PR: Cents;
}

const RECOGNIZED: ReadonlySet<OrderState> = new Set(["final", "preliminary", "incomplete"]);

export function emptySums(): ColumnSums {
  const lines = Object.fromEntries(PNL_LINE_KEYS.map((k) => [k, 0n])) as Record<PnlLineKey, Cents>;
  return { lines, memo: {}, T: 0n, NR: 0n, GP: 0n, PR: 0n };
}

function addTo(s: ColumnSums, category: RefCategory, v: Cents): void {
  const line = lineOf(category);
  if (line === "memo") {
    s.memo[category] = (s.memo[category] ?? 0n) + v;
    return;
  }
  s.lines[line] += v;
  if (kindOf(category) === "revenue") s.T += v;
  if (isNetRevenue(category)) s.NR += v;
  if (isNetRevenue(category) || kindOf(category) === "cogs") s.GP += v;
  if (affectsProfit(category)) s.PR += v;
}

export class Converter {
  readonly unconverted = new Map<string, { amount: Cents; entries: number }>();
  constructor(
    readonly currency: string,
    readonly ctx: ConvertContext,
  ) {}
  /** Сконвертоване значення або null (тоді запис потрапляє в «Без курсу»). */
  of(e: { amount: string; currency: string; fxOn: string }): Cents | null {
    const a = cents(e.amount);
    const c = convert(a, e.currency, this.currency, e.fxOn, this.ctx);
    if (c === null) {
      const m = this.unconverted.get(e.currency) ?? { amount: 0n, entries: 0 };
      m.amount += a;
      m.entries += 1;
      this.unconverted.set(e.currency, m);
    }
    return c;
  }
  list(): Array<{ currency: string; amount: string; entries: number }> {
    return [...this.unconverted.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, m]) => ({ currency, amount: str(m.amount), entries: m.entries }));
  }
}

const inP = (d: string | null, o: ReportOptions) => d !== null && d >= o.from && d <= o.to;

function metaMap(j: RefJournal): Map<string, RefOrderMeta> {
  return new Map(j.orders.map((m) => [m.orderId, m]));
}

export function columnOf(e: RefEntry, metas: Map<string, RefOrderMeta>): Column {
  if (!e.orderId) return "period";
  const st = metas.get(e.orderId)?.state;
  return st === "final" || st === "preliminary" || st === "incomplete" ? st : "period";
}

const settledState = (s: ComponentState | undefined) => s === "actual" || s === "zero_confirmed" || s === "not_applicable";

export interface PnlResult {
  columns: Record<Column | "total", Record<string, string>>;
  turnover: string;
  netRevenue: string;
  /** «Оцінка» (order_snapshot) замовлень, визнаних у періоді, — окремо, ніколи не у факті. */
  estimate: { orders: number; amount: string };
  profit: { fact: string | null; forecast: string | null; orders: number; factOrders: number; forecastOrders: number };
  /**
   * Адитивні суми до правила «—» (для денних рядків знімка й діапазонів, I15): factValue = Σ final + Σ періоду;
   * forecastValue = factValue + Σ (записи + прогнози) preliminary; prelimForecast — Σ прогнозів preliminary.
   */
  raw: { factValue: string; forecastValue: string; prelimForecast: string };
  grossProfit: { value: string; ordersValue: string; periodAdjustment: string; orders: number; margin: string | null };
  orderMargin: { fact: string | null; forecast: string | null };
  periodMargin: { fact: string | null; factCoveragePct: number | null; forecast: string | null; forecastCoveragePct: number | null };
  notCounted: { orders: number; turnover: string; netRevenue: string };
  completeness: { orders: number; final: number; preliminary: number; incomplete: number; missingByComponent: Partial<Record<RefComponent, number>>; lateEntries: number };
  unconverted: Array<{ currency: string; amount: string; entries: number }>;
}

function render(s: ColumnSums, withProfit: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of PNL_LINE_KEYS) out[k] = str(s.lines[k]);
  for (const [k, v] of Object.entries(s.memo)) out[k] = str(v!);
  out.T = str(s.T);
  out.NR = str(s.NR);
  out.GP = str(s.GP);
  if (withProfit) out.PR = str(s.PR);
  return out;
}

/** Відсоток покриття, ціле (половина від нуля). */
function coveragePct(part: Cents, all: Cents): number | null {
  if (all <= 0n) return null;
  return Number(divRound(part * 100n, all));
}

/** P&L за період у валюті звітності (облік періоду, §2.2/§2.6). */
export function pnlReport(j: RefJournal, o: ReportOptions): PnlResult {
  const metas = metaMap(j);
  const conv = new Converter(o.currency, o.ctx);
  const cols: Record<Column, ColumnSums> = { final: emptySums(), preliminary: emptySums(), incomplete: emptySums(), period: emptySums() };
  const total = emptySums();
  const orders = new Set<string>();
  const gpOrders = new Map<string, Cents>();
  const gpNr = new Map<string, Cents>();
  let periodAdj = 0n;
  let late = 0;
  for (const e of j.entries) {
    if (!inP(e.recognizedOn, o)) continue;
    const v = conv.of(e);
    if (v === null) continue;
    if (e.isLate) late += 1;
    const col = columnOf(e, metas);
    addTo(cols[col], e.category, v);
    addTo(total, e.category, v);
    if (col !== "period" && e.orderId) {
      // Покриття «за N з M» — замовлення з записами, що впливають на прибуток (довідкові не рахуються, I8).
      if (affectsProfit(e.category)) orders.add(e.orderId);
      const m = metas.get(e.orderId)!;
      if (settledState(m.components?.revenue?.state) && settledState(m.components?.cogs?.state ?? "not_applicable")) {
        if (isNetRevenue(e.category) || kindOf(e.category) === "cogs") gpOrders.set(e.orderId, (gpOrders.get(e.orderId) ?? 0n) + v);
        if (isNetRevenue(e.category)) gpNr.set(e.orderId, (gpNr.get(e.orderId) ?? 0n) + v);
        if (!gpOrders.has(e.orderId)) gpOrders.set(e.orderId, 0n);
      }
    }
    if (!e.orderId && e.category === "cogs_adjustment") periodAdj += v;
  }
  // Прогнози preliminary-замовлень (датою визнання в P).
  let prelimForecast = 0n;
  for (const f of j.forecasts) {
    const m = metas.get(f.orderId);
    if (!m || m.state !== "preliminary" || !inP(f.recognizedOn, o)) continue;
    const v = conv.of(f);
    if (v !== null) prelimForecast += v;
  }
  const count = (st: OrderState) => [...orders].filter((id) => metas.get(id)?.state === st).length;
  const nFinal = count("final");
  const nPrelim = count("preliminary");
  const nInc = count("incomplete");
  const nOrders = orders.size;
  const factValue = cols.final.PR + cols.period.PR;
  const fact = nOrders > 0 && nFinal === 0 ? null : factValue;
  const forecastValue = factValue + cols.preliminary.PR + prelimForecast;
  const forecast = nOrders > 0 && nFinal + nPrelim === 0 ? null : forecastValue;
  const allNr = cols.final.NR + cols.preliminary.NR + cols.incomplete.NR;
  const factNr = cols.final.NR;
  const fcNr = cols.final.NR + cols.preliminary.NR;
  const covers = (part: Cents) => allNr > 0n && part * 10n >= allNr * 9n;
  const missingByComponent: Partial<Record<RefComponent, number>> = {};
  for (const id of orders) {
    const m = metas.get(id)!;
    for (const c of m.missing ?? []) missingByComponent[c] = (missingByComponent[c] ?? 0) + 1;
  }
  // «Оцінка» виручки — окремим рядком.
  let est = 0n;
  let estOrders = 0;
  for (const f of j.forecasts) {
    if (f.component !== "revenue" || f.basis !== "order_snapshot") continue;
    const m = metas.get(f.orderId);
    if (!m || !RECOGNIZED.has(m.state) || !inP(m.recognizedOn, o)) continue;
    const v = conv.of(f);
    if (v === null) continue;
    est += v;
    estOrders += 1;
  }
  const gpValue = sum([...gpOrders.values()]);
  const gpNrValue = sum([...gpNr.values()]);
  const columns = {
    final: render(cols.final, false),
    preliminary: render(cols.preliminary, false),
    incomplete: render(cols.incomplete, false),
    period: render(cols.period, false),
    total: render(total, false),
  };
  return {
    columns,
    turnover: str(total.T),
    netRevenue: str(total.NR),
    estimate: { orders: estOrders, amount: str(est) },
    profit: { fact: fact === null ? null : str(fact), forecast: forecast === null ? null : str(forecast), orders: nOrders, factOrders: nFinal, forecastOrders: nFinal + nPrelim },
    raw: { factValue: str(factValue), forecastValue: str(forecastValue), prelimForecast: str(prelimForecast) },
    grossProfit: { value: str(gpValue + periodAdj), ordersValue: str(gpValue), periodAdjustment: str(periodAdj), orders: gpOrders.size, margin: percent1(gpValue, gpNrValue) },
    orderMargin: {
      fact: nFinal > 0 ? percent1(cols.final.PR, cols.final.NR) : null,
      forecast: nFinal + nPrelim > 0 ? percent1(cols.final.PR + cols.preliminary.PR + prelimForecast, fcNr) : null,
    },
    periodMargin: {
      fact: fact !== null && covers(factNr) ? percent1(fact, factNr) : null,
      factCoveragePct: coveragePct(factNr, allNr),
      forecast: forecast !== null && covers(fcNr) ? percent1(forecast, fcNr) : null,
      forecastCoveragePct: coveragePct(fcNr, allNr),
    },
    notCounted: { orders: nInc, turnover: str(cols.incomplete.T), netRevenue: str(cols.incomplete.NR) },
    completeness: { orders: nOrders, final: nFinal, preliminary: nPrelim, incomplete: nInc, missingByComponent, lateEntries: late },
    unconverted: conv.list(),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// «Замовлення періоду»: прибуток замовлення, середній чек, середній прибуток
// ---------------------------------------------------------------------------------------------------------------

export interface OrderProfit {
  orderId: string;
  state: OrderState;
  /** Σ записів замовлення (усі дати) у валюті звітності. */
  entriesProfit: Cents;
  /** Σ прогнозів незавершених складників. */
  forecast: Cents;
  netRevenue: Cents;
  turnover: Cents;
  unconverted: number;
}

/** Прибуток одного замовлення за всі його записи (I4: картка = Σ записів замовлення, сконвертованих). */
export function orderProfit(j: RefJournal, orderId: string, currency: string, ctx: ConvertContext): OrderProfit {
  const m = j.orders.find((x) => x.orderId === orderId);
  const conv = new Converter(currency, ctx);
  let p = 0n;
  let nr = 0n;
  let t = 0n;
  for (const e of j.entries) {
    if (e.orderId !== orderId) continue;
    const v = conv.of(e);
    if (v === null) continue;
    if (affectsProfit(e.category)) p += v;
    if (isNetRevenue(e.category)) nr += v;
    if (kindOf(e.category) === "revenue") t += v;
  }
  let f = 0n;
  for (const x of j.forecasts) {
    if (x.orderId !== orderId || x.component === "revenue") continue;
    const v = conv.of(x);
    if (v !== null) f += v;
  }
  return { orderId, state: m?.state ?? "open", entriesProfit: p, forecast: f, netRevenue: nr, turnover: t, unconverted: [...conv.unconverted.values()].reduce((a, x) => a + x.entries, 0) };
}

function ordersOfPeriod(j: RefJournal, o: ReportOptions): RefOrderMeta[] {
  return j.orders.filter((m) => RECOGNIZED.has(m.state) && inP(m.recognizedOn, o));
}

/** Середній чек (§2.6, §12.2): «Факт» = оборот / замовлення з фактичною виручкою; «≈ з оцінками» — / усі визнані. */
export function averageCheck(j: RefJournal, o: ReportOptions): { fact: string | null; factOrders: number; withEstimates: string | null; orders: number; turnoverFact: string; estimate: string } {
  const list = ordersOfPeriod(j, o);
  const conv = new Converter(o.currency, o.ctx);
  let t = 0n;
  let n = 0;
  let est = 0n;
  for (const m of list) {
    const revenueActual = m.components?.revenue?.state === "actual";
    if (revenueActual) {
      n += 1;
      t += orderProfit(j, m.orderId, o.currency, o.ctx).turnover;
    } else {
      for (const f of j.forecasts) {
        if (f.orderId === m.orderId && f.component === "revenue") {
          const v = conv.of(f);
          if (v !== null) est += v;
        }
      }
    }
  }
  return {
    fact: n > 0 ? str(divRound(t, BigInt(n))) : null,
    factOrders: n,
    withEstimates: list.length > 0 ? str(divRound(t + est, BigInt(list.length))) : null,
    orders: list.length,
    turnoverFact: str(t),
    estimate: str(est),
  };
}

/** Середній прибуток із замовлення (§12.2): факт — final; «≈ Прогноз» — final + preliminary; без витрат періоду. */
export function averageOrderProfit(j: RefJournal, o: ReportOptions): { fact: string | null; factOrders: number; forecast: string | null; forecastOrders: number } {
  const list = ordersOfPeriod(j, o);
  let f = 0n;
  let nf = 0;
  let p = 0n;
  let np = 0;
  for (const m of list) {
    const op = orderProfit(j, m.orderId, o.currency, o.ctx);
    if (m.state === "final") {
      f += op.entriesProfit;
      nf += 1;
    } else if (m.state === "preliminary") {
      p += op.entriesProfit + op.forecast;
      np += 1;
    }
  }
  return {
    fact: nf > 0 ? str(divRound(f, BigInt(nf))) : null,
    factOrders: nf,
    forecast: nf + np > 0 ? str(divRound(f + p, BigInt(nf + np))) : null,
    forecastOrders: nf + np,
  };
}

/** Порівняння (§12.1): Δ і Δ %; Δ % — «—», якщо база ≤ 0 або неповна; будь-яке значення null → null. */
export function compareValues(current: string | null, base: string | null, baseComplete = true): { delta: string | null; deltaPct: string | null } {
  if (current === null || base === null) return { delta: null, deltaPct: null };
  const c = cents(current);
  const b = cents(base);
  return { delta: str(c - b), deltaPct: baseComplete && b > 0n ? percent1(c - b, b) : null };
}

/** I13: Σ прибутку замовлень за станами + записи періоду = прибуток панелі (те саме правило повноти). */
export function profitByStates(j: RefJournal, o: ReportOptions): Record<Column, string> {
  const metas = metaMap(j);
  const conv = new Converter(o.currency, o.ctx);
  const acc: Record<Column, Cents> = { final: 0n, preliminary: 0n, incomplete: 0n, period: 0n };
  for (const e of j.entries) {
    if (!inP(e.recognizedOn, o) || !affectsProfit(e.category)) continue;
    const v = conv.of(e);
    if (v !== null) acc[columnOf(e, metas)] += v;
  }
  return { final: str(acc.final), preliminary: str(acc.preliminary), incomplete: str(acc.incomplete), period: str(acc.period) };
}

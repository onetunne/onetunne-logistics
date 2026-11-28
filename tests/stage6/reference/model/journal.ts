/**
 * Еталонна модель (WP12a): записи журналу, дати проведення, закриті місяці, сторно, ручні витрати з розподілом за
 * періодом послуги, сума періоду замість прогнозу, обмін валюти (§0 п. 1, F2, §3.3, §3.4, §10.1–§10.4, §2.7).
 */
import { allocate, cents, str, type Cents } from "./money";
import { REF_CATEGORIES, type RefCategory } from "./categories";
import { eachDay, instantMs, kyivDate, monthOf, monthsBetween } from "./dates";
import { convert, type ConvertContext } from "./fx";

/** Запис журналу — вхід агрегатора (сирі рядки finance_entries застосунку перетворюються саме сюди). */
export interface RefEntry {
  key: string;
  orderId: string | null;
  lineId?: string | null;
  productId?: string | null;
  category: RefCategory;
  /** Сума зі знаком впливу на прибуток (дохід «+», витрата «−»), у початковій валюті, «0.00»-формат. */
  amount: string;
  currency: string;
  recognizedOn: string;
  fxOn: string;
  originalOn: string;
  isLate: boolean;
  isLateCompletion: boolean;
  reversesKey: string | null;
  details?: Record<string, string | number | boolean | null>;
}

/** Закриття місяця: діє з closedAt до reopenedAt (якщо відкрито повторно). */
export interface RefMonthClosure {
  month: string;
  closedAt: string;
  reopenedAt?: string | null;
  /** Чек-лист: усі категорії витрат і податки підтверджено (§2.7). */
  allConfirmedWithTaxes: boolean;
}

export function isMonthClosedAt(closures: readonly RefMonthClosure[], month: string, at: string): boolean {
  const t = instantMs(at);
  return closures.some((c) => c.month === month && instantMs(c.closedAt) <= t && (!c.reopenedAt || instantMs(c.reopenedAt) > t));
}

/**
 * Дати проведення системного факту (§3.4): цільова дата в закритому (на момент проведення) місяці → recognized_on =
 * дата проведення (Київ), is_late; original_on = цільова дата; fx_on — справжня дата (не змінюється).
 */
export function postingDates(
  target: { recognizedOn: string; fxOn: string },
  postedAt: string,
  closures: readonly RefMonthClosure[],
): { recognizedOn: string; originalOn: string; fxOn: string; isLate: boolean } {
  if (isMonthClosedAt(closures, monthOf(target.recognizedOn), postedAt)) {
    return { recognizedOn: kyivDate(postedAt), originalOn: target.recognizedOn, fxOn: target.fxOn, isLate: true };
  }
  return { recognizedOn: target.recognizedOn, originalOn: target.recognizedOn, fxOn: target.fxOn, isLate: false };
}

/**
 * Сторно (F2): сума з протилежним знаком, ключ `<ключ>:rev`; recognized_on = recognized_on оригіналу, якщо його місяць
 * відкритий, інакше дата проведення з is_late; original_on і fx_on — ЗАВЖДИ з оригіналу (I14).
 */
export function reverseEntry(original: RefEntry, postedAt: string, closures: readonly RefMonthClosure[]): RefEntry {
  if (original.reversesKey !== null) throw new RangeError("reference: a reversal cannot be reversed");
  const closed = isMonthClosedAt(closures, monthOf(original.recognizedOn), postedAt);
  return {
    ...original,
    key: `${original.key}:rev`,
    amount: str(-cents(original.amount)),
    recognizedOn: closed ? kyivDate(postedAt) : original.recognizedOn,
    isLate: closed,
    isLateCompletion: false,
    originalOn: original.originalOn,
    fxOn: original.fxOn,
    reversesKey: original.key,
  };
}

/** Активні записи: без сторнованих оригіналів і без самих сторно (для перевірок «чинний стан»). */
export function activeEntries(entries: readonly RefEntry[]): RefEntry[] {
  const reversed = new Set(entries.filter((e) => e.reversesKey !== null).map((e) => e.reversesKey!));
  return entries.filter((e) => e.reversesKey === null && !reversed.has(e.key));
}

/** Ключі унікальні (F2: ON CONFLICT DO NOTHING — повтор не дає другого запису). */
export function assertUniqueKeys(entries: readonly RefEntry[]): void {
  const seen = new Set<string>();
  for (const e of entries) {
    if (seen.has(e.key)) throw new RangeError(`reference: duplicate key ${e.key}`);
    seen.add(e.key);
  }
}

/** Ідемпотентне додавання: запис з наявним ключем пропускається (F2). */
export function appendIdempotent(journal: RefEntry[], entries: readonly RefEntry[]): number {
  const keys = new Set(journal.map((e) => e.key));
  let inserted = 0;
  for (const e of entries) {
    if (keys.has(e.key)) continue;
    if (cents(e.amount) === 0n) throw new RangeError("reference: amount <> 0 (CHECK)");
    keys.add(e.key);
    journal.push(e);
    inserted += 1;
  }
  return inserted;
}

// ---------------------------------------------------------------------------------------------------------------
// Ручні витрати (§10.1–§10.2)
// ---------------------------------------------------------------------------------------------------------------

/** Щоденний розподіл суми за періодом послуги (§10.2): найбільші остачі, нічия — раніші дні; Σ = сума точно. */
export function allocateDaily(amount: Cents, from: string, to: string): Array<{ date: string; amount: Cents }> {
  const days = eachDay(from, to);
  if (days.length === 0 || days.length > 366) throw new RangeError("reference: service period must be 1..366 days");
  const parts = allocate(amount, days.map(() => 1n));
  return days.map((date, i) => ({ date, amount: parts[i]! }));
}

/** Версія ручної витрати (редагування = нова версія + сторно попередньої). */
export interface RefExpenseVersion {
  version: number;
  category: RefCategory;
  /** Сума витрати як вводить власник (додатна витрата; кредит — від'ємна); знак у журналі — за видом категорії. */
  amount: string;
  currency: string;
  date?: string;
  periodFrom?: string;
  periodTo?: string;
  orderId?: string | null;
  /** Момент збереження цієї версії. */
  enteredAt: string;
}

export interface RefExpense {
  id: string;
  versions: RefExpenseVersion[];
  voidedAt?: string | null;
  /**
   * «Списати невикористані витрати партії» (§6.7, §10.1): `inventory_loss` вводиться ЛИШЕ так — рядок витрат із
   * production_batch_id; записи несуть details.kind = production_cancelled, id і номер партії (R6 — дата власника).
   */
  productionBatchId?: string | null;
  batchNumber?: string | null;
}

export type ExpenseResult =
  | { ok: true; entries: RefEntry[] }
  | { ok: false; error: "monthClosed"; month: string }
  | { ok: false; error: "categoryNotAllowed"; category: RefCategory };

/** Знак у журналі: дохід (other_income, inventory_gain) — «+», витрата — «−»; fx_difference — як ввели. */
export function journalSignForExpense(category: RefCategory, amount: Cents): Cents {
  const kind = REF_CATEGORIES[category].kind;
  if (kind === "other_income" || category === "fx_difference") return amount;
  return -amount;
}

function expenseVersionEntries(e: RefExpense, v: RefExpenseVersion): RefEntry[] {
  const signed = journalSignForExpense(v.category, cents(v.amount));
  const details = e.productionBatchId ? { kind: "production_cancelled", productionBatchId: e.productionBatchId, batchNumber: e.batchNumber ?? null } : undefined;
  const base = (date: string, amount: Cents, key: string): RefEntry => ({
    key,
    orderId: v.orderId ?? null,
    category: v.category,
    amount: str(amount),
    currency: v.currency,
    recognizedOn: date,
    fxOn: date,
    originalOn: date,
    isLate: false,
    isLateCompletion: false,
    reversesKey: null,
    ...(details ? { details } : {}),
  });
  if (v.periodFrom && v.periodTo) {
    return allocateDaily(signed, v.periodFrom, v.periodTo)
      .filter((d) => d.amount !== 0n)
      .map((d) => base(d.date, d.amount, `exp:${e.id}:v${v.version}:${d.date}`));
  }
  if (!v.date) throw new RangeError("reference: expense needs a date or a service period");
  return [base(v.date, signed, `exp:${e.id}:v${v.version}`)];
}

function datesOfVersion(v: RefExpenseVersion): string[] {
  return v.periodFrom && v.periodTo ? monthsBetween(v.periodFrom, v.periodTo).map((m) => `${m}-01`) : [v.date!];
}

/**
 * Записи ручної витрати з історією версій (§10.1, R4): кожна нова версія сторнує записи попередньої (датою й курсом
 * оригіналу) і проводить свої; дата в закритому місяці (на момент збереження) — відмова (§3.4).
 */
export function postExpense(e: RefExpense, closures: readonly RefMonthClosure[]): ExpenseResult {
  const journal: RefEntry[] = [];
  let previous: RefEntry[] = [];
  const versions = [...e.versions].sort((a, b) => a.version - b.version);
  for (const v of versions) {
    // inventory_loss — лише через списання витрат партії (з production_batch_id), і такий рядок — лише inventory_loss.
    if ((v.category === "inventory_loss") !== Boolean(e.productionBatchId)) return { ok: false, error: "categoryNotAllowed", category: v.category };
  }
  for (const v of versions) {
    for (const d of datesOfVersion(v)) {
      if (isMonthClosedAt(closures, monthOf(d), v.enteredAt)) return { ok: false, error: "monthClosed", month: monthOf(d) };
    }
    for (const p of previous) {
      if (isMonthClosedAt(closures, monthOf(p.recognizedOn), v.enteredAt)) return { ok: false, error: "monthClosed", month: monthOf(p.recognizedOn) };
    }
    for (const p of previous) journal.push(reverseEntry(p, v.enteredAt, closures));
    previous = expenseVersionEntries(e, v);
    journal.push(...previous);
  }
  if (e.voidedAt) for (const p of previous) journal.push(reverseEntry(p, e.voidedAt, closures));
  return { ok: true, entries: journal };
}

/** «Списати невикористані витрати партії» (§6.7): скасована партія / закрита з недопоставкою → inventory_loss (R6). */
export interface RefBatchWriteOff {
  id: string;
  productionBatchId: string;
  batchNumber: string;
  amount: string;
  currency: string;
  date: string;
  enteredAt: string;
}

export function postBatchWriteOff(w: RefBatchWriteOff, closures: readonly RefMonthClosure[]): ExpenseResult {
  return postExpense(
    {
      id: w.id,
      productionBatchId: w.productionBatchId,
      batchNumber: w.batchNumber,
      versions: [{ version: 1, category: "inventory_loss", amount: w.amount, currency: w.currency, date: w.date, enteredAt: w.enteredAt }],
    },
    closures,
  );
}

/** Ручний запис з датою: дозволено, лише якщо місяць дати відкритий на момент введення (§3.4, G11). */
export function manualEntryAllowed(date: string, enteredAt: string, closures: readonly RefMonthClosure[]): boolean {
  return !isMonthClosedAt(closures, monthOf(date), enteredAt);
}

// ---------------------------------------------------------------------------------------------------------------
// Сума періоду замість прогнозу (§10.3) і обмін валюти (§10.4)
// ---------------------------------------------------------------------------------------------------------------

export interface PeriodSumTarget {
  orderId: string;
  /** Прогноз складника замовлення (додатна величина витрати) або null — немає прогнозу. */
  forecast: Cents | null;
  /** Чиста виручка — запасна вага, якщо всі прогнози 0. */
  revenue: Cents;
  /** Складник уже фактичний — частку не отримує. */
  alreadyActual?: boolean;
}

/**
 * Розподіл суми періоду на замовлення виміру пропорційно прогнозам (найбільші остачі; всі прогнози 0 — за виручкою);
 * немає відповідних замовлень → null (один запис періоду).
 */
export function allocatePeriodSum(amount: Cents, targets: readonly PeriodSumTarget[]): Array<{ orderId: string; amount: Cents }> | null {
  const eligible = targets.filter((t) => !t.alreadyActual);
  if (eligible.length === 0) return null;
  const fw = eligible.map((t) => (t.forecast !== null && t.forecast > 0n ? t.forecast : 0n));
  const weights = fw.some((w) => w > 0n) ? fw : eligible.map((t) => (t.revenue > 0n ? t.revenue : 0n));
  if (!weights.some((w) => w > 0n)) return null;
  const parts = allocate(amount, weights);
  return eligible.map((t, i) => ({ orderId: t.orderId, amount: parts[i]! }));
}

/** Запис обміну валюти (§5.7, §10.4): fx_difference у валюті отримання, датою обміну; без курсу — відмова (null). */
export function fxConversionEntry(
  c: { id: string; date: string; sold: { amount: string; currency: string }; received: { amount: string; currency: string } },
  ctx: ConvertContext,
): RefEntry | null {
  const expected = convert(cents(c.sold.amount), c.sold.currency, c.received.currency, c.date, ctx);
  if (expected === null) return null;
  const diff = cents(c.received.amount) - expected;
  if (diff === 0n) return null;
  return {
    key: `fxconv:${c.id}:v1`,
    orderId: null,
    category: "fx_difference",
    amount: str(diff),
    currency: c.received.currency,
    recognizedOn: c.date,
    fxOn: c.date,
    originalOn: c.date,
    isLate: false,
    isLateCompletion: false,
    reversesKey: null,
  };
}

/**
 * Назва підсумку (§2.7): «Чистий прибуток» лише якщо КОЖЕН місяць діапазону закритий на момент `at` і в його
 * чек-листі підтверджено всі категорії витрат і податки.
 */
export function profitLabel(from: string, to: string, closures: readonly RefMonthClosure[], at: string): "net_profit" | "profit_after_costs" {
  const months = monthsBetween(from, to);
  const t = instantMs(at);
  const active = (m: string) => closures.filter((c) => c.month === m && instantMs(c.closedAt) <= t && (!c.reopenedAt || instantMs(c.reopenedAt) > t));
  const ok = months.every((m) => {
    const a = active(m);
    return a.length > 0 && a.every((c) => c.allConfirmedWithTaxes);
  });
  return ok ? "net_profit" : "profit_after_costs";
}

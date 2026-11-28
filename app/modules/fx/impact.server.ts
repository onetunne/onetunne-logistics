/**
 * Етап 6, WP1: наслідки зміни курсу для журналу (docs/stage6-design.md §5.3, F6). Сума записів у початковій валюті
 * НІКОЛИ не змінюється; сконвертоване значення відкритого періоду йде за поточною версією курсу на `fx_on`. Тому кожна
 * зміна курсу (ручна версія, анулювання, новий рядок НБУ) пишеться в історію змін з кількістю зачеплених записів і Δ
 * прибутку у валюті звітності («Змінено курс EUR на 20.11: 14 записів, Δ прибутку +31,20 грн»).
 *
 * Правило: зачеплені дати — ті, на які вибір курсу (pickRate — те саме правило, що rateFor) до й після зміни дає
 * різний курс (дата зміни і дати, для яких вона була або стала запасною, ≤ fallbackDays уперед). Зачеплені записи —
 * записи цих дат курсу у валюті курсу (або, коли змінено курс самої валюти звітності, — у всіх інших валютах). Δ — лише
 * категорії прибутку (без довідкових memo); запис без курсу в одному зі станів у суму цього стану не входить (F4).
 *
 * Записи, які додала сама зміна курсу (перерахунок курсової різниці обмінів дати — сторно попередньої версії й нова
 * версія, `addedEntryIds`), входять у «після» за новими курсами й не входять у «до»; сторновані ними записи
 * (`reversedEntryIds`) теж зачеплені. Тобто Δ = Σ(записи після зміни, нові курси) − Σ(записи до зміни, старі курси)
 * для всього, що змінилося, у валюті звітності; кількість — різні id зачеплених, сторнованих і доданих записів.
 * Лише читання; без перевірки актора (викликають сервіси власника й завдання, які вже перевірили доступ). ВНУТРІШНІЙ
 * модуль: повертає Δ (гроші) без requireFinance — сторінки, маршрути, команди й ШІ його не імпортують (сканер).
 */
import { and, asc, eq, gte, inArray, lte, ne, notInArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financeEntries, fxRates } from "~/db/schema";
import { FINANCE_CATEGORY_DEFS, FX_QUOTE_CURRENCY, isFinanceCategory } from "~/domain/finance";
import { assertSupportedCurrency, convertMinor, fromMinor, toMinorForCurrency } from "~/lib/decimal";
import { addDays, eachDay } from "~/lib/periods";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import type { AppMode } from "~/server/types";
import { UAH_SCALED_RATE } from "./convert";
import { pickRate } from "./rate-for.server";

/** Рядок курсу в обсязі, потрібному для правила вибору (pickRate). */
export type RateRow = Pick<typeof fxRates.$inferSelect, "id" | "source" | "currency" | "effectiveDate" | "ratePerUnit" | "version" | "isCurrent">;

const RATE_COLUMNS = {
  id: fxRates.id,
  source: fxRates.source,
  currency: fxRates.currency,
  effectiveDate: fxRates.effectiveDate,
  ratePerUnit: fxRates.ratePerUnit,
  version: fxRates.version,
  isCurrent: fxRates.isCurrent,
};

/** Усі рядки курсів валют у [from, to] (усі джерела; придатність за режимом вирішує pickRate). */
export async function loadRateRows(db: DbOrTx, currencies: readonly string[], from: string, to: string): Promise<RateRow[]> {
  const list = [...new Set(currencies.filter((c) => c !== FX_QUOTE_CURRENCY))];
  if (list.length === 0) return [];
  return db
    .select(RATE_COLUMNS)
    .from(fxRates)
    .where(and(inArray(fxRates.currency, list), eq(fxRates.quoteCurrency, FX_QUOTE_CURRENCY), gte(fxRates.effectiveDate, from), lte(fxRates.effectiveDate, to)))
    .orderBy(asc(fxRates.effectiveDate));
}

/** P (× 10^10) валюти на дату за правилом вибору або null. */
export function scaledFrom(rows: readonly RateRow[], currency: string, date: string, mode: AppMode, fallbackDays: number): bigint | null {
  if (currency === FX_QUOTE_CURRENCY) return UAH_SCALED_RATE;
  const r = pickRate(rows, currency, date, mode, fallbackDays);
  return r.ok ? r.scaled : null;
}

export interface RateImpactInput {
  /** Валюта, курс якої змінився. */
  currency: string;
  /** Дати рядків, що змінилися (найменша й найбільша). */
  from: string;
  to: string;
  /** Рядки цієї валюти у [from − fallbackDays, to + fallbackDays] до й після зміни. */
  before: readonly RateRow[];
  after: readonly RateRow[];
  mode: AppMode;
  fallbackDays: number;
  reportingCurrency: string;
  storeId?: string;
  /** Записи, додані самою зміною курсу (сторно й нові версії курсової різниці обмінів дати). */
  addedEntryIds?: readonly string[];
  /** Записи, сторновані самою зміною курсу. */
  reversedEntryIds?: readonly string[];
}

export interface RateImpact {
  /** Скільки записів журналу змінюють сконвертоване значення. */
  affectedEntries: number;
  /** Δ прибутку у валюті звітності (десятковий рядок; "0.00" — зачеплених записів немає). */
  deltaReporting: string;
  reportingCurrency: string;
  /** Дати курсу, на які вибір курсу змінився. */
  changedDates: string[];
}

function sameRate(a: bigint | null, b: bigint | null): boolean {
  return a === b;
}

/** Наслідки зміни курсу (див. вгорі файла). */
export async function rateChangeImpact(db: DbOrTx, input: RateImpactInput): Promise<RateImpact> {
  const { currency: X, mode, fallbackDays: fb } = input;
  const R = input.reportingCurrency;
  const dR = assertSupportedCurrency(R);
  const candidates = eachDay({ from: input.from, to: addDays(input.to, fb) });
  const changedDates = candidates.filter((d) => !sameRate(scaledFrom(input.before, X, d, mode, fb), scaledFrom(input.after, X, d, mode, fb)));
  const added = [...new Set(input.addedEntryIds ?? [])];
  const none: RateImpact = { affectedEntries: 0, deltaReporting: fromMinor(0n), reportingCurrency: R, changedDates };
  if (changedDates.length === 0 && added.length === 0) return none;
  const storeId = input.storeId ?? DEFAULT_STORE_ID;
  const columns = { id: financeEntries.id, amount: financeEntries.amount, currency: financeEntries.currency, fxOn: financeEntries.fxOn, category: financeEntries.category };
  // Наявні до зміни записи, сконвертоване значення яких змінилося.
  const existing =
    changedDates.length === 0
      ? []
      : await db
          .select(columns)
          .from(financeEntries)
          .where(
            and(
              eq(financeEntries.storeId, storeId),
              inArray(financeEntries.fxOn, changedDates),
              X === R ? ne(financeEntries.currency, X) : eq(financeEntries.currency, X),
              ...(added.length > 0 ? [notInArray(financeEntries.id, added)] : []),
            ),
          );
  // Додані самою зміною (у «до» їх не було).
  const fresh = added.length === 0 ? [] : await db.select(columns).from(financeEntries).where(and(eq(financeEntries.storeId, storeId), inArray(financeEntries.id, added)));
  if (existing.length === 0 && fresh.length === 0) return none;
  // Курси інших валют (валюта звітності; валюти записів) зміна не зачепила.
  const others = new Set<string>([R, ...existing.map((e) => e.currency), ...fresh.map((e) => e.currency)]);
  others.delete(X);
  others.delete(FX_QUOTE_CURRENCY);
  const dates = [...changedDates, ...fresh.map((e) => e.fxOn)].sort();
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const otherRows = await loadRateRows(db, [...others], addDays(first, -fb), last);
  const lookup = (which: "before" | "after", c: string, d: string): bigint | null =>
    c === X ? scaledFrom(which === "before" ? input.before : input.after, c, d, mode, fb) : scaledFrom(otherRows, c, d, mode, fb);
  const convert = (which: "before" | "after", amount: string, c: string, d: string): bigint | null => {
    const a = toMinorForCurrency(amount, c);
    if (c === R) return a;
    const px = lookup(which, c, d);
    const py = lookup(which, R, d);
    return px === null || py === null ? null : convertMinor(a, px, py, dR);
  };
  const inProfit = (category: string) => isFinanceCategory(category) && FINANCE_CATEGORY_DEFS[category].kind !== "memo";
  let delta = 0n;
  for (const e of existing) {
    if (!inProfit(e.category)) continue;
    delta += (convert("after", e.amount, e.currency, e.fxOn) ?? 0n) - (convert("before", e.amount, e.currency, e.fxOn) ?? 0n);
  }
  for (const e of fresh) {
    if (!inProfit(e.category)) continue;
    delta += convert("after", e.amount, e.currency, e.fxOn) ?? 0n;
  }
  const touched = new Set<string>([...existing.map((e) => e.id), ...(input.reversedEntryIds ?? []), ...fresh.map((e) => e.id)]);
  return { affectedEntries: touched.size, deltaReporting: fromMinor(delta), reportingCurrency: R, changedDates };
}

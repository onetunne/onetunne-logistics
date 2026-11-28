/**
 * Етап 6: вибір курсу `rateFor(currency, date)` — ЄДИНЕ джерело курсів для фінансів (журнал, оцінка запасів, звіти,
 * експорт, бот, ШІ), docs/stage6-design.md §5.4:
 * 1. UAH → рівно 1.
 * 2. Поточний ручний рядок саме на цю дату (явний вибір власника має перевагу).
 * 3. Рядок автоматичного джерела на цю дату (nbu у робочому режимі, demo у демо).
 * 4. Запасний: останній ручний або автоматичний рядок у [дата − fallbackDays, дата) → позначка fallback («курс за 20.11»).
 * 5. Інакше — немає курсу (запис лишається в початковій валюті, не входить у конвертовані суми).
 * Курси на майбутні дати ніколи не припускаються (лише назад). Тарифи Checkout етапу 3 мають власну таблицю й сюди не
 * входять. SQL-двійник — sqlRateScaled (sql.ts), те саме правило.
 */
import { and, asc, eq, gte, inArray, lte, or } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { fxRates } from "~/db/schema";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { addDays, parseIsoDate } from "~/lib/periods";
import { RATE_SCALE_FACTOR, scaledRateFromDb, scaledRateToDecimal } from "~/lib/decimal";
import { getSetting } from "~/modules/settings/settings.server";
import type { AppMode } from "~/server/types";
import { automaticRateSources } from "./sql";

export interface RateForOptions {
  mode: AppMode;
  /** За замовчуванням — finance.fx.fallbackDays. */
  fallbackDays?: number;
}

export type RateSourceLabel = "base" | "nbu" | "manual" | "demo";

export interface RateFound {
  ok: true;
  currency: string;
  /** Запитана дата. */
  date: string;
  /** P = курс × 10^10 (гривень за 1 одиницю). */
  scaled: bigint;
  /** Курс за 1 одиницю, десятковий рядок («49.4942»). */
  ratePerUnit: string;
  /** Дата рядка курсу (≠ date — запасний). */
  rateDate: string;
  source: RateSourceLabel;
  fallback: boolean;
  /** Рядок fx_rates (null для UAH) і його версія — для експорту й знімків (rates_used). */
  rateId: string | null;
  version: number | null;
}

export interface RateMissing {
  ok: false;
  currency: string;
  date: string;
  reason: "no_rate";
}

export type RateForResult = RateFound | RateMissing;

type RateRow = Pick<typeof fxRates.$inferSelect, "id" | "source" | "currency" | "effectiveDate" | "ratePerUnit" | "version" | "isCurrent">;

const BASE: Omit<RateFound, "currency" | "date" | "rateDate"> = {
  ok: true,
  scaled: RATE_SCALE_FACTOR,
  ratePerUnit: "1",
  source: "base",
  fallback: false,
  rateId: null,
  version: null,
};

async function fallbackDaysOf(db: DbOrTx, opts: RateForOptions): Promise<number> {
  if (opts.fallbackDays !== undefined) return opts.fallbackDays;
  return (await getSetting(db, "finance")).fx.fallbackDays;
}

/** Вибір з рядків однієї валюти (чисте правило; спільне для rateFor і createRateResolver). */
export function pickRate(rows: readonly RateRow[], currency: string, date: string, mode: AppMode, fallbackDays: number): RateForResult {
  if (currency === FX_QUOTE_CURRENCY) return { ...BASE, currency, date, rateDate: date };
  const auto = new Set<string>(automaticRateSources(mode));
  const earliest = addDays(date, -fallbackDays);
  let best: RateRow | null = null;
  for (const r of rows) {
    if (r.currency !== currency) continue;
    if (r.effectiveDate > date || r.effectiveDate < earliest) continue;
    const eligible = (r.source === "manual" && r.isCurrent) || auto.has(r.source);
    if (!eligible) continue;
    if (
      !best ||
      r.effectiveDate > best.effectiveDate ||
      (r.effectiveDate === best.effectiveDate && r.source === "manual" && best.source !== "manual")
    ) {
      best = r;
    }
  }
  if (!best) return { ok: false, currency, date, reason: "no_rate" };
  const scaled = scaledRateFromDb(best.ratePerUnit);
  return {
    ok: true,
    currency,
    date,
    scaled,
    ratePerUnit: scaledRateToDecimal(scaled),
    rateDate: best.effectiveDate,
    source: best.source as RateSourceLabel,
    fallback: best.effectiveDate !== date,
    rateId: best.id,
    version: best.version,
  };
}

const RATE_COLUMNS = {
  id: fxRates.id,
  source: fxRates.source,
  currency: fxRates.currency,
  effectiveDate: fxRates.effectiveDate,
  ratePerUnit: fxRates.ratePerUnit,
  version: fxRates.version,
  isCurrent: fxRates.isCurrent,
};

function eligibleWhere(currencies: readonly string[], from: string, to: string, mode: AppMode) {
  return and(
    inArray(fxRates.currency, [...currencies]),
    eq(fxRates.quoteCurrency, FX_QUOTE_CURRENCY),
    gte(fxRates.effectiveDate, from),
    lte(fxRates.effectiveDate, to),
    or(and(eq(fxRates.source, "manual"), eq(fxRates.isCurrent, true)), inArray(fxRates.source, [...automaticRateSources(mode)])),
  );
}

/** Курс валюти на дату (див. правило вгорі файла). */
export async function rateFor(db: DbOrTx, currency: string, date: string, opts: RateForOptions): Promise<RateForResult> {
  if (currency === FX_QUOTE_CURRENCY) return { ...BASE, currency, date, rateDate: date };
  const fallbackDays = await fallbackDaysOf(db, opts);
  const rows = await db
    .select(RATE_COLUMNS)
    .from(fxRates)
    .where(eligibleWhere([currency], addDays(date, -fallbackDays), date, opts.mode))
    .orderBy(asc(fxRates.effectiveDate));
  return pickRate(rows, currency, date, opts.mode, fallbackDays);
}

/** Синхронний пошук курсів, завантажених одним запитом (для звітів/агрегатів у TS). */
export interface RateResolver {
  /**
   * Курс на дату курсу запису. Валюта поза `currencies` або дата поза [from, to] вікна → RangeError (помилка
   * викликача: відповідь «немає курсу» була б хибною — запис мовчки випав би з конвертованих сум).
   */
  rateFor(currency: string, date: string): RateForResult;
  /** P або null («немає курсу») — для sumConverted (convert.ts). Ті самі межі, що rateFor. */
  scaled(currency: string, date: string): bigint | null;
  /** Використані рядки fx_rates (для rates_used знімків і стовпців курсів експорту). */
  used(): RateFound[];
}

/** Вікно курсів: валюти й межі ДАТ КУРСУ записів (`fx_on`), не межі звіту. */
export interface RateWindow {
  currencies: readonly string[];
  /** Найменша fx_on (YYYY-MM-DD). */
  from: string;
  /** Найбільша fx_on (YYYY-MM-DD). */
  to: string;
}

/**
 * Вікно для набору записів: усі їхні валюти + цільові (валюти показу) і min/max `fx_on`. Пізні записи й сторно мають
 * fx_on раніше за період звіту (§3.4, F2) — тому вікно береться з записів, не з періоду. Порожній набір → null.
 */
export function rateWindowOf(entries: ReadonlyArray<{ currency: string; fxOn: string }>, targets: readonly string[] = []): RateWindow | null {
  if (entries.length === 0) return null;
  let from = entries[0]!.fxOn;
  let to = from;
  const currencies = new Set<string>(targets);
  for (const e of entries) {
    currencies.add(e.currency);
    if (e.fxOn < from) from = e.fxOn;
    if (e.fxOn > to) to = e.fxOn;
  }
  return { currencies: [...currencies].sort(), from, to };
}

/**
 * Завантажує всі придатні рядки валют для дат курсу [from, to] (з запасним вікном) одним запитом; далі — те саме
 * правило, що rateFor, без звернень до БД. `from`/`to` — межі `fx_on` записів (rateWindowOf), а не періоду звіту.
 */
export async function createRateResolver(db: DbOrTx, input: RateWindow, opts: RateForOptions): Promise<RateResolver> {
  if (!parseIsoDate(input.from) || !parseIsoDate(input.to) || input.from > input.to) {
    throw new RangeError(`invalid rate window ${input.from}..${input.to}`);
  }
  const fallbackDays = await fallbackDaysOf(db, opts);
  const currencies = [...new Set(input.currencies.filter((c) => c !== FX_QUOTE_CURRENCY))];
  const loaded = new Set(currencies);
  const rows = currencies.length
    ? await db
        .select(RATE_COLUMNS)
        .from(fxRates)
        .where(eligibleWhere(currencies, addDays(input.from, -fallbackDays), input.to, opts.mode))
        .orderBy(asc(fxRates.effectiveDate))
    : [];
  const byCurrency = new Map<string, RateRow[]>();
  for (const r of rows) byCurrency.set(r.currency, [...(byCurrency.get(r.currency) ?? []), r]);
  const cache = new Map<string, RateForResult>();
  const usedRows = new Map<string, RateFound>();
  const resolve = (currency: string, date: string): RateForResult => {
    if (currency !== FX_QUOTE_CURRENCY) {
      if (!loaded.has(currency)) throw new RangeError(`rate resolver: currency ${currency} was not loaded`);
      if (date < input.from || date > input.to) {
        throw new RangeError(`rate resolver: date ${date} is outside the loaded fx_on window ${input.from}..${input.to}`);
      }
    }
    const key = `${currency}|${date}`;
    let r = cache.get(key);
    if (!r) {
      r = pickRate(byCurrency.get(currency) ?? [], currency, date, opts.mode, fallbackDays);
      cache.set(key, r);
    }
    if (r.ok && r.rateId) usedRows.set(r.rateId, r);
    return r;
  };
  return {
    rateFor: resolve,
    scaled: (currency, date) => {
      const r = resolve(currency, date);
      return r.ok ? r.scaled : null;
    },
    used: () => [...usedRows.values()],
  };
}

/**
 * Етап 6, WP1: читання для сторінки «Фінанси → Курси» (docs/stage6-design.md §18.2). Кожна функція — requireFinance
 * (finance.view + роль owner). Вибір курсу — те саме правило, що rateFor (pickRate, §5.4): ручний на дату → автоматичний
 * на дату (НБУ у робочому режимі, демо — у демо) → запасний ≤ fallbackDays днів назад із позначкою → «Без курсу».
 */
import { and, count, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { fxRates, jobs } from "~/db/schema";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { DomainError } from "~/lib/errors";
import { addDays, eachDay, isoWeekday, parseIsoDate } from "~/lib/periods";
import { requireFinance } from "~/modules/finance/core/access.server";
import { listFinanceChanges } from "~/modules/finance/core/change-log.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { ensureFinanceState } from "~/modules/finance/core/store.server";
import { FINANCE_JOB } from "~/modules/finance/jobs";
import { getSetting } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import { loadRateRows } from "./impact.server";
import { pickRate, type RateSourceLabel } from "./rate-for.server";
import { automaticRateSources } from "./sql";

type ViewCtx = Pick<ServiceContext, "db" | "actor" | "mode">;

/** Найдовший період таблиці курсів на сторінці. */
export const RATE_MATRIX_MAX_DAYS = 62;

export interface RateCell {
  /** Курс, що діє на дату (правило rateFor); null — «Без курсу». */
  effective: {
    ratePerUnit: string;
    source: RateSourceLabel;
    rateDate: string;
    fallback: boolean;
    version: number | null;
  } | null;
  /** Рядок автоматичного джерела саме на цю дату (як опубліковано: курс за units одиниць). */
  automatic: { rate: string; units: number; ratePerUnit: string; setOn: string | null } | null;
  /** Поточний ручний рядок на цю дату. */
  manual: { rate: string; units: number; ratePerUnit: string; version: number } | null;
}

export interface RateMatrix {
  from: string;
  to: string;
  currencies: string[];
  /** Дати від новіших до старіших. */
  rows: Array<{ date: string; weekend: boolean; cells: Record<string, RateCell> }>;
  fallbackDays: number;
  automaticSource: "nbu" | "demo";
}

/** Таблиця курсів за датами й валютами. */
export async function listRateMatrix(ctx: ViewCtx, input: { from: string; to: string; currencies: readonly string[] }): Promise<RateMatrix> {
  requireFinance(ctx, "view");
  const from = parseIsoDate(input.from);
  const to = parseIsoDate(input.to);
  if (!from || !to || from > to) throw new DomainError("financeFx.error.periodInvalid", 400);
  const days = eachDay({ from, to });
  if (days.length > RATE_MATRIX_MAX_DAYS) throw new DomainError("financeFx.error.periodTooLong", 400, { days: RATE_MATRIX_MAX_DAYS });
  const currencies = [...new Set(input.currencies.filter((c) => /^[A-Z]{3}$/.test(c) && c !== FX_QUOTE_CURRENCY))];
  const settings = await loadFinanceSettings(ctx.db);
  const fb = settings.fx.fallbackDays;
  const all = await loadRateRows(ctx.db, currencies, addDays(from, -fb), to);
  const auto = automaticRateSources(ctx.mode)[0]!;
  // Опубліковані значення (rate, units, set_on) рядків на дати періоду.
  const details = currencies.length
    ? await ctx.db
        .select({
          id: fxRates.id,
          source: fxRates.source,
          currency: fxRates.currency,
          effectiveDate: fxRates.effectiveDate,
          rate: fxRates.rate,
          units: fxRates.units,
          ratePerUnit: fxRates.ratePerUnit,
          setOn: fxRates.setOn,
          version: fxRates.version,
          isCurrent: fxRates.isCurrent,
        })
        .from(fxRates)
        .where(
          and(
            inArray(fxRates.currency, currencies),
            eq(fxRates.quoteCurrency, FX_QUOTE_CURRENCY),
            gte(fxRates.effectiveDate, from),
            lte(fxRates.effectiveDate, to),
            or(eq(fxRates.source, auto), and(eq(fxRates.source, "manual"), eq(fxRates.isCurrent, true))),
          ),
        )
    : [];
  const byKey = new Map<string, (typeof details)[number][]>();
  for (const d of details) byKey.set(`${d.currency}|${d.effectiveDate}`, [...(byKey.get(`${d.currency}|${d.effectiveDate}`) ?? []), d]);
  const rows = [...days].reverse().map((date) => {
    const cells: Record<string, RateCell> = {};
    for (const c of currencies) {
      const r = pickRate(all, c, date, ctx.mode, fb);
      const here = byKey.get(`${c}|${date}`) ?? [];
      const a = here.find((x) => x.source === auto);
      const m = here.find((x) => x.source === "manual");
      cells[c] = {
        effective: r.ok ? { ratePerUnit: r.ratePerUnit, source: r.source, rateDate: r.rateDate, fallback: r.fallback, version: r.source === "manual" ? r.version : null } : null,
        automatic: a ? { rate: a.rate, units: a.units, ratePerUnit: a.ratePerUnit, setOn: a.setOn } : null,
        manual: m ? { rate: m.rate, units: m.units, ratePerUnit: m.ratePerUnit, version: m.version } : null,
      };
    }
    return { date, weekend: isoWeekday(date) >= 6, cells };
  });
  return { from, to, currencies, rows, fallbackDays: fb, automaticSource: auto };
}

/** Валюти, для яких є курси (ручні або автоматичного джерела режиму), за абеткою. */
export async function listRateCurrencies(ctx: ViewCtx): Promise<string[]> {
  requireFinance(ctx, "view");
  const auto = automaticRateSources(ctx.mode);
  const rows = await ctx.db
    .selectDistinct({ currency: fxRates.currency })
    .from(fxRates)
    .where(or(inArray(fxRates.source, [...auto]), eq(fxRates.source, "manual")));
  return rows.map((r) => r.currency).sort();
}

export interface ManualRateVersion {
  id: string;
  currency: string;
  effectiveDate: string;
  rate: string;
  units: number;
  ratePerUnit: string;
  version: number;
  isCurrent: boolean;
  /** Причина (маскована при збереженні). */
  reason: string | null;
  createdAt: string;
  /** З історії змін: скільки записів зачепила ця версія і Δ прибутку (null — історії немає, напр. демо-заповнення). */
  affectedEntries: number | null;
  deltaReporting: string | null;
  reportingCurrency: string | null;
}

/** Ручні курси з усіма версіями (новіші дати й версії першими). */
export async function listManualRateVersions(ctx: ViewCtx, filter: { currency?: string; limit?: number } = {}): Promise<ManualRateVersion[]> {
  requireFinance(ctx, "view");
  const conds = [eq(fxRates.source, "manual")];
  if (filter.currency && /^[A-Z]{3}$/.test(filter.currency)) conds.push(eq(fxRates.currency, filter.currency));
  const rows = await ctx.db
    .select()
    .from(fxRates)
    .where(and(...conds))
    .orderBy(desc(fxRates.effectiveDate), fxRates.currency, desc(fxRates.version))
    .limit(Math.min(Math.max(filter.limit ?? 50, 1), 500));
  const changes = rows.length ? await listFinanceChanges(ctx, { entityType: "fx_rate", limit: 1000 }) : [];
  const impact = new Map<string, { affectedEntries: number | null; deltaReporting: string | null; reportingCurrency: string | null }>();
  for (const ch of changes) {
    const after = (ch.after ?? null) as Record<string, unknown> | null;
    if (!after || after.source !== "manual" || ch.action === "void") continue;
    const key = `${ch.entityId}|${String(after.rateVersion)}`;
    if (impact.has(key)) continue;
    impact.set(key, {
      affectedEntries: typeof after.affectedEntries === "number" ? after.affectedEntries : null,
      deltaReporting: typeof after.deltaReporting === "string" ? after.deltaReporting : null,
      reportingCurrency: typeof after.reportingCurrency === "string" ? after.reportingCurrency : null,
    });
  }
  return rows.map((r) => {
    const i = impact.get(`${r.currency}:${r.effectiveDate}|${r.version}`);
    return {
      id: r.id,
      currency: r.currency,
      effectiveDate: r.effectiveDate,
      rate: r.rate,
      units: r.units,
      ratePerUnit: r.ratePerUnit,
      version: r.version,
      isCurrent: r.isCurrent,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
      affectedEntries: i?.affectedEntries ?? null,
      deltaReporting: i?.deltaReporting ?? null,
      reportingCurrency: i?.reportingCurrency ?? null,
    };
  });
}

export interface NbuState {
  /** НБУ доступний лише в робочому режимі (у демо — демо-курси). */
  available: boolean;
  enabled: boolean;
  autoFetch: boolean;
  fallbackDays: number;
  lastFetchedAt: string | null;
  /** «ok» | «empty» | «error:<код>» | null. */
  lastStatus: string | null;
  /** Завдань НБУ в черзі / у роботі. */
  pendingJobs: number;
  /** Найновіша дата рядка НБУ (null — рядків немає). */
  latestNbuDate: string | null;
}

/** Стан отримання курсів НБУ (вимикач, останнє отримання, черга). */
export async function getNbuState(ctx: ViewCtx): Promise<NbuState> {
  requireFinance(ctx, "view");
  const settings = await loadFinanceSettings(ctx.db);
  const state = await ensureFinanceState(ctx.db);
  const [pending] = await ctx.db
    .select({ c: count() })
    .from(jobs)
    .where(and(inArray(jobs.type, [FINANCE_JOB.fxFetch, FINANCE_JOB.fxBackfill]), inArray(jobs.status, ["queued", "running"])));
  const [latest] = await ctx.db
    .select({ d: sql<string | null>`max(${fxRates.effectiveDate})` })
    .from(fxRates)
    .where(eq(fxRates.source, "nbu"));
  return {
    available: ctx.mode === "production",
    enabled: settings.fx.nbuEnabled,
    autoFetch: settings.fx.autoFetch,
    fallbackDays: settings.fx.fallbackDays,
    lastFetchedAt: state.fxFetchedAt ? state.fxFetchedAt.toISOString() : null,
    lastStatus: state.fxFetchStatus ?? null,
    pendingJobs: Number(pending?.c ?? 0),
    latestNbuDate: latest?.d ?? null,
  };
}

export interface CheckoutRatesView {
  /** Валюта тарифу перевізника (база таблиці). */
  baseCurrency: string;
  enabled: boolean;
  rates: Array<{ currency: string; rate: string }>;
}

/** Курси для тарифів Checkout етапу 3 (не фінансові, лише читання; змінюються в «Налаштуваннях»). */
export async function getCheckoutRatesView(ctx: ViewCtx): Promise<CheckoutRatesView> {
  requireFinance(ctx, "view");
  const [checkout, novaPost] = await Promise.all([getSetting(ctx.db, "checkoutRates"), getSetting(ctx.db, "novaPost")]);
  return { baseCurrency: novaPost.tariffCurrency, enabled: checkout.enabled, rates: checkout.fxRates.map((r) => ({ currency: r.currency, rate: r.rate })) };
}

/**
 * Етап 6, WP1: ручні курси з версіями (docs/stage6-design.md §5.3, §3.4, F6). Сервіси власника: finance.manage + роль
 * owner (requireFinance) у КОЖНІЙ функції.
 *
 * - Нова версія робить попередню `is_current = false` (унікальні: версія на дату; один поточний на дату). Той самий курс,
 *   що поточний, — повтор (нічого не змінюється; захищає від подвійного натискання): перевіряється ДО порівняння версій,
 *   тож друге однакове надсилання форми (з тією самою очікуваною версією) — «без змін», а не хибний конфлікт. Так само
 *   повторне анулювання версії, яку власник бачив і яку вже анульовано (новішої немає), — «без змін».
 * - Причина обов'язкова, якщо на дату є рядок автоматичного джерела (НБУ у робочому режимі, демо — у демо) або це
 *   виправлення (уже були ручні версії на цю дату); також — для анулювання.
 * - Дата в закритому місяці — відмова (finance.error.monthClosed, під спільним блокуванням місяця).
 * - Кожна зміна → finance_change_log (fx_rate) з кількістю зачеплених записів і Δ прибутку у валюті звітності (у тій
 *   самій транзакції), audit_log — лише id і кількості. Δ і кількість ураховують і перерахунок курсової різниці обмінів
 *   цієї дати (repriceConversions: сторно попередніх і нові записи), який виконується ДО підрахунку.
 * - Після збереження — завершення шарів оцінки складу, що чекали курсу (completeFxPendingLayers, WP2), усе в тій самій
 *   транзакції.
 * - Блокування курсу дати (rate-lock.server.ts) — до блокування місяця; обмін валюти бере те саме блокування.
 * - CAS: expectedVersion — версія поточного ручного рядка, яку бачив власник (0 — немає) → інакше ConflictError.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { fxRates } from "~/db/schema";
import { FX_QUOTE_CURRENCY } from "~/domain/finance";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { addDays, businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { completeFxPendingLayers } from "~/modules/costing/fx-pending.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import { conversionsNeedingRate, repriceConversions } from "./conversions-internal.server";
import { loadRateRows, rateChangeImpact, type RateImpact } from "./impact.server";
import { pickRate } from "./rate-for.server";
import { lockRateDates } from "./rate-lock.server";
import { parseRateCurrency, parseRateInput } from "./rate-input";
import { automaticRateSources } from "./sql";

/** Ручний курс можна задати не далі, ніж на стільки днів уперед (як публікує НБУ — до наступного робочого дня). */
export const MANUAL_RATE_MAX_DAYS_AHEAD = 7;
export const MANUAL_RATE_REASON_MAX = 300;

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;

export interface SaveManualRateInput {
  currency: string;
  effectiveDate: string;
  /** Курс з форми («49,4942») за `units` одиниць валюти. */
  rate: string;
  units?: number | string;
  reason?: string | null;
  /** Версія поточного ручного рядка, яку бачив власник (0 — ручного курсу на дату не було). */
  expectedVersion?: number | null;
}

export interface RateChangeSummary {
  currency: string;
  effectiveDate: string;
  /** Нова версія (для анулювання — анульована). */
  version: number;
  affectedEntries: number;
  /** Δ прибутку у валюті звітності. */
  deltaReporting: string;
  reportingCurrency: string;
  /** Завершено шарів оцінки складу, що чекали курсу. */
  completedLayers: number;
  /** Обмінів валюти з перерахованою курсовою різницею. */
  repricedConversions: number;
}

export type SaveManualRateResult = ({ duplicate: true } | { duplicate: false; id: string }) & RateChangeSummary;

/** duplicate — версію, яку бачив власник, уже анульовано (повторне надсилання форми): нічого не змінено. */
export type VoidManualRateResult = RateChangeSummary & { duplicate: boolean };

function validDate(value: string, today: string): string {
  const d = parseIsoDate(value);
  if (!d) throw new DomainError("financeFx.error.dateInvalid", 400);
  if (d > addDays(today, MANUAL_RATE_MAX_DAYS_AHEAD)) throw new DomainError("financeFx.error.dateTooFar", 400, { days: MANUAL_RATE_MAX_DAYS_AHEAD });
  return d;
}

function currencyOrThrow(input: string): string {
  const c = parseRateCurrency(input);
  if (!c.ok) throw new DomainError(c.error, 400, { currency: input.trim().toUpperCase().slice(0, 3) });
  return c.currency;
}

async function manualRows(tx: Tx, currency: string, date: string) {
  return tx
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.source, "manual"), eq(fxRates.currency, currency), eq(fxRates.quoteCurrency, FX_QUOTE_CURRENCY), eq(fxRates.effectiveDate, date)))
    .orderBy(desc(fxRates.version))
    .for("update");
}

async function hasAutomaticRow(tx: Tx, currency: string, date: string, ctx: Ctx): Promise<boolean> {
  const [row] = await tx
    .select({ id: fxRates.id })
    .from(fxRates)
    .where(
      and(
        inArray(fxRates.source, [...automaticRateSources(ctx.mode)]),
        eq(fxRates.currency, currency),
        eq(fxRates.quoteCurrency, FX_QUOTE_CURRENCY),
        eq(fxRates.effectiveDate, date),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** Курс, що діє на дату (для before / after історії змін). */
function effectiveRate(rows: Awaited<ReturnType<typeof loadRateRows>>, currency: string, date: string, ctx: Ctx, fallbackDays: number) {
  const r = pickRate(rows, currency, date, ctx.mode, fallbackDays);
  return r.ok
    ? { currency, quoteCurrency: FX_QUOTE_CURRENCY, effectiveDate: r.rateDate, ratePerUnit: r.ratePerUnit, source: r.source, ...(r.version ? { rateVersion: r.version } : {}) }
    : { currency, quoteCurrency: FX_QUOTE_CURRENCY, effectiveDate: date, source: "none" };
}

async function afterChange(
  tx: Tx,
  ctx: Ctx,
  input: { currency: string; date: string; before: Awaited<ReturnType<typeof loadRateRows>>; fallbackDays: number; reportingCurrency: string },
): Promise<{ impact: RateImpact; repriced: number }> {
  const after = await loadRateRows(tx, [input.currency], addDays(input.date, -input.fallbackDays), addDays(input.date, input.fallbackDays));
  // Спершу перерахунок обмінів дати: його сторно й нові записи входять у Δ і кількість зачеплених записів.
  const reprice = await repriceConversions(tx, ctx.actor, { currency: input.currency, date: input.date, mode: ctx.mode });
  const impact = await rateChangeImpact(tx, {
    currency: input.currency,
    from: input.date,
    to: input.date,
    before: input.before,
    after,
    mode: ctx.mode,
    fallbackDays: input.fallbackDays,
    reportingCurrency: input.reportingCurrency,
    addedEntryIds: reprice.postedEntryIds,
    reversedEntryIds: reprice.reversedEntryIds,
  });
  return { impact, repriced: reprice.repriced };
}

/** Зберігає ручний курс (нова версія). */
export async function saveManualRate(ctx: Ctx, input: SaveManualRateInput): Promise<SaveManualRateResult> {
  requireFinance(ctx, "manage");
  const today = businessDate(ctx.now());
  const currency = currencyOrThrow(input.currency);
  const date = validDate(input.effectiveDate, today);
  const parsed = parseRateInput(input.rate, input.units ?? 1);
  if (!parsed.ok) throw new DomainError(parsed.error, 400);
  const reason = maskFreeTextNote(input.reason, MANUAL_RATE_REASON_MAX);
  const settings = await loadFinanceSettings(ctx.db);
  const fb = settings.fx.fallbackDays;
  return ctx.db.transaction(async (tx) => {
    await lockRateDates(tx, [currency], date);
    await assertMonthOpen(tx, date);
    const existing = await manualRows(tx, currency, date);
    const current = existing.find((r) => r.isCurrent) ?? null;
    const base = { currency, effectiveDate: date, reportingCurrency: settings.reportingCurrency, completedLayers: 0, repricedConversions: 0 };
    // Повтор — до порівняння версій: друге однакове надсилання (та сама очікувана версія) нічого не змінює.
    if (current && current.units === parsed.units && sameDecimal(current.rate, parsed.rate)) {
      return { duplicate: true, ...base, version: current.version, affectedEntries: 0, deltaReporting: "0.00" };
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== (current?.version ?? 0)) {
      throw new ConflictError();
    }
    const maxVersion = existing.reduce((m, r) => Math.max(m, r.version), 0);
    if (!reason && (maxVersion > 0 || (await hasAutomaticRow(tx, currency, date, ctx)))) {
      throw new DomainError("financeFx.error.reasonRequired", 400);
    }
    const before = await loadRateRows(tx, [currency], addDays(date, -fb), addDays(date, fb));
    if (current) {
      const [off] = await tx
        .update(fxRates)
        .set({ isCurrent: false })
        .where(and(eq(fxRates.id, current.id), eq(fxRates.isCurrent, true)))
        .returning({ id: fxRates.id });
      if (!off) throw new ConflictError();
    }
    const version = maxVersion + 1;
    const [row] = await tx
      .insert(fxRates)
      .values({
        source: "manual",
        currency,
        quoteCurrency: FX_QUOTE_CURRENCY,
        effectiveDate: date,
        rate: parsed.rate,
        units: parsed.units,
        ratePerUnit: parsed.ratePerUnit,
        version,
        isCurrent: true,
        enteredBy: ctx.actor.id,
        reason,
      })
      .returning({ id: fxRates.id });
    const { impact, repriced } = await afterChange(tx, ctx, { currency, date, before, fallbackDays: fb, reportingCurrency: settings.reportingCurrency });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "fx_rate",
      entityId: `${currency}:${date}`,
      action: maxVersion > 0 ? "update" : "create",
      before: effectiveRate(before, currency, date, ctx, fb),
      after: {
        currency,
        quoteCurrency: FX_QUOTE_CURRENCY,
        effectiveDate: date,
        rate: parsed.rate,
        units: parsed.units,
        ratePerUnit: parsed.ratePerUnit,
        source: "manual",
        rateVersion: version,
        affectedEntries: impact.affectedEntries,
        deltaReporting: impact.deltaReporting,
        reportingCurrency: impact.reportingCurrency,
      },
      reason,
    });
    const { completed } = await completeFxPendingLayers(tx, ctx.actor, { currency });
    await writeAudit(tx, ctx.actor, "finance.fx_rate_saved", { type: "fx_rate", id: row!.id }, { version, affectedEntries: impact.affectedEntries, completed });
    return {
      duplicate: false,
      id: row!.id,
      ...base,
      version,
      affectedEntries: impact.affectedEntries,
      deltaReporting: impact.deltaReporting,
      completedLayers: completed,
      repricedConversions: repriced,
    };
  });
}

function sameDecimal(a: string, b: string): boolean {
  const norm = (v: string) => {
    const [i = "0", f = ""] = v.split(".");
    return `${i.replace(/^0+(?=\d)/, "")}.${f.replace(/0+$/, "")}`;
  };
  return norm(a) === norm(b);
}

export interface VoidManualRateInput {
  currency: string;
  effectiveDate: string;
  reason: string;
  /** Версія поточного ручного рядка, яку бачив власник. */
  expectedVersion?: number | null;
}

/**
 * Анулює поточний ручний курс дати (рядок лишається в історії, `is_current = false`): далі діє автоматичний курс дати
 * або запасний. Якщо курс потрібен обміну валюти цієї дати, а точного курсу після анулювання не буде — відмова.
 */
export async function voidManualRate(ctx: Ctx, input: VoidManualRateInput): Promise<VoidManualRateResult> {
  requireFinance(ctx, "manage");
  const currency = currencyOrThrow(input.currency);
  const date = parseIsoDate(input.effectiveDate);
  if (!date) throw new DomainError("financeFx.error.dateInvalid", 400);
  const reason = maskFreeTextNote(input.reason, MANUAL_RATE_REASON_MAX);
  if (!reason) throw new DomainError("financeFx.error.reasonRequired", 400);
  const settings = await loadFinanceSettings(ctx.db);
  const fb = settings.fx.fallbackDays;
  return ctx.db.transaction(async (tx) => {
    await lockRateDates(tx, [currency], date);
    await assertMonthOpen(tx, date);
    const existing = await manualRows(tx, currency, date);
    const current = existing.find((r) => r.isCurrent);
    if (!current) {
      // Повторне надсилання форми анулювання: версію, яку бачив власник, уже анульовано, новішої немає → без змін.
      const latest = existing[0];
      if (latest && input.expectedVersion !== undefined && input.expectedVersion !== null && latest.version === input.expectedVersion) {
        return {
          duplicate: true,
          currency,
          effectiveDate: date,
          version: latest.version,
          affectedEntries: 0,
          deltaReporting: "0.00",
          reportingCurrency: settings.reportingCurrency,
          completedLayers: 0,
          repricedConversions: 0,
        };
      }
      throw new NotFoundError("fx_rate");
    }
    if (input.expectedVersion !== undefined && input.expectedVersion !== null && input.expectedVersion !== current.version) throw new ConflictError();
    const before = await loadRateRows(tx, [currency], addDays(date, -fb), addDays(date, fb));
    const [off] = await tx
      .update(fxRates)
      .set({ isCurrent: false })
      .where(and(eq(fxRates.id, current.id), eq(fxRates.isCurrent, true)))
      .returning({ id: fxRates.id });
    if (!off) throw new ConflictError();
    if ((await conversionsNeedingRate(tx, { currency, date, mode: ctx.mode })) > 0) {
      throw new DomainError("financeFx.error.rateUsedByConversion", 409, { currency, date });
    }
    const { impact, repriced } = await afterChange(tx, ctx, { currency, date, before, fallbackDays: fb, reportingCurrency: settings.reportingCurrency });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "fx_rate",
      entityId: `${currency}:${date}`,
      action: "void",
      before: {
        currency,
        quoteCurrency: FX_QUOTE_CURRENCY,
        effectiveDate: date,
        rate: current.rate,
        units: current.units,
        ratePerUnit: current.ratePerUnit,
        source: "manual",
        rateVersion: current.version,
      },
      after: {
        ...effectiveRate(await loadRateRows(tx, [currency], addDays(date, -fb), date), currency, date, ctx, fb),
        affectedEntries: impact.affectedEntries,
        deltaReporting: impact.deltaReporting,
        reportingCurrency: impact.reportingCurrency,
      },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.fx_rate_voided", { type: "fx_rate", id: current.id }, { version: current.version, affectedEntries: impact.affectedEntries });
    return {
      duplicate: false,
      currency,
      effectiveDate: date,
      version: current.version,
      affectedEntries: impact.affectedEntries,
      deltaReporting: impact.deltaReporting,
      reportingCurrency: impact.reportingCurrency,
      completedLayers: 0,
      repricedConversions: repriced,
    };
  });
}


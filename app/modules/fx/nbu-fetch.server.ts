/**
 * Етап 6, WP1: отримання курсів НБУ (docs/stage6-design.md §5.6) — логіка завдань і кнопок власника.
 *
 * ОДИН вимикач `finance.fx.nbuEnabled` (власник, з історією змін; типово вимкнено, D-4) керує КОЖНИМ запитом до НБУ: за
 * розкладом, кнопкою «Оновити курси НБУ зараз» і довантаженням історії. Поки він вимкнений, кнопки відмовляють
 * (finance.error.nbuDisabled), завдання НБУ не ставляться, а вже поставлені — не виконують запиту (обробник ще раз
 * перевіряє вимикач перед мережею; I18). `fx.autoFetch` керує лише розкладом. У демо НБУ немає (демо-курси вигадані).
 *
 * Ланцюжок (рецепт етапу 5): `finance.fx_fetch_scheduled` кожні 6 год (перший — через 5 хв після старту) СПЕРШУ планує
 * наступний, потім, якщо nbuEnabled і autoFetch, ставить `finance.fx_fetch` (дедуплікація `fx:<дата Києва>:<слот>`).
 * Кнопка ставить те саме завдання; «Завантажити історичні курси» → `finance.fx_backfill {currency, from, to}` — по
 * завданню на вікно ≤ 1 року. Після нових рядків — `finance.valuation_pending` (WP2: оцінки, що чекали курсу).
 * Стан останнього отримання — finance_state.fx_fetched_at / fx_fetch_status (лише час і код, без тексту відповіді).
 */
import type { Db, DbOrTx } from "~/db/client.server";
import type { OfficialFxRateSource } from "~/integrations/directories/types";
import { NbuFetchError } from "~/integrations/fx/nbu.server";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { addDays, businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueValuationPending } from "~/modules/costing/jobs.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { loadFinanceSettings, saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { updateFinanceState } from "~/modules/finance/core/store.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING, financeJobDedupe } from "~/modules/finance/jobs";
import { enqueueJob } from "~/modules/jobs/queue.server";
import type { AppMode, ServiceContext } from "~/server/types";
import { NBU_BACKFILL_EARLIEST, NBU_BACKFILL_MAX_YEARS, NBU_BACKFILL_WINDOW_DAYS, nbuFetchWindow, splitWindows } from "./nbu-parse";

export { NBU_BACKFILL_EARLIEST, NBU_BACKFILL_MAX_YEARS };
import { parseRateCurrency } from "./rate-input";
import { storeOfficialRates, type StoreOfficialRatesResult } from "./rates-store.server";

/** Пауза між завданнями вікон довантаження (без сплеску запитів до НБУ). */
export const NBU_BACKFILL_SPACING_MS = 30_000;

export type FxFetchStatus = "ok" | "empty" | `error:${string}`;

export type FxFetchOutcome =
  | { status: "disabled" }
  | { status: "demo" }
  | ({ status: "ok" | "empty" } & StoreOfficialRatesResult);

const KYIV_HOUR = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Kyiv", hour: "2-digit", hourCycle: "h23" });

/** Дата Києва і 6-годинний слот (0..3) моменту — ключ дедуплікації `fx:<дата>:<слот>`. */
export function fxFetchSlot(now: Date): { date: string; slot: number } {
  const hour = Number(KYIV_HOUR.format(now)) % 24;
  return { date: businessDate(now), slot: Math.floor(hour / 6) };
}

async function recordStatus(db: DbOrTx, at: Date, status: FxFetchStatus): Promise<void> {
  await updateFinanceState(db, { fxFetchedAt: at, fxFetchStatus: status });
}

/** Помилка завдання: повторювана — звичайна (черга повторить), інша — DomainError (без повторів). Лише код. */
function jobError(error: unknown): Error {
  if (error instanceof NbuFetchError) return error.retryable ? new Error(`nbu.${error.code}`) : new DomainError(`nbu.${error.code}`, 502);
  return error instanceof Error ? error : new Error("nbu.unknown");
}

async function fetchAndStore(
  db: Db,
  input: { source: OfficialFxRateSource; from: string; to: string; currency?: string; now: Date; mode: AppMode },
): Promise<FxFetchOutcome> {
  let rows;
  try {
    rows = await input.source.fetchRates({ from: input.from, to: input.to, ...(input.currency ? { currency: input.currency } : {}) });
  } catch (error) {
    const code = error instanceof NbuFetchError ? error.code : "unknown";
    await recordStatus(db, input.now, `error:${code}`);
    logger.warn("fx.nbu_fetch_failed", { code, currency: input.currency ?? null });
    throw jobError(error);
  }
  const stored = await storeOfficialRates(db, rows, { fetchedAt: input.now, mode: input.mode });
  await recordStatus(db, input.now, rows.length === 0 ? "empty" : "ok");
  if (stored.inserted > 0) await enqueueValuationPending(db);
  logger.info("fx.nbu_fetched", { rows: rows.length, inserted: stored.inserted, unchanged: stored.unchanged, conflicts: stored.conflicts });
  return { status: rows.length === 0 ? "empty" : "ok", ...stored };
}

/**
 * Обробник `finance.fx_fetch`: вікно [сьогодні − 3, сьогодні + 7] для всіх валют. Вимикач перевіряється ДО мережі.
 * У робочому режимі (обробник черги в демо не працює); `mode` — для тестів.
 */
export async function runFxFetch(db: Db, opts: { source: OfficialFxRateSource; now?: Date; mode?: AppMode }): Promise<FxFetchOutcome> {
  const mode = opts.mode ?? "production";
  if (mode === "demo") return { status: "demo" };
  const settings = await loadFinanceSettings(db);
  if (!settings.fx.nbuEnabled) return { status: "disabled" };
  const now = opts.now ?? new Date();
  const window = nbuFetchWindow(businessDate(now));
  return fetchAndStore(db, { source: opts.source, ...window, now, mode });
}

/** Обробник `finance.fx_backfill {currency, from, to}` (одне вікно ≤ 1 року). Вимикач — ДО мережі. */
export async function runFxBackfill(
  db: Db,
  opts: { source: OfficialFxRateSource; currency: string; from: string; to: string; now?: Date; mode?: AppMode },
): Promise<FxFetchOutcome> {
  const mode = opts.mode ?? "production";
  if (mode === "demo") return { status: "demo" };
  const settings = await loadFinanceSettings(db);
  if (!settings.fx.nbuEnabled) return { status: "disabled" };
  return fetchAndStore(db, { source: opts.source, currency: opts.currency, from: opts.from, to: opts.to, now: opts.now ?? new Date(), mode });
}

/** Наступна ланка ланцюжка розкладу (уже заплановану не дублює). */
export function scheduleFxChain(db: DbOrTx, opts: { now?: Date; delayMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  return enqueueJob(db, FINANCE_JOB.fxFetchScheduled, {}, {
    dedupeKey: financeJobDedupe.fxFetchScheduled(),
    maxAttempts: 3,
    runAt: new Date(now.getTime() + (opts.delayMs ?? FINANCE_JOB_TIMING.fxFetchIntervalMs)),
  });
}

/** Ставить `finance.fx_fetch` поточного слоту (дедуплікація серед завдань у черзі). */
export function enqueueFxFetch(db: DbOrTx, now: Date = new Date()): Promise<boolean> {
  const { date, slot } = fxFetchSlot(now);
  return enqueueJob(db, FINANCE_JOB.fxFetch, { date, slot }, { dedupeKey: financeJobDedupe.fxFetch(date, slot), maxAttempts: 4 });
}

export type FxScheduledOutcome = { status: "queued" | "already_queued" } | { status: "disabled" } | { status: "auto_off" };

/** Обробник `finance.fx_fetch_scheduled`: спершу наступна ланка, потім (якщо дозволено) отримання. Без мережі. */
export async function runFxFetchScheduled(db: Db, now: Date = new Date()): Promise<FxScheduledOutcome> {
  await scheduleFxChain(db, { now });
  const settings = await loadFinanceSettings(db);
  if (!settings.fx.nbuEnabled) return { status: "disabled" };
  if (!settings.fx.autoFetch) return { status: "auto_off" };
  return { status: (await enqueueFxFetch(db, now)) ? "queued" : "already_queued" };
}

type OwnerCtx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;

function assertNbuAvailable(ctx: OwnerCtx, enabled: boolean): void {
  if (ctx.mode === "demo") throw new DomainError("financeFx.error.demoNoNbu", 409);
  if (!enabled) throw new DomainError("finance.error.nbuDisabled", 409);
}

/** Кнопка «Оновити курси НБУ зараз» (finance.manage): ставить `finance.fx_fetch`. Вимкнено / демо — відмова. */
export async function requestNbuFetch(ctx: OwnerCtx): Promise<{ queued: boolean }> {
  requireFinance(ctx, "manage");
  const settings = await loadFinanceSettings(ctx.db);
  assertNbuAvailable(ctx, settings.fx.nbuEnabled);
  const queued = await enqueueFxFetch(ctx.db, ctx.now());
  await writeAudit(ctx.db, ctx.actor, "finance.fx_fetch_requested", { type: "finance_state", id: "default" }, { queued });
  return { queued };
}

export interface NbuBackfillInput {
  currency: string;
  from: string;
  to: string;
}

/**
 * «Завантажити історичні курси» (finance.manage): одна валюта, період ≤ 5 років від 2000-01-01 до сьогодні + 7 →
 * завдання `finance.fx_backfill` на кожне вікно ≤ 1 року (рознесені в часі). Вимкнено / демо — відмова.
 */
export async function requestNbuBackfill(ctx: OwnerCtx, input: NbuBackfillInput): Promise<{ windows: number; queued: number }> {
  requireFinance(ctx, "manage");
  const settings = await loadFinanceSettings(ctx.db);
  assertNbuAvailable(ctx, settings.fx.nbuEnabled);
  const c = parseRateCurrency(input.currency);
  if (!c.ok) throw new DomainError(c.error, 400, { currency: (input.currency ?? "").trim().toUpperCase().slice(0, 3) });
  const today = businessDate(ctx.now());
  // Дата до 2000 р. — окреме пояснення (календарні функції застосунку працюють з 2000 р.).
  if (/^\d{4}-\d{2}-\d{2}$/.test(input.from ?? "") && input.from < NBU_BACKFILL_EARLIEST) {
    throw new DomainError("financeFx.error.backfillTooEarly", 400, { date: NBU_BACKFILL_EARLIEST });
  }
  const from = parseIsoDate(input.from);
  const to = parseIsoDate(input.to);
  if (!from || !to || from > to) throw new DomainError("financeFx.error.periodInvalid", 400);
  if (to > addDays(today, 7)) throw new DomainError("financeFx.error.dateTooFar", 400, { days: 7 });
  const windows = splitWindows(from, to, NBU_BACKFILL_WINDOW_DAYS);
  if (windows.length > NBU_BACKFILL_MAX_YEARS) throw new DomainError("financeFx.error.backfillTooLong", 400, { years: NBU_BACKFILL_MAX_YEARS });
  const now = ctx.now();
  let queued = 0;
  for (const [i, w] of windows.entries()) {
    const ok = await enqueueJob(ctx.db, FINANCE_JOB.fxBackfill, { currency: c.currency, from: w.from, to: w.to }, {
      dedupeKey: financeJobDedupe.fxBackfill(c.currency, w.from, w.to),
      maxAttempts: 4,
      runAt: new Date(now.getTime() + i * NBU_BACKFILL_SPACING_MS),
    });
    if (ok) queued++;
  }
  await writeAudit(ctx.db, ctx.actor, "finance.fx_backfill_requested", { type: "finance_state", id: "default" }, { windows: windows.length, queued });
  return { windows: windows.length, queued };
}

/**
 * Вимикач запитів до НБУ на сторінці курсів (finance.manage): та сама зміна налаштувань `finance`, що на сторінці
 * фінансових налаштувань (settings_history + finance_change_log, причина). У демо — відмова (НБУ немає).
 */
export async function setNbuEnabled(ctx: OwnerCtx, input: { enabled: boolean; reason?: string | null; expectedVersion?: number }): Promise<{ ok: boolean; version: number | null }> {
  requireFinance(ctx, "manage");
  if (ctx.mode === "demo") throw new DomainError("financeFx.error.demoNoNbu", 409);
  const settings = await loadFinanceSettings(ctx.db);
  const r = await saveFinanceSettings(ctx, { fx: { ...settings.fx, nbuEnabled: input.enabled } }, {
    reason: input.reason ?? null,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  });
  if (r.ok && input.enabled) await scheduleFxChain(ctx.db, { now: ctx.now(), delayMs: FINANCE_JOB_TIMING.fxFetchFirstDelayMs });
  return { ok: r.ok, version: r.ok ? r.version : null };
}

/**
 * Етап 6, WP2: завдання пакета собівартості (docs/stage6-design.md §6.3, §21.1). Контракт — FinanceJobModule
 * (modules/finance/core/contracts.ts); статично збирає modules/finance/jobs.server.ts. У демо обробника немає (курси
 * засіваються першими; ручний курс завершує шари одразу — WP1 викликає completeFxPendingLayers у своїй транзакції).
 *
 * - finance.valuation_pending {currency?, date?} — завершення шарів fx_pending, для яких з'явився курс (SYSTEM_ACTOR).
 *   Ставить WP1 після отримання курсів НБУ (enqueueValuationPending) і ensureSchedules — при старті, якщо є шари, що
 *   чекають курсу. Корисне навантаження — лише коди валют і дати (без грошей).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import { inventoryCostLayers } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import type { FinanceJobDeps } from "~/modules/finance/core/contracts";
import { FINANCE_JOB, financeJobDedupe } from "~/modules/finance/jobs";
import { enqueueJob } from "~/modules/jobs/queue.server";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import { completeFxPendingLayers } from "./fx-pending.server";

const CURRENCY_RE = /^[A-Z]{3}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Розбір корисного навантаження (лише валюта й дата; усе інше ігнорується). */
export function valuationPendingScope(payload: unknown): { currency?: string; date?: string } {
  const p = (payload ?? {}) as Record<string, unknown>;
  const scope: { currency?: string; date?: string } = {};
  if (typeof p.currency === "string" && CURRENCY_RE.test(p.currency)) scope.currency = p.currency;
  if (typeof p.date === "string" && DATE_RE.test(p.date)) scope.date = p.date;
  return scope;
}

export function handlers(deps: FinanceJobDeps): JobHandlers {
  return {
    [FINANCE_JOB.valuationPending]: {
      async run(job) {
        const scope = valuationPendingScope(job.payload);
        const { completed } = await deps.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, scope));
        logger.info("costing.valuation_pending_done", { completed, currency: scope.currency ?? null });
      },
    },
  };
}

/** Чи є шари fx_pending, що чекають курсу. */
export async function hasPendingFxLayers(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ one: sql<number>`1` })
    .from(inventoryCostLayers)
    .where(and(eq(inventoryCostLayers.reason, "fx_pending"), isNull(inventoryCostLayers.closedAt)))
    .limit(1);
  return Boolean(row);
}

/**
 * Ставить завдання завершення ВСІХ очікуваних оцінок (ідемпотентно — одне завдання в черзі, dedupe). Для WP1: після
 * отримання курсів НБУ. Корисне навантаження порожнє (обробник перевіряє всі шари fx_pending).
 */
export function enqueueValuationPending(db: DbOrTx, runAt?: Date): Promise<boolean> {
  return enqueueJob(db, FINANCE_JOB.valuationPending, {}, { dedupeKey: financeJobDedupe.valuationPending(), runAt });
}

export async function ensureSchedules(db: Db): Promise<void> {
  try {
    if (await hasPendingFxLayers(db)) await enqueueValuationPending(db);
  } catch (error) {
    logger.error("costing.schedules_failed", { error });
  }
}

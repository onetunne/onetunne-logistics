/**
 * Етап 6 (WP3): постановка фінансових завдань у чергу (docs/stage6-design.md §16.3). Без важких залежностей —
 * імпортують синхронізація етапу 2 (після збереження замовлення), webhooks (REFUNDS_CREATE, ORDERS_EDITED), сервіси
 * власника й завдання. Дедуплікація `finance-order:<gid>` (поки завдання в черзі, повторні події нового не створюють),
 * запуск через +30 с — сплеск webhook-ів одного замовлення об'єднується в одне читання. Примусове читання (кнопка
 * власника) не губиться дедуплікацією: завдання, що вже чекає, отримує force і запускається не пізніше за нове.
 */
import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { jobs } from "~/db/schema";
import { FINANCE_JOB, FINANCE_JOB_TIMING, financeJobDedupe } from "~/modules/finance/jobs";
import { enqueueJob } from "~/modules/jobs/queue.server";

/** Корисне навантаження finance.sync_order (лише id і прапорці — §14.2). */
export interface FinanceSyncOrderPayload {
  shop: string;
  orderGid: string;
  /** Відкладене повторне читання customerJourneySummary (§9.2, ≤ 3). */
  journey?: boolean;
  /** Перечитати угоди й повернення, навіть якщо updatedAt не змінився (кнопка власника). */
  force?: boolean;
}

export const FINANCE_SYNC_MAX_ATTEMPTS = 6;

/**
 * finance.sync_order {shop, orderGid}: dedupe finance-order:<gid>, runAt now + delayMs (типово +30 с). true — у черзі
 * з'явилося нове завдання або (force) завдання, що вже чекало, тепер примусове; false — таке саме вже чекає.
 */
export async function enqueueFinanceOrderSync(
  db: DbOrTx,
  input: { shop: string; orderGid: string; force?: boolean },
  opts: { now?: Date; delayMs?: number } = {},
): Promise<boolean> {
  const now = opts.now ?? new Date();
  const payload: FinanceSyncOrderPayload = { shop: input.shop, orderGid: input.orderGid, ...(input.force ? { force: true } : {}) };
  const dedupeKey = financeJobDedupe.syncOrder(input.orderGid);
  const runAt = new Date(now.getTime() + (opts.delayMs ?? FINANCE_JOB_TIMING.syncOrderDelayMs));
  // Дві спроби: якщо завдання, що чекало, саме взяв обробник (між вставкою й оновленням) — вставка вдасться повторно.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (await enqueueJob(db, FINANCE_JOB.syncOrder, { ...payload }, { dedupeKey, runAt, maxAttempts: FINANCE_SYNC_MAX_ATTEMPTS })) return true;
    if (!input.force) return false;
    // Уже чекає звичайне (не примусове) — воно стає примусовим і запускається не пізніше за запитаний час.
    const upgraded = await db
      .update(jobs)
      .set({
        payload: sql`${jobs.payload} || '{"force":true}'::jsonb`,
        runAt: sql`least(${jobs.runAt}, ${runAt.toISOString()}::timestamptz)`,
        updatedAt: now,
      })
      .where(and(eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, "queued"), sql`coalesce((${jobs.payload}->>'force')::boolean, false) = false`))
      .returning({ id: jobs.id });
    if (upgraded.length > 0) return true;
    const [forced] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, dedupeKey), eq(jobs.status, "queued")))
      .limit(1);
    if (forced) return false; // примусове вже чекає
  }
  return false;
}

/** Відкладене повторне читання customerJourneySummary (dedupe finance-journey:<gid>). */
export function enqueueJourneyRecheck(db: DbOrTx, input: { shop: string; orderGid: string; delayMs: number }, now: Date = new Date()): Promise<boolean> {
  const payload: FinanceSyncOrderPayload = { shop: input.shop, orderGid: input.orderGid, journey: true };
  return enqueueJob(db, FINANCE_JOB.syncOrder, { ...payload }, {
    dedupeKey: financeJobDedupe.journey(input.orderGid),
    runAt: new Date(now.getTime() + input.delayMs),
    maxAttempts: FINANCE_SYNC_MAX_ATTEMPTS,
  });
}

/** Ланцюжок звірки finance.reconcile_scheduled (dedupe; уже заплановану ланку не переносить). */
export function scheduleReconcileChain(db: DbOrTx, opts: { now?: Date; delayMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  return enqueueJob(db, FINANCE_JOB.reconcileScheduled, {}, {
    dedupeKey: financeJobDedupe.reconcileScheduled(),
    maxAttempts: 3,
    runAt: new Date(now.getTime() + (opts.delayMs ?? FINANCE_JOB_TIMING.reconcileIntervalMs)),
  });
}

/** Сторінка початкового заповнення finance.backfill_orders (dedupe). */
export function scheduleBackfill(db: DbOrTx, opts: { now?: Date; delayMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  return enqueueJob(db, FINANCE_JOB.backfillOrders, {}, {
    dedupeKey: financeJobDedupe.backfillOrders(),
    maxAttempts: 6,
    runAt: new Date(now.getTime() + (opts.delayMs ?? 0)),
  });
}

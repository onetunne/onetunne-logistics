/**
 * Етап 6 (WP3): обробники й розклади завдань синхронізації фінансів Shopify (docs/stage6-design.md §16.3):
 * finance.sync_order, finance.reconcile_scheduled, finance.reconcile, finance.backfill_orders. Контракт —
 * FinanceJobModule (modules/finance/core/contracts.ts); статично збирає modules/finance/jobs.server.ts. Обробники
 * виконуються з SYSTEM_ACTOR; корисне навантаження й помилки — лише id і коди (§14.2). У демо обробників немає
 * (ensureJobWorker — лише з ключами Shopify і DATABASE_URL).
 */
import { z } from "zod";
import type { Db } from "~/db/client.server";
import type { FinanceJobDeps } from "~/modules/finance/core/contracts";
import { ensureFinanceState } from "~/modules/finance/core/store.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING } from "~/modules/finance/jobs";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { scheduleBackfill, scheduleReconcileChain } from "./schedule.server";
import { runFinanceBackfill, runFinanceReconcile, runReconcileScheduled } from "./scheduled.server";
import { runFinanceOrderSync } from "./sync-order.server";

const gidSchema = z.string().regex(/^gid:\/\/shopify\/Order\/\d+$/);

const syncOrderPayload = z.object({
  shop: z.string().min(1).max(255).optional(),
  orderGid: gidSchema,
  journey: z.boolean().optional(),
  force: z.boolean().optional(),
});

const reconcilePayload = z.object({
  shop: z.string().min(1).max(255).optional(),
  after: z.string().max(2000).nullable().optional(),
  query: z.string().max(200).optional(),
  startedAt: z.string().max(40).optional(),
});

function payloadOf<T>(schema: z.ZodType<T>, payload: unknown, type: string): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new DomainError("job.invalidPayload", 422, { type });
  return r.data;
}

/** Магазин завдання: з корисного навантаження або поточне встановлення. */
async function shopOf(db: Db, shop: string | undefined): Promise<string | null> {
  if (shop) return shop;
  return (await currentShop(db))?.shop ?? null;
}

export function handlers(deps: FinanceJobDeps): JobHandlers {
  return {
    [FINANCE_JOB.syncOrder]: {
      run: async (job) => {
        const p = payloadOf(syncOrderPayload, job.payload, FINANCE_JOB.syncOrder);
        const shop = await shopOf(deps.db, p.shop);
        if (!shop) return;
        const outcome = await runFinanceOrderSync({ db: deps.db, admin: await deps.admin(shop) }, { ...p, shop });
        if (outcome.status !== "synced") logger.info("finance.sync_order", { status: outcome.status });
      },
    },
    [FINANCE_JOB.reconcileScheduled]: {
      run: async () => {
        const outcome = await runReconcileScheduled(deps.db);
        logger.info("finance.reconcile_scheduled", { ...outcome });
      },
    },
    [FINANCE_JOB.reconcile]: {
      run: async (job) => {
        const p = payloadOf(reconcilePayload, job.payload, FINANCE_JOB.reconcile);
        const shop = await shopOf(deps.db, p.shop);
        if (!shop) return;
        const outcome = await runFinanceReconcile(
          { db: deps.db, admin: await deps.admin(shop) },
          { shop, after: p.after ?? null, ...(p.query ? { query: p.query } : {}), ...(p.startedAt ? { startedAt: p.startedAt } : {}) },
        );
        logger.info("finance.reconcile", { ...outcome });
      },
    },
    [FINANCE_JOB.backfillOrders]: {
      run: async () => {
        const outcome = await runFinanceBackfill(deps.db);
        logger.info("finance.backfill_orders", { ...outcome });
      },
    },
  };
}

/**
 * Запуск ланцюжків (один виклик ensureFinanceSchedules з ensureJobWorker): звірка — перша через 10 хв (уже заплановану
 * не переносить); початкове заповнення — поки finance_state.backfilled_at порожній. Не кидає винятків (реєстр ядра
 * логує помилку).
 */
export async function ensureSchedules(db: Db): Promise<void> {
  const now = new Date();
  await scheduleReconcileChain(db, { now, delayMs: FINANCE_JOB_TIMING.reconcileFirstDelayMs });
  const state = await ensureFinanceState(db);
  if (!state.backfilledAt) await scheduleBackfill(db, { now, delayMs: 2 * 60_000 });
}

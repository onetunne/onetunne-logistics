/**
 * Етап 6, WP3 (заглушка ядра, раунд 0): обробники й розклади завдань пакета (finance.sync_order, finance.reconcile_scheduled, finance.reconcile, finance.backfill_orders).
 * Контракт — FinanceJobModule (modules/finance/core/contracts.ts); статично збирає modules/finance/jobs.server.ts.
 * Назви завдань — FINANCE_JOB (modules/finance/jobs.ts). Заглушка: обробників немає, ланцюжки не ставляться.
 */
import type { Db } from "~/db/client.server";
import type { FinanceJobDeps } from "~/modules/finance/core/contracts";
import type { JobHandlers } from "~/modules/jobs/worker.server";

export function handlers(_deps: FinanceJobDeps): JobHandlers {
  return {};
}

export async function ensureSchedules(_db: Db): Promise<void> {
  // WP3: реалізація.
}

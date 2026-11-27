/** Обробники фонових завдань синхронізації залишків (реєструються в modules/shopify-sync/handlers.server.ts). */
import type { Db } from "~/db/client.server";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { logger } from "~/lib/logger.server";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import { INVENTORY_SYNC_JOB } from "./jobs";
import { runInventoryPush } from "./push.server";
import { parseReconcilePayload, runReconcileJob } from "./reconcile.server";
import { ensureInventoryPushSweep } from "./schedule.server";

export interface InventorySyncDeps {
  db: Db;
  admin: (shop: string) => Promise<AdminGraphql>;
  /** SHOPIFY_APP_URL; за замовчуванням — зі змінних середовища (лише робочий режим). */
  appUrl?: () => string | null;
}

async function defaultAppUrl(): Promise<string | null> {
  const { getEnv } = await import("~/lib/env.server");
  return getEnv().SHOPIFY_APP_URL ?? null;
}

export function createInventorySyncHandlers(deps: InventorySyncDeps): JobHandlers {
  return {
    [INVENTORY_SYNC_JOB.push]: {
      run: async () => {
        const appUrl = deps.appUrl ? deps.appUrl() : await defaultAppUrl();
        const result = await runInventoryPush({ db: deps.db, admin: deps.admin, appUrl });
        if (result.status !== "done") logger.info("inventory_sync.push_run", { ...result });
        // Страховий обхід: поки передачу ввімкнено, наступний запуск — не пізніше ніж через PUSH_SWEEP_MS
        // (рухи модулів, що не поставили передачу самі; вимкнення передачі → очікувані стануть skipped).
        // Збій запуску (виняток) сюди не доходить: повтор робить черга, а повторний запуск продовжить ланцюжок.
        if (result.skipReason !== "push_off" && result.skipReason !== "not_installed") await ensureInventoryPushSweep(deps.db);
      },
    },
    [INVENTORY_SYNC_JOB.reconcile]: {
      run: async (job) => {
        const payload = parseReconcilePayload(job.payload);
        if (!payload) {
          logger.warn("inventory_sync.reconcile_bad_payload", { jobId: job.id });
          return;
        }
        await runReconcileJob({ db: deps.db, admin: deps.admin }, payload);
      },
    },
  };
}

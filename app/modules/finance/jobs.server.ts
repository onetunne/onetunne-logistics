/**
 * Етап 6: реєстр фінансових завдань (docs/stage6-design.md §21.1). СТАТИЧНО збирає обробники й розклади з модулів
 * пакетів — пакети не дописують рядків у файли ядра:
 *   fx/jobs.server.ts (WP1) · costing/jobs.server.ts (WP2) · finance-sync/jobs.server.ts (WP3) ·
 *   finance-reports/jobs.server.ts (WP10).
 * Точки підключення: createFinanceJobHandlers — у мапі обробників (modules/shopify-sync/handlers.server.ts);
 * ensureFinanceSchedules — в ensureJobWorker (server/production-runtime.server.ts). У демо обробника немає.
 */
import type { Db } from "~/db/client.server";
import { logger } from "~/lib/logger.server";
import * as costingJobs from "~/modules/costing/jobs.server";
import * as financeReportsJobs from "~/modules/finance-reports/jobs.server";
import * as financeSyncJobs from "~/modules/finance-sync/jobs.server";
import * as fxJobs from "~/modules/fx/jobs.server";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import type { FinanceJobDeps, FinanceJobModule } from "./core/contracts";
import { FINANCE_JOB_NAMES, FINANCE_JOB_OWNER, type FinanceJobName } from "./jobs";

export const FINANCE_JOB_MODULES = {
  fx: fxJobs satisfies FinanceJobModule,
  costing: costingJobs satisfies FinanceJobModule,
  "finance-sync": financeSyncJobs satisfies FinanceJobModule,
  "finance-reports": financeReportsJobs satisfies FinanceJobModule,
} as const;

/**
 * Обробники всіх фінансових завдань. Кожен модуль може обробляти лише свої завдання (FINANCE_JOB_OWNER); чуже чи
 * невідоме ім'я — помилка конфігурації (виняток під час старту, не тихе перезаписування).
 */
export function createFinanceJobHandlers(deps: FinanceJobDeps): JobHandlers {
  const out: JobHandlers = {};
  for (const [owner, mod] of Object.entries(FINANCE_JOB_MODULES) as Array<[keyof typeof FINANCE_JOB_MODULES, FinanceJobModule]>) {
    for (const [name, handler] of Object.entries(mod.handlers(deps))) {
      if (!(FINANCE_JOB_NAMES as readonly string[]).includes(name) || FINANCE_JOB_OWNER[name as FinanceJobName] !== owner) {
        throw new Error(`finance job ${name} is not registered for module ${owner}`);
      }
      out[name] = handler;
    }
  }
  return out;
}

/** Запуск ланцюжків усіх модулів (FX, звірка, початкове заповнення, знімки, очікувані оцінки). Не кидає винятків. */
export async function ensureFinanceSchedules(db: Db): Promise<void> {
  for (const [owner, mod] of Object.entries(FINANCE_JOB_MODULES) as Array<[string, FinanceJobModule]>) {
    try {
      await mod.ensureSchedules(db);
    } catch (error) {
      logger.error("finance.schedules_failed", { module: owner, error });
    }
  }
}

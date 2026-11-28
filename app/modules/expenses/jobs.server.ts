/**
 * Етап 6, WP6 (інтеграційний раунд ядра): завдання пакета витрат (docs/stage6-design.md §10.3, I16, §21.1). Контракт —
 * FinanceJobModule (modules/finance/core/contracts.ts); статично збирає modules/finance/jobs.server.ts. У демо обробника
 * немає (кнопка «Перерахувати розподіл» лишається; enqueueExpenseReallocation у демо нічого не ставить).
 *
 * - finance.expense_reallocate {expenseId} — перерахунок розподілу суми періоду (той самий, що кнопка власника) від
 *   SYSTEM_ACTOR у власній транзакції (reallocation.server.ts runExpenseReallocation). Ставить WP4
 *   (enqueueExpenseReallocation), коли замовлення чекає перерозподілу. Корисне навантаження — id витрати (+ номер
 *   повтору після no_rate: немає курсу → повтор через годину, scheduleNoRateRetry; завдання не «мертве»).
 */
import { z } from "zod";
import type { Db } from "~/db/client.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import type { FinanceJobDeps } from "~/modules/finance/core/contracts";
import { FINANCE_JOB } from "~/modules/finance/jobs";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import { runExpenseReallocation, scheduleNoRateRetry } from "./reallocation.server";

/** noRateRetry — номер повтору після no_rate (ставить сам обробник, scheduleNoRateRetry). */
const payloadSchema = z.object({ expenseId: z.string().uuid(), noRateRetry: z.number().int().min(1).max(100_000).optional() });

export function handlers(deps: FinanceJobDeps): JobHandlers {
  return {
    [FINANCE_JOB.expenseReallocate]: {
      async run(job) {
        const parsed = payloadSchema.safeParse(job.payload);
        if (!parsed.success) throw new DomainError("job.invalidPayload", 400);
        const ctx = deps.serviceContext();
        const { expenseId } = parsed.data;
        const r = await runExpenseReallocation(deps.db, SYSTEM_ACTOR, expenseId, { mode: ctx.mode, now: ctx.now() });
        if (r.status === "no_rate") {
          // Не «мертве» завдання (DomainError не повторюється чергою): повтор, коли курс міг з'явитися.
          const retry = (parsed.data.noRateRetry ?? 0) + 1;
          const queued = await scheduleNoRateRetry(deps.db, expenseId, { retry, now: ctx.now() });
          logger.warn("expenses.reallocate_no_rate", { expenseId, currency: r.missingRate?.currency, date: r.missingRate?.date, retry, queued });
          return;
        }
        logger.info("expenses.reallocate_done", { expenseId, status: r.status, orders: r.allocatedOrders, posted: r.posted, reversed: r.reversed });
      },
    },
  };
}

/** Ланцюжків немає: завдання ставить лише WP4 за станом замовлення. */
export async function ensureSchedules(_db: Db): Promise<void> {
  // Немає планових завдань.
}

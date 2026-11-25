import { randomUUID } from "node:crypto";
import type { Db } from "~/db/client.server";
import { logger } from "~/lib/logger.server";
import { DomainError } from "~/lib/errors";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import { claimJob, completeJob, failJob, type JobRow } from "./queue.server";

export interface JobHandler {
  run(job: JobRow): Promise<void>;
  /** Викликається, коли завдання остаточно не вдалося (dead). */
  onDead?(job: JobRow, error: string): Promise<void>;
}

export type JobHandlers = Record<string, JobHandler>;

export function isRetryable(error: unknown): boolean {
  if (error instanceof ShopifyApiError) return error.retryable;
  if (error instanceof DomainError) return false;
  return true;
}

/** Обробляє готові завдання до вичерпання черги або ліміту. Повертає кількість оброблених. */
export async function runJobsOnce(db: Db, handlers: JobHandlers, opts: { workerId?: string; limit?: number } = {}): Promise<number> {
  const workerId = opts.workerId ?? `w-${process.pid}`;
  let processed = 0;
  while (processed < (opts.limit ?? 20)) {
    const job = await claimJob(db, workerId);
    if (!job) break;
    processed++;
    const handler = handlers[job.type];
    try {
      if (!handler) throw new DomainError("job.unknownType", 500, { type: job.type });
      await handler.run(job);
      await completeJob(db, job);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const outcome = await failJob(db, job, message, isRetryable(e));
      logger.warn("job.failed", { type: job.type, attempts: job.attempts, outcome, error: e });
      if (outcome === "dead") await handler?.onDead?.(job, message).catch(() => undefined);
    }
  }
  return processed;
}

/** Фоновий обробник у процесі сервера (опитування БД). Стан — у БД, тому перезапуск безпечний. */
export function startJobWorker(db: Db, handlers: JobHandlers, intervalMs = 3000): { stop(): void } {
  const workerId = `w-${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  const tick = async () => {
    if (stopped) return;
    try {
      await runJobsOnce(db, handlers, { workerId });
    } catch (e) {
      logger.error("job.worker_error", { error: e });
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 1000);
  logger.info("job.worker_started", { workerId });
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

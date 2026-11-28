/**
 * Етап 6, WP1: обробники й розклади завдань курсів НБУ (docs/stage6-design.md §5.6): finance.fx_fetch_scheduled,
 * finance.fx_fetch, finance.fx_backfill. Контракт — FinanceJobModule (modules/finance/core/contracts.ts); статично
 * збирає modules/finance/jobs.server.ts. Обробники виконуються з SYSTEM_ACTOR; корисне навантаження й помилки — лише
 * коди валют, дати й коди помилок (§14.2). Кожен обробник НБУ ще раз перевіряє `finance.fx.nbuEnabled` ДО мережевого
 * запиту (I18). У демо обробника черги немає (ensureJobWorker — лише з ключами Shopify і DATABASE_URL).
 */
import { z } from "zod";
import type { Db } from "~/db/client.server";
import type { OfficialFxRateSource } from "~/integrations/directories/types";
import { createNbuSource } from "~/integrations/fx/nbu.server";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { parseIsoDate } from "~/lib/periods";
import type { FinanceJobDeps } from "~/modules/finance/core/contracts";
import { FINANCE_JOB, FINANCE_JOB_TIMING } from "~/modules/finance/jobs";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import { NBU_BACKFILL_WINDOW_DAYS, splitWindows } from "./nbu-parse";
import { runFxBackfill, runFxFetch, runFxFetchScheduled, scheduleFxChain } from "./nbu-fetch.server";

const isoDate = z.string().refine((v) => parseIsoDate(v) === v, "date");

const backfillPayload = z
  .object({ currency: z.string().regex(/^[A-Z]{3}$/), from: isoDate, to: isoDate })
  .refine((p) => p.from <= p.to && splitWindows(p.from, p.to, NBU_BACKFILL_WINDOW_DAYS).length === 1, "window");

export interface FxJobOptions {
  /** Джерело курсів (тести — фікстури); типово — НБУ (createNbuSource). */
  source?: OfficialFxRateSource;
}

export function handlers(deps: FinanceJobDeps, opts: FxJobOptions = {}): JobHandlers {
  const source = () => opts.source ?? createNbuSource();
  return {
    [FINANCE_JOB.fxFetchScheduled]: {
      run: async () => {
        const outcome = await runFxFetchScheduled(deps.db);
        logger.info("fx.fetch_scheduled", { status: outcome.status });
      },
    },
    [FINANCE_JOB.fxFetch]: {
      run: async () => {
        const outcome = await runFxFetch(deps.db, { source: source(), mode: deps.serviceContext().mode });
        if (outcome.status === "disabled") logger.info("fx.fetch_skipped", { status: outcome.status });
      },
    },
    [FINANCE_JOB.fxBackfill]: {
      run: async (job) => {
        const p = backfillPayload.safeParse(job.payload);
        if (!p.success) throw new DomainError("job.invalidPayload", 422, { type: FINANCE_JOB.fxBackfill });
        const outcome = await runFxBackfill(deps.db, { source: source(), ...p.data, mode: deps.serviceContext().mode });
        if (outcome.status === "disabled") logger.info("fx.backfill_skipped", { status: outcome.status });
      },
    },
  };
}

/**
 * Запуск ланцюжка розкладу: перша ланка — через 5 хв після старту (уже заплановану не переносить). Сам ланцюжок
 * мережі не торкається: отримання ставиться лише з увімкненими nbuEnabled і autoFetch. Не кидає винятків.
 */
export async function ensureSchedules(db: Db): Promise<void> {
  try {
    await scheduleFxChain(db, { delayMs: FINANCE_JOB_TIMING.fxFetchFirstDelayMs });
  } catch (error) {
    logger.error("fx.schedules_failed", { error });
  }
}

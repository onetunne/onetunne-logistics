/**
 * Етап 6, WP2 (заглушки ядра, раунд 0): довантаження оцінки складу й перебудова демо-історії (docs/stage6-design.md §6.4).
 * Сигнатури остаточні (contracts.ts EnsureValuationBackfill, RebuildValuationForDemo).
 * - ensureValuationBackfill(db) — старт застосунку й seedReferenceData; позиції без стану під VALUATION_LOCK у порядку
 *   (stock_item_id, seq);
 * - rebuildValuationForDemo(tx, ctx) — ЛИШЕ demo або тестове середовище (інакше відмова), наприкінці seedDemoFinance.
 */
import type { Db, Tx } from "~/db/client.server";
import { DomainError } from "~/lib/errors";
import type { EnsureValuationBackfill, RebuildValuationForDemo } from "~/modules/finance/core/contracts";
import type { ServiceContext } from "~/server/types";

export const ensureValuationBackfill: EnsureValuationBackfill = async (_db: Db): Promise<void> => {
  // WP2: реалізація.
};

/** Дозволено лише в демо або в тестах (Vitest). */
export function assertDemoRebuildAllowed(ctx: Pick<ServiceContext, "mode">): void {
  if (ctx.mode !== "demo" && !process.env.VITEST) throw new DomainError("finance.error.demoOnly", 403);
}

export const rebuildValuationForDemo: RebuildValuationForDemo = async (_tx: Tx, ctx: Pick<ServiceContext, "mode">): Promise<void> => {
  assertDemoRebuildAllowed(ctx);
  // WP2: реалізація.
};

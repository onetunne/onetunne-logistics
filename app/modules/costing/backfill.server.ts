/**
 * Етап 6, WP2: довантаження оцінки складу й перебудова демо-історії (docs/stage6-design.md §6.4).
 * - ensureValuationBackfill(db) — старт застосунку й seedReferenceData: позиції без стану (або з неоціненими рухами
 *   seq > last_seq) оцінюються під pg_advisory_xact_lock(VALUATION_LOCK), кожна у своїй транзакції, у порядку
 *   (stock_item_id, seq); баланс позиції блокується першим (той самий порядок, що applyMovements, — без взаємоблокувань).
 *   Ідемпотентно (I9: довантаження з нуля = покрокова оцінка).
 * - rebuildValuationForDemo(tx, ctx) — ЛИШЕ демо або тестове середовище (інакше відмова), наприкінці seedDemoFinance:
 *   видаляє оцінки, шари, стани й похідні записи журналу складу (source_type valuation / cost_adjustment) і переоцінює
 *   всі рухи за (created_at, seq) — ЄДИНИЙ виняток із порядку за seq (демо пересуває дати після вставки). Потім
 *   переоцінює партії (revalueBatchLines) і синхронізує фінанси замовлень з оцінками (syncOrderFinance).
 * ВНУТРІШНІ функції (INTERNAL_POSTING_FUNCTIONS).
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db, Tx } from "~/db/client.server";
import {
  financeEntries,
  inventoryCostLayers,
  inventoryCostState,
  inventoryMovements,
  inventoryValuationCompletions,
  inventoryValuations,
  productionReceipts,
} from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { logger, redact } from "~/lib/logger.server";
import type { EnsureValuationBackfill, RebuildValuationForDemo } from "~/modules/finance/core/contracts";
import { lockValuation, lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { updateFinanceState } from "~/modules/finance/core/store.server";
import { lockBalances } from "~/modules/inventory/ledger.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";
import type { ServiceContext } from "~/server/types";
import { loadCostingContext } from "./inputs.server";
import { revalueBatchLinesInternal } from "./revalue.server";
import { flushValuationResults, itemPairsInLockOrder, valueItemMovements } from "./valuation.server";

/** Позиції з неоціненими рухами: стану немає або last_seq < max(seq). */
async function pairsNeedingValuation(db: Db): Promise<Array<{ warehouseId: string; stockItemId: string }>> {
  const rows = await db
    .select({ warehouseId: inventoryMovements.warehouseId, stockItemId: inventoryMovements.stockItemId })
    .from(inventoryMovements)
    .leftJoin(
      inventoryCostState,
      and(eq(inventoryCostState.warehouseId, inventoryMovements.warehouseId), eq(inventoryCostState.stockItemId, inventoryMovements.stockItemId)),
    )
    .groupBy(inventoryMovements.warehouseId, inventoryMovements.stockItemId, inventoryCostState.lastSeq)
    .having(sql`${inventoryCostState.lastSeq} is null or ${inventoryCostState.lastSeq} < max(${inventoryMovements.seq})`);
  return itemPairsInLockOrder(rows);
}

export const ensureValuationBackfill: EnsureValuationBackfill = async (db: Db): Promise<void> => {
  const pairs = await pairsNeedingValuation(db);
  for (const pair of pairs) {
    try {
      await db.transaction(async (tx) => {
        await lockValuation(tx);
        await lockBalances(tx, [pair]);
        const cctx = await loadCostingContext(tx);
        const r = await valueItemMovements(tx, cctx, pair.warehouseId, pair.stockItemId);
        await flushValuationResults(tx, [r]);
      });
    } catch (e) {
      if (process.env.VITEST) throw e;
      logger.error("costing.backfill_failed", { stockItemId: pair.stockItemId, error: redact(e) });
    }
  }
  if (pairs.length > 0) await updateFinanceState(db, { valuationBackfilledAt: new Date() });
};

/** Дозволено лише в демо або в тестах (Vitest). */
export function assertDemoRebuildAllowed(ctx: Pick<ServiceContext, "mode">): void {
  if (ctx.mode !== "demo" && !process.env.VITEST) throw new DomainError("finance.error.demoOnly", 403);
}

export const rebuildValuationForDemo: RebuildValuationForDemo = async (tx: Tx, ctx: Pick<ServiceContext, "mode">): Promise<void> => {
  assertDemoRebuildAllowed(ctx);
  // Похідні записи журналу складу (наслідки оцінок, завершення, коригування партій, собівартість замовлень з оцінок).
  await tx.delete(financeEntries).where(inArray(financeEntries.sourceType, ["valuation", "cost_adjustment"]));
  await tx.delete(inventoryValuationCompletions);
  await tx.delete(inventoryCostLayers);
  await tx.delete(inventoryValuations);
  await tx.delete(inventoryCostState);
  const cctx = await loadCostingContext(tx);
  const all = await tx.select().from(inventoryMovements).orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.seq));
  const pairs = itemPairsInLockOrder(all);
  if (pairs.length > 0) await lockBalances(tx, pairs);
  const results = [];
  for (const pair of pairs) {
    const own = all.filter((m) => m.warehouseId === pair.warehouseId && m.stockItemId === pair.stockItemId);
    results.push(await valueItemMovements(tx, cctx, pair.warehouseId, pair.stockItemId, { movements: own, softC0: true }));
  }
  await flushValuationResults(tx, results);
  // Партії з надходженнями — ціль за поточною собівартістю (коригування датою перебудови).
  const batches = await tx.selectDistinct({ id: productionReceipts.batchId }).from(productionReceipts).orderBy(asc(productionReceipts.batchId));
  for (const b of batches) await revalueBatchLinesInternal(tx, SYSTEM_ACTOR, b.id);
  // Фінанси замовлень, що мають оцінки (собівартість, упаковка, повернення).
  const orderRows = await tx
    .selectDistinct({ orderId: inventoryValuations.orderId })
    .from(inventoryValuations)
    .where(isNotNull(inventoryValuations.orderId));
  // FINO усіх замовлень одним упорядкованим набором до першої синхронізації (як WP4 syncOrderFinanceMany, §17.8).
  const financeOrderIds = orderRows.map((r) => r.orderId!).sort();
  await lockFinanceOrders(tx, financeOrderIds);
  for (const o of financeOrderIds) await syncOrderFinance(tx, SYSTEM_ACTOR, o);
};

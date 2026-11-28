/**
 * Етап 6, WP2 → WP4: прогноз собівартості й ручна собівартість для позицій без списання (docs/stage6-design.md §4, §6.5).
 * Внутрішні читання для syncOrderFinance (без перевірки актора; сторінки не імпортують).
 * - unitCostForecast — прогноз одиниці (НЕ проводиться): поточна середня пулу (pool_average) → непідтверджена ручна
 *   собівартість / підказка Shopify (owner_standard) → собівартість якісної одиниці останньої партії (batch);
 *   матеріал: середня пулу → каталожна ціна (catalogue). Немає → null («Немає даних»).
 * - ownerStandardCost — підтверджена ручна собівартість на дату визнання (§6.5 п. 2, D-20): stdcogs = одиниця ×
 *   кількість, передана при визнанні (ключ stdcogs:<lineId>:v<n>, details.quantity) — проводить WP4.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryCostState, packagingMaterials, productionBatches, productionBatchLines, stockItems } from "~/db/schema";
import { toMinor } from "~/lib/money";
import { batchCostSummary } from "~/modules/production/calc";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { centsAverage } from "./engine";
import { manualCostAt } from "./inputs.server";

export interface UnitCostEstimate {
  unitCost: string;
  currency: string;
  basis: "pool_average" | "owner_standard" | "batch" | "catalogue";
}

export async function unitCostForecast(db: DbOrTx, stockItemId: string, date: string): Promise<UnitCostEstimate | null> {
  const warehouse = await getDefaultWarehouse(db);
  const [state] = await db
    .select()
    .from(inventoryCostState)
    .where(and(eq(inventoryCostState.warehouseId, warehouse.id), eq(inventoryCostState.stockItemId, stockItemId)));
  if (state && state.knownQty > 0) {
    const avg = centsAverage(toMinor(state.knownValue), state.knownQty);
    if (avg !== null) return { unitCost: avg, currency: state.currency, basis: "pool_average" };
  }
  const [item] = await db.select().from(stockItems).where(eq(stockItems.id, stockItemId));
  if (!item) return null;
  const manual = await manualCostAt(db, stockItemId, date, { confirmedOnly: false });
  if (manual) return { unitCost: manual.unitCost, currency: manual.currency, basis: item.kind === "material" ? "catalogue" : "owner_standard" };
  if (item.kind === "material" && item.materialId) {
    const [m] = await db.select({ unitCost: packagingMaterials.unitCost, currency: packagingMaterials.costCurrency }).from(packagingMaterials).where(eq(packagingMaterials.id, item.materialId));
    return m?.unitCost && m.currency ? { unitCost: m.unitCost, currency: m.currency, basis: "catalogue" } : null;
  }
  if (!item.variantId) return null;
  const [last] = await db
    .select({ batch: productionBatches, lineId: productionBatchLines.id })
    .from(productionBatchLines)
    .innerJoin(productionBatches, eq(productionBatches.id, productionBatchLines.batchId))
    .where(and(eq(productionBatchLines.variantId, item.variantId), sql`${productionBatchLines.quantityReceived} > 0`))
    .orderBy(desc(productionBatches.createdAt))
    .limit(1);
  if (!last) return null;
  const lines = await db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, last.batch.id));
  const summary = batchCostSummary(
    lines.map((l) => ({ id: l.id, ordered: l.quantityOrdered, received: l.quantityReceived, defective: l.quantityDefective, unitCost: l.unitCost, costCurrency: l.costCurrency })),
    last.batch.extraCost,
    last.batch.costCurrency,
    last.batch.status,
  );
  const unit = summary.lines.find((l) => l.id === last.lineId)?.costPerGoodUnit ?? null;
  return unit && summary.currency ? { unitCost: unit, currency: summary.currency, basis: "batch" } : null;
}

export interface OwnerStandardCost {
  costId: string;
  unitCost: string;
  currency: string;
  effectiveFrom: string;
}

/** Підтверджена ручна собівартість позиції на дату (факт за даними власника, §6.5 п. 2). */
export async function ownerStandardCost(db: DbOrTx, stockItemId: string, date: string): Promise<OwnerStandardCost | null> {
  const row = await manualCostAt(db, stockItemId, date, { confirmedOnly: true });
  return row ? { costId: row.id, unitCost: row.unitCost, currency: row.currency, effectiveFrom: row.effectiveFrom } : null;
}

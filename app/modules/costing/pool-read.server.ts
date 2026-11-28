/**
 * Етап 6, WP2: ВНУТРІШНІ читання вартості пулу (docs/stage6-design.md §6.7, §14.1) — БЕЗ перевірки актора, тож ЛИШЕ для
 * викликачів, що вже перевірили finance.view (сервіси читання costing/queries.server.ts; аналітика складу й CSV етапу 5
 * з includeCosts = canFinance(actor, "view")). Сторінки, маршрути, команди й ШІ цей модуль НЕ імпортують (кандидат у
 * INTERNAL_ONLY_MODULES — запит до ядра); тому він окремий від queries.server.ts, який імпортують сторінки.
 */
import { and, desc, eq, inArray, lte } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryCostState, inventoryValuations, stockItems } from "~/db/schema";
import { POOL_CHANGING_VALUATION_KINDS } from "~/domain/finance";
import { toMinor } from "~/lib/money";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { centsAverage } from "./engine";

export interface PoolStateAt {
  stockItemId: string;
  kind: "product" | "material";
  knownQty: number;
  knownValue: bigint;
  unknownQty: number;
  deficitQty: number;
}

/**
 * Стан пулу кожної позиції після ОСТАННЬОЇ за seq оцінки, що змінює пул (inflow, outflow, revaluation, stock_completion),
 * з occurred_on ≤ D. sale_completion (завершення вже проданих, датою продажу) пул не змінює і пропускається.
 */
export async function poolStatesAt(db: DbOrTx, date: string): Promise<PoolStateAt[]> {
  const rows = await db
    .selectDistinctOn([inventoryValuations.warehouseId, inventoryValuations.stockItemId], {
      stockItemId: inventoryValuations.stockItemId,
      kind: stockItems.kind,
      knownQty: inventoryValuations.knownQtyAfter,
      knownValue: inventoryValuations.knownValueAfter,
      unknownQty: inventoryValuations.unknownQtyAfter,
      deficitQty: inventoryValuations.deficitQtyAfter,
    })
    .from(inventoryValuations)
    .innerJoin(stockItems, eq(stockItems.id, inventoryValuations.stockItemId))
    .where(and(inArray(inventoryValuations.kind, [...POOL_CHANGING_VALUATION_KINDS]), lte(inventoryValuations.occurredOn, date)))
    .orderBy(inventoryValuations.warehouseId, inventoryValuations.stockItemId, desc(inventoryValuations.seq));
  return rows.map((r) => ({
    stockItemId: r.stockItemId,
    kind: r.kind,
    knownQty: r.knownQty ?? 0,
    knownValue: r.knownValue ? toMinor(r.knownValue) : 0n,
    unknownQty: r.unknownQty ?? 0,
    deficitQty: r.deficitQty ?? 0,
  }));
}

export interface PoolValue {
  stockItemId: string;
  knownQty: number;
  knownValue: string;
  unknownQty: number;
  deficitQty: number;
  /** Середня за одиницю (known_value / known_qty) — null, якщо відомих одиниць немає. */
  averageUnit: string | null;
  currency: string;
}

/** Поточний стан пулу позицій складу за замовчуванням (лише для викликачів, що вже перевірили finance.view). */
export async function loadPoolValues(db: DbOrTx, stockItemIds?: readonly string[]): Promise<Map<string, PoolValue>> {
  const out = new Map<string, PoolValue>();
  if (stockItemIds && stockItemIds.length === 0) return out;
  const warehouse = await getDefaultWarehouse(db);
  const rows = await db
    .select()
    .from(inventoryCostState)
    .where(and(eq(inventoryCostState.warehouseId, warehouse.id), stockItemIds ? inArray(inventoryCostState.stockItemId, [...stockItemIds]) : undefined));
  for (const r of rows) {
    out.set(r.stockItemId, {
      stockItemId: r.stockItemId,
      knownQty: r.knownQty,
      knownValue: r.knownValue,
      unknownQty: r.unknownQty,
      deficitQty: r.deficitQty,
      averageUnit: r.knownQty > 0 ? centsAverage(toMinor(r.knownValue), r.knownQty) : null,
      currency: r.currency,
    });
  }
  return out;
}

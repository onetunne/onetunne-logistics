/**
 * Етап 6, WP2: збереження стану пулу, шарів, оцінок і завершень (docs/stage6-design.md §6.2). Лише внутрішній модуль
 * рушія (hook / backfill / completion / revalue): без перевірки актора, нічого не повертає сторінкам.
 * Порядок блокувань (F10, §17.8): баланси (applyMovements / lockBalances) → стан собівартості (FOR UPDATE тут) →
 * фінанси замовлення (syncOrderFinance).
 */
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { inventoryCostLayers, inventoryCostState, inventoryValuationCompletions, inventoryValuations } from "~/db/schema";
import { assertFinanceDetails } from "~/modules/finance/core/details";
import { toMinor } from "~/lib/money";
import { minorToDecimal, type CostLayer, type PoolState, type ValuationDraft } from "./engine";

export type StateRow = typeof inventoryCostState.$inferSelect;
export type LayerRow = typeof inventoryCostLayers.$inferSelect;
export type ValuationRow = typeof inventoryValuations.$inferSelect;
export type CompletionRow = typeof inventoryValuationCompletions.$inferSelect;

export const moneyToMinor = (v: string | null | undefined): bigint | null => (v === null || v === undefined ? null : toMinor(v));

export function stateFromRow(r: StateRow): PoolState {
  return {
    currency: r.currency,
    knownQty: r.knownQty,
    knownValue: toMinor(r.knownValue),
    unknownQty: r.unknownQty,
    deficitQty: r.deficitQty,
    lastAvgUnit: r.lastAvgUnit === null ? null : normalizeRate(r.lastAvgUnit),
    lastSeq: Number(r.lastSeq),
  };
}

/** numeric(20,10) з БД («111.1111111111», «100.0000000000») → без зайвих нулів. */
function normalizeRate(v: string): string {
  return v.includes(".") ? v.replace(/0+$/, "").replace(/\.$/, "") : v;
}

export function layerFromRow(r: LayerRow): CostLayer {
  return {
    id: r.id,
    kind: r.kind,
    reason: r.reason,
    qtyIn: r.qtyIn,
    qtyOpen: r.qtyOpen,
    valueOpen: moneyToMinor(r.valueOpen),
    pendingUnitCost: r.pendingUnitCost,
    pendingCurrency: r.pendingCurrency,
    sourceValuationId: r.sourceValuationId,
    originValuationId: r.originValuationId,
    createdSeq: Number(r.createdSeq),
    closed: r.closedAt !== null,
  };
}

/**
 * Блокує рядок стану (склад, позиція) FOR UPDATE; якщо його немає — створює порожній (у валюті оцінки).
 * Повертає стан і ознаку «щойно створено» (потрібне вбудоване довантаження всієї історії позиції).
 */
export async function lockCostState(tx: Tx, warehouseId: string, stockItemId: string, currency: string): Promise<{ state: PoolState; created: boolean }> {
  const inserted = await tx
    .insert(inventoryCostState)
    .values({ warehouseId, stockItemId, currency })
    .onConflictDoNothing()
    .returning({ warehouseId: inventoryCostState.warehouseId });
  const [row] = await tx
    .select()
    .from(inventoryCostState)
    .where(and(eq(inventoryCostState.warehouseId, warehouseId), eq(inventoryCostState.stockItemId, stockItemId)))
    .for("update");
  if (!row) throw new Error("inventory_cost_state row missing after insert");
  return { state: stateFromRow(row), created: inserted.length > 0 };
}

export async function saveCostState(tx: Tx, warehouseId: string, stockItemId: string, s: PoolState): Promise<void> {
  await tx
    .update(inventoryCostState)
    .set({
      currency: s.currency,
      knownQty: s.knownQty,
      knownValue: minorToDecimal(s.knownValue),
      unknownQty: s.unknownQty,
      deficitQty: s.deficitQty,
      lastAvgUnit: s.lastAvgUnit,
      lastSeq: s.lastSeq,
      version: sql`${inventoryCostState.version} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(inventoryCostState.warehouseId, warehouseId), eq(inventoryCostState.stockItemId, stockItemId)));
}

/** Відкриті шари позиції (усі види), FIFO. */
export async function loadOpenLayers(db: DbOrTx, warehouseId: string, stockItemId: string): Promise<CostLayer[]> {
  const rows = await db
    .select()
    .from(inventoryCostLayers)
    .where(
      and(
        eq(inventoryCostLayers.warehouseId, warehouseId),
        eq(inventoryCostLayers.stockItemId, stockItemId),
        gt(inventoryCostLayers.qtyOpen, 0),
        isNull(inventoryCostLayers.closedAt),
      ),
    )
    .orderBy(asc(inventoryCostLayers.createdSeq), asc(inventoryCostLayers.id));
  return rows.map(layerFromRow);
}

export interface ValuationInsert {
  draft: ValuationDraft;
  eventKey: string;
  warehouseId: string;
  stockItemId: string;
  currency: string;
  movementId: string | null;
  movementSeq: number | null;
  orderId: string | null;
  orderLineItemId: string | null;
  occurredOn: string;
}

export async function insertValuation(tx: Tx, v: ValuationInsert): Promise<void> {
  const d = v.draft;
  const nullAfter = d.kind === "sale_completion";
  await tx.insert(inventoryValuations).values({
    id: d.id,
    eventKey: v.eventKey,
    movementId: v.movementId,
    movementSeq: v.movementSeq,
    warehouseId: v.warehouseId,
    stockItemId: v.stockItemId,
    currency: v.currency,
    kind: d.kind,
    qty: d.qty,
    knownQty: d.knownQty,
    unknownQty: d.unknownQty,
    deficitQty: d.deficitQty,
    value: d.value === null ? null : minorToDecimal(d.value),
    valueSource: d.valueSource,
    drawnLayers: d.drawnLayers,
    originalAmount: d.originalAmount,
    originalCurrency: d.originalCurrency,
    rateDate: d.rateDate,
    rateSource: d.rateSource,
    orderId: v.orderId,
    orderLineItemId: v.orderLineItemId,
    knownQtyAfter: nullAfter ? null : d.after.knownQty,
    knownValueAfter: nullAfter ? null : minorToDecimal(d.after.knownValue),
    unknownQtyAfter: nullAfter ? null : d.after.unknownQty,
    deficitQtyAfter: nullAfter ? null : d.after.deficitQty,
    occurredOn: v.occurredOn,
    details: assertFinanceDetails(d.details),
  });
}

/** Нові шари й зміни наявних (кількість, вартість браку, закриття). */
export async function persistLayers(
  tx: Tx,
  warehouseId: string,
  stockItemId: string,
  layers: readonly CostLayer[],
  createdIds: readonly string[],
  touchedIds: readonly string[],
  now: Date = new Date(),
): Promise<void> {
  const byId = new Map(layers.map((l) => [l.id, l]));
  const created = createdIds.map((id) => byId.get(id)!).filter(Boolean);
  if (created.length > 0) {
    await tx.insert(inventoryCostLayers).values(
      created.map((l) => ({
        id: l.id,
        warehouseId,
        stockItemId,
        kind: l.kind,
        reason: l.reason,
        qtyIn: l.qtyIn,
        qtyOpen: l.qtyOpen,
        valueOpen: l.valueOpen === null ? null : minorToDecimal(l.valueOpen),
        pendingUnitCost: l.pendingUnitCost,
        pendingCurrency: l.pendingCurrency,
        sourceValuationId: l.sourceValuationId,
        originValuationId: l.originValuationId,
        createdSeq: l.createdSeq,
        closedAt: l.closed ? now : null,
      })),
    );
  }
  for (const id of touchedIds) {
    const l = byId.get(id);
    if (!l) continue;
    await tx
      .update(inventoryCostLayers)
      .set({
        qtyOpen: l.qtyOpen,
        valueOpen: l.valueOpen === null ? null : minorToDecimal(l.valueOpen),
        closedAt: l.closed ? now : null,
      })
      .where(eq(inventoryCostLayers.id, id));
  }
}

export interface CompletionInsert {
  id: string;
  valuationId: string;
  layerId: string | null;
  qty: number;
  value: bigint;
  basis: string;
  eventKey: string;
}

export async function insertCompletions(tx: Tx, rows: readonly CompletionInsert[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(inventoryValuationCompletions).values(
    rows.map((r) => ({ id: r.id, valuationId: r.valuationId, layerId: r.layerId, qty: r.qty, value: minorToDecimal(r.value), basis: r.basis, eventKey: r.eventKey })),
  );
}

/** Збільшує returned_qty оцінок продажу (скільки одиниць уже повернуто). */
export async function addReturnedQty(tx: Tx, valuationId: string, qty: number): Promise<void> {
  if (qty <= 0) return;
  await tx
    .update(inventoryValuations)
    .set({ returnedQty: sql`${inventoryValuations.returnedQty} + ${qty}` })
    .where(eq(inventoryValuations.id, valuationId));
}

export async function loadValuations(db: DbOrTx, ids: readonly string[]): Promise<ValuationRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(inventoryValuations).where(inArray(inventoryValuations.id, [...new Set(ids)]));
}

/** Σ завершень (кількість, вартість) за оцінками виходу. */
export async function completionTotals(db: DbOrTx, valuationIds: readonly string[]): Promise<Map<string, { qty: number; value: bigint; byLayer: Map<string, number> }>> {
  const out = new Map<string, { qty: number; value: bigint; byLayer: Map<string, number> }>();
  if (valuationIds.length === 0) return out;
  const rows = await db
    .select({
      valuationId: inventoryValuationCompletions.valuationId,
      layerId: inventoryValuationCompletions.layerId,
      qty: inventoryValuationCompletions.qty,
      value: inventoryValuationCompletions.value,
    })
    .from(inventoryValuationCompletions)
    .where(inArray(inventoryValuationCompletions.valuationId, [...new Set(valuationIds)]));
  for (const r of rows) {
    const t = out.get(r.valuationId) ?? { qty: 0, value: 0n, byLayer: new Map<string, number>() };
    t.qty += r.qty;
    t.value += toMinor(r.value);
    if (r.layerId) t.byLayer.set(r.layerId, (t.byLayer.get(r.layerId) ?? 0) + r.qty);
    out.set(r.valuationId, t);
  }
  return out;
}

/** Деталі оцінки як запис (jsonb). */
export function detailsOf(v: Pick<ValuationRow, "details">): Record<string, unknown> {
  return (v.details ?? {}) as Record<string, unknown>;
}

export function detailNumber(v: Pick<ValuationRow, "details">, key: string): number {
  const x = detailsOf(v)[key];
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

export function detailMinor(v: Pick<ValuationRow, "details">, key: string): bigint {
  const x = detailsOf(v)[key];
  return typeof x === "string" ? toMinor(x) : 0n;
}

export function detailString(v: Pick<ValuationRow, "details">, key: string): string | null {
  const x = detailsOf(v)[key];
  return typeof x === "string" ? x : null;
}

export function detailList(v: Pick<ValuationRow, "details">, key: string): string[] {
  const x = detailsOf(v)[key];
  return Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : [];
}

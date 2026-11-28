/**
 * Етап 6, WP2: оцінка рухів однієї позиції на складі (docs/stage6-design.md §6.4) — спільне для хука applyMovements,
 * довантаження (backfill) і перебудови демо. ВНУТРІШНІЙ модуль: без перевірки актора; результат — лише записи до
 * проведення й замовлення для syncOrderFinance (гроші не повертаються сторінкам).
 *
 * Порядок: стан пулу блокується FOR UPDATE (після балансів, F10); оцінюються всі рухи позиції з seq > last_seq у порядку
 * seq (якщо стану ще не було — уся історія позиції: вбудоване довантаження). Після кроків — перевірка C0
 * (on_hand = known + unknown − deficit): якщо стан був узгоджений до виклику, а після — ні, це помилка рушія → у тестах
 * виняток; інакше (стан розійшовся раніше — напр. демо-історія змінила баланс напряму, до rebuildValuationForDemo)
 * — розбіжність cost_state_out_of_sync (критична) і запис у журнал.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { inventoryBalances, inventoryMovements } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import { businessDate } from "~/lib/periods";
import { autoResolveDiscrepancy, discrepancyKey, openDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { postEntries, type EntryInput } from "~/modules/finance/core/entries.server";
import { lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";
import { poolOnHand, RETURN_DEFECT_SUFFIX, step, type CostLayer, type PoolState, type StepInputs, type StepMovement, type ValuationEffect } from "./engine";
import {
  loadStockItemInfo,
  movementValueInput,
  saleSourcesFor,
  standardSourcesFor,
  standardUnitFor,
  type CostingContext,
  type StockItemInfo,
} from "./inputs.server";
import { completionCategory, completionEntry, effectEntry } from "./postings";
import {
  addReturnedQty,
  detailString,
  insertCompletions,
  insertValuation,
  loadOpenLayers,
  loadValuations,
  lockCostState,
  persistLayers,
  saveCostState,
  type CompletionInsert,
} from "./store.server";
import { valuationEventKeys } from "~/modules/finance/core/keys";
import type { MovementType } from "~/modules/inventory/movement-types";

export type MovementRow = typeof inventoryMovements.$inferSelect;

/** Запис до проведення від імені виконавця руху. */
export interface PendingEntry {
  actorId: string;
  entry: EntryInput;
}

export interface ValueItemResult {
  entries: PendingEntry[];
  /** Замовлення, чиї фінанси треба синхронізувати (orderId → виконавець). */
  orders: Map<string, string>;
  valued: number;
}

export interface ValueItemOptions {
  /** Явний перелік рухів (перебудова демо: за created_at, seq); інакше — усі з seq > last_seq за seq. */
  movements?: readonly MovementRow[];
  /** Лише розбіжність замість винятку при порушенні C0 (перебудова демо). */
  softC0?: boolean;
  now?: Date;
}

/** Суворий C0 (виняток) — у тестах (Vitest), якщо не вимкнено COSTING_C0_SOFT. */
function strictC0(): boolean {
  return Boolean(process.env.VITEST) && !process.env.COSTING_C0_SOFT;
}

const OUTFLOW_TYPES = new Set(["consume_sale", "material_consume", "defect_mark", "adjustment", "shopify_external", "transfer_out", "opening"]);
const VALUED_RECEIPT_TYPES = new Set(["receipt_production", "receipt_manual", "transfer_in"]);

function toStepMovement(m: MovementRow, item: StockItemInfo): StepMovement {
  return {
    id: m.id,
    seq: Number(m.seq),
    type: m.type as MovementType,
    idempotencyKey: m.idempotencyKey,
    stockKind: item.kind,
    onHandDelta: m.onHandDelta,
    defectiveDelta: m.defectiveDelta,
    orderId: m.orderId,
    orderLineItemId: m.orderLineItemId,
    productionBatchId: m.productionBatchId,
    reason: m.reason,
    occurredOn: businessDate(m.createdAt),
  };
}

async function movementByKey(tx: Tx, key: string, inBatch: readonly MovementRow[]): Promise<MovementRow | null> {
  const found = inBatch.find((x) => x.idempotencyKey === key);
  if (found) return found;
  const [row] = await tx.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, key));
  return row ?? null;
}

async function buildInputs(
  tx: Tx,
  cctx: CostingContext,
  item: StockItemInfo,
  m: MovementRow,
  sm: StepMovement,
  layers: readonly CostLayer[],
  batch: readonly MovementRow[],
): Promise<StepInputs> {
  const inputs: StepInputs = { valuationId: randomUUID(), newId: randomUUID, value: { status: "none" }, standard: null };
  const isReturn = m.type === "receipt_manual" && m.reason === "customer_return";
  if (VALUED_RECEIPT_TYPES.has(m.type) && !isReturn) {
    inputs.value = await movementValueInput(tx, cctx, {
      unitCost: m.unitCost,
      costCurrency: m.costCurrency,
      onHandDelta: m.onHandDelta,
      defectiveDelta: m.defectiveDelta,
      occurredOn: sm.occurredOn,
    });
  }
  const hasOpenUnknown = layers.some((l) => l.kind === "unknown" && l.qtyOpen > 0 && l.reason !== "fx_pending");
  const needsStandard =
    (OUTFLOW_TYPES.has(m.type) && m.onHandDelta < 0 && hasOpenUnknown) ||
    (m.type === "opening" && m.onHandDelta > 0) ||
    (item.kind === "material" && VALUED_RECEIPT_TYPES.has(m.type) && inputs.value.status === "none");
  if (needsStandard) inputs.standard = await standardUnitFor(tx, cctx, item, sm.occurredOn);
  if (isReturn) {
    const pair = await movementByKey(tx, `${m.idempotencyKey}${RETURN_DEFECT_SUFFIX}`, batch);
    const pairedDefectQty = pair && pair.type === "defect_mark" && pair.stockItemId === m.stockItemId ? pair.defectiveDelta : null;
    inputs.returnSources = {
      pairedDefectQty,
      sales: m.orderId ? await saleSourcesFor(tx, m.orderId, item.id) : [],
      standards: m.orderId ? await standardSourcesFor(tx, cctx, m.orderId, item) : [],
    };
  }
  if (m.type === "defect_mark" && m.idempotencyKey.endsWith(RETURN_DEFECT_SUFFIX)) {
    const base = await movementByKey(tx, m.idempotencyKey.slice(0, -RETURN_DEFECT_SUFFIX.length), batch);
    inputs.pairedReturnDefect = Boolean(
      base && base.type === "receipt_manual" && base.reason === "customer_return" && base.stockItemId === m.stockItemId && Number(base.seq) < Number(m.seq),
    );
  }
  return inputs;
}

/**
 * Оцінює рухи позиції (склад, позиція): блокує стан, кроки рушія, збереження, C0. Викликач тримає блокування балансу
 * позиції (applyMovements / lockBalances) — порядок блокувань F10.
 */
export async function valueItemMovements(
  tx: Tx,
  cctx: CostingContext,
  warehouseId: string,
  stockItemId: string,
  opts: ValueItemOptions = {},
): Promise<ValueItemResult> {
  const result: ValueItemResult = { entries: [], orders: new Map(), valued: 0 };
  const { state: initial } = await lockCostState(tx, warehouseId, stockItemId, cctx.valuationCurrency);
  const movements =
    opts.movements ??
    (await tx
      .select()
      .from(inventoryMovements)
      .where(
        and(eq(inventoryMovements.warehouseId, warehouseId), eq(inventoryMovements.stockItemId, stockItemId), gt(inventoryMovements.seq, initial.lastSeq)),
      )
      .orderBy(asc(inventoryMovements.seq)));
  if (movements.length === 0) return result;
  const item = await loadStockItemInfo(tx, stockItemId);
  const [balance] = await tx
    .select({ onHand: inventoryBalances.onHand })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.warehouseId, warehouseId), eq(inventoryBalances.stockItemId, stockItemId)));
  const onHand = balance?.onHand ?? 0;
  const sumDelta = movements.reduce((s, m) => s + m.onHandDelta, 0);
  const preInSync = poolOnHand(initial) === onHand - sumDelta;

  let state: PoolState = initial;
  let layers: CostLayer[] = await loadOpenLayers(tx, warehouseId, stockItemId);
  const now = opts.now ?? new Date();
  for (const m of movements) {
    const sm = toStepMovement(m, item);
    const inputs = await buildInputs(tx, cctx, item, m, sm, layers, movements);
    const r = step(state, layers, sm, inputs);
    if (r.valuation) {
      const d = r.valuation;
      if (r.deficitCompletions.length > 0) d.details.deficitLayers = r.deficitCompletions.map((c) => `${c.layerId}:${c.qty}`).slice(0, 50);
      if (m.productionBatchId) d.details.productionBatchId = m.productionBatchId;
      await insertValuation(tx, {
        draft: d,
        eventKey: valuationEventKeys.movement(m.id),
        warehouseId,
        stockItemId,
        currency: state.currency,
        movementId: m.id,
        movementSeq: Number(m.seq),
        orderId: m.orderId,
        orderLineItemId: m.orderLineItemId,
        occurredOn: sm.occurredOn,
      });
      result.valued += 1;
      if (m.orderId) result.orders.set(m.orderId, m.actorId);
      for (const e of r.effects) {
        result.entries.push({
          actorId: m.actorId,
          entry: effectEntry(e, {
            valuationId: d.id,
            occurredOn: sm.occurredOn,
            currency: state.currency,
            stockItemId,
            variantId: item.variantId,
            quantity: Math.abs(m.onHandDelta) || Math.abs(m.defectiveDelta),
            movementType: m.type,
            productionBatchId: m.productionBatchId,
          }),
        });
      }
    }
    await persistLayers(tx, warehouseId, stockItemId, r.layers, r.createdLayerIds, r.touchedLayerIds, now);
    // Закриття дефіциту входом з вартістю — завершення тих продажів (R3).
    const valuedCompletions = r.deficitCompletions.filter((c) => c.minor !== null && c.saleValuationId !== null);
    if (valuedCompletions.length > 0 && r.valuation) {
      const sales = new Map((await loadValuations(tx, valuedCompletions.map((c) => c.saleValuationId!))).map((v) => [v.id, v]));
      const rows: CompletionInsert[] = [];
      for (const c of valuedCompletions) {
        const sale = sales.get(c.saleValuationId!);
        if (!sale) continue;
        const id = randomUUID();
        rows.push({ id, valuationId: sale.id, layerId: c.layerId, qty: c.qty, value: c.minor!, basis: r.valuation.valueSource, eventKey: `${valuationEventKeys.movement(m.id)}:${c.layerId}` });
        if (sale.orderId) {
          result.orders.set(sale.orderId, m.actorId);
          continue;
        }
        const category = completionCategory((detailString(sale, "effect") ?? "none") as ValuationEffect);
        if (category && c.minor! > 0n) {
          result.entries.push({
            actorId: m.actorId,
            entry: completionEntry({
              completionId: id,
              category,
              minor: c.minor!,
              outflowOn: sale.occurredOn,
              currency: state.currency,
              stockItemId,
              variantId: item.variantId,
              quantity: c.qty,
              saleValuationId: sale.id,
              basis: r.valuation.valueSource,
              lossKind: detailString(sale, "lossKind"),
            }),
          });
        }
      }
      await insertCompletions(tx, rows);
    }
    for (const a of r.returnAllocations) await addReturnedQty(tx, a.saleValuationId, a.knownQty + a.unvaluedQty);
    state = r.state;
    layers = r.layers.filter((l) => l.qtyOpen > 0 && !l.closed);
  }
  await saveCostState(tx, warehouseId, stockItemId, state);
  await checkC0(tx, warehouseId, stockItemId, state, onHand, preInSync, opts.softC0 === true);
  return result;
}

/** C0 після оцінки (див. вгорі файла). */
async function checkC0(tx: Tx, warehouseId: string, stockItemId: string, state: PoolState, onHand: number, preInSync: boolean, soft: boolean): Promise<void> {
  const pool = poolOnHand(state);
  if (pool === onHand) {
    // Стан знову узгоджений (напр. після rebuildValuationForDemo) — відкрита розбіжність цієї позиції закривається.
    if (!preInSync || soft) await autoResolveDiscrepancy(tx, SYSTEM_ACTOR, discrepancyKey("cost_state_out_of_sync", warehouseId, stockItemId));
    return;
  }
  if (preInSync && !soft && strictC0()) {
    throw new Error(`C0 violated for stock item ${stockItemId}: on_hand ${onHand} ≠ known + unknown − deficit ${pool}`);
  }
  logger.warn("costing.cost_state_out_of_sync", { stockItemId, warehouseId, onHand, pool, preInSync });
  await openDiscrepancy(tx, SYSTEM_ACTOR, {
    type: "cost_state_out_of_sync",
    dedupeKey: discrepancyKey("cost_state_out_of_sync", warehouseId, stockItemId),
    details: { stockItemId, warehouseId, onHand, poolOnHand: pool },
    reopen: true,
  });
}

/** Позиції (склад, позиція) рухів — у порядку блокувань ledger (stock_item_id, warehouse_id). */
export function itemPairsInLockOrder<T extends { warehouseId: string; stockItemId: string }>(rows: readonly T[]): Array<{ warehouseId: string; stockItemId: string }> {
  const seen = new Map<string, { warehouseId: string; stockItemId: string }>();
  for (const r of rows) seen.set(`${r.warehouseId}|${r.stockItemId}`, { warehouseId: r.warehouseId, stockItemId: r.stockItemId });
  return [...seen.values()].sort((a, b) =>
    a.stockItemId === b.stockItemId ? a.warehouseId.localeCompare(b.warehouseId) : a.stockItemId.localeCompare(b.stockItemId),
  );
}

/** Проводить записи (групами за виконавцем) і синхронізує фінанси замовлень (у порядку order_id). */
export async function flushValuationResults(tx: Tx, results: readonly ValueItemResult[]): Promise<void> {
  const byActor = new Map<string, EntryInput[]>();
  for (const r of results) for (const e of r.entries) byActor.set(e.actorId, [...(byActor.get(e.actorId) ?? []), e.entry]);
  for (const [actorId, entries] of [...byActor].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    await postEntries(tx, { id: actorId }, entries);
  }
  const orders = new Map<string, string>();
  for (const r of results) for (const [o, a] of r.orders) orders.set(o, a);
  if (orders.size === 0) return;
  // FINO усіх замовлень — одним упорядкованим набором ДО першої синхронізації (WP4 syncOrderFinanceMany, §17.8):
  // синхронізація ставить/утримує завдання перерахунку розподілу останнім записом (рядок jobs до фіксації).
  await lockFinanceOrders(tx, [...orders.keys()]);
  for (const orderId of [...orders.keys()].sort()) await syncOrderFinance(tx, { id: orders.get(orderId)! }, orderId);
}

/** Id рухів → (склад, позиція), для перевірок. */
export async function movementsByIds(tx: Tx, ids: readonly string[]): Promise<MovementRow[]> {
  if (ids.length === 0) return [];
  return tx.select().from(inventoryMovements).where(inArray(inventoryMovements.id, [...ids]));
}

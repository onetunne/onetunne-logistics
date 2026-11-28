/**
 * Етап 6, WP2: завершення шарів fx_pending, коли з'явився курс (docs/stage6-design.md §6.3 «Валюта надходження»).
 * Викликають: WP1 після збереження ручного курсу (у тій самій транзакції), завдання finance.valuation_pending
 * (costing/jobs.server.ts). Курс — лише rateFor (§5.4) на дату руху надходження; вартість V = unit_cost × (якісні + брак)
 * руху (original_amount оцінки), конвертована одним округленням. Залишок шару → відомі (спершу закриває дефіцит);
 * уже витрачені одиниці → завершення продажів датою продажу (R3; закритий місяць → пізній запис ядра).
 * Довідковий запис «Виготовлено / Закуплено» проводиться датою надходження (val:<оцінка>:fxmemo). Для надходження з
 * партії після завершення — revalueBatchLines (ціль партії могла змінитися, поки чекали курс).
 * ВНУТРІШНЯ функція (INTERNAL_POSTING_FUNCTIONS): актора не перевіряє, результат — лише кількість.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { inventoryCostLayers, inventoryMovements, inventoryValuations } from "~/db/schema";
import { toMinor } from "~/lib/money";
import { businessDate } from "~/lib/periods";
import type { CompleteFxPendingLayers, PostingActor } from "~/modules/finance/core/contracts";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys, valuationEventKeys } from "~/modules/finance/core/keys";
import { lockBalances } from "~/modules/inventory/ledger.server";
import { applyCompletionPlan, planLayerValueCompletion } from "./completion.server";
import { averageUnit, minorToDecimal } from "./engine";
import { convertToValuation, loadCostingContext, loadStockItemInfo, type CostingContext, type StockItemInfo } from "./inputs.server";
import { detailString, insertValuation, layerFromRow, lockCostState, saveCostState, type ValuationRow } from "./store.server";
import { flushValuationResults, itemPairsInLockOrder, type ValueItemResult } from "./valuation.server";
import { revalueBatchLinesInternal } from "./revalue.server";

type LayerRow = typeof inventoryCostLayers.$inferSelect;

export const completeFxPendingLayers: CompleteFxPendingLayers = async (
  tx: Tx,
  actor: PostingActor,
  scope: { currency?: string; date?: string },
): Promise<{ completed: number }> => {
  const candidates = await tx
    .select({ layer: inventoryCostLayers, origin: inventoryValuations })
    .from(inventoryCostLayers)
    .innerJoin(inventoryValuations, eq(inventoryValuations.id, inventoryCostLayers.originValuationId))
    .where(
      and(
        eq(inventoryCostLayers.reason, "fx_pending"),
        isNull(inventoryCostLayers.closedAt),
        scope.currency ? eq(inventoryCostLayers.pendingCurrency, scope.currency) : undefined,
        scope.date ? eq(inventoryValuations.occurredOn, scope.date) : undefined,
      ),
    )
    .orderBy(asc(inventoryCostLayers.stockItemId), asc(inventoryCostLayers.createdSeq));
  if (candidates.length === 0) return { completed: 0 };
  const cctx = await loadCostingContext(tx);
  const today = businessDate(new Date());
  // Партії надходжень, що завершуються (після завершення — переоцінка партії, revalueBatchLines).
  const batchIds = [
    ...new Set(
      candidates
        .filter((c) => detailString(c.origin, "movementType") === "receipt_production")
        .map((c) => detailString(c.origin, "productionBatchId"))
        .filter((x): x is string => Boolean(x)),
    ),
  ].sort();
  // Порядок блокувань (F10, §17.8): баланси ВСІХ позицій, яких торкнуться і завершення, і переоцінка партій, — одним
  // викликом lockBalances у порядку stock_item_id ДО будь-якого стану собівартості й фінансів замовлень. Інакше
  // переоцінка партії взяла б баланси позицій з меншим stock_item_id після вже взятих — взаємоблокування з будь-якою
  // впорядкованою транзакцією (applyMovements, updateBatchCosts).
  const batchPairs = batchIds.length
    ? await tx
        .selectDistinct({ warehouseId: inventoryMovements.warehouseId, stockItemId: inventoryMovements.stockItemId })
        .from(inventoryMovements)
        .where(and(inArray(inventoryMovements.productionBatchId, batchIds), eq(inventoryMovements.type, "receipt_production")))
    : [];
  const pairs = itemPairsInLockOrder(candidates.map((c) => c.layer));
  await lockBalances(tx, [...pairs, ...batchPairs]);
  const results: ValueItemResult[] = [];
  const batches = new Set<string>();
  let completed = 0;
  for (const pair of pairs) {
    const item = await loadStockItemInfo(tx, pair.stockItemId);
    for (const c of candidates.filter((x) => x.layer.stockItemId === pair.stockItemId && x.layer.warehouseId === pair.warehouseId)) {
      if (!c.origin.originalAmount || !c.origin.originalCurrency) continue;
      const conv = await convertToValuation(tx, cctx, toMinor(c.origin.originalAmount), c.origin.originalCurrency, c.origin.occurredOn);
      if (!conv.ok) continue;
      // Свіжий рядок шару (попередні завершення в цьому виклику могли його змінити).
      const [fresh] = await tx.select().from(inventoryCostLayers).where(eq(inventoryCostLayers.id, c.layer.id));
      if (!fresh || fresh.closedAt !== null) continue;
      const movementType = detailString(c.origin, "movementType");
      const batchId = detailString(c.origin, "productionBatchId");
      const common = {
        originValuationId: c.origin.id,
        ...(c.origin.movementId ? { receiptMovementId: c.origin.movementId } : {}),
        ...(batchId ? { productionBatchId: batchId } : {}),
        // Повна вартість надходження (залишок + уже продане) — «проведена вартість» для пізнішої переоцінки партії.
        deltaTotal: minorToDecimal(conv.minor),
        rateDate: conv.rateDate,
        rateSource: conv.rateSource,
        originalAmount: c.origin.originalAmount,
        originalCurrency: c.origin.originalCurrency,
      };
      const res =
        c.origin.qty === 0
          ? await completeDefectOnlyReceipt(tx, cctx, pair.warehouseId, item, fresh, c.origin, conv.minor, { actorId: actor.id, today, details: common })
          : await completeLayer(tx, cctx, pair.warehouseId, item, fresh, c.origin, conv.minor, { actorId: actor.id, today, details: common, movementType });
      await tx.update(inventoryCostLayers).set({ closedAt: new Date() }).where(eq(inventoryCostLayers.id, fresh.id));
      results.push(res);
      completed += 1;
      if (movementType === "receipt_production" && batchId) batches.add(batchId);
    }
  }
  // Переоцінка партій (ціль могла змінитися, поки чекали курс) — баланси вже взято вище, у порядку.
  for (const batchId of [...batches].sort()) await revalueBatchLinesInternal(tx, actor, batchId);
  await flushValuationResults(tx, results);
  return { completed };
};

interface CompleteOpts {
  actorId: string;
  today: string;
  details: Record<string, string | number | boolean | null>;
  movementType?: string | null;
}

/** Шар з якісними одиницями: залишок → відомі (спершу закриває дефіцит), уже продане → завершення продажів (R3). */
async function completeLayer(
  tx: Tx,
  cctx: CostingContext,
  warehouseId: string,
  item: StockItemInfo,
  fresh: LayerRow,
  origin: ValuationRow,
  value: bigint,
  opts: CompleteOpts,
): Promise<ValueItemResult> {
  const layer = layerFromRow(fresh);
  const plan = await planLayerValueCompletion(tx, layer, item.id, value, { currency: cctx.valuationCurrency });
  const res = await applyCompletionPlan(tx, cctx, warehouseId, item, plan, {
    eventKey: valuationEventKeys.fxPending(layer.id),
    occurredOn: opts.today,
    basis: "movement_cost",
    actorId: opts.actorId,
    details: opts.details,
    forceStockValuation: true,
  });
  // Довідковий запис вартості надходження (датою надходження, R3).
  if (value > 0n) res.entries.push({ actorId: opts.actorId, entry: memoEntry(cctx, item, origin, value, fresh.qtyIn, opts.movementType ?? null) });
  return res;
}

/**
 * Надходження лише з браком (g = 0, §6.3), що чекало курсу: вартість V — у пул, якщо в ньому є відомі одиниці (+ довідковий
 * запис), інакше inventory_loss (details.kind = production_defect) датою надходження. Оцінка stock_completion з
 * кількістю 0 фіксує, куди пішла вартість (effect), — для пізнішої переоцінки партії.
 */
async function completeDefectOnlyReceipt(
  tx: Tx,
  cctx: CostingContext,
  warehouseId: string,
  item: StockItemInfo,
  fresh: LayerRow,
  origin: ValuationRow,
  value: bigint,
  opts: CompleteOpts,
): Promise<ValueItemResult> {
  const res: ValueItemResult = { entries: [], orders: new Map(), valued: 0 };
  const { state } = await lockCostState(tx, warehouseId, item.id, cctx.valuationCurrency);
  const toPool = state.knownQty > 0;
  if (toPool) {
    state.knownValue += value;
    state.lastAvgUnit = averageUnit(state.knownValue, state.knownQty);
  }
  const valuationId = randomUUID();
  await insertValuation(tx, {
    draft: {
      id: valuationId,
      kind: "stock_completion",
      qty: 0,
      knownQty: 0,
      unknownQty: 0,
      deficitQty: 0,
      value,
      valueSource: "movement_cost",
      drawnLayers: [],
      originalAmount: null,
      originalCurrency: null,
      rateDate: null,
      rateSource: null,
      after: { knownQty: state.knownQty, knownValue: state.knownValue, unknownQty: state.unknownQty, deficitQty: state.deficitQty },
      details: { basis: "movement_cost", layers: [], defectOnly: true, effect: toPool ? "none" : "loss", ...opts.details },
    },
    eventKey: valuationEventKeys.fxPending(fresh.id),
    warehouseId,
    stockItemId: item.id,
    currency: state.currency,
    movementId: null,
    movementSeq: null,
    orderId: null,
    orderLineItemId: null,
    occurredOn: opts.today,
  });
  await saveCostState(tx, warehouseId, item.id, state);
  res.valued = 1;
  if (value <= 0n) return res;
  if (toPool) {
    res.entries.push({ actorId: opts.actorId, entry: memoEntry(cctx, item, origin, value, fresh.qtyIn, detailString(origin, "movementType")) });
  } else {
    res.entries.push({
      actorId: opts.actorId,
      entry: {
        idempotencyKey: financeKeys.valuation(origin.id, "fxloss"),
        category: "inventory_loss",
        recognizedOn: origin.occurredOn,
        fxOn: origin.occurredOn,
        isLateCompletion: true,
        amount: minorToDecimal(-value),
        currency: cctx.valuationCurrency,
        stockItemId: item.id,
        variantId: item.variantId,
        quantity: fresh.qtyIn,
        sourceType: "valuation",
        sourceId: valuationId,
        details: { kind: "production_defect", movementType: detailString(origin, "movementType") ?? "receipt_production", fxCompleted: true },
      },
    });
  }
  return res;
}

/** «Виготовлено / Закуплено» (довідково) — датою надходження, ключ val:<оцінка надходження>:fxmemo. */
function memoEntry(cctx: CostingContext, item: StockItemInfo, origin: ValuationRow, value: bigint, qty: number, movementType: string | null): EntryInput {
  return {
    idempotencyKey: financeKeys.valuation(origin.id, "fxmemo"),
    category: item.kind === "material" ? "materials_purchased_memo" : "production_capitalized_memo",
    recognizedOn: origin.occurredOn,
    fxOn: origin.occurredOn,
    isLateCompletion: true,
    amount: minorToDecimal(value),
    currency: cctx.valuationCurrency,
    stockItemId: item.id,
    variantId: item.variantId,
    quantity: qty,
    sourceType: "valuation",
    sourceId: origin.id,
    details: { source: movementType === "receipt_production" ? "production" : "purchase", fxCompleted: true },
  };
}

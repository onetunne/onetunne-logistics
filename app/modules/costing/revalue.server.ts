/**
 * Етап 6, WP2: переоцінка рядків партії після зміни собівартості (docs/stage6-design.md §6.7). Викликають
 * updateBatchCosts / closeBatch / cancelBatch (production/batches.server.ts) і завершення fx_pending.
 * ВНУТРІШНЯ функція (INTERNAL_POSTING_FUNCTIONS): актора не перевіряє (закриття партії — делегований production.manage),
 * нічого не повертає; сторінки/маршрути/команди/ШІ її не імпортують (тест-сканер).
 *
 * Для кожного руху надходження партії: Δ = ціль − (проведена вартість + попередні коригування) → частка на закриті
 * дефіцити (до продажів), частка, що лишилася на складі (r з історії виходів, Δ_stock — у пул), решта за видами виходів:
 * продажі → cogs_adjustment, втрати → inventory_loss — записи ПЕРІОДУ датою зміни (R6) з stock_item_id і номером партії,
 * ключ adj:<movementId>:v<n>:<частина>; оцінка `adj:<movementId>:v<n>` (revaluation). Надходження без ціни — завершення
 * його невідомого шару вартістю партії (залишок → у пул, уже продане → завершення продажів, R3). Рядки, що чекають курсу
 * (fx_pending, або немає курсу для цілі), пропускаються — коригування чекає курсу. Минулі звіти не змінюються.
 * Блокування: рядок партії (викликач) → баланси позицій (lockBalances) → стан собівартості; рядків замовлень — ніколи (F10).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryCostLayers,
  inventoryMovements,
  inventoryValuations,
  orders,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
} from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { toMinor } from "~/lib/money";
import { businessDate } from "~/lib/periods";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import type { PostingActor, RevalueBatchLines } from "~/modules/finance/core/contracts";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys, valuationEventKeys } from "~/modules/finance/core/keys";
import { inventoryKeys } from "~/modules/inventory/keys";
import { lockBalances } from "~/modules/inventory/ledger.server";
import { batchCostSummary } from "~/modules/production/calc";
import { applyCompletionPlan, planLayerValueCompletion } from "./completion.server";
import { allocateQ, averageUnit, currencyQuantum, minorToDecimal } from "./engine";
import { convertToValuation, loadCostingContext, loadStockItemInfo } from "./inputs.server";
import { splitRevaluation, type OutflowBucket, type PoolOutflow } from "./revalue-calc";
import { detailList, detailMinor, detailNumber, detailString, insertValuation, layerFromRow, lockCostState, saveCostState, type ValuationRow } from "./store.server";
import { flushValuationResults, itemPairsInLockOrder, valueItemMovements, type ValueItemResult } from "./valuation.server";

export const revalueBatchLines: RevalueBatchLines = (tx: Tx, actor: PostingActor, batchId: string): Promise<void> =>
  revalueBatchLinesInternal(tx, actor, batchId);

export interface ReceiptTarget {
  movementId: string;
  warehouseId: string;
  stockItemId: string;
  batchLineId: string;
  occurredOn: string;
  /** Ціль у валюті партії (мінорні одиниці). */
  target: bigint;
}

/** Підсумок переоцінки рядка (для історії змін). */
interface LineDelta {
  deltaStock: bigint;
  deltaSales: bigint;
}

/** Вид виходу для розподілу Δ (продажі → cogs_adjustment, решта → inventory_loss). */
function bucketOf(v: ValuationRow, testOrders: ReadonlySet<string>): OutflowBucket {
  const type = detailString(v, "movementType");
  if (type === "consume_sale" && v.orderId && !testOrders.has(v.orderId)) return "sales";
  return "loss";
}

type BatchRow = typeof productionBatches.$inferSelect;

/**
 * Ціль кожного руху надходження партії (§6.7 п. 1): ціль рядка = batchCostSummary().lines[].producedValue (unit_cost ×
 * produced + частка extra), поділена між надходженнями рядка allocateMinor за кількістю (якісні + брак), — у валюті
 * партії. ВНУТРІШНЄ читання (для переоцінки й «еквівалента у валюті оцінки» сторінки, що вже перевірила finance.view).
 */
export async function batchReceiptTargets(tx: DbOrTx, batch: BatchRow): Promise<{ currency: string | null; targets: ReceiptTarget[] }> {
  const lines = await tx.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batch.id)).orderBy(asc(productionBatchLines.id));
  if (lines.length === 0) return { currency: null, targets: [] };
  const summary = batchCostSummary(
    lines.map((l) => ({ id: l.id, ordered: l.quantityOrdered, received: l.quantityReceived, defective: l.quantityDefective, unitCost: l.unitCost, costCurrency: l.costCurrency })),
    batch.extraCost,
    batch.costCurrency,
    batch.status,
  );
  const currency = summary.currency;
  if (currency === null) return { currency: null, targets: [] };
  const receiptLines = await tx
    .select({ id: productionReceiptLines.id, batchLineId: productionReceiptLines.batchLineId, good: productionReceiptLines.goodQty, defective: productionReceiptLines.defectiveQty })
    .from(productionReceiptLines)
    .where(inArray(productionReceiptLines.batchLineId, lines.map((l) => l.id)))
    .orderBy(asc(productionReceiptLines.id));
  if (receiptLines.length === 0) return { currency, targets: [] };
  const keys = receiptLines.map((r) => inventoryKeys.productionReceipt(r.id));
  const movements = await tx.select().from(inventoryMovements).where(inArray(inventoryMovements.idempotencyKey, keys));
  const movementByKey = new Map(movements.map((m) => [m.idempotencyKey, m]));
  const targets: ReceiptTarget[] = [];
  for (const line of summary.lines) {
    if (line.producedValue === null) continue;
    const own = receiptLines
      .map((r) => ({ r, m: movementByKey.get(inventoryKeys.productionReceipt(r.id)) }))
      .filter((x): x is { r: (typeof receiptLines)[number]; m: NonNullable<typeof x.m> } => x.r.batchLineId === line.id && Boolean(x.m));
    const weights = own.map((x) => BigInt(x.r.good + x.r.defective));
    if (weights.length === 0 || weights.every((w) => w === 0n)) continue;
    const parts = allocateQ(toMinor(line.producedValue), weights, currencyQuantum(currency));
    own.forEach((x, i) =>
      targets.push({
        movementId: x.m.id,
        warehouseId: x.m.warehouseId,
        stockItemId: x.m.stockItemId,
        batchLineId: line.id,
        occurredOn: businessDate(x.m.createdAt),
        target: parts[i]!,
      }),
    );
  }
  return { currency, targets };
}

/**
 * Реалізація з необов'язковим записом історії змін (batch_cost: Δ до залишку / до продажів за рядком) — changeActor
 * передає updateBatchCosts (власник). Без грошей у результаті.
 */
export async function revalueBatchLinesInternal(
  tx: Tx,
  actor: PostingActor,
  batchId: string,
  opts: { changeActor?: Pick<Actor, "id" | "role">; now?: Date } = {},
): Promise<void> {
  const [batch] = await tx.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  if (!batch || !batch.costCurrency) return;
  const { targets } = await batchReceiptTargets(tx, batch);
  if (targets.length === 0) return;
  const cctx = await loadCostingContext(tx);
  const now = opts.now ?? new Date();
  const today = businessDate(now);
  const results: ValueItemResult[] = [];
  const lineDeltas = new Map<string, LineDelta>();
  const addLine = (lineId: string, d: Partial<LineDelta>) => {
    const t = lineDeltas.get(lineId) ?? { deltaStock: 0n, deltaSales: 0n };
    t.deltaStock += d.deltaStock ?? 0n;
    t.deltaSales += d.deltaSales ?? 0n;
    lineDeltas.set(lineId, t);
  };
  const pairs = itemPairsInLockOrder(targets);
  await lockBalances(tx, pairs);
  for (const pair of pairs) {
    // Неоцінені рухи позиції (довантаження) — до переоцінки.
    results.push(await valueItemMovements(tx, cctx, pair.warehouseId, pair.stockItemId));
    const item = await loadStockItemInfo(tx, pair.stockItemId);
    for (const t of targets.filter((x) => x.stockItemId === pair.stockItemId && x.warehouseId === pair.warehouseId)) {
      const [mv] = await tx.select().from(inventoryValuations).where(eq(inventoryValuations.eventKey, valuationEventKeys.movement(t.movementId)));
      if (!mv) continue;
      const converted = await convertToValuation(tx, cctx, t.target, batch.costCurrency, t.occurredOn);
      if (!converted.ok) continue; // чекає курсу
      const target = converted.minor;
      const prior = await tx
        .select()
        .from(inventoryValuations)
        .where(
          and(
            sql`${inventoryValuations.details}->>'receiptMovementId' = ${t.movementId}`,
            inArray(inventoryValuations.kind, ["revaluation", "stock_completion"]),
          ),
        );
      const n = prior.filter((p) => p.eventKey.startsWith("adj:")).length + 1;
      const recognized = (mv.value === null ? 0n : toMinor(mv.value)) + prior.reduce((s, p) => s + detailMinor(p, "deltaTotal"), 0n);
      const delta = target - recognized;
      if (delta === 0n) continue;
      const eventKey = valuationEventKeys.adjustment(t.movementId, n);
      const baseDetails = { receiptMovementId: t.movementId, productionBatchId: batch.id, batchLineId: t.batchLineId, batchNumber: batch.number, version: n };

      // База розподілу Δ: надходження з вартістю — його якісні одиниці (і закриті ним дефіцити) від seq надходження;
      // надходження без вартості, уже завершене (курсом fx або попереднім коригуванням партії), — від seq завершення:
      // у пул тоді увійшли лише одиниці, що лишалися на складі, решта (продані до завершення) — як «до продажів».
      let base: { goodQty: number; deficitClosedQty: number; startSeq: number } | null =
        mv.value !== null ? { goodQty: mv.knownQty, deficitClosedQty: detailNumber(mv, "deficitClosedQty"), startSeq: mv.seq } : null;
      if (mv.value === null) {
        // Надходження без вартості: fx_pending чекає курсу; receipt_without_cost — завершення шару вартістю партії.
        const [layerRow] = await tx.select().from(inventoryCostLayers).where(eq(inventoryCostLayers.originValuationId, mv.id));
        if (!layerRow) continue;
        const completion = prior.filter((p) => p.kind === "stock_completion").sort((a, b) => a.seq - b.seq)[0];
        if (completion) {
          const pooled = detailList(completion, "layers")
            .map((x) => x.split(":"))
            .filter((x) => x[0] === layerRow.id)
            .reduce((sum, x) => sum + Number(x[1] ?? 0), 0);
          base = { goodQty: mv.qty, deficitClosedQty: Math.max(0, mv.qty - pooled), startSeq: completion.seq };
        } else if (layerRow.reason === "fx_pending") {
          continue; // чекає курсу (fx-pending.server.ts викличе переоцінку після завершення)
        }
      }
      if (mv.value === null && !base) {
        const [layerRow] = await tx.select().from(inventoryCostLayers).where(eq(inventoryCostLayers.originValuationId, mv.id));
        const layer = layerFromRow(layerRow!);
        const extraDeficits = detailList(mv, "deficitLayers")
          .map((s) => s.split(":"))
          .filter((p) => p.length === 2)
          .map(([layerId, qty]) => ({ layerId: layerId!, qty: Number(qty) }));
        const deficitLayers = extraDeficits.length
          ? await tx.select().from(inventoryCostLayers).where(inArray(inventoryCostLayers.id, extraDeficits.map((d) => d.layerId)))
          : [];
        const originOf = new Map(deficitLayers.map((d) => [d.id, d.originValuationId]));
        const plan = await planLayerValueCompletion(tx, layer, pair.stockItemId, target, {
          currency: cctx.valuationCurrency,
          extraDeficits: extraDeficits
            .filter((d) => originOf.get(d.layerId))
            .map((d) => ({ layerId: d.layerId, saleValuationId: originOf.get(d.layerId)!, qty: d.qty })),
          totalUnits: layer.qtyIn + extraDeficits.reduce((s, d) => s + d.qty, 0),
        });
        const res = await applyCompletionPlan(tx, cctx, pair.warehouseId, item, plan, {
          eventKey,
          occurredOn: today,
          basis: "batch",
          actorId: actor.id,
          details: { ...baseDetails, deltaTotal: minorToDecimal(delta), completion: true },
          forceStockValuation: true,
          now,
        });
        await tx.update(inventoryCostLayers).set({ closedAt: now }).where(eq(inventoryCostLayers.id, layer.id));
        results.push(res);
        addLine(t.batchLineId, {
          deltaStock: plan.stock.reduce((s, p) => s + p.value, 0n),
          deltaSales: plan.sales.reduce((s, p) => s + p.value, 0n),
        });
        continue;
      }

      const { state } = await lockCostState(tx, pair.warehouseId, pair.stockItemId, cctx.valuationCurrency);
      const after = await tx
        .select()
        .from(inventoryValuations)
        .where(
          and(
            eq(inventoryValuations.warehouseId, pair.warehouseId),
            eq(inventoryValuations.stockItemId, pair.stockItemId),
            eq(inventoryValuations.kind, "outflow"),
            gt(inventoryValuations.seq, base!.startSeq),
          ),
        )
        .orderBy(asc(inventoryValuations.seq));
      const orderIds = [...new Set(after.map((a) => a.orderId).filter((x): x is string => Boolean(x)))];
      const testOrders = new Set<string>();
      if (orderIds.length > 0 && !cctx.includeTestOrders) {
        const rows = await tx.select({ id: orders.id }).from(orders).where(and(inArray(orders.id, orderIds), eq(orders.shopifyTest, true)));
        for (const r of rows) testOrders.add(r.id);
      }
      const outflows: PoolOutflow[] = after
        .filter((a) => detailNumber(a, "poolQty") > 0 && a.knownQtyAfter !== null && (a.details as Record<string, unknown>)?.pairedReturnDefect !== true)
        .map((a) => ({ knownBefore: a.knownQtyAfter! + detailNumber(a, "poolQty"), knownAfter: a.knownQtyAfter!, bucket: bucketOf(a, testOrders) }));
      // Надходження лише з браком, визнане збитком (порожній пул): під час руху або під час завершення курсом.
      const fxCompletion = prior.filter((p) => p.kind === "stock_completion").sort((a, b) => a.seq - b.seq)[0];
      const allDefectLoss = mv.qty === 0 && (detailString(mv, "effect") === "loss" || (fxCompletion !== undefined && detailString(fxCompletion, "effect") === "loss"));
      const split = allDefectLoss
        ? { deltaDeficit: 0n, deltaStock: 0n, buckets: { sales: 0n, loss: delta } }
        : splitRevaluation({
            delta,
            goodQty: base!.goodQty,
            deficitClosedQty: base!.deficitClosedQty,
            outflows,
            currentKnownQty: state.knownQty,
            currentKnownValue: state.knownValue,
            quantum: currencyQuantum(state.currency),
          });
      state.knownValue += split.deltaStock;
      if (state.knownQty > 0) state.lastAvgUnit = averageUnit(state.knownValue, state.knownQty);
      const valuationId = randomUUID();
      await insertValuation(tx, {
        draft: {
          id: valuationId,
          kind: "revaluation",
          qty: 0,
          knownQty: 0,
          unknownQty: 0,
          deficitQty: 0,
          value: delta,
          valueSource: "batch",
          drawnLayers: [],
          originalAmount: null,
          originalCurrency: null,
          rateDate: converted.rateDate,
          rateSource: converted.rateSource,
          after: { knownQty: state.knownQty, knownValue: state.knownValue, unknownQty: state.unknownQty, deficitQty: state.deficitQty },
          details: {
            ...baseDetails,
            deltaTotal: minorToDecimal(delta),
            deltaStock: minorToDecimal(split.deltaStock),
            deltaSales: minorToDecimal(split.buckets.sales),
            deltaLoss: minorToDecimal(split.buckets.loss),
            deltaDeficit: minorToDecimal(split.deltaDeficit),
          },
        },
        eventKey,
        warehouseId: pair.warehouseId,
        stockItemId: pair.stockItemId,
        currency: state.currency,
        movementId: null,
        movementSeq: null,
        orderId: null,
        orderLineItemId: null,
        occurredOn: today,
      });
      await saveCostState(tx, pair.warehouseId, pair.stockItemId, state);
      const entries: EntryInput[] = [];
      const common = {
        recognizedOn: today,
        fxOn: today,
        currency: state.currency,
        stockItemId: pair.stockItemId,
        variantId: item.variantId,
        sourceType: "cost_adjustment" as const,
        sourceId: valuationId,
        details: { kind: "batch_adjustment", productionBatchId: batch.id, batchNumber: batch.number },
      };
      if (split.buckets.sales !== 0n) {
        entries.push({ ...common, idempotencyKey: financeKeys.batchAdjustment(t.movementId, n, "sales"), category: "cogs_adjustment", amount: minorToDecimal(-split.buckets.sales) });
      }
      if (split.buckets.loss !== 0n) {
        entries.push({ ...common, idempotencyKey: financeKeys.batchAdjustment(t.movementId, n, "loss"), category: "inventory_loss", amount: minorToDecimal(-split.buckets.loss) });
      }
      results.push({ entries: entries.map((entry) => ({ actorId: actor.id, entry })), orders: new Map(), valued: 1 });
      addLine(t.batchLineId, { deltaStock: split.deltaStock, deltaSales: split.buckets.sales + split.buckets.loss });
    }
  }
  await flushValuationResults(tx, results);
  if (opts.changeActor) {
    for (const [lineId, d] of [...lineDeltas].sort(([a], [b]) => (a < b ? -1 : 1))) {
      await writeFinanceChange(tx, opts.changeActor, {
        entityType: "batch_cost",
        entityId: batch.id,
        action: "update",
        after: { batchId: batch.id, batchLineId: lineId, currency: cctx.valuationCurrency, deltaStock: minorToDecimal(d.deltaStock), deltaSales: minorToDecimal(d.deltaSales), version: batch.version },
      });
    }
  }
}

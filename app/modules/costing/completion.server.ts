/**
 * Етап 6, WP2: завершення невідомої вартості (docs/stage6-design.md §6.2, §6.3, §6.6) — спільне для:
 * - ручної собівартості власника «до залишку» (відкриті невідомі шари → відомі, датою збереження) і «до вже проданих»
 *   (витрати невідомих шарів виходами з датою ≥ effective_from → завершення тих продажів датою руху, R3);
 * - курсу, що з'явився для шару fx_pending (fx-pending.server.ts);
 * - собівартості партії, що з'явилася для надходження без ціни (revalue.server.ts).
 * Частка одиниць, які вже повернулися шаром return_without_cost, завершує ЦЕЙ шар (вартість іде в пул), а не
 * собівартість продажу. ВНУТРІШНІЙ модуль (без перевірки актора; гроші сторінкам не повертає).
 *
 * Обмеження (документовано): одиниці не розрізняються — повернені «без вартості» одиниці продажу приписуються шару, що
 * завершується першим (сума за продажем і пулом зберігається точно).
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { inventoryBalances, inventoryCostLayers, inventoryValuations } from "~/db/schema";
import type { ValuationValueSource } from "~/domain/finance";
import { valuationEventKeys } from "~/modules/finance/core/keys";
import { allocateQ, averageUnit, cumulativeShares, currencyQuantum, minorToDecimal, poolOnHand, type CostLayer, type PoolState, type ValuationEffect } from "./engine";
import type { CostingContext, StockItemInfo } from "./inputs.server";
import { completionCategory, completionEntry } from "./postings";
import {
  completionTotals,
  detailString,
  insertCompletions,
  insertValuation,
  layerFromRow,
  loadOpenLayers,
  loadValuations,
  lockCostState,
  persistLayers,
  saveCostState,
  type CompletionInsert,
  type ValuationRow,
} from "./store.server";
import type { ValueItemResult } from "./valuation.server";

/** Частина плану: відкриті одиниці шару → пул. */
export interface StockPart {
  layerId: string;
  qty: number;
  value: bigint;
}

/** Частина плану: одиниці, які вихід `sale` взяв із шару `layerId` без вартості, → завершення продажу. */
export interface SalePart {
  sale: ValuationRow;
  layerId: string;
  qty: number;
  value: bigint;
}

export interface CompletionPlan {
  stock: StockPart[];
  sales: SalePart[];
}

export interface ApplyPlanInput {
  /** Ключ події частини «у пул» (complete:<op>:<item> / fx:<layer> / adj:<movement>:v<n>); продажі — `<ключ>:<saleId>`. */
  eventKey: string;
  /** Дата частини «у пул». */
  occurredOn: string;
  basis: ValuationValueSource;
  actorId: string;
  /** Додаткові поля деталей оцінки «у пул» (напр. deltaTotal коригування партії). */
  details?: Record<string, string | number | boolean | null | string[]>;
  /** Створити оцінку «у пул» навіть без одиниць (носій деталей коригування). */
  forceStockValuation?: boolean;
  now?: Date;
}

/** Виходи позиції, що брали одиниці шару без вартості (drawn_layers). */
export async function outflowsDrawingLayer(tx: Tx, stockItemId: string, layerId: string): Promise<ValuationRow[]> {
  return tx
    .select()
    .from(inventoryValuations)
    .where(
      and(
        eq(inventoryValuations.stockItemId, stockItemId),
        eq(inventoryValuations.kind, "outflow"),
        sql`${inventoryValuations.drawnLayers} @> ${JSON.stringify([{ layerId }])}::jsonb`,
      ),
    )
    .orderBy(asc(inventoryValuations.seq));
}

/** Скільки одиниць кожного виходу повернулося шаром return_without_cost (Σ qty_in шарів з source_valuation_id). */
export async function returnedUnvaluedBySale(tx: DbOrTx, saleIds: readonly string[]): Promise<Map<string, { qtyIn: number; open: CostLayer[] }>> {
  const out = new Map<string, { qtyIn: number; open: CostLayer[] }>();
  if (saleIds.length === 0) return out;
  const rows = await tx
    .select()
    .from(inventoryCostLayers)
    .where(and(eq(inventoryCostLayers.reason, "return_without_cost"), inArray(inventoryCostLayers.sourceValuationId, [...new Set(saleIds)])))
    .orderBy(asc(inventoryCostLayers.createdSeq), asc(inventoryCostLayers.id));
  for (const r of rows) {
    const t = out.get(r.sourceValuationId!) ?? { qtyIn: 0, open: [] };
    t.qtyIn += r.qtyIn;
    if (r.qtyOpen > 0 && r.closedAt === null) t.open.push(layerFromRow(r));
    out.set(r.sourceValuationId!, t);
  }
  return out;
}

/** Одиниці виходу, що ще продані й без вартості: U − повернені без вартості − завершені. */
export function soldUnvaluedOf(sale: ValuationRow, returnedUnvalued: number, completed: number): number {
  return Math.max(0, sale.unknownQty + sale.deficitQty - returnedUnvalued - completed);
}

/**
 * Розподіл завершення одиниць виходу між продажем і його поверненими шарами: перші `soldUnvalued` одиниць — продаж,
 * решта — відкриті шари return_without_cost цього виходу (у пул). Значення — частки `value` за кількістю.
 */
export function splitSaleCompletion(
  pending: Array<{ layerId: string; qty: number }>,
  value: bigint,
  soldUnvalued: number,
  openReturnLayers: readonly CostLayer[],
  q: bigint = 1n,
): { sales: Array<{ layerId: string; qty: number; value: bigint }>; stock: StockPart[]; consumedReturned: Map<string, number> } {
  const total = pending.reduce((s, p) => s + p.qty, 0);
  const sales: Array<{ layerId: string; qty: number; value: bigint }> = [];
  const stock: StockPart[] = [];
  const consumedReturned = new Map<string, number>();
  if (total <= 0) return { sales, stock, consumedReturned };
  const soldQty = Math.min(total, soldUnvalued);
  // Частини: продажі FIFO за шарами, потім повернені шари.
  const parts: Array<{ kind: "sale" | "return"; layerId: string; qty: number }> = [];
  let left = soldQty;
  for (const p of pending) {
    if (left === 0) break;
    const t = Math.min(p.qty, left);
    if (t > 0) parts.push({ kind: "sale", layerId: p.layerId, qty: t });
    left -= t;
  }
  let returned = total - soldQty;
  for (const l of openReturnLayers) {
    if (returned === 0) break;
    const t = Math.min(l.qtyOpen, returned);
    if (t > 0) parts.push({ kind: "return", layerId: l.id, qty: t });
    returned -= t;
  }
  const shares = cumulativeShares(value, parts.map((p) => p.qty), total, q);
  parts.forEach((p, i) => {
    if (p.kind === "sale") sales.push({ layerId: p.layerId, qty: p.qty, value: shares[i]! });
    else {
      stock.push({ layerId: p.layerId, qty: p.qty, value: shares[i]! });
      consumedReturned.set(p.layerId, (consumedReturned.get(p.layerId) ?? 0) + p.qty);
    }
  });
  return { sales, stock, consumedReturned };
}

/**
 * Завершення одиниць, які вихід(и) взяли з шару `layer`, на загальну вартість `value` шару (курс / партія): частка
 * відкритих одиниць — у пул, частки виходів — завершення продажів (з урахуванням повернених). Повертає план.
 */
export async function planLayerValueCompletion(
  tx: Tx,
  layer: CostLayer,
  stockItemId: string,
  value: bigint,
  opts: {
    extraDeficits?: Array<{ layerId: string; saleValuationId: string; qty: number }>;
    /** Усього одиниць, на які припадає `value` (типово — Σ ще не завершених); частка вже завершених відкидається. */
    totalUnits?: number;
    /** Валюта оцінки (квант часток: JPY — цілі одиниці). */
    currency?: string;
  } = {},
): Promise<CompletionPlan> {
  const q = opts.currency ? currencyQuantum(opts.currency) : 1n;
  const draws = await outflowsDrawingLayer(tx, stockItemId, layer.id);
  const totals = await completionTotals(tx, [...draws.map((d) => d.id), ...(opts.extraDeficits ?? []).map((e) => e.saleValuationId)]);
  const drawn = draws.map((d) => {
    const qty = (d.drawnLayers ?? []).filter((x) => x.layerId === layer.id).reduce((s, x) => s + x.qty, 0);
    const done = totals.get(d.id)?.byLayer.get(layer.id) ?? 0;
    return { sale: d, qty: Math.max(0, qty - done) };
  });
  const deficitSales = opts.extraDeficits?.length ? await loadValuations(tx, opts.extraDeficits.map((e) => e.saleValuationId)) : [];
  const deficitById = new Map(deficitSales.map((v) => [v.id, v]));
  const weights = [layer.qtyOpen, ...drawn.map((d) => d.qty), ...(opts.extraDeficits ?? []).map((e) => e.qty)];
  const sum = weights.reduce((s, w) => s + w, 0);
  const plan: CompletionPlan = { stock: [], sales: [] };
  if (sum <= 0) return plan;
  if (opts.totalUnits !== undefined && opts.totalUnits > sum) weights.push(opts.totalUnits - sum);
  const parts = allocateQ(value, weights.map((w) => BigInt(w)), q);
  if (layer.qtyOpen > 0) plan.stock.push({ layerId: layer.id, qty: layer.qtyOpen, value: parts[0]! });
  const returned = await returnedUnvaluedBySale(tx, [...drawn.map((d) => d.sale.id), ...deficitSales.map((v) => v.id)]);
  // Одиниці продажу, уже повернуті шаром return_without_cost, отримують вартість у СВІЙ шар (у пул), а не в собівартість
  // продажу (§6.2) — і для витрат шару, і для дефіцитів, закритих цим надходженням лише кількістю.
  const consumed = new Map<string, number>();
  const completedInPlan = new Map<string, number>();
  const split = (sale: ValuationRow, layerId: string, qty: number, v: bigint) => {
    const r = returned.get(sale.id) ?? { qtyIn: 0, open: [] };
    const completed = (totals.get(sale.id)?.qty ?? 0) + (completedInPlan.get(sale.id) ?? 0);
    const openReturns = r.open.map((l) => ({ ...l, qtyOpen: l.qtyOpen - (consumed.get(l.id) ?? 0) })).filter((l) => l.qtyOpen > 0);
    const res = splitSaleCompletion([{ layerId, qty }], v, soldUnvaluedOf(sale, r.qtyIn, completed), openReturns, q);
    for (const s of res.sales) {
      plan.sales.push({ sale, ...s });
      completedInPlan.set(sale.id, (completedInPlan.get(sale.id) ?? 0) + s.qty);
    }
    plan.stock.push(...res.stock);
    for (const [id, n] of res.consumedReturned) consumed.set(id, (consumed.get(id) ?? 0) + n);
  };
  drawn.forEach((d, i) => {
    if (d.qty > 0) split(d.sale, layer.id, d.qty, parts[i + 1]!);
  });
  (opts.extraDeficits ?? []).forEach((e, j) => {
    const sale = deficitById.get(e.saleValuationId);
    if (sale && e.qty > 0) split(sale, e.layerId, e.qty, parts[1 + drawn.length + j]!);
  });
  return plan;
}

/**
 * Застосовує план завершення до позиції (склад, позиція): частина «у пул» спершу закриває дефіцит (R3 тих продажів),
 * решта — відомі; частини продажів — рядки завершень + оцінка sale_completion датою продажу (*_after = null). Викликач
 * тримає блокування балансу позиції (F10).
 */
export async function applyCompletionPlan(
  tx: Tx,
  cctx: CostingContext,
  warehouseId: string,
  item: StockItemInfo,
  plan: CompletionPlan,
  input: ApplyPlanInput,
): Promise<ValueItemResult> {
  const result: ValueItemResult = { entries: [], orders: new Map(), valued: 0 };
  if (plan.stock.length === 0 && plan.sales.length === 0 && !input.forceStockValuation) return result;
  const now = input.now ?? new Date();
  const { state: initial } = await lockCostState(tx, warehouseId, item.id, cctx.valuationCurrency);
  const state: PoolState = { ...initial };
  const q = currencyQuantum(state.currency);
  const layers = await loadOpenLayers(tx, warehouseId, item.id);
  const byId = new Map(layers.map((l) => [l.id, l]));
  const touched = new Set<string>();
  // 1. Відкриті одиниці шарів → пул.
  let stockQty = 0;
  let stockValue = 0n;
  const stockLayers: string[] = [];
  for (const p of plan.stock) {
    const l = byId.get(p.layerId);
    if (!l || l.kind !== "unknown") continue;
    const qty = Math.min(p.qty, l.qtyOpen);
    if (qty <= 0) continue;
    const value = qty === p.qty ? p.value : cumulativeShares(p.value, [qty], p.qty, q)[0]!;
    l.qtyOpen -= qty;
    if (l.qtyOpen === 0) l.closed = true;
    touched.add(l.id);
    state.unknownQty -= qty;
    stockQty += qty;
    stockValue += value;
    stockLayers.push(`${l.id}:${qty}`);
  }
  // Закриття дефіциту (FIFO) вартістю, що надійшла (курс, партія). Ручна собівартість власника дефіциту НЕ закриває
  // (D-20, §6.5: для від'ємного залишку вона лише прогноз — справжня вартість прийде з надходженням): одиниці йдуть у
  // відомий пул, дефіцит чекає наступного надходження.
  const deficitCompletions: Array<{ layer: CostLayer; qty: number; value: bigint }> = [];
  if (stockQty > 0 && input.basis === "owner_standard") {
    state.knownQty += stockQty;
    state.knownValue += stockValue;
  } else if (stockQty > 0) {
    let remaining = stockQty;
    const deficits = layers.filter((l) => l.kind === "deficit" && l.qtyOpen > 0 && !l.closed).sort((a, b) => a.createdSeq - b.createdSeq);
    const parts: Array<{ layer: CostLayer; s: number }> = [];
    for (const d of deficits) {
      if (remaining === 0) break;
      const s = Math.min(d.qtyOpen, remaining);
      parts.push({ layer: d, s });
      remaining -= s;
    }
    const shares = cumulativeShares(stockValue, [...parts.map((p) => p.s), remaining], stockQty, q);
    parts.forEach((p, i) => {
      p.layer.qtyOpen -= p.s;
      if (p.layer.qtyOpen === 0) p.layer.closed = true;
      touched.add(p.layer.id);
      state.deficitQty -= p.s;
      deficitCompletions.push({ layer: p.layer, qty: p.s, value: shares[i]! });
    });
    state.knownQty += remaining;
    state.knownValue += shares[shares.length - 1]!;
  }
  if (state.knownQty > 0) state.lastAvgUnit = averageUnit(state.knownValue, state.knownQty);
  const completions: CompletionInsert[] = [];
  const stockValuationId = randomUUID();
  if (stockQty > 0 || input.forceStockValuation) {
    await insertValuation(tx, {
      draft: {
        id: stockValuationId,
        kind: "stock_completion",
        qty: stockQty,
        knownQty: stockQty,
        unknownQty: 0,
        deficitQty: 0,
        value: stockValue,
        valueSource: input.basis,
        drawnLayers: [],
        originalAmount: null,
        originalCurrency: null,
        rateDate: null,
        rateSource: null,
        after: { knownQty: state.knownQty, knownValue: state.knownValue, unknownQty: state.unknownQty, deficitQty: state.deficitQty },
        details: {
          basis: input.basis,
          layers: stockLayers.slice(0, 50),
          ...(deficitCompletions.length ? { deficitLayers: deficitCompletions.map((d) => `${d.layer.id}:${d.qty}`).slice(0, 50) } : {}),
          ...(input.details ?? {}),
        },
      },
      eventKey: input.eventKey,
      warehouseId,
      stockItemId: item.id,
      currency: state.currency,
      movementId: null,
      movementSeq: null,
      orderId: null,
      orderLineItemId: null,
      occurredOn: input.occurredOn,
    });
    result.valued += 1;
  }
  // 2. Завершення продажів: частини плану + дефіцити, закриті частиною «у пул».
  const saleParts: SalePart[] = [...plan.sales];
  if (deficitCompletions.length > 0) {
    const sales = new Map((await loadValuations(tx, deficitCompletions.map((d) => d.layer.originValuationId!).filter(Boolean))).map((v) => [v.id, v]));
    for (const d of deficitCompletions) {
      const sale = d.layer.originValuationId ? sales.get(d.layer.originValuationId) : undefined;
      if (sale) saleParts.push({ sale, layerId: d.layer.id, qty: d.qty, value: d.value });
    }
  }
  const bySale = new Map<string, SalePart[]>();
  for (const p of saleParts) {
    if (p.qty <= 0) continue;
    bySale.set(p.sale.id, [...(bySale.get(p.sale.id) ?? []), p]);
  }
  for (const [saleId, parts] of bySale) {
    const sale = parts[0]!.sale;
    const qty = parts.reduce((s, p) => s + p.qty, 0);
    const value = parts.reduce((s, p) => s + p.value, 0n);
    await insertValuation(tx, {
      draft: {
        id: randomUUID(),
        kind: "sale_completion",
        qty,
        knownQty: qty,
        unknownQty: 0,
        deficitQty: 0,
        value,
        valueSource: input.basis,
        drawnLayers: [],
        originalAmount: null,
        originalCurrency: null,
        rateDate: null,
        rateSource: null,
        after: { knownQty: 0, knownValue: 0n, unknownQty: 0, deficitQty: 0 },
        details: { basis: input.basis, saleValuationId: saleId, layers: parts.map((p) => `${p.layerId}:${p.qty}`).slice(0, 50), movementType: detailString(sale, "movementType") },
      },
      eventKey: `${input.eventKey}:${saleId}`,
      warehouseId,
      stockItemId: item.id,
      currency: state.currency,
      movementId: null,
      movementSeq: null,
      orderId: sale.orderId,
      orderLineItemId: sale.orderLineItemId,
      occurredOn: sale.occurredOn,
    });
    for (const p of parts) {
      const id = randomUUID();
      completions.push({ id, valuationId: saleId, layerId: p.layerId, qty: p.qty, value: p.value, basis: input.basis, eventKey: `${input.eventKey}:${saleId}:${p.layerId}` });
      if (sale.orderId) {
        result.orders.set(sale.orderId, input.actorId);
        continue;
      }
      const category = completionCategory((detailString(sale, "effect") ?? "none") as ValuationEffect);
      if (category && p.value > 0n) {
        result.entries.push({
          actorId: input.actorId,
          entry: completionEntry({
            completionId: id,
            category,
            minor: p.value,
            outflowOn: sale.occurredOn,
            currency: state.currency,
            stockItemId: item.id,
            variantId: item.variantId,
            quantity: p.qty,
            saleValuationId: saleId,
            basis: input.basis,
            lossKind: detailString(sale, "lossKind"),
          }),
        });
      }
    }
  }
  await insertCompletions(tx, completions);
  await persistLayers(tx, warehouseId, item.id, [...byId.values()], [], [...touched], now);
  await saveCostState(tx, warehouseId, item.id, state);
  // C0 (завершення кількості не змінює).
  const [balance] = await tx
    .select({ onHand: inventoryBalances.onHand })
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.warehouseId, warehouseId), eq(inventoryBalances.stockItemId, item.id)));
  if (balance && poolOnHand(initial) === balance.onHand && poolOnHand(state) !== balance.onHand && process.env.VITEST) {
    // Завершення кількостей не змінює — порушення можливе лише через помилку коду (у тестах — виняток).
    throw new Error(`C0 violated by completion for stock item ${item.id}`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Ручна собівартість власника (§6.6)
// ---------------------------------------------------------------------------

/** Відкриті невідомі шари позиції, до яких застосовується ручна собівартість (без fx_pending). */
export async function openStandardLayers(tx: Tx, warehouseId: string, stockItemId: string): Promise<CostLayer[]> {
  const rows = await tx
    .select()
    .from(inventoryCostLayers)
    .where(
      and(
        eq(inventoryCostLayers.warehouseId, warehouseId),
        eq(inventoryCostLayers.stockItemId, stockItemId),
        eq(inventoryCostLayers.kind, "unknown"),
        gt(inventoryCostLayers.qtyOpen, 0),
        isNull(inventoryCostLayers.closedAt),
      ),
    )
    .orderBy(asc(inventoryCostLayers.createdSeq), asc(inventoryCostLayers.id));
  return rows.map(layerFromRow).filter((l) => l.reason !== "fx_pending");
}

/**
 * Виходи позиції з одиницями без вартості з дати `from` до `until` (виключно; null — без межі) — для «до вже проданих».
 * Межа `until` — наступний підтверджений рядок ручної собівартості (§6.6: діє останній effective_from ≤ дата), тож
 * рядок із минулою датою дії не перекриває вже чинний пізніший рядок.
 */
export async function outflowsWithDrawsSince(tx: DbOrTx, warehouseId: string | null, stockItemIds: readonly string[], from: string | null, until: string | null = null): Promise<ValuationRow[]> {
  if (stockItemIds.length === 0) return [];
  return tx
    .select()
    .from(inventoryValuations)
    .where(
      and(
        warehouseId ? eq(inventoryValuations.warehouseId, warehouseId) : undefined,
        inArray(inventoryValuations.stockItemId, [...stockItemIds]),
        eq(inventoryValuations.kind, "outflow"),
        sql`${inventoryValuations.unknownQty} + ${inventoryValuations.deficitQty} > 0`,
        from ? sql`${inventoryValuations.occurredOn} >= ${from}` : undefined,
        until ? sql`${inventoryValuations.occurredOn} < ${until}` : undefined,
      ),
    )
    .orderBy(asc(inventoryValuations.seq));
}

/** Причини шарів, з яких виходи брали одиниці без вартості (fx_pending ручною собівартістю не завершується). */
export async function drawnLayerReasons(tx: DbOrTx, outflows: readonly ValuationRow[]): Promise<Map<string, string>> {
  const layerIds = [...new Set(outflows.flatMap((o) => (o.drawnLayers ?? []).map((d) => d.layerId)))];
  if (layerIds.length === 0) return new Map();
  const rows = await tx.select({ id: inventoryCostLayers.id, reason: inventoryCostLayers.reason }).from(inventoryCostLayers).where(inArray(inventoryCostLayers.id, layerIds));
  return new Map(rows.map((l) => [l.id, l.reason]));
}

/** Витрати невідомих шарів виходом, які ручна собівартість ще може завершити (крім fx_pending, без уже завершених). */
export function ownerPendingDraws(o: ValuationRow, reasonOf: ReadonlyMap<string, string>, done: { byLayer: Map<string, number> } | undefined): Array<{ layerId: string; qty: number }> {
  const pending: Array<{ layerId: string; qty: number }> = [];
  for (const d of o.drawnLayers ?? []) {
    if (reasonOf.get(d.layerId) === "fx_pending") continue;
    const left = d.qty - (done?.byLayer.get(d.layerId) ?? 0);
    if (left > 0) pending.push({ layerId: d.layerId, qty: left });
  }
  return pending;
}

/**
 * Одиниці виходу без вартості: `completable` — їх завершить ручна собівартість «до вже проданих» (продані одиниці з
 * невідомих шарів, крім fx_pending); `awaiting` — решта (від'ємний залишок чекає надходження, fx_pending — курсу; D-20).
 */
export function unvaluedSplitOf(o: ValuationRow, pending: ReadonlyArray<{ qty: number }>, returnedUnvalued: number, completed: number): { completable: number; awaiting: number } {
  const sold = soldUnvaluedOf(o, returnedUnvalued, completed);
  const completable = Math.min(sold, pending.reduce((s, p) => s + p.qty, 0));
  return { completable, awaiting: sold - completable };
}

/**
 * План завершення ручною собівартістю (одиниця — у валюті оцінки):
 * - toSold — витрати невідомих шарів (крім fx_pending) виходами з датою в [effectiveFrom, until), ще не завершені:
 *   продані одиниці → завершення продажів, повернені → їхні шари return_without_cost (у пул). Одиниця — `soldUnitAt` на
 *   ДАТУ КОЖНОГО ВИХОДУ (так само, як рушій оцінює вихід за ручною собівартістю: курс дати руху, I9);
 * - toStock — відкриті невідомі шари (крім fx_pending) → у пул за `stockUnit` (дата збереження); null — не застосовується.
 */
export async function planOwnerCompletion(
  tx: Tx,
  warehouseId: string,
  stockItemId: string,
  opts: {
    effectiveFrom: string;
    until: string | null;
    toStock: boolean;
    toSold: boolean;
    /** Одиниця «до залишку» (лише якщо є відкриті невідомі шари); null — не застосовується. */
    stockUnit: (() => Promise<bigint>) | null;
    soldUnitAt: (date: string) => Promise<bigint>;
    currency?: string;
  },
): Promise<CompletionPlan> {
  const q = opts.currency ? currencyQuantum(opts.currency) : 1n;
  const plan: CompletionPlan = { stock: [], sales: [] };
  const consumed = new Map<string, number>();
  if (opts.toSold) {
    const outflows = await outflowsWithDrawsSince(tx, warehouseId, [stockItemId], opts.effectiveFrom, opts.until);
    const reasonOf = await drawnLayerReasons(tx, outflows);
    const totals = await completionTotals(tx, outflows.map((o) => o.id));
    const returned = await returnedUnvaluedBySale(tx, outflows.map((o) => o.id));
    for (const o of outflows) {
      const done = totals.get(o.id);
      const pending = ownerPendingDraws(o, reasonOf, done);
      const total = pending.reduce((s, p) => s + p.qty, 0);
      if (total === 0) continue;
      const r = returned.get(o.id) ?? { qtyIn: 0, open: [] };
      const openReturns = r.open.map((l) => ({ ...l, qtyOpen: l.qtyOpen - (consumed.get(l.id) ?? 0) })).filter((l) => l.qtyOpen > 0);
      const unit = await opts.soldUnitAt(o.occurredOn);
      const split = splitSaleCompletion(pending, unit * BigInt(total), soldUnvaluedOf(o, r.qtyIn, done?.qty ?? 0), openReturns, q);
      for (const s of split.sales) plan.sales.push({ sale: o, ...s });
      plan.stock.push(...split.stock);
      for (const [id, n] of split.consumedReturned) consumed.set(id, (consumed.get(id) ?? 0) + n);
    }
  }
  if (opts.toStock && opts.stockUnit !== null) {
    let unit: bigint | null = null;
    for (const l of await openStandardLayers(tx, warehouseId, stockItemId)) {
      const left = l.qtyOpen - (consumed.get(l.id) ?? 0);
      if (left <= 0) continue;
      unit ??= await opts.stockUnit();
      plan.stock.push({ layerId: l.id, qty: left, value: unit * BigInt(left) });
    }
  }
  // Злиття частин «у пул» за шаром.
  const merged = new Map<string, StockPart>();
  for (const p of plan.stock) {
    const m = merged.get(p.layerId);
    if (m) {
      m.qty += p.qty;
      m.value += p.value;
    } else merged.set(p.layerId, { ...p });
  }
  plan.stock = [...merged.values()];
  return plan;
}

/** Ключ події завершення власника для позиції. */
export const ownerCompletionKey = (operationId: string, stockItemId: string) => valuationEventKeys.completion(operationId, stockItemId);

/** Деталі оцінки — сума частин плану (для історії змін). */
export function planTotals(plan: CompletionPlan): { stockQty: number; stockValue: string; soldQty: number; soldValue: string } {
  const stockQty = plan.stock.reduce((s, p) => s + p.qty, 0);
  const stockValue = plan.stock.reduce((s, p) => s + p.value, 0n);
  const soldQty = plan.sales.reduce((s, p) => s + p.qty, 0);
  const soldValue = plan.sales.reduce((s, p) => s + p.value, 0n);
  return { stockQty, stockValue: minorToDecimal(stockValue), soldQty, soldValue: minorToDecimal(soldValue) };
}

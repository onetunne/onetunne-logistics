/**
 * Етап 6, WP2: ручна собівартість власника (docs/stage6-design.md §6.6, D-20) — СЕРВІСИ КЕРУВАННЯ (requireFinance
 * "manage" / "view"). Рядки stock_item_costs — лише вставка (останній effective_from ≤ дата, потім created_at).
 * - одна позиція або масово за моделлю × кольором (рядок на кожен варіант, ключ manual:<operationId>:<variantId>);
 * - «до залишку» → завершення відкритих невідомих шарів (оцінка complete:<operationId>:<stockItemId>, датою збереження);
 * - «до вже проданих» → завершення витрат невідомих шарів виходами з датою ≥ effective_from — датою тих рухів (R3;
 *   закритий місяць → «Пізній запис»); повернені одиниці завершують свої шари return_without_cost (у пул);
 * - «перерахувати вже оцінені за попередньою ручною собівартістю» (типово вимкнено) → коригування датою зміни (R2):
 *   і виходи, оцінені ручною собівартістю під час руху, і продані одиниці, завершені «до вже проданих» раніше.
 * Новий рядок діє лише в межах [effective_from, наступний підтверджений рядок) — правило пошуку «останній effective_from
 * ≤ дата» (рядок із минулою датою не перекриває чинний пізніший). Ціна в іншій валюті конвертується на ДАТУ КОЖНОГО
 * ВИХОДУ (як у рушії, I9); «до залишку» — на дату збереження. effective_from у майбутньому — відмова.
 * Минулі суми не переписуються. Дата в закритому місяці — відмова (§3.4). Кожна зміна — finance_change_log (до → після).
 * Один operationId — одна операція (FIOP); повтор форми — duplicate.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, like, min, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { inventoryCostLayers, inventoryCostState, inventoryValuationCompletions, inventoryValuations, productVariants, stockItemCosts, stockItems } from "~/db/schema";
import { DomainError, NotFoundError } from "~/lib/errors";
import { isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { toMinor } from "~/lib/money";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { writeFinanceChange } from "~/modules/finance/core/change-log.server";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { lockFinanceOperation } from "~/modules/finance/core/locks.server";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { ensureStockItemsForVariants, lockBalances } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import type { ServiceContext } from "~/server/types";
import {
  applyCompletionPlan,
  drawnLayerReasons,
  outflowsWithDrawsSince,
  ownerCompletionKey,
  ownerPendingDraws,
  planOwnerCompletion,
  planTotals,
  returnedUnvaluedBySale,
  unvaluedSplitOf,
} from "./completion.server";
import { minorToDecimal } from "./engine";
import { convertToValuation, loadCostingContext, loadStockItemInfo, manualCostAt, type CostingContext } from "./inputs.server";
import { completionTotals, detailMinor, detailNumber, detailString, insertValuation, lockCostState, type ValuationRow } from "./store.server";
import { flushValuationResults, valueItemMovements, type ValueItemResult } from "./valuation.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MANUAL_COST_NOTE_MAX = 200;
export const MAX_MANUAL_COST_ITEMS = 500;

export type ManualCostTarget =
  | { kind: "stockItems"; stockItemIds: readonly string[] }
  | { kind: "modelColor"; model: string; color: string | null };

export interface SaveManualCostInput {
  operationId: string;
  target: ManualCostTarget;
  /** Десятковий рядок ≥ 0 (розібраний parseOwnerAmount). */
  unitCost: string;
  currency: string;
  effectiveFrom: string;
  applyToStock: boolean;
  applyToSold: boolean;
  /** Перерахувати виходи, уже оцінені за попередньою ручною собівартістю (R2, датою зміни). Типово — ні. */
  recomputeStandard?: boolean;
  note?: string | null;
  /** Джерело рядка (типово manual / bulk_model_color; підтвердження підказки Shopify — shopify_unit_cost). */
  source?: "manual" | "bulk_model_color" | "shopify_unit_cost";
}

export interface SaveManualCostResult {
  duplicate: boolean;
  items: number;
  /** Одиниці, що отримали вартість: на складі / уже продані. */
  completedStockUnits: number;
  completedSoldUnits: number;
  recomputed: number;
}

function badInput(field: string): DomainError {
  return new DomainError("financeCosts.error.invalid", 400, { field });
}

/** Позиції обліку цілі (товари; масово — усі живі варіанти моделі × кольору). */
export async function resolveCostTarget(db: DbOrTx, target: ManualCostTarget): Promise<Array<{ stockItemId: string; variantId: string | null }>> {
  if (target.kind === "stockItems") {
    const ids = [...new Set(target.stockItemIds.map((s) => s.toLowerCase()))];
    if (ids.length === 0 || ids.length > MAX_MANUAL_COST_ITEMS || ids.some((id) => !UUID_RE.test(id))) throw badInput("stockItemIds");
    const rows = await db.select({ id: stockItems.id, variantId: stockItems.variantId }).from(stockItems).where(inArray(stockItems.id, ids));
    if (rows.length !== ids.length) throw new NotFoundError("stockItem");
    return rows.map((r) => ({ stockItemId: r.id, variantId: r.variantId })).sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));
  }
  const model = target.model.trim();
  if (!model || model.length > 120) throw badInput("model");
  const variants = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.model, model),
        target.color === null ? isNull(productVariants.color) : eq(productVariants.color, target.color),
        isNull(productVariants.removedAt),
      ),
    )
    .orderBy(asc(productVariants.id));
  if (variants.length === 0) throw new NotFoundError("productVariant");
  if (variants.length > MAX_MANUAL_COST_ITEMS) throw badInput("model");
  // Позиції обліку масової цілі створює ensureTargetStockItems (у транзакції збереження); тут — лише перевірка.
  return [];
}

async function ensureTargetStockItems(tx: Tx, target: ManualCostTarget): Promise<Array<{ stockItemId: string; variantId: string | null }>> {
  if (target.kind === "stockItems") return resolveCostTarget(tx, target);
  await resolveCostTarget(tx, target);
  const variants = await tx
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.model, target.model.trim()),
        target.color === null ? isNull(productVariants.color) : eq(productVariants.color, target.color),
        isNull(productVariants.removedAt),
      ),
    );
  const map = await ensureStockItemsForVariants(tx, variants.map((v) => v.id));
  return [...map].map(([variantId, stockItemId]) => ({ stockItemId, variantId })).sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));
}

/**
 * Одиниця ручної собівартості у валюті оцінки на дату (немає курсу → finance.error.noRate). Кеш за датою: «до вже
 * проданих» і перерахунок конвертують на дату кожного виходу — так само, як рушій (inputs.standardUnitFor).
 */
function unitConverter(tx: DbOrTx, cctx: CostingContext, unitCost: string, currency: string): (date: string) => Promise<bigint> {
  const cache = new Map<string, Promise<bigint>>();
  return (date: string) => {
    let p = cache.get(date);
    if (!p) {
      p = convertToValuation(tx, cctx, toMinor(unitCost), currency, date).then((conv) => {
        if (!conv.ok) throw new DomainError(conv.reason === "no_rate" ? "finance.error.noRate" : "finance.error.unsupportedCurrency", 409, { currency, date });
        return conv.minor;
      });
      cache.set(date, p);
    }
    return p;
  };
}

/**
 * Наступна дата дії підтвердженого рядка ручної собівартості позиції після `from` (виключна межа дії рядка з
 * effective_from = from); null — пізніших рядків немає. Рядки з тією самою датою перекриває новіший (created_at).
 */
export async function nextEffectiveFrom(db: DbOrTx, stockItemId: string, from: string): Promise<string | null> {
  const [row] = await db
    .select({ next: min(stockItemCosts.effectiveFrom) })
    .from(stockItemCosts)
    .where(and(eq(stockItemCosts.stockItemId, stockItemId), eq(stockItemCosts.confirmed, true), gt(stockItemCosts.effectiveFrom, from)));
  return row?.next ?? null;
}

/** effective_from: дата ISO, не пізніше сьогодні (за Києвом) — інакше стан оцінювався б ціною, що ще не діє (§6.6). */
export function validateEffectiveFrom(raw: string, today: string): string {
  const effectiveFrom = parseIsoDate(raw);
  if (!effectiveFrom || effectiveFrom > today) throw badInput("effectiveFrom");
  return effectiveFrom;
}

function validate(input: SaveManualCostInput, today: string): { effectiveFrom: string; unitCost: string } {
  if (!UUID_RE.test(input.operationId)) throw badInput("operationId");
  if (!isSupportedCurrency(input.currency)) throw new DomainError("finance.error.unsupportedCurrency", 400, { currency: input.currency });
  let minor: bigint;
  try {
    minor = toMinorForCurrency(input.unitCost, input.currency);
  } catch {
    throw new DomainError("finance.error.amountWholeUnits", 400);
  }
  if (minor < 0n) throw new DomainError("finance.error.amountInvalid", 400);
  const effectiveFrom = validateEffectiveFrom(input.effectiveFrom, today);
  return { effectiveFrom, unitCost: minorToDecimal(minor) };
}

/** Зберігає ручну собівартість і (за вибором) завершує невідому вартість «до залишку» / «до вже проданих». */
export async function saveManualCost(ctx: ServiceContext, input: SaveManualCostInput): Promise<SaveManualCostResult> {
  requireFinance(ctx, "manage");
  validate(input, businessDate(ctx.now()));
  return ctx.db.transaction((tx) => saveManualCostTx(tx, ctx, input));
}

/** Те саме в транзакції викликача (підтвердження підказок Shopify); requireFinance("manage") — і тут. */
export async function saveManualCostTx(tx: Tx, ctx: Pick<ServiceContext, "actor" | "now">, input: SaveManualCostInput): Promise<SaveManualCostResult> {
  requireFinance(ctx, "manage");
  const today = businessDate(ctx.now());
  const { effectiveFrom, unitCost } = validate(input, today);
  const op = input.operationId.toLowerCase();
  const note = maskFreeTextNote(input.note ?? null, MANUAL_COST_NOTE_MAX);
  {
    await lockFinanceOperation(tx, op);
    await assertMonthOpen(tx, effectiveFrom);
    const items = await ensureTargetStockItems(tx, input.target);
    const keyOf = (i: { stockItemId: string; variantId: string | null }) => `manual:${op}:${i.variantId ?? i.stockItemId}`;
    const existing = await tx
      .select({ key: stockItemCosts.idempotencyKey })
      .from(stockItemCosts)
      .where(inArray(stockItemCosts.idempotencyKey, items.map(keyOf)));
    if (existing.length > 0) return { duplicate: true, items: items.length, completedStockUnits: 0, completedSoldUnits: 0, recomputed: 0 };
    const cctx = await loadCostingContext(tx);
    const unitAt = unitConverter(tx, cctx, unitCost, input.currency);
    const source = input.source ?? (input.target.kind === "modelColor" ? "bulk_model_color" : "manual");
    const model = input.target.kind === "modelColor" ? input.target.model.trim() : null;
    const color = input.target.kind === "modelColor" ? input.target.color : null;
    const inserted: Array<{ stockItemId: string; id: string }> = [];
    for (const item of items) {
      const before = await manualCostAt(tx, item.stockItemId, effectiveFrom, { confirmedOnly: true });
      const id = randomUUID();
      await tx.insert(stockItemCosts).values({
        id,
        stockItemId: item.stockItemId,
        unitCost,
        currency: input.currency,
        effectiveFrom,
        source,
        confirmed: true,
        note,
        idempotencyKey: keyOf(item),
        createdBy: ctx.actor.id,
      });
      inserted.push({ stockItemId: item.stockItemId, id });
      await writeFinanceChange(tx, ctx.actor, {
        entityType: "stock_item_cost",
        entityId: item.stockItemId,
        action: before ? "update" : "create",
        before: before ? { stockItemId: item.stockItemId, unitCost: before.unitCost, currency: before.currency, effectiveFrom: before.effectiveFrom, source: before.source } : null,
        after: {
          stockItemId: item.stockItemId,
          unitCost,
          currency: input.currency,
          effectiveFrom,
          source,
          confirmed: true,
          model,
          color,
          applyToStock: input.applyToStock,
          applyToSold: input.applyToSold,
        },
        reason: note,
      });
    }
    const result: SaveManualCostResult = { duplicate: false, items: items.length, completedStockUnits: 0, completedSoldUnits: 0, recomputed: 0 };
    const results: ValueItemResult[] = [];
    if (input.applyToStock || input.applyToSold || input.recomputeStandard) {
      const warehouse = await getDefaultWarehouse(tx);
      await lockBalances(tx, items.map((i) => ({ warehouseId: warehouse.id, stockItemId: i.stockItemId })));
      for (const i of items) {
        const info = await loadStockItemInfo(tx, i.stockItemId);
        // Неоцінені рухи позиції (дані до етапу 6, ще не довантажені) — спершу оцінити за seq.
        results.push(await valueItemMovements(tx, cctx, warehouse.id, i.stockItemId));
        // Межа дії нового рядка: наступний підтверджений рядок (§6.6 «останній effective_from ≤ дата»).
        const until = await nextEffectiveFrom(tx, i.stockItemId, effectiveFrom);
        const governsToday = until === null || until > today;
        if (input.applyToStock || input.applyToSold) {
          const plan = await planOwnerCompletion(tx, warehouse.id, i.stockItemId, {
            effectiveFrom,
            until,
            // «До залишку» — датою збереження; якщо сьогодні діє пізніший рядок, новий рядок до залишку не застосовується.
            toStock: input.applyToStock && governsToday,
            toSold: input.applyToSold,
            stockUnit: input.applyToStock && governsToday ? () => unitAt(today) : null,
            soldUnitAt: unitAt,
            currency: cctx.valuationCurrency,
          });
          const totals = planTotals(plan);
          if (totals.stockQty + totals.soldQty > 0) {
            const res = await applyCompletionPlan(tx, cctx, warehouse.id, info, plan, {
              eventKey: ownerCompletionKey(op, i.stockItemId),
              occurredOn: today,
              basis: "owner_standard",
              actorId: ctx.actor.id,
              details: { stockItemCostId: inserted.find((x) => x.stockItemId === i.stockItemId)!.id, soldQty: totals.soldQty, soldValue: totals.soldValue },
              now: ctx.now(),
            });
            results.push(res);
            result.completedStockUnits += totals.stockQty;
            result.completedSoldUnits += totals.soldQty;
            await writeFinanceChange(tx, ctx.actor, {
              entityType: "valuation_completion",
              entityId: i.stockItemId,
              action: "create",
              after: {
                stockItemId: i.stockItemId,
                qty: totals.stockQty + totals.soldQty,
                value: minorToDecimal(toMinor(totals.stockValue) + toMinor(totals.soldValue)),
                currency: cctx.valuationCurrency,
                basis: "owner_standard",
              },
            });
          }
        }
        if (input.recomputeStandard) {
          const r = await recomputeStandardValued(tx, cctx, {
            warehouseId: warehouse.id,
            stockItemId: i.stockItemId,
            variantId: info.variantId,
            unitAt,
            effectiveFrom,
            until,
            newCostId: inserted.find((x) => x.stockItemId === i.stockItemId)!.id,
            operationId: op,
            actorId: ctx.actor.id,
            today,
          });
          results.push(r.result);
          result.recomputed += r.count;
        }
      }
    }
    await flushValuationResults(tx, results);
    await writeAudit(tx, ctx.actor, "finance.manual_cost_saved", { type: "stock_item_cost", id: op }, {
      items: items.length,
      source,
      applyToStock: input.applyToStock,
      applyToSold: input.applyToSold,
      completedStockUnits: result.completedStockUnits,
      completedSoldUnits: result.completedSoldUnits,
      recomputed: result.recomputed,
    });
    return result;
  }
}

/**
 * Виходи з датою в межах дії нового рядка [effective_from, until), оцінені за ПОПЕРЕДНЬОЮ ручною собівартістю — і під
 * час руху (details.standardQty, рядок ≠ новий), і пізніше завершенням «до вже проданих» (завершення з basis
 * owner_standard інших операцій), → коригування Δ = одиниця нової (курс дати виходу) × кількість − попередня вартість
 * − попередні коригування, датою зміни (R2): продажі замовлень — cogs_adjustment з order_id, решта — за наслідком
 * виходу. Оцінка revaluation `adj:<movementId>:v<n>` (пул не змінюється). Обмеження (документовано): одиниці, які після
 * цього повернулися на склад, коригуються разом із проданими (повернення оцінене за собівартістю продажу).
 */
async function recomputeStandardValued(
  tx: Tx,
  cctx: CostingContext,
  a: {
    warehouseId: string;
    stockItemId: string;
    variantId: string | null;
    unitAt: (date: string) => Promise<bigint>;
    effectiveFrom: string;
    until: string | null;
    newCostId: string;
    operationId: string;
    actorId: string;
    today: string;
  },
): Promise<{ result: ValueItemResult; count: number }> {
  const result: ValueItemResult = { entries: [], orders: new Map(), valued: 0 };
  const outflows = await tx
    .select()
    .from(inventoryValuations)
    .where(
      and(
        eq(inventoryValuations.warehouseId, a.warehouseId),
        eq(inventoryValuations.stockItemId, a.stockItemId),
        eq(inventoryValuations.kind, "outflow"),
        sql`${inventoryValuations.occurredOn} >= ${a.effectiveFrom}`,
        a.until ? sql`${inventoryValuations.occurredOn} < ${a.until}` : undefined,
      ),
    )
    .orderBy(asc(inventoryValuations.seq));
  if (outflows.length === 0) return { result, count: 0 };
  // Завершення «до вже проданих» за ручною собівартістю інших операцій (цієї операції — уже за новою).
  const completionRows = await tx
    .select({ valuationId: inventoryValuationCompletions.valuationId, qty: inventoryValuationCompletions.qty, value: inventoryValuationCompletions.value, eventKey: inventoryValuationCompletions.eventKey })
    .from(inventoryValuationCompletions)
    .where(and(inArray(inventoryValuationCompletions.valuationId, outflows.map((o) => o.id)), eq(inventoryValuationCompletions.basis, "owner_standard")));
  const ownPrefix = `${ownerCompletionKey(a.operationId, a.stockItemId)}:`;
  const completedByOwner = new Map<string, { qty: number; value: bigint }>();
  for (const c of completionRows) {
    if (c.eventKey.startsWith(ownPrefix)) continue;
    const t = completedByOwner.get(c.valuationId) ?? { qty: 0, value: 0n };
    t.qty += c.qty;
    t.value += toMinor(c.value);
    completedByOwner.set(c.valuationId, t);
  }
  const { state } = await lockCostState(tx, a.warehouseId, a.stockItemId, cctx.valuationCurrency);
  let count = 0;
  for (const o of outflows) {
    if (!o.movementId) continue;
    const direct = detailNumber(o, "standardQty") > 0 && detailString(o, "standardCostId") !== a.newCostId;
    const directQty = direct ? detailNumber(o, "standardQty") : 0;
    const directValue = direct ? detailMinor(o, "standardValue") : 0n;
    const completed = completedByOwner.get(o.id) ?? { qty: 0, value: 0n };
    const qty = directQty + completed.qty;
    if (qty === 0) continue;
    const unit = await a.unitAt(o.occurredOn);
    const delta = unit * BigInt(qty) - directValue - completed.value - (await priorStandardDeltas(tx, o.movementId));
    if (delta === 0n) continue;
    const n = (await tx.select({ c: sql<number>`count(*)`.mapWith(Number) }).from(inventoryValuations).where(like(inventoryValuations.eventKey, `adj:${o.movementId}:v%`)))[0]!.c + 1;
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
        valueSource: "owner_standard",
        drawnLayers: [],
        originalAmount: null,
        originalCurrency: null,
        rateDate: null,
        rateSource: null,
        after: { knownQty: state.knownQty, knownValue: state.knownValue, unknownQty: state.unknownQty, deficitQty: state.deficitQty },
        details: {
          standardRecompute: true,
          outflowMovementId: o.movementId,
          standardDelta: minorToDecimal(delta),
          stockItemCostId: a.newCostId,
          directQty,
          completedQty: completed.qty,
        },
      },
      eventKey: `adj:${o.movementId}:v${n}`,
      warehouseId: a.warehouseId,
      stockItemId: a.stockItemId,
      currency: state.currency,
      movementId: null,
      movementSeq: null,
      orderId: o.orderId,
      orderLineItemId: o.orderLineItemId,
      occurredOn: a.today,
    });
    const effect = detailString(o, "effect");
    const category = effect === "order" ? (detailString(o, "movementType") === "material_consume" ? "packaging" : "cogs_adjustment") : effect === "packaging_unlinked" ? "packaging_unlinked" : "inventory_loss";
    const entry: EntryInput = {
      idempotencyKey: financeKeys.batchAdjustment(o.movementId, n, "std"),
      category,
      recognizedOn: a.today,
      fxOn: a.today,
      amount: minorToDecimal(-delta),
      currency: state.currency,
      orderId: o.orderId,
      orderLineItemId: o.orderLineItemId,
      stockItemId: a.stockItemId,
      variantId: a.variantId,
      quantity: qty,
      sourceType: "cost_adjustment",
      sourceId: valuationId,
      details: { kind: "standard_recompute", stockItemCostId: a.newCostId },
    };
    result.entries.push({ actorId: a.actorId, entry });
    if (o.orderId) result.orders.set(o.orderId, a.actorId);
    count += 1;
  }
  return { result, count };
}

async function priorStandardDeltas(tx: Tx, movementId: string): Promise<bigint> {
  const rows = await tx
    .select({ details: inventoryValuations.details })
    .from(inventoryValuations)
    .where(sql`${inventoryValuations.details}->>'outflowMovementId' = ${movementId} and ${inventoryValuations.details}->>'standardRecompute' = 'true'`);
  return rows.reduce((s, r) => s + detailMinor(r as Pick<ValuationRow, "details">, "standardDelta"), 0n);
}

// ---------------------------------------------------------------------------
// Попередній перегляд (кількості — без грошей)
// ---------------------------------------------------------------------------

export interface ManualCostPreview {
  items: number;
  /** На складі без собівартості (відкриті невідомі шари, крім fx_pending). */
  onHandWithoutCost: number;
  /**
   * Продано без собівартості з дати effective_from, які ручна собівартість «до вже проданих» справді завершить (одиниці з
   * невідомих шарів, ще не завершені й не повернені; до наступного рядка ручної собівартості).
   */
  soldWithoutCost: number;
  /** Замовлень серед soldWithoutCost. */
  orders: number;
  /**
   * Продано без собівартості, але ручна собівартість їх НЕ завершить: від'ємний залишок (вартість прийде з надходженням,
   * D-20) або надходження в іншій валюті чекає курсу.
   */
  soldAwaitingReceipt: number;
}

/** «Без собівартості: на складі 12 од., продано 7 од. (5 замовлень)» перед збереженням (finance.view). */
export async function manualCostPreview(ctx: Pick<ServiceContext, "db" | "actor">, input: { target: ManualCostTarget; effectiveFrom: string }): Promise<ManualCostPreview> {
  requireFinance(ctx, "view");
  const effectiveFrom = parseIsoDate(input.effectiveFrom);
  if (!effectiveFrom) throw badInput("effectiveFrom");
  const items =
    input.target.kind === "stockItems"
      ? await resolveCostTarget(ctx.db, input.target)
      : await stockItemsOfModelColor(ctx.db, input.target.model, input.target.color);
  if (items.length === 0) return { items: 0, onHandWithoutCost: 0, soldWithoutCost: 0, orders: 0, soldAwaitingReceipt: 0 };
  const ids = items.map((i) => i.stockItemId);
  const until = new Map<string, string | null>();
  for (const id of ids) until.set(id, await nextEffectiveFrom(ctx.db, id, effectiveFrom));
  return unvaluedCounts(ctx.db, ids, effectiveFrom, items.length, until);
}

async function stockItemsOfModelColor(db: DbOrTx, model: string, color: string | null): Promise<Array<{ stockItemId: string; variantId: string | null }>> {
  const rows = await db
    .select({ stockItemId: stockItems.id, variantId: stockItems.variantId })
    .from(stockItems)
    .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .where(and(eq(productVariants.model, model.trim()), color === null ? isNull(productVariants.color) : eq(productVariants.color, color), isNull(productVariants.removedAt)));
  return rows;
}

/**
 * Кількості без вартості для позицій: на складі (відкриті невідомі шари, крім fx_pending) і продано з дати `from` (до
 * межі `until` позиції, виключно): soldWithoutCost — одиниці, які завершить ручна собівартість «до вже проданих»;
 * soldAwaitingReceipt — решта (від'ємний залишок, курс). Без грошей (лише кількості).
 */
export async function unvaluedCounts(
  db: DbOrTx,
  stockItemIds: readonly string[],
  from: string | null,
  items = stockItemIds.length,
  until: ReadonlyMap<string, string | null> = new Map(),
): Promise<ManualCostPreview> {
  const ids = [...new Set(stockItemIds)];
  if (ids.length === 0) return { items, onHandWithoutCost: 0, soldWithoutCost: 0, orders: 0, soldAwaitingReceipt: 0 };
  const [stock] = await db
    .select({ units: sql<number>`coalesce(sum(${inventoryCostState.unknownQty}), 0)`.mapWith(Number) })
    .from(inventoryCostState)
    .where(inArray(inventoryCostState.stockItemId, ids));
  const [fx] = await db
    .select({ units: sql<number>`coalesce(sum(${inventoryCostLayers.qtyOpen}), 0)`.mapWith(Number) })
    .from(inventoryCostLayers)
    .where(
      and(
        inArray(inventoryCostLayers.stockItemId, ids),
        eq(inventoryCostLayers.reason, "fx_pending"),
        isNull(inventoryCostLayers.closedAt),
        gt(inventoryCostLayers.qtyOpen, 0),
      ),
    );
  const fxUnits = fx?.units ?? 0;
  const outflows = (await outflowsWithDrawsSince(db, null, ids, from)).filter((o) => {
    const u = until.get(o.stockItemId);
    return !u || o.occurredOn < u;
  });
  const split = await soldWithoutCostSplit(db, outflows);
  let sold = 0;
  let awaiting = 0;
  const orders = new Set<string>();
  for (const o of outflows) {
    const s = split.get(o.id)!;
    sold += s.completable;
    awaiting += s.awaiting;
    if (s.completable > 0 && o.orderId) orders.add(o.orderId);
  }
  return { items, onHandWithoutCost: Math.max(0, (stock?.units ?? 0) - fxUnits), soldWithoutCost: sold, orders: orders.size, soldAwaitingReceipt: awaiting };
}

/** Для кожного виходу: одиниці без вартості, які завершить ручна собівартість, і ті, що чекають надходження / курсу. */
export async function soldWithoutCostSplit(db: DbOrTx, outflows: readonly ValuationRow[]): Promise<Map<string, { completable: number; awaiting: number }>> {
  const out = new Map<string, { completable: number; awaiting: number }>();
  if (outflows.length === 0) return out;
  const [reasonOf, totals, returned] = await Promise.all([
    drawnLayerReasons(db, outflows),
    completionTotals(db, outflows.map((o) => o.id)),
    returnedUnvaluedBySale(db, outflows.map((o) => o.id)),
  ]);
  for (const o of outflows) {
    const done = totals.get(o.id);
    out.set(o.id, unvaluedSplitOf(o, ownerPendingDraws(o, reasonOf, done), returned.get(o.id)?.qtyIn ?? 0, done?.qty ?? 0));
  }
  return out;
}

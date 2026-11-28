/**
 * Етап 6, WP2: СЕРВІСИ ЧИТАННЯ собівартості (requireFinance "view" у кожній функції; docs/stage6-design.md §6.7, §18.7):
 * вартість запасів на дату, собівартість моделей і кольорів, партії (планова / в обліку / коригування), брак і списання,
 * історія собівартості, «Потребує уваги» (без собівартості на складі / продано). Джерело вартості складу — рушій оцінки
 * (inventory_valuations / inventory_cost_state); суми P&L (собівартість проданих, брак) — журнал finance_entries (F1).
 * Відсутнє — null («—»), ніколи не 0. Жодних даних покупців.
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "~/db/client.server";
import {
  financeEntries,
  inventoryBalances,
  inventoryCostLayers,
  inventoryCostState,
  inventoryValuations,
  packagingMaterials,
  productionBatchLines,
  productionBatches,
  products,
  productVariants,
  stockItemCosts,
  stockItems,
} from "~/db/schema";
import { toMinor } from "~/lib/money";
import { parseIsoDate } from "~/lib/periods";
import { requireFinance } from "~/modules/finance/core/access.server";
import { listFinanceChanges, type FinanceChangeRow } from "~/modules/finance/core/change-log.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { batchCostSummary, defectRatePercent, inProductionQuantity, landedUnitCost, lineProduced, lineRemaining, billedQuantity } from "~/modules/production/calc";
import { displayVariantTitle } from "~/modules/warehouse/constants";
import type { ServiceContext } from "~/server/types";
import { centsAverage, currencyQuantum, minorToDecimal, mulDivQ } from "./engine";
import { loadPoolValues, poolStatesAt } from "./pool-read.server";
import { batchWriteOffEligible } from "./batch-writeoff.server";
import { convertToValuation, loadCostingContext, type CostingContext } from "./inputs.server";
import { soldWithoutCostSplit } from "./manual-costs.server";
import { batchReceiptTargets } from "./revalue.server";
import { detailMinor, detailString } from "./store.server";

type Ctx = Pick<ServiceContext, "db" | "actor">;

/** Чиста допоміжна функція (без даних) — реекспорт для сумісності тестів. */
export { centsAverage };

const money = (minor: bigint) => minorToDecimal(minor);

// ---------------------------------------------------------------------------
// Вартість запасів на дату (§6.7; золотий G18)
// ---------------------------------------------------------------------------

export interface InventoryValueAt {
  date: string;
  currency: string;
  products: { value: string; units: number; items: number };
  materials: { value: string; units: number; items: number };
  /** Одиниці без собівартості (невідомі шари) на дату. */
  unitsWithoutCost: number;
  itemsWithoutCost: number;
  /** Від'ємний залишок (дефіцит) на дату. */
  negativeUnits: number;
  /** Поточні (не на дату): брак — кількість, вартість 0; у виробництві — планова вартість за валютами партій. */
  current: { defectiveUnits: number; inProduction: Array<{ currency: string; amount: string; units: number }> };
}

export async function inventoryValueAt(ctx: Ctx, input: { date: string }): Promise<InventoryValueAt> {
  requireFinance(ctx, "view");
  const date = parseIsoDate(input.date);
  if (!date) throw new RangeError("invalid date");
  const settings = await loadFinanceSettings(ctx.db);
  const states = await poolStatesAt(ctx.db, date);
  const out: InventoryValueAt = {
    date,
    currency: settings.valuationCurrency,
    products: { value: "0.00", units: 0, items: 0 },
    materials: { value: "0.00", units: 0, items: 0 },
    unitsWithoutCost: 0,
    itemsWithoutCost: 0,
    negativeUnits: 0,
    current: { defectiveUnits: 0, inProduction: [] },
  };
  const sums = { product: 0n, material: 0n };
  for (const s of states) {
    const bucket = s.kind === "material" ? out.materials : out.products;
    sums[s.kind] += s.knownValue;
    bucket.units += s.knownQty;
    if (s.knownQty > 0) bucket.items += 1;
    out.unitsWithoutCost += s.unknownQty;
    if (s.unknownQty > 0) out.itemsWithoutCost += 1;
    out.negativeUnits += s.deficitQty;
  }
  out.products.value = money(sums.product);
  out.materials.value = money(sums.material);
  const warehouse = await getDefaultWarehouse(ctx.db);
  const [def] = await ctx.db
    .select({ units: sql<number>`coalesce(sum(${inventoryBalances.defective}), 0)`.mapWith(Number) })
    .from(inventoryBalances)
    .where(eq(inventoryBalances.warehouseId, warehouse.id));
  out.current.defectiveUnits = def?.units ?? 0;
  out.current.inProduction = await plannedInProduction(ctx.db);
  return out;
}

/** «У виробництві (планова вартість)» = Σ in_production × landedUnitCost відкритих рядків партій, за валютами партій. */
async function plannedInProduction(db: DbOrTx): Promise<Array<{ currency: string; amount: string; units: number }>> {
  const batches = await db
    .select()
    .from(productionBatches)
    .where(inArray(productionBatches.status, ["in_production", "partially_received", "received"]));
  if (batches.length === 0) return [];
  const lines = await db.select().from(productionBatchLines).where(inArray(productionBatchLines.batchId, batches.map((b) => b.id)));
  const byCurrency = new Map<string, { minor: bigint; units: number }>();
  for (const b of batches) {
    const own = lines.filter((l) => l.batchId === b.id);
    const q = (l: (typeof own)[number]) => ({ ordered: l.quantityOrdered, received: l.quantityReceived, defective: l.quantityDefective });
    const totalBilled = own.reduce((s, l) => s + billedQuantity(q(l), b.status), 0);
    for (const l of own) {
      const units = inProductionQuantity(b.status, lineRemaining(q(l)));
      const currency = l.costCurrency ?? b.costCurrency;
      if (units <= 0 || !currency) continue;
      const unit = landedUnitCost(l.unitCost, b.costCurrency === currency ? b.extraCost : null, totalBilled);
      if (unit === null) continue;
      const t = byCurrency.get(currency) ?? { minor: 0n, units: 0 };
      t.minor += toMinor(unit) * BigInt(units);
      t.units += units;
      byCurrency.set(currency, t);
    }
  }
  return [...byCurrency].sort(([a], [b]) => a.localeCompare(b)).map(([currency, t]) => ({ currency, amount: money(t.minor), units: t.units }));
}

// ---------------------------------------------------------------------------
// Собівартість моделей і кольорів (§6.7; G18)
// ---------------------------------------------------------------------------

export interface ModelColorRow {
  model: string | null;
  /** Варіанти без моделі групуються за товаром (назва товару замість моделі). */
  productTitle: string | null;
  color: string | null;
  variants: number;
  /** (а) ручна собівартість (поточна підтверджена); різні значення → min / max. */
  manual: { min: string; max: string; currency: string } | null;
  manualMixedCurrency: boolean;
  /** (б) поточна середня на складі (Σ known_value / Σ known_qty). */
  stock: { qty: number; value: string; average: string | null };
  unitsWithoutCost: number;
  /**
   * (в) собівартість проданої одиниці за період = Σ cogs / Σ кількість (журнал; разом із пізніми завершеннями R3 — у них
   * своя кількість). null — продажів з відомою собівартістю немає.
   */
  sold: { qty: number; value: string; average: string | null } | null;
  /** (г) остання партія: собівартість якісної одиниці (у валюті партії). */
  lastBatch: { number: string; costPerGoodUnit: string | null; currency: string | null } | null;
}

export interface ModelColorCosts {
  currency: string;
  rows: ModelColorRow[];
  /** Підсумки моделей (середня на складі моделі — зважено за кількістю); без моделі — за товаром. */
  models: Array<{ model: string | null; productTitle: string | null; qty: number; value: string; average: string | null }>;
}

const reversals = alias(financeEntries, "costs_rev");

export async function modelColorCosts(ctx: Ctx, input: { from: string; to: string; today: string }): Promise<ModelColorCosts> {
  requireFinance(ctx, "view");
  const settings = await loadFinanceSettings(ctx.db);
  const variants = await ctx.db
    .select({
      variantId: productVariants.id,
      model: productVariants.model,
      color: productVariants.color,
      stockItemId: stockItems.id,
      productId: products.id,
      productTitle: products.title,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
    .where(isNull(productVariants.removedAt))
    .orderBy(asc(productVariants.model), asc(products.title), asc(productVariants.color));
  const stockIds = variants.map((v) => v.stockItemId).filter((x): x is string => Boolean(x));
  const pools = await loadPoolValues(ctx.db, stockIds);
  // (а) поточна підтверджена ручна собівартість (на сьогодні) кожної позиції.
  const costRows = stockIds.length
    ? await ctx.db
        .selectDistinctOn([stockItemCosts.stockItemId], { stockItemId: stockItemCosts.stockItemId, unitCost: stockItemCosts.unitCost, currency: stockItemCosts.currency })
        .from(stockItemCosts)
        .where(and(inArray(stockItemCosts.stockItemId, stockIds), eq(stockItemCosts.confirmed, true), lte(stockItemCosts.effectiveFrom, input.today)))
        .orderBy(stockItemCosts.stockItemId, desc(stockItemCosts.effectiveFrom), desc(stockItemCosts.createdAt))
    : [];
  const manualOf = new Map(costRows.map((r) => [r.stockItemId, r]));
  // (в) собівартість проданих за період — чинні записи cogs (без сторно) з кількістю.
  const sold = stockIds.length
    ? await ctx.db
        .select({
          stockItemId: financeEntries.stockItemId,
          value: sql<string>`coalesce(sum(${financeEntries.amount}), 0)`,
          qty: sql<number>`coalesce(sum(${financeEntries.quantity}), 0)`.mapWith(Number),
        })
        .from(financeEntries)
        .where(
          and(
            inArray(financeEntries.stockItemId, stockIds),
            eq(financeEntries.category, "cogs"),
            eq(financeEntries.currency, settings.valuationCurrency),
            gte(financeEntries.recognizedOn, input.from),
            lte(financeEntries.recognizedOn, input.to),
            isNull(financeEntries.reversesEntryId),
            notExists(ctx.db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
            // Завершення (R3, details.completion) мають власну кількість — кожна одиниця рахується один раз (Σ cogs / Σ кількість).
          ),
        )
        .groupBy(financeEntries.stockItemId)
    : [];
  const soldOf = new Map(sold.map((r) => [r.stockItemId!, r]));
  const lastBatches = await lastBatchByVariant(ctx.db, variants.map((v) => v.variantId));
  const groups = new Map<string, typeof variants>();
  const modelKey = (v: (typeof variants)[number]) => (v.model !== null ? `m:${v.model}` : `p:${v.productId}`);
  for (const v of variants) {
    const key = `${modelKey(v)}\u0000${v.color ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), v]);
  }
  const rows: ModelColorRow[] = [];
  const models = new Map<string, { model: string | null; productTitle: string | null; qty: number; value: bigint }>();
  for (const list of groups.values()) {
    const first = list[0]!;
    let qty = 0;
    let value = 0n;
    let unknown = 0;
    let soldQty = 0;
    let soldValue = 0n;
    const manual: Array<{ unitCost: string; currency: string }> = [];
    let last: ModelColorRow["lastBatch"] = null;
    let lastAt = 0;
    for (const v of list) {
      if (v.stockItemId) {
        const p = pools.get(v.stockItemId);
        if (p) {
          qty += p.knownQty;
          value += toMinor(p.knownValue);
          unknown += p.unknownQty;
        }
        const m = manualOf.get(v.stockItemId);
        if (m) manual.push(m);
        const s = soldOf.get(v.stockItemId);
        if (s && s.qty > 0) {
          soldQty += s.qty;
          soldValue += -toMinor(s.value);
        }
      }
      const b = lastBatches.get(v.variantId);
      if (b && b.at > lastAt) {
        lastAt = b.at;
        last = { number: b.number, costPerGoodUnit: b.costPerGoodUnit, currency: b.currency };
      }
    }
    const currencies = new Set(manual.map((m) => m.currency));
    const sorted = [...manual].sort((a, b) => (toMinor(a.unitCost) < toMinor(b.unitCost) ? -1 : 1));
    rows.push({
      model: first.model,
      productTitle: first.model === null ? first.productTitle : null,
      color: first.color,
      variants: list.length,
      manual: sorted.length && currencies.size === 1 ? { min: sorted[0]!.unitCost, max: sorted[sorted.length - 1]!.unitCost, currency: sorted[0]!.currency } : null,
      manualMixedCurrency: currencies.size > 1,
      stock: { qty, value: money(value), average: centsAverage(value, qty) },
      unitsWithoutCost: unknown,
      sold: soldQty > 0 ? { qty: soldQty, value: money(soldValue), average: centsAverage(soldValue, soldQty) } : null,
      lastBatch: last,
    });
    const mk = modelKey(first);
    const t = models.get(mk) ?? { model: first.model, productTitle: first.model === null ? first.productTitle : null, qty: 0, value: 0n };
    t.qty += qty;
    t.value += value;
    models.set(mk, t);
  }
  return {
    currency: settings.valuationCurrency,
    rows,
    models: [...models.values()].map((m) => ({ model: m.model, productTitle: m.productTitle, qty: m.qty, value: money(m.value), average: centsAverage(m.value, m.qty) })),
  };
}

/** Остання партія з якісними одиницями варіанта: собівартість якісної одиниці позиції (batchCostSummary). */
async function lastBatchByVariant(db: DbOrTx, variantIds: readonly string[]): Promise<Map<string, { number: string; costPerGoodUnit: string | null; currency: string | null; at: number }>> {
  const out = new Map<string, { number: string; costPerGoodUnit: string | null; currency: string | null; at: number }>();
  if (variantIds.length === 0) return out;
  const lines = await db
    .select({ l: productionBatchLines, b: productionBatches })
    .from(productionBatchLines)
    .innerJoin(productionBatches, eq(productionBatches.id, productionBatchLines.batchId))
    .where(and(inArray(productionBatchLines.variantId, [...variantIds]), sql`${productionBatchLines.quantityReceived} > 0`))
    .orderBy(desc(productionBatches.createdAt))
    .limit(2000);
  const batchIds = [...new Set(lines.map((x) => x.b.id))];
  const allLines = batchIds.length ? await db.select().from(productionBatchLines).where(inArray(productionBatchLines.batchId, batchIds)) : [];
  const summaries = new Map<string, ReturnType<typeof batchCostSummary>>();
  for (const id of batchIds) {
    const b = lines.find((x) => x.b.id === id)!.b;
    summaries.set(
      id,
      batchCostSummary(
        allLines.filter((l) => l.batchId === id).map((l) => ({ id: l.id, ordered: l.quantityOrdered, received: l.quantityReceived, defective: l.quantityDefective, unitCost: l.unitCost, costCurrency: l.costCurrency })),
        b.extraCost,
        b.costCurrency,
        b.status,
      ),
    );
  }
  for (const { l, b } of lines) {
    if (out.has(l.variantId)) continue;
    const s = summaries.get(b.id)!;
    out.set(l.variantId, { number: b.number, costPerGoodUnit: s.lines.find((x) => x.id === l.id)?.costPerGoodUnit ?? null, currency: s.currency, at: b.createdAt.getTime() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Партії (§6.7, §18.7)
// ---------------------------------------------------------------------------

export interface BatchCostRow {
  batchId: string;
  number: string;
  title: string;
  status: string;
  currency: string | null;
  /** Планова / остаточна сума (batchCostSummary.total) у валюті партії. */
  plannedTotal: string | null;
  producedTotal: string | null;
  costPerGoodUnit: string | null;
  defectRate: number | null;
  /** Вартість браку (у валюті партії) = Σ брак рядка × повна собівартість одиниці рядка (producedValue / виготовлено). */
  defectValue: string | null;
  /**
   * Еквівалент виготовленого у валюті оцінки: ціль кожного надходження (як у переоцінці) за курсом дати надходження;
   * null — немає надходжень або курсу на якусь дату.
   */
  producedInValuation: string | null;
  /** В обліку (валюта оцінки): Σ вартостей надходжень + коригування. */
  booked: string | null;
  bookedCurrency: string;
  adjustments: { toStock: string; toSales: string; toLosses: string; count: number };
  writeOffEligible: boolean;
}

export async function batchCosts(ctx: Ctx, opts: { limit?: number } = {}): Promise<BatchCostRow[]> {
  requireFinance(ctx, "view");
  const settings = await loadFinanceSettings(ctx.db);
  const batches = await ctx.db
    .select()
    .from(productionBatches)
    .where(sql`${productionBatches.status} <> 'planned'`)
    .orderBy(desc(productionBatches.createdAt))
    .limit(Math.min(Math.max(opts.limit ?? 50, 1), 200));
  if (batches.length === 0) return [];
  const ids = batches.map((b) => b.id);
  const lines = await ctx.db.select().from(productionBatchLines).where(inArray(productionBatchLines.batchId, ids));
  const vals = await ctx.db
    .select()
    .from(inventoryValuations)
    .where(inArray(sql<string>`${inventoryValuations.details}->>'productionBatchId'`, ids));
  const cctx = await loadCostingContext(ctx.db);
  const equivalent = new Map<string, string | null>();
  for (const b of batches) equivalent.set(b.id, await producedInValuation(ctx.db, cctx, b));
  return batches.map((b) => {
    const own = lines.filter((l) => l.batchId === b.id);
    const q = (l: (typeof own)[number]) => ({ ordered: l.quantityOrdered, received: l.quantityReceived, defective: l.quantityDefective });
    const summary = batchCostSummary(
      own.map((l) => ({ id: l.id, ...q(l), unitCost: l.unitCost, costCurrency: l.costCurrency })),
      b.extraCost,
      b.costCurrency,
      b.status,
    );
    const mine = vals.filter((v) => detailString(v, "productionBatchId") === b.id);
    let booked = 0n;
    let anyBooked = false;
    const adj = { stock: 0n, sales: 0n, loss: 0n, count: 0 };
    for (const v of mine) {
      if (v.eventKey.startsWith("mv:") && v.value !== null) {
        booked += toMinor(v.value);
        anyBooked = true;
      } else if (v.kind === "revaluation") {
        booked += detailMinor(v, "deltaTotal");
        adj.stock += detailMinor(v, "deltaStock");
        adj.sales += detailMinor(v, "deltaSales");
        adj.loss += detailMinor(v, "deltaLoss");
        adj.count += 1;
        anyBooked = true;
      } else if (v.kind === "stock_completion" && detailString(v, "receiptMovementId")) {
        booked += detailMinor(v, "deltaTotal");
        anyBooked = true;
        adj.count += 1;
      }
    }
    const totals = own.reduce((t, l) => ({ defective: t.defective + l.quantityDefective, produced: t.produced + lineProduced(q(l)) }), { defective: 0, produced: 0 });
    // Вартість браку: брак × повна собівартість одиниці рядка (виготовлена вартість рядка / виготовлено), у валюті партії.
    let defectMinor: bigint | null = summary.currency ? 0n : null;
    for (const l of own) {
      const line = summary.lines.find((x) => x.id === l.id);
      const produced = lineProduced(q(l));
      if (l.quantityDefective === 0 || defectMinor === null) continue;
      if (!line || line.producedValue === null || produced <= 0) {
        defectMinor = null;
        continue;
      }
      defectMinor += mulDivQ(toMinor(line.producedValue), BigInt(l.quantityDefective), BigInt(produced), currencyQuantum(summary.currency!));
    }
    return {
      batchId: b.id,
      number: b.number,
      title: b.title,
      status: b.status,
      currency: summary.currency,
      plannedTotal: summary.total,
      producedTotal: summary.producedTotal,
      costPerGoodUnit: summary.costPerGoodUnit,
      defectRate: defectRatePercent(totals.defective, totals.produced),
      defectValue: defectMinor === null ? null : money(defectMinor),
      producedInValuation: equivalent.get(b.id) ?? null,
      booked: anyBooked ? money(booked) : null,
      bookedCurrency: settings.valuationCurrency,
      adjustments: { toStock: money(adj.stock), toSales: money(adj.sales), toLosses: money(adj.loss), count: adj.count },
      writeOffEligible: batchWriteOffEligible(b.status, own.map(q)),
    };
  });
}

/** Еквівалент виготовленого у валюті оцінки: цілі надходжень (revalue.batchReceiptTargets) за курсом дати кожного. */
async function producedInValuation(db: DbOrTx, cctx: CostingContext, batch: typeof productionBatches.$inferSelect): Promise<string | null> {
  if (!batch.costCurrency) return null;
  const { targets } = await batchReceiptTargets(db, batch);
  if (targets.length === 0) return null;
  let sum = 0n;
  for (const t of targets) {
    const conv = await convertToValuation(db, cctx, t.target, batch.costCurrency, t.occurredOn);
    if (!conv.ok) return null;
    sum += conv.minor;
  }
  return money(sum);
}

// ---------------------------------------------------------------------------
// Брак і списання (журнал за період) + одиниці
// ---------------------------------------------------------------------------

export interface DefectsSummary {
  from: string;
  to: string;
  /** Σ записів за видом (details.kind) і категорією, за валютами. */
  rows: Array<{ category: "inventory_loss" | "inventory_gain"; kind: string; currency: string; amount: string; entries: number }>;
  /**
   * Одиниці за період: складський брак (позначено / відремонтовано / утилізовано), виробничий брак (надходження партій),
   * пошкоджені повернення покупців (собівартість уже визнана у продажі).
   */
  units: { marked: number; repaired: number; writtenOff: number; production: number; returnsDamaged: number };
}

export async function defectsSummary(ctx: Ctx, input: { from: string; to: string }): Promise<DefectsSummary> {
  requireFinance(ctx, "view");
  const rows = await ctx.db
    .select({
      category: financeEntries.category,
      kind: sql<string>`coalesce(${financeEntries.details}->>'kind', 'other')`,
      currency: financeEntries.currency,
      amount: sql<string>`sum(${financeEntries.amount})`,
      entries: sql<number>`count(*)`.mapWith(Number),
    })
    .from(financeEntries)
    .where(
      and(
        inArray(financeEntries.category, ["inventory_loss", "inventory_gain"]),
        gte(financeEntries.recognizedOn, input.from),
        lte(financeEntries.recognizedOn, input.to),
      ),
    )
    .groupBy(financeEntries.category, sql`coalesce(${financeEntries.details}->>'kind', 'other')`, financeEntries.currency)
    .orderBy(financeEntries.category, sql`2`, financeEntries.currency);
  const units = await ctx.db
    .select({ type: sql<string>`${inventoryValuations.details}->>'movementType'`, qty: sql<number>`coalesce(sum(greatest(${inventoryValuations.qty}, coalesce((${inventoryValuations.details}->>'writtenOffQty')::int, 0))), 0)`.mapWith(Number) })
    .from(inventoryValuations)
    .where(
      and(
        sql`${inventoryValuations.details}->>'movementType' in ('defect_mark', 'defect_repair', 'defect_writeoff')`,
        sql`coalesce((${inventoryValuations.details}->>'pairedReturnDefect')::boolean, false) = false`,
        gte(inventoryValuations.occurredOn, input.from),
        lte(inventoryValuations.occurredOn, input.to),
      ),
    )
    .groupBy(sql`${inventoryValuations.details}->>'movementType'`);
  const u = new Map(units.map((r) => [r.type, r.qty]));
  const [other] = await ctx.db
    .select({
      production: sql<number>`coalesce(sum(case when ${inventoryValuations.details}->>'movementType' = 'receipt_production' then coalesce((${inventoryValuations.details}->>'defectiveQty')::int, 0) else 0 end), 0)`.mapWith(Number),
      returnsDamaged: sql<number>`coalesce(sum(case when ${inventoryValuations.details}->>'kind' = 'customer_return' then coalesce((${inventoryValuations.details}->>'damagedQty')::int, 0) else 0 end), 0)`.mapWith(Number),
    })
    .from(inventoryValuations)
    .where(
      and(
        isNotNull(inventoryValuations.movementId),
        eq(inventoryValuations.kind, "inflow"),
        gte(inventoryValuations.occurredOn, input.from),
        lte(inventoryValuations.occurredOn, input.to),
      ),
    );
  return {
    from: input.from,
    to: input.to,
    rows: rows.map((r) => ({ category: r.category as "inventory_loss" | "inventory_gain", kind: r.kind, currency: r.currency, amount: money(toMinor(r.amount)), entries: r.entries })),
    units: {
      marked: u.get("defect_mark") ?? 0,
      repaired: u.get("defect_repair") ?? 0,
      writtenOff: u.get("defect_writeoff") ?? 0,
      production: other?.production ?? 0,
      returnsDamaged: other?.returnsDamaged ?? 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Потребує уваги: без собівартості на складі / продано (§18.7)
// ---------------------------------------------------------------------------

export interface AttentionRow {
  stockItemId: string;
  kind: "product" | "material";
  title: string;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  onHandWithoutCost: number;
  /** Продано без собівартості, які завершить ручна собівартість «до вже проданих». */
  soldWithoutCost: number;
  /** Замовлень серед soldWithoutCost. */
  orders: number;
  /** Продано без собівартості з від'ємного залишку / до курсу — вартість прийде з надходженням (D-20). */
  soldAwaitingReceipt: number;
  /** Очікує курсу (fx_pending), одиниць. */
  awaitingRate: number;
}

export async function costsAttention(ctx: Ctx, opts: { limit?: number } = {}): Promise<AttentionRow[]> {
  requireFinance(ctx, "view");
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const stock = await ctx.db
    .select({ stockItemId: inventoryCostState.stockItemId, unknown: inventoryCostState.unknownQty })
    .from(inventoryCostState)
    .where(sql`${inventoryCostState.unknownQty} > 0`);
  const outflows = await ctx.db
    .select()
    .from(inventoryValuations)
    .where(and(eq(inventoryValuations.kind, "outflow"), sql`${inventoryValuations.unknownQty} + ${inventoryValuations.deficitQty} > 0`));
  const split = await soldWithoutCostSplit(ctx.db, outflows);
  const sold = new Map<string, { units: number; awaiting: number; orders: Set<string> }>();
  for (const o of outflows) {
    const s = split.get(o.id)!;
    if (s.completable + s.awaiting <= 0) continue;
    const t = sold.get(o.stockItemId) ?? { units: 0, awaiting: 0, orders: new Set<string>() };
    t.units += s.completable;
    t.awaiting += s.awaiting;
    if (o.orderId && s.completable > 0) t.orders.add(o.orderId);
    sold.set(o.stockItemId, t);
  }
  const fxRows = await ctx.db
    .select({ id: inventoryCostLayers.stockItemId, n: sql<number>`coalesce(sum(${inventoryCostLayers.qtyOpen}), 0)`.mapWith(Number) })
    .from(inventoryCostLayers)
    .where(and(eq(inventoryCostLayers.reason, "fx_pending"), isNull(inventoryCostLayers.closedAt), sql`${inventoryCostLayers.qtyOpen} > 0`))
    .groupBy(inventoryCostLayers.stockItemId);
  const fxOf = new Map(fxRows.map((r) => [r.id, Number(r.n)]));
  const ids = [...new Set([...stock.map((s) => s.stockItemId), ...sold.keys()])];
  if (ids.length === 0) return [];
  const info = await ctx.db
    .select({
      id: stockItems.id,
      kind: stockItems.kind,
      productTitle: products.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      model: productVariants.model,
      color: productVariants.color,
      materialName: packagingMaterials.name,
      materialCode: packagingMaterials.code,
    })
    .from(stockItems)
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(inArray(stockItems.id, ids));
  const unknownOf = new Map(stock.map((s) => [s.stockItemId, s.unknown]));
  const rows: AttentionRow[] = info.map((i) => {
    const awaiting = fxOf.get(i.id) ?? 0;
    return {
      stockItemId: i.id,
      kind: i.kind,
      title: i.kind === "material" ? (i.materialName ?? "—") : (i.productTitle ?? "—"),
      variantTitle: i.kind === "material" ? null : displayVariantTitle(i.variantTitle),
      sku: i.kind === "material" ? i.materialCode : i.sku,
      model: i.model,
      color: i.color,
      onHandWithoutCost: Math.max(0, (unknownOf.get(i.id) ?? 0) - awaiting),
      soldWithoutCost: sold.get(i.id)?.units ?? 0,
      orders: sold.get(i.id)?.orders.size ?? 0,
      soldAwaitingReceipt: sold.get(i.id)?.awaiting ?? 0,
      awaitingRate: awaiting,
    };
  });
  return rows
    .filter((r) => r.onHandWithoutCost + r.soldWithoutCost + r.soldAwaitingReceipt + r.awaitingRate > 0)
    .sort((a, b) => b.soldWithoutCost + b.onHandWithoutCost - (a.soldWithoutCost + a.onHandWithoutCost) || b.soldAwaitingReceipt - a.soldAwaitingReceipt || a.title.localeCompare(b.title))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Історія собівартості (§6.7)
// ---------------------------------------------------------------------------

export interface CostHistory {
  /** Часовий ряд середньої після кожного входу / коригування / завершення (одна позиція). */
  series: Array<{ date: string; kind: string; knownQty: number; knownValue: string; average: string | null; value: string | null }>;
  manualCosts: Array<{ id: string; stockItemId: string; title: string; unitCost: string; currency: string; effectiveFrom: string; source: string; confirmed: boolean; createdAt: Date }>;
  changes: FinanceChangeRow[];
}

export async function costHistory(ctx: Ctx, input: { stockItemId?: string | null; limit?: number } = {}): Promise<CostHistory> {
  requireFinance(ctx, "view");
  const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
  let series: CostHistory["series"] = [];
  if (input.stockItemId) {
    const vals = await ctx.db
      .select()
      .from(inventoryValuations)
      .where(and(eq(inventoryValuations.stockItemId, input.stockItemId), inArray(inventoryValuations.kind, ["inflow", "revaluation", "stock_completion"])))
      .orderBy(desc(inventoryValuations.seq))
      .limit(limit);
    series = vals.reverse().map((v) => ({
      date: v.occurredOn,
      kind: v.kind,
      knownQty: v.knownQtyAfter ?? 0,
      knownValue: v.knownValueAfter ?? "0.00",
      average: v.knownQtyAfter && v.knownValueAfter ? centsAverage(toMinor(v.knownValueAfter), v.knownQtyAfter) : null,
      value: v.value,
    }));
  }
  const manual = await ctx.db
    .select({
      c: stockItemCosts,
      productTitle: products.title,
      variantTitle: productVariants.title,
      materialName: packagingMaterials.name,
    })
    .from(stockItemCosts)
    .innerJoin(stockItems, eq(stockItems.id, stockItemCosts.stockItemId))
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .where(input.stockItemId ? eq(stockItemCosts.stockItemId, input.stockItemId) : undefined)
    .orderBy(desc(stockItemCosts.createdAt), desc(stockItemCosts.id))
    .limit(limit);
  const changes: FinanceChangeRow[] = [];
  for (const entityType of ["stock_item_cost", "batch_cost", "material_cost", "valuation_completion"] as const) {
    changes.push(...(await listFinanceChanges(ctx, { entityType, entityId: input.stockItemId && entityType !== "batch_cost" && entityType !== "material_cost" ? input.stockItemId : undefined, limit })));
  }
  changes.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id);
  return {
    series,
    manualCosts: manual.map((m) => ({
      id: m.c.id,
      stockItemId: m.c.stockItemId,
      title: m.materialName ?? [m.productTitle, displayVariantTitle(m.variantTitle)].filter(Boolean).join(" · "),
      unitCost: m.c.unitCost,
      currency: m.c.currency,
      effectiveFrom: m.c.effectiveFrom,
      source: m.c.source,
      confirmed: m.c.confirmed,
      createdAt: m.c.createdAt,
    })),
    changes: changes.slice(0, limit),
  };
}

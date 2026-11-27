/**
 * Виробництво: читання (перелік партій із фільтрами, картка партії, вибір товарів для сітки модель × колір).
 * Собівартість повертається ЛИШЕ з includeCosts: true — викликач передає can(actor, "finance.view").
 * Без includeCosts у результаті немає жодного поля з цінами (не null, а відсутнє: costs = null).
 */
import { and, asc, count, desc, eq, exists, ilike, inArray, isNotNull, lt, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  inventoryMovements,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  productVariants,
  products,
  PRODUCTION_BATCH_STATUSES,
  type ProductionBatchStatus,
} from "~/db/schema";
import { inventoryKeys } from "~/modules/inventory/keys";
import {
  ACTIVE_BATCH_STATUSES,
  CLOSABLE_STATUSES,
  NOT_RECEIVED_STATUSES,
  RECEIVABLE_STATUSES,
  REMAINDER_KIND,
  batchCostSummary,
  defectRatePercent,
  inProductionQuantity,
  isOverdue,
  isStatusIn,
  lineOverReceived,
  lineProduced,
  lineRemaining,
  quantityTotals,
  type CostSummary,
  type QuantityTotals,
  type RemainderKind,
} from "./calc";
import { UUID_RE } from "./batches.server";

/** Shopify називає єдиний варіант товару «Default Title» — не показуємо. */
const DEFAULT_VARIANT_TITLE = "Default Title";
const cleanVariantTitle = (title: string | null) => (title && title !== DEFAULT_VARIANT_TITLE ? title : null);
const likePattern = (search: string) => `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const activeProduct = or(sql`${products.status} is null`, inArray(products.status, ["ACTIVE", "active", "DRAFT", "draft"]));

export interface BatchListFilters {
  statuses?: ProductionBatchStatus[];
  /** Номер, назва, виробник, назва товару або SKU позиції. */
  search?: string;
  productIds?: string[];
  models?: string[];
  colors?: string[];
  /** Лише прострочені (планова дата < сьогодні, ще не отримано). */
  overdue?: boolean;
}

export interface BatchListOptions {
  /** Сьогодні за Києвом (YYYY-MM-DD) — для прострочення. */
  today: string;
  includeCosts?: boolean;
  limit?: number;
  offset?: number;
}

export interface BatchLineView {
  id: string;
  variantId: string;
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  ordered: number;
  received: number;
  defective: number;
  produced: number;
  remaining: number;
  overReceived: number;
  defectRate: number | null;
  version: number;
}

export interface BatchCostView {
  currency: string | null;
  complete: boolean;
  total: string | null;
  costPerGoodUnit: string | null;
}

export interface BatchListRow {
  id: string;
  number: string;
  title: string;
  status: ProductionBatchStatus;
  plannedReadyDate: string | null;
  manufacturer: string | null;
  overdue: boolean;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  totals: QuantityTotals;
  /** Що означає totals.remaining у цьому стані (до виготовлення / у виробництві / не виготовлено). */
  remainderKind: RemainderKind;
  /** Одиниць партії в кошику складу «У виробництві» (0 для запланованої, закритої, скасованої). */
  inProduction: number;
  /** До 3 товарів партії (назва, зображення Shopify). */
  products: Array<{ id: string; title: string; imageUrl: string | null }>;
  productCount: number;
  /** Лише з includeCosts. */
  cost: BatchCostView | null;
}

export interface BatchListResult {
  rows: BatchListRow[];
  total: number;
  /** Кількість партій за станами (з урахуванням інших фільтрів, без фільтра стану). */
  statusCounts: Record<ProductionBatchStatus, number>;
  /** Прострочені (з урахуванням інших фільтрів). */
  overdueCount: number;
}

function lineMatch(db: DbOrTx, cond: SQL | undefined): SQL {
  return exists(
    db
      .select({ one: sql`1` })
      .from(productionBatchLines)
      .innerJoin(productVariants, eq(productVariants.id, productionBatchLines.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productionBatchLines.batchId, productionBatches.id), cond)),
  );
}

function overdueCondition(today: string): SQL {
  return and(
    isNotNull(productionBatches.plannedReadyDate),
    lt(productionBatches.plannedReadyDate, today),
    inArray(productionBatches.status, [...NOT_RECEIVED_STATUSES]),
  )!;
}

function baseConditions(db: DbOrTx, filters: BatchListFilters, today: string): Array<SQL | undefined> {
  const search = filters.search?.trim() ? likePattern(filters.search) : null;
  return [
    search
      ? or(
          ilike(productionBatches.number, search),
          ilike(productionBatches.title, search),
          ilike(productionBatches.manufacturer, search),
          lineMatch(db, or(ilike(products.title, search), ilike(productVariants.sku, search), ilike(productVariants.title, search))),
        )
      : undefined,
    filters.productIds?.length ? lineMatch(db, inArray(productVariants.productId, filters.productIds)) : undefined,
    filters.models?.length ? lineMatch(db, inArray(productVariants.model, filters.models)) : undefined,
    filters.colors?.length ? lineMatch(db, inArray(productVariants.color, filters.colors)) : undefined,
    filters.overdue ? overdueCondition(today) : undefined,
  ];
}

const ACTIVE_ORDER = sql`case when ${productionBatches.status} in ('planned', 'in_production', 'partially_received', 'received') then 0 else 1 end`;

async function loadLineViews(db: DbOrTx, batchIds: readonly string[]): Promise<Map<string, BatchLineView[]>> {
  const out = new Map<string, BatchLineView[]>();
  if (batchIds.length === 0) return out;
  const rows = await db
    .select({
      line: productionBatchLines,
      productId: products.id,
      productTitle: products.title,
      productImage: products.imageUrl,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      model: productVariants.model,
      color: productVariants.color,
      variantImage: productVariants.imageUrl,
    })
    .from(productionBatchLines)
    .innerJoin(productVariants, eq(productVariants.id, productionBatchLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productionBatchLines.batchId, [...batchIds]))
    .orderBy(asc(products.title), asc(productVariants.model), asc(productVariants.color), asc(productVariants.title), asc(productionBatchLines.id));
  for (const r of rows) {
    const qty = { ordered: r.line.quantityOrdered, received: r.line.quantityReceived, defective: r.line.quantityDefective };
    const view: BatchLineView = {
      id: r.line.id,
      variantId: r.line.variantId,
      productId: r.productId,
      productTitle: r.productTitle,
      variantTitle: cleanVariantTitle(r.variantTitle),
      sku: r.sku,
      model: r.model,
      color: r.color,
      imageUrl: r.variantImage ?? r.productImage,
      ...qty,
      produced: lineProduced(qty),
      remaining: lineRemaining(qty),
      overReceived: lineOverReceived(qty),
      defectRate: defectRatePercent(qty.defective, lineProduced(qty)),
      version: r.line.version,
    };
    out.set(r.line.batchId, [...(out.get(r.line.batchId) ?? []), view]);
  }
  return out;
}

async function loadLineCosts(db: DbOrTx, batchIds: readonly string[]) {
  if (batchIds.length === 0) return new Map<string, Array<typeof productionBatchLines.$inferSelect>>();
  const rows = await db.select().from(productionBatchLines).where(inArray(productionBatchLines.batchId, [...batchIds]));
  const out = new Map<string, Array<typeof productionBatchLines.$inferSelect>>();
  for (const r of rows) out.set(r.batchId, [...(out.get(r.batchId) ?? []), r]);
  return out;
}

function costSummaryOf(batch: typeof productionBatches.$inferSelect, lines: ReadonlyArray<typeof productionBatchLines.$inferSelect>): CostSummary {
  return batchCostSummary(
    lines.map((l) => ({
      id: l.id,
      ordered: l.quantityOrdered,
      received: l.quantityReceived,
      defective: l.quantityDefective,
      unitCost: l.unitCost,
      costCurrency: l.costCurrency,
    })),
    batch.extraCost,
    batch.costCurrency,
    batch.status,
  );
}

/**
 * Перелік партій: активні спершу, далі за плановою датою (ранні першими), новіші вище.
 * Фільтри — стан, пошук, товар/модель/колір позицій, прострочені.
 */
export async function listBatches(db: DbOrTx, filters: BatchListFilters, opts: BatchListOptions): Promise<BatchListResult> {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const base = baseConditions(db, filters, opts.today);
  const statuses = filters.statuses?.filter((s) => (PRODUCTION_BATCH_STATUSES as readonly string[]).includes(s));
  const where = and(...base, statuses?.length ? inArray(productionBatches.status, statuses) : undefined);
  const [rows, [totalRow], statusRows, [overdueRow]] = await Promise.all([
    db
      .select()
      .from(productionBatches)
      .where(where)
      .orderBy(ACTIVE_ORDER, sql`${productionBatches.plannedReadyDate} asc nulls last`, desc(productionBatches.createdAt), desc(productionBatches.id))
      .limit(limit)
      .offset(offset),
    db.select({ c: count() }).from(productionBatches).where(where),
    db
      .select({ status: productionBatches.status, c: count() })
      .from(productionBatches)
      .where(and(...base))
      .groupBy(productionBatches.status),
    db
      .select({ c: count() })
      .from(productionBatches)
      .where(and(...base.slice(0, 4), overdueCondition(opts.today))),
  ]);
  const ids = rows.map((r) => r.id);
  const [lineViews, lineCosts] = await Promise.all([loadLineViews(db, ids), opts.includeCosts ? loadLineCosts(db, ids) : Promise.resolve(null)]);
  const statusCounts = Object.fromEntries(PRODUCTION_BATCH_STATUSES.map((s) => [s, 0])) as Record<ProductionBatchStatus, number>;
  for (const r of statusRows) statusCounts[r.status] = Number(r.c);
  return {
    total: Number(totalRow?.c ?? 0),
    statusCounts,
    overdueCount: Number(overdueRow?.c ?? 0),
    rows: rows.map((b) => {
      const lines = lineViews.get(b.id) ?? [];
      const productMap = new Map<string, { id: string; title: string; imageUrl: string | null }>();
      for (const l of lines) if (!productMap.has(l.productId)) productMap.set(l.productId, { id: l.productId, title: l.productTitle, imageUrl: l.imageUrl });
      let cost: BatchCostView | null = null;
      if (lineCosts) {
        const s = costSummaryOf(b, lineCosts.get(b.id) ?? []);
        cost = { currency: s.currency, complete: s.complete, total: s.total, costPerGoodUnit: s.costPerGoodUnit };
      }
      const totals = quantityTotals(lines);
      return {
        id: b.id,
        number: b.number,
        title: b.title,
        status: b.status,
        plannedReadyDate: b.plannedReadyDate,
        manufacturer: b.manufacturer,
        overdue: isOverdue(b.status, b.plannedReadyDate, opts.today),
        version: b.version,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
        totals,
        remainderKind: REMAINDER_KIND[b.status],
        inProduction: inProductionQuantity(b.status, totals.remaining),
        products: [...productMap.values()].slice(0, 3),
        productCount: productMap.size,
        cost,
      };
    }),
  };
}

/** Кількість активних партій (заплановано / у виробництві / частково отримано) — для панелі й розділу. */
export async function countActiveBatches(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(productionBatches)
    .where(inArray(productionBatches.status, ["planned", "in_production", "partially_received"]));
  return Number(row?.c ?? 0);
}

export interface BatchFilterOptions {
  products: Array<{ id: string; title: string }>;
  models: string[];
  colors: string[];
}

/** Значення фільтрів переліку: товари, моделі й кольори, що трапляються в позиціях партій. */
export async function listBatchFilterOptions(db: DbOrTx): Promise<BatchFilterOptions> {
  const rows = await db
    .selectDistinct({ productId: products.id, title: products.title, model: productVariants.model, color: productVariants.color })
    .from(productionBatchLines)
    .innerJoin(productVariants, eq(productVariants.id, productionBatchLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .limit(5000);
  const productMap = new Map<string, string>();
  const models = new Set<string>();
  const colors = new Set<string>();
  for (const r of rows) {
    productMap.set(r.productId, r.title);
    if (r.model) models.add(r.model);
    if (r.color) colors.add(r.color);
  }
  const collator = new Intl.Collator("uk");
  return {
    products: [...productMap].map(([id, title]) => ({ id, title })).sort((a, b) => collator.compare(a.title, b.title)),
    models: [...models].sort(collator.compare),
    colors: [...colors].sort(collator.compare),
  };
}

// ---------------------------------------------------------------------------
// Картка партії
// ---------------------------------------------------------------------------

export interface ReceiptView {
  id: string;
  receivedAt: Date;
  receivedBy: string;
  receivedByName: string;
  note: string | null;
  good: number;
  defective: number;
  lines: Array<{ batchLineId: string; good: number; defective: number; defectReason: string | null }>;
}

export interface BatchActionsAllowed {
  /** Стан дозволяє (права перевіряє викликач/сервіс). */
  edit: boolean;
  start: boolean;
  receive: boolean;
  close: boolean;
  cancel: boolean;
  updateCosts: boolean;
}

export interface BatchDetail {
  batch: {
    id: string;
    number: string;
    title: string;
    status: ProductionBatchStatus;
    plannedReadyDate: string | null;
    manufacturer: string | null;
    notes: string | null;
    overdue: boolean;
    version: number;
    createdAt: Date;
    updatedAt: Date;
  };
  lines: BatchLineView[];
  totals: QuantityTotals;
  /** Що означає remaining позицій і підсумків у цьому стані (до виготовлення / у виробництві / не виготовлено). */
  remainderKind: RemainderKind;
  /** Одиниць партії в кошику складу «У виробництві» (0 для запланованої, закритої, скасованої). */
  inProduction: number;
  receipts: ReceiptView[];
  allowed: BatchActionsAllowed;
  /** Лише з includeCosts. extraCost/currency — збережені значення партії; summary — розрахунок. */
  costs: {
    extraCost: string | null;
    currency: string | null;
    lineUnitCosts: Record<string, string | null>;
    summary: CostSummary;
  } | null;
}

/** Картка партії: позиції, підсумки, брак, історія надходжень (з причинами браку), дозволені дії. */
export async function getBatchDetail(db: DbOrTx, batchId: string, opts: { today: string; includeCosts?: boolean }): Promise<BatchDetail | null> {
  if (!UUID_RE.test(batchId)) return null;
  const [b] = await db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  if (!b) return null;
  const [lineViews, receiptRows, receiptLineRows, reasonRows] = await Promise.all([
    loadLineViews(db, [b.id]),
    db.select().from(productionReceipts).where(eq(productionReceipts.batchId, b.id)).orderBy(desc(productionReceipts.receivedAt), desc(productionReceipts.id)),
    db
      .select({ rl: productionReceiptLines })
      .from(productionReceiptLines)
      .innerJoin(productionReceipts, eq(productionReceipts.id, productionReceiptLines.receiptId))
      .where(eq(productionReceipts.batchId, b.id)),
    db
      .select({ key: inventoryMovements.idempotencyKey, note: inventoryMovements.note })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.productionBatchId, b.id), eq(inventoryMovements.type, "receipt_production"))),
  ]);
  const lines = lineViews.get(b.id) ?? [];
  const reasons = new Map(reasonRows.map((r) => [r.key, r.note]));
  const linesByReceipt = new Map<string, ReceiptView["lines"]>();
  for (const { rl } of receiptLineRows) {
    linesByReceipt.set(rl.receiptId, [
      ...(linesByReceipt.get(rl.receiptId) ?? []),
      {
        batchLineId: rl.batchLineId,
        good: rl.goodQty,
        defective: rl.defectiveQty,
        defectReason: reasons.get(inventoryKeys.productionReceipt(rl.id)) ?? null,
      },
    ]);
  }
  const receipts: ReceiptView[] = receiptRows.map((r) => {
    const rl = linesByReceipt.get(r.id) ?? [];
    return {
      id: r.id,
      receivedAt: r.receivedAt,
      receivedBy: r.receivedBy,
      receivedByName: r.receivedByName,
      note: r.note,
      good: rl.reduce((s, x) => s + x.good, 0),
      defective: rl.reduce((s, x) => s + x.defective, 0),
      lines: rl,
    };
  });
  const totals = quantityTotals(lines);
  const hasReceipts = receipts.length > 0 || totals.produced > 0;
  let costs: BatchDetail["costs"] = null;
  if (opts.includeCosts) {
    const raw = (await loadLineCosts(db, [b.id])).get(b.id) ?? [];
    costs = {
      extraCost: b.extraCost,
      currency: b.costCurrency,
      lineUnitCosts: Object.fromEntries(raw.map((l) => [l.id, l.unitCost])),
      summary: costSummaryOf(b, raw),
    };
  }
  return {
    batch: {
      id: b.id,
      number: b.number,
      title: b.title,
      status: b.status,
      plannedReadyDate: b.plannedReadyDate,
      manufacturer: b.manufacturer,
      notes: b.notes,
      overdue: isOverdue(b.status, b.plannedReadyDate, opts.today),
      version: b.version,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    },
    lines,
    totals,
    remainderKind: REMAINDER_KIND[b.status],
    inProduction: inProductionQuantity(b.status, totals.remaining),
    receipts,
    allowed: {
      edit: b.status === "planned",
      start: b.status === "planned" && lines.length > 0,
      receive: isStatusIn(b.status, RECEIVABLE_STATUSES),
      close: isStatusIn(b.status, CLOSABLE_STATUSES),
      cancel: b.status === "planned" || (b.status === "in_production" && !hasReceipts),
      updateCosts: b.status !== "cancelled",
    },
    costs,
  };
}

// ---------------------------------------------------------------------------
// Вибір товарів і сітка модель × колір (форма партії)
// ---------------------------------------------------------------------------

export interface PickerProduct {
  id: string;
  title: string;
  imageUrl: string | null;
  variantCount: number;
}

/** Товари для вибору (активні/чернетки Shopify), пошук за назвою або SKU варіанта. */
export async function listProductsForPicker(db: DbOrTx, opts: { search?: string; limit?: number } = {}): Promise<PickerProduct[]> {
  const search = opts.search?.trim() ? likePattern(opts.search) : null;
  const rows = await db
    .select({ id: products.id, title: products.title, imageUrl: products.imageUrl, variantCount: count(productVariants.id) })
    .from(products)
    .innerJoin(productVariants, eq(productVariants.productId, products.id))
    .where(
      and(
        activeProduct,
        search
          ? or(
              ilike(products.title, search),
              exists(
                db
                  .select({ one: sql`1` })
                  .from(productVariants)
                  .where(and(eq(productVariants.productId, products.id), or(ilike(productVariants.sku, search), ilike(productVariants.title, search)))),
              ),
            )
          : undefined,
      ),
    )
    .groupBy(products.id, products.title, products.imageUrl)
    .orderBy(asc(products.title), asc(products.id))
    .limit(Math.min(Math.max(opts.limit ?? 30, 1), 100));
  return rows.map((r) => ({ ...r, variantCount: Number(r.variantCount) }));
}

export interface GridVariant {
  id: string;
  title: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
}

export interface VariantGridProduct {
  productId: string;
  title: string;
  imageUrl: string | null;
  /** Рядки сітки (null — без моделі). */
  models: Array<string | null>;
  /** Колонки сітки (null — без кольору). */
  colors: Array<string | null>;
  variants: GridVariant[];
}

/**
 * Товари з варіантами для сітки «модель × колір». Порядок варіантів — порядок появи (наближення до порядку Shopify):
 * час створення, далі числовий id варіанта Shopify (зростає з часом створення), SKU, id. Варіанти, записані однією
 * синхронізацією, мають однаковий created_at — без додаткових ключів порядок залежав би від випадкового uuid.
 */
export async function loadVariantGrid(db: DbOrTx, productIds: readonly string[]): Promise<VariantGridProduct[]> {
  const ids = [...new Set(productIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ product: products, variant: productVariants })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(products.id, ids))
    .orderBy(
      asc(products.title),
      asc(products.id),
      asc(productVariants.createdAt),
      sql`length(${productVariants.shopifyVariantId}) asc nulls last`,
      sql`${productVariants.shopifyVariantId} asc nulls last`,
      sql`${productVariants.sku} asc nulls last`,
      asc(productVariants.id),
    );
  const out = new Map<string, VariantGridProduct>();
  for (const { product, variant } of rows) {
    const p = out.get(product.id) ?? { productId: product.id, title: product.title, imageUrl: product.imageUrl, models: [], colors: [], variants: [] };
    if (!p.models.includes(variant.model)) p.models.push(variant.model);
    if (!p.colors.includes(variant.color)) p.colors.push(variant.color);
    p.variants.push({
      id: variant.id,
      title: cleanVariantTitle(variant.title),
      sku: variant.sku,
      model: variant.model,
      color: variant.color,
      imageUrl: variant.imageUrl ?? product.imageUrl,
    });
    out.set(product.id, p);
  }
  return [...out.values()];
}

/** variantId → productId (для типової ціни товару у формі партії). */
export async function variantProductIds(db: DbOrTx, variantIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(variantIds.filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return new Map();
  const rows = await db.select({ id: productVariants.id, productId: productVariants.productId }).from(productVariants).where(inArray(productVariants.id, ids));
  return new Map(rows.map((r) => [r.id, r.productId]));
}

// ---------------------------------------------------------------------------
// Для аналітики/рекомендацій і асистента
// ---------------------------------------------------------------------------

export interface OpenProductionByVariant {
  variantId: string;
  /** Запущено й ще не виготовлено (у виробництві / частково отримано). */
  inProduction: number;
  /** Заплановано, але ще не запущено. */
  planned: number;
  /** Найраніша планова дата готовності відкритих партій (YYYY-MM-DD) або null. */
  nextReadyDate: string | null;
  batchIds: string[];
}

/** Відкрите виробництво за варіантами (рекомендації партій, асистент). */
export async function openProductionByVariant(db: DbOrTx, variantIds?: readonly string[]): Promise<OpenProductionByVariant[]> {
  const rows = await db
    .select({
      variantId: productionBatchLines.variantId,
      batchId: productionBatches.id,
      status: productionBatches.status,
      plannedReadyDate: productionBatches.plannedReadyDate,
      ordered: productionBatchLines.quantityOrdered,
      received: productionBatchLines.quantityReceived,
      defective: productionBatchLines.quantityDefective,
    })
    .from(productionBatchLines)
    .innerJoin(productionBatches, eq(productionBatches.id, productionBatchLines.batchId))
    .where(
      and(
        inArray(productionBatches.status, [...NOT_RECEIVED_STATUSES]),
        variantIds?.length ? inArray(productionBatchLines.variantId, [...variantIds]) : undefined,
      ),
    );
  const out = new Map<string, OpenProductionByVariant>();
  for (const r of rows) {
    const v = out.get(r.variantId) ?? { variantId: r.variantId, inProduction: 0, planned: 0, nextReadyDate: null, batchIds: [] };
    const remaining = lineRemaining({ ordered: r.ordered, received: r.received, defective: r.defective });
    if (r.status === "planned") v.planned += remaining;
    else v.inProduction += remaining;
    if (remaining > 0 && r.plannedReadyDate && (!v.nextReadyDate || r.plannedReadyDate < v.nextReadyDate)) v.nextReadyDate = r.plannedReadyDate;
    if (!v.batchIds.includes(r.batchId)) v.batchIds.push(r.batchId);
    out.set(r.variantId, v);
  }
  return [...out.values()];
}

export { ACTIVE_BATCH_STATUSES };

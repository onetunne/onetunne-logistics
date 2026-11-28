/**
 * CSV-експорт складських даних — для власника (Excel), майбутнього фінансового модуля й ШІ.
 *
 * Набори (dataset):
 * - stock     — залишки на зараз: товари (варіанти активних товарів) і пакувальні матеріали;
 * - movements — історія руху за період (дати за Києвом), до MAX_EXPORT_MOVEMENTS рядків;
 * - sales     — продажі за варіантами за період + швидкість, днів запасу, дата вичерпання, рекомендація партії;
 * - production — партії виробництва із собівартістю (рядок — позиція партії): номер, стан, дати, модель/колір/SKU,
 *   замовлено, отримано якісних/браку, ціна одиниці, додаткові витрати, собівартість якісної одиниці.
 *
 * Права (перевіряються тут, на сервері): warehouse.view — обов'язково; колонки собівартості (unit_cost, cost_currency,
 * stock_value) — ЛИШЕ з finance.view (власник). Без finance.view цих колонок у файлі немає взагалі. Набір production
 * повністю — лише finance.view (без нього — ForbiddenError, маршрут відповідає 403).
 * Персональні дані не експортуються: жодних даних покупців, приміток (вільний текст) та імен працівників — лише
 * стабільний actor_id. Кожен експорт записується в журнал (audit_log: набір, кількість рядків, чи з собівартістю).
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import {
  auditLog,
  inventoryMovements,
  orders,
  packagingMaterials,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  productVariants,
  products,
  stockItems,
  type ProductionBatchStatus,
  type ShopifySyncState,
  type StockItemKind,
} from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { writeAudit } from "~/modules/audit/audit.server";
import { getBalances } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { batchCostSummary, billedQuantity, lineRemaining, type CostSummary, type LineCostSummary } from "~/modules/production/calc";
import { displayVariantTitle } from "~/modules/warehouse/constants";
import { businessDate, businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { loadPoolValues, type PoolValue } from "~/modules/costing/pool-read.server";
import { canFinance } from "~/modules/finance/core/access.server";
import { resolvePeriod, roundTo, type ResolvedPeriod } from "./calc";
import { buildCsv, csvAmount, csvDecimal, csvFileName, type CsvColumn, type CsvSeparatorKey } from "./csv";
import { MAX_EXPORT_MOVEMENTS } from "./export-contract";
import type { ExportDataset } from "./params";
import {
  computeWarehouseAnalytics,
  hasAnalyticsFilters,
  listAllStock,
  type AnalyticsFilters,
  type VariantAnalytics,
} from "./queries.server";

/** Найбільше рядків історії руху в одному файлі (більше → обріжеться, X-Export-Truncated: 1; сторінка попереджає). */
export { MAX_EXPORT_MOVEMENTS };

export interface CsvExport {
  dataset: ExportDataset;
  fileName: string;
  content: string;
  rows: number;
  truncated: boolean;
  /** Колонки собівартості включено (finance.view). */
  withCosts: boolean;
}

export interface ExportRequest {
  dataset: ExportDataset;
  separator?: CsvSeparatorKey;
  /** Для movements/sales; за замовчуванням — 30 днів до сьогодні. */
  period?: ResolvedPeriod;
  filters?: AnalyticsFilters;
}

/** Суми — CsvDecimal: у файлі з «;» (Excel uk/EU) — з десятковою комою, з «,» — з крапкою (csv.ts). */
const costColumns = <T>(withCosts: boolean, pick: (row: T) => { unitCost: string; currency: string } | null, value?: (row: T) => string | null): CsvColumn<T>[] =>
  withCosts
    ? [
        { header: "unit_cost", value: (r) => csvAmount(pick(r)?.unitCost) },
        { header: "cost_currency", value: (r) => pick(r)?.currency ?? null },
        ...(value ? [{ header: "stock_value", value: (r: T) => csvAmount(value(r)) } as CsvColumn<T>] : []),
      ]
    : [];

// ---------------------------------------------------------------------------
// Залишки
// ---------------------------------------------------------------------------

interface StockCsvRow {
  kind: StockItemKind;
  sku: string | null;
  barcode: string | null;
  title: string;
  variant: string | null;
  model: string | null;
  color: string | null;
  unit: string;
  onHand: number;
  reserved: number;
  available: number;
  defective: number;
  inProduction: number;
  threshold: number;
  status: string;
  tracking: string | null;
  shopifyAvailable: number | null;
  cost: { unitCost: string; currency: string } | null;
  /** Етап 6: valuation — рушій оцінки (середня пулу, вартість відомих одиниць); material — лише каталожна ціна. */
  costSource: "valuation" | "material" | null;
  /** Вартість відомих одиниць пулу (рушій оцінки); null — немає відомих одиниць (не 0). */
  value: string | null;
  unitsWithoutCost: number | null;
}

function poolCost(p: PoolValue | undefined): Pick<StockCsvRow, "cost" | "costSource" | "value" | "unitsWithoutCost"> {
  if (!p) return { cost: null, costSource: null, value: null, unitsWithoutCost: null };
  const known = p.knownQty > 0 && p.averageUnit !== null;
  return {
    cost: known ? { unitCost: p.averageUnit!, currency: p.currency } : null,
    costSource: known ? "valuation" : null,
    value: known ? p.knownValue : null,
    unitsWithoutCost: p.unknownQty,
  };
}

async function stockRows(ctx: ServiceContext, filters: AnalyticsFilters, withCosts: boolean): Promise<StockCsvRow[]> {
  const [variants, pools] = await Promise.all([
    listAllStock(ctx.db, filters),
    withCosts ? loadPoolValues(ctx.db) : Promise.resolve(new Map<string, PoolValue>()),
  ]);
  const rows: StockCsvRow[] = variants.map((v) => {
    const c = withCosts && v.stockItemId ? poolCost(pools.get(v.stockItemId)) : poolCost(undefined);
    return {
      kind: "product",
      sku: v.sku,
      barcode: v.barcode,
      title: v.productTitle,
      variant: displayVariantTitle(v.variantTitle),
      model: v.model,
      color: v.color,
      unit: "pcs",
      onHand: v.onHand,
      reserved: v.reserved,
      available: v.available,
      defective: v.defective,
      inProduction: v.inProduction,
      threshold: v.threshold,
      status: v.status,
      tracking: v.tracking,
      shopifyAvailable: v.shopifyAvailable,
      ...c,
    };
  });
  // Матеріали — лише без фільтрів товарів (фільтри модель/колір/товар стосуються товарів).
  if (hasAnalyticsFilters(filters)) return rows;
  const materials: Awaited<ReturnType<typeof getBalances>>["rows"] = [];
  for (let offset = 0; offset < 10_000; offset += 500) {
    const page = await getBalances(ctx.db, { kind: "material" }, { limit: 500, offset });
    materials.push(...page.rows);
    if (page.rows.length < 500 || materials.length >= page.total) break;
  }
  const materialCosts = new Map<string, { unitCost: string; currency: string }>();
  if (withCosts && materials.length > 0) {
    const ids = materials.map((m) => m.materialId!).filter(Boolean);
    const costRows = await ctx.db
      .select({ id: packagingMaterials.id, unitCost: packagingMaterials.unitCost, currency: packagingMaterials.costCurrency })
      .from(packagingMaterials)
      .where(inArray(packagingMaterials.id, ids));
    for (const r of costRows) if (r.unitCost && r.currency) materialCosts.set(r.id, { unitCost: r.unitCost, currency: r.currency });
  }
  for (const m of materials) {
    const catalogue = withCosts && m.materialId ? materialCosts.get(m.materialId) : undefined;
    const fromPool = withCosts && m.stockItemId ? poolCost(pools.get(m.stockItemId)) : poolCost(undefined);
    const c: Pick<StockCsvRow, "cost" | "costSource" | "value" | "unitsWithoutCost"> = fromPool.cost
      ? fromPool
      : { ...fromPool, cost: catalogue ?? null, costSource: catalogue ? "material" : null };
    rows.push({
      kind: "material",
      sku: m.sku,
      barcode: null,
      title: m.title,
      variant: null,
      model: null,
      color: null,
      unit: m.unit,
      onHand: m.onHand,
      reserved: m.reserved,
      available: m.available,
      defective: m.defective,
      inProduction: m.inProduction,
      threshold: m.threshold,
      status: m.status,
      tracking: null,
      shopifyAvailable: null,
      ...c,
    });
  }
  return rows;
}

/** Вартість запасу рядка — з рушія оцінки (відомі одиниці пулу); без відомих — порожньо, не 0. */
function stockValue(r: StockCsvRow): string | null {
  return r.value;
}

/** Залишки (товари + матеріали) на зараз. */
export async function exportStockCsv(
  ctx: ServiceContext,
  opts: { separator?: CsvSeparatorKey; filters?: AnalyticsFilters } = {},
): Promise<CsvExport> {
  requirePermission(ctx.actor, "warehouse.view");
  const withCosts = canFinance(ctx.actor, "view");
  const rows = await stockRows(ctx, opts.filters ?? {}, withCosts);
  const today = businessDate(ctx.now());
  const warehouse = await getDefaultWarehouse(ctx.db);
  const columns: CsvColumn<StockCsvRow>[] = [
    { header: "snapshot_date", value: () => today },
    { header: "warehouse", value: () => warehouse.name },
    { header: "kind", value: (r) => r.kind },
    { header: "sku", value: (r) => r.sku },
    { header: "barcode", value: (r) => r.barcode },
    { header: "product", value: (r) => r.title },
    { header: "variant", value: (r) => r.variant },
    { header: "model", value: (r) => r.model },
    { header: "color", value: (r) => r.color },
    { header: "unit", value: (r) => r.unit },
    { header: "on_hand", value: (r) => r.onHand },
    { header: "reserved", value: (r) => r.reserved },
    { header: "available", value: (r) => r.available },
    { header: "defective", value: (r) => r.defective },
    { header: "in_production", value: (r) => r.inProduction },
    { header: "low_stock_threshold", value: (r) => r.threshold },
    { header: "status", value: (r) => r.status },
    { header: "tracking", value: (r) => r.tracking },
    { header: "shopify_available", value: (r) => r.shopifyAvailable },
    ...costColumns<StockCsvRow>(withCosts, (r) => r.cost, stockValue),
    ...(withCosts
      ? [
          { header: "cost_source", value: (r: StockCsvRow) => r.costSource } as CsvColumn<StockCsvRow>,
          { header: "units_without_cost", value: (r: StockCsvRow) => r.unitsWithoutCost } as CsvColumn<StockCsvRow>,
        ]
      : []),
  ];
  const result: CsvExport = {
    dataset: "stock",
    fileName: csvFileName("stock", today),
    content: buildCsv(columns, rows, { separator: opts.separator }),
    rows: rows.length,
    truncated: false,
    withCosts,
  };
  await auditExport(ctx, result, {});
  return result;
}

// ---------------------------------------------------------------------------
// Історія руху
// ---------------------------------------------------------------------------

interface MovementCsvRow {
  id: string;
  createdAt: Date;
  type: string;
  reason: string | null;
  kind: StockItemKind;
  sku: string | null;
  title: string;
  variant: string | null;
  onHandDelta: number;
  reservedDelta: number;
  defectiveDelta: number;
  inProductionDelta: number;
  orderNumber: string | null;
  batchNumber: string | null;
  actorId: string;
  shopifySyncState: ShopifySyncState;
  cost: { unitCost: string; currency: string } | null;
}

/** Рух за період (дати за Києвом), старіші спершу. Фільтри товарів — лише рухи відповідних товарів. */
export async function exportMovementsCsv(
  ctx: ServiceContext,
  opts: {
    separator?: CsvSeparatorKey;
    period?: ResolvedPeriod;
    filters?: AnalyticsFilters;
    /** Менший ліміт рядків (1…MAX_EXPORT_MOVEMENTS; для тестів обрізання). За замовчуванням — MAX_EXPORT_MOVEMENTS. */
    maxRows?: number;
  } = {},
): Promise<CsvExport> {
  requirePermission(ctx.actor, "warehouse.view");
  const withCosts = canFinance(ctx.actor, "view");
  const today = businessDate(ctx.now());
  const period = opts.period ?? resolvePeriod({ today });
  const filters = opts.filters ?? {};
  const maxRows =
    opts.maxRows !== undefined && Number.isSafeInteger(opts.maxRows) ? Math.min(Math.max(opts.maxRows, 1), MAX_EXPORT_MOVEMENTS) : MAX_EXPORT_MOVEMENTS;
  const warehouse = await getDefaultWarehouse(ctx.db);
  const productFilter = hasAnalyticsFilters(filters)
    ? and(
        eq(stockItems.kind, "product"),
        filters.productIds?.length ? inArray(productVariants.productId, filters.productIds) : undefined,
        filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
        filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
      )
    : undefined;
  const raw = await ctx.db
    .select({
      m: inventoryMovements,
      kind: stockItems.kind,
      productTitle: products.title,
      variantTitle: productVariants.title,
      sku: productVariants.sku,
      materialName: packagingMaterials.name,
      materialCode: packagingMaterials.code,
      orderNumber: orders.orderNumber,
      batchNumber: productionBatches.number,
    })
    .from(inventoryMovements)
    .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .leftJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
    .leftJoin(orders, eq(orders.id, inventoryMovements.orderId))
    .leftJoin(productionBatches, eq(productionBatches.id, inventoryMovements.productionBatchId))
    .where(
      and(
        eq(inventoryMovements.warehouseId, warehouse.id),
        gte(inventoryMovements.createdAt, businessDayStart(period.from)),
        lte(inventoryMovements.createdAt, businessDayEnd(period.to)),
        productFilter,
      ),
    )
    .orderBy(asc(inventoryMovements.createdAt), asc(inventoryMovements.id))
    .limit(maxRows + 1);
  const truncated = raw.length > maxRows;
  const rows: MovementCsvRow[] = raw.slice(0, maxRows).map((r) => ({
    id: r.m.id,
    createdAt: r.m.createdAt,
    type: r.m.type,
    reason: r.m.reason,
    kind: r.kind,
    sku: r.kind === "product" ? r.sku : r.materialCode,
    title: r.productTitle ?? r.materialName ?? "—",
    variant: r.kind === "product" ? displayVariantTitle(r.variantTitle) : null,
    onHandDelta: r.m.onHandDelta,
    reservedDelta: r.m.reservedDelta,
    defectiveDelta: r.m.defectiveDelta,
    inProductionDelta: r.m.inProductionDelta,
    orderNumber: r.orderNumber,
    batchNumber: r.batchNumber,
    actorId: r.m.actorId,
    shopifySyncState: r.m.shopifySyncState,
    cost: withCosts && r.m.unitCost && r.m.costCurrency ? { unitCost: r.m.unitCost, currency: r.m.costCurrency } : null,
  }));
  const columns: CsvColumn<MovementCsvRow>[] = [
    { header: "movement_id", value: (r) => r.id },
    { header: "created_at", value: (r) => r.createdAt.toISOString() },
    { header: "date", value: (r) => businessDate(r.createdAt) },
    { header: "type", value: (r) => r.type },
    { header: "reason", value: (r) => r.reason },
    { header: "kind", value: (r) => r.kind },
    { header: "sku", value: (r) => r.sku },
    { header: "product", value: (r) => r.title },
    { header: "variant", value: (r) => r.variant },
    { header: "on_hand_delta", value: (r) => r.onHandDelta },
    { header: "reserved_delta", value: (r) => r.reservedDelta },
    { header: "defective_delta", value: (r) => r.defectiveDelta },
    { header: "in_production_delta", value: (r) => r.inProductionDelta },
    { header: "order_number", value: (r) => r.orderNumber },
    { header: "batch_number", value: (r) => r.batchNumber },
    { header: "actor_id", value: (r) => r.actorId },
    { header: "shopify_sync_state", value: (r) => r.shopifySyncState },
    ...costColumns<MovementCsvRow>(withCosts, (r) => r.cost),
  ];
  const result: CsvExport = {
    dataset: "movements",
    fileName: csvFileName("movements", period.from, period.to),
    content: buildCsv(columns, rows, { separator: opts.separator }),
    rows: rows.length,
    truncated,
    withCosts,
  };
  await auditExport(ctx, result, { from: period.from, to: period.to });
  return result;
}

// ---------------------------------------------------------------------------
// Продажі за варіантами
// ---------------------------------------------------------------------------

/** Продажі за варіантами за період із прогнозом (усі варіанти активних товарів + проданих архівних). */
export async function exportSalesCsv(
  ctx: ServiceContext,
  opts: { separator?: CsvSeparatorKey; period?: ResolvedPeriod; filters?: AnalyticsFilters } = {},
): Promise<CsvExport> {
  requirePermission(ctx.actor, "warehouse.view");
  const withCosts = canFinance(ctx.actor, "view");
  const today = businessDate(ctx.now());
  const period = opts.period ?? resolvePeriod({ today });
  const data = await computeWarehouseAnalytics(ctx.db, { today, period, filters: opts.filters, includeCosts: withCosts });
  const dec = (v: number) => csvDecimal(roundTo(v, 3), 3);
  const columns: CsvColumn<VariantAnalytics>[] = [
    { header: "period_from", value: () => period.from },
    { header: "period_to", value: () => period.to },
    { header: "sku", value: (r) => r.sku },
    { header: "barcode", value: (r) => r.barcode },
    { header: "product", value: (r) => r.productTitle },
    { header: "variant", value: (r) => r.variantTitle },
    { header: "model", value: (r) => r.model },
    { header: "color", value: (r) => r.color },
    { header: "active", value: (r) => r.active },
    { header: "units", value: (r) => r.units },
    { header: "orders", value: (r) => r.orders },
    { header: "previous_units", value: (r) => r.previousUnits },
    { header: "trend_percent", value: (r) => r.trend.percent },
    { header: "units_30d", value: (r) => r.units30 },
    { header: "units_90d", value: (r) => r.units90 },
    { header: "velocity_30d", value: (r) => dec(r.velocity30) },
    { header: "velocity_90d", value: (r) => dec(r.velocity90) },
    { header: "velocity_weighted", value: (r) => dec(r.velocity) },
    { header: "on_hand", value: (r) => r.onHand },
    { header: "reserved", value: (r) => r.reserved },
    { header: "available", value: (r) => r.available },
    { header: "in_production", value: (r) => r.inProduction },
    { header: "planned", value: (r) => r.planned },
    { header: "days_of_cover", value: (r) => csvDecimal(r.coverDays, 1) },
    { header: "stockout_date", value: (r) => r.stockOutDate },
    { header: "risk", value: (r) => (r.forecast ? r.risk : null) },
    { header: "recommended_qty", value: (r) => r.recommendation?.quantity ?? null },
    ...costColumns<VariantAnalytics>(withCosts, (r) => r.cost),
  ];
  const result: CsvExport = {
    dataset: "sales",
    fileName: csvFileName("sales", period.from, period.to),
    content: buildCsv(columns, data.variants, { separator: opts.separator }),
    rows: data.variants.length,
    truncated: false,
    withCosts,
  };
  await auditExport(ctx, result, { from: period.from, to: period.to });
  return result;
}

// ---------------------------------------------------------------------------
// Партії виробництва із собівартістю (лише власник)
// ---------------------------------------------------------------------------

/** Дії журналу, що закривають партію (дата закриття/скасування — з audit_log; окремої колонки в партії немає). */
const BATCH_END_ACTIONS = ["production.batch_closed", "production.batch_cancelled"] as const;

interface ProductionCsvRow {
  batch: typeof productionBatches.$inferSelect;
  line: typeof productionBatchLines.$inferSelect;
  sku: string | null;
  barcode: string | null;
  title: string;
  variant: string | null;
  model: string | null;
  color: string | null;
  dates: { started: Date | null; firstReceived: Date | null; lastReceived: Date | null; ended: Date | null };
  cost: CostSummary;
  lineCost: LineCostSummary | null;
}

/**
 * Партії виробництва для майбутнього фінансового модуля: рядок — позиція партії (усі стани, зокрема закриті й
 * скасовані; фільтри товар/модель/колір — за позиціями; період не застосовується — партія живе довше за період).
 * Собівартість — batchCostSummary (production/calc.ts): ціна одиниці, частка додаткових витрат, планова собівартість
 * одиниці виготовленого (landed_unit_cost — як unit_cost рухів запуску/надходження) і собівартість ЯКІСНОЇ одиниці
 * (брак «оплачують» якісні) — позиції й партії. Колонки партії (batch_*) однакові в усіх рядках партії — не сумуйте
 * їх по рядках. Дати — за Києвом: запуск — перший рух production_start, надходження — перше/останнє
 * production_receipts, закриття/скасування — запис журналу (production.batch_closed/_cancelled). Без даних покупців,
 * приміток і виробника (вільний текст); надходження — без імен працівників.
 */
export async function exportProductionCsv(
  ctx: ServiceContext,
  opts: { separator?: CsvSeparatorKey; filters?: AnalyticsFilters; maxRows?: number } = {},
): Promise<CsvExport> {
  requirePermission(ctx.actor, "warehouse.view");
  requirePermission(ctx.actor, "finance.view");
  const filters = opts.filters ?? {};
  const maxRows =
    opts.maxRows !== undefined && Number.isSafeInteger(opts.maxRows) ? Math.min(Math.max(opts.maxRows, 1), MAX_EXPORT_MOVEMENTS) : MAX_EXPORT_MOVEMENTS;
  const raw = await ctx.db
    .select({
      batch: productionBatches,
      line: productionBatchLines,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      title: products.title,
      variantTitle: productVariants.title,
      model: productVariants.model,
      color: productVariants.color,
    })
    .from(productionBatchLines)
    .innerJoin(productionBatches, eq(productionBatches.id, productionBatchLines.batchId))
    .innerJoin(productVariants, eq(productVariants.id, productionBatchLines.variantId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      and(
        filters.productIds?.length ? inArray(productVariants.productId, filters.productIds) : undefined,
        filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
        filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
      ),
    )
    .orderBy(
      asc(productionBatches.createdAt),
      asc(productionBatches.number),
      asc(products.title),
      asc(productVariants.model),
      asc(productVariants.color),
      asc(productVariants.title),
      asc(productionBatchLines.id),
    )
    .limit(maxRows + 1);
  const truncated = raw.length > maxRows;
  const picked = raw.slice(0, maxRows);
  const batchIds = [...new Set(picked.map((r) => r.batch.id))];

  // Собівартість рахується за ВСІМА позиціями партії (частка додаткових витрат залежить від усіх), навіть з фільтром.
  const allLines = new Map<string, Array<typeof productionBatchLines.$inferSelect>>();
  const started = new Map<string, Date>();
  const received = new Map<string, { first: Date; last: Date }>();
  const ended = new Map<string, Date>();
  if (batchIds.length > 0) {
    const [lineRows, startRows, receiptRows, endRows] = await Promise.all([
      ctx.db.select().from(productionBatchLines).where(inArray(productionBatchLines.batchId, batchIds)),
      ctx.db
        .select({ batchId: inventoryMovements.productionBatchId, at: sql<Date>`min(${inventoryMovements.createdAt})`.mapWith(inventoryMovements.createdAt) })
        .from(inventoryMovements)
        .where(and(inArray(inventoryMovements.productionBatchId, batchIds), eq(inventoryMovements.type, "production_start")))
        .groupBy(inventoryMovements.productionBatchId),
      ctx.db
        .select({
          batchId: productionReceipts.batchId,
          first: sql<Date>`min(${productionReceipts.receivedAt})`.mapWith(productionReceipts.receivedAt),
          last: sql<Date>`max(${productionReceipts.receivedAt})`.mapWith(productionReceipts.receivedAt),
        })
        .from(productionReceipts)
        // Лише надходження з позиціями (порожнього надходження сервіс не записує; захист від пошкоджених даних).
        .where(
          and(
            inArray(productionReceipts.batchId, batchIds),
            sql`exists (select 1 from ${productionReceiptLines} where ${productionReceiptLines.receiptId} = ${productionReceipts.id})`,
          ),
        )
        .groupBy(productionReceipts.batchId),
      ctx.db
        .select({ batchId: auditLog.entityId, at: sql<Date>`max(${auditLog.createdAt})`.mapWith(auditLog.createdAt) })
        .from(auditLog)
        .where(and(eq(auditLog.entityType, "production_batch"), inArray(auditLog.entityId, batchIds), inArray(auditLog.action, [...BATCH_END_ACTIONS])))
        .groupBy(auditLog.entityId),
    ]);
    for (const l of lineRows) allLines.set(l.batchId, [...(allLines.get(l.batchId) ?? []), l]);
    for (const r of startRows) if (r.batchId) started.set(r.batchId, r.at);
    for (const r of receiptRows) received.set(r.batchId, { first: r.first, last: r.last });
    for (const r of endRows) if (r.batchId) ended.set(r.batchId, r.at);
  }
  const summaries = new Map<string, CostSummary>();
  for (const id of batchIds) {
    const b = picked.find((r) => r.batch.id === id)!.batch;
    summaries.set(
      id,
      batchCostSummary(
        (allLines.get(id) ?? []).map((l) => ({
          id: l.id,
          ordered: l.quantityOrdered,
          received: l.quantityReceived,
          defective: l.quantityDefective,
          unitCost: l.unitCost,
          costCurrency: l.costCurrency,
        })),
        b.extraCost,
        b.costCurrency,
        b.status,
      ),
    );
  }
  const isEnded = (status: ProductionBatchStatus) => status === "closed" || status === "cancelled";
  const rows: ProductionCsvRow[] = picked.map((r) => {
    const cost = summaries.get(r.batch.id)!;
    return {
      batch: r.batch,
      line: r.line,
      sku: r.sku,
      barcode: r.barcode,
      title: r.title,
      variant: displayVariantTitle(r.variantTitle),
      model: r.model,
      color: r.color,
      dates: {
        started: started.get(r.batch.id) ?? null,
        firstReceived: received.get(r.batch.id)?.first ?? null,
        lastReceived: received.get(r.batch.id)?.last ?? null,
        ended: isEnded(r.batch.status) ? (ended.get(r.batch.id) ?? null) : null,
      },
      cost,
      lineCost: cost.lines.find((l) => l.id === r.line.id) ?? null,
    };
  });
  const day = (d: Date | null) => (d ? businessDate(d) : null);
  const q = (r: ProductionCsvRow) => ({ ordered: r.line.quantityOrdered, received: r.line.quantityReceived, defective: r.line.quantityDefective });
  const columns: CsvColumn<ProductionCsvRow>[] = [
    { header: "batch_number", value: (r) => r.batch.number },
    { header: "batch_title", value: (r) => r.batch.title },
    { header: "status", value: (r) => r.batch.status },
    { header: "created_date", value: (r) => day(r.batch.createdAt) },
    { header: "planned_ready_date", value: (r) => r.batch.plannedReadyDate },
    { header: "started_date", value: (r) => day(r.dates.started) },
    { header: "first_received_date", value: (r) => day(r.dates.firstReceived) },
    { header: "last_received_date", value: (r) => day(r.dates.lastReceived) },
    { header: "closed_date", value: (r) => day(r.dates.ended) },
    { header: "sku", value: (r) => r.sku },
    { header: "barcode", value: (r) => r.barcode },
    { header: "product", value: (r) => r.title },
    { header: "variant", value: (r) => r.variant },
    { header: "model", value: (r) => r.model },
    { header: "color", value: (r) => r.color },
    { header: "ordered", value: (r) => r.line.quantityOrdered },
    { header: "received_good", value: (r) => r.line.quantityReceived },
    { header: "received_defective", value: (r) => r.line.quantityDefective },
    { header: "remaining", value: (r) => lineRemaining(q(r)) },
    { header: "billed_qty", value: (r) => billedQuantity(q(r), r.batch.status) },
    { header: "cost_currency", value: (r) => r.cost.currency },
    { header: "unit_cost", value: (r) => csvAmount(r.lineCost?.unitCost) },
    { header: "line_total", value: (r) => csvAmount(r.lineCost?.total) },
    { header: "extra_cost_share", value: (r) => csvAmount(r.lineCost?.extraShare) },
    { header: "landed_unit_cost", value: (r) => csvAmount(r.lineCost?.landedUnitCost) },
    { header: "cost_per_good_unit", value: (r) => csvAmount(r.lineCost?.costPerGoodUnit) },
    { header: "batch_extra_cost", value: (r) => csvAmount(r.cost.extraCost) },
    { header: "batch_total_cost", value: (r) => csvAmount(r.cost.total) },
    { header: "batch_produced_cost", value: (r) => csvAmount(r.cost.producedTotal) },
    { header: "batch_good_received", value: (r) => r.cost.goodReceived },
    { header: "batch_cost_per_good_unit", value: (r) => csvAmount(r.cost.costPerGoodUnit) },
    { header: "batch_cost_complete", value: (r) => r.cost.complete },
  ];
  const result: CsvExport = {
    dataset: "production",
    fileName: csvFileName("production", businessDate(ctx.now())),
    content: buildCsv(columns, rows, { separator: opts.separator }),
    rows: rows.length,
    truncated,
    withCosts: true,
  };
  await auditExport(ctx, result, {});
  return result;
}

/** Експорт за набором (ресурсний маршрут warehouse/export). */
export async function exportWarehouseCsv(ctx: ServiceContext, req: ExportRequest): Promise<CsvExport> {
  const opts = { separator: req.separator, period: req.period, filters: req.filters };
  switch (req.dataset) {
    case "stock":
      return exportStockCsv(ctx, opts);
    case "movements":
      return exportMovementsCsv(ctx, opts);
    case "sales":
      return exportSalesCsv(ctx, opts);
    case "production":
      return exportProductionCsv(ctx, { separator: req.separator, filters: req.filters });
  }
}

async function auditExport(ctx: ServiceContext, r: CsvExport, extra: { from?: string; to?: string }): Promise<void> {
  await writeAudit(ctx.db, ctx.actor, "warehouse.exported", { type: "warehouse" }, {
    dataset: r.dataset,
    rows: r.rows,
    truncated: r.truncated,
    withCosts: r.withCosts,
    ...extra,
  });
}

/**
 * CSV-експорт складських даних — для власника (Excel), майбутнього фінансового модуля й ШІ.
 *
 * Набори (dataset):
 * - stock     — залишки на зараз: товари (варіанти активних товарів) і пакувальні матеріали;
 * - movements — історія руху за період (дати за Києвом), до MAX_EXPORT_MOVEMENTS рядків;
 * - sales     — продажі за варіантами за період + швидкість, днів запасу, дата вичерпання, рекомендація партії.
 *
 * Права (перевіряються тут, на сервері): warehouse.view — обов'язково; колонки собівартості (unit_cost, cost_currency,
 * stock_value) — ЛИШЕ з finance.view (власник). Без finance.view цих колонок у файлі немає взагалі.
 * Персональні дані не експортуються: жодних даних покупців, приміток (вільний текст) та імен працівників — лише
 * стабільний actor_id. Кожен експорт записується в журнал (audit_log: набір, кількість рядків, чи з собівартістю).
 */
import { and, asc, eq, gte, inArray, lte } from "drizzle-orm";
import {
  inventoryMovements,
  orders,
  packagingMaterials,
  productionBatches,
  productVariants,
  products,
  stockItems,
  type ShopifySyncState,
  type StockItemKind,
} from "~/db/schema";
import { can, requirePermission } from "~/domain/permissions";
import { fromMinor, toMinor } from "~/lib/money";
import { writeAudit } from "~/modules/audit/audit.server";
import { getBalances } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { displayVariantTitle } from "~/modules/warehouse/constants";
import { businessDate, businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { resolvePeriod, roundTo, type ResolvedPeriod } from "./calc";
import { buildCsv, csvDecimal, csvFileName, type CsvColumn, type CsvSeparatorKey } from "./csv";
import { MAX_EXPORT_MOVEMENTS } from "./export-contract";
import type { ExportDataset } from "./params";
import {
  computeWarehouseAnalytics,
  hasAnalyticsFilters,
  listAllStock,
  loadLatestProductionUnitCosts,
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

const costColumns = <T>(withCosts: boolean, pick: (row: T) => { unitCost: string; currency: string } | null, value?: (row: T) => string | null): CsvColumn<T>[] =>
  withCosts
    ? [
        { header: "unit_cost", value: (r) => pick(r)?.unitCost ?? null },
        { header: "cost_currency", value: (r) => pick(r)?.currency ?? null },
        ...(value ? [{ header: "stock_value", value } as CsvColumn<T>] : []),
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
  costSource: "production_receipt" | "material" | null;
}

async function stockRows(ctx: ServiceContext, filters: AnalyticsFilters, withCosts: boolean): Promise<StockCsvRow[]> {
  const [variants, costs] = await Promise.all([
    listAllStock(ctx.db, filters),
    withCosts ? loadLatestProductionUnitCosts(ctx.db) : Promise.resolve(new Map()),
  ]);
  const rows: StockCsvRow[] = variants.map((v) => {
    const c = withCosts && v.stockItemId ? costs.get(v.stockItemId) : undefined;
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
      cost: c ? { unitCost: c.unitCost, currency: c.currency } : null,
      costSource: c ? "production_receipt" : null,
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
    const c = withCosts && m.materialId ? materialCosts.get(m.materialId) : undefined;
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
      cost: c ?? null,
      costSource: c ? "material" : null,
    });
  }
  return rows;
}

function stockValue(r: StockCsvRow): string | null {
  if (!r.cost || r.onHand <= 0) return null;
  return fromMinor(toMinor(r.cost.unitCost) * BigInt(r.onHand));
}

/** Залишки (товари + матеріали) на зараз. */
export async function exportStockCsv(
  ctx: ServiceContext,
  opts: { separator?: CsvSeparatorKey; filters?: AnalyticsFilters } = {},
): Promise<CsvExport> {
  requirePermission(ctx.actor, "warehouse.view");
  const withCosts = can(ctx.actor, "finance.view");
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
    ...(withCosts ? [{ header: "cost_source", value: (r: StockCsvRow) => r.costSource } as CsvColumn<StockCsvRow>] : []),
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
  const withCosts = can(ctx.actor, "finance.view");
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
  const withCosts = can(ctx.actor, "finance.view");
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

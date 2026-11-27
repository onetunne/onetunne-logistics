/**
 * Читання для сторінок «Склад»: перелік залишків варіантів (фільтри, сортування, сторінки, лічильники станів),
 * картка позиції (баланси, попередження, резерви за замовленнями, остання інвентаризація).
 *
 * Джерело — inventory_balances (змінюються лише через applyMovements); варіанти без руху — нулі. Значення Shopify
 * (product_variants.inventory_available) — лише для порівняння, не джерело обліку.
 */
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  inventoryBalances,
  inventoryMovements,
  orders,
  packagingMaterials,
  productVariants,
  products,
  stockAlerts,
  stockItems,
  stockReservations,
  type MaterialUnit,
  type PackagingMaterialKind,
  type ReservationStatus,
  type StockAlertKind,
  type StockItemKind,
} from "~/db/schema";
import type { OrderStatus } from "~/domain/order-status";
import { availableOf, stockLevelStatus, type StockLevelStatus } from "~/modules/inventory/alerts";
import type { AlertView } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { getSetting } from "~/modules/settings/settings.server";
import { DEFAULT_STOCK_SORT, MAX_SEARCH_LENGTH, STOCKTAKE_REASON, type StockSort, type StockTrackingState } from "./constants";

export interface StockListFilters {
  /** Назва товару/варіанта, SKU, штрихкод. */
  search?: string;
  models?: string[];
  colors?: string[];
  productIds?: string[];
  variantIds?: string[];
  statuses?: StockLevelStatus[];
  tracking?: StockTrackingState[];
  /** Архівні/видалені в Shopify товари (за замовчуванням ні). */
  includeInactive?: boolean;
}

export interface StockRow {
  variantId: string;
  /** null — позиція ще не мала жодного руху (нулі). */
  stockItemId: string | null;
  productId: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  barcode: string | null;
  model: string | null;
  color: string | null;
  /** Збережене посилання на зображення Shopify (варіант або товар). */
  imageUrl: string | null;
  onHand: number;
  reserved: number;
  /** on_hand − reserved */
  available: number;
  defective: number;
  inProduction: number;
  /** Власний поріг (null — типовий). */
  lowStockThreshold: number | null;
  threshold: number;
  status: StockLevelStatus;
  tracking: StockTrackingState;
  /** Shopify «доступно» з останньої синхронізації (null — Shopify не відстежує / невідомо). */
  shopifyAvailable: number | null;
  shopifySyncedAt: Date | null;
  openedAt: Date | null;
  updatedAt: Date | null;
}

const ACTIVE_PRODUCT_STATUSES = ["ACTIVE", "active", "DRAFT", "draft"];

const likePattern = (search: string) =>
  `%${search
    .trim()
    .slice(0, MAX_SEARCH_LENGTH)
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** Вирази залишку (поріг за замовчуванням — числовий літерал з налаштувань, щоб вираз стану можна було групувати). */
function expressions(defaultThreshold: number) {
  const fallback = sql.raw(String(Math.max(0, Math.trunc(defaultThreshold))));
  const onHand = sql<number>`coalesce(${inventoryBalances.onHand}, 0)`;
  const reserved = sql<number>`coalesce(${inventoryBalances.reserved}, 0)`;
  const defective = sql<number>`coalesce(${inventoryBalances.defective}, 0)`;
  const inProduction = sql<number>`coalesce(${inventoryBalances.inProduction}, 0)`;
  const available = sql<number>`(${onHand} - ${reserved})`;
  const threshold = sql<number>`coalesce(${stockItems.lowStockThreshold}, ${fallback})`;
  const status = sql<StockLevelStatus>`(case
    when ${onHand} < 0 then 'negative'
    when ${reserved} > 0 and ${reserved} > ${onHand} then 'oversold'
    when ${available} <= 0 then 'out'
    when ${available} <= ${threshold} then 'low'
    else 'ok' end)`;
  const tracking = sql<StockTrackingState>`(case
    when ${inventoryBalances.openedAt} is not null then 'opened'
    when ${productVariants.inventoryAvailable} is null then 'untracked'
    else 'not_opened' end)`;
  const statusRank = sql<number>`(case ${status}
    when 'negative' then 0 when 'oversold' then 1 when 'out' then 2 when 'low' then 3 else 4 end)`;
  return { onHand, reserved, defective, inProduction, available, threshold, status, tracking, statusRank };
}

type Expressions = ReturnType<typeof expressions>;

function whereOf(filters: StockListFilters, e: Expressions, opts: { ignoreStatus?: boolean } = {}): SQL | undefined {
  const search = filters.search?.trim() ? likePattern(filters.search) : null;
  return and(
    filters.includeInactive ? undefined : or(isNull(products.status), inArray(products.status, ACTIVE_PRODUCT_STATUSES)),
    filters.productIds?.length ? inArray(products.id, filters.productIds) : undefined,
    filters.variantIds?.length ? inArray(productVariants.id, filters.variantIds) : undefined,
    filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
    filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
    search
      ? or(
          ilike(products.title, search),
          ilike(productVariants.title, search),
          ilike(productVariants.sku, search),
          ilike(productVariants.barcode, search),
        )
      : undefined,
    !opts.ignoreStatus && filters.statuses?.length ? sql`${e.status} in ${filters.statuses}` : undefined,
    filters.tracking?.length ? sql`${e.tracking} in ${filters.tracking}` : undefined,
  );
}

function orderOf(sort: StockSort, e: Expressions): SQL[] {
  const tie = [asc(products.title), asc(productVariants.title), asc(productVariants.id)];
  switch (sort) {
    case "sku":
      return [sql`${productVariants.sku} asc nulls last`, asc(productVariants.id)];
    case "available_asc":
      return [sql`${e.available} asc`, ...tie];
    case "available_desc":
      return [sql`${e.available} desc`, ...tie];
    case "on_hand_desc":
      return [sql`${e.onHand} desc`, ...tie];
    case "reserved_desc":
      return [sql`${e.reserved} desc`, ...tie];
    case "defective_desc":
      return [sql`${e.defective} desc`, ...tie];
    case "in_production_desc":
      return [sql`${e.inProduction} desc`, ...tie];
    case "status":
      return [sql`${e.statusRank} asc`, sql`${e.available} asc`, ...tie];
    case "updated_desc":
      return [sql`${inventoryBalances.updatedAt} desc nulls last`, ...tie];
    case "product":
    default:
      return tie;
  }
}

/** Перелік залишків варіантів товарів (склад за замовчуванням): фільтри, сортування, сторінки. */
export async function listStock(
  db: DbOrTx,
  filters: StockListFilters = {},
  opts: { sort?: StockSort; limit?: number; offset?: number } = {},
): Promise<{ rows: StockRow[]; total: number }> {
  const warehouse = await getDefaultWarehouse(db);
  const defaultThreshold = (await getSetting(db, "warehouse")).lowStockThreshold;
  const e = expressions(defaultThreshold);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 50), 1), 500);
  const offset = Math.max(Math.trunc(opts.offset ?? 0), 0);
  const where = whereOf(filters, e);
  const balanceJoin = and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id));
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        variantId: productVariants.id,
        productId: products.id,
        productTitle: products.title,
        productImage: products.imageUrl,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
        barcode: productVariants.barcode,
        model: productVariants.model,
        color: productVariants.color,
        variantImage: productVariants.imageUrl,
        shopifyAvailable: productVariants.inventoryAvailable,
        shopifySyncedAt: productVariants.inventorySyncedAt,
        stockItemId: stockItems.id,
        lowStockThreshold: stockItems.lowStockThreshold,
        onHand: e.onHand.mapWith(Number),
        reserved: e.reserved.mapWith(Number),
        defective: e.defective.mapWith(Number),
        inProduction: e.inProduction.mapWith(Number),
        threshold: e.threshold.mapWith(Number),
        status: e.status,
        tracking: e.tracking,
        openedAt: inventoryBalances.openedAt,
        updatedAt: inventoryBalances.updatedAt,
      })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
      .leftJoin(inventoryBalances, balanceJoin)
      .where(where)
      .orderBy(...orderOf(opts.sort ?? DEFAULT_STOCK_SORT, e))
      .limit(limit)
      .offset(offset),
    db
      .select({ c: count() })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
      .leftJoin(inventoryBalances, balanceJoin)
      .where(where),
  ]);
  return {
    total: Number(totalRow?.c ?? 0),
    rows: rows.map((r) => ({
      variantId: r.variantId,
      stockItemId: r.stockItemId,
      productId: r.productId,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      sku: r.sku,
      barcode: r.barcode,
      model: r.model,
      color: r.color,
      imageUrl: r.variantImage ?? r.productImage,
      onHand: r.onHand,
      reserved: r.reserved,
      available: r.onHand - r.reserved,
      defective: r.defective,
      inProduction: r.inProduction,
      lowStockThreshold: r.lowStockThreshold,
      threshold: r.threshold,
      status: r.status,
      tracking: r.tracking,
      shopifyAvailable: r.shopifyAvailable,
      shopifySyncedAt: r.shopifySyncedAt,
      openedAt: r.openedAt,
      updatedAt: r.updatedAt,
    })),
  };
}

/** Наявні варіанти з переліку (захист масових дій від вигаданих id: позиція обліку створюється лише для наявних). */
export async function existingVariantIds(db: DbOrTx, variantIds: readonly string[]): Promise<string[]> {
  if (variantIds.length === 0) return [];
  const rows = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(inArray(productVariants.id, [...variantIds]));
  return rows.map((r) => r.id);
}

export type StockStatusCounts = Record<StockLevelStatus, number>;

/** Кількість варіантів за станом залишку (з тими самими фільтрами, крім стану) — для швидких фільтрів. */
export async function stockStatusCounts(db: DbOrTx, filters: StockListFilters = {}): Promise<StockStatusCounts> {
  const warehouse = await getDefaultWarehouse(db);
  const e = expressions((await getSetting(db, "warehouse")).lowStockThreshold);
  const rows = await db
    .select({ status: e.status, c: count() })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
    .leftJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id)))
    .where(whereOf(filters, e, { ignoreStatus: true }))
    .groupBy(sql`1`);
  const out: StockStatusCounts = { ok: 0, low: 0, out: 0, oversold: 0, negative: 0 };
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}

export interface StockFilterOptions {
  models: string[];
  colors: string[];
  products: Array<{ id: string; title: string }>;
}

/** Значення для фільтрів (моделі, кольори, товари) серед активних товарів. */
export async function stockFilterOptions(db: DbOrTx): Promise<StockFilterOptions> {
  const active = or(isNull(products.status), inArray(products.status, ACTIVE_PRODUCT_STATUSES));
  const [models, colors, productRows] = await Promise.all([
    db
      .selectDistinct({ v: productVariants.model })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(active, sql`${productVariants.model} is not null and ${productVariants.model} <> ''`))
      .orderBy(asc(productVariants.model))
      .limit(500),
    db
      .selectDistinct({ v: productVariants.color })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(active, sql`${productVariants.color} is not null and ${productVariants.color} <> ''`))
      .orderBy(asc(productVariants.color))
      .limit(500),
    db
      .select({ id: products.id, title: products.title })
      .from(products)
      .where(active)
      .orderBy(asc(products.title), asc(products.id))
      .limit(500),
  ]);
  return {
    models: models.map((m) => m.v!).filter(Boolean),
    colors: colors.map((c) => c.v!).filter(Boolean),
    products: productRows,
  };
}

// ---------------------------------------------------------------------------
// Попередження (зведення для верху сторінки)
// ---------------------------------------------------------------------------

export interface AlertSummary {
  total: number;
  byKind: Record<StockAlertKind, number>;
  /** Попередження пакувальних матеріалів (окремий розділ «Матеріали»). */
  materials: number;
  /** Найважливіші попередження товарів (для посилань на картки). */
  top: Array<Pick<AlertView, "id" | "kind" | "stockItemId" | "title" | "variantTitle" | "sku" | "details">>;
}

const ALERT_RANK: Record<StockAlertKind, number> = { negative_on_hand: 0, oversold: 1, out_of_stock: 2, low_stock: 3 };

export function summarizeAlerts(alerts: readonly AlertView[], topCount = 5): AlertSummary {
  const byKind: Record<StockAlertKind, number> = { low_stock: 0, out_of_stock: 0, negative_on_hand: 0, oversold: 0 };
  let materials = 0;
  for (const a of alerts) {
    if (a.itemKind === "material") materials++;
    else byKind[a.kind]++;
  }
  const top = alerts
    .filter((a) => a.itemKind === "product")
    .sort((a, b) => ALERT_RANK[a.kind] - ALERT_RANK[b.kind] || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, topCount)
    .map((a) => ({
      id: a.id,
      kind: a.kind,
      stockItemId: a.stockItemId,
      title: a.title,
      variantTitle: a.variantTitle,
      sku: a.sku,
      details: a.details,
    }));
  return { total: alerts.length - materials, byKind, materials, top };
}

/**
 * Зведення відкритих попереджень для верху сторінки «Склад»: лічильники — згрупованим COUNT(*) за всіма відкритими
 * (без обмеження кількості), список — лише topCount найважливіших попереджень товарів (стан, потім новіші).
 */
export async function loadAlertSummary(db: DbOrTx, topCount = 5): Promise<AlertSummary> {
  const open = eq(stockAlerts.status, "open");
  const rank = sql<number>`(case ${stockAlerts.kind}
    when 'negative_on_hand' then 0 when 'oversold' then 1 when 'out_of_stock' then 2 else 3 end)`;
  const [counts, topRows] = await Promise.all([
    db
      .select({ itemKind: stockItems.kind, kind: stockAlerts.kind, c: count() })
      .from(stockAlerts)
      .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
      .where(open)
      .groupBy(stockItems.kind, stockAlerts.kind),
    db
      .select({
        id: stockAlerts.id,
        kind: stockAlerts.kind,
        stockItemId: stockAlerts.stockItemId,
        details: stockAlerts.details,
        title: products.title,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
      })
      .from(stockAlerts)
      .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
      .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(open, eq(stockItems.kind, "product")))
      .orderBy(asc(rank), desc(stockAlerts.createdAt), desc(stockAlerts.id))
      .limit(Math.min(Math.max(Math.trunc(topCount), 0), 50)),
  ]);
  const byKind: Record<StockAlertKind, number> = { low_stock: 0, out_of_stock: 0, negative_on_hand: 0, oversold: 0 };
  let total = 0;
  let materials = 0;
  for (const r of counts) {
    const n = Number(r.c);
    if (r.itemKind === "material") materials += n;
    else {
      byKind[r.kind] += n;
      total += n;
    }
  }
  return { total, byKind, materials, top: topRows };
}

// ---------------------------------------------------------------------------
// Картка позиції
// ---------------------------------------------------------------------------

export interface StockItemCard {
  /** null — варіант ще не мав руху (позиція обліку створиться з першою операцією). */
  stockItemId: string | null;
  kind: StockItemKind;
  variantId: string | null;
  materialId: string | null;
  productId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  materialKind: PackagingMaterialKind | null;
  unit: MaterialUnit;
  /** Статус товару в Shopify (ACTIVE/ARCHIVED/…); null — матеріал/невідомо. */
  productStatus: string | null;
  /** Валюта за замовчуванням для собівартості надходження. */
  defaultCostCurrency: string;
  onHand: number;
  reserved: number;
  available: number;
  defective: number;
  inProduction: number;
  version: number;
  lowStockThreshold: number | null;
  threshold: number;
  defaultThreshold: number;
  status: StockLevelStatus;
  /** null — матеріал (Shopify не веде). */
  tracking: StockTrackingState | null;
  shopifyAvailable: number | null;
  shopifySyncedAt: Date | null;
  openedAt: Date | null;
  openingSnapshotAt: Date | null;
  updatedAt: Date | null;
}

/** Картка за id позиції обліку АБО id варіанта / матеріалу (без руху ще немає позиції обліку). null — не знайдено. */
export async function getStockItemCard(db: DbOrTx, id: string): Promise<StockItemCard | null> {
  const warehouse = await getDefaultWarehouse(db);
  const defaultThreshold = (await getSetting(db, "warehouse")).lowStockThreshold;
  const [item] = await db
    .select()
    .from(stockItems)
    .where(or(eq(stockItems.id, id), eq(stockItems.variantId, id), eq(stockItems.materialId, id)))
    .orderBy(sql`case when ${stockItems.id} = ${id} then 0 else 1 end`)
    .limit(1);
  const variantId = item ? item.variantId : id;

  let base: Omit<
    StockItemCard,
    | "onHand"
    | "reserved"
    | "available"
    | "defective"
    | "inProduction"
    | "version"
    | "threshold"
    | "status"
    | "tracking"
    | "openedAt"
    | "openingSnapshotAt"
    | "updatedAt"
  > | null = null;
  if (!item || item.kind === "product") {
    const [v] = await db
      .select({ v: productVariants, p: products })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(eq(productVariants.id, variantId!));
    if (v) {
      base = {
        stockItemId: item?.id ?? null,
        kind: "product",
        variantId: v.v.id,
        materialId: null,
        productId: v.p.id,
        title: v.p.title,
        variantTitle: v.v.title,
        sku: v.v.sku,
        barcode: v.v.barcode,
        model: v.v.model,
        color: v.v.color,
        imageUrl: v.v.imageUrl ?? v.p.imageUrl,
        materialKind: null,
        unit: "pcs",
        productStatus: v.p.status,
        defaultCostCurrency: v.v.currency,
        lowStockThreshold: item?.lowStockThreshold ?? null,
        defaultThreshold,
        shopifyAvailable: v.v.inventoryAvailable,
        shopifySyncedAt: v.v.inventorySyncedAt,
      };
    }
  }
  // Матеріал: за позицією обліку або за id матеріалу (матеріал без руху ще не має позиції).
  const materialId = item ? item.materialId : base ? null : id;
  if (!base && materialId) {
    const [m] = await db.select().from(packagingMaterials).where(eq(packagingMaterials.id, materialId));
    if (m) {
      base = {
        stockItemId: item?.id ?? null,
        kind: "material",
        variantId: null,
        materialId: m.id,
        productId: null,
        title: m.name,
        variantTitle: null,
        sku: m.code,
        barcode: null,
        model: null,
        color: null,
        imageUrl: null,
        materialKind: m.kind,
        unit: m.unit,
        productStatus: null,
        defaultCostCurrency: m.costCurrency ?? "UAH",
        lowStockThreshold: item?.lowStockThreshold ?? null,
        defaultThreshold,
        shopifyAvailable: null,
        shopifySyncedAt: null,
      };
    }
  }
  if (!base) return null;

  const [b] = base.stockItemId
    ? await db
        .select()
        .from(inventoryBalances)
        .where(and(eq(inventoryBalances.warehouseId, warehouse.id), eq(inventoryBalances.stockItemId, base.stockItemId)))
    : [];
  const onHand = b?.onHand ?? 0;
  const reserved = b?.reserved ?? 0;
  const threshold = base.lowStockThreshold ?? defaultThreshold;
  const openedAt = b?.openedAt ?? null;
  return {
    ...base,
    onHand,
    reserved,
    available: availableOf({ onHand, reserved }),
    defective: b?.defective ?? 0,
    inProduction: b?.inProduction ?? 0,
    version: b?.version ?? 0,
    threshold,
    status: stockLevelStatus({ onHand, reserved, threshold }),
    tracking: base.kind === "material" ? null : openedAt ? "opened" : base.shopifyAvailable === null ? "untracked" : "not_opened",
    openedAt,
    openingSnapshotAt: b?.openingSnapshotAt ?? null,
    updatedAt: b?.updatedAt ?? null,
  };
}

export interface ItemReservation {
  orderId: string;
  orderNumber: string;
  orderStatus: OrderStatus;
  placedAt: Date;
  reservedQty: number;
  consumedQty: number;
  status: ReservationStatus;
  updatedAt: Date;
}

/** Активні резерви позиції за замовленнями (лише номер і статус замовлення — без даних покупця). */
export async function listItemReservations(
  db: DbOrTx,
  stockItemId: string,
  limit = 100,
): Promise<{ rows: ItemReservation[]; total: number; totalQty: number }> {
  const where = and(eq(stockReservations.stockItemId, stockItemId), gt(stockReservations.reservedQty, 0));
  const [rows, [totals]] = await Promise.all([
    db
      .select({
        orderId: orders.id,
        orderNumber: orders.orderNumber,
        orderStatus: orders.status,
        placedAt: orders.placedAt,
        reservedQty: stockReservations.reservedQty,
        consumedQty: stockReservations.consumedQty,
        status: stockReservations.status,
        updatedAt: stockReservations.updatedAt,
      })
      .from(stockReservations)
      .innerJoin(orders, eq(orders.id, stockReservations.orderId))
      .where(where)
      .orderBy(asc(orders.placedAt), asc(orders.id))
      .limit(Math.min(Math.max(limit, 1), 500)),
    db
      .select({ c: count(), qty: sql<number>`coalesce(sum(${stockReservations.reservedQty}), 0)`.mapWith(Number) })
      .from(stockReservations)
      .where(where),
  ]);
  return { rows, total: Number(totals?.c ?? 0), totalQty: totals?.qty ?? 0 };
}

export interface ItemAlert {
  id: string;
  kind: StockAlertKind;
  details: Record<string, number | string | null>;
  createdAt: Date;
}

export async function listItemAlerts(db: DbOrTx, stockItemId: string): Promise<ItemAlert[]> {
  const rows = await db
    .select({ id: stockAlerts.id, kind: stockAlerts.kind, details: stockAlerts.details, createdAt: stockAlerts.createdAt })
    .from(stockAlerts)
    .where(and(eq(stockAlerts.stockItemId, stockItemId), eq(stockAlerts.status, "open")))
    .orderBy(desc(stockAlerts.createdAt));
  return rows.sort((a, b) => ALERT_RANK[a.kind] - ALERT_RANK[b.kind]);
}

export interface LastStocktake {
  at: Date;
  actorName: string;
  delta: number;
}

/** Остання інвентаризація позиції (рух adjustment із причиною stocktake). */
export async function lastStocktake(db: DbOrTx, stockItemId: string): Promise<LastStocktake | null> {
  const [row] = await db
    .select({ at: inventoryMovements.createdAt, actorName: inventoryMovements.actorName, delta: inventoryMovements.onHandDelta })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.stockItemId, stockItemId),
        eq(inventoryMovements.type, "adjustment"),
        eq(inventoryMovements.reason, STOCKTAKE_REASON),
      ),
    )
    .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
    .limit(1);
  return row ?? null;
}

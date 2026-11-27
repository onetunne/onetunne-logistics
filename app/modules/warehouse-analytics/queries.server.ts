/**
 * Аналітика складу — запити до БД і зведення для сторінки «Аналітика складу», CSV-експорту та команд
 * (Telegram/асистент). Розрахунки — чисті функції calc.ts.
 *
 * Джерела:
 * - продажі — order_line_items × orders: оплачені (financial_status paid / partially_refunded / refunded, як
 *   shopify-sync isPaid), не скасовані (status ≠ cancelled, cancelled_at null); кількість — effectiveLineQuantitySql
 *   (Shopify currentQuantity: без повернених і видалених одиниць); дата — orders.placed_at за Києвом;
 * - залишки — inventory_balances через listStock (лише активні/чернетки товари; прогноз — лише для ВІДКРИТИХ позицій:
 *   до ініціалізації обліку баланс не відображає реальність);
 * - виробництво — кошик «У виробництві» з балансу + «заплановано» з незапущених партій (openProductionByVariant);
 * - собівартість (лише includeCosts = finance.view) — unit_cost останнього руху receipt_production позиції
 *   (планова собівартість одиниці з урахуванням додаткових витрат партії, як її записує модуль виробництва).
 * Жодних даних покупців: лише кількості, номери й назви товарів.
 */
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryMovements, orderLineItems, orders, productVariants, products } from "~/db/schema";
import { can, requirePermission } from "~/domain/permissions";
import { fromMinor, toMinor } from "~/lib/money";
import { effectiveLineQuantitySql } from "~/modules/inventory/reservations.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { openProductionByVariant } from "~/modules/production/queries.server";
import { getSetting } from "~/modules/settings/settings.server";
import { displayVariantTitle, type StockTrackingState } from "~/modules/warehouse/constants";
import { businessDate, businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import { listStock, type StockRow } from "~/modules/warehouse/stock.server";
import type { ServiceContext } from "~/server/types";
import {
  forecastItem,
  groupSales,
  resolvePeriod,
  trendOf,
  velocityWindows,
  type ForecastSettings,
  type Recommendation,
  type ResolvedPeriod,
  type RiskLevel,
  type SalesGroup,
  type Trend,
  type VelocityUnits,
} from "./calc";

/** Фінансові статуси оплаченого замовлення (як PAID_STATUSES у shopify-sync/mappers.ts, у нижньому регістрі). */
export const PAID_FINANCIAL_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

/** Запобіжник: найбільше варіантів у зведенні (сторінки listStock по 500). */
export const MAX_ANALYTICS_VARIANTS = 10_000;
export const DEFAULT_TOP_LIMIT = 10;

export interface AnalyticsFilters {
  productIds?: string[];
  models?: string[];
  colors?: string[];
}

export function hasAnalyticsFilters(f: AnalyticsFilters): boolean {
  return Boolean(f.productIds?.length || f.models?.length || f.colors?.length);
}

function variantFilter(f: AnalyticsFilters): SQL | undefined {
  return and(
    f.productIds?.length ? inArray(productVariants.productId, f.productIds) : undefined,
    f.models?.length ? inArray(productVariants.model, f.models) : undefined,
    f.colors?.length ? inArray(productVariants.color, f.colors) : undefined,
  );
}

/** Умова «продаж»: оплачене, не скасоване замовлення. */
export function saleOrderCondition(): SQL {
  return and(
    ne(orders.status, "cancelled"),
    isNull(orders.cancelledAt),
    inArray(sql`lower(${orders.financialStatus})`, [...PAID_FINANCIAL_STATUSES]),
  )!;
}

const ts = (d: Date) => sql`${d.toISOString()}::timestamptz`;

// ---------------------------------------------------------------------------
// Продажі
// ---------------------------------------------------------------------------

export interface VariantSales {
  variantId: string;
  units: number;
  previousUnits: number;
  /** Замовлень з цим варіантом у періоді. */
  orders: number;
}

export interface PeriodSalesTotals {
  units: number;
  previousUnits: number;
  orders: number;
  previousOrders: number;
  /** Одиниці позицій без варіанта (не пов'язані з товаром застосунку); з фільтрами — 0. */
  unmatchedUnits: number;
  previousUnmatchedUnits: number;
}

/** Продажі за період і попередній період такої самої довжини — за варіантами й разом. */
export async function loadPeriodSales(
  db: DbOrTx,
  period: ResolvedPeriod,
  filters: AnalyticsFilters = {},
): Promise<{ byVariant: Map<string, VariantSales>; totals: PeriodSalesTotals }> {
  const currentStart = businessDayStart(period.from);
  const where = and(
    saleOrderCondition(),
    gte(orders.placedAt, businessDayStart(period.previousFrom)),
    lte(orders.placedAt, businessDayEnd(period.to)),
    variantFilter(filters),
  );
  const qty = effectiveLineQuantitySql;
  const inCurrent = sql`${orders.placedAt} >= ${ts(currentStart)}`;
  const [rows, [orderTotals]] = await Promise.all([
    db
      .select({
        variantId: orderLineItems.variantId,
        units: sql<number>`coalesce(sum(${qty}) filter (where ${inCurrent}), 0)`.mapWith(Number),
        previousUnits: sql<number>`coalesce(sum(${qty}) filter (where not (${inCurrent})), 0)`.mapWith(Number),
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${inCurrent} and ${qty} > 0)`.mapWith(Number),
      })
      .from(orderLineItems)
      .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
      .leftJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
      .where(where)
      .groupBy(orderLineItems.variantId),
    db
      .select({
        orders: sql<number>`count(distinct ${orders.id}) filter (where ${inCurrent} and ${qty} > 0)`.mapWith(Number),
        previousOrders: sql<number>`count(distinct ${orders.id}) filter (where not (${inCurrent}) and ${qty} > 0)`.mapWith(Number),
      })
      .from(orderLineItems)
      .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
      .leftJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
      .where(where),
  ]);
  const byVariant = new Map<string, VariantSales>();
  const totals: PeriodSalesTotals = {
    units: 0,
    previousUnits: 0,
    orders: Number(orderTotals?.orders ?? 0),
    previousOrders: Number(orderTotals?.previousOrders ?? 0),
    unmatchedUnits: 0,
    previousUnmatchedUnits: 0,
  };
  for (const r of rows) {
    totals.units += r.units;
    totals.previousUnits += r.previousUnits;
    if (!r.variantId) {
      totals.unmatchedUnits += r.units;
      totals.previousUnmatchedUnits += r.previousUnits;
      continue;
    }
    byVariant.set(r.variantId, { variantId: r.variantId, units: r.units, previousUnits: r.previousUnits, orders: r.orders });
  }
  return { byVariant, totals };
}

/** Продано за останні 30 і 90 днів (до сьогодні включно) за варіантами — для швидкості продажів. */
export async function loadVelocityUnits(db: DbOrTx, today: string, filters: AnalyticsFilters = {}): Promise<Map<string, VelocityUnits>> {
  const w = velocityWindows(today);
  const qty = effectiveLineQuantitySql;
  const rows = await db
    .select({
      variantId: orderLineItems.variantId,
      units30: sql<number>`coalesce(sum(${qty}) filter (where ${orders.placedAt} >= ${ts(businessDayStart(w.short.from))}), 0)`.mapWith(Number),
      units90: sql<number>`coalesce(sum(${qty}), 0)`.mapWith(Number),
    })
    .from(orderLineItems)
    .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
    .innerJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
    .where(
      and(
        saleOrderCondition(),
        isNotNull(orderLineItems.variantId),
        gte(orders.placedAt, businessDayStart(w.long.from)),
        lte(orders.placedAt, businessDayEnd(w.long.to)),
        variantFilter(filters),
      ),
    )
    .groupBy(orderLineItems.variantId);
  return new Map(rows.filter((r) => r.variantId).map((r) => [r.variantId!, { units30: r.units30, units90: r.units90 }]));
}

// ---------------------------------------------------------------------------
// Залишки й собівартість
// ---------------------------------------------------------------------------

/** Усі варіанти активних товарів із балансами (сторінками по 500). */
export async function listAllStock(db: DbOrTx, filters: AnalyticsFilters = {}): Promise<StockRow[]> {
  const out: StockRow[] = [];
  const query = { productIds: filters.productIds, models: filters.models, colors: filters.colors };
  for (let offset = 0; offset < MAX_ANALYTICS_VARIANTS; offset += 500) {
    const page = await listStock(db, query, { sort: "product", limit: 500, offset });
    out.push(...page.rows);
    if (page.rows.length < 500 || out.length >= page.total) break;
  }
  return out;
}

export interface UnitCost {
  unitCost: string;
  currency: string;
  /** Коли записано надходження з цією собівартістю. */
  at: Date;
}

/**
 * Собівартість одиниці з ОСТАННЬОГО надходження з виробництва (рух receipt_production з unit_cost) для кожної позиції.
 * Лише для власника (викликач передає can(actor, "finance.view")).
 */
export async function loadLatestProductionUnitCosts(db: DbOrTx, warehouseId?: string): Promise<Map<string, UnitCost>> {
  const wid = warehouseId ?? (await getDefaultWarehouse(db)).id;
  const rows = await db
    .selectDistinctOn([inventoryMovements.stockItemId], {
      stockItemId: inventoryMovements.stockItemId,
      unitCost: inventoryMovements.unitCost,
      currency: inventoryMovements.costCurrency,
      at: inventoryMovements.createdAt,
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.warehouseId, wid),
        eq(inventoryMovements.type, "receipt_production"),
        isNotNull(inventoryMovements.unitCost),
        isNotNull(inventoryMovements.costCurrency),
      ),
    )
    .orderBy(inventoryMovements.stockItemId, desc(inventoryMovements.createdAt), desc(inventoryMovements.id));
  const out = new Map<string, UnitCost>();
  for (const r of rows) if (r.unitCost && r.currency) out.set(r.stockItemId, { unitCost: r.unitCost, currency: r.currency, at: r.at });
  return out;
}

export interface InventoryValue {
  /** Вартість фактичного залишку (on_hand > 0) за собівартістю, окремо за валютами. */
  totals: Array<{ currency: string; amount: string }>;
  itemsValued: number;
  unitsValued: number;
  /** Позиції з залишком, для яких немає собівартості (ще не було надходження з виробництва з ціною). */
  itemsWithoutCost: number;
  unitsWithoutCost: number;
}

/** Вартість запасу (чиста функція): Σ on_hand × собівартість за валютами. */
export function inventoryValueOf(rows: ReadonlyArray<{ onHand: number; cost: { unitCost: string; currency: string } | null }>): InventoryValue {
  const byCurrency = new Map<string, bigint>();
  const v: InventoryValue = { totals: [], itemsValued: 0, unitsValued: 0, itemsWithoutCost: 0, unitsWithoutCost: 0 };
  for (const r of rows) {
    if (r.onHand <= 0) continue;
    if (!r.cost) {
      v.itemsWithoutCost += 1;
      v.unitsWithoutCost += r.onHand;
      continue;
    }
    byCurrency.set(r.cost.currency, (byCurrency.get(r.cost.currency) ?? 0n) + toMinor(r.cost.unitCost) * BigInt(r.onHand));
    v.itemsValued += 1;
    v.unitsValued += r.onHand;
  }
  v.totals = [...byCurrency]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, minor]) => ({ currency, amount: fromMinor(minor) }));
  return v;
}

// ---------------------------------------------------------------------------
// Зведення
// ---------------------------------------------------------------------------

export interface VariantAnalytics {
  variantId: string;
  productId: string;
  /** null — позиція ще не мала руху. */
  stockItemId: string | null;
  productTitle: string;
  /** Назва варіанта без «Default Title». */
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  model: string | null;
  color: string | null;
  /** Збережене посилання на зображення Shopify. */
  imageUrl: string | null;
  /** Активний товар (є в залишках); false — архівний/видалений, лише історія продажів. */
  active: boolean;
  tracking: StockTrackingState | null;
  /** Прогноз зроблено (активний товар з відкритим обліком). */
  forecast: boolean;
  units: number;
  previousUnits: number;
  orders: number;
  trend: Trend;
  units30: number;
  units90: number;
  velocity30: number;
  velocity90: number;
  /** Зважена швидкість (шт./день). */
  velocity: number;
  onHand: number;
  reserved: number;
  available: number;
  defective: number;
  inProduction: number;
  /** У ще не запущених партіях. */
  planned: number;
  nextReadyDate: string | null;
  coverDays: number | null;
  stockOutDate: string | null;
  risk: RiskLevel;
  /** null — без прогнозу (облік не відкрито / товар неактивний). */
  recommendation: Recommendation | null;
  /** Лише з includeCosts (finance.view); інакше null. */
  cost: { unitCost: string; currency: string } | null;
}

export interface AnalyticsKpi {
  unitsSold: number;
  previousUnits: number;
  trend: Trend;
  orders: number;
  previousOrders: number;
  ordersTrend: Trend;
  /** Середньо за день у періоді (шт.). */
  avgDailyUnits: number;
  variantsSold: number;
  unmatchedUnits: number;
  onHandUnits: number;
  availableUnits: number;
  inProductionUnits: number;
  plannedUnits: number;
  /** Позицій із прогнозом (відкритий облік) і без нього. */
  forecastVariants: number;
  notForecastVariants: number;
  atRisk: number;
  outOfStock: number;
  recommendations: number;
  recommendedUnits: number;
}

export interface WarehouseAnalytics {
  today: string;
  period: ResolvedPeriod;
  settings: ForecastSettings & { lowStockThreshold: number };
  filters: AnalyticsFilters;
  kpi: AnalyticsKpi;
  topProducts: SalesGroup[];
  topColors: SalesGroup[];
  topModels: SalesGroup[];
  /** Усі варіанти з продажами або залишком (за спаданням продажів у періоді). */
  variants: VariantAnalytics[];
  /** Під ризиком: немає доступних (а попит є) або закінчиться раніше, ніж встигне нова партія. */
  atRisk: VariantAnalytics[];
  /** Рекомендовані партії (quantity > 0): спершу ті, що закінчаться раніше. */
  recommendations: VariantAnalytics[];
  includeCosts: boolean;
  /** Лише з includeCosts. */
  inventoryValue: InventoryValue | null;
}

export interface ComputeAnalyticsOptions {
  today: string;
  period: ResolvedPeriod;
  filters?: AnalyticsFilters;
  includeCosts?: boolean;
  topLimit?: number;
}

interface VariantMeta {
  productId: string;
  productTitle: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
}

async function loadVariantMeta(db: DbOrTx, ids: readonly string[]): Promise<Map<string, VariantMeta>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ v: productVariants, productTitle: products.title, productImage: products.imageUrl })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(inArray(productVariants.id, [...ids]));
  return new Map(
    rows.map((r) => [
      r.v.id,
      {
        productId: r.v.productId,
        productTitle: r.productTitle,
        variantTitle: displayVariantTitle(r.v.title),
        sku: r.v.sku,
        barcode: r.v.barcode,
        model: r.v.model,
        color: r.v.color,
        imageUrl: r.v.imageUrl ?? r.productImage,
      },
    ]),
  );
}

const byStockOut = (a: VariantAnalytics, b: VariantAnalytics) =>
  (a.stockOutDate ?? "9999-12-31").localeCompare(b.stockOutDate ?? "9999-12-31") ||
  b.velocity - a.velocity ||
  a.productTitle.localeCompare(b.productTitle) ||
  (a.variantTitle ?? "").localeCompare(b.variantTitle ?? "");

/** Зведення аналітики (без перевірки прав — викликач перевіряє warehouse.view і передає includeCosts). */
export async function computeWarehouseAnalytics(db: DbOrTx, opts: ComputeAnalyticsOptions): Promise<WarehouseAnalytics> {
  const filters = opts.filters ?? {};
  const includeCosts = opts.includeCosts === true;
  const warehouseSettings = await getSetting(db, "warehouse");
  const settings = {
    productionLeadDays: warehouseSettings.productionLeadDays,
    targetCoverDays: warehouseSettings.targetCoverDays,
    batchRounding: warehouseSettings.batchRounding,
    lowStockThreshold: warehouseSettings.lowStockThreshold,
  };
  const [stock, velocityUnits, sales, production, costs] = await Promise.all([
    listAllStock(db, filters),
    loadVelocityUnits(db, opts.today, filters),
    loadPeriodSales(db, opts.period, filters),
    openProductionByVariant(db),
    includeCosts ? loadLatestProductionUnitCosts(db) : Promise.resolve(new Map<string, UnitCost>()),
  ]);
  const productionByVariant = new Map(production.map((p) => [p.variantId, p]));
  const stockByVariant = new Map(stock.map((s) => [s.variantId, s]));
  const salesOnly = [...new Set([...sales.byVariant.keys(), ...velocityUnits.keys()])].filter((id) => !stockByVariant.has(id));
  const meta = await loadVariantMeta(db, salesOnly);

  const variants: VariantAnalytics[] = [];
  const build = (variantId: string, s: StockRow | null, m: VariantMeta | null) => {
    const info = s
      ? {
          productId: s.productId,
          productTitle: s.productTitle,
          variantTitle: displayVariantTitle(s.variantTitle),
          sku: s.sku,
          barcode: s.barcode,
          model: s.model,
          color: s.color,
          imageUrl: s.imageUrl,
        }
      : m!;
    const sold = sales.byVariant.get(variantId) ?? { units: 0, previousUnits: 0, orders: 0 };
    const vu = velocityUnits.get(variantId) ?? { units30: 0, units90: 0 };
    const prod = productionByVariant.get(variantId);
    const balance = {
      onHand: s?.onHand ?? 0,
      reserved: s?.reserved ?? 0,
      available: s?.available ?? 0,
      defective: s?.defective ?? 0,
      inProduction: s?.inProduction ?? 0,
    };
    const planned = prod?.planned ?? 0;
    const canForecast = Boolean(s && s.tracking === "opened");
    const f = forecastItem({ ...vu, available: balance.available, inProduction: balance.inProduction, planned }, settings, opts.today);
    const cost = includeCosts && s?.stockItemId ? (costs.get(s.stockItemId) ?? null) : null;
    variants.push({
      variantId,
      stockItemId: s?.stockItemId ?? null,
      ...info,
      active: Boolean(s),
      tracking: s?.tracking ?? null,
      forecast: canForecast,
      units: sold.units,
      previousUnits: sold.previousUnits,
      orders: sold.orders,
      trend: trendOf(sold.units, sold.previousUnits),
      units30: vu.units30,
      units90: vu.units90,
      velocity30: f.velocity30,
      velocity90: f.velocity90,
      velocity: f.velocity,
      ...balance,
      planned,
      nextReadyDate: prod?.nextReadyDate ?? null,
      coverDays: canForecast ? f.coverDays : null,
      stockOutDate: canForecast ? f.stockOutDate : null,
      risk: canForecast ? f.risk : "none",
      recommendation: canForecast ? f.recommendation : null,
      cost: cost ? { unitCost: cost.unitCost, currency: cost.currency } : null,
    });
  };
  for (const s of stock) build(s.variantId, s, null);
  for (const id of salesOnly) {
    const m = meta.get(id);
    if (m) build(id, null, m);
  }
  variants.sort(
    (a, b) =>
      b.units - a.units ||
      b.velocity - a.velocity ||
      a.productTitle.localeCompare(b.productTitle) ||
      (a.variantTitle ?? "").localeCompare(b.variantTitle ?? "") ||
      a.variantId.localeCompare(b.variantId),
  );

  const atRisk = variants.filter((v) => v.risk !== "none").sort(byStockOut);
  const recommendations = variants
    .filter((v) => (v.recommendation?.quantity ?? 0) > 0)
    .sort((a, b) => byStockOut(a, b) || (b.recommendation?.quantity ?? 0) - (a.recommendation?.quantity ?? 0));
  const salesLines = variants.map((v) => ({
    variantId: v.variantId,
    productId: v.productId,
    productTitle: v.productTitle,
    model: v.model,
    color: v.color,
    imageUrl: v.imageUrl,
    units: v.units,
    previousUnits: v.previousUnits,
  }));
  const topLimit = opts.topLimit ?? DEFAULT_TOP_LIMIT;
  const active = variants.filter((v) => v.active);
  const forecasted = active.filter((v) => v.forecast);
  const sum = (rows: readonly VariantAnalytics[], pick: (v: VariantAnalytics) => number) => rows.reduce((s, v) => s + pick(v), 0);
  const totals = sales.totals;
  // Разом з одиницями позицій без варіанта (продаж відбувся, хоч і не прив'язаний до товару застосунку).
  const unitsSold = totals.units;
  const kpi: AnalyticsKpi = {
    unitsSold,
    previousUnits: totals.previousUnits,
    trend: trendOf(unitsSold, totals.previousUnits),
    orders: totals.orders,
    previousOrders: totals.previousOrders,
    ordersTrend: trendOf(totals.orders, totals.previousOrders),
    avgDailyUnits: opts.period.days > 0 ? unitsSold / opts.period.days : 0,
    variantsSold: variants.filter((v) => v.units > 0).length,
    unmatchedUnits: totals.unmatchedUnits,
    onHandUnits: sum(active, (v) => v.onHand),
    availableUnits: sum(active, (v) => v.available),
    inProductionUnits: sum(active, (v) => v.inProduction),
    plannedUnits: sum(active, (v) => v.planned),
    forecastVariants: forecasted.length,
    notForecastVariants: active.length - forecasted.length,
    atRisk: atRisk.length,
    outOfStock: atRisk.filter((v) => v.risk === "out").length,
    recommendations: recommendations.length,
    recommendedUnits: sum(recommendations, (v) => v.recommendation?.quantity ?? 0),
  };
  return {
    today: opts.today,
    period: opts.period,
    settings,
    filters,
    kpi,
    topProducts: groupSales(salesLines, "product", topLimit),
    topColors: groupSales(salesLines, "color", topLimit),
    topModels: groupSales(salesLines, "model", topLimit),
    variants,
    atRisk,
    recommendations,
    includeCosts,
    inventoryValue: includeCosts ? inventoryValueOf(active) : null,
  };
}

// ---------------------------------------------------------------------------
// Короткий підсумок рекомендацій (головна сторінка)
// ---------------------------------------------------------------------------

export interface RecommendationSummary {
  /** Позицій під ризиком (немає доступних при попиті або закінчаться раніше, ніж встигне нова партія). */
  atRisk: number;
  /** З них уже немає доступних. */
  outOfStock: number;
  /** Позицій, для яких рекомендовано нову партію (quantity > 0). */
  recommendations: number;
  /** Рекомендовано одиниць разом. */
  recommendedUnits: number;
}

/**
 * Лічильники ризиків і рекомендацій партій — ті самі правила й числа, що kpi.atRisk / kpi.recommendations у
 * computeWarehouseAnalytics (без фільтрів), але дешевше: лише ВІДКРИТІ позиції активних товарів (прогноз робиться
 * лише для них), без продажів за період і без метаданих архівних товарів. Без собівартості й даних покупців —
 * лише кількості (для головної: картка «Нові партії» для production.manage).
 */
export async function loadRecommendationSummary(db: DbOrTx, today: string): Promise<RecommendationSummary> {
  const warehouseSettings = await getSetting(db, "warehouse");
  const settings: ForecastSettings = {
    productionLeadDays: warehouseSettings.productionLeadDays,
    targetCoverDays: warehouseSettings.targetCoverDays,
    batchRounding: warehouseSettings.batchRounding,
  };
  const opened: StockRow[] = [];
  for (let offset = 0; offset < MAX_ANALYTICS_VARIANTS; offset += 500) {
    const page = await listStock(db, { tracking: ["opened"] }, { sort: "product", limit: 500, offset });
    opened.push(...page.rows);
    if (page.rows.length < 500 || opened.length >= page.total) break;
  }
  const summary: RecommendationSummary = { atRisk: 0, outOfStock: 0, recommendations: 0, recommendedUnits: 0 };
  if (opened.length === 0) return summary;
  const [velocityUnits, production] = await Promise.all([loadVelocityUnits(db, today), openProductionByVariant(db)]);
  const planned = new Map(production.map((p) => [p.variantId, p.planned]));
  for (const s of opened) {
    const vu = velocityUnits.get(s.variantId) ?? { units30: 0, units90: 0 };
    const f = forecastItem(
      { ...vu, available: s.available, inProduction: s.inProduction, planned: planned.get(s.variantId) ?? 0 },
      settings,
      today,
    );
    if (f.risk !== "none") summary.atRisk += 1;
    if (f.risk === "out") summary.outOfStock += 1;
    if (f.recommendation.quantity > 0) {
      summary.recommendations += 1;
      summary.recommendedUnits += f.recommendation.quantity;
    }
  }
  return summary;
}

/**
 * Зведення від імені актора: warehouse.view обов'язково (ForbiddenError), собівартість — лише finance.view.
 * Період за замовчуванням — 30 днів до сьогодні (Київ).
 */
export async function loadWarehouseAnalytics(
  ctx: ServiceContext,
  opts: { period?: ResolvedPeriod; filters?: AnalyticsFilters; topLimit?: number } = {},
): Promise<WarehouseAnalytics> {
  requirePermission(ctx.actor, "warehouse.view");
  const today = businessDate(ctx.now());
  return computeWarehouseAnalytics(ctx.db, {
    today,
    period: opts.period ?? resolvePeriod({ today }),
    filters: opts.filters,
    includeCosts: can(ctx.actor, "finance.view"),
    topLimit: opts.topLimit,
  });
}

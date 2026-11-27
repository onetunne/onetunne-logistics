/**
 * Відкриття складського обліку зі знімка Shopify у ЛОКАЦІЇ складу (робочий режим; docs/stage5-design.md §11).
 *
 * Чому не product_variants.inventory_available: це ProductVariant.inventoryQuantity — «total sellable quantity», сума
 * по ВСІХ локаціях магазину, а звірка й передача залишків працюють з однією локацією складу
 * (warehouses.shopify_location_id). Тут S = InventoryLevel.quantities(available) саме в цій локації (читання
 * readShopifyLevels зі звірки), T = момент ПЕРЕД запитом сторінки рівнів (замовлення між запитом і записом не
 * рахуються двічі; похибка — у бік заниження, яке покаже звірка).
 *
 * Порядок (initializeInventoryFromShopify, лише власник — warehouse.adjust):
 * 1. Локація складу: збережена або єдина в магазині (ensureWarehouseLocation); кілька → власник обирає на сторінці
 *    «Склад → Shopify» (до вибору відкриття не виконується).
 * 2. Позиції відкритих замовлень Shopify без current_quantity (збережені до етапу 5) перечитуються з Shopify
 *    (syncOrder; лише читання): інакше резервувалися б повернені/видалені одиниці. Не вдалося / замовлення має
 *    неперенесені зміни позицій (активна накладна) → відкриття відкладається (orders_not_ready) — знімок узгоджується
 *    з позиціями лише коли вони актуальні.
 * 3. Рівні локації для відстежуваних невідкритих варіантів → initializeInventory зі знімком `location`.
 *
 * Варіанти, що з'являються після ініціалізації (новий колір, товар почав відстежуватися), відкриваються автоматично
 * тією самою формулою після синхронізації товару (openNewVariantsFromShopify у обробнику shopify.sync_product).
 * Нічого не записує в Shopify.
 */
import { and, count, eq, exists, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import { inventoryBalances, orderLineItems, orders, productVariants, products, stockItems } from "~/db/schema";
import { SYSTEM_ACTOR, requirePermission } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { RECONCILE_PAGE_SIZE } from "~/integrations/shopify/inventory-graphql";
import {
  NON_RESERVING_STATUSES,
  initializeInventory,
  openInventory,
  type InitializeInventoryResult,
  type OpeningLevel,
  type OpeningSnapshot,
} from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { ensureWarehouseLocation } from "~/modules/inventory-sync/location.server";
import { readShopifyLevels } from "~/modules/inventory-sync/reconcile.server";
import type { ServiceContext } from "~/server/types";
import { syncOrder } from "./sync.server";

/** Замовлень, що перечитуються з Shopify за одне натискання (решта — наступним натисканням). */
export const MAX_ORDER_REFRESH_PER_RUN = 40;

export type ShopifyOpeningOutcome =
  | { kind: "opened"; result: InitializeInventoryResult; refreshedOrders: number }
  /** Локацію складу не визначено: кілька локацій (власник обирає) або жодної активної. */
  | { kind: "location_required"; state: "ambiguous" | "none" }
  /**
   * Позиції частини відкритих замовлень ще не актуальні: staleOrders — без current_quantity (не вдалося перечитати /
   * не встигли / не знайдено в Shopify), pendingOrders — Shopify змінив позиції, але застосунок їх не застосував
   * (активна накладна). Нічого не відкрито.
   */
  | { kind: "orders_not_ready"; refreshedOrders: number; failedOrders: number; staleOrders: number; pendingOrders: number };

const openShopifyOrders = () =>
  and(eq(orders.source, "shopify"), isNotNull(orders.shopifyOrderId), notInArray(orders.status, [...NON_RESERVING_STATUSES]));

const hasLegacyLine = (db: DbOrTx) =>
  exists(
    db
      .select({ one: sql`1` })
      .from(orderLineItems)
      .where(and(eq(orderLineItems.orderId, orders.id), isNull(orderLineItems.currentQuantity))),
  );

async function legacyOrders(db: DbOrTx, limit: number): Promise<string[]> {
  const rows = await db
    .select({ gid: orders.shopifyOrderId })
    .from(orders)
    .where(and(openShopifyOrders(), hasLegacyLine(db)))
    .orderBy(orders.placedAt, orders.id)
    .limit(limit);
  return rows.map((r) => r.gid!);
}

async function countNotReady(db: DbOrTx): Promise<{ staleOrders: number; pendingOrders: number }> {
  const [stale] = await db.select({ c: count() }).from(orders).where(and(openShopifyOrders(), hasLegacyLine(db)));
  const [pending] = await db
    .select({ c: count() })
    .from(orders)
    .where(and(notInArray(orders.status, [...NON_RESERVING_STATUSES]), isNotNull(orders.shopifyLinesPendingAt)));
  return { staleOrders: Number(stale?.c ?? 0), pendingOrders: Number(pending?.c ?? 0) };
}

/**
 * Перечитує з Shopify відкриті замовлення з позиціями без current_quantity (до MAX_ORDER_REFRESH_PER_RUN).
 * Однакова кількість заповнюється тихо, змінена (повернення/видалення) — звичайною синхронізацією з історією.
 */
export async function refreshLegacyOrderLines(ctx: ServiceContext, admin: AdminGraphql): Promise<{ refreshed: number; failed: number }> {
  const systemCtx: ServiceContext = { ...ctx, actor: SYSTEM_ACTOR };
  let refreshed = 0;
  let failed = 0;
  for (const gid of await legacyOrders(ctx.db, MAX_ORDER_REFRESH_PER_RUN)) {
    try {
      await syncOrder(systemCtx, admin, gid, "live");
      refreshed++;
    } catch (e) {
      failed++;
      logger.warn("inventory.opening_order_refresh_failed", { error: e });
    }
  }
  return { refreshed, failed };
}

/** Відстежувані варіанти, ще не відкриті на складі (з InventoryItem Shopify); productId — лише цього товару. */
async function unopenedVariants(db: DbOrTx, warehouseId: string, productId?: string): Promise<Array<{ id: string; inventoryItemId: string }>> {
  const rows = await db
    .select({ id: productVariants.id, inventoryItemId: productVariants.inventoryItemId })
    .from(productVariants)
    .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
    .leftJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouseId)))
    .where(
      and(
        isNotNull(productVariants.inventoryAvailable),
        isNotNull(productVariants.inventoryItemId),
        isNull(inventoryBalances.openedAt),
        productId ? eq(productVariants.productId, productId) : undefined,
      ),
    )
    .orderBy(productVariants.id);
  return rows.map((r) => ({ id: r.id, inventoryItemId: r.inventoryItemId! }));
}

/**
 * Знімок локації: «доступно» кожного варіанта в локації складу. Час знімка — момент ПЕРЕД запитом своєї сторінки.
 * Немає рівня в локації / Shopify не відстежує / не знайдено → notStocked (варіант не відкривається).
 */
export async function readLocationSnapshot(
  admin: AdminGraphql,
  locationId: string,
  variants: ReadonlyArray<{ id: string; inventoryItemId: string }>,
): Promise<Extract<OpeningSnapshot, { kind: "location" }>> {
  const levels = new Map<string, OpeningLevel>();
  let notStocked = 0;
  for (let i = 0; i < variants.length; i += RECONCILE_PAGE_SIZE) {
    const page = variants.slice(i, i + RECONCILE_PAGE_SIZE);
    const snapshotAt = new Date();
    const reads = await readShopifyLevels(
      admin,
      page.map((v) => v.inventoryItemId),
      locationId,
    );
    for (const v of page) {
      const read = reads.get(v.inventoryItemId);
      if (read?.kind === "ok") levels.set(v.id, { available: read.quantities.available, snapshotAt });
      else notStocked++;
    }
  }
  return { kind: "location", locationId, levels, notStocked };
}

/** Відкриття обліку власником у робочому режимі (кроки — вгорі файлу). */
export async function initializeInventoryFromShopify(ctx: ServiceContext, admin: AdminGraphql): Promise<ShopifyOpeningOutcome> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const warehouse = await getDefaultWarehouse(ctx.db);
  const location = await ensureWarehouseLocation(ctx.db, admin, warehouse);
  if (location.status !== "ready") return { kind: "location_required", state: location.status };
  const refresh = await refreshLegacyOrderLines(ctx, admin);
  const notReady = await countNotReady(ctx.db);
  if (refresh.failed > 0 || notReady.staleOrders > 0 || notReady.pendingOrders > 0) {
    return { kind: "orders_not_ready", refreshedOrders: refresh.refreshed, failedOrders: refresh.failed, ...notReady };
  }
  const snapshot = await readLocationSnapshot(admin, location.locationId, await unopenedVariants(ctx.db, warehouse.id));
  const result = await initializeInventory(ctx, { snapshot });
  return { kind: "opened", result, refreshedOrders: refresh.refreshed };
}

/**
 * Автоматичне відкриття варіантів, що з'явилися після ініціалізації складу (новий варіант, почав відстежуватися), —
 * та сама формула й знімок локації. Викликається після синхронізації товару; склад ще не ініціалізовано, немає
 * невідкритих варіантів або локація не визначена → нічого (власник бачить їх на сторінці «Склад»).
 */
export async function openNewVariantsFromShopify(
  db: Db,
  admin: AdminGraphql,
  /** Товар, що щойно синхронізовано; null — усі невідкриті варіанти (сторінка повної синхронізації товарів). */
  productGid: string | null,
): Promise<InitializeInventoryResult | null> {
  const warehouse = await getDefaultWarehouse(db);
  if (!warehouse.inventoryInitializedAt) return null;
  let productId: string | undefined;
  if (productGid) {
    const [product] = await db.select({ id: products.id }).from(products).where(eq(products.shopifyProductId, productGid));
    if (!product) return null;
    productId = product.id;
  }
  const candidates = await unopenedVariants(db, warehouse.id, productId);
  if (candidates.length === 0) return null;
  const location = await ensureWarehouseLocation(db, admin, warehouse);
  if (location.status !== "ready") {
    logger.info("inventory.auto_open_skipped", { reason: `location_${location.status}`, variants: candidates.length });
    return null;
  }
  const snapshot = await readLocationSnapshot(admin, location.locationId, candidates);
  if (snapshot.levels.size === 0) return null;
  return openInventory({ db, actor: SYSTEM_ACTOR, now: () => new Date() }, { snapshot, onlyIfInitialized: true });
}

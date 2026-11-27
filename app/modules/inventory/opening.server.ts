/**
 * Відкриття товарів в обліку складу: початкові залишки зі знімка Shopify (docs/stage5-design.md §1–2, §11).
 *
 * Товар «відкрито» (inventory_balances.opened_at) — з цього моменту його облік пов'язано з Shopify: резерви під
 * замовлення, списання при передачі перевізнику, передача внутрішніх змін у Shopify. Відкриваються варіанти, залишок
 * яких Shopify відстежує (inventory_available ≠ null); решта — «невідстежувані» (без резервів і хибних попереджень).
 *
 * Формула для варіанта (S — «доступно» знімка, T — час знімка, H — on_hand від внутрішніх рухів ДО відкриття):
 *     on_hand = H + max(0, S + Σ кількостей відкритих оплачених замовлень, створених (і позицій, доданих) до T,
 *                              крім уже виконаних у Shopify поза застосунком)
 * Знімок (OpeningSnapshot):
 * - `location` (робочий режим, modules/shopify-sync/inventory-opening.server.ts): S = InventoryLevel.quantities
 *   (available) у ЛОКАЦІЇ СКЛАДУ (warehouses.shopify_location_id — та сама, з якою працюють звірка й передача),
 *   T = момент ПЕРЕД запитом цієї сторінки рівнів (похибка — у бік заниження). Варіанти, яких немає в локації
 *   (not_stocked/untracked/missing), не відкриваються (skippedNotStocked).
 * - `stored` (демо, тести): S = product_variants.inventory_available (ProductVariant.inventoryQuantity — СУМА по всіх
 *   локаціях), T = product_variants.inventory_synced_at (момент перед читанням товару) або момент відкриття.
 *   Для магазину з кількома локаціями не підходить — робочий інтерфейс використовує лише `location`.
 * Чому: «available» Shopify уже НЕ містить одиниць, закріплених за замовленнями, створеними до знімка (committed);
 * фізично вони ще на складі (on_hand) і зарезервовані → доступно застосунку = S. Замовлення, створені після T,
 * знімок ще містить — їх лише резервуємо. Замовлення до T, уже виконане (частково) в Shopify поза застосунком, не
 * рахується й не резервується: виконаних одиниць немає ні в S, ні на складі (для часткового виконання розподіл за
 * позиціями невідомий — доступно лишається точним, on_hand занижено на невиконані одиниці; див. reservations.server.ts).
 * Внутрішні рухи до відкриття Shopify не надсилалися (ledger: «skipped»), тож вони ДОДАЮТЬСЯ (не затираються). Якщо H ≠ 0, створюється розбіжність inventory_conflicts
 * (opened_with_internal_history): власник перевіряє, чи не внесено ці одиниці в Shopify вручну.
 * Від'ємна сума (Shopify «перепродав» або закріпив одиниці за неоплаченими замовленнями, яких немає в застосунку)
 * обрізається до 0 (причина shopify_snapshot_clamped) — розбіжність покаже звірка з Shopify.
 *
 * Атомарність: знімок, позначки відкриття й резерви ВСІХ відкритих замовлень для цих товарів — ОДНА транзакція.
 * Тож немає вікна, у якому замовлення, враховане в знімку, передано перевізнику без резерву (і не списано).
 * Склад блокується FOR NO KEY UPDATE (lockWarehouseForInitialization): синхронізації резервів (FOR SHARE) чекають
 * і після завершення застосовують різницю від резервів ініціалізації; інші рухи (KEY SHARE зовнішніх ключів)
 * не блокуються. Замовлення не блокуються (резерви пишуться напряму планувальником planReservationChanges).
 * Замовлення, що з'явиться пізніше, але створене до T (пізній webhook, імпорт), отримає корекцію on_hand
 * при першому резерві (reservations.server.ts, ключ opening_line:<позиція>).
 *
 * Повторний виклик ідемпотентний: відкриті товари не змінюються, нові варіанти (з'явилися або почали
 * відстежуватися пізніше) відкриваються. Лише власник (warehouse.adjust).
 *
 * Обмеження (документовано): Shopify також закріплює одиниці за НЕОПЛАЧЕНИМИ замовленнями, яких застосунок не
 * імпортує; on_hand застосунку може бути меншим за on_hand Shopify на цю кількість. Позиції без shopify_added_at
 * (до етапу 5) порівнюються лише за orders.placed_at (processedAt; створені заднім числом — «до знімка»).
 * Перед відкриттям у робочому режимі позиції відкритих замовлень без current_quantity (збережені до етапу 5)
 * перечитуються з Shopify (повернені/видалені одиниці не резервуються).
 */
import { and, count, eq, inArray, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryBalances,
  inventoryConflicts,
  orderLineItems,
  orders,
  productVariants,
  stockItems,
  stockReservations,
  warehouses,
} from "~/db/schema";
import { SHIPPED_STATUSES, isFulfilledInShopify, type OrderStatus } from "~/domain/order-status";
import { requirePermission, type Actor } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { getSetting } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import { inventoryKeys } from "./keys";
import {
  applyMovements,
  ensureStockItemsForVariants,
  evaluateStockAlerts,
  lockBalances,
  type MovementInput,
} from "./ledger.server";
import { effectiveLineQuantity } from "./quantities";
import {
  lineInSnapshot,
  planReservationChanges,
  syncOrderReservations,
  toPlanReservation,
  writePlannedRows,
  type PlannedRow,
} from "./reservations.server";
import { getDefaultWarehouse, lockWarehouseForInitialization } from "./warehouse.server";

/** Статуси, у яких замовлення НЕ резервується (скасоване або вже передане перевізнику). */
export const NON_RESERVING_STATUSES: readonly OrderStatus[] = ["cancelled", ...SHIPPED_STATUSES];

export interface InitializeInventoryResult {
  warehouseId: string;
  /** true — склад уже був ініціалізований раніше (відкрито лише нові позиції). */
  alreadyInitialized: boolean;
  initializedAt: Date;
  /** Відкрито цим викликом. */
  opened: number;
  /** Уже були відкриті раніше. */
  alreadyOpened: number;
  /** Варіанти без кількості в Shopify (не відстежуються) — не відкриті. */
  skippedUntracked: number;
  /** Від'ємна сума обрізана до 0. */
  clampedNegative: number;
  /** Відкриті з внутрішніми рухами до відкриття (H ≠ 0) — для кожного створено розбіжність. */
  openedWithHistory: number;
  /** Відкриті оплачені замовлення, зарезервовані в тій самій транзакції. */
  ordersSynced: number;
  /** Знімок `location`: відстежувані варіанти, яких немає в локації складу Shopify (не відкриті). */
  skippedNotStocked: number;
  /** Позиції замовлень до знімка, уже виконаних у Shopify поза застосунком: не враховані й не зарезервовані. */
  excludedFulfilledLines: number;
  /**
   * deferUnsettledOrders: варіанти з позицій відкритих замовлень, позиції яких ще не актуальні щодо Shopify
   * (неперенесені зміни або позиції без current_quantity), — не відкриті цим викликом (наступна спроба — пізніше).
   */
  deferredUnsettledVariants: number;
}

/** «Доступно» одного варіанта в знімку локації і час знімка (момент перед запитом). */
export interface OpeningLevel {
  available: number;
  snapshotAt: Date;
}

export type OpeningSnapshot =
  /** Демо/тести: product_variants.inventory_available (сума по локаціях) і inventory_synced_at. */
  | { kind: "stored" }
  /** Робочий режим: рівні локації складу за variantId; лише ці варіанти можуть відкритися. */
  | { kind: "location"; locationId: string; levels: ReadonlyMap<string, OpeningLevel>; notStocked: number };

export interface InitializeInventoryOptions {
  source?: "shopify_snapshot";
  snapshot?: OpeningSnapshot;
  /**
   * Лише якщо склад уже ініціалізовано власником (автоматичне відкриття варіантів, що з'явилися пізніше, —
   * modules/shopify-sync/inventory-opening.server.ts). Не ініціалізовано → null, нічого не змінено.
   */
  onlyIfInitialized?: boolean;
  /**
   * Не відкривати варіанти, що є в позиціях відкритих замовлень з неактуальними щодо Shopify позиціями
   * (variantsOnUnsettledOrders): Σ формули взяв би застарілу кількість (повернені/видалені в Shopify одиниці), і після
   * застосування змін «доступно» застосунку перевищило б Shopify. Перевірка — у транзакції відкриття (після блокування
   * складу). Автоматичне відкриття нових варіантів (inventory-opening.server.ts); власник при ініціалізації взагалі
   * не відкриває облік, доки такі замовлення є (orders_not_ready).
   */
  deferUnsettledOrders?: boolean;
}

/** Хто й коли відкриває (власник через initializeInventory або система — автоматичне відкриття нових варіантів). */
export interface OpeningEnv {
  db: Db;
  actor: Actor;
  now: () => Date;
}

const CHUNK = 500;

/**
 * Варіанти (з variantIds), що є в позиціях відкритих замовлень, чиї позиції ще не узгоджені з Shopify:
 * - замовлення має неперенесені зміни позицій (orders.shopify_lines_pending_at; поки була активна накладна) — Shopify
 *   уже повернув/видалив/змінив одиниці, а позиції застосунку старі;
 * - позиція замовлення Shopify без current_quantity (збережена до етапу 5) — повернення невідомі.
 * Знімок «доступно» для таких варіантів не узгоджується з Σ формули відкриття.
 */
export async function variantsOnUnsettledOrders(db: DbOrTx, variantIds: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (const part of chunks(variantIds)) {
    const rows = await db
      .selectDistinct({ variantId: orderLineItems.variantId })
      .from(orderLineItems)
      .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
      .where(
        and(
          inArray(orderLineItems.variantId, part),
          notInArray(orders.status, [...NON_RESERVING_STATUSES]),
          or(
            isNotNull(orders.shopifyLinesPendingAt),
            and(eq(orders.source, "shopify"), isNotNull(orders.shopifyOrderId), isNull(orderLineItems.currentQuantity)),
          ),
        ),
      );
    for (const r of rows) if (r.variantId) out.add(r.variantId);
  }
  return out;
}
/** Рухів на один виклик applyMovements (межа — MAX_MOVEMENTS_PER_CALL). */
const MOVEMENT_CHUNK = 1500;
const MAX_ATTEMPTS = 3;

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Взаємоблокування / конфлікт серіалізації — транзакцію можна безпечно повторити. */
function isRetryableLockError(e: unknown): boolean {
  const err = e as { code?: string; cause?: { code?: string } } | null;
  const code = err?.code ?? err?.cause?.code;
  return code === "40P01" || code === "40001";
}

export async function initializeInventory(ctx: ServiceContext, opts: InitializeInventoryOptions = {}): Promise<InitializeInventoryResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const result = await openInventory({ db: ctx.db, actor: ctx.actor, now: () => ctx.now() }, { ...opts, onlyIfInitialized: false });
  return result!;
}

/**
 * Відкриття без перевірки дозволу (виклик — initializeInventory після requirePermission або системне автоматичне
 * відкриття нових варіантів з onlyIfInitialized). null — onlyIfInitialized, а склад ще не ініціалізовано.
 */
export async function openInventory(env: OpeningEnv, opts: InitializeInventoryOptions = {}): Promise<InitializeInventoryResult | null> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await env.db.transaction((tx) => initializeInTx(tx, env, opts));
    } catch (e) {
      if (attempt >= MAX_ATTEMPTS || !isRetryableLockError(e)) throw e;
      logger.warn("inventory.initialize_retry", { attempt });
    }
  }
}

interface OpeningItem {
  variantId: string;
  stockItemId: string;
  available: number;
  snapshotAt: Date;
}

async function initializeInTx(tx: Tx, env: OpeningEnv, opts: InitializeInventoryOptions): Promise<InitializeInventoryResult | null> {
  const now = env.now();
  const source = opts.source ?? "shopify_snapshot";
  const snapshot: OpeningSnapshot = opts.snapshot ?? { kind: "stored" };
  const warehouse = await lockWarehouseForInitialization(tx, (await getDefaultWarehouse(tx)).id);
  const alreadyInitialized = Boolean(warehouse.inventoryInitializedAt);
  if (opts.onlyIfInitialized && !alreadyInitialized) return null;

  const variants = await tx
    .select({ id: productVariants.id, available: productVariants.inventoryAvailable, syncedAt: productVariants.inventorySyncedAt })
    .from(productVariants)
    .orderBy(productVariants.id);
  const skippedUntracked = variants.filter((v) => v.available === null).length;
  // S і T кожного відстежуваного варіанта зі знімка (location — лише варіанти, прочитані в локації складу).
  const tracked: Array<{ id: string; available: number; snapshotAt: Date }> = [];
  for (const v of variants) {
    if (v.available === null) continue;
    if (snapshot.kind === "stored") tracked.push({ id: v.id, available: v.available, snapshotAt: v.syncedAt ?? now });
    else {
      const level = snapshot.levels.get(v.id);
      if (level) tracked.push({ id: v.id, available: level.available, snapshotAt: level.snapshotAt });
    }
  }
  const skippedNotStocked = snapshot.kind === "location" ? snapshot.notStocked : 0;

  const stockByVariant = new Map<string, string>();
  for (const part of chunks(tracked.map((v) => v.id))) {
    for (const [variantId, stockItemId] of await ensureStockItemsForVariants(tx, part)) stockByVariant.set(variantId, stockItemId);
  }
  const openedItems = new Set<string>();
  for (const part of chunks([...stockByVariant.values()])) {
    const rows = await tx
      .select({ id: inventoryBalances.stockItemId })
      .from(inventoryBalances)
      .where(and(eq(inventoryBalances.warehouseId, warehouse.id), inArray(inventoryBalances.stockItemId, part), isNotNull(inventoryBalances.openedAt)));
    for (const r of rows) openedItems.add(r.id);
  }
  const unopened: OpeningItem[] = tracked
    .map((v) => ({ variantId: v.id, stockItemId: stockByVariant.get(v.id)!, available: v.available, snapshotAt: v.snapshotAt }))
    .filter((v) => !openedItems.has(v.stockItemId))
    .sort((a, b) => a.stockItemId.localeCompare(b.stockItemId));
  const alreadyOpened = tracked.length - unopened.length;
  // Невідкриті варіанти замовлень з неактуальними щодо Shopify позиціями — не відкриваються (G1a-NEW-2). Зміну, якої
  // застосунок ще не отримав (подія Shopify в дорозі), перевірка не бачить — як і будь-яку пізню подію після знімка;
  // таку розбіжність покаже звірка з Shopify.
  const unsettled =
    opts.deferUnsettledOrders && unopened.length > 0 ? await variantsOnUnsettledOrders(tx, unopened.map((v) => v.variantId)) : new Set<string>();
  const toOpen = unopened.filter((v) => !unsettled.has(v.variantId));
  const deferredUnsettledVariants = unopened.length - toOpen.length;

  let clampedNegative = 0;
  let openedWithHistory = 0;
  let ordersSynced = 0;
  let excludedFulfilledLines = 0;
  if (toOpen.length > 0) {
    // 1. Баланси всіх позицій, що відкриваються, — у глобальному порядку stock_item_id (без взаємоблокувань).
    const balances = new Map<string, number>();
    for (const part of chunks(toOpen)) {
      const locked = await lockBalances(
        tx,
        part.map((v) => ({ warehouseId: warehouse.id, stockItemId: v.stockItemId })),
      );
      for (const b of locked.values()) balances.set(b.stockItemId, b.onHand);
    }

    // 2. Позиції відкритих оплачених замовлень цих варіантів (зафіксовані дані; незавершені зміни замовлень
    //    синхронізуються різницею після цієї транзакції).
    const byVariant = new Map(toOpen.map((v) => [v.variantId, v]));
    const openLines: Array<{ id: string; orderId: string; variantId: string; quantity: number; inSnapshot: boolean }> = [];
    for (const part of chunks(toOpen.map((v) => v.variantId))) {
      const rows = await tx
        .select({
          id: orderLineItems.id,
          orderId: orderLineItems.orderId,
          variantId: orderLineItems.variantId,
          quantity: orderLineItems.quantity,
          currentQuantity: orderLineItems.currentQuantity,
          shopifyAddedAt: orderLineItems.shopifyAddedAt,
          placedAt: orders.placedAt,
          fulfillmentStatus: orders.fulfillmentStatus,
        })
        .from(orderLineItems)
        .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
        .where(and(inArray(orderLineItems.variantId, part), notInArray(orders.status, [...NON_RESERVING_STATUSES])));
      for (const r of rows) {
        const inSnapshot = lineInSnapshot(r.placedAt, r.shopifyAddedAt, byVariant.get(r.variantId!)!.snapshotAt);
        // До знімка й уже виконане в Shopify поза застосунком: одиниць немає ні в S, ні на складі — не рахуємо й не
        // резервуємо (те саме правило першої появи — у syncOrderReservations).
        if (inSnapshot && isFulfilledInShopify(r.fulfillmentStatus)) {
          excludedFulfilledLines++;
          continue;
        }
        openLines.push({ id: r.id, orderId: r.orderId, variantId: r.variantId!, quantity: effectiveLineQuantity(r), inSnapshot });
      }
    }
    const included = new Map<string, number>();
    for (const l of openLines) {
      if (l.inSnapshot) included.set(l.variantId, (included.get(l.variantId) ?? 0) + l.quantity);
    }

    // 3. Рухи opening (додаються до внутрішньої історії H).
    const openingMovements: MovementInput[] = [];
    const conflicts: Array<typeof inventoryConflicts.$inferInsert> = [];
    for (const v of toOpen) {
      const raw = v.available + (included.get(v.variantId) ?? 0);
      const target = Math.max(0, raw);
      if (raw < 0) clampedNegative++;
      const history = balances.get(v.stockItemId) ?? 0;
      openingMovements.push({
        warehouseId: warehouse.id,
        stockItemId: v.stockItemId,
        type: "opening",
        idempotencyKey: inventoryKeys.opening(warehouse.id, v.stockItemId),
        onHandDelta: target,
        reason: raw < 0 ? "shopify_snapshot_clamped" : "shopify_snapshot",
      });
      if (history !== 0) {
        openedWithHistory++;
        conflicts.push({
          stockItemId: v.stockItemId,
          warehouseId: warehouse.id,
          appOnHand: history + target,
          shopifyOnHand: target,
          shopifyAvailable: v.available,
          expectedDiff: 0,
          details: { reason: "opened_with_internal_history", internalOnHand: history, snapshotAt: v.snapshotAt.toISOString() },
        });
      }
    }
    for (const part of chunks(openingMovements, MOVEMENT_CHUNK)) await applyMovements(tx, env.actor, part, { evaluateAlerts: false });

    // 4. Позначка «відкрито» (до резервів: applyMovements дозволяє reserve лише для відкритих товарів).
    for (const part of chunks(toOpen)) {
      const values = sql.join(
        part.map((v) => sql`(${v.stockItemId}::uuid, ${v.snapshotAt.toISOString()}::timestamptz)`),
        sql`, `,
      );
      await tx.execute(sql`
        update ${inventoryBalances} as b
        set opened_at = ${now.toISOString()}::timestamptz, opening_snapshot_at = v.snapshot_at, updated_at = ${now.toISOString()}::timestamptz
        from (values ${values}) as v(stock_item_id, snapshot_at)
        where b.warehouse_id = ${warehouse.id}::uuid and b.stock_item_id = v.stock_item_id and b.opened_at is null`);
    }
    for (const part of chunks(conflicts)) {
      await tx
        .insert(inventoryConflicts)
        .values(part)
        .onConflictDoNothing({
          target: [inventoryConflicts.stockItemId, inventoryConflicts.warehouseId],
          where: sql`${inventoryConflicts.status} = 'open'`,
        });
    }

    // 5. Резерви відкритих замовлень (корекцію знімка вже включено в opening → inSnapshot: false).
    const existing = new Map<string, typeof stockReservations.$inferSelect>();
    for (const part of chunks(openLines.map((l) => l.id))) {
      for (const r of await tx.select().from(stockReservations).where(inArray(stockReservations.orderLineItemId, part))) existing.set(r.orderLineItemId, r);
    }
    const linesByOrder = new Map<string, typeof openLines>();
    for (const l of openLines) linesByOrder.set(l.orderId, [...(linesByOrder.get(l.orderId) ?? []), l]);
    const movements: MovementInput[] = [];
    const rowsByOrder = new Map<string, PlannedRow[]>();
    for (const [orderId, lines] of linesByOrder) {
      const plan = planReservationChanges({
        mode: "reserve",
        warehouseId: warehouse.id,
        lines: lines.map((l) => ({ lineItemId: l.id, stockItemId: byVariant.get(l.variantId)!.stockItemId, quantity: l.quantity, inSnapshot: false })),
        reservations: lines.flatMap((l) => {
          const r = existing.get(l.id);
          return r ? [toPlanReservation(r)] : [];
        }),
      });
      movements.push(...plan.movements.map((m) => ({ ...m, orderId })));
      if (plan.rows.length > 0) rowsByOrder.set(orderId, plan.rows);
    }
    for (const part of chunks(movements, MOVEMENT_CHUNK)) await applyMovements(tx, env.actor, part, { evaluateAlerts: false });
    for (const [orderId, rows] of rowsByOrder) await writePlannedRows(tx, orderId, rows, now);
    ordersSynced = rowsByOrder.size;

    const threshold = (await getSetting(tx, "warehouse")).lowStockThreshold;
    for (const part of chunks(toOpen.map((v) => v.stockItemId))) await evaluateStockAlerts(tx, part, { defaultThreshold: threshold });
  }

  const initializedAt = warehouse.inventoryInitializedAt ?? now;
  if (!alreadyInitialized) {
    await tx.update(warehouses).set({ inventoryInitializedAt: initializedAt, updatedAt: now }).where(eq(warehouses.id, warehouse.id));
  }
  const result: InitializeInventoryResult = {
    warehouseId: warehouse.id,
    alreadyInitialized,
    initializedAt,
    opened: toOpen.length,
    alreadyOpened,
    skippedUntracked,
    clampedNegative,
    openedWithHistory,
    ordersSynced,
    skippedNotStocked,
    excludedFulfilledLines,
    deferredUnsettledVariants,
  };
  // Автоматичне відкриття без нових позицій — без запису в журнал (кожна синхронізація товару).
  if (opts.onlyIfInitialized && toOpen.length === 0) return result;
  await writeAudit(tx, env.actor, "inventory.initialized", { type: "warehouse", id: warehouse.id }, {
    source,
    snapshot: snapshot.kind,
    automatic: Boolean(opts.onlyIfInitialized),
    opened: result.opened,
    alreadyOpened,
    skippedUntracked,
    skippedNotStocked,
    clampedNegative,
    openedWithHistory,
    ordersSynced,
    excludedFulfilledLines,
    deferredUnsettledVariants,
    alreadyInitialized,
  });
  return result;
}

/**
 * Відновлення: синхронізує резерви всіх відкритих замовлень (кожне — окрема транзакція; ідемпотентно; помилка
 * одного замовлення не зупиняє решту — повертається в failed). Після initializeInventory не потрібна (резерви
 * створено в тій самій транзакції); для перевірки/відновлення після ручних змін бази. Лише власник.
 */
export async function syncAllOpenOrderReservations(ctx: ServiceContext): Promise<{ synced: number; failed: string[] }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const open = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(notInArray(orders.status, [...NON_RESERVING_STATUSES]))
    .orderBy(orders.placedAt, orders.id);
  let synced = 0;
  const failed: string[] = [];
  for (const o of open) {
    try {
      await ctx.db.transaction((tx) => syncOrderReservations(tx, o.id, ctx.actor));
      synced++;
    } catch (e) {
      failed.push(o.id);
      logger.warn("inventory.order_reservation_sync_failed", { orderId: o.id, error: e });
    }
  }
  return { synced, failed };
}

export interface InventoryOpeningStatus {
  warehouseId: string;
  initializedAt: Date | null;
  /** Варіанти, залишок яких Shopify відстежує. */
  trackedVariants: number;
  /** З них відкрито в обліку. */
  openedVariants: number;
  /** Відстежувані, але ще не відкриті (нові варіанти) — потрібен повторний initializeInventory. */
  unopenedTracked: number;
  /** Shopify не відстежує залишок — не резервуються. */
  untrackedVariants: number;
}

/** Стан відкриття обліку (для сторінки «Склад», Telegram, асистента). */
export async function getInventoryOpeningStatus(db: DbOrTx): Promise<InventoryOpeningStatus> {
  const warehouse = await getDefaultWarehouse(db);
  const [totals] = await db
    .select({
      tracked: sql<number>`count(*) filter (where ${productVariants.inventoryAvailable} is not null)`.mapWith(Number),
      untracked: sql<number>`count(*) filter (where ${productVariants.inventoryAvailable} is null)`.mapWith(Number),
    })
    .from(productVariants);
  const [opened] = await db
    .select({ c: count() })
    .from(inventoryBalances)
    .innerJoin(stockItems, eq(stockItems.id, inventoryBalances.stockItemId))
    .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .where(and(eq(inventoryBalances.warehouseId, warehouse.id), isNotNull(inventoryBalances.openedAt), isNotNull(productVariants.inventoryAvailable)));
  const [unopened] = await db
    .select({ c: count() })
    .from(productVariants)
    .leftJoin(stockItems, eq(stockItems.variantId, productVariants.id))
    .leftJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id)))
    .where(and(isNotNull(productVariants.inventoryAvailable), isNull(inventoryBalances.openedAt)));
  return {
    warehouseId: warehouse.id,
    initializedAt: warehouse.inventoryInitializedAt,
    trackedVariants: totals?.tracked ?? 0,
    openedVariants: Number(opened?.c ?? 0),
    unopenedTracked: Number(unopened?.c ?? 0),
    untrackedVariants: totals?.untracked ?? 0,
  };
}

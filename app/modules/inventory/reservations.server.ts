/**
 * Резервування й списання товарів під замовлення (docs/stage5-design.md §2).
 *
 * syncOrderReservations обчислює БАЖАНИЙ стан із замовлення й застосовує лише різницю:
 * - оплачене, не скасоване, не передане → зарезервовано effectiveLineQuantity (Shopify currentQuantity) кожної
 *   позиції з ВІДКРИТИМ товаром (inventory_balances.opened_at, див. opening.server.ts);
 * - передано перевізнику (SHIPPED_STATUSES) → списано один раз (consume_sale: on_hand −q, reserved −резерв);
 * - скасовано до передачі → резерв знято; позиція видалена/без варіанта → резерв знято.
 * Ключі: reserve:/release:<lineItemId>:<seq> (seq — версія резерву позиції), consume:<lineItemId> (раз на позицію),
 * opening_line:<lineItemId> (корекція знімка, раз на позицію).
 *
 * Чому не буває подвійного резерву/списання: (1) рядок замовлення блокується FOR NO KEY UPDATE — синхронізації
 * одного замовлення йдуть по черзі; (2) кожна зміна — рух з унікальним ключем; (3) стан позиції
 * (stock_reservations) оновлюється в тій самій транзакції, що й рух; (4) склад блокується FOR SHARE —
 * ініціалізація (FOR NO KEY UPDATE) і резерви не перетинаються.
 *
 * Перша поява позиції (немає рядка резерву) порівнюється з часом знімка Shopify, з якого відкрито товар
 * (inventory_balances.opening_snapshot_at), — lineInSnapshot: замовлення (orders.placed_at) І сама позиція
 * (order_line_items.shopify_added_at — LineItem.createdAt або час оновлення, що її приніс) з'явилися ДО знімка:
 * - у знімку: Shopify уже вилучив її одиниці з «доступно» знімка. Відкрите → резерв + корекція on_hand +q
 *   (opening_line); передане → не списується (його вже немає в знімку — історичне);
 * - після знімка (нове замовлення АБО позиція, додана редагуванням уже після знімка — інакше on_hand завищувався б):
 *   звичайний продаж. Відкрите → резерв; передане (уперше побачене вже відправленим) → списання on_hand −q без резерву.
 * - у знімку, але замовлення вже виконане (частково) в Shopify поза застосунком (orders.fulfillment_status): одиниць
 *   немає ні у знімку, ні фізично (або розподіл часткового виконання невідомий) → позиція НЕ резервується й не
 *   коригується; «Відправлено поза застосунком» її теж не списує (історичне). Так само робить initializeInventory.
 *   Часткове виконання ЛИШЕ позицій без доставки (orders.shopify_shippable_fulfilled = false: подарункова картка,
 *   цифровий товар) — не «виконано»: фізичні позиції ще committed у Shopify й на складі, тож резервуються
 *   (isOrderFulfilledInShopify, як у звірці складу й «Відправлено поза застосунком»).
 *   Обмеження (документовано): для частково виконаного до знімка замовлення невиконані одиниці теж не рахуються в
 *   on_hand (доступно — точне, on_hand занижено на них до відправлення).
 * Невідкритий товар (Shopify не відстежує залишок або ще не ініціалізовано) не резервується й не списується —
 * без хибних попереджень «продано більше, ніж є». До initializeInventory резерви не ведуться (not_initialized).
 * Нестача товару ніколи не блокує замовлення: резерв понад наявність → попередження oversold.
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { inventoryBalances, orderLineItems, orders, stockItems, stockReservations, type ReservationStatus } from "~/db/schema";
import { isOrderFulfilledInShopify, isShipped, type OrderStatus } from "~/domain/order-status";
import { NotFoundError } from "~/lib/errors";
import { inventoryKeys } from "./keys";
import { applyMovements, type MovementActor, type MovementInput } from "./ledger.server";
import { effectiveLineQuantity } from "./quantities";
import { getDefaultWarehouse, lockWarehouseForTracking } from "./warehouse.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";

/** SQL-аналог effectiveLineQuantity (для сум у запитах: початковий залишок, аналітика продажів). */
export const effectiveLineQuantitySql = sql<number>`greatest(coalesce(${orderLineItems.currentQuantity}, ${orderLineItems.quantity}), 0)`;

export type ReservationMode = "reserve" | "consume" | "none";

/** Бажаний режим резерву за статусом замовлення. */
export function reservationModeFor(status: OrderStatus): ReservationMode {
  if (status === "cancelled") return "none";
  if (isShipped(status)) return "consume";
  return "reserve";
}

export function reservationStatusOf(reservedQty: number, consumedQty: number): ReservationStatus {
  if (reservedQty > 0 && consumedQty > 0) return "partial";
  if (consumedQty > 0) return "consumed";
  if (reservedQty > 0) return "reserved";
  return "released";
}

export interface PlanLine {
  lineItemId: string;
  /** null — позиція без варіанта або товар не відкрито (не резервується; наявний резерв знімається). */
  stockItemId: string | null;
  /** Кількість до відправлення (effectiveLineQuantity). */
  quantity: number;
  /**
   * Замовлення створене ДО знімка Shopify, з якого відкрито товар (orders.placed_at < opening_snapshot_at).
   * Діє лише для позиції без рядка резерву: відкрите → корекція on_hand +q; передане → не списується.
   * initializeInventory передає false: корекцію вже включено в рух opening.
   */
  inSnapshot: boolean;
}

export interface PlanReservation {
  id: string;
  lineItemId: string;
  stockItemId: string;
  warehouseId: string;
  reservedQty: number;
  consumedQty: number;
  status: ReservationStatus;
  seq: number;
}

export interface PlannedRow {
  /** null — новий рядок резерву. */
  id: string | null;
  lineItemId: string;
  stockItemId: string;
  warehouseId: string;
  reservedQty: number;
  consumedQty: number;
  status: ReservationStatus;
  seq: number;
}

export interface ReservationPlan {
  movements: Array<Omit<MovementInput, "orderId">>;
  /** Рядки резервів, що змінилися (або нові). */
  rows: PlannedRow[];
}

/** Чиста функція: зміни резервів і рухи, що переводять поточний стан у бажаний (правила — вгорі файлу). */
export function planReservationChanges(input: {
  mode: ReservationMode;
  warehouseId: string;
  lines: readonly PlanLine[];
  reservations: readonly PlanReservation[];
}): ReservationPlan {
  const { mode, warehouseId } = input;
  const plan: ReservationPlan = { movements: [], rows: [] };
  const byLine = new Map(input.reservations.map((r) => [r.lineItemId, r]));
  const handled = new Set<string>();

  const release = (r: PlannedRow, qty: number, reason: string) => {
    r.seq += 1;
    plan.movements.push({
      warehouseId: r.warehouseId,
      stockItemId: r.stockItemId,
      type: "release",
      idempotencyKey: inventoryKeys.release(r.lineItemId, r.seq),
      reservedDelta: -qty,
      orderLineItemId: r.lineItemId,
      reason,
    });
    r.reservedQty -= qty;
  };

  for (const line of input.lines) {
    if (!line.stockItemId) continue; // без варіанта / не відкрито — не резервується (наявний резерв знімається нижче)
    handled.add(line.lineItemId);
    const q = Math.max(0, Math.trunc(line.quantity));
    const existing = byLine.get(line.lineItemId);
    const r: PlannedRow = existing
      ? { ...existing }
      : { id: null, lineItemId: line.lineItemId, stockItemId: line.stockItemId, warehouseId, reservedQty: 0, consumedQty: 0, status: "released", seq: 0 };
    const before = JSON.stringify(r);
    let consumedNow = false;

    if (r.consumedQty > 0 || r.status === "consumed") {
      // Списано один раз назавжди (повернення — етап 6).
      continue;
    }
    if (mode === "none") {
      if (!existing) continue;
      if (r.reservedQty > 0) release(r, r.reservedQty, "order_cancelled");
    } else if (mode === "consume") {
      // Уперше побачене вже переданим і створене до знімка — історичне: одиниць немає в знімку, не списується.
      if (!existing && (line.inSnapshot || q === 0)) continue;
      if (q === 0) {
        // Усі одиниці видалено/повернено до передачі — списувати нічого, резерв знімається.
        if (r.reservedQty > 0) release(r, r.reservedQty, "quantity_changed");
      } else {
        if (r.stockItemId !== line.stockItemId && r.reservedQty > 0) release(r, r.reservedQty, "variant_changed");
        const sameItem = r.stockItemId === line.stockItemId;
        plan.movements.push({
          warehouseId: r.warehouseId,
          stockItemId: line.stockItemId,
          type: "consume_sale",
          idempotencyKey: inventoryKeys.consume(line.lineItemId),
          onHandDelta: -q,
          reservedDelta: sameItem && r.reservedQty > 0 ? -r.reservedQty : 0,
          orderLineItemId: line.lineItemId,
          reason: existing ? "handed_over" : "handed_over_unreserved",
        });
        r.stockItemId = line.stockItemId;
        r.reservedQty = 0;
        r.consumedQty = q;
        consumedNow = true;
      }
    } else {
      if (!existing && q === 0) continue;
      if (existing && r.stockItemId !== line.stockItemId) {
        if (r.reservedQty > 0) release(r, r.reservedQty, "variant_changed");
        r.stockItemId = line.stockItemId;
        r.warehouseId = warehouseId;
      }
      if (!existing && line.inSnapshot) {
        // Shopify закріпив ці одиниці до знімка → їх немає в «доступно» знімка, але фізично вони на складі.
        plan.movements.push({
          warehouseId: r.warehouseId,
          stockItemId: r.stockItemId,
          type: "opening",
          idempotencyKey: inventoryKeys.openingLine(line.lineItemId),
          onHandDelta: q,
          orderLineItemId: line.lineItemId,
          reason: "snapshot_committed",
        });
      }
      if (q !== r.reservedQty) {
        const delta = q - r.reservedQty;
        r.seq += 1;
        plan.movements.push({
          warehouseId: r.warehouseId,
          stockItemId: r.stockItemId,
          type: delta > 0 ? "reserve" : "release",
          idempotencyKey: delta > 0 ? inventoryKeys.reserve(line.lineItemId, r.seq) : inventoryKeys.release(line.lineItemId, r.seq),
          reservedDelta: delta,
          orderLineItemId: line.lineItemId,
          reason: !existing ? "order_paid" : "quantity_changed",
        });
        r.reservedQty = q;
      }
    }
    r.status = consumedNow ? "consumed" : reservationStatusOf(r.reservedQty, r.consumedQty);
    if (JSON.stringify(r) !== before) plan.rows.push(r);
  }

  // Резерви позицій, яких більше немає (видалено в Shopify) або без варіанта — знімаються.
  for (const existing of input.reservations) {
    if (handled.has(existing.lineItemId)) continue;
    if (existing.consumedQty > 0 || existing.reservedQty === 0) continue;
    const r: PlannedRow = { ...existing };
    release(r, r.reservedQty, "line_removed");
    r.status = reservationStatusOf(r.reservedQty, r.consumedQty);
    plan.rows.push(r);
  }
  return plan;
}

export interface ReservationSyncResult {
  orderId: string;
  /** not_initialized — склад ще не ініціалізовано (резерви не ведуться). */
  state: "synced" | "not_initialized";
  mode: ReservationMode;
  applied: number;
  /** Рухи-повтори (уже записані раніше) — баланс не змінювався. */
  skipped: number;
}

export interface OpenedVariant {
  stockItemId: string;
  /** Час знімка Shopify, з якого відкрито товар. */
  snapshotAt: Date;
}

/** Відкриті товари складу за варіантами (variantId → позиція й час знімка). Без блокування. */
export async function loadOpenedVariants(db: DbOrTx, warehouseId: string, variantIds: readonly string[]): Promise<Map<string, OpenedVariant>> {
  const ids = [...new Set(variantIds)];
  const out = new Map<string, OpenedVariant>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await db
      .select({ variantId: stockItems.variantId, stockItemId: stockItems.id, snapshotAt: inventoryBalances.openingSnapshotAt })
      .from(stockItems)
      .innerJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouseId)))
      .where(and(inArray(stockItems.variantId, ids.slice(i, i + 500)), isNotNull(inventoryBalances.openedAt)));
    for (const r of rows) if (r.variantId && r.snapshotAt) out.set(r.variantId, { stockItemId: r.stockItemId, snapshotAt: r.snapshotAt });
  }
  return out;
}

/** Рядки stock_reservations → вхід планувальника. */
export function toPlanReservation(r: typeof stockReservations.$inferSelect): PlanReservation {
  return {
    id: r.id,
    lineItemId: r.orderLineItemId,
    stockItemId: r.stockItemId,
    warehouseId: r.warehouseId,
    reservedQty: r.reservedQty,
    consumedQty: r.consumedQty,
    status: r.status,
    seq: r.seq,
  };
}

/** Записує змінені/нові рядки резервів плану (у транзакції, де застосовано рухи плану). */
export async function writePlannedRows(tx: Tx, orderId: string, rows: readonly PlannedRow[], now = new Date()): Promise<void> {
  for (const row of rows) {
    const values = {
      stockItemId: row.stockItemId,
      warehouseId: row.warehouseId,
      reservedQty: row.reservedQty,
      consumedQty: row.consumedQty,
      status: row.status,
      seq: row.seq,
      updatedAt: now,
    };
    if (row.id) await tx.update(stockReservations).set(values).where(eq(stockReservations.id, row.id));
    else await tx.insert(stockReservations).values({ ...values, orderId, orderLineItemId: row.lineItemId });
  }
}

/**
 * Приводить резерви замовлення до бажаного стану. Викликати в ТІЙ САМІЙ транзакції, що й зміну замовлення
 * (синхронізація Shopify, скасування, передача перевізнику), ДО інших applyMovements цієї транзакції (порядок
 * блокувань: замовлення → склад → баланси). Ідемпотентна: повторний виклик без змін замовлення нічого не робить.
 * Не кидає помилок через нестачу товару (oversold → попередження).
 */
/**
 * Чи входить позиція в знімок Shopify, з якого відкрито товар: і замовлення, і сама позиція з'явилися до знімка.
 * shopifyAddedAt = null (демо, позиції до етапу 5) — лише за часом замовлення.
 */
export function lineInSnapshot(placedAt: Date, shopifyAddedAt: Date | null, snapshotAt: Date): boolean {
  return placedAt < snapshotAt && (shopifyAddedAt === null || shopifyAddedAt < snapshotAt);
}

export async function syncOrderReservations(tx: Tx, orderId: string, actor: MovementActor): Promise<ReservationSyncResult> {
  const result = await syncOrderReservationsInner(tx, orderId, actor);
  // Етап 6 (точка підключення, docs/stage6-design.md §17.7): фінанси замовлення — на кожному шляху (накладна, передача,
  // відстеження, «відправлено поза застосунком», синхронізація Shopify, відкриття обліку, демо), у тій самій транзакції,
  // після складу (порядок блокувань F10). Внутрішня функція: без перевірки актора, нічого не повертає.
  await syncOrderFinance(tx, actor, orderId);
  return result;
}

async function syncOrderReservationsInner(tx: Tx, orderId: string, actor: MovementActor): Promise<ReservationSyncResult> {
  const [order] = await tx
    .select({
      id: orders.id,
      status: orders.status,
      placedAt: orders.placedAt,
      fulfillmentStatus: orders.fulfillmentStatus,
      shopifyShippableFulfilled: orders.shopifyShippableFulfilled,
    })
    .from(orders)
    .where(eq(orders.id, orderId))
    .for("no key update");
  if (!order) throw new NotFoundError("order");
  const mode = reservationModeFor(order.status);
  const warehouse = await getDefaultWarehouse(tx);
  const initializedAt = await lockWarehouseForTracking(tx, warehouse.id);
  if (!initializedAt) return { orderId, state: "not_initialized", mode, applied: 0, skipped: 0 };

  const reservations = await tx.select().from(stockReservations).where(eq(stockReservations.orderId, orderId)).for("update");
  // Скасоване замовлення без резервів — нічого створювати не потрібно.
  if (mode === "none" && reservations.length === 0) return { orderId, state: "synced", mode, applied: 0, skipped: 0 };

  const lines = await tx
    .select({
      id: orderLineItems.id,
      variantId: orderLineItems.variantId,
      quantity: orderLineItems.quantity,
      currentQuantity: orderLineItems.currentQuantity,
      shopifyAddedAt: orderLineItems.shopifyAddedAt,
    })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, orderId));
  const reservedLines = new Set(reservations.map((r) => r.orderLineItemId));
  // Виконане в Shopify поза застосунком (застосунок ще не відправив): позиції зі знімка, які ще не резервувалися, —
  // історичні (див. вгорі файлу). Часткове виконання лише позицій без доставки (shopify_shippable_fulfilled = false)
  // фізичних позицій не торкається — вони резервуються (те саме правило, що у відкритті обліку, opening.server.ts).
  const fulfilledOutside = mode !== "none" && !isShipped(order.status) && isOrderFulfilledInShopify(order);
  const opened = await loadOpenedVariants(
    tx,
    warehouse.id,
    lines.map((l) => l.variantId).filter((v): v is string => Boolean(v)),
  );
  const plan = planReservationChanges({
    mode,
    warehouseId: warehouse.id,
    lines: lines.map((l) => {
      const o = l.variantId ? opened.get(l.variantId) : undefined;
      const inSnapshot = o ? lineInSnapshot(order.placedAt, l.shopifyAddedAt, o.snapshotAt) : false;
      // Без рядка резерву й «у знімку» на виконаному в Shopify замовленні — не резервується (stockItemId: null).
      const historical = fulfilledOutside && inSnapshot && !reservedLines.has(l.id);
      return {
        lineItemId: l.id,
        stockItemId: historical ? null : (o?.stockItemId ?? null),
        quantity: effectiveLineQuantity(l),
        inSnapshot,
      };
    }),
    reservations: reservations.map(toPlanReservation),
  });
  if (plan.movements.length === 0 && plan.rows.length === 0) return { orderId, state: "synced", mode, applied: 0, skipped: 0 };

  const result = await applyMovements(
    tx,
    actor,
    plan.movements.map((m) => ({ ...m, orderId })),
  );
  await writePlannedRows(tx, orderId, plan.rows);
  return { orderId, state: "synced", mode, applied: result.applied.length, skipped: result.skipped.length };
}

/** Резерви одного замовлення (для картки замовлення, пакування, Telegram). */
export async function loadOrderReservations(db: DbOrTx, orderId: string): Promise<Array<typeof stockReservations.$inferSelect>> {
  return db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
}

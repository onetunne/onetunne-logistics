/**
 * Резервування й списання товарів під замовлення (docs/stage5-design.md §2).
 *
 * syncOrderReservations обчислює БАЖАНИЙ стан із замовлення й застосовує лише різницю:
 * - оплачене, не скасоване, не передане перевізнику → зарезервовано `quantity` кожної позиції з варіантом;
 * - передано перевізнику (SHIPPED_STATUSES) → списано один раз (consume_sale: on_hand −q, reserved −резерв);
 * - скасовано до передачі → резерв знято; позиція видалена/без варіанта → резерв знято.
 * Ключі: reserve:/release:<lineItemId>:<seq> (seq — версія резерву позиції), consume:<lineItemId> (раз на позицію).
 *
 * Чому не буває подвійного резерву/списання: (1) рядок замовлення блокується FOR UPDATE — синхронізації одного
 * замовлення йдуть по черзі; (2) кожна зміна — рух з унікальним ключем; (3) стан позиції (stock_reservations)
 * оновлюється в тій самій транзакції, що й рух.
 *
 * «Невідстежувані» позиції: замовлення, передане перевізнику без резерву (історичний імпорт, відправлене до
 * ініціалізації складу), НЕ списується — його вже враховано в знімку Shopify (opening.server.ts).
 * До initializeInventory резерви не ведуться (state = "not_initialized").
 * Нестача товару ніколи не блокує замовлення: резерв понад наявність → попередження oversold.
 */
import { eq } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { orderLineItems, orders, stockReservations, type ReservationStatus } from "~/db/schema";
import { isShipped, type OrderStatus } from "~/domain/order-status";
import { NotFoundError } from "~/lib/errors";
import { inventoryKeys } from "./keys";
import { applyMovements, ensureStockItemsForVariants, type MovementActor, type MovementInput } from "./ledger.server";
import { getDefaultWarehouse, lockWarehouseForTracking } from "./warehouse.server";

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
  /** null — позиція без варіанта (не резервується). */
  stockItemId: string | null;
  quantity: number;
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

/**
 * Чиста функція: зміни резервів і рухи, що переводять поточний стан у бажаний.
 * `consumeUntracked` не підтримується навмисно: передане замовлення без резерву не списується.
 */
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
    if (!line.stockItemId) continue; // без варіанта — не резервується (наявний резерв знімається як «сирота» нижче)
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
      if (!existing) continue; // невідстежувана позиція (історична / до ініціалізації складу)
      if (r.stockItemId !== line.stockItemId && r.reservedQty > 0) release(r, r.reservedQty, "variant_changed");
      const sameItem = r.stockItemId === line.stockItemId;
      plan.movements.push({
        warehouseId: r.warehouseId,
        stockItemId: line.stockItemId,
        type: "consume_sale",
        idempotencyKey: inventoryKeys.consume(line.lineItemId),
        onHandDelta: -q,
        reservedDelta: sameItem ? -r.reservedQty : 0,
        orderLineItemId: line.lineItemId,
        reason: "handed_over",
      });
      r.stockItemId = line.stockItemId;
      r.reservedQty = 0;
      r.consumedQty = q;
      consumedNow = true;
    } else {
      if (existing && r.stockItemId !== line.stockItemId) {
        if (r.reservedQty > 0) release(r, r.reservedQty, "variant_changed");
        r.stockItemId = line.stockItemId;
        r.warehouseId = warehouseId;
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
      if (!existing && q === 0) continue;
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

/**
 * Приводить резерви замовлення до бажаного стану. Викликати в ТІЙ САМІЙ транзакції, що й зміну замовлення
 * (синхронізація Shopify, скасування, передача перевізнику). Ідемпотентна: повторний виклик без змін
 * замовлення нічого не робить. Не кидає помилок через нестачу товару (oversold → попередження).
 */
export async function syncOrderReservations(tx: Tx, orderId: string, actor: MovementActor): Promise<ReservationSyncResult> {
  const [order] = await tx.select({ id: orders.id, status: orders.status }).from(orders).where(eq(orders.id, orderId)).for("update");
  if (!order) throw new NotFoundError("order");
  const mode = reservationModeFor(order.status);
  const warehouse = await getDefaultWarehouse(tx);
  const initializedAt = await lockWarehouseForTracking(tx, warehouse.id);
  if (!initializedAt) return { orderId, state: "not_initialized", mode, applied: 0, skipped: 0 };

  const lines = await tx
    .select({ id: orderLineItems.id, variantId: orderLineItems.variantId, quantity: orderLineItems.quantity })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, orderId));
  const reservations = await tx.select().from(stockReservations).where(eq(stockReservations.orderId, orderId)).for("update");
  // Скасоване замовлення без резервів — нічого створювати не потрібно.
  if (mode === "none" && reservations.length === 0) return { orderId, state: "synced", mode, applied: 0, skipped: 0 };
  // Передане без резервів — невідстежуване (історичне); позиції обліку не створюємо.
  if (mode === "consume" && reservations.length === 0) return { orderId, state: "synced", mode, applied: 0, skipped: 0 };

  const stockByVariant = await ensureStockItemsForVariants(
    tx,
    lines.map((l) => l.variantId).filter((v): v is string => Boolean(v)),
  );
  const plan = planReservationChanges({
    mode,
    warehouseId: warehouse.id,
    lines: lines.map((l) => ({
      lineItemId: l.id,
      stockItemId: l.variantId ? (stockByVariant.get(l.variantId) ?? null) : null,
      quantity: l.quantity,
    })),
    reservations: reservations.map((r) => ({
      id: r.id,
      lineItemId: r.orderLineItemId,
      stockItemId: r.stockItemId,
      warehouseId: r.warehouseId,
      reservedQty: r.reservedQty,
      consumedQty: r.consumedQty,
      status: r.status,
      seq: r.seq,
    })),
  });
  if (plan.movements.length === 0 && plan.rows.length === 0) return { orderId, state: "synced", mode, applied: 0, skipped: 0 };

  const result = await applyMovements(
    tx,
    actor,
    plan.movements.map((m) => ({ ...m, orderId })),
  );
  const now = new Date();
  for (const row of plan.rows) {
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
  return { orderId, state: "synced", mode, applied: result.applied.length, skipped: result.skipped.length };
}

/** Резерви одного замовлення (для картки замовлення, пакування, Telegram). */
export async function loadOrderReservations(db: DbOrTx, orderId: string): Promise<Array<typeof stockReservations.$inferSelect>> {
  return db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
}

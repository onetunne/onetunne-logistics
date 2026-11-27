/**
 * Повернення покупця й залишок Shopify (docs/stage5-design.md §10) — для звірки.
 *
 * Повернення змінює залишок двічі: Shopify поповнює «доступно», коли повернення/відшкодування оформлено з поверненням
 * на склад (restock), а склад оприбутковує посилку (receipt_manual, причина customer_return; за замовчуванням НЕ
 * надсилається в Shopify — skipped, бо Shopify поповнює сам). Ці дві події приходять у будь-якому порядку, тож до
 * другої з них різниця з Shopify пояснюється поверненням і автоприйняття її подвоїло б або скасувало б:
 * - pending — Shopify міг уже поповнити (поточна кількість позиції замовлення зменшилася після списання), а склад ще не
 *   оприбуткував стільки одиниць (on_hand надходжень повернення). Повернення, яке Shopify поповнив, записується з УСІМА
 *   одиницями в on_hand, а пошкоджені окремим рухом браку (manual:<uuid>:return_defect) переходять у брак — його −дельту
 *   надіслано в Shopify (warehouse/operations.server.ts). Надходження «надіслати в Shopify», «пошкоджені в Shopify не
 *   поповнювали» і записані до цієї зміни тримають пошкоджені одразу в браку — тут вони не рахуються (Shopify їх не
 *   поповнював або вже враховано); returnOrderSuggestions (для підказки у формі) рахує on_hand + defective;
 * - awaiting — склад оприбуткував повернення (не надіслане), а відшкодування з поверненням у Shopify ще немає: Shopify
 *   додасть ці одиниці сам («Надіслати склад» їх не надсилає — pure.ts pushPlan).
 *
 * Для кожного замовлення net = повернено (у Shopify) − оприбутковано (на складі). Повернення без замовлення — спільний
 * пул (форма не вимагає замовлення). Обидва рахуються ВІД ОСТАННЬОГО УЗГОДЖЕННЯ (unsent.server.ts): точка узгодження
 * зберігає net кожного замовлення й суму повернень без замовлення на той момент, тож уже узгоджене (напр. повернення без
 * замовлення, яке Shopify поповнили вручну, або відшкодування без повернення на склад) більше не впливає на нові
 * повернення. Замовлення — лише змінені в Shopify за RETURN_PENDING_WINDOW_MS або з поверненням, оприбуткованим за цей
 * час; повернення без замовлення — лише оприбутковані за цей час (межа для запитів і для невизначеності).
 *
 * Неоднозначність, яку не усуває жоден підрахунок: повернення без замовлення може стосуватися будь-якого відшкодування
 * (або ручного поповнення в Shopify). Тому склад має вказувати замовлення в поверненні, коли воно відоме.
 */
import { and, eq, gt, inArray, isNotNull, or, sql, type AnyColumn } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryMovements, orderLineItems, orders, stockItems, stockReservations } from "~/db/schema";
import { SHIPPED_STATUSES } from "~/domain/order-status";
import { SHOPIFY_RESTOCK_REASONS } from "~/modules/warehouse/constants";

/** Повернення враховуються не довше за це вікно від зміни замовлення в Shopify / оприбуткування повернення. */
export const RETURN_PENDING_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;

export interface OrderReturns {
  /** Списані (передані) одиниці позиції, яких більше немає в поточній кількості (повернено/відшкодовано в Shopify). */
  returned: number;
  /** Оприбутковані складом придатні одиниці повернень цього замовлення (on_hand). */
  received: number;
  /** З них не надіслані в Shopify (skipped — Shopify поповнює сам). */
  receivedSkipped: number;
}

export interface ReturnsState {
  orders: Map<string, OrderReturns>;
  /** Повернення без замовлення (on_hand): усі за весь час — монотонна сума для точки узгодження. */
  unlinkedTotal: number;
  /** Повернення без замовлення, оприбутковані у вікні (усі / не надіслані в Shopify). */
  unlinkedWindow: number;
  unlinkedWindowSkipped: number;
}

/** Стан повернень на момент узгодження (зберігається в точці узгодження). */
export interface ReturnsSnapshot {
  /** net (returned − received) замовлень вікна, лише ненульові. */
  net: Record<string, number>;
  /** unlinkedTotal. */
  unlinked: number;
}

export const EMPTY_RETURNS_SNAPSHOT: ReturnsSnapshot = { net: {}, unlinked: 0 };

export const emptyReturnsState = (): ReturnsState => ({ orders: new Map(), unlinkedTotal: 0, unlinkedWindow: 0, unlinkedWindowSkipped: 0 });

export interface ReturnsTiming {
  /** Shopify міг поповнити, склад ще не оприбуткував (від узгодження). */
  pending: number;
  /** Склад оприбуткував, Shopify ще має поповнити сам (від узгодження). */
  awaiting: number;
}

/** Поточні pending/awaiting відносно точки узгодження (чиста функція). */
export function returnsTimingFrom(state: ReturnsState, snapshot: ReturnsSnapshot): ReturnsTiming {
  let pendingLinked = 0;
  let awaitingLinked = 0;
  for (const [orderId, o] of state.orders) {
    const net = o.returned - o.received;
    const agreed = snapshot.net[orderId] ?? 0;
    // Нові повернення в Shopify, не покриті новими оприбуткуваннями (від узгодження).
    pendingLinked += Math.max(0, net - agreed);
    // Оприбутковано більше, ніж повернено в Shopify, — лише не надіслані й лише нові від узгодження.
    awaitingLinked += Math.min(o.receivedSkipped, Math.max(0, o.received - o.returned), Math.max(0, agreed - net));
  }
  const pool = Math.min(Math.max(0, state.unlinkedTotal - snapshot.unlinked), state.unlinkedWindow);
  return {
    pending: Math.max(0, pendingLinked - pool),
    awaiting: awaitingLinked + Math.min(Math.max(0, pool - pendingLinked), state.unlinkedWindowSkipped),
  };
}

export function returnsSnapshotOf(state: ReturnsState): ReturnsSnapshot {
  const net: Record<string, number> = {};
  for (const [orderId, o] of [...state.orders].sort(([a], [b]) => a.localeCompare(b))) {
    const n = o.returned - o.received;
    if (n !== 0) net[orderId] = n;
  }
  return { net, unlinked: state.unlinkedTotal };
}

export function sameReturnsSnapshot(a: ReturnsSnapshot, b: ReturnsSnapshot): boolean {
  if (a.unlinked !== b.unlinked) return false;
  const ka = Object.keys(a.net);
  if (ka.length !== Object.keys(b.net).length) return false;
  return ka.every((k) => a.net[k] === b.net[k]);
}

/** Знімок із details точки узгодження (старі записи без нього — порожній). */
export function parseReturnsSnapshot(v: unknown): ReturnsSnapshot {
  if (!v || typeof v !== "object") return EMPTY_RETURNS_SNAPSHOT;
  const d = v as Record<string, unknown>;
  const unlinked = typeof d.unlinked === "number" && Number.isSafeInteger(d.unlinked) ? d.unlinked : 0;
  const net: Record<string, number> = {};
  if (d.net && typeof d.net === "object") {
    for (const [k, n] of Object.entries(d.net as Record<string, unknown>)) {
      if (typeof n === "number" && Number.isSafeInteger(n)) net[k] = n;
    }
  }
  return { net, unlinked };
}

/** Стан повернень позицій складу (запити; викликати під блокуванням балансу для узгодженості з рухами). */
export async function loadReturnsState(
  db: DbOrTx,
  warehouseId: string,
  stockItemIds: readonly string[],
  now: Date,
): Promise<Map<string, ReturnsState>> {
  const out = new Map<string, ReturnsState>();
  if (stockItemIds.length === 0) return out;
  const ids = [...new Set(stockItemIds)];
  const get = (id: string) => {
    let s = out.get(id);
    if (!s) out.set(id, (s = emptyReturnsState()));
    return s;
  };
  const order = (s: ReturnsState, orderId: string) => {
    let o = s.orders.get(orderId);
    if (!o) s.orders.set(orderId, (o = { returned: 0, received: 0, receivedSkipped: 0 }));
    return o;
  };
  const since = sql`${new Date(now.getTime() - RETURN_PENDING_WINDOW_MS).toISOString()}::timestamptz`;
  const isReturnReceipt = and(
    eq(inventoryMovements.warehouseId, warehouseId),
    eq(inventoryMovements.type, "receipt_manual"),
    inArray(inventoryMovements.reason, [...SHOPIFY_RESTOCK_REASONS]),
  );
  const orderInWindow = sql`coalesce(${orders.shopifyUpdatedAt}, ${orders.updatedAt}) >= ${since}`;
  const recentReceiptFor = (orderId: AnyColumn, stockItemId: AnyColumn) =>
    sql`exists (select 1 from ${inventoryMovements} where ${and(
      isReturnReceipt,
      sql`${inventoryMovements.orderId} = ${orderId}`,
      sql`${inventoryMovements.stockItemId} = ${stockItemId}`,
      sql`${inventoryMovements.createdAt} >= ${since}`,
    )})`;

  // Списані за резервом одиниці, яких більше немає в позиції (повернено/відшкодовано в Shopify).
  const lineQty = sql`greatest(coalesce(${orderLineItems.currentQuantity}, ${orderLineItems.quantity}, ${stockReservations.consumedQty}), 0)`;
  const reservedQty = sql<number>`coalesce(sum(greatest(${stockReservations.consumedQty} - ${lineQty}, 0)), 0)`;
  const reserved = await db
    .select({ stockItemId: stockReservations.stockItemId, orderId: stockReservations.orderId, qty: reservedQty.mapWith(Number) })
    .from(stockReservations)
    .innerJoin(orders, eq(orders.id, stockReservations.orderId))
    .leftJoin(orderLineItems, eq(orderLineItems.id, stockReservations.orderLineItemId))
    .where(
      and(
        eq(stockReservations.warehouseId, warehouseId),
        inArray(stockReservations.stockItemId, ids),
        gt(stockReservations.consumedQty, 0),
        or(orderInWindow, recentReceiptFor(stockReservations.orderId, stockReservations.stockItemId)),
      ),
    )
    .groupBy(stockReservations.stockItemId, stockReservations.orderId)
    .having(sql`${reservedQty} > 0`);
  for (const r of reserved) order(get(r.stockItemId), r.orderId).returned += r.qty;

  // Історичні позиції (уперше побачені вже переданими, без рядка резерву): повернено = кількість − поточна кількість.
  const historicalQty = sql<number>`coalesce(sum(greatest(${orderLineItems.quantity} - coalesce(${orderLineItems.currentQuantity}, ${orderLineItems.quantity}), 0)), 0)`;
  const historical = await db
    .select({ stockItemId: stockItems.id, orderId: orderLineItems.orderId, qty: historicalQty.mapWith(Number) })
    .from(orderLineItems)
    .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
    .innerJoin(stockItems, eq(stockItems.variantId, orderLineItems.variantId))
    .where(
      and(
        inArray(stockItems.id, ids),
        inArray(orders.status, [...SHIPPED_STATUSES]),
        isNotNull(orders.shopifyOrderId),
        sql`not exists (select 1 from ${stockReservations} where ${stockReservations.orderLineItemId} = ${orderLineItems.id})`,
        or(orderInWindow, recentReceiptFor(orderLineItems.orderId, stockItems.id)),
      ),
    )
    .groupBy(stockItems.id, orderLineItems.orderId)
    .having(sql`${historicalQty} > 0`);
  for (const r of historical) order(get(r.stockItemId), r.orderId).returned += r.qty;

  // Оприбутковані повернення: одиниці on_hand надходжень (для поповненого Shopify повернення — усі, разом із
  // пошкодженими, які окремий рух браку зняв у Shopify); пошкоджені, записані одразу в брак, Shopify не поповнював.
  const inWindow = sql`${inventoryMovements.createdAt} >= ${since}`;
  const skipped = sql`${inventoryMovements.shopifySyncState} = 'skipped'`;
  const receipts = await db
    .select({
      stockItemId: inventoryMovements.stockItemId,
      orderId: inventoryMovements.orderId,
      all: sql<number>`coalesce(sum(${inventoryMovements.onHandDelta}), 0)`.mapWith(Number),
      skipped: sql<number>`coalesce(sum(case when ${skipped} then ${inventoryMovements.onHandDelta} else 0 end), 0)`.mapWith(Number),
      window: sql<number>`coalesce(sum(case when ${inWindow} then ${inventoryMovements.onHandDelta} else 0 end), 0)`.mapWith(Number),
      windowSkipped: sql<number>`coalesce(sum(case when ${inWindow} and ${skipped} then ${inventoryMovements.onHandDelta} else 0 end), 0)`.mapWith(
        Number,
      ),
    })
    .from(inventoryMovements)
    .where(and(isReturnReceipt, inArray(inventoryMovements.stockItemId, ids)))
    .groupBy(inventoryMovements.stockItemId, inventoryMovements.orderId);
  for (const r of receipts) {
    const s = get(r.stockItemId);
    if (!r.orderId) {
      s.unlinkedTotal += r.all;
      s.unlinkedWindow += r.window;
      s.unlinkedWindowSkipped += r.windowSkipped;
      continue;
    }
    // Замовлення поза вікном (давні повернення без нових змін) не враховуються.
    const known = s.orders.get(r.orderId);
    if (!known && r.window <= 0) continue;
    const o = known ?? order(s, r.orderId);
    o.received += r.all;
    o.receivedSkipped += r.skipped;
  }
  return out;
}

export interface ReturnOrderSuggestion {
  orderId: string;
  orderNumber: string;
  /** Повернено/відшкодовано в Shopify, але ще не оприбутковано складом як повернення цього замовлення (одиниць). */
  units: number;
}

/** Найбільше підказок у формі повернення. */
export const RETURN_SUGGESTIONS_LIMIT = 10;

/**
 * Підказки номера замовлення у формі повернення покупця (лише читання, без звернень до Shopify): замовлення, у яких
 * позицію цього товару нещодавно повернули/відшкодували в Shopify (поточна кількість менша за списану —
 * loadReturnsState, те саме вікно RETURN_PENDING_WINDOW_MS), а склад ще не отримав стільки одиниць повернень із цим
 * замовленням (returned − отримано > 0). Отримано — УСІ фізично отримані одиниці (on_hand + defective надходжень
 * повернення): на відміну від обліку для звірки (лише on_hand), пошкоджені одиниці, записані одразу в брак («надіслати
 * в Shopify», «пошкоджені в Shopify не повертали», записи до розділення — operations.server.ts), теж отримані —
 * інакше замовлення лишалося б у підказках після отримання всього повернення. Повернення без замовлення не
 * віднімаються: невідомо, якого замовлення вони стосуються, — саме тому склад обирає замовлення. Лише номер замовлення
 * (без даних покупця); найновіші зміни першими.
 */
export async function returnOrderSuggestions(
  db: DbOrTx,
  warehouseId: string,
  stockItemId: string,
  now: Date = new Date(),
  limit: number = RETURN_SUGGESTIONS_LIMIT,
): Promise<ReturnOrderSuggestion[]> {
  const state = (await loadReturnsState(db, warehouseId, [stockItemId], now)).get(stockItemId);
  if (!state) return [];
  const candidates = [...state.orders].filter(([, o]) => o.returned - o.received > 0);
  if (candidates.length === 0) return [];
  // Пошкоджені одиниці тих самих надходжень повернення (defective), які облік для звірки не рахує.
  const damagedRows = await db
    .select({
      orderId: inventoryMovements.orderId,
      damaged: sql<number>`coalesce(sum(${inventoryMovements.defectiveDelta}), 0)`.mapWith(Number),
    })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.warehouseId, warehouseId),
        eq(inventoryMovements.stockItemId, stockItemId),
        eq(inventoryMovements.type, "receipt_manual"),
        inArray(inventoryMovements.reason, [...SHOPIFY_RESTOCK_REASONS]),
        inArray(
          inventoryMovements.orderId,
          candidates.map(([orderId]) => orderId),
        ),
      ),
    )
    .groupBy(inventoryMovements.orderId);
  const damaged = new Map(damagedRows.map((r) => [r.orderId, r.damaged]));
  const open = new Map<string, number>();
  for (const [orderId, o] of candidates) {
    const units = o.returned - o.received - Math.max(0, damaged.get(orderId) ?? 0);
    if (units > 0) open.set(orderId, units);
  }
  if (open.size === 0) return [];
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      changedAt: sql<string>`coalesce(${orders.shopifyUpdatedAt}, ${orders.updatedAt})`,
    })
    .from(orders)
    .where(inArray(orders.id, [...open.keys()]));
  return rows
    .map((r) => ({ orderId: r.id, orderNumber: r.orderNumber, units: open.get(r.id) ?? 0, at: new Date(r.changedAt).getTime() }))
    .sort((a, b) => b.at - a.at || a.orderNumber.localeCompare(b.orderNumber))
    .slice(0, Math.max(0, limit))
    .map(({ orderId, orderNumber, units }) => ({ orderId, orderNumber, units }));
}

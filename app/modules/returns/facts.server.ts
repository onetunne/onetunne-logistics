/**
 * Етап 6, WP9: джерела випадків повернень із наявних таблиць (без грошей): повернення коштів Shopify (WP3 —
 * `order_refunds` / `order_refund_lines`), надходження повернень на склад (етап 5 — `receipt_manual` з причиною
 * `customer_return` і `order_id`, разом із парним рухом браку `<ключ>:return_defect`), факти відвантаження замовлення.
 * Читає й внутрішня синхронізація (sync.server.ts), і сервіси сторінок — тому без перевірки актора й без сум.
 */
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryMovements, orderFinance, orderLineItems, orderRefundLines, orderRefunds, orders, shipments, stockItems } from "~/db/schema";
import { isOrderFulfilledInShopify, isShipped, type OrderStatus } from "~/domain/order-status";
import type { ReceiptSource, RefundSource, ShippingFacts } from "./rules";

/** Причина надходження «повернення покупця» (warehouse/constants.ts RECEIPT_REASONS). */
export const CUSTOMER_RETURN_REASON = "customer_return";
/** Суфікс ключа парного руху браку надходження-повернення (warehouse/operations.server.ts). */
export const RETURN_DEFECT_SUFFIX = ":return_defect";

export interface OrderShipping extends ShippingFacts {
  /** Найраніша дата вручення (для «днів доставка → повернення»); null — невідомо. */
  deliveredAt: Date | null;
}

const minDate = (...values: Array<Date | null | undefined>): Date | null =>
  values.filter((v): v is Date => v instanceof Date).reduce<Date | null>((m, v) => (m === null || v.getTime() < m.getTime() ? v : m), null);

/** Факти відвантаження замовлень: перша передача (накладна / списання consume_sale / визнання), вручення. */
export async function loadShippingFacts(db: DbOrTx, orderIds: readonly string[]): Promise<Map<string, OrderShipping>> {
  const all = [...new Set(orderIds)];
  const out = new Map<string, OrderShipping>();
  for (let i = 0; i < all.length; i += 1000) await loadShippingChunk(db, all.slice(i, i + 1000), out);
  return out;
}

async function loadShippingChunk(db: DbOrTx, ids: string[], out: Map<string, OrderShipping>): Promise<void> {
  // Послідовно: db може бути транзакцією (одне з'єднання — паралельні запити pg лише ставить у чергу).
  const orderRows = await db
    .select({
      id: orders.id,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      shopifyShippableFulfilled: orders.shopifyShippableFulfilled,
    })
    .from(orders)
    .where(inArray(orders.id, ids));
  const shipRows = await db
    .select({
      orderId: shipments.orderId,
      handedOverAt: sql<Date | null>`min(${shipments.handedOverAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
      deliveredAt: sql<Date | null>`min(${shipments.deliveredAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
    })
    .from(shipments)
    .where(inArray(shipments.orderId, ids))
    .groupBy(shipments.orderId);
  const consumeRows = await db
    .select({
      orderId: inventoryMovements.orderId,
      at: sql<Date | null>`min(${inventoryMovements.createdAt})`.mapWith((v) => (v ? new Date(v as string) : null)),
    })
    .from(inventoryMovements)
    .where(and(inArray(inventoryMovements.orderId, ids), eq(inventoryMovements.type, "consume_sale")))
    .groupBy(inventoryMovements.orderId);
  const finRows = await db
    .select({
      orderId: orderFinance.orderId,
      recognizedAt: orderFinance.recognizedAt,
    })
    .from(orderFinance)
    .where(inArray(orderFinance.orderId, ids));
  const ship = new Map(shipRows.map((r) => [r.orderId, r]));
  const consume = new Map(consumeRows.map((r) => [r.orderId!, r.at]));
  const fin = new Map(finRows.map((r) => [r.orderId, r.recognizedAt]));
  for (const o of orderRows) {
    const shippedAt = minDate(ship.get(o.id)?.handedOverAt, consume.get(o.id), fin.get(o.id));
    out.set(o.id, {
      shippedAt,
      shipped: shippedAt !== null || isShipped(o.status as OrderStatus) || isOrderFulfilledInShopify(o),
      deliveredAt: ship.get(o.id)?.deliveredAt ?? null,
    });
  }
}

/** Повернення коштів замовлення (рядки — з варіантом позиції замовлення). */
export async function loadRefundSources(db: DbOrTx, orderId: string): Promise<RefundSource[]> {
  return (await loadRefundSourcesForOrders(db, [orderId])).get(orderId) ?? [];
}

/** Повернення коштів кількох замовлень (порядок — як у loadRefundSources: за часом створення в Shopify, id). */
export async function loadRefundSourcesForOrders(db: DbOrTx, orderIds: readonly string[]): Promise<Map<string, RefundSource[]>> {
  const out = new Map<string, RefundSource[]>();
  const all = [...new Set(orderIds)];
  for (let i = 0; i < all.length; i += 1000) {
    const chunk = all.slice(i, i + 1000);
    const heads = await db
      .select({
        id: orderRefunds.id,
        orderId: orderRefunds.orderId,
        processedAt: orderRefunds.processedAt,
        createdAtShopify: orderRefunds.createdAtShopify,
        fetchedAt: orderRefunds.fetchedAt,
      })
      .from(orderRefunds)
      .where(inArray(orderRefunds.orderId, chunk))
      .orderBy(asc(orderRefunds.createdAtShopify), asc(orderRefunds.id));
    if (heads.length === 0) continue;
    const lines: Array<{
      refundId: string;
      shopifyLineItemId: string;
      orderLineItemId: string | null;
      variantId: string | null;
      quantity: number;
      restockType: string | null;
      restockQuantities: Record<string, number> | null;
    }> = [];
    for (let j = 0; j < heads.length; j += 1000) {
      lines.push(
        ...(await db
          .select({
            refundId: orderRefundLines.refundId,
            shopifyLineItemId: orderRefundLines.shopifyLineItemId,
            orderLineItemId: orderRefundLines.orderLineItemId,
            variantId: orderLineItems.variantId,
            quantity: orderRefundLines.quantity,
            restockType: orderRefundLines.restockType,
            restockQuantities: orderRefundLines.restockQuantities,
          })
          .from(orderRefundLines)
          .leftJoin(orderLineItems, eq(orderLineItems.id, orderRefundLines.orderLineItemId))
          .where(
            inArray(
              orderRefundLines.refundId,
              heads.slice(j, j + 1000).map((h) => h.id),
            ),
          )
          .orderBy(asc(orderRefundLines.shopifyLineItemId))),
      );
    }
    const byRefund = new Map<string, typeof lines>();
    for (const l of lines) {
      const list = byRefund.get(l.refundId);
      if (list) list.push(l);
      else byRefund.set(l.refundId, [l]);
    }
    for (const h of heads) {
      const list = out.get(h.orderId) ?? [];
      list.push({
        refundId: h.id,
        at: h.processedAt ?? h.createdAtShopify ?? h.fetchedAt,
        lines: (byRefund.get(h.id) ?? []).map((l) => ({
          shopifyLineItemId: l.shopifyLineItemId,
          orderLineItemId: l.orderLineItemId,
          variantId: l.variantId ?? null,
          quantity: l.quantity,
          restockType: l.restockType,
          restockQuantities: l.restockQuantities ?? null,
        })),
      });
      out.set(h.orderId, list);
    }
  }
  return out;
}

/** Id рухів надходження-повернення (receipt_manual, причина customer_return) кількох замовлень. */
export async function loadReceiptMovementIds(db: DbOrTx, orderIds: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const all = [...new Set(orderIds)];
  for (let i = 0; i < all.length; i += 1000) {
    const rows = await db
      .select({ id: inventoryMovements.id, orderId: inventoryMovements.orderId })
      .from(inventoryMovements)
      .where(
        and(
          inArray(inventoryMovements.orderId, all.slice(i, i + 1000)),
          eq(inventoryMovements.type, "receipt_manual"),
          eq(inventoryMovements.reason, CUSTOMER_RETURN_REASON),
        ),
      )
      .orderBy(asc(inventoryMovements.seq));
    for (const r of rows) {
      if (!r.orderId) continue;
      const list = out.get(r.orderId);
      if (list) list.push(r.id);
      else out.set(r.orderId, [r.id]);
    }
  }
  return out;
}

/** Надходження-повернення замовлення (придатні = on_hand − парний брак; пошкоджені = defective + парний брак). */
export async function loadReceiptSources(db: DbOrTx, orderId: string): Promise<ReceiptSource[]> {
  const rows = await db
    .select({
      id: inventoryMovements.id,
      key: inventoryMovements.idempotencyKey,
      type: inventoryMovements.type,
      seq: inventoryMovements.seq,
      createdAt: inventoryMovements.createdAt,
      onHand: inventoryMovements.onHandDelta,
      defective: inventoryMovements.defectiveDelta,
      orderLineItemId: inventoryMovements.orderLineItemId,
      variantId: stockItems.variantId,
    })
    .from(inventoryMovements)
    .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
    .where(
      and(
        eq(inventoryMovements.orderId, orderId),
        eq(inventoryMovements.reason, CUSTOMER_RETURN_REASON),
        inArray(inventoryMovements.type, ["receipt_manual", "defect_mark"]),
      ),
    )
    .orderBy(asc(inventoryMovements.seq));
  const receipts = rows.filter((r) => r.type === "receipt_manual");
  if (receipts.length === 0) return [];
  const splits = new Map(
    rows.filter((r) => r.type === "defect_mark" && r.key.endsWith(RETURN_DEFECT_SUFFIX)).map((r) => [r.key.slice(0, -RETURN_DEFECT_SUFFIX.length), r]),
  );
  const lineByVariant = new Map<string, string>();
  const needLines = receipts.some((r) => !r.orderLineItemId && r.variantId);
  if (needLines) {
    const items = await db
      .select({ id: orderLineItems.id, variantId: orderLineItems.variantId })
      .from(orderLineItems)
      .where(and(eq(orderLineItems.orderId, orderId), isNotNull(orderLineItems.variantId)))
      .orderBy(asc(orderLineItems.position), asc(orderLineItems.id));
    for (const i of items) if (i.variantId && !lineByVariant.has(i.variantId)) lineByVariant.set(i.variantId, i.id);
  }
  return receipts.map((r) => {
    const split = splits.get(r.key);
    const moved = split ? split.defective : 0;
    return {
      movementId: r.id,
      at: r.createdAt,
      seq: Number(r.seq),
      variantId: r.variantId ?? null,
      orderLineItemId: r.orderLineItemId ?? (r.variantId ? (lineByVariant.get(r.variantId) ?? null) : null),
      good: Math.max(0, r.onHand - moved),
      damaged: Math.max(0, r.defective + moved),
    };
  });
}

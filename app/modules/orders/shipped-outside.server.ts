/**
 * «Відправлено поза застосунком» (етап 5): замовлення виконано в Shopify (повністю або частково) без накладної
 * застосунку — інший перевізник, самовивіз, POS, 3PL. Shopify уже зменшив свій on_hand під час виконання; застосунок
 * списує свій резерв лише за явним рішенням менеджера (waybills.manage), бо фізичний факт знає лише склад.
 *
 * Гарантії:
 * - ОДНЕ списання: рядок замовлення блокується (FOR NO KEY UPDATE), статус переходить у handed_to_carrier, списання —
 *   syncOrderReservations у тій самій транзакції (рухи consume_sale з ключем consume:<позиція> — раз на позицію).
 *   Повторний виклик для вже відправленого замовлення нічого не змінює (already_shipped).
 * - Без звернень до перевізника й без передачі виконання в Shopify (Shopify уже виконав замовлення; відправлень
 *   застосунку немає — fulfillShipment не ставиться).
 * - Лише коли Shopify справді показує виконання (orders.fulfillment_status fulfilled / partially_fulfilled): інакше
 *   on_hand застосунку зменшився б, а Shopify — ні (розбіжність). Частково виконане: менеджер підтверджує, що ВСІ
 *   товари замовлення вже покинули склад (решту Shopify виконає поза застосунком).
 * - Активна накладна застосунку → помилка: тоді правильна дія — «Підтвердити передачу» (або скасувати накладну).
 * Позиції, яких Shopify торкнувся ще до знімка складу й які не резервувалися, не списуються (історичні; див.
 * reservations.server.ts). Проблема SHOPIFY_FULFILLED_OUTSIDE_APP закривається (resolution shipped_outside_app).
 */
import { and, eq, sql } from "drizzle-orm";
import { issues, orders } from "~/db/schema";
import { canMarkShippedOutsideApp, isFulfilledInShopify, isShipped } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { syncOrderReservations } from "~/modules/inventory/reservations.server";
import { findActiveShipment } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import { loadOrderRow, type OrderRow } from "./repository.server";

export type ShippedOutsideResult =
  /** Позначено відправленим; movements — рухи складу цього виклику (списання; 0 — склад ще не ініціалізовано тощо). */
  | { kind: "confirmed"; movements: number }
  /** Замовлення вже передане перевізнику / відправлене — нічого не змінено. */
  | { kind: "already_shipped" };

/** Чи доступна дія для замовлення (для інтерфейсу; сервер перевіряє те саме в транзакції). */
export function shippedOutsideAvailable(
  order: Pick<OrderRow, "status" | "fulfillmentStatus">,
  hasActiveShipment: boolean,
): boolean {
  return !hasActiveShipment && canMarkShippedOutsideApp(order.status) && isFulfilledInShopify(order.fulfillmentStatus);
}

export async function confirmShippedOutsideApp(ctx: ServiceContext, orderId: string): Promise<ShippedOutsideResult> {
  requirePermission(ctx.actor, "waybills.manage");
  return ctx.db.transaction(async (tx) => {
    const order = await loadOrderRow(tx, orderId, { forUpdate: true });
    if (isShipped(order.status)) return { kind: "already_shipped" } as const;
    if (order.status === "cancelled" || !canMarkShippedOutsideApp(order.status)) {
      throw new DomainError("order.notEditable", 409, { status: order.status });
    }
    if (!isFulfilledInShopify(order.fulfillmentStatus)) throw new DomainError("order.shippedOutside.notFulfilledInShopify", 409);
    if (await findActiveShipment(tx, orderId)) throw new DomainError("order.shippedOutside.activeWaybill", 409);

    await tx
      .update(orders)
      .set({ status: "handed_to_carrier", version: sql`${orders.version} + 1`, updatedAt: ctx.now() })
      .where(eq(orders.id, orderId));
    await writeAudit(tx, ctx.actor, "order.status_changed", { type: "order", id: orderId }, {
      from: order.status,
      to: "handed_to_carrier",
      source: "shipped_outside_app",
    });
    // Списання резерву (раз на позицію; позиції без резерву зі знімка — історичні, не списуються).
    const sync = await syncOrderReservations(tx, orderId, ctx.actor);
    const now = ctx.now();
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: now, resolvedBy: ctx.actor.id, resolution: "shipped_outside_app", updatedAt: now })
      .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_FULFILLED_OUTSIDE_APP")));
    await writeAudit(tx, ctx.actor, "order.shipped_outside_app", { type: "order", id: orderId }, {
      fulfillmentStatus: order.fulfillmentStatus,
      fromStatus: order.status,
      stock: sync.state,
      movements: sync.applied,
    });
    return { kind: "confirmed", movements: sync.applied } as const;
  });
}

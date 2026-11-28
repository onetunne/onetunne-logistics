/**
 * Етап 6, WP9: ключі джерел випадків повернень (`order_returns.source_key`, унікальний — повтор не створює другого
 * випадку, docs/stage6-design.md §11, §14.5) і детерміновані id позицій випадку.
 *
 * Позиції з джерела (рядок повернення коштів, надходження на склад) отримують id, обчислений із ключа джерела
 * (`returnLineId`): так «джерело вже враховане» видно навіть тоді, коли воно приєднане до випадку з ІНШИМ ключем
 * (надходження до випадку з повернення коштів і навпаки) — повторна синхронізація нічого не дублює, а паралельна
 * вставка тієї самої позиції впирається в первинний ключ (ON CONFLICT DO NOTHING). Ключі — лише id (без персональних
 * даних).
 */
import { createHash } from "node:crypto";

export const returnSourceKeys = {
  /** Повернення коштів Shopify (`order_refunds.id`). */
  refund: (refundId: string) => `ret:refund:${refundId}`,
  /** Надходження на склад з причиною customer_return (`inventory_movements.id` руху receipt_manual). */
  receipt: (movementId: string) => `ret:receipt:${movementId}`,
  /** Випадок, відкритий кнопкою «Відкрити» з підказки перевізника (`shipments.id`). */
  carrier: (shipmentId: string) => `ret:carrier:${shipmentId}`,
  /** Ручний випадок (uuid форми — подвійне надсилання не створює другого випадку). */
  manual: (operationId: string) => `ret:manual:${operationId}`,
  /** Демо (WP11). */
  demo: (part: string) => `ret:demo:${part}`,
} as const;

/** Частини позицій надходження: придатні й пошкоджені одиниці — окремі позиції з різним станом. */
export const RECEIPT_LINE_PARTS = ["resellable", "damaged"] as const;

/** Детермінований uuid (формат v5: версія 5, варіант RFC 4122) позиції `part` джерела `sourceKey`. */
export function returnLineId(sourceKey: string, part: string): string {
  const b = createHash("sha256").update(`order_return_line|${sourceKey}|${part}`).digest();
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.subarray(0, 16).toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

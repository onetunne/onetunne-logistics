/**
 * Статуси замовлення та дозволені переходи (детермінований автомат станів).
 * Важливо: створення накладної НЕ означає відправлення. «Відправлено» —
 * лише після фактичної передачі перевізнику (handed_to_carrier).
 */
export const ORDER_STATUSES = [
  "paid",
  "awaiting_review",
  "needs_correction",
  "waybill_created",
  "awaiting_picking",
  "packed",
  "handed_to_carrier",
  "in_transit",
  "customs",
  "delivered",
  "delivery_problem",
  "returned",
  "cancelled",
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  paid: ["awaiting_review", "needs_correction", "cancelled"],
  awaiting_review: ["needs_correction", "waybill_created", "cancelled"],
  needs_correction: ["awaiting_review", "cancelled"],
  // → handed_to_carrier: фактичну передачу підтвердив перевізник (відстеження) або менеджер
  // (комплектація/пакування — етап 5, тому проміжні статуси можуть бути пропущені).
  waybill_created: ["awaiting_picking", "handed_to_carrier", "awaiting_review", "needs_correction", "cancelled"],
  awaiting_picking: ["packed", "handed_to_carrier", "awaiting_review", "cancelled"],
  packed: ["handed_to_carrier", "awaiting_picking", "cancelled"],
  handed_to_carrier: ["in_transit", "customs", "delivered", "delivery_problem", "returned"],
  in_transit: ["customs", "delivered", "delivery_problem", "returned"],
  customs: ["in_transit", "delivered", "delivery_problem", "returned"],
  delivery_problem: ["in_transit", "customs", "delivered", "returned"],
  delivered: ["returned"],
  returned: [],
  cancelled: [],
};

/** Статуси після фактичної передачі посилки перевізнику. */
export const SHIPPED_STATUSES: readonly OrderStatus[] = [
  "handed_to_carrier",
  "in_transit",
  "customs",
  "delivered",
  "delivery_problem",
  "returned",
];

/** Статуси, у яких дані замовлення ще можна редагувати (до передачі перевізнику). */
export const EDITABLE_STATUSES: readonly OrderStatus[] = [
  "paid",
  "awaiting_review",
  "needs_correction",
  "waybill_created",
  "awaiting_picking",
  "packed",
];

export function isOrderStatus(value: unknown): value is OrderStatus {
  return typeof value === "string" && (ORDER_STATUSES as readonly string[]).includes(value);
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  return ORDER_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: OrderStatus,
    readonly to: OrderStatus,
  ) {
    super(`Invalid order status transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isShipped(status: OrderStatus): boolean {
  return SHIPPED_STATUSES.includes(status);
}

export function isEditable(status: OrderStatus): boolean {
  return EDITABLE_STATUSES.includes(status);
}

/**
 * Shopify показує повне або часткове виконання замовлення (orders.fulfillment_status — displayFulfillmentStatus у нижньому
 * регістрі). Для замовлення, НЕ відправленого застосунком, це виконання поза застосунком: така накладна була б повторним
 * відправленням (modules/shipments/waybill.server.ts блокує створення), а склад списує лише за явним рішенням менеджера
 * («Відправлено поза застосунком», modules/orders/shipped-outside.server.ts).
 *
 * shippableFulfilled (orders.shopify_shippable_fulfilled) уточнює ЧАСТКОВЕ виконання: false — Shopify виконав лише
 * позиції без доставки (цифрову подарункову картку Shopify виконує після активації, зазвичай автоматично; так само —
 * цифрові товари), фізичні товари ще не відправлено → це не виконання поза застосунком. Не передано / null (невідомо) — як
 * виконання (безпечніше: накладна не створюється). Повне виконання (fulfilled) — завжди виконання: Shopify вважає, що
 * відправляти більше нічого.
 */
export function isFulfilledInShopify(fulfillmentStatus: string | null | undefined, shippableFulfilled?: boolean | null): boolean {
  if (fulfillmentStatus === "fulfilled") return true;
  return fulfillmentStatus === "partially_fulfilled" && shippableFulfilled !== false;
}

/** Те саме за рядком замовлення (orders.fulfillment_status + orders.shopify_shippable_fulfilled). */
export function isOrderFulfilledInShopify(order: { fulfillmentStatus: string | null; shopifyShippableFulfilled: boolean | null }): boolean {
  return isFulfilledInShopify(order.fulfillmentStatus, order.shopifyShippableFulfilled);
}

/**
 * Статуси, з яких менеджер може підтвердити «Відправлено поза застосунком» (замовлення виконано в Shopify, а накладної
 * застосунку немає) — окремий явний перехід у handed_to_carrier, не частина ORDER_TRANSITIONS: автоматичні шляхи
 * (відстеження, синхронізація) так перейти не можуть.
 */
export const SHIPPED_OUTSIDE_APP_FROM: readonly OrderStatus[] = EDITABLE_STATUSES;

export function canMarkShippedOutsideApp(status: OrderStatus): boolean {
  return SHIPPED_OUTSIDE_APP_FROM.includes(status);
}

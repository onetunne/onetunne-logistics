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

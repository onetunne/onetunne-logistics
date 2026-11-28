/**
 * Етап 6, WP4: визнання замовлення (docs/stage6-design.md §3.2) — чиста функція.
 *
 * `recognized_on` встановлюється ОДИН раз — під час першого syncOrderFinance, що бачить замовлення переданим
 * перевізнику (`status ∈ SHIPPED_STATUSES`, той самий предикат, що reservationModeFor → «consume»): дата Києва першого
 * наявного доказу в порядку пріоритету:
 *   1. min(shipments.handed_over_at) відправлень замовлення (подія відстеження або ручна передача) → `handover`;
 *   2. min(inventory_movements.created_at) рухів consume_sale замовлення → `consume`;
 *   3. orders.placed_at (імпортовані вже виконаними, без руху) → `placed_fallback` («дата відвантаження невідома»).
 * Разом із датою зберігається момент `recognized_at` (той самий доказ) — межа «до / після визнання» для угод продажу
 * (§2.1). Дата, раз установлена, НЕ рухається (F6) — і коли замовлення пізніше скасовано (виручка лишається, §3.5) або
 * виключено (тестове без includeTestOrders): повторне ввімкнення includeTestOrders дає ту саму дату.
 *
 * Стан: тестове без includeTestOrders → `excluded` (і до, і після передачі); визнане → `recognized`; скасоване або
 * повністю повернене до передачі → `closed_unrecognized`; інакше `open`.
 */
import { SHIPPED_STATUSES, type OrderStatus } from "~/domain/order-status";
import type { FxRateDatePolicy, OrderFinanceState, RecognitionBasis } from "~/domain/finance";
import { businessDate } from "~/lib/periods";

export interface RecognitionEvidence {
  /** min(shipments.handed_over_at) відправлень замовлення. */
  handoverAt: Date | null;
  /** min(inventory_movements.created_at) рухів consume_sale замовлення. */
  consumeAt: Date | null;
  placedAt: Date;
}

export interface RecognitionInput extends RecognitionEvidence {
  status: OrderStatus;
  /** orders.shopify_test. */
  test: boolean;
  includeTestOrders: boolean;
  /** Shopify displayFinancialStatus = REFUNDED (повністю повернено). */
  fullyRefunded: boolean;
  /** Уже збережене визнання (order_finance) — не рухається. */
  existing: { recognizedOn: string | null; recognizedAt: Date | null; basis: RecognitionBasis | null } | null;
}

export interface RecognitionResult {
  state: OrderFinanceState;
  recognizedOn: string | null;
  recognizedAt: Date | null;
  basis: RecognitionBasis | null;
}

/** Доказ визнання (у порядку пріоритету §3.2) або null, якщо замовлення ще не передано. */
export function recognitionEvidence(status: OrderStatus, e: RecognitionEvidence): { at: Date; basis: RecognitionBasis } | null {
  if (!SHIPPED_STATUSES.includes(status)) return null;
  if (e.handoverAt) return { at: e.handoverAt, basis: "handover" };
  if (e.consumeAt) return { at: e.consumeAt, basis: "consume" };
  return { at: e.placedAt, basis: "placed_fallback" };
}

export function recognizeOrder(input: RecognitionInput): RecognitionResult {
  let recognizedOn = input.existing?.recognizedOn ?? null;
  let recognizedAt = input.existing?.recognizedAt ?? null;
  let basis = input.existing?.basis ?? null;
  if (!recognizedOn || !recognizedAt) {
    const ev = recognitionEvidence(input.status, input);
    if (ev) {
      recognizedAt = ev.at;
      recognizedOn = businessDate(ev.at);
      basis = ev.basis;
    } else {
      recognizedOn = null;
      recognizedAt = null;
      basis = null;
    }
  }
  const excluded = input.test && !input.includeTestOrders;
  let state: OrderFinanceState;
  if (excluded) state = "excluded";
  else if (recognizedOn) state = "recognized";
  else if (input.status === "cancelled" || input.fullyRefunded) state = "closed_unrecognized";
  else state = "open";
  return { state, recognizedOn, recognizedAt, basis };
}

export interface PaymentTransactionLike {
  kind: string;
  status: string;
  test: boolean;
  processedAt: Date | null;
}

/**
 * Дата оплати (D-25): Київ-дата першої SUCCESS-транзакції SALE / CAPTURE (не тестової, з `processedAt`); без
 * транзакцій — дата `placed_at`.
 */
export function paymentDateOf(transactions: readonly PaymentTransactionLike[], placedAt: Date): string {
  let first: Date | null = null;
  for (const t of transactions) {
    if (t.status !== "SUCCESS" || t.test || (t.kind !== "SALE" && t.kind !== "CAPTURE") || !t.processedAt) continue;
    if (!first || t.processedAt < first) first = t.processedAt;
  }
  return businessDate(first ?? placedAt);
}

/** Дата курсу виручки й комісій оплати (§3.3 R1, D-25): дата оплати або дата визнання за політикою. */
export function revenueFxDateOf(policy: FxRateDatePolicy, paymentDate: string, recognizedOn: string | null): string {
  if (policy === "recognition_date" && recognizedOn) return recognizedOn;
  return paymentDate;
}

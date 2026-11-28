/**
 * Етап 6 (WP3): форма збережених фактів Shopify замовлення — `order_shopify_finance.snapshot` і `.flags`
 * (docs/stage6-design.md §17.3). Чисті типи й розбір, без сервера: їх читають WP4 (складники, стани, причини перевірки),
 * WP7 (атрибуція), WP8/WP9 (статистика), WP12b (документи). Гроші — десяткові рядки у валюті магазину/покупця.
 *
 * КОНТРАКТ для WP4 (syncOrderFinance):
 * - `status.sales !== "complete"` → складник виручки `missing` (`awaiting_shopify`); з прапорцем `order_unreadable` —
 *   «Оцінка» (`order_snapshot`); продажі з `order_sales` при цьому НЕ проводити як повну виручку;
 * - `status.sales = "complete"` + прапорець `order_unreadable` — факти попереднього читання чинні (проводяться), але
 *   пізнішу зміну (напр. повернення за замовленням > 60 днів) Shopify не віддав: лише «Потребує перевірки»
 *   (`order_unreadable`), складник НЕ переводиться в «Оцінку»;
 * - `flags` — лише коди REVIEW_REASONS (`FINANCE_SYNC_FLAGS`): WP4 додає їх у `order_finance.review_reasons`;
 * - стан `partial` (`reconciliation_mismatch`) — `partialComponentsOf` (reconcile.ts) через `loadReconciliationState`
 *   (facts-view.server.ts), а не з самого прапорця (кандидати RC1/RC4 складник не змінюють);
 * - `status.transactions !== "complete"` (`truncated` / `damaged` / `not_read`) — «Оплачено покупцем» і дата оплати
 *   неповні (RC2/RC3 unknown), не фактичні;
 * - `status.fees !== "complete"` (`truncated` / `damaged` / `not_read`) — збережені `order_transaction_fees` НЕ повний
 *   набір комісій: складник комісій не може бути `actual` / `zero_confirmed` з цих рядків (F4, §8.1 «НІКОЛИ не 0») —
 *   `missing` (`awaiting_shopify`) з прогнозом правила шлюзу, якщо він є, + причина перевірки з прапорців.
 */
import type { ReviewReason } from "~/domain/finance";
import type { FeesStatus, FinanceParseError, FinanceTotalKey, TransactionsStatus } from "./parse";

export const SNAPSHOT_VERSION = 1;

/** Прапорці фактів — підмножина причин «Потребує перевірки» (REVIEW_REASONS), які визначає синхронізація фінансів. */
export const FINANCE_SYNC_FLAGS = [
  "transactions_truncated",
  "refunds_incomplete",
  "amount_parse_error",
  "unsupported_currency",
  "reconciliation_mismatch",
  "order_unreadable",
  "journey_never_ready",
] as const satisfies readonly ReviewReason[];
export type FinanceSyncFlag = (typeof FINANCE_SYNC_FLAGS)[number];

export interface StoredMoney {
  amount: string;
  currency: string;
  presentmentAmount: string | null;
  presentmentCurrency: string | null;
}

/**
 * Стан продажів угод: complete — усі угоди й продажі прочитано без помилок; damaged — пошкоджене значення (продажі цього
 * читання не збережено); unsupported_currency — валюта з 3–4 знаками; not_read — угоди ще не читалися (недоступне
 * замовлення, перше читання не вдалося).
 */
export type SalesFactStatus = "complete" | "damaged" | "unsupported_currency" | "not_read";
/** Стан повернень коштів: none — повернень немає; incomplete — прочитано не всі (refunds_incomplete). */
export type RefundsFactStatus = "none" | "complete" | "incomplete" | "damaged" | "not_read";

export interface SnapshotShippingLine {
  title: string | null;
  code: string | null;
  source: string | null;
  carrierIdentifier: string | null;
  isRemoved: boolean | null;
  discountedPrice: StoredMoney | null;
  currentDiscountedPrice: StoredMoney | null;
}

export interface OrderShopifySnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** Order.updatedAt останнього читання OtOrderFinance (ISO). */
  orderUpdatedAt: string | null;
  createdAt: string | null;
  processedAt: string | null;
  cancelledAt: string | null;
  test: boolean | null;
  totals: Partial<Record<FinanceTotalKey, StoredMoney | null>>;
  shippingLines: SnapshotShippingLine[];
  status: { sales: SalesFactStatus; transactions: TransactionsStatus | "not_read"; fees: FeesStatus | "not_read"; refunds: RefundsFactStatus };
  /** Order.updatedAt, для якого прочитано угоди (null — не читалися). */
  agreementsReadFor: string | null;
  /** Id повернень з угод RefundAgreement (останнє читання угод). */
  refundGids: string[];
  parseErrors: { order: FinanceParseError[]; sales: FinanceParseError[]; refunds: FinanceParseError[] };
  /** Кількість помилок понад збережені (MAX_STORED_PARSE_ERRORS). */
  parseErrorsTruncated: number;
}

export function emptySnapshot(): OrderShopifySnapshot {
  return {
    version: SNAPSHOT_VERSION,
    orderUpdatedAt: null,
    createdAt: null,
    processedAt: null,
    cancelledAt: null,
    test: null,
    totals: {},
    shippingLines: [],
    status: { sales: "not_read", transactions: "not_read", fees: "not_read", refunds: "not_read" },
    agreementsReadFor: null,
    refundGids: [],
    parseErrors: { order: [], sales: [], refunds: [] },
    parseErrorsTruncated: 0,
  };
}

/** Розбір збереженого знімка; невідома/порожня форма → порожній знімок («не читалося»). */
export function parseSnapshot(value: unknown): OrderShopifySnapshot {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== SNAPSHOT_VERSION) return emptySnapshot();
  const v = value as Partial<OrderShopifySnapshot>;
  const base = emptySnapshot();
  return {
    ...base,
    ...v,
    status: { ...base.status, ...(v.status ?? {}) },
    parseErrors: { ...base.parseErrors, ...(v.parseErrors ?? {}) },
    refundGids: Array.isArray(v.refundGids) ? v.refundGids : [],
    shippingLines: Array.isArray(v.shippingLines) ? v.shippingLines : [],
    totals: v.totals && typeof v.totals === "object" ? v.totals : {},
  } as OrderShopifySnapshot;
}

export function isFinanceSyncFlag(value: string): value is FinanceSyncFlag {
  return (FINANCE_SYNC_FLAGS as readonly string[]).includes(value);
}

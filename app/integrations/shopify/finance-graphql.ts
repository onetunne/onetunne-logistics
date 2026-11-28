/**
 * Етап 6: GraphQL Admin API 2026-10 — фінансові читання замовлень (docs/stage6-design.md §16.2). Документи (OtOrderFinance,
 * OtOrderAgreements, OtAgreementSales, OtOrderRefunds, OtOrdersUpdatedSince) додає WP3 у цей файл; ядро (WP0) зафіксувало
 * розміри сторінок і змінні, з якими їх викликають (рядки SIZES у tests/stage5/shopify-query-cost.test.ts):
 * розміри ВБУДОВУЮТЬСЯ в документ із цих констант (як ORDER_QUERY), змінні — лише id / курсори / рядок пошуку.
 * Наявні ORDER_QUERY (461) і ORDERS_PAGE_QUERY (737) не змінюються. Ліміт оцінки — 950 балів.
 * Свідомо НЕ вибираються: ShippingLine.phone, адреси, email, accountNumber, receiptJson, paymentDetails, Refund.note,
 * staffMember, returnReasonNote, customerNote, ReturnAgreement.return, докази спорів.
 */

/** OtOrderFinance($id): shippingLines(first: 5, includeRemovals: true). Оцінка — 382. */
export const FINANCE_SHIPPING_LINES_PAGE = 5;
/** OtOrderFinance($id): transactions(first: 20) + transactionsCount { count } (обрізання видно з count > 20). */
export const FINANCE_TRANSACTIONS_PAGE = 20;
/** OtOrderFinance($id): fulfillments(first: 10). */
export const FINANCE_FULFILLMENTS_PAGE = 10;
/** OtOrderFinance($id): fulfillments.trackingInfo(first: 5) — зовнішні номери накладних (recordExternalWaybills). */
export const FINANCE_TRACKING_PAGE = 5;
/** OtOrderAgreements($id, $after): agreements(first: 3) { sales(first: 15) }. Оцінка — 558. */
export const FINANCE_AGREEMENTS_PAGE = 3;
export const FINANCE_AGREEMENT_SALES_PAGE = 15;
/** OtAgreementSales($id, $agreementQuery, $after): agreements(first: 1, query) { sales(first: 50, after) }. Оцінка — 606. */
export const FINANCE_AGREEMENT_SALES_MORE_PAGE = 50;
/** OtOrderRefunds($id): refunds(first: 10) { refundLineItems(first: 10) }. Оцінка — 666. */
export const FINANCE_REFUNDS_PAGE = 10;
export const FINANCE_REFUND_LINES_PAGE = 10;
/** OtOrdersUpdatedSince($query, $after): orders(first: 50, sortKey: UPDATED_AT). Оцінка — 102. */
export const FINANCE_RECONCILE_PAGE = 50;

/** Оцінки, виміряні оцінювачем репозиторію на вибірках §16.2 (28.11.2026) — точні формули в тестах WP3. */
export const FINANCE_QUERY_COST_ESTIMATES = {
  OtOrderFinance: 382,
  OtOrderAgreements: 558,
  OtAgreementSales: 606,
  OtOrderRefunds: 666,
  OtOrdersUpdatedSince: 102,
} as const;

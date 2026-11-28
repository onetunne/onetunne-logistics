/**
 * Етап 6: GraphQL Admin API 2026-10 — фінансові читання замовлень (docs/stage6-design.md §16.2). Документи (OtOrderFinance,
 * OtOrderAgreements, OtAgreementSales, OtOrderRefunds, OtOrdersUpdatedSince) — WP3; ядро (WP0) зафіксувало розміри сторінок
 * і змінні, з якими їх викликають (рядки SIZES у tests/stage5/shopify-query-cost.test.ts): розміри ВБУДОВАНО в документ із
 * цих констант (як ORDER_QUERY), змінні — лише id / курсори / рядок пошуку. Наявні ORDER_QUERY (461) і ORDERS_PAGE_QUERY
 * (737) не змінюються. Ліміт оцінки — 950 балів; точні формули — tests/stage6/finance-sync/graphql-cost.test.ts.
 * Свідомо НЕ вибираються: ShippingLine.phone, адреси, email, accountNumber, receiptJson, paymentDetails, Refund.note,
 * staffMember, returnReasonNote, customerNote, ReturnAgreement.return, докази спорів.
 *
 * Поля звірено з документацією shopify.dev (Order, OrderTransaction, TransactionFee, SalesAgreement, Sale, ProductSale,
 * RefundAgreement, Refund, RefundLineItem, OrderDisputeSummary, CustomerJourneySummary, Fulfillment.trackingInfo).
 * Тип `totalTaxAmount` / `totalDiscountAmountBeforeTaxes` у фактах не вказано — припущено MoneyBag, як у `totalAmount`:
 * неправильне припущення дає явну помилку GraphQL на тестовому магазині, а не тихий нуль (§16.2).
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

/** MoneyBag: гроші магазину й покупця (оцінка — 3: об'єкт + два вкладені). */
const MB = "{ shopMoney { amount currencyCode } presentmentMoney { amount currencyCode } }";
/** MoneyV2 (оцінка — 1). */
const MV2 = "{ amount currencyCode }";

/**
 * Підсумки замовлення для звірки (§16.1 «Звірка (знімок)»): 12 MoneyBag. Ключ — назва поля без суфікса Set
 * (modules/finance-sync/parse.ts FINANCE_TOTAL_KEYS у тому самому порядку).
 */
export const FINANCE_TOTAL_FIELDS = [
  "totalPriceSet",
  "currentTotalPriceSet",
  "currentTotalTaxSet",
  "currentTotalDiscountsSet",
  "currentShippingPriceSet",
  "totalRefundedSet",
  "totalRefundedShippingSet",
  "totalReceivedSet",
  "netPaymentSet",
  "totalTipReceivedSet",
  "currentTotalDutiesSet",
  "totalOutstandingSet",
] as const;
export type FinanceTotalField = (typeof FINANCE_TOTAL_FIELDS)[number];

/**
 * Фінансовий знімок замовлення: скаляри й MoneyBag-и звірки, customerJourneySummary (реферальний код, §9.2), спори без
 * суми, рядки доставки (довідково), транзакції з комісіями (+ transactionsCount: обрізання точно видно з count > 20) і
 * трек-номери виконань (зовнішні номери накладних). Оцінка 382 (без transactionsCount і fulfillments — 299).
 */
export const ORDER_FINANCE_QUERY = `#graphql
  query OtOrderFinance($id: ID!) {
    order(id: $id) {
      id updatedAt createdAt processedAt cancelledAt test edited taxesIncluded
      currencyCode presentmentCurrencyCode displayFinancialStatus returnStatus
      paymentGatewayNames discountCodes
      ${FINANCE_TOTAL_FIELDS.map((f) => `${f} ${MB}`).join("\n      ")}
      customerJourneySummary { ready lastVisit { referralCode } }
      disputes { id initiatedAs status }
      shippingLines(first: ${FINANCE_SHIPPING_LINES_PAGE}, includeRemovals: true) {
        nodes { title code source carrierIdentifier isRemoved discountedPriceSet ${MB} currentDiscountedPriceSet ${MB} }
      }
      transactions(first: ${FINANCE_TRANSACTIONS_PAGE}) {
        id kind status test gateway manualPaymentGateway createdAt processedAt
        parentTransaction { id }
        amountSet ${MB}
        settlementCurrency settlementCurrencyRate
        currencyExchangeAdjustment { id adjustment ${MV2} }
        fees { id type amount ${MV2} flatFee ${MV2} rate rateName taxAmount ${MV2} }
      }
      transactionsCount { count }
      fulfillments(first: ${FINANCE_FULFILLMENTS_PAGE}) { trackingInfo(first: ${FINANCE_TRACKING_PAGE}) { number company } }
    }
  }`;

const SALE_FIELDS = `
  __typename id actionType lineType quantity
  totalAmount ${MB} totalTaxAmount ${MB} totalDiscountAmountBeforeTaxes ${MB}
  ... on ProductSale { lineItem { id } }
`;

/**
 * Угоди продажу замовлення (§2.1, §16.1): сторінки угод по 3, у кожній — перші 15 продажів; решта продажів угоди —
 * OtAgreementSales. updatedAt — перевірка, що замовлення не змінилося між сторінками. Оцінка 558.
 */
export const ORDER_AGREEMENTS_QUERY = `#graphql
  query OtOrderAgreements($id: ID!, $after: String) {
    order(id: $id) {
      id updatedAt
      agreements(first: ${FINANCE_AGREEMENTS_PAGE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename id happenedAt reason
          ... on RefundAgreement { refund { id } }
          sales(first: ${FINANCE_AGREEMENT_SALES_PAGE}) {
            pageInfo { hasNextPage endCursor }
            nodes { ${SALE_FIELDS} }
          }
        }
      }
    }
  }`;

/** Наступні сторінки продажів однієї угоди (agreementQuery = `id:<числовий id угоди>`). Оцінка 606. */
export const AGREEMENT_SALES_QUERY = `#graphql
  query OtAgreementSales($id: ID!, $agreementQuery: String!, $after: String) {
    order(id: $id) {
      id updatedAt
      agreements(first: 1, query: $agreementQuery) {
        nodes {
          id
          sales(first: ${FINANCE_AGREEMENT_SALES_MORE_PAGE}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { ${SALE_FIELDS} }
          }
        }
      }
    }
  }`;

/**
 * Повернення коштів (заголовки й рядки — розділ «Повернення», статистика, звірка RC3, звірка повернень етапу 5 за
 * restockType/restocked). Лише коли totalRefundedSet > 0 і змінилися id повернень. Без note/staffMember/return. Оцінка 666.
 */
export const ORDER_REFUNDS_QUERY = `#graphql
  query OtOrderRefunds($id: ID!) {
    order(id: $id) {
      id updatedAt
      totalRefundedSet ${MB}
      refunds(first: ${FINANCE_REFUNDS_PAGE}) {
        id createdAt processedAt
        totalRefundedSet ${MB}
        refundLineItems(first: ${FINANCE_REFUND_LINES_PAGE}) {
          pageInfo { hasNextPage }
          nodes { quantity restockType restocked lineItem { id } subtotalSet ${MB} }
        }
      }
    }
  }`;

/** Змінені замовлення від водяного знаку (звірка, §16.3): query = `updated_at:>='<ISO>'`. Оцінка 102. */
export const ORDERS_UPDATED_SINCE_QUERY = `#graphql
  query OtOrdersUpdatedSince($query: String!, $after: String) {
    orders(first: ${FINANCE_RECONCILE_PAGE}, after: $after, sortKey: UPDATED_AT, query: $query) {
      pageInfo { hasNextPage endCursor }
      nodes { id updatedAt test }
    }
  }`;

// ---------------------------------------------------------------------------
// Сирі відповіді (НЕ довіряються: розбір — modules/finance-sync/parse.ts, гроші — строгий parseShopifyMoney)
// ---------------------------------------------------------------------------

export interface GqlMoneyV2 {
  amount: unknown;
  currencyCode: unknown;
}

export interface GqlMoneyBag {
  shopMoney: GqlMoneyV2 | null;
  presentmentMoney: GqlMoneyV2 | null;
}

export interface GqlFinanceTransaction {
  id: string;
  kind: string;
  status: string;
  test: boolean;
  gateway: string | null;
  manualPaymentGateway: boolean | null;
  createdAt: string | null;
  processedAt: string | null;
  parentTransaction: { id: string } | null;
  amountSet: GqlMoneyBag | null;
  settlementCurrency: string | null;
  settlementCurrencyRate: string | null;
  currencyExchangeAdjustment: { id: string; adjustment: GqlMoneyV2 | null } | null;
  fees: Array<{
    id: string;
    type: string | null;
    amount: GqlMoneyV2 | null;
    flatFee: GqlMoneyV2 | null;
    rate: string | null;
    rateName: string | null;
    taxAmount: GqlMoneyV2 | null;
  }> | null;
}

export type GqlOrderFinanceNode = {
  id: string;
  updatedAt: string;
  createdAt: string | null;
  processedAt: string | null;
  cancelledAt: string | null;
  test: boolean;
  edited: boolean | null;
  taxesIncluded: boolean | null;
  currencyCode: string;
  presentmentCurrencyCode: string | null;
  displayFinancialStatus: string | null;
  returnStatus: string | null;
  paymentGatewayNames: string[] | null;
  discountCodes: string[] | null;
  customerJourneySummary: { ready: boolean | null; lastVisit: { referralCode: string | null } | null } | null;
  disputes: Array<{ id: string; initiatedAs: string | null; status: string | null }> | null;
  shippingLines: {
    nodes: Array<{
      title: string | null;
      code: string | null;
      source: string | null;
      carrierIdentifier: string | null;
      isRemoved: boolean | null;
      discountedPriceSet: GqlMoneyBag | null;
      currentDiscountedPriceSet: GqlMoneyBag | null;
    }>;
  } | null;
  transactions: GqlFinanceTransaction[] | null;
  transactionsCount: { count: number } | null;
  fulfillments: Array<{ trackingInfo: Array<{ number: string | null; company: string | null }> | null }> | null;
} & { [K in FinanceTotalField]: GqlMoneyBag | null };

export interface GqlOrderFinance {
  order: GqlOrderFinanceNode | null;
}

export interface GqlSale {
  __typename: string;
  id: string;
  actionType: string;
  lineType: string;
  quantity: number | null;
  totalAmount: GqlMoneyBag | null;
  totalTaxAmount: GqlMoneyBag | null;
  totalDiscountAmountBeforeTaxes: GqlMoneyBag | null;
  lineItem?: { id: string } | null;
}

export interface GqlSalesConnection {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: GqlSale[];
}

export interface GqlAgreement {
  __typename: string;
  id: string;
  happenedAt: string;
  reason: string | null;
  refund?: { id: string } | null;
  sales: GqlSalesConnection;
}

export interface GqlOrderAgreements {
  order: {
    id: string;
    updatedAt: string;
    agreements: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlAgreement[] };
  } | null;
}

export interface GqlAgreementSales {
  order: { id: string; updatedAt: string; agreements: { nodes: Array<{ id: string; sales: GqlSalesConnection }> } } | null;
}

export interface GqlRefund {
  id: string;
  createdAt: string | null;
  processedAt: string | null;
  totalRefundedSet: GqlMoneyBag | null;
  refundLineItems: {
    pageInfo: { hasNextPage: boolean };
    nodes: Array<{
      quantity: number;
      restockType: string | null;
      restocked: boolean | null;
      lineItem: { id: string } | null;
      subtotalSet: GqlMoneyBag | null;
    }>;
  } | null;
}

export interface GqlOrderRefunds {
  order: { id: string; updatedAt: string; totalRefundedSet: GqlMoneyBag | null; refunds: GqlRefund[] | null } | null;
}

export interface GqlOrdersUpdatedSince {
  orders: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Array<{ id: string; updatedAt: string; test: boolean }> };
}

/** Рядок пошуку для OtOrdersUpdatedSince (ISO-час без мілісекунд). */
export function updatedSinceQuery(since: Date): string {
  return `updated_at:>='${since.toISOString().replace(/\.\d{3}Z$/, "Z")}'`;
}

/** Рядок пошуку угоди для OtAgreementSales: `id:<числовий id>` з GID угоди (null — GID без числового id). */
export function agreementIdQuery(agreementGid: string): string | null {
  const m = /\/(\d+)$/.exec(agreementGid);
  return m ? `id:${m[1]}` : null;
}

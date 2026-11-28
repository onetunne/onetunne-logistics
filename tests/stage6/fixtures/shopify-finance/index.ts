/**
 * Етап 6 (WP3): імітація фінансових читань Admin API (OtOrderFinance, OtOrderAgreements, OtAgreementSales, OtOrderRefunds,
 * OtOrdersUpdatedSince) і будівники вигаданих даних у форматі відповідей 2026-10 (без персональних даних; гроші —
 * рядки Decimal, як у Shopify). Кожен виклик перевіряє запитувану вартість оцінювачем репозиторію (≤ 950 балів,
 * costCheckedAdmin) і пагінацію так, як її віддає Shopify (угоди по 3, продажі по 15, додаткові продажі по 50, повернення
 * по 10, рядки повернень по 10 з hasNextPage, змінені замовлення по 50).
 */
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  FINANCE_AGREEMENTS_PAGE,
  FINANCE_AGREEMENT_SALES_MORE_PAGE,
  FINANCE_AGREEMENT_SALES_PAGE,
  FINANCE_RECONCILE_PAGE,
  FINANCE_REFUNDS_PAGE,
  FINANCE_REFUND_LINES_PAGE,
  FINANCE_TRANSACTIONS_PAGE,
  type FinanceTotalField,
  type GqlFinanceTransaction,
  type GqlMoneyBag,
  type GqlOrderFinanceNode,
} from "~/integrations/shopify/finance-graphql";
import { QUERY_COST_BUDGET, requestedQueryCost } from "../../../helpers/shopify-query-cost";

export const SHOP = "ot-finance.myshopify.com";

export function bag(amount: string, currency = "EUR", pAmount: string = amount, pCurrency: string = currency): GqlMoneyBag {
  return { shopMoney: { amount, currencyCode: currency }, presentmentMoney: { amount: pAmount, currencyCode: pCurrency } };
}
export const mv2 = (amount: string, currency = "EUR") => ({ amount, currencyCode: currency });

export interface FixtureSale {
  __typename: string;
  id: string;
  actionType: string;
  lineType: string;
  quantity: number | null;
  totalAmount: unknown;
  totalTaxAmount: unknown;
  totalDiscountAmountBeforeTaxes: unknown;
  lineItem?: { id: string } | null;
}

export interface FixtureAgreement {
  __typename: string;
  id: string;
  happenedAt: string;
  reason: string | null;
  refund?: { id: string } | null;
  /** Усі продажі (імітація ділить їх на сторінки). */
  sales: FixtureSale[];
}

export interface FixtureRefund {
  id: string;
  createdAt: string | null;
  processedAt: string | null;
  totalRefundedSet: unknown;
  /** Усі рядки (імітація віддає перші 10 + hasNextPage). */
  lines: Array<{ quantity: number; restockType: string | null; restocked: boolean | null; lineItem: { id: string } | null; subtotalSet: unknown }>;
}

export interface FinanceOrderFixture {
  finance: GqlOrderFinanceNode;
  agreements: FixtureAgreement[];
  refunds: FixtureRefund[];
  /** Повна кількість транзакцій (transactionsCount); типово — довжина списку. */
  transactionsTotal?: number;
}

let seq = 1000;
export const nextId = () => ++seq;

export function sale(input: {
  id?: number;
  lineType?: string;
  actionType?: string;
  quantity?: number | null;
  total: string;
  tax?: string;
  discount?: string | null;
  currency?: string;
  pTotal?: string;
  pTax?: string;
  pCurrency?: string;
  lineItem?: string | null;
}): FixtureSale {
  const id = input.id ?? nextId();
  const lineType = input.lineType ?? "PRODUCT";
  const currency = input.currency ?? "EUR";
  return {
    __typename: lineType === "PRODUCT" ? "ProductSale" : lineType === "SHIPPING" ? "ShippingLineSale" : "AdjustmentSale",
    id: `gid://shopify/${lineType === "PRODUCT" ? "ProductSale" : "Sale"}/${id}`,
    actionType: input.actionType ?? "ORDER",
    lineType,
    quantity: input.quantity === undefined ? (lineType === "PRODUCT" ? 1 : null) : input.quantity,
    totalAmount: bag(input.total, currency, input.pTotal ?? input.total, input.pCurrency ?? currency),
    totalTaxAmount: bag(input.tax ?? "0.00", currency, input.pTax ?? input.tax ?? "0.00", input.pCurrency ?? currency),
    totalDiscountAmountBeforeTaxes: input.discount === null ? null : bag(input.discount ?? "0.00", currency, input.discount ?? "0.00", input.pCurrency ?? currency),
    ...(lineType === "PRODUCT" ? { lineItem: input.lineItem === null ? null : { id: input.lineItem ?? "gid://shopify/LineItem/1" } } : {}),
  };
}

export function agreement(kind: "OrderAgreement" | "OrderEditAgreement" | "RefundAgreement" | "ReturnAgreement" | string, happenedAt: string, sales: FixtureSale[], over: Partial<FixtureAgreement> = {}): FixtureAgreement {
  const id = nextId();
  return {
    __typename: kind,
    id: `gid://shopify/SalesAgreement/${id}`,
    happenedAt,
    reason: kind === "RefundAgreement" ? "REFUND" : kind === "ReturnAgreement" ? "RETURN" : kind === "OrderEditAgreement" ? "ORDER_EDIT" : "ORDER",
    ...(kind === "RefundAgreement" ? { refund: { id: `gid://shopify/Refund/${id}` } } : {}),
    sales,
    ...over,
  };
}

/** Угода у формі відповіді OtOrderAgreements з усіма продажами на одній сторінці (для чистих тестів розбору). */
export function agreementNode(a: FixtureAgreement) {
  return { ...a, sales: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: a.sales } };
}

export function transaction(input: {
  id?: number;
  kind?: string;
  status?: string;
  amount: string;
  currency?: string;
  processedAt?: string;
  gateway?: string;
  test?: boolean;
  fees?: GqlFinanceTransaction["fees"];
}): GqlFinanceTransaction {
  const id = input.id ?? nextId();
  return {
    id: `gid://shopify/OrderTransaction/${id}`,
    kind: input.kind ?? "SALE",
    status: input.status ?? "SUCCESS",
    test: input.test ?? false,
    gateway: input.gateway ?? "shopify_payments",
    manualPaymentGateway: false,
    createdAt: input.processedAt ?? "2026-10-05T09:00:00Z",
    processedAt: input.processedAt ?? "2026-10-05T09:00:00Z",
    parentTransaction: null,
    amountSet: bag(input.amount, input.currency ?? "EUR"),
    settlementCurrency: null,
    settlementCurrencyRate: null,
    currencyExchangeAdjustment: null,
    fees: input.fees ?? [],
  };
}

export function fee(amount: string, over: Partial<NonNullable<GqlFinanceTransaction["fees"]>[number]> = {}): NonNullable<GqlFinanceTransaction["fees"]>[number] {
  return {
    id: `gid://shopify/TransactionFee/${nextId()}`,
    type: "payment",
    amount: mv2(amount),
    flatFee: mv2("0.30"),
    rate: "0.029",
    rateName: "Online",
    taxAmount: mv2("0.00"),
    ...over,
  };
}

export function refund(input: { amount: string; currency?: string; processedAt?: string; lines?: FixtureRefund["lines"]; id?: string }): FixtureRefund {
  return {
    id: input.id ?? `gid://shopify/Refund/${nextId()}`,
    createdAt: input.processedAt ?? "2026-11-04T10:00:00Z",
    processedAt: input.processedAt ?? "2026-11-04T10:00:00Z",
    totalRefundedSet: bag(input.amount, input.currency ?? "EUR"),
    lines: input.lines ?? [],
  };
}

export function refundLine(lineItem: string, quantity: number, restockType: "RETURN" | "NO_RESTOCK" | "CANCEL" | "LEGACY_RESTOCK", restocked: boolean, subtotal = "0.00") {
  return { quantity, restockType, restocked, lineItem: { id: lineItem }, subtotalSet: bag(subtotal) };
}

type Totals = Partial<Record<FinanceTotalField, GqlMoneyBag | null>>;

/** Фінансовий знімок замовлення (OtOrderFinance) з типовими нулями підсумків у валюті магазину. */
export function financeNode(
  gid: string,
  over: Partial<GqlOrderFinanceNode> & { totals?: Totals; currency?: string; presentment?: string } = {},
): GqlOrderFinanceNode {
  const currency = over.currency ?? over.currencyCode ?? "EUR";
  const presentment = over.presentment ?? over.presentmentCurrencyCode ?? currency;
  const zero = bag("0.00", currency, "0.00", presentment);
  const totals: Record<FinanceTotalField, GqlMoneyBag | null> = {
    totalPriceSet: zero,
    currentTotalPriceSet: zero,
    currentTotalTaxSet: zero,
    currentTotalDiscountsSet: zero,
    currentShippingPriceSet: zero,
    totalRefundedSet: zero,
    totalRefundedShippingSet: zero,
    totalReceivedSet: zero,
    netPaymentSet: zero,
    totalTipReceivedSet: zero,
    currentTotalDutiesSet: null,
    totalOutstandingSet: zero,
    ...(over.totals ?? {}),
  };
  const { totals: _t, currency: _c, presentment: _p, ...rest } = over;
  return {
    id: gid,
    updatedAt: "2026-10-05T10:00:00Z",
    createdAt: "2026-10-05T09:00:00Z",
    processedAt: "2026-10-05T09:00:00Z",
    cancelledAt: null,
    test: false,
    edited: false,
    taxesIncluded: false,
    currencyCode: currency,
    presentmentCurrencyCode: presentment,
    displayFinancialStatus: "PAID",
    returnStatus: "NO_RETURN",
    paymentGatewayNames: ["shopify_payments"],
    discountCodes: [],
    customerJourneySummary: { ready: true, lastVisit: { referralCode: null } },
    disputes: [],
    shippingLines: { nodes: [] },
    transactions: [],
    transactionsCount: null,
    fulfillments: [],
    ...totals,
    ...rest,
  } as GqlOrderFinanceNode;
}

/**
 * Золотий G2 (docs/stage6-design.md §20.1): DE, ціни з податком 19 %: товар totalAmount 59,50 (податок 9,50), доставка
 * 10,00 (податок 1,60), оплачено 69,50; currentTotalTaxSet 9,50 — податок лише позицій (RC4 — без розбіжності).
 */
export function g2Fixture(gid: string, lineItemGid = "gid://shopify/LineItem/92011"): FinanceOrderFixture {
  return {
    finance: financeNode(gid, {
      taxesIncluded: true,
      totals: {
        totalPriceSet: bag("69.50"),
        currentTotalPriceSet: bag("69.50"),
        currentTotalTaxSet: bag("9.50"),
        currentShippingPriceSet: bag("10.00"),
        totalReceivedSet: bag("69.50"),
        netPaymentSet: bag("69.50"),
      },
      transactions: [transaction({ amount: "69.50", fees: [fee("2.32")] })],
    }),
    agreements: [
      agreement("OrderAgreement", "2026-10-05T09:00:00Z", [
        sale({ lineType: "PRODUCT", total: "59.50", tax: "9.50", discount: "0.00", lineItem: lineItemGid }),
        sale({ lineType: "SHIPPING", total: "10.00", tax: "1.60", discount: "0.00" }),
      ]),
    ],
    refunds: [],
  };
}

export interface FakeFinanceAdmin {
  admin: AdminGraphql;
  calls: Array<{ op: string; variables?: Record<string, unknown>; cost: number }>;
  /** Викликається перед кожною відповіддю (напр. змінити замовлення між сторінками). */
  beforeResponse: ((op: string, variables: Record<string, unknown> | undefined) => void) | null;
  /** Помилка для наступного виклику операції. */
  failNext: (op: string, error: Error) => void;
  ops: () => string[];
}

function page<T>(all: readonly T[], size: number, after: unknown) {
  const start = typeof after === "string" && after ? Number(after) : 0;
  const next = start + size;
  return { nodes: all.slice(start, next), pageInfo: { hasNextPage: next < all.length, endCursor: next < all.length ? String(next) : null } };
}

function salesPage(sales: readonly FixtureSale[], size: number, after: unknown) {
  return page(sales, size, after);
}

/**
 * Імітація Admin GraphQL фінансових операцій. `fallback` — інша імітація (напр. етапу 2) для решти операцій.
 * Перевіряє вартість кожного запиту оцінювачем (≤ 950) з фактичними змінними виклику.
 */
export function fakeFinanceAdmin(store: Map<string, FinanceOrderFixture>, fallback?: AdminGraphql): FakeFinanceAdmin {
  const calls: FakeFinanceAdmin["calls"] = [];
  const failures = new Map<string, Error>();
  const api: FakeFinanceAdmin = {
    admin: null as unknown as AdminGraphql,
    calls,
    beforeResponse: null,
    failNext: (op, error) => failures.set(op, error),
    ops: () => calls.map((c) => c.op),
  };
  const admin: AdminGraphql = async <T,>(query: string, variables?: Record<string, unknown>): Promise<T> => {
    const op = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
    const finance = ["OtOrderFinance", "OtOrderAgreements", "OtAgreementSales", "OtOrderRefunds", "OtOrdersUpdatedSince"].includes(op);
    if (!finance) {
      if (!fallback) throw new Error(`unexpected op ${op}`);
      return fallback<T>(query, variables);
    }
    const cost = requestedQueryCost(query, variables);
    if (cost > QUERY_COST_BUDGET) throw new Error(`${op} requested cost ${cost} > ${QUERY_COST_BUDGET}`);
    calls.push({ op, variables, cost });
    const failure = failures.get(op);
    if (failure) {
      failures.delete(op);
      throw failure;
    }
    api.beforeResponse?.(op, variables);
    const fx = store.get(String(variables?.id));
    let data: unknown;
    switch (op) {
      case "OtOrderFinance": {
        if (!fx) {
          data = { order: null };
          break;
        }
        const transactions = fx.finance.transactions ?? [];
        data = {
          order: {
            ...fx.finance,
            transactions: transactions.slice(0, FINANCE_TRANSACTIONS_PAGE),
            transactionsCount: { count: fx.transactionsTotal ?? transactions.length },
          },
        };
        break;
      }
      case "OtOrderAgreements": {
        if (!fx) {
          data = { order: null };
          break;
        }
        const p = page(fx.agreements, FINANCE_AGREEMENTS_PAGE, variables?.after);
        data = {
          order: {
            id: fx.finance.id,
            updatedAt: fx.finance.updatedAt,
            agreements: {
              pageInfo: p.pageInfo,
              nodes: p.nodes.map((a) => ({ ...a, sales: salesPage(a.sales, FINANCE_AGREEMENT_SALES_PAGE, null) })),
            },
          },
        };
        break;
      }
      case "OtAgreementSales": {
        if (!fx) {
          data = { order: null };
          break;
        }
        const numeric = /^id:(\d+)$/.exec(String(variables?.agreementQuery))?.[1];
        const a = fx.agreements.find((x) => x.id.endsWith(`/${numeric}`));
        // Курсор першої сторінки угоди (15) — "15"; далі сторінки по 50 від позиції курсора.
        data = {
          order: {
            id: fx.finance.id,
            updatedAt: fx.finance.updatedAt,
            agreements: { nodes: a ? [{ id: a.id, sales: salesPage(a.sales, FINANCE_AGREEMENT_SALES_MORE_PAGE, variables?.after) }] : [] },
          },
        };
        break;
      }
      case "OtOrderRefunds": {
        if (!fx) {
          data = { order: null };
          break;
        }
        data = {
          order: {
            id: fx.finance.id,
            updatedAt: fx.finance.updatedAt,
            totalRefundedSet: fx.finance.totalRefundedSet,
            refunds: fx.refunds.slice(0, FINANCE_REFUNDS_PAGE).map((r) => ({
              id: r.id,
              createdAt: r.createdAt,
              processedAt: r.processedAt,
              totalRefundedSet: r.totalRefundedSet,
              refundLineItems: {
                pageInfo: { hasNextPage: r.lines.length > FINANCE_REFUND_LINES_PAGE },
                nodes: r.lines.slice(0, FINANCE_REFUND_LINES_PAGE),
              },
            })),
          },
        };
        break;
      }
      case "OtOrdersUpdatedSince": {
        const since = /updated_at:>='([^']+)'/.exec(String(variables?.query))?.[1];
        const from = since ? Date.parse(since) : 0;
        const all = [...store.values()]
          .map((f) => ({ id: f.finance.id, updatedAt: f.finance.updatedAt, test: f.finance.test }))
          .filter((n) => Date.parse(n.updatedAt) >= from)
          .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id.localeCompare(b.id));
        data = { orders: page(all, FINANCE_RECONCILE_PAGE, variables?.after) };
        break;
      }
    }
    return structuredClone(data) as T;
  };
  api.admin = admin;
  return api;
}

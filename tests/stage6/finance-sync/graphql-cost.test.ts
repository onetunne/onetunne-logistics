/**
 * Етап 6 (WP3): точна запитувана вартість фінансових документів (docs/stage6-design.md §16.2) — формули закріплено
 * константами сторінок (оцінювач tests/helpers/shopify-query-cost.ts; ліміт застосунку 950, Shopify — 1000), розміри
 * ВБУДОВАНО в документи, змінні — лише id / курсори / рядок пошуку; персональні поля не вибираються (F9).
 */
import { describe, expect, it } from "vitest";
import {
  AGREEMENT_SALES_QUERY,
  FINANCE_AGREEMENTS_PAGE,
  FINANCE_AGREEMENT_SALES_MORE_PAGE,
  FINANCE_AGREEMENT_SALES_PAGE,
  FINANCE_FULFILLMENTS_PAGE,
  FINANCE_QUERY_COST_ESTIMATES,
  FINANCE_RECONCILE_PAGE,
  FINANCE_REFUNDS_PAGE,
  FINANCE_REFUND_LINES_PAGE,
  FINANCE_SHIPPING_LINES_PAGE,
  FINANCE_TOTAL_FIELDS,
  FINANCE_TRACKING_PAGE,
  FINANCE_TRANSACTIONS_PAGE,
  ORDERS_UPDATED_SINCE_QUERY,
  ORDER_AGREEMENTS_QUERY,
  ORDER_FINANCE_QUERY,
  ORDER_REFUNDS_QUERY,
  agreementIdQuery,
  updatedSinceQuery,
} from "~/integrations/shopify/finance-graphql";
import { ORDERS_PAGE_QUERY, ORDER_QUERY } from "~/integrations/shopify/graphql";
import { QUERY_COST_BUDGET, operationName, requestedQueryCost } from "../../helpers/shopify-query-cost";

const ID = "gid://shopify/Order/1";
/** MoneyBag {shopMoney, presentmentMoney} = 3; MoneyV2 = 1. */
const MB = 3;
const MV2 = 1;

describe("exact requested cost of each finance document", () => {
  it("OtOrderFinance = 382 (without transactionsCount and fulfillments — 299)", () => {
    const totals = FINANCE_TOTAL_FIELDS.length * MB; // 12 MoneyBag
    const journey = 1 + 1; // customerJourneySummary + lastVisit
    const disputes = 1; // список без розміру — один об'єкт (можливе заниження, §16.2)
    const shippingLines = 2 + FINANCE_SHIPPING_LINES_PAGE * (1 + MB + MB);
    const transaction = 1 + 1 /* parentTransaction */ + MB /* amountSet */ + (1 + MV2) /* currencyExchangeAdjustment */ + (1 + 3 * MV2); /* fees */
    const transactions = 2 + FINANCE_TRANSACTIONS_PAGE * transaction;
    const count = 1;
    const fulfillments = 2 + FINANCE_FULFILLMENTS_PAGE * (1 + (2 + FINANCE_TRACKING_PAGE * 1));
    const formula = 1 + totals + journey + disputes + shippingLines + transactions + count + fulfillments;
    expect(formula).toBe(382);
    expect(formula - count - fulfillments).toBe(299);
    expect(requestedQueryCost(ORDER_FINANCE_QUERY, { id: ID })).toBe(formula);
  });

  it("OtOrderAgreements = 558", () => {
    const sale = 1 + 3 * MB + 1; // вузол + totalAmount/totalTaxAmount/totalDiscountAmountBeforeTaxes + ProductSale.lineItem
    const sales = 2 + FINANCE_AGREEMENT_SALES_PAGE * (1 /* pageInfo */ + sale);
    const agreement = 1 + 1 /* RefundAgreement.refund */ + sales;
    const formula = 1 + (2 + FINANCE_AGREEMENTS_PAGE * (1 /* pageInfo */ + agreement));
    expect(formula).toBe(558);
    expect(requestedQueryCost(ORDER_AGREEMENTS_QUERY, { id: ID, after: "c1" })).toBe(formula);
  });

  it("OtAgreementSales = 606", () => {
    const sale = 1 + 3 * MB + 1;
    const sales = 2 + FINANCE_AGREEMENT_SALES_MORE_PAGE * (1 + sale);
    const formula = 1 + (2 + 1 * (1 + sales));
    expect(formula).toBe(606);
    expect(requestedQueryCost(AGREEMENT_SALES_QUERY, { id: ID, agreementQuery: "id:1", after: "c1" })).toBe(formula);
  });

  it("OtOrderRefunds = 666", () => {
    const line = 1 + 1 /* lineItem */ + MB;
    const lines = 2 + FINANCE_REFUND_LINES_PAGE * (1 /* pageInfo */ + line);
    const refund = 1 + MB + lines;
    const formula = 1 + MB + (2 + FINANCE_REFUNDS_PAGE * refund);
    expect(formula).toBe(666);
    expect(requestedQueryCost(ORDER_REFUNDS_QUERY, { id: ID })).toBe(formula);
  });

  it("OtOrdersUpdatedSince = 102", () => {
    const formula = 2 + FINANCE_RECONCILE_PAGE * (1 + 1);
    expect(formula).toBe(102);
    expect(requestedQueryCost(ORDERS_UPDATED_SINCE_QUERY, { query: updatedSinceQuery(new Date("2026-11-01T00:00:00Z")), after: null })).toBe(formula);
  });

  it("matches the core estimates, stays ≤ 950; stage-2 documents are unchanged (461 / 737)", () => {
    const docs = { OtOrderFinance: ORDER_FINANCE_QUERY, OtOrderAgreements: ORDER_AGREEMENTS_QUERY, OtAgreementSales: AGREEMENT_SALES_QUERY, OtOrderRefunds: ORDER_REFUNDS_QUERY, OtOrdersUpdatedSince: ORDERS_UPDATED_SINCE_QUERY };
    const vars: Record<string, Record<string, unknown>> = {
      OtOrderFinance: { id: ID },
      OtOrderAgreements: { id: ID, after: null },
      OtAgreementSales: { id: ID, agreementQuery: "id:1", after: null },
      OtOrderRefunds: { id: ID },
      OtOrdersUpdatedSince: { query: "updated_at:>='2026-01-01T00:00:00Z'", after: null },
    };
    for (const [name, doc] of Object.entries(docs)) {
      expect(operationName(doc)).toBe(name);
      const cost = requestedQueryCost(doc, vars[name]);
      expect(cost).toBe(FINANCE_QUERY_COST_ESTIMATES[name as keyof typeof FINANCE_QUERY_COST_ESTIMATES]);
      expect(cost).toBeLessThanOrEqual(QUERY_COST_BUDGET);
      // Розміри сторінок вбудовано: документ не має змінних first/last.
      expect(doc).not.toMatch(/\$first|\$last/);
    }
    expect(requestedQueryCost(ORDER_QUERY, { id: ID })).toBe(461);
    expect(requestedQueryCost(ORDERS_PAGE_QUERY, { first: 5, after: null, query: "x" })).toBe(737);
    // Бюджет синхронізації одного замовлення (§16.2): без повернень ≈ 940, з поверненнями ≈ 1 606.
    expect(FINANCE_QUERY_COST_ESTIMATES.OtOrderFinance + FINANCE_QUERY_COST_ESTIMATES.OtOrderAgreements).toBe(940);
    expect(FINANCE_QUERY_COST_ESTIMATES.OtOrderFinance + FINANCE_QUERY_COST_ESTIMATES.OtOrderAgreements + FINANCE_QUERY_COST_ESTIMATES.OtOrderRefunds).toBe(1606);
  });
});

describe("no personal data is selected (F9, §16.2)", () => {
  it.each([
    ["OtOrderFinance", ORDER_FINANCE_QUERY],
    ["OtOrderAgreements", ORDER_AGREEMENTS_QUERY],
    ["OtAgreementSales", AGREEMENT_SALES_QUERY],
    ["OtOrderRefunds", ORDER_REFUNDS_QUERY],
    ["OtOrdersUpdatedSince", ORDERS_UPDATED_SINCE_QUERY],
  ])("%s", (_name, doc) => {
    for (const field of ["phone", "email", "Address", "address1", "accountNumber", "receiptJson", "paymentDetails", "note", "staffMember", "customer {", "customerNote", "returnReasonNote", "return {", "evidence", "firstName", "lastName"]) {
      expect(doc, field).not.toContain(field);
    }
  });
});

describe("query strings", () => {
  it("updated_at search and agreement id search", () => {
    expect(updatedSinceQuery(new Date("2026-11-28T10:11:12.345Z"))).toBe("updated_at:>='2026-11-28T10:11:12Z'");
    expect(agreementIdQuery("gid://shopify/SalesAgreement/123456")).toBe("id:123456");
    expect(agreementIdQuery("gid://shopify/SalesAgreement/x")).toBeNull();
  });
});

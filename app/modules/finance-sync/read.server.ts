/**
 * Етап 6 (WP3): читання фінансових документів замовлення з Admin API (docs/stage6-design.md §16.2, §16.3). Лише читання —
 * у Shopify нічого не записується (F11). Нічого не обрізається мовчки:
 * - угоди — усі сторінки (OtOrderAgreements, по FINANCE_AGREEMENTS_PAGE), продажі угоди понад першу сторінку —
 *   OtAgreementSales (по FINANCE_AGREEMENT_SALES_MORE_PAGE);
 * - замовлення змінилося між сторінками (updatedAt) або зникло → повторювана помилка (завдання повториться зі свіжими
 *   даними); відповідь без курсора → неповторювана помилка відповіді; понад межу сторінок → неповторювана помилка
 *   (замовлення — вручну), як readAllLineItems етапу 2;
 * - транзакції — лише перші FINANCE_TRANSACTIONS_PAGE (список без pageInfo): обрізання видно з transactionsCount.
 * Бюджет (§16.2): ≈ 940 балів на замовлення без повернень, ≈ 1 606 з поверненнями, + 606 за кожну додаткову сторінку
 * продажів; THROTTLED повторюється через ShopifyApiError.retryable.
 */
import {
  AGREEMENT_SALES_QUERY,
  ORDER_AGREEMENTS_QUERY,
  ORDER_FINANCE_QUERY,
  ORDER_REFUNDS_QUERY,
  agreementIdQuery,
  type GqlAgreement,
  type GqlAgreementSales,
  type GqlOrderAgreements,
  type GqlOrderFinance,
  type GqlOrderFinanceNode,
  type GqlOrderRefunds,
  type GqlRefund,
  type GqlSale,
} from "~/integrations/shopify/finance-graphql";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";

/** Межа сторінок угод одного замовлення (20 × 3 = 60 угод). */
export const MAX_AGREEMENT_PAGES = 20;
/** Межа додаткових сторінок продажів однієї угоди (20 × 50 = 1 000 продажів понад перші 15). */
export const MAX_AGREEMENT_SALES_PAGES = 20;

export async function readOrderFinance(admin: AdminGraphql, orderGid: string): Promise<GqlOrderFinanceNode | null> {
  const data = await admin<GqlOrderFinance>(ORDER_FINANCE_QUERY, { id: orderGid });
  return data.order ?? null;
}

function changed(): ShopifyApiError {
  return new ShopifyApiError("Shopify order changed while its finance data were being read", true, "ORDER_CHANGED_DURING_READ");
}

function sameUpdatedAt(a: string, b: string): boolean {
  const x = Date.parse(a);
  const y = Date.parse(b);
  return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b;
}

/**
 * Усі угоди замовлення з усіма продажами. expectedUpdatedAt — Order.updatedAt з OtOrderFinance того самого читання:
 * інший — замовлення змінилося під час читання (повторювана помилка).
 */
export async function readAllAgreements(admin: AdminGraphql, orderGid: string, expectedUpdatedAt: string): Promise<GqlAgreement[]> {
  const out: GqlAgreement[] = [];
  let after: string | null = null;
  for (let page = 0; ; page++) {
    if (page >= MAX_AGREEMENT_PAGES) {
      throw new ShopifyApiError("Too many sales agreements on one order", false, "TOO_MANY_AGREEMENTS");
    }
    const data: GqlOrderAgreements = await admin<GqlOrderAgreements>(ORDER_AGREEMENTS_QUERY, { id: orderGid, after });
    if (!data.order) throw changed();
    if (!sameUpdatedAt(data.order.updatedAt, expectedUpdatedAt)) throw changed();
    const conn = data.order.agreements;
    if (!conn || !Array.isArray(conn.nodes)) throw new ShopifyApiError("Shopify returned an invalid agreements page", false, "FINANCE_RESPONSE_INVALID");
    for (const agreement of conn.nodes) out.push(await completeSales(admin, orderGid, expectedUpdatedAt, agreement));
    if (!conn.pageInfo?.hasNextPage) break;
    if (!conn.pageInfo.endCursor) throw new ShopifyApiError("Shopify returned an incomplete agreements page (no cursor)", false, "INCOMPLETE_AGREEMENTS");
    after = conn.pageInfo.endCursor;
  }
  return out;
}

/** Продажі угоди понад першу сторінку — OtAgreementSales; результат — угода з усіма продажами (pageInfo без продовження). */
async function completeSales(admin: AdminGraphql, orderGid: string, expectedUpdatedAt: string, agreement: GqlAgreement): Promise<GqlAgreement> {
  let info = agreement?.sales?.pageInfo;
  if (!info?.hasNextPage) return agreement;
  const nodes: GqlSale[] = [...(agreement.sales.nodes ?? [])];
  const query = agreementIdQuery(agreement.id);
  if (!query) throw new ShopifyApiError("Agreement id without a numeric part", false, "FINANCE_RESPONSE_INVALID");
  for (let page = 0; info?.hasNextPage; page++) {
    if (page >= MAX_AGREEMENT_SALES_PAGES) throw new ShopifyApiError("Too many sales on one agreement", false, "TOO_MANY_SALES");
    if (!info.endCursor) throw new ShopifyApiError("Shopify returned an incomplete sales page (no cursor)", false, "INCOMPLETE_SALES");
    const data: GqlAgreementSales = await admin<GqlAgreementSales>(AGREEMENT_SALES_QUERY, { id: orderGid, agreementQuery: query, after: info.endCursor });
    if (!data.order || !sameUpdatedAt(data.order.updatedAt, expectedUpdatedAt)) throw changed();
    const match = data.order.agreements?.nodes?.find((a) => a.id === agreement.id);
    if (!match) throw changed();
    nodes.push(...(match.sales.nodes ?? []));
    info = match.sales.pageInfo;
  }
  return { ...agreement, sales: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
}

export async function readOrderRefunds(
  admin: AdminGraphql,
  orderGid: string,
  expectedUpdatedAt: string,
): Promise<{ totalRefundedSet: unknown; refunds: GqlRefund[] | null }> {
  const data = await admin<GqlOrderRefunds>(ORDER_REFUNDS_QUERY, { id: orderGid });
  if (!data.order || !sameUpdatedAt(data.order.updatedAt, expectedUpdatedAt)) throw changed();
  return { totalRefundedSet: data.order.totalRefundedSet, refunds: data.order.refunds };
}

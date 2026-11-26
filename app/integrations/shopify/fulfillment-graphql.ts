/**
 * GraphQL Admin API 2026-10: виконання замовлення з трек-номером (merchant-managed fulfillment).
 * Звірено з документацією shopify.dev (fulfillmentCreate, FulfillmentInput, FulfillmentTrackingInput,
 * FulfillmentOrder, Order.fulfillmentOrders / Order.fulfillments):
 * - потрібен дозвіл write_merchant_managed_fulfillment_orders (write включає read);
 * - notifyCustomer за замовчуванням false; ідемпотентного ключа в fulfillmentCreate немає →
 *   перед кожною спробою застосунок перечитує стан fulfillment orders (виконане FO закривається або має залишок 0);
 * - Nova Post немає в списку перевізників Shopify → company — довільний текст, посилання — у url.
 * Персональні дані (адреса призначення FulfillmentOrder.destination) НЕ запитуються.
 *
 * Вартість запиту (документація rate-limits: об'єкт — 1, список/з'єднання — 2 + first × вартість вузла,
 * ліміт одного запиту — 1000 балів, перевіряється ДО виконання): розміри сторінок нижче дають ≈ 550 балів навіть за
 * консервативною оцінкою (перевіряє tests/stage3/fulfillment.test.ts; попередні 25 × 100 давали ≈ 3000). fulfillmentOrders гортаються сторінками ($after);
 * якщо в FO більше позицій, ніж на сторінці, — pageInfo.hasNextPage (fulfillmentCreate без переліку позицій
 * виконує весь залишок FO, тож самі позиції перечитувати не потрібно).
 */

export const FULFILLMENT_ORDERS_PAGE_SIZE = 10;
export const FULFILLMENT_ORDER_LINE_ITEMS_PAGE_SIZE = 20;

export const ORDER_FULFILLMENT_STATE_QUERY = `#graphql
  query OtOrderFulfillmentState($id: ID!, $after: String) {
    order(id: $id) {
      id
      displayFulfillmentStatus
      fulfillments(first: 10) {
        id
        status
        trackingInfo(first: 5) { number }
      }
      fulfillmentOrders(first: ${FULFILLMENT_ORDERS_PAGE_SIZE}, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          status
          supportedActions { action }
          assignedLocation { location { id } }
          lineItems(first: ${FULFILLMENT_ORDER_LINE_ITEMS_PAGE_SIZE}) {
            pageInfo { hasNextPage }
            nodes { id remainingQuantity }
          }
        }
      }
    }
  }`;

export const FULFILLMENT_CREATE_MUTATION = `#graphql
  mutation OtFulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment { id status trackingInfo(first: 10) { company number url } }
      userErrors { field message }
    }
  }`;

export interface GqlFulfillmentOrder {
  id: string;
  status: string;
  supportedActions: { action: string }[];
  assignedLocation: { location: { id: string } | null } | null;
  lineItems: { pageInfo?: { hasNextPage: boolean }; nodes: { id: string; remainingQuantity: number }[] };
}

export interface GqlOrderFulfillmentState {
  order: {
    id: string;
    displayFulfillmentStatus: string;
    fulfillments: { id: string; status: string; trackingInfo: { number: string | null }[] }[];
    fulfillmentOrders: { pageInfo?: { hasNextPage: boolean; endCursor: string | null }; nodes: GqlFulfillmentOrder[] };
  } | null;
}

export interface GqlFulfillmentCreateResult {
  fulfillmentCreate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

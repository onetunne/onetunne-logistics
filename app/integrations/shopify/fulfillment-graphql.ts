/**
 * GraphQL Admin API 2026-10: виконання замовлення з трек-номером (merchant-managed fulfillment).
 * Звірено з документацією shopify.dev (fulfillmentCreate, FulfillmentInput, FulfillmentTrackingInput,
 * FulfillmentOrder, Order.fulfillmentOrders / Order.fulfillments):
 * - потрібен дозвіл write_merchant_managed_fulfillment_orders (write включає read);
 * - notifyCustomer за замовчуванням false; ідемпотентного ключа в fulfillmentCreate немає →
 *   перед повтором застосунок сам перевіряє наявні виконання (Order.fulfillments.trackingInfo);
 * - Nova Post немає в списку перевізників Shopify → company — довільний текст, посилання — у url.
 * Персональні дані (адреса призначення FulfillmentOrder.destination) НЕ запитуються.
 */

export const ORDER_FULFILLMENT_STATE_QUERY = `#graphql
  query OtOrderFulfillmentState($id: ID!) {
    order(id: $id) {
      id
      displayFulfillmentStatus
      fulfillments(first: 25) {
        id
        status
        trackingInfo(first: 10) { number }
      }
      fulfillmentOrders(first: 25) {
        nodes {
          id
          status
          supportedActions { action }
          assignedLocation { location { id } }
          lineItems(first: 100) { nodes { id remainingQuantity } }
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
  lineItems: { nodes: { id: string; remainingQuantity: number }[] };
}

export interface GqlOrderFulfillmentState {
  order: {
    id: string;
    displayFulfillmentStatus: string;
    fulfillments: { id: string; status: string; trackingInfo: { number: string | null }[] }[];
    fulfillmentOrders: { nodes: GqlFulfillmentOrder[] };
  } | null;
}

export interface GqlFulfillmentCreateResult {
  fulfillmentCreate: {
    fulfillment: { id: string; status: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
}

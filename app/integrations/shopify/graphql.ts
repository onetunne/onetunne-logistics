/**
 * Запити GraphQL Admin API (версія 2026-10). Поля звірено з офіційною документацією shopify.dev
 * (Order, LineItem, ProductVariant, Product, InventoryItem, MailingAddress, OrderInput, MailingAddressInput).
 * Митний опис: метаполе товару `logistics.customs_description` (див. docs/shopify-test-server.md).
 */

const MONEY = "shopMoney { amount currencyCode }";
const ADDRESS = "firstName lastName company address1 address2 city province provinceCode zip countryCodeV2 phone";

export const ORDER_FIELDS = `
  id legacyResourceId name email phone createdAt updatedAt processedAt cancelledAt test note
  displayFinancialStatus displayFulfillmentStatus currencyCode
  subtotalPriceSet { ${MONEY} }
  totalPriceSet { ${MONEY} }
  totalShippingPriceSet { ${MONEY} }
  shippingAddress { ${ADDRESS} }
  billingAddress { countryCodeV2 }
  lineItems(first: 100) {
    nodes {
      id title variantTitle sku quantity
      originalUnitPriceSet { ${MONEY} }
      image { url }
      variant { id product { id } }
    }
  }
`;

export const ORDER_QUERY = `#graphql
  query OtOrder($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } }`;

export const ORDERS_PAGE_QUERY = `#graphql
  query OtOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${ORDER_FIELDS} }
    }
  }`;

export const PRODUCT_FIELDS = `
  id title handle status updatedAt
  featuredMedia { preview { image { url } } }
  customsDescription: metafield(namespace: "logistics", key: "customs_description") { value }
  variants(first: 100) {
    nodes {
      id title sku barcode price inventoryQuantity
      selectedOptions { name value }
      image { url }
      inventoryItem {
        id harmonizedSystemCode countryCodeOfOrigin
        measurement { weight { unit value } }
      }
    }
  }
`;

export const PRODUCT_QUERY = `#graphql
  query OtProduct($id: ID!) { product(id: $id) { ${PRODUCT_FIELDS} } }`;

export const PRODUCTS_PAGE_QUERY = `#graphql
  query OtProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }`;

export const INVENTORY_ITEM_PRODUCT_QUERY = `#graphql
  query OtInventoryItem($id: ID!) { inventoryItem(id: $id) { id variant { id product { id } } } }`;

export const ORDER_UPDATE_MUTATION = `#graphql
  mutation OtOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id updatedAt }
      userErrors { field message }
    }
  }`;

export const SHOP_CURRENCY_QUERY = `#graphql
  query OtShop { shop { currencyCode } }`;

// --- Типи відповідей (лише поля, які ми запитуємо) ---

export interface GqlMoney {
  shopMoney: { amount: string; currencyCode: string };
}

export interface GqlAddress {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  address1: string | null;
  address2: string | null;
  city: string | null;
  province: string | null;
  provinceCode: string | null;
  zip: string | null;
  countryCodeV2: string | null;
  phone: string | null;
}

export interface GqlOrder {
  id: string;
  legacyResourceId: string;
  name: string;
  email: string | null;
  phone: string | null;
  createdAt: string;
  updatedAt: string;
  processedAt: string | null;
  cancelledAt: string | null;
  test: boolean;
  note: string | null;
  displayFinancialStatus: string | null;
  displayFulfillmentStatus: string | null;
  currencyCode: string;
  subtotalPriceSet: GqlMoney | null;
  totalPriceSet: GqlMoney;
  totalShippingPriceSet: GqlMoney | null;
  shippingAddress: GqlAddress | null;
  billingAddress: { countryCodeV2: string | null } | null;
  lineItems: {
    nodes: Array<{
      id: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      quantity: number;
      originalUnitPriceSet: GqlMoney;
      image: { url: string } | null;
      variant: { id: string; product: { id: string } | null } | null;
    }>;
  };
}

export interface GqlVariant {
  id: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  price: string;
  inventoryQuantity: number | null;
  selectedOptions: Array<{ name: string; value: string }>;
  image: { url: string } | null;
  inventoryItem: {
    id: string;
    harmonizedSystemCode: string | null;
    countryCodeOfOrigin: string | null;
    measurement: { weight: { unit: string; value: number } | null } | null;
  } | null;
}

export interface GqlProduct {
  id: string;
  title: string;
  handle: string;
  status: string;
  updatedAt: string;
  featuredMedia: { preview: { image: { url: string } | null } | null } | null;
  customsDescription: { value: string } | null;
  variants: { nodes: GqlVariant[] };
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/**
 * Запити GraphQL Admin API (версія 2026-10). Поля звірено з офіційною документацією shopify.dev
 * (Order, LineItem, ProductVariant, Product, InventoryItem, MailingAddress, OrderInput, MailingAddressInput).
 * Митний опис: метаполе товару `logistics.customs_description` (див. docs/shopify-test-server.md);
 * необов'язкові `logistics.customs_description_uk` (опис українською) і `logistics.material` (матеріал англійською).
 */

const MONEY = "shopMoney { amount currencyCode }";
const ADDRESS = "firstName lastName company address1 address2 city province provinceCode zip countryCodeV2 phone";

/**
 * Розміри сторінок обрано так, щоб запитувана вартість запиту не перевищувала ліміт 1000 балів
 * (вкладені списки множать вартість). Якщо в замовленні/товарі більше позицій, ніж на сторінці,
 * воно перечитується окремим запитом із більшим лімітом.
 */
const orderFields = (lineItemsFirst: number) => `
  id legacyResourceId name email phone createdAt updatedAt processedAt cancelledAt test note
  displayFinancialStatus displayFulfillmentStatus currencyCode
  subtotalPriceSet { ${MONEY} }
  totalPriceSet { ${MONEY} }
  totalShippingPriceSet { ${MONEY} }
  shippingAddress { ${ADDRESS} }
  billingAddress { countryCodeV2 }
  lineItems(first: ${lineItemsFirst}) {
    pageInfo { hasNextPage }
    nodes {
      id createdAt title variantTitle sku quantity currentQuantity unfulfilledQuantity requiresShipping
      originalUnitPriceSet { ${MONEY} }
      image { url }
      variant { id product { id } }
    }
  }
`;

export const ORDER_QUERY = `#graphql
  query OtOrder($id: ID!) { order(id: $id) { ${orderFields(100)} } }`;

export const ORDERS_PAGE_QUERY = `#graphql
  query OtOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${orderFields(15)} }
    }
  }`;

const productFields = (variantsFirst: number) => `
  id title handle status updatedAt
  featuredMedia { preview { image { url } } }
  customsDescription: metafield(namespace: "logistics", key: "customs_description") { value }
  customsDescriptionUk: metafield(namespace: "logistics", key: "customs_description_uk") { value }
  material: metafield(namespace: "logistics", key: "material") { value }
  variants(first: ${variantsFirst}) {
    pageInfo { hasNextPage }
    nodes {
      id title sku barcode price inventoryQuantity
      selectedOptions { name value }
      image { url }
      inventoryItem {
        id tracked harmonizedSystemCode countryCodeOfOrigin
        measurement { weight { unit value } }
      }
    }
  }
`;

export const PRODUCT_QUERY = `#graphql
  query OtProduct($id: ID!) { product(id: $id) { ${productFields(200)} } }`;

export const PRODUCTS_PAGE_QUERY = `#graphql
  query OtProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${productFields(30)} }
    }
  }`;

// --- Етап 5: колекції (read_products; поля звірено з shopify.dev 2026-10: Product.collections, QueryRoot.collections,
// QueryRoot.collection, Collection.products — CollectionConnection/ProductConnection з first/after/pageInfo). ---
// Обидва види колекцій (ручні й автоматичні) повертає той самий запит. Вартість запитів невелика (немає вкладених
// варіантів): сторінка членства products(25) × collections(20) ≈ 577 балів < 1000.

const COLLECTION_FIELDS = "id title handle updatedAt";

/** Колекції одного товару (повний перелік — посторінково). */
export const PRODUCT_COLLECTIONS_QUERY = `#graphql
  query OtProductCollections($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      id
      collections(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${COLLECTION_FIELDS} }
      }
    }
  }`;

/** Список колекцій магазину (повна синхронізація: назви й виявлення видалених). */
export const COLLECTIONS_PAGE_QUERY = `#graphql
  query OtCollections($first: Int!, $after: String) {
    collections(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes { ${COLLECTION_FIELDS} }
    }
  }`;

/** Одна колекція з товарами (webhook collections/create|update: ручне додавання/вилучення товарів, зміна умов). */
export const COLLECTION_PRODUCTS_QUERY = `#graphql
  query OtCollection($id: ID!, $first: Int!, $after: String) {
    collection(id: $id) {
      ${COLLECTION_FIELDS}
      products(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }`;

/** Повна синхронізація членства: товари з їхніми колекціями (товар із більшою кількістю — окремим запитом). */
export const PRODUCT_MEMBERSHIPS_PAGE_QUERY = `#graphql
  query OtProductMemberships($first: Int!, $after: String, $collectionsFirst: Int!) {
    products(first: $first, after: $after, sortKey: ID) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        collections(first: $collectionsFirst) {
          pageInfo { hasNextPage endCursor }
          nodes { ${COLLECTION_FIELDS} }
        }
      }
    }
  }`;

export const INVENTORY_ITEM_PRODUCT_QUERY = `#graphql
  query OtInventoryItem($id: ID!) { inventoryItem(id: $id) { id variant { id product { id } } } }`;

export const ORDER_UPDATE_MUTATION = `#graphql
  mutation OtOrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order { id updatedAt shippingAddress { countryCodeV2 zip } }
      userErrors { field message }
    }
  }`;

/** Поточна адреса й спосіб доставки замовлення в Shopify (для діагностики; ПД не логуються). */
export const ORDER_ADDRESS_STATE_QUERY = `#graphql
  query OtOrderAddressState($id: ID!) {
    order(id: $id) {
      id presentmentCurrencyCode
      shippingAddress { countryCodeV2 provinceCode zip phone }
      shippingLine { title source code carrierIdentifier deliveryCategory }
    }
  }`;

/** Країни, у які магазин доставляє (зони доставки). Shopify приймає адресу замовлення лише для цих країн. */
export const SHOP_SHIPPING_COUNTRIES_QUERY = `#graphql
  query OtShopShipping { shop { shipsToCountries countriesInShippingZones { countryCodes includeRestOfWorld } } }`;

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
    pageInfo?: { hasNextPage: boolean };
    nodes: Array<{
      id: string;
      /**
       * Етап 5: коли позицію створено (LineItem.createdAt, DateTime!, 2026-10) — позиція, додана редагуванням замовлення
       * після знімка складу, не отримує корекції знімка. Відсутнє в старих тестових даних.
       */
      createdAt?: string;
      title: string;
      variantTitle: string | null;
      sku: string | null;
      /** Замовлено, разом із поверненими й видаленими одиницями. */
      quantity: number;
      /** Без повернених і видалених одиниць (LineItem.currentQuantity, 2026-10). Відсутнє в старих тестових даних. */
      currentQuantity?: number;
      /**
       * Етап 5: «The number of units not yet fulfilled» (LineItem.unfulfilledQuantity, Int!, 2026-10). Невиконаних не
       * більше, ніж quantity − виконані, тож unfulfilledQuantity ≥ quantity ⇒ жодної одиниці позиції не виконано (за
       * будь-якого врахування повернень). Відсутнє в старих тестових даних.
       */
      unfulfilledQuantity?: number;
      /** Етап 5: «Whether physical shipping is required for the variant» (LineItem.requiresShipping, Boolean!, 2026-10). */
      requiresShipping?: boolean;
      originalUnitPriceSet: GqlMoney;
      image: { url: string } | null;
      /** null — варіант (або товар) видалено в Shopify після замовлення (REST: «can be null if … deleted»). */
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
    tracked?: boolean;
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
  /** Етап 3: необов'язкові метаполя для митних документів (відсутні в старих відповідях/тестах). */
  customsDescriptionUk?: { value: string } | null;
  material?: { value: string } | null;
  variants: { pageInfo?: { hasNextPage: boolean }; nodes: GqlVariant[] };
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export interface GqlCollection {
  id: string;
  title: string;
  handle: string;
  updatedAt: string;
}

export interface GqlCollectionConnection {
  pageInfo: PageInfo;
  nodes: GqlCollection[];
}

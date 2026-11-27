/**
 * Запити GraphQL Admin API (версія 2026-10). Поля звірено з офіційною документацією shopify.dev
 * (Order, LineItem, ProductVariant, Product, InventoryItem, MailingAddress, OrderInput, MailingAddressInput).
 * Митний опис: метаполе товару `logistics.customs_description` (див. docs/shopify-test-server.md);
 * необов'язкові `logistics.customs_description_uk` (опис українською) і `logistics.material` (матеріал англійською).
 */

const MONEY = "shopMoney { amount currencyCode }";
const ADDRESS = "firstName lastName company address1 address2 city province provinceCode zip countryCodeV2 phone";

/**
 * Вартість запитів (shopify.dev, «GraphQL Admin API rate limits»): «A single query may not exceed a cost of 1,000 points,
 * regardless of plan limits. This limit is enforced before a query is executed based on the query's requested cost.»
 * Типові вартості: скаляр/enum — 0, об'єкт — 1, з'єднання — «Sized by `first` and `last` arguments» (вкладені списки
 * множать вартість). Перевищення → помилка MAX_COST_EXCEEDED ще до виконання (усе завдання не виконується).
 * Розміри сторінок нижче експортовано: tests/stage5/shopify-query-cost.test.ts рахує консервативну запитувану вартість
 * КОЖНОГО запиту з цими розмірами (tests/helpers/shopify-query-cost.ts) і вимагає ≤ 950 балів.
 *
 * Нічого не обрізається мовчки: позиції замовлення й варіанти товару, що не вмістилися на першу сторінку, дочитуються
 * наступними сторінками (after) — modules/shopify-sync/sync.server.ts (readAllLineItems, readAllVariants).
 */

/** Позицій замовлення на сторінку (ORDER_QUERY і ORDER_LINE_ITEMS_PAGE_QUERY): ≈ 460 балів. */
export const ORDER_LINE_ITEMS_PAGE_SIZE = 50;
/** Межа сторінок позицій одного замовлення (1000 позицій): більше — помилка замовлення, а не часткові позиції. */
export const ORDER_LINE_ITEMS_MAX_PAGES = 20;
/** Список замовлень (імпорт): замовлень на сторінку × позицій кожного (≈ 740 балів); решта позицій — окремим читанням. */
export const ORDERS_PAGE_SIZE = 5;
export const ORDERS_PAGE_LINE_ITEMS = 15;
/** Варіантів на сторінку (перша — у PRODUCT_QUERY, наступні — PRODUCT_VARIANTS_PAGE_QUERY): ≈ 710 балів. */
export const PRODUCT_VARIANTS_PAGE_SIZE = 100;
/**
 * Product.variants (2026-10): «If querying a single product at the root, you can fetch up to 2048 variants.» —
 * сторінок вистачає на 2048 варіантів; якщо Shopify повертає ще (некоректна відповідь) — перелік вважається неповним.
 */
export const PRODUCT_VARIANTS_MAX_PAGES = Math.ceil(2048 / PRODUCT_VARIANTS_PAGE_SIZE) + 1;
/** Список товарів (повна синхронізація): товарів × варіантів кожного (≈ 750 балів); товар із більшою кількістю — окремо. */
export const PRODUCTS_PAGE_SIZE = 5;
export const PRODUCTS_PAGE_VARIANTS = 20;

/**
 * LineItem (2026-10): discountedUnitPriceAfterAllDiscountsSet — «The approximate unit price of the line item in shop and
 * presentment currencies. This value includes discounts applied to refunded and removed quantities.» (MoneyBag!) —
 * митна вартість одиниці (modules/customs/invoice.ts). Валюта — shopMoney, як і в originalUnitPriceSet та сумах
 * замовлення (orders.currency = totalPriceSet.shopMoney).
 */
const LINE_ITEM_FIELDS = `
  id createdAt title variantTitle sku quantity currentQuantity unfulfilledQuantity requiresShipping
  originalUnitPriceSet { ${MONEY} }
  discountedUnitPriceAfterAllDiscountsSet { ${MONEY} }
  image { url }
  variant { id product { id } }
`;

const orderFields = (lineItemsFirst: number) => `
  id legacyResourceId name email phone createdAt updatedAt processedAt cancelledAt test note
  displayFinancialStatus displayFulfillmentStatus currencyCode
  subtotalPriceSet { ${MONEY} }
  totalPriceSet { ${MONEY} }
  totalShippingPriceSet { ${MONEY} }
  shippingAddress { ${ADDRESS} }
  billingAddress { countryCodeV2 }
  lineItems(first: ${lineItemsFirst}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${LINE_ITEM_FIELDS} }
  }
`;

export const ORDER_QUERY = `#graphql
  query OtOrder($id: ID!) { order(id: $id) { ${orderFields(ORDER_LINE_ITEMS_PAGE_SIZE)} } }`;

/** Наступні сторінки позицій замовлення (Order.lineItems: first/after). updatedAt — перевірка, що замовлення не змінилося. */
export const ORDER_LINE_ITEMS_PAGE_QUERY = `#graphql
  query OtOrderLineItems($id: ID!, $first: Int!, $after: String) {
    order(id: $id) {
      id updatedAt
      lineItems(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${LINE_ITEM_FIELDS} }
      }
    }
  }`;

export const ORDERS_PAGE_QUERY = `#graphql
  query OtOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT) {
      pageInfo { hasNextPage endCursor }
      nodes { ${orderFields(ORDERS_PAGE_LINE_ITEMS)} }
    }
  }`;

const VARIANT_FIELDS = `
  id title sku barcode price inventoryQuantity
  selectedOptions { name value }
  image { url }
  inventoryItem {
    id tracked harmonizedSystemCode countryCodeOfOrigin
    measurement { weight { unit value } }
  }
`;

const productFields = (variantsFirst: number) => `
  id title handle status updatedAt
  featuredMedia { preview { image { url } } }
  customsDescription: metafield(namespace: "logistics", key: "customs_description") { value }
  customsDescriptionUk: metafield(namespace: "logistics", key: "customs_description_uk") { value }
  material: metafield(namespace: "logistics", key: "material") { value }
  variants(first: ${variantsFirst}) {
    pageInfo { hasNextPage endCursor }
    nodes { ${VARIANT_FIELDS} }
  }
`;

export const PRODUCT_QUERY = `#graphql
  query OtProduct($id: ID!) { product(id: $id) { ${productFields(PRODUCT_VARIANTS_PAGE_SIZE)} } }`;

/** Наступні сторінки варіантів товару (Product.variants: first/after). updatedAt — перевірка, що товар не змінився. */
export const PRODUCT_VARIANTS_PAGE_QUERY = `#graphql
  query OtProductVariants($id: ID!, $first: Int!, $after: String) {
    product(id: $id) {
      id updatedAt
      variants(first: $first, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ${VARIANT_FIELDS} }
      }
    }
  }`;

export const PRODUCTS_PAGE_QUERY = `#graphql
  query OtProducts($first: Int!, $after: String) {
    products(first: $first, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ${productFields(PRODUCTS_PAGE_VARIANTS)} }
    }
  }`;

// --- Етап 5: колекції (read_products; поля звірено з shopify.dev 2026-10: Product.collections, QueryRoot.collections,
// QueryRoot.collection, Collection.products — CollectionConnection/ProductConnection з first/after/pageInfo). ---
// Обидва види колекцій (ручні й автоматичні) повертає той самий запит. Розміри сторінок — у
// modules/shopify-sync/collections.server.ts; найдорожча — сторінка членства (товари × колекції), ≈ 680 балів.

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
    /** endCursor — для дочитування наступних сторінок (ORDER_LINE_ITEMS_PAGE_QUERY); відсутній у старих тестових даних. */
    pageInfo?: { hasNextPage: boolean; endCursor?: string | null };
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
      /**
       * Етап 5: «The approximate unit price of the line item in shop and presentment currencies. This value includes
       * discounts applied to refunded and removed quantities.» (LineItem.discountedUnitPriceAfterAllDiscountsSet, 2026-10).
       * Відсутнє в старих тестових даних.
       */
      discountedUnitPriceAfterAllDiscountsSet?: GqlMoney;
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
  variants: { pageInfo?: { hasNextPage: boolean; endCursor?: string | null }; nodes: GqlVariant[] };
}

export interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Відповідь ORDER_LINE_ITEMS_PAGE_QUERY. */
export interface GqlOrderLineItemsPage {
  order: { id: string; updatedAt: string; lineItems: { pageInfo: PageInfo; nodes: GqlOrder["lineItems"]["nodes"] } } | null;
}

/** Відповідь PRODUCT_VARIANTS_PAGE_QUERY. */
export interface GqlProductVariantsPage {
  product: { id: string; updatedAt: string; variants: { pageInfo: PageInfo; nodes: GqlVariant[] } } | null;
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

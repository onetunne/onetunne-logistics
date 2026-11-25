import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";

/** Вигадані дані у форматі відповідей GraphQL Admin API (поля звірено зі схемою 2026-10). */
export function gqlProduct(n = 1, over: Partial<GqlProduct> = {}): GqlProduct {
  return {
    id: `gid://shopify/Product/${n}`,
    title: `Тестовий товар ${n}`,
    handle: `test-${n}`,
    status: "ACTIVE",
    updatedAt: "2026-11-20T10:00:00Z",
    featuredMedia: { preview: { image: { url: `https://cdn.example.com/p${n}.jpg` } } },
    customsDescription: { value: "Scooter accessory" },
    variants: {
      nodes: [
        {
          id: `gid://shopify/ProductVariant/${n}01`,
          title: "Black",
          sku: `SKU-${n}`,
          barcode: null,
          price: "29.9",
          inventoryQuantity: 12,
          selectedOptions: [{ name: "Color", value: "Black" }],
          image: null,
          inventoryItem: {
            id: `gid://shopify/InventoryItem/${n}01`,
            harmonizedSystemCode: "871410",
            countryCodeOfOrigin: "UA",
            measurement: { weight: { unit: "KILOGRAMS", value: 0.25 } },
          },
        },
      ],
    },
    ...over,
  };
}

export function gqlOrder(n = 5001, over: Partial<GqlOrder> = {}): GqlOrder {
  return {
    id: `gid://shopify/Order/${n}`,
    legacyResourceId: String(n),
    name: `#${n}`,
    email: "buyer@example.com",
    phone: null,
    createdAt: "2026-11-20T10:00:00Z",
    updatedAt: "2026-11-20T10:00:00Z",
    processedAt: "2026-11-20T10:00:00Z",
    cancelledAt: null,
    test: true,
    note: null,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    currencyCode: "EUR",
    subtotalPriceSet: { shopMoney: { amount: "29.9", currencyCode: "EUR" } },
    totalPriceSet: { shopMoney: { amount: "41.9", currencyCode: "EUR" } },
    totalShippingPriceSet: { shopMoney: { amount: "12.0", currencyCode: "EUR" } },
    shippingAddress: {
      firstName: "Test",
      lastName: "Buyer",
      company: null,
      address1: "Beispielweg 1",
      address2: null,
      city: "Berlin",
      province: null,
      provinceCode: null,
      zip: "10115",
      countryCodeV2: "DE",
      phone: "+4915123456789",
    },
    billingAddress: { countryCodeV2: "DE" },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${n}1`,
          title: "Тестовий товар 1",
          variantTitle: "Black",
          sku: "SKU-1",
          quantity: 1,
          originalUnitPriceSet: { shopMoney: { amount: "29.9", currencyCode: "EUR" } },
          image: null,
          variant: { id: "gid://shopify/ProductVariant/101", product: { id: "gid://shopify/Product/1" } },
        },
      ],
    },
    ...over,
  };
}

/** Імітація Admin GraphQL: відповідає за назвою операції, записує виклики. */
export function fakeAdmin(store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> }) {
  const calls: Array<{ op: string; variables?: Record<string, unknown> }> = [];
  let updateErrors: Array<{ field: string[] | null; message: string }> = [];
  let shipsTo: string[] = ["DE", "UA", "PT", "US", "FR", "PL"];
  let keepCountry: string | null = null;
  let rejectWhen: ((input: Record<string, any>) => Array<{ field: string[] | null; message: string }>) | null = null;
  const admin: AdminGraphql = async <T,>(query: string, variables?: Record<string, unknown>) => {
    const op = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
    calls.push({ op, variables });
    let data: unknown;
    switch (op) {
      case "OtShop":
        data = { shop: { currencyCode: "EUR" } };
        break;
      case "OtProduct":
        data = { product: store.products.get(String(variables?.id)) ?? null };
        break;
      case "OtOrder":
        data = { order: store.orders.get(String(variables?.id)) ?? null };
        break;
      case "OtProducts": {
        const all = [...store.products.values()];
        const start = variables?.after ? Number(variables.after) : 0;
        const page = all.slice(start, start + 1);
        data = { products: { nodes: page, pageInfo: { hasNextPage: start + 1 < all.length, endCursor: String(start + 1) } } };
        break;
      }
      case "OtOrders": {
        const all = [...store.orders.values()];
        const start = variables?.after ? Number(variables.after) : 0;
        const page = all.slice(start, start + 2);
        data = { orders: { nodes: page, pageInfo: { hasNextPage: start + 2 < all.length, endCursor: String(start + 2) } } };
        break;
      }
      case "OtInventoryItem":
        data = { inventoryItem: { id: variables?.id, variant: { id: "v", product: { id: "gid://shopify/Product/1" } } } };
        break;
      case "OtShopShipping":
        data = { shop: { shipsToCountries: shipsTo, countriesInShippingZones: { countryCodes: shipsTo, includeRestOfWorld: false } } };
        break;
      case "OtOrderAddressState": {
        const o = store.orders.get(String(variables?.id));
        data = {
          order: o
            ? {
                id: o.id,
                presentmentCurrencyCode: "EUR",
                shippingAddress: o.shippingAddress
                  ? { countryCodeV2: o.shippingAddress.countryCodeV2, provinceCode: o.shippingAddress.provinceCode, zip: o.shippingAddress.zip, phone: o.shippingAddress.phone }
                  : null,
                shippingLine: { title: "Standard", source: "shopify", code: "Standard", carrierIdentifier: null, deliveryCategory: null },
              }
            : null,
        };
        break;
      }
      case "OtOrderUpdate": {
        const addr = (variables?.input as { shippingAddress?: { countryCode?: string; zip?: string } }).shippingAddress;
        const custom = rejectWhen ? rejectWhen(variables?.input as Record<string, any>) : [];
        if (custom.length) {
          data = { orderUpdate: { order: null, userErrors: custom } };
          break;
        }
        data = {
          orderUpdate: {
            order: updateErrors.length
              ? null
              : { id: "x", updatedAt: new Date().toISOString(), shippingAddress: { countryCodeV2: keepCountry ?? addr?.countryCode ?? null, zip: addr?.zip ?? null } },
            userErrors: updateErrors,
          },
        };
        break;
      }
      default:
        throw new Error(`unexpected op ${op}`);
    }
    return data as T;
  };
  return {
    admin,
    calls,
    failUpdatesWith: (e: typeof updateErrors) => (updateErrors = e),
    setShipsTo: (c: string[]) => (shipsTo = c),
    /** Імітація: Shopify відповідає без помилок, але лишає стару країну. */
    keepCountryAs: (c: string | null) => (keepCountry = c),
    rejectWhen: (fn: typeof rejectWhen) => (rejectWhen = fn),
  };
}

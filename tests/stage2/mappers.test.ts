import { describe, expect, it } from "vitest";
import {
  gidFromPayload,
  initialStatus,
  isPaid,
  mapOrder,
  mapProduct,
  normalizeAmount,
  orderGidFromOrderEditPayload,
  orderGidFromRefundPayload,
  weightToGrams,
} from "~/modules/shopify-sync/mappers";
import { WEBHOOK_TOPICS, normalizeTopic } from "~/modules/shopify-sync/webhooks.server";
import { buildOrderUpdateInput } from "~/modules/shopify-sync/sync.server";
import { gqlOrder, gqlProduct } from "./fixtures";

describe("Shopify mappers", () => {
  it("converts weights to grams without inventing values", () => {
    expect(weightToGrams({ unit: "KILOGRAMS", value: 0.25 })).toBe(250);
    expect(weightToGrams({ unit: "POUNDS", value: 1 })).toBe(454);
    expect(weightToGrams({ unit: "OUNCES", value: 2 })).toBe(57);
    expect(weightToGrams({ unit: "GRAMS", value: 0 })).toBeNull();
    expect(weightToGrams(null)).toBeNull();
    expect(weightToGrams({ unit: "STONES", value: 1 })).toBeNull();
  });

  it("normalizes decimal amounts exactly", () => {
    expect(normalizeAmount("29.9")).toBe("29.90");
    expect(normalizeAmount("10")).toBe("10.00");
    expect(normalizeAmount("1.005")).toBe("1.01");
    expect(normalizeAmount("0.1")).toBe("0.10");
  });

  it("maps a product with variant customs data, image and stock", () => {
    const p = mapProduct(gqlProduct(1));
    expect(p.variants[0]).toMatchObject({
      shopifyVariantId: "gid://shopify/ProductVariant/101",
      color: "Black",
      price: "29.90",
      weightGrams: 250,
      hsCode: "871410",
      countryOfOrigin: "UA",
      customsDescription: "Scooter accessory",
      imageUrl: "https://cdn.example.com/p1.jpg",
      inventoryAvailable: 12,
      inventoryItemId: "gid://shopify/InventoryItem/101",
    });
  });

  it("missing customs metafield stays null (validation reports it)", () => {
    const p = mapProduct(gqlProduct(2, { customsDescription: null }));
    expect(p.variants[0]?.customsDescription).toBeNull();
  });

  it("maps an order and decides processing", () => {
    const o = mapOrder(gqlOrder());
    expect(o).toMatchObject({ orderNumber: "#5001", total: "41.90", shippingPaid: "12.00", currency: "EUR" });
    expect(o.shipping).toMatchObject({ city: "Berlin", postalCode: "10115", countryCode: "DE" });
    expect(isPaid({ displayFinancialStatus: "PAID" })).toBe(true);
    expect(isPaid({ displayFinancialStatus: "PENDING" })).toBe(false);
    expect(initialStatus(o, "live")).toBe("paid");
    expect(initialStatus(mapOrder(gqlOrder(1, { displayFulfillmentStatus: "FULFILLED" })), "import")).toBe("handed_to_carrier");
    expect(initialStatus(mapOrder(gqlOrder(1, { cancelledAt: "2026-11-21T00:00:00Z" })), "import")).toBe("cancelled");
  });

  it("builds webhook GIDs and topics", () => {
    expect(gidFromPayload({ admin_graphql_api_id: "gid://shopify/Order/9" }, "Order")).toBe("gid://shopify/Order/9");
    expect(gidFromPayload({ id: 77 }, "Product")).toBe("gid://shopify/Product/77");
    expect(gidFromPayload({}, "Product")).toBeNull();
    expect(normalizeTopic("orders/paid")).toBe("ORDERS_PAID");
    expect(normalizeTopic("ORDERS_PAID")).toBe("ORDERS_PAID");
  });

  it("builds orderUpdate input with MailingAddressInput fields only", () => {
    const input = buildOrderUpdateInput({
      shopifyOrderId: "gid://shopify/Order/1",
      email: "a@example.com",
      contactPhone: "+491701234567",
      shipFirstName: "A",
      shipLastName: "B",
      shipCompany: null,
      shipAddress1: "X 1",
      shipAddress2: null,
      shipCity: "Austin",
      shipProvince: "TX",
      shipPostalCode: "73301",
      shipCountryCode: "US",
      shipPhone: "+12025550123",
    } as never);
    expect(Object.keys(input.shippingAddress).sort()).toEqual(
      ["address1", "address2", "city", "company", "countryCode", "firstName", "lastName", "phone", "provinceCode", "zip"].sort(),
    );
    expect(input.shippingAddress.provinceCode).toBe("TX");
    expect(input.phone).toBe("+491701234567");
  });

  it("stage 6: maps LineItem.requiresShipping and Order.test without inventing values", () => {
    const base = gqlOrder();
    const line = base.lineItems.nodes[0]!;
    expect(mapOrder(gqlOrder(1, { test: false, lineItems: { nodes: [{ ...line, requiresShipping: false }] } }))).toMatchObject({
      test: false,
      lineItems: [{ requiresShipping: false }],
    });
    expect(mapOrder(gqlOrder(1, { lineItems: { nodes: [{ ...line, requiresShipping: true }] } })).lineItems[0]?.requiresShipping).toBe(true);
    // Немає поля в даних — null (фінанси вважають «потребує доставки»), а не false.
    expect(mapOrder(base).lineItems[0]?.requiresShipping).toBeNull();
    expect(mapOrder(base).test).toBe(true);
  });

  it("stage 6: refund and order-edit webhooks give the ORDER gid (safe integers only)", () => {
    expect(orderGidFromRefundPayload({ id: 9, order_id: 820982911946154, admin_graphql_api_id: "gid://shopify/Refund/9" })).toBe(
      "gid://shopify/Order/820982911946154",
    );
    expect(orderGidFromRefundPayload({ order_id: "450789469" })).toBe("gid://shopify/Order/450789469");
    expect(orderGidFromRefundPayload({ order_id: 2 ** 60 })).toBeNull();
    expect(orderGidFromRefundPayload({ order_id: "12a" })).toBeNull();
    expect(orderGidFromRefundPayload({ admin_graphql_api_id: "gid://shopify/Refund/9" })).toBeNull();
    expect(orderGidFromOrderEditPayload({ order_edit: { id: 1, order_id: 450789469 } })).toBe("gid://shopify/Order/450789469");
    expect(orderGidFromOrderEditPayload({ id: 450789469 })).toBeNull();
    expect(orderGidFromOrderEditPayload({ order_edit: null })).toBeNull();
    expect(WEBHOOK_TOPICS).toEqual(expect.arrayContaining(["REFUNDS_CREATE", "ORDERS_EDITED"]));
    expect(normalizeTopic("refunds/create")).toBe("REFUNDS_CREATE");
    expect(normalizeTopic("orders/edited")).toBe("ORDERS_EDITED");
  });
});

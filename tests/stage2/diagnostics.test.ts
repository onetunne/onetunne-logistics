import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orders } from "~/db/schema";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { diagnoseOrderAddressUpdate, recordInstallation } from "~/modules/shopify-sync/sync.server";
import { describeOrderUpdateInput, inputVariant, phoneFormat, valueShape } from "~/modules/shopify-sync/diagnostics";
import { updateOrderData } from "~/modules/orders/workflow.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import type { ServiceContext } from "~/server/types";
import { openTestDatabase, OWNER } from "../helpers";
import { fakeAdmin, gqlOrder, gqlProduct } from "./fixtures";

describe("safe request description", () => {
  it("never contains personal values", () => {
    const lines = describeOrderUpdateInput({
      id: "gid://shopify/Order/123",
      email: "secret.person@example.com",
      phone: "+380671234567",
      shippingAddress: { firstName: "Olena", lastName: "Petrenko", address1: "Khreshchatyk 1", city: "Berlin", zip: "10178", countryCode: "DE", provinceCode: null, phone: "+4915123456789", company: "" },
    });
    const text = lines.join(" ");
    for (const pii of ["secret.person", "380671234567", "Olena", "Petrenko", "Khreshchatyk", "Berlin", "10178", "4915123456789"]) {
      expect(text).not.toContain(pii);
    }
    expect(lines).toEqual(expect.arrayContaining([
      "shippingAddress.countryCode=DE",
      "shippingAddress.provinceCode:null",
      "shippingAddress.zip:shape(#####)",
      "shippingAddress.phone:E164(14)",
      "shippingAddress.company:empty",
      "shippingAddress.city:set(6)",
    ]));
    expect(valueShape("SW1A 1AA")).toBe("AA#A #AA");
    expect(phoneFormat("0671234567")).toBe("nonE164(10)");
  });

  it("variants only drop empty fields / phones — never change values", () => {
    const input = { id: "x", email: null, phone: "+1", shippingAddress: { countryCode: "DE", provinceCode: null, zip: "10178", phone: "+49" } };
    expect(inputVariant(input, "omit_nulls")).toEqual({ id: "x", phone: "+1", shippingAddress: { countryCode: "DE", zip: "10178", phone: "+49" } });
    expect(inputVariant(input, "omit_nulls_no_phones")).toEqual({ id: "x", shippingAddress: { countryCode: "DE", zip: "10178" } });
    expect(inputVariant(input, "address_only")).toEqual({ id: "x", shippingAddress: { countryCode: "DE", zip: "10178" } });
  });
});

const SHOP = "ot-test.myshopify.com";
const GID = "gid://shopify/Order/9300";
let h: DatabaseHandle;
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
const run = () => runJobsOnce(h.db, createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin }), { limit: 50 });

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map([["gid://shopify/Product/1", gqlProduct(1)]]) };
  fake = fakeAdmin(store);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new QueueingShopifyGateway(h.db, async () => SHOP), now: () => new Date() };
  await recordInstallation(h.db, SHOP, "write_orders");
  store.orders.set(GID, gqlOrder(9300, {
    shippingAddress: { firstName: "Olena", lastName: "Petrenko", company: null, address1: "Khreshchatyk 1", address2: null, city: "Kyiv", province: "Kyiv city", provinceCode: "30", zip: "01001", countryCodeV2: "UA", phone: "+380671234567" },
  }));
  await handleShopifyWebhook(h.db, { topic: "ORDERS_PAID", shop: SHOP, webhookId: "dg-1", payload: { admin_graphql_api_id: GID } });
  await run();
});
afterAll(async () => {
  await h.close();
});

describe("country change diagnostics", () => {
  it("logs request/response shape without personal data, and the diagnostic pinpoints the rejected element", async () => {
    // Імітація: Shopify відхиляє країну, коли в запиті присутній provinceCode: null.
    fake.rejectWhen((input) =>
      input.shippingAddress && "provinceCode" in input.shippingAddress && input.shippingAddress.provinceCode === null
        ? [{ field: ["shippingAddress", "countryCode"], message: "Country/region not supported" }]
        : [],
    );
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line: string) => void logs.push(line));
    const prevEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      const [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, GID));
      await updateOrderData(ctx, o!.id, { expectedVersion: o!.version, shipping: { countryCode: "DE", city: "Berlin", postalCode: "10178", province: "", phone: "+4915123456789" } });
      await run();
      const report = await diagnoseOrderAddressUpdate(h.db, fake.admin, o!.id);
      expect(report.context.countryChanged).toBe(true);
      expect(report.context.before).toMatchObject({ countryIso: "UA", regionCode: "30" });
      expect(report.attempts.map((a) => [a.variant, a.ok])).toEqual([["as_sent", false], ["omit_nulls", true]]);
      expect(report.succeededWith).toBe("omit_nulls");
      const open = await h.db.select().from(issues).where(and(eq(issues.orderId, o!.id), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_SYNC_FAILED")));
      expect(open).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = prevEnv;
      spy.mockRestore();
      fake.rejectWhen(null);
    }
    const all = logs.join("\n");
    expect(all).toContain("shopify.order_update.request");
    expect(all).toContain("shopify.order_update.response");
    expect(all).toContain("Country/region not supported");
    expect(all).toContain("shippingAddress.countryCode=DE");
    expect(all).toContain('"countryIso":"UA"');
    for (const pii of ["Olena", "Petrenko", "Khreshchatyk", "Berlin", "10178", "4915123456789", "380671234567", "buyer@example.com"]) {
      expect(all).not.toContain(pii);
    }
  });
});

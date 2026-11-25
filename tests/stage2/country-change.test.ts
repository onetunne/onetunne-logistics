/**
 * Регресія: зміна країни доставки замовлення через застосунок (UA → DE, Berlin, 10178).
 * Перевіряє фактичні параметри orderUpdate, країни доставки магазину і підтвердження застосування адреси.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, jobs, orders } from "~/db/schema";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { recordInstallation } from "~/modules/shopify-sync/sync.server";
import { updateOrderData } from "~/modules/orders/workflow.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import type { ServiceContext } from "~/server/types";
import { openTestDatabase, OWNER } from "../helpers";
import { fakeAdmin, gqlOrder, gqlProduct } from "./fixtures";

const SHOP = "ot-test.myshopify.com";
const GID = "gid://shopify/Order/9100";
let h: DatabaseHandle;
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
const run = () => runJobsOnce(h.db, createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin }), { limit: 50 });
const order = async () => (await h.db.select().from(orders).where(eq(orders.shopifyOrderId, GID)))[0]!;
const openIssues = async (id: string) =>
  h.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.status, "open")));
const lastUpdate = () => [...fake.calls].reverse().find((c) => c.op === "OtOrderUpdate")?.variables?.input as Record<string, any> | undefined;

async function changeToGermany() {
  const o = await order();
  return updateOrderData(ctx, o.id, {
    expectedVersion: o.version,
    shipping: { countryCode: "DE", city: "Berlin", postalCode: "10178", province: "", address1: "Alexanderplatz 1", phone: "+4915123456789" },
  });
}

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map([["gid://shopify/Product/1", gqlProduct(1)]]) };
  fake = fakeAdmin(store);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new QueueingShopifyGateway(h.db, async () => SHOP), now: () => new Date() };
  await recordInstallation(h.db, SHOP, "write_orders,read_products,read_inventory");
  // Початкове замовлення з українською адресою (регіон із кодом, як у тестовому магазині).
  store.orders.set(GID, gqlOrder(9100, {
    shippingAddress: {
      firstName: "Test", lastName: "Buyer", company: null, address1: "вул. Хрещатик 1", address2: null,
      city: "Київ", province: "Kyiv city", provinceCode: "30", zip: "01001", countryCodeV2: "UA", phone: "+380671234567",
    },
  }));
  await handleShopifyWebhook(h.db, { topic: "ORDERS_PAID", shop: SHOP, webhookId: "cc-1", payload: { admin_graphql_api_id: GID } });
  await run();
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  fake.failUpdatesWith([]);
  fake.setShipsTo(["DE", "UA"]);
  fake.keepCountryAs(null);
});

describe("shipping country change UA → DE", () => {
  it("sends countryCode (enum CountryCode) with zip/city, no deprecated country/province and no stale UA region", async () => {
    expect((await order()).shipProvince).toBe("30");
    const res = await changeToGermany();
    expect(res.sync).toEqual({ status: "queued" });
    await run();
    const input = lastUpdate()!;
    expect(input.id).toBe(GID);
    expect(input.shippingAddress).toEqual({
      firstName: "Test", lastName: "Buyer", company: null, address1: "Alexanderplatz 1", address2: null,
      city: "Berlin", provinceCode: null, zip: "10178", countryCode: "DE", phone: "+4915123456789",
    });
    expect(input.shippingAddress).not.toHaveProperty("country");
    expect(input.shippingAddress).not.toHaveProperty("province");
    expect((await openIssues((await order()).id)).filter((i) => i.code.startsWith("SHOPIFY_"))).toHaveLength(0);
  });

  it("country outside the store's shipping zones → no request, precise problem next to the country field", async () => {
    fake.setShipsTo(["UA"]);
    const o = await order();
    await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { address2: "2. OG" } });
    const before = fake.calls.filter((c) => c.op === "OtOrderUpdate").length;
    await run();
    expect(fake.calls.filter((c) => c.op === "OtOrderUpdate").length).toBe(before);
    const problem = (await openIssues(o.id)).find((i) => i.code === "SHOPIFY_COUNTRY_NOT_SHIPPED");
    expect(problem).toMatchObject({ field: "shipping.countryCode", params: { country: "DE", shipsTo: "UA" } });
    const dead = await h.db.select().from(jobs).where(eq(jobs.status, "dead"));
    expect(dead.length).toBeGreaterThan(0);
  });

  it("after the country is added to shipping zones, the retry succeeds and clears the problem and the failed job", async () => {
    fake.setShipsTo(["UA", "DE"]);
    const o = await order();
    await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { address2: "3. OG" } });
    await run();
    expect(lastUpdate()?.shippingAddress).toMatchObject({ countryCode: "DE", zip: "10178", address2: "3. OG" });
    expect((await openIssues(o.id)).filter((i) => i.code.startsWith("SHOPIFY_"))).toHaveLength(0);
    expect(await h.db.select().from(jobs).where(eq(jobs.status, "dead"))).toHaveLength(0);
  });

  it("Shopify 'Country/region not supported' is shown next to the country field", async () => {
    fake.failUpdatesWith([{ field: ["shippingAddress", "countryCode"], message: "Country/region not supported" }]);
    const o = await order();
    await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { address2: "4. OG" } });
    await run();
    const problem = (await openIssues(o.id)).find((i) => i.code === "SHOPIFY_SYNC_FAILED");
    expect(problem).toMatchObject({ field: "shipping.countryCode", params: { message: "Country/region not supported" } });
  });

  it("a response without errors that keeps the old country is not treated as success", async () => {
    fake.keepCountryAs("UA");
    const o = await order();
    await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { address2: "5. OG" } });
    await run();
    const problems = (await openIssues(o.id)).filter((i) => i.code === "SHOPIFY_SYNC_FAILED" && i.field === "shipping.countryCode");
    expect(problems.length).toBe(1);
    expect(String(problems[0]!.params.message)).toContain("instead of DE");
  });
});

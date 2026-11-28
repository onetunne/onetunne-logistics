import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, jobs, orderChanges, orderLineItems, orders, productVariants, shopInstallations, staffMembers, webhookEvents } from "~/db/schema";
import { can } from "~/domain/permissions";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import { resolveShopifyActor } from "~/server/context.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { currentShop, recordInstallation, startOrdersImport } from "~/modules/shopify-sync/sync.server";
import { updateOrderData, validateOrderById } from "~/modules/orders/workflow.server";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { seedReferenceData, DEMO_SETTINGS } from "~/db/seed/seed.server";
import type { DatabaseHandle } from "~/db/client.server";
import { openTestDatabase, OWNER } from "../helpers";
import type { ServiceContext } from "~/server/types";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { fakeAdmin, gqlOrder, gqlProduct } from "./fixtures";

const SHOP = "ot-test.myshopify.com";
let h: DatabaseHandle;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let handlers: ReturnType<typeof createSyncHandlers>;

beforeAll(async () => {
  h = await openTestDatabase();
  // Довідники + тестовий відправник; тестовий перевізник замість Nova Global (лише для тестів).
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map() };
  fake = fakeAdmin(store);
  const shopify = new QueueingShopifyGateway(h.db, async () => SHOP);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify, now: () => new Date() };
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  fake.calls.length = 0;
});

const run = () => runJobsOnce(h.db, handlers, { limit: 100 });
let hook = 0;
const webhook = (topic: string, payload: Record<string, unknown>, id = `wh-${++hook}`) =>
  handleShopifyWebhook(h.db, { topic, shop: SHOP, webhookId: id, payload });
const orderRow = async (gid: string) => (await h.db.select().from(orders).where(eq(orders.shopifyOrderId, gid)))[0];

describe("installation and product sync", () => {
  it("records the install and syncs all products page by page", async () => {
    store.products.set("gid://shopify/Product/1", gqlProduct(1));
    store.products.set("gid://shopify/Product/2", gqlProduct(2));
    const r = await recordInstallation(h.db, SHOP, "read_orders,read_products");
    expect(r.firstSync).toBe(true);
    await run();
    const variants = await h.db.select().from(productVariants);
    expect(variants.map((v) => v.sku).sort()).toEqual(["SKU-1", "SKU-2"]);
    expect(variants[0]).toMatchObject({ weightGrams: 250, hsCode: "871410", currency: "EUR" });
    expect((await currentShop(h.db))?.productsSyncedAt).toBeTruthy();
  });

  it("inventory webhook re-reads the product", async () => {
    store.products.set("gid://shopify/Product/1", gqlProduct(1, {
      updatedAt: "2026-11-21T10:00:00Z",
      variants: { nodes: [{ ...gqlProduct(1).variants.nodes[0]!, inventoryQuantity: 3 }] },
    }));
    expect(await webhook("INVENTORY_LEVELS_UPDATE", { inventory_item_id: 101, available: 3 })).toBe("queued");
    await run();
    const [v] = await h.db.select().from(productVariants).where(eq(productVariants.sku, "SKU-1"));
    expect(v?.inventoryAvailable).toBe(3);
  });
});

describe("orders via webhooks", () => {
  it("unpaid orders are not created; paid ones are and get processed (semi mode → validated)", async () => {
    store.orders.set("gid://shopify/Order/5001", gqlOrder(5001, { displayFinancialStatus: "PENDING" }));
    await webhook("ORDERS_CREATE", { admin_graphql_api_id: "gid://shopify/Order/5001" });
    await run();
    expect(await orderRow("gid://shopify/Order/5001")).toBeUndefined();

    store.orders.set("gid://shopify/Order/5001", gqlOrder(5001, { updatedAt: "2026-11-20T10:05:00Z" }));
    await webhook("ORDERS_PAID", { admin_graphql_api_id: "gid://shopify/Order/5001" });
    await run();
    const o = await orderRow("gid://shopify/Order/5001");
    expect(o).toMatchObject({ source: "shopify", orderNumber: "#5001", status: "awaiting_review", total: "41.90" });
    const lines = await h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o!.id));
    expect(lines[0]?.variantId).toBeTruthy();
  });

  it("duplicate webhook deliveries are processed once", async () => {
    expect(await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/5001" }, "same-id")).toBe("queued");
    expect(await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/5001" }, "same-id")).toBe("duplicate");
    const rows = await h.db.select().from(webhookEvents).where(eq(webhookEvents.webhookId, "same-id"));
    expect(rows).toHaveLength(1);
    await run();
  });

  it("address change in Shopify updates an editable order with history; stale events are ignored", async () => {
    store.orders.set("gid://shopify/Order/5001", gqlOrder(5001, {
      updatedAt: "2026-11-20T11:00:00Z",
      shippingAddress: { ...gqlOrder().shippingAddress!, city: "Potsdam", zip: "14467" },
    }));
    await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/5001" });
    await run();
    let o = await orderRow("gid://shopify/Order/5001");
    expect(o?.shipCity).toBe("Potsdam");
    const changes = await h.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, o!.id), eq(orderChanges.source, "shopify_sync")));
    expect(changes.map((c) => c.field).sort()).toEqual(["shipping.city", "shipping.postalCode"]);

    store.orders.set("gid://shopify/Order/5001", gqlOrder(5001, { updatedAt: "2026-11-20T09:00:00Z" }));
    await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/5001" });
    await run();
    o = await orderRow("gid://shopify/Order/5001");
    expect(o?.shipCity).toBe("Potsdam");
  });

  it("confirmed manual edits are pushed to Shopify via the queue (orderUpdate)", async () => {
    const o = (await orderRow("gid://shopify/Order/5001"))!;
    const res = await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { address1: "Neue Straße 5" } });
    expect(res.sync).toEqual({ status: "queued" });
    await run();
    const push = fake.calls.find((c) => c.op === "OtOrderUpdate");
    const input = push?.variables?.input as { id: string; shippingAddress: { address1: string } };
    expect(input.id).toBe("gid://shopify/Order/5001");
    expect(input.shippingAddress.address1).toBe("Neue Straße 5");
  });

  it("rejected Shopify update ends as a visible problem", async () => {
    const o = (await orderRow("gid://shopify/Order/5001"))!;
    fake.failUpdatesWith([{ field: ["shippingAddress", "zip"], message: "Zip is invalid" }]);
    await updateOrderData(ctx, o.id, { expectedVersion: o.version, shipping: { address2: "Hinterhaus" } });
    await run();
    fake.failUpdatesWith([]);
    const open = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.status, "open")));
    expect(open.map((i) => i.code)).toContain("SHOPIFY_SYNC_FAILED");
  });

  it("changes after a waybill exists become a problem instead of overwriting", async () => {
    store.orders.set("gid://shopify/Order/5002", gqlOrder(5002));
    await webhook("ORDERS_PAID", { admin_graphql_api_id: "gid://shopify/Order/5002" });
    await run();
    const o = (await orderRow("gid://shopify/Order/5002"))!;
    expect((await createWaybill(ctx, o.id)).kind).toBe("created");
    store.orders.set("gid://shopify/Order/5002", gqlOrder(5002, {
      updatedAt: "2026-11-22T10:00:00Z",
      shippingAddress: { ...gqlOrder().shippingAddress!, city: "Hamburg" },
    }));
    await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/5002" });
    await run();
    expect((await orderRow("gid://shopify/Order/5002"))?.shipCity).toBe("Berlin");
    const open = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.status, "open")));
    expect(open.map((i) => i.code)).toContain("SHOPIFY_ORDER_CHANGED");
  });

  it("cancellation in Shopify cancels the order and its test waybill", async () => {
    store.orders.set("gid://shopify/Order/5002", gqlOrder(5002, { updatedAt: "2026-11-23T10:00:00Z", cancelledAt: "2026-11-23T10:00:00Z" }));
    await webhook("ORDERS_CANCELLED", { admin_graphql_api_id: "gid://shopify/Order/5002" });
    await run();
    expect((await orderRow("gid://shopify/Order/5002"))?.status).toBe("cancelled");
  });
});

describe("import of past orders", () => {
  it("imports page by page without duplicates and without automatic processing", async () => {
    await updateSetting(h.db, OWNER, "automation", { mode: "auto", globalPause: false });
    store.orders.clear();
    store.orders.set("gid://shopify/Order/4001", gqlOrder(4001, { displayFulfillmentStatus: "FULFILLED" }));
    store.orders.set("gid://shopify/Order/4002", gqlOrder(4002));
    store.orders.set("gid://shopify/Order/4003", gqlOrder(4003, { displayFinancialStatus: "PENDING" }));
    store.orders.set("gid://shopify/Order/5001", gqlOrder(5001, { updatedAt: "2026-11-24T10:00:00Z" }));
    await startOrdersImport(h.db, SHOP, "2026-01-01");
    await run();
    expect((await orderRow("gid://shopify/Order/4001"))?.status).toBe("handed_to_carrier");
    expect((await orderRow("gid://shopify/Order/4002"))?.status).toBe("paid");
    expect(await orderRow("gid://shopify/Order/4003")).toBeUndefined();
    const [inst] = await h.db.select().from(shopInstallations).where(eq(shopInstallations.shop, SHOP));
    expect(inst?.importState).toMatchObject({ status: "done", imported: 2, skipped: 1 });
    // Повторний імпорт не створює дублікатів.
    await startOrdersImport(h.db, SHOP, "2026-01-01");
    await run();
    const all = await h.db.select().from(orders);
    expect(all.filter((o) => o.shopifyOrderId === "gid://shopify/Order/4002")).toHaveLength(1);
    // Етап 6: після збереження кожного ЗБЕРЕЖЕНОГО замовлення ставиться фінансова синхронізація (finance.sync_order,
    // +30 с, dedupe finance-order:<gid> — повторний імпорт не множить завдання); інших завдань черга не тримає.
    const q = await h.db.select().from(jobs).where(eq(jobs.status, "queued"));
    expect(q.filter((j) => j.type !== "finance.sync_order")).toHaveLength(0);
    const stored = all.filter((o) => o.shopifyOrderId).map((o) => `finance-order:${o.shopifyOrderId}`).sort();
    expect(q.map((j) => j.dedupeKey).sort()).toEqual(stored);
    expect(q.every((j) => j.runAt.getTime() > Date.now())).toBe(true);
    expect(q.map((j) => j.dedupeKey)).not.toContain("finance-order:gid://shopify/Order/4003"); // неоплачене не збережено
    await updateSetting(h.db, OWNER, "automation", { mode: "semi", globalPause: false });
  });
});

describe("roles from Shopify users", () => {
  it("unknown users are registered as staff; owner via env or assigned role", async () => {
    const staff = await resolveShopifyActor(h.db, "111", new Set());
    expect(staff.role).toBe("staff");
    expect(can(staff, "finance.view")).toBe(false);
    const [m] = await h.db.select().from(staffMembers).where(eq(staffMembers.shopifyUserId, "111"));
    expect(m?.lastSeenAt).toBeTruthy();
    expect((await resolveShopifyActor(h.db, "222", new Set(["222"]))).role).toBe("owner");
    await h.db.update(staffMembers).set({ role: "owner" }).where(eq(staffMembers.shopifyUserId, "111"));
    expect((await resolveShopifyActor(h.db, "111", new Set())).role).toBe("owner");
    await h.db.update(staffMembers).set({ active: false, role: "staff" }).where(eq(staffMembers.shopifyUserId, "111"));
    const disabled = await resolveShopifyActor(h.db, "111", new Set());
    expect(disabled.permissions.size).toBe(0);
  });
});

it("validation still works on synced orders", async () => {
  const o = (await orderRow("gid://shopify/Order/4002"))!;
  const v = await validateOrderById(ctx, o.id);
  expect(v.status).toBe("awaiting_review");
  expect((await loadOrderRow(h.db, o.id)).source).toBe("shopify");
});

// ---------------------------------------------------------------------------
// Етап 6 (WP3, docs/stage6-design.md §16.3–§16.4, §14.3 п. 6): синхронізація етапу 2 зберігає Order.test і
// LineItem.requiresShipping, для відвантажених — лише current_quantity; нові webhooks ставлять обидві синхронізації.
// ---------------------------------------------------------------------------

describe("stage 6: finance facts kept by the stage-2 order sync", () => {
  const line = (n: number, over: Partial<GqlOrder["lineItems"]["nodes"][number]> = {}) => ({ ...gqlOrder(n).lineItems.nodes[0]!, ...over });
  const lineRows = async (gid: string) => {
    const o = (await orderRow(gid))!;
    return h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id));
  };
  const financeJob = async (gid: string) =>
    (await h.db.select().from(jobs).where(and(eq(jobs.type, "finance.sync_order"), eq(jobs.dedupeKey, `finance-order:${gid}`), eq(jobs.status, "queued"))))[0];

  it("stores orders.shopify_test and order_line_items.requires_shipping (and their later changes)", async () => {
    store.orders.set("gid://shopify/Order/6001", gqlOrder(6001, { test: false, lineItems: { nodes: [line(6001, { requiresShipping: false })] } }));
    await webhook("ORDERS_PAID", { admin_graphql_api_id: "gid://shopify/Order/6001" });
    await run();
    expect((await orderRow("gid://shopify/Order/6001"))?.shopifyTest).toBe(false);
    expect((await lineRows("gid://shopify/Order/6001")).map((l) => l.requiresShipping)).toEqual([false]);
    const before = (await lineRows("gid://shopify/Order/6001"))[0]!.id;

    store.orders.set(
      "gid://shopify/Order/6001",
      gqlOrder(6001, { test: true, updatedAt: "2026-11-21T10:00:00Z", lineItems: { nodes: [line(6001, { requiresShipping: true })] } }),
    );
    await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/6001" });
    await run();
    expect((await orderRow("gid://shopify/Order/6001"))?.shopifyTest).toBe(true);
    const after = await lineRows("gid://shopify/Order/6001");
    expect(after.map((l) => [l.id, l.requiresShipping])).toEqual([[before, true]]);
    // Без поля в даних (старі відповіді) — null, а не вигадане значення.
    store.orders.set("gid://shopify/Order/6003", gqlOrder(6003));
    await webhook("ORDERS_PAID", { admin_graphql_api_id: "gid://shopify/Order/6003" });
    await run();
    expect((await lineRows("gid://shopify/Order/6003")).map((l) => l.requiresShipping)).toEqual([null]);
  });

  it("queues finance.sync_order (+30 s, dedupe) after a stored order is saved", async () => {
    const job = await financeJob("gid://shopify/Order/6001");
    expect(job).toBeTruthy();
    expect(job!.payload).toEqual({ shop: SHOP, orderGid: "gid://shopify/Order/6001" });
    expect(job!.runAt.getTime()).toBeGreaterThan(Date.now() + 10_000);
    const queued = await h.db.select().from(jobs).where(and(eq(jobs.type, "finance.sync_order"), eq(jobs.status, "queued")));
    // Повторні події того самого замовлення не множать завдання.
    expect(queued.filter((j) => j.dedupeKey === "finance-order:gid://shopify/Order/6001")).toHaveLength(1);
  });

  it("a refund after shipment updates ONLY current_quantity (same line ids, no line history, no problem)", async () => {
    store.orders.set("gid://shopify/Order/6002", gqlOrder(6002, { lineItems: { nodes: [line(6002, { quantity: 2, currentQuantity: 2 })] } }));
    await webhook("ORDERS_PAID", { admin_graphql_api_id: "gid://shopify/Order/6002" });
    await run();
    const o = (await orderRow("gid://shopify/Order/6002"))!;
    await h.db.update(orders).set({ status: "handed_to_carrier" }).where(eq(orders.id, o.id));
    const [before] = await lineRows("gid://shopify/Order/6002");
    expect(before).toMatchObject({ quantity: 2, currentQuantity: 2 });
    const historyBefore = await h.db.select().from(orderChanges).where(eq(orderChanges.orderId, o.id));

    store.orders.set(
      "gid://shopify/Order/6002",
      gqlOrder(6002, {
        updatedAt: "2026-11-25T10:00:00Z",
        displayFinancialStatus: "PARTIALLY_REFUNDED",
        displayFulfillmentStatus: "FULFILLED",
        lineItems: { nodes: [line(6002, { quantity: 2, currentQuantity: 1, title: "Перейменовано" })] },
      }),
    );
    await webhook("ORDERS_UPDATED", { admin_graphql_api_id: "gid://shopify/Order/6002" });
    await run();
    const [after] = await lineRows("gid://shopify/Order/6002");
    // Позицію не замінено (той самий id, назва й кількість — як були), змінено лише поточну кількість.
    expect(after).toMatchObject({ id: before!.id, quantity: 2, currentQuantity: 1, title: before!.title });
    expect(await h.db.select().from(orderChanges).where(eq(orderChanges.orderId, o.id))).toHaveLength(historyBefore.length);
    const open = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.status, "open")));
    expect(open.map((i) => i.code)).not.toContain("SHOPIFY_ORDER_CHANGED");
    expect((await orderRow("gid://shopify/Order/6002"))?.status).toBe("handed_to_carrier");
  });

  it("REFUNDS_CREATE takes the order from order_id (not the refund's admin_graphql_api_id) and queues both syncs", async () => {
    await h.db.delete(jobs);
    expect(await webhook("REFUNDS_CREATE", { id: 777, order_id: 6002, admin_graphql_api_id: "gid://shopify/Refund/777" })).toBe("queued");
    const q = await h.db.select().from(jobs).where(eq(jobs.status, "queued"));
    expect(q.map((j) => [j.type, j.dedupeKey, (j.payload as { orderGid: string }).orderGid]).sort()).toEqual([
      ["finance.sync_order", "finance-order:gid://shopify/Order/6002", "gid://shopify/Order/6002"],
      ["shopify.sync_order", "order:gid://shopify/Order/6002", "gid://shopify/Order/6002"],
    ]);
    // Число понад 2^53 після JSON.parse неточне — не вгадуємо замовлення.
    expect(await webhook("REFUNDS_CREATE", { id: 778, order_id: 2 ** 60, admin_graphql_api_id: "gid://shopify/Refund/778" })).toBe("ignored");
    expect(await webhook("REFUNDS_CREATE", { id: 779, admin_graphql_api_id: "gid://shopify/Refund/779" })).toBe("ignored");
  });

  it("ORDERS_EDITED takes order_edit.order_id and is routed before the generic ORDERS_* rule", async () => {
    await h.db.delete(jobs);
    expect(await webhook("orders/edited", { order_edit: { id: 55, order_id: 6001, notify_customer: false } })).toBe("queued");
    const q = await h.db.select().from(jobs).where(eq(jobs.status, "queued"));
    expect(q.map((j) => (j.payload as { orderGid: string }).orderGid)).toEqual(["gid://shopify/Order/6001", "gid://shopify/Order/6001"]);
    expect(q.map((j) => j.type).sort()).toEqual(["finance.sync_order", "shopify.sync_order"]);
    // Корінь — правка, не замовлення: id кореня (id правки) не використовується.
    expect(await webhook("ORDERS_EDITED", { id: 6001, admin_graphql_api_id: "gid://shopify/Order/6001" })).toBe("ignored");
    await h.db.delete(jobs);
  });
});

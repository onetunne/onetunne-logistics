/**
 * Етап 3: передача трек-номера в Shopify (fulfillmentCreate) — імітація Admin API.
 * Перевіряє: лише після фактичної передачі; ідемпотентність (звірка за трек-номером); групування за локацією;
 * notifyCustomer з налаштувань (за замовчуванням false); відмова Shopify → без повторів → проблема.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orderLineItems, orders, shipments } from "~/db/schema";
import { createCarrierRegistry } from "~/integrations/carriers";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlFulfillmentOrder, GqlOrderFulfillmentState } from "~/integrations/shopify/fulfillment-graphql";
import { fulfillableGroups, fulfillShipment, reportFulfillmentFailure, trackingInfoFor } from "~/modules/shopify-sync/fulfillment.server";
import { updateSetting } from "~/modules/settings/settings.server";
import type { CarrierAdapter } from "~/integrations/carriers/types";
import { createTestEnv, OWNER, type TestEnv } from "../helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const carrier = {
  code: "nova_post",
  displayName: "Nova Post",
  trackingInfo: (n: string) => ({ company: "Nova Post", number: n, url: null }),
} as unknown as CarrierAdapter;
const carriers = createCarrierRegistry([carrier], "nova_post");

function fo(id: string, over: Partial<GqlFulfillmentOrder> = {}): GqlFulfillmentOrder {
  return {
    id: `gid://shopify/FulfillmentOrder/${id}`,
    status: "OPEN",
    supportedActions: [{ action: "CREATE_FULFILLMENT" }, { action: "MOVE" }],
    assignedLocation: { location: { id: "gid://shopify/Location/1" } },
    lineItems: { nodes: [{ id: `gid://shopify/FulfillmentOrderLineItem/${id}1`, remainingQuantity: 1 }] },
    ...over,
  };
}

function fakeAdmin(state: GqlOrderFulfillmentState, opts: { userErrors?: string[] } = {}) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  const admin = (async (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes("OtOrderFulfillmentState")) return state;
    if (query.includes("OtFulfillmentCreate")) {
      if (opts.userErrors?.length) {
        return { fulfillmentCreate: { fulfillment: null, userErrors: opts.userErrors.map((m) => ({ field: ["fulfillment"], message: m })) } };
      }
      const id = `gid://shopify/Fulfillment/${calls.length}`;
      const number = ((variables?.fulfillment as { trackingInfo: { number: string } }).trackingInfo).number;
      state.order?.fulfillments.push({ id, status: "SUCCESS", trackingInfo: [{ number }] });
      return { fulfillmentCreate: { fulfillment: { id, status: "SUCCESS" }, userErrors: [] } };
    }
    throw new Error(`unexpected query ${query.slice(0, 40)}`);
  }) as AdminGraphql;
  return { admin, calls };
}

let seq = 0;
/** Замовлення Shopify з накладною (стан created). handedOver — фактична передача. */
async function shipmentFor(handedOver: boolean): Promise<{ shipmentId: string; orderId: string; gid: string; number: string }> {
  const db = env.handle.db;
  seq++;
  const [src] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
  const gid = `gid://shopify/Order/77${seq}`;
  const [order] = await db
    .insert(orders)
    .values({ ...rest, orderNumber: `F-${seq}`, status: handedOver ? "handed_to_carrier" : "waybill_created", source: "shopify", shopifyOrderId: gid })
    .returning({ id: orders.id });
  const items = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id));
  for (const { id: _i, orderId: _o, ...item } of items) await db.insert(orderLineItems).values({ ...item, orderId: order!.id, shopifyLineItemId: null });
  const number = `2045000000${String(seq).padStart(4, "0")}`;
  const [s] = await db
    .insert(shipments)
    .values({
      orderId: order!.id,
      carrierCode: "nova_post",
      mode: "live",
      status: "created",
      carrierReference: `OT-F${seq}-1`,
      waybillNumber: number,
      trackingNumber: number,
      createdBy: "test",
      handedOverAt: handedOver ? new Date() : null,
    })
    .returning({ id: shipments.id });
  return { shipmentId: s!.id, orderId: order!.id, gid, number };
}

const stateWith = (gid: string, fulfillmentOrders: GqlFulfillmentOrder[], fulfillments: GqlOrderFulfillmentState["order"] extends infer O ? O extends { fulfillments: infer F } ? F : never : never = []) =>
  ({ order: { id: gid, displayFulfillmentStatus: "UNFULFILLED", fulfillments, fulfillmentOrders: { nodes: fulfillmentOrders } } }) as GqlOrderFulfillmentState;

describe("pure helpers", () => {
  it("groups only fulfillable fulfillment orders by location", () => {
    const groups = fulfillableGroups([
      fo("1"),
      fo("2", { assignedLocation: { location: { id: "gid://shopify/Location/2" } } }),
      fo("3", { status: "CLOSED", supportedActions: [] }),
      fo("4", { status: "ON_HOLD", supportedActions: [{ action: "RELEASE_HOLD" }] }),
      fo("5", { lineItems: { nodes: [{ id: "x", remainingQuantity: 0 }] } }),
      fo("6"),
    ]);
    expect(groups.map((g) => g.map((f) => f.id.split("/").pop()))).toEqual([["1", "6"], ["2"]]);
  });

  it("builds tracking info from template or adapter", () => {
    expect(trackingInfoFor(carriers, "nova_post", "20450000000001", "")).toEqual({ company: "Nova Post", number: "20450000000001" });
    expect(trackingInfoFor(carriers, "nova_post", "20450000000001", "https://track.example/{number}?x=1")).toEqual({
      company: "Nova Post",
      number: "20450000000001",
      url: "https://track.example/20450000000001?x=1",
    });
  });
});

describe("fulfillShipment", () => {
  it("does nothing before the actual handover", async () => {
    const s = await shipmentFor(false);
    const { admin, calls } = fakeAdmin(stateWith(s.gid, [fo("10")]));
    expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("not_ready");
    expect(calls).toHaveLength(0);
  });

  it("creates one fulfillment per location with tracking, notifyCustomer=false by default, and is idempotent", async () => {
    const s = await shipmentFor(true);
    const state = stateWith(s.gid, [fo("20"), fo("21", { assignedLocation: { location: { id: "gid://shopify/Location/9" } } })]);
    const { admin, calls } = fakeAdmin(state);
    expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("created");
    const creates = calls.filter((c) => c.query.includes("OtFulfillmentCreate"));
    expect(creates).toHaveLength(2);
    expect(creates[0]!.variables).toEqual({
      fulfillment: {
        lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/20" }],
        trackingInfo: { company: "Nova Post", number: s.number },
        notifyCustomer: false,
      },
    });
    // Запит стану не містить адреси/персональних даних.
    expect(calls[0]!.query).not.toMatch(/destination|address|email|phone/i);
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
    expect(row!.shopifyFulfilledAt).not.toBeNull();
    expect(row!.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/2");
    // Повтор завдання — без звернення до Shopify.
    expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("already_recorded");
    expect(calls.filter((c) => c.query.includes("OtFulfillmentCreate"))).toHaveLength(2);
  });

  it("after a lost response, finds the existing fulfillment by tracking number instead of creating a duplicate", async () => {
    const s = await shipmentFor(true);
    const state = stateWith(s.gid, [fo("30", { status: "CLOSED", supportedActions: [] })], [
      { id: "gid://shopify/Fulfillment/555", status: "SUCCESS", trackingInfo: [{ number: s.number }] },
    ]);
    const { admin, calls } = fakeAdmin(state);
    expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("found_existing");
    expect(calls.some((c) => c.query.includes("OtFulfillmentCreate"))).toBe(false);
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
    expect(row!.shopifyFulfillmentId).toBe("gid://shopify/Fulfillment/555");
  });

  it("uses notifyCustomer and the tracking URL template from settings", async () => {
    await updateSetting(env.handle.db, OWNER, "tracking", {
      enabled: true,
      intervalMinutes: 60,
      pushToShopify: true,
      notifyCustomer: true,
      trackingUrlTemplate: "https://track.example/{number}",
    });
    const s = await shipmentFor(true);
    const { admin, calls } = fakeAdmin(stateWith(s.gid, [fo("40")]));
    await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId });
    const create = calls.find((c) => c.query.includes("OtFulfillmentCreate"))!;
    expect(create.variables).toMatchObject({
      fulfillment: { notifyCustomer: true, trackingInfo: { url: `https://track.example/${s.number}` } },
    });
    await updateSetting(env.handle.db, OWNER, "tracking", {
      enabled: true,
      intervalMinutes: 60,
      pushToShopify: true,
      notifyCustomer: false,
      trackingUrlTemplate: "",
    });
  });

  it("on hold → retryable error; already fulfilled elsewhere → recorded without creating", async () => {
    const held = await shipmentFor(true);
    const { admin: a1 } = fakeAdmin(stateWith(held.gid, [fo("50", { status: "ON_HOLD", supportedActions: [{ action: "RELEASE_HOLD" }] })]));
    await expect(fulfillShipment(env.handle.db, a1, carriers, { shopifyOrderId: held.gid, shipmentId: held.shipmentId })).rejects.toMatchObject({
      retryable: true,
    });
    const done = await shipmentFor(true);
    const { admin: a2, calls } = fakeAdmin(stateWith(done.gid, [fo("51", { status: "CLOSED", supportedActions: [] })]));
    expect(await fulfillShipment(env.handle.db, a2, carriers, { shopifyOrderId: done.gid, shipmentId: done.shipmentId })).toBe(
      "already_fulfilled_in_shopify",
    );
    expect(calls.some((c) => c.query.includes("OtFulfillmentCreate"))).toBe(false);
  });

  it("Shopify userErrors → non-retryable error; dead job opens one issue", async () => {
    const s = await shipmentFor(true);
    const { admin } = fakeAdmin(stateWith(s.gid, [fo("60")]), { userErrors: ["Fulfillment order is not in a fulfillable state"] });
    const err = await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect((err as ShopifyApiError).retryable).toBe(false);
    await reportFulfillmentFailure(env.handle.db, s.shipmentId, (err as Error).message);
    await reportFulfillmentFailure(env.handle.db, s.shipmentId, (err as Error).message);
    const open = await env.handle.db
      .select()
      .from(issues)
      .where(and(eq(issues.orderId, s.orderId), eq(issues.code, "SHOPIFY_FULFILLMENT_FAILED"), eq(issues.status, "open")));
    expect(open).toHaveLength(1);
  });
});

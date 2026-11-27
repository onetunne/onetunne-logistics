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
import {
  FULFILLMENT_CREATE_MUTATION,
  ORDER_FULFILLMENT_STATE_QUERY,
  type GqlFulfillmentOrder,
  type GqlOrderFulfillmentState,
} from "~/integrations/shopify/fulfillment-graphql";
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

/**
 * Імітація Admin API. Створене виконання закриває FO (як у Shopify: «transitions to a CLOSED status»).
 * failCreateAt — номер виклику fulfillmentCreate (з 1), який кидає мережеву помилку (повторювану).
 */
function fakeAdmin(state: GqlOrderFulfillmentState, opts: { userErrors?: string[]; failCreateAt?: number } = {}) {
  const calls: { query: string; variables?: Record<string, unknown> }[] = [];
  let creates = 0;
  const admin = (async (query: string, variables?: Record<string, unknown>) => {
    calls.push({ query, variables });
    if (query.includes("OtOrderFulfillmentState")) return structuredClone(state);
    if (query.includes("OtFulfillmentCreate")) {
      creates++;
      if (opts.failCreateAt === creates) throw new ShopifyApiError("network error", true, "NETWORK");
      if (opts.userErrors?.length) {
        return { fulfillmentCreate: { fulfillment: null, userErrors: opts.userErrors.map((m) => ({ field: ["fulfillment"], message: m })) } };
      }
      const id = `gid://shopify/Fulfillment/${calls.length}`;
      const input = variables?.fulfillment as { trackingInfo: { number: string }; lineItemsByFulfillmentOrder: { fulfillmentOrderId: string }[] };
      state.order?.fulfillments.push({ id, status: "SUCCESS", trackingInfo: [{ number: input.trackingInfo.number }] });
      for (const { fulfillmentOrderId } of input.lineItemsByFulfillmentOrder) {
        const node = state.order?.fulfillmentOrders.nodes.find((n) => n.id === fulfillmentOrderId);
        if (node) {
          node.status = "CLOSED";
          node.supportedActions = [];
          node.lineItems.nodes = node.lineItems.nodes.map((li) => ({ ...li, remainingQuantity: 0 }));
        }
      }
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

/**
 * Запитувана вартість запиту за правилами документації shopify.dev (rate-limits): скаляр/enum — 0, об'єкт — 1,
 * список/з'єднання з first/last — 2 + first × вартість вузла (приклад документації products(first: 1){edges{node{title}}} = 3).
 * Обгортки edges/nodes прозорі (вузол — об'єкт). Мутація — 10. Консервативно: усе всередині з'єднання множиться.
 */
function requestedQueryCost(document: string): number {
  const src = document.replace(/#graphql/g, "").replace(/\$[A-Za-z]+\s*:\s*[A-Za-z!\[\]]+/g, "");
  let i = 0;
  const skipWs = () => {
    while (i < src.length && /[\s,]/.test(src[i]!)) i++;
  };
  const readName = () => {
    skipWs();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0];
  };
  const readArgs = (): Record<string, string> => {
    skipWs();
    if (src[i] !== "(") return {};
    const end = src.indexOf(")", i);
    const body = src.slice(i + 1, end);
    i = end + 1;
    return Object.fromEntries([...body.matchAll(/([A-Za-z]+)\s*:\s*([^,\s)]+)/g)].map((m) => [m[1]!, m[2]!]));
  };
  // Повертає вартість набору полів { ... } (без вартості самого об'єкта-власника).
  const readSelection = (): number => {
    skipWs();
    if (src[i] !== "{") return 0;
    i++;
    let total = 0;
    for (;;) {
      skipWs();
      if (src[i] === "}") {
        i++;
        return total;
      }
      const name = readName();
      if (!name) throw new Error(`parse error at ${i}: ${src.slice(i, i + 20)}`);
      const args = readArgs();
      skipWs();
      const hasSelection = src[i] === "{";
      const children = hasSelection ? readSelection() : 0;
      const size = Number(args.first ?? args.last ?? NaN);
      if (!hasSelection) continue; // скаляр / enum
      if (name === "edges" || name === "nodes" || name === "node") total += name === "edges" ? children : 1 + children;
      else if (Number.isFinite(size)) total += 2 + size * Math.max(1, children);
      else total += 1 + children;
    }
  };
  skipWs();
  const kind = readName();
  readName(); // назва операції
  readArgs();
  const cost = readSelection();
  return kind === "mutation" ? 10 + cost : cost;
}

describe("query cost (Shopify single-query limit 1000, checked before execution)", () => {
  it("matches the documented example", () => {
    expect(requestedQueryCost("query Q { products(first: 1) { edges { node { title } } } }")).toBe(3);
  });

  it("fulfillment state query and mutation stay well under 1000 points", () => {
    const stateCost = requestedQueryCost(ORDER_FULFILLMENT_STATE_QUERY);
    expect(stateCost).toBeGreaterThan(100);
    expect(stateCost).toBeLessThan(700);
    // Попередня форма запиту (fulfillmentOrders(first: 25) × lineItems(first: 100)) перевищувала ліміт.
    expect(
      requestedQueryCost(
        "query Q($id: ID!) { order(id: $id) { id fulfillments(first: 25) { id trackingInfo(first: 10) { number } } fulfillmentOrders(first: 25) { nodes { id supportedActions { action } assignedLocation { location { id } } lineItems(first: 100) { nodes { id remainingQuantity } } } } } }",
      ),
    ).toBeGreaterThan(1000);
    expect(requestedQueryCost(FULFILLMENT_CREATE_MUTATION)).toBeLessThan(100);
  });
});

describe("fulfillShipment — partial progress and visibility", () => {
  it("multi-location: failure between locations → retry fulfils only the remaining location, no duplicate", async () => {
    const s = await shipmentFor(true);
    const state = stateWith(s.gid, [fo("70"), fo("71", { assignedLocation: { location: { id: "gid://shopify/Location/9" } } })]);
    const first = fakeAdmin(state, { failCreateAt: 2 });
    await expect(fulfillShipment(env.handle.db, first.admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).rejects.toMatchObject({
      retryable: true,
    });
    let [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
    expect(row!.shopifyFulfilledAt).toBeNull();
    expect(state.order!.fulfillmentOrders.nodes.map((n) => n.status)).toEqual(["CLOSED", "OPEN"]);

    const retry = fakeAdmin(state);
    expect(await fulfillShipment(env.handle.db, retry.admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("created");
    const creates = retry.calls.filter((c) => c.query.includes("OtFulfillmentCreate"));
    expect(creates).toHaveLength(1);
    expect(creates[0]!.variables).toMatchObject({
      fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/71" }] },
    });
    expect(state.order!.fulfillmentOrders.nodes.every((n) => n.status === "CLOSED")).toBe(true);
    expect(state.order!.fulfillments).toHaveLength(2);
    [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
    expect(row!.shopifyFulfilledAt).not.toBeNull();
    // Ідентифікатор — перше (знайдене) виконання з нашим трек-номером.
    expect(row!.shopifyFulfillmentId).toBe(state.order!.fulfillments[0]!.id);
  });

  it("multi-location: userErrors on the second location → not recorded; retry creates only the rest", async () => {
    const s = await shipmentFor(true);
    const state = stateWith(s.gid, [fo("72"), fo("73", { assignedLocation: { location: { id: "gid://shopify/Location/9" } } })]);
    let n = 0;
    const base = fakeAdmin(state);
    const flaky = (async (query: string, variables?: Record<string, unknown>) => {
      if (query.includes("OtFulfillmentCreate") && ++n === 2) {
        return { fulfillmentCreate: { fulfillment: null, userErrors: [{ field: ["fulfillment"], message: "Location is not active" }] } };
      }
      return base.admin(query, variables);
    }) as AdminGraphql;
    await expect(fulfillShipment(env.handle.db, flaky, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).rejects.toMatchObject({
      retryable: false,
      code: "USER_ERRORS",
    });
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
    expect(row!.shopifyFulfilledAt).toBeNull();
    const retry = fakeAdmin(state);
    expect(await fulfillShipment(env.handle.db, retry.admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("created");
    expect(retry.calls.filter((c) => c.query.includes("OtFulfillmentCreate"))).toHaveLength(1);
  });

  it("no visible fulfillment orders (scope not approved yet) → non-retryable error, shipment NOT marked fulfilled", async () => {
    const s = await shipmentFor(true);
    const { admin, calls } = fakeAdmin(stateWith(s.gid, []));
    const err = await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId }).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err).toMatchObject({ retryable: false, code: "NO_FULFILLABLE_FO" });
    expect(calls.some((c) => c.query.includes("OtFulfillmentCreate"))).toBe(false);
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
    expect(row!.shopifyFulfilledAt).toBeNull();
  });

  it("open FO without CREATE_FULFILLMENT (e.g. fulfillment service) → not treated as fulfilled", async () => {
    const s = await shipmentFor(true);
    const { admin } = fakeAdmin(stateWith(s.gid, [fo("74", { supportedActions: [{ action: "REQUEST_FULFILLMENT" }] })]));
    await expect(fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).rejects.toMatchObject({
      code: "NO_FULFILLABLE_FO",
    });
  });

  it("empty FO list but Shopify shows FULFILLED → recorded as already fulfilled", async () => {
    const s = await shipmentFor(true);
    const state = stateWith(s.gid, []);
    state.order!.displayFulfillmentStatus = "FULFILLED";
    const { admin } = fakeAdmin(state);
    expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe(
      "already_fulfilled_in_shopify",
    );
  });

  it("reads all fulfillment-order pages before deciding", async () => {
    const s = await shipmentFor(true);
    const page1 = stateWith(s.gid, [fo("75", { status: "CLOSED", supportedActions: [] })]);
    page1.order!.fulfillmentOrders.pageInfo = { hasNextPage: true, endCursor: "c1" };
    const page2 = stateWith(s.gid, [fo("76")]);
    const calls: { query: string; variables?: Record<string, unknown> }[] = [];
    const admin = (async (query: string, variables?: Record<string, unknown>) => {
      calls.push({ query, variables });
      if (query.includes("OtOrderFulfillmentState")) return structuredClone(variables?.after === "c1" ? page2 : page1);
      return { fulfillmentCreate: { fulfillment: { id: "gid://shopify/Fulfillment/900", status: "SUCCESS" }, userErrors: [] } };
    }) as AdminGraphql;
    expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("created");
    expect(calls.filter((c) => c.query.includes("OtOrderFulfillmentState")).map((c) => c.variables?.after ?? null)).toEqual([null, "c1"]);
    expect(calls.find((c) => c.query.includes("OtFulfillmentCreate"))!.variables).toMatchObject({
      fulfillment: { lineItemsByFulfillmentOrder: [{ fulfillmentOrderId: "gid://shopify/FulfillmentOrder/76" }] },
    });
  });

  it("FO with more line items than one page counts as fulfillable", () => {
    const groups = fulfillableGroups([fo("77", { lineItems: { pageInfo: { hasNextPage: true }, nodes: [{ id: "x", remainingQuantity: 0 }] } })]);
    expect(groups).toHaveLength(1);
  });

  it("push to Shopify disabled after the job was queued → no Admin API call, not recorded", async () => {
    await updateSetting(env.handle.db, OWNER, "tracking", {
      enabled: true,
      intervalMinutes: 60,
      pushToShopify: false,
      notifyCustomer: true,
      trackingUrlTemplate: "",
    });
    try {
      const s = await shipmentFor(true);
      const { admin, calls } = fakeAdmin(stateWith(s.gid, [fo("78")]));
      expect(await fulfillShipment(env.handle.db, admin, carriers, { shopifyOrderId: s.gid, shipmentId: s.shipmentId })).toBe("disabled");
      expect(calls).toHaveLength(0);
      const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, s.shipmentId));
      expect(row!.shopifyFulfilledAt).toBeNull();
    } finally {
      await updateSetting(env.handle.db, OWNER, "tracking", {
        enabled: true,
        intervalMinutes: 60,
        pushToShopify: true,
        notifyCustomer: false,
        trackingUrlTemplate: "",
      });
    }
  });
});

/**
 * Етап 3: відстеження посилок — статуси замовлення лише дозволеними переходами, фактична передача,
 * події без дублікатів, проблеми доставки, передача трек-номера в Shopify (через шлюз), опитування.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, jobs, orderLineItems, orders, shipmentEvents, shipments, shipmentTrackingEvents } from "~/db/schema";
import { createCarrierRegistry } from "~/integrations/carriers";
import type {
  CarrierAdapter,
  CarrierCapabilities,
  CreatedShipment,
  LookupResult,
  TrackingSnapshot,
  TrackingStatus,
} from "~/integrations/carriers/types";
import type { ShopifyGateway, ShopifySyncResult } from "~/integrations/shopify/types";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { JOB } from "~/modules/shopify-sync/sync.server";
import { updateSetting } from "~/modules/settings/settings.server";
import {
  markHandedOver,
  orderStatusForTracking,
  planOrderTransitions,
  pollTracking,
  refreshShipmentTracking,
  runTrackingPollJob,
} from "~/modules/tracking/tracking.server";
import type { ServiceContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../helpers";

class TrackingCarrier implements CarrierAdapter {
  readonly code = "trk";
  readonly displayName = "Tracking carrier";
  readonly mode = "test" as const;
  capabilities: CarrierCapabilities = {
    rates: false,
    availability: false,
    createShipment: true,
    updateShipment: false,
    cancelShipment: true,
    documents: false,
    tracking: true,
    returns: false,
    findByReference: false,
    referenceLookupAuthoritative: false,
  };
  private n = 0;
  snapshots = new Map<string, TrackingSnapshot>();
  calls: string[][] = [];
  fail = false;
  async createShipment(): Promise<CreatedShipment> {
    this.n++;
    const num = `TRK${String(this.n).padStart(8, "0")}`;
    return { carrierShipmentId: `id-${this.n}`, waybillNumber: num, trackingNumber: num, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment() {
    return { cancelled: true };
  }
  async getTracking(numbers: string[]): Promise<TrackingSnapshot[]> {
    this.calls.push(numbers);
    if (this.fail) throw new Error("carrier down");
    return numbers.flatMap((n) => (this.snapshots.has(n) ? [this.snapshots.get(n)!] : []));
  }
}

class RecordingGateway implements ShopifyGateway {
  readonly kind = "admin_api" as const;
  requests: { shopifyOrderId: string | null; shipmentId: string }[] = [];
  async updateOrderShippingAddress(): Promise<ShopifySyncResult> {
    return { status: "queued" };
  }
  async updateOrderContact(): Promise<ShopifySyncResult> {
    return { status: "queued" };
  }
  async requestFulfillment(input: { shopifyOrderId: string | null; shipmentId: string }): Promise<ShopifySyncResult> {
    this.requests.push(input);
    return input.shopifyOrderId ? { status: "queued" } : { status: "skipped", reason: "not_linked" };
  }
}

function snap(number: string, status: TrackingStatus, code: string, events: [TrackingStatus, string, string][] = []): TrackingSnapshot {
  return {
    waybillNumber: number,
    status,
    carrierStatusCode: code,
    carrierStatusText: `status ${code}`,
    statusAt: new Date("2026-11-20T10:00:00Z"),
    events: events.map(([s, c, at]) => ({ status: s, code: c, occurredAt: new Date(at), location: "Kyiv, UA", description: `event ${c}` })),
  };
}

let env: TestEnv;
let carrier: TrackingCarrier;
let gateway: RecordingGateway;
let now = new Date("2026-11-20T12:00:00Z");
const ctxFor = (actor = OWNER): ServiceContext => ({
  ...env.ctx(actor),
  carriers: createCarrierRegistry([carrier], carrier.code),
  shopify: gateway,
  now: () => now,
});

beforeAll(async () => {
  env = await createTestEnv();
  carrier = new TrackingCarrier();
  gateway = new RecordingGateway();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  gateway.requests = [];
  carrier.calls = [];
  carrier.fail = false;
  now = new Date(now.getTime() + 60 * 60 * 1000);
});

/** Копія «чистого» демо-замовлення #1001 з новим номером (кожен тест — окреме замовлення). */
async function cleanOrder(number: string): Promise<string> {
  const db = env.handle.db;
  const [src] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
  const [row] = await db.insert(orders).values({ ...rest, orderNumber: number, status: "paid", version: 1 }).returning({ id: orders.id });
  const items = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id));
  for (const { id: _i, orderId: _o, ...item } of items) {
    await db.insert(orderLineItems).values({ ...item, orderId: row!.id, shopifyLineItemId: null });
  }
  return row!.id;
}

async function orderWithWaybill(number: string, shopifyOrderId: string | null = null) {
  const ctx = ctxFor();
  const id = await cleanOrder(`T${number}`);
  if (shopifyOrderId) await ctx.db.update(orders).set({ source: "shopify", shopifyOrderId }).where(eq(orders.id, id));
  await validateOrderById(ctx, id);
  const r = await createWaybill(ctx, id);
  if (r.kind !== "created") throw new Error(`waybill not created: ${r.kind}`);
  return { orderId: id, shipment: r.shipment };
}

describe("pure mapping", () => {
  it("maps tracking statuses to order statuses", () => {
    expect(orderStatusForTracking("created")).toBeNull();
    expect(orderStatusForTracking("accepted")).toBe("handed_to_carrier");
    expect(orderStatusForTracking("out_for_delivery")).toBe("in_transit");
    expect(orderStatusForTracking("customs")).toBe("customs");
    expect(orderStatusForTracking("lost")).toBe("delivery_problem");
    expect(orderStatusForTracking("cancelled")).toBeNull();
  });

  it("plans only allowed transitions, via handed_to_carrier before shipment", () => {
    expect(planOrderTransitions("waybill_created", "in_transit")).toEqual(["handed_to_carrier", "in_transit"]);
    expect(planOrderTransitions("waybill_created", "handed_to_carrier")).toEqual(["handed_to_carrier"]);
    expect(planOrderTransitions("packed", "delivered")).toEqual(["handed_to_carrier", "delivered"]);
    expect(planOrderTransitions("in_transit", "customs")).toEqual(["customs"]);
    expect(planOrderTransitions("delivered", "in_transit")).toEqual([]);
    expect(planOrderTransitions("in_transit", "handed_to_carrier")).toEqual([]);
    expect(planOrderTransitions("awaiting_review", "in_transit")).toEqual([]);
    expect(planOrderTransitions("cancelled", "delivered")).toEqual([]);
    expect(planOrderTransitions("in_transit", null)).toEqual([]);
  });
});

describe("tracking poll", () => {
  it("waybill created ≠ shipped: status 'created' keeps the order in waybill_created", async () => {
    const { orderId, shipment } = await orderWithWaybill("#1001");
    carrier.snapshots.set(shipment.waybillNumber!, snap(shipment.waybillNumber!, "created", "1"));
    const summary = await pollTracking(ctxFor());
    expect(summary.checked).toBeGreaterThanOrEqual(1);
    expect((await loadOrderRow(env.handle.db, orderId)).status).toBe("waybill_created");
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.trackingStatus).toBe("created");
    expect(row!.handedOverAt).toBeNull();
    expect(gateway.requests).toHaveLength(0);
  });

  it("carrier acceptance → handed_to_carrier → in_transit, events stored once, fulfillment requested once", async () => {
    const { orderId, shipment } = await orderWithWaybill("#1003", "gid://shopify/Order/9001");
    const n = shipment.waybillNumber!;
    carrier.snapshots.set(
      n,
      snap(n, "in_transit", "5", [
        ["created", "1", "2026-11-20T08:00:00Z"],
        ["accepted", "4", "2026-11-20T09:00:00Z"],
        ["in_transit", "5", "2026-11-20T10:00:00Z"],
      ]),
    );
    await pollTracking(ctxFor());
    const order = await loadOrderRow(env.handle.db, orderId);
    expect(order.status).toBe("in_transit");
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.handedOverAt?.toISOString()).toBe("2026-11-20T09:00:00.000Z");
    expect(gateway.requests).toEqual([{ shopifyOrderId: "gid://shopify/Order/9001", shipmentId: shipment.id }]);

    // Повторне опитування (після MIN_POLL_AGE) не дублює події й не запитує виконання вдруге.
    now = new Date(now.getTime() + 60 * 60 * 1000);
    gateway.requests = [];
    await pollTracking(ctxFor());
    const events = await env.handle.db.select().from(shipmentTrackingEvents).where(eq(shipmentTrackingEvents.shipmentId, shipment.id));
    expect(events).toHaveLength(3);
    // Передача вже відбулася раніше — повторного запиту немає (у demo-контексті й ensurePendingFulfillments не працює).
    expect(gateway.requests).toHaveLength(0);
  });

  it("delivery problem opens an issue and recovery resolves it; delivered stops polling", async () => {
    const { orderId, shipment } = await orderWithWaybill("#1004");
    const n = shipment.waybillNumber!;
    carrier.snapshots.set(n, snap(n, "failed_attempt", "111", [["accepted", "4", "2026-11-20T09:00:00Z"]]));
    await pollTracking(ctxFor());
    expect((await loadOrderRow(env.handle.db, orderId)).status).toBe("delivery_problem");
    let open = await env.handle.db.select().from(issues).where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "DELIVERY_PROBLEM")));
    expect(open).toHaveLength(1);

    now = new Date(now.getTime() + 60 * 60 * 1000);
    carrier.snapshots.set(n, snap(n, "delivered", "9"));
    await pollTracking(ctxFor());
    expect((await loadOrderRow(env.handle.db, orderId)).status).toBe("delivered");
    open = await env.handle.db.select().from(issues).where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "DELIVERY_PROBLEM")));
    expect(open).toHaveLength(0);
    const [row] = await env.handle.db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row!.deliveredAt).not.toBeNull();

    now = new Date(now.getTime() + 60 * 60 * 1000);
    carrier.calls = [];
    await pollTracking(ctxFor());
    expect(carrier.calls.flat()).not.toContain(n);
  });

  it("waybill deleted at the carrier before handover → issue, order unchanged", async () => {
    const { orderId, shipment } = await orderWithWaybill("#1005");
    const n = shipment.waybillNumber!;
    carrier.snapshots.set(n, snap(n, "cancelled", "2"));
    await pollTracking(ctxFor());
    expect((await loadOrderRow(env.handle.db, orderId)).status).toBe("waybill_created");
    const open = await env.handle.db.select().from(issues).where(and(eq(issues.orderId, orderId), eq(issues.code, "CARRIER_SHIPMENT_DELETED")));
    expect(open).toHaveLength(1);
  });

  it("carrier failure does not change anything and is reported", async () => {
    const { orderId, shipment } = await orderWithWaybill("#1006");
    carrier.fail = true;
    const summary = await pollTracking(ctxFor());
    expect(summary.failedCarriers).toContain("trk");
    expect((await loadOrderRow(env.handle.db, orderId)).status).toBe("waybill_created");
    await expect(refreshShipmentTracking(ctxFor(), shipment.id)).rejects.toMatchObject({ code: "tracking.carrierUnavailable" });
  });
});

describe("manual handover", () => {
  it("requires waybills.manage, moves order to handed_to_carrier once", async () => {
    const { orderId, shipment } = await orderWithWaybill("#1007", "gid://shopify/Order/9007");
    await expect(markHandedOver(ctxFor(STAFF), shipment.id)).rejects.toBeTruthy();
    await markHandedOver(ctxFor(), shipment.id);
    expect((await loadOrderRow(env.handle.db, orderId)).status).toBe("handed_to_carrier");
    expect(gateway.requests).toEqual([{ shopifyOrderId: "gid://shopify/Order/9007", shipmentId: shipment.id }]);
    await expect(markHandedOver(ctxFor(), shipment.id)).rejects.toMatchObject({ code: "shipment.alreadyHandedOver" });
    const ev = await env.handle.db.select().from(shipmentEvents).where(and(eq(shipmentEvents.shipmentId, shipment.id), eq(shipmentEvents.type, "handed_over")));
    expect(ev).toHaveLength(1);
  });

  it("does not request Shopify fulfillment when disabled in settings", async () => {
    const ctx = ctxFor();
    const { shipment } = await orderWithWaybill("#1008", "gid://shopify/Order/9008");
    await updateSetting(ctx.db, OWNER, "tracking", { enabled: true, intervalMinutes: 60, pushToShopify: false, notifyCustomer: false });
    await markHandedOver(ctx, shipment.id);
    expect(gateway.requests).toHaveLength(0);
    await updateSetting(ctx.db, OWNER, "tracking", { enabled: true, intervalMinutes: 60, pushToShopify: true, notifyCustomer: false });
  });
});

describe("poll job scheduling", () => {
  it("schedules exactly one next poll even if run repeatedly", async () => {
    await runTrackingPollJob(ctxFor());
    await runTrackingPollJob(ctxFor());
    const queued = await env.handle.db.select().from(jobs).where(and(eq(jobs.type, JOB.trackingPoll), eq(jobs.status, "queued")));
    expect(queued).toHaveLength(1);
  });
});

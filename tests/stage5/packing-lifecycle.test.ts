import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, inventoryMovements, issues, jobs, orderPacking, orders, shipmentEvents, shipments, shopInstallations } from "~/db/schema";
import type { TrackingSnapshot } from "~/integrations/carriers/types";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { ORDER_CANCELLED_AFTER_PACKING, PACKING_SKIPPED_AT_HANDOVER } from "~/modules/packing/lifecycle.server";
import {
  confirmCancelledPackingReturned,
  confirmPacked,
  recordScan,
  savePackingParcel,
  startPacking,
  unpackOrder,
} from "~/modules/packing/packing.server";
import { parseQueueFilters } from "~/modules/packing/queue-filters";
import { listPackingQueue } from "~/modules/packing/queue.server";
import { loadPackingScreen, loadPackingSummary } from "~/modules/packing/view.server";
import { cancelOrder, cancelWaybill, createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { applyTrackingSnapshot, markHandedOver } from "~/modules/tracking/tracking.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресії рецензії G1b (packing-1/3/4/5/11/m1, e2e-4): пакування лишається узгодженим, коли накладну або замовлення
 * скасовують, коли посилку передають без «Запаковано», коли Shopify змінив позиції чи накладну видалено у перевізника.
 */
let env: TestEnv;
const ids: Record<string, string> = {};

async function prepare(number: string) {
  const id = await env.orderId(number);
  await validateOrderById(env.ctx(OWNER), id);
  const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
  if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
  ids[number] = id;
  return id;
}

beforeAll(async () => {
  env = await createTestEnv();
  for (const n of ["#1001", "#1002", "#1003", "#1007", "#1009", "#1011", "#1012"]) await prepare(n);
});
afterAll(async () => {
  await env.close();
});

async function scanAll(orderId: string) {
  const screen = await loadPackingScreen(env.ctx(), orderId);
  for (const line of screen.lines) {
    for (let i = line.packed; i < line.required; i += 1) {
      expect((await recordScan(env.ctx(STAFF), orderId, line.barcode ?? line.sku ?? "")).kind).toBe("matched");
    }
  }
}
async function pack(orderId: string) {
  await startPacking(env.ctx(STAFF), orderId);
  await scanAll(orderId);
  const screen = await loadPackingScreen(env.ctx(), orderId);
  return confirmPacked(env.ctx(STAFF), orderId, screen.packing!.version);
}
async function orderRow(id: string) {
  const [row] = await env.handle.db.select().from(orders).where(eq(orders.id, id));
  return row!;
}
async function packings(id: string) {
  return env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
}
async function openIssues(id: string, code: string) {
  return env.handle.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.code, code), eq(issues.status, "open")));
}
async function materialConsumes(orderId: string) {
  const [row] = await env.handle.db
    .select({ c: count() })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.orderId, orderId), eq(inventoryMovements.type, "material_consume")));
  return Number(row?.c ?? 0);
}
async function eventTypes(orderId: string) {
  const rows = await env.handle.db
    .select({ type: shipmentEvents.type })
    .from(shipmentEvents)
    .innerJoin(shipments, eq(shipments.id, shipmentEvents.shipmentId))
    .where(eq(shipments.orderId, orderId));
  return rows.map((r) => r.type);
}
const snapshot = (waybillNumber: string, status: TrackingSnapshot["status"]): TrackingSnapshot => ({
  waybillNumber,
  status,
  carrierStatusCode: status.toUpperCase(),
  carrierStatusText: null,
  statusAt: new Date(),
  events: [],
});

describe("Shopify changed the lines after the waybill (packing-1)", () => {
  it("'Packed' is refused for staff, the owner may confirm with a reason; screen, card and queue show it", async () => {
    const id = ids["#1001"]!;
    await startPacking(env.ctx(STAFF), id);
    await scanAll(id);
    await env.handle.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, id));
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen).toMatchObject({ shopifyLinesPending: true, fulfilledInShopify: false });
    expect(screen.progress.complete).toBe(true);
    expect((await loadPackingSummary(env.handle.db, id)).shopifyLinesPending).toBe(true);
    const row = (await listPackingQueue(env.ctx(), parseQueueFilters(new URLSearchParams()))).rows.find((r) => r.id === id)!;
    expect(row.shopifyLinesPending).toBe(true);

    await expect(confirmPacked(env.ctx(STAFF), id, screen.packing!.version)).rejects.toMatchObject({ code: "packing.error.shopifyLinesPending" });
    await expect(confirmPacked(env.ctx(OWNER), id, screen.packing!.version)).rejects.toMatchObject({ code: "packing.error.shopifyLinesPending" });
    await expect(confirmPacked(env.ctx(STAFF), id, screen.packing!.version, { override: { reason: "customer agreed" } })).rejects.toMatchObject({
      code: "packing.error.overrideOwnerOnly",
    });
    const r = await confirmPacked(env.ctx(OWNER), id, screen.packing!.version, { override: { reason: "customer agreed by phone" } });
    expect(r).toMatchObject({ kind: "packed", override: true });
    const [audit] = await env.handle.db.select().from(auditLog).where(and(eq(auditLog.action, "packing.confirmed_override"), eq(auditLog.entityId, id)));
    expect(audit!.details).toMatchObject({ shopifyLinesPendingAcknowledged: true });
  });

  it("start is refused for staff while lines are pending (the owner may start)", async () => {
    const id = ids["#1002"]!;
    await env.handle.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, id));
    await expect(startPacking(env.ctx(STAFF), id)).rejects.toMatchObject({ code: "packing.error.shopifyLinesPending" });
    expect((await packings(id)).length).toBe(0);
    expect((await startPacking(env.ctx(OWNER), id)).kind).toBe("started");
    await env.handle.db.update(orders).set({ shopifyLinesPendingAt: null }).where(eq(orders.id, id));
  });

  it("an order already (partially) fulfilled in Shopify cannot be packed by anyone", async () => {
    const id = ids["#1007"]!;
    await env.handle.db.update(orders).set({ fulfillmentStatus: "partially_fulfilled" }).where(eq(orders.id, id));
    await expect(startPacking(env.ctx(OWNER), id)).rejects.toMatchObject({ code: "packing.error.fulfilledInShopify" });
    expect(await loadPackingScreen(env.ctx(), id)).toMatchObject({ fulfilledInShopify: true, canStart: false });
    await env.handle.db.update(orders).set({ fulfillmentStatus: null }).where(eq(orders.id, id));
  });

  it("cancelling the waybill of a packed order + 'Unpack' → awaiting review queues the Shopify re-read (G1a handoff)", async () => {
    const id = ids["#1001"]!; // запаковано рішенням власника, позиції ще не застосовано
    await env.handle.db.update(orders).set({ source: "shopify", shopifyOrderId: "gid://shopify/Order/770001" }).where(eq(orders.id, id));
    await env.handle.db.insert(shopInstallations).values({ shop: "ot-test.myshopify.com", scopes: "read_orders" });
    try {
      await cancelWaybill(env.ctx(OWNER), (await findActiveShipment(env.handle.db, id))!.id, { purpose: "correction" });
      expect((await orderRow(id)).status).toBe("packed"); // скасування не повертає «Запаковано» до перевірки
      expect(await env.handle.db.select().from(jobs).where(eq(jobs.dedupeKey, "order:gid://shopify/Order/770001"))).toHaveLength(0);
      const r = await unpackOrder(env.ctx(STAFF), id);
      expect(r).toMatchObject({ kind: "unpacked", status: "awaiting_review", shopifyResync: "queued" });
      expect(await env.handle.db.select().from(jobs).where(eq(jobs.dedupeKey, "order:gid://shopify/Order/770001"))).toHaveLength(1);
    } finally {
      await env.handle.db.delete(shopInstallations);
    }
  });
});

describe("order cancelled while packing / packed (packing-4, packing-m1)", () => {
  it("packed → cancelOrder: packing closed, warehouse warning opened (not swept by the bulk resolve), 'Returned to stock' closes it", async () => {
    const id = ids["#1011"]!;
    expect((await pack(id)).kind).toBe("packed");
    await cancelOrder(env.ctx(OWNER), id);
    expect((await orderRow(id)).status).toBe("cancelled");
    expect((await packings(id)).map((p) => p.status)).toEqual(["cancelled"]);
    const [issue] = await openIssues(id, ORDER_CANCELLED_AFTER_PACKING);
    expect(issue).toMatchObject({ severity: "warning", params: { previousStatus: "packed", materialsConsumed: 1 } });
    expect(await eventTypes(id)).toContain("packing_cancelled");
    const screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.cancelledAfterPacking).toEqual({ previousStatus: "packed", materialsConsumed: true });
    expect((await loadPackingSummary(env.handle.db, id)).cancelledAfterPacking).toBe(true);
    // Матеріали не списуються вдруге й не повертаються автоматично.
    const consumed = await materialConsumes(id);

    expect(await confirmCancelledPackingReturned(env.ctx(STAFF), id)).toMatchObject({ kind: "returned" });
    expect(await openIssues(id, ORDER_CANCELLED_AFTER_PACKING)).toHaveLength(0);
    expect(await confirmCancelledPackingReturned(env.ctx(STAFF), id)).toEqual({ kind: "nothing" });
    expect(await eventTypes(id)).toContain("packing_returned");
    expect(await materialConsumes(id)).toBe(consumed);
    expect((await loadPackingScreen(env.ctx(), id)).cancelledAfterPacking).toBeNull();
  });

  it("in progress → cancelOrder: warning opened; planned-only (queued) packing is closed without a warning", async () => {
    const id = ids["#1012"]!;
    await startPacking(env.ctx(STAFF), id);
    await cancelOrder(env.ctx(OWNER), id);
    expect((await packings(id)).map((p) => p.status)).toEqual(["cancelled"]);
    expect((await openIssues(id, ORDER_CANCELLED_AFTER_PACKING))[0]).toMatchObject({ params: { previousStatus: "in_progress", materialsConsumed: 0 } });

    const queued = ids["#1003"]!;
    const [gen] = await env.handle.db.insert(orderPacking).values({ orderId: queued, generation: 1, status: "queued" }).returning();
    await cancelOrder(env.ctx(OWNER), queued);
    const [p] = await env.handle.db.select().from(orderPacking).where(eq(orderPacking.id, gen!.id));
    expect(p!.status).toBe("cancelled");
    expect(await openIssues(queued, ORDER_CANCELLED_AFTER_PACKING)).toHaveLength(0);
  });
});

describe("handover vs picking control (packing-5)", () => {
  it("manual handover of an unconfirmed packing is refused; the owner may hand over with a reason → packed, materials written off once", async () => {
    const orderId = ids["#1009"]!;
    await startPacking(env.ctx(STAFF), orderId);
    const shipment = (await findActiveShipment(env.handle.db, orderId))!;
    await expect(markHandedOver(env.ctx(OWNER), shipment.id)).rejects.toMatchObject({ code: "shipment.packingIncomplete", params: { packed: 0, required: 1 } });
    await expect(markHandedOver(env.ctx(OWNER), shipment.id, { packingOverride: { reason: "x" } })).rejects.toMatchObject({
      code: "packing.error.overrideReasonRequired",
    });
    expect((await orderRow(orderId)).status).toBe("awaiting_picking");
    expect(await materialConsumes(orderId)).toBe(0);

    await markHandedOver(env.ctx(OWNER), shipment.id, { packingOverride: { reason: "courier waiting, set checked by hand" } });
    expect((await orderRow(orderId)).status).toBe("handed_to_carrier");
    const [p] = await packings(orderId);
    expect(p).toMatchObject({ status: "packed", packedBy: OWNER.id });
    expect(await materialConsumes(orderId)).toBeGreaterThan(0);
    expect(await eventTypes(orderId)).toContain("packed_at_handover");
    const [audit] = await env.handle.db.select().from(auditLog).where(and(eq(auditLog.action, "shipment.handed_over"), eq(auditLog.entityId, shipment.id)));
    expect(audit!.details).toMatchObject({ packing: "incomplete", packingConfirmedAtHandover: true });
  });

  it("manual handover without any packing is allowed but recorded (event, audit); no materials are written off", async () => {
    const id = await env.orderId("#0998"); // накладна тестового перевізника з демо-даних, пакування не розпочинали
    expect((await orderRow(id)).status).toBe("waybill_created");
    const shipment = (await findActiveShipment(env.handle.db, id))!;
    await markHandedOver(env.ctx(OWNER), shipment.id);
    expect((await orderRow(id)).status).toBe("handed_to_carrier");
    expect(await eventTypes(id)).toContain("packing_skipped_handover");
    const [audit] = await env.handle.db.select().from(auditLog).where(and(eq(auditLog.action, "shipment.handed_over"), eq(auditLog.entityId, shipment.id)));
    expect(audit!.details).toMatchObject({ packing: "not_started" });
    expect(await materialConsumes(id)).toBe(0);
  });

  it("carrier-reported handover is never blocked: an unfinished packing is closed and a warning opened", async () => {
    const id = ids["#1002"]!; // пакування розпочате власником, комплект не зібрано
    const shipment = (await findActiveShipment(env.handle.db, id))!;
    const r = await applyTrackingSnapshot(env.ctx(OWNER), shipment.id, snapshot(shipment.waybillNumber!, "accepted"), "Test carrier");
    expect(r).toMatchObject({ newlyHandedOver: true, orderStatus: "handed_to_carrier" });
    expect((await packings(id)).map((p) => p.status)).toEqual(["cancelled"]);
    const [issue] = await openIssues(id, PACKING_SKIPPED_AT_HANDOVER);
    expect(issue).toMatchObject({ severity: "warning", params: { previousStatus: "in_progress", packed: 0, required: 1 } });
    expect(await eventTypes(id)).toContain("packing_skipped_handover");
    expect(await materialConsumes(id)).toBe(0);
  });
});

describe("waybill deleted at the carrier is not packable (packing-11)", () => {
  it("start and the screen refuse it; the queue badges it", async () => {
    const id = ids["#1007"]!;
    const shipment = (await findActiveShipment(env.handle.db, id))!;
    await env.handle.db.update(shipments).set({ trackingStatus: "cancelled" }).where(eq(shipments.id, shipment.id));
    try {
      const screen = await loadPackingScreen(env.ctx(), id);
      expect(screen).toMatchObject({ deletedAtCarrier: true, canStart: false, packedWithoutWaybill: false });
      expect(screen.shipment!.packable).toBe(false);
      await expect(startPacking(env.ctx(STAFF), id)).rejects.toMatchObject({ code: "packing.error.deletedAtCarrier" });
      const row = (await listPackingQueue(env.ctx(), parseQueueFilters(new URLSearchParams()))).rows.find((r) => r.id === id)!;
      expect(row.waybill).toMatchObject({ packable: false, deletedAtCarrier: true });
    } finally {
      await env.handle.db.update(shipments).set({ trackingStatus: null }).where(eq(shipments.id, shipment.id));
    }
  });
});

describe("after handover no 're-issue before handover' advice (e2e-4)", () => {
  it("a parcel mismatch is not reported once the parcel is with the carrier", async () => {
    const id = ids["#1007"]!;
    await startPacking(env.ctx(STAFF), id);
    await scanAll(id);
    let screen = await loadPackingScreen(env.ctx(), id);
    await savePackingParcel(env.ctx(STAFF), id, { expectedVersion: screen.packing!.version, boxMaterialId: screen.packing!.boxMaterialId, weightGrams: 5000 });
    screen = await loadPackingScreen(env.ctx(), id);
    expect(screen.mismatch).not.toBeNull();
    await confirmPacked(env.ctx(STAFF), id, screen.packing!.version);
    expect((await loadPackingSummary(env.handle.db, id)).mismatch).not.toBeNull();
    await markHandedOver(env.ctx(OWNER), (await findActiveShipment(env.handle.db, id))!.id);
    expect((await loadPackingScreen(env.ctx(), id)).mismatch).toBeNull();
    expect((await loadPackingSummary(env.handle.db, id)).mismatch).toBeNull();
    const statuses = await env.handle.db.select({ s: orderPacking.status }).from(orderPacking).where(and(eq(orderPacking.orderId, id), inArray(orderPacking.status, ["packed"])));
    expect(statuses).toHaveLength(1);
  });
});

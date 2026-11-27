/**
 * Регресійні тести станів накладної: невідомий результат, ручний розгляд, пізні відповіді,
 * відмова перевізника скасувати, ручне прив'язування. Використовує керовану заглушку перевізника.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orderLineItems, orders, shipmentEvents, shipments } from "~/db/schema";
import { createCarrierRegistry } from "~/integrations/carriers";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierCapabilities,
  type CreatedShipment,
  type LookupResult,
} from "~/integrations/carriers/types";
import { DomainError } from "~/lib/errors";
import { updateOrderData, validateOrderById } from "~/modules/orders/workflow.server";
import { loadOrderRow } from "~/modules/orders/repository.server";
import {
  cancelOrder,
  cancelWaybill,
  confirmNotCreated,
  createWaybill,
  linkWaybillManually,
  reconcileShipment,
  referenceFor,
} from "~/modules/shipments/waybill.server";
import { loadOrderInvoice } from "~/modules/shipments/documents.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import { createTestEnv, OWNER, type TestEnv } from "../helpers";

class StubCarrier implements CarrierAdapter {
  readonly code = "stub";
  readonly displayName = "Stub carrier";
  readonly mode = "test" as const;
  capabilities: CarrierCapabilities = {
    rates: false,
    availability: false,
    createShipment: true,
    updateShipment: false,
    cancelShipment: true,
    documents: false,
    tracking: false,
    returns: false,
    findByReference: false,
    referenceLookupAuthoritative: false,
  };
  createMode: "ok" | "unknown" | "unavailable" = "unknown";
  cancelResult = true;
  cancelCalls: string[] = [];
  lookup: LookupResult = { found: false, authoritative: false };
  private n = 0;
  async createShipment(): Promise<CreatedShipment> {
    if (this.createMode === "unknown") throw new CarrierError("unknown_outcome", "stub", "timeout");
    if (this.createMode === "unavailable") throw new CarrierError("unavailable", "stub", "carrier down");
    this.n++;
    return { carrierShipmentId: `stub-${this.n}`, waybillNumber: `STUB${String(this.n).padStart(8, "0")}`, trackingNumber: null, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return this.lookup;
  }
  async cancelShipment(number: string) {
    this.cancelCalls.push(number);
    return { cancelled: this.cancelResult };
  }
}

let env: TestEnv;
let stub: StubCarrier;
let ctx: ServiceContext;

beforeAll(async () => {
  env = await createTestEnv();
  stub = new StubCarrier();
  ctx = { ...env.ctx(OWNER), carriers: createCarrierRegistry([stub], stub.code) };
});
afterAll(async () => {
  await env.close();
});

async function readyOrder(number: string): Promise<string> {
  const id = await env.orderId(number);
  await validateOrderById(ctx, id);
  return id;
}

describe("unknown outcome → manual review", () => {
  it("blocks data edits and revalidation while the result is unknown", async () => {
    stub.createMode = "unknown";
    const id = await readyOrder("#1001");
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("unknown");
    const order = await loadOrderRow(ctx.db, id);
    expect(order.automationPaused).toBe(true);
    await expect(
      updateOrderData(ctx, id, { expectedVersion: order.version, shipping: { city: "Potsdam" } }),
    ).rejects.toMatchObject({ code: "waybill.resolveFirst" });
    await expect(validateOrderById(ctx, id)).rejects.toBeInstanceOf(DomainError);
    await expect(cancelOrder(ctx, id)).rejects.toMatchObject({ code: "waybill.resolveFirst" });
    // Повторне створення не надсилає новий запит, а знову звіряє.
    const again = await createWaybill(ctx, id);
    expect(again.kind).toBe("unknown");
    const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(rows).toHaveLength(1);
  });

  it("manual link on an unknown API shipment is cancelled only locally", async () => {
    const id = await env.orderId("#1001");
    const linked = await linkWaybillManually(ctx, id, "cab-123456");
    expect(linked.kind).toBe("created");
    expect((await loadOrderRow(ctx.db, id)).status).toBe("waybill_created");
    const open = await ctx.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.status, "open")));
    expect(open.filter((i) => i.code === "CARRIER_RESULT_UNKNOWN")).toHaveLength(0);
    if (linked.kind !== "created") return;
    stub.cancelCalls = [];
    await cancelWaybill(ctx, linked.shipment.id);
    expect(stub.cancelCalls).toEqual([]); // ручну накладну скасовують у кабінеті перевізника
    expect((await loadOrderRow(ctx.db, id)).status).toBe("awaiting_review");
    // Той самий номер не можна прив'язати повторно навіть до цього замовлення.
    await expect(linkWaybillManually(ctx, id, "CAB-123456")).rejects.toMatchObject({ code: "waybill.alreadyLinked" });
  });

  it("reconcile of a settled shipment changes nothing", async () => {
    const id = await env.orderId("#1001");
    const [cancelled] = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    const res = await reconcileShipment(ctx, cancelled!.id);
    expect(res.kind).toBe("not_created");
    const [after] = await ctx.db.select().from(shipments).where(eq(shipments.id, cancelled!.id));
    expect(after?.status).toBe("cancelled");
  });

  it("lookup that finds a cancelled waybill closes the shipment instead of manual review", async () => {
    stub.createMode = "unknown";
    stub.capabilities = { ...stub.capabilities, findByReference: true };
    stub.lookup = {
      found: true,
      cancelled: true,
      shipment: { carrierShipmentId: "x", waybillNumber: "STUBCANCEL1", trackingNumber: null, createdAt: new Date() },
    };
    const id = await readyOrder("#1009");
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("not_created");
    const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(rows.map((s) => s.status)).toEqual(["cancelled"]);
    stub.capabilities = { ...stub.capabilities, findByReference: false };
    stub.lookup = { found: false, authoritative: false };
  });
});

/** Копія «чистого» демо-замовлення #1001 з новим номером. */
async function cloneReadyOrder(number: string): Promise<string> {
  const db = env.handle.db;
  const [src] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
  const [row] = await db
    .insert(orders)
    .values({ ...rest, orderNumber: number, status: "paid", version: 1, automationPaused: false })
    .returning({ id: orders.id });
  const items = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id));
  for (const { id: _i, orderId: _o, ...item } of items) await db.insert(orderLineItems).values({ ...item, orderId: row!.id, shopifyLineItemId: null });
  await validateOrderById(ctx, row!.id);
  return row!.id;
}

describe("reconcile must not adopt a foreign/older shipment with the same reference", () => {
  const OLD = new Date("2026-01-10T10:00:00Z");

  it("reference is unique per shipment row (order number + generation + row id), ≤ 50 chars", async () => {
    const ref = referenceFor({ orderNumber: "#1001" }, 1, "0f3a9c2e-1111-4222-8333-444455556666");
    expect(ref).toBe("OT-1001-1-0F3A9C2E");
    expect(referenceFor({ orderNumber: "#1001" }, 1, "aa000000-0000-4000-8000-000000000000")).not.toBe(ref);
    expect(referenceFor({ orderNumber: "X".repeat(80) }, 12345, "0f3a9c2e-1111").length).toBeLessThanOrEqual(50);
    stub.createMode = "ok";
    const id = await cloneReadyOrder("#R-REF");
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    expect(r.shipment.carrierReference).toBe(`OT-RREF-1-${r.shipment.id.replace(/-/g, "").slice(0, 8).toUpperCase()}`);
  });

  it("active match created before our shipment row → manual review, not recovered", async () => {
    stub.createMode = "unknown";
    stub.capabilities = { ...stub.capabilities, findByReference: true };
    stub.lookup = {
      found: true,
      cancelled: false,
      shipment: { carrierShipmentId: "old-1", waybillNumber: "STUBOLD00001", trackingNumber: "STUBOLD00001", createdAt: OLD },
    };
    try {
      const id = await cloneReadyOrder("#R-OLD");
      const r = await createWaybill(ctx, id);
      expect(r.kind).toBe("unknown");
      const [row] = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
      expect(row!.status).toBe("unknown");
      expect(row!.waybillNumber).toBeNull();
      const ev = await ctx.db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, row!.id));
      expect(ev.map((e) => e.type)).toContain("reference_match_predates_shipment");
      const open = await ctx.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.status, "open")));
      expect(open.map((i) => i.code)).toContain("CARRIER_RESULT_UNKNOWN");
    } finally {
      stub.capabilities = { ...stub.capabilities, findByReference: false };
      stub.lookup = { found: false, authoritative: false };
    }
  });

  it("deleted match created before our shipment row → manual review, not 'cancelled' (no second create)", async () => {
    stub.createMode = "unknown";
    stub.capabilities = { ...stub.capabilities, findByReference: true };
    stub.lookup = {
      found: true,
      cancelled: true,
      shipment: { carrierShipmentId: "old-2", waybillNumber: "STUBOLD00002", trackingNumber: null, createdAt: OLD },
    };
    try {
      const id = await cloneReadyOrder("#R-DEL");
      const r = await createWaybill(ctx, id);
      expect(r.kind).toBe("unknown");
      const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
      expect(rows.map((s) => s.status)).toEqual(["unknown"]);
    } finally {
      stub.capabilities = { ...stub.capabilities, findByReference: false };
      stub.lookup = { found: false, authoritative: false };
    }
  });

  it("match created after our shipment row is still recovered", async () => {
    stub.createMode = "unknown";
    stub.capabilities = { ...stub.capabilities, findByReference: true };
    stub.lookup = {
      found: true,
      cancelled: false,
      shipment: { carrierShipmentId: "new-1", waybillNumber: "STUBNEW00001", trackingNumber: "STUBNEW00001", createdAt: new Date(Date.now() + 1000) },
    };
    try {
      const id = await cloneReadyOrder("#R-NEW");
      const r = await createWaybill(ctx, id);
      expect(r.kind).toBe("recovered");
    } finally {
      stub.capabilities = { ...stub.capabilities, findByReference: false };
      stub.lookup = { found: false, authoritative: false };
    }
  });
});

describe("printed invoice = invoice sent to the carrier", () => {
  it("failed attempt retried on a later day → print shows the retry date; later settings changes do not alter it", async () => {
    const id = await cloneReadyOrder("#R-INV");
    stub.createMode = "unavailable";
    const day1 = { ...ctx, now: () => new Date("2026-11-20T10:00:00Z") };
    expect((await createWaybill(day1, id)).kind).toBe("not_created");
    stub.createMode = "ok";
    const day3 = { ...ctx, now: () => new Date("2026-11-22T10:00:00Z") };
    const r = await createWaybill(day3, id);
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    const sent = r.shipment.requestSnapshot as { customs: { invoiceDate: string; incoterm: string; totalValue: { amount: string } } };
    expect(sent.customs.invoiceDate).toBe("2026-11-22");

    const customs = await getSetting(ctx.db, "customs");
    const flipped = customs.incoterm === "DAP" ? "DDP" : "DAP";
    await updateSetting(ctx.db, OWNER, "customs", { ...customs, incoterm: flipped });
    try {
      const printed = await loadOrderInvoice(day3, id);
      expect(printed.date).toBe("2026-11-22");
      expect(printed.incoterm).toBe(sent.customs.incoterm);
      expect(printed.goodsTotal).toBe(sent.customs.totalValue.amount);
      expect(printed.waybillNumber).toBe(r.shipment.waybillNumber);
    } finally {
      await updateSetting(ctx.db, OWNER, "customs", customs);
    }
  });
});

describe("in-flight and cancellation guards", () => {
  it("a fresh 'creating' request cannot be declared not created", async () => {
    const id = await readyOrder("#1012");
    const [row] = await ctx.db
      .insert(shipments)
      .values({ orderId: id, carrierCode: stub.code, mode: "test", status: "creating", carrierReference: "OT-TEST-INFLIGHT", createdBy: "test" })
      .returning();
    await expect(confirmNotCreated(ctx, row!.id)).rejects.toMatchObject({ code: "waybill.inProgress" });
    expect((await createWaybill(ctx, id)).kind).toBe("blocked");
    await ctx.db.delete(shipments).where(eq(shipments.id, row!.id));
  });

  it("carrier refusing to cancel keeps the waybill active", async () => {
    stub.createMode = "ok";
    const id = await readyOrder("#1011");
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("created");
    if (r.kind !== "created") return;
    stub.cancelResult = false;
    await expect(cancelWaybill(ctx, r.shipment.id)).rejects.toMatchObject({ code: "waybill.cancelRefused" });
    const [s] = await ctx.db.select().from(shipments).where(eq(shipments.id, r.shipment.id));
    expect(s?.status).toBe("created");
    stub.cancelResult = true;
    await cancelWaybill(ctx, r.shipment.id);
    await expect(cancelWaybill(ctx, r.shipment.id)).rejects.toMatchObject({ code: "waybill.notCancellable" });
    const [o] = await ctx.db.select().from(orders).where(eq(orders.id, id));
    expect(o?.status).toBe("awaiting_review");
  });
});

/**
 * Регресійні тести станів накладної: невідомий результат, ручний розгляд, пізні відповіді,
 * відмова перевізника скасувати, ручне прив'язування. Використовує керовану заглушку перевізника.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orders, shipments } from "~/db/schema";
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
} from "~/modules/shipments/waybill.server";
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
  createMode: "ok" | "unknown" = "unknown";
  cancelResult = true;
  cancelCalls: string[] = [];
  lookup: LookupResult = { found: false, authoritative: false };
  private n = 0;
  async createShipment(): Promise<CreatedShipment> {
    if (this.createMode === "unknown") throw new CarrierError("unknown_outcome", "stub", "timeout");
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

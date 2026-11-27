/**
 * Етап 4: «Переоформити накладну» — скасування у перевізника + нове покоління без дублікатів.
 * Демо-перевізник (sandbox у PGlite) для щасливого шляху й паралельних запитів; керована заглушка —
 * для відмови перевізника скасувати, ручної прив'язки і вимкненого створення.
 */
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, issues, orderChanges, orders, sandboxCarrierShipments, shipmentEvents, shipments } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { createCarrierRegistry } from "~/integrations/carriers";
import { CarrierError, type CarrierAdapter, type CarrierCapabilities, type CreatedShipment, type LookupResult } from "~/integrations/carriers/types";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { dismissIssue, validateOrderById } from "~/modules/orders/workflow.server";
import { problemCategory, problemSource } from "~/modules/problems/categories";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { isReissuable, reissueWaybill } from "~/modules/shipments/reissue.server";
import { cancelWaybill, createWaybill, linkWaybillManually } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../helpers";

class StubCarrier implements CarrierAdapter {
  readonly code = "stub4";
  readonly displayName = "Stub carrier";
  readonly mode = "live" as const;
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
  cancelResult = true;
  cancelThrows: Error | null = null;
  /** Виконується під час запиту скасування (імітація паралельної передачі посилки). */
  onCancel: (() => Promise<void>) | null = null;
  cancelCalls: string[] = [];
  createCalls = 0;
  private n = 0;
  async createShipment(): Promise<CreatedShipment> {
    this.createCalls++;
    this.n++;
    return { carrierShipmentId: `s4-${this.n}`, waybillNumber: `STUB4${String(this.n).padStart(8, "0")}`, trackingNumber: null, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment(number: string) {
    this.cancelCalls.push(number);
    if (this.onCancel) await this.onCancel();
    if (this.cancelThrows) throw this.cancelThrows;
    return { cancelled: this.cancelResult };
  }
}

let env: TestEnv;
let ctx: ServiceContext;
let stub: StubCarrier;
let stubCtx: ServiceContext;

beforeAll(async () => {
  env = await createTestEnv();
  ctx = env.ctx(OWNER);
  stub = new StubCarrier();
  stubCtx = { ...env.ctx(OWNER), carriers: createCarrierRegistry([stub], stub.code) };
});
afterAll(async () => {
  await env.close();
});

async function withWaybill(number: string, c: ServiceContext = ctx) {
  const id = await env.orderId(number);
  await validateOrderById(c, id);
  const r = await createWaybill(c, id);
  if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
  return { id, shipment: r.shipment };
}

async function orderShipments(orderId: string) {
  return ctx.db.select().from(shipments).where(eq(shipments.orderId, orderId));
}

/** Демо-замовлення з проблемами, виправлені напряму (чисті замовлення демо вже використано вище). */
const FIXED_DATA: Record<string, Partial<typeof orders.$inferInsert>> = {
  "#1013": { shipCity: "Stockholm", shipPhone: "+46 70 123 45 67" },
  "#1010": { shipCountryCode: "DE", shipCity: "Berlin", shipPostalCode: "10115", shipPhone: "+49 1512 3456780" },
};

async function patchOrder(number: string, patch: Partial<typeof orders.$inferInsert> = {}) {
  await ctx.db.update(orders).set(patch).where(eq(orders.id, await env.orderId(number)));
}

async function openIssues(orderId: string, code: string) {
  return ctx.db
    .select()
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.code, code), eq(issues.status, "open")));
}

async function eventsOf(shipmentId: string) {
  return ctx.db.select().from(shipmentEvents).where(eq(shipmentEvents.shipmentId, shipmentId));
}

describe("reissueWaybill: happy path (demo test carrier)", () => {
  it("cancels the old waybill at the carrier and creates a new generation with a new reference", async () => {
    const { id, shipment: old } = await withWaybill("#1001");
    expect(isReissuable(old, "waybill_created")).toBe(true);

    const r = await reissueWaybill(ctx, old.id);
    expect(r.kind).toBe("reissued");
    if (r.kind !== "reissued") return;
    expect(r.recovered).toBe(false);
    expect(r.cancelled).toMatchObject({ id: old.id, status: "cancelled" });
    expect(r.created).toMatchObject({ status: "created", generation: old.generation + 1 });
    expect(r.created.carrierReference).not.toBe(old.carrierReference);
    expect(r.created.waybillNumber).not.toBe(old.waybillNumber);

    const rows = await orderShipments(id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((s) => ["creating", "created", "unknown"].includes(s.status))).toHaveLength(1);
    expect((await loadOrderRow(ctx.db, id)).status).toBe("waybill_created");

    // У тестового перевізника стару накладну скасовано, нову створено.
    const remote = await ctx.db
      .select()
      .from(sandboxCarrierShipments)
      .where(inArray(sandboxCarrierShipments.reference, [old.carrierReference, r.created.carrierReference]));
    expect(remote.find((x) => x.reference === old.carrierReference)?.cancelled).toBe(true);
    expect(remote.find((x) => x.reference === r.created.carrierReference)?.cancelled).toBe(false);

    // Історія: скасування з метою «reissue», подія переоформлення; нове покоління — з джерелом reissue.
    const oldEvents = await eventsOf(old.id);
    expect(oldEvents.find((e) => e.type === "cancelled")?.data).toMatchObject({ purpose: "reissue" });
    expect(oldEvents.find((e) => e.type === "reissued")?.data).toMatchObject({ newShipmentId: r.created.id, newGeneration: 2 });
    const newEvents = await eventsOf(r.created.id);
    expect(newEvents.find((e) => e.type === "request_started")?.data).toMatchObject({ source: "reissue" });
    expect(newEvents.map((e) => e.type)).toContain("created");

    const [audit] = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "waybill.reissued"), eq(auditLog.entityId, old.id)));
    // Ідентифікатори в audit_log проходять через redact (він може маскувати цифри UUID) — перевіряємо коди.
    expect(audit?.details).toMatchObject({ outcome: "created", trigger: "order_page", newGeneration: 2, previousGeneration: 1 });

    // Повтор для вже скасованої накладної — відмова, нового покоління немає.
    await expect(reissueWaybill(ctx, old.id)).rejects.toMatchObject({ code: "waybill.notCancellable" });
    expect(await orderShipments(id)).toHaveLength(2);
  });
});

describe("reissueWaybill: duplicate protection", () => {
  it("parallel re-issue requests never produce two active shipments", async () => {
    const { id, shipment: old } = await withWaybill("#1002");
    const results = await Promise.all(Array.from({ length: 4 }, () => reissueWaybill(ctx, old.id).catch((e: unknown) => e)));
    const kinds = results.map((r) => (r instanceof Error ? `error:${(r as { code?: string }).code ?? r.message}` : (r as { kind: string }).kind));
    expect(kinds.filter((k) => k === "reissued")).toHaveLength(1);
    // Решта — «паралельний запит» або відмова для вже скасованої накладної; нічого не створено. Вікно між скасуванням і
    // новою накладною переможця (замовлення «Очікує перевірки») — теж «паралельний запит», не відмова за статусом
    // (детерміновано: tests/stage4/reissue-concurrent-window.test.ts).
    for (const k of kinds.filter((k) => k !== "reissued")) expect(["concurrent", "error:waybill.notCancellable"]).toContain(k);
    const rows = await orderShipments(id);
    expect(rows.filter((s) => ["creating", "created", "unknown"].includes(s.status))).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.filter((s) => s.status === "cancelled").map((s) => s.id)).toEqual([old.id]);
  });
});

describe("reissueWaybill: blocked steps", () => {
  it("carrier refuses to cancel → the old waybill stays active, nothing else changes", async () => {
    const { id, shipment: old } = await withWaybill("#1003", stubCtx);
    const before = await loadOrderRow(ctx.db, id);
    stub.cancelResult = false;
    stub.createCalls = 0;
    try {
      await expect(reissueWaybill(stubCtx, old.id)).rejects.toMatchObject({ code: "waybill.cancelRefused" });
    } finally {
      stub.cancelResult = true;
    }
    expect(stub.createCalls).toBe(0);
    const rows = await orderShipments(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, status: "created", waybillNumber: old.waybillNumber });
    const after = await loadOrderRow(ctx.db, id);
    expect(after.status).toBe("waybill_created");
    expect(after.version).toBe(before.version);
    expect((await eventsOf(old.id)).map((e) => e.type)).toContain("cancel_refused");
  });

  it("no answer from the carrier to the cancellation → «cancel failed», the waybill stays active, a problem asks to check", async () => {
    const id = await env.orderId("#1003");
    const [active] = await ctx.db.select().from(shipments).where(and(eq(shipments.orderId, id), eq(shipments.status, "created")));
    // Явна відмова (попередній тест) проблеми «невідомо, чи скасовано» не відкриває.
    expect(await openIssues(id, "CARRIER_CANCEL_UNKNOWN")).toHaveLength(0);
    stub.cancelThrows = new CarrierError("unknown_outcome", stub.code, "timeout");
    try {
      await expect(reissueWaybill(stubCtx, active!.id)).rejects.toMatchObject({ code: "waybill.cancelFailed" });
      await expect(cancelWaybill(stubCtx, active!.id)).rejects.toMatchObject({ code: "waybill.cancelFailed" });
    } finally {
      stub.cancelThrows = null;
    }
    expect((await orderShipments(id)).map((s) => s.status)).toEqual(["created"]);
    const unknown = await openIssues(id, "CARRIER_CANCEL_UNKNOWN");
    expect(unknown).toHaveLength(1); // без дублікатів
    expect(unknown[0]).toMatchObject({ severity: "error", shipmentId: active!.id, params: { carrier: "Stub carrier", waybill: active!.waybillNumber } });
    expect(problemSource("CARRIER_CANCEL_UNKNOWN")).toBe("carrier");
    expect(problemCategory("CARRIER_CANCEL_UNKNOWN")).toBe("carrier");
  });

  it("dry-run validation blocks the re-issue BEFORE the cancellation → nothing is cancelled", async () => {
    const { id, shipment: old } = await withWaybill("#1007");
    // Дані змінилися після створення накладної (напр. місто втрачено) — нова накладна була б заблокована.
    await ctx.db.update(orders).set({ shipCity: null }).where(eq(orders.id, id));
    const before = await loadOrderRow(ctx.db, id);
    const r = await reissueWaybill(ctx, old.id);
    expect(r).toMatchObject({ kind: "not_started", reason: "validation" });
    if (r.kind !== "not_started") return;
    expect(String(r.params?.issues).split(",")).toContain("CITY_MISSING");
    const rows = await orderShipments(id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: old.id, status: "created" });
    const after = await loadOrderRow(ctx.db, id);
    expect(after).toMatchObject({ status: "waybill_created", version: before.version });
    const [remote] = await ctx.db.select().from(sandboxCarrierShipments).where(eq(sandboxCarrierShipments.reference, old.carrierReference));
    expect(remote?.cancelled).toBe(false);
    expect((await eventsOf(old.id)).map((e) => e.type)).not.toContain("cancelled");
  });

  it("dry-run finds only auto-fixes → re-issue proceeds, fixes are applied with history and the new waybill is created", async () => {
    await patchOrder("#1004", { shipPostalCode: "69001" });
    const { id, shipment: old } = await withWaybill("#1004");
    const city = (await loadOrderRow(ctx.db, id)).shipCity!;
    await ctx.db.update(orders).set({ shipCity: `  ${city}  ` }).where(eq(orders.id, id));
    const r = await reissueWaybill(ctx, old.id);
    expect(r.kind).toBe("reissued");
    const order = await loadOrderRow(ctx.db, id);
    expect(order).toMatchObject({ status: "waybill_created", shipCity: city });
    const changes = await ctx.db.select().from(orderChanges).where(eq(orderChanges.orderId, id));
    expect(changes.some((c) => c.field === "shipping.city" && c.newValue === city)).toBe(true);
    const rows = await orderShipments(id);
    expect(rows.filter((s) => s.status === "created")).toHaveLength(1);
    expect(rows.find((s) => s.id === old.id)?.status).toBe("cancelled");
  });

  it("creating the new waybill throws after the cancellation → «old one IS cancelled», never a generic error", async () => {
    await patchOrder("#1005", { shipProvince: "TX" });
    const { id, shipment: old } = await withWaybill("#1005", stubCtx);
    let calls = 0;
    const throwing: ServiceContext = {
      ...stubCtx,
      carriers: {
        ...stubCtx.carriers,
        getDefault: () => {
          calls++;
          if (calls > 1) throw new Error("db down");
          return stubCtx.carriers.getDefault();
        },
      },
    };
    const r = await reissueWaybill(throwing, old.id);
    expect(r).toMatchObject({ kind: "cancelled_only", cancelled: { id: old.id, status: "cancelled" }, next: { kind: "error", code: "error.generic" } });
    expect((await orderShipments(id)).map((s) => s.status)).toEqual(["cancelled"]);
    expect((await loadOrderRow(ctx.db, id)).status).toBe("awaiting_review");
    expect((await eventsOf(old.id)).find((e) => e.type === "reissue_blocked")?.data).toMatchObject({ outcome: "error", code: "error.generic" });
  });

  it("handover recorded while the carrier cancels → error issue CARRIER_CANCEL_CONFLICT and a distinct error (cancel and re-issue)", async () => {
    for (const [number, run] of [
      ["#1013", (sid: string) => cancelWaybill(stubCtx, sid)],
      ["#1010", (sid: string) => reissueWaybill(stubCtx, sid)],
    ] as const) {
      await patchOrder(number, FIXED_DATA[number]);
      const { id, shipment } = await withWaybill(number, stubCtx);
      stub.onCancel = async () => {
        await ctx.db.update(shipments).set({ handedOverAt: new Date() }).where(eq(shipments.id, shipment.id));
      };
      stub.createCalls = 0;
      try {
        await expect(run(shipment.id), number).rejects.toMatchObject({
          code: "waybill.cancelledButHandedOver",
          params: { number: shipment.waybillNumber },
        });
      } finally {
        stub.onCancel = null;
      }
      expect(stub.createCalls).toBe(0);
      const [row] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipment.id));
      expect(row?.status).toBe("created");
      // Подію й проблему збережено (транзакцію не відкочено).
      expect((await eventsOf(shipment.id)).find((e) => e.type === "cancel_conflict_handed_over")?.data).toMatchObject({ carrierCancelled: true });
      const conflict = await openIssues(id, "CARRIER_CANCEL_CONFLICT");
      expect(conflict).toHaveLength(1);
      expect(conflict[0]).toMatchObject({ severity: "error", params: { carrier: "Stub carrier", waybill: shipment.waybillNumber } });
      // Менеджер закриває після з'ясування з перевізником.
      await dismissIssue(ctx, conflict[0]!.id);
      expect(await openIssues(id, "CARRIER_CANCEL_CONFLICT")).toHaveLength(0);
    }
  });

  it("a successful cancellation closes the «unknown whether cancelled» problem", async () => {
    const id = await env.orderId("#1003");
    const [active] = await ctx.db.select().from(shipments).where(and(eq(shipments.orderId, id), eq(shipments.status, "created")));
    expect(await openIssues(id, "CARRIER_CANCEL_UNKNOWN")).toHaveLength(1);
    await cancelWaybill(stubCtx, active!.id);
    expect(await openIssues(id, "CARRIER_CANCEL_UNKNOWN")).toHaveLength(0);
  });

  it("carrier rejects the new waybill (simulation) → old cancelled, rejection explained", async () => {
    const { id, shipment: old } = await withWaybill("#1011");
    const sim = await getSetting(ctx.db, "testCarrier");
    await updateSetting(ctx.db, OWNER, "testCarrier", { ...sim, simulation: "reject" });
    try {
      const r = await reissueWaybill(ctx, old.id);
      expect(r).toMatchObject({ kind: "cancelled_only", next: { kind: "rejected" } });
    } finally {
      await updateSetting(ctx.db, OWNER, "testCarrier", sim);
    }
    const rows = await orderShipments(id);
    expect(rows.filter((s) => ["creating", "created", "unknown"].includes(s.status))).toHaveLength(0);
  });

  it("creation disabled for the carrier → nothing is cancelled (pre-check)", async () => {
    const { id, shipment: old } = await withWaybill("#1012", stubCtx);
    stub.capabilities = { ...stub.capabilities, createShipment: false };
    stub.cancelCalls = [];
    try {
      const r = await reissueWaybill(stubCtx, old.id);
      expect(r).toEqual({ kind: "not_started", reason: "carrier_not_configured", params: { carrier: "Stub carrier" } });
    } finally {
      stub.capabilities = { ...stub.capabilities, createShipment: true };
    }
    expect(stub.cancelCalls).toEqual([]);
    expect((await orderShipments(id))[0]).toMatchObject({ id: old.id, status: "created" });
  });

  it("a manually linked waybill is cancelled only locally, then a new API waybill is created", async () => {
    const id = await env.orderId("#1009");
    await validateOrderById(stubCtx, id);
    const linked = await linkWaybillManually(stubCtx, id, "MAN-4000001");
    if (linked.kind !== "created") throw new Error(linked.kind);
    stub.cancelCalls = [];
    const r = await reissueWaybill(stubCtx, linked.shipment.id);
    expect(r.kind).toBe("reissued");
    expect(stub.cancelCalls).toEqual([]);
    const rows = await orderShipments(id);
    expect(rows.filter((s) => s.status === "created")).toHaveLength(1);
    expect(rows.find((s) => s.id === linked.shipment.id)?.status).toBe("cancelled");
  });
});

describe("reissueWaybill: refusals", () => {
  it("refuses after the handover and for a shipped order", async () => {
    // #1001 переоформлено вище — беремо його активну накладну (нове покоління).
    const id = await env.orderId("#1001");
    const [shipment] = await ctx.db.select().from(shipments).where(and(eq(shipments.orderId, id), eq(shipments.status, "created")));
    if (!shipment) throw new Error("no active shipment");
    await ctx.db.update(shipments).set({ handedOverAt: new Date() }).where(eq(shipments.id, shipment.id));
    await expect(reissueWaybill(ctx, shipment.id)).rejects.toMatchObject({ code: "waybill.alreadyHandedOver" });
    const [row] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipment.id));
    expect(row?.status).toBe("created");
    expect(isReissuable(row!, "waybill_created")).toBe(false);
    expect((await orderShipments(id)).filter((s) => s.status === "created")).toHaveLength(1);

    // Доставлене замовлення з демо-даних (#0997): статус не дозволяє переоформлення.
    const delivered = await env.orderId("#0997");
    const [dShip] = await ctx.db.select().from(shipments).where(eq(shipments.orderId, delivered));
    await expect(reissueWaybill(ctx, dShip!.id)).rejects.toMatchObject({ code: "waybill.reissueNotAllowed", params: { status: "delivered" } });
  });

  it("staff without waybills.manage is forbidden; manage without create is forbidden before anything changes", async () => {
    const id = await env.orderId("#0998");
    const [ship] = await ctx.db.select().from(shipments).where(and(eq(shipments.orderId, id), eq(shipments.status, "created")));
    await expect(reissueWaybill(env.ctx(STAFF), ship!.id)).rejects.toBeInstanceOf(ForbiddenError);
    const manageOnly = makeActor({
      id: "test-manage-only",
      displayName: "Manage only",
      role: "staff",
      overrides: { grant: ["waybills.manage"], revoke: ["waybills.create"] },
    });
    await expect(reissueWaybill(env.ctx(manageOnly), ship!.id)).rejects.toBeInstanceOf(ForbiddenError);
    const [after] = await ctx.db.select().from(shipments).where(eq(shipments.id, ship!.id));
    expect(after?.status).toBe("created");
  });
});

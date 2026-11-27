import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import {
  inventoryMovements,
  orderLineItems,
  orders,
  productVariants,
  shipments,
  stockReservations,
  warehouses,
} from "~/db/schema";
import { insertSimulatedOrder } from "~/db/seed/seed.server";
import { ForbiddenError, SYSTEM_ACTOR } from "~/domain/permissions";
import { getBalances } from "~/modules/inventory/ledger.server";
import { initializeInventory, syncAllOpenOrderReservations } from "~/modules/inventory/opening.server";
import { loadOrderReservations, syncOrderReservations } from "~/modules/inventory/reservations.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { cancelOrder, createWaybill } from "~/modules/shipments/waybill.server";
import { applyTrackingSnapshot, markHandedOver } from "~/modules/tracking/tracking.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { ACTOR, balance, movementCount, stockItemFor } from "./helpers";

/** Резерви й списання замовлень на демо-базі (демо-заповнення ініціалізує склад). */
let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function lineOf(orderId: string) {
  const lines = await env.handle.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  return lines;
}

async function reservationOf(lineItemId: string) {
  const [r] = await env.handle.db.select().from(stockReservations).where(eq(stockReservations.orderLineItemId, lineItemId));
  return r;
}

describe("opening balances (demo seed → initializeInventory)", () => {
  it("the default warehouse is initialized and app 'available' equals the Shopify snapshot for every variant", async () => {
    const w = await getDefaultWarehouse(env.handle.db);
    expect(w.inventoryInitializedAt).toBeInstanceOf(Date);
    const variants = await env.handle.db.select().from(productVariants);
    const { rows } = await getBalances(env.handle.db, {}, { limit: 500 });
    for (const v of variants) {
      const b = rows.find((r) => r.variantId === v.id)!;
      // on_hand = available Shopify + резерви відкритих замовлень → доступно застосунку = available Shopify.
      expect(b.available, v.sku ?? "").toBe(v.inventoryAvailable);
      expect(b.onHand - b.reserved).toBe(v.inventoryAvailable);
    }
  });

  it("open orders are reserved; delivered history is untracked; cancelled is not reserved", async () => {
    const open = await env.orderId("#1001");
    const delivered = await env.orderId("#0997");
    const cancelled = await env.orderId("#0996");
    const waybill = await env.orderId("#0998");
    for (const l of await lineOf(open)) expect(await reservationOf(l.id)).toMatchObject({ status: "reserved", reservedQty: l.quantity });
    for (const l of await lineOf(waybill)) expect(await reservationOf(l.id)).toMatchObject({ status: "reserved", reservedQty: l.quantity });
    expect(await loadOrderReservations(env.handle.db, delivered)).toEqual([]);
    expect(await loadOrderReservations(env.handle.db, cancelled)).toEqual([]);
  });

  it("is idempotent: a second run opens nothing and changes no balance", async () => {
    const before = await getBalances(env.handle.db, {}, { limit: 500 });
    const movements = await movementCount(env.handle.db);
    const r = await initializeInventory(env.ctx(OWNER));
    expect(r).toMatchObject({ alreadyInitialized: true, opened: 0 });
    expect(r.alreadyOpened).toBeGreaterThan(0);
    expect(await movementCount(env.handle.db)).toBe(movements);
    const after = await getBalances(env.handle.db, {}, { limit: 500 });
    expect(after.rows.map((x) => [x.sku, x.onHand, x.reserved])).toEqual(before.rows.map((x) => [x.sku, x.onHand, x.reserved]));
  });

  it("staff cannot initialize inventory", async () => {
    await expect(initializeInventory(env.ctx(STAFF))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("re-syncing every open order changes nothing", async () => {
    const movements = await movementCount(env.handle.db);
    await syncAllOpenOrderReservations(env.ctx(OWNER));
    expect(await movementCount(env.handle.db)).toBe(movements);
  });
});

describe("reservation lifecycle", () => {
  it("new paid order → reserved in the same transaction; repeated sync does not double", async () => {
    const orderId = await insertSimulatedOrder(env.ctx(OWNER));
    const [line] = await lineOf(orderId);
    const item = await stockItemFor(env.handle.db, line!.variantId!);
    const reservedBefore = (await balance(env.handle.db, item)).reserved;
    expect(await reservationOf(line!.id)).toMatchObject({ status: "reserved", reservedQty: line!.quantity, seq: 1 });
    for (let i = 0; i < 3; i++) await env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    expect((await balance(env.handle.db, item)).reserved).toBe(reservedBefore);
    expect(await movementCount(env.handle.db, { key: `reserve:${line!.id}:1` })).toBe(1);
    expect(await movementCount(env.handle.db, { key: `reserve:${line!.id}:2` })).toBe(0);
  });

  it("quantity changes adjust the reservation by the delta (versioned keys)", async () => {
    const orderId = await insertSimulatedOrder(env.ctx(OWNER));
    const [line] = await lineOf(orderId);
    const item = await stockItemFor(env.handle.db, line!.variantId!);
    const base = (await balance(env.handle.db, item)).reserved;
    const q0 = line!.quantity;
    await env.handle.db.update(orderLineItems).set({ quantity: q0 + 2 }).where(eq(orderLineItems.id, line!.id));
    await env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    expect((await balance(env.handle.db, item)).reserved).toBe(base + 2);
    expect(await reservationOf(line!.id)).toMatchObject({ reservedQty: q0 + 2, seq: 2 });
    await env.handle.db.update(orderLineItems).set({ quantity: 1 }).where(eq(orderLineItems.id, line!.id));
    await env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    expect((await balance(env.handle.db, item)).reserved).toBe(base - q0 + 1);
    expect(await reservationOf(line!.id)).toMatchObject({ reservedQty: 1, seq: 3, status: "reserved" });
    const keys = (
      await env.handle.db.select({ key: inventoryMovements.idempotencyKey }).from(inventoryMovements).where(eq(inventoryMovements.orderLineItemId, line!.id))
    ).map((r) => r.key);
    expect(keys.sort()).toEqual([`release:${line!.id}:3`, `reserve:${line!.id}:1`, `reserve:${line!.id}:2`].sort());
  });

  it("cancel → reservation released (once) together with the cancellation", async () => {
    const orderId = await insertSimulatedOrder(env.ctx(OWNER));
    const [line] = await lineOf(orderId);
    const item = await stockItemFor(env.handle.db, line!.variantId!);
    const before = await balance(env.handle.db, item);
    await cancelOrder(env.ctx(OWNER), orderId);
    const after = await balance(env.handle.db, item);
    expect(before.reserved - after.reserved).toBe(line!.quantity);
    expect(after.onHand).toBe(before.onHand);
    expect(await reservationOf(line!.id)).toMatchObject({ status: "released", reservedQty: 0 });
    await env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    expect((await balance(env.handle.db, item)).reserved).toBe(after.reserved);
  });

  it("handover → consumed exactly once even when synced 3×; on_hand drops by the quantity", async () => {
    const ctx = env.ctx(OWNER);
    const orderId = await env.orderId("#1001");
    await validateOrderById(ctx, orderId, "manual");
    const created = await createWaybill(ctx, orderId);
    expect(created.kind).toBe("created");
    const lines = await lineOf(orderId);
    const items = await Promise.all(lines.map((l) => stockItemFor(env.handle.db, l.variantId!)));
    const before = await Promise.all(items.map((i) => balance(env.handle.db, i)));
    const shipmentId = created.kind === "created" ? created.shipment.id : "";
    await markHandedOver(ctx, shipmentId);
    for (let i = 0; i < 3; i++) await env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    // Повторне застосування статусу відстеження теж не списує вдруге.
    await applyTrackingSnapshot(ctx, shipmentId, { waybillNumber: "x", status: "in_transit", carrierStatusCode: "5", carrierStatusText: null, statusAt: new Date(), events: [] }, "Test");
    for (const [i, l] of lines.entries()) {
      const after = await balance(env.handle.db, items[i]!);
      expect(before[i]!.onHand - after.onHand).toBe(l.quantity);
      expect(before[i]!.reserved - after.reserved).toBe(l.quantity);
      expect(await reservationOf(l.id)).toMatchObject({ status: "consumed", consumedQty: l.quantity, reservedQty: 0 });
      expect(await movementCount(env.handle.db, { key: `consume:${l.id}` })).toBe(1);
    }
    const [order] = await env.handle.db.select().from(orders).where(eq(orders.id, orderId));
    expect(order!.status).toBe("in_transit");
  });

  it("tracking handover consumes inside applyTrackingSnapshot", async () => {
    const ctx = env.ctx(OWNER);
    const orderId = await env.orderId("#0998");
    const [shipment] = await env.handle.db
      .select()
      .from(shipments)
      .where(and(eq(shipments.orderId, orderId), eq(shipments.status, "created")));
    const lines = await lineOf(orderId);
    const item = await stockItemFor(env.handle.db, lines[0]!.variantId!);
    const before = await balance(env.handle.db, item);
    const snap = { waybillNumber: shipment!.waybillNumber!, status: "accepted" as const, carrierStatusCode: "1", carrierStatusText: null, statusAt: new Date(), events: [] };
    const r1 = await applyTrackingSnapshot(ctx, shipment!.id, snap, "Test");
    const r2 = await applyTrackingSnapshot(ctx, shipment!.id, snap, "Test");
    expect(r1?.newlyHandedOver).toBe(true);
    expect(r2?.newlyHandedOver).toBe(false);
    const after = await balance(env.handle.db, item);
    expect(before.onHand - after.onHand).toBe(lines[0]!.quantity);
    expect(await movementCount(env.handle.db, { key: `consume:${lines[0]!.id}` })).toBe(1);
  });

  it("parallel syncs of the same order do not double-reserve", async () => {
    const orderId = await insertSimulatedOrder(env.ctx(OWNER));
    const [line] = await lineOf(orderId);
    const item = await stockItemFor(env.handle.db, line!.variantId!);
    const base = (await balance(env.handle.db, item)).reserved;
    await env.handle.db.update(orderLineItems).set({ quantity: line!.quantity + 3 }).where(eq(orderLineItems.id, line!.id));
    await Promise.all(Array.from({ length: 6 }, () => env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR))));
    expect((await balance(env.handle.db, item)).reserved).toBe(base + 3);
    expect(await reservationOf(line!.id)).toMatchObject({ reservedQty: line!.quantity + 3, seq: 2 });
  });

  it("removed line items release their reservation; lines without a variant are skipped", async () => {
    const orderId = await insertSimulatedOrder(env.ctx(OWNER));
    const [line] = await lineOf(orderId);
    const item = await stockItemFor(env.handle.db, line!.variantId!);
    const base = (await balance(env.handle.db, item)).reserved;
    await env.handle.db.insert(orderLineItems).values({
      orderId,
      variantId: null,
      title: "Gift wrap",
      quantity: 1,
      unitPrice: "1.00",
      currency: "EUR",
      position: 9,
    });
    await env.handle.db.delete(orderLineItems).where(eq(orderLineItems.id, line!.id));
    const r = await env.handle.db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    expect(r.applied).toBe(1);
    expect((await balance(env.handle.db, item)).reserved).toBe(base - line!.quantity);
    expect(await reservationOf(line!.id)).toMatchObject({ status: "released", reservedQty: 0 });
    expect(await loadOrderReservations(env.handle.db, orderId)).toHaveLength(1);
  });
});

describe("not initialized warehouse", () => {
  it("does not reserve before initializeInventory", async () => {
    const fresh = await createTestEnv({ seed: false });
    try {
      const { seedReferenceData, DEMO_SETTINGS } = await import("~/db/seed/seed.server");
      await seedReferenceData(fresh.handle.db, DEMO_SETTINGS);
      const [w] = await fresh.handle.db.select().from(warehouses).where(eq(warehouses.isDefault, true));
      expect(w?.inventoryInitializedAt).toBeNull();
      // Замовлення без варіантів достатньо, щоб перевірити, що синхронізація нічого не робить.
      const [o] = await fresh.handle.db
        .insert(orders)
        .values({ source: "demo", orderNumber: "#T1", currency: "EUR", subtotal: "1.00", total: "1.00" })
        .returning({ id: orders.id });
      const r = await fresh.handle.db.transaction((tx) => syncOrderReservations(tx, o!.id, SYSTEM_ACTOR));
      expect(r.state).toBe("not_initialized");
      expect(await fresh.handle.db.select().from(stockReservations)).toEqual([]);
      expect(await fresh.handle.db.select().from(inventoryMovements).where(inArray(inventoryMovements.type, ["reserve"]))).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});

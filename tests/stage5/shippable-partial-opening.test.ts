import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  inventoryBalances,
  inventoryConflicts,
  inventoryMovements,
  orderLineItems,
  orders,
  stockAlerts,
  stockReservations,
  warehouses,
} from "~/db/schema";
import type { Db } from "~/db/client.server";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { syncOrderReservations } from "~/modules/inventory/reservations.server";
import { OWNER, createTestEnv, type TestEnv } from "../helpers";
import { ACTOR, balance, insertProduct, stockItemFor } from "./helpers";

/**
 * R5B-2: замовлення до знімка, у якому Shopify виконав ЛИШЕ позиції без доставки (partially_fulfilled +
 * shopify_shippable_fulfilled = false: подарункова картка), — фізичні позиції ще committed у Shopify й на складі:
 * відкриття обліку їх рахує й резервує, перша поява в syncOrderReservations — резервує. null/true — як раніше
 * (виконано поза застосунком: не рахується й не резервується). Дані вигадані.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const HOUR = 3_600_000;
let seq = 0;

async function preSnapshotOrder(db: Db, variantId: string, shippable: boolean | null, fulfillmentStatus = "partially_fulfilled") {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: `#T-SHP-${seq}`,
      currency: "EUR",
      subtotal: "20.00",
      total: "20.00",
      placedAt: new Date(Date.now() - 2 * HOUR),
      fulfillmentStatus,
      shopifyShippableFulfilled: shippable,
    })
    .returning({ id: orders.id });
  await db.insert(orderLineItems).values({ orderId: o!.id, variantId, title: "Physical item", quantity: 2, currentQuantity: 2, unitPrice: "10.00", currency: "EUR" });
  return o!.id;
}

async function reservedOf(db: Db, orderId: string) {
  const rows = await db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
  return rows.reduce((s, r) => s + r.reservedQty, 0);
}

describe("first appearance of a pre-snapshot order fulfilled only for non-shipping lines (syncOrderReservations)", () => {
  it("shippable_fulfilled=false → the physical line is reserved and on_hand corrected; null/true → not reserved", async () => {
    const db = env.handle.db;
    const { variantIds } = await insertProduct(db, "R5B2 Reserve", [{ sku: "R5B2-RES", available: 5 }]);
    const variantId = variantIds[0]!;
    const stockItemId = await stockItemFor(db, variantId); // відкрито зараз: замовлення нижче — «у знімку»
    const digitalOnly = await preSnapshotOrder(db, variantId, false);
    const unknown = await preSnapshotOrder(db, variantId, null);
    const physical = await preSnapshotOrder(db, variantId, true);
    const before = await balance(db, stockItemId);

    for (const id of [digitalOnly, unknown, physical]) await db.transaction((tx) => syncOrderReservations(tx, id, ACTOR));

    expect(await reservedOf(db, digitalOnly)).toBe(2);
    expect(await reservedOf(db, unknown)).toBe(0);
    expect(await reservedOf(db, physical)).toBe(0);
    const after = await balance(db, stockItemId);
    // Одиниці замовлення були committed у знімку → on_hand +2 (opening_line), резерв 2: «доступно» не змінилося.
    expect(after.onHand - before.onHand).toBe(2);
    expect(after.reserved - before.reserved).toBe(2);
    // Повторна синхронізація нічого не додає (без подвійного резерву).
    await db.transaction((tx) => syncOrderReservations(tx, digitalOnly, ACTOR));
    expect(await reservedOf(db, digitalOnly)).toBe(2);
    expect(await balance(db, stockItemId)).toMatchObject({ onHand: after.onHand, reserved: after.reserved });
  });
});

describe("opening the inventory (initializeInventory) with such orders before the snapshot", () => {
  it("counts and reserves the physical line of a digital-only partial fulfilment; excludes null/true as fulfilled outside", async () => {
    const db = env.handle.db;
    // Облік «не ініціалізовано» (демо-базу ініціалізовано при заповненні).
    await db.delete(inventoryMovements);
    await db.delete(stockReservations);
    await db.delete(stockAlerts);
    await db.delete(inventoryConflicts);
    await db.delete(inventoryBalances);
    await db.update(warehouses).set({ inventoryInitializedAt: null });

    const { variantIds } = await insertProduct(db, "R5B2 Opening", [{ sku: "R5B2-OPEN", available: 6 }]);
    const variantId = variantIds[0]!;
    const digitalOnly = await preSnapshotOrder(db, variantId, false);
    const unknown = await preSnapshotOrder(db, variantId, null);
    const physical = await preSnapshotOrder(db, variantId, true);
    const fulfilled = await preSnapshotOrder(db, variantId, false, "fulfilled");

    const r = await initializeInventory(env.ctx(OWNER));
    // Виключено як «виконано поза застосунком» — по одній позиції: null, true і повністю виконане цього тесту + null і
    // true з попереднього тесту (демо-замовлення не виконані в Shopify). Digital-only (обидва тести) — не виключено.
    const ours = [unknown, physical, fulfilled];
    expect(r.excludedFulfilledLines).toBe(5);
    const stockItemId = await ensureStockItemForVariant(db, variantId);
    // Знімок «доступно» 6 + 2 committed одиниці digital-only замовлення → on_hand 8, резерв 2, «доступно» 6.
    expect(await balance(db, stockItemId)).toMatchObject({ onHand: 8, reserved: 2 });
    expect(await reservedOf(db, digitalOnly)).toBe(2);
    for (const id of ours) expect(await reservedOf(db, id)).toBe(0);
  });
});

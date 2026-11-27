import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import {
  inventoryBalances,
  inventoryConflicts,
  inventoryMovements,
  orderLineItems,
  orders,
  productVariants,
  products,
  stockAlerts,
  stockReservations,
  warehouses,
} from "~/db/schema";
import type { Db } from "~/db/client.server";
import { applyMovements, ensureStockItemForVariant, lockBalances } from "~/modules/inventory/ledger.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import { NON_RESERVING_STATUSES, getInventoryOpeningStatus, initializeInventory, syncAllOpenOrderReservations } from "~/modules/inventory/opening.server";
import { syncOrderReservations } from "~/modules/inventory/reservations.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import { OWNER, createTestEnv, type TestEnv } from "../helpers";
import { ACTOR, apply, balance, movementCount } from "./helpers";

/**
 * Відкриття обліку (initializeInventory) — регресійні тести незалежного огляду:
 * атомарність знімка й резервів, відсутність взаємоблокувань, додавання внутрішньої історії, відкриття нових варіантів.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv(); // демо: склад уже ініціалізовано
});
afterAll(async () => {
  await env.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Повертає облік демо-бази до стану «склад не ініціалізовано» (рухи, резерви, баланси видалено). */
async function resetLedger(db: Db) {
  await db.delete(inventoryMovements);
  await db.delete(stockReservations);
  await db.delete(stockAlerts);
  await db.delete(inventoryConflicts);
  await db.delete(inventoryBalances);
  await db.update(warehouses).set({ inventoryInitializedAt: null });
}

async function newVariant(db: Db, sku: string, available: number | null) {
  const [p] = await db.insert(products).values({ title: `P ${sku}`, handle: `p-${sku.toLowerCase()}` }).returning({ id: products.id });
  const [v] = await db
    .insert(productVariants)
    .values({ productId: p!.id, title: sku, sku, price: "1.00", currency: "EUR", inventoryAvailable: available })
    .returning({ id: productVariants.id });
  return v!.id;
}

describe("atomic opening (snapshot + reservations in one transaction)", () => {
  it("an order handed over right after initialization is written off (no window without a reservation)", async () => {
    const db = env.handle.db;
    const ctx = env.ctx(OWNER);
    const target = await env.orderId("#1001");
    await validateOrderById(ctx, target, "manual");
    const created = await createWaybill(ctx, target);
    expect(created.kind).toBe("created");
    const shipmentId = created.kind === "created" ? created.shipment.id : "";
    await resetLedger(db);

    // Передача відбувається одразу після ПЕРШОЇ транзакції ініціалізації (раніше — між знімком і резервами).
    let hooked = false;
    const proxied = new Proxy(db, {
      get(target_, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target_, prop, receiver);
        return async (fn: Parameters<Db["transaction"]>[0]) => {
          const result = await target_.transaction(fn);
          if (!hooked) {
            hooked = true;
            await markHandedOver(ctx, shipmentId);
          }
          return result;
        };
      },
    }) as Db;
    const lines = await db.select().from(orderLineItems).where(and(eq(orderLineItems.orderId, target), isNotNull(orderLineItems.variantId)));
    const r = await initializeInventory({ ...ctx, db: proxied });
    expect(hooked).toBe(true);
    expect(r.ordersSynced).toBeGreaterThan(0);
    const [order] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, target));
    expect(order!.status).toBe("handed_to_carrier");
    for (const l of lines) {
      const item = await ensureStockItemForVariant(db, l.variantId!);
      const [v] = await db.select().from(productVariants).where(eq(productVariants.id, l.variantId!));
      const b = await balance(db, item);
      // Списано: доступно = знімок Shopify, фізично — мінус передані одиниці.
      expect(b.onHand - b.reserved, v!.sku ?? "").toBe(v!.inventoryAvailable);
      expect(await movementCount(db, { key: inventoryKeys.consume(l.id) })).toBe(1);
      const [res] = await db.select().from(stockReservations).where(eq(stockReservations.orderLineItemId, l.id));
      expect(res).toMatchObject({ status: "consumed", consumedQty: l.quantity, reservedQty: 0 });
    }
  });

  it("every open order is reserved by the opening itself; the recovery sync is a no-op and fault tolerant", async () => {
    const db = env.handle.db;
    const open = await db.select({ id: orders.id }).from(orders).where(notInArray(orders.status, [...NON_RESERVING_STATUSES]));
    for (const o of open) {
      const lines = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id));
      const res = await db.select().from(stockReservations).where(eq(stockReservations.orderId, o.id));
      expect(res.length, o.id).toBe(lines.filter((l) => l.variantId).length);
    }
    const before = await movementCount(db);
    const r = await syncAllOpenOrderReservations(env.ctx(OWNER));
    expect(r).toEqual({ synced: open.length, failed: [] });
    expect(await movementCount(db)).toBe(before);
  });
});

describe("re-initialization opens new variants without losing internal movements", () => {
  it("receipts recorded before opening are kept (added to the Shopify snapshot) and flagged as a conflict", async () => {
    const db = env.handle.db;
    const variantId = await newVariant(db, "NEW-GRN", 5);
    const item = await ensureStockItemForVariant(db, variantId);
    // 50 одиниць з виробництва до відкриття: Shopify про них не знає ("skipped").
    const rcpt = await apply(db, { stockItemId: item, type: "receipt_manual", idempotencyKey: inventoryKeys.manual("t-open-rcpt"), onHandDelta: 50, reason: "test" });
    expect(rcpt.applied[0]!.shopifySyncState).toBe("skipped");
    expect((await getInventoryOpeningStatus(db)).unopenedTracked).toBe(1);
    const r = await initializeInventory(env.ctx(OWNER));
    expect(r).toMatchObject({ alreadyInitialized: true, opened: 1, openedWithHistory: 1 });
    expect(await balance(db, item)).toMatchObject({ onHand: 55, reserved: 0 });
    const [conflict] = await db.select().from(inventoryConflicts).where(eq(inventoryConflicts.stockItemId, item));
    expect(conflict).toMatchObject({ status: "open", appOnHand: 55, shopifyOnHand: 5, shopifyAvailable: 5 });
    expect(conflict!.details).toMatchObject({ reason: "opened_with_internal_history", internalOnHand: 50 });
    // Повторний запуск нічого не змінює.
    const again = await initializeInventory(env.ctx(OWNER));
    expect(again.opened).toBe(0);
    expect(await balance(db, item)).toMatchObject({ onHand: 55 });
    expect((await getInventoryOpeningStatus(db)).unopenedTracked).toBe(0);
  });

  it("untracked variants (Shopify does not track stock) are never opened, reserved or alerted", async () => {
    const db = env.handle.db;
    const variantId = await newVariant(db, "UNTRACKED-1", null);
    const r = await initializeInventory(env.ctx(OWNER));
    expect(r.skippedUntracked).toBeGreaterThanOrEqual(1);
    const [o] = await db
      .insert(orders)
      .values({ source: "demo", orderNumber: "#T-UNTR", currency: "EUR", subtotal: "2.00", total: "2.00" })
      .returning({ id: orders.id });
    const [line] = await db
      .insert(orderLineItems)
      .values({ orderId: o!.id, variantId, title: "U", quantity: 2, unitPrice: "1.00", currency: "EUR" })
      .returning({ id: orderLineItems.id });
    const res = await db.transaction((tx) => syncOrderReservations(tx, o!.id, ACTOR));
    expect(res.applied).toBe(0);
    expect(await db.select().from(stockReservations).where(eq(stockReservations.orderLineItemId, line!.id))).toEqual([]);
    const item = await ensureStockItemForVariant(db, variantId);
    expect(await db.select().from(stockAlerts).where(eq(stockAlerts.stockItemId, item))).toEqual([]);
    // Пряме резервування невідкритого товару заборонене ядром.
    await expect(apply(db, { stockItemId: item, type: "reserve", idempotencyKey: "t:untracked:r", reservedDelta: 1 })).rejects.toMatchObject({
      code: "inventory.notOpened",
    });
  });
});

describe("concurrency with initialization (real PostgreSQL)", () => {
  it("'set value' (lockBalances → applyMovements) on a variant being opened does not deadlock", async () => {
    if (env.handle.driver !== "pg") return;
    const db = env.handle.db;
    const w = await getDefaultWarehouse(db);
    const variantId = await newVariant(db, "NEW-CNT", 5);
    const item = await ensureStockItemForVariant(db, variantId);
    await db.transaction((tx) => lockBalances(tx, [{ warehouseId: w.id, stockItemId: item }]));
    const errors: string[] = [];
    const count = db
      .transaction(async (tx) => {
        const locked = await lockBalances(tx, [{ warehouseId: w.id, stockItemId: item }]);
        await sleep(400);
        const current = locked.get(`${w.id}|${item}`)!.onHand;
        await applyMovements(tx, ACTOR, [
          { warehouseId: w.id, stockItemId: item, type: "adjustment", idempotencyKey: inventoryKeys.manual("t-cnt-1"), onHandDelta: 7 - current, reason: "stocktake" },
        ]);
      })
      .catch((e: unknown) => errors.push(`count: ${String((e as { cause?: unknown }).cause ?? e)}`));
    await sleep(100);
    const init = initializeInventory(env.ctx(OWNER)).catch((e: unknown) => errors.push(`init: ${String((e as { cause?: unknown }).cause ?? e)}`));
    await Promise.all([count, init]);
    expect(errors).toEqual([]);
    // Інвентаризація (7) до відкриття + знімок Shopify (5).
    expect(await balance(db, item)).toMatchObject({ onHand: 12 });
  });

  it("initialization does not wait for an order row locked by an order transaction (FOR NO KEY UPDATE)", async () => {
    if (env.handle.driver !== "pg") return;
    const db = env.handle.db;
    const orderId = await env.orderId("#1002");
    await resetLedger(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const holder = db.transaction(async (tx) => {
      // Як loadOrderRow(forUpdate)/upsertOrder: зміна замовлення в процесі (до синхронізації резервів).
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("no key update");
      locked();
      await gate;
    });
    await lockedP;
    const started = Date.now();
    const r = await Promise.race([initializeInventory(env.ctx(OWNER)), sleep(10_000).then(() => "timeout" as const)]);
    release();
    await holder;
    expect(r).not.toBe("timeout");
    expect(Date.now() - started).toBeLessThan(10_000);
    const res = await db.select().from(stockReservations).where(eq(stockReservations.orderId, orderId));
    expect(res.length).toBeGreaterThan(0);
  });

  it("an order sync waiting for the initialization applies only the difference afterwards", async () => {
    if (env.handle.driver !== "pg") return;
    const db = env.handle.db;
    const orderId = await env.orderId("#1003");
    await resetLedger(db);
    const [line] = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, orderId));
    // Зміна кількості в Shopify ще не зафіксована, коли ініціалізація читає замовлення.
    let edited!: () => void;
    const editedP = new Promise<void>((r) => (edited = r));
    const edit = db.transaction(async (tx) => {
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("no key update");
      await tx.update(orderLineItems).set({ currentQuantity: line!.quantity + 2 }).where(eq(orderLineItems.id, line!.id));
      edited();
      await sleep(300); // ініціалізація стартує й блокує склад
      await syncOrderReservations(tx, orderId, ACTOR); // чекає завершення ініціалізації
    });
    await editedP;
    const init = initializeInventory(env.ctx(OWNER));
    await Promise.all([edit, init]);
    const [res] = await db.select().from(stockReservations).where(eq(stockReservations.orderLineItemId, line!.id));
    expect(res).toMatchObject({ reservedQty: line!.quantity + 2, seq: 2 });
    const keys = (await db.select({ k: inventoryMovements.idempotencyKey }).from(inventoryMovements).where(eq(inventoryMovements.orderLineItemId, line!.id))).map(
      (m) => m.k,
    );
    expect(keys.sort()).toEqual([`reserve:${line!.id}:1`, `reserve:${line!.id}:2`].sort());
  });
});

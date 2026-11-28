/**
 * Етап 6, WP2: допоміжне для тестів собівартості на БД (PGlite; TEST_DATABASE_URL — справжній PostgreSQL).
 * Вигадані товари й замовлення, без персональних даних.
 */
import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DatabaseHandle, Db } from "~/db/client.server";
import {
  financeEntries,
  fxRates,
  inventoryCostLayers,
  inventoryCostState,
  inventoryMovements,
  inventoryValuations,
  orderLineItems,
  orders,
} from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { Actor } from "~/domain/permissions";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { ratePerUnitScaled, scaledRateToDecimal } from "~/lib/decimal";
import { businessDayStart } from "~/modules/warehouse/dates";
import { applyMovements, type MovementInput } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { AppMode, ServiceContext } from "~/server/types";
import { OWNER, openTestDatabase } from "../../helpers";
import { ACTOR, insertProduct, stockItemFor } from "../../stage5/helpers";

export interface CostEnv {
  hd: DatabaseHandle;
  db: Db;
  ctx: (actor?: Actor, opts?: { now?: Date; mode?: AppMode }) => ServiceContext;
  warehouseId: string;
  close: () => Promise<void>;
}

export async function openCostEnv(): Promise<CostEnv> {
  const hd = await openTestDatabase();
  await seedReferenceData(hd.db, DEMO_SETTINGS);
  const carriers = createDemoCarriers(hd.db);
  const w = await getDefaultWarehouse(hd.db);
  return {
    hd,
    db: hd.db,
    warehouseId: w.id,
    ctx: (actor = OWNER, opts = {}) => ({
      mode: opts.mode ?? "demo",
      db: hd.db,
      actor,
      carriers,
      shopify: new DemoShopifyGateway(),
      now: () => opts.now ?? new Date(),
    }),
    close: () => hd.close(),
  };
}

let seq = 0;
/** Вигаданий товар з одним варіантом, відкритий для обліку (резерви/продажі дозволені). */
export async function product(db: Db, opts: { model?: string; color?: string } = {}): Promise<{ variantId: string; stockItemId: string; sku: string }> {
  seq += 1;
  const sku = `CT-${process.pid}-${seq}`;
  const { variantIds } = await insertProduct(db, `Costing test ${seq}`, [{ sku, model: opts.model, color: opts.color }]);
  const variantId = variantIds[0]!;
  return { variantId, stockItemId: await stockItemFor(db, variantId), sku };
}

/** Вигадане оплачене замовлення з позицією (без персональних даних). */
export async function order(db: Db, variantId: string, quantity: number, extra: Partial<typeof orders.$inferInsert> = {}): Promise<{ orderId: string; lineId: string }> {
  seq += 1;
  const [o] = await db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: `#CT${process.pid}${seq}`,
      status: "delivered",
      financialStatus: "paid",
      currency: "EUR",
      subtotal: "10.00",
      total: "10.00",
      placedAt: new Date(),
      ...extra,
    })
    .returning({ id: orders.id });
  const [l] = await db
    .insert(orderLineItems)
    .values({ orderId: o!.id, variantId, title: "Costing test", quantity, unitPrice: "10.00", currency: "EUR", position: 0 })
    .returning({ id: orderLineItems.id });
  return { orderId: o!.id, lineId: l!.id };
}

export type MoveInput = Omit<MovementInput, "warehouseId" | "idempotencyKey"> & { idempotencyKey?: string };

/** Рухи в одній транзакції (одним викликом applyMovements, як у потоках етапу 5). */
export async function moves(db: Db, inputs: readonly MoveInput[], actor = ACTOR) {
  const w = await getDefaultWarehouse(db);
  return db.transaction((tx) =>
    applyMovements(
      tx,
      actor,
      inputs.map((m) => ({ ...m, warehouseId: w.id, idempotencyKey: m.idempotencyKey ?? `test:${randomUUID()}` })),
      { shopifyPush: "off" },
    ),
  );
}

export async function move(db: Db, input: MoveInput, actor = ACTOR) {
  const r = await moves(db, [input], actor);
  return r.applied[0]!;
}

/** Переносить рух на дату (полудень за Києвом) — для перебудови демо (rebuildValuationForDemo: created_at, seq). */
export async function backdate(db: Db, movementIds: readonly string[], date: string): Promise<void> {
  const at = new Date(businessDayStart(date).getTime() + 12 * 3600 * 1000);
  await db.update(inventoryMovements).set({ createdAt: at }).where(inArray(inventoryMovements.id, [...movementIds]));
}

export async function costState(db: Db, stockItemId: string) {
  const [s] = await db.select().from(inventoryCostState).where(eq(inventoryCostState.stockItemId, stockItemId));
  return s ?? null;
}

export async function valuationsOf(db: Db, stockItemId: string) {
  return db.select().from(inventoryValuations).where(eq(inventoryValuations.stockItemId, stockItemId)).orderBy(asc(inventoryValuations.seq));
}

export async function layersOf(db: Db, stockItemId: string) {
  return db.select().from(inventoryCostLayers).where(eq(inventoryCostLayers.stockItemId, stockItemId)).orderBy(asc(inventoryCostLayers.createdSeq));
}

export async function entriesOf(db: Db, where: { stockItemId?: string; orderId?: string; keyPrefix?: string } = {}) {
  return db
    .select()
    .from(financeEntries)
    .where(
      and(
        where.stockItemId ? eq(financeEntries.stockItemId, where.stockItemId) : undefined,
        where.orderId ? eq(financeEntries.orderId, where.orderId) : undefined,
        where.keyPrefix ? sql`${financeEntries.idempotencyKey} like ${`${where.keyPrefix}%`}` : undefined,
      ),
    )
    .orderBy(asc(financeEntries.seq));
}

/** Ручний курс (гривень за 1 одиницю) на дату — як WP1 (версія 1, поточний). */
export async function manualRate(db: Db, currency: string, date: string, rate: string, units = 1): Promise<void> {
  const p = ratePerUnitScaled(rate, units);
  await db.insert(fxRates).values({
    source: "manual",
    currency,
    quoteCurrency: "UAH",
    effectiveDate: date,
    rate,
    units,
    ratePerUnit: scaledRateToDecimal(p),
    version: 1,
    isCurrent: true,
    enteredBy: "test-owner",
    reason: "test",
  });
}

export { OWNER, ACTOR };

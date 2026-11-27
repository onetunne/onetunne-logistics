import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq, inArray } from "drizzle-orm";
import { auditLog, inventoryMovements, jobs, packagingMaterials, productVariants, stockAlerts, stockItems } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { inventoryKeys } from "~/modules/inventory/keys";
import { applyMovements, ensureStockItemForMaterial, ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import {
  OPERATION_PERMISSIONS,
  StocktakeAlreadySavedError,
  StocktakeConflictError,
  adjustToCount,
  cleanNote,
  markDefective,
  newOperationId,
  normalizeUnitCost,
  receiveStock,
  repairDefective,
  setLowStockThreshold,
  setLowStockThresholds,
  stocktake,
  writeOffDefective,
} from "~/modules/warehouse/operations.server";
import { loadAlertSummary } from "~/modules/warehouse/stock.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { apply, balance, insertProduct, movementCount, openAlertKinds, stockItemFor } from "./helpers";

/**
 * Складські операції людей (modules/warehouse/operations.server.ts) на справжньому PostgreSQL (PGlite або
 * TEST_DATABASE_URL): дельти, ідемпотентність форми (подвійне надсилання), інвентаризація з блокуванням,
 * дозволи працівника/власника, собівартість лише з finance.view.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const db = () => env.handle.db;

async function itemBySku(sku: string): Promise<string> {
  const [v] = await db().select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku));
  if (!v) throw new Error(`variant ${sku} not found`);
  return ensureStockItemForVariant(db(), v.id);
}

async function movementByKey(key: string) {
  const [m] = await db().select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, key));
  return m;
}

/** Окрема позиція з відомим залишком (вигаданий товар, не відкритий в обліку — внутрішні рухи дозволені). */
async function freshItem(sku: string, onHand = 0): Promise<string> {
  const p = await insertProduct(db(), `Ops ${sku}`, [{ sku, available: null }]);
  const item = await ensureStockItemForVariant(db(), p.variantIds[0]!);
  if (onHand > 0)
    await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: onHand, reason: "purchase" });
  return item;
}

/** Відкритий товар (облік запущено — внутрішні зміни on_hand можуть іти в Shopify) з відомим залишком. */
async function openedItem(sku: string, onHand = 0): Promise<string> {
  const p = await insertProduct(db(), `Opened ${sku}`, [{ sku, available: onHand }]);
  const item = await stockItemFor(db(), p.variantIds[0]!);
  if (onHand > 0)
    await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: onHand, reason: "purchase" });
  return item;
}

async function syncStateOf(movementId: string) {
  const [m] = await db()
    .select({ s: inventoryMovements.shopifySyncState })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.id, movementId));
  return m?.s;
}

/** Очікувані завдання передачі в Shopify. */
async function queuedPushJobs(): Promise<number> {
  const [row] = await db()
    .select({ c: count() })
    .from(jobs)
    .where(and(eq(jobs.type, "inventory.push"), eq(jobs.status, "queued")));
  return Number(row?.c ?? 0);
}
const clearPushJobs = () => db().delete(jobs).where(eq(jobs.type, "inventory.push"));

/** Робочий режим: передача в Shopify діє лише там (у демо Shopify не підключено — movementOptionsFor). */
const prodCtx = (actor: Parameters<TestEnv["ctx"]>[0]) => ({ ...env.ctx(actor), mode: "production" as const });

/** Тимчасово інший режим передачі в Shopify (warehouse.shopifyPush). */
async function withPushMode<T>(mode: "off" | "deltas", run: () => Promise<T>): Promise<T> {
  const current = await getSetting(db(), "warehouse");
  await updateSetting(db(), OWNER, "warehouse", { ...current, shopifyPush: mode });
  try {
    return await run();
  } finally {
    await updateSetting(db(), OWNER, "warehouse", current);
  }
}

describe("receiveStock", () => {
  it("staff receives good and damaged units linked to an order; double submit is harmless", async () => {
    const item = await itemBySku("OT-GR-BLK");
    const orderId = await env.orderId("#1001");
    const before = await balance(db(), item);
    const operationId = newOperationId();
    const input = {
      operationId,
      stockItemId: item,
      quantity: 5,
      defectiveQuantity: 1,
      reason: "customer_return" as const,
      orderId,
      note: "Повернення, дзвонити +380 67 123 45 67, mail test@example.com",
    };
    const first = await receiveStock(env.ctx(STAFF), input);
    expect(first).toMatchObject({ replay: false, stockItemId: item, type: "receipt_manual" });
    expect(first.balance).toMatchObject({ onHand: before.onHand + 5, defective: before.defective + 1 });
    const second = await receiveStock(env.ctx(STAFF), input);
    expect(second).toMatchObject({ replay: true, movementId: first.movementId });
    const after = await balance(db(), item);
    expect(after.onHand - before.onHand).toBe(5);
    expect(after.defective - before.defective).toBe(1);

    const key = inventoryKeys.manual(operationId);
    expect(await movementCount(db(), { key })).toBe(1);
    const m = await movementByKey(key);
    expect(m).toMatchObject({
      type: "receipt_manual",
      reason: "customer_return",
      orderId,
      actorId: STAFF.id,
      actorName: STAFF.displayName,
      onHandDelta: 5,
      defectiveDelta: 1,
    });
    // Примітка без персональних даних.
    expect(m!.note).not.toMatch(/123 45 67|test@example\.com/);
    expect(m!.note).toMatch(/^Повернення/);
    const audits = await db()
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "inventory.received"), eq(auditLog.entityId, item)));
    expect(audits).toHaveLength(1);
  });

  it("the same form id for another operation is rejected (not silently skipped)", async () => {
    const item = await itemBySku("OT-GR-GRY");
    const other = await itemBySku("OT-BG-BLK");
    const operationId = newOperationId();
    await receiveStock(env.ctx(STAFF), { operationId, stockItemId: item, quantity: 2, reason: "purchase" });
    await expect(receiveStock(env.ctx(STAFF), { operationId, stockItemId: item, quantity: 3, reason: "purchase" })).rejects.toMatchObject({
      code: "warehouse.error.operationReused",
    });
    await expect(receiveStock(env.ctx(STAFF), { operationId, stockItemId: other, quantity: 2, reason: "purchase" })).rejects.toMatchObject({
      code: "warehouse.error.operationReused",
    });
    await expect(markDefective(env.ctx(STAFF), { operationId, stockItemId: item, quantity: 1, reason: "other" })).rejects.toMatchObject({
      code: "warehouse.error.operationReused",
    });
  });

  it("unit cost needs finance.view; the owner's cost is stored exactly", async () => {
    const item = await itemBySku("OT-LT-STD");
    await expect(
      receiveStock(env.ctx(STAFF), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 1,
        reason: "purchase",
        unitCost: "9.90",
        costCurrency: "EUR",
      }),
    ).rejects.toMatchObject({ permission: "finance.view" });
    const operationId = newOperationId();
    await receiveStock(env.ctx(OWNER), {
      operationId,
      stockItemId: item,
      quantity: 4,
      reason: "purchase",
      unitCost: "12,5",
      costCurrency: "eur",
    });
    expect(await movementByKey(inventoryKeys.manual(operationId))).toMatchObject({ unitCost: "12.50", costCurrency: "EUR" });
    expect(() => normalizeUnitCost("-1", "EUR")).toThrow();
    expect(() => normalizeUnitCost("1.999", "EUR")).toThrow();
    expect(() => normalizeUnitCost("1", "EU")).toThrow();
  });

  it("validates quantities, reasons, form id, item and order", async () => {
    const item = await itemBySku("OT-LT-STD");
    const ctx = env.ctx(STAFF);
    const base = { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "purchase" as const };
    await expect(receiveStock(ctx, { ...base, quantity: 0 })).rejects.toMatchObject({ code: "warehouse.error.quantity" });
    await expect(receiveStock(ctx, { ...base, quantity: 1.5 })).rejects.toMatchObject({ code: "warehouse.error.quantity" });
    await expect(receiveStock(ctx, { ...base, quantity: 100_001 })).rejects.toMatchObject({ code: "warehouse.error.quantity" });
    await expect(receiveStock(ctx, { ...base, reason: "stocktake" as never })).rejects.toMatchObject({ code: "warehouse.error.reason" });
    await expect(receiveStock(ctx, { ...base, operationId: "not-a-uuid" })).rejects.toMatchObject({ code: "warehouse.error.operationId" });
    await expect(receiveStock(ctx, { ...base, stockItemId: newOperationId() })).rejects.toMatchObject({ code: "error.notFound" });
    await expect(receiveStock(ctx, { ...base, orderId: newOperationId() })).rejects.toMatchObject({
      code: "warehouse.error.orderNotFound",
    });
    expect(await movementCount(db(), { key: inventoryKeys.manual(base.operationId) })).toBe(0);
  });

  it("works for packaging materials too (no Shopify sync)", async () => {
    const [material] = await db()
      .select({ id: packagingMaterials.id })
      .from(packagingMaterials)
      .where(eq(packagingMaterials.code, "box_l"));
    const item = await ensureStockItemForMaterial(db(), material!.id);
    const before = await balance(db(), item);
    const r = await receiveStock(env.ctx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 20, reason: "purchase" });
    expect(r.balance.onHand).toBe(before.onHand + 20);
    const [m] = await db().select().from(inventoryMovements).where(eq(inventoryMovements.id, r.movementId));
    expect(m!.shopifySyncState).toBe("none");
  });

  it("internal on-hand changes of an opened product follow warehouse.shopifyPush", async () => {
    const item = await itemBySku("OT-PH-BLK");
    const current = await getSetting(db(), "warehouse");
    await updateSetting(db(), OWNER, "warehouse", { ...current, shopifyPush: "deltas" });
    try {
      const r = await receiveStock(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "found" });
      const [m] = await db().select().from(inventoryMovements).where(eq(inventoryMovements.id, r.movementId));
      expect(m!.shopifySyncState).toBe("pending");
      // Списання браку не змінює on_hand → у Shopify не надсилається.
      const marked = await markDefective(prodCtx(STAFF), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 1,
        reason: "damaged_in_warehouse",
      });
      expect((await db().select().from(inventoryMovements).where(eq(inventoryMovements.id, marked.movementId)))[0]!.shopifySyncState).toBe(
        "pending",
      );
      const off = await writeOffDefective(prodCtx(OWNER), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 1,
        reason: "disposed",
      });
      expect((await db().select().from(inventoryMovements).where(eq(inventoryMovements.id, off.movementId)))[0]!.shopifySyncState).toBe(
        "none",
      );
    } finally {
      await updateSetting(db(), OWNER, "warehouse", current);
    }
  });
});

describe("defects", () => {
  it("mark → repair → write off move units between on hand and defective", async () => {
    const item = await freshItem("OPS-DEF", 10);
    const ctx = env.ctx(STAFF);
    const marked = await markDefective(ctx, {
      operationId: newOperationId(),
      stockItemId: item,
      quantity: 4,
      reason: "damaged_in_warehouse",
      note: "Тріщина",
    });
    expect(marked.balance).toMatchObject({ onHand: 6, defective: 4 });
    const repaired = await repairDefective(ctx, { operationId: newOperationId(), stockItemId: item, quantity: 1 });
    expect(repaired.balance).toMatchObject({ onHand: 7, defective: 3 });
    const writeOff = { operationId: newOperationId(), stockItemId: item, quantity: 3, reason: "returned_to_manufacturer" as const };
    const off = await writeOffDefective(env.ctx(OWNER), writeOff);
    expect(off.balance).toMatchObject({ onHand: 7, defective: 0 });
    // Подвійне надсилання списання — без повторного руху й без помилки «недостатньо».
    expect(await writeOffDefective(env.ctx(OWNER), writeOff)).toMatchObject({ replay: true, movementId: off.movementId });
    expect(await balance(db(), item)).toMatchObject({ onHand: 7, defective: 0 });
    const types = (
      await db()
        .select({ type: inventoryMovements.type, reason: inventoryMovements.reason })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.stockItemId, item))
    ).map((m) => `${m.type}:${m.reason}`);
    expect(types.sort()).toEqual(
      [
        "receipt_manual:purchase",
        "defect_mark:damaged_in_warehouse",
        "defect_repair:repaired",
        "defect_writeoff:returned_to_manufacturer",
      ].sort(),
    );
  });

  it("cannot take more than there is (nothing written)", async () => {
    const item = await freshItem("OPS-DEF2", 2);
    await expect(
      markDefective(env.ctx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 3, reason: "production" }),
    ).rejects.toMatchObject({
      code: "inventory.insufficient",
    });
    await expect(repairDefective(env.ctx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 1 })).rejects.toMatchObject({
      code: "inventory.insufficient",
    });
    await expect(
      writeOffDefective(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "lost" }),
    ).rejects.toMatchObject({
      code: "inventory.insufficient",
    });
    expect(await balance(db(), item)).toMatchObject({ onHand: 2, defective: 0 });
    expect(await movementCount(db(), { stockItemId: item })).toBe(1);
  });

  it("marking reserved units defective opens an oversold alert (physical damage is never blocked by reservations)", async () => {
    const p = await insertProduct(db(), "Ops reserved", [{ sku: "OPS-RES" }]);
    const item = await stockItemFor(db(), p.variantIds[0]!);
    await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: 5, reason: "purchase" });
    await apply(db(), { stockItemId: item, type: "reserve", idempotencyKey: `t:ops:reserve:${item}`, reservedDelta: 3 });
    const r = await markDefective(env.ctx(STAFF), {
      operationId: newOperationId(),
      stockItemId: item,
      quantity: 5,
      reason: "damaged_in_warehouse",
    });
    expect(r.balance).toMatchObject({ onHand: 0, reserved: 3, defective: 5, available: -3 });
    expect(await openAlertKinds(db(), item)).toEqual(expect.arrayContaining(["oversold", "out_of_stock"]));
  });
});

describe("adjustToCount (stocktake)", () => {
  it("sets on hand to the counted value; a match is recorded with a zero delta; double submit is a replay", async () => {
    const item = await freshItem("OPS-CNT", 10);
    const operationId = newOperationId();
    const res = await adjustToCount(env.ctx(OWNER), {
      operationId,
      stockItemId: item,
      countedOnHand: 7,
      expectedOnHand: 10,
      note: "Ряд A",
    });
    expect(res).toMatchObject({ replay: false, previousOnHand: 10, countedOnHand: 7, delta: -3 });
    expect(res.balance.onHand).toBe(7);
    expect(await adjustToCount(env.ctx(OWNER), { operationId, stockItemId: item, countedOnHand: 7, expectedOnHand: 10 })).toMatchObject({
      replay: true,
      delta: -3,
    });
    expect((await balance(db(), item)).onHand).toBe(7);
    const same = await adjustToCount(env.ctx(OWNER), {
      operationId: newOperationId(),
      stockItemId: item,
      countedOnHand: 7,
      expectedOnHand: 7,
    });
    expect(same).toMatchObject({ delta: 0, previousOnHand: 7 });
    const [m] = await db().select().from(inventoryMovements).where(eq(inventoryMovements.id, same.movementId));
    expect(m).toMatchObject({ type: "adjustment", reason: "stocktake", onHandDelta: 0, shopifySyncState: "none" });
    await expect(
      adjustToCount(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: -1 }),
    ).rejects.toMatchObject({
      code: "warehouse.error.quantity",
    });
    // Інша позиція з тим самим uuid форми — не повтор, а помилка.
    const other = await freshItem("OPS-CNT2", 1);
    await expect(adjustToCount(env.ctx(OWNER), { operationId, stockItemId: other, countedOnHand: 1 })).rejects.toMatchObject({
      code: "warehouse.error.operationReused",
    });
  });

  it("stock changed since the form was opened → stocktakeChanged, nothing written; equal to current is accepted", async () => {
    const item = await freshItem("OPS-CAS", 10);
    await expect(
      adjustToCount(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: 8, expectedOnHand: 9 }),
    ).rejects.toMatchObject({
      code: "warehouse.error.stocktakeChanged",
      params: { expected: 9, current: 10, counted: 8 },
    });
    expect(await movementCount(db(), { stockItemId: item })).toBe(1);
    expect(
      await adjustToCount(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: 10, expectedOnHand: 9 }),
    ).toMatchObject({ delta: 0 });
  });
});

describe("stocktake (count sheet)", () => {
  it("all counts are one applyMovements call: one transaction, per-item keys, totals", async () => {
    const a = await freshItem("OPS-ST-A", 5);
    const b = await freshItem("OPS-ST-B", 5);
    const c = await freshItem("OPS-ST-C", 5);
    const operationId = newOperationId();
    const input = {
      operationId,
      counts: [
        { stockItemId: a, countedOnHand: 8, expectedOnHand: 5 },
        { stockItemId: b, countedOnHand: 2, expectedOnHand: 5 },
        { stockItemId: c, countedOnHand: 5, expectedOnHand: 5 },
      ],
    };
    const res = await stocktake(env.ctx(OWNER), input);
    expect(res).toMatchObject({ replay: false, changed: 2, unchanged: 1, unitsAdded: 3, unitsRemoved: 3 });
    expect([(await balance(db(), a)).onHand, (await balance(db(), b)).onHand, (await balance(db(), c)).onHand]).toEqual([8, 2, 5]);
    for (const id of [a, b, c]) expect(await movementCount(db(), { key: inventoryKeys.manual(operationId, id) })).toBe(1);
    // Усі рухи — однієї транзакції (created_at = now() — час початку транзакції PostgreSQL).
    const times = await db()
      .select({ at: inventoryMovements.createdAt })
      .from(inventoryMovements)
      .where(
        inArray(
          inventoryMovements.idempotencyKey,
          [a, b, c].map((id) => inventoryKeys.manual(operationId, id)),
        ),
      );
    expect(new Set(times.map((t) => t.at.getTime())).size).toBe(1);
    expect(await stocktake(env.ctx(OWNER), input)).toMatchObject({
      replay: true,
      applied: [],
      replayed: expect.arrayContaining([a, b, c]),
    });
    expect((await balance(db(), a)).onHand).toBe(8);
  });

  it("a changed item blocks the whole sheet (atomic) and lists the conflicts", async () => {
    const a = await freshItem("OPS-ST-D", 5);
    const b = await freshItem("OPS-ST-E", 5);
    const err = await stocktake(env.ctx(OWNER), {
      operationId: newOperationId(),
      counts: [
        { stockItemId: a, countedOnHand: 1, expectedOnHand: 5 },
        { stockItemId: b, countedOnHand: 1, expectedOnHand: 4 },
      ],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StocktakeConflictError);
    expect((err as StocktakeConflictError).conflicts).toEqual([{ stockItemId: b, expectedOnHand: 4, currentOnHand: 5, countedOnHand: 1 }]);
    expect((await balance(db(), a)).onHand).toBe(5);
    expect(await movementCount(db(), { stockItemId: a })).toBe(1);
  });

  it("validates the sheet", async () => {
    const a = await freshItem("OPS-ST-F", 1);
    const ctx = env.ctx(OWNER);
    await expect(stocktake(ctx, { operationId: newOperationId(), counts: [] })).rejects.toMatchObject({ code: "warehouse.error.noItems" });
    await expect(
      stocktake(ctx, {
        operationId: newOperationId(),
        counts: [
          { stockItemId: a, countedOnHand: 1 },
          { stockItemId: a, countedOnHand: 2 },
        ],
      }),
    ).rejects.toMatchObject({ code: "warehouse.error.duplicateItem" });
    await expect(stocktake(ctx, { operationId: "x", counts: [{ stockItemId: a, countedOnHand: 1 }] })).rejects.toMatchObject({
      code: "warehouse.error.operationId",
    });
    await expect(
      stocktake(ctx, { operationId: newOperationId(), counts: Array.from({ length: 201 }, () => ({ stockItemId: a, countedOnHand: 1 })) }),
    ).rejects.toMatchObject({ code: "warehouse.error.tooManyItems" });
    await expect(
      stocktake(ctx, { operationId: newOperationId(), counts: [{ stockItemId: newOperationId(), countedOnHand: 1 }] }),
    ).rejects.toMatchObject({
      code: "error.notFound",
    });
  });
});

describe("thresholds", () => {
  it("own threshold re-evaluates alerts; bulk sets many at once; null restores the default", async () => {
    const item = await freshItem("OPS-THR", 3);
    expect(await openAlertKinds(db(), item)).toEqual(["low_stock"]);
    await setLowStockThreshold(env.ctx(OWNER), { stockItemId: item, threshold: 1 });
    expect(await openAlertKinds(db(), item)).toEqual([]);
    const other = await freshItem("OPS-THR2", 3);
    const res = await setLowStockThresholds(env.ctx(OWNER), { stockItemIds: [item, other], threshold: 10 });
    expect(res).toMatchObject({ updated: 2, openedAlerts: 1 });
    expect(await openAlertKinds(db(), item)).toEqual(["low_stock"]);
    await setLowStockThresholds(env.ctx(OWNER), { stockItemIds: [item, other], threshold: null });
    const rows = await db().select({ t: stockItems.lowStockThreshold }).from(stockItems).where(eq(stockItems.id, item));
    expect(rows[0]!.t).toBeNull();
    await expect(setLowStockThreshold(env.ctx(OWNER), { stockItemId: item, threshold: -1 })).rejects.toMatchObject({
      code: "warehouse.error.threshold",
    });
    await expect(setLowStockThresholds(env.ctx(OWNER), { stockItemIds: [], threshold: 1 })).rejects.toMatchObject({
      code: "warehouse.error.noItems",
    });
  });
});

describe("permission matrix (server-side)", () => {
  const noWarehouse = makeActor({ id: "no-wh", displayName: "No WH", role: "staff", overrides: { revoke: ["warehouse.receive"] } });
  const staffAdjust = makeActor({
    id: "staff-adj",
    displayName: "Staff Adjust",
    role: "staff",
    overrides: { grant: ["warehouse.adjust"] },
  });

  const cases: Array<{ name: keyof typeof OPERATION_PERMISSIONS; run: (actor: Actor, item: string) => Promise<unknown> }> = [
    {
      name: "receiveStock",
      run: (a, item) => receiveStock(env.ctx(a), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "found" }),
    },
    {
      name: "markDefective",
      run: (a, item) => markDefective(env.ctx(a), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "other" }),
    },
    {
      name: "repairDefective",
      run: (a, item) => repairDefective(env.ctx(a), { operationId: newOperationId(), stockItemId: item, quantity: 1 }),
    },
    {
      name: "writeOffDefective",
      run: (a, item) => writeOffDefective(env.ctx(a), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "lost" }),
    },
    {
      name: "adjustToCount",
      run: (a, item) => adjustToCount(env.ctx(a), { operationId: newOperationId(), stockItemId: item, countedOnHand: 50 }),
    },
    {
      name: "stocktake",
      run: (a, item) => stocktake(env.ctx(a), { operationId: newOperationId(), counts: [{ stockItemId: item, countedOnHand: 50 }] }),
    },
    { name: "setLowStockThreshold", run: (a, item) => setLowStockThreshold(env.ctx(a), { stockItemId: item, threshold: 2 }) },
    { name: "setLowStockThresholds", run: (a, item) => setLowStockThresholds(env.ctx(a), { stockItemIds: [item], threshold: 2 }) },
  ];

  it("staff: receive/defect/repair yes; write-off/stocktake/thresholds no; owner: all; revoked/granted overrides respected", async () => {
    const item = await freshItem("OPS-PERM", 50);
    // Брак для ремонту/списання.
    await markDefective(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: 10, reason: "other" });
    const outcome = async (actor: Actor, run: (a: Actor, i: string) => Promise<unknown>) =>
      run(actor, item).then(
        () => "ok",
        (e: { permission?: string; code?: string }) => (e.permission ? `forbidden:${e.permission}` : `error:${e.code}`),
      );
    const staffExpected: Record<string, string> = {
      receiveStock: "ok",
      markDefective: "ok",
      repairDefective: "ok",
      writeOffDefective: "forbidden:warehouse.adjust",
      adjustToCount: "forbidden:warehouse.adjust",
      stocktake: "forbidden:warehouse.adjust",
      setLowStockThreshold: "forbidden:warehouse.adjust",
      setLowStockThresholds: "forbidden:warehouse.adjust",
    };
    for (const c of cases) {
      expect(`${c.name}:${await outcome(STAFF, c.run)}`).toBe(`${c.name}:${staffExpected[c.name]}`);
      expect(`${c.name}:${await outcome(OWNER, c.run)}`).toBe(`${c.name}:ok`);
      expect(`${c.name}:${await outcome(staffAdjust, c.run)}`).toBe(`${c.name}:ok`);
      const revoked = await outcome(noWarehouse, c.run);
      expect(revoked.startsWith("forbidden:"), `${c.name}: ${revoked}`).toBe(true);
    }
  });
});

describe("Shopify push queue (warehouse.shopifyPush = deltas)", () => {
  it("every pushable operation queues inventory.push in its own transaction; write-off, replay and push=off do not", async () => {
    const item = await openedItem("OPS-PUSH-A", 10);
    await withPushMode("deltas", async () => {
      const ops: Array<[string, () => Promise<{ movementId: string; shopifyPushQueued: boolean }>]> = [
        ["receive", () => receiveStock(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 30, reason: "purchase" })],
        ["defect", () => markDefective(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 2, reason: "other" })],
        ["repair", () => repairDefective(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 1 })],
        ["count", () => adjustToCount(prodCtx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: 20 })],
        [
          "sheet",
          async () => {
            const r = await stocktake(prodCtx(OWNER), { operationId: newOperationId(), counts: [{ stockItemId: item, countedOnHand: 25 }] });
            return { movementId: r.applied[0]!.movementId, shopifyPushQueued: r.shopifyPushQueued };
          },
        ],
      ];
      for (const [name, run] of ops) {
        await clearPushJobs();
        const r = await run();
        expect(`${name}:${await syncStateOf(r.movementId)}:${r.shopifyPushQueued}`).toBe(`${name}:pending:true`);
        expect(`${name}:${await queuedPushJobs()}`).toBe(`${name}:1`);
      }
      // Кілька операцій — одне очікуване завдання (dedupe).
      await receiveStock(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "found" });
      expect(await queuedPushJobs()).toBe(1);

      await clearPushJobs();
      // Списання браку не змінює on_hand → не надсилається, завдання немає.
      const off = await writeOffDefective(prodCtx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "disposed" });
      expect([await syncStateOf(off.movementId), off.shopifyPushQueued, await queuedPushJobs()]).toEqual(["none", false, 0]);
      // Підрахунок без змін (нульова дельта) — теж ні.
      const current = (await balance(db(), item)).onHand;
      const same = await adjustToCount(prodCtx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: current });
      expect([same.shopifySyncState, same.shopifyPushQueued, await queuedPushJobs()]).toEqual(["none", false, 0]);
      // Повтор форми не ставить нове завдання.
      const operationId = newOperationId();
      await receiveStock(prodCtx(STAFF), { operationId, stockItemId: item, quantity: 1, reason: "purchase" });
      await clearPushJobs();
      const replay = await receiveStock(prodCtx(STAFF), { operationId, stockItemId: item, quantity: 1, reason: "purchase" });
      expect([replay.replay, replay.shopifySyncState, replay.shopifyPushQueued, await queuedPushJobs()]).toEqual([true, "pending", false, 0]);
      // Операція, що не відбулася (залишок змінився), не залишає завдання.
      await expect(
        adjustToCount(prodCtx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: 1, expectedOnHand: current + 100 }),
      ).rejects.toMatchObject({ code: "warehouse.error.stocktakeChanged" });
      expect(await queuedPushJobs()).toBe(0);
    });
    await clearPushJobs();
    await withPushMode("off", async () => {
      const r = await receiveStock(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 3, reason: "purchase" });
      const c = await adjustToCount(prodCtx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: 5 });
      expect([await syncStateOf(r.movementId), r.shopifyPushQueued, c.shopifySyncState, c.shopifyPushQueued]).toEqual([
        "skipped",
        false,
        "skipped",
        false,
      ]);
      expect(await queuedPushJobs()).toBe(0);
    });
  });

  it("demo: nothing is sent to Shopify, so internal changes are «not sent» and no push is queued or announced (e2e-5)", async () => {
    const item = await openedItem("OPS-PUSH-DEMO", 5);
    await withPushMode("deltas", async () => {
      await clearPushJobs();
      const demo = env.ctx(STAFF);
      expect(demo.mode).toBe("demo");
      const r = await receiveStock(demo, { operationId: newOperationId(), stockItemId: item, quantity: 2, reason: "purchase" });
      expect([await syncStateOf(r.movementId), r.shopifyPushQueued, await queuedPushJobs()]).toEqual(["skipped", false, 0]);
      const c = await adjustToCount(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: 3 });
      expect([c.shopifySyncState, c.shopifyPushQueued, await queuedPushJobs()]).toEqual(["skipped", false, 0]);
    });
  });

  it("a not yet opened product never queues a push (its movements are added to the snapshot on opening)", async () => {
    const item = await freshItem("OPS-PUSH-NEW");
    await withPushMode("deltas", async () => {
      await clearPushJobs();
      const r = await receiveStock(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: item, quantity: 4, reason: "purchase" });
      expect([await syncStateOf(r.movementId), r.shopifyPushQueued, await queuedPushJobs()]).toEqual(["skipped", false, 0]);
    });
  });
});

describe("customer returns and Shopify restock", () => {
  it("by default a customer return is not sent to Shopify (Shopify restocks itself); explicit choice sends it", async () => {
    const item = await openedItem("OPS-RET", 2);
    const orderId = await env.orderId("#1001");
    await withPushMode("deltas", async () => {
      await clearPushJobs();
      const restocked = await receiveStock(prodCtx(STAFF), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 2,
        reason: "customer_return",
        orderId,
      });
      expect([await syncStateOf(restocked.movementId), restocked.shopifyPushQueued, await queuedPushJobs()]).toEqual(["skipped", false, 0]);
      expect(restocked.balance.onHand).toBe(4); // облік складу змінюється як завжди
      const audits = await db()
        .select({ details: auditLog.details })
        .from(auditLog)
        .where(and(eq(auditLog.action, "inventory.received"), eq(auditLog.entityId, item)));
      expect(audits.find((a) => a.details.movementId === restocked.movementId)?.details).toMatchObject({
        reason: "customer_return",
        shopifySyncState: "skipped",
        shopifyAlreadyApplied: true,
      });

      const notRestocked = await receiveStock(prodCtx(STAFF), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 1,
        reason: "customer_return",
        restockedInShopify: false,
      });
      expect([await syncStateOf(notRestocked.movementId), notRestocked.shopifyPushQueued, await queuedPushJobs()]).toEqual([
        "pending",
        true,
        1,
      ]);
      // Для інших причин прапорець не діє: закупівля завжди надсилається.
      const purchase = await receiveStock(prodCtx(STAFF), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 1,
        reason: "purchase",
        restockedInShopify: true,
      });
      expect(await syncStateOf(purchase.movementId)).toBe("pending");
      // Лише пошкоджені одиниці (on_hand не змінюється) і матеріали — none, як і без прапорця.
      const damagedOnly = await receiveStock(prodCtx(STAFF), {
        operationId: newOperationId(),
        stockItemId: item,
        quantity: 0,
        defectiveQuantity: 1,
        reason: "customer_return",
      });
      expect(await syncStateOf(damagedOnly.movementId)).toBe("none");
      const [material] = await db().select({ id: packagingMaterials.id }).from(packagingMaterials).where(eq(packagingMaterials.code, "box_l"));
      const materialItem = await ensureStockItemForMaterial(db(), material!.id);
      const m = await receiveStock(prodCtx(STAFF), {
        operationId: newOperationId(),
        stockItemId: materialItem,
        quantity: 1,
        reason: "customer_return",
      });
      expect(await syncStateOf(m.movementId)).toBe("none");
    });
    await clearPushJobs();
  });
});

describe("stocktake resubmission with different values", () => {
  it("single count: the same form with another count is rejected (not silently dropped); identical resubmit is a replay", async () => {
    const item = await freshItem("OPS-RS-1", 10);
    const operationId = newOperationId();
    await adjustToCount(env.ctx(OWNER), { operationId, stockItemId: item, countedOnHand: 7, expectedOnHand: 10 });
    const err = await adjustToCount(env.ctx(OWNER), { operationId, stockItemId: item, countedOnHand: 3, expectedOnHand: 10 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(StocktakeAlreadySavedError);
    expect(err).toMatchObject({
      code: "warehouse.error.countAlreadySaved",
      status: 409,
      params: { current: 7, counted: 3, count: 1 },
      items: [{ stockItemId: item, currentOnHand: 7, countedOnHand: 3 }],
    });
    expect((await balance(db(), item)).onHand).toBe(7);
    expect(await movementCount(db(), { stockItemId: item, type: "adjustment" })).toBe(1);
    expect(await adjustToCount(env.ctx(OWNER), { operationId, stockItemId: item, countedOnHand: 7, expectedOnHand: 10 })).toMatchObject({
      replay: true,
    });
    // Залишок змінився ПІСЛЯ збереження — повтор тієї самої форми теж не підтверджується мовчки.
    await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "found" });
    await expect(
      adjustToCount(env.ctx(OWNER), { operationId, stockItemId: item, countedOnHand: 7, expectedOnHand: 10 }),
    ).rejects.toMatchObject({ code: "warehouse.error.countAlreadySaved", params: { current: 8, counted: 7 } });
    expect((await balance(db(), item)).onHand).toBe(8);
  });

  it("sheet: a corrected value for an already saved item blocks the resubmit (nothing written); new items are added on identical resubmit", async () => {
    const a = await freshItem("OPS-RS-A", 3);
    const b = await freshItem("OPS-RS-B", 4);
    const c = await freshItem("OPS-RS-C", 6);
    const operationId = newOperationId();
    await stocktake(env.ctx(OWNER), { operationId, counts: [{ stockItemId: a, countedOnHand: 5, expectedOnHand: 3 }] });
    const err = await stocktake(env.ctx(OWNER), {
      operationId,
      counts: [
        { stockItemId: a, countedOnHand: 1, expectedOnHand: 3 },
        { stockItemId: b, countedOnHand: 2, expectedOnHand: 4 },
      ],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StocktakeAlreadySavedError);
    expect(err).toMatchObject({ code: "warehouse.error.sheetAlreadySaved", params: { count: 1 } });
    expect((err as StocktakeAlreadySavedError).items).toEqual([{ stockItemId: a, currentOnHand: 5, countedOnHand: 1 }]);
    expect([(await balance(db(), a)).onHand, (await balance(db(), b)).onHand]).toEqual([5, 4]);
    expect(await movementCount(db(), { stockItemId: b, type: "adjustment" })).toBe(0);
    // Той самий лист без виправлень + нова позиція: перша — повтор (видно в replayed), нова — записана.
    const res = await stocktake(env.ctx(OWNER), {
      operationId,
      counts: [
        { stockItemId: a, countedOnHand: 5, expectedOnHand: 3 },
        { stockItemId: c, countedOnHand: 2, expectedOnHand: 6 },
      ],
    });
    expect(res).toMatchObject({ replay: false, replayed: [a], changed: 1, unitsRemoved: 4 });
    expect(res.applied.map((l) => l.stockItemId)).toEqual([c]);
    expect([(await balance(db(), a)).onHand, (await balance(db(), c)).onHand]).toEqual([5, 2]);
  });
});

describe("alerts summary for the stock page", () => {
  it("counts every open alert with a grouped query (not capped at a page), lists the most severe product alerts first", async () => {
    const w = await getDefaultWarehouse(db());
    const p = await insertProduct(
      db(),
      "Alerts bulk",
      Array.from({ length: 520 }, (_, i) => ({ sku: `OPS-AL-${i}`, available: null })),
    );
    const items = await Promise.all(p.variantIds.map((v) => ensureStockItemForVariant(db(), v)));
    const before = await loadAlertSummary(db());
    await db()
      .insert(stockAlerts)
      .values(items.map((id, i) => ({ stockItemId: id, warehouseId: w.id, kind: i === 0 ? ("negative_on_hand" as const) : ("low_stock" as const) })));
    const after = await loadAlertSummary(db());
    expect(after.total - before.total).toBe(520);
    expect(after.byKind.low_stock - before.byKind.low_stock).toBe(519);
    expect(after.byKind.negative_on_hand - before.byKind.negative_on_hand).toBe(1);
    expect(after.materials).toBe(before.materials);
    const [direct] = await db()
      .select({ c: count() })
      .from(stockAlerts)
      .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
      .where(and(eq(stockAlerts.status, "open"), eq(stockItems.kind, "product")));
    expect(after.total).toBe(Number(direct!.c));
    expect(after.top).toHaveLength(5);
    expect(after.top[0]!.kind).toBe("negative_on_hand");
    const rank = { negative_on_hand: 0, oversold: 1, out_of_stock: 2, low_stock: 3 } as const;
    const ranks = after.top.map((a) => rank[a.kind]);
    expect(ranks).toEqual([...ranks].sort((x, y) => x - y));
    await db().delete(stockAlerts).where(inArray(stockAlerts.stockItemId, items));
  });
});

describe("notes and helpers", () => {
  it("cleanNote trims, collapses whitespace, caps length and masks personal data", () => {
    expect(cleanNote("   ")).toBeNull();
    expect(cleanNote(null)).toBeNull();
    expect(cleanNote("  a \n b  ")).toBe("a b");
    expect(cleanNote("x".repeat(600))!.length).toBe(500);
    expect(cleanNote("call 0671234567 or a@b.com")).not.toMatch(/0671234567|a@b\.com/);
    expect(cleanNote("order #1001, 3 pcs")).toBe("order #1001, 3 pcs");
  });
});

// Справжні паралельні транзакції — лише на PostgreSQL (TEST_DATABASE_URL); на PGlite (один процес, одне з'єднання)
// ці перевірки ПРОПУСКАЮТЬСЯ (у звіті vitest — skipped), а не «проходять» без виконання.
describe.skipIf(!process.env.TEST_DATABASE_URL)("threshold change vs. a concurrent movement (real PostgreSQL, inventory-7)", () => {
  it("a threshold change waits for the movement's balance lock: no contradictory low_stock + out_of_stock", async () => {
    expect(env.handle.driver).toBe("pg");
    for (const bulk of [true, false]) {
      const item = await freshItem(bulk ? "OPS-THR-RACE-B" : "OPS-THR-RACE-S", 10);
      expect(await openAlertKinds(db(), item)).toEqual([]);
      const warehouse = await getDefaultWarehouse(db());
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      let moved!: () => void;
      const movedSignal = new Promise<void>((r) => (moved = r));
      // Транзакція A: увесь залишок — у брак (available 0 → out_of_stock), лишається відкритою.
      const a = db().transaction(async (tx) => {
        await applyMovements(tx, STAFF, [
          { warehouseId: warehouse.id, stockItemId: item, type: "defect_mark", idempotencyKey: inventoryKeys.manual(newOperationId()), onHandDelta: -10, defectiveDelta: 10, reason: "other" },
        ]);
        moved();
        await gate;
      });
      await movedSignal;
      // Поки A відкрита: поріг 20 (за старим залишком 10 це було б «мало»).
      const threshold = bulk
        ? setLowStockThresholds(env.ctx(OWNER), { stockItemIds: [item], threshold: 20 })
        : setLowStockThreshold(env.ctx(OWNER), { stockItemId: item, threshold: 20 });
      await new Promise((r) => setTimeout(r, 300));
      release();
      await a;
      await threshold;
      expect(await openAlertKinds(db(), item)).toEqual(["out_of_stock"]);
    }
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("stocktake concurrency (real PostgreSQL)", () => {
  it("two simultaneous counts of the same item end consistently (last count wins, ledger sums to the balance)", async () => {
    expect(env.handle.driver).toBe("pg");
    const item = await freshItem("OPS-RACE", 10);
    const counts = [3, 12];
    const results = await Promise.all(
      counts.map((counted) => adjustToCount(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: counted })),
    );
    const final = (await balance(db(), item)).onHand;
    expect(counts).toContain(final);
    // Пізніший підрахунок застосовано від стану після першого (без втраченого оновлення).
    const later = results.find((r) => r.countedOnHand === final)!;
    const earlier = results.find((r) => r.countedOnHand !== final)!;
    expect(later.previousOnHand).toBe(earlier.countedOnHand);
    const ledger = await db()
      .select({ d: inventoryMovements.onHandDelta })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.stockItemId, item));
    expect(ledger.reduce((s, m) => s + m.d, 0)).toBe(final);
  });

  it("with the expected value seen by both counters, the second is rejected as changed", async () => {
    expect(env.handle.driver).toBe("pg");
    const item = await freshItem("OPS-RACE2", 10);
    const settled = await Promise.allSettled(
      [4, 6].map((counted) =>
        adjustToCount(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, countedOnHand: counted, expectedOnHand: 10 }),
      ),
    );
    const ok = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "warehouse.error.stocktakeChanged" });
    const final = (await balance(db(), item)).onHand;
    expect([4, 6]).toContain(final);
    expect(await movementCount(db(), { stockItemId: item, type: "adjustment" })).toBe(1);
  });

  it("the same form submitted twice in parallel writes one movement", async () => {
    expect(env.handle.driver).toBe("pg");
    const item = await freshItem("OPS-RACE3", 10);
    const operationId = newOperationId();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => receiveStock(env.ctx(STAFF), { operationId, stockItemId: item, quantity: 3, reason: "purchase" })),
    );
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect((await balance(db(), item)).onHand).toBe(13);
    const countId = newOperationId();
    const counts = await Promise.all(
      Array.from({ length: 3 }, () => adjustToCount(env.ctx(OWNER), { operationId: countId, stockItemId: item, countedOnHand: 20 })),
    );
    expect(counts.filter((r) => !r.replay)).toHaveLength(1);
    expect((await balance(db(), item)).onHand).toBe(20);
    // Та сама форма паралельно з РІЗНИМИ значеннями: одне записано, інше відхилено (не мовчазний повтор).
    const raceId = newOperationId();
    const settled = await Promise.allSettled(
      [5, 9].map((counted) => adjustToCount(env.ctx(OWNER), { operationId: raceId, stockItemId: item, countedOnHand: counted })),
    );
    const done = settled.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof adjustToCount>>> => r.status === "fulfilled");
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(done).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ code: "warehouse.error.countAlreadySaved" });
    expect((await balance(db(), item)).onHand).toBe(done[0]!.value.countedOnHand);
  });

  it("parallel pushable operations on different items share one queued push job without deadlocks", async () => {
    expect(env.handle.driver).toBe("pg");
    const items = await Promise.all(["OPS-PAR-1", "OPS-PAR-2", "OPS-PAR-3"].map((sku) => openedItem(sku, 5)));
    await withPushMode("deltas", async () => {
      await clearPushJobs();
      const results = await Promise.all(
        Array.from({ length: 9 }, (_, i) =>
          i % 3 === 2
            ? adjustToCount(prodCtx(OWNER), { operationId: newOperationId(), stockItemId: items[i % 3]!, countedOnHand: 7 + i })
            : receiveStock(prodCtx(STAFF), { operationId: newOperationId(), stockItemId: items[i % 3]!, quantity: 1 + i, reason: "purchase" }),
        ),
      );
      expect(results.every((r) => r.shopifyPushQueued)).toBe(true);
      expect(await queuedPushJobs()).toBe(1);
    });
    await clearPushJobs();
  });
});

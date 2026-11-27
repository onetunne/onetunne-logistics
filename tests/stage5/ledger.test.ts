import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { inventoryBalances, inventoryMovements, stockAlerts } from "~/db/schema";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { DomainError } from "~/lib/errors";
import {
  applyMovements,
  evaluateStockAlerts,
  getBalance,
  getBalances,
  lockBalances,
  movementHistory,
  setLowStockThreshold,
} from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { OWNER, openTestDatabase } from "../helpers";
import { ACTOR, apply, balance, insertMaterial, insertProduct, movementCount, openAlertKinds, stockItemFor } from "./helpers";

/** Ядро складського обліку на справжньому PostgreSQL (PGlite або TEST_DATABASE_URL). */
let h: DatabaseHandle;
let warehouseId: string;
let itemA: string;
let itemB: string;
let itemC: string;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  warehouseId = (await getDefaultWarehouse(h.db)).id;
  const p = await insertProduct(h.db, "Ledger Product", [
    { sku: "L-A", color: "Black", model: "X" },
    { sku: "L-B", color: "White", model: "X" },
    { sku: "L-C", color: "Black", model: "S" },
  ]);
  itemA = await stockItemFor(h.db, p.variantIds[0]!);
  itemB = await stockItemFor(h.db, p.variantIds[1]!);
  itemC = await stockItemFor(h.db, p.variantIds[2]!);
});
afterAll(async () => {
  await h.close();
});

describe("default warehouse", () => {
  it("exists exactly once and is idempotent", async () => {
    await seedReferenceData(h.db, DEMO_SETTINGS);
    const again = await getDefaultWarehouse(h.db);
    expect(again.id).toBe(warehouseId);
    expect(again.name).toBe("Основний склад");
    expect(again.isDefault).toBe(true);
    expect(again.active).toBe(true);
  });
});

describe("idempotency", () => {
  it("the same key twice → one movement, balance changed once", async () => {
    const first = await apply(h.db, { stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:idem:1", onHandDelta: 5 });
    const second = await apply(h.db, { stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:idem:1", onHandDelta: 5 });
    expect(first.applied).toHaveLength(1);
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.map((s) => s.idempotencyKey)).toEqual(["t:idem:1"]);
    expect(await movementCount(h.db, { key: "t:idem:1" })).toBe(1);
    expect((await balance(h.db, itemA)).onHand).toBe(5);
    expect(second.balances[0]).toMatchObject({ onHand: 5, available: 5 });
  });

  it("a duplicate key inside one call is applied once", async () => {
    const r = await h.db.transaction((tx) =>
      applyMovements(tx, ACTOR, [
        { warehouseId, stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:idem:2", onHandDelta: 2 },
        { warehouseId, stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:idem:2", onHandDelta: 2 },
      ]),
    );
    expect(r.applied).toHaveLength(1);
    expect(r.skipped).toHaveLength(1);
    expect((await balance(h.db, itemA)).onHand).toBe(7);
  });

  it("records the actor display name snapshot and context", async () => {
    await apply(h.db, { stockItemId: itemA, type: "adjustment", idempotencyKey: "t:idem:3", onHandDelta: -1, reason: "stocktake", note: "count" });
    const [m] = await h.db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, "t:idem:3"));
    expect(m).toMatchObject({ actorId: "test-owner", actorName: "Owner", reason: "stocktake", note: "count", onHandDelta: -1, type: "adjustment" });
    expect((await balance(h.db, itemA)).onHand).toBe(6);
  });
});

describe("concurrency (no lost updates, no doubles)", () => {
  it("the same reservation key in parallel is applied exactly once", async () => {
    const before = await balance(h.db, itemB);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        h.db.transaction((tx) =>
          applyMovements(tx, ACTOR, [{ warehouseId, stockItemId: itemB, type: "reserve", idempotencyKey: "t:conc:same", reservedDelta: 3 }]),
        ),
      ),
    );
    expect(results.reduce((n, r) => n + r.applied.length, 0)).toBe(1);
    expect(results.reduce((n, r) => n + r.skipped.length, 0)).toBe(7);
    const after = await balance(h.db, itemB);
    expect(after.reserved - before.reserved).toBe(3);
    expect(await movementCount(h.db, { key: "t:conc:same" })).toBe(1);
  });

  it("different keys on the same item in parallel all apply (no lost update)", async () => {
    const before = await balance(h.db, itemB);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        h.db.transaction((tx) =>
          applyMovements(tx, ACTOR, [{ warehouseId, stockItemId: itemB, type: "receipt_manual", idempotencyKey: `t:conc:k${i}`, onHandDelta: 1 }]),
        ),
      ),
    );
    const after = await balance(h.db, itemB);
    expect(after.onHand - before.onHand).toBe(20);
    expect(after.version - before.version).toBe(20);
  });

  it("parallel multi-item calls in opposite orders do not deadlock", async () => {
    const before = [await balance(h.db, itemA), await balance(h.db, itemC)];
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        h.db.transaction((tx) =>
          applyMovements(
            tx,
            ACTOR,
            (i % 2 === 0 ? [itemA, itemC] : [itemC, itemA]).map((stockItemId, j) => ({
              warehouseId,
              stockItemId,
              type: "receipt_manual" as const,
              idempotencyKey: `t:conc:multi:${i}:${j}`,
              onHandDelta: 1,
            })),
          ),
        ),
      ),
    );
    expect((await balance(h.db, itemA)).onHand - before[0]!.onHand).toBe(10);
    expect((await balance(h.db, itemC)).onHand - before[1]!.onHand).toBe(10);
  });

  it("parallel reservations never push reserved below zero when releasing", async () => {
    // 5 резервів по 1 і 5 зняттів по 1 паралельно: підсумок 0, частина зняттів може бути відхилена, але не «мінус».
    const base = await balance(h.db, itemC);
    const ops = [
      ...Array.from({ length: 5 }, (_, i) => ({ type: "reserve" as const, idempotencyKey: `t:conc:r${i}`, reservedDelta: 1 })),
      ...Array.from({ length: 5 }, (_, i) => ({ type: "release" as const, idempotencyKey: `t:conc:x${i}`, reservedDelta: -1 })),
    ];
    const settled = await Promise.allSettled(
      ops.map((op) => h.db.transaction((tx) => applyMovements(tx, ACTOR, [{ warehouseId, stockItemId: itemC, ...op }]))),
    );
    const after = await balance(h.db, itemC);
    expect(after.reserved).toBeGreaterThanOrEqual(0);
    const okReleases = settled.filter((s, i) => s.status === "fulfilled" && ops[i]!.type === "release").length;
    expect(after.reserved - base.reserved).toBe(5 - okReleases);
    for (const s of settled) if (s.status === "rejected") expect((s.reason as DomainError).code).toBe("inventory.insufficient");
    // Вирівнюємо для наступних перевірок.
    if (after.reserved > base.reserved) {
      await apply(h.db, { stockItemId: itemC, type: "release", idempotencyKey: "t:conc:cleanup", reservedDelta: -(after.reserved - base.reserved) });
    }
  });
});

describe("constraints", () => {
  it("reserved below zero → inventory.insufficient, nothing written", async () => {
    const before = await balance(h.db, itemA);
    await expect(
      apply(h.db, { stockItemId: itemA, type: "release", idempotencyKey: "t:c:1", reservedDelta: -(before.reserved + 1) }),
    ).rejects.toMatchObject({ code: "inventory.insufficient", status: 409 });
    expect(await movementCount(h.db, { key: "t:c:1" })).toBe(0);
    expect(await balance(h.db, itemA)).toMatchObject({ reserved: before.reserved, version: before.version });
  });

  it("a failed call rolls back to its savepoint: the caller's transaction stays usable", async () => {
    const before = await balance(h.db, itemA);
    await h.db.transaction(async (tx) => {
      await expect(
        applyMovements(tx, ACTOR, [
          { warehouseId, stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:c:2a", onHandDelta: 4 },
          { warehouseId, stockItemId: itemA, type: "defect_writeoff", idempotencyKey: "t:c:2b", defectiveDelta: -1000 },
        ]),
      ).rejects.toBeInstanceOf(DomainError);
      await applyMovements(tx, ACTOR, [{ warehouseId, stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:c:2c", onHandDelta: 1 }]);
    });
    expect(await movementCount(h.db, { key: "t:c:2a" })).toBe(0);
    expect(await movementCount(h.db, { key: "t:c:2b" })).toBe(0);
    expect(await movementCount(h.db, { key: "t:c:2c" })).toBe(1);
    expect((await balance(h.db, itemA)).onHand).toBe(before.onHand + 1);
  });

  it("an error in the caller after applyMovements rolls everything back", async () => {
    const before = await balance(h.db, itemA);
    await expect(
      h.db.transaction(async (tx) => {
        await applyMovements(tx, ACTOR, [{ warehouseId, stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:c:3", onHandDelta: 9 }]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await movementCount(h.db, { key: "t:c:3" })).toBe(0);
    expect((await balance(h.db, itemA)).onHand).toBe(before.onHand);
  });

  it("on_hand cannot go below zero for manual operations, defects or materials", async () => {
    const b = await balance(h.db, itemA);
    await expect(
      apply(h.db, { stockItemId: itemA, type: "adjustment", idempotencyKey: "t:c:4", onHandDelta: -(b.onHand + 1) }),
    ).rejects.toMatchObject({ code: "inventory.insufficient" });
    await expect(
      apply(h.db, { stockItemId: itemA, type: "defect_mark", idempotencyKey: "t:c:5", onHandDelta: -(b.onHand + 1), defectiveDelta: b.onHand + 1 }),
    ).rejects.toMatchObject({ code: "inventory.insufficient" });
    const box = await insertMaterial(h.db, "t-box");
    await expect(
      apply(h.db, { stockItemId: box.stockItemId, type: "material_consume", idempotencyKey: "t:c:6", onHandDelta: -1 }),
    ).rejects.toMatchObject({ code: "inventory.insufficient" });
  });

  it("the database CHECK constraints guard the buckets as a second line of defence", async () => {
    await expect(
      h.db.update(inventoryBalances).set({ reserved: -1 }).where(eq(inventoryBalances.stockItemId, itemA)),
    ).rejects.toThrow();
  });

  it("movement shape rules: buckets, signs and item kinds", async () => {
    const box = await insertMaterial(h.db, "t-box-2");
    const bad = [
      { stockItemId: itemA, type: "adjustment" as const, reservedDelta: 1 },
      { stockItemId: itemA, type: "reserve" as const, reservedDelta: -1 },
      { stockItemId: itemA, type: "consume_sale" as const, onHandDelta: 1 },
      { stockItemId: box.stockItemId, type: "reserve" as const, reservedDelta: 1 },
      { stockItemId: itemA, type: "material_consume" as const, onHandDelta: -1 },
      { stockItemId: itemA, type: "receipt_manual" as const, onHandDelta: 1.5 },
    ];
    for (const [i, m] of bad.entries()) {
      await expect(apply(h.db, { ...m, idempotencyKey: `t:shape:${i}` }), `case ${i}`).rejects.toMatchObject({ code: "inventory.invalidMovement" });
    }
    await expect(apply(h.db, { stockItemId: itemA, type: "receipt_manual", idempotencyKey: "", onHandDelta: 1 })).rejects.toMatchObject({
      code: "inventory.invalidMovement",
    });
    await expect(
      apply(h.db, { stockItemId: itemA, type: "receipt_manual", idempotencyKey: "t:shape:cost", onHandDelta: 1, unitCost: "1.00" }),
    ).rejects.toMatchObject({ code: "inventory.invalidMovement" });
  });
});

describe("negative on_hand after physical events", () => {
  it("consume_sale may go below zero and opens negative_on_hand; a receipt resolves it", async () => {
    const p = await insertProduct(h.db, "Neg", [{ sku: "N-1" }]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    await apply(h.db, { stockItemId: item, type: "reserve", idempotencyKey: "t:neg:r", reservedDelta: 2 });
    expect(await openAlertKinds(h.db, item)).toEqual(["out_of_stock", "oversold"]);
    const r = await apply(h.db, { stockItemId: item, type: "consume_sale", idempotencyKey: "t:neg:c", onHandDelta: -2, reservedDelta: -2 });
    expect(r.balances[0]).toMatchObject({ onHand: -2, reserved: 0, available: -2 });
    expect(r.openedAlerts.map((a) => a.kind)).toEqual(["negative_on_hand"]);
    expect(await openAlertKinds(h.db, item)).toEqual(["negative_on_hand", "out_of_stock"]);
    await apply(h.db, { stockItemId: item, type: "receipt_manual", idempotencyKey: "t:neg:in", onHandDelta: 20 });
    expect(await openAlertKinds(h.db, item)).toEqual([]);
    const resolved = await h.db.select().from(stockAlerts).where(and(eq(stockAlerts.stockItemId, item), eq(stockAlerts.status, "resolved")));
    expect(resolved.map((a) => a.kind).sort()).toEqual(["negative_on_hand", "out_of_stock", "oversold"]);
  });

  it("shopify_external below zero follows warehouse.allowNegativeOnHand", async () => {
    const p = await insertProduct(h.db, "Ext", [{ sku: "E-1" }]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    await apply(h.db, { stockItemId: item, type: "shopify_external", idempotencyKey: "t:ext:1", onHandDelta: -1 });
    expect((await balance(h.db, item)).onHand).toBe(-1);
    const current = (await h.db.query.settings.findFirst({ where: (s, { eq: e }) => e(s.key, "warehouse") }))!;
    await updateSetting(h.db, OWNER, "warehouse", { ...(current.value as object), allowNegativeOnHand: false });
    await expect(apply(h.db, { stockItemId: item, type: "shopify_external", idempotencyKey: "t:ext:2", onHandDelta: -1 })).rejects.toMatchObject({
      code: "inventory.insufficient",
    });
    await updateSetting(h.db, OWNER, "warehouse", { ...(current.value as object), allowNegativeOnHand: true });
  });
});

describe("stock alerts", () => {
  it("low / out of stock follow the threshold and are opened once", async () => {
    const p = await insertProduct(h.db, "Alerts", [{ sku: "AL-1" }]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    await apply(h.db, { stockItemId: item, type: "receipt_manual", idempotencyKey: "t:al:1", onHandDelta: 5 });
    expect(await openAlertKinds(h.db, item)).toEqual(["low_stock"]); // доступно 5 ≤ поріг 5
    await apply(h.db, { stockItemId: item, type: "receipt_manual", idempotencyKey: "t:al:2", onHandDelta: 1 });
    expect(await openAlertKinds(h.db, item)).toEqual([]);
    await apply(h.db, { stockItemId: item, type: "reserve", idempotencyKey: "t:al:3", reservedDelta: 6 });
    expect(await openAlertKinds(h.db, item)).toEqual(["out_of_stock"]);
    // Повторна оцінка не дублює відкриті попередження.
    await evaluateStockAlerts(h.db, [item]);
    await evaluateStockAlerts(h.db, [item]);
    const open = await h.db.select().from(stockAlerts).where(and(eq(stockAlerts.stockItemId, item), eq(stockAlerts.status, "open")));
    expect(open).toHaveLength(1);
    expect(open[0]!.details).toMatchObject({ onHand: 6, reserved: 6, available: 0, threshold: 5 });
  });

  it("an item threshold overrides the default", async () => {
    const p = await insertProduct(h.db, "Threshold", [{ sku: "TH-1" }]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    await apply(h.db, { stockItemId: item, type: "receipt_manual", idempotencyKey: "t:th:1", onHandDelta: 8 });
    expect(await openAlertKinds(h.db, item)).toEqual([]);
    await h.db.transaction((tx) => setLowStockThreshold(tx, item, 10));
    expect(await openAlertKinds(h.db, item)).toEqual(["low_stock"]);
    await h.db.transaction((tx) => setLowStockThreshold(tx, item, null));
    expect(await openAlertKinds(h.db, item)).toEqual([]);
  });
});

describe("Shopify sync state", () => {
  it("internal on_hand changes are 'skipped' while push is off and 'pending' with deltas; Shopify-known events are 'none'", async () => {
    const p = await insertProduct(h.db, "Sync", [{ sku: "SY-1" }]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    const box = await insertMaterial(h.db, "t-box-sync");
    const a = await apply(h.db, { stockItemId: item, type: "receipt_manual", idempotencyKey: "t:sy:1", onHandDelta: 3 });
    expect(a.applied[0]!.shopifySyncState).toBe("skipped");
    const current = (await h.db.query.settings.findFirst({ where: (s, { eq: e }) => e(s.key, "warehouse") }))!;
    await updateSetting(h.db, OWNER, "warehouse", { ...(current.value as object), shopifyPush: "deltas" });
    const b = await apply(h.db, { stockItemId: item, type: "adjustment", idempotencyKey: "t:sy:2", onHandDelta: -1 });
    const c = await apply(h.db, { stockItemId: item, type: "reserve", idempotencyKey: "t:sy:3", reservedDelta: 1 });
    const d = await apply(h.db, { stockItemId: box.stockItemId, type: "receipt_manual", idempotencyKey: "t:sy:4", onHandDelta: 3 });
    const e = await apply(h.db, { stockItemId: item, type: "defect_writeoff", idempotencyKey: "t:sy:5", defectiveDelta: 0 });
    expect([b, c, d, e].map((r) => r.applied[0]!.shopifySyncState)).toEqual(["pending", "none", "none", "none"]);
    await updateSetting(h.db, OWNER, "warehouse", { ...(current.value as object), shopifyPush: "off" });
  });
});

describe("reads", () => {
  it("getBalances lists every variant (zeros without movements) with filters by model, colour and status", async () => {
    const p = await insertProduct(h.db, "Read Model", [
      { sku: "RD-1", color: "Red", model: "Z" },
      { sku: "RD-2", color: "Blue", model: "Z" },
    ]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    await apply(h.db, { stockItemId: item, type: "receipt_manual", idempotencyKey: "t:rd:1", onHandDelta: 3 });
    const byModel = await getBalances(h.db, { models: ["Z"] });
    expect(byModel.total).toBe(2);
    const red = byModel.rows.find((r) => r.sku === "RD-1")!;
    const blue = byModel.rows.find((r) => r.sku === "RD-2")!;
    expect(red).toMatchObject({ onHand: 3, reserved: 0, available: 3, status: "low", threshold: 5, kind: "product", color: "Red" });
    expect(blue).toMatchObject({ onHand: 0, available: 0, status: "out", stockItemId: null });
    expect((await getBalances(h.db, { models: ["Z"], colors: ["Blue"] })).rows.map((r) => r.sku)).toEqual(["RD-2"]);
    expect((await getBalances(h.db, { models: ["Z"], statuses: ["low"] })).rows.map((r) => r.sku)).toEqual(["RD-1"]);
    expect((await getBalances(h.db, { search: "rd-2" })).rows.map((r) => r.sku)).toEqual(["RD-2"]);
    const paged = await getBalances(h.db, {}, { limit: 2, offset: 0 });
    expect(paged.rows).toHaveLength(2);
    expect(paged.total).toBeGreaterThan(2);
    const materials = await getBalances(h.db, { kind: "material" });
    expect(materials.rows.every((r) => r.kind === "material")).toBe(true);
    expect(await getBalance(h.db, item)).toMatchObject({ onHand: 3, available: 3 });
  });

  it("movement history is newest first and hides unit cost without includeCosts", async () => {
    await apply(h.db, {
      stockItemId: itemC,
      type: "receipt_manual",
      idempotencyKey: "t:hist:1",
      onHandDelta: 2,
      unitCost: "12.50",
      costCurrency: "UAH",
    });
    const plain = await movementHistory(h.db, { stockItemIds: [itemC], types: ["receipt_manual"] }, { limit: 5 });
    expect(plain.rows[0]).toMatchObject({ type: "receipt_manual", onHandDelta: 2, unitCost: null, costCurrency: null, sku: "L-C" });
    const owner = await movementHistory(h.db, { stockItemIds: [itemC], types: ["receipt_manual"] }, { limit: 5 }, { includeCosts: true });
    expect(owner.rows[0]).toMatchObject({ unitCost: "12.50", costCurrency: "UAH" });
    expect(owner.total).toBeGreaterThan(1);
  });

  it("lockBalances creates missing rows so 'set to' operations can compute deltas", async () => {
    const p = await insertProduct(h.db, "Lock", [{ sku: "LK-1" }]);
    const item = await stockItemFor(h.db, p.variantIds[0]!);
    await h.db.transaction(async (tx) => {
      const locked = await lockBalances(tx, [{ warehouseId, stockItemId: item }]);
      const b = locked.get(`${warehouseId}|${item}`)!;
      expect(b).toMatchObject({ onHand: 0, kind: "product" });
      await applyMovements(tx, ACTOR, [{ warehouseId, stockItemId: item, type: "adjustment", idempotencyKey: "t:lk:1", onHandDelta: 7 - b.onHand, reason: "stocktake" }]);
    });
    expect((await balance(h.db, item)).onHand).toBe(7);
  });
});

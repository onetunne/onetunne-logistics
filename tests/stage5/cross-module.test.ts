/**
 * Зв'язки між модулями етапу 5 (інтеграція потоків):
 * - надходження з виробництва ставить передачу залишків у Shopify (warehouse.shopifyPush = deltas);
 * - неактивний пакувальний матеріал не має відкритих попереджень навіть після руху через ядро.
 * PGlite або TEST_DATABASE_URL (справжній PostgreSQL).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, eq } from "drizzle-orm";
import { inventoryMovements, jobs, packagingMaterials, productionBatchLines, stockAlerts } from "~/db/schema";
import { applyMovements } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { createBatch, receiveProduction, startProduction } from "~/modules/production/batches.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { ACTOR, insertMaterial, insertProduct, stockItemFor } from "./helpers";

let env: TestEnv;
const db = () => env.handle.db;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function queuedPushJobs(): Promise<number> {
  const [row] = await db()
    .select({ c: count() })
    .from(jobs)
    .where(and(eq(jobs.type, "inventory.push"), eq(jobs.status, "queued")));
  return Number(row?.c ?? 0);
}

describe("production receipt → Shopify push queue", () => {
  it("queues inventory.push in the receipt transaction when push is on; nothing when it is off", async () => {
    const p = await insertProduct(db(), "Інтеграційне крило", [{ sku: "CM-X-BLK", model: "X", color: "Чорний" }]);
    const variantId = p.variantIds[0]!;
    const stockItemId = await stockItemFor(db(), variantId);
    const current = await getSetting(db(), "warehouse");

    const run = async (mode: "demo" | "production" = "production") => {
      const ctx = (actor: typeof OWNER) => ({ ...env.ctx(actor), mode });
      const { batchId } = await createBatch(ctx(OWNER), {
        title: "Інтеграційна партія",
        plannedReadyDate: "2030-01-15",
        manufacturer: "Вигаданий виробник",
        notes: null,
        lines: [{ variantId, quantity: 4 }],
      });
      await startProduction(ctx(OWNER), batchId, 1);
      const [line] = await db().select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
      await receiveProduction(ctx(STAFF), batchId, {
        idempotencyKey: globalThis.crypto.randomUUID(),
        lines: [{ batchLineId: line!.id, good: 3, defective: 1, defectReason: "подряпини" }],
      });
      const [mv] = await db()
        .select({ state: inventoryMovements.shopifySyncState })
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.stockItemId, stockItemId), eq(inventoryMovements.productionBatchId, batchId), eq(inventoryMovements.type, "receipt_production")));
      return mv!.state;
    };

    try {
      await db().delete(jobs).where(eq(jobs.type, "inventory.push"));
      await updateSetting(db(), OWNER, "warehouse", { ...current, shopifyPush: "deltas" });
      expect(await run()).toBe("pending");
      expect(await queuedPushJobs()).toBe(1);

      // Демо: Shopify не підключено — «не надсилалося», без завдання передачі (e2e-5).
      await db().delete(jobs).where(eq(jobs.type, "inventory.push"));
      expect(await run("demo")).toBe("skipped");
      expect(await queuedPushJobs()).toBe(0);

      await db().delete(jobs).where(eq(jobs.type, "inventory.push"));
      await updateSetting(db(), OWNER, "warehouse", { ...(await getSetting(db(), "warehouse")), shopifyPush: "off" });
      expect(await run()).not.toBe("pending");
      expect(await queuedPushJobs()).toBe(0);
    } finally {
      await updateSetting(db(), OWNER, "warehouse", { ...(await getSetting(db(), "warehouse")), shopifyPush: current.shopifyPush });
    }
  });
});

describe("inactive packaging materials never keep open alerts", () => {
  it("a core movement on an inactive material resolves its alerts and opens none", async () => {
    const { materialId, stockItemId } = await insertMaterial(db(), "CM-BOX-OLD");
    const w = await getDefaultWarehouse(db());
    const open = async () =>
      Number(
        (
          await db()
            .select({ c: count() })
            .from(stockAlerts)
            .where(and(eq(stockAlerts.stockItemId, stockItemId), eq(stockAlerts.status, "open")))
        )[0]?.c ?? 0,
      );
    const move = (key: string, onHand: number) =>
      db().transaction((tx) =>
        applyMovements(tx, ACTOR, [
          { warehouseId: w.id, stockItemId, type: "adjustment", idempotencyKey: key, onHandDelta: onHand, reason: "test" },
        ]),
      );
    await move("cm-mat-1", 1); // 1 ≤ поріг → «мало»
    expect(await open()).toBeGreaterThan(0);
    await db().update(packagingMaterials).set({ active: false }).where(eq(packagingMaterials.id, materialId));
    await move("cm-mat-2", -1); // 0 → «немає», але матеріал неактивний
    expect(await open()).toBe(0);
  });
});

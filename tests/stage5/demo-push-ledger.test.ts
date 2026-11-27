import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { inventoryConflicts, inventoryMovements, jobs } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import { applyMovements, movementOptionsFor } from "~/modules/inventory/ledger.server";
import { MOVEMENT_RULES, defaultShopifySyncState } from "~/modules/inventory/movement-types";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { acceptInTx } from "~/modules/inventory-sync/accept.server";
import { INVENTORY_SYNC_JOB } from "~/modules/inventory-sync/jobs";
import type { ConflictObservation } from "~/modules/inventory-sync/observation";
import { enqueueInventoryPushIfPending } from "~/modules/inventory-sync/schedule.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { OWNER, openTestDatabase } from "../helpers";
import { ACTOR, balance, insertProduct, stockItemFor } from "./helpers";

/**
 * Демо й передача в Shopify (H3, e2e-5): рухи товару, які створює синхронізація залишків (inventory-sync), ніколи не
 * стають «Очікує надсилання» і не ставлять завдання inventory.push. «Прийняти значення Shopify» (acceptInTx, вручну й
 * автоприйняттям звірки) пише shopify_external — зміну, що прийшла з Shopify, тож вона не надсилається назад
 * (стан "none") навіть з увімкненою передачею. Порівняння: внутрішня зміна (надходження) у робочому режимі — pending,
 * у демо (movementOptionsFor) — skipped і без завдання.
 */
let h: DatabaseHandle;
let stockItemId: string;
let warehouseId: string;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  const { variantIds } = await insertProduct(h.db, "Demo Push Tee", [{ sku: "DP-1" }]);
  stockItemId = await stockItemFor(h.db, variantIds[0]!);
  warehouseId = (await getDefaultWarehouse(h.db)).id;
  // Передачу ввімкнено в налаштуваннях (у демо власник може так зберегти для перегляду).
  const current = await getSetting(h.db, "warehouse");
  expect((await updateSetting(h.db, OWNER, "warehouse", { ...current, shopifyPush: "deltas" })).ok).toBe(true);
  await h.db.transaction((tx) =>
    applyMovements(tx, ACTOR, [{ warehouseId, stockItemId, type: "opening", idempotencyKey: `opening:${randomUUID()}`, onHandDelta: 20 }]),
  );
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(jobs).where(eq(jobs.type, INVENTORY_SYNC_JOB.push));
});

async function pushJobs(): Promise<number> {
  const rows = await h.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, INVENTORY_SYNC_JOB.push));
  return rows.length;
}

async function openConflict(diff: number): Promise<{ conflict: typeof inventoryConflicts.$inferSelect; obs: ConflictObservation }> {
  const b = await balance(h.db, stockItemId);
  const [conflict] = await h.db
    .insert(inventoryConflicts)
    .values({ stockItemId, warehouseId, appOnHand: b.onHand, shopifyOnHand: b.onHand + diff, shopifyAvailable: b.onHand + diff })
    .returning();
  // Лише поля, які читає acceptInTx (непояснена різниця, невдалі передачі) + обов'язкові поля спостереження.
  const obs = {
    kind: "reconciliation",
    observationSeq: 1,
    observedAt: new Date().toISOString(),
    inventoryItemId: "gid://shopify/InventoryItem/demo-push",
    locationId: "gid://shopify/Location/demo-push",
    appVersion: b.version,
    appOnHand: b.onHand,
    appReserved: 0,
    appAvailable: b.onHand,
    shopifyAvailable: b.onHand + diff,
    shopifyOnHand: b.onHand + diff,
    shopifyCommitted: 0,
    diff,
    expectedDiff: 0,
    committedNotReserved: 0,
    reservationExcess: 0,
    shopifyOtherStates: 0,
    inFlight: 0,
    fulfilledOutside: 0,
    uncertain: false,
    returnsPending: 0,
    returnsAwaiting: 0,
    failedMovementIds: [],
    failedDelta: 0,
    unsentCount: 0,
    unsentDelta: 0,
    unsentMovementIds: [],
  } satisfies ConflictObservation;
  return { conflict: conflict!, obs };
}

describe("demo push: inventory-sync movements never wait to be sent", () => {
  it("the assumption the code relies on: shopify_external is not pushable (state «none» in every push mode)", () => {
    expect(MOVEMENT_RULES.shopify_external.shopifyPushable).toBe(false);
    for (const mode of ["off", "deltas"] as const) {
      expect(defaultShopifySyncState("shopify_external", "product", -3, mode), mode).toBe("none");
      expect(defaultShopifySyncState("shopify_external", "product", 3, mode), mode).toBe("none");
    }
  });

  it("accepting the Shopify value (manual and automatic) writes shopify_external «none» and queues no push, push = deltas", async () => {
    expect((await getSetting(h.db, "warehouse")).shopifyPush).toBe("deltas");
    for (const [mode, diff] of [
      ["manual", -2],
      ["auto", 3],
    ] as const) {
      const { conflict, obs } = await openConflict(diff);
      const before = (await balance(h.db, stockItemId)).onHand;
      const r = await h.db.transaction((tx) => acceptInTx(tx, OWNER, conflict, obs, mode, new Date()));
      expect(r.delta, mode).toBe(diff);
      expect((await balance(h.db, stockItemId)).onHand, mode).toBe(before + diff);
      const [m] = await h.db
        .select({ type: inventoryMovements.type, state: inventoryMovements.shopifySyncState })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.shopifyExternal(conflict.id)));
      expect(m, mode).toEqual({ type: "shopify_external", state: "none" });
      expect(await pushJobs(), mode).toBe(0);
    }
    const pending = await h.db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.stockItemId, stockItemId), inArray(inventoryMovements.shopifySyncState, ["pending"])));
    expect(pending).toEqual([]);
  });

  it("comparison: an internal receipt is pending in production but «not sent» in the demo, and only production queues a push", async () => {
    const receipt = (ctx: { mode: "demo" | "production" }) =>
      h.db.transaction(async (tx) => {
        const res = await applyMovements(
          tx,
          ACTOR,
          [{ warehouseId, stockItemId, type: "receipt_manual", idempotencyKey: inventoryKeys.manual(randomUUID()), onHandDelta: 1 }],
          movementOptionsFor(ctx),
        );
        await enqueueInventoryPushIfPending(tx, res.applied);
        return res.applied[0]!.shopifySyncState;
      });
    expect(await receipt({ mode: "demo" })).toBe("skipped");
    expect(await pushJobs()).toBe(0);
    expect(await receipt({ mode: "production" })).toBe("pending");
    expect(await pushJobs()).toBe(1);
  });
});

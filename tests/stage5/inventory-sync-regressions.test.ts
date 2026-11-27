import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { inventoryConflicts, inventoryMovements, jobs, productVariants, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { inventoryKeys } from "~/modules/inventory/keys";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import type { MOVEMENT_TYPES } from "~/modules/inventory/movement-types";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { acceptShopifyValue, acceptShopifyValues, listConflicts, pushAppValue } from "~/modules/inventory-sync/conflicts.server";
import { INVENTORY_SYNC_JOB, PUSH_DEDUPE_KEY, PUSH_SWEEP_MS } from "~/modules/inventory-sync/jobs";
import { setWarehouseLocation } from "~/modules/inventory-sync/location.server";
import { parseObservation } from "~/modules/inventory-sync/observation";
import { compareLevels, movementReferenceUri, unexplainedDiff, verdictOf } from "~/modules/inventory-sync/pure";
import { runInventoryPush } from "~/modules/inventory-sync/push.server";
import { runReconcileJob } from "~/modules/inventory-sync/reconcile.server";
import { enqueueInventoryPush, enqueueInventoryPushIfPending } from "~/modules/inventory-sync/schedule.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertProduct } from "~/modules/shopify-sync/sync.server";
import { receiveStock } from "~/modules/warehouse/operations.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { RequestContext, ServiceContext } from "~/server/types";
import { gqlProduct } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";
import { apply, balance } from "./helpers";
import { LOC, LOC2, fakeInventoryAdmin, location, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Регресії синхронізації залишків (рев'ю етапу 5): вердикт diff = 0 при закріплених Shopify одиницях, розв'язання лише
 * непояснених різниць, зміна локації, «застряглі» pending, страховий обхід передачі, посилання referenceDocumentUri,
 * паралельні запуски на справжньому PostgreSQL (TEST_DATABASE_URL). Імітація Admin API — inventory-sync-fixtures.ts.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

const SHOP = "ot-regress.myshopify.com";
const APP_URL = "https://ot-app.example.com";
const FULL_SCOPES = "read_products,read_inventory,write_inventory";
const N = 10;

let h: DatabaseHandle;
let ctx: ServiceContext;
let fake: FakeInventoryAdmin;
const items: Record<number, { variantId: string; stockItemId: string; gid: string }> = {};

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new DemoShopifyGateway(), now: () => new Date() };
  m.ctx = { ...ctx, basePath: "/app", locale: "uk" };
  await h.db.insert(shopInstallations).values({ shop: SHOP, scopes: FULL_SCOPES });
  for (let n = 1; n <= N; n++) await upsertProduct(h.db, mapProduct(gqlProduct(n)), "EUR"); // inventoryQuantity 12
  await initializeInventory(ctx);
  fake = fakeInventoryAdmin();
  for (let n = 1; n <= N; n++) {
    const [v] = await h.db
      .select({ id: productVariants.id, gid: productVariants.inventoryItemId })
      .from(productVariants)
      .where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
    items[n] = { variantId: v!.id, stockItemId: await ensureStockItemForVariant(h.db, v!.id), gid: v!.gid! };
    fake.setLevel(v!.gid!, { available: 12, onHand: 12, committed: 0 });
  }
  await setWarehouse({ shopifyPush: "deltas" });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(jobs);
});

async function setWarehouse(patch: Record<string, unknown>) {
  const current = await getSetting(h.db, "warehouse");
  const r = await updateSetting(h.db, OWNER, "warehouse", { ...current, ...patch });
  expect(r.ok).toBe(true);
}

const adminFor = async () => fake.admin;
const push = () => runInventoryPush({ db: h.db, admin: adminFor, appUrl: APP_URL });
const handlers = () => createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: adminFor });
const reconcileItem = async (n: number) =>
  runReconcileJob({ db: h.db, admin: adminFor }, { scope: "item", inventoryItemGid: items[n]!.gid }).then((r) =>
    "results" in r ? r.results.map((x) => x.outcome) : [r.status],
  );
const level = (n: number) => fake.levels.get(items[n]!.gid)!;

async function movement(n: number, type: (typeof MOVEMENT_TYPES)[number], deltas: { onHandDelta?: number; defectiveDelta?: number }) {
  const res = await apply(h.db, { stockItemId: items[n]!.stockItemId, type, idempotencyKey: inventoryKeys.manual(randomUUID()), ...deltas });
  return res.applied[0]!;
}

async function syncState(movementId: string) {
  const [row] = await h.db.select({ s: inventoryMovements.shopifySyncState }).from(inventoryMovements).where(eq(inventoryMovements.id, movementId));
  return row?.s;
}

async function openConflict(n: number) {
  const [row] = await h.db
    .select()
    .from(inventoryConflicts)
    .where(and(eq(inventoryConflicts.stockItemId, items[n]!.stockItemId), eq(inventoryConflicts.status, "open")));
  return row ?? null;
}

const queuedPushJobs = () => h.db.select().from(jobs).where(and(eq(jobs.type, INVENTORY_SYNC_JOB.push), eq(jobs.status, "queued")));
/** Зробити заплановані завдання передачі такими, що настали (runJobsOnce бере лише ті, чий run_at минув). */
const makePushDue = () =>
  h.db
    .update(jobs)
    .set({ runAt: new Date(Date.now() - 1000) })
    .where(and(eq(jobs.type, INVENTORY_SYNC_JOB.push), eq(jobs.status, "queued")));

// ---------------------------------------------------------------------------

describe("verdict: equal «available» while Shopify holds units the app does not reserve", () => {
  it("is a discrepancy, not a match (pure)", () => {
    const none = { inFlight: 0, fulfilledOutside: 0, uncertain: false };
    const c = compareLevels({ available: 10, onHand: 12, committed: 2 }, { onHand: 10, reserved: 0 }, none);
    expect(c).toMatchObject({ diff: 0, expectedDiff: -2, committedNotReserved: 2 });
    expect(verdictOf(c)).toBe("conflict");
    expect(unexplainedDiff(c)).toBe(2);
    expect(verdictOf({ diff: 0, expectedDiff: 0 })).toBe("match");
    expect(verdictOf({ diff: -2, expectedDiff: -2 })).toBe("explained");
    expect(verdictOf({ diff: 3, expectedDiff: -2 })).toBe("conflict");
  });

  it("keeps the failed push as evidence, so a later reconciliation never adds the lost delta back (probe B)", async () => {
    const d = await movement(1, "defect_mark", { onHandDelta: -2, defectiveDelta: 2 });
    fake.inject({ userErrors: [{ field: ["input", "reason"], message: "bad", code: "INVALID_REASON" }] });
    expect(await push()).toMatchObject({ failed: 1 });
    expect(await syncState(d.id)).toBe("failed");
    // Неоплачене замовлення 2 шт. у Shopify: available 12 → 10, committed 2. «Доступно» збігається (10 = 10), але
    // Shopify мав би показувати 8.
    fake.setLevel(items[1]!.gid, { available: 10, onHand: 12, committed: 2 });
    expect(await reconcileItem(1)).toEqual(["opened"]);
    expect(await syncState(d.id)).toBe("failed");
    const obs = parseObservation((await openConflict(1))!.details)!;
    expect(obs).toMatchObject({ diff: 0, expectedDiff: -2, failedMovementIds: [d.id] });

    // Замовлення скасовано, власник увімкнув автоприйняття: невдала передача блокує його — склад не змінюється.
    fake.setLevel(items[1]!.gid, { available: 12, onHand: 12, committed: 0 });
    await setWarehouse({ externalShopifyChanges: "apply" });
    try {
      expect(await reconcileItem(1)).toEqual(["updated"]);
    } finally {
      await setWarehouse({ externalShopifyChanges: "review" });
    }
    expect(await balance(h.db, items[1]!.stockItemId)).toMatchObject({ onHand: 10, defective: 2 });
    // «Надіслати склад» доносить втрачену зміну; невдала передача закривається як pushed.
    expect(await pushAppValue(ctx, fake.admin, (await openConflict(1))!.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -2 });
    expect(level(1).available).toBe(10);
    expect(await syncState(d.id)).toBe("pushed");
    expect(await reconcileItem(1)).toEqual(["match"]);
  });
});

describe("resolution changes only the unexplained part of the difference (probes A, A2)", () => {
  // Shopify: неоплачене замовлення 2 шт. (available −2, committed +2) і ручне +5 → available 15, on_hand 17.
  const drifted = { available: 15, onHand: 17, committed: 2 };

  it("accept Shopify: on_hand += diff − expectedDiff; the order's units stay explained", async () => {
    fake.setLevel(items[2]!.gid, drifted);
    expect(await reconcileItem(2)).toEqual(["opened"]);
    const c = (await openConflict(2))!;
    expect(parseObservation(c.details)).toMatchObject({ diff: 3, expectedDiff: -2 });
    expect((await listConflicts(h.db, { conflictId: c.id })).rows[0]).toMatchObject({ diff: 3, unexplained: 5, expectedDiff: -2 });
    expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toMatchObject({ status: "accepted", delta: 5 });
    expect((await balance(h.db, items[2]!.stockItemId)).onHand).toBe(17); // = фізичний on_hand Shopify
    const [mv] = await h.db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, inventoryKeys.shopifyExternal(c.id)));
    expect(mv).toMatchObject({ onHandDelta: 5, type: "shopify_external" });
    expect(await reconcileItem(2)).toEqual(["explained"]);
    fake.setLevel(items[2]!.gid, { available: 17, onHand: 17, committed: 0 }); // замовлення скасовано
    expect(await reconcileItem(2)).toEqual(["match"]);
  });

  it("push app value: available −= diff − expectedDiff with CAS on the observed value", async () => {
    fake.setLevel(items[3]!.gid, drifted);
    expect(await reconcileItem(3)).toEqual(["opened"]);
    const c = (await openConflict(3))!;
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -5 });
    expect(fake.adjustCalls().at(-1)!.input).toMatchObject({ name: "available", changes: [{ delta: -5, changeFromQuantity: 15 }] });
    expect(level(3)).toMatchObject({ available: 10, onHand: 12, committed: 2 }); // on_hand Shopify = фізичний склад
    expect(await reconcileItem(3)).toEqual(["explained"]);
    fake.setLevel(items[3]!.gid, { available: 12, onHand: 12, committed: 0 });
    expect(await reconcileItem(3)).toEqual(["match"]);
  });

  it("bulk accept sums the unexplained parts", async () => {
    fake.setLevel(items[4]!.gid, { available: 9, onHand: 11, committed: 2 }); // замовлення 2 + ручне −1
    expect(await reconcileItem(4)).toEqual(["opened"]);
    const c = (await openConflict(4))!;
    expect(await acceptShopifyValues(ctx, [c.id], { admin: adminFor })).toEqual({ accepted: 1, already: 0, stale: 0, pending: 0, failed: 0, units: -1 });
    expect((await balance(h.db, items[4]!.stockItemId)).onHand).toBe(11);
    expect(await reconcileItem(4)).toEqual(["explained"]);
  });
});

describe("Shopify location change", () => {
  it("invalidates open conflicts and queues a full reconciliation (probe E)", async () => {
    fake.setLevel(items[5]!.gid, { available: 14, onHand: 14 });
    expect(await reconcileItem(5)).toEqual(["opened"]);
    const c = (await openConflict(5))!;
    expect(parseObservation(c.details)?.locationId).toBe(LOC);
    fake.locations.push(location(LOC2, "Pop-up"));
    try {
      await setWarehouseLocation(ctx, fake.admin, await getDefaultWarehouse(h.db), LOC2);
      const reconcileAll = await h.db.select().from(jobs).where(and(eq(jobs.type, INVENTORY_SYNC_JOB.reconcile), eq(jobs.status, "queued")));
      expect(reconcileAll.map((j) => (j.payload as { scope?: string }).scope)).toContain("all");
      // Спостереження з іншої локації: дії не виконуються, позиція звіряється заново вже в новій локації.
      const adjustBefore = fake.adjustCalls().length;
      expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "needs_reconcile", reconciled: "updated" });
      expect(fake.adjustCalls()).toHaveLength(adjustBefore);
      expect(parseObservation((await openConflict(5))!.details)).toMatchObject({ locationId: LOC2, observationSeq: 2 });
      // «Прийняти» зі спостереженням старої локації теж не виконується (і не змінює склад).
      await h.db
        .update(inventoryConflicts)
        .set({ details: { ...(await openConflict(5))!.details, locationId: LOC } })
        .where(eq(inventoryConflicts.id, c.id));
      const onHand = (await balance(h.db, items[5]!.stockItemId)).onHand;
      expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toEqual({ status: "needs_reconcile", reconciled: "updated" });
      expect((await balance(h.db, items[5]!.stockItemId)).onHand).toBe(onHand);
      expect(parseObservation((await openConflict(5))!.details)).toMatchObject({ locationId: LOC2, observationSeq: 3 });
      expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -2 });
      expect(fake.adjustCalls().at(-1)!.input.changes[0].locationId).toBe(LOC2);
    } finally {
      await setWarehouseLocation(ctx, fake.admin, await getDefaultWarehouse(h.db), LOC);
      fake.locations.pop();
    }
    expect((await getDefaultWarehouse(h.db)).shopifyLocationId).toBe(LOC);
  });
});

describe("pending movements never get stuck (probe F)", () => {
  it("push turned off after the movement: reconciliation queues the push job, which marks it skipped", async () => {
    const mv = await movement(6, "receipt_manual", { onHandDelta: 1 });
    expect(mv.shopifySyncState).toBe("pending");
    await setWarehouse({ shopifyPush: "off" });
    try {
      expect(await reconcileItem(6)).toEqual(["skipped_pending"]);
      expect(await queuedPushJobs()).toHaveLength(1);
      const adjustBefore = fake.adjustCalls().length;
      await runJobsOnce(h.db, handlers());
      expect(await syncState(mv.id)).toBe("skipped");
      expect(fake.adjustCalls()).toHaveLength(adjustBefore);
      expect(await queuedPushJobs()).toEqual([]); // передачу вимкнено — страховий обхід не продовжується
      // Позиція звіряється, дія з розбіжністю не «застаріла».
      expect(await reconcileItem(6)).toEqual(["opened"]);
      expect(await acceptShopifyValue(ctx, (await openConflict(6))!.id, { admin: adminFor })).toMatchObject({ status: "accepted", delta: -1 });
    } finally {
      await setWarehouse({ shopifyPush: "deltas" });
    }
  });

  it("write_inventory not granted: the same, with reason missing_scope", async () => {
    await h.db.update(shopInstallations).set({ scopes: "read_products,read_inventory" });
    try {
      const mv = await movement(6, "receipt_manual", { onHandDelta: 1 });
      expect(await reconcileItem(6)).toEqual(["skipped_pending"]);
      await runJobsOnce(h.db, handlers());
      expect(await syncState(mv.id)).toBe("skipped");
      // Передачу ввімкнено: ланцюжок обходу триває (нові рухи теж не застрягнуть).
      expect(await queuedPushJobs()).toHaveLength(1);
      await expect(pushAppValue(ctx, fake.admin, "00000000-0000-4000-8000-000000000000", { appUrl: APP_URL })).rejects.toMatchObject({
        code: "inventorySync.missingWriteScope",
      });
    } finally {
      await h.db.update(shopInstallations).set({ scopes: FULL_SCOPES });
    }
  });

  it("the setting switched off later is picked up by the next sweep (no caller needed)", async () => {
    // Запуск передачі без змін → наступний страховий обхід у черзі.
    await enqueueInventoryPush(h.db);
    await runJobsOnce(h.db, handlers());
    expect(await queuedPushJobs()).toHaveLength(1);
    const mv = await movement(7, "receipt_manual", { onHandDelta: 1 }); // модуль не поставив передачу
    await setWarehouse({ shopifyPush: "off" });
    try {
      await makePushDue();
      await runJobsOnce(h.db, handlers());
      expect(await syncState(mv.id)).toBe("skipped");
      expect(await queuedPushJobs()).toEqual([]);
    } finally {
      await setWarehouse({ shopifyPush: "deltas" });
    }
  });
});

describe("push scheduling", () => {
  it("a warehouse receipt queues inventory.push in its own transaction", async () => {
    const before = level(8).available;
    await receiveStock(ctx, { operationId: randomUUID(), stockItemId: items[8]!.stockItemId, quantity: 2, reason: "purchase" });
    const queued = await queuedPushJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    await runJobsOnce(h.db, handlers());
    expect(level(8).available).toBe(before + 2);
  });

  it("the sweep pushes movements of modules that did not enqueue; an explicit enqueue pulls the sweep forward", async () => {
    await enqueueInventoryPush(h.db);
    await runJobsOnce(h.db, handlers());
    const [sweep] = await queuedPushJobs();
    expect(sweep!.dedupeKey).toBe(PUSH_DEDUPE_KEY);
    expect(sweep!.runAt.getTime()).toBeGreaterThan(Date.now() + PUSH_SWEEP_MS - 60_000);
    expect(sweep!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + PUSH_SWEEP_MS);

    const mv = await movement(8, "receipt_manual", { onHandDelta: 1 });
    await runJobsOnce(h.db, handlers());
    expect(await syncState(mv.id)).toBe("pending"); // обхід ще не настав
    await makePushDue();
    await runJobsOnce(h.db, handlers());
    expect(await syncState(mv.id)).toBe("pushed");

    // Явна постановка не створює другого завдання, а пришвидшує заплановане.
    expect(await enqueueInventoryPush(h.db)).toBe(false);
    const now = await queuedPushJobs();
    expect(now).toHaveLength(1);
    expect(now[0]!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Хелпер для модулів: лише якщо серед записаних рухів є pending.
    await h.db.delete(jobs);
    expect(await enqueueInventoryPushIfPending(h.db, [{ shopifySyncState: "skipped" }, { shopifySyncState: "none" }])).toBe(false);
    expect(await queuedPushJobs()).toEqual([]);
    expect(await enqueueInventoryPushIfPending(h.db, [{ shopifySyncState: "none" }, { shopifySyncState: "pending" }])).toBe(true);
    expect(await queuedPushJobs()).toHaveLength(1);
  });
});

describe("referenceDocumentUri resolves to the movement", () => {
  it("the movement journal opened from the Shopify inventory history shows exactly that movement", async () => {
    const mv = await movement(9, "receipt_manual", { onHandDelta: 1 });
    await movement(9, "defect_mark", { onHandDelta: -1, defectiveDelta: 1 }); // інший рух тієї самої позиції
    await push();
    const uri = fake.adjustCalls().find((c) => c.key === `ot-mv-${mv.id}`)!.input.referenceDocumentUri as string;
    expect(uri).toBe(movementReferenceUri(APP_URL, { ...mv, stockItemId: items[9]!.stockItemId }));
    expect(uri.startsWith(`${APP_URL}/app/warehouse/movements?`)).toBe(true);
    const journal = await import("~/pages/warehouse-movements");
    const url = new URL(uri);
    const data = await journal.loader({ request: new Request(`http://localhost${url.pathname}${url.search}`), params: {}, context: {} } as never);
    expect(data.rows.map((r: { id: string }) => r.id)).toEqual([mv.id]);
  });
});

describe("concurrency (real PostgreSQL when TEST_DATABASE_URL is set)", () => {
  it("parallel push runs send a movement once", async () => {
    const before = level(10).available;
    const mv = await movement(10, "receipt_manual", { onHandDelta: 3 });
    const runs = await Promise.allSettled([push(), push(), push()]);
    expect(runs.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"]);
    expect(await syncState(mv.id)).toBe("pushed");
    expect(level(10).available).toBe(before + 3);
    expect(new Set(fake.adjustCalls().filter((c) => c.key === `ot-mv-${mv.id}`).map((c) => JSON.stringify(c.input))).size).toBe(1);
  });

  it("parallel «accept Shopify» clicks apply one movement", async () => {
    const start = (await balance(h.db, items[10]!.stockItemId)).onHand;
    fake.setLevel(items[10]!.gid, { available: start + 4, onHand: start + 4, committed: 0 });
    expect(await reconcileItem(10)).toEqual(["opened"]);
    const c = (await openConflict(10))!;
    const results = await Promise.all([acceptShopifyValue(ctx, c.id, { admin: adminFor }), acceptShopifyValue(ctx, c.id, { admin: adminFor }), acceptShopifyValue(ctx, c.id, { admin: adminFor })]);
    expect(results.filter((r) => r.status === "accepted")).toHaveLength(1);
    expect(results.filter((r) => r.status === "already")).toHaveLength(2);
    const moves = await h.db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, inventoryKeys.shopifyExternal(c.id)));
    expect(moves).toHaveLength(1);
    expect((await balance(h.db, items[10]!.stockItemId)).onHand).toBe(start + 4);
  });
});

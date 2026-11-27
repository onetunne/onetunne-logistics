import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, count, desc, eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { auditLog, inventoryConflicts, inventoryMovements, jobs, productVariants, shopInstallations, warehouses } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { ForbiddenError } from "~/domain/permissions";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import { SHOPIFY_ADJUST_REASONS, type GqlLocation } from "~/integrations/shopify/inventory-graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { inventoryKeys } from "~/modules/inventory/keys";
import { MOVEMENT_TYPES } from "~/modules/inventory/movement-types";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { acceptShopifyValue, acceptShopifyValues, dismissConflict, listConflicts, pushAppValue } from "~/modules/inventory-sync/conflicts.server";
import { INVENTORY_SYNC_JOB, RECONCILE_DELAY_MS, RECONCILE_MAX_DEFER_MS, reconcileItemDedupeKey } from "~/modules/inventory-sync/jobs";
import { locationFingerprint, setWarehouseLocation } from "~/modules/inventory-sync/location.server";
import { parseObservation } from "~/modules/inventory-sync/observation";
import {
  canAutoApply,
  classifyAdjustErrors,
  compareLevels,
  conflictPushKey,
  conflictReferenceUri,
  isOutsideIdempotencyWindow,
  movementReferenceUri,
  pickLocation,
  pushIdempotencyKey,
  shopifyReasonFor,
  verdictOf,
} from "~/modules/inventory-sync/pure";
import { runInventoryPush } from "~/modules/inventory-sync/push.server";
import { runReconcileJob } from "~/modules/inventory-sync/reconcile.server";
import { enqueueInventoryPush, scheduleReconcileForInventoryWebhook } from "~/modules/inventory-sync/schedule.server";
import { getInventorySyncOverview } from "~/modules/inventory-sync/status.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { JOB, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { gqlProduct } from "../stage2/fixtures";
import { OWNER, STAFF, openTestDatabase } from "../helpers";
import { apply, balance } from "./helpers";
import { LOC, LOC2, fakeInventoryAdmin, location, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Синхронізація залишків із Shopify (docs/stage5-design.md §10) з імітацією Admin API: передача рухів дельтою з
 * @idempotent, вікно ключа 23 год, звірка (відкриття/оновлення/закриття розбіжностей, пропуск позицій із
 * неперенесеними рухами, автоприйняття), дії власника (кожна ідемпотентна), webhook → відкладена звірка.
 */
const SHOP = "ot-test.myshopify.com";
const APP_URL = "https://ot-app.example.com";
const FULL_SCOPES = "write_orders,read_products,read_inventory,write_inventory";
const N = 12;

let h: DatabaseHandle;
let ctx: ServiceContext;
let fake: FakeInventoryAdmin;
const items: Record<number, { variantId: string; stockItemId: string; gid: string }> = {};

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = {
    mode: "production",
    db: h.db,
    actor: OWNER,
    carriers: createDemoCarriers(h.db),
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
  };
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

async function setWarehouse(patch: Record<string, unknown>) {
  const current = await getSetting(h.db, "warehouse");
  const r = await updateSetting(h.db, OWNER, "warehouse", { ...current, ...patch });
  expect(r.ok).toBe(true);
}

const adminFor = async () => fake.admin;
const push = () => runInventoryPush({ db: h.db, admin: adminFor, appUrl: APP_URL });
const reconcileItem = async (n: number) =>
  runReconcileJob({ db: h.db, admin: adminFor }, { scope: "item", inventoryItemGid: items[n]!.gid }).then((r) =>
    "results" in r ? r.results.map((x) => x.outcome) : [r.status],
  );

async function movement(n: number, type: (typeof MOVEMENT_TYPES)[number], deltas: { onHandDelta?: number; defectiveDelta?: number }) {
  const res = await apply(h.db, { stockItemId: items[n]!.stockItemId, type, idempotencyKey: inventoryKeys.manual(randomUUID()), ...deltas });
  return res.applied[0]!;
}
const receipt = (n: number, qty: number) => movement(n, "receipt_manual", { onHandDelta: qty });

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

async function conflictById(id: string) {
  const [row] = await h.db.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, id));
  return row!;
}

async function lastAudit(action: string, entityId?: string) {
  const [row] = await h.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), entityId ? eq(auditLog.entityId, entityId) : undefined))
    .orderBy(desc(auditLog.id))
    .limit(1);
  return row ?? null;
}

const level = (n: number) => fake.levels.get(items[n]!.gid)!;
const kyivDay = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// ---------------------------------------------------------------------------

describe("pure rules", () => {
  it("idempotency keys, references and documented reasons", () => {
    expect(pushIdempotencyKey("m-1")).toBe("ot-mv-m-1");
    expect(conflictPushKey("c-1", 3)).toBe("ot-cf-c-1-3");
    // 23:30 UTC 26.11 = 01:30 27.11 за Києвом: день у фільтрі журналу — київський.
    const ref = { id: "abc", stockItemId: "si-1", type: "receipt_manual", createdAt: new Date("2026-11-26T23:30:00Z") };
    expect(movementReferenceUri("https://ot-app.example.com/some/path", ref)).toBe(
      "https://ot-app.example.com/app/warehouse/movements?item=si-1&type=receipt_manual&from=2026-11-27&to=2026-11-27&movement=abc",
    );
    expect(conflictReferenceUri("https://ot-app.example.com", "c")).toBe("https://ot-app.example.com/app/warehouse/shopify?conflict=c");
    expect(movementReferenceUri("http://insecure.example.com", ref)).toBeNull();
    expect(movementReferenceUri(null, ref)).toBeNull();
    expect(shopifyReasonFor("receipt_production", null)).toBe("received");
    expect(shopifyReasonFor("receipt_manual", null)).toBe("received");
    expect(shopifyReasonFor("adjustment", "stocktake")).toBe("cycle_count_available");
    expect(shopifyReasonFor("adjustment", null)).toBe("correction");
    expect(shopifyReasonFor("defect_mark", null)).toBe("damaged");
    expect(shopifyReasonFor("defect_repair", null)).toBe("correction");
    for (const type of MOVEMENT_TYPES) expect(SHOPIFY_ADJUST_REASONS).toContain(shopifyReasonFor(type, null));
  });

  it("23h idempotency window", () => {
    const now = new Date("2026-11-27T12:00:00Z");
    expect(isOutsideIdempotencyWindow(new Date("2026-11-26T13:30:00Z"), now)).toBe(false); // 22,5 год
    expect(isOutsideIdempotencyWindow(new Date("2026-11-26T12:30:00Z"), now)).toBe(true); // 23,5 год
  });

  it("classifies userErrors: transient → retry with the same key, everything else → failed", () => {
    const e = (code: string | null) => ({ field: null, message: "x", code });
    expect(classifyAdjustErrors([])).toBeNull();
    expect(classifyAdjustErrors([e("IDEMPOTENCY_CONCURRENT_REQUEST")])).toEqual({ kind: "retry", code: "IDEMPOTENCY_CONCURRENT_REQUEST" });
    expect(classifyAdjustErrors([e("ADJUST_QUANTITIES_FAILED")])?.kind).toBe("retry");
    expect(classifyAdjustErrors([e("SERVICE_UNAVAILABLE")])?.kind).toBe("retry");
    expect(classifyAdjustErrors([e("IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED")])).toMatchObject({ kind: "failed", code: "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED" });
    expect(classifyAdjustErrors([e("SERVICE_UNAVAILABLE"), e("INVALID_LOCATION")])).toMatchObject({ kind: "failed", code: "INVALID_LOCATION" });
    expect(classifyAdjustErrors([e(null)])).toMatchObject({ kind: "failed", code: "UNKNOWN" });
  });

  it("picks only an unambiguous location", () => {
    const a = location(LOC, "A");
    const b = location(LOC2, "B");
    const fs: GqlLocation = location("gid://shopify/Location/3", "3PL", { isFulfillmentService: true });
    const off: GqlLocation = location("gid://shopify/Location/4", "Closed", { isActive: false });
    expect(pickLocation([a], false)).toEqual({ kind: "single", location: a });
    expect(pickLocation([a, fs, off], false)).toEqual({ kind: "single", location: a });
    expect(pickLocation([a, b], false).kind).toBe("ambiguous");
    expect(pickLocation([a], true).kind).toBe("ambiguous");
    expect(pickLocation([fs], false)).toEqual({ kind: "none" });
  });

  it("compares available and explains known differences", () => {
    const none = { inFlight: 0, fulfilledOutside: 0, uncertain: false };
    // Неоплачене замовлення в Shopify: available −2, committed +2 — очікувана різниця.
    const unpaid = compareLevels({ available: 8, onHand: 10, committed: 2 }, { onHand: 10, reserved: 0 }, none);
    expect(unpaid).toMatchObject({ diff: -2, expectedDiff: -2, committedNotReserved: 2 });
    expect(verdictOf(unpaid)).toBe("explained");
    // Передано перевізнику, у Shopify ще не виконано: «доступно» однакове.
    const inFlight = compareLevels({ available: 8, onHand: 11, committed: 3 }, { onHand: 9, reserved: 1 }, { ...none, inFlight: 2 });
    expect(inFlight).toMatchObject({ diff: 0, expectedDiff: 0 });
    expect(verdictOf(inFlight)).toBe("match");
    // Зміна в Shopify вручну.
    const external = compareLevels({ available: 13, onHand: 13, committed: 0 }, { onHand: 10, reserved: 0 }, none);
    expect(verdictOf(external)).toBe("conflict");
    expect(canAutoApply(external, 0)).toBe(true);
    expect(canAutoApply(external, 1)).toBe(false);
    expect(canAutoApply({ ...external, uncertain: true }, 0)).toBe(false);
    const mixed = compareLevels({ available: 11, onHand: 13, committed: 2 }, { onHand: 10, reserved: 0 }, none);
    expect(verdictOf(mixed)).toBe("conflict");
    expect(canAutoApply(mixed, 0)).toBe(false);
    expect(locationFingerprint(LOC)).toMatch(/^[a-p]{24}$/);
  });
});

describe("push (inventory.push)", () => {
  it("sends a pending movement with @idempotent key ot-mv-<id>, name available, null CAS and the movement URL", async () => {
    const m = await receipt(1, 5);
    expect(m.shopifySyncState).toBe("pending");
    const r = await push();
    expect(r).toMatchObject({ status: "done", pushed: 1, failed: 0 });
    const calls = fake.adjustCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.key).toBe(`ot-mv-${m.id}`);
    expect(calls[0]!.input).toEqual({
      name: "available",
      reason: "received",
      referenceDocumentUri: `${APP_URL}/app/warehouse/movements?item=${items[1]!.stockItemId}&type=receipt_manual&from=${kyivDay(m.createdAt)}&to=${kyivDay(m.createdAt)}&movement=${m.id}`,
      changes: [{ inventoryItemId: items[1]!.gid, locationId: LOC, delta: 5, changeFromQuantity: null }],
    });
    expect(Object.keys(calls[0]!.input)).toEqual(["name", "reason", "referenceDocumentUri", "changes"]);
    expect(JSON.stringify(calls[0]!.input)).toContain('"changeFromQuantity":null');
    expect(level(1).available).toBe(17);
    expect(await syncState(m.id)).toBe("pushed");
    // Єдина локація магазину збережена автоматично (власник підтверджує на сторінці).
    expect((await getDefaultWarehouse(h.db)).shopifyLocationId).toBe(LOC);
    expect(await lastAudit("inventory_sync.location_auto_selected")).not.toBeNull();
    expect((await getInventorySyncOverview(h.db)).locationAutoSelected).toBe(true);
    // Повторний запуск нічого не надсилає.
    await push();
    expect(fake.adjustCalls()).toHaveLength(1);
    // Брак: available −1, reason damaged.
    const d = await movement(1, "defect_mark", { onHandDelta: -1, defectiveDelta: 1 });
    await push();
    expect(fake.adjustCalls().at(-1)!.input).toMatchObject({ reason: "damaged", changes: [{ delta: -1 }] });
    expect(await syncState(d.id)).toBe("pushed");
    expect(level(1).available).toBe(16);
  });

  it("transient errors keep the movement pending and the retry reuses the same key (no double delta)", async () => {
    const m = await receipt(1, 2);
    fake.inject({ userErrors: [{ field: null, message: "busy", code: "IDEMPOTENCY_CONCURRENT_REQUEST" }] });
    await expect(push()).rejects.toMatchObject({ retryable: true });
    expect(await syncState(m.id)).toBe("pending");
    await push();
    expect(await syncState(m.id)).toBe("pushed");
    expect(fake.adjustCalls().slice(-2).map((c) => c.key)).toEqual([`ot-mv-${m.id}`, `ot-mv-${m.id}`]);
    expect(level(1).available).toBe(18);
    // Відповідь втрачено після застосування (тайм-аут) → повтор тим самим ключем → кешована відповідь.
    const m2 = await receipt(1, 3);
    fake.inject({ applyThenThrow: new ShopifyApiError("timeout", true, "NETWORK") });
    await expect(push()).rejects.toBeInstanceOf(ShopifyApiError);
    expect(level(1).available).toBe(21);
    expect(await syncState(m2.id)).toBe("pending");
    await push();
    expect(level(1).available).toBe(21);
    expect(await syncState(m2.id)).toBe("pushed");
  });

  it("userErrors and IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED → failed with the code, and the item is queued for reconciliation", async () => {
    const m = await receipt(2, 4);
    fake.inject({ userErrors: [{ field: ["input", "changes", "0", "inventoryItemId"], message: "bad", code: "INVALID_INVENTORY_ITEM" }] });
    expect(await push()).toMatchObject({ pushed: 0, failed: 1 });
    expect(await syncState(m.id)).toBe("failed");
    expect((await lastAudit("inventory_sync.push_failed", m.id))?.details).toMatchObject({ code: "INVALID_INVENTORY_ITEM" });
    const [job] = await h.db.select().from(jobs).where(and(eq(jobs.dedupeKey, reconcileItemDedupeKey(items[2]!.gid)), eq(jobs.status, "queued")));
    expect(job).toBeTruthy();
    expect(job!.runAt.getTime() - Date.now()).toBeLessThanOrEqual(61_000);
    // Невдалий рух більше не надсилається автоматично.
    const before = fake.adjustCalls().length;
    await push();
    expect(fake.adjustCalls()).toHaveLength(before);

    const m2 = await receipt(2, 1);
    fake.inject({ userErrors: [{ field: null, message: "prev", code: "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED" }] });
    await push();
    expect(await syncState(m2.id)).toBe("failed");
    const overview = await getInventorySyncOverview(h.db);
    expect(overview.push.failed).toBe(2);
    expect(overview.recentFailures.map((f) => [f.movementId, f.code])).toEqual(
      expect.arrayContaining([
        [m.id, "INVALID_INVENTORY_ITEM"],
        [m2.id, "IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED"],
      ]),
    );
  });

  it("failed pushes surface as a discrepancy; «push app value» fixes Shopify and settles them", async () => {
    // Склад 12 + 4 + 1 = 17, Shopify 12: різниця −5, пояснена невдалими передачами.
    expect(await reconcileItem(2)).toEqual(["opened"]);
    const c = (await openConflict(2))!;
    const obs = parseObservation(c.details)!;
    expect(obs).toMatchObject({ diff: -5, expectedDiff: 0, failedDelta: 5, appAvailable: 17, shopifyAvailable: 12 });
    expect(obs.failedMovementIds).toHaveLength(2);
    // Автоприйняття неможливе: Shopify, імовірно, не отримав зміни.
    const r = await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL });
    expect(r).toEqual({ status: "pushed", delta: 5 });
    expect(fake.adjustCalls().at(-1)).toMatchObject({
      key: `ot-cf-${c.id}-1`,
      input: { reason: "correction", changes: [{ delta: 5, changeFromQuantity: 12 }] },
    });
    expect(level(2).available).toBe(17);
    expect((await conflictById(c.id)).status).toBe("pushed_app");
    for (const id of obs.failedMovementIds) expect(await syncState(id)).toBe("pushed");
    expect(await reconcileItem(2)).toEqual(["match"]);
  });

  it("does not push movements older than 23 h: failed «idempotency_window»", async () => {
    const m = await receipt(3, 2);
    await h.db.update(inventoryMovements).set({ createdAt: new Date(Date.now() - 24 * 3600_000) }).where(eq(inventoryMovements.id, m.id));
    const young = await receipt(3, 1);
    await h.db.update(inventoryMovements).set({ createdAt: new Date(Date.now() - 22 * 3600_000) }).where(eq(inventoryMovements.id, young.id));
    const before = fake.adjustCalls().length;
    const r = await push();
    expect(r).toMatchObject({ expired: 1, pushed: 1 });
    expect(await syncState(m.id)).toBe("failed");
    expect(await syncState(young.id)).toBe("pushed");
    expect(fake.adjustCalls()).toHaveLength(before + 1);
    expect(fake.adjustCalls().at(-1)!.key).toBe(`ot-mv-${young.id}`);
    expect((await lastAudit("inventory_sync.push_failed", m.id))?.details).toMatchObject({ code: "idempotency_window" });
  });

  it("push off or missing write_inventory → pending movements are skipped, nothing is sent", async () => {
    const m = await receipt(4, 1);
    await setWarehouse({ shopifyPush: "off" });
    const before = fake.adjustCalls().length;
    expect(await push()).toMatchObject({ status: "skipped", skipReason: "push_off", skipped: 1 });
    expect(await syncState(m.id)).toBe("skipped");
    expect((await receipt(4, 1)).shopifySyncState).toBe("skipped");
    await setWarehouse({ shopifyPush: "deltas" });

    await h.db.update(shopInstallations).set({ scopes: "write_orders,read_products,read_inventory" });
    const m3 = await receipt(4, 1);
    expect(await push()).toMatchObject({ status: "skipped", skipReason: "missing_scope" });
    expect(await syncState(m3.id)).toBe("skipped");
    expect(fake.adjustCalls()).toHaveLength(before);
    expect((await lastAudit("inventory_sync.push_skipped"))?.details).toMatchObject({ reason: "missing_scope" });
    await h.db.update(shopInstallations).set({ scopes: FULL_SCOPES });
  });

  it("several Shopify locations → the owner chooses; until then movements stay pending", async () => {
    const w = await getDefaultWarehouse(h.db);
    await h.db.update(warehouses).set({ shopifyLocationId: null }).where(eq(warehouses.id, w.id));
    fake.locations.push(location(LOC2, "Pop-up"));
    try {
      const m = await receipt(1, 1);
      expect(await push()).toMatchObject({ status: "location_required" });
      expect(await syncState(m.id)).toBe("pending");
      expect((await getDefaultWarehouse(h.db)).shopifyLocationId).toBeNull();
      const fresh = await getDefaultWarehouse(h.db);
      await expect(setWarehouseLocation({ ...ctx, actor: STAFF }, fake.admin, fresh, LOC)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(setWarehouseLocation(ctx, fake.admin, fresh, "gid://shopify/Location/777")).rejects.toMatchObject({ code: "inventorySync.locationInvalid" });
      await setWarehouseLocation(ctx, fake.admin, fresh, LOC);
      const overview = await getInventorySyncOverview(h.db);
      expect(overview.locationId).toBe(LOC);
      expect(overview.locationConfirmation).not.toBeNull();
      expect(overview.locationAutoSelected).toBe(false);
      expect(await push()).toMatchObject({ pushed: 1 });
      expect(await syncState(m.id)).toBe("pushed");
    } finally {
      fake.locations.pop();
    }
  });
});

describe("reconciliation (inventory.reconcile)", () => {
  it("opens one conflict per item, updates it with fresh observations and closes it when values match again", async () => {
    expect(await reconcileItem(5)).toEqual(["match"]);
    expect(await openConflict(5)).toBeNull();
    fake.setLevel(items[5]!.gid, { available: 9, onHand: 9 });
    expect(await reconcileItem(5)).toEqual(["opened"]);
    const c = (await openConflict(5))!;
    expect(c).toMatchObject({ appOnHand: 12, shopifyOnHand: 9, shopifyAvailable: 9, expectedDiff: 0 });
    expect(parseObservation(c.details)).toMatchObject({ observationSeq: 1, diff: -3, appAvailable: 12, locationId: LOC, inventoryItemId: items[5]!.gid });
    fake.setLevel(items[5]!.gid, { available: 8, onHand: 8 });
    expect(await reconcileItem(5)).toEqual(["updated"]);
    const again = (await openConflict(5))!;
    expect(again.id).toBe(c.id);
    expect(parseObservation(again.details)).toMatchObject({ observationSeq: 2, diff: -4 });
    const [{ c: openCount }] = (await h.db
      .select({ c: count() })
      .from(inventoryConflicts)
      .where(and(eq(inventoryConflicts.stockItemId, items[5]!.stockItemId), eq(inventoryConflicts.status, "open")))) as [{ c: number }];
    expect(Number(openCount)).toBe(1);
    fake.setLevel(items[5]!.gid, { available: 12, onHand: 12 });
    expect(await reconcileItem(5)).toEqual(["closed"]);
    expect(await conflictById(c.id)).toMatchObject({ status: "dismissed", resolvedBy: "system" });
    expect((await conflictById(c.id)).details).toMatchObject({ resolution: "auto_resolved" });
    expect((await balance(h.db, items[5]!.stockItemId)).onHand).toBe(12);
  });

  it("skips items with pending pushes (no Shopify read) and re-schedules them", async () => {
    const m = await receipt(6, 2);
    const reads = () => fake.calls.filter((c) => c.op === "OtInventoryLevels").length;
    const before = reads();
    expect(await reconcileItem(6)).toEqual(["skipped_pending"]);
    expect(reads()).toBe(before);
    const [job] = await h.db.select().from(jobs).where(and(eq(jobs.dedupeKey, reconcileItemDedupeKey(items[6]!.gid)), eq(jobs.status, "queued")));
    expect(job?.payload).toMatchObject({ scope: "item", attempt: 1 });
    // Страховка: передачу поставлено в чергу, навіть якщо автор руху її не поставив.
    const pushJobs = await h.db.select().from(jobs).where(and(eq(jobs.type, INVENTORY_SYNC_JOB.push), eq(jobs.status, "queued")));
    expect(pushJobs).toHaveLength(1);
    expect(await openConflict(6)).toBeNull();
    await push();
    expect(await syncState(m.id)).toBe("pushed");
    expect(await reconcileItem(6)).toEqual(["match"]);
  });

  it("items not opened in accounting are not read from Shopify", async () => {
    await upsertProduct(h.db, mapProduct(gqlProduct(40)), "EUR");
    const callsBefore = fake.calls.length;
    const job = () => runReconcileJob({ db: h.db, admin: adminFor }, { scope: "item", inventoryItemGid: "gid://shopify/InventoryItem/4001" });
    expect(await job()).toEqual({ status: "done", results: [] }); // ще немає позиції обліку
    const [v] = await h.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.inventoryItemId, "gid://shopify/InventoryItem/4001"));
    await ensureStockItemForVariant(h.db, v!.id);
    expect(await job()).toMatchObject({ status: "done", results: [{ outcome: "not_opened" }] });
    expect(fake.calls.length).toBe(callsBefore);
    // Webhook для невідкритого товару звірку не планує.
    expect(await scheduleReconcileForInventoryWebhook(h.db, SHOP, "gid://shopify/InventoryItem/4001")).toBe(false);
    expect(await h.db.select().from(jobs).where(eq(jobs.dedupeKey, reconcileItemDedupeKey("gid://shopify/InventoryItem/4001")))).toEqual([]);
  });

  it("unpaid orders held in Shopify are an explained difference; external changes are applied automatically when chosen", async () => {
    fake.setLevel(items[7]!.gid, { available: 10, onHand: 12, committed: 2 });
    expect(await reconcileItem(7)).toEqual(["explained"]);
    expect(await openConflict(7)).toBeNull();

    await setWarehouse({ externalShopifyChanges: "apply" });
    try {
      fake.setLevel(items[7]!.gid, { available: 15, onHand: 15, committed: 0 });
      expect(await reconcileItem(7)).toEqual(["auto_applied"]);
      expect((await balance(h.db, items[7]!.stockItemId)).onHand).toBe(15);
      const [conflict] = await h.db.select().from(inventoryConflicts).where(eq(inventoryConflicts.stockItemId, items[7]!.stockItemId));
      expect(conflict).toMatchObject({ status: "accepted_shopify", resolvedBy: "system" });
      expect(conflict!.details).toMatchObject({ resolution: "auto_applied" });
      const moves = await h.db
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.stockItemId, items[7]!.stockItemId), eq(inventoryMovements.type, "shopify_external")));
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ idempotencyKey: inventoryKeys.shopifyExternal(conflict!.id), onHandDelta: 3, shopifySyncState: "none" });
      expect(await reconcileItem(7)).toEqual(["match"]);

      // Різниця з іншими поясненнями (Shopify закріпив одиниці) — лише на розгляд.
      fake.setLevel(items[7]!.gid, { available: 14, onHand: 17, committed: 3 });
      expect(await reconcileItem(7)).toEqual(["opened"]);
      expect((await balance(h.db, items[7]!.stockItemId)).onHand).toBe(15);
      await dismissConflict(ctx, (await openConflict(7))!.id, "Перевірено");

      // Від'ємний on_hand заборонено налаштуванням → автоприйняття не виконано, розбіжність відкрита.
      await setWarehouse({ allowNegativeOnHand: false });
      fake.setLevel(items[7]!.gid, { available: -5, onHand: -5, committed: 0 });
      expect(await reconcileItem(7)).toEqual(["opened"]);
      const blocked = (await openConflict(7))!;
      expect(blocked.details).toMatchObject({ autoApplyBlocked: "insufficient" });
      expect((await balance(h.db, items[7]!.stockItemId)).onHand).toBe(15);
      await dismissConflict(ctx, blocked.id, "Перевірено");
    } finally {
      await setWarehouse({ externalShopifyChanges: "review", allowNegativeOnHand: true });
      fake.setLevel(items[7]!.gid, { available: 15, onHand: 15, committed: 0 });
    }
  });
});

describe("conflict resolution (owner actions)", () => {
  it("accept Shopify: permission, demo refusal, stale observation, idempotent movement", async () => {
    fake.setLevel(items[8]!.gid, { available: 10, onHand: 10 });
    expect(await reconcileItem(8)).toEqual(["opened"]);
    const c = (await openConflict(8))!;
    await expect(acceptShopifyValue({ ...ctx, actor: STAFF }, c.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(acceptShopifyValue({ ...ctx, mode: "demo" }, c.id)).rejects.toMatchObject({ code: "inventorySync.demoUnavailable" });

    // Баланс змінився після звірки (брак без зміни on_hand) → застаріле спостереження, нова звірка.
    await movement(8, "adjustment", { defectiveDelta: 1 });
    const stale = await acceptShopifyValue(ctx, c.id, { admin: adminFor });
    expect(stale).toEqual({ status: "stale", reconciled: "updated" });
    expect(parseObservation((await conflictById(c.id)).details)?.observationSeq).toBe(2);

    expect(await acceptShopifyValue(ctx, c.id)).toMatchObject({ status: "accepted", delta: -2 });
    expect((await balance(h.db, items[8]!.stockItemId)).onHand).toBe(10);
    expect(await acceptShopifyValue(ctx, c.id)).toEqual({ status: "already" });
    const moves = await h.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.shopifyExternal(c.id)));
    expect(moves).toHaveLength(1);
    expect((await balance(h.db, items[8]!.stockItemId)).onHand).toBe(10);
    await expect(dismissConflict(ctx, c.id, "note")).rejects.toMatchObject({ code: "inventorySync.conflictResolved" });
    expect(await reconcileItem(8)).toEqual(["match"]);
  });

  it("push app value: CAS on the observed Shopify value, idempotent, stale → re-reconcile with a new key", async () => {
    fake.setLevel(items[8]!.gid, { available: 7, onHand: 7 });
    expect(await reconcileItem(8)).toEqual(["opened"]);
    const c = (await openConflict(8))!;
    await expect(pushAppValue({ ...ctx, actor: STAFF }, fake.admin, c.id, { appUrl: APP_URL })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: 3 });
    expect(fake.adjustCalls().at(-1)).toMatchObject({
      key: `ot-cf-${c.id}-1`,
      input: {
        name: "available",
        reason: "correction",
        referenceDocumentUri: `${APP_URL}/app/warehouse/shopify?conflict=${c.id}`,
        changes: [{ inventoryItemId: items[8]!.gid, locationId: LOC, delta: 3, changeFromQuantity: 7 }],
      },
    });
    expect(level(8).available).toBe(10);
    const calls = fake.adjustCalls().length;
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "already" });
    expect(fake.adjustCalls()).toHaveLength(calls);
    expect(level(8).available).toBe(10);

    fake.setLevel(items[8]!.gid, { available: 6, onHand: 6 });
    expect(await reconcileItem(8)).toEqual(["opened"]);
    const c3 = (await openConflict(8))!;
    fake.setLevel(items[8]!.gid, { available: 5, onHand: 5 }); // змінилося в Shopify після звірки
    expect(await pushAppValue(ctx, fake.admin, c3.id, { appUrl: APP_URL })).toEqual({ status: "stale", reconciled: "updated" });
    expect(level(8).available).toBe(5);
    expect(parseObservation((await conflictById(c3.id)).details)).toMatchObject({ observationSeq: 2, shopifyAvailable: 5, diff: -5 });
    expect(await pushAppValue(ctx, fake.admin, c3.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: 5 });
    expect(fake.adjustCalls().at(-1)!.key).toBe(`ot-cf-${c3.id}-2`);
    expect(level(8).available).toBe(10);
  });

  it("dismiss requires a note and is idempotent; stock is unchanged", async () => {
    fake.setLevel(items[8]!.gid, { available: 11, onHand: 11 });
    expect(await reconcileItem(8)).toEqual(["opened"]);
    const c = (await openConflict(8))!;
    await expect(dismissConflict(ctx, c.id, "   ")).rejects.toMatchObject({ code: "inventorySync.noteRequired" });
    expect(await dismissConflict(ctx, c.id, "Перевірено вручну")).toEqual({ status: "dismissed" });
    expect(await dismissConflict(ctx, c.id, "ще раз")).toEqual({ status: "already" });
    expect((await conflictById(c.id)).details).toMatchObject({ resolution: "dismissed", dismissNote: "Перевірено вручну" });
    expect((await balance(h.db, items[8]!.stockItemId)).onHand).toBe(10);
    fake.setLevel(items[8]!.gid, { available: 10, onHand: 10 });
  });

  it("a conflict from inventory initialization is reconciled first (origin kept), then becomes resolvable", async () => {
    const w = await getDefaultWarehouse(h.db);
    const [legacy] = await h.db
      .insert(inventoryConflicts)
      .values({
        stockItemId: items[9]!.stockItemId,
        warehouseId: w.id,
        appOnHand: 12,
        shopifyOnHand: 10,
        shopifyAvailable: 10,
        details: { reason: "opened_with_internal_history", internalOnHand: 2, snapshotAt: new Date().toISOString() },
      })
      .returning();
    expect((await listConflicts(h.db, { status: "open" })).rows.find((r) => r.id === legacy!.id)).toMatchObject({
      resolvable: false,
      origin: "opened_with_internal_history",
      diff: null,
    });
    fake.setLevel(items[9]!.gid, { available: 14, onHand: 14 });
    expect(await acceptShopifyValue(ctx, legacy!.id, { admin: adminFor })).toEqual({ status: "needs_reconcile", reconciled: "updated" });
    const row = (await listConflicts(h.db, { status: "open" })).rows.find((r) => r.id === legacy!.id)!;
    expect(row).toMatchObject({ resolvable: true, origin: "opened_with_internal_history", diff: 2 });
    expect(parseObservation((await conflictById(legacy!.id)).details)).toMatchObject({ observationSeq: 1, internalOnHand: 2 });
    fake.setLevel(items[9]!.gid, { available: 12, onHand: 12 });
    expect(await reconcileItem(9)).toEqual(["closed"]);
    expect((await balance(h.db, items[9]!.stockItemId)).onHand).toBe(12);
  });

  it("bulk accept counts units and skips duplicates/invalid ids", async () => {
    fake.setLevel(items[10]!.gid, { available: 14, onHand: 14 });
    fake.setLevel(items[11]!.gid, { available: 9, onHand: 9 });
    expect(await reconcileItem(10)).toEqual(["opened"]);
    expect(await reconcileItem(11)).toEqual(["opened"]);
    const c10 = (await openConflict(10))!;
    const c11 = (await openConflict(11))!;
    const list = await listConflicts(h.db, { status: "open" });
    expect(list.rows.map((r) => r.id)).toEqual(expect.arrayContaining([c10.id, c11.id]));
    expect(list.rows.find((r) => r.id === c10.id)).toMatchObject({ diff: 2, appAvailable: 12, shopifyAvailable: 14, resolvable: true });
    const r = await acceptShopifyValues(ctx, [c10.id, c11.id, c10.id, "not-a-uuid"]);
    expect(r).toEqual({ accepted: 2, already: 0, stale: 0, failed: 0, units: -1 });
    expect((await balance(h.db, items[10]!.stockItemId)).onHand).toBe(14);
    expect((await balance(h.db, items[11]!.stockItemId)).onHand).toBe(9);
    expect(await acceptShopifyValues(ctx, [c10.id])).toMatchObject({ accepted: 0, already: 1 });
  });
});

describe("full reconciliation, webhook and job handlers", () => {
  it("full reconciliation checks every opened item and records the summary", async () => {
    const r = await runReconcileJob({ db: h.db, admin: adminFor }, { scope: "all", after: null, startedAt: new Date().toISOString() });
    expect(r.status).toBe("done");
    if (r.status !== "done") return;
    expect(r.summary?.checked).toBe(N);
    const overview = await getInventorySyncOverview(h.db);
    expect(overview.lastReconcile?.summary.checked).toBe(N);
    expect(overview.lastReconcile!.summary.match + overview.lastReconcile!.summary.explained).toBeGreaterThan(0);
  });

  it("enqueueInventoryPush is deduplicated and the registered handler pushes", async () => {
    await h.db.delete(jobs);
    const m = await receipt(12, 3);
    expect(await enqueueInventoryPush(h.db)).toBe(true);
    expect(await enqueueInventoryPush(h.db)).toBe(false);
    const handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: adminFor });
    expect(Object.keys(handlers)).toEqual(expect.arrayContaining([INVENTORY_SYNC_JOB.push, INVENTORY_SYNC_JOB.reconcile]));
    await runJobsOnce(h.db, handlers);
    expect(await syncState(m.id)).toBe("pushed");
    expect(level(12).available).toBe(15);
  });

  it("inventory_levels/update webhook schedules a delayed, deduplicated reconciliation (value not applied directly)", async () => {
    await h.db.delete(jobs);
    const gid = items[9]!.gid;
    const numericId = gid.split("/").pop()!;
    const before = Date.now();
    expect(
      await handleShopifyWebhook(h.db, { topic: "inventory_levels/update", shop: SHOP, webhookId: "wh-inv-1", payload: { inventory_item_id: Number(numericId), location_id: 9001, available: 3 } }),
    ).toBe("queued");
    expect(
      await handleShopifyWebhook(h.db, { topic: "inventory_levels/update", shop: SHOP, webhookId: "wh-inv-1", payload: { inventory_item_id: Number(numericId) } }),
    ).toBe("duplicate");
    const handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: adminFor });
    const [syncJob] = await h.db.select().from(jobs).where(eq(jobs.type, JOB.syncInventoryItem));
    await handlers[JOB.syncInventoryItem]!.run(syncJob!);
    const reconcileJobs = () =>
      h.db.select().from(jobs).where(and(eq(jobs.type, INVENTORY_SYNC_JOB.reconcile), eq(jobs.status, "queued")));
    let queued = await reconcileJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.dedupeKey).toBe(reconcileItemDedupeKey(gid));
    expect(queued[0]!.payload).toMatchObject({ scope: "item", inventoryItemGid: gid, shop: SHOP });
    const firstRunAt = queued[0]!.runAt.getTime();
    expect(firstRunAt).toBeGreaterThanOrEqual(before + RECONCILE_DELAY_MS - 1000);
    expect(firstRunAt).toBeLessThanOrEqual(Date.now() + RECONCILE_DELAY_MS + 1000);
    // Повторна подія: те саме завдання, звірку відкладено, але не далі ніж на 30 хв від першої.
    await new Promise((r) => setTimeout(r, 20));
    await handlers[JOB.syncInventoryItem]!.run(syncJob!);
    queued = await reconcileJobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.runAt.getTime()).toBeGreaterThanOrEqual(firstRunAt);
    expect(queued[0]!.runAt.getTime()).toBeLessThanOrEqual(queued[0]!.createdAt.getTime() + RECONCILE_MAX_DEFER_MS);
    // Значення з webhook не застосовується; звірка ще не настала (runJobsOnce її не бере).
    expect((await balance(h.db, items[9]!.stockItemId)).onHand).toBe(12);
    await h.db.delete(jobs).where(eq(jobs.type, JOB.syncProduct));
    await runJobsOnce(h.db, handlers);
    expect(await reconcileJobs()).toHaveLength(1);
  });
});

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { auditLog, inventoryConflicts, inventoryMovements, jobs, orderLineItems, orders, productVariants, shipments, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { inventoryItemGidFromLevelPayload } from "~/integrations/shopify/inventory-graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { inventoryKeys } from "~/modules/inventory/keys";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import {
  acceptShopifyValue,
  acceptShopifyValues,
  dismissConflict,
  listConflicts,
  pushAppValue,
  type AcceptResult,
} from "~/modules/inventory-sync/conflicts.server";
import { fetchLocations, setWarehouseLocation } from "~/modules/inventory-sync/location.server";
import { parseObservation } from "~/modules/inventory-sync/observation";
import {
  autoApplyBlockers,
  autoApplyEffective,
  canAutoApply,
  compareLevels,
  pickLocation,
  unexplainedDiff,
  verdictOf,
} from "~/modules/inventory-sync/pure";
import { runInventoryPush } from "~/modules/inventory-sync/push.server";
import { fulfillmentTiming, reconcileStockItemNow, runReconcileJob } from "~/modules/inventory-sync/reconcile.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { JOB, upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { receiveStock } from "~/modules/warehouse/operations.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { RequestContext, ServiceContext } from "~/server/types";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";
import { apply, balance } from "./helpers";
import { LOC, fakeInventoryAdmin, location, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Безпека синхронізації залишків (рев'ю етапу 5, раунд 2): автоприйняття й дії власника ніколи не скасовують внутрішніх
 * змін, яких Shopify не отримав; розбіжності пояснювані; у Shopify нічого не пишеться без явного вибору власника.
 * Кожен тест відтворює сценарій знахідки (shopify-1…9, m1, m2, security-5) і падає без виправлення.
 * Імітація Admin API — inventory-sync-fixtures.ts. Справжній PostgreSQL — TEST_DATABASE_URL.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

const SHOP = "ot-safety.myshopify.com";
const APP_URL = "https://ot-app.example.com";
const FULL_SCOPES = "read_products,read_inventory,write_inventory";
const N = 15;

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
  for (let n = 1; n <= N; n++) await register(n);
  await setWarehouse({ shopifyPush: "deltas", externalShopifyChanges: "review" });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.db.delete(jobs);
});

async function register(n: number) {
  const [v] = await h.db
    .select({ id: productVariants.id, gid: productVariants.inventoryItemId })
    .from(productVariants)
    .where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
  items[n] = { variantId: v!.id, stockItemId: await ensureStockItemForVariant(h.db, v!.id), gid: v!.gid! };
  fake.setLevel(v!.gid!, { available: 12, onHand: 12, committed: 0 });
}

async function setWarehouse(patch: Record<string, unknown>) {
  const current = await getSetting(h.db, "warehouse");
  const r = await updateSetting(h.db, OWNER, "warehouse", { ...current, ...patch });
  expect(r.ok).toBe(true);
}

async function withApply<T>(fn: () => Promise<T>): Promise<T> {
  await setWarehouse({ externalShopifyChanges: "apply" });
  try {
    return await fn();
  } finally {
    await setWarehouse({ externalShopifyChanges: "review" });
  }
}

const adminFor = async () => fake.admin;
const push = () => runInventoryPush({ db: h.db, admin: adminFor, appUrl: APP_URL });
const reconcileItem = async (n: number) =>
  runReconcileJob({ db: h.db, admin: adminFor }, { scope: "item", inventoryItemGid: items[n]!.gid }).then((r) =>
    "results" in r ? r.results.map((x) => x.outcome) : [r.status],
  );
const onHand = async (n: number) => (await balance(h.db, items[n]!.stockItemId)).onHand;
const level = (n: number) => fake.levels.get(items[n]!.gid)!;
const receipt = async (n: number, qty: number) =>
  (await apply(h.db, { stockItemId: items[n]!.stockItemId, type: "receipt_manual", idempotencyKey: inventoryKeys.manual(randomUUID()), onHandDelta: qty })).applied[0]!;

async function openConflict(n: number) {
  const [row] = await h.db
    .select()
    .from(inventoryConflicts)
    .where(and(eq(inventoryConflicts.stockItemId, items[n]!.stockItemId), eq(inventoryConflicts.status, "open")));
  return row ?? null;
}
const observation = async (n: number) => parseObservation((await openConflict(n))!.details)!;
const view = async (id: string) => (await listConflicts(h.db, { conflictId: id })).rows[0]!;

async function syncState(movementId: string) {
  const [row] = await h.db.select({ s: inventoryMovements.shopifySyncState }).from(inventoryMovements).where(eq(inventoryMovements.id, movementId));
  return row?.s;
}

const none = { inFlight: 0, fulfilledOutside: 0, uncertain: false };
const noEvidence = { failedPushes: 0, unsentDelta: 0 };

/** Замовлення Shopify з однією позицією товару n (вигадані дані). */
function orderFor(n: number, orderNo: number, qty: number, over: Partial<GqlOrder> & { at?: Date; currentQuantity?: number } = {}): GqlOrder {
  const { at = new Date(), currentQuantity, ...rest } = over;
  const base = gqlOrder(orderNo);
  const iso = at.toISOString();
  return gqlOrder(orderNo, {
    createdAt: iso,
    processedAt: iso,
    updatedAt: iso,
    lineItems: {
      nodes: [
        {
          ...base.lineItems.nodes[0]!,
          sku: `SKU-${n}`,
          quantity: qty,
          ...(currentQuantity === undefined ? {} : { currentQuantity }),
          variant: { id: `gid://shopify/ProductVariant/${n}01`, product: { id: `gid://shopify/Product/${n}` } },
        },
      ],
    },
    ...rest,
  });
}

async function orderRow(orderNo: number) {
  const [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, `gid://shopify/Order/${orderNo}`));
  return o!;
}

// ---------------------------------------------------------------------------

describe("shopify-1: auto-apply never reverts internal changes Shopify did not receive", () => {
  it("pure: unsent movements, opening history and the effective mode block auto-apply", () => {
    const external = compareLevels({ available: 13, onHand: 13, committed: 0 }, { onHand: 10, reserved: 0 }, none);
    expect(canAutoApply(external, noEvidence)).toBe(true);
    expect(autoApplyBlockers(external, { ...noEvidence, unsentDelta: 5 })).toEqual(["unsent_movements"]);
    expect(autoApplyBlockers(external, { ...noEvidence, origin: "opened_with_internal_history" })).toEqual(["opening_history"]);
    expect(autoApplyBlockers(external, { ...noEvidence, pushPending: true })).toEqual(["push_pending"]);
    expect(autoApplyEffective({ externalMode: "apply", pushMode: "deltas", canWrite: true })).toBe(true);
    expect(autoApplyEffective({ externalMode: "apply", pushMode: "off", canWrite: true })).toBe(false);
    expect(autoApplyEffective({ externalMode: "apply", pushMode: "deltas", canWrite: false })).toBe(false);
    expect(autoApplyEffective({ externalMode: "review", pushMode: "deltas", canWrite: true })).toBe(false);
  });

  it("(a) push off: a receipt Shopify never got stays (review), and is still protected once push is turned on", async () => {
    await setWarehouse({ shopifyPush: "off" });
    try {
      const mv = await receipt(1, 5);
      expect(mv.shopifySyncState).toBe("skipped");
      expect(await onHand(1)).toBe(17);
      expect(await withApply(() => reconcileItem(1))).toEqual(["opened"]);
      expect(await onHand(1)).toBe(17);
      const obs = await observation(1);
      expect(obs).toMatchObject({ diff: -5, unsentCount: 1, unsentDelta: 5, unsentMovementIds: [mv.id] });
      expect((await view((await openConflict(1))!.id)).unsentDelta).toBe(5);
    } finally {
      await setWarehouse({ shopifyPush: "deltas" });
    }
    // Передачу ввімкнено, автоприйняття діє — але неотримане надходження все одно не скасовується.
    expect(await withApply(() => reconcileItem(1))).toEqual(["updated"]);
    expect(await onHand(1)).toBe(17);
    expect((await observation(1)).autoApplyBlockers).toEqual(["unsent_movements"]);
  });

  it("(b) push on without write_inventory: the skipped receipt is not reverted", async () => {
    await h.db.update(shopInstallations).set({ scopes: "read_products,read_inventory" });
    try {
      const mv = await receipt(2, 5);
      expect(await push()).toMatchObject({ status: "skipped", skipReason: "missing_scope" });
      expect(await syncState(mv.id)).toBe("skipped");
      expect(await withApply(() => reconcileItem(2))).toEqual(["opened"]);
      expect(await onHand(2)).toBe(17);
    } finally {
      await h.db.update(shopInstallations).set({ scopes: FULL_SCOPES });
    }
  });

  it("(c) a failed push dismissed by the owner is not reverted later; (f) after «send warehouse» auto-apply works again", async () => {
    const mv = await receipt(3, 4);
    fake.inject({ userErrors: [{ field: ["input", "reason"], message: "bad", code: "INVALID_REASON" }] });
    expect(await push()).toMatchObject({ failed: 1 });
    expect(await reconcileItem(3)).toEqual(["opened"]);
    await dismissConflict(ctx, (await openConflict(3))!.id, "Перевірю пізніше");
    expect(await syncState(mv.id)).toBe("skipped");
    expect(await withApply(() => reconcileItem(3))).toEqual(["opened"]);
    expect(await onHand(3)).toBe(16);
    expect(await observation(3)).toMatchObject({ unsentDelta: 4, failedMovementIds: [], autoApplyBlockers: ["unsent_movements"] });

    // Власник надсилає склад → Shopify і склад узгоджені: наступна зміна в Shopify приймається автоматично.
    expect(await pushAppValue(ctx, fake.admin, (await openConflict(3))!.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: 4 });
    expect(level(3)).toMatchObject({ available: 16, onHand: 16 });
    fake.setLevel(items[3]!.gid, { available: 15, onHand: 15 });
    expect(await withApply(() => reconcileItem(3))).toEqual(["auto_applied"]);
    expect(await onHand(3)).toBe(15);
  });

  it("(d) opening with internal history is never auto-applied; (g) after the owner accepts, auto-apply works again", async () => {
    await upsertProduct(h.db, mapProduct(gqlProduct(40)), "EUR");
    const [v] = await h.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.shopifyVariantId, "gid://shopify/ProductVariant/4001"));
    const stockItemId = await ensureStockItemForVariant(h.db, v!.id);
    const pre = await apply(h.db, { stockItemId, type: "receipt_manual", idempotencyKey: inventoryKeys.manual(randomUUID()), onHandDelta: 4 });
    expect(pre.applied[0]!.shopifySyncState).toBe("skipped");
    await initializeInventory(ctx);
    await register(40);
    expect(await onHand(40)).toBe(16);
    expect((await openConflict(40))!.details).toMatchObject({ reason: "opened_with_internal_history" });
    expect(await withApply(() => reconcileItem(40))).toEqual(["updated"]);
    expect(await onHand(40)).toBe(16);
    expect((await observation(40)).autoApplyBlockers).toEqual(expect.arrayContaining(["unsent_movements", "opening_history"]));

    expect(await acceptShopifyValue(ctx, (await openConflict(40))!.id, { admin: adminFor })).toMatchObject({ status: "accepted", delta: -4 });
    fake.setLevel(items[40]!.gid, { available: 14, onHand: 14 });
    expect(await withApply(() => reconcileItem(40))).toEqual(["auto_applied"]);
    expect(await onHand(40)).toBe(14);
  });

  it("(e) a customer return recorded before Shopify restocks is not reverted; once values match, auto-apply resumes", async () => {
    const r = await receiveStock(ctx, { operationId: randomUUID(), stockItemId: items[4]!.stockItemId, quantity: 1, reason: "customer_return" });
    expect(r.shopifySyncState).toBe("skipped");
    expect(await withApply(() => reconcileItem(4))).toEqual(["opened"]);
    expect(await onHand(4)).toBe(13);
    fake.setLevel(items[4]!.gid, { available: 13, onHand: 13 }); // Shopify поповнив повернення
    expect(await withApply(() => reconcileItem(4))).toEqual(["closed"]);
    const [marker] = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "inventory_sync.in_sync"))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(marker!.details).toMatchObject({ source: "match", settledCount: 1, settledDelta: 1 });
    fake.setLevel(items[4]!.gid, { available: 15, onHand: 15 }); // ручна зміна в Shopify
    expect(await withApply(() => reconcileItem(4))).toEqual(["auto_applied"]);
    expect(await onHand(4)).toBe(15);
  });
});

describe("shopify-2: the app reserving more than Shopify commits is explained, never auto-applied", () => {
  it("pure: released by Shopify → explained; fulfilled in Shopify first → match; external change on top → conflict", () => {
    const edited = compareLevels({ available: 9, onHand: 10, committed: 1 }, { onHand: 10, reserved: 3 }, none);
    expect(edited).toMatchObject({ diff: 2, expectedDiff: 2, reservationExcess: 2, committedNotReserved: 0 });
    expect(unexplainedDiff(edited)).toBe(0);
    expect(verdictOf(edited)).toBe("explained");
    expect(canAutoApply(edited, noEvidence)).toBe(false);
    const cancelled = compareLevels({ available: 13, onHand: 13, committed: 0 }, { onHand: 13, reserved: 3 }, none);
    expect(cancelled).toMatchObject({ diff: 3, expectedDiff: 3, reservationExcess: 3 });
    expect(verdictOf(cancelled)).toBe("explained");
    const reviewerCase = compareLevels({ available: 10, onHand: 10, committed: 0 }, { onHand: 10, reserved: 2 }, none);
    expect(unexplainedDiff(reviewerCase)).toBe(0);
    expect(canAutoApply(reviewerCase, noEvidence)).toBe(false);
    // Виконано в Shopify раніше, ніж застосунок це побачив: «доступно» однакове — не розбіжність.
    const fulfilledFirst = compareLevels({ available: 7, onHand: 7, committed: 0 }, { onHand: 10, reserved: 3 }, none);
    expect(fulfilledFirst).toMatchObject({ diff: 0, expectedDiff: 0, reservationExcess: 3 });
    expect(verdictOf(fulfilledFirst)).toBe("match");
    // Звільнено в Shopify + ручне +2 → непояснено рівно +2, і без автоприйняття.
    const mixed = compareLevels({ available: 11, onHand: 12, committed: 1 }, { onHand: 10, reserved: 3 }, none);
    expect(mixed).toMatchObject({ diff: 4, expectedDiff: 2 });
    expect(unexplainedDiff(mixed)).toBe(2);
    expect(canAutoApply(mixed, noEvidence)).toBe(false);
  });

  it("an order edited in Shopify (restock) while a waybill is active: not auto-applied, on-hand unchanged", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(5, 9501, 3)), "live");
    const o = await orderRow(9501);
    expect((await balance(h.db, items[5]!.stockItemId)).reserved).toBe(3);
    fake.setLevel(items[5]!.gid, { available: 9, onHand: 12, committed: 3 });
    expect(await reconcileItem(5)).toEqual(["match"]);
    await h.db.update(orders).set({ status: "waybill_created" }).where(eq(orders.id, o.id));
    await h.db.insert(shipments).values({
      orderId: o.id,
      carrierCode: "sandbox",
      mode: "test",
      status: "created",
      carrierReference: `OT-T-${o.id.slice(0, 8)}`,
      createdBy: "test",
    });
    const edited = await upsertOrder(ctx, mapOrder(orderFor(5, 9501, 1, { at: new Date(Date.now() + 60_000) })), "live");
    expect(edited.result).toBe("conflict_reported");
    expect((await balance(h.db, items[5]!.stockItemId)).reserved).toBe(3);
    fake.setLevel(items[5]!.gid, { available: 11, onHand: 12, committed: 1 }); // Shopify повернув 2 шт. у «доступно»
    expect(await withApply(() => reconcileItem(5))).toEqual(["explained"]);
    expect(await onHand(5)).toBe(12);
    expect(await openConflict(5)).toBeNull();
  });
});

describe("shopify-m1 / shopify-4: units in Shopify «unavailable» states", () => {
  it("a move to damaged/reserved in Shopify is not auto-accepted as an on-hand decrease", async () => {
    fake.setLevel(items[6]!.gid, { available: 9, onHand: 12, committed: 0 });
    expect(await withApply(() => reconcileItem(6))).toEqual(["opened"]);
    expect(await onHand(6)).toBe(12);
    expect(await observation(6)).toMatchObject({ diff: -3, shopifyOtherStates: 3, autoApplyBlockers: ["other_states"] });
  });

  it("«send warehouse» does not raise available while Shopify holds units in other states (no phantom on_hand)", async () => {
    const c = (await openConflict(6))!;
    expect((await view(c.id)).pushBlockedOtherStates).toBe(true);
    const calls = fake.adjustCalls().length;
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "other_states", count: 3 });
    expect(fake.adjustCalls()).toHaveLength(calls);
    expect(level(6)).toMatchObject({ available: 9, onHand: 12 });
    expect((await openConflict(6))!.details).not.toHaveProperty("pushAttempt");
  });

  it("lowering available is still allowed (it never adds on_hand)", async () => {
    fake.setLevel(items[14]!.gid, { available: 14, onHand: 15, committed: 0 }); // 1 шт. в іншому стані
    expect(await reconcileItem(14)).toEqual(["opened"]);
    expect(await pushAppValue(ctx, fake.admin, (await openConflict(14))!.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -2 });
    expect(level(14)).toMatchObject({ available: 12, onHand: 13 });
  });
});

describe("shopify-3: «accept Shopify» while a «send warehouse» result is unknown", () => {
  it("unknown (timeout after Shopify applied it): accept refuses; retrying the push resolves it", async () => {
    fake.setLevel(items[7]!.gid, { available: 15, onHand: 15 });
    expect(await reconcileItem(7)).toEqual(["opened"]);
    const c = (await openConflict(7))!;
    fake.inject({ applyThenThrow: new ShopifyApiError("timeout", true, "TIMEOUT") });
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "unknown" });
    expect(level(7).available).toBe(12);
    expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toEqual({ status: "push_pending" });
    expect(await acceptShopifyValues(ctx, [c.id], { admin: adminFor })).toMatchObject({ accepted: 0, pending: 1 });
    expect(await onHand(7)).toBe(12);
    expect((await view(c.id)).pushAttemptAt).not.toBeNull();
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -3 });
    expect(level(7).available).toBe(12);
    expect(await onHand(7)).toBe(12);
  });

  it("in progress: accept refuses, a fresh reconciliation keeps the attempt (no auto-apply), accept works after it settles", async () => {
    fake.setLevel(items[8]!.gid, { available: 15, onHand: 15 });
    expect(await reconcileItem(8)).toEqual(["opened"]);
    const c = (await openConflict(8))!;
    fake.inject({ userErrors: [{ field: null, message: "busy", code: "IDEMPOTENCY_CONCURRENT_REQUEST" }] });
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "in_progress" });
    expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toEqual({ status: "push_pending" });
    expect(await withApply(() => reconcileItem(8))).toEqual(["updated"]);
    expect(await observation(8)).toMatchObject({ observationSeq: 2, autoApplyBlockers: ["push_pending"] });
    expect((await observation(8)).pushAttempt?.seq).toBe(1);
    expect(await onHand(8)).toBe(12);
    expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toEqual({ status: "push_pending" });
    const later = { ...ctx, now: () => new Date(Date.now() + 6 * 60_000) };
    expect(await acceptShopifyValue(later, c.id, { admin: adminFor })).toMatchObject({ status: "accepted", delta: 3 });
    expect(await onHand(8)).toBe(15);
  });

  it("accept clicked while the push mutation is in flight is refused; the push completes once", async () => {
    fake.setLevel(items[9]!.gid, { available: 15, onHand: 15 });
    expect(await reconcileItem(9)).toEqual(["opened"]);
    const c = (await openConflict(9))!;
    let concurrent: AcceptResult | null = null;
    const racing: AdminGraphql = async (query, variables) => {
      if (/mutation OtInventoryAdjust/.test(query) && !concurrent) concurrent = await acceptShopifyValue(ctx, c.id, { admin: adminFor });
      return fake.admin(query, variables);
    };
    expect(await pushAppValue(ctx, racing, c.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -3 });
    expect(concurrent).toEqual({ status: "push_pending" });
    expect(await onHand(9)).toBe(12);
    expect(level(9).available).toBe(12);
    const [row] = await h.db.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, c.id));
    expect(row!.status).toBe("pushed_app");
  });

  it("a definitive Shopify refusal clears the attempt; a dismissal during the push is reported, not hidden", async () => {
    fake.setLevel(items[10]!.gid, { available: 14, onHand: 14 });
    expect(await reconcileItem(10)).toEqual(["opened"]);
    const c = (await openConflict(10))!;
    fake.inject({ userErrors: [{ field: ["input", "changes", "0", "delta"], message: "bad", code: "INVALID_QUANTITY_DOCUMENT" }] });
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "failed", code: "INVALID_QUANTITY_DOCUMENT" });
    expect((await openConflict(10))!.details).not.toHaveProperty("pushAttempt");
    expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toMatchObject({ status: "accepted", delta: 2 });

    fake.setLevel(items[10]!.gid, { available: 12, onHand: 12 });
    expect(await reconcileItem(10)).toEqual(["opened"]);
    const c2 = (await openConflict(10))!;
    let dismissed = false;
    const racing: AdminGraphql = async (query, variables) => {
      if (/mutation OtInventoryAdjust/.test(query) && !dismissed) {
        dismissed = true;
        await dismissConflict(ctx, c2.id, "Перевірено");
      }
      return fake.admin(query, variables);
    };
    expect(await pushAppValue(ctx, racing, c2.id, { appUrl: APP_URL })).toEqual({ status: "resolved_concurrently", delta: 2 });
    const [audit] = await h.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "inventory_sync.conflict_pushed_after_resolution"), eq(auditLog.entityId, c2.id)));
    expect(audit!.details).toMatchObject({ delta: 2 });
    expect(await reconcileItem(10)).toEqual(["match"]);
  });
});

describe("shopify-6: «accept Shopify» re-reads Shopify first", () => {
  it("a Shopify change reverted after reconciliation is not accepted", async () => {
    fake.setLevel(items[11]!.gid, { available: 15, onHand: 15 });
    expect(await reconcileItem(11)).toEqual(["opened"]);
    const c = (await openConflict(11))!;
    fake.setLevel(items[11]!.gid, { available: 12, onHand: 12 });
    expect(await acceptShopifyValue(ctx, c.id, { admin: adminFor })).toEqual({ status: "stale", reconciled: "closed" });
    expect(await onHand(11)).toBe(12);
  });

  it("bulk accept reads Shopify for all selected and skips the changed ones", async () => {
    fake.setLevel(items[11]!.gid, { available: 14, onHand: 14 });
    fake.setLevel(items[12]!.gid, { available: 14, onHand: 14 });
    expect(await reconcileItem(11)).toEqual(["opened"]);
    expect(await reconcileItem(12)).toEqual(["opened"]);
    const ids = [(await openConflict(11))!.id, (await openConflict(12))!.id];
    fake.setLevel(items[12]!.gid, { available: 13, onHand: 13 });
    expect(await acceptShopifyValues(ctx, ids, { admin: adminFor })).toEqual({ accepted: 1, already: 0, stale: 1, pending: 0, failed: 0, units: 2 });
    expect(await onHand(11)).toBe(14);
    expect(await onHand(12)).toBe(12);
    expect((await observation(12)).diff).toBe(1);
  });
});

describe("shopify-5: returns restocked in Shopify before the warehouse receives them", () => {
  it("are not auto-applied; the customer_return receipt then closes the difference without double counting", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(13, 9601, 1, { displayFulfillmentStatus: "FULFILLED" })), "import");
    const o = await orderRow(9601);
    expect(o.status).toBe("handed_to_carrier");
    expect(await onHand(13)).toBe(11);
    fake.setLevel(items[13]!.gid, { available: 11, onHand: 11, committed: 0 });
    expect(await reconcileItem(13)).toEqual(["match"]);
    // Відшкодування з поверненням на склад у Shopify: currentQuantity 1 → 0, Shopify «доступно» +1.
    await h.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, o.id));
    await h.db.update(orders).set({ shopifyUpdatedAt: new Date() }).where(eq(orders.id, o.id));
    fake.setLevel(items[13]!.gid, { available: 12, onHand: 12 });
    const timing = (await fulfillmentTiming(h.db, (await getDefaultWarehouse(h.db)).id, [items[13]!.stockItemId])).get(items[13]!.stockItemId);
    expect(timing).toMatchObject({ returnsPending: 1, uncertain: true, inFlight: 0 });
    expect(await withApply(() => reconcileItem(13))).toEqual(["opened"]);
    expect(await onHand(13)).toBe(11);
    expect(await observation(13)).toMatchObject({ returnsPending: 1, uncertain: true, autoApplyBlockers: ["uncertain"] });
    const r = await receiveStock(ctx, { operationId: randomUUID(), stockItemId: items[13]!.stockItemId, quantity: 1, reason: "customer_return", orderId: o.id });
    expect(r.shopifySyncState).toBe("skipped");
    expect(await withApply(() => reconcileItem(13))).toEqual(["closed"]);
    expect(await onHand(13)).toBe(12);
  });
});

describe("shopify-5: a damaged return restocked in Shopify", () => {
  it("is taken out of Shopify's available by a pushed defect movement (no auto-apply, no phantom unit)", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(15, 9602, 1, { displayFulfillmentStatus: "FULFILLED" })), "import");
    const o = await orderRow(9602);
    expect(await onHand(15)).toBe(11);
    await h.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, o.id));
    await h.db.update(orders).set({ shopifyUpdatedAt: new Date() }).where(eq(orders.id, o.id));
    fake.setLevel(items[15]!.gid, { available: 12, onHand: 12 });
    await receiveStock(ctx, { operationId: randomUUID(), stockItemId: items[15]!.stockItemId, quantity: 0, defectiveQuantity: 1, reason: "customer_return", orderId: o.id });
    expect(await balance(h.db, items[15]!.stockItemId)).toMatchObject({ onHand: 11, defective: 1 });
    // Рух браку ще не передано — звірку відкладено.
    expect(await reconcileItem(15)).toEqual(["skipped_pending"]);
    const calls = fake.adjustCalls().length;
    expect(await push()).toMatchObject({ pushed: 1 });
    const sent = fake.adjustCalls().slice(calls);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.input).toMatchObject({ name: "available", changes: [expect.objectContaining({ delta: -1 })] });
    expect(level(15).available).toBe(11);
    expect(await withApply(() => reconcileItem(15))).toEqual(["match"]);
    expect(await openConflict(15)).toBeNull();
    expect(await onHand(15)).toBe(11);
    const external = await h.db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.stockItemId, items[15]!.stockItemId), eq(inventoryMovements.type, "shopify_external")));
    expect(external).toHaveLength(0);
  });
});

describe("shopify-m2: orders shipped before opening but still committed in Shopify", () => {
  it("count as in-flight, so the reconciliation matches (no phantom «accept Shopify»)", async () => {
    await upsertProduct(h.db, mapProduct(gqlProduct(41)), "EUR");
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await upsertOrder(ctx, mapOrder(orderFor(41, 9701, 2, { at: yesterday })), "live");
    const o = await orderRow(9701);
    await h.db.update(orders).set({ status: "handed_to_carrier" }).where(eq(orders.id, o.id));
    await initializeInventory(ctx);
    await register(41);
    expect(await onHand(41)).toBe(12);
    fake.setLevel(items[41]!.gid, { available: 12, onHand: 14, committed: 2 });
    const timing = (await fulfillmentTiming(h.db, (await getDefaultWarehouse(h.db)).id, [items[41]!.stockItemId])).get(items[41]!.stockItemId);
    expect(timing).toMatchObject({ inFlight: 2 });
    expect(await reconcileItem(41)).toEqual(["match"]);
    expect(await openConflict(41)).toBeNull();
    // Shopify виконав замовлення: committed 0, on_hand 12 — збіг і далі.
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled" }).where(eq(orders.id, o.id));
    fake.setLevel(items[41]!.gid, { available: 12, onHand: 12, committed: 0 });
    expect(await reconcileItem(41)).toEqual(["match"]);
  });
});

describe("shopify-8: inventory_levels/update with a 64-bit inventory_item_id", () => {
  const SAMPLE =
    '{"inventory_item_id":271878346596884015,"location_id":24826418,"available":10,"updated_at":"2021-12-31T19:00:00-05:00","admin_graphql_api_id":"gid://shopify/InventoryLevel/24826418?inventory_item_id=271878346596884015"}';

  it("takes the id from admin_graphql_api_id (the numeric field is rounded by JSON.parse)", () => {
    const payload = JSON.parse(SAMPLE) as Record<string, unknown>;
    expect(Number.isSafeInteger(payload.inventory_item_id)).toBe(false);
    expect(String(payload.inventory_item_id)).not.toBe("271878346596884015");
    expect(inventoryItemGidFromLevelPayload(payload)).toBe("gid://shopify/InventoryItem/271878346596884015");
    expect(inventoryItemGidFromLevelPayload({ inventory_item_id: Number("271878346596884015") })).toBeNull();
    expect(inventoryItemGidFromLevelPayload({ inventory_item_id: 4001 })).toBe("gid://shopify/InventoryItem/4001");
    expect(inventoryItemGidFromLevelPayload({ inventory_item_id: "4001" })).toBe("gid://shopify/InventoryItem/4001");
    expect(inventoryItemGidFromLevelPayload({ admin_graphql_api_id: "gid://shopify/InventoryLevel/1?inventory_item_id=abc" })).toBeNull();
  });

  it("the webhook queues the item with the exact id", async () => {
    expect(await handleShopifyWebhook(h.db, { topic: "inventory_levels/update", shop: SHOP, webhookId: "wh-big-1", payload: JSON.parse(SAMPLE) })).toBe("queued");
    const [job] = await h.db.select().from(jobs).where(eq(jobs.type, JOB.syncInventoryItem));
    expect(job!.payload).toMatchObject({ inventoryItemGid: "gid://shopify/InventoryItem/271878346596884015" });
  });
});

describe("security-5: reconcile with an invalid stock item id", () => {
  it("returns null without touching Shopify or the database uuid column", async () => {
    const calls = fake.calls.length;
    expect(await reconcileStockItemNow(h.db, fake.admin, "abc")).toBeNull();
    expect(fake.calls.length).toBe(calls);
  });
});

describe("shopify-9: more than one page of Shopify locations", () => {
  it("lists every location and accepts the owner's choice beyond the first page", async () => {
    const extra = Array.from({ length: 60 }, (_, i) => location(`gid://shopify/Location/${9100 + i}`, `Pop-up ${i}`));
    fake.locations.push(...extra);
    const target = extra[59]!;
    try {
      const all = await fetchLocations(fake.admin);
      expect(all.nodes).toHaveLength(61);
      expect(all.hasMore).toBe(false);
      expect(pickLocation(all.nodes, all.hasMore).kind).toBe("ambiguous");
      expect(await setWarehouseLocation(ctx, fake.admin, await getDefaultWarehouse(h.db), target.id)).toMatchObject({ id: target.id });
      expect((await getDefaultWarehouse(h.db)).shopifyLocationId).toBe(target.id);
    } finally {
      fake.locations.splice(1);
      await setWarehouseLocation(ctx, fake.admin, await getDefaultWarehouse(h.db), LOC);
    }
  });
});

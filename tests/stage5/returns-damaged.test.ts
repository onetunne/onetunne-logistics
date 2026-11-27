import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { inventoryConflicts, inventoryMovements, jobs, orderLineItems, orders, productVariants, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { inventoryKeys } from "~/modules/inventory/keys";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { pushAppValue } from "~/modules/inventory-sync/conflicts.server";
import { INVENTORY_SYNC_JOB } from "~/modules/inventory-sync/jobs";
import { parseObservation } from "~/modules/inventory-sync/observation";
import { pushIdempotencyKey } from "~/modules/inventory-sync/pure";
import { runInventoryPush } from "~/modules/inventory-sync/push.server";
import { fulfillmentTiming, runReconcileJob } from "~/modules/inventory-sync/reconcile.server";
import { returnOrderSuggestions } from "~/modules/inventory-sync/returns.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { RETURN_DEFECT_KEY_SUFFIX, receiveStock, recordedReceiptState, type ReceiveStockInput } from "~/modules/warehouse/operations.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";
import { OWNER, STAFF, openTestDatabase } from "../helpers";
import { apply, balance } from "./helpers";
import { fakeInventoryAdmin, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Пошкоджене повернення покупця, яке Shopify поповнив сам (R1, operations.server.ts receiveStock): Shopify повертає
 * в «доступно» всі одиниці повернення, тож пошкоджені записуються як «повернено й поповнено Shopify, потім позначено
 * браком» — надходження on_hand + (якісні + пошкоджені), skipped, і рух браку on_hand − пошкоджені (передається в
 * Shopify рівно один раз). Облік повернень (returns.server.ts) і звірка сходяться без ручного виправлення в обох
 * порядках подій; «надіслати в Shopify» (restockedInShopify: false) і демо — без змін. Імітація Admin API 2026-10,
 * вигадані дані. Справжній PostgreSQL — TEST_DATABASE_URL.
 */
const SHOP = "ot-returns-damaged.myshopify.com";
const APP_URL = "https://ot-app.example.com";
const N = 14;

let hd: DatabaseHandle;
let ctx: ServiceContext;
let fake: FakeInventoryAdmin;
const items: Record<number, { variantId: string; stockItemId: string; gid: string }> = {};

beforeAll(async () => {
  hd = await openTestDatabase();
  await seedReferenceData(hd.db, DEMO_SETTINGS);
  ctx = { mode: "production", db: hd.db, actor: OWNER, carriers: createDemoCarriers(hd.db), shopify: new DemoShopifyGateway(), now: () => new Date() };
  await hd.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_products,read_inventory,write_inventory" });
  for (let n = 1; n <= N; n++) await upsertProduct(hd.db, mapProduct(gqlProduct(n)), "EUR"); // inventoryQuantity 12
  await initializeInventory(ctx);
  fake = fakeInventoryAdmin();
  for (let n = 1; n <= N; n++) {
    const [v] = await hd.db
      .select({ id: productVariants.id, gid: productVariants.inventoryItemId })
      .from(productVariants)
      .where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
    items[n] = { variantId: v!.id, stockItemId: await ensureStockItemForVariant(hd.db, v!.id), gid: v!.gid! };
    fake.setLevel(v!.gid!, { available: 12, onHand: 12, committed: 0 });
  }
  await setWarehouse({ shopifyPush: "deltas", externalShopifyChanges: "review" });
});
afterAll(async () => {
  await hd.close();
});
beforeEach(async () => {
  await hd.db.delete(jobs);
});

async function setWarehouse(patch: Record<string, unknown>) {
  const current = await getSetting(hd.db, "warehouse");
  const r = await updateSetting(hd.db, OWNER, "warehouse", { ...current, ...patch });
  expect(r.ok).toBe(true);
}

/** Власник обрав «приймати зміни Shopify автоматично» — перевірка, що різниця повернення не прийнята автоматично. */
async function withApply<T>(fn: () => Promise<T>): Promise<T> {
  await setWarehouse({ externalShopifyChanges: "apply" });
  try {
    return await fn();
  } finally {
    await setWarehouse({ externalShopifyChanges: "review" });
  }
}

const adminFor = async () => fake.admin;
const push = () => runInventoryPush({ db: hd.db, admin: adminFor, appUrl: APP_URL });
const reconcileItem = async (n: number) =>
  runReconcileJob({ db: hd.db, admin: adminFor }, { scope: "item", inventoryItemGid: items[n]!.gid }).then((r) =>
    "results" in r ? r.results.map((x) => x.outcome) : [r.status],
  );
const bal = (n: number) => balance(hd.db, items[n]!.stockItemId);
const level = (n: number) => fake.levels.get(items[n]!.gid)!;
const setShopify = (n: number, available: number) => fake.setLevel(items[n]!.gid, { available, onHand: available, committed: 0 });
const timing = async (n: number) =>
  (await fulfillmentTiming(hd.db, (await getDefaultWarehouse(hd.db)).id, [items[n]!.stockItemId])).get(items[n]!.stockItemId)!;

async function openConflict(n: number) {
  const [row] = await hd.db
    .select()
    .from(inventoryConflicts)
    .where(and(eq(inventoryConflicts.stockItemId, items[n]!.stockItemId), eq(inventoryConflicts.status, "open")));
  return row ?? null;
}

/** Рухи форми повернення (надходження і, якщо є, рух браку) у порядку ключів. */
async function movementsOf(operationId: string) {
  const keys = [inventoryKeys.manual(operationId), inventoryKeys.manual(operationId, RETURN_DEFECT_KEY_SUFFIX)];
  const rows = await hd.db
    .select({
      id: inventoryMovements.id,
      key: inventoryMovements.idempotencyKey,
      type: inventoryMovements.type,
      onHandDelta: inventoryMovements.onHandDelta,
      defectiveDelta: inventoryMovements.defectiveDelta,
      reason: inventoryMovements.reason,
      orderId: inventoryMovements.orderId,
      state: inventoryMovements.shopifySyncState,
    })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.idempotencyKey, keys))
    .orderBy(asc(inventoryMovements.idempotencyKey));
  return rows;
}

async function itemMovements(n: number, type?: string) {
  return hd.db
    .select({ id: inventoryMovements.id, state: inventoryMovements.shopifySyncState })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.stockItemId, items[n]!.stockItemId), type ? eq(inventoryMovements.type, type as never) : undefined));
}
const pendingOf = async (n: number) => (await itemMovements(n)).filter((m) => m.state === "pending").length;
const pushJobs = async () => (await hd.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, "inventory.push"))).length;

/** Замовлення Shopify з однією позицією товару n на qty шт., уже виконане в Shopify (вигадані дані). */
function fulfilledOrder(n: number, orderNo: number, qty: number): GqlOrder {
  const base = gqlOrder(orderNo);
  const iso = new Date().toISOString();
  return gqlOrder(orderNo, {
    createdAt: iso,
    processedAt: iso,
    updatedAt: iso,
    displayFulfillmentStatus: "FULFILLED",
    lineItems: {
      nodes: [
        {
          ...base.lineItems.nodes[0]!,
          sku: `SKU-${n}`,
          quantity: qty,
          variant: { id: `gid://shopify/ProductVariant/${n}01`, product: { id: `gid://shopify/Product/${n}` } },
        },
      ],
    },
  });
}

/** Виконане замовлення товару n на qty шт.: склад −qty, Shopify −qty, звірено (збіг). */
async function shippedOrder(n: number, orderNo: number, qty: number) {
  const before = (await bal(n)).onHand;
  await upsertOrder(ctx, mapOrder(fulfilledOrder(n, orderNo, qty)), "import");
  const [o] = await hd.db.select().from(orders).where(eq(orders.shopifyOrderId, `gid://shopify/Order/${orderNo}`));
  expect(o!.status).toBe("handed_to_carrier");
  expect((await bal(n)).onHand).toBe(before - qty);
  setShopify(n, level(n).available - qty);
  expect(await reconcileItem(n)).toEqual(["match"]);
  return o!;
}

/**
 * Повернення/відшкодування в Shopify: поточна кількість позиції `left` (0 — усе; з поверненням на склад чи без — вирішує
 * тест).
 */
async function refund(orderId: string, left = 0) {
  await hd.db.update(orderLineItems).set({ currentQuantity: left }).where(eq(orderLineItems.orderId, orderId));
  await hd.db.update(orders).set({ shopifyUpdatedAt: new Date() }).where(eq(orders.id, orderId));
}

const damagedReturn = (n: number, over: Partial<ReceiveStockInput> = {}): ReceiveStockInput => ({
  operationId: randomUUID(),
  stockItemId: items[n]!.stockItemId,
  quantity: 1,
  defectiveQuantity: 1,
  reason: "customer_return",
  orderId: null,
  ...over,
});

/** Shopify і склад узгоджені: «доступно» однакове, відкритої розбіжності немає, нічого не прийнято автоматично. */
async function expectSettled(n: number) {
  const b = await bal(n);
  expect(level(n).available).toBe(b.onHand - b.reserved);
  expect(await openConflict(n)).toBeNull();
  expect(await itemMovements(n, "shopify_external")).toEqual([]);
  expect(await timing(n)).toMatchObject({ returnsPending: 0, returnsAwaiting: 0, uncertain: false });
  expect(await withApply(() => reconcileItem(n))).toEqual(["match"]);
}

// ---------------------------------------------------------------------------

describe("R1: a damaged customer return restocked in Shopify", () => {
  it("(a) refund with restock first, then the return (1 good + 1 damaged, linked): Shopify loses the damaged unit exactly once", async () => {
    const o = await shippedOrder(1, 9901, 2); // склад 10, Shopify 10
    await refund(o.id);
    setShopify(1, 12); // Shopify поповнив обидві одиниці як доступні, посилка ще в дорозі
    expect(await withApply(() => reconcileItem(1))).toEqual(["opened"]);
    expect((await bal(1)).onHand).toBe(10); // не прийнято автоматично (повернення ще не отримано)

    const input = damagedReturn(1, { orderId: o.id });
    const r = await receiveStock({ ...ctx, actor: STAFF }, input);
    expect(r).toMatchObject({
      replay: false,
      type: "receipt_manual",
      shopifySyncState: "skipped",
      shopifyPushQueued: true,
      returnDefect: { quantity: 1, shopifySyncState: "pending" },
      balance: { onHand: 11, defective: 1, available: 11 },
    });
    // «Повернено й поповнено Shopify (обидві), потім одна позначена браком».
    expect(await movementsOf(input.operationId)).toEqual([
      expect.objectContaining({ type: "receipt_manual", onHandDelta: 2, defectiveDelta: 0, reason: "customer_return", orderId: o.id, state: "skipped" }),
      expect.objectContaining({ type: "defect_mark", onHandDelta: -1, defectiveDelta: 1, reason: "customer_return", orderId: o.id, state: "pending" }),
    ]);
    expect(await pushJobs()).toBe(1);
    expect(await reconcileItem(1)).toEqual(["skipped_pending"]); // звірка чекає передачі

    expect(await push()).toMatchObject({ pushed: 1, failed: 0 });
    const sent = fake.adjustCalls().at(-1)!;
    expect(sent.key).toBe(pushIdempotencyKey(r.returnDefect!.movementId));
    expect(sent.input).toMatchObject({ name: "available", reason: "damaged" });
    expect(sent.input.changes).toEqual([expect.objectContaining({ inventoryItemId: items[1]!.gid, delta: -1, changeFromQuantity: null })]);
    expect(level(1).available).toBe(11);

    expect(await withApply(() => reconcileItem(1))).toEqual(["closed"]);
    await expectSettled(1);

    // Повторне надсилання тієї самої форми — без другого ефекту (ні руху, ні передачі).
    const calls = fake.adjustCalls().length;
    const again = await receiveStock({ ...ctx, actor: STAFF }, input);
    expect(again).toMatchObject({ replay: true, movementId: r.movementId, returnDefect: { movementId: r.returnDefect!.movementId, quantity: 1 } });
    expect(await movementsOf(input.operationId)).toHaveLength(2);
    expect(await push()).toMatchObject({ pushed: 0 });
    expect(fake.adjustCalls()).toHaveLength(calls);
    expect(level(1).available).toBe(11);
    expect(await bal(1)).toMatchObject({ onHand: 11, defective: 1 });

    // Узгоджено: наступна ручна зміна в Shopify приймається автоматично (повернення більше не «висить»).
    setShopify(1, 14);
    expect(await withApply(() => reconcileItem(1))).toEqual(["auto_applied"]);
    expect((await bal(1)).onHand).toBe(14);
  });

  it("(a) the same without an order number: the unlinked pool covers the refund", async () => {
    const o = await shippedOrder(2, 9902, 2); // склад 10, Shopify 10
    await refund(o.id);
    setShopify(2, 12);
    const r = await receiveStock(ctx, damagedReturn(2));
    expect(r.returnDefect).toMatchObject({ quantity: 1, shopifySyncState: "pending" });
    expect(await push()).toMatchObject({ pushed: 1 });
    expect(level(2).available).toBe(11);
    expect(await withApply(() => reconcileItem(2))).toEqual(["match"]);
    await expectSettled(2);
  });

  it("(b) the return received first, Shopify's refund with restock later: the same end state", async () => {
    const o = await shippedOrder(3, 9903, 2); // склад 10, Shopify 10
    const r = await receiveStock(ctx, damagedReturn(3, { orderId: o.id }));
    expect(r).toMatchObject({ shopifySyncState: "skipped", returnDefect: { shopifySyncState: "pending" }, balance: { onHand: 11, defective: 1 } });
    expect(await push()).toMatchObject({ pushed: 1 });
    expect(level(3).available).toBe(9); // брак знято одразу; повернення Shopify поповнить сам

    expect(await withApply(() => reconcileItem(3))).toEqual(["opened"]);
    expect((await bal(3)).onHand).toBe(11);
    const obs = parseObservation((await openConflict(3))!.details)!;
    expect(obs).toMatchObject({ diff: -2, returnsAwaiting: 2 });
    expect(obs.autoApplyBlockers).toContain("awaiting_restock");
    // «Надіслати склад» не надсилає повернення, яке Shopify поповнить сам.
    const calls = fake.adjustCalls().length;
    expect(await pushAppValue(ctx, fake.admin, (await openConflict(3))!.id, { appUrl: APP_URL })).toEqual({ status: "awaiting_restock", count: 2 });
    expect(fake.adjustCalls()).toHaveLength(calls);

    await refund(o.id);
    setShopify(3, level(3).available + 2); // відшкодовано з поверненням на склад: Shopify +2
    expect(await withApply(() => reconcileItem(3))).toEqual(["closed"]);
    expect(level(3).available).toBe(11);
    await expectSettled(3);
  });

  it("(c) «send this return to Shopify» (restockedInShopify: false) keeps today's behaviour", async () => {
    const o = await shippedOrder(4, 9904, 2); // склад 10, Shopify 10
    await refund(o.id); // відшкодовано БЕЗ повернення на склад: Shopify не змінився
    const input = damagedReturn(4, { orderId: o.id, restockedInShopify: false });
    const r = await receiveStock(ctx, input);
    expect(r).toMatchObject({ shopifySyncState: "pending", shopifyPushQueued: true, balance: { onHand: 11, defective: 1 } });
    expect(r.returnDefect).toBeUndefined();
    expect(await movementsOf(input.operationId)).toEqual([
      expect.objectContaining({ type: "receipt_manual", onHandDelta: 1, defectiveDelta: 1, state: "pending" }),
    ]);
    expect(await push()).toMatchObject({ pushed: 1 });
    expect(fake.adjustCalls().at(-1)!.input).toMatchObject({ name: "available", reason: "received", changes: [expect.objectContaining({ delta: 1 })] });
    expect(level(4).available).toBe(11);
    expect(await reconcileItem(4)).toEqual(["match"]);
    expect(await openConflict(4)).toBeNull();
  });

  it("(d) demo mode: the same records, nothing pending and no push job", async () => {
    const demo: ServiceContext = { ...ctx, mode: "demo" };
    const input = damagedReturn(5);
    const r = await receiveStock(demo, input);
    expect(r).toMatchObject({ shopifySyncState: "skipped", shopifyPushQueued: false, returnDefect: { quantity: 1, shopifySyncState: "skipped" } });
    expect((await movementsOf(input.operationId)).map((m) => m.state)).toEqual(["skipped", "skipped"]);
    expect(await pendingOf(5)).toBe(0);
    expect(await pushJobs()).toBe(0);
    expect(await bal(5)).toMatchObject({ onHand: 13, defective: 1 });
  });

  it("a damaged-only return (0 good + 1 damaged) restocked in Shopify: the unit leaves Shopify's available", async () => {
    const o = await shippedOrder(6, 9906, 1); // склад 11, Shopify 11
    await refund(o.id);
    setShopify(6, 12); // Shopify поповнив пошкоджену одиницю як доступну
    const r = await receiveStock(ctx, damagedReturn(6, { quantity: 0, orderId: o.id }));
    expect(r).toMatchObject({ shopifySyncState: "skipped", returnDefect: { quantity: 1, shopifySyncState: "pending" }, balance: { onHand: 11, defective: 1 } });
    expect(await push()).toMatchObject({ pushed: 1 });
    expect(level(6).available).toBe(11);
    expect(await withApply(() => reconcileItem(6))).toEqual(["match"]);
    await expectSettled(6);
  });

  it("only good units: no defect movement (unchanged)", async () => {
    const input = damagedReturn(7, { defectiveQuantity: 0 });
    const r = await receiveStock(ctx, input);
    expect(r.returnDefect).toBeUndefined();
    expect(await movementsOf(input.operationId)).toEqual([expect.objectContaining({ type: "receipt_manual", onHandDelta: 1, defectiveDelta: 0, state: "skipped" })]);
    expect(await pushJobs()).toBe(0);
  });
});

describe("R1: idempotency of the split receipt", () => {
  it("a form recorded before the split (one receipt with defective) is a replay: no defect movement is added", async () => {
    const operationId = randomUUID();
    await apply(hd.db, {
      stockItemId: items[8]!.stockItemId,
      type: "receipt_manual",
      idempotencyKey: inventoryKeys.manual(operationId),
      onHandDelta: 1,
      defectiveDelta: 1,
      reason: "customer_return",
      shopifySyncState: "skipped",
    });
    const before = await bal(8);
    const r = await receiveStock(ctx, damagedReturn(8, { operationId }));
    expect(r).toMatchObject({ replay: true, shopifySyncState: "skipped" });
    expect(r.returnDefect).toBeUndefined();
    expect(await movementsOf(operationId)).toHaveLength(1);
    expect(await bal(8)).toMatchObject({ onHand: before.onHand, defective: before.defective, version: before.version });
    expect(await pendingOf(8)).toBe(0);
    expect(await recordedReceiptState(hd.db, { operationId, stockItemId: items[8]!.stockItemId, quantity: 1, defectiveQuantity: 1 })).toBe("same");
    // Той самий uuid для іншої кількості — інша операція.
    await expect(receiveStock(ctx, damagedReturn(8, { operationId, quantity: 2 }))).rejects.toMatchObject({ code: "warehouse.error.operationReused" });
    expect(await recordedReceiptState(hd.db, { operationId, stockItemId: items[8]!.stockItemId, quantity: 2, defectiveQuantity: 1 })).toBe("other");
  });

  it("a split receipt resubmitted (also with the other Shopify choice) is a replay; other quantities or items are refused", async () => {
    const input = damagedReturn(9, { quantity: 2, defectiveQuantity: 3 });
    const first = await receiveStock(ctx, input);
    expect(await movementsOf(input.operationId)).toEqual([
      expect.objectContaining({ type: "receipt_manual", onHandDelta: 5, defectiveDelta: 0 }),
      expect.objectContaining({ type: "defect_mark", onHandDelta: -3, defectiveDelta: 3 }),
    ]);
    const after = await bal(9);
    expect(await receiveStock(ctx, { ...input, restockedInShopify: false })).toMatchObject({ replay: true, movementId: first.movementId });
    for (const over of [{ defectiveQuantity: 2 }, { quantity: 3 }, { stockItemId: items[10]!.stockItemId }]) {
      await expect(receiveStock(ctx, { ...input, ...over }), JSON.stringify(over)).rejects.toMatchObject({ code: "warehouse.error.operationReused" });
    }
    expect(await bal(9)).toMatchObject({ onHand: after.onHand, defective: after.defective, version: after.version });
    expect(await bal(10)).toMatchObject({ defective: 0 });
    expect(await recordedReceiptState(hd.db, { operationId: input.operationId, stockItemId: items[9]!.stockItemId, quantity: 2, defectiveQuantity: 3 })).toBe("same");
    expect(await recordedReceiptState(hd.db, { operationId: randomUUID(), stockItemId: items[9]!.stockItemId, quantity: 2, defectiveQuantity: 3 })).toBe("none");
  });

  it("two simultaneous submissions of the same form record the receipt and the defect once", async () => {
    const input = damagedReturn(10);
    const before = await bal(10);
    const results = await Promise.all([receiveStock(ctx, input), receiveStock(ctx, input)]);
    expect(results.map((x) => x.replay).sort()).toEqual([false, true]);
    expect(await movementsOf(input.operationId)).toHaveLength(2);
    expect(await bal(10)).toMatchObject({ onHand: before.onHand + 1, defective: before.defective + 1 });
    expect(await pendingOf(10)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Повторна перевірка (follow-up): частково поповнене повернення, підказки, відмова Shopify
// ---------------------------------------------------------------------------

/** Передати рухи, які лишили попередні тести (інші позиції), — щоб лічильники передачі стосувалися лише цього тесту. */
const flushPush = async () => {
  await push();
  expect(await push()).toMatchObject({ pushed: 0, failed: 0 });
};

describe("NI-2: Shopify restocked only the good units of a damaged return", () => {
  beforeEach(flushPush);

  it("«the damaged units were not restocked in Shopify» (damagedRestockedInShopify: false): one receipt as before R1, nothing sent, match", async () => {
    const o = await shippedOrder(11, 9911, 2); // склад 10, Shopify 10
    await refund(o.id, 1); // пошкоджену одиницю не відшкодовано: відшкодовано й поповнено лише якісну
    setShopify(11, 11);
    expect(await withApply(() => reconcileItem(11))).toEqual(["opened"]); // посилка ще в дорозі

    const input = damagedReturn(11, { orderId: o.id, damagedRestockedInShopify: false });
    const r = await receiveStock({ ...ctx, actor: STAFF }, input);
    expect(r).toMatchObject({ replay: false, shopifySyncState: "skipped", shopifyPushQueued: false, balance: { onHand: 11, defective: 1, available: 11 } });
    expect(r.returnDefect).toBeUndefined();
    expect(await movementsOf(input.operationId)).toEqual([
      expect.objectContaining({ type: "receipt_manual", onHandDelta: 1, defectiveDelta: 1, reason: "customer_return", orderId: o.id, state: "skipped" }),
    ]);
    expect(await pendingOf(11)).toBe(0);
    expect(await push()).toMatchObject({ pushed: 0 });
    expect(level(11).available).toBe(11); // Shopify не втратив придатну одиницю

    expect(await withApply(() => reconcileItem(11))).toEqual(["closed"]);
    await expectSettled(11);

    // Повтор форми з іншим вибором — повтор: рух браку не дописується.
    const again = await receiveStock({ ...ctx, actor: STAFF }, { ...input, damagedRestockedInShopify: true });
    expect(again).toMatchObject({ replay: true, movementId: r.movementId });
    expect(again.returnDefect).toBeUndefined();
    expect(await movementsOf(input.operationId)).toHaveLength(1);
    expect(await pendingOf(11)).toBe(0);
    expect(level(11).available).toBe(11);
  });

  it("the default choice in the same case (a wrong choice): the conflict waits for a restock and «include returns» repairs it", async () => {
    const o = await shippedOrder(12, 9912, 2); // склад 10, Shopify 10
    await refund(o.id, 1);
    setShopify(12, 11);
    const r = await receiveStock(ctx, damagedReturn(12, { orderId: o.id })); // «Shopify поповнив усе» — неправда
    expect(r.returnDefect).toMatchObject({ quantity: 1, shopifySyncState: "pending" });
    expect(await push()).toMatchObject({ pushed: 1 });
    expect(level(12).available).toBe(10); // пошкодженої одиниці в Shopify не було — знято придатну

    expect(await withApply(() => reconcileItem(12))).toEqual(["opened"]);
    expect((await bal(12)).onHand).toBe(11); // не прийнято автоматично
    const conflict = (await openConflict(12))!;
    expect(parseObservation(conflict.details)).toMatchObject({ diff: -1, returnsAwaiting: 1 });
    // Звичайне «Надіслати склад» чекає поповнення в Shopify; позначка «Shopify не поповнить ці повернення» — надсилає.
    expect(await pushAppValue(ctx, fake.admin, conflict.id, { appUrl: APP_URL })).toEqual({ status: "awaiting_restock", count: 1 });
    expect(await pushAppValue(ctx, fake.admin, conflict.id, { appUrl: APP_URL, includeReturns: true })).toMatchObject({ status: "pushed", delta: 1 });
    expect(level(12).available).toBe(11);
    expect(await bal(12)).toMatchObject({ onHand: 11, defective: 1 });
    expect(await openConflict(12)).toBeNull();
  });
});

describe("NI-3: return order suggestions count every received unit", () => {
  it("returns received with the damaged units in defective (sent to Shopify, damaged not restocked, recorded before the split) leave no stale suggestion", async () => {
    const warehouseId = (await getDefaultWarehouse(hd.db)).id;
    const suggest = async () =>
      (await returnOrderSuggestions(hd.db, warehouseId, items[13]!.stockItemId)).map((x) => ({ orderId: x.orderId, units: x.units })).sort((a, b) => a.orderId.localeCompare(b.orderId));
    const sent = await shippedOrder(13, 9931, 2);
    const kept = await shippedOrder(13, 9932, 2);
    const legacy = await shippedOrder(13, 9933, 2);
    const partly = await shippedOrder(13, 9934, 2);
    for (const o of [sent, kept, legacy, partly]) await refund(o.id);
    const byId = (list: Array<{ orderId: string; units: number }>) => list.sort((a, b) => a.orderId.localeCompare(b.orderId));
    expect(await suggest()).toEqual(byId([sent, kept, legacy, partly].map((o) => ({ orderId: o.id, units: 2 }))));

    // «Надіслати це повернення в Shopify»: якісна — on_hand, пошкоджена — у брак.
    await receiveStock(ctx, damagedReturn(13, { orderId: sent.id, restockedInShopify: false }));
    // «Пошкоджені в Shopify на склад не повертали»: те саме, нічого не надсилається.
    await receiveStock(ctx, damagedReturn(13, { orderId: kept.id, damagedRestockedInShopify: false }));
    // Записано до розділення (R1): одне надходження з defective.
    await apply(hd.db, {
      stockItemId: items[13]!.stockItemId,
      type: "receipt_manual",
      idempotencyKey: inventoryKeys.manual(randomUUID()),
      onHandDelta: 1,
      defectiveDelta: 1,
      reason: "customer_return",
      orderId: legacy.id,
      shopifySyncState: "skipped",
    });
    // Отримано лише пошкоджену одиницю (надіслано в Shopify) — друга ще в дорозі.
    await receiveStock(ctx, damagedReturn(13, { orderId: partly.id, quantity: 0, restockedInShopify: false }));
    expect(await suggest()).toEqual([{ orderId: partly.id, units: 1 }]);
    await receiveStock(ctx, damagedReturn(13, { orderId: partly.id, defectiveQuantity: 0, restockedInShopify: false }));
    expect(await suggest()).toEqual([]);
  });
});

describe("R1 limitation: Shopify refuses the defect adjustment", () => {
  beforeEach(flushPush);

  it("the defect movement fails once (no second attempt), a reconcile is scheduled, and «Надіслати склад» repairs it after Shopify's restock", async () => {
    const o = await shippedOrder(14, 9914, 2); // склад 10, Shopify 10
    const r = await receiveStock(ctx, damagedReturn(14, { orderId: o.id })); // повернення раніше за відшкодування
    expect(r.returnDefect).toMatchObject({ shopifySyncState: "pending" });
    // Гіпотетична відмова (напр., якби Shopify не дозволяв «доступно» нижче 0 — не задокументовано).
    fake.inject({ userErrors: [{ field: ["input", "changes", "0", "delta"], message: "The quantity can't be lower than -2,000,000,000", code: "INVALID_QUANTITY_TOO_LOW" }] });
    expect(await push()).toMatchObject({ pushed: 0, failed: 1 });
    expect(level(14).available).toBe(10);
    const [defect] = await hd.db
      .select({ state: inventoryMovements.shopifySyncState })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.id, r.returnDefect!.movementId));
    expect(defect!.state).toBe("failed");
    const reconcileJobs = await hd.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.type, INVENTORY_SYNC_JOB.reconcile));
    expect(reconcileJobs.length).toBeGreaterThan(0);
    const calls = fake.adjustCalls().length;
    expect(await push()).toMatchObject({ pushed: 0 }); // без повторної спроби тим самим рухом
    expect(fake.adjustCalls()).toHaveLength(calls);
    expect(await bal(14)).toMatchObject({ onHand: 11, defective: 1 }); // склад правильний

    await refund(o.id);
    setShopify(14, 12); // відшкодовано з поверненням на склад: Shopify +2, пошкоджена знову «доступна»
    expect(await withApply(() => reconcileItem(14))).toEqual(["opened"]); // не прийнято автоматично
    expect((await bal(14)).onHand).toBe(11);
    const conflict = (await openConflict(14))!;
    expect(parseObservation(conflict.details)).toMatchObject({ diff: 1, returnsAwaiting: 0 });
    expect(await pushAppValue(ctx, fake.admin, conflict.id, { appUrl: APP_URL })).toMatchObject({ status: "pushed", delta: -1 });
    expect(level(14).available).toBe(11);
    expect(await openConflict(14)).toBeNull();
  });
});

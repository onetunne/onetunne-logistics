import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { inventoryConflicts, inventoryMovements, jobs, orders, productVariants, shopInstallations, stockReservations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { parseObservation } from "~/modules/inventory-sync/observation";
import { fulfillmentTiming, runReconcileJob } from "~/modules/inventory-sync/reconcile.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";
import { balance } from "./helpers";
import { fakeInventoryAdmin, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Точність звірки залишків із Shopify (рев'ю R5, B3). Імітація Admin API — inventory-sync-fixtures.ts (вигадані дані).
 * (a) Резерв відкритого замовлення з неперенесеними змінами позицій Shopify (orders.shopify_lines_pending_at): застосунок
 *     резервує за старими позиціями, committed Shopify — уже за новими → невизначеність (без автоприйняття).
 * (b) Часткове виконання лише позицій без доставки (orders.shopify_shippable_fulfilled = false): фізичні позиції ще
 *     committed у Shopify — як невиконані (передані перевізнику — inFlight), а не «невизначено» з хибною розбіжністю.
 * Справжній PostgreSQL — TEST_DATABASE_URL.
 */
const SHOP = "ot-precision.myshopify.com";
const FULL_SCOPES = "read_products,read_inventory,write_inventory";

let h: DatabaseHandle;
let ctx: ServiceContext;
let fake: FakeInventoryAdmin;
let warehouseId = "";
const items: Record<number, { variantId: string; stockItemId: string; gid: string }> = {};

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new DemoShopifyGateway(), now: () => new Date() };
  await h.db.insert(shopInstallations).values({ shop: SHOP, scopes: FULL_SCOPES });
  for (let n = 1; n <= 4; n++) await upsertProduct(h.db, mapProduct(gqlProduct(n)), "EUR"); // inventoryQuantity 12
  await initializeInventory(ctx);
  fake = fakeInventoryAdmin();
  for (let n = 1; n <= 4; n++) await register(n);
  warehouseId = (await getDefaultWarehouse(h.db)).id;
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

const reconcileItem = async (n: number) =>
  runReconcileJob({ db: h.db, admin: async () => fake.admin }, { scope: "item", inventoryItemGid: items[n]!.gid }).then((r) =>
    "results" in r ? r.results.map((x) => x.outcome) : [r.status],
  );
const onHand = async (n: number) => (await balance(h.db, items[n]!.stockItemId)).onHand;
const timing = async (n: number) => (await fulfillmentTiming(h.db, warehouseId, [items[n]!.stockItemId])).get(items[n]!.stockItemId)!;

async function openConflict(n: number) {
  const [row] = await h.db
    .select()
    .from(inventoryConflicts)
    .where(and(eq(inventoryConflicts.stockItemId, items[n]!.stockItemId), eq(inventoryConflicts.status, "open")));
  return row ?? null;
}
async function externalMovements(n: number) {
  return h.db
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.stockItemId, items[n]!.stockItemId), eq(inventoryMovements.type, "shopify_external")));
}

/** Замовлення Shopify з однією позицією товару n (вигадані дані). */
function orderFor(n: number, orderNo: number, qty: number, over: Partial<GqlOrder> & { at?: Date } = {}): GqlOrder {
  const { at = new Date(), ...rest } = over;
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

describe("(a) reservations of orders with pending Shopify line changes", () => {
  it("make the item uncertain: an apply-mode difference is not auto-accepted; the flag clears with the pending lines", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(1, 9801, 2)), "live");
    const o = await orderRow(9801);
    expect(["paid", "awaiting_review", "needs_correction"]).toContain(o.status); // відкрите (резервує), не передане
    expect(await balance(h.db, items[1]!.stockItemId)).toMatchObject({ onHand: 12, reserved: 2 });
    fake.setLevel(items[1]!.gid, { available: 10, onHand: 12, committed: 2 });
    expect(await reconcileItem(1)).toEqual(["match"]);
    expect(await timing(1)).toMatchObject({ uncertain: false });

    // Shopify змінив позиції замовлення (застосунок їх не застосував — напр., була активна накладна): резерв застосунку
    // (2) застарів, committed Shopify уже за новими позиціями. Разом із неоплаченим замовленням (+1 committed, якого
    // застосунок не бачить) committed знову 2, а on_hand Shopify на 1 більший: без позначки ця різниця виглядала б
    // «чистою» зміною в Shopify й прийнялася б автоматично.
    await h.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, o.id));
    fake.setLevel(items[1]!.gid, { available: 11, onHand: 13, committed: 2 });
    expect(await timing(1)).toMatchObject({ uncertain: true, inFlight: 0, fulfilledOutside: 0 });
    expect(await withApply(() => reconcileItem(1))).toEqual(["opened"]);
    expect(await onHand(1)).toBe(12);
    expect(await externalMovements(1)).toHaveLength(0);
    const obs = parseObservation((await openConflict(1))!.details)!;
    expect(obs).toMatchObject({ diff: 1, expectedDiff: 0, reservationExcess: 0, uncertain: true, autoApplyBlockers: ["uncertain"] });

    // Позиції оновлено (позначку знято) — невизначеності більше немає.
    await h.db.update(orders).set({ shopifyLinesPendingAt: null }).where(eq(orders.id, o.id));
    expect(await timing(1)).toMatchObject({ uncertain: false });
  });

  it("a pending flag on an order without reserved units of the item does not make it uncertain", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(2, 9802, 1)), "live");
    const o = await orderRow(9802);
    await h.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, o.id));
    // Резерв уже знято (напр., списано), але рядок резерву лишився: позначка не стосується «доступно» цієї позиції.
    await h.db.update(stockReservations).set({ reservedQty: 0 }).where(eq(stockReservations.orderId, o.id));
    expect(await timing(2)).toMatchObject({ uncertain: false });
    await h.db.update(stockReservations).set({ reservedQty: 1 }).where(eq(stockReservations.orderId, o.id));
    expect(await timing(2)).toMatchObject({ uncertain: true });
    await h.db.update(orders).set({ shopifyLinesPendingAt: null }).where(eq(orders.id, o.id));
  });
});

describe("(b) partially fulfilled orders where Shopify fulfilled only items without shipping", () => {
  it("shipped by the app: the physical units still committed in Shopify are in flight — a match, not a false conflict", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(3, 9803, 1, { displayFulfillmentStatus: "FULFILLED" })), "import");
    const o = await orderRow(9803);
    expect(o.status).toBe("handed_to_carrier");
    expect(await onHand(3)).toBe(11);
    // Shopify виконав лише цифрову позицію (подарункову картку): фізична одиниця ще committed і в on_hand Shopify.
    await h.db.update(orders).set({ fulfillmentStatus: "partially_fulfilled", shopifyShippableFulfilled: false }).where(eq(orders.id, o.id));
    fake.setLevel(items[3]!.gid, { available: 11, onHand: 12, committed: 1 });
    expect(await timing(3)).toMatchObject({ inFlight: 1, uncertain: false });
    expect(await reconcileItem(3)).toEqual(["match"]);
    expect(await openConflict(3)).toBeNull();

    // Невідомо (null) або виконано фізичні позиції (true) — як раніше: розподіл невідомий.
    for (const shippable of [null, true]) {
      await h.db.update(orders).set({ shopifyShippableFulfilled: shippable }).where(eq(orders.id, o.id));
      expect(await timing(3), String(shippable)).toMatchObject({ inFlight: 0, uncertain: true });
    }
    await h.db.update(orders).set({ fulfillmentStatus: "fulfilled", shopifyShippableFulfilled: true }).where(eq(orders.id, o.id));
  });

  it("still reserved in the app: not uncertain, so a genuine Shopify change can be auto-accepted", async () => {
    await upsertOrder(ctx, mapOrder(orderFor(4, 9804, 1)), "live");
    const o = await orderRow(9804);
    expect(await balance(h.db, items[4]!.stockItemId)).toMatchObject({ onHand: 12, reserved: 1 });
    await h.db.update(orders).set({ fulfillmentStatus: "partially_fulfilled", shopifyShippableFulfilled: false }).where(eq(orders.id, o.id));
    fake.setLevel(items[4]!.gid, { available: 11, onHand: 12, committed: 1 });
    expect(await timing(4)).toMatchObject({ inFlight: 0, fulfilledOutside: 0, uncertain: false });
    expect(await reconcileItem(4)).toEqual(["match"]);
    // Перерахунок у Shopify (+1): єдине пояснення — зміна в Shopify.
    fake.setLevel(items[4]!.gid, { available: 12, onHand: 13, committed: 1 });
    expect(await withApply(() => reconcileItem(4))).toEqual(["auto_applied"]);
    expect(await onHand(4)).toBe(13);
  });

  it("shipped before opening (no reservation row): counted in flight, not uncertain", async () => {
    await upsertProduct(h.db, mapProduct(gqlProduct(41)), "EUR");
    const yesterday = new Date(Date.now() - 24 * 3600_000);
    await upsertOrder(ctx, mapOrder(orderFor(41, 9841, 2, { at: yesterday })), "live");
    const o = await orderRow(9841);
    await h.db.update(orders).set({ status: "handed_to_carrier" }).where(eq(orders.id, o.id));
    await initializeInventory(ctx);
    await register(41);
    expect(await onHand(41)).toBe(12);
    await h.db.update(orders).set({ fulfillmentStatus: "partially_fulfilled", shopifyShippableFulfilled: false }).where(eq(orders.id, o.id));
    fake.setLevel(items[41]!.gid, { available: 12, onHand: 14, committed: 2 });
    expect(await timing(41)).toMatchObject({ inFlight: 2, uncertain: false });
    expect(await reconcileItem(41)).toEqual(["match"]);
    expect(await openConflict(41)).toBeNull();

    await h.db.update(orders).set({ shopifyShippableFulfilled: null }).where(eq(orders.id, o.id));
    expect(await timing(41)).toMatchObject({ inFlight: 0, uncertain: true });
  });
});

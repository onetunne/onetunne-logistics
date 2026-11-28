import { randomUUID } from "node:crypto";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import type { ActionResult } from "~/components/action-banner";
import type { DatabaseHandle } from "~/db/client.server";
import { auditLog, inventoryConflicts, inventoryMovements, jobs, orderLineItems, orders, productVariants, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { DICTIONARIES } from "~/i18n";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { inventoryKeys } from "~/modules/inventory/keys";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { acceptShopifyValue, dismissConflict, listConflicts, pushAppValue } from "~/modules/inventory-sync/conflicts.server";
import { parseObservation } from "~/modules/inventory-sync/observation";
import {
  autoApplyBlockers,
  compareLevels,
  conflictPushKey,
  pushBlockedByOtherStates,
  pushPlan,
  settlesEvidence,
  unexplainedDiff,
  verdictOf,
} from "~/modules/inventory-sync/pure";
import { runInventoryPush } from "~/modules/inventory-sync/push.server";
import { fulfillmentTiming, runReconcileJob } from "~/modules/inventory-sync/reconcile.server";
import { returnsTimingFrom, type ReturnsState } from "~/modules/inventory-sync/returns.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { receiveStock } from "~/modules/warehouse/operations.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { RequestContext, ServiceContext } from "~/server/types";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";
import { runFinanceOrderSync } from "~/modules/finance-sync/sync-order.server";
import {
  SHOP as FINANCE_SHOP,
  agreement as financeAgreement,
  bag,
  fakeFinanceAdmin,
  financeNode,
  refund as financeRefund,
  refundLine,
  sale as financeSale,
  transaction as financeTransaction,
  type FinanceOrderFixture,
} from "../stage6/fixtures/shopify-finance";
import { OWNER, openTestDatabase } from "../helpers";
import { apply, balance } from "./helpers";
import { fakeInventoryAdmin, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Синхронізація залишків, рев'ю етапу 5, раунд 3 (NEW-1…NEW-6): повернення покупця рахуються від останнього узгодження
 * (повернення без замовлення не «покривають» нових відшкодувань назавжди; повернення, оприбутковане до відшкодування,
 * чекає поповнення в Shopify й не надсилається), невідома спроба «надіслати склад» переживає відхилення, розподіл
 * reservationExcess — за on_hand Shopify, точний збіг узгоджує докази, «надіслати склад» не блокується назавжди
 * одиницями в інших станах Shopify. Кожен тест відтворює сценарій знахідки й падає без виправлення (крім позначених
 * «control»). Вигадані дані. Справжній PostgreSQL — TEST_DATABASE_URL.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null, admin: null as AdminGraphql | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));
vi.mock("~/integrations/shopify/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/integrations/shopify/admin-client.server")>();
  return {
    ...actual,
    adminClientFor: async () => {
      if (!m.admin) throw new Error("admin is not set");
      return m.admin;
    },
  };
});

const SHOP = "ot-returns.myshopify.com";
const APP_URL = "https://ot-app.example.com";
// Етап 6 (WP3): товари 15–16 — звірка повернень за рядками повернень Shopify (NO_RESTOCK / RETURN), справжній шлях синхронізації.
const N = 16;

let hd: DatabaseHandle;
let ctx: ServiceContext;
let fake: FakeInventoryAdmin;
let page: typeof import("~/pages/inventory-sync");
const items: Record<number, { variantId: string; stockItemId: string; gid: string }> = {};

beforeAll(async () => {
  hd = await openTestDatabase();
  await seedReferenceData(hd.db, DEMO_SETTINGS);
  ctx = { mode: "production", db: hd.db, actor: OWNER, carriers: createDemoCarriers(hd.db), shopify: new DemoShopifyGateway(), now: () => new Date() };
  m.ctx = { ...ctx, basePath: "/app", locale: "uk" };
  await hd.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_products,read_inventory,write_inventory" });
  for (let n = 1; n <= N; n++) await upsertProduct(hd.db, mapProduct(gqlProduct(n)), "EUR"); // inventoryQuantity 12
  await initializeInventory(ctx);
  fake = fakeInventoryAdmin();
  m.admin = fake.admin;
  for (let n = 1; n <= N; n++) {
    const [v] = await hd.db
      .select({ id: productVariants.id, gid: productVariants.inventoryItemId })
      .from(productVariants)
      .where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
    items[n] = { variantId: v!.id, stockItemId: await ensureStockItemForVariant(hd.db, v!.id), gid: v!.gid! };
    fake.setLevel(v!.gid!, { available: 12, onHand: 12, committed: 0 });
  }
  await setWarehouse({ shopifyPush: "deltas", externalShopifyChanges: "review" });
  page = await import("~/pages/inventory-sync");
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
const reconcileItem = async (n: number, now?: Date) =>
  runReconcileJob({ db: hd.db, admin: adminFor, ...(now ? { now: () => now } : {}) }, { scope: "item", inventoryItemGid: items[n]!.gid }).then(
    (r) => ("results" in r ? r.results.map((x) => x.outcome) : [r.status]),
  );
const onHand = async (n: number) => (await balance(hd.db, items[n]!.stockItemId)).onHand;
const level = (n: number) => fake.levels.get(items[n]!.gid)!;
const setShopify = (n: number, available: number, onHandQty = available, committed = 0) =>
  fake.setLevel(items[n]!.gid, { available, onHand: onHandQty, committed });
const receipt = async (n: number, qty: number) =>
  (await apply(hd.db, { stockItemId: items[n]!.stockItemId, type: "receipt_manual", idempotencyKey: inventoryKeys.manual(randomUUID()), onHandDelta: qty }))
    .applied[0]!;
/** Повернення покупця (Shopify поповнює сам — skipped), з замовленням або без. */
const returnReceipt = (n: number, qty: number, orderId?: string) =>
  receiveStock(ctx, { operationId: randomUUID(), stockItemId: items[n]!.stockItemId, quantity: qty, reason: "customer_return", orderId: orderId ?? null });
const timing = async (n: number) =>
  (await fulfillmentTiming(hd.db, (await getDefaultWarehouse(hd.db)).id, [items[n]!.stockItemId])).get(items[n]!.stockItemId)!;

async function openConflict(n: number) {
  const [row] = await hd.db
    .select()
    .from(inventoryConflicts)
    .where(and(eq(inventoryConflicts.stockItemId, items[n]!.stockItemId), eq(inventoryConflicts.status, "open")));
  return row ?? null;
}
const observation = async (n: number) => parseObservation((await openConflict(n))!.details)!;
const view = async (id: string) => (await listConflicts(hd.db, { conflictId: id })).rows[0]!;

async function syncState(movementId: string) {
  const [row] = await hd.db.select({ s: inventoryMovements.shopifySyncState }).from(inventoryMovements).where(eq(inventoryMovements.id, movementId));
  return row?.s;
}

/** Замовлення Shopify з однією позицією товару n, уже виконане в Shopify (вигадані дані). */
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

/** Виконане замовлення товару n на 1 шт.: склад −1, Shopify −1, звірено (збіг). */
async function shippedOrder(n: number, orderNo: number) {
  const before = await onHand(n);
  await upsertOrder(ctx, mapOrder(fulfilledOrder(n, orderNo, 1)), "import");
  const [o] = await hd.db.select().from(orders).where(eq(orders.shopifyOrderId, `gid://shopify/Order/${orderNo}`));
  expect(o!.status).toBe("handed_to_carrier");
  expect(await onHand(n)).toBe(before - 1);
  setShopify(n, level(n).available - 1);
  expect(await reconcileItem(n)).toEqual(["match"]);
  return o!;
}

/** Відшкодування в Shopify: поточна кількість позиції 0 (з поверненням на склад чи без — вирішує тест для Shopify). */
async function refund(orderId: string) {
  await hd.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, orderId));
  await hd.db.update(orders).set({ shopifyUpdatedAt: new Date() }).where(eq(orders.id, orderId));
}

const none = { inFlight: 0, fulfilledOutside: 0, uncertain: false };

// ---------------------------------------------------------------------------

describe("NEW-1: unlinked customer returns already settled do not offset later refunds", () => {
  it("an unlinked return restocked by hand and matched, then a refund with restock: not auto-applied, no double count", async () => {
    await returnReceipt(1, 1); // склад 13 (без замовлення)
    setShopify(1, 13); // Shopify поповнили вручну
    expect(await reconcileItem(1)).toEqual(["match"]);
    const [marker] = await hd.db.select().from(auditLog).where(eq(auditLog.action, "inventory_sync.in_sync")).orderBy(desc(auditLog.id)).limit(1);
    expect(marker!.details).toMatchObject({ source: "match", returns: { unlinked: 1 } });

    const o = await shippedOrder(1, 9801); // склад 12, Shopify 12
    await refund(o.id);
    setShopify(1, 13); // відшкодовано з поверненням на склад: Shopify +1, посилка ще в дорозі
    expect(await timing(1)).toMatchObject({ returnsPending: 1, uncertain: true });
    expect(await withApply(() => reconcileItem(1))).toEqual(["opened"]);
    expect(await onHand(1)).toBe(12);
    expect((await observation(1)).autoApplyBlockers).toContain("uncertain");

    // Посилка надійшла, працівник не вказав замовлення: склад 13 = Shopify 13 = фізично.
    await returnReceipt(1, 1);
    expect(await withApply(() => reconcileItem(1))).toEqual(["closed"]);
    expect(await onHand(1)).toBe(13);
  });

  it("pure: the unlinked pool counts only receipts since the agreement and within the window", () => {
    const state = (over: Partial<ReturnsState>): ReturnsState => ({
      orders: new Map([["o1", { returned: 1, received: 0, receivedSkipped: 0 }]]),
      unlinkedTotal: 1,
      unlinkedWindow: 1,
      unlinkedWindowSkipped: 1,
      ...over,
    });
    // До узгодження повернення без замовлення покриває відшкодування.
    expect(returnsTimingFrom(state({}), { net: {}, unlinked: 0 })).toEqual({ pending: 0, awaiting: 0 });
    // Уже узгоджене — ні.
    expect(returnsTimingFrom(state({}), { net: {}, unlinked: 1 })).toEqual({ pending: 1, awaiting: 0 });
    // Давнє (поза вікном) — ні.
    expect(returnsTimingFrom(state({ unlinkedWindow: 0, unlinkedWindowSkipped: 0 }), { net: {}, unlinked: 0 })).toEqual({ pending: 1, awaiting: 0 });
    // Відшкодування, узгоджене збігом (без повернення на склад), — більше не очікується.
    expect(returnsTimingFrom(state({ unlinkedTotal: 0, unlinkedWindow: 0 }), { net: { o1: 1 }, unlinked: 0 })).toEqual({ pending: 0, awaiting: 0 });
  });
});

describe("NEW-2: a return received before the merchant refunds and restocks in Shopify", () => {
  it("waits for Shopify's restock: «send warehouse» does not send it, the restock closes the difference", async () => {
    const o = await shippedOrder(2, 9802); // склад 11, Shopify 11
    await returnReceipt(2, 1, o.id); // склад 12 (Shopify поповнить сам)
    expect(await withApply(() => reconcileItem(2))).toEqual(["opened"]);
    expect(await onHand(2)).toBe(12);
    expect(await observation(2)).toMatchObject({ diff: -1, returnsAwaiting: 1, unsentDelta: 1 });
    expect((await observation(2)).autoApplyBlockers).toEqual(expect.arrayContaining(["awaiting_restock", "unsent_movements"]));
    const c = (await openConflict(2))!;
    expect(await view(c.id)).toMatchObject({ returnsAwaiting: 1, pushDelta: 0, pushHeldAwaiting: 1, pushBlockedOtherStates: false });
    const calls = fake.adjustCalls().length;
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "awaiting_restock", count: 1 });
    expect(fake.adjustCalls()).toHaveLength(calls);
    expect(level(2).available).toBe(11);

    await refund(o.id);
    setShopify(2, 12); // відшкодовано з поверненням на склад
    expect(await withApply(() => reconcileItem(2))).toEqual(["closed"]);
    expect(await onHand(2)).toBe(12);
    // Узгоджено: наступна ручна зміна в Shopify приймається автоматично.
    setShopify(2, 14);
    expect(await withApply(() => reconcileItem(2))).toEqual(["auto_applied"]);
    expect(await onHand(2)).toBe(14);
  });

  it("if the owner sends it anyway, Shopify's later restock is not auto-applied (reported as a return to correct)", async () => {
    const o = await shippedOrder(3, 9803);
    await returnReceipt(3, 1, o.id);
    expect(await reconcileItem(3)).toEqual(["opened"]);
    const c = (await openConflict(3))!;
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL, includeReturns: true })).toEqual({ status: "pushed", delta: 1 });
    expect(level(3).available).toBe(12);

    await refund(o.id);
    setShopify(3, 13); // Shopify поповнив повернення вдруге
    expect(await withApply(() => reconcileItem(3))).toEqual(["opened"]);
    expect(await onHand(3)).toBe(12);
    expect(await observation(3)).toMatchObject({ diff: 1, returnsPending: 1, uncertain: true });
    expect(await pushAppValue(ctx, fake.admin, (await openConflict(3))!.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: -1 });
    expect(level(3).available).toBe(12);
  });

  it("retrying with «Shopify will not restock» after an unknown send uses its own key; the CAS prevents a double apply", async () => {
    const o = await shippedOrder(13, 9813); // склад 11, Shopify 11
    await returnReceipt(13, 1, o.id); // склад 12, чекає поповнення в Shopify
    fake.inject({ userErrors: [{ field: ["input", "reason"], message: "bad", code: "INVALID_REASON" }] });
    await receipt(13, 2); // склад 14, передача не вдалася
    expect(await push()).toMatchObject({ failed: 1 });
    expect(await reconcileItem(13)).toEqual(["opened"]);
    const c = (await openConflict(13))!;
    expect(await view(c.id)).toMatchObject({ diff: -3, pushDelta: 2, pushHeldAwaiting: 1 });
    fake.inject({ applyThenThrow: new ShopifyApiError("timeout", true, "TIMEOUT") });
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "unknown" });
    expect(level(13).available).toBe(13); // Shopify застосував +2, відповідь втрачено
    const r = await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL, includeReturns: true });
    expect(r).toMatchObject({ status: "stale" });
    expect(level(13).available).toBe(13); // не 16: друга спроба не застосована
    expect(fake.adjustCalls().slice(-2).map((a) => a.key)).toEqual([conflictPushKey(c.id, 1), conflictPushKey(c.id, 1, true)]);
    expect(await onHand(13)).toBe(14);
  });

  it("an unlinked return received before the refund also waits for the restock", async () => {
    const o = await shippedOrder(4, 9804);
    await returnReceipt(4, 1);
    expect(await reconcileItem(4)).toEqual(["opened"]);
    expect(await observation(4)).toMatchObject({ returnsAwaiting: 1 });
    expect(await pushAppValue(ctx, fake.admin, (await openConflict(4))!.id, { appUrl: APP_URL })).toEqual({ status: "awaiting_restock", count: 1 });
    await refund(o.id);
    setShopify(4, 12);
    expect(await reconcileItem(4)).toEqual(["closed"]);
    expect(await onHand(4)).toBe(12);
  });
});

describe("NEW-3: an unknown «send warehouse» survives dismissal", () => {
  it("dismissed while the push result is unknown: the next conflict is not auto-applied and accept refuses", async () => {
    setShopify(5, 15);
    expect(await reconcileItem(5)).toEqual(["opened"]);
    const c = (await openConflict(5))!;
    fake.inject({ throw: new ShopifyApiError("timeout", true, "TIMEOUT") });
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "unknown" });
    expect(await dismissConflict(ctx, c.id, "Перевірю в Shopify")).toEqual({ status: "dismissed" });

    expect(await withApply(() => reconcileItem(5))).toEqual(["opened"]);
    expect(await onHand(5)).toBe(12);
    const obs = await observation(5);
    expect(obs.autoApplyBlockers).toEqual(["push_pending"]);
    expect(obs.pushAttempt?.key).toBe(conflictPushKey(c.id, 1));
    const next = (await openConflict(5))!;
    expect((await view(next.id)).pushAttemptAt).not.toBeNull();
    expect(await acceptShopifyValue(ctx, next.id, { admin: adminFor })).toEqual({ status: "push_pending" });

    // Після 24 год Shopify ключ уже не пам'ятає — спроба більше не враховується.
    const later = new Date(Date.now() + 25 * 3600_000);
    expect(await withApply(() => reconcileItem(5, later))).toEqual(["auto_applied"]);
    expect(await onHand(5)).toBe(15);
  });

  it("a definitive refusal after a concurrent dismissal clears the attempt, so nothing lingers into the next conflict", async () => {
    setShopify(6, 14);
    expect(await reconcileItem(6)).toEqual(["opened"]);
    const c = (await openConflict(6))!;
    let dismissed = false;
    const racing: AdminGraphql = async (query, variables) => {
      if (/mutation OtInventoryAdjust/.test(query) && !dismissed) {
        dismissed = true;
        await dismissConflict(ctx, c.id, "Перевірено");
        fake.inject({ userErrors: [{ field: ["input", "changes", "0", "delta"], message: "bad", code: "INVALID_QUANTITY_DOCUMENT" }] });
      }
      return fake.admin(query, variables);
    };
    expect(await pushAppValue(ctx, racing, c.id, { appUrl: APP_URL })).toEqual({ status: "failed", code: "INVALID_QUANTITY_DOCUMENT" });
    const [row] = await hd.db.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, c.id));
    expect(row!.status).toBe("dismissed");
    expect(row!.details).not.toHaveProperty("pushAttempt");
    expect(await withApply(() => reconcileItem(6))).toEqual(["auto_applied"]);
    expect(await onHand(6)).toBe(14);
  });
});

describe("NEW-4: the reservation-excess split uses Shopify on-hand", () => {
  it("units moved to other Shopify states are not absorbed as «released by Shopify»", () => {
    const states = compareLevels({ available: 11, onHand: 13, committed: 0 }, { onHand: 13, reserved: 3 }, none);
    expect(states).toMatchObject({ diff: 1, reservationExcess: 3, shopifyOtherStates: 2, expectedDiff: 3 });
    expect(verdictOf(states)).toBe("conflict");
    expect(unexplainedDiff(states)).toBe(-2);
    // Замовлення змінено в Shopify (звільнено 2) і 1 шт. переміщено в брак.
    const mixed = compareLevels({ available: 10, onHand: 12, committed: 1 }, { onHand: 12, reserved: 3 }, none);
    expect(unexplainedDiff(mixed)).toBe(-1);
  });

  it("stale in-flight units do not hide a real Shopify change", () => {
    const stale = compareLevels({ available: 13, onHand: 13, committed: 0 }, { onHand: 12, reserved: 0 }, { ...none, inFlight: 2 });
    expect(stale).toMatchObject({ diff: 1, expectedDiff: 0, reservationExcess: 2 });
    expect(verdictOf(stale)).toBe("conflict");
    expect(unexplainedDiff(stale)).toBe(1);
    // Без зовнішньої зміни — збіг (виконано в Shopify), але докази не узгоджуються (reservationExcess).
    const fulfilled = compareLevels({ available: 12, onHand: 12, committed: 0 }, { onHand: 12, reserved: 0 }, { ...none, inFlight: 2 });
    expect(verdictOf(fulfilled)).toBe("match");
    expect(settlesEvidence(fulfilled)).toBe(false);
  });

  it("control: the round-2 cases keep their verdicts", () => {
    expect(verdictOf(compareLevels({ available: 9, onHand: 10, committed: 1 }, { onHand: 10, reserved: 3 }, none))).toBe("explained");
    expect(verdictOf(compareLevels({ available: 13, onHand: 13, committed: 0 }, { onHand: 13, reserved: 3 }, none))).toBe("explained");
    expect(verdictOf(compareLevels({ available: 7, onHand: 7, committed: 0 }, { onHand: 10, reserved: 3 }, none))).toBe("match");
    expect(unexplainedDiff(compareLevels({ available: 11, onHand: 12, committed: 1 }, { onHand: 10, reserved: 3 }, none))).toBe(2);
  });
});

describe("NEW-5: an exact match settles the evidence even while returns are uncertain", () => {
  it("refund without restock + a failed receipt fixed in Shopify by hand: the failed send is settled, auto-apply resumes", async () => {
    const o = await shippedOrder(8, 9808); // склад 11, Shopify 11
    await refund(o.id); // відшкодовано БЕЗ повернення на склад: Shopify не змінився
    expect(await timing(8)).toMatchObject({ returnsPending: 1, uncertain: true });
    fake.inject({ userErrors: [{ field: ["input", "reason"], message: "bad", code: "INVALID_REASON" }] });
    const mv = await receipt(8, 2);
    expect(await push()).toMatchObject({ failed: 1 });
    expect(await syncState(mv.id)).toBe("failed");
    setShopify(8, 13); // власник виправив Shopify вручну
    expect(await reconcileItem(8)).toEqual(["match"]);
    expect(await syncState(mv.id)).toBe("pushed");
    expect(await timing(8)).toMatchObject({ returnsPending: 0 });
    setShopify(8, 15);
    expect(await withApply(() => reconcileItem(8))).toEqual(["auto_applied"]);
    expect(await onHand(8)).toBe(15);
  });

  it("pure: exact match settles; reservation excess or an uncertain explained difference does not", () => {
    const base = { reservationExcess: 0, uncertain: false, returnsAwaiting: 0 };
    expect(settlesEvidence({ ...base, diff: 0, expectedDiff: 0, uncertain: true })).toBe(true);
    expect(settlesEvidence({ ...base, diff: 0, expectedDiff: 0, returnsAwaiting: 1 })).toBe(true);
    expect(settlesEvidence({ ...base, diff: 0, expectedDiff: 0, reservationExcess: 2 })).toBe(false);
    expect(settlesEvidence({ ...base, diff: -2, expectedDiff: -2 })).toBe(true);
    expect(settlesEvidence({ ...base, diff: -2, expectedDiff: -2, uncertain: true })).toBe(false);
    expect(settlesEvidence({ ...base, diff: 1, expectedDiff: 0 })).toBe(false);
  });
});

describe("NEW-6: «send warehouse» with units Shopify keeps in other states (safety stock)", () => {
  it("sends the receipt without the held units; only the held remainder is refused", async () => {
    setShopify(9, 11, 12); // 1 шт. — безпечний запас Shopify
    fake.inject({ userErrors: [{ field: ["input", "reason"], message: "bad", code: "INVALID_REASON" }] });
    const mv = await receipt(9, 5);
    expect(await push()).toMatchObject({ failed: 1 });
    expect(await onHand(9)).toBe(17);
    expect(await reconcileItem(9)).toEqual(["opened"]);
    const c = (await openConflict(9))!;
    expect(await view(c.id)).toMatchObject({ diff: -6, unexplained: -6, pushDelta: 5, pushHeldOtherStates: 1, pushBlockedOtherStates: false });
    expect(await pushAppValue(ctx, fake.admin, c.id, { appUrl: APP_URL })).toEqual({ status: "pushed", delta: 5, heldOtherStates: 1 });
    expect(level(9)).toMatchObject({ available: 16, onHand: 17 }); // фактичний залишок Shopify = склад
    expect(await syncState(mv.id)).toBe("pushed");

    expect(await reconcileItem(9)).toEqual(["opened"]); // лишається −1: одиниця безпечного запасу
    const c2 = (await openConflict(9))!;
    expect(await view(c2.id)).toMatchObject({ diff: -1, pushDelta: 0, pushBlockedOtherStates: true });
    const calls = fake.adjustCalls().length;
    expect(await pushAppValue(ctx, fake.admin, c2.id, { appUrl: APP_URL })).toEqual({ status: "other_states", count: 1 });
    expect(fake.adjustCalls()).toHaveLength(calls);
  });

  it("pure: the push plan holds other states and awaiting returns, never a decrease", () => {
    expect(pushPlan({ diff: -6, expectedDiff: 0, shopifyOtherStates: 1 })).toEqual({ full: 6, delta: 5, heldOtherStates: 1, heldAwaiting: 0 });
    expect(pushPlan({ diff: -3, expectedDiff: 0, shopifyOtherStates: 3 })).toMatchObject({ delta: 0, heldOtherStates: 3 });
    expect(pushPlan({ diff: -3, expectedDiff: 0, shopifyOtherStates: 0, returnsAwaiting: 1 })).toMatchObject({ delta: 2, heldAwaiting: 1 });
    expect(pushPlan({ diff: -3, expectedDiff: 0, shopifyOtherStates: 0, returnsAwaiting: 1 }, { includeReturns: true })).toMatchObject({ delta: 3 });
    expect(pushPlan({ diff: 2, expectedDiff: 0, shopifyOtherStates: 1, returnsAwaiting: 1 })).toMatchObject({ delta: -2, heldOtherStates: 0 });
    expect(pushBlockedByOtherStates({ diff: -1, expectedDiff: 0, shopifyOtherStates: 1 })).toBe(true);
    expect(pushBlockedByOtherStates({ diff: -6, expectedDiff: 0, shopifyOtherStates: 1 })).toBe(false);
    expect(autoApplyBlockers({ expectedDiff: 0, uncertain: false, reservationExcess: 0, shopifyOtherStates: 0, returnsAwaiting: 1 }, { failedPushes: 0, unsentDelta: 0 })).toEqual([
      "awaiting_restock",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Сторінка «Склад → Shopify»
// ---------------------------------------------------------------------------

const URL_BASE = "http://localhost/app/warehouse/shopify";
async function act(fields: Record<string, string>): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return page.action({ request: new Request(URL_BASE, { method: "POST", body }), params: {}, context: {} } as never);
}
async function render(search = ""): Promise<string> {
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: "layout",
          path: "app",
          Component: Outlet,
          children: [{ id: "page", path: "warehouse/shopify", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`${URL_BASE}${search}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}
const uk = (key: string) => DICTIONARIES.uk[key]!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("page: returns awaiting Shopify's restock and held units", () => {
  it("explains the awaiting return, offers the «Shopify will not restock» option and passes it to the server", async () => {
    const o = await shippedOrder(10, 9810);
    await returnReceipt(10, 1, o.id);
    expect(await act({ intent: "reconcileItem", stockItemId: items[10]!.stockItemId })).toMatchObject({ ok: true });
    const id = (await openConflict(10))!.id;
    const html = await render(`?conflict=${id}`);
    expect(html).toContain(esc(uk("inventorySync.why.returnsAwaiting").replace("{count}", "1")));
    expect(html).toContain(esc(uk("inventorySync.action.pushApp.heldAwaiting").replace("{count}", "1")));
    expect(html).toContain(`name="includeReturns"`);
    expect(html).toContain(esc(uk("inventorySync.action.accept.awaitingWarning").replace("{count}", "1")));
    expect(await act({ intent: "pushApp", conflictId: id })).toEqual({ ok: false, error: "inventorySync.pushAwaitingReturns", params: { count: 1 } });
    expect(level(10).available).toBe(11);
    expect(await act({ intent: "pushApp", conflictId: id, includeReturns: "on" })).toEqual({
      ok: true,
      message: "inventorySync.result.pushed",
      params: { delta: "+1" },
    });
    expect(level(10).available).toBe(12);
  });

  it("reports held other-state units after a partial send", async () => {
    setShopify(11, 11, 12);
    fake.inject({ userErrors: [{ field: ["input", "reason"], message: "bad", code: "INVALID_REASON" }] });
    await receipt(11, 3);
    expect(await push()).toMatchObject({ failed: 1 });
    await act({ intent: "reconcileItem", stockItemId: items[11]!.stockItemId });
    const id = (await openConflict(11))!.id;
    const html = await render(`?conflict=${id}`);
    expect(html).toContain(esc(uk("inventorySync.action.pushApp.heldOtherStates").replace("{count}", "1")));
    expect(await act({ intent: "pushApp", conflictId: id })).toEqual({
      ok: true,
      message: "inventorySync.result.pushedHeld",
      params: { delta: "+3", held: 1 },
      tone: "info",
    });
    expect(level(11)).toMatchObject({ available: 14, onHand: 15 });
  });

  it("warns on a conflict whose «send warehouse» result is unknown", async () => {
    setShopify(12, 15);
    await act({ intent: "reconcileItem", stockItemId: items[12]!.stockItemId });
    const c = (await openConflict(12))!;
    fake.inject({ throw: new ShopifyApiError("timeout", true, "TIMEOUT") });
    expect(await act({ intent: "pushApp", conflictId: c.id })).toMatchObject({ ok: true, message: "inventorySync.result.unknown" });
    const html = await render(`?conflict=${c.id}`);
    expect(html).toContain(esc(uk("inventorySync.action.dismiss.pushPending")));
  });
});

// ---------------------------------------------------------------------------
// Етап 6 (WP3, docs/stage6-design.md §14.3 п. 6): «повернено на склад Shopify» — з рядків повернень коштів
// (restockType RETURN + restocked), а не з «списано − поточна кількість». Повернення коштів без повернення на склад
// (NO_RESTOCK) теж зменшує currentQuantity, але на склад Shopify нічого не повертає — раніше воно «пояснювало» справжню
// розбіжність. Обидва шляхи — справжні: синхронізація етапу 2 (current_quantity відвантаженого замовлення) і фінансова
// синхронізація (рядки повернень) з імітацією Admin API.
// ---------------------------------------------------------------------------

describe("stage 6: Shopify restock comes from refund lines (NO_RESTOCK regression through the real sync paths)", () => {
  const finance = new Map<string, FinanceOrderFixture>();
  const financeAdmin = fakeFinanceAdmin(finance);

  /** Відшкодування в Shopify: синхронізація етапу 2 (currentQuantity 0) і фінансів (рядок повернення з видом). */
  async function refundInShopify(n: number, orderNo: number, restock: "NO_RESTOCK" | "RETURN") {
    const orderGid = `gid://shopify/Order/${orderNo}`;
    const updatedAt = new Date(Date.now() + 1000).toISOString();
    const refunded = fulfilledOrder(n, orderNo, 1);
    refunded.updatedAt = updatedAt;
    refunded.displayFinancialStatus = "REFUNDED";
    refunded.lineItems.nodes[0]!.currentQuantity = 0;
    await upsertOrder(ctx, mapOrder(refunded), "live");
    const lineGid = refunded.lineItems.nodes[0]!.id;
    const ref = financeRefund({ amount: "29.90", lines: [refundLine(lineGid, 1, restock, restock === "RETURN", "29.90")] });
    finance.set(orderGid, {
      finance: financeNode(orderGid, {
        updatedAt,
        displayFinancialStatus: "REFUNDED",
        transactions: [financeTransaction({ amount: "29.90" }), financeTransaction({ kind: "REFUND", amount: "29.90" })],
        totals: { currentTotalPriceSet: bag("0.00"), netPaymentSet: bag("0.00"), totalRefundedSet: bag("29.90") },
      }),
      agreements: [
        financeAgreement("OrderAgreement", updatedAt, [financeSale({ total: "29.90", lineItem: lineGid })]),
        financeAgreement("RefundAgreement", updatedAt, [financeSale({ total: "-29.90", quantity: -1, actionType: "RETURN", lineItem: lineGid })], {
          refund: { id: ref.id },
        }),
      ],
      refunds: [ref],
    });
    return { orderGid, lineGid };
  }

  const syncFinance = (orderGid: string) => runFinanceOrderSync({ db: hd.db, admin: financeAdmin.admin }, { shop: FINANCE_SHOP, orderGid });

  it("NO_RESTOCK: the stage-2 sync now updates current_quantity of the shipped order; refund lines then show «not restocked» — the difference is no longer explained", async () => {
    const o = await shippedOrder(15, 9815); // склад 11, Shopify 11
    const { orderGid } = await refundInShopify(15, 9815, "NO_RESTOCK"); // Shopify НЕ поповнив
    const [line] = await hd.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id));
    expect(line).toMatchObject({ quantity: 1, currentQuantity: 0 }); // §14.3 п. 6: лише current_quantity
    // До фінансових фактів — як раніше (за кількістю): одиниця «може бути поповнена», звірка невизначена.
    expect(await timing(15)).toMatchObject({ returnsPending: 1, uncertain: true });

    expect(await syncFinance(orderGid)).toMatchObject({ status: "synced", refundsRead: true, refundLines: 1 });
    // З рядками повернень: NO_RESTOCK на склад Shopify нічого не повернув — нічого й не очікується.
    expect(await timing(15)).toMatchObject({ returnsPending: 0, uncertain: false });
    expect(await reconcileItem(15)).toEqual(["match"]);

    // Справжня розбіжність (хтось змінив Shopify вручну) більше не «пояснюється» поверненням: її видно без невизначеності.
    setShopify(15, level(15).available + 1);
    expect(await reconcileItem(15)).toEqual(["opened"]);
    expect(await observation(15)).toMatchObject({ diff: 1, returnsPending: 0, uncertain: false });
    expect((await observation(15)).autoApplyBlockers ?? []).not.toContain("uncertain");
  });

  it("RETURN + restocked: pending until the parcel is received, then in sync (refund lines say Shopify restocked)", async () => {
    const o = await shippedOrder(16, 9816); // склад 11, Shopify 11
    const { orderGid } = await refundInShopify(16, 9816, "RETURN");
    setShopify(16, level(16).available + 1); // Shopify поповнив
    expect(await syncFinance(orderGid)).toMatchObject({ status: "synced", refundLines: 1 });
    expect(await timing(16)).toMatchObject({ returnsPending: 1, uncertain: true });
    await returnReceipt(16, 1, o.id); // посилка надійшла: склад 12 = Shopify 12
    expect(await timing(16)).toMatchObject({ returnsPending: 0 });
    expect(await reconcileItem(16)).toEqual(["match"]);
    expect(await onHand(16)).toBe(12);
  });

  it("stale refund facts (the order changed in Shopify after the finance sync) fall back to the quantity rule", async () => {
    // Замовлення 9815 знову змінилося в Shopify (новіший updatedAt), фінанси ще не перечитано: рядки повернень можуть бути
    // неповними — звірка тимчасово рахує за кількістю (консервативно: невизначеність, а не хибний збіг).
    await hd.db.update(orders).set({ shopifyUpdatedAt: new Date(Date.now() + 60_000) }).where(eq(orders.shopifyOrderId, "gid://shopify/Order/9815"));
    expect(await timing(15)).toMatchObject({ returnsPending: 1, uncertain: true });
  });
});


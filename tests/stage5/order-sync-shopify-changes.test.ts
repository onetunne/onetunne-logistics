import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  issues,
  jobs,
  orderChanges,
  orderLineItems,
  orders,
  productVariants,
  shipments,
  shopInstallations,
  stockReservations,
} from "~/db/schema";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { confirmShippedOutsideApp } from "~/modules/orders/shipped-outside.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { reissueWaybill } from "~/modules/shipments/reissue.server";
import { cancelWaybillDetailed, createWaybill } from "~/modules/shipments/waybill.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { JOB } from "~/modules/shopify-sync/jobs";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { hasPendingShopifyLineChanges } from "~/modules/shopify-sync/pending-lines.server";
import { upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { fakeAdmin, gqlOrder, gqlProduct } from "../stage2/fixtures";
import { OWNER, STAFF, openTestDatabase } from "../helpers";
import { balance, movementCount, stockItemFor } from "./helpers";

/**
 * Регресійні тести огляду етапу 5 (G1a): зміни позицій у Shopify під час активної накладної (застосування після
 * скасування, блокування нової накладної/переоформлення/ручної передачі), видалений у Shopify варіант, замовлення,
 * виконані в Shopify поза застосунком («Відправлено поза застосунком»), позиції, додані після знімка складу.
 * Production-контекст з тестовим перевізником (sandbox) — справжніх накладних немає; Admin API — імітація.
 */
const SHOP = "ot-test.myshopify.com";
let h: DatabaseHandle;
let ctx: ServiceContext;
let item: string;
let snapshotAt: Date;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
let handlers: ReturnType<typeof createSyncHandlers>;

/** Менеджер: працівник із дозволом керування накладними (не власник). */
const MANAGER = makeActor({ id: "test-manager", displayName: "Manager", role: "staff", overrides: { grant: ["waybills.manage"] } });

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = {
    mode: "production",
    db: h.db,
    actor: OWNER,
    carriers: createDemoCarriers(h.db),
    shopify: new QueueingShopifyGateway(h.db, async () => SHOP),
    now: () => new Date(),
  };
  await h.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_orders,read_products,read_inventory" });
  store = { orders: new Map(), products: new Map([["gid://shopify/Product/1", gqlProduct(1)]]) };
  const fake = fakeAdmin(store);
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
  await upsertProduct(h.db, mapProduct(gqlProduct(1)), "EUR"); // Shopify available 12
  await initializeInventory(ctx);
  const [v] = await h.db.select().from(productVariants);
  snapshotAt = v!.inventorySyncedAt!;
  item = await stockItemFor(h.db, v!.id);
});
afterAll(async () => {
  await h.close();
});

const at = (minutes: number) => new Date(snapshotAt.getTime() + minutes * 60_000).toISOString();
const gid = (n: number) => `gid://shopify/Order/${n}`;
const line = (n: number, quantity: number, currentQuantity?: number, over: Record<string, unknown> = {}) => ({
  ...gqlOrder(n).lineItems.nodes[0]!,
  quantity,
  ...(currentQuantity === undefined ? {} : { currentQuantity }),
  ...over,
});
/** Замовлення, створене через `placed` хв після знімка (від'ємне — до знімка); updatedAt — через `minutes` хв. */
function order(n: number, over: Partial<GqlOrder> & { minutes?: number; placed?: number } = {}): GqlOrder {
  const { minutes = 1, placed = 1, ...rest } = over;
  return gqlOrder(n, { createdAt: at(placed), processedAt: at(placed), updatedAt: at(minutes), ...rest });
}
const lines = (...nodes: ReturnType<typeof line>[]) => ({ nodes });

async function orderRow(n: number) {
  const [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, gid(n)));
  return o!;
}
async function lineRows(n: number) {
  return h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, (await orderRow(n)).id));
}
async function reservedFor(n: number) {
  const rows = await h.db.select().from(stockReservations).where(eq(stockReservations.orderId, (await orderRow(n)).id));
  return rows.reduce((s, r) => s + r.reservedQty, 0);
}
async function openIssues(n: number) {
  return h.db.select().from(issues).where(and(eq(issues.orderId, (await orderRow(n)).id), eq(issues.status, "open")));
}
/** Shopify: замовлення існує з такими даними, і застосунок отримує подію про нього. */
async function shopifyHas(o: GqlOrder) {
  store.orders.set(o.id, o);
  return upsertOrder(ctx, mapOrder(o), "live");
}
/** Виконує поставлене в чергу читання замовлення з Shopify (як обробник черги). */
async function runQueuedOrderSync(n: number) {
  const [job] = await h.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, JOB.syncOrder), eq(jobs.dedupeKey, `order:${gid(n)}`), eq(jobs.status, "queued")));
  expect(job, "queued shopify.sync_order").toBeDefined();
  await handlers[JOB.syncOrder]!.run(job!);
  await h.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, job!.id));
}
async function readyWaybill(n: number) {
  const o = await orderRow(n);
  await validateOrderById(ctx, o.id, "manual");
  const created = await createWaybill(ctx, o.id);
  expect(created.kind).toBe("created");
  return created.kind === "created" ? created.shipment : null!;
}

describe("Shopify line changes while a waybill is active (inventory-2, regressions-1, packing-1)", () => {
  it("are applied after the waybill is cancelled; until then new waybill, reissue and manual handover are blocked", async () => {
    const before = await balance(h.db, item);
    await shopifyHas(order(9201, { lineItems: lines(line(9201, 2)) }));
    const shipment = await readyWaybill(9201);
    expect(await reservedFor(9201)).toBe(2);

    // У Shopify 1 одиницю повернуто/видалено (currentQuantity 1).
    expect((await shopifyHas(order(9201, { minutes: 5, lineItems: lines(line(9201, 2, 1)) }))).result).toBe("conflict_reported");
    const o = await orderRow(9201);
    expect(o.shopifyLinesPendingAt).not.toBeNull();
    expect(await hasPendingShopifyLineChanges(h.db, o.id)).toBe(true);
    expect((await lineRows(9201))[0]).toMatchObject({ quantity: 2, currentQuantity: 2 });
    expect((await openIssues(9201)).find((i) => i.code === "SHOPIFY_ORDER_CHANGED")?.params).toMatchObject({ fields: "lineItems" });

    // Переоформлення не скасовує стару накладну й не створює нову зі старими позиціями.
    const reissue = await reissueWaybill(ctx, shipment.id);
    expect(reissue).toMatchObject({ kind: "not_started", reason: "shopify_lines_pending" });
    expect((await h.db.select().from(shipments).where(eq(shipments.id, shipment.id)))[0]!.status).toBe("created");
    // Ручна передача: менеджер — заборонено; власник без явного підтвердження — теж.
    await expect(markHandedOver({ ...ctx, actor: MANAGER }, shipment.id, { acknowledgeShopifyLineChanges: true })).rejects.toMatchObject({
      code: "shipment.shopifyLinesPending",
    });
    await expect(markHandedOver(ctx, shipment.id)).rejects.toMatchObject({ code: "shipment.shopifyLinesPending" });

    // Скасування накладної → повторне читання замовлення в черзі (у тій самій транзакції).
    const cancelled = await cancelWaybillDetailed(ctx, shipment.id, { purpose: "correction" });
    expect(cancelled.shopifyResync).toBe("queued");
    expect(await createWaybill(ctx, o.id)).toMatchObject({ kind: "blocked", reason: "shopify_lines_pending" });

    // Читання (той самий updatedAt — не «застаріле») застосовує позиції й різницю резерву.
    await runQueuedOrderSync(9201);
    const after = await orderRow(9201);
    expect(after.shopifyLinesPendingAt).toBeNull();
    expect((await lineRows(9201))[0]).toMatchObject({ quantity: 2, currentQuantity: 1 });
    expect(await reservedFor(9201)).toBe(1);
    const [changed] = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED")));
    expect(changed).toMatchObject({ status: "resolved", resolution: "shopify_applied" });
    const history = await h.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, o.id), eq(orderChanges.field, "lineItems")));
    expect(history.map((c) => [c.oldValue, c.newValue])).toEqual([["SKU-1×2", "SKU-1×1"]]);

    // Нова накладна й передача — за актуальною кількістю (списання — currentQuantity).
    await validateOrderById(ctx, o.id, "manual");
    const next = await createWaybill(ctx, o.id);
    expect(next.kind).toBe("created");
    await markHandedOver(ctx, next.kind === "created" ? next.shipment.id : "");
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand - 1, reserved: before.reserved });
  });

  it("the owner may confirm the handover explicitly (stock written off by the packed app lines)", async () => {
    const before = await balance(h.db, item);
    await shopifyHas(order(9202, { lineItems: lines(line(9202, 2)) }));
    const shipment = await readyWaybill(9202);
    await shopifyHas(order(9202, { minutes: 5, lineItems: lines(line(9202, 2, 1)) }));
    await markHandedOver(ctx, shipment.id, { acknowledgeShopifyLineChanges: true });
    expect((await orderRow(9202)).status).toBe("handed_to_carrier");
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand - 2, reserved: before.reserved });
    expect(await hasPendingShopifyLineChanges(h.db, (await orderRow(9202)).id)).toBe(false); // відправлено — блокування не діють
  });

  it("Shopify reverting the change clears the pending state without cancelling the waybill", async () => {
    await shopifyHas(order(9203, { lineItems: lines(line(9203, 3)) }));
    await readyWaybill(9203);
    await shopifyHas(order(9203, { minutes: 5, lineItems: lines(line(9203, 3, 2)) }));
    expect((await orderRow(9203)).shopifyLinesPendingAt).not.toBeNull();
    expect((await shopifyHas(order(9203, { minutes: 6, lineItems: lines(line(9203, 3, 3)) }))).result).toBe("updated");
    expect((await orderRow(9203)).shopifyLinesPendingAt).toBeNull();
    expect((await openIssues(9203)).map((i) => i.code)).not.toContain("SHOPIFY_ORDER_CHANGED");
  });
});

describe("variant deleted in Shopify (regressions-2)", () => {
  it("keeps the local variant link, the reservation and the order state", async () => {
    await shopifyHas(order(9301, { lineItems: lines(line(9301, 1)) }));
    const o = await orderRow(9301);
    await validateOrderById(ctx, o.id, "manual");
    const [before] = await lineRows(9301);
    expect(before!.variantId).not.toBeNull();
    const r = await shopifyHas(order(9301, { minutes: 5, note: "tag", lineItems: lines(line(9301, 1, undefined, { variant: null })) }));
    expect(r.result).toBe("unchanged");
    const [after] = await lineRows(9301);
    expect(after!.variantId).toBe(before!.variantId);
    expect(await reservedFor(9301)).toBe(1);
    expect((await openIssues(9301)).map((i) => i.code)).not.toContain("PRODUCT_NOT_LINKED");
    expect((await orderRow(9301)).status).toBe("awaiting_review");
  });

  it("with an active waybill no SHOPIFY_ORDER_CHANGED is reported", async () => {
    await shopifyHas(order(9302, { lineItems: lines(line(9302, 1)) }));
    await readyWaybill(9302);
    const r = await shopifyHas(order(9302, { minutes: 5, lineItems: lines(line(9302, 1, undefined, { variant: null })) }));
    expect(r.result).toBe("unchanged");
    expect((await openIssues(9302)).map((i) => i.code)).not.toContain("SHOPIFY_ORDER_CHANGED");
    expect((await orderRow(9302)).shopifyLinesPendingAt).toBeNull();
  });
});

describe("orders fulfilled in Shopify outside the app (inventory-3/5, regressions-4, regressions-m2)", () => {
  it("a live order that arrives already (partially) fulfilled is not auto-processed into a waybill (auto mode)", async () => {
    await updateSetting(h.db, OWNER, "automation", { mode: "auto", globalPause: false });
    try {
      for (const [n, status] of [
        [9401, "FULFILLED"],
        [9402, "PARTIALLY_FULFILLED"],
      ] as const) {
        expect((await shopifyHas(order(n, { displayFulfillmentStatus: status, lineItems: lines(line(n, 2)) }))).result).toBe("created");
        const o = await orderRow(n);
        expect(o.status).toBe("paid");
        expect(await h.db.select().from(shipments).where(eq(shipments.orderId, o.id))).toEqual([]);
        expect((await openIssues(n)).map((i) => i.code)).toContain("SHOPIFY_FULFILLED_OUTSIDE_APP");
      }
    } finally {
      await updateSetting(h.db, OWNER, "automation", { mode: "semi", globalPause: false });
    }
  });

  it("manual/bulk waybill creation and reissue are refused for an order fulfilled in Shopify", async () => {
    const o = await orderRow(9402);
    await validateOrderById(ctx, o.id, "manual");
    expect(await createWaybill(ctx, o.id, { source: "manual" })).toMatchObject({ kind: "blocked", reason: "fulfilled_in_shopify" });
    expect(await createWaybill(ctx, o.id, { source: "bulk" })).toMatchObject({ kind: "blocked", reason: "fulfilled_in_shopify" });
  });

  it("'shipped outside the app' writes the reservation off exactly once, without carrier or Shopify fulfillment", async () => {
    const before = await balance(h.db, item);
    await shopifyHas(order(9403, { lineItems: lines(line(9403, 1)) }));
    const o = await orderRow(9403);
    await validateOrderById(ctx, o.id, "manual");
    expect((await balance(h.db, item)).reserved).toBe(before.reserved + 1);
    expect((await shopifyHas(order(9403, { minutes: 5, displayFulfillmentStatus: "FULFILLED", lineItems: lines(line(9403, 1)) }))).result).toBe(
      "conflict_reported",
    );
    // Працівник без керування накладними — заборонено.
    await expect(confirmShippedOutsideApp({ ...ctx, actor: STAFF }, o.id)).rejects.toBeInstanceOf(ForbiddenError);
    const jobsBefore = (await h.db.select().from(jobs).where(eq(jobs.type, JOB.fulfillShipment))).length;
    expect(await confirmShippedOutsideApp({ ...ctx, actor: MANAGER }, o.id)).toMatchObject({ kind: "confirmed" });
    expect((await orderRow(9403)).status).toBe("handed_to_carrier");
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand - 1, reserved: before.reserved });
    const [l] = await lineRows(9403);
    expect(await movementCount(h.db, { key: `consume:${l!.id}` })).toBe(1);
    const [issue] = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.code, "SHOPIFY_FULFILLED_OUTSIDE_APP")));
    expect(issue).toMatchObject({ status: "resolved", resolution: "shipped_outside_app" });
    expect((await h.db.select().from(jobs).where(eq(jobs.type, JOB.fulfillShipment))).length).toBe(jobsBefore);
    // Повтор нічого не змінює.
    expect(await confirmShippedOutsideApp(ctx, o.id)).toEqual({ kind: "already_shipped" });
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand - 1, reserved: before.reserved });
  });

  it("is refused when Shopify does not show the order fulfilled or when an app waybill is active", async () => {
    await shopifyHas(order(9404, { lineItems: lines(line(9404, 1)) }));
    const o = await orderRow(9404);
    await expect(confirmShippedOutsideApp(ctx, o.id)).rejects.toMatchObject({ code: "order.shippedOutside.notFulfilledInShopify" });
    await readyWaybill(9404);
    await shopifyHas(order(9404, { minutes: 5, displayFulfillmentStatus: "FULFILLED", lineItems: lines(line(9404, 1)) }));
    await expect(confirmShippedOutsideApp(ctx, o.id)).rejects.toMatchObject({ code: "order.shippedOutside.activeWaybill" });
  });

  it("a pre-snapshot order first seen fulfilled is neither reserved nor corrected; confirming it does not write off", async () => {
    const before = await balance(h.db, item);
    await shopifyHas(order(9405, { placed: -60, minutes: -50, displayFulfillmentStatus: "FULFILLED", lineItems: lines(line(9405, 2)) }));
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
    // Подальші події цього замовлення теж не резервують його.
    await shopifyHas(order(9405, { placed: -60, minutes: 5, note: "x", displayFulfillmentStatus: "FULFILLED", lineItems: lines(line(9405, 2)) }));
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
    expect(await confirmShippedOutsideApp(ctx, (await orderRow(9405)).id)).toMatchObject({ kind: "confirmed" });
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
  });
});

describe("line items added after the snapshot to an order placed before it (inventory-1)", () => {
  it("a line added by an edit after the snapshot is a new sale: reserve only, no opening_line correction", async () => {
    const before = await balance(h.db, item);
    await shopifyHas(order(9501, { placed: -60, minutes: -59, lineItems: lines(line(9501, 1)) }));
    const afterCreate = await balance(h.db, item);
    expect(afterCreate).toMatchObject({ onHand: before.onHand + 1, reserved: before.reserved + 1 }); // у знімку
    const added = line(9501, 1, 1, { id: "gid://shopify/LineItem/95012" });
    expect((await shopifyHas(order(9501, { placed: -60, minutes: 5, lineItems: lines(line(9501, 1), added) }))).result).toBe("updated");
    const b = await balance(h.db, item);
    expect(b).toMatchObject({ onHand: afterCreate.onHand, reserved: afterCreate.reserved + 1 });
    const newLine = (await lineRows(9501)).find((l) => l.shopifyLineItemId === "gid://shopify/LineItem/95012")!;
    expect(newLine.shopifyAddedAt?.toISOString()).toBe(at(5));
    expect(await movementCount(h.db, { key: `opening_line:${newLine.id}` })).toBe(0);
  });

  it("LineItem.createdAt decides for a pre-snapshot order first seen after the edit", async () => {
    const before = await balance(h.db, item);
    const original = line(9502, 1, 1, { createdAt: at(-60) });
    const added = line(9502, 1, 1, { id: "gid://shopify/LineItem/95022", createdAt: at(10) });
    await shopifyHas(order(9502, { placed: -60, minutes: 11, lineItems: lines(original, added) }));
    // Лише початкова позиція — у знімку (корекція +1); додана після знімка — звичайний продаж.
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand + 1, reserved: before.reserved + 2 });
  });
});

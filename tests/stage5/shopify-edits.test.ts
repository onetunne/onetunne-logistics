import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orderChanges, orderLineItems, orders, productVariants, shipments, stockReservations } from "~/db/schema";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";
import { balance, movementCount, stockItemFor } from "./helpers";

/**
 * Редагування замовлень у Shopify ↔ резерви складу (регресійні тести огляду): зміна лише позицій, currentQuantity
 * (повернені/видалені одиниці), пізні замовлення відносно знімка, виконання поза застосунком.
 */
let h: DatabaseHandle;
let ctx: ServiceContext;
let item: string;
let snapshotAt: Date;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = {
    mode: "production",
    db: h.db,
    actor: OWNER,
    carriers: createDemoCarriers(h.db),
    shopify: new QueueingShopifyGateway(h.db, async () => "ot-test.myshopify.com"),
    now: () => new Date(),
  };
  await upsertProduct(h.db, mapProduct(gqlProduct(1)), "EUR"); // Shopify available 12
  await initializeInventory(ctx);
  const [v] = await h.db.select().from(productVariants);
  snapshotAt = v!.inventorySyncedAt!;
  item = await stockItemFor(h.db, v!.id);
});
afterAll(async () => {
  await h.close();
});

/** Час після знімка Shopify (нове замовлення, якого знімок ще не враховує). */
const after = (minutes: number) => new Date(snapshotAt.getTime() + minutes * 60_000).toISOString();

const line = (n: number, quantity: number, currentQuantity?: number) => ({
  nodes: [{ ...gqlOrder(n).lineItems.nodes[0]!, quantity, ...(currentQuantity === undefined ? {} : { currentQuantity }) }],
});

function order(n: number, over: Partial<GqlOrder> & { minutes?: number } = {}): GqlOrder {
  const { minutes = 1, ...rest } = over;
  return gqlOrder(n, { createdAt: after(minutes), processedAt: after(minutes), updatedAt: after(minutes), ...rest });
}

async function orderRow(n: number) {
  const [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, `gid://shopify/Order/${n}`));
  return o!;
}

async function reservedFor(n: number) {
  const o = await orderRow(n);
  const rows = await h.db.select().from(stockReservations).where(eq(stockReservations.orderId, o.id));
  return rows.reduce((s, r) => s + r.reservedQty, 0);
}

describe("line-item edits in Shopify", () => {
  it("a quantity-only edit (same contacts) adjusts the reservation by the delta and is recorded in the history", async () => {
    const base = await balance(h.db, item);
    await upsertOrder(ctx, mapOrder(order(8001, { lineItems: line(8001, 3) })), "live");
    expect((await balance(h.db, item)).reserved).toBe(base.reserved + 3);
    const up = await upsertOrder(ctx, mapOrder(order(8001, { minutes: 2, lineItems: line(8001, 5) })), "live");
    expect(up.result).toBe("updated");
    expect(await reservedFor(8001)).toBe(5);
    const down = await upsertOrder(ctx, mapOrder(order(8001, { minutes: 3, lineItems: line(8001, 1) })), "live");
    expect(down.result).toBe("updated");
    expect(await reservedFor(8001)).toBe(1);
    expect((await balance(h.db, item)).reserved).toBe(base.reserved + 1);
    expect((await balance(h.db, item)).onHand).toBe(base.onHand); // новий продаж після знімка — без корекції
    const o = await orderRow(8001);
    const history = await h.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, o.id), eq(orderChanges.field, "lineItems")));
    expect(history.map((c) => [c.oldValue, c.newValue])).toEqual([
      ["SKU-1×3", "SKU-1×5"],
      ["SKU-1×5", "SKU-1×1"],
    ]);
    // Та сама подія ще раз — без змін.
    expect((await upsertOrder(ctx, mapOrder(order(8001, { minutes: 3, lineItems: line(8001, 1) })), "live")).result).toBe("unchanged");
  });

  it("with an active waybill the line change is reported (SHOPIFY_ORDER_CHANGED · lineItems), not applied", async () => {
    await upsertOrder(ctx, mapOrder(order(8002, { lineItems: line(8002, 2) })), "live");
    const o = await orderRow(8002);
    await h.db.update(orders).set({ status: "waybill_created" }).where(eq(orders.id, o.id));
    await h.db.insert(shipments).values({
      orderId: o.id,
      carrierCode: "sandbox",
      mode: "test",
      status: "created",
      carrierReference: `OT-T-${o.id.slice(0, 8)}`,
      createdBy: "test",
    });
    const r = await upsertOrder(ctx, mapOrder(order(8002, { minutes: 2, lineItems: line(8002, 4) })), "live");
    expect(r.result).toBe("conflict_reported");
    const [issue] = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED")));
    expect(issue!.params).toMatchObject({ fields: "lineItems" });
    const [l] = await h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id));
    expect(l!.quantity).toBe(2);
    expect(await reservedFor(8002)).toBe(2);
  });
});

describe("currentQuantity (refunded/removed units)", () => {
  it("reserves currentQuantity, not the ordered quantity; a full refund releases the reservation", async () => {
    await upsertOrder(ctx, mapOrder(order(8003, { lineItems: line(8003, 3, 2) })), "live");
    const o = await orderRow(8003);
    const [l] = await h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id));
    expect(l).toMatchObject({ quantity: 3, currentQuantity: 2 });
    expect(await reservedFor(8003)).toBe(2);
    // Повне повернення до відправлення (замовлення не скасоване): currentQuantity 0 → резерв знято.
    const r = await upsertOrder(ctx, mapOrder(order(8003, { minutes: 2, displayFinancialStatus: "REFUNDED", lineItems: line(8003, 3, 0) })), "live");
    expect(r.result).toBe("updated");
    expect(await reservedFor(8003)).toBe(0);
  });
});

describe("orders relative to the Shopify snapshot", () => {
  it("an order created before the snapshot but imported later is not subtracted twice (on_hand corrected once)", async () => {
    const before = await balance(h.db, item);
    const placed = new Date(snapshotAt.getTime() - 3600_000).toISOString();
    const m = mapOrder(gqlOrder(6100, { createdAt: placed, processedAt: placed, updatedAt: placed, lineItems: line(6100, 2) }));
    expect((await upsertOrder(ctx, m, "import")).result).toBe("created");
    const afterImport = await balance(h.db, item);
    // Shopify «доступно» знімка вже не містило цих 2 одиниць → доступно застосунку не змінюється.
    expect(afterImport.onHand - afterImport.reserved).toBe(before.onHand - before.reserved);
    expect(afterImport).toMatchObject({ onHand: before.onHand + 2, reserved: before.reserved + 2 });
    const o = await orderRow(6100);
    const [l] = await h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, o.id));
    expect(await movementCount(h.db, { key: `opening_line:${l!.id}` })).toBe(1);
    await upsertOrder(ctx, m, "import");
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand + 2, reserved: before.reserved + 2 });
  });

  it("an order created after the snapshot reduces 'available' (normal sale)", async () => {
    const before = await balance(h.db, item);
    await upsertOrder(ctx, mapOrder(order(8004, { lineItems: line(8004, 1) })), "live");
    const b = await balance(h.db, item);
    expect(b).toMatchObject({ onHand: before.onHand, reserved: before.reserved + 1 });
  });

  it("first seen already fulfilled: before the snapshot → not written off; after → written off once", async () => {
    const before = await balance(h.db, item);
    const placed = new Date(snapshotAt.getTime() - 3600_000).toISOString();
    await upsertOrder(
      ctx,
      mapOrder(gqlOrder(6101, { createdAt: placed, processedAt: placed, updatedAt: placed, displayFulfillmentStatus: "FULFILLED", lineItems: line(6101, 2) })),
      "import",
    );
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
    await upsertOrder(ctx, mapOrder(order(8005, { displayFulfillmentStatus: "FULFILLED", lineItems: line(8005, 2) })), "import");
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand - 2, reserved: before.reserved });
    expect((await orderRow(8005)).status).toBe("handed_to_carrier");
  });
});

describe("fulfilled in Shopify outside the app", () => {
  it("opens SHOPIFY_FULFILLED_OUTSIDE_APP once and keeps the reservation for the manager's decision", async () => {
    await upsertOrder(ctx, mapOrder(order(8006, { lineItems: line(8006, 2) })), "live");
    const r = await upsertOrder(ctx, mapOrder(order(8006, { minutes: 2, displayFulfillmentStatus: "FULFILLED", lineItems: line(8006, 2) })), "live");
    expect(r.result).toBe("conflict_reported");
    const o = await orderRow(8006);
    const found = await h.db.select().from(issues).where(and(eq(issues.orderId, o.id), eq(issues.code, "SHOPIFY_FULFILLED_OUTSIDE_APP")));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: "warning", status: "open" });
    expect(await reservedFor(8006)).toBe(2);
    // Повтор тієї самої події не дублює проблему.
    expect((await upsertOrder(ctx, mapOrder(order(8006, { minutes: 2, displayFulfillmentStatus: "FULFILLED", lineItems: line(8006, 2) })), "live")).result).toBe(
      "unchanged",
    );
  });
});

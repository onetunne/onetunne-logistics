import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { issues, orderLineItems, orders, productVariants, stockReservations } from "~/db/schema";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
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
 * Синхронізація замовлень Shopify ↔ резерви складу: повторні/оновлені події не дублюють резерв,
 * id позицій стабільні, скасування знімає резерв, історичні виконані замовлення не списуються.
 */
let h: DatabaseHandle;
let ctx: ServiceContext;
let variantId: string;
let item: string;

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
  await upsertProduct(h.db, mapProduct(gqlProduct(1)), "EUR"); // inventoryQuantity 12
  [{ id: variantId }] = (await h.db.select({ id: productVariants.id }).from(productVariants)) as [{ id: string }];
});
afterAll(async () => {
  await h.close();
});

const twoLines = (n: number, q1: number, q2?: number) => ({
  nodes: [
    { ...gqlOrder(n).lineItems.nodes[0]!, id: `gid://shopify/LineItem/${n}1`, quantity: q1 },
    ...(q2 === undefined ? [] : [{ ...gqlOrder(n).lineItems.nodes[0]!, id: `gid://shopify/LineItem/${n}2`, quantity: q2 }]),
  ],
});

describe("before initialization", () => {
  it("orders sync without reservations", async () => {
    const r = await upsertOrder(ctx, mapOrder(gqlOrder(7001, { lineItems: twoLines(7001, 2) })), "live");
    expect(r.result).toBe("created");
    expect(await h.db.select().from(stockReservations)).toEqual([]);
  });

  it("initialization opens on_hand = Shopify available + open orders and reserves them", async () => {
    const res = await initializeInventory(ctx);
    expect(res).toMatchObject({ alreadyInitialized: false, opened: 1, ordersSynced: 1 });
    item = await stockItemFor(h.db, variantId);
    expect(await balance(h.db, item)).toMatchObject({ onHand: 14, reserved: 2 }); // 12 + 2 → доступно 12
  });
});

describe("after initialization", () => {
  it("a new paid order reserves; the same event replayed does not double", async () => {
    const m = mapOrder(gqlOrder(7002, { lineItems: twoLines(7002, 1, 3) }));
    await upsertOrder(ctx, m, "live");
    await upsertOrder(ctx, m, "live");
    await upsertOrder(ctx, { ...m, shopifyUpdatedAt: new Date("2026-11-20T10:05:00Z") }, "live");
    expect((await balance(h.db, item)).reserved).toBe(2 + 4);
    expect(await movementCount(h.db, { type: "reserve" })).toBe(3);
  });

  it("an update keeps line item ids, adjusts changed quantities by delta and releases removed lines", async () => {
    const [order] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, "gid://shopify/Order/7002"));
    const before = await h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, order!.id));
    // Оновлення з Shopify: інша адреса (контакти редагуються) + кількість першої позиції 1 → 2, друга позиція видалена.
    const changed = mapOrder(
      gqlOrder(7002, {
        updatedAt: "2026-11-21T10:00:00Z",
        shippingAddress: { ...gqlOrder(7002).shippingAddress!, address1: "Beispielweg 2" },
        lineItems: twoLines(7002, 2),
      }),
    );
    expect((await upsertOrder(ctx, changed, "live")).result).toBe("updated");
    const after = await h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, order!.id));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before.find((l) => l.shopifyLineItemId === "gid://shopify/LineItem/70021")!.id);
    expect(after[0]!.quantity).toBe(2);
    expect((await balance(h.db, item)).reserved).toBe(2 + 2);
    const rows = await h.db.select().from(stockReservations).where(eq(stockReservations.orderId, order!.id));
    expect(rows.map((r) => [r.reservedQty, r.status]).sort()).toEqual([
      [0, "released"],
      [2, "reserved"],
    ]);
    // Той самий апдейт ще раз — без змін.
    await upsertOrder(ctx, changed, "live");
    expect((await balance(h.db, item)).reserved).toBe(4);
  });

  it("cancellation in Shopify releases the reservation", async () => {
    const cancelled = mapOrder(gqlOrder(7002, { updatedAt: "2026-11-22T10:00:00Z", cancelledAt: "2026-11-22T10:00:00Z", lineItems: twoLines(7002, 2) }));
    const r = await upsertOrder(ctx, cancelled, "live");
    expect(r.result).toBe("cancelled");
    expect((await balance(h.db, item)).reserved).toBe(2);
    const [order] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, "gid://shopify/Order/7002"));
    expect(order!.status).toBe("cancelled");
    expect(await h.db.select().from(issues).where(eq(issues.code, "SHOPIFY_CANCELLED_AFTER_SHIPMENT"))).toEqual([]);
  });

  it("historical fulfilled orders imported later are not written off (already in the Shopify snapshot)", async () => {
    const before = await balance(h.db, item);
    const r = await upsertOrder(ctx, mapOrder(gqlOrder(6001, { displayFulfillmentStatus: "FULFILLED", lineItems: twoLines(6001, 5) })), "import");
    expect(r.result).toBe("created");
    const [order] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, "gid://shopify/Order/6001"));
    expect(order!.status).toBe("handed_to_carrier");
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
    expect(await h.db.select().from(stockReservations).where(eq(stockReservations.orderId, order!.id))).toEqual([]);
  });

  it("product sync does not overwrite internal balances (Shopify quantity is only a snapshot)", async () => {
    const before = await balance(h.db, item);
    await upsertProduct(
      h.db,
      mapProduct(gqlProduct(1, { updatedAt: "2026-11-25T10:00:00Z", variants: { nodes: [{ ...gqlProduct(1).variants.nodes[0]!, inventoryQuantity: 99 }] } })),
      "EUR",
    );
    expect(await balance(h.db, item)).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
    const [v] = await h.db.select().from(productVariants).where(eq(productVariants.id, variantId));
    expect(v!.inventoryAvailable).toBe(99);
  });
});

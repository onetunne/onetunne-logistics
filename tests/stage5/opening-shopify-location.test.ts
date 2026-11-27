import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  inventoryBalances,
  jobs,
  orderChanges,
  orderLineItems,
  orders,
  productVariants,
  shopInstallations,
  stockReservations,
  warehouses,
} from "~/db/schema";
import type { DatabaseHandle, Db } from "~/db/client.server";
import { MIGRATIONS_FOLDER } from "~/db/migrate.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { isOrderFulfilledInShopify } from "~/domain/order-status";
import { ForbiddenError } from "~/domain/permissions";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { openInventory, variantsOnUnsettledOrders } from "~/modules/inventory/opening.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { cancelWaybillDetailed, createWaybill } from "~/modules/shipments/waybill.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { initializeInventoryFromShopify } from "~/modules/shopify-sync/inventory-opening.server";
import { JOB } from "~/modules/shopify-sync/jobs";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { syncProduct, upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { fakeAdmin, gqlOrder, gqlProduct } from "../stage2/fixtures";
import { OWNER, STAFF, openTestDatabase } from "../helpers";
import { balance } from "./helpers";
import { LOC, LOC2, fakeInventoryAdmin, location } from "./inventory-sync-fixtures";

/**
 * Відкриття обліку в робочому режимі (G1a: inventory-4/8/9/m1, shopify-7, regressions-m1, gap-14): знімок «доступно» у
 * ЛОКАЦІЇ складу (не сума по локаціях), час знімка — до запиту, перечитування позицій до етапу 5, виключення
 * виконаних у Shopify замовлень, автоматичне відкриття нових варіантів. Admin API — імітація.
 */
const SHOP = "ot-test.myshopify.com";
let h: DatabaseHandle;
let ctx: ServiceContext;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct> };
let inv: ReturnType<typeof fakeInventoryAdmin>;
let admin: AdminGraphql;
const failingOrders = new Set<string>();
const levelCalls: Date[] = [];

const variant2 = (inventoryItem: string, sku: string, id: string) => ({
  ...gqlProduct(1).variants.nodes[0]!,
  id,
  sku,
  title: sku,
  inventoryItem: { ...gqlProduct(1).variants.nodes[0]!.inventoryItem!, id: inventoryItem },
});

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
  store = { orders: new Map(), products: new Map() };
  const base = fakeAdmin(store);
  inv = fakeInventoryAdmin();
  admin = (async (query: string, variables?: Record<string, unknown>) => {
    const op = /(query|mutation)\s+(\w+)/.exec(query)?.[2];
    if (op === "OtInventoryLevels") levelCalls.push(new Date());
    if (op === "OtLocations" || op === "OtInventoryLevels") return inv.admin(query, variables);
    if (op === "OtOrder" && failingOrders.has(String(variables?.id))) throw new Error("fetch failed: ECONNRESET");
    return base.admin(query, variables);
  }) as AdminGraphql;
  // Shopify: варіант 101 — 15 «доступно» по ВСІХ локаціях, з них 10 — у локації складу.
  store.products.set("gid://shopify/Product/1", gqlProduct(1, { variants: { nodes: [{ ...gqlProduct(1).variants.nodes[0]!, inventoryQuantity: 15 }] } }));
  await syncProduct(h.db, admin, "gid://shopify/Product/1", "EUR");
  inv.setLevel("gid://shopify/InventoryItem/101", { available: 10, onHand: 13, committed: 3 });
});
afterAll(async () => {
  await h.close();
});

const gid = (n: number) => `gid://shopify/Order/${n}`;
const line = (n: number, quantity: number, currentQuantity?: number) => ({
  nodes: [{ ...gqlOrder(n).lineItems.nodes[0]!, quantity, ...(currentQuantity === undefined ? {} : { currentQuantity }) }],
});
async function shopifyHas(o: GqlOrder, mode: "live" | "import" = "live") {
  store.orders.set(o.id, o);
  return upsertOrder(ctx, mapOrder(o), mode);
}
async function orderId(n: number) {
  const [o] = await h.db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyOrderId, gid(n)));
  return o!.id;
}
async function linesOf(n: number) {
  return h.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, await orderId(n)));
}
async function reserved(n: number) {
  const rows = await h.db.select().from(stockReservations).where(eq(stockReservations.orderId, await orderId(n)));
  return rows.reduce((s, r) => s + r.reservedQty, 0);
}
async function item101() {
  const [v] = await h.db.select().from(productVariants).where(eq(productVariants.shopifyVariantId, "gid://shopify/ProductVariant/101"));
  return ensureStockItemForVariant(h.db, v!.id);
}

describe("snapshot time is taken before the Shopify read (inventory-8)", () => {
  it("upsertProduct stores the explicit fetch time; syncProduct takes it before the request", async () => {
    const fetchedAt = new Date(Date.now() - 3_600_000);
    await upsertProduct(h.db, mapProduct(store.products.get("gid://shopify/Product/1")!), "EUR", fetchedAt);
    const [v] = await h.db.select().from(productVariants).where(eq(productVariants.shopifyVariantId, "gid://shopify/ProductVariant/101"));
    expect(v!.inventorySyncedAt?.toISOString()).toBe(fetchedAt.toISOString());
    let calledAt: Date | null = null;
    const timed = (async (query: string, variables?: Record<string, unknown>) => {
      calledAt = new Date();
      await new Promise((r) => setTimeout(r, 20));
      return admin(query, variables);
    }) as AdminGraphql;
    await syncProduct(h.db, timed, "gid://shopify/Product/1", "EUR");
    const [after] = await h.db.select().from(productVariants).where(eq(productVariants.shopifyVariantId, "gid://shopify/ProductVariant/101"));
    expect(after!.inventorySyncedAt!.getTime()).toBeLessThanOrEqual(calledAt!.getTime());
  });
});

describe("production opening from the warehouse location (inventory-4, shopify-7, inventory-9, inventory-m1, regressions-m1)", () => {
  it("staff cannot open; several locations without a choice → nothing is opened", async () => {
    await expect(initializeInventoryFromShopify({ ...ctx, actor: STAFF }, admin)).rejects.toBeInstanceOf(ForbiddenError);
    inv.locations.push(location(LOC2, "Showroom"));
    const r = await initializeInventoryFromShopify(ctx, admin);
    expect(r).toEqual({ kind: "location_required", state: "ambiguous" });
    expect((await getDefaultWarehouse(h.db)).inventoryInitializedAt).toBeNull();
    inv.locations.pop();
  });

  it("orders saved before stage 5 (current_quantity NULL) are re-read first; a failed re-read postpones opening", async () => {
    // Замовлення до етапу 5: позиції без current_quantity. 7101 — у Shopify 2 з 3 одиниць повернуто; 7102 — без змін.
    await shopifyHas(gqlOrder(7101, { lineItems: line(7101, 3) }));
    await shopifyHas(gqlOrder(7102, { lineItems: line(7102, 1) }));
    await h.db.update(orderLineItems).set({ currentQuantity: null }).where(sql`${orderLineItems.orderId} in (${await orderId(7101)}, ${await orderId(7102)})`);
    store.orders.set(gid(7101), gqlOrder(7101, { updatedAt: "2026-11-20T10:00:00Z", lineItems: line(7101, 3, 1) }));
    failingOrders.add(gid(7102));
    const r = await initializeInventoryFromShopify(ctx, admin);
    expect(r).toMatchObject({ kind: "orders_not_ready", failedOrders: 1, staleOrders: 1, pendingOrders: 0 });
    expect((await getDefaultWarehouse(h.db)).inventoryInitializedAt).toBeNull();
    expect((await linesOf(7101))[0]).toMatchObject({ quantity: 3, currentQuantity: 1 });
    failingOrders.clear();
  });

  it("an order with unapplied Shopify line changes postpones opening", async () => {
    await shopifyHas(gqlOrder(7103, { lineItems: line(7103, 1) }));
    await h.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, await orderId(7103)));
    const r = await initializeInventoryFromShopify(ctx, admin);
    expect(r).toMatchObject({ kind: "orders_not_ready", staleOrders: 0, pendingOrders: 1 });
    await h.db.update(orders).set({ shopifyLinesPendingAt: null }).where(eq(orders.id, await orderId(7103)));
  });

  it("opens S from the location level (not the all-locations total), excluding orders fulfilled in Shopify", async () => {
    // До знімка: виконане поза застосунком (live), частково виконане (імпорт) — не враховуються й не резервуються.
    await shopifyHas(gqlOrder(7104, { displayFulfillmentStatus: "FULFILLED", lineItems: line(7104, 1) }));
    await shopifyHas(gqlOrder(7105, { displayFulfillmentStatus: "PARTIALLY_FULFILLED", lineItems: line(7105, 2) }), "import");
    const startedAt = new Date();
    const r = await initializeInventoryFromShopify(ctx, admin);
    expect(r.kind).toBe("opened");
    if (r.kind !== "opened") return;
    expect(r.result).toMatchObject({ opened: 1, excludedFulfilledLines: 2, skippedNotStocked: 0 });
    // 7101 (1 після повернення) + 7102 (1) + 7103 (1) відкриті оплачені до знімка → on_hand = 10 + 3, резерв 3.
    const b = await balance(h.db, await item101());
    expect(b).toMatchObject({ onHand: 13, reserved: 3 });
    expect(b.onHand - b.reserved).toBe(10);
    expect(await reserved(7101)).toBe(1);
    expect(await reserved(7104)).toBe(0);
    expect(await reserved(7105)).toBe(0);
    // Тихе заповнення current_quantity без історії (кількість не змінилася).
    expect((await linesOf(7102))[0]!.currentQuantity).toBe(1);
    expect(await h.db.select().from(orderChanges).where(eq(orderChanges.orderId, await orderId(7102)))).toEqual([]);
    // Час знімка — до запиту рівнів.
    const [bal] = await h.db.select().from(inventoryBalances).where(eq(inventoryBalances.stockItemId, await item101()));
    expect(bal!.openingSnapshotAt!.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(bal!.openingSnapshotAt!.getTime()).toBeLessThanOrEqual(levelCalls.at(-1)!.getTime());
    expect((await h.db.select().from(warehouses))[0]!.shopifyLocationId).toBe(LOC);
  });

  it("a later sync of the excluded pre-snapshot fulfilled order still does not reserve it", async () => {
    const before = await balance(h.db, await item101());
    await shopifyHas(gqlOrder(7104, { updatedAt: "2026-11-21T10:00:00Z", note: "n", displayFulfillmentStatus: "FULFILLED", lineItems: line(7104, 1) }));
    expect(await balance(h.db, await item101())).toMatchObject({ onHand: before.onHand, reserved: before.reserved });
  });
});

describe("variants added after initialization are opened automatically (gap-14)", () => {
  it("product sync opens a new tracked variant from the location level; a variant not stocked there stays closed", async () => {
    inv.setLevel("gid://shopify/InventoryItem/102", { available: 4, onHand: 4, committed: 0 });
    inv.setLevel("gid://shopify/InventoryItem/103", { available: 0, onHand: 0, committed: 0, stocked: false });
    store.products.set(
      "gid://shopify/Product/1",
      gqlProduct(1, {
        updatedAt: "2026-11-25T10:00:00Z",
        variants: {
          nodes: [
            { ...gqlProduct(1).variants.nodes[0]!, inventoryQuantity: 15 },
            variant2("gid://shopify/InventoryItem/102", "SKU-1-RED", "gid://shopify/ProductVariant/102"),
            variant2("gid://shopify/InventoryItem/103", "SKU-1-BLU", "gid://shopify/ProductVariant/103"),
          ],
        },
      }),
    );
    const handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => admin });
    const [job] = await h.db
      .insert(jobs)
      .values({ type: JOB.syncProduct, payload: { shop: SHOP, productGid: "gid://shopify/Product/1" } })
      .returning();
    await handlers[JOB.syncProduct]!.run(job!);
    const variantId = async (sku: string) =>
      (await h.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku)))[0]!.id;
    const red = await ensureStockItemForVariant(h.db, await variantId("SKU-1-RED"));
    const blue = await ensureStockItemForVariant(h.db, await variantId("SKU-1-BLU"));
    const w = await getDefaultWarehouse(h.db);
    const [redBal] = await h.db.select().from(inventoryBalances).where(and(eq(inventoryBalances.stockItemId, red), eq(inventoryBalances.warehouseId, w.id)));
    expect(redBal).toMatchObject({ onHand: 4, reserved: 0 });
    expect(redBal!.openedAt).not.toBeNull();
    const [blueBal] = await h.db.select().from(inventoryBalances).where(eq(inventoryBalances.stockItemId, blue));
    expect(blueBal?.openedAt ?? null).toBeNull();
    // Повторна синхронізація не змінює вже відкритого.
    await handlers[JOB.syncProduct]!.run(job!);
    expect((await balance(h.db, red)).onHand).toBe(4);
  });
});

describe("auto-open waits for orders whose Shopify items are not applied yet (G1a-NEW-2)", () => {
  it("a variant on an order with pending Shopify line changes stays unopened; after the re-read it opens with Shopify's available", async () => {
    const handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => admin });
    const productWith104 = (updatedAt: string) =>
      gqlProduct(1, {
        updatedAt,
        variants: {
          nodes: [
            { ...gqlProduct(1).variants.nodes[0]!, inventoryQuantity: 15 },
            variant2("gid://shopify/InventoryItem/102", "SKU-1-RED", "gid://shopify/ProductVariant/102"),
            variant2("gid://shopify/InventoryItem/103", "SKU-1-BLU", "gid://shopify/ProductVariant/103"),
            variant2("gid://shopify/InventoryItem/104", "SKU-1-GRN", "gid://shopify/ProductVariant/104"),
          ],
        },
      });
    const syncProductJob = async (updatedAt: string) => {
      store.products.set("gid://shopify/Product/1", productWith104(updatedAt));
      const [job] = await h.db
        .insert(jobs)
        .values({ type: JOB.syncProduct, payload: { shop: SHOP, productGid: "gid://shopify/Product/1" } })
        .returning();
      await handlers[JOB.syncProduct]!.run(job!);
    };
    // 104 ще не зберігається в локації складу → лишається невідкритим.
    inv.setLevel("gid://shopify/InventoryItem/104", { available: 0, onHand: 0, committed: 0, stocked: false });
    await syncProductJob("2026-11-26T10:00:00Z");
    const [v104] = await h.db.select().from(productVariants).where(eq(productVariants.shopifyVariantId, "gid://shopify/ProductVariant/104"));
    const item = await ensureStockItemForVariant(h.db, v104!.id);
    const openedAt = async () => (await h.db.select().from(inventoryBalances).where(eq(inventoryBalances.stockItemId, item)))[0]?.openedAt ?? null;
    expect(await openedAt()).toBeNull();

    // Замовлення (до знімка) на 2 шт. 104 отримує накладну; у Shopify 1 одиницю повернуто й поповнено → позначка.
    const greenLine = (quantity: number, currentQuantity?: number) => ({
      nodes: [
        {
          ...gqlOrder(7201).lineItems.nodes[0]!,
          sku: "SKU-1-GRN",
          quantity,
          ...(currentQuantity === undefined ? {} : { currentQuantity }),
          variant: { id: "gid://shopify/ProductVariant/104", product: { id: "gid://shopify/Product/1" } },
        },
      ],
    });
    await shopifyHas(gqlOrder(7201, { lineItems: greenLine(2) }));
    const id = await orderId(7201);
    await validateOrderById(ctx, id, "manual");
    const created = await createWaybill(ctx, id);
    expect(created.kind).toBe("created");
    expect((await shopifyHas(gqlOrder(7201, { updatedAt: "2026-11-20T11:00:00Z", lineItems: greenLine(2, 1) }))).result).toBe("conflict_reported");
    expect((await h.db.select().from(orders).where(eq(orders.id, id)))[0]!.shopifyLinesPendingAt).not.toBeNull();

    // Локація починає зберігати 104: on_hand 6, закріплено 1, доступно 5. Синхронізація товару НЕ відкриває 104.
    inv.setLevel("gid://shopify/InventoryItem/104", { available: 5, onHand: 6, committed: 1, stocked: true });
    await syncProductJob("2026-11-26T11:00:00Z");
    expect(await openedAt()).toBeNull();
    const deferred = await openInventory({ db: h.db, actor: OWNER, now: () => new Date() }, {
      snapshot: { kind: "location", locationId: LOC, levels: new Map([[v104!.id, { available: 5, snapshotAt: new Date() }]]), notStocked: 0 },
      onlyIfInitialized: true,
      deferUnsettledOrders: true,
    });
    expect(deferred).toMatchObject({ opened: 0, deferredUnsettledVariants: 1 });
    expect(await openedAt()).toBeNull();

    // Скасування накладної → повторне читання застосовує позиції (1 шт.) і знімає позначку.
    expect((await cancelWaybillDetailed(ctx, created.kind === "created" ? created.shipment.id : "", { purpose: "correction" })).shopifyResync).toBe("queued");
    const [sync] = await h.db.select().from(jobs).where(and(eq(jobs.type, JOB.syncOrder), eq(jobs.dedupeKey, `order:${gid(7201)}`), eq(jobs.status, "queued")));
    await handlers[JOB.syncOrder]!.run(sync!);
    await h.db.update(jobs).set({ status: "succeeded" }).where(eq(jobs.id, sync!.id));
    expect((await h.db.select().from(orders).where(eq(orders.id, id)))[0]!.shopifyLinesPendingAt).toBeNull();

    // Наступна синхронізація товару відкриває 104: on_hand = 5 + 1, резерв 1 → доступно = 5, як у Shopify.
    await syncProductJob("2026-11-26T12:00:00Z");
    expect(await openedAt()).not.toBeNull();
    const b = await balance(h.db, item);
    expect(b).toMatchObject({ onHand: 6, reserved: 1 });
    expect(b.onHand - b.reserved).toBe(5);
    expect(await reserved(7201)).toBe(1);
  });

  it("variants on orders with items saved before stage 5 (current_quantity NULL) are deferred too", async () => {
    await shopifyHas(gqlOrder(7202, { lineItems: line(7202, 1) }));
    const [v101] = await h.db.select().from(productVariants).where(eq(productVariants.shopifyVariantId, "gid://shopify/ProductVariant/101"));
    expect(await variantsOnUnsettledOrders(h.db, [v101!.id])).toEqual(new Set());
    await h.db.update(orderLineItems).set({ currentQuantity: null }).where(eq(orderLineItems.orderId, await orderId(7202)));
    expect(await variantsOnUnsettledOrders(h.db, [v101!.id])).toEqual(new Set([v101!.id]));
    await h.db.update(orderLineItems).set({ currentQuantity: 1 }).where(eq(orderLineItems.orderId, await orderId(7202)));
  });
});

describe("migration 0006 on a database with stage-5 data", () => {
  it("adds the new columns without touching existing rows", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig6-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const target = journal.entries.find((e) => e.tag.includes("order_sync_pending_lines"));
    expect(target).toBeDefined();
    const previous = { ...journal, entries: journal.entries.filter((e) => e.idx < target!.idx) };
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(previous));
    for (const e of previous.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    const raw = await openRaw();
    try {
      await raw.migrate(dir);
      await raw.db.execute(sql`insert into orders (source, order_number, currency, subtotal, total) values ('demo', '#M-1', 'EUR', '1.00', '1.00')`);
      await raw.db.execute(sql`insert into order_line_items (order_id, title, quantity, unit_price, currency)
        select id, 'Item', 2, '1.00', 'EUR' from orders where order_number = '#M-1'`);
      await raw.migrate(MIGRATIONS_FOLDER);
      const [o] = await raw.db.select().from(orders);
      const [l] = await raw.db.select().from(orderLineItems);
      expect(o).toMatchObject({ orderNumber: "#M-1", shopifyLinesPendingAt: null });
      expect(l).toMatchObject({ quantity: 2, currentQuantity: null, shopifyAddedAt: null });
    } finally {
      await raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("migration 0008 (orders.shopify_shippable_fulfilled) on a database with data", () => {
  it("adds the nullable column; existing partially fulfilled orders stay conservatively blocked (null)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig8-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const target = journal.entries.find((e) => e.tag.includes("order_shippable_fulfilled"));
    expect(target).toBeDefined();
    const previous = { ...journal, entries: journal.entries.filter((e) => e.idx < target!.idx) };
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(previous));
    for (const e of previous.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    const raw = await openRaw();
    try {
      await raw.migrate(dir);
      await raw.db.execute(sql`insert into orders (source, order_number, currency, subtotal, total, fulfillment_status, shopify_lines_pending_at)
        values ('shopify', '#M-8', 'EUR', '1.00', '1.00', 'partially_fulfilled', now())`);
      await raw.migrate(MIGRATIONS_FOLDER);
      const [o] = await raw.db.select().from(orders);
      expect(o).toMatchObject({ orderNumber: "#M-8", fulfillmentStatus: "partially_fulfilled", shopifyShippableFulfilled: null });
      expect(o!.shopifyLinesPendingAt).not.toBeNull();
      expect(isOrderFulfilledInShopify(o!)).toBe(true);
    } finally {
      await raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** База без міграцій (PGlite у пам'яті або тимчасова база PostgreSQL з TEST_DATABASE_URL). */
async function openRaw(): Promise<{ db: Db; migrate: (folder: string) => Promise<void>; close: () => Promise<void> }> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    const db = drizzle(client) as unknown as Db;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { db, migrate: (folder) => migrate(db as any, { migrationsFolder: folder }), close: () => client.close() };
  }
  const { Client, Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const name = `ot_mig6_${process.pid}_${Date.now()}`;
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 2 });
  const db = drizzle(pool) as unknown as Db;
  return {
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrate: (folder) => migrate(db as any, { migrationsFolder: folder }),
    close: async () => {
      await pool.end();
      const d = new Client({ connectionString: adminUrl });
      await d.connect();
      await d.query(`drop database if exists ${name}`);
      await d.end();
    },
  };
}

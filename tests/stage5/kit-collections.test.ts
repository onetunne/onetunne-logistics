import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseHandle, Db } from "~/db/client.server";
import { MIGRATIONS_FOLDER } from "~/db/migrate.server";
import {
  collections,
  jobs,
  kitTemplates,
  orderLineItems,
  orders,
  productCollections,
  productVariants,
  products,
  shopInstallations,
} from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createKitTemplate, getKitTemplate, resolveKitMaterials } from "~/modules/packaging/kits.server";
import { createMaterial } from "~/modules/packaging/materials.server";
import { applyProductCollections, startCollectionsSync, upsertCollections } from "~/modules/shopify-sync/collections.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { JOB } from "~/modules/shopify-sync/jobs";
import { recordInstallation } from "~/modules/shopify-sync/sync.server";
import { WEBHOOK_TOPICS, handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { fakeAdmin, gqlCollection, gqlProduct, type FakeCollection } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";

/**
 * Етап 5 (gap-4): шаблони комплектації «на колекцію» з членством із Shopify. Новий товар колекції охоплюється
 * автоматично; автоматичні колекції — через products/update (collections/update тоді не приходить); ручні зміни
 * колекції — через collections/update; видалення — позначка, а не мовчазна зміна цілі шаблону.
 */
const SHOP = "ot-kits.myshopify.com";
const P = (n: number) => `gid://shopify/Product/${n}`;
const C = (n: number) => `gid://shopify/Collection/${n}`;
let h: DatabaseHandle;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct>; collections: Map<string, FakeCollection> };
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let handlers: ReturnType<typeof createSyncHandlers>;
let bolts: string;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map(), collections: new Map() };
  fake = fakeAdmin(store);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new QueueingShopifyGateway(h.db, async () => SHOP), now: () => new Date() };
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
  bolts = (await createMaterial(ctx, { code: "bolts_m6", name: "Болти M6", kind: "bolt", unit: "pcs", active: true })).id;
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  fake.calls.length = 0;
});

const run = () => runJobsOnce(h.db, handlers, { limit: 200 });
let hook = 0;
const webhook = (topic: string, payload: Record<string, unknown>) => handleShopifyWebhook(h.db, { topic, shop: SHOP, webhookId: `wh-kit-${++hook}`, payload });
const ops = (op: string) => fake.calls.filter((c) => c.op === op);

async function localProduct(gid: string) {
  const [p] = await h.db.select().from(products).where(eq(products.shopifyProductId, gid));
  return p!;
}
async function localCollection(gid: string) {
  const [c] = await h.db.select().from(collections).where(eq(collections.shopifyCollectionId, gid));
  return c!;
}
async function membership(productGid: string): Promise<string[]> {
  const rows = await h.db
    .select({ gid: collections.shopifyCollectionId })
    .from(productCollections)
    .innerJoin(collections, eq(collections.id, productCollections.collectionId))
    .innerJoin(products, eq(products.id, productCollections.productId))
    .where(eq(products.shopifyProductId, productGid));
  return rows.map((r) => r.gid!).sort();
}
async function deadJobs() {
  return h.db.select().from(jobs).where(eq(jobs.status, "dead"));
}
/** Замовлення з однією позицією товару (перший варіант) — для розрахунку комплектації. */
async function orderWith(productGid: string, quantity: number): Promise<string> {
  const [variant] = await h.db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(products.shopifyProductId, productGid));
  const [o] = await h.db
    .insert(orders)
    .values({ source: "shopify", orderNumber: `#K-${++hook}`, currency: "EUR", subtotal: "1.00", total: "1.00" })
    .returning({ id: orders.id });
  await h.db.insert(orderLineItems).values({ orderId: o!.id, variantId: variant!.id, title: "Item", quantity, unitPrice: "1.00", currency: "EUR" });
  return o!.id;
}
const boltsFor = async (orderId: string) => (await resolveKitMaterials(h.db, orderId)).find((m) => m.materialId === bolts)?.quantity ?? 0;

describe("full collection sync", () => {
  it("runs after the products sync: custom and smart collections and each product's memberships", async () => {
    store.products.set(P(1), gqlProduct(1, { title: "Крило" }));
    store.products.set(P(2), gqlProduct(2, { title: "Тримач" }));
    store.collections.set(C(1), { collection: gqlCollection(1, { title: "Крила" }), products: [P(1)] });
    store.collections.set(C(2), { collection: gqlCollection(2, { title: "Аксесуари (автоматична)" }), products: [P(2)] });
    store.collections.set(C(3), { collection: gqlCollection(3, { title: "Усі товари" }), products: [P(1), P(2)] });
    expect((await recordInstallation(h.db, SHOP, "read_products")).firstSync).toBe(true);
    await run();
    expect(await deadJobs()).toEqual([]);
    expect((await h.db.select().from(collections)).map((c) => c.title).sort()).toEqual(["Аксесуари (автоматична)", "Крила", "Усі товари"]);
    expect(await membership(P(1))).toEqual([C(1), C(3)]);
    expect(await membership(P(2))).toEqual([C(2), C(3)]);
    const [inst] = await h.db.select().from(shopInstallations).where(eq(shopInstallations.shop, SHOP));
    expect(inst?.collectionsSyncedAt).toBeInstanceOf(Date);
    expect(ops("OtCollections").length).toBeGreaterThan(0);
    expect(ops("OtProductMemberships").length).toBeGreaterThan(0);
  });

  it("subscribes to collection webhooks; read_products already covers collections (no new scope)", () => {
    expect(WEBHOOK_TOPICS).toEqual(expect.arrayContaining(["COLLECTIONS_CREATE", "COLLECTIONS_UPDATE", "COLLECTIONS_DELETE", "PRODUCTS_UPDATE"]));
    const toml = fs.readFileSync(path.resolve("shopify.app.toml"), "utf8");
    expect(/^scopes = "([^"]+)"/m.exec(toml)?.[1]?.split(",")).toContain("read_products");
  });
});

describe("kit templates on collections follow Shopify membership", () => {
  let fendersTemplate: string;

  it("a new product added to the collection in Shopify gets the collection's kit automatically (products/create)", async () => {
    fendersTemplate = (
      await createKitTemplate(ctx, {
        name: "Крила: болти",
        appliesTo: "collections",
        lines: [{ materialId: bolts, quantity: 1, per: "item" }],
        collectionIds: [(await localCollection(C(1))).id],
      })
    ).id;
    // Shopify: новий товар потрапляє в колекцію (за умовою автоматичної колекції або вручну).
    store.products.set(P(3), gqlProduct(3, { title: "Крило нове" }));
    store.collections.get(C(1))!.products.push(P(3));
    expect(await webhook("products/create", { admin_graphql_api_id: P(3) })).toBe("queued");
    await run();
    expect(await membership(P(3))).toEqual([C(1)]);
    const order = await orderWith(P(3), 2);
    expect(await boltsFor(order)).toBe(2);
    // Товар іншої колекції шаблону не отримує.
    expect(await boltsFor(await orderWith(P(2), 1))).toBe(0);
  });

  it("products/update takes a product out of a smart collection (Shopify sends no collections/update for that)", async () => {
    store.collections.get(C(1))!.products = [P(1)];
    store.products.set(P(3), gqlProduct(3, { title: "Крило нове", updatedAt: "2026-11-21T10:00:00Z" }));
    await webhook("products/update", { admin_graphql_api_id: P(3) });
    await run();
    expect(await membership(P(3))).toEqual([]);
    expect(await boltsFor(await orderWith(P(3), 1))).toBe(0);
  });

  it("collections/update (manual add) re-reads only the products whose membership changed", async () => {
    store.collections.get(C(1))!.products.push(P(2));
    await webhook("collections/update", { id: 1, admin_graphql_api_id: C(1) });
    await run();
    expect(await membership(P(2))).toEqual([C(1), C(2), C(3)]);
    expect(ops("OtCollection")).toHaveLength(1);
    expect(ops("OtProductCollections").map((c) => c.variables?.id)).toEqual([P(2)]);
    expect(await boltsFor(await orderWith(P(2), 3))).toBe(3);
    // Перейменування колекції в Shopify — нова назва в базі.
    store.collections.get(C(1))!.collection = gqlCollection(1, { title: "Крила й щитки", updatedAt: "2026-11-22T10:00:00Z" });
    await webhook("collections/update", { admin_graphql_api_id: C(1) });
    await run();
    expect((await getKitTemplate(h.db, fendersTemplate)).collections.map((c) => c.title)).toEqual(["Крила й щитки"]);
  });

  it("collections/delete: memberships removed, the template keeps the collection marked deleted and stops applying", async () => {
    const before = await orderWith(P(1), 1);
    expect(await boltsFor(before)).toBe(1);
    store.collections.delete(C(1));
    await webhook("collections/delete", { id: 1, admin_graphql_api_id: C(1) });
    await run();
    const deleted = await localCollection(C(1));
    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(await membership(P(1))).toEqual([C(3)]);
    expect((await getKitTemplate(h.db, fendersTemplate)).collections).toMatchObject([{ id: deleted.id, deleted: true, productsCount: 0 }]);
    expect(await boltsFor(before)).toBe(0);
    // Старіше читання (почалося до видалення) не «воскрешає» колекцію.
    await upsertCollections(h.db, [gqlCollection(1)], new Date(deleted.deletedAt!.getTime() - 60_000));
    expect((await localCollection(C(1))).deletedAt).toEqual(deleted.deletedAt);
    expect(await deadJobs()).toEqual([]);
  });
});

describe("membership consistency", () => {
  it("an older read of a product's collections never overwrites a newer one", async () => {
    const t2 = new Date();
    const t1 = new Date(t2.getTime() - 5_000);
    expect(await applyProductCollections(h.db, P(2), [gqlCollection(2)], t2)).toBe("saved");
    expect(await applyProductCollections(h.db, P(2), [gqlCollection(2), gqlCollection(3)], t1)).toBe("stale");
    expect(await membership(P(2))).toEqual([C(2)]);
    expect(await applyProductCollections(h.db, P(999), [gqlCollection(2)], t2)).toBe("unknown_product");
  });

  it("a full sync marks collections missing in Shopify as deleted, not ones created during the sync", async () => {
    store.collections.delete(C(3));
    const startedAt = new Date();
    await h.db.delete(jobs).where(eq(jobs.type, JOB.collectionsPage));
    await startCollectionsSync(h.db, SHOP, startedAt);
    // Колекція, створена (webhook) уже під час синхронізації, у списку ще не встигла з'явитися.
    await new Promise((r) => setTimeout(r, 5));
    await upsertCollections(h.db, [gqlCollection(4, { title: "Нова" })], new Date());
    await run();
    expect((await localCollection(C(3))).deletedAt).toBeInstanceOf(Date);
    expect((await localCollection(C(4))).deletedAt).toBeNull();
    expect((await localCollection(C(2))).deletedAt).toBeNull();
    expect(await membership(P(2))).toEqual([C(2)]);
    expect(await deadJobs()).toEqual([]);
  });

  it("a product in more collections than one page holds is read in full by a separate job", async () => {
    for (let n = 10; n < 35; n++) store.collections.set(C(n), { collection: gqlCollection(n), products: [P(1)] });
    await h.db.delete(jobs);
    await startCollectionsSync(h.db, SHOP);
    await run();
    expect((await membership(P(1))).length).toBe(25);
    expect(ops("OtProductCollections").map((c) => c.variables?.id)).toContain(P(1));
    expect(await deadJobs()).toEqual([]);
  });
});

describe("migration 0007 on a database with stage-5 kit data", () => {
  it("adds collections, kit filters and targets without touching existing templates", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig7-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const target = journal.entries.find((e) => e.tag.includes("kit_collections"));
    expect(target).toBeDefined();
    const previous = { ...journal, entries: journal.entries.filter((e) => e.idx < target!.idx) };
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(previous));
    for (const e of previous.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    const raw = await openRaw();
    try {
      await raw.migrate(dir);
      await raw.db.execute(sql`insert into products (title) values ('Old product')`);
      await raw.db.execute(sql`insert into kit_templates (name, applies_to) values ('Old kit', 'products')`);
      await raw.db.execute(sql`insert into kit_template_products (template_id, product_id) select k.id, p.id from kit_templates k, products p`);
      await raw.migrate(MIGRATIONS_FOLDER);
      const [kit] = await raw.db.select().from(kitTemplates);
      expect(kit).toMatchObject({ name: "Old kit", appliesTo: "products", variantModels: [], variantColors: [] });
      const [p] = await raw.db.select().from(products);
      expect(p).toMatchObject({ title: "Old product", collectionsSyncedAt: null });
      await raw.db.update(kitTemplates).set({ appliesTo: "collections" }).where(and(eq(kitTemplates.id, kit!.id)));
      await expect(raw.db.execute(sql`update kit_templates set applies_to = 'bogus'`)).rejects.toThrow();
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
  const name = `ot_mig7_${process.pid}_${Date.now()}`;
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

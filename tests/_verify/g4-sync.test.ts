import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { collections, jobs, orderLineItems, orders, productCollections, productVariants, products } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder, GqlProduct } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createKitTemplate, getKitTemplate, resolveKitMaterials } from "~/modules/packaging/kits.server";
import { createMaterial } from "~/modules/packaging/materials.server";
import { applyProductCollections, startCollectionsSync, upsertCollections } from "~/modules/shopify-sync/collections.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { recordInstallation } from "~/modules/shopify-sync/sync.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { fakeAdmin, gqlCollection, gqlProduct, type FakeCollection } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";

const SHOP = "ot-verify.myshopify.com";
const P = (n: number) => `gid://shopify/Product/${n}`;
const C = (n: number) => `gid://shopify/Collection/${n}`;
let h: DatabaseHandle;
let store: { orders: Map<string, GqlOrder>; products: Map<string, GqlProduct>; collections: Map<string, FakeCollection> };
let fake: ReturnType<typeof fakeAdmin>;
let ctx: ServiceContext;
let handlers: ReturnType<typeof createSyncHandlers>;
let bolts: string;
let hook = 0;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  store = { orders: new Map(), products: new Map(), collections: new Map() };
  fake = fakeAdmin(store);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new QueueingShopifyGateway(h.db, async () => SHOP), now: () => new Date() };
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });
  bolts = (await createMaterial(ctx, { code: "bolts_v", name: "Bolts V", kind: "bolt", unit: "pcs", active: true })).id;
  for (const n of [1, 2, 3]) store.products.set(P(n), gqlProduct(n));
  store.collections.set(C(1), { collection: gqlCollection(1), products: [P(1)] });
  store.collections.set(C(2), { collection: gqlCollection(2), products: [P(1), P(2)] });
  await recordInstallation(h.db, SHOP, "read_products");
  await runJobsOnce(h.db, handlers, { limit: 200 });
});
afterAll(async () => {
  await h?.close();
});

const run = () => runJobsOnce(h.db, handlers, { limit: 200 });
const webhook = (topic: string, payload: Record<string, unknown>) => handleShopifyWebhook(h.db, { topic, shop: SHOP, webhookId: `wh-v-${++hook}`, payload });
const localCollection = async (gid: string) => (await h.db.select().from(collections).where(eq(collections.shopifyCollectionId, gid)))[0]!;
async function membership(productGid: string): Promise<string[]> {
  const rows = await h.db
    .select({ gid: collections.shopifyCollectionId })
    .from(productCollections)
    .innerJoin(collections, eq(collections.id, productCollections.collectionId))
    .innerJoin(products, eq(products.id, productCollections.productId))
    .where(eq(products.shopifyProductId, productGid));
  return rows.map((r) => r.gid!).sort();
}
async function orderWith(productGid: string, quantity: number): Promise<string> {
  const [variant] = await h.db
    .select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(eq(products.shopifyProductId, productGid));
  const [o] = await h.db.insert(orders).values({ source: "shopify", orderNumber: `#V-${++hook}`, currency: "EUR", subtotal: "1.00", total: "1.00" }).returning({ id: orders.id });
  await h.db.insert(orderLineItems).values({ orderId: o!.id, variantId: variant!.id, title: "Item", quantity, unitPrice: "1.00", currency: "EUR" });
  return o!.id;
}
const boltsFor = async (orderId: string) => (await resolveKitMaterials(h.db, orderId)).find((m) => m.materialId === bolts)?.quantity ?? 0;

describe("G4 adversarial: collections sync", () => {
  it("initial full sync stored memberships", async () => {
    expect(await membership(P(1))).toEqual([C(1), C(2)]);
    expect(await membership(P(2))).toEqual([C(2)]);
    expect((await h.db.select().from(jobs).where(eq(jobs.status, "dead"))).length).toBe(0);
  });

  it("product in two collections of one template counts once; a products-template on top adds (by design)", async () => {
    const tpl = await createKitTemplate(ctx, {
      name: "two collections",
      appliesTo: "collections",
      lines: [{ materialId: bolts, quantity: 1, per: "item" }],
      collectionIds: [(await localCollection(C(1))).id, (await localCollection(C(2))).id],
    });
    const order = await orderWith(P(1), 3);
    expect(await boltsFor(order)).toBe(3);
    const pid = (await h.db.select().from(products).where(eq(products.shopifyProductId, P(1))))[0]!.id;
    const t2 = await createKitTemplate(ctx, { name: "products", appliesTo: "products", lines: [{ materialId: bolts, quantity: 1, per: "item" }], productIds: [pid] });
    expect(await boltsFor(order)).toBe(6);
    await h.db.execute(sql`delete from kit_templates where id in (${tpl.id}, ${t2.id})`);
  });

  it("out-of-order: update job queued, then collection deleted (delete webhook) -> stays deleted, kit stops", async () => {
    const tpl = await createKitTemplate(ctx, {
      name: "C1 kit",
      appliesTo: "collections",
      lines: [{ materialId: bolts, quantity: 1, per: "item" }],
      collectionIds: [(await localCollection(C(1))).id],
    });
    const order = await orderWith(P(1), 1);
    expect(await boltsFor(order)).toBe(1);
    // update webhook queued (not yet run), then Shopify deletes the collection and sends delete
    await webhook("collections/update", { admin_graphql_api_id: C(1) });
    store.collections.delete(C(1));
    await webhook("collections/delete", { id: 1 }); // numeric id only (no admin_graphql_api_id)
    await run();
    const c1 = await localCollection(C(1));
    expect(c1.deletedAt).toBeInstanceOf(Date);
    expect(await boltsFor(order)).toBe(0);
    // A stale product read (started before deletion) re-applies membership containing C1
    const stale = new Date(c1.deletedAt!.getTime() - 1000);
    // force product syncedAt earlier than stale so the product check passes
    await h.db.update(products).set({ collectionsSyncedAt: new Date(stale.getTime() - 1000) }).where(eq(products.shopifyProductId, P(1)));
    expect(await applyProductCollections(h.db, P(1), [gqlCollection(1), gqlCollection(2)], stale)).toBe("saved");
    expect((await localCollection(C(1))).deletedAt).toEqual(c1.deletedAt);
    // membership row for a deleted collection exists again, but must not drive kits
    const rows = await membership(P(1));
    console.log("[verify] membership after stale apply:", rows);
    expect(await boltsFor(order)).toBe(0);
    const view = await getKitTemplate(h.db, tpl.id);
    console.log("[verify] template collections view:", JSON.stringify(view.collections));
    expect(view.collections[0]!.deleted).toBe(true);
    // late update webhook for the deleted collection
    await webhook("collections/update", { admin_graphql_api_id: C(1) });
    await run();
    expect((await localCollection(C(1))).deletedAt).toBeInstanceOf(Date);
    expect(await boltsFor(order)).toBe(0);
  });

  it("concurrent applies for the same product: the newer read always wins regardless of commit order", async () => {
    for (let i = 0; i < 8; i++) {
      const base = Date.now() + i * 10_000 + 1_000_000;
      const newer = new Date(base + 5000);
      const older = new Date(base);
      const sets = [
        () => applyProductCollections(h.db, P(2), [gqlCollection(2)], newer),
        () => applyProductCollections(h.db, P(2), [gqlCollection(2), gqlCollection(3, { title: "X" })], older),
      ];
      const results = await Promise.all(i % 2 ? [sets[0]!(), sets[1]!()] : [sets[1]!(), sets[0]!()]);
      expect(results).toContain("saved");
      expect(await membership(P(2))).toEqual([C(2)]);
    }
  });

  it("collections/update for a manual add of a product not yet in the DB, then products/create picks it up", async () => {
    store.products.set(P(7), gqlProduct(7));
    store.collections.get(C(2))!.products.push(P(7));
    await webhook("collections/update", { admin_graphql_api_id: C(2) });
    await run();
    expect(await membership(P(7))).toEqual([]); // product unknown yet
    await webhook("products/create", { admin_graphql_api_id: P(7) });
    await run();
    expect(await membership(P(7))).toEqual([C(2)]);
  });

  it("silent deletion (no webhook) is caught by the full sync; stale earlier read cannot resurrect", async () => {
    store.collections.set(C(5), { collection: gqlCollection(5), products: [P(3)] });
    await webhook("collections/create", { admin_graphql_api_id: C(5) });
    await run();
    expect(await membership(P(3))).toEqual([C(5)]);
    const before = new Date();
    store.collections.delete(C(5));
    await new Promise((r) => setTimeout(r, 5));
    await h.db.delete(jobs).where(sql`${jobs.status} <> 'queued'`);
    await startCollectionsSync(h.db, SHOP);
    await run();
    const c5 = await localCollection(C(5));
    expect(c5.deletedAt).toBeInstanceOf(Date);
    expect(await membership(P(3))).toEqual([]);
    await upsertCollections(h.db, [gqlCollection(5)], before);
    expect((await localCollection(C(5))).deletedAt).toEqual(c5.deletedAt);
    expect((await h.db.select().from(jobs).where(eq(jobs.status, "dead"))).length).toBe(0);
  });

  it("button pressed twice while a full sync is queued -> one start job", async () => {
    await h.db.delete(jobs);
    expect(await startCollectionsSync(h.db, SHOP)).toBe(true);
    expect(await startCollectionsSync(h.db, SHOP)).toBe(false);
    await run();
    // and after it completed, a new one can be queued again
    expect(await startCollectionsSync(h.db, SHOP)).toBe(true);
    await run();
    expect((await h.db.select().from(jobs).where(eq(jobs.status, "dead"))).length).toBe(0);
  });
});

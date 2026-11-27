/**
 * A4: «варіант видалено в Shopify» — явна позначка product_variants.removed_at замість неявного правила
 * «updated_at варіанта старіший за updated_at товару». Ставить її лише повний перелік варіантів (upsertProduct,
 * variantsComplete), знімає — поява варіанта в переліку; інші зміни рядка (митні дані в застосунку тощо) її не
 * зачіпають. Сканування в пакуванні (catalogVariantLive) не вважає штрихкод видаленого варіанта «спільним».
 * Міграція 0010 переносить уже видалені за старим правилом варіанти в removed_at.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import { MIGRATIONS_FOLDER } from "~/db/migrate.server";
import { orderLineItems, orders, productVariants } from "~/db/schema";
import type { GqlProduct } from "~/integrations/shopify/graphql";
import { updateVariantCustomsData, validateOrderById } from "~/modules/orders/workflow.server";
import { adjustPackedLine, recordScan, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertProduct } from "~/modules/shopify-sync/sync.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { gqlProduct } from "../stage2/fixtures";

let env: TestEnv;
let orderId = "";
let line: { id: string; barcode: string };

beforeAll(async () => {
  env = await createTestEnv();
  orderId = await env.orderId("#1001");
  await validateOrderById(env.ctx(OWNER), orderId);
  expect((await createWaybill(env.ctx(OWNER), orderId)).kind).toBe("created");
  await startPacking(env.ctx(STAFF), orderId);
  const first = (await loadPackingScreen(env.ctx(STAFF), orderId)).lines.find((l) => l.barcode);
  line = { id: first!.id, barcode: first!.barcode! };
});
afterAll(async () => {
  await env.close();
});

async function scanKind(): Promise<string> {
  const r = await recordScan(env.ctx(STAFF), orderId, line.barcode);
  if (r.kind === "matched") await adjustPackedLine(env.ctx(STAFF), orderId, line.id, -1, "correction");
  return r.kind;
}

const A = "gid://shopify/ProductVariant/920101";
const B = "gid://shopify/ProductVariant/920102";
function dup(updatedAt: string, ids: string[]): GqlProduct {
  const base = gqlProduct(9201).variants.nodes[0]!;
  const nodes = ids.map((id) => ({ ...base, id, sku: id === A ? "DUP-A" : "DUP-B", barcode: id === A ? line.barcode : "999000222" }));
  return gqlProduct(9201, { updatedAt, variants: { nodes } });
}
async function removedAt(gid: string) {
  const [v] = await env.handle.db.select({ id: productVariants.id, removedAt: productVariants.removedAt }).from(productVariants).where(eq(productVariants.shopifyVariantId, gid));
  return v!;
}

describe("removed_at is explicit", () => {
  it("set by a complete list without the variant, cleared when it reappears", async () => {
    await upsertProduct(env.handle.db, mapProduct(dup("2026-11-20T10:00:00Z", [A, B])), "EUR", new Date(), { variantsComplete: true });
    expect((await removedAt(A)).removedAt).toBeNull();
    expect(await scanKind()).toBe("ambiguous");

    await upsertProduct(env.handle.db, mapProduct(dup("2026-11-21T10:00:00Z", [B])), "EUR", new Date(), { variantsComplete: true });
    expect((await removedAt(A)).removedAt).not.toBeNull();
    expect((await removedAt(B)).removedAt).toBeNull();
    expect(await scanKind()).toBe("matched");

    // Варіант знову в переліку Shopify → позначку знято, спільний штрихкод знову неоднозначний.
    await upsertProduct(env.handle.db, mapProduct(dup("2026-11-22T10:00:00Z", [A, B])), "EUR", new Date(), { variantsComplete: true });
    expect((await removedAt(A)).removedAt).toBeNull();
    expect(await scanKind()).toBe("ambiguous");
  });

  it("editing the removed variant in the app (customs data → updated_at) does not bring it back", async () => {
    await upsertProduct(env.handle.db, mapProduct(dup("2026-11-23T10:00:00Z", [B])), "EUR", new Date(), { variantsComplete: true });
    expect(await scanKind()).toBe("matched");
    // Старе правило (updated_at варіанта ≥ updated_at товару) після цього вважало б варіант знову наявним.
    await updateVariantCustomsData(env.ctx(OWNER), (await removedAt(A)).id, { hsCode: "871410" });
    expect((await removedAt(A)).removedAt).not.toBeNull();
    expect(await scanKind()).toBe("matched");
  });

  it("an incomplete list says nothing about absent variants: they count as present (safe for packing)", async () => {
    await upsertProduct(env.handle.db, mapProduct(dup("2026-11-24T10:00:00Z", [B])), "EUR", new Date(), { variantsComplete: false });
    expect((await removedAt(A)).removedAt).toBeNull();
    expect(await scanKind()).toBe("ambiguous");
  });
});

describe("migration 0010 on a database migrated to 0009 with rows", () => {
  it("adds nullable columns; variants removed under the old rule get removed_at; nothing else changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig10-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const target = journal.entries.find((e) => e.tag.includes("shopify_api_cost_customs_value"));
    expect(target).toBeDefined();
    const previous = { ...journal, entries: journal.entries.filter((e) => e.idx < target!.idx) };
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(previous));
    for (const e of previous.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    const raw = await openRaw();
    try {
      await raw.migrate(dir);
      await raw.db.execute(sql`insert into products (id, shopify_product_id, title, handle, status, updated_at) values
        ('00000000-0000-4000-8000-000000000001', 'gid://shopify/Product/1', 'Shopify', 's', 'ACTIVE', '2026-11-20T10:00:00Z'),
        ('00000000-0000-4000-8000-000000000002', null, 'Demo', 'd', 'ACTIVE', '2026-11-20T10:00:00Z'),
        ('00000000-0000-4000-8000-000000000003', 'gid://shopify/Product/3', 'Deleted', 'x', 'DELETED', '2026-11-20T10:00:00Z')`);
      await raw.db.execute(sql`insert into product_variants (product_id, shopify_variant_id, title, sku, price, currency, updated_at) values
        ('00000000-0000-4000-8000-000000000001', 'gid://shopify/ProductVariant/11', 'live', 'S-LIVE', '1.00', 'EUR', '2026-11-20T10:00:00Z'),
        ('00000000-0000-4000-8000-000000000001', 'gid://shopify/ProductVariant/12', 'gone', 'S-GONE', '1.00', 'EUR', '2026-11-19T10:00:00Z'),
        ('00000000-0000-4000-8000-000000000002', null, 'demo', 'D-OLD', '1.00', 'EUR', '2026-11-19T10:00:00Z'),
        ('00000000-0000-4000-8000-000000000003', 'gid://shopify/ProductVariant/31', 'del', 'X-OLD', '1.00', 'EUR', '2026-11-19T10:00:00Z')`);
      await raw.db.execute(sql`insert into orders (source, order_number, currency, subtotal, total, status, fulfillment_status)
        values ('shopify', '#M-10', 'EUR', '1.00', '1.00', 'handed_to_carrier', 'unfulfilled')`);
      await raw.db.execute(sql`insert into order_line_items (order_id, title, quantity, unit_price, currency)
        select id, 'Item', 2, '1.00', 'EUR' from orders where order_number = '#M-10'`);
      await raw.migrate(MIGRATIONS_FOLDER);
      const variants = await raw.db.select({ sku: productVariants.sku, removedAt: productVariants.removedAt }).from(productVariants);
      const bySku = Object.fromEntries(variants.map((v) => [v.sku, v.removedAt?.toISOString() ?? null]));
      expect(bySku).toEqual({ "S-LIVE": null, "S-GONE": "2026-11-20T10:00:00.000Z", "D-OLD": null, "X-OLD": null });
      const [o] = await raw.db.select().from(orders);
      expect(o).toMatchObject({ orderNumber: "#M-10", status: "handed_to_carrier", shopifyFulfillmentCheckedAt: null });
      const [l] = await raw.db.select().from(orderLineItems);
      expect(l).toMatchObject({ quantity: 2, unitPrice: "1.00", discountedUnitPrice: null });
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
  const name = `ot_mig10_${process.pid}_${Date.now()}`;
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

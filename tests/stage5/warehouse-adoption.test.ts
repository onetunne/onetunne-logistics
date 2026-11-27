import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { warehouses } from "~/db/schema";
import type { Db } from "~/db/client.server";
import { MIGRATIONS_FOLDER } from "~/db/migrate.server";
import { ensureDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { ensureDefaultSettings } from "~/modules/settings/settings.server";
import { openTestDatabase } from "../helpers";

/** Бази, заповнені до етапу 5: наявний склад стає складом за замовчуванням (а не створюється другий). */
describe("adopting an existing warehouse as the default", () => {
  it("ensureDefaultWarehouse marks the only existing warehouse as default instead of inserting a second one", async () => {
    const h = await openTestDatabase();
    try {
      await ensureDefaultSettings(h.db);
      const [old] = await h.db
        .insert(warehouses)
        .values({ name: "Склад Київ (демо)", countryCode: "UA", city: "Київ", shopifyLocationId: "gid://shopify/Location/1" })
        .returning();
      expect(old!.isDefault).toBe(false);
      const results = await Promise.all([1, 2, 3].map(() => ensureDefaultWarehouse(h.db)));
      expect(new Set(results.map((w) => w.id))).toEqual(new Set([old!.id]));
      const all = await h.db.select().from(warehouses);
      expect(all).toHaveLength(1);
      expect(all[0]).toMatchObject({ id: old!.id, isDefault: true, shopifyLocationId: "gid://shopify/Location/1" });
    } finally {
      await h.close();
    }
  });

  it("migration 0005 adopts the warehouse of a stage 1–4 database", async () => {
    // Каталог міграцій лише до 0004 (стан бази етапів 1–4).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const stage4 = { ...journal, entries: journal.entries.filter((e) => e.idx <= 4) };
    expect(journal.entries.filter((e) => e.tag.includes("warehouse_production"))).toHaveLength(1);
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(stage4));
    for (const e of stage4.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));

    const { db, migrate, close } = await openRaw();
    try {
      await migrate(dir);
      await db.execute(sql`insert into warehouses (name, country_code, city) values ('Склад Київ (демо)', 'UA', 'Київ')`);
      await migrate(MIGRATIONS_FOLDER);
      const rows = await db.select({ name: warehouses.name, isDefault: warehouses.isDefault }).from(warehouses);
      expect(rows).toEqual([{ name: "Склад Київ (демо)", isDefault: true }]);
    } finally {
      await close();
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
  const name = `ot_mig_${process.pid}_${Date.now()}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
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
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database if exists ${name}`);
      await c.end();
    },
  };
}

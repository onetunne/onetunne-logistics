/**
 * Етап 6 (WP0): міграція 0012 на базі з даними етапу 5 (docs/stage6-design.md §6.4, §17, §20.3). Спершу 0000–0011,
 * потім рядки «як у етапу 5» (сирий SQL — схема ще без колонок етапу 6), потім 0012:
 * - inventory_movements.seq нумерує наявні рядки за (created_at, входи перед виходами, ключ), NOT NULL, identity;
 *   наступна вставка отримує max + 1; явне значення seq заборонено (GENERATED ALWAYS);
 * - магазин 'default' і рядок finance_state створено; orders.shopify_test = false; requires_shipping = null;
 * - повторний запуск міграцій нічого не змінює.
 * PGlite завжди; PostgreSQL 16 — з TEST_DATABASE_URL.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER } from "~/db/migrate.server";

interface Exec {
  run(query: string): Promise<Array<Record<string, unknown>>>;
  migrate(folder: string): Promise<void>;
  close(): Promise<void>;
}

const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** Копія міграцій до 0011 включно (журнал без 0012). */
function stage5Folder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig5-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "meta"));
  const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: Array<{ tag: string }> };
  const idx = journal.entries.findIndex((e) => e.tag.startsWith("0012_"));
  expect(idx).toBe(12);
  const kept = { ...journal, entries: journal.entries.slice(0, idx) };
  fs.writeFileSync(path.join(dir, "meta", "_journal.json"), JSON.stringify(kept));
  for (const e of kept.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
  return dir;
}

async function pgliteExec(): Promise<Exec> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const client = new PGlite();
  const db = drizzle(client);
  return {
    run: async (q) => (await client.query<Record<string, unknown>>(q)).rows,
    migrate: (folder) => migrate(db, { migrationsFolder: folder }),
    close: () => client.close(),
  };
}

async function pgExec(adminUrl: string): Promise<Exec> {
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
  const db = drizzle(pool);
  return {
    run: async (q) => (await pool.query(q)).rows as Array<Record<string, unknown>>,
    migrate: (folder) => migrate(db, { migrationsFolder: folder }),
    close: async () => {
      await pool.end();
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database if exists ${name}`);
      await c.end();
    },
  };
}

const ID = {
  warehouse: "00000000-0000-4000-8000-000000000001",
  product: "00000000-0000-4000-8000-000000000002",
  variant: "00000000-0000-4000-8000-000000000003",
  item: "00000000-0000-4000-8000-000000000004",
  order: "00000000-0000-4000-8000-000000000005",
  line: "00000000-0000-4000-8000-000000000006",
};

/** Рядки етапу 5: три «транзакції» (однаковий created_at усередині), рухи різних видів і ключів. */
async function seedStage5(x: Exec): Promise<void> {
  await x.run(`insert into warehouses (id, name, country_code, city, is_default) values ('${ID.warehouse}', 'Main', 'UA', 'Kyiv', true)`);
  await x.run(`insert into products (id, title) values ('${ID.product}', 'Holder')`);
  await x.run(`insert into product_variants (id, product_id, title, price, currency) values ('${ID.variant}', '${ID.product}', 'Black', '25.00', 'EUR')`);
  await x.run(`insert into stock_items (id, kind, variant_id) values ('${ID.item}', 'product', '${ID.variant}')`);
  await x.run(
    `insert into orders (id, source, order_number, currency, subtotal, total) values ('${ID.order}', 'demo', '#5001', 'EUR', '25.00', '25.00')`,
  );
  await x.run(
    `insert into order_line_items (id, order_id, title, quantity, unit_price, currency) values ('${ID.line}', '${ID.order}', 'Holder', 1, '25.00', 'EUR')`,
  );
  const mv = (key: string, type: string, onHand: number, reserved: number, at: string) =>
    `('${ID.warehouse}', '${ID.item}', '${type}', ${onHand}, ${reserved}, '${key}', 'test', 'Test', '${at}')`;
  const T0 = "2026-09-01T10:00:00Z";
  const T1 = "2026-09-02T10:00:00Z";
  const T2 = "2026-09-03T10:00:00Z";
  await x.run(`insert into inventory_movements (warehouse_id, stock_item_id, type, on_hand_delta, reserved_delta, idempotency_key, actor_id, actor_name, created_at) values
    ${[
      mv("a-later", "adjustment", -2, 0, T2),
      mv("k-b", "consume_sale", -1, -1, T1),
      mv("k-c", "reserve", 0, 1, T1),
      mv("k-d", "receipt_manual", 1, 0, T1),
      mv("k-a", "receipt_manual", 5, 0, T1),
      mv("z-opening", "opening", 3, 0, T0),
    ].join(",\n")}`);
}

async function scenario(x: Exec): Promise<void> {
  await x.migrate(stage5Folder());
  const before = await x.run(`select count(*)::int as c from information_schema.columns where table_name = 'inventory_movements' and column_name = 'seq'`);
  expect(before[0]!.c).toBe(0);
  await seedStage5(x);
  await x.migrate(MIGRATIONS_FOLDER);

  const order = await x.run(`select idempotency_key as k, seq::int as seq from inventory_movements order by seq`);
  expect(order.map((r) => [r.k, r.seq])).toEqual([
    ["z-opening", 1],
    ["k-a", 2],
    ["k-d", 3],
    ["k-c", 4],
    ["k-b", 5],
    ["a-later", 6],
  ]);
  const col = await x.run(
    `select is_nullable, is_identity, identity_generation from information_schema.columns where table_name = 'inventory_movements' and column_name = 'seq'`,
  );
  expect(col[0]).toMatchObject({ is_nullable: "NO", is_identity: "YES", identity_generation: "ALWAYS" });
  // Наступна вставка — max + 1; явне значення seq заборонено.
  await x.run(
    `insert into inventory_movements (warehouse_id, stock_item_id, type, on_hand_delta, idempotency_key, actor_id, actor_name) values ('${ID.warehouse}', '${ID.item}', 'adjustment', 1, 'after-migration', 'test', 'Test')`,
  );
  const next = await x.run(`select seq::int as seq from inventory_movements where idempotency_key = 'after-migration'`);
  expect(next[0]!.seq).toBe(7);
  await expect(
    x.run(
      `insert into inventory_movements (warehouse_id, stock_item_id, type, on_hand_delta, idempotency_key, actor_id, actor_name, seq) values ('${ID.warehouse}', '${ID.item}', 'adjustment', 1, 'explicit-seq', 'test', 'Test', 100)`,
    ),
  ).rejects.toThrow();
  const uq = await x.run(`select indexname from pg_indexes where tablename = 'inventory_movements' and indexname = 'inventory_movements_seq_uq'`);
  expect(uq).toHaveLength(1);

  // Магазин і стан фінансів; нові колонки наявних таблиць.
  expect(await x.run(`select id, is_default from stores`)).toEqual([{ id: "default", is_default: true }]);
  expect(await x.run(`select store_id from finance_state`)).toEqual([{ store_id: "default" }]);
  expect(await x.run(`select shopify_test from orders`)).toEqual([{ shopify_test: false }]);
  expect(await x.run(`select requires_shipping from order_line_items`)).toEqual([{ requires_shipping: null }]);
  // Фінансовий запис отримує магазин за замовчуванням; сума 0 — відмова CHECK.
  await x.run(
    `insert into finance_entries (idempotency_key, category, recognized_on, original_on, fx_on, amount, currency, source_type, source_id, posted_by) values ('m:1', 'sales_product', '2026-09-02', '2026-09-02', '2026-09-02', '25.00', 'EUR', 'demo', 'x', 'test')`,
  );
  expect(await x.run(`select store_id, seq::int as seq from finance_entries`)).toEqual([{ store_id: "default", seq: 1 }]);
  await expect(
    x.run(
      `insert into finance_entries (idempotency_key, category, recognized_on, original_on, fx_on, amount, currency, source_type, source_id, posted_by) values ('m:2', 'sales_product', '2026-09-02', '2026-09-02', '2026-09-02', '0', 'EUR', 'demo', 'x', 'test')`,
    ),
  ).rejects.toThrow();
  // Вираз-індекс відправлень за нормалізованим номером.
  const idx = await x.run(`select indexdef from pg_indexes where indexname = 'shipments_waybill_norm_idx'`);
  expect(String(idx[0]!.indexdef)).toMatch(/upper\(regexp_replace/);

  // Повторний запуск — без змін.
  await x.migrate(MIGRATIONS_FOLDER);
  expect((await x.run(`select count(*)::int as c from inventory_movements`))[0]!.c).toBe(7);
  expect((await x.run(`select count(*)::int as c from stores`))[0]!.c).toBe(1);
}

describe("migration 0012 on a database with stage-5 data", () => {
  it("PGlite", async () => {
    const x = await pgliteExec();
    try {
      await scenario(x);
    } finally {
      await x.close();
    }
  });

  it.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL 16", async () => {
    const x = await pgExec(process.env.TEST_DATABASE_URL!);
    try {
      await scenario(x);
    } finally {
      await x.close();
    }
  });

  it("the migration file and the journal entry are consistent", () => {
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const last = journal.entries.at(-1)!;
    expect(last).toMatchObject({ idx: 12, tag: "0012_stage6_finance" });
    expect(last.when).toBeGreaterThan(journal.entries.at(-2)!.when);
    expect(fs.existsSync(path.join(MIGRATIONS_FOLDER, "0012_stage6_finance.sql"))).toBe(true);
    expect(fs.existsSync(path.join(MIGRATIONS_FOLDER, "meta", "0012_snapshot.json"))).toBe(true);
    const text = fs.readFileSync(path.join(MIGRATIONS_FOLDER, "0012_stage6_finance.sql"), "utf8");
    // Ручні оператори §6.4 замість згенерованого ADD COLUMN … IDENTITY.
    expect(text).not.toMatch(/ADD COLUMN "seq" bigint NOT NULL GENERATED/);
    expect(text).toMatch(/ALTER COLUMN "seq" ADD GENERATED ALWAYS AS IDENTITY/);
    expect(text).toMatch(/setval\(pg_get_serial_sequence\('inventory_movements', 'seq'\)/);
  });
});

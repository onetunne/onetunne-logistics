import path from "node:path";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import type { PgDatabase, PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { ExtractTablesWithRelations } from "drizzle-orm";
import * as schema from "./schema";
import { migrateDatabase } from "./migrate.server";

export type Schema = typeof schema;
/** Спільний тип для node-postgres (production) та PGlite (демо/тести). */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
export type Tx = PgTransaction<PgQueryResultHKT, Schema, ExtractTablesWithRelations<Schema>>;
export type DbOrTx = Db | Tx;

export interface DatabaseHandle {
  db: Db;
  driver: "pg" | "pglite";
  close(): Promise<void>;
}

/** Робоча база PostgreSQL (DATABASE_URL). */
export async function openPostgres(connectionString: string, opts: { migrate?: boolean } = {}): Promise<DatabaseHandle> {
  const { Pool } = await import("pg");
  const pool = new Pool({ connectionString, max: 10 });
  const db = drizzlePg(pool, { schema }) as unknown as Db;
  if (opts.migrate !== false) await migrateDatabase(db, "pg");
  return { db, driver: "pg", close: () => pool.end() };
}

/**
 * Вбудований PostgreSQL (PGlite) — для автономного демо та тестів.
 * dataDir = undefined → у пам'яті; інакше файлове сховище (зберігається між перезапусками).
 */
export async function openPglite(dataDir?: string): Promise<DatabaseHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const client = dataDir ? new PGlite(path.resolve(dataDir)) : new PGlite();
  const db = drizzlePglite(client, { schema }) as unknown as Db;
  await migrateDatabase(db, "pglite");
  return { db, driver: "pglite", close: () => client.close() };
}

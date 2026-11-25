import path from "node:path";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import type { Db } from "./client.server";

export const MIGRATIONS_FOLDER = path.resolve(process.cwd(), "drizzle");

/** Застосовує SQL-міграції з ./drizzle (версіонування схеми через таблицю __drizzle_migrations). */
export async function migrateDatabase(db: Db, driver: "pg" | "pglite"): Promise<void> {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (driver === "pg") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migratePg(db as any, config);
  } else {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migratePglite(db as any, config);
  }
}

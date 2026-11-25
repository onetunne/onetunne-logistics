import { eq } from "drizzle-orm";
import { openPglite, openPostgres, type DatabaseHandle } from "~/db/client.server";
import { orders } from "~/db/schema";
import { seedDemoData } from "~/db/seed/seed.server";
import { makeActor, SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";

export const OWNER = makeActor({ id: "test-owner", displayName: "Owner", role: "owner" });
export const STAFF = makeActor({ id: "test-staff", displayName: "Staff", role: "staff" });

export interface TestEnv {
  handle: DatabaseHandle;
  ctx: (actor?: Actor) => ServiceContext;
  orderId: (number: string) => Promise<string>;
  close: () => Promise<void>;
}

let dbCounter = 0;

/**
 * Ізольована база з міграціями та демо-даними: PGlite у пам'яті (за замовчуванням)
 * або окрема тимчасова база на справжньому PostgreSQL, якщо задано TEST_DATABASE_URL.
 */
export async function openTestDatabase(): Promise<DatabaseHandle> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) return openPglite();
  const { Client } = await import("pg");
  const name = `ot_test_${process.pid}_${Date.now()}_${dbCounter++}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const handle = await openPostgres(url.toString());
  return {
    ...handle,
    close: async () => {
      await handle.close();
      const c = new Client({ connectionString: adminUrl });
      await c.connect();
      await c.query(`drop database if exists ${name}`);
      await c.end();
    },
  };
}

export async function createTestEnv(opts: { seed?: boolean } = {}): Promise<TestEnv> {
  const handle = await openTestDatabase();
  const carriers = createDemoCarriers(handle.db);
  const ctx = (actor: Actor = OWNER): ServiceContext => ({
    mode: "demo",
    db: handle.db,
    actor,
    carriers,
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
  });
  if (opts.seed !== false) await seedDemoData(ctx(SYSTEM_ACTOR));
  return {
    handle,
    ctx,
    orderId: async (number) => {
      const [row] = await handle.db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, number));
      if (!row) throw new Error(`order ${number} not found`);
      return row.id;
    },
    close: () => handle.close(),
  };
}

import { openPglite, type DatabaseHandle } from "~/db/client.server";
import { seedDemoData } from "~/db/seed/seed.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { createCarrierRegistry, DbSandboxStore, TestCarrierAdapter } from "~/integrations/carriers";
import type { CarrierRegistry } from "~/integrations/carriers/types";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { getSetting } from "~/modules/settings/settings.server";
import type { Db } from "~/db/client.server";
import type { ServiceContext } from "./types";

/**
 * Середовище демо: окрема вбудована база PGlite (ніколи не DATABASE_URL), тестовий перевізник,
 * Shopify-шлюз без мережевих запитів. Нічого реального не створюється й не надсилається.
 */
export interface DemoRuntime {
  handle: DatabaseHandle;
  carriers: CarrierRegistry;
}

const g = globalThis as unknown as { __otDemoRuntime?: Promise<DemoRuntime> };

export function createDemoCarriers(db: Db): CarrierRegistry {
  const testCarrier = new TestCarrierAdapter({
    store: new DbSandboxStore(db),
    getSimulation: async () => (await getSetting(db, "testCarrier")).simulation,
  });
  return createCarrierRegistry([testCarrier], testCarrier.code);
}

export function demoServiceContext(runtime: DemoRuntime, actor = SYSTEM_ACTOR): ServiceContext {
  return {
    mode: "demo",
    db: runtime.handle.db,
    actor,
    carriers: runtime.carriers,
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
  };
}

async function init(): Promise<DemoRuntime> {
  const env = getEnv();
  const dir = env.DEMO_DATA_DIR === "memory" ? undefined : (env.DEMO_DATA_DIR ?? ".data/demo-db");
  const handle = await openPglite(dir);
  const runtime: DemoRuntime = { handle, carriers: createDemoCarriers(handle.db) };
  await seedDemoData(demoServiceContext(runtime));
  logger.info("demo.runtime_ready", { storage: dir ? "file" : "memory" });
  return runtime;
}

export function getDemoRuntime(): Promise<DemoRuntime> {
  if (!g.__otDemoRuntime) {
    g.__otDemoRuntime = init().catch((e) => {
      g.__otDemoRuntime = undefined;
      throw e;
    });
  }
  return g.__otDemoRuntime;
}

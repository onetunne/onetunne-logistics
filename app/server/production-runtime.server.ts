import { openPostgres, type DatabaseHandle } from "~/db/client.server";
import { seedReferenceData } from "~/db/seed/seed.server";
import { createCarrierRegistry, NovaGlobalAdapter } from "~/integrations/carriers";
import type { CarrierRegistry } from "~/integrations/carriers/types";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { startJobWorker } from "~/modules/jobs/worker.server";
import { createSyncHandlers, defaultAdmin } from "~/modules/shopify-sync/handlers.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import type { ShopifyGateway } from "~/integrations/shopify/types";
import type { ServiceContext } from "./types";

/**
 * Робоче середовище: PostgreSQL (DATABASE_URL). Тестовий перевізник тут НЕ реєструється —
 * у робочій версії неможливо створити тестову/фіктивну накладну. Nova Global — після етапу 3.
 */
export interface ProductionRuntime {
  handle: DatabaseHandle;
  carriers: CarrierRegistry;
  shopify: ShopifyGateway;
}

const g = globalThis as unknown as { __otProdRuntime?: Promise<ProductionRuntime> };

async function init(): Promise<ProductionRuntime> {
  const env = getEnv();
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const handle = await openPostgres(env.DATABASE_URL, { migrate: env.AUTO_MIGRATE !== "false" });
  await seedReferenceData(handle.db);
  const nova = new NovaGlobalAdapter();
  const db = handle.db;
  const shopify = new QueueingShopifyGateway(db, async () => (await currentShop(db))?.shop ?? null);
  return { handle, carriers: createCarrierRegistry([nova], nova.code), shopify };
}

export function productionServiceContext(runtime: ProductionRuntime): ServiceContext {
  return {
    mode: "production",
    db: runtime.handle.db,
    actor: SYSTEM_ACTOR,
    carriers: runtime.carriers,
    shopify: runtime.shopify,
    now: () => new Date(),
  };
}

let workerStarted = false;

/** Запускає фоновий обробник черги (один на процес). Викликається під час старту сервера. */
export async function ensureJobWorker(): Promise<void> {
  if (workerStarted) return;
  workerStarted = true;
  try {
    const runtime = await getProductionRuntime();
    const handlers = createSyncHandlers({
      db: runtime.handle.db,
      serviceContext: () => productionServiceContext(runtime),
      admin: defaultAdmin,
    });
    startJobWorker(runtime.handle.db, handlers);
  } catch (e) {
    workerStarted = false;
    logger.error("job.worker_start_failed", { error: e });
  }
}

export function getProductionRuntime(): Promise<ProductionRuntime> {
  if (!g.__otProdRuntime) {
    g.__otProdRuntime = init().catch((e) => {
      g.__otProdRuntime = undefined;
      throw e;
    });
  }
  return g.__otProdRuntime;
}

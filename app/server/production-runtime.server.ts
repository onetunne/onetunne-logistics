import { openPostgres, type DatabaseHandle } from "~/db/client.server";
import { seedReferenceData } from "~/db/seed/seed.server";
import { createCarrierRegistry, NovaGlobalAdapter } from "~/integrations/carriers";
import type { CarrierRegistry } from "~/integrations/carriers/types";
import { getEnv } from "~/lib/env.server";

/**
 * Робоче середовище: PostgreSQL (DATABASE_URL). Тестовий перевізник тут НЕ реєструється —
 * у робочій версії неможливо створити тестову/фіктивну накладну. Nova Global — після етапу 3.
 */
export interface ProductionRuntime {
  handle: DatabaseHandle;
  carriers: CarrierRegistry;
}

const g = globalThis as unknown as { __otProdRuntime?: Promise<ProductionRuntime> };

async function init(): Promise<ProductionRuntime> {
  const env = getEnv();
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const handle = await openPostgres(env.DATABASE_URL, { migrate: env.AUTO_MIGRATE !== "false" });
  await seedReferenceData(handle.db);
  const nova = new NovaGlobalAdapter();
  return { handle, carriers: createCarrierRegistry([nova], nova.code) };
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

import { openPostgres, type DatabaseHandle } from "~/db/client.server";
import { seedReferenceData } from "~/db/seed/seed.server";
import { createCarrierRegistry, NovaGlobalAdapter } from "~/integrations/carriers";
import { NovaPostAdapter, NOVA_POST_CODE } from "~/integrations/carriers/nova-post/adapter.server";
import { NovaPostClient, NOVA_POST_ENDPOINTS } from "~/integrations/carriers/nova-post/client.server";
import type { CarrierAdapter, CarrierRegistry } from "~/integrations/carriers/types";
import { getSettings } from "~/modules/settings/settings.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { startJobWorker } from "~/modules/jobs/worker.server";
import { createSyncHandlers, defaultAdmin } from "~/modules/shopify-sync/handlers.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import type { ShopifyGateway } from "~/integrations/shopify/types";
import { scheduleTrackingPoll } from "~/modules/tracking/tracking.server";
import type { ServiceContext } from "./types";
import { ensureInventoryPushSweep, scheduleFullReconcileCheck } from "~/modules/inventory-sync/schedule.server";
import { SCHEDULED_RECONCILE_FIRST_DELAY_MS } from "~/modules/inventory-sync/jobs";
import { SCHEDULED_COLLECTIONS_SYNC_FIRST_DELAY_MS, scheduleCollectionsSyncCheck } from "~/modules/shopify-sync/collections.server";
import { enqueueWebhookSubscriptionCheck, webhookConfigKey } from "~/modules/shopify-sync/webhook-subscriptions.server";

/**
 * Робоче середовище: PostgreSQL (DATABASE_URL). Тестовий перевізник тут НЕ реєструється —
 * у робочій версії неможливо створити тестову/фіктивну накладну.
 * Перевізники: Nova Post API v1.0 — за наявності NOVA_POSHTA_API_KEY (перевізник за замовчуванням);
 * реальне створення накладних — лише з NOVA_POST_SHIPMENTS_ENABLED=true (окремий дозвіл власника).
 * Nova Global — заглушка not_configured до отримання облікових даних за договором.
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
  const db = handle.db;
  const novaGlobal = new NovaGlobalAdapter();
  const adapters: CarrierAdapter[] = [novaGlobal];
  let defaultCode: string = novaGlobal.code;
  if (env.NOVA_POSHTA_API_KEY) {
    const client = new NovaPostClient({ apiKey: env.NOVA_POSHTA_API_KEY, baseUrl: env.NOVA_POSHTA_API_BASE ?? NOVA_POST_ENDPOINTS.ua });
    adapters.push(
      new NovaPostAdapter({ client, settings: () => getSettings(db), allowShipmentCreation: env.NOVA_POST_SHIPMENTS_ENABLED }),
    );
    defaultCode = NOVA_POST_CODE;
  }
  logger.info("carriers.registered", {
    carriers: adapters.map((a) => a.code).join(","),
    default: defaultCode,
    novaPostShipmentCreation: env.NOVA_POST_SHIPMENTS_ENABLED ? "enabled" : "disabled",
  });
  const shopify = new QueueingShopifyGateway(db, async () => (await currentShop(db))?.shop ?? null);
  return { handle, carriers: createCarrierRegistry(adapters, defaultCode), shopify };
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
      webhooks: {
        configKey: webhookConfigKey(getEnv().SHOPIFY_APP_URL ?? ""),
        register: async (shop) => (await import("~/shopify.server")).registerShopWebhooks(shop),
      },
    });
    startJobWorker(runtime.handle.db, handlers);
    // Підписки на webhooks наявного встановлення: нові теми після оновлення (етап 5 — collections/*) без повторної
    // авторизації власника (afterAuth для встановленого застосунку не гарантований).
    await enqueueWebhookSubscriptionCheck(runtime.handle.db);
    // Ланцюжок опитування відстеження: одне очікуване завдання (dedupe), перше — через хвилину після старту.
    await scheduleTrackingPoll(runtime.handle.db, new Date(Date.now() + 60_000));
    // Страхова передача складських змін у Shopify (етап 5): ланцюжок зупиняється сам, якщо передачу вимкнено.
    await ensureInventoryPushSweep(runtime.handle.db);
    // Планова повна звірка залишків із Shopify (кожні 6 год; лише читання; звіряє, коли облік відкрито).
    await scheduleFullReconcileCheck(runtime.handle.db, { delayMs: SCHEDULED_RECONCILE_FIRST_DELAY_MS });
    // Щоденна повна синхронізація колекцій (шаблони комплектації «на колекцію»; лише читання Shopify).
    await scheduleCollectionsSyncCheck(runtime.handle.db, { delayMs: SCHEDULED_COLLECTIONS_SYNC_FIRST_DELAY_MS });
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

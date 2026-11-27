/**
 * Конфігурація Embedded Shopify App (офіційний @shopify/shopify-app-react-router).
 * Ініціалізується ЛЕДАЧЕ і лише для маршрутів /app, /auth, /webhooks — демо цей модуль не завантажує.
 *
 * Розповсюдження: Custom Distribution через Shopify Dev Dashboard (етап 2).
 * Доступи (scopes) — мінімальні, задаються в shopify.app.toml / SCOPES.
 */
import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, AppDistribution, DeliveryMethod, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { DrizzleSessionStoragePostgres } from "@shopify/shopify-app-session-storage-drizzle";
import { shopifySessions } from "~/db/schema";
import { getEnv } from "~/lib/env.server";
import { getProductionRuntime } from "~/server/production-runtime.server";
import { logger } from "~/lib/logger.server";
import { recordInstallation } from "~/modules/shopify-sync/sync.server";
import {
  WEBHOOK_SUBSCRIPTIONS,
  enqueueWebhookSubscriptionCheck,
  recordWebhookRegistration,
  webhookConfigKey,
} from "~/modules/shopify-sync/webhook-subscriptions.server";

/**
 * Shop-specific підписки (реєструються через API після встановлення — без Shopify CLI). Для вже встановленого
 * застосунку нові теми підписуються фоновим завданням (webhook-subscriptions.server.ts), без повторної авторизації.
 */
const WEBHOOKS = Object.fromEntries(
  WEBHOOK_SUBSCRIPTIONS.map(({ topic, callbackUrl }) => [topic, { deliveryMethod: DeliveryMethod.Http as const, callbackUrl }]),
);

/** Стабільна версія GraphQL Admin API. */
export const API_VERSION = ApiVersion.October26;

async function createShopify() {
  const env = getEnv();
  if (!env.shopifyConfigured) throw new Error("Shopify is not configured (SHOPIFY_API_KEY/SECRET/APP_URL)");
  const runtime = await getProductionRuntime();
  return shopifyApp({
    apiKey: env.SHOPIFY_API_KEY,
    apiSecretKey: env.SHOPIFY_API_SECRET ?? "",
    apiVersion: API_VERSION,
    scopes: env.SCOPES?.split(",").map((s) => s.trim()).filter(Boolean),
    appUrl: env.SHOPIFY_APP_URL ?? "",
    authPathPrefix: "/auth",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sessionStorage: new DrizzleSessionStoragePostgres(runtime.handle.db as any, shopifySessions),
    distribution: AppDistribution.AppStore,
    webhooks: WEBHOOKS,
    hooks: {
      afterAuth: async ({ session }) => {
        // Після встановлення/повторної авторизації: запис встановлення (перша синхронізація товарів) і підписки на
        // webhooks. Збій реєстрації не скасовує запис встановлення — підписки повторить фонове завдання.
        const db = runtime.handle.db;
        try {
          await recordInstallation(db, session.shop, session.scope ?? null);
        } catch (e) {
          logger.error("shopify.after_auth_failed", { error: e });
        }
        try {
          const shopify = await getShopify();
          const result = await shopify.registerWebhooks({ session });
          const outcome = await recordWebhookRegistration(db, session.shop, webhookConfigKey(env.SHOPIFY_APP_URL ?? ""), result);
          if (!outcome.complete) await enqueueWebhookSubscriptionCheck(db, { force: true, runAt: new Date(Date.now() + 60_000) });
        } catch (e) {
          logger.error("shopify.webhooks_register_failed", { error: e });
          await enqueueWebhookSubscriptionCheck(db, { force: true, runAt: new Date(Date.now() + 60_000) }).catch(() => undefined);
        }
      },
    },
    // Обов'язково для застосунків, створених після 01.12.2026; рекомендовано для всіх.
    future: { expiringOfflineAccessTokens: true },
    ...(env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [env.SHOP_CUSTOM_DOMAIN] } : {}),
  });
}

export type ShopifyAppInstance = Awaited<ReturnType<typeof createShopify>>;

const g = globalThis as unknown as { __otShopify?: Promise<ShopifyAppInstance> };

/**
 * Перереєстрація підписок для встановленого магазину (фонове завдання shopify.ensure_webhooks): офлайн-сесія з бази
 * (unauthenticated.admin сам оновлює прострочений офлайн-токен), без участі власника.
 */
export async function registerShopWebhooks(shop: string) {
  const shopify = await getShopify();
  const { session } = await shopify.unauthenticated.admin(shop);
  return shopify.registerWebhooks({ session });
}

export function getShopify(): Promise<ShopifyAppInstance> {
  if (!g.__otShopify) {
    g.__otShopify = createShopify().catch((e) => {
      g.__otShopify = undefined;
      throw e;
    });
  }
  return g.__otShopify;
}

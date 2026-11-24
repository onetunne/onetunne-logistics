/**
 * Конфігурація Embedded Shopify App (офіційний @shopify/shopify-app-react-router).
 * Ініціалізується ЛЕДАЧЕ і лише для маршрутів /app, /auth, /webhooks — демо цей модуль не завантажує.
 *
 * Розповсюдження: Custom Distribution через Shopify Dev Dashboard (етап 2).
 * Доступи (scopes) — мінімальні, задаються в shopify.app.toml / SCOPES.
 */
import "@shopify/shopify-app-react-router/adapters/node";
import { ApiVersion, AppDistribution, shopifyApp } from "@shopify/shopify-app-react-router/server";
import { DrizzleSessionStoragePostgres } from "@shopify/shopify-app-session-storage-drizzle";
import { shopifySessions } from "~/db/schema";
import { getEnv } from "~/lib/env.server";
import { getProductionRuntime } from "~/server/production-runtime.server";

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
    future: { expiringOfflineAccessTokens: true },
    ...(env.SHOP_CUSTOM_DOMAIN ? { customShopDomains: [env.SHOP_CUSTOM_DOMAIN] } : {}),
  });
}

export type ShopifyAppInstance = Awaited<ReturnType<typeof createShopify>>;

const g = globalThis as unknown as { __otShopify?: Promise<ShopifyAppInstance> };

export function getShopify(): Promise<ShopifyAppInstance> {
  if (!g.__otShopify) {
    g.__otShopify = createShopify().catch((e) => {
      g.__otShopify = undefined;
      throw e;
    });
  }
  return g.__otShopify;
}

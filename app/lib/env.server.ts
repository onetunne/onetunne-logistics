import { z } from "zod";

/**
 * Централізована перевірка змінних середовища.
 * Секрети читаються лише тут і ніколи не логуються.
 */
const bool = z
  .enum(["true", "false", "1", "0", ""])
  .optional()
  .transform((v) => v === "true" || v === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  DEMO_MODE: bool,
  DEMO_DATA_DIR: z.string().optional(),
  DEMO_PASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  AUTO_MIGRATE: z.enum(["true", "false"]).optional(),
  SHOPIFY_API_KEY: z.string().optional(),
  SHOPIFY_API_SECRET: z.string().optional(),
  SHOPIFY_APP_URL: z.string().optional(),
  SCOPES: z.string().optional(),
  SHOP_CUSTOM_DOMAIN: z.string().optional(),
  OWNER_SHOPIFY_USER_IDS: z.string().optional(),
});

export type AppEnv = z.infer<typeof EnvSchema> & {
  shopifyConfigured: boolean;
  ownerShopifyUserIds: ReadonlySet<string>;
};

let cached: AppEnv | null = null;

export function readEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const parsed = EnvSchema.parse(source);
  const shopifyConfigured = Boolean(
    parsed.SHOPIFY_API_KEY && parsed.SHOPIFY_API_SECRET && parsed.SHOPIFY_APP_URL,
  );
  const env: AppEnv = {
    ...parsed,
    shopifyConfigured,
    ownerShopifyUserIds: new Set(
      (parsed.OWNER_SHOPIFY_USER_IDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  };
  assertSafeConfiguration(env);
  return env;
}

/**
 * Захист: демонстраційний режим не можна випадково увімкнути на робочому сервері
 * з реальними ключами Shopify. Демо завжди працює з окремою локальною базою (PGlite)
 * і ніколи не обходить авторизацію маршрутів /app.
 */
export function assertSafeConfiguration(env: AppEnv): void {
  if (
    env.DEMO_MODE &&
    env.NODE_ENV === "production" &&
    env.shopifyConfigured
  ) {
    throw new Error(
      "DEMO_MODE=true заборонено разом із ключами Shopify у production. " +
        "Розгорніть демо окремим сервісом без SHOPIFY_API_SECRET.",
    );
  }
  if (env.DEMO_MODE && env.DEMO_PASSWORD && !env.SESSION_SECRET) {
    throw new Error("Для DEMO_PASSWORD потрібен SESSION_SECRET (випадковий рядок ≥ 32 символів).");
  }
  if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET має містити щонайменше 32 символи.");
  }
}

export function getEnv(): AppEnv {
  if (!cached) cached = readEnv();
  return cached;
}

/** Лише для тестів. */
export function resetEnvCache(): void {
  cached = null;
}

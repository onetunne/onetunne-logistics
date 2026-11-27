/**
 * Етап 5: підписки на webhooks Shopify для ВЖЕ встановленого застосунку.
 *
 * Підписки реєструються в afterAuth (shopify.server.ts), але afterAuth бібліотека викликає лише тоді, коли активної
 * офлайн-сесії немає (token-exchange), а фоновий обробник оновлює офлайн-токени сам (unauthenticated.admin). Тож після
 * оновлення, що додає теми (етап 5: collections/create|update|delete), наявне встановлення могло б так і не
 * підписатися на нові теми. Тому застосунок зберігає відбиток конфігурації підписок (теми, адреси, SHOPIFY_APP_URL) у
 * shop_installations і під час старту фонового обробника порівнює його з поточним: різниця (або встановлення до
 * етапу 5, коли відбитка ще немає) → registerWebhooks з офлайн-сесією магазину. Власник може запустити це й кнопкою на
 * сторінці «Синхронізація Shopify», там же видно підтверджені теми.
 *
 * registerWebhooks (@shopify/shopify-api) ідемпотентна: читає наявні підписки, створює відсутні, оновлює змінені й
 * видаляє зайві; для актуальної теми повертає порожній перелік операцій.
 */
import { createHash } from "node:crypto";
import { desc, eq, isNull } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { shopInstallations } from "~/db/schema";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { logger } from "~/lib/logger.server";
import { JOB } from "./jobs";
import { WEBHOOK_TOPICS } from "./webhooks.server";

/** Усі підписки застосунку (тема → шлях обробника). Конфігурація shopifyApp будується з цього переліку. */
export const WEBHOOK_SUBSCRIPTIONS: ReadonlyArray<{ topic: string; callbackUrl: string }> = [
  ...WEBHOOK_TOPICS.map((topic) => ({ topic, callbackUrl: "/webhooks/shopify" })),
  { topic: "APP_UNINSTALLED", callbackUrl: "/webhooks/app/uninstalled" },
  { topic: "APP_SCOPES_UPDATE", callbackUrl: "/webhooks/app/scopes_update" },
];

export const ENSURE_WEBHOOKS_DEDUPE_KEY = "shopify.ensure_webhooks";

/** Відбиток конфігурації підписок: зміна тем, шляхів або адреси застосунку → перереєстрація. */
export function webhookConfigKey(appUrl: string): string {
  const canonical = JSON.stringify({
    v: 1,
    appUrl: appUrl.trim().replace(/\/+$/, ""),
    subscriptions: WEBHOOK_SUBSCRIPTIONS.map((s) => `${s.topic} ${s.callbackUrl}`).sort(),
  });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Результат shopify.registerWebhooks (RegisterReturn @shopify/shopify-api): тема → результати операцій (порожній
 * перелік — підписка вже актуальна). undefined — бібліотека отримала THROTTLED і нічого не повернула.
 */
export type WebhookRegisterReturn = Record<string, ReadonlyArray<{ success: boolean }>> | void | undefined;

/** Реєстрація підписок для магазину (робоче середовище: офлайн-сесія; тести — імітація). */
export interface WebhookRegistrar {
  configKey: string;
  register(shop: string): Promise<WebhookRegisterReturn>;
}

export interface WebhookRegistrationOutcome {
  complete: boolean;
  registered: string[];
  failed: string[];
}

/**
 * Записує результат реєстрації: підтверджені теми — завжди (показ), відбиток і час — лише коли ВСІ теми застосунку
 * підтверджено (інакше наступна перевірка спробує знову). Помилки тем поза переліком застосунку (видалення застарілих
 * підписок) не блокують.
 */
export async function recordWebhookRegistration(
  db: DbOrTx,
  shop: string,
  configKey: string,
  result: WebhookRegisterReturn,
  at: Date = new Date(),
): Promise<WebhookRegistrationOutcome> {
  if (!result) return { complete: false, registered: [], failed: WEBHOOK_SUBSCRIPTIONS.map((s) => s.topic) };
  const registered: string[] = [];
  const failed: string[] = [];
  for (const { topic } of WEBHOOK_SUBSCRIPTIONS) {
    const ops = result[topic];
    if (ops && ops.every((op) => op.success)) registered.push(topic);
    else failed.push(topic);
  }
  const complete = failed.length === 0;
  await db
    .update(shopInstallations)
    .set({
      webhookTopics: registered.join(","),
      webhooksConfigKey: complete ? configKey : null,
      ...(complete ? { webhooksRegisteredAt: at } : {}),
      updatedAt: at,
    })
    .where(eq(shopInstallations.shop, shop));
  if (!complete) logger.warn("shopify.webhooks_incomplete", { failed: failed.join(",") });
  return { complete, registered, failed };
}

/** Перевірка підписок у черзі (старт обробника; force — кнопка власника / збій реєстрації в afterAuth). */
export function enqueueWebhookSubscriptionCheck(db: DbOrTx, opts: { force?: boolean; runAt?: Date } = {}): Promise<boolean> {
  return enqueueJob(db, JOB.ensureWebhooks, { force: Boolean(opts.force) }, {
    dedupeKey: opts.force ? `${ENSURE_WEBHOOKS_DEDUPE_KEY}:force` : ENSURE_WEBHOOKS_DEDUPE_KEY,
    maxAttempts: 6,
    ...(opts.runAt ? { runAt: opts.runAt } : {}),
  });
}

export type EnsureWebhooksOutcome = "not_installed" | "up_to_date" | "registered";

/**
 * Обробник завдання shopify.ensure_webhooks: відбиток збігається (і не force) → нічого не робить; інакше —
 * registerWebhooks з офлайн-сесією. Неповна реєстрація → помилка з повтором (видно на сторінці синхронізації).
 */
export async function ensureWebhookSubscriptions(
  db: DbOrTx,
  registrar: WebhookRegistrar,
  opts: { force?: boolean } = {},
): Promise<EnsureWebhooksOutcome> {
  const [shop] = await db
    .select({ shop: shopInstallations.shop, configKey: shopInstallations.webhooksConfigKey })
    .from(shopInstallations)
    .where(isNull(shopInstallations.uninstalledAt))
    .orderBy(desc(shopInstallations.installedAt))
    .limit(1);
  if (!shop) return "not_installed";
  if (!opts.force && shop.configKey === registrar.configKey) return "up_to_date";
  const outcome = await recordWebhookRegistration(db, shop.shop, registrar.configKey, await registrar.register(shop.shop));
  if (!outcome.complete) {
    throw new ShopifyApiError(`Webhook registration incomplete: ${outcome.failed.join(", ")}`, true, "WEBHOOKS_INCOMPLETE");
  }
  logger.info("shopify.webhooks_registered", { topics: outcome.registered.length });
  return "registered";
}

export interface WebhookSubscriptionStatus {
  /** up_to_date — відбиток збігається; outdated — конфігурація змінилася або остання реєстрація неповна; unknown — до етапу 5. */
  state: "up_to_date" | "outdated" | "unknown";
  registered: string[];
  /** Теми застосунку, яких немає серед підтверджених (порожньо, якщо теми ще не записувалися). */
  missing: string[];
  registeredAt: Date | null;
}

/** Стан підписок для сторінки «Синхронізація Shopify». */
export function webhookSubscriptionStatus(
  shop: { webhookTopics: string | null; webhooksConfigKey: string | null; webhooksRegisteredAt: Date | null } | null,
  configKey: string,
): WebhookSubscriptionStatus {
  const registered = (shop?.webhookTopics ?? "").split(",").filter(Boolean);
  const known = shop?.webhookTopics != null;
  const missing = known ? WEBHOOK_SUBSCRIPTIONS.map((s) => s.topic).filter((t) => !registered.includes(t)) : [];
  const state = shop?.webhooksConfigKey === configKey ? "up_to_date" : known ? "outdated" : "unknown";
  return { state, registered, missing, registeredAt: shop?.webhooksRegisteredAt ?? null };
}

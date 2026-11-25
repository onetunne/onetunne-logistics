import type { ActionFunctionArgs } from "react-router";
import { getEnv } from "~/lib/env.server";
import { handleShopifyWebhook } from "~/modules/shopify-sync/webhooks.server";

/**
 * Єдина точка прийому webhooks синхронізації (замовлення, товари, залишки).
 * authenticate.webhook перевіряє HMAC-підпис; неавтентичний запит → 401 від бібліотеки.
 */
export async function action({ request }: ActionFunctionArgs) {
  if (!getEnv().shopifyConfigured) return new Response(null, { status: 503 });
  const { getShopify } = await import("~/shopify.server");
  const { getProductionRuntime } = await import("~/server/production-runtime.server");
  const { topic, shop, webhookId, payload } = await (await getShopify()).authenticate.webhook(request);
  const { db } = (await getProductionRuntime()).handle;
  await handleShopifyWebhook(db, { topic: String(topic), shop, webhookId, payload });
  return new Response();
}

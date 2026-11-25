import type { ActionFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { shopifySessions } from "~/db/schema";
import { getEnv } from "~/lib/env.server";
import { claimWebhook, completeWebhook } from "~/modules/webhooks/dedupe.server";

/** app/uninstalled: видаляємо сесії магазину. Автентичність перевіряє authenticate.webhook (HMAC). */
export async function action({ request }: ActionFunctionArgs) {
  if (!getEnv().shopifyConfigured) return new Response(null, { status: 503 });
  const { getShopify } = await import("~/shopify.server");
  const { getProductionRuntime } = await import("~/server/production-runtime.server");
  const { shop, topic, webhookId } = await (await getShopify()).authenticate.webhook(request);
  const { db } = (await getProductionRuntime()).handle;
  if (!(await claimWebhook(db, { webhookId, topic, shop }))) return new Response();
  try {
    await db.delete(shopifySessions).where(eq(shopifySessions.shop, shop));
    const { recordUninstall } = await import("~/modules/shopify-sync/sync.server");
    await recordUninstall(db, shop);
    await completeWebhook(db, webhookId);
  } catch (e) {
    await completeWebhook(db, webhookId, "processing_failed").catch(() => undefined);
    throw e; // 500 → Shopify повторить доставку, і її буде оброблено
  }
  return new Response();
}

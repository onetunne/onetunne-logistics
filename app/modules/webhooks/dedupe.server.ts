import { eq } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { webhookEvents } from "~/db/schema";

/**
 * Захист від повторної обробки webhooks: Shopify може доставити подію кілька разів.
 * Повертає true, якщо подію з цим X-Shopify-Webhook-Id ще не обробляли.
 */
export async function claimWebhook(
  db: DbOrTx,
  event: { webhookId: string; topic: string; shop: string },
): Promise<boolean> {
  if (!event.webhookId) return true;
  const inserted = await db
    .insert(webhookEvents)
    .values({ webhookId: event.webhookId, topic: event.topic, shop: event.shop })
    .onConflictDoNothing({ target: webhookEvents.webhookId })
    .returning({ id: webhookEvents.id });
  return inserted.length > 0;
}

export async function completeWebhook(db: DbOrTx, webhookId: string, error?: string): Promise<void> {
  if (!webhookId) return;
  await db
    .update(webhookEvents)
    .set({ status: error ? "failed" : "processed", error: error ?? null, processedAt: new Date() })
    .where(eq(webhookEvents.webhookId, webhookId));
}

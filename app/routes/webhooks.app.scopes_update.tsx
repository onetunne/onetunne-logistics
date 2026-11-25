import type { ActionFunctionArgs } from "react-router";
import { eq } from "drizzle-orm";
import { shopifySessions } from "~/db/schema";
import { getEnv } from "~/lib/env.server";
import { claimWebhook, completeWebhook } from "~/modules/webhooks/dedupe.server";

/** app/scopes_update: оновлюємо збережені доступи сесії. */
export async function action({ request }: ActionFunctionArgs) {
  if (!getEnv().shopifyConfigured) return new Response(null, { status: 503 });
  const { getShopify } = await import("~/shopify.server");
  const { getProductionRuntime } = await import("~/server/production-runtime.server");
  const { payload, session, topic, shop, webhookId } = await (await getShopify()).authenticate.webhook(request);
  const { db } = (await getProductionRuntime()).handle;
  if (!(await claimWebhook(db, { webhookId, topic, shop }))) return new Response();
  const current = (payload as { current?: unknown }).current;
  try {
    if (session && Array.isArray(current)) {
      await db.update(shopifySessions).set({ scope: current.map(String).join(",") }).where(eq(shopifySessions.id, session.id));
      const { shopInstallations } = await import("~/db/schema");
      await db
        .update(shopInstallations)
        .set({ scopes: current.map(String).join(","), updatedAt: new Date() })
        .where(eq(shopInstallations.shop, shop));
    }
    await completeWebhook(db, webhookId);
  } catch (e) {
    await completeWebhook(db, webhookId, "processing_failed").catch(() => undefined);
    throw e;
  }
  return new Response();
}

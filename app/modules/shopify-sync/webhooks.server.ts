/**
 * Прийом webhooks Shopify: автентичність (HMAC) перевіряє authenticate.webhook у маршруті;
 * тут — дедуплікація за X-Shopify-Webhook-Id і постановка завдання в чергу. Відповідь швидка (<1 с).
 */
import type { Db } from "~/db/client.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { claimWebhook, completeWebhook } from "~/modules/webhooks/dedupe.server";
import { gidFromPayload } from "./mappers";
import { JOB } from "./sync.server";

/** Теми webhook, на які застосунок підписується (shop-specific, реєструються після встановлення). */
export const WEBHOOK_TOPICS = [
  "ORDERS_CREATE",
  "ORDERS_UPDATED",
  "ORDERS_PAID",
  "ORDERS_CANCELLED",
  "PRODUCTS_CREATE",
  "PRODUCTS_UPDATE",
  "PRODUCTS_DELETE",
  "INVENTORY_LEVELS_UPDATE",
] as const;

export function normalizeTopic(topic: string): string {
  return topic.toUpperCase().replace(/[/.]/g, "_");
}

export interface IncomingWebhook {
  topic: string;
  shop: string;
  webhookId: string;
  payload: Record<string, unknown>;
}

export async function handleShopifyWebhook(db: Db, event: IncomingWebhook): Promise<"queued" | "duplicate" | "ignored"> {
  const topic = normalizeTopic(event.topic);
  if (!(await claimWebhook(db, { webhookId: event.webhookId, topic, shop: event.shop }))) return "duplicate";
  try {
    let queued = false;
    const shop = event.shop;
    if (topic.startsWith("ORDERS_")) {
      const orderGid = gidFromPayload(event.payload, "Order");
      if (orderGid) queued = await enqueueOrQueued(db, JOB.syncOrder, { shop, orderGid, mode: "live" }, `order:${orderGid}`);
    } else if (topic === "PRODUCTS_DELETE") {
      const productGid = gidFromPayload(event.payload, "Product");
      if (productGid) queued = await enqueueOrQueued(db, JOB.deleteProduct, { productGid }, `product-delete:${productGid}`);
    } else if (topic.startsWith("PRODUCTS_")) {
      const productGid = gidFromPayload(event.payload, "Product");
      if (productGid) queued = await enqueueOrQueued(db, JOB.syncProduct, { shop, productGid }, `product:${productGid}`);
    } else if (topic === "INVENTORY_LEVELS_UPDATE") {
      const id = event.payload.inventory_item_id;
      const gid = typeof id === "number" || typeof id === "string" ? `gid://shopify/InventoryItem/${id}` : null;
      if (gid) queued = await enqueueOrQueued(db, JOB.syncInventoryItem, { shop, inventoryItemGid: gid }, `inventory:${gid}`);
    }
    await completeWebhook(db, event.webhookId);
    return queued ? "queued" : "ignored";
  } catch (e) {
    await completeWebhook(db, event.webhookId, "processing_failed").catch(() => undefined);
    throw e;
  }
}

/** Повторна подія для ресурсу, що вже чекає в черзі, не створює нового завдання — це теж успіх. */
async function enqueueOrQueued(db: Db, type: string, payload: Record<string, unknown>, dedupeKey: string) {
  await enqueueJob(db, type, payload, { dedupeKey });
  return true;
}

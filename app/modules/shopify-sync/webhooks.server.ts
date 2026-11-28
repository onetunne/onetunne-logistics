/**
 * Прийом webhooks Shopify: автентичність (HMAC) перевіряє authenticate.webhook у маршруті;
 * тут — дедуплікація за X-Shopify-Webhook-Id і постановка завдання в чергу. Відповідь швидка (<1 с).
 */
import type { Db } from "~/db/client.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { inventoryItemGidFromLevelPayload } from "~/integrations/shopify/inventory-graphql";
import { claimWebhook, completeWebhook } from "~/modules/webhooks/dedupe.server";
import { enqueueFinanceOrderSync } from "~/modules/finance-sync/schedule.server";
import { scheduleCollectionSync } from "./collections.server";
import { gidFromPayload, orderGidFromOrderEditPayload, orderGidFromRefundPayload } from "./mappers";
import { JOB, orderSyncDedupeKey } from "./jobs";

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
  // Етап 5: колекції для шаблонів комплектації (read_products). Зміна товару, через яку він потрапляє в автоматичну
  // колекцію або випадає з неї, collections/update НЕ викликає — це покриває products/update (collections.server.ts).
  "COLLECTIONS_CREATE",
  "COLLECTIONS_UPDATE",
  "COLLECTIONS_DELETE",
  // Етап 6 (docs/stage6-design.md §16.4, read_orders): нове повернення коштів і правка замовлення — фінансові факти
  // (угоди продажу, повернення) перечитуються. Зміна переліку перереєстровує підписки автоматично (webhooksConfigKey).
  "REFUNDS_CREATE",
  "ORDERS_EDITED",
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
    if (topic === "REFUNDS_CREATE" || topic === "ORDERS_EDITED") {
      // Етап 6: id замовлення — з order_id (повернення) / order_edit.order_id (правка), а не з admin_graphql_api_id; до
      // загального правила ORDERS_* (корінь orders/edited — правка, не замовлення). Обидва: синхронізація замовлення
      // (позиції, current_quantity) і фінансів (угоди, повернення).
      const orderGid = topic === "REFUNDS_CREATE" ? orderGidFromRefundPayload(event.payload) : orderGidFromOrderEditPayload(event.payload);
      if (orderGid) {
        await enqueueOrQueued(db, JOB.syncOrder, { shop, orderGid, mode: "live" }, orderSyncDedupeKey(orderGid));
        await enqueueFinanceOrderSync(db, { shop, orderGid });
        queued = true;
      }
    } else if (topic.startsWith("ORDERS_")) {
      const orderGid = gidFromPayload(event.payload, "Order");
      if (orderGid) queued = await enqueueOrQueued(db, JOB.syncOrder, { shop, orderGid, mode: "live" }, `order:${orderGid}`);
    } else if (topic === "PRODUCTS_DELETE") {
      const productGid = gidFromPayload(event.payload, "Product");
      if (productGid) queued = await enqueueOrQueued(db, JOB.deleteProduct, { productGid }, `product-delete:${productGid}`);
    } else if (topic.startsWith("PRODUCTS_")) {
      const productGid = gidFromPayload(event.payload, "Product");
      if (productGid) queued = await enqueueOrQueued(db, JOB.syncProduct, { shop, productGid }, `product:${productGid}`);
    } else if (topic === "COLLECTIONS_DELETE") {
      const collectionGid = gidFromPayload(event.payload, "Collection");
      if (collectionGid) queued = await enqueueOrQueued(db, JOB.deleteCollection, { collectionGid }, `collection-delete:${collectionGid}`);
    } else if (topic === "COLLECTIONS_CREATE" || topic === "COLLECTIONS_UPDATE") {
      // Читання зараз + перевірки через 2 і 15 хв: членство за умовами Shopify оновлює асинхронно (collections.server.ts).
      const collectionGid = gidFromPayload(event.payload, "Collection");
      if (collectionGid) {
        await scheduleCollectionSync(db, shop, collectionGid);
        queued = true;
      }
    } else if (topic === "INVENTORY_LEVELS_UPDATE") {
      // Id з admin_graphql_api_id (рядок): числове inventory_item_id понад 2^53 після JSON.parse неточне.
      const gid = inventoryItemGidFromLevelPayload(event.payload);
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

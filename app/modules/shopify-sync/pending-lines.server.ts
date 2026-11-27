/**
 * Неперенесені зміни позицій замовлення з Shopify (orders.shopify_lines_pending_at).
 *
 * Поки замовлення має активну накладну (або статус уже не дозволяє змін), синхронізація НЕ змінює його позиції:
 * на них спираються накладна, митні позиції, чекліст пакування й резерв складу. Зміну позицій у Shopify
 * (кількість, видалення, повернення, заміна) синхронізація лише фіксує: проблема SHOPIFY_ORDER_CHANGED (поле
 * lineItems) + позначка orders.shopify_lines_pending_at. Позначка — не проблема (попередження можна приховати), тож
 * блокування на неї не залежать від того, чи менеджер закрив попередження.
 *
 * Поки позначка є (і замовлення не передане перевізнику й не скасоване):
 * - нову накладну не створити й не переоформити (createWaybill → blocked `shopify_lines_pending`,
 *   reissueWaybill → not_started), ручна передача перевізнику — лише з явним підтвердженням власника;
 * - пакування й передачу блокують модулі пакування/відстеження через hasPendingShopifyLineChanges.
 * Скасування накладної (замовлення знову «Очікує перевірки») ставить у чергу повторне читання замовлення з Shopify
 * (shopify.sync_order): синхронізація застосовує актуальні позиції (резерв — різницею), знімає позначку й частину
 * lineItems проблеми SHOPIFY_ORDER_CHANGED. Менеджер може поставити читання й вручну (requestShopifyResync).
 */
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { orders, shopInstallations } from "~/db/schema";
import { isShipped } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import type { ServiceContext } from "~/server/types";
import { JOB, orderSyncDedupeKey } from "./jobs";

type PendingOrder = { status: (typeof orders.$inferSelect)["status"]; shopifyLinesPendingAt: Date | null };

/** Чиста перевірка за рядком замовлення: позиції застаріли щодо Shopify й це ще має значення (до передачі). */
export function shopifyLinesPending(order: PendingOrder): boolean {
  return order.shopifyLinesPendingAt !== null && order.status !== "cancelled" && !isShipped(order.status);
}

/**
 * Чи має замовлення неперенесені зміни позицій із Shopify (для блокувань створення накладної, пакування, передачі).
 * Викликайте в транзакції дії після блокування рядка замовлення (loadOrderRow forUpdate), щоб не пропустити
 * паралельну синхронізацію.
 */
export async function hasPendingShopifyLineChanges(db: DbOrTx, orderId: string): Promise<boolean> {
  const [row] = await db
    .select({ status: orders.status, shopifyLinesPendingAt: orders.shopifyLinesPendingAt })
    .from(orders)
    .where(eq(orders.id, orderId));
  return row ? shopifyLinesPending(row) : false;
}

export type ResyncQueueResult = "queued" | "not_shopify" | "no_shop";

/**
 * Ставить у чергу повторне читання замовлення з Shopify (те саме завдання, що й webhook; дедуплікація order:<gid>).
 * Нічого не надсилає в Shopify (лише читання). Без встановленого магазину (демо, тести) — no_shop.
 */
export async function enqueueOrderResync(
  db: DbOrTx,
  order: { source: string; shopifyOrderId: string | null },
): Promise<ResyncQueueResult> {
  if (order.source !== "shopify" || !order.shopifyOrderId) return "not_shopify";
  const [shop] = await db
    .select({ shop: shopInstallations.shop })
    .from(shopInstallations)
    .where(sql`${shopInstallations.uninstalledAt} is null`)
    .orderBy(sql`${shopInstallations.installedAt} desc`)
    .limit(1);
  if (!shop) return "no_shop";
  // false — таке саме завдання вже чекає в черзі (воно прочитає свіжі дані) — для менеджера це теж «у черзі».
  await enqueueJob(db, JOB.syncOrder, { shop: shop.shop, orderGid: order.shopifyOrderId, mode: "live" }, {
    dedupeKey: orderSyncDedupeKey(order.shopifyOrderId),
  });
  return "queued";
}

export type ShopifyResyncResult = ResyncQueueResult | "demo";

/** Дія менеджера «Прочитати замовлення з Shopify ще раз» (orders.edit). Демо — нічого не робить. */
export async function requestShopifyResync(ctx: ServiceContext, orderId: string): Promise<ShopifyResyncResult> {
  requirePermission(ctx.actor, "orders.edit");
  const [order] = await ctx.db
    .select({ id: orders.id, source: orders.source, shopifyOrderId: orders.shopifyOrderId })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order");
  const result: ShopifyResyncResult = ctx.mode === "demo" || ctx.shopify.kind === "demo" ? "demo" : await enqueueOrderResync(ctx.db, order);
  await writeAudit(ctx.db, ctx.actor, "order.shopify_resync_requested", { type: "order", id: order.id }, { result });
  return result;
}

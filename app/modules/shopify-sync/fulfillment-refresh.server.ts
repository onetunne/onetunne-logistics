/**
 * Етап 5: страхове перечитування статусу виконання замовлень, які відправив застосунок (передано перевізнику й далі),
 * коли в базі Shopify досі «не виконано» довше за STALE_FULFILLMENT_AFTER_MS — webhook orders/updated міг загубитися.
 *
 * Навіщо: звірка складу (modules/inventory-sync/reconcile.server.ts, orderTiming) рахує такі одиниці «в дорозі»
 * (у застосунку вже списано, у Shopify ще в committed). Застаріла позначка тримає reservationExcess > 0 і за задумом
 * блокує узгодження й автоприйняття для цього SKU — доки статус у базі не оновиться.
 *
 * Як: ланцюжок планових перевірок (одне очікуване завдання, dedupe; перезапуск сервера не переносить і не множить
 * перевірку). Кожна перевірка спершу планує наступну, потім ставить у чергу повторне читання замовлення
 * (shopify.sync_order у режимі refresh: лише читання Shopify, у Shopify нічого не записується) для не більш ніж
 * FULFILLMENT_REFRESH_BATCH найдавніше перевірених замовлень; кожне — не частіше ніж раз на FULFILLMENT_RECHECK_MS
 * (orders.shopify_fulfillment_checked_at). Режим refresh застосовує дані лише тоді, коли Shopify повідомляє щось нове
 * (новіший updatedAt або інший статус виконання — sync.server.ts refreshFindsNews): загублений webhook так виявляється,
 * а незмінене замовлення не застосовується щодоби вдруге (і не відтворює закриті менеджером проблеми).
 *
 * Кандидати — ті самі замовлення, які звірка складу рахує «в дорозі» (orderTiming, notFulfilled): не «fulfilled», не
 * старе «restocked» і не часткове виконання, що могло зачепити фізичні позиції (вони вже не «в дорозі», а
 * «невизначені»); часткове виконання лише позицій без доставки (shopify_shippable_fulfilled = false) — кандидат.
 *
 * Пропускається, коли застосунок не встановлено або немає дозволу читати замовлення. Дозволи (shopify.dev, access
 * scopes): «`read_orders` provides read access and `write_orders` provides read and write access. Both cover orders
 * created within the last 60 days. For older orders, add `read_all_orders`» — без read_all_orders старші замовлення
 * не перечитуються (Shopify їх не віддасть).
 */
import { and, asc, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { orders, shipments } from "~/db/schema";
import { SHIPPED_STATUSES } from "~/domain/order-status";
import { NOT_FULFILLED_IN_SHOPIFY_SQL } from "~/modules/inventory-sync/reconcile.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { JOB, orderRefreshDedupeKey } from "./jobs";
import { currentShop } from "./sync.server";

export const FULFILLMENT_REFRESH_DEDUPE_KEY = "shopify:fulfillment-refresh";
/** Як часто перевіряти. */
export const FULFILLMENT_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
/** Перша перевірка після старту сервера (якщо в черзі ще немає запланованої). */
export const FULFILLMENT_REFRESH_FIRST_DELAY_MS = 30 * 60_000;
/** Відколи статус вважається застарілим: передано перевізнику понад N днів тому, а Shopify ще не «виконано». */
export const STALE_FULFILLMENT_AFTER_MS = 2 * 24 * 60 * 60_000;
/** Одне замовлення перечитується не частіше ніж раз на добу. */
export const FULFILLMENT_RECHECK_MS = 24 * 60 * 60_000;
/** Замовлень за одну перевірку (кожне — окреме завдання читання). */
export const FULFILLMENT_REFRESH_BATCH = 25;
/** Вікно замовлень без read_all_orders (shopify.dev: «orders created within the last 60 days»). */
export const ORDERS_DEFAULT_READ_WINDOW_MS = 60 * 24 * 60 * 60_000;

const ORDER_READ_SCOPES = ["read_orders", "write_orders"] as const;
const ALL_ORDERS_SCOPE = "read_all_orders";

function scopeList(scopes: string | null | undefined): string[] {
  return (scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Наступна планова перевірка (одне очікуване завдання; уже заплановане не переноситься). */
export function scheduleFulfillmentRefreshCheck(db: DbOrTx, opts: { now?: Date; delayMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  return enqueueJob(db, JOB.fulfillmentRefresh, {}, {
    dedupeKey: FULFILLMENT_REFRESH_DEDUPE_KEY,
    maxAttempts: 3,
    runAt: new Date(now.getTime() + (opts.delayMs ?? FULFILLMENT_REFRESH_INTERVAL_MS)),
  });
}

export type FulfillmentRefreshOutcome =
  | { status: "queued"; orders: number }
  | { status: "nothing_stale" }
  | { status: "not_installed" }
  | { status: "missing_scope" };

/**
 * Замовлення із застарілим статусом виконання: відправлені (SHIPPED_STATUSES), пов'язані з Shopify, у базі «в дорозі»
 * (NOT_FULFILLED_IN_SHOPIFY_SQL з modules/inventory-sync/reconcile.server.ts — те саме правило, що в orderTiming); передані перевізнику (остання накладна з
 * handed_over_at; без неї — дата замовлення) понад STALE_FULFILLMENT_AFTER_MS тому; не перевірені за останні FULFILLMENT_RECHECK_MS; у вікні читання замовлень.
 */
export async function staleFulfillmentOrders(
  db: DbOrTx,
  opts: { now: Date; allOrders: boolean; limit: number },
): Promise<Array<{ id: string; shopifyOrderId: string }>> {
  const staleBefore = new Date(opts.now.getTime() - STALE_FULFILLMENT_AFTER_MS).toISOString();
  const recheckBefore = new Date(opts.now.getTime() - FULFILLMENT_RECHECK_MS).toISOString();
  const windowStart = new Date(opts.now.getTime() - ORDERS_DEFAULT_READ_WINDOW_MS).toISOString();
  const handedOver = sql`coalesce((select max(${shipments.handedOverAt}) from ${shipments} where ${shipments.orderId} = ${orders.id}), ${orders.placedAt})`;
  // Те саме правило, що й «в дорозі» у звірці складу (orderTiming): спільний предикат, не копія.
  const inFlightInDb = NOT_FULFILLED_IN_SHOPIFY_SQL;
  const rows = await db
    .select({ id: orders.id, shopifyOrderId: orders.shopifyOrderId })
    .from(orders)
    .where(
      and(
        inArray(orders.status, [...SHIPPED_STATUSES]),
        isNotNull(orders.shopifyOrderId),
        inFlightInDb,
        sql`${handedOver} <= ${staleBefore}::timestamptz`,
        sql`(${orders.shopifyFulfillmentCheckedAt} is null or ${orders.shopifyFulfillmentCheckedAt} <= ${recheckBefore}::timestamptz)`,
        opts.allOrders ? undefined : sql`${orders.placedAt} >= ${windowStart}::timestamptz`,
      ),
    )
    .orderBy(sql`${orders.shopifyFulfillmentCheckedAt} asc nulls first`, asc(orders.placedAt), asc(orders.id))
    .limit(opts.limit);
  return rows.filter((r): r is { id: string; shopifyOrderId: string } => Boolean(r.shopifyOrderId));
}

/**
 * Обробник планової перевірки: спершу планує наступну (ланцюжок не обривається ні при збої, ні коли нічого
 * перевіряти), потім ставить повторне читання застарілих замовлень (shopify.sync_order, mode refresh; власний dedupe —
 * не поглинає звичайне читання, див. orderRefreshDedupeKey).
 */
export async function runFulfillmentRefresh(db: DbOrTx, now: Date = new Date()): Promise<FulfillmentRefreshOutcome> {
  await scheduleFulfillmentRefreshCheck(db, { now });
  const shop = await currentShop(db);
  if (!shop) return { status: "not_installed" };
  const scopes = scopeList(shop.scopes);
  if (!ORDER_READ_SCOPES.some((s) => scopes.includes(s))) return { status: "missing_scope" };
  const stale = await staleFulfillmentOrders(db, { now, allOrders: scopes.includes(ALL_ORDERS_SCOPE), limit: FULFILLMENT_REFRESH_BATCH });
  if (stale.length === 0) return { status: "nothing_stale" };
  for (const o of stale) {
    await enqueueJob(db, JOB.syncOrder, { shop: shop.shop, orderGid: o.shopifyOrderId, mode: "refresh" }, { dedupeKey: orderRefreshDedupeKey(o.shopifyOrderId) });
  }
  await db
    .update(orders)
    .set({ shopifyFulfillmentCheckedAt: now })
    .where(inArray(orders.id, stale.map((o) => o.id)));
  return { status: "queued", orders: stale.length };
}

/**
 * Етап 6 (WP3): стан і перезапуск початкового заповнення фінансових фактів (docs/stage6-design.md §16.3, §16.4). Без
 * грошей і без проведень (лише стан `finance_state`, черга й лічильники) — тож сервіси власника (facts-view.server.ts)
 * імпортують звідси, а не з внутрішнього scheduled.server.ts.
 *
 * Хто входить у заповнення (`backfillCandidates`): збережені замовлення Shopify (тестові — лише з includeTestOrders) без
 * рядка фактів, а коли магазин має read_all_orders — ще й позначені `order_unreadable` (давні замовлення, які раніше
 * Shopify не віддав: §16.4 рекомендує scope саме для них; без нього вони не перечитуються).
 */
import { and, eq, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { orderShopifyFinance, orders } from "~/db/schema";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { getDefaultStore, updateFinanceState } from "~/modules/finance/core/store.server";
import { scheduleBackfill } from "./schedule.server";

/** Рядок фактів позначено «Shopify не віддає замовлення». */
export const flaggedUnreadable: SQL = sql`${orderShopifyFinance.flags} @> array['order_unreadable']::text[]`;

/**
 * Умова відбору заповнення (запит має `left join order_shopify_finance`): без фактів або (з read_all_orders) недоступні.
 */
export function backfillCandidates(opts: { includeTestOrders: boolean; allOrdersScope: boolean }): SQL {
  return and(
    isNotNull(orders.shopifyOrderId),
    eq(orders.source, "shopify"),
    opts.includeTestOrders ? undefined : eq(orders.shopifyTest, false),
    opts.allOrdersScope ? or(isNull(orderShopifyFinance.orderId), flaggedUnreadable) : isNull(orderShopifyFinance.orderId),
  )!;
}

/**
 * Повторне заповнення (напр. після ввімкнення includeTestOrders або надання read_all_orders): скидає позначку завершення
 * й курсор і ставить завдання. Нічого не видаляє; замовлення з фактами пропускаються (крім недоступних — з
 * read_all_orders). Внутрішня функція (без грошей); зі сторінки — лише через сервіс власника requestFinanceBackfill.
 */
export async function restartFinanceBackfill(db: DbOrTx, now: Date = new Date()): Promise<boolean> {
  const store = await getDefaultStore(db);
  await updateFinanceState(db, { backfilledAt: null, backfillCursor: null }, store.id);
  return scheduleBackfill(db, { now });
}

/**
 * Скільки збережених замовлень Shopify (тестові — лише з includeTestOrders) ще без фактів продажів Shopify: рядка фактів
 * немає або продажі не читалися (недоступне замовлення). Без грошей; для сторінки стану.
 */
export async function countOrdersWithoutFacts(db: DbOrTx): Promise<number> {
  const settings = await loadFinanceSettings(db);
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(orders)
    .leftJoin(orderShopifyFinance, eq(orderShopifyFinance.orderId, orders.id))
    .where(
      and(
        isNotNull(orders.shopifyOrderId),
        eq(orders.source, "shopify"),
        settings.includeTestOrders ? undefined : eq(orders.shopifyTest, false),
        or(isNull(orderShopifyFinance.orderId), sql`${orderShopifyFinance.snapshot}->'status'->>'sales' = 'not_read'`),
      ),
    );
  return Number(row?.n ?? 0);
}

/** Скільки замовлень позначено `order_unreadable` (потрібен read_all_orders, потім requestFinanceBackfill). */
export async function countUnreadableOrders(db: DbOrTx): Promise<number> {
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(orderShopifyFinance).where(flaggedUnreadable);
  return Number(row?.n ?? 0);
}

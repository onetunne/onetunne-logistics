/**
 * Етап 6, WP7: валюта комісії партнера (docs/stage6-design.md §9.3 «Валюта — валюта магазину», §9.5). Виплата закриває
 * баланс комісії (covers_amount + covers_currency) — завжди у валюті КОМІСІЇ, а не у валюті виплати чи звітності:
 * - валюти подій партнера (фактичні нарахування);
 * - інакше (подій ще немає — аванс) — валюта магазину: stores.shop_currency (магазин за замовчуванням), далі валюта
 *   магазину з фактів Shopify / фінансів найновішого замовлення, далі orders.currency найновішого замовлення (етап 2 —
 *   shopMoney, тобто валюта магазину);
 * - не визначено (немає жодного замовлення) — null: виплату не можна прив'язати до балансу комісії.
 * Лише читання (виклики — у сервісах власника з requireFinance).
 */
import { desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { orderFinance, orderShopifyFinance, orders, partnerCommissionEvents, stores } from "~/db/schema";

/** Валюта магазину (див. вгорі файла) або null. */
export async function shopCurrencyOf(db: DbOrTx): Promise<string | null> {
  const [store] = await db.select({ c: stores.shopCurrency }).from(stores).where(eq(stores.isDefault, true));
  if (store?.c) return store.c;
  const [facts] = await db
    .select({ c: orderShopifyFinance.shopCurrency })
    .from(orderShopifyFinance)
    .innerJoin(orders, eq(orders.id, orderShopifyFinance.orderId))
    .where(isNotNull(orderShopifyFinance.shopCurrency))
    .orderBy(desc(orders.placedAt))
    .limit(1);
  if (facts?.c) return facts.c;
  const [fin] = await db
    .select({ c: orderFinance.shopCurrency })
    .from(orderFinance)
    .innerJoin(orders, eq(orders.id, orderFinance.orderId))
    .where(isNotNull(orderFinance.shopCurrency))
    .orderBy(desc(orders.placedAt))
    .limit(1);
  if (fin?.c) return fin.c;
  const [order] = await db.select({ c: orders.currency }).from(orders).orderBy(desc(orders.placedAt)).limit(1);
  return order?.c ? order.c.trim().toUpperCase() : null;
}

export interface CommissionCurrencies {
  /** Валюта, у якій закривається баланс за замовчуванням (одна валюта подій або валюта магазину); null — невідомо. */
  primary: string | null;
  /** Допустимі валюти покриття: валюти подій партнера + валюта магазину. */
  allowed: string[];
}

/** Валюти комісії кількох партнерів (одним запитом подій + валюта магазину). */
export async function commissionCurrenciesOf(db: DbOrTx, partnerIds: readonly string[]): Promise<Map<string, CommissionCurrencies>> {
  const out = new Map<string, CommissionCurrencies>();
  if (partnerIds.length === 0) return out;
  const rows = await db
    .selectDistinct({ partnerId: partnerCommissionEvents.partnerId, currency: partnerCommissionEvents.currency })
    .from(partnerCommissionEvents)
    .where(inArray(partnerCommissionEvents.partnerId, [...partnerIds]))
    .orderBy(sql`1, 2`);
  const shop = await shopCurrencyOf(db);
  for (const id of partnerIds) {
    const own = rows.filter((r) => r.partnerId === id).map((r) => r.currency);
    const allowed = [...new Set([...own, ...(shop ? [shop] : [])])].sort();
    const primary = own.length === 1 ? own[0]! : own.length === 0 ? shop : shop && own.includes(shop) ? shop : null;
    out.set(id, { primary, allowed });
  }
  return out;
}

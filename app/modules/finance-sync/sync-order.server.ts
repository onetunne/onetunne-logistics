/**
 * Етап 6 (WP3): фінансова синхронізація одного замовлення (завдання finance.sync_order, docs/stage6-design.md §16.3).
 * Кроки: OtOrderFinance → якщо Order.updatedAt змінився від останньої фінансової синхронізації (або force) —
 * OtOrderAgreements (+ сторінки, OtAgreementSales) → OtOrderRefunds за потреби → розбір (строгий parseShopifyMoney) →
 * ОДНА транзакція: факти + syncOrderFinance (facts.server.ts). Мережеві читання — до транзакції (блокування не
 * тримаються під час запитів до Shopify). Лише читання Shopify (F11).
 *
 * Замовлення, якого немає в застосунку (неоплачені не зберігаються, етап 2), не синхронізується: синхронізація етапу 2
 * поставить finance.sync_order після збереження. Shopify не віддає замовлення поза вікном читання (старше 60 днів без
 * read_all_orders; порожня відповідь або ACCESS_DENIED) → order_unreadable без повторів (факти, прочитані раніше,
 * лишаються). ACCESS_DENIED для замовлення У вікні читання — це брак дозволу на якесь поле, не «давнє замовлення»:
 * неповторювана помилка завдання (dead, видно на сторінці синхронізації), а не тихий пропуск (§16.4, §16.6).
 *
 * Внутрішній модуль (F8): досягає syncOrderFinance без перевірки актора — лише для завдань (jobs.server.ts); сторінки,
 * маршрути, команди й ШІ його не імпортують (CORE REQUEST: INTERNAL_ONLY_MODULES).
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import { orderRefunds, orderShopifyFinance, orders } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { logger } from "~/lib/logger.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { getDefaultStore } from "~/modules/finance/core/store.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { markOrderUnreadable, rememberShop, writeOrderFinanceFacts, type FinanceRead, type WriteFactsResult } from "./facts.server";
import { parseAgreements, parseOrderFinance, parseRefunds } from "./parse";
import { outsideReadWindow } from "./read-window.server";
import { readAllAgreements, readOrderFinance, readOrderRefunds } from "./read.server";
import type { FinanceSyncOrderPayload } from "./schedule.server";
import { parseSnapshot } from "./snapshot";

/** Результат — лише кількості й коди (без грошей). */
export type FinanceOrderSyncOutcome =
  | ({ status: "synced"; agreementsRead: boolean; refundsRead: boolean } & WriteFactsResult)
  | { status: "stale" }
  | { status: "not_stored" }
  | { status: "not_found" }
  | { status: "unreadable"; marked: boolean; factsKept: boolean };

export interface FinanceOrderSyncDeps {
  db: Db;
  admin: AdminGraphql;
  now?: () => Date;
}

const sameSet = (a: readonly string[], b: ReadonlySet<string>) => a.length === b.size && a.every((x) => b.has(x));

export async function runFinanceOrderSync(deps: FinanceOrderSyncDeps, payload: FinanceSyncOrderPayload): Promise<FinanceOrderSyncOutcome> {
  const now = deps.now?.() ?? new Date();
  const { db } = deps;
  const [order] = await db
    .select({ id: orders.id, placedAt: orders.placedAt })
    .from(orders)
    .where(eq(orders.shopifyOrderId, payload.orderGid));
  if (!order) return { status: "not_stored" };
  const store = await getDefaultStore(db);
  const [existing] = await db
    .select({ snapshot: orderShopifyFinance.snapshot, shopifyUpdatedAt: orderShopifyFinance.shopifyUpdatedAt })
    .from(orderShopifyFinance)
    .where(eq(orderShopifyFinance.orderId, order.id));
  const prev = parseSnapshot(existing?.snapshot);

  let raw;
  let denied = false;
  try {
    raw = await readOrderFinance(deps.admin, payload.orderGid);
  } catch (e) {
    if (!(e instanceof ShopifyApiError && e.code === "ACCESS_DENIED")) throw e;
    denied = true;
    raw = null;
  }
  if (!raw) {
    const shop = await currentShop(db);
    if (!outsideReadWindow(order.placedAt, now, shop?.scopes)) {
      // У вікні читання ACCESS_DENIED — брак дозволу (scope), не давнє замовлення: явна неповторювана помилка.
      if (denied) throw new ShopifyApiError("Shopify denied access to the finance read of an order inside the read window", false, "ACCESS_DENIED");
      return { status: "not_found" };
    }
    const r = await db.transaction((tx) => markOrderUnreadable(tx, SYSTEM_ACTOR, { orderId: order.id, storeId: store.id, now }));
    return { status: "unreadable", ...r };
  }

  const parsed = parseOrderFinance(raw);
  const needAgreements =
    payload.force === true || !existing || prev.status.sales === "not_read" || existing.shopifyUpdatedAt?.getTime() !== parsed.updatedAt.getTime();
  const read: FinanceRead = { order: parsed, agreements: null, refunds: null };
  if (needAgreements) {
    const agreements = await readAllAgreements(deps.admin, payload.orderGid, raw.updatedAt);
    read.agreements = parseAgreements(agreements, parsed);
    // Повернення — лише коли вони є (сума > 0 або угоди повернень) і змінилися id повернень / попереднє читання
    // неповне чи пошкоджене (§16.2: економія балів). Угода повернення з нульовою сумою (повернення на склад без коштів)
    // теж читається: звірка повернень етапу 5 бере restockType/restocked саме з рядків повернень (§14.3 п. 6).
    const storedRefunds = await db
      .select({ gid: orderRefunds.shopifyRefundId })
      .from(orderRefunds)
      .where(and(eq(orderRefunds.orderId, order.id), eq(orderRefunds.storeId, store.id)));
    const stored = new Set(storedRefunds.map((r) => r.gid));
    const total = parsed.totals.totalRefunded?.shop.amount ?? null;
    const anyRefunds = read.agreements.refundGids.length > 0 || total === null || !/^-?0+(\.0+)?$/.test(total);
    const changedIds = !read.agreements.refundGids.every((g) => stored.has(g)) || (stored.size === 0 && anyRefunds);
    const prevIncomplete = prev.status.refunds === "incomplete" || prev.status.refunds === "damaged" || prev.status.refunds === "not_read";
    if (anyRefunds && (changedIds || prevIncomplete || payload.force === true || !sameSet(read.agreements.refundGids, stored))) {
      read.refunds = parseRefunds(await readOrderRefunds(deps.admin, payload.orderGid, raw.updatedAt), parsed);
    }
  }

  const settings = await loadFinanceSettings(db);
  // shop_domain / валюта магазину — ДО транзакції фактів і окремими операторами (див. rememberShop: 40P01 інакше).
  await rememberShop(db, store, payload.shop, parsed.shopCurrency);
  const result = await db.transaction((tx) =>
    writeOrderFinanceFacts(tx, SYSTEM_ACTOR, {
      orderId: order.id,
      shop: payload.shop,
      storeId: store.id,
      now,
      read,
      includeTestOrders: settings.includeTestOrders,
    }),
  );
  if (result.stale) return { status: "stale" };
  if (result.mismatches.length > 0 || result.flags.length > 0) {
    logger.info("finance.sync_order.review", { order: order.id, mismatches: result.mismatches, flags: result.flags });
  }
  return { status: "synced", agreementsRead: read.agreements !== null, refundsRead: read.refunds !== null, ...result };
}

/**
 * Етап 6 (WP3): планові фінансові процеси Shopify (docs/stage6-design.md §16.3). Лише читання Shopify; у демо обробника
 * немає (ensureJobWorker — лише з ключами Shopify), усе там обчислюється при читанні/дії.
 *
 * Звірка змінених замовлень — ланцюжок finance.reconcile_scheduled (кожні 6 год, перший через 10 хв; спершу планує
 * наступний) → finance.reconcile: OtOrdersUpdatedSince від `finance_state.reconcile_watermark − 1 год`, ≤ 20 сторінок за
 * запуск (далі — продовження з курсором тим самим рядком пошуку) → finance.sync_order для збережених замовлень, чиї
 * фінансові факти старші (order_shopify_finance.shopify_updated_at < updatedAt або фактів немає). Тестові — лише з
 * includeTestOrders. Водяний знак = момент старту повного проходу (лише коли прохід завершено).
 *
 * Початкове заповнення — одноразове finance.backfill_orders (ставить ensureSchedules, поки finance_state.backfilled_at
 * порожній): сторінками за id ставить finance.sync_order для кожного збереженого замовлення Shopify без фінансових фактів
 * (тестові — лише з includeTestOrders), рознесено в часі (FINANCE_SYNC_SPACING_MS — у межах бюджету балів); давніші за
 * 60 днів без read_all_orders одразу — order_unreadable, без запиту; з read_all_orders позначені order_unreadable
 * перечитуються (backfillCandidates). Курсор — finance_state.backfill_cursor. Початковий reconcile_watermark = момент
 * старту заповнення.
 *
 * Внутрішній модуль (F8): runFinanceBackfill досягає syncOrderFinance (markOrderUnreadable) без перевірки актора — лише
 * для завдань (jobs.server.ts); сторінки/маршрути/команди/ШІ його не імпортують (CORE REQUEST: INTERNAL_ONLY_MODULES).
 * Стан і перезапуск заповнення для сервісів власника — backfill-status.server.ts; постановка завдань — schedule.server.ts.
 */
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import { orderShopifyFinance, orders } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { ORDERS_UPDATED_SINCE_QUERY, updatedSinceQuery, type GqlOrdersUpdatedSince } from "~/integrations/shopify/finance-graphql";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { ensureFinanceState, getDefaultStore, updateFinanceState } from "~/modules/finance/core/store.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING, financeJobDedupe } from "~/modules/finance/jobs";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { backfillCandidates } from "./backfill-status.server";
import { markOrderUnreadable } from "./facts.server";
import { ALL_ORDERS_SCOPE, hasScope, outsideReadWindow } from "./read-window.server";
import { enqueueFinanceOrderSync, scheduleBackfill, scheduleReconcileChain } from "./schedule.server";

/** Перекриття водяного знаку (годинники Shopify і сервера, затримки індексу пошуку). */
export const RECONCILE_OVERLAP_MS = 60 * 60 * 1000;
/** Без водяного знаку (ще не було ні заповнення, ні звірки) — від стількох днів тому (вікно читання замовлень). */
export const RECONCILE_DEFAULT_LOOKBACK_MS = 60 * 24 * 60 * 60 * 1000;
/** Інтервал між запусками finance.sync_order пакета (≈ 940–1 606 балів на замовлення; відновлення Standard — 100/с). */
export const FINANCE_SYNC_SPACING_MS = 15_000;
/** Замовлень на сторінку початкового заповнення. */
export const BACKFILL_PAGE_SIZE = 50;

export type ReconcileScheduledOutcome = { status: "queued" } | { status: "not_installed" };

/** Ланцюжок звірки: спершу наступна ланка (не обривається ні при збої, ні коли нічого звіряти), потім звірка. */
export async function runReconcileScheduled(db: Db, now: Date = new Date()): Promise<ReconcileScheduledOutcome> {
  await scheduleReconcileChain(db, { now });
  const shop = await currentShop(db);
  if (!shop) return { status: "not_installed" };
  await enqueueJob(db, FINANCE_JOB.reconcile, { shop: shop.shop, after: null }, { dedupeKey: financeJobDedupe.reconcile(null), maxAttempts: 6 });
  return { status: "queued" };
}

export interface ReconcilePayload {
  shop: string;
  /** Курсор продовження (null — новий прохід). */
  after: string | null;
  /** Рядок пошуку та момент старту проходу (для продовжень — ті самі). */
  query?: string;
  startedAt?: string;
}

export interface ReconcileOutcome {
  pages: number;
  seen: number;
  queued: number;
  done: boolean;
}

/**
 * Один запуск звірки (≤ reconcileMaxPages сторінок). Ставить finance.sync_order для збережених замовлень із застарілими
 * фактами; завершений прохід зсуває водяний знак на свій старт.
 */
export async function runFinanceReconcile(deps: { db: Db; admin: AdminGraphql; now?: () => Date }, payload: ReconcilePayload): Promise<ReconcileOutcome> {
  const now = deps.now?.() ?? new Date();
  const { db } = deps;
  const store = await getDefaultStore(db);
  const state = await ensureFinanceState(db, store.id);
  const startedAt = payload.startedAt && !Number.isNaN(Date.parse(payload.startedAt)) ? new Date(payload.startedAt) : now;
  const since = state.reconcileWatermark
    ? new Date(state.reconcileWatermark.getTime() - RECONCILE_OVERLAP_MS)
    : new Date(startedAt.getTime() - RECONCILE_DEFAULT_LOOKBACK_MS);
  const query = payload.query ?? updatedSinceQuery(since);
  const settings = await loadFinanceSettings(db);
  let after = payload.after;
  const out: ReconcileOutcome = { pages: 0, seen: 0, queued: 0, done: false };
  while (out.pages < FINANCE_JOB_TIMING.reconcileMaxPages) {
    const data: GqlOrdersUpdatedSince = await deps.admin<GqlOrdersUpdatedSince>(ORDERS_UPDATED_SINCE_QUERY, { query, after });
    out.pages++;
    const nodes = (data.orders?.nodes ?? []).filter((n) => typeof n?.id === "string" && typeof n.updatedAt === "string");
    out.seen += nodes.length;
    const candidates = nodes.filter((n) => settings.includeTestOrders || n.test !== true);
    if (candidates.length > 0) {
      const rows = await db
        .select({ gid: orders.shopifyOrderId, factsAt: orderShopifyFinance.shopifyUpdatedAt, hasFacts: orderShopifyFinance.orderId })
        .from(orders)
        .leftJoin(orderShopifyFinance, eq(orderShopifyFinance.orderId, orders.id))
        .where(
          inArray(
            orders.shopifyOrderId,
            candidates.map((n) => n.id),
          ),
        );
      const byGid = new Map(rows.map((r) => [r.gid!, r]));
      for (const n of candidates) {
        const r = byGid.get(n.id);
        if (!r) continue; // не збережене (неоплачене) — фінансів немає
        const updatedAt = Date.parse(n.updatedAt);
        const stale = !r.hasFacts || !r.factsAt || !Number.isFinite(updatedAt) || r.factsAt.getTime() < updatedAt;
        if (!stale) continue;
        if (await enqueueFinanceOrderSync(db, { shop: payload.shop, orderGid: n.id }, { now, delayMs: FINANCE_JOB_TIMING.syncOrderDelayMs + out.queued * FINANCE_SYNC_SPACING_MS })) out.queued++;
      }
    }
    const info = data.orders?.pageInfo;
    if (!info?.hasNextPage || !info.endCursor) {
      out.done = true;
      break;
    }
    after = info.endCursor;
  }
  if (out.done) {
    await updateFinanceState(db, { reconcileWatermark: startedAt }, store.id);
  } else {
    await enqueueJob(
      db,
      FINANCE_JOB.reconcile,
      { shop: payload.shop, after, query, startedAt: startedAt.toISOString() },
      { dedupeKey: financeJobDedupe.reconcile(after), maxAttempts: 6, runAt: new Date(now.getTime() + out.queued * FINANCE_SYNC_SPACING_MS) },
    );
  }
  return out;
}

export type BackfillOutcome =
  | { status: "not_installed" }
  | { status: "already_done" }
  | { status: "page"; queued: number; unreadable: number; done: boolean };

/** Одна сторінка початкового заповнення (наступна — окреме завдання, рознесене в часі). */
export async function runFinanceBackfill(db: Db, now: Date = new Date()): Promise<BackfillOutcome> {
  const shop = await currentShop(db);
  if (!shop) return { status: "not_installed" };
  const store = await getDefaultStore(db);
  const state = await ensureFinanceState(db, store.id);
  if (state.backfilledAt) return { status: "already_done" };
  // Початковий водяний знак звірки — момент старту заповнення (новіші зміни підхопить звірка).
  if (!state.backfillCursor && !state.reconcileWatermark) await updateFinanceState(db, { reconcileWatermark: now }, store.id);
  const settings = await loadFinanceSettings(db);
  const allOrdersScope = hasScope(shop.scopes, ALL_ORDERS_SCOPE);
  const page = await db
    .select({ id: orders.id, gid: orders.shopifyOrderId, placedAt: orders.placedAt })
    .from(orders)
    .leftJoin(orderShopifyFinance, eq(orderShopifyFinance.orderId, orders.id))
    .where(
      and(
        backfillCandidates({ includeTestOrders: settings.includeTestOrders, allOrdersScope }),
        state.backfillCursor ? gt(orders.id, state.backfillCursor) : undefined,
      ),
    )
    .orderBy(asc(orders.id))
    .limit(BACKFILL_PAGE_SIZE);
  let queued = 0;
  let unreadable = 0;
  for (const o of page) {
    if (!o.gid) continue;
    if (outsideReadWindow(o.placedAt, now, shop.scopes)) {
      const r = await db.transaction((tx) => markOrderUnreadable(tx, SYSTEM_ACTOR, { orderId: o.id, storeId: store.id, now }));
      if (r.marked) unreadable++;
      continue;
    }
    if (await enqueueFinanceOrderSync(db, { shop: shop.shop, orderGid: o.gid }, { now, delayMs: FINANCE_JOB_TIMING.syncOrderDelayMs + queued * FINANCE_SYNC_SPACING_MS })) queued++;
  }
  const done = page.length < BACKFILL_PAGE_SIZE;
  if (done) {
    await updateFinanceState(db, { backfilledAt: now, backfillCursor: null }, store.id);
  } else {
    await updateFinanceState(db, { backfillCursor: page[page.length - 1]!.id }, store.id);
    await scheduleBackfill(db, { now, delayMs: Math.max(1, queued) * FINANCE_SYNC_SPACING_MS });
  }
  return { status: "page", queued, unreadable, done };
}


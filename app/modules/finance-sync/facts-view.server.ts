/**
 * Етап 6 (WP3): перегляд фактів Shopify замовлення й керування синхронізацією для власника (docs/stage6-design.md §2.4
 * «стан звірки з Shopify, розбіжності, спори», §16). Сервіси читання/керування — requireFinance (дозвіл + роль owner) у
 * КОЖНІЙ функції; працівник отримує ForbiddenError. loadReconciliationState — внутрішнє читання БЕЗ грошей (стан
 * перевірок і розбіжностей) для syncOrderFinance (WP4).
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  financeDiscrepancies,
  orderDisputes,
  orderExternalWaybills,
  orderRefundLines,
  orderRefunds,
  orderSales,
  orderShopifyFinance,
  orderTransactionFees,
  orderTransactions,
  orders,
} from "~/db/schema";
import { RECONCILIATION_CHECKS, type DiscrepancyStatus, type OrderComponent, type ReconciliationCheck } from "~/domain/finance";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { ensureFinanceState } from "~/modules/finance/core/store.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import type { ServiceContext } from "~/server/types";
import { likePrefix, parseReconciliation, partialComponentsOf, reconciliationKeyPrefix, type ReconciliationDiscrepancyState, type ReconciliationResult } from "./reconcile";
import { countOrdersWithoutFacts, countUnreadableOrders, restartFinanceBackfill } from "./backfill-status.server";
import { ALL_ORDERS_SCOPE, hasScope } from "./read-window.server";
import { enqueueFinanceOrderSync } from "./schedule.server";
import { parseSnapshot, type FinanceSyncFlag, type OrderShopifySnapshot, isFinanceSyncFlag } from "./snapshot";

// ---------------------------------------------------------------------------
// Внутрішнє (без грошей): стан звірки для WP4
// ---------------------------------------------------------------------------

export interface ReconciliationState {
  /** Факти Shopify є (рядок order_shopify_finance). */
  hasFacts: boolean;
  /** Статус кожної перевірки (ok / mismatch / unknown / not_applicable) і чи кандидат; null — фактів немає. */
  checks: Record<ReconciliationCheck, { status: string; candidate: boolean }> | null;
  /** Розбіжності звірки замовлення (перевірки RC*, змінені продажі/комісії) зі статусом. */
  discrepancies: ReconciliationDiscrepancyState[];
  /** Складники, які мають бути `partial` (`reconciliation_mismatch`) — §2.6, §16.5. */
  partialComponents: OrderComponent[];
  flags: FinanceSyncFlag[];
  salesStatus: OrderShopifySnapshot["status"]["sales"];
  /** ≠ "complete" — «Оплачено покупцем» і дата оплати неповні (RC2/RC3 unknown). */
  transactionsStatus: OrderShopifySnapshot["status"]["transactions"];
  /** ≠ "complete" — збережені комісії НЕ повний набір (складник комісій не фактичний, F4, §8.1). */
  feesStatus: OrderShopifySnapshot["status"]["fees"];
  refundsStatus: OrderShopifySnapshot["status"]["refunds"];
}

function checkOfKey(orderId: string, key: string): ReconciliationDiscrepancyState["check"] | null {
  for (const c of [...RECONCILIATION_CHECKS, "sale", "fee"] as const) if (key.startsWith(reconciliationKeyPrefix(orderId, c))) return c;
  return null;
}

/** Внутрішнє читання для syncOrderFinance (у його транзакції): лише коди й статуси, без сум. */
export async function loadReconciliationState(db: DbOrTx, orderId: string): Promise<ReconciliationState> {
  const [row] = await db
    .select({ reconciliation: orderShopifyFinance.reconciliation, flags: orderShopifyFinance.flags, snapshot: orderShopifyFinance.snapshot, storeId: orderShopifyFinance.storeId })
    .from(orderShopifyFinance)
    .where(eq(orderShopifyFinance.orderId, orderId));
  const snapshot = parseSnapshot(row?.snapshot);
  const result: ReconciliationResult | null = row ? parseReconciliation(row.reconciliation) : null;
  const rows = await db
    .select({ dedupeKey: financeDiscrepancies.dedupeKey, status: financeDiscrepancies.status })
    .from(financeDiscrepancies)
    .where(
      and(
        eq(financeDiscrepancies.orderId, orderId),
        eq(financeDiscrepancies.type, "reconciliation_mismatch"),
        sql`${financeDiscrepancies.dedupeKey} like ${likePrefix(`reconciliation_mismatch:${orderId}:`)}`,
      ),
    );
  const discrepancies: ReconciliationDiscrepancyState[] = [];
  for (const r of rows) {
    const check = checkOfKey(orderId, r.dedupeKey);
    if (check) discrepancies.push({ check, status: r.status as DiscrepancyStatus });
  }
  const checks = result
    ? (Object.fromEntries(RECONCILIATION_CHECKS.map((c) => [c, { status: result.checks[c].status, candidate: result.checks[c].candidate }])) as ReconciliationState["checks"])
    : null;
  return {
    hasFacts: Boolean(row),
    checks,
    discrepancies,
    partialComponents: partialComponentsOf(result, discrepancies),
    flags: (row?.flags ?? []).filter(isFinanceSyncFlag),
    salesStatus: snapshot.status.sales,
    transactionsStatus: snapshot.status.transactions,
    feesStatus: snapshot.status.fees,
    refundsStatus: snapshot.status.refunds,
  };
}

// ---------------------------------------------------------------------------
// Сервіси власника (requireFinance)
// ---------------------------------------------------------------------------

export interface OrderShopifyFinanceView {
  fetchedAt: string;
  shopifyUpdatedAt: string | null;
  shopCurrency: string | null;
  presentmentCurrency: string | null;
  taxesIncluded: boolean | null;
  edited: boolean | null;
  displayFinancialStatus: string | null;
  returnStatus: string | null;
  paymentGatewayNames: string[];
  discountCodes: string[];
  referralCode: string | null;
  journeyReady: boolean | null;
  journeyChecks: number;
  transactionsCount: number | null;
  flags: FinanceSyncFlag[];
  snapshot: OrderShopifySnapshot;
  reconciliation: ReconciliationResult | null;
  partialComponents: OrderComponent[];
  sales: Array<{
    shopifySaleId: string;
    agreementKind: string;
    happenedAt: string;
    actionType: string;
    lineType: string;
    quantity: number | null;
    totalAmount: string;
    totalTax: string;
    discountBeforeTax: string | null;
    currency: string;
    pTotalAmount: string;
    pCurrency: string;
  }>;
  transactions: Array<{
    shopifyTransactionId: string;
    kind: string;
    status: string;
    test: boolean;
    gateway: string | null;
    amount: string;
    currency: string;
    processedAt: string | null;
    fees: Array<{ type: string | null; amount: string; currency: string; taxAmount: string | null; taxCurrency: string | null }>;
  }>;
  refunds: Array<{
    shopifyRefundId: string;
    processedAt: string | null;
    total: string;
    currency: string;
    lines: Array<{ shopifyLineItemId: string; quantity: number; restockType: string | null; restocked: boolean | null }>;
  }>;
  disputes: Array<{ disputeGid: string; initiatedAs: string | null; status: string | null; outcome: string | null; source: string }>;
  externalWaybills: number;
  openDiscrepancies: number;
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Факти Shopify замовлення для картки «Фінанси замовлення» й «Стан звірки з Shopify» (лише власник; `finance.view`).
 * null — фактів ще немає (картка показує «Немає даних», не нулі).
 */
export async function getOrderShopifyFinance(ctx: Pick<ServiceContext, "db" | "actor">, orderId: string): Promise<OrderShopifyFinanceView | null> {
  requireFinance(ctx, "view");
  const { db } = ctx;
  const [row] = await db.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, orderId));
  if (!row) return null;
  const [sales, transactions, fees, refunds, refundLines, disputes, waybills, discrepancyRows, state] = await Promise.all([
    db.select().from(orderSales).where(eq(orderSales.orderId, orderId)).orderBy(asc(orderSales.happenedAt), asc(orderSales.shopifySaleId)),
    db.select().from(orderTransactions).where(eq(orderTransactions.orderId, orderId)).orderBy(asc(orderTransactions.createdAtShopify), asc(orderTransactions.shopifyTransactionId)),
    db.select().from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId)),
    db.select().from(orderRefunds).where(eq(orderRefunds.orderId, orderId)).orderBy(asc(orderRefunds.createdAtShopify), asc(orderRefunds.shopifyRefundId)),
    db
      .select({ refundId: orderRefundLines.refundId, shopifyLineItemId: orderRefundLines.shopifyLineItemId, quantity: orderRefundLines.quantity, restockType: orderRefundLines.restockType, restocked: orderRefundLines.restocked })
      .from(orderRefundLines)
      .innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId))
      .where(eq(orderRefunds.orderId, orderId)),
    db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId)).orderBy(asc(orderDisputes.firstSeenAt)),
    db.select({ n: sql<number>`count(*)::int` }).from(orderExternalWaybills).where(eq(orderExternalWaybills.orderId, orderId)),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(financeDiscrepancies)
      .where(and(eq(financeDiscrepancies.orderId, orderId), eq(financeDiscrepancies.status, "open"))),
    loadReconciliationState(db, orderId),
  ]);
  return {
    fetchedAt: row.fetchedAt.toISOString(),
    shopifyUpdatedAt: iso(row.shopifyUpdatedAt),
    shopCurrency: row.shopCurrency,
    presentmentCurrency: row.presentmentCurrency,
    taxesIncluded: row.taxesIncluded,
    edited: row.edited,
    displayFinancialStatus: row.displayFinancialStatus,
    returnStatus: row.returnStatus,
    paymentGatewayNames: row.paymentGatewayNames,
    discountCodes: row.discountCodes,
    referralCode: row.referralCode,
    journeyReady: row.journeyReady,
    journeyChecks: row.journeyChecks,
    transactionsCount: row.transactionsCount,
    flags: row.flags.filter(isFinanceSyncFlag),
    snapshot: parseSnapshot(row.snapshot),
    reconciliation: parseReconciliation(row.reconciliation),
    partialComponents: state.partialComponents,
    sales: sales.map((s) => ({
      shopifySaleId: s.shopifySaleId,
      agreementKind: s.agreementKind,
      happenedAt: s.happenedAt.toISOString(),
      actionType: s.actionType,
      lineType: s.lineType,
      quantity: s.quantity,
      totalAmount: s.totalAmount,
      totalTax: s.totalTax,
      discountBeforeTax: s.discountBeforeTax,
      currency: s.currency,
      pTotalAmount: s.pTotalAmount,
      pCurrency: s.pCurrency,
    })),
    transactions: transactions.map((t) => ({
      shopifyTransactionId: t.shopifyTransactionId,
      kind: t.kind,
      status: t.status,
      test: t.test,
      gateway: t.gateway,
      amount: t.amount,
      currency: t.currency,
      processedAt: iso(t.processedAt),
      fees: fees
        .filter((f) => f.transactionId === t.id)
        .map((f) => ({ type: f.type, amount: f.amount, currency: f.currency, taxAmount: f.taxAmount, taxCurrency: f.taxCurrency })),
    })),
    refunds: refunds.map((r) => ({
      shopifyRefundId: r.shopifyRefundId,
      processedAt: iso(r.processedAt),
      total: r.total,
      currency: r.currency,
      lines: refundLines
        .filter((l) => l.refundId === r.id)
        .map((l) => ({ shopifyLineItemId: l.shopifyLineItemId, quantity: l.quantity, restockType: l.restockType, restocked: l.restocked })),
    })),
    disputes: disputes.map((d) => ({ disputeGid: d.disputeGid, initiatedAs: d.initiatedAs, status: d.status, outcome: d.outcome, source: d.source })),
    externalWaybills: Number(waybills[0]?.n ?? 0),
    openDiscrepancies: Number(discrepancyRows[0]?.n ?? 0),
  };
}

export type ResyncOutcome = { status: "queued" | "already_queued" | "demo" | "not_installed" | "not_shopify" };

/**
 * «Перечитати з Shopify» (власник, `finance.manage`): finance.sync_order з force (угоди й повернення перечитуються навіть
 * без зміни updatedAt) одразу. Звичайне завдання того самого замовлення, що вже чекає (напр. +30 с після webhook), стає
 * примусовим і запускається одразу ("queued"); "already_queued" — примусове вже чекає. У демо — нічого (мережі немає).
 * Аудит — лише id.
 */
export async function requestOrderFinanceResync(ctx: ServiceContext, orderId: string): Promise<ResyncOutcome> {
  requireFinance(ctx, "manage");
  if (ctx.mode === "demo") return { status: "demo" };
  const [order] = await ctx.db.select({ gid: orders.shopifyOrderId }).from(orders).where(eq(orders.id, orderId));
  if (!order?.gid) return { status: "not_shopify" };
  const shop = await currentShop(ctx.db);
  if (!shop) return { status: "not_installed" };
  const queued = await enqueueFinanceOrderSync(ctx.db, { shop: shop.shop, orderGid: order.gid, force: true }, { now: ctx.now(), delayMs: 0 });
  await writeAudit(ctx.db, ctx.actor, "finance.shopify_resync_requested", { type: "order", id: orderId }, { queued });
  return { status: queued ? "queued" : "already_queued" };
}

export interface FinanceSyncStatus {
  installed: boolean;
  /** Магазин має read_all_orders (без нього давні замовлення — order_unreadable; §16.4 рекомендує). */
  allOrdersScope: boolean;
  reconcileWatermark: string | null;
  backfilledAt: string | null;
  backfillRunning: boolean;
  /** Збережені замовлення без фактів продажів Shopify (рядка немає або продажі не читалися). */
  ordersWithoutFacts: number;
  /** Позначені order_unreadable: після надання read_all_orders — requestFinanceBackfill перечитує їх. */
  ordersUnreadable: number;
  ordersNeedingReview: number;
}

/** Стан синхронізації фінансів (сторінка налаштувань фінансів / «Потребує уваги»; лише власник, без грошей). */
export async function getFinanceSyncStatus(ctx: Pick<ServiceContext, "db" | "actor">): Promise<FinanceSyncStatus> {
  requireFinance(ctx, "view");
  const state = await ensureFinanceState(ctx.db);
  const shop = await currentShop(ctx.db);
  const [review] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(orderShopifyFinance)
    .where(sql`cardinality(${orderShopifyFinance.flags}) > 0`);
  return {
    installed: Boolean(shop),
    allOrdersScope: hasScope(shop?.scopes, ALL_ORDERS_SCOPE),
    reconcileWatermark: iso(state.reconcileWatermark),
    backfilledAt: iso(state.backfilledAt),
    backfillRunning: !state.backfilledAt && Boolean(state.backfillCursor),
    ordersWithoutFacts: await countOrdersWithoutFacts(ctx.db),
    ordersUnreadable: await countUnreadableOrders(ctx.db),
    ordersNeedingReview: Number(review?.n ?? 0),
  };
}

/**
 * Повторне початкове заповнення (власник, `finance.manage`; напр. після ввімкнення includeTestOrders на тестовому
 * магазині або після надання read_all_orders): замовлення без фактів — і, з read_all_orders, позначені order_unreadable —
 * ставляться в чергу. У демо — нічого.
 */
export async function requestFinanceBackfill(ctx: ServiceContext): Promise<{ status: "queued" | "already_queued" | "demo" | "not_installed" }> {
  requireFinance(ctx, "manage");
  if (ctx.mode === "demo") return { status: "demo" };
  if (!(await currentShop(ctx.db))) return { status: "not_installed" };
  const queued = await restartFinanceBackfill(ctx.db, ctx.now());
  await writeAudit(ctx.db, ctx.actor, "finance.shopify_backfill_requested", { type: "finance_state", id: "default" }, { queued });
  return { status: queued ? "queued" : "already_queued" };
}

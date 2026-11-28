/**
 * Етап 6, WP4: ВНУТРІШНЄ читання фактів замовлення для syncOrderFinance (docs/stage6-design.md §3–§4, §7–§8) — без
 * перевірки актора, з сумами: імпорт у app/pages/**, app/routes/**, команди й інструменти ШІ заборонено (F8; модуль —
 * у запиті до реєстру INTERNAL_ONLY_MODULES ядра). Сторінки читають фінанси лише через сервіси card.server.ts /
 * list.server.ts (requireFinance).
 *
 * Читає (без блокувань рядків — FINANCE_ORDER_LOCK тримає викликач; F10: коригування собівартості НІКОЛИ не бере
 * блокування рядка замовлення): замовлення й позиції, факти Shopify (WP3: продажі, транзакції, комісії, спори, стан
 * звірки), відправлення з розрахунком перевізника, зовнішні номери, перший рух consume_sale, рядки рахунків
 * перевізника, зіставлені із замовленням (WP5 пише їх, WP4 проводить), заморожені прогнози доставки, ручні витрати
 * замовлення (WP6), пакування.
 */
import { and, asc, eq, inArray, isNull, min, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "~/db/client.server";
import {
  carrierInvoiceLines,
  carrierInvoices,
  financeEntries,
  financeExpenses,
  inventoryMovements,
  orderDisputes,
  orderExternalWaybills,
  orderFinance,
  orderLineItems,
  orderPacking,
  orderSales,
  orderShopifyFinance,
  orderTransactionFees,
  orderTransactions,
  orders,
  shipmentCostEstimates,
  shipments,
  shippingForecastSnapshots,
  stockItems,
} from "~/db/schema";
import type { OrderStatus } from "~/domain/order-status";
import { fromMinor, isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import { loadReconciliationState, type ReconciliationState } from "~/modules/finance-sync/facts-view.server";
import { parseSnapshot, type OrderShopifySnapshot } from "~/modules/finance-sync/snapshot";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { normalizeAgreementKind, type DisputeFact, type FeeFact, type InvoiceLineFact, type SaleFact, type TransactionFact } from "./plan";
import type { ActiveEntry } from "./diff";

export interface OrderRowFacts {
  id: string;
  orderNumber: string;
  source: "demo" | "shopify";
  status: OrderStatus;
  currency: string;
  subtotal: string;
  total: string;
  placedAt: Date;
  cancelledAt: Date | null;
  shopifyTest: boolean;
  shipCountryCode: string | null;
  parcelBoxMaterialId: string | null;
}

export interface LineFacts {
  id: string;
  variantId: string | null;
  stockItemId: string | null;
  quantity: number;
  currentQuantity: number | null;
  requiresShipping: boolean | null;
}

export interface ShipmentFacts {
  id: string;
  status: string;
  carrierCode: string;
  waybillNumber: string | null;
  handedOverAt: Date | null;
  createdAt: Date;
  destinationCountry: string | null;
  incoterm: string | null;
  estimate: { amount: string; currency: string; payer: string | null; source: string; currencyAssumed: boolean } | null;
}

export interface ExternalWaybillFacts {
  id: string;
  carrierCode: string | null;
  createdAt: Date;
}

export interface ShopifyFinanceFacts {
  shopCurrency: string | null;
  presentmentCurrency: string | null;
  displayFinancialStatus: string | null;
  paymentGatewayNames: string[];
  discountCodes: string[];
  flags: string[];
  snapshot: OrderShopifySnapshot;
  fetchedAt: Date;
  shopifyUpdatedAt: Date | null;
}

export type OrderFinanceRow = typeof orderFinance.$inferSelect;
export type SnapshotRow = typeof shippingForecastSnapshots.$inferSelect;

export interface OrderFinanceFacts {
  order: OrderRowFacts;
  existing: OrderFinanceRow | null;
  lines: LineFacts[];
  shopify: ShopifyFinanceFacts | null;
  reconciliation: ReconciliationState;
  sales: SaleFact[];
  transactions: TransactionFact[];
  fees: FeeFact[];
  disputes: DisputeFact[];
  shipments: ShipmentFacts[];
  externalWaybills: ExternalWaybillFacts[];
  /** min(created_at) рухів consume_sale замовлення. */
  consumeAt: Date | null;
  invoiceLines: InvoiceLineFact[];
  snapshots: SnapshotRow[];
  /** Категорії діючих ручних витрат із цим замовленням (WP6). */
  manualExpenseCategories: Set<string>;
  /**
   * Σ діючих ручних витрат замовлення за категорією й валютою (додатна — витрата, кредит — від'ємна; лише валюти, що
   * проводяться). Для відкритого замовлення WP6 ще нічого не проводить (§3.3: чекає визнання) — це відома сума, яка
   * стане фактом при визнанні (прогноз з основою `manual`).
   */
  manualExpenseAmounts: Map<string, Array<{ amount: string; currency: string }>>;
  /** Пакування в застосунку: коробка активного пакування. */
  packingBoxMaterialId: string | null;
}

const trimCurrency = (c: string | null) => (c === null ? null : c.trim());

/** Σ ручних витрат за категорією й валютою (BigInt; валюти, що не проводяться, пропускаються). */
function manualAmountsOf(rows: ReadonlyArray<{ category: string; amount: string; currency: string }>): Map<string, Array<{ amount: string; currency: string }>> {
  const by = new Map<string, Map<string, bigint>>();
  for (const r of rows) {
    const currency = r.currency.trim();
    if (!isSupportedCurrency(currency)) continue;
    const m = by.get(r.category) ?? new Map<string, bigint>();
    m.set(currency, (m.get(currency) ?? 0n) + toMinorForCurrency(r.amount, currency));
    by.set(r.category, m);
  }
  const out = new Map<string, Array<{ amount: string; currency: string }>>();
  for (const [category, m] of by) {
    out.set(
      category,
      [...m.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([currency, minor]) => ({ currency, amount: fromMinor(minor) })),
    );
  }
  return out;
}

function snapshotField(snapshot: unknown, path: readonly string[]): string | null {
  let v: unknown = snapshot;
  for (const p of path) {
    if (!v || typeof v !== "object") return null;
    v = (v as Record<string, unknown>)[p];
  }
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Завантажує факти замовлення (null — замовлення не існує). */
export async function loadOrderFinanceFacts(db: DbOrTx, orderId: string): Promise<OrderFinanceFacts | null> {
  const [order] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      source: orders.source,
      status: orders.status,
      currency: orders.currency,
      subtotal: orders.subtotal,
      total: orders.total,
      placedAt: orders.placedAt,
      cancelledAt: orders.cancelledAt,
      shopifyTest: orders.shopifyTest,
      shipCountryCode: orders.shipCountryCode,
      parcelBoxMaterialId: orders.parcelBoxMaterialId,
    })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return null;
  const [existing] = await db.select().from(orderFinance).where(eq(orderFinance.orderId, orderId));
  const lines = await db
    .select({
      id: orderLineItems.id,
      variantId: orderLineItems.variantId,
      stockItemId: stockItems.id,
      quantity: orderLineItems.quantity,
      currentQuantity: orderLineItems.currentQuantity,
      requiresShipping: orderLineItems.requiresShipping,
    })
    .from(orderLineItems)
    .leftJoin(stockItems, eq(stockItems.variantId, orderLineItems.variantId))
    .where(eq(orderLineItems.orderId, orderId))
    .orderBy(asc(orderLineItems.position), asc(orderLineItems.id));
  const [shopifyRow] = await db.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, orderId));
  const reconciliation = await loadReconciliationState(db, orderId);
  const sales = await db.select().from(orderSales).where(eq(orderSales.orderId, orderId)).orderBy(asc(orderSales.happenedAt), asc(orderSales.id));
  const txs = await db.select().from(orderTransactions).where(eq(orderTransactions.orderId, orderId)).orderBy(asc(orderTransactions.processedAt), asc(orderTransactions.id));
  const fees = await db.select().from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId)).orderBy(asc(orderTransactionFees.id));
  const disputes = await db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId)).orderBy(asc(orderDisputes.id));
  const shipmentRows = await db
    .select({ s: shipments, e: shipmentCostEstimates })
    .from(shipments)
    .leftJoin(shipmentCostEstimates, and(eq(shipmentCostEstimates.shipmentId, shipments.id), eq(shipmentCostEstimates.kind, "carrier_reported")))
    .where(eq(shipments.orderId, orderId))
    .orderBy(asc(shipments.createdAt), asc(shipments.id));
  const external = await db
    .select({ id: orderExternalWaybills.id, carrierCode: orderExternalWaybills.carrierCode, createdAt: orderExternalWaybills.createdAt })
    .from(orderExternalWaybills)
    .where(eq(orderExternalWaybills.orderId, orderId))
    .orderBy(asc(orderExternalWaybills.createdAt), asc(orderExternalWaybills.id));
  const [consume] = await db
    .select({ at: min(inventoryMovements.createdAt) })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.orderId, orderId), eq(inventoryMovements.type, "consume_sale")));
  const invoiceRows = await db
    .select({ l: carrierInvoiceLines, d: { id: carrierInvoices.id, status: carrierInvoices.status, posting: carrierInvoices.posting, invoiceDate: carrierInvoices.invoiceDate, importedAt: carrierInvoices.importedAt, carrierCode: carrierInvoices.carrierCode } })
    .from(carrierInvoiceLines)
    .innerJoin(carrierInvoices, eq(carrierInvoices.id, carrierInvoiceLines.invoiceId))
    .where(and(eq(carrierInvoiceLines.orderId, orderId), inArray(carrierInvoiceLines.lineKind, ["charge", "credit"])))
    .orderBy(asc(carrierInvoices.importedAt), asc(carrierInvoiceLines.id));
  const snapshots = await db.select().from(shippingForecastSnapshots).where(eq(shippingForecastSnapshots.orderId, orderId));
  const expenseRows = await db
    .select({ category: financeExpenses.category, amount: financeExpenses.amount, currency: financeExpenses.currency })
    .from(financeExpenses)
    .where(and(eq(financeExpenses.orderId, orderId), eq(financeExpenses.status, "active")))
    .orderBy(asc(financeExpenses.category), asc(financeExpenses.id));
  // Рядки рахунків, за якими для ЦЬОГО замовлення вже проводився запис `inv:` (зокрема сторнований): «перший документ»
  // накладної рахується лише з таких або діючих рядків — документ, замінений чи анульований ще до визнання (відкрите
  // замовлення записів не має), першим фактичним значенням доставки не був (§3.3 R3).
  const postedLineRows = await db
    .selectDistinct({ sourceId: financeEntries.sourceId })
    .from(financeEntries)
    .where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), eq(financeEntries.orderId, orderId), eq(financeEntries.sourceType, "invoice_line"), isNull(financeEntries.reversesEntryId)));
  const postedLines = new Set(postedLineRows.map((r) => (r.sourceId ?? "").toLowerCase()));
  const [packing] = await db
    .select({ boxMaterialId: orderPacking.boxMaterialId })
    .from(orderPacking)
    .where(and(eq(orderPacking.orderId, orderId), inArray(orderPacking.status, ["queued", "in_progress", "packed"])));
  return {
    order: { ...order, currency: order.currency.trim(), shipCountryCode: order.shipCountryCode?.trim().toUpperCase() || null },
    existing: existing ?? null,
    lines,
    shopify: shopifyRow
      ? {
          shopCurrency: trimCurrency(shopifyRow.shopCurrency),
          presentmentCurrency: trimCurrency(shopifyRow.presentmentCurrency),
          displayFinancialStatus: shopifyRow.displayFinancialStatus,
          paymentGatewayNames: shopifyRow.paymentGatewayNames,
          discountCodes: shopifyRow.discountCodes,
          flags: shopifyRow.flags,
          snapshot: parseSnapshot(shopifyRow.snapshot),
          fetchedAt: shopifyRow.fetchedAt,
          shopifyUpdatedAt: shopifyRow.shopifyUpdatedAt,
        }
      : null,
    reconciliation,
    sales: sales.map((s) => ({
      id: s.id,
      agreementKind: normalizeAgreementKind(s.agreementKind),
      happenedAt: s.happenedAt,
      actionType: s.actionType,
      lineType: s.lineType,
      quantity: s.quantity,
      orderLineItemId: s.orderLineItemId,
      totalAmount: s.totalAmount,
      totalTax: s.totalTax,
      discountBeforeTax: s.discountBeforeTax,
      currency: s.currency.trim(),
      pTotalAmount: s.pTotalAmount,
      pTotalTax: s.pTotalTax,
      pCurrency: s.pCurrency.trim(),
      source: s.source,
    })),
    transactions: txs.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      test: t.test,
      gateway: t.gateway,
      amount: t.amount,
      currency: t.currency.trim(),
      processedAt: t.processedAt,
      fxAdjustment: t.fxAdjustment,
      fxAdjustmentCurrency: trimCurrency(t.fxAdjustmentCurrency),
      shopifyId: t.shopifyTransactionId,
      parentShopifyId: t.parentTransactionId,
    })),
    fees: fees.map((f) => ({ id: f.id, transactionId: f.transactionId, type: f.type, amount: f.amount, currency: f.currency.trim(), taxAmount: f.taxAmount, taxCurrency: trimCurrency(f.taxCurrency) })),
    disputes: disputes.map((d) => ({
      id: d.id,
      version: d.version,
      outcome: d.outcome,
      amount: d.amount,
      recoveredAmount: d.recoveredAmount,
      currency: trimCurrency(d.currency),
      fee: d.fee,
      feeCurrency: trimCurrency(d.feeCurrency),
      decidedOn: d.decidedOn,
      vatReducible: d.vatReducible,
      source: d.source,
    })),
    shipments: shipmentRows.map(({ s, e }) => ({
      id: s.id,
      status: s.status,
      carrierCode: s.carrierCode,
      waybillNumber: s.waybillNumber,
      handedOverAt: s.handedOverAt,
      createdAt: s.createdAt,
      destinationCountry: snapshotField(s.requestSnapshot, ["destinationCountry"])?.toUpperCase() ?? null,
      incoterm: snapshotField(s.requestSnapshot, ["customs", "incoterm"]),
      estimate: e ? { amount: e.amount, currency: e.currency.trim(), payer: e.payer, source: e.source, currencyAssumed: e.currencyAssumed } : null,
    })),
    externalWaybills: external,
    consumeAt: consume?.at ?? null,
    invoiceLines: invoiceRows.map(({ l, d }) => ({
      id: l.id,
      invoiceId: d.id,
      importedAt: d.importedAt,
      chargeType: l.chargeType,
      serviceDate: l.chargeDate ?? d.invoiceDate ?? businessDate(d.importedAt),
      amount: l.amount,
      amountExclVat: l.amountExclVat,
      currency: l.currency.trim(),
      carrierCode: d.carrierCode,
      shipmentId: l.shipmentId,
      externalWaybillId: l.externalWaybillId,
      matchVersion: l.matchVersion,
      active: d.status === "active" && d.posting && (l.matchStatus === "matched" || l.matchStatus === "manual"),
      posted: postedLines.has(l.id.toLowerCase()),
    })),
    snapshots,
    manualExpenseCategories: new Set(expenseRows.map((r) => r.category)),
    manualExpenseAmounts: manualAmountsOf(expenseRows),
    packingBoxMaterialId: packing?.boxMaterialId ?? null,
  };
}

/** Джерела записів, якими керує syncOrderFinance (WP6 витрати/частки, WP7 винагорода, WP2 коригування — НЕ тут). */
export const ORDER_FINANCE_SOURCE_TYPES = ["shopify_sale", "shopify_fee", "shopify_transaction", "valuation", "owner_standard", "invoice_line", "chargeback", "owner_confirmation"] as const;

/** Записи-сторно (самоз'єднання журналу: «чи сторновано запис»). */
const reversals = alias(financeEntries, "of_fe_rev");

/** Діючі записи замовлення, якими керує syncOrderFinance (не сторно й не сторновані). */
export async function loadManagedEntries(db: DbOrTx, orderId: string): Promise<ActiveEntry[]> {
  const rows = await db
    .select({
      id: financeEntries.id,
      idempotencyKey: financeEntries.idempotencyKey,
      category: financeEntries.category,
      amount: financeEntries.amount,
      currency: financeEntries.currency,
      orderId: financeEntries.orderId,
      originalOn: financeEntries.originalOn,
      fxOn: financeEntries.fxOn,
      isLateCompletion: financeEntries.isLateCompletion,
    })
    .from(financeEntries)
    .where(
      and(
        eq(financeEntries.storeId, DEFAULT_STORE_ID),
        eq(financeEntries.orderId, orderId),
        isNull(financeEntries.reversesEntryId),
        inArray(financeEntries.sourceType, [...ORDER_FINANCE_SOURCE_TYPES]),
        notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
      ),
    )
    .orderBy(asc(financeEntries.seq));
  return rows.map((r) => ({ ...r, currency: r.currency.trim() }));
}

export interface EntryTotal {
  category: string;
  currency: string;
  amount: string;
  count: number;
}

/** Σ діючих записів замовлення за категорією й валютою (усі джерела — для `actual` складників). */
export async function loadOrderEntryTotals(db: DbOrTx, orderId: string): Promise<EntryTotal[]> {
  const rows = await db
    .select({
      category: financeEntries.category,
      currency: financeEntries.currency,
      amount: sql<string>`sum(${financeEntries.amount})::text`,
      n: sql<number>`count(*)::int`,
    })
    .from(financeEntries)
    .where(
      and(
        eq(financeEntries.storeId, DEFAULT_STORE_ID),
        eq(financeEntries.orderId, orderId),
        isNull(financeEntries.reversesEntryId),
        notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))),
      ),
    )
    .groupBy(financeEntries.category, financeEntries.currency)
    .orderBy(asc(financeEntries.category), asc(financeEntries.currency));
  return rows.map((r) => ({ category: r.category, currency: r.currency.trim(), amount: r.amount, count: Number(r.n) }));
}

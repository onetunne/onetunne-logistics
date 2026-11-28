/**
 * Етап 6 (WP3): запис фактів Shopify замовлення в ОДНІЙ транзакції (docs/stage6-design.md §16.3, §17.3): знімок
 * `order_shopify_finance` (MoneyBag-и, звірка RC1–RC5, прапорці), продажі угод `order_sales` (НЕЗМІННІ: той самий Sale.id з
 * іншими значеннями → розбіжність reconciliation_mismatch, рядок не змінюється), транзакції `order_transactions` (знімок
 * об'єкта: PENDING → SUCCESS оновлює рядок), комісії SUCCESS-транзакцій `order_transaction_fees` (незмінні, як продажі),
 * повернення коштів `order_refunds` / `order_refund_lines`, спори `order_disputes` (без суми; поля власника не
 * змінюються), зовнішні номери накладних — recordExternalWaybills (ядро) — і наприкінці syncOrderFinance(tx, actor,
 * orderId) (WP4) у тій самій транзакції.
 *
 * Внутрішні функції (F8): без перевірки актора (викликають завдання з SYSTEM_ACTOR), результат — лише кількості й коди,
 * без грошей. Модуль — лише для завдань синхронізації (sync-order.server.ts, scheduled.server.ts): НЕ імпортувати зі
 * сторінок, маршрутів, команд чи інструментів ШІ (CORE REQUEST: INTERNAL_ONLY_MODULES). Блокування (F10): рядок
 * замовлення (FOR NO KEY UPDATE, як синхронізація етапу 2) → FINANCE_ORDER_LOCK; два паралельні finance.sync_order
 * одного замовлення виконуються по черзі й дають той самий набір рядків. Рядок `stores` у транзакції фактів НЕ
 * змінюється (лише KEY SHARE від зовнішніх ключів): shop_domain / shop_currency записує rememberShop ДО неї окремим
 * оператором — інакше перші паралельні синхронізації різних замовлень взаємно блокуються (40P01).
 * Фінансові пункти перевірки — лише `finance_discrepancies` і прапорці; `issues` НЕ створюються (I19).
 */
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  financeDiscrepancies,
  jobs,
  orderDisputes,
  orderLineItems,
  orderRefundLines,
  orderRefunds,
  orderSales,
  orderShopifyFinance,
  orderTransactionFees,
  orderTransactions,
  orders,
  stores,
} from "~/db/schema";
import { RECONCILIATION_CHECKS, RESTOCK_TYPE_MIXED, RESTOCK_TYPE_UNKNOWN, type ReconciliationCheck } from "~/domain/finance";
import type { Actor } from "~/domain/permissions";
import { discrepancyKey, autoResolveDiscrepancy, openDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { recordExternalWaybills, type RecordExternalWaybillsResult } from "~/modules/finance/core/waybills.server";
import { financeJobDedupe } from "~/modules/finance/jobs";
import { addMoney } from "~/lib/money";
import { logger } from "~/lib/logger.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";
import { journeyDecision } from "./journey";
import type { Money } from "./money";
import {
  FINANCE_TOTAL_KEYS,
  MAX_STORED_PARSE_ERRORS,
  type FinanceParseError,
  type MoneyPair,
  type ParsedAgreements,
  type ParsedOrderFinance,
  type ParsedRefunds,
  type ParsedSale,
} from "./parse";
import {
  factChangeDedupeParts,
  factChangeKeyPrefix,
  factValueText,
  likePrefix,
  mismatchedChecks,
  reconcileOrder,
  reconciliationDedupeParts,
  reconciliationKeyPrefix,
  unknownReconciliation,
  type CheckResult,
  type ReconciliationResult,
} from "./reconcile";
import { enqueueJourneyRecheck } from "./schedule.server";
import {
  emptySnapshot,
  parseSnapshot,
  type FinanceSyncFlag,
  type OrderShopifySnapshot,
  type RefundsFactStatus,
  type StoredMoney,
} from "./snapshot";

/** Актор синхронізації (posted_by / історія змін): SYSTEM_ACTOR завдань. */
export type FactsActor = Pick<Actor, "id" | "role">;

export interface FinanceRead {
  order: ParsedOrderFinance;
  /** null — угоди цього разу не читалися (updatedAt не змінився). */
  agreements: ParsedAgreements | null;
  /** null — повернення цього разу не читалися. */
  refunds: ParsedRefunds | null;
}

export interface WriteFactsInput {
  orderId: string;
  shop: string;
  storeId: string;
  now: Date;
  read: FinanceRead;
  /** Налаштування finance.includeTestOrders (тестові замовлення без нього не атрибутуються — без повторних читань §9.2). */
  includeTestOrders: boolean;
}

/** Результат — лише кількості й коди (F8: без грошей). */
export interface WriteFactsResult {
  /** Читання старіше за вже записаний знімок (паралельна синхронізація) — нічого не записано. */
  stale: boolean;
  sales: { inserted: number; unchanged: number; changed: number; skipped: boolean };
  transactions: number;
  fees: { inserted: number; changed: number };
  refunds: number;
  refundLines: number;
  disputes: number;
  externalWaybills: RecordExternalWaybillsResult;
  mismatches: ReconciliationCheck[];
  journeyScheduled: boolean;
  flags: FinanceSyncFlag[];
}

const STALE_RESULT: WriteFactsResult = {
  stale: true,
  sales: { inserted: 0, unchanged: 0, changed: 0, skipped: true },
  transactions: 0,
  fees: { inserted: 0, changed: 0 },
  refunds: 0,
  refundLines: 0,
  disputes: 0,
  externalWaybills: { inserted: 0, skipped: 0, invalid: 0, ownShipment: 0 },
  mismatches: [],
  journeyScheduled: false,
  flags: [],
};

const toStored = (p: MoneyPair | null): StoredMoney | null =>
  p ? { amount: p.shop.amount, currency: p.shop.currency, presentmentAmount: p.presentment?.amount ?? null, presentmentCurrency: p.presentment?.currency ?? null } : null;

const ZERO_RE = /^-?0+(\.0+)?$/;

function clipErrors(lists: FinanceParseError[][]): { kept: FinanceParseError[][]; truncated: number } {
  let left = MAX_STORED_PARSE_ERRORS;
  let truncated = 0;
  const kept = lists.map((l) => {
    const take = l.slice(0, Math.max(0, left));
    left -= take.length;
    truncated += l.length - take.length;
    return take;
  });
  return { kept, truncated };
}

/** Рядок замовлення під блокуванням (порядок F10: замовлення → … → фінанси замовлення). */
async function lockOrder(tx: Tx, orderId: string): Promise<void> {
  await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId)).for("no key update");
  await lockFinanceOrder(tx, orderId);
}

async function lineItemIdsByGid(tx: Tx, orderId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: orderLineItems.id, gid: orderLineItems.shopifyLineItemId })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, orderId));
  return new Map(rows.filter((r) => r.gid).map((r) => [r.gid!, r.id]));
}

// ---------------------------------------------------------------------------
// Розбіжності звірки (ключі з reconcile.ts; ніколи не issues)
// ---------------------------------------------------------------------------

const DISCREPANCY_ROW = { dedupeKey: financeDiscrepancies.dedupeKey, status: financeDiscrepancies.status, resolutionCode: financeDiscrepancies.resolutionCode };

async function existingByPrefix(tx: Tx, storeId: string, prefix: string) {
  return tx
    .select(DISCREPANCY_ROW)
    .from(financeDiscrepancies)
    .where(
      and(
        eq(financeDiscrepancies.storeId, storeId),
        eq(financeDiscrepancies.type, "reconciliation_mismatch"),
        sql`${financeDiscrepancies.dedupeKey} like ${likePrefix(prefix)}`,
      ),
    );
}

/** Відкрити (або повторно відкрити закриту СИСТЕМОЮ) розбіжність; рішення власника не перекривається. */
async function ensureOpen(
  tx: Tx,
  actor: FactsActor,
  input: { storeId: string; orderId: string; dedupeKey: string; candidate: boolean; details: Record<string, string | number | boolean | null | string[]> },
  existing: ReadonlyArray<{ dedupeKey: string; status: string; resolutionCode: string | null }>,
) {
  const row = existing.find((e) => e.dedupeKey === input.dedupeKey);
  if (row && (row.status === "open" || row.resolutionCode !== "auto_resolved")) return;
  await openDiscrepancy(tx, actor, {
    type: "reconciliation_mismatch",
    dedupeKey: input.dedupeKey,
    severity: input.candidate ? "warning" : "critical",
    orderId: input.orderId,
    details: input.details,
    storeId: input.storeId,
    reopen: Boolean(row),
  });
}

async function syncCheckDiscrepancies(tx: Tx, actor: FactsActor, storeId: string, orderId: string, result: ReconciliationResult) {
  for (const check of RECONCILIATION_CHECKS) {
    const r: CheckResult = result.checks[check];
    const prefix = reconciliationKeyPrefix(orderId, check);
    const existing = await existingByPrefix(tx, storeId, prefix);
    if (r.status === "mismatch") {
      const key = discrepancyKey("reconciliation_mismatch", ...reconciliationDedupeParts(orderId, check, r));
      for (const e of existing) if (e.status === "open" && e.dedupeKey !== key) await autoResolveDiscrepancy(tx, actor, e.dedupeKey, storeId);
      await ensureOpen(
        tx,
        actor,
        {
          storeId,
          orderId,
          dedupeKey: key,
          candidate: r.candidate,
          details: {
            check,
            candidate: r.candidate,
            expected: r.expected,
            actual: r.actual,
            currency: r.currency,
            reason: r.reason ?? null,
            violations: r.violations ?? null,
          },
        },
        existing,
      );
    } else if (r.status === "ok" || r.status === "not_applicable") {
      for (const e of existing) if (e.status === "open") await autoResolveDiscrepancy(tx, actor, e.dedupeKey, storeId);
    }
    // unknown — перевірити неможливо: наявна розбіжність лишається як є.
  }
}

const clipText = (v: unknown) => factValueText(v).slice(0, 200);

/**
 * Зміна незмінного факту: ключ містить відбиток ПОБАЧЕНИХ значень (рішення власника — саме про цю зміну); інші значення
 * того самого id → нова розбіжність, попередня відкрита закривається системою. У деталях — поля, збережені й побачені
 * значення (десяткові рядки, коди, id, дати — без персональних даних).
 */
async function recordFactChange(
  tx: Tx,
  actor: FactsActor,
  input: { storeId: string; orderId: string; kind: "sale" | "fee"; shopifyId: string; fields: string[]; stored: unknown[]; observed: unknown[] },
) {
  const fields = input.fields.slice(0, 20);
  const stored = input.stored.slice(0, 20).map(clipText);
  const observed = input.observed.slice(0, 20).map(clipText);
  const key = discrepancyKey("reconciliation_mismatch", ...factChangeDedupeParts(input.orderId, input.kind, input.shopifyId, [...fields, ...observed]));
  const existing = await existingByPrefix(tx, input.storeId, factChangeKeyPrefix(input.orderId, input.kind, input.shopifyId));
  for (const e of existing) if (e.status === "open" && e.dedupeKey !== key) await autoResolveDiscrepancy(tx, actor, e.dedupeKey, input.storeId);
  await ensureOpen(
    tx,
    actor,
    {
      storeId: input.storeId,
      orderId: input.orderId,
      dedupeKey: key,
      candidate: false,
      details: { check: input.kind, kind: `${input.kind}_changed`, shopifyId: input.shopifyId, fields, stored, observed },
    },
    existing,
  );
}

/** Значення факту знову збігаються зі збереженими — відкриті розбіжності цього id закриває система. */
async function settleFactChange(tx: Tx, actor: FactsActor, storeId: string, orderId: string, kind: "sale" | "fee", shopifyId: string) {
  const existing = await existingByPrefix(tx, storeId, factChangeKeyPrefix(orderId, kind, shopifyId));
  for (const e of existing) if (e.status === "open") await autoResolveDiscrepancy(tx, actor, e.dedupeKey, storeId);
}

// ---------------------------------------------------------------------------
// Продажі (незмінні)
// ---------------------------------------------------------------------------

type SaleRow = typeof orderSales.$inferInsert;

function saleRow(input: { storeId: string; orderId: string; now: Date; lineIds: Map<string, string> }, a: ParsedAgreements["agreements"][number], s: ParsedSale): SaleRow {
  return {
    storeId: input.storeId,
    orderId: input.orderId,
    shopifySaleId: s.gid,
    agreementId: a.gid,
    agreementKind: a.kind,
    agreementReason: a.reason,
    happenedAt: a.happenedAt,
    refundId: a.refundGid,
    actionType: s.actionType,
    lineType: s.lineType,
    quantity: s.quantity,
    lineItemGid: s.lineItemGid,
    orderLineItemId: s.lineItemGid ? (input.lineIds.get(s.lineItemGid) ?? null) : null,
    totalAmount: s.total.shop.amount,
    totalTax: s.tax.shop.amount,
    discountBeforeTax: s.discountBeforeTax?.shop.amount ?? null,
    currency: s.total.shop.currency,
    pTotalAmount: s.total.presentment.amount,
    pTotalTax: s.tax.presentment.amount,
    pCurrency: s.total.presentment.currency,
    source: "shopify",
    fetchedAt: input.now,
  };
}

/** Поля продажу, які НЕ можуть змінитися (рядок незмінний; інше значення → розбіжність). */
const SALE_IMMUTABLE_FIELDS = [
  "orderId",
  "agreementId",
  "agreementKind",
  "happenedAt",
  "refundId",
  "actionType",
  "lineType",
  "quantity",
  "lineItemGid",
  "totalAmount",
  "totalTax",
  "discountBeforeTax",
  "currency",
  "pTotalAmount",
  "pTotalTax",
  "pCurrency",
] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return (a ?? null) === (b ?? null);
}

async function writeSales(tx: Tx, actor: FactsActor, input: WriteFactsInput, agreements: ParsedAgreements, lineIds: Map<string, string>) {
  const out = { inserted: 0, unchanged: 0, changed: 0, skipped: false };
  if (agreements.status !== "complete") {
    out.skipped = true;
    return out;
  }
  const rows: SaleRow[] = [];
  for (const a of agreements.agreements) for (const s of a.sales) rows.push(saleRow({ ...input, lineIds }, a, s));
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.shopifySaleId);
  const stored = new Map<string, typeof orderSales.$inferSelect>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = await tx
      .select()
      .from(orderSales)
      .where(and(eq(orderSales.storeId, input.storeId), inArray(orderSales.shopifySaleId, ids.slice(i, i + 500))));
    for (const r of chunk) stored.set(r.shopifySaleId, r);
  }
  const fresh = rows.filter((r) => !stored.has(r.shopifySaleId));
  for (let i = 0; i < fresh.length; i += 200) {
    const inserted = await tx
      .insert(orderSales)
      .values(fresh.slice(i, i + 200))
      .onConflictDoNothing({ target: [orderSales.storeId, orderSales.shopifySaleId] })
      .returning({ id: orderSales.id });
    out.inserted += inserted.length;
  }
  for (const r of rows) {
    const s = stored.get(r.shopifySaleId);
    if (!s) continue;
    const differing = SALE_IMMUTABLE_FIELDS.filter((f) => !sameValue(s[f], r[f as keyof SaleRow]));
    if (differing.length > 0) {
      out.changed++;
      await recordFactChange(tx, actor, {
        storeId: input.storeId,
        orderId: input.orderId,
        kind: "sale",
        shopifyId: r.shopifySaleId,
        fields: [...differing],
        stored: differing.map((f) => s[f]),
        observed: differing.map((f) => r[f as keyof SaleRow]),
      });
      continue;
    }
    out.unchanged++;
    await settleFactChange(tx, actor, input.storeId, input.orderId, "sale", r.shopifySaleId);
    // Зв'язок із позицією (не значення продажу): позиція могла з'явитися в застосунку пізніше.
    if (!s.orderLineItemId && r.orderLineItemId) {
      await tx.update(orderSales).set({ orderLineItemId: r.orderLineItemId }).where(eq(orderSales.id, s.id));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Транзакції й комісії
// ---------------------------------------------------------------------------

const FEE_IMMUTABLE_FIELDS = ["transactionId", "type", "amount", "currency", "flatFee", "flatFeeCurrency", "rate", "taxAmount", "taxCurrency"] as const;

async function writeTransactions(tx: Tx, actor: FactsActor, input: WriteFactsInput) {
  const out = { transactions: 0, fees: { inserted: 0, changed: 0 } };
  for (const t of input.read.order.transactions) {
    const values = {
      storeId: input.storeId,
      orderId: input.orderId,
      shopifyTransactionId: t.gid,
      parentTransactionId: t.parentGid,
      kind: t.kind,
      status: t.status,
      test: t.test,
      gateway: t.gateway,
      manualGateway: t.manualGateway,
      amount: t.amount.shop.amount,
      currency: t.amount.shop.currency,
      pAmount: t.amount.presentment?.amount ?? null,
      pCurrency: t.amount.presentment?.currency ?? null,
      settlementCurrency: t.settlementCurrency,
      settlementRate: t.settlementRate,
      fxAdjustmentId: t.fxAdjustment?.gid ?? null,
      fxAdjustment: t.fxAdjustment?.amount?.amount ?? null,
      fxAdjustmentCurrency: t.fxAdjustment?.amount?.currency ?? null,
      processedAt: t.processedAt,
      createdAtShopify: t.createdAt,
      fetchedAt: input.now,
    };
    const { storeId: _s, shopifyTransactionId: _g, ...update } = values;
    const [row] = await tx
      .insert(orderTransactions)
      .values(values)
      .onConflictDoUpdate({ target: [orderTransactions.storeId, orderTransactions.shopifyTransactionId], set: update })
      .returning({ id: orderTransactions.id });
    out.transactions++;
    // Комісії — лише SUCCESS-транзакцій (§8.1); незмінні (інше значення того самого TransactionFee.id → розбіжність).
    if (t.status !== "SUCCESS" || !row) continue;
    for (const f of t.fees) {
      const fee = {
        storeId: input.storeId,
        transactionId: row.id,
        orderId: input.orderId,
        shopifyFeeId: f.gid,
        type: f.type,
        amount: f.amount.amount,
        currency: f.amount.currency,
        flatFee: f.flatFee?.amount ?? null,
        flatFeeCurrency: f.flatFee?.currency ?? null,
        rate: f.rate,
        rateName: f.rateName,
        taxAmount: f.taxAmount?.amount ?? null,
        taxCurrency: f.taxAmount?.currency ?? null,
        createdAtShopify: t.processedAt ?? t.createdAt,
        fetchedAt: input.now,
      };
      const inserted = await tx
        .insert(orderTransactionFees)
        .values(fee)
        .onConflictDoNothing({ target: [orderTransactionFees.storeId, orderTransactionFees.shopifyFeeId] })
        .returning({ id: orderTransactionFees.id });
      if (inserted.length > 0) {
        out.fees.inserted++;
        continue;
      }
      const [stored] = await tx
        .select()
        .from(orderTransactionFees)
        .where(and(eq(orderTransactionFees.storeId, input.storeId), eq(orderTransactionFees.shopifyFeeId, f.gid)));
      if (!stored) continue;
      const differing: Array<(typeof FEE_IMMUTABLE_FIELDS)[number]> = FEE_IMMUTABLE_FIELDS.filter((k) => !sameValue(stored[k], fee[k]));
      if (stored.orderId !== input.orderId) differing.push("transactionId");
      if (differing.length > 0) {
        out.fees.changed++;
        const fields = [...new Set(differing)];
        await recordFactChange(tx, actor, {
          storeId: input.storeId,
          orderId: input.orderId,
          kind: "fee",
          shopifyId: f.gid,
          fields,
          stored: fields.map((k) => stored[k]),
          observed: fields.map((k) => fee[k]),
        });
      } else {
        await settleFactChange(tx, actor, input.storeId, input.orderId, "fee", f.gid);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Повернення коштів, спори
// ---------------------------------------------------------------------------

async function writeRefunds(tx: Tx, input: WriteFactsInput, refunds: ParsedRefunds, lineIds: Map<string, string>) {
  let headers = 0;
  let lines = 0;
  for (const r of refunds.refunds) {
    const values = {
      storeId: input.storeId,
      orderId: input.orderId,
      shopifyRefundId: r.gid,
      processedAt: r.processedAt,
      createdAtShopify: r.createdAt,
      total: r.total.shop.amount,
      currency: r.total.shop.currency,
      pTotal: r.total.presentment?.amount ?? null,
      pCurrency: r.total.presentment?.currency ?? null,
      fetchedAt: input.now,
    };
    const { storeId: _s, shopifyRefundId: _g, ...update } = values;
    const [row] = await tx
      .insert(orderRefunds)
      .values(values)
      .onConflictDoUpdate({ target: [orderRefunds.storeId, orderRefunds.shopifyRefundId], set: update })
      .returning({ id: orderRefunds.id });
    if (!row) continue;
    headers++;
    // Один рядок на позицію (унікальний (refund_id, shopify_line_item_id)): кілька рядків однієї позиції — сума кількостей;
    // різні види повернення на склад → "MIXED" (звірка складу не рахує його поверненим на склад Shopify — консервативно),
    // а розподіл кількості за видом — у restock_quantities (міграція 0013; WP9 рахує повернені одиниці точно).
    const merged = new Map<
      string,
      { quantity: number; restockType: string | null; restocked: boolean | null; subtotal: Money | null; mixedMoney: boolean; byType: Map<string, number> }
    >();
    const typeKey = (t: string | null) => t ?? RESTOCK_TYPE_UNKNOWN;
    for (const l of r.lines) {
      const prev = merged.get(l.lineItemGid);
      const subtotal = l.subtotal?.shop ?? null;
      if (!prev) {
        merged.set(l.lineItemGid, {
          quantity: l.quantity,
          restockType: l.restockType,
          restocked: l.restocked,
          subtotal,
          mixedMoney: false,
          byType: new Map([[typeKey(l.restockType), l.quantity]]),
        });
        continue;
      }
      prev.quantity += l.quantity;
      prev.byType.set(typeKey(l.restockType), (prev.byType.get(typeKey(l.restockType)) ?? 0) + l.quantity);
      if (prev.restockType !== l.restockType) {
        prev.restockType = RESTOCK_TYPE_MIXED;
        prev.restocked = null;
      } else if (prev.restocked !== l.restocked) prev.restocked = null;
      if (prev.subtotal && subtotal && prev.subtotal.currency === subtotal.currency) {
        prev.subtotal = { amount: addMoney(prev.subtotal.amount, subtotal.amount), currency: subtotal.currency };
      } else prev.mixedMoney = true;
    }
    for (const [gid, l] of merged) {
      const subtotal = l.mixedMoney ? null : l.subtotal;
      const lineValues = {
        refundId: row.id,
        shopifyLineItemId: gid,
        orderLineItemId: lineIds.get(gid) ?? null,
        quantity: l.quantity,
        restockType: l.restockType,
        restocked: l.restocked,
        // Лише для об'єднаного MIXED: вид → кількість (ключі впорядковано; Σ = quantity). Інакше null.
        restockQuantities: l.restockType === RESTOCK_TYPE_MIXED ? Object.fromEntries([...l.byType].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : null,
        subtotal: subtotal?.amount ?? null,
        currency: subtotal?.currency ?? null,
      };
      const { refundId: _r, shopifyLineItemId: _l, ...lineUpdate } = lineValues;
      await tx
        .insert(orderRefundLines)
        .values(lineValues)
        .onConflictDoUpdate({ target: [orderRefundLines.refundId, orderRefundLines.shopifyLineItemId], set: lineUpdate });
      lines++;
    }
  }
  return { headers, lines };
}

async function writeDisputes(tx: Tx, input: WriteFactsInput): Promise<number> {
  let n = 0;
  for (const d of input.read.order.disputes) {
    await tx
      .insert(orderDisputes)
      .values({ storeId: input.storeId, orderId: input.orderId, disputeGid: d.gid, initiatedAs: d.initiatedAs, status: d.status, source: "shopify" })
      .onConflictDoUpdate({
        target: [orderDisputes.storeId, orderDisputes.disputeGid],
        set: {
          initiatedAs: sql`excluded.initiated_as`,
          status: sql`excluded.status`,
          statusChangedAt: sql`case when ${orderDisputes.status} is distinct from excluded.status then ${input.now.toISOString()}::timestamptz else ${orderDisputes.statusChangedAt} end`,
          version: sql`case when ${orderDisputes.status} is distinct from excluded.status then ${orderDisputes.version} + 1 else ${orderDisputes.version} end`,
        },
      });
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Знімок, прапорці, звірка
// ---------------------------------------------------------------------------

function totalsOf(order: ParsedOrderFinance): OrderShopifySnapshot["totals"] {
  const out: OrderShopifySnapshot["totals"] = {};
  for (const k of FINANCE_TOTAL_KEYS) out[k] = toStored(order.totals[k]);
  return out;
}

/**
 * Стан повернень після запису: прочитано зараз — стан розбору; угоди не перечитувалися — попередній; угоди прочитано, а
 * повернення не знадобились (id повернень не змінилися) — попередній, або «немає», коли повернень точно немає.
 */
function refundsStatusOf(input: { read: FinanceRead; prev: OrderShopifySnapshot; storedRefunds: number }): RefundsFactStatus {
  const { read, prev } = input;
  if (read.refunds) return read.refunds.status;
  if (!read.agreements) return prev.status.refunds;
  const total = read.order.totals.totalRefunded?.shop.amount ?? null;
  if (input.storedRefunds === 0 && read.agreements.refundGids.length === 0 && total !== null && ZERO_RE.test(total)) return "none";
  return prev.status.refunds === "none" ? "not_read" : prev.status.refunds;
}

/**
 * Запис фактів одного читання + syncOrderFinance — у транзакції викликача (`tx`). Викликач тримає
 * дані читання (read.server.ts + parse.ts); мережі тут немає.
 */
export async function writeOrderFinanceFacts(tx: Tx, actor: FactsActor, input: WriteFactsInput): Promise<WriteFactsResult> {
  const { orderId, storeId, read } = input;
  await lockOrder(tx, orderId);
  const [existing] = await tx.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, orderId)).for("update");
  const prev = parseSnapshot(existing?.snapshot);
  // Паралельне читання новішого стану вже записано (його транзакція завершилась раніше) — старіше не перезаписує знімок.
  if (prev.orderUpdatedAt && Date.parse(prev.orderUpdatedAt) > read.order.updatedAt.getTime()) return { ...STALE_RESULT, stale: true };
  // §2.5: Order.test → orders.shopify_test (авторитетне читання під блокуванням рядка замовлення). Замовлення, збережені до
  // етапу 6 (стовпець — типово false), етап 2 більше не перечитує: їх тестовість стає відомою саме тут (заповнення).
  const testFixed = await tx
    .update(orders)
    .set({ shopifyTest: read.order.test })
    .where(and(eq(orders.id, orderId), ne(orders.shopifyTest, read.order.test)))
    .returning({ id: orders.id });
  if (testFixed.length > 0) logger.info("finance.sync_order.test_flag", { order: orderId, test: read.order.test });
  const lineIds = await lineItemIdsByGid(tx, orderId);

  const sales = read.agreements ? await writeSales(tx, actor, input, read.agreements, lineIds) : { inserted: 0, unchanged: 0, changed: 0, skipped: true };
  const tr = await writeTransactions(tx, actor, input);
  const refundWrite = read.refunds ? await writeRefunds(tx, input, read.refunds, lineIds) : { headers: 0, lines: 0 };
  const disputes = await writeDisputes(tx, input);
  const externalWaybills = await recordExternalWaybills(tx, actor, {
    orderId,
    source: "shopify_fulfillment",
    numbers: read.order.trackingNumbers.map((number) => ({ number })),
    storeId,
  });

  // Стан фактів після запису (звірка рахується з бази: продажі з попередніх читань теж входять у RC1/RC4/RC5).
  const salesStatus = read.agreements ? read.agreements.status : prev.status.sales;
  const storedRefundRows = await tx
    .select({ total: orderRefunds.total, currency: orderRefunds.currency })
    .from(orderRefunds)
    .where(eq(orderRefunds.orderId, orderId));
  const refundsStatus = refundsStatusOf({ read, prev, storedRefunds: storedRefundRows.length });
  const salesRows = await tx
    .select({
      agreementKind: orderSales.agreementKind,
      lineType: orderSales.lineType,
      quantity: orderSales.quantity,
      totalAmount: orderSales.totalAmount,
      totalTax: orderSales.totalTax,
      currency: orderSales.currency,
    })
    .from(orderSales)
    .where(eq(orderSales.orderId, orderId));
  const txRows = await tx
    .select({ kind: orderTransactions.kind, status: orderTransactions.status, amount: orderTransactions.amount, currency: orderTransactions.currency })
    .from(orderTransactions)
    .where(eq(orderTransactions.orderId, orderId));
  const reconciliation = read.order.shopCurrency
    ? reconcileOrder({
        shopCurrency: read.order.shopCurrency,
        currentTotalPrice: read.order.totals.currentTotalPrice?.shop.amount ?? null,
        currentTotalTax: read.order.totals.currentTotalTax?.shop.amount ?? null,
        netPayment: read.order.totals.netPayment?.shop.amount ?? null,
        totalRefunded: read.order.totals.totalRefunded?.shop.amount ?? null,
        sales: salesRows,
        salesStatus,
        transactions: txRows,
        transactionsStatus: read.order.transactionsStatus,
        refundHeaders: refundsStatus === "complete" || refundsStatus === "none" ? storedRefundRows : null,
      })
    : unknownReconciliation("sales_damaged");
  await syncCheckDiscrepancies(tx, actor, storeId, orderId, reconciliation);
  const openFactChanges = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(financeDiscrepancies)
    .where(
      and(
        eq(financeDiscrepancies.storeId, storeId),
        eq(financeDiscrepancies.status, "open"),
        sql`(${financeDiscrepancies.dedupeKey} like ${likePrefix(reconciliationKeyPrefix(orderId, "sale"))} or ${financeDiscrepancies.dedupeKey} like ${likePrefix(reconciliationKeyPrefix(orderId, "fee"))})`,
      ),
    );

  // Відкладені читання customerJourneySummary (§9.2).
  const journeyChecks = existing?.journeyChecks ?? 0;
  const [queuedRetry] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.dedupeKey, financeJobDedupe.journey(read.order.orderGid)), eq(jobs.status, "queued")))
    .limit(1);
  const decision = journeyDecision({
    ready: read.order.journey.ready,
    checks: journeyChecks,
    isTest: read.order.test,
    includeTestOrders: input.includeTestOrders,
    retryQueued: Boolean(queuedRetry),
  });
  let journeyScheduled = false;
  if (decision.scheduleDelayMs !== null) {
    journeyScheduled = await enqueueJourneyRecheck(tx, { shop: input.shop, orderGid: read.order.orderGid, delayMs: decision.scheduleDelayMs }, input.now);
  }

  const parseOrder = read.order.errors;
  const parseSales = read.agreements ? read.agreements.errors : prev.parseErrors.sales;
  const parseRefunds = read.refunds ? read.refunds.errors : prev.parseErrors.refunds;
  const clipped = clipErrors([parseOrder, parseSales, parseRefunds]);
  const unsupported =
    read.order.currencyStatus === "unsupported" || salesStatus === "unsupported_currency" || parseOrder.some((e) => e.code === "unsupported_currency");
  const flags = new Set<FinanceSyncFlag>();
  if (read.order.transactionsStatus === "truncated") flags.add("transactions_truncated");
  if (refundsStatus === "incomplete") flags.add("refunds_incomplete");
  if (parseOrder.length + parseSales.length + parseRefunds.length > 0 || salesStatus === "damaged" || refundsStatus === "damaged") flags.add("amount_parse_error");
  if (unsupported) flags.add("unsupported_currency");
  const mismatches = mismatchedChecks(reconciliation);
  if (mismatches.length > 0 || (openFactChanges[0]?.n ?? 0) > 0) flags.add("reconciliation_mismatch");
  const wasNeverReady = (existing?.flags ?? []).includes("journey_never_ready");
  if (read.order.journey.ready !== true && (decision.neverReady || (wasNeverReady && read.order.journey.ready === false))) flags.add("journey_never_ready");

  const snapshot: OrderShopifySnapshot = {
    ...emptySnapshot(),
    orderUpdatedAt: read.order.updatedAt.toISOString(),
    createdAt: read.order.createdAt?.toISOString() ?? null,
    processedAt: read.order.processedAt?.toISOString() ?? null,
    cancelledAt: read.order.cancelledAt?.toISOString() ?? null,
    test: read.order.test,
    totals: totalsOf(read.order),
    shippingLines: read.order.shippingLines.map((s) => ({ ...s, discountedPrice: toStored(s.discountedPrice), currentDiscountedPrice: toStored(s.currentDiscountedPrice) })),
    status: { sales: salesStatus, transactions: read.order.transactionsStatus, fees: read.order.feesStatus, refunds: refundsStatus },
    agreementsReadFor: read.agreements ? read.order.updatedAt.toISOString() : prev.agreementsReadFor,
    refundGids: read.agreements ? read.agreements.refundGids : prev.refundGids,
    parseErrors: { order: clipped.kept[0]!, sales: clipped.kept[1]!, refunds: clipped.kept[2]! },
    parseErrorsTruncated: clipped.truncated,
  };
  const row = {
    storeId,
    shopCurrency: read.order.shopCurrency,
    presentmentCurrency: read.order.presentmentCurrency,
    taxesIncluded: read.order.taxesIncluded,
    edited: read.order.edited,
    returnStatus: read.order.returnStatus,
    displayFinancialStatus: read.order.displayFinancialStatus,
    paymentGatewayNames: read.order.paymentGatewayNames,
    discountCodes: read.order.discountCodes,
    // Реферальний код — лише з ready = true; поки не готово — попереднє значення (якщо було) не стирається.
    referralCode: read.order.journey.ready === true ? read.order.journey.referralCode : (existing?.referralCode ?? null),
    journeyReady: read.order.journey.ready,
    journeyChecks: journeyChecks + (journeyScheduled ? 1 : 0),
    transactionsCount: read.order.transactionsCount,
    snapshot: snapshot as unknown as Record<string, unknown>,
    reconciliation: reconciliation as unknown as Record<string, unknown>,
    flags: [...flags],
    // Order.updatedAt, для якого прочитано угоди (наступне читання з тим самим updatedAt угод не перечитує).
    shopifyUpdatedAt: read.agreements ? read.order.updatedAt : (existing?.shopifyUpdatedAt ?? null),
    fetchedAt: input.now,
  };
  await tx
    .insert(orderShopifyFinance)
    .values({ orderId, ...row })
    .onConflictDoUpdate({ target: orderShopifyFinance.orderId, set: row });

  // Успішне читання: замовлення доступне (позначки недоступного — і «не читалося», і «пізня зміна» — знімає система).
  for (const key of unreadableKeys(orderId)) await autoResolveDiscrepancy(tx, actor, key, storeId);

  // WP4: фінанси замовлення з новими фактами — та сама транзакція (§16.3).
  await syncOrderFinance(tx, actor, orderId);

  return {
    stale: false,
    sales,
    transactions: tr.transactions,
    fees: tr.fees,
    refunds: refundWrite.headers,
    refundLines: refundWrite.lines,
    disputes,
    externalWaybills,
    mismatches,
    journeyScheduled,
    flags: [...flags],
  };
}

/**
 * §15: shop_domain і валюта магазину за замовчуванням — з першої фінансової синхронізації (не перезаписуються).
 * Викликати ПОЗА транзакцією фактів (окремими короткими операторами, `db`, до writeOrderFinanceFacts): оновлення
 * унікального shop_domain бере FOR UPDATE рядка `stores`, а транзакції фактів тримають на ньому KEY SHARE (зовнішні
 * ключі store_id) — усередині них це дало б взаємне блокування перших паралельних синхронізацій. Нічого не робить, коли
 * обидва значення вже записано (без запису).
 */
export async function rememberShop(
  db: DbOrTx,
  store: { id: string; shopDomain: string | null; shopCurrency: string | null },
  shop: string,
  currency: string | null,
): Promise<void> {
  if (store.shopDomain === null) {
    await db.execute(sql`
      update ${stores} set shop_domain = ${shop}
      where ${stores.id} = ${store.id} and ${stores.shopDomain} is null
        and not exists (select 1 from ${stores} s2 where s2.shop_domain = ${shop})`);
  }
  if (currency && store.shopCurrency === null) {
    await db.update(stores).set({ shopCurrency: currency }).where(and(eq(stores.id, store.id), sql`${stores.shopCurrency} is null`));
  }
}

/** Ключі розбіжностей недоступного замовлення: фактів ще немає / пізня зміна замовлення з фактами. */
function unreadableKeys(orderId: string): [string, string] {
  return [discrepancyKey("order_unreadable", orderId), discrepancyKey("order_unreadable", orderId, "later")];
}

/**
 * Замовлення, яке Shopify не віддає (старше 60 днів без read_all_orders, §16.3, §22.1): позначка order_unreadable +
 * розбіжність order_unreadable («Потребує перевірки»). Без запиту до Shopify.
 * - Фактів ще немає (продажі не читалися) — WP4 переводить замовлення в «Оцінку» (order_snapshot); ключ
 *   `order_unreadable:<id>` (рішення власника не перекривається повторними спробами).
 * - Факти вже прочитано раніше (напр. webhook повернення за старим замовленням) — збережені факти й стан продажів НЕ
 *   змінюються (виручка лишається фактичною), але пізнішої зміни не прочитано: прапорець + розбіжність
 *   `order_unreadable:<id>:later` (`later_change_unreadable`); кожна нова непрочитана зміна відкриває її знову.
 * Обидві знімає наступне успішне читання (writeOrderFinanceFacts).
 */
export async function markOrderUnreadable(
  tx: Tx,
  actor: FactsActor,
  input: { orderId: string; storeId: string; now: Date },
): Promise<{ marked: boolean; factsKept: boolean }> {
  await lockOrder(tx, input.orderId);
  const [existing] = await tx.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, input.orderId)).for("update");
  const prev = parseSnapshot(existing?.snapshot);
  const flags = [...new Set([...(existing?.flags ?? []), "order_unreadable"])];
  const [neverReadKey, laterKey] = unreadableKeys(input.orderId);
  if (existing && prev.status.sales !== "not_read") {
    // Факти лишаються чинними; лише позначка «пізню зміну не прочитано» (fetched_at не змінюється — нових фактів немає).
    await tx.update(orderShopifyFinance).set({ flags }).where(eq(orderShopifyFinance.orderId, input.orderId));
    await openDiscrepancy(tx, actor, {
      type: "order_unreadable",
      dedupeKey: laterKey,
      orderId: input.orderId,
      details: { reason: "later_change_unreadable", scope: "read_all_orders" },
      storeId: input.storeId,
      reopen: true,
    });
    await syncOrderFinance(tx, actor, input.orderId);
    return { marked: true, factsKept: true };
  }
  if (existing) {
    await tx.update(orderShopifyFinance).set({ flags, fetchedAt: input.now }).where(eq(orderShopifyFinance.orderId, input.orderId));
  } else {
    await tx
      .insert(orderShopifyFinance)
      .values({
        orderId: input.orderId,
        storeId: input.storeId,
        flags,
        snapshot: emptySnapshot() as unknown as Record<string, unknown>,
        reconciliation: unknownReconciliation("sales_not_read") as unknown as Record<string, unknown>,
        fetchedAt: input.now,
      })
      .onConflictDoNothing({ target: orderShopifyFinance.orderId });
  }
  await openDiscrepancy(tx, actor, {
    type: "order_unreadable",
    dedupeKey: neverReadKey,
    orderId: input.orderId,
    details: { reason: "older_than_read_window", scope: "read_all_orders" },
    storeId: input.storeId,
  });
  await syncOrderFinance(tx, actor, input.orderId);
  return { marked: true, factsKept: false };
}

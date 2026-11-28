/**
 * Етап 6, WP6: місяці — чек-лист, підтвердження, закриття й повторне відкриття (docs/stage6-design.md §3.4, §2.7,
 * §13.1, §17.8). Сервіси власника (requireFinance: читання — view, зміни — manage).
 *
 * - Закрити можна лише повністю минулий місяць (Київ) без жодного ■ (checklist.ts). Закриття — під FINANCE_OP_LOCK
 *   місяця й ЕКСКЛЮЗИВНИМ FINANCE_PERIOD_LOCK: проведення й ручні зміни, датовані місяцем, беруть його спільно, тож
 *   паралельна витрата дає або відмову, або запис до закриття — ніколи після (§20.3). Після закриття системні факти
 *   місяця проводяться датою проведення з «Пізній запис» (postEntries, I12), ручні — відхиляються (assertMonthOpen).
 * - При закритті — НЕЗМІННІ остаточні знімки (`is_final`, джерело `close`) у КОЖНІЙ валюті показу
 *   (`finance.displayCurrencies` + валюта звітності): дані — buildReportData (WP8; викликається в транзакції закриття
 *   ДО зміни статусу, тож бачить місяць живим), збереження — saveReportSnapshot ядра (version + 1). У даних знімка
 *   WP6 фіксує назву прибутку закритого місяця (§2.7), net_profit_eligible і закриті місяці повноти.
 * - Усі ☐ підтверджено → `net_profit_eligible` (назва «Чистий прибуток», profitLabelFor).
 * - Повторне відкриття — лише з причиною; старі знімки лишаються; наступне закриття — нова версія знімка.
 * - Підтвердження ☐ — лише у відкритому місяці; «внесено» / «немає» узгоджуються з діючими записами місяця й
 *   витратами періоду, датованими місяцем, — під час збереження І при кожному обчисленні чек-листа (закриття бере
 *   перевірений результат: застаріле підтвердження → без «Чистого прибутку»). Зміна пункту
 *   упаковки перераховує фінанси замовлень, визнаних у місяці (syncOrderFinance WP4: упаковка not_applicable з
 *   причиною packaging_accounted_in_total).
 */
import { and, asc, count, desc, eq, gte, inArray, isNull, lte, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { Db, DbOrTx, Tx } from "~/db/client.server";
import {
  financeDiscrepancies,
  financeEntries,
  financeExpenses,
  financePeriods,
  financeReportSnapshots,
  inventoryCostState,
  orderFinance,
  orderFinanceForecasts,
} from "~/db/schema";
import { isSupportedCurrency } from "~/lib/decimal";
import { ConflictError, DomainError } from "~/lib/errors";
import { addMonths, businessDate, isFullyPastMonth, isMonthStart, monthEnd, monthStart, parseIsoDate } from "~/lib/periods";
import { writeAudit } from "~/modules/audit/audit.server";
import { requireFinance } from "~/modules/finance/core/access.server";
import { listFinanceChanges, writeFinanceChange, type FinanceChangeRow } from "~/modules/finance/core/change-log.server";
import type { BuildReportData, ReportData } from "~/modules/finance/core/contracts";
import { lockFinanceOperation, lockFinancePeriodExclusive, lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { saveReportSnapshot } from "~/modules/finance/core/snapshots.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { buildReportData as defaultBuildReportData } from "~/modules/finance-analytics/report-data.server";
import { createRateResolver, rateWindowOf } from "~/modules/fx/rate-for.server";
import { syncOrderFinance } from "~/modules/order-finance/sync.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import { businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { AppMode, ServiceContext } from "~/server/types";
import {
  allowedConfirmValues,
  checklistForLog,
  CONFIRM_ITEM_CATEGORIES,
  CONFIRM_ITEMS,
  confirmationError,
  evaluateChecklist,
  isConfirmItem,
  isConfirmValue,
  type ChecklistFacts,
  type ChecklistResult,
  type ConfirmItem,
  type ConfirmValue,
} from "./checklist";

const reversals = alias(financeEntries, "fe_period_rev");

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;
export type PeriodRow = typeof financePeriods.$inferSelect;
export const PERIOD_REASON_MAX = 300;

/** Збережений чек-лист (finance_periods.checklist). */
export interface StoredChecklist {
  confirm: Partial<Record<ConfirmItem, ConfirmValue>>;
  /** Кількості пунктів на момент закриття (плаский вигляд). */
  closing?: Record<string, string | number | boolean | null>;
}

export function storedChecklist(value: unknown): StoredChecklist {
  const v = (value ?? {}) as { confirm?: Record<string, unknown>; closing?: Record<string, string | number | boolean | null> };
  const confirm: Partial<Record<ConfirmItem, ConfirmValue>> = {};
  for (const [k, val] of Object.entries(v.confirm ?? {})) {
    if (isConfirmItem(k) && typeof val === "string" && isConfirmValue(val) && allowedConfirmValues(k).includes(val)) confirm[k] = val;
  }
  return { confirm, ...(v.closing ? { closing: v.closing } : {}) };
}

function assertMonth(month: string): string {
  const m = parseIsoDate(month);
  if (!m || !isMonthStart(m)) throw new DomainError("financeExpenses.error.monthInvalid", 400);
  return m;
}

const monthLockKey = (storeId: string, month: string) => `period|${storeId}|${month}`;

export async function loadPeriodRow(db: DbOrTx, month: string, storeId: string = DEFAULT_STORE_ID): Promise<PeriodRow | null> {
  const [row] = await db.select().from(financePeriods).where(and(eq(financePeriods.storeId, storeId), eq(financePeriods.month, month)));
  return row ?? null;
}

/**
 * Внутрішнє (WP4): чи підтвердив власник «Упаковку … обліковано загальною сумою» для місяця (без перевірки актора) — і
 * чи загальна сума упаковки місяця досі є в журналі (анульована сума робить підтвердження застарілим: false, складник
 * упаковки повертається до прогнозу).
 */
export async function isPackagingAccountedInTotal(db: DbOrTx, month: string, storeId: string = DEFAULT_STORE_ID): Promise<boolean> {
  const m = monthStart(month);
  const row = await loadPeriodRow(db, m, storeId);
  if (storedChecklist(row?.checklist).confirm.packaging_total_accounted !== "entered") return false;
  return (await confirmItemEntries(db, m, "packaging_total_accounted")) > 0;
}

const activeEntry = (db: DbOrTx): SQL =>
  and(isNull(financeEntries.reversesEntryId), notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))))!;

const inMonth = (col: typeof financeEntries.recognizedOn | typeof orderFinance.recognizedOn, month: string) => and(gte(col, month), lte(col, monthEnd(month)))!;

/**
 * Діючі записи місяця пункту ☐ (не сторно й не сторновані; для упаковки — лише загальні суми: packaging_unlinked або
 * упаковка без замовлення). Внутрішнє — лише кількість.
 */
export async function confirmItemEntries(db: DbOrTx, month: string, item: ConfirmItem): Promise<number> {
  const cats = CONFIRM_ITEM_CATEGORIES[item];
  const catCond =
    item === "packaging_total_accounted"
      ? or(eq(financeEntries.category, "packaging_unlinked"), and(eq(financeEntries.category, "packaging"), isNull(financeEntries.orderId)))!
      : inArray(financeEntries.category, [...cats]);
  const [row] = await db
    .select({ c: count() })
    .from(financeEntries)
    .where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), inMonth(financeEntries.recognizedOn, month), catCond, activeEntry(db)));
  return Number(row?.c ?? 0);
}

/**
 * Діючі ручні витрати періоду (без замовлення) пункту ☐, датовані місяцем (дата в місяці або період послуги перетинає
 * його): сума, частки якої лягли в інший місяць (визнання замовлень) або ще чекають визнання, — теж «внесено» для свого
 * місяця (§10.3). Упаковка — 0 (пункт стосується загальних сум у журналі). Внутрішнє — лише кількість.
 */
export async function confirmItemExpenses(db: DbOrTx, month: string, item: ConfirmItem): Promise<number> {
  if (item === "packaging_total_accounted") return 0;
  const cats = CONFIRM_ITEM_CATEGORIES[item];
  const to = monthEnd(month);
  const [row] = await db
    .select({ c: count() })
    .from(financeExpenses)
    .where(
      and(
        eq(financeExpenses.storeId, DEFAULT_STORE_ID),
        eq(financeExpenses.status, "active"),
        isNull(financeExpenses.orderId),
        inArray(financeExpenses.category, [...cats]),
        or(
          and(gte(financeExpenses.expenseDate, month), lte(financeExpenses.expenseDate, to)),
          and(lte(financeExpenses.periodFrom, to), gte(financeExpenses.periodTo, month)),
        ),
      ),
    );
  return Number(row?.c ?? 0);
}

/** Записи + витрати місяця пункту ☐ — для узгодження «внесено» / «за місяць немає». */
async function confirmItemRecords(db: DbOrTx, month: string, item: ConfirmItem): Promise<number> {
  return (await confirmItemEntries(db, month, item)) + (await confirmItemExpenses(db, month, item));
}

/** Валюти показу для чек-листа й знімків: finance.displayCurrencies + валюта звітності (без дублів). */
export function displayCurrenciesOf(settings: { displayCurrencies: readonly string[]; reportingCurrency: string }): string[] {
  return [...new Set([settings.reportingCurrency, ...settings.displayCurrencies])].filter(isSupportedCurrency);
}

/** Факти чек-листа місяця (лише кількості). */
export async function computeChecklistFacts(
  db: DbOrTx,
  month: string,
  opts: { mode: AppMode; today: string; displayCurrencies: readonly string[]; confirmations: Partial<Record<ConfirmItem, ConfirmValue>> },
): Promise<ChecklistFacts> {
  const end = monthEnd(month);
  const recognizedInMonth = and(eq(orderFinance.storeId, DEFAULT_STORE_ID), eq(orderFinance.state, "recognized"), inMonth(orderFinance.recognizedOn, month))!;
  const [orderStats] = await db
    .select({
      total: count(),
      notFinal: sql<number>`count(*) filter (where ${orderFinance.profitState} <> 'final')`,
      review: sql<number>`count(*) filter (where ${orderFinance.needsReview})`,
    })
    .from(orderFinance)
    .where(recognizedInMonth);
  // Курси для КОЖНОЇ валюти показу на дату курсу кожного запису місяця (зокрема пізніх і сторно).
  const pairs = await db
    .select({ currency: financeEntries.currency, fxOn: financeEntries.fxOn, n: count() })
    .from(financeEntries)
    .where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), inMonth(financeEntries.recognizedOn, month)))
    .groupBy(financeEntries.currency, financeEntries.fxOn);
  const entriesWithoutRate: Record<string, number> = Object.fromEntries(opts.displayCurrencies.map((c) => [c, 0]));
  let entries = 0;
  const points = pairs.map((p) => ({ currency: p.currency.trim(), fxOn: p.fxOn, n: Number(p.n) }));
  const window = rateWindowOf(points, opts.displayCurrencies);
  if (window) {
    const resolver = await createRateResolver(db, window, { mode: opts.mode });
    for (const p of points) {
      entries += p.n;
      const source = resolver.scaled(p.currency, p.fxOn);
      for (const d of opts.displayCurrencies) {
        if (source === null || resolver.scaled(d, p.fxOn) === null) entriesWithoutRate[d] = (entriesWithoutRate[d] ?? 0) + p.n;
      }
    }
  }
  const monthOrderIds = db.select({ id: orderFinance.orderId }).from(orderFinance).where(recognizedInMonth);
  const [disc] = await db
    .select({
      total: count(),
      critical: sql<number>`count(*) filter (where ${financeDiscrepancies.severity} = 'critical')`,
    })
    .from(financeDiscrepancies)
    .where(
      and(
        eq(financeDiscrepancies.storeId, DEFAULT_STORE_ID),
        eq(financeDiscrepancies.status, "open"),
        or(
          inArray(financeDiscrepancies.orderId, monthOrderIds),
          and(
            isNull(financeDiscrepancies.orderId),
            gte(financeDiscrepancies.createdAt, businessDayStart(month)),
            lte(financeDiscrepancies.createdAt, businessDayEnd(end)),
          ),
        ),
      ),
    );
  const [unknown] = await db.select({ q: sql<number>`coalesce(sum(${inventoryCostState.unknownQty}), 0)` }).from(inventoryCostState);
  const [pkg] = await db
    .select({ c: count() })
    .from(orderFinanceForecasts)
    .where(and(eq(orderFinanceForecasts.component, "packaging"), inArray(orderFinanceForecasts.orderId, monthOrderIds)));
  const entriesByConfirmItem: Partial<Record<ConfirmItem, number>> = {};
  const expensesByConfirmItem: Partial<Record<ConfirmItem, number>> = {};
  for (const item of CONFIRM_ITEMS) {
    entriesByConfirmItem[item] = await confirmItemEntries(db, month, item);
    expensesByConfirmItem[item] = await confirmItemExpenses(db, month, item);
  }
  return {
    fullyPast: isFullyPastMonth(month, opts.today),
    ordersRecognized: Number(orderStats?.total ?? 0),
    ordersNotFinal: Number(orderStats?.notFinal ?? 0),
    entries,
    entriesWithoutRate,
    openDiscrepancies: Number(disc?.total ?? 0),
    criticalDiscrepancies: Number(disc?.critical ?? 0),
    ordersNeedReview: Number(orderStats?.review ?? 0),
    unknownCostUnits: Number(unknown?.q ?? 0),
    packagingTotals: entriesByConfirmItem.packaging_total_accounted ?? 0,
    ordersWithPackagingForecast: Number(pkg?.c ?? 0),
    entriesByConfirmItem,
    expensesByConfirmItem,
    confirmations: opts.confirmations,
  };
}

export interface MonthSnapshot {
  id: string;
  reportingCurrency: string;
  version: number;
  isFinal: boolean;
  source: string;
  dataSha256: string;
  generatedAt: string;
}

export interface MonthOverview {
  month: string;
  status: "open" | "closed";
  version: number;
  netProfitEligible: boolean;
  closedAt: string | null;
  closedBy: string | null;
  reopenedAt: string | null;
  reopenReason: string | null;
  fullyPast: boolean;
  checklist: ChecklistResult;
  confirmations: Partial<Record<ConfirmItem, ConfirmValue>>;
  displayCurrencies: string[];
  /** Знімки місяця (усі версії, новіші першими). */
  snapshots: MonthSnapshot[];
  /** Закритий місяць: валюти показу без остаточного знімка — «Живий перерахунок, не знімок». */
  liveCurrencies: string[];
  history: FinanceChangeRow[];
}

async function monthSnapshots(db: DbOrTx, month: string): Promise<MonthSnapshot[]> {
  const rows = await db
    .select()
    .from(financeReportSnapshots)
    .where(and(eq(financeReportSnapshots.storeId, DEFAULT_STORE_ID), eq(financeReportSnapshots.kind, "month"), eq(financeReportSnapshots.periodFrom, month)))
    .orderBy(asc(financeReportSnapshots.reportingCurrency), desc(financeReportSnapshots.version));
  return rows.map((r) => ({
    id: r.id,
    reportingCurrency: r.reportingCurrency.trim(),
    version: r.version,
    isFinal: r.isFinal,
    source: r.source,
    dataSha256: r.dataSha256,
    generatedAt: r.generatedAt.toISOString(),
  }));
}

/** Огляд місяця: стан, чек-лист (живий для відкритого), знімки, історія (finance.view). */
export async function getMonthOverview(ctx: Pick<ServiceContext, "db" | "actor" | "mode" | "now">, month: string): Promise<MonthOverview> {
  requireFinance(ctx, "view");
  const m = assertMonth(month);
  const settings = await loadFinanceSettings(ctx.db);
  const displayCurrencies = displayCurrenciesOf(settings);
  const row = await loadPeriodRow(ctx.db, m);
  const stored = storedChecklist(row?.checklist);
  const today = businessDate(ctx.now());
  const facts = await computeChecklistFacts(ctx.db, m, { mode: ctx.mode, today, displayCurrencies, confirmations: stored.confirm });
  const snapshots = await monthSnapshots(ctx.db, m);
  const status = row?.status === "closed" ? "closed" : "open";
  const finalCurrencies = new Set(snapshots.filter((s) => s.isFinal).map((s) => s.reportingCurrency));
  return {
    month: m,
    status,
    version: row?.version ?? 0,
    netProfitEligible: row?.netProfitEligible ?? false,
    closedAt: row?.closedAt?.toISOString() ?? null,
    closedBy: row?.closedBy ?? null,
    reopenedAt: row?.reopenedAt?.toISOString() ?? null,
    reopenReason: row?.reopenReason ?? null,
    fullyPast: facts.fullyPast,
    checklist: evaluateChecklist(facts),
    confirmations: stored.confirm,
    displayCurrencies,
    snapshots,
    liveCurrencies: status === "closed" ? displayCurrencies.filter((c) => !finalCurrencies.has(c)) : [],
    history: await listFinanceChanges(ctx, { entityType: "period", entityId: m, limit: 50 }),
  };
}

export interface MonthListItem {
  month: string;
  status: "open" | "closed";
  netProfitEligible: boolean;
  closedAt: string | null;
  fullyPast: boolean;
  /** Діючі й сторно-записи місяця (кількість), замовлення, визнані в місяці, остаточні знімки. */
  entries: number;
  orders: number;
  finalSnapshots: number;
}

/** Місяці для сторінки (finance.view): останні `count` до поточного + старіші з рядками finance_periods. */
export async function listFinanceMonths(ctx: Pick<ServiceContext, "db" | "actor" | "now">, opts: { count?: number } = {}): Promise<MonthListItem[]> {
  requireFinance(ctx, "view");
  const today = businessDate(ctx.now());
  const current = monthStart(today);
  const n = Math.min(Math.max(opts.count ?? 12, 1), 36);
  const recent = Array.from({ length: n }, (_v, i) => addMonths(current, -i));
  const rows = await ctx.db.select().from(financePeriods).where(eq(financePeriods.storeId, DEFAULT_STORE_ID)).orderBy(desc(financePeriods.month)).limit(120);
  const months = [...new Set([...recent, ...rows.map((r) => r.month)])].filter((m) => m <= current).sort().reverse();
  const from = months[months.length - 1]!;
  const monthExpr = (col: SQL | typeof financeEntries.recognizedOn) => sql<string>`to_char(date_trunc('month', ${col}), 'YYYY-MM-DD')`;
  const [entryCounts, orderCounts, snapCounts] = await Promise.all([
    ctx.db
      .select({ m: monthExpr(financeEntries.recognizedOn), c: count() })
      .from(financeEntries)
      .where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), gte(financeEntries.recognizedOn, from)))
      .groupBy(monthExpr(financeEntries.recognizedOn)),
    ctx.db
      .select({ m: sql<string>`to_char(date_trunc('month', ${orderFinance.recognizedOn}), 'YYYY-MM-DD')`, c: count() })
      .from(orderFinance)
      .where(and(eq(orderFinance.state, "recognized"), gte(orderFinance.recognizedOn, from)))
      .groupBy(sql`date_trunc('month', ${orderFinance.recognizedOn})`),
    ctx.db
      .select({ m: financeReportSnapshots.periodFrom, c: count() })
      .from(financeReportSnapshots)
      .where(and(eq(financeReportSnapshots.storeId, DEFAULT_STORE_ID), eq(financeReportSnapshots.kind, "month"), eq(financeReportSnapshots.isFinal, true)))
      .groupBy(financeReportSnapshots.periodFrom),
  ]);
  const ec = new Map(entryCounts.map((r) => [r.m, Number(r.c)]));
  const oc = new Map(orderCounts.map((r) => [r.m, Number(r.c)]));
  const sc = new Map(snapCounts.map((r) => [r.m, Number(r.c)]));
  const byMonth = new Map(rows.map((r) => [r.month, r]));
  return months.map((m) => {
    const r = byMonth.get(m);
    return {
      month: m,
      status: r?.status === "closed" ? "closed" : "open",
      netProfitEligible: r?.netProfitEligible ?? false,
      closedAt: r?.closedAt?.toISOString() ?? null,
      fullyPast: isFullyPastMonth(m, today),
      entries: ec.get(m) ?? 0,
      orders: oc.get(m) ?? 0,
      finalSnapshots: sc.get(m) ?? 0,
    };
  });
}

function checkVersion(row: PeriodRow | null, expected: number | null | undefined) {
  if (expected !== undefined && expected !== null && expected !== (row?.version ?? 0)) throw new ConflictError();
}

async function upsertPeriod(
  tx: Tx,
  month: string,
  existing: PeriodRow | null,
  patch: Partial<Omit<PeriodRow, "storeId" | "month" | "version" | "updatedAt">>,
): Promise<PeriodRow> {
  if (!existing) {
    const [row] = await tx
      .insert(financePeriods)
      .values({ storeId: DEFAULT_STORE_ID, month, ...patch, version: 1 })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new ConflictError();
    return row;
  }
  const [row] = await tx
    .update(financePeriods)
    .set({ ...patch, version: existing.version + 1, updatedAt: new Date() })
    .where(and(eq(financePeriods.storeId, existing.storeId), eq(financePeriods.month, month), eq(financePeriods.version, existing.version)))
    .returning();
  if (!row) throw new ConflictError();
  return row;
}

/** Замовлення, визнані в місяці (для перерахунку після зміни пункту упаковки). */
async function ordersRecognizedIn(db: DbOrTx, month: string): Promise<string[]> {
  const rows = await db
    .select({ id: orderFinance.orderId })
    .from(orderFinance)
    .where(and(eq(orderFinance.storeId, DEFAULT_STORE_ID), eq(orderFinance.state, "recognized"), inMonth(orderFinance.recognizedOn, month)))
    .orderBy(asc(orderFinance.orderId));
  return rows.map((r) => r.id);
}

export interface ConfirmInput {
  month: string;
  /** Пункт → значення; порожнє / null — зняти підтвердження. */
  values: Partial<Record<string, string | null>>;
  expectedVersion?: number | null;
  reason?: string | null;
}

/** Підтвердження пунктів ☐ відкритого місяця (finance.manage). */
export async function confirmMonthItems(ctx: Ctx, input: ConfirmInput): Promise<{ version: number; changed: ConfirmItem[]; resynced: number }> {
  requireFinance(ctx, "manage");
  const month = assertMonth(input.month);
  const reason = maskFreeTextNote(input.reason, PERIOD_REASON_MAX);
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, monthLockKey(DEFAULT_STORE_ID, month));
    const [row] = await tx
      .select()
      .from(financePeriods)
      .where(and(eq(financePeriods.storeId, DEFAULT_STORE_ID), eq(financePeriods.month, month)))
      .for("update");
    const existing = row ?? null;
    if (existing?.status === "closed") throw new DomainError("finance.error.monthClosed", 409, { month });
    checkVersion(existing, input.expectedVersion);
    const stored = storedChecklist(existing?.checklist);
    const next: Partial<Record<ConfirmItem, ConfirmValue>> = { ...stored.confirm };
    const changed: ConfirmItem[] = [];
    for (const [key, raw] of Object.entries(input.values)) {
      if (!isConfirmItem(key)) throw new DomainError("financeExpenses.error.confirmItemInvalid", 400);
      const value = (raw ?? "").trim();
      if (value === "") {
        if (next[key] !== undefined) {
          delete next[key];
          changed.push(key);
        }
        continue;
      }
      if (!isConfirmValue(value)) throw new DomainError("financeExpenses.error.confirmValueInvalid", 400);
      if (next[key] === value) continue;
      const err = confirmationError(key, value, await confirmItemRecords(tx, month, key));
      if (err) throw new DomainError(err, 400, { item: key });
      next[key] = value;
      changed.push(key);
    }
    if (changed.length === 0) return { version: existing?.version ?? 0, changed, resynced: 0 };
    const saved = await upsertPeriod(tx, month, existing, { checklist: { ...stored, confirm: next } });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "period",
      entityId: month,
      action: "confirm",
      before: { month, checklist: { ...stored.confirm }, version: existing?.version ?? 0 },
      after: { month, checklist: { ...next }, version: saved.version },
      reason,
    });
    let resynced = 0;
    if (changed.includes("packaging_total_accounted")) {
      // FINO усіх замовлень місяця одним упорядкованим набором до першої синхронізації (як WP4 syncOrderFinanceMany, §17.8).
      const ids = await ordersRecognizedIn(tx, month);
      await lockFinanceOrders(tx, ids);
      for (const id of ids) {
        await syncOrderFinance(tx, ctx.actor, id);
        resynced++;
      }
    }
    await writeAudit(tx, ctx.actor, "finance.period_confirmed", { type: "finance_period", id: month }, { items: changed.length, resynced });
    return { version: saved.version, changed, resynced };
  });
}

export interface CloseMonthResult {
  month: string;
  version: number;
  netProfitEligible: boolean;
  snapshots: Array<{ currency: string; id: string; version: number }>;
}

/** Дані остаточного знімка закритого місяця: назва прибутку й повнота за підсумком закриття (§2.7). */
function finalizeData(data: ReportData, month: string, eligible: boolean): ReportData {
  return {
    ...data,
    profitLabel: eligible ? "net_profit" : "profit_after_recorded_costs",
    completeness: {
      ...data.completeness,
      netProfitEligible: eligible,
      closedMonths: [...new Set([...data.completeness.closedMonths, month])].sort(),
    },
  };
}

/**
 * Закриває місяць (finance.manage): чек-лист ■, остаточні знімки в кожній валюті показу, стан closed, історія змін.
 * deps.buildReportData — для тестів (типово — WP8 finance-analytics/report-data.server.ts).
 */
export async function closeMonth(
  ctx: Ctx,
  input: { month: string; expectedVersion?: number | null },
  deps: { buildReportData?: BuildReportData } = {},
): Promise<CloseMonthResult> {
  requireFinance(ctx, "manage");
  const month = assertMonth(input.month);
  const today = businessDate(ctx.now());
  if (!isFullyPastMonth(month, today)) throw new DomainError("financeExpenses.error.monthNotPast", 409, { month });
  const build = deps.buildReportData ?? defaultBuildReportData;
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, monthLockKey(DEFAULT_STORE_ID, month));
    await lockFinancePeriodExclusive(tx, DEFAULT_STORE_ID, month);
    const [row] = await tx
      .select()
      .from(financePeriods)
      .where(and(eq(financePeriods.storeId, DEFAULT_STORE_ID), eq(financePeriods.month, month)))
      .for("update");
    const existing = row ?? null;
    if (existing?.status === "closed") throw new DomainError("financeExpenses.error.alreadyClosed", 409, { month });
    checkVersion(existing, input.expectedVersion);
    const settings = await loadFinanceSettings(tx);
    const displayCurrencies = displayCurrenciesOf(settings);
    const stored = storedChecklist(existing?.checklist);
    const facts = await computeChecklistFacts(tx, month, { mode: ctx.mode, today, displayCurrencies, confirmations: stored.confirm });
    const result = evaluateChecklist(facts);
    if (!result.canClose) throw new DomainError("financeExpenses.error.checklistBlocked", 409, { count: result.blockingFailures });
    const eligible = result.allConfirmed;
    const reportCtx: ServiceContext = { ...(ctx as ServiceContext), db: tx as unknown as Db };
    const snapshots: CloseMonthResult["snapshots"] = [];
    for (const currency of displayCurrencies) {
      const built = await build(reportCtx, { kind: "month", period: { from: month, to: monthEnd(month) }, reportingCurrency: currency });
      const data = finalizeData(built.data, month, eligible);
      const saved = await saveReportSnapshot(tx, ctx.actor, {
        kind: "month",
        periodFrom: month,
        periodTo: monthEnd(month),
        reportingCurrency: currency,
        source: "close",
        isFinal: true,
        schemaVersion: data.schemaVersion,
        data,
        ratesUsed: built.ratesUsed,
      });
      snapshots.push({ currency, id: saved.id, version: saved.version });
    }
    const primary = snapshots.find((s) => s.currency === settings.reportingCurrency) ?? snapshots[0] ?? null;
    const closing = checklistForLog(result);
    const saved = await upsertPeriod(tx, month, existing, {
      status: "closed",
      checklist: { ...stored, closing },
      netProfitEligible: eligible,
      closedAt: ctx.now(),
      closedBy: ctx.actor.id,
      snapshotId: primary?.id ?? null,
    });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "period",
      entityId: month,
      action: "close",
      before: { month, status: existing?.status ?? "open", version: existing?.version ?? 0 },
      after: { month, status: "closed", netProfitEligible: eligible, checklist: closing, snapshots: snapshots.length, version: saved.version },
    });
    await writeAudit(tx, ctx.actor, "finance.period_closed", { type: "finance_period", id: month }, { snapshots: snapshots.length, eligible });
    return { month, version: saved.version, netProfitEligible: eligible, snapshots };
  });
}

/** Повторне відкриття закритого місяця — лише з причиною (finance.manage). Старі знімки лишаються. */
export async function reopenMonth(ctx: Ctx, input: { month: string; reason: string; expectedVersion?: number | null }): Promise<{ month: string; version: number }> {
  requireFinance(ctx, "manage");
  const month = assertMonth(input.month);
  const reason = maskFreeTextNote(input.reason, PERIOD_REASON_MAX);
  if (!reason) throw new DomainError("financeExpenses.error.reasonRequired", 400);
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOperation(tx, monthLockKey(DEFAULT_STORE_ID, month));
    await lockFinancePeriodExclusive(tx, DEFAULT_STORE_ID, month);
    const [row] = await tx
      .select()
      .from(financePeriods)
      .where(and(eq(financePeriods.storeId, DEFAULT_STORE_ID), eq(financePeriods.month, month)))
      .for("update");
    if (!row || row.status !== "closed") throw new DomainError("financeExpenses.error.notClosed", 409, { month });
    checkVersion(row, input.expectedVersion);
    const saved = await upsertPeriod(tx, month, row, {
      status: "open",
      netProfitEligible: false,
      reopenedAt: ctx.now(),
      reopenedBy: ctx.actor.id,
      reopenReason: reason,
    });
    await writeFinanceChange(tx, ctx.actor, {
      entityType: "period",
      entityId: month,
      action: "reopen",
      before: { month, status: "closed", netProfitEligible: row.netProfitEligible, version: row.version },
      after: { month, status: "open", netProfitEligible: false, version: saved.version },
      reason,
    });
    await writeAudit(tx, ctx.actor, "finance.period_reopened", { type: "finance_period", id: month });
    return { month, version: saved.version };
  });
}

/**
 * Етап 6, WP9: суми розділу «Повернення» — ЛИШЕ власнику (`requireFinance(ctx, "view")`, §11, §14.2). Сторінки
 * викликають їх через `financeFieldOrNull`, тож працівник отримує `null`, а не порожнє.
 *
 * Кожне грошове число — агрегат журналу `finance_entries` (F1): записи замовлення випадку за категоріями (повернено
 * коштів — refund_*; зворотна доставка — return_shipping_cost: рядки рахунку `return_delivery` / `redirect` і ручні
 * витрати; обробка — return_handling; вплив на собівартість — cogs_return, лише придатні повернення; утримані збори —
 * payment_fees / platform_fees замовлення). Конвертація — кожен запис окремо за курсом його `fx_on` (sumConverted, одне
 * округлення на запис); запис без курсу не стає 0 — він у `unconverted`.
 *
 * Віднесення до випадку (§11 — суми випадку, а не всього замовлення; attribution.ts `entryCase`): запис продажу угоди
 * повернення (`shopify_sale` → order_sales.refund_id → повернення коштів, що належить випадку), оцінки складу
 * (`valuation` → рух надходження-повернення випадку) і ручної витрати / частки (`expense` / `allocation` →
 * `finance_expenses.return_id`). Решта записів замовлення (рядки рахунку перевізника — без випадку; повернення коштів
 * без позицій; утримані збори) — окремим блоком «За замовленням, не прив'язано до випадку»; записи ІНШИХ випадків того
 * самого замовлення сюди не входять (сума за випадками + не прив'язане = сума замовлення, без подвійного рахунку).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financeEntries, financeExpenses, inventoryValuations, orderRefunds, orderReturnLines, orderReturns, orderSales } from "~/db/schema";
import { fromMinor, toMinorForCurrency } from "~/lib/decimal";
import { NotFoundError } from "~/lib/errors";
import { requireFinance } from "~/modules/finance/core/access.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { sumConverted, type ConvertibleEntry, type UnconvertedTotal } from "~/modules/fx/convert";
import { createRateResolver, rateWindowOf } from "~/modules/fx/rate-for.server";
import type { ServiceContext } from "~/server/types";
import { entryCase, lineOrigins, sourceOwners } from "./attribution";
import { loadReceiptMovementIds, loadRefundSources } from "./facts.server";
import {
  CASE_MONEY_GROUP_KEYS,
  RETURN_COST_CATEGORIES,
  RETURN_MONEY_GROUP_KEYS,
  RETURN_MONEY_GROUPS,
  type CaseMoneyGroup,
  type ReturnMoneyGroup,
} from "./money-groups";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode">;

export {
  CASE_MONEY_GROUP_KEYS,
  RETURN_COST_CATEGORIES,
  RETURN_MONEY_GROUP_KEYS,
  RETURN_MONEY_GROUPS,
  type CaseMoneyGroup,
  type ReturnMoneyGroup,
} from "./money-groups";

export interface MoneyAmount {
  amount: string;
  currency: string;
}

/** Сума у валюті показу + початкові суми за валютами; total null — нічого не сконвертовано (є лише записи без курсу). */
export interface ReturnMoneySum {
  currency: string;
  total: string | null;
  /** Σ у початкових валютах (F3). */
  original: MoneyAmount[];
  entries: number;
  unconverted: UnconvertedTotal[];
}

interface EntryRow extends ConvertibleEntry {
  category: string;
}

/** Валюта показу: запитана, якщо вона серед валют показу налаштувань, інакше — валюта звітності. */
export async function returnsCurrency(db: DbOrTx, requested: string | null | undefined): Promise<{ currency: string; options: string[] }> {
  const s = await loadFinanceSettings(db);
  const options = [...new Set([s.reportingCurrency, ...s.displayCurrencies])];
  const want = (requested ?? "").trim().toUpperCase();
  return {
    currency: options.includes(want) ? want : s.reportingCurrency,
    options,
  };
}

/** Σ записів у валюті `currency` (кожен запис — за курсом свого fx_on). */
export function sumEntries(entries: readonly ConvertibleEntry[], currency: string, rateOf: (c: string, d: string) => bigint | null): ReturnMoneySum {
  const byCurrency = new Map<string, bigint>();
  for (const e of entries) byCurrency.set(e.currency, (byCurrency.get(e.currency) ?? 0n) + toMinorForCurrency(e.amount, e.currency));
  const converted = sumConverted(entries, currency, rateOf);
  return {
    currency,
    total: entries.length === 0 ? null : converted.total,
    original: [...byCurrency.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([c, minor]) => ({ amount: fromMinor(minor), currency: c })),
    entries: entries.length,
    unconverted: converted.unconverted,
  };
}

/** Суми груп для набору записів однією вибіркою курсів (вікно — за fx_on записів). */
export async function sumGroups<K extends string>(
  ctx: Ctx,
  rows: readonly EntryRow[],
  groups: Readonly<Record<K, readonly string[]>>,
  currency: string,
): Promise<Record<K, ReturnMoneySum>> {
  const window = rateWindowOf(rows, [currency]);
  const resolver = window ? await createRateResolver(ctx.db, window, { mode: ctx.mode }) : null;
  const rateOf = (c: string, d: string) => (resolver ? resolver.scaled(c, d) : null);
  const out = {} as Record<K, ReturnMoneySum>;
  for (const key of Object.keys(groups) as K[]) {
    const cats = groups[key];
    out[key] = sumEntries(
      rows.filter((r) => cats.includes(r.category)),
      currency,
      rateOf,
    );
  }
  return out;
}

export interface ReturnCaseAmounts {
  currency: string;
  currencies: string[];
  /** Записи, віднесені до ЦЬОГО випадку (повернено коштів, зворотна доставка, обробка, сторно собівартості). */
  groups: Record<CaseMoneyGroup, ReturnMoneySum>;
  /** Витрати на повернення випадку = зворотна доставка + обробка. */
  returnCosts: ReturnMoneySum;
  /** Записи замовлення, не віднесені до жодного його випадку (утримані збори — завжди тут). */
  orderLevel: {
    groups: Record<ReturnMoneyGroup, ReturnMoneySum>;
    returnCosts: ReturnMoneySum;
    /** Записів у блоці (0 — блок порожній). */
    entries: number;
  };
  /** Кількість випадків замовлення (≥ 1). */
  orderCases: number;
  /** Повернення коштів Shopify (джерело, у валюті магазину): цього випадку (`case`) і не прив'язані (`order`). */
  refunds: Array<{
    refundId: string;
    at: Date;
    amount: string;
    currency: string;
    scope: "case" | "order";
  }>;
  /** Ручні витрати, прив'язані до цього випадку (джерела; суми — як внесено). */
  expenses: Array<{
    id: string;
    category: string;
    amount: string;
    currency: string;
    date: string | null;
    status: string;
  }>;
  /** Пошкоджені одиниці випадку: їхня вартість не повертається в собівартість (довідково). */
  damagedUnits: number;
}

export async function loadReturnAmounts(ctx: Ctx, caseId: string, opts: { currency?: string | null } = {}): Promise<ReturnCaseAmounts> {
  requireFinance(ctx, "view");
  const [c] = await ctx.db.select({ id: orderReturns.id, orderId: orderReturns.orderId }).from(orderReturns).where(eq(orderReturns.id, caseId));
  if (!c) throw new NotFoundError("return");
  const { currency, options } = await returnsCurrency(ctx.db, opts.currency);
  const allCats = RETURN_MONEY_GROUP_KEYS.flatMap((k) => [...RETURN_MONEY_GROUPS[k]]);
  const [rows, refundHeads, expenses, cases, sales, refunds, receiptIds] = await Promise.all([
    ctx.db
      .select({
        category: financeEntries.category,
        amount: financeEntries.amount,
        currency: financeEntries.currency,
        fxOn: financeEntries.fxOn,
        sourceType: financeEntries.sourceType,
        sourceId: financeEntries.sourceId,
      })
      .from(financeEntries)
      .where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), eq(financeEntries.orderId, c.orderId), inArray(financeEntries.category, allCats))),
    ctx.db
      .select({
        id: orderRefunds.id,
        shopifyRefundId: orderRefunds.shopifyRefundId,
        processedAt: orderRefunds.processedAt,
        createdAtShopify: orderRefunds.createdAtShopify,
        fetchedAt: orderRefunds.fetchedAt,
        total: orderRefunds.total,
        currency: orderRefunds.currency,
      })
      .from(orderRefunds)
      .where(eq(orderRefunds.orderId, c.orderId))
      .orderBy(asc(orderRefunds.createdAtShopify), asc(orderRefunds.id)),
    ctx.db
      .select({
        id: financeExpenses.id,
        category: financeExpenses.category,
        amount: financeExpenses.amount,
        currency: financeExpenses.currency,
        date: financeExpenses.expenseDate,
        periodFrom: financeExpenses.periodFrom,
        status: financeExpenses.status,
      })
      .from(financeExpenses)
      .where(eq(financeExpenses.returnId, c.id))
      .orderBy(asc(financeExpenses.createdAt)),
    ctx.db.select({ id: orderReturns.id, sourceKey: orderReturns.sourceKey }).from(orderReturns).where(eq(orderReturns.orderId, c.orderId)),
    ctx.db
      .select({ id: orderSales.id, shopifySaleId: orderSales.shopifySaleId, refundId: orderSales.refundId })
      .from(orderSales)
      .where(eq(orderSales.orderId, c.orderId)),
    loadRefundSources(ctx.db, c.orderId),
    loadReceiptMovementIds(ctx.db, [c.orderId]),
  ]);
  const caseIds = cases.map((x) => x.id);
  const lines = await ctx.db
    .select({ id: orderReturnLines.id, returnId: orderReturnLines.returnId, quantity: orderReturnLines.quantity, condition: orderReturnLines.condition })
    .from(orderReturnLines)
    .where(inArray(orderReturnLines.returnId, caseIds));
  const valuationIds = [...new Set(rows.filter((r) => r.sourceType === "valuation").map((r) => r.sourceId))].filter((id) => UUID_RE.test(id));
  const expenseIds = [...new Set(rows.filter((r) => r.sourceType === "expense" || r.sourceType === "allocation").map((r) => r.sourceId))].filter((id) =>
    UUID_RE.test(id),
  );
  const [valuations, sourceExpenses] = await Promise.all([
    valuationIds.length
      ? ctx.db
          .select({ id: inventoryValuations.id, movementId: inventoryValuations.movementId })
          .from(inventoryValuations)
          .where(inArray(inventoryValuations.id, valuationIds))
      : Promise.resolve([]),
    expenseIds.length
      ? ctx.db.select({ id: financeExpenses.id, returnId: financeExpenses.returnId }).from(financeExpenses).where(inArray(financeExpenses.id, expenseIds))
      : Promise.resolve([]),
  ]);
  const origins = lineOrigins(refunds, receiptIds.get(c.orderId) ?? []);
  const owners = sourceOwners({ cases, lines, origins });
  const saleRefundGid = new Map<string, string | null>();
  for (const sale of sales) {
    saleRefundGid.set(sale.id, sale.refundId);
    saleRefundGid.set(sale.shopifySaleId, sale.refundId);
  }
  const maps = {
    saleRefundGid,
    refundIdByGid: new Map(refundHeads.map((r) => [r.shopifyRefundId, r.id])),
    valuationMovement: new Map(valuations.map((v) => [v.id, v.movementId])),
    expenseReturn: new Map(sourceExpenses.map((e) => [e.id, e.returnId])),
    owners,
    caseIds: new Set(caseIds),
  };
  const mine: typeof rows = [];
  const unattributed: typeof rows = [];
  for (const r of rows) {
    const owner = entryCase(r, maps);
    if (owner === c.id) mine.push(r);
    else if (owner === null) unattributed.push(r);
  }
  // Одна вибірка курсів на обидва блоки (вікно — за fx_on усіх записів).
  const resolverRows = [...mine, ...unattributed];
  const sums = await sumGroupSets(ctx, resolverRows, currency, [
    { rows: mine, groups: { ...caseGroupsOf(), returnCosts: RETURN_COST_CATEGORIES } },
    { rows: unattributed, groups: { ...RETURN_MONEY_GROUPS, returnCosts: RETURN_COST_CATEGORIES } },
  ]);
  const [caseSums, orderSums] = sums as [Record<CaseMoneyGroup | "returnCosts", ReturnMoneySum>, Record<ReturnMoneyGroup | "returnCosts", ReturnMoneySum>];
  const { returnCosts, ...groups } = caseSums;
  const { returnCosts: orderReturnCosts, ...orderGroups } = orderSums;
  return {
    currency,
    currencies: options,
    groups,
    returnCosts,
    orderLevel: { groups: orderGroups, returnCosts: orderReturnCosts, entries: unattributed.length },
    orderCases: cases.length,
    refunds: refundHeads.flatMap((r) => {
      const owner = owners.refundCase.get(r.id);
      const scope = owner === c.id ? ("case" as const) : owner === undefined ? ("order" as const) : null;
      return scope
        ? [
            {
              refundId: r.id,
              at: r.processedAt ?? r.createdAtShopify ?? r.fetchedAt,
              amount: r.total,
              currency: r.currency,
              scope,
            },
          ]
        : [];
    }),
    expenses: expenses.map((e) => ({
      id: e.id,
      category: e.category,
      amount: e.amount,
      currency: e.currency,
      date: e.date ?? e.periodFrom ?? null,
      status: e.status,
    })),
    damagedUnits: lines.filter((l) => l.returnId === c.id && l.condition === "damaged").reduce((s, l) => s + l.quantity, 0),
  };
}

function caseGroupsOf(): Record<CaseMoneyGroup, readonly string[]> {
  return {
    refunds: RETURN_MONEY_GROUPS.refunds,
    returnShipping: RETURN_MONEY_GROUPS.returnShipping,
    returnHandling: RETURN_MONEY_GROUPS.returnHandling,
    cogsReturn: RETURN_MONEY_GROUPS.cogsReturn,
  } satisfies Record<(typeof CASE_MONEY_GROUP_KEYS)[number], readonly string[]>;
}

/** Кілька наборів груп однією вибіркою курсів. */
async function sumGroupSets(
  ctx: Ctx,
  all: readonly EntryRow[],
  currency: string,
  sets: ReadonlyArray<{ rows: readonly EntryRow[]; groups: Readonly<Record<string, readonly string[]>> }>,
): Promise<Array<Record<string, ReturnMoneySum>>> {
  const window = rateWindowOf(all, [currency]);
  const resolver = window ? await createRateResolver(ctx.db, window, { mode: ctx.mode }) : null;
  const rateOf = (cur: string, d: string) => (resolver ? resolver.scaled(cur, d) : null);
  return sets.map((set) => {
    const out: Record<string, ReturnMoneySum> = {};
    for (const [key, cats] of Object.entries(set.groups))
      out[key] = sumEntries(
        set.rows.filter((r) => cats.includes(r.category)),
        currency,
        rateOf,
      );
    return out;
  });
}

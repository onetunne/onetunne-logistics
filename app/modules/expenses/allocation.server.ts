/**
 * Етап 6, WP6: розподіл суми періоду, що замінює прогнози замовлень (docs/stage6-design.md §10.3, I16) — ВНУТРІШНІЙ
 * розрахунок (без перевірки актора; викликають сервіси витрат у своїй транзакції; сторінки не імпортують).
 *
 * Розподіляється лише ДОДАТНА сума з виміром (шлюз для комісій, перевізник для доставки; упаковка — без виміру):
 * кредит і сума без виміру (рахунок Shopify за тариф, «Доставка (інше)» без перевізника) — звичайні витрати періоду
 * (rules.ts coverageApplies).
 * Кандидати — замовлення виміру витрати (шлюз / перевізник / усі для упаковки), оформлені (`placed_at`, Київ) у вікні
 * витрати (`coverageWindow`: період послуги або місяць дати), не скасовані, не виключені (тестові без
 * includeTestOrders, `excluded`, `closed_unrecognized`), у яких цей складник ЩЕ НЕ ФАКТИЧНИЙ — ні проведеним записом,
 * ні фактом джерела, що чекає визнання (R1: факти до визнання не проводяться, §3.3):
 * - немає діючого запису тієї самої категорії з order_id з іншого джерела, ніж розподіл (комісія Shopify, рядок
 *   рахунку, оцінка упаковки, ручна витрата замовлення);
 * - немає факту джерела: комісії — рядок `order_transaction_fees` замовлення (TransactionFee Shopify; §8.1 «сума
 *   періоду — лише коли fees порожній»); упаковка — оцінка виходу `material_consume` з order_id (`inventory_valuations`);
 *   доставка — зіставлений рядок рахунку перевізника (`carrier_invoice_lines` matched/manual, нарахування доставки, не
 *   мито й не зворотна доставка);
 * - немає діючої ручної витрати замовлення тієї самої категорії (вона ще може чекати визнання);
 * - замовлення не покрите поточною версією розподілу ІНШОЇ діючої (додатної) суми періоду тієї самої категорії.
 * Ваги — прогнози складника (`order_finance_forecasts`, §4; кілька валют → гривні за курсом дати оформлення); замовлення
 * без прогнозу (вага 0) у розподіл не входять — лишаються «Немає даних» (F4: невідоме не стає нулем). Якщо прогнозів
 * немає в жодного кандидата — за виручкою (`orders.total` замовлення; усі 0 — порівну). Частки — найбільші остачі в
 * цілих одиницях валюти, Σ = сума точно; нічия — раніше оформлене замовлення.
 */
import { and, asc, eq, gte, inArray, isNull, lte, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbOrTx } from "~/db/client.server";
import {
  carrierInvoiceLines,
  financeEntries,
  financeExpenseAllocations,
  financeExpenses,
  inventoryValuations,
  orderExternalWaybills,
  orderFinance,
  orderFinanceForecasts,
  orders,
  orderShopifyFinance,
  orderTransactionFees,
  orderTransactions,
  shipments,
} from "~/db/schema";
import type { OrderComponent } from "~/domain/finance";
import { DomainError } from "~/lib/errors";
import { RATE_SCALE_FACTOR, toMinor, toMinorForCurrency } from "~/lib/decimal";
import { businessDate, monthEnd, monthStart } from "~/lib/periods";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import { rateFor } from "~/modules/fx/rate-for.server";
import type { AppMode } from "~/server/types";
import {
  allocateCurrencyMinor,
  coverageApplies,
  COVERING_COMPONENT,
  COVERING_DIMENSION,
  coverageWindow,
  isCoveringCategory,
  type CoveringCategory,
} from "./rules";
import { resolveRateMode } from "~/modules/finance/core/rate-mode.server";

const reversals = alias(financeEntries, "fe_alloc_rev");

export type AllocationRow = typeof financeExpenseAllocations.$inferSelect;
type ExpenseRow = typeof financeExpenses.$inferSelect;

export interface AllocationShare {
  orderId: string;
  /** Соті частки у валюті витрати (≥ 0 для суми > 0). */
  minor: bigint;
}

export interface ComputedAllocation {
  weightBasis: "forecast" | "revenue";
  shares: AllocationShare[];
}

interface Candidate {
  id: string;
  placedAt: Date;
  currency: string;
  total: string;
}

/** Активний запис журналу (не сторно й не сторнований). */
const activeEntry = (db: DbOrTx) =>
  and(isNull(financeEntries.reversesEntryId), notExists(db.select({ one: sql`1` }).from(reversals).where(eq(reversals.reversesEntryId, financeEntries.id))));

/** Чи може рядок бути сумою, що замінює прогнози: категорія, без замовлення, додатна, з виміром (rules.ts). */
export function isAllocatableRow(row: Pick<ExpenseRow, "category" | "orderId" | "amount" | "currency" | "gateway" | "carrierCode">): boolean {
  if (!isCoveringCategory(row.category as never)) return false;
  return coverageApplies({
    category: row.category as CoveringCategory,
    hasOrder: row.orderId !== null,
    amountMinor: toMinorForCurrency(row.amount, row.currency.trim()),
    gateway: row.gateway,
    carrierCode: row.carrierCode,
  });
}

/** Факт складника в джерелі (ще не проведений або вже проведений) — замовлення не кандидат (див. вгорі файла). */
function sourceFactExists(category: CoveringCategory): SQL {
  const component = COVERING_COMPONENT[category];
  if (component === "fees") {
    return sql`exists (select 1 from ${orderTransactionFees} where ${orderTransactionFees.orderId} = ${orders.id})`;
  }
  if (component === "packaging") {
    return sql`exists (select 1 from ${inventoryValuations} where ${inventoryValuations.orderId} = ${orders.id}
      and ${inventoryValuations.kind} = 'outflow' and ${inventoryValuations.details}->>'movementType' = 'material_consume')`;
  }
  return sql`exists (select 1 from ${carrierInvoiceLines} where ${carrierInvoiceLines.orderId} = ${orders.id}
    and ${carrierInvoiceLines.matchStatus} in ('matched', 'manual') and ${carrierInvoiceLines.lineKind} = 'charge'
    and ${carrierInvoiceLines.chargeType} not in ('customs_duty', 'return_delivery', 'redirect'))`;
}

/** Кандидати розподілу витрати (див. вгорі файла); onlyOrderId — перевірити одне замовлення. */
export async function allocationCandidates(
  db: DbOrTx,
  row: ExpenseRow,
  opts: {
    includeTestOrders: boolean;
    onlyOrderId?: string;
    /** Виправлення: записи цієї (щойно анульованої, ще не сторнованої) витрати не роблять складник фактичним. */
    ignoreExpenseId?: string;
  },
): Promise<Candidate[]> {
  if (!isAllocatableRow(row)) return [];
  const category = row.category as CoveringCategory;
  const window = coverageWindow(row);
  const conds: SQL[] = [
    gte(orders.placedAt, businessDayStart(window.from)),
    lte(orders.placedAt, businessDayEnd(window.to)),
    ne(orders.status, "cancelled"),
    sql`coalesce(${orderFinance.state}, 'open') in ('open', 'recognized')`,
    sql`not ${sourceFactExists(category)}`,
  ];
  if (opts.onlyOrderId) conds.push(eq(orders.id, opts.onlyOrderId));
  if (!opts.includeTestOrders) conds.push(eq(orders.shopifyTest, false));
  const dimension = COVERING_DIMENSION[category];
  if (dimension === "gateway" && row.gateway) {
    const g = row.gateway;
    conds.push(
      or(
        sql`exists (select 1 from ${orderShopifyFinance} where ${orderShopifyFinance.orderId} = ${orders.id} and ${g} = any(${orderShopifyFinance.paymentGatewayNames}))`,
        sql`exists (select 1 from ${orderTransactions} where ${orderTransactions.orderId} = ${orders.id} and ${orderTransactions.gateway} = ${g})`,
      )!,
    );
  }
  if (dimension === "carrier" && row.carrierCode) {
    const c = row.carrierCode;
    conds.push(
      or(
        sql`exists (select 1 from ${shipments} where ${shipments.orderId} = ${orders.id} and ${shipments.carrierCode} = ${c})`,
        sql`exists (select 1 from ${orderExternalWaybills} where ${orderExternalWaybills.orderId} = ${orders.id} and ${orderExternalWaybills.carrierCode} = ${c})`,
      )!,
    );
  }
  // Складник уже фактичний з іншого джерела (запис тієї самої категорії, не розподіл).
  conds.push(
    notExists(
      db
        .select({ one: sql`1` })
        .from(financeEntries)
        .where(
          and(
            eq(financeEntries.orderId, orders.id),
            eq(financeEntries.category, category),
            ne(financeEntries.sourceType, "allocation"),
            opts.ignoreExpenseId ? sql`${financeEntries.sourceId} is distinct from ${opts.ignoreExpenseId}` : undefined,
            activeEntry(db),
          ),
        ),
    ),
  );
  // Діюча ручна витрата замовлення тієї самої категорії (може ще чекати визнання).
  conds.push(
    sql`not exists (select 1 from ${financeExpenses} fx where fx.order_id = ${orders.id} and fx.category = ${category} and fx.status = 'active')`,
  );
  // Покрите поточною версією розподілу іншої діючої (додатної) суми періоду тієї самої категорії.
  conds.push(
    sql`not exists (select 1 from ${financeExpenseAllocations} fa join ${financeExpenses} fo on fo.id = fa.expense_id
      where fa.order_id = ${orders.id} and fa.expense_version = fo.version and fo.status = 'active'
        and fo.covers_forecast and fo.amount > 0 and fo.category = ${category} and fo.id <> ${row.id})`,
  );
  const rows = await db
    .select({ id: orders.id, placedAt: orders.placedAt, currency: orders.currency, total: orders.total })
    .from(orders)
    .leftJoin(orderFinance, eq(orderFinance.orderId, orders.id))
    .where(and(...conds))
    .orderBy(asc(orders.placedAt), asc(orders.id));
  return rows.map((r) => ({ id: r.id, placedAt: r.placedAt, currency: r.currency.trim(), total: r.total }));
}

/** Значення в різних валютах → спільні одиниці (гривні × 10^10 за курсом дати; одна валюта — без конвертації). */
async function commonWeights(
  db: DbOrTx,
  values: ReadonlyArray<{ orderId: string; currency: string; minor: bigint; date: string }>,
  mode: AppMode,
): Promise<Map<string, bigint>> {
  const out = new Map<string, bigint>();
  const currencies = new Set(values.map((v) => v.currency));
  if (currencies.size <= 1) {
    for (const v of values) out.set(v.orderId, (out.get(v.orderId) ?? 0n) + (v.minor > 0n ? v.minor : 0n));
    return out;
  }
  for (const v of values) {
    const r = await rateFor(db, v.currency, v.date, { mode });
    if (!r.ok) throw new DomainError("finance.error.noRate", 422, { currency: v.currency, date: v.date });
    // Гривні в сотих частках × 10^10 (без округлення — лише ваги).
    const w = v.minor > 0n ? v.minor * r.scaled : 0n;
    out.set(v.orderId, (out.get(v.orderId) ?? 0n) + w);
  }
  return out;
}

/** Розподіл суми витрати на кандидатів (null — кандидатів немає: сума проводиться одним записом періоду). */
export async function computeAllocation(
  db: DbOrTx,
  row: ExpenseRow,
  opts: { mode: AppMode; includeTestOrders: boolean; ignoreExpenseId?: string },
): Promise<ComputedAllocation | null> {
  if (!row.coversForecast || row.status !== "active" || !isAllocatableRow(row)) return null;
  const candidates = await allocationCandidates(db, row, opts);
  if (candidates.length === 0) return null;
  const component = COVERING_COMPONENT[row.category as keyof typeof COVERING_COMPONENT];
  const dateOf = new Map(candidates.map((c) => [c.id, businessDate(c.placedAt)]));
  const forecasts = await db
    .select({ orderId: orderFinanceForecasts.orderId, currency: orderFinanceForecasts.currency, amount: orderFinanceForecasts.amount })
    .from(orderFinanceForecasts)
    .where(and(inArray(orderFinanceForecasts.orderId, candidates.map((c) => c.id)), eq(orderFinanceForecasts.component, component)));
  // Прогнози order_finance_forecasts — зі знаком впливу на прибуток (витрата «−», WP4/WP7, модель WP12a): вага —
  // величина прогнозу витрати (|сума|), інакше кожен справжній прогноз комісії / доставки / упаковки відкидався б (> 0) і
  // розподіл завжди падав би на виручку (§10.3 «пропорційно їхнім прогнозам», G13).
  const fWeights = await commonWeights(
    db,
    forecasts.map((f) => {
      const minor = toMinorForCurrency(f.amount, f.currency.trim());
      return { orderId: f.orderId, currency: f.currency.trim(), minor: minor < 0n ? -minor : minor, date: dateOf.get(f.orderId)! };
    }),
    opts.mode,
  );
  const total = toMinorForCurrency(row.amount, row.currency);
  let basis: ComputedAllocation["weightBasis"] = "forecast";
  let participants = candidates.filter((c) => (fWeights.get(c.id) ?? 0n) > 0n);
  let weights = participants.map((c) => fWeights.get(c.id)!);
  if (participants.length === 0) {
    basis = "revenue";
    const rWeights = await commonWeights(
      db,
      candidates.map((c) => ({ orderId: c.id, currency: c.currency, minor: toMinorForCurrency(c.total, c.currency), date: dateOf.get(c.id)! })),
      opts.mode,
    );
    const positive = candidates.filter((c) => (rWeights.get(c.id) ?? 0n) > 0n);
    participants = positive.length > 0 ? positive : candidates;
    weights = positive.length > 0 ? positive.map((c) => rWeights.get(c.id)!) : candidates.map(() => RATE_SCALE_FACTOR);
  }
  const parts = allocateCurrencyMinor(total, row.currency, weights);
  return { weightBasis: basis, shares: participants.map((c, i) => ({ orderId: c.id, minor: parts[i]! })) };
}

/** Поточні частки витрати (версія = версія витрати). */
export async function currentAllocations(db: DbOrTx, expense: Pick<ExpenseRow, "id" | "version">): Promise<AllocationRow[]> {
  return db
    .select()
    .from(financeExpenseAllocations)
    .where(and(eq(financeExpenseAllocations.expenseId, expense.id), eq(financeExpenseAllocations.expenseVersion, expense.version)))
    .orderBy(asc(financeExpenseAllocations.createdAt), asc(financeExpenseAllocations.orderId));
}

/** Чи збігається новий розрахунок із поточними частками (ті самі замовлення й суми). */
export function sameAllocation(current: readonly Pick<AllocationRow, "orderId" | "amount">[], computed: ComputedAllocation | null): boolean {
  const next = computed?.shares ?? [];
  if (current.length !== next.length) return false;
  const byOrder = new Map(current.map((c) => [c.orderId, c.amount]));
  return next.every((s) => {
    const a = byOrder.get(s.orderId);
    return a !== undefined && toMinor(a) === s.minor;
  });
}

// ---------------------------------------------------------------------------
// I16 для WP4: стан покриття складника замовлення сумою періоду
// ---------------------------------------------------------------------------

export interface OrderCoveringStatus {
  /** Складник замовлення (fees / shipping_cost / packaging). */
  component: OrderComponent;
  category: CoveringCategory;
  expenseId: string;
  expenseVersion: number;
  /**
   * - `allocated` — у замовлення є рядок частки ПОТОЧНОЇ версії діючої суми: складник фактичний (`basis = allocated`,
   *   частка може бути 0), прогноз складника НЕ рахується;
   * - `awaiting_reallocation` — замовлення входить у вимір і вікно діючої суми й перерахунок дав би йому частку, але
   *   частки поточної версії немає (оформлене / імпортоване / знову враховане після збереження суми): прогноз складника
   *   НЕ рахується в «≈ Прогноз» (I16), доки власник не натисне «Перерахувати розподіл» (сторінка «Витрати» показує
   *   попередження «Розподіл застарів»).
   */
  state: "allocated" | "awaiting_reallocation";
}

/**
 * ВНУТРІШНЄ (WP4 syncOrderFinance, у його транзакції; без перевірки актора, без грошей): які складники замовлення
 * покриває сума періоду (§10.3, I16). Один рядок на (категорію, суму). Порожньо — сум немає.
 */
export async function coveringStatusForOrder(db: DbOrTx, orderId: string, opts: { mode?: AppMode; includeTestOrders?: boolean } = {}): Promise<OrderCoveringStatus[]> {
  const out: OrderCoveringStatus[] = [];
  const seen = new Set<string>();
  const allocated = await db
    .select({ expenseId: financeExpenses.id, version: financeExpenses.version, category: financeExpenses.category })
    .from(financeExpenseAllocations)
    .innerJoin(financeExpenses, eq(financeExpenses.id, financeExpenseAllocations.expenseId))
    .where(
      and(
        eq(financeExpenseAllocations.orderId, orderId),
        eq(financeExpenseAllocations.expenseVersion, financeExpenses.version),
        eq(financeExpenses.status, "active"),
        eq(financeExpenses.coversForecast, true),
        isNull(financeExpenses.orderId),
      ),
    )
    .orderBy(asc(financeExpenses.id));
  for (const a of allocated) {
    if (!isCoveringCategory(a.category as never)) continue;
    const category = a.category as CoveringCategory;
    seen.add(a.expenseId);
    out.push({ component: COVERING_COMPONENT[category], category, expenseId: a.expenseId, expenseVersion: a.version, state: "allocated" });
  }
  const [order] = await db.select({ placedAt: orders.placedAt }).from(orders).where(eq(orders.id, orderId));
  if (!order) return out;
  const day = businessDate(order.placedAt);
  const sums = await db
    .select()
    .from(financeExpenses)
    .where(
      and(
        eq(financeExpenses.status, "active"),
        eq(financeExpenses.coversForecast, true),
        isNull(financeExpenses.orderId),
        sql`${financeExpenses.amount} > 0`,
        or(
          and(isNull(financeExpenses.periodFrom), gte(financeExpenses.expenseDate, monthStart(day)), lte(financeExpenses.expenseDate, monthEnd(day))),
          and(lte(financeExpenses.periodFrom, day), gte(financeExpenses.periodTo, day)),
        ),
      ),
    )
    .orderBy(asc(financeExpenses.id));
  const pending = sums.filter((r) => !seen.has(r.id) && isAllocatableRow(r));
  if (pending.length === 0) return out;
  const includeTestOrders = opts.includeTestOrders ?? (await loadFinanceSettings(db)).includeTestOrders;
  // syncOrderFinance (WP4) не знає режиму: ядро (resolveRateMode) — робочий сервер завжди production; демо й тести —
  // demo за наявністю демо-курсів (як costingRateMode WP2).
  const mode: AppMode = opts.mode ?? (await resolveRateMode(db));
  for (const r of pending) {
    const category = r.category as CoveringCategory;
    let wouldShare: boolean;
    try {
      const computed = await computeAllocation(db, r, { mode, includeTestOrders });
      wouldShare = computed?.shares.some((x) => x.orderId === orderId) ?? false;
    } catch {
      // Немає курсу для ваг різних валют: обережно — кандидат виміру й вікна вважається непокритим.
      wouldShare = (await allocationCandidates(db, r, { includeTestOrders, onlyOrderId: orderId })).length > 0;
    }
    if (wouldShare) out.push({ component: COVERING_COMPONENT[category], category, expenseId: r.id, expenseVersion: r.version, state: "awaiting_reallocation" });
  }
  return out;
}

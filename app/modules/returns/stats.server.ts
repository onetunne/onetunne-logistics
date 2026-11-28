/**
 * Етап 6, WP9: статистика повернень (docs/stage6-design.md §11, §2.6 — завжди з покриттям).
 *
 * Тестові замовлення Shopify (`orders.shopify_test`, §2.5) не враховуються, якщо власник не ввімкнув
 * `finance.includeTestOrders` — той самий набір замовлень, що й у частці повернень (когорта визнаних замовлень).
 *
 * `returnStats` (orders.view — кількості, без грошей): випадки за періодом першого сигналу (Київ) — за видом, статусом,
 * причиною (покриття: з відомою причиною), моделлю, кольором, товаром, країною; одиниці (поповнено / не поповнено склад,
 * пошкоджено); середні дні «доставка → повернення» (лише випадки з відомою датою вручення — «за N з M»); до / після
 * відвантаження (перший сигнал щодо першої передачі перевізнику); «Очікує надходження на склад» (§6.7); одиниці з
 * неточною кількістю (рядки повернення коштів MIXED) — окремо («можливо ще N»), у точні не додаються. Частка повернень (правило повноти §2.6, МАЄ):
 * замовлення, ВИЗНАНІ в періоді (order_finance, стан recognized), з відомими даними повернень (без `order_unreadable` /
 * `awaiting_shopify` у виручці) — знаменник; з них ті, що мають ≥ 1 повернення коштів після визнання (активний запис
 * refund_*, §2.1) або надходження-повернення на склад, — чисельник; той самий набір замовлень.
 *
 * `returnMoneyStats` (requireFinance view — лише власнику): записи журналу періоду (`recognized_on`): повернено коштів
 * (refund_*), витрати на повернення = зворотна доставка (return_shipping_cost — з рахунків і вручну) + обробка
 * (return_handling), вплив на собівартість (cogs_return); у валюті показу, без курсу — окремо, ніколи 0.
 */
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financeEntries, orderReturnLines, orderReturns, orders, productVariants, products } from "~/db/schema";
import type { FinanceCategory } from "~/domain/finance";
import { requirePermission } from "~/domain/permissions";
import { daysBetween, type DateRange } from "~/lib/periods";
import { requireFinance } from "~/modules/finance/core/access.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { businessDate, businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { RETURN_COST_CATEGORIES, RETURN_MONEY_GROUPS, returnsCurrency, sumGroups, type ReturnMoneySum } from "./amounts.server";
import { caseInsight } from "./attribution";
import { CUSTOMER_RETURN_REASON, loadShippingFacts } from "./facts.server";
import { loadLineOrigins } from "./insights.server";
import { averageDays, groupCounts, sharePercent, type ReturnKind, type ReturnReason, type ReturnStatus } from "./rules";

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode">;

export interface CountRow<K extends string = string> {
  key: K;
  /** Підпис (товар — назва; модель / колір — значення; null — «Без моделі» / «Без кольору» / «Без країни»). */
  label?: string | null;
  cases: number;
  units: number;
}

export interface ReturnRate {
  /** Замовлення з поверненням (чисельник). */
  returned: number;
  /** Визнані замовлення періоду з відомими даними повернень (знаменник). */
  known: number;
  /** Усі визнані замовлення періоду (покриття: known з recognized). */
  recognized: number;
  /** returned / known, % з 1 знаком; null — знаменник 0 («—»). */
  percent: string | null;
}

export interface ReturnStats {
  range: DateRange;
  cases: number;
  byKind: Array<CountRow<ReturnKind>>;
  byStatus: Array<CountRow<ReturnStatus>>;
  byReason: Array<CountRow<ReturnReason>>;
  /** Випадки з відомою причиною (≠ unknown) з усіх. */
  reasonCoverage: { n: number; m: number };
  byProduct: CountRow[];
  byModel: CountRow[];
  byColor: CountRow[];
  byCountry: CountRow[];
  units: {
    /** Точно відомі одиниці. */
    total: number;
    restocked: number;
    notRestocked: number;
    damaged: number;
    /** Можливо ще одиниць (рядки повернення коштів MIXED — кількість неточна), не входять у total. */
    uncertain: number;
    /** Випадки з неточною кількістю. */
    uncertainCases: number;
  };
  /** §6.7 «Очікує надходження на склад» (незакриті випадки). */
  awaitingReceipt: number;
  days: { average: string | null; n: number; m: number };
  timing: { beforeShipment: number; afterShipment: number };
  rate: ReturnRate;
  /** Тестові замовлення враховано (`finance.includeTestOrders`). */
  includesTestOrders: boolean;
}

const NONE = "__none__";

/** Випадки з першим сигналом у періоді (Київ); тестові замовлення — лише з `includeTestOrders`. */
export function returnsRangeWhere(range: DateRange, includeTestOrders: boolean) {
  return and(
    eq(orderReturns.storeId, DEFAULT_STORE_ID),
    gte(orderReturns.firstSignalAt, businessDayStart(range.from)),
    lte(orderReturns.firstSignalAt, businessDayEnd(range.to)),
    includeTestOrders ? undefined : eq(orders.shopifyTest, false),
  );
}

/** Налаштування власника «Враховувати тестові замовлення» (§2.5, типово ні). */
export async function includeTestOrdersSetting(db: DbOrTx): Promise<boolean> {
  return (await loadFinanceSettings(db)).includeTestOrders === true;
}

const REFUND_CATEGORIES: readonly FinanceCategory[] = RETURN_MONEY_GROUPS.refunds;

/** Частка повернень (когорта визнаних у періоді замовлень, §2.6). */
export async function returnRate(ctx: Pick<ServiceContext, "db" | "actor">, range: DateRange): Promise<ReturnRate> {
  requirePermission(ctx.actor, "orders.view");
  const refundList = sql.join(
    REFUND_CATEGORIES.map((c) => sql`${c}`),
    sql`, `,
  );
  const res = await ctx.db.execute(sql`
    with cohort as (
      select f.order_id,
        coalesce(f.components -> 'revenue' ->> 'state' = 'missing' and f.components -> 'revenue' ->> 'reason' in ('order_unreadable', 'awaiting_shopify'), false) as unknown
      from order_finance f
      where f.store_id = ${DEFAULT_STORE_ID} and f.state = 'recognized' and f.recognized_on between ${range.from} and ${range.to}
    )
    select count(*) as recognized,
      count(*) filter (where not c.unknown) as known,
      count(*) filter (where not c.unknown and (
        exists (select 1 from finance_entries e
          where e.order_id = c.order_id and e.category in (${refundList}) and e.reverses_entry_id is null
            and not exists (select 1 from finance_entries r where r.reverses_entry_id = e.id))
        or exists (select 1 from inventory_movements m
          where m.order_id = c.order_id and m.type = 'receipt_manual' and m.reason = ${CUSTOMER_RETURN_REASON})
      )) as returned
    from cohort c`);
  const r = res as unknown as { rows?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
  const row = (Array.isArray(r) ? r : (r.rows ?? []))[0];
  const recognized = Number(row?.recognized ?? 0);
  const known = Number(row?.known ?? 0);
  const returned = Number(row?.returned ?? 0);
  return {
    returned,
    known,
    recognized,
    percent: sharePercent(returned, known),
  };
}

export async function returnStats(ctx: Pick<ServiceContext, "db" | "actor">, input: { range: DateRange }): Promise<ReturnStats> {
  requirePermission(ctx.actor, "orders.view");
  const { range } = input;
  const includesTestOrders = await includeTestOrdersSetting(ctx.db);
  const cases = await ctx.db
    .select({
      id: orderReturns.id,
      orderId: orderReturns.orderId,
      kind: orderReturns.kind,
      status: orderReturns.status,
      reasonCode: orderReturns.reasonCode,
      firstSignalAt: orderReturns.firstSignalAt,
      country: orders.shipCountryCode,
    })
    .from(orderReturns)
    .innerJoin(orders, eq(orders.id, orderReturns.orderId))
    .where(returnsRangeWhere(range, includesTestOrders))
    .orderBy(asc(orderReturns.firstSignalAt), asc(orderReturns.id));
  const ids = cases.map((c) => c.id);
  const loadLines = async () => {
    const out = [];
    for (let i = 0; i < ids.length; i += 1000) {
      out.push(
        ...(await ctx.db
          .select({
            line: orderReturnLines,
            productId: productVariants.productId,
            productTitle: products.title,
            model: productVariants.model,
            color: productVariants.color,
          })
          .from(orderReturnLines)
          .leftJoin(productVariants, eq(productVariants.id, orderReturnLines.variantId))
          .leftJoin(products, eq(products.id, productVariants.productId))
          .where(inArray(orderReturnLines.returnId, ids.slice(i, i + 1000)))),
      );
    }
    return out;
  };
  const [lines, shipping, rate, origins] = await Promise.all([
    loadLines(),
    loadShippingFacts(
      ctx.db,
      cases.map((c) => c.orderId),
    ),
    returnRate(ctx, range),
    loadLineOrigins(
      ctx.db,
      cases.map((c) => c.orderId),
    ),
  ]);
  const linesByCase = new Map<string, Array<(typeof lines)[number]["line"]>>();
  for (const l of lines) {
    const list = linesByCase.get(l.line.returnId);
    if (list) list.push(l.line);
    else linesByCase.set(l.line.returnId, [l.line]);
  }
  const variantInfo = new Map(lines.filter((l) => l.line.variantId).map((l) => [l.line.variantId!, l]));
  const kindRows: Array<CountRow<ReturnKind>> = [];
  const statusRows: Array<CountRow<ReturnStatus>> = [];
  const reasonRows: Array<CountRow<ReturnReason>> = [];
  const productRows: CountRow[] = [];
  const modelRows: CountRow[] = [];
  const colorRows: CountRow[] = [];
  const countryRows: CountRow[] = [];
  const productLabel = new Map<string, string | null>();
  const units = { total: 0, restocked: 0, notRestocked: 0, damaged: 0, uncertain: 0, uncertainCases: 0 };
  let awaitingReceipt = 0;
  const days: number[] = [];
  const timing = { beforeShipment: 0, afterShipment: 0 };
  for (const c of cases) {
    const insight = caseInsight(c, linesByCase.get(c.id) ?? [], origins);
    const u = insight.units;
    units.total += u.units;
    units.restocked += u.restocked;
    units.notRestocked += Math.max(0, u.units - u.restocked);
    units.damaged += u.damaged;
    units.uncertain += u.uncertainUnits;
    if (insight.quantityUncertain) units.uncertainCases++;
    if (insight.awaitingReceipt) awaitingReceipt++;
    kindRows.push({ key: c.kind, cases: 1, units: u.units });
    statusRows.push({ key: c.status, cases: 1, units: u.units });
    reasonRows.push({ key: c.reasonCode, cases: 1, units: u.units });
    countryRows.push({ key: c.country ?? NONE, cases: 1, units: u.units });
    // Товар / модель / колір: випадок рахується один раз на значення, одиниці — за позиціями.
    const perProduct = new Map<string, number>();
    const perModel = new Map<string, number>();
    const perColor = new Map<string, number>();
    for (const it of u.items) {
      const info = it.variantId ? variantInfo.get(it.variantId) : undefined;
      const productKey = info?.productId ?? NONE;
      if (info?.productId) productLabel.set(info.productId, info.productTitle ?? null);
      perProduct.set(productKey, (perProduct.get(productKey) ?? 0) + it.units);
      perModel.set(info?.model ?? NONE, (perModel.get(info?.model ?? NONE) ?? 0) + it.units);
      perColor.set(info?.color ?? NONE, (perColor.get(info?.color ?? NONE) ?? 0) + it.units);
    }
    for (const [key, n] of perProduct) productRows.push({ key, cases: 1, units: n });
    for (const [key, n] of perModel) modelRows.push({ key, cases: 1, units: n });
    for (const [key, n] of perColor) colorRows.push({ key, cases: 1, units: n });
    const ship = shipping.get(c.orderId);
    if (ship?.deliveredAt) {
      const d = daysBetween(businessDate(ship.deliveredAt), businessDate(c.firstSignalAt));
      if (d >= 0) days.push(d);
    }
    if (ship && (ship.shippedAt ? ship.shippedAt.getTime() <= c.firstSignalAt.getTime() : ship.shipped)) timing.afterShipment++;
    else timing.beforeShipment++;
  }
  const labelled = (rows: CountRow[], label: (k: string) => string | null) =>
    groupCounts(rows).map((r) => ({
      ...r,
      label: r.key === NONE ? null : label(r.key),
    }));
  return {
    range,
    cases: cases.length,
    byKind: groupCounts(kindRows),
    byStatus: groupCounts(statusRows),
    byReason: groupCounts(reasonRows),
    reasonCoverage: {
      n: cases.filter((c) => c.reasonCode !== "unknown").length,
      m: cases.length,
    },
    byProduct: labelled(productRows, (k) => productLabel.get(k) ?? null),
    byModel: labelled(modelRows, (k) => k),
    byColor: labelled(colorRows, (k) => k),
    byCountry: labelled(countryRows, (k) => k),
    units,
    awaitingReceipt,
    days: { average: averageDays(days), n: days.length, m: cases.length },
    timing,
    rate,
    includesTestOrders,
  };
}

export interface ReturnMoneyStats {
  currency: string;
  currencies: string[];
  range: DateRange;
  /** Повернено коштів (refund_*, від'ємні — як у звіті P&L). */
  refunds: ReturnMoneySum;
  returnShipping: ReturnMoneySum;
  returnHandling: ReturnMoneySum;
  /** Витрати на повернення = зворотна доставка + обробка. */
  returnCosts: ReturnMoneySum;
  /** Сторно собівартості придатних повернень (cogs_return). */
  cogsReturn: ReturnMoneySum;
}

export async function returnMoneyStats(ctx: Ctx, input: { range: DateRange; currency?: string | null }): Promise<ReturnMoneyStats> {
  requireFinance(ctx, "view");
  const { currency, options } = await returnsCurrency(ctx.db, input.currency);
  const cats = [...RETURN_MONEY_GROUPS.refunds, ...RETURN_COST_CATEGORIES, ...RETURN_MONEY_GROUPS.cogsReturn];
  const rows = await ctx.db
    .select({
      category: financeEntries.category,
      amount: financeEntries.amount,
      currency: financeEntries.currency,
      fxOn: financeEntries.fxOn,
    })
    .from(financeEntries)
    .where(
      and(
        eq(financeEntries.storeId, DEFAULT_STORE_ID),
        inArray(financeEntries.category, cats),
        gte(financeEntries.recognizedOn, input.range.from),
        lte(financeEntries.recognizedOn, input.range.to),
      ),
    );
  const g = await sumGroups(
    ctx,
    rows,
    {
      refunds: RETURN_MONEY_GROUPS.refunds,
      returnShipping: RETURN_MONEY_GROUPS.returnShipping,
      returnHandling: RETURN_MONEY_GROUPS.returnHandling,
      returnCosts: RETURN_COST_CATEGORIES,
      cogsReturn: RETURN_MONEY_GROUPS.cogsReturn,
    },
    currency,
  );
  return { currency, currencies: options, range: input.range, ...g };
}

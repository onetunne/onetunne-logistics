/**
 * Етап 6, WP4: список «Фінанси → Замовлення» (docs/stage6-design.md §18.2) — СЕРВІС ЧИТАННЯ власника (requireFinance
 * "view" першим рядком). Колонки: номер, дата визнання, країна, чиста виручка, собівартість, доставка (стан), комісії,
 * партнер, прибуток, рентабельність, стан. Пошук за номером замовлення; фільтри: період (дата визнання; невизнані — дата
 * оформлення), стан, країна, «потребує перевірки», партнер, «лише збиткові» (прибуток у валюті показу < 0); сортування
 * на сервері; сторінки по PAGE_SIZE.
 *
 * Суми — з журналу (F1) у валюті показу: кожен запис за курсом свого fx_on (sqlConvertAmount — той самий вираз, що TS,
 * I6), потім сума; колонка, у якій хоч один запис без курсу, — не часткова сума, а «—» з позначкою «без курсу»
 * (`unconvertedColumns`; F4, §2.6); рентабельність без відомої чистої виручки — «—». Прибуток — за станом:
 * `final` — «Факт» = Σ записів; `preliminary` — «≈ Прогноз» = Σ записів + Σ прогнозів, що рахуються (без «Оцінки»
 * виручки; components.ts isForecastCounted); `incomplete` і невизнані — не показується (null).
 */
import { sql, type SQL } from "drizzle-orm";
import { PROFIT_CATEGORIES, type ComponentState, type OrderComponent, type OrderFinanceState, type ProfitState } from "~/domain/finance";
import { assertSupportedCurrency, marginPercent, toMinorForCurrency } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import { requireFinance } from "~/modules/finance/core/access.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { parseOrderComponents } from "~/modules/finance/core/states";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { sqlConvertAmount } from "~/modules/fx/sql";
import type { ServiceContext } from "~/server/types";

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;

export {
  ORDER_FINANCE_LIST_STATES,
  ORDER_FINANCE_PAGE_SIZE,
  ORDER_FINANCE_SORTS,
  type OrderFinanceList,
  type OrderFinanceListFilter,
  type OrderFinanceListRow,
  type OrderFinanceListState,
  type OrderFinanceSort,
} from "./list-types";
import { ORDER_FINANCE_PAGE_SIZE, type OrderFinanceList, type OrderFinanceListFilter, type OrderFinanceListRow, type OrderFinanceSort } from "./list-types";

function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = result as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const list = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);

const NR_CATEGORIES = ["sales_product", "sales_shipping", "sales_other", "sales_adjustment", "sales_unknown", "refund_product", "refund_shipping", "refund_other", "refund_adjustment", "refund_unknown", "chargeback_loss"];
const COGS_CATEGORIES = ["cogs", "cogs_return", "cogs_adjustment"];
const SHIPPING_CATEGORIES = ["shipping_cost", "return_shipping_cost"];
const FEE_CATEGORIES = ["payment_fees", "platform_fees", "chargeback_fees"];

function num(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(2, "0").slice(0, 2)}`;
}

/** Список фінансів замовлень (див. шапку). */
export async function listOrderFinance(ctx: Ctx, filter: OrderFinanceListFilter = {}): Promise<OrderFinanceList> {
  requireFinance(ctx, "view");
  const settings = await loadFinanceSettings(ctx.db);
  const display = [...new Set([settings.reportingCurrency, ...settings.displayCurrencies])];
  const currency = filter.currency && display.includes(filter.currency) ? filter.currency : settings.reportingCurrency;
  assertSupportedCurrency(currency);
  const rateOpts = { mode: ctx.mode, fallbackDays: settings.fx.fallbackDays };
  const today = businessDate(ctx.now());
  const page = Math.max(1, Math.min(Math.trunc(filter.page ?? 1) || 1, 100000));
  const pageSize = ORDER_FINANCE_PAGE_SIZE;
  const conv = sqlConvertAmount(sql`fe.amount`, sql`fe.currency`, sql`fe.fx_on`, currency, rateOpts);
  // Дата курсу прогнозу: виручка й комісії — дата курсу виручки (D-25), інше — дата визнання; невизнані — сьогодні.
  const paymentDateSql = sql`coalesce((select (min(t.processed_at) at time zone 'Europe/Kyiv')::date from order_transactions t
      where t.order_id = f2.order_id and t.status = 'SUCCESS' and not t.test and t.kind in ('SALE', 'CAPTURE')),
    (o2.placed_at at time zone 'Europe/Kyiv')::date)`;
  const revenueFxSql = settings.fx.rateDatePolicy === "recognition_date" ? sql`f2.recognized_on` : paymentDateSql;
  const fcDate = sql`(case when f2.recognized_on is null then ${today}::date when fc.component in ('fees', 'revenue') then ${revenueFxSql} else f2.recognized_on end)`;
  const fcConv = sqlConvertAmount(sql`fc.amount`, sql`fc.currency`, fcDate, currency, rateOpts);

  const where: SQL[] = [sql`f.store_id = ${DEFAULT_STORE_ID}`];
  const q = (filter.q ?? "").trim().slice(0, 40);
  if (q) where.push(sql`o.order_number ilike ${`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`}`);
  const dateExpr = sql`coalesce(f.recognized_on, (o.placed_at at time zone 'Europe/Kyiv')::date)`;
  if (filter.from && ISO_RE.test(filter.from)) where.push(sql`${dateExpr} >= ${filter.from}::date`);
  if (filter.to && ISO_RE.test(filter.to)) where.push(sql`${dateExpr} <= ${filter.to}::date`);
  if (filter.state) {
    if (filter.state === "final" || filter.state === "preliminary" || filter.state === "incomplete") where.push(sql`f.state = 'recognized' and f.profit_state = ${filter.state}`);
    else where.push(sql`f.state = ${filter.state}`);
  }
  if (filter.country && /^[A-Z]{2}$/.test(filter.country)) where.push(sql`upper(o.ship_country_code) = ${filter.country}`);
  if (filter.needsReview) where.push(sql`f.needs_review`);
  if (filter.partnerId && UUID_RE.test(filter.partnerId)) where.push(sql`exists (select 1 from partner_attributions pa where pa.order_id = f.order_id and pa.partner_id = ${filter.partnerId} and pa.status = 'attributed')`);
  const whereSql = sql.join(where, sql` and `);

  const base = sql`
    with sel as (
      select f.order_id from order_finance f join orders o on o.id = f.order_id where ${whereSql}
    ),
    e as (
      select fe.order_id, fe.category, ${conv} as v
      from finance_entries fe join sel on sel.order_id = fe.order_id
      where fe.store_id = ${DEFAULT_STORE_ID} and fe.reverses_entry_id is null
        and not exists (select 1 from finance_entries r where r.reverses_entry_id = fe.id)
    ),
    agg as (
      select order_id,
        sum(v) filter (where category in (${list(PROFIT_CATEGORIES)})) as profit,
        count(*) filter (where v is null and category in (${list(PROFIT_CATEGORIES)})) as unconverted,
        sum(v) filter (where category in (${list(NR_CATEGORIES)})) as nr,
        count(*) filter (where category in (${list(NR_CATEGORIES)})) as nr_n,
        count(*) filter (where v is null and category in (${list(NR_CATEGORIES)})) as nr_u,
        sum(v) filter (where category in (${list(COGS_CATEGORIES)})) as cogs,
        count(*) filter (where category in (${list(COGS_CATEGORIES)})) as cogs_n,
        count(*) filter (where v is null and category in (${list(COGS_CATEGORIES)})) as cogs_u,
        sum(v) filter (where category in (${list(SHIPPING_CATEGORIES)})) as shipping,
        count(*) filter (where category in (${list(SHIPPING_CATEGORIES)})) as shipping_n,
        count(*) filter (where v is null and category in (${list(SHIPPING_CATEGORIES)})) as shipping_u,
        sum(v) filter (where category in (${list(FEE_CATEGORIES)})) as fees,
        count(*) filter (where category in (${list(FEE_CATEGORIES)})) as fees_n,
        count(*) filter (where v is null and category in (${list(FEE_CATEGORIES)})) as fees_u,
        sum(v) filter (where category = 'partner_commission') as partner,
        count(*) filter (where category = 'partner_commission') as partner_n,
        count(*) filter (where v is null and category = 'partner_commission') as partner_u
      from e group by order_id
    ),
    fca as (
      select fc.order_id, sum(${fcConv}) as forecast, count(*) filter (where ${fcConv} is null) as forecast_unconverted
      from order_finance_forecasts fc
      join sel on sel.order_id = fc.order_id
      join order_finance f2 on f2.order_id = fc.order_id
      join orders o2 on o2.id = fc.order_id
      where fc.component <> 'revenue'
        and coalesce((f2.components -> fc.component ->> 'hasForecast')::boolean, false)
        and coalesce(f2.components -> fc.component ->> 'state', 'missing') not in ('actual', 'zero_confirmed', 'not_applicable')
      group by fc.order_id
    ),
    rows as (
      select f.order_id, o.order_number, f.recognized_on, (o.placed_at at time zone 'Europe/Kyiv')::date as placed_on, upper(o.ship_country_code) as country,
        f.state, f.profit_state, f.needs_review, f.components,
        agg.profit, coalesce(agg.unconverted, 0) + coalesce(fca.forecast_unconverted, 0) as unconverted,
        -- Колонка з хоч одним записом без курсу — не сума (часткова сума виглядала б повною, F4): null + позначка.
        case when coalesce(agg.nr_u, 0) > 0 then null else agg.nr end as nr, agg.nr_n, coalesce(agg.nr_u, 0) as nr_u,
        agg.cogs, agg.cogs_n, coalesce(agg.cogs_u, 0) as cogs_u,
        agg.shipping, agg.shipping_n, coalesce(agg.shipping_u, 0) as shipping_u,
        agg.fees, agg.fees_n, coalesce(agg.fees_u, 0) as fees_u,
        agg.partner, agg.partner_n, coalesce(agg.partner_u, 0) as partner_u,
        (select pa.partner_id from partner_attributions pa where pa.order_id = f.order_id and pa.status = 'attributed') as partner_id,
        case
          when f.state <> 'recognized' then null
          when coalesce(agg.unconverted, 0) > 0 then null
          when f.profit_state = 'final' then coalesce(agg.profit, 0)
          when f.profit_state = 'preliminary' and coalesce(fca.forecast_unconverted, 0) = 0 then coalesce(agg.profit, 0) + coalesce(fca.forecast, 0)
          else null
        end as shown_profit
      from order_finance f
      join orders o on o.id = f.order_id
      left join agg on agg.order_id = f.order_id
      left join fca on fca.order_id = f.order_id
      where ${whereSql}
    )`;
  const loss = filter.lossOnly ? sql`where shown_profit < 0` : sql``;
  const sort = filter.sort ?? "recognized_desc";
  const marginExpr = sql`(case when nr > 0 and shown_profit is not null then shown_profit / nr else null end)`;
  const orderBy: Record<OrderFinanceSort, SQL> = {
    recognized_desc: sql`coalesce(recognized_on, placed_on) desc nulls last, order_number desc`,
    recognized_asc: sql`coalesce(recognized_on, placed_on) asc nulls last, order_number asc`,
    profit_desc: sql`shown_profit desc nulls last, order_number desc`,
    profit_asc: sql`shown_profit asc nulls last, order_number asc`,
    margin_desc: sql`${marginExpr} desc nulls last, order_number desc`,
    margin_asc: sql`${marginExpr} asc nulls last, order_number asc`,
    revenue_desc: sql`nr desc nulls last, order_number desc`,
  };
  const result = await ctx.db.execute(sql`${base}
    select * from rows ${loss}
    order by ${orderBy[sort] ?? orderBy.recognized_desc}
    limit ${pageSize} offset ${(page - 1) * pageSize}`);
  const countResult = await ctx.db.execute(sql`${base} select count(*)::int as n from rows ${loss}`);
  const countryResult = await ctx.db.execute(sql`
    select distinct upper(o.ship_country_code) as c from order_finance f join orders o on o.id = f.order_id
    where f.store_id = ${DEFAULT_STORE_ID} and o.ship_country_code is not null order by 1`);
  const rows: OrderFinanceListRow[] = rowsOf(result).map((r) => {
    const state = String(r.state) as OrderFinanceState;
    const profitState = String(r.profit_state) as ProfitState;
    const unconverted = Number(r.unconverted ?? 0);
    const shown = num(r.shown_profit);
    const unconv = (u: unknown) => Number(u ?? 0) > 0;
    const components = parseOrderComponents(r.components) ?? {};
    const states: Partial<Record<OrderComponent, ComponentState>> = {};
    for (const [k, v] of Object.entries(components)) if (v) states[k as OrderComponent] = v.state;
    // «0,00» — лише ВІДОМИЙ нуль (§2.6, F4): визнане замовлення, складник фактичний / «0 (підтверджено)», а записів немає
    // (нульові записи не проводяться — правило «без комісії», позначка «Шлюз без комісії», безкоштовна доставка); інакше
    // без записів — «—» (невідоме).
    const knownZero = (component: OrderComponent, n: unknown) => {
      const st = components[component]?.state;
      const settled = component === "revenue" ? st === "actual" || st === "partial" : st === "actual" || st === "zero_confirmed";
      return state === "recognized" && settled && Number(n ?? 0) === 0;
    };
    const amountOr = (value: unknown, n: unknown, u: unknown, component: OrderComponent) => (Number(n ?? 0) > 0 && !unconv(u) ? num(value) : knownZero(component, n) ? "0.00" : null);
    const nr = amountOr(r.nr, r.nr_n, r.nr_u, "revenue");
    // Прибуток не показано ЛИШЕ через записи / прогнози без курсу у валюті показу — «без курсу», а не «немає даних» (§2.6).
    const shownOr = (kind: "fact" | "forecast") => (shown !== null ? kind : unconverted > 0 ? "no_rate" : "hidden");
    const profitKind: OrderFinanceListRow["profitKind"] =
      state !== "recognized" ? "not_applicable" : profitState === "final" ? shownOr("fact") : profitState === "preliminary" ? shownOr("forecast") : "hidden";
    const unconvertedColumns: OrderFinanceListRow["unconvertedColumns"] = [];
    if (unconv(r.nr_u)) unconvertedColumns.push("netRevenue");
    if (unconv(r.cogs_u)) unconvertedColumns.push("cogs");
    if (unconv(r.shipping_u)) unconvertedColumns.push("shipping");
    if (unconv(r.fees_u)) unconvertedColumns.push("fees");
    if (unconv(r.partner_u)) unconvertedColumns.push("partner");
    return {
      orderId: String(r.order_id),
      orderNumber: String(r.order_number),
      recognizedOn: r.recognized_on ? String(r.recognized_on).slice(0, 10) : null,
      placedOn: String(r.placed_on).slice(0, 10),
      country: r.country ? String(r.country) : null,
      state,
      profitState,
      needsReview: Boolean(r.needs_review),
      netRevenue: nr,
      cogs: amountOr(r.cogs, r.cogs_n, r.cogs_u, "cogs"),
      shipping: amountOr(r.shipping, r.shipping_n, r.shipping_u, "shipping_cost"),
      fees: amountOr(r.fees, r.fees_n, r.fees_u, "fees"),
      partner: amountOr(r.partner, r.partner_n, r.partner_u, "partner"),
      profit: profitKind === "fact" || profitKind === "forecast" ? shown : null,
      profitKind,
      margin: shown !== null && nr !== null && (profitKind === "fact" || profitKind === "forecast") ? marginPercent(toMinorForCurrency(shown, currency), toMinorForCurrency(nr, currency)) : null,
      unconverted,
      unconvertedColumns,
      components: states,
      partnerId: r.partner_id ? String(r.partner_id) : null,
    };
  });
  return {
    currency,
    displayCurrencies: display,
    rows,
    total: Number(rowsOf(countResult)[0]?.n ?? 0),
    page,
    pageSize,
    countries: rowsOf(countryResult)
      .map((r) => (r.c ? String(r.c) : ""))
      .filter((c) => /^[A-Z]{2}$/.test(c)),
  };
}

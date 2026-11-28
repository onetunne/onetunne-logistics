/**
 * Етап 6, WP7: «Ефективність партнера» за період (docs/stage6-design.md §9.6, F1, §2.6). Сервіс читання власника
 * (finance.view). Замовлення — атрибутовані партнеру й ВИЗНАНІ в періоді (order_finance.recognized_on), з усіма їхніми
 * записами журналу (будь-якої дати) і прогнозами; фіксовані оплати — записи partner_fixed_fee з partner_id цього
 * партнера, визнані в періоді. Кожен запис конвертується окремо за курсом свого fx_on (одне округлення на запис, потім
 * сума — sumConverted); записи без курсу не входять у суми й показуються окремо («Без курсу»), замовлення з такими
 * записами не входить у прибуток (повнота); фіксована оплата без курсу робить окупність невідомою (не 0 у знаменнику).
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { financeEntries, orderFinance, orderFinanceForecasts, partnerAttributions, partners } from "~/db/schema";
import { isFinanceCategory, type FinanceCategory, type ProfitState } from "~/domain/finance";
import { fromMinor, toMinorForCurrency } from "~/lib/decimal";
import { monthStart, type DateRange } from "~/lib/periods";
import { requireFinance } from "~/modules/finance/core/access.server";
import { sumConverted, type ConvertibleEntry, type UnconvertedTotal } from "~/modules/fx/convert";
import { createRateResolver, rateWindowOf } from "~/modules/fx/rate-for.server";
import type { ServiceContext } from "~/server/types";
import { summarizePerformance, type PerformanceOrder, type PerformanceSummary } from "./performance";

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode">;

export interface PartnerPerformanceView {
  partnerId: string;
  range: DateRange;
  currency: string;
  summary: PerformanceSummary;
  /** Записи без курсу для валюти показу (не в сумах). */
  unconverted: UnconvertedTotal[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mergeUnconverted(into: Map<string, { minor: bigint; entries: number }>, list: readonly UnconvertedTotal[]) {
  for (const u of list) {
    const m = into.get(u.currency) ?? { minor: 0n, entries: 0 };
    m.minor += toMinorForCurrency(u.amount, u.currency);
    m.entries += u.entries;
    into.set(u.currency, m);
  }
}

/** Показники партнера (§9.6) у валюті показу `currency`. null — партнера немає. */
export async function getPartnerPerformance(ctx: Ctx, input: { partnerId: string; range: DateRange; currency: string }): Promise<PartnerPerformanceView | null> {
  requireFinance(ctx, "view");
  if (!UUID_RE.test(input.partnerId)) return null;
  const [p] = await ctx.db.select({ id: partners.id }).from(partners).where(eq(partners.id, input.partnerId));
  if (!p) return null;
  const target = input.currency;
  const orderRows = await ctx.db
    .select({ orderId: orderFinance.orderId, profitState: orderFinance.profitState, recognizedOn: orderFinance.recognizedOn })
    .from(partnerAttributions)
    .innerJoin(orderFinance, eq(orderFinance.orderId, partnerAttributions.orderId))
    .where(
      and(
        eq(partnerAttributions.partnerId, p.id),
        eq(partnerAttributions.status, "attributed"),
        eq(orderFinance.state, "recognized"),
        gte(orderFinance.recognizedOn, input.range.from),
        lte(orderFinance.recognizedOn, input.range.to),
      ),
    );
  const ids = orderRows.map((o) => o.orderId);
  const entries = ids.length
    ? await ctx.db
        .select({ orderId: financeEntries.orderId, category: financeEntries.category, amount: financeEntries.amount, currency: financeEntries.currency, fxOn: financeEntries.fxOn })
        .from(financeEntries)
        .where(inArray(financeEntries.orderId, ids))
    : [];
  const forecasts = ids.length
    ? await ctx.db
        .select({ orderId: orderFinanceForecasts.orderId, component: orderFinanceForecasts.component, amount: orderFinanceForecasts.amount, currency: orderFinanceForecasts.currency })
        .from(orderFinanceForecasts)
        .where(inArray(orderFinanceForecasts.orderId, ids))
    : [];
  const fees = await ctx.db
    .select({ amount: financeEntries.amount, currency: financeEntries.currency, fxOn: financeEntries.fxOn })
    .from(financeEntries)
    .where(and(eq(financeEntries.partnerId, p.id), eq(financeEntries.category, "partner_fixed_fee"), gte(financeEntries.recognizedOn, input.range.from), lte(financeEntries.recognizedOn, input.range.to)));
  const recognizedOf = new Map(orderRows.map((o) => [o.orderId, o.recognizedOn ?? input.range.to]));
  const forecastEntries: Array<ConvertibleEntry & { orderId: string; component: string }> = forecasts.map((f) => ({
    orderId: f.orderId,
    component: f.component,
    amount: f.amount,
    currency: f.currency,
    fxOn: recognizedOf.get(f.orderId) ?? input.range.to,
  }));
  const window = rateWindowOf([...entries, ...forecastEntries, ...fees], [target]);
  const resolver = window ? await createRateResolver(ctx.db, window, { mode: ctx.mode }) : null;
  const rateOf = (currency: string, fxOn: string) => (resolver ? resolver.scaled(currency, fxOn) : null);
  const unconverted = new Map<string, { minor: bigint; entries: number }>();

  const perfOrders: PerformanceOrder[] = orderRows.map((o) => {
    const own = entries.filter((e) => e.orderId === o.orderId);
    const byCategory: Partial<Record<FinanceCategory, bigint>> = {};
    let missingRate = false;
    const unconvertedCategories: FinanceCategory[] = [];
    const cats = [...new Set(own.map((e) => e.category))].filter(isFinanceCategory);
    for (const c of cats) {
      const r = sumConverted(own.filter((e) => e.category === c), target, rateOf);
      if (r.unconverted.length) {
        missingRate = true;
        unconvertedCategories.push(c);
        mergeUnconverted(unconverted, r.unconverted);
      }
      if (r.total !== null) byCategory[c] = toMinorForCurrency(r.total, target);
    }
    const fc = forecastEntries.filter((f) => f.orderId === o.orderId);
    const fcAll = sumConverted(fc, target, rateOf);
    const fcPartner = sumConverted(fc.filter((f) => f.component === "partner"), target, rateOf);
    if (fcAll.unconverted.length) missingRate = true;
    return {
      orderId: o.orderId,
      month: monthStart(o.recognizedOn ?? input.range.to),
      profitState: o.profitState as ProfitState,
      byCategory,
      unconverted: missingRate,
      unconvertedCategories,
      forecastTotal: fcAll.total ? toMinorForCurrency(fcAll.total, target) : 0n,
      forecastPartner: fcPartner.total ? toMinorForCurrency(fcPartner.total, target) : 0n,
    };
  });
  const feeSum = sumConverted(fees, target, rateOf);
  mergeUnconverted(unconverted, feeSum.unconverted);
  // Лише сконвертовані фіксовані оплати в сумі; є без курсу — окупність невідома (fixedFeesComplete = false).
  const fixedFeesMinor = feeSum.total ? -toMinorForCurrency(feeSum.total, target) : 0n;
  return {
    partnerId: p.id,
    range: input.range,
    currency: target,
    summary: summarizePerformance(perfOrders, fixedFeesMinor, { fixedFeesComplete: feeSum.unconverted.length === 0 }),
    unconverted: [...unconverted.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([currency, m]) => ({ currency, amount: fromMinor(m.minor), entries: m.entries })),
  };
}

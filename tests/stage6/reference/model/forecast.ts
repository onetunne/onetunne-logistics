/**
 * Еталонна модель (WP12a): прогноз доходів і витрат (§12.3) — «Прогноз, а не факт».
 *
 * Тлумачення моделі (передано WP8): категорії й прибуток — суми з одним округленням кожної категорії (дохід ×
 * відношення); прибуток = дохід − Σ змінних − Σ постійних (те саме, що дохід × (1 − Σ відношень) − Σ постійних, без
 * подвійного округлення). Постійні: advertising, platform (Shopify, без замовлення), taxes, salaries, services, other
 * (rent, bank_fees, other_expense, partner_fixed_fee). Витрати у валюті звітності — додатні величини (`expense`).
 */
import { divRound, mulDiv, rational, str, type Cents, type Rational } from "./money";
import { addDays, daysBetween, daysInMonth, monthEnd, monthOf, addMonths } from "./dates";
import { isNetRevenue, type RefCategory, type RefComponent } from "./categories";
import { Converter, type RefJournal } from "./pnl";
import type { ConvertContext } from "./fx";

export const VARIABLE_GROUPS = ["cogs", "shipping", "packaging", "fees", "partners"] as const;
export type VariableGroup = (typeof VARIABLE_GROUPS)[number];
export const FIXED_GROUPS = ["advertising", "platform", "taxes", "salaries", "services", "other"] as const;
export type FixedGroup = (typeof FIXED_GROUPS)[number];

export const VARIABLE_CATEGORIES: Record<VariableGroup, readonly RefCategory[]> = {
  cogs: ["cogs", "cogs_return", "cogs_adjustment"],
  shipping: ["shipping_cost", "return_shipping_cost"],
  packaging: ["packaging"],
  fees: ["payment_fees", "platform_fees", "chargeback_fees"],
  partners: ["partner_commission"],
};
export const VARIABLE_COMPONENT: Record<VariableGroup, RefComponent> = { cogs: "cogs", shipping: "shipping_cost", packaging: "packaging", fees: "fees", partners: "partner" };
export const FIXED_CATEGORIES: Record<FixedGroup, readonly RefCategory[]> = {
  advertising: ["advertising"],
  platform: ["platform_fees"],
  taxes: ["taxes_company"],
  salaries: ["salaries"],
  services: ["services"],
  other: ["rent", "bank_fees", "other_expense", "partner_fixed_fee"],
};

export interface ForecastInputs {
  today: string;
  /** Днів історії до вчора і кількість визнаних замовлень у вікні (поріг показу: ≥ 28 і ≥ 10). */
  historyDays: number;
  recognizedOrders: number;
  windowDays: number;
  /** Чиста виручка визнаних замовлень у вікні. */
  windowNR: Cents;
  /** NR поточного місяця до вчора включно. */
  monthNRToYesterday: Cents;
  variable: Record<VariableGroup, { cost: Cents; finalNR: Cents; settledOrders: number; recognizedOrders: number }>;
  fixed: Record<FixedGroup, { months: readonly Cents[]; confirmedNone?: boolean; enteredForTarget?: Cents | null }>;
}

export interface ForecastResult {
  status: "ok" | "insufficient";
  currentMonthRevenue: string | null;
  nextMonth: {
    month: string;
    revenue: string | null;
    variable: Record<VariableGroup, string | null>;
    fixed: Record<FixedGroup, string | null>;
    totalCosts: string | null;
    profit: string | null;
    missing: Array<VariableGroup | FixedGroup>;
  };
}

/** Відношення змінної категорії до NR за остаточними замовленнями, якщо повнота ≥ 80 %; інакше null. */
export function variableRatio(v: ForecastInputs["variable"][VariableGroup]): Rational | null {
  if (v.recognizedOrders === 0 || v.settledOrders * 5 < v.recognizedOrders * 4 || v.finalNR <= 0n) return null;
  return rational(v.cost, v.finalNR);
}

/** Прогноз (§12.3, G17). */
export function forecast(i: ForecastInputs): ForecastResult {
  const next = addMonths(monthOf(i.today), 1);
  const empty = Object.fromEntries;
  if (i.historyDays < 28 || i.recognizedOrders < 10 || i.windowDays <= 0) {
    return {
      status: "insufficient",
      currentMonthRevenue: null,
      nextMonth: { month: next, revenue: null, variable: empty(VARIABLE_GROUPS.map((g) => [g, null])) as ForecastResult["nextMonth"]["variable"], fixed: empty(FIXED_GROUPS.map((g) => [g, null])) as ForecastResult["nextMonth"]["fixed"], totalCosts: null, profit: null, missing: [] },
    };
  }
  const restDays = daysBetween(i.today, monthEnd(monthOf(i.today))) + 1;
  const current = i.monthNRToYesterday + mulDiv(i.windowNR, BigInt(restDays), BigInt(i.windowDays));
  const revenue = mulDiv(i.windowNR, BigInt(daysInMonth(next)), BigInt(i.windowDays));
  const variable = {} as Record<VariableGroup, string | null>;
  const fixed = {} as Record<FixedGroup, string | null>;
  const missing: Array<VariableGroup | FixedGroup> = [];
  let costs = 0n;
  for (const g of VARIABLE_GROUPS) {
    const r = variableRatio(i.variable[g]);
    if (r === null) {
      variable[g] = null;
      missing.push(g);
      continue;
    }
    const v = mulDiv(revenue, r.num, r.den);
    variable[g] = str(v);
    costs += v;
  }
  for (const g of FIXED_GROUPS) {
    const f = i.fixed[g];
    let v: Cents | null;
    if (f.enteredForTarget !== undefined && f.enteredForTarget !== null) v = f.enteredForTarget;
    else if (f.months.some((m) => m !== 0n)) v = divRound(f.months.reduce((a, m) => a + m, 0n), 3n);
    else v = f.confirmedNone ? 0n : null;
    if (v === null) {
      fixed[g] = null;
      missing.push(g);
      continue;
    }
    fixed[g] = str(v);
    costs += v;
  }
  const can = missing.length === 0;
  return {
    status: "ok",
    currentMonthRevenue: str(current),
    nextMonth: { month: next, revenue: str(revenue), variable, fixed, totalCosts: can ? str(costs) : null, profit: can ? str(revenue - costs) : null, missing },
  };
}

/**
 * Вхід прогнозу з журналу (для I5 на випадкових наборах): вікно — 90 повних днів до вчора; змінні — за final
 * замовленнями вікна; повнота — частка визнаних у вікні, де складник settled; постійні — 3 повні місяці до поточного.
 */
export function forecastInputsFromJournal(j: RefJournal, today: string, currency: string, ctx: ConvertContext, opts: { firstDataOn?: string; confirmedNone?: readonly FixedGroup[] } = {}): ForecastInputs {
  const yesterday = addDays(today, -1);
  const from = addDays(today, -90);
  const conv = new Converter(currency, ctx);
  const meta = new Map(j.orders.map((m) => [m.orderId, m]));
  const recognized = j.orders.filter((m) => (m.state === "final" || m.state === "preliminary" || m.state === "incomplete") && m.recognizedOn !== null && m.recognizedOn >= from && m.recognizedOn <= yesterday);
  const recIds = new Set(recognized.map((m) => m.orderId));
  const isNr = isNetRevenue;
  let windowNR = 0n;
  let monthNR = 0n;
  const finalNR = { v: 0n };
  const varCost = Object.fromEntries(VARIABLE_GROUPS.map((g) => [g, 0n])) as Record<VariableGroup, Cents>;
  for (const e of j.entries) {
    if (!e.orderId || !recIds.has(e.orderId)) continue;
    const v = conv.of(e);
    if (v === null) continue;
    if (isNr(e.category)) windowNR += v;
    if (meta.get(e.orderId)?.state === "final") {
      if (isNr(e.category)) finalNR.v += v;
      for (const g of VARIABLE_GROUPS) if (VARIABLE_CATEGORIES[g].includes(e.category)) varCost[g] += -v;
    }
  }
  const monthStartDay = `${monthOf(today)}-01`;
  for (const e of j.entries) {
    if (!e.orderId) continue;
    const m = meta.get(e.orderId);
    if (!m || !m.recognizedOn || m.recognizedOn < monthStartDay || m.recognizedOn > yesterday || !(m.state === "final" || m.state === "preliminary" || m.state === "incomplete")) continue;
    if (!isNr(e.category)) continue;
    const v = conv.of(e);
    if (v !== null) monthNR += v;
  }
  const variable = {} as ForecastInputs["variable"];
  for (const g of VARIABLE_GROUPS) {
    const settledOrders = recognized.filter((m) => {
      const st = m.components?.[VARIABLE_COMPONENT[g]]?.state ?? "not_applicable";
      return st === "actual" || st === "zero_confirmed" || st === "not_applicable";
    }).length;
    variable[g] = { cost: varCost[g], finalNR: finalNR.v, settledOrders, recognizedOrders: recognized.length };
  }
  const months = [addMonths(monthOf(today), -3), addMonths(monthOf(today), -2), addMonths(monthOf(today), -1)];
  const fixed = {} as ForecastInputs["fixed"];
  for (const g of FIXED_GROUPS) {
    const sums = months.map((mo) => {
      let s = 0n;
      for (const e of j.entries) {
        if (e.orderId || monthOf(e.recognizedOn) !== mo || !FIXED_CATEGORIES[g].includes(e.category)) continue;
        const v = conv.of(e);
        if (v !== null) s += -v;
      }
      return s;
    });
    fixed[g] = { months: sums, confirmedNone: opts.confirmedNone?.includes(g) ?? false };
  }
  const first = opts.firstDataOn ?? recognized.map((m) => m.recognizedOn!).sort()[0] ?? today;
  return {
    today,
    historyDays: Math.min(90, Math.max(0, daysBetween(first, yesterday) + 1)),
    recognizedOrders: recognized.length,
    windowDays: 90,
    windowNR,
    monthNRToYesterday: monthNR,
    variable,
    fixed,
  };
}

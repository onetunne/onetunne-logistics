/**
 * Етап 6, WP7: «Ефективність партнера» й «Окупність» (docs/stage6-design.md §9.6, золотий G19). ЧИСТІ функції над уже
 * сконвертованими (у валюту показу) сумами записів журналу й прогнозів атрибутованих замовлень, визнаних у періоді.
 *
 * Правило повноти (§2.6): прибуток «Факт» — лише замовлення `final` (і лише якщо всі їхні записи мали курс); «≈ Прогноз»
 * = факт + записи й прогнози замовлень `preliminary`; `incomplete` не входять у жоден прибуток. Покриття — завжди.
 * Окупність = прибуток атрибутованих замовлень ПІСЛЯ всіх їхніх витрат (з винагородою) ÷ (винагорода + фіксовані
 * оплати); знаменник ≤ 0 → null («—»). G19: (4 200 − 800) / (800 + 200) = 3,40. Фіксовані оплати періоду, з яких
 * хоч одна без курсу для валюти показу, — знаменник НЕВІДОМИЙ: окупність null (`paybackMissing = fixed_fees_unconverted`),
 * а не завищена (F4); повнота кожної частини (виручка, винагорода, chargeback, фіксовані оплати) — у `complete`.
 * Конверсія й нові/повторні покупці — НЕДОСТУПНО (немає даних сесій і покупців).
 */
import { affectsProfit, FINANCE_CATEGORY_DEFS, type FinanceCategory, type ProfitState } from "~/domain/finance";
import { fromMinor, marginPercent, mulDivHalfAwayFromZero, scaledToDecimal } from "~/lib/decimal";

/** Окупність: profitAfter / (commission + fixedFees), 2 знаки (половина від нуля); знаменник ≤ 0 → null. */
export function paybackRatio(profitAfterMinor: bigint, commissionMinor: bigint, fixedFeesMinor: bigint): string | null {
  const den = commissionMinor + fixedFeesMinor;
  if (den <= 0n) return null;
  return scaledToDecimal(mulDivHalfAwayFromZero(profitAfterMinor, 100n, den), 2, 2);
}

export interface PerformanceOrder {
  orderId: string;
  /** Перший день місяця визнання. */
  month: string;
  profitState: ProfitState;
  /** Σ записів за категоріями (соті валюти показу; лише записи з курсом). */
  byCategory: Partial<Record<FinanceCategory, bigint>>;
  /** Є записи без курсу для валюти показу — прибуток замовлення невідомий. */
  unconverted: boolean;
  /** Категорії, у яких є записи без курсу (повнота окремих показників). */
  unconvertedCategories?: readonly FinanceCategory[];
  /** Σ прогнозів замовлення (соті, знак — за впливом на прибуток) і частина «партнер». */
  forecastTotal: bigint;
  forecastPartner: bigint;
}

export interface PerformanceMonth {
  month: string;
  orders: number;
  netProducts: string;
  commission: string;
  /** Прибуток після винагороди, лише остаточні замовлення місяця; null — немає жодного. */
  profit: string | null;
  finalOrders: number;
}

export interface PerformanceSummary {
  orders: number;
  final: number;
  preliminary: number;
  incomplete: number;
  /** Замовлення з фактичною виручкою (знаменник середнього чека). */
  withRevenue: number;
  netProducts: string;
  turnover: string;
  averageCheck: string | null;
  /** Частка замовлень з поверненням коштів, % (1 знак); null — немає виручки. */
  returnShare: string | null;
  returnOrders: number;
  chargebackLoss: string;
  chargebackOrders: number;
  /** Винагорода всіх замовлень періоду (нарахування + коригування, ≥ 0 як витрата). */
  commission: string;
  fixedFees: string;
  /** Повнота частин: false — є записи без курсу (суми показано без них, маркер «Неповні дані»). */
  complete: { revenue: boolean; commission: boolean; chargeback: boolean; fixedFees: boolean };
  /** Чому окупність «—», хоча прибуток відомий. */
  paybackMissing: "fixed_fees_unconverted" | null;
  fact: { profitBefore: string | null; profitAfter: string | null; commission: string; payback: string | null };
  forecast: { profitBefore: string | null; profitAfter: string | null; commission: string; payback: string | null };
  months: PerformanceMonth[];
}

/** Оборот T = A + B + C (§2.2): усі категорії виду revenue. */
const TURNOVER = (Object.keys(FINANCE_CATEGORY_DEFS) as FinanceCategory[]).filter((c) => FINANCE_CATEGORY_DEFS[c].kind === "revenue");
const REFUND_CATEGORIES = (Object.keys(FINANCE_CATEGORY_DEFS) as FinanceCategory[]).filter((c) => c.startsWith("refund_"));

const sumOf = (o: PerformanceOrder, cats: readonly FinanceCategory[]) => cats.reduce((s, c) => s + (o.byCategory[c] ?? 0n), 0n);
const profitOf = (o: PerformanceOrder) => (Object.keys(o.byCategory) as FinanceCategory[]).filter(affectsProfit).reduce((s, c) => s + (o.byCategory[c] ?? 0n), 0n);
const commissionOf = (o: PerformanceOrder) => -(o.byCategory.partner_commission ?? 0n);

/**
 * Показники партнера за період (див. вгорі файла). `fixedFeesMinor` ≥ 0 — фіксовані оплати періоду як витрата (лише
 * сконвертовані); `opts.fixedFeesComplete = false` — частина фіксованих оплат без курсу (окупність невідома).
 */
export function summarizePerformance(orders: readonly PerformanceOrder[], fixedFeesMinor: bigint, opts: { fixedFeesComplete?: boolean } = {}): PerformanceSummary {
  const fixedFeesComplete = opts.fixedFeesComplete !== false;
  const missingIn = (cats: readonly FinanceCategory[]) => orders.some((o) => (o.unconvertedCategories ?? []).some((c) => cats.includes(c)));
  let netProducts = 0n;
  let turnover = 0n;
  let withRevenue = 0;
  let returnOrders = 0;
  let chargeback = 0n;
  let chargebackOrders = 0;
  let commission = 0n;
  let final = 0;
  let preliminary = 0;
  let incomplete = 0;
  let factProfit = 0n;
  let factCommission = 0n;
  let fcProfit = 0n;
  let fcCommission = 0n;
  const months = new Map<string, { orders: number; netProducts: bigint; commission: bigint; profit: bigint; finalOrders: number }>();
  for (const o of orders) {
    const hasRevenue = TURNOVER.some((c) => o.byCategory[c] !== undefined);
    const np = sumOf(o, ["sales_product", "refund_product"]);
    netProducts += np;
    turnover += sumOf(o, TURNOVER);
    if (hasRevenue) withRevenue++;
    if (REFUND_CATEGORIES.some((c) => (o.byCategory[c] ?? 0n) !== 0n)) returnOrders++;
    const cb = o.byCategory.chargeback_loss ?? 0n;
    chargeback += cb;
    if (cb !== 0n) chargebackOrders++;
    const c = commissionOf(o);
    commission += c;
    const m = months.get(o.month) ?? { orders: 0, netProducts: 0n, commission: 0n, profit: 0n, finalOrders: 0 };
    m.orders++;
    m.netProducts += np;
    m.commission += c;
    const known = !o.unconverted;
    if (o.profitState === "final" && known) {
      final++;
      const p = profitOf(o);
      factProfit += p;
      factCommission += c;
      fcProfit += p;
      fcCommission += c;
      m.profit += p;
      m.finalOrders++;
    } else if (o.profitState === "preliminary" && known) {
      preliminary++;
      fcProfit += profitOf(o) + o.forecastTotal;
      fcCommission += c - o.forecastPartner;
    } else {
      incomplete++;
    }
    months.set(o.month, m);
  }
  const fact = final > 0;
  const fc = final + preliminary > 0;
  const paybackMissing = fixedFeesComplete ? null : ("fixed_fees_unconverted" as const);
  return {
    orders: orders.length,
    final,
    preliminary,
    incomplete,
    withRevenue,
    netProducts: fromMinor(netProducts),
    turnover: fromMinor(turnover),
    averageCheck: withRevenue > 0 ? fromMinor(mulDivHalfAwayFromZero(turnover, 1n, BigInt(withRevenue))) : null,
    returnShare: withRevenue > 0 ? marginPercent(BigInt(returnOrders), BigInt(withRevenue)) : null,
    returnOrders,
    chargebackLoss: fromMinor(chargeback),
    chargebackOrders,
    commission: fromMinor(commission),
    fixedFees: fromMinor(fixedFeesMinor),
    complete: {
      revenue: !missingIn(TURNOVER),
      commission: !missingIn(["partner_commission"]),
      chargeback: !missingIn(["chargeback_loss"]),
      fixedFees: fixedFeesComplete,
    },
    paybackMissing: fact || fc ? paybackMissing : null,
    fact: {
      profitAfter: fact ? fromMinor(factProfit) : null,
      profitBefore: fact ? fromMinor(factProfit + factCommission) : null,
      commission: fromMinor(factCommission),
      payback: fact && fixedFeesComplete ? paybackRatio(factProfit, factCommission, fixedFeesMinor) : null,
    },
    forecast: {
      profitAfter: fc ? fromMinor(fcProfit) : null,
      profitBefore: fc ? fromMinor(fcProfit + fcCommission) : null,
      commission: fromMinor(fcCommission),
      payback: fc && fixedFeesComplete ? paybackRatio(fcProfit, fcCommission, fixedFeesMinor) : null,
    },
    months: [...months.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([month, m]) => ({
        month,
        orders: m.orders,
        netProducts: fromMinor(m.netProducts),
        commission: fromMinor(m.commission),
        profit: m.finalOrders > 0 ? fromMinor(m.profit) : null,
        finalOrders: m.finalOrders,
      })),
  };
}

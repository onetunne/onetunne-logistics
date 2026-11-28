/**
 * Золоті випадки етапу 6 (WP12a → WP12b): валюти (G3, G4), партнер (G6, G19), розподіли (G7, G13), закриття місяця
 * й знімки в кожній валюті показу (G11), сторно в іншій валюті (G11b), прогноз (G17). Значення з §20.1; позначені
 * «похідне» — пораховані незалежно (Python Decimal) для повноти перевірки.
 */
import type { RefExpense } from "../model/journal";
import type { PartnerOrderLedger, PartnerPayout } from "../model/partners";
import type { ForecastInputs } from "../model/forecast";

export const G3_EXPECTED = {
  date: "2026-11-20",
  eurToUah: { amount: "100.00", expected: "4953.35" },
  eurToUsd: { amount: "100.00", expected: "109.94" },
  eurToHuf: { amount: "100.00", expected: "36880.53" },
  bigEurToUsd: { amount: "123456.78", expected: "135733.90", crossRounded: "135728.38", crossRate: "1.0994" },
  implied: { presentmentGbp: "86.40", shopEur: "100.00", expected: "0.8640" },
  saturday: { date: "2026-11-21", rateDate: "2026-11-21", fallback: false },
  manualFallback: { date: "2026-11-21", rateDate: "2026-11-20", fallback: true },
  gap8Days: { currency: "GBP", date: "2026-11-20", rate: null },
  jpy: { eurToJpy: { amount: "100.00", expected: "17578.00" }, smallEurToJpy: { amount: "0.64", expected: "112.00", twoStep: "113.00" }, jpyToUah: { amount: "1000.00", expected: "281.80" } },
  /** похідне (вигаданий курс KRW 3,0812 за 100). */
  krw: { eurToKrw: { amount: "100.00", expected: "160760.00" }, krwToUah: { amount: "10000.00", expected: "308.12" }, krwToEur: { amount: "10000.00", expected: "6.22" }, jpyToKrw: { amount: "1000.00", expected: "9146.00" }, krwToJpy: { amount: "50000.00", expected: "5467.00" } },
} as const;

export const G4_INPUT = { date: "2026-11-27", sold: { amount: "1000.00", currency: "EUR" }, received: { amount: "48650.00", currency: "UAH" } } as const;
export const G4_EXPECTED = { difference: "-844.20" } as const;

/** G6 — нараховано 11,70 (05.10), виплата 11,70 (10.11), повне повернення 15.11, наступне замовлення +8,00 (20.11). */
export const G6_ORDERS: readonly PartnerOrderLedger[] = [
  {
    orderId: "o1",
    recognizedOn: "2026-10-05",
    holdDays: 30,
    events: [
      { n: 1, kind: "accrual", amount: 1170n, date: "2026-10-05" },
      { n: 2, kind: "cancellation", amount: -1170n, date: "2026-11-15" },
    ],
  },
  { orderId: "o2", recognizedOn: "2026-11-20", holdDays: 30, events: [{ n: 1, kind: "accrual", amount: 800n, date: "2026-11-20" }] },
];
export const G6_PAYOUTS: readonly PartnerPayout[] = [{ id: "pay1", paidOn: "2026-11-10", covers: "11.70" }];
export const G6_EXPECTED = {
  "2026-11-04": { balance: "11.70", payable: "0.00", o1: "accrued_hold" },
  "2026-11-05": { balance: "11.70", payable: "11.70", o1: "payable" },
  "2026-11-11": { balance: "0.00", payable: "0.00", o1: "paid" },
  "2026-11-16": { balance: "-11.70", payable: "0.00", o1: "cancelled" },
  "2026-11-21": { balance: "-3.70", payable: "0.00", o1: "cancelled" },
} as const;

/** G7 — 1 000,00 UAH за 01–30.11. */
export const G7_INPUT = { amount: "1000.00", from: "2026-11-01", to: "2026-11-30" } as const;
export const G7_EXPECTED = { first10: "33.34", rest20: "33.33", total: "1000.00" } as const;

/** G11b — реклама 100,00 EUR датою 20.10 (48,50), 06.11 змінено на 90,00 EUR (жовтень відкритий). */
export const G11B_EXPENSE: RefExpense = {
  id: "exp-g11b",
  versions: [
    { version: 1, category: "advertising", amount: "100.00", currency: "EUR", date: "2026-10-20", enteredAt: "2026-10-21T09:00:00Z" },
    { version: 2, category: "advertising", amount: "90.00", currency: "EUR", date: "2026-10-20", enteredAt: "2026-11-06T09:00:00Z" },
  ],
};
export const G11B_EXPECTED = { first: "-4850.00", reversal: "4850.00", reversalOn: "2026-10-20", reversalFxOn: "2026-10-20", second: "-4365.00", october: "-4365.00", november: "0.00" } as const;

/** G11 — реклама датою 20.10, введена 06.11 при закритому жовтні → відмова. */
export const G11_LATE_AD: RefExpense = { id: "exp-g11", versions: [{ version: 1, category: "advertising", amount: "50.00", currency: "UAH", date: "2026-10-20", enteredAt: "2026-11-06T09:00:00Z" }] };
export const G11_EXPECTED = {
  lateRefund: { recognizedOn: "2026-11-06", originalOn: "2026-10-31", fxOn: "2026-10-31", isLate: true },
  labelOctober: "net_profit",
  labelOctNov: "profit_after_costs",
  lateAd: { ok: false, error: "monthClosed", month: "2026-10" },
  /**
   * Знімки жовтня (закриття 05.11, валюти показу UAH і EUR) з G11_ORDER + G11_SERVICES_EXPENSE: «звіт жовтня = знімок у
   * кожній валюті показу». Похідне (Python Decimal): UAH 3 882,11 − 300,00; EUR 80,06 − 300 / 48,50 (запасний курс
   * 05.10) = 80,06 − 6,19. Після пізнього повернення (06.11) і курсу НБУ EUR 10.10 = 48,60 (отримано пізніше) звіт
   * жовтня лишається знімком; живий перерахунок EUR дав би 80,06 − 6,17 = 73,89.
   */
  snapshots: {
    month: "2026-10",
    closedAt: "2026-11-05T10:00:00Z",
    displayCurrencies: ["UAH", "EUR"],
    UAH: { profit: "3582.11", turnover: "6256.50", version: 1 },
    EUR: { profit: "73.87", turnover: "129.00", version: 1, liveWouldBe: "73.89" },
  },
  /** USD додано до показу 20.11 (після закриття) → «Живий перерахунок, не знімок»; похідне (Python Decimal). */
  addedCurrency: { currency: "USD", at: "2026-11-30T00:00:00Z", source: "live", liveNotSnapshot: true, profit: "86.33" },
  /** Листопад (відкритий) — наживо: пізнє повернення −45,00 EUR і коригування партнера +4,50 EUR датою 06.11. */
  november: { EUR: "-40.50", UAH: "-1968.30" },
  /** Діапазон жовтень–листопад у EUR = знімок жовтня + живий листопад (I15). */
  octNovEur: "33.37",
  /** Повторне відкриття 10.11 (з причиною) → наживо з новими курсами; закриття 15.11 → знімок версії 2, версія 1 зберігається. */
  reopen: { reopenedAt: "2026-11-10T09:00:00Z", liveEur: "73.89", reclosedAt: "2026-11-15T09:00:00Z", versionEur: 2, profitEurV2: "73.89" },
} as const;

/** G11 — витрата періоду жовтня (введена до закриття): послуги 300,00 UAH датою 10.10. */
export const G11_SERVICES_EXPENSE: RefExpense = { id: "exp-g11-services", versions: [{ version: 1, category: "services", amount: "300.00", currency: "UAH", date: "2026-10-10", enteredAt: "2026-10-12T09:00:00Z" }] };

/** G13 — прогнози комісій PayPal 3,00 / 2,00 / 1,00 EUR; фактична сума 7,00 EUR. */
export const G13_INPUT = { amount: "7.00", forecasts: ["3.00", "2.00", "1.00"] } as const;
export const G13_EXPECTED = ["3.50", "2.33", "1.17"] as const;

const C = (v: string) => BigInt(v.replace(".", ""));
const fixedNone = { months: [0n, 0n, 0n], confirmedNone: true };

/** G17 — вікно 90 днів, NR 90 000,00; сьогодні 15.10.2026 → наступний місяць листопад (30 днів). */
export const G17_INPUT_A: ForecastInputs = {
  today: "2026-10-15",
  historyDays: 90,
  recognizedOrders: 100,
  windowDays: 90,
  windowNR: C("90000.00"),
  monthNRToYesterday: C("14000.00"),
  variable: {
    cogs: { cost: C("21000.00"), finalNR: C("60000.00"), settledOrders: 100, recognizedOrders: 100 },
    shipping: { cost: C("6000.00"), finalNR: C("60000.00"), settledOrders: 60, recognizedOrders: 100 },
    packaging: { cost: C("600.00"), finalNR: C("60000.00"), settledOrders: 100, recognizedOrders: 100 },
    fees: { cost: C("1800.00"), finalNR: C("60000.00"), settledOrders: 95, recognizedOrders: 100 },
    partners: { cost: C("1200.00"), finalNR: C("60000.00"), settledOrders: 100, recognizedOrders: 100 },
  },
  fixed: {
    advertising: { months: [C("8000.00"), C("8500.00"), C("9000.00")] },
    platform: { months: [C("1700.00"), C("1700.00"), C("1700.00")] },
    services: { months: [C("300.00"), C("300.00"), C("300.00")] },
    taxes: fixedNone,
    salaries: fixedNone,
    other: fixedNone,
  },
};
export const G17_INPUT_B: ForecastInputs = { ...G17_INPUT_A, variable: { ...G17_INPUT_A.variable, shipping: { cost: C("6000.00"), finalNR: C("60000.00"), settledOrders: 85, recognizedOrders: 100 } } };
export const G17_EXPECTED = {
  a: { revenue: "30000.00", cogs: "10500.00", packaging: "300.00", fees: "900.00", partners: "600.00", shipping: null, profit: null, missing: ["shipping"], currentMonthRevenue: "31000.00" },
  b: { shipping: "3000.00", fixed: "10500.00", profit: "4200.00", totalCosts: "25800.00" },
} as const;

/** G19 — окупність партнера. */
export const G19_INPUT = { profitBeforeCommission: "4200.00", commission: "800.00", fixedFees: "200.00" } as const;
export const G19_EXPECTED = { profitAfter: "3400.00", payback: "3.40" } as const;

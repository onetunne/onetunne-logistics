/**
 * Золоті випадки етапу 6 (WP12a → WP12b): дані рівня журналу (G14, G14b, G16) — записи, стани замовлень, прогнози.
 * WP12b відтворює їх фактами застосунку (замовлення зі складниками у вказаних станах) і порівнює показники.
 */
import type { RefEntry } from "../model/journal";
import type { RefJournal, RefOrderMeta } from "../model/pnl";
import type { RefCategory } from "../model/categories";
import type { RefForecast } from "../model/order-posting";

let n = 0;
/** Запис журналу (UAH, дата 2026-11-10 за замовчуванням). */
export function je(orderId: string | null, category: RefCategory, amount: string, extra: Partial<RefEntry> = {}): RefEntry {
  const d = extra.recognizedOn ?? "2026-11-10";
  return {
    key: `g:${++n}`,
    orderId,
    category,
    amount,
    currency: "UAH",
    recognizedOn: d,
    fxOn: d,
    originalOn: d,
    isLate: false,
    isLateCompletion: false,
    reversesKey: null,
    ...extra,
  };
}

const settled = { state: "actual" as const };
const meta = (orderId: string, state: RefOrderMeta["state"], components: RefOrderMeta["components"], extra: Partial<RefOrderMeta> = {}): RefOrderMeta => ({
  orderId,
  state,
  recognizedOn: "2026-11-10",
  components,
  ...extra,
});
const fc = (orderId: string, component: RefForecast["component"], amount: string, basis: string): RefForecast => ({
  orderId,
  component,
  amount,
  currency: "UAH",
  fxOn: "2026-11-10",
  recognizedOn: "2026-11-10",
  basis,
});

/** G14 — повнота на панелі (магазин UAH), період — листопад 2026. */
export const G14_JOURNAL: RefJournal = {
  entries: [
    je("F", "sales_product", "300.00"),
    je("F", "cogs", "-120.00"),
    je("F", "shipping_cost", "-50.00"),
    je("F", "payment_fees", "-10.00"),
    je("F", "packaging", "-20.00"),
    je("P", "sales_product", "200.00"),
    je("P", "cogs", "-80.00"),
    je("P", "packaging", "-10.00"),
    je("P", "payment_fees", "-5.00"),
    je("I", "sales_product", "150.00"),
    je(null, "advertising", "-40.00", { recognizedOn: "2026-11-15", fxOn: "2026-11-15", originalOn: "2026-11-15" }),
  ],
  orders: [
    meta("F", "final", { revenue: settled, cogs: settled, packaging: settled, shipping_cost: settled, fees: settled }, { country: "DE" }),
    meta("P", "preliminary", { revenue: settled, cogs: settled, packaging: settled, shipping_cost: { state: "forecast" }, fees: settled }, { country: "DE" }),
    meta("I", "incomplete", { revenue: settled, cogs: { state: "missing" }, packaging: settled, shipping_cost: settled, fees: settled }, { country: "PL", missing: ["cogs"] }),
  ],
  forecasts: [fc("P", "shipping_cost", "-15.00", "country_average")],
};
export const G14_EXPECTED = {
  turnover: "650.00",
  orders: 3,
  averageCheck: "216.67",
  grossProfit: "300.00",
  grossMargin: "60.0",
  profitFact: "60.00",
  profitFactOrders: 1,
  orderMarginFact: "33.3",
  periodMarginFact: null,
  periodMarginFactCoveragePct: 46,
  profitForecast: "150.00",
  profitForecastOrders: 2,
  orderMarginForecast: "38.0",
  periodMarginForecast: null,
  periodMarginForecastCoveragePct: 77,
  averageOrderProfitFact: "100.00",
  averageOrderProfitForecast: "95.00",
  notCountedOrders: 1,
  notCountedRevenue: "150.00",
} as const;

/** G14b — 10 визнаних: 8 з фактичною виручкою на 8 000,00 і 2 з «Оцінкою» по 500,00. */
export const G14B_JOURNAL: RefJournal = (() => {
  const entries: RefEntry[] = [];
  const orders: RefOrderMeta[] = [];
  const forecasts: RefForecast[] = [];
  for (let i = 1; i <= 8; i++) {
    entries.push(je(`A${i}`, "sales_product", "1000.00"), je(`A${i}`, "cogs", "-400.00"));
    orders.push(meta(`A${i}`, "final", { revenue: settled, cogs: settled }));
  }
  for (let i = 1; i <= 2; i++) {
    orders.push(meta(`E${i}`, "incomplete", { revenue: { state: "missing" }, cogs: settled }, { missing: ["revenue"] }));
    forecasts.push(fc(`E${i}`, "revenue", "500.00", "order_snapshot"));
  }
  return { entries, orders, forecasts };
})();
export const G14B_EXPECTED = { averageCheckFact: "1000.00", factOrders: 8, orders: 10, averageCheckWithEstimates: "900.00", turnoverFact: "8000.00", estimate: "1000.00", estimateOrders: 2 } as const;

/**
 * G16 — рейтинг товарів і країн з розподілом (магазин UAH). X (DE, final): P1 600 / −200, P2 400 / −150, витрати
 * замовлення −154,01; Y (PL, incomplete): P1 300 / −100, P3 200 без собівартості. Реклама −40 — «Не розподілено».
 */
export const G16_JOURNAL: RefJournal = {
  entries: [
    je("X", "sales_product", "600.00", { lineId: "X1", productId: "P1" }),
    je("X", "cogs", "-200.00", { lineId: "X1", productId: "P1" }),
    je("X", "sales_product", "400.00", { lineId: "X2", productId: "P2" }),
    je("X", "cogs", "-150.00", { lineId: "X2", productId: "P2" }),
    je("X", "shipping_cost", "-100.00"),
    je("X", "packaging", "-24.01"),
    je("X", "payment_fees", "-30.00"),
    je("Y", "sales_product", "300.00", { lineId: "Y1", productId: "P1" }),
    je("Y", "cogs", "-100.00", { lineId: "Y1", productId: "P1" }),
    je("Y", "sales_product", "200.00", { lineId: "Y2", productId: "P3" }),
    je(null, "advertising", "-40.00"),
  ],
  orders: [
    meta("X", "final", { revenue: settled, cogs: settled, packaging: settled, shipping_cost: settled, fees: settled }, { country: "DE" }),
    meta("Y", "incomplete", { revenue: settled, cogs: { state: "partial" }, packaging: { state: "not_applicable" }, shipping_cost: { state: "not_applicable" }, fees: { state: "zero_confirmed" } }, { country: "PL", missing: ["cogs"] }),
  ],
  forecasts: [],
};
export const G16_LINES = [
  { orderId: "X", lineId: "X1", productId: "P1", model: "M1", color: "black", cogsSettled: true },
  { orderId: "X", lineId: "X2", productId: "P2", model: "M1", color: "white", cogsSettled: true },
  { orderId: "Y", lineId: "Y1", productId: "P1", model: "M1", color: "black", cogsSettled: true },
  { orderId: "Y", lineId: "Y2", productId: "P3", model: "M2", color: "black", cogsSettled: false },
] as const;
export const G16_EXPECTED = {
  /** Лише замовлення X. */
  orderX: {
    P1: { netRevenue: "600.00", cogs: "-200.00", gross: "400.00", margin: "66.7", allocatedCosts: "-92.41", grossAfterAllocation: "307.59" },
    P2: { netRevenue: "400.00", cogs: "-150.00", gross: "250.00", margin: "62.5", allocatedCosts: "-61.60", grossAfterAllocation: "188.40" },
  },
  /** X + Y: P1 разом; P3 — поза рейтингом («показати неповні»). */
  all: { P1: { netRevenue: "900.00", cogs: "-300.00", gross: "600.00", margin: "66.7" }, hiddenIncomplete: ["P3"] },
  countries: {
    DE: { orders: 1, profitFact: "495.99", profitForecast: "495.99", margin: "49.6" },
    PL: { orders: 1, profitFact: null, profitForecast: null },
    unallocated: "-40.00",
  },
} as const;

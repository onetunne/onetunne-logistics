/**
 * Етап 6, WP6: чисті правила витрат (§10.1–§10.3; G7, I7). Таблиця категорій і замовлень, знак запису, щоденний
 * розподіл (найбільші остачі, нічия — раніші дні, цілі одиниці для валют з 0 знаками), дати записів витрати із
 * замовленням (R1/R2/R5), захист від подвійного обліку (сума періоду — «замінює» або «окрема» з причиною), I7 —
 * розподіл сумує точно (власний генератор із зерном).
 */
import { describe, expect, it } from "vitest";
import { COVERS_FORECAST_CATEGORIES, EXPENSE_CATEGORIES, EXPENSE_CATEGORY_RULES } from "~/domain/finance";
import {
  allocateCurrencyMinor,
  BATCH_ONLY_CATEGORIES,
  coverageApplies,
  coverageNotApplicableReason,
  coverageWindow,
  dailyShares,
  datesTouched,
  defaultCoversForecast,
  entryAmountMinor,
  FORM_EXPENSE_CATEGORIES,
  FORM_INCOME_CATEGORIES,
  orderExpenseRecognizedOn,
  shapeError,
  type ExpenseShape,
} from "~/modules/expenses/rules";

const shape = (over: Partial<ExpenseShape>): ExpenseShape => ({
  category: "advertising",
  amountMinor: 10000n,
  currency: "UAH",
  expenseDate: "2026-11-10",
  periodFrom: null,
  periodTo: null,
  channel: null,
  gateway: null,
  carrierCode: null,
  partnerId: null,
  hasOrder: false,
  hasReturn: false,
  coversForecast: false,
  separateFromForecast: false,
  separateReason: null,
  ...over,
});

/** Детермінований генератор (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("category table §10.1", () => {
  it("required / optional / forbidden / batch-only follow the design table", () => {
    expect(EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_RULES[c] === "required").sort()).toEqual(["return_handling", "return_shipping_cost"]);
    expect(EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_RULES[c] === "optional").sort()).toEqual(
      ["chargeback_fees", "duties_paid", "other_expense", "packaging", "payment_fees", "platform_fees", "shipping_cost"].sort(),
    );
    expect(BATCH_ONLY_CATEGORIES).toEqual(["inventory_loss"]);
    expect([...FORM_EXPENSE_CATEGORIES, ...FORM_INCOME_CATEGORIES, ...BATCH_ONLY_CATEGORIES].sort()).toEqual([...EXPENSE_CATEGORIES].sort());
    expect(FORM_INCOME_CATEGORIES).toEqual(["other_income"]);
  });

  it("entry sign by profit impact: expense −, credit +, income +", () => {
    expect(entryAmountMinor("advertising", 10000n)).toBe(-10000n);
    expect(entryAmountMinor("advertising", -500n)).toBe(500n);
    expect(entryAmountMinor("other_income", 3000n)).toBe(3000n);
    expect(entryAmountMinor("fx_difference", 100n)).toBe(-100n);
  });

  it("shape errors: order rules, return cases, dimensions, partner, coverage", () => {
    expect(shapeError(shape({}))).toBeNull();
    expect(shapeError(shape({ amountMinor: 0n }))).toBe("financeExpenses.error.amountZero");
    expect(shapeError(shape({ expenseDate: null }))).toBe("financeExpenses.error.dateOrPeriod");
    expect(shapeError(shape({ expenseDate: null, periodFrom: "2026-11-30", periodTo: "2026-11-01" }))).toBe("financeExpenses.error.periodInvalid");
    expect(shapeError(shape({ expenseDate: null, periodFrom: "2026-01-01", periodTo: "2026-12-31" }))).toBeNull();
    expect(shapeError(shape({ expenseDate: null, periodFrom: "2026-01-01", periodTo: "2027-01-01" }))).toBeNull(); // 366 днів
    expect(shapeError(shape({ expenseDate: null, periodFrom: "2026-01-01", periodTo: "2027-01-02" }))).toBe("financeExpenses.error.periodInvalid");
    expect(shapeError(shape({ hasOrder: true }))).toBe("financeExpenses.error.orderForbidden");
    expect(shapeError(shape({ category: "return_handling" }))).toBe("financeExpenses.error.orderRequired");
    expect(shapeError(shape({ category: "return_handling", hasOrder: true, hasReturn: true }))).toBeNull();
    expect(shapeError(shape({ category: "other_expense", hasOrder: true, hasReturn: true }))).toBe("financeExpenses.error.returnNotAllowed");
    expect(shapeError(shape({ category: "shipping_cost", hasOrder: true, expenseDate: null, periodFrom: "2026-11-01", periodTo: "2026-11-02" }))).toBe("financeExpenses.error.orderWithPeriod");
    expect(shapeError(shape({ category: "inventory_loss" }))).toBe("financeExpenses.error.batchOnly");
    expect(shapeError(shape({ channel: "meta" }))).toBeNull();
    expect(shapeError(shape({ category: "rent", channel: "meta" }))).toBe("financeExpenses.error.channelInvalid");
    expect(shapeError(shape({ channel: "radio" }))).toBe("financeExpenses.error.channelInvalid");
    expect(shapeError(shape({ gateway: "paypal" }))).toBe("financeExpenses.error.gatewayNotAllowed");
    expect(shapeError(shape({ category: "duties_paid", carrierCode: "Nova Post" }))).toBe("financeExpenses.error.carrierInvalid");
    expect(shapeError(shape({ category: "partner_fixed_fee" }))).toBe("financeExpenses.error.partnerRequired");
    expect(shapeError(shape({ category: "rent", partnerId: "p" }))).toBe("financeExpenses.error.partnerNotAllowed");
  });

  /** Вимір суми періоду (§10.3): шлюз — комісії, перевізник — доставка, упаковка — без виміру. */
  const dimensionOf = (category: string) =>
    category === "shipping_cost" ? { carrierCode: "nova_post" } : category === "packaging" ? {} : { gateway: "paypal" };

  it("double-counting guard (§10.3, MUST): a positive fee/shipping/packaging sum with its dimension and without an order either covers forecasts or is separate with a reason", () => {
    for (const category of COVERS_FORECAST_CATEGORIES) {
      const dim = dimensionOf(category);
      const input = { category, hasOrder: false, amountMinor: 10000n, gateway: null, carrierCode: null, ...dim };
      expect(defaultCoversForecast(input)).toBe(true);
      expect(defaultCoversForecast({ ...input, hasOrder: true })).toBe(false);
      expect(shapeError(shape({ category, ...dim }))).toBe("financeExpenses.error.coverageRequired");
      expect(shapeError(shape({ category, ...dim, coversForecast: true }))).toBeNull();
      expect(shapeError(shape({ category, ...dim, separateFromForecast: true }))).toBe("financeExpenses.error.separateReasonRequired");
      expect(shapeError(shape({ category, ...dim, separateFromForecast: true, separateReason: "річна плата" }))).toBeNull();
      expect(shapeError(shape({ category, ...dim, coversForecast: true, separateFromForecast: true, separateReason: "x" }))).toBe("financeExpenses.error.coverageBoth");
      expect(shapeError(shape({ category, ...dim, hasOrder: true }))).toBeNull();
      expect(shapeError(shape({ category, ...dim, hasOrder: true, coversForecast: true }))).toBe("financeExpenses.error.coverageNotApplicable");
    }
    expect(shapeError(shape({ coversForecast: true }))).toBe("financeExpenses.error.coverageNotApplicable");
  });

  it("a fee sum without a gateway (Shopify plan bill), shipping without a carrier (courier pickup) and any credit are plain period expenses — never covering", () => {
    // Рахунок Shopify за тариф і застосунки (§8.1): platform_fees без шлюзу — витрата періоду, вибору немає.
    const plan = { category: "platform_fees" as const, hasOrder: false, amountMinor: 3900n, gateway: null, carrierCode: null };
    expect(coverageApplies(plan)).toBe(false);
    expect(coverageNotApplicableReason(plan)).toBe("no_dimension");
    expect(shapeError(shape({ category: "platform_fees" }))).toBeNull();
    expect(shapeError(shape({ category: "platform_fees", coversForecast: true }))).toBe("financeExpenses.error.coverageNeedsDimension");
    expect(shapeError(shape({ category: "payment_fees", separateFromForecast: true, separateReason: "x" }))).toBe("financeExpenses.error.coverageNeedsDimension");
    // «Доставка (інше)» без перевізника — те саме; зі шлюзом замість перевізника — теж без виміру.
    expect(coverageNotApplicableReason({ ...plan, category: "shipping_cost", gateway: "paypal" })).toBe("no_dimension");
    expect(shapeError(shape({ category: "shipping_cost", coversForecast: true }))).toBe("financeExpenses.error.coverageNeedsDimension");
    expect(shapeError(shape({ category: "shipping_cost" }))).toBeNull();
    // Кредит (від'ємна сума) — ніколи не замінює прогнози, навіть із виміром (§4, I16).
    for (const category of COVERS_FORECAST_CATEGORIES) {
      const credit = { category, hasOrder: false, amountMinor: -100n, gateway: "paypal", carrierCode: "nova_post" };
      expect(coverageApplies(credit)).toBe(false);
      expect(coverageNotApplicableReason(credit)).toBe("credit");
      expect(shapeError(shape({ category, ...dimensionOf(category), amountMinor: -100n }))).toBeNull();
      expect(shapeError(shape({ category, ...dimensionOf(category), amountMinor: -100n, coversForecast: true }))).toBe("financeExpenses.error.coverageCredit");
    }
    // Упаковка — без виміру: додатна сума завжди з вибором.
    expect(coverageApplies({ ...plan, category: "packaging" })).toBe(true);
  });
});

describe("daily allocation §10.2 (G7)", () => {
  it("1 000,00 UAH for 01–30.11 → 10 × 33,34 + 20 × 33,33, earlier days first", () => {
    const d = dailyShares(100000n, "UAH", "2026-11-01", "2026-11-30");
    expect(d).toHaveLength(30);
    expect(d.slice(0, 10).every((x) => x.minor === 3334n)).toBe(true);
    expect(d.slice(10).every((x) => x.minor === 3333n)).toBe(true);
    expect(d.reduce((a, x) => a + x.minor, 0n)).toBe(100000n);
    expect(d[0]!.day).toBe("2026-11-01");
    expect(d[29]!.day).toBe("2026-11-30");
  });

  it("negative sums (expense entries) and 0-decimal currencies; zero-share days are skipped", () => {
    const neg = dailyShares(-100000n, "UAH", "2026-11-01", "2026-11-30");
    expect(neg[0]!.minor).toBe(-3334n);
    expect(neg.reduce((a, x) => a + x.minor, 0n)).toBe(-100000n);
    expect(dailyShares(100000n, "JPY", "2026-11-01", "2026-11-03").map((x) => x.minor)).toEqual([33400n, 33300n, 33300n]);
    expect(dailyShares(2n, "UAH", "2026-11-01", "2026-11-05").map((x) => [x.day, x.minor])).toEqual([
      ["2026-11-01", 1n],
      ["2026-11-02", 1n],
    ]);
    expect(() => allocateCurrencyMinor(12350n, "JPY", [1n, 1n])).toThrow();
  });

  it("I7: allocation always sums exactly (seeded random cases, 2- and 0-decimal currencies)", () => {
    const r = rng(20261128);
    for (let i = 0; i < 2000; i++) {
      const currency = r() < 0.2 ? "JPY" : "EUR";
      const step = currency === "JPY" ? 100n : 1n;
      const total = BigInt(Math.floor((r() - 0.3) * 1e7)) * step;
      const n = 1 + Math.floor(r() * 12);
      const weights: bigint[] = Array.from({ length: n }, () => BigInt(Math.floor(r() * 1000)));
      if (!weights.some((w) => w > 0n)) weights[0] = 1n;
      const parts = allocateCurrencyMinor(total, currency, weights);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      expect(parts.every((p) => p % step === 0n)).toBe(true);
      weights.forEach((w, k) => {
        if (w === 0n) expect(parts[k]).toBe(0n);
      });
    }
  });
});

describe("dates", () => {
  it("coverage window: the service period, else the calendar month of the date", () => {
    expect(coverageWindow({ expenseDate: "2026-11-30", periodFrom: null, periodTo: null })).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(coverageWindow({ expenseDate: null, periodFrom: "2026-11-05", periodTo: "2026-12-04" })).toEqual({ from: "2026-11-05", to: "2026-12-04" });
  });

  it("dates touched by an expense: one per month of the period (closed-month check)", () => {
    expect(datesTouched({ expenseDate: "2026-11-10", periodFrom: null, periodTo: null })).toEqual(["2026-11-10"]);
    expect(datesTouched({ expenseDate: null, periodFrom: "2026-10-20", periodTo: "2026-12-02" })).toEqual(["2026-10-20", "2026-11-01", "2026-12-01"]);
  });

  it("order-linked expense dates: R1 recognition date, R2 returns and chargeback fees max(date, recognition), R5 own date, open → waits", () => {
    const rec = { state: "recognized" as const, recognizedOn: "2026-11-05" };
    expect(orderExpenseRecognizedOn("shipping_cost", "2026-11-20", rec)).toBe("2026-11-05");
    expect(orderExpenseRecognizedOn("return_handling", "2026-11-20", rec)).toBe("2026-11-20");
    expect(orderExpenseRecognizedOn("return_handling", "2026-11-01", rec)).toBe("2026-11-05");
    // G10 / §8.2: ручна комісія chargeback — датою комісії (R2: max(дата, визнання)), не датою визнання.
    expect(orderExpenseRecognizedOn("chargeback_fees", "2026-11-12", { state: "recognized", recognizedOn: "2026-10-05" })).toBe("2026-11-12");
    expect(orderExpenseRecognizedOn("chargeback_fees", "2026-10-01", { state: "recognized", recognizedOn: "2026-10-05" })).toBe("2026-10-05");
    expect(orderExpenseRecognizedOn("payment_fees", "2026-11-03", { state: "closed_unrecognized", recognizedOn: null })).toBe("2026-11-03");
    expect(orderExpenseRecognizedOn("payment_fees", "2026-11-03", { state: "excluded", recognizedOn: null })).toBe("2026-11-03");
    expect(orderExpenseRecognizedOn("payment_fees", "2026-11-03", { state: "open", recognizedOn: null })).toBeNull();
    expect(orderExpenseRecognizedOn("payment_fees", "2026-11-03", { state: "none", recognizedOn: null })).toBeNull();
  });
});

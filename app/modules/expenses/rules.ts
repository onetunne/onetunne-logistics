/**
 * Етап 6, WP6: чисті правила ручних витрат і доходів (docs/stage6-design.md §10.1–§10.3, §2.5, §3.3 R1–R5).
 * Без БД і React — їх використовують сервіси (expenses.server.ts), внутрішнє проведення (posting.server.ts), сторінка й
 * тести.
 *
 * Домовленості:
 * - сума власника `finance_expenses.amount` ≠ 0: для витрат «+» — витрата, «−» — кредит (повернення витрати); для
 *   доходу (`other_income`) «+» — дохід. Знак ЗАПИСУ журналу — за впливом на прибуток (§0 п. 2): витрата → −сума,
 *   дохід → +сума (`entryAmountMinor`). Курсова різниця, внесена вручну (`fx_difference`), — як витрата: «+» — збиток,
 *   «−» — прибуток від курсу.
 * - суми — соті частки (`toMinorForCurrency`), і для валют з 0 знаками: розподіл іде цілими одиницями валюти
 *   (`unitStep`), тож частка 1 000 JPY ніколи не стає 333,34 JPY.
 * - період послуги → щоденний розподіл `allocateMinor(сума, [1, 1, …, 1])` (найбільші остачі, нічия — раніші дні), §10.2.
 */
import {
  COVERS_FORECAST_CATEGORIES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_RULES,
  EXPENSE_CHANNELS,
  EXPENSE_MAX_PERIOD_DAYS,
  type ExpenseCategory,
  type ExpenseOrderRule,
  type OrderComponent,
} from "~/domain/finance";
import { allocateMinor, assertSupportedCurrency } from "~/lib/decimal";
import { addDays, daysBetween, eachDay, monthEnd, monthStart, type DateRange } from "~/lib/periods";

export type ExpenseChannel = (typeof EXPENSE_CHANNELS)[number];

/** Категорії, що вводяться лише окремою дією (не формою витрат): «Списати невикористані витрати партії» (§6.7, WP2). */
export const BATCH_ONLY_CATEGORIES: readonly ExpenseCategory[] = EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_RULES[c] === "batch_only");

/** Категорії доходу (запис «+»). */
export const INCOME_CATEGORIES: readonly ExpenseCategory[] = ["other_income"];

/** Категорії форми «Додати витрату» (у порядку списку). */
export const FORM_EXPENSE_CATEGORIES: readonly ExpenseCategory[] = EXPENSE_CATEGORIES.filter(
  (c) => !BATCH_ONLY_CATEGORIES.includes(c) && !INCOME_CATEGORIES.includes(c),
);
/** Категорії форми «Додати дохід». */
export const FORM_INCOME_CATEGORIES: readonly ExpenseCategory[] = INCOME_CATEGORIES;

/** Повернення: зворотна доставка й обробка — з обов'язковим замовленням (§10.1, §11). */
export const RETURN_EXPENSE_CATEGORIES: readonly ExpenseCategory[] = ["return_shipping_cost", "return_handling"];

/**
 * Пізніші події замовлення (R2, §3.3): витрати на повернення й ручна комісія chargeback (§8.2 «`chargeback_fees` —
 * датою комісії», G10) — `recognized_on = max(дата витрати, дата визнання)`, без «пізнього завершення» (chargeback — не
 * обов'язковий складник, §2.6).
 */
export const POST_RECOGNITION_EVENT_CATEGORIES: readonly ExpenseCategory[] = [...RETURN_EXPENSE_CATEGORIES, "chargeback_fees"];

/** Категорії, у яких можна вказати шлюз / перевізника / канал / партнера. */
export const GATEWAY_CATEGORIES: readonly ExpenseCategory[] = ["payment_fees", "platform_fees", "chargeback_fees"];
export const CARRIER_CATEGORIES: readonly ExpenseCategory[] = ["shipping_cost", "return_shipping_cost", "duties_paid"];
export const CHANNEL_CATEGORIES: readonly ExpenseCategory[] = ["advertising"];
export const PARTNER_CATEGORIES: readonly ExpenseCategory[] = ["partner_fixed_fee", "advertising"];

export const EXPENSE_DESCRIPTION_MAX = 200;
export const EXPENSE_DOCUMENT_MAX = 100;
export const EXPENSE_REASON_MAX = 300;
export const EXPENSE_GATEWAY_MAX = 120;
export const CARRIER_CODE_RE = /^[a-z0-9][a-z0-9_.-]{0,39}$/;

export function isExpenseCategory(value: string): value is ExpenseCategory {
  return (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

export function orderRuleOf(category: ExpenseCategory): ExpenseOrderRule {
  return EXPENSE_CATEGORY_RULES[category];
}

export function isIncomeCategory(category: ExpenseCategory): boolean {
  return INCOME_CATEGORIES.includes(category);
}

/** Сума запису журналу (вплив на прибуток) із суми власника: витрата → −сума, дохід → +сума. */
export function entryAmountMinor(category: ExpenseCategory, ownerAmountMinor: bigint): bigint {
  return isIncomeCategory(category) ? ownerAmountMinor : -ownerAmountMinor;
}

// ---------------------------------------------------------------------------
// Сума періоду, що замінює прогнози (§10.3)
// ---------------------------------------------------------------------------

export type CoveringCategory = "payment_fees" | "platform_fees" | "shipping_cost" | "packaging";

export function isCoveringCategory(category: ExpenseCategory): category is CoveringCategory {
  return COVERS_FORECAST_CATEGORIES.includes(category);
}

/** Вимір суми періоду: шлюз (комісії), перевізник (доставка), без виміру (упаковка). */
export type CoveringDimension = "gateway" | "carrier" | "none";

export const COVERING_DIMENSION: Readonly<Record<CoveringCategory, CoveringDimension>> = {
  payment_fees: "gateway",
  platform_fees: "gateway",
  shipping_cost: "carrier",
  packaging: "none",
};

/** Складник замовлення (order_finance_forecasts.component), прогноз якого замінює сума періоду. */
export const COVERING_COMPONENT: Readonly<Record<CoveringCategory, OrderComponent>> = {
  payment_fees: "fees",
  platform_fees: "fees",
  shipping_cost: "shipping_cost",
  packaging: "packaging",
};

/**
 * Вікно замовлень, які покриває сума періоду (оформлені — `placed_at`, Київ): період послуги, якщо задано, інакше
 * календарний місяць дати витрати.
 */
export function coverageWindow(input: { expenseDate: string | null; periodFrom: string | null; periodTo: string | null }): DateRange {
  if (input.periodFrom && input.periodTo) return { from: input.periodFrom, to: input.periodTo };
  if (!input.expenseDate) throw new RangeError("expense has neither a date nor a period");
  return { from: monthStart(input.expenseDate), to: monthEnd(input.expenseDate) };
}

export interface CoverageInput {
  category: ExpenseCategory;
  hasOrder: boolean;
  amountMinor: bigint;
  gateway: string | null;
  carrierCode: string | null;
}

/**
 * Чому вибір «замінює прогноз / окрема» не застосовний до суми категорії комісій / доставки / упаковки без замовлення:
 * - `no_dimension` — не вказано виміру (шлюз для комісій, перевізник для доставки, §10.3 «вимір … збігається»): напр.
 *   рахунок Shopify за тариф і застосунки (`platform_fees`, §8.1) або «Доставка (інше)» без перевізника — звичайна
 *   витрата періоду, прогнозів замовлень не замінює;
 * - `credit` — від'ємна сума (кредит, повернення комісії): не підсумок складника за місяць і не може заміняти прогнози
 *   (§4 «факт замінює прогноз», I16) — запис періоду «+».
 * null — вибір застосовний (або категорія / замовлення його взагалі не передбачають).
 */
export function coverageNotApplicableReason(s: CoverageInput): "no_dimension" | "credit" | null {
  if (!isCoveringCategory(s.category) || s.hasOrder) return null;
  if (s.amountMinor < 0n) return "credit";
  const dimension = COVERING_DIMENSION[s.category];
  if (dimension === "gateway" && !s.gateway) return "no_dimension";
  if (dimension === "carrier" && !s.carrierCode) return "no_dimension";
  return null;
}

/**
 * Чи застосовний вибір «замінює прогноз» / «окрема» (§10.3): категорія комісій / доставки / упаковки, без замовлення,
 * додатна сума і вказаний вимір (шлюз / перевізник; упаковка — без виміру).
 */
export function coverageApplies(s: CoverageInput): boolean {
  return isCoveringCategory(s.category) && !s.hasOrder && coverageNotApplicableReason(s) === null;
}

/** Чи має витрата ставати сумою періоду, що замінює прогнози (типово — так, коли вибір застосовний, §10.3). */
export function defaultCoversForecast(s: CoverageInput): boolean {
  return coverageApplies(s);
}

// ---------------------------------------------------------------------------
// Розподіл сум (найбільші остачі; цілі одиниці валюти)
// ---------------------------------------------------------------------------

/** Крок мінорних (сотих) одиниць: 1 для валют з 2 знаками, 100 для валют з 0 знаками. */
export function unitStep(currency: string): bigint {
  return assertSupportedCurrency(currency) === 0 ? 100n : 1n;
}

/**
 * Розподіл суми (соті частки) за вагами методом найбільших остач (allocateMinor) у цілих одиницях валюти: Σ частин =
 * total точно. Ваги ≥ 0, сума ваг > 0.
 */
export function allocateCurrencyMinor(total: bigint, currency: string, weights: readonly bigint[]): bigint[] {
  const step = unitStep(currency);
  if (total % step !== 0n) throw new RangeError(`amount has fractional units for ${currency}`);
  return allocateMinor(total / step, weights).map((p) => p * step);
}

export interface DayShare {
  day: string;
  minor: bigint;
}

/** Найдовший період послуги — у днях включно (CHECK period_to − period_from < 366). */
export function isAllowedServicePeriod(from: string, to: string): boolean {
  return from <= to && daysBetween(from, to) + 1 <= EXPENSE_MAX_PERIOD_DAYS;
}

/**
 * Щоденний розподіл суми за період послуги (§10.2): рівні ваги, остачі — раніші дні. Приклад G7: 1 000,00 UAH за
 * 01–30.11 → 10 × 33,34 + 20 × 33,33. Дні з нульовою часткою (сума менша за кількість днів) пропускаються — записів
 * із нульовою сумою немає (CHECK amount <> 0).
 */
export function dailyShares(totalMinor: bigint, currency: string, from: string, to: string): DayShare[] {
  if (!isAllowedServicePeriod(from, to)) throw new RangeError("invalid service period");
  const days = eachDay({ from, to });
  const parts = allocateCurrencyMinor(totalMinor, currency, days.map(() => 1n));
  return days.map((day, i) => ({ day, minor: parts[i]! })).filter((d) => d.minor !== 0n);
}

/** Дати, які зачіпає витрата (для перевірки закритих місяців): дата або перший і останній день кожного місяця періоду. */
export function datesTouched(input: { expenseDate: string | null; periodFrom: string | null; periodTo: string | null }): string[] {
  if (input.periodFrom && input.periodTo) {
    const out: string[] = [];
    for (let m = monthStart(input.periodFrom); m <= input.periodTo; m = monthStart(addDays(monthEnd(m), 1))) {
      out.push(m < input.periodFrom ? input.periodFrom : m);
    }
    return out;
  }
  return input.expenseDate ? [input.expenseDate] : [];
}

// ---------------------------------------------------------------------------
// Дати записів витрати із замовленням (§3.3)
// ---------------------------------------------------------------------------

/** Стан фінансів замовлення для дат записів ручної витрати з order_id. */
export interface OrderRecognitionState {
  state: "open" | "recognized" | "closed_unrecognized" | "excluded" | "none";
  recognizedOn: string | null;
}

/**
 * Дата періоду запису витрати із замовленням або null (факт чекає визнання, R1):
 * - визнане: складники замовлення (доставка, мито, упаковка, комісії, інші) — дата визнання (R1/R3); пізніші події —
 *   витрати на повернення й комісія chargeback — max(дата витрати, дата визнання) (R2, G10);
 * - скасоване до відвантаження або не враховане: дата витрати (R5, витрата періоду з order_id);
 * - ще не відвантажене (або фінансів замовлення ще немає) — null: запис проведе syncOrderExpenseEntries під час визнання.
 * Дата курсу завжди — дата самої витрати (власна дата значення, R3).
 */
export function orderExpenseRecognizedOn(category: ExpenseCategory, expenseDate: string, order: OrderRecognitionState): string | null {
  if (order.state === "recognized" && order.recognizedOn) {
    if (POST_RECOGNITION_EVENT_CATEGORIES.includes(category)) return expenseDate > order.recognizedOn ? expenseDate : order.recognizedOn;
    return order.recognizedOn;
  }
  if (order.state === "closed_unrecognized" || order.state === "excluded") return expenseDate;
  return null;
}

// ---------------------------------------------------------------------------
// Перевірка форми (чиста частина; існування замовлення, повернення, партнера — у сервісі)
// ---------------------------------------------------------------------------

export interface ExpenseShape {
  category: ExpenseCategory;
  amountMinor: bigint;
  currency: string;
  expenseDate: string | null;
  periodFrom: string | null;
  periodTo: string | null;
  channel: string | null;
  gateway: string | null;
  carrierCode: string | null;
  partnerId: string | null;
  hasOrder: boolean;
  hasReturn: boolean;
  coversForecast: boolean;
  separateFromForecast: boolean;
  separateReason: string | null;
}

/** Код помилки (ключ i18n financeExpenses.error.*) або null. */
export function shapeError(s: ExpenseShape): string | null {
  if (s.amountMinor === 0n) return "financeExpenses.error.amountZero";
  const hasDate = s.expenseDate !== null;
  const hasPeriod = s.periodFrom !== null || s.periodTo !== null;
  if (hasDate === hasPeriod) return "financeExpenses.error.dateOrPeriod";
  if (hasPeriod && (!s.periodFrom || !s.periodTo || !isAllowedServicePeriod(s.periodFrom, s.periodTo))) return "financeExpenses.error.periodInvalid";
  const rule = orderRuleOf(s.category);
  if (rule === "batch_only") return "financeExpenses.error.batchOnly";
  if (rule === "required" && !s.hasOrder) return "financeExpenses.error.orderRequired";
  if (rule === "forbidden" && (s.hasOrder || s.hasReturn)) return "financeExpenses.error.orderForbidden";
  if (s.hasReturn && !s.hasOrder) return "financeExpenses.error.returnNeedsOrder";
  if (s.hasReturn && !RETURN_EXPENSE_CATEGORIES.includes(s.category)) return "financeExpenses.error.returnNotAllowed";
  if (s.hasOrder && hasPeriod) return "financeExpenses.error.orderWithPeriod";
  if (s.channel !== null && (!CHANNEL_CATEGORIES.includes(s.category) || !(EXPENSE_CHANNELS as readonly string[]).includes(s.channel))) {
    return "financeExpenses.error.channelInvalid";
  }
  if (s.gateway !== null && !GATEWAY_CATEGORIES.includes(s.category)) return "financeExpenses.error.gatewayNotAllowed";
  if (s.carrierCode !== null && (!CARRIER_CATEGORIES.includes(s.category) || !CARRIER_CODE_RE.test(s.carrierCode))) {
    return "financeExpenses.error.carrierInvalid";
  }
  if (s.category === "partner_fixed_fee" && !s.partnerId) return "financeExpenses.error.partnerRequired";
  if (s.partnerId !== null && !PARTNER_CATEGORIES.includes(s.category)) return "financeExpenses.error.partnerNotAllowed";
  if (s.coversForecast && s.separateFromForecast) return "financeExpenses.error.coverageBoth";
  const covering = coverageApplies(s);
  if (!covering && (s.coversForecast || s.separateFromForecast)) {
    const why = coverageNotApplicableReason(s);
    if (why === "credit") return "financeExpenses.error.coverageCredit";
    if (why === "no_dimension") return "financeExpenses.error.coverageNeedsDimension";
    return "financeExpenses.error.coverageNotApplicable";
  }
  // Захист від подвійного обліку (§10.3, МАЄ): сума періоду комісій / доставки / упаковки без замовлення, з виміром
  // (шлюз / перевізник; упаковка — без виміру) і додатна, — або «замінює прогноз», або явно «окрема» з причиною.
  if (covering && !s.coversForecast && !s.separateFromForecast) return "financeExpenses.error.coverageRequired";
  if (s.separateFromForecast && !s.separateReason) return "financeExpenses.error.separateReasonRequired";
  return null;
}

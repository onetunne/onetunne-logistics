/**
 * Ціна тарифу для Shopify Checkout (чиста функція, без float).
 *
 * Конвеєр: ціна перевізника (десятковий рядок у валюті перевізника)
 *   → перерахунок у валюту кошика за курсами власника (settings.checkoutRates.fxRates)
 *   → націнка у відсотках
 *   → + фіксована надбавка: задана у БАЗОВІЙ валюті таблиці курсів (валюта тарифу перевізника, UAH)
 *     і перераховується у валюту кошика за тим самим курсом. Одне число для всіх валют кошика
 *     («+20 грн») — інакше "5.00" означало б 5 EUR, 5 UAH або 5 JPY залежно від покупця
 *   → одне округлення ВГОРУ до копійок/центів від точної суми (без накопичення)
 *   → режим округлення (none | up_whole | up_99).
 *
 * Усі ділення округлюються ВГОРУ — магазин ніколи не бере з клієнта менше, ніж розрахував перевізник.
 *
 * Одиниці результату: `cents` = сума × 100 (ціле). Це збігається з полем Shopify `total_price`:
 * «The total price expressed in subunits. If the currency doesn't use subunits, then the value must be
 * multiplied by 100» (shopify.dev, DeliveryCarrierService → Response fields). Тобто для EUR 12.99 → 1299,
 * для JPY 1000 → 100000. Валюти з 3–4 знаками (KWD, BHD, …) не підтримуються: як Shopify очікує їх
 * subunits — НЕ ЗАДОКУМЕНТОВАНО, а помилка у 10 разів означала б заниження ціни.
 */
import type { Money } from "~/integrations/carriers/types";
import { currencyMinorDigits } from "~/lib/decimal";
import { fromMinor } from "~/lib/money";
import type { SettingsValue } from "~/modules/settings/schema";

export type RoundingMode = SettingsValue<"checkoutRates">["rounding"];
export type PricingSettings = Pick<SettingsValue<"checkoutRates">, "markupPercent" | "markupFixed" | "rounding" | "fxRates">;

/** Раціональне число num/den (den > 0). */
interface Rational {
  num: bigint;
  den: bigint;
}

const ONE: Rational = { num: 1n, den: 1n };
const CENTS = 100n;
const BASIS_POINTS = 10_000n;

/**
 * Кількість знаків після коми за ISO 4217 — перенесено в app/lib/decimal.ts (етап 6); тут реекспорт без зміни поведінки.
 */
export { currencyMinorDigits } from "~/lib/decimal";

const CURRENCY_RE = /^[A-Z]{3}$/;

export function normalizeCurrency(currency: string): string | null {
  const c = currency.trim().toUpperCase();
  return CURRENCY_RE.test(c) ? c : null;
}

/** Ціле ділення з округленням угору (a ≥ 0, b > 0). */
export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new RangeError("divisor must be positive");
  if (a < 0n) throw new RangeError("dividend must be non-negative");
  return (a + b - 1n) / b;
}

const DECIMAL_RE = /^(\d{1,18})(?:\.(\d{1,18}))?$/;

/** Невід'ємний десятковий рядок → точне раціональне число; інакше null (жодних "1e3", знаків, пробілів усередині). */
export function parseDecimal(value: string): Rational | null {
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) return null;
  const int = m[1]!;
  const frac = m[2] ?? "";
  return { num: BigInt(int + frac), den: 10n ** BigInt(frac.length) };
}

/**
 * Відсоток націнки (number, може мати дробову частину) → базисні пункти (1 % = 100 б.п.).
 * Число переводиться в десятковий запис із 10 знаками (`toFixed(10)`): так відкидається «шум» float
 * (12.34 → 1234, а не 1233.9999…). Частки базисного пункту округлюються ВГОРУ (12.345 % → 1235 б.п.).
 */
export function markupPercentToBasisPoints(percent: number): bigint {
  if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 0 || percent > 100_000) {
    throw new RangeError(`markupPercent must be a finite number in [0, 100000], got ${String(percent)}`);
  }
  const [int, frac = ""] = percent.toFixed(10).split(".");
  const scaled = BigInt(int! + frac.padEnd(10, "0")); // percent × 10^10
  return ceilDiv(scaled, 10n ** 8n); // percent × 100
}

/** Фіксована надбавка "12.50" → центи (≤ 2 знаки після коми, невід'ємна). */
export function markupFixedToCents(value: string): bigint {
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new RangeError(`markupFixed must be a non-negative decimal with up to 2 decimals, got ${value}`);
  return BigInt(m[1]!) * CENTS + BigInt((m[2] ?? "").padEnd(2, "0"));
}

/**
 * Курс як «скільки одиниць базової валюти (валюти таблиці курсів, напр. UAH) коштує 1 одиниця `currency`».
 * Для самої базової валюти — 1. Немає курсу або курс 0 → null.
 */
function rateToBase(currency: string, base: string | null, fxRates: PricingSettings["fxRates"]): Rational | null {
  if (base !== null && currency === base) return ONE;
  const entry = fxRates.find((r) => r.currency.trim().toUpperCase() === currency);
  if (!entry) return null;
  const rate = parseDecimal(entry.rate);
  if (!rate || rate.num === 0n) return null;
  return rate;
}

/**
 * Коефіцієнт перерахунку `from` → `to` (скільки одиниць `to` за 1 одиницю `from`).
 * Однакові валюти — без перерахунку. Таблиця курсів задана відносно базової валюти:
 * from→to = курс(from) / курс(to), де курс(base) = 1; підтримується і крос-курс через базову валюту.
 */
export function conversionFactor(
  from: string,
  to: string,
  fxRates: PricingSettings["fxRates"],
  fxBaseCurrency: string | null,
): Rational | null {
  if (from === to) return ONE;
  const base = fxBaseCurrency ? normalizeCurrency(fxBaseCurrency) : null;
  const fromRate = rateToBase(from, base, fxRates);
  const toRate = rateToBase(to, base, fxRates);
  if (!fromRate || !toRate) return null;
  // (fromRate.num / fromRate.den) / (toRate.num / toRate.den)
  return { num: fromRate.num * toRate.den, den: fromRate.den * toRate.num };
}

/**
 * Чи можна взагалі показати тариф у валюті кошика: валюта з 0 або 2 знаками і є курс від базової валюти
 * таблиці (валюти тарифу перевізника). Перевіряється ДО запиту до перевізника, щоб не викликати його даремно.
 */
export function canPriceInCurrency(
  targetCurrency: string,
  fxRates: PricingSettings["fxRates"],
  fxBaseCurrency: string,
): Exclude<PricingFailure, "invalid_price"> | null {
  const target = normalizeCurrency(targetCurrency);
  const base = normalizeCurrency(fxBaseCurrency);
  if (!target || !base) return "unsupported_currency";
  const digits = currencyMinorDigits(target);
  if (digits !== 0 && digits !== 2) return "unsupported_currency";
  return conversionFactor(base, target, fxRates, base) ? null : "no_fx_rate";
}

/** Режим округлення для суми в центах (сума × 100). 0 лишається 0 (безкоштовний тариф не стає 0.99). */
export function applyRounding(cents: bigint, mode: RoundingMode, minorDigits: number): bigint {
  if (cents < 0n) throw new RangeError("amount must be non-negative");
  if (cents === 0n) return 0n;
  const whole = ceilDiv(cents, CENTS) * CENTS;
  // Валюта без дробових одиниць (JPY…): сума завжди ціла. «X.99» для неї не має сенсу → як up_whole.
  if (minorDigits === 0) return whole;
  switch (mode) {
    case "none":
      return cents;
    case "up_whole":
      return whole;
    case "up_99":
      // Найменше X.99 ≥ суми: 10.00 → 10.99, 10.99 → 10.99, 11.00 → 11.99.
      return (cents / CENTS) * CENTS + 99n;
  }
}

export type PricingFailure = "no_fx_rate" | "invalid_price" | "unsupported_currency";

export interface CheckoutPrice {
  currency: string;
  /** Сума × 100 (ціле). Саме це значення йде в Shopify `total_price`. */
  cents: bigint;
  /** Десятковий рядок для відображення/журналу, напр. "12.99". */
  amount: string;
  /** Ціна перевізника у валюті кошика ДО націнки й округлення (округлено вгору до центів) — для перевірки власником. */
  convertedAmount: string;
}

export type PricingResult = { ok: true; price: CheckoutPrice } | { ok: false; reason: PricingFailure };

export interface PricingOptions {
  /**
   * Валюта, відносно якої задано таблицю курсів (за описом налаштування — валюта перевізника, UAH).
   * У ній же задано фіксовану надбавку `markupFixed`.
   * null — таблиця (і надбавка) вважаються заданими відносно валюти ціни перевізника.
   */
  fxBaseCurrency: string | null;
}

/**
 * Ціна тарифу в Checkout. Кидає RangeError лише на некоректні налаштування (NaN, від'ємна націнка) —
 * zod-схема налаштувань цього не допускає. Неможливість розрахувати (немає курсу тощо) — `ok: false`.
 */
export function priceCheckoutRate(
  carrierPrice: Money,
  targetCurrency: string,
  settings: PricingSettings,
  options: PricingOptions = { fxBaseCurrency: null },
): PricingResult {
  const bp = markupPercentToBasisPoints(settings.markupPercent);
  const fixedCents = markupFixedToCents(settings.markupFixed);

  const target = normalizeCurrency(targetCurrency);
  const from = normalizeCurrency(carrierPrice.currency);
  if (!target || !from) return { ok: false, reason: "unsupported_currency" };
  const digits = currencyMinorDigits(target);
  if (digits !== 0 && digits !== 2) return { ok: false, reason: "unsupported_currency" };

  const price = parseDecimal(carrierPrice.amount);
  if (!price) return { ok: false, reason: "invalid_price" };

  const base = options.fxBaseCurrency ? normalizeCurrency(options.fxBaseCurrency) : from;
  if (!base) return { ok: false, reason: "unsupported_currency" };
  const factor = conversionFactor(from, target, settings.fxRates, base);
  if (!factor) return { ok: false, reason: "no_fx_rate" };
  // Фіксована надбавка — у базовій валюті таблиці курсів (див. опис модуля).
  const fixedFactor = fixedCents === 0n ? ONE : conversionFactor(base, target, settings.fxRates, base);
  if (!fixedFactor) return { ok: false, reason: "no_fx_rate" };

  // Центи у валюті кошика = price × factor × 100, округлено вгору.
  const convNum = price.num * factor.num * CENTS;
  const convDen = price.den * factor.den;
  const convertedCents = ceilDiv(convNum, convDen);
  // price × factor × (10000 + bp) / 10000 × 100 + fixed × fixedFactor — точна сума, одне округлення вгору.
  const markedNum = convNum * (BASIS_POINTS + bp);
  const markedDen = convDen * BASIS_POINTS;
  const totalCents = ceilDiv(markedNum * fixedFactor.den + fixedCents * fixedFactor.num * markedDen, markedDen * fixedFactor.den);
  const cents = applyRounding(totalCents, settings.rounding, digits);

  return {
    ok: true,
    price: { currency: target, cents, amount: fromMinor(cents), convertedAmount: fromMinor(convertedCents) },
  };
}

/**
 * Найменша оголошена вартість для розрахунку тарифу у валюті `currency`: 1 одиниця базової валюти таблиці курсів
 * (валюти тарифу перевізника), перерахована у `currency` і округлена ВГОРУ до цілої одиниці (EUR → "1.00",
 * JPY за курсу 0.27 → "4.00"). Nova Post вимагає insuranceCost > 0, тож нульова вартість (безкоштовні товари)
 * давала б відмову перевізника і резервні тарифи Shopify. Немає курсу → null.
 */
export function minimumDeclaredAmount(currency: string, fxRates: PricingSettings["fxRates"], fxBaseCurrency: string): string | null {
  const target = normalizeCurrency(currency);
  const base = normalizeCurrency(fxBaseCurrency);
  if (!target || !base) return null;
  const factor = conversionFactor(base, target, fxRates, base);
  if (!factor) return null;
  return fromMinor(ceilDiv(ceilDiv(CENTS * factor.num, factor.den), CENTS) * CENTS);
}

/**
 * Ціле значення в найменших одиницях валюти (як `items[].price` у запиті Shopify) → десятковий рядок.
 * Одиниця `items[].price` у документації прямо не названа (приклад 1999 узгоджується з центами); для
 * `order_totals` — «integer in the smallest unit of the shop's currency (for example, cents)».
 * Для валют без дробових одиниць найменша одиниця = ціла (JPY 1000 → "1000.00"); 3 знаки → округлення вгору до 2.
 */
export function subunitsToDecimal(subunits: bigint, currency: string): string {
  if (subunits < 0n) throw new RangeError("subunits must be non-negative");
  const digits = currencyMinorDigits(currency);
  if (digits === 2) return fromMinor(subunits);
  if (digits < 2) return fromMinor(subunits * 10n ** BigInt(2 - digits));
  return fromMinor(ceilDiv(subunits, 10n ** BigInt(digits - 2)));
}

/**
 * Еталонна модель (WP12a): валюти, вибір курсу й конвертація (§5.1, §5.4, §5.5, §5.7) — власна реалізація.
 *
 * Конвертація: A_Y = a × p_X(d) / p_Y(d), p — гривень за 1 одиницю (точний дріб rate / units), a — соті частки;
 * ОДНЕ округлення (половина від нуля) одразу до мінорних одиниць Y (для валют з 0 знаками — до цілих), результат знову
 * в сотих. Кросс-курс НІКОЛИ не округлюється заздалегідь.
 */
import { cents, divRound, parseDecimal, rational, str, type Cents, type Rational } from "./money";
import { addDays } from "./dates";

const ZERO_DIGITS = new Set(["BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF"]);
const UNSUPPORTED = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND", "CLF", "UYW"]);

/** Кількість десяткових знаків валюти (ISO 4217): 0 або 2; 3–4 знаки — не підтримуються в етапі 6 (§5.1). */
export function digitsOf(currency: string): 0 | 2 {
  if (!/^[A-Z]{3}$/.test(currency)) throw new RangeError(`reference: bad currency ${currency}`);
  if (UNSUPPORTED.has(currency)) throw new RangeError(`reference: unsupported currency ${currency}`);
  return ZERO_DIGITS.has(currency) ? 0 : 2;
}

/** Сума з ненульовими сотими у валюті з 0 знаками — помилка розбору, не округлення (§5.1). */
export function isValidAmountFor(amount: Cents, currency: string): boolean {
  return digitsOf(currency) === 2 || amount % 100n === 0n;
}

export type RateSource = "nbu" | "manual" | "demo";

/** Рядок таблиці курсів (`fx_rates`): `rate` за `units` одиниць, як опубліковано. */
export interface RefRate {
  currency: string;
  date: string;
  rate: string;
  units?: number;
  source: RateSource;
  /** Ручні: версія й чинність (попередні версії — isCurrent=false). */
  version?: number;
  isCurrent?: boolean;
}

export interface RateHit {
  currency: string;
  /** Гривень за 1 одиницю, точно. */
  perUnit: Rational;
  rateDate: string;
  source: RateSource | "base";
  fallback: boolean;
}

export interface RateOptions {
  /** Автоматичне джерело: робочий режим — nbu, демо — demo. */
  mode?: "production" | "demo";
  fallbackDays?: number;
}

function perUnitOf(r: RefRate): Rational {
  const p = parseDecimal(r.rate);
  return rational(p.num, p.den * BigInt(r.units ?? 1));
}

/**
 * Курс валюти на дату (§5.4): UAH = 1; поточний ручний на дату; автоматичний на дату; запасний — найсвіжіший ручний
 * або автоматичний у [date − fallbackDays, date) (у межах дня — ручний першим); інакше null («Без курсу»).
 * Курси на майбутні дати не припускаються (лише ≤ date).
 */
export function rateFor(rates: readonly RefRate[], currency: string, date: string, opts: RateOptions = {}): RateHit | null {
  if (currency === "UAH") return { currency, perUnit: { num: 1n, den: 1n }, rateDate: date, source: "base", fallback: false };
  const auto: RateSource = opts.mode === "demo" ? "demo" : "nbu";
  const fallbackDays = opts.fallbackDays ?? 7;
  const usable = rates.filter((r) => r.currency === currency && (r.source === auto || (r.source === "manual" && r.isCurrent !== false)));
  const pick = (d: string): RefRate | undefined =>
    usable.find((r) => r.date === d && r.source === "manual") ?? usable.find((r) => r.date === d && r.source === auto);
  const exact = pick(date);
  if (exact) return { currency, perUnit: perUnitOf(exact), rateDate: date, source: exact.source, fallback: false };
  for (let back = 1; back <= fallbackDays; back++) {
    const d = addDays(date, -back);
    const hit = pick(d);
    if (hit) return { currency, perUnit: perUnitOf(hit), rateDate: d, source: hit.source, fallback: true };
  }
  return null;
}

/** Точна конвертація сотих `a` з X у Y за курсами p_X, p_Y (гривень за 1 одиницю). */
export function convertWith(a: Cents, px: Rational, py: Rational, to: string): Cents {
  const dY = digitsOf(to);
  const unit = dY === 2 ? 1n : 100n; // соті в одній мінорній одиниці Y
  // a × px / py у сотих Y → у мінорних одиницях: / unit
  const minor = divRound(a * px.num * py.den, px.den * py.num * unit);
  return minor * unit;
}

export interface ConvertContext {
  rates: readonly RefRate[];
  opts?: RateOptions;
}

/** Конвертація суми запису з валюти `from` у `to` за курсами дати `date` (fx_on); немає курсу → null. */
export function convert(a: Cents, from: string, to: string, date: string, ctx: ConvertContext): Cents | null {
  digitsOf(from);
  if (from === to) return a;
  const px = rateFor(ctx.rates, from, date, ctx.opts);
  const py = rateFor(ctx.rates, to, date, ctx.opts);
  if (!px || !py) return null;
  return convertWith(a, px.perUnit, py.perUnit, to);
}

export interface Convertible {
  amount: string;
  currency: string;
  fxOn: string;
}

export interface ConvertedSum {
  /** null — є записи, але жоден не сконвертовано; «0.00» — лише відомий нуль (або порожньо). */
  total: string | null;
  totalCents: Cents | null;
  converted: number;
  unconverted: Array<{ currency: string; amount: string; entries: number }>;
}

/** Σ сконвертованих записів (кожен — окремо за курсом свого fx_on); без курсу — окремим переліком (§2.6). */
export function sumConverted(items: readonly Convertible[], target: string, ctx: ConvertContext): ConvertedSum {
  let total = 0n;
  let converted = 0;
  const missing = new Map<string, { amount: Cents; entries: number }>();
  for (const it of items) {
    const a = cents(it.amount);
    const c = convert(a, it.currency, target, it.fxOn, ctx);
    if (c === null) {
      const m = missing.get(it.currency) ?? { amount: 0n, entries: 0 };
      m.amount += a;
      m.entries += 1;
      missing.set(it.currency, m);
    } else {
      total += c;
      converted += 1;
    }
  }
  const none = items.length > 0 && converted === 0;
  return {
    total: none ? null : str(total),
    totalCents: none ? null : total,
    converted,
    unconverted: [...missing.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([currency, m]) => ({ currency, amount: str(m.amount), entries: m.entries })),
  };
}

/** Курсова різниця обміну (§5.7): отримано b у B мінус convert(a, A→B, D) у валюті B; без курсу → null (відмова). */
export function fxConversionDifference(
  sold: { amount: string; currency: string },
  received: { amount: string; currency: string },
  date: string,
  ctx: ConvertContext,
): string | null {
  const a = cents(sold.amount);
  const b = cents(received.amount);
  const expected = convert(a, sold.currency, received.currency, date, ctx);
  return expected === null ? null : str(b - expected);
}

/** Неявне співвідношення валюти покупця до валюти магазину (довідково, 4 знаки): 86.40 / 100.00 → «0.8640». */
export function impliedRatio(presentment: string, shop: string): string | null {
  const p = cents(presentment);
  const s = cents(shop);
  if (s <= 0n) return null;
  const scaled = divRound(p * 10000n, s);
  return `${scaled / 10000n}.${(scaled % 10000n).toString().padStart(4, "0")}`;
}

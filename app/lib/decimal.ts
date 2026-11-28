/**
 * Етап 6: точні десяткові для фінансів (docs/stage6-design.md §5.5, §5.9). BigInt, без float; API `app/lib/money.ts`
 * не змінюється (гроші — рядки з 2 знаками, `toMinor`/`fromMinor`).
 *
 * Домовленості:
 * - суми `numeric(14,2)` зберігаються в СОТИХ частках для будь-якої валюти (і для валют з 0 знаками: 1 000 JPY → 100 000);
 * - курс p — гривень за 1 одиницю валюти; P = p × 10^10 — ціле (`fx_rates.rate_per_unit` має рівно 10 знаків);
 * - округлення — половина від нуля, ОДИН раз на запис (convertMinor), потім сума.
 */
import { fromMinor, toMinor } from "./money";

export { divideMinorHalfUp } from "~/modules/production/calc";

/** Раціональне число num/den (den > 0). */
export interface Rational {
  num: bigint;
  den: bigint;
}

/** Масштаб курсу: P = p × 10^RATE_SCALE (ціле). */
export const RATE_SCALE = 10;
export const RATE_SCALE_FACTOR = 10n ** BigInt(RATE_SCALE);

// ---------------------------------------------------------------------------
// Валюти (перенесено з app/modules/rates/pricing.ts; там — реекспорт без зміни поведінки)
// ---------------------------------------------------------------------------

/**
 * Кількість знаків після коми за ISO 4217 (лише ті, що відрізняються від 2).
 * Shopify на сторінках CarrierService власного списку не наводить — беремо стандарт ISO 4217.
 */
const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX", "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
]);
const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);
const FOUR_DECIMAL_CURRENCIES = new Set(["CLF", "UYW"]);

export function currencyMinorDigits(currency: string): number {
  const c = currency.trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(c)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(c)) return 3;
  if (FOUR_DECIMAL_CURRENCIES.has(c)) return 4;
  return 2;
}

/** Те саме, що currencyMinorDigits (назва з §5.9). */
export const minorDigits = currencyMinorDigits;

export const CURRENCY_CODE_RE = /^[A-Z]{3}$/;

export class UnsupportedCurrencyError extends RangeError {
  constructor(readonly currency: string) {
    super(`Unsupported currency for finance: ${currency}`);
    this.name = "UnsupportedCurrencyError";
  }
}

/**
 * Валюта фінансів етапу 6: код ISO 4217 `^[A-Z]{3}$` з 0 або 2 десятковими (§5.1). Валюти з 3–4 знаками (BHD, KWD,
 * TND…) не підтримуються (сховище numeric(14,2)) → UnsupportedCurrencyError (факт не проводиться, «Потребує
 * перевірки: unsupported_currency»). Повертає кількість знаків.
 */
export function assertSupportedCurrency(currency: string): 0 | 2 {
  if (!CURRENCY_CODE_RE.test(currency)) throw new UnsupportedCurrencyError(currency);
  const d = currencyMinorDigits(currency);
  if (d !== 0 && d !== 2) throw new UnsupportedCurrencyError(currency);
  return d;
}

export function isSupportedCurrency(currency: string): boolean {
  try {
    assertSupportedCurrency(currency);
    return true;
  } catch {
    return false;
  }
}

/**
 * Сума у валюті з 0 знаками з ненульовими сотими (12.50 JPY) — помилка розбору, не округлення (§5.1).
 * Повертає соті частки (як toMinor) або кидає RangeError.
 */
export function toMinorForCurrency(amount: string, currency: string): bigint {
  const d = assertSupportedCurrency(currency);
  const minor = toMinor(amount);
  if (d === 0 && minor % 100n !== 0n) throw new RangeError(`Amount ${amount} has fractional units for ${currency}`);
  return minor;
}

// ---------------------------------------------------------------------------
// Розбір
// ---------------------------------------------------------------------------

const STRICT_DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Строгий розбір десяткового рядка: необов'язковий знак, цифри, крапка; без експоненти, пробілів і ком. Знаків після
 * коми — не більше maxScale. Результат — точне раціональне число з den = 10^(кількість знаків рядка); інакше null.
 */
export function parseDecimalStrict(value: string, maxScale: number): Rational | null {
  if (typeof value !== "string") return null;
  const m = STRICT_DECIMAL_RE.exec(value);
  if (!m) return null;
  const frac = m[3] ?? "";
  if (frac.length > maxScale) return null;
  if (m[2]!.length > 30) return null;
  const abs = BigInt(m[2]! + frac);
  return { num: m[1] === "-" ? -abs : abs, den: 10n ** BigInt(frac.length) };
}

/** Десятковий рядок → ціле, помножене на 10^scale (точно; більше знаків, ніж scale → null). */
export function decimalToScaled(value: string, scale: number): bigint | null {
  const r = parseDecimalStrict(value, scale);
  if (!r) return null;
  return r.num * (10n ** BigInt(scale) / r.den);
}

/** Ціле, помножене на 10^scale → десятковий рядок без зайвих нулів у кінці дробової частини («49.4942», «1»). */
export function scaledToDecimal(value: bigint, scale: number, minFraction = 0): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const f = 10n ** BigInt(scale);
  const int = (abs / f).toString();
  let frac = scale > 0 ? (abs % f).toString().padStart(scale, "0") : "";
  frac = frac.replace(/0+$/, "");
  if (frac.length < minFraction) frac = frac.padEnd(minFraction, "0");
  return `${negative && abs !== 0n ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/**
 * P = rate / units × 10^10 (ціле, точно). rate — десятковий рядок як опубліковано (до 6 знаків, > 0), units ∈
 * {1, 10, 100, 1000, 10000}. Неточне (більше 10 знаків) або некоректне → RangeError.
 */
export function ratePerUnitScaled(rate: string, units: number): bigint {
  if (!Number.isSafeInteger(units) || units <= 0) throw new RangeError(`units must be a positive integer, got ${units}`);
  const r = parseDecimalStrict(rate, 10);
  if (!r || r.num <= 0n) throw new RangeError(`rate must be a positive decimal, got ${rate}`);
  const num = r.num * RATE_SCALE_FACTOR;
  const den = r.den * BigInt(units);
  if (num % den !== 0n) throw new RangeError(`rate ${rate} / ${units} has more than ${RATE_SCALE} decimals`);
  return num / den;
}

/** `fx_rates.rate_per_unit` (numeric(20,10) з БД, напр. "49.4942000000") → P. */
export function scaledRateFromDb(ratePerUnit: string): bigint {
  const p = decimalToScaled(ratePerUnit, RATE_SCALE);
  if (p === null || p <= 0n) throw new RangeError(`invalid rate_per_unit ${ratePerUnit}`);
  return p;
}

/** P → десятковий рядок курсу за 1 одиницю («49.4942»). */
export function scaledRateToDecimal(p: bigint): string {
  return scaledToDecimal(p, RATE_SCALE);
}

// ---------------------------------------------------------------------------
// Округлення й конвертація
// ---------------------------------------------------------------------------

const absBig = (v: bigint) => (v < 0n ? -v : v);

/** a × num / den, округлення половина від нуля (зі знаком; den ≠ 0). */
export function mulDivHalfAwayFromZero(a: bigint, num: bigint, den: bigint): bigint {
  if (den === 0n) throw new RangeError("division by zero");
  const n = a * num;
  const negative = n < 0n !== den < 0n && n !== 0n;
  const q = (2n * absBig(n) + absBig(den)) / (2n * absBig(den));
  return negative ? -q : q;
}

/**
 * Конвертація суми запису (§5.5): a — СОТІ частки валюти X; PX, PY — курси × 10^10 (гривень за 1 одиницю); dY ∈ {0, 2}.
 * n = a × PX; D = PY × 10^(2 − dY); result = sign(n) × floor((2|n| + D) / (2D)) × 10^(2 − dY) — соті частки Y.
 * Одне округлення (половина від нуля) одразу до мінорних одиниць Y: 0,64 EUR → 112 JPY (а не 112,50 → 113).
 */
export function convertMinor(a: bigint, PX: bigint, PY: bigint, dY: number): bigint {
  if (dY !== 0 && dY !== 2) throw new RangeError(`unsupported target minor digits ${dY}`);
  if (PX <= 0n || PY <= 0n) throw new RangeError("rates must be positive");
  const k = dY === 0 ? 100n : 1n;
  const n = a * PX;
  const D = PY * k;
  const q = (2n * absBig(n) + D) / (2n * D);
  return (n < 0n ? -q : q) * k;
}

/** Відсоток у базисних пунктах від суми в мінорних одиницях: round(a × bp / 10000), половина від нуля. */
export function percentOfMinor(a: bigint, bp: bigint | number): bigint {
  return mulDivHalfAwayFromZero(a, BigInt(bp), 10_000n);
}

/**
 * Розподіл суми (мінорні одиниці) пропорційно вагам методом найбільших остач: Σ частин = total точно; нічия остач —
 * менший індекс; від'ємна сума розподіляється за модулем і повертається зі знаком. Ваги ≥ 0, сума ваг > 0.
 */
export function allocateMinor(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new RangeError("allocateMinor: no weights");
  let sum = 0n;
  for (const w of weights) {
    if (w < 0n) throw new RangeError("allocateMinor: negative weight");
    sum += w;
  }
  if (sum === 0n) throw new RangeError("allocateMinor: weights sum to zero");
  const negative = total < 0n;
  const t = absBig(total);
  const parts = weights.map((w) => (t * w) / sum);
  const remainders = weights.map((w, i) => ({ i, r: (t * w) % sum }));
  let left = t - parts.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    parts[i] = parts[i]! + 1n;
    left -= 1n;
  }
  return negative ? parts.map((p) => -p) : parts;
}

/**
 * Рентабельність у відсотках з 1 знаком (половина від нуля): num / den × 100. den ≤ 0 → null («—», §2.4).
 * Результат — десятковий рядок («56.8», «-3.0»).
 */
export function marginPercent(num: bigint, den: bigint): string | null {
  if (den <= 0n) return null;
  const tenths = mulDivHalfAwayFromZero(num, 1000n, den);
  return scaledToDecimal(tenths, 1, 1);
}

/** Сума мінорних одиниць (лише ВІДОМИХ значень; відсутнє — null у викликача, ніколи не 0). */
export function sumMinor(values: readonly bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n);
}

export { fromMinor, toMinor };

// ---------------------------------------------------------------------------
// Сума, введена власником (§5.9)
// ---------------------------------------------------------------------------

export type OwnerAmountError = "finance.error.amountEmpty" | "finance.error.amountInvalid" | "finance.error.amountAmbiguous" | "finance.error.amountTooPrecise";

/**
 * Сума з форми власника: «1 234,50», «1234,50», «1234.50», «-120» (кредит). Пробіли (зокрема нерозривні) — розділювачі
 * тисяч. І кома, і крапка → «Неоднозначний запис суми»; більше 2 знаків після коми → помилка; до 12 цілих розрядів
 * (numeric(14,2)). Результат — "1234.50".
 */
export function parseOwnerAmount(input: string | null | undefined): { ok: true; value: string } | { ok: false; error: OwnerAmountError } {
  const raw = (input ?? "").replace(/[\s  ]/g, "").replace(/^−/, "-");
  if (raw === "") return { ok: false, error: "finance.error.amountEmpty" };
  if (raw.includes(",") && raw.includes(".")) return { ok: false, error: "finance.error.amountAmbiguous" };
  if ((raw.match(/[,.]/g) ?? []).length > 1) return { ok: false, error: "finance.error.amountAmbiguous" };
  const normalized = raw.replace(",", ".");
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!m) return { ok: false, error: "finance.error.amountInvalid" };
  const frac = m[3] ?? "";
  if (frac.length > 2) return { ok: false, error: "finance.error.amountTooPrecise" };
  const int = m[2]!.replace(/^0+(?=\d)/, "");
  if (int.length > 12) return { ok: false, error: "finance.error.amountInvalid" };
  return { ok: true, value: fromMinor(toMinor(`${m[1] ?? ""}${int}${frac ? `.${frac}` : ""}`)) };
}

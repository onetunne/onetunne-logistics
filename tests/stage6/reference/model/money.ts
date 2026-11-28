/**
 * Еталонна модель етапу 6 (WP12a): власна точна арифметика грошей на BigInt.
 *
 * НЕЗАЛЕЖНІСТЬ: файли tests/stage6/reference/** НІКОЛИ не імпортують app/ (ні `~/…`, ні відносні шляхи) — модель
 * написана заново за docs/stage6-design.md і є «другою парою очей» для WP12b (тест reference-independence).
 *
 * Сума — ціле число СОТИХ (як `numeric(14,2)`), зокрема для валют з 0 знаками: 1 000 JPY = 100000n (§5.5).
 * Округлення — половина від нуля; одне округлення на операцію.
 */

export type Cents = bigint;

const AMOUNT_RE = /^(-)?(\d{1,16})(?:\.(\d{1,2}))?$/;

/** «-123.4» → -12340n. Строго: без пробілів-розділювачів, без експоненти, ≤ 2 знаків після крапки. */
export function cents(value: string): Cents {
  const m = AMOUNT_RE.exec(value);
  if (!m) throw new RangeError(`reference: bad amount "${value}"`);
  const whole = BigInt(m[2]!);
  const frac = BigInt(((m[3] ?? "") + "00").slice(0, 2));
  const v = whole * 100n + frac;
  return m[1] ? -v : v;
}

/** -12340n → «-123.40» (нуль — «0.00», без мінуса). */
export function str(value: Cents): string {
  const neg = value < 0n;
  const a = neg ? -value : value;
  const s = `${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
  return neg ? `-${s}` : s;
}

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function sum(values: readonly bigint[]): bigint {
  let s = 0n;
  for (const v of values) s += v;
  return s;
}

/** round(n / d), половина від нуля; d ≠ 0 (будь-який знак). */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new RangeError("reference: division by zero");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const neg = n < 0n;
  const a = neg ? -n : n;
  const q = (2n * a + d) / (2n * d);
  return neg ? -q : q;
}

/** round(a × num / den), половина від нуля. */
export function mulDiv(a: bigint, num: bigint, den: bigint): bigint {
  return divRound(a * num, den);
}

/**
 * Розподіл `total` пропорційно невід'ємним вагам методом найбільших остач (§5.9): Σ частин = total точно; нічия —
 * менший індекс; від'ємна сума — за модулем зі знаком. Сума ваг > 0 (інакше — виняток: викликач обирає запасне
 * правило, напр. «за виручкою», §10.3).
 */
export function allocate(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) throw new RangeError("reference.allocate: no weights");
  let w = 0n;
  for (const x of weights) {
    if (x < 0n) throw new RangeError("reference.allocate: negative weight");
    w += x;
  }
  if (w === 0n) throw new RangeError("reference.allocate: zero weights");
  const neg = total < 0n;
  const t = neg ? -total : total;
  const parts = weights.map((x) => (t * x) / w);
  let left = t - sum(parts);
  const order = weights.map((x, i) => ({ i, r: (t * x) % w })).sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of order) {
    if (left === 0n) break;
    parts[i] = parts[i]! + 1n;
    left -= 1n;
  }
  return neg ? parts.map((p) => -p) : parts;
}

/** Відсоток з 1 знаком (половина від нуля) як рядок «56.8»; знаменник ≤ 0 → null («—», §2.4). */
export function percent1(num: bigint, den: bigint): string | null {
  if (den <= 0n) return null;
  const tenths = mulDiv(num, 1000n, den);
  const neg = tenths < 0n;
  const a = neg ? -tenths : tenths;
  const s = `${a / 10n}.${a % 10n}`;
  return neg ? `-${s}` : s;
}

/** Відношення з `digits` знаками (половина від нуля) як рядок; знаменник ≤ 0 → null. Напр. окупність «3.40». */
export function ratio(num: bigint, den: bigint, digits = 2): string | null {
  if (den <= 0n) return null;
  const scale = 10n ** BigInt(digits);
  const scaled = mulDiv(num, scale, den);
  const neg = scaled < 0n;
  const a = neg ? -scaled : scaled;
  const s = digits === 0 ? `${a}` : `${a / scale}.${(a % scale).toString().padStart(digits, "0")}`;
  return neg ? `-${s}` : s;
}

/** Точний дріб (для курсів і часток). den > 0. */
export interface Rational {
  num: bigint;
  den: bigint;
}

function gcd(a: bigint, b: bigint): bigint {
  a = abs(a);
  b = abs(b);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

export function rational(num: bigint, den: bigint): Rational {
  if (den === 0n) throw new RangeError("reference: zero denominator");
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const g = gcd(num, den) || 1n;
  return { num: num / g, den: den / g };
}

export function rMul(a: Rational, b: Rational): Rational {
  return rational(a.num * b.num, a.den * b.den);
}

export function rAdd(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den + b.num * a.den, a.den * b.den);
}

export function rSub(a: Rational, b: Rational): Rational {
  return rational(a.num * b.den - b.num * a.den, a.den * b.den);
}

export const R_ONE: Rational = { num: 1n, den: 1n };
export const R_ZERO: Rational = { num: 0n, den: 1n };

/** Десятковий рядок «49.5335» → дріб (лише ≥ 0, без експоненти). */
export function parseDecimal(value: string): Rational {
  const m = /^(\d{1,12})(?:\.(\d{1,12}))?$/.exec(value);
  if (!m) throw new RangeError(`reference: bad decimal "${value}"`);
  const frac = m[2] ?? "";
  return rational(BigInt(m[1]! + frac), 10n ** BigInt(frac.length));
}

/** Порівняння a > b для дробів. */
export function rGreater(a: Rational, b: Rational): boolean {
  return a.num * b.den > b.num * a.den;
}

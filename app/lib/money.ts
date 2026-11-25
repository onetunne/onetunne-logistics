/**
 * Точна десяткова арифметика для грошей (2 знаки після коми) через BigInt мінорних одиниць.
 * Жодних float у розрахунках.
 */
const SCALE = 100n;
const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d{1,2}))?$/;

export function isDecimalString(value: string): boolean {
  return DECIMAL_RE.test(value.trim());
}

export function toMinor(value: string): bigint {
  const m = DECIMAL_RE.exec(value.trim());
  if (!m) throw new RangeError(`Invalid decimal amount: ${value}`);
  const [, sign, int, frac = ""] = m;
  const minor = BigInt(int!) * SCALE + BigInt(frac.padEnd(2, "0"));
  return sign ? -minor : minor;
}

export function fromMinor(minor: bigint): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const int = abs / SCALE;
  const frac = (abs % SCALE).toString().padStart(2, "0");
  return `${negative ? "-" : ""}${int}.${frac}`;
}

export function addMoney(...values: string[]): string {
  return fromMinor(values.reduce((acc, v) => acc + toMinor(v), 0n));
}

export function multiplyMoney(value: string, quantity: number): string {
  if (!Number.isInteger(quantity)) throw new RangeError("quantity must be an integer");
  return fromMinor(toMinor(value) * BigInt(quantity));
}

export function compareMoney(a: string, b: string): -1 | 0 | 1 {
  const d = toMinor(a) - toMinor(b);
  return d === 0n ? 0 : d < 0n ? -1 : 1;
}

export function isPositiveMoney(value: string | null | undefined): boolean {
  if (!value || !isDecimalString(value)) return false;
  return toMinor(value) > 0n;
}

/** Форматування для відображення (Intl), значення залишається рядком у даних. */
export function formatMoney(amount: string, currency: string, locale: string): string {
  const minor = toMinor(amount);
  const formatter = new Intl.NumberFormat(locale === "uk" ? "uk-UA" : "en-GB", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  // Number безпечний для відображення сум до 2^53 мінорних одиниць.
  return formatter.format(Number(minor) / 100);
}

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

const NBSP = "\u00A0";

/** Групування розрядів цілої частини (рядок цифр) фіксованим роздільником. */
export function groupDigits(digits: string, separator: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, separator);
}

/** Англійська: символ перед сумою (як en-GB). Інші валюти — ISO-код перед сумою. */
const EN_PREFIX: Readonly<Record<string, string>> = { EUR: "€", GBP: "£", USD: "US$" };
/** Українська: ISO-код після суми; для гривні — «грн». */
const UK_SUFFIX: Readonly<Record<string, string>> = { UAH: "грн" };

/**
 * Детерміноване форматування суми для інтерфейсу: однаковий результат на сервері (SSR) і в будь-якому браузері.
 * НЕ використовує Intl style:"currency": символ гривні в Node («₴») і Chrome («грн») різний → помилки гідратації React.
 * uk: «1 234,50 грн», «-1 234,50 EUR» (групування — нерозривний пробіл U+00A0);
 * en: «€1,234.50», «US$1,234.50», «UAH 1,234.50».
 */
export function formatMoney(amount: string, currency: string, locale: string): string {
  const minor = toMinor(amount);
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const uk = locale === "uk";
  const int = groupDigits((abs / SCALE).toString(), uk ? NBSP : ",");
  const frac = (abs % SCALE).toString().padStart(2, "0");
  const number = `${int}${uk ? "," : "."}${frac}`;
  const code = currency.trim().toUpperCase();
  const sign = negative ? "-" : "";
  if (uk) return `${sign}${number}${NBSP}${UK_SUFFIX[code] ?? code}`;
  const prefix = EN_PREFIX[code];
  return prefix ? `${sign}${prefix}${number}` : `${sign}${code}${NBSP}${number}`;
}

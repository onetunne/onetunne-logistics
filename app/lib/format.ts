import type { Locale } from "~/i18n/types";
import { formatMoney as formatMoneyExact, groupDigits } from "./money";

/**
 * Форматування для інтерфейсу — ЄДИНЕ місце для сум, чисел і дат (SSR і браузер).
 * Результат детермінований: роздільники й порядок частин задані тут, а не локальними даними ICU рушія
 * (Node, Chrome, Safari, Firefox мають різні версії ICU; різниця в одному символі ламає гідратацію React).
 * Intl використовується лише для того, що визначено стандартом однаково всюди: часовий пояс і округлення цифр.
 * Часовий пояс фіксований (Europe/Kyiv), щоб сервер і браузер показували однаковий час.
 */
export const BUSINESS_TIME_ZONE = "Europe/Kyiv";

const NBSP = " ";

const intlLocale = (locale: Locale) => (locale === "uk" ? "uk-UA" : "en-GB");

/** Роздільники за мовою: uk — «1 234,5» (U+00A0), en — «1,234.5». */
const SEPARATORS: Readonly<Record<Locale, { group: string; decimal: string; date: string }>> = {
  uk: { group: NBSP, decimal: ",", date: "." },
  en: { group: ",", decimal: ".", date: "/" },
};

/** Частини дати/часу в Europe/Kyiv (цифри «en-US» + h23 однакові в усіх рушіях). */
const KYIV_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: BUSINESS_TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function kyivParts(value: Date | string): { year: string; month: string; day: string; hour: string; minute: string } | null {
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return null;
  const parts = KYIV_PARTS.formatToParts(d);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  // Деякі рушії повертають «24» для опівночі навіть з h23 — нормалізуємо.
  const hour = get("hour") === "24" ? "00" : get("hour");
  return { year: get("year"), month: get("month"), day: get("day"), hour, minute: get("minute") };
}

/** «27.11.2026, 09:19» (uk) / «27/11/2026, 09:19» (en), час — Europe/Kyiv. */
export function formatDateTime(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const p = kyivParts(value);
  if (!p) return "—";
  const sep = SEPARATORS[locale].date;
  return `${p.day}${sep}${p.month}${sep}${p.year}, ${p.hour}:${p.minute}`;
}

/** «27.11.2026» (uk) / «27/11/2026» (en), дата в Europe/Kyiv. */
export function formatDate(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const p = kyivParts(value);
  if (!p) return "—";
  const sep = SEPARATORS[locale].date;
  return `${p.day}${sep}${p.month}${sep}${p.year}`;
}

/** Календарна дата "YYYY-MM-DD" (без часу й часового поясу) → «11.12.2026» / «11/12/2026». */
export function formatIsoDate(value: string | null | undefined, locale: Locale): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((value ?? "").trim());
  if (!m) return value ? value : "—";
  const sep = SEPARATORS[locale].date;
  return `${m[3]}${sep}${m[2]}${sep}${m[1]}`;
}

export function formatMoney(amount: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  if (!amount || !currency) return "—";
  return formatMoneyExact(amount, currency, locale);
}

/** Цифри без групування з округленням Intl (визначено стандартом ECMA-402 однаково в усіх рушіях). */
const PLAIN_DIGITS = new Map<string, Intl.NumberFormat>();
function plainDigits(minFraction: number, maxFraction: number): Intl.NumberFormat {
  const key = `${minFraction}:${maxFraction}`;
  let f = PLAIN_DIGITS.get(key);
  if (!f) {
    f = new Intl.NumberFormat("en-US", { useGrouping: false, minimumFractionDigits: minFraction, maximumFractionDigits: maxFraction });
    PLAIN_DIGITS.set(key, f);
  }
  return f;
}

/**
 * Число з фіксованими роздільниками: uk «1 234,5», en «1,234.5». За замовчуванням — до 3 знаків після коми
 * (як toLocaleString). Нескінченність/NaN → «—».
 */
export function formatDecimal(
  value: number,
  locale: Locale,
  options: { minimumFractionDigits?: number; maximumFractionDigits?: number } = {},
): string {
  if (!Number.isFinite(value)) return "—";
  const max = Math.min(20, Math.max(0, options.maximumFractionDigits ?? 3));
  const min = Math.min(max, Math.max(0, options.minimumFractionDigits ?? 0));
  const raw = plainDigits(min, max).format(value === 0 ? 0 : value);
  const negative = raw.startsWith("-");
  const [int = "0", frac] = (negative ? raw.slice(1) : raw).split(".");
  const { group, decimal } = SEPARATORS[locale];
  const body = `${groupDigits(int, group)}${frac ? `${decimal}${frac}` : ""}`;
  // «-0» після округлення (−0,0001 → «0») не показуємо зі знаком.
  return negative && /[1-9]/.test(body) ? `-${body}` : body;
}

export function formatNumber(value: number, locale: Locale): string {
  return formatDecimal(value, locale);
}

export function formatWeight(grams: number | null | undefined, locale: Locale): string {
  if (grams === null || grams === undefined) return "—";
  if (grams < 1000) return `${grams} ${locale === "uk" ? "г" : "g"}`;
  const kg = formatDecimal(grams / 1000, locale, { maximumFractionDigits: 3 });
  return `${kg} ${locale === "uk" ? "кг" : "kg"}`;
}

/** Назва країни за ISO-кодом (Intl.DisplayNames), з запасним варіантом — сам код. */
export function countryName(code: string | null | undefined, locale: Locale): string {
  if (!code) return "—";
  try {
    return new Intl.DisplayNames([intlLocale(locale)], { type: "region" }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/**
 * Етап 6: відсоток із десяткового рядка («56.8» → uk «56,8 %», en «56.8%»); null / некоректне → «—».
 * Рядок, а не number: рентабельність рахується точно (app/lib/decimal.ts marginPercent).
 */
export function formatPercent(value: string | null | undefined, locale: Locale): string {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec((value ?? "").trim());
  if (!m) return "—";
  const { group, decimal } = SEPARATORS[locale];
  const body = `${groupDigits(m[2]!, group)}${m[3] ? `${decimal}${m[3]}` : ""}`;
  const sign = m[1] && /[1-9]/.test(body) ? "-" : "";
  return locale === "uk" ? `${sign}${body}${NBSP}%` : `${sign}${body}%`;
}

/** Одиниці від меншої до більшої (вибір — за ОКРУГЛЕНИМ значенням). */
const COMPACT_UNITS: Readonly<Record<Locale, ReadonlyArray<{ exp: number; suffix: string }>>> = {
  uk: [
    { exp: 3, suffix: "тис." },
    { exp: 6, suffix: "млн" },
    { exp: 9, suffix: "млрд" },
  ],
  en: [
    { exp: 3, suffix: "k" },
    { exp: 6, suffix: "m" },
    { exp: 9, suffix: "bn" },
  ],
};

/**
 * Етап 6: коротка сума для підписів осей графіків («12,3 тис. грн» / «€12.3k»): 1 знак, половина від нуля, BigInt
 * (детерміновано для SSR). Менше 1 000 (після округлення) — ціле. Одиниця обирається за округленим значенням:
 * 999,50 → «1 тис.», 999 950 → «1 млн» (не «1 000 тис.»). Відсутнє → «—».
 */
export function formatCompactMoney(amount: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec((amount ?? "").trim());
  if (!m || !currency) return "—";
  const negative = Boolean(m[1]);
  const minor = BigInt(m[2]!) * 100n + BigInt((m[3] ?? "").padEnd(2, "0"));
  const { group, decimal } = SEPARATORS[locale];
  const roundDiv = (den: bigint) => (minor * 2n + den) / (2n * den); // половина від нуля (minor ≥ 0)
  let number: string;
  const whole = roundDiv(100n);
  if (whole < 1000n) {
    number = groupDigits(whole.toString(), group);
  } else {
    const units = COMPACT_UNITS[locale];
    let chosen = units[units.length - 1]!;
    let tenths = 0n;
    for (const u of units) {
      // десяті частки одиниці виміру (з мінорних одиниць); «1 000,0 одиниці» → наступна одиниця
      tenths = roundDiv(10n ** BigInt(u.exp + 1));
      chosen = u;
      if (tenths < 10_000n) break;
    }
    const int = groupDigits((tenths / 10n).toString(), group);
    const frac = (tenths % 10n).toString();
    number = `${int}${frac === "0" ? "" : `${decimal}${frac}`}${locale === "uk" ? `${NBSP}${chosen.suffix}` : chosen.suffix}`;
  }
  const sign = negative && /[1-9]/.test(number) ? "-" : "";
  const code = currency.trim().toUpperCase();
  if (locale === "uk") return `${sign}${number}${NBSP}${code === "UAH" ? "грн" : code}`;
  const prefix = ({ EUR: "€", GBP: "£", USD: "US$" } as Record<string, string>)[code];
  return prefix ? `${sign}${prefix}${number}` : `${sign}${code}${NBSP}${number}`;
}

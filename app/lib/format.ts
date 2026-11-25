import type { Locale } from "~/i18n/types";
import { formatMoney as formatMoneyExact } from "./money";

/**
 * Форматування для інтерфейсу. Часовий пояс фіксований (Europe/Kyiv), щоб сервер і браузер
 * показували однаковий час (без розбіжностей під час гідратації).
 */
export const BUSINESS_TIME_ZONE = "Europe/Kyiv";

const intlLocale = (locale: Locale) => (locale === "uk" ? "uk-UA" : "en-GB");

export function formatDateTime(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: BUSINESS_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function formatDate(value: Date | string | null | undefined, locale: Locale): string {
  if (!value) return "—";
  const d = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: BUSINESS_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);
}

export function formatMoney(amount: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  if (!amount || !currency) return "—";
  return formatMoneyExact(amount, currency, locale);
}

export function formatWeight(grams: number | null | undefined, locale: Locale): string {
  if (grams === null || grams === undefined) return "—";
  if (grams < 1000) return `${grams} ${locale === "uk" ? "г" : "g"}`;
  const kg = (grams / 1000).toLocaleString(intlLocale(locale), { maximumFractionDigits: 3 });
  return `${kg} ${locale === "uk" ? "кг" : "kg"}`;
}

export function formatNumber(value: number, locale: Locale): string {
  return value.toLocaleString(intlLocale(locale));
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

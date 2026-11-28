import { isOrderStatus } from "~/domain/order-status";
import { countryName, formatMonthYear } from "~/lib/format";
import { hasKey, type TFunction, type TranslateParams } from "./index";
import type { Locale } from "./types";

/** Службовий код (напр. confirmed_not_created) → зрозумілий текст; невідомий текст залишається як є. */
export function localizeCode(value: string, t: TFunction): string {
  const key = `order.code.${value}`;
  return hasKey(key) ? t(key) : value;
}

/** Параметри з кодом країни ISO (DE, UA…), які показуються назвою країни. */
const COUNTRY_PARAMS = ["country", "phoneCountry"] as const;

/** "DE" → «Німеччина (DE)»; невідомий/нестандартний код — як є. */
export function localizeCountry(code: string, locale: Locale): string {
  const value = code.trim();
  if (!/^[A-Za-z]{2}$/.test(value)) return code;
  const upper = value.toUpperCase();
  const name = countryName(upper, locale);
  return name && name !== upper ? `${name} (${upper})` : upper;
}

/** Назва поля: field.* (shipping.city, email, variant.…) → підпис; поле відправника (city, phone…) → підпис; інакше як є. */
function fieldText(field: string, t: TFunction): string {
  if (hasKey(`field.${field}`)) return t(`field.${field}`);
  if (hasKey(`order.waybill.shipperField.${field}`)) return t(`order.waybill.shipperField.${field}`);
  return field;
}

/** Параметр `month` сервісів фінансів (напр. finance.error.monthClosed { month: "2026-10-01" }) — календарний місяць. */
const ISO_MONTH_PARAM = /^\d{4}-\d{2}(?:-01)?$/;

/**
 * Локалізує параметри повідомлень сервісів: статус замовлення, службові коди перевізника, коди країн
 * (`country`, `phoneCountry`), перелік полів (`fields`: поля замовлення та відправника), календарний місяць (`month`
 * "YYYY-MM-01" → «жовтень 2026» / «October 2026», етап 6: finance.error.monthClosed — централізовано, сторінки не
 * форматують самі). Так у інтерфейсі не з'являються сирі ідентифікатори («UA», «shipping.city», «2026-10-01»).
 */
export function localizeParams(
  params: TranslateParams | undefined | null,
  t: TFunction,
  locale: Locale,
): TranslateParams | undefined {
  if (!params) return undefined;
  const out: TranslateParams = { ...params };
  if (typeof out.status === "string" && isOrderStatus(out.status)) out.status = t(`status.${out.status}`);
  if (typeof out.message === "string") out.message = localizeCode(out.message, t);
  for (const key of COUNTRY_PARAMS) {
    const value = out[key];
    if (typeof value === "string") out[key] = localizeCountry(value, locale);
  }
  if (typeof out.month === "string" && ISO_MONTH_PARAM.test(out.month.trim())) out.month = formatMonthYear(out.month, locale);
  if (typeof out.fields === "string") {
    out.fields = out.fields
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean)
      .map((f) => fieldText(f, t))
      .join(", ");
  }
  return out;
}

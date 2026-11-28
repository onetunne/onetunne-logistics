/**
 * Етап 6, WP7: форматування сум партнерів для сторінок (чисте; без серверних залежностей). Відсутнє — «—», ніколи 0.
 */
import type { Locale } from "~/i18n/types";
import { formatMoney, formatPercent } from "~/lib/format";
import { bpToPercent } from "./input";
import type { Money } from "./types";

/** Кілька сум у різних валютах одним рядком («7,20 EUR · 120,00 UAH»); порожньо → «—». */
export function moneyList(list: readonly Money[], locale: Locale): string {
  return list.length ? list.map((m) => formatMoney(m.amount, m.currency, locale)).join(" · ") : "—";
}

/** Від'ємне значення десяткового рядка → додатне (−4.50 → 4.50). */
export function absDecimal(amount: string): string {
  return amount.startsWith("-") ? amount.slice(1) : amount;
}

/** Ставка в базисних пунктах → відсоток за правилами мови («12,5 %» / «12.5%»); немає ставки — «—». */
export function formatRateBp(bp: number | null | undefined, locale: Locale): string {
  return bp === null || bp === undefined ? "—" : formatPercent(bpToPercent(bp), locale);
}

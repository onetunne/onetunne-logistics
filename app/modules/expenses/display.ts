/**
 * Етап 6, WP6: підписи для сторінок витрат і місяців (детерміновано для SSR; без Intl-назв місяців).
 * Місяць YYYY-MM-01 → uk «10.2026», en «10/2026» (той самий вигляд, що в повідомленнях сервісів курсів).
 */
import type { Locale } from "~/i18n/types";

export function monthLabel(month: string, locale: Locale): string {
  const [y, m] = month.split("-");
  return locale === "uk" ? `${m}.${y}` : `${m}/${y}`;
}

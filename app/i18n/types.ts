export const LOCALES = ["uk", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "uk";

export type Messages = Record<string, string>;
/** Кожен файл у app/i18n/messages експортує модуль з однаковими ключами для uk та en. */
export interface MessageModule {
  uk: Messages;
  en: Messages;
}

export function isLocale(v: unknown): v is Locale {
  return v === "uk" || v === "en";
}

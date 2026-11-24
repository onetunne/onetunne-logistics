import { createCookie } from "react-router";
import { getEnv } from "~/lib/env.server";
import { DEFAULT_LOCALE, isLocale, type Locale } from "~/i18n/types";
import type { Role } from "~/domain/permissions";

const base = { path: "/", sameSite: "lax" as const, httpOnly: true, maxAge: 60 * 60 * 24 * 365 };

export const localeCookie = createCookie("ot_locale", base);
export const themeCookie = createCookie("ot_theme", base);
/** Демо: вибір ролі для демонстрації прав доступу (лише вигадані дані). */
export const demoRoleCookie = createCookie("ot_demo_role", base);

export const THEMES = ["system", "light", "dark"] as const;
export type Theme = (typeof THEMES)[number];

export function isTheme(v: unknown): v is Theme {
  return typeof v === "string" && (THEMES as readonly string[]).includes(v);
}

export function isRole(v: unknown): v is Role {
  return v === "owner" || v === "staff";
}

/** Підписаний cookie доступу до демо (якщо задано DEMO_PASSWORD). */
export function demoAccessCookie() {
  const env = getEnv();
  return createCookie("ot_demo_access", {
    ...base,
    maxAge: 60 * 60 * 24 * 30,
    secure: env.NODE_ENV === "production",
    secrets: env.SESSION_SECRET ? [env.SESSION_SECRET] : [],
  });
}

export async function readPreferences(request: Request): Promise<{ locale: Locale; theme: Theme }> {
  const header = request.headers.get("Cookie");
  const url = new URL(request.url);
  const [locale, theme] = await Promise.all([localeCookie.parse(header), themeCookie.parse(header)]);
  // У вбудованому режимі Shopify передає ?locale=… (cookie в iframe можуть блокуватися).
  const fromQuery = url.searchParams.get("locale")?.slice(0, 2);
  return {
    locale: isLocale(locale) ? locale : isLocale(fromQuery) ? fromQuery : DEFAULT_LOCALE,
    theme: isTheme(theme) ? theme : "system",
  };
}

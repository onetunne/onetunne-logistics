import { useRouteLoaderData } from "react-router";
import { DEFAULT_LOCALE, isLocale, type Locale, type MessageModule, type Messages } from "./types";
import common from "./messages/common";
import validation from "./messages/validation";
import waybills from "./messages/waybills";
import dashboard from "./messages/dashboard";
import orders from "./messages/orders";
import problems from "./messages/problems";
import settings from "./messages/settings";
import planned from "./messages/planned";
import demo from "./messages/demo";
import results from "./messages/results";
import order from "./messages/order";
import shopify from "./messages/shopify";
import tracking from "./messages/tracking";
import carrierSettings from "./messages/carrier-settings";
import products from "./messages/products";
import orderStage4 from "./messages/order-stage4";
import customerRequests from "./messages/customer-requests";
import countryRules from "./messages/country-rules";
import warehouse from "./messages/warehouse";
import inventorySync from "./messages/inventory-sync";
import production from "./messages/production";
import packaging from "./messages/packaging";
import packing from "./messages/packing";
import warehouseAnalytics from "./messages/warehouse-analytics";

export * from "./types";

export const MESSAGE_MODULES: Record<string, MessageModule> = {
  common,
  validation,
  waybills,
  dashboard,
  orders,
  problems,
  settings,
  planned,
  demo,
  results,
  order,
  shopify,
  tracking,
  carrierSettings,
  products,
  orderStage4,
  customerRequests,
  countryRules,
  warehouse,
  inventorySync,
  production,
  packaging,
  packing,
  warehouseAnalytics,
};

function merge(locale: Locale): Messages {
  const out: Messages = {};
  for (const mod of Object.values(MESSAGE_MODULES)) Object.assign(out, mod[locale]);
  return out;
}

export const DICTIONARIES: Record<Locale, Messages> = { uk: merge("uk"), en: merge("en") };

export type TranslateParams = Record<string, string | number | null | undefined>;
export type TFunction = (key: string, params?: TranslateParams) => string;

/** Підстановка параметрів формату `{name}`. Відсутній ключ → українська версія → сам ключ. */
export function translate(locale: Locale, key: string, params?: TranslateParams): string {
  const template = DICTIONARIES[locale][key] ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const v = params[name];
    return v === undefined || v === null ? match : String(v);
  });
}

export function hasKey(key: string): boolean {
  return key in DICTIONARIES.uk;
}

export function makeT(locale: Locale): TFunction {
  return (key, params) => translate(locale, key, params);
}

/** Локаль з даних кореневого loader (root.tsx). */
export function useLocale(): Locale {
  const data = useRouteLoaderData("root") as { locale?: unknown } | undefined;
  return isLocale(data?.locale) ? data.locale : DEFAULT_LOCALE;
}

export function useT(): TFunction {
  const locale = useLocale();
  return makeT(locale);
}

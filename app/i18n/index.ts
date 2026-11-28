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
import warehouseInsights from "./messages/warehouse-insights";
import staff from "./messages/staff";
// Етап 6: спільний модуль фінансів (ядро) і модулі пакетів (docs/stage6-design.md §18.10).
import finance from "./messages/finance";
import financeDashboard from "./messages/finance-dashboard";
import financeOrders from "./messages/finance-orders";
import financeShipping from "./messages/finance-shipping";
import financeCosts from "./messages/finance-costs";
import financeFx from "./messages/finance-fx";
import financeExpenses from "./messages/finance-expenses";
import partners from "./messages/partners";
import analytics from "./messages/analytics";
import returns from "./messages/returns";
import financeReports from "./messages/finance-reports";
import financeCommands from "./messages/finance-commands";
import financeUi from "./messages/finance-ui";

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
  warehouseInsights,
  staff,
  finance,
  financeDashboard,
  financeOrders,
  financeShipping,
  financeCosts,
  financeFx,
  financeExpenses,
  partners,
  analytics,
  returns,
  financeReports,
  financeCommands,
  financeUi,
};

function merge(locale: Locale): Messages {
  const out: Messages = {};
  for (const mod of Object.values(MESSAGE_MODULES)) Object.assign(out, mod[locale]);
  return out;
}

export const DICTIONARIES: Record<Locale, Messages> = { uk: merge("uk"), en: merge("en") };

export type TranslateParams = Record<string, string | number | null | undefined>;
export type TFunction = (key: string, params?: TranslateParams) => string;

const PLURAL_RULES: Readonly<Record<Locale, Intl.PluralRules>> = {
  uk: new Intl.PluralRules("uk-UA"),
  en: new Intl.PluralRules("en-GB"),
};
const PLURAL_START = /\{(\w+),\s*plural,/g;
const PLURAL_SELECTOR = /^\s*(=\d+|zero|one|two|few|many|other)\s*\{/;

/**
 * Число для вибору форми: number як є; рядок — уже відформатоване число мови (lib/format: uk «1 234,5», en «1,234.5»).
 * Не число → null (форма «other»).
 */
function pluralNumber(v: TranslateParams[string], locale: Locale): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const compact = v.replace(/[\s\u00A0\u202F]/g, "");
  const normalized = locale === "uk" ? compact.replace(",", ".") : compact.replace(/,/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  return Number(normalized);
}

/**
 * Множина у стилі ICU: `{count, plural, one {# позиція} few {# позиції} many {# позицій} other {# позиції}}`.
 * Форма — за Intl.PluralRules мови (uk: one/few/many/other, en: one/other); `=N` — точне значення; `#` — значення
 * параметра як передано (можна вже відформатоване число). Некоректний шаблон повертається без змін.
 */
export function applyPlurals(template: string, locale: Locale, params: TranslateParams = {}): string {
  if (!template.includes(", plural,") && !template.includes(",plural,")) return template;
  let out = "";
  let i = 0;
  for (;;) {
    PLURAL_START.lastIndex = i;
    const m = PLURAL_START.exec(template);
    if (!m) break;
    const name = m[1]!;
    const branches = new Map<string, string>();
    let j = m.index + m[0].length;
    let closed = false;
    while (j < template.length) {
      const rest = template.slice(j);
      const end = /^\s*\}/.exec(rest);
      if (end) {
        j += end[0].length;
        closed = true;
        break;
      }
      const sel = PLURAL_SELECTOR.exec(rest);
      if (!sel) return template;
      j += sel[0].length;
      const bodyStart = j;
      let depth = 1;
      while (j < template.length && depth > 0) {
        const ch = template[j];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
        j++;
      }
      if (depth !== 0) return template;
      branches.set(sel[1]!, template.slice(bodyStart, j - 1));
    }
    if (!closed || !branches.has("other")) return template;
    const raw = params[name];
    const n = pluralNumber(raw, locale);
    const exact = n === null ? undefined : branches.get(`=${n}`);
    const byRule = n === null ? undefined : branches.get(PLURAL_RULES[locale].select(n));
    const chosen = exact ?? byRule ?? branches.get("other")!;
    out += template.slice(i, m.index) + chosen.replace(/#/g, raw === undefined || raw === null ? "#" : String(raw));
    i = j;
  }
  return out + template.slice(i);
}

/**
 * Підстановка параметрів формату `{name}` і множини `{name, plural, …}` (applyPlurals).
 * Відсутній ключ → українська версія → сам ключ.
 */
export function translate(locale: Locale, key: string, params?: TranslateParams): string {
  const own = DICTIONARIES[locale][key];
  const template = applyPlurals(own ?? DICTIONARIES[DEFAULT_LOCALE][key] ?? key, own === undefined ? DEFAULT_LOCALE : locale, params);
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

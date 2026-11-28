/**
 * Етап 6, WP4: параметри запиту сторінки «Фінанси → Замовлення» (§18.2) — чиста функція, без БД. Невідомі або
 * некоректні значення відкидаються (типові), сервер списку ще раз перевіряє кожне (list.server.ts).
 * Період (?period=<шаблон> або ?period=custom&from=&to=) — за датою визнання (невизнані — за датою оформлення);
 * довільний — не довший за 5 років і from ≤ to, інакше — типовий шаблон «30 днів».
 */
import { addMonths, isAllowedCustomRange, monthStart, parseIsoDate, PERIOD_PRESETS, resolvePreset, type DateRange, type PeriodPreset } from "~/lib/periods";
import { ORDER_FINANCE_LIST_STATES, ORDER_FINANCE_SORTS, type OrderFinanceListFilter, type OrderFinanceListState, type OrderFinanceSort } from "./list-types";

export const DEFAULT_ORDER_FINANCE_PRESET: Exclude<PeriodPreset, "custom"> = "last30";
/** Найдовший пошуковий рядок (номер замовлення). */
export const ORDER_FINANCE_QUERY_MAX = 40;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface OrderFinanceListParams {
  preset: PeriodPreset;
  range: DateRange;
  filter: Required<Pick<OrderFinanceListFilter, "sort" | "page" | "needsReview" | "lossOnly">> &
    Pick<OrderFinanceListFilter, "q" | "state" | "country" | "partnerId" | "currency"> & { from: string; to: string };
}

export function orderFinancePeriodOf(sp: URLSearchParams, today: string): { preset: PeriodPreset; range: DateRange } {
  const raw = sp.get("period") ?? "";
  const preset = (PERIOD_PRESETS as readonly string[]).includes(raw) ? (raw as PeriodPreset) : DEFAULT_ORDER_FINANCE_PRESET;
  if (preset === "custom") {
    const from = parseIsoDate(sp.get("from"));
    const to = parseIsoDate(sp.get("to"));
    if (from && to && from <= to && isAllowedCustomRange({ from, to }, "month") && from >= addMonths(monthStart(today), -12 * 5)) {
      return { preset, range: { from, to } };
    }
    return { preset: DEFAULT_ORDER_FINANCE_PRESET, range: resolvePreset(DEFAULT_ORDER_FINANCE_PRESET, today) };
  }
  return { preset, range: resolvePreset(preset, today) };
}

/** Параметри списку з рядка запиту. */
export function orderFinanceListParamsOf(sp: URLSearchParams, today: string): OrderFinanceListParams {
  const { preset, range } = orderFinancePeriodOf(sp, today);
  const q = (sp.get("q") ?? "").trim().slice(0, ORDER_FINANCE_QUERY_MAX);
  const stateRaw = sp.get("state") ?? "";
  const state = (ORDER_FINANCE_LIST_STATES as readonly string[]).includes(stateRaw) ? (stateRaw as OrderFinanceListState) : null;
  const countryRaw = (sp.get("country") ?? "").trim().toUpperCase();
  const country = /^[A-Z]{2}$/.test(countryRaw) ? countryRaw : null;
  const partnerRaw = sp.get("partner") ?? "";
  const partnerId = UUID_RE.test(partnerRaw) ? partnerRaw.toLowerCase() : null;
  const sortRaw = sp.get("sort") ?? "";
  const sort = (ORDER_FINANCE_SORTS as readonly string[]).includes(sortRaw) ? (sortRaw as OrderFinanceSort) : "recognized_desc";
  const pageRaw = sp.get("page") ?? "";
  const page = /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1;
  const currencyRaw = (sp.get("currency") ?? "").trim().toUpperCase();
  return {
    preset,
    range,
    filter: {
      q: q || null,
      from: range.from,
      to: range.to,
      state,
      country,
      needsReview: sp.get("review") === "1",
      partnerId,
      lossOnly: sp.get("loss") === "1",
      sort,
      page,
      currency: /^[A-Z]{3}$/.test(currencyRaw) ? currencyRaw : null,
    },
  };
}

/** Посилання на іншу сторінку списку (інші параметри запиту зберігаються). */
export function orderFinancePageHref(pathname: string, search: string, page: number): string {
  const params = new URLSearchParams(search);
  if (page <= 1) params.delete("page");
  else params.set("page", String(page));
  const s = params.toString();
  return s ? `${pathname}?${s}` : pathname;
}

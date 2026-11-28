/**
 * Етап 6, WP0-UI: банер повноти над фінансовими показниками (§2.6, §2.7, §18.1, §18.3):
 * - демо → «Демо: усі фінансові дані вигадані.»; `includesTestOrders` → «Враховано тестові замовлення»;
 * - маркер (значок + текст): «Повні дані» / «З прогнозом» / «Неповні дані» і рядок станів замовлень;
 * - назва прибутку за §2.7: «Чистий прибуток» лише коли `profitLabel = net_profit`, інакше підказка, як його отримати;
 * - розгортання «Що заповнити»: бракує за складниками, лише прогноз, без курсу (сума в валюті запису й кількість
 *   записів), розбіжності, «Потребує перевірки», пізні записи, закриті місяці зі знімків.
 * 0 визнаних замовлень — НІКОЛИ не «Повні дані» / «З прогнозом» (маркер ядра `completenessMarker` для 0 замовлень —
 * `complete`): заголовок «Немає даних за цей період» (нічого немає) або «Немає визнаних замовлень» (є лише пояснення —
 * оплачені невідвантажені, тестові, закриті місяці), тон info, пункти — у «Що заповнити». Лише справжня неповнота
 * (маркер `incomplete`, напр. записи без курсу) лишає «Неповні дані», але без рядка «0 · 0 · 0 — з 0».
 */
import { ORDER_COMPONENTS, type OrderComponent } from "~/domain/finance";
import { useLocale, type Locale } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import type { CompletenessSummary } from "~/modules/finance/core/states";
import { Banner, Disclosure, Stack } from "~/ui";
import type { CompletenessBannerProps } from "./contracts";
import { countText, formatMonth, moneyText } from "./format-ui";
import { useFinanceUiT, type FinanceUiT } from "./i18n";
import { MarkerBadge } from "./marker-badge";

export interface CompletenessItem {
  key: string;
  text: string;
  /** warning — впливає на числа; info — пояснення. */
  tone: "warning" | "info";
}

function orderedComponents(map: Partial<Record<OrderComponent, number>>): Array<[OrderComponent, number]> {
  return ORDER_COMPONENTS.filter((c) => (map[c] ?? 0) > 0).map((c) => [c, map[c]!]);
}

/** Пункти «Що заповнити» з об'єкта повноти (чиста функція; порядок — від того, що змінює числа). */
export function completenessItems(c: CompletenessSummary, ft: FinanceUiT, locale: Locale): CompletenessItem[] {
  const n = (v: number) => countText(v, locale);
  const items: CompletenessItem[] = [];
  for (const [component, count] of orderedComponents(c.missingByComponent)) {
    items.push({
      key: `missing:${component}`,
      tone: "warning",
      text: ft("financeUi.banner.missingComponent", { component: ft(financeLabelKeys.component(component)), n: n(count) }),
    });
  }
  for (const u of c.unconverted) {
    items.push({
      key: `unconverted:${u.currency}`,
      tone: "warning",
      text: ft(financeLabelKeys.rate("unconverted"), { amount: moneyText(u.amount, u.currency, locale), n: n(u.entries) }),
    });
  }
  if (c.incomplete > 0) items.push({ key: "incomplete", tone: "warning", text: ft("financeUi.banner.incompleteOrders", { n: n(c.incomplete) }) });
  if (c.openDiscrepancies > 0) items.push({ key: "discrepancies", tone: "warning", text: ft("financeUi.banner.discrepancies", { n: n(c.openDiscrepancies) }) });
  if (c.needsReview > 0) items.push({ key: "needsReview", tone: "warning", text: ft("financeUi.banner.needsReview", { n: n(c.needsReview) }) });
  if (c.unknownCostUnitsOnHand > 0) {
    items.push({ key: "unknownCost", tone: "warning", text: ft("financeUi.banner.unknownCostUnits", { n: n(c.unknownCostUnitsOnHand) }) });
  }
  for (const [component, count] of orderedComponents(c.forecastByComponent)) {
    items.push({
      key: `forecast:${component}`,
      tone: "info",
      text: ft("financeUi.banner.forecastComponent", { component: ft(financeLabelKeys.component(component)), n: n(count) }),
    });
  }
  if (c.preliminary > 0) items.push({ key: "preliminary", tone: "info", text: ft("financeUi.banner.preliminaryOrders", { n: n(c.preliminary) }) });
  if (c.staleRates > 0) items.push({ key: "staleRates", tone: "info", text: ft("financeUi.banner.staleRates", { n: n(c.staleRates) }) });
  if (c.lateEntries > 0) items.push({ key: "late", tone: "info", text: ft("financeUi.banner.lateEntries", { n: n(c.lateEntries) }) });
  if (c.open > 0) items.push({ key: "open", tone: "info", text: ft("financeUi.banner.open", { n: n(c.open) }) });
  if (c.excluded > 0) items.push({ key: "excluded", tone: "info", text: ft("financeUi.banner.excluded", { n: n(c.excluded) }) });
  if (c.closedMonths.length > 0) {
    items.push({
      key: "closedMonths",
      tone: "info",
      text: ft("financeUi.banner.closedMonths", { months: c.closedMonths.map((m) => formatMonth(m, locale)).join(", ") }),
    });
  }
  return items;
}

export function CompletenessBanner({ completeness, marker, profitLabel, includesTestOrders, demo }: CompletenessBannerProps) {
  const ft = useFinanceUiT();
  const locale = useLocale();
  const items = completenessItems(completeness, ft, locale);
  const noOrders = completeness.orders === 0;
  // Без визнаних замовлень маркер «повно» нічого не означає — показуємо порожній стан (крім справжньої неповноти,
  // яку пояснюють пункти «Що заповнити»).
  const empty = noOrders && (marker !== "incomplete" || items.length === 0);
  const tone = empty ? "info" : marker === "complete" ? "success" : marker === "with_forecast" ? "info" : "warning";
  const n = (v: number) => countText(v, locale);
  const emptyTitle = items.length === 0 ? ft("financeUi.chart.empty") : ft("financeUi.banner.noOrdersTitle");
  return (
    <Stack gap={2} className="ot-completeness">
      {demo ? <Banner tone="info">{ft(financeLabelKeys.notice("demo"))}</Banner> : null}
      {includesTestOrders ? <Banner tone="warning">{ft(financeLabelKeys.notice("testOrdersIncluded"))}</Banner> : null}
      <Banner tone={tone} title={empty ? emptyTitle : <MarkerBadge marker={marker} size="md" />}>
        <div className="ot-completeness__body" data-marker={empty ? "empty" : marker}>
          {noOrders ? (
            <p>{ft(items.length === 0 ? "financeUi.banner.empty" : "financeUi.banner.noOrders")}</p>
          ) : (
            <p className="ot-text--numeric">
              {ft("financeUi.banner.summary", {
                final: n(completeness.final),
                preliminary: n(completeness.preliminary),
                incomplete: n(completeness.incomplete),
                orders: n(completeness.orders),
              })}
            </p>
          )}
          <p className="ot-completeness__profit">
            {profitLabel === "net_profit" ? ft("financeUi.banner.netProfit") : ft(financeLabelKeys.notice("netProfitHint"))}
          </p>
          {items.length > 0 ? (
            <Disclosure summary={ft("financeUi.banner.details")} defaultOpen={marker === "incomplete" || noOrders} className="ot-completeness__details">
              <ul className="ot-completeness__list">
                {items.map((item) => (
                  <li key={item.key} data-tone={item.tone}>
                    {item.text}
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </div>
      </Banner>
    </Stack>
  );
}

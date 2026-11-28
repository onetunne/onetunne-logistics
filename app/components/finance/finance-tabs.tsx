/**
 * Етап 6, WP0-UI: вкладки фінансів (§18.1): Огляд · Замовлення · Доставка · Витрати · Партнери · Собівартість · Курси ·
 * Звіти · Місяці · Налаштування — посилання UI-кіту `Tabs` (на телефоні прокручуються горизонтально з підказкою краю),
 * поточна — `aria-current="page"`. Шляхи — `FINANCE_TABS` відносно basePath оболонки (/demo або /app).
 */
import { FINANCE_TABS } from "~/domain/finance";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Tabs } from "~/ui";
import { useHref } from "../shell";
import type { FinanceTabsProps } from "./contracts";
import { useFinanceUiT } from "./i18n";

export function FinanceTabs({ current }: FinanceTabsProps) {
  const ft = useFinanceUiT();
  const href = useHref();
  return (
    <Tabs
      className="ot-finance-tabs"
      ariaLabel={ft("nav.finance")}
      selected={current}
      preventScrollReset={false}
      items={FINANCE_TABS.map((tab) => ({ key: tab.key, label: ft(financeLabelKeys.tab(tab.key)), href: href(tab.path) }))}
    />
  );
}

/** Етап 6 (заглушка ядра → WP0-UI): вкладки фінансів (§18.1), прокрутка на телефоні — UI-кіт Tabs. */
import { FINANCE_TABS } from "~/domain/finance";
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Tabs } from "~/ui";
import { useHref } from "../shell";
import type { FinanceTabsProps } from "./contracts";

export function FinanceTabs({ current }: FinanceTabsProps) {
  const t = useT();
  const href = useHref();
  return (
    <Tabs
      ariaLabel={t("nav.finance")}
      selected={current}
      preventScrollReset={false}
      items={FINANCE_TABS.map((tab) => ({ key: tab.key, label: t(financeLabelKeys.tab(tab.key)), href: href(tab.path) }))}
    />
  );
}

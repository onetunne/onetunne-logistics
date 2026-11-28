/** Етап 6 (заглушка ядра → WP0-UI): банер повноти, назва прибутку (§2.7), тестові замовлення, демо. */
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Banner } from "~/ui";
import type { CompletenessBannerProps } from "./contracts";

export function CompletenessBanner({ marker, profitLabel, includesTestOrders, demo }: CompletenessBannerProps) {
  const t = useT();
  return (
    <>
      {demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
      {includesTestOrders ? <Banner tone="warning">{t(financeLabelKeys.notice("testOrdersIncluded"))}</Banner> : null}
      <Banner tone={marker === "complete" ? "success" : "warning"} title={t(financeLabelKeys.completeness(marker))}>
        {profitLabel === "net_profit" ? t(financeLabelKeys.profitLabel(profitLabel)) : t(financeLabelKeys.notice("netProfitHint"))}
      </Banner>
    </>
  );
}

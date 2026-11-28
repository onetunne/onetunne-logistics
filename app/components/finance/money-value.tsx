/** Етап 6 (заглушка ядра → WP0-UI): сума у валюті звітності + початкові суми підрядком; відсутнє — «—». */
import { useLocale, useT } from "~/i18n";
import { formatMoney } from "~/lib/format";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Text } from "~/ui";
import type { MoneyValueProps } from "./contracts";

export function MoneyValue({ value, original, forecast, emphasis = "default" }: MoneyValueProps) {
  const locale = useLocale();
  const t = useT();
  return (
    <span className="ot-money-value">
      <Text as="span" numeric weight={emphasis === "strong" ? "semibold" : undefined}>
        {forecast ? "≈ " : ""}
        {value ? formatMoney(value.amount, value.currency, locale) : "—"}
      </Text>
      {forecast ? <Text as="span" variant="caption" tone="subdued">{` ${t(financeLabelKeys.state("forecast"))}`}</Text> : null}
      {original && original.length > 0 ? (
        <Text as="span" variant="caption" tone="subdued">
          {" "}
          {original.map((o) => formatMoney(o.amount, o.currency, locale)).join(" · ")}
        </Text>
      ) : null}
    </span>
  );
}

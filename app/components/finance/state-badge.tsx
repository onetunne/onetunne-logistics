/**
 * Етап 6, WP0-UI: бейдж стану (§2.6, §18.3) — значок + текст (не лише колір). Стан складника (`ComponentState`),
 * прибутку (`ProfitState`) або визнання замовлення (`OrderFinanceState`); поруч — причина (`finance.reason.*`) і основа
 * значення (`finance.basis.*`), якщо їх передано: «Немає даних · Немає рахунку перевізника», «Факт · Shopify».
 */
import { COMPONENT_STATES, ORDER_FINANCE_STATES, type ComponentState, type OrderFinanceState, type ProfitState } from "~/domain/finance";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Badge, cx } from "~/ui";
import type { StateBadgeProps } from "./contracts";
import { useFinanceUiT } from "./i18n";
import { FinanceIcon, STATE_PRESENTATION } from "./icons";

/** Ключ i18n підпису стану (стани складника мають пріоритет над однойменними станами інших родин). */
export function stateLabelKey(state: StateBadgeProps["state"]): string {
  if ((COMPONENT_STATES as readonly string[]).includes(state)) return financeLabelKeys.state(state as ComponentState);
  if ((ORDER_FINANCE_STATES as readonly string[]).includes(state)) return financeLabelKeys.orderState(state as OrderFinanceState);
  return financeLabelKeys.profitState(state as ProfitState);
}

export function StateBadge({ state, reason, basis, size = "sm" }: StateBadgeProps) {
  const ft = useFinanceUiT();
  const presentation = STATE_PRESENTATION[state] ?? STATE_PRESENTATION["n/a"];
  const label = ft(stateLabelKey(state));
  const details = [reason ? ft(financeLabelKeys.reason(reason)) : null, basis ? ft(financeLabelKeys.basis(basis)) : null].filter(
    (d): d is string => Boolean(d),
  );
  return (
    <span className={cx("ot-state", `ot-state--${size}`)} data-state={state}>
      <Badge tone={presentation.tone} size={size} title={details.length > 0 ? `${label} · ${details.join(" · ")}` : label}>
        <FinanceIcon name={presentation.icon} />
        <span className="ot-state__label">{label}</span>
      </Badge>
      {details.length > 0 ? <span className="ot-state__detail">{details.join(" · ")}</span> : null}
    </span>
  );
}

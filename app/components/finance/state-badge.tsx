/** Етап 6 (заглушка ядра → WP0-UI): бейдж стану (значок + текст, не лише колір). */
import { COMPONENT_STATES, ORDER_FINANCE_STATES, type ComponentState, type OrderFinanceState, type ProfitState } from "~/domain/finance";
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Badge } from "~/ui";
import type { StateBadgeProps } from "./contracts";

export function stateLabelKey(state: StateBadgeProps["state"]): string {
  if ((COMPONENT_STATES as readonly string[]).includes(state)) return financeLabelKeys.state(state as ComponentState);
  if ((ORDER_FINANCE_STATES as readonly string[]).includes(state)) return financeLabelKeys.orderState(state as OrderFinanceState);
  return financeLabelKeys.profitState(state as ProfitState);
}

export function StateBadge({ state, reason, size = "sm" }: StateBadgeProps) {
  const t = useT();
  const tone = state === "actual" || state === "final" ? "strong" : state === "missing" || state === "incomplete" ? "warning" : "outline";
  return (
    <Badge tone={tone} size={size} title={reason ? t(financeLabelKeys.reason(reason)) : undefined}>
      {t(stateLabelKey(state))}
    </Badge>
  );
}

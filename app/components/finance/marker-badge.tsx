/**
 * Етап 6, WP0-UI: маркер повноти показника (§2.6): «Повні дані» / «З прогнозом» / «Неповні дані» — значок + текст.
 * Використовується в плитці (`KpiTile`) і банері повноти; сторінки можуть ставити його біля будь-якого підсумку.
 */
import type { CompletenessMarker } from "~/domain/finance";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Badge } from "~/ui";
import { useFinanceUiT } from "./i18n";
import { FinanceIcon, MARKER_PRESENTATION } from "./icons";

export interface MarkerBadgeProps {
  marker: CompletenessMarker;
  size?: "sm" | "md";
}

export function MarkerBadge({ marker, size = "sm" }: MarkerBadgeProps) {
  const ft = useFinanceUiT();
  const p = MARKER_PRESENTATION[marker];
  return (
    <span className="ot-marker" data-marker={marker}>
      <Badge tone={p.tone} size={size}>
        <FinanceIcon name={p.icon} />
        <span>{ft(financeLabelKeys.completeness(marker))}</span>
      </Badge>
    </span>
  );
}

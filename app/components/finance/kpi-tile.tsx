/** Етап 6 (заглушка ядра → WP0-UI): плитка показника — факт, «≈ Прогноз» окремо, маркер повноти, покриття. */
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Card, Stack, Text } from "~/ui";
import type { KpiTileProps } from "./contracts";
import { CoverageNote } from "./coverage-note";
import { MoneyValue } from "./money-value";

export function KpiTile({ id, title, value, forecast, marker, coverage, note }: KpiTileProps) {
  const t = useT();
  return (
    <Card title={title}>
      <Stack gap={1} align="start">
        <span id={`kpi-${id}`}>
          <MoneyValue value={value} emphasis="strong" />
        </span>
        {forecast !== undefined ? <MoneyValue value={forecast} forecast /> : null}
        <Text as="span" variant="caption">
          {t(financeLabelKeys.completeness(marker))}
        </Text>
        {coverage ? <CoverageNote {...coverage} /> : null}
        {note ? (
          <Text as="span" variant="caption" tone="subdued">
            {note}
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}

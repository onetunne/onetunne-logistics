/** Етап 6 (заглушка ядра → WP0-UI): рядок покриття «за N з M замовлень». */
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Text } from "~/ui";
import type { CoverageNoteProps } from "./contracts";

export function CoverageNote({ n, m, kind = "orders" }: CoverageNoteProps) {
  const t = useT();
  return (
    <Text as="span" variant="caption" tone="subdued">
      {t(financeLabelKeys.coverage(kind), { n, m })}
    </Text>
  );
}

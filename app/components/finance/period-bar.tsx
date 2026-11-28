/** Етап 6 (заглушка ядра → WP0-UI): вибір періоду (шаблони, довільний, відрізок, порівняння) — форма GET. */
import { Form } from "react-router";
import { PERIOD_PRESETS } from "~/lib/periods";
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Button, Select, Stack } from "~/ui";
import type { PeriodBarProps } from "./contracts";

export function PeriodBar({ preset, presets = PERIOD_PRESETS, paramPrefix = "" }: PeriodBarProps) {
  const t = useT();
  return (
    <Form method="get" preventScrollReset>
      <Stack gap={2}>
        <Select
          label={t(financeLabelKeys.period("custom"))}
          labelHidden
          name={`${paramPrefix}period`}
          defaultValue={preset}
          options={presets.map((p) => ({ value: p, label: t(financeLabelKeys.period(p)) }))}
        />
        <Button type="submit" variant="secondary">
          {t("common.apply")}
        </Button>
      </Stack>
    </Form>
  );
}

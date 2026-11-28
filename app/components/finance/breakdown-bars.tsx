/** Етап 6 (заглушка ядра → WP0-UI): розбивка за складниками. Заглушка — список значень. */
import { useLocale } from "~/i18n";
import { formatMoney } from "~/lib/format";
import type { BreakdownBarsProps } from "./contracts";

export function BreakdownBars({ rows, currency }: BreakdownBarsProps) {
  const locale = useLocale();
  return (
    <ul className="ot-finance-breakdown">
      {rows.map((r) => (
        <li key={r.key}>
          {r.label}: {r.value ? formatMoney(r.value, currency, locale) : "—"}
        </li>
      ))}
    </ul>
  );
}

/** Етап 6 (заглушка ядра → WP0-UI): графік прибутку (факт / ≈ прогноз) з «Показати таблицею». Заглушка — таблиця. */
import { useLocale } from "~/i18n";
import { formatMoney } from "~/lib/format";
import type { ProfitChartProps } from "./contracts";

export function ProfitChart({ buckets, currency, tableCaption }: ProfitChartProps) {
  const locale = useLocale();
  return (
    <table className="ot-finance-table">
      <caption>{tableCaption}</caption>
      <tbody>
        {buckets.map((b) => (
          <tr key={b.key}>
            <th scope="row">{b.label}</th>
            <td>{b.actual ? formatMoney(b.actual, currency, locale) : "—"}</td>
            <td>{b.forecast ? `≈ ${formatMoney(b.forecast, currency, locale)}` : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

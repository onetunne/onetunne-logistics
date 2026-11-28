/**
 * Етап 6, WP0-UI: розбивка (витрат) за складниками (§18.3 «Витрати … % чистої виручки»): рядок — назва, тонка смуга
 * (одна гама; довжина — частка найбільшого за модулем рядка), сума, частка `total` (чиста виручка) і значок стану.
 * Прогноз — смуга зі штрихуванням і «≈» біля суми; від'ємне значення — контурна смуга; відсутнє — «—» без смуги
 * (НІКОЛИ не 0). `total` — знаменник часток (чиста виручка), не сума рядків: undefined — без стовпця часток; null або
 * ≤ 0 — частки «—» з поясненням.
 */
import { useLocale, useT } from "~/i18n";
import { formatPercent } from "~/lib/format";
import { cx } from "~/ui";
import type { BreakdownBarsProps } from "./contracts";
import { DASH, barPercent, moneyText, parseMinor, sharePercent } from "./format-ui";
import { StateBadge } from "./state-badge";

export function BreakdownBars({ rows, currency, total }: BreakdownBarsProps) {
  const ft = useT();
  const locale = useLocale();
  const values = rows.map((r) => parseMinor(r.value));
  let max = 0n;
  for (const v of values) {
    if (v === null) continue;
    const a = v < 0n ? -v : v;
    if (a > max) max = a;
  }
  const withShare = total !== undefined;
  const totalKnown = withShare && (parseMinor(total) ?? 0n) > 0n;
  return (
    <div className="ot-breakdown">
      {withShare ? (
        <p className="ot-breakdown__head">
          <span>{ft("financeUi.breakdown.share")}</span>
        </p>
      ) : null}
      <ul className="ot-breakdown__list">
        {rows.map((r, i) => {
          const v = values[i] ?? null;
          const amount = moneyText(r.value, currency, locale);
          const forecast = r.state === "forecast";
          const share = withShare ? formatPercent(sharePercent(r.value, total), locale) : null;
          const width = barPercent(v, max);
          return (
            <li
              key={r.key}
              className={cx("ot-breakdown__row", forecast && "is-forecast", v !== null && v < 0n && "is-negative", v === null && "is-missing")}
              data-key={r.key}
              data-value={r.value ?? ""}
            >
              <span className="ot-breakdown__label">{r.label}</span>
              <span className="ot-breakdown__amount ot-text--numeric">{amount !== DASH && forecast ? `≈ ${amount}` : amount}</span>
              {share !== null ? <span className="ot-breakdown__share ot-text--numeric">{share}</span> : null}
              <span className="ot-breakdown__track" aria-hidden="true">
                {width > 0 ? <span className="ot-breakdown__bar" style={{ width: `${width}%` }} /> : null}
              </span>
              {r.state && r.state !== "actual" ? (
                <span className="ot-breakdown__state">
                  <StateBadge state={r.state} />
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
      {withShare ? (
        <p className="ot-breakdown__note">
          {totalKnown ? ft("financeUi.breakdown.shareOf", { total: moneyText(total, currency, locale) }) : ft("financeUi.breakdown.noShare")}
        </p>
      ) : null}
    </div>
  );
}

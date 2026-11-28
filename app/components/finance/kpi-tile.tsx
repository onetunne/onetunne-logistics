/**
 * Етап 6, WP0-UI: плитка показника (§18.3): назва (посилання, якщо є `href`), значення (факт; null — «—»), за потреби
 * окремим рядком «≈ Прогноз» (ніколи не в факті, F5), маркер повноти зі значком, зміна до періоду порівняння (стрілка +
 * слова), рядок покриття, примітка, міні-графік, розгортання «Чого бракує» з посиланнями й «Як порахувано».
 *
 * Пропси — `KpiTileProps` з contracts.ts; додаткові необов'язкові пропси WP0-UI (`KpiTileExtraProps`) не змінюють
 * контракт: текст «Як порахувано» і напрям «менше — добре» для витрат.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";
import { useLocale } from "~/i18n";
import { formatDecimal } from "~/lib/format";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { Card, Disclosure, Text, VisuallyHidden, cx } from "~/ui";
import type { KpiTileProps } from "./contracts";
import { CoverageNote } from "./coverage-note";
import { DASH, signOf, signedMoneyText, signedPercentText } from "./format-ui";
import { useFinanceUiT } from "./i18n";
import { MarkerBadge } from "./marker-badge";
import { MoneyValue } from "./money-value";
import { Sparkline } from "./sparkline";

export interface KpiTileExtraProps {
  /** Розгортання «Як порахувано» (формула з §2, текст сторінки). */
  explanation?: ReactNode;
  /** Для витрат: «менше — добре» біля зміни. Типово — без оцінки напряму. */
  deltaPreference?: "higher" | "lower";
  /** Підпис бази зміни (типово «до періоду порівняння»), напр. «до попередніх 30 днів». */
  deltaLabel?: string;
}

export type DeltaDirection = "up" | "down" | "flat" | "unknown";

/** Напрям зміни: за знаком відсотка, інакше — за знаком суми; обидва невідомі → unknown. */
export function deltaDirection(delta: NonNullable<KpiTileProps["delta"]>): DeltaDirection {
  const s = delta.percent !== null ? signOf(delta.percent) : delta.amount ? signOf(delta.amount.amount) : null;
  if (s === null) return "unknown";
  return s > 0 ? "up" : s < 0 ? "down" : "flat";
}

const ARROWS: Readonly<Record<DeltaDirection, string>> = { up: "▲", down: "▼", flat: "=", unknown: "" };

export function KpiTile({
  id,
  title,
  value,
  forecast,
  marker,
  coverage,
  delta,
  missing,
  sparkline,
  href,
  note,
  explanation,
  deltaPreference,
  deltaLabel,
}: KpiTileProps & KpiTileExtraProps) {
  const ft = useFinanceUiT();
  const locale = useLocale();
  const withForecast = forecast !== undefined;
  const missingItems = (missing ?? []).filter((m) => m.count > 0);
  const direction = delta ? deltaDirection(delta) : null;
  return (
    <Card
      className={cx("ot-kpi", `ot-kpi--${marker}`)}
      title={href ? <Link to={href}>{title}</Link> : title}
      actions={<MarkerBadge marker={marker} />}
    >
      <div className="ot-kpi__body" data-kpi={id}>
        <div className="ot-kpi__values">
          <p className="ot-kpi__row">
            {withForecast ? <span className="ot-kpi__label">{ft(financeLabelKeys.state("actual"))}</span> : null}
            <span id={`kpi-${id}`} className="ot-kpi__value">
              <MoneyValue value={value} emphasis="strong" />
            </span>
          </p>
          {withForecast ? (
            <p className="ot-kpi__row ot-kpi__row--forecast">
              <span className="ot-kpi__label">{`≈ ${ft(financeLabelKeys.state("forecast"))}`}</span>
              <span id={`kpi-${id}-forecast`} className="ot-kpi__value ot-kpi__value--forecast">
                <MoneyValue value={forecast ?? null} />
              </span>
            </p>
          ) : null}
        </div>
        {delta && direction ? (
          <p className="ot-kpi__delta" data-direction={direction}>
            {direction === "unknown" ? (
              <span>{ft("financeUi.delta.unknown")}</span>
            ) : (
              <>
                <span className="ot-kpi__arrow" aria-hidden="true">
                  {ARROWS[direction]}
                </span>
                <VisuallyHidden>{`${ft(`financeUi.delta.${direction}`)}: `}</VisuallyHidden>
                <span className="ot-text--numeric">
                  {delta.percent !== null ? signedPercentText(delta.percent, locale) : DASH}
                  {" · "}
                  {delta.amount ? signedMoneyText(delta.amount.amount, delta.amount.currency, locale) : DASH}
                </span>{" "}
                <span className="ot-kpi__delta-base">{deltaLabel ?? ft("financeUi.delta.vsComparison")}</span>
                {deltaPreference === "lower" ? <span className="ot-kpi__delta-hint">{` · ${ft("financeUi.delta.lowerIsBetter")}`}</span> : null}
              </>
            )}
          </p>
        ) : null}
        {coverage ? (
          <p className="ot-kpi__coverage">
            <CoverageNote {...coverage} />
          </p>
        ) : null}
        {note ? (
          <Text as="p" variant="caption" tone="subdued">
            {note}
          </Text>
        ) : null}
        {sparkline && sparkline.length > 0 ? <Sparkline points={sparkline} label={ft("financeUi.kpi.trend", { title })} /> : null}
        {missingItems.length > 0 ? (
          <Disclosure className="ot-kpi__more" summary={ft("financeUi.kpi.missing")}>
            <ul className="ot-kpi__missing">
              {missingItems.map((m, i) => {
                const text = `${ft(m.labelKey)}: ${formatDecimal(m.count, locale, { maximumFractionDigits: 0 })}`;
                return <li key={`${m.labelKey}:${i}`}>{m.href ? <Link to={m.href}>{text}</Link> : text}</li>;
              })}
            </ul>
          </Disclosure>
        ) : null}
        {explanation ? (
          <Disclosure className="ot-kpi__more" summary={ft("financeUi.kpi.explanation")}>
            <div className="ot-kpi__explanation">{explanation}</div>
          </Disclosure>
        ) : null}
      </div>
    </Card>
  );
}

/**
 * Етап 6, WP0-UI: сума у валюті звітності (§18.9) + початкові суми підрядком (у валютах записів) + підказка з курсом.
 * Відсутнє (null, пошкоджене) — «—» з текстом «Немає даних» для читачів екрана, НІКОЛИ не 0 (F4). Будь-яке число з
 * прогнозом має «≈» і підпис «Прогноз» (F5): `forecast` або стан `forecast`.
 */
import { type Locale, type TFunction, useLocale, useT } from "~/i18n";
import { formatIsoDate } from "~/lib/format";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { cx, VisuallyHidden } from "~/ui";
import type { MoneyAmount, MoneyValueProps, RateHint } from "./contracts";
import { DASH, moneyText, parseMinor } from "./format-ui";

/** Текст підказки курсу; гривня (`base`) — без підказки. */
export function rateHintText(rate: RateHint | null | undefined, ft: TFunction, locale: Locale): string | null {
  if (!rate || rate.source === "base") return null;
  const params = { source: ft(financeLabelKeys.rateSource(rate.source)), date: formatIsoDate(rate.rateDate, locale) };
  return ft(rate.fallback ? "financeUi.rate.fallbackOnDate" : "financeUi.rate.onDate", params);
}

/** Початкові суми, якщо вони щось додають: одна сума в тій самій валюті й на ту саму суму — не дублюється. */
function originalsToShow(value: MoneyAmount | null, original: readonly MoneyAmount[] | undefined): readonly MoneyAmount[] {
  if (!original || original.length === 0) return [];
  if (value && original.length === 1) {
    const only = original[0]!;
    const a = parseMinor(only.amount);
    if (only.currency === value.currency && a !== null && a === parseMinor(value.amount)) return [];
  }
  return original;
}

export function MoneyValue({ value, original, state, rate, forecast, emphasis = "default" }: MoneyValueProps) {
  const ft = useT();
  const locale = useLocale();
  const text = value ? moneyText(value.amount, value.currency, locale) : DASH;
  const known = text !== DASH;
  const isForecast = forecast === true || state === "forecast";
  const stateLabel = state ? ft(financeLabelKeys.state(state)) : isForecast ? ft(financeLabelKeys.state("forecast")) : null;
  const originals = originalsToShow(known ? value : null, original);
  const hint = rateHintText(rate, ft, locale);
  return (
    <span
      className={cx("ot-money", emphasis === "strong" && "ot-money--strong", isForecast && "ot-money--forecast", !known && "ot-money--missing")}
      data-state={state ?? (isForecast ? "forecast" : undefined)}
    >
      <span className="ot-money__amount ot-text--numeric">
        {known && isForecast ? "≈ " : ""}
        {text}
      </span>
      {stateLabel ? <span className="ot-money__state">{stateLabel}</span> : null}
      {!known && !stateLabel ? <VisuallyHidden>{ft(financeLabelKeys.state("missing"))}</VisuallyHidden> : null}
      {originals.length > 0 ? (
        <span className="ot-money__original ot-text--numeric">
          <VisuallyHidden>{`${ft("financeUi.money.originalLabel")} `}</VisuallyHidden>
          {originals.map((o) => moneyText(o.amount, o.currency, locale)).join(" · ")}
        </span>
      ) : null}
      {hint ? <span className="ot-money__rate">{hint}</span> : null}
    </span>
  );
}

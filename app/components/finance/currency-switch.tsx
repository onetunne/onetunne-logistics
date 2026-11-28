/**
 * Етап 6, WP0-UI: перемикач валюти показу (§18.3 «Валюта [UAH · EUR · USD · …]») — посилання `?currency=` (параметр
 * запиту, не зберігається), решта параметрів сторінки лишається; поточна — `aria-current`. Цілі дотику ≥ 44 px на
 * телефоні (styles.css). Невідомий поточний код теж показується (сторінка вирішує, що з ним робити).
 * Підпис «Валюта показу» — завжди як aria-label; видимий — лише з `showLabel` (сторінки часто мають власний підпис).
 */
import { Link, useLocation } from "react-router";
import { cx } from "~/ui";
import type { CurrencySwitchProps } from "./contracts";
import { useFinanceUiT } from "./i18n";

/** Посилання на ту саму сторінку з іншою валютою (інші параметри запиту зберігаються). */
export function currencyHref(pathname: string, search: string, paramName: string, currency: string): string {
  const params = new URLSearchParams(search);
  params.set(paramName, currency);
  return `${pathname}?${params.toString()}`;
}

export interface CurrencySwitchExtraProps {
  /** Показати підпис «Валюта показу» перед перемикачем. */
  showLabel?: boolean;
}

export function CurrencySwitch({ current, options, paramName = "currency", showLabel = false }: CurrencySwitchProps & CurrencySwitchExtraProps) {
  const ft = useFinanceUiT();
  const location = useLocation();
  const list = options.includes(current) ? options : [current, ...options];
  const label = ft("financeUi.currency.label");
  return (
    <nav className="ot-currency-switch" aria-label={label}>
      {showLabel ? (
        <span className="ot-currency-switch__label" aria-hidden="true">
          {label}
        </span>
      ) : null}
      <ul className="ot-currency-switch__list">
        {list.map((c) => {
          const selected = c === current;
          return (
            <li key={c}>
              <Link
                to={currencyHref(location.pathname, location.search, paramName, c)}
                className={cx("ot-currency-switch__link", selected && "is-selected")}
                aria-current={selected ? "true" : undefined}
                preventScrollReset
              >
                {c}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

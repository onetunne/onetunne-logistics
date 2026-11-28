/** Етап 6 (заглушка ядра → WP0-UI): перемикач валюти показу (?currency=, не зберігається). */
import { Link, useLocation } from "react-router";
import { Stack } from "~/ui";
import type { CurrencySwitchProps } from "./contracts";

export function CurrencySwitch({ current, options, paramName = "currency" }: CurrencySwitchProps) {
  const location = useLocation();
  const href = (c: string) => {
    const params = new URLSearchParams(location.search);
    params.set(paramName, c);
    return `${location.pathname}?${params.toString()}`;
  };
  return (
    <Stack gap={2}>
      {options.map((c) => (
        <Link key={c} to={href(c)} aria-current={c === current ? "true" : undefined} preventScrollReset>
          {c}
        </Link>
      ))}
    </Stack>
  );
}

import { Form, useLocation, useRouteLoaderData } from "react-router";
import { useLocale, useT } from "~/i18n";
import { useShell } from "./shell";

/** Перемикачі мови, теми та (у демо) ролі. Працюють без JavaScript (звичайні форми). */
export function ShellControls() {
  const t = useT();
  const locale = useLocale();
  const shell = useShell();
  const location = useLocation();
  const root = useRouteLoaderData("root") as { theme?: string } | undefined;
  const redirectTo = location.pathname + location.search;

  const choice = (intent: string, current: string, options: { value: string; label: string }[], label: string) => (
    <Form method="post" action="/preferences" className="ot-pref-form" aria-label={label}>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="redirectTo" value={redirectTo} />
      <span className="ot-pref-label">{label}</span>
      <span className="ot-segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="submit"
            name="value"
            value={o.value}
            className="ot-segmented__item"
            aria-pressed={current === o.value}
          >
            {o.label}
          </button>
        ))}
      </span>
    </Form>
  );

  return (
    <div className="ot-shell-controls">
      {shell.mode === "demo"
        ? choice(
            "demoRole",
            shell.actor.role,
            [
              { value: "owner", label: t("role.owner") },
              { value: "staff", label: t("role.staff") },
            ],
            t("demo.role.label"),
          )
        : null}
      {choice(
        "locale",
        locale,
        [
          { value: "uk", label: "UA" },
          { value: "en", label: "EN" },
        ],
        t("language.label"),
      )}
      {choice(
        "theme",
        root?.theme ?? "system",
        [
          { value: "system", label: t("theme.system") },
          { value: "light", label: t("theme.light") },
          { value: "dark", label: t("theme.dark") },
        ],
        t("theme.label"),
      )}
    </div>
  );
}

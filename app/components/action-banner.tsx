import { useLocale, useT } from "~/i18n";
import { localizeParams } from "~/i18n/localize";
import { Banner } from "~/ui";

/** Стандартна відповідь дії: { ok: true, message, params } або { ok: false, error, params, fieldErrors }. */
export type ActionResult =
  | { ok: true; message: string; params?: Record<string, string | number>; extra?: string[]; tone?: "success" | "info" | "warning" | "critical" }
  | { ok: false; error: string; params?: Record<string, string | number>; fieldErrors?: Record<string, string> };

/** Показує результат останньої дії (успіх/помилка) зрозумілою мовою. */
export function ActionBanner({ data }: { data: ActionResult | undefined | null }) {
  const t = useT();
  const locale = useLocale();
  if (!data) return null;
  const params = localizeParams(data.params, t, locale);
  if (data.ok) {
    return (
      <Banner tone={data.tone ?? "success"}>
        <p>{t(data.message, params)}</p>
        {data.extra?.map((key) => (
          <p key={key}>{t(key, params)}</p>
        ))}
      </Banner>
    );
  }
  return (
    <Banner tone="critical" title={t("error.title")}>
      {t(data.error, params)}
    </Banner>
  );
}

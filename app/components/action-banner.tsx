import { useT } from "~/i18n";
import { Banner } from "~/ui";

/** Стандартна відповідь дії: { ok: true, message, params } або { ok: false, error, params, fieldErrors }. */
export type ActionResult =
  | { ok: true; message: string; params?: Record<string, string | number>; extra?: string[]; tone?: "success" | "info" | "warning" | "critical" }
  | { ok: false; error: string; params?: Record<string, string | number>; fieldErrors?: Record<string, string> };

/** Показує результат останньої дії (успіх/помилка) зрозумілою мовою. */
export function ActionBanner({ data }: { data: ActionResult | undefined | null }) {
  const t = useT();
  if (!data) return null;
  if (data.ok) {
    return (
      <Banner tone={data.tone ?? "success"}>
        <p>{t(data.message, data.params)}</p>
        {data.extra?.map((key) => (
          <p key={key}>{t(key, data.params)}</p>
        ))}
      </Banner>
    );
  }
  return (
    <Banner tone="critical" title={t("error.title")}>
      {t(data.error, data.params)}
    </Banner>
  );
}

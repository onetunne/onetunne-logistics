/**
 * Контракт ресурсного маршруту CSV-експорту (чистий модуль: використовують і сервер, і сторінка в браузері):
 * ліміт рядків, службові заголовки відповіді й розбір відповіді на сторінці перед збереженням файлу.
 */

/** Найбільше рядків історії руху в одному файлі (більше → файл обрізано, заголовок X-Export-Truncated: 1). */
export const MAX_EXPORT_MOVEMENTS = 50_000;

/** Службові заголовки відповіді warehouse/export. */
export const EXPORT_HEADERS = {
  rows: "X-Export-Rows",
  /** "1" — у файл потрапили не всі рядки (лише перші MAX_EXPORT_MOVEMENTS за часом). */
  truncated: "X-Export-Truncated",
  withCosts: "X-Export-With-Costs",
} as const;

export type ExportResponseOutcome =
  | { ok: true; truncated: boolean; rows: number | null }
  /** error — ключ i18n для показу людині. */
  | { ok: false; error: string };

type ResponseLike = Pick<Response, "type" | "redirected" | "status" | "ok" | "headers">;

/**
 * Відповідь маршруту → що показати: помилка (сесія, права, збій) або файл (з ознакою «обрізано», яку сторінка
 * МАЄ показати людині — інакше неповна історія виглядала б повною).
 * У вбудованому застосунку завершена сесія повертає перенаправлення або не-CSV сторінку — це «сесія завершилася».
 */
export function exportResponseOutcome(response: ResponseLike): ExportResponseOutcome {
  if (response.type === "opaqueredirect" || response.redirected || response.status === 401) {
    return { ok: false, error: "warehouseAnalytics.export.error.session" };
  }
  if (response.status === 403) return { ok: false, error: "warehouseAnalytics.export.error.forbidden" };
  if (!response.ok) return { ok: false, error: "warehouseAnalytics.export.error.generic" };
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "text/csv") return { ok: false, error: "warehouseAnalytics.export.error.session" };
  const rowsRaw = response.headers.get(EXPORT_HEADERS.rows);
  return {
    ok: true,
    truncated: response.headers.get(EXPORT_HEADERS.truncated) === "1",
    rows: rowsRaw && /^\d{1,9}$/.test(rowsRaw) ? Number(rowsRaw) : null,
  };
}

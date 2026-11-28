/**
 * Етап 6, WP10: ресурсний маршрут експорту фінансів (CSV/XLSX, §13.2) …/finance/export. Лише GET; finance.view + роль
 * owner у loader і повторно в сервісі експорту.
 * ЗАГЛУШКА ядра (раунд 0) — далі належить WP10: доступ остаточний (працівник → 403), експорт ще не реалізовано (501).
 */
import type { LoaderFunctionArgs } from "react-router";
import { translate, type Locale } from "~/i18n";
import { canFinance } from "~/modules/finance/core/access.server";
import { financeLabelKeys, type FinanceErrorCode } from "~/modules/finance/core/labels";
import { getRequestContext } from "~/server/context.server";

function text(locale: Locale, status: number, code: FinanceErrorCode): Response {
  return new Response(translate(locale, financeLabelKeys.error(code)), {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Export-Error": financeLabelKeys.error(code),
    },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!canFinance(ctx.actor, "view")) return text(ctx.locale, 403, "forbidden");
  return text(ctx.locale, 501, "notImplemented");
}

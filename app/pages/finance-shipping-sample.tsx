/**
 * Етап 6, WP5: ресурсний маршрут …/finance/shipping/sample?format=csv|xlsx — вигаданий зразок файла рахунку для імпорту
 * (§19 п. 9). ЛИШЕ демо (404 у робочому режимі) і finance.view + роль owner. Лише GET.
 * ЗАГЛУШКА ядра (раунд 0) — далі належить WP5: доступ остаточний, файл ще не формується (501).
 */
import type { LoaderFunctionArgs } from "react-router";
import { translate, type Locale } from "~/i18n";
import { canFinance } from "~/modules/finance/core/access.server";
import { financeLabelKeys, type FinanceErrorCode } from "~/modules/finance/core/labels";
import { getRequestContext } from "~/server/context.server";

function text(locale: Locale, status: number, code: FinanceErrorCode): Response {
  return new Response(translate(locale, financeLabelKeys.error(code)), {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (ctx.mode !== "demo") throw new Response("Not Found", { status: 404 });
  if (!canFinance(ctx.actor, "view")) return text(ctx.locale, 403, "forbidden");
  return text(ctx.locale, 501, "notImplemented");
}

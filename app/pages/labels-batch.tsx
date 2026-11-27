/**
 * Ресурсний маршрут: етикетки перевізника для вибраних замовлень черги, об'єднані в один PDF
 * (…/picking/labels?ids=<uuid>&ids=<uuid>…). Авторизація — як у сторінок (getRequestContext: /app → Shopify,
 * /demo → демо); дозволи — packing.perform + orders.view (як документи замовлення). Нічого не змінює.
 *
 * Відповідь:
 * - 200 application/pdf — об'єднаний документ; заголовки X-OT-Labels-Included (кількість етикеток) і
 *   X-OT-Labels-Skipped (JSON [{ n: номер замовлення, r: причина }], URL-кодування) — пропущені замовлення;
 * - 409 application/json { error, skipped } — жодної етикетки не додано (напр. тестовий перевізник демо
 *   документів не створює — причина not_supported);
 * - 400 — не вибрано замовлень; 403 — немає дозволу.
 * У вбудованому застосунку документ завантажується через fetch (App Bridge додає токен сесії).
 */
import type { LoaderFunctionArgs } from "react-router";
import { ForbiddenError } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import { MAX_LABEL_ORDERS } from "~/modules/packing/constants";
import { mergeCarrierLabels } from "~/modules/packing/documents.server";
import { parseOrderIds } from "~/modules/packing/queue-filters";
import { getRequestContext } from "~/server/context.server";
import { isSameOrigin } from "~/server/http.server";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function kyivStamp(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  return parts.replace(/-/g, "");
}

export async function loader({ request }: LoaderFunctionArgs) {
  if (!isSameOrigin(request)) return json(403, { error: "error.forbidden" });
  const ctx = await getRequestContext(request);
  const ids = parseOrderIds(new URL(request.url).searchParams.getAll("ids"), MAX_LABEL_ORDERS);
  if (ids.length === 0) return json(400, { error: "packing.bulk.noneSelected", skipped: [] });
  try {
    const result = await mergeCarrierLabels(ctx, ids);
    const skipped = result.skipped.map((s) => ({ n: s.orderNumber, r: s.reason }));
    if (!result.pdf) return json(409, { error: "packing.labels.noneAvailable", skipped });
    return new Response(new Blob([new Uint8Array(result.pdf)], { type: "application/pdf" }), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="labels-${kyivStamp(ctx.now())}.pdf"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-OT-Labels-Included": String(result.included.length),
        "X-OT-Labels-Skipped": encodeURIComponent(JSON.stringify(skipped)),
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return json(403, { error: "error.forbidden" });
    logger.error("packing.labels_unexpected_error", { error: e });
    return json(500, { error: "packing.labels.error.generic" });
  }
}

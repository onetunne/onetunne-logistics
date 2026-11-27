/**
 * Ресурсний маршрут: CSV-експорт складу (…/warehouse/export?dataset=stock|movements|sales&sep=semicolon|comma
 * &period=7|30|90|custom&from=&to=&model=&color=&product=). Лише читання (GET) — нічого не змінює, окрім запису
 * в журналі про експорт.
 * Авторизація — як у сторінок (getRequestContext: /app → Shopify, /demo → демо); дозвіл warehouse.view, колонки
 * собівартості — лише finance.view (перевіряє modules/warehouse-analytics/export.server.ts).
 * У вбудованому застосунку файл завантажується через fetch (App Bridge додає токен сесії) — див. warehouse-analytics.tsx.
 */
import type { LoaderFunctionArgs } from "react-router";
import { can, ForbiddenError } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { resolvePeriod } from "~/modules/warehouse-analytics/calc";
import { CSV_CONTENT_TYPE } from "~/modules/warehouse-analytics/csv";
import { EXPORT_HEADERS } from "~/modules/warehouse-analytics/export-contract";
import { exportWarehouseCsv } from "~/modules/warehouse-analytics/export.server";
import { filtersOf, parseAnalyticsQuery, parseExportParams } from "~/modules/warehouse-analytics/params";
import { businessDate } from "~/modules/warehouse/dates";
import { getRequestContext } from "~/server/context.server";

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) return text(403, "Forbidden");
  const url = new URL(request.url);
  const { dataset, separator } = parseExportParams(url.searchParams);
  if (!dataset) return text(400, "warehouseAnalytics.export.error.dataset");
  const query = parseAnalyticsQuery(url.searchParams);
  const period = resolvePeriod({ key: query.period, from: query.from, to: query.to, today: businessDate(ctx.now()) });
  if (period.invalid) return text(400, "warehouseAnalytics.export.error.period");
  try {
    const csv = await exportWarehouseCsv(ctx, { dataset, separator, period, filters: filtersOf(query) });
    return new Response(csv.content, {
      status: 200,
      headers: {
        "Content-Type": CSV_CONTENT_TYPE,
        "Content-Disposition": `attachment; filename="${csv.fileName}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        // Обрізаний файл (лише movements, понад MAX_EXPORT_MOVEMENTS рядків) — сторінка показує попередження.
        [EXPORT_HEADERS.rows]: String(csv.rows),
        [EXPORT_HEADERS.truncated]: csv.truncated ? "1" : "0",
        [EXPORT_HEADERS.withCosts]: csv.withCosts ? "1" : "0",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return text(403, "Forbidden");
    if (e instanceof DomainError) return text(409, e.code);
    logger.error("warehouse.export_failed", { dataset, error: e });
    return text(500, "error.generic");
  }
}

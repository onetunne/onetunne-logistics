/**
 * Ресурсний маршрут: PDF-документ перевізника для відправлення
 * (…/orders/:orderId/shipments/:shipmentId/documents/:kind, kind = label | invoice | customs_declaration).
 * Авторизація — як у сторінок (getRequestContext: /app → Shopify, /demo → демо).
 * У вбудованому застосунку документ завантажується через fetch (App Bridge додає токен сесії).
 */
import type { LoaderFunctionArgs } from "react-router";
import { ForbiddenError } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { fetchCarrierDocument, isCarrierDocumentKind } from "~/modules/shipments/documents.server";
import { CarrierError } from "~/integrations/carriers/types";
import { getRequestContext } from "~/server/context.server";

function text(status: number, message: string): Response {
  return new Response(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  const kind = params.kind ?? "";
  if (!isCarrierDocumentKind(kind) || !params.orderId || !params.shipmentId) return text(404, "Not Found");
  try {
    const doc = await fetchCarrierDocument(ctx, params.orderId, params.shipmentId, kind);
    return new Response(new Blob([new Uint8Array(doc.content)], { type: doc.contentType }), {
      status: 200,
      headers: {
        "Content-Type": doc.contentType,
        "Content-Disposition": `inline; filename="${doc.fileName.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return text(403, "Forbidden");
    if (e instanceof NotFoundError) return text(404, "Not Found");
    if (e instanceof DomainError) return text(409, e.code);
    if (e instanceof CarrierError) {
      logger.warn("document.carrier_error", { kind: e.kind, carrier: e.carrier, error: e });
      return text(e.kind === "rejected" ? 409 : 503, `carrier.${e.kind}`);
    }
    logger.error("document.unexpected_error", { error: e });
    return text(500, "error.generic");
  }
}

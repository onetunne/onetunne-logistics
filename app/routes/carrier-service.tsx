import type { ActionFunctionArgs } from "react-router";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyCarrierServiceToken, isCarrierServiceTokenFormat } from "~/modules/rates/carrier-service.server";
import { computeCheckoutRates, parseRateRequest } from "~/modules/rates/checkout-rates.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";

/**
 * Callback Shopify CarrierService: POST /carrier-service/:token → { rates: [...] }.
 *
 * Shopify викликає адресу сервер-сервер, без сесії й без підпису (HMAC для CarrierService НЕ задокументований),
 * тому authenticate.admin тут немає; доступ — лише за секретним токеном у шляху (carrier-service.server.ts).
 * Перевірка Origin React Router на ресурсні маршрути не поширюється, а запит без заголовка Origin
 * не відхиляється і для сторінок (як і /webhooks/shopify).
 *
 * Коди: 404 — демо / Shopify не налаштовано / неправильний токен (без деталей); 405 — не POST; 413 — тіло > 256 КБ;
 * 400 — не JSON або не та структура; 503 — помилка перевізника чи внутрішня (Shopify покаже резервні тарифи);
 * 200 — { rates: [...] } (порожній список — «не можемо розрахувати»).
 */
export const MAX_CARRIER_SERVICE_BODY_BYTES = 256 * 1024;

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };

const status = (code: number, headers?: Record<string, string>) => new Response(null, { status: code, headers });
const json = (body: unknown, code: number) => new Response(JSON.stringify(body), { status: code, headers: JSON_HEADERS });

export function loader() {
  return status(405, { Allow: "POST" });
}

/** Читання тіла з обмеженням розміру (незалежно від Content-Length). null — завелике. */
async function readBodyLimited(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function action({ request, params }: ActionFunctionArgs) {
  if (request.method !== "POST") return status(405, { Allow: "POST" });
  try {
    const env = getEnv();
    const secret = env.SHOPIFY_API_SECRET;
    if (env.DEMO_MODE || !env.shopifyConfigured || !secret) return status(404);
    const token = params.token ?? "";
    if (!isCarrierServiceTokenFormat(token)) return status(404);

    const length = request.headers.get("Content-Length");
    if (length !== null) {
      if (!/^\d{1,12}$/.test(length.trim())) return status(400);
      if (Number(length) > MAX_CARRIER_SERVICE_BODY_BYTES) return status(413);
    }

    const { getProductionRuntime } = await import("~/server/production-runtime.server");
    const runtime = await getProductionRuntime();
    const db = runtime.handle.db;
    const shop = await currentShop(db);
    if (!shop || !verifyCarrierServiceToken(secret, shop.shop, token)) return status(404);

    const raw = await readBodyLimited(request, MAX_CARRIER_SERVICE_BODY_BYTES);
    if (raw === null) return status(413);
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
    } catch {
      return status(400);
    }
    const parsed = parseRateRequest(body);
    if (!parsed.ok) {
      logger.warn("checkout_rates.invalid_request", { issues: parsed.issues });
      return status(400);
    }

    const result = await computeCheckoutRates({ db, carriers: runtime.carriers, now: () => new Date() }, parsed.request);
    return json(result.body, result.status);
  } catch (error) {
    logger.error("checkout_rates.route_failed", { error });
    return json({ rates: [] }, 503);
  }
}

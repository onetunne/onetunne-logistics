import { PassThrough } from "node:stream";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";
import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { getEnv } from "~/lib/env.server";

export const streamTimeout = 5000;

/**
 * Заголовки безпеки. Для вбудованих маршрутів Shopify встановлює CSP frame-ancestors
 * (дозволяє лише Shopify Admin); для демо — заборона вбудовування в iframe.
 */
async function applySecurityHeaders(request: Request, headers: Headers) {
  const { pathname } = new URL(request.url);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  const embedded = pathname.startsWith("/app") || pathname.startsWith("/auth");
  if (embedded && getEnv().shopifyConfigured) {
    const { getShopify } = await import("~/shopify.server");
    (await getShopify()).addDocumentResponseHeaders(request, headers);
  } else {
    headers.set("Content-Security-Policy", "frame-ancestors 'none'");
    headers.set("X-Frame-Options", "DENY");
  }
}

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  reactRouterContext: EntryContext,
) {
  await applySecurityHeaders(request, responseHeaders);
  const callbackName = isbot(request.headers.get("user-agent") ?? "") ? "onAllReady" : "onShellReady";

  return new Promise((resolve, reject) => {
    const { pipe, abort } = renderToPipeableStream(<ServerRouter context={reactRouterContext} url={request.url} />, {
      [callbackName]: () => {
        const body = new PassThrough();
        const stream = createReadableStreamFromReadable(body);
        responseHeaders.set("Content-Type", "text/html; charset=utf-8");
        resolve(new Response(stream, { headers: responseHeaders, status: responseStatusCode }));
        pipe(body);
      },
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        responseStatusCode = 500;
        console.error(error);
      },
    });
    setTimeout(abort, streamTimeout + 1000);
  });
}

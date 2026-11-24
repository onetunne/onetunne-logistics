import { redirect, type LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/lib/env.server";

/**
 * Корінь: Shopify Admin відкриває застосунок з ?shop=… → /app; інакше — демо (якщо увімкнено).
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const env = getEnv();
  if (url.searchParams.get("shop") && env.shopifyConfigured) throw redirect(`/app?${url.searchParams.toString()}`);
  if (env.DEMO_MODE) throw redirect("/demo");
  if (env.shopifyConfigured) throw redirect("/auth/login");
  return new Response("ONE TUNNE Logistics: not configured. See README.md", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

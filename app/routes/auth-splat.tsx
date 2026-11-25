import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { getEnv } from "~/lib/env.server";

export async function loader({ request }: LoaderFunctionArgs) {
  if (!getEnv().shopifyConfigured) throw new Response("Shopify is not configured", { status: 503 });
  const { getShopify } = await import("~/shopify.server");
  await (await getShopify()).authenticate.admin(request);
  return null;
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

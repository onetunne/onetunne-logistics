import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { NavMenu } from "@shopify/app-bridge-react";
import { LayoutBody } from "~/components/layout";
import { getRequestContext } from "~/server/context.server";
import { buildShellData } from "~/server/shell.server";
import { getEnv } from "~/lib/env.server";
import { useT } from "~/i18n";

/** Вбудований режим Shopify Admin: автентифікація завжди через authenticate.admin. */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  return { ...(await buildShellData(ctx)), apiKey: getEnv().SHOPIFY_API_KEY ?? "" };
}

export default function AppLayout() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  return (
    <AppProvider apiKey={data.apiKey}>
      <NavMenu>
        <a href="/app" rel="home">
          {t("nav.dashboard")}
        </a>
        {data.nav
          .filter((n) => n.key !== "dashboard" && !n.planned)
          .map((n) => (
            <a key={n.key} href={n.href}>
              {t(`nav.${n.key}`)}
            </a>
          ))}
      </NavMenu>
      <LayoutBody embedded />
    </AppProvider>
  );
}

// Shopify потребує, щоб React Router перехоплював відповіді з заголовками.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

import type { LinksFunction, LoaderFunctionArgs } from "react-router";
import {
  isRouteErrorResponse,
  Links,
  useLocation,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useRouteError,
  useRouteLoaderData,
} from "react-router";
import stylesHref from "~/ui/styles.css?url";
import { readPreferences } from "~/server/cookies.server";
import { makeT, DEFAULT_LOCALE } from "~/i18n";

export const links: LinksFunction = () => [{ rel: "stylesheet", href: stylesHref }];

export async function loader({ request }: LoaderFunctionArgs) {
  return readPreferences(request);
}

function Document({ children, locale, theme }: { children: React.ReactNode; locale: string; theme: string }) {
  return (
    <html lang={locale} data-theme={theme}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="robots" content="noindex,nofollow" />
        <title>ONE TUNNE Logistics</title>
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const { locale, theme } = useLoaderData<typeof loader>();
  return (
    <Document locale={locale} theme={theme}>
      <Outlet />
    </Document>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const data = useRouteLoaderData<typeof loader>("root");
  const locale = data?.locale ?? DEFAULT_LOCALE;
  const t = makeT(locale);
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const { pathname } = useLocation();
  const home = pathname.startsWith("/app") ? "/app" : pathname.startsWith("/demo") ? "/demo" : "/";
  const message =
    status === 404 ? t("error.notFound") : status === 403 ? t("error.forbidden") : t("error.generic");
  return (
    <Document locale={locale} theme={data?.theme ?? "system"}>
      <main className="ot-error-page">
        <h1>{status}</h1>
        <p>{message}</p>
        <a href={home}>ONE TUNNE Logistics</a>
      </main>
    </Document>
  );
}

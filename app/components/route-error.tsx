import { isRouteErrorResponse, Link, useRouteError } from "react-router";
import { useT } from "~/i18n";
import { Banner, Page } from "~/ui";

/** Помилка всередині розділу (403/404/500) без технічних деталей. */
export function RouteErrorBoundary() {
  const error = useRouteError();
  const t = useT();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const message = status === 403 ? t("error.forbidden") : status === 404 ? t("error.notFound") : t("error.generic");
  return (
    <Page title={t("error.title")}>
      <Banner tone={status >= 500 ? "critical" : "warning"} title={String(status)}>
        <p>{message}</p>
        <p>
          <Link to="/">{t("common.back")}</Link>
        </p>
      </Banner>
    </Page>
  );
}

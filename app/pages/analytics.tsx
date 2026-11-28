/**
 * Етап 6, WP8: аналітика бізнесу …/analytics (вкладки §12; лише власник). Доступ (§14.2): finance.view + роль owner;
 * інакше працівник із warehouse.view → переадресація на аналітику складу (…/warehouse/analytics, як у меню —
 * fallbackToRelated); інакше 403.
 * СТОРІНКА-ЗАГЛУШКА ядра (раунд 0) — далі належить WP8. Фінансових даних не показує.
 */
import { redirect, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { can } from "~/domain/permissions";
import { useT } from "~/i18n";
import { canFinance } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getRequestContext } from "~/server/context.server";
import { Banner, Card, Page, Stack, Text } from "~/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!canFinance(ctx.actor, "view")) {
    if (can(ctx.actor, "warehouse.view")) throw redirect(`${ctx.basePath}/warehouse/analytics`);
    throw new Response("Forbidden", { status: 403 });
  }
  return { demo: ctx.mode === "demo" };
}

export default function AnalyticsStubPage() {
  const { demo } = useLoaderData<typeof loader>();
  const t = useT();
  return (
    <Page title={t("nav.analytics")}>
      <Stack gap={4}>
        {demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <Card>
          <Text>{t(financeLabelKeys.notice("inDevelopment"))}</Text>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

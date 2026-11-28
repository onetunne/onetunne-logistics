/**
 * Етап 6, WP5: майстер імпорту рахунків (§7.3, §18.5). Маршрут …/finance/shipping/import (app/routes.ts).
 * СТОРІНКА-ЗАГЛУШКА ядра (раунд 0, docs/stage6-design.md §21.3) — далі належить пакету WP5. Доступ (§14.2) уже
 * остаточний: loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router). Сторінка не показує жодних фінансових даних.
 */
import { useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { useT } from "~/i18n";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getRequestContext } from "~/server/context.server";
import { Banner, Card, Page, Stack, Text } from "~/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  return { demo: ctx.mode === "demo" };
}

export async function action({ request }: ActionFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  return { ok: false as const, error: financeLabelKeys.error("notImplemented") };
}

export default function FinanceStubPage() {
  const { demo } = useLoaderData<typeof loader>();
  const t = useT();
  return (
    <Page title={t(financeLabelKeys.tab("shipping"))}>
      <Stack gap={4}>
        <FinanceTabs current="shipping" />
        {demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <Card>
          <Text>{t(financeLabelKeys.notice("inDevelopment"))}</Text>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

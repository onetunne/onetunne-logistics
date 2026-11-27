import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { can } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime } from "~/lib/format";
import { listOpenAlerts } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { getRequestContext } from "~/server/context.server";
import { Banner, Card, KeyValueList, Page, Stack } from "~/ui";

/**
 * Склад (етап 5). Тимчасова сторінка-заготовка: показує лише реальний стан обліку (склад, ініціалізація,
 * відкриті попередження). Повний розділ (залишки, історія руху, операції) — окремим кроком етапу 5.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const warehouse = await getDefaultWarehouse(ctx.db);
  const alerts = await listOpenAlerts(ctx.db, { limit: 500 });
  return {
    warehouseName: warehouse.name,
    initializedAt: warehouse.inventoryInitializedAt ? warehouse.inventoryInitializedAt.toISOString() : null,
    openAlerts: alerts.length,
  };
}

export default function WarehousePage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  return (
    <Page title={t("nav.warehouse")} subtitle={t("warehouse.placeholder.subtitle")}>
      <Stack gap={4}>
        <Banner tone="info">{t("warehouse.placeholder.inProgress")}</Banner>
        <Card title={t("warehouse.placeholder.stateTitle")}>
          <KeyValueList
            items={[
              { key: "name", label: t("warehouse.placeholder.warehouse"), value: data.warehouseName },
              {
                key: "initialized",
                label: t("warehouse.placeholder.initialized"),
                value: data.initializedAt ? formatDateTime(data.initializedAt, locale) : t("warehouse.placeholder.notInitialized"),
              },
              { key: "alerts", label: t("warehouse.placeholder.openAlerts"), value: String(data.openAlerts) },
            ]}
          />
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

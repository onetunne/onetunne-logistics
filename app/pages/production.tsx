import { count, inArray } from "drizzle-orm";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { productionBatches } from "~/db/schema";
import { can } from "~/domain/permissions";
import { useT } from "~/i18n";
import { getRequestContext } from "~/server/context.server";
import { Banner, Card, KeyValueList, Page, Stack } from "~/ui";

/**
 * Виробництво (етап 5). Тимчасова сторінка-заготовка: кількість активних партій із бази.
 * Перегляд — warehouse.view; створення й зміна партій (production.manage) — окремим кроком етапу 5.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const [row] = await ctx.db
    .select({ c: count() })
    .from(productionBatches)
    .where(inArray(productionBatches.status, ["planned", "in_production", "partially_received"]));
  return { activeBatches: Number(row?.c ?? 0), canManage: can(ctx.actor, "production.manage") };
}

export default function ProductionPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  return (
    <Page title={t("nav.production")} subtitle={t("production.placeholder.subtitle")}>
      <Stack gap={4}>
        <Banner tone="info">{t("warehouse.placeholder.inProgress")}</Banner>
        <Card title={t("warehouse.placeholder.stateTitle")}>
          <KeyValueList
            items={[{ key: "active", label: t("production.placeholder.activeBatches"), value: String(data.activeBatches) }]}
          />
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

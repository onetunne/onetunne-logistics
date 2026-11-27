import { count, inArray } from "drizzle-orm";
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { orders } from "~/db/schema";
import { can } from "~/domain/permissions";
import { useT } from "~/i18n";
import { getRequestContext } from "~/server/context.server";
import { Banner, Card, KeyValueList, Page, Stack } from "~/ui";

/** Статуси замовлень, що чекають комплектації/пакування (накладна створена, ще не передано перевізнику). */
const PACKING_QUEUE_STATUSES = ["waybill_created", "awaiting_picking", "packed"] as const;

/**
 * Комплектація й пакування (етап 5). Тимчасова сторінка-заготовка: розмір черги з бази.
 * Черга, контроль комплектації, масовий друк — окремим кроком етапу 5.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "packing.perform")) throw new Response("Forbidden", { status: 403 });
  const [row] = await ctx.db.select({ c: count() }).from(orders).where(inArray(orders.status, [...PACKING_QUEUE_STATUSES]));
  return { queued: Number(row?.c ?? 0) };
}

export default function PickingPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  return (
    <Page title={t("nav.picking")} subtitle={t("picking.placeholder.subtitle")}>
      <Stack gap={4}>
        <Banner tone="info">{t("warehouse.placeholder.inProgress")}</Banner>
        <Card title={t("warehouse.placeholder.stateTitle")}>
          <KeyValueList items={[{ key: "queued", label: t("picking.placeholder.queued"), value: String(data.queued) }]} />
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

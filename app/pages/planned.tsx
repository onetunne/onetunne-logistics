import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { sectionByPath } from "~/domain/navigation";
import { can } from "~/domain/permissions";
import { useT } from "~/i18n";
import { getRequestContext } from "~/server/context.server";
import { Badge, Banner, Card, Page, Stack, Text } from "~/ui";

/** Розділи наступних етапів: лише опис, без імітації функціональності. */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  const section = sectionByPath(params.section ?? "");
  if (!section || section.implemented) throw new Response("Not Found", { status: 404 });
  if (section.permission && !can(ctx.actor, section.permission)) throw new Response("Forbidden", { status: 403 });
  return { key: section.key, stage: section.stage };
}

export default function PlannedSection() {
  const { key, stage } = useLoaderData<typeof loader>();
  const t = useT();
  return (
    <Page title={t(`nav.${key}`)} titleMeta={<Badge tone="outline">{t("common.plannedStage", { stage })}</Badge>}>
      <Stack gap={4}>
        <Banner tone="info" title={t("planned.banner.title")}>
          {t("planned.banner.body", { stage })}
        </Banner>
        <Card title={t("planned.scope.title")}>
          <Text>{t(`planned.${key}.description`)}</Text>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

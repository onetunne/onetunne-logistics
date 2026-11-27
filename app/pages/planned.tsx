import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { sectionByPath } from "~/domain/navigation";
import { can } from "~/domain/permissions";
import { useT } from "~/i18n";
import { getRequestContext } from "~/server/context.server";
import { useHref } from "~/components/shell";
import { Badge, Banner, Button, Card, Page, Stack, Text } from "~/ui";

/** Розділи наступних етапів: лише опис, без імітації функціональності. */
export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  const section = sectionByPath(params.section ?? "");
  if (!section || section.implemented) throw new Response("Not Found", { status: 404 });
  if (section.permission && !can(ctx.actor, section.permission)) throw new Response("Forbidden", { status: 403 });
  const related = section.related && (!section.related.permission || can(ctx.actor, section.related.permission)) ? section.related : null;
  return {
    key: section.key,
    stage: section.stage,
    related: related ? { path: related.path, labelKey: related.labelKey, descriptionKey: related.descriptionKey } : null,
  };
}

export default function PlannedSection() {
  const { key, stage, related } = useLoaderData<typeof loader>();
  const t = useT();
  const href = useHref();
  return (
    <Page title={t(`nav.${key}`)} titleMeta={<Badge tone="outline">{t("common.plannedStage", { stage })}</Badge>}>
      <Stack gap={4}>
        <Banner tone="info" title={t("planned.banner.title")}>
          {t("planned.banner.body", { stage })}
        </Banner>
        {related ? (
          <Card title={t(related.labelKey)}>
            <Stack gap={3} align="start">
              <Text>{t(related.descriptionKey)}</Text>
              <Button to={href(related.path)} variant="primary">
                {t(related.labelKey)}
              </Button>
            </Stack>
          </Card>
        ) : null}
        <Card title={t("planned.scope.title")}>
          <Text>{t(`planned.${key}.description`)}</Text>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

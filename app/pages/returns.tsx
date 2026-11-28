/**
 * Етап 6, WP9: розділ «Повернення» …/returns (§11): список випадків. Доступ (§14.2): orders.view; суми — лише з finance.view і роллю owner (loader повертає
 * null, не порожнє). Дії (ручний випадок, витрата на повернення) — orders.edit / finance.manage (WP9).
 * СТОРІНКА-ЗАГЛУШКА ядра (раунд 0) — далі належить WP9. Сум не показує.
 */
import { useLoaderData, type LoaderFunctionArgs } from "react-router";
import { can } from "~/domain/permissions";
import { useT } from "~/i18n";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getRequestContext } from "~/server/context.server";
import { Card, Page, Stack, Text } from "~/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "orders.view")) throw new Response("Forbidden", { status: 403 });
  // Суми повернень — лише власнику (WP9); заглушка їх не має.
  return { amounts: null };
}

export default function ReturnsStubPage() {
  useLoaderData<typeof loader>();
  const t = useT();
  return (
    <Page title={t("nav.returns")}>
      <Stack gap={4}>
        <Card>
          <Text>{t(financeLabelKeys.notice("inDevelopment"))}</Text>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime } from "~/lib/format";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob, jobStats, retryDeadJobs } from "~/modules/jobs/queue.server";
import { JOB, currentShop, startOrdersImport } from "~/modules/shopify-sync/sync.server";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import { Badge, Banner, Button, Card, ConfirmSubmitButton, KeyValueList, Page, Stack, Text, TextField } from "~/ui";

/** Стан підключення до Shopify, синхронізації, імпорту і фонової черги (лише власник). */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "settings.manage");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  if (ctx.mode === "demo") return { mode: ctx.mode, shop: null, jobs: null, defaultSince: "" };
  const shop = await currentShop(ctx.db);
  const since = new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 10);
  return { mode: ctx.mode, shop, jobs: await jobStats(ctx.db), defaultSince: since };
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "settings.manage");
    if (ctx.mode !== "production") throw new DomainError("shopify.demoUnavailable", 409);
    const shop = await currentShop(ctx.db);
    if (!shop) throw new DomainError("shopify.notInstalled", 409);
    const form = await request.formData();
    const intent = formString(form, "intent");
    if (intent === "syncProducts") {
      await enqueueJob(ctx.db, JOB.productsPage, { shop: shop.shop, after: null }, { dedupeKey: "products:start" });
      await writeAudit(ctx.db, ctx.actor, "shopify.products_sync_requested", { type: "shop", id: shop.shop });
      return { ok: true, message: "shopify.result.productsQueued" };
    }
    if (intent === "importOrders") {
      const since = formString(form, "since");
      await startOrdersImport(ctx.db, shop.shop, since);
      await writeAudit(ctx.db, ctx.actor, "shopify.import_requested", { type: "shop", id: shop.shop }, { since });
      return { ok: true, message: "shopify.result.importQueued", params: { since } };
    }
    if (intent === "retryDead") {
      const n = await retryDeadJobs(ctx.db);
      return { ok: true, message: "shopify.result.retried", params: { count: n } };
    }
    return { ok: false, error: "error.generic" };
  } catch (e) {
    return toActionError(e);
  }
}

export default function ShopifySyncPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const busy = useNavigation().state !== "idle";
  if (data.mode === "demo") {
    return (
      <Page title={t("shopify.title")}>
        <Banner tone="info">{t("shopify.demo")}</Banner>
      </Page>
    );
  }
  const imp = (data.shop?.importState ?? null) as { status?: string; since?: string; imported?: number; skipped?: number } | null;
  return (
    <Page title={t("shopify.title")} subtitle={t("shopify.subtitle")}>
      <Stack gap={4}>
        <ActionBanner data={result} />
        {!data.shop ? <Banner tone="warning">{t("shopify.notInstalled")}</Banner> : null}
        <Card title={t("shopify.connection.title")}>
          <KeyValueList
            items={[
              { label: t("shopify.connection.shop"), value: data.shop?.shop ?? "—" },
              { label: t("shopify.connection.installed"), value: formatDateTime(data.shop?.installedAt, locale) },
              { label: t("shopify.connection.webhooks"), value: formatDateTime(data.shop?.webhooksRegisteredAt, locale) },
              { label: t("shopify.connection.scopes"), value: data.shop?.scopes ?? "—" },
              { label: t("shopify.connection.products"), value: formatDateTime(data.shop?.productsSyncedAt, locale) },
            ]}
          />
        </Card>
        <Card title={t("shopify.products.title")} description={t("shopify.products.help")}>
          <Form method="post">
            <input type="hidden" name="intent" value="syncProducts" />
            <Button type="submit" loading={busy} disabled={!data.shop}>
              {t("shopify.products.button")}
            </Button>
          </Form>
        </Card>
        <Card title={t("shopify.import.title")} description={t("shopify.import.help")}>
          <Stack gap={3}>
            {imp ? (
              <Text>
                {t("shopify.import.state", {
                  status: t(`shopify.import.status.${imp.status ?? "queued"}`),
                  since: imp.since ?? "—",
                  imported: imp.imported ?? 0,
                  skipped: imp.skipped ?? 0,
                })}
              </Text>
            ) : null}
            <Form method="post">
              <input type="hidden" name="intent" value="importOrders" />
              <Stack gap={2}>
                <TextField label={t("shopify.import.since")} name="since" type="date" defaultValue={data.defaultSince} required />
                <ConfirmSubmitButton
                  title={t("shopify.import.confirmTitle")}
                  message={t("shopify.import.confirmMessage")}
                  confirmLabel={t("shopify.import.button")}
                  cancelLabel={t("common.cancel")}
                  disabled={!data.shop}
                >
                  {t("shopify.import.button")}
                </ConfirmSubmitButton>
              </Stack>
            </Form>
          </Stack>
        </Card>
        <Card title={t("shopify.jobs.title")} description={t("shopify.jobs.help")}>
          <Stack gap={3}>
            <Stack direction="horizontal" gap={2} wrap>
              {(["queued", "running", "succeeded", "failed", "dead"] as const).map((k) => (
                <Badge key={k} tone={k === "dead" && (data.jobs?.stats.dead ?? 0) > 0 ? "critical" : "neutral"}>
                  {t(`shopify.jobs.${k}`)}: {data.jobs?.stats[k] ?? 0}
                </Badge>
              ))}
            </Stack>
            {data.jobs?.problems.map((p) => (
              <Text key={p.id} variant="body-sm" tone={p.status === "dead" ? "critical" : "subdued"}>
                {p.type} · {t(`shopify.jobs.${p.status}`)} · {t("shopify.jobs.attempts", { n: p.attempts })} · {p.lastError ?? ""}
              </Text>
            ))}
            {(data.jobs?.stats.dead ?? 0) > 0 ? (
              <Form method="post">
                <input type="hidden" name="intent" value="retryDead" />
                <Button type="submit" loading={busy}>
                  {t("shopify.jobs.retry")}
                </Button>
              </Form>
            ) : null}
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

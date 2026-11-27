import type { ReactNode } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import type { ActionResult } from "~/components/action-banner";
import { ActionBanner } from "~/components/action-banner";
import { useCan, useHref } from "~/components/shell";
import { SeverityBadge, ShipmentStatusBadge, TestBadge } from "~/components/status-badge";
import { insertSimulatedOrder } from "~/db/seed/seed.server";
import type { OrderStatus } from "~/domain/order-status";
import { can, requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime, formatNumber } from "~/lib/format";
import { logger } from "~/lib/logger.server";
import {
  countOpenIssues,
  countOrdersByStatus,
  listIssues,
  listShipments,
  loadOrderRow,
} from "~/modules/orders/repository.server";
import { listOrderIdsByStatus, validateOrders } from "~/modules/orders/workflow.server";
import { countPackingQueue } from "~/modules/packing/queue.server";
import { countProductionDue } from "~/modules/production/queries.server";
import { businessDate } from "~/modules/warehouse/dates";
import { loadAlertSummary } from "~/modules/warehouse/stock.server";
import { displayVariantTitle } from "~/modules/warehouse/constants";
import { getSetting, loadSettings, updateSetting } from "~/modules/settings/settings.server";
import { processPaidOrder } from "~/modules/shipments/waybill.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import type { RequestContext } from "~/server/types";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSubmitButton,
  DataTable,
  Divider,
  EmptyState,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Stack,
  Text,
} from "~/ui";

/** Статуси, що показуються на головній як показники (посилання на відфільтрований список замовлень). */
const KPI_STATUSES = ["paid", "needs_correction", "awaiting_review", "waybill_created"] as const satisfies readonly OrderStatus[];
type KpiStatus = (typeof KPI_STATUSES)[number];

/** Скільки замовлень validateOrders() перевіряє за один запуск (див. slice у workflow.server.ts). */
const BULK_VALIDATE_LIMIT = 200;
/** «Готові найближчим часом» — партії з плановою готовністю в найближчі N днів. */
const PRODUCTION_DUE_SOON_DAYS = 7;
/** Порядок видів попереджень складу на головній (найважливіші спершу). */
const ALERT_KIND_ORDER = ["negative_on_hand", "oversold", "out_of_stock", "low_stock"] as const;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  const canViewOrders = can(ctx.actor, "orders.view");
  const canBulk = can(ctx.actor, "orders.bulk");
  const canViewProblems = can(ctx.actor, "problems.view");
  // Етап 5 на головній — лише за дозволами: склад/виробництво — warehouse.view, черга пакування — packing.perform.
  const canViewWarehouse = can(ctx.actor, "warehouse.view");
  const canPack = can(ctx.actor, "packing.perform");

  const [counts, problemCounts, issueRows, shipmentRows, automation, stockAlerts, production, packingQueue] = await Promise.all([
    canViewOrders || canBulk ? countOrdersByStatus(ctx.db) : null,
    canViewProblems ? countOpenIssues(ctx.db) : null,
    canViewProblems ? listIssues(ctx.db, { status: "open", limit: 5 }) : null,
    canViewOrders ? listShipments(ctx.db, { limit: 5 }) : null,
    getSetting(ctx.db, "automation"),
    canViewWarehouse ? loadAlertSummary(ctx.db, 3) : null,
    canViewWarehouse ? countProductionDue(ctx.db, businessDate(ctx.now()), PRODUCTION_DUE_SOON_DAYS) : null,
    canPack ? countPackingQueue(ctx.db) : null,
  ]);
  const carrier = ctx.carriers.getDefault();

  return {
    mode: ctx.mode,
    kpi:
      counts && canViewOrders
        ? (Object.fromEntries(KPI_STATUSES.map((s) => [s, counts[s]])) as Record<KpiStatus, number>)
        : null,
    paidCount: counts && canBulk ? counts.paid : null,
    problems: problemCounts,
    issues:
      issueRows?.map((r) => ({
        id: r.issue.id,
        code: r.issue.code,
        severity: r.issue.severity,
        createdAt: r.issue.createdAt,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
      })) ?? null,
    shipments:
      shipmentRows?.map((r) => ({
        id: r.shipment.id,
        orderId: r.shipment.orderId,
        orderNumber: r.orderNumber,
        waybillNumber: r.shipment.waybillNumber,
        reference: r.shipment.carrierReference,
        mode: r.shipment.mode,
        status: r.shipment.status,
        createdAt: r.shipment.createdAt,
      })) ?? null,
    automation: { mode: automation.mode, globalPause: automation.globalPause },
    warehouse:
      stockAlerts || production || packingQueue !== null
        ? {
            alerts: stockAlerts
              ? {
                  total: stockAlerts.total,
                  byKind: stockAlerts.byKind,
                  materials: stockAlerts.materials,
                  top: stockAlerts.top.map((a) => ({
                    id: a.id,
                    kind: a.kind,
                    stockItemId: a.stockItemId,
                    title: a.title,
                    variantTitle: displayVariantTitle(a.variantTitle),
                    sku: a.sku,
                  })),
                }
              : null,
            production,
            packingQueue,
          }
        : null,
    carrier: carrier
      ? { displayName: carrier.displayName, mode: carrier.mode, canCreateShipment: carrier.capabilities.createShipment }
      : null,
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  try {
    switch (intent) {
      case "validateAllPaid":
        return await validateAllPaid(ctx);
      case "simulateOrder":
        return await simulateOrder(ctx);
      case "toggleGlobalPause":
        return await setGlobalPause(ctx, formString(form, "globalPause"));
      default:
        return { ok: false, error: "error.generic" };
    }
  } catch (e) {
    return toActionError(e);
  }
}

async function validateAllPaid(ctx: RequestContext): Promise<ActionResult> {
  requirePermission(ctx.actor, "orders.bulk");
  const ids = await listOrderIdsByStatus(ctx.db, ["paid"]);
  if (ids.length === 0) return { ok: true, message: "dashboard.quick.validateAll.none", tone: "info" };
  const result = await validateOrders(ctx, ids);
  const ready = result.ok.filter((s) => !s.blocking).length;
  const fixes = result.ok.reduce((sum, s) => sum + s.autoFixes.length, 0);
  return {
    ok: true,
    message: "result.bulk.validated",
    params: { ok: result.ok.length, failed: result.failed.length, ready, blocked: result.ok.length - ready, fixes },
    extra: ["dashboard.result.validateAll.outcome"],
    tone: result.failed.length > 0 ? "warning" : "success",
  };
}

type PaidOrderOutcome = Awaited<ReturnType<typeof processPaidOrder>>;

/** Опис того, що зробила автоматизація з новим замовленням (додаткові рядки повідомлення). */
function describeAutomation(outcome: PaidOrderOutcome): Pick<Extract<ActionResult, { ok: true }>, "params" | "extra" | "tone"> {
  if (!outcome.validated) {
    return { extra: [`dashboard.simulate.skipped.${outcome.reason}`], tone: "info" };
  }
  const params: Record<string, string | number> = {
    fixes: outcome.summary.autoFixes.length,
    issues: outcome.summary.issueCount,
  };
  const waybill = outcome.waybill;
  if (!waybill) {
    return {
      params,
      extra: [outcome.summary.blocking ? "dashboard.simulate.validated.blocking" : "dashboard.simulate.validated.semi"],
      tone: "success",
    };
  }
  const extra = ["dashboard.simulate.validated.auto"];
  switch (waybill.kind) {
    case "created":
    case "already_exists":
    case "recovered":
      params.waybill = waybill.shipment.waybillNumber ?? waybill.shipment.carrierReference;
      extra.push(
        waybill.kind === "created"
          ? "dashboard.simulate.waybill.created"
          : waybill.kind === "recovered"
            ? "dashboard.simulate.waybill.recovered"
            : "dashboard.simulate.waybill.existing",
      );
      return { params, extra, tone: "success" };
    case "blocked":
      Object.assign(params, waybill.params ?? {});
      extra.push(`result.waybill.blocked.${waybill.reason}`);
      return { params, extra, tone: "warning" };
    case "rejected":
      params.message = waybill.message;
      extra.push("result.waybill.rejected");
      return { params, extra, tone: "warning" };
    case "not_created":
      extra.push("result.waybill.not_created");
      return { params, extra, tone: "warning" };
    case "unknown":
      extra.push("result.waybill.unknown");
      return { params, extra, tone: "warning" };
  }
}

/** Демо: нове оплачене замовлення + обробка відповідно до режиму автоматизації. */
async function simulateOrder(ctx: RequestContext): Promise<ActionResult> {
  if (ctx.mode !== "demo") throw new Response("Not Found", { status: 404 });
  requirePermission(ctx.actor, "orders.edit");
  const orderId = await insertSimulatedOrder(ctx);
  const { orderNumber } = await loadOrderRow(ctx.db, orderId);
  try {
    const described = describeAutomation(await processPaidOrder(ctx, orderId));
    return { ok: true, message: "result.demo.simulated", ...described, params: { ...described.params, number: orderNumber } };
  } catch (e) {
    if (e instanceof Response) throw e;
    logger.error("dashboard.simulate.automation_failed", { error: e });
    return {
      ok: true,
      message: "result.demo.simulated",
      params: { number: orderNumber },
      extra: ["dashboard.simulate.automationFailed"],
      tone: "warning",
    };
  }
}

/** Глобальна пауза: форма передає бажаний стан (ідемпотентно, без «перемикання навпаки» при повторі). */
async function setGlobalPause(ctx: RequestContext, value: string): Promise<ActionResult> {
  requirePermission(ctx.actor, "automation.manage");
  if (value !== "true" && value !== "false") return { ok: false, error: "error.validation" };
  const globalPause = value === "true";
  const { values, versions } = await loadSettings(ctx.db);
  const current = values.automation;
  if (current.globalPause === globalPause) {
    return { ok: true, message: "dashboard.automation.result.unchanged", tone: "info" };
  }
  const result = await updateSetting(ctx.db, ctx.actor, "automation", { ...current, globalPause }, versions.automation);
  if (!result.ok) return { ok: false, error: "error.validation", fieldErrors: result.fieldErrors };
  return globalPause
    ? { ok: true, message: "dashboard.automation.result.paused", tone: "warning" }
    : { ok: true, message: "dashboard.automation.result.resumed", tone: "success" };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type WarehouseData = NonNullable<LoaderData["warehouse"]>;

/** Сигнали етапу 5: попередження складу, черга пакування, партії до готовності (кожен блок — за дозволом). */
function WarehouseSignals({ data }: { data: WarehouseData }) {
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const n = (v: number) => formatNumber(v, locale);
  const { alerts, production, packingQueue } = data;
  return (
    <Stack gap={3} as="section">
      <Text as="h2" variant="heading-md">
        {t("dashboard.stage5.title")}
      </Text>
      <Grid columns={{ xs: 1, md: 3 }} gap={3}>
        {alerts ? (
          <Card
            title={t("dashboard.stage5.alerts.title")}
            titleAs="h3"
            actions={
              <Button
                to={href(alerts.byKind.out_of_stock > 0 ? "warehouse?status=out" : alerts.byKind.low_stock > 0 ? "warehouse?status=low" : "warehouse")}
                variant="plain"
                size="sm"
              >
                {t("dashboard.stage5.alerts.open")}
              </Button>
            }
          >
            <Stack gap={2}>
              <Text as="p" variant="heading-lg" numeric tone={alerts.total > 0 ? "critical" : undefined}>
                {n(alerts.total)}
              </Text>
              {alerts.total === 0 ? (
                <Text variant="body-sm" tone="subdued">
                  {/* «Немає» лише коли немає й попереджень матеріалів (вони показані нижче окремим посиланням). */}
                  {t(alerts.materials > 0 ? "dashboard.stage5.alerts.noneProducts" : "dashboard.stage5.alerts.none")}
                </Text>
              ) : (
                <KeyValueList
                  items={ALERT_KIND_ORDER.filter((k) => alerts.byKind[k] > 0).map((k) => ({
                    key: k,
                    label: t(`stockAlert.${k}`),
                    value: n(alerts.byKind[k]),
                  }))}
                />
              )}
              {alerts.top.length > 0 ? (
                <Stack as="ul" gap={1}>
                  {alerts.top.map((a) => (
                    <li key={a.id}>
                      <Link to={href(`warehouse/items/${a.stockItemId}`)}>
                        {[a.title, a.variantTitle].filter(Boolean).join(" · ")}
                      </Link>{" "}
                      <Text as="span" variant="caption" tone="subdued">
                        {t(`stockAlert.${a.kind}`)}
                      </Text>
                    </li>
                  ))}
                </Stack>
              ) : null}
              {alerts.materials > 0 ? (
                <Text variant="body-sm" tone="subdued">
                  <Link to={href("warehouse/materials")}>{t("dashboard.stage5.alerts.materials", { count: n(alerts.materials) })}</Link>
                </Text>
              ) : null}
            </Stack>
          </Card>
        ) : null}
        {packingQueue !== null ? (
          <Card
            title={t("dashboard.stage5.packing.title")}
            titleAs="h3"
            description={t("dashboard.stage5.packing.hint")}
            actions={
              <Button to={href("picking")} variant="plain" size="sm">
                {t("dashboard.stage5.packing.open")}
              </Button>
            }
          >
            <Text as="p" variant="heading-lg" numeric>
              {n(packingQueue)}
            </Text>
          </Card>
        ) : null}
        {production ? (
          <Card
            title={t("dashboard.stage5.production.title")}
            titleAs="h3"
            actions={
              <Button to={href(production.overdue > 0 ? "production?overdue=1" : "production")} variant="plain" size="sm">
                {t("dashboard.stage5.production.open")}
              </Button>
            }
          >
            <Stack gap={2}>
              <Text as="p" variant="heading-lg" numeric>
                {n(production.active)}
              </Text>
              <Text variant="body-sm" tone="subdued">
                {t("dashboard.stage5.production.active")}
              </Text>
              {production.overdue > 0 ? (
                <Text variant="body-sm" tone="critical" weight="semibold">
                  {t("dashboard.stage5.production.overdue", { count: n(production.overdue) })}
                </Text>
              ) : null}
              <Text variant="body-sm" tone="subdued">
                {t("dashboard.stage5.production.dueSoon", { count: n(production.dueSoon), days: PRODUCTION_DUE_SOON_DAYS })}
              </Text>
            </Stack>
          </Card>
        ) : null}
      </Grid>
    </Stack>
  );
}
type IssueItem = NonNullable<LoaderData["issues"]>[number];
type ShipmentItem = NonNullable<LoaderData["shipments"]>[number];

export default function DashboardPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const canDo = useCan();
  const href = useHref();
  const navigation = useNavigation();
  const pendingIntent = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;

  const { automation } = data;
  const modeLabel = t(`dashboard.automation.mode.${automation.mode}`);
  const canBulk = canDo("orders.bulk") && data.paidCount !== null;
  const canSimulate = data.mode === "demo" && canDo("orders.edit");
  const canManageAutomation = canDo("automation.manage");
  const orderHref = (orderId: string | null) => (orderId ? href(`orders/${orderId}`) : null);

  return (
    <Page title={t("nav.dashboard")} subtitle={t("dashboard.subtitle")}>
      <Stack gap={5}>
        <ActionBanner data={actionData} />

        {data.kpi ? (
          <Stack gap={3} as="section">
            <Text as="h2" variant="heading-md">
              {t("dashboard.kpi.title")}
            </Text>
            <Grid columns={{ xs: 2, lg: 4 }} gap={3}>
              {KPI_STATUSES.map((status) => {
                const count = data.kpi?.[status] ?? 0;
                const label = t(`dashboard.kpi.${status}.label`);
                return (
                  <Card key={status} title={label} titleAs="h3" description={t(`dashboard.kpi.${status}.hint`)}>
                    <Stack gap={2} align="start">
                      <Text as="p" variant="heading-lg" numeric>
                        {formatNumber(count, locale)}
                      </Text>
                      <Button
                        to={href(`orders?status=${status}`)}
                        variant="plain"
                        size="sm"
                        aria-label={t("dashboard.kpi.linkLabel", { label, count })}
                      >
                        {t("common.view")}
                      </Button>
                    </Stack>
                  </Card>
                );
              })}
            </Grid>
          </Stack>
        ) : null}

        {data.problems ? (
          data.problems.total > 0 ? (
            <Banner
              tone={data.problems.errors > 0 ? "critical" : "warning"}
              role="status"
              title={t("dashboard.problems.summary.title")}
              action={
                <Button to={href("problems")} size="sm">
                  {t("dashboard.problems.openAll")}
                </Button>
              }
            >
              {t("dashboard.problems.summary.some", {
                total: data.problems.total,
                errors: data.problems.errors,
                warnings: data.problems.warnings,
                orders: data.problems.orders,
              })}
            </Banner>
          ) : (
            <Banner tone="success">{t("dashboard.problems.summary.none")}</Banner>
          )
        ) : null}

        {data.warehouse ? <WarehouseSignals data={data.warehouse} /> : null}

        <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
          {canBulk || canSimulate ? (
            <Card title={t("dashboard.quick.title")}>
              <Stack gap={4}>
                {canBulk && data.paidCount !== null ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="validateAllPaid" />
                    <Stack gap={2} align="start">
                      <Text variant="body-sm" tone="subdued">
                        {data.paidCount > 0
                          ? t("dashboard.quick.validateAll.help", { count: data.paidCount })
                          : t("dashboard.quick.validateAll.none")}
                      </Text>
                      {data.paidCount > BULK_VALIDATE_LIMIT ? (
                        <Text variant="body-sm" tone="subdued">
                          {t("dashboard.quick.validateAll.limit", { limit: BULK_VALIDATE_LIMIT })}
                        </Text>
                      ) : null}
                      <ConfirmSubmitButton
                        variant="primary"
                        title={t("dashboard.quick.validateAll.confirmTitle")}
                        message={
                          <Stack gap={2}>
                            <Text weight="semibold">
                              {t("dashboard.quick.validateAll.confirmCount", {
                                count: Math.min(data.paidCount, BULK_VALIDATE_LIMIT),
                              })}
                            </Text>
                            <Text>{t("dashboard.quick.validateAll.confirmFixes")}</Text>
                            <Text>{t("dashboard.quick.validateAll.confirmIssues")}</Text>
                          </Stack>
                        }
                        confirmLabel={t("dashboard.quick.validateAll.confirm")}
                        cancelLabel={t("common.cancel")}
                        disabled={data.paidCount === 0}
                        loading={pendingIntent === "validateAllPaid"}
                      >
                        {t("dashboard.quick.validateAll.button")}
                      </ConfirmSubmitButton>
                    </Stack>
                  </Form>
                ) : null}

                {canBulk && canSimulate ? <Divider /> : null}

                {canSimulate ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="simulateOrder" />
                    <Stack gap={2} align="start">
                      <Text variant="body-sm" tone="subdued">
                        {t("demo.simulate.help")} {t("dashboard.quick.simulate.modeHint", { mode: modeLabel })}
                      </Text>
                      {automation.globalPause ? (
                        <Text variant="body-sm" tone="warning">
                          {t("dashboard.quick.simulate.pausedHint")}
                        </Text>
                      ) : null}
                      <Button type="submit" loading={pendingIntent === "simulateOrder"}>
                        {t("demo.simulate.button")}
                      </Button>
                    </Stack>
                  </Form>
                ) : null}
              </Stack>
            </Card>
          ) : null}

          <Card
            title={t("dashboard.automation.title")}
            actions={
              canDo("settings.view") ? (
                <Button to={href("settings")} variant="plain" size="sm">
                  {t("dashboard.automation.changeMode")}
                </Button>
              ) : null
            }
          >
            <Stack gap={4}>
              <KeyValueList
                items={[
                  {
                    key: "mode",
                    label: t("dashboard.automation.modeLabel"),
                    value: (
                      <Stack gap={1} align="start">
                        <Badge tone="info">{modeLabel}</Badge>
                        <Text variant="body-sm" tone="subdued">
                          {t(`dashboard.automation.modeHelp.${automation.mode}`)}
                        </Text>
                      </Stack>
                    ),
                  },
                  {
                    key: "pause",
                    label: t("dashboard.automation.pauseLabel"),
                    value: automation.globalPause ? (
                      <Badge tone="warning">{t("dashboard.automation.pause.on")}</Badge>
                    ) : (
                      <Badge tone="neutral">{t("dashboard.automation.pause.off")}</Badge>
                    ),
                  },
                ]}
              />
              {canManageAutomation ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="toggleGlobalPause" />
                  <input type="hidden" name="globalPause" value={automation.globalPause ? "false" : "true"} />
                  {automation.globalPause ? (
                    <ConfirmSubmitButton
                      variant="primary"
                      title={t("dashboard.automation.resumeConfirmTitle")}
                      message={<Text>{t("dashboard.automation.resumeConfirmMessage", { mode: modeLabel })}</Text>}
                      confirmLabel={t("dashboard.automation.resumeConfirm")}
                      cancelLabel={t("common.cancel")}
                      loading={pendingIntent === "toggleGlobalPause"}
                    >
                      {t("dashboard.automation.resumeButton")}
                    </ConfirmSubmitButton>
                  ) : (
                    <ConfirmSubmitButton
                      variant="critical"
                      title={t("dashboard.automation.pauseConfirmTitle")}
                      message={<Text>{t("dashboard.automation.pauseConfirmMessage", { mode: modeLabel })}</Text>}
                      confirmLabel={t("dashboard.automation.pauseConfirm")}
                      cancelLabel={t("common.cancel")}
                      loading={pendingIntent === "toggleGlobalPause"}
                    >
                      {t("dashboard.automation.pauseButton")}
                    </ConfirmSubmitButton>
                  )}
                </Form>
              ) : (
                <Text variant="body-sm" tone="subdued">
                  {t("dashboard.automation.ownerOnly")}
                </Text>
              )}
            </Stack>
          </Card>
        </Grid>

        {data.issues || data.shipments ? (
          <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
            {data.issues ? (
              <Card
                title={t("nav.problems")}
                description={
                  data.problems && data.problems.total > 0
                    ? t("dashboard.problems.description", { shown: data.issues.length, total: data.problems.total })
                    : undefined
                }
                actions={
                  <Button to={href("problems")} variant="plain" size="sm">
                    {t("dashboard.problems.viewAll")}
                  </Button>
                }
                padded={false}
              >
                <DataTable<IssueItem>
                  caption={t("nav.problems")}
                  rows={data.issues}
                  rowKey={(r) => r.id}
                  emptyState={
                    <EmptyState
                      title={t("dashboard.problems.empty.title")}
                      description={t("dashboard.problems.empty.description")}
                    />
                  }
                  columns={[
                    {
                      key: "problem",
                      header: t("dashboard.problems.col.problem"),
                      primary: true,
                      render: (r) => (
                        <Stack gap={2} direction="horizontal" align="center">
                          <SeverityBadge severity={r.severity} />
                          <span>{t(`issue.${r.code}.title`)}</span>
                        </Stack>
                      ),
                    },
                    {
                      key: "order",
                      header: t("dashboard.problems.col.order"),
                      render: (r) => {
                        const to = orderHref(r.orderId);
                        return to && r.orderNumber ? <Link to={to}>{r.orderNumber}</Link> : "—";
                      },
                    },
                    {
                      key: "detected",
                      header: t("dashboard.problems.col.detected"),
                      hideOnMobile: true,
                      render: (r) => formatDateTime(r.createdAt, locale),
                    },
                  ]}
                />
              </Card>
            ) : null}

            {data.shipments ? (
              <Card
                title={t("dashboard.waybills.title")}
                description={t("dashboard.waybills.description")}
                actions={
                  <Button to={href("waybills")} variant="plain" size="sm">
                    {t("dashboard.waybills.viewAll")}
                  </Button>
                }
                padded={false}
              >
                <DataTable<ShipmentItem>
                  caption={t("dashboard.waybills.title")}
                  rows={data.shipments}
                  rowKey={(r) => r.id}
                  emptyState={
                    <EmptyState
                      title={t("dashboard.waybills.empty.title")}
                      description={t("dashboard.waybills.empty.description")}
                    />
                  }
                  columns={[
                    {
                      key: "waybill",
                      header: t("dashboard.waybills.col.waybill"),
                      primary: true,
                      render: (r) => (
                        <Stack gap={2} direction="horizontal" align="center">
                          {r.waybillNumber ? (
                            <InlineCode>{r.waybillNumber}</InlineCode>
                          ) : (
                            <Text as="span" variant="body-sm" tone="subdued">
                              {t("dashboard.waybills.noNumber")} <InlineCode>{r.reference}</InlineCode>
                            </Text>
                          )}
                          {r.mode === "test" ? <TestBadge /> : null}
                        </Stack>
                      ),
                    },
                    {
                      key: "status",
                      header: t("dashboard.waybills.col.status"),
                      render: (r) => <ShipmentStatusBadge status={r.status} />,
                    },
                    {
                      key: "order",
                      header: t("dashboard.waybills.col.order"),
                      render: (r) => <Link to={href(`orders/${r.orderId}`)}>{r.orderNumber}</Link>,
                    },
                    {
                      key: "created",
                      header: t("dashboard.waybills.col.created"),
                      hideOnMobile: true,
                      render: (r) => formatDateTime(r.createdAt, locale),
                    },
                  ]}
                />
              </Card>
            ) : null}
          </Grid>
        ) : null}

        <Card title={t("dashboard.integrations.title")} description={t("dashboard.integrations.description")}>
          <KeyValueList
            items={[
              {
                key: "shopify",
                label: t("dashboard.integrations.shopify"),
                value: (
                  <IntegrationStatus
                    badge={
                      data.mode === "demo" ? (
                        <Badge tone="outline">{t("dashboard.integrations.status.notConnected")}</Badge>
                      ) : (
                        <Badge tone="success">{t("dashboard.integrations.status.connected")}</Badge>
                      )
                    }
                    text={t(data.mode === "demo" ? "dashboard.integrations.shopify.demo" : "dashboard.integrations.shopify.production")}
                  />
                ),
              },
              {
                key: "carrier",
                label: t("dashboard.integrations.carrier"),
                value: <CarrierStatus carrier={data.carrier} />,
              },
              {
                key: "assistant",
                label: t("nav.assistant"),
                value: (
                  <IntegrationStatus
                    badge={<Badge tone="outline">{t("common.plannedStage", { stage: 7 })}</Badge>}
                    text={t("dashboard.integrations.assistant.planned")}
                  />
                ),
              },
              {
                key: "telegram",
                label: t("dashboard.integrations.telegram"),
                value: (
                  <IntegrationStatus
                    badge={<Badge tone="outline">{t("common.plannedStage", { stage: 8 })}</Badge>}
                    text={t("dashboard.integrations.telegram.planned")}
                  />
                ),
              },
            ]}
          />
        </Card>
      </Stack>
    </Page>
  );
}

function IntegrationStatus({ badge, text }: { badge: ReactNode; text: string }) {
  return (
    <Stack gap={1} align="start">
      {badge}
      <Text variant="body-sm" tone="subdued">
        {text}
      </Text>
    </Stack>
  );
}

/** Чесний стан перевізника: тестовий (sandbox), очікує API (етап 3), підключений або відсутній. */
function CarrierStatus({ carrier }: { carrier: LoaderData["carrier"] }) {
  const t = useT();
  if (!carrier) {
    return (
      <IntegrationStatus
        badge={<Badge tone="critical">{t("dashboard.integrations.status.notConnected")}</Badge>}
        text={t("dashboard.integrations.carrier.none")}
      />
    );
  }
  if (carrier.mode === "test") {
    return <IntegrationStatus badge={<TestBadge />} text={t("dashboard.integrations.carrier.test")} />;
  }
  if (!carrier.canCreateShipment) {
    return (
      <IntegrationStatus
        badge={<Badge tone="warning">{t("dashboard.integrations.status.waiting")}</Badge>}
        text={t("dashboard.integrations.carrier.pending", { carrier: carrier.displayName })}
      />
    );
  }
  return (
    <IntegrationStatus
      badge={<Badge tone="success">{t("dashboard.integrations.status.connected")}</Badge>}
      text={t("dashboard.integrations.carrier.ready", { carrier: carrier.displayName })}
    />
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

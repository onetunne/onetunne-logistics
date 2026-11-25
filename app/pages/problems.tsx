import { Fragment } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useCan, useHref } from "~/components/shell";
import { OrderStatusBadge, SeverityBadge } from "~/components/status-badge";
import { isOrderStatus, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { hasKey, makeT, useLocale, useT, type Locale } from "~/i18n";
import { localizeCode, localizeParams } from "~/i18n/localize";
import { countryName, formatDateTime, formatNumber } from "~/lib/format";
import { countOpenIssues, listIssues, type OpenIssueListRow } from "~/modules/orders/repository.server";
import { VALIDATABLE_STATUSES, acceptSuggestion, dismissIssue } from "~/modules/orders/workflow.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError, type ActionError } from "~/server/http.server";
import type { RequestContext } from "~/server/types";
import {
  Banner,
  Button,
  Card,
  Divider,
  EmptyState,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Stack,
  Tabs,
  Text,
  type KeyValueItem,
  type TabItem,
} from "~/ui";

/** Скільки проблем показується за один раз (відкриті — найстаріші першими, вирішені — найновіші). */
const ISSUE_LIMIT = 200;
const MAX_CANDIDATE_LENGTH = 200;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type ProblemsTab = "open" | "resolved";
type Severity = "error" | "warning";

interface ProblemFilters {
  tab: ProblemsTab;
  severity: Severity | null;
}

function parseFilters(params: URLSearchParams): ProblemFilters {
  const severity = params.get("severity");
  return {
    tab: params.get("tab") === "resolved" ? "resolved" : "open",
    severity: severity === "error" || severity === "warning" ? severity : null,
  };
}

/** Рядок запиту сторінки (вкладку «Відкриті» та «усі» не пишемо). */
function buildSearch(f: ProblemFilters): string {
  const params = new URLSearchParams();
  if (f.tab === "resolved") params.set("tab", "resolved");
  if (f.severity) params.set("severity", f.severity);
  const search = params.toString();
  return search ? `?${search}` : "";
}

interface IssueView {
  id: string;
  code: string;
  severity: Severity;
  field: string | null;
  params: Record<string, string | number>;
  /** Варіанти виправлення (лише для відкритих проблем). */
  candidates: string[];
  /** Текст відповіді перевізника (для проблем CARRIER_*), уже без персональних даних. */
  carrierMessage: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

interface OrderGroup {
  key: string;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  countryCode: string | null;
  countryLabel: string | null;
  /** Чи можна змінювати дані замовлення (застосовувати пропозиції) у поточному статусі. */
  editable: boolean;
  hasErrors: boolean;
  issues: IssueView[];
}

function toIssueView(row: OpenIssueListRow, tab: ProblemsTab): IssueView {
  const { issue } = row;
  const message = issue.params.message;
  return {
    id: issue.id,
    code: issue.code,
    severity: issue.severity,
    field: issue.field,
    params: issue.params,
    candidates: tab === "open" ? (issue.suggestion?.candidates ?? []) : [],
    carrierMessage: issue.code.startsWith("CARRIER_") && typeof message === "string" && message.trim() ? message : null,
    createdAt: issue.createdAt,
    resolvedAt: issue.resolvedAt,
    resolution: issue.resolution,
  };
}

/** Групування за замовленням. Відкриті: спершу замовлення з помилками, далі — найстаріші. */
function groupByOrder(rows: OpenIssueListRow[], tab: ProblemsTab, locale: Locale): OrderGroup[] {
  const groups = new Map<string, OrderGroup>();
  for (const row of rows) {
    const key = row.orderId ?? "none";
    let group = groups.get(key);
    if (!group) {
      group = {
        key,
        orderId: row.orderId,
        orderNumber: row.orderNumber,
        orderStatus: row.orderStatus,
        countryCode: row.countryCode,
        countryLabel: row.countryCode ? countryName(row.countryCode, locale) : null,
        editable: row.orderStatus !== null && VALIDATABLE_STATUSES.includes(row.orderStatus),
        hasErrors: false,
        issues: [],
      };
      groups.set(key, group);
    }
    group.issues.push(toIssueView(row, tab));
    if (row.issue.severity === "error") group.hasErrors = true;
  }
  const list = [...groups.values()];
  if (tab === "open") {
    for (const group of list) {
      group.issues.sort((a, b) => Number(b.severity === "error") - Number(a.severity === "error"));
    }
    list.sort((a, b) => Number(b.hasErrors) - Number(a.hasErrors));
  }
  return list;
}

const time = (d: Date | null) => (d ? d.getTime() : 0);

/** Вирішені та приховані проблеми разом, найновіші першими. */
async function listClosedIssues(db: RequestContext["db"], severity: Severity | null): Promise<OpenIssueListRow[]> {
  const [resolved, dismissed] = await Promise.all([
    listIssues(db, { status: "resolved", severity, limit: ISSUE_LIMIT }),
    listIssues(db, { status: "dismissed", severity, limit: ISSUE_LIMIT }),
  ]);
  return [...resolved, ...dismissed]
    .sort((a, b) => time(b.issue.resolvedAt) - time(a.issue.resolvedAt))
    .slice(0, ISSUE_LIMIT);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "problems.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const filters = parseFilters(new URL(request.url).searchParams);
  const [counts, rows] = await Promise.all([
    countOpenIssues(ctx.db),
    filters.tab === "open"
      ? listIssues(ctx.db, { status: "open", severity: filters.severity, limit: ISSUE_LIMIT })
      : listClosedIssues(ctx.db, filters.severity),
  ]);
  return {
    filters,
    counts,
    groups: groupByOrder(rows, filters.tab, ctx.locale),
    truncated: rows.length >= ISSUE_LIMIT,
  };
}

/** Зрозуміліші повідомлення про помилки дій: «не знайдено» стосується проблеми, статус — перекладено. */
function localizeError(result: ActionError, locale: Locale): ActionResult {
  if (result.error === "error.notFound") return { ok: false, error: "problems.error.notFound" };
  const status = result.params?.status;
  if (isOrderStatus(status)) {
    return { ...result, params: { ...result.params, status: makeT(locale)(`status.${status}`) } };
  }
  return result;
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    const form = await request.formData();
    const intent = formString(form, "intent");
    if (intent !== "acceptSuggestion" && intent !== "dismissIssue") return { ok: false, error: "error.generic" };
    const issueId = formString(form, "issueId");
    if (!UUID_RE.test(issueId)) return { ok: false, error: "problems.error.notFound" };

    if (intent === "dismissIssue") {
      await dismissIssue(ctx, issueId.toLowerCase());
      return { ok: true, message: "result.issue.dismissed" };
    }

    const candidate = formString(form, "candidate");
    if (!candidate || candidate.length > MAX_CANDIDATE_LENGTH) return { ok: false, error: "issue.invalidCandidate" };
    const summary = await acceptSuggestion(ctx, issueId.toLowerCase(), candidate);
    return {
      ok: true,
      message: "result.suggestion.accepted",
      params: { errors: summary.errorCount },
      extra: [summary.blocking ? "problems.result.revalidated.blocking" : "problems.result.revalidated.ready"],
      tone: summary.blocking ? "warning" : "success",
    };
  } catch (e) {
    return localizeError(toActionError(e), ctx.locale);
  }
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Group = LoaderData["groups"][number];
type Issue = Group["issues"][number];

/** Ключ назви поля: shipping.* / email / contactPhone, variant.<id>.<поле> → field.variant.<поле>. */
function fieldLabelKey(field: string | null): string | null {
  if (!field) return null;
  let key: string;
  if (field.startsWith("variant.")) key = `field.variant.${field.split(".").pop() ?? ""}`;
  else if (field.startsWith("lineItem.")) key = "field.lineItem";
  else key = `field.${field}`;
  return hasKey(key) ? key : null;
}

/** Підказка «де виправити»: дані замовлення або товару. Для решти (перевізник, позиції Shopify) достатньо пояснення. */
function fixHintKeyFor(field: string | null): string | null {
  if (!field) return null;
  if (field === "email" || field === "contactPhone" || field.startsWith("shipping.")) return "problems.issue.fixInOrder";
  if (field.startsWith("variant.")) return "problems.issue.fixProduct";
  return null;
}

interface PendingSubmit {
  intent: string | null;
  issueId: string | null;
  candidate: string | null;
}

export default function ProblemsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const navigation = useNavigation();

  const { filters, counts, groups } = data;
  const canEdit = can("orders.edit");
  const problemsPath = href("problems");
  const listHref = (f: ProblemFilters) => `${problemsPath}${buildSearch(f)}`;

  const submitting = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const field = (name: string) => {
    const v = submitting ? navigation.formData?.get(name) : null;
    return typeof v === "string" ? v : null;
  };
  const pending: PendingSubmit = { intent: field("intent"), issueId: field("issueId"), candidate: field("candidate") };

  const tabs: TabItem[] = [
    {
      key: "open",
      label: t("problems.tabs.open"),
      href: listHref({ tab: "open", severity: filters.severity }),
      count: counts.total,
    },
    { key: "resolved", label: t("problems.tabs.resolved"), href: listHref({ tab: "resolved", severity: filters.severity }) },
  ];

  const severityOptions: Array<{ value: Severity | null; label: string }> = [
    { value: null, label: t("common.all") },
    { value: "error", label: t("problems.filter.errors") },
    { value: "warning", label: t("problems.filter.warnings") },
  ];

  const kpis = [
    { key: "errors", value: counts.errors },
    { key: "warnings", value: counts.warnings },
    { key: "orders", value: counts.orders },
  ] as const;

  const emptyState = filters.severity ? (
    <EmptyState
      title={t("problems.empty.filtered.title")}
      description={t("problems.empty.filtered.description")}
      action={<Button to={listHref({ tab: filters.tab, severity: null })}>{t("problems.empty.showAll")}</Button>}
    />
  ) : filters.tab === "open" ? (
    <EmptyState title={t("problems.empty.open.title")} description={t("problems.empty.open.description")} />
  ) : (
    <EmptyState title={t("problems.empty.resolved.title")} description={t("problems.empty.resolved.description")} />
  );

  return (
    <Page title={t("nav.problems")} subtitle={t("problems.subtitle")}>
      <Stack gap={5}>
        <ActionBanner data={actionData} />

        {filters.tab === "open" ? (
          <Stack gap={3} as="section">
            <Text as="h2" variant="heading-md">
              {t("problems.kpi.title")}
            </Text>
            <Grid columns={{ xs: 1, md: 3 }} gap={3}>
              {kpis.map((kpi) => (
                <Card
                  key={kpi.key}
                  title={t(`problems.kpi.${kpi.key}.label`)}
                  titleAs="h3"
                  description={t(`problems.kpi.${kpi.key}.hint`)}
                >
                  <Text as="p" variant="heading-lg" numeric>
                    {formatNumber(kpi.value, locale)}
                  </Text>
                </Card>
              ))}
            </Grid>
          </Stack>
        ) : null}

        <Stack gap={3}>
          <Tabs items={tabs} selected={filters.tab} ariaLabel={t("problems.tabs.label")} />
          <nav aria-label={t("problems.filter.label")}>
            <Stack direction="horizontal" gap={2} align="center">
              <Text as="span" variant="body-sm" tone="subdued">
                {t("problems.filter.label")}
              </Text>
              {severityOptions.map((option) => {
                const selected = filters.severity === option.value;
                return (
                  <Button
                    key={option.value ?? "all"}
                    to={listHref({ tab: filters.tab, severity: option.value })}
                    size="sm"
                    variant={selected ? "primary" : "secondary"}
                    aria-label={selected ? t("problems.filter.current", { label: option.label }) : undefined}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </Stack>
          </nav>
        </Stack>

        {groups.length === 0 ? (
          <Card>{emptyState}</Card>
        ) : (
          <Stack gap={4}>
            {groups.map((group) => (
              <OrderProblemsCard
                key={group.key}
                group={group}
                tab={filters.tab}
                canEdit={canEdit}
                pending={pending}
                orderHref={group.orderId ? href(`orders/${group.orderId}`) : null}
              />
            ))}
            {data.truncated ? (
              <Text variant="body-sm" tone="subdued">
                {t(filters.tab === "open" ? "problems.limit.open" : "problems.limit.resolved", { limit: ISSUE_LIMIT })}
              </Text>
            ) : null}
          </Stack>
        )}
      </Stack>
    </Page>
  );
}

function OrderProblemsCard({
  group,
  tab,
  canEdit,
  pending,
  orderHref,
}: {
  group: Group;
  tab: ProblemsTab;
  canEdit: boolean;
  pending: PendingSubmit;
  orderHref: string | null;
}) {
  const t = useT();
  const number = group.orderNumber ?? "";
  return (
    <Card
      title={orderHref && group.orderNumber ? <Link to={orderHref}>{group.orderNumber}</Link> : t("problems.group.noOrder")}
      description={
        <Stack direction="horizontal" gap={2} align="center">
          {group.orderStatus ? <OrderStatusBadge status={group.orderStatus} /> : null}
          {group.countryCode ? (
            <Stack as="span" direction="horizontal" gap={1} align="center">
              <InlineCode>{group.countryCode}</InlineCode>
              <span>{group.countryLabel}</span>
            </Stack>
          ) : null}
          <Text as="span" variant="body-sm" tone="subdued">
            {t("problems.group.count", { count: group.issues.length })}
          </Text>
        </Stack>
      }
      actions={
        orderHref ? (
          <Button to={orderHref} size="sm" aria-label={t("problems.openOrderLabel", { number })}>
            {t("problems.openOrder")}
          </Button>
        ) : null
      }
    >
      <Stack gap={4}>
        {group.issues.map((issue, index) => (
          <Fragment key={issue.id}>
            {index > 0 ? <Divider /> : null}
            <IssueItem issue={issue} group={group} tab={tab} canEdit={canEdit} pending={pending} />
          </Fragment>
        ))}
      </Stack>
    </Card>
  );
}

function IssueItem({
  issue,
  group,
  tab,
  canEdit,
  pending,
}: {
  issue: Issue;
  group: Group;
  tab: ProblemsTab;
  canEdit: boolean;
  pending: PendingSubmit;
}) {
  const t = useT();
  const locale = useLocale();
  const fieldKey = fieldLabelKey(issue.field);
  const resolutionKey = `problems.resolution.${issue.resolution ?? "other"}`;

  const details: KeyValueItem[] = [];
  if (fieldKey) details.push({ key: "field", label: t("problems.issue.field"), value: t(fieldKey) });
  details.push({ key: "detected", label: t("problems.issue.detected"), value: formatDateTime(issue.createdAt, locale) });
  if (tab === "resolved") {
    details.push({
      key: "resolution",
      label: t("problems.issue.resolution"),
      value: t(hasKey(resolutionKey) ? resolutionKey : "problems.resolution.other"),
    });
    details.push({ key: "resolvedAt", label: t("problems.issue.resolvedAt"), value: formatDateTime(issue.resolvedAt, locale) });
  }

  const isOpen = tab === "open";
  const busy = pending.issueId === issue.id;
  const hasCandidates = issue.candidates.length > 0;
  const fixHintKey = isOpen && canEdit && issue.severity === "error" && !hasCandidates ? fixHintKeyFor(issue.field) : null;

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} align="center">
        <SeverityBadge severity={issue.severity} />
        <Text as="h3" variant="heading-sm">
          {t(`issue.${issue.code}.title`)}
        </Text>
      </Stack>
      <Text>{t(`issue.${issue.code}.help`, localizeParams(issue.params, t))}</Text>
      {issue.carrierMessage ? (
        <Text variant="body-sm" tone="subdued">
          {t("problems.issue.carrierMessage", { message: localizeCode(issue.carrierMessage, t) })}
        </Text>
      ) : null}
      <KeyValueList items={details} />

      {isOpen && canEdit && hasCandidates ? (
        group.editable ? (
          <Form method="post">
            <input type="hidden" name="intent" value="acceptSuggestion" />
            <input type="hidden" name="issueId" value={issue.id} />
            <Stack gap={2}>
              <Text variant="body-sm" weight="semibold">
                {t(issue.candidates.length === 1 ? "problems.suggestion.single" : "problems.suggestion.multiple")}
              </Text>
              <Stack direction="horizontal" gap={2}>
                {issue.candidates.map((candidate) => (
                  <Button
                    key={candidate}
                    type="submit"
                    name="candidate"
                    value={candidate}
                    size="sm"
                    variant={issue.candidates.length === 1 ? "primary" : "secondary"}
                    loading={busy && pending.intent === "acceptSuggestion" && pending.candidate === candidate}
                    disabled={busy}
                    aria-label={t("problems.suggestion.apply", { value: candidate })}
                    translate="no"
                  >
                    {candidate}
                  </Button>
                ))}
              </Stack>
              <Text variant="caption" tone="subdued">
                {t("problems.suggestion.note")}
              </Text>
            </Stack>
          </Form>
        ) : group.orderStatus ? (
          <Banner tone="info">{t("problems.suggestion.locked", { status: t(`status.${group.orderStatus}`) })}</Banner>
        ) : null
      ) : null}

      {isOpen && canEdit && issue.severity === "warning" ? (
        <Form method="post">
          <input type="hidden" name="intent" value="dismissIssue" />
          <input type="hidden" name="issueId" value={issue.id} />
          <Stack direction="horizontal" gap={2} align="center">
            <Button
              type="submit"
              size="sm"
              variant="plain"
              loading={busy && pending.intent === "dismissIssue"}
              disabled={busy}
            >
              {t("problems.dismiss.button")}
            </Button>
            <Text as="span" variant="caption" tone="subdued">
              {t("problems.dismiss.help")}
            </Text>
          </Stack>
        </Form>
      ) : null}

      {fixHintKey ? (
        <Text variant="body-sm" tone="subdued">
          {t(fixHintKey)}
        </Text>
      ) : null}
    </Stack>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

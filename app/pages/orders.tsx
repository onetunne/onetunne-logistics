import { useEffect, useState, type ReactNode } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useCan, useHref, useShell } from "~/components/shell";
import { OrderStatusBadge, TestBadge } from "~/components/status-badge";
import { ORDER_STATUSES, isOrderStatus, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { countryName, formatDateTime, formatMoney } from "~/lib/format";
import {
  countOpenIssues,
  countOrdersByStatus,
  listOrders,
  loadCountryRuleRows,
  type OrderListFilter,
} from "~/modules/orders/repository.server";
import { validateOrders, type BulkResult, type ValidationSummary } from "~/modules/orders/workflow.server";
import { createWaybills, type BulkWaybillSummary } from "~/modules/shipments/waybill.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  DataTable,
  EmptyState,
  Grid,
  InlineCode,
  Page,
  Pagination,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  type DataTableColumn,
  type TabItem,
} from "~/ui";

const PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 100;
const MAX_BULK_IDS = 100;
const BULK_FORM_ID = "bulk-form";
const SELECTION_NAME = "orderIds";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DASH = "—";

/** Статуси, що мають власну вкладку; решта — через список «Статус» у фільтрах. */
const TAB_STATUSES = [
  "paid",
  "needs_correction",
  "awaiting_review",
  "waybill_created",
  "cancelled",
] as const satisfies readonly OrderStatus[];

/** Причини, через які накладну не створено з вини налаштувань (а не самого замовлення). */
const SETUP_REASONS: ReadonlySet<string> = new Set(["shipper_incomplete", "no_carrier", "carrier_not_configured"]);
const NOT_ELIGIBLE_REASONS: ReadonlySet<string> = new Set(["status", "validation", "automation_paused"]);

interface OrderFilters {
  status: OrderStatus | null;
  q: string;
  country: string | null;
  problems: boolean;
  page: number;
}

function parseFilters(params: URLSearchParams): OrderFilters {
  const status = params.get("status");
  const country = (params.get("country") ?? "").trim().toUpperCase();
  const pageRaw = (params.get("page") ?? "").trim();
  return {
    status: isOrderStatus(status) ? status : null,
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    problems: params.get("problems") === "1",
    page: /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1,
  };
}

/** Рядок запиту списку (лише власні параметри сторінки; page=1 не пишемо). */
function buildSearch(f: Partial<OrderFilters>): string {
  const params = new URLSearchParams();
  if (f.status) params.set("status", f.status);
  if (f.q) params.set("q", f.q);
  if (f.country) params.set("country", f.country);
  if (f.problems) params.set("problems", "1");
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }

  const filters = parseFilters(new URL(request.url).searchParams);
  const listFilter: OrderListFilter = {
    status: filters.status,
    q: filters.q || null,
    country: filters.country,
    withProblems: filters.problems,
    pageSize: PAGE_SIZE,
  };
  const [firstPage, byStatus, openIssues, countryRows] = await Promise.all([
    listOrders(ctx.db, { ...listFilter, page: filters.page }),
    countOrdersByStatus(ctx.db),
    countOpenIssues(ctx.db),
    loadCountryRuleRows(ctx.db),
  ]);
  const pages = Math.max(1, Math.ceil(firstPage.total / firstPage.pageSize));
  // Застаріле посилання на сторінку за межами списку → остання наявна сторінка.
  const list = firstPage.page > pages ? await listOrders(ctx.db, { ...listFilter, page: pages }) : firstPage;

  const countries = countryRows.map((r) => ({ code: r.countryCode, name: countryName(r.countryCode, ctx.locale) }));
  if (filters.country && !countries.some((c) => c.code === filters.country)) {
    countries.push({ code: filters.country, name: countryName(filters.country, ctx.locale) });
  }
  // Сортування на сервері — однаковий порядок під час гідратації.
  const collator = new Intl.Collator(ctx.locale === "uk" ? "uk" : "en");
  countries.sort((a, b) => collator.compare(a.name, b.name));

  return {
    filters: { ...filters, page: list.page },
    isFiltered: Boolean(filters.status || filters.q || filters.country || filters.problems),
    rows: list.rows,
    total: list.total,
    page: list.page,
    pages,
    pageSize: list.pageSize,
    counts: {
      all: Object.values(byStatus).reduce((sum, n) => sum + n, 0),
      problems: openIssues.orders,
      byStatus,
    },
    countries,
  };
}

function parseOrderIds(form: FormData): string[] {
  const ids = new Set<string>();
  for (const value of form.getAll(SELECTION_NAME)) {
    if (ids.size >= MAX_BULK_IDS) break;
    if (typeof value === "string" && UUID_RE.test(value)) ids.add(value.toLowerCase());
  }
  return [...ids];
}

function summarizeValidation(result: BulkResult<ValidationSummary>): ActionResult {
  const ok = result.ok.length;
  const failed = result.failed.length;
  const fixes = result.ok.reduce((sum, s) => sum + s.autoFixes.length, 0);
  const needsCorrection = result.ok.filter((s) => s.status === "needs_correction").length;
  const extra: string[] = [];
  if (fixes > 0) extra.push("orders.bulk.validated.fixes");
  if (needsCorrection > 0) extra.push("orders.bulk.validated.needsCorrection");
  if (failed > 0) extra.push("orders.bulk.validated.skipped");
  return {
    ok: true,
    message: "result.bulk.validated",
    params: { ok, failed, fixes, needsCorrection },
    extra,
    tone: failed > 0 || needsCorrection > 0 ? "warning" : "success",
  };
}

function summarizeWaybills(summary: BulkWaybillSummary, testCarrier: boolean): ActionResult {
  const n = { created: 0, existing: 0, notEligible: 0, setup: 0, inProgress: 0, rejected: 0, notCreated: 0, unknown: 0, errors: 0 };
  for (const r of summary.results) {
    switch (r.result) {
      case "created":
      case "recovered":
        n.created += 1;
        break;
      case "already_exists":
        n.existing += 1;
        break;
      case "rejected":
        n.rejected += 1;
        break;
      case "not_created":
        n.notCreated += 1;
        break;
      case "unknown":
        n.unknown += 1;
        break;
      case "blocked":
        if (r.reason === "in_progress") n.inProgress += 1;
        else if (r.reason && SETUP_REASONS.has(r.reason)) n.setup += 1;
        else if (r.reason && NOT_ELIGIBLE_REASONS.has(r.reason)) n.notEligible += 1;
        else n.errors += 1;
        break;
    }
  }
  const skipped = summary.results.length - n.created - n.existing;
  const extra: string[] = [];
  if (testCarrier && n.created > 0) extra.push("orders.bulk.waybills.testCreated");
  if (n.notEligible > 0) extra.push("orders.bulk.waybills.notEligible");
  if (n.setup > 0) extra.push("orders.bulk.waybills.setup");
  if (n.inProgress > 0) extra.push("orders.bulk.waybills.inProgress");
  if (n.rejected > 0) extra.push("orders.bulk.waybills.rejected");
  if (n.notCreated > 0) extra.push("orders.bulk.waybills.notCreated");
  if (n.unknown > 0) extra.push("orders.bulk.waybills.unknown");
  if (n.errors > 0) extra.push("orders.bulk.waybills.errors");
  return {
    ok: true,
    message: "result.bulk.waybills",
    params: { ...n, skipped },
    extra,
    tone: skipped > 0 ? "warning" : "success",
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.bulk");
    const form = await request.formData();
    const intent = formString(form, "intent");
    if (intent !== "bulkValidate" && intent !== "bulkWaybills") return { ok: false, error: "error.generic" };
    const ids = parseOrderIds(form);
    if (ids.length === 0) return { ok: false, error: "orders.bulk.noneSelected" };

    if (intent === "bulkValidate") {
      return summarizeValidation(await validateOrders(ctx, ids));
    }
    requirePermission(ctx.actor, "waybills.create");
    const summary = await createWaybills(ctx, ids);
    return summarizeWaybills(summary, ctx.carriers.getDefault()?.mode === "test");
  } catch (e) {
    return toActionError(e);
  }
}

type Row = Awaited<ReturnType<typeof loader>>["rows"][number];

const MOBILE_QUERY = "(max-width: 767.98px)";
/** До гідратації на телефоні вміст розкривного блока прихований (щоб фільтри не «блимали»). */
const DISCLOSURE_CSS =
  "@media (max-width: 767.98px){details[data-filters-disclosure]:not([data-ready])>:not(summary){display:none}}" +
  "details[data-filters-disclosure]>summary{cursor:pointer;padding:2px 0}";

/**
 * Розкривний блок фільтрів: на телефоні згорнутий за замовчуванням (прохання власника), на ширших екранах — відкритий.
 * TODO: перенести в UI-кіт (app/ui) разом зі стилем; зараз однакова копія є в app/pages/problems.tsx.
 */
function FiltersDisclosure({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (window.matchMedia?.(MOBILE_QUERY).matches) setOpen(false);
    setReady(true);
  }, []);
  return (
    <details
      data-filters-disclosure=""
      data-ready={ready ? "" : undefined}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <style dangerouslySetInnerHTML={{ __html: DISCLOSURE_CSS }} />
      <summary>
        <Text as="span" variant="body-sm" weight="semibold">
          {label}
        </Text>
      </summary>
      <div style={{ paddingTop: "var(--ot-space-3)" }}>{children}</div>
    </details>
  );
}

function countCheckedOrders(): number {
  return document.querySelectorAll(`input[name="${SELECTION_NAME}"][form="${BULK_FORM_ID}"]:checked`).length;
}

export default function OrdersPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const { mode } = useShell();
  const location = useLocation();
  const navigation = useNavigation();
  const [selectedCount, setSelectedCount] = useState(0);

  const { filters, rows } = data;
  const ordersPath = href("orders");
  const isDemo = mode === "demo";
  const canBulk = can("orders.bulk");
  const canCreateWaybills = canBulk && can("waybills.create");
  // Після навігації (вкладки, фільтри, сторінки) поля фільтра й прапорці вибору створюються заново.
  const listKey = location.search;

  // Лічильник вибору синхронізується з DOM після кожного оновлення даних
  // (навігація, повторна перевірка після дії, відновлення стану форми браузером).
  useEffect(() => {
    setSelectedCount(countCheckedOrders());
  }, [rows]);

  const method = navigation.formMethod?.toUpperCase();
  const busyIntent = navigation.state !== "idle" && method === "POST" ? navigation.formData?.get("intent") : null;
  const isFiltering =
    navigation.state === "loading" && method === "GET" && navigation.location.pathname === location.pathname;

  const listHref = (f: Partial<OrderFilters>) => `${ordersPath}${buildSearch(f)}`;
  const keep = { q: filters.q, country: filters.country };
  const tabs: TabItem[] = [
    { key: "all", label: t("common.all"), href: listHref(keep), count: data.counts.all },
    ...TAB_STATUSES.map((status) => ({
      key: status,
      label: t(`status.${status}`),
      href: listHref({ ...keep, status }),
      count: data.counts.byStatus[status],
    })),
    { key: "problems", label: t("orders.tabs.problems"), href: listHref({ ...keep, problems: true }), count: data.counts.problems },
  ];
  const selectedTab = filters.problems ? (filters.status ? "" : "problems") : (filters.status ?? "all");

  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = from === 0 ? 0 : from + rows.length - 1;

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "order",
      header: t("orders.col.order"),
      primary: true,
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={2} align="center">
          <span>{r.orderNumber}</span>
          {r.source === "demo" ? (
            <Badge tone="outline" size="sm" title={t("orders.demoOrder")}>
              {t("common.demo")}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    { key: "date", header: t("orders.col.date"), render: (r) => formatDateTime(r.placedAt, locale) },
    { key: "customer", header: t("orders.col.customer"), render: (r) => r.customerName || DASH },
    {
      key: "destination",
      header: t("orders.col.destination"),
      render: (r) =>
        r.countryCode || r.city ? (
          <Stack as="span" direction="horizontal" gap={1} align="center">
            {r.countryCode ? <InlineCode>{r.countryCode}</InlineCode> : null}
            {r.city ? <span>{r.city}</span> : null}
          </Stack>
        ) : (
          DASH
        ),
    },
    {
      key: "items",
      header: t("orders.col.items"),
      align: "end",
      hideOnMobile: true,
      render: (r) => <Text as="span" numeric>{r.itemCount}</Text>,
    },
    {
      key: "total",
      header: t("orders.col.total"),
      align: "end",
      render: (r) => <Text as="span" numeric>{formatMoney(r.total, r.currency, locale)}</Text>,
    },
    {
      key: "status",
      header: t("orders.col.status"),
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={1} align="center">
          <OrderStatusBadge status={r.status} />
          {r.automationPaused ? (
            <Badge tone="warning" size="sm">
              {t("orders.automationPaused")}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "problems",
      header: t("orders.col.problems"),
      render: (r) => {
        const warnings = r.openIssueCount - r.openErrorCount;
        if (r.openErrorCount <= 0 && warnings <= 0) return DASH;
        return (
          <Stack as="span" direction="horizontal" gap={1} align="center">
            {r.openErrorCount > 0 ? (
              <Badge tone="critical">{t("orders.problems.errors", { count: r.openErrorCount })}</Badge>
            ) : null}
            {warnings > 0 ? <Badge tone="warning">{t("orders.problems.warnings", { count: warnings })}</Badge> : null}
          </Stack>
        );
      },
    },
    {
      key: "waybill",
      header: t("orders.col.waybill"),
      render: (r) =>
        r.waybillNumber ? (
          <Stack as="span" direction="horizontal" gap={1} align="center">
            <InlineCode>{r.waybillNumber}</InlineCode>
            {/* Демо працює лише з тестовим перевізником; у робочій версії тестових накладних немає. */}
            {isDemo ? <TestBadge /> : null}
          </Stack>
        ) : (
          DASH
        ),
    },
  ];

  const emptyState = data.isFiltered ? (
    <EmptyState
      title={t("orders.empty.filtered.title")}
      description={t("orders.empty.filtered.description")}
      action={<Button to={ordersPath}>{t("orders.empty.resetFilters")}</Button>}
    />
  ) : (
    <EmptyState
      title={t("orders.empty.title")}
      description={isDemo ? t("orders.empty.demo") : t("orders.empty.production")}
      action={isDemo ? <Button to={href()}>{t("orders.empty.toDashboard")}</Button> : undefined}
    />
  );

  const bulkBusy = busyIntent === "bulkValidate" || busyIntent === "bulkWaybills";
  const activeFilters = [filters.q, filters.country, filters.status, filters.problems].filter(Boolean).length;

  return (
    <Page title={t("nav.orders")} subtitle={t("orders.subtitle")}>
      <Stack gap={4}>
        <ActionBanner data={actionData} />

        <Tabs items={tabs} selected={selectedTab} ariaLabel={t("orders.tabs.label")} />

        <Card>
          <FiltersDisclosure
            label={activeFilters > 0 ? t("orders.filters.titleActive", { count: activeFilters }) : t("common.filters")}
          >
            <Form key={listKey} method="get" role="search">
              <Stack gap={4}>
                <Grid columns={{ xs: 1, md: 2, lg: 3 }} gap={3}>
                  <TextField
                    id="orders-filter-q"
                    type="search"
                    name="q"
                    label={t("common.search")}
                    placeholder={t("orders.filters.searchPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={MAX_QUERY_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Select
                    id="orders-filter-country"
                    name="country"
                    label={t("orders.filters.country")}
                    placeholder={t("orders.filters.allCountries")}
                    options={data.countries.map((c) => ({ value: c.code, label: c.name }))}
                    defaultValue={filters.country ?? ""}
                  />
                  <Select
                    id="orders-filter-status"
                    name="status"
                    label={t("orders.filters.status")}
                    placeholder={t("orders.filters.allStatuses")}
                    options={ORDER_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) }))}
                    defaultValue={filters.status ?? ""}
                  />
                </Grid>
                <Checkbox
                  id="orders-filter-problems"
                  name="problems"
                  value="1"
                  label={t("orders.filters.problemsOnly")}
                  defaultChecked={filters.problems}
                />
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" loading={isFiltering}>
                    {t("common.apply")}
                  </Button>
                  <Button to={ordersPath} disabled={!data.isFiltered}>
                    {t("common.reset")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </FiltersDisclosure>
        </Card>

        {canBulk && rows.length > 0 ? (
          <Card>
            <Form id={BULK_FORM_ID} method="post" aria-label={t("orders.bulk.label")}>
              <Stack direction="horizontal" gap={3} align="center" justify="between">
                <div aria-live="polite" aria-atomic="true">
                  <Stack gap={1}>
                    <Text variant="body-sm" weight="semibold">
                      {t("common.selected", { count: selectedCount })}
                    </Text>
                    {selectedCount === 0 ? (
                      <Text variant="caption" tone="subdued">
                        {t("orders.bulk.hint")}
                      </Text>
                    ) : null}
                  </Stack>
                </div>
                <Stack direction="horizontal" gap={2}>
                  <ConfirmSubmitButton
                    name="intent"
                    value="bulkValidate"
                    disabled={selectedCount === 0 || bulkBusy}
                    loading={busyIntent === "bulkValidate"}
                    title={t("orders.bulk.validate.title")}
                    confirmLabel={t("orders.bulk.validate.confirm")}
                    cancelLabel={t("common.cancel")}
                    message={
                      <Stack gap={2}>
                        <Text weight="semibold">{t("orders.bulk.validate.count", { count: selectedCount })}</Text>
                        <Text>{t("orders.bulk.validate.fixes")}</Text>
                        <Text>{t("orders.bulk.validate.ambiguous")}</Text>
                        <Text variant="body-sm" tone="subdued">
                          {t("orders.bulk.validate.scope")}
                        </Text>
                      </Stack>
                    }
                  >
                    {t("orders.bulk.validate.button")}
                  </ConfirmSubmitButton>
                  {canCreateWaybills ? (
                    <ConfirmSubmitButton
                      name="intent"
                      value="bulkWaybills"
                      variant="primary"
                      disabled={selectedCount === 0 || bulkBusy}
                      loading={busyIntent === "bulkWaybills"}
                      title={t(isDemo ? "orders.bulk.waybills.title.test" : "orders.bulk.waybills.title.live")}
                      confirmLabel={t("orders.bulk.waybills.confirm")}
                      cancelLabel={t("common.cancel")}
                      message={
                        <Stack gap={2}>
                          <Text weight="semibold">{t("orders.bulk.waybills.count", { count: selectedCount })}</Text>
                          <Text>{t("orders.bulk.waybills.scope")}</Text>
                          <Text>{t("orders.bulk.waybills.noDuplicates")}</Text>
                          <Text>{t("orders.bulk.waybills.notShipped")}</Text>
                          {isDemo ? (
                            <Text variant="body-sm" tone="subdued">
                              {t("orders.bulk.waybills.testNote")}
                            </Text>
                          ) : null}
                        </Stack>
                      }
                    >
                      {t(isDemo ? "orders.bulk.waybills.button.test" : "orders.bulk.waybills.button.live")}
                    </ConfirmSubmitButton>
                  ) : null}
                </Stack>
              </Stack>
            </Form>
          </Card>
        ) : null}

        <Card padded={false}>
          <DataTable<Row>
            key={listKey}
            caption={t("orders.table.caption")}
            rows={rows}
            rowKey={(r) => r.id}
            rowHref={(r) => `${ordersPath}/${r.id}`}
            columns={columns}
            emptyState={emptyState}
            selection={
              canBulk
                ? {
                    name: SELECTION_NAME,
                    formId: BULK_FORM_ID,
                    value: (r) => r.id,
                    label: (r) => t("common.selectRow", { label: r.orderNumber }),
                    allLabel: t("common.selectAll"),
                    onChange: (values) => setSelectedCount(values.length),
                  }
                : undefined
            }
          />
        </Card>

        {data.total > 0 ? (
          <Stack direction="horizontal" gap={3} align="center" justify="between">
            <Text variant="body-sm" tone="subdued">
              {t("orders.list.range", { from, to, total: data.total })}
            </Text>
            <Pagination
              prevHref={data.page > 1 ? listHref({ ...filters, page: data.page - 1 }) : null}
              nextHref={data.page < data.pages ? listHref({ ...filters, page: data.page + 1 }) : null}
              label={t("common.pageOf", { page: data.page, pages: data.pages })}
              prevLabel={t("common.previous")}
              nextLabel={t("common.next")}
              ariaLabel={t("common.pagination")}
            />
          </Stack>
        ) : null}
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

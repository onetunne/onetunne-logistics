import { useMemo, useState } from "react";
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
import { useHref } from "~/components/shell";
import type { ProductionBatchStatus } from "~/db/schema";
import { can, ForbiddenError, requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { DomainError } from "~/lib/errors";
import { formatDate, formatNumber } from "~/lib/format";
import { UUID_RE, closeBatch, startProduction } from "~/modules/production/batches.server";
import {
  ACTIVE_BATCH_STATUSES,
  BATCH_STATUSES,
  BATCH_STATUS_TONE,
  CLOSABLE_STATUSES,
  formatCost,
  isBatchStatus,
  isStatusIn,
  kyivDate,
} from "~/modules/production/calc";
import { countActiveBatches, listBatchFilterOptions, listBatches } from "~/modules/production/queries.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  DataTable,
  Disclosure,
  EmptyState,
  Grid,
  Page,
  Pagination,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  type DataTableColumn,
} from "~/ui";

/**
 * Виробництво (етап 5): перелік партій із фільтрами (стан, товар/модель/колір, прострочені), масові дії
 * (запуск, закриття — з підтвердженням і кількостями). Перегляд — warehouse.view; дії — production.manage;
 * собівартість — лише finance.view (у даних loader для інших її немає). Логіка — modules/production.
 */

const PAGE_SIZE = 50;
const MAX_QUERY_LENGTH = 100;
const MAX_BULK = 100;
const BULK_FORM_ID = "production-bulk";
const TABS = ["active", ...BATCH_STATUSES, "all"] as const;
type Tab = (typeof TABS)[number];

interface ListFilters {
  tab: Tab;
  q: string;
  product: string | null;
  model: string | null;
  color: string | null;
  overdue: boolean;
  page: number;
}

function parseFilters(params: URLSearchParams): ListFilters {
  const tab = params.get("tab") ?? "";
  const pageRaw = (params.get("page") ?? "").trim();
  const text = (name: string) => {
    const v = (params.get(name) ?? "").trim().slice(0, MAX_QUERY_LENGTH);
    return v === "" ? null : v;
  };
  const product = text("product");
  return {
    tab: (TABS as readonly string[]).includes(tab) ? (tab as Tab) : "active",
    q: text("q") ?? "",
    product: product && UUID_RE.test(product) ? product : null,
    model: text("model"),
    color: text("color"),
    overdue: params.get("overdue") === "1",
    page: /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1,
  };
}

function buildSearch(f: Partial<ListFilters>): string {
  const params = new URLSearchParams();
  if (f.tab && f.tab !== "active") params.set("tab", f.tab);
  if (f.q) params.set("q", f.q);
  if (f.product) params.set("product", f.product);
  if (f.model) params.set("model", f.model);
  if (f.color) params.set("color", f.color);
  if (f.overdue) params.set("overdue", "1");
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

function statusesOf(tab: Tab): ProductionBatchStatus[] | undefined {
  if (tab === "all") return undefined;
  if (tab === "active") return [...ACTIVE_BATCH_STATUSES];
  return [tab];
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const filters = parseFilters(new URL(request.url).searchParams);
  const includeCosts = can(ctx.actor, "finance.view");
  const today = kyivDate(ctx.now());
  const query = {
    statuses: statusesOf(filters.tab),
    search: filters.q || undefined,
    productIds: filters.product ? [filters.product] : undefined,
    models: filters.model ? [filters.model] : undefined,
    colors: filters.color ? [filters.color] : undefined,
    overdue: filters.overdue,
  };
  let list = await listBatches(ctx.db, query, { today, includeCosts, limit: PAGE_SIZE, offset: (filters.page - 1) * PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(list.total / PAGE_SIZE));
  // Застаріле посилання на сторінку за межами списку → остання наявна сторінка.
  if (filters.page > pages) {
    filters.page = pages;
    list = await listBatches(ctx.db, query, { today, includeCosts, limit: PAGE_SIZE, offset: (pages - 1) * PAGE_SIZE });
  }
  const [options, activeBatches] = await Promise.all([listBatchFilterOptions(ctx.db), countActiveBatches(ctx.db)]);
  const counts = list.statusCounts;
  return {
    /** Активні партії (заплановано / у виробництві / частково отримано). */
    activeBatches,
    canManage: can(ctx.actor, "production.manage"),
    canReceive: can(ctx.actor, "warehouse.receive"),
    canSeeCosts: includeCosts,
    today,
    filters,
    isFiltered: Boolean(filters.q || filters.product || filters.model || filters.color || filters.overdue),
    tabCounts: {
      active: ACTIVE_BATCH_STATUSES.reduce((s, k) => s + counts[k], 0),
      all: BATCH_STATUSES.reduce((s, k) => s + counts[k], 0),
      ...counts,
    } as Record<Tab, number>,
    overdueCount: list.overdueCount,
    options,
    total: list.total,
    page: filters.page,
    pages,
    rows: list.rows.map((r) => ({
      id: r.id,
      number: r.number,
      title: r.title,
      status: r.status,
      plannedReadyDate: r.plannedReadyDate,
      manufacturer: r.manufacturer,
      overdue: r.overdue,
      version: r.version,
      totals: r.totals,
      remainderKind: r.remainderKind,
      inProduction: r.inProduction,
      products: r.products,
      productCount: r.productCount,
      // Собівартість — лише власник (finance.view); для інших — null.
      cost: includeCosts ? r.cost : null,
    })),
  };
}

type BulkIntent = "bulkStart" | "bulkClose";

/** Значення прапорця рядка: "<id>:<version>" — версія захищає від дії над зміненою партією. */
function parseRefs(values: FormDataEntryValue[]): Array<{ id: string; version: number }> {
  const out = new Map<string, number>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    const [id, version] = v.split(":");
    if (!id || !UUID_RE.test(id) || !/^\d{1,9}$/.test(version ?? "")) continue;
    out.set(id.toLowerCase(), Number(version));
  }
  return [...out].slice(0, MAX_BULK).map(([id, version]) => ({ id, version }));
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "production.manage");
    const form = await request.formData();
    const intent = formString(form, "intent") as BulkIntent;
    if (intent !== "bulkStart" && intent !== "bulkClose") return { ok: false, error: "error.generic" };
    const refs = parseRefs(form.getAll("batch"));
    if (refs.length === 0) return { ok: false, error: "production.error.noneSelected" };
    let done = 0;
    let skipped = 0;
    let units = 0;
    for (const ref of refs) {
      try {
        if (intent === "bulkStart") units += (await startProduction(ctx, ref.id, ref.version)).units;
        else units += (await closeBatch(ctx, ref.id, ref.version)).closedUnits;
        done += 1;
      } catch (e) {
        // Партія в іншому стані, змінена чи видалена — пропускаємо (кожна партія — окрема транзакція).
        if (e instanceof ForbiddenError || !(e instanceof DomainError)) throw e;
        skipped += 1;
      }
    }
    return {
      ok: true,
      message: intent === "bulkStart" ? "production.result.bulkStarted" : "production.result.bulkClosed",
      params: { done, skipped, units },
      tone: skipped > 0 ? "warning" : "success",
    };
  } catch (e) {
    return toActionError(e);
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Row = Data["rows"][number];

function StatusBadges({ status, overdue }: { status: ProductionBatchStatus; overdue: boolean }) {
  const t = useT();
  return (
    <Stack direction="horizontal" gap={1}>
      <Badge tone={BATCH_STATUS_TONE[status]}>{t(`productionStatus.${status}`)}</Badge>
      {overdue ? <Badge tone="critical">{t("production.overdue")}</Badge> : null}
    </Stack>
  );
}

export default function ProductionPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const location = useLocation();
  const navigation = useNavigation();
  const listPath = href("production");
  const { filters, rows } = data;
  const [selected, setSelected] = useState<string[]>([]);
  const listHref = (f: Partial<ListFilters>) => `${listPath}${buildSearch(f)}`;
  const isFiltering =
    navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET" && navigation.location.pathname === location.pathname;
  const busy = navigation.state !== "idle";
  const busyIntent = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;

  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);
  const selectedRows = selected.map((v) => rowById.get(v.split(":")[0] ?? "")).filter((r): r is Row => Boolean(r));
  const startable = selectedRows.filter((r) => r.status === "planned" && r.totals.lines > 0);
  const closable = selectedRows.filter((r) => isBatchStatus(r.status) && isStatusIn(r.status, CLOSABLE_STATUSES));
  const startUnits = startable.reduce((s, r) => s + r.totals.ordered, 0);
  const closeUnits = closable.reduce((s, r) => s + r.totals.remaining, 0);

  const tabs = TABS.map((key) => ({
    key,
    label: key === "active" ? t("production.tabs.active") : key === "all" ? t("common.all") : t(`productionStatus.${key}`),
    href: listHref({ ...filters, tab: key, page: 1 }),
    count: data.tabCounts[key],
  }));
  const activeFilterCount = [filters.q, filters.product, filters.model, filters.color, filters.overdue ? "1" : ""].filter(Boolean).length;

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "batch",
      header: t("production.list.batch"),
      primary: true,
      render: (r) => (
        <Stack gap={0}>
          <Text as="span" weight="semibold">
            {r.number}
          </Text>
          <Text as="span" variant="body-sm" tone="subdued">
            {r.title}
          </Text>
        </Stack>
      ),
    },
    { key: "status", header: t("production.list.status"), render: (r) => <StatusBadges status={r.status} overdue={r.overdue} /> },
    {
      key: "products",
      header: t("production.list.products"),
      render: (r) =>
        r.products.length === 0 ? (
          "—"
        ) : (
          <Stack direction="horizontal" gap={2} align="center">
            {r.products.map((p) => (
              <Thumbnail key={p.id} src={p.imageUrl} alt={p.title} size="sm" />
            ))}
            <Text as="span" variant="body-sm">
              {r.products[0]!.title}
              {r.productCount > 1 ? ` ${t("production.list.moreProducts", { count: r.productCount - 1 })}` : ""}
            </Text>
          </Stack>
        ),
    },
    {
      key: "ready",
      header: t("production.list.readyDate"),
      render: (r) => (
        <Text as="span" tone={r.overdue ? "critical" : "default"}>
          {r.plannedReadyDate ? formatDate(r.plannedReadyDate, locale) : "—"}
        </Text>
      ),
    },
    {
      key: "progress",
      header: t("production.list.progress"),
      align: "end",
      render: (r) => t("production.list.progressValue", { produced: formatNumber(r.totals.produced, locale), ordered: formatNumber(r.totals.ordered, locale) }),
    },
    {
      key: "defective",
      header: t("production.list.defective"),
      align: "end",
      render: (r) =>
        r.totals.defective > 0 ? (
          <Text as="span" tone="warning">
            {t("production.defectValue", { count: formatNumber(r.totals.defective, locale), rate: r.totals.defectRate ?? 0 })}
          </Text>
        ) : (
          "0"
        ),
    },
    {
      // Лише запущені партії мають одиниці в кошику «У виробництві»; заплановані, закриті й скасовані — «—».
      key: "remaining",
      header: t("production.list.remaining"),
      align: "end",
      render: (r) => (r.remainderKind === "inProduction" ? formatNumber(r.inProduction, locale) : "—"),
    },
  ];
  if (data.canSeeCosts) {
    columns.push({
      key: "cost",
      header: t("production.list.cost"),
      align: "end",
      render: (r) =>
        r.cost?.total && r.cost.currency ? (
          <Stack gap={0}>
            <Text as="span" numeric>
              {formatCost(r.cost.total, r.cost.currency, locale)}
            </Text>
            {r.cost.costPerGoodUnit ? (
              <Text as="span" variant="caption" tone="subdued">
                {t("production.list.perGoodUnit", { amount: formatCost(r.cost.costPerGoodUnit, r.cost.currency, locale) })}
              </Text>
            ) : null}
          </Stack>
        ) : (
          "—"
        ),
    });
  }

  return (
    <Page
      title={t("nav.production")}
      subtitle={t("production.subtitle")}
      primaryAction={
        data.canManage ? (
          <Button to={href("production/new")} variant="primary">
            {t("production.new")}
          </Button>
        ) : null
      }
    >
      <Stack gap={4}>
        <ActionBanner data={actionData} />
        {!data.canManage ? (
          <Banner tone="info">{t(data.canReceive ? "production.readOnly.canReceive" : "production.readOnly")}</Banner>
        ) : null}
        {data.overdueCount > 0 && !filters.overdue ? (
          <Banner tone="warning">
            <p>{t("production.overdueBanner", { count: data.overdueCount })}</p>
            <p>
              <Button to={listHref({ tab: "all", overdue: true })} size="sm">
                {t("production.overdueShow")}
              </Button>
            </p>
          </Banner>
        ) : null}

        <Tabs items={tabs} selected={filters.tab} ariaLabel={t("production.tabs.label")} />

        <Disclosure collapsedOnMobile summary={activeFilterCount > 0 ? t("production.filters.titleActive", { count: activeFilterCount }) : t("common.filters")}>
          <Form key={location.search} method="get" role="search">
            {filters.tab !== "active" ? <input type="hidden" name="tab" value={filters.tab} /> : null}
            <Stack gap={4}>
              <Grid columns={{ xs: 1, md: 2, lg: 4 }} gap={3}>
                <TextField
                  id="production-filter-q"
                  type="search"
                  name="q"
                  label={t("common.search")}
                  placeholder={t("production.filters.searchPlaceholder")}
                  defaultValue={filters.q}
                  maxLength={MAX_QUERY_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Select
                  id="production-filter-product"
                  name="product"
                  label={t("production.filters.product")}
                  placeholder={t("production.filters.anyProduct")}
                  options={data.options.products.map((p) => ({ value: p.id, label: p.title }))}
                  defaultValue={filters.product ?? ""}
                />
                <Select
                  id="production-filter-model"
                  name="model"
                  label={t("production.filters.model")}
                  placeholder={t("production.filters.anyModel")}
                  options={data.options.models.map((m) => ({ value: m, label: m }))}
                  defaultValue={filters.model ?? ""}
                />
                <Select
                  id="production-filter-color"
                  name="color"
                  label={t("production.filters.color")}
                  placeholder={t("production.filters.anyColor")}
                  options={data.options.colors.map((c) => ({ value: c, label: c }))}
                  defaultValue={filters.color ?? ""}
                />
              </Grid>
              <Checkbox id="production-filter-overdue" name="overdue" value="1" label={t("production.filters.overdueOnly")} defaultChecked={filters.overdue} />
              <Stack direction="horizontal" gap={2}>
                <Button type="submit" variant="primary" loading={isFiltering}>
                  {t("common.apply")}
                </Button>
                <Button to={listHref({ tab: filters.tab })} disabled={!data.isFiltered}>
                  {t("common.reset")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        </Disclosure>

        {data.canManage && rows.length > 0 ? (
          <Card>
            <Form method="post" id={BULK_FORM_ID} aria-label={t("production.bulk.label")}>
              <Stack direction="horizontal" gap={3} align="center" justify="between">
                <div aria-live="polite" aria-atomic="true">
                  <Stack gap={1}>
                    <Text variant="body-sm" weight="semibold">
                      {t("common.selected", { count: selectedRows.length })}
                    </Text>
                    {selectedRows.length === 0 ? (
                      <Text variant="caption" tone="subdued">
                        {t("production.bulk.hint")}
                      </Text>
                    ) : null}
                  </Stack>
                </div>
                <Stack direction="horizontal" gap={2}>
                  <ConfirmSubmitButton
                    name="intent"
                    value="bulkStart"
                    disabled={startable.length === 0 || busy}
                    loading={busyIntent === "bulkStart"}
                    title={t("production.bulk.startTitle")}
                    message={
                      <Stack gap={2}>
                        <Text weight="semibold">
                          {t("production.bulk.startConfirm", { count: startable.length, units: formatNumber(startUnits, locale) })}
                        </Text>
                        <Text>{t("production.bulk.startEffect")}</Text>
                        {selectedRows.length > startable.length ? (
                          <Text variant="body-sm" tone="subdued">
                            {t("production.bulk.skippedNote", { count: selectedRows.length - startable.length })}
                          </Text>
                        ) : null}
                      </Stack>
                    }
                    confirmLabel={t("production.bulk.startConfirmLabel")}
                    cancelLabel={t("common.cancel")}
                  >
                    {t("production.bulk.start", { count: startable.length })}
                  </ConfirmSubmitButton>
                  <ConfirmSubmitButton
                    variant="critical"
                    name="intent"
                    value="bulkClose"
                    disabled={closable.length === 0 || busy}
                    loading={busyIntent === "bulkClose"}
                    title={t("production.bulk.closeTitle")}
                    message={
                      <Stack gap={2}>
                        <Text weight="semibold">
                          {t("production.bulk.closeConfirm", { count: closable.length, units: formatNumber(closeUnits, locale) })}
                        </Text>
                        <Text>{t("production.bulk.closeEffect")}</Text>
                        {selectedRows.length > closable.length ? (
                          <Text variant="body-sm" tone="subdued">
                            {t("production.bulk.skippedNote", { count: selectedRows.length - closable.length })}
                          </Text>
                        ) : null}
                      </Stack>
                    }
                    confirmLabel={t("production.bulk.closeConfirmLabel")}
                    cancelLabel={t("common.cancel")}
                  >
                    {t("production.bulk.close", { count: closable.length })}
                  </ConfirmSubmitButton>
                </Stack>
              </Stack>
            </Form>
          </Card>
        ) : null}

        <Card padded={false} title={t("production.list.caption", { count: data.total })}>
          <Stack gap={0}>
            <DataTable
              caption={t("nav.production")}
              columns={columns}
              rows={rows}
              rowKey={(r) => r.id}
              rowHref={(r) => href(`production/${r.id}`)}
              selection={
                data.canManage
                  ? {
                      name: "batch",
                      formId: BULK_FORM_ID,
                      value: (r) => `${r.id}:${r.version}`,
                      label: (r) => t("common.selectRow", { label: r.number }),
                      allLabel: t("common.selectAll"),
                      onChange: setSelected,
                    }
                  : undefined
              }
              emptyState={
                <EmptyState
                  title={data.isFiltered ? t("production.empty.filtered") : t("production.empty.title")}
                  description={data.canManage && !data.isFiltered ? t("production.empty.description") : undefined}
                  action={
                    data.canManage && !data.isFiltered ? (
                      <Button to={href("production/new")} variant="primary">
                        {t("production.new")}
                      </Button>
                    ) : undefined
                  }
                />
              }
            />
            <Pagination
              prevHref={data.page > 1 ? listHref({ ...filters, page: data.page - 1 }) : null}
              nextHref={data.page < data.pages ? listHref({ ...filters, page: data.page + 1 }) : null}
              label={t("common.pageOf", { page: data.page, pages: data.pages })}
              prevLabel={t("common.previous")}
              nextLabel={t("common.next")}
              ariaLabel={t("common.pagination")}
            />
          </Stack>
        </Card>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

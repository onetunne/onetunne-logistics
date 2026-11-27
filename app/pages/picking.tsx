import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigate,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useCan, useHref, useShell } from "~/components/shell";
import { OrderStatusBadge, TestBadge } from "~/components/status-badge";
import type { OrderPriority } from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { hasKey, makeT, useLocale, useT, type TFunction } from "~/i18n";
import { countryName, formatDateTime } from "~/lib/format";
import {
  MAX_BULK_ORDERS,
  MAX_HANDOVER_ORDERS,
  MAX_LABEL_ORDERS,
  MAX_PICK_LIST_ORDERS,
  MAX_PRINT_ORDERS,
  PRIORITIES,
  PRIORITY_KEYS,
  parsePriority,
} from "~/modules/packing/constants";
import { setOrdersPriority, startPackingBulk, type BulkStartSummary } from "~/modules/packing/packing.server";
import {
  QUEUE_TABS,
  activeFilterCount,
  buildQueueSearch,
  parseOrderIds,
  parseQueueFilters,
  type QueueFilters,
  type QueueTab,
} from "~/modules/packing/queue-filters";
import { listPackingQueue } from "~/modules/packing/queue.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSubmitButton,
  DataTable,
  Disclosure,
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
  Thumbnail,
  type BadgeTone,
  type DataTableColumn,
  type TabItem,
} from "~/ui";

/**
 * Комплектація й пакування (етап 5): черга замовлень з накладною (пріоритет ↓, дата ↑), фільтри (статус, пріоритет,
 * країна, модель, колір, працівник), масові дії (почати пакування, пріоритет, друк пакувальних листів та інвойсів,
 * зведений лист комплектації picking/pick-list, об'єднаний PDF етикеток перевізника) і вкладка «Потрібна накладна»
 * (звідти — вага й габарити посилки до накладної на екрані пакування). Пакування замовлення — picking/:orderId.
 * Дозволи перевіряє сервер: черга й пакування — packing.perform; пріоритет — orders.edit.
 */

const BULK_FORM_ID = "packing-bulk-form";
const SELECTION_NAME = "orderIds";
const PRIORITY_TONE: Record<OrderPriority, BadgeTone> = { 0: "outline", 1: "warning", 2: "critical" };

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "packing.perform");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const filters = parseQueueFilters(new URL(request.url).searchParams);
  const result = await listPackingQueue(ctx, filters);
  const collator = new Intl.Collator(ctx.locale === "uk" ? "uk" : "en");
  const countries = result.options.countries
    .map((code) => ({ code, name: countryName(code, ctx.locale) }))
    .sort((a, b) => collator.compare(a.name, b.name));
  return {
    filters: { ...filters, page: result.page },
    rows: result.rows,
    total: result.total,
    page: result.page,
    pages: result.pages,
    pageSize: result.pageSize,
    counts: result.counts,
    /** Замовлень у черзі пакування (усі статуси черги, з урахуванням фільтрів). */
    queued: result.counts.queue,
    options: { ...result.options, countries },
    isDemo: ctx.mode === "demo",
  };
}

function summarizeStart(s: BulkStartSummary): ActionResult {
  const skipped = s.skipped.length;
  const extra: string[] = [];
  if (s.alreadyStarted > 0) extra.push("packing.bulk.start.alreadyStarted");
  if (s.alreadyPacked > 0) extra.push("packing.bulk.start.alreadyPacked");
  if (skipped > 0) extra.push("packing.bulk.start.skipped");
  return {
    ok: true,
    message: "packing.bulk.start.result",
    params: { started: s.started, alreadyStarted: s.alreadyStarted, alreadyPacked: s.alreadyPacked, skipped },
    extra,
    tone: skipped > 0 ? "warning" : s.started > 0 ? "success" : "info",
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "packing.perform");
    const form = await request.formData();
    const intent = formString(form, "intent");
    const ids = parseOrderIds(form.getAll(SELECTION_NAME), MAX_BULK_ORDERS);
    if (intent !== "bulkStart" && intent !== "bulkPriority") return { ok: false, error: "error.generic" };
    if (ids.length === 0) return { ok: false, error: "packing.bulk.noneSelected" };
    if (intent === "bulkStart") return summarizeStart(await startPackingBulk(ctx, ids));
    const priority = parsePriority(formString(form, "priority"));
    if (priority === null) return { ok: false, error: "packing.error.invalidPriority" };
    const s = await setOrdersPriority(ctx, ids, priority);
    return {
      ok: true,
      message: "packing.bulk.priority.result",
      params: { updated: s.updated, unchanged: s.unchanged, skipped: s.skipped.length, priority: makeT(ctx.locale)(`packing.priority.${PRIORITY_KEYS[priority]}`) },
      tone: s.skipped.length > 0 ? "warning" : "success",
    };
  } catch (e) {
    return toActionError(e);
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Row = Data["rows"][number];

/** Відповідь маршруту етикеток: пропущені замовлення (заголовок або тіло JSON). */
interface LabelsOutcome {
  tone: "success" | "warning" | "critical";
  messageKey: string;
  params?: Record<string, string | number>;
  skipped: Array<{ n: string; r: string }>;
}

function parseSkipped(value: string | null): Array<{ n: string; r: string }> {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return Array.isArray(parsed)
      ? parsed.filter((x): x is { n: string; r: string } => typeof x === "object" && x !== null && typeof x.n === "string" && typeof x.r === "string")
      : [];
  } catch {
    return [];
  }
}

/** Завантажує об'єднаний PDF етикеток через fetch (у вбудованому застосунку App Bridge додає токен сесії). */
async function downloadLabels(url: string): Promise<LabelsOutcome> {
  let response: Response;
  try {
    response = await window.fetch(url, { credentials: "same-origin", redirect: "manual", headers: { Accept: "application/pdf" } });
  } catch {
    return { tone: "critical", messageKey: "packing.labels.error.network", skipped: [] };
  }
  if (response.type === "opaqueredirect" || response.redirected) return { tone: "critical", messageKey: "packing.labels.error.session", skipped: [] };
  const type = (response.headers.get("Content-Type") ?? "").split(";")[0]?.trim().toLowerCase();
  if (response.ok && type === "application/pdf") {
    const blob = new Blob([await response.arrayBuffer()], { type: "application/pdf" });
    const objectUrl = URL.createObjectURL(blob);
    const opened = window.open(objectUrl, "_blank");
    if (!opened) {
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = "labels.pdf";
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
    const skipped = parseSkipped(response.headers.get("X-OT-Labels-Skipped"));
    const included = Number(response.headers.get("X-OT-Labels-Included") ?? "0");
    return { tone: skipped.length > 0 ? "warning" : "success", messageKey: "packing.labels.result", params: { included, skipped: skipped.length }, skipped };
  }
  if (type === "application/json") {
    const body = (await response.json().catch(() => null)) as { error?: string; skipped?: Array<{ n: string; r: string }> } | null;
    return { tone: "warning", messageKey: body?.error ?? "packing.labels.error.generic", skipped: Array.isArray(body?.skipped) ? body.skipped : [] };
  }
  if (response.status === 403) return { tone: "critical", messageKey: "packing.labels.error.forbidden", skipped: [] };
  if (type === "text/html") return { tone: "critical", messageKey: "packing.labels.error.session", skipped: [] };
  return { tone: "critical", messageKey: "packing.labels.error.generic", skipped: [] };
}

function priorityLabel(p: OrderPriority, t: TFunction): string {
  return t(`packing.priority.${PRIORITY_KEYS[p]}`);
}

function PriorityBadge({ priority }: { priority: OrderPriority }) {
  const t = useT();
  if (priority === 0) return null;
  return (
    <Badge tone={PRIORITY_TONE[priority]} size="sm">
      {priorityLabel(priority, t)}
    </Badge>
  );
}

function countChecked(): string[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>(`input[name="${SELECTION_NAME}"][form="${BULK_FORM_ID}"]:checked`)).map((b) => b.value);
}

export default function PickingPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const { mode } = useShell();
  const location = useLocation();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const [selected, setSelected] = useState<string[]>([]);
  const [labels, setLabels] = useState<LabelsOutcome | null>(null);
  const [labelsBusy, setLabelsBusy] = useState(false);

  const { filters, rows } = data;
  const basePath = href("picking");
  const listKey = location.search;
  const needsWaybill = filters.tab === "needs_waybill";
  const canPriority = can("orders.edit");

  useEffect(() => {
    setSelected(countChecked());
  }, [rows]);

  const method = navigation.formMethod?.toUpperCase();
  const busyIntent = navigation.state !== "idle" && method === "POST" ? navigation.formData?.get("intent") : null;
  const isFiltering = navigation.state === "loading" && method === "GET" && navigation.location.pathname === location.pathname;

  const listHref = (f: Partial<QueueFilters>) => `${basePath}${buildQueueSearch(f)}`;
  const keep: Partial<QueueFilters> = { priority: filters.priority, country: filters.country, model: filters.model, color: filters.color, worker: filters.worker, q: filters.q };
  const tabs: TabItem[] = QUEUE_TABS.map((tab: QueueTab) => ({
    key: tab,
    label: t(`packing.tab.${tab}`),
    href: listHref({ ...keep, tab }),
    count: data.counts[tab],
  }));

  // Попередній підрахунок для масових дій (за даними рядків поточної сторінки).
  const selectedRows = rows.filter((r) => selected.includes(r.id));
  const preview = {
    total: selectedRows.length,
    startable: selectedRows.filter((r) => r.waybill?.packable && (r.status === "waybill_created" || (r.status === "awaiting_picking" && r.packing?.status !== "in_progress"))).length,
    inProgress: selectedRows.filter((r) => r.packing?.status === "in_progress" && r.status === "awaiting_picking").length,
    packed: selectedRows.filter((r) => r.status === "packed").length,
    withLabel: selectedRows.filter((r) => r.waybill?.labelAvailable).length,
    /** До комплектації (лист комплектації): накладна створена / очікує комплектації. */
    toPick: selectedRows.filter((r) => r.status === "waybill_created" || r.status === "awaiting_picking").length,
  };
  const notStartable = preview.total - preview.startable - preview.inProgress - preview.packed;
  const idsQuery = (limit: number) => selected.slice(0, limit).map((id) => `ids=${encodeURIComponent(id)}`).join("&");

  async function onLabels() {
    setLabels(null);
    setLabelsBusy(true);
    try {
      setLabels(await downloadLabels(`${href("picking/labels")}?${idsQuery(MAX_LABEL_ORDERS)}`));
    } finally {
      setLabelsBusy(false);
    }
  }

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "order",
      header: t("packing.col.order"),
      primary: true,
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={2} align="center">
          <span>{r.orderNumber}</span>
          <PriorityBadge priority={r.priority} />
          {r.source === "demo" ? (
            <Badge tone="outline" size="sm">
              {t("common.demo")}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "items",
      header: t("packing.col.items"),
      render: (r) => <ItemsSummary row={r} />,
    },
    {
      key: "status",
      header: t("packing.col.status"),
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={1} align="center" wrap>
          <OrderStatusBadge status={r.status} />
          {r.packing && r.packing.status !== "packed" && r.packing.requiredUnits > 0 ? (
            <Badge tone={r.packing.complete ? "success" : "info"} size="sm">
              {t("packing.progress.short", { packed: r.packing.packedUnits, required: r.packing.requiredUnits })}
            </Badge>
          ) : null}
          {!needsWaybill && !r.waybill?.packable ? (
            <Badge tone="warning" size="sm">
              {t(r.waybill?.deletedAtCarrier ? "packing.queue.deletedAtCarrier" : "packing.queue.noWaybill")}
            </Badge>
          ) : null}
          {r.shopifyLinesPending ? (
            <Badge tone="critical" size="sm">
              {t("packing.queue.shopifyLinesPending")}
            </Badge>
          ) : null}
          {needsWaybill && r.status === "packed" ? (
            <Badge tone="warning" size="sm">
              {t("packing.queue.packedNoWaybill")}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "worker",
      header: t("packing.col.worker"),
      hideOnMobile: needsWaybill,
      render: (r) => <WorkerCell row={r} />,
    },
    {
      key: "destination",
      header: t("packing.col.destination"),
      render: (r) =>
        r.countryCode || r.city ? (
          <Stack as="span" direction="horizontal" gap={1} align="center">
            {r.countryCode ? <InlineCode>{r.countryCode}</InlineCode> : null}
            {r.city ? <span>{r.city}</span> : null}
          </Stack>
        ) : (
          "—"
        ),
    },
    {
      key: "waybill",
      header: t("packing.col.waybill"),
      hideOnMobile: true,
      render: (r) =>
        r.waybill?.number ? (
          <Stack as="span" gap={0}>
            <Stack as="span" direction="horizontal" gap={1} align="center">
              <InlineCode>{r.waybill.number}</InlineCode>
              {r.waybill.testMode ? <TestBadge /> : null}
            </Stack>
            <Text as="span" variant="caption" tone="subdued">
              {t(r.waybill.labelAvailable ? "packing.queue.labelAvailable" : "packing.queue.labelUnavailable")}
            </Text>
          </Stack>
        ) : (
          "—"
        ),
    },
    {
      key: "placed",
      header: t("packing.col.placed"),
      hideOnMobile: true,
      render: (r) => <time dateTime={new Date(r.placedAt).toISOString()}>{formatDateTime(r.placedAt, locale)}</time>,
    },
    // «Потрібна накладна»: посилку можна зважити й виміряти ДО накладної (екран пакування → ручне коригування).
    ...(needsWaybill
      ? [
          {
            key: "parcel",
            header: t("packing.col.parcel"),
            render: (r: Row) =>
              r.status === "packed" ? (
                "—"
              ) : (
                <Button to={href(`picking/${r.id}`)} size="sm" variant="plain">
                  {t("packing.queue.setParcel")}
                </Button>
              ),
          } satisfies DataTableColumn<Row>,
        ]
      : []),
  ];

  const emptyState =
    activeFilterCount(filters) > 0 ? (
      <EmptyState
        title={t("packing.empty.filtered")}
        description={t("packing.empty.filteredHint")}
        action={<Button to={listHref({ tab: filters.tab })}>{t("common.reset")}</Button>}
      />
    ) : (
      <EmptyState
        title={t(needsWaybill ? "packing.empty.needsWaybill" : "packing.empty.queue")}
        description={t(needsWaybill ? "packing.empty.needsWaybillHint" : "packing.empty.queueHint")}
        action={<Button to={href("orders")}>{t("packing.empty.toOrders")}</Button>}
      />
    );

  const active = activeFilterCount(filters);
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = from === 0 ? 0 : from + rows.length - 1;
  const bulkBusy = busyIntent === "bulkStart" || busyIntent === "bulkPriority";

  return (
    <Page title={t("nav.picking")} subtitle={t("packing.queue.subtitle")}>
      <Stack gap={4}>
        <ActionBanner data={actionData} />
        {labels ? <LabelsBanner outcome={labels} isDemo={mode === "demo"} /> : null}

        <Tabs items={tabs} selected={filters.tab} ariaLabel={t("packing.tabs.label")} />
        {data.counts.packed > 0 && !needsWaybill ? (
          <Stack direction="horizontal" gap={2} align="center" wrap>
            <Button to={href("picking/handover")}>{t("packing.handover.open", { count: data.counts.packed })}</Button>
            <Text variant="caption" tone="subdued">
              {t("packing.handover.openHint")}
            </Text>
          </Stack>
        ) : null}

        <Card>
          <Disclosure collapsedOnMobile summary={active > 0 ? t("packing.filters.titleActive", { count: active }) : t("common.filters")}>
            <Form key={listKey} method="get" role="search">
              {filters.tab !== "queue" ? <input type="hidden" name="tab" value={filters.tab} /> : null}
              <Stack gap={4}>
                <Grid columns={{ xs: 1, md: 2, lg: 3 }} gap={3}>
                  <TextField
                    id="packing-filter-q"
                    type="search"
                    name="q"
                    label={t("packing.filters.order")}
                    placeholder={t("packing.filters.orderPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={80}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Select
                    id="packing-filter-priority"
                    name="priority"
                    label={t("packing.filters.priority")}
                    placeholder={t("packing.filters.any")}
                    options={PRIORITIES.map((p) => ({ value: String(p), label: priorityLabel(p, t) }))}
                    defaultValue={filters.priority === null ? "" : String(filters.priority)}
                  />
                  <Select
                    id="packing-filter-country"
                    name="country"
                    label={t("packing.filters.country")}
                    placeholder={t("packing.filters.any")}
                    options={data.options.countries.map((c) => ({ value: c.code, label: c.name }))}
                    defaultValue={filters.country ?? ""}
                  />
                  <Select
                    id="packing-filter-model"
                    name="model"
                    label={t("packing.filters.model")}
                    placeholder={t("packing.filters.any")}
                    options={data.options.models.map((m) => ({ value: m, label: m }))}
                    defaultValue={filters.model ?? ""}
                  />
                  <Select
                    id="packing-filter-color"
                    name="color"
                    label={t("packing.filters.color")}
                    placeholder={t("packing.filters.any")}
                    options={data.options.colors.map((c) => ({ value: c, label: c }))}
                    defaultValue={filters.color ?? ""}
                  />
                  <Select
                    id="packing-filter-worker"
                    name="worker"
                    label={t("packing.filters.worker")}
                    placeholder={t("packing.filters.any")}
                    options={data.options.workers.map((w) => ({ value: w.id, label: w.name }))}
                    defaultValue={filters.worker ?? ""}
                  />
                </Grid>
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" loading={isFiltering}>
                    {t("common.apply")}
                  </Button>
                  <Button to={listHref({ tab: filters.tab })} disabled={active === 0}>
                    {t("common.reset")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Disclosure>
        </Card>

        {rows.length > 0 && !needsWaybill ? (
          <Card>
            <Form id={BULK_FORM_ID} method="post" aria-label={t("packing.bulk.label")}>
              <Stack gap={3}>
                <div aria-live="polite" aria-atomic="true">
                  <Stack gap={1}>
                    <Text variant="body-sm" weight="semibold">
                      {t("common.selected", { count: preview.total })}
                    </Text>
                    {preview.total === 0 ? (
                      <Text variant="caption" tone="subdued">
                        {t("packing.bulk.hint")}
                      </Text>
                    ) : (
                      <Text variant="caption" tone="subdued">
                        {t("packing.bulk.preview", { startable: preview.startable, inProgress: preview.inProgress, packed: preview.packed, withLabel: preview.withLabel })}
                      </Text>
                    )}
                  </Stack>
                </div>
                <Stack direction="horizontal" gap={2} wrap>
                  <ConfirmSubmitButton
                    name="intent"
                    value="bulkStart"
                    variant="primary"
                    disabled={preview.total === 0 || bulkBusy}
                    loading={busyIntent === "bulkStart"}
                    title={t("packing.bulk.start.title")}
                    confirmLabel={t("packing.bulk.start.confirm")}
                    cancelLabel={t("common.cancel")}
                    message={
                      <Stack gap={2}>
                        <Text weight="semibold">{t("packing.bulk.start.count", { count: preview.startable })}</Text>
                        {preview.inProgress > 0 ? <Text>{t("packing.bulk.start.previewInProgress", { count: preview.inProgress })}</Text> : null}
                        {preview.packed + notStartable > 0 ? (
                          <Text>{t("packing.bulk.start.previewSkipped", { count: preview.packed + Math.max(0, notStartable) })}</Text>
                        ) : null}
                        <Text variant="body-sm" tone="subdued">
                          {t("packing.bulk.start.note")}
                        </Text>
                      </Stack>
                    }
                  >
                    {t("packing.bulk.start.button")}
                  </ConfirmSubmitButton>
                  <Button
                    disabled={preview.total === 0}
                    onClick={() => navigate(`${href("picking/print")}?${idsQuery(MAX_PRINT_ORDERS)}`)}
                  >
                    {t("packing.bulk.print")}
                  </Button>
                  <Button disabled={preview.total === 0 || labelsBusy} loading={labelsBusy} onClick={() => void onLabels()}>
                    {t("packing.bulk.labels", { count: preview.withLabel })}
                  </Button>
                  <Button
                    disabled={preview.toPick === 0}
                    onClick={() => navigate(`${href("picking/pick-list")}?${idsQuery(MAX_PICK_LIST_ORDERS)}`)}
                  >
                    {t("packing.bulk.pickList", { count: preview.toPick })}
                  </Button>
                  <Button
                    disabled={preview.packed === 0}
                    onClick={() => navigate(`${href("picking/handover")}?${idsQuery(MAX_HANDOVER_ORDERS)}`)}
                  >
                    {t("packing.bulk.handover", { count: preview.packed })}
                  </Button>
                </Stack>
                {preview.total > MAX_PRINT_ORDERS || preview.total > MAX_LABEL_ORDERS ? (
                  <Text variant="caption" tone="subdued">
                    {t("packing.bulk.limits", { print: MAX_PRINT_ORDERS, labels: MAX_LABEL_ORDERS })}
                  </Text>
                ) : null}
                {canPriority ? (
                  <Stack direction="horizontal" gap={2} align="end" wrap>
                    <Select
                      id="packing-bulk-priority"
                      name="priority"
                      label={t("packing.bulk.priority.label")}
                      options={PRIORITIES.map((p) => ({ value: String(p), label: priorityLabel(p, t) }))}
                      defaultValue="1"
                    />
                    <ConfirmSubmitButton
                      name="intent"
                      value="bulkPriority"
                      disabled={preview.total === 0 || bulkBusy}
                      loading={busyIntent === "bulkPriority"}
                      title={t("packing.bulk.priority.title")}
                      confirmLabel={t("packing.bulk.priority.confirm")}
                      cancelLabel={t("common.cancel")}
                      message={<Text>{t("packing.bulk.priority.count", { count: preview.total })}</Text>}
                    >
                      {t("packing.bulk.priority.button")}
                    </ConfirmSubmitButton>
                  </Stack>
                ) : null}
              </Stack>
            </Form>
          </Card>
        ) : null}

        {needsWaybill && rows.length > 0 ? (
          <Banner tone="info" action={<Button to={`${href("orders")}?status=awaiting_review`}>{t("packing.needsWaybill.toOrders")}</Button>}>
            {t("packing.needsWaybill.hint")}
          </Banner>
        ) : null}
        {needsWaybill && rows.some((r) => r.status === "packed") ? <Banner tone="warning">{t("packing.needsWaybill.packedHint")}</Banner> : null}

        <Card padded={false}>
          <DataTable<Row>
            key={listKey}
            caption={t("packing.table.caption")}
            rows={rows}
            rowKey={(r) => r.id}
            // «Потрібна накладна»: накладну створюють на сторінці замовлення; запаковане без накладної спершу
            // розпаковують на екрані пакування.
            rowHref={(r) => (needsWaybill && r.status !== "packed" ? href(`orders/${r.id}`) : href(`picking/${r.id}`))}
            columns={columns}
            emptyState={emptyState}
            selection={
              needsWaybill
                ? undefined
                : {
                    name: SELECTION_NAME,
                    formId: BULK_FORM_ID,
                    value: (r) => r.id,
                    label: (r) => t("common.selectRow", { label: r.orderNumber }),
                    allLabel: t("common.selectAll"),
                    onChange: setSelected,
                  }
            }
          />
        </Card>

        {data.total > 0 ? (
          <Stack direction="horizontal" gap={3} align="center" justify="between" wrap>
            <Text variant="body-sm" tone="subdued">
              {t("packing.list.range", { from, to, total: data.total })}
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

function ItemsSummary({ row }: { row: Row }) {
  const t = useT();
  const shown = row.lines.slice(0, 3);
  return (
    <Stack as="span" gap={1}>
      <Stack as="span" direction="horizontal" gap={1} align="center" wrap>
        {shown.map((l) => (
          <Thumbnail key={l.id} src={l.imageUrl} alt={l.title} size="sm" />
        ))}
        <Text as="span" variant="body-sm" weight="semibold">
          {t("packing.queue.units", { count: row.units })}
        </Text>
      </Stack>
      <Text as="span" variant="caption" tone="subdued">
        {row.lines
          .map((l) => {
            const traits = [l.model, l.color].filter(Boolean).join(", ");
            return `${l.quantity} × ${l.title}${traits ? ` (${traits})` : l.variantTitle ? ` (${l.variantTitle})` : ""}`;
          })
          .join("; ")}
      </Text>
    </Stack>
  );
}

function WorkerCell({ row }: { row: Row }) {
  const t = useT();
  const locale = useLocale();
  const p = row.packing;
  if (!p) return <>—</>;
  return (
    <Stack as="span" gap={0}>
      {p.startedByName ? (
        <Text as="span" variant="body-sm">
          {t("packing.queue.startedBy", { name: p.startedByName, time: formatDateTime(p.startedAt, locale) })}
        </Text>
      ) : null}
      {p.packedByName ? (
        <Text as="span" variant="caption" tone="subdued">
          {t("packing.queue.packedBy", { name: p.packedByName, time: formatDateTime(p.packedAt, locale) })}
        </Text>
      ) : null}
    </Stack>
  );
}

function LabelsBanner({ outcome, isDemo }: { outcome: LabelsOutcome; isDemo: boolean }) {
  const t = useT();
  const allUnsupported = outcome.skipped.length > 0 && outcome.skipped.every((s) => s.r === "not_supported");
  return (
    <Banner tone={outcome.tone} title={t("packing.labels.title")}>
      <p>{hasKey(outcome.messageKey) ? t(outcome.messageKey, outcome.params) : t("packing.labels.error.generic")}</p>
      {outcome.skipped.length > 0 ? (
        <ul>
          {outcome.skipped.map((s) => (
            <li key={`${s.n}-${s.r}`}>{t("packing.labels.skippedLine", { number: s.n, reason: hasKey(`packing.labels.reason.${s.r}`) ? t(`packing.labels.reason.${s.r}`) : s.r })}</li>
          ))}
        </ul>
      ) : null}
      {allUnsupported && isDemo ? <p>{t("packing.labels.demoNote")}</p> : null}
    </Banner>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

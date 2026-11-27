import { Fragment, useEffect, useState } from "react";
import {
  Form,
  Link,
  useActionData,
  useLoaderData,
  useLocation,
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
import { countOpenIssues } from "~/modules/orders/repository.server";
import { VALIDATABLE_STATUSES, acceptSuggestion, dismissIssue, validateOrders } from "~/modules/orders/workflow.server";
import {
  PROBLEM_CATEGORIES,
  PROBLEM_SOURCES,
  isProblemCategory,
  isProblemSource,
  type ProblemCategory,
  type ProblemSource,
} from "~/modules/problems/categories";
import { MAX_BULK_ORDERS, MAX_PROBLEM_QUERY_LENGTH, PROBLEM_PAGE_SIZE } from "~/modules/problems/limits";
import {
  dismissWarnings,
  queryProblems,
  type ProblemFilter,
  type ProblemGroup,
  type ProblemIssue,
} from "~/modules/problems/problems.server";
import { MAX_CANDIDATE_LENGTH } from "~/modules/validation/types";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError, type ActionError } from "~/server/http.server";
import {
  Disclosure,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  Divider,
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
  type TabItem,
} from "~/ui";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BULK_FORM_ID = "problems-bulk-form";
const SELECTION_NAME = "orderIds";

type ProblemsTab = "open" | "resolved";
type Severity = "error" | "warning";

export interface ProblemFilters {
  tab: ProblemsTab;
  category: ProblemCategory | null;
  severity: Severity | null;
  country: string | null;
  source: ProblemSource | null;
  suggestion: boolean;
  q: string;
  page: number;
}

function parseFilters(params: URLSearchParams): ProblemFilters {
  const severity = params.get("severity");
  const category = params.get("category");
  const source = params.get("source");
  const country = (params.get("country") ?? "").trim().toUpperCase();
  const pageRaw = (params.get("page") ?? "").trim();
  return {
    tab: params.get("tab") === "resolved" ? "resolved" : "open",
    category: isProblemCategory(category) ? category : null,
    severity: severity === "error" || severity === "warning" ? severity : null,
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    source: isProblemSource(source) ? source : null,
    suggestion: params.get("suggestion") === "1",
    q: (params.get("q") ?? "").trim().slice(0, MAX_PROBLEM_QUERY_LENGTH),
    page: /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1,
  };
}

/** Рядок запиту сторінки (значення за замовчуванням не пишемо). */
function buildSearch(f: Partial<ProblemFilters>): string {
  const params = new URLSearchParams();
  if (f.tab === "resolved") params.set("tab", "resolved");
  if (f.category) params.set("category", f.category);
  if (f.severity) params.set("severity", f.severity);
  if (f.country) params.set("country", f.country);
  if (f.source) params.set("source", f.source);
  if (f.suggestion) params.set("suggestion", "1");
  if (f.q) params.set("q", f.q);
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

function toQueryFilter(f: ProblemFilters): ProblemFilter {
  return {
    tab: f.tab === "resolved" ? "closed" : "open",
    category: f.category,
    severity: f.severity,
    country: f.country,
    source: f.source,
    hasSuggestion: f.suggestion,
    q: f.q || null,
    page: f.page,
    pageSize: PROBLEM_PAGE_SIZE,
  };
}

/** Фільтри у формі (без вкладки, швидких фільтрів і сторінки) — для підпису «Фільтри · N». */
function formFilterCount(f: ProblemFilters): number {
  return [f.q, f.country, f.source, f.suggestion].filter(Boolean).length;
}

const EDITABLE_FIELD_RE = /^(email|contactPhone|shipping\.[A-Za-z0-9]+)$/;

interface IssueView {
  id: string;
  code: string;
  category: ProblemCategory;
  source: ProblemSource;
  severity: Severity;
  field: string | null;
  params: Record<string, string | number>;
  /** Варіанти виправлення (лише для відкритих проблем). Значення полів показуються лише тут. */
  candidates: string[];
  /** Текст відповіді перевізника (для проблем CARRIER_*), уже без персональних даних. */
  carrierMessage: string | null;
  createdAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

/** Картка замовлення: лише номер, статус і країна (без імені, адреси, контактів). */
interface GroupView {
  key: string;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  countryCode: string | null;
  countryLabel: string | null;
  /** Чи можна змінювати дані замовлення (застосовувати пропозиції, перевіряти повторно) у поточному статусі. */
  editable: boolean;
  errorCount: number;
  warningCount: number;
  issues: IssueView[];
}

function toIssueView(issue: ProblemIssue, tab: ProblemsTab): IssueView {
  const message = issue.params.message;
  return {
    id: issue.id,
    code: issue.code,
    category: issue.category,
    source: issue.source,
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

function toGroupView(group: ProblemGroup, tab: ProblemsTab, locale: Locale): GroupView {
  return {
    key: group.orderId ?? "none",
    orderId: group.orderId,
    orderNumber: group.orderNumber,
    orderStatus: group.orderStatus,
    countryCode: group.countryCode,
    countryLabel: group.countryCode ? countryName(group.countryCode, locale) : null,
    editable: group.orderStatus !== null && VALIDATABLE_STATUSES.includes(group.orderStatus),
    errorCount: group.errorCount,
    warningCount: group.warningCount,
    issues: group.issues.map((i) => toIssueView(i, tab)),
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "problems.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const filters = parseFilters(new URL(request.url).searchParams);
  const [result, totals] = await Promise.all([queryProblems(ctx.db, toQueryFilter(filters)), countOpenIssues(ctx.db)]);

  const countries = result.countries.map((code) => ({ code, name: countryName(code, ctx.locale) }));
  if (filters.country && !countries.some((c) => c.code === filters.country)) {
    countries.push({ code: filters.country, name: countryName(filters.country, ctx.locale) });
  }
  const collator = new Intl.Collator(ctx.locale === "uk" ? "uk" : "en");
  countries.sort((a, b) => collator.compare(a.name, b.name));

  return {
    filters: { ...filters, page: result.page },
    isFiltered: Boolean(filters.category || filters.severity || formFilterCount(filters) > 0),
    totals,
    facets: result.facets,
    countries,
    groups: result.groups.map((g) => toGroupView(g, filters.tab, ctx.locale)),
    totalGroups: result.totalGroups,
    totalIssues: result.totalIssues,
    page: result.page,
    pages: result.pages,
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

function parseOrderIds(form: FormData): string[] {
  const ids = new Set<string>();
  for (const value of form.getAll(SELECTION_NAME)) {
    if (ids.size >= MAX_BULK_ORDERS) break;
    if (typeof value === "string" && UUID_RE.test(value)) ids.add(value.toLowerCase());
  }
  return [...ids];
}

const INTENTS = new Set(["acceptSuggestion", "dismissIssue", "bulkRevalidate", "bulkDismissWarnings"]);

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    // Будь-яка зміна в розділі «Проблеми» — це зміна даних замовлення.
    requirePermission(ctx.actor, "orders.edit");
    const form = await request.formData();
    const intent = formString(form, "intent");
    if (!INTENTS.has(intent)) return { ok: false, error: "error.generic" };

    if (intent === "bulkRevalidate" || intent === "bulkDismissWarnings") {
      const ids = parseOrderIds(form);
      if (ids.length === 0) return { ok: false, error: "problems.bulk.noneSelected" };
      if (intent === "bulkRevalidate") {
        const result = await validateOrders(ctx, ids);
        const blocking = result.ok.filter((s) => s.blocking).length;
        const extra: string[] = [];
        if (blocking > 0) extra.push("problems.bulk.revalidated.blocking");
        if (result.failed.length > 0) extra.push("problems.bulk.revalidated.skipped");
        return {
          ok: true,
          message: "problems.bulk.revalidated",
          params: { ok: result.ok.length, failed: result.failed.length, blocking },
          extra,
          tone: blocking > 0 || result.failed.length > 0 ? "warning" : "success",
        };
      }
      // Приховуються лише попередження, що відповідають фільтрам, з якими менеджер бачив список.
      const filters = parseFilters(new URL(request.url).searchParams);
      if (filters.tab !== "open") return { ok: false, error: "error.generic" };
      const res = await dismissWarnings(ctx, ids, {
        category: filters.category,
        severity: filters.severity,
        country: filters.country,
        source: filters.source,
        hasSuggestion: filters.suggestion,
        q: filters.q || null,
      });
      if (res.dismissed === 0) return { ok: true, message: "problems.bulk.dismissed.none", tone: "info" };
      return {
        ok: true,
        message: "problems.bulk.dismissed",
        params: { dismissed: res.dismissed, orders: res.orders, failed: res.failed },
        extra: res.failed > 0 ? ["problems.bulk.dismissed.failed"] : [],
        tone: res.failed > 0 ? "warning" : "success",
      };
    }

    const issueId = formString(form, "issueId");
    if (!UUID_RE.test(issueId)) return { ok: false, error: "problems.error.notFound" };

    if (intent === "dismissIssue") {
      await dismissIssue(ctx, issueId.toLowerCase());
      return { ok: true, message: "result.issue.dismissed" };
    }

    // Значення має бути одним зі збережених варіантів — перевіряє acceptSuggestion (issue.invalidCandidate).
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

/** Якір поля у формі виправлення на сторінці замовлення (id поля UI-кіту: ot-<name>). */
function fieldAnchor(field: string | null): string | null {
  if (!field || !EDITABLE_FIELD_RE.test(field)) return null;
  return `#ot-${field.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
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
  const location = useLocation();
  const navigation = useNavigation();

  const { filters, facets, groups, totals } = data;
  const canEdit = can("orders.edit");
  const canBulk = canEdit && can("orders.bulk");
  const isOpen = filters.tab === "open";
  const problemsPath = href("problems");
  const listHref = (f: Partial<ProblemFilters>) => `${problemsPath}${buildSearch(f)}`;
  // Посилання вкладок і швидких фільтрів зберігають решту фільтрів і повертають на першу сторінку.
  const keep: Partial<ProblemFilters> = { ...filters, page: 1 };

  const submitting = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const field = (name: string) => {
    const v = submitting ? navigation.formData?.get(name) : null;
    return typeof v === "string" ? v : null;
  };
  const pending: PendingSubmit = { intent: field("intent"), issueId: field("issueId"), candidate: field("candidate") };
  const isFiltering =
    navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET" && navigation.location.pathname === location.pathname;

  // Вибір замовлень для масових дій (лише відкриті проблеми, лише замовлення).
  const selectable = isOpen && canEdit ? groups.filter((g) => g.orderId) : [];
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const ids = new Set(groups.map((g) => g.orderId).filter((id): id is string => Boolean(id)));
    setSelected((prev) => new Set([...prev].filter((id) => ids.has(id))));
  }, [groups]);
  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const selectedGroups = selectable.filter((g) => selected.has(g.orderId!));
  const allSelected = selectable.length > 0 && selectedGroups.length === selectable.length;

  const tabs: TabItem[] = [
    { key: "open", label: t("problems.tabs.open"), href: listHref({ ...keep, tab: "open" }), count: totals.total },
    { key: "resolved", label: t("problems.tabs.resolved"), href: listHref({ ...keep, tab: "resolved" }) },
  ];

  const categoryCount = (c: ProblemCategory) => facets.categories[c];
  const categoryTotal = PROBLEM_CATEGORIES.reduce((sum, c) => sum + categoryCount(c), 0);
  const categoryChips: Array<{ value: ProblemCategory | null; label: string; count: number }> = [
    { value: null, label: t("common.all"), count: categoryTotal },
    ...PROBLEM_CATEGORIES.filter((c) => categoryCount(c) > 0 || filters.category === c).map((c) => ({
      value: c,
      label: t(`problems.category.${c}`),
      count: categoryCount(c),
    })),
  ];
  const severityChips: Array<{ value: Severity | null; label: string; count: number }> = [
    { value: null, label: t("common.all"), count: facets.severities.error + facets.severities.warning },
    { value: "error", label: t("problems.filter.errors"), count: facets.severities.error },
    { value: "warning", label: t("problems.filter.warnings"), count: facets.severities.warning },
  ];

  const activeFormFilters = formFilterCount(filters);
  const emptyState = data.isFiltered ? (
    <EmptyState
      title={t("problems.empty.filtered.title")}
      description={t("problems.empty.filtered.description")}
      action={<Button to={listHref({ tab: filters.tab })}>{t("problems.empty.showAll")}</Button>}
    />
  ) : isOpen ? (
    <EmptyState title={t("problems.empty.open.title")} description={t("problems.empty.open.description")} />
  ) : (
    <EmptyState title={t("problems.empty.resolved.title")} description={t("problems.empty.resolved.description")} />
  );

  return (
    <Page title={t("nav.problems")} subtitle={t("problems.subtitle")}>
      <Stack gap={4}>
        <ActionBanner data={actionData} />

        {isOpen ? (
          <Grid columns={{ xs: 3 }} gap={2}>
            {(["errors", "warnings", "orders"] as const).map((key) => (
              <Stack key={key} gap={0}>
                <Text as="span" variant="heading-md" numeric>
                  {formatNumber(totals[key], locale)}
                </Text>
                <Text as="span" variant="caption" tone="subdued">
                  {t(`problems.kpi.${key}.label`)}
                </Text>
              </Stack>
            ))}
          </Grid>
        ) : null}

        <Tabs items={tabs} selected={filters.tab} ariaLabel={t("problems.tabs.label")} />

        <Stack gap={2}>
          <ChipRow
            label={t("problems.chips.category")}
            chips={categoryChips.map((c) => ({
              key: c.value ?? "all",
              label: c.label,
              count: c.count,
              selected: filters.category === c.value,
              href: listHref({ ...keep, category: c.value }),
            }))}
          />
          <ChipRow
            label={t("problems.filter.label")}
            chips={severityChips.map((c) => ({
              key: c.value ?? "all",
              label: c.label,
              count: c.count,
              selected: filters.severity === c.value,
              href: listHref({ ...keep, severity: c.value }),
            }))}
          />
        </Stack>

        <Card>
          <Disclosure
            collapsedOnMobile
            summary={
              activeFormFilters > 0 ? t("problems.filters.titleActive", { count: activeFormFilters }) : t("common.filters")
            }
          >
            <Form key={location.search} method="get" role="search">
              {filters.tab === "resolved" ? <input type="hidden" name="tab" value="resolved" /> : null}
              {filters.category ? <input type="hidden" name="category" value={filters.category} /> : null}
              {filters.severity ? <input type="hidden" name="severity" value={filters.severity} /> : null}
              <Stack gap={3}>
                <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                  <TextField
                    id="problems-filter-q"
                    type="search"
                    name="q"
                    label={t("problems.filters.order")}
                    placeholder={t("problems.filters.orderPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={MAX_PROBLEM_QUERY_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Select
                    id="problems-filter-country"
                    name="country"
                    label={t("problems.filters.country")}
                    placeholder={t("problems.filters.allCountries")}
                    options={data.countries.map((c) => ({ value: c.code, label: `${c.code} — ${c.name}` }))}
                    defaultValue={filters.country ?? ""}
                  />
                  <Select
                    id="problems-filter-source"
                    name="source"
                    label={t("problems.filters.source")}
                    placeholder={t("problems.filters.allSources")}
                    options={PROBLEM_SOURCES.map((s) => ({ value: s, label: t(`problems.source.${s}`) }))}
                    defaultValue={filters.source ?? ""}
                  />
                </Grid>
                <Checkbox
                  id="problems-filter-suggestion"
                  name="suggestion"
                  value="1"
                  label={t("problems.filters.suggestionOnly")}
                  defaultChecked={filters.suggestion}
                />
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" size="sm" loading={isFiltering}>
                    {t("common.apply")}
                  </Button>
                  <Button to={listHref({ tab: filters.tab })} size="sm" disabled={!data.isFiltered}>
                    {t("common.reset")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Disclosure>
        </Card>

        {groups.length > 0 ? (
          <Text variant="body-sm" tone="subdued">
            {t("problems.summary", { issues: data.totalIssues, orders: data.totalGroups })}
          </Text>
        ) : null}

        {selectable.length > 0 ? (
          <BulkBar
            action={listHref(filters)}
            selectedGroups={selectedGroups}
            canBulk={canBulk}
            allSelected={allSelected}
            selectableCount={selectable.length}
            onSelectAll={(on) => setSelected(on ? new Set(selectable.map((g) => g.orderId!)) : new Set())}
            busyIntent={pending.intent}
          />
        ) : null}

        {groups.length === 0 ? (
          <Card>{emptyState}</Card>
        ) : (
          <Stack gap={4} as="section">
            {groups.map((group) => (
              <OrderProblemsCard
                key={group.key}
                group={group}
                tab={filters.tab}
                canEdit={canEdit}
                pending={pending}
                orderHref={group.orderId ? href(`orders/${group.orderId}`) : null}
                selection={
                  group.orderId && selectable.length > 0
                    ? { checked: selected.has(group.orderId), onChange: (on) => toggle(group.orderId!, on) }
                    : null
                }
              />
            ))}
          </Stack>
        )}

        <Pagination
          prevHref={data.page > 1 ? listHref({ ...filters, page: data.page - 1 }) : null}
          nextHref={data.page < data.pages ? listHref({ ...filters, page: data.page + 1 }) : null}
          label={t("common.pageOf", { page: data.page, pages: data.pages })}
          prevLabel={t("common.previous")}
          nextLabel={t("common.next")}
          ariaLabel={t("common.pagination")}
        />
      </Stack>
    </Page>
  );
}

function ChipRow({
  label,
  chips,
}: {
  label: string;
  chips: Array<{ key: string; label: string; count: number; selected: boolean; href: string }>;
}) {
  const t = useT();
  const locale = useLocale();
  return (
    <nav aria-label={label}>
      <Stack direction="horizontal" gap={2} align="center">
        <Text as="span" variant="body-sm" tone="subdued">
          {label}
        </Text>
        {chips.map((chip) => {
          const text = `${chip.label} · ${formatNumber(chip.count, locale)}`;
          return (
            <Button
              key={chip.key}
              to={chip.href}
              size="sm"
              variant={chip.selected ? "primary" : "secondary"}
              aria-label={chip.selected ? t("problems.filter.current", { label: text }) : undefined}
            >
              {text}
            </Button>
          );
        })}
      </Stack>
    </nav>
  );
}

function BulkBar({
  action,
  selectedGroups,
  canBulk,
  allSelected,
  selectableCount,
  onSelectAll,
  busyIntent,
}: {
  action: string;
  selectedGroups: Group[];
  canBulk: boolean;
  allSelected: boolean;
  selectableCount: number;
  onSelectAll: (on: boolean) => void;
  busyIntent: string | null;
}) {
  const t = useT();
  const count = selectedGroups.length;
  const checkable = selectedGroups.filter((g) => g.editable).length;
  const warnings = selectedGroups.reduce((sum, g) => sum + g.warningCount, 0);
  const busy = busyIntent === "bulkRevalidate" || busyIntent === "bulkDismissWarnings";
  return (
    <Card>
      <Form id={BULK_FORM_ID} method="post" action={action} aria-label={t("problems.bulk.label")}>
        <Stack direction="horizontal" gap={3} align="center" justify="between">
          <div aria-live="polite" aria-atomic="true">
            <Stack gap={1}>
              <Checkbox
                id="problems-select-all"
                name="selectAll"
                label={t("problems.bulk.selectPage", { count: selectableCount })}
                checked={allSelected}
                onChange={(e) => onSelectAll(e.currentTarget.checked)}
              />
              <Text variant="caption" tone="subdued">
                {count === 0 ? t("problems.bulk.hint") : t("common.selected", { count })}
              </Text>
            </Stack>
          </div>
          <Stack direction="horizontal" gap={2}>
            {canBulk ? (
              <ConfirmSubmitButton
                name="intent"
                value="bulkRevalidate"
                size="sm"
                disabled={checkable === 0 || busy}
                loading={busyIntent === "bulkRevalidate"}
                title={t("problems.bulk.revalidate.title")}
                confirmLabel={t("problems.bulk.revalidate.confirm")}
                cancelLabel={t("common.cancel")}
                message={
                  <Stack gap={2}>
                    <Text weight="semibold">{t("problems.bulk.revalidate.count", { count: checkable })}</Text>
                    {count > checkable ? (
                      <Text>{t("problems.bulk.revalidate.skipped", { count: count - checkable })}</Text>
                    ) : null}
                    <Text>{t("problems.bulk.revalidate.help")}</Text>
                  </Stack>
                }
              >
                {t("problems.bulk.revalidate.button")}
              </ConfirmSubmitButton>
            ) : null}
            <ConfirmSubmitButton
              name="intent"
              value="bulkDismissWarnings"
              size="sm"
              disabled={warnings === 0 || busy}
              loading={busyIntent === "bulkDismissWarnings"}
              title={t("problems.bulk.dismiss.title")}
              confirmLabel={t("problems.bulk.dismiss.confirm")}
              cancelLabel={t("common.cancel")}
              message={
                <Stack gap={2}>
                  <Text weight="semibold">{t("problems.bulk.dismiss.count", { warnings, orders: count })}</Text>
                  <Text>{t("problems.bulk.dismiss.help")}</Text>
                </Stack>
              }
            >
              {t("problems.bulk.dismiss.button")}
            </ConfirmSubmitButton>
          </Stack>
        </Stack>
      </Form>
    </Card>
  );
}

function OrderProblemsCard({
  group,
  tab,
  canEdit,
  pending,
  orderHref,
  selection,
}: {
  group: Group;
  tab: ProblemsTab;
  canEdit: boolean;
  pending: PendingSubmit;
  orderHref: string | null;
  selection: { checked: boolean; onChange: (on: boolean) => void } | null;
}) {
  const t = useT();
  const number = group.orderNumber ?? "";
  return (
    <Card
      title={orderHref && group.orderNumber ? <Link to={orderHref}>{group.orderNumber}</Link> : t("problems.group.noOrder")}
      titleAs="h2"
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
        selection || orderHref ? (
          <>
            {selection ? (
              <Checkbox
                id={`problems-select-${group.orderId}`}
                name={SELECTION_NAME}
                value={group.orderId ?? ""}
                form={BULK_FORM_ID}
                label={t("problems.bulk.selectOrder", { number })}
                checked={selection.checked}
                onChange={(e) => selection.onChange(e.currentTarget.checked)}
              />
            ) : null}
            {orderHref ? (
              <Button to={orderHref} size="sm" aria-label={t("problems.openOrderLabel", { number })}>
                {t("problems.openOrder")}
              </Button>
            ) : null}
          </>
        ) : null
      }
    >
      <Stack gap={4}>
        {group.issues.map((issue, index) => (
          <Fragment key={issue.id}>
            {index > 0 ? <Divider /> : null}
            <IssueItem issue={issue} group={group} tab={tab} canEdit={canEdit} pending={pending} orderHref={orderHref} />
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
  orderHref,
}: {
  issue: Issue;
  group: Group;
  tab: ProblemsTab;
  canEdit: boolean;
  pending: PendingSubmit;
  orderHref: string | null;
}) {
  const t = useT();
  const locale = useLocale();
  const fieldKey = fieldLabelKey(issue.field);
  const resolutionKey = `problems.resolution.${issue.resolution ?? "other"}`;
  const titleKey = `issue.${issue.code}.title`;
  const helpKey = `issue.${issue.code}.help`;

  const isOpen = tab === "open";
  const busy = pending.issueId === issue.id;
  const hasCandidates = issue.candidates.length > 0;
  const fixHintKey = isOpen && canEdit && issue.severity === "error" && !hasCandidates ? fixHintKeyFor(issue.field) : null;
  const anchor = isOpen && canEdit && group.editable ? fieldAnchor(issue.field) : null;

  const meta = [
    t(`problems.category.${issue.category}`),
    fieldKey ? t("problems.issue.fieldValue", { field: t(fieldKey) }) : null,
    isOpen
      ? t("problems.issue.detectedAt", { time: formatDateTime(issue.createdAt, locale) })
      : t("problems.issue.resolvedAtValue", { time: formatDateTime(issue.resolvedAt, locale) }),
  ].filter(Boolean);

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} align="center">
        <SeverityBadge severity={issue.severity} />
        <Text as="h3" variant="heading-sm">
          {hasKey(titleKey) ? t(titleKey) : issue.code}
        </Text>
      </Stack>
      <Text variant="caption" tone="subdued">
        {meta.join(" · ")}
      </Text>
      {hasKey(helpKey) ? <Text>{t(helpKey, localizeParams(issue.params, t, locale))}</Text> : null}
      {issue.carrierMessage ? (
        <Text variant="body-sm" tone="subdued">
          {t("problems.issue.carrierMessage", { message: localizeCode(issue.carrierMessage, t) })}
        </Text>
      ) : null}
      {!isOpen ? (
        <Text variant="body-sm">
          {t("problems.issue.resolutionValue", {
            resolution: t(hasKey(resolutionKey) ? resolutionKey : "problems.resolution.other"),
          })}
        </Text>
      ) : null}

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
                  >
                    <span translate="no">{t("problems.suggestion.applyValue", { value: candidate })}</span>
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
            <Button type="submit" size="sm" variant="plain" loading={busy && pending.intent === "dismissIssue"} disabled={busy}>
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
      {anchor && orderHref ? (
        <div>
          <Button to={`${orderHref}${anchor}`} size="sm" variant="plain">
            {t("problems.issue.goToField")}
          </Button>
        </div>
      ) : null}
    </Stack>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

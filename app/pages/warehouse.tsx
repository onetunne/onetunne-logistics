import { useEffect, useMemo, useState } from "react";
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
import type { StockAlertKind } from "~/db/schema";
import { can, requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { formatDateTime, formatNumber } from "~/lib/format";
import { STOCK_LEVEL_STATUSES, type StockLevelStatus } from "~/modules/inventory/alerts";
import { ensureStockItemsForVariants } from "~/modules/inventory/ledger.server";
import { getInventoryOpeningStatus, initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { getSetting } from "~/modules/settings/settings.server";
import {
  ALERT_KINDS_BY_SEVERITY,
  DEFAULT_STOCK_SORT,
  MAX_BULK_ITEMS,
  MAX_COUNTED_QUANTITY,
  MAX_NOTE_LENGTH,
  MAX_SEARCH_LENGTH,
  MAX_THRESHOLD,
  STOCK_PAGE_SIZE,
  STOCK_SORTS,
  STOCK_TRACKING_STATES,
  UUID_RE,
  WAREHOUSE_RELATED_LINKS,
  WAREHOUSE_SECTION_LINKS,
  displayVariantTitle,
  isStockSort,
  isStockTrackingState,
  parseFormInt,
  type StockSort,
  type StockTrackingState,
} from "~/modules/warehouse/constants";
import {
  StocktakeAlreadySavedError,
  StocktakeConflictError,
  newOperationId,
  setLowStockThresholds,
  stocktake,
} from "~/modules/warehouse/operations.server";
import {
  existingVariantIds,
  listStock,
  loadAlertSummary,
  stockFilterOptions,
  stockStatusCounts,
  type StockListFilters,
  type StockRow,
} from "~/modules/warehouse/stock.server";
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
  InlineCode,
  KeyValueList,
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
 * «Склад» — залишки кожного варіанта (фактично, зарезервовано, ДОСТУПНО = фактично − зарезервовано, у виробництві,
 * брак), стан, значення Shopify для порівняння, попередження, масові дії (поріг «мало», лист інвентаризації) та
 * ініціалізація обліку (власник). `?view=stocktake` — лист інвентаризації для вибраних/відфільтрованих позицій.
 * Дозволи перевіряються на сервері в loader/action і в сервісах (modules/warehouse/operations.server.ts).
 */

const BULK_FORM_ID = "warehouse-bulk-form";
const SELECTION_NAME = "variantIds";

export interface StockPageFilters {
  q: string;
  model: string | null;
  color: string | null;
  product: string | null;
  status: StockLevelStatus | null;
  tracking: StockTrackingState | null;
  inactive: boolean;
  sort: StockSort;
  page: number;
}

const isLevel = (v: unknown): v is StockLevelStatus => typeof v === "string" && (STOCK_LEVEL_STATUSES as readonly string[]).includes(v);

function parseFilters(params: URLSearchParams): StockPageFilters {
  const text = (name: string) => (params.get(name) ?? "").trim().slice(0, MAX_SEARCH_LENGTH) || null;
  const product = text("product");
  const pageRaw = (params.get("page") ?? "").trim();
  const status = params.get("status");
  const tracking = params.get("tracking");
  const sort = params.get("sort");
  return {
    q: text("q") ?? "",
    model: text("model"),
    color: text("color"),
    product: product && UUID_RE.test(product) ? product.toLowerCase() : null,
    status: isLevel(status) ? status : null,
    tracking: isStockTrackingState(tracking) ? tracking : null,
    inactive: params.get("inactive") === "1",
    sort: isStockSort(sort) ? sort : DEFAULT_STOCK_SORT,
    page: /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1,
  };
}

/** Рядок запиту (значення за замовчуванням не пишемо). */
function buildSearch(f: Partial<StockPageFilters> & { view?: "stocktake"; items?: string[] }): string {
  const params = new URLSearchParams();
  if (f.view) params.set("view", f.view);
  if (f.items?.length) params.set("items", f.items.join(","));
  if (f.q) params.set("q", f.q);
  if (f.model) params.set("model", f.model);
  if (f.color) params.set("color", f.color);
  if (f.product) params.set("product", f.product);
  if (f.status) params.set("status", f.status);
  if (f.tracking) params.set("tracking", f.tracking);
  if (f.inactive) params.set("inactive", "1");
  if (f.sort && f.sort !== DEFAULT_STOCK_SORT) params.set("sort", f.sort);
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

function toListFilters(f: StockPageFilters, opts: { ignoreStatus?: boolean } = {}): StockListFilters {
  return {
    search: f.q || undefined,
    models: f.model ? [f.model] : undefined,
    colors: f.color ? [f.color] : undefined,
    productIds: f.product ? [f.product] : undefined,
    statuses: !opts.ignoreStatus && f.status ? [f.status] : undefined,
    tracking: f.tracking ? [f.tracking] : undefined,
    includeInactive: f.inactive,
  };
}

/** Вибрані варіанти для листа інвентаризації (?items=id,id,…). */
function parseItems(params: URLSearchParams): string[] {
  const ids = new Set<string>();
  for (const raw of (params.get("items") ?? "").split(",")) {
    const id = raw.trim().toLowerCase();
    if (UUID_RE.test(id)) ids.add(id);
    if (ids.size >= MAX_BULK_ITEMS) break;
  }
  return [...ids];
}

type RowView = Omit<StockRow, "shopifySyncedAt" | "openedAt" | "updatedAt" | "variantTitle"> & {
  variantTitle: string | null;
  shopifySyncedAt: string | null;
  updatedAt: string | null;
  /** Шлях картки позиції (id позиції обліку або варіанта, якщо руху ще не було). */
  itemPath: string;
};

function toRowView(r: StockRow): RowView {
  return {
    ...r,
    variantTitle: displayVariantTitle(r.variantTitle),
    shopifySyncedAt: r.shopifySyncedAt ? r.shopifySyncedAt.toISOString() : null,
    updatedAt: r.updatedAt ? r.updatedAt.toISOString() : null,
    itemPath: `warehouse/items/${r.stockItemId ?? r.variantId}`,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  const filters = parseFilters(url.searchParams);
  const view: "list" | "stocktake" = url.searchParams.get("view") === "stocktake" ? "stocktake" : "list";
  const canAdjust = can(ctx.actor, "warehouse.adjust");

  const warehouse = await getDefaultWarehouse(ctx.db);
  const [opening, alerts, options, settings] = await Promise.all([
    getInventoryOpeningStatus(ctx.db),
    loadAlertSummary(ctx.db),
    stockFilterOptions(ctx.db),
    getSetting(ctx.db, "warehouse"),
  ]);
  const common = {
    // Сумісність: заголовок складу й момент запуску обліку.
    warehouseName: warehouse.name,
    initializedAt: warehouse.inventoryInitializedAt ? warehouse.inventoryInitializedAt.toISOString() : null,
    filters,
    options,
    defaultThreshold: settings.lowStockThreshold,
    alerts,
    opening: {
      trackedVariants: opening.trackedVariants,
      openedVariants: opening.openedVariants,
      unopenedTracked: opening.unopenedTracked,
      untrackedVariants: opening.untrackedVariants,
    },
    canAdjust,
    operationIds: { stocktake: newOperationId() },
  };

  if (view === "stocktake") {
    const items = parseItems(url.searchParams);
    const sheetFilters: StockListFilters = items.length > 0 ? { variantIds: items, includeInactive: true } : toListFilters(filters);
    const { rows, total } = await listStock(ctx.db, sheetFilters, { sort: filters.sort, limit: MAX_BULK_ITEMS });
    return {
      ...common,
      view,
      sheet: {
        source: items.length > 0 ? ("selection" as const) : ("filter" as const),
        items,
        rows: rows.map(toRowView),
        total,
        truncated: total > rows.length,
      },
      rows: [] as RowView[],
      total: 0,
      page: 1,
      pages: 1,
      pageSize: STOCK_PAGE_SIZE,
      statusCounts: null,
      isFiltered: false,
    };
  }

  const listFilters = toListFilters(filters);
  let page = filters.page;
  let result = await listStock(ctx.db, listFilters, { sort: filters.sort, limit: STOCK_PAGE_SIZE, offset: (page - 1) * STOCK_PAGE_SIZE });
  const pages = Math.max(1, Math.ceil(result.total / STOCK_PAGE_SIZE));
  if (page > pages) {
    page = pages;
    result = await listStock(ctx.db, listFilters, { sort: filters.sort, limit: STOCK_PAGE_SIZE, offset: (page - 1) * STOCK_PAGE_SIZE });
  }
  const statusCounts = await stockStatusCounts(ctx.db, toListFilters(filters, { ignoreStatus: true }));
  return {
    ...common,
    view,
    sheet: null,
    filters: { ...filters, page },
    rows: result.rows.map(toRowView),
    total: result.total,
    page,
    pages,
    pageSize: STOCK_PAGE_SIZE,
    statusCounts,
    isFiltered: Boolean(
      filters.q || filters.model || filters.color || filters.product || filters.status || filters.tracking || filters.inactive,
    ),
  };
}

export type WarehouseActionResult =
  | (Extract<ActionResult, { ok: true }> & { intent: string })
  | (Extract<ActionResult, { ok: false }> & {
      intent?: string;
      /** Позиції листа, які не збережено: залишок змінився, поки рахували, або лист уже збережено з іншим значенням. */
      conflicts?: Array<{ variantId: string; expected: number | null; current: number; counted: number; alreadySaved?: boolean }>;
    });

const INTENTS = new Set(["bulkThreshold", "stocktake", "initialize"]);

function parseVariantIds(form: FormData, name: string): string[] {
  const ids = new Set<string>();
  for (const value of form.getAll(name)) {
    if (typeof value === "string" && UUID_RE.test(value)) ids.add(value.toLowerCase());
  }
  return [...ids];
}

export async function action({ request }: ActionFunctionArgs): Promise<WarehouseActionResult> {
  const ctx = await getRequestContext(request);
  let intent = "";
  try {
    requirePermission(ctx.actor, "warehouse.view");
    const form = await request.formData();
    intent = formString(form, "intent");
    if (!INTENTS.has(intent)) return { ok: false, error: "error.generic" };

    if (intent === "initialize") {
      requirePermission(ctx.actor, "warehouse.adjust");
      const r = await initializeInventory(ctx);
      const extra: string[] = [];
      if (r.clampedNegative > 0) extra.push("warehouse.init.result.clamped");
      if (r.openedWithHistory > 0) extra.push("warehouse.init.result.history");
      if (r.skippedUntracked > 0) extra.push("warehouse.init.result.untracked");
      return {
        ok: true,
        intent,
        message: r.opened > 0 ? "warehouse.init.result.opened" : "warehouse.init.result.nothing",
        params: {
          opened: r.opened,
          alreadyOpened: r.alreadyOpened,
          untracked: r.skippedUntracked,
          clamped: r.clampedNegative,
          history: r.openedWithHistory,
          orders: r.ordersSynced,
        },
        extra,
        tone: r.clampedNegative > 0 || r.openedWithHistory > 0 ? "warning" : r.opened > 0 ? "success" : "info",
      };
    }

    if (intent === "bulkThreshold") {
      requirePermission(ctx.actor, "warehouse.adjust");
      const variantIds = parseVariantIds(form, SELECTION_NAME);
      if (variantIds.length === 0) return { ok: false, intent, error: "warehouse.error.noItems" };
      if (variantIds.length > MAX_BULK_ITEMS)
        return { ok: false, intent, error: "warehouse.error.tooManyItems", params: { max: MAX_BULK_ITEMS } };
      const threshold = parseFormInt(formString(form, "threshold"), 0, MAX_THRESHOLD);
      if (threshold === undefined) return { ok: false, intent, error: "warehouse.error.threshold", params: { max: MAX_THRESHOLD } };
      if ((await existingVariantIds(ctx.db, variantIds)).length !== variantIds.length)
        return { ok: false, intent, error: "error.notFound" };
      const stockByVariant = await ensureStockItemsForVariants(ctx.db, variantIds);
      const res = await setLowStockThresholds(ctx, { stockItemIds: [...stockByVariant.values()], threshold });
      return {
        ok: true,
        intent,
        message: threshold === null ? "warehouse.bulk.threshold.resetDone" : "warehouse.bulk.threshold.done",
        params: { count: res.updated, threshold: threshold ?? "" },
      };
    }

    // Лист інвентаризації.
    requirePermission(ctx.actor, "warehouse.adjust");
    const variantIds = parseVariantIds(form, "item");
    if (variantIds.length > MAX_BULK_ITEMS)
      return { ok: false, intent, error: "warehouse.error.tooManyItems", params: { max: MAX_BULK_ITEMS } };
    const counted: Array<{ variantId: string; counted: number; expected: number | null }> = [];
    for (const variantId of variantIds) {
      const raw = formString(form, `counted.${variantId}`);
      const value = parseFormInt(raw, 0, MAX_COUNTED_QUANTITY);
      if (value === undefined) {
        return {
          ok: false,
          intent,
          error: "warehouse.error.countValue",
          params: { max: MAX_COUNTED_QUANTITY },
          fieldErrors: { [`counted.${variantId}`]: "warehouse.error.countValue" },
        };
      }
      if (value === null) continue;
      const expectedRaw = formString(form, `expected.${variantId}`);
      const expected = /^-?\d{1,9}$/.test(expectedRaw.trim()) ? Number(expectedRaw.trim()) : null;
      counted.push({ variantId, counted: value, expected });
    }
    if (counted.length === 0) return { ok: false, intent, error: "warehouse.error.noCounts" };
    const countedIds = counted.map((c) => c.variantId);
    if ((await existingVariantIds(ctx.db, countedIds)).length !== countedIds.length) return { ok: false, intent, error: "error.notFound" };
    const stockByVariant = await ensureStockItemsForVariants(ctx.db, countedIds);
    const variantByStock = new Map([...stockByVariant].map(([v, s]) => [s, v]));
    try {
      const res = await stocktake(ctx, {
        operationId: formString(form, "operationId"),
        note: formString(form, "note"),
        counts: counted.map((c) => ({
          stockItemId: stockByVariant.get(c.variantId)!,
          countedOnHand: c.counted,
          expectedOnHand: c.expected,
        })),
      });
      if (res.replay) return { ok: true, intent, message: "warehouse.op.replay", tone: "info" };
      const extra: string[] = [];
      // Частина позицій цього листа вже була збережена раніше (повторне надсилання) — показуємо, а не мовчимо.
      if (res.replayed.length > 0) extra.push("warehouse.stocktake.doneReplayed");
      if (res.shopifyPushQueued) extra.push("warehouse.op.pushQueued");
      return {
        ok: true,
        intent,
        message: "warehouse.stocktake.done",
        params: {
          counted: res.applied.length,
          changed: res.changed,
          unchanged: res.unchanged,
          added: res.unitsAdded,
          removed: res.unitsRemoved,
          replayed: res.replayed.length,
        },
        extra,
        tone: res.changed > 0 ? "success" : "info",
      };
    } catch (e) {
      if (e instanceof StocktakeAlreadySavedError) {
        return {
          ok: false,
          intent,
          error: e.code,
          params: e.params,
          conflicts: e.items.map((c) => ({
            variantId: variantByStock.get(c.stockItemId) ?? c.stockItemId,
            expected: null,
            current: c.currentOnHand,
            counted: c.countedOnHand,
            alreadySaved: true,
          })),
        };
      }
      if (e instanceof StocktakeConflictError) {
        return {
          ok: false,
          intent,
          error: e.code,
          params: e.params,
          conflicts: e.conflicts.map((c) => ({
            variantId: variantByStock.get(c.stockItemId) ?? c.stockItemId,
            expected: c.expectedOnHand,
            current: c.currentOnHand,
            counted: c.countedOnHand,
          })),
        };
      }
      throw e;
    }
  } catch (e) {
    return { ...toActionError(e), intent };
  }
}

// ---------------------------------------------------------------------------
// Інтерфейс
// ---------------------------------------------------------------------------

type LoaderData = Awaited<ReturnType<typeof loader>>;

const LEVEL_TONE: Record<StockLevelStatus, BadgeTone> = {
  ok: "success",
  low: "warning",
  out: "critical",
  oversold: "critical",
  negative: "critical",
};

function StockLevelBadge({ status }: { status: StockLevelStatus }) {
  const t = useT();
  return <Badge tone={LEVEL_TONE[status]}>{t(`stockLevel.${status}`)}</Badge>;
}

function TrackingBadge({ tracking }: { tracking: StockTrackingState }) {
  const t = useT();
  if (tracking === "opened") return null;
  return (
    <Badge tone="outline" size="sm" title={t(`warehouse.tracking.${tracking}.help`)}>
      {t(`warehouse.tracking.${tracking}`)}
    </Badge>
  );
}

/** Вкладки підрозділів складу + посилання на пов'язані розділи. */
function WarehouseNav({ current }: { current: "stock" | "movements" }) {
  const t = useT();
  const href = useHref();
  const can = useCan();
  const tabs: TabItem[] = WAREHOUSE_SECTION_LINKS.filter((l) => can(l.permission)).map((l) => ({
    key: l.key,
    label: t(l.labelKey),
    href: href(l.path),
  }));
  return <Tabs items={tabs} selected={current} ariaLabel={t("warehouse.nav.label")} preventScrollReset={false} />;
}

function RelatedLinks() {
  const t = useT();
  const href = useHref();
  const can = useCan();
  const links = WAREHOUSE_RELATED_LINKS.filter((l) => can(l.permission));
  if (links.length === 0) return null;
  return (
    <>
      {links.map((l) => (
        <Button key={l.key} to={href(l.path)} size="sm">
          {t(l.labelKey)}
        </Button>
      ))}
    </>
  );
}

function Qty({ value, strong, tone }: { value: number; strong?: boolean; tone?: "critical" | "subdued" }) {
  const locale = useLocale();
  return (
    <Text as="span" numeric weight={strong ? "semibold" : undefined} tone={tone ?? (value === 0 ? "subdued" : undefined)}>
      {formatNumber(value, locale)}
    </Text>
  );
}

function ShopifyValue({ row }: { row: RowView }) {
  const t = useT();
  const locale = useLocale();
  if (row.shopifyAvailable === null) {
    return (
      <Text as="span" tone="subdued" variant="body-sm">
        <span title={t("warehouse.stock.shopify.untracked")}>—</span>
      </Text>
    );
  }
  const differs = row.tracking === "opened" && row.shopifyAvailable !== row.available;
  const title = row.shopifySyncedAt
    ? t("warehouse.stock.shopify.asOf", { time: formatDateTime(row.shopifySyncedAt, locale) })
    : t("warehouse.stock.shopify.hint");
  return (
    <Stack as="span" direction="horizontal" gap={1} align="center" justify="end">
      <span title={title}>
        <Text as="span" numeric tone="subdued">
          {formatNumber(row.shopifyAvailable, locale)}
        </Text>
      </span>
      {differs ? (
        <Badge tone="warning" size="sm" title={t("warehouse.stock.shopify.differs", { app: row.available, shopify: row.shopifyAvailable })}>
          {t("warehouse.stock.shopify.differsShort")}
        </Badge>
      ) : null}
    </Stack>
  );
}

function ItemTitle({ row }: { row: Pick<RowView, "productTitle" | "variantTitle" | "sku" | "imageUrl" | "model" | "color"> }) {
  const meta = [
    row.variantTitle,
    row.model && row.model !== row.variantTitle ? row.model : null,
    row.color && row.color !== row.variantTitle ? row.color : null,
  ].filter(Boolean);
  return (
    <Stack as="span" direction="horizontal" gap={2} align="center" wrap={false}>
      <Thumbnail src={row.imageUrl} alt="" size="sm" />
      <Stack as="span" gap={0}>
        <Text as="span" weight="semibold">
          {row.productTitle}
        </Text>
        {meta.length > 0 ? (
          <Text as="span" variant="body-sm" tone="subdued">
            {meta.join(" · ")}
          </Text>
        ) : null}
        {row.sku ? (
          <span>
            <InlineCode>{row.sku}</InlineCode>
          </span>
        ) : null}
      </Stack>
    </Stack>
  );
}

export default function WarehousePage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  if (data.view === "stocktake" && data.sheet) return <StocktakeSheet data={data} sheet={data.sheet} actionData={actionData} />;
  return <StockList data={data} actionData={actionData} />;
}

function StockList({ data, actionData }: { data: LoaderData; actionData: WarehouseActionResult | undefined }) {
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const can = useCan();
  const location = useLocation();
  const navigation = useNavigation();
  const [selected, setSelected] = useState<string[]>([]);
  const [threshold, setThreshold] = useState("");
  const { filters } = data;
  const listPath = href("warehouse");
  const listHref = (f: Partial<StockPageFilters>) => `${listPath}${buildSearch(f)}`;
  const keep: Partial<StockPageFilters> = { ...filters, page: 1 };
  const canAdjust = can("warehouse.adjust");
  const busyIntent =
    navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST" ? navigation.formData?.get("intent") : null;
  const isFiltering =
    navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET" && navigation.location.pathname === location.pathname;

  // Після навігації (фільтри, сторінки) рядки інші — вибір скидається.
  useEffect(() => setSelected([]), [location.search]);

  const counts = data.statusCounts;
  const statusTotal = counts ? STOCK_LEVEL_STATUSES.reduce((s, k) => s + counts[k], 0) : 0;
  const chips = counts
    ? [
        { key: "all", label: t("common.all"), count: statusTotal, value: null as StockLevelStatus | null },
        ...(["low", "out", "oversold", "negative", "ok"] as const)
          .filter((s) => counts[s] > 0 || filters.status === s)
          .map((s) => ({ key: s, label: t(`stockLevel.${s}`), count: counts[s], value: s as StockLevelStatus | null })),
      ]
    : [];

  const columns: Array<DataTableColumn<RowView>> = [
    { key: "item", header: t("warehouse.stock.col.item"), primary: true, render: (r) => <ItemTitle row={r} /> },
    {
      key: "onHand",
      header: t("inventory.bucket.onHand"),
      align: "end",
      render: (r) => <Qty value={r.onHand} tone={r.onHand < 0 ? "critical" : undefined} />,
    },
    { key: "reserved", header: t("inventory.bucket.reserved"), align: "end", render: (r) => <Qty value={r.reserved} /> },
    {
      key: "available",
      header: t("warehouse.stock.col.available"),
      align: "end",
      render: (r) => <Qty value={r.available} strong tone={r.available < 0 ? "critical" : undefined} />,
    },
    { key: "inProduction", header: t("inventory.bucket.inProduction"), align: "end", render: (r) => <Qty value={r.inProduction} /> },
    { key: "defective", header: t("inventory.bucket.defective"), align: "end", render: (r) => <Qty value={r.defective} /> },
    {
      key: "status",
      header: t("warehouse.stock.col.status"),
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={1} align="center">
          <StockLevelBadge status={r.status} />
          <TrackingBadge tracking={r.tracking} />
        </Stack>
      ),
    },
    // На телефоні теж (працівники складу користуються телефонами): значення Shopify й позначка «розбіжність».
    { key: "shopify", header: t("warehouse.stock.col.shopify"), align: "end", render: (r) => <ShopifyValue row={r} /> },
  ];

  const activeFormFilters = [filters.q, filters.model, filters.color, filters.product, filters.tracking, filters.inactive].filter(
    Boolean,
  ).length;
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = from === 0 ? 0 : from + data.rows.length - 1;
  const thresholdValue = threshold.trim();
  const thresholdValid = thresholdValue === "" || (/^\d{1,6}$/.test(thresholdValue) && Number(thresholdValue) <= MAX_THRESHOLD);

  return (
    <Page
      title={t("nav.warehouse")}
      subtitle={t("warehouse.stock.subtitle", { warehouse: data.warehouseName })}
      secondaryActions={<RelatedLinks />}
    >
      <Stack gap={4}>
        <WarehouseNav current="stock" />
        <ActionBanner data={actionData} />

        <AlertsSummary data={data} listHref={(status) => listHref({ ...keep, status })} />

        <InitializationCard data={data} busy={busyIntent === "initialize"} />

        {chips.length > 0 ? (
          <nav aria-label={t("warehouse.stock.chips.label")}>
            <Stack direction="horizontal" gap={2} align="center">
              {chips.map((chip) => {
                const text = `${chip.label} · ${formatNumber(chip.count, locale)}`;
                const current = filters.status === chip.value;
                return (
                  <Button
                    key={chip.key}
                    to={listHref({ ...keep, status: chip.value })}
                    size="sm"
                    variant={current ? "primary" : "secondary"}
                    aria-label={current ? t("warehouse.stock.chips.current", { label: text }) : undefined}
                  >
                    {text}
                  </Button>
                );
              })}
            </Stack>
          </nav>
        ) : null}

        <Card>
          <Disclosure
            collapsedOnMobile
            summary={activeFormFilters > 0 ? t("warehouse.filters.titleActive", { count: activeFormFilters }) : t("common.filters")}
          >
            <Form key={location.search} method="get" role="search">
              {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
              <Stack gap={3}>
                <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                  <TextField
                    id="warehouse-filter-q"
                    type="search"
                    name="q"
                    label={t("warehouse.filters.search")}
                    placeholder={t("warehouse.filters.searchPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={MAX_SEARCH_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Select
                    id="warehouse-filter-model"
                    name="model"
                    label={t("warehouse.filters.model")}
                    placeholder={t("warehouse.filters.allModels")}
                    options={data.options.models.map((m) => ({ value: m, label: m }))}
                    defaultValue={filters.model ?? ""}
                  />
                  <Select
                    id="warehouse-filter-color"
                    name="color"
                    label={t("warehouse.filters.color")}
                    placeholder={t("warehouse.filters.allColors")}
                    options={data.options.colors.map((c) => ({ value: c, label: c }))}
                    defaultValue={filters.color ?? ""}
                  />
                  <Select
                    id="warehouse-filter-product"
                    name="product"
                    label={t("warehouse.filters.product")}
                    placeholder={t("warehouse.filters.allProducts")}
                    options={data.options.products.map((p) => ({ value: p.id, label: p.title }))}
                    defaultValue={filters.product ?? ""}
                  />
                  <Select
                    id="warehouse-filter-tracking"
                    name="tracking"
                    label={t("warehouse.filters.tracking")}
                    placeholder={t("common.all")}
                    options={STOCK_TRACKING_STATES.map((s) => ({ value: s, label: t(`warehouse.tracking.${s}.filter`) }))}
                    defaultValue={filters.tracking ?? ""}
                  />
                  <Select
                    id="warehouse-filter-sort"
                    name="sort"
                    label={t("warehouse.filters.sort")}
                    options={STOCK_SORTS.map((s) => ({ value: s, label: t(`warehouse.sort.${s}`) }))}
                    defaultValue={filters.sort}
                  />
                </Grid>
                <Checkbox
                  id="warehouse-filter-inactive"
                  name="inactive"
                  value="1"
                  label={t("warehouse.filters.inactive")}
                  defaultChecked={filters.inactive}
                />
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" size="sm" loading={isFiltering}>
                    {t("common.apply")}
                  </Button>
                  <Button to={listPath} size="sm" disabled={!data.isFiltered && filters.sort === DEFAULT_STOCK_SORT}>
                    {t("common.reset")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Disclosure>
        </Card>

        {canAdjust && data.rows.length > 0 ? (
          <Card>
            <Disclosure
              collapsedOnMobile
              summary={
                selected.length > 0
                  ? `${t("warehouse.bulk.title")} · ${t("common.selected", { count: selected.length })}`
                  : t("warehouse.bulk.title")
              }
            >
              <Form id={BULK_FORM_ID} method="post" action={listHref(filters)} aria-label={t("warehouse.bulk.title")}>
                <Stack gap={3}>
                  <div aria-live="polite" aria-atomic="true">
                    <Text variant="body-sm" tone="subdued">
                      {selected.length === 0 ? t("warehouse.bulk.hint") : t("common.selected", { count: selected.length })}
                    </Text>
                  </div>
                  <Grid columns={{ xs: 1, md: 2 }} gap={3}>
                    <Stack gap={2}>
                      <TextField
                        id="warehouse-bulk-threshold"
                        name="threshold"
                        type="number"
                        inputMode="numeric"
                        min={0}
                        max={MAX_THRESHOLD}
                        step={1}
                        label={t("warehouse.bulk.threshold.label")}
                        helpText={t("warehouse.bulk.threshold.help", { default: data.defaultThreshold })}
                        value={threshold}
                        onChange={(e) => setThreshold(e.currentTarget.value)}
                        error={thresholdValid ? null : t("warehouse.error.threshold", { max: MAX_THRESHOLD })}
                      />
                      <div>
                        <ConfirmSubmitButton
                          name="intent"
                          value="bulkThreshold"
                          size="sm"
                          disabled={selected.length === 0 || !thresholdValid || busyIntent === "bulkThreshold"}
                          loading={busyIntent === "bulkThreshold"}
                          title={t("warehouse.bulk.threshold.title")}
                          confirmLabel={t("warehouse.bulk.threshold.confirm")}
                          cancelLabel={t("common.cancel")}
                          message={
                            <Stack gap={2}>
                              <Text weight="semibold">
                                {thresholdValue === ""
                                  ? t("warehouse.bulk.threshold.previewReset", { count: selected.length, default: data.defaultThreshold })
                                  : t("warehouse.bulk.threshold.preview", { count: selected.length, threshold: thresholdValue })}
                              </Text>
                              <Text>{t("warehouse.bulk.threshold.previewHelp")}</Text>
                            </Stack>
                          }
                        >
                          {t("warehouse.bulk.threshold.button")}
                        </ConfirmSubmitButton>
                      </div>
                    </Stack>
                    <Stack gap={2}>
                      <Text variant="body-sm">{t("warehouse.bulk.stocktake.help")}</Text>
                      <Stack direction="horizontal" gap={2}>
                        <Button
                          size="sm"
                          to={
                            selected.length > 0
                              ? `${listPath}${buildSearch({ view: "stocktake", items: selected, sort: filters.sort })}`
                              : undefined
                          }
                          disabled={selected.length === 0}
                        >
                          {t("warehouse.bulk.stocktake.selected", { count: selected.length })}
                        </Button>
                        <Button size="sm" to={`${listPath}${buildSearch({ ...filters, page: 1, view: "stocktake" })}`}>
                          {t("warehouse.bulk.stocktake.filtered", { count: Math.min(data.total, MAX_BULK_ITEMS) })}
                        </Button>
                      </Stack>
                    </Stack>
                  </Grid>
                </Stack>
              </Form>
            </Disclosure>
          </Card>
        ) : null}

        <Card padded={false}>
          <DataTable
            key={location.search}
            caption={t("warehouse.stock.caption")}
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.variantId}
            rowHref={(r) => href(r.itemPath)}
            selection={
              canAdjust
                ? {
                    name: SELECTION_NAME,
                    value: (r) => r.variantId,
                    label: (r) => t("warehouse.stock.select", { item: r.sku ?? r.productTitle }),
                    formId: BULK_FORM_ID,
                    allLabel: t("warehouse.stock.selectPage", { count: data.rows.length }),
                    onChange: setSelected,
                  }
                : undefined
            }
            emptyState={
              data.isFiltered ? (
                <EmptyState
                  title={t("warehouse.stock.empty.filtered.title")}
                  description={t("warehouse.stock.empty.filtered.description")}
                  action={<Button to={listPath}>{t("common.reset")}</Button>}
                />
              ) : (
                <EmptyState title={t("warehouse.stock.empty.title")} description={t("warehouse.stock.empty.description")} />
              )
            }
          />
        </Card>

        <Stack gap={1}>
          <Text variant="caption" tone="subdued">
            {t("warehouse.stock.legend")}
          </Text>
          <Text variant="caption" tone="subdued">
            {t("warehouse.stock.shopify.legend")}
          </Text>
        </Stack>

        {data.total > 0 ? (
          <Stack direction="horizontal" gap={3} align="center" justify="between">
            <Text variant="body-sm" tone="subdued">
              {t("warehouse.stock.range", { from, to, total: data.total })}
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

function AlertsSummary({ data, listHref }: { data: LoaderData; listHref: (status: StockLevelStatus) => string }) {
  const t = useT();
  const href = useHref();
  const { alerts } = data;
  if (alerts.total === 0 && alerts.materials === 0) return null;
  const kindToStatus: Record<StockAlertKind, StockLevelStatus> = {
    low_stock: "low",
    out_of_stock: "out",
    oversold: "oversold",
    negative_on_hand: "negative",
  };
  const critical = alerts.byKind.negative_on_hand + alerts.byKind.oversold + alerts.byKind.out_of_stock > 0;
  return (
    <Banner tone={critical ? "critical" : "warning"} title={t("warehouse.alerts.title", { count: alerts.total + alerts.materials })}>
      <Stack gap={2}>
        {alerts.total > 0 ? (
          <Stack direction="horizontal" gap={2} align="center">
            {ALERT_KINDS_BY_SEVERITY.filter((k) => alerts.byKind[k] > 0).map((k) => (
              <Link key={k} to={listHref(kindToStatus[k])}>
                {t("warehouse.alerts.kindCount", { kind: t(`stockAlert.${k}`), count: alerts.byKind[k] })}
              </Link>
            ))}
          </Stack>
        ) : null}
        {alerts.top.length > 0 ? (
          <Stack as="ul" gap={1}>
            {alerts.top.map((a) => (
              <li key={a.id}>
                <Link to={href(`warehouse/items/${a.stockItemId}`)}>
                  {[a.title, displayVariantTitle(a.variantTitle), a.sku].filter(Boolean).join(" · ")}
                </Link>
                {" — "}
                {t("warehouse.alerts.item", {
                  kind: t(`stockAlert.${a.kind}`),
                  available: typeof a.details.available === "number" ? a.details.available : "—",
                  threshold: typeof a.details.threshold === "number" ? a.details.threshold : "—",
                })}
              </li>
            ))}
          </Stack>
        ) : null}
        {alerts.materials > 0 ? (
          <Text variant="body-sm">
            <Link to={href("warehouse/materials")}>{t("warehouse.alerts.materials", { count: alerts.materials })}</Link>
          </Text>
        ) : null}
      </Stack>
    </Banner>
  );
}

function InitializationCard({ data, busy }: { data: LoaderData; busy: boolean }) {
  const t = useT();
  const locale = useLocale();
  const { opening } = data;
  const initialized = Boolean(data.initializedAt);
  if (!data.canAdjust) {
    if (initialized) return null;
    return <Banner tone="warning">{t("warehouse.init.notInitializedStaff")}</Banner>;
  }
  const needsRun = !initialized || opening.unopenedTracked > 0;
  const explanation = (
    <Stack gap={2}>
      <Text>{t("warehouse.init.formula")}</Text>
      <Text variant="body-sm">{t("warehouse.init.why")}</Text>
      <Text variant="body-sm">{t("warehouse.init.oneTime")}</Text>
      <Text variant="body-sm">{t("warehouse.init.history")}</Text>
      <Text variant="body-sm" tone="subdued">
        {t("warehouse.init.untrackedNote")}
      </Text>
    </Stack>
  );
  const status = (
    <KeyValueList
      items={[
        {
          key: "initialized",
          label: t("warehouse.init.initializedAt"),
          value: initialized ? formatDateTime(data.initializedAt, locale) : t("warehouse.init.never"),
        },
        {
          key: "opened",
          label: t("warehouse.init.opened"),
          value: `${formatNumber(opening.openedVariants, locale)} / ${formatNumber(opening.trackedVariants, locale)}`,
        },
        { key: "unopened", label: t("warehouse.init.unopened"), value: formatNumber(opening.unopenedTracked, locale) },
        { key: "untracked", label: t("warehouse.init.untracked"), value: formatNumber(opening.untrackedVariants, locale) },
      ]}
    />
  );
  if (!needsRun) {
    return (
      <Card>
        <Disclosure summary={t("warehouse.init.doneSummary", { time: formatDateTime(data.initializedAt, locale) })}>
          <Stack gap={3}>
            {status}
            {explanation}
          </Stack>
        </Disclosure>
      </Card>
    );
  }
  return (
    <Card title={t(initialized ? "warehouse.init.titleNew" : "warehouse.init.title")} titleAs="h2">
      <Form method="post">
        <Stack gap={3}>
          {explanation}
          {status}
          <div>
            <ConfirmSubmitButton
              name="intent"
              value="initialize"
              variant="primary"
              loading={busy}
              disabled={busy}
              title={t("warehouse.init.confirmTitle")}
              confirmLabel={t("warehouse.init.confirm")}
              cancelLabel={t("common.cancel")}
              message={
                <Stack gap={2}>
                  <Text weight="semibold">
                    {initialized
                      ? t("warehouse.init.previewNew", { count: opening.unopenedTracked })
                      : t("warehouse.init.preview", { count: opening.trackedVariants - opening.openedVariants })}
                  </Text>
                  <Text>{t("warehouse.init.previewHelp")}</Text>
                </Stack>
              }
            >
              {initialized ? t("warehouse.init.buttonNew", { count: opening.unopenedTracked }) : t("warehouse.init.button")}
            </ConfirmSubmitButton>
          </div>
        </Stack>
      </Form>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Лист інвентаризації
// ---------------------------------------------------------------------------

function StocktakeSheet({
  data,
  sheet,
  actionData,
}: {
  data: LoaderData;
  sheet: NonNullable<LoaderData["sheet"]>;
  actionData: WarehouseActionResult | undefined;
}) {
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const can = useCan();
  const navigation = useNavigation();
  const canSubmit = can("warehouse.adjust");
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [formKey, setFormKey] = useState(0);
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "stocktake";

  // Після успішного збереження поля очищаються (нова форма, новий uuid з loader).
  useEffect(() => {
    if (actionData?.ok && actionData.intent === "stocktake") {
      setCounts({});
      setFormKey((k) => k + 1);
    }
  }, [actionData]);

  const conflicts = useMemo(
    () => new Map((actionData && !actionData.ok ? (actionData.conflicts ?? []) : []).map((c) => [c.variantId, c])),
    [actionData],
  );

  const preview = useMemo(() => {
    let counted = 0;
    let changed = 0;
    let added = 0;
    let removed = 0;
    let invalid = 0;
    let belowReserved = 0;
    for (const r of sheet.rows) {
      const raw = (counts[r.variantId] ?? "").trim();
      if (raw === "") continue;
      if (!/^\d{1,7}$/.test(raw) || Number(raw) > MAX_COUNTED_QUANTITY) {
        invalid++;
        continue;
      }
      counted++;
      const delta = Number(raw) - r.onHand;
      if (delta !== 0) changed++;
      if (delta > 0) added += delta;
      if (delta < 0) removed -= delta;
      if (Number(raw) < r.reserved) belowReserved++;
    }
    return {
      counted,
      changed,
      added,
      removed,
      invalid,
      belowReserved,
      unchanged: counted - changed,
      skipped: sheet.rows.length - counted - invalid,
    };
  }, [counts, sheet.rows]);

  const backHref = href("warehouse");
  const columns: Array<DataTableColumn<RowView>> = [
    { key: "item", header: t("warehouse.stock.col.item"), primary: true, render: (r) => <ItemTitle row={r} /> },
    {
      key: "system",
      header: t("warehouse.stocktake.col.system"),
      align: "end",
      render: (r) => (
        <>
          <input type="hidden" name="item" value={r.variantId} form="warehouse-stocktake-form" />
          <input type="hidden" name={`expected.${r.variantId}`} value={String(r.onHand)} form="warehouse-stocktake-form" />
          <Stack as="span" gap={0} align="end">
            <Qty value={r.onHand} />
            {r.reserved > 0 ? (
              <Text as="span" variant="caption" tone="subdued">
                {t("warehouse.stocktake.reservedNote", { reserved: formatNumber(r.reserved, locale) })}
              </Text>
            ) : null}
          </Stack>
        </>
      ),
    },
    {
      key: "counted",
      header: t("warehouse.stocktake.col.counted"),
      render: (r) => {
        const conflict = conflicts.get(r.variantId);
        const raw = (counts[r.variantId] ?? "").trim();
        const belowReserved = /^\d{1,7}$/.test(raw) && Number(raw) < r.reserved;
        return (
          <TextField
            id={`warehouse-count-${r.variantId}`}
            name={`counted.${r.variantId}`}
            form="warehouse-stocktake-form"
            type="number"
            inputMode="numeric"
            min={0}
            max={MAX_COUNTED_QUANTITY}
            step={1}
            label={t("warehouse.stocktake.countLabel", { item: r.sku ?? r.productTitle })}
            labelHidden
            disabled={!canSubmit}
            onChange={(e) => {
              const value = e.currentTarget.value;
              setCounts((prev) => ({ ...prev, [r.variantId]: value }));
            }}
            helpText={belowReserved ? t("warehouse.stocktake.rowBelowReserved", { reserved: r.reserved }) : undefined}
            error={
              conflict
                ? conflict.alreadySaved
                  ? t("warehouse.stocktake.rowAlreadySaved", { current: conflict.current, counted: conflict.counted })
                  : t("warehouse.stocktake.rowChanged", { expected: conflict.expected ?? "—", current: conflict.current })
                : null
            }
          />
        );
      },
    },
    {
      key: "diff",
      header: t("warehouse.stocktake.col.diff"),
      align: "end",
      render: (r) => {
        const raw = (counts[r.variantId] ?? "").trim();
        if (!/^\d{1,7}$/.test(raw))
          return (
            <Text as="span" tone="subdued">
              —
            </Text>
          );
        const delta = Number(raw) - r.onHand;
        return (
          <Text as="span" numeric weight="semibold" tone={delta < 0 ? "critical" : delta > 0 ? "success" : "subdued"}>
            {delta > 0 ? `+${formatNumber(delta, locale)}` : formatNumber(delta, locale)}
          </Text>
        );
      },
    },
  ];

  return (
    <Page
      title={t("warehouse.stocktake.title")}
      subtitle={t("warehouse.stocktake.subtitle", { count: sheet.rows.length })}
      backHref={backHref}
      backLabel={t("warehouse.stocktake.back")}
    >
      <Stack gap={4}>
        <ActionBanner data={actionData} />
        <Banner tone="info">
          <Stack gap={1}>
            <p>{t("warehouse.stocktake.help")}</p>
            <p>{t("warehouse.stocktake.helpPacked")}</p>
            <p>{t("warehouse.stocktake.helpChanged")}</p>
          </Stack>
        </Banner>
        {!canSubmit ? <Banner tone="warning">{t("warehouse.stocktake.noPermission")}</Banner> : null}
        {sheet.truncated ? (
          <Banner tone="warning">
            {t("warehouse.stocktake.truncated", { shown: sheet.rows.length, total: sheet.total, max: MAX_BULK_ITEMS })}
          </Banner>
        ) : null}
        {!data.initializedAt ? <Banner tone="warning">{t("warehouse.stocktake.notInitialized")}</Banner> : null}

        <Card padded={false}>
          <DataTable
            key={formKey}
            caption={t("warehouse.stocktake.title")}
            columns={columns}
            rows={sheet.rows}
            rowKey={(r) => r.variantId}
            emptyState={
              <EmptyState title={t("warehouse.stocktake.empty")} action={<Button to={backHref}>{t("warehouse.stocktake.back")}</Button>} />
            }
          />
        </Card>

        {sheet.rows.length > 0 && canSubmit ? (
          <Card>
            <Form id="warehouse-stocktake-form" key={formKey} method="post">
              <input type="hidden" name="intent" value="stocktake" />
              <input type="hidden" name="operationId" value={data.operationIds.stocktake} />
              <Stack gap={3}>
                <TextField
                  id="warehouse-stocktake-note"
                  name="note"
                  label={t("warehouse.op.note")}
                  helpText={t("warehouse.op.noteHelp")}
                  maxLength={MAX_NOTE_LENGTH}
                  multiline={2}
                />
                <Text variant="body-sm" tone="subdued">
                  {t("warehouse.stocktake.previewLine", { counted: preview.counted, total: sheet.rows.length, changed: preview.changed })}
                </Text>
                {preview.belowReserved > 0 ? (
                  <Banner tone="warning">{t("warehouse.stocktake.preview.belowReserved", { count: preview.belowReserved })}</Banner>
                ) : null}
                <div>
                  <ConfirmSubmitButton
                    variant="primary"
                    disabled={preview.counted === 0 || preview.invalid > 0 || busy}
                    loading={busy}
                    title={t("warehouse.stocktake.confirmTitle")}
                    confirmLabel={t("warehouse.stocktake.confirm")}
                    cancelLabel={t("common.cancel")}
                    message={
                      <Stack gap={2}>
                        <Text weight="semibold">
                          {t("warehouse.stocktake.preview.counted", { counted: preview.counted, total: sheet.rows.length })}
                        </Text>
                        <Text>
                          {t("warehouse.stocktake.preview.changed", {
                            changed: preview.changed,
                            added: preview.added,
                            removed: preview.removed,
                          })}
                        </Text>
                        <Text>{t("warehouse.stocktake.preview.unchanged", { count: preview.unchanged })}</Text>
                        {preview.skipped > 0 ? <Text>{t("warehouse.stocktake.preview.skipped", { count: preview.skipped })}</Text> : null}
                        {preview.belowReserved > 0 ? (
                          <Banner tone="warning">{t("warehouse.stocktake.preview.belowReserved", { count: preview.belowReserved })}</Banner>
                        ) : null}
                      </Stack>
                    }
                  >
                    {t("warehouse.stocktake.submit")}
                  </ConfirmSubmitButton>
                </div>
              </Stack>
            </Form>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

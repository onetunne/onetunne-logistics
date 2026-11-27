import { Link, Form, useLoaderData, useLocation, useNavigation, type LoaderFunctionArgs } from "react-router";
import { useCan, useHref } from "~/components/shell";
import type { StockItemKind } from "~/db/schema";
import { can } from "~/domain/permissions";
import { hasKey, useLocale, useT, type Locale } from "~/i18n";
import { formatDateTime, formatMoney, formatNumber } from "~/lib/format";
import { movementHistory, type MovementFilters, type MovementView } from "~/modules/inventory/ledger.server";
import { MOVEMENT_TYPES, isMovementType, type MovementType, shopifySyncStateForDisplay } from "~/modules/inventory/movement-types";
import {
  ITEM_KINDS,
  MAX_SEARCH_LENGTH,
  MOVEMENTS_PAGE_SIZE,
  UUID_RE,
  WAREHOUSE_RELATED_LINKS,
  WAREHOUSE_SECTION_LINKS,
  displayVariantTitle,
} from "~/modules/warehouse/constants";
import { businessDayEnd, businessDayStart, parseIsoDate } from "~/modules/warehouse/dates";
import { movementDeltaParts, reasonKey, signedNumber } from "~/modules/warehouse/format";
import {
  findOrderById,
  findOrderByNumber,
  getStockItemLabel,
  listMovementActors,
  searchStockItemIds,
} from "~/modules/warehouse/lookup.server";
import { stockFilterOptions } from "~/modules/warehouse/stock.server";
import { getRequestContext } from "~/server/context.server";
import {
  Badge,
  Banner,
  Button,
  Card,
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
  type BadgeTone,
  type DataTableColumn,
  type TabItem,
} from "~/ui";

/**
 * Історія руху залишків (warehouse/movements): фільтри за типом, датою (Europe/Kyiv), позицією, замовленням,
 * виконавцем, видом позиції, моделлю й кольором варіанта (ті самі значення й точний збіг, що в переліку залишків —
 * stockFilterOptions); сторінки. Собівартість одиниці — ЛИШЕ з finance.view (сервер не передає її іншим).
 */

export interface MovementPageFilters {
  type: MovementType | null;
  from: string | null;
  to: string | null;
  /** id позиції обліку (посилання з картки). */
  item: string | null;
  /** SKU / назва. */
  q: string;
  /** Номер замовлення. */
  order: string;
  /** id замовлення (посилання з замовлення). */
  orderId: string | null;
  /**
   * id конкретного руху — посилання на документ (referenceDocumentUri, який застосунок передає в Shopify:
   * inventory-sync/pure.ts movementReferenceUri). Показується лише цей рух; банер «Показати всі рухи» скидає фільтр.
   */
  movement: string | null;
  actor: string | null;
  kind: StockItemKind | null;
  /** Модель / колір варіанта (точний збіг, як у переліку залишків). */
  model: string | null;
  color: string | null;
  page: number;
}

function parseFilters(params: URLSearchParams): MovementPageFilters {
  const text = (name: string, max = MAX_SEARCH_LENGTH) => (params.get(name) ?? "").trim().slice(0, max);
  const type = params.get("type");
  const item = text("item").toLowerCase();
  const orderId = text("orderId").toLowerCase();
  const movement = text("movement").toLowerCase();
  const kind = params.get("kind");
  const pageRaw = text("page");
  return {
    type: isMovementType(type) ? type : null,
    from: parseIsoDate(params.get("from")),
    to: parseIsoDate(params.get("to")),
    item: UUID_RE.test(item) ? item : null,
    q: text("q"),
    order: text("order", 64),
    orderId: UUID_RE.test(orderId) ? orderId : null,
    movement: UUID_RE.test(movement) ? movement : null,
    actor: text("actor", 120) || null,
    kind: kind && (ITEM_KINDS as readonly string[]).includes(kind) ? (kind as StockItemKind) : null,
    model: text("model") || null,
    color: text("color") || null,
    page: /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1,
  };
}

function buildSearch(f: Partial<MovementPageFilters>): string {
  const params = new URLSearchParams();
  if (f.type) params.set("type", f.type);
  if (f.from) params.set("from", f.from);
  if (f.to) params.set("to", f.to);
  if (f.item) params.set("item", f.item);
  if (f.q) params.set("q", f.q);
  if (f.order) params.set("order", f.order);
  if (f.orderId) params.set("orderId", f.orderId);
  if (f.movement) params.set("movement", f.movement);
  if (f.actor) params.set("actor", f.actor);
  if (f.kind) params.set("kind", f.kind);
  if (f.model) params.set("model", f.model);
  if (f.color) params.set("color", f.color);
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

/** Собівартість — спільним детермінованим форматером (lib/format), як на інших сторінках складу. */
function serialize(m: MovementView, locale: Locale, mode: "demo" | "production") {
  return {
    id: m.id,
    createdAt: m.createdAt.toISOString(),
    type: m.type,
    stockItemId: m.stockItemId,
    itemKind: m.itemKind,
    title: m.title,
    variantTitle: displayVariantTitle(m.variantTitle),
    sku: m.sku,
    onHandDelta: m.onHandDelta,
    reservedDelta: m.reservedDelta,
    defectiveDelta: m.defectiveDelta,
    inProductionDelta: m.inProductionDelta,
    orderId: m.orderId,
    orderNumber: m.orderNumber,
    productionBatchId: m.productionBatchId,
    batchNumber: m.batchNumber,
    reason: m.reason,
    note: m.note,
    actorId: m.actorId,
    actorName: m.actorName,
    shopifySyncState: shopifySyncStateForDisplay(mode, m.shopifySyncState),
    unitCost: m.unitCost,
    costCurrency: m.costCurrency,
    unitCostText: m.unitCost && m.costCurrency ? formatMoney(m.unitCost, m.costCurrency, locale) : null,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const includeCosts = can(ctx.actor, "finance.view");
  const filters = parseFilters(new URL(request.url).searchParams);

  let empty = false;
  let stockItemIds: string[] | undefined;
  const itemLabel = filters.item ? await getStockItemLabel(ctx.db, filters.item) : null;
  if (filters.item) {
    stockItemIds = [filters.item];
    if (!itemLabel) empty = true;
  }
  if (filters.q) {
    const found = await searchStockItemIds(ctx.db, filters.q, { kind: filters.kind ?? undefined });
    stockItemIds = stockItemIds ? stockItemIds.filter((id) => found.includes(id)) : found;
    if (stockItemIds.length === 0) empty = true;
  }
  const orderRef = filters.orderId
    ? await findOrderById(ctx.db, filters.orderId)
    : filters.order
      ? await findOrderByNumber(ctx.db, filters.order)
      : null;
  const orderMissing = Boolean((filters.orderId || filters.order) && !orderRef);
  if (orderMissing) empty = true;

  const query: MovementFilters = {
    movementIds: filters.movement ? [filters.movement] : undefined,
    stockItemIds,
    types: filters.type ? [filters.type] : undefined,
    orderId: orderRef?.id,
    actorId: filters.actor ?? undefined,
    kind: filters.kind ?? undefined,
    models: filters.model ? [filters.model] : undefined,
    colors: filters.color ? [filters.color] : undefined,
    from: filters.from ? businessDayStart(filters.from) : undefined,
    to: filters.to ? businessDayEnd(filters.to) : undefined,
  };
  let page = filters.page;
  const fetchPage = (p: number) =>
    empty
      ? Promise.resolve({ rows: [] as MovementView[], total: 0 })
      : movementHistory(ctx.db, query, { limit: MOVEMENTS_PAGE_SIZE, offset: (p - 1) * MOVEMENTS_PAGE_SIZE }, { includeCosts });
  let result = await fetchPage(page);
  const pages = Math.max(1, Math.ceil(result.total / MOVEMENTS_PAGE_SIZE));
  if (page > pages) {
    page = pages;
    result = await fetchPage(page);
  }
  const [actors, stockOptions] = await Promise.all([listMovementActors(ctx.db), stockFilterOptions(ctx.db)]);
  if (filters.actor && !actors.some((a) => a.id === filters.actor)) actors.push({ id: filters.actor, name: filters.actor });
  // Ті самі значення, що у фільтрах переліку залишків; вибране значення (напр. архівного товару) лишається у списку.
  const withSelected = (values: string[], selected: string | null) =>
    selected && !values.includes(selected) ? [...values, selected] : values;
  const options = {
    models: withSelected(stockOptions.models, filters.model),
    colors: withSelected(stockOptions.colors, filters.color),
  };

  return {
    filters: { ...filters, page },
    rows: result.rows.map((r) => serialize(r, ctx.locale, ctx.mode)),
    total: result.total,
    page,
    pages,
    pageSize: MOVEMENTS_PAGE_SIZE,
    actors,
    options,
    itemLabel: itemLabel ? { ...itemLabel, variantTitle: displayVariantTitle(itemLabel.variantTitle) } : null,
    orderRef,
    orderMissing,
    movementMissing: Boolean(filters.movement && result.total === 0),
    canSeeCosts: includeCosts,
    isFiltered: Boolean(
      filters.type ||
      filters.from ||
      filters.to ||
      filters.item ||
      filters.q ||
      filters.order ||
      filters.orderId ||
      filters.movement ||
      filters.actor ||
      filters.kind ||
      filters.model ||
      filters.color,
    ),
  };
}

// ---------------------------------------------------------------------------
// Інтерфейс
// ---------------------------------------------------------------------------

type Row = Awaited<ReturnType<typeof loader>>["rows"][number];

const SYNC_TONE: Record<string, BadgeTone> = { pending: "info", pushed: "success", failed: "critical", skipped: "outline" };

export default function WarehouseMovementsPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const can = useCan();
  const location = useLocation();
  const navigation = useNavigation();
  const { filters } = data;
  const path = href("warehouse/movements");
  const listHref = (f: Partial<MovementPageFilters>) => `${path}${buildSearch(f)}`;
  const isFiltering =
    navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET" && navigation.location.pathname === location.pathname;
  const fmt = (n: number) => formatNumber(n, locale);
  const canSeeCosts = data.canSeeCosts && can("finance.view");

  const tabs: TabItem[] = WAREHOUSE_SECTION_LINKS.filter((l) => can(l.permission)).map((l) => ({
    key: l.key,
    label: t(l.labelKey),
    href: href(l.path),
  }));

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "item",
      header: t("warehouse.history.col.item"),
      primary: true,
      render: (r) => (
        <Stack as="span" gap={0}>
          <Text as="span" weight="semibold">
            {r.title}
          </Text>
          {r.variantTitle ? (
            <Text as="span" variant="body-sm" tone="subdued">
              {r.variantTitle}
            </Text>
          ) : null}
          {r.sku ? (
            <span>
              <InlineCode>{r.sku}</InlineCode>
            </span>
          ) : null}
        </Stack>
      ),
    },
    { key: "time", header: t("warehouse.history.col.time"), render: (r) => formatDateTime(r.createdAt, locale) },
    {
      key: "type",
      header: t("warehouse.history.col.type"),
      render: (r) => {
        const key = reasonKey(r.reason);
        return (
          <Stack as="span" gap={0}>
            <span>{t(`movementType.${r.type}`)}</span>
            {key ? (
              <Text as="span" variant="caption" tone="subdued">
                {hasKey(key) ? t(key) : r.reason}
              </Text>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: "change",
      header: t("warehouse.history.col.change"),
      render: (r) => {
        const parts = movementDeltaParts(r);
        if (parts.length === 0)
          return (
            <Text as="span" tone="subdued">
              {t("warehouse.movement.noChange")}
            </Text>
          );
        return (
          <Stack as="span" gap={0}>
            {parts.map((p) => (
              <Text key={p.bucket} as="span" numeric tone={p.delta < 0 && p.bucket === "onHand" ? "critical" : undefined}>
                {`${t(`inventory.bucket.${p.bucket}`)} ${signedNumber(p.delta, fmt)}`}
              </Text>
            ))}
          </Stack>
        );
      },
    },
    {
      key: "source",
      header: t("warehouse.history.col.source"),
      render: (r) => {
        if (r.orderId && r.orderNumber) {
          return can("orders.view") ? <Link to={href(`orders/${r.orderId}`)}>{r.orderNumber}</Link> : <span>{r.orderNumber}</span>;
        }
        if (r.batchNumber) return <span>{t("warehouse.movement.batch", { number: r.batchNumber })}</span>;
        return (
          <Text as="span" tone="subdued">
            —
          </Text>
        );
      },
    },
    { key: "actor", header: t("warehouse.history.col.actor"), render: (r) => r.actorName },
    {
      key: "shopify",
      header: t("warehouse.history.col.shopify"),
      hideOnMobile: true,
      render: (r) =>
        r.shopifySyncState === "none" ? (
          <Text as="span" tone="subdued">
            —
          </Text>
        ) : (
          <Badge tone={SYNC_TONE[r.shopifySyncState] ?? "neutral"} size="sm">
            {t(`shopifySyncState.${r.shopifySyncState}`)}
          </Badge>
        ),
    },
    ...(canSeeCosts
      ? [
          {
            key: "cost",
            header: t("warehouse.history.col.unitCost"),
            align: "end" as const,
            render: (r: Row) =>
              r.unitCostText ? (
                <Text as="span" numeric>
                  {r.unitCostText}
                </Text>
              ) : (
                "—"
              ),
          },
        ]
      : []),
    { key: "note", header: t("warehouse.history.col.note"), hideOnMobile: true, render: (r) => r.note ?? "—" },
  ];

  const activeFilters = [
    filters.type,
    filters.from,
    filters.to,
    filters.q,
    filters.order,
    filters.actor,
    filters.kind,
    filters.model,
    filters.color,
  ].filter(Boolean).length;
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = from === 0 ? 0 : from + data.rows.length - 1;
  const dateInvalid = filters.from && filters.to && filters.from > filters.to;

  return (
    <Page
      title={t("warehouse.history.title")}
      subtitle={t("warehouse.history.subtitle")}
      secondaryActions={
        <>
          {WAREHOUSE_RELATED_LINKS.filter((l) => can(l.permission)).map((l) => (
            <Button key={l.key} to={href(l.path)} size="sm">
              {t(l.labelKey)}
            </Button>
          ))}
        </>
      }
    >
      <Stack gap={4}>
        <Tabs items={tabs} selected="movements" ariaLabel={t("warehouse.nav.label")} preventScrollReset={false} />

        {data.itemLabel ? (
          <Banner
            tone="info"
            action={
              <Button to={listHref({ ...filters, item: null, page: 1 })} size="sm">
                {t("warehouse.history.clearItem")}
              </Button>
            }
          >
            {t("warehouse.history.forItem")}{" "}
            <Link to={href(`warehouse/items/${data.itemLabel.stockItemId}`)}>
              {[data.itemLabel.title, data.itemLabel.variantTitle, data.itemLabel.sku].filter(Boolean).join(" · ")}
            </Link>
          </Banner>
        ) : null}
        {data.orderRef && filters.orderId ? (
          <Banner
            tone="info"
            action={
              <Button to={listHref({ ...filters, orderId: null, page: 1 })} size="sm">
                {t("warehouse.history.clearOrder")}
              </Button>
            }
          >
            {t("warehouse.history.forOrder", { number: data.orderRef.orderNumber })}
          </Banner>
        ) : null}
        {data.orderMissing ? <Banner tone="warning">{t("warehouse.history.orderNotFound")}</Banner> : null}
        {filters.movement ? (
          <Banner
            tone={data.movementMissing ? "warning" : "info"}
            action={
              <Button to={listHref({ ...filters, movement: null, page: 1 })} size="sm">
                {filters.from && filters.from === filters.to ? t("warehouse.history.clearMovementDay") : t("warehouse.history.clearMovement")}
              </Button>
            }
          >
            {data.movementMissing ? t("warehouse.history.movementNotFound") : t("warehouse.history.forMovement")}
          </Banner>
        ) : null}
        {dateInvalid ? <Banner tone="warning">{t("warehouse.history.dateRangeInvalid")}</Banner> : null}

        <Card>
          <Disclosure
            collapsedOnMobile
            summary={activeFilters > 0 ? t("warehouse.filters.titleActive", { count: activeFilters }) : t("common.filters")}
          >
            <Form key={location.search} method="get" role="search">
              {filters.item ? <input type="hidden" name="item" value={filters.item} /> : null}
              {filters.orderId ? <input type="hidden" name="orderId" value={filters.orderId} /> : null}
              {filters.movement ? <input type="hidden" name="movement" value={filters.movement} /> : null}
              <Stack gap={3}>
                <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                  <Select
                    id="wh-history-type"
                    name="type"
                    label={t("warehouse.history.filter.type")}
                    placeholder={t("warehouse.history.filter.allTypes")}
                    options={MOVEMENT_TYPES.map((type) => ({ value: type, label: t(`movementType.${type}`) }))}
                    defaultValue={filters.type ?? ""}
                  />
                  <TextField
                    id="wh-history-from"
                    name="from"
                    type="date"
                    label={t("warehouse.history.filter.from")}
                    defaultValue={filters.from ?? ""}
                  />
                  <TextField
                    id="wh-history-to"
                    name="to"
                    type="date"
                    label={t("warehouse.history.filter.to")}
                    defaultValue={filters.to ?? ""}
                  />
                  <TextField
                    id="wh-history-q"
                    name="q"
                    type="search"
                    label={t("warehouse.history.filter.item")}
                    placeholder={t("warehouse.history.filter.itemPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={MAX_SEARCH_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <TextField
                    id="wh-history-order"
                    name="order"
                    label={t("warehouse.history.filter.order")}
                    placeholder={t("warehouse.history.filter.orderPlaceholder")}
                    defaultValue={filters.order}
                    maxLength={64}
                    autoComplete="off"
                  />
                  <Select
                    id="wh-history-actor"
                    name="actor"
                    label={t("warehouse.history.filter.actor")}
                    placeholder={t("warehouse.history.filter.allActors")}
                    options={data.actors.map((a) => ({ value: a.id, label: a.name }))}
                    defaultValue={filters.actor ?? ""}
                  />
                  <Select
                    id="wh-history-kind"
                    name="kind"
                    label={t("warehouse.history.filter.kind")}
                    placeholder={t("common.all")}
                    options={ITEM_KINDS.map((k) => ({ value: k, label: t(`warehouse.history.kind.${k}`) }))}
                    defaultValue={filters.kind ?? ""}
                  />
                  <Select
                    id="wh-history-model"
                    name="model"
                    label={t("warehouse.filters.model")}
                    placeholder={t("warehouse.filters.allModels")}
                    options={data.options.models.map((v) => ({ value: v, label: v }))}
                    defaultValue={filters.model ?? ""}
                  />
                  <Select
                    id="wh-history-color"
                    name="color"
                    label={t("warehouse.filters.color")}
                    placeholder={t("warehouse.filters.allColors")}
                    options={data.options.colors.map((v) => ({ value: v, label: v }))}
                    defaultValue={filters.color ?? ""}
                  />
                </Grid>
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" size="sm" loading={isFiltering}>
                    {t("common.apply")}
                  </Button>
                  <Button to={path} size="sm" disabled={!data.isFiltered}>
                    {t("common.reset")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Disclosure>
        </Card>

        <Card padded={false}>
          <DataTable
            key={location.search}
            caption={t("warehouse.history.title")}
            columns={columns}
            rows={data.rows}
            rowKey={(r) => r.id}
            rowHref={(r) => href(`warehouse/items/${r.stockItemId}`)}
            emptyState={
              data.isFiltered ? (
                <EmptyState
                  title={t("warehouse.history.empty.filtered.title")}
                  description={t("warehouse.history.empty.filtered.description")}
                  action={<Button to={path}>{t("common.reset")}</Button>}
                />
              ) : (
                <EmptyState title={t("warehouse.history.empty.title")} description={t("warehouse.history.empty.description")} />
              )
            }
          />
        </Card>

        {data.total > 0 ? (
          <Stack direction="horizontal" gap={3} align="center" justify="between">
            <Text variant="body-sm" tone="subdued">
              {t("warehouse.history.range", { from, to, total: data.total })}
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

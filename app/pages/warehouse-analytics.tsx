import { useState, type ReactNode } from "react";
import { Form, useLoaderData, useLocation, useNavigation, type LoaderFunctionArgs } from "react-router";
import { useCan, useHref } from "~/components/shell";
import { can } from "~/domain/permissions";
import { useLocale, useT, type Locale, type TFunction } from "~/i18n";
import { formatDecimal, formatIsoDate, formatMoney, formatNumber } from "~/lib/format";
import {
  MAX_CUSTOM_PERIOD_DAYS,
  PERIOD_KEYS,
  productionPrefill,
  roundTo,
  resolvePeriod,
  type RiskLevel,
  type SalesGroup,
  type Trend,
} from "~/modules/warehouse-analytics/calc";
import { CSV_SEPARATORS, DEFAULT_CSV_SEPARATOR, isCsvSeparatorKey, type CsvSeparatorKey } from "~/modules/warehouse-analytics/csv";
import { exportResponseOutcome, MAX_EXPORT_MOVEMENTS } from "~/modules/warehouse-analytics/export-contract";
import { analyticsSearch, exportDatasetsFor, filtersOf, parseAnalyticsQuery, type AnalyticsQuery, type ExportDataset } from "~/modules/warehouse-analytics/params";
import { computeWarehouseAnalytics, type VariantAnalytics } from "~/modules/warehouse-analytics/queries.server";
import { MAX_SEARCH_LENGTH, WAREHOUSE_RELATED_LINKS, WAREHOUSE_SECTION_LINKS } from "~/modules/warehouse/constants";
import { businessDate } from "~/modules/warehouse/dates";
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
  KeyValueList,
  Page,
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
 * «Аналітика складу» (етап 5): продажі за період (оплачені, не скасовані замовлення; кількість — currentQuantity),
 * топ товарів/кольорів/моделей, швидкість продажів (30/90 днів, зважена), днів запасу, дата вичерпання, позиції під
 * ризиком, рекомендації партій з посиланням «Створити партію» (форма партії з вибраними товарами й кількостями),
 * CSV-експорт. Перегляд — warehouse.view; вартість запасу й колонки собівартості в CSV — лише finance.view.
 * Розрахунки — modules/warehouse-analytics (calc.ts — формули, queries.server.ts — дані).
 */

const TABLE_LIMIT = 50;
const VARIANT_LIMIT = 100;

type Row = ReturnType<typeof toRow>;

function toRow(v: VariantAnalytics) {
  return {
    variantId: v.variantId,
    productId: v.productId,
    stockItemId: v.stockItemId,
    productTitle: v.productTitle,
    variantTitle: v.variantTitle,
    sku: v.sku,
    model: v.model,
    color: v.color,
    imageUrl: v.imageUrl,
    active: v.active,
    forecast: v.forecast,
    units: v.units,
    previousUnits: v.previousUnits,
    orders: v.orders,
    trend: v.trend,
    units30: v.units30,
    units90: v.units90,
    velocity30: roundTo(v.velocity30, 2),
    velocity90: roundTo(v.velocity90, 2),
    velocity: roundTo(v.velocity, 2),
    onHand: v.onHand,
    reserved: v.reserved,
    available: v.available,
    inProduction: v.inProduction,
    planned: v.planned,
    nextReadyDate: v.nextReadyDate,
    coverDays: v.coverDays,
    stockOutDate: v.stockOutDate,
    risk: v.risk,
    recommendation: v.recommendation,
    // Собівартість — лише власник (finance.view); для інших — null (computeWarehouseAnalytics без includeCosts).
    cost: v.cost,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  const query = parseAnalyticsQuery(url.searchParams);
  const today = businessDate(ctx.now());
  const period = resolvePeriod({ key: query.period, from: query.from, to: query.to, today });
  const includeCosts = can(ctx.actor, "finance.view");
  const canManageProduction = can(ctx.actor, "production.manage");
  const [data, options] = await Promise.all([
    computeWarehouseAnalytics(ctx.db, { today, period, filters: filtersOf(query), includeCosts }),
    stockFilterOptions(ctx.db),
  ]);
  const prefill = productionPrefill(
    data.recommendations.map((v) => ({ productId: v.productId, variantId: v.variantId, quantity: v.recommendation?.quantity ?? 0 })),
  );
  return {
    today,
    query,
    period,
    isFiltered: Boolean(query.model || query.color || query.product || query.period !== "30"),
    canSeeCosts: includeCosts,
    canManageProduction,
    settings: data.settings,
    kpi: data.kpi,
    topProducts: data.topProducts,
    topColors: data.topColors,
    topModels: data.topModels,
    atRisk: data.atRisk.slice(0, TABLE_LIMIT).map(toRow),
    atRiskTotal: data.atRisk.length,
    recommendations: data.recommendations.slice(0, TABLE_LIMIT).map(toRow),
    recommendationsTotal: data.recommendations.length,
    prefill: canManageProduction ? prefill : null,
    variants: data.variants.filter((v) => v.units > 0 || v.active).slice(0, VARIANT_LIMIT).map(toRow),
    variantsTotal: data.variants.filter((v) => v.units > 0 || v.active).length,
    inventoryValue: includeCosts ? data.inventoryValue : null,
    options,
  };
}

// ---------------------------------------------------------------------------
// Відображення
// ---------------------------------------------------------------------------

/** ISO-дата (YYYY-MM-DD) → дата для показу (календарна дата, без часового поясу). */
function isoDate(value: string | null, locale: Locale): string {
  return value ? formatIsoDate(value, locale) : "—";
}

/** Спільний детермінований форматер (lib/format) — однаково на сервері й у браузері. */
function decimal(value: number, locale: Locale, digits = 2): string {
  return formatDecimal(value, locale, { maximumFractionDigits: digits });
}

const TREND_TONE: Record<Trend["direction"], BadgeTone> = { up: "success", down: "warning", flat: "neutral", new: "info", none: "outline" };

function TrendBadge({ trend }: { trend: Trend }) {
  const t = useT();
  if (trend.direction === "none") {
    return (
      <Text as="span" tone="subdued">
        —
      </Text>
    );
  }
  const label =
    trend.direction === "new"
      ? t("warehouseAnalytics.trend.new")
      : t(`warehouseAnalytics.trend.${trend.direction}`, { percent: Math.abs(trend.percent ?? 0) });
  return (
    <Badge tone={TREND_TONE[trend.direction]} size="sm" title={t("warehouseAnalytics.trend.hint", { previous: trend.previous })}>
      {label}
    </Badge>
  );
}

const RISK_TONE: Record<RiskLevel, BadgeTone> = { out: "critical", critical: "warning", none: "neutral" };

function ItemCell({ r }: { r: Row }) {
  const t = useT();
  return (
    <Stack direction="horizontal" gap={2} align="center" wrap={false}>
      <Thumbnail src={r.imageUrl} alt={r.productTitle} size="sm" />
      <Stack as="span" gap={0}>
        <Text as="span" weight="semibold">
          {r.productTitle}
        </Text>
        <Text as="span" variant="body-sm" tone="subdued">
          {[r.variantTitle, r.sku].filter(Boolean).join(" · ") || t("warehouseAnalytics.noSku")}
        </Text>
      </Stack>
    </Stack>
  );
}

/**
 * Заголовок показника: на вузьких екранах (2 колонки при 320px) довге слово (від 10 літер) переноситься з дефісом,
 * а не посередині без дефіса; короткі слова не розриваються (hyphenate-limit-chars; де не підтримується — звичайний
 * перенос із дефісом). Підписи показників добрано так, щоб при 320px переносів у словах не було.
 */
const KPI_TITLE_STYLE = { hyphens: "auto", hyphenateLimitChars: "10 4 4", overflowWrap: "break-word" } as const;

function Kpi({ label, value, hint, children }: { label: string; value: string; hint?: string; children?: ReactNode }) {
  return (
    <Card title={<span style={KPI_TITLE_STYLE}>{label}</span>} titleAs="h3" description={hint}>
      <Stack gap={1} align="start">
        <Text as="p" variant="heading-lg" numeric>
          {/* Довгі суми (кілька валют) переносяться, а не розширюють сторінку на вузьких екранах. */}
          <span style={{ overflowWrap: "anywhere" }}>{value}</span>
        </Text>
        {children}
      </Stack>
    </Card>
  );
}

/** Примітка в картці без внутрішніх відступів (під таблицею). */
function CardNote({ children }: { children: ReactNode }) {
  return <div style={{ padding: "var(--ot-space-3) var(--ot-space-4)" }}>{children}</div>;
}

function groupColumns(t: TFunction, locale: Locale, by: "product" | "color" | "model"): Array<DataTableColumn<SalesGroup>> {
  return [
    {
      key: "label",
      header: t(`warehouseAnalytics.top.col.${by}`),
      primary: true,
      render: (g) =>
        by === "product" ? (
          <Stack direction="horizontal" gap={2} align="center" wrap={false}>
            <Thumbnail src={g.imageUrl} alt={g.label ?? ""} size="sm" />
            <Text as="span">{g.label}</Text>
          </Stack>
        ) : (
          <Text as="span">{g.label ?? t(by === "color" ? "warehouseAnalytics.noColor" : "warehouseAnalytics.noModel")}</Text>
        ),
    },
    {
      // Кількість, частка й тренд — в одній колонці: три таблиці поруч на ПК без внутрішньої прокрутки.
      key: "units",
      header: t("warehouseAnalytics.col.unitsShare"),
      align: "end",
      render: (g) => (
        <Stack as="span" gap={1} align="end">
          <Text as="span" numeric>
            {t("warehouseAnalytics.unitsShare", { units: formatNumber(g.units, locale), share: g.sharePercent })}
          </Text>
          <TrendBadge trend={g.trend} />
        </Stack>
      ),
    },
  ];
}

// ---------------------------------------------------------------------------
// Експорт CSV (через fetch: у вбудованому застосунку App Bridge додає токен сесії)
// ---------------------------------------------------------------------------

function fileNameFrom(response: Response, fallback: string): string {
  const header = response.headers.get("Content-Disposition") ?? "";
  const match = /filename="?([A-Za-z0-9][A-Za-z0-9._-]{0,150})"?\s*(?:;|$)/.exec(header);
  return match?.[1] ?? fallback;
}

/** Завантажує файл. Результат: помилка (ключ i18n) або { truncated } — файл збережено, але, можливо, неповний. */
async function downloadCsv(url: string, fallbackName: string): Promise<{ error: string } | { truncated: boolean }> {
  let response: Response;
  try {
    response = await window.fetch(url, { credentials: "same-origin", redirect: "manual", headers: { Accept: "text/csv" } });
  } catch {
    return { error: "warehouseAnalytics.export.error.network" };
  }
  const outcome = exportResponseOutcome(response);
  if (!outcome.ok) return { error: outcome.error };
  const blob = new Blob([await response.arrayBuffer()], { type: "text/csv;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = fileNameFrom(response, fallbackName);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return { truncated: outcome.truncated };
}

function ExportCard({ query, canSeeCosts }: { query: AnalyticsQuery; canSeeCosts: boolean }) {
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const canDo = useCan();
  // Набір «Партії виробництва» (собівартість) — лише власник (finance.view); сервер перевіряє сам.
  const datasets = exportDatasetsFor(canDo);
  const [separator, setSeparator] = useState<CsvSeparatorKey>(DEFAULT_CSV_SEPARATOR);
  const [pending, setPending] = useState<ExportDataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Набір, файл якого збережено обрізаним (X-Export-Truncated: 1) — попередження, доки не завантажать інший. */
  const [truncated, setTruncated] = useState<ExportDataset | null>(null);
  const download = async (dataset: ExportDataset) => {
    setError(null);
    setTruncated(null);
    setPending(dataset);
    try {
      const url = `${href("warehouse/export")}${analyticsSearch({ ...query, dataset, sep: separator })}`;
      const result = await downloadCsv(url, `${dataset}.csv`);
      if ("error" in result) setError(result.error);
      else if (result.truncated) setTruncated(dataset);
    } catch {
      setError("warehouseAnalytics.export.error.generic");
    } finally {
      setPending(null);
    }
  };
  return (
    <Card title={t("warehouseAnalytics.export.title")} description={t("warehouseAnalytics.export.description")}>
      <Stack gap={3}>
        <Grid columns={{ xs: 1, md: 3 }} gap={3}>
          <Select
            id="wa-export-sep"
            name="sep"
            label={t("warehouseAnalytics.export.separator")}
            value={separator}
            onChange={(e) => setSeparator(isCsvSeparatorKey(e.target.value) ? e.target.value : DEFAULT_CSV_SEPARATOR)}
            options={(Object.keys(CSV_SEPARATORS) as CsvSeparatorKey[]).map((k) => ({ value: k, label: t(`warehouseAnalytics.export.sep.${k}`) }))}
          />
        </Grid>
        <Stack direction="horizontal" gap={2}>
          {datasets.map((dataset) => (
            <Button
              key={dataset}
              size="sm"
              loading={pending === dataset}
              disabled={pending !== null && pending !== dataset}
              onClick={() => void download(dataset)}
            >
              {t(`warehouseAnalytics.export.dataset.${dataset}`)}
            </Button>
          ))}
        </Stack>
        <Text variant="body-sm" tone="subdued">
          {t("warehouseAnalytics.export.help")}
        </Text>
        <Text variant="body-sm" tone="subdued">
          {canSeeCosts ? t("warehouseAnalytics.export.costsOwner") : t("warehouseAnalytics.export.costsStaff")}
        </Text>
        {datasets.includes("production") ? (
          <Text variant="body-sm" tone="subdued">
            {t("warehouseAnalytics.export.productionHelp")}
          </Text>
        ) : null}
        {error ? (
          <Banner tone="critical" title={t("warehouseAnalytics.export.error.title")}>
            {t(error)}
          </Banner>
        ) : null}
        {truncated ? (
          <Banner tone="warning" title={t("warehouseAnalytics.export.truncated.title")}>
            {t(truncated === "production" ? "warehouseAnalytics.export.truncatedProduction" : "warehouseAnalytics.export.truncated", {
              max: formatNumber(MAX_EXPORT_MOVEMENTS, locale),
            })}
          </Banner>
        ) : null}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Сторінка
// ---------------------------------------------------------------------------

export default function WarehouseAnalyticsPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const canDo = useCan();
  const location = useLocation();
  const navigation = useNavigation();
  const path = href("warehouse/analytics");
  const { query, period, kpi, settings } = data;
  const n = (v: number) => formatNumber(v, locale);
  const isFiltering = navigation.state === "loading" && navigation.location?.pathname === location.pathname;

  // Вкладка «Аналітика» — у спільному переліку WAREHOUSE_SECTION_LINKS (видно з усіх сторінок складу).
  const tabs: TabItem[] = WAREHOUSE_SECTION_LINKS.filter((l) => canDo(l.permission)).map((l) => ({
    key: l.key,
    label: t(l.labelKey),
    href: href(l.path),
  }));
  const batchHref = (search: string) => `${href("production/new")}${search}`;

  const coverText = (r: Row) =>
    r.coverDays === null ? t("warehouseAnalytics.cover.noSales") : t("warehouseAnalytics.cover.days", { days: decimal(r.coverDays, locale, 1) });

  const recommendationColumns: Array<DataTableColumn<Row>> = [
    { key: "item", header: t("warehouseAnalytics.col.item"), primary: true, render: (r) => <ItemCell r={r} /> },
    {
      key: "qty",
      header: t("warehouseAnalytics.col.recommended"),
      align: "end",
      render: (r) => (
        <Text as="span" weight="semibold" numeric>
          {n(r.recommendation?.quantity ?? 0)}
        </Text>
      ),
    },
    {
      key: "velocity",
      header: t("warehouseAnalytics.col.velocity"),
      align: "end",
      render: (r) => t("warehouseAnalytics.velocity.value", { value: decimal(r.velocity, locale), v30: decimal(r.velocity30, locale) }),
    },
    { key: "available", header: t("warehouseAnalytics.col.available"), align: "end", render: (r) => n(r.available) },
    {
      key: "production",
      header: t("warehouseAnalytics.col.production"),
      align: "end",
      render: (r) => t("warehouseAnalytics.production.value", { inProduction: n(r.inProduction), planned: n(r.planned) }),
    },
    { key: "stockout", header: t("warehouseAnalytics.col.stockOut"), render: (r) => isoDate(r.stockOutDate, locale) },
    {
      key: "why",
      header: t("warehouseAnalytics.col.explanation"),
      hideOnMobile: true,
      render: (r) =>
        r.recommendation ? (
          <Text as="span" variant="body-sm" tone="subdued">
            {t("warehouseAnalytics.explanation", {
              horizon: r.recommendation.horizonDays,
              demand: n(r.recommendation.demand),
              supply: n(r.recommendation.supply),
              shortfall: n(r.recommendation.shortfall),
              rounding: r.recommendation.rounding,
              quantity: n(r.recommendation.quantity),
            })}
          </Text>
        ) : (
          "—"
        ),
    },
    ...(data.prefill
      ? [
          {
            key: "action",
            header: t("warehouseAnalytics.col.action"),
            render: (r: Row) => (
              <Button
                size="sm"
                to={batchHref(productionPrefill([{ productId: r.productId, variantId: r.variantId, quantity: r.recommendation?.quantity ?? 0 }]).search)}
              >
                {t("warehouseAnalytics.createBatchOne")}
              </Button>
            ),
          },
        ]
      : []),
  ];

  const riskColumns: Array<DataTableColumn<Row>> = [
    { key: "item", header: t("warehouseAnalytics.col.item"), primary: true, render: (r) => <ItemCell r={r} /> },
    {
      key: "risk",
      header: t("warehouseAnalytics.col.risk"),
      render: (r) => (
        <Badge tone={RISK_TONE[r.risk]} size="sm">
          {t(`warehouseAnalytics.risk.${r.risk}`)}
        </Badge>
      ),
    },
    { key: "available", header: t("warehouseAnalytics.col.available"), align: "end", render: (r) => n(r.available) },
    { key: "v30", header: t("warehouseAnalytics.col.velocity30"), align: "end", render: (r) => decimal(r.velocity30, locale) },
    { key: "cover", header: t("warehouseAnalytics.col.cover"), render: coverText },
    { key: "stockout", header: t("warehouseAnalytics.col.stockOut"), render: (r) => isoDate(r.stockOutDate, locale) },
    {
      key: "incoming",
      header: t("warehouseAnalytics.col.incoming"),
      hideOnMobile: true,
      render: (r) =>
        r.inProduction + r.planned > 0
          ? t("warehouseAnalytics.incoming.value", { units: n(r.inProduction + r.planned), date: isoDate(r.nextReadyDate, locale) })
          : "—",
    },
  ];

  const variantColumns: Array<DataTableColumn<Row>> = [
    { key: "item", header: t("warehouseAnalytics.col.item"), primary: true, width: "30%", render: (r) => <ItemCell r={r} /> },
    {
      key: "modelColor",
      header: t("warehouseAnalytics.col.modelColor"),
      hideOnMobile: true,
      render: (r) => [r.model, r.color].filter(Boolean).join(" · ") || "—",
    },
    { key: "units", header: t("warehouseAnalytics.col.units"), align: "end", render: (r) => n(r.units) },
    { key: "orders", header: t("warehouseAnalytics.col.orders"), align: "end", hideOnMobile: true, render: (r) => n(r.orders) },
    { key: "trend", header: t("warehouseAnalytics.col.trend"), render: (r) => <TrendBadge trend={r.trend} /> },
    {
      key: "velocity",
      header: t("warehouseAnalytics.col.velocity3090"),
      align: "end",
      render: (r) => t("warehouseAnalytics.velocity.pair", { v30: decimal(r.velocity30, locale), v90: decimal(r.velocity90, locale) }),
    },
    {
      key: "available",
      header: t("warehouseAnalytics.col.available"),
      align: "end",
      render: (r) => (r.active ? n(r.available) : t("warehouseAnalytics.inactive")),
    },
    { key: "cover", header: t("warehouseAnalytics.col.cover"), hideOnMobile: true, render: (r) => (r.forecast ? coverText(r) : "—") },
    ...(data.canSeeCosts
      ? [
          {
            key: "cost",
            header: t("warehouseAnalytics.col.unitCost"),
            align: "end" as const,
            hideOnMobile: true,
            render: (r: Row) => (r.cost ? formatMoney(r.cost.unitCost, r.cost.currency, locale) : "—"),
          },
        ]
      : []),
  ];

  const periodLabel = t("warehouseAnalytics.period.range", {
    from: isoDate(period.from, locale),
    to: isoDate(period.to, locale),
    days: period.days,
    previousFrom: isoDate(period.previousFrom, locale),
    previousTo: isoDate(period.previousTo, locale),
  });
  const activeFilters = [query.model, query.color, query.product, query.period !== "30" ? query.period : null].filter(Boolean).length;

  return (
    <Page
      title={t("warehouseAnalytics.title")}
      subtitle={t("warehouseAnalytics.subtitle")}
      secondaryActions={
        <>
          {WAREHOUSE_RELATED_LINKS.filter((l) => canDo(l.permission)).map((l) => (
            <Button key={l.key} to={href(l.path)} size="sm">
              {t(l.labelKey)}
            </Button>
          ))}
        </>
      }
    >
      <Stack gap={4}>
        <Tabs items={tabs} selected="analytics" ariaLabel={t("warehouse.nav.label")} preventScrollReset={false} />

        {period.invalid ? (
          <Banner tone="warning">{t("warehouseAnalytics.period.invalid", { max: MAX_CUSTOM_PERIOD_DAYS })}</Banner>
        ) : null}

        <Card>
          <Disclosure
            collapsedOnMobile
            summary={activeFilters > 0 ? t("warehouseAnalytics.filters.titleActive", { count: activeFilters }) : t("common.filters")}
          >
            <Form key={location.search} method="get" role="search">
              <Stack gap={3}>
                <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                  <Select
                    id="wa-period"
                    name="period"
                    label={t("warehouseAnalytics.filters.period")}
                    options={PERIOD_KEYS.map((k) => ({ value: k, label: t(`warehouseAnalytics.period.${k}`) }))}
                    defaultValue={query.period}
                  />
                  <TextField
                    id="wa-from"
                    name="from"
                    type="date"
                    label={t("warehouseAnalytics.filters.from")}
                    defaultValue={query.period === "custom" ? (query.from ?? "") : period.from}
                    helpText={t("warehouseAnalytics.filters.customHelp")}
                    max={data.today}
                  />
                  <TextField
                    id="wa-to"
                    name="to"
                    type="date"
                    label={t("warehouseAnalytics.filters.to")}
                    defaultValue={query.period === "custom" ? (query.to ?? "") : period.to}
                    max={data.today}
                  />
                  <Select
                    id="wa-product"
                    name="product"
                    label={t("warehouseAnalytics.filters.product")}
                    placeholder={t("warehouseAnalytics.filters.anyProduct")}
                    options={data.options.products.map((p) => ({ value: p.id, label: p.title.slice(0, MAX_SEARCH_LENGTH) }))}
                    defaultValue={query.product ?? ""}
                  />
                  <Select
                    id="wa-model"
                    name="model"
                    label={t("warehouseAnalytics.filters.model")}
                    placeholder={t("warehouseAnalytics.filters.anyModel")}
                    options={data.options.models.map((m) => ({ value: m, label: m }))}
                    defaultValue={query.model ?? ""}
                  />
                  <Select
                    id="wa-color"
                    name="color"
                    label={t("warehouseAnalytics.filters.color")}
                    placeholder={t("warehouseAnalytics.filters.anyColor")}
                    options={data.options.colors.map((c) => ({ value: c, label: c }))}
                    defaultValue={query.color ?? ""}
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

        <Text variant="body-sm" tone="subdued">
          {periodLabel}
        </Text>

        <Stack gap={3} as="section">
          <Text as="h2" variant="heading-md">
            {t("warehouseAnalytics.kpi.title")}
          </Text>
          <Grid columns={{ xs: 2, lg: 4 }} gap={3}>
            <Kpi label={t("warehouseAnalytics.kpi.units")} value={n(kpi.unitsSold)}>
              <TrendBadge trend={kpi.trend} />
            </Kpi>
            <Kpi label={t("warehouseAnalytics.kpi.orders")} value={n(kpi.orders)}>
              <TrendBadge trend={kpi.ordersTrend} />
            </Kpi>
            <Kpi label={t("warehouseAnalytics.kpi.perDay")} value={decimal(kpi.avgDailyUnits, locale, 1)} hint={t("warehouseAnalytics.kpi.perDayHint")} />
            <Kpi
              label={t("warehouseAnalytics.kpi.available")}
              value={n(kpi.availableUnits)}
              hint={t("warehouseAnalytics.kpi.availableHint", { inProduction: n(kpi.inProductionUnits), planned: n(kpi.plannedUnits) })}
            />
            <Kpi label={t("warehouseAnalytics.kpi.atRisk")} value={n(kpi.atRisk)} hint={t("warehouseAnalytics.kpi.atRiskHint", { out: n(kpi.outOfStock) })} />
            <Kpi
              label={t("warehouseAnalytics.kpi.recommendations")}
              value={n(kpi.recommendations)}
              hint={t("warehouseAnalytics.kpi.recommendationsHint", { units: n(kpi.recommendedUnits) })}
            />
            <Kpi label={t("warehouseAnalytics.kpi.variantsSold")} value={n(kpi.variantsSold)} />
            {data.inventoryValue ? (
              <Kpi
                label={t("warehouseAnalytics.kpi.value")}
                value={
                  data.inventoryValue.totals.length > 0
                    ? data.inventoryValue.totals.map((v) => formatMoney(v.amount, v.currency, locale)).join(" + ")
                    : "—"
                }
                hint={
                  data.inventoryValue.itemsWithoutCost > 0
                    ? t("warehouseAnalytics.kpi.valueMissing", {
                        items: n(data.inventoryValue.itemsWithoutCost),
                        units: n(data.inventoryValue.unitsWithoutCost),
                      })
                    : t("warehouseAnalytics.kpi.valueHint")
                }
              />
            ) : null}
          </Grid>
        </Stack>

        {kpi.notForecastVariants > 0 ? (
          <Banner
            tone="info"
            action={
              <Button to={href("warehouse")} size="sm">
                {t("warehouse.nav.stock")}
              </Button>
            }
          >
            {t("warehouseAnalytics.notForecast", { count: n(kpi.notForecastVariants) })}
          </Banner>
        ) : null}
        {kpi.unmatchedUnits > 0 ? <Banner tone="info">{t("warehouseAnalytics.unmatched", { units: n(kpi.unmatchedUnits) })}</Banner> : null}

        <Card
          padded={false}
          title={t("warehouseAnalytics.recommendations.title", { count: n(data.recommendationsTotal) })}
          description={t("warehouseAnalytics.recommendations.description", {
            lead: settings.productionLeadDays,
            cover: settings.targetCoverDays,
            rounding: settings.batchRounding,
          })}
          actions={
            data.prefill && data.prefill.variants > 0 ? (
              <Button to={batchHref(data.prefill.search)} variant="primary" size="sm">
                {t("warehouseAnalytics.createBatch", { products: n(data.prefill.products) })}
              </Button>
            ) : null
          }
        >
          {data.prefill && data.prefill.variants > 0 ? (
            <CardNote>
              <Stack gap={1}>
                {/* Форма партії відкривається з вибраними товарами й рекомендованими кількостями (qty.<variantId>);
                    партія створюється лише після збереження людиною. */}
                <Text variant="body-sm" tone="subdued">
                  {t("warehouseAnalytics.createBatchNote")}
                </Text>
                {data.prefill.truncated ? (
                  <Text variant="body-sm" tone="subdued">
                    {t("warehouseAnalytics.createBatchTruncated", { products: data.prefill.products })}
                  </Text>
                ) : null}
              </Stack>
            </CardNote>
          ) : null}
          <DataTable
            key={`rec-${location.search}`}
            caption={t("warehouseAnalytics.recommendations.caption")}
            columns={recommendationColumns}
            rows={data.recommendations}
            rowKey={(r) => r.variantId}
            rowHref={(r) => (r.stockItemId ? href(`warehouse/items/${r.stockItemId}`) : href(`warehouse?product=${r.productId}`))}
            emptyState={
              <EmptyState
                title={t("warehouseAnalytics.recommendations.empty.title")}
                description={t("warehouseAnalytics.recommendations.empty.description")}
              />
            }
          />
          {data.recommendationsTotal > data.recommendations.length ? (
            <CardNote>
              <Text variant="body-sm" tone="subdued">
                {t("warehouseAnalytics.moreInCsv", { shown: data.recommendations.length, total: data.recommendationsTotal })}
              </Text>
            </CardNote>
          ) : null}
        </Card>

        <Card padded={false} title={t("warehouseAnalytics.risk.title", { count: n(data.atRiskTotal) })} description={t("warehouseAnalytics.risk.description", { lead: settings.productionLeadDays })}>
          <DataTable
            key={`risk-${location.search}`}
            caption={t("warehouseAnalytics.risk.caption")}
            columns={riskColumns}
            rows={data.atRisk}
            rowKey={(r) => r.variantId}
            rowHref={(r) => (r.stockItemId ? href(`warehouse/items/${r.stockItemId}`) : href(`warehouse?product=${r.productId}`))}
            emptyState={<EmptyState title={t("warehouseAnalytics.risk.empty.title")} description={t("warehouseAnalytics.risk.empty.description")} />}
          />
        </Card>

        <Grid columns={{ xs: 1, lg: 3 }} gap={4}>
          {(
            [
              ["product", data.topProducts],
              ["color", data.topColors],
              ["model", data.topModels],
            ] as const
          ).map(([by, rows]) => (
            <Card key={by} padded={false} title={t(`warehouseAnalytics.top.${by}`)}>
              <DataTable
                caption={t(`warehouseAnalytics.top.${by}`)}
                columns={groupColumns(t, locale, by)}
                rows={[...rows]}
                rowKey={(g) => `${by}-${g.key}`}
                rowHref={
                  by === "product"
                    ? (g) => `${path}${analyticsSearch({ ...query, product: g.key })}`
                    : (g) => (g.key ? `${path}${analyticsSearch({ ...query, [by]: g.key })}` : `${path}${location.search}`)
                }
                emptyState={<EmptyState title={t("warehouseAnalytics.top.empty")} />}
              />
            </Card>
          ))}
        </Grid>

        <Card
          padded={false}
          title={t("warehouseAnalytics.variants.title")}
          description={t("warehouseAnalytics.variants.description")}
        >
          <DataTable
            key={`var-${location.search}`}
            caption={t("warehouseAnalytics.variants.title")}
            columns={variantColumns}
            rows={data.variants}
            rowKey={(r) => r.variantId}
            rowHref={(r) => (r.stockItemId ? href(`warehouse/items/${r.stockItemId}`) : href(`warehouse?product=${r.productId}`))}
            emptyState={
              <EmptyState
                title={t("warehouseAnalytics.variants.empty.title")}
                description={t("warehouseAnalytics.variants.empty.description")}
                action={data.isFiltered ? <Button to={path}>{t("common.reset")}</Button> : undefined}
              />
            }
          />
          {data.variantsTotal > data.variants.length ? (
            <CardNote>
              <Text variant="body-sm" tone="subdued">
                {t("warehouseAnalytics.moreInCsv", { shown: data.variants.length, total: data.variantsTotal })}
              </Text>
            </CardNote>
          ) : null}
        </Card>

        <Disclosure summary={t("warehouseAnalytics.method.title")}>
          <KeyValueList
            items={[
              { key: "sales", label: t("warehouseAnalytics.method.salesLabel"), value: t("warehouseAnalytics.method.sales") },
              { key: "velocity", label: t("warehouseAnalytics.method.velocityLabel"), value: t("warehouseAnalytics.method.velocity") },
              { key: "cover", label: t("warehouseAnalytics.method.coverLabel"), value: t("warehouseAnalytics.method.cover") },
              {
                key: "recommendation",
                label: t("warehouseAnalytics.method.recommendationLabel"),
                value: t("warehouseAnalytics.method.recommendation", {
                  lead: settings.productionLeadDays,
                  cover: settings.targetCoverDays,
                  rounding: settings.batchRounding,
                }),
              },
              {
                key: "settings",
                label: t("warehouseAnalytics.method.settingsLabel"),
                value: t("warehouseAnalytics.method.settings", {
                  lead: settings.productionLeadDays,
                  cover: settings.targetCoverDays,
                  rounding: settings.batchRounding,
                  threshold: settings.lowStockThreshold,
                }),
              },
            ]}
          />
        </Disclosure>

        {/* Експорт — за фактично показаним періодом (некоректний довільний → 30 днів, як на сторінці). */}
        <ExportCard query={{ ...query, period: period.key, from: period.from, to: period.to }} canSeeCosts={data.canSeeCosts} />
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

/**
 * Етап 6, WP4: «Фінанси → Замовлення» (docs/stage6-design.md §18.2). Маршрут …/finance/orders (app/routes.ts).
 * Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router); сервіс списку ще раз перевіряє requireFinance.
 *
 * Список: номер, дата визнання (невизнані — дата оформлення), країна, чиста виручка, собівартість, доставка (стан),
 * комісії, партнер, прибуток («Факт» / «≈ Прогноз» / «—»), рентабельність, стан. Пошук за номером замовлення; фільтри:
 * період, стан, країна, «потребує перевірки», партнер, «лише збиткові»; сортування й сторінки — на сервері. Суми — у
 * валюті показу (перемикач), кожен запис за курсом свого дня; без курсу — «—» з позначкою, ніколи 0. Телефон — картки
 * (DataTable). Порожня база — «Немає даних».
 */
import { Form, Link, useLoaderData, useLocation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { CurrencySwitch } from "~/components/finance/currency-switch";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { MoneyValue } from "~/components/finance/money-value";
import { PeriodBar } from "~/components/finance/period-bar";
import { StateBadge } from "~/components/finance/state-badge";
import { useHref } from "~/components/shell";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { countryName, formatIsoDate, formatPercent } from "~/lib/format";
import { businessDate } from "~/lib/periods";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { listOrderFinance } from "~/modules/order-finance/list.server";
import { orderFinanceListParamsOf, orderFinancePageHref, ORDER_FINANCE_QUERY_MAX } from "~/modules/order-finance/list-params";
import { ORDER_FINANCE_LIST_STATES, ORDER_FINANCE_SORTS, type OrderFinanceListRow } from "~/modules/order-finance/list-types";
import { listPartnerOptions } from "~/modules/partners/partners.server";
import { getRequestContext } from "~/server/context.server";
import { Badge, Banner, Button, Card, Checkbox, DataTable, Disclosure, EmptyState, FormLayout, Grid, Page, Pagination, Select, Stack, Text, TextField } from "~/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const today = businessDate(ctx.now());
  const params = orderFinanceListParamsOf(new URL(request.url).searchParams, today);
  const list = await listOrderFinance(ctx, params.filter);
  const partners = (await listPartnerOptions(ctx)).map((p) => ({ id: p.id, displayName: p.displayName }));
  return { demo: ctx.mode === "demo", preset: params.preset, range: params.range, filter: params.filter, list, partners };
}

/** Сторінка списку не має дій (дії — у блоці «Фінанси замовлення» на сторінці замовлення); доступ — як у ядра. */
export async function action({ request }: ActionFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  return { ok: false as const, error: "error.generic" };
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

interface SectionProps {
  data: Data;
  t: TFunction;
  locale: Locale;
}

export default function FinanceOrdersPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  return (
    <Page title={t(financeLabelKeys.tab("orders"))} subtitle={t("financeOrders.list.subtitle")}>
      <Stack gap={4}>
        <FinanceTabs current="orders" />
        {data.demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <Card>
          <Stack gap={3}>
            <PeriodBar
              preset={data.preset}
              range={data.range}
              granularity="month"
              compare="none"
              allowCustom
              extra={<CurrencySwitch current={data.list.currency} options={data.list.displayCurrencies} showLabel />}
            />
            <Text variant="body-sm" tone="subdued">
              {t("financeOrders.list.period", { from: formatIsoDate(data.range.from, locale), to: formatIsoDate(data.range.to, locale) })}
            </Text>
          </Stack>
        </Card>
        <FiltersCard data={data} t={t} locale={locale} />
        <OrdersTable data={data} t={t} locale={locale} />
      </Stack>
    </Page>
  );
}

function isFiltered(f: Data["filter"]): boolean {
  return Boolean(f.q || f.state || f.country || f.partnerId || f.needsReview || f.lossOnly);
}

function FiltersCard({ data, t, locale }: SectionProps) {
  const f = data.filter;
  const location = useLocation();
  const any = { value: "", label: t("financeOrders.filter.any") };
  const keep = new URLSearchParams(location.search);
  const kept = ["period", "from", "to", "currency"].filter((k) => keep.has(k));
  const resetParams = new URLSearchParams();
  for (const k of kept) resetParams.set(k, keep.get(k) ?? "");
  const reset = resetParams.toString();
  return (
    <Card>
      <Disclosure summary={t("financeOrders.filter.title")} collapsedOnMobile defaultOpen={isFiltered(f) || f.sort !== "recognized_desc"}>
        <Form method="get" preventScrollReset>
          {kept.map((k) => (
            <input key={k} type="hidden" name={k} value={keep.get(k) ?? ""} />
          ))}
          <FormLayout>
            <Grid columns={{ xs: 1, md: 2, lg: 3 }} gap={3}>
              <TextField label={t("financeOrders.filter.q")} name="q" type="search" defaultValue={f.q ?? ""} maxLength={ORDER_FINANCE_QUERY_MAX} />
              <Select
                label={t("financeOrders.filter.state")}
                name="state"
                defaultValue={f.state ?? ""}
                options={[any, ...ORDER_FINANCE_LIST_STATES.map((s) => ({ value: s, label: t(`financeOrders.listState.${s}`) }))]}
              />
              <Select
                label={t("financeOrders.filter.country")}
                name="country"
                defaultValue={f.country ?? ""}
                options={[any, ...data.list.countries.map((c) => ({ value: c, label: countryName(c, locale) }))]}
              />
              <Select
                label={t("financeOrders.filter.partner")}
                name="partner"
                defaultValue={f.partnerId ?? ""}
                options={[any, ...data.partners.map((p) => ({ value: p.id, label: p.displayName }))]}
              />
              <Select
                label={t("financeOrders.filter.sort")}
                name="sort"
                defaultValue={f.sort}
                options={ORDER_FINANCE_SORTS.map((s) => ({ value: s, label: t(`financeOrders.sort.${s}`) }))}
              />
            </Grid>
            <Stack gap={2}>
              <Checkbox label={t("financeOrders.filter.needsReview")} name="review" value="1" defaultChecked={f.needsReview} />
              <Checkbox label={t("financeOrders.filter.lossOnly")} name="loss" value="1" defaultChecked={f.lossOnly} />
            </Stack>
            <Stack gap={2}>
              <div>
                <Button type="submit">{t("financeOrders.filter.apply")}</Button>
              </div>
              {isFiltered(f) ? <Link to={reset ? `?${reset}` : "?"}>{t("financeOrders.filter.reset")}</Link> : null}
            </Stack>
          </FormLayout>
        </Form>
      </Disclosure>
    </Card>
  );
}

function Amount({ value, currency, unconverted }: { value: string | null; currency: string; unconverted?: boolean }) {
  const t = useT();
  return (
    <Stack gap={1}>
      <MoneyValue value={value !== null ? { amount: value, currency } : null} />
      {value === null && unconverted ? (
        <Text as="span" variant="body-sm" tone="subdued">
          {t("financeOrders.list.noRate")}
        </Text>
      ) : null}
    </Stack>
  );
}

function ProfitCell({ row, currency, t }: { row: OrderFinanceListRow; currency: string; t: TFunction }) {
  if (row.profit === null) {
    // Прибуток final / preliminary не показано лише через записи без курсу — «без курсу», а не «немає даних» (§2.6).
    const text =
      row.profitKind === "no_rate"
        ? t("financeOrders.list.profitNoRate", { n: row.unconverted })
        : t(row.state === "excluded" ? "financeOrders.list.profitExcluded" : row.state === "recognized" ? "financeOrders.list.profitHidden" : "financeOrders.list.profitNotRecognized");
    return (
      <Stack gap={1}>
        <MoneyValue value={null} />
        <Text as="span" variant="body-sm" tone="subdued">
          {text}
        </Text>
      </Stack>
    );
  }
  return <MoneyValue value={{ amount: row.profit, currency }} forecast={row.profitKind === "forecast"} emphasis="strong" />;
}

/** Рентабельність; з прогнозу («≈ Прогноз») — з позначкою «≈», як і прибуток рядка (F5). */
function MarginCell({ row, locale }: { row: OrderFinanceListRow; locale: Locale }) {
  if (row.margin === null) return <>—</>;
  const text = formatPercent(row.margin, locale);
  return row.profitKind === "forecast" ? <span className="ot-money--forecast ot-text--numeric">{`≈ ${text}`}</span> : <span className="ot-text--numeric">{text}</span>;
}

function StateCell({ row, t }: { row: OrderFinanceListRow; t: TFunction }) {
  return (
    <Stack gap={1}>
      <StateBadge state={row.state === "recognized" ? row.profitState : row.state} />
      {row.needsReview ? (
        <span>
          <Badge size="sm" tone="warning">
            {t("financeOrders.list.needsReview")}
          </Badge>
        </span>
      ) : null}
    </Stack>
  );
}

function OrdersTable({ data, t, locale }: SectionProps) {
  const href = useHref();
  const location = useLocation();
  const { list } = data;
  const currency = list.currency;
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filtered = isFiltered(data.filter);
  const unconverted = (r: OrderFinanceListRow, column: OrderFinanceListRow["unconvertedColumns"][number]) => r.unconvertedColumns.includes(column);
  return (
    <Card
      title={t("financeOrders.list.title")}
      description={list.total > 0 ? t("financeOrders.list.total", { n: list.total, currency }) : undefined}
      padded={false}
    >
      <Stack gap={3}>
        <DataTable<OrderFinanceListRow>
          caption={t("financeOrders.list.title")}
          rows={list.rows}
          rowKey={(r) => r.orderId}
          rowHref={(r) => href(`/orders/${r.orderId}`)}
          emptyState={
            <EmptyState
              title={t(filtered ? "financeOrders.list.emptyFiltered" : "financeOrders.list.empty")}
              description={t(filtered ? "financeOrders.list.emptyFilteredHelp" : "financeOrders.list.emptyHelp")}
            />
          }
          columns={[
            {
              key: "order",
              header: t("financeOrders.list.col.order"),
              primary: true,
              render: (r) => (
                <Text as="span" weight="semibold">
                  {r.orderNumber}
                </Text>
              ),
            },
            {
              key: "date",
              header: t("financeOrders.list.col.date"),
              render: (r) =>
                r.recognizedOn ? formatIsoDate(r.recognizedOn, locale) : t("financeOrders.list.placedOn", { date: formatIsoDate(r.placedOn, locale) }),
            },
            { key: "country", header: t("financeOrders.list.col.country"), render: (r) => (r.country ? countryName(r.country, locale) : "—") },
            {
              key: "revenue",
              header: t("financeOrders.list.col.netRevenue"),
              align: "end",
              render: (r) => <Amount value={r.netRevenue} currency={currency} unconverted={unconverted(r, "netRevenue")} />,
            },
            { key: "cogs", header: t("financeOrders.list.col.cogs"), align: "end", render: (r) => <Amount value={r.cogs} currency={currency} unconverted={unconverted(r, "cogs")} /> },
            {
              key: "shipping",
              header: t("financeOrders.list.col.shipping"),
              align: "end",
              render: (r) => (
                <Stack gap={1}>
                  <Amount value={r.shipping} currency={currency} unconverted={unconverted(r, "shipping")} />
                  {r.components.shipping_cost ? <StateBadge state={r.components.shipping_cost} /> : null}
                </Stack>
              ),
            },
            { key: "fees", header: t("financeOrders.list.col.fees"), align: "end", hideOnMobile: true, render: (r) => <Amount value={r.fees} currency={currency} unconverted={unconverted(r, "fees")} /> },
            {
              key: "partner",
              header: t("financeOrders.list.col.partner"),
              align: "end",
              hideOnMobile: true,
              render: (r) => <Amount value={r.partner} currency={currency} unconverted={unconverted(r, "partner")} />,
            },
            { key: "profit", header: t("financeOrders.list.col.profit"), align: "end", render: (r) => <ProfitCell row={r} currency={currency} t={t} /> },
            { key: "margin", header: t("financeOrders.list.col.margin"), align: "end", render: (r) => <MarginCell row={r} locale={locale} /> },
            { key: "state", header: t("financeOrders.list.col.state"), render: (r) => <StateCell row={r} t={t} /> },
          ]}
        />
        {pages > 1 ? (
          <Pagination
            ariaLabel={t("financeOrders.list.pagination")}
            label={t("financeOrders.list.page", { page: list.page, pages })}
            prevLabel={t("financeOrders.list.prev")}
            nextLabel={t("financeOrders.list.next")}
            prevHref={list.page > 1 ? orderFinancePageHref(location.pathname, location.search, list.page - 1) : undefined}
            nextHref={list.page < pages ? orderFinancePageHref(location.pathname, location.search, list.page + 1) : undefined}
          />
        ) : null}
      </Stack>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

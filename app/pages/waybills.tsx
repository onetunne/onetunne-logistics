import { Fragment } from "react";
import { Link, useLoaderData, type LoaderFunctionArgs } from "react-router";
import { useCan, useHref, useShell } from "~/components/shell";
import { OrderStatusBadge, ShipmentStatusBadge, TestBadge } from "~/components/status-badge";
import { requirePermission } from "~/domain/permissions";
import { hasKey, useLocale, useT } from "~/i18n";
import { NOVA_GLOBAL_CODE } from "~/integrations/carriers/nova-global";
import type { CarrierCapabilities } from "~/integrations/carriers/types";
import { countryName, formatDateTime, formatMoney, formatNumber, formatWeight } from "~/lib/format";
import { listShipments } from "~/modules/orders/repository.server";
import { getRequestContext } from "~/server/context.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  Divider,
  EmptyState,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Stack,
  Text,
  type DataTableColumn,
} from "~/ui";

const SHIPMENT_LIMIT = 100;

/** Стани запису накладної (shipment_status у схемі БД) у порядку життєвого циклу. */
const SHIPMENT_STATUSES = ["creating", "created", "unknown", "failed", "cancelled"] as const;
type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** Можливості перевізника, які показуються на сторінці (решта — етапи 3+). */
const SHOWN_CAPABILITIES = [
  "createShipment",
  "cancelShipment",
  "findByReference",
  "rates",
  "tracking",
  "documents",
] as const satisfies ReadonlyArray<keyof CarrierCapabilities>;

/** Перелік накладних (лише перегляд). Створення — на сторінці замовлення або масово у списку замовлень. */
export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }

  const rows = await listShipments(ctx.db, { limit: SHIPMENT_LIMIT });
  const defaultCode = ctx.carriers.getDefault()?.code ?? null;
  const carriers = ctx.carriers.list().map((adapter) => ({
    code: adapter.code,
    displayName: adapter.displayName,
    mode: adapter.mode,
    isDefault: adapter.code === defaultCode,
    configured: adapter.capabilities.createShipment,
    capabilities: SHOWN_CAPABILITIES.map((key) => ({ key, available: adapter.capabilities[key] })),
  }));

  const statusCounts = Object.fromEntries(SHIPMENT_STATUSES.map((s) => [s, 0])) as Record<ShipmentStatus, number>;
  for (const r of rows) statusCounts[r.shipment.status] += 1;

  return {
    carriers,
    novaGlobalRegistered: carriers.some((c) => c.code === NOVA_GLOBAL_CODE),
    statusCounts,
    truncated: rows.length >= SHIPMENT_LIMIT,
    // Лише поля для таблиці: без знімка запиту до перевізника (персональні дані) і тексту помилок.
    shipments: rows.map(({ shipment: s, orderNumber, orderStatus, countryCode }) => ({
      id: s.id,
      orderId: s.orderId,
      orderNumber,
      orderStatus,
      countryCode,
      countryLabel: countryCode ? countryName(countryCode, ctx.locale) : null,
      carrierCode: s.carrierCode,
      mode: s.mode,
      status: s.status,
      waybillNumber: s.waybillNumber,
      reference: s.carrierReference,
      attempts: s.attempts,
      chargeableWeightGrams: s.chargeableWeightGrams,
      declaredValue: s.declaredValue,
      currency: s.currency,
      createdAt: s.createdAt,
    })),
  };
}

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Carrier = LoaderData["carriers"][number];
type Row = LoaderData["shipments"][number];

const DASH = "—";

/** Назва перевізника: перекладена для відомих адаптерів (тестовий), інакше — назва з адаптера. */
function useCarrierName(): (code: string, displayName: string) => string {
  const t = useT();
  return (code, displayName) => {
    const key = `waybills.carrierName.${code}`;
    return hasKey(key) ? t(key) : displayName;
  };
}

export default function WaybillsPage() {
  const data = useLoaderData<typeof loader>();
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const { mode } = useShell();
  const carrierName = useCarrierName();

  const { shipments, statusCounts } = data;
  const carriersByCode = new Map(data.carriers.map((c) => [c.code, c]));
  const nameOf = (code: string) => carrierName(code, carriersByCode.get(code)?.displayName ?? code);
  const multiCarrier = new Set(shipments.map((s) => s.carrierCode)).size > 1;

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "waybill",
      header: t("waybills.col.waybill"),
      primary: true,
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={2} align="center">
          {r.waybillNumber ? (
            <InlineCode>{r.waybillNumber}</InlineCode>
          ) : (
            <Text as="span" variant="body-sm" tone="subdued">
              {t("waybills.noNumber")} <InlineCode>{r.reference}</InlineCode>
            </Text>
          )}
          {r.mode === "test" ? <TestBadge /> : null}
        </Stack>
      ),
    },
    { key: "status", header: t("waybills.col.status"), render: (r) => <ShipmentStatusBadge status={r.status} /> },
    {
      key: "order",
      header: t("waybills.col.order"),
      render: (r) => <Link to={href(`orders/${r.orderId}`)}>{r.orderNumber}</Link>,
    },
    { key: "orderStatus", header: t("waybills.col.orderStatus"), render: (r) => <OrderStatusBadge status={r.orderStatus} /> },
    {
      key: "destination",
      header: t("waybills.col.destination"),
      render: (r) =>
        r.countryCode ? (
          <Stack as="span" direction="horizontal" gap={1} align="center">
            <InlineCode>{r.countryCode}</InlineCode>
            <span>{r.countryLabel}</span>
          </Stack>
        ) : (
          DASH
        ),
    },
    ...(multiCarrier
      ? [{ key: "carrier", header: t("waybills.col.carrier"), hideOnMobile: true, render: (r: Row) => nameOf(r.carrierCode) }]
      : []),
    {
      key: "weight",
      header: t("waybills.col.weight"),
      align: "end",
      render: (r) => (
        <Text as="span" numeric>
          {formatWeight(r.chargeableWeightGrams, locale)}
        </Text>
      ),
    },
    {
      key: "value",
      header: t("waybills.col.value"),
      align: "end",
      render: (r) => (
        <Text as="span" numeric>
          {formatMoney(r.declaredValue, r.currency, locale)}
        </Text>
      ),
    },
    {
      key: "attempts",
      header: t("waybills.col.attempts"),
      align: "end",
      hideOnMobile: true,
      render: (r) => (
        <Text as="span" numeric>
          {r.attempts}
        </Text>
      ),
    },
    {
      key: "created",
      header: t("waybills.col.created"),
      hideOnMobile: true,
      render: (r) => formatDateTime(r.createdAt, locale),
    },
  ];

  return (
    <Page title={t("nav.waybills")} subtitle={t("waybills.subtitle")}>
      <Stack gap={5}>
        <Banner tone="info" title={t(mode === "demo" ? "waybills.info.title" : "waybills.info.titleProduction")}>
          <p>{t(mode === "demo" ? "waybills.info.demo" : "waybills.info.production")}</p>
          <p>{t("waybills.info.notShipped")}</p>
          <p>{t("waybills.info.stage3")}</p>
          <p>{t("waybills.info.novaGlobal")}</p>
        </Banner>

        {statusCounts.unknown > 0 ? (
          <Banner
            tone="warning"
            title={t("waybills.unknown.title")}
            action={
              can("problems.view") ? (
                <Button to={href("problems")} size="sm">
                  {t("waybills.unknown.action")}
                </Button>
              ) : null
            }
          >
            {t("waybills.unknown.body", { count: statusCounts.unknown })}
          </Banner>
        ) : null}

        {shipments.length > 0 ? (
          <Stack gap={3} as="section">
            <Text as="h2" variant="heading-md">
              {t("waybills.summary.title")}
            </Text>
            <Grid columns={{ xs: 2, md: 3, lg: 5 }} gap={3}>
              {SHIPMENT_STATUSES.map((status) => (
                <Card
                  key={status}
                  title={t(`shipmentStatus.${status}`)}
                  titleAs="h3"
                  description={t(`waybills.summary.hint.${status}`)}
                >
                  <Text as="p" variant="heading-lg" numeric>
                    {formatNumber(statusCounts[status], locale)}
                  </Text>
                </Card>
              ))}
            </Grid>
            {data.truncated ? (
              <Text variant="body-sm" tone="subdued">
                {t("waybills.summary.partial", { count: shipments.length })}
              </Text>
            ) : null}
          </Stack>
        ) : null}

        <Card title={t("waybills.table.title")} padded={false}>
          <DataTable<Row>
            caption={t("waybills.table.caption")}
            rows={shipments}
            rowKey={(r) => r.id}
            columns={columns}
            emptyState={
              <EmptyState
                title={t("waybills.empty.title")}
                description={t("waybills.empty.description")}
                action={<Button to={href("orders")}>{t("waybills.empty.toOrders")}</Button>}
              />
            }
          />
        </Card>
        {data.truncated ? (
          <Text variant="body-sm" tone="subdued">
            {t("waybills.limit", { limit: SHIPMENT_LIMIT })}
          </Text>
        ) : null}

        <Card title={t("waybills.carriers.title")} description={t("waybills.carriers.description")}>
          {data.carriers.length === 0 ? (
            <Text tone="subdued">{t("waybills.carriers.none")}</Text>
          ) : (
            <Stack gap={4}>
              {data.carriers.map((carrier, index) => (
                <Fragment key={carrier.code}>
                  {index > 0 ? <Divider /> : null}
                  <CarrierItem carrier={carrier} name={carrierName(carrier.code, carrier.displayName)} />
                </Fragment>
              ))}
              {!data.novaGlobalRegistered ? (
                <>
                  <Divider />
                  <Text variant="body-sm" tone="subdued">
                    {t("waybills.carriers.novaPending")}
                  </Text>
                </>
              ) : null}
            </Stack>
          )}
        </Card>
      </Stack>
    </Page>
  );
}

/** Перевізник: режим (тестовий/робочий), чи налаштований, і які можливості доступні. */
function CarrierItem({ carrier, name }: { carrier: Carrier; name: string }) {
  const t = useT();
  const available = carrier.capabilities.filter((c) => c.available);
  const unavailable = carrier.capabilities.filter((c) => !c.available);
  const badges = (list: typeof carrier.capabilities, tone: "success" | "outline") =>
    list.length > 0 ? (
      <Stack as="span" direction="horizontal" gap={1}>
        {list.map((c) => (
          <Badge key={c.key} tone={tone} size="sm">
            {t(`waybills.capability.${c.key}`)}
          </Badge>
        ))}
      </Stack>
    ) : (
      t("common.none")
    );

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} align="center">
        <Text as="h3" variant="heading-sm">
          {name}
        </Text>
        {carrier.mode === "test" ? <TestBadge /> : <Badge tone="neutral">{t("waybills.carriers.mode.live")}</Badge>}
        {carrier.isDefault ? <Badge tone="info">{t("waybills.carriers.default")}</Badge> : null}
        {!carrier.configured ? <Badge tone="warning">{t("waybills.carriers.notConfigured")}</Badge> : null}
      </Stack>
      {!carrier.configured ? (
        <Text variant="body-sm" tone="subdued">
          {t("waybills.carriers.notConfiguredHelp")}
        </Text>
      ) : null}
      <KeyValueList
        items={[
          { key: "available", label: t("waybills.carriers.available"), value: badges(available, "success") },
          { key: "unavailable", label: t("waybills.carriers.unavailable"), value: badges(unavailable, "outline") },
        ]}
      />
    </Stack>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

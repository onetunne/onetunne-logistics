/**
 * Етап 6, WP9: випадок повернення …/returns/:returnId (docs/stage6-design.md §11, §14.2) — повна історія замовлення:
 * зміни (`order_changes`), статуси (`audit_log`), відправлення й події відстеження, пакування, рухи складу (списання при
 * передачі, надходження повернення, брак), повернення коштів Shopify, сам випадок (створення, приєднані джерела, зміни).
 * Доступ: `orders.view` (інакше 403); зміна випадку — `orders.edit` (сервіс перевіряє сам, compare-and-set за версією).
 * Лише власнику (`finance.view` + роль owner; працівнику loader повертає `amounts: null`): суми ЦЬОГО випадку
 * (повернено коштів, вартість зворотної доставки, обробка, вплив на собівартість — сторно придатних; пошкоджені —
 * довідково) і окремо «За замовленням, не прив'язано до випадку» (утримані збори, рядки рахунку перевізника, повернення
 * коштів без позицій); ручні витрати випадку й кнопки «Додати витрату на повернення» (форма «Фінанси → Витрати» із
 * заповненими замовленням і випадком; лише з `finance.manage`). Ознаки для всіх: «Очікує надходження на склад» (§6.7),
 * «кількість неточна» (рядки повернення коштів Shopify MIXED), «Тестове замовлення».
 */
import { Form, Link, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { CurrencySwitch } from "~/components/finance/currency-switch";
import { MoneyValue } from "~/components/finance/money-value";
import { useHref } from "~/components/shell";
import { RETURN_KINDS, RETURN_REASON_CODES, RETURN_STATUSES, type FinanceCategory } from "~/domain/finance";
import { can } from "~/domain/permissions";
import { hasKey, useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { NotFoundError } from "~/lib/errors";
import { countryName, formatDate, formatDateTime, formatIsoDate, formatMoney } from "~/lib/format";
import { canFinance, financeFieldOrNull } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { loadReturnAmounts, type ReturnMoneySum } from "~/modules/returns/amounts.server";
import { getReturnCase, updateReturnCase, type ReturnCaseLineView, type ReturnShipmentView, type ReturnTimelineEntry } from "~/modules/returns/cases.server";
import { returnsLabelKeys } from "~/modules/returns/labels";
import { CASE_MONEY_GROUP_KEYS, RETURN_MONEY_GROUP_KEYS } from "~/modules/returns/money-groups";
import type { ReturnSource, ReturnStatus } from "~/modules/returns/rules";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  FormLayout,
  Grid,
  KeyValueList,
  Page,
  Select,
  Stack,
  Text,
  TextField,
  Timeline,
  type BadgeTone,
  type TimelineItem,
} from "~/ui";

const NOTICES = ["created", "replay", "existing", "opened"] as const;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "orders.view")) throw new Response("Forbidden", { status: 403 });
  const id = params.returnId ?? "";
  let detail: Awaited<ReturnType<typeof getReturnCase>>;
  try {
    detail = await getReturnCase(ctx, id);
  } catch (e) {
    if (e instanceof NotFoundError) throw new Response("Not found", { status: 404 });
    throw e;
  }
  const sp = new URL(request.url).searchParams;
  const amounts = await financeFieldOrNull(ctx, () => loadReturnAmounts(ctx, detail.case.id, { currency: sp.get("currency") }));
  const notice = (NOTICES as readonly string[]).includes(sp.get("notice") ?? "") ? (sp.get("notice") as (typeof NOTICES)[number]) : null;
  return {
    demo: ctx.mode === "demo",
    detail,
    amounts,
    notice,
    canEdit: can(ctx.actor, "orders.edit"),
    canAddExpense: canFinance(ctx.actor, "manage"),
  };
}

export async function action({ request, params }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "orders.view")) throw new Response("Forbidden", { status: 403 });
  try {
    const form = await request.formData();
    if (formString(form, "intent") !== "update") return { ok: false, error: "error.generic" };
    const version = Number.parseInt(formString(form, "version"), 10);
    const r = await updateReturnCase(ctx, {
      id: params.returnId ?? "",
      expectedVersion: Number.isFinite(version) ? version : -1,
      kind: formString(form, "kind") || undefined,
      reasonCode: formString(form, "reasonCode") || undefined,
      status: formString(form, "status") || undefined,
      note: form.has("note") ? formString(form, "note") : undefined,
    });
    return {
      ok: true,
      message: r.changed ? "returns.result.updated" : "returns.result.unchanged",
    };
  } catch (e) {
    return toActionError(e);
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

const STATUS_TONE: Record<ReturnStatus, BadgeTone> = {
  open: "warning",
  in_transit: "info",
  received: "success",
  closed: "neutral",
};

export default function ReturnDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const { detail } = data;
  const signals = detail.shipments.filter((s) => s.signal);
  return (
    <Page title={t("returns.detail.title", { order: detail.order.orderNumber })} backHref={href("returns")} backLabel={t("returns.detail.back")}>
      <Stack gap={4}>
        {data.demo ? <Banner tone="info">{t("returns.demo")}</Banner> : null}
        {data.notice ? <Banner tone={data.notice === "existing" ? "info" : "success"}>{t(`returns.notice.${data.notice}`)}</Banner> : null}
        <ActionBanner data={actionData} />
        {detail.awaitingReceipt ? (
          <Banner tone="warning">{t(detail.awaitingReceiptUncertain ? "returns.awaiting.helpUncertain" : "returns.awaiting.help")}</Banner>
        ) : null}
        {detail.quantityUncertain ? <Banner tone="info">{t("returns.uncertain.help")}</Banner> : null}
        {signals.map((s) => (
          <Banner key={s.id} tone="warning">
            {t("returns.detail.carrierSignal", {
              signal: t(returnsLabelKeys.signal(s.signal!)),
              code: s.code ?? "",
              number: s.waybillNumber ?? "—",
            })}
          </Banner>
        ))}
        <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
          <Stack gap={4}>
            <SummaryCard data={data} t={t} locale={locale} />
            {data.canEdit ? <EditCard data={data} t={t} /> : null}
          </Stack>
          <Stack gap={4}>
            {data.amounts ? <AmountsCard data={data} t={t} locale={locale} /> : null}
            <LinesCard lines={detail.lines} units={detail.units} t={t} />
          </Stack>
        </Grid>
        <ShipmentsCard shipments={detail.shipments} t={t} locale={locale} />
        {detail.otherCases.length > 0 ? (
          <Card title={t("returns.detail.otherCases")}>
            <Stack gap={2}>
              {detail.otherCases.map((o) => (
                <Link key={o.id} to={href(`returns/${o.id}`)}>
                  {[t(returnsLabelKeys.kind(o.kind)), t(returnsLabelKeys.status(o.status)), formatDate(o.firstSignalAt, locale)].join(" · ")}
                </Link>
              ))}
            </Stack>
          </Card>
        ) : null}
        <TimelineCard entries={detail.timeline} t={t} locale={locale} />
      </Stack>
    </Page>
  );
}

interface SectionProps {
  data: Data;
  t: TFunction;
  locale: Locale;
}

function SummaryCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const { detail } = data;
  const c = detail.case;
  const statusKey = `status.${detail.order.status}`;
  return (
    <Card title={t("returns.detail.summary")}>
      <KeyValueList
        items={[
          {
            key: "order",
            label: t("returns.detail.order"),
            value: <Link to={href(`orders/${detail.order.id}`)}>{detail.order.orderNumber}</Link>,
          },
          {
            key: "kind",
            label: t("returns.field.kind"),
            value: t(returnsLabelKeys.kind(c.kind)),
          },
          {
            key: "status",
            label: t("returns.field.status"),
            value: (
              <Stack gap={1}>
                <span>
                  <Badge tone={STATUS_TONE[c.status]}>{t(returnsLabelKeys.status(c.status))}</Badge>
                </span>
                {detail.awaitingReceipt ? (
                  <span>
                    <Badge tone="warning">{t("returns.awaiting.badge")}</Badge>
                  </span>
                ) : null}
              </Stack>
            ),
          },
          {
            key: "reason",
            label: t("returns.field.reason"),
            value: t(returnsLabelKeys.reason(c.reasonCode)),
          },
          ...(c.reasonNote
            ? [
                {
                  key: "note",
                  label: t("returns.field.note"),
                  value: c.reasonNote,
                },
              ]
            : []),
          {
            key: "source",
            label: t("returns.detail.source"),
            value: t(returnsLabelKeys.source(c.source as ReturnSource)),
          },
          {
            key: "first",
            label: t("returns.detail.firstSignal"),
            value: formatDateTime(c.firstSignalAt, locale),
          },
          {
            key: "received",
            label: t("returns.detail.received"),
            value: formatDateTime(c.receivedAt, locale),
          },
          ...(c.closedAt
            ? [
                {
                  key: "closed",
                  label: t("returns.detail.closed"),
                  value: formatDateTime(c.closedAt, locale),
                },
              ]
            : []),
          {
            key: "country",
            label: t("returns.detail.country"),
            value: countryName(detail.order.countryCode, locale),
          },
          {
            key: "orderStatus",
            label: t("returns.detail.orderStatus"),
            value: (
              <Stack gap={1}>
                <span>{hasKey(statusKey) ? t(statusKey) : detail.order.status}</span>
                {detail.order.testOrder ? (
                  <span>
                    <Badge tone="neutral">{t("returns.testOrder")}</Badge>
                  </span>
                ) : null}
              </Stack>
            ),
          },
        ]}
      />
    </Card>
  );
}

function EditCard({ data, t }: { data: Data; t: TFunction }) {
  const c = data.detail.case;
  return (
    <Card title={t("returns.detail.edit")}>
      <Form method="post" preventScrollReset>
        <input type="hidden" name="intent" value="update" />
        <input type="hidden" name="version" value={c.version} />
        <FormLayout>
          <Select
            label={t("returns.field.kind")}
            name="kind"
            defaultValue={c.kind}
            options={RETURN_KINDS.map((k) => ({
              value: k,
              label: t(returnsLabelKeys.kind(k)),
            }))}
          />
          <Select
            label={t("returns.field.reason")}
            name="reasonCode"
            defaultValue={c.reasonCode}
            options={RETURN_REASON_CODES.map((r) => ({
              value: r,
              label: t(returnsLabelKeys.reason(r)),
            }))}
          />
          <Select
            label={t("returns.field.status")}
            name="status"
            defaultValue={c.status}
            options={RETURN_STATUSES.map((s) => ({
              value: s,
              label: t(returnsLabelKeys.status(s)),
            }))}
          />
          <TextField
            label={t("returns.field.note")}
            name="note"
            defaultValue={c.reasonNote ?? ""}
            multiline={3}
            maxLength={300}
            helpText={t("returns.field.noteHelp")}
          />
          <div>
            <Button type="submit">{t("returns.detail.save")}</Button>
          </div>
        </FormLayout>
      </Form>
    </Card>
  );
}

function LinesCard({ lines, units, t }: { lines: ReturnCaseLineView[]; units: Data["detail"]["units"]; t: TFunction }) {
  return (
    <Card
      title={t("returns.detail.lines")}
      description={
        lines.length > 0
          ? [t("returns.detail.unitsSummary", units), units.uncertainUnits > 0 ? t("returns.uncertain.units", { n: units.uncertainUnits }) : null]
              .filter(Boolean)
              .join(" · ")
          : undefined
      }
    >
      <DataTable<ReturnCaseLineView>
        caption={t("returns.detail.lines")}
        rows={lines}
        rowKey={(l) => l.id}
        emptyState={<Text tone="subdued">{t("returns.detail.noLines")}</Text>}
        columns={[
          {
            key: "item",
            header: t("returns.detail.col.item"),
            primary: true,
            render: (l) => [l.title ?? "—", l.variantTitle].filter(Boolean).join(" · "),
          },
          {
            key: "sku",
            header: t("returns.detail.col.sku"),
            render: (l) => l.sku ?? "—",
          },
          {
            key: "qty",
            header: t("returns.detail.col.qty"),
            align: "end",
            render: (l) =>
              l.uncertain ? (
                <Stack gap={1}>
                  <span>≤ {l.quantity}</span>
                  <span>
                    <Badge tone="warning">{t("returns.uncertain.line")}</Badge>
                  </span>
                </Stack>
              ) : (
                l.quantity
              ),
          },
          {
            key: "condition",
            header: t("returns.field.condition"),
            render: (l) => t(returnsLabelKeys.condition(l.condition)),
          },
          {
            key: "restocked",
            header: t("returns.detail.col.restocked"),
            align: "end",
            render: (l) => l.restockedQty,
          },
          {
            key: "origin",
            header: t("returns.detail.col.origin"),
            render: (l) => t(returnsLabelKeys.origin(l.origin)),
          },
        ]}
      />
    </Card>
  );
}

function MoneyLine({ sum, t, locale }: { sum: ReturnMoneySum; t: TFunction; locale: Locale }) {
  return (
    <Stack gap={1}>
      <MoneyValue value={sum.total === null ? null : { amount: sum.total, currency: sum.currency }} original={sum.original} />
      {sum.entries === 0 ? (
        <Text variant="body-sm" tone="subdued">
          {t("returns.money.noEntries")}
        </Text>
      ) : null}
      {sum.unconverted.map((u) => (
        <Text key={u.currency} variant="body-sm" tone="subdued">
          {t("returns.money.unconverted", {
            amount: formatMoney(u.amount, u.currency, locale),
            n: u.entries,
          })}
        </Text>
      ))}
    </Stack>
  );
}

function expenseHref(href: (p: string) => string, category: "return_shipping_cost" | "return_handling", orderNumber: string, returnId: string): string {
  const sp = new URLSearchParams({
    add: "expense",
    category,
    order: orderNumber,
    returnId,
  });
  return `${href("finance/expenses")}?${sp.toString()}#expense-form`;
}

function AmountsCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const money = data.amounts!;
  const { detail } = data;
  const orderLevel = money.orderLevel;
  const caseRefunds = money.refunds.filter((r) => r.scope === "case");
  const orderRefunds = money.refunds.filter((r) => r.scope === "order");
  return (
    <Card
      title={t("returns.money.title")}
      description={t("returns.money.scope")}
      actions={<CurrencySwitch current={money.currency} options={money.currencies} />}
    >
      <Stack gap={4}>
        <KeyValueList
          items={[
            ...CASE_MONEY_GROUP_KEYS.map((g) => ({
              key: g,
              label: t(returnsLabelKeys.money(g)),
              value: <MoneyLine sum={money.groups[g]} t={t} locale={locale} />,
            })),
            {
              key: "returnCosts",
              label: t(returnsLabelKeys.money("returnCosts")),
              value: <MoneyLine sum={money.returnCosts} t={t} locale={locale} />,
            },
          ]}
        />
        {money.damagedUnits > 0 ? (
          <Text variant="body-sm" tone="subdued">
            {t("returns.money.damaged", { n: money.damagedUnits })}
          </Text>
        ) : null}
        {money.orderCases > 1 ? (
          <Text variant="body-sm" tone="subdued">
            {t("returns.money.orderCases", { n: money.orderCases })}
          </Text>
        ) : null}
        {caseRefunds.length > 0 || orderRefunds.length > 0 ? (
          <Stack gap={1}>
            <Text weight="semibold">{t("returns.money.refundsTitle")}</Text>
            {[...caseRefunds, ...orderRefunds].map((r) => (
              <Text key={r.refundId} variant="body-sm" tone={r.scope === "order" ? "subdued" : "default"}>
                {[formatDate(r.at, locale), formatMoney(r.amount, r.currency, locale), r.scope === "order" ? t("returns.money.refundOrderLevel") : null]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ))}
          </Stack>
        ) : null}
        <Stack gap={2}>
          <Text weight="semibold">{t("returns.money.orderLevelTitle")}</Text>
          <Text variant="body-sm" tone="subdued">
            {t("returns.money.orderLevelHelp")}
          </Text>
          {orderLevel.entries === 0 ? (
            <Text variant="body-sm" tone="subdued">
              {t("returns.money.orderLevelNone")}
            </Text>
          ) : (
            <KeyValueList
              items={RETURN_MONEY_GROUP_KEYS.filter((g) => orderLevel.groups[g].entries > 0).map((g) => ({
                key: `order-${g}`,
                label: t(returnsLabelKeys.money(g)),
                value: <MoneyLine sum={orderLevel.groups[g]} t={t} locale={locale} />,
              }))}
            />
          )}
        </Stack>
        <Stack gap={1}>
          <Text weight="semibold">{t("returns.money.expensesTitle")}</Text>
          {money.expenses.length === 0 ? (
            <Text variant="body-sm" tone="subdued">
              {t("returns.money.noExpenses")}
            </Text>
          ) : (
            money.expenses.map((e) => (
              <Text key={e.id} variant="body-sm" tone={e.status === "voided" ? "subdued" : "default"}>
                {[
                  t(financeLabelKeys.category(e.category as FinanceCategory)),
                  formatMoney(e.amount, e.currency, locale),
                  e.date ? formatIsoDate(e.date, locale) : null,
                  e.status === "voided" ? t("returns.money.voided") : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
            ))
          )}
        </Stack>
        {data.canAddExpense ? (
          <Stack gap={2}>
            <Button to={expenseHref(href, "return_shipping_cost", detail.order.orderNumber, detail.case.id)}>{t("returns.money.addShipping")}</Button>
            <Button to={expenseHref(href, "return_handling", detail.order.orderNumber, detail.case.id)}>{t("returns.money.addHandling")}</Button>
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}

function ShipmentsCard({ shipments, t, locale }: { shipments: ReturnShipmentView[]; t: TFunction; locale: Locale }) {
  return (
    <Card title={t("returns.detail.shipments")}>
      <DataTable<ReturnShipmentView>
        caption={t("returns.detail.shipments")}
        rows={shipments}
        rowKey={(s) => s.id}
        emptyState={<Text tone="subdued">{t("returns.detail.noShipments")}</Text>}
        columns={[
          {
            key: "number",
            header: t("returns.detail.col.waybill"),
            primary: true,
            render: (s) => s.waybillNumber ?? "—",
          },
          {
            key: "carrier",
            header: t("returns.detail.col.carrier"),
            render: (s) => (s.carrierCode === "test" ? t("demo.testCarrier") : s.carrierCode),
          },
          {
            key: "tracking",
            header: t("returns.detail.col.tracking"),
            render: (s) =>
              s.trackingStatus && hasKey(`tracking.status.${s.trackingStatus}`) ? t(`tracking.status.${s.trackingStatus}`) : (s.trackingStatus ?? "—"),
          },
          {
            key: "handover",
            header: t("returns.detail.col.handedOver"),
            render: (s) => formatDate(s.handedOverAt, locale),
          },
          {
            key: "delivered",
            header: t("returns.detail.col.delivered"),
            render: (s) => formatDate(s.deliveredAt, locale),
          },
          {
            key: "signal",
            header: t("returns.detail.col.signal"),
            render: (s) => (s.signal ? t(returnsLabelKeys.signal(s.signal)) : "—"),
          },
        ]}
      />
    </Card>
  );
}

const TIMELINE_TONE: Partial<Record<ReturnTimelineEntry["type"], TimelineItem["tone"]>> = {
  refund: "warning",
  order_cancelled: "warning",
  waybill_failed: "warning",
  stock_return: "success",
  delivered: "success",
  handed_over: "success",
  waybill_cancelled: "warning",
  stock_defect: "warning",
  case_created: "success",
};

function label(t: TFunction, key: string, fallback: string): string {
  return key && hasKey(key) ? t(key) : fallback;
}

function timelineTitle(e: ReturnTimelineEntry, t: TFunction): string {
  const p = e.params;
  const str = (k: string) => String(p[k] ?? "");
  switch (e.type) {
    case "order_change":
      return t("returns.timeline.order_change", {
        field: label(t, `field.${str("field")}`, str("field")),
        from: str("from") || t("returns.timeline.emptyValue"),
        to: str("to") || t("returns.timeline.emptyValue"),
      });
    case "order_status":
      return t("returns.timeline.order_status", {
        from: label(t, `status.${str("from")}`, str("from")),
        to: label(t, `status.${str("to")}`, str("to")),
      });
    case "order_validated":
      return t("returns.timeline.order_validated", {
        to: label(t, `status.${str("to")}`, str("to") || "—"),
      });
    case "tracking": {
      const status = label(t, `tracking.status.${str("status")}`, str("status"));
      return p.signal
        ? t("returns.timeline.trackingReturn", {
            signal: t(returnsLabelKeys.signal(str("signal") as never)),
            code: str("code"),
          })
        : t("returns.timeline.tracking", { status, code: str("code") || "—" });
    }
    case "case_created":
      return t("returns.timeline.case_created", {
        kind: label(t, returnsLabelKeys.kind(str("kind") as never), str("kind")),
        source: label(t, returnsLabelKeys.source(str("source") as never), str("source")),
      });
    case "case_linked":
      return t("returns.timeline.case_linked", {
        source: label(t, returnsLabelKeys.source(str("source") as never), str("source")),
      });
    case "case_status":
      return t("returns.timeline.case_status", {
        from: label(t, returnsLabelKeys.status(str("from") as never), str("from")),
        to: label(t, returnsLabelKeys.status(str("to") as never), str("to")),
      });
    case "case_updated":
      return t("returns.timeline.case_updated", {
        fields: str("fields")
          .split(",")
          .filter(Boolean)
          .map((f) => label(t, `returns.field.${f}`, f))
          .join(", "),
      });
    default:
      return t(returnsLabelKeys.timeline(e.type), Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v === "" ? "—" : v])));
  }
}

function TimelineCard({ entries, t, locale }: { entries: ReturnTimelineEntry[]; t: TFunction; locale: Locale }) {
  const items: TimelineItem[] = entries.map((e) => ({
    id: e.id,
    title: timelineTitle(e, t),
    description: e.type.startsWith("case_") && !e.current ? t("returns.timeline.otherCase") : undefined,
    time: <time dateTime={new Date(e.at).toISOString()}>{formatDateTime(e.at, locale)}</time>,
    tone: e.type === "tracking" && e.params.signal ? "warning" : (TIMELINE_TONE[e.type] ?? "default"),
  }));
  return (
    <Card title={t("returns.detail.timeline")} description={t("returns.detail.timelineHelp")}>
      {items.length === 0 ? <Text tone="subdued">{t("returns.detail.noTimeline")}</Text> : <Timeline items={items} />}
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

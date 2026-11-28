/**
 * Етап 6, WP9: розділ «Повернення» …/returns (docs/stage6-design.md §11, §14.2).
 * Доступ: loader і action — `orders.view` (інакше 403); ручні дії — `orders.edit` (сервіси перевіряють самі). Суми — лише
 * з `finance.view` і роллю owner (`financeFieldOrNull` → працівник отримує `amounts: null`, не порожнє).
 *
 * Вкладка «Випадки»: «Можливе повернення (дані перевізника)» з кнопкою «Відкрити» (CARRIER_RETURN_CODES за ключем
 * перевізника, лише читання), фільтри (статус, вид, причина, країна, період першого сигналу, номер замовлення; на
 * телефоні — згорнуті), список (на телефоні — картки), «Додати випадок» (номер замовлення → позиції). Вкладка
 * «Статистика» (`?tab=stats` або параметр `period`): частка повернень з покриттям, причини, моделі, кольори, товари,
 * країни, дні «вручення → повернення», до / після відвантаження, поповнено / не поповнено склад; власнику — суми
 * (повернено коштів, витрати на повернення = зворотна доставка + обробка, сторно собівартості) у валюті показу.
 * Ознаки рядка: «Очікує надходження на склад» (§6.7), «Тестове замовлення», «ще до N од. — кількість неточна» (MIXED).
 * Статистика без тестових замовлень Shopify, якщо власник не ввімкнув `finance.includeTestOrders` (§2.5).
 * Порожня база — «Немає даних» / «Випадків повернень ще немає», ніде не вигаданий 0 для невідомого.
 */
import { Form, Link, redirect, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { CurrencySwitch } from "~/components/finance/currency-switch";
import { MoneyValue } from "~/components/finance/money-value";
import { PeriodBar } from "~/components/finance/period-bar";
import { useHref } from "~/components/shell";
import { RETURN_KINDS, RETURN_LINE_CONDITIONS, RETURN_REASON_CODES, RETURN_STATUSES } from "~/domain/finance";
import { can } from "~/domain/permissions";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { countryName, formatDate, formatDecimal, formatIsoDate, formatMoney, formatPercent } from "~/lib/format";
import { businessDate } from "~/lib/periods";
import { financeFieldOrNull } from "~/modules/finance/core/access.server";
import type { ReturnMoneySum } from "~/modules/returns/amounts.server";
import {
  createManualReturnCase,
  listCarrierReturnHints,
  listReturnCases,
  openReturnFromCarrierHint,
  returnFormOrder,
  RETURNS_PAGE_SIZE,
  type ReturnCaseRow,
} from "~/modules/returns/cases.server";
import { returnsLabelKeys } from "~/modules/returns/labels";
import { returnsPeriodOf } from "~/modules/returns/period";
import type { ReturnStatus } from "~/modules/returns/rules";
import { returnMoneyStats, returnStats, type CountRow } from "~/modules/returns/stats.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  Disclosure,
  EmptyState,
  FormLayout,
  Grid,
  KeyValueList,
  Page,
  Pagination,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  type BadgeTone,
} from "~/ui";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "orders.view")) throw new Response("Forbidden", { status: 403 });
  const sp = new URL(request.url).searchParams;
  const tab: "cases" | "stats" = sp.get("tab") === "stats" || sp.has("period") ? "stats" : "cases";
  const today = businessDate(ctx.now());
  const canEdit = can(ctx.actor, "orders.edit");
  const base = { demo: ctx.mode === "demo", tab, canEdit, today };
  if (tab === "stats") {
    const period = returnsPeriodOf(sp, today);
    const [stats, amounts] = await Promise.all([
      returnStats(ctx, { range: period.range }),
      financeFieldOrNull(ctx, () =>
        returnMoneyStats(ctx, {
          range: period.range,
          currency: sp.get("currency"),
        }),
      ),
    ]);
    return {
      ...base,
      period,
      stats,
      amounts,
      list: null,
      hints: null,
      filter: null,
      form: null,
      operationId: null,
    };
  }
  const pick = (name: string, values: readonly string[]) => {
    const v = sp.get(name) ?? "";
    return values.includes(v) ? v : "";
  };
  const date = (name: string) => {
    const v = (sp.get(name) ?? "").trim();
    return DATE_RE.test(v) ? v : "";
  };
  const filter = {
    status: pick("status", RETURN_STATUSES),
    kind: pick("kind", RETURN_KINDS),
    reason: pick("reason", RETURN_REASON_CODES),
    country: /^[A-Za-z]{2}$/.test(sp.get("country") ?? "") ? sp.get("country")!.toUpperCase() : "",
    from: date("from"),
    to: date("to"),
    q: (sp.get("q") ?? "").trim().slice(0, 40),
    page: Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1),
  };
  const orderRef = canEdit ? (sp.get("order") ?? "").trim().slice(0, 64) : "";
  const [list, hints, formOrder] = await Promise.all([
    listReturnCases(ctx, { ...filter, pageSize: RETURNS_PAGE_SIZE }),
    listCarrierReturnHints(ctx),
    orderRef ? returnFormOrder(ctx, orderRef) : Promise.resolve(null),
  ]);
  return {
    ...base,
    period: null,
    stats: null,
    amounts: null,
    list,
    hints,
    filter,
    form: orderRef ? { ref: orderRef, order: formOrder } : null,
    operationId: canEdit ? globalThis.crypto.randomUUID() : null,
  };
}

type ReturnsActionResult = ActionResult & { intent?: string };

export async function action({ request }: ActionFunctionArgs): Promise<ReturnsActionResult | Response> {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "orders.view")) throw new Response("Forbidden", { status: 403 });
  let intent = "";
  try {
    const form = await request.formData();
    intent = formString(form, "intent");
    if (intent === "createCase") {
      const lines: Array<{
        orderLineItemId: string;
        quantity: number;
        condition: string;
      }> = [];
      for (const raw of form.getAll("itemId")) {
        const id = String(raw);
        const qtyText = formString(form, `qty_${id}`).trim();
        if (qtyText === "" || qtyText === "0") continue;
        const quantity = /^\d{1,6}$/.test(qtyText) ? Number(qtyText) : Number.NaN;
        lines.push({
          orderLineItemId: id,
          quantity,
          condition: formString(form, `condition_${id}`),
        });
      }
      const r = await createManualReturnCase(ctx, {
        operationId: formString(form, "operationId"),
        orderRef: formString(form, "orderRef"),
        kind: formString(form, "kind"),
        reasonCode: formString(form, "reasonCode") || null,
        status: formString(form, "status") || null,
        note: formString(form, "note") || null,
        lines,
      });
      return redirect(`${ctx.basePath}/returns/${r.caseId}?notice=${r.outcome}`);
    }
    if (intent === "openHint") {
      const r = await openReturnFromCarrierHint(ctx, {
        shipmentId: formString(form, "shipmentId"),
      });
      return redirect(`${ctx.basePath}/returns/${r.caseId}?notice=${r.outcome === "created" ? "opened" : r.outcome}`);
    }
    return { ok: false, error: "error.generic", intent };
  } catch (e) {
    return { ...toActionError(e), intent };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

const RETURN_STATUS_TONE: Record<ReturnStatus, BadgeTone> = {
  open: "warning",
  in_transit: "info",
  received: "success",
  closed: "neutral",
};

export default function ReturnsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ReturnsActionResult | undefined;
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  return (
    <Page title={t("nav.returns")} subtitle={t("returns.subtitle")}>
      <Stack gap={4}>
        {data.demo ? <Banner tone="info">{t("returns.demo")}</Banner> : null}
        <ActionBanner data={actionData} />
        <Tabs
          ariaLabel={t("returns.tabs.aria")}
          selected={data.tab}
          items={[
            {
              key: "cases",
              label: t("returns.tab.cases"),
              href: href("returns"),
            },
            {
              key: "stats",
              label: t("returns.tab.stats"),
              href: href("returns?tab=stats"),
            },
          ]}
        />
        {data.tab === "stats" ? <StatsTab data={data} t={t} locale={locale} /> : <CasesTab data={data} t={t} locale={locale} />}
      </Stack>
    </Page>
  );
}

interface SectionProps {
  data: Data;
  t: TFunction;
  locale: Locale;
}

// ---------------------------------------------------------------------------
// Випадки
// ---------------------------------------------------------------------------

function CasesTab({ data, t, locale }: SectionProps) {
  return (
    <Stack gap={4}>
      <HintsCard data={data} t={t} locale={locale} />
      <FiltersCard data={data} t={t} locale={locale} />
      <CasesCard data={data} t={t} locale={locale} />
      {data.canEdit ? <NewCaseCard data={data} t={t} locale={locale} /> : null}
    </Stack>
  );
}

function HintsCard({ data, t, locale }: SectionProps) {
  const hints = data.hints ?? [];
  if (hints.length === 0) return null;
  return (
    <Card title={t("returns.hints.title")} description={t("returns.hints.description")}>
      <Stack gap={3}>
        {hints.map((h) => (
          <Form method="post" key={h.shipmentId} preventScrollReset>
            <input type="hidden" name="intent" value="openHint" />
            <input type="hidden" name="shipmentId" value={h.shipmentId} />
            <Stack gap={2}>
              <Text weight="semibold">
                {t("returns.hints.line", {
                  order: h.orderNumber,
                  signal: t(returnsLabelKeys.signal(h.signal)),
                })}
              </Text>
              <Text variant="body-sm" tone="subdued">
                {[
                  h.waybillNumber
                    ? t("returns.hints.waybill", {
                        number: h.waybillNumber,
                        code: h.code,
                      })
                    : t("returns.hints.code", { code: h.code }),
                  t("returns.hints.suggested", {
                    kind: t(returnsLabelKeys.kind(h.suggestedKind)),
                  }),
                  h.at ? formatDate(h.at, locale) : null,
                  h.countryCode ? countryName(h.countryCode, locale) : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Text>
              {data.canEdit ? (
                <div>
                  <Button type="submit" variant="secondary">
                    {t("returns.hints.open")}
                  </Button>
                </div>
              ) : null}
            </Stack>
          </Form>
        ))}
      </Stack>
    </Card>
  );
}

function FiltersCard({ data, t, locale }: SectionProps) {
  const f = data.filter;
  if (!f) return null;
  const any = { value: "", label: t("returns.filters.any") };
  const active = Boolean(f.status || f.kind || f.reason || f.country || f.from || f.to || f.q);
  const countries = data.list?.countries ?? [];
  return (
    <Card>
      <Disclosure summary={t("returns.filters.title")} collapsedOnMobile defaultOpen={active}>
        <Form method="get" preventScrollReset>
          <FormLayout>
            <Grid columns={{ xs: 1, md: 2, lg: 4 }} gap={3}>
              <Select
                label={t("returns.filters.status")}
                name="status"
                defaultValue={f.status}
                options={[
                  any,
                  ...RETURN_STATUSES.map((s) => ({
                    value: s,
                    label: t(returnsLabelKeys.status(s)),
                  })),
                ]}
              />
              <Select
                label={t("returns.filters.kind")}
                name="kind"
                defaultValue={f.kind}
                options={[
                  any,
                  ...RETURN_KINDS.map((k) => ({
                    value: k,
                    label: t(returnsLabelKeys.kind(k)),
                  })),
                ]}
              />
              <Select
                label={t("returns.filters.reason")}
                name="reason"
                defaultValue={f.reason}
                options={[
                  any,
                  ...RETURN_REASON_CODES.map((r) => ({
                    value: r,
                    label: t(returnsLabelKeys.reason(r)),
                  })),
                ]}
              />
              <Select
                label={t("returns.filters.country")}
                name="country"
                defaultValue={f.country}
                options={[
                  any,
                  ...countries.map((c) => ({
                    value: c,
                    label: countryName(c, locale),
                  })),
                ]}
              />
              <TextField label={t("returns.filters.from")} name="from" type="date" defaultValue={f.from} />
              <TextField label={t("returns.filters.to")} name="to" type="date" defaultValue={f.to} />
              <TextField label={t("returns.filters.q")} name="q" type="search" defaultValue={f.q} inputMode="numeric" />
            </Grid>
            <Stack gap={2}>
              <div>
                <Button type="submit">{t("returns.filters.apply")}</Button>
              </div>
              {active ? <Link to="?">{t("returns.filters.reset")}</Link> : null}
            </Stack>
          </FormLayout>
        </Form>
      </Disclosure>
    </Card>
  );
}

function pageHref(filter: NonNullable<Data["filter"]>, page: number): string {
  const sp = new URLSearchParams();
  for (const k of ["status", "kind", "reason", "country", "from", "to", "q"] as const) if (filter[k]) sp.set(k, filter[k]);
  if (page > 1) sp.set("page", String(page));
  const s = sp.toString();
  return s ? `?${s}` : "?";
}

function CasesCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const list = data.list;
  const f = data.filter;
  if (!list || !f) return null;
  const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
  const filtered = Boolean(f.status || f.kind || f.reason || f.country || f.from || f.to || f.q);
  return (
    <Card title={t("returns.list.title")} description={list.total > 0 ? t("returns.list.total", { n: list.total }) : undefined}>
      <Stack gap={3}>
        <DataTable<ReturnCaseRow>
          caption={t("returns.list.title")}
          rows={list.rows}
          rowKey={(r) => r.id}
          rowHref={(r) => href(`returns/${r.id}`)}
          emptyState={<EmptyState title={t(filtered ? "returns.list.emptyFiltered" : "returns.list.empty")} description={t("returns.list.emptyHelp")} />}
          columns={[
            {
              key: "order",
              header: t("returns.list.col.order"),
              primary: true,
              render: (r) =>
                r.testOrder ? (
                  <Stack gap={1}>
                    <span>{r.orderNumber}</span>
                    <span>
                      <Badge tone="neutral">{t("returns.testOrder")}</Badge>
                    </span>
                  </Stack>
                ) : (
                  r.orderNumber
                ),
            },
            {
              key: "kind",
              header: t("returns.list.col.kind"),
              render: (r) => t(returnsLabelKeys.kind(r.kind)),
            },
            {
              key: "status",
              header: t("returns.list.col.status"),
              render: (r) => (
                <Stack gap={1}>
                  <span>
                    <Badge tone={RETURN_STATUS_TONE[r.status]}>{t(returnsLabelKeys.status(r.status))}</Badge>
                  </span>
                  {r.awaitingReceipt ? (
                    <span>
                      <Badge tone="warning">{t("returns.awaiting.badge")}</Badge>
                    </span>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "reason",
              header: t("returns.list.col.reason"),
              render: (r) => t(returnsLabelKeys.reason(r.reasonCode)),
            },
            {
              key: "signal",
              header: t("returns.list.col.signal"),
              render: (r) => formatDate(r.firstSignalAt, locale),
            },
            {
              key: "country",
              header: t("returns.list.col.country"),
              render: (r) => countryName(r.countryCode, locale),
            },
            {
              key: "units",
              header: t("returns.list.col.units"),
              align: "end",
              render: (r) => {
                const exact =
                  r.units > 0
                    ? t("returns.list.unitsValue", {
                        units: r.units,
                        restocked: r.restocked,
                      })
                    : null;
                const uncertain = r.uncertainUnits > 0 ? t("returns.uncertain.units", { n: r.uncertainUnits }) : null;
                return [exact, uncertain].filter(Boolean).join(" · ") || "—";
              },
            },
          ]}
        />
        {pages > 1 ? (
          <Pagination
            prevHref={list.page > 1 ? pageHref(f, list.page - 1) : null}
            nextHref={list.page < pages ? pageHref(f, list.page + 1) : null}
            label={t("returns.list.page", { page: list.page, pages })}
            prevLabel={t("returns.list.prev")}
            nextLabel={t("returns.list.next")}
          />
        ) : null}
      </Stack>
    </Card>
  );
}

function NewCaseCard({ data, t }: SectionProps) {
  const form = data.form;
  const order = form?.order ?? null;
  return (
    <Card id="new-case" title={t("returns.new.title")} description={t("returns.new.description")}>
      <Stack gap={4}>
        <Form method="get" preventScrollReset>
          <FormLayout>
            <TextField label={t("returns.new.orderRef")} name="order" defaultValue={form?.ref ?? ""} required inputMode="numeric" />
            <div>
              <Button type="submit" variant="secondary">
                {t("returns.new.find")}
              </Button>
            </div>
          </FormLayout>
        </Form>
        {form && !order ? <Banner tone="warning">{t("returns.error.orderNotFound", { order: form.ref })}</Banner> : null}
        {order ? (
          <Form method="post" preventScrollReset>
            <input type="hidden" name="intent" value="createCase" />
            <input type="hidden" name="operationId" value={data.operationId ?? ""} />
            <input type="hidden" name="orderRef" value={order.id} />
            <FormLayout>
              <Text weight="semibold">{t("returns.new.forOrder", { order: order.orderNumber })}</Text>
              {order.openCaseId ? (
                <Banner tone="info">
                  {t("returns.new.openExists")} <OpenCaseLink id={order.openCaseId} t={t} />
                </Banner>
              ) : null}
              <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                <Select
                  label={t("returns.field.kind")}
                  name="kind"
                  defaultValue="customer_return"
                  options={RETURN_KINDS.map((k) => ({
                    value: k,
                    label: t(returnsLabelKeys.kind(k)),
                  }))}
                />
                <Select
                  label={t("returns.field.reason")}
                  name="reasonCode"
                  defaultValue="unknown"
                  options={RETURN_REASON_CODES.map((r) => ({
                    value: r,
                    label: t(returnsLabelKeys.reason(r)),
                  }))}
                />
                <Select
                  label={t("returns.field.status")}
                  name="status"
                  defaultValue="open"
                  options={RETURN_STATUSES.map((s) => ({
                    value: s,
                    label: t(returnsLabelKeys.status(s)),
                  }))}
                />
              </Grid>
              <TextField label={t("returns.field.note")} name="note" multiline={3} maxLength={300} helpText={t("returns.field.noteHelp")} />
              {order.items.length === 0 ? (
                <Text tone="subdued">{t("returns.new.noItems")}</Text>
              ) : (
                <Stack gap={3}>
                  <Text weight="semibold">{t("returns.new.items")}</Text>
                  {order.items.map((i) => (
                    <Grid key={i.id} columns={{ xs: 1, md: 3 }} gap={2}>
                      <input type="hidden" name="itemId" value={i.id} />
                      <Text>{[i.title, i.variantTitle, i.sku].filter(Boolean).join(" · ")}</Text>
                      <TextField
                        label={t("returns.new.qty", { max: i.quantity })}
                        name={`qty_${i.id}`}
                        type="number"
                        min={0}
                        max={i.quantity}
                        defaultValue="0"
                      />
                      <Select
                        label={t("returns.field.condition")}
                        name={`condition_${i.id}`}
                        defaultValue="unknown"
                        options={RETURN_LINE_CONDITIONS.map((c) => ({
                          value: c,
                          label: t(returnsLabelKeys.condition(c)),
                        }))}
                      />
                    </Grid>
                  ))}
                </Stack>
              )}
              <div>
                <Button type="submit">{t("returns.new.submit")}</Button>
              </div>
            </FormLayout>
          </Form>
        ) : null}
      </Stack>
    </Card>
  );
}

function OpenCaseLink({ id, t }: { id: string; t: TFunction }) {
  const href = useHref();
  return <Link to={href(`returns/${id}`)}>{t("returns.new.openLink")}</Link>;
}

// ---------------------------------------------------------------------------
// Статистика
// ---------------------------------------------------------------------------

function StatsTab({ data, t, locale }: SectionProps) {
  const s = data.stats;
  const period = data.period;
  if (!s || !period) return null;
  return (
    <Stack gap={4}>
      <Card>
        <Stack gap={3}>
          <PeriodBar preset={period.preset} range={period.range} granularity="month" compare="none" allowCustom />
          <Text variant="body-sm" tone="subdued">
            {t("returns.stats.period", {
              from: formatIsoDate(period.range.from, locale),
              to: formatIsoDate(period.range.to, locale),
            })}
          </Text>
          <Text variant="body-sm" tone="subdued">
            {t(s.includesTestOrders ? "returns.stats.testOrders.included" : "returns.stats.testOrders.excluded")}
          </Text>
        </Stack>
      </Card>
      <Grid columns={{ xs: 1, md: 2, lg: 3 }} gap={4}>
        <Card title={t("returns.stats.rate.title")}>
          <Stack gap={2}>
            <Text variant="heading-lg">{formatPercent(s.rate.percent, locale)}</Text>
            <Text variant="body-sm">
              {t("returns.stats.rate.detail", {
                returned: s.rate.returned,
                known: s.rate.known,
              })}
            </Text>
            <Text variant="body-sm" tone="subdued">
              {t("returns.stats.rate.coverage", {
                known: s.rate.known,
                recognized: s.rate.recognized,
              })}
            </Text>
            <Text variant="body-sm" tone="subdued">
              {t("returns.stats.rate.help")}
            </Text>
          </Stack>
        </Card>
        <Card title={t("returns.stats.cases.title")}>
          <KeyValueList
            items={[
              {
                key: "cases",
                label: t("returns.stats.cases.count"),
                value: s.cases,
              },
              {
                key: "units",
                label: t("returns.stats.units.total"),
                value: s.units.total,
              },
              {
                key: "restocked",
                label: t("returns.stats.units.restocked"),
                value: s.units.restocked,
              },
              {
                key: "notRestocked",
                label: t("returns.stats.units.notRestocked"),
                value: s.units.notRestocked,
              },
              {
                key: "damaged",
                label: t("returns.stats.units.damaged"),
                value: s.units.damaged,
              },
              ...(s.units.uncertain > 0
                ? [
                    {
                      key: "uncertain",
                      label: t("returns.stats.units.uncertain"),
                      value: (
                        <Stack gap={1}>
                          <span>{s.units.uncertain}</span>
                          <Text variant="body-sm" tone="subdued">
                            {t("returns.stats.units.uncertainHelp", { n: s.units.uncertainCases })}
                          </Text>
                        </Stack>
                      ),
                    },
                  ]
                : []),
              {
                key: "awaiting",
                label: t("returns.stats.awaiting"),
                value: s.awaitingReceipt,
              },
            ]}
          />
        </Card>
        <Card title={t("returns.stats.timing.title")}>
          <KeyValueList
            items={[
              {
                key: "days",
                label: t("returns.stats.days.title"),
                value: (
                  <Stack gap={1}>
                    <span>
                      {s.days.average === null
                        ? "—"
                        : t("returns.stats.days.value", {
                            days: formatDecimal(Number(s.days.average), locale, {
                              minimumFractionDigits: 1,
                              maximumFractionDigits: 1,
                            }),
                          })}
                    </span>
                    <Text variant="body-sm" tone="subdued">
                      {t("returns.stats.days.coverage", {
                        n: s.days.n,
                        m: s.days.m,
                      })}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "before",
                label: t("returns.stats.timing.before"),
                value: s.timing.beforeShipment,
              },
              {
                key: "after",
                label: t("returns.stats.timing.after"),
                value: s.timing.afterShipment,
              },
            ]}
          />
        </Card>
      </Grid>
      {data.amounts ? <MoneyCard money={data.amounts} t={t} /> : null}
      {s.cases === 0 ? (
        <Card>
          <EmptyState title={t("returns.stats.empty")} description={t("returns.list.emptyHelp")} />
        </Card>
      ) : (
        <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
          <CountCard
            title={t("returns.stats.byReason")}
            note={t("returns.stats.reasonCoverage", {
              n: s.reasonCoverage.n,
              m: s.reasonCoverage.m,
            })}
            rows={s.byReason.map((r) => ({
              ...r,
              text: t(returnsLabelKeys.reason(r.key)),
            }))}
            t={t}
          />
          <CountCard
            title={t("returns.stats.byKind")}
            rows={s.byKind.map((r) => ({
              ...r,
              text: t(returnsLabelKeys.kind(r.key)),
            }))}
            t={t}
          />
          <CountCard
            title={t("returns.stats.byStatus")}
            rows={s.byStatus.map((r) => ({
              ...r,
              text: t(returnsLabelKeys.status(r.key)),
            }))}
            t={t}
          />
          <CountCard title={t("returns.stats.byCountry")} rows={labelRows(s.byCountry, (l) => countryName(l, locale), t("returns.stats.noCountry"))} t={t} />
          <CountCard title={t("returns.stats.byProduct")} rows={labelRows(s.byProduct, (l) => l, t("returns.stats.noProduct"))} t={t} />
          <CountCard title={t("returns.stats.byModel")} rows={labelRows(s.byModel, (l) => l, t("returns.stats.noModel"))} t={t} />
          <CountCard title={t("returns.stats.byColor")} rows={labelRows(s.byColor, (l) => l, t("returns.stats.noColor"))} t={t} />
        </Grid>
      )}
    </Stack>
  );
}

type TextRow = { key: string; text: string; cases: number; units: number };

function labelRows(rows: readonly CountRow[], label: (l: string) => string, none: string): TextRow[] {
  return rows.map((r) => ({
    key: r.key,
    cases: r.cases,
    units: r.units,
    text: r.label ? label(r.label) : none,
  }));
}

function CountCard({ title, note, rows, t }: { title: string; note?: string; rows: TextRow[]; t: TFunction }) {
  return (
    <Card title={title} description={note}>
      <DataTable<TextRow>
        caption={title}
        rows={rows}
        rowKey={(r) => r.key}
        emptyState={<Text tone="subdued">{t("returns.stats.noRows")}</Text>}
        columns={[
          {
            key: "label",
            header: t("returns.stats.col.value"),
            primary: true,
            render: (r) => r.text,
          },
          {
            key: "cases",
            header: t("returns.stats.col.cases"),
            align: "end",
            render: (r) => r.cases,
          },
          {
            key: "units",
            header: t("returns.stats.col.units"),
            align: "end",
            render: (r) => r.units,
          },
        ]}
      />
    </Card>
  );
}

function MoneyLine({ sum, t }: { sum: ReturnMoneySum; t: TFunction }) {
  const locale = useLocale();
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

function MoneyCard({ money, t }: { money: NonNullable<Data["amounts"]>; t: TFunction }) {
  return (
    <Card
      title={t("returns.money.periodTitle")}
      description={t("returns.money.periodHelp")}
      actions={<CurrencySwitch current={money.currency} options={money.currencies} />}
    >
      <KeyValueList
        items={[
          {
            key: "refunds",
            label: t(returnsLabelKeys.money("refunds")),
            value: <MoneyLine sum={money.refunds} t={t} />,
          },
          {
            key: "returnCosts",
            label: t(returnsLabelKeys.money("returnCosts")),
            value: <MoneyLine sum={money.returnCosts} t={t} />,
          },
          {
            key: "returnShipping",
            label: t(returnsLabelKeys.money("returnShipping")),
            value: <MoneyLine sum={money.returnShipping} t={t} />,
          },
          {
            key: "returnHandling",
            label: t(returnsLabelKeys.money("returnHandling")),
            value: <MoneyLine sum={money.returnHandling} t={t} />,
          },
          {
            key: "cogsReturn",
            label: t(returnsLabelKeys.money("cogsReturn")),
            value: <MoneyLine sum={money.cogsReturn} t={t} />,
          },
        ]}
      />
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

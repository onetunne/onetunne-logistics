/**
 * Етап 6, WP7: картка партнера (docs/stage6-design.md §9.4–§9.6, §18.6). Маршрут …/finance/partners/:partnerId
 * (app/routes.ts). Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action —
 * finance.manage + роль owner (Origin сторінок перевіряє React Router); кожен сервіс ще раз перевіряє requireFinance.
 *
 * Розділи: баланс (нараховано / коригування / виплачено / баланс / до виплати / утримання; від'ємний — «Партнер винен …
 * — буде утримано з наступної виплати») · «Ефективність партнера» за період і валютою показу (§9.6, окупність; факт —
 * лише остаточні замовлення, прогноз окремо, покриття; конверсія — недоступно) · «Комісії» (замовлення, дата, база, %,
 * сума, стан, утримання до) і «Очікується» · «Виплати» («Створити виплату» з підтвердженням «Виплатити 412,00 грн?»,
 * аванс — окреме підтвердження; анулювання з причиною) · «Фіксовані оплати» (витрати partner_fixed_fee; «Додати» — форма
 * витрат) · «Коди» · «Ставки» (з датою дії) · «Змінити партнера» · «Історія змін». Відсутнє — «—», ніколи не 0.
 */
import { useState } from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { CoverageNote } from "~/components/finance/coverage-note";
import { CurrencySwitch } from "~/components/finance/currency-switch";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { KpiTile } from "~/components/finance/kpi-tile";
import { MarkerBadge } from "~/components/finance/marker-badge";
import { PeriodBar } from "~/components/finance/period-bar";
import { useHref } from "~/components/shell";
import {
  PARTNER_CODE_SOURCES,
  PARTNER_KINDS,
  PARTNER_STATUSES,
  PAYOUT_METHODS,
  QUICK_CURRENCIES,
  type CompletenessMarker,
  type FinanceChangeAction,
  type FinanceChangeEntityType,
} from "~/domain/finance";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { formatDateTime, formatIsoDate, formatMoney, formatPercent } from "~/lib/format";
import { DomainError } from "~/lib/errors";
import { parseOwnerAmount } from "~/lib/decimal";
import { businessDate, parseIsoDate } from "~/lib/periods";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getFinanceSettings } from "~/modules/finance/core/settings.server";
import { absDecimal, formatRateBp, moneyList } from "~/modules/partners/display";
import { parsePercentBp } from "~/modules/partners/input";
import { addPartnerCode, addPartnerRate, deactivatePartnerCode, getPartnerDetail, updatePartner, type CommissionRowView } from "~/modules/partners/partners.server";
import { createPayout, voidPayout } from "~/modules/partners/payouts.server";
import { getPartnerPerformance } from "~/modules/partners/performance.server";
import { partnerPeriodOf } from "~/modules/partners/period";
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
  FormLayout,
  Grid,
  KeyValueList,
  Page,
  Select,
  Stack,
  Text,
  TextField,
} from "~/ui";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const detail = await getPartnerDetail(ctx, params.partnerId ?? "");
  if (!detail) throw new Response("Not Found", { status: 404 });
  const sp = new URL(request.url).searchParams;
  const today = businessDate(ctx.now());
  const period = partnerPeriodOf(sp, today);
  const { value: settings } = await getFinanceSettings(ctx);
  const currencies = settings.displayCurrencies.includes(settings.reportingCurrency) ? settings.displayCurrencies : [settings.reportingCurrency, ...settings.displayCurrencies];
  const requested = (sp.get("currency") ?? "").toUpperCase();
  const currency = currencies.includes(requested) ? requested : settings.reportingCurrency;
  const performance = await getPartnerPerformance(ctx, { partnerId: detail.partner.id, range: period.range, currency });
  // Валюта комісії (баланс і покриття виплат) — з сервісу (валюта подій / магазину), не валюта виплати чи звітності.
  const commissionCurrency = detail.commissionCurrency;
  const payoutCurrencyDefault = detail.partner.payoutCurrency ?? commissionCurrency ?? settings.reportingCurrency;
  return {
    demo: ctx.mode === "demo",
    today,
    period,
    currency,
    currencies,
    detail,
    performance,
    commissionCurrency,
    payoutCurrencyDefault,
    operationId: globalThis.crypto.randomUUID(),
  };
}

type PartnerActionResult = ActionResult & { intent?: string; nextOperationId?: string; advanceRequired?: boolean };

function localizedError(e: unknown, locale: Locale): ActionResult & { advanceRequired?: boolean } {
  const r = toActionError(e);
  if (r.error === "error.notFound") return { ok: false, error: "partners.error.notFound" };
  if (e instanceof DomainError && e.code === "partners.error.payoutExceedsPayable") {
    const currency = String(e.params.currency ?? "");
    return {
      ok: false,
      error: r.error,
      params: { payable: formatMoney(String(e.params.payable ?? ""), currency, locale), covers: formatMoney(String(e.params.covers ?? ""), currency, locale) },
      advanceRequired: true,
    };
  }
  if (!r.params) return r;
  const params: Record<string, string | number> = { ...r.params };
  if (typeof params.date === "string" && parseIsoDate(params.date)) params.date = formatIsoDate(params.date, locale);
  if (typeof params.month === "string" && parseIsoDate(params.month)) {
    const [y, m] = params.month.split("-");
    params.month = locale === "uk" ? `${m}.${y}` : `${m}/${y}`;
  }
  return { ...r, params };
}

export async function action({ request, params }: ActionFunctionArgs): Promise<PartnerActionResult> {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  const partnerId = params.partnerId ?? "";
  const nextOperationId = globalThis.crypto.randomUUID();
  const locale = ctx.locale;
  let intent = "";
  try {
    const form = await request.formData();
    intent = formString(form, "intent");
    if (intent === "updatePartner") {
      const version = Number(formString(form, "expectedVersion"));
      await updatePartner(ctx, {
        id: partnerId,
        expectedVersion: Number.isSafeInteger(version) ? version : -1,
        displayName: formString(form, "displayName"),
        kind: formString(form, "kind"),
        status: formString(form, "status"),
        holdDays: formString(form, "holdDays"),
        payoutCurrency: formString(form, "payoutCurrency") || null,
        note: formString(form, "note") || null,
        reason: formString(form, "reason") || null,
      });
      return { ok: true, message: "partners.result.updated", intent, nextOperationId };
    }
    if (intent === "addCode") {
      const r = await addPartnerCode(ctx, {
        partnerId,
        source: formString(form, "source"),
        code: formString(form, "code"),
        validFrom: formString(form, "validFrom") || null,
        validTo: formString(form, "validTo") || null,
      });
      const extra = [...(r.attributed > 0 ? ["partners.result.attributed"] : []), ...(r.reused ? ["partners.result.codeReused"] : [])];
      return {
        ok: true,
        message: "partners.result.codeAdded",
        params: { n: r.attributed, date: r.validFrom ? formatIsoDate(r.validFrom, locale) : "—" },
        ...(extra.length ? { extra } : {}),
        intent,
        nextOperationId,
      };
    }
    if (intent === "deactivateCode") {
      await deactivatePartnerCode(ctx, { codeId: formString(form, "codeId"), reason: formString(form, "reason") || null });
      return { ok: true, message: "partners.result.codeDeactivated", intent, nextOperationId };
    }
    if (intent === "addRate") {
      const rateBp = parsePercentBp(formString(form, "rate"));
      if (rateBp === null) return { ok: false, error: "partners.error.rateInvalid", intent, nextOperationId };
      await addPartnerRate(ctx, {
        partnerId,
        codeId: formString(form, "codeId") || null,
        rateBp,
        effectiveFrom: formString(form, "effectiveFrom"),
        reason: formString(form, "reason") || null,
      });
      return { ok: true, message: "partners.result.rateAdded", intent, nextOperationId };
    }
    if (intent === "createPayout") {
      const r = await createPayout(ctx, {
        operationId: formString(form, "operationId"),
        partnerId,
        paidOn: formString(form, "paidOn"),
        amount: formString(form, "amount"),
        currency: formString(form, "currency"),
        coversAmount: formString(form, "coversAmount") || null,
        coversCurrency: formString(form, "coversCurrency") || null,
        method: formString(form, "method"),
        reference: formString(form, "reference") || null,
        note: formString(form, "note") || null,
        confirmAdvance: form.has("confirmAdvance"),
      });
      if (r.duplicate) return { ok: true, tone: "info", message: "partners.result.payoutDuplicate", intent, nextOperationId };
      return {
        ok: true,
        message: r.advance ? "partners.result.payoutAdvance" : "partners.result.payoutCreated",
        params: { amount: formatMoney(r.amount.amount, r.amount.currency, locale), covers: formatMoney(r.covers.amount, r.covers.currency, locale) },
        intent,
        nextOperationId,
      };
    }
    if (intent === "voidPayout") {
      await voidPayout(ctx, { id: formString(form, "id"), reason: formString(form, "reason") });
      return { ok: true, message: "partners.result.payoutVoided", intent, nextOperationId };
    }
    return { ok: false, error: "error.generic", intent, nextOperationId };
  } catch (e) {
    return { ...localizedError(e, locale), intent, nextOperationId };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

interface SectionProps {
  data: Data;
  t: TFunction;
  locale: Locale;
}

/** «3.40» → «3,40» / «3.40». */
function formatRatio(value: string | null, locale: Locale): string {
  if (!value) return "—";
  return locale === "uk" ? value.replace(".", ",") : value;
}

/** Одиниця валюти для фраз («грн» для UAH українською, інакше код). */
function unitOf(currency: string, locale: Locale): string {
  return currency === "UAH" && locale === "uk" ? "грн" : currency;
}

export default function FinancePartnerPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const p = data.detail.partner;
  const operationId = actionData?.ok && actionData.nextOperationId ? actionData.nextOperationId : data.operationId;
  return (
    <Page
      title={p.displayName}
      subtitle={`${t(`partners.kind.${p.kind}`)} · ${formatRateBp(data.detail.currentRateBp, locale)} · ${t("partners.detail.holdDays", { days: p.holdDays })}`}
      backHref={href("/finance/partners")}
      backLabel={t(financeLabelKeys.tab("partners"))}
      titleMeta={
        p.status !== "active" ? (
          <Badge tone="outline">{t(`partners.status.${p.status}`)}</Badge>
        ) : undefined
      }
    >
      <Stack gap={4}>
        <FinanceTabs current="partners" />
        {data.demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <ActionBanner data={actionData} />
        <BalanceCard data={data} t={t} locale={locale} />
        <PerformanceCard data={data} t={t} locale={locale} />
        <CommissionsCard data={data} t={t} locale={locale} />
        <PayoutsCard data={data} t={t} locale={locale} operationId={operationId} advanceRequired={Boolean(actionData && !actionData.ok && actionData.advanceRequired)} />
        <FixedFeesCard data={data} t={t} locale={locale} />
        <CodesCard data={data} t={t} locale={locale} />
        <RatesCard data={data} t={t} locale={locale} />
        <EditCard data={data} t={t} />
        <HistoryCard data={data} t={t} locale={locale} />
      </Stack>
    </Page>
  );
}

function BalanceCard({ data, t, locale }: SectionProps) {
  const ledger = data.detail.ledger;
  const expected = data.detail.expected;
  return (
    <Card title={t("partners.balance.title")} description={t("partners.balance.description")}>
      {ledger.length === 0 && expected.length === 0 ? (
        <EmptyState title={t("partners.noData")} description={t("partners.balance.empty")} />
      ) : (
        <Stack gap={3}>
          {ledger.map((l) => (
            <Stack gap={2} key={l.currency}>
              {l.owes !== "0.00" ? (
                <Banner tone="warning">{t("partners.balance.owes", { amount: formatMoney(l.owes, l.currency, locale) })}</Banner>
              ) : null}
              <Grid columns={{ xs: 2, md: 3, lg: 6 }} gap={3}>
                <Metric label={t("partners.balance.accrued")} value={formatMoney(l.accrued, l.currency, locale)} />
                <Metric label={t("partners.balance.adjustments")} value={formatMoney(l.adjustments, l.currency, locale)} />
                <Metric label={t("partners.balance.paid")} value={formatMoney(l.paid, l.currency, locale)} />
                <Metric label={t("partners.balance.balance")} value={formatMoney(l.balance, l.currency, locale)} tone={l.owes !== "0.00" ? "critical" : "default"} strong />
                <Metric label={t(financeLabelKeys.partnerState("payable"))} value={formatMoney(l.payable, l.currency, locale)} strong />
                <Metric label={t("partners.balance.inHold")} value={formatMoney(l.inHold, l.currency, locale)} />
              </Grid>
            </Stack>
          ))}
          <Text variant="body-sm" tone="subdued">
            {t(financeLabelKeys.partnerState("expected"))}: {moneyList(data.detail.expectedTotals, locale)} ·{" "}
            {t("partners.balance.expectedHelp")}
          </Text>
        </Stack>
      )}
    </Card>
  );
}

function Metric({ label, value, tone = "default", strong }: { label: string; value: string; tone?: "default" | "critical"; strong?: boolean }) {
  return (
    <Stack gap={1}>
      <Text as="span" variant="caption" tone="subdued">
        {label}
      </Text>
      <Text as="span" numeric weight={strong ? "semibold" : undefined} tone={tone}>
        {value}
      </Text>
    </Stack>
  );
}

function markerOf(s: { final: number; preliminary: number; incomplete: number }, unconverted: boolean): CompletenessMarker {
  if (s.incomplete > 0 || unconverted) return "incomplete";
  if (s.preliminary > 0) return "with_forecast";
  return "complete";
}

function PerformanceCard({ data, t, locale }: SectionProps) {
  const perf = data.performance;
  const s = perf?.summary;
  const c = data.currency;
  const money = (v: string | null) => (v === null ? null : { amount: v, currency: c });
  const unconverted = (perf?.unconverted.length ?? 0) > 0;
  // Замовлення із записами без курсу вже враховано як «неповні» (s.incomplete) — маркер прибутку за станами замовлень.
  const marker = s ? markerOf(s, false) : "incomplete";
  const partMarker = (complete: boolean): CompletenessMarker => (complete ? "complete" : "incomplete");
  const paybackMarker: CompletenessMarker = s ? (s.complete.fixedFees ? markerOf(s, false) : "incomplete") : "incomplete";
  const coverage = s ? { n: s.final, m: s.orders } : null;
  return (
    <Card title={t("partners.performance.title")} description={t("partners.performance.description")}>
      <Stack gap={4}>
        <Grid columns={{ xs: 1, md: 2 }} gap={3}>
          <PeriodBar preset={data.period.preset} range={data.period.range} granularity="month" compare="none" allowCustom />
          <Stack gap={1}>
            <Text as="span" variant="caption" tone="subdued">
              {t("partners.performance.currency")}
            </Text>
            <CurrencySwitch current={c} options={data.currencies} />
          </Stack>
        </Grid>
        <Text variant="body-sm" tone="subdued">
          {t("partners.list.period", { from: formatIsoDate(data.period.range.from, locale), to: formatIsoDate(data.period.range.to, locale) })}
        </Text>
        {!s || s.orders === 0 ? (
          <EmptyState title={t("partners.noData")} description={t("partners.performance.empty")} />
        ) : (
          <Stack gap={3}>
            <Grid columns={{ xs: 1, md: 2, lg: 4 }} gap={3}>
              <Card title={t("partners.performance.orders")}>
                <Stack gap={1}>
                  <Text variant="heading-md" numeric>
                    {String(s.orders)}
                  </Text>
                  <Text as="span" variant="caption" tone="subdued">
                    {t("partners.performance.states", { final: s.final, preliminary: s.preliminary, incomplete: s.incomplete })}
                  </Text>
                </Stack>
              </Card>
              <KpiTile id="partner-net-products" title={t("partners.performance.netProducts")} value={money(s.netProducts)} marker={partMarker(s.complete.revenue)} coverage={{ n: s.withRevenue, m: s.orders }} />
              <KpiTile id="partner-turnover" title={t(financeLabelKeys.term("turnover"))} value={money(s.turnover)} marker={partMarker(s.complete.revenue)} coverage={{ n: s.withRevenue, m: s.orders }} />
              <KpiTile
                id="partner-aov"
                title={t(financeLabelKeys.term("averageOrderValue"))}
                value={money(s.averageCheck)}
                marker={partMarker(s.complete.revenue)}
                coverage={{ n: s.withRevenue, m: s.orders }}
              />
              <Card title={t("partners.performance.returns")}>
                <Stack gap={1}>
                  <Text variant="heading-md" numeric>
                    {formatPercent(s.returnShare, locale)}
                  </Text>
                  <CoverageNote n={s.returnOrders} m={s.withRevenue} />
                </Stack>
              </Card>
              <KpiTile
                id="partner-chargeback"
                title={t("partners.performance.chargeback")}
                value={money(s.chargebackLoss)}
                marker={partMarker(s.complete.chargeback)}
                note={t("partners.performance.chargebackOrders", { n: s.chargebackOrders })}
              />
              <KpiTile id="partner-commission" title={t("partners.performance.commission")} value={money(s.commission)} marker={partMarker(s.complete.commission)} />
              <KpiTile id="partner-fixed" title={t("partners.performance.fixedFees")} value={money(s.fixedFees)} marker={partMarker(s.complete.fixedFees)} />
            </Grid>
            <Grid columns={{ xs: 1, md: 3 }} gap={3}>
              <KpiTile
                id="partner-profit-before"
                title={t("partners.performance.profitBefore")}
                value={money(s.fact.profitBefore)}
                forecast={money(s.forecast.profitBefore)}
                marker={marker}
                coverage={coverage}
              />
              <KpiTile
                id="partner-profit-after"
                title={t("partners.performance.profitAfter")}
                value={money(s.fact.profitAfter)}
                forecast={money(s.forecast.profitAfter)}
                marker={marker}
                coverage={coverage}
              />
              <Card title={t("partners.performance.payback")}>
                <Stack gap={1}>
                  <span>
                    <MarkerBadge marker={paybackMarker} />
                  </span>
                  <Text variant="heading-md" numeric>
                    {formatRatio(s.fact.payback, locale)}
                  </Text>
                  {s.forecast.payback !== null ? (
                    <Text as="span" variant="body-sm" tone="subdued">
                      ≈ {formatRatio(s.forecast.payback, locale)} {t(financeLabelKeys.state("forecast"))}
                    </Text>
                  ) : null}
                  <Text as="span" variant="caption" tone="subdued">
                    {s.fact.payback !== null
                      ? t("partners.performance.paybackExplain", { unit: unitOf(c, locale), value: formatRatio(s.fact.payback, locale) })
                      : s.paybackMissing === "fixed_fees_unconverted"
                        ? t("partners.performance.paybackNoRate", { currency: c })
                        : t("partners.performance.paybackMissing")}
                  </Text>
                  <CoverageNote n={s.final} m={s.orders} />
                </Stack>
              </Card>
            </Grid>
            {unconverted ? (
              <Banner tone="warning">
                {t(financeLabelKeys.rate("unconverted"), { amount: perf!.unconverted.map((u) => formatMoney(u.amount, u.currency, locale)).join(", "), n: perf!.unconverted.reduce((a, u) => a + u.entries, 0) })}
              </Banner>
            ) : null}
            <DataTable
              caption={t("partners.performance.months")}
              rows={s.months}
              rowKey={(m) => m.month}
              columns={[
                { key: "month", header: t("partners.performance.month"), primary: true, render: (m) => formatIsoDate(m.month, locale).slice(3) },
                { key: "orders", header: t("partners.performance.orders"), align: "end", render: (m) => String(m.orders) },
                { key: "net", header: t("partners.performance.netProducts"), align: "end", render: (m) => formatMoney(m.netProducts, c, locale) },
                { key: "commission", header: t("partners.performance.commission"), align: "end", render: (m) => formatMoney(m.commission, c, locale) },
                {
                  key: "profit",
                  header: t("partners.performance.profitAfter"),
                  align: "end",
                  render: (m) => (m.profit === null ? "—" : `${formatMoney(m.profit, c, locale)} (${t(financeLabelKeys.coverage("orders"), { n: m.finalOrders, m: m.orders })})`),
                },
              ]}
            />
          </Stack>
        )}
        <Text variant="body-sm" tone="subdued">
          {t("partners.performance.unavailable")}
        </Text>
      </Stack>
    </Card>
  );
}

function stateTone(state: CommissionRowView["state"]): "strong" | "outline" | "warning" | "neutral" {
  return state === "payable" ? "strong" : state === "paid" ? "neutral" : state === "cancelled" ? "outline" : "warning";
}

function CommissionsCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const rows = data.detail.commissions;
  return (
    <Card title={t("partners.commissions.title")} description={t("partners.commissions.description")} padded={false}>
      <Stack gap={3}>
        <DataTable<CommissionRowView>
          caption={t("partners.commissions.title")}
          rows={rows}
          rowKey={(r) => `${r.orderId}|${r.currency}`}
          rowHref={(r) => href(`/orders/${r.orderId}`)}
          emptyState={<EmptyState title={t("partners.noData")} description={t("partners.commissions.empty")} />}
          columns={[
            { key: "order", header: t("partners.commissions.order"), primary: true, render: (r) => r.orderNumber },
            { key: "date", header: t("partners.commissions.date"), render: (r) => formatIsoDate(r.firstOn, locale) },
            { key: "base", header: t("partners.commissions.base"), align: "end", render: (r) => formatMoney(r.base, r.currency, locale) },
            { key: "rate", header: t("partners.commissions.rate"), align: "end", render: (r) => formatRateBp(r.rateBp, locale) },
            {
              key: "amount",
              header: t("partners.commissions.amount"),
              align: "end",
              render: (r) => (
                <Stack gap={1}>
                  <Text as="span" numeric weight="semibold">
                    {formatMoney(r.net, r.currency, locale)}
                  </Text>
                  {r.adjustments !== "0.00" ? (
                    <Text as="span" variant="caption" tone="subdued">
                      {t("partners.commissions.breakdown", { accrued: formatMoney(r.accrued, r.currency, locale), adjustments: formatMoney(r.adjustments, r.currency, locale) })}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "state",
              header: t("partners.commissions.state"),
              render: (r) => (
                <Badge size="sm" tone={stateTone(r.state)}>
                  {t(financeLabelKeys.partnerState(r.state))}
                </Badge>
              ),
            },
            { key: "hold", header: t("partners.commissions.holdUntil"), render: (r) => formatIsoDate(r.holdUntil, locale) },
            { key: "paid", header: t("partners.commissions.paid"), align: "end", render: (r) => formatMoney(r.paid, r.currency, locale) },
          ]}
        />
        {data.detail.expected.length > 0 ? (
          <div className="ot-card__body">
            <Stack gap={2}>
              <Text weight="semibold">{t(financeLabelKeys.partnerState("expected"))}</Text>
              <DataTable
                caption={t(financeLabelKeys.partnerState("expected"))}
                rows={data.detail.expected}
                rowKey={(r) => r.orderId}
                rowHref={(r) => href(`/orders/${r.orderId}`)}
                columns={[
                  { key: "order", header: t("partners.commissions.order"), primary: true, render: (r) => r.orderNumber },
                  { key: "placed", header: t("partners.commissions.placed"), render: (r) => formatIsoDate(r.placedOn, locale) },
                  { key: "amount", header: t("partners.commissions.expectedAmount"), align: "end", render: (r) => `≈ ${formatMoney(r.amount.amount, r.amount.currency, locale)}` },
                ]}
              />
            </Stack>
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function PayoutsCard({ data, t, locale, operationId, advanceRequired }: SectionProps & { operationId: string; advanceRequired: boolean }) {
  const nav = useNavigation();
  const busy = nav.state === "submitting" && nav.formData?.get("intent") === "createPayout";
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(data.payoutCurrencyDefault);
  const commissionCurrency = data.commissionCurrency;
  const payable = commissionCurrency ? data.detail.ledger.find((l) => l.currency === commissionCurrency) : undefined;
  const parsedAmount = parseOwnerAmount(amount);
  const confirmAmount = parsedAmount.ok ? formatMoney(parsedAmount.value, currency, locale) : "—";
  const currencyOptions = [...new Set([data.payoutCurrencyDefault, ...(commissionCurrency ? [commissionCurrency] : []), ...QUICK_CURRENCIES])].map((c) => ({ value: c, label: c }));
  return (
    <Card title={t("partners.payouts.title")} description={t("partners.payouts.description")} id="payouts">
      <Stack gap={4}>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="createPayout" />
          <input type="hidden" name="operationId" value={operationId} />
          <Stack gap={3}>
            <Text weight="semibold">{t("partners.payouts.create")}</Text>
            <Text variant="body-sm" tone="subdued">
              {t("partners.payouts.payable", { amount: payable ? formatMoney(payable.payable, payable.currency, locale) : "—" })}
            </Text>
            {commissionCurrency ? (
              <Text variant="body-sm" tone="subdued">
                {t("partners.payouts.commissionCurrency", { currency: commissionCurrency })}
              </Text>
            ) : (
              <Banner tone="warning">{t("partners.payouts.commissionCurrencyUnknown")}</Banner>
            )}
            <FormLayout columns={2}>
              <TextField label={t("partners.payouts.amount")} name="amount" required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoComplete="off" />
              <Select label={t("partners.payouts.currency")} name="currency" value={currency} onChange={(e) => setCurrency(e.target.value)} options={currencyOptions} />
              <TextField label={t("partners.payouts.paidOn")} name="paidOn" type="date" required defaultValue={data.today} max={data.today} />
              <Select label={t("partners.payouts.method")} name="method" defaultValue="bank" options={PAYOUT_METHODS.map((m) => ({ value: m, label: t(`partners.method.${m}`) }))} />
              <TextField label={t("partners.payouts.reference")} name="reference" maxLength={100} autoComplete="off" helpText={t("partners.payouts.referenceHelp")} />
              <TextField label={t("partners.field.note")} name="note" maxLength={300} />
            </FormLayout>
            {commissionCurrency && currency !== commissionCurrency ? (
              <FormLayout columns={2}>
                <TextField
                  label={t("partners.payouts.covers", { currency: commissionCurrency })}
                  name="coversAmount"
                  inputMode="decimal"
                  helpText={t("partners.payouts.coversHelp")}
                />
              </FormLayout>
            ) : null}
            {commissionCurrency ? <input type="hidden" name="coversCurrency" value={commissionCurrency} /> : null}
            <Checkbox
              label={t("partners.payouts.confirmAdvance")}
              name="confirmAdvance"
              defaultChecked={advanceRequired}
              helpText={t("partners.payouts.confirmAdvanceHelp")}
            />
            <div>
              <ConfirmSubmitButton
                variant="primary"
                title={t("partners.payouts.confirmTitle")}
                message={t("partners.payouts.confirm", { amount: confirmAmount, name: data.detail.partner.displayName })}
                confirmLabel={t("partners.payouts.confirmLabel")}
                cancelLabel={t("common.cancel")}
                loading={busy}
              >
                {t("partners.payouts.submit")}
              </ConfirmSubmitButton>
            </div>
          </Stack>
        </Form>
        <DataTable
          caption={t("partners.payouts.history")}
          rows={data.detail.payouts}
          rowKey={(x) => x.id}
          emptyState={<EmptyState title={t("partners.noData")} description={t("partners.payouts.empty")} />}
          columns={[
            { key: "date", header: t("partners.payouts.paidOn"), primary: true, render: (x) => formatIsoDate(x.paidOn, locale) },
            { key: "amount", header: t("partners.payouts.amount"), align: "end", render: (x) => formatMoney(x.amount.amount, x.amount.currency, locale) },
            {
              key: "covers",
              header: t("partners.payouts.coversShort"),
              align: "end",
              render: (x) => (x.covers.currency === x.amount.currency ? "—" : formatMoney(x.covers.amount, x.covers.currency, locale)),
            },
            { key: "method", header: t("partners.payouts.method"), render: (x) => t(`partners.method.${x.method}`) },
            { key: "reference", header: t("partners.payouts.reference"), render: (x) => x.reference ?? "—" },
            {
              key: "status",
              header: t("partners.payouts.status"),
              render: (x) =>
                x.status === "voided" ? (
                  <Stack gap={1}>
                    <span>
                      <Badge size="sm" tone="outline">
                        {t("partners.payouts.voided")}
                      </Badge>
                    </span>
                    {x.voidReason ? (
                      <Text as="span" variant="caption" tone="subdued">
                        {x.voidReason}
                      </Text>
                    ) : null}
                  </Stack>
                ) : (
                  <Form method="post" preventScrollReset>
                    <input type="hidden" name="intent" value="voidPayout" />
                    <input type="hidden" name="id" value={x.id} />
                    <Stack gap={2}>
                      <TextField label={t("partners.field.reason")} labelHidden placeholder={t("partners.field.reason")} name="reason" required maxLength={300} />
                      <ConfirmSubmitButton
                        size="sm"
                        variant="critical"
                        title={t("partners.payouts.voidTitle")}
                        message={t("partners.payouts.voidConfirm", { amount: formatMoney(x.amount.amount, x.amount.currency, locale) })}
                        confirmLabel={t("partners.payouts.void")}
                        cancelLabel={t("common.cancel")}
                      >
                        {t("partners.payouts.void")}
                      </ConfirmSubmitButton>
                    </Stack>
                  </Form>
                ),
            },
          ]}
        />
        <Text variant="body-sm" tone="subdued">
          {t("partners.payouts.fxNote")}
        </Text>
      </Stack>
    </Card>
  );
}

function FixedFeesCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const addHref = href(`/finance/expenses?add=expense&category=partner_fixed_fee&partnerId=${encodeURIComponent(data.detail.partner.id)}#expense-form`);
  return (
    <Card
      title={t("partners.fixed.title")}
      description={t("partners.fixed.description")}
      actions={
        <Link className="ot-link" to={addHref}>
          {t("partners.fixed.add")}
        </Link>
      }
    >
      <DataTable
        caption={t("partners.fixed.title")}
        rows={data.detail.fixedFees}
        rowKey={(f) => f.id}
        emptyState={<EmptyState title={t("partners.noData")} description={t("partners.fixed.empty")} />}
        columns={[
          {
            key: "date",
            header: t("partners.fixed.date"),
            primary: true,
            render: (f) => (f.periodFrom && f.periodTo ? `${formatIsoDate(f.periodFrom, locale)} – ${formatIsoDate(f.periodTo, locale)}` : formatIsoDate(f.date, locale)),
          },
          { key: "amount", header: t("partners.fixed.amount"), align: "end", render: (f) => formatMoney(absDecimal(f.amount.amount), f.amount.currency, locale) },
          { key: "status", header: t("partners.fixed.status"), render: (f) => (f.status === "voided" ? t("partners.payouts.voided") : t("partners.fixed.active")) },
          { key: "description", header: t("partners.fixed.descriptionColumn"), render: (f) => f.description ?? "—" },
        ]}
      />
    </Card>
  );
}

function CodesCard({ data, t, locale }: SectionProps) {
  const codes = data.detail.codes;
  return (
    <Card title={t("partners.codes.title")} description={t("partners.codes.description")}>
      <Stack gap={4}>
        <DataTable
          caption={t("partners.codes.title")}
          rows={codes}
          rowKey={(c) => c.id}
          emptyState={<EmptyState title={t("partners.codes.empty")} />}
          columns={[
            { key: "code", header: t("partners.field.code"), primary: true, render: (c) => c.code },
            { key: "source", header: t("partners.field.codeSource"), render: (c) => t(`partners.source.${c.source}`) },
            {
              key: "validity",
              header: t("partners.codes.validity"),
              render: (c) =>
                c.validFrom || c.validTo ? `${c.validFrom ? formatIsoDate(c.validFrom, locale) : "…"} – ${c.validTo ? formatIsoDate(c.validTo, locale) : "…"}` : t("partners.codes.always"),
            },
            {
              key: "active",
              header: t("partners.codes.state"),
              render: (c) =>
                c.active ? (
                  <Form method="post" preventScrollReset>
                    <input type="hidden" name="intent" value="deactivateCode" />
                    <input type="hidden" name="codeId" value={c.id} />
                    <ConfirmSubmitButton
                      size="sm"
                      title={t("partners.codes.deactivateTitle")}
                      message={t("partners.codes.deactivateConfirm", { code: c.code })}
                      confirmLabel={t("partners.codes.deactivate")}
                      cancelLabel={t("common.cancel")}
                    >
                      {t("partners.codes.deactivate")}
                    </ConfirmSubmitButton>
                  </Form>
                ) : (
                  <Badge size="sm" tone="outline">
                    {t("partners.codes.inactive")}
                  </Badge>
                ),
            },
          ]}
        />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="addCode" />
          <Stack gap={3}>
            <Text weight="semibold">{t("partners.codes.add")}</Text>
            <FormLayout columns={2}>
              <Select label={t("partners.field.codeSource")} name="source" defaultValue="discount_code" options={PARTNER_CODE_SOURCES.map((s) => ({ value: s, label: t(`partners.source.${s}`) }))} />
              <TextField label={t("partners.field.code")} name="code" required maxLength={64} autoComplete="off" spellCheck={false} autoCapitalize="characters" />
              <TextField label={t("partners.codes.validFrom")} name="validFrom" type="date" />
              <TextField label={t("partners.codes.validTo")} name="validTo" type="date" />
            </FormLayout>
            <Text variant="body-sm" tone="subdued">
              {t("partners.codes.addHelp")}
            </Text>
            <div>
              <Button type="submit">{t("partners.codes.addSubmit")}</Button>
            </div>
          </Stack>
        </Form>
      </Stack>
    </Card>
  );
}

function RatesCard({ data, t, locale }: SectionProps) {
  const activeCodes = data.detail.codes.filter((c) => c.active);
  return (
    <Card title={t("partners.rates.title")} description={t("partners.rates.description")}>
      <Stack gap={4}>
        <DataTable
          caption={t("partners.rates.title")}
          rows={data.detail.rates}
          rowKey={(r) => r.id}
          emptyState={<EmptyState title={t("partners.noData")} />}
          columns={[
            { key: "from", header: t("partners.rates.effectiveFrom"), primary: true, render: (r) => formatIsoDate(r.effectiveFrom, locale) },
            { key: "code", header: t("partners.rates.scope"), render: (r) => r.code ?? t("partners.rates.allCodes") },
            { key: "rate", header: t("partners.list.rate"), align: "end", render: (r) => formatRateBp(r.rateBp, locale) },
            { key: "reason", header: t("partners.field.reason"), render: (r) => r.reason ?? "—" },
          ]}
        />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="addRate" />
          <Stack gap={3}>
            <Text weight="semibold">{t("partners.rates.add")}</Text>
            <FormLayout columns={2}>
              <TextField label={t("partners.field.rate")} name="rate" required inputMode="decimal" suffix="%" />
              <TextField label={t("partners.rates.effectiveFrom")} name="effectiveFrom" type="date" required defaultValue={data.today} />
              <Select
                label={t("partners.rates.scope")}
                name="codeId"
                defaultValue=""
                options={[{ value: "", label: t("partners.rates.allCodes") }, ...activeCodes.map((c) => ({ value: c.id, label: c.code }))]}
              />
              <TextField label={t("partners.field.reason")} name="reason" maxLength={300} />
            </FormLayout>
            <Text variant="body-sm" tone="subdued">
              {t("partners.rates.newOrdersOnly")}
            </Text>
            <div>
              <Button type="submit">{t("partners.rates.submit")}</Button>
            </div>
          </Stack>
        </Form>
      </Stack>
    </Card>
  );
}

function EditCard({ data, t }: { data: Data; t: TFunction }) {
  const p = data.detail.partner;
  return (
    <Card>
      <Disclosure summary={t("partners.edit.title")}>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="updatePartner" />
          <input type="hidden" name="expectedVersion" value={p.version} />
          <Stack gap={3}>
            <FormLayout columns={2}>
              <TextField label={t("partners.field.name")} name="displayName" required maxLength={120} defaultValue={p.displayName} autoComplete="off" />
              <Select label={t("partners.field.kind")} name="kind" defaultValue={p.kind} options={PARTNER_KINDS.map((k) => ({ value: k, label: t(`partners.kind.${k}`) }))} />
              <Select label={t("partners.field.status")} name="status" defaultValue={p.status} options={PARTNER_STATUSES.map((s) => ({ value: s, label: t(`partners.status.${s}`) }))} />
              <TextField label={t("partners.field.holdDays")} name="holdDays" required type="number" min={0} max={365} defaultValue={p.holdDays} helpText={t("partners.edit.holdHelp")} />
              <Select
                label={t("partners.field.payoutCurrency")}
                name="payoutCurrency"
                defaultValue={p.payoutCurrency ?? ""}
                options={[{ value: "", label: t("partners.field.payoutCurrencyAuto") }, ...[...new Set([...(p.payoutCurrency ? [p.payoutCurrency] : []), ...QUICK_CURRENCIES])].map((c) => ({ value: c, label: c }))]}
              />
              <TextField label={t("partners.field.note")} name="note" maxLength={300} defaultValue={p.note ?? ""} />
              <TextField label={t("partners.field.reason")} name="reason" maxLength={300} />
            </FormLayout>
            <div>
              <Button type="submit">{t("partners.edit.submit")}</Button>
            </div>
          </Stack>
        </Form>
      </Disclosure>
    </Card>
  );
}

function HistoryCard({ data, t, locale }: SectionProps) {
  const rows = data.detail.history;
  return (
    <Card>
      <Disclosure summary={t("partners.history.title")}>
        {rows.length === 0 ? (
          <Text tone="subdued">{t("partners.history.empty")}</Text>
        ) : (
          <KeyValueList
            items={rows.map((r) => ({
              key: String(r.id),
              label: formatDateTime(r.createdAt, locale),
              value: `${t(financeLabelKeys.changeEntity(r.entityType as FinanceChangeEntityType))} · ${t(financeLabelKeys.changeAction(r.action as FinanceChangeAction))}${r.reason ? ` · ${r.reason}` : ""}`,
            }))}
          />
        )}
      </Disclosure>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

/**
 * Етап 6, WP6: «Фінанси → Місяці» (docs/stage6-design.md §3.4, §2.7, §13.1, §18.2). Маршрут …/finance/periods.
 * Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router). Кожен сервіс ще раз перевіряє requireFinance.
 *
 * Розділи: перелік місяців (стан, «Чистий прибуток», записи, замовлення, остаточні знімки) · обраний місяць: чек-лист
 * ■ (блокує) / ▲ (попереджає) / ☐ (підтвердження власника, зокрема податки «внесено / немає» і «Упаковку … обліковано
 * загальною сумою» за потреби) · «Закрити місяць» (ConfirmSubmitButton; лише повністю минулий місяць без ■) ·
 * «Відкрити повторно» (з причиною) · знімки закритого місяця за валютами («Живий перерахунок, не знімок» для валют без
 * знімка) · історія змін. Порожня база — місяці без записів («Немає даних»), закриття доступне з порожнім чек-листом.
 */
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { useHref } from "~/components/shell";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { formatDateTime, formatIsoDate } from "~/lib/format";
import { addMonths, businessDate, monthStart, parseIsoDate } from "~/lib/periods";
import { monthLabel } from "~/modules/expenses/display";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { allowedConfirmValues, CONFIRM_ITEMS, type ChecklistItemResult } from "~/modules/finance/periods/checklist";
import { closeMonth, confirmMonthItems, getMonthOverview, listFinanceMonths, reopenMonth } from "~/modules/finance/periods/periods.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import { Badge, Banner, Button, Card, ConfirmSubmitButton, DataTable, Disclosure, EmptyState, FormLayout, Page, Select, Stack, Text, TextField } from "~/ui";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const sp = new URL(request.url).searchParams;
  const today = businessDate(ctx.now());
  const raw = (sp.get("month") ?? "").trim();
  const iso = parseIsoDate(/^\d{4}-\d{2}$/.test(raw) ? `${raw}-01` : raw);
  const month = iso ? monthStart(iso) : addMonths(monthStart(today), -1);
  const [months, overview] = await Promise.all([listFinanceMonths(ctx, { count: 12 }), getMonthOverview(ctx, month)]);
  return { demo: ctx.mode === "demo", today, month, months, overview };
}

type PeriodsActionResult = ActionResult & { intent?: string };

function localizedError(e: unknown, locale: Locale): ActionResult {
  const r = toActionError(e);
  if (!r.params) return r;
  const params: Record<string, string | number> = { ...r.params };
  // Місяць (finance.error.monthClosed) форматує централізовано localizeParams (ActionBanner).
  return { ...r, params };
}

export async function action({ request }: ActionFunctionArgs): Promise<PeriodsActionResult> {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  const locale = ctx.locale;
  let intent = "";
  try {
    const form = await request.formData();
    intent = formString(form, "intent");
    const month = formString(form, "month");
    const raw = formString(form, "expectedVersion");
    const expectedVersion = /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
    if (intent === "confirm") {
      const values: Record<string, string | null> = {};
      for (const item of CONFIRM_ITEMS) if (form.has(`confirm.${item}`)) values[item] = formString(form, `confirm.${item}`);
      const r = await confirmMonthItems(ctx, { month, values, expectedVersion, reason: formString(form, "reason") });
      if (r.changed.length === 0) return { ok: true, tone: "info", message: "financeExpenses.result.confirmUnchanged", intent };
      return { ok: true, message: "financeExpenses.result.confirmed", params: { items: r.changed.length, orders: r.resynced }, intent };
    }
    if (intent === "close") {
      const r = await closeMonth(ctx, { month, expectedVersion });
      return {
        ok: true,
        message: r.netProfitEligible ? "financeExpenses.result.closedNetProfit" : "financeExpenses.result.closed",
        params: { month: monthLabel(r.month, locale), snapshots: r.snapshots.length },
        intent,
      };
    }
    if (intent === "reopen") {
      const r = await reopenMonth(ctx, { month, reason: formString(form, "reason"), expectedVersion });
      return { ok: true, message: "financeExpenses.result.reopened", params: { month: monthLabel(r.month, locale) }, intent };
    }
    return { ok: false, error: "error.generic", intent };
  } catch (e) {
    return { ...localizedError(e, locale), intent };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
interface SectionProps {
  data: Data;
  t: TFunction;
  locale: Locale;
}

export default function FinancePeriodsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  return (
    <Page title={t(financeLabelKeys.tab("periods"))} subtitle={t("financeExpenses.periods.subtitle")}>
      <Stack gap={4}>
        <FinanceTabs current="periods" />
        {data.demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <ActionBanner data={actionData} />
        <MonthCard data={data} t={t} locale={locale} />
        <MonthsListCard data={data} t={t} locale={locale} />
        <Text variant="body-sm" tone="subdued">
          {t(financeLabelKeys.notice("netProfitHint"))}
        </Text>
      </Stack>
    </Page>
  );
}

function statusBadge(status: "open" | "closed", t: TFunction) {
  return (
    <Badge size="sm" tone={status === "closed" ? "strong" : "neutral"}>
      {t(financeLabelKeys.periodStatus(status))}
    </Badge>
  );
}

function MonthsListCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  return (
    <Card title={t("financeExpenses.periods.listTitle")} padded={false}>
      <DataTable
        caption={t("financeExpenses.periods.listTitle")}
        rows={data.months}
        rowKey={(m) => m.month}
        columns={[
          {
            key: "month",
            header: t("financeExpenses.periods.month"),
            primary: true,
            render: (m) => (
              <a className="ot-link" href={href(`/finance/periods?month=${m.month}`)} aria-current={m.month === data.month ? "true" : undefined}>
                {monthLabel(m.month, locale)}
              </a>
            ),
          },
          {
            key: "status",
            header: t("financeExpenses.list.state"),
            render: (m) => (
              <Stack direction="horizontal" gap={1}>
                {statusBadge(m.status, t)}
                {m.status === "closed" && m.netProfitEligible ? (
                  <Badge size="sm" tone="success">
                    {t(financeLabelKeys.profitLabel("net_profit"))}
                  </Badge>
                ) : null}
                {!m.fullyPast ? (
                  <Badge size="sm" tone="outline">
                    {t("financeExpenses.periods.current")}
                  </Badge>
                ) : null}
              </Stack>
            ),
          },
          { key: "entries", header: t("financeExpenses.periods.entries"), align: "end", render: (m) => (m.entries > 0 ? String(m.entries) : t("financeExpenses.noData")) },
          { key: "orders", header: t("financeExpenses.periods.orders"), align: "end", hideOnMobile: true, render: (m) => String(m.orders) },
          { key: "snapshots", header: t("financeExpenses.periods.finalSnapshots"), align: "end", hideOnMobile: true, render: (m) => String(m.finalSnapshots) },
          { key: "closedAt", header: t("financeExpenses.periods.closedAt"), hideOnMobile: true, render: (m) => (m.closedAt ? formatDateTime(m.closedAt, locale) : "—") },
        ]}
      />
    </Card>
  );
}

const STATUS_TONE: Record<ChecklistItemResult["status"], "success" | "critical" | "warning" | "neutral" | "outline" | "info"> = {
  ok: "success",
  blocked: "critical",
  warning: "warning",
  confirmed: "success",
  pending: "outline",
  stale: "warning",
  not_needed: "neutral",
};

function itemDetail(i: ChecklistItemResult, t: TFunction): string | null {
  switch (i.item) {
    case "orders_final":
      return t("financeExpenses.checklistCount.orders_final", { count: i.count, recognized: i.details.recognized ?? 0 });
    case "rates_for_display_currencies": {
      const parts = Object.entries(i.details)
        .filter(([k, v]) => k !== "entries" && v > 0)
        .map(([k, v]) => `${k}: ${v}`);
      return parts.length ? t("financeExpenses.checklistCount.rates_missing", { list: parts.join(", ") }) : t("financeExpenses.checklistCount.rates_ok", { entries: i.details.entries ?? 0 });
    }
    case "open_discrepancies":
      return t("financeExpenses.checklistCount.open_discrepancies", { count: i.count, critical: i.details.critical ?? 0 });
    case "orders_need_review":
    case "unknown_cost_units":
    case "packaging_forecast_with_total":
      return i.count > 0 ? t(`financeExpenses.checklistCount.${i.item}`, { count: i.count }) : null;
    default: {
      if (i.kind !== "confirm") return null;
      const expenses = i.details.expenses ?? 0;
      const counts = expenses > 0 ? t("financeExpenses.checklistCount.entriesAndExpenses", { count: i.count, expenses }) : t("financeExpenses.checklistCount.entries", { count: i.count });
      if (i.status !== "stale" || !i.value) return counts;
      const value = t(`financeExpenses.confirmValue.${i.value}`);
      const why = i.staleReason === "financeExpenses.error.confirmNoneWithEntries" ? "staleNone" : "staleEntered";
      return `${counts} ${t(`financeExpenses.checklistCount.${why}`, { value })}`;
    }
  }
}

function MonthCard({ data, t, locale }: SectionProps) {
  const o = data.overview;
  const c = o.checklist;
  const closed = o.status === "closed";
  const groups = (["blocking", "warning", "confirm"] as const).map((kind) => ({ kind, items: c.items.filter((i) => i.kind === kind) }));
  return (
    <Card
      id="month"
      title={t("financeExpenses.periods.monthTitle", { month: monthLabel(o.month, locale) })}
      description={closed ? t("financeExpenses.periods.closedDescription") : t("financeExpenses.periods.openDescription")}
      actions={statusBadge(o.status, t)}
    >
      <Stack gap={4}>
        {closed ? (
          <Banner tone={o.netProfitEligible ? "success" : "info"}>
            <p>
              {t("financeExpenses.periods.closedInfo", { date: formatDateTime(o.closedAt, locale) })}{" "}
              {o.netProfitEligible ? t("financeExpenses.periods.netProfitYes") : t("financeExpenses.periods.netProfitNo")}
            </p>
          </Banner>
        ) : null}
        {!closed && o.reopenedAt ? (
          <Banner tone="info">{t("financeExpenses.periods.reopenedInfo", { date: formatDateTime(o.reopenedAt, locale), reason: o.reopenReason ?? "—" })}</Banner>
        ) : null}
        {groups.map((g) => (
          <Stack key={g.kind} gap={2}>
            <Text as="h3" variant="heading-sm">
              {t(`financeExpenses.checklistMarker.${g.kind}`)} {t(financeLabelKeys.checklistKind(g.kind))}
            </Text>
            <Stack as="ul" gap={2}>
              {g.items.map((i) => (
                <li key={i.item}>
                  <Stack direction="horizontal" gap={2} align="center">
                    <Badge size="sm" tone={STATUS_TONE[i.status]}>
                      {i.value && i.status !== "stale" ? t(`financeExpenses.confirmValue.${i.value}`) : t(`financeExpenses.checklistStatus.${i.status}`)}
                    </Badge>
                    <Text as="span">{t(financeLabelKeys.checklist(i.item))}</Text>
                  </Stack>
                  {itemDetail(i, t) ? (
                    <Text as="p" variant="body-sm" tone="subdued">
                      {itemDetail(i, t)}
                    </Text>
                  ) : null}
                </li>
              ))}
            </Stack>
          </Stack>
        ))}
        {!closed ? <ConfirmForm data={data} t={t} locale={locale} /> : null}
        {!closed ? <CloseForm data={data} t={t} locale={locale} /> : <ReopenForm data={data} t={t} locale={locale} />}
        <SnapshotsBlock data={data} t={t} locale={locale} />
        <Disclosure summary={t("financeExpenses.detail.history")}>
          {o.history.length === 0 ? (
            <Text tone="subdued">{t("financeExpenses.noData")}</Text>
          ) : (
            <ul>
              {o.history.map((h) => (
                <li key={h.id}>
                  {formatDateTime(h.createdAt, locale)} — {t(financeLabelKeys.changeAction(h.action as never))}
                  {h.reason ? ` · ${h.reason}` : ""}
                </li>
              ))}
            </ul>
          )}
        </Disclosure>
      </Stack>
    </Card>
  );
}

function ConfirmForm({ data, t }: SectionProps) {
  const o = data.overview;
  const confirmItems = o.checklist.items.filter((i) => i.kind === "confirm");
  return (
    <Disclosure summary={t("financeExpenses.periods.confirmTitle")} defaultOpen={o.checklist.pendingConfirmations + o.checklist.staleConfirmations > 0}>
      <Form method="post" preventScrollReset>
        <input type="hidden" name="intent" value="confirm" />
        <input type="hidden" name="month" value={o.month} />
        <input type="hidden" name="expectedVersion" value={o.version} />
        <Stack gap={3}>
          <Text variant="body-sm" tone="subdued">
            {t("financeExpenses.periods.confirmHelp")}
          </Text>
          <FormLayout columns={2}>
            {confirmItems.map((i) => (
              <Select
                key={i.item}
                label={t(financeLabelKeys.checklist(i.item))}
                name={`confirm.${i.item}`}
                defaultValue={o.confirmations[i.item as keyof typeof o.confirmations] ?? ""}
                options={[
                  { value: "", label: t("financeExpenses.confirmValue.unset") },
                  ...allowedConfirmValues(i.item as (typeof CONFIRM_ITEMS)[number]).map((v) => ({ value: v, label: t(`financeExpenses.confirmValue.${v}`) })),
                ]}
                helpText={(i.details.expenses ?? 0) > 0 ? t("financeExpenses.checklistCount.entriesAndExpenses", { count: i.count, expenses: i.details.expenses ?? 0 }) : t("financeExpenses.checklistCount.entries", { count: i.count })}
              />
            ))}
          </FormLayout>
          <TextField label={t("financeExpenses.field.reason")} name="reason" maxLength={300} />
          <div>
            <Button type="submit" variant="secondary">
              {t("financeExpenses.periods.confirmSave")}
            </Button>
          </div>
        </Stack>
      </Form>
    </Disclosure>
  );
}

function CloseForm({ data, t, locale }: SectionProps) {
  const o = data.overview;
  const c = o.checklist;
  const reason = !o.fullyPast ? t("financeExpenses.periods.notPast") : c.blockingFailures > 0 ? t("financeExpenses.periods.blocked", { count: c.blockingFailures }) : null;
  return (
    <Form method="post" preventScrollReset>
      <input type="hidden" name="intent" value="close" />
      <input type="hidden" name="month" value={o.month} />
      <input type="hidden" name="expectedVersion" value={o.version} />
      <Stack gap={2}>
        {reason ? <Banner tone="warning">{reason}</Banner> : null}
        {!reason && c.warnings > 0 ? <Banner tone="warning">{t("financeExpenses.periods.warningsBeforeClose", { count: c.warnings })}</Banner> : null}
        {c.staleConfirmations > 0 ? <Banner tone="warning">{t("financeExpenses.periods.staleConfirmations", { count: c.staleConfirmations })}</Banner> : null}
        {!reason && !c.allConfirmed ? <Text variant="body-sm">{t("financeExpenses.periods.closeWithoutNetProfit")}</Text> : null}
        <div>
          <ConfirmSubmitButton
            title={t(financeLabelKeys.term("closeMonth"))}
            message={t("financeExpenses.periods.closeConfirm", { month: monthLabel(o.month, locale), currencies: o.displayCurrencies.join(", ") })}
            confirmLabel={t(financeLabelKeys.term("closeMonth"))}
            cancelLabel={t("financeExpenses.form.cancel")}
            variant="primary"
            confirmVariant="primary"
            disabled={reason !== null}
          >
            {t(financeLabelKeys.term("closeMonth"))}
          </ConfirmSubmitButton>
        </div>
      </Stack>
    </Form>
  );
}

function ReopenForm({ data, t, locale }: SectionProps) {
  const o = data.overview;
  return (
    <Form method="post" preventScrollReset>
      <input type="hidden" name="intent" value="reopen" />
      <input type="hidden" name="month" value={o.month} />
      <input type="hidden" name="expectedVersion" value={o.version} />
      <Stack gap={2}>
        <TextField label={t("financeExpenses.periods.reopenReason")} name="reason" required maxLength={300} helpText={t("financeExpenses.periods.reopenHelp")} />
        <div>
          <ConfirmSubmitButton
            title={t(financeLabelKeys.term("reopenMonth"))}
            message={t("financeExpenses.periods.reopenConfirm", { month: monthLabel(o.month, locale) })}
            confirmLabel={t(financeLabelKeys.term("reopenMonth"))}
            cancelLabel={t("financeExpenses.form.cancel")}
            variant="critical"
          >
            {t(financeLabelKeys.term("reopenMonth"))}
          </ConfirmSubmitButton>
        </div>
      </Stack>
    </Form>
  );
}

function SnapshotsBlock({ data, t, locale }: SectionProps) {
  const o = data.overview;
  return (
    <Stack gap={2}>
      <Text as="h3" variant="heading-sm">
        {t("financeExpenses.periods.snapshotsTitle")}
      </Text>
      {o.liveCurrencies.length > 0 ? (
        <Banner tone="info">
          {t(financeLabelKeys.notice("liveRecalculation"))}: {o.liveCurrencies.join(", ")}
        </Banner>
      ) : null}
      {o.snapshots.length === 0 ? (
        <EmptyState title={t("financeExpenses.noData")} description={t("financeExpenses.periods.noSnapshots")} />
      ) : (
        <DataTable
          caption={t("financeExpenses.periods.snapshotsTitle")}
          rows={o.snapshots}
          rowKey={(s) => s.id}
          columns={[
            { key: "currency", header: t("financeExpenses.field.currency"), primary: true, render: (s) => s.reportingCurrency },
            { key: "version", header: t("financeExpenses.detail.version"), align: "end", render: (s) => String(s.version) },
            {
              key: "kind",
              header: t("financeExpenses.list.state"),
              render: (s) => (
                <Stack direction="horizontal" gap={1}>
                  {s.isFinal ? (
                    <Badge size="sm" tone="strong">
                      {t("financeExpenses.periods.final")}
                    </Badge>
                  ) : null}
                  <Badge size="sm" tone="outline">
                    {t(financeLabelKeys.snapshotSource(s.source as "manual" | "scheduled" | "close"))}
                  </Badge>
                </Stack>
              ),
            },
            { key: "at", header: t("financeExpenses.periods.generatedAt"), render: (s) => formatDateTime(s.generatedAt, locale) },
            { key: "sha", header: "SHA-256", hideOnMobile: true, render: (s) => <code>{s.dataSha256.slice(0, 12)}</code> },
          ]}
        />
      )}
      <Text variant="body-sm" tone="subdued">
        {t("financeExpenses.periods.snapshotNote", { from: formatIsoDate(o.month, locale) })}
      </Text>
    </Stack>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

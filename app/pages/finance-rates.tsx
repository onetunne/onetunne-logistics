/**
 * Етап 6, WP1: «Фінанси → Курси» (docs/stage6-design.md §5, §10.4, §18.2). Маршрут …/finance/rates (app/routes.ts).
 * Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router). Кожен сервіс ще раз перевіряє requireFinance.
 *
 * Розділи: «Розбіжності курсів НБУ» (якщо є) · «Курси за датами» (НБУ / Вручну / Демо, позначки «запасний» і «Без
 * курсу», правило вибору rateFor) · «Курс вручну» («1 EUR = … грн», причина, версії, кількість зачеплених записів і Δ,
 * анулювання) · «Версії ручних курсів» · «Обмін валюти» (форма й перелік, курсова різниця) · «Курси НБУ» (вимикач і
 * стан, «Оновити зараз», «Завантажити історичні курси» — неактивні без вимикача; у демо НБУ немає) · «Курси для тарифів
 * Checkout (не фінансові)» лише для читання · посилання на джерело. Порожня база — «Немає даних» / порожні стани; суми й
 * курси — десяткові рядки (app/lib/format.ts, formatRate), відсутнє — «—», ніколи не 0.
 */
import type { ReactNode } from "react";
import { Form, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { useHref } from "~/components/shell";
import { FX_CONVERSION_COUNTERPARTIES, FX_RATE_UNITS, QUICK_CURRENCIES } from "~/domain/finance";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { formatDateTime, formatIsoDate, formatMoney } from "~/lib/format";
import { isSupportedCurrency } from "~/lib/decimal";
import { addDays, businessDate, daysBetween, parseIsoDate } from "~/lib/periods";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { listDiscrepancies, resolveDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getFinanceSettings } from "~/modules/finance/core/settings.server";
import { createFxConversion, listFxConversions, voidFxConversion } from "~/modules/fx/conversions.server";
import { formatRate } from "~/modules/fx/display";
import { saveManualRate, voidManualRate } from "~/modules/fx/manual-rates.server";
import { requestNbuBackfill, requestNbuFetch, setNbuEnabled } from "~/modules/fx/nbu-fetch.server";
import { NBU_BACKFILL_EARLIEST, NBU_BACKFILL_MAX_YEARS } from "~/modules/fx/nbu-parse";
import { getCheckoutRatesView, getNbuState, listManualRateVersions, listRateCurrencies, listRateMatrix, RATE_MATRIX_MAX_DAYS, type RateCell } from "~/modules/fx/queries.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSubmitButton,
  DataTable,
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

const CODE_RE = /^[A-Z]{3}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_DAYS = 14;

const codeOf = (v: string | null | undefined) => {
  const c = (v ?? "").trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
};

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const url = new URL(request.url);
  const sp = url.searchParams;
  const today = businessDate(ctx.now());
  const { value: settings } = await getFinanceSettings(ctx);
  const to = parseIsoDate(sp.get("to")) ?? today;
  const fromParam = parseIsoDate(sp.get("from"));
  let from = fromParam && fromParam <= to ? fromParam : addDays(to, -(DEFAULT_DAYS - 1));
  if (daysBetween(from, to) + 1 > RATE_MATRIX_MAX_DAYS) from = addDays(to, -(RATE_MATRIX_MAX_DAYS - 1));
  const extra = codeOf(sp.get("currency"));
  const display = settings.displayCurrencies.filter((c) => c !== "UAH");
  const currencies = [...new Set([...display, ...(extra && extra !== "UAH" ? [extra] : [])])];
  const known = await listRateCurrencies(ctx);
  // Лише валюти фінансів (0 або 2 знаки; НБУ публікує й TND тощо — для них ручний курс не потрібен, §5.1).
  const rateCurrencyOptions = [...new Set([...QUICK_CURRENCIES, ...display, ...known])].filter((c) => c !== "UAH" && isSupportedCurrency(c));
  const editCurrency = codeOf(sp.get("rateCurrencyOther")) ?? codeOf(sp.get("rateCurrency")) ?? rateCurrencyOptions[0] ?? "EUR";
  const editDate = parseIsoDate(sp.get("rateDate")) ?? today;
  const [matrix, editMatrix, versions, nbu, conversions, conflicts, checkout] = await Promise.all([
    listRateMatrix(ctx, { from, to, currencies }),
    editCurrency !== "UAH" ? listRateMatrix(ctx, { from: editDate, to: editDate, currencies: [editCurrency] }) : null,
    listManualRateVersions(ctx, { limit: 50 }),
    getNbuState(ctx),
    listFxConversions(ctx, { limit: 50 }),
    listDiscrepancies(ctx, { type: "fx_rate_conflict", status: "open", limit: 50 }),
    getCheckoutRatesView(ctx),
  ]);
  return {
    demo: ctx.mode === "demo",
    today,
    period: { from, to },
    extraCurrency: extra,
    reportingCurrency: settings.reportingCurrency,
    rateCurrencyOptions,
    conversionCurrencies: [...new Set(["UAH", ...rateCurrencyOptions])],
    matrix,
    edit: { currency: editCurrency, date: editDate, cell: editMatrix?.rows[0]?.cells[editCurrency] ?? null },
    versions,
    nbu,
    conversions,
    conflicts: conflicts.map((d) => ({ id: d.id, version: d.version, details: d.details, createdAt: d.createdAt.toISOString() })),
    checkout,
    operationId: globalThis.crypto.randomUUID(),
  };
}

type RatesActionResult = ActionResult & { intent?: string; nextOperationId?: string };

/** Параметри помилок сервісів для показу: ISO-дати → формат мови, місяць → «10.2026». */
function localizedError(e: unknown, locale: Locale): ActionResult {
  const r = toActionError(e);
  if (r.error === "error.notFound") return { ok: false, error: "financeFx.error.notFound" };
  if (!r.params) return r;
  const params: Record<string, string | number> = { ...r.params };
  if (typeof params.date === "string" && parseIsoDate(params.date)) params.date = formatIsoDate(params.date, locale);
  if (typeof params.month === "string" && parseIsoDate(params.month)) {
    const [y, m] = params.month.split("-");
    params.month = locale === "uk" ? `${m}.${y}` : `${m}/${y}`;
  }
  return { ...r, params };
}

function signed(amount: string, currency: string, locale: Locale): string {
  const s = formatMoney(amount, currency, locale);
  return /^[^-]/.test(amount) && /[1-9]/.test(amount) ? `+${s}` : s;
}

export async function action({ request }: ActionFunctionArgs): Promise<RatesActionResult> {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  const nextOperationId = globalThis.crypto.randomUUID();
  const locale = ctx.locale;
  let intent = "";
  try {
    const form = await request.formData();
    intent = formString(form, "intent");
    const version = (name: string) => {
      const raw = formString(form, name);
      return /^\d{1,9}$/.test(raw) ? Number(raw) : undefined;
    };
    if (intent === "saveRate") {
      const r = await saveManualRate(ctx, {
        currency: formString(form, "currency"),
        effectiveDate: formString(form, "effectiveDate"),
        rate: formString(form, "rate"),
        units: formString(form, "units") || 1,
        reason: formString(form, "reason") || null,
        expectedVersion: version("expectedVersion"),
      });
      const params = { currency: r.currency, date: formatIsoDate(r.effectiveDate, locale), version: r.version, entries: r.affectedEntries, delta: signed(r.deltaReporting, r.reportingCurrency, locale) };
      if (r.duplicate) return { ok: true, tone: "info", message: "financeFx.result.rateUnchanged", params, intent, nextOperationId };
      const extra = [...(r.completedLayers > 0 ? ["financeFx.result.layers"] : []), ...(r.repricedConversions > 0 ? ["financeFx.result.conversionsRepriced"] : [])];
      return {
        ok: true,
        message: "financeFx.result.rateSaved",
        params: { ...params, n: r.completedLayers > 0 ? r.completedLayers : r.repricedConversions },
        ...(extra.length ? { extra } : {}),
        intent,
        nextOperationId,
      };
    }
    if (intent === "voidRate") {
      const r = await voidManualRate(ctx, {
        currency: formString(form, "currency"),
        effectiveDate: formString(form, "effectiveDate"),
        reason: formString(form, "reason"),
        expectedVersion: version("expectedVersion"),
      });
      if (r.duplicate) return { ok: true, tone: "info", message: "financeFx.result.rateAlreadyVoided", params: { currency: r.currency, date: formatIsoDate(r.effectiveDate, locale) }, intent, nextOperationId };
      return {
        ok: true,
        message: "financeFx.result.rateVoided",
        params: { currency: r.currency, date: formatIsoDate(r.effectiveDate, locale), entries: r.affectedEntries, delta: signed(r.deltaReporting, r.reportingCurrency, locale), n: r.repricedConversions },
        ...(r.repricedConversions > 0 ? { extra: ["financeFx.result.conversionsRepriced"] } : {}),
        intent,
        nextOperationId,
      };
    }
    if (intent === "nbuToggle") {
      const enabled = formString(form, "enabled") === "true";
      await setNbuEnabled(ctx, { enabled, reason: formString(form, "reason") || null });
      return { ok: true, message: enabled ? "financeFx.result.nbuOn" : "financeFx.result.nbuOff", intent, nextOperationId };
    }
    if (intent === "nbuFetch") {
      const r = await requestNbuFetch(ctx);
      return { ok: true, tone: r.queued ? "success" : "info", message: r.queued ? "financeFx.result.fetchQueued" : "financeFx.result.fetchAlreadyQueued", intent, nextOperationId };
    }
    if (intent === "nbuBackfill") {
      const r = await requestNbuBackfill(ctx, { currency: formString(form, "currency"), from: formString(form, "from"), to: formString(form, "to") });
      return { ok: true, message: "financeFx.result.backfillQueued", params: { queued: r.queued, windows: r.windows }, intent, nextOperationId };
    }
    if (intent === "conversion") {
      const r = await createFxConversion(ctx, {
        operationId: formString(form, "operationId"),
        occurredOn: formString(form, "occurredOn"),
        soldAmount: formString(form, "soldAmount"),
        soldCurrency: formString(form, "soldCurrency"),
        boughtAmount: formString(form, "boughtAmount"),
        boughtCurrency: formString(form, "boughtCurrency"),
        counterparty: formString(form, "counterparty") || "bank",
        note: formString(form, "note") || null,
      });
      if (r.duplicate) return { ok: true, tone: "info", message: "financeFx.result.conversionDuplicate", intent, nextOperationId };
      return {
        ok: true,
        message: "financeFx.result.conversionSaved",
        params: {
          expected: r.expected ? formatMoney(r.expected.amount, r.expected.currency, locale) : "—",
          difference: signed(r.difference.amount, r.difference.currency, locale),
        },
        intent,
        nextOperationId,
      };
    }
    if (intent === "voidConversion") {
      await voidFxConversion(ctx, { id: formString(form, "id"), reason: formString(form, "reason"), expectedVersion: version("expectedVersion") });
      return { ok: true, message: "financeFx.result.conversionVoided", intent, nextOperationId };
    }
    if (intent === "keepConflict") {
      const id = formString(form, "id");
      if (!UUID_RE.test(id)) return { ok: false, error: "financeFx.error.notFound", intent, nextOperationId };
      await resolveDiscrepancy(ctx, { id, status: "resolved", resolutionCode: "accepted", note: formString(form, "note") || null, expectedVersion: version("expectedVersion") });
      return { ok: true, message: "financeFx.result.conflictKept", intent, nextOperationId };
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

const UNIT_OPTIONS = FX_RATE_UNITS.map((u) => ({ value: String(u), label: String(u) }));

/**
 * Відступи вмісту (форма, порожні стани) у картці без відступів (`padded={false}`, таблиця на всю ширину). Не клас
 * `ot-card__body`: у такій картці правило `.ot-card--flush .ot-card__body` обнуляє його відступи.
 */
function Inset({ children }: { children: ReactNode }) {
  return (
    <div className="ot-rates-inset" style={{ padding: "var(--ot-space-4)", minWidth: 0 }}>
      {children}
    </div>
  );
}

export default function FinanceRatesPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const operationId = actionData?.ok && actionData.nextOperationId ? actionData.nextOperationId : data.operationId;
  return (
    <Page title={t(financeLabelKeys.tab("rates"))} subtitle={t("financeFx.subtitle")}>
      <Stack gap={4}>
        <FinanceTabs current="rates" />
        {data.demo ? (
          <Banner tone="info">
            <p>{t(financeLabelKeys.notice("demo"))}</p>
            <p>{t(financeLabelKeys.notice("demoRates"))}</p>
          </Banner>
        ) : null}
        <ActionBanner data={actionData} />
        <ConflictsCard data={data} t={t} locale={locale} />
        <RatesTableCard data={data} t={t} locale={locale} />
        <ManualRateCard data={data} t={t} locale={locale} />
        <VersionsCard data={data} t={t} locale={locale} />
        <ConversionCard data={data} t={t} locale={locale} operationId={operationId} />
        <NbuCard data={data} t={t} locale={locale} />
        <CheckoutCard data={data} t={t} locale={locale} />
        <Stack gap={1}>
          <Text variant="body-sm" tone="subdued">
            {t(financeLabelKeys.notice("nbuSource"))} ·{" "}
            <a className="ot-link" href="https://bank.gov.ua/ua/markets/exchangerates" target="_blank" rel="noopener noreferrer">
              {t("financeFx.source.link")}
            </a>
          </Text>
          <Text variant="body-sm" tone="subdued">
            {t("financeFx.cross")} {t(financeLabelKeys.notice("rounding"))}
          </Text>
        </Stack>
      </Stack>
    </Page>
  );
}

function sourceTone(source: string): "info" | "neutral" | "outline" | "strong" {
  return source === "manual" ? "strong" : source === "demo" ? "outline" : "neutral";
}

function RateCellView({ cell, t, locale, auto, currency, date }: { cell: RateCell; t: TFunction; locale: Locale; auto: "nbu" | "demo"; currency: string; date: string }) {
  const eff = cell.effective;
  if (!eff) {
    return (
      <Stack gap={1}>
        <Text as="span" tone="subdued">
          {t(financeLabelKeys.rate("none"))}
        </Text>
        <Text as="span" variant="body-sm">
          <ManualLink currency={currency} date={date} t={t} />
        </Text>
      </Stack>
    );
  }
  const published = eff.source === "manual" ? cell.manual : eff.fallback ? null : cell.automatic;
  return (
    <Stack gap={1}>
      <Text as="span" weight="semibold">
        {formatRate(eff.ratePerUnit, locale)}
      </Text>
      <span>
        <Badge size="sm" tone={sourceTone(eff.source)}>
          {t(financeLabelKeys.rateSource(eff.source))}
          {eff.source === "manual" && eff.version ? ` · ${t("financeFx.table.version", { version: eff.version })}` : ""}
        </Badge>
      </span>
      {eff.fallback ? (
        <Text as="span" variant="body-sm" tone="warning">
          {t(financeLabelKeys.rate("fallback"), { date: formatIsoDate(eff.rateDate, locale) })}
        </Text>
      ) : null}
      {published && published.units > 1 ? (
        <Text as="span" variant="body-sm" tone="subdued">
          {t("financeFx.table.perUnits", { rate: formatRate(published.rate, locale), units: published.units })}
        </Text>
      ) : null}
      {eff.source === "manual" && cell.automatic ? (
        <Text as="span" variant="body-sm" tone="subdued">
          {t(financeLabelKeys.rateSource(auto))}: {formatRate(cell.automatic.ratePerUnit, locale)}
        </Text>
      ) : null}
      {eff.fallback ? (
        <Text as="span" variant="body-sm">
          <ManualLink currency={currency} date={date} t={t} />
        </Text>
      ) : null}
    </Stack>
  );
}

function ConflictsCard({ data, t, locale }: SectionProps) {
  if (data.conflicts.length === 0) return null;
  return (
    <Card title={t("financeFx.conflicts.title")} description={t("financeFx.conflicts.description")}>
      <Stack gap={3}>
        {data.conflicts.map((c) => {
          const d = c.details as Record<string, unknown>;
          const currency = String(d.currency ?? "");
          const date = String(d.effectiveDate ?? "");
          return (
            <Banner key={c.id} tone="critical" title={t(financeLabelKeys.discrepancy("fx_rate_conflict"))}>
              <p>
                {t("financeFx.conflicts.row", {
                  currency,
                  date: formatIsoDate(date, locale),
                  stored: `${formatRate(String(d.storedRate ?? ""), locale)} / ${String(d.storedUnits ?? "")}`,
                  fetched: `${formatRate(String(d.fetchedRate ?? ""), locale)} / ${String(d.fetchedUnits ?? "")}`,
                })}
              </p>
              <Form method="post" preventScrollReset>
                <input type="hidden" name="intent" value="keepConflict" />
                <input type="hidden" name="id" value={c.id} />
                <input type="hidden" name="expectedVersion" value={c.version} />
                <Stack direction="horizontal" gap={2} align="end">
                  <TextField label={t("financeFx.conflicts.note")} name="note" maxLength={300} />
                  <Button type="submit" variant="secondary">
                    {t("financeFx.conflicts.keep")}
                  </Button>
                  <ManualLink currency={currency} date={date} t={t} />
                </Stack>
              </Form>
            </Banner>
          );
        })}
      </Stack>
    </Card>
  );
}

function ManualLink({ currency, date, t }: { currency: string; date: string; t: TFunction }) {
  const href = useHref();
  return (
    <a className="ot-link" href={href(`/finance/rates?rateCurrency=${encodeURIComponent(currency)}&rateDate=${encodeURIComponent(date)}#manual-rate`)}>
      {t("financeFx.table.enterManual")}
    </a>
  );
}

function RatesTableCard({ data, t, locale }: SectionProps) {
  const m = data.matrix;
  const hasAny = m.rows.some((r) => m.currencies.some((c) => r.cells[c]?.effective));
  return (
    <Card
      title={t("financeFx.table.title")}
      description={t("financeFx.table.description", { source: t(financeLabelKeys.rateSource(m.automaticSource)), days: m.fallbackDays })}
      padded={false}
    >
      <Stack gap={0}>
        <Inset>
          <Form method="get" preventScrollReset>
            <Grid columns={{ xs: 1, md: 4 }} gap={3}>
              <TextField label={t("financeFx.table.from")} name="from" type="date" defaultValue={data.period.from} />
              <TextField label={t("financeFx.table.to")} name="to" type="date" defaultValue={data.period.to} />
              <TextField
                label={t("financeFx.table.addCurrency")}
                name="currency"
                defaultValue={data.extraCurrency ?? ""}
                maxLength={3}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                pattern="[A-Za-z]{3}"
              />
              <div>
                <Button type="submit" variant="secondary">
                  {t("financeFx.table.show")}
                </Button>
              </div>
            </Grid>
          </Form>
        </Inset>
        {m.currencies.length === 0 ? (
          <Inset>
            <EmptyState title={t("financeFx.noData")} description={t("financeFx.table.noCurrencies")} />
          </Inset>
        ) : !hasAny ? (
          <Inset>
            <EmptyState title={t("financeFx.noData")} description={t("financeFx.table.empty")} />
          </Inset>
        ) : (
          <DataTable
            caption={t("financeFx.table.title")}
            rows={m.rows}
            rowKey={(r) => r.date}
            columns={[
              {
                key: "date",
                header: t("financeFx.table.date"),
                primary: true,
                render: (r) => (
                  <Stack gap={1}>
                    <span>{formatIsoDate(r.date, locale)}</span>
                    {r.weekend ? (
                      <Text as="span" variant="body-sm" tone="subdued">
                        {t(financeLabelKeys.rate("weekend"))}
                      </Text>
                    ) : null}
                  </Stack>
                ),
              },
              ...m.currencies.map((c) => ({
                key: c,
                header: c,
                render: (r: (typeof m.rows)[number]) => {
                  const cell = r.cells[c];
                  return cell ? <RateCellView cell={cell} t={t} locale={locale} auto={m.automaticSource} currency={c} date={r.date} /> : "—";
                },
              })),
            ]}
          />
        )}
      </Stack>
    </Card>
  );
}

function ManualRateCard({ data, t, locale }: SectionProps) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting" && navigation.formData?.get("intent") === "saveRate";
  const { currency, date, cell } = data.edit;
  const manual = cell?.manual ?? null;
  const eff = cell?.effective ?? null;
  const defaultUnits = String(manual?.units ?? cell?.automatic?.units ?? 1);
  const keep = (
    <>
      <input type="hidden" name="from" value={data.period.from} />
      <input type="hidden" name="to" value={data.period.to} />
      {data.extraCurrency ? <input type="hidden" name="currency" value={data.extraCurrency} /> : null}
    </>
  );
  return (
    <Card id="manual-rate" title={t("financeFx.manual.title")} description={t("financeFx.manual.description")}>
      <Stack gap={4}>
        <Form method="get" preventScrollReset>
          {keep}
          <FormLayout>
            <Text variant="heading-sm">{t("financeFx.manual.pickTitle")}</Text>
            <Grid columns={{ xs: 1, md: 3 }} gap={3}>
              <Select
                label={t("financeFx.manual.currency")}
                name="rateCurrency"
                defaultValue={data.rateCurrencyOptions.includes(currency) ? currency : data.rateCurrencyOptions[0]}
                options={data.rateCurrencyOptions.map((c) => ({ value: c, label: c }))}
              />
              <TextField
                label={t("financeFx.table.addCurrency")}
                name="rateCurrencyOther"
                defaultValue={data.rateCurrencyOptions.includes(currency) ? "" : currency}
                maxLength={3}
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                pattern="[A-Za-z]{3}"
              />
              <TextField label={t("financeFx.manual.date")} name="rateDate" type="date" defaultValue={date} max={addDays(data.today, 7)} />
            </Grid>
            <div>
              <Button type="submit" variant="secondary">
                {t("financeFx.manual.pick")}
              </Button>
            </div>
          </FormLayout>
        </Form>
        <KeyValueList
          items={[
            { key: "cur", label: t("financeFx.manual.currency"), value: currency },
            { key: "date", label: t("financeFx.manual.date"), value: formatIsoDate(date, locale) },
            {
              key: "eff",
              label: t("financeFx.versions.rate"),
              value: eff ? (
                <Stack gap={1}>
                  <span>
                    {t("financeFx.manual.effective", { rate: formatRate(eff.ratePerUnit, locale) })} · {t(financeLabelKeys.rateSource(eff.source))}
                  </span>
                  {eff.fallback ? <span>{t(financeLabelKeys.rate("fallback"), { date: formatIsoDate(eff.rateDate, locale) })}</span> : null}
                </Stack>
              ) : (
                t("financeFx.manual.noEffective")
              ),
            },
            {
              key: "manual",
              label: t("financeFx.manual.title"),
              value: manual ? t("financeFx.manual.current", { rate: formatRate(manual.ratePerUnit, locale), version: manual.version }) : t("financeFx.manual.noCurrent"),
            },
          ]}
        />
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="saveRate" />
          <input type="hidden" name="currency" value={currency} />
          <input type="hidden" name="effectiveDate" value={date} />
          <input type="hidden" name="expectedVersion" value={manual?.version ?? 0} />
          <FormLayout>
            <Grid columns={{ xs: 1, md: 2 }} gap={3}>
              <TextField
                label={t("financeFx.manual.rate")}
                name="rate"
                inputMode="decimal"
                required
                autoComplete="off"
                helpText={t("financeFx.manual.rateHelp", { units: defaultUnits, currency })}
              />
              <Select label={t("financeFx.manual.units")} name="units" defaultValue={defaultUnits} options={UNIT_OPTIONS} helpText={t("financeFx.manual.unitsHelp")} />
            </Grid>
            <TextField label={t("financeFx.manual.reason")} name="reason" maxLength={300} multiline={2} helpText={t("financeFx.manual.reasonHelp")} />
            <div>
              <Button type="submit" variant="primary" disabled={busy}>
                {t("financeFx.manual.save")}
              </Button>
            </div>
          </FormLayout>
        </Form>
        {manual ? (
          <Form method="post" preventScrollReset>
            <input type="hidden" name="intent" value="voidRate" />
            <input type="hidden" name="currency" value={currency} />
            <input type="hidden" name="effectiveDate" value={date} />
            <input type="hidden" name="expectedVersion" value={manual.version} />
            <FormLayout>
              <TextField label={t("financeFx.manual.voidReason")} name="reason" required maxLength={300} />
              <div>
                <ConfirmSubmitButton
                  title={t("financeFx.manual.voidTitle")}
                  message={t("financeFx.manual.voidMessage")}
                  confirmLabel={t("financeFx.manual.void")}
                  cancelLabel={t("common.cancel")}
                  confirmVariant="critical"
                  variant="secondary"
                >
                  {t("financeFx.manual.void")}
                </ConfirmSubmitButton>
              </div>
            </FormLayout>
          </Form>
        ) : null}
      </Stack>
    </Card>
  );
}

function VersionsCard({ data, t, locale }: SectionProps) {
  const rows = data.versions;
  return (
    <Card title={t("financeFx.versions.title")} padded={rows.length === 0}>
      {rows.length === 0 ? (
        <EmptyState title={t("financeFx.noData")} description={t("financeFx.versions.empty")} />
      ) : (
        <DataTable
          caption={t("financeFx.versions.title")}
          rows={rows}
          rowKey={(r) => r.id}
          columns={[
            { key: "date", header: t("financeFx.manual.date"), primary: true, render: (r) => `${formatIsoDate(r.effectiveDate, locale)} · ${r.currency}` },
            { key: "version", header: t("financeFx.versions.version"), align: "end", render: (r) => String(r.version) },
            {
              key: "rate",
              header: t("financeFx.versions.rate"),
              align: "end",
              render: (r) => (r.units > 1 ? t("financeFx.table.perUnits", { rate: formatRate(r.rate, locale), units: r.units }) : formatRate(r.ratePerUnit, locale)),
            },
            {
              key: "state",
              header: t("financeFx.versions.state"),
              render: (r) => (
                <Badge size="sm" tone={r.isCurrent ? "strong" : "neutral"}>
                  {r.isCurrent ? t("financeFx.versions.current") : t("financeFx.versions.replaced")}
                </Badge>
              ),
            },
            { key: "affected", header: t("financeFx.versions.affected"), align: "end", hideOnMobile: true, render: (r) => (r.affectedEntries === null ? "—" : String(r.affectedEntries)) },
            {
              key: "delta",
              header: t("financeFx.versions.delta"),
              align: "end",
              render: (r) => (r.deltaReporting !== null && r.reportingCurrency ? signed(r.deltaReporting, r.reportingCurrency, locale) : "—"),
            },
            { key: "reason", header: t("financeFx.versions.reason"), hideOnMobile: true, render: (r) => r.reason ?? "—" },
            { key: "created", header: t("financeFx.versions.created"), hideOnMobile: true, render: (r) => formatDateTime(r.createdAt, locale) },
          ]}
        />
      )}
    </Card>
  );
}

function ConversionCard({ data, t, locale, operationId }: SectionProps & { operationId: string }) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting" && navigation.formData?.get("intent") === "conversion";
  const options = data.conversionCurrencies.map((c) => ({ value: c, label: c }));
  const soldDefault = data.conversionCurrencies.find((c) => c !== "UAH") ?? "EUR";
  return (
    <Card id="conversion" title={t("financeFx.conversion.title")} description={t("financeFx.conversion.description")}>
      <Stack gap={4}>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="conversion" />
          <input type="hidden" name="operationId" value={operationId} />
          <FormLayout>
            <Grid columns={{ xs: 1, md: 2 }} gap={3}>
              <TextField label={t("financeFx.conversion.date")} name="occurredOn" type="date" required defaultValue={data.today} max={data.today} />
              <Select
                label={t("financeFx.conversion.counterparty")}
                name="counterparty"
                defaultValue="bank"
                options={FX_CONVERSION_COUNTERPARTIES.map((c) => ({ value: c, label: t(`financeFx.counterparty.${c}`) }))}
              />
              <TextField label={t("financeFx.conversion.soldAmount")} name="soldAmount" inputMode="decimal" required autoComplete="off" />
              <Select label={t("financeFx.conversion.soldCurrency")} name="soldCurrency" defaultValue={soldDefault} options={options} />
              <TextField label={t("financeFx.conversion.boughtAmount")} name="boughtAmount" inputMode="decimal" required autoComplete="off" />
              <Select label={t("financeFx.conversion.boughtCurrency")} name="boughtCurrency" defaultValue="UAH" options={options} />
            </Grid>
            <TextField label={t("financeFx.conversion.note")} name="note" maxLength={200} />
            <div>
              <Button type="submit" variant="primary" disabled={busy}>
                {t("financeFx.conversion.save")}
              </Button>
            </div>
          </FormLayout>
        </Form>
        {data.conversions.length === 0 ? (
          <EmptyState title={t("financeFx.noData")} description={t("financeFx.conversion.empty")} />
        ) : (
          <DataTable
            caption={t("financeFx.conversion.title")}
            rows={data.conversions}
            rowKey={(r) => r.id}
            columns={[
              { key: "date", header: t("financeFx.conversion.date"), primary: true, render: (r) => formatIsoDate(r.occurredOn, locale) },
              { key: "sold", header: t("financeFx.conversion.sold"), align: "end", render: (r) => formatMoney(r.soldAmount, r.soldCurrency, locale) },
              { key: "bought", header: t("financeFx.conversion.bought"), align: "end", render: (r) => formatMoney(r.boughtAmount, r.boughtCurrency, locale) },
              {
                key: "expected",
                header: t("financeFx.conversion.expected"),
                align: "end",
                hideOnMobile: true,
                render: (r) => (r.expected ? formatMoney(r.expected, r.boughtCurrency, locale) : t(financeLabelKeys.rate("none"))),
              },
              {
                key: "difference",
                header: t("financeFx.conversion.difference"),
                align: "end",
                render: (r) => (r.difference === null ? "—" : signed(r.difference, r.boughtCurrency, locale)),
              },
              {
                key: "state",
                header: t("financeFx.conversion.state"),
                render: (r) => (
                  <Badge size="sm" tone={r.status === "voided" ? "neutral" : "strong"}>
                    {t(`financeFx.conversion.status.${r.status}`)}
                  </Badge>
                ),
              },
              {
                key: "void",
                header: t("financeFx.conversion.void"),
                render: (r) =>
                  r.status === "voided" ? (
                    "—"
                  ) : (
                    <Form method="post" preventScrollReset>
                      <input type="hidden" name="intent" value="voidConversion" />
                      <input type="hidden" name="id" value={r.id} />
                      <input type="hidden" name="expectedVersion" value={r.version} />
                      <Stack gap={2}>
                        <TextField label={t("financeFx.conversion.voidReason")} name="reason" required maxLength={300} />
                        <ConfirmSubmitButton
                          title={t("financeFx.conversion.voidTitle")}
                          message={t("financeFx.conversion.voidMessage")}
                          confirmLabel={t("financeFx.conversion.void")}
                          cancelLabel={t("common.cancel")}
                          confirmVariant="critical"
                          variant="secondary"
                          size="sm"
                        >
                          {t("financeFx.conversion.void")}
                        </ConfirmSubmitButton>
                      </Stack>
                    </Form>
                  ),
              },
            ]}
          />
        )}
      </Stack>
    </Card>
  );
}

function nbuStatusText(status: string | null, t: TFunction): string {
  if (!status) return "—";
  const kind = status === "ok" || status === "empty" ? status : "error";
  return t(`financeFx.nbu.status.${kind}`, { code: status.replace(/^error:/, "") });
}

function NbuCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const n = data.nbu;
  const active = n.available && n.enabled;
  const options = data.rateCurrencyOptions.map((c) => ({ value: c, label: c }));
  return (
    <Card id="nbu" title={t("financeFx.nbu.title")} description={t("financeFx.nbu.description")}>
      <Stack gap={4}>
        {!n.available ? <Banner tone="info">{t("financeFx.nbu.demo")}</Banner> : null}
        <Stack gap={1}>
          <Text weight="semibold">{n.enabled ? t("financeFx.nbu.enabled") : t("financeFx.nbu.disabled")}</Text>
          {n.enabled ? <Text tone="subdued">{n.autoFetch ? t("financeFx.nbu.autoFetchOn") : t("financeFx.nbu.autoFetchOff")}</Text> : null}
          <Text tone="subdued">
            {n.lastFetchedAt ? t("financeFx.nbu.lastFetch", { at: formatDateTime(n.lastFetchedAt, locale), status: nbuStatusText(n.lastStatus, t) }) : t("financeFx.nbu.never")}
          </Text>
          {n.latestNbuDate ? <Text tone="subdued">{t("financeFx.nbu.latest", { date: formatIsoDate(n.latestNbuDate, locale) })}</Text> : null}
          {n.pendingJobs > 0 ? <Text tone="subdued">{t("financeFx.nbu.pending", { n: n.pendingJobs })}</Text> : null}
        </Stack>
        {n.available ? (
          <Form method="post" preventScrollReset>
            <input type="hidden" name="intent" value="nbuToggle" />
            <input type="hidden" name="enabled" value={n.enabled ? "false" : "true"} />
            <FormLayout>
              <TextField label={t("financeFx.nbu.toggleReason")} name="reason" maxLength={300} />
              <div>
                <Button type="submit" variant={n.enabled ? "secondary" : "primary"}>
                  {n.enabled ? t("financeFx.nbu.toggleOff") : t("financeFx.nbu.toggleOn")}
                </Button>
              </div>
            </FormLayout>
          </Form>
        ) : null}
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="nbuFetch" />
          <Stack gap={1}>
            <div>
              <Button type="submit" variant="secondary" disabled={!active}>
                {t("financeFx.nbu.fetchNow")}
              </Button>
            </div>
            {!active ? (
              <Text variant="body-sm" tone="subdued">
                {n.available ? t("financeFx.nbu.disabledHint") : t("financeFx.error.demoNoNbu")}
              </Text>
            ) : null}
          </Stack>
        </Form>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value="nbuBackfill" />
          <FormLayout>
            <Text variant="heading-sm">{t("financeFx.nbu.backfillTitle")}</Text>
            <Text variant="body-sm" tone="subdued">
              {t("financeFx.nbu.backfillHelp", { years: NBU_BACKFILL_MAX_YEARS, date: formatIsoDate(NBU_BACKFILL_EARLIEST, locale) })}
            </Text>
            <Grid columns={{ xs: 1, md: 3 }} gap={3}>
              <Select label={t("financeFx.manual.currency")} name="currency" defaultValue={options[0]?.value} options={options} disabled={!active} />
              <TextField label={t("financeFx.table.from")} name="from" type="date" defaultValue={addDays(data.today, -30)} min={NBU_BACKFILL_EARLIEST} disabled={!active} />
              <TextField label={t("financeFx.table.to")} name="to" type="date" defaultValue={data.today} disabled={!active} />
            </Grid>
            <div>
              <Button type="submit" variant="secondary" disabled={!active}>
                {t("financeFx.nbu.backfillSubmit")}
              </Button>
            </div>
          </FormLayout>
        </Form>
        <Text variant="body-sm" tone="subdued">
          <a className="ot-link" href={href("/finance/settings")}>
            {t("financeFx.nbu.settingsLink")}
          </a>
        </Text>
      </Stack>
    </Card>
  );
}

function CheckoutCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const c = data.checkout;
  return (
    <Card title={t("financeFx.checkout.title")} description={t("financeFx.checkout.description")}>
      <Stack gap={2}>
        <Text tone="subdued">{c.enabled ? t("financeFx.checkout.on") : t("financeFx.checkout.off")}</Text>
        {c.rates.length === 0 ? (
          <Text tone="subdued">{t("financeFx.checkout.empty")}</Text>
        ) : (
          <Stack as="ul" gap={1}>
            {c.rates.map((r) => (
              <li key={r.currency}>{t("financeFx.checkout.row", { currency: r.currency, rate: formatRate(r.rate, locale), base: c.baseCurrency })}</li>
            ))}
          </Stack>
        )}
        <Text variant="body-sm">
          <a className="ot-link" href={href("/settings")}>
            {t("financeFx.checkout.link")}
          </a>
        </Text>
      </Stack>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

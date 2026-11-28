/**
 * Етап 6, WP7: «Фінанси → Партнери» (docs/stage6-design.md §9, §18.6). Маршрут …/finance/partners (app/routes.ts).
 * Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router); кожен сервіс ще раз перевіряє requireFinance.
 *
 * Список: партнер, тип, коди, відсоток, замовлень (оформлено в періоді), нараховано, очікується, до виплати, виплачено,
 * баланс (від'ємний — «Партнер винен»); «Неоднозначні атрибуції» з «Обрати партнера»; «Додати партнера» (ім'я, тип,
 * відсоток, днів утримання, коди: вид + код). Суми — у валюті комісії (валюта магазину), десяткові рядки; відсутнє — «—»,
 * ніколи не 0. Порожня база — «Немає партнерів».
 */
import { Form, Link, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { PeriodBar } from "~/components/finance/period-bar";
import { useHref } from "~/components/shell";
import { PARTNER_CODE_SOURCES, PARTNER_KINDS, QUICK_CURRENCIES } from "~/domain/finance";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { formatIsoDate, formatMoney } from "~/lib/format";
import { businessDate } from "~/lib/periods";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getFinanceSettings } from "~/modules/finance/core/settings.server";
import { bpToPercent, parsePercentBp } from "~/modules/partners/input";
import { createPartner, listPartners, setOrderAttribution, type PartnerListItem } from "~/modules/partners/partners.server";
import { partnerPeriodOf } from "~/modules/partners/period";
import { formatRateBp, moneyList } from "~/modules/partners/display";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import { Badge, Banner, Button, Card, DataTable, EmptyState, FormLayout, Grid, Select, Stack, Text, TextField, Page } from "~/ui";

/** Скільки рядків кодів у формі «Додати партнера». */
const NEW_CODE_ROWS = 3;

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const sp = new URL(request.url).searchParams;
  const today = businessDate(ctx.now());
  const period = partnerPeriodOf(sp, today);
  const includeArchived = sp.get("archived") === "1";
  const { value: settings } = await getFinanceSettings(ctx);
  const { partners, ambiguous } = await listPartners(ctx, { range: period.range, includeArchived });
  return {
    demo: ctx.mode === "demo",
    today,
    period,
    includeArchived,
    defaults: { rate: bpToPercent(settings.partners.defaultRateBp), holdDays: settings.partners.holdDays },
    partners,
    ambiguous,
  };
}

type PartnersActionResult = ActionResult & { intent?: string };

export async function action({ request }: ActionFunctionArgs): Promise<PartnersActionResult> {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  let intent = "";
  try {
    const form = await request.formData();
    intent = formString(form, "intent");
    if (intent === "createPartner") {
      const rateBp = parsePercentBp(formString(form, "rate"));
      if (rateBp === null) return { ok: false, error: "partners.error.rateInvalid", intent };
      const codes = Array.from({ length: NEW_CODE_ROWS }, (_, i) => ({ source: formString(form, `codeSource${i}`), code: formString(form, `code${i}`) })).filter(
        (c) => c.code.trim() !== "",
      );
      const r = await createPartner(ctx, {
        displayName: formString(form, "displayName"),
        kind: formString(form, "kind"),
        rateBp,
        holdDays: formString(form, "holdDays"),
        payoutCurrency: formString(form, "payoutCurrency") || null,
        note: formString(form, "note") || null,
        codes,
      });
      const extra = [...(r.attributed > 0 ? ["partners.result.attributed"] : []), ...(r.reusedCodes > 0 ? ["partners.result.codesReused"] : [])];
      return { ok: true, message: "partners.result.created", params: { n: r.attributed, reused: r.reusedCodes }, ...(extra.length ? { extra } : {}), intent };
    }
    if (intent === "chooseAttribution") {
      const partnerId = formString(form, "partnerId");
      const r = await setOrderAttribution(ctx, {
        orderId: formString(form, "orderId"),
        mode: "manual",
        partnerId: partnerId || null,
        reason: formString(form, "reason"),
      });
      return { ok: true, message: r.status === "attributed" ? "partners.result.attributionSet" : "partners.result.attributionRemoved", intent };
    }
    return { ok: false, error: "error.generic", intent };
  } catch (e) {
    return { ...toActionError(e), intent };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

export default function FinancePartnersPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  return (
    <Page title={t(financeLabelKeys.tab("partners"))} subtitle={t("partners.subtitle")}>
      <Stack gap={4}>
        <FinanceTabs current="partners" />
        {data.demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <ActionBanner data={actionData} />
        <Card>
          <Stack gap={3}>
            <PeriodBar preset={data.period.preset} range={data.period.range} granularity="month" compare="none" allowCustom />
            <Text variant="body-sm" tone="subdued">
              {t("partners.list.period", { from: formatIsoDate(data.period.range.from, locale), to: formatIsoDate(data.period.range.to, locale) })}
            </Text>
          </Stack>
        </Card>
        <AmbiguousCard data={data} t={t} locale={locale} />
        <PartnersTable data={data} t={t} locale={locale} />
        <CreatePartnerCard data={data} t={t} />
      </Stack>
    </Page>
  );
}

interface SectionProps {
  data: Data;
  t: TFunction;
  locale: Locale;
}

function AmbiguousCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  if (data.ambiguous.length === 0) return null;
  const all = data.partners.map((p) => ({ value: p.id, label: p.displayName }));
  return (
    <Card title={t("partners.ambiguous.title")} description={t("partners.ambiguous.description")}>
      <Stack gap={3}>
        {data.ambiguous.map((a) => (
          <Form method="post" key={a.orderId} preventScrollReset>
            <input type="hidden" name="intent" value="chooseAttribution" />
            <input type="hidden" name="orderId" value={a.orderId} />
            <Stack gap={2}>
              <Text weight="semibold">
                <Link className="ot-link" to={href(`/orders/${a.orderId}`)}>
                  {a.orderNumber}
                </Link>{" "}
                · {formatIsoDate(a.placedOn, locale)} · {t("partners.ambiguous.codes", { codes: a.codes.join(", ") || "—" })}
              </Text>
              <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                <Select
                  label={t("partners.ambiguous.choose")}
                  name="partnerId"
                  defaultValue={a.candidates[0]?.id ?? ""}
                  options={[
                    ...a.candidates.map((c) => ({ value: c.id, label: t("partners.ambiguous.candidate", { name: c.displayName }) })),
                    ...all.filter((o) => !a.candidates.some((c) => c.id === o.value)),
                    { value: "", label: t("partners.ambiguous.none") },
                  ]}
                />
                <TextField label={t("partners.field.reason")} name="reason" required maxLength={300} />
                <div>
                  <Button type="submit" variant="primary">
                    {t("partners.ambiguous.submit")}
                  </Button>
                </div>
              </Grid>
            </Stack>
          </Form>
        ))}
      </Stack>
    </Card>
  );
}

function ledgerCell(p: PartnerListItem, field: "accrued" | "payable" | "paid", locale: Locale, t: TFunction): string {
  if (p.ledger.length === 0) return t("partners.list.noCommissions");
  return p.ledger.map((l) => formatMoney(l[field], l.currency, locale)).join(" · ");
}

function BalanceCell({ p, t, locale }: { p: PartnerListItem; t: TFunction; locale: Locale }) {
  if (p.ledger.length === 0) return <Text as="span" tone="subdued">—</Text>;
  return (
    <Stack gap={1}>
      {p.ledger.map((l) => (
        <Text as="span" key={l.currency} tone={l.owes !== "0.00" ? "critical" : "default"} numeric>
          {formatMoney(l.balance, l.currency, locale)}
          {l.owes !== "0.00" ? ` · ${t("partners.balance.owesShort")}` : ""}
        </Text>
      ))}
    </Stack>
  );
}

function PartnersTable({ data, t, locale }: SectionProps) {
  const href = useHref();
  return (
    <Card
      title={t("partners.list.title")}
      padded={false}
      actions={
        <Link className="ot-link" to={href(`/finance/partners?archived=${data.includeArchived ? "0" : "1"}`)}>
          {t(data.includeArchived ? "partners.list.hideArchived" : "partners.list.showArchived")}
        </Link>
      }
    >
      <DataTable<PartnerListItem>
        caption={t("partners.list.title")}
        rows={data.partners}
        rowKey={(p) => p.id}
        rowHref={(p) => href(`/finance/partners/${p.id}`)}
        emptyState={<EmptyState title={t("partners.list.empty")} description={t("partners.list.emptyHelp")} />}
        columns={[
          {
            key: "name",
            header: t("partners.list.partner"),
            primary: true,
            render: (p) => (
              <Stack gap={1}>
                <Text as="span" weight="semibold">
                  {p.displayName}
                </Text>
                {p.status !== "active" ? (
                  <span>
                    <Badge size="sm" tone="outline">
                      {t(`partners.status.${p.status}`)}
                    </Badge>
                  </span>
                ) : null}
              </Stack>
            ),
          },
          { key: "kind", header: t("partners.list.kind"), render: (p) => t(`partners.kind.${p.kind}`) },
          {
            key: "codes",
            header: t("partners.list.codes"),
            render: (p) => {
              const active = p.codes.filter((c) => c.active);
              return active.length ? active.map((c) => `${c.code} (${t(`partners.source.${c.source}`)})`).join(", ") : "—";
            },
          },
          { key: "rate", header: t("partners.list.rate"), align: "end", render: (p) => formatRateBp(p.rateBp, locale) },
          { key: "orders", header: t("partners.list.orders"), align: "end", render: (p) => String(p.ordersInPeriod) },
          { key: "accrued", header: t("partners.list.accrued"), align: "end", render: (p) => ledgerCell(p, "accrued", locale, t) },
          { key: "expected", header: t("partners.list.expected"), align: "end", render: (p) => moneyList(p.expected, locale) },
          { key: "payable", header: t("partners.list.payable"), align: "end", render: (p) => ledgerCell(p, "payable", locale, t) },
          { key: "paid", header: t("partners.list.paid"), align: "end", render: (p) => ledgerCell(p, "paid", locale, t) },
          { key: "balance", header: t("partners.list.balance"), align: "end", render: (p) => <BalanceCell p={p} t={t} locale={locale} /> },
        ]}
      />
    </Card>
  );
}

function CreatePartnerCard({ data, t }: { data: Data; t: TFunction }) {
  const nav = useNavigation();
  const busy = nav.state === "submitting" && nav.formData?.get("intent") === "createPartner";
  return (
    <Card title={t("partners.create.title")} description={t("partners.create.description")} id="create-partner">
      <Form method="post" preventScrollReset>
        <input type="hidden" name="intent" value="createPartner" />
        <Stack gap={4}>
          <FormLayout columns={2}>
            <TextField label={t("partners.field.name")} name="displayName" required maxLength={120} autoComplete="off" helpText={t("partners.field.nameHelp")} />
            <Select label={t("partners.field.kind")} name="kind" defaultValue="blogger" options={PARTNER_KINDS.map((k) => ({ value: k, label: t(`partners.kind.${k}`) }))} />
            <TextField label={t("partners.field.rate")} name="rate" required defaultValue={data.defaults.rate} inputMode="decimal" suffix="%" helpText={t("partners.field.rateHelp")} />
            <TextField label={t("partners.field.holdDays")} name="holdDays" required type="number" min={0} max={365} defaultValue={data.defaults.holdDays} helpText={t("partners.field.holdDaysHelp")} />
            <Select
              label={t("partners.field.payoutCurrency")}
              name="payoutCurrency"
              defaultValue=""
              options={[{ value: "", label: t("partners.field.payoutCurrencyAuto") }, ...QUICK_CURRENCIES.map((c) => ({ value: c, label: c }))]}
            />
            <TextField label={t("partners.field.note")} name="note" maxLength={300} />
          </FormLayout>
          <Stack gap={2}>
            <Text weight="semibold">{t("partners.create.codes")}</Text>
            <Text variant="body-sm" tone="subdued">
              {t("partners.create.codesHelp")}
            </Text>
            {Array.from({ length: NEW_CODE_ROWS }, (_, i) => (
              <Grid key={i} columns={{ xs: 1, md: 2 }} gap={3}>
                <Select
                  label={t("partners.field.codeSource")}
                  name={`codeSource${i}`}
                  defaultValue="discount_code"
                  options={PARTNER_CODE_SOURCES.map((s) => ({ value: s, label: t(`partners.source.${s}`) }))}
                />
                <TextField label={t("partners.field.code")} name={`code${i}`} maxLength={64} autoComplete="off" spellCheck={false} autoCapitalize="characters" />
              </Grid>
            ))}
          </Stack>
          <div>
            <Button type="submit" variant="primary" loading={busy}>
              {t("partners.create.submit")}
            </Button>
          </div>
        </Stack>
      </Form>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

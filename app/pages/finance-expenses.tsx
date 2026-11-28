/**
 * Етап 6, WP6: «Фінанси → Витрати» (docs/stage6-design.md §10, §8.1, §18.2, §18.8). Маршрут …/finance/expenses.
 * Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router). Кожен сервіс ще раз перевіряє requireFinance.
 *
 * Розділи: попередження про подвійний облік (§10.3) · «Додати витрату» / «Додати дохід» / «Виправити» (одна колонка на
 * телефоні; «Одна дата / Період»; «замінює прогноз» або «окрема» з причиною; попередження про виробничі витрати) ·
 * список за місяцем і категорією (телефон — картки) · деталі витрати (частки розподілу, «Перерахувати розподіл»,
 * анулювання з причиною, історія) · правила комісій шлюзів (незмінні рядки) · прогноз vs факт комісій за 3 місяці.
 * Порожня база — «Немає даних». Суми — десяткові рядки через app/lib/format.ts; відсутнє — «—», ніколи не 0.
 *
 * Посилання з інших розділів — форма відкривається з цими полями:
 * - WP9 «Витрата на повернення»: `?add=expense&category=return_shipping_cost|return_handling&order=<номер або id>&returnId=<id>#expense-form`;
 * - WP7 «Додати фіксовану оплату» (сторінка партнера): `?add=expense&category=partner_fixed_fee&partnerId=<id>#expense-form`
 *   (партнер — лише зі списку форми).
 */
import { Form, useActionData, useLoaderData, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { useHref } from "~/components/shell";
import { EXPENSE_CATEGORIES, EXPENSE_CHANNELS, FEE_RULE_KINDS, type ExpenseCategory } from "~/domain/finance";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { Locale } from "~/i18n/types";
import { formatDateTime, formatIsoDate, formatMoney } from "~/lib/format";
import { addMonths, businessDate, monthStart, parseIsoDate } from "~/lib/periods";
import {
  carrierCodeOptions,
  coverageWarnings,
  createExpense,
  getExpense,
  listExpenses,
  orderForExpenseForm,
  partnerOptions,
  recalculateAllocation,
  replaceExpense,
  voidExpense,
  type ExpenseDetail,
  type ExpenseInput,
  type ExpenseListItem,
} from "~/modules/expenses/expenses.server";
import { monthLabel } from "~/modules/expenses/display";
import { endFeeRule, feeForecastVsActual, listFeeRules, listSeenGateways, saveFeeRule } from "~/modules/expenses/fee-rules.server";
import { FORM_EXPENSE_CATEGORIES, FORM_INCOME_CATEGORIES, orderRuleOf } from "~/modules/expenses/rules";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getFinanceSettings } from "~/modules/finance/core/settings.server";
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
  Pagination,
  Select,
  Stack,
  Text,
  TextField,
} from "~/ui";

const PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MONTH_OPTIONS = 24;

function monthParam(raw: string | null, today: string): string {
  const v = (raw ?? "").trim();
  const m = /^(\d{4})-(\d{2})$/.exec(v) ? `${v}-01` : v;
  const iso = parseIsoDate(m);
  return iso ? monthStart(iso) : monthStart(today);
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const sp = new URL(request.url).searchParams;
  const today = businessDate(ctx.now());
  const month = monthParam(sp.get("month"), today);
  // Фільтр списку — `cat`; `category` — лише поле форми, заповнене посиланням (`?add=expense&category=…`).
  const category = (EXPENSE_CATEGORIES as readonly string[]).includes(sp.get("cat") ?? "") ? sp.get("cat") : null;
  const statusParam = sp.get("status");
  const status = statusParam === "voided" || statusParam === "all" ? statusParam : "active";
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "1", 10) || 1);
  const detailId = UUID_RE.test(sp.get("expense") ?? "") ? sp.get("expense")! : null;
  const editId = UUID_RE.test(sp.get("edit") ?? "") ? sp.get("edit")! : null;
  const add = sp.get("add") === "income" ? "income" : sp.get("add") === "expense" ? "expense" : null;
  const prefillOrderRef = (sp.get("order") ?? "").trim().slice(0, 64);
  const prefillCategory =
    (add || prefillOrderRef) && (EXPENSE_CATEGORIES as readonly string[]).includes(sp.get("category") ?? "") ? (sp.get("category") as ExpenseCategory) : null;
  const prefillReturnId = UUID_RE.test(sp.get("returnId") ?? "") ? sp.get("returnId")! : null;
  const partnerParam = UUID_RE.test(sp.get("partnerId") ?? "") ? sp.get("partnerId")!.toLowerCase() : null;
  const { value: settings } = await getFinanceSettings(ctx);
  const safe = async <T,>(p: Promise<T>): Promise<T | null> => {
    try {
      return await p;
    } catch (e) {
      if (e instanceof Response) throw e;
      return null;
    }
  };
  const [list, warnings, rules, gateways, comparison, partners, carriers, detail, edit, prefillOrder] = await Promise.all([
    listExpenses(ctx, { month, category, status, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    coverageWarnings(ctx, month),
    listFeeRules(ctx),
    listSeenGateways(ctx),
    feeForecastVsActual(ctx, { months: 3 }),
    partnerOptions(ctx),
    carrierCodeOptions(ctx),
    detailId ? safe(getExpense(ctx, detailId)) : null,
    editId ? safe(getExpense(ctx, editId)) : null,
    prefillOrderRef ? orderForExpenseForm(ctx, prefillOrderRef) : null,
  ]);
  const months = Array.from({ length: MONTH_OPTIONS }, (_v, i) => addMonths(monthStart(today), -i));
  // WP7 «Додати фіксовану оплату» (сторінка партнера): ?add=expense&category=partner_fixed_fee&partnerId=<id> — лише
  // партнер зі списку форми (діючий або призупинений).
  const prefillPartnerId = partnerParam && partners.some((p) => p.id.toLowerCase() === partnerParam) ? partners.find((p) => p.id.toLowerCase() === partnerParam)!.id : null;
  return {
    demo: ctx.mode === "demo",
    today,
    month,
    months,
    filter: { category, status, page },
    list,
    warnings,
    rules,
    gateways,
    comparison,
    partners,
    carriers,
    detail,
    edit: edit && edit.status === "active" ? edit : null,
    add: add ?? (prefillCategory || prefillOrder ? "expense" : null),
    prefill: { category: prefillCategory, order: prefillOrder, orderRef: prefillOrderRef, returnId: prefillReturnId, partnerId: prefillPartnerId },
    currencies: [...new Set([settings.reportingCurrency, ...settings.displayCurrencies])],
    reportingCurrency: settings.reportingCurrency,
    operationId: globalThis.crypto.randomUUID(),
  };
}

type ExpensesActionResult = ActionResult & { intent?: string; nextOperationId?: string };

function localizedError(e: unknown, locale: Locale): ActionResult {
  const r = toActionError(e);
  if (r.error === "error.notFound") return { ok: false, error: "financeExpenses.error.notFound" };
  if (!r.params) return r;
  const params: Record<string, string | number> = { ...r.params };
  if (typeof params.date === "string" && parseIsoDate(params.date)) params.date = formatIsoDate(params.date, locale);
  // Місяць (finance.error.monthClosed) форматує централізовано localizeParams (ActionBanner).
  return { ...r, params };
}

function expenseInput(form: FormData): ExpenseInput {
  const coverage = formString(form, "coverage");
  return {
    operationId: formString(form, "operationId"),
    category: formString(form, "category"),
    amount: formString(form, "amount"),
    currency: formString(form, "currencyOther").trim() || formString(form, "currency"),
    dateMode: formString(form, "dateMode") === "period" ? "period" : "single",
    expenseDate: formString(form, "expenseDate"),
    periodFrom: formString(form, "periodFrom"),
    periodTo: formString(form, "periodTo"),
    description: formString(form, "description"),
    channel: formString(form, "channel"),
    gateway: formString(form, "gateway"),
    carrierCode: formString(form, "carrierCode"),
    partnerId: formString(form, "partnerId"),
    order: formString(form, "order"),
    returnId: formString(form, "returnId"),
    document: formString(form, "document"),
    coverage: coverage === "separate" ? "separate" : coverage === "covers" ? "covers" : null,
    separateReason: formString(form, "separateReason"),
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<ExpensesActionResult> {
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
    if (intent === "create") {
      const r = await createExpense(ctx, expenseInput(form));
      if (r.duplicate) return { ok: true, tone: "info", message: "financeExpenses.result.duplicate", intent, nextOperationId };
      const extra = [
        ...(r.allocatedOrders !== null && r.allocatedOrders > 0 ? ["financeExpenses.result.allocated"] : []),
        ...(r.allocatedOrders === 0 ? ["financeExpenses.result.noCandidates"] : []),
        ...(r.coverageNote === "no_dimension" ? ["financeExpenses.result.noDimension"] : []),
        ...(r.coverageNote === "credit" ? ["financeExpenses.result.credit"] : []),
        ...(r.awaiting > 0 ? ["financeExpenses.result.awaiting"] : []),
      ];
      return { ok: true, message: "financeExpenses.result.created", params: { entries: r.posted, orders: r.allocatedOrders ?? 0, awaiting: r.awaiting }, ...(extra.length ? { extra } : {}), intent, nextOperationId };
    }
    if (intent === "replace") {
      const r = await replaceExpense(ctx, { ...expenseInput(form), expenseId: formString(form, "expenseId"), expectedVersion: version("expectedVersion"), reason: formString(form, "reason") });
      if (r.duplicate) return { ok: true, tone: "info", message: "financeExpenses.result.duplicate", intent, nextOperationId };
      const extra = [
        ...(r.coverageNote === "no_dimension" ? ["financeExpenses.result.noDimension"] : []),
        ...(r.coverageNote === "credit" ? ["financeExpenses.result.credit"] : []),
      ];
      return { ok: true, message: "financeExpenses.result.replaced", params: { reversed: r.reversed, entries: r.posted }, ...(extra.length ? { extra } : {}), intent, nextOperationId };
    }
    if (intent === "void") {
      const r = await voidExpense(ctx, { expenseId: formString(form, "expenseId"), reason: formString(form, "reason"), expectedVersion: version("expectedVersion") });
      return { ok: true, tone: r.voided ? "success" : "info", message: r.voided ? "financeExpenses.result.voided" : "financeExpenses.result.alreadyVoided", params: { reversed: r.reversed }, intent, nextOperationId };
    }
    if (intent === "recalc") {
      const r = await recalculateAllocation(ctx, { expenseId: formString(form, "expenseId"), expectedVersion: version("expectedVersion") });
      return { ok: true, tone: r.changed ? "success" : "info", message: r.changed ? "financeExpenses.result.recalculated" : "financeExpenses.result.recalcUnchanged", params: { orders: r.allocatedOrders, version: r.version }, intent, nextOperationId };
    }
    if (intent === "feeRule") {
      const r = await saveFeeRule(ctx, {
        gateway: formString(form, "gatewayOther").trim() || formString(form, "gateway"),
        kind: formString(form, "kind"),
        percent: formString(form, "percent"),
        fixedAmount: formString(form, "fixedAmount"),
        fixedCurrency: formString(form, "fixedCurrency"),
        noFees: form.has("noFees"),
        appliesFrom: formString(form, "appliesFrom"),
        reason: formString(form, "reason"),
      });
      if (r.duplicate) return { ok: true, tone: "info", message: "financeExpenses.result.feeRuleDuplicate", intent, nextOperationId };
      return { ok: true, message: r.closedRuleId ? "financeExpenses.result.feeRuleReplaced" : "financeExpenses.result.feeRuleSaved", params: { orders: r.resynced }, intent, nextOperationId };
    }
    if (intent === "feeRuleEnd") {
      const r = await endFeeRule(ctx, { ruleId: formString(form, "ruleId"), appliesTo: formString(form, "appliesTo"), reason: formString(form, "reason") });
      return { ok: true, tone: r.ended ? "success" : "info", message: r.ended ? "financeExpenses.result.feeRuleEnded" : "financeExpenses.result.feeRuleUnchanged", intent, nextOperationId };
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

const catLabel = (t: TFunction, c: string) => t(financeLabelKeys.category(c as ExpenseCategory));

function dateText(e: Pick<ExpenseListItem, "expenseDate" | "periodFrom" | "periodTo">, locale: Locale): string {
  if (e.periodFrom && e.periodTo) return `${formatIsoDate(e.periodFrom, locale)} – ${formatIsoDate(e.periodTo, locale)}`;
  return formatIsoDate(e.expenseDate, locale);
}

export default function FinanceExpensesPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const operationId = actionData?.ok && actionData.nextOperationId ? actionData.nextOperationId : data.operationId;
  return (
    <Page title={t(financeLabelKeys.tab("expenses"))} subtitle={t("financeExpenses.subtitle")}>
      <Stack gap={4}>
        <FinanceTabs current="expenses" />
        {data.demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <ActionBanner data={actionData} />
        <WarningsCard data={data} t={t} locale={locale} />
        <ExpenseFormCard data={data} t={t} locale={locale} operationId={operationId} />
        {data.detail ? <DetailCard data={data} t={t} locale={locale} detail={data.detail} /> : null}
        <ListCard data={data} t={t} locale={locale} />
        <FeeRulesCard data={data} t={t} locale={locale} />
        <ComparisonCard data={data} t={t} locale={locale} />
      </Stack>
    </Page>
  );
}

function WarningsCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const { stale, periodTotals, packaging } = data.warnings;
  if (stale.length === 0 && periodTotals.length === 0 && !packaging) return null;
  return (
    <Stack gap={2}>
      {packaging ? (
        <Banner tone="warning" title={t("financeExpenses.warning.packagingTitle")}>
          <p>{t("financeExpenses.warning.packagingText", { orders: packaging.ordersWithForecast, month: monthLabel(packaging.month, locale) })}</p>
          <p>
            <a className="ot-link" href={href(`/finance/periods?month=${packaging.month}#month`)}>
              {t("financeExpenses.warning.packagingAction")}
            </a>
          </p>
        </Banner>
      ) : null}
      {stale.length > 0 ? (
        <Banner tone="warning" title={t("financeExpenses.warning.staleTitle")}>
          <p>{t("financeExpenses.warning.staleText", { month: monthLabel(data.month, locale) })}</p>
          <ul>
            {stale.map((s) => (
              <li key={s.expenseId}>
                <a className="ot-link" href={href(`/finance/expenses?month=${data.month}&expense=${s.expenseId}#expense-detail`)}>
                  {catLabel(t, s.category)}
                </a>{" "}
                — {t("financeExpenses.warning.staleRow", { current: s.current, next: s.next })}
              </li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {periodTotals.length > 0 ? (
        <Banner tone="info" title={t("financeExpenses.warning.periodTotalTitle")}>
          <p>{t("financeExpenses.warning.periodTotalText")}</p>
        </Banner>
      ) : null}
    </Stack>
  );
}

const CATEGORY_HINTS: ReadonlyArray<ExpenseCategory> = ["advertising", "platform_fees", "payment_fees", "return_shipping_cost", "return_handling", "partner_fixed_fee", "taxes_company", "fx_difference"];

function ExpenseFormCard({ data, t, locale, operationId }: SectionProps & { operationId: string }) {
  const edit = data.edit;
  const kind = edit ? ((FORM_INCOME_CATEGORIES as readonly string[]).includes(edit.category) ? "income" : "expense") : data.add === "income" ? "income" : "expense";
  const categories = kind === "income" ? FORM_INCOME_CATEGORIES : FORM_EXPENSE_CATEGORIES;
  const href = useHref();
  const defaultCategory = edit?.category ?? data.prefill.category ?? categories[0]!;
  const currencyOptions = data.currencies.map((c) => ({ value: c, label: c }));
  const currency = edit?.currency ?? data.currencies[0] ?? "UAH";
  const knownCurrency = data.currencies.includes(currency);
  const orderRef = edit?.order?.number ?? data.prefill.order?.orderNumber ?? data.prefill.orderRef;
  const returns = data.prefill.order?.returns ?? [];
  const open = Boolean(edit) || data.add !== null;
  const title = edit ? t("financeExpenses.form.editTitle") : kind === "income" ? t("financeExpenses.form.addIncome") : t("financeExpenses.form.addExpense");
  return (
    <Card
      id="expense-form"
      title={title}
      description={edit ? t("financeExpenses.form.editDescription") : t("financeExpenses.form.description")}
      actions={
        edit ? null : (
          <Stack direction="horizontal" gap={2}>
            <Button variant={kind === "expense" ? "primary" : "secondary"} size="sm" to={href(`/finance/expenses?month=${data.month}&add=expense#expense-form`)}>
              {t("financeExpenses.form.addExpense")}
            </Button>
            <Button variant={kind === "income" ? "primary" : "secondary"} size="sm" to={href(`/finance/expenses?month=${data.month}&add=income#expense-form`)}>
              {t("financeExpenses.form.addIncome")}
            </Button>
          </Stack>
        )
      }
    >
      <Disclosure summary={open ? t("financeExpenses.form.fields") : t("financeExpenses.form.open")} defaultOpen={open}>
        <Form method="post" preventScrollReset>
          <input type="hidden" name="intent" value={edit ? "replace" : "create"} />
          <input type="hidden" name="operationId" value={operationId} />
          {edit ? (
            <>
              <input type="hidden" name="expenseId" value={edit.id} />
              <input type="hidden" name="expectedVersion" value={edit.version} />
            </>
          ) : null}
          <Stack gap={4}>
            <Banner tone="info">{t("financeExpenses.form.productionWarning")}</Banner>
            <FormLayout columns={2}>
              <Select
                label={t("financeExpenses.field.category")}
                name="category"
                defaultValue={defaultCategory}
                options={categories.map((c) => ({ value: c, label: catLabel(t, c) }))}
                helpText={t("financeExpenses.field.categoryHelp")}
              />
              <TextField
                label={t("financeExpenses.field.amount")}
                name="amount"
                inputMode="decimal"
                required
                defaultValue={edit?.amount.replace(".", locale === "uk" ? "," : ".") ?? ""}
                helpText={kind === "income" ? t("financeExpenses.field.amountIncomeHelp") : t("financeExpenses.field.amountHelp")}
                maxLength={20}
              />
              <Select label={t("financeExpenses.field.currency")} name="currency" defaultValue={knownCurrency ? currency : data.currencies[0]} options={currencyOptions} />
              <TextField
                label={t("financeExpenses.field.currencyOther")}
                name="currencyOther"
                defaultValue={knownCurrency ? "" : currency}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                helpText={t("financeExpenses.field.currencyOtherHelp")}
              />
              <Select
                label={t("financeExpenses.field.dateMode")}
                name="dateMode"
                defaultValue={edit?.periodFrom ? "period" : "single"}
                options={[
                  { value: "single", label: t("financeExpenses.field.dateModeSingle") },
                  { value: "period", label: t("financeExpenses.field.dateModePeriod") },
                ]}
                helpText={t("financeExpenses.field.dateModeHelp")}
              />
              <TextField label={t("financeExpenses.field.expenseDate")} name="expenseDate" type="date" defaultValue={edit?.expenseDate ?? data.today} />
              <TextField label={t("financeExpenses.field.periodFrom")} name="periodFrom" type="date" defaultValue={edit?.periodFrom ?? ""} />
              <TextField label={t("financeExpenses.field.periodTo")} name="periodTo" type="date" defaultValue={edit?.periodTo ?? ""} />
              <TextField
                label={t("financeExpenses.field.order")}
                name="order"
                defaultValue={orderRef}
                maxLength={64}
                autoComplete="off"
                helpText={t("financeExpenses.field.orderHelp")}
              />
              {returns.length > 0 ? (
                <Select
                  label={t("financeExpenses.field.return")}
                  name="returnId"
                  defaultValue={data.prefill.returnId ?? edit?.returnId ?? ""}
                  options={[{ value: "", label: t("financeExpenses.field.returnNone") }, ...returns.map((r, i) => ({ value: r.id, label: t("financeExpenses.field.returnOption", { n: i + 1, id: r.id.slice(0, 8) }) }))]}
                />
              ) : (
                <input type="hidden" name="returnId" value={data.prefill.returnId ?? edit?.returnId ?? ""} />
              )}
              <Select
                label={t("financeExpenses.field.channel")}
                name="channel"
                defaultValue={edit?.channel ?? ""}
                options={[{ value: "", label: t("financeExpenses.field.none") }, ...EXPENSE_CHANNELS.map((c) => ({ value: c, label: t(`financeExpenses.channel.${c}`) }))]}
                helpText={t("financeExpenses.field.channelHelp")}
              />
              <TextField
                label={t("financeExpenses.field.gateway")}
                name="gateway"
                defaultValue={edit?.gateway ?? ""}
                maxLength={120}
                autoComplete="off"
                spellCheck={false}
                helpText={t("financeExpenses.field.gatewayHelp", { gateways: data.gateways.length ? data.gateways.join(", ") : "—" })}
              />
              <TextField
                label={t("financeExpenses.field.carrier")}
                name="carrierCode"
                defaultValue={edit?.carrierCode ?? ""}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                helpText={t("financeExpenses.field.carrierHelp", { carriers: data.carriers.length ? data.carriers.join(", ") : "—" })}
              />
              <Select
                label={t("financeExpenses.field.partner")}
                name="partnerId"
                defaultValue={edit?.partner?.id ?? data.prefill.partnerId ?? ""}
                options={[{ value: "", label: t("financeExpenses.field.none") }, ...data.partners.map((p) => ({ value: p.id, label: p.name }))]}
                helpText={t("financeExpenses.field.partnerHelp")}
              />
              <Select
                label={t("financeExpenses.field.coverage")}
                name="coverage"
                defaultValue={edit?.separateFromForecast ? "separate" : "covers"}
                options={[
                  { value: "covers", label: t("financeExpenses.field.coverageCovers") },
                  { value: "separate", label: t("financeExpenses.field.coverageSeparate") },
                ]}
                helpText={t("financeExpenses.field.coverageHelp")}
              />
              <TextField label={t("financeExpenses.field.separateReason")} name="separateReason" defaultValue={edit?.separateReason ?? ""} maxLength={300} helpText={t("financeExpenses.field.separateReasonHelp")} />
              <TextField label={t("financeExpenses.field.description")} name="description" defaultValue={edit?.description ?? ""} maxLength={200} multiline={2} helpText={t("financeExpenses.field.noPersonalData")} />
              <TextField label={t("financeExpenses.field.document")} name="document" defaultValue={edit?.document ?? ""} maxLength={100} helpText={t("financeExpenses.field.noPersonalData")} />
              {edit ? <TextField label={t("financeExpenses.field.reason")} name="reason" required maxLength={300} helpText={t("financeExpenses.field.reasonHelp")} /> : null}
            </FormLayout>
            <Disclosure summary={t("financeExpenses.form.hintsTitle")}>
              <ul>
                {CATEGORY_HINTS.map((c) => (
                  <li key={c}>
                    <strong>{catLabel(t, c)}</strong> — {t(`financeExpenses.hint.${c}`)}
                  </li>
                ))}
                <li>{t("financeExpenses.hint.orderRules", { required: categoriesByRule(t, "required"), forbidden: categoriesByRule(t, "forbidden") })}</li>
              </ul>
            </Disclosure>
            <Stack direction="horizontal" gap={2}>
              <Button type="submit" variant="primary">
                {edit ? t("financeExpenses.form.saveCorrection") : t("financeExpenses.form.save")}
              </Button>
              {edit ? (
                <Button variant="secondary" to={href(`/finance/expenses?month=${data.month}&expense=${edit.id}#expense-detail`)}>
                  {t("financeExpenses.form.cancel")}
                </Button>
              ) : null}
            </Stack>
          </Stack>
        </Form>
      </Disclosure>
    </Card>
  );
}

function categoriesByRule(t: TFunction, rule: "required" | "forbidden"): string {
  return FORM_EXPENSE_CATEGORIES.filter((c) => orderRuleOf(c) === rule)
    .map((c) => catLabel(t, c))
    .join(", ");
}

function coverageBadge(e: ExpenseListItem, t: TFunction) {
  if (e.coversForecast) {
    const a = e.allocation;
    return (
      <Badge size="sm" tone="info">
        {a && a.orders > 0 ? t("financeExpenses.coverage.allocated", { orders: a.withShare }) : t("financeExpenses.coverage.periodTotal")}
      </Badge>
    );
  }
  if (e.separateFromForecast) return <Badge size="sm" tone="outline">{t("financeExpenses.coverage.separate")}</Badge>;
  return null;
}

function dimensions(e: ExpenseListItem, t: TFunction): string {
  return [
    e.channel ? t(`financeExpenses.channel.${e.channel}`) : null,
    e.gateway,
    e.carrierCode,
    e.partner?.name ?? null,
    e.order ? t("financeExpenses.list.order", { number: e.order.number }) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ListCard({ data, t, locale }: SectionProps) {
  const href = useHref();
  const items = data.list.items;
  const totalPages = Math.max(1, Math.ceil(data.list.total / PAGE_SIZE));
  const pageHref = (p: number) => href(`/finance/expenses?month=${data.month}&status=${data.filter.status}${data.filter.category ? `&cat=${data.filter.category}` : ""}&page=${p}`);
  return (
    <Card title={t("financeExpenses.list.title")} description={t("financeExpenses.list.description")} padded={false}>
      <Stack gap={3}>
        <div className="ot-card__body">
          <Form method="get" preventScrollReset>
            <Grid columns={{ xs: 1, md: 4 }} gap={3}>
              <Select label={t("financeExpenses.filter.month")} name="month" defaultValue={data.month} options={data.months.map((m) => ({ value: m, label: monthLabel(m, locale) }))} />
              <Select
                label={t("financeExpenses.filter.category")}
                name="cat"
                defaultValue={data.filter.category ?? ""}
                options={[{ value: "", label: t("financeExpenses.filter.allCategories") }, ...EXPENSE_CATEGORIES.map((c) => ({ value: c, label: catLabel(t, c) }))]}
              />
              <Select
                label={t("financeExpenses.filter.status")}
                name="status"
                defaultValue={data.filter.status}
                options={[
                  { value: "active", label: t("financeExpenses.status.active") },
                  { value: "voided", label: t("financeExpenses.status.voided") },
                  { value: "all", label: t("financeExpenses.filter.allStatuses") },
                ]}
              />
              <div>
                <Button type="submit" variant="secondary">
                  {t("financeExpenses.filter.show")}
                </Button>
              </div>
            </Grid>
          </Form>
        </div>
        {items.length === 0 ? (
          <div className="ot-card__body">
            <EmptyState title={t("financeExpenses.noData")} description={t("financeExpenses.list.empty", { month: monthLabel(data.month, locale) })} />
          </div>
        ) : (
          <DataTable
            caption={t("financeExpenses.list.title")}
            rows={items}
            rowKey={(r) => r.id}
            columns={[
              {
                key: "category",
                header: t("financeExpenses.field.category"),
                primary: true,
                render: (r) => (
                  <Stack gap={1}>
                    <a className="ot-link" href={href(`/finance/expenses?month=${data.month}&expense=${r.id}#expense-detail`)}>
                      {catLabel(t, r.category)}
                    </a>
                    {dimensions(r, t) ? (
                      <Text as="span" variant="body-sm" tone="subdued">
                        {dimensions(r, t)}
                      </Text>
                    ) : null}
                    {r.description ? (
                      <Text as="span" variant="body-sm" tone="subdued">
                        {r.description}
                      </Text>
                    ) : null}
                  </Stack>
                ),
              },
              { key: "date", header: t("financeExpenses.list.date"), render: (r) => dateText(r, locale) },
              {
                key: "amount",
                header: t("financeExpenses.field.amount"),
                align: "end",
                render: (r) => (
                  <Stack gap={1}>
                    <Text as="span" weight="semibold">
                      {formatMoney(r.amount, r.currency, locale)}
                    </Text>
                    {r.amount.startsWith("-") ? (
                      <Text as="span" variant="body-sm" tone="subdued">
                        {t("financeExpenses.list.credit")}
                      </Text>
                    ) : null}
                  </Stack>
                ),
              },
              {
                key: "state",
                header: t("financeExpenses.list.state"),
                render: (r) => (
                  <Stack direction="horizontal" gap={1}>
                    <Badge size="sm" tone={r.status === "voided" ? "critical" : "neutral"}>
                      {t(`financeExpenses.status.${r.status}`)}
                    </Badge>
                    {coverageBadge(r, t)}
                    {r.awaitingOrder || (r.allocation?.awaiting ?? 0) > 0 ? (
                      <Badge size="sm" tone="warning">
                        {t("financeExpenses.list.awaiting")}
                      </Badge>
                    ) : null}
                    {r.supersedesId ? (
                      <Badge size="sm" tone="outline">
                        {t("financeExpenses.list.correction")}
                      </Badge>
                    ) : null}
                  </Stack>
                ),
              },
            ]}
          />
        )}
        {totalPages > 1 ? (
          <div className="ot-card__body">
            <Pagination
              prevHref={data.filter.page > 1 ? pageHref(data.filter.page - 1) : null}
              nextHref={data.filter.page < totalPages ? pageHref(data.filter.page + 1) : null}
              label={t("financeExpenses.list.page", { page: data.filter.page, pages: totalPages })}
              prevLabel={t("financeExpenses.list.prev")}
              nextLabel={t("financeExpenses.list.next")}
              ariaLabel={t("financeExpenses.list.pagination")}
            />
          </div>
        ) : null}
      </Stack>
    </Card>
  );
}

function DetailCard({ data, t, locale, detail }: SectionProps & { detail: ExpenseDetail }) {
  const href = useHref();
  const active = detail.status === "active";
  const batchOnly = detail.category === "inventory_loss";
  return (
    <Card id="expense-detail" title={t("financeExpenses.detail.title", { category: catLabel(t, detail.category) })}>
      <Stack gap={4}>
        <KeyValueList
          items={[
            { key: "amount", label: t("financeExpenses.field.amount"), value: formatMoney(detail.amount, detail.currency, locale) },
            { key: "date", label: t("financeExpenses.list.date"), value: dateText(detail, locale) },
            { key: "status", label: t("financeExpenses.list.state"), value: t(`financeExpenses.status.${detail.status}`) },
            { key: "dims", label: t("financeExpenses.detail.dimensions"), value: dimensions(detail, t) || "—" },
            { key: "coverage", label: t("financeExpenses.field.coverage"), value: coverageBadge(detail, t) ?? "—" },
            ...(detail.separateReason ? [{ key: "sep", label: t("financeExpenses.field.separateReason"), value: detail.separateReason }] : []),
            ...(detail.document ? [{ key: "doc", label: t("financeExpenses.field.document"), value: detail.document }] : []),
            ...(detail.voidReason ? [{ key: "void", label: t("financeExpenses.detail.voidReason"), value: `${detail.voidReason} · ${formatDateTime(detail.voidedAt, locale)}` }] : []),
            { key: "version", label: t("financeExpenses.detail.version"), value: String(detail.version) },
            { key: "created", label: t("financeExpenses.detail.created"), value: formatDateTime(detail.createdAt, locale) },
          ]}
        />
        {detail.supersedesId ? (
          <Text variant="body-sm">
            <a className="ot-link" href={href(`/finance/expenses?month=${data.month}&status=all&expense=${detail.supersedesId}#expense-detail`)}>
              {t("financeExpenses.detail.supersedes")}
            </a>
          </Text>
        ) : null}
        {detail.supersededById ? (
          <Text variant="body-sm">
            <a className="ot-link" href={href(`/finance/expenses?month=${data.month}&expense=${detail.supersededById}#expense-detail`)}>
              {t("financeExpenses.detail.supersededBy")}
            </a>
          </Text>
        ) : null}
        {detail.awaitingOrder ? <Banner tone="warning">{t("financeExpenses.detail.awaitingOrder")}</Banner> : null}
        {detail.coversForecast ? (
          <Stack gap={2}>
            <Text variant="heading-sm" as="h3">
              {t("financeExpenses.detail.sharesTitle")}
            </Text>
            {detail.shares.length === 0 ? (
              <Text tone="subdued">{t("financeExpenses.detail.noShares")}</Text>
            ) : (
              <DataTable
                caption={t("financeExpenses.detail.sharesTitle")}
                rows={detail.shares}
                rowKey={(s) => s.orderId}
                columns={[
                  {
                    key: "order",
                    header: t("financeExpenses.detail.order"),
                    primary: true,
                    render: (s) => (
                      <a className="ot-link" href={href(`/orders/${s.orderId}`)}>
                        {s.orderNumber}
                      </a>
                    ),
                  },
                  { key: "amount", header: t("financeExpenses.field.amount"), align: "end", render: (s) => formatMoney(s.amount, s.currency, locale) },
                  { key: "basis", header: t("financeExpenses.detail.basis"), render: (s) => t(`financeExpenses.weightBasis.${s.weightBasis === "revenue" ? "revenue" : "forecast"}`) },
                  {
                    key: "posted",
                    header: t("financeExpenses.list.state"),
                    render: (s) => (
                      <Badge size="sm" tone={s.posted ? "success" : "warning"}>
                        {s.posted ? t("financeExpenses.detail.posted") : t("financeExpenses.list.awaiting")}
                      </Badge>
                    ),
                  },
                ]}
              />
            )}
            {active ? (
              <Form method="post" preventScrollReset>
                <input type="hidden" name="intent" value="recalc" />
                <input type="hidden" name="expenseId" value={detail.id} />
                <input type="hidden" name="expectedVersion" value={detail.version} />
                <ConfirmSubmitButton
                  title={t("financeExpenses.detail.recalc")}
                  message={t("financeExpenses.detail.recalcConfirm")}
                  confirmLabel={t("financeExpenses.detail.recalc")}
                  cancelLabel={t("financeExpenses.form.cancel")}
                  variant="secondary"
                  confirmVariant="primary"
                >
                  {t("financeExpenses.detail.recalc")}
                </ConfirmSubmitButton>
              </Form>
            ) : null}
          </Stack>
        ) : null}
        {active ? (
          <Stack gap={3}>
            {!batchOnly ? (
              <div>
                <Button variant="secondary" to={href(`/finance/expenses?month=${data.month}&edit=${detail.id}#expense-form`)}>
                  {t("financeExpenses.detail.edit")}
                </Button>
              </div>
            ) : null}
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="void" />
              <input type="hidden" name="expenseId" value={detail.id} />
              <input type="hidden" name="expectedVersion" value={detail.version} />
              <Stack gap={2}>
                <TextField label={t("financeExpenses.detail.voidReasonField")} name="reason" required maxLength={300} />
                <div>
                  <ConfirmSubmitButton
                    title={t("financeExpenses.detail.void")}
                    message={t("financeExpenses.detail.voidConfirm")}
                    confirmLabel={t("financeExpenses.detail.void")}
                    cancelLabel={t("financeExpenses.form.cancel")}
                    variant="critical"
                  >
                    {t("financeExpenses.detail.void")}
                  </ConfirmSubmitButton>
                </div>
              </Stack>
            </Form>
          </Stack>
        ) : null}
        <Disclosure summary={t("financeExpenses.detail.history")}>
          {detail.history.length === 0 ? (
            <Text tone="subdued">{t("financeExpenses.noData")}</Text>
          ) : (
            <ul>
              {detail.history.map((h) => (
                <li key={h.id}>
                  {formatDateTime(h.createdAt, locale)} — {t(financeLabelKeys.changeEntity(h.entityType as never))}: {t(financeLabelKeys.changeAction(h.action as never))}
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

function FeeRulesCard({ data, t, locale }: SectionProps) {
  const rules = data.rules;
  return (
    <Card id="fee-rules" title={t("financeExpenses.feeRules.title")} description={t("financeExpenses.feeRules.description")} padded={false}>
      <Stack gap={3}>
        {rules.length === 0 ? (
          <div className="ot-card__body">
            <EmptyState title={t("financeExpenses.noData")} description={t("financeExpenses.feeRules.empty")} />
          </div>
        ) : (
          <DataTable
            caption={t("financeExpenses.feeRules.title")}
            rows={rules}
            rowKey={(r) => r.id}
            columns={[
              {
                key: "gateway",
                header: t("financeExpenses.field.gateway"),
                primary: true,
                render: (r) => (
                  <Stack gap={1}>
                    <Text as="span" weight="semibold">
                      {r.gateway}
                    </Text>
                    <Text as="span" variant="body-sm" tone="subdued">
                      {t(`financeExpenses.feeKind.${r.kind}`)}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "terms",
                header: t("financeExpenses.feeRules.terms"),
                render: (r) =>
                  r.noFees
                    ? t("financeExpenses.feeRules.noFees")
                    : [r.percentBp > 0 ? `${r.percent.replace(".", locale === "uk" ? "," : ".")} %` : null, r.fixedAmount && r.fixedCurrency ? formatMoney(r.fixedAmount, r.fixedCurrency, locale) : null]
                        .filter(Boolean)
                        .join(" + "),
              },
              {
                key: "period",
                header: t("financeExpenses.feeRules.period"),
                render: (r) => (
                  <Stack gap={1}>
                    <span>
                      {formatIsoDate(r.appliesFrom, locale)} – {r.appliesTo ? formatIsoDate(r.appliesTo, locale) : t("financeExpenses.feeRules.openEnded")}
                    </span>
                    {r.current ? (
                      <span>
                        <Badge size="sm" tone="success">
                          {t("financeExpenses.feeRules.current")}
                        </Badge>
                      </span>
                    ) : null}
                  </Stack>
                ),
              },
              {
                key: "end",
                header: t("financeExpenses.feeRules.end"),
                render: (r) =>
                  r.appliesTo === null ? (
                    <Form method="post" preventScrollReset>
                      <input type="hidden" name="intent" value="feeRuleEnd" />
                      <input type="hidden" name="ruleId" value={r.id} />
                      <Stack gap={2}>
                        <TextField label={t("financeExpenses.feeRules.endDate")} name="appliesTo" type="date" defaultValue={data.today} />
                        <TextField label={t("financeExpenses.field.reason")} name="reason" maxLength={300} />
                        <div>
                          <ConfirmSubmitButton
                            title={t("financeExpenses.feeRules.end")}
                            message={t("financeExpenses.feeRules.endConfirm")}
                            confirmLabel={t("financeExpenses.feeRules.end")}
                            cancelLabel={t("financeExpenses.form.cancel")}
                            size="sm"
                          >
                            {t("financeExpenses.feeRules.end")}
                          </ConfirmSubmitButton>
                        </div>
                      </Stack>
                    </Form>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
        )}
        <div className="ot-card__body">
          <Disclosure summary={t("financeExpenses.feeRules.add")} defaultOpen={rules.length === 0}>
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="feeRule" />
              <Stack gap={3}>
                <FormLayout columns={2}>
                  {data.gateways.length > 0 ? (
                    <Select label={t("financeExpenses.field.gateway")} name="gateway" options={data.gateways.map((g) => ({ value: g, label: g }))} />
                  ) : (
                    <input type="hidden" name="gateway" value="" />
                  )}
                  <TextField
                    label={data.gateways.length > 0 ? t("financeExpenses.feeRules.gatewayOther") : t("financeExpenses.field.gateway")}
                    name="gatewayOther"
                    maxLength={120}
                    autoComplete="off"
                    spellCheck={false}
                    helpText={t("financeExpenses.feeRules.gatewayHelp")}
                  />
                  <Select label={t("financeExpenses.feeRules.kind")} name="kind" options={FEE_RULE_KINDS.map((k) => ({ value: k, label: t(`financeExpenses.feeKind.${k}`) }))} helpText={t("financeExpenses.feeRules.kindHelp")} />
                  <TextField label={t("financeExpenses.feeRules.percent")} name="percent" inputMode="decimal" maxLength={8} placeholder="3,49" />
                  <TextField label={t("financeExpenses.feeRules.fixedAmount")} name="fixedAmount" inputMode="decimal" maxLength={20} />
                  <Select label={t("financeExpenses.feeRules.fixedCurrency")} name="fixedCurrency" options={data.currencies.map((c) => ({ value: c, label: c }))} />
                  <TextField label={t("financeExpenses.feeRules.appliesFrom")} name="appliesFrom" type="date" defaultValue={data.today} required />
                  <TextField label={t("financeExpenses.field.reason")} name="reason" maxLength={300} />
                </FormLayout>
                <Checkbox label={t("financeExpenses.feeRules.noFeesField")} name="noFees" helpText={t("financeExpenses.feeRules.noFeesHelp")} />
                <Text variant="body-sm" tone="subdued">
                  {t("financeExpenses.feeRules.immutable")}
                </Text>
                <div>
                  <Button type="submit" variant="primary">
                    {t("financeExpenses.feeRules.save")}
                  </Button>
                </div>
              </Stack>
            </Form>
          </Disclosure>
        </div>
      </Stack>
    </Card>
  );
}

function ComparisonCard({ data, t, locale }: SectionProps) {
  const c = data.comparison;
  return (
    <Card title={t("financeExpenses.comparison.title")} description={t("financeExpenses.comparison.description", { currency: c.reportingCurrency })} padded={false}>
      {c.rows.length === 0 ? (
        <div className="ot-card__body">
          <EmptyState title={t("financeExpenses.noData")} description={t("financeExpenses.comparison.empty")} />
        </div>
      ) : (
        <DataTable
          caption={t("financeExpenses.comparison.title")}
          rows={c.rows}
          rowKey={(r) => `${r.gateway}|${r.month}`}
          columns={[
            {
              key: "gateway",
              header: t("financeExpenses.field.gateway"),
              primary: true,
              render: (r) => (
                <Stack gap={1}>
                  <Text as="span" weight="semibold">
                    {r.gateway}
                  </Text>
                  <Text as="span" variant="body-sm" tone="subdued">
                    {monthLabel(r.month, locale)}
                  </Text>
                </Stack>
              ),
            },
            { key: "orders", header: t("financeExpenses.comparison.orders"), align: "end", render: (r) => String(r.orders) },
            {
              key: "forecast",
              header: t("financeExpenses.comparison.forecast"),
              align: "end",
              render: (r) => (
                <Stack gap={1}>
                  <span>{r.forecast === null ? "—" : `≈ ${formatMoney(r.forecast, c.reportingCurrency, locale)}`}</span>
                  <Text as="span" variant="body-sm" tone="subdued">
                    {t("financeExpenses.comparison.coverage", { n: r.compared, m: r.ordersWithActual })}
                  </Text>
                  {r.noRule > 0 ? (
                    <Text as="span" variant="body-sm" tone="subdued">
                      {t("financeExpenses.comparison.noRule", { count: r.noRule })}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "actual",
              header: t("financeExpenses.comparison.actual"),
              align: "end",
              render: (r) => <span>{r.actual === null ? "—" : formatMoney(r.actual, c.reportingCurrency, locale)}</span>,
            },
            {
              // Без курсу — завжди видно (і на телефоні): значення поза сумами, валюта + сума + кількість (§2.6).
              key: "unconverted",
              header: t(financeLabelKeys.term("noRate")),
              align: "end",
              render: (r) =>
                r.unconverted.length === 0 ? (
                  "—"
                ) : (
                  <Stack gap={1}>
                    {r.unconverted.map((u) => (
                      <Text as="span" variant="body-sm" key={`${u.kind}|${u.currency}`}>
                        {t("financeExpenses.comparison.unconvertedRow", {
                          kind: t(u.kind === "forecast" ? "financeExpenses.comparison.forecast" : "financeExpenses.comparison.actual"),
                          amount: formatMoney(u.amount, u.currency, locale),
                          count: u.entries,
                        })}
                      </Text>
                    ))}
                    <Text as="span" variant="body-sm" tone="subdued">
                      {t("financeExpenses.comparison.unconvertedOrders", { count: r.ordersUnconverted })}
                    </Text>
                  </Stack>
                ),
            },
          ]}
        />
      )}
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

import { useEffect, useState } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type ShouldRevalidateFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useHref } from "~/components/shell";
import { can, requirePermission } from "~/domain/permissions";
import { hasKey, useLocale, useT, type TFunction } from "~/i18n";
import { formatDateTime } from "~/lib/format";
import {
  addCountryRule,
  defaultRuleFor,
  getCountryRule,
  isChangedFromDefault,
  listCountryRules,
  listHistory,
  markCountryRuleVerified,
  needsVerification,
  resetCountryRuleToDefault,
  testPostalCode,
  updateCountryRule,
  withVerifyMarker,
  withoutVerifyMarker,
  type CountryRuleChangeResult,
  type CountryRuleHistoryRow,
  type CountryRuleRow,
  type PostalTestResult,
} from "~/modules/country-rules/country-rules.server";
import {
  DUTY_PAYERS,
  EDITABLE_RULE_FIELDS,
  ERR,
  MAX_EXAMPLE_LENGTH,
  MAX_NAME_LENGTH,
  MAX_NOTES_LENGTH,
  MAX_PATTERN_LENGTH,
} from "~/modules/country-rules/constants";
import type { CountryRuleSnapshot } from "~/modules/country-rules/schema";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import type { RequestContext } from "~/server/types";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  DataTable,
  EmptyState,
  FormLayout,
  InlineCode,
  KeyValueList,
  Page,
  Select,
  Stack,
  Text,
  TextField,
  Timeline,
} from "~/ui";

/**
 * Правила країн (етап 4). Їх використовує перевірка даних замовлень.
 * Власник (settings.manage) змінює правила, повертає типові, додає країни; працівник — лише перегляд.
 * Логіка — modules/country-rules (версія, історія, журнал, повторна перевірка відкритих замовлень).
 */

const MAX_QUERY_LENGTH = 60;
const SHIPPING_FILTERS = ["all", "enabled", "disabled"] as const;
type ShippingFilter = (typeof SHIPPING_FILTERS)[number];
const MUTATION_INTENTS = ["update", "reset", "add", "verify"] as const;
type MutationIntent = (typeof MUTATION_INTENTS)[number];
const RULE_FLAGS = ["shippingEnabled", "postalCodeRequired", "provinceRequired", "phoneRequired"] as const;

interface Filters {
  q: string;
  shipping: ShippingFilter;
  changed: boolean;
  country: string | null;
}

function parseFilters(params: URLSearchParams): Filters {
  const shipping = params.get("shipping") ?? "all";
  const country = (params.get("country") ?? "").trim().toUpperCase();
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    shipping: (SHIPPING_FILTERS as readonly string[]).includes(shipping) ? (shipping as ShippingFilter) : "all",
    changed: params.get("changed") === "1",
    country: /^[A-Z]{2}$/.test(country) ? country : null,
  };
}

function buildSearch(f: Partial<Filters>): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.shipping && f.shipping !== "all") params.set("shipping", f.shipping);
  if (f.changed) params.set("changed", "1");
  if (f.country) params.set("country", f.country);
  const search = params.toString();
  return search ? `?${search}` : "";
}

function ruleView(r: CountryRuleRow) {
  const def = defaultRuleFor(r.countryCode);
  return {
    countryCode: r.countryCode,
    nameUk: r.nameUk,
    nameEn: r.nameEn,
    shippingEnabled: r.shippingEnabled,
    postalCodeRequired: r.postalCodeRequired,
    postalCodePattern: r.postalCodePattern,
    postalCodeExample: r.postalCodeExample,
    provinceRequired: r.provinceRequired,
    phoneRequired: r.phoneRequired,
    dutyPayer: r.dutyPayer,
    notes: r.notes,
    /** Примітки для показу: без англійської службової позначки (її замінює значок «Потребує перевірки»). */
    notesDisplay: withoutVerifyMarker(r.notes),
    version: r.version,
    hasDefault: def !== undefined,
    changed: isChangedFromDefault(r),
    needsVerification: needsVerification(r.notes),
  };
}

type HistoryValue = string | boolean | null;

/** Історія: кожна версія + що змінилося відносно попередньої записаної версії. */
function historyView(rows: CountryRuleHistoryRow[]) {
  return rows.map((row, i) => {
    const value = (row.value ?? {}) as Partial<CountryRuleSnapshot>;
    const prev = rows[i + 1]?.value as Partial<CountryRuleSnapshot> | undefined;
    const fields: (keyof CountryRuleSnapshot)[] = ["nameUk", "nameEn", ...EDITABLE_RULE_FIELDS];
    const changes = prev
      ? fields
          .filter((f) => (value[f] ?? null) !== (prev[f] ?? null))
          .map((f) => ({ field: f, from: (prev[f] ?? null) as HistoryValue, to: (value[f] ?? null) as HistoryValue }))
      : [];
    return {
      id: row.id,
      version: row.version,
      source: row.source,
      by: row.changedBy === "system" ? ("system" as const) : ("owner" as const),
      changedAt: row.changedAt.toISOString(),
      changes,
    };
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const filters = parseFilters(new URL(request.url).searchParams);
  const all = (await listCountryRules(ctx.db)).map(ruleView);
  const q = filters.q.toLowerCase();
  const rules = all.filter(
    (r) =>
      (!q || r.countryCode.toLowerCase() === q || r.nameUk.toLowerCase().includes(q) || r.nameEn.toLowerCase().includes(q)) &&
      (filters.shipping === "all" || r.shippingEnabled === (filters.shipping === "enabled")) &&
      (!filters.changed || r.changed),
  );
  // Точний збіг коду (напр. «DE») — першим.
  if (q.length === 2) rules.sort((a, b) => Number(b.countryCode.toLowerCase() === q) - Number(a.countryCode.toLowerCase() === q));
  const selected = filters.country ? all.find((r) => r.countryCode === filters.country) ?? null : null;
  return {
    canManage: can(ctx.actor, "settings.manage"),
    filters,
    isFiltered: Boolean(filters.q || filters.shipping !== "all" || filters.changed),
    rules,
    total: all.length,
    verifyCount: all.filter((r) => r.needsVerification).length,
    selected,
    missingCountry: filters.country && !selected ? filters.country : null,
    history: selected ? historyView(await listHistory(ctx.db, selected.countryCode)) : [],
    dutyPayers: [...DUTY_PAYERS],
  };
}

export type CountryRulesActionResult = ActionResult & { intent: MutationIntent | "unknown"; countryCode?: string };
export interface PostalTestView extends PostalTestResult {
  intent: "testPostal";
  countryCode: string;
  sample: string;
  pattern: string | null;
}

function isMutationIntent(value: string): value is MutationIntent {
  return (MUTATION_INTENTS as readonly string[]).includes(value);
}

function ruleInput(form: FormData) {
  return {
    ...Object.fromEntries(RULE_FLAGS.map((f) => [f, form.has(f)])),
    postalCodePattern: formString(form, "postalCodePattern"),
    postalCodeExample: formString(form, "postalCodeExample"),
    dutyPayer: formString(form, "dutyPayer"),
    // Форма показує примітки без службової позначки; поки правило не позначено перевіреним, позначку зберігаємо.
    notes: form.get("keepVerifyMarker") === "1" ? withVerifyMarker(formString(form, "notes")) : formString(form, "notes"),
  };
}

function expectedVersion(form: FormData): number | null {
  const raw = formString(form, "expectedVersion");
  return /^\d{1,9}$/.test(raw) ? Number(raw) : null;
}

function toResult(intent: MutationIntent, r: CountryRuleChangeResult, countryCode: string): CountryRulesActionResult {
  if (!r.ok) return { ok: false, error: "error.validation", fieldErrors: r.fieldErrors, intent, countryCode };
  if (r.unchanged) return { ok: true, message: "countryRules.result.unchanged", tone: "info", intent, countryCode: r.countryCode };
  const message =
    intent === "add"
      ? "countryRules.result.added"
      : intent === "reset"
        ? "countryRules.result.reset"
        : intent === "verify"
          ? "countryRules.result.verified"
          : "countryRules.result.updated";
  return { ok: true, message, params: { count: r.revalidated }, intent, countryCode: r.countryCode };
}

async function runTest(ctx: RequestContext, form: FormData): Promise<PostalTestView | CountryRulesActionResult> {
  requirePermission(ctx.actor, "orders.view");
  const rule = await getCountryRule(ctx.db, formString(form, "countryCode"));
  if (!rule) return { ok: false, error: "error.notFound", intent: "unknown" };
  const sample = formString(form, "sample").slice(0, MAX_EXAMPLE_LENGTH * 2);
  // Неперевірений шаблон з форми — лише для власника (працівник перевіряє збереженим).
  const pattern = can(ctx.actor, "settings.manage") && form.has("pattern") ? formString(form, "pattern") : rule.postalCodePattern;
  const result = testPostalCode(rule, pattern, sample);
  return { ...result, intent: "testPostal", countryCode: rule.countryCode, sample, pattern: pattern?.trim() || null };
}

export async function action({ request }: ActionFunctionArgs): Promise<CountryRulesActionResult | PostalTestView> {
  const ctx = await getRequestContext(request);
  const form = await request.formData();
  const intent = formString(form, "intent");
  const countryCode = formString(form, "countryCode").trim().toUpperCase();
  try {
    if (intent === "testPostal") return await runTest(ctx, form);
    if (!isMutationIntent(intent)) return { ok: false, error: "error.generic", intent: "unknown" };
    requirePermission(ctx.actor, "settings.manage");
    if (intent === "add") {
      const input = { ...ruleInput(form), countryCode, nameUk: formString(form, "nameUk"), nameEn: formString(form, "nameEn") };
      return toResult(intent, await addCountryRule(ctx, input), countryCode);
    }
    const version = expectedVersion(form);
    if (version === null) return { ok: false, error: "error.generic", intent, countryCode };
    if (intent === "reset") return toResult(intent, await resetCountryRuleToDefault(ctx, countryCode, version), countryCode);
    if (intent === "verify") return toResult(intent, await markCountryRuleVerified(ctx, countryCode, version), countryCode);
    return toResult(intent, await updateCountryRule(ctx, countryCode, ruleInput(form), version), countryCode);
  } catch (e) {
    return { ...toActionError(e), intent: isMutationIntent(intent) ? intent : "unknown", countryCode };
  }
}

/** Перевірка індексу (fetcher) не змінює даних — список не перечитуємо. */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs): boolean {
  if (formData?.get("intent") === "testPostal") return false;
  return defaultShouldRevalidate;
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Rule = Data["rules"][number];
type HistoryEntry = Data["history"][number];
type FieldErrorFn = (name: string) => string | null;

function fieldErrorFn(t: TFunction, result: CountryRulesActionResult | undefined): FieldErrorFn {
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  return (name) => {
    const message = errors?.[name];
    if (!message) return null;
    return t(hasKey(message) ? message : ERR.invalid);
  };
}

function isMutationResult(data: unknown): data is CountryRulesActionResult {
  return typeof data === "object" && data !== null && "ok" in data && (data as { intent?: string }).intent !== "testPostal";
}

export default function CountryRulesPage() {
  const data = useLoaderData<typeof loader>();
  const rawAction = useActionData<typeof action>();
  const actionData = isMutationResult(rawAction) ? rawAction : undefined;
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const location = useLocation();
  const navigation = useNavigation();
  const basePath = href("country-rules");
  const { filters } = data;
  const listHref = (f: Partial<Filters>) => `${basePath}${buildSearch(f)}`;
  const name = (r: { nameUk: string; nameEn: string }) => (locale === "uk" ? r.nameUk : r.nameEn);
  const yesNo = (v: boolean) => (v ? t("common.yes") : t("common.no"));
  const pendingIntent = navigation.state !== "idle" ? navigation.formData?.get("intent") : null;
  const isFiltering = navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET";

  // Результат дії для вибраної країни показується в її картці; решта (додавання, помилки) — угорі.
  const detailResult =
    actionData && data.selected && actionData.countryCode === data.selected.countryCode && actionData.intent !== "add" ? actionData : undefined;
  const addResult = actionData?.intent === "add" ? actionData : undefined;
  const topResult = actionData && !detailResult && !addResult ? actionData : undefined;

  return (
    <Page title={t("nav.countryRules")} subtitle={t("planned.countryRules.subtitle")}>
      <Stack gap={4}>
        <ActionBanner data={topResult} />
        <Banner tone="info">{t(data.canManage ? "countryRules.info.owner" : "countryRules.info.readOnly")}</Banner>
        {data.verifyCount > 0 ? (
          <Banner tone="warning" title={t("countryRules.verify.title")}>
            {t("countryRules.verify.body", { count: data.verifyCount })}
          </Banner>
        ) : null}

        {data.missingCountry ? (
          <Banner tone="warning">{t("countryRules.detail.notFound", { country: data.missingCountry })}</Banner>
        ) : null}
        {data.selected ? (
          <RuleDetail
            key={`${data.selected.countryCode}:${data.selected.version}`}
            rule={data.selected}
            history={data.history}
            dutyPayers={data.dutyPayers}
            canManage={data.canManage}
            result={detailResult}
            pendingIntent={typeof pendingIntent === "string" ? pendingIntent : null}
            closeHref={listHref({ ...filters, country: null })}
          />
        ) : null}

        <Card title={t("common.filters")}>
          <Form key={location.search} method="get" role="search">
            <Stack gap={4}>
              <FormLayout columns={2}>
                <TextField
                  id="country-rules-q"
                  type="search"
                  name="q"
                  label={t("common.search")}
                  placeholder={t("countryRules.filters.searchPlaceholder")}
                  defaultValue={filters.q}
                  maxLength={MAX_QUERY_LENGTH}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Select
                  id="country-rules-shipping"
                  name="shipping"
                  label={t("countryRules.filters.shipping")}
                  defaultValue={filters.shipping}
                  options={SHIPPING_FILTERS.map((s) => ({ value: s, label: t(`countryRules.filters.shipping.${s}`) }))}
                />
              </FormLayout>
              <Checkbox
                id="country-rules-changed"
                name="changed"
                value="1"
                label={t("countryRules.filters.changed")}
                defaultChecked={filters.changed}
              />
              <Stack direction="horizontal" gap={2}>
                <Button type="submit" variant="primary" loading={isFiltering}>
                  {t("common.apply")}
                </Button>
                <Button to={basePath} disabled={!data.isFiltered}>
                  {t("common.reset")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        </Card>

        <Card padded={false}>
          <DataTable<Rule>
            caption={t("nav.countryRules")}
            rows={data.rules}
            rowKey={(r) => r.countryCode}
            rowHref={(r) => listHref({ ...filters, country: r.countryCode })}
            emptyState={
              <EmptyState
                title={t("countryRules.list.empty.title")}
                description={t("countryRules.list.empty.description")}
                action={<Button to={basePath}>{t("common.reset")}</Button>}
              />
            }
            columns={[
              {
                key: "country",
                header: t("planned.countryRules.country"),
                primary: true,
                render: (r) => (
                  <Stack gap={1} direction="horizontal" align="center" wrap>
                    <InlineCode>{r.countryCode}</InlineCode>
                    <span>{name(r)}</span>
                  </Stack>
                ),
              },
              {
                key: "shipping",
                header: t("planned.countryRules.shipping"),
                render: (r) =>
                  r.shippingEnabled ? (
                    <Badge tone="neutral">{t("planned.countryRules.enabled")}</Badge>
                  ) : (
                    <Badge tone="critical">{t("planned.countryRules.disabled")}</Badge>
                  ),
              },
              {
                key: "postal",
                header: t("planned.countryRules.postalCode"),
                render: (r) =>
                  r.postalCodeRequired ? (
                    <Text variant="body-sm">
                      {t("planned.countryRules.required")}
                      {r.postalCodeExample ? ` · ${r.postalCodeExample}` : ""}
                    </Text>
                  ) : (
                    <Text variant="body-sm" tone="subdued">
                      {r.postalCodeExample ? t("planned.countryRules.optional") : t("planned.countryRules.notUsed")}
                    </Text>
                  ),
              },
              { key: "province", header: t("planned.countryRules.province"), render: (r) => yesNo(r.provinceRequired), hideOnMobile: true },
              { key: "phone", header: t("planned.countryRules.phone"), render: (r) => yesNo(r.phoneRequired), hideOnMobile: true },
              {
                key: "duty",
                header: t("planned.countryRules.dutyPayer"),
                render: (r) => t(`planned.countryRules.duty.${r.dutyPayer}`),
                hideOnMobile: true,
              },
              { key: "state", header: t("countryRules.list.status"), render: (r) => <RuleBadges rule={r} /> },
            ]}
          />
        </Card>
        <Text variant="body-sm" tone="subdued">
          {t("countryRules.list.count", { shown: data.rules.length, total: data.total })}
        </Text>

        {data.canManage ? (
          <AddCountryCard
            dutyPayers={data.dutyPayers}
            result={addResult}
            pending={pendingIntent === "add"}
            openHref={addResult?.ok && addResult.countryCode ? listHref({ country: addResult.countryCode }) : null}
          />
        ) : null}
      </Stack>
    </Page>
  );
}

function RuleBadges({ rule }: { rule: Pick<Rule, "changed" | "hasDefault" | "needsVerification"> }) {
  const t = useT();
  return (
    <Stack as="span" direction="horizontal" gap={1} wrap>
      {!rule.hasDefault ? (
        <Badge tone="info" size="sm">
          {t("countryRules.badge.custom")}
        </Badge>
      ) : rule.changed ? (
        <Badge tone="strong" size="sm">
          {t("countryRules.badge.changed")}
        </Badge>
      ) : (
        <Badge tone="outline" size="sm">
          {t("countryRules.badge.default")}
        </Badge>
      )}
      {rule.needsVerification ? (
        <Badge tone="warning" size="sm">
          {t("countryRules.badge.verify")}
        </Badge>
      ) : null}
    </Stack>
  );
}

function RuleDetail({
  rule,
  history,
  dutyPayers,
  canManage,
  result,
  pendingIntent,
  closeHref,
}: {
  rule: Rule;
  history: HistoryEntry[];
  dutyPayers: string[];
  canManage: boolean;
  result: CountryRulesActionResult | undefined;
  pendingIntent: string | null;
  closeHref: string;
}) {
  const t = useT();
  const locale = useLocale();
  const [pattern, setPattern] = useState(rule.postalCodePattern ?? "");
  const fieldError = fieldErrorFn(t, result);
  const title = `${rule.countryCode} · ${locale === "uk" ? rule.nameUk : rule.nameEn}`;
  const isDefault = rule.hasDefault && !rule.changed;

  return (
    <Card
      id="rule"
      title={title}
      description={t("countryRules.detail.version", { version: rule.version })}
      actions={<Button to={closeHref}>{t("countryRules.detail.close")}</Button>}
    >
      <Stack gap={4}>
        <RuleBadges rule={rule} />
        <ActionBanner data={result} />
        {rule.needsVerification ? (
          <Banner tone="warning">
            <Stack gap={3}>
              <Text>{t(canManage ? "countryRules.verify.rule" : "countryRules.verify.ruleReadOnly")}</Text>
              {canManage ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="verify" />
                  <input type="hidden" name="countryCode" value={rule.countryCode} />
                  <input type="hidden" name="expectedVersion" value={rule.version} />
                  <Button type="submit" variant="secondary" loading={pendingIntent === "verify"}>
                    {t("countryRules.verify.button")}
                  </Button>
                </Form>
              ) : null}
            </Stack>
          </Banner>
        ) : null}

        {canManage ? (
          <Form method="post">
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="countryCode" value={rule.countryCode} />
            <input type="hidden" name="expectedVersion" value={rule.version} />
            {rule.needsVerification ? <input type="hidden" name="keepVerifyMarker" value="1" /> : null}
            <Stack gap={4}>
              <RuleFields
                idPrefix={`rule-${rule.countryCode}`}
                values={{ ...rule, notes: rule.notesDisplay }}
                dutyPayers={dutyPayers}
                fieldError={fieldError}
                pattern={pattern}
                onPatternChange={setPattern}
              />
              <Stack direction="horizontal" gap={3} align="center">
                <Button type="submit" variant="primary" loading={pendingIntent === "update"}>
                  {t("common.save")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        ) : (
          <KeyValueList
            items={[
              { key: "shipping", label: t("countryRules.field.shippingEnabled"), value: yesNoText(t, rule.shippingEnabled) },
              { key: "postalRequired", label: t("countryRules.field.postalCodeRequired"), value: yesNoText(t, rule.postalCodeRequired) },
              {
                key: "pattern",
                label: t("countryRules.field.postalCodePattern"),
                value: rule.postalCodePattern ? <InlineCode>{rule.postalCodePattern}</InlineCode> : t("countryRules.detail.noPattern"),
              },
              { key: "example", label: t("countryRules.field.postalCodeExample"), value: rule.postalCodeExample ?? "—" },
              { key: "province", label: t("countryRules.field.provinceRequired"), value: yesNoText(t, rule.provinceRequired) },
              { key: "phone", label: t("countryRules.field.phoneRequired"), value: yesNoText(t, rule.phoneRequired) },
              { key: "duty", label: t("countryRules.field.dutyPayer"), value: t(`planned.countryRules.duty.${rule.dutyPayer}`) },
              { key: "notes", label: t("countryRules.field.notes"), value: rule.notesDisplay ?? "—" },
            ]}
          />
        )}

        <PostalTester countryCode={rule.countryCode} pattern={canManage ? pattern : null} />

        {canManage ? (
          rule.hasDefault ? (
            isDefault ? (
              <Text variant="body-sm" tone="subdued">
                {t("countryRules.reset.isDefault")}
              </Text>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="reset" />
                <input type="hidden" name="countryCode" value={rule.countryCode} />
                <input type="hidden" name="expectedVersion" value={rule.version} />
                <ConfirmSubmitButton
                  variant="secondary"
                  title={t("countryRules.reset.title")}
                  message={<Text>{t("countryRules.reset.message", { country: title })}</Text>}
                  confirmLabel={t("countryRules.reset.confirm")}
                  cancelLabel={t("common.cancel")}
                  loading={pendingIntent === "reset"}
                >
                  {t("countryRules.reset.button")}
                </ConfirmSubmitButton>
              </Form>
            )
          ) : (
            <Text variant="body-sm" tone="subdued">
              {t("countryRules.reset.noDefault")}
            </Text>
          )
        ) : null}

        <Stack gap={2}>
          <Text as="h3" variant="heading-sm">
            {t("countryRules.history.title")}
          </Text>
          {history.length === 0 ? (
            <Text variant="body-sm" tone="subdued">
              {t("countryRules.history.empty")}
            </Text>
          ) : (
            <Timeline
              items={history.map((h) => ({
                id: h.id,
                title: t("countryRules.history.entry", {
                  version: h.version,
                  source: t(`countryRules.history.source.${h.source}`),
                }),
                time: `${formatDateTime(h.changedAt, locale)} · ${t(`countryRules.history.by.${h.by}`)}`,
                description:
                  h.changes.length > 0 ? (
                    <Stack as="ul" gap={1}>
                      {h.changes.map((c) => (
                        <li key={c.field}>
                          <Text as="span" variant="body-sm">
                            {t("countryRules.history.change", {
                              field: t(`countryRules.field.${c.field}`),
                              from: historyValue(t, c.field, c.from),
                              to: historyValue(t, c.field, c.to),
                            })}
                          </Text>
                        </li>
                      ))}
                    </Stack>
                  ) : undefined,
              }))}
            />
          )}
        </Stack>
      </Stack>
    </Card>
  );
}

function yesNoText(t: TFunction, v: boolean): string {
  return v ? t("common.yes") : t("common.no");
}

function historyValue(t: TFunction, field: string, value: HistoryValue): string {
  if (value === null || value === "") return t("countryRules.history.empty_value");
  if (typeof value === "boolean") return yesNoText(t, value);
  if (field === "dutyPayer") return t(`planned.countryRules.duty.${value}`);
  return value;
}

interface RuleFieldValues {
  shippingEnabled: boolean;
  postalCodeRequired: boolean;
  postalCodePattern: string | null;
  postalCodeExample: string | null;
  provinceRequired: boolean;
  phoneRequired: boolean;
  dutyPayer: string;
  notes: string | null;
}

/** Поля правила (форма зміни і форма нової країни). */
function RuleFields({
  idPrefix,
  values,
  dutyPayers,
  fieldError,
  pattern,
  onPatternChange,
}: {
  idPrefix: string;
  values: RuleFieldValues;
  dutyPayers: string[];
  fieldError: FieldErrorFn;
  pattern?: string;
  onPatternChange?: (value: string) => void;
}) {
  const t = useT();
  return (
    <Stack gap={4}>
      <Stack gap={2}>
        {RULE_FLAGS.map((f) => (
          <Checkbox
            key={f}
            id={`${idPrefix}-${f}`}
            name={f}
            label={t(`countryRules.field.${f}`)}
            helpText={f === "shippingEnabled" ? t("countryRules.field.shippingEnabledHelp") : undefined}
            defaultChecked={values[f]}
            error={fieldError(f)}
          />
        ))}
      </Stack>
      <FormLayout columns={2}>
        <div className="ot-form-layout__full">
          <TextField
            id={`${idPrefix}-postalCodePattern`}
            name="postalCodePattern"
            label={t("countryRules.field.postalCodePattern")}
            helpText={t("countryRules.field.postalCodePatternHelp")}
            {...(onPatternChange
              ? { value: pattern ?? "", onChange: (e) => onPatternChange(e.currentTarget.value) }
              : { defaultValue: values.postalCodePattern ?? "" })}
            maxLength={MAX_PATTERN_LENGTH}
            error={fieldError("postalCodePattern")}
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </div>
        <TextField
          id={`${idPrefix}-postalCodeExample`}
          name="postalCodeExample"
          label={t("countryRules.field.postalCodeExample")}
          helpText={t("countryRules.field.postalCodeExampleHelp")}
          defaultValue={values.postalCodeExample ?? ""}
          maxLength={MAX_EXAMPLE_LENGTH}
          error={fieldError("postalCodeExample")}
          autoComplete="off"
          spellCheck={false}
        />
        <Select
          id={`${idPrefix}-dutyPayer`}
          name="dutyPayer"
          label={t("countryRules.field.dutyPayer")}
          defaultValue={values.dutyPayer}
          options={dutyPayers.map((d) => ({ value: d, label: t(`planned.countryRules.duty.${d}`) }))}
          error={fieldError("dutyPayer")}
        />
        <div className="ot-form-layout__full">
          <TextField
            id={`${idPrefix}-notes`}
            name="notes"
            label={t("countryRules.field.notes")}
            helpText={t("countryRules.field.notesHelp")}
            defaultValue={values.notes ?? ""}
            maxLength={MAX_NOTES_LENGTH}
            multiline={3}
            error={fieldError("notes")}
          />
        </div>
      </FormLayout>
    </Stack>
  );
}

const TEST_DEBOUNCE_MS = 400;

/**
 * Перевірка зразка індексу на сервері (intent testPostal через fetcher, без перезавантаження списку).
 * Власник перевіряє шаблон із форми (ще не збережений), працівник — збережений.
 */
function PostalTester({ countryCode, pattern }: { countryCode: string; pattern: string | null }) {
  const t = useT();
  const fetcher = useFetcher<typeof action>();
  const [sample, setSample] = useState("");
  const submit = fetcher.submit;

  useEffect(() => {
    if (!sample.trim()) return;
    const timer = setTimeout(() => {
      const payload: Record<string, string> = { intent: "testPostal", countryCode, sample };
      if (pattern !== null) payload.pattern = pattern;
      void submit(payload, { method: "post" });
    }, TEST_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // submit змінюється між рендерами — перевірка лише за зміни зразка/шаблону.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sample, pattern, countryCode]);

  const data = fetcher.data;
  const test =
    data && "intent" in data && data.intent === "testPostal" && data.sample === sample && (pattern === null || data.pattern === (pattern.trim() || null))
      ? (data as PostalTestView)
      : null;

  return (
    <fetcher.Form method="post">
      <input type="hidden" name="intent" value="testPostal" />
      <input type="hidden" name="countryCode" value={countryCode} />
      {pattern !== null ? <input type="hidden" name="pattern" value={pattern} /> : null}
      <Stack gap={2}>
        <Text as="h3" variant="heading-sm">
          {t("countryRules.test.title")}
        </Text>
        <Text variant="body-sm" tone="subdued">
          {t("countryRules.test.description")}
          {pattern !== null ? ` ${t("countryRules.test.descriptionOwner")}` : ""}
        </Text>
        <Stack direction="horizontal" gap={2} align="end">
          <TextField
            id={`postal-test-${countryCode}`}
            name="sample"
            label={t("countryRules.test.sample")}
            value={sample}
            onChange={(e) => setSample(e.currentTarget.value)}
            maxLength={MAX_EXAMPLE_LENGTH * 2}
            autoComplete="off"
            spellCheck={false}
          />
          <Button type="submit" loading={fetcher.state !== "idle"}>
            {t("countryRules.test.submit")}
          </Button>
        </Stack>
        <div aria-live="polite">{test && sample.trim() ? <PostalTestText test={test} /> : null}</div>
      </Stack>
    </fetcher.Form>
  );
}

function PostalTestText({ test }: { test: PostalTestView }) {
  const t = useT();
  if (!test.patternValid) {
    return (
      <Text variant="body-sm" tone="critical">
        {t("countryRules.test.patternInvalid")}
      </Text>
    );
  }
  if (test.match === null) {
    return (
      <Text variant="body-sm" tone="subdued">
        {t("countryRules.test.noPattern", { value: test.normalized })}
      </Text>
    );
  }
  return (
    <Text variant="body-sm" tone={test.match ? "success" : "critical"}>
      {t(test.match ? "countryRules.test.match" : "countryRules.test.noMatch", { value: test.normalized })}
    </Text>
  );
}

const NEW_RULE_DEFAULTS: RuleFieldValues = {
  shippingEnabled: true,
  postalCodeRequired: true,
  postalCodePattern: null,
  postalCodeExample: null,
  provinceRequired: false,
  phoneRequired: true,
  dutyPayer: "unknown",
  notes: null,
};

function AddCountryCard({
  dutyPayers,
  result,
  pending,
  openHref,
}: {
  dutyPayers: string[];
  result: CountryRulesActionResult | undefined;
  pending: boolean;
  openHref: string | null;
}) {
  const t = useT();
  const fieldError = fieldErrorFn(t, result);
  return (
    <Card title={t("countryRules.add.title")} description={t("countryRules.add.description")}>
      {/* Після успішного додавання форма очищується (новий key). */}
      <Form method="post" key={result?.ok ? `added-${result.countryCode ?? ""}` : "add"}>
        <input type="hidden" name="intent" value="add" />
        <Stack gap={4}>
          <ActionBanner data={result} />
          {openHref ? (
            <Stack direction="horizontal">
              <Button to={openHref}>{t("countryRules.list.open", { country: result?.countryCode ?? "" })}</Button>
            </Stack>
          ) : null}
          <FormLayout columns={2}>
            <TextField
              id="add-countryCode"
              name="countryCode"
              label={t("countryRules.field.countryCode")}
              helpText={t("countryRules.field.countryCodeHelp")}
              maxLength={2}
              autoCapitalize="characters"
              autoComplete="off"
              spellCheck={false}
              required
              error={fieldError("countryCode")}
            />
            <TextField
              id="add-nameUk"
              name="nameUk"
              label={t("countryRules.field.nameUk")}
              helpText={t("countryRules.field.nameHelp")}
              maxLength={MAX_NAME_LENGTH}
              error={fieldError("nameUk")}
            />
            <TextField
              id="add-nameEn"
              name="nameEn"
              label={t("countryRules.field.nameEn")}
              helpText={t("countryRules.field.nameHelp")}
              maxLength={MAX_NAME_LENGTH}
              error={fieldError("nameEn")}
            />
          </FormLayout>
          <RuleFields idPrefix="add" values={NEW_RULE_DEFAULTS} dutyPayers={dutyPayers} fieldError={fieldError} />
          <Stack direction="horizontal">
            <Button type="submit" variant="primary" loading={pending}>
              {t("countryRules.add.submit")}
            </Button>
          </Stack>
        </Stack>
      </Form>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

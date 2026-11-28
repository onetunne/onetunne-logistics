/**
 * Етап 6, WP2: «Фінанси → Собівартість» (docs/stage6-design.md §6, §18.7). Маршрут …/finance/costs.
 * Доступ (§14.2): loader — finance.view + роль owner (інакше 403 без переадресації), action — finance.manage + роль owner
 * (Origin сторінок перевіряє React Router). Кожен сервіс ще раз перевіряє requireFinance.
 * Розділи: «Потребує уваги», «Ручна собівартість» (позиція або модель × колір, «до залишку» / «до вже проданих»),
 * «За моделями й кольорами» (+ підказки з Shopify), «Вартість запасів» на дату, «Партії» (коригування, «Списати
 * невикористані витрати партії»), «Брак і списання», «Історія змін собівартості». Порожня база — «Немає даних».
 * Суми — десяткові рядки через app/lib/format.ts; відсутнє — «—», ніколи не 0.
 */
import { useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { Form, Link } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import type { FinanceChangeAction, FinanceChangeEntityType } from "~/domain/finance";
import { FinanceTabs } from "~/components/finance/finance-tabs";
import { useHref } from "~/components/shell";
import { adminClientFor } from "~/integrations/shopify/admin-client.server";
import { useLocale, useT, type TFunction } from "~/i18n";
import { parseOwnerAmount } from "~/lib/decimal";
import { formatDateTime, formatIsoDate, formatMoney, formatNumber } from "~/lib/format";
import { addDays, parseIsoDate } from "~/lib/periods";
import { batchWriteOffs, writeOffBatchCosts } from "~/modules/costing/batch-writeoff.server";
import { manualCostPreview, saveManualCost, type ManualCostPreview, type ManualCostTarget } from "~/modules/costing/manual-costs.server";
import { batchCosts, costHistory, costsAttention, defectsSummary, inventoryValueAt, modelColorCosts } from "~/modules/costing/queries.server";
import { confirmCostSuggestions, importShopifyCostSuggestions, listCostSuggestions } from "~/modules/costing/shopify-costs.server";
import { requireFinanceOr403 } from "~/modules/finance/core/access.server";
import { financeLabelKeys } from "~/modules/finance/core/labels";
import { getFinanceSettings } from "~/modules/finance/core/settings.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { businessDate } from "~/modules/warehouse/dates";
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function targetFromParams(sp: URLSearchParams): ManualCostTarget | null {
  const item = sp.get("item");
  if (item && UUID_RE.test(item)) return { kind: "stockItems", stockItemIds: [item] };
  const model = sp.get("model");
  if (model && model.trim()) return { kind: "modelColor", model: model.trim().slice(0, 120), color: sp.get("color") || null };
  return null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "view");
  const url = new URL(request.url);
  const today = businessDate(ctx.now());
  const date = parseIsoDate(url.searchParams.get("date")) ?? today;
  const to = parseIsoDate(url.searchParams.get("to")) ?? today;
  const fromParam = parseIsoDate(url.searchParams.get("from"));
  const from = fromParam && fromParam <= to ? fromParam : addDays(to, -29);
  // Дата дії ручної собівартості — не пізніше сьогодні (сервіс відхиляє майбутню дату, §6.6).
  const effectiveFromParam = parseIsoDate(url.searchParams.get("effectiveFrom")) ?? today;
  const effectiveFrom = effectiveFromParam > today ? today : effectiveFromParam;
  const target = targetFromParams(url.searchParams);
  const { value: settings } = await getFinanceSettings(ctx);
  let preview: ManualCostPreview | null = null;
  let previewError: string | null = null;
  if (target) {
    try {
      preview = await manualCostPreview(ctx, { target, effectiveFrom });
    } catch {
      previewError = "financeCosts.form.targetNotFound";
    }
  }
  const [attention, models, stockValue, batches, defects, history, suggestions] = await Promise.all([
    costsAttention(ctx, { limit: 100 }),
    modelColorCosts(ctx, { from, to, today }),
    inventoryValueAt(ctx, { date: date > today ? today : date }),
    batchCosts(ctx, { limit: 50 }),
    defectsSummary(ctx, { from, to }),
    costHistory(ctx, { stockItemId: target?.kind === "stockItems" ? target.stockItemIds[0] : null, limit: 30 }),
    listCostSuggestions(ctx, { limit: 200 }),
  ]);
  const writeOffs = await batchWriteOffs(ctx, batches.map((b) => b.batchId));
  const attentionItem = target?.kind === "stockItems" ? attention.find((a) => a.stockItemId === target.stockItemIds[0]) : undefined;
  return {
    demo: ctx.mode === "demo",
    shopifyAvailable: ctx.mode === "production",
    today,
    period: { from, to },
    date: stockValue.date,
    effectiveFrom,
    valuationCurrency: settings.valuationCurrency,
    currencies: [...new Set([settings.valuationCurrency, ...settings.displayCurrencies])],
    operationId: globalThis.crypto.randomUUID(),
    target,
    targetLabel: target?.kind === "modelColor" ? `${target.model}${target.color ? ` · ${target.color}` : ""}` : attentionItem ? labelOf(attentionItem) : null,
    preview,
    previewError,
    attention,
    models,
    stockValue,
    batches: batches.map((b) => ({ ...b, writeOffs: writeOffs.get(b.batchId) ?? [] })),
    defects,
    history,
    suggestions,
  };
}

function labelOf(a: { title: string; variantTitle: string | null; sku: string | null }): string {
  return [a.title, a.variantTitle, a.sku ? `(${a.sku})` : null].filter(Boolean).join(" · ");
}

type CostsActionResult = ActionResult & { intent?: string; nextOperationId?: string };

function amountOrError(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const r = parseOwnerAmount(raw);
  return r.ok ? r : { ok: false, error: r.error };
}

export async function action({ request }: ActionFunctionArgs): Promise<CostsActionResult> {
  const ctx = await getRequestContext(request);
  requireFinanceOr403(ctx, "manage");
  const nextOperationId = globalThis.crypto.randomUUID();
  let intent = "";
  try {
    const form = await request.formData();
    intent = formString(form, "intent");
    if (intent === "saveCost") {
      const amount = amountOrError(formString(form, "unitCost"));
      if (!amount.ok) return { ok: false, error: amount.error, intent, nextOperationId };
      const item = formString(form, "stockItemId");
      const model = formString(form, "model").trim();
      const target: ManualCostTarget | null = item
        ? { kind: "stockItems", stockItemIds: [item] }
        : model
          ? { kind: "modelColor", model, color: formString(form, "color").trim() || null }
          : null;
      if (!target) return { ok: false, error: "financeCosts.form.targetRequired", intent, nextOperationId };
      const r = await saveManualCost(ctx, {
        operationId: formString(form, "operationId"),
        target,
        unitCost: amount.value,
        currency: formString(form, "currency").trim().toUpperCase(),
        effectiveFrom: formString(form, "effectiveFrom"),
        applyToStock: form.has("applyToStock"),
        applyToSold: form.has("applyToSold"),
        recomputeStandard: form.has("recomputeStandard"),
        note: formString(form, "note") || null,
      });
      if (r.duplicate) return { ok: true, tone: "info", message: "financeCosts.result.duplicate", intent, nextOperationId };
      return {
        ok: true,
        message: "financeCosts.result.saved",
        params: { items: r.items, stock: r.completedStockUnits, sold: r.completedSoldUnits },
        extra: r.recomputed > 0 ? ["financeCosts.result.recomputed"] : undefined,
        intent,
        nextOperationId,
      };
    }
    if (intent === "importShopify") {
      if (ctx.mode !== "production") return { ok: false, error: "financeCosts.error.shopifyUnavailable", intent, nextOperationId };
      const shop = await currentShop(ctx.db);
      if (!shop) return { ok: false, error: "financeCosts.error.shopifyUnavailable", intent, nextOperationId };
      const r = await importShopifyCostSuggestions(ctx, await adminClientFor(shop.shop));
      return {
        ok: true,
        message: "financeCosts.result.imported",
        params: { variants: r.variants, suggestions: r.suggestions, withoutCost: r.withoutCost },
        extra: r.truncated ? ["financeCosts.result.importTruncated"] : undefined,
        intent,
        nextOperationId,
      };
    }
    if (intent === "confirmSuggestions") {
      const ids = form.getAll("suggestionIds").filter((v): v is string => typeof v === "string" && UUID_RE.test(v));
      if (ids.length === 0) return { ok: false, error: "financeCosts.suggestions.noneSelected", intent, nextOperationId };
      const r = await confirmCostSuggestions(ctx, {
        operationId: formString(form, "operationId"),
        suggestionIds: ids,
        effectiveFrom: formString(form, "effectiveFrom"),
        applyToStock: form.has("applyToStock"),
        applyToSold: form.has("applyToSold"),
      });
      return { ok: true, message: "financeCosts.result.confirmed", params: { count: r.confirmed, stock: r.completedStockUnits, sold: r.completedSoldUnits }, intent, nextOperationId };
    }
    if (intent === "writeOff") {
      const amount = amountOrError(formString(form, "amount"));
      if (!amount.ok) return { ok: false, error: amount.error, intent, nextOperationId };
      const r = await writeOffBatchCosts(ctx, {
        operationId: formString(form, "operationId"),
        batchId: formString(form, "batchId"),
        amount: amount.value,
        currency: formString(form, "currency").trim().toUpperCase(),
        date: formString(form, "date"),
        reason: formString(form, "reason"),
      });
      return { ok: true, tone: r.duplicate ? "info" : "success", message: r.duplicate ? "financeCosts.result.duplicate" : "financeCosts.result.writtenOff", intent, nextOperationId };
    }
    return { ok: false, error: "error.generic", intent, nextOperationId };
  } catch (e) {
    return { ...toActionError(e), intent, nextOperationId };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;

const money = (amount: string | null | undefined, currency: string | null | undefined, locale: "uk" | "en") => formatMoney(amount, currency, locale);

export default function FinanceCostsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const operationId = actionData?.ok && actionData.nextOperationId ? actionData.nextOperationId : data.operationId;
  return (
    <Page title={t(financeLabelKeys.tab("costs"))} subtitle={t("financeCosts.subtitle")}>
      <Stack gap={4}>
        <FinanceTabs current="costs" />
        {data.demo ? <Banner tone="info">{t(financeLabelKeys.notice("demo"))}</Banner> : null}
        <ActionBanner data={actionData} />
        <AttentionCard data={data} t={t} />
        <ManualCostCard data={data} t={t} locale={locale} operationId={operationId} />
        <ModelsCard data={data} t={t} locale={locale} operationId={operationId} />
        <StockValueCard data={data} t={t} locale={locale} />
        <BatchesCard data={data} t={t} locale={locale} operationId={operationId} />
        <DefectsCard data={data} t={t} locale={locale} />
        <HistoryCard data={data} t={t} locale={locale} />
        <Text tone="subdued" variant="body-sm">
          {t("financeCosts.method")}
        </Text>
      </Stack>
    </Page>
  );
}

interface SectionProps {
  data: Data;
  t: TFunction;
  locale: "uk" | "en";
}

function NoData({ t }: { t: TFunction }) {
  return <EmptyState title={t("financeCosts.noData")} />;
}

function AttentionCard({ data, t }: Omit<SectionProps, "locale">) {
  const href = useHref();
  const rows = data.attention;
  return (
    <Card title={t("financeCosts.attention.title")} description={t("financeCosts.attention.description")} padded={rows.length === 0}>
      {rows.length === 0 ? (
        <EmptyState title={t("financeCosts.attention.empty")} />
      ) : (
        <DataTable
          caption={t("financeCosts.attention.title")}
          rows={rows}
          rowKey={(r) => r.stockItemId}
          columns={[
            { key: "item", header: t("financeCosts.col.item"), primary: true, render: (r) => labelOf(r) },
            { key: "stock", header: t("financeCosts.col.onHandWithoutCost"), align: "end", render: (r) => String(r.onHandWithoutCost) },
            {
              key: "sold",
              header: t("financeCosts.col.soldWithoutCost"),
              align: "end",
              render: (r) => (r.soldWithoutCost > 0 ? t("financeCosts.attention.soldOrders", { units: r.soldWithoutCost, orders: r.orders }) : "0"),
            },
            {
              key: "awaiting",
              header: t("financeCosts.col.soldAwaiting"),
              align: "end",
              hideOnMobile: true,
              render: (r) => (r.soldAwaitingReceipt > 0 ? String(r.soldAwaitingReceipt) : "—"),
            },
            { key: "fx", header: t("financeCosts.col.awaitingRate"), align: "end", hideOnMobile: true, render: (r) => (r.awaitingRate > 0 ? String(r.awaitingRate) : "—") },
            {
              key: "action",
              header: t("financeCosts.col.action"),
              render: (r) => (
                <Link to={href(`/finance/costs?item=${r.stockItemId}#manual-cost`)} preventScrollReset>
                  {t("financeCosts.attention.enterCost")}
                </Link>
              ),
            },
          ]}
        />
      )}
    </Card>
  );
}

function ManualCostCard({ data, t, locale, operationId }: SectionProps & { operationId: string }) {
  const navigation = useNavigation();
  const busy = navigation.state === "submitting" && navigation.formData?.get("intent") === "saveCost";
  const target = data.target;
  return (
    <Card id="manual-cost" title={t("financeCosts.form.title")} description={t("financeCosts.form.description")}>
      <Stack gap={3}>
        {data.previewError ? <Banner tone="warning">{t(data.previewError)}</Banner> : null}
        {!target ? (
          <Text tone="subdued">{t("financeCosts.form.pickTarget")}</Text>
        ) : (
          <>
            <KeyValueList items={[{ key: "target", label: t("financeCosts.form.target"), value: data.targetLabel ?? "—" }]} />
            {data.preview ? (
              <Banner tone={data.preview.onHandWithoutCost + data.preview.soldWithoutCost > 0 ? "warning" : "info"}>
                {t("financeCosts.form.preview", {
                  stock: data.preview.onHandWithoutCost,
                  sold: data.preview.soldWithoutCost,
                  orders: data.preview.orders,
                  items: data.preview.items,
                })}
                {data.preview.soldAwaitingReceipt > 0 ? ` ${t("financeCosts.form.previewAwaiting", { units: data.preview.soldAwaitingReceipt })}` : null}
              </Banner>
            ) : null}
            <Form method="get" preventScrollReset>
              {target.kind === "stockItems" ? <input type="hidden" name="item" value={target.stockItemIds[0]} /> : null}
              {target.kind === "modelColor" ? (
                <>
                  <input type="hidden" name="model" value={target.model} />
                  <input type="hidden" name="color" value={target.color ?? ""} />
                </>
              ) : null}
              <FormLayout>
                <TextField label={t("financeCosts.form.effectiveFrom")} name="effectiveFrom" type="date" defaultValue={data.effectiveFrom} max={data.today} />
                <Button type="submit" variant="secondary">
                  {t("financeCosts.form.refreshPreview")}
                </Button>
              </FormLayout>
            </Form>
            <Form method="post" preventScrollReset>
              <input type="hidden" name="intent" value="saveCost" />
              <input type="hidden" name="operationId" value={operationId} />
              <input type="hidden" name="effectiveFrom" value={data.effectiveFrom} />
              {target.kind === "stockItems" ? <input type="hidden" name="stockItemId" value={target.stockItemIds[0]} /> : null}
              {target.kind === "modelColor" ? (
                <>
                  <input type="hidden" name="model" value={target.model} />
                  <input type="hidden" name="color" value={target.color ?? ""} />
                </>
              ) : null}
              <FormLayout>
                <Grid columns={{ xs: 1, md: 2 }} gap={3}>
                  <TextField label={t("financeCosts.form.unitCost")} name="unitCost" inputMode="decimal" required autoComplete="off" />
                  <Select
                    label={t("financeCosts.form.currency")}
                    name="currency"
                    defaultValue={data.valuationCurrency}
                    options={data.currencies.map((c) => ({ value: c, label: c }))}
                  />
                </Grid>
                <Text variant="body-sm" tone="subdued">
                  {t("financeCosts.form.effectiveFromValue", { date: formatIsoDate(data.effectiveFrom, locale) })}
                </Text>
                <Checkbox name="applyToStock" label={t("financeCosts.form.applyToStock")} helpText={t("financeCosts.form.applyToStockHelp")} defaultChecked />
                <Checkbox name="applyToSold" label={t("financeCosts.form.applyToSold")} helpText={t("financeCosts.form.applyToSoldHelp")} />
                <Checkbox name="recomputeStandard" label={t("financeCosts.form.recompute")} helpText={t("financeCosts.form.recomputeHelp")} />
                <TextField label={t("financeCosts.form.note")} name="note" maxLength={200} multiline={2} />
                <Button type="submit" variant="primary" disabled={busy}>
                  {t("financeCosts.form.save")}
                </Button>
              </FormLayout>
            </Form>
          </>
        )}
      </Stack>
    </Card>
  );
}

function ModelsCard({ data, t, locale, operationId }: SectionProps & { operationId: string }) {
  const href = useHref();
  const m = data.models;
  const cur = m.currency;
  return (
    <Card title={t("financeCosts.models.title")} description={t("financeCosts.models.description", { from: formatIsoDate(data.period.from, locale), to: formatIsoDate(data.period.to, locale) })} padded={false}>
      <Stack gap={3}>
        {m.rows.length === 0 ? (
          <div className="ot-card__body">
            <NoData t={t} />
          </div>
        ) : (
          <DataTable
            caption={t("financeCosts.models.title")}
            rows={m.rows}
            rowKey={(r) => `${r.model ?? `p:${r.productTitle ?? ""}`}|${r.color ?? ""}`}
            columns={[
              {
                key: "model",
                header: t("financeCosts.col.modelColor"),
                primary: true,
                render: (r) => `${r.model ?? r.productTitle ?? t("financeCosts.models.noModel")} · ${r.color ?? t("financeCosts.models.noColor")}`,
              },
              {
                key: "manual",
                header: t("financeCosts.col.manual"),
                align: "end",
                render: (r) =>
                  r.manualMixedCurrency
                    ? t("financeCosts.models.mixed")
                    : r.manual
                      ? r.manual.min === r.manual.max
                        ? money(r.manual.min, r.manual.currency, locale)
                        : `${money(r.manual.min, r.manual.currency, locale)} – ${money(r.manual.max, r.manual.currency, locale)}`
                      : "—",
              },
              {
                key: "stock",
                header: t("financeCosts.col.stockAverage"),
                align: "end",
                render: (r) => (r.stock.average ? `${money(r.stock.average, cur, locale)} · ${formatNumber(r.stock.qty, locale)}` : "—"),
              },
              { key: "unknown", header: t("financeCosts.col.withoutCost"), align: "end", hideOnMobile: true, render: (r) => (r.unitsWithoutCost > 0 ? String(r.unitsWithoutCost) : "0") },
              { key: "sold", header: t("financeCosts.col.soldAverage"), align: "end", hideOnMobile: true, render: (r) => (r.sold?.average ? money(r.sold.average, cur, locale) : "—") },
              {
                key: "batch",
                header: t("financeCosts.col.lastBatch"),
                align: "end",
                hideOnMobile: true,
                render: (r) => (r.lastBatch ? `${money(r.lastBatch.costPerGoodUnit, r.lastBatch.currency, locale)} · ${r.lastBatch.number}` : "—"),
              },
              {
                key: "edit",
                header: t("financeCosts.col.action"),
                render: (r) =>
                  r.model ? (
                    <Link to={href(`/finance/costs?model=${encodeURIComponent(r.model)}&color=${encodeURIComponent(r.color ?? "")}#manual-cost`)} preventScrollReset>
                      {t("financeCosts.models.bulkEdit")}
                    </Link>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
        )}
        {m.models.length > 0 ? (
          <div className="ot-card__body">
            <KeyValueList
              items={m.models.map((x) => ({
                key: x.model ?? `p:${x.productTitle ?? ""}`,
                label: t("financeCosts.models.modelAverage", { model: x.model ?? x.productTitle ?? t("financeCosts.models.noModel") }),
                value: x.average ? `${money(x.average, cur, locale)} (${money(x.value, cur, locale)} / ${formatNumber(x.qty, locale)})` : "—",
              }))}
            />
          </div>
        ) : null}
        <div className="ot-card__body">
          <SuggestionsBlock data={data} t={t} locale={locale} operationId={operationId} />
        </div>
      </Stack>
    </Card>
  );
}

function SuggestionsBlock({ data, t, locale, operationId }: SectionProps & { operationId: string }) {
  return (
    <Stack gap={3}>
      <Text variant="heading-sm">{t("financeCosts.suggestions.title")}</Text>
      <Text tone="subdued" variant="body-sm">
        {t("financeCosts.suggestions.description")}
      </Text>
      <Form method="post" preventScrollReset>
        <input type="hidden" name="intent" value="importShopify" />
        <input type="hidden" name="operationId" value={operationId} />
        <Button type="submit" variant="secondary" disabled={!data.shopifyAvailable}>
          {t("financeCosts.suggestions.import")}
        </Button>
      </Form>
      {!data.shopifyAvailable ? <Text tone="subdued">{t("financeCosts.suggestions.demoUnavailable")}</Text> : null}
      {data.suggestions.length > 0 ? (
        <Form method="post" preventScrollReset id="confirm-suggestions">
          <input type="hidden" name="intent" value="confirmSuggestions" />
          <input type="hidden" name="operationId" value={operationId} />
          <Stack gap={3}>
            <DataTable
              caption={t("financeCosts.suggestions.title")}
              rows={data.suggestions}
              rowKey={(r) => r.id}
              selection={{ name: "suggestionIds", value: (r) => r.id, label: (r) => r.productTitle, formId: "confirm-suggestions" }}
              columns={[
                { key: "item", header: t("financeCosts.col.item"), primary: true, render: (r) => [r.productTitle, r.variantTitle, r.sku ? `(${r.sku})` : null].filter(Boolean).join(" · ") },
                { key: "shopify", header: t("financeCosts.col.shopifyCost"), align: "end", render: (r) => money(r.unitCost, r.currency, locale) },
                { key: "current", header: t("financeCosts.col.manual"), align: "end", render: (r) => (r.current ? money(r.current.unitCost, r.current.currency, locale) : "—") },
                { key: "date", header: t("financeCosts.col.date"), hideOnMobile: true, render: (r) => formatIsoDate(r.suggestedOn, locale) },
              ]}
            />
            <FormLayout>
              <TextField label={t("financeCosts.form.effectiveFrom")} name="effectiveFrom" type="date" defaultValue={data.today} max={data.today} />
              <Checkbox name="applyToStock" label={t("financeCosts.form.applyToStock")} defaultChecked />
              <Checkbox name="applyToSold" label={t("financeCosts.form.applyToSold")} />
              <Button type="submit" variant="primary">
                {t("financeCosts.suggestions.confirm")}
              </Button>
            </FormLayout>
          </Stack>
        </Form>
      ) : (
        <Text tone="subdued">{t("financeCosts.suggestions.empty")}</Text>
      )}
    </Stack>
  );
}

function StockValueCard({ data, t, locale }: SectionProps) {
  const v = data.stockValue;
  const cur = v.currency;
  const hasAny = v.products.units + v.materials.units + v.unitsWithoutCost + v.negativeUnits > 0 || v.current.defectiveUnits > 0 || v.current.inProduction.length > 0;
  return (
    <Card title={t("financeCosts.stock.title")} description={t("financeCosts.stock.description")}>
      <Stack gap={3}>
        <Form method="get" preventScrollReset>
          <FormLayout>
            <TextField label={t("financeCosts.stock.date")} name="date" type="date" defaultValue={v.date} max={data.today} />
            <Button type="submit" variant="secondary">
              {t("financeCosts.stock.show")}
            </Button>
          </FormLayout>
        </Form>
        {!hasAny ? (
          <NoData t={t} />
        ) : (
          <KeyValueList
            items={[
              { key: "products", label: t("financeCosts.stock.products"), value: `${money(v.products.value, cur, locale)} · ${t("financeCosts.stock.units", { units: v.products.units })}` },
              { key: "materials", label: t("financeCosts.stock.materials"), value: `${money(v.materials.value, cur, locale)} · ${t("financeCosts.stock.units", { units: v.materials.units })}` },
              { key: "without", label: t("financeCosts.stock.withoutCost"), value: t("financeCosts.stock.unitsItems", { units: v.unitsWithoutCost, items: v.itemsWithoutCost }) },
              { key: "negative", label: t("financeCosts.stock.negative"), value: t("financeCosts.stock.units", { units: v.negativeUnits }) },
              {
                key: "production",
                label: t("financeCosts.stock.inProduction"),
                value: v.current.inProduction.length ? v.current.inProduction.map((p) => `${money(p.amount, p.currency, locale)} (${formatNumber(p.units, locale)})`).join(" + ") : "—",
              },
              { key: "defective", label: t("financeCosts.stock.defective"), value: t("financeCosts.stock.defectiveValue", { units: v.current.defectiveUnits }) },
            ]}
          />
        )}
        <Text tone="subdued" variant="body-sm">
          {t("financeCosts.stock.note")}
        </Text>
      </Stack>
    </Card>
  );
}

function BatchesCard({ data, t, locale, operationId }: SectionProps & { operationId: string }) {
  const rows = data.batches;
  return (
    <Card title={t("financeCosts.batches.title")} description={t("financeCosts.batches.description")} padded={rows.length === 0}>
      {rows.length === 0 ? (
        <NoData t={t} />
      ) : (
        <Stack gap={3}>
          <DataTable
            caption={t("financeCosts.batches.title")}
            rows={rows}
            rowKey={(r) => r.batchId}
            columns={[
              { key: "number", header: t("financeCosts.col.batch"), primary: true, render: (r) => `${r.number} · ${r.title}` },
              { key: "status", header: t("financeCosts.col.status"), render: (r) => <Badge tone="neutral">{t(`productionStatus.${r.status}`)}</Badge> },
              { key: "planned", header: t("financeCosts.col.planned"), align: "end", render: (r) => money(r.plannedTotal, r.currency, locale) },
              { key: "booked", header: t("financeCosts.col.booked"), align: "end", render: (r) => money(r.booked, r.bookedCurrency, locale) },
              { key: "unit", header: t("financeCosts.col.perGoodUnit"), align: "end", hideOnMobile: true, render: (r) => money(r.costPerGoodUnit, r.currency, locale) },
              { key: "defect", header: t("financeCosts.col.defectRate"), align: "end", hideOnMobile: true, render: (r) => (r.defectRate === null ? "—" : `${String(r.defectRate).replace(".", locale === "uk" ? "," : ".")} %`) },
              { key: "defectValue", header: t("financeCosts.col.defectValue"), align: "end", hideOnMobile: true, render: (r) => money(r.defectValue, r.currency, locale) },
              {
                key: "equivalent",
                header: t("financeCosts.col.producedInValuation"),
                align: "end",
                hideOnMobile: true,
                render: (r) => (r.currency === r.bookedCurrency ? "—" : money(r.producedInValuation, r.bookedCurrency, locale)),
              },
              {
                key: "adj",
                header: t("financeCosts.col.adjustments"),
                render: (r) =>
                  r.adjustments.count > 0
                    ? t("financeCosts.batches.adjustmentSplit", {
                        stock: money(r.adjustments.toStock, r.bookedCurrency, locale),
                        sales: money(r.adjustments.toSales, r.bookedCurrency, locale),
                        losses: money(r.adjustments.toLosses, r.bookedCurrency, locale),
                      })
                    : "—",
              },
            ]}
          />
          {rows
            .filter((r) => r.writeOffEligible)
            .map((r) => (
              <div className="ot-card__body" key={r.batchId}>
                <Disclosure summary={t("financeCosts.writeOff.title", { number: r.number })}>
                  <Stack gap={3}>
                    {r.writeOffs.length > 0 ? (
                      <Text tone="subdued">
                        {t("financeCosts.writeOff.already", { amounts: r.writeOffs.map((w) => money(w.amount, w.currency, locale)).join(", ") })}
                      </Text>
                    ) : null}
                    <Text tone="subdued" variant="body-sm">
                      {t("financeCosts.writeOff.description")}
                    </Text>
                    <Form method="post" preventScrollReset>
                      <input type="hidden" name="intent" value="writeOff" />
                      <input type="hidden" name="operationId" value={operationId} />
                      <input type="hidden" name="batchId" value={r.batchId} />
                      <FormLayout>
                        <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                          <TextField label={t("financeCosts.writeOff.amount")} name="amount" inputMode="decimal" required autoComplete="off" />
                          <Select label={t("financeCosts.form.currency")} name="currency" defaultValue={r.currency ?? data.valuationCurrency} options={data.currencies.map((c) => ({ value: c, label: c }))} />
                          <TextField label={t("financeCosts.col.date")} name="date" type="date" defaultValue={data.today} max={data.today} required />
                        </Grid>
                        <TextField label={t("financeCosts.writeOff.reason")} name="reason" required maxLength={200} />
                        <ConfirmSubmitButton
                          title={t("financeCosts.writeOff.submit")}
                          message={t("financeCosts.writeOff.confirm")}
                          confirmLabel={t("financeCosts.writeOff.submit")}
                          cancelLabel={t("financeCosts.writeOff.cancel")}
                          variant="primary"
                        >
                          {t("financeCosts.writeOff.submit")}
                        </ConfirmSubmitButton>
                      </FormLayout>
                    </Form>
                  </Stack>
                </Disclosure>
              </div>
            ))}
        </Stack>
      )}
    </Card>
  );
}

function DefectsCard({ data, t, locale }: SectionProps) {
  const d = data.defects;
  const empty = d.rows.length === 0 && d.units.marked + d.units.repaired + d.units.writtenOff + d.units.production + d.units.returnsDamaged === 0;
  return (
    <Card title={t("financeCosts.defects.title")} description={t("financeCosts.defects.description", { from: formatIsoDate(d.from, locale), to: formatIsoDate(d.to, locale) })}>
      <Stack gap={3}>
        <Form method="get" preventScrollReset>
          <Grid columns={{ xs: 1, md: 3 }} gap={3}>
            <TextField label={t("financeCosts.defects.from")} name="from" type="date" defaultValue={d.from} />
            <TextField label={t("financeCosts.defects.to")} name="to" type="date" defaultValue={d.to} max={data.today} />
            <Button type="submit" variant="secondary">
              {t("financeCosts.stock.show")}
            </Button>
          </Grid>
        </Form>
        {empty ? (
          <NoData t={t} />
        ) : (
          <>
            <KeyValueList
              items={[
                ...d.rows.map((r) => ({
                  key: `${r.category}:${r.kind}:${r.currency}`,
                  label: `${t(financeLabelKeys.category(r.category))} · ${t(`financeCosts.kind.${lossKindKey(r.kind)}`)}`,
                  value: `${money(r.amount, r.currency, locale)} (${formatNumber(r.entries, locale)})`,
                })),
                { key: "units", label: t("financeCosts.defects.units"), value: t("financeCosts.defects.unitsValue", d.units) },
              ]}
            />
          </>
        )}
      </Stack>
    </Card>
  );
}

const LOSS_KINDS = ["defect", "shortage", "shopify_external", "production_defect", "opening_correction", "test_order", "production_cancelled", "batch_adjustment", "repair", "surplus", "standard_recompute", "return_without_order"] as const;
function lossKindKey(kind: string): string {
  return (LOSS_KINDS as readonly string[]).includes(kind) ? kind : "other";
}

function HistoryCard({ data, t, locale }: SectionProps) {
  const h = data.history;
  const empty = h.series.length === 0 && h.manualCosts.length === 0 && h.changes.length === 0;
  return (
    <Card title={t("financeCosts.history.title")} description={t("financeCosts.history.description")}>
      {empty ? (
        <NoData t={t} />
      ) : (
        <Stack gap={4}>
          {h.series.length > 0 ? (
            <Stack gap={2}>
              <Text variant="heading-sm">{t("financeCosts.history.series", { item: data.targetLabel ?? "" })}</Text>
              <DataTable
                caption={t("financeCosts.history.series", { item: data.targetLabel ?? "" })}
                rows={h.series}
                rowKey={(r) => `${r.date}:${r.kind}:${r.knownQty}:${r.knownValue}`}
                columns={[
                  { key: "date", header: t("financeCosts.col.date"), primary: true, render: (r) => formatIsoDate(r.date, locale) },
                  { key: "kind", header: t("financeCosts.col.event"), render: (r) => t(`financeCosts.valuationKind.${r.kind}`) },
                  { key: "avg", header: t("financeCosts.col.stockAverage"), align: "end", render: (r) => money(r.average, data.valuationCurrency, locale) },
                  { key: "qty", header: t("financeCosts.col.qty"), align: "end", hideOnMobile: true, render: (r) => formatNumber(r.knownQty, locale) },
                ]}
              />
            </Stack>
          ) : null}
          {h.manualCosts.length > 0 ? (
            <Stack gap={2}>
              <Text variant="heading-sm">{t("financeCosts.history.manual")}</Text>
              <DataTable
                caption={t("financeCosts.history.manual")}
                rows={h.manualCosts}
                rowKey={(r) => r.id}
                columns={[
                  { key: "item", header: t("financeCosts.col.item"), primary: true, render: (r) => r.title || "—" },
                  { key: "cost", header: t("financeCosts.col.manual"), align: "end", render: (r) => money(r.unitCost, r.currency, locale) },
                  { key: "from", header: t("financeCosts.form.effectiveFrom"), render: (r) => formatIsoDate(r.effectiveFrom, locale) },
                  {
                    key: "source",
                    header: t("financeCosts.col.source"),
                    hideOnMobile: true,
                    render: (r) => `${t(`financeCosts.source.${r.source}`)}${r.confirmed ? "" : ` · ${t("financeCosts.history.unconfirmed")}`}`,
                  },
                ]}
              />
            </Stack>
          ) : null}
          {h.changes.length > 0 ? (
            <Stack gap={2}>
              <Text variant="heading-sm">{t("financeCosts.history.changes")}</Text>
              <DataTable
                caption={t("financeCosts.history.changes")}
                rows={h.changes}
                rowKey={(r) => String(r.id)}
                columns={[
                  { key: "when", header: t("financeCosts.col.date"), primary: true, render: (r) => formatDateTime(r.createdAt, locale) },
                  { key: "what", header: t("financeCosts.col.event"), render: (r) => `${t(financeLabelKeys.changeEntity(r.entityType as FinanceChangeEntityType))} · ${t(financeLabelKeys.changeAction(r.action as FinanceChangeAction))}` },
                  { key: "change", header: t("financeCosts.col.change"), render: (r) => describeChange(r.before, r.after, data.valuationCurrency, locale, t) },
                ]}
              />
            </Stack>
          ) : null}
        </Stack>
      )}
    </Card>
  );
}

/** «100,00 грн → 110,00 грн», «+60,00 грн до залишку, +40,00 грн до продажів» — лише дозволені поля історії. */
function describeChange(before: unknown, after: unknown, valuationCurrency: string, locale: "uk" | "en", t: TFunction): string {
  const b = (before ?? {}) as Record<string, unknown>;
  const a = (after ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : null);
  if (s(a.deltaStock) !== null || s(a.deltaSales) !== null) {
    return t("financeCosts.history.delta", { stock: money(s(a.deltaStock), s(a.currency) ?? valuationCurrency, locale), sales: money(s(a.deltaSales), s(a.currency) ?? valuationCurrency, locale) });
  }
  const field = s(a.unitCost) !== null || s(b.unitCost) !== null ? "unitCost" : s(a.extraCost) !== null || s(b.extraCost) !== null ? "extraCost" : s(a.value) !== null ? "value" : null;
  if (!field) return "—";
  const cur = (o: Record<string, unknown>) => s(o.currency) ?? valuationCurrency;
  const from = s(b[field]) !== null ? money(s(b[field]), cur(b), locale) : "—";
  const to = s(a[field]) !== null ? money(s(a[field]), cur(a), locale) : "—";
  return field === "value" ? to : `${from} → ${to}`;
}

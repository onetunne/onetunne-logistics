import { useState, type ReactNode } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useHref } from "~/components/shell";
import type { ProductionBatchStatus } from "~/db/schema";
import { can } from "~/domain/permissions";
import { useLocale, useT, type TFunction } from "~/i18n";
import { formatDate, formatDateTime, formatNumber } from "~/lib/format";
import type { Locale } from "~/i18n/types";
import { movementHistory, type MovementType } from "~/modules/inventory/ledger.server";
import {
  UUID_RE,
  cancelBatch,
  closeBatch,
  createBatch,
  receiveProduction,
  startProduction,
  updateBatch,
  updateBatchCosts,
  type BatchInput,
  type BatchLineInput,
  type ReceiptLineInput,
} from "~/modules/production/batches.server";
import { BATCH_STATUS_TONE, LIMITS, NOT_RECEIVED_STATUSES, formatCost, isStatusIn, kyivDate, parseQuantityInput } from "~/modules/production/calc";
import { FIELD_ERRORS, ProductionValidationError } from "~/modules/production/errors";
import {
  getBatchDetail,
  listProductsForPicker,
  loadVariantGrid,
  variantProductIds,
  type BatchDetail,
  type GridVariant,
  type VariantGridProduct,
} from "~/modules/production/queries.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import type { ServiceContext } from "~/server/types";
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
  Thumbnail,
  Timeline,
  type DataTableColumn,
  type TimelineItem,
} from "~/ui";
import { parseProductionPrefill } from "~/modules/warehouse-analytics/calc";
import { DEFAULT_COST_CURRENCY } from "~/modules/warehouse/constants";

/**
 * Виробнича партія (етап 5): /production/new — створення; /production/:id — картка (позиції, брак, надходження,
 * дії з підтвердженням); ?edit=1 — зміна запланованої партії. Сітка «модель × колір» для кількостей.
 * Перегляд — warehouse.view; надходження — warehouse.receive; керування — production.manage;
 * собівартість — лише finance.view (у даних loader для інших її немає).
 */

const CURRENCIES = ["UAH", "EUR", "USD", "PLN", "GBP", "CNY", "TRY"];
const MAX_PICKER_QUERY = 100;
const MAX_SELECTED_PRODUCTS = 20;

type Mode = "create" | "view" | "edit";
type Notice = "created" | "updated" | null;

function serializeDetail(d: BatchDetail) {
  return {
    ...d,
    batch: { ...d.batch, createdAt: d.batch.createdAt.toISOString(), updatedAt: d.batch.updatedAt.toISOString() },
    receipts: d.receipts.map((r) => ({ ...r, receivedAt: r.receivedAt.toISOString() })),
  };
}

async function loadEditor(ctx: ServiceContext, url: URL, lockedProducts: string[]) {
  const pq = (url.searchParams.get("pq") ?? "").trim().slice(0, MAX_PICKER_QUERY);
  const chosen = url.searchParams.getAll("product").filter((id) => UUID_RE.test(id)).map((id) => id.toLowerCase());
  const selected = [...new Set([...lockedProducts, ...chosen])].slice(0, MAX_SELECTED_PRODUCTS + lockedProducts.length);
  const [picker, grid] = await Promise.all([listProductsForPicker(ctx.db, { search: pq, limit: 30 }), loadVariantGrid(ctx.db, selected)]);
  return { pq, selected, locked: [...new Set(lockedProducts)], picker, grid };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  const batchId = params.batchId ?? "";
  const includeCosts = can(ctx.actor, "finance.view");
  const canManage = can(ctx.actor, "production.manage");
  const canReceive = can(ctx.actor, "warehouse.receive");
  const today = kyivDate(ctx.now());
  const noticeRaw = url.searchParams.get("notice");
  const base = {
    canManage,
    canReceive,
    canSeeCosts: includeCosts,
    today,
    currencies: CURRENCIES,
    notice: (noticeRaw === "created" || noticeRaw === "updated" ? noticeRaw : null) as Notice,
  };

  if (batchId === "new") {
    if (!canManage) throw new Response("Forbidden", { status: 403 });
    const created = await loadEditor(ctx, url, []);
    // Рекомендації аналітики (qty.<variantId>): лише для варіантів сітки; партію створює тільки збереження форми.
    const prefill = parseProductionPrefill(url.searchParams, {
      allowedVariantIds: created.grid.flatMap((p) => p.variants.map((v) => v.id)),
    });
    const values: Record<string, { qty: number; cost?: string | null }> = Object.fromEntries(
      Object.entries(prefill).map(([id, qty]) => [id, { qty }]),
    );
    return {
      ...base,
      mode: "create" as Mode,
      detail: null,
      editor: { ...created, values },
      receiptKey: null,
      lastReceiptId: null,
      movements: [],
    };
  }

  const detail = await getBatchDetail(ctx.db, batchId, { today, includeCosts });
  if (!detail) throw new Response("Not Found", { status: 404 });
  const edit = url.searchParams.get("edit") === "1" && canManage && detail.allowed.edit;
  let editor = null;
  if (edit) {
    const values: Record<string, { qty: number; cost?: string | null }> = {};
    for (const l of detail.lines) {
      values[l.variantId] = includeCosts ? { qty: l.ordered, cost: detail.costs?.lineUnitCosts[l.id] ?? null } : { qty: l.ordered };
    }
    editor = { ...(await loadEditor(ctx, url, detail.lines.map((l) => l.productId))), values };
  }
  const movements = edit
    ? []
    : (await movementHistory(ctx.db, { productionBatchId: detail.batch.id }, { limit: 200 }, { includeCosts: false })).rows.map((m) => ({
        id: m.id,
        createdAt: m.createdAt.toISOString(),
        type: m.type,
        title: m.title,
        variantTitle: m.variantTitle && m.variantTitle !== "Default Title" ? m.variantTitle : null,
        sku: m.sku,
        onHandDelta: m.onHandDelta,
        defectiveDelta: m.defectiveDelta,
        inProductionDelta: m.inProductionDelta,
        actorName: m.actorName,
      }));
  return {
    ...base,
    mode: (edit ? "edit" : "view") as Mode,
    detail: serializeDetail(detail),
    editor,
    // Ключ форми надходження: повторне надсилання тієї самої форми не дублює надходження.
    receiptKey: canReceive && detail.allowed.receive ? globalThis.crypto.randomUUID() : null,
    lastReceiptId: detail.receipts[0]?.id ?? null,
    movements,
  };
}

// ---------------------------------------------------------------------------
// Дії
// ---------------------------------------------------------------------------

function parseVersion(form: FormData): number {
  const raw = formString(form, "version");
  return /^\d{1,9}$/.test(raw) ? Number(raw) : -1;
}

/** Поля форми партії → BatchInput. Ціни — лише для finance.view (інакше поля ігноруються, ціни не змінюються). */
async function batchInputFromForm(ctx: ServiceContext, form: FormData): Promise<BatchInput> {
  const includeCosts = can(ctx.actor, "finance.view");
  const variantIds = [...new Set([...form.keys()].filter((k) => k.startsWith("qty.")).map((k) => k.slice(4).toLowerCase()))].filter((id) =>
    UUID_RE.test(id),
  );
  const productOf = includeCosts ? await variantProductIds(ctx.db, variantIds) : new Map<string, string>();
  const errors: Record<string, string> = {};
  const lines: BatchLineInput[] = [];
  for (const variantId of variantIds) {
    const qty = parseQuantityInput(formString(form, `qty.${variantId}`));
    if (qty === "invalid") {
      errors[`qty.${variantId}`] = FIELD_ERRORS.invalidQuantity;
      continue;
    }
    if (qty === 0) continue;
    const line: BatchLineInput = { variantId, quantity: qty };
    if (includeCosts) {
      const own = formString(form, `cost.${variantId}`).trim();
      const productId = productOf.get(variantId);
      const fallback = productId ? formString(form, `defaultCost.${productId}`).trim() : "";
      line.unitCost = own || fallback || null;
    }
    lines.push(line);
  }
  if (Object.keys(errors).length > 0) throw new ProductionValidationError(errors);
  return {
    title: formString(form, "title"),
    plannedReadyDate: formString(form, "plannedReadyDate"),
    manufacturer: formString(form, "manufacturer"),
    notes: formString(form, "notes"),
    ...(includeCosts ? { extraCost: formString(form, "extraCost"), costCurrency: formString(form, "costCurrency") } : {}),
    lines,
  };
}

function receiptLinesFromForm(form: FormData): ReceiptLineInput[] {
  const ids = [
    ...new Set(
      [...form.keys()].filter((k) => k.startsWith("good.") || k.startsWith("defective.")).map((k) => k.slice(k.indexOf(".") + 1).toLowerCase()),
    ),
  ].filter((id) => UUID_RE.test(id));
  const errors: Record<string, string> = {};
  const lines: ReceiptLineInput[] = [];
  for (const id of ids) {
    const good = parseQuantityInput(formString(form, `good.${id}`));
    const defective = parseQuantityInput(formString(form, `defective.${id}`));
    if (good === "invalid") errors[`good.${id}`] = FIELD_ERRORS.invalidQuantity;
    if (defective === "invalid") errors[`defective.${id}`] = FIELD_ERRORS.invalidQuantity;
    if (good === "invalid" || defective === "invalid") continue;
    lines.push({ batchLineId: id, good, defective, defectReason: formString(form, `reason.${id}`) });
  }
  if (Object.keys(errors).length > 0) throw new ProductionValidationError(errors);
  return lines;
}

export async function action({ request, params }: ActionFunctionArgs): Promise<ActionResult | Response> {
  const ctx = await getRequestContext(request);
  const batchId = params.batchId ?? "";
  try {
    const form = await request.formData();
    const intent = formString(form, "intent");
    const version = parseVersion(form);
    if (batchId === "new") {
      if (intent !== "create") return { ok: false, error: "error.generic" };
      const created = await createBatch(ctx, await batchInputFromForm(ctx, form));
      return redirect(`${ctx.basePath}/production/${created.batchId}?notice=created`);
    }
    switch (intent) {
      case "update": {
        await updateBatch(ctx, batchId, version, await batchInputFromForm(ctx, form));
        return redirect(`${ctx.basePath}/production/${batchId}?notice=updated`);
      }
      case "start": {
        const r = await startProduction(ctx, batchId, version);
        return { ok: true, message: "production.result.started", params: { lines: r.lines, units: r.units } };
      }
      case "close": {
        const r = await closeBatch(ctx, batchId, version);
        return { ok: true, message: "production.result.closed", params: { units: r.closedUnits } };
      }
      case "cancel": {
        const r = await cancelBatch(ctx, batchId, version);
        return { ok: true, message: "production.result.cancelled", params: { units: r.releasedUnits } };
      }
      case "receive":
      case "receiveRemaining": {
        const r = await receiveProduction(ctx, batchId, {
          idempotencyKey: formString(form, "receiptKey"),
          lines: intent === "receiveRemaining" ? "remaining" : receiptLinesFromForm(form),
          note: formString(form, "note"),
          allowOverReceipt: intent === "receive" && form.has("allowOver"),
        });
        if (r.duplicate) return { ok: true, message: "production.result.receiptDuplicate", tone: "info", params: { good: r.good, defective: r.defective } };
        const extra = [
          ...(r.overReceived > 0 ? ["production.result.overReceived"] : []),
          ...(r.status === "received" ? ["production.result.fullyReceived"] : []),
        ];
        return { ok: true, message: "production.result.received", params: { good: r.good, defective: r.defective, over: r.overReceived }, extra };
      }
      case "updateCosts": {
        const lineCosts = [...form.keys()]
          .filter((k) => k.startsWith("lineCost."))
          .map((k) => ({ batchLineId: k.slice("lineCost.".length), unitCost: formString(form, k) }));
        await updateBatchCosts(ctx, batchId, version, {
          extraCost: formString(form, "extraCost"),
          costCurrency: formString(form, "costCurrency"),
          lines: lineCosts,
        });
        return { ok: true, message: "production.result.costsUpdated" };
      }
      default:
        return { ok: false, error: "error.generic" };
    }
  } catch (e) {
    if (e instanceof ProductionValidationError) return { ok: false, error: "error.validation", fieldErrors: e.fieldErrors };
    return toActionError(e);
  }
}

// ---------------------------------------------------------------------------
// Інтерфейс
// ---------------------------------------------------------------------------

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Detail = NonNullable<Data["detail"]>;
type Line = Detail["lines"][number];
type Editor = NonNullable<Data["editor"]>;

function useFieldErrors(): Record<string, string> {
  const actionData = useActionData<typeof action>();
  return actionData && !actionData.ok ? (actionData.fieldErrors ?? {}) : {};
}

function lineName(l: { productTitle: string; variantTitle: string | null }): string {
  return l.variantTitle ? `${l.productTitle} · ${l.variantTitle}` : l.productTitle;
}

function money(amount: string | null | undefined, currency: string | null | undefined, locale: Locale): string {
  return amount && currency ? formatCost(amount, currency, locale) : "—";
}

function StatusBadges({ status, overdue }: { status: ProductionBatchStatus; overdue: boolean }) {
  const t = useT();
  return (
    <Stack direction="horizontal" gap={1}>
      <Badge tone={BATCH_STATUS_TONE[status]}>{t(`productionStatus.${status}`)}</Badge>
      {overdue ? <Badge tone="critical">{t("production.overdue")}</Badge> : null}
    </Stack>
  );
}

function LineCell({ line }: { line: Pick<Line, "productTitle" | "variantTitle" | "sku" | "imageUrl"> }) {
  return (
    <Stack direction="horizontal" gap={2} align="center" wrap={false}>
      <Thumbnail src={line.imageUrl} alt={line.productTitle} size="sm" />
      <Stack gap={0}>
        <Text as="span" weight="medium">
          {lineName(line)}
        </Text>
        {line.sku ? (
          <Text as="span" variant="caption" tone="subdued">
            {line.sku}
          </Text>
        ) : null}
      </Stack>
    </Stack>
  );
}

export default function ProductionBatchPage() {
  const data = useLoaderData<typeof loader>();
  if (data.mode !== "view" && data.editor) return <BatchEditor data={data} editor={data.editor} />;
  return <BatchView data={data} detail={data.detail!} />;
}

// ---------------------------------------------------------------------------
// Картка партії
// ---------------------------------------------------------------------------

function BatchView({ data, detail }: { data: Data; detail: Detail }) {
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busyIntent = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;
  const busy = navigation.state !== "idle";
  const { batch, totals, allowed } = detail;
  const costs = detail.costs;
  const lineCost = new Map((costs?.summary.lines ?? []).map((l) => [l.id, l]));
  const currency = costs?.summary.currency ?? costs?.currency ?? null;
  const remainingLines = detail.lines.filter((l) => l.remaining > 0).length;
  // Залишок (замовлено − виготовлено) означає різне залежно від стану: «у виробництві» — лише для запущеної партії.
  const kind = detail.remainderKind;

  const lineColumns: Array<DataTableColumn<Line>> = [
    { key: "item", header: t("production.lines.item"), primary: true, render: (l) => <LineCell line={l} /> },
    { key: "model", header: t("production.lines.model"), render: (l) => l.model ?? "—", hideOnMobile: !detail.lines.some((l) => l.model) },
    { key: "color", header: t("production.lines.color"), render: (l) => l.color ?? "—", hideOnMobile: !detail.lines.some((l) => l.color) },
    { key: "ordered", header: t("production.lines.ordered"), align: "end", render: (l) => formatNumber(l.ordered, locale) },
    { key: "received", header: t("production.lines.received"), align: "end", render: (l) => formatNumber(l.received, locale) },
    {
      key: "defective",
      header: t("production.lines.defective"),
      align: "end",
      render: (l) => (l.defective > 0 ? t("production.defectValue", { count: formatNumber(l.defective, locale), rate: formatNumber(l.defectRate ?? 0, locale) }) : "0"),
    },
  ];
  // Запланована партія: «до виготовлення» = «замовлено» — окрема колонка не потрібна (див. підсумки).
  if (kind !== "toProduce") {
    lineColumns.push({
      key: "remaining",
      header: kind === "notProduced" ? t("production.lines.notProduced") : t("production.lines.remaining"),
      align: "end",
      render: (l) => (l.overReceived > 0 ? t("production.lines.overValue", { count: formatNumber(l.overReceived, locale) }) : formatNumber(l.remaining, locale)),
    });
  }
  if (costs) {
    lineColumns.push(
      { key: "unitCost", header: t("production.cost.unitCost"), align: "end", render: (l) => money(lineCost.get(l.id)?.unitCost, currency, locale) },
      { key: "lineTotal", header: t("production.cost.lineTotal"), align: "end", render: (l) => money(lineCost.get(l.id)?.total, currency, locale) },
      {
        key: "perGood",
        header: t("production.cost.perGoodUnit"),
        align: "end",
        render: (l) => money(lineCost.get(l.id)?.costPerGoodUnit, currency, locale),
      },
    );
  }

  const lineById = new Map(detail.lines.map((l) => [l.id, l]));
  const timeline: TimelineItem[] = detail.receipts.map((r) => ({
    id: r.id,
    tone: r.defective > 0 ? "warning" : "success",
    title: t("production.receipts.itemTitle", { good: formatNumber(r.good, locale), defective: formatNumber(r.defective, locale) }),
    time: formatDateTime(r.receivedAt, locale),
    description: (
      <Stack gap={1}>
        <Text variant="body-sm" tone="subdued">
          {t("production.receipts.by", { name: r.receivedByName })}
        </Text>
        <Stack as="ul" gap={0}>
          {r.lines.map((rl) => {
            const l = lineById.get(rl.batchLineId);
            return (
              <Text as="li" variant="body-sm" key={rl.batchLineId}>
                {t("production.receipts.line", {
                  item: l ? lineName(l) : "—",
                  good: formatNumber(rl.good, locale),
                  defective: formatNumber(rl.defective, locale),
                })}
                {rl.defectReason ? ` — ${t("production.receipts.reason", { reason: rl.defectReason })}` : ""}
              </Text>
            );
          })}
        </Stack>
        {r.note ? <Text variant="body-sm">{t("production.receipts.note", { note: r.note })}</Text> : null}
      </Stack>
    ),
  }));

  const showActions = data.canManage && (allowed.edit || allowed.start || allowed.close || allowed.cancel);

  return (
    <Page
      title={batch.number}
      titleMeta={<StatusBadges status={batch.status} overdue={batch.overdue} />}
      subtitle={batch.title}
      backHref={href("production")}
      backLabel={t("production.backToList")}
      secondaryActions={
        data.canManage && allowed.edit ? (
          <Button to={`${href(`production/${batch.id}`)}?edit=1`}>{t("production.edit")}</Button>
        ) : null
      }
    >
      <Stack gap={4}>
        <ActionBanner data={actionData} />
        {!actionData && data.notice ? <Banner tone="success">{t(`production.notice.${data.notice}`, { number: batch.number })}</Banner> : null}
        {batch.overdue ? <Banner tone="warning">{t("production.overdueDetail", { date: formatDate(batch.plannedReadyDate, locale) })}</Banner> : null}

        <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
          <Card title={t("production.detail.batchTitle")}>
            <KeyValueList
              items={[
                { key: "title", label: t("production.field.title"), value: batch.title },
                { key: "manufacturer", label: t("production.field.manufacturer"), value: batch.manufacturer ?? "—" },
                {
                  key: "ready",
                  label: t("production.field.plannedReadyDate"),
                  value: batch.plannedReadyDate ? formatDate(batch.plannedReadyDate, locale) : "—",
                },
                { key: "created", label: t("production.detail.created"), value: formatDateTime(batch.createdAt, locale) },
                { key: "updated", label: t("production.detail.updated"), value: formatDateTime(batch.updatedAt, locale) },
                ...(batch.notes ? [{ key: "notes", label: t("production.field.notes"), value: batch.notes }] : []),
              ]}
            />
          </Card>
          <Card title={t("production.detail.totalsTitle")}>
            <KeyValueList
              items={[
                { key: "ordered", label: t("production.totals.ordered"), value: formatNumber(totals.ordered, locale) },
                { key: "received", label: t("production.totals.received"), value: formatNumber(totals.received, locale) },
                {
                  key: "defective",
                  label: t("production.totals.defective"),
                  value: totals.defective > 0 ? t("production.defectValue", { count: formatNumber(totals.defective, locale), rate: formatNumber(totals.defectRate ?? 0, locale) }) : "0",
                },
                kind === "inProduction"
                  ? { key: "remaining", label: t("production.totals.remaining"), value: formatNumber(detail.inProduction, locale) }
                  : kind === "toProduce"
                    ? { key: "toProduce", label: t("production.totals.toProduce"), value: formatNumber(totals.remaining, locale) }
                    : {
                        key: "notProduced",
                        label: t(batch.status === "cancelled" ? "production.totals.notProducedCancelled" : "production.totals.notProduced"),
                        value: formatNumber(totals.remaining, locale),
                      },
                ...(totals.overReceived > 0
                  ? [{ key: "over", label: t("production.totals.overReceived"), value: formatNumber(totals.overReceived, locale) }]
                  : []),
              ]}
            />
          </Card>
        </Grid>

        {showActions ? (
          <Card title={t("production.actions.title")}>
            <Form method="post">
              <input type="hidden" name="version" value={batch.version} />
              <Stack direction="horizontal" gap={2}>
                {allowed.start ? (
                  <ConfirmSubmitButton
                    variant="primary"
                    name="intent"
                    value="start"
                    loading={busyIntent === "start"}
                    disabled={busy}
                    title={t("production.actions.startTitle")}
                    message={t("production.actions.startConfirm", { lines: totals.lines, units: formatNumber(totals.ordered, locale) })}
                    confirmLabel={t("production.actions.start")}
                    cancelLabel={t("common.cancel")}
                  >
                    {t("production.actions.start")}
                  </ConfirmSubmitButton>
                ) : null}
                {allowed.close ? (
                  <ConfirmSubmitButton
                    name="intent"
                    value="close"
                    loading={busyIntent === "close"}
                    disabled={busy}
                    title={t("production.actions.closeTitle")}
                    message={
                      detail.inProduction > 0
                        ? t("production.actions.closeConfirm", { units: formatNumber(detail.inProduction, locale), lines: remainingLines })
                        : t("production.actions.closeConfirmNothing")
                    }
                    confirmLabel={t("production.actions.close")}
                    cancelLabel={t("common.cancel")}
                  >
                    {t("production.actions.close")}
                  </ConfirmSubmitButton>
                ) : null}
                {allowed.cancel ? (
                  <ConfirmSubmitButton
                    variant="critical"
                    name="intent"
                    value="cancel"
                    loading={busyIntent === "cancel"}
                    disabled={busy}
                    title={t("production.actions.cancelTitle")}
                    message={
                      batch.status === "planned"
                        ? t("production.actions.cancelPlannedConfirm")
                        : t("production.actions.cancelStartedConfirm", { units: formatNumber(detail.inProduction, locale) })
                    }
                    confirmLabel={t("production.actions.cancel")}
                    cancelLabel={t("common.back")}
                  >
                    {t("production.actions.cancel")}
                  </ConfirmSubmitButton>
                ) : null}
              </Stack>
            </Form>
          </Card>
        ) : null}

        {data.canReceive && allowed.receive && data.receiptKey ? (
          <ReceiptForm detail={detail} receiptKey={data.receiptKey} formKey={data.lastReceiptId ?? "first"} />
        ) : null}

        <Card title={t("production.lines.title", { count: totals.lines })} padded={false}>
          <DataTable
            caption={t("production.lines.title", { count: totals.lines })}
            columns={lineColumns}
            rows={detail.lines}
            rowKey={(l) => l.id}
            emptyState={<EmptyState title={t("production.lines.empty")} />}
          />
        </Card>

        {costs ? <CostsCard data={data} detail={detail} /> : null}

        <Card title={t("production.receipts.title", { count: detail.receipts.length })}>
          {timeline.length > 0 ? <Timeline items={timeline} /> : <Text tone="subdued">{t("production.receipts.empty")}</Text>}
        </Card>

        {data.movements.length > 0 ? (
          <Card>
            <Disclosure summary={t("production.movements.title", { count: data.movements.length })}>
              <Stack as="ul" gap={2}>
                {data.movements.map((m) => (
                  <Stack as="li" key={m.id} gap={0}>
                    <Text variant="body-sm" weight="semibold">
                      {t(`movementType.${m.type as MovementType}`)} · {m.variantTitle ? `${m.title} · ${m.variantTitle}` : m.title}
                    </Text>
                    <Text variant="caption" tone="subdued">
                      {formatDateTime(m.createdAt, locale)} · {m.actorName} · {deltaText(m, t)}
                    </Text>
                  </Stack>
                ))}
              </Stack>
            </Disclosure>
          </Card>
        ) : null}
      </Stack>
    </Page>
  );
}

function deltaText(m: { onHandDelta: number; defectiveDelta: number; inProductionDelta: number }, t: TFunction): string {
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  return [
    m.onHandDelta ? `${t("inventory.bucket.onHand")} ${sign(m.onHandDelta)}` : null,
    m.defectiveDelta ? `${t("inventory.bucket.defective")} ${sign(m.defectiveDelta)}` : null,
    m.inProductionDelta ? `${t("inventory.bucket.inProduction")} ${sign(m.inProductionDelta)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function ReceiptForm({ detail, receiptKey, formKey }: { detail: Detail; receiptKey: string; formKey: string }) {
  const t = useT();
  const locale = useLocale();
  const errors = useFieldErrors();
  const navigation = useNavigation();
  const busyIntent = navigation.state === "submitting" ? navigation.formData?.get("intent") : null;
  const busy = navigation.state !== "idle";
  const { totals } = detail;
  const remainingLines = detail.lines.filter((l) => l.remaining > 0);
  const err = (name: string) => (errors[name] ? t(errors[name]!, { max: LIMITS.quantity }) : undefined);

  return (
    <Card id="receive" title={t("production.receive.title")} description={t("production.receive.help")}>
      {/* key: після успішного надходження форма очищується; після помилки введене лишається. */}
      <Form method="post" key={formKey}>
        <input type="hidden" name="receiptKey" value={receiptKey} />
        <Stack gap={4}>
          {detail.batch.status === "received" ? <Banner tone="info">{t("production.receive.allReceived")}</Banner> : null}
          {detail.lines.map((l) => (
            <Stack key={l.id} gap={2}>
              <Stack direction="horizontal" gap={2} align="center" justify="between">
                <LineCell line={l} />
                <Text as="span" variant="body-sm" tone={l.remaining > 0 ? "default" : "subdued"}>
                  {t("production.receive.remaining", { count: formatNumber(l.remaining, locale), ordered: formatNumber(l.ordered, locale) })}
                </Text>
              </Stack>
              <Grid columns={{ xs: 2 }} gap={3}>
                <TextField
                  id={`good-${l.id}`}
                  name={`good.${l.id}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={LIMITS.quantity}
                  step={1}
                  placeholder="0"
                  label={t("production.receive.good")}
                  error={err(`good.${l.id}`)}
                />
                <TextField
                  id={`defective-${l.id}`}
                  name={`defective.${l.id}`}
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={LIMITS.quantity}
                  step={1}
                  placeholder="0"
                  label={t("production.receive.defective")}
                  error={err(`defective.${l.id}`)}
                />
              </Grid>
              <Disclosure summary={t("production.receive.defectReason")} defaultOpen={Boolean(errors[`reason.${l.id}`])}>
                <TextField
                  id={`reason-${l.id}`}
                  name={`reason.${l.id}`}
                  label={t("production.receive.defectReasonLabel", { item: lineName(l) })}
                  labelHidden
                  maxLength={LIMITS.defectReason}
                  placeholder={t("production.receive.defectReasonPlaceholder")}
                  error={errors[`reason.${l.id}`] ? t(errors[`reason.${l.id}`]!, { max: LIMITS.defectReason }) : undefined}
                />
              </Disclosure>
            </Stack>
          ))}
          <TextField
            id="receipt-note"
            name="note"
            multiline={2}
            maxLength={LIMITS.receiptNote}
            label={t("production.receive.note")}
            helpText={t("production.receive.noteHelp")}
            error={errors.note ? t(errors.note, { max: LIMITS.receiptNote }) : undefined}
          />
          <Checkbox id="receipt-allow-over" name="allowOver" label={t("production.receive.allowOver")} helpText={t("production.receive.allowOverHelp")} />
          <Stack direction="horizontal" gap={2}>
            {/* Перша кнопка надсилання — типова для Enter. */}
            <Button type="submit" variant="primary" name="intent" value="receive" loading={busyIntent === "receive"} disabled={busy}>
              {t("production.receive.submit")}
            </Button>
            {totals.remaining > 0 ? (
              <ConfirmSubmitButton
                name="intent"
                value="receiveRemaining"
                loading={busyIntent === "receiveRemaining"}
                disabled={busy}
                title={t("production.receive.remainingTitle")}
                message={
                  <Stack gap={2}>
                    <Text weight="semibold">
                      {t("production.receive.remainingConfirm", { units: formatNumber(totals.remaining, locale), lines: remainingLines.length })}
                    </Text>
                    <Text variant="body-sm" tone="subdued">
                      {t("production.receive.remainingNote")}
                    </Text>
                  </Stack>
                }
                confirmLabel={t("production.receive.remainingConfirmLabel")}
                cancelLabel={t("common.cancel")}
              >
                {t("production.receive.remainingButton")}
              </ConfirmSubmitButton>
            ) : null}
          </Stack>
        </Stack>
      </Form>
    </Card>
  );
}

function CostsCard({ data, detail }: { data: Data; detail: Detail }) {
  const t = useT();
  const locale = useLocale();
  const errors = useFieldErrors();
  const costs = detail.costs!;
  const s = costs.summary;
  const currency = s.currency ?? costs.currency;
  const currencies = costs.currency && !data.currencies.includes(costs.currency) ? [...data.currencies, costs.currency] : data.currencies;
  // Поки партію не отримано повністю, загальна — планова, а собівартість якісної одиниці — лише за вже отриманим.
  const unfinished = isStatusIn(detail.batch.status, NOT_RECEIVED_STATUSES);
  return (
    <Card title={t("production.cost.title")} description={t("production.cost.ownerOnly")}>
      <Stack gap={4}>
        <KeyValueList
          items={[
            { key: "lines", label: t("production.cost.linesTotal"), value: money(s.linesTotal, currency, locale) },
            { key: "extra", label: t("production.cost.extraCost"), value: money(s.extraCost, currency, locale) },
            {
              key: "total",
              label: t(unfinished ? "production.cost.totalPlanned" : "production.cost.total"),
              value: <Text weight="semibold">{money(s.total, currency, locale)}</Text>,
            },
            ...(unfinished && detail.totals.produced > 0
              ? [{ key: "produced", label: t("production.cost.producedTotal"), value: money(s.producedTotal, currency, locale) }]
              : []),
            { key: "good", label: t("production.cost.goodReceived"), value: formatNumber(s.goodReceived, locale) },
            {
              key: "perGood",
              label: t(unfinished ? "production.cost.perGoodUnitSoFar" : "production.cost.perGoodUnit"),
              value: <Text weight="semibold">{money(s.costPerGoodUnit, currency, locale)}</Text>,
            },
          ]}
        />
        {!s.complete && detail.lines.length > 0 ? (
          <Banner tone="warning">{t("production.cost.incomplete", { count: s.linesWithoutCost })}</Banner>
        ) : null}
        <Text variant="body-sm" tone="subdued">
          {t("production.cost.formula")}
        </Text>
        {data.canManage && detail.allowed.updateCosts ? (
          <Disclosure summary={t("production.cost.edit")} defaultOpen={Object.keys(errors).some((k) => k.startsWith("lineCost.") || k === "extraCost" || k === "costCurrency")}>
            <Form method="post">
              <input type="hidden" name="version" value={detail.batch.version} />
              <Stack gap={3}>
                <FormLayout columns={2}>
                  <TextField
                    id="costs-extra"
                    name="extraCost"
                    inputMode="decimal"
                    label={t("production.cost.extraCost")}
                    helpText={t("production.cost.extraCostHelp")}
                    defaultValue={costs.extraCost ?? ""}
                    error={errors.extraCost ? t(errors.extraCost) : undefined}
                  />
                  <Select
                    id="costs-currency"
                    name="costCurrency"
                    label={t("production.cost.currency")}
                    options={currencies.map((c) => ({ value: c, label: c }))}
                    defaultValue={costs.currency ?? DEFAULT_COST_CURRENCY}
                    error={errors.costCurrency ? t(errors.costCurrency) : undefined}
                  />
                </FormLayout>
                {detail.lines.map((l) => (
                  <TextField
                    key={l.id}
                    id={`line-cost-${l.id}`}
                    name={`lineCost.${l.id}`}
                    inputMode="decimal"
                    label={t("production.cost.unitCostFor", { item: lineName(l) })}
                    defaultValue={costs.lineUnitCosts[l.id] ?? ""}
                    error={errors[`lineCost.${l.id}`] ? t(errors[`lineCost.${l.id}`]!) : undefined}
                  />
                ))}
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" name="intent" value="updateCosts">
                    {t("production.cost.save")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Disclosure>
        ) : null}
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Створення / зміна партії
// ---------------------------------------------------------------------------

interface GridRow {
  key: string;
  model: string | null;
  cells: Map<string, GridVariant[]>;
}

const colorKey = (c: string | null) => (c === null ? "\u0000none" : `c:${c}`);

function gridRows(p: VariantGridProduct): GridRow[] {
  return p.models.map((model) => {
    const cells = new Map<string, GridVariant[]>();
    for (const v of p.variants.filter((x) => x.model === model)) cells.set(colorKey(v.color), [...(cells.get(colorKey(v.color)) ?? []), v]);
    return { key: model === null ? "\u0000none" : `m:${model}`, model, cells };
  });
}

function VariantInputs({
  variants,
  product,
  editor,
  showCosts,
  errors,
}: {
  variants: GridVariant[];
  product: VariantGridProduct;
  editor: Editor;
  showCosts: boolean;
  errors: Record<string, string>;
}) {
  const t = useT();
  if (variants.length === 0) return <Text tone="subdued">—</Text>;
  return (
    <Stack gap={2}>
      {variants.map((v) => {
        const label = [product.title, v.model, v.color, v.title].filter(Boolean).join(" · ");
        const value = editor.values[v.id];
        return (
          <Stack key={v.id} gap={1}>
            {variants.length > 1 ? (
              <Text as="span" variant="caption" tone="subdued">
                {v.title ?? v.sku ?? "—"}
              </Text>
            ) : null}
            <TextField
              id={`qty-${v.id}`}
              name={`qty.${v.id}`}
              type="number"
              inputMode="numeric"
              min={0}
              max={LIMITS.quantity}
              step={1}
              placeholder="0"
              label={t("production.grid.qtyFor", { item: label })}
              labelHidden
              defaultValue={value?.qty ? String(value.qty) : ""}
              error={errors[`qty.${v.id}`] ? t(errors[`qty.${v.id}`]!, { max: LIMITS.quantity }) : undefined}
            />
            {showCosts ? (
              <TextField
                id={`cost-${v.id}`}
                name={`cost.${v.id}`}
                inputMode="decimal"
                placeholder={t("production.grid.costPlaceholder")}
                label={t("production.grid.costFor", { item: label })}
                labelHidden
                defaultValue={value?.cost ?? ""}
                error={errors[`cost.${v.id}`] ? t(errors[`cost.${v.id}`]!) : undefined}
              />
            ) : null}
          </Stack>
        );
      })}
    </Stack>
  );
}

function ProductGrid({ product, editor, showCosts, errors }: { product: VariantGridProduct; editor: Editor; showCosts: boolean; errors: Record<string, string> }) {
  const t = useT();
  const total = product.variants.reduce((s, v) => s + (editor.values[v.id]?.qty ?? 0), 0);
  const flat = product.models.every((m) => m === null) && product.colors.every((c) => c === null);
  let table: ReactNode;
  if (flat) {
    const columns: Array<DataTableColumn<GridVariant>> = [
      { key: "variant", header: t("production.grid.variant"), primary: true, render: (v) => v.title ?? v.sku ?? product.title },
      {
        key: "qty",
        header: t("production.grid.quantity"),
        render: (v) => <VariantInputs variants={[v]} product={product} editor={editor} showCosts={showCosts} errors={errors} />,
      },
    ];
    table = <DataTable caption={product.title} columns={columns} rows={product.variants} rowKey={(v) => v.id} />;
  } else {
    const columns: Array<DataTableColumn<GridRow>> = [
      { key: "model", header: t("production.grid.model"), primary: true, render: (r) => r.model ?? t("production.grid.noModel") },
      ...product.colors.map((color) => ({
        key: colorKey(color),
        header: color ?? t("production.grid.noColor"),
        render: (r: GridRow) => (
          <VariantInputs variants={r.cells.get(colorKey(color)) ?? []} product={product} editor={editor} showCosts={showCosts} errors={errors} />
        ),
      })),
    ];
    table = <DataTable caption={product.title} columns={columns} rows={gridRows(product)} rowKey={(r) => r.key} />;
  }
  return (
    <Card
      title={
        <Stack direction="horizontal" gap={2} align="center" wrap={false}>
          <Thumbnail src={product.imageUrl} alt={product.title} size="sm" />
          <span>{product.title}</span>
        </Stack>
      }
      description={
        total > 0
          ? t("production.grid.descriptionWithTotal", { variants: product.variants.length, count: total })
          : t("production.grid.description", { variants: product.variants.length })
      }
      actions={
        showCosts ? (
          <TextField
            id={`default-cost-${product.productId}`}
            name={`defaultCost.${product.productId}`}
            inputMode="decimal"
            label={t("production.grid.defaultCost")}
            helpText={t("production.grid.defaultCostHelp")}
          />
        ) : null
      }
      padded={false}
    >
      {table}
    </Card>
  );
}

function BatchEditor({ data, editor }: { data: Data; editor: Editor }) {
  const t = useT();
  const href = useHref();
  const actionData = useActionData<typeof action>();
  const errors = useFieldErrors();
  const navigation = useNavigation();
  const busy = navigation.state === "submitting";
  const isCreate = data.mode === "create";
  const batch = data.detail?.batch ?? null;
  const costs = data.detail?.costs ?? null;
  const showCosts = data.canSeeCosts;
  const pickerIds = new Set(editor.picker.map((p) => p.id));
  const locked = new Set(editor.locked);
  const selected = new Set(editor.selected);
  const err = (name: string, params?: Record<string, number>) => (errors[name] ? t(errors[name]!, params) : undefined);
  const backHref = batch ? href(`production/${batch.id}`) : href("production");

  return (
    <Page
      title={isCreate ? t("production.editor.createTitle") : t("production.editor.editTitle", { number: batch?.number ?? "" })}
      subtitle={t("production.editor.subtitle")}
      backHref={backHref}
      backLabel={t("common.back")}
    >
      <Stack gap={4}>
        <ActionBanner data={actionData} />

        <Card title={t("production.editor.step1")} description={t("production.editor.step1Help")}>
          <Form method="get" role="search">
            {!isCreate ? <input type="hidden" name="edit" value="1" /> : null}
            {/* Уже вибрані товари, яких немає в результатах пошуку, лишаються вибраними. */}
            {editor.selected
              .filter((id) => !pickerIds.has(id) && !locked.has(id))
              .map((id) => (
                <input key={id} type="hidden" name="product" value={id} />
              ))}
            <Stack gap={3}>
              <Stack direction="horizontal" gap={2} align="end">
                <TextField
                  id="picker-q"
                  type="search"
                  name="pq"
                  label={t("production.editor.searchProducts")}
                  placeholder={t("production.editor.searchPlaceholder")}
                  defaultValue={editor.pq}
                  maxLength={MAX_PICKER_QUERY}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button type="submit">{t("common.search")}</Button>
              </Stack>
              {editor.picker.length === 0 ? (
                <Text tone="subdued">{t("production.editor.noProducts")}</Text>
              ) : (
                <Grid columns={{ xs: 1, md: 2, lg: 3 }} gap={2}>
                  {editor.picker.map((p) => (
                    <Checkbox
                      key={p.id}
                      id={`pick-${p.id}`}
                      name="product"
                      value={p.id}
                      disabled={locked.has(p.id)}
                      defaultChecked={selected.has(p.id)}
                      label={
                        <Stack direction="horizontal" gap={2} align="center" wrap={false}>
                          <Thumbnail src={p.imageUrl} alt={p.title} size="sm" />
                          <Stack gap={0}>
                            <Text as="span">{p.title}</Text>
                            <Text as="span" variant="caption" tone="subdued">
                              {t("production.editor.variantCount", { count: p.variantCount })}
                            </Text>
                          </Stack>
                        </Stack>
                      }
                    />
                  ))}
                </Grid>
              )}
              <Stack direction="horizontal" gap={2}>
                <Button type="submit" variant="primary">
                  {t("production.editor.showGrid")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        </Card>

        <Form method="post">
          <input type="hidden" name="intent" value={isCreate ? "create" : "update"} />
          {batch ? <input type="hidden" name="version" value={batch.version} /> : null}
          <Stack gap={4}>
            <Card title={t("production.editor.step2")}>
              <FormLayout columns={2}>
                <TextField
                  id="batch-title"
                  name="title"
                  required
                  maxLength={LIMITS.title}
                  label={t("production.field.title")}
                  placeholder={t("production.field.titlePlaceholder")}
                  defaultValue={batch?.title ?? ""}
                  error={err("title", { max: LIMITS.title })}
                />
                <TextField
                  id="batch-ready"
                  name="plannedReadyDate"
                  type="date"
                  label={t("production.field.plannedReadyDate")}
                  defaultValue={batch?.plannedReadyDate ?? ""}
                  error={err("plannedReadyDate")}
                />
                <TextField
                  id="batch-manufacturer"
                  name="manufacturer"
                  maxLength={LIMITS.manufacturer}
                  label={t("production.field.manufacturer")}
                  defaultValue={batch?.manufacturer ?? ""}
                  error={err("manufacturer", { max: LIMITS.manufacturer })}
                />
                {showCosts ? (
                  <Select
                    id="batch-currency"
                    name="costCurrency"
                    label={t("production.cost.currency")}
                    options={data.currencies.map((c) => ({ value: c, label: c }))}
                    defaultValue={costs?.currency ?? DEFAULT_COST_CURRENCY}
                    error={err("costCurrency")}
                  />
                ) : null}
                {showCosts ? (
                  <TextField
                    id="batch-extra-cost"
                    name="extraCost"
                    inputMode="decimal"
                    label={t("production.cost.extraCost")}
                    helpText={t("production.cost.extraCostHelp")}
                    defaultValue={costs?.extraCost ?? ""}
                    error={err("extraCost")}
                  />
                ) : null}
                <div className="ot-form-layout__full">
                  <TextField
                    id="batch-notes"
                    name="notes"
                    multiline={3}
                    maxLength={LIMITS.notes}
                    label={t("production.field.notes")}
                    defaultValue={batch?.notes ?? ""}
                    error={err("notes", { max: LIMITS.notes })}
                  />
                </div>
              </FormLayout>
            </Card>

            <Stack gap={2}>
              <Text variant="heading-sm">{t("production.editor.step3")}</Text>
              <Text variant="body-sm" tone="subdued">
                {t(showCosts ? "production.editor.step3HelpCosts" : "production.editor.step3Help")}
              </Text>
            </Stack>
            {errors.lines ? <Banner tone="critical">{t(errors.lines, { max: LIMITS.lines })}</Banner> : null}
            {editor.grid.length === 0 ? (
              <Card>
                <EmptyState title={t("production.editor.chooseProducts")} description={t("production.editor.chooseProductsHelp")} />
              </Card>
            ) : (
              editor.grid.map((p) => <ProductGrid key={p.productId} product={p} editor={editor} showCosts={showCosts} errors={errors} />)
            )}

            <Stack direction="horizontal" gap={2}>
              <Button type="submit" variant="primary" loading={busy}>
                {isCreate ? t("production.editor.create") : t("common.save")}
              </Button>
              <Button to={backHref}>{t("common.cancel")}</Button>
            </Stack>
          </Stack>
        </Form>
      </Stack>
    </Page>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

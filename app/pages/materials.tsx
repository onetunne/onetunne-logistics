import { useEffect, useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useLocation,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useHref } from "~/components/shell";
import type { MaterialUnit, PackagingMaterialKind } from "~/db/schema";
import { MATERIAL_KINDS, UNITS } from "~/modules/packaging/constants";
import { can, requirePermission } from "~/domain/permissions";
import { hasKey, useLocale, useT, type TFunction } from "~/i18n";
import { formatMoney, formatNumber, formatWeight } from "~/lib/format";
import { BOX_KINDS } from "~/modules/packaging/box-selection";
import {
  MATERIAL_CONSUMPTION_DAYS,
  applyMaterialStock,
  createMaterial,
  getMaterial,
  listMaterials,
  materialStockPermission,
  setMaterialsActive,
  updateMaterial,
  type MaterialStockLineResult,
  type MaterialStockStatus,
  type MaterialView,
} from "~/modules/packaging/materials.server";
import { MATERIAL_STOCK_OPERATIONS, MAX_STOCK_LINES, materialStockDelta, type MaterialStockOperation } from "~/modules/packaging/schemas";
import { getSetting } from "~/modules/settings/settings.server";
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
  InlineCode,
  Page,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  type BadgeTone,
  type DataTableColumn,
} from "~/ui";
import { DEFAULT_COST_CURRENCY } from "~/modules/warehouse/constants";

/**
 * «Склад» → «Пакувальні матеріали» (етап 5, WP «Упаковка»): довідник матеріалів (коробки з внутрішніми габаритами,
 * макс. вагою й тарою; наклейки, інструкції, візитки, болти…), залишки й масові операції з підтвердженням.
 * Дозволи перевіряються на сервері (modules/packaging/materials.server.ts); інтерфейс лише приховує недоступне.
 */

const MAX_QUERY_LENGTH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STOCK_FORM_ID = "materials-stock";
const BULK_FORM_ID = "materials-bulk";
const QTY_PREFIX = "qty.";
const STATUS_TABS = ["all", "low", "out", "negative"] as const;
type StatusTab = (typeof STATUS_TABS)[number];
const ACTIVITY = ["active", "inactive", "all"] as const;
type Activity = (typeof ACTIVITY)[number];

interface Filters {
  q: string;
  kind: PackagingMaterialKind | null;
  status: StatusTab;
  activity: Activity;
}

function parseFilters(params: URLSearchParams): Filters {
  const kind = params.get("kind");
  const status = params.get("status");
  const activity = params.get("activity");
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    kind: kind && (MATERIAL_KINDS as readonly string[]).includes(kind) ? (kind as PackagingMaterialKind) : null,
    status: status && (STATUS_TABS as readonly string[]).includes(status) ? (status as StatusTab) : "all",
    activity: activity && (ACTIVITY as readonly string[]).includes(activity) ? (activity as Activity) : "active",
  };
}

function buildSearch(f: Partial<Filters> & { edit?: string | null }): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.kind) params.set("kind", f.kind);
  if (f.status && f.status !== "all") params.set("status", f.status);
  if (f.activity && f.activity !== "active") params.set("activity", f.activity);
  if (f.edit) params.set("edit", f.edit);
  const s = params.toString();
  return s ? `?${s}` : "";
}

function forbiddenResponse(): never {
  throw new Response("Forbidden", { status: 403 });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) forbiddenResponse();
  const params = new URL(request.url).searchParams;
  const filters = parseFilters(params);
  const includeCosts = can(ctx.actor, "finance.view");
  const canEdit = can(ctx.actor, "warehouse.adjust");
  const list = await listMaterials(
    ctx.db,
    {
      search: filters.q || undefined,
      kinds: filters.kind ? [filters.kind] : undefined,
      activity: filters.activity,
      statuses: filters.status === "all" ? undefined : [filters.status as MaterialStockStatus],
    },
    { includeCosts, now: ctx.now() },
  );
  const editParam = params.get("edit");
  let editing: MaterialView | null = null;
  let creating = false;
  if (canEdit && editParam === "new") creating = true;
  else if (canEdit && editParam && UUID_RE.test(editParam)) {
    try {
      editing = await getMaterial(ctx.db, editParam, { includeCosts, now: ctx.now() });
    } catch {
      editing = null;
    }
  }
  const operations = MATERIAL_STOCK_OPERATIONS.filter((op) => can(ctx.actor, materialStockPermission(op)));
  return {
    filters,
    isFiltered: Boolean(filters.q || filters.kind || filters.activity !== "active"),
    // Суми форматуються на сервері: символ гривні в Intl Node і браузера різний («₴» / «грн») → розбіжність гідратації.
    rows: list.rows.map((r) => ({ ...r, costText: r.unitCost && r.costCurrency ? formatMoney(r.unitCost, r.costCurrency, ctx.locale) : null })),
    statusCounts: list.statusCounts,
    total: list.total,
    editing,
    creating,
    canEdit,
    canSeeCosts: includeCosts,
    operations,
    /**
     * uuid масової операції для ПЕРШОГО показу форми: подвійне надсилання тієї самої форми не дублює рух. Сторінка
     * тримає його до успішного застосування (далі — nextOperationId з результату дії); нові значення з повторних
     * завантажень (після дії, фільтрів) ігноруються, щоб відмова сервера не скидала введені кількості.
     */
    operationId: globalThis.crypto.randomUUID(),
    defaultThreshold: (await getSetting(ctx.db, "warehouse")).lowStockThreshold,
    /** Період «Витрачено за … днів» (materials.server.ts — лише сервер, тому передається даними). */
    consumptionDays: MATERIAL_CONSUMPTION_DAYS,
  };
}

export type MaterialsActionResult = ActionResult & {
  intent?: string;
  stock?: { operation: MaterialStockOperation; lines: MaterialStockLineResult[] };
  /** Після УСПІШНОЇ масової операції — uuid для наступної (форма очищується). Після відмови його немає: форма лишає
   *  кількості й той самий uuid (нічого не записано — усе або нічого; повтор після збою мережі не задвоїть рух). */
  nextOperationId?: string;
  materialId?: string;
};

function readInt(form: FormData, name: string): string {
  return formString(form, name).trim();
}

function materialFormInput(form: FormData) {
  return {
    code: formString(form, "code"),
    name: formString(form, "name"),
    kind: formString(form, "kind") as PackagingMaterialKind,
    unit: (formString(form, "unit") || "pcs") as MaterialUnit,
    innerLengthMm: readInt(form, "innerLengthMm"),
    innerWidthMm: readInt(form, "innerWidthMm"),
    innerHeightMm: readInt(form, "innerHeightMm"),
    maxWeightGrams: readInt(form, "maxWeightGrams"),
    tareWeightGrams: readInt(form, "tareWeightGrams"),
    unitCost: form.has("unitCost") ? formString(form, "unitCost") : undefined,
    costCurrency: form.has("costCurrency") ? formString(form, "costCurrency") : undefined,
    active: form.has("active"),
    lowStockThreshold: readInt(form, "lowStockThreshold"),
  };
}

export async function action({ request }: ActionFunctionArgs): Promise<MaterialsActionResult> {
  const ctx = await getRequestContext(request);
  let intent = "";
  try {
    requirePermission(ctx.actor, "warehouse.view");
    const form = await request.formData();
    intent = formString(form, "intent");
    if (intent === "createMaterial") {
      const { id } = await createMaterial(ctx, materialFormInput(form));
      return { ok: true, intent, message: "packaging.materials.result.created", materialId: id };
    }
    if (intent === "updateMaterial") {
      const id = formString(form, "materialId");
      if (!UUID_RE.test(id)) return { ok: false, intent, error: "error.notFound" };
      // Без finance.view поля собівартості у формі немає → не змінюється (і сервіс їх ігнорує).
      await updateMaterial(ctx, id, materialFormInput(form), { expectedVersion: formString(form, "version") || null });
      return { ok: true, intent, message: "packaging.materials.result.updated", materialId: id };
    }
    if (intent === "setActive") {
      const ids = form.getAll("materialIds").filter((v): v is string => typeof v === "string" && UUID_RE.test(v));
      const active = formString(form, "active") === "1";
      const r = await setMaterialsActive(ctx, ids, active);
      return { ok: true, intent, message: active ? "packaging.materials.result.activated" : "packaging.materials.result.deactivated", params: { count: r.updated } };
    }
    if (intent === "stock") {
      const operation = formString(form, "operation") as MaterialStockOperation;
      if (!(MATERIAL_STOCK_OPERATIONS as readonly string[]).includes(operation)) return { ok: false, intent, error: "packaging.error.invalid" };
      requirePermission(ctx.actor, materialStockPermission(operation));
      const lines: Array<{ materialId: string; quantity: string }> = [];
      for (const [name, value] of form.entries()) {
        if (!name.startsWith(QTY_PREFIX) || typeof value !== "string" || value.trim() === "") continue;
        const materialId = name.slice(QTY_PREFIX.length);
        if (!UUID_RE.test(materialId)) continue;
        lines.push({ materialId, quantity: value.trim() });
        if (lines.length > MAX_STOCK_LINES) break;
      }
      if (lines.length === 0) return { ok: false, intent, error: "packaging.error.stockNoLines" };
      const withCost = operation === "receive" && can(ctx.actor, "finance.view") && formString(form, "unitCost").trim() !== "";
      const r = await applyMaterialStock(ctx, {
        operationId: formString(form, "operationId"),
        operation,
        lines,
        note: formString(form, "note"),
        unitCost: withCost ? formString(form, "unitCost") : null,
        costCurrency: withCost ? formString(form, "costCurrency") : null,
      });
      return {
        ok: true,
        intent,
        message: r.applied > 0 ? "packaging.stock.result.applied" : "packaging.stock.result.nothing",
        params: { applied: r.applied, duplicates: r.duplicates, unchanged: r.unchanged },
        extra: r.duplicates > 0 ? ["packaging.stock.result.duplicates"] : undefined,
        tone: r.applied > 0 ? "success" : "info",
        stock: { operation: r.operation, lines: r.lines },
        nextOperationId: globalThis.crypto.randomUUID(),
      };
    }
    return { ok: false, intent, error: "error.generic" };
  } catch (e) {
    return { ...toActionError(e), intent };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Row = Data["rows"][number];

const STATUS_TONE: Record<string, BadgeTone> = { ok: "success", low: "warning", out: "critical", negative: "critical", oversold: "critical" };

function dims(row: Pick<MaterialView, "innerLengthMm" | "innerWidthMm" | "innerHeightMm">): string | null {
  return row.innerLengthMm && row.innerWidthMm && row.innerHeightMm ? `${row.innerLengthMm}×${row.innerWidthMm}×${row.innerHeightMm}` : null;
}

/** Зміна залишку для введеного значення (формула сервера — materialStockDelta) або null — некоректна кількість. */
function stockDelta(operation: MaterialStockOperation, raw: string, onHand: number): number | null {
  const v = raw.trim();
  return /^[-+]?\d{1,7}$/.test(v) ? materialStockDelta(operation, Number(v), onHand) : null;
}

export default function MaterialsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const location = useLocation();
  const navigation = useNavigation();
  const basePath = href("warehouse/materials");
  const { filters, rows } = data;
  const busyIntent = navigation.state === "submitting" ? String(navigation.formData?.get("intent") ?? "") : null;
  const isFiltering =
    navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET" && navigation.location.pathname === location.pathname;

  const [operation, setOperation] = useState<MaterialStockOperation | "">(data.operations[0] ?? "");
  const [qty, setQty] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState(0);
  // uuid операції живе до УСПІШНОГО застосування (див. loader): відмова сервера (залишок змінився, некоректні дані)
  // лишає введені кількості й той самий uuid — виправити й підтвердити ще раз.
  const [operationId, setOperationId] = useState<string>(data.operationId);
  const [selectionKey, setSelectionKey] = useState(0);
  useEffect(() => {
    if (!actionData?.ok) return;
    if (actionData.intent === "stock") {
      setQty({});
      if (actionData.nextOperationId) setOperationId(actionData.nextOperationId);
    }
    if (actionData.intent === "setActive") {
      // Перелік змінився — скинути вибір рядків.
      setSelectionKey((k) => k + 1);
      setSelected(0);
    }
  }, [actionData]);
  // Інші фільтри — інший перелік рядків: кількості прихованих рядків не надсилаються, тож поля очищуються
  // (uuid лишається — нічого не застосовано).
  useEffect(() => {
    setQty({});
    setSelected(0);
  }, [location.search]);

  const preview = useMemo(() => {
    let lines = 0;
    let plus = 0;
    let minus = 0;
    let invalid = 0;
    let negative = 0;
    const items: Array<{ row: Row; delta: number }> = [];
    if (operation) {
      for (const row of rows) {
        const raw = qty[row.id];
        if (!raw || raw.trim() === "") continue;
        const delta = stockDelta(operation, raw, row.onHand);
        if (delta === null) {
          invalid += 1;
          continue;
        }
        if (delta === 0) continue;
        lines += 1;
        if (delta > 0) plus += delta;
        else minus += -delta;
        if (row.onHand + delta < 0) negative += 1;
        items.push({ row, delta });
      }
    }
    return { lines, plus, minus, invalid, negative, items };
  }, [operation, qty, rows]);

  const listHref = (f: Partial<Filters>) => `${basePath}${buildSearch({ ...filters, ...f })}`;
  const tabs = STATUS_TABS.filter((s) => s !== "negative" || data.statusCounts.negative > 0).map((s) => ({
    key: s,
    label: t(`packaging.materials.tab.${s}`),
    href: listHref({ status: s }),
    count: s === "all" ? null : data.statusCounts[s],
  }));
  const activeFilters = [filters.q, filters.kind, filters.activity !== "active" ? filters.activity : ""].filter(Boolean).length;
  const canStock = data.operations.length > 0;
  const stockResult = actionData?.ok && actionData.intent === "stock" ? actionData.stock : null;
  const isFormIntent = actionData?.intent === "createMaterial" || actionData?.intent === "updateMaterial";
  const unitLabel = (u: MaterialUnit) => t(`materialUnit.${u}`);

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "material",
      header: t("packaging.materials.col.material"),
      primary: true,
      render: (r) => (
        <Stack gap={1}>
          <Text as="span" weight="semibold">
            {r.name}
          </Text>
          <Stack as="span" direction="horizontal" gap={2} align="center">
            <InlineCode>{r.code}</InlineCode>
            {!r.active ? (
              <Badge size="sm" tone="outline">
                {t("packaging.materials.inactive")}
              </Badge>
            ) : null}
          </Stack>
        </Stack>
      ),
    },
    { key: "kind", header: t("packaging.materials.col.kind"), render: (r) => t(`materialKind.${r.kind}`) },
    {
      key: "stock",
      header: t("packaging.materials.col.stock"),
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={2} align="center">
          <Text as="span" numeric weight="semibold">
            {formatNumber(r.onHand, locale)} {unitLabel(r.unit)}
          </Text>
          {r.active ? (
            <Badge size="sm" tone={STATUS_TONE[r.status] ?? "neutral"}>
              {t(`stockLevel.${r.status}`)}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      // Витрата при пакуванні за 30 днів і на скільки днів вистачить залишку (materials.server.ts materialDaysLeft).
      key: "usage",
      header: t("warehouseInsights.material.consumed", { days: data.consumptionDays }),
      render: (r) =>
        r.consumedRecent > 0 ? (
          <Stack as="span" gap={0}>
            <Text as="span" numeric>
              {formatNumber(r.consumedRecent, locale)} {unitLabel(r.unit)}
            </Text>
            <Text as="span" variant="caption" tone={r.daysLeft === 0 ? "critical" : "subdued"}>
              {r.daysLeft === 0
                ? t("warehouseInsights.material.runOut")
                : t("warehouseInsights.material.daysLeftValue", { days: formatNumber(r.daysLeft ?? 0, locale) })}
            </Text>
          </Stack>
        ) : (
          <Text as="span" variant="body-sm" tone="subdued">
            {t("warehouseInsights.material.noUsage")}
          </Text>
        ),
    },
    {
      key: "threshold",
      header: t("packaging.materials.col.threshold"),
      hideOnMobile: true,
      render: (r) =>
        r.lowStockThreshold === null ? t("packaging.materials.thresholdDefault", { value: r.threshold }) : formatNumber(r.threshold, locale),
    },
    {
      key: "box",
      header: t("packaging.materials.col.box"),
      hideOnMobile: true,
      render: (r) =>
        r.isBox ? (
          <Stack gap={1}>
            <Text as="span" variant="body-sm" numeric>
              {dims(r) ? t("packaging.materials.dimsValue", { dims: dims(r)! }) : t("packaging.materials.noDims")}
            </Text>
            <Text as="span" variant="caption" tone="subdued">
              {t("packaging.materials.boxWeights", {
                max: r.maxWeightGrams ? formatWeight(r.maxWeightGrams, locale) : "—",
                tare: r.tareWeightGrams !== null ? formatWeight(r.tareWeightGrams, locale) : "—",
              })}
            </Text>
            {!r.selectable && r.active ? (
              <Text as="span" variant="caption" tone="warning">
                {t("packaging.materials.notSelectable")}
              </Text>
            ) : null}
          </Stack>
        ) : (
          "—"
        ),
    },
    ...(data.canSeeCosts
      ? [
          {
            key: "cost",
            header: t("packaging.materials.col.cost"),
            hideOnMobile: true,
            align: "end" as const,
            render: (r: Row) => r.costText ?? "—",
          },
        ]
      : []),
    ...(canStock && operation
      ? [
          {
            key: "qty",
            header: t(`packaging.stock.qtyHeader.${operation}`),
            render: (r: Row) => {
              const raw = qty[r.id] ?? "";
              const delta = raw ? stockDelta(operation, raw, r.onHand) : null;
              const invalid = raw.trim() !== "" && delta === null;
              return (
                <Stack gap={1}>
                  <TextField
                    id={`qty-${r.id}`}
                    name={`${QTY_PREFIX}${r.id}`}
                    form={STOCK_FORM_ID}
                    type="number"
                    inputMode="numeric"
                    step={1}
                    min={operation === "adjust" ? undefined : 0}
                    label={t("packaging.stock.qtyLabel", { name: r.name })}
                    labelHidden
                    value={raw}
                    onChange={(e) => {
                      const v = e.currentTarget.value;
                      setQty((prev) => ({ ...prev, [r.id]: v }));
                    }}
                    suffix={unitLabel(r.unit)}
                    error={invalid ? t("packaging.stock.qtyInvalid") : null}
                  />
                  {delta !== null && delta !== 0 ? (
                    <Text as="span" variant="caption" tone={r.onHand + delta < 0 ? "critical" : "subdued"} numeric>
                      {t("packaging.stock.afterValue", { before: r.onHand, after: r.onHand + delta })}
                    </Text>
                  ) : null}
                </Stack>
              );
            },
          },
        ]
      : []),
    ...(data.canEdit
      ? [
          {
            key: "edit",
            header: t("common.actions"),
            render: (r: Row) => (
              <Button size="sm" to={`${basePath}${buildSearch({ ...filters, edit: r.id })}`}>
                {t("common.edit")}
              </Button>
            ),
          },
        ]
      : []),
  ];

  return (
    <Page
      title={t("packaging.materials.title")}
      subtitle={t("packaging.materials.subtitle")}
      backHref={href("warehouse")}
      backLabel={t("nav.warehouse")}
      primaryAction={
        data.canEdit ? (
          <Button variant="primary" to={`${basePath}${buildSearch({ ...filters, edit: "new" })}`}>
            {t("packaging.materials.add")}
          </Button>
        ) : undefined
      }
      secondaryActions={<Button to={href("warehouse/kits")}>{t("packaging.kits.title")}</Button>}
    >
      <Stack gap={4}>
        {/* Помилки форми матеріалу показуються у самій формі; решта результатів — тут. */}
        {actionData && !(isFormIntent && !actionData.ok) ? <ActionBanner data={actionData} /> : null}

        {(data.creating || data.editing) && !(isFormIntent && actionData?.ok) ? (
          <MaterialForm
            key={data.editing ? `${data.editing.id}-${data.editing.version}` : "new"}
            material={data.editing}
            canSeeCosts={data.canSeeCosts}
            defaultThreshold={data.defaultThreshold}
            closeHref={`${basePath}${buildSearch(filters)}`}
            result={actionData && !actionData.ok && isFormIntent ? actionData : null}
            busy={busyIntent === "createMaterial" || busyIntent === "updateMaterial"}
          />
        ) : null}

        <Tabs items={tabs} selected={filters.status} ariaLabel={t("packaging.materials.tabsLabel")} />

        <Card>
          <Disclosure
            collapsedOnMobile
            summary={activeFilters > 0 ? t("packaging.filters.titleActive", { count: activeFilters }) : t("common.filters")}
          >
            <Form key={location.search} method="get" role="search">
              {filters.status !== "all" ? <input type="hidden" name="status" value={filters.status} /> : null}
              <Stack gap={4}>
                <Grid columns={{ xs: 1, md: 3 }} gap={3}>
                  <TextField
                    id="materials-filter-q"
                    type="search"
                    name="q"
                    label={t("common.search")}
                    placeholder={t("packaging.materials.searchPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={MAX_QUERY_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Select
                    id="materials-filter-kind"
                    name="kind"
                    label={t("packaging.materials.col.kind")}
                    placeholder={t("packaging.filters.allKinds")}
                    options={MATERIAL_KINDS.map((k) => ({ value: k, label: t(`materialKind.${k}`) }))}
                    defaultValue={filters.kind ?? ""}
                  />
                  <Select
                    id="materials-filter-activity"
                    name="activity"
                    label={t("packaging.filters.activity")}
                    options={ACTIVITY.map((a) => ({ value: a, label: t(`packaging.filters.activity.${a}`) }))}
                    defaultValue={filters.activity}
                  />
                </Grid>
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary" loading={isFiltering}>
                    {t("common.apply")}
                  </Button>
                  <Button to={basePath} disabled={!data.isFiltered && filters.status === "all"}>
                    {t("common.reset")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Disclosure>
        </Card>

        {canStock && rows.length > 0 ? (
          <Card title={t("packaging.stock.title")} description={t("packaging.stock.description")}>
            <Form id={STOCK_FORM_ID} method="post" aria-label={t("packaging.stock.title")}>
              <input type="hidden" name="intent" value="stock" />
              <input type="hidden" name="operationId" value={operationId} />
              <Stack gap={3}>
                <Grid columns={{ xs: 1, md: 2 }} gap={3}>
                  <Select
                    id="materials-stock-operation"
                    name="operation"
                    label={t("packaging.stock.operation")}
                    options={data.operations.map((op) => ({ value: op, label: t(`packaging.stock.op.${op}`) }))}
                    value={operation}
                    onChange={(e) => setOperation(e.currentTarget.value as MaterialStockOperation)}
                    helpText={operation ? t(`packaging.stock.opHelp.${operation}`) : undefined}
                  />
                  <TextField id="materials-stock-note" name="note" label={t("packaging.stock.note")} maxLength={500} helpText={t("packaging.stock.noteHelp")} />
                </Grid>
                {operation === "receive" && data.canSeeCosts ? (
                  <Grid columns={{ xs: 2, md: 4 }} gap={3}>
                    <TextField id="materials-stock-cost" name="unitCost" label={t("packaging.stock.unitCost")} inputMode="decimal" placeholder="0.00" />
                    <TextField id="materials-stock-currency" name="costCurrency" label={t("packaging.field.costCurrency")} defaultValue={DEFAULT_COST_CURRENCY} maxLength={3} />
                  </Grid>
                ) : null}
                <div aria-live="polite" aria-atomic="true">
                  <Text variant="body-sm" weight="semibold">
                    {t("packaging.stock.summary", { lines: preview.lines, plus: preview.plus, minus: preview.minus })}
                  </Text>
                  {preview.invalid > 0 ? (
                    <Text variant="caption" tone="critical">
                      {t("packaging.stock.invalidCount", { count: preview.invalid })}
                    </Text>
                  ) : null}
                  {preview.negative > 0 ? (
                    <Text variant="caption" tone="critical">
                      {t("packaging.stock.negativeCount", { count: preview.negative })}
                    </Text>
                  ) : null}
                </div>
                <Stack direction="horizontal" gap={2}>
                  <ConfirmSubmitButton
                    name="confirm"
                    value="1"
                    variant="primary"
                    disabled={!operation || preview.lines === 0 || preview.invalid > 0 || preview.negative > 0 || busyIntent === "stock"}
                    loading={busyIntent === "stock"}
                    title={operation ? t(`packaging.stock.op.${operation}`) : t("packaging.stock.title")}
                    confirmLabel={t("packaging.stock.confirm")}
                    cancelLabel={t("common.cancel")}
                    message={
                      <Stack gap={2}>
                        <Text weight="semibold">{t("packaging.stock.summary", { lines: preview.lines, plus: preview.plus, minus: preview.minus })}</Text>
                        <Stack as="ul" gap={1}>
                          {preview.items.slice(0, 12).map(({ row, delta }) => (
                            <Text as="li" key={row.id} variant="body-sm" numeric>
                              {t("packaging.stock.previewLine", {
                                name: row.name,
                                before: row.onHand,
                                after: row.onHand + delta,
                                delta: delta > 0 ? `+${delta}` : String(delta),
                                unit: unitLabel(row.unit),
                              })}
                            </Text>
                          ))}
                        </Stack>
                        {preview.items.length > 12 ? (
                          <Text variant="body-sm" tone="subdued">
                            {t("packaging.stock.previewMore", { count: preview.items.length - 12 })}
                          </Text>
                        ) : null}
                        <Text variant="body-sm" tone="subdued">
                          {t("packaging.stock.confirmNote")}
                        </Text>
                      </Stack>
                    }
                  >
                    {t("packaging.stock.apply")}
                  </ConfirmSubmitButton>
                  <Button disabled={Object.keys(qty).length === 0} onClick={() => setQty({})}>
                    {t("common.clear")}
                  </Button>
                </Stack>
              </Stack>
            </Form>
          </Card>
        ) : null}

        {stockResult ? <StockResultCard lines={stockResult.lines} /> : null}

        {data.canEdit && rows.length > 0 ? (
          <Card>
            <Form id={BULK_FORM_ID} method="post" aria-label={t("packaging.materials.bulkLabel")}>
              <input type="hidden" name="intent" value="setActive" />
              <Stack direction="horizontal" gap={3} align="center" justify="between">
                <Text variant="body-sm" weight="semibold">
                  {t("common.selected", { count: selected })}
                </Text>
                <Stack direction="horizontal" gap={2}>
                  <ConfirmSubmitButton
                    name="active"
                    value="0"
                    disabled={selected === 0 || busyIntent === "setActive"}
                    title={t("packaging.materials.deactivateTitle")}
                    confirmLabel={t("packaging.materials.deactivate")}
                    cancelLabel={t("common.cancel")}
                    message={<Text>{t("packaging.materials.deactivateMessage", { count: selected })}</Text>}
                  >
                    {t("packaging.materials.deactivate")}
                  </ConfirmSubmitButton>
                  <ConfirmSubmitButton
                    name="active"
                    value="1"
                    disabled={selected === 0 || busyIntent === "setActive"}
                    title={t("packaging.materials.activateTitle")}
                    confirmLabel={t("packaging.materials.activate")}
                    cancelLabel={t("common.cancel")}
                    message={<Text>{t("packaging.materials.activateMessage", { count: selected })}</Text>}
                  >
                    {t("packaging.materials.activate")}
                  </ConfirmSubmitButton>
                </Stack>
              </Stack>
            </Form>
          </Card>
        ) : null}

        <Card padded={false}>
          <DataTable<Row>
            key={`${location.search}|${selectionKey}`}
            caption={t("packaging.materials.title")}
            rows={rows}
            rowKey={(r) => r.id}
            columns={columns}
            selection={
              data.canEdit
                ? {
                    name: "materialIds",
                    formId: BULK_FORM_ID,
                    value: (r) => r.id,
                    label: (r) => t("common.selectRow", { label: r.name }),
                    allLabel: t("common.selectAll"),
                    onChange: (values) => setSelected(values.length),
                  }
                : undefined
            }
            emptyState={
              <EmptyState
                title={t(data.isFiltered || filters.status !== "all" ? "packaging.materials.empty.filtered" : "packaging.materials.empty.title")}
                description={t(data.canEdit ? "packaging.materials.empty.descriptionOwner" : "packaging.materials.empty.description")}
                action={data.isFiltered || filters.status !== "all" ? <Button to={basePath}>{t("common.reset")}</Button> : undefined}
              />
            }
          />
        </Card>
        {data.total > 0 ? (
          <Text variant="body-sm" tone="subdued">
            {t("packaging.materials.count", { count: data.total })}
          </Text>
        ) : null}
      </Stack>
    </Page>
  );
}

function StockResultCard({ lines }: { lines: MaterialStockLineResult[] }) {
  const t = useT();
  return (
    <Card title={t("packaging.stock.resultTitle")}>
      <Stack as="ul" gap={1}>
        {lines.map((l) => (
          <Text as="li" key={l.materialId} variant="body-sm" numeric>
            {t(`packaging.stock.lineStatus.${l.status}`, {
              name: l.name,
              before: l.before,
              after: l.after,
              unit: t(`materialUnit.${l.unit}`),
            })}
          </Text>
        ))}
      </Stack>
    </Card>
  );
}

function fieldErrorFn(t: TFunction, result: MaterialsActionResult | null) {
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  return (name: string): string | null => {
    const message = errors?.[name];
    if (!message) return null;
    return t(hasKey(message) ? message : "packaging.error.invalid");
  };
}

function MaterialForm({
  material,
  canSeeCosts,
  defaultThreshold,
  closeHref,
  result,
  busy,
}: {
  material: MaterialView | null;
  canSeeCosts: boolean;
  defaultThreshold: number;
  closeHref: string;
  result: MaterialsActionResult | null;
  busy: boolean;
}) {
  const t = useT();
  const fieldError = fieldErrorFn(t, result);
  const [kind, setKind] = useState<PackagingMaterialKind>(material?.kind ?? "box");
  const isBox = BOX_KINDS.includes(kind);
  return (
    <Card
      title={material ? t("packaging.materials.editTitle", { name: material.name }) : t("packaging.materials.add")}
      actions={<Button to={closeHref}>{t("common.close")}</Button>}
    >
      <Form method="post">
        <input type="hidden" name="intent" value={material ? "updateMaterial" : "createMaterial"} />
        {material ? <input type="hidden" name="materialId" value={material.id} /> : null}
        {material ? <input type="hidden" name="version" value={material.version} /> : null}
        <Stack gap={4}>
          {result ? <ActionBanner data={result} /> : null}
          <FormLayout columns={2}>
            <TextField
              id="material-name"
              name="name"
              label={t("packaging.field.name")}
              defaultValue={material?.name ?? ""}
              required
              maxLength={120}
              error={fieldError("name")}
            />
            <TextField
              id="material-code"
              name="code"
              label={t("packaging.field.code")}
              defaultValue={material?.code ?? ""}
              required
              maxLength={40}
              autoCapitalize="none"
              spellCheck={false}
              helpText={t("packaging.field.codeHelp")}
              error={fieldError("code")}
            />
            <Select
              id="material-kind"
              name="kind"
              label={t("packaging.materials.col.kind")}
              options={MATERIAL_KINDS.map((k) => ({ value: k, label: t(`materialKind.${k}`) }))}
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value as PackagingMaterialKind)}
              error={fieldError("kind")}
            />
            <Select
              id="material-unit"
              name="unit"
              label={t("packaging.field.unit")}
              options={UNITS.map((u) => ({ value: u, label: t(`materialUnit.${u}`) }))}
              defaultValue={material?.unit ?? "pcs"}
              error={fieldError("unit")}
            />
            <TextField
              id="material-threshold"
              name="lowStockThreshold"
              type="number"
              inputMode="numeric"
              min={0}
              step={1}
              label={t("packaging.field.lowStockThreshold")}
              defaultValue={material?.lowStockThreshold ?? ""}
              helpText={t("packaging.field.lowStockThresholdHelp", { value: defaultThreshold })}
              error={fieldError("lowStockThreshold")}
            />
          </FormLayout>
          {isBox ? (
            <Stack gap={3}>
              <Text variant="heading-sm" as="h3">
                {t("packaging.field.boxTitle")}
              </Text>
              <Text variant="body-sm" tone="subdued">
                {t("packaging.field.boxHelp")}
              </Text>
              <Grid columns={{ xs: 3 }} gap={2}>
                {(["innerLengthMm", "innerWidthMm", "innerHeightMm"] as const).map((f) => (
                  <TextField
                    key={f}
                    id={`material-${f}`}
                    name={f}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    step={1}
                    label={t(`packaging.field.${f}`)}
                    defaultValue={material?.[f] ?? ""}
                    suffix={t("packaging.unit.mm")}
                    error={fieldError(f)}
                  />
                ))}
              </Grid>
              <FormLayout columns={2}>
                <TextField
                  id="material-maxWeight"
                  name="maxWeightGrams"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  label={t("packaging.field.maxWeightGrams")}
                  defaultValue={material?.maxWeightGrams ?? ""}
                  suffix={t("packaging.unit.g")}
                  helpText={t("packaging.field.maxWeightHelp")}
                  error={fieldError("maxWeightGrams")}
                />
                <TextField
                  id="material-tare"
                  name="tareWeightGrams"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  step={1}
                  label={t("packaging.field.tareWeightGrams")}
                  defaultValue={material?.tareWeightGrams ?? ""}
                  suffix={t("packaging.unit.g")}
                  error={fieldError("tareWeightGrams")}
                />
              </FormLayout>
            </Stack>
          ) : null}
          {canSeeCosts ? (
            <FormLayout columns={2}>
              <TextField
                id="material-cost"
                name="unitCost"
                inputMode="decimal"
                label={t("packaging.field.unitCost")}
                defaultValue={material?.unitCost ?? ""}
                placeholder="0.00"
                helpText={t("packaging.field.unitCostHelp")}
                error={fieldError("unitCost")}
              />
              <TextField
                id="material-currency"
                name="costCurrency"
                label={t("packaging.field.costCurrency")}
                defaultValue={material?.costCurrency ?? DEFAULT_COST_CURRENCY}
                maxLength={3}
                error={fieldError("costCurrency")}
              />
            </FormLayout>
          ) : null}
          <Checkbox id="material-active" name="active" label={t("packaging.field.active")} defaultChecked={material?.active ?? true} />
          {material && material.kitLines > 0 && material.active ? (
            <Banner tone="info">{t("packaging.materials.usedInKits", { count: material.kitLines })}</Banner>
          ) : null}
          <Stack direction="horizontal" gap={2}>
            <Button type="submit" variant="primary" loading={busy}>
              {t("common.save")}
            </Button>
            <Button to={closeHref}>{t("common.cancel")}</Button>
          </Stack>
        </Stack>
      </Form>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

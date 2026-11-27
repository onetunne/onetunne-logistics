import { useEffect, useMemo, useRef, useState } from "react";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useHref } from "~/components/shell";
import { can, requirePermission } from "~/domain/permissions";
import { hasKey, useLocale, useT, type TFunction } from "~/i18n";
import { DomainError } from "~/lib/errors";
import { formatDateTime, formatNumber, formatWeight } from "~/lib/format";
import { writeAudit } from "~/modules/audit/audit.server";
import { kitProductMatchesQuery } from "~/modules/packaging/kit-options";
import { normalizeVariantValue } from "~/modules/packaging/kit-resolution";
import {
  collectionModels,
  createKitTemplate,
  deleteKitTemplate,
  listKitCollectionOptions,
  listKitProductOptions,
  listKitTemplates,
  listKitVariantAttributes,
  productModels,
  setKitTemplatesActive,
  updateKitTemplate,
  type KitAppliesTo,
  type KitLinePer,
} from "~/modules/packaging/kits.server";
import { startCollectionsSync } from "~/modules/shopify-sync/collections.server";
import { currentShop } from "~/modules/shopify-sync/sync.server";
import { listMaterials } from "~/modules/packaging/materials.server";
import { findOrderIdByNumber, previewOrderPacking, type OrderPackingPreview } from "~/modules/packaging/preview.server";
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
  Divider,
  EmptyState,
  FormLayout,
  Grid,
  KeyValueList,
  Page,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  type DataTableColumn,
} from "~/ui";

/**
 * «Склад» → «Комплектація» (етап 5, WP «Упаковка»): шаблони — що додається до замовлення (на замовлення) або до
 * кожної одиниці товару (на товар). Ціль шаблону: усі товари, вибрані товари або колекції Shopify (нові товари
 * колекції — автоматично) + необов'язковий фільтр за моделлю/кольором варіанта. Правила — kit-resolution.ts.
 * Перевірка на замовленні показує матеріали (усі шаблони, що підходять) і запропоновану коробку.
 * Дозволи — на сервері (modules/packaging/kits.server.ts): перегляд warehouse.view, зміни warehouse.adjust.
 *
 * Вибір товарів/колекцій у формі не обрізається мовчки: призначені завжди в списку, а коли каталог більший за ліміт —
 * повідомлення й пошук у каталозі (той самий loader з параметром pq/cq через fetcher, стан форми не губиться).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_QUERY_LENGTH = 100;
const BULK_FORM_ID = "kits-bulk";
const STATUS_TABS = ["all", "active", "inactive"] as const;
type StatusTab = (typeof STATUS_TABS)[number];
const APPLIES = ["all", "products", "collections"] as const satisfies readonly KitAppliesTo[];
const isApplies = (v: string | null): v is KitAppliesTo => v !== null && (APPLIES as readonly string[]).includes(v);

interface Filters {
  q: string;
  status: StatusTab;
  appliesTo: KitAppliesTo | null;
  model: string;
  order: string;
}

function parseFilters(params: URLSearchParams): Filters {
  const status = params.get("status");
  const applies = params.get("applies");
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    status: status && (STATUS_TABS as readonly string[]).includes(status) ? (status as StatusTab) : "all",
    appliesTo: isApplies(applies) ? applies : null,
    model: (params.get("model") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    order: (params.get("order") ?? "").trim().slice(0, 40),
  };
}

function buildSearch(f: Partial<Filters> & { edit?: string | null }): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.status && f.status !== "all") params.set("status", f.status);
  if (f.appliesTo) params.set("applies", f.appliesTo);
  if (f.model) params.set("model", f.model);
  if (f.order) params.set("order", f.order);
  if (f.edit) params.set("edit", f.edit);
  const s = params.toString();
  return s ? `?${s}` : "";
}

const lower = (s: string) => s.toLocaleLowerCase("uk");

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const params = new URL(request.url).searchParams;
  const filters = parseFilters(params);
  const canEdit = can(ctx.actor, "warehouse.adjust");
  const templates = await listKitTemplates(ctx.db);
  const attributes = await listKitVariantAttributes(ctx.db);
  const [modelsByProduct, modelsByCollection] = await Promise.all([
    productModels(ctx.db, templates.flatMap((t) => t.products.map((p) => p.id))),
    collectionModels(ctx.db, templates.flatMap((t) => t.collections.map((c) => c.id))),
  ]);
  const models = [...new Set([...attributes.models, ...templates.flatMap((t) => t.models)])].sort((a, b) => a.localeCompare(b));

  const q = lower(filters.q);
  const model = normalizeVariantValue(filters.model);
  const hasModel = (values: readonly string[] | undefined) => (values ?? []).some((v) => normalizeVariantValue(v) === model);
  const visible = templates.filter((tpl) => {
    if (filters.status === "active" && !tpl.active) return false;
    if (filters.status === "inactive" && tpl.active) return false;
    if (filters.appliesTo && tpl.appliesTo !== filters.appliesTo) return false;
    if (model) {
      // Фільтр моделі шаблону — головний; без нього: «усі товари» підходять будь-якій моделі, інакше — моделі цілі.
      if (tpl.models.length > 0) {
        if (!hasModel(tpl.models)) return false;
      } else if (tpl.appliesTo === "products" && !tpl.products.some((p) => hasModel(modelsByProduct.get(p.id)))) return false;
      else if (tpl.appliesTo === "collections" && !tpl.collections.some((c) => hasModel(modelsByCollection.get(c.id)))) return false;
    }
    if (q) {
      const haystack = [
        tpl.name,
        ...tpl.lines.flatMap((l) => [l.materialName, l.materialCode]),
        ...tpl.products.map((p) => p.title),
        ...tpl.collections.map((c) => c.title),
        ...tpl.models,
        ...tpl.colors,
      ].map(lower);
      if (!haystack.some((h) => h.includes(q))) return false;
    }
    return true;
  });

  const editParam = params.get("edit");
  const editing = canEdit && editParam && UUID_RE.test(editParam) ? (templates.find((t) => t.id === editParam) ?? null) : null;
  const creating = canEdit && editParam === "new";
  const editorOpen = Boolean(editing || creating);
  const materials = editorOpen ? (await listMaterials(ctx.db, { activity: "all" })).rows : [];
  // Вибір у формі: призначені шаблону — завжди; решта — до ліміту, з пошуком у каталозі (pq / cq).
  const productQuery = (params.get("pq") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const collectionQuery = (params.get("cq") ?? "").trim().slice(0, MAX_QUERY_LENGTH);
  const [productPage, collectionPage] = editorOpen
    ? await Promise.all([
        listKitProductOptions(ctx.db, { includeIds: editing?.products.map((p) => p.id) ?? [], query: productQuery }),
        listKitCollectionOptions(ctx.db, { includeIds: editing?.collections.map((c) => c.id) ?? [], query: collectionQuery }),
      ])
    : [null, null];

  // Перевірка на замовленні: матеріали комплектації й запропонована коробка (потрібен і перегляд замовлень).
  let check: ({ found: true; query: string } & OrderPackingPreview) | { found: false; query: string } | null = null;
  if (filters.order && can(ctx.actor, "orders.view")) {
    const order = await findOrderIdByNumber(ctx.db, filters.order);
    check = order ? { found: true, query: filters.order, ...(await previewOrderPacking(ctx.db, order.id)) } : { found: false, query: filters.order };
  }

  // Стан синхронізації колекцій (робочий режим): коли востаннє повністю синхронізовано; кнопка — для warehouse.adjust.
  const shop = ctx.mode === "production" ? await currentShop(ctx.db) : null;

  return {
    filters,
    isFiltered: Boolean(filters.q || filters.appliesTo || filters.model),
    templates: visible,
    counts: {
      all: templates.length,
      active: templates.filter((t) => t.active).length,
      inactive: templates.filter((t) => !t.active).length,
    },
    models,
    editing,
    creating,
    canEdit,
    canCheckOrders: can(ctx.actor, "orders.view"),
    materials: materials.map((m) => ({ id: m.id, code: m.code, name: m.name, kind: m.kind, unit: m.unit, active: m.active })),
    productOptions: productPage?.options ?? [],
    productOptionsInfo: productPage ? { total: productPage.total, truncated: productPage.truncated, limit: productPage.limit, query: productQuery } : null,
    collectionOptions: collectionPage?.options ?? [],
    collectionOptionsInfo: collectionPage
      ? { total: collectionPage.total, truncated: collectionPage.truncated, limit: collectionPage.limit, query: collectionQuery }
      : null,
    variantAttributes: editorOpen ? attributes : { models: [], colors: [] },
    collectionsSync: {
      mode: ctx.mode,
      connected: Boolean(shop),
      syncedAt: shop?.collectionsSyncedAt ?? null,
      canSync: canEdit && ctx.mode === "production" && Boolean(shop),
    },
    check,
  };
}

export type KitsActionResult = ActionResult & { intent?: string; templateId?: string };

/**
 * Поля форми шаблону. Рядки редактора без матеріалу (порожні) пропускаються, тому індекси рядків у запиті
 * (і в шляхах помилок zod: lines.N.*) можуть відрізнятися від рядків редактора — lineIndex[N] = індекс рядка редактора.
 */
function kitFormInput(form: FormData) {
  const materialIds = form.getAll("lineMaterialId").map(String);
  const quantities = form.getAll("lineQuantity").map(String);
  const pers = form.getAll("linePer").map(String);
  const kept = materialIds
    .map((materialId, index) => ({ index, materialId: materialId.trim(), quantity: (quantities[index] ?? "").trim(), per: (pers[index] ?? "order") as KitLinePer }))
    .filter((l) => l.materialId !== "");
  return {
    input: {
      name: formString(form, "name"),
      appliesTo: formString(form, "appliesTo") as KitAppliesTo,
      priority: formString(form, "priority"),
      active: form.has("active"),
      lines: kept.map(({ materialId, quantity, per }) => ({ materialId, quantity, per })),
      productIds: form.getAll("productIds").map(String),
      collectionIds: form.getAll("collectionIds").map(String),
      models: form.getAll("models").map(String),
      colors: form.getAll("colors").map(String),
    },
    lineIndex: kept.map((l) => l.index),
  };
}

/** Помилки полів рядків (lines.N.поле) — до індексів рядків редактора (щоб помилка була біля свого рядка). */
function remapLineErrors(fieldErrors: Record<string, string>, lineIndex: readonly number[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, message] of Object.entries(fieldErrors)) {
    const m = /^lines\.(\d+)(\..*)?$/.exec(key);
    const editorIndex = m ? lineIndex[Number(m[1])] : undefined;
    out[m && editorIndex !== undefined ? `lines.${editorIndex}${m[2] ?? ""}` : key] = message;
  }
  return out;
}

export async function action({ request }: ActionFunctionArgs): Promise<KitsActionResult> {
  const ctx = await getRequestContext(request);
  let intent = "";
  let lineIndex: number[] | null = null;
  try {
    requirePermission(ctx.actor, "warehouse.view");
    const form = await request.formData();
    intent = formString(form, "intent");
    if (intent === "createKit") {
      const kit = kitFormInput(form);
      lineIndex = kit.lineIndex;
      const { id } = await createKitTemplate(ctx, kit.input);
      return { ok: true, intent, message: "packaging.kits.result.created", templateId: id };
    }
    if (intent === "updateKit") {
      const id = formString(form, "templateId");
      if (!UUID_RE.test(id)) return { ok: false, intent, error: "error.notFound" };
      const kit = kitFormInput(form);
      lineIndex = kit.lineIndex;
      await updateKitTemplate(ctx, id, kit.input, { expectedVersion: formString(form, "version") || null });
      return { ok: true, intent, message: "packaging.kits.result.updated", templateId: id };
    }
    if (intent === "deleteKit") {
      const id = formString(form, "templateId");
      if (!UUID_RE.test(id)) return { ok: false, intent, error: "error.notFound" };
      await deleteKitTemplate(ctx, id);
      return { ok: true, intent, message: "packaging.kits.result.deleted" };
    }
    if (intent === "syncCollections") {
      // Повна синхронізація колекцій з Shopify (лише робочий режим; та сама, що після повної синхронізації товарів).
      requirePermission(ctx.actor, "warehouse.adjust");
      if (ctx.mode !== "production") throw new DomainError("shopify.demoUnavailable", 409);
      const shop = await currentShop(ctx.db);
      if (!shop) throw new DomainError("shopify.notInstalled", 409);
      await startCollectionsSync(ctx.db, shop.shop);
      await writeAudit(ctx.db, ctx.actor, "shopify.collections_sync_requested", { type: "shop", id: shop.shop });
      return { ok: true, intent, message: "packaging.kits.result.collectionsQueued" };
    }
    if (intent === "setActive") {
      const ids = form.getAll("templateIds").filter((v): v is string => typeof v === "string" && UUID_RE.test(v));
      const active = formString(form, "active") === "1";
      const r = await setKitTemplatesActive(ctx, ids, active);
      return { ok: true, intent, message: active ? "packaging.kits.result.activated" : "packaging.kits.result.deactivated", params: { count: r.updated } };
    }
    return { ok: false, intent, error: "error.generic" };
  } catch (e) {
    const err = toActionError(e);
    if (err.fieldErrors && lineIndex) err.fieldErrors = remapLineErrors(err.fieldErrors, lineIndex);
    return { ...err, intent };
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Row = Data["templates"][number];

function lineSummary(t: TFunction, l: Row["lines"][number]): string {
  return t(`packaging.kits.line.${l.per}`, { name: l.materialName, quantity: l.quantity, unit: t(`materialUnit.${l.materialUnit}`) });
}

export default function KitsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const href = useHref();
  const location = useLocation();
  const navigation = useNavigation();
  const basePath = href("warehouse/kits");
  const { filters } = data;
  const busyIntent = navigation.state === "submitting" ? String(navigation.formData?.get("intent") ?? "") : null;
  const [selected, setSelected] = useState(0);
  const isFormIntent = actionData?.intent === "createKit" || actionData?.intent === "updateKit";
  const listHref = (f: Partial<Filters>) => `${basePath}${buildSearch({ ...filters, ...f })}`;
  const closeHref = listHref({});
  const showForm = (data.creating || data.editing) && !(actionData?.ok && (isFormIntent || actionData.intent === "deleteKit"));
  const activeFilters = [filters.q, filters.appliesTo, filters.model].filter(Boolean).length;

  const tabs = STATUS_TABS.map((s) => ({ key: s, label: t(`packaging.kits.tab.${s}`), href: listHref({ status: s }), count: data.counts[s] }));

  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "name",
      header: t("packaging.kits.col.name"),
      primary: true,
      render: (r) => (
        <Stack gap={1}>
          <Text as="span" weight="semibold">
            {r.name}
          </Text>
          {!r.active ? (
            <Badge size="sm" tone="outline">
              {t("packaging.kits.inactive")}
            </Badge>
          ) : null}
        </Stack>
      ),
    },
    {
      key: "applies",
      header: t("packaging.kits.col.appliesTo"),
      render: (r) => <AppliesSummary row={r} />,
    },
    {
      key: "lines",
      header: t("packaging.kits.col.lines"),
      render: (r) => (
        <Stack as="ul" gap={1}>
          {r.lines.map((l) => (
            <Text as="li" key={l.id} variant="body-sm" tone={l.materialActive ? "default" : "subdued"}>
              {lineSummary(t, l)}
              {!l.materialActive ? ` (${t("packaging.kits.materialInactive")})` : ""}
            </Text>
          ))}
        </Stack>
      ),
    },
    { key: "priority", header: t("packaging.kits.col.priority"), hideOnMobile: true, align: "end", render: (r) => String(r.priority) },
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
      title={t("packaging.kits.title")}
      subtitle={t("packaging.kits.subtitle")}
      backHref={href("warehouse")}
      backLabel={t("nav.warehouse")}
      primaryAction={
        data.canEdit ? (
          <Button variant="primary" to={`${basePath}${buildSearch({ ...filters, edit: "new" })}`}>
            {t("packaging.kits.add")}
          </Button>
        ) : undefined
      }
      secondaryActions={<Button to={href("warehouse/materials")}>{t("packaging.materials.title")}</Button>}
    >
      <Stack gap={4}>
        {actionData && !(isFormIntent && !actionData.ok) ? <ActionBanner data={actionData} /> : null}

        {showForm ? (
          <KitForm
            key={data.editing ? `${data.editing.id}-${data.editing.version}` : "new"}
            template={data.editing}
            materials={data.materials}
            products={data.productOptions}
            productsInfo={data.productOptionsInfo}
            collections={data.collectionOptions}
            collectionsInfo={data.collectionOptionsInfo}
            attributes={data.variantAttributes}
            searchHref={`${basePath}?edit=${data.editing?.id ?? "new"}`}
            closeHref={closeHref}
            result={actionData && !actionData.ok && isFormIntent ? actionData : null}
            busy={busyIntent === "createKit" || busyIntent === "updateKit"}
            deleting={busyIntent === "deleteKit"}
          />
        ) : null}

        <CollectionsSyncCard sync={data.collectionsSync} busy={busyIntent === "syncCollections"} />

        <Tabs items={tabs} selected={filters.status} ariaLabel={t("packaging.kits.tabsLabel")} />

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
                    id="kits-filter-q"
                    type="search"
                    name="q"
                    label={t("common.search")}
                    placeholder={t("packaging.kits.searchPlaceholder")}
                    defaultValue={filters.q}
                    maxLength={MAX_QUERY_LENGTH}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <Select
                    id="kits-filter-applies"
                    name="applies"
                    label={t("packaging.kits.col.appliesTo")}
                    placeholder={t("packaging.filters.any")}
                    options={APPLIES.map((a) => ({ value: a, label: t(`packaging.kits.appliesTo.${a}`) }))}
                    defaultValue={filters.appliesTo ?? ""}
                  />
                  <Select
                    id="kits-filter-model"
                    name="model"
                    label={t("packaging.filters.model")}
                    placeholder={t("packaging.filters.anyModel")}
                    options={data.models.map((m) => ({ value: m, label: m }))}
                    defaultValue={filters.model}
                  />
                </Grid>
                <Stack direction="horizontal" gap={2}>
                  <Button type="submit" variant="primary">
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

        {data.canEdit && data.templates.length > 0 ? (
          <Card>
            <Form id={BULK_FORM_ID} method="post" aria-label={t("packaging.kits.bulkLabel")}>
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
                    title={t("packaging.kits.deactivateTitle")}
                    confirmLabel={t("packaging.kits.deactivate")}
                    cancelLabel={t("common.cancel")}
                    message={<Text>{t("packaging.kits.deactivateMessage", { count: selected })}</Text>}
                  >
                    {t("packaging.kits.deactivate")}
                  </ConfirmSubmitButton>
                  <ConfirmSubmitButton
                    name="active"
                    value="1"
                    disabled={selected === 0 || busyIntent === "setActive"}
                    title={t("packaging.kits.activateTitle")}
                    confirmLabel={t("packaging.kits.activate")}
                    cancelLabel={t("common.cancel")}
                    message={<Text>{t("packaging.kits.activateMessage", { count: selected })}</Text>}
                  >
                    {t("packaging.kits.activate")}
                  </ConfirmSubmitButton>
                </Stack>
              </Stack>
            </Form>
          </Card>
        ) : null}

        <Card padded={false}>
          <DataTable<Row>
            key={location.search}
            caption={t("packaging.kits.title")}
            rows={data.templates}
            rowKey={(r) => r.id}
            columns={columns}
            selection={
              data.canEdit
                ? {
                    name: "templateIds",
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
                title={t(data.isFiltered || filters.status !== "all" ? "packaging.kits.empty.filtered" : "packaging.kits.empty.title")}
                description={t("packaging.kits.empty.description")}
                action={data.isFiltered || filters.status !== "all" ? <Button to={basePath}>{t("common.reset")}</Button> : undefined}
              />
            }
          />
        </Card>

        {data.canCheckOrders ? <OrderCheckCard filters={filters} check={data.check} /> : null}
      </Stack>
    </Page>
  );
}

function OrderCheckCard({ filters, check }: { filters: Filters; check: Data["check"] }) {
  const t = useT();
  const locale = useLocale();
  return (
    <Card title={t("packaging.check.title")} description={t("packaging.check.description")}>
      <Stack gap={3}>
        <Form method="get" role="search">
          {(["q", "model"] as const).map((k) => (filters[k] ? <input key={k} type="hidden" name={k} value={filters[k]} /> : null))}
          {filters.status !== "all" ? <input type="hidden" name="status" value={filters.status} /> : null}
          {filters.appliesTo ? <input type="hidden" name="applies" value={filters.appliesTo} /> : null}
          <Stack direction="horizontal" gap={2} align="end">
            <TextField
              id="kits-check-order"
              name="order"
              label={t("packaging.check.orderNumber")}
              placeholder="#1001"
              defaultValue={filters.order}
              maxLength={40}
              autoComplete="off"
            />
            <Button type="submit">{t("packaging.check.submit")}</Button>
          </Stack>
        </Form>
        {check && !check.found ? <Text tone="critical">{t("packaging.check.notFound", { number: check.query })}</Text> : null}
        {check && check.found ? (
          <Stack gap={3}>
            <Text variant="heading-sm" as="h3">
              {t("packaging.check.resultTitle", { number: check.orderNumber })}
            </Text>
            <KeyValueList
              items={[
                {
                  key: "box",
                  label: t("packaging.check.box"),
                  value: (
                    <Stack gap={1}>
                      <Text as="span" weight="semibold">
                        {check.box ? `${check.box.name} (${check.box.code})` : t("packaging.check.noBox")}
                      </Text>
                      <Text as="span" variant="body-sm" tone={check.box && check.boxReason === "fits" ? "subdued" : "warning"}>
                        {t(`packaging.boxReason.${check.boxReason}`)}
                      </Text>
                      {check.boxFlags.outOfStock ? (
                        <Text as="span" variant="caption" tone="warning">
                          {t("packaging.check.boxOutOfStock")}
                        </Text>
                      ) : null}
                      {check.boxFlags.missingWeightUnits > 0 ? (
                        <Text as="span" variant="caption" tone="warning">
                          {t("packaging.check.missingWeight", { count: check.boxFlags.missingWeightUnits })}
                        </Text>
                      ) : null}
                    </Stack>
                  ),
                },
                {
                  key: "goods",
                  label: t("packaging.check.goods"),
                  value: t("packaging.check.goodsValue", {
                    units: check.goods.units,
                    measured: check.goods.measuredUnits,
                    weight: formatWeight(check.goods.weightGrams, locale),
                  }),
                },
              ]}
            />
            {check.materials.length === 0 ? (
              <Text tone="subdued">{t("packaging.check.noMaterials")}</Text>
            ) : (
              <Stack as="ul" gap={2}>
                {check.materials.map((m) => (
                  <Stack as="li" key={m.materialId} gap={0}>
                    <Text as="span" variant="body-sm" weight="semibold" numeric>
                      {m.name} — {formatNumber(m.quantity, locale)} {t(`materialUnit.${m.unit}`)}
                    </Text>
                    <Text as="span" variant="caption" tone="subdued">
                      {m.templateNames.join(", ")}
                    </Text>
                  </Stack>
                ))}
              </Stack>
            )}
          </Stack>
        ) : null}
      </Stack>
    </Card>
  );
}

function fieldErrorFn(t: TFunction, result: KitsActionResult | null) {
  const errors = result && !result.ok ? result.fieldErrors : undefined;
  return (name: string): string | null => {
    const message = errors?.[name];
    if (!message) return null;
    return t(hasKey(message) ? message : "packaging.error.invalid");
  };
}

interface EditorLine {
  key: number;
  materialId: string;
  quantity: string;
  per: KitLinePer;
}

type ProductOption = Data["productOptions"][number];
type CollectionOption = Data["collectionOptions"][number];
type OptionsInfo = NonNullable<Data["productOptionsInfo"]>;

/** «Застосовується до» у списку: ціль, перші назви, фільтр моделі/кольору, попередження про видалені колекції. */
function AppliesSummary({ row }: { row: Row }) {
  const t = useT();
  const names = (titles: string[]) => `${titles.slice(0, 3).join(", ")}${titles.length > 3 ? ` +${titles.length - 3}` : ""}`;
  const deleted = row.collections.filter((c) => c.deleted).length;
  const filter = [...row.models, ...row.colors];
  return (
    <Stack gap={1}>
      <Text as="span" variant="body-sm">
        {row.appliesTo === "all"
          ? t("packaging.kits.appliesTo.all")
          : row.appliesTo === "products"
            ? t("packaging.kits.appliesTo.productsCount", { count: row.products.length })
            : t("packaging.kits.appliesTo.collectionsCount", { count: row.collections.length })}
      </Text>
      {row.appliesTo === "products" && row.products.length > 0 ? (
        <Text as="span" variant="caption" tone="subdued">
          {names(row.products.map((p) => p.title))}
        </Text>
      ) : null}
      {row.appliesTo === "collections" && row.collections.length > 0 ? (
        <Text as="span" variant="caption" tone="subdued">
          {names(row.collections.map((c) => c.title))}
        </Text>
      ) : null}
      {filter.length > 0 ? (
        <Text as="span" variant="caption">
          {t("packaging.kits.variantFilter.summary", { values: filter.join(", ") })}
        </Text>
      ) : null}
      {row.appliesTo === "collections" && deleted > 0 ? (
        <Text as="span" variant="caption" tone="warning">
          {t("packaging.kits.collectionsDeletedCount", { count: deleted })}
        </Text>
      ) : null}
    </Stack>
  );
}

/** Звідки беруться колекції: демо — вигадані; робочий режим — синхронізація з Shopify (і кнопка для власника). */
function CollectionsSyncCard({ sync, busy }: { sync: Data["collectionsSync"]; busy: boolean }) {
  const t = useT();
  const locale = useLocale();
  if (sync.mode !== "production") {
    return (
      <Text variant="body-sm" tone="subdued">
        {t("packaging.kits.sync.demo")}
      </Text>
    );
  }
  return (
    <Card>
      <Stack direction="horizontal" gap={3} align="center" justify="between">
        <Stack gap={1}>
          <Text weight="semibold">{t("packaging.kits.sync.title")}</Text>
          <Text variant="body-sm" tone="subdued">
            {sync.syncedAt ? t("packaging.kits.sync.syncedAt", { date: formatDateTime(sync.syncedAt, locale) }) : t("packaging.kits.sync.never")}
          </Text>
          <Text variant="caption" tone="subdued">
            {t("packaging.kits.sync.help")}
          </Text>
        </Stack>
        {sync.canSync ? (
          <Form method="post">
            <input type="hidden" name="intent" value="syncCollections" />
            <Button type="submit" loading={busy}>
              {t("packaging.kits.sync.button")}
            </Button>
          </Form>
        ) : null}
      </Stack>
    </Card>
  );
}

/** Об'єднання варіантів вибору: початкові (з призначеними) + знайдені пошуком у каталозі; порядок — за назвою. */
function mergeOptions<T extends { id: string; title: string }>(base: readonly T[], extra: ReadonlyMap<string, T>): T[] {
  const byId = new Map(base.map((o) => [o.id, o]));
  for (const [id, o] of extra) if (!byId.has(id)) byId.set(id, o);
  return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Повідомлення «показано не всі» + пошук у каталозі (на сервері, без втрати стану форми). */
function CatalogSearch({
  info,
  shown,
  query,
  loading,
  onSearch,
}: {
  info: OptionsInfo | null;
  shown: number;
  query: string;
  loading: boolean;
  onSearch: () => void;
}) {
  const t = useT();
  if (!info?.truncated) return null;
  return (
    <Banner tone="warning">
      <Stack gap={2}>
        <Text variant="body-sm">{t("packaging.kits.optionsTruncated", { shown, total: info.total })}</Text>
        <div>
          <Button size="sm" onClick={onSearch} disabled={!query.trim()} loading={loading}>
            {t("packaging.kits.searchCatalog")}
          </Button>
        </div>
      </Stack>
    </Banner>
  );
}

/** Групи прапорців фільтра моделі/кольору (значення шаблону, яких уже немає в каталозі, теж показуються). */
function VariantFilter({ template, attributes }: { template: Row | null; attributes: Data["variantAttributes"] }) {
  const t = useT();
  const groups = (
    [
      ["models", attributes.models, template?.models ?? []],
      ["colors", attributes.colors, template?.colors ?? []],
    ] as const
  ).map(([name, catalog, saved]) => {
    const known = new Set(catalog.map(normalizeVariantValue));
    return { name, values: [...catalog, ...saved.filter((v) => !known.has(normalizeVariantValue(v)))], saved: new Set(saved.map(normalizeVariantValue)) };
  });
  const active = (template?.models.length ?? 0) + (template?.colors.length ?? 0);
  return (
    <Disclosure
      defaultOpen={active > 0}
      summary={active > 0 ? t("packaging.kits.variantFilter.titleActive", { count: active }) : t("packaging.kits.variantFilter.title")}
    >
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {t("packaging.kits.variantFilter.help")}
        </Text>
        {groups.every((g) => g.values.length === 0) ? <Text tone="subdued">{t("packaging.kits.variantFilter.none")}</Text> : null}
        <Grid columns={{ xs: 1, md: 2 }} gap={3}>
          {groups.map((g) =>
            g.values.length > 0 ? (
              <fieldset key={g.name} style={{ border: 0, margin: 0, padding: 0, minWidth: 0, display: "grid", gap: "4px" }}>
                <legend style={{ padding: 0, marginBottom: "4px" }}>
                  <Text as="span" variant="body-sm" weight="semibold">
                    {t(`packaging.kits.variantFilter.${g.name}`)}
                  </Text>
                </legend>
                {g.values.map((v, i) => (
                  <Checkbox
                    key={v}
                    id={`kit-${g.name}-${i}`}
                    name={g.name}
                    value={v}
                    defaultChecked={g.saved.has(normalizeVariantValue(v))}
                    label={v}
                  />
                ))}
              </fieldset>
            ) : null,
          )}
        </Grid>
      </Stack>
    </Disclosure>
  );
}

function KitForm({
  template,
  materials,
  products: initialProducts,
  productsInfo,
  collections: initialCollections,
  collectionsInfo,
  attributes,
  searchHref,
  closeHref,
  result,
  busy,
  deleting,
}: {
  template: Row | null;
  materials: Data["materials"];
  products: Data["productOptions"];
  productsInfo: Data["productOptionsInfo"];
  collections: Data["collectionOptions"];
  collectionsInfo: Data["collectionOptionsInfo"];
  attributes: Data["variantAttributes"];
  searchHref: string;
  closeHref: string;
  result: KitsActionResult | null;
  busy: boolean;
  deleting: boolean;
}) {
  const t = useT();
  const fieldError = fieldErrorFn(t, result);
  const nextKey = useRef(1000);
  const [appliesTo, setAppliesTo] = useState<KitAppliesTo>(template?.appliesTo ?? "all");
  const [lines, setLines] = useState<EditorLine[]>(() =>
    template && template.lines.length > 0
      ? template.lines.map((l, i) => ({ key: i, materialId: l.materialId, quantity: String(l.quantity), per: l.per }))
      : [{ key: 0, materialId: "", quantity: "1", per: "order" }],
  );
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(template?.products.map((p) => p.id) ?? []));
  const [chosenCollections, setChosenCollections] = useState<Set<string>>(() => new Set(template?.collections.map((c) => c.id) ?? []));
  const [search, setSearch] = useState("");
  const [collectionSearch, setCollectionSearch] = useState("");
  const [model, setModel] = useState("");
  const [color, setColor] = useState("");

  // Пошук у каталозі поза лімітом списку: той самий loader (pq / cq), знайдене додається до списку вибору.
  const productFetcher = useFetcher<typeof loader>();
  const collectionFetcher = useFetcher<typeof loader>();
  const [foundProducts, setFoundProducts] = useState<Map<string, ProductOption>>(() => new Map());
  const [foundCollections, setFoundCollections] = useState<Map<string, CollectionOption>>(() => new Map());
  useEffect(() => {
    const found = productFetcher.data?.productOptions;
    if (found) setFoundProducts((prev) => new Map([...prev, ...found.map((o) => [o.id, o] as const)]));
  }, [productFetcher.data]);
  useEffect(() => {
    const found = collectionFetcher.data?.collectionOptions;
    if (found) setFoundCollections((prev) => new Map([...prev, ...found.map((o) => [o.id, o] as const)]));
  }, [collectionFetcher.data]);
  const products = useMemo(() => mergeOptions(initialProducts, foundProducts), [initialProducts, foundProducts]);
  const collectionOptions = useMemo(() => mergeOptions(initialCollections, foundCollections), [initialCollections, foundCollections]);
  const productIdsShown = new Set(products.map((p) => p.id));
  const collectionIdsShown = new Set(collectionOptions.map((c) => c.id));

  const models = useMemo(() => [...new Set(products.flatMap((p) => p.models))].sort((a, b) => a.localeCompare(b)), [products]);
  const colors = useMemo(() => [...new Set(products.flatMap((p) => p.colors))].sort((a, b) => a.localeCompare(b)), [products]);
  const visibleIds = useMemo(() => {
    const q = lower(search.trim());
    return new Set(
      products
        .filter((p) => (!model || p.models.includes(model)) && (!color || p.colors.includes(color)))
        // Ті самі поля, що й серверний пошук у каталозі (штрихкод, handle, назва варіанта — теж).
        .filter((p) => !q || kitProductMatchesQuery(p, q))
        .map((p) => p.id),
    );
  }, [products, search, model, color]);
  const visibleCollectionIds = useMemo(() => {
    const q = lower(collectionSearch.trim());
    return new Set(collectionOptions.filter((c) => !q || [c.title, c.handle ?? ""].some((v) => lower(v).includes(q))).map((c) => c.id));
  }, [collectionOptions, collectionSearch]);

  const materialOptions = materials
    .filter((m) => m.active || lines.some((l) => l.materialId === m.id))
    .map((m) => ({
      value: m.id,
      label: `${m.name} (${m.code})${m.active ? "" : ` — ${t("packaging.kits.materialInactive")}`}`,
    }));
  const updateLine = (key: number, patch: Partial<EditorLine>) => setLines((prev) => prev.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const toggle = (setter: typeof setChosen, id: string, on: boolean) =>
    setter((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Card
      title={template ? t("packaging.kits.editTitle", { name: template.name }) : t("packaging.kits.add")}
      actions={<Button to={closeHref}>{t("common.close")}</Button>}
    >
      <Stack gap={4}>
        <Form method="post">
          <input type="hidden" name="intent" value={template ? "updateKit" : "createKit"} />
          {template ? <input type="hidden" name="templateId" value={template.id} /> : null}
          {template ? <input type="hidden" name="version" value={template.version} /> : null}
          <Stack gap={4}>
            {result ? <ActionBanner data={result} /> : null}
            <FormLayout columns={2}>
              <TextField
                id="kit-name"
                name="name"
                label={t("packaging.kits.field.name")}
                defaultValue={template?.name ?? ""}
                required
                maxLength={120}
                error={fieldError("name")}
              />
              <TextField
                id="kit-priority"
                name="priority"
                type="number"
                inputMode="numeric"
                step={1}
                label={t("packaging.kits.col.priority")}
                defaultValue={template?.priority ?? 0}
                helpText={t("packaging.kits.field.priorityHelp")}
                error={fieldError("priority")}
              />
              <Select
                id="kit-applies"
                name="appliesTo"
                label={t("packaging.kits.col.appliesTo")}
                options={APPLIES.map((a) => ({ value: a, label: t(`packaging.kits.appliesTo.${a}`) }))}
                value={appliesTo}
                onChange={(e) => {
                  const v = e.currentTarget.value;
                  setAppliesTo(isApplies(v) ? v : "all");
                }}
                helpText={t(`packaging.kits.appliesToHelp.${appliesTo}`)}
              />
            </FormLayout>
            <Checkbox id="kit-active" name="active" label={t("packaging.kits.field.active")} defaultChecked={template?.active ?? true} />
            <Text variant="caption" tone="subdued">
              {t("packaging.kits.precedenceHelp")}
            </Text>

            <Stack gap={3}>
              <Text as="h3" variant="heading-sm">
                {t("packaging.kits.field.lines")}
              </Text>
              {fieldError("lines") ? <Text tone="critical">{fieldError("lines")}</Text> : null}
              {lines.map((line, index) => (
                <Stack key={line.key} gap={2}>
                  {index > 0 ? <Divider /> : null}
                  <Grid columns={{ xs: 1, md: 4 }} gap={2}>
                    <Select
                      id={`kit-line-material-${line.key}`}
                      name="lineMaterialId"
                      label={t("packaging.kits.field.material")}
                      placeholder={t("packaging.kits.field.materialPlaceholder")}
                      options={materialOptions}
                      value={line.materialId}
                      onChange={(e) => updateLine(line.key, { materialId: e.currentTarget.value })}
                      error={fieldError(`lines.${index}.materialId`)}
                    />
                    <TextField
                      id={`kit-line-qty-${line.key}`}
                      name="lineQuantity"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      step={1}
                      label={t("packaging.kits.field.quantity")}
                      value={line.quantity}
                      onChange={(e) => updateLine(line.key, { quantity: e.currentTarget.value })}
                      error={fieldError(`lines.${index}.quantity`)}
                    />
                    <Select
                      id={`kit-line-per-${line.key}`}
                      name="linePer"
                      label={t("packaging.kits.field.per")}
                      options={(["order", "item"] as const).map((p) => ({ value: p, label: t(`packaging.kits.per.${p}`) }))}
                      value={line.per}
                      onChange={(e) => updateLine(line.key, { per: e.currentTarget.value === "item" ? "item" : "order" })}
                    />
                    <Stack justify="end">
                      <Button
                        variant="plain"
                        disabled={lines.length === 1}
                        onClick={() => setLines((prev) => prev.filter((l) => l.key !== line.key))}
                        aria-label={t("packaging.kits.removeLineLabel", { index: index + 1 })}
                      >
                        {t("packaging.kits.removeLine")}
                      </Button>
                    </Stack>
                  </Grid>
                </Stack>
              ))}
              <div>
                <Button
                  onClick={() => setLines((prev) => [...prev, { key: nextKey.current++, materialId: "", quantity: "1", per: "order" }])}
                  disabled={lines.length >= 50}
                >
                  {t("packaging.kits.addLine")}
                </Button>
              </div>
            </Stack>

            {appliesTo === "products" ? (
              <Stack gap={3}>
                <Text as="h3" variant="heading-sm">
                  {t("packaging.kits.field.products", { count: chosen.size })}
                </Text>
                {fieldError("productIds") ? <Text tone="critical">{fieldError("productIds")}</Text> : null}
                <Text variant="caption" tone="subdued">
                  {t("packaging.kits.productPickerHelp")}
                </Text>
                <Grid columns={{ xs: 1, md: 3 }} gap={2}>
                  <TextField
                    id="kit-products-search"
                    name="productSearch"
                    type="search"
                    label={t("common.search")}
                    placeholder={t("packaging.kits.productSearchPlaceholder")}
                    value={search}
                    onChange={(e) => setSearch(e.currentTarget.value)}
                    maxLength={MAX_QUERY_LENGTH}
                    autoComplete="off"
                  />
                  <Select
                    id="kit-products-model"
                    name="productModel"
                    label={t("packaging.filters.model")}
                    placeholder={t("packaging.filters.anyModel")}
                    options={models.map((m) => ({ value: m, label: m }))}
                    value={model}
                    onChange={(e) => setModel(e.currentTarget.value)}
                  />
                  <Select
                    id="kit-products-color"
                    name="productColor"
                    label={t("packaging.filters.color")}
                    placeholder={t("packaging.filters.anyColor")}
                    options={colors.map((c) => ({ value: c, label: c }))}
                    value={color}
                    onChange={(e) => setColor(e.currentTarget.value)}
                  />
                </Grid>
                <CatalogSearch
                  info={productsInfo}
                  shown={initialProducts.length}
                  query={search}
                  loading={productFetcher.state !== "idle"}
                  onSearch={() => productFetcher.load(`${searchHref}&pq=${encodeURIComponent(search.trim())}`)}
                />
                <Stack direction="horizontal" gap={2}>
                  <Button size="sm" onClick={() => setChosen((prev) => new Set([...prev, ...visibleIds]))} disabled={visibleIds.size === 0}>
                    {t("packaging.kits.selectVisible", { count: visibleIds.size })}
                  </Button>
                  <Button size="sm" onClick={() => setChosen((prev) => new Set([...prev].filter((id) => !visibleIds.has(id))))}>
                    {t("packaging.kits.clearVisible")}
                  </Button>
                </Stack>
                {/* Вибране, якого немає в списку (не повинно траплятися), усе одно надсилається — шаблон не втрачає товарів. */}
                {[...chosen]
                  .filter((id) => !productIdsShown.has(id))
                  .map((id) => (
                    <input key={id} type="hidden" name="productIds" value={id} />
                  ))}
                <Stack as="ul" gap={1}>
                  {products.map((p) => (
                    <li key={p.id} hidden={!visibleIds.has(p.id)}>
                      <Stack direction="horizontal" gap={2} align="center" wrap={false}>
                        <Thumbnail src={p.imageUrl} alt="" size="sm" />
                        <Checkbox
                          id={`kit-product-${p.id}`}
                          name="productIds"
                          value={p.id}
                          checked={chosen.has(p.id)}
                          onChange={(e) => toggle(setChosen, p.id, e.currentTarget.checked)}
                          label={
                            <Stack as="span" gap={0}>
                              <span>{p.title}</span>
                              {p.models.length || p.colors.length ? (
                                <Text as="span" variant="caption" tone="subdued">
                                  {[...p.models, ...p.colors].join(" · ")}
                                </Text>
                              ) : null}
                            </Stack>
                          }
                        />
                      </Stack>
                    </li>
                  ))}
                </Stack>
                {visibleIds.size === 0 ? <Text tone="subdued">{t("packaging.kits.noProducts")}</Text> : null}
              </Stack>
            ) : null}

            {appliesTo === "collections" ? (
              <Stack gap={3}>
                <Text as="h3" variant="heading-sm">
                  {t("packaging.kits.field.collections", { count: chosenCollections.size })}
                </Text>
                {fieldError("collectionIds") ? <Text tone="critical">{fieldError("collectionIds")}</Text> : null}
                <Text variant="caption" tone="subdued">
                  {t("packaging.kits.collectionPickerHelp")}
                </Text>
                {collectionOptions.length === 0 ? (
                  <Text tone="subdued">{t("packaging.kits.collectionsNoneYet")}</Text>
                ) : (
                  <TextField
                    id="kit-collections-search"
                    name="collectionSearch"
                    type="search"
                    label={t("common.search")}
                    placeholder={t("packaging.kits.collectionSearchPlaceholder")}
                    value={collectionSearch}
                    onChange={(e) => setCollectionSearch(e.currentTarget.value)}
                    maxLength={MAX_QUERY_LENGTH}
                    autoComplete="off"
                  />
                )}
                <CatalogSearch
                  info={collectionsInfo}
                  shown={initialCollections.length}
                  query={collectionSearch}
                  loading={collectionFetcher.state !== "idle"}
                  onSearch={() => collectionFetcher.load(`${searchHref}&cq=${encodeURIComponent(collectionSearch.trim())}`)}
                />
                {[...chosenCollections]
                  .filter((id) => !collectionIdsShown.has(id))
                  .map((id) => (
                    <input key={id} type="hidden" name="collectionIds" value={id} />
                  ))}
                <Stack as="ul" gap={1}>
                  {collectionOptions.map((c) => (
                    <li key={c.id} hidden={!visibleCollectionIds.has(c.id)}>
                      <Checkbox
                        id={`kit-collection-${c.id}`}
                        name="collectionIds"
                        value={c.id}
                        checked={chosenCollections.has(c.id)}
                        onChange={(e) => toggle(setChosenCollections, c.id, e.currentTarget.checked)}
                        label={
                          <Stack as="span" gap={0}>
                            <span>{c.title}</span>
                            <Text as="span" variant="caption" tone={c.deleted ? "warning" : "subdued"}>
                              {c.deleted ? t("packaging.kits.collectionDeleted") : t("packaging.kits.collectionProducts", { count: c.productsCount })}
                            </Text>
                          </Stack>
                        }
                      />
                    </li>
                  ))}
                </Stack>
                {collectionOptions.length > 0 && visibleCollectionIds.size === 0 ? <Text tone="subdued">{t("packaging.kits.noCollections")}</Text> : null}
              </Stack>
            ) : null}

            <VariantFilter template={template} attributes={attributes} />
            {fieldError("models") || fieldError("colors") ? <Text tone="critical">{fieldError("models") ?? fieldError("colors")}</Text> : null}

            <Stack direction="horizontal" gap={2}>
              <Button type="submit" variant="primary" loading={busy}>
                {t("common.save")}
              </Button>
              <Button to={closeHref}>{t("common.cancel")}</Button>
            </Stack>
          </Stack>
        </Form>
        {template ? (
          <Form method="post">
            <input type="hidden" name="templateId" value={template.id} />
            <ConfirmSubmitButton
              name="intent"
              value="deleteKit"
              variant="critical"
              loading={deleting}
              title={t("packaging.kits.deleteTitle")}
              confirmLabel={t("packaging.kits.delete")}
              cancelLabel={t("common.cancel")}
              message={<Text>{t("packaging.kits.deleteMessage", { name: template.name })}</Text>}
            >
              {t("packaging.kits.delete")}
            </ConfirmSubmitButton>
          </Form>
        ) : null}
      </Stack>
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

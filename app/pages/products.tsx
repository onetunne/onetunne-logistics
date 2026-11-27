import type { ReactNode } from "react";
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
import { useCan, useHref } from "~/components/shell";
import { OverriddenBadge, VariantCustomsForm } from "~/components/variant-customs-form";
import { requirePermission } from "~/domain/permissions";
import { useLocale, useT } from "~/i18n";
import { countryName, formatWeight } from "~/lib/format";
import { updateVariantCustomsData } from "~/modules/orders/workflow.server";
import { OVERRIDE_FIELDS, type OverrideField } from "~/modules/products/customs-overrides";
import { VARIANTS_PAGE_SIZE, listVariants } from "~/modules/products/repository.server";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  Divider,
  EmptyState,
  InlineCode,
  KeyValueList,
  Page,
  Pagination,
  Stack,
  Text,
  TextField,
  Thumbnail,
  type KeyValueItem,
} from "~/ui";

/**
 * Розділ «Товари» (етап 3): митні дані, вага й габарити кожного варіанта.
 * Зміни зберігаються як перевизначення застосунку (product_variants.customs_overrides): пріоритет над Shopify,
 * синхронізація їх не перезаписує, порожнє поле — значення з Shopify. Логіка — у modules/products і orders/workflow.
 */

const MAX_QUERY_LENGTH = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Shopify називає єдиний варіант товару «Default Title» — не показуємо. */
const DEFAULT_VARIANT_TITLE = "Default Title";

interface ProductFilters {
  q: string;
  missing: boolean;
  page: number;
}

function parseFilters(params: URLSearchParams): ProductFilters {
  const pageRaw = (params.get("page") ?? "").trim();
  return {
    q: (params.get("q") ?? "").trim().slice(0, MAX_QUERY_LENGTH),
    missing: params.get("missing") === "1",
    page: /^\d{1,6}$/.test(pageRaw) ? Math.max(1, Number(pageRaw)) : 1,
  };
}

function buildSearch(f: Partial<ProductFilters>): string {
  const params = new URLSearchParams();
  if (f.q) params.set("q", f.q);
  if (f.missing) params.set("missing", "1");
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const search = params.toString();
  return search ? `?${search}` : "";
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const filters = parseFilters(new URL(request.url).searchParams);
  const listFilter = { q: filters.q || null, missing: filters.missing, pageSize: VARIANTS_PAGE_SIZE };
  const first = await listVariants(ctx.db, { ...listFilter, page: filters.page });
  const pages = Math.max(1, Math.ceil(first.total / first.pageSize));
  // Застаріле посилання на сторінку за межами списку → остання наявна сторінка.
  const list = first.page > pages ? await listVariants(ctx.db, { ...listFilter, page: pages }) : first;
  return {
    isDemo: ctx.mode === "demo",
    filters: { ...filters, page: list.page },
    isFiltered: Boolean(filters.q || filters.missing),
    rows: list.rows.map((r) => ({
      ...r,
      variantTitle: r.variantTitle === DEFAULT_VARIANT_TITLE ? "" : r.variantTitle,
      originName: r.effective.countryOfOrigin ? countryName(r.effective.countryOfOrigin, ctx.locale) : null,
    })),
    total: list.total,
    page: list.page,
    pages,
    pageSize: list.pageSize,
    missingTotal: list.missingTotal,
  };
}

type ProductActionResult = ActionResult & { variantId?: string };

export async function action({ request }: ActionFunctionArgs): Promise<ProductActionResult> {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.edit");
    const form = await request.formData();
    if (formString(form, "intent") !== "updateVariant") return { ok: false, error: "error.generic" };
    const variantId = formString(form, "variantId").trim();
    if (!UUID_RE.test(variantId)) return { ok: false, error: "error.notFound" };
    const input = Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f, formString(form, f)])) as Record<OverrideField, string>;
    try {
      const r = await updateVariantCustomsData(ctx, variantId, input);
      return { ok: true, message: "result.product.updated", params: { count: r.revalidated }, variantId };
    } catch (e) {
      // Помилки полів прив'язуємо до конкретного варіанта (на сторінці кілька форм).
      const err = toActionError(e);
      if (err.fieldErrors) {
        err.fieldErrors = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [`variant.${variantId}.${k}`, v]));
      }
      return { ...err, variantId };
    }
  } catch (e) {
    return toActionError(e);
  }
}

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type Row = Data["rows"][number];

export default function ProductsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const can = useCan();
  const href = useHref();
  const location = useLocation();
  const navigation = useNavigation();
  const { filters, rows } = data;
  const productsPath = href("products");
  const canEdit = can("orders.edit");
  const listHref = (f: Partial<ProductFilters>) => `${productsPath}${buildSearch(f)}`;
  const isFiltering =
    navigation.state === "loading" && navigation.formMethod?.toUpperCase() === "GET" && navigation.location.pathname === location.pathname;
  const from = data.total === 0 ? 0 : (data.page - 1) * data.pageSize + 1;
  const to = from === 0 ? 0 : from + rows.length - 1;
  const inlineResult = actionData?.variantId && rows.some((r) => r.id === actionData.variantId) ? actionData : null;

  return (
    <Page title={t("nav.products")} subtitle={t("products.subtitle")}>
      <Stack gap={4}>
        {inlineResult ? null : <ActionBanner data={actionData} />}

        <Banner tone="info" title={t("products.info.title")}>
          <p>{t(data.isDemo ? "products.info.demo" : "products.info.production")}</p>
        </Banner>

        <Card title={t("common.filters")}>
          <Form key={location.search} method="get" role="search">
            <Stack gap={4}>
              <TextField
                id="products-filter-q"
                type="search"
                name="q"
                label={t("common.search")}
                placeholder={t("products.filters.searchPlaceholder")}
                defaultValue={filters.q}
                maxLength={MAX_QUERY_LENGTH}
                autoComplete="off"
                spellCheck={false}
              />
              <Checkbox
                id="products-filter-missing"
                name="missing"
                value="1"
                label={t("products.filters.missingOnly")}
                defaultChecked={filters.missing}
              />
              <Text variant="body-sm" tone={data.missingTotal > 0 ? "critical" : "subdued"}>
                {t("products.missingCount", { count: data.missingTotal })}
              </Text>
              <Stack direction="horizontal" gap={2}>
                <Button type="submit" variant="primary" loading={isFiltering}>
                  {t("common.apply")}
                </Button>
                <Button to={productsPath} disabled={!data.isFiltered}>
                  {t("common.reset")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        </Card>

        <Card title={t("products.list.caption")}>
          {rows.length === 0 ? (
            data.isFiltered ? (
              <EmptyState
                title={t("products.empty.filtered.title")}
                description={t("products.empty.filtered.description")}
                action={<Button to={productsPath}>{t("common.reset")}</Button>}
              />
            ) : (
              <EmptyState
                title={t("products.empty.title")}
                description={t(data.isDemo ? "products.empty.demo" : "products.empty.production")}
              />
            )
          ) : (
            <Stack as="ul" gap={4}>
              {rows.map((row, index) => (
                <Stack as="li" key={row.id} gap={3}>
                  {index > 0 ? <Divider /> : null}
                  <VariantItem
                    row={row}
                    isDemo={data.isDemo}
                    canEdit={canEdit}
                    result={inlineResult?.variantId === row.id ? inlineResult : null}
                  />
                </Stack>
              ))}
            </Stack>
          )}
        </Card>

        {data.total > 0 ? (
          <Stack direction="horizontal" gap={3} align="center" justify="between">
            <Text variant="body-sm" tone="subdued">
              {t("products.list.range", { from, to, total: data.total })}
            </Text>
            <Pagination
              prevHref={data.page > 1 ? listHref({ ...filters, page: data.page - 1 }) : null}
              nextHref={data.page < data.pages ? listHref({ ...filters, page: data.page + 1 }) : null}
              label={t("common.pageOf", { page: data.page, pages: data.pages })}
              prevLabel={t("common.previous")}
              nextLabel={t("common.next")}
              ariaLabel={t("common.pagination")}
            />
          </Stack>
        ) : null}
      </Stack>
    </Page>
  );
}

function VariantItem({
  row,
  isDemo,
  canEdit,
  result,
}: {
  row: Row;
  isDemo: boolean;
  canEdit: boolean;
  result: ProductActionResult | null;
}) {
  const t = useT();
  const locale = useLocale();
  const e = row.effective;
  const overridden = new Set<string>(row.overriddenFields);
  const missing = (critical?: boolean) =>
    critical ? (
      <Badge tone="critical" size="sm">
        {t("products.missing")}
      </Badge>
    ) : (
      <Text as="span" tone="subdued">
        {t("products.missing")}
      </Text>
    );
  /** Значення + позначка «змінено в застосунку» + значення з Shopify як підказка. */
  const value = (fields: OverrideField[], content: ReactNode, shopifyText: string | null, extra?: ReactNode): ReactNode => {
    const isOverridden = fields.some((f) => overridden.has(f));
    return (
      <Stack as="span" gap={1}>
        <Stack as="span" direction="horizontal" gap={2} align="center">
          {content}
          {isOverridden ? <OverriddenBadge /> : null}
          {extra}
        </Stack>
        {isOverridden ? (
          <Text as="span" variant="caption" tone="subdued">
            {shopifyText
              ? t(isDemo ? "products.demoValue" : "products.shopifyValue", { value: shopifyText })
              : t(isDemo ? "products.demoEmpty" : "products.shopifyEmpty")}
          </Text>
        ) : null}
      </Stack>
    );
  };
  const dims = (v: { lengthMm: number | null; widthMm: number | null; heightMm: number | null }) =>
    v.lengthMm || v.widthMm || v.heightMm
      ? t("products.dimensionsValue", { length: v.lengthMm ?? "—", width: v.widthMm ?? "—", height: v.heightMm ?? "—" })
      : null;
  const hsDigits = e.hsCode?.replace(/\D/g, "").length ?? 0;

  const items: KeyValueItem[] = [
    {
      key: "hs",
      label: t("field.variant.hsCode"),
      value: e.hsCode
        ? value(
            ["hsCode"],
            <InlineCode>{e.hsCode}</InlineCode>,
            row.shopify.hsCode,
            hsDigits < 8 ? (
              <Badge tone="warning" size="sm">
                {t("products.hsShort")}
              </Badge>
            ) : null,
          )
        : missing(true),
    },
    {
      key: "origin",
      label: t("field.variant.countryOfOrigin"),
      value: e.countryOfOrigin
        ? value(
            ["countryOfOrigin"],
            <>
              <InlineCode>{e.countryOfOrigin}</InlineCode>
              {row.originName ? <span>{row.originName}</span> : null}
            </>,
            row.shopify.countryOfOrigin,
          )
        : missing(true),
    },
    {
      key: "description",
      label: t("field.variant.customsDescription"),
      value: e.customsDescription
        ? value(["customsDescription"], <span>{e.customsDescription}</span>, row.shopify.customsDescription)
        : missing(true),
    },
    {
      key: "descriptionLocal",
      label: t("field.variant.customsDescriptionLocal"),
      value: e.customsDescriptionLocal
        ? value(["customsDescriptionLocal"], <span>{e.customsDescriptionLocal}</span>, row.shopify.customsDescriptionLocal)
        : missing(),
    },
    {
      key: "material",
      label: t("field.variant.material"),
      value: e.material ? value(["material"], <span>{e.material}</span>, row.shopify.material) : missing(),
    },
    {
      key: "weight",
      label: t("field.variant.weightGrams"),
      value:
        e.weightGrams !== null
          ? value(
              ["weightGrams"],
              <Text as="span" numeric>
                {formatWeight(e.weightGrams, locale)}
              </Text>,
              row.shopify.weightGrams !== null ? formatWeight(row.shopify.weightGrams, locale) : null,
            )
          : missing(true),
    },
    {
      key: "dimensions",
      label: t("products.dimensions"),
      value: dims(e)
        ? value(
            ["lengthMm", "widthMm", "heightMm"],
            <Text as="span" numeric>
              {dims(e)}
            </Text>,
            dims(row.shopify),
          )
        : missing(),
    },
  ];

  return (
    <Stack gap={3}>
      <Stack direction="horizontal" gap={3} align="start" wrap={false}>
        <Thumbnail src={row.imageUrl} alt="" size="md" />
        <Stack gap={1}>
          <Stack as="span" direction="horizontal" gap={2} align="center">
            <Text as="h3" variant="heading-sm">
              {row.productTitle}
            </Text>
            {row.productStatus === "DELETED" ? (
              <Badge tone="warning" size="sm">
                {t("products.deleted")}
              </Badge>
            ) : null}
          </Stack>
          {row.variantTitle ? (
            <Text variant="body-sm" tone="subdued">
              {row.variantTitle}
            </Text>
          ) : null}
          <Text variant="body-sm">
            {t("products.sku")}: {row.sku ? <InlineCode>{row.sku}</InlineCode> : t("products.missing")}
          </Text>
        </Stack>
      </Stack>
      <KeyValueList items={items} />
      {result ? <ActionBanner data={result} /> : null}
      {canEdit ? (
        <VariantCustomsForm
          variant={{ id: row.id, overrides: row.overrides, shopify: row.shopify }}
          isDemo={isDemo}
          fieldErrors={result && !result.ok ? result.fieldErrors : undefined}
        />
      ) : null}
    </Stack>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

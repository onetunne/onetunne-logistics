/**
 * Список варіантів товарів для сторінки «Товари» (етап 3): пошук, фільтр «бракує митних даних», сторінки.
 * Значення Shopify (колонки product_variants) і перевизначення застосунку (customs_overrides) повертаються окремо,
 * щоб інтерфейс міг показати і ефективне значення, і значення з Shopify.
 */
import { and, asc, count, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { products, productVariants } from "~/db/schema";
import {
  effectiveVariant,
  readOverrides,
  type CustomsOverrides,
  type OverrideField,
  type VariantCustomsFields,
} from "./customs-overrides";

export interface VariantListFilter {
  q?: string | null;
  /** Лише варіанти без HS-коду, країни походження, митного опису (англ.) або ваги (з урахуванням перевизначень). */
  missing?: boolean;
  page?: number;
  pageSize?: number;
}

/** Значення митних полів без перевизначень (з Shopify; у демо — демо-дані товару). */
export type CustomsValues = Omit<VariantCustomsFields, "customsOverrides">;

export interface VariantListRow {
  id: string;
  productTitle: string;
  variantTitle: string;
  sku: string | null;
  imageUrl: string | null;
  productStatus: string | null;
  /** Ефективні значення: перевизначення застосунку → інакше Shopify. */
  effective: CustomsValues;
  /** Значення з Shopify (без перевизначень). */
  shopify: CustomsValues;
  /** Перевизначення застосунку (лише задані поля). */
  overrides: CustomsOverrides;
  overriddenFields: OverrideField[];
}

export const VARIANTS_PAGE_SIZE = 50;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Текстове поле не задане ні в застосунку, ні в Shopify. Ключ — константа коду (не дані користувача). */
function missingText(
  column: typeof productVariants.hsCode | typeof productVariants.countryOfOrigin | typeof productVariants.customsDescription,
  key: OverrideField,
): SQL {
  return sql`((${productVariants.customsOverrides} ->> ${sql.raw(`'${key}'`)}) is null and coalesce(btrim(${column}), '') = '')`;
}

export function missingCustomsCondition(): SQL {
  return or(
    missingText(productVariants.hsCode, "hsCode"),
    missingText(productVariants.countryOfOrigin, "countryOfOrigin"),
    missingText(productVariants.customsDescription, "customsDescription"),
    sql`((${productVariants.customsOverrides} -> 'weightGrams') is null and ${productVariants.weightGrams} is null)`,
  )!;
}

function customsValues(v: VariantCustomsFields): CustomsValues {
  return {
    hsCode: v.hsCode,
    countryOfOrigin: v.countryOfOrigin?.trim().toUpperCase() || null,
    customsDescription: v.customsDescription,
    customsDescriptionLocal: v.customsDescriptionLocal,
    material: v.material,
    weightGrams: v.weightGrams,
    lengthMm: v.lengthMm,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
  };
}

const variantColumns = {
  id: productVariants.id,
  variantTitle: productVariants.title,
  sku: productVariants.sku,
  variantImageUrl: productVariants.imageUrl,
  hsCode: productVariants.hsCode,
  countryOfOrigin: productVariants.countryOfOrigin,
  customsDescription: productVariants.customsDescription,
  customsDescriptionLocal: productVariants.customsDescriptionLocal,
  material: productVariants.material,
  weightGrams: productVariants.weightGrams,
  lengthMm: productVariants.lengthMm,
  widthMm: productVariants.widthMm,
  heightMm: productVariants.heightMm,
  customsOverrides: productVariants.customsOverrides,
};

function toParts(v: VariantCustomsFields) {
  const eff = effectiveVariant(v);
  return {
    effective: customsValues(eff),
    shopify: customsValues(v),
    overrides: readOverrides(v.customsOverrides),
    overriddenFields: eff.overriddenFields,
  };
}

export async function listVariants(
  db: DbOrTx,
  filter: VariantListFilter = {},
): Promise<{ rows: VariantListRow[]; total: number; page: number; pageSize: number; missingTotal: number }> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? VARIANTS_PAGE_SIZE, 1), 100);
  const page = Math.max(filter.page ?? 1, 1);
  const conditions: SQL[] = [];
  const q = filter.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      or(
        ilike(products.title, like),
        ilike(productVariants.title, like),
        ilike(productVariants.sku, like),
        ilike(productVariants.barcode, like),
      )!,
    );
  }
  if (filter.missing) conditions.push(missingCustomsCondition());
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const [rows, [totalRow], [missingRow]] = await Promise.all([
    db
      .select({ ...variantColumns, productTitle: products.title, productImageUrl: products.imageUrl, productStatus: products.status })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(where)
      .orderBy(asc(products.title), asc(productVariants.title), asc(productVariants.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ n: count() })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(where),
    db.select({ n: count() }).from(productVariants).where(missingCustomsCondition()),
  ]);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      productTitle: r.productTitle,
      variantTitle: r.variantTitle,
      sku: r.sku,
      imageUrl: r.variantImageUrl ?? r.productImageUrl ?? null,
      productStatus: r.productStatus,
      ...toParts(r),
    })),
    total: totalRow?.n ?? 0,
    page,
    pageSize,
    missingTotal: missingRow?.n ?? 0,
  };
}

/** Значення Shopify і перевизначення для вказаних варіантів (форма редагування на сторінці замовлення). */
export async function loadVariantCustomsParts(
  db: DbOrTx,
  ids: readonly string[],
): Promise<Map<string, { shopify: CustomsValues; overrides: CustomsOverrides; overriddenFields: OverrideField[] }>> {
  const out = new Map<string, { shopify: CustomsValues; overrides: CustomsOverrides; overriddenFields: OverrideField[] }>();
  if (ids.length === 0) return out;
  const rows = await db.select(variantColumns).from(productVariants).where(inArray(productVariants.id, [...ids]));
  for (const r of rows) {
    const { shopify, overrides, overriddenFields } = toParts(r);
    out.set(r.id, { shopify, overrides, overriddenFields });
  }
  return out;
}

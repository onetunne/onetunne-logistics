/**
 * Шаблони комплектації (kit_templates + рядки + товари/колекції + фільтр моделі/кольору) і розрахунок матеріалів для
 * замовлення (docs/stage5-design.md §5). Правила застосування й об'єднання — kit-resolution.ts (чиста функція).
 *
 * Дозволи: перегляд — warehouse.view; створення/зміна/видалення — warehouse.adjust (типово власник).
 * Цілі шаблону: усі товари / вибрані товари / колекції Shopify (членство — modules/shopify-sync/collections.server.ts;
 * новий товар колекції охоплюється автоматично) + необов'язковий фільтр за моделлю/кольором варіанта.
 *
 * Список товарів і колекцій для форми обмежений (MAX_KIT_*_OPTIONS) і НЕ обрізається мовчки: товари/колекції, уже
 * призначені шаблонам, завжди входять у список (окремим запитом без ліміту), а `truncated` + пошук на сервері
 * (`query`) дають знайти решту. Збереження замінює перелік повністю, тому все призначене мусить потрапити у форму.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  collections,
  kitTemplateCollections,
  kitTemplateLines,
  kitTemplateProducts,
  kitTemplates,
  orderLineItems,
  packagingMaterials,
  productCollections,
  productVariants,
  products,
  type KitAppliesTo,
  type MaterialUnit,
  type PackagingMaterialKind,
} from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { ConflictError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import type { ServiceContext } from "~/server/types";
import type { KitProductSearchFields, KitVariantAttributes } from "./kit-options";
import { computeKitMaterials, type KitMaterialRequirement, type KitTemplateForResolution } from "./kit-resolution";
import { kitTemplateInputSchema, type KitTemplateInput, type ParsedKitTemplateInput } from "./schemas";
import { matchesVersion, touchedAt, versionToken } from "./version";

export type { KitAppliesTo } from "~/db/schema";
export type KitLinePer = "order" | "item";

export interface KitLineView {
  id: string;
  materialId: string;
  materialCode: string;
  materialName: string;
  materialKind: PackagingMaterialKind;
  materialUnit: MaterialUnit;
  materialActive: boolean;
  quantity: number;
  per: KitLinePer;
}

export interface KitProductView {
  id: string;
  title: string;
  imageUrl: string | null;
  status: string | null;
}

export interface KitCollectionView {
  id: string;
  title: string;
  /** Колекцію видалено в Shopify: шаблон на неї більше не діє (видно на сторінці). */
  deleted: boolean;
  /** Товарів у колекції (за синхронізованим членством). */
  productsCount: number;
}

export interface KitTemplateView {
  id: string;
  name: string;
  appliesTo: KitAppliesTo;
  priority: number;
  active: boolean;
  lines: KitLineView[];
  products: KitProductView[];
  collections: KitCollectionView[];
  /** Фільтр варіантів (порожній — без фільтра). */
  models: string[];
  colors: string[];
  /** Мітка версії для оптимістичного блокування форми (version.ts). */
  version: string;
}

/** Кількість товарів (не видалених у Shopify) у кожній колекції. */
async function collectionProductCounts(db: DbOrTx, collectionIds: readonly string[]): Promise<Map<string, number>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await db
    .select({ collectionId: productCollections.collectionId, c: sql<number>`count(*)::int` })
    .from(productCollections)
    .innerJoin(products, eq(products.id, productCollections.productId))
    .where(and(inArray(productCollections.collectionId, [...collectionIds]), or(isNull(products.status), ne(products.status, "DELETED"))))
    .groupBy(productCollections.collectionId);
  return new Map(rows.map((r) => [r.collectionId, Number(r.c)]));
}

/** Усі шаблони (активні спершу, пріоритет ↓, назва ↑) з рядками, товарами й колекціями. */
export async function listKitTemplates(db: DbOrTx, opts: { ids?: string[]; includeInactive?: boolean } = {}): Promise<KitTemplateView[]> {
  if (opts.ids && opts.ids.length === 0) return [];
  const templates = await db
    .select({ t: kitTemplates, version: versionToken(kitTemplates.updatedAt) })
    .from(kitTemplates)
    .where(
      and(
        opts.ids?.length ? inArray(kitTemplates.id, opts.ids) : undefined,
        opts.includeInactive === false ? eq(kitTemplates.active, true) : undefined,
      ),
    )
    .orderBy(desc(kitTemplates.active), desc(kitTemplates.priority), asc(kitTemplates.name), asc(kitTemplates.id));
  if (templates.length === 0) return [];
  const ids = templates.map(({ t }) => t.id);
  const [lines, links, collectionLinks] = await Promise.all([
    db
      .select({ line: kitTemplateLines, material: packagingMaterials })
      .from(kitTemplateLines)
      .innerJoin(packagingMaterials, eq(packagingMaterials.id, kitTemplateLines.materialId))
      .where(inArray(kitTemplateLines.templateId, ids))
      .orderBy(asc(kitTemplateLines.per), asc(packagingMaterials.name), asc(kitTemplateLines.id)),
    db
      .select({ templateId: kitTemplateProducts.templateId, product: products })
      .from(kitTemplateProducts)
      .innerJoin(products, eq(products.id, kitTemplateProducts.productId))
      .where(inArray(kitTemplateProducts.templateId, ids))
      .orderBy(asc(products.title), asc(products.id)),
    db
      .select({ templateId: kitTemplateCollections.templateId, collection: collections })
      .from(kitTemplateCollections)
      .innerJoin(collections, eq(collections.id, kitTemplateCollections.collectionId))
      .where(inArray(kitTemplateCollections.templateId, ids))
      .orderBy(asc(collections.title), asc(collections.id)),
  ]);
  const counts = await collectionProductCounts(db, [...new Set(collectionLinks.map((l) => l.collection.id))]);
  return templates.map(({ t, version }) => ({
    id: t.id,
    name: t.name,
    appliesTo: t.appliesTo,
    priority: t.priority,
    active: t.active,
    version,
    models: [...t.variantModels],
    colors: [...t.variantColors],
    lines: lines
      .filter((l) => l.line.templateId === t.id)
      .map(({ line, material }) => ({
        id: line.id,
        materialId: material.id,
        materialCode: material.code,
        materialName: material.name,
        materialKind: material.kind,
        materialUnit: material.unit,
        materialActive: material.active,
        quantity: line.quantity,
        per: line.per,
      })),
    products: links
      .filter((l) => l.templateId === t.id)
      .map(({ product }) => ({ id: product.id, title: product.title, imageUrl: product.imageUrl, status: product.status })),
    collections: collectionLinks
      .filter((l) => l.templateId === t.id)
      .map(({ collection }) => ({
        id: collection.id,
        title: collection.title,
        deleted: collection.deletedAt !== null,
        productsCount: counts.get(collection.id) ?? 0,
      })),
  }));
}

export async function getKitTemplate(db: DbOrTx, id: string): Promise<KitTemplateView> {
  const [row] = await listKitTemplates(db, { ids: [id] });
  if (!row) throw new NotFoundError("kitTemplate");
  return row;
}

// ---------------------------------------------------------------------------
// Варіанти вибору для форми
// ---------------------------------------------------------------------------

export interface KitProductOption extends KitProductSearchFields {
  id: string;
  title: string;
  imageUrl: string | null;
  status: string | null;
  models: string[];
  colors: string[];
  skus: string[];
  /** Для фільтра форми (kit-options.ts): ті самі поля, що й серверний пошук у каталозі. */
  handle: string | null;
  barcodes: string[];
  variantTitles: string[];
}

export interface KitOptionsPage<T> {
  options: T[];
  /** Скільки варіантів відповідає умовам (без урахування ліміту; призначені поза умовами не рахуються). */
  total: number;
  /** Показано не всі (total > limit): решту можна знайти пошуком. */
  truncated: boolean;
  limit: number;
}

export const MAX_KIT_PRODUCT_OPTIONS = 2000;
export const MAX_KIT_COLLECTION_OPTIONS = 500;
export const MAX_KIT_OPTION_QUERY_LENGTH = 100;

const likePattern = (search: string) =>
  `%${search
    .trim()
    .slice(0, MAX_KIT_OPTION_QUERY_LENGTH)
    .replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const ACTIVE_PRODUCT_STATUSES = ["ACTIVE", "active", "DRAFT", "draft"];

const sortedValues = (s: Set<string> | undefined) => [...(s ?? [])].sort((a, b) => a.localeCompare(b));

/**
 * Товари для вибору у формі шаблону: активні/чернетки (за пошуком `query` — назва, handle, SKU, штрихкод, модель,
 * колір) з моделями, кольорами й SKU варіантів, до `limit`. Призначені шаблонам (`includeIds`) — ЗАВЖДИ, окремим
 * запитом без ліміту й незалежно від статусу та пошуку (інакше збереження форми мовчки прибрало б їх із шаблону).
 */
export async function listKitProductOptions(
  db: DbOrTx,
  opts: { includeIds?: readonly string[]; query?: string; limit?: number } = {},
): Promise<KitOptionsPage<KitProductOption>> {
  const include = [...new Set(opts.includeIds ?? [])];
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_KIT_PRODUCT_OPTIONS, MAX_KIT_PRODUCT_OPTIONS));
  const q = opts.query?.trim() ? likePattern(opts.query) : null;
  const where: SQL | undefined = and(
    or(sql`${products.status} is null`, inArray(products.status, ACTIVE_PRODUCT_STATUSES)),
    q
      ? or(
          sql`${products.title} ilike ${q}`,
          sql`${products.handle} ilike ${q}`,
          sql`exists (select 1 from ${productVariants} pv where pv.product_id = ${products.id}
            and (pv.sku ilike ${q} or pv.barcode ilike ${q} or pv.model ilike ${q} or pv.color ilike ${q} or pv.title ilike ${q}))`,
        )
      : undefined,
  );
  const [matching, [totalRow], assigned] = await Promise.all([
    db.select({ product: products }).from(products).where(where).orderBy(asc(products.title), asc(products.id)).limit(limit),
    db.select({ c: sql<number>`count(*)::int` }).from(products).where(where),
    include.length ? db.select({ product: products }).from(products).where(inArray(products.id, include)) : Promise.resolve([]),
  ]);
  const byId = new Map<string, typeof products.$inferSelect>();
  for (const r of [...matching, ...assigned]) byId.set(r.product.id, r.product);
  const rows = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = rows.map((r) => r.id);
  const variants = ids.length
    ? await db
        .select({
          productId: productVariants.productId,
          model: productVariants.model,
          color: productVariants.color,
          sku: productVariants.sku,
          barcode: productVariants.barcode,
          title: productVariants.title,
        })
        .from(productVariants)
        .where(inArray(productVariants.productId, ids))
    : [];
  type Acc = { models: Set<string>; colors: Set<string>; skus: Set<string>; barcodes: Set<string>; titles: Set<string> };
  const by = new Map<string, Acc>();
  for (const v of variants) {
    const e: Acc = by.get(v.productId) ?? { models: new Set(), colors: new Set(), skus: new Set(), barcodes: new Set(), titles: new Set() };
    if (v.model) e.models.add(v.model);
    if (v.color) e.colors.add(v.color);
    if (v.sku) e.skus.add(v.sku);
    if (v.barcode) e.barcodes.add(v.barcode);
    if (v.title) e.titles.add(v.title);
    by.set(v.productId, e);
  }
  const total = Number(totalRow?.c ?? 0);
  return {
    options: rows.map((product) => ({
      id: product.id,
      title: product.title,
      imageUrl: product.imageUrl,
      status: product.status,
      models: sortedValues(by.get(product.id)?.models),
      colors: sortedValues(by.get(product.id)?.colors),
      skus: sortedValues(by.get(product.id)?.skus),
      handle: product.handle,
      barcodes: sortedValues(by.get(product.id)?.barcodes),
      variantTitles: sortedValues(by.get(product.id)?.titles),
    })),
    total,
    truncated: total > limit,
    limit,
  };
}

export interface KitCollectionOption extends KitCollectionView {
  handle: string | null;
}

/**
 * Колекції для вибору у формі (не видалені; за пошуком — назва або handle), до `limit`. Призначені шаблонам — завжди
 * (зокрема видалені в Shopify, щоб власник бачив і міг прибрати їх).
 */
export async function listKitCollectionOptions(
  db: DbOrTx,
  opts: { includeIds?: readonly string[]; query?: string; limit?: number } = {},
): Promise<KitOptionsPage<KitCollectionOption>> {
  const include = [...new Set(opts.includeIds ?? [])];
  const limit = Math.max(1, Math.min(opts.limit ?? MAX_KIT_COLLECTION_OPTIONS, MAX_KIT_COLLECTION_OPTIONS));
  const q = opts.query?.trim() ? likePattern(opts.query) : null;
  const where = and(isNull(collections.deletedAt), q ? or(sql`${collections.title} ilike ${q}`, sql`${collections.handle} ilike ${q}`) : undefined);
  const [matching, [totalRow], assigned] = await Promise.all([
    db.select().from(collections).where(where).orderBy(asc(collections.title), asc(collections.id)).limit(limit),
    db.select({ c: sql<number>`count(*)::int` }).from(collections).where(where),
    include.length ? db.select().from(collections).where(inArray(collections.id, include)) : Promise.resolve([]),
  ]);
  const byId = new Map<string, typeof collections.$inferSelect>();
  for (const r of [...matching, ...assigned]) byId.set(r.id, r);
  const rows = [...byId.values()].sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const counts = await collectionProductCounts(db, rows.map((r) => r.id));
  const total = Number(totalRow?.c ?? 0);
  return {
    options: rows.map((c) => ({ id: c.id, title: c.title, handle: c.handle, deleted: c.deletedAt !== null, productsCount: counts.get(c.id) ?? 0 })),
    total,
    truncated: total > limit,
    limit,
  };
}

export const MAX_KIT_ATTRIBUTE_OPTIONS = 500;

/**
 * Наявний варіант каталогу: товар не видалено в Shopify і варіант не зник із переліку варіантів товару
 * (product_variants.removed_at, як catalogVariantLive у packing.server.ts). Фільтр списку шаблонів за моделлю/кольором
 * і варіанти полів «Модель»/«Колір» беруть лише такі варіанти: інакше шаблон «підходив» би кольору, який мають лише
 * видалені варіанти цілі (R6F-4).
 */
const liveCatalogVariant = () => and(or(isNull(products.status), ne(products.status, "DELETED")), isNull(productVariants.removedAt));

/** Моделі й кольори наявних варіантів каталогу (без видалених товарів і варіантів) — для фільтра шаблону. */
export async function listKitVariantAttributes(db: DbOrTx): Promise<{ models: string[]; colors: string[] }> {
  const live = liveCatalogVariant();
  const [models, colors] = await Promise.all([
    db
      .selectDistinct({ v: productVariants.model })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(isNotNull(productVariants.model), live))
      .orderBy(asc(productVariants.model))
      .limit(MAX_KIT_ATTRIBUTE_OPTIONS),
    db
      .selectDistinct({ v: productVariants.color })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(isNotNull(productVariants.color), live))
      .orderBy(asc(productVariants.color))
      .limit(MAX_KIT_ATTRIBUTE_OPTIONS),
  ]);
  const clean = (rows: Array<{ v: string | null }>) =>
    [...new Set(rows.map((r) => r.v?.trim() ?? "").filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return { models: clean(models), colors: clean(colors) };
}

/** Модель і колір кожного наявного варіанта товарів (для фільтра списку шаблонів за моделлю/кольором). */
export async function productVariantAttributes(db: DbOrTx, productIds: readonly string[]): Promise<Map<string, KitVariantAttributes[]>> {
  if (productIds.length === 0) return new Map();
  const rows = await db
    .selectDistinct({ productId: productVariants.productId, model: productVariants.model, color: productVariants.color })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(inArray(productVariants.productId, [...new Set(productIds)]), liveCatalogVariant()));
  const out = new Map<string, KitVariantAttributes[]>();
  for (const r of rows) out.set(r.productId, [...(out.get(r.productId) ?? []), { model: r.model, color: r.color }]);
  return out;
}

/** Модель і колір наявних варіантів товарів кожної колекції (для фільтра списку шаблонів за моделлю/кольором). */
export async function collectionVariantAttributes(db: DbOrTx, collectionIds: readonly string[]): Promise<Map<string, KitVariantAttributes[]>> {
  if (collectionIds.length === 0) return new Map();
  const rows = await db
    .selectDistinct({ collectionId: productCollections.collectionId, model: productVariants.model, color: productVariants.color })
    .from(productCollections)
    .innerJoin(productVariants, eq(productVariants.productId, productCollections.productId))
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(and(inArray(productCollections.collectionId, [...new Set(collectionIds)]), liveCatalogVariant()));
  const out = new Map<string, KitVariantAttributes[]>();
  for (const r of rows) out.set(r.collectionId, [...(out.get(r.collectionId) ?? []), { model: r.model, color: r.color }]);
  return out;
}

// ---------------------------------------------------------------------------
// Зміни
// ---------------------------------------------------------------------------

async function writeChildren(tx: DbOrTx, templateId: string, parsed: ParsedKitTemplateInput) {
  const materialIds = [...new Set(parsed.lines.map((l) => l.materialId))];
  const found = await tx.select({ id: packagingMaterials.id }).from(packagingMaterials).where(inArray(packagingMaterials.id, materialIds));
  if (found.length !== materialIds.length) throw new NotFoundError("material");
  const productIds = parsed.appliesTo === "products" ? [...new Set(parsed.productIds)] : [];
  if (productIds.length) {
    const p = await tx.select({ id: products.id }).from(products).where(inArray(products.id, productIds));
    if (p.length !== productIds.length) throw new NotFoundError("product");
  }
  const collectionIds = parsed.appliesTo === "collections" ? [...new Set(parsed.collectionIds)] : [];
  if (collectionIds.length) {
    const c = await tx.select({ id: collections.id }).from(collections).where(inArray(collections.id, collectionIds));
    if (c.length !== collectionIds.length) throw new NotFoundError("collection");
  }
  await tx.delete(kitTemplateLines).where(eq(kitTemplateLines.templateId, templateId));
  await tx.delete(kitTemplateProducts).where(eq(kitTemplateProducts.templateId, templateId));
  await tx.delete(kitTemplateCollections).where(eq(kitTemplateCollections.templateId, templateId));
  await tx.insert(kitTemplateLines).values(parsed.lines.map((l) => ({ templateId, materialId: l.materialId, quantity: l.quantity, per: l.per })));
  if (productIds.length) await tx.insert(kitTemplateProducts).values(productIds.map((productId) => ({ templateId, productId })));
  if (collectionIds.length) await tx.insert(kitTemplateCollections).values(collectionIds.map((collectionId) => ({ templateId, collectionId })));
  return { lines: parsed.lines.length, products: productIds.length, collections: collectionIds.length, models: parsed.models.length, colors: parsed.colors.length };
}

const templateColumns = (parsed: ParsedKitTemplateInput) => ({
  name: parsed.name,
  appliesTo: parsed.appliesTo,
  priority: parsed.priority,
  active: parsed.active,
  variantModels: parsed.models,
  variantColors: parsed.colors,
});

/** Новий шаблон (warehouse.adjust). */
export async function createKitTemplate(ctx: ServiceContext, input: KitTemplateInput): Promise<{ id: string }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const parsed = kitTemplateInputSchema.parse(input);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.insert(kitTemplates).values(templateColumns(parsed)).returning({ id: kitTemplates.id });
    const counts = await writeChildren(tx, row!.id, parsed);
    await writeAudit(tx, ctx.actor, "packaging.kit.created", { type: "kit_template", id: row!.id }, { appliesTo: parsed.appliesTo, ...counts });
    return { id: row!.id };
  });
}

/** Зміна шаблону: рядки, товари й колекції замінюються повністю (warehouse.adjust). expectedVersion — мітка з форми. */
export async function updateKitTemplate(
  ctx: ServiceContext,
  id: string,
  input: KitTemplateInput,
  opts: { expectedVersion?: string | null } = {},
): Promise<void> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const parsed = kitTemplateInputSchema.parse(input);
  await ctx.db.transaction(async (tx) => {
    const updated = await tx
      .update(kitTemplates)
      .set({ ...templateColumns(parsed), updatedAt: touchedAt() })
      .where(and(eq(kitTemplates.id, id), opts.expectedVersion ? matchesVersion(kitTemplates.updatedAt, opts.expectedVersion) : undefined))
      .returning({ id: kitTemplates.id });
    if (updated.length === 0) {
      const [exists] = await tx.select({ id: kitTemplates.id }).from(kitTemplates).where(eq(kitTemplates.id, id));
      if (!exists) throw new NotFoundError("kitTemplate");
      throw new ConflictError();
    }
    const counts = await writeChildren(tx, id, parsed);
    await writeAudit(tx, ctx.actor, "packaging.kit.updated", { type: "kit_template", id }, { appliesTo: parsed.appliesTo, active: parsed.active, ...counts });
  });
}

/** Масово ввімкнути/вимкнути шаблони (warehouse.adjust). */
export async function setKitTemplatesActive(ctx: ServiceContext, ids: readonly string[], active: boolean): Promise<{ updated: number }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { updated: 0 };
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .update(kitTemplates)
      .set({ active, updatedAt: touchedAt() })
      .where(and(inArray(kitTemplates.id, unique), eq(kitTemplates.active, !active)))
      .returning({ id: kitTemplates.id });
    if (rows.length) {
      await writeAudit(tx, ctx.actor, active ? "packaging.kit.activated" : "packaging.kit.deactivated", { type: "kit_template" }, { ids: rows.map((r) => r.id) });
    }
    return { updated: rows.length };
  });
}

/**
 * Видалення шаблону (warehouse.adjust). Історія витрат не втрачається: рухи матеріалів посилаються на пакування,
 * а не на шаблон.
 */
export async function deleteKitTemplate(ctx: ServiceContext, id: string): Promise<void> {
  requirePermission(ctx.actor, "warehouse.adjust");
  await ctx.db.transaction(async (tx) => {
    const rows = await tx.delete(kitTemplates).where(eq(kitTemplates.id, id)).returning({ id: kitTemplates.id, name: kitTemplates.name });
    if (rows.length === 0) throw new NotFoundError("kitTemplate");
    await writeAudit(tx, ctx.actor, "packaging.kit.deleted", { type: "kit_template", id });
  });
}

// ---------------------------------------------------------------------------
// Розрахунок для замовлення
// ---------------------------------------------------------------------------

export interface KitMaterialNeed extends KitMaterialRequirement {
  code: string;
  name: string;
  kind: PackagingMaterialKind;
  unit: MaterialUnit;
}

/** Активні шаблони з рядками (лише активні матеріали), товарами, колекціями й фільтрами — для computeKitMaterials. */
export async function loadActiveKitTemplates(db: DbOrTx): Promise<KitTemplateForResolution[]> {
  const templates = await db.select().from(kitTemplates).where(eq(kitTemplates.active, true));
  if (templates.length === 0) return [];
  const ids = templates.map((t) => t.id);
  const [lines, links, collectionLinks] = await Promise.all([
    db
      .select({ line: kitTemplateLines, active: packagingMaterials.active })
      .from(kitTemplateLines)
      .innerJoin(packagingMaterials, eq(packagingMaterials.id, kitTemplateLines.materialId))
      .where(inArray(kitTemplateLines.templateId, ids)),
    db.select().from(kitTemplateProducts).where(inArray(kitTemplateProducts.templateId, ids)),
    db.select().from(kitTemplateCollections).where(inArray(kitTemplateCollections.templateId, ids)),
  ]);
  return templates.map((t) => ({
    id: t.id,
    appliesTo: t.appliesTo,
    priority: t.priority,
    active: t.active,
    productIds: links.filter((l) => l.templateId === t.id).map((l) => l.productId),
    collectionIds: collectionLinks.filter((l) => l.templateId === t.id).map((l) => l.collectionId),
    models: t.variantModels,
    colors: t.variantColors,
    lines: lines
      .filter((l) => l.line.templateId === t.id)
      .map((l) => ({ materialId: l.line.materialId, quantity: l.line.quantity, per: l.line.per, materialActive: l.active })),
  }));
}

/** Позиції замовлення для розрахунку: товар, модель/колір варіанта, колекції товару (без видалених). */
async function loadKitOrderLines(db: DbOrTx, orderId: string) {
  const lines = await db
    .select({
      productId: productVariants.productId,
      model: productVariants.model,
      color: productVariants.color,
      quantity: orderLineItems.quantity,
      currentQuantity: orderLineItems.currentQuantity,
    })
    .from(orderLineItems)
    .innerJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
    .where(and(eq(orderLineItems.orderId, orderId), isNotNull(orderLineItems.variantId)));
  const productIds = [...new Set(lines.map((l) => l.productId))];
  const memberships = productIds.length
    ? await db
        .select({ productId: productCollections.productId, collectionId: productCollections.collectionId })
        .from(productCollections)
        .innerJoin(collections, eq(collections.id, productCollections.collectionId))
        .where(and(inArray(productCollections.productId, productIds), isNull(collections.deletedAt)))
    : [];
  const byProduct = new Map<string, string[]>();
  for (const m of memberships) byProduct.set(m.productId, [...(byProduct.get(m.productId) ?? []), m.collectionId]);
  return lines.map((l) => ({ ...l, collectionIds: byProduct.get(l.productId) ?? [] }));
}

/**
 * Матеріали комплектації замовлення: усі активні шаблони, що підходять (правила — kit-resolution.ts), об'єднано за
 * матеріалом. Кількість одиниць — effectiveLineQuantity (без повернених/видалених). Порожній масив — нічого не потрібно.
 */
export async function resolveKitMaterials(db: DbOrTx, orderId: string): Promise<KitMaterialNeed[]> {
  const lines = await loadKitOrderLines(db, orderId);
  if (lines.length === 0) return [];
  const requirements = computeKitMaterials(await loadActiveKitTemplates(db), lines);
  if (requirements.length === 0) return [];
  const materials = await db
    .select()
    .from(packagingMaterials)
    .where(inArray(packagingMaterials.id, requirements.map((r) => r.materialId)));
  const byId = new Map(materials.map((m) => [m.id, m]));
  return requirements.flatMap((r) => {
    const m = byId.get(r.materialId);
    return m ? [{ ...r, code: m.code, name: m.name, kind: m.kind, unit: m.unit }] : [];
  });
}

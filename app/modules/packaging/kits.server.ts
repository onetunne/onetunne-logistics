/**
 * Шаблони комплектації (kit_templates + рядки + товари) і розрахунок матеріалів для замовлення
 * (docs/stage5-design.md §5). Правила об'єднання — kit-resolution.ts (чиста функція).
 *
 * Дозволи: перегляд — warehouse.view; створення/зміна/видалення — warehouse.adjust (типово власник).
 * «Колекція/група» товарів — перелік товарів шаблону (kit_template_products); у формі — пошук і фільтр за моделлю/кольором.
 */
import { and, asc, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  kitTemplateLines,
  kitTemplateProducts,
  kitTemplates,
  orderLineItems,
  packagingMaterials,
  productVariants,
  products,
  type MaterialUnit,
  type PackagingMaterialKind,
} from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { ConflictError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import type { ServiceContext } from "~/server/types";
import { computeKitMaterials, type KitMaterialRequirement, type KitTemplateForResolution } from "./kit-resolution";
import { kitTemplateInputSchema, type KitTemplateInput, type ParsedKitTemplateInput } from "./schemas";
import { matchesVersion, touchedAt, versionToken } from "./version";

export type KitAppliesTo = "all" | "products";
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

export interface KitTemplateView {
  id: string;
  name: string;
  appliesTo: KitAppliesTo;
  priority: number;
  active: boolean;
  lines: KitLineView[];
  products: KitProductView[];
  /** Мітка версії для оптимістичного блокування форми (version.ts). */
  version: string;
}

/** Усі шаблони (активні спершу, пріоритет ↓, назва ↑) з рядками й товарами. */
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
  const [lines, links] = await Promise.all([
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
  ]);
  return templates.map(({ t, version }) => ({
    id: t.id,
    name: t.name,
    appliesTo: t.appliesTo,
    priority: t.priority,
    active: t.active,
    version,
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
  }));
}

export async function getKitTemplate(db: DbOrTx, id: string): Promise<KitTemplateView> {
  const [row] = await listKitTemplates(db, { ids: [id] });
  if (!row) throw new NotFoundError("kitTemplate");
  return row;
}

export interface KitProductOption {
  id: string;
  title: string;
  imageUrl: string | null;
  status: string | null;
  models: string[];
  colors: string[];
  skus: string[];
}

export const MAX_KIT_PRODUCT_OPTIONS = 2000;

/**
 * Товари для вибору у формі шаблону: активні/чернетки (або всі, якщо includeIds містить архівні) з моделями,
 * кольорами й SKU варіантів — для пошуку й фільтрів на клієнті. Зображення — збережені URL Shopify.
 */
export async function listKitProductOptions(db: DbOrTx, opts: { includeIds?: readonly string[] } = {}): Promise<KitProductOption[]> {
  const include = [...new Set(opts.includeIds ?? [])];
  const rows = await db
    .select({ product: products })
    .from(products)
    .where(
      or(
        sql`${products.status} is null`,
        inArray(products.status, ["ACTIVE", "active", "DRAFT", "draft"]),
        include.length ? inArray(products.id, include) : undefined,
      ),
    )
    .orderBy(asc(products.title), asc(products.id))
    .limit(MAX_KIT_PRODUCT_OPTIONS);
  const ids = rows.map((r) => r.product.id);
  const variants = ids.length
    ? await db
        .select({ productId: productVariants.productId, model: productVariants.model, color: productVariants.color, sku: productVariants.sku })
        .from(productVariants)
        .where(inArray(productVariants.productId, ids))
    : [];
  const by = new Map<string, { models: Set<string>; colors: Set<string>; skus: Set<string> }>();
  for (const v of variants) {
    const e = by.get(v.productId) ?? { models: new Set(), colors: new Set(), skus: new Set() };
    if (v.model) e.models.add(v.model);
    if (v.color) e.colors.add(v.color);
    if (v.sku) e.skus.add(v.sku);
    by.set(v.productId, e);
  }
  const sorted = (s: Set<string> | undefined) => [...(s ?? [])].sort((a, b) => a.localeCompare(b));
  return rows.map(({ product }) => ({
    id: product.id,
    title: product.title,
    imageUrl: product.imageUrl,
    status: product.status,
    models: sorted(by.get(product.id)?.models),
    colors: sorted(by.get(product.id)?.colors),
    skus: sorted(by.get(product.id)?.skus),
  }));
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
  await tx.delete(kitTemplateLines).where(eq(kitTemplateLines.templateId, templateId));
  await tx.delete(kitTemplateProducts).where(eq(kitTemplateProducts.templateId, templateId));
  await tx.insert(kitTemplateLines).values(parsed.lines.map((l) => ({ templateId, materialId: l.materialId, quantity: l.quantity, per: l.per })));
  if (productIds.length) await tx.insert(kitTemplateProducts).values(productIds.map((productId) => ({ templateId, productId })));
  return { lines: parsed.lines.length, products: productIds.length };
}

/** Новий шаблон (warehouse.adjust). */
export async function createKitTemplate(ctx: ServiceContext, input: KitTemplateInput): Promise<{ id: string }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const parsed = kitTemplateInputSchema.parse(input);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(kitTemplates)
      .values({ name: parsed.name, appliesTo: parsed.appliesTo, priority: parsed.priority, active: parsed.active })
      .returning({ id: kitTemplates.id });
    const counts = await writeChildren(tx, row!.id, parsed);
    await writeAudit(tx, ctx.actor, "packaging.kit.created", { type: "kit_template", id: row!.id }, { appliesTo: parsed.appliesTo, ...counts });
    return { id: row!.id };
  });
}

/** Зміна шаблону: рядки й товари замінюються повністю (warehouse.adjust). expectedVersion — мітка з форми. */
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
      .set({ name: parsed.name, appliesTo: parsed.appliesTo, priority: parsed.priority, active: parsed.active, updatedAt: touchedAt() })
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

/** Активні шаблони з рядками (лише активні матеріали) і товарами — у вигляді для computeKitMaterials. */
export async function loadActiveKitTemplates(db: DbOrTx): Promise<KitTemplateForResolution[]> {
  const templates = await db.select().from(kitTemplates).where(eq(kitTemplates.active, true));
  if (templates.length === 0) return [];
  const ids = templates.map((t) => t.id);
  const [lines, links] = await Promise.all([
    db
      .select({ line: kitTemplateLines, active: packagingMaterials.active })
      .from(kitTemplateLines)
      .innerJoin(packagingMaterials, eq(packagingMaterials.id, kitTemplateLines.materialId))
      .where(inArray(kitTemplateLines.templateId, ids)),
    db.select().from(kitTemplateProducts).where(inArray(kitTemplateProducts.templateId, ids)),
  ]);
  return templates.map((t) => ({
    id: t.id,
    appliesTo: t.appliesTo,
    priority: t.priority,
    active: t.active,
    productIds: links.filter((l) => l.templateId === t.id).map((l) => l.productId),
    lines: lines
      .filter((l) => l.line.templateId === t.id)
      .map((l) => ({ materialId: l.line.materialId, quantity: l.line.quantity, per: l.line.per, materialActive: l.active })),
  }));
}

/**
 * Матеріали комплектації замовлення: усі активні шаблони, що підходять (правила — kit-resolution.ts), об'єднано за
 * матеріалом. Кількість одиниць — effectiveLineQuantity (без повернених/видалених). Порожній масив — нічого не потрібно.
 */
export async function resolveKitMaterials(db: DbOrTx, orderId: string): Promise<KitMaterialNeed[]> {
  const lines = await db
    .select({ productId: productVariants.productId, quantity: orderLineItems.quantity, currentQuantity: orderLineItems.currentQuantity })
    .from(orderLineItems)
    .innerJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
    .where(and(eq(orderLineItems.orderId, orderId), isNotNull(orderLineItems.variantId)));
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

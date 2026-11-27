/**
 * Комплектація замовлення пакувальними матеріалами (чиста функція, без БД) — docs/stage5-design.md §5.
 *
 * Які одиниці товару «стосуються» шаблону (обидві умови разом):
 * 1. Ціль (appliesTo):
 *    - "all" — усі товари замовлення;
 *    - "products" — товари з переліку шаблону (productIds);
 *    - "collections" — товари, що входять хоча б в одну колекцію шаблону (collectionIds; членство — з Shopify,
 *      тож новий товар колекції охоплюється автоматично, після синхронізації). Товар у кількох колекціях шаблону
 *      рахується один раз.
 * 2. Фільтр варіанта (необов'язковий, для будь-якої цілі): models / colors не порожні → лише одиниці варіантів, у яких
 *    модель (колір) є в списку. Обидва списки — одночасно (І). Порівняння — без зайвих пробілів і без регістру.
 *    Варіант без моделі (кольору) під фільтр за моделлю (кольором) не підпадає.
 *
 * Правила об'єднання («пріоритет вирішення»):
 * - Застосовуються ВСІ активні шаблони, що підходять замовленню (хоча б одна одиниця стосується шаблону); шаблон не
 *   скасовує й не замінює інший, навіть специфічніший (для різних матеріалів за моделлю/кольором — окремі шаблони з
 *   фільтрами). Пріоритет визначає лише порядок показу пакувальнику.
 * - Рядок per = "order" — quantity один раз на замовлення; per = "item" — quantity × кількість одиниць, що стосуються
 *   шаблону (з урахуванням цілі й фільтра).
 * - Кількість одиниць — effectiveLineQuantity (Shopify currentQuantity: без повернених/видалених одиниць).
 *   Позиції без варіанта товару (довільні позиції Shopify: послуги, чайові) не рахуються — це не фізичні товари.
 * - Однакові матеріали з різних шаблонів/рядків підсумовуються; templateIds — шаблони, що дали матеріал.
 * - Неактивні матеріали пропускаються (власник вивів їх з ужитку).
 * - Порядок результату детермінований: найвищий пріоритет шаблону, що дав матеріал ↓, потім materialId ↑;
 *   templateIds — за пріоритетом ↓, потім id ↑.
 */
import { effectiveLineQuantity } from "~/modules/inventory/quantities";

export type KitTemplateScope = "all" | "products" | "collections";

export interface KitTemplateForResolution {
  id: string;
  appliesTo: KitTemplateScope;
  priority: number;
  active: boolean;
  productIds: readonly string[];
  /** Колекції шаблону (для appliesTo = "collections"). */
  collectionIds?: readonly string[];
  /** Фільтр варіантів за моделлю (порожній / відсутній — без фільтра). */
  models?: readonly string[];
  /** Фільтр варіантів за кольором (порожній / відсутній — без фільтра). */
  colors?: readonly string[];
  lines: ReadonlyArray<{ materialId: string; quantity: number; per: "order" | "item"; materialActive?: boolean }>;
}

export interface KitOrderLine {
  productId: string | null;
  quantity: number;
  currentQuantity?: number | null;
  /** Колекції товару позиції (product_collections, без видалених колекцій). */
  collectionIds?: readonly string[];
  /** Атрибути варіанта позиції (product_variants.model / color). */
  model?: string | null;
  color?: string | null;
}

export interface KitMaterialRequirement {
  materialId: string;
  quantity: number;
  /** Шаблони, що дали цей матеріал (пріоритет ↓, id ↑). */
  templateIds: string[];
}

/** Нормалізоване значення атрибута для порівняння (той самий вигляд у формі й у розрахунку). */
export function normalizeVariantValue(value: string | null | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase("uk");
}

export interface PreparedKitLine {
  productId: string;
  units: number;
  collectionIds: ReadonlySet<string>;
  model: string;
  color: string;
}

function scopeMatches(template: KitTemplateForResolution, line: PreparedKitLine, productIds: ReadonlySet<string>, collectionIds: ReadonlySet<string>): boolean {
  switch (template.appliesTo) {
    case "all":
      return true;
    case "products":
      return productIds.has(line.productId);
    case "collections":
      for (const c of line.collectionIds) if (collectionIds.has(c)) return true;
      return false;
  }
}

/** Одиниці замовлення, що стосуються шаблону (ціль + фільтр варіанта). */
export function templateUnits(template: KitTemplateForResolution, lines: readonly PreparedKitLine[]): number {
  const productIds = new Set(template.productIds);
  const collectionIds = new Set(template.collectionIds ?? []);
  const models = new Set((template.models ?? []).map(normalizeVariantValue).filter(Boolean));
  const colors = new Set((template.colors ?? []).map(normalizeVariantValue).filter(Boolean));
  let units = 0;
  for (const line of lines) {
    if (!scopeMatches(template, line, productIds, collectionIds)) continue;
    if (models.size > 0 && !models.has(line.model)) continue;
    if (colors.size > 0 && !colors.has(line.color)) continue;
    units += line.units;
  }
  return units;
}

export function prepareKitLines(orderLines: readonly KitOrderLine[]): PreparedKitLine[] {
  const out: PreparedKitLine[] = [];
  for (const line of orderLines) {
    if (!line.productId) continue;
    const units = effectiveLineQuantity(line);
    if (units <= 0) continue;
    out.push({
      productId: line.productId,
      units,
      collectionIds: new Set(line.collectionIds ?? []),
      model: normalizeVariantValue(line.model),
      color: normalizeVariantValue(line.color),
    });
  }
  return out;
}

export function computeKitMaterials(
  templates: readonly KitTemplateForResolution[],
  orderLines: readonly KitOrderLine[],
): KitMaterialRequirement[] {
  const lines = prepareKitLines(orderLines);
  if (lines.length === 0) return [];

  const ordered = templates
    .filter((t) => t.active)
    .slice()
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const acc = new Map<string, { quantity: number; templateIds: string[]; topPriority: number }>();
  for (const template of ordered) {
    const units = templateUnits(template, lines);
    if (units === 0) continue;
    for (const line of template.lines) {
      if (line.materialActive === false) continue;
      if (!Number.isSafeInteger(line.quantity) || line.quantity <= 0) continue;
      const quantity = line.per === "order" ? line.quantity : line.quantity * units;
      if (quantity <= 0) continue;
      const entry = acc.get(line.materialId) ?? { quantity: 0, templateIds: [], topPriority: template.priority };
      entry.quantity += quantity;
      if (!entry.templateIds.includes(template.id)) entry.templateIds.push(template.id);
      acc.set(line.materialId, entry);
    }
  }
  return [...acc.entries()]
    .sort(([ma, a], [mb, b]) => (a.topPriority !== b.topPriority ? b.topPriority - a.topPriority : ma < mb ? -1 : ma > mb ? 1 : 0))
    .map(([materialId, e]) => ({ materialId, quantity: e.quantity, templateIds: e.templateIds }));
}

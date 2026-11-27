/**
 * Комплектація замовлення пакувальними матеріалами (чиста функція, без БД) — docs/stage5-design.md §5.
 *
 * Правила:
 * - Застосовуються ВСІ активні шаблони, що підходять замовленню (не «перший за пріоритетом»):
 *   appliesTo = "all" — кожне замовлення з товарами; appliesTo = "products" — замовлення, у якому є хоча б одна одиниця
 *   товару з переліку шаблону («колекція/група» товарів).
 * - Рядок per = "order" — quantity один раз на замовлення; per = "item" — quantity × кількість одиниць товарів, яких
 *   стосується шаблон: для "all" — усіх товарів замовлення, для "products" — лише товарів із переліку шаблону.
 * - Кількість одиниць — effectiveLineQuantity (Shopify currentQuantity: без повернених/видалених одиниць).
 *   Позиції без варіанта товару (довільні позиції Shopify: послуги, чайові) не рахуються — це не фізичні товари.
 * - Однакові матеріали з різних шаблонів/рядків підсумовуються; templateIds — шаблони, що дали матеріал.
 * - Неактивні матеріали пропускаються (власник вивів їх з ужитку).
 * - Порядок результату детермінований: найвищий пріоритет шаблону, що дав матеріал ↓, потім materialId ↑;
 *   templateIds — за пріоритетом ↓, потім id ↑ (пріоритет визначає порядок показу пакувальнику).
 */
import { effectiveLineQuantity } from "~/modules/inventory/quantities";

export interface KitTemplateForResolution {
  id: string;
  appliesTo: "all" | "products";
  priority: number;
  active: boolean;
  productIds: readonly string[];
  lines: ReadonlyArray<{ materialId: string; quantity: number; per: "order" | "item"; materialActive?: boolean }>;
}

export interface KitOrderLine {
  productId: string | null;
  quantity: number;
  currentQuantity?: number | null;
}

export interface KitMaterialRequirement {
  materialId: string;
  quantity: number;
  /** Шаблони, що дали цей матеріал (пріоритет ↓, id ↑). */
  templateIds: string[];
}

export function computeKitMaterials(
  templates: readonly KitTemplateForResolution[],
  orderLines: readonly KitOrderLine[],
): KitMaterialRequirement[] {
  const unitsByProduct = new Map<string, number>();
  let totalUnits = 0;
  for (const line of orderLines) {
    if (!line.productId) continue;
    const q = effectiveLineQuantity(line);
    if (q <= 0) continue;
    unitsByProduct.set(line.productId, (unitsByProduct.get(line.productId) ?? 0) + q);
    totalUnits += q;
  }
  if (totalUnits === 0) return [];

  const ordered = templates
    .filter((t) => t.active)
    .slice()
    .sort((a, b) => (a.priority !== b.priority ? b.priority - a.priority : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const acc = new Map<string, { quantity: number; templateIds: string[]; topPriority: number }>();
  for (const template of ordered) {
    let units: number;
    if (template.appliesTo === "all") units = totalUnits;
    else {
      units = 0;
      for (const productId of new Set(template.productIds)) units += unitsByProduct.get(productId) ?? 0;
      if (units === 0) continue;
    }
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

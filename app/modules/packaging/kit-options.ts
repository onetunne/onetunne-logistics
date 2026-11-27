/**
 * Етап 5: пошук товару у формі шаблону комплектації — ТІ САМІ поля, що й серверний пошук у каталозі
 * (listKitProductOptions: назва, handle, SKU, штрихкод, модель, колір, назва варіанта). Інакше товар, знайдений
 * кнопкою «Шукати в каталозі» за штрихкодом чи handle, додавався б до списку, але фільтр форми його ховав.
 * Чиста функція (без React/БД) — для сторінки kits.tsx і тестів.
 */
import { normalizeVariantValue } from "./kit-resolution";

export interface KitProductSearchFields {
  title: string;
  handle: string | null;
  skus: readonly string[];
  barcodes: readonly string[];
  models: readonly string[];
  colors: readonly string[];
  variantTitles: readonly string[];
}

const lower = (s: string) => s.toLocaleLowerCase("uk");

export function kitProductSearchValues(p: KitProductSearchFields): string[] {
  return [p.title, p.handle ?? "", ...p.skus, ...p.barcodes, ...p.models, ...p.colors, ...p.variantTitles].filter(Boolean);
}

/** Чи відповідає товар тексту пошуку форми (порожній текст — так). */
export function kitProductMatchesQuery(p: KitProductSearchFields, query: string): boolean {
  const q = lower(query.trim());
  if (!q) return true;
  return kitProductSearchValues(p).some((v) => lower(v).includes(q));
}

// ---------------------------------------------------------------------------
// Фільтр списку шаблонів за моделлю й кольором варіанта (сторінка «Комплектація»)
// ---------------------------------------------------------------------------

/** Модель і колір варіанта (product_variants.model / color). */
export interface KitVariantAttributes {
  model: string | null;
  color: string | null;
}

export interface KitTemplateVariantScope {
  appliesTo: "all" | "products" | "collections";
  /** Власний фільтр варіантів шаблону (порожній — без фільтра). */
  models: readonly string[];
  colors: readonly string[];
}

/**
 * Чи стосується шаблон варіантів із моделлю та/або кольором фільтра списку (порожні — без фільтра). Ті самі правила,
 * що й у розрахунку комплектації (kit-resolution.ts): порівняння без зайвих пробілів і регістру, модель І колір разом.
 * - Власний фільтр шаблону — головний: є він за моделлю (кольором) — значення фільтра списку мусить у нього входити.
 * - Вимір, якого шаблон сам не обмежує, перевіряється за ціллю: «усі товари» підходять будь-якому значенню; вибрані
 *   товари / колекції — потрібен хоча б ОДИН варіант цілі з такою моделлю (кольором), що проходить і власний фільтр
 *   шаблону (модель і колір — одного варіанта, а не різних).
 * `targetVariants` — варіанти товарів цілі шаблону (для «усі товари» не потрібні).
 */
export function kitTemplateMatchesVariantFilter(
  tpl: KitTemplateVariantScope,
  targetVariants: readonly KitVariantAttributes[] | null | undefined,
  filter: { model?: string | null; color?: string | null },
): boolean {
  const model = normalizeVariantValue(filter.model);
  const color = normalizeVariantValue(filter.color);
  if (!model && !color) return true;
  const ownModels = tpl.models.map(normalizeVariantValue).filter(Boolean);
  const ownColors = tpl.colors.map(normalizeVariantValue).filter(Boolean);
  if (model && ownModels.length > 0 && !ownModels.includes(model)) return false;
  if (color && ownColors.length > 0 && !ownColors.includes(color)) return false;
  const needModel = model !== "" && ownModels.length === 0;
  const needColor = color !== "" && ownColors.length === 0;
  if (!needModel && !needColor) return true;
  if (tpl.appliesTo === "all") return true;
  return (targetVariants ?? []).some((v) => {
    const vm = normalizeVariantValue(v.model);
    const vc = normalizeVariantValue(v.color);
    if (needModel && vm !== model) return false;
    if (needColor && vc !== color) return false;
    if (ownModels.length > 0 && !ownModels.includes(vm)) return false;
    if (ownColors.length > 0 && !ownColors.includes(vc)) return false;
    return true;
  });
}

/**
 * Значення поля фільтра «Модель»/«Колір» у списку шаблонів. Фільтр порівнює без регістру й зайвих пробілів
 * (normalizeVariantValue), а варіанти поля — точні значення каталогу й шаблонів. Тож поле показує варіант, рівний
 * вибраному після нормалізації (?color=blue → «Blue»); якщо такого немає (значення з посилання, товар прибрано) —
 * вибране додається до варіантів. Інакше поле показувало б «Усі …», хоча перелік відфільтровано, а повторне
 * «Застосувати» мовчки скидало б фільтр.
 */
export function variantFilterSelection(options: readonly string[], selected: string | null | undefined): { options: string[]; value: string } {
  const value = (selected ?? "").trim();
  if (!value) return { options: [...options], value: "" };
  const key = normalizeVariantValue(value);
  const match = options.find((o) => normalizeVariantValue(o) === key);
  return match !== undefined ? { options: [...options], value: match } : { options: [...options, value], value };
}

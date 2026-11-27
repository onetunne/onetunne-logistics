/**
 * Етап 5: пошук товару у формі шаблону комплектації — ТІ САМІ поля, що й серверний пошук у каталозі
 * (listKitProductOptions: назва, handle, SKU, штрихкод, модель, колір, назва варіанта). Інакше товар, знайдений
 * кнопкою «Шукати в каталозі» за штрихкодом чи handle, додавався б до списку, але фільтр форми його ховав.
 * Чиста функція (без React/БД) — для сторінки kits.tsx і тестів.
 */
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

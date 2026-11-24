import type { IssueCode, LineItemInput, ValidationIssue, VariantCustomsField } from "./types";

/**
 * Перевірка товарів і митних даних. Дані товарів НІКОЛИ не виправляються автоматично —
 * лише повідомляються проблеми (виправлення — у картці товару).
 */

/** HS-код: лише цифри, якщо після видалення крапок і пробілів залишилось 6–10 цифр; інакше null. */
export function normalizeHsCode(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const digits = raw.replace(/[.\s]/g, "");
  return /^\d{6,10}$/.test(digits) ? digits : null;
}

/** Десятковий рядок > 0 (напр. "24.90"). */
export function isPositiveDecimal(value: string): boolean {
  const v = value.trim();
  return /^\d+(?:\.\d+)?$/.test(v) && /[1-9]/.test(v);
}

function blank(value: string | null): boolean {
  return value === null || value.trim() === "";
}

export function validateProducts(items: readonly LineItemInput[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (items.length === 0) {
    issues.push({ code: "ORDER_NO_ITEMS", severity: "error", field: "order", params: {}, suggestion: null });
    return issues;
  }

  const seenVariants = new Set<string>();
  for (const item of items) {
    const lineField = `lineItem.${item.lineItemId}`;
    const title = item.title;

    if (!isPositiveDecimal(item.unitPrice)) {
      issues.push({ code: "PRODUCT_PRICE_INVALID", severity: "error", field: lineField, params: { title }, suggestion: null });
    }

    const variant = item.variant;
    if (variant === null) {
      issues.push({ code: "PRODUCT_NOT_LINKED", severity: "error", field: lineField, params: { title }, suggestion: null });
      continue;
    }

    // Проблеми варіанта — один раз, навіть якщо варіант повторюється в кількох позиціях.
    if (seenVariants.has(variant.variantId)) continue;
    seenVariants.add(variant.variantId);

    const params = { title, sku: variant.sku?.trim() || "—" };
    const add = (code: IssueCode, field: VariantCustomsField) =>
      issues.push({ code, severity: "error", field: `variant.${variant.variantId}.${field}`, params: { ...params }, suggestion: null });

    const weight = variant.weightGrams;
    if (weight === null || !Number.isFinite(weight) || weight <= 0) add("PRODUCT_WEIGHT_MISSING", "weightGrams");

    if (blank(variant.hsCode)) add("PRODUCT_HS_CODE_MISSING", "hsCode");
    else if (normalizeHsCode(variant.hsCode) === null) add("PRODUCT_HS_CODE_INVALID", "hsCode");

    const origin = (variant.countryOfOrigin ?? "").trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(origin)) add("PRODUCT_ORIGIN_MISSING", "countryOfOrigin");

    if (blank(variant.customsDescription)) add("PRODUCT_CUSTOMS_DESCRIPTION_MISSING", "customsDescription");
  }

  return issues;
}

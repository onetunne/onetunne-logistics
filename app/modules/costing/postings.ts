/**
 * Етап 6, WP2: записи журналу з наслідків оцінки складу БЕЗ замовлення (docs/stage6-design.md §6.3, §6.4, R4/R6) —
 * чисті функції. Ключі — financeKeys (core/keys.ts): `val:<valuationId>[:part]`, `valc:<completionId>`,
 * `adj:<movementId>:v<n>:<part>`. Записи замовлень (cogs, packaging, cogs_return) проводить syncOrderFinance (WP4) з
 * фактів order-facts.server.ts.
 */
import type { FinanceCategory } from "~/domain/finance";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { minorToDecimal, type CostEffect, type ValuationEffect } from "./engine";

export interface EffectContext {
  valuationId: string;
  occurredOn: string;
  currency: string;
  stockItemId: string;
  variantId: string | null;
  quantity: number;
  movementType: string;
  productionBatchId?: string | null;
}

const neg = (minor: bigint) => minorToDecimal(-minor);
const pos = (minor: bigint) => minorToDecimal(minor);

/** Наслідок → запис (сума ≠ 0; нульові наслідки рушій не створює). */
export function effectEntry(e: CostEffect, c: EffectContext): EntryInput {
  const base = {
    recognizedOn: c.occurredOn,
    fxOn: c.occurredOn,
    currency: c.currency,
    stockItemId: c.stockItemId,
    variantId: c.variantId,
    quantity: c.quantity,
    sourceType: "valuation" as const,
    sourceId: c.valuationId,
  };
  switch (e.type) {
    case "inventory_loss":
      return { ...base, idempotencyKey: financeKeys.valuation(c.valuationId), category: "inventory_loss", amount: neg(e.minor), details: { kind: e.lossKind, movementType: c.movementType } };
    case "inventory_gain":
      return { ...base, idempotencyKey: financeKeys.valuation(c.valuationId), category: "inventory_gain", amount: pos(e.minor), details: { kind: e.gainKind, movementType: c.movementType } };
    case "packaging_unlinked":
      return { ...base, idempotencyKey: financeKeys.valuation(c.valuationId), category: "packaging_unlinked", amount: neg(e.minor), details: { movementType: c.movementType } };
    case "cogs_return_unlinked":
      return { ...base, idempotencyKey: financeKeys.valuation(c.valuationId), category: "cogs_return", amount: pos(e.minor), details: { kind: "return_without_order", movementType: c.movementType } };
    case "production_capitalized_memo":
      return {
        ...base,
        idempotencyKey: financeKeys.valuation(c.valuationId, "memo"),
        category: "production_capitalized_memo",
        amount: pos(e.minor),
        details: { source: e.source, movementType: c.movementType, ...(c.productionBatchId ? { productionBatchId: c.productionBatchId } : {}) },
      };
    case "materials_purchased_memo":
      return { ...base, idempotencyKey: financeKeys.valuation(c.valuationId, "memo"), category: "materials_purchased_memo", amount: pos(e.minor), details: { movementType: c.movementType } };
  }
}

/** Категорія завершення для виходу без замовлення (за наслідком оцінки виходу); null — запису немає. */
export function completionCategory(effect: ValuationEffect): FinanceCategory | null {
  if (effect === "loss") return "inventory_loss";
  if (effect === "packaging_unlinked") return "packaging_unlinked";
  return null;
}

/**
 * Завершення відсутньої вартості виходу без замовлення (R3): датою виходу (закритий місяць → пізній запис ядра),
 * is_late_completion, ключ valc:<completionId>.
 */
export function completionEntry(input: {
  completionId: string;
  category: FinanceCategory;
  minor: bigint;
  outflowOn: string;
  currency: string;
  stockItemId: string;
  variantId: string | null;
  quantity: number;
  saleValuationId: string;
  basis: string;
  lossKind?: string | null;
}): EntryInput {
  return {
    idempotencyKey: financeKeys.valuationCompletion(input.completionId),
    category: input.category,
    recognizedOn: input.outflowOn,
    fxOn: input.outflowOn,
    isLateCompletion: true,
    amount: minorToDecimal(input.category === "inventory_gain" ? input.minor : -input.minor),
    currency: input.currency,
    stockItemId: input.stockItemId,
    variantId: input.variantId,
    quantity: input.quantity,
    sourceType: "valuation",
    sourceId: input.saleValuationId,
    details: { basis: input.basis, completion: true, ...(input.lossKind ? { kind: input.lossKind } : {}) },
  };
}

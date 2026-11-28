/**
 * Етап 6, WP2 → WP4: факти собівартості замовлення з оцінок складу (docs/stage6-design.md §6.4, §6.5, §3.3).
 * syncOrderFinance (WP4) читає ці факти й проводить записи замовлення (repostEntries) з датами визнання:
 * - продаж (consume_sale) → cogs (R1, дата визнання); тестове замовлення без includeTestOrders → inventory_loss
 *   (details.kind = test_order, R6 — дата руху); той самий ключ `cogs:<valuationId>` (перемикання includeTestOrders —
 *   сторно + нове покоління ключа, repostEntries);
 * - упаковка (material_consume з order_id) → packaging (R1; не визнане — R5, дата події), ключ `val:<valuationId>`;
 * - придатне повернення (receipt_manual customer_return) → cogs_return (R2: max(дата події, дата визнання), fx_on — дата
 *   події), ключ `val:<valuationId>`; тестове — inventory_gain (test_order);
 * - пізні завершення невідомої / дефіцитної вартості → та сама категорія, що й факт (R3: дата визнання,
 *   is_late_completion, fx_on — дата руху), ключ `valc:<completionId>`.
 * ВНУТРІШНІЙ модуль для WP4 (сторінки/маршрути не імпортують; гроші — лише в межах внутрішнього проведення).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryValuationCompletions, inventoryValuations, stockItems } from "~/db/schema";
import type { FinanceCategory } from "~/domain/finance";
import { toMinor } from "~/lib/money";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { minorToDecimal } from "./engine";
import { returnedFromSales } from "./inputs.server";
import { detailString } from "./store.server";

export type OrderCostFactKind = "sale" | "packaging" | "return";

export interface OrderCostCompletion {
  completionId: string;
  qty: number;
  /** Десятковий рядок (додатний) у валюті оцінки. */
  value: string;
  basis: string;
}

export interface OrderCostFact {
  valuationId: string;
  kind: OrderCostFactKind;
  movementType: string;
  /** Дата руху (Київ). */
  occurredOn: string;
  stockItemId: string;
  variantId: string | null;
  orderLineItemId: string | null;
  currency: string;
  qty: number;
  /** Одиниці з відомою вартістю на момент руху. */
  knownQty: number;
  /** Відома частина вартості (додатна; null — невідомо). */
  value: string | null;
  valueSource: string;
  unknownQty: number;
  deficitQty: number;
  completions: OrderCostCompletion[];
  /** Лише продаж: одиниці, що досі без вартості (не завершені й не повернені без вартості). */
  unvaluedRemaining: number;
}

export interface OrderCostFacts {
  orderId: string;
  facts: OrderCostFact[];
}

function kindOf(movementType: string | null, valuationKind: string): OrderCostFactKind | null {
  if (movementType === "consume_sale" && valuationKind === "outflow") return "sale";
  if (movementType === "material_consume" && valuationKind === "outflow") return "packaging";
  if (movementType === "receipt_manual" && valuationKind === "inflow") return "return";
  return null;
}

/** Факти собівартості замовлення (оцінки рухів з order_id + їхні завершення). */
export async function loadOrderCostingFacts(db: DbOrTx, orderId: string): Promise<OrderCostFacts> {
  const rows = await db
    .select({ v: inventoryValuations, variantId: stockItems.variantId })
    .from(inventoryValuations)
    .innerJoin(stockItems, eq(stockItems.id, inventoryValuations.stockItemId))
    .where(and(eq(inventoryValuations.orderId, orderId), sql`${inventoryValuations.movementId} is not null`))
    .orderBy(asc(inventoryValuations.seq));
  const ids = rows.map((r) => r.v.id);
  const completions = ids.length
    ? await db.select().from(inventoryValuationCompletions).where(inArray(inventoryValuationCompletions.valuationId, ids)).orderBy(asc(inventoryValuationCompletions.createdAt), asc(inventoryValuationCompletions.id))
    : [];
  const returns = rows.filter((r) => r.v.kind === "inflow" && (r.v.details as Record<string, unknown>)?.kind === "customer_return").map((r) => r.v);
  const returned = returnedFromSales(returns);
  const facts: OrderCostFact[] = [];
  for (const { v, variantId } of rows) {
    const kind = kindOf(detailString(v, "movementType"), v.kind);
    if (!kind) continue;
    const own = completions.filter((c) => c.valuationId === v.id);
    const completedQty = own.reduce((s, c) => s + c.qty, 0);
    facts.push({
      valuationId: v.id,
      kind,
      movementType: detailString(v, "movementType")!,
      occurredOn: v.occurredOn,
      stockItemId: v.stockItemId,
      variantId,
      orderLineItemId: v.orderLineItemId,
      currency: v.currency,
      qty: v.qty,
      knownQty: v.knownQty,
      value: v.value,
      valueSource: v.valueSource,
      unknownQty: v.unknownQty,
      deficitQty: v.deficitQty,
      completions: own.map((c) => ({ completionId: c.id, qty: c.qty, value: c.value, basis: c.basis })),
      unvaluedRemaining: kind === "sale" ? Math.max(0, v.unknownQty + v.deficitQty - completedQty - (returned.get(v.id)?.unvaluedQty ?? 0)) : 0,
    });
  }
  return { orderId, facts };
}

export interface OrderCostingTreatment {
  /** Дата визнання замовлення (R1/R3); null — не визнане (скасоване до відвантаження: R5 — дата події). */
  recognizedOn: string | null;
  /** Тестове замовлення без includeTestOrders: вихід → inventory_loss (test_order, R6), повернення → inventory_gain. */
  excludedTestOrder: boolean;
}

const later = (a: string, b: string) => (a > b ? a : b);
const neg = (v: string) => minorToDecimal(-toMinor(v));

/**
 * Записи замовлення з фактів (чиста функція; базові ключі — для repostEntries). Нульових сум немає (CHECK amount <> 0):
 * факт без відомої вартості не проводиться (складник лишається missing / partial).
 */
export function costingEntriesForOrder(orderId: string, facts: readonly OrderCostFact[], t: OrderCostingTreatment): EntryInput[] {
  const out: EntryInput[] = [];
  for (const f of facts) {
    const dimensions = {
      orderId,
      orderLineItemId: f.orderLineItemId,
      stockItemId: f.stockItemId,
      variantId: f.variantId,
      currency: f.currency,
      sourceType: "valuation" as const,
      sourceId: f.valuationId,
    };
    let category: FinanceCategory;
    let recognizedOn: string;
    let sign: 1 | -1;
    const details: Record<string, string | number | boolean> = { movementType: f.movementType, valueSource: f.valueSource };
    if (f.kind === "sale") {
      category = t.excludedTestOrder ? "inventory_loss" : "cogs";
      recognizedOn = t.excludedTestOrder || t.recognizedOn === null ? f.occurredOn : t.recognizedOn;
      sign = -1;
      if (t.excludedTestOrder) details.kind = "test_order";
      if (f.unknownQty + f.deficitQty > 0) details.unvaluedQty = f.unknownQty + f.deficitQty;
    } else if (f.kind === "packaging") {
      category = "packaging";
      recognizedOn = t.recognizedOn ?? f.occurredOn;
      sign = -1;
    } else {
      category = t.excludedTestOrder ? "inventory_gain" : "cogs_return";
      recognizedOn = t.excludedTestOrder || t.recognizedOn === null ? f.occurredOn : later(f.occurredOn, t.recognizedOn);
      sign = 1;
      if (t.excludedTestOrder) details.kind = "test_order";
    }
    if (f.value !== null && toMinor(f.value) !== 0n) {
      out.push({
        ...dimensions,
        idempotencyKey: f.kind === "sale" ? financeKeys.cogs(f.valuationId) : financeKeys.valuation(f.valuationId),
        category,
        recognizedOn,
        fxOn: f.kind === "return" ? f.occurredOn : recognizedOn,
        amount: sign === 1 ? f.value : neg(f.value),
        quantity: f.knownQty,
        details,
      });
    }
    for (const c of f.completions) {
      if (toMinor(c.value) === 0n) continue;
      out.push({
        ...dimensions,
        idempotencyKey: financeKeys.valuationCompletion(c.completionId),
        category,
        recognizedOn,
        fxOn: f.occurredOn,
        isLateCompletion: true,
        amount: sign === 1 ? c.value : neg(c.value),
        quantity: c.qty,
        details: { ...details, completion: true, basis: c.basis },
      });
    }
  }
  return out;
}

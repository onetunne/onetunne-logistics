/**
 * Етап 6, WP9: чисте віднесення джерел до випадків повернення (docs/stage6-design.md §6.7, §11) — без БД і без грошей.
 *
 * Позиції випадків із джерел мають детерміновані id (keys.ts `returnLineId`), тож за самими id видно, з якого джерела
 * позиція: рядок повернення коштів Shopify (з його `restockType`) чи надходження на склад. Звідси:
 * - `lineOrigins` — походження кожної позиції замовлення з джерела (MIXED з точним розподілом — точно, лише якщо кількість
 *   позиції випадку збігається з розподілом: `refundLineRestockType` / `isUncertainCaseLine`);
 * - `sourceOwners` — якому випадку належить кожне повернення коштів / надходження (за ключем випадку або за його
 *   позиціями; джерело, що випадку не утворило — напр. повернення коштів без позицій, — не належить нікому);
 * - `caseInsight` — одиниці випадку (рядки MIXED — неточні, rules.ts caseUnits), «Очікує надходження на склад» (§6.7:
 *   повернення коштів з поверненням товару на склад — RETURN / LEGACY_RESTOCK, можливо MIXED — без надходження;
 *   лише незакритий випадок, у якому товар фізично повертається — не «Лише повернення коштів» і не «Втрачено»);
 * - `entryCase` — випадок запису журналу за його джерелом (продаж угоди повернення → повернення коштів; оцінка складу →
 *   надходження; ручна витрата / частка → `finance_expenses.return_id`); інакше null («за замовленням»).
 */
import { returnSourceKeys } from "./keys";
import {
  caseUnits,
  exactRestockSplit,
  isReturnRestock,
  isUncertainRestock,
  resolveMixedLine,
  receiptLineIds,
  refundLineIds,
  type CaseLineLike,
  type CaseUnits,
  type RefundSource,
  type ReturnKind,
  type ReturnStatus,
} from "./rules";

export type LineOrigin =
  | {
      kind: "refund";
      refundId: string;
      /** Вид рядка повернення коштів, як записано (MIXED — кількість позиції неточна, якщо `exact` її не підтверджує). */
      restockType: string | null;
      /**
       * Лише MIXED з точним розподілом (0013): кількості, які дає розподіл (після / до відвантаження — resolveMixedLine), з
       * представницьким видом. Позиція випадку ТОЧНА, лише якщо її кількість — одна з них; інакше її створено до 0013 з
       * верхньої межі (разом з CANCEL) — і вона лишається «неточно» (позиції з джерел не переписуються мовчки).
       */
      exact?: ReadonlyArray<{ quantity: number; restockType: string | null }>;
    }
  | { kind: "receipt"; movementId: string };

/** Походження позицій з джерел замовлення (id позиції → джерело). */
export function lineOrigins(refunds: ReadonlyArray<Pick<RefundSource, "refundId" | "lines">>, receiptMovementIds: readonly string[]): Map<string, LineOrigin> {
  const out = new Map<string, LineOrigin>();
  for (const r of refunds) {
    const ids = refundLineIds(r);
    r.lines.forEach((l, i) => {
      const origin: LineOrigin = { kind: "refund", refundId: r.refundId, restockType: l.restockType };
      if (exactRestockSplit(l)) {
        const exact: Array<{ quantity: number; restockType: string | null }> = [];
        for (const after of [true, false]) {
          const resolved = resolveMixedLine(l, after);
          if (resolved && !exact.some((e) => e.quantity === resolved.quantity)) exact.push({ quantity: resolved.quantity, restockType: resolved.restockType });
        }
        origin.exact = exact;
      }
      out.set(ids[i]!, origin);
    });
  }
  for (const movementId of receiptMovementIds) for (const id of receiptLineIds({ movementId })) out.set(id, { kind: "receipt", movementId });
  return out;
}

/**
 * Вид одиниць позиції випадку з джерела-повернення коштів (undefined — позиція не з повернення коштів). MIXED з точним
 * розподілом — представницький вид, якщо кількість позиції збігається з розподілом; інакше MIXED (неточно).
 */
export function refundLineRestockType(o: LineOrigin | undefined, quantity: number): string | null | undefined {
  if (o?.kind !== "refund") return undefined;
  if (!o.exact) return o.restockType;
  const match = o.exact.find((e) => e.quantity === quantity);
  return match ? match.restockType : o.restockType;
}

/** Кількість позиції випадку неточна (рядок повернення коштів MIXED, не підтверджений точним розподілом). */
export function isUncertainCaseLine(o: LineOrigin | undefined, quantity: number): boolean {
  const t = refundLineRestockType(o, quantity);
  return t !== undefined && isUncertainRestock(t);
}

export interface SourceOwners {
  /** order_refunds.id → випадок. */
  refundCase: Map<string, string>;
  /** inventory_movements.id (надходження) → випадок. */
  receiptCase: Map<string, string>;
}

/** Якому випадку належить кожне джерело замовлення: випадок із ключем джерела, інакше — випадок з його позиціями. */
export function sourceOwners(input: {
  cases: ReadonlyArray<{ id: string; sourceKey: string }>;
  lines: ReadonlyArray<{ id: string; returnId: string }>;
  origins: ReadonlyMap<string, LineOrigin>;
}): SourceOwners {
  const refundCase = new Map<string, string>();
  const receiptCase = new Map<string, string>();
  const refundPrefix = returnSourceKeys.refund("");
  const receiptPrefix = returnSourceKeys.receipt("");
  for (const c of input.cases) {
    if (c.sourceKey.startsWith(refundPrefix)) refundCase.set(c.sourceKey.slice(refundPrefix.length), c.id);
    if (c.sourceKey.startsWith(receiptPrefix)) receiptCase.set(c.sourceKey.slice(receiptPrefix.length), c.id);
  }
  for (const l of input.lines) {
    const o = input.origins.get(l.id);
    if (!o) continue;
    if (o.kind === "refund" && !refundCase.has(o.refundId)) refundCase.set(o.refundId, l.returnId);
    if (o.kind === "receipt" && !receiptCase.has(o.movementId)) receiptCase.set(o.movementId, l.returnId);
  }
  return { refundCase, receiptCase };
}

export interface CaseInsight {
  units: CaseUnits;
  /** §6.7: повернення коштів з поверненням товару на склад не має надходження. */
  awaitingReceipt: boolean;
  /** awaitingReceipt лише за рядками MIXED (повернення товару можливе, не напевно). */
  awaitingReceiptUncertain: boolean;
  /** Є позиції з неточною кількістю (MIXED). */
  quantityUncertain: boolean;
}

/** Види випадків, у яких товар фізично повертається на склад. */
const PHYSICAL_RETURN_KINDS: readonly ReturnKind[] = ["customer_return", "carrier_return", "refused", "other"];

export function caseInsight(
  c: { kind: ReturnKind; status: ReturnStatus },
  lines: readonly CaseLineLike[],
  origins: ReadonlyMap<string, LineOrigin>,
): CaseInsight {
  let returnRefund = false;
  let possibleReturnRefund = false;
  let receipt = false;
  const marked = lines.map((l) => {
    const o = origins.get(l.id);
    if (o?.kind === "receipt") receipt = true;
    const t = refundLineRestockType(o, l.quantity);
    const uncertain = t !== undefined && isUncertainRestock(t);
    if (t !== undefined && isReturnRestock(t)) {
      if (uncertain) possibleReturnRefund = true;
      else returnRefund = true;
    }
    return { ...l, uncertain };
  });
  const units = caseUnits(marked);
  const awaiting = c.status !== "closed" && PHYSICAL_RETURN_KINDS.includes(c.kind) && !receipt && (returnRefund || possibleReturnRefund);
  return {
    units,
    awaitingReceipt: awaiting,
    awaitingReceiptUncertain: awaiting && !returnRefund,
    quantityUncertain: marked.some((l) => l.uncertain),
  };
}

export interface EntrySourceMaps {
  /** order_sales: id і shopify_sale_id → Shopify refund gid (null — продаж не з повернення коштів). */
  saleRefundGid: ReadonlyMap<string, string | null>;
  /** order_refunds.shopify_refund_id → order_refunds.id. */
  refundIdByGid: ReadonlyMap<string, string>;
  /** inventory_valuations.id → рух складу. */
  valuationMovement: ReadonlyMap<string, string | null>;
  /** finance_expenses.id → return_id. */
  expenseReturn: ReadonlyMap<string, string | null>;
  owners: SourceOwners;
  /** Випадки замовлення (віднесення лише до них). */
  caseIds: ReadonlySet<string>;
}

/** Випадок запису журналу за джерелом; null — запис замовлення, не віднесений до жодного випадку. */
export function entryCase(e: { sourceType: string; sourceId: string }, m: EntrySourceMaps): string | null {
  let caseId: string | null | undefined = null;
  if (e.sourceType === "shopify_sale") {
    const gid = m.saleRefundGid.get(e.sourceId);
    const refundId = gid ? m.refundIdByGid.get(gid) : undefined;
    caseId = refundId ? m.owners.refundCase.get(refundId) : null;
  } else if (e.sourceType === "valuation") {
    const movementId = m.valuationMovement.get(e.sourceId);
    caseId = movementId ? m.owners.receiptCase.get(movementId) : null;
  } else if (e.sourceType === "expense" || e.sourceType === "allocation") {
    caseId = m.expenseReturn.get(e.sourceId) ?? null;
  }
  return caseId && m.caseIds.has(caseId) ? caseId : null;
}

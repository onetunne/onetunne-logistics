/**
 * Етап 6, WP9: чисті правила розділу «Повернення» (docs/stage6-design.md §11) — без БД, детерміновано.
 *
 * 1. Які повернення коштів Shopify створюють випадок (`classifyRefund`): рядки з `restockType = RETURN` (товар
 *    повернено) — завжди; інші рядки, крім `CANCEL` (скасування невідвантаженого), — лише якщо замовлення вже передано
 *    перевізнику до повернення коштів («повернені виконані позиції»). RETURN / LEGACY_RESTOCK після відвантаження →
 *    «Повернення покупця»; лише NO_RESTOCK (гроші повернено, товар на склад не повертали) → «Лише повернення коштів».
 *    Повернення коштів без позицій або до відвантаження (зменшення продажу, §2.1) випадку не створює.
 *    `MIXED` (WP3 об'єднує кілька рядків повернення однієї позиції з РІЗНИМИ видами — напр. CANCEL 1 + RETURN 2 — в один
 *    рядок; розподіл кількості втрачено): можливо містить повернення товару → «Повернення покупця» (як і інші рядки не
 *    CANCEL — лише після відвантаження), але кількість НЕТОЧНА (верхня межа, частина може бути скасуванням
 *    невідвантаженого): такі позиції позначено `uncertain` і в одиниці випадку їх не додано мовчки (`caseUnits` →
 *    `uncertainUnits`, «ще до N од. — кількість неточна»).
 * 2. Зв'язування джерел (`planReturnSync`, ідемпотентно): джерела — у порядку часу; уже враховане джерело (є випадок
 *    із його ключем або позиція з його детермінованим id) пропускається. Повернення коштів приєднується до найранішого
 *    незакритого випадку без повернення коштів, інакше — новий випадок (`open`). Надходження на склад приєднується до
 *    найранішого випадку «Відкрито» / «Їде назад» (стає «Отримано на склад»), інакше — до останнього незакритого
 *    «Отримано на склад», інакше — новий випадок (`received`). «Лише повернення коштів» + надходження → «Повернення
 *    покупця». Закриті випадки не змінюються.
 * 3. Одиниці випадку (`caseUnits`): позиції зі станом «невідомо» — заявлені (повернення коштів), з відомим станом —
 *    оглянуті на складі; одиниць товару в випадку = max(заявлено, оглянуто) на позицію замовлення — повернення коштів і
 *    надходження тих самих одиниць не рахуються двічі.
 */
import type { RETURN_KINDS, RETURN_LINE_CONDITIONS, RETURN_REASON_CODES, RETURN_SOURCES, RETURN_STATUSES } from "~/domain/finance";
import { mulDivHalfAwayFromZero, scaledToDecimal } from "~/lib/decimal";
import { RECEIPT_LINE_PARTS, returnLineId, returnSourceKeys } from "./keys";

export type ReturnKind = (typeof RETURN_KINDS)[number];
export type ReturnStatus = (typeof RETURN_STATUSES)[number];
export type ReturnLineCondition = (typeof RETURN_LINE_CONDITIONS)[number];
export type ReturnSource = (typeof RETURN_SOURCES)[number];
export type ReturnReason = (typeof RETURN_REASON_CODES)[number];

// ---------------------------------------------------------------------------
// Джерела
// ---------------------------------------------------------------------------

export interface RefundLineSource {
  shopifyLineItemId: string;
  orderLineItemId: string | null;
  variantId: string | null;
  quantity: number;
  /** Shopify RefundLineItem.restockType (RETURN | NO_RESTOCK | CANCEL | LEGACY_RESTOCK) або null. */
  restockType: string | null;
}

export interface RefundSource {
  /** `order_refunds.id`. */
  refundId: string;
  /** processedAt ?? createdAt (Shopify) ?? час отримання. */
  at: Date;
  lines: RefundLineSource[];
}

export interface ReceiptSource {
  /** Рух receipt_manual (причина customer_return). */
  movementId: string;
  at: Date;
  seq: number;
  variantId: string | null;
  orderLineItemId: string | null;
  /** Придатні одиниці (on_hand після парного руху браку `…:return_defect`). */
  good: number;
  /** Пошкоджені одиниці. */
  damaged: number;
}

/** Відвантаження замовлення: перша фактична передача (якщо відома) і чи замовлення взагалі відвантажене. */
export interface ShippingFacts {
  shippedAt: Date | null;
  shipped: boolean;
}

const norm = (v: string | null) => (v ?? "").trim().toUpperCase();

/** Види повернення на склад Shopify, що означають повернення товару (§6.7, §11). */
export const RETURN_RESTOCK_TYPES = ["RETURN", "LEGACY_RESTOCK"] as const;
/** Рядок повернення коштів, у якому WP3 об'єднав кілька видів повернення на склад (кількість за видами втрачено). */
export const MIXED_RESTOCK_TYPE = "MIXED";

/** Рядок означає повернення товару (RETURN / LEGACY_RESTOCK) — або, можливо, містить його (MIXED). */
export function isReturnRestock(restockType: string | null): boolean {
  const t = norm(restockType);
  return (RETURN_RESTOCK_TYPES as readonly string[]).includes(t) || t === MIXED_RESTOCK_TYPE;
}

/** Кількість рядка неточна (MIXED — частина може бути CANCEL). */
export function isUncertainRestock(restockType: string | null): boolean {
  return norm(restockType) === MIXED_RESTOCK_TYPE;
}

/** Чи замовлення було відвантажене на момент `at` (час передачі невідомий, але замовлення відвантажене → так). */
export function shippedBy(shipping: ShippingFacts, at: Date): boolean {
  if (shipping.shippedAt) return shipping.shippedAt.getTime() <= at.getTime();
  return shipping.shipped;
}

/** Повернення коштів → вид випадку й позиції, що його утворюють; null — не повернення товару (див. шапку). */
export function classifyRefund(
  refund: RefundSource,
  shipping: ShippingFacts,
): {
  kind: Extract<ReturnKind, "customer_return" | "refund_only">;
  lines: RefundLineSource[];
  /** Є рядки MIXED: вид «Повернення покупця» лише можливий, кількість — верхня межа. */
  uncertain: boolean;
} | null {
  const after = shippedBy(shipping, refund.at);
  const lines = refund.lines.filter((l) => {
    if (!(l.quantity > 0)) return false;
    const t = norm(l.restockType);
    if (t === "RETURN") return true;
    if (t === "CANCEL") return false;
    // NO_RESTOCK, LEGACY_RESTOCK, MIXED, невідомий — лише виконані позиції (після відвантаження).
    return after;
  });
  if (lines.length === 0) return null;
  const returned = lines.some((l) => isReturnRestock(l.restockType));
  return {
    kind: returned ? "customer_return" : "refund_only",
    lines,
    uncertain: lines.some((l) => isUncertainRestock(l.restockType)),
  };
}

/** Детерміновані id позицій повернення коштів (одна позиція на рядок повернення). */
export function refundLineIds(refund: Pick<RefundSource, "refundId" | "lines">): string[] {
  const key = returnSourceKeys.refund(refund.refundId);
  return refund.lines.map((l) => returnLineId(key, l.shopifyLineItemId));
}

/** Детерміновані id позицій надходження (придатні / пошкоджені). */
export function receiptLineIds(receipt: Pick<ReceiptSource, "movementId">): string[] {
  const key = returnSourceKeys.receipt(receipt.movementId);
  return RECEIPT_LINE_PARTS.map((p) => returnLineId(key, p));
}

// ---------------------------------------------------------------------------
// План синхронізації
// ---------------------------------------------------------------------------

export interface ExistingCase {
  id: string;
  kind: ReturnKind;
  status: ReturnStatus;
  source: ReturnSource;
  sourceKey: string;
  firstSignalAt: Date;
  receivedAt: Date | null;
  createdAt: Date;
  version: number;
}

export interface PlanInput {
  refunds: readonly RefundSource[];
  receipts: readonly ReceiptSource[];
  shipping: ShippingFacts;
  cases: readonly ExistingCase[];
  /** Наявні позиції випадків замовлення (id → випадок). */
  lines: ReadonlyArray<{ id: string; returnId: string }>;
  newId: () => string;
}

export interface PlannedLine {
  id: string;
  returnId: string;
  orderLineItemId: string | null;
  variantId: string | null;
  quantity: number;
  condition: ReturnLineCondition;
  restockedQty: number;
}

export interface PlannedCase {
  id: string;
  kind: ReturnKind;
  status: ReturnStatus;
  source: ReturnSource;
  sourceKey: string;
  firstSignalAt: Date;
  receivedAt: Date | null;
}

export interface PlannedUpdate {
  id: string;
  expectedVersion: number;
  kind: ReturnKind;
  status: ReturnStatus;
  firstSignalAt: Date;
  receivedAt: Date | null;
}

export interface ReturnSyncPlan {
  creates: PlannedCase[];
  updates: PlannedUpdate[];
  lines: PlannedLine[];
  /** Джерела, приєднані до наявних (або щойно створених цим планом) випадків з іншим ключем. */
  linked: Array<{ returnId: string; sourceKey: string }>;
}

interface WorkCase {
  id: string;
  kind: ReturnKind;
  status: ReturnStatus;
  firstSignalAt: Date;
  receivedAt: Date | null;
  createdAt: Date;
  hasRefund: boolean;
  existing: ExistingCase | null;
  planned: PlannedCase | null;
}

const earlier = (a: Date, b: Date) => (a.getTime() <= b.getTime() ? a : b);

function byFirstSignal(a: WorkCase, b: WorkCase): number {
  return a.firstSignalAt.getTime() - b.firstSignalAt.getTime() || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}

type SourceEvent = { type: "refund"; at: Date; id: string; refund: RefundSource } | { type: "receipt"; at: Date; id: string; receipt: ReceiptSource };

/** Детермінований план: що створити, що оновити (CAS за версією), які позиції вставити. */
export function planReturnSync(input: PlanInput): ReturnSyncPlan {
  const existingLineIds = new Set(input.lines.map((l) => l.id));
  const lineCase = new Map(input.lines.map((l) => [l.id, l.returnId]));
  const allRefundIds = new Set(input.refunds.flatMap(refundLineIds));
  const work: WorkCase[] = input.cases.map((c) => ({
    id: c.id,
    kind: c.kind,
    status: c.status,
    firstSignalAt: c.firstSignalAt,
    receivedAt: c.receivedAt,
    createdAt: c.createdAt,
    hasRefund: c.source === "shopify_refund" || input.lines.some((l) => l.returnId === c.id && allRefundIds.has(l.id)),
    existing: c,
    planned: null,
  }));
  const keys = new Set(input.cases.map((c) => c.sourceKey));
  const plan: ReturnSyncPlan = {
    creates: [],
    updates: [],
    lines: [],
    linked: [],
  };
  const claimed = (key: string, ids: readonly string[]) => keys.has(key) || ids.some((id) => existingLineIds.has(id));

  const events: SourceEvent[] = [
    ...input.refunds.map((refund) => ({
      type: "refund" as const,
      at: refund.at,
      id: refund.refundId,
      refund,
    })),
    ...input.receipts.map((receipt) => ({
      type: "receipt" as const,
      at: receipt.at,
      id: receipt.movementId,
      receipt,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.type === b.type ? 0 : a.type === "refund" ? -1 : 1) || a.id.localeCompare(b.id));

  const create = (c: Omit<PlannedCase, "id">): WorkCase => {
    const planned: PlannedCase = { id: input.newId(), ...c };
    plan.creates.push(planned);
    keys.add(c.sourceKey);
    const w: WorkCase = {
      id: planned.id,
      kind: c.kind,
      status: c.status,
      firstSignalAt: c.firstSignalAt,
      receivedAt: c.receivedAt,
      createdAt: c.firstSignalAt,
      hasRefund: c.source === "shopify_refund",
      existing: null,
      planned,
    };
    work.push(w);
    return w;
  };
  const addLine = (line: PlannedLine) => {
    if (existingLineIds.has(line.id)) return;
    existingLineIds.add(line.id);
    lineCase.set(line.id, line.returnId);
    plan.lines.push(line);
  };

  for (const ev of events) {
    const active = work.filter((c) => c.status !== "closed");
    if (ev.type === "refund") {
      const key = returnSourceKeys.refund(ev.refund.refundId);
      if (claimed(key, refundLineIds(ev.refund))) continue;
      const cls = classifyRefund(ev.refund, input.shipping);
      if (!cls) continue;
      let target = active.filter((c) => !c.hasRefund).sort(byFirstSignal)[0];
      if (target) {
        target.firstSignalAt = earlier(target.firstSignalAt, ev.at);
        target.hasRefund = true;
        plan.linked.push({ returnId: target.id, sourceKey: key });
      } else {
        target = create({
          kind: cls.kind,
          status: "open",
          source: "shopify_refund",
          sourceKey: key,
          firstSignalAt: ev.at,
          receivedAt: null,
        });
      }
      for (const l of cls.lines) {
        addLine({
          id: returnLineId(key, l.shopifyLineItemId),
          returnId: target.id,
          orderLineItemId: l.orderLineItemId,
          variantId: l.variantId,
          quantity: l.quantity,
          condition: "unknown",
          restockedQty: 0,
        });
      }
    } else {
      const r = ev.receipt;
      const key = returnSourceKeys.receipt(r.movementId);
      if (claimed(key, receiptLineIds(r))) continue;
      if (r.good + r.damaged <= 0) continue;
      let target =
        active.filter((c) => c.status === "open" || c.status === "in_transit").sort(byFirstSignal)[0] ??
        active
          .filter((c) => c.status === "received")
          .sort(byFirstSignal)
          .at(-1);
      if (target) {
        if (target.status !== "received") target.status = "received";
        target.receivedAt = target.receivedAt ?? ev.at;
        target.firstSignalAt = earlier(target.firstSignalAt, ev.at);
        if (target.kind === "refund_only") target.kind = "customer_return";
        plan.linked.push({ returnId: target.id, sourceKey: key });
      } else {
        target = create({
          kind: "customer_return",
          status: "received",
          source: "stock_receipt",
          sourceKey: key,
          firstSignalAt: ev.at,
          receivedAt: ev.at,
        });
      }
      const [resellableId, damagedId] = receiptLineIds(r) as [string, string];
      const base = {
        returnId: target.id,
        orderLineItemId: r.orderLineItemId,
        variantId: r.variantId,
      };
      if (r.good > 0)
        addLine({
          id: resellableId,
          ...base,
          quantity: r.good,
          condition: "resellable",
          restockedQty: r.good,
        });
      if (r.damaged > 0)
        addLine({
          id: damagedId,
          ...base,
          quantity: r.damaged,
          condition: "damaged",
          restockedQty: 0,
        });
    }
  }

  for (const w of work) {
    if (w.planned) {
      Object.assign(w.planned, {
        kind: w.kind,
        status: w.status,
        firstSignalAt: w.firstSignalAt,
        receivedAt: w.receivedAt,
      });
      continue;
    }
    const e = w.existing!;
    const changed =
      e.kind !== w.kind ||
      e.status !== w.status ||
      e.firstSignalAt.getTime() !== w.firstSignalAt.getTime() ||
      (e.receivedAt?.getTime() ?? null) !== (w.receivedAt?.getTime() ?? null);
    if (changed)
      plan.updates.push({
        id: e.id,
        expectedVersion: e.version,
        kind: w.kind,
        status: w.status,
        firstSignalAt: w.firstSignalAt,
        receivedAt: w.receivedAt,
      });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Ручні зміни
// ---------------------------------------------------------------------------

/**
 * Ручна зміна статусу (будь-який інший статус; закритий можна відкрити знову): «Отримано на склад» ставить дату
 * отримання, якщо її ще немає (дата фактичного надходження не переписується); «Закрито» — дату закриття; інший статус
 * її знімає.
 */
export function statusDates(
  current: { receivedAt: Date | null; closedAt: Date | null },
  next: ReturnStatus,
  now: Date,
): { receivedAt: Date | null; closedAt: Date | null } {
  return {
    receivedAt: next === "received" ? (current.receivedAt ?? now) : current.receivedAt,
    closedAt: next === "closed" ? (current.closedAt ?? now) : null,
  };
}

// ---------------------------------------------------------------------------
// Одиниці й статистика
// ---------------------------------------------------------------------------

export interface CaseLineLike {
  id: string;
  orderLineItemId: string | null;
  variantId: string | null;
  quantity: number;
  condition: ReturnLineCondition;
  restockedQty: number;
  /** Кількість неточна (рядок повернення коштів MIXED — верхня межа). */
  uncertain?: boolean;
}

export interface CaseItemUnits {
  /** Ключ позиції: позиція замовлення → варіант → сама позиція випадку. */
  key: string;
  orderLineItemId: string | null;
  variantId: string | null;
  /** max(заявлено точно, оглянуто). */
  units: number;
  /** Повернено коштів / заявлено (стан «невідомо», точна кількість). */
  announced: number;
  /** Заявлено з неточною кількістю (MIXED — верхня межа). */
  announcedUncertain: number;
  /** Можливо ще одиниць понад `units` (верхня межа неточних рядків; 0 — кількість точна). */
  uncertain: number;
  /** Оглянуто на складі (придатні + пошкоджені). */
  inspected: number;
  resellable: number;
  damaged: number;
  restocked: number;
}

export interface CaseUnits {
  /** Точно відомі одиниці (рядки MIXED сюди не входять мовчки). */
  units: number;
  restocked: number;
  damaged: number;
  /** Можливо ще одиниць (верхня межа неточних рядків понад `units`); 0 — кількість точна. */
  uncertainUnits: number;
  items: CaseItemUnits[];
}

export function caseUnits(lines: readonly CaseLineLike[]): CaseUnits {
  const items = new Map<string, CaseItemUnits>();
  for (const l of lines) {
    const key = l.orderLineItemId ? `li:${l.orderLineItemId}` : l.variantId ? `v:${l.variantId}` : `l:${l.id}`;
    const it = items.get(key) ?? {
      key,
      orderLineItemId: l.orderLineItemId,
      variantId: l.variantId,
      units: 0,
      announced: 0,
      announcedUncertain: 0,
      uncertain: 0,
      inspected: 0,
      resellable: 0,
      damaged: 0,
      restocked: 0,
    };
    it.variantId = it.variantId ?? l.variantId;
    if (l.condition === "unknown") {
      if (l.uncertain) it.announcedUncertain += l.quantity;
      else it.announced += l.quantity;
    } else it.inspected += l.quantity;
    if (l.condition === "resellable") it.resellable += l.quantity;
    if (l.condition === "damaged") it.damaged += l.quantity;
    it.restocked += l.restockedQty;
    it.units = Math.max(it.announced, it.inspected);
    it.uncertain = Math.max(0, Math.max(it.announced + it.announcedUncertain, it.inspected) - it.units);
    items.set(key, it);
  }
  const list = [...items.values()].sort((a, b) => a.key.localeCompare(b.key));
  return {
    units: list.reduce((s, i) => s + i.units, 0),
    restocked: list.reduce((s, i) => s + i.restocked, 0),
    damaged: list.reduce((s, i) => s + i.damaged, 0),
    uncertainUnits: list.reduce((s, i) => s + i.uncertain, 0),
    items: list,
  };
}

/** Середнє цілих днів з 1 знаком (половина від нуля), десятковий рядок; порожньо → null («—»). */
export function averageDays(days: readonly number[]): string | null {
  if (days.length === 0) return null;
  const sum = days.reduce((s, d) => s + BigInt(d), 0n);
  return scaledToDecimal(mulDivHalfAwayFromZero(sum, 10n, BigInt(days.length)), 1, 1);
}

/** Частка у відсотках з 1 знаком (половина від нуля); знаменник 0 → null («—», не 0). */
export function sharePercent(numerator: number, denominator: number): string | null {
  if (denominator <= 0) return null;
  return scaledToDecimal(mulDivHalfAwayFromZero(BigInt(numerator), 1000n, BigInt(denominator)), 1, 1);
}

/** Групування з лічильником випадків і одиниць (рядки статистики). Порядок: випадки ↓, одиниці ↓, ключ. */
export function groupCounts<K extends string>(rows: ReadonlyArray<{ key: K; cases: number; units: number }>): Array<{ key: K; cases: number; units: number }> {
  const m = new Map<K, { key: K; cases: number; units: number }>();
  for (const r of rows) {
    const g = m.get(r.key) ?? { key: r.key, cases: 0, units: 0 };
    g.cases += r.cases;
    g.units += r.units;
    m.set(r.key, g);
  }
  return [...m.values()].sort((a, b) => b.cases - a.cases || b.units - a.units || a.key.localeCompare(b.key));
}

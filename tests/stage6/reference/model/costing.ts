/**
 * Еталонна модель (WP12a): рушій собівартості — ковзна середньозважена з невідомими, дефіцитними й шарами браку
 * (§6.1–§6.3, §6.5–§6.8), вартість запасів на дату (§6.7, G18), коригування собівартості партії (§6.7, G5).
 *
 * Одна позиція обліку (склад × stock_item) на виклик; суми — соті валюти оцінки (UAH), додатні величини.
 * Рушій НІКОЛИ не кидає виняток через відсутні дані (невідома вартість — стан), лише через порушення інваріанта C0
 * (on_hand = known + unknown − deficit) — це помилка моделі.
 */
import { allocate, cents, mulDiv, rational, rMul, rSub, R_ONE, R_ZERO, rAdd, str, type Cents, type Rational } from "./money";
import type { RefCategory } from "./categories";
import { convert, type ConvertContext } from "./fx";

export type OutflowReason = "sale" | "test_sale" | "material" | "defect_mark" | "adjustment";

export type CostMovement =
  | { kind: "opening"; id: string; date: string; qty: number }
  | { kind: "receipt"; id: string; date: string; good: number; defect?: number; unitCost: string | null; currency?: string; source?: "production" | "purchase" }
  | { kind: "outflow"; id: string; date: string; qty: number; reason: OutflowReason; orderId?: string | null }
  /** defect_mark у парі з `…:return_defect` — вихід за нульовою вартістю (ці одиниці увійшли за нулем). */
  | { kind: "defect_mark_return"; id: string; date: string; qty: number }
  | { kind: "defect_repair"; id: string; date: string; qty: number }
  | { kind: "defect_writeoff"; id: string; date: string; qty: number }
  /** adjustment / shopify_external Δ > 0. */
  | { kind: "surplus"; id: string; date: string; qty: number }
  /**
   * receipt_manual customer_return (з order_id): `good` придатних, `damaged` пошкоджених. `record: "split"` — запис
   * етапу 5 з розділенням (on_hand + усі, потім парний defect_mark), `"plain"` — без розділення; результат однаковий.
   */
  | { kind: "customer_return"; id: string; date: string; orderId: string; good: number; damaged?: number; record?: "split" | "plain" }
  /** Ручна собівартість власника з effective_from: «до залишку» / «до вже проданих» (§6.6). */
  | { kind: "completion"; id: string; date: string; unitCost: string; effectiveFrom: string; toStock: boolean; toSold: boolean }
  /** Зміна собівартості партії: нова ціль вартості надходження `receiptId` (§6.7). */
  | { kind: "revalue"; id: string; date: string; receiptId: string; target: string };

export interface CostLayer {
  id: string;
  kind: "unknown" | "deficit" | "defect";
  reason: string;
  qtyIn: number;
  qtyOpen: number;
  valueOpen: Cents;
  /** deficit — оцінка продажу, що його створила; return_without_cost — оцінка продажу, з якого повернуто. */
  saleValuationId: string | null;
  from: "unknown" | "deficit" | null;
  createdSeq: number;
}

export interface PoolState {
  knownQty: number;
  knownValue: Cents;
  unknownQty: number;
  deficitQty: number;
}

export type ValuationKind = "inflow" | "outflow" | "revaluation" | "stock_completion" | "sale_completion";

export interface CostValuation {
  id: string;
  seq: number;
  movementId: string;
  kind: ValuationKind;
  reason: string;
  occurredOn: string;
  qty: number;
  /** Відома частина вартості (додатна величина). */
  value: Cents;
  knownQty: number;
  unknownQty: number;
  deficitQty: number;
  orderId: string | null;
  after: PoolState | null;
  // Внутрішні лічильники (виходи продажу й надходження).
  poolBefore?: number;
  poolAfter?: number;
  pendUnknown?: number;
  pendDeficit?: number;
  valuedQty?: number;
  valuedValue?: Cents;
  returnedValuedQty?: number;
  returnedValuedValue?: Cents;
  good?: number;
  deficitClosed?: number;
  postedValue?: Cents;
  adjustments?: Cents;
}

export interface CostEffect {
  valuationId: string;
  category: RefCategory;
  /** Зі знаком впливу на прибуток. */
  amount: Cents;
  date: string;
  orderId: string | null;
  kind: string;
}

export interface CostingOptions {
  /** Валюта оцінки (типово UAH) і курси для надходжень в іншій валюті (конвертація на дату руху). */
  currency?: string;
  ctx?: ConvertContext;
  itemKind?: "product" | "material";
  /** Ручна собівартість рядків замовлень без списання (stdcogs): orderId → вартість одиниці (§6.3 п. 2). */
  orderStandards?: Readonly<Record<string, string>>;
}

export interface CostingResult {
  state: PoolState;
  onHand: number;
  layers: CostLayer[];
  valuations: CostValuation[];
  effects: CostEffect[];
}

/** Прогін руху позиції через рушій (порядок — порядок масиву, = seq). */
export function runCosting(movements: readonly CostMovement[], opts: CostingOptions = {}): CostingResult {
  const currency = opts.currency ?? "UAH";
  const pool = { knownQty: 0, knownValue: 0n };
  let onHand = 0;
  const layers: CostLayer[] = [];
  const valuations: CostValuation[] = [];
  const effects: CostEffect[] = [];
  let seq = 0;
  let layerSeq = 0;

  const open = (kind: CostLayer["kind"]) => layers.filter((l) => l.kind === kind && l.qtyOpen > 0).sort((a, b) => a.createdSeq - b.createdSeq);
  const sumOpen = (kind: CostLayer["kind"]) => open(kind).reduce((a, l) => a + l.qtyOpen, 0);
  const snapshot = (): PoolState => ({ knownQty: pool.knownQty, knownValue: pool.knownValue, unknownQty: sumOpen("unknown"), deficitQty: sumOpen("deficit") });
  const addLayer = (l: Omit<CostLayer, "id" | "createdSeq" | "qtyOpen" | "valueOpen"> & { valueOpen?: Cents }) => {
    const layer: CostLayer = { ...l, id: `L${++layerSeq}`, qtyOpen: l.qtyIn, valueOpen: l.valueOpen ?? 0n, createdSeq: seq };
    layers.push(layer);
    return layer;
  };
  const valuation = (v: Omit<CostValuation, "seq" | "after" | "id"> & { after?: PoolState | null }): CostValuation => {
    const r: CostValuation = { ...v, id: `V${seq + 1}`, seq: ++seq, after: v.after === undefined ? snapshot() : v.after };
    valuations.push(r);
    return r;
  };
  const effect = (valuationId: string, category: RefCategory, amount: Cents, date: string, orderId: string | null, kind: string) => {
    if (amount !== 0n) effects.push({ valuationId, category, amount, date, orderId, kind });
  };
  const checkC0 = (where: string) => {
    const s = snapshot();
    if (onHand !== s.knownQty + s.unknownQty - s.deficitQty) throw new Error(`reference C0 violated after ${where}`);
  };
  /** Наслідок вартості виходу за його видом (продаж → cogs; втрати → inventory_loss; матеріали → упаковка). */
  const outflowCategory = (reason: string, orderId: string | null): RefCategory =>
    reason === "sale" ? "cogs" : reason === "material" ? (orderId ? "packaging" : "packaging_unlinked") : "inventory_loss";
  /** Додати в пул (спершу закриваючи дефіцит, §6.3): повертає вартість, що пішла на закриття дефіциту. */
  const inflowToPool = (qty: number, value: Cents, date: string, sourceMovementId: string): { closedQty: number; closedValue: Cents } => {
    const deficits = open("deficit");
    const s = Math.min(qty, deficits.reduce((a, l) => a + l.qtyOpen, 0));
    const closeValue = qty > 0 && s > 0 ? mulDiv(value, BigInt(s), BigInt(qty)) : 0n;
    if (s > 0) {
      const takes: Array<{ layer: CostLayer; t: number }> = [];
      let rem = s;
      for (const l of deficits) {
        if (rem === 0) break;
        const t = Math.min(rem, l.qtyOpen);
        takes.push({ layer: l, t });
        rem -= t;
      }
      const parts = allocate(closeValue, takes.map((x) => BigInt(x.t)));
      takes.forEach(({ layer, t }, i) => {
        layer.qtyOpen -= t;
        completeSaleUnits(layer.saleValuationId!, t, parts[i]!, "deficit", date, sourceMovementId);
      });
    }
    pool.knownQty += qty - s;
    pool.knownValue += value - closeValue;
    return { closedQty: s, closedValue: closeValue };
  };
  /**
   * Завершення одиниць виходу без вартості: частка, що вже повернулася шаром return_without_cost, завершує ЦЕЙ шар
   * (вартість іде в пул), решта — собівартість виходу (sale_completion, дата виходу; пул не змінює).
   */
  function completeSaleUnits(saleValuationId: string, n: number, value: Cents, from: "unknown" | "deficit", date: string, sourceId: string) {
    const sv = valuations.find((v) => v.id === saleValuationId)!;
    const retLayers = layers.filter((l) => l.kind === "unknown" && l.reason === "return_without_cost" && l.saleValuationId === sv.id && l.from === from && l.qtyOpen > 0);
    const tl = Math.min(n, retLayers.reduce((a, l) => a + l.qtyOpen, 0));
    const ts = n - tl;
    const [vl, vs] = tl > 0 && ts > 0 ? (allocate(value, [BigInt(tl), BigInt(ts)]) as [Cents, Cents]) : tl > 0 ? [value, 0n] : [0n, value];
    if (tl > 0) {
      let rem = tl;
      for (const l of retLayers) {
        if (rem === 0) break;
        const t = Math.min(rem, l.qtyOpen);
        l.qtyOpen -= t;
        rem -= t;
      }
      pool.knownQty += tl;
      pool.knownValue += vl;
      valuation({ movementId: sourceId, kind: "stock_completion", reason: "return_layer", occurredOn: date, qty: tl, value: vl, knownQty: tl, unknownQty: 0, deficitQty: 0, orderId: null });
    }
    if (ts > 0) {
      if (from === "unknown") sv.pendUnknown = (sv.pendUnknown ?? 0) - ts;
      else sv.pendDeficit = (sv.pendDeficit ?? 0) - ts;
      sv.valuedQty = (sv.valuedQty ?? 0) + ts;
      sv.valuedValue = (sv.valuedValue ?? 0n) + vs;
      const c = valuation({ movementId: sourceId, kind: "sale_completion", reason: sv.reason, occurredOn: sv.occurredOn, qty: ts, value: vs, knownQty: ts, unknownQty: 0, deficitQty: 0, orderId: sv.orderId, after: null });
      effect(c.id, outflowCategory(sv.reason, sv.orderId), -vs, sv.occurredOn, sv.orderId, "completion");
    }
  }
  /** Вихід q (§6.3): невідомі шари FIFO → відомий пул за середньою → дефіцитний шар без вартості. */
  const outflow = (m: { id: string; date: string; qty: number }, reason: string, orderId: string | null): CostValuation => {
    let rem = m.qty;
    let unknownTaken = 0;
    for (const l of open("unknown")) {
      if (rem === 0) break;
      const t = Math.min(rem, l.qtyOpen);
      l.qtyOpen -= t;
      unknownTaken += t;
      rem -= t;
    }
    const before = pool.knownQty;
    const k = Math.min(rem, pool.knownQty);
    const value = k === 0 ? 0n : k === pool.knownQty ? pool.knownValue : mulDiv(pool.knownValue, BigInt(k), BigInt(pool.knownQty));
    pool.knownQty -= k;
    pool.knownValue -= value;
    rem -= k;
    onHand -= m.qty;
    const v = valuation({
      movementId: m.id,
      kind: "outflow",
      reason,
      occurredOn: m.date,
      qty: m.qty,
      value,
      knownQty: k,
      unknownQty: unknownTaken,
      deficitQty: rem,
      orderId,
      after: null,
      poolBefore: before,
      poolAfter: pool.knownQty,
      pendUnknown: unknownTaken,
      pendDeficit: rem,
      valuedQty: k,
      valuedValue: value,
      returnedValuedQty: 0,
      returnedValuedValue: 0n,
    });
    if (rem > 0) addLayer({ kind: "deficit", reason: "deficit", qtyIn: rem, saleValuationId: v.id, from: null });
    v.after = snapshot();
    return v;
  };

  for (const m of movements) {
    switch (m.kind) {
      case "opening": {
        onHand += m.qty;
        addLayer({ kind: "unknown", reason: "opening", qtyIn: m.qty, saleValuationId: null, from: null });
        valuation({ movementId: m.id, kind: "inflow", reason: "opening", occurredOn: m.date, qty: m.qty, value: 0n, knownQty: 0, unknownQty: m.qty, deficitQty: 0, orderId: null });
        break;
      }
      case "receipt": {
        const g = m.good;
        const f = m.defect ?? 0;
        onHand += g;
        if (m.unitCost === null) {
          // Без ціни: закриває дефіцит за кількістю без вартості; решта — шар receipt_without_cost.
          let rem = g;
          for (const l of open("deficit")) {
            if (rem === 0) break;
            const t = Math.min(rem, l.qtyOpen);
            l.qtyOpen -= t;
            rem -= t;
            const sv = valuations.find((v) => v.id === l.saleValuationId)!;
            sv.pendDeficit = (sv.pendDeficit ?? 0) - t;
            sv.pendUnknown = (sv.pendUnknown ?? 0) + t;
            for (const rl of layers) if (rl.saleValuationId === sv.id && rl.reason === "return_without_cost" && rl.from === "deficit") rl.from = "unknown";
          }
          if (rem > 0) addLayer({ kind: "unknown", reason: "receipt_without_cost", qtyIn: rem, saleValuationId: null, from: null });
          valuation({ movementId: m.id, kind: "inflow", reason: "receipt_without_cost", occurredOn: m.date, qty: g, value: 0n, knownQty: 0, unknownQty: rem, deficitQty: 0, orderId: null, good: g, deficitClosed: g - rem, postedValue: 0n, adjustments: 0n });
          break;
        }
        const gross = cents(m.unitCost) * BigInt(g + f);
        const V = m.currency && m.currency !== currency ? convert(gross, m.currency, currency, m.date, opts.ctx ?? { rates: [] }) : gross;
        if (V === null) {
          // Немає курсу → шар fx_pending (завершення курсом — поза моделлю).
          if (g > 0) addLayer({ kind: "unknown", reason: "fx_pending", qtyIn: g, saleValuationId: null, from: null });
          valuation({ movementId: m.id, kind: "inflow", reason: "fx_pending", occurredOn: m.date, qty: g, value: 0n, knownQty: 0, unknownQty: g, deficitQty: 0, orderId: null });
          break;
        }
        let closed = { closedQty: 0, closedValue: 0n };
        let lossValue = 0n;
        if (g === 0) {
          if (pool.knownQty > 0) pool.knownValue += V;
          else lossValue = V;
        } else closed = inflowToPool(g, V, m.date, m.id);
        const v = valuation({ movementId: m.id, kind: "inflow", reason: "receipt", occurredOn: m.date, qty: g, value: V, knownQty: g, unknownQty: 0, deficitQty: 0, orderId: null, good: g, deficitClosed: closed.closedQty, postedValue: V, adjustments: 0n });
        const memo: RefCategory = opts.itemKind === "material" && m.source === "purchase" ? "materials_purchased_memo" : "production_capitalized_memo";
        effect(v.id, memo, V, m.date, null, m.source ?? "production");
        if (lossValue !== 0n) effect(v.id, "inventory_loss", -lossValue, m.date, null, "production_defect");
        break;
      }
      case "outflow": {
        const v = outflow(m, m.reason, m.orderId ?? null);
        const cat = outflowCategory(m.reason, m.orderId ?? null);
        effect(v.id, cat, -v.value, m.date, cat === "inventory_loss" || cat === "packaging_unlinked" ? null : (m.orderId ?? null), m.reason === "test_sale" ? "test_order" : m.reason);
        if (m.reason === "defect_mark") {
          addLayer({ kind: "defect", reason: "defect_mark", qtyIn: m.qty, valueOpen: v.value, saleValuationId: null, from: null });
        }
        break;
      }
      case "defect_mark_return": {
        // Пошкоджені повернені одиниці увійшли за нулем і виходять за нулем — пул не змінюється.
        addLayer({ kind: "defect", reason: "defect_mark", qtyIn: m.qty, valueOpen: 0n, saleValuationId: null, from: null });
        break;
      }
      case "defect_writeoff": {
        let rem = m.qty;
        for (const l of open("defect")) {
          if (rem === 0) break;
          const t = Math.min(rem, l.qtyOpen);
          l.valueOpen -= t === l.qtyOpen ? l.valueOpen : mulDiv(l.valueOpen, BigInt(t), BigInt(l.qtyOpen));
          l.qtyOpen -= t;
          rem -= t;
        }
        break;
      }
      case "defect_repair": {
        let rem = m.qty;
        let value = 0n;
        for (const l of open("defect")) {
          if (rem === 0) break;
          const t = Math.min(rem, l.qtyOpen);
          const v = t === l.qtyOpen ? l.valueOpen : mulDiv(l.valueOpen, BigInt(t), BigInt(l.qtyOpen));
          l.valueOpen -= v;
          l.qtyOpen -= t;
          value += v;
          rem -= t;
        }
        onHand += m.qty;
        inflowToPool(m.qty, value, m.date, m.id);
        const v = valuation({ movementId: m.id, kind: "inflow", reason: "defect_repair", occurredOn: m.date, qty: m.qty, value, knownQty: m.qty, unknownQty: 0, deficitQty: 0, orderId: null });
        effect(v.id, "inventory_gain", value, m.date, null, "defect_repair");
        break;
      }
      case "surplus": {
        onHand += m.qty;
        if (pool.knownQty > 0) {
          const value = mulDiv(pool.knownValue, BigInt(m.qty), BigInt(pool.knownQty));
          inflowToPool(m.qty, value, m.date, m.id);
          const v = valuation({ movementId: m.id, kind: "inflow", reason: "surplus", occurredOn: m.date, qty: m.qty, value, knownQty: m.qty, unknownQty: 0, deficitQty: 0, orderId: null });
          effect(v.id, "inventory_gain", value, m.date, null, "surplus");
        } else {
          let rem = m.qty;
          for (const l of open("deficit")) {
            if (rem === 0) break;
            const t = Math.min(rem, l.qtyOpen);
            l.qtyOpen -= t;
            rem -= t;
            const sv = valuations.find((v) => v.id === l.saleValuationId)!;
            sv.pendDeficit = (sv.pendDeficit ?? 0) - t;
            sv.pendUnknown = (sv.pendUnknown ?? 0) + t;
          }
          if (rem > 0) addLayer({ kind: "unknown", reason: "surplus_without_cost", qtyIn: rem, saleValuationId: null, from: null });
          valuation({ movementId: m.id, kind: "inflow", reason: "surplus_without_cost", occurredOn: m.date, qty: m.qty, value: 0n, knownQty: 0, unknownQty: rem, deficitQty: 0, orderId: null });
        }
        break;
      }
      case "customer_return": {
        // Обидва записи етапу 5 нормалізуються однаково: придатні g оцінюються, пошкоджені — нуль, пул не змінюють.
        const g = m.good;
        let rem = g;
        let value = 0n;
        onHand += g;
        const sales = valuations.filter((v) => v.kind === "outflow" && v.reason === "sale" && v.orderId === m.orderId);
        // (1а) одиниці продажу з відомою вартістю (за їхньою вартістю).
        for (const sv of sales) {
          if (rem === 0) break;
          const avail = (sv.valuedQty ?? 0) - (sv.returnedValuedQty ?? 0);
          const t = Math.min(rem, avail);
          if (t <= 0) continue;
          const remainingValue = (sv.valuedValue ?? 0n) - (sv.returnedValuedValue ?? 0n);
          const v = t === avail ? remainingValue : mulDiv(remainingValue, BigInt(t), BigInt(avail));
          sv.returnedValuedQty = (sv.returnedValuedQty ?? 0) + t;
          sv.returnedValuedValue = (sv.returnedValuedValue ?? 0n) + v;
          value += v;
          rem -= t;
        }
        const knownReturned = g - rem;
        // (1б) одиниці продажу без вартості → шар return_without_cost, пов'язаний із продажем.
        let unknownReturned = 0;
        for (const sv of sales) {
          for (const from of ["unknown", "deficit"] as const) {
            if (rem === 0) break;
            const key = from === "unknown" ? "pendUnknown" : "pendDeficit";
            const avail = sv[key] ?? 0;
            const t = Math.min(rem, avail);
            if (t <= 0) continue;
            sv[key] = avail - t;
            addLayer({ kind: "unknown", reason: "return_without_cost", qtyIn: t, saleValuationId: sv.id, from });
            unknownReturned += t;
            rem -= t;
          }
        }
        // (2) ручна собівартість рядків замовлення (stdcogs), (3) середня пулу, (4) шар без вартості.
        let stdValue = 0n;
        let stdQty = 0;
        const std = opts.orderStandards?.[m.orderId];
        if (rem > 0 && std) {
          stdValue = cents(std) * BigInt(rem);
          stdQty = rem;
          rem = 0;
        }
        let avgValue = 0n;
        let avgQty = 0;
        if (rem > 0 && pool.knownQty > 0) {
          avgValue = mulDiv(pool.knownValue, BigInt(rem), BigInt(pool.knownQty));
          avgQty = rem;
          rem = 0;
        }
        if (rem > 0) {
          addLayer({ kind: "unknown", reason: "return_without_cost", qtyIn: rem, saleValuationId: null, from: null });
          unknownReturned += rem;
        }
        const valuedQty = knownReturned + stdQty + avgQty;
        const total = value + stdValue + avgValue;
        if (valuedQty > 0) inflowToPool(valuedQty, total, m.date, m.id);
        const v = valuation({ movementId: m.id, kind: "inflow", reason: "customer_return", occurredOn: m.date, qty: g, value: total, knownQty: valuedQty, unknownQty: unknownReturned, deficitQty: 0, orderId: m.orderId });
        effect(v.id, "cogs_return", total, m.date, m.orderId, "customer_return");
        // Запис без розділення: пошкоджені одразу в брак (шар defect з нульовою вартістю); із розділенням той самий шар
        // створює парний рух defect_mark_return.
        if ((m.damaged ?? 0) > 0 && m.record !== "split") addLayer({ kind: "defect", reason: "return_defect", qtyIn: m.damaged!, valueOpen: 0n, saleValuationId: null, from: null });
        break;
      }
      case "completion": {
        const unit = cents(m.unitCost);
        if (m.toSold) {
          for (const sv of valuations.filter((v) => v.kind === "outflow" && v.occurredOn >= m.effectiveFrom)) {
            const sold = sv.pendUnknown ?? 0;
            const ret = layers.filter((l) => l.reason === "return_without_cost" && l.saleValuationId === sv.id && l.from === "unknown" && l.qtyOpen > 0).reduce((a, l) => a + l.qtyOpen, 0);
            const n = sold + ret;
            if (n > 0) completeSaleUnits(sv.id, n, unit * BigInt(n), "unknown", m.date, m.id);
          }
        }
        if (m.toStock) {
          let qty = 0;
          for (const l of open("unknown")) {
            if (l.reason === "fx_pending") continue;
            qty += l.qtyOpen;
            l.qtyOpen = 0;
          }
          if (qty > 0) {
            pool.knownQty += qty;
            pool.knownValue += unit * BigInt(qty);
            valuation({ movementId: m.id, kind: "stock_completion", reason: "owner_standard", occurredOn: m.date, qty, value: unit * BigInt(qty), knownQty: qty, unknownQty: 0, deficitQty: 0, orderId: null });
          }
        }
        break;
      }
      case "revalue": {
        revalue(m);
        break;
      }
    }
    checkC0(m.id);
  }

  function revalue(m: Extract<CostMovement, { kind: "revalue" }>) {
    const rv = valuations.find((v) => v.movementId === m.receiptId && v.kind === "inflow" && v.reason === "receipt");
    if (!rv) throw new Error(`reference: receipt ${m.receiptId} not valued`);
    const delta = cents(m.target) - ((rv.postedValue ?? 0n) + (rv.adjustments ?? 0n));
    if (delta === 0n) return;
    const g = rv.good ?? 0;
    const s = rv.deficitClosed ?? 0;
    const dDef = g > 0 && s > 0 ? mulDiv(delta, BigInt(s), BigInt(g)) : 0n;
    const dPool = delta - dDef;
    // Частка, що лишилася на складі: r = Π (after / before) виходів з відомого пулу після надходження.
    let r: Rational = R_ONE;
    const shares = new Map<string, Rational>();
    for (const ov of valuations) {
      if (ov.seq <= rv.seq || ov.kind !== "outflow" || !ov.poolBefore) continue;
      const factor = rational(BigInt(ov.poolAfter ?? 0), BigInt(ov.poolBefore));
      const share = rMul(r, rSub(R_ONE, factor));
      const cat = outflowCategory(ov.reason, ov.orderId) === "cogs" ? "cogs_adjustment" : "inventory_loss";
      shares.set(cat, rAdd(shares.get(cat) ?? R_ZERO, share));
      r = rMul(r, factor);
    }
    let dStock = pool.knownQty === 0 ? 0n : mulDiv(dPool, r.num, r.den);
    if (pool.knownValue + dStock < 0n) dStock = -pool.knownValue;
    const rest = dPool - dStock;
    const cats = [...shares.keys()].sort();
    const v = valuation({ movementId: m.id, kind: "revaluation", reason: "batch_cost_change", occurredOn: m.date, qty: 0, value: dStock, knownQty: 0, unknownQty: 0, deficitQty: 0, orderId: null, after: null });
    pool.knownValue += dStock;
    v.after = snapshot();
    rv.adjustments = (rv.adjustments ?? 0n) + delta;
    if (rest !== 0n) {
      const lcd = cats.reduce((a, c) => a * shares.get(c)!.den, 1n);
      const weights = cats.map((c) => (shares.get(c)!.num * lcd) / shares.get(c)!.den);
      if (weights.some((w) => w > 0n)) {
        const parts = allocate(rest, weights);
        cats.forEach((c, i) => effect(v.id, c as RefCategory, -parts[i]!, m.date, null, "batch_adjustment"));
      } else effect(v.id, "inventory_loss", -rest, m.date, null, "batch_adjustment_rounding");
    }
    if (dDef !== 0n) effect(v.id, "cogs_adjustment", -dDef, m.date, null, "batch_adjustment_deficit");
  }

  return { state: snapshot(), onHand, layers, valuations, effects };
}

/** Ціль рядків партії (§6.7 п. 1): unit_cost × produced + частка extra за allocate (ваги produced); Σ = producedTotal. */
export function batchLineTargets(lines: ReadonlyArray<{ unitCost: string; produced: number }>, extraCost: string): Cents[] {
  const extra = cents(extraCost);
  const parts = extra !== 0n && lines.some((l) => l.produced > 0) ? allocate(extra, lines.map((l) => BigInt(l.produced))) : lines.map(() => 0n);
  return lines.map((l, i) => cents(l.unitCost) * BigInt(l.produced) + parts[i]!);
}

/** Ціль рядка ділиться між його надходженнями за кількістю (якісні + брак). */
export function splitTargetByReceipts(target: Cents, receiptQtys: readonly number[]): Cents[] {
  return allocate(target, receiptQtys.map((q) => BigInt(q)));
}

/**
 * Вартість запасів на дату D (§6.7, G18): стан після ОСТАННЬОЇ за seq оцінки, що змінює пул (inflow, outflow,
 * revaluation, stock_completion), з occurred_on ≤ D; sale_completion пропускається.
 */
export function stockValueAt(valuations: readonly CostValuation[], date: string): { knownValue: string; knownQty: number; unknownQty: number; deficitQty: number } {
  const last = valuations.filter((v) => v.kind !== "sale_completion" && v.occurredOn <= date && v.after).sort((a, b) => b.seq - a.seq)[0];
  if (!last || !last.after) return { knownValue: "0.00", knownQty: 0, unknownQty: 0, deficitQty: 0 };
  return { knownValue: str(last.after.knownValue), knownQty: last.after.knownQty, unknownQty: last.after.unknownQty, deficitQty: last.after.deficitQty };
}

/** Σ наслідків рушія за категорією (зі знаком впливу). */
export function effectTotals(effects: readonly CostEffect[]): Partial<Record<RefCategory, string>> {
  const acc = new Map<RefCategory, Cents>();
  for (const e of effects) acc.set(e.category, (acc.get(e.category) ?? 0n) + e.amount);
  return Object.fromEntries([...acc.entries()].map(([k, v]) => [k, str(v)]));
}

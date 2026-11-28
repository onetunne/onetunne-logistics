/**
 * Етап 6, WP2: ЧИСТИЙ рушій собівартості — ковзна середньозважена (MWA) на (склад, позиція) у валюті оцінки
 * (docs/stage6-design.md §6.1–§6.3). Без БД і без React: усі дані (вартість руху, курс, ручна собівартість, джерела
 * повернення) готує шар БД (hook.server.ts / inputs.server.ts) і передає в `step()`.
 *
 * Правила:
 * - стан пулу: known_qty / known_value (відомі), unknown_qty (Σ відкритих невідомих шарів), deficit_qty (від'ємний
 *   залишок); C0: on_hand = known + unknown − deficit (перевіряє шар БД);
 * - вартість k відомих одиниць: k = known_qty ? known_value : mulDivHalfAwayFromZero(known_value, k, known_qty) —
 *   остання одиниця бере точну решту (Σ витрат = Σ надходжень);
 * - вихід q: (1) невідомі шари FIFO (за ручною собівартістю / каталожною ціною, якщо вона є на дату руху, — owner_standard /
 *   catalogue, інакше без вартості, drawn_layers); (2) відомий пул за середньою; (3) решта → дефіцитний шар (без вартості);
 * - вхід з відомою вартістю спершу закриває дефіцитні шари FIFO (вартість частки — до завершення тих продажів, R3), решта —
 *   у пул; вхід без вартості закриває дефіцит лише кількістю (ті продажі лишаються без вартості);
 * - fx_pending і return_without_cost — невідомі шари, що дефіцитів НЕ закривають (їхня вартість ще надійде);
 * - брак (defective) і in_production вартості не мають; шари `defect` — поза on_hand (вартість, визнана збитком, що може
 *   повернутися ремонтом);
 * - НІКОЛИ не кидає виняток через відсутні дані: невідома вартість — це стан (null), а не нуль.
 * Округлення — половина від нуля, BigInt (app/lib/decimal.ts); гроші — мінорні одиниці (соті частки).
 */
import type { CostLayerKind, CostLayerReason, ValuationKind, ValuationValueSource } from "~/domain/finance";
import { allocateMinor, minorDigits, mulDivHalfAwayFromZero, scaledToDecimal } from "~/lib/decimal";
import type { MovementType } from "~/modules/inventory/movement-types";

// ---------------------------------------------------------------------------
// Типи
// ---------------------------------------------------------------------------

export interface PoolState {
  /** Валюта оцінки (finance.valuationCurrency, типово UAH). */
  currency: string;
  knownQty: number;
  /** Мінорні одиниці (соті частки), ≥ 0. */
  knownValue: bigint;
  unknownQty: number;
  deficitQty: number;
  /** Остання відома середня за одиницю (десятковий рядок до 10 знаків) — прогноз дефіциту; null — ще не було. */
  lastAvgUnit: string | null;
  /** seq останнього оціненого руху. */
  lastSeq: number;
}

export interface CostLayer {
  id: string;
  kind: CostLayerKind;
  reason: CostLayerReason;
  qtyIn: number;
  qtyOpen: number;
  /** Лише defect: вартість, визнана збитком, що ще може повернутися ремонтом (мінорні одиниці). */
  valueOpen: bigint | null;
  /** Лише fx_pending: початкова ціна одиниці й валюта. */
  pendingUnitCost: string | null;
  pendingCurrency: string | null;
  /** return_without_cost: оцінка продажу, з якого повернуто. */
  sourceValuationId: string | null;
  /** Оцінка, що створила шар. */
  originValuationId: string | null;
  createdSeq: number;
  /** Шар закрито: дефіцит/брак — qty_open = 0; невідомий — вартість визначено (завершено). */
  closed: boolean;
}

export interface DrawnLayer {
  layerId: string;
  qty: number;
}

export interface StepMovement {
  id: string;
  seq: number;
  type: MovementType;
  idempotencyKey: string;
  stockKind: "product" | "material";
  onHandDelta: number;
  defectiveDelta: number;
  orderId: string | null;
  orderLineItemId: string | null;
  productionBatchId: string | null;
  reason: string | null;
  /** Дата руху (Київ, YYYY-MM-DD). */
  occurredOn: string;
}

/** Вартість руху (unit_cost × (якісні + брак)), уже конвертована у валюту оцінки. */
export type MovementValueInput =
  | { status: "valued"; minor: bigint; originalAmount: string; originalCurrency: string; rateDate: string | null; rateSource: string | null }
  /** Валюта руху ≠ валюта оцінки, курсу на дату руху немає → шар fx_pending. */
  | { status: "no_rate"; originalAmount: string; originalCurrency: string; unitCost: string }
  /** Рух без unit_cost. */
  | { status: "none" };

/** Ручна собівартість власника (товар) або каталожна ціна (матеріал) на дату руху, у валюті оцінки. */
export interface StandardUnit {
  minor: bigint;
  source: "owner_standard" | "catalogue";
  costId: string | null;
}

/** Оцінка consume_sale замовлення (повернення прив'язане до замовлення й товару): ще не повернене. */
export interface SaleSource {
  valuationId: string;
  /** Одиниці з відомою вартістю (зокрема завершені), ще не повернені. */
  knownUnits: number;
  knownValue: bigint;
  /** Одиниці без вартості чи дефіцитні, ще не завершені й не повернені. */
  unvaluedUnits: number;
}

/** Запис stdcogs позиції товару в замовленні (ручна собівартість для позиції без списання, §6.5): ще не повернене. */
export interface StandardSource {
  entryId: string;
  unitMinor: bigint;
  qty: number;
}

export interface ReturnSources {
  /** Кількість парного руху `<ключ надходження>:return_defect` (null — пари немає: брак = defective_delta надходження). */
  pairedDefectQty: number | null;
  sales: SaleSource[];
  standards: StandardSource[];
}

export interface StepInputs {
  /** Id рядка оцінки цього руху (шари посилаються на нього). */
  valuationId: string;
  /** Генератор id нових шарів. */
  newId: () => string;
  value: MovementValueInput;
  standard: StandardUnit | null;
  returnSources?: ReturnSources;
  /** defect_mark з ключем `…:return_defect` у парі з надходженням-поверненням (одиниці увійшли за нулем). */
  pairedReturnDefect?: boolean;
}

/** Вид збитку (details.kind запису inventory_loss). */
export type LossKind = "defect" | "shortage" | "shopify_external" | "production_defect" | "opening_correction" | "transfer";

/** Фінансові наслідки руху БЕЗ замовлення (проводить шар БД одразу, ключ val:<valuationId>). */
export type CostEffect =
  | { type: "inventory_loss"; minor: bigint; lossKind: LossKind }
  | { type: "inventory_gain"; minor: bigint; gainKind: "repair" | "surplus" }
  | { type: "production_capitalized_memo"; minor: bigint; source: "production" | "purchase" }
  | { type: "materials_purchased_memo"; minor: bigint }
  | { type: "packaging_unlinked"; minor: bigint }
  /** Придатне повернення без замовлення — за середньою (cogs_return без order_id). */
  | { type: "cogs_return_unlinked"; minor: bigint };

/** Закриття дефіцитного шару входом: s одиниць тих продажів отримують вартість (null — закрито без вартості). */
export interface DeficitCompletion {
  layerId: string;
  saleValuationId: string | null;
  qty: number;
  minor: bigint | null;
}

export interface ReturnAllocation {
  saleValuationId: string;
  knownQty: number;
  knownValue: bigint;
  unvaluedQty: number;
}

export interface StandardAllocation {
  entryId: string;
  qty: number;
  value: bigint;
}

/** Наслідок для фінансів, записаний в оцінці (для пізніших завершень і коригувань). */
export type ValuationEffect = "order" | "loss" | "packaging_unlinked" | "gain" | "none";

export type DetailValue = string | number | boolean | null | string[];

export interface ValuationDraft {
  id: string;
  kind: ValuationKind;
  qty: number;
  /** Одиниці з відомою вартістю (пул + ручна собівартість). */
  knownQty: number;
  unknownQty: number;
  deficitQty: number;
  /** Відома частина вартості (null — невідомо; 0 — відомий нуль). */
  value: bigint | null;
  valueSource: ValuationValueSource;
  drawnLayers: DrawnLayer[];
  originalAmount: string | null;
  originalCurrency: string | null;
  rateDate: string | null;
  rateSource: string | null;
  after: { knownQty: number; knownValue: bigint; unknownQty: number; deficitQty: number };
  details: Record<string, DetailValue>;
}

export interface StepResult {
  state: PoolState;
  /** Усі шари після кроку (відкриті й щойно закриті). */
  layers: CostLayer[];
  createdLayerIds: string[];
  touchedLayerIds: string[];
  /** null — рух не змінює вартості (резерв, запуск виробництва…). */
  valuation: ValuationDraft | null;
  effects: CostEffect[];
  deficitCompletions: DeficitCompletion[];
  returnAllocations: ReturnAllocation[];
  standardAllocations: StandardAllocation[];
}

// ---------------------------------------------------------------------------
// Допоміжні (експортовані — їх використовують сервіси завершень і коригувань)
// ---------------------------------------------------------------------------

/**
 * Квант валюти оцінки в сотих частках: 1 (2 знаки, UAH/EUR) або 100 (0 знаків, JPY/KRW — суми лише в цілих одиницях,
 * §5.1). Кожна частка, яку рахує рушій, кратна кванту: інакше запис журналу з дробовими єнами відхилило б ядро, і
 * складська операція впала б (рушій НІКОЛИ не блокує рухи).
 */
export function currencyQuantum(currency: string): bigint {
  return minorDigits(currency) === 0 ? 100n : 1n;
}

/** a × num / den, округлене (половина від нуля) одним кроком до кратного кванта q. */
export function mulDivQ(a: bigint, num: bigint, den: bigint, q: bigint = 1n): bigint {
  if (q === 1n) return mulDivHalfAwayFromZero(a, num, den);
  return mulDivHalfAwayFromZero(a, num, den * q) * q;
}

/** Сума в сотих → найближче кратне кванта (половина від нуля). */
export function roundToQuantum(a: bigint, q: bigint = 1n): bigint {
  return q === 1n ? a : mulDivQ(a, 1n, 1n, q);
}

/**
 * Розподіл суми за вагами методом найбільших остач у квантах (Σ частин = total точно). Сума, не кратна кванту
 * (не буває для значень рушія), — остача додається до першої частини з ненульовою вагою.
 */
export function allocateQ(total: bigint, weights: readonly bigint[], q: bigint = 1n): bigint[] {
  if (q === 1n) return allocateMinor(total, weights);
  const units = total / q;
  const parts = allocateMinor(units, weights).map((x) => x * q);
  const rest = total - units * q;
  if (rest !== 0n) {
    const i = weights.findIndex((w) => w > 0n);
    parts[i < 0 ? 0 : i]! += rest;
  }
  return parts;
}

/** Вартість k з n відомих одиниць пулу вартістю v (остання одиниця бере точну решту); частки кратні кванту q. */
export function valueOfUnits(v: bigint, k: number, n: number, q: bigint = 1n): bigint {
  if (k <= 0 || n <= 0) return 0n;
  if (k >= n) return v;
  return mulDivQ(v, BigInt(k), BigInt(n), q);
}

/** Середня за одиницю у вигляді numeric(20,10) (гривні, не копійки): v (соті) / n. */
export function averageUnit(v: bigint, n: number): string | null {
  if (n <= 0) return null;
  // v соті × 10^8 / n = гривні × 10^10.
  return scaledToDecimal(mulDivHalfAwayFromZero(v, 100_000_000n, BigInt(n)), 10);
}

/** Середня за одиницю, округлена до копійки (для таблиць; точна середня — averageUnit). */
export function centsAverage(valueMinor: bigint, qty: number): string | null {
  if (qty <= 0) return null;
  const avg = averageUnit(valueMinor, qty)!;
  const [int, frac = ""] = avg.split(".");
  const padded = (frac + "000").slice(0, 3);
  const cents = BigInt(int!.replace("-", "")) * 100n + BigInt(padded.slice(0, 2)) + (Number(padded[2]) >= 5 ? 1n : 0n);
  return minorToDecimal(avg.startsWith("-") ? -cents : cents);
}

/** Мінорні одиниці (соті) → десятковий рядок з 2 знаками. */
export function minorToDecimal(v: bigint): string {
  return scaledToDecimal(v, 2, 2);
}

/**
 * Розподіл суми між послідовними частинами (кумулятивно: Σ частин = total точно, без накопичення похибки):
 * частина i = round(total × cum_i / n) − round(total × cum_{i−1} / n).
 */
export function cumulativeShares(total: bigint, parts: readonly number[], n: number, q: bigint = 1n): bigint[] {
  const out: bigint[] = [];
  let cum = 0;
  let prev = 0n;
  for (const p of parts) {
    cum += p;
    const upTo = cum >= n ? total : mulDivQ(total, BigInt(cum), BigInt(n), q);
    out.push(upTo - prev);
    prev = upTo;
  }
  return out;
}

const UNKNOWN_KIND: CostLayerKind = "unknown";
/** Невідомі шари, що НЕ закривають дефіцитів (їхня справжня вартість ще надійде). */
const NON_CLOSING_REASONS: ReadonlySet<CostLayerReason> = new Set<CostLayerReason>(["fx_pending", "return_without_cost"]);
/** Невідомі шари, до яких ручна собівартість НЕ застосовується (справжня вартість надійде з курсом, D-20). */
export const STANDARD_EXCLUDED_REASONS: ReadonlySet<CostLayerReason> = new Set<CostLayerReason>(["fx_pending"]);

const byFifo = (a: CostLayer, b: CostLayer) => a.createdSeq - b.createdSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// ---------------------------------------------------------------------------
// Робочий контекст кроку
// ---------------------------------------------------------------------------

class Work {
  readonly state: PoolState;
  readonly layers: CostLayer[];
  readonly created: string[] = [];
  readonly touched = new Set<string>();
  readonly effects: CostEffect[] = [];
  readonly deficitCompletions: DeficitCompletion[] = [];
  readonly returnAllocations: ReturnAllocation[] = [];
  readonly standardAllocations: StandardAllocation[] = [];

  /** Квант валюти оцінки (1 або 100 сотих). */
  readonly q: bigint;

  constructor(
    state: PoolState,
    layers: readonly CostLayer[],
    readonly m: StepMovement,
    readonly inputs: StepInputs,
  ) {
    this.state = { ...state };
    this.layers = layers.map((l) => ({ ...l }));
    this.q = currencyQuantum(state.currency);
  }

  open(kind: CostLayerKind, filter?: (l: CostLayer) => boolean): CostLayer[] {
    return this.layers.filter((l) => l.kind === kind && l.qtyOpen > 0 && !l.closed && (!filter || filter(l))).sort(byFifo);
  }

  /**
   * Позначає зміну шару. Дефіцитний і бракований шар закриваються, щойно qty_open = 0; невідомий — НІ: його витрачені
   * одиниці ще чекають вартості (завершення курсом / партією / ручною собівартістю), closed_at = «вартість визначено».
   */
  touch(l: CostLayer): void {
    if (l.qtyOpen === 0 && l.kind !== "unknown") l.closed = true;
    this.touched.add(l.id);
  }

  newLayer(kind: CostLayerKind, reason: CostLayerReason, qty: number, extra: Partial<CostLayer> = {}): CostLayer {
    const layer: CostLayer = {
      id: this.inputs.newId(),
      kind,
      reason,
      qtyIn: qty,
      qtyOpen: qty,
      valueOpen: null,
      pendingUnitCost: null,
      pendingCurrency: null,
      sourceValuationId: null,
      originValuationId: this.inputs.valuationId,
      createdSeq: this.m.seq,
      closed: false,
      ...extra,
    };
    this.layers.push(layer);
    this.created.push(layer.id);
    return layer;
  }

  /** Вхід n одиниць вартістю v: спершу закриває дефіцит FIFO (частки — завершення продажів), решта — у пул. */
  inflowValued(n: number, v: bigint): { closedQty: number; closedValue: bigint } {
    if (n <= 0) return { closedQty: 0, closedValue: 0n };
    let remaining = n;
    const deficits = this.open("deficit");
    const parts: Array<{ layer: CostLayer; s: number }> = [];
    for (const d of deficits) {
      if (remaining === 0) break;
      const s = Math.min(d.qtyOpen, remaining);
      parts.push({ layer: d, s });
      remaining -= s;
    }
    const shares = cumulativeShares(v, [...parts.map((p) => p.s), remaining], n, this.q);
    let closedQty = 0;
    let closedValue = 0n;
    parts.forEach((p, i) => {
      const value = shares[i]!;
      p.layer.qtyOpen -= p.s;
      this.touch(p.layer);
      this.state.deficitQty -= p.s;
      closedQty += p.s;
      closedValue += value;
      this.deficitCompletions.push({ layerId: p.layer.id, saleValuationId: p.layer.originValuationId, qty: p.s, minor: value });
    });
    this.state.knownQty += remaining;
    this.state.knownValue += shares[shares.length - 1]!;
    return { closedQty, closedValue };
  }

  /** Вхід n одиниць без вартості: закриває дефіцит кількістю (без вартості), решта — невідомий шар `reason`. */
  inflowUnknown(n: number, reason: CostLayerReason, extra: Partial<CostLayer> = {}): { closedQty: number; layerQty: number } {
    if (n <= 0) return { closedQty: 0, layerQty: 0 };
    let remaining = n;
    let closedQty = 0;
    if (!NON_CLOSING_REASONS.has(reason)) {
      for (const d of this.open("deficit")) {
        if (remaining === 0) break;
        const s = Math.min(d.qtyOpen, remaining);
        d.qtyOpen -= s;
        this.touch(d);
        this.state.deficitQty -= s;
        closedQty += s;
        remaining -= s;
        this.deficitCompletions.push({ layerId: d.id, saleValuationId: d.originValuationId, qty: s, minor: null });
      }
    }
    if (remaining > 0) {
      this.newLayer(UNKNOWN_KIND, reason, remaining, extra);
      this.state.unknownQty += remaining;
    }
    return { closedQty, layerQty: remaining };
  }

  /**
   * Вихід q: невідомі шари FIFO (за ручною собівартістю, якщо є), відомий пул за середньою, решта — дефіцит.
   */
  outflow(q: number): {
    poolQty: number;
    poolValue: bigint;
    standardQty: number;
    standardValue: bigint;
    drawn: DrawnLayer[];
    deficitQty: number;
  } {
    let remaining = q;
    const drawn: DrawnLayer[] = [];
    let standardQty = 0;
    let standardValue = 0n;
    const std = this.inputs.standard;
    for (const l of this.open(UNKNOWN_KIND)) {
      if (remaining === 0) break;
      const t = Math.min(l.qtyOpen, remaining);
      l.qtyOpen -= t;
      this.touch(l);
      this.state.unknownQty -= t;
      remaining -= t;
      if (std && !STANDARD_EXCLUDED_REASONS.has(l.reason)) {
        standardQty += t;
        standardValue += std.minor * BigInt(t);
      } else {
        drawn.push({ layerId: l.id, qty: t });
      }
    }
    const k = Math.min(this.state.knownQty, remaining);
    const poolValue = valueOfUnits(this.state.knownValue, k, this.state.knownQty, this.q);
    this.state.knownQty -= k;
    this.state.knownValue -= poolValue;
    remaining -= k;
    if (remaining > 0) {
      this.newLayer("deficit", "deficit", remaining);
      this.state.deficitQty += remaining;
    }
    return { poolQty: k, poolValue, standardQty, standardValue, drawn, deficitQty: remaining };
  }

  after() {
    return {
      knownQty: this.state.knownQty,
      knownValue: this.state.knownValue,
      unknownQty: this.state.unknownQty,
      deficitQty: this.state.deficitQty,
    };
  }
}

// ---------------------------------------------------------------------------
// Крок
// ---------------------------------------------------------------------------

/** Рухи без впливу на вартість (резерви, виробництво в процесі). */
const NO_VALUE_TYPES: ReadonlySet<MovementType> = new Set<MovementType>(["reserve", "release", "production_start", "production_close"]);

/** Ключ парного руху браку повернення (modules/warehouse/operations.server.ts RETURN_DEFECT_KEY_SUFFIX). */
export const RETURN_DEFECT_SUFFIX = ":return_defect";

export function isCustomerReturn(m: Pick<StepMovement, "type" | "reason">): boolean {
  return m.type === "receipt_manual" && m.reason === "customer_return";
}

function baseDetails(m: StepMovement, effect: ValuationEffect): Record<string, DetailValue> {
  return { movementType: m.type, effect, ...(m.reason ? { reasonCode: m.reason } : {}) };
}

/**
 * Один крок оцінки руху. Повертає новий стан, шари, рядок оцінки, наслідки без замовлення й завершення дефіцитів.
 * Чиста функція: вхідні state/layers не змінюються.
 */
export function step(state: PoolState, layers: readonly CostLayer[], m: StepMovement, inputs: StepInputs): StepResult {
  const w = new Work(state, layers, m, inputs);
  const valuation = NO_VALUE_TYPES.has(m.type) ? null : valueMovement(w);
  w.state.lastSeq = Math.max(w.state.lastSeq, m.seq);
  if (w.state.knownQty > 0) w.state.lastAvgUnit = averageUnit(w.state.knownValue, w.state.knownQty);
  if (valuation) valuation.after = w.after();
  return {
    state: w.state,
    layers: w.layers,
    createdLayerIds: w.created,
    touchedLayerIds: [...w.touched].filter((id) => !w.created.includes(id)),
    valuation,
    effects: w.effects,
    deficitCompletions: w.deficitCompletions,
    returnAllocations: w.returnAllocations,
    standardAllocations: w.standardAllocations,
  };
}

function draft(w: Work, init: Partial<ValuationDraft> & Pick<ValuationDraft, "kind" | "qty" | "valueSource">): ValuationDraft {
  return {
    id: w.inputs.valuationId,
    knownQty: 0,
    unknownQty: 0,
    deficitQty: 0,
    value: null,
    drawnLayers: [],
    originalAmount: null,
    originalCurrency: null,
    rateDate: null,
    rateSource: null,
    after: w.after(),
    details: {},
    ...init,
  };
}

function outflowDraft(w: Work, q: number, effect: ValuationEffect, extraDetails: Record<string, DetailValue> = {}): { d: ValuationDraft; knownValue: bigint | null } {
  const o = w.outflow(q);
  const knownQty = o.poolQty + o.standardQty;
  const value = knownQty > 0 ? o.poolValue + o.standardValue : null;
  const source: ValuationValueSource =
    o.poolQty > 0 ? "pool_average" : o.standardQty > 0 ? (w.inputs.standard?.source ?? "owner_standard") : "none";
  const d = draft(w, {
    kind: "outflow",
    qty: q,
    knownQty,
    unknownQty: o.drawn.reduce((s, l) => s + l.qty, 0),
    deficitQty: o.deficitQty,
    value,
    valueSource: source,
    drawnLayers: o.drawn,
    details: {
      ...baseDetails(w.m, effect),
      poolQty: o.poolQty,
      poolValue: minorToDecimal(o.poolValue),
      ...(o.standardQty > 0
        ? { standardQty: o.standardQty, standardValue: minorToDecimal(o.standardValue), standardSource: w.inputs.standard!.source, standardCostId: w.inputs.standard!.costId }
        : {}),
      ...extraDetails,
    },
  });
  return { d, knownValue: value };
}

function inflowValuedDraft(
  w: Work,
  n: number,
  v: bigint,
  source: ValuationValueSource,
  effect: ValuationEffect,
  extra: Partial<ValuationDraft> = {},
  extraDetails: Record<string, DetailValue> = {},
): ValuationDraft {
  const closed = w.inflowValued(n, v);
  return draft(w, {
    kind: "inflow",
    qty: n,
    knownQty: n,
    value: v,
    valueSource: source,
    ...extra,
    details: {
      ...baseDetails(w.m, effect),
      poolQty: n - closed.closedQty,
      poolValue: minorToDecimal(v - closed.closedValue),
      ...(closed.closedQty > 0 ? { deficitClosedQty: closed.closedQty, deficitClosedValue: minorToDecimal(closed.closedValue) } : {}),
      ...extraDetails,
    },
  });
}

function inflowUnknownDraft(
  w: Work,
  n: number,
  reason: CostLayerReason,
  effect: ValuationEffect,
  layerExtra: Partial<CostLayer> = {},
  extra: Partial<ValuationDraft> = {},
): ValuationDraft {
  const r = w.inflowUnknown(n, reason, layerExtra);
  return draft(w, {
    kind: "inflow",
    qty: n,
    unknownQty: n,
    value: null,
    valueSource: "none",
    ...extra,
    details: {
      ...baseDetails(w.m, effect),
      poolQty: 0,
      poolValue: "0.00",
      layerReason: reason,
      layerQty: r.layerQty,
      ...(r.closedQty > 0 ? { deficitClosedQty: r.closedQty } : {}),
    },
  });
}

function movementValueExtra(v: MovementValueInput): Partial<ValuationDraft> {
  if (v.status === "valued") {
    return { originalAmount: v.originalAmount, originalCurrency: v.originalCurrency, rateDate: v.rateDate, rateSource: v.rateSource };
  }
  if (v.status === "no_rate") return { originalAmount: v.originalAmount, originalCurrency: v.originalCurrency };
  return {};
}

/** Надходження з відомою (або очікуваною) вартістю V на g якісних + f браку (§6.3, рядки receipt_production / receipt_manual). */
function receiptWithCost(w: Work, g: number, f: number, source: ValuationValueSource): ValuationDraft {
  const v = w.inputs.value;
  const m = w.m;
  const memo = (minor: bigint) => {
    if (minor <= 0n) return;
    if (m.stockKind === "material") w.effects.push({ type: "materials_purchased_memo", minor });
    else w.effects.push({ type: "production_capitalized_memo", minor, source: m.type === "receipt_production" ? "production" : "purchase" });
  };
  if (v.status === "valued") {
    if (g > 0) {
      memo(v.minor);
      return inflowValuedDraft(w, g, v.minor, source, "none", movementValueExtra(v), { defectiveQty: f });
    }
    // Усі одиниці — брак: вартість іде в пул (якщо є відомі одиниці), інакше — збиток виробництва.
    if (w.state.knownQty > 0) {
      w.state.knownValue += v.minor;
      memo(v.minor);
      return draft(w, {
        kind: "inflow",
        qty: 0,
        value: v.minor,
        valueSource: source,
        ...movementValueExtra(v),
        details: { ...baseDetails(m, "none"), poolQty: 0, poolValue: minorToDecimal(v.minor), defectiveQty: f },
      });
    }
    if (v.minor > 0n) w.effects.push({ type: "inventory_loss", minor: v.minor, lossKind: "production_defect" });
    return draft(w, {
      kind: "inflow",
      qty: 0,
      value: v.minor,
      valueSource: source,
      ...movementValueExtra(v),
      details: { ...baseDetails(m, "loss"), poolQty: 0, poolValue: "0.00", defectiveQty: f, lossKind: "production_defect" },
    });
  }
  if (v.status === "no_rate") {
    if (g <= 0) {
      // Лише брак, курсу немає: вартість V визнається, коли з'явиться курс (правило g = 0 на момент завершення: у пул,
      // якщо є відомі одиниці, інакше inventory_loss production_defect). Позначка для завдання курсів — шар fx_pending
      // без відкритих одиниць (кількість = брак; у on_hand і C0 не входить).
      if (f > 0) w.newLayer(UNKNOWN_KIND, "fx_pending", f, { qtyOpen: 0, pendingUnitCost: v.unitCost, pendingCurrency: v.originalCurrency });
      return draft(w, {
        kind: "inflow",
        qty: 0,
        value: null,
        valueSource: "none",
        ...movementValueExtra(v),
        details: { ...baseDetails(m, "none"), poolQty: 0, poolValue: "0.00", defectiveQty: f, fxPending: true, defectOnly: true },
      });
    }
    return inflowUnknownDraft(
      w,
      g,
      "fx_pending",
      "none",
      { pendingUnitCost: v.unitCost, pendingCurrency: v.originalCurrency },
      movementValueExtra(v),
    );
  }
  // Без вартості.
  if (g <= 0) {
    return draft(w, { kind: "inflow", qty: 0, value: null, valueSource: "none", details: { ...baseDetails(m, "none"), poolQty: 0, poolValue: "0.00", defectiveQty: f } });
  }
  if (m.stockKind === "material" && w.inputs.standard) {
    // Матеріал без ціни надходження — за каталожною ціною (catalogue), довідкового запису закупівлі немає.
    const unit = w.inputs.standard;
    return inflowValuedDraft(w, g, unit.minor * BigInt(g), "catalogue", "none", {}, { defectiveQty: f, standardCostId: unit.costId });
  }
  return inflowUnknownDraft(w, g, "receipt_without_cost", "none");
}

/** Придатне повернення покупця (§6.3, рядок receipt_manual customer_return). */
function customerReturn(w: Work): ValuationDraft {
  const m = w.m;
  const src = w.inputs.returnSources ?? { pairedDefectQty: null, sales: [], standards: [] };
  const paired = src.pairedDefectQty !== null && src.pairedDefectQty > 0;
  const f = paired ? src.pairedDefectQty! : Math.max(0, m.defectiveDelta);
  const g = paired ? Math.max(0, m.onHandDelta - f) : Math.max(0, m.onHandDelta);
  let remaining = g;
  let knownQty = 0;
  let knownValue = 0n;
  const fromSales: string[] = [];
  const fromStd: string[] = [];
  // (1а) відомі одиниці продажів цього товару в замовленні.
  const allocations = new Map<string, ReturnAllocation>();
  for (const s of src.sales) {
    if (remaining === 0) break;
    const t = Math.min(s.knownUnits, remaining);
    if (t <= 0) continue;
    const value = valueOfUnits(s.knownValue, t, s.knownUnits, w.q);
    knownQty += t;
    knownValue += value;
    remaining -= t;
    allocations.set(s.valuationId, { saleValuationId: s.valuationId, knownQty: t, knownValue: value, unvaluedQty: 0 });
  }
  // (1б) одиниці, що були без вартості чи дефіцитні. Спершу вони ГАСЯТЬ відкритий дефіцит цього ж продажу (одиниця,
  // продана з від'ємного залишку, повернулася — від'ємний залишок зменшується, вартості в неї немає й не буде: §6.2
  // «частка повернутих одиниць не стає собівартістю продажу»); лише решта — шар return_without_cost, пов'язаний з
  // оцінкою продажу (його завершить вартість, що надійде для одиниць продажу). Так шар повернення ніколи не співіснує з
  // відкритим дефіцитом свого продажу, і пізніше надходження, що закриває дефіцит, дає вартість лише ще проданим
  // одиницям. Погашені одиниці записуються закритим шаром (qty_open = 0) — для обліку «повернено без вартості».
  const unvaluedLayers: Array<{ saleValuationId: string; qty: number }> = [];
  const cancelledLayers: Array<{ saleValuationId: string; qty: number }> = [];
  for (const s of src.sales) {
    if (remaining === 0) break;
    const t = Math.min(s.unvaluedUnits, remaining);
    if (t <= 0) continue;
    remaining -= t;
    let cancelled = 0;
    for (const d of w.open("deficit", (l) => l.originValuationId === s.valuationId)) {
      const c = Math.min(d.qtyOpen, t - cancelled);
      if (c <= 0) break;
      d.qtyOpen -= c;
      w.touch(d);
      w.state.deficitQty -= c;
      cancelled += c;
    }
    if (cancelled > 0) cancelledLayers.push({ saleValuationId: s.valuationId, qty: cancelled });
    if (t - cancelled > 0) unvaluedLayers.push({ saleValuationId: s.valuationId, qty: t - cancelled });
    const a = allocations.get(s.valuationId) ?? { saleValuationId: s.valuationId, knownQty: 0, knownValue: 0n, unvaluedQty: 0 };
    a.unvaluedQty += t;
    allocations.set(s.valuationId, a);
  }
  for (const a of allocations.values()) {
    w.returnAllocations.push(a);
    fromSales.push(`${a.saleValuationId}:${a.knownQty}:${minorToDecimal(a.knownValue)}:${a.unvaluedQty}`);
  }
  // (2) записи stdcogs позицій товару в замовленні.
  let stdQty = 0;
  let stdValue = 0n;
  for (const s of src.standards) {
    if (remaining === 0) break;
    const t = Math.min(s.qty, remaining);
    if (t <= 0) continue;
    const value = s.unitMinor * BigInt(t);
    stdQty += t;
    stdValue += value;
    remaining -= t;
    w.standardAllocations.push({ entryId: s.entryId, qty: t, value });
    fromStd.push(`${s.entryId}:${t}`);
  }
  // (3) поточна середня пулу.
  let avgQty = 0;
  let avgValue = 0n;
  if (remaining > 0 && w.state.knownQty > 0) {
    avgQty = remaining;
    avgValue = mulDivQ(w.state.knownValue, BigInt(remaining), BigInt(w.state.knownQty), w.q);
    remaining = 0;
  }
  // (4) решта — шар return_without_cost без продажу.
  const layerQty = remaining;
  const valuedQty = knownQty + stdQty + avgQty;
  const valuedValue = knownValue + stdValue + avgValue;
  const closed = w.inflowValued(valuedQty, valuedValue);
  for (const u of unvaluedLayers) {
    w.newLayer(UNKNOWN_KIND, "return_without_cost", u.qty, { sourceValuationId: u.saleValuationId });
    w.state.unknownQty += u.qty;
  }
  for (const c of cancelledLayers) {
    // Погашено дефіцит свого продажу: шар без відкритих одиниць (не входить у unknown_qty), лише облік повернутого.
    w.newLayer(UNKNOWN_KIND, "return_without_cost", c.qty, { sourceValuationId: c.saleValuationId, qtyOpen: 0, closed: true });
  }
  const cancelledQty = cancelledLayers.reduce((s, c) => s + c.qty, 0);
  if (layerQty > 0) {
    w.newLayer(UNKNOWN_KIND, "return_without_cost", layerQty);
    w.state.unknownQty += layerQty;
  }
  // Пошкоджені одиниці розділеного запису етапу 5 (on_hand + пошкоджені, потім парний брак) — у пул за нулем;
  // парний defect_mark забирає їх за нулем. Без розділення вони в кошику браку (вартості не мають).
  if (paired) w.state.knownQty += f;
  const unlinked = m.orderId === null;
  if (unlinked && valuedValue > 0n) w.effects.push({ type: "cogs_return_unlinked", minor: valuedValue });
  const source: ValuationValueSource =
    knownQty > 0 ? "original_sale" : stdQty > 0 ? "owner_standard" : avgQty > 0 ? "pool_average" : "none";
  return draft(w, {
    kind: "inflow",
    qty: g + (paired ? f : 0),
    knownQty: valuedQty + (paired ? f : 0),
    unknownQty: unvaluedLayers.reduce((s, u) => s + u.qty, 0) + layerQty,
    value: valuedQty > 0 || paired ? valuedValue : null,
    valueSource: source,
    details: {
      ...baseDetails(m, unlinked ? "none" : "order"),
      kind: "customer_return",
      goodQty: g,
      damagedQty: f,
      pairedDamaged: paired,
      fromSales,
      fromStd,
      saleKnownQty: knownQty,
      saleKnownValue: minorToDecimal(knownValue),
      stdQty,
      stdValue: minorToDecimal(stdValue),
      avgQty,
      avgValue: minorToDecimal(avgValue),
      layerQty: layerQty + unvaluedLayers.reduce((s, u) => s + u.qty, 0),
      ...(cancelledQty > 0 ? { deficitCancelledQty: cancelledQty } : {}),
      poolQty: valuedQty - closed.closedQty,
      poolValue: minorToDecimal(valuedValue - closed.closedValue),
      ...(closed.closedQty > 0 ? { deficitClosedQty: closed.closedQty, deficitClosedValue: minorToDecimal(closed.closedValue) } : {}),
      ...(unlinked ? { withoutOrder: true } : {}),
    },
  });
}

function valueMovement(w: Work): ValuationDraft | null {
  const m = w.m;
  const dOn = m.onHandDelta;
  switch (m.type) {
    case "opening": {
      if (dOn > 0) {
        const std = w.inputs.standard;
        if (std) return inflowValuedDraft(w, dOn, std.minor * BigInt(dOn), std.source, "none", {}, { standardCostId: std.costId });
        return inflowUnknownDraft(w, dOn, "opening", "none");
      }
      if (dOn < 0) {
        const { d, knownValue } = outflowDraft(w, -dOn, "loss", { lossKind: "opening_correction" });
        if (knownValue !== null && knownValue > 0n) w.effects.push({ type: "inventory_loss", minor: knownValue, lossKind: "opening_correction" });
        return d;
      }
      return null;
    }
    case "receipt_production":
      return receiptWithCost(w, Math.max(0, dOn), Math.max(0, m.defectiveDelta), "batch");
    case "receipt_manual":
      if (isCustomerReturn(m)) return customerReturn(w);
      return receiptWithCost(w, Math.max(0, dOn), Math.max(0, m.defectiveDelta), "movement_cost");
    case "adjustment":
    case "shopify_external": {
      const lossKind: LossKind = m.type === "adjustment" ? "shortage" : "shopify_external";
      let d: ValuationDraft | null = null;
      if (dOn > 0) {
        if (w.state.knownQty > 0) {
          const value = mulDivQ(w.state.knownValue, BigInt(dOn), BigInt(w.state.knownQty), w.q);
          d = inflowValuedDraft(w, dOn, value, "pool_average", "gain");
          if (value > 0n) w.effects.push({ type: "inventory_gain", minor: value, gainKind: "surplus" });
        } else {
          d = inflowUnknownDraft(w, dOn, "surplus_without_cost", "gain");
        }
      } else if (dOn < 0) {
        const r = outflowDraft(w, -dOn, "loss", { lossKind });
        d = r.d;
        if (r.knownValue !== null && r.knownValue > 0n) w.effects.push({ type: "inventory_loss", minor: r.knownValue, lossKind });
      }
      if (m.defectiveDelta < 0) {
        const closedDefect = closeDefectLayers(w, -m.defectiveDelta);
        if (!d) {
          d = draft(w, {
            kind: "outflow",
            qty: 0,
            value: null,
            valueSource: "zero",
            details: { ...baseDetails(m, "none"), poolQty: 0, poolValue: "0.00", defectClosedQty: closedDefect.qty },
          });
        } else {
          d.details.defectClosedQty = closedDefect.qty;
        }
      }
      return d;
    }
    case "consume_sale":
    case "material_consume":
    case "transfer_out": {
      if (dOn >= 0) return null;
      const effect: ValuationEffect =
        m.type === "transfer_out" ? "none" : m.orderId ? "order" : m.type === "material_consume" ? "packaging_unlinked" : "loss";
      const { d, knownValue } = outflowDraft(w, -dOn, effect, m.type === "consume_sale" && !m.orderId ? { lossKind: "shortage" } : {});
      if (effect === "packaging_unlinked" && knownValue !== null && knownValue > 0n) w.effects.push({ type: "packaging_unlinked", minor: knownValue });
      if (effect === "loss" && knownValue !== null && knownValue > 0n) w.effects.push({ type: "inventory_loss", minor: knownValue, lossKind: "shortage" });
      return d;
    }
    case "transfer_in": {
      if (dOn <= 0) return null;
      const v = w.inputs.value;
      if (v.status === "valued") return inflowValuedDraft(w, dOn, v.minor, "movement_cost", "none", movementValueExtra(v));
      return inflowUnknownDraft(w, dOn, "surplus_without_cost", "none");
    }
    case "defect_mark": {
      const q = Math.max(0, -dOn);
      if (q === 0) return null;
      if (w.inputs.pairedReturnDefect && w.state.knownQty >= q) {
        // Одиниці щойно увійшли за нулем (розділений запис повернення): вихід за нульовою вартістю.
        w.state.knownQty -= q;
        w.newLayer("defect", "defect_mark", q, { valueOpen: 0n });
        return draft(w, {
          kind: "outflow",
          qty: q,
          knownQty: q,
          value: 0n,
          valueSource: "zero",
          details: { ...baseDetails(m, "none"), poolQty: q, poolValue: "0.00", pairedReturnDefect: true },
        });
      }
      const { d, knownValue } = outflowDraft(w, q, "loss", { lossKind: "defect" });
      w.newLayer("defect", "defect_mark", q, { valueOpen: knownValue ?? 0n });
      if (knownValue !== null && knownValue > 0n) w.effects.push({ type: "inventory_loss", minor: knownValue, lossKind: "defect" });
      return d;
    }
    case "defect_writeoff": {
      const q = Math.max(0, -m.defectiveDelta);
      if (q === 0) return null;
      const closed = closeDefectLayers(w, q);
      return draft(w, {
        kind: "outflow",
        qty: 0,
        value: null,
        valueSource: "zero",
        details: { ...baseDetails(m, "none"), poolQty: 0, poolValue: "0.00", defectClosedQty: closed.qty, writtenOffQty: q },
      });
    }
    case "defect_repair": {
      const q = Math.max(0, dOn);
      if (q === 0) return null;
      const taken = closeDefectLayers(w, q);
      const d = inflowValuedDraft(w, q, taken.value, taken.value > 0n ? "pool_average" : "zero", taken.value > 0n ? "gain" : "none", {}, {
        defectLayerQty: taken.qty,
      });
      if (taken.value > 0n) w.effects.push({ type: "inventory_gain", minor: taken.value, gainKind: "repair" });
      return d;
    }
    default:
      return null;
  }
}

/** Бере шари defect FIFO (ремонт / списання браку): повертає кількість одиниць із шарів і їхню вартість. */
function closeDefectLayers(w: Work, q: number): { qty: number; value: bigint } {
  let remaining = q;
  let qty = 0;
  let value = 0n;
  for (const l of w.open("defect")) {
    if (remaining === 0) break;
    const t = Math.min(l.qtyOpen, remaining);
    const v = valueOfUnits(l.valueOpen ?? 0n, t, l.qtyOpen, w.q);
    l.qtyOpen -= t;
    l.valueOpen = (l.valueOpen ?? 0n) - v;
    w.touch(l);
    qty += t;
    value += v;
    remaining -= t;
  }
  return { qty, value };
}

/** Початковий стан пулу. */
export function emptyPoolState(currency: string): PoolState {
  return { currency, knownQty: 0, knownValue: 0n, unknownQty: 0, deficitQty: 0, lastAvgUnit: null, lastSeq: 0 };
}

/** C0: on_hand = known + unknown − deficit. */
export function poolOnHand(s: Pick<PoolState, "knownQty" | "unknownQty" | "deficitQty">): number {
  return s.knownQty + s.unknownQty - s.deficitQty;
}

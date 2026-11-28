/**
 * Етап 6, WP2: простий симулятор чистого рушія (tests/stage6/costing) — послідовність рухів без БД.
 */
import { emptyPoolState, minorToDecimal, step, type CostEffect, type CostLayer, type DeficitCompletion, type PoolState, type StepInputs, type StepMovement, type ValuationDraft } from "~/modules/costing/engine";
import { toMinor } from "~/lib/money";

export interface SimStep {
  movement: StepMovement;
  valuation: ValuationDraft | null;
  effects: CostEffect[];
  deficitCompletions: DeficitCompletion[];
}

export class Sim {
  state: PoolState;
  layers: CostLayer[] = [];
  steps: SimStep[] = [];
  private seq = 0;
  private ids = 0;
  onHand = 0;
  /** Вид позиції (матеріал — каталожна ціна як ручна собівартість). */
  stockKind: StepMovement["stockKind"] = "product";

  constructor(currency = "UAH") {
    this.state = emptyPoolState(currency);
  }

  newId = () => `L${++this.ids}`;

  apply(
    type: StepMovement["type"],
    m: Partial<StepMovement> = {},
    inputs: Partial<Omit<StepInputs, "valuationId" | "newId">> & { valueMinor?: string } = {},
  ): SimStep {
    const seq = ++this.seq;
    const movement: StepMovement = {
      id: `M${seq}`,
      seq,
      type,
      idempotencyKey: m.idempotencyKey ?? `k${seq}`,
      stockKind: this.stockKind,
      onHandDelta: 0,
      defectiveDelta: 0,
      orderId: null,
      orderLineItemId: null,
      productionBatchId: null,
      reason: null,
      occurredOn: "2026-09-01",
      ...m,
    };
    const value: StepInputs["value"] =
      inputs.valueMinor !== undefined
        ? { status: "valued", minor: toMinor(inputs.valueMinor), originalAmount: inputs.valueMinor, originalCurrency: this.state.currency, rateDate: null, rateSource: null }
        : (inputs.value ?? { status: "none" });
    const r = step(this.state, this.layers, movement, {
      valuationId: `V${seq}`,
      newId: this.newId,
      value,
      standard: inputs.standard ?? null,
      returnSources: inputs.returnSources,
      pairedReturnDefect: inputs.pairedReturnDefect,
    });
    this.state = r.state;
    this.layers = r.layers.filter((l) => l.qtyOpen > 0 && !l.closed);
    this.onHand += movement.onHandDelta;
    const s: SimStep = { movement, valuation: r.valuation, effects: r.effects, deficitCompletions: r.deficitCompletions };
    this.steps.push(s);
    return s;
  }

  /** Вартість пулу (десятковий рядок). */
  get poolValue(): string {
    return minorToDecimal(this.state.knownValue);
  }

  get c0(): boolean {
    return this.state.knownQty + this.state.unknownQty - this.state.deficitQty === this.onHand;
  }
}

export const dec = (v: bigint | null | undefined) => (v === null || v === undefined ? null : minorToDecimal(v));

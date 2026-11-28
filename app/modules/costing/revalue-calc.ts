/**
 * Етап 6, WP2: чисті розрахунки коригування собівартості партії після надходження (docs/stage6-design.md §6.7).
 *
 * 1. Ціль рядка партії = unit_cost × produced + частка extraFor(Σ produced) (batchCostSummary().lines[].producedValue);
 *    ціль ділиться між надходженнями рядка allocateMinor за кількістю (якісні + брак).
 * 2. Δ руху = ціль − (проведена вартість + попередні коригування).
 * 3. Частка Δ на закриті цим надходженням дефіцити (s з g якісних): Δ_deficit = mulDiv(Δ, s, g) — до продажів.
 *    Решта Δ_pool: частка, що лишилася на складі, — з ІСТОРІЇ: r = Π(known_after / known_before) за виходами з
 *    відомого пулу з seq > seq надходження (входи множник не змінюють); Δ_stock = mulDiv(Δ_pool, r.num, r.den) одним
 *    округленням; known_qty = 0 → 0; known_value + Δ_stock < 0 → −known_value.
 * 4. Решта Δ_pool − Δ_stock ділиться за видами виходів allocateMinor з ТОЧНИМИ вагами кожного виходу
 *    (w_i = Π_{j<i} after_j × (before_i − after_i) × Π_{j>i} before_j — спільний знаменник Π before): продажі →
 *    cogs_adjustment, втрати (брак, нестача, тестове замовлення) → inventory_loss.
 */
import type { Rational } from "~/lib/decimal";
import { allocateQ, mulDivQ } from "./engine";

export type OutflowBucket = "sales" | "loss";

export interface PoolOutflow {
  /** Одиниці пулу до виходу. */
  knownBefore: number;
  /** Після виходу. */
  knownAfter: number;
  bucket: OutflowBucket;
}

/** r = Π after/before (точне раціональне; без виходів — 1). */
export function remainingShare(outflows: readonly PoolOutflow[]): Rational {
  let num = 1n;
  let den = 1n;
  for (const o of outflows) {
    if (o.knownBefore <= 0) continue;
    num *= BigInt(Math.max(0, o.knownAfter));
    den *= BigInt(o.knownBefore);
  }
  return { num, den };
}

/** Точні ваги часток виходів (спільний знаменник Π before; Σ ваг = den − num). */
export function outflowWeights(outflows: readonly PoolOutflow[]): bigint[] {
  const valid = outflows.map((o) => o.knownBefore > 0);
  const before = outflows.map((o) => BigInt(Math.max(0, o.knownBefore)));
  const after = outflows.map((o) => BigInt(Math.max(0, o.knownAfter)));
  return outflows.map((_, i) => {
    if (!valid[i]) return 0n;
    let w = before[i]! - after[i]!;
    for (let j = 0; j < outflows.length; j++) {
      if (j === i || !valid[j]) continue;
      w *= j < i ? after[j]! : before[j]!;
    }
    return w;
  });
}

export interface RevaluationSplit {
  deltaDeficit: bigint;
  deltaStock: bigint;
  /** Частки за видами виходів (Σ = Δ − Δ_deficit − Δ_stock). */
  buckets: Record<OutflowBucket, bigint>;
}

export function splitRevaluation(input: {
  delta: bigint;
  /** Якісні одиниці надходження (g) і закриті ним дефіцити (s). */
  goodQty: number;
  deficitClosedQty: number;
  outflows: readonly PoolOutflow[];
  currentKnownQty: number;
  currentKnownValue: bigint;
  /** Квант валюти оцінки (engine.currencyQuantum): JPY — частки в цілих одиницях. */
  quantum?: bigint;
}): RevaluationSplit {
  const { delta, goodQty, deficitClosedQty } = input;
  const q = input.quantum ?? 1n;
  const deltaDeficit = goodQty > 0 && deficitClosedQty > 0 ? mulDivQ(delta, BigInt(Math.min(deficitClosedQty, goodQty)), BigInt(goodQty), q) : 0n;
  const deltaPool = delta - deltaDeficit;
  let deltaStock = 0n;
  if (input.currentKnownQty > 0) {
    const r = remainingShare(input.outflows);
    deltaStock = r.den === 0n ? 0n : mulDivQ(deltaPool, r.num, r.den, q);
    if (input.currentKnownValue + deltaStock < 0n) deltaStock = -input.currentKnownValue;
  }
  const rest = deltaPool - deltaStock;
  const buckets: Record<OutflowBucket, bigint> = { sales: deltaDeficit, loss: 0n };
  if (rest !== 0n) {
    const weights = outflowWeights(input.outflows);
    if (weights.some((w) => w > 0n)) {
      const parts = allocateQ(rest, weights, q);
      input.outflows.forEach((o, i) => {
        buckets[o.bucket] += parts[i]!;
      });
    } else {
      // Артефакт округлення без виходів (лише обмеження «пул ніколи не від'ємний») — у втрати.
      buckets.loss += rest;
    }
  }
  return { deltaDeficit, deltaStock, buckets };
}

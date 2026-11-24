/**
 * Розрахунок ваги місця (посилки).
 *
 * - фактична вага = Σ(вага товару × кількість) + вага тари;
 * - об'ємна вага, г = ceil(Д × Ш × В (см³) × 1000 / дільник), дільник у см³/кг (напр. 5000);
 * - оплачувана вага = max(фактична, об'ємна).
 *
 * Лише цілі числа (грами, сантиметри). Специфічне для перевізника округлення (кроки 100 г / 0,5 кг
 * тощо) застосовує адаптер перевізника на етапі 3, НЕ тут.
 */

export interface ParcelWeightInput {
  items: Array<{ weightGrams: number; quantity: number }>;
  pkg: { lengthCm: number; widthCm: number; heightCm: number; tareWeightGrams: number };
  volumetricDivisor: number;
}

export interface ParcelWeights {
  actualWeightGrams: number;
  volumetricWeightGrams: number;
  chargeableWeightGrams: number;
}

function assertNonNegativeInt(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer, got ${String(value)}`);
  }
}

/** Ціле ділення з округленням угору, стійке до похибок float. */
function ceilDiv(numerator: number, divisor: number): number {
  const q = Math.trunc(numerator / divisor);
  return q * divisor < numerator ? q + 1 : q;
}

export function computeParcelWeights(input: ParcelWeightInput): ParcelWeights {
  const { items, pkg, volumetricDivisor } = input;

  if (!Number.isSafeInteger(volumetricDivisor) || volumetricDivisor <= 0) {
    throw new RangeError(`volumetricDivisor must be a positive integer, got ${String(volumetricDivisor)}`);
  }
  assertNonNegativeInt(pkg.lengthCm, "pkg.lengthCm");
  assertNonNegativeInt(pkg.widthCm, "pkg.widthCm");
  assertNonNegativeInt(pkg.heightCm, "pkg.heightCm");
  assertNonNegativeInt(pkg.tareWeightGrams, "pkg.tareWeightGrams");

  let actual = pkg.tareWeightGrams;
  items.forEach((item, i) => {
    assertNonNegativeInt(item.weightGrams, `items[${i}].weightGrams`);
    assertNonNegativeInt(item.quantity, `items[${i}].quantity`);
    actual += item.weightGrams * item.quantity;
  });
  assertNonNegativeInt(actual, "actualWeightGrams");

  const volumeTimes1000 = pkg.lengthCm * pkg.widthCm * pkg.heightCm * 1000;
  assertNonNegativeInt(volumeTimes1000, "package volume");
  const volumetric = ceilDiv(volumeTimes1000, volumetricDivisor);

  return {
    actualWeightGrams: actual,
    volumetricWeightGrams: volumetric,
    chargeableWeightGrams: Math.max(actual, volumetric),
  };
}

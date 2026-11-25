import { describe, expect, it } from "vitest";
import { computeParcelWeights, type ParcelWeightInput } from "~/modules/shipments/weight";

const mailerM = { lengthCm: 35, widthCm: 25, heightCm: 8, tareWeightGrams: 70 };

function input(overrides: Partial<ParcelWeightInput> = {}): ParcelWeightInput {
  return {
    items: [
      { weightGrams: 300, quantity: 2 },
      { weightGrams: 150, quantity: 1 },
    ],
    pkg: mailerM,
    volumetricDivisor: 5000,
    ...overrides,
  };
}

describe("computeParcelWeights", () => {
  it("computes actual, volumetric and chargeable weight", () => {
    // actual = 600 + 150 + 70 = 820; volumetric = 35*25*8*1000/5000 = 1400
    expect(computeParcelWeights(input())).toEqual({
      actualWeightGrams: 820,
      volumetricWeightGrams: 1400,
      chargeableWeightGrams: 1400,
    });
  });

  it("uses the actual weight when it exceeds the volumetric weight", () => {
    const res = computeParcelWeights(input({ items: [{ weightGrams: 1000, quantity: 3 }] }));
    expect(res).toEqual({ actualWeightGrams: 3070, volumetricWeightGrams: 1400, chargeableWeightGrams: 3070 });
  });

  it("rounds the volumetric weight up to whole grams", () => {
    const res = computeParcelWeights(
      input({ items: [], pkg: { lengthCm: 1, widthCm: 1, heightCm: 1, tareWeightGrams: 0 }, volumetricDivisor: 3000 }),
    );
    // 1000 / 3000 = 0.333… → 1
    expect(res.volumetricWeightGrams).toBe(1);

    const odd = computeParcelWeights(
      input({ items: [], pkg: { lengthCm: 7, widthCm: 11, heightCm: 13, tareWeightGrams: 0 }, volumetricDivisor: 6000 }),
    );
    // 1001000 / 6000 = 166.83… → 167
    expect(odd.volumetricWeightGrams).toBe(167);
  });

  it("keeps exact divisions exact", () => {
    const res = computeParcelWeights(
      input({ items: [], pkg: { lengthCm: 40, widthCm: 30, heightCm: 20, tareWeightGrams: 250 }, volumetricDivisor: 5000 }),
    );
    expect(res).toEqual({ actualWeightGrams: 250, volumetricWeightGrams: 4800, chargeableWeightGrams: 4800 });
  });

  it("handles no items (tare only) and zero quantity", () => {
    expect(computeParcelWeights(input({ items: [] })).actualWeightGrams).toBe(70);
    expect(computeParcelWeights(input({ items: [{ weightGrams: 500, quantity: 0 }] })).actualWeightGrams).toBe(70);
  });

  it("returns integers only", () => {
    const res = computeParcelWeights(
      input({ pkg: { lengthCm: 33, widthCm: 17, heightCm: 9, tareWeightGrams: 55 }, volumetricDivisor: 4000 }),
    );
    for (const v of Object.values(res)) expect(Number.isInteger(v)).toBe(true);
  });

  it.each([
    ["negative item weight", input({ items: [{ weightGrams: -1, quantity: 1 }] })],
    ["NaN item weight", input({ items: [{ weightGrams: Number.NaN, quantity: 1 }] })],
    ["fractional item weight", input({ items: [{ weightGrams: 10.5, quantity: 1 }] })],
    ["negative quantity", input({ items: [{ weightGrams: 10, quantity: -2 }] })],
    ["fractional quantity", input({ items: [{ weightGrams: 10, quantity: 1.5 }] })],
    ["infinite quantity", input({ items: [{ weightGrams: 10, quantity: Number.POSITIVE_INFINITY }] })],
    ["negative length", input({ pkg: { ...mailerM, lengthCm: -35 } })],
    ["NaN width", input({ pkg: { ...mailerM, widthCm: Number.NaN } })],
    ["fractional height", input({ pkg: { ...mailerM, heightCm: 8.2 } })],
    ["negative tare", input({ pkg: { ...mailerM, tareWeightGrams: -70 } })],
    ["zero divisor", input({ volumetricDivisor: 0 })],
    ["negative divisor", input({ volumetricDivisor: -5000 })],
    ["fractional divisor", input({ volumetricDivisor: 5000.5 })],
    ["NaN divisor", input({ volumetricDivisor: Number.NaN })],
  ])("throws RangeError on %s", (_label, bad) => {
    expect(() => computeParcelWeights(bad)).toThrow(RangeError);
  });
});

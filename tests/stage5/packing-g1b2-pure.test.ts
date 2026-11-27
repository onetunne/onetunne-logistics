import { describe, expect, it } from "vitest";
import { selectBox, type Box } from "~/modules/packaging/box-selection";
import { materialsPlanKey } from "~/modules/packaging/consumption.server";
import type { BoxCandidate, LineItems } from "~/modules/packaging/parcel.server";
import { CameraScanGate } from "~/modules/packing/camera-gate";
import { compareParcels, dimsConsistentWithWaybill, waybillParcel } from "~/modules/packing/parcel-compare";
import { INITIAL_SCAN_FEEDBACK, SCAN_FEEDBACK_TTL_MS, scanFeedbackReducer } from "~/modules/packing/scan-feedback";
import { adjustChecklist, checklistProgress, type ChecklistLine } from "~/modules/packing/scan";
import { packingSuggestion } from "~/modules/packing/view.server";

/**
 * G1b2 (чисті функції): одна одиниця в коробці за розміром (production-1), −1 для зайвих одиниць (packing-8), камера —
 * одна одиниця на одне свідоме зчитування (packing-7 / ui-2), повідомлення сканування не «висить» (e2e-7), габарити
 * типової упаковки — верхня межа й узгоджена ★ (e2e-3), відбиток плану матеріалів (production-5).
 */

const box = (code: string, dims: [number, number, number], maxWeightGrams: number | null = 2000, tare = 100): Box => ({
  id: `id-${code}`,
  code,
  kind: "box",
  active: true,
  innerLengthMm: dims[0],
  innerWidthMm: dims[1],
  innerHeightMm: dims[2],
  maxWeightGrams,
  tareWeightGrams: tare,
});
const S = box("box_s", [200, 150, 80], 2000, 120);
const M = box("box_m", [300, 200, 120], 5000, 220);
const L = box("box_l", [400, 300, 200], 10000, 380);

describe("production-1: the fill factor applies only to several units", () => {
  const item = { lengthMm: 200, widthMm: 150, heightMm: 70, weightGrams: 500, quantity: 1 };

  it("a single unit that fits with rotations is accepted by a snug box", () => {
    expect(selectBox([item], [S])).toMatchObject({ reason: "fits", box: { code: "box_s" } });
    // Найменша придатна — S, а не L (раніше: L, бо 85 % об'єму S «не вистачало»).
    expect(selectBox([item], [L, S, M])).toMatchObject({ reason: "fits", box: { code: "box_s" } });
    // Те саме для товару впритул (габарити = внутрішні габарити коробки), у будь-якій орієнтації.
    expect(selectBox([{ ...item, lengthMm: 80, widthMm: 200, heightMm: 150 }], [S, L])).toMatchObject({ box: { code: "box_s" } });
    // Поворот не допомагає — коробка не підходить.
    expect(selectBox([{ ...item, lengthMm: 210 }], [S]).box).toBeNull();
  });

  it("several units still need the fill factor (two such items do not fit S)", () => {
    expect(selectBox([{ ...item, quantity: 2 }], [S]).box).toBeNull();
    expect(selectBox([item, { ...item }], [S]).box).toBeNull();
    // Одна одиниця з габаритами + одна без — дві одиниці: коефіцієнт діє.
    const unmeasured = { lengthMm: null, widthMm: null, heightMm: null, weightGrams: 100, quantity: 1 };
    expect(selectBox([item, unmeasured], [S, L])).toMatchObject({ reason: "partial_dimensions", box: { code: "box_l" } });
  });
});

describe("packing-8: −1 removes extra units of any over-packed line", () => {
  const lines: ChecklistLine[] = [{ id: "a", variantId: "v", sku: null, barcode: null, required: 1 }];

  it("over by 3: three −1 steps reach the required quantity; +1 stays capped", () => {
    let checklist: Record<string, number> = { a: 4 };
    expect(checklistProgress(lines, checklist).complete).toBe(false);
    for (const expected of [3, 2, 1]) {
      const r = adjustChecklist(lines, checklist, "a", -1);
      expect(r).toMatchObject({ kind: "ok", packed: expected, required: 1 });
      if (r.kind !== "ok") throw new Error("unreachable");
      checklist = r.checklist;
    }
    expect(checklistProgress(lines, checklist).complete).toBe(true);
    expect(adjustChecklist(lines, checklist, "a", 1)).toEqual({ kind: "over_quantity", packed: 1, required: 1 });
    expect(adjustChecklist(lines, { a: 3 }, "a", 1)).toEqual({ kind: "over_quantity", packed: 3, required: 1 });
    expect(adjustChecklist(lines, {}, "a", -1)).toEqual({ kind: "below_zero" });
  });
});

describe("packing-7 / ui-2: camera counts a unit once per deliberate scan", () => {
  /** Кадри кожні 340 мс (300 мс + час detect) — як у циклі сторінки. */
  function run(gate: CameraScanGate, frames: Array<string[]>, start = 0, step = 340) {
    const emitted: Array<{ code: string; at: number }> = [];
    frames.forEach((codes, i) => {
      const at = start + i * step;
      const r = gate.frame(codes, at);
      if (r.kind === "emit") emitted.push({ code: r.code, at });
    });
    return emitted;
  }

  it("a barcode held in view for 5 s is counted once (was: every ~2 s)", () => {
    const gate = new CameraScanGate();
    const emitted = run(gate, Array.from({ length: 15 }, () => ["4820000000017"]));
    expect(emitted).toEqual([{ code: "4820000000017", at: 0 }]);
    expect(gate.frame(["4820000000017"], 15 * 340)).toEqual({ kind: "held", code: "4820000000017" });
  });

  it("the code is counted again only after it left the frame (several frames and ~1 s)", () => {
    const gate = new CameraScanGate();
    const A = "4820000000017";
    // В кадрі → поодинокий пропуск розпізнавання (1 кадр) → знову в кадрі: це та сама одиниця.
    expect(run(gate, [[A], [A], [], [A], [A]])).toHaveLength(1);
    // Прибрали з кадру на 4 кадри (~1,4 с) → наступна одиниця.
    const gate2 = new CameraScanGate();
    const emitted = run(gate2, [[A], [A], [], [], [], [], [A], [A]]);
    expect(emitted.map((e) => e.at)).toEqual([0, 6 * 340]);
  });

  it("explicit «Next unit» re-arms a code that stays in view (after the debounce)", () => {
    const gate = new CameraScanGate();
    const A = "OT-PH-BLK";
    expect(gate.frame([A], 0).kind).toBe("emit");
    expect(gate.frame([A], 300).kind).toBe("held");
    gate.rearm();
    // Пауза після попереднього зарахування ще діє.
    expect(gate.frame([A], 500)).toEqual({ kind: "wait", code: A });
    expect(gate.frame([A], 900)).toEqual({ kind: "emit", code: A });
    expect(gate.frame([A], 1200).kind).toBe("held");
  });

  it("two different codes alternating in view are counted once each, not on every alternation", () => {
    const gate = new CameraScanGate();
    const emitted = run(gate, Array.from({ length: 12 }, (_, i) => [i % 2 === 0 ? "A" : "B"]));
    expect(emitted.map((e) => e.code)).toEqual(["A", "B"]);
    // Другий код — не миттєво після першого (пауза), а лише один раз.
    expect(emitted[1]!.at).toBeGreaterThanOrEqual(800);
  });

  it("a frame with several different codes counts nothing", () => {
    const gate = new CameraScanGate();
    expect(gate.frame(["A", "B"], 0)).toEqual({ kind: "multiple", count: 2 });
    expect(gate.frame([" A ", "A", "", null], 1000)).toEqual({ kind: "emit", code: "A" });
    expect(gate.frame([], 1500)).toEqual({ kind: "none" });
  });

  it("same-code cooldown: a brief disappearance right after a count does not count it again", () => {
    const gate = new CameraScanGate({ absentFrames: 1, absentMs: 0 });
    expect(gate.frame(["A"], 0).kind).toBe("emit");
    expect(gate.frame([], 340).kind).toBe("none");
    // Знову озброєний відсутністю, але минуло < sameCodeCooldownMs (1,5 с).
    expect(gate.frame(["A"], 1000)).toEqual({ kind: "held", code: "A" });
    expect(gate.frame([], 1340).kind).toBe("none");
    expect(gate.frame(["A"], 1700).kind).toBe("emit");
  });
});

describe("e2e-7: the scan message does not linger", () => {
  it("hides on another action and after its time; a new scan shows its own result", () => {
    let s = scanFeedbackReducer(INITIAL_SCAN_FEEDBACK, { type: "result", ok: false, at: 0 });
    expect(s).toMatchObject({ visible: true, ok: false, seq: 1 });
    s = scanFeedbackReducer(s, { type: "otherAction", at: 100 });
    expect(s.visible).toBe(false);
    s = scanFeedbackReducer(s, { type: "result", ok: true, at: 200 });
    expect(s).toMatchObject({ visible: true, ok: true, seq: 2 });
    expect(scanFeedbackReducer(s, { type: "tick", at: 200 + SCAN_FEEDBACK_TTL_MS.ok - 1 }).visible).toBe(true);
    expect(scanFeedbackReducer(s, { type: "tick", at: 200 + SCAN_FEEDBACK_TTL_MS.ok }).visible).toBe(false);
    // Помилку видно довше.
    const err = scanFeedbackReducer(s, { type: "result", ok: false, at: 0 });
    expect(scanFeedbackReducer(err, { type: "tick", at: SCAN_FEEDBACK_TTL_MS.ok + 1 }).visible).toBe(true);
    expect(scanFeedbackReducer(err, { type: "tick", at: SCAN_FEEDBACK_TTL_MS.error }).visible).toBe(false);
  });
});

describe("e2e-3: default-package dimensions are an upper bound; ★ is consistent with the waybill", () => {
  const snapshot = (parcelSource: string) => ({
    parcelSource,
    parcels: [{ lengthCm: 35, widthCm: 25, heightCm: 8, actualWeightGrams: 500 }],
  });

  it("a smaller box in a default-package waybill is not a mismatch; a larger one is (exceeds)", () => {
    const placeholder = waybillParcel({ requestSnapshot: snapshot("default_package"), actualWeightGrams: null });
    expect(placeholder).toMatchObject({ dimsMm: [350, 250, 80], dimsUpperBound: true });
    expect(compareParcels(placeholder, { weightGrams: null, dimsMm: [200, 150, 80] })).toBeNull();
    expect(compareParcels(placeholder, { weightGrams: null, dimsMm: [355, 255, 90] })).toBeNull();
    expect(compareParcels(placeholder, { weightGrams: null, dimsMm: [300, 200, 120] })).toEqual({
      weight: null,
      dims: { waybillMm: [350, 250, 80], packedMm: [300, 200, 120], exceeds: true },
    });
    // Вага — як завжди (±10 %).
    expect(compareParcels(placeholder, { weightGrams: 400, dimsMm: [200, 150, 80] })?.weight).toEqual({ waybillGrams: 500, packedGrams: 400 });
    // Виміряні габарити (коробка / вручну) — точні: менша посилка — розбіжність.
    const exact = waybillParcel({ requestSnapshot: snapshot("auto_box"), actualWeightGrams: null });
    expect(exact.dimsUpperBound).toBeUndefined();
    expect(compareParcels(exact, { weightGrams: null, dimsMm: [200, 150, 80] })?.dims).toEqual({ waybillMm: [350, 250, 80], packedMm: [200, 150, 80] });
    expect(dimsConsistentWithWaybill(exact, [345, 255, 75])).toBe(true);
    expect(dimsConsistentWithWaybill(placeholder, null)).toBe(true);
  });

  const candidate = (b: Box, name: string): BoxCandidate => ({ ...b, name, onHand: 10, inStock: true });
  const boxes = [candidate(S, "S"), candidate(M, "M"), candidate(L, "L"), candidate(box("mailer_m", [340, 240, 50], 1000, 30), "Mailer")];
  const goods = (weightGrams: number) =>
    [{ quantity: 1, currentQuantity: null, variant: { lengthMm: null, widthMm: null, heightMm: null, weightGrams } }] as unknown as LineItems;
  const placeholder = { parcel: waybillParcel({ requestSnapshot: snapshot("default_package"), actualWeightGrams: null }), boxMaterialId: null };

  it("weight-only selection inside the default package: ★ = the usual pick, no mismatch to expect", () => {
    expect(packingSuggestion(goods(300), boxes, placeholder)).toMatchObject({ code: "box_s", reason: "weight_only", source: "selection", differsFromWaybill: false });
    // Без накладної — звичайний підбір.
    expect(packingSuggestion(goods(300), boxes, null)).toMatchObject({ code: "box_s", source: "selection", differsFromWaybill: false });
  });

  it("the waybill's own box is ★; a box beyond the waybill dimensions is flagged", () => {
    expect(packingSuggestion(goods(300), boxes, { parcel: placeholder.parcel, boxMaterialId: "id-box_m" })).toMatchObject({ code: "box_m", source: "waybill", differsFromWaybill: false });
    // 3 кг: S (2 кг) і пакет (1 кг) не витримують, M вища за 8 см накладної → ★ M з позначкою «відрізняється».
    expect(packingSuggestion(goods(3000), boxes, placeholder)).toMatchObject({ code: "box_m", source: "selection", differsFromWaybill: true });
    // Звичайний підбір виходить за межі, а в межах є придатна (точні габарити накладної 30 × 20 × 12 см) → вона.
    const exactM = {
      parcel: waybillParcel({ requestSnapshot: { parcelSource: "manual", parcels: [{ lengthCm: 30, widthCm: 20, heightCm: 12, actualWeightGrams: 500 }] }, actualWeightGrams: null }),
      boxMaterialId: null,
    };
    expect(packingSuggestion(goods(300), boxes, exactM)).toMatchObject({ code: "box_m", source: "waybill_fit", differsFromWaybill: false });
  });
});

describe("production-5: materials plan fingerprint", () => {
  it("is order-independent and changes with the material or the quantity", () => {
    const a = [
      { materialId: "B", required: 1 },
      { materialId: "a", required: 2 },
    ];
    expect(materialsPlanKey(a)).toBe(materialsPlanKey([...a].reverse()));
    expect(materialsPlanKey(a)).not.toBe(materialsPlanKey([{ materialId: "B", required: 1 }, { materialId: "a", required: 3 }]));
    expect(materialsPlanKey(a)).not.toBe(materialsPlanKey([...a, { materialId: "c", required: 1 }]));
    expect(materialsPlanKey([])).toBe("");
  });
});

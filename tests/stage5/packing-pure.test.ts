import { describe, expect, it } from "vitest";
import { parsePriority } from "~/modules/packing/constants";
import { compareParcels, waybillParcel } from "~/modules/packing/parcel-compare";
import {
  initialParcelForm,
  parcelPrefill,
  parcelPrefillMarkers,
  reduceParcelForm,
  resolveParcelForm,
  type ParcelFormAction,
  type ParcelFormEnv,
  type ParcelFormState,
} from "~/modules/packing/parcel-form";
import { activeFilterCount, buildQueueSearch, parseOrderIds, parseQueueFilters } from "~/modules/packing/queue-filters";
import {
  adjustChecklist,
  applyScan,
  checklistProgress,
  codeKey,
  matchScan,
  normalizeScanCode,
  type ChecklistLine,
} from "~/modules/packing/scan";

/** Чисті функції пакування: сканування/чекліст, розбіжність посилки з накладною, фільтри черги. */

const lines: ChecklistLine[] = [
  { id: "l1", variantId: "v1", sku: "OT-PH-BLK", barcode: "4820000000017", required: 2 },
  { id: "l2", variantId: "v2", sku: "OT-GR-BLK", barcode: "4820000000055", required: 1 },
];

describe("scan matching", () => {
  it("normalizes scanner input: control characters, spaces, case, GTIN leading zeros", () => {
    expect(normalizeScanCode("  4820000000017\r\n")).toBe("4820000000017");
    expect(normalizeScanCode("\tot-ph-blk\u0000 ")).toBe("ot-ph-blk");
    expect(codeKey("ot-ph-blk")).toBe(codeKey("OT-PH-BLK"));
    expect(codeKey("04820000000017")).toBe(codeKey("4820000000017"));
    expect(codeKey("OT PH BLK")).toBe("OTPHBLK");
    expect(normalizeScanCode("x".repeat(100), 64)).toHaveLength(64);
  });

  it("matches barcode first, then SKU; each scan adds one unit", () => {
    const first = applyScan(lines, {}, "4820000000017");
    expect(first.match).toMatchObject({ kind: "matched", lineId: "l1", packed: 1, required: 2, lineComplete: false, by: "barcode" });
    const second = applyScan(lines, first.checklist, "ot-ph-blk");
    expect(second.match).toMatchObject({ kind: "matched", lineId: "l1", packed: 2, lineComplete: true, by: "sku" });
    expect(second.checklist).toEqual({ l1: 2 });
  });

  it("over-quantity and wrong item do not change the checklist", () => {
    const full = { l1: 2 };
    const over = applyScan(lines, full, "4820000000017");
    expect(over.match).toEqual({ kind: "over_quantity", lineId: "l1", packed: 2, required: 2 });
    expect(over.checklist).toEqual(full);
    expect(matchScan(lines, full, "4820000000999")).toEqual({ kind: "not_found" });
    expect(matchScan(lines, full, "   ")).toEqual({ kind: "empty" });
  });

  it("several lines of the same variant fill in order; different variants with one code are ambiguous", () => {
    const split: ChecklistLine[] = [
      { id: "a", variantId: "v1", sku: "S", barcode: null, required: 1 },
      { id: "b", variantId: "v1", sku: "S", barcode: null, required: 1 },
    ];
    const one = applyScan(split, {}, "S");
    expect(one.match).toMatchObject({ kind: "matched", lineId: "a" });
    expect(applyScan(split, one.checklist, "S").match).toMatchObject({ kind: "matched", lineId: "b" });
    const clash: ChecklistLine[] = [
      { id: "a", variantId: "v1", sku: "DUP", barcode: null, required: 1 },
      { id: "b", variantId: "v2", sku: "DUP", barcode: null, required: 1 },
    ];
    expect(matchScan(clash, {}, "dup")).toEqual({ kind: "ambiguous", lineIds: ["a", "b"] });
  });

  it("lines with nothing left to ship are not matched", () => {
    const zero: ChecklistLine[] = [{ id: "z", variantId: "v1", sku: "Z", barcode: null, required: 0 }];
    expect(matchScan(zero, {}, "Z")).toEqual({ kind: "not_found" });
  });
});

describe("manual adjustment and progress", () => {
  it("+1/−1 stays within 0…required", () => {
    expect(adjustChecklist(lines, {}, "l2", -1)).toEqual({ kind: "below_zero" });
    const plus = adjustChecklist(lines, {}, "l2", 1);
    expect(plus).toMatchObject({ kind: "ok", packed: 1, checklist: { l2: 1 } });
    expect(adjustChecklist(lines, { l2: 1 }, "l2", 1)).toEqual({ kind: "over_quantity", packed: 1, required: 1 });
    const minus = adjustChecklist(lines, { l2: 1 }, "l2", -1);
    expect(minus).toMatchObject({ kind: "ok", packed: 0, checklist: {} });
    expect(adjustChecklist(lines, {}, "missing", 1)).toEqual({ kind: "unknown_line" });
  });

  it("units of lines removed from the order count as extra until removed", () => {
    const progress = checklistProgress(lines, { l1: 2, l2: 1, gone: 1 });
    expect(progress).toMatchObject({ requiredUnits: 3, packedUnits: 3, overUnits: 1, complete: false });
    const removed = adjustChecklist(lines, { l1: 2, l2: 1, gone: 1 }, "gone", -1);
    expect(removed.kind).toBe("ok");
    if (removed.kind === "ok") expect(checklistProgress(lines, removed.checklist).complete).toBe(true);
  });

  it("complete only when every line is exactly packed", () => {
    expect(checklistProgress(lines, { l1: 1, l2: 1 })).toMatchObject({ packedUnits: 2, complete: false, missing: [{ lineId: "l1", missing: 1 }] });
    expect(checklistProgress(lines, { l1: 2, l2: 1 })).toMatchObject({ packedUnits: 3, completeLines: 2, complete: true });
    expect(checklistProgress(lines, { l1: 3, l2: 1 })).toMatchObject({ packedUnits: 3, overUnits: 1, complete: false });
    expect(checklistProgress(lines, { l1: -5, l2: 1.5 } as Record<string, number>)).toMatchObject({ packedUnits: 0, complete: false });
    expect(checklistProgress([], {}).complete).toBe(true);
  });
});

describe("parcel mismatch with the waybill", () => {
  const snapshot = { parcels: [{ lengthCm: 35, widthCm: 25, heightCm: 8, actualWeightGrams: 1000 }] };
  const waybill = waybillParcel({ requestSnapshot: snapshot, actualWeightGrams: 1000 });

  it("reads the waybill parcel from the request snapshot (cm → mm)", () => {
    expect(waybill).toEqual({ weightGrams: 1000, dimsMm: [350, 250, 80] });
    expect(waybillParcel({ requestSnapshot: null, actualWeightGrams: null })).toEqual({ weightGrams: null, dimsMm: null });
    expect(waybillParcel({ requestSnapshot: { parcels: "x" }, actualWeightGrams: 500 })).toEqual({ weightGrams: 500, dimsMm: null });
  });

  it("weight ±10 % and each dimension ±10 mm (orientation does not matter)", () => {
    expect(compareParcels(waybill, { weightGrams: 1100, dimsMm: [80, 350, 250] })).toBeNull();
    expect(compareParcels(waybill, { weightGrams: 900, dimsMm: [360, 240, 90] })).toBeNull();
    expect(compareParcels(waybill, { weightGrams: 1101, dimsMm: null })).toEqual({ weight: { waybillGrams: 1000, packedGrams: 1101 }, dims: null });
    expect(compareParcels(waybill, { weightGrams: null, dimsMm: [200, 150, 80] })).toEqual({
      weight: null,
      dims: { waybillMm: [350, 250, 80], packedMm: [200, 150, 80] },
    });
  });

  it("nothing to compare → no warning", () => {
    expect(compareParcels({ weightGrams: null, dimsMm: null }, { weightGrams: 5000, dimsMm: [1, 1, 1] })).toBeNull();
    expect(compareParcels(waybill, { weightGrams: null, dimsMm: null })).toBeNull();
  });
});

describe("parcel form: box change and prefilled values (regression)", () => {
  const env: ParcelFormEnv = {
    boxes: [
      { id: "S", innerDimsMm: [200, 150, 80], tareWeightGrams: 120 },
      { id: "L", innerDimsMm: [400, 300, 200], tareWeightGrams: 300 },
      { id: "N", innerDimsMm: null, tareWeightGrams: 50 },
    ],
    goodsWeightGrams: 210,
    defaultTareGrams: 100,
  };
  const run = (state: ParcelFormState, ...actions: ParcelFormAction[]) => actions.reduce((s, a) => reduceParcelForm(env, s, a), state);
  /** Те, що надіслала б форма (значення + підказки) → що збереже сервер. */
  const submit = (state: ParcelFormState) =>
    resolveParcelForm({
      weightGrams: state.weight,
      lengthMm: state.dims[0],
      widthMm: state.dims[1],
      heightMm: state.dims[2],
      ...parcelPrefillMarkers(env, state),
    });

  it("prefill: box dimensions and goods + tare (default package tare without a box)", () => {
    expect(parcelPrefill(env.boxes[0]!, 210, 100)).toEqual({ weightGrams: 330, dimsMm: [200, 150, 80] });
    expect(parcelPrefill(null, 210, 100)).toEqual({ weightGrams: 310, dimsMm: null });
    expect(parcelPrefill(env.boxes[2]!, 0, 100)).toEqual({ weightGrams: null, dimsMm: null });
  });

  it("changing the box replaces untouched dimensions and weight with the new box's values", () => {
    const start = initialParcelForm(env, { boxId: "S", weightGrams: null, dimsMm: null });
    expect(start).toEqual({ boxId: "S", weight: "330", dims: ["200", "150", "80"], weightManual: false, dimsManual: false });
    const large = run(start, { type: "box", boxId: "L" });
    expect(large).toMatchObject({ boxId: "L", weight: "510", dims: ["400", "300", "200"] });
    expect(run(large, { type: "box", boxId: "none" })).toMatchObject({ weight: "310", dims: ["", "", ""] });
    expect(run(large, { type: "box", boxId: "N" })).toMatchObject({ weight: "260", dims: ["", "", ""] });
    // Нічого не введено вручну → зберігається лише коробка (габарити й вага — null: коробка й розрахунок).
    expect(submit(large)).toEqual({ weightGrams: null, lengthMm: null, widthMm: null, heightMm: null });
  });

  it("typed or saved values are kept on a box change and are saved as entered", () => {
    const typed = run(initialParcelForm(env, { boxId: "S", weightGrams: null, dimsMm: null }), { type: "weight", value: "345" }, { type: "dim", index: 2, value: "95" });
    const moved = run(typed, { type: "box", boxId: "L" });
    expect(moved).toMatchObject({ boxId: "L", weight: "345", dims: ["200", "150", "95"], weightManual: true, dimsManual: true });
    expect(submit(moved)).toEqual({ weightGrams: "345", lengthMm: "200", widthMm: "150", heightMm: "95" });
    const saved = initialParcelForm(env, { boxId: "S", weightGrams: 400, dimsMm: [210, 160, 90] });
    expect(saved).toMatchObject({ weight: "400", dims: ["210", "160", "90"], weightManual: true, dimsManual: true });
    expect(run(saved, { type: "box", boxId: "L" })).toMatchObject({ weight: "400", dims: ["210", "160", "90"] });
    // «Взяти габарити коробки» / «Взяти розрахунок» — знову автоматичні значення (не зберігаються як ручні).
    const reset = run(saved, { type: "box", boxId: "L" }, { type: "useBoxDims" }, { type: "useEstimate" });
    expect(reset).toMatchObject({ weight: "510", dims: ["400", "300", "200"], weightManual: false, dimsManual: false });
    expect(submit(reset)).toEqual({ weightGrams: null, lengthMm: null, widthMm: null, heightMm: null });
  });

  it("without JavaScript: the box changes but the old prefilled values equal their markers → not saved", () => {
    const start = initialParcelForm(env, { boxId: "S", weightGrams: null, dimsMm: null });
    const markers = parcelPrefillMarkers(env, start);
    expect(markers).toEqual({ weightPrefill: "330", dimsPrefill: "200x150x80" });
    // Вибрано L, але поля й підказки лишилися від S (сторінка без JS) — збережеться лише коробка L.
    expect(resolveParcelForm({ weightGrams: "330", lengthMm: "200", widthMm: "150", heightMm: "80", ...markers })).toEqual({
      weightGrams: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
    });
    // Змінене вручну поле ≠ підказці → зберігається; габарити — групою.
    expect(resolveParcelForm({ weightGrams: "331", lengthMm: "200", widthMm: "150", heightMm: "81", ...markers })).toEqual({
      weightGrams: "331",
      lengthMm: "200",
      widthMm: "150",
      heightMm: "81",
    });
    // Без підказок (старі форми / API) — усе як введено; порожні поля лишаються порожніми.
    expect(resolveParcelForm({ weightGrams: "330", lengthMm: "", widthMm: "", heightMm: "", weightPrefill: "", dimsPrefill: "" })).toEqual({
      weightGrams: "330",
      lengthMm: "",
      widthMm: "",
      heightMm: "",
    });
    expect(resolveParcelForm({ weightGrams: "330", lengthMm: "1", widthMm: "2", heightMm: "3", weightPrefill: "x", dimsPrefill: "1x2" })).toMatchObject({
      weightGrams: "330",
      lengthMm: "1",
    });
  });
});

describe("queue filters", () => {
  it("parses and rebuilds the query string", () => {
    const f = parseQueueFilters(new URLSearchParams("tab=packed&priority=2&country=de&model=Model%20X&color=&worker=u1&q=10&page=3"));
    expect(f).toEqual({ tab: "packed", priority: 2, country: "DE", model: "Model X", color: null, worker: "u1", q: "10", page: 3 });
    expect(activeFilterCount(f)).toBe(5);
    expect(parseQueueFilters(new URLSearchParams(buildQueueSearch(f)))).toEqual(f);
    expect(parseQueueFilters(new URLSearchParams("tab=bogus&priority=7&country=XYZ&page=-1"))).toMatchObject({
      tab: "queue",
      priority: null,
      country: null,
      page: 1,
    });
    expect(buildQueueSearch({ tab: "queue", priority: 0, page: 1 })).toBe("?priority=0");
  });

  it("priority and order ids are validated", () => {
    expect([parsePriority("0"), parsePriority("2"), parsePriority("3"), parsePriority("x"), parsePriority(undefined)]).toEqual([0, 2, null, null, null]);
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    expect(parseOrderIds([a.toUpperCase(), `${b},${a}`, "nope", 5], 10)).toEqual([a, b]);
    expect(parseOrderIds([`${a},${b}`], 1)).toEqual([a]);
  });
});

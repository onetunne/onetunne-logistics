import { describe, expect, it } from "vitest";
import {
  DEFAULT_FILL_FACTOR,
  fitsWithRotation,
  isSelectableBox,
  selectBox,
  sortedDims,
  type Box,
  type BoxSelectionItem,
} from "~/modules/packaging/box-selection";
import { computeKitMaterials, type KitTemplateForResolution } from "~/modules/packaging/kit-resolution";
import { chooseParcelPackage, type ParcelBoxPlan } from "~/modules/packaging/parcel";
import { kitTemplateInputSchema, materialInputSchema } from "~/modules/packaging/schemas";

/** Чисті функції WP «Упаковка»: підбір коробки, комплектація, джерело параметрів посилки, перевірка форм. */

let seq = 0;
function box(code: string, dims: [number, number, number] | null, extra: Partial<Box> = {}): Box {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    code,
    kind: "box",
    active: true,
    innerLengthMm: dims?.[0] ?? null,
    innerWidthMm: dims?.[1] ?? null,
    innerHeightMm: dims?.[2] ?? null,
    maxWeightGrams: null,
    tareWeightGrams: null,
    ...extra,
  };
}
const item = (dims: [number, number, number] | null, weightGrams: number | null, quantity = 1): BoxSelectionItem => ({
  lengthMm: dims?.[0] ?? null,
  widthMm: dims?.[1] ?? null,
  heightMm: dims?.[2] ?? null,
  weightGrams,
  quantity,
});

const S = box("box_s", [200, 150, 80], { maxWeightGrams: 2000, tareWeightGrams: 120 });
const M = box("box_m", [300, 200, 120], { maxWeightGrams: 5000, tareWeightGrams: 220 });
const L = box("box_l", [400, 300, 200], { maxWeightGrams: 10000, tareWeightGrams: 380 });
const MAILER = box("mailer_m", [340, 240, 50], { kind: "mailer", maxWeightGrams: 1000, tareWeightGrams: 30 });
const ALL = [L, MAILER, M, S];

describe("rotation helpers", () => {
  it("sorts dimensions descending and checks fit by rotation", () => {
    expect(sortedDims(80, 200, 150)).toEqual([200, 150, 80]);
    expect(fitsWithRotation(sortedDims(70, 190, 140), sortedDims(200, 150, 80))).toBe(true);
    expect(fitsWithRotation(sortedDims(210, 10, 10), sortedDims(200, 150, 80))).toBe(false);
    // Довгий плаский предмет лягає по діагоналі? Ні — лише повороти на 90°: 160 > 150 (друга вісь) не вміщується.
    expect(fitsWithRotation(sortedDims(190, 160, 10), sortedDims(200, 150, 80))).toBe(false);
  });

  it("only active box/mailer materials with all three inner dimensions are selectable", () => {
    expect(isSelectableBox(S)).toBe(true);
    expect(isSelectableBox(MAILER)).toBe(true);
    expect(isSelectableBox({ ...S, active: false })).toBe(false);
    expect(isSelectableBox({ ...S, kind: "sticker" })).toBe(false);
    expect(isSelectableBox({ ...S, innerHeightMm: null })).toBe(false);
    expect(isSelectableBox({ ...S, innerHeightMm: 0 })).toBe(false);
    expect(isSelectableBox({ ...S, maxWeightGrams: 0 })).toBe(false);
  });
});

describe("selectBox", () => {
  it("chooses the smallest-volume box that fits dimensions and weight", () => {
    const r = selectBox([item([180, 140, 70], 500)], ALL);
    expect(r).toMatchObject({ box: { code: "box_s" }, reason: "fits", candidates: 4 });
    expect(r.flags).toEqual({ missingDimensionsUnits: 0, missingWeightUnits: 0, outOfStock: false });
    expect(r.goods).toMatchObject({ units: 1, measuredUnits: 1, weightGrams: 500, volumeMm3: 180 * 140 * 70 });
  });

  it("uses rotation: an item given in any orientation fits the same box", () => {
    for (const dims of [
      [70, 180, 140],
      [140, 70, 180],
      [180, 70, 140],
    ] as Array<[number, number, number]>) {
      expect(selectBox([item(dims, 300)], ALL).box?.code).toBe("box_s");
    }
    // Плаский довгий товар: не вміщується в S (довжина), але вміщується в пакет-конверт (340×240×50) — він менший за M.
    expect(selectBox([item([320, 40, 230], 300)], ALL).box?.code).toBe("mailer_m");
  });

  it("respects max contents weight (tare excluded) and treats an empty max weight as no limit", () => {
    expect(selectBox([item([100, 100, 50], 2000)], ALL).box?.code).toBe("box_s"); // рівно макс. — підходить
    expect(selectBox([item([100, 100, 50], 2001)], ALL).box?.code).toBe("box_m");
    expect(selectBox([item([100, 100, 50], 9000)], ALL).box?.code).toBe("box_l");
    const noLimit = box("box_xs", [120, 120, 60]);
    expect(selectBox([item([100, 100, 50], 50_000)], [...ALL, noLimit]).box?.code).toBe("box_xs");
    // Пакет витримує 1000 г: важчий плаский товар (вміщується і в пакет, і в M) іде в M.
    expect(selectBox([item([290, 40, 190], 900)], ALL).box?.code).toBe("mailer_m");
    expect(selectBox([item([290, 40, 190], 1500)], ALL).box?.code).toBe("box_m");
  });

  it("applies the fill factor to the total volume of several items", () => {
    // Два товари по 190×140×70 окремо вміщуються в S, але разом (3,72 л) > 85 % від 2,4 л.
    const two = selectBox([item([190, 140, 70], 200, 2)], ALL);
    expect(two.box?.code).not.toBe("box_s");
    expect(two.box?.code).toBe("box_m");
    // Об'єм рівно на межі коефіцієнта (S: 2 400 000 мм³ × 0,85 = 2 040 000) — вміщується; на 1 мм³ більше — ні.
    expect(selectBox([item([200, 150, 68], 100)], [S]).box?.code).toBe("box_s");
    expect(selectBox([item([200, 150, 68], 100), item([1, 1, 1], 1)], [S]).box).toBeNull();
    expect(selectBox([item([190, 140, 70], 200, 2)], [S], { fillFactor: 1 }).box).toBeNull(); // 3,72 л > 2,4 л навіть при 100 %
    expect(DEFAULT_FILL_FACTOR).toBe(0.85);
  });

  it("reports why no box fits", () => {
    expect(selectBox([item([500, 100, 100], 100)], ALL)).toMatchObject({ box: null, reason: "too_large" });
    expect(selectBox([item([100, 100, 50], 20_000)], ALL)).toMatchObject({ box: null, reason: "too_heavy" });
    // Великий легкий і малий важкий кандидати: жоден не виконує обидві умови.
    const bigLight = box("big_light", [500, 500, 500], { maxWeightGrams: 1000 });
    const smallHeavy = box("small_heavy", [100, 100, 100], { maxWeightGrams: 50_000 });
    expect(selectBox([item([300, 300, 300], 5000)], [bigLight, smallHeavy])).toMatchObject({ box: null, reason: "no_single_box" });
    expect(selectBox([item([600, 600, 600], 60_000)], [bigLight, smallHeavy])).toMatchObject({ box: null, reason: "too_large" });
    expect(selectBox([], ALL)).toMatchObject({ box: null, reason: "no_items", candidates: 4 });
    expect(selectBox([item([10, 10, 10], 10, 0)], ALL)).toMatchObject({ box: null, reason: "no_items" });
    expect(selectBox([item([10, 10, 10], 10)], [])).toMatchObject({ box: null, reason: "no_boxes", candidates: 0 });
    expect(selectBox([item([10, 10, 10], 10)], [box("nodims", null), { ...S, active: false }, { ...S, kind: "card" }])).toMatchObject({
      box: null,
      reason: "no_boxes",
      candidates: 0,
    });
  });

  it("falls back to weight only for items without dimensions and flags it", () => {
    const none = selectBox([item(null, 1500)], ALL);
    expect(none).toMatchObject({ reason: "weight_only", box: { code: "box_s" } });
    expect(none.flags.missingDimensionsUnits).toBe(1);
    // Пакет менший за об'ємом, ніж M, але не витримує 1500 г.
    const partial = selectBox([item([180, 140, 70], 500), item([100, 100, null as unknown as number], 1600, 2)], ALL);
    expect(partial.reason).toBe("partial_dimensions");
    expect(partial.flags.missingDimensionsUnits).toBe(2);
    expect(partial.goods.weightGrams).toBe(500 + 3200);
    expect(partial.box?.code).toBe("box_m");
    // Товар без ваги рахується як 0 г і позначається.
    const noWeight = selectBox([item([100, 100, 50], null, 3)], ALL);
    expect(noWeight).toMatchObject({ reason: "fits", box: { code: "box_s" } });
    expect(noWeight.flags.missingWeightUnits).toBe(3);
  });

  it("ignores invalid item values instead of throwing", () => {
    const r = selectBox(
      [item([-1, 100, 100], -5), item([100.5, 100, 100], Number.NaN), item([100, 100, 100], 100, -2), item([100, 100, 100], 100, 1.5)],
      ALL,
    );
    expect(r.goods).toMatchObject({ units: 2, measuredUnits: 0, weightGrams: 0 });
    expect(r.reason).toBe("weight_only");
    expect(() => selectBox([item([1, 1, 1], 1)], ALL, { fillFactor: 0 })).toThrow(RangeError);
    expect(() => selectBox([item([1, 1, 1], 1)], ALL, { fillFactor: 1.2 })).toThrow(RangeError);
  });

  it("prefers boxes in stock but does not require stock", () => {
    const sOut = { ...S, inStock: false };
    const mIn = { ...M, inStock: true };
    const lIn = { ...L, inStock: true };
    expect(selectBox([item([180, 140, 70], 500)], [sOut, mIn, lIn])).toMatchObject({ box: { code: "box_m" }, flags: { outOfStock: false } });
    expect(selectBox([item([180, 140, 70], 500)], [sOut, mIn, lIn], { preferInStock: false }).box?.code).toBe("box_s");
    // Жодна придатна не в наявності → найменша придатна з позначкою.
    const r = selectBox([item([180, 140, 70], 500)], [sOut, { ...M, inStock: false }]);
    expect(r).toMatchObject({ box: { code: "box_s" }, flags: { outOfStock: true } });
    // Невідома наявність (undefined) вважається «є».
    expect(selectBox([item([180, 140, 70], 500)], [S, mIn]).box?.code).toBe("box_s");
  });

  it("breaks ties deterministically: volume, then tare, then longest side, then code, then id", () => {
    const a = box("b_a", [200, 100, 100], { tareWeightGrams: 50 });
    const b = box("b_b", [200, 100, 100], { tareWeightGrams: 40 });
    const c = box("b_c", [100, 100, 200], { tareWeightGrams: 40 }); // той самий об'єм і найбільша сторона
    const d = box("b_d", [400, 50, 100], { tareWeightGrams: 40 }); // той самий об'єм, довша сторона
    const items = [item([90, 90, 40], 100)];
    expect(selectBox(items, [a, b, c, d]).box?.code).toBe("b_b");
    expect(selectBox(items, [d, c, b, a]).box?.code).toBe("b_b");
    const sameCode1 = box("same", [200, 100, 100]);
    const sameCode2 = box("same", [200, 100, 100]);
    expect(selectBox(items, [sameCode2, sameCode1]).box?.id).toBe(sameCode1.id < sameCode2.id ? sameCode1.id : sameCode2.id);
    // Детермінованість: будь-яка перестановка кандидатів дає той самий результат.
    const perms = [
      [S, M, L, MAILER],
      [MAILER, L, M, S],
      [M, S, MAILER, L],
    ];
    for (const p of perms) expect(selectBox([item([150, 120, 60], 700, 2)], p).box?.code).toBe(selectBox([item([150, 120, 60], 700, 2)], ALL).box?.code);
  });

  it("returns the caller's box objects (generic)", () => {
    const boxes = [{ ...S, name: "Коробка S", onHand: 5 }];
    const r = selectBox([item([100, 100, 50], 100)], boxes);
    expect(r.box?.name).toBe("Коробка S");
  });
});

describe("chooseParcelPackage (waybill parcel source precedence)", () => {
  const defaultPkg = { code: "mailer_m", lengthCm: 35, widthCm: 25, heightCm: 8, tareWeightGrams: 70 };
  const noOverride = { parcelLengthMm: null, parcelWidthMm: null, parcelHeightMm: null };
  const auto: ParcelBoxPlan = {
    box: { source: "auto_box", materialId: "m-auto", code: "box_m", innerLengthMm: 300, innerWidthMm: 201, innerHeightMm: 120, tareWeightGrams: 220 },
    autoReason: "fits",
  };
  const manualBox: ParcelBoxPlan = {
    box: { source: "manual_box", materialId: "m-man", code: "box_l", innerLengthMm: 400, innerWidthMm: 300, innerHeightMm: 200, tareWeightGrams: null },
    autoReason: null,
  };

  it("manual dimensions win over any box; tare from a manually chosen box, else the default package", () => {
    const order = { parcelLengthMm: 301, parcelWidthMm: 200, parcelHeightMm: 95 };
    expect(chooseParcelPackage(order, defaultPkg, auto)).toEqual({
      pkg: { code: "mailer_m", lengthCm: 31, widthCm: 20, heightCm: 10, tareWeightGrams: 70 },
      source: "manual",
      boxMaterialId: null,
    });
    expect(chooseParcelPackage(order, defaultPkg, manualBox)).toEqual({
      pkg: { code: "box_l", lengthCm: 31, widthCm: 20, heightCm: 10, tareWeightGrams: 0 },
      source: "manual",
      boxMaterialId: "m-man",
    });
  });

  it("incomplete manual dimensions are ignored; then the chosen box (inner dims → cm up, tare); else the default package", () => {
    expect(chooseParcelPackage({ ...noOverride, parcelLengthMm: 500 }, defaultPkg, auto)).toEqual({
      pkg: { code: "box_m", lengthCm: 30, widthCm: 21, heightCm: 12, tareWeightGrams: 220 },
      source: "auto_box",
      boxMaterialId: "m-auto",
    });
    expect(chooseParcelPackage(noOverride, defaultPkg, manualBox).source).toBe("manual_box");
    expect(chooseParcelPackage(noOverride, defaultPkg, { box: null, autoReason: "weight_only" })).toEqual({
      pkg: defaultPkg,
      source: "default_package",
      boxMaterialId: null,
    });
    expect(chooseParcelPackage(noOverride, defaultPkg, null).source).toBe("default_package");
  });
});

describe("computeKitMaterials", () => {
  const tpl = (id: string, extra: Partial<KitTemplateForResolution>): KitTemplateForResolution => ({
    id,
    appliesTo: "all",
    priority: 0,
    active: true,
    productIds: [],
    lines: [],
    ...extra,
  });
  const general = tpl("t-general", { lines: [{ materialId: "sticker", quantity: 1, per: "order" }, { materialId: "card", quantity: 1, per: "order" }] });
  const fender = tpl("t-fender", {
    appliesTo: "products",
    priority: 10,
    productIds: ["p-fender"],
    lines: [
      { materialId: "bolts", quantity: 2, per: "item" },
      { materialId: "instruction", quantity: 1, per: "order" },
    ],
  });
  const perItemAll = tpl("t-tape", { priority: -1, lines: [{ materialId: "sticker", quantity: 1, per: "item" }] });

  it("combines every matching active template; per item uses units of the template's products only", () => {
    const lines = [
      { productId: "p-fender", quantity: 3, currentQuantity: 2 }, // 1 одиницю повернено → 2
      { productId: "p-holder", quantity: 1 },
      { productId: null, quantity: 5 }, // позиція без варіанта не рахується
    ];
    expect(computeKitMaterials([general, fender, perItemAll], lines)).toEqual([
      { materialId: "bolts", quantity: 4, templateIds: ["t-fender"] },
      { materialId: "instruction", quantity: 1, templateIds: ["t-fender"] },
      { materialId: "card", quantity: 1, templateIds: ["t-general"] },
      // наклейка: 1 на замовлення (general) + 1 × 3 одиниці (усі товари з варіантом)
      { materialId: "sticker", quantity: 4, templateIds: ["t-general", "t-tape"] },
    ]);
  });

  it("skips product templates without matching units, inactive templates and inactive materials", () => {
    expect(computeKitMaterials([fender], [{ productId: "p-holder", quantity: 2 }])).toEqual([]);
    expect(computeKitMaterials([fender], [{ productId: "p-fender", quantity: 2, currentQuantity: 0 }])).toEqual([]);
    expect(computeKitMaterials([{ ...general, active: false }], [{ productId: "p-holder", quantity: 1 }])).toEqual([]);
    const withInactive = tpl("t-x", { lines: [{ materialId: "old", quantity: 1, per: "order", materialActive: false }, { materialId: "card", quantity: 2, per: "order" }] });
    expect(computeKitMaterials([withInactive], [{ productId: "p", quantity: 1 }])).toEqual([{ materialId: "card", quantity: 2, templateIds: ["t-x"] }]);
  });

  it("returns nothing for an order without physical units", () => {
    expect(computeKitMaterials([general], [])).toEqual([]);
    expect(computeKitMaterials([general], [{ productId: "p", quantity: 2, currentQuantity: 0 }])).toEqual([]);
    expect(computeKitMaterials([general], [{ productId: null, quantity: 2 }])).toEqual([]);
  });

  it("is deterministic regardless of template order", () => {
    const lines = [{ productId: "p-fender", quantity: 1 }];
    expect(computeKitMaterials([perItemAll, fender, general], lines)).toEqual(computeKitMaterials([general, fender, perItemAll], lines));
  });
});

describe("computeKitMaterials: collections and variant filters (resolution precedence)", () => {
  const tpl = (id: string, extra: Partial<KitTemplateForResolution>): KitTemplateForResolution => ({
    id,
    appliesTo: "all",
    priority: 0,
    active: true,
    productIds: [],
    lines: [{ materialId: `m-${id}`, quantity: 1, per: "item" }],
    ...extra,
  });
  const fenderX = { productId: "p-fender", quantity: 2, model: "Model X", color: null, collectionIds: ["c-fenders", "c-safety"] };
  const fenderS = { productId: "p-fender", quantity: 1, model: " model s ", color: null, collectionIds: ["c-fenders", "c-safety"] };
  const holderBlack = { productId: "p-holder", quantity: 3, model: null, color: "Чорний", collectionIds: ["c-handlebar"] };
  const qty = (r: ReturnType<typeof computeKitMaterials>, id: string) => r.find((x) => x.materialId === `m-${id}`)?.quantity ?? 0;

  it("collection target: units of products in any chosen collection, each line counted once", () => {
    const fenders = tpl("fenders", { appliesTo: "collections", collectionIds: ["c-fenders", "c-safety"] });
    const r = computeKitMaterials([fenders], [fenderX, fenderS, holderBlack]);
    expect(qty(r, "fenders")).toBe(3); // 2 + 1, не 6 (товар у двох колекціях шаблону)
    expect(computeKitMaterials([fenders], [holderBlack])).toEqual([]);
    // Позиція без колекцій (товар ще не синхронізовано / не в колекції) — шаблон не підходить.
    expect(computeKitMaterials([fenders], [{ productId: "p-fender", quantity: 1 }])).toEqual([]);
  });

  it("model/colour filter narrows any target (trimmed, case-insensitive); both filters are AND", () => {
    const sOnly = tpl("s", { appliesTo: "collections", collectionIds: ["c-fenders"], models: ["Model S"] });
    expect(qty(computeKitMaterials([sOnly], [fenderX, fenderS]), "s")).toBe(1);
    expect(computeKitMaterials([sOnly], [fenderX])).toEqual([]);
    const allBlack = tpl("black", { colors: ["чорний"] }); // ціль «усі товари» + фільтр кольору
    expect(qty(computeKitMaterials([allBlack], [fenderX, holderBlack]), "black")).toBe(3);
    const both = tpl("both", { models: ["Model X"], colors: ["Чорний"] });
    expect(computeKitMaterials([both], [fenderX, holderBlack])).toEqual([]); // жоден варіант не має обох
    const products = tpl("prod", { appliesTo: "products", productIds: ["p-fender"], models: ["Model X", "Model S"] });
    expect(qty(computeKitMaterials([products], [fenderX, fenderS, holderBlack]), "prod")).toBe(3);
    // Варіант без моделі не підпадає під фільтр моделі.
    expect(computeKitMaterials([tpl("m", { models: ["Model X"] })], [holderBlack])).toEqual([]);
  });

  it("a specific template never replaces a general one: all matching templates add up (priority = display order only)", () => {
    const general = tpl("g", { lines: [{ materialId: "bolts", quantity: 1, per: "item" }] });
    const specific = tpl("sp", { appliesTo: "collections", collectionIds: ["c-fenders"], models: ["Model S"], priority: 50, lines: [{ materialId: "bolts", quantity: 1, per: "item" }] });
    expect(computeKitMaterials([general, specific], [fenderS])).toEqual([{ materialId: "bolts", quantity: 2, templateIds: ["sp", "g"] }]);
    expect(computeKitMaterials([general, specific], [fenderX])).toEqual([{ materialId: "bolts", quantity: 2, templateIds: ["g"] }]);
  });
});

describe("form schemas", () => {
  const base = { code: " Box_M ", name: " Коробка ", kind: "box", unit: "pcs", innerLengthMm: "300", innerWidthMm: "200", innerHeightMm: "120", maxWeightGrams: "", tareWeightGrams: "0", lowStockThreshold: "" };

  it("normalizes material input and validates dimensions as all-or-none", () => {
    expect(materialInputSchema.parse(base)).toMatchObject({ code: "box_m", name: "Коробка", innerLengthMm: 300, maxWeightGrams: null, tareWeightGrams: 0, lowStockThreshold: null, active: true });
    const r = materialInputSchema.safeParse({ ...base, innerHeightMm: "" });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => [i.path.join("."), i.message])).toEqual([["innerHeightMm", "packaging.error.dimsIncomplete"]]);
    expect(materialInputSchema.safeParse({ ...base, code: "Коробка" }).success).toBe(false);
    expect(materialInputSchema.safeParse({ ...base, unitCost: "12,5" }).error?.issues[0]?.message).toBe("packaging.error.currencyRequired");
    expect(materialInputSchema.parse({ ...base, unitCost: "12,5", costCurrency: "uah" })).toMatchObject({ unitCost: "12.5", costCurrency: "UAH" });
  });

  it("validates kit templates: lines required, duplicates rejected, products required for product templates", () => {
    const m = "11111111-1111-4111-8111-111111111111";
    expect(kitTemplateInputSchema.safeParse({ name: "A", appliesTo: "all", priority: "", lines: [] }).error?.issues[0]?.message).toBe("packaging.error.kitNoLines");
    const dup = kitTemplateInputSchema.safeParse({
      name: "A",
      appliesTo: "all",
      lines: [
        { materialId: m, quantity: "1", per: "order" },
        { materialId: m, quantity: "2", per: "order" },
      ],
    });
    expect(dup.error?.issues.map((i) => i.path.join("."))).toEqual(["lines.1.materialId"]);
    expect(
      kitTemplateInputSchema.safeParse({ name: "A", appliesTo: "products", lines: [{ materialId: m, quantity: "1", per: "item" }], productIds: [] }).error?.issues[0]?.message,
    ).toBe("packaging.error.kitNoProducts");
    expect(kitTemplateInputSchema.parse({ name: "A", appliesTo: "all", priority: "5", lines: [{ materialId: m, quantity: "3", per: "item" }] })).toMatchObject({
      priority: 5,
      lines: [{ quantity: 3, per: "item" }],
      collectionIds: [],
      models: [],
      colors: [],
    });
  });

  it("validates collection templates and normalizes the model/colour filter", () => {
    const m = "11111111-1111-4111-8111-111111111111";
    const line = [{ materialId: m, quantity: "1", per: "item" }];
    expect(kitTemplateInputSchema.safeParse({ name: "A", appliesTo: "collections", lines: line, collectionIds: [] }).error?.issues[0]?.message).toBe(
      "packaging.error.kitNoCollections",
    );
    expect(
      kitTemplateInputSchema.parse({ name: "A", appliesTo: "collections", lines: line, collectionIds: [m.toUpperCase()], models: [" Model S ", "model s", ""], colors: ["Чорний"] }),
    ).toMatchObject({ collectionIds: [m], models: ["Model S"], colors: ["Чорний"] });
    expect(kitTemplateInputSchema.safeParse({ name: "A", appliesTo: "all", lines: line, models: ["x".repeat(256)] }).success).toBe(false);
    expect(kitTemplateInputSchema.safeParse({ name: "A", appliesTo: "all", lines: line, models: Array.from({ length: 51 }, (_, i) => `M${i}`) }).success).toBe(false);
    expect(kitTemplateInputSchema.safeParse({ name: "A", appliesTo: "bogus", lines: line }).success).toBe(false);
  });
});

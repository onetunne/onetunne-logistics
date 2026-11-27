/**
 * Автоматичний підбір коробки (чиста функція, без БД) — docs/stage5-design.md §5.
 *
 * Правило: з активних коробок і пакетів (kind box | mailer) з ВІДОМИМИ внутрішніми габаритами обирається найменша
 * за внутрішнім об'ємом, яка:
 * 1. витримує вагу товарів: Σ(вага × кількість) ≤ max_weight_grams (не задано → обмеження немає). Вага тари сюди
 *    не входить: max_weight — допустима вага вмісту;
 * 2. вміщує КОЖЕН товар з габаритами окремо з урахуванням поворотів: габарити товару й коробки сортуються за
 *    спаданням і порівнюються попарно (a1 ≤ b1, a2 ≤ b2, a3 ≤ b3) — необхідна й достатня умова для поворотів
 *    на 90° навколо осей;
 * 3. вміщує сумарний об'єм товарів з урахуванням коефіцієнта заповнення: Σ об'ємів ≤ об'єм коробки × fillFactor
 *    (типово 0,85). Це ЕВРИСТИКА, а не розв'язання задачі укладання: кілька товарів, що проходять перевірку, на
 *    практиці можуть не скластися; результат — підказка пакувальнику, якого він може змінити.
 *
 * Товари без габаритів (хоча б одного з трьох) враховуються лише вагою (запасний варіант «лише за вагою»), а
 * результат позначається: `partial_dimensions` (частина товарів без габаритів) або `weight_only` (жоден товар не має
 * габаритів). Такий підбір неточний — створення накладної його НЕ використовує (див. parcel.ts).
 * Товар без ваги (null або ≤ 0) рахується як 0 г і позначається у flags.missingWeightUnits.
 *
 * Наявність на складі: за замовчуванням (preferInStock) спершу шукається найменша коробка, що є в наявності
 * (`inStock !== false`); якщо жодна з придатних не в наявності — найменша придатна загалом з позначкою
 * flags.outOfStock. Наявність не обов'язкова: підбір працює й без обліку матеріалів.
 *
 * Детермінованість (однакові вхідні дані → та сама коробка): порядок кандидатів — [у наявності] → об'єм ↑ →
 * вага тари ↑ (не задано = 0) → найбільший внутрішній габарит ↑ → code ↑ → id ↑. Порядок у вхідному масиві
 * значення не має. Усі порівняння — цілі числа (об'єм і коефіцієнт заповнення — BigInt, без похибок float).
 */
import type { PackagingMaterialKind } from "~/db/schema";

export const DEFAULT_FILL_FACTOR = 0.85;

/** Види матеріалів, які можуть бути транспортною упаковкою посилки. */
export const BOX_KINDS: readonly PackagingMaterialKind[] = ["box", "mailer"];

export interface BoxSelectionItem {
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  weightGrams: number | null;
  quantity: number;
}

export interface Box {
  id: string;
  code: string;
  kind: PackagingMaterialKind;
  active: boolean;
  innerLengthMm: number | null;
  innerWidthMm: number | null;
  innerHeightMm: number | null;
  /** Допустима вага вмісту, г. null — без обмеження. */
  maxWeightGrams: number | null;
  /** Вага самої коробки, г. null — невідомо (рахується як 0). */
  tareWeightGrams: number | null;
  /** Є на складі (on_hand > 0). undefined — невідомо (вважається «є»). */
  inStock?: boolean;
}

export interface SelectBoxOptions {
  /** Частка внутрішнього об'єму, яку можна заповнити товарами: (0; 1]. Типово 0,85. */
  fillFactor?: number;
  /** Спершу коробки, що є на складі. Типово true. */
  preferInStock?: boolean;
}

export type SelectBoxSuccessReason =
  /** Усі товари мають габарити й вагу перевірено. */
  | "fits"
  /** Частина товарів без габаритів: вони враховані лише вагою (неточно). */
  | "partial_dimensions"
  /** Жоден товар не має габаритів: підбір лише за вагою (неточно). */
  | "weight_only";

export type SelectBoxFailureReason =
  /** Немає товарів з кількістю > 0. */
  | "no_items"
  /** Немає активних коробок/пакетів із заданими внутрішніми габаритами. */
  | "no_boxes"
  /** Жодна коробка не витримує вагу товарів. */
  | "too_heavy"
  /** Жодна коробка не вміщує товари (габарити або об'єм); вага може теж перевищувати. */
  | "too_large"
  /** Вагу витримують одні коробки, габарити вміщують інші, але жодна — обидва. */
  | "no_single_box";

export type SelectBoxReason = SelectBoxSuccessReason | SelectBoxFailureReason;

export const SELECT_BOX_REASONS: readonly SelectBoxReason[] = [
  "fits",
  "partial_dimensions",
  "weight_only",
  "no_items",
  "no_boxes",
  "too_heavy",
  "too_large",
  "no_single_box",
];

export interface SelectBoxFlags {
  /** Одиниць товару без габаритів (враховані лише вагою). */
  missingDimensionsUnits: number;
  /** Одиниць товару без ваги (враховані як 0 г). */
  missingWeightUnits: number;
  /** Обрана коробка не в наявності (inStock = false). */
  outOfStock: boolean;
}

export interface GoodsSummary {
  /** Одиниць товару (кількість > 0). */
  units: number;
  /** З них — з габаритами. */
  measuredUnits: number;
  /** Вага товарів без тари, г. */
  weightGrams: number;
  /** Сумарний об'єм товарів з габаритами, мм³. */
  volumeMm3: number;
}

export type SelectBoxResult<B extends Box = Box> =
  | { box: B; reason: SelectBoxSuccessReason; flags: SelectBoxFlags; goods: GoodsSummary; candidates: number }
  | { box: null; reason: SelectBoxFailureReason; flags: SelectBoxFlags; goods: GoodsSummary; candidates: number };

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Габарити за спаданням (для перевірки з поворотами). */
export function sortedDims(a: number, b: number, c: number): [number, number, number] {
  const s = [a, b, c].sort((x, y) => y - x);
  return [s[0]!, s[1]!, s[2]!];
}

/** Чи вміщується предмет (габарити за спаданням) у порожнину (габарити за спаданням) з поворотами на 90°. */
export function fitsWithRotation(item: readonly [number, number, number], cavity: readonly [number, number, number]): boolean {
  return item[0] <= cavity[0] && item[1] <= cavity[1] && item[2] <= cavity[2];
}

/** Повні внутрішні габарити коробки (за спаданням) або null. */
export function boxInnerDims(box: Pick<Box, "innerLengthMm" | "innerWidthMm" | "innerHeightMm">): [number, number, number] | null {
  const { innerLengthMm: l, innerWidthMm: w, innerHeightMm: h } = box;
  return isPositiveInt(l) && isPositiveInt(w) && isPositiveInt(h) ? sortedDims(l, w, h) : null;
}

/** Коробка може брати участь в автоматичному підборі. */
export function isSelectableBox(box: Box): boolean {
  if (!box.active || !BOX_KINDS.includes(box.kind)) return false;
  if (box.maxWeightGrams !== null && !isPositiveInt(box.maxWeightGrams)) return false;
  return boxInnerDims(box) !== null;
}

function fillBasisPoints(fillFactor: number | undefined): bigint {
  const f = fillFactor ?? DEFAULT_FILL_FACTOR;
  if (typeof f !== "number" || !Number.isFinite(f) || f <= 0 || f > 1) {
    throw new RangeError(`fillFactor must be in (0, 1], got ${String(fillFactor)}`);
  }
  return BigInt(Math.round(f * 10_000));
}

interface Prepared<B extends Box> {
  box: B;
  dims: [number, number, number];
  volume: bigint;
  weightOk: boolean;
  dimsOk: boolean;
}

function compareCandidates<B extends Box>(a: Prepared<B>, b: Prepared<B>, preferInStock: boolean): number {
  if (preferInStock) {
    const sa = a.box.inStock === false ? 1 : 0;
    const sb = b.box.inStock === false ? 1 : 0;
    if (sa !== sb) return sa - sb;
  }
  if (a.volume !== b.volume) return a.volume < b.volume ? -1 : 1;
  const ta = a.box.tareWeightGrams ?? 0;
  const tb = b.box.tareWeightGrams ?? 0;
  if (ta !== tb) return ta - tb;
  if (a.dims[0] !== b.dims[0]) return a.dims[0] - b.dims[0];
  if (a.box.code !== b.box.code) return a.box.code < b.box.code ? -1 : 1;
  return a.box.id < b.box.id ? -1 : a.box.id > b.box.id ? 1 : 0;
}

/**
 * Підбирає коробку для товарів (див. правило вгорі файлу). Ніколи не кидає помилок через дані товарів/коробок
 * (некоректні значення вважаються відсутніми); RangeError — лише для некоректного fillFactor.
 */
export function selectBox<B extends Box>(
  items: readonly BoxSelectionItem[],
  boxes: readonly B[],
  opts: SelectBoxOptions = {},
): SelectBoxResult<B> {
  const fillBp = fillBasisPoints(opts.fillFactor);
  const preferInStock = opts.preferInStock ?? true;

  let units = 0;
  let measuredUnits = 0;
  let weight = 0;
  let missingWeightUnits = 0;
  let volume = 0n;
  const measured: Array<[number, number, number]> = [];
  for (const item of items) {
    const q = item.quantity;
    if (!isPositiveInt(q)) continue;
    units += q;
    if (isPositiveInt(item.weightGrams)) weight += item.weightGrams * q;
    else missingWeightUnits += q;
    if (isPositiveInt(item.lengthMm) && isPositiveInt(item.widthMm) && isPositiveInt(item.heightMm)) {
      measuredUnits += q;
      const dims = sortedDims(item.lengthMm, item.widthMm, item.heightMm);
      measured.push(dims);
      volume += BigInt(dims[0]) * BigInt(dims[1]) * BigInt(dims[2]) * BigInt(q);
    }
  }
  const goods: GoodsSummary = { units, measuredUnits, weightGrams: weight, volumeMm3: Number(volume) };
  const flags: SelectBoxFlags = { missingDimensionsUnits: units - measuredUnits, missingWeightUnits, outOfStock: false };

  const selectable = boxes.filter(isSelectableBox);
  const candidates = selectable.length;
  if (units === 0) return { box: null, reason: "no_items", flags, goods, candidates };
  if (selectable.length === 0) return { box: null, reason: "no_boxes", flags, goods, candidates };

  const prepared: Array<Prepared<B>> = selectable.map((box) => {
    const dims = boxInnerDims(box)!;
    const boxVolume = BigInt(dims[0]) * BigInt(dims[1]) * BigInt(dims[2]);
    return {
      box,
      dims,
      volume: boxVolume,
      weightOk: box.maxWeightGrams === null || weight <= box.maxWeightGrams,
      dimsOk: measured.every((d) => fitsWithRotation(d, dims)) && volume * 10_000n <= boxVolume * fillBp,
    };
  });

  const fitting = prepared.filter((p) => p.weightOk && p.dimsOk).sort((a, b) => compareCandidates(a, b, preferInStock));
  const best = fitting[0];
  if (!best) {
    const anyWeight = prepared.some((p) => p.weightOk);
    const anyDims = prepared.some((p) => p.dimsOk);
    // Не вміщує жодна коробка (навіть якщо й вага завелика) → too_large; лише вага → too_heavy;
    // кожну умову виконує якась коробка, але не одна й та сама → no_single_box.
    const reason: SelectBoxFailureReason = !anyDims ? "too_large" : !anyWeight ? "too_heavy" : "no_single_box";
    return { box: null, reason, flags, goods, candidates };
  }
  flags.outOfStock = best.box.inStock === false;
  const reason: SelectBoxSuccessReason = measuredUnits === units ? "fits" : measuredUnits === 0 ? "weight_only" : "partial_dimensions";
  return { box: best.box, reason, flags, goods, candidates };
}

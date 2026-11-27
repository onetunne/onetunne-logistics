/**
 * Форма «Коробка й посилка» на екрані пакування — чисті функції для сторінки (стан форми) і сервера (що зберігати).
 *
 * Поля ваги й габаритів заповнюються наперед: габарити — внутрішні габарити вибраної коробки, вага — розрахунок
 * (товари + тара коробки, без коробки — тара типової упаковки). Підставлене автоматично — НЕ ручне коригування:
 * у orders.parcel_* зберігається лише те, що пакувальник ввів сам (або вже зберіг раніше). Інакше нова коробка
 * збереглася б зі старими габаритами, а ручні габарити мають пріоритет над коробкою для накладної.
 *
 * Тому форма надсилає поруч зі значеннями підказки (weightPrefill / dimsPrefill) — значення, підставлені
 * автоматично. Поле, що дорівнює своїй підказці, зберігається як порожнє (null): накладна далі бере габарити
 * коробки й розрахункову вагу. Працює й без JavaScript: змінене вручну поле ≠ підказці; зміна коробки без JavaScript
 * лишає старі підставлені значення, але вони дорівнюють старій підказці → не зберігаються.
 * З JavaScript зміна коробки оновлює поля, яких пакувальник не змінював (reduceParcelForm).
 */
import type { Dims } from "./parcel-compare";

export interface PrefillBox {
  id: string;
  innerDimsMm: Dims | null;
  tareWeightGrams: number | null;
}

export interface ParcelPrefill {
  /** Розрахункова вага (товари + тара) або null, якщо ваги товарів невідомі. */
  weightGrams: number | null;
  /** Внутрішні габарити коробки або null (без коробки / коробка без габаритів). */
  dimsMm: Dims | null;
}

/** Дані для розрахунку підказок (з екрана пакування). */
export interface ParcelFormEnv {
  boxes: readonly PrefillBox[];
  /** Вага товарів посилки, г (ті самі позиції й кількості, що й для накладної). */
  goodsWeightGrams: number;
  /** Тара типової упаковки з налаштувань (посилка без коробки). */
  defaultTareGrams: number;
}

export const NO_BOX = "none";

export function parcelPrefill(box: Pick<PrefillBox, "innerDimsMm" | "tareWeightGrams"> | null, goodsWeightGrams: number, defaultTareGrams: number): ParcelPrefill {
  const tare = box ? (box.tareWeightGrams ?? 0) : defaultTareGrams;
  return { weightGrams: goodsWeightGrams > 0 ? goodsWeightGrams + tare : null, dimsMm: box?.innerDimsMm ?? null };
}

export function prefillForBox(env: ParcelFormEnv, boxId: string | null): ParcelPrefill {
  const box = boxId && boxId !== NO_BOX ? (env.boxes.find((b) => b.id === boxId) ?? null) : null;
  return parcelPrefill(box, env.goodsWeightGrams, env.defaultTareGrams);
}

// ---------------------------------------------------------------------------
// Стан форми (сторінка)
// ---------------------------------------------------------------------------

export type DimsInput = [string, string, string];

export interface ParcelFormState {
  /** Ідентифікатор коробки або "none". */
  boxId: string;
  weight: string;
  dims: DimsInput;
  /** Вагу введено (або збережено раніше) вручну — зміна коробки її не змінює. */
  weightManual: boolean;
  /** Габарити введено (або збережено раніше) вручну — зміна коробки їх не змінює. */
  dimsManual: boolean;
}

export type ParcelFormAction =
  | { type: "box"; boxId: string }
  | { type: "weight"; value: string }
  | { type: "dim"; index: 0 | 1 | 2; value: string }
  /** Повернути габарити вибраної коробки (скасувати ручні габарити). */
  | { type: "useBoxDims" }
  /** Повернути розрахункову вагу (скасувати ручну вагу). */
  | { type: "useEstimate" };

const str = (v: number | null | undefined): string => (v === null || v === undefined ? "" : String(v));
const dimsInput = (d: Dims | null): DimsInput => (d ? [String(d[0]), String(d[1]), String(d[2])] : ["", "", ""]);

/** Початковий стан: збережені вручну значення, інакше підказки для коробки пакування. */
export function initialParcelForm(
  env: ParcelFormEnv,
  saved: { boxId: string | null; weightGrams: number | null; dimsMm: Dims | null },
): ParcelFormState {
  const boxId = saved.boxId ?? NO_BOX;
  const prefill = prefillForBox(env, boxId);
  return {
    boxId,
    weight: saved.weightGrams !== null ? String(saved.weightGrams) : str(prefill.weightGrams),
    dims: saved.dimsMm ? dimsInput(saved.dimsMm) : dimsInput(prefill.dimsMm),
    weightManual: saved.weightGrams !== null,
    dimsManual: saved.dimsMm !== null,
  };
}

export function reduceParcelForm(env: ParcelFormEnv, state: ParcelFormState, action: ParcelFormAction): ParcelFormState {
  switch (action.type) {
    case "box": {
      const prefill = prefillForBox(env, action.boxId);
      return {
        ...state,
        boxId: action.boxId,
        weight: state.weightManual ? state.weight : str(prefill.weightGrams),
        dims: state.dimsManual ? state.dims : dimsInput(prefill.dimsMm),
      };
    }
    case "weight":
      return { ...state, weight: action.value, weightManual: true };
    case "dim": {
      const dims: DimsInput = [...state.dims];
      dims[action.index] = action.value;
      return { ...state, dims, dimsManual: true };
    }
    case "useBoxDims":
      return { ...state, dims: dimsInput(prefillForBox(env, state.boxId).dimsMm), dimsManual: false };
    case "useEstimate":
      return { ...state, weight: str(prefillForBox(env, state.boxId).weightGrams), weightManual: false };
  }
}

export function formatDimsPrefill(d: Dims | null): string {
  return d ? `${d[0]}x${d[1]}x${d[2]}` : "";
}

/** Підказки, що надсилаються з формою: порожньо — поле введено вручну (зберігається як є). */
export function parcelPrefillMarkers(env: ParcelFormEnv, state: ParcelFormState): { weightPrefill: string; dimsPrefill: string } {
  const prefill = prefillForBox(env, state.boxId);
  return {
    weightPrefill: state.weightManual ? "" : str(prefill.weightGrams),
    dimsPrefill: state.dimsManual ? "" : formatDimsPrefill(prefill.dimsMm),
  };
}

// ---------------------------------------------------------------------------
// Сервер: що зберігати
// ---------------------------------------------------------------------------

export interface ParcelFormFields {
  weightGrams: string;
  lengthMm: string;
  widthMm: string;
  heightMm: string;
  weightPrefill: string;
  dimsPrefill: string;
}

export interface ParcelFormValues {
  weightGrams: string | null;
  lengthMm: string | null;
  widthMm: string | null;
  heightMm: string | null;
}

const DIMS_PREFILL_RE = /^(\d{1,6})x(\d{1,6})x(\d{1,6})$/;

/** Ціле значення поля дорівнює підказці (обидва непорожні). */
function samePrefilled(value: string, prefill: string): boolean {
  const v = value.trim();
  const p = prefill.trim();
  return /^\d{1,9}$/.test(v) && /^\d{1,9}$/.test(p) && Number(v) === Number(p);
}

/**
 * Значення форми → вхід savePackingParcel: незмінене підставлене значення — null (не ручне коригування).
 * Габарити — група: якщо змінено хоч один, зберігаються всі три як введені.
 */
export function resolveParcelForm(f: ParcelFormFields): ParcelFormValues {
  const weightAuto = samePrefilled(f.weightGrams, f.weightPrefill);
  const m = DIMS_PREFILL_RE.exec(f.dimsPrefill.trim());
  const prefillDims = m ? [m[1]!, m[2]!, m[3]!] : null;
  const dimsAuto = prefillDims !== null && [f.lengthMm, f.widthMm, f.heightMm].every((v, i) => samePrefilled(v, prefillDims[i]!));
  return {
    weightGrams: weightAuto ? null : f.weightGrams,
    lengthMm: dimsAuto ? null : f.lengthMm,
    widthMm: dimsAuto ? null : f.widthMm,
    heightMm: dimsAuto ? null : f.heightMm,
  };
}

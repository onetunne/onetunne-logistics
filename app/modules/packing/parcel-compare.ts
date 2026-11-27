/**
 * Розбіжність посилки з накладною (чиста функція): накладну створено з одними вагою/габаритами, а запаковано
 * інакше (інша коробка, зважена вага). Допуск: вага ±10 % від ваги в накладній, кожен габарит ±10 мм.
 * Габарити порівнюються без урахування орієнтації (за спаданням). Порівнюються лише відомі значення з обох боків.
 *
 * Дані накладної: знімок запиту (shipments.request_snapshot.parcels[0]: см і г) або shipments.actual_weight_grams.
 * Ручне прив'язування (без знімка) — порівнювати нічого (null).
 *
 * Габарити-«заглушка»: якщо накладну створено з габаритами ТИПОВОЇ упаковки (знімок parcelSource = default_package
 * або manual_box_default_dims — габарити товарів/коробки були невідомі), задеклароване — це верхня межа, а не вимір.
 * Тоді розбіжністю габаритів вважається лише посилка, БІЛЬША за задекларовану (хоч один габарит понад допуск):
 * менша посилка (напр. рекомендована ★ коробка S у накладній з типовим пакетом) перевізника не порушує й
 * переоформлення не потребує. Вага порівнюється як завжди (±10 %).
 */
import { PARCEL_DIMENSION_TOLERANCE_MM, PARCEL_WEIGHT_TOLERANCE_PERCENT } from "./constants";

export type Dims = [number, number, number];

export interface ParcelMeasure {
  weightGrams: number | null;
  /** Габарити, мм (будь-який порядок). */
  dimsMm: Dims | null;
  /**
   * Лише для накладної: габарити — типової упаковки (не виміряні), тобто верхня межа. Розбіжність — лише більша посилка.
   */
  dimsUpperBound?: boolean;
}

export interface ParcelMismatch {
  weight: {
    waybillGrams: number;
    packedGrams: number;
    /**
     * Зважена вага менша за 90 % ваги товарів за даними Shopify і не підтверджена власником — нова накладна її теж
     * не використає (buildShipmentRequest надішле розрахункову), тож переоформлення розбіжність не усуне: причина —
     * ваги товарів у Shopify (або описка). Заповнює parcelMismatchFor (packing.server.ts).
     */
    ignoredByWaybill?: { goodsGrams: number; minGrams: number };
  } | null;
  /** exceeds — посилка більша за задекларовані габарити типової упаковки (dimsUpperBound). */
  dims: { waybillMm: Dims; packedMm: Dims; exceeds?: true } | null;
}

/** Джерела габаритів накладної, коли вони НЕ виміряні (типова упаковка з налаштувань). */
export const PLACEHOLDER_DIMS_SOURCES: readonly string[] = ["default_package", "manual_box_default_dims"];

const positive = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

export function sortDims(d: readonly [number, number, number]): Dims {
  const s = [...d].sort((a, b) => b - a);
  return [s[0]!, s[1]!, s[2]!];
}

/** Габарити з трьох значень — лише якщо всі три додатні. */
export function dimsOf(l: number | null | undefined, w: number | null | undefined, h: number | null | undefined): Dims | null {
  return positive(l) && positive(w) && positive(h) ? [l, w, h] : null;
}

/** Параметри посилки, з якими створено накладну. */
export function waybillParcel(shipment: { requestSnapshot: unknown; actualWeightGrams: number | null }): ParcelMeasure {
  const snapshot = shipment.requestSnapshot && typeof shipment.requestSnapshot === "object" ? (shipment.requestSnapshot as Record<string, unknown>) : null;
  const parcels = snapshot && Array.isArray(snapshot.parcels) ? (snapshot.parcels as unknown[]) : [];
  const first = parcels[0] && typeof parcels[0] === "object" ? (parcels[0] as Record<string, unknown>) : null;
  const cm = first ? dimsOf(first.lengthCm as number, first.widthCm as number, first.heightCm as number) : null;
  const weight = positive(first?.actualWeightGrams) ? (first!.actualWeightGrams as number) : positive(shipment.actualWeightGrams) ? shipment.actualWeightGrams : null;
  const placeholder = typeof snapshot?.parcelSource === "string" && PLACEHOLDER_DIMS_SOURCES.includes(snapshot.parcelSource);
  return { weightGrams: weight, dimsMm: cm ? [cm[0] * 10, cm[1] * 10, cm[2] * 10] : null, ...(cm && placeholder ? { dimsUpperBound: true } : {}) };
}

/**
 * Чи узгоджуються габарити (напр. внутрішні габарити коробки) з накладною — те саме правило, що й compareParcels
 * (верхня межа для типової упаковки). Невідомі габарити з будь-якого боку — узгоджено (порівнювати нічого).
 */
export function dimsConsistentWithWaybill(waybill: ParcelMeasure, dimsMm: Dims | null, dimensionMm = PARCEL_DIMENSION_TOLERANCE_MM): boolean {
  if (!waybill.dimsMm || !dimsMm) return true;
  const a = sortDims(waybill.dimsMm);
  const b = sortDims(dimsMm);
  return waybill.dimsUpperBound ? b.every((v, i) => v <= a[i]! + dimensionMm) : a.every((v, i) => Math.abs(v - b[i]!) <= dimensionMm);
}

/** null — розбіжності немає (або порівнювати нічого). */
export function compareParcels(
  waybill: ParcelMeasure,
  packed: ParcelMeasure,
  tolerance: { weightPercent?: number; dimensionMm?: number } = {},
): ParcelMismatch | null {
  const weightPercent = tolerance.weightPercent ?? PARCEL_WEIGHT_TOLERANCE_PERCENT;
  const dimensionMm = tolerance.dimensionMm ?? PARCEL_DIMENSION_TOLERANCE_MM;
  let weight: ParcelMismatch["weight"] = null;
  if (positive(waybill.weightGrams) && positive(packed.weightGrams)) {
    // |різниця| > допуск% від ваги накладної (цілі числа: без похибок float).
    if (Math.abs(packed.weightGrams - waybill.weightGrams) * 100 > waybill.weightGrams * weightPercent) {
      weight = { waybillGrams: waybill.weightGrams, packedGrams: packed.weightGrams };
    }
  }
  let dims: ParcelMismatch["dims"] = null;
  if (waybill.dimsMm && packed.dimsMm && !dimsConsistentWithWaybill(waybill, packed.dimsMm, dimensionMm)) {
    dims = { waybillMm: sortDims(waybill.dimsMm), packedMm: sortDims(packed.dimsMm), ...(waybill.dimsUpperBound ? { exceeds: true as const } : {}) };
  }
  return weight || dims ? { weight, dims } : null;
}

/**
 * Чи усуне розбіжність переоформлення накладної: так — розбіжність габаритів або ваги, яку нова накладна використає;
 * ні — лише вага, яку нова накладна теж проігнорує (ignoredByWaybill): порада «Переоформити» вела б до повторних
 * скасувань і створень накладної без результату.
 */
export function mismatchNeedsReissue(m: ParcelMismatch | null | undefined): boolean {
  return Boolean(m && (m.dims || (m.weight && !m.weight.ignoredByWaybill)));
}

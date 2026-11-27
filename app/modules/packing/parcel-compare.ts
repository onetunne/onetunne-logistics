/**
 * Розбіжність посилки з накладною (чиста функція): накладну створено з одними вагою/габаритами, а запаковано
 * інакше (інша коробка, зважена вага). Допуск: вага ±10 % від ваги в накладній, кожен габарит ±10 мм.
 * Габарити порівнюються без урахування орієнтації (за спаданням). Порівнюються лише відомі значення з обох боків.
 *
 * Дані накладної: знімок запиту (shipments.request_snapshot.parcels[0]: см і г) або shipments.actual_weight_grams.
 * Ручне прив'язування (без знімка) — порівнювати нічого (null).
 */
import { PARCEL_DIMENSION_TOLERANCE_MM, PARCEL_WEIGHT_TOLERANCE_PERCENT } from "./constants";

export type Dims = [number, number, number];

export interface ParcelMeasure {
  weightGrams: number | null;
  /** Габарити, мм (будь-який порядок). */
  dimsMm: Dims | null;
}

export interface ParcelMismatch {
  weight: { waybillGrams: number; packedGrams: number } | null;
  dims: { waybillMm: Dims; packedMm: Dims } | null;
}

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
  return { weightGrams: weight, dimsMm: cm ? [cm[0] * 10, cm[1] * 10, cm[2] * 10] : null };
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
  if (waybill.dimsMm && packed.dimsMm) {
    const a = sortDims(waybill.dimsMm);
    const b = sortDims(packed.dimsMm);
    if (a.some((v, i) => Math.abs(v - b[i]!) > dimensionMm)) dims = { waybillMm: a, packedMm: b };
  }
  return weight || dims ? { weight, dims } : null;
}

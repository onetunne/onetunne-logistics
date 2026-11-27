/**
 * Параметри посилки для накладної (чиста функція, без БД) — використовує buildShipmentRequest.
 *
 * Пріоритет джерел габаритів і тари:
 * 1. "manual" — ручне коригування на рівні замовлення: orders.parcel_length/width/height_mm (усі три). Тара, код і id —
 *    коробки, вибраної вручну (orders.parcel_box_material_id, вид box | mailer; її внутрішні габарити тут не потрібні),
 *    інакше типової упаковки з налаштувань.
 * 2. "manual_box" — коробка, вибрана вручну (orders.parcel_box_material_id) з відомими внутрішніми габаритами.
 *    Вибрана вручну коробка БЕЗ габаритів і без ручних габаритів посилки описати посилку не може → далі п. 3–4
 *    (пакувальнику варто ввести габарити посилки вручну).
 * 3. "auto_box" — автоматично підібрана коробка (selectBoxForOrder) — ЛИШЕ якщо всі товари мають габарити
 *    (reason = "fits"); неточний підбір (лише за вагою / частина без габаритів) для накладної не використовується.
 * 4. "default_package" — типова упаковка з налаштувань «Упаковка».
 * Вага: orders.parcel_weight_grams (зважена посилка) замінює розрахункову фактичну — незалежно від джерела габаритів.
 * Розрахункова вага товарів — parcelGoods (ті самі позиції й кількості, що й для підбору коробки): автоматично
 * підібрана коробка завжди перевірена саме на ту вагу товарів, яку отримує накладна.
 *
 * Обмеження: коробки мають лише ВНУТРІШНІ габарити (зовнішні не зберігаються) — вони передаються перевізнику з
 * округленням до сантиметра вгору.
 */
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import type { BoxSelectionItem, SelectBoxReason } from "./box-selection";

export const PARCEL_SOURCES = ["manual", "manual_box", "auto_box", "default_package"] as const;
export type ParcelSource = (typeof PARCEL_SOURCES)[number];

/** Коробка для посилки, визначена до побудови запиту (planParcelBox у parcel.server.ts). */
export interface ParcelBoxChoice {
  source: "manual_box" | "auto_box";
  materialId: string;
  code: string;
  /**
   * Внутрішні габарити. null — не задані: лише для manual_box разом із ручними габаритами посилки (тоді від коробки
   * потрібні тільки тара, код і id). Коробка без габаритів і без ручних габаритів посилки ігнорується.
   */
  innerLengthMm: number | null;
  innerWidthMm: number | null;
  innerHeightMm: number | null;
  tareWeightGrams: number | null;
}

export interface ParcelBoxPlan {
  /** Коробка для накладної (вибрана вручну або підібрана автоматично) або null — типова упаковка. */
  box: ParcelBoxChoice | null;
  /** Результат автоматичного підбору, якщо він виконувався (для знімка запиту й діагностики). */
  autoReason: SelectBoxReason | null;
}

export interface PackageSpec {
  code: string;
  lengthCm: number;
  widthCm: number;
  heightCm: number;
  tareWeightGrams: number;
}

export interface ParcelOrderFields {
  parcelLengthMm: number | null;
  parcelWidthMm: number | null;
  parcelHeightMm: number | null;
}

export interface ChosenParcelPackage {
  pkg: PackageSpec;
  source: ParcelSource;
  /** Коробка-матеріал, з якої взято габарити/тару (null — ручні габарити без коробки або типова упаковка). */
  boxMaterialId: string | null;
}

const mmToCm = (mm: number) => Math.ceil(mm / 10);
const positive = (v: number | null | undefined): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/** Позиція замовлення для розрахунків посилки (форма loadLineItems; variant — ЕФЕКТИВНІ вага/габарити, з перевизначеннями). */
export interface ParcelLine {
  quantity: number;
  currentQuantity?: number | null;
  variant: { lengthMm: number | null; widthMm: number | null; heightMm: number | null; weightGrams: number | null } | null;
}

/**
 * Фізичні товари посилки — ОДНЕ джерело і для підбору коробки (selectBoxForOrder), і для розрахункової ваги посилки
 * (buildShipmentRequest), щоб підібрана коробка була перевірена саме на ту вагу, яку отримує накладна:
 * - лише позиції з варіантом товару: довільні позиції Shopify без варіанта (послуги, чайові, доплати) не пакуються —
 *   як і в комплектації (kit-resolution.ts); раніше вони вважалися «товаром без габаритів» і вимикали автоматичний
 *   підбір для всього замовлення;
 * - кількість — effectiveLineQuantity (Shopify currentQuantity: без повернених/видалених одиниць; саме стільки
 *   пакується й списується зі складу).
 */
export function parcelGoods(items: readonly ParcelLine[]): BoxSelectionItem[] {
  return items
    .filter((i) => i.variant !== null)
    .map((i) => ({
      lengthMm: i.variant!.lengthMm,
      widthMm: i.variant!.widthMm,
      heightMm: i.variant!.heightMm,
      weightGrams: i.variant!.weightGrams,
      quantity: effectiveLineQuantity(i),
    }));
}

/** Вхід computeParcelWeights із parcelGoods: вага без значення (або некоректна) — 0 г, як і в selectBox. */
export function parcelWeightItems(items: readonly ParcelLine[]): Array<{ weightGrams: number; quantity: number }> {
  return parcelGoods(items).map((g) => ({ weightGrams: positive(g.weightGrams) ? g.weightGrams : 0, quantity: g.quantity }));
}

export function chooseParcelPackage(
  order: ParcelOrderFields,
  defaultPkg: PackageSpec,
  plan: ParcelBoxPlan | null | undefined,
): ChosenParcelPackage {
  const box = plan?.box ?? null;
  const manualBox = box?.source === "manual_box" ? box : null;
  if (order.parcelLengthMm && order.parcelWidthMm && order.parcelHeightMm) {
    return {
      pkg: {
        code: manualBox?.code ?? defaultPkg.code,
        lengthCm: mmToCm(order.parcelLengthMm),
        widthCm: mmToCm(order.parcelWidthMm),
        heightCm: mmToCm(order.parcelHeightMm),
        tareWeightGrams: manualBox ? (manualBox.tareWeightGrams ?? 0) : defaultPkg.tareWeightGrams,
      },
      source: "manual",
      boxMaterialId: manualBox?.materialId ?? null,
    };
  }
  if (box && positive(box.innerLengthMm) && positive(box.innerWidthMm) && positive(box.innerHeightMm)) {
    return {
      pkg: {
        code: box.code,
        lengthCm: mmToCm(box.innerLengthMm),
        widthCm: mmToCm(box.innerWidthMm),
        heightCm: mmToCm(box.innerHeightMm),
        tareWeightGrams: box.tareWeightGrams ?? 0,
      },
      source: box.source,
      boxMaterialId: box.materialId,
    };
  }
  return { pkg: { ...defaultPkg }, source: "default_package", boxMaterialId: null };
}

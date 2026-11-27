/**
 * Параметри посилки для накладної (чиста функція, без БД) — використовує buildShipmentRequest.
 *
 * Пріоритет джерел габаритів і тари:
 * 1. "manual" — ручне коригування на рівні замовлення: orders.parcel_length/width/height_mm (усі три). Тара, код і id —
 *    коробки, вибраної вручну (orders.parcel_box_material_id, вид box | mailer; її внутрішні габарити тут не потрібні),
 *    інакше типової упаковки з налаштувань.
 * 2. "manual_box" — коробка, вибрана вручну (orders.parcel_box_material_id) з відомими внутрішніми габаритами.
 *    "manual_box_default_dims" — вибрана вручну коробка БЕЗ габаритів і без ручних габаритів посилки: код, тара й id —
 *    цієї коробки (людина її вибрала — іншу не підставляємо), габарити — типової упаковки (пакувальнику варто ввести
 *    габарити посилки вручну).
 * 3. "auto_box" — автоматично підібрана коробка (selectBoxForOrder) — ЛИШЕ якщо всі товари мають габарити
 *    (reason = "fits"); неточний підбір (лише за вагою / частина без габаритів) для накладної не використовується.
 * 4. "default_package" — типова упаковка з налаштувань «Упаковка».
 * Вага: orders.parcel_weight_grams (зважена посилка) замінює розрахункову фактичну — незалежно від джерела габаритів,
 * якщо вона правдоподібна (isManualWeightPlausible: не менша за 90 % розрахункової ваги товарів) або власник
 * підтвердив її (manualWeightUse: ваги товарів у Shopify завищені); інакше (застаріла після зміни позицій, описка
 * 30 замість 300) — не надсилається, береться розрахункова, а екран пакування й картка замовлення це пояснюють
 * (parcelWeightCheck, manualWeightIgnoredOf).
 * Розрахункова вага товарів — parcelGoods (ті самі позиції й кількості, що й для підбору коробки): автоматично
 * підібрана коробка завжди перевірена саме на ту вагу товарів, яку отримує накладна.
 *
 * Обмеження: коробки мають лише ВНУТРІШНІ габарити (зовнішні не зберігаються) — вони передаються перевізнику з
 * округленням до сантиметра вгору.
 */
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import type { BoxSelectionItem, SelectBoxReason } from "./box-selection";

/**
 * manual_box_default_dims — коробка/пакет, вибрані вручну, без внутрішніх габаритів і без ручних габаритів посилки:
 * код, тара й id — вибраної коробки (нічого не підміняється іншою коробкою), габарити — типової упаковки.
 */
export const PARCEL_SOURCES = ["manual", "manual_box", "manual_box_default_dims", "auto_box", "default_package"] as const;
export type ParcelSource = (typeof PARCEL_SOURCES)[number];

/** Коробка для посилки, визначена до побудови запиту (planParcelBox у parcel.server.ts). */
export interface ParcelBoxChoice {
  source: "manual_box" | "auto_box";
  materialId: string;
  code: string;
  /**
   * Внутрішні габарити. null — не задані: лише для manual_box (тоді від коробки потрібні тільки тара, код і id; габарити —
   * ручні габарити посилки або, без них, типової упаковки).
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
  if (manualBox && !(positive(manualBox.innerLengthMm) && positive(manualBox.innerWidthMm) && positive(manualBox.innerHeightMm))) {
    // Вибрану вручну коробку без габаритів не підміняємо іншою (код і тара — її), габарити — типової упаковки.
    return {
      pkg: { ...defaultPkg, code: manualBox.code, tareWeightGrams: manualBox.tareWeightGrams ?? 0 },
      source: "manual_box_default_dims",
      boxMaterialId: manualBox.materialId,
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

/**
 * Найменша частка розрахункової ваги товарів (%), яку може мати зважена вручну посилка разом з упаковкою: допуск на
 * неточні ваги товарів у Shopify. Менше — значення застаріле (позиції змінилися після зважування) або описка.
 */
export const MANUAL_WEIGHT_MIN_GOODS_PERCENT = 90;

/** Чи правдоподібна зважена вручну вага посилки щодо розрахункової ваги товарів (без тари). */
export function isManualWeightPlausible(manualGrams: number, goodsGrams: number): boolean {
  if (!positive(manualGrams)) return false;
  return manualGrams * 100 >= Math.max(0, goodsGrams) * MANUAL_WEIGHT_MIN_GOODS_PERCENT;
}

/** Розрахункова вага товарів посилки без тари, г (parcelWeightItems — ті самі позиції й кількості, що й у накладній). */
export function parcelGoodsWeightGrams(items: readonly ParcelLine[]): number {
  return parcelWeightItems(items).reduce((s, i) => s + i.weightGrams * i.quantity, 0);
}

/** Найменша правдоподібна зважена вага (ціле, г) для ваги товарів — межа isManualWeightPlausible. */
export function minPlausibleManualWeight(goodsGrams: number): number {
  const goods = Math.max(0, goodsGrams);
  return Math.floor((goods * MANUAL_WEIGHT_MIN_GOODS_PERCENT + 99) / 100);
}

/**
 * Як накладна використає зважену вручну вагу (orders.parcel_weight_grams):
 * - plausible — не менша за 90 % ваги товарів, надсилається;
 * - owner_verified — менша, але власник підтвердив, що зважено правильно (ваги товарів у Shopify завищені), надсилається;
 * - ignored — менша й не підтверджена: надсилається розрахункова вага (застаріле значення, описка або завищені ваги
 *   товарів у Shopify — тоді їх варто виправити в Shopify або попросити власника підтвердити вагу).
 */
export type ManualWeightUse = "plausible" | "owner_verified" | "ignored";

export function manualWeightUse(manualGrams: number, goodsGrams: number, ownerVerified: boolean): ManualWeightUse {
  if (isManualWeightPlausible(manualGrams, goodsGrams)) return "plausible";
  return ownerVerified && positive(manualGrams) ? "owner_verified" : "ignored";
}

/**
 * Зважена вага менша за 90 % ваги товарів — попередження на екрані пакування й у картці замовлення (null — ваги
 * немає або вона правдоподібна). use: owner_verified — накладна її використає; ignored — не використає.
 */
export interface ParcelWeightCheck {
  manualGrams: number;
  goodsGrams: number;
  /** Найменша вага, яку накладна прийме без підтвердження власника. */
  minGrams: number;
  use: Exclude<ManualWeightUse, "plausible">;
}

export function parcelWeightCheck(manualGrams: number | null | undefined, goodsGrams: number, ownerVerified: boolean): ParcelWeightCheck | null {
  if (!positive(manualGrams)) return null;
  const use = manualWeightUse(manualGrams, goodsGrams, ownerVerified);
  return use === "plausible" ? null : { manualGrams, goodsGrams, minGrams: minPlausibleManualWeight(goodsGrams), use };
}

/**
 * Знімок запиту накладної: зважену вручну вагу НЕ надіслано (manualWeightIgnored у buildShipmentRequest) — для
 * пояснення на екрані пакування й на сторінці замовлення. null — надіслано або ручної ваги не було.
 */
export function manualWeightIgnoredOf(requestSnapshot: unknown): { manualGrams: number; goodsGrams: number } | null {
  if (!requestSnapshot || typeof requestSnapshot !== "object") return null;
  const v = (requestSnapshot as Record<string, unknown>).manualWeightIgnored;
  if (!v || typeof v !== "object") return null;
  const { manualGrams, goodsGrams } = v as Record<string, unknown>;
  const isCount = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x) && x >= 0;
  return isCount(manualGrams) && manualGrams > 0 && isCount(goodsGrams) ? { manualGrams, goodsGrams } : null;
}

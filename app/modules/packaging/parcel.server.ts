/**
 * Підбір коробки для замовлення з бази (обгортка над чистою selectBox) і план посилки для накладної.
 *
 * - Товари: loadLineItems → parcelGoods (parcel.ts): лише позиції з варіантом товару (довільні позиції Shopify без
 *   варіанта не пакуються й не вимикають підбір), ЕФЕКТИВНІ вага й габарити варіанта (перевизначення застосунку з
 *   «Товари» мають пріоритет над Shopify, modules/products/customs-overrides.ts), кількість — effectiveLineQuantity
 *   (без повернених/видалених). Ті самі дані дають вагу посилки в buildShipmentRequest.
 * - Коробки: активні матеріали kind box|mailer; наявність (on_hand > 0 на складі за замовчуванням) — перевага, але не
 *   обов'язкова умова (облік матеріалів може ще не вестися).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryBalances, orderChanges, packagingMaterials, stockItems, type PackagingMaterialKind } from "~/db/schema";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { loadLineItems, type OrderRow } from "~/modules/orders/repository.server";
import { BOX_KINDS, boxInnerDims, selectBox, type Box, type BoxSelectionItem, type SelectBoxOptions, type SelectBoxResult } from "./box-selection";
import { parcelGoods, parcelGoodsWeightGrams, parcelWeightCheck, type ParcelBoxChoice, type ParcelBoxPlan, type ParcelWeightCheck } from "./parcel";

export type LineItems = Awaited<ReturnType<typeof loadLineItems>>;

export interface BoxCandidate extends Box {
  name: string;
  /** Фактичний залишок на складі за замовчуванням. */
  onHand: number;
}

/** Активні коробки й пакети з залишком (on_hand) на складі за замовчуванням. */
export async function loadBoxCandidates(db: DbOrTx, opts: { includeInactive?: boolean } = {}): Promise<BoxCandidate[]> {
  const warehouse = await getDefaultWarehouse(db);
  const rows = await db
    .select({ m: packagingMaterials, onHand: inventoryBalances.onHand })
    .from(packagingMaterials)
    .leftJoin(stockItems, eq(stockItems.materialId, packagingMaterials.id))
    .leftJoin(inventoryBalances, and(eq(inventoryBalances.stockItemId, stockItems.id), eq(inventoryBalances.warehouseId, warehouse.id)))
    .where(
      and(
        inArray(packagingMaterials.kind, BOX_KINDS as PackagingMaterialKind[]),
        opts.includeInactive ? undefined : eq(packagingMaterials.active, true),
      ),
    );
  return rows.map(({ m, onHand }) => ({
    id: m.id,
    code: m.code,
    name: m.name,
    kind: m.kind,
    active: m.active,
    innerLengthMm: m.innerLengthMm,
    innerWidthMm: m.innerWidthMm,
    innerHeightMm: m.innerHeightMm,
    maxWeightGrams: m.maxWeightGrams,
    tareWeightGrams: m.tareWeightGrams,
    onHand: onHand ?? 0,
    inStock: (onHand ?? 0) > 0,
  }));
}

/** Позиції замовлення → вхід selectBox (parcelGoods: лише товари з варіантом, ефективні вага/габарити й кількість). */
export function toBoxSelectionItems(items: LineItems): BoxSelectionItem[] {
  return parcelGoods(items);
}

export type OrderBoxSelection = SelectBoxResult<BoxCandidate>;

/** Автоматичний підбір коробки для замовлення (див. box-selection.ts). items — уже завантажені позиції (необов'язково). */
export async function selectBoxForOrder(
  db: DbOrTx,
  orderId: string,
  opts: SelectBoxOptions & { items?: LineItems } = {},
): Promise<OrderBoxSelection> {
  const items = opts.items ?? (await loadLineItems(db, orderId));
  const boxes = await loadBoxCandidates(db);
  return selectBox(toBoxSelectionItems(items), boxes, { fillFactor: opts.fillFactor, preferInStock: opts.preferInStock });
}

function toChoice(
  source: ParcelBoxChoice["source"],
  m: Pick<Box, "id" | "code" | "innerLengthMm" | "innerWidthMm" | "innerHeightMm" | "tareWeightGrams">,
): ParcelBoxChoice {
  const hasDims = boxInnerDims(m) !== null;
  return {
    source,
    materialId: m.id,
    code: m.code,
    innerLengthMm: hasDims ? m.innerLengthMm : null,
    innerWidthMm: hasDims ? m.innerWidthMm : null,
    innerHeightMm: hasDims ? m.innerHeightMm : null,
    tareWeightGrams: m.tareWeightGrams,
  };
}

/**
 * План коробки для накладної (передається в buildShipmentRequest; пріоритет джерел — parcel.ts):
 * 1. orders.parcel_box_material_id (коробка, вибрана вручну; вид box | mailer, активність не важлива — її вже
 *    використано) → manual_box: завжди (від коробки — тара, код, id; габарити — її внутрішні, ручні габарити посилки
 *    або, якщо немає ні тих, ні інших, — типової упаковки: chooseParcelPackage). Іншу коробку не підставляємо;
 * 2. ручні габарити посилки (усі три) без вибраної коробки → підбір не потрібен (box = null, тара — типової упаковки);
 * 3. автоматичний підбір → auto_box лише при reason = "fits" (усі товари мають габарити й вагу перевірено);
 *    неточний підбір (лише за вагою / частина без габаритів) або невдалий → null (типова упаковка), причина — у autoReason.
 */
export async function planParcelBox(
  db: DbOrTx,
  order: Pick<OrderRow, "id" | "parcelBoxMaterialId" | "parcelLengthMm" | "parcelWidthMm" | "parcelHeightMm">,
  items?: LineItems,
): Promise<ParcelBoxPlan> {
  const manualDims = Boolean(order.parcelLengthMm && order.parcelWidthMm && order.parcelHeightMm);
  if (order.parcelBoxMaterialId) {
    const [m] = await db.select().from(packagingMaterials).where(eq(packagingMaterials.id, order.parcelBoxMaterialId));
    if (m && BOX_KINDS.includes(m.kind)) {
      return { box: toChoice("manual_box", m), autoReason: null };
    }
  }
  if (manualDims) return { box: null, autoReason: null };
  const selection = await selectBoxForOrder(db, order.id, { items });
  if (selection.box && selection.reason === "fits") {
    return { box: toChoice("auto_box", selection.box), autoReason: selection.reason };
  }
  return { box: null, autoReason: selection.reason };
}

/**
 * Причина запису історії (order_changes.reason, поле parcel.weightGrams, старе = нове значення): власник підтвердив,
 * що зважена вага посилки правильна, хоч вона менша за 90 % ваги товарів за даними Shopify (ваги товарів завищені).
 * Перекладається на сторінці замовлення (ключ packing.history.*).
 */
export const PARCEL_WEIGHT_VERIFIED_REASON = "packing.history.weightVerifiedByOwner";

/**
 * Чи підтвердив власник ПОТОЧНУ зважену вагу замовлення (orders.parcel_weight_grams): останній запис історії поля
 * parcel.weightGrams — підтвердження власника (PARCEL_WEIGHT_VERIFIED_REASON) саме з цим значенням. Будь-яка пізніша
 * зміна ваги (пакувальник перезважив, скидання застарілого коригування) підтвердження знімає.
 */
export async function isParcelWeightOwnerVerified(db: DbOrTx, order: Pick<OrderRow, "id" | "parcelWeightGrams">): Promise<boolean> {
  if (!order.parcelWeightGrams) return false;
  const [last] = await db
    .select({ newValue: orderChanges.newValue, reason: orderChanges.reason })
    .from(orderChanges)
    .where(and(eq(orderChanges.orderId, order.id), eq(orderChanges.field, "parcel.weightGrams")))
    .orderBy(desc(orderChanges.createdAt))
    .limit(1);
  return last?.reason === PARCEL_WEIGHT_VERIFIED_REASON && last.newValue === String(order.parcelWeightGrams);
}

/**
 * Перевірка зваженої ваги замовлення щодо ваги товарів (parcelWeightCheck): null — ваги немає або вона правдоподібна;
 * інакше — чи використає її накладна (owner_verified) чи ні (ignored). items — уже завантажені позиції (необов'язково).
 */
export async function loadParcelWeightCheck(
  db: DbOrTx,
  order: Pick<OrderRow, "id" | "parcelWeightGrams">,
  items?: LineItems,
): Promise<ParcelWeightCheck | null> {
  if (!order.parcelWeightGrams) return null;
  const goods = parcelGoodsWeightGrams(items ?? (await loadLineItems(db, order.id)));
  const check = parcelWeightCheck(order.parcelWeightGrams, goods, false);
  if (!check) return null;
  return (await isParcelWeightOwnerVerified(db, order)) ? { ...check, use: "owner_verified" } : check;
}

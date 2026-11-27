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
import { and, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { inventoryBalances, packagingMaterials, stockItems, type PackagingMaterialKind } from "~/db/schema";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { loadLineItems, type OrderRow } from "~/modules/orders/repository.server";
import { BOX_KINDS, boxInnerDims, selectBox, type Box, type BoxSelectionItem, type SelectBoxOptions, type SelectBoxResult } from "./box-selection";
import { parcelGoods, type ParcelBoxChoice, type ParcelBoxPlan } from "./parcel";

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
 *    використано) → manual_box: з ручними габаритами посилки — завжди (від коробки — тара, код, id; її габарити не
 *    потрібні), без них — лише якщо в коробки задано внутрішні габарити;
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
    if (m && BOX_KINDS.includes(m.kind) && (manualDims || boxInnerDims(m) !== null)) {
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

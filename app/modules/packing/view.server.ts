/**
 * Дані для екрана пакування (сторінка picking/:orderId) і картки «Пакування» на сторінці замовлення.
 * Нічого не змінює. Дані покупця — лише ім'я отримувача, місто й країна (звірити з етикеткою), і лише з дозволом
 * orders.view: пакувальнику, якому власник зняв перегляд замовлень, — тільки країна (packing.perform сам по собі не
 * відкриває персональних даних).
 *
 * Рекомендована коробка (★) узгоджена з накладною (packingSuggestion): коробка, з якою створено накладну; інакше
 * найменша придатна, що не виходить за габарити накладної (типова упаковка — верхня межа, parcel-compare.ts); лише
 * якщо такої немає — звичайний підбір із позначкою «відрізняється від накладної». Так вибір ★ сам по собі не дає
 * попередження «Посилка відрізняється від накладної».
 */
import { eq } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { packagingMaterials, type OrderPriority, type PackagingMaterialKind } from "~/db/schema";
import { isFulfilledInShopify, type OrderStatus } from "~/domain/order-status";
import { can, requirePermission } from "~/domain/permissions";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { boxInnerDims, selectBox, type SelectBoxFlags, type SelectBoxReason } from "~/modules/packaging/box-selection";
import { consumedMaterialsFor, materialsPlanKey, planPackingMaterials, type PackingMaterialLine } from "~/modules/packaging/consumption.server";
import { parcelWeightItems } from "~/modules/packaging/parcel";
import { loadBoxCandidates, toBoxSelectionItems, type BoxCandidate, type LineItems } from "~/modules/packaging/parcel.server";
import { isReissuable } from "~/modules/shipments/reissue.server";
import { getSettings } from "~/modules/settings/settings.server";
import { availableDocumentKinds } from "~/modules/shipments/documents.server";
import { findActiveShipment } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import { STARTABLE_STATUSES } from "./constants";
import { dimsConsistentWithWaybill, dimsOf, waybillParcel, type Dims, type ParcelMeasure, type ParcelMismatch } from "./parcel-compare";
import { openCancelledAfterPacking } from "./lifecycle.server";
import {
  PRE_WAYBILL_PARCEL_STATUSES,
  defaultBoxFor,
  isDeletedAtCarrier,
  isPackableShipment,
  loadActivePacking,
  materialsConsumedFor,
  normalizeId,
  parcelMismatchFor,
  toChecklistLines,
  type PackingRow,
} from "./packing.server";
import { shopifyLinesPending } from "~/modules/shopify-sync/pending-lines.server";
import { parcelPrefill } from "./parcel-form";
import { checklistProgress, packedQty, type ChecklistProgress } from "./scan";

export interface PackingLineView {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  barcode: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  required: number;
  packed: number;
}

export interface PackingBoxOption {
  id: string;
  code: string;
  name: string;
  kind: PackagingMaterialKind;
  innerDimsMm: Dims | null;
  maxWeightGrams: number | null;
  tareWeightGrams: number | null;
  onHand: number;
  active: boolean;
}

export interface PackingInfo {
  id: string;
  status: PackingRow["status"];
  version: number;
  generation: number;
  boxMaterialId: string | null;
  startedByName: string | null;
  startedAt: Date | null;
  packedByName: string | null;
  packedAt: Date | null;
}

/** Рекомендована коробка (★) на екрані пакування — див. packingSuggestion. */
export interface PackingSuggestion {
  boxId: string | null;
  code: string | null;
  name: string | null;
  reason: SelectBoxReason;
  flags: SelectBoxFlags;
  /**
   * waybill — коробка, з якою створено накладну; waybill_fit — найменша придатна в межах габаритів накладної;
   * selection — звичайний підбір (накладної немає або в її межах коробки немає).
   */
  source: "waybill" | "waybill_fit" | "selection";
  /** Рекомендована коробка не узгоджується з габаритами накладної: після вибору — переоформлення. */
  differsFromWaybill: boolean;
}

export interface PackingScreen {
  order: {
    id: string;
    orderNumber: string;
    status: OrderStatus;
    priority: OrderPriority;
    placedAt: Date;
    countryCode: string | null;
    /** Лише з orders.view (інакше null). */
    city: string | null;
    /** Лише з orders.view (інакше null). */
    recipientName: string | null;
    source: "demo" | "shopify";
    /** orders.version — для форми посилки до накладної (saveOrderParcel). */
    version: number;
  };
  /** Дані отримувача приховано (немає orders.view). */
  customerDataHidden: boolean;
  shipment: {
    id: string;
    waybillNumber: string | null;
    carrierName: string;
    testMode: boolean;
    packable: boolean;
    reissuable: boolean;
    labelAvailable: boolean;
  } | null;
  packing: PackingInfo | null;
  lines: PackingLineView[];
  /** Позиції без товару в каталозі (послуги тощо) — не пакуються, лише для довідки. */
  otherLines: Array<{ id: string; title: string; quantity: number }>;
  /** Одиниці в чеклісті, яких уже немає в замовленні (змінено в Shopify) — вийняти з посилки. */
  staleUnits: number;
  /** Ті самі одиниці по позиціях — щоб зняти їх кнопкою −1 (позицію видалено або її кількість стала 0). */
  staleLines: Array<{ id: string; title: string | null; variantTitle: string | null; packed: number }>;
  progress: ChecklistProgress;
  boxes: PackingBoxOption[];
  suggestion: PackingSuggestion;
  /** Що покласти/списати при «Запаковано» (коробка + комплектація). */
  materials: PackingMaterialLine[];
  /** Відбиток переліку materials — надсилається з «Запаковано» (списується саме те, що бачив пакувальник). */
  materialsKey: string;
  /**
   * Коробки, уже списані для цього пакування, крім поточної (посилку переклали після розпакування): лишаються
   * списаними; якщо коробку повернули на полицю — коригування на сторінці матеріалів.
   */
  previousBoxes: Array<{ code: string; name: string }>;
  /** Матеріали, уже списані для цього пакування (повторне «Запаковано» їх не списує; решту переліку — спише). */
  consumedMaterialIds: string[];
  /**
   * Де зберігається форма посилки: packing — у пакуванні (savePackingParcel); order — до накладної, без пакування
   * (saveOrderParcel); null — форма недоступна.
   */
  parcelTarget: "packing" | "order" | null;
  parcel: {
    /** Початкові значення форми: збережені вручну, інакше підказки (габарити коробки, розрахункова вага). */
    weightGrams: number | null;
    lengthMm: number | null;
    widthMm: number | null;
    heightMm: number | null;
    /** Значення вже збережено (ручне коригування), інакше — розрахунок для підказки. */
    saved: boolean;
    estimateWeightGrams: number | null;
    /** Збережені вручну (пакування або замовлення) — інакше null; підставлене автоматично сюди не входить. */
    savedWeightGrams: number | null;
    savedDimsMm: Dims | null;
    /** Для підказок форми при зміні коробки (parcel-form.ts): вага товарів і тара типової упаковки. */
    goodsWeightGrams: number;
    defaultTareGrams: number;
    /** Коробка у формі: пакування — його коробка; до накладної — вибрана для замовлення (orders.parcel_box_material_id). */
    formBoxId: string | null;
  };
  waybillParcel: ParcelMeasure | null;
  mismatch: ParcelMismatch | null;
  /** Запаковано, а дійсної накладної немає (скасовано після «Запаковано»): спершу розпакувати, потім нова накладна. */
  packedWithoutWaybill: boolean;
  /** Для цього пакування матеріали вже списано (повторне «Запаковано» не списує вдруге). */
  materialsConsumed: boolean;
  canStart: boolean;
  /** Перевізник повідомив, що накладну видалено: пакувати з цією етикеткою не можна (нова накладна на сторінці замовлення). */
  deletedAtCarrier: boolean;
  /**
   * Етап 5: Shopify змінив позиції після створення накладної, а застосунок їх ще не застосував — чекліст може бути
   * застарілим; «Запаковано» лише рішенням власника (шлях — скасувати накладну, застосунок перечитає замовлення).
   */
  shopifyLinesPending: boolean;
  /** Етап 5: замовлення вже виконане (частково) в Shopify поза застосунком — пакувати не можна. */
  fulfilledInShopify: boolean;
  /**
   * Етап 5: замовлення скасовано після початку пакування / «Запаковано» — розібрати посилку й повернути товар на
   * полицю, потім «Повернуто на склад» (закриває попередження ORDER_CANCELLED_AFTER_PACKING).
   */
  cancelledAfterPacking: { previousStatus: string; materialsConsumed: boolean } | null;
}

const toPackingInfo = (p: PackingRow): PackingInfo => ({
  id: p.id,
  status: p.status,
  version: p.version,
  generation: p.generation,
  boxMaterialId: p.boxMaterialId,
  startedByName: p.startedByName,
  startedAt: p.startedAt,
  packedByName: p.packedByName,
  packedAt: p.packedAt,
});

/**
 * ★ узгоджена з накладною: (1) коробка, з якою створено накладну (знімок запиту); (2) звичайний підбір, якщо його
 * коробка в межах габаритів накладної; (3) найменша придатна серед коробок у межах габаритів накладної; (4) інакше —
 * звичайний підбір з differsFromWaybill. Без накладної — звичайний підбір.
 */
export function packingSuggestion(
  items: LineItems,
  candidates: readonly BoxCandidate[],
  waybill: { parcel: ParcelMeasure; boxMaterialId: string | null } | null,
): PackingSuggestion {
  const goods = toBoxSelectionItems(items);
  const selection = selectBox(goods, candidates);
  const pick = (r: ReturnType<typeof selectBox<BoxCandidate>>, source: PackingSuggestion["source"], differs: boolean): PackingSuggestion => ({
    boxId: r.box?.id ?? null,
    code: r.box?.code ?? null,
    name: r.box?.name ?? null,
    reason: r.reason,
    flags: r.flags,
    source,
    differsFromWaybill: differs,
  });
  if (!waybill) return pick(selection, "selection", false);
  const fromWaybill = waybill.boxMaterialId ? candidates.find((c) => c.id === waybill.boxMaterialId) : undefined;
  if (fromWaybill) {
    return { boxId: fromWaybill.id, code: fromWaybill.code, name: fromWaybill.name, reason: selection.reason, flags: selection.flags, source: "waybill", differsFromWaybill: false };
  }
  if (!selection.box || dimsConsistentWithWaybill(waybill.parcel, boxInnerDims(selection.box))) return pick(selection, "selection", false);
  const within = selectBox(goods, candidates.filter((c) => dimsConsistentWithWaybill(waybill.parcel, boxInnerDims(c))));
  if (within.box) return pick(within, "waybill_fit", false);
  return pick(selection, "selection", true);
}

export async function loadPackingScreen(ctx: Pick<ServiceContext, "db" | "carriers" | "actor">, orderId: string): Promise<PackingScreen> {
  requirePermission(ctx.actor, "packing.perform");
  const db = ctx.db;
  const id = normalizeId(orderId, "order");
  const showCustomer = can(ctx.actor, "orders.view");
  const order = await loadOrderRow(db, id);
  const [items, packing, shipment, settings] = await Promise.all([loadLineItems(db, id), loadActivePacking(db, id), findActiveShipment(db, id), getSettings(db)]);
  const checklist = packing?.checklist ?? {};
  const lines = toChecklistLines(items);
  const progress = checklistProgress(lines, checklist);
  const lineViews: PackingLineView[] = items
    .filter((i) => i.variant !== null && effectiveLineQuantity(i) > 0)
    .map((i) => ({
      id: i.id,
      title: i.variant!.productTitle,
      variantTitle: i.variant!.title ?? i.variantTitle,
      sku: i.variant!.sku ?? i.sku,
      barcode: i.variant!.barcode,
      model: i.variant!.model,
      color: i.variant!.color,
      imageUrl: i.variant!.imageUrl ?? i.variant!.productImageUrl ?? i.imageUrl,
      required: effectiveLineQuantity(i),
      packed: packedQty(checklist, i.id),
    }));
  const known = new Set(lineViews.map((l) => l.id));
  const staleLines = Object.keys(checklist)
    .filter((k) => !known.has(k) && packedQty(checklist, k) > 0)
    .map((k) => {
      const item = items.find((i) => i.id === k);
      return {
        id: k,
        title: item ? (item.variant?.productTitle ?? item.title) : null,
        variantTitle: item ? (item.variant?.title ?? item.variantTitle) : null,
        packed: packedQty(checklist, k),
      };
    });
  const staleUnits = staleLines.reduce((s, l) => s + l.packed, 0);

  const candidates = await loadBoxCandidates(db);
  const boxes: PackingBoxOption[] = candidates.map((b) => ({
    id: b.id,
    code: b.code,
    name: b.name,
    kind: b.kind,
    innerDimsMm: boxInnerDims(b),
    maxWeightGrams: b.maxWeightGrams,
    tareWeightGrams: b.tareWeightGrams,
    onHand: b.onHand,
    active: b.active,
  }));
  // Коробка форми й переліку матеріалів: пакування — його коробка; без пакування — та, яку підставить «Почати
  // пакування» (defaultBoxFor: вибрана для замовлення → з накладної → точний підбір), — як і в пакувальному листі.
  const currentBoxId = packing ? packing.boxMaterialId : await defaultBoxFor(db, order, shipment);
  const formBoxId = packing ? packing.boxMaterialId : order.parcelBoxMaterialId;
  for (const extraId of new Set([currentBoxId, formBoxId])) {
    if (!extraId || boxes.some((b) => b.id === extraId)) continue;
    const [m] = await db.select().from(packagingMaterials).where(eq(packagingMaterials.id, extraId));
    if (m) {
      boxes.push({
        id: m.id,
        code: m.code,
        name: m.name,
        kind: m.kind,
        innerDimsMm: boxInnerDims(m),
        maxWeightGrams: m.maxWeightGrams,
        tareWeightGrams: m.tareWeightGrams,
        onHand: 0,
        active: m.active,
      });
    }
  }
  boxes.sort((a, b) => a.name.localeCompare(b.name, "uk"));
  const box = boxes.find((b) => b.id === currentBoxId) ?? null;
  const createdWaybill = shipment && shipment.status === "created" ? shipment : null;
  const snapshot = createdWaybill?.requestSnapshot && typeof createdWaybill.requestSnapshot === "object" ? (createdWaybill.requestSnapshot as Record<string, unknown>) : null;
  const suggestion = packingSuggestion(
    items,
    candidates,
    createdWaybill
      ? { parcel: waybillParcel(createdWaybill), boxMaterialId: typeof snapshot?.parcelBoxMaterialId === "string" ? snapshot.parcelBoxMaterialId.toLowerCase() : null }
      : null,
  );

  // Розрахункова вага: товари (ті самі позиції, що й у накладній) + тара коробки (або типової упаковки).
  const goodsGrams = parcelWeightItems(items).reduce((s, i) => s + i.weightGrams * i.quantity, 0);
  const defaultPkg = settings.packaging.packages.find((p) => p.code === settings.packaging.defaultPackageCode) ?? settings.packaging.packages[0];
  const defaultTareGrams = defaultPkg?.tareWeightGrams ?? 0;
  const prefill = parcelPrefill(box, goodsGrams, defaultTareGrams);
  const estimateWeightGrams = prefill.weightGrams;
  const savedDims = dimsOf(packing?.parcelLengthMm, packing?.parcelWidthMm, packing?.parcelHeightMm) ?? dimsOf(order.parcelLengthMm, order.parcelWidthMm, order.parcelHeightMm);
  const savedWeight = packing?.parcelWeightGrams ?? order.parcelWeightGrams ?? null;
  const dims = savedDims ?? prefill.dimsMm;

  const adapter = shipment ? ctx.carriers.get(shipment.carrierCode) : undefined;
  const packable = isPackableShipment(shipment);
  const linesPending = shopifyLinesPending(order);
  const fulfilledInShopify = isFulfilledInShopify(order.fulfillmentStatus) && order.status !== "cancelled";
  const cancelled = order.status === "cancelled" ? await openCancelledAfterPacking(db, id) : null;
  const materials = await planPackingMaterials(db, id, currentBoxId);
  const consumedBefore = packing ? await consumedMaterialsFor(db, packing.id) : [];
  const previousBoxes = consumedBefore
    .filter((m) => (m.kind === "box" || m.kind === "mailer") && m.materialId !== currentBoxId)
    .map((m) => ({ code: m.code, name: m.name }));
  const packingParcelStatuses: readonly OrderStatus[] = ["awaiting_review", "waybill_created", "awaiting_picking", "packed"];
  const parcelTarget: PackingScreen["parcelTarget"] = packing
    ? packingParcelStatuses.includes(order.status)
      ? "packing"
      : null
    : !shipment && (PRE_WAYBILL_PARCEL_STATUSES as readonly OrderStatus[]).includes(order.status)
      ? "order"
      : null;
  return {
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      priority: order.priority as OrderPriority,
      placedAt: order.placedAt,
      countryCode: order.shipCountryCode?.trim().toUpperCase() || null,
      city: showCustomer ? order.shipCity : null,
      recipientName: showCustomer ? [order.shipFirstName, order.shipLastName].filter(Boolean).join(" ") : null,
      source: order.source,
      version: order.version,
    },
    customerDataHidden: !showCustomer,
    shipment: shipment
      ? {
          id: shipment.id,
          waybillNumber: shipment.waybillNumber,
          carrierName: adapter?.displayName ?? shipment.carrierCode,
          testMode: shipment.mode === "test",
          packable,
          reissuable: isReissuable(shipment, order.status),
          labelAvailable: availableDocumentKinds(ctx, shipment).includes("label"),
        }
      : null,
    packing: packing ? toPackingInfo(packing) : null,
    lines: lineViews,
    otherLines: items
      .filter((i) => i.variant === null && effectiveLineQuantity(i) > 0)
      .map((i) => ({ id: i.id, title: i.title, quantity: effectiveLineQuantity(i) })),
    staleUnits,
    staleLines,
    progress,
    boxes,
    suggestion,
    materials,
    materialsKey: materialsPlanKey(materials),
    previousBoxes,
    consumedMaterialIds: consumedBefore.map((m) => m.materialId),
    parcelTarget,
    parcel: {
      weightGrams: savedWeight ?? estimateWeightGrams,
      lengthMm: dims?.[0] ?? null,
      widthMm: dims?.[1] ?? null,
      heightMm: dims?.[2] ?? null,
      saved: savedWeight !== null || savedDims !== null,
      estimateWeightGrams,
      savedWeightGrams: savedWeight,
      savedDimsMm: savedDims,
      goodsWeightGrams: goodsGrams,
      defaultTareGrams,
      formBoxId,
    },
    waybillParcel: shipment && shipment.status === "created" ? waybillParcel(shipment) : null,
    mismatch: await parcelMismatchFor(db, order, packing, shipment),
    packedWithoutWaybill: order.status === "packed" && !packable && !isDeletedAtCarrier(shipment),
    materialsConsumed: packing ? await materialsConsumedFor(db, packing.id) : false,
    // «Почати/продовжити»: нове пакування або «Накладна створена» з розпочатим пакуванням (напр. після переоформлення).
    canStart:
      packable &&
      !fulfilledInShopify &&
      (STARTABLE_STATUSES as readonly OrderStatus[]).includes(order.status) &&
      !(order.status === "awaiting_picking" && packing?.status === "in_progress"),
    deletedAtCarrier: isDeletedAtCarrier(shipment),
    shopifyLinesPending: linesPending,
    fulfilledInShopify,
    cancelledAfterPacking: cancelled ? { previousStatus: cancelled.previousStatus, materialsConsumed: cancelled.materialsConsumed } : null,
  };
}

export interface PackingSummary {
  priority: OrderPriority;
  status: OrderStatus;
  packing: (PackingInfo & { boxCode: string | null; boxName: string | null }) | null;
  progress: Pick<ChecklistProgress, "packedUnits" | "requiredUnits" | "overUnits" | "complete">;
  parcel: { weightGrams: number | null; dimsMm: Dims | null };
  mismatch: ParcelMismatch | null;
  materialsConsumed: boolean;
  /** Замовлення в черзі пакування (накладна створена, не передано) — можна відкрити екран пакування. */
  inQueue: boolean;
  /** Запаковано, а дійсної накладної немає (скасовано після «Запаковано»): розпакувати на екрані пакування. */
  packedWithoutWaybill: boolean;
  /** Накладну видалено у перевізника (етикетка недійсна). */
  deletedAtCarrier: boolean;
  /** Етап 5: неперенесені зміни позицій із Shopify (див. PackingScreen.shopifyLinesPending). */
  shopifyLinesPending: boolean;
  /** Етап 5: виконано (частково) в Shopify поза застосунком. */
  fulfilledInShopify: boolean;
  /** Етап 5: скасовано після пакування — посилку розібрати й повернути товар (див. PackingScreen). */
  cancelledAfterPacking: boolean;
  /**
   * Накладної й пакування ще немає, статус до накладної — вагу, габарити й коробку посилки можна задати заздалегідь на
   * екрані пакування (saveOrderParcel; їх використає нова накладна).
   */
  parcelBeforeWaybill: boolean;
}

/** Картка «Пакування» на сторінці замовлення. */
export async function loadPackingSummary(db: DbOrTx, orderId: string): Promise<PackingSummary> {
  const id = normalizeId(orderId, "order");
  const order = await loadOrderRow(db, id);
  const [packing, shipment, items] = await Promise.all([loadActivePacking(db, id), findActiveShipment(db, id), loadLineItems(db, id)]);
  const progress = checklistProgress(toChecklistLines(items), packing?.checklist ?? {});
  let boxCode: string | null = null;
  let boxName: string | null = null;
  if (packing?.boxMaterialId) {
    const [m] = await db.select({ code: packagingMaterials.code, name: packagingMaterials.name }).from(packagingMaterials).where(eq(packagingMaterials.id, packing.boxMaterialId));
    boxCode = m?.code ?? null;
    boxName = m?.name ?? null;
  }
  const packable = isPackableShipment(shipment);
  return {
    priority: order.priority as OrderPriority,
    status: order.status,
    packing: packing ? { ...toPackingInfo(packing), boxCode, boxName } : null,
    progress: { packedUnits: progress.packedUnits, requiredUnits: progress.requiredUnits, overUnits: progress.overUnits, complete: progress.complete },
    parcel: {
      weightGrams: packing?.parcelWeightGrams ?? order.parcelWeightGrams ?? null,
      dimsMm: dimsOf(packing?.parcelLengthMm, packing?.parcelWidthMm, packing?.parcelHeightMm) ?? dimsOf(order.parcelLengthMm, order.parcelWidthMm, order.parcelHeightMm),
    },
    mismatch: await parcelMismatchFor(db, order, packing, shipment),
    materialsConsumed: packing ? await materialsConsumedFor(db, packing.id) : false,
    inQueue: packable && ["waybill_created", "awaiting_picking", "packed"].includes(order.status),
    packedWithoutWaybill: order.status === "packed" && !packable && !isDeletedAtCarrier(shipment),
    deletedAtCarrier: isDeletedAtCarrier(shipment),
    shopifyLinesPending: shopifyLinesPending(order),
    fulfilledInShopify: isFulfilledInShopify(order.fulfillmentStatus) && order.status !== "cancelled",
    cancelledAfterPacking: order.status === "cancelled" && (await openCancelledAfterPacking(db, id)) !== null,
    parcelBeforeWaybill: !packing && !shipment && (PRE_WAYBILL_PARCEL_STATUSES as readonly OrderStatus[]).includes(order.status),
  };
}

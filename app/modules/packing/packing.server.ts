/**
 * Підготовка замовлень — пакування (docs/stage5-design.md §6): початок пакування, контроль комплектації
 * (сканування/ручні ±), коробка й параметри посилки, підтвердження «Запаковано», розпакування, пріоритет.
 *
 * Гарантії:
 * - Статус замовлення змінюється лише дозволеними переходами (domain/order-status) і compare-and-set
 *   (`WHERE status = …`): waybill_created → awaiting_picking (початок), awaiting_picking → packed (підтвердження),
 *   packed → awaiting_picking (розпакування). Подвійне натискання / паралельний запит не дає подвійного переходу.
 * - Одне активне пакування на замовлення (частковий унікальний індекс order_packing_one_active_uq + блокування рядка
 *   замовлення): паралельні «Почати пакування» → одне пакування.
 * - Порядок блокувань: замовлення (FOR NO KEY UPDATE) → пакування (FOR NO KEY UPDATE) → баланси (списання
 *   матеріалів у consumeMaterialsForPacking). Ніколи навпаки.
 * - Матеріали списуються ЛИШЕ при підтвердженні «Запаковано», ідемпотентно: кожен матеріал — не більше одного разу
 *   на пакування (ключ material:<packing>:<material>). Повторне «Запаковано» після розпакування не списує вдруге вже
 *   списане, але списує НОВУ коробку, якщо посилку переклали в іншу (consumption.server.ts). Розпакування матеріалів
 *   автоматично НЕ повертає (фізично їх могли використати) — коригування вручну на сторінці матеріалів.
 * - Списується те, що бачив пакувальник: сторінка надсилає відбиток плану матеріалів (materialsPlanKey); якщо план
 *   на сервері інший (шаблон комплектації змінили, поки екран був відкритий) — packing.error.materialsChanged і
 *   повторне підтвердження зі свіжим переліком.
 * - Дозволи: packing.perform — черга, комплектація, «Запаковано», а також ФІЗИЧНІ параметри посилки (коробка, вага,
 *   габарити: orders.parcel_* з історією order_changes і журналом) — їх вимірює пакувальник, вони не містять даних
 *   покупця й не змінюють позицій/цін. Решта даних замовлення (пріоритет тощо) — orders.edit. Дані отримувача (ім'я,
 *   місто) на екрані пакування — лише з orders.view (view.server.ts).
 * - Створення накладної ≠ пакування ≠ відправлення: «Передано перевізнику» тут не встановлюється.
 * - Журнал (audit_log) — лише ідентифікатори й коди; вільний текст (причина рішення власника) — лише в історії
 *   замовлення (shipment_events.message, з маскуванням телефонів/email).
 */
import { and, count, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryMovements,
  issues,
  orderChanges,
  orderPacking,
  orders,
  packagingMaterials,
  productVariants,
  products,
  shipments,
  type OrderPriority,
} from "~/db/schema";
import { isOrderFulfilledInShopify, isShipped, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { redact } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { loadLineItems, loadOrderRow, type LineItemWithVariant, type OrderRow, type ShipmentRow } from "~/modules/orders/repository.server";
import { BOX_KINDS } from "~/modules/packaging/box-selection";
import { consumeMaterialsForPacking, materialsPlanKey, planPackingMaterials, type ConsumeMaterialsResult } from "~/modules/packaging/consumption.server";
import { manualWeightUse, minPlausibleManualWeight, parcelGoodsWeightGrams, type ParcelWeightCheck } from "~/modules/packaging/parcel";
import {
  PARCEL_WEIGHT_VERIFIED_REASON,
  isParcelWeightOwnerVerified,
  loadParcelWeightCheck,
  selectBoxForOrder,
} from "~/modules/packaging/parcel.server";
import { ACTIVE_SHIPMENT_STATUSES, findActiveShipment } from "~/modules/shipments/waybill.server";
import { enqueueOrderResync, shopifyLinesPending, type ResyncQueueResult } from "~/modules/shopify-sync/pending-lines.server";
import { addPackingEvent, ORDER_CANCELLED_AFTER_PACKING, toChecklistLines } from "./lifecycle.server";
import type { ServiceContext } from "~/server/types";
import {
  ACTIVE_PACKING_STATUSES,
  MAX_BULK_ORDERS,
  MAX_OVERRIDE_REASON_LENGTH,
  MAX_PARCEL_DIMENSION_MM,
  MAX_PARCEL_WEIGHT_GRAMS,
  MAX_SCAN_LENGTH,
  STARTABLE_STATUSES,
  isManualAdjustReason,
  type ManualAdjustReason,
  type PackingEventType,
} from "./constants";
import { compareParcels, dimsOf, waybillParcel, type ParcelMeasure, type ParcelMismatch } from "./parcel-compare";
import { adjustChecklist, applyScan, checklistProgress, codeKey, normalizeScanCode, type ChecklistProgress } from "./scan";

export type PackingRow = typeof orderPacking.$inferSelect;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ідентифікатор → нижній регістр; некоректний → NotFoundError (без помилки SQL «invalid uuid»). */
export function normalizeId(id: string, entity: string): string {
  if (!UUID_RE.test(id)) throw new NotFoundError(entity);
  return id.toLowerCase();
}

// ---------------------------------------------------------------------------
// Спільні допоміжні функції
// ---------------------------------------------------------------------------

/** Активне пакування замовлення; lock — FOR NO KEY UPDATE (після блокування рядка замовлення). */
export async function loadActivePacking(db: DbOrTx, orderId: string, opts: { lock?: boolean } = {}): Promise<PackingRow | null> {
  const query = db
    .select()
    .from(orderPacking)
    .where(and(eq(orderPacking.orderId, orderId), inArray(orderPacking.status, [...ACTIVE_PACKING_STATUSES])))
    .limit(1);
  const [row] = opts.lock ? await query.for("no key update") : await query;
  return row ?? null;
}

export { toChecklistLines };

/**
 * Накладна, з якою можна пакувати: створена, ще не передана перевізнику й не видалена у перевізника (відстеження
 * повідомило «скасовано» — CARRIER_SHIPMENT_DELETED: з «мертвою» етикеткою посилку не передати).
 * Той самий предикат — в екрані пакування, картці замовлення й черзі (SQL — packableShipmentSql у queue.server.ts).
 */
export function isPackableShipment(
  s: Pick<ShipmentRow, "status" | "waybillNumber" | "handedOverAt" | "trackingStatus"> | null,
): s is ShipmentRow {
  return Boolean(s && s.status === "created" && s.waybillNumber && !s.handedOverAt && s.trackingStatus !== "cancelled");
}

/** Накладну видалено у перевізника (відстеження: «скасовано», посилку ще не передано). */
export function isDeletedAtCarrier(s: Pick<ShipmentRow, "status" | "handedOverAt" | "trackingStatus"> | null): boolean {
  return Boolean(s && s.status === "created" && !s.handedOverAt && s.trackingStatus === "cancelled");
}

/**
 * Блокування пакування станом синхронізації з Shopify (під блокуванням рядка замовлення):
 * - замовлення вже виконане (частково) в Shopify поза застосунком → пакувати не можна нікому (повторне відправлення;
 *   шлях — скасувати накладну й «Відправлено поза застосунком»);
 * - Shopify змінив позиції, а застосунок їх ще не застосував (orders.shopify_lines_pending_at) → чекліст зі старими
 *   кількостями: лише власник (почати — бачачи попередження; «Запаковано» — з причиною), інакше
 *   packing.error.shopifyLinesPending. Шлях — скасувати накладну (застосунок перечитає замовлення з Shopify).
 */
function assertShopifyAllowsPacking(order: OrderRow, actor: ServiceContext["actor"], ownerDecision: boolean): void {
  if (isOrderFulfilledInShopify(order)) {
    throw new DomainError("packing.error.fulfilledInShopify", 409, { fulfillment: order.fulfillmentStatus ?? "" });
  }
  if (shopifyLinesPending(order) && !(ownerDecision && actor.role === "owner")) {
    throw new DomainError("packing.error.shopifyLinesPending", 409);
  }
}

/** Перехід статусу замовлення compare-and-set. false — статус уже інший (паралельний запит). */
async function casOrderStatus(tx: Tx, ctx: ServiceContext, order: OrderRow, from: OrderStatus, to: OrderStatus): Promise<boolean> {
  const [row] = await tx
    .update(orders)
    .set({ status: to, version: sql`${orders.version} + 1`, updatedAt: ctx.now() })
    .where(and(eq(orders.id, order.id), eq(orders.status, from)))
    .returning({ id: orders.id });
  if (!row) return false;
  await writeAudit(tx, ctx.actor, "order.status_changed", { type: "order", id: order.id }, { from, to, source: "packing" });
  return true;
}

/** Чи списувалися вже матеріали для цього пакування. */
export async function materialsConsumedFor(db: DbOrTx, packingId: string): Promise<boolean> {
  const [row] = await db
    .select({ c: count() })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.packingId, packingId), eq(inventoryMovements.type, "material_consume")));
  return Number(row?.c ?? 0) > 0;
}

/** Коробка-матеріал (box | mailer) або null. */
async function loadBox(db: DbOrTx, materialId: string): Promise<typeof packagingMaterials.$inferSelect | null> {
  const [m] = await db.select().from(packagingMaterials).where(eq(packagingMaterials.id, materialId));
  return m && BOX_KINDS.includes(m.kind) ? m : null;
}

/**
 * Коробка за замовчуванням для нового пакування — узгоджена з накладною (як planParcelBox): вибрана вручну для
 * замовлення → коробка, з якою створено накладну (знімок запиту) → автоматичний підбір ЛИШЕ з reason = "fits"
 * (усі товари мають габарити) → без коробки. Неточний підбір (лише за вагою / частина товарів без габаритів —
 * звичайний випадок для Shopify, де у варіантів немає габаритів) коробку не підставляє: накладну тоді створено
 * з типовою упаковкою, а підібрана за вагою коробка лише рекомендація на екрані пакування (★). Інакше її
 * габарити одразу давали б хибне «Посилка відрізняється від накладної» і списання коробки, якої ніхто не вибирав.
 */
export async function defaultBoxFor(
  tx: DbOrTx,
  order: Pick<OrderRow, "id" | "parcelBoxMaterialId">,
  shipment: Pick<ShipmentRow, "requestSnapshot"> | null,
): Promise<string | null> {
  const snapshot = shipment?.requestSnapshot && typeof shipment.requestSnapshot === "object" ? (shipment.requestSnapshot as Record<string, unknown>) : null;
  const fromWaybill = typeof snapshot?.parcelBoxMaterialId === "string" ? snapshot.parcelBoxMaterialId : null;
  for (const id of [order.parcelBoxMaterialId, fromWaybill]) {
    if (id && UUID_RE.test(id) && (await loadBox(tx, id))) return id.toLowerCase();
  }
  const selection = await selectBoxForOrder(tx, order.id);
  return selection.box && selection.reason === "fits" ? selection.box.id : null;
}

/**
 * Фактичні параметри посилки пакування: введені/збережені вручну вага й габарити; без габаритів — внутрішні
 * габарити коробки пакування. Коробка пакування — лише вибрана людиною, коробка накладної або точний підбір
 * (defaultBoxFor), тож порівнюються значення, які підтвердив пакувальник або з якими створено накладну.
 * Розрахункова вага (підказка у формі) сюди не потрапляє: зберігається лише введена вручну (parcel-form.ts).
 */
export async function packedParcelOf(
  db: DbOrTx,
  packing: Pick<PackingRow, "boxMaterialId" | "parcelWeightGrams" | "parcelLengthMm" | "parcelWidthMm" | "parcelHeightMm"> | null,
  order: Pick<OrderRow, "parcelWeightGrams" | "parcelLengthMm" | "parcelWidthMm" | "parcelHeightMm">,
): Promise<ParcelMeasure> {
  const weightGrams = packing?.parcelWeightGrams ?? order.parcelWeightGrams ?? null;
  let dimsMm =
    dimsOf(packing?.parcelLengthMm, packing?.parcelWidthMm, packing?.parcelHeightMm) ??
    dimsOf(order.parcelLengthMm, order.parcelWidthMm, order.parcelHeightMm);
  if (!dimsMm && packing?.boxMaterialId) {
    const box = await loadBox(db, packing.boxMaterialId);
    if (box) dimsMm = dimsOf(box.innerLengthMm, box.innerWidthMm, box.innerHeightMm);
  }
  return { weightGrams, dimsMm };
}

/**
 * Розбіжність запакованої посилки з накладною (null — немає або порівнювати нічого).
 * Розбіжність ваги, яку нова накладна теж не використає (зважена вага менша за 90 % ваги товарів за Shopify і не
 * підтверджена власником — manualWeightUse = ignored), позначається weight.ignoredByWaybill: переоформлення її не
 * усуне (mismatchNeedsReissue), екран пояснює причину замість поради «Переоформити».
 */
export async function parcelMismatchFor(
  db: DbOrTx,
  order: OrderRow,
  packing: PackingRow | null,
  shipment: ShipmentRow | null,
): Promise<ParcelMismatch | null> {
  // Після фактичної передачі перевізнику переоформити вже не можна — порада «переоформіть до передачі» хибна.
  if (!shipment || shipment.status !== "created" || shipment.handedOverAt || isShipped(order.status)) return null;
  const mismatch = compareParcels(waybillParcel(shipment), await packedParcelOf(db, packing, order));
  if (!mismatch?.weight) return mismatch;
  const packedGrams = mismatch.weight.packedGrams;
  const goodsGrams = parcelGoodsWeightGrams(await loadLineItems(db, order.id));
  const verified = await isParcelWeightOwnerVerified(db, { id: order.id, parcelWeightGrams: packedGrams });
  if (manualWeightUse(packedGrams, goodsGrams, verified) !== "ignored") return mismatch;
  return { ...mismatch, weight: { ...mismatch.weight, ignoredByWaybill: { goodsGrams, minGrams: minPlausibleManualWeight(goodsGrams) } } };
}

/**
 * Блокування для змін пакування: [накладна FOR KEY SHARE] → замовлення (FOR NO KEY UPDATE) → пакування.
 * withShipment — для дій, що пишуть подію в історію (shipment_events посилається на накладну): відстеження й
 * ручна передача перевізнику блокують накладну FOR UPDATE, а потім замовлення; без попереднього KEY SHARE вставка
 * події після блокування замовлення чекала б на накладну → взаємоблокування.
 */
async function lockForPacking(
  tx: Tx,
  orderId: string,
  opts: { withShipment?: boolean } = {},
): Promise<{ order: OrderRow; packing: PackingRow | null }> {
  if (opts.withShipment) {
    await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(eq(shipments.orderId, orderId), inArray(shipments.status, [...ACTIVE_SHIPMENT_STATUSES])))
      .for("key share");
  }
  const order = await loadOrderRow(tx, orderId, { forUpdate: true });
  const packing = await loadActivePacking(tx, orderId, { lock: true });
  return { order, packing };
}

// ---------------------------------------------------------------------------
// Почати пакування
// ---------------------------------------------------------------------------

export type StartPackingResult =
  /** Створено нове пакування (або взято в роботу заплановане); замовлення → «Очікує комплектації». */
  | { kind: "started"; packingId: string }
  /** Пакування вже розпочате (цим або іншим працівником) — продовжуємо його. */
  | { kind: "already_started"; packingId: string; startedByName: string | null }
  /** Замовлення вже запаковане. */
  | { kind: "already_packed"; packingId: string | null };

export async function startPacking(ctx: ServiceContext, orderId: string): Promise<StartPackingResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  return ctx.db.transaction(async (tx) => {
    const { order, packing: active } = await lockForPacking(tx, id, { withShipment: true });
    if (order.status === "packed") return { kind: "already_packed", packingId: active?.id ?? null };
    if (!(STARTABLE_STATUSES as readonly OrderStatus[]).includes(order.status)) {
      throw new DomainError("packing.error.status", 409, { status: order.status });
    }
    const shipment = await findActiveShipment(tx, id);
    if (!isPackableShipment(shipment)) {
      throw new DomainError(isDeletedAtCarrier(shipment) ? "packing.error.deletedAtCarrier" : "packing.error.noWaybill", 409);
    }
    // Етап 5: позиції застаріли щодо Shopify / уже виконано в Shopify — власник може почати (бачить попередження).
    assertShopifyAllowsPacking(order, ctx.actor, true);
    const now = ctx.now();
    let result: StartPackingResult;
    if (!active) {
      const [gen] = await tx.select({ g: max(orderPacking.generation) }).from(orderPacking).where(eq(orderPacking.orderId, id));
      const [inserted] = await tx
        .insert(orderPacking)
        .values({
          orderId: id,
          generation: (gen?.g ?? 0) + 1,
          status: "in_progress",
          boxMaterialId: await defaultBoxFor(tx, order, shipment),
          parcelWeightGrams: order.parcelWeightGrams,
          parcelLengthMm: order.parcelLengthMm,
          parcelWidthMm: order.parcelWidthMm,
          parcelHeightMm: order.parcelHeightMm,
          startedBy: ctx.actor.id,
          startedByName: ctx.actor.displayName,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: orderPacking.id });
      if (!inserted) {
        // Захисна сітка (рядок замовлення заблоковано, тож паралельна вставка неможлива): беремо наявне.
        const existing = await loadActivePacking(tx, id, { lock: true });
        if (!existing) throw new ConflictError();
        result = { kind: "already_started", packingId: existing.id, startedByName: existing.startedByName };
      } else {
        result = { kind: "started", packingId: inserted.id };
      }
    } else if (active.status === "queued" || active.status === "packed") {
      // queued — заплановане, ще ніхто не почав; packed за статусу «до пакування» — статус змінено поза пакуванням:
      // відновлюємо комплектацію (чекліст зберігається, матеріали вдруге не списуються).
      await tx
        .update(orderPacking)
        .set({
          status: "in_progress",
          startedBy: active.startedBy ?? ctx.actor.id,
          startedByName: active.startedByName ?? ctx.actor.displayName,
          startedAt: active.startedAt ?? now,
          packedBy: null,
          packedByName: null,
          packedAt: null,
          version: sql`${orderPacking.version} + 1`,
          updatedAt: now,
        })
        .where(eq(orderPacking.id, active.id));
      result = active.status === "queued" ? { kind: "started", packingId: active.id } : { kind: "already_started", packingId: active.id, startedByName: active.startedByName };
    } else {
      result = { kind: "already_started", packingId: active.id, startedByName: active.startedByName };
    }
    if (order.status === "waybill_created") await casOrderStatus(tx, ctx, order, "waybill_created", "awaiting_picking");
    if (result.kind === "started") {
      await addPackingEvent(tx, id, "packing_started", { packingId: result.packingId });
      await writeAudit(tx, ctx.actor, "packing.started", { type: "order", id }, { packingId: result.packingId });
    }
    return result;
  });
}

export interface BulkStartSummary {
  started: number;
  alreadyStarted: number;
  alreadyPacked: number;
  skipped: Array<{ orderId: string; code: string; params?: Record<string, string | number> }>;
}

/** «Почати пакування» для вибраних замовлень (кожне — окрема транзакція; помилка одного не зупиняє інші). */
export async function startPackingBulk(ctx: ServiceContext, orderIds: readonly string[]): Promise<BulkStartSummary> {
  requirePermission(ctx.actor, "packing.perform");
  const summary: BulkStartSummary = { started: 0, alreadyStarted: 0, alreadyPacked: 0, skipped: [] };
  for (const raw of [...new Set(orderIds.map((i) => i.toLowerCase()))].slice(0, MAX_BULK_ORDERS)) {
    try {
      const r = await startPacking(ctx, raw);
      if (r.kind === "started") summary.started += 1;
      else if (r.kind === "already_started") summary.alreadyStarted += 1;
      else summary.alreadyPacked += 1;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      summary.skipped.push({ orderId: raw, code: e.code, params: e.params });
    }
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Контроль комплектації: сканування й ручні ±
// ---------------------------------------------------------------------------

export interface ScanLineInfo {
  lineId: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  packed: number;
  required: number;
}

export type ScanResult =
  | { kind: "matched"; line: ScanLineInfo; progress: ChecklistProgress; version: number }
  | { kind: "over_quantity"; line: ScanLineInfo }
  /**
   * Код однозначно не визначає товар: scope "order" — кілька різних позицій замовлення; "catalog" — у каталозі
   * кілька варіантів із цим штрихкодом/SKU (зокрема поза замовленням: напр. скопійований штрихкод іншого кольору).
   * Чекліст не змінюється — пакувальник звіряє модель і колір і позначає товар вручну (+1 з причиною).
   */
  | {
      kind: "ambiguous";
      code: string;
      scope: "order" | "catalog";
      /** Різних варіантів із цим кодом (у переліку variants — не більше AMBIGUOUS_VARIANTS_SHOWN). */
      count: number;
      variants: Array<{ productTitle: string; variantTitle: string | null }>;
    }
  /** Товар із каталогу, якого немає в цьому замовленні. */
  | { kind: "wrong_item"; code: string; productTitle: string; variantTitle: string | null }
  /** Код не знайдено ні в замовленні, ні в каталозі. */
  | { kind: "unknown_code"; code: string }
  | { kind: "empty" };

function lineInfo(items: readonly LineItemWithVariant[], lineId: string, packed: number, required: number): ScanLineInfo {
  const item = items.find((i) => i.id === lineId);
  return {
    lineId,
    title: item?.variant?.productTitle ?? item?.title ?? "",
    variantTitle: item?.variant?.title ?? item?.variantTitle ?? null,
    sku: item?.variant?.sku ?? item?.sku ?? null,
    packed,
    required,
  };
}

/** Пакування, у якому можна змінювати чекліст: розпочате (in_progress) і замовлення «Очікує комплектації». */
function assertPackingOpen(order: OrderRow, packing: PackingRow | null): asserts packing is PackingRow {
  if (order.status === "packed" || packing?.status === "packed") throw new DomainError("packing.error.alreadyPacked", 409);
  if (!packing || packing.status !== "in_progress" || order.status !== "awaiting_picking") {
    throw new DomainError("packing.error.notStarted", 409);
  }
}

/** Умова «штрихкод варіанта = код» з тією самою нормалізацією, що й codeKey (цифровий — без провідних нулів). */
function barcodeEquals(key: string) {
  return /^\d+$/.test(key)
    ? sql`ltrim(upper(replace(coalesce(${productVariants.barcode}, ''), ' ', '')), '0') = ${key}`
    : sql`upper(replace(coalesce(${productVariants.barcode}, ''), ' ', '')) = ${key}`;
}
function skuEquals(key: string) {
  return sql`upper(replace(coalesce(${productVariants.sku}, ''), ' ', '')) = ${key}`;
}

/**
 * Варіант каталогу «живий» — товар не видалено в Shopify (products.status ≠ DELETED, markProductDeleted) і варіант
 * не позначено видаленим (product_variants.removed_at: його не було в ОСТАННЬОМУ повному переліку варіантів товару —
 * upsertProduct; знову з'явився — позначку знято). Видалені рядки зберігаються (на них посилаються замовлення й облік),
 * але їхні штрихкоди/SKU не роблять сканування живого товару «неоднозначним»: після видалення й повторного створення
 * товару (імпорт CSV) або заміни варіанта з тим самим штрихкодом кожне сканування інакше назавжди вимагало б ручного +1.
 */
const catalogVariantLive = sql`(${products.status} is distinct from 'DELETED' and ${productVariants.removedAt} is null)`;

async function findCatalogVariant(db: DbOrTx, code: string): Promise<{ productTitle: string; variantTitle: string | null } | null> {
  const key = codeKey(code);
  if (!key) return null;
  // «Не той товар»: перевага — живому варіанту каталогу; видалений у Shopify — лише якщо інших немає (назва все одно
  // допомагає зрозуміти, що взято з полиці).
  const [row] = await db
    .select({ productTitle: products.title, variantTitle: productVariants.title })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(sql`(${barcodeEquals(key)}) or (${skuEquals(key)})`)
    .orderBy(sql`case when ${catalogVariantLive} then 0 else 1 end`, products.title, productVariants.title, productVariants.id)
    .limit(1);
  return row ?? null;
}

/** Скільки варіантів каталогу показати в повідомленні про неоднозначний код. */
const AMBIGUOUS_VARIANTS_SHOWN = 5;

/**
 * Перевірка коду на рівні КАТАЛОГУ для збігу з позицією замовлення: штрихкод — чи немає іншого варіанта з тим самим
 * штрихкодом; SKU — чи немає іншого варіанта з тим самим SKU або з таким ШТРИХКОДОМ (код — штрихкод іншого товару).
 * Враховуються лише живі варіанти (catalogVariantLive: не видалені в Shopify); варіант самої позиції — завжди.
 * Повертає варіанти (разом із варіантом позиції), якщо їх більше одного; інакше null.
 */
async function catalogAmbiguity(
  db: DbOrTx,
  code: string,
  by: "barcode" | "sku",
  lineVariantId: string | null,
): Promise<{ count: number; variants: Array<{ productTitle: string; variantTitle: string | null }> } | null> {
  const key = codeKey(code);
  if (!key) return null;
  const byCode = by === "barcode" ? barcodeEquals(key) : sql`(${skuEquals(key)}) or (${barcodeEquals(key)})`;
  // Варіант самої позиції — завжди в переліку (SKU позиції може бути з рядка замовлення, а не з варіанта).
  const rows = await db
    .select({ id: productVariants.id, productTitle: products.title, variantTitle: productVariants.title })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(lineVariantId ? sql`((${byCode}) and ${catalogVariantLive}) or ${productVariants.id} = ${lineVariantId}` : sql`(${byCode}) and ${catalogVariantLive}`)
    .orderBy(products.title, productVariants.title, productVariants.id)
    .limit(50);
  if (rows.length <= 1) return null;
  return { count: rows.length, variants: rows.slice(0, AMBIGUOUS_VARIANTS_SHOWN).map((r) => ({ productTitle: r.productTitle, variantTitle: r.variantTitle })) };
}

/** Сканування штрихкоду/SKU: +1 одиниця відповідної позиції (або зрозуміла помилка, чекліст не змінюється). */
export async function recordScan(ctx: ServiceContext, orderId: string, rawCode: string): Promise<ScanResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  const code = normalizeScanCode(rawCode, MAX_SCAN_LENGTH);
  if (!code) return { kind: "empty" };
  return ctx.db.transaction(async (tx): Promise<ScanResult> => {
    const { order, packing } = await lockForPacking(tx, id);
    assertPackingOpen(order, packing);
    const items = await loadLineItems(tx, id);
    const lines = toChecklistLines(items);
    const { match, checklist } = applyScan(lines, packing.checklist ?? {}, code);
    switch (match.kind) {
      case "matched": {
        // Штрихкод/SKU, спільний з іншим варіантом каталогу (напр. інший колір поза замовленням), — не «вдалий збіг»:
        // пакувальник міг узяти не той товар. Чекліст не змінюється — звірити модель/колір і позначити вручну.
        const shared = await catalogAmbiguity(tx, code, match.by, lines.find((l) => l.id === match.lineId)?.variantId ?? null);
        if (shared) return { kind: "ambiguous", code, scope: "catalog", ...shared };
        const [row] = await tx
          .update(orderPacking)
          .set({ checklist, version: sql`${orderPacking.version} + 1`, updatedAt: ctx.now() })
          .where(eq(orderPacking.id, packing.id))
          .returning({ version: orderPacking.version });
        return {
          kind: "matched",
          line: lineInfo(items, match.lineId, match.packed, match.required),
          progress: checklistProgress(lines, checklist),
          version: row!.version,
        };
      }
      case "over_quantity":
        return { kind: "over_quantity", line: lineInfo(items, match.lineId, match.packed, match.required) };
      case "ambiguous":
        return {
          kind: "ambiguous",
          code,
          scope: "order",
          count: new Set(match.lineIds.map((lineId) => lines.find((l) => l.id === lineId)?.variantId ?? lineId)).size,
          variants: match.lineIds.map((lineId) => {
            const info = lineInfo(items, lineId, 0, 0);
            return { productTitle: info.title, variantTitle: info.variantTitle };
          }),
        };
      case "empty":
        return { kind: "empty" };
      case "not_found": {
        const variant = await findCatalogVariant(tx, code);
        return variant ? { kind: "wrong_item", code, ...variant } : { kind: "unknown_code", code };
      }
    }
  });
}

export type AdjustLineResult =
  | { kind: "ok"; line: ScanLineInfo; progress: ChecklistProgress; version: number }
  | { kind: "over_quantity"; line: ScanLineInfo }
  | { kind: "below_zero" };

/** Ручна зміна кількості в чеклісті на ±1 з причиною (код) — для пакувальника (packing.perform). */
export async function adjustPackedLine(
  ctx: ServiceContext,
  orderId: string,
  lineItemId: string,
  delta: 1 | -1,
  reason: ManualAdjustReason,
): Promise<AdjustLineResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  const lineId = normalizeId(lineItemId, "lineItem");
  if (delta !== 1 && delta !== -1) throw new DomainError("error.validation", 400);
  if (!isManualAdjustReason(reason)) throw new DomainError("packing.error.reasonRequired", 400);
  return ctx.db.transaction(async (tx): Promise<AdjustLineResult> => {
    const { order, packing } = await lockForPacking(tx, id);
    assertPackingOpen(order, packing);
    const items = await loadLineItems(tx, id);
    const lines = toChecklistLines(items);
    const r = adjustChecklist(lines, packing.checklist ?? {}, lineId, delta);
    if (r.kind === "unknown_line") throw new NotFoundError("lineItem");
    if (r.kind === "below_zero") return { kind: "below_zero" };
    if (r.kind === "over_quantity") return { kind: "over_quantity", line: lineInfo(items, lineId, r.packed, r.required) };
    const [row] = await tx
      .update(orderPacking)
      .set({ checklist: r.checklist, version: sql`${orderPacking.version} + 1`, updatedAt: ctx.now() })
      .where(eq(orderPacking.id, packing.id))
      .returning({ version: orderPacking.version });
    await writeAudit(tx, ctx.actor, "packing.manual_adjust", { type: "order", id }, { packingId: packing.id, lineItemId: lineId, delta, reason });
    return { kind: "ok", line: lineInfo(items, lineId, r.packed, r.required), progress: checklistProgress(lines, r.checklist), version: row!.version };
  });
}

// ---------------------------------------------------------------------------
// Коробка й параметри посилки (ручне коригування замовлення: orders.parcel_*)
// ---------------------------------------------------------------------------

const trimmed = (v: unknown) => (typeof v === "string" ? v.trim() : v);
const optionalInt = (maxValue: number) =>
  z.preprocess(
    (v) => {
      const t = trimmed(v);
      return t === "" || t === undefined ? null : t;
    },
    z.union([
      z.null(),
      z.coerce.number({ message: "packing.error.number" }).int("packing.error.integer").min(1, "packing.error.range").max(maxValue, "packing.error.range"),
    ]),
  );

export const parcelInputSchema = z
  .object({
    expectedVersion: z.coerce.number({ message: "error.conflict" }).int("error.conflict").min(1, "error.conflict"),
    /** null / "" / "none" — без коробки (інша упаковка). */
    boxMaterialId: z.preprocess(
      (v) => {
        const t = trimmed(v);
        return t === "" || t === "none" || t === undefined ? null : t;
      },
      z.union([z.null(), z.string().regex(UUID_RE, "packing.error.invalidBox").transform((v) => v.toLowerCase())]),
    ),
    weightGrams: optionalInt(MAX_PARCEL_WEIGHT_GRAMS),
    lengthMm: optionalInt(MAX_PARCEL_DIMENSION_MM),
    widthMm: optionalInt(MAX_PARCEL_DIMENSION_MM),
    heightMm: optionalInt(MAX_PARCEL_DIMENSION_MM),
  })
  .superRefine((v, c) => {
    const set = [v.lengthMm, v.widthMm, v.heightMm].filter((x) => x !== null).length;
    if (set !== 0 && set !== 3) c.addIssue({ code: "custom", path: ["lengthMm"], message: "packing.error.dimsAllOrNone" });
  });

/** Вхід savePackingParcel: значення форми (рядки) або типізовані; не передане поле = порожнє (null). */
export interface ParcelInput {
  /** Версія пакування, яку бачив пакувальник (order_packing.version). */
  expectedVersion: number | string;
  /** Коробка-матеріал; null / "" / "none" — без коробки. */
  boxMaterialId?: string | null;
  weightGrams?: number | string | null;
  lengthMm?: number | string | null;
  widthMm?: number | string | null;
  heightMm?: number | string | null;
}

export interface SaveParcelResult {
  /** Змінені поля замовлення (orders.parcel_*), для історії. */
  changed: string[];
  version: number;
  mismatch: ParcelMismatch | null;
  /**
   * Збережена вага менша за 90 % ваги товарів за даними Shopify (loadParcelWeightCheck): use = ignored — накладна її
   * НЕ використає (перевірити ваги товарів у Shopify або підтвердження власника, confirmParcelWeight); owner_verified —
   * використає (підтверджено власником). null — ваги немає або вона правдоподібна.
   */
  weightCheck: ParcelWeightCheck | null;
}

const PARCEL_FIELDS = [
  ["weightGrams", "parcelWeightGrams"],
  ["lengthMm", "parcelLengthMm"],
  ["widthMm", "parcelWidthMm"],
  ["heightMm", "parcelHeightMm"],
] as const;

type ParsedParcelInput = z.infer<typeof parcelInputSchema>;

/**
 * Ручне коригування посилки на рівні замовлення (orders.parcel_*: коробка, вага, габарити) з історією order_changes
 * (поля parcel.*, джерело manual) і журналом order.parcel_updated. Викликати під блокуванням рядка замовлення.
 * currentBoxId — уже вибрана коробка (її можна лишити навіть неактивною); нова — лише активна box | mailer.
 */
async function applyOrderParcel(
  tx: Tx,
  ctx: ServiceContext,
  order: OrderRow,
  v: ParsedParcelInput,
  meta: { packingId: string | null; currentBoxId: string | null; stage: "packing" | "before_waybill" },
): Promise<{ changes: string[]; patch: Partial<OrderRow>; version: number }> {
  let boxCode: string | null = null;
  if (v.boxMaterialId) {
    const box = await loadBox(tx, v.boxMaterialId);
    // Нова коробка — лише активна; уже вибрана (навіть неактивна) — без змін.
    if (!box || (!box.active && v.boxMaterialId !== meta.currentBoxId)) throw new DomainError("packing.error.invalidBox", 400);
    boxCode = box.code;
  }
  const changes: Array<{ field: string; oldValue: string | null; newValue: string | null }> = [];
  const patch: Partial<OrderRow> = {};
  for (const [key, column] of PARCEL_FIELDS) {
    const next = v[key];
    if (order[column] !== next) {
      changes.push({ field: `parcel.${key}`, oldValue: order[column] === null ? null : String(order[column]), newValue: next === null ? null : String(next) });
      patch[column] = next;
    }
  }
  if (order.parcelBoxMaterialId !== v.boxMaterialId) {
    const oldCode = order.parcelBoxMaterialId ? ((await loadBox(tx, order.parcelBoxMaterialId))?.code ?? null) : null;
    changes.push({ field: "parcel.box", oldValue: oldCode, newValue: boxCode });
    patch.parcelBoxMaterialId = v.boxMaterialId;
  }
  let version = order.version;
  if (changes.length > 0) {
    const [row] = await tx
      .update(orders)
      .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: ctx.now() })
      .where(eq(orders.id, order.id))
      .returning({ version: orders.version });
    version = row!.version;
    await tx.insert(orderChanges).values(
      changes.map((c) => ({ orderId: order.id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: "manual" as const, reason: null, actorId: ctx.actor.id })),
    );
    await writeAudit(tx, ctx.actor, "order.parcel_updated", { type: "order", id: order.id }, {
      packingId: meta.packingId,
      fields: changes.map((c) => c.field),
      stage: meta.stage,
    });
  }
  return { changes: changes.map((c) => c.field), patch, version };
}

/**
 * Зберігає коробку, вагу й габарити посилки: у пакуванні й як ручне коригування замовлення (orders.parcel_*),
 * яке використовує створення/переоформлення накладної. Історія — order_changes (поля parcel.*).
 * Після «Запаковано» коробку не змінити (матеріали вже списано) — лише вагу/габарити.
 */
export async function savePackingParcel(ctx: ServiceContext, orderId: string, input: ParcelInput): Promise<SaveParcelResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  const v = parcelInputSchema.parse(input);
  return ctx.db.transaction(async (tx) => {
    const { order, packing } = await lockForPacking(tx, id);
    if (isShipped(order.status) || order.status === "cancelled") throw new DomainError("packing.error.status", 409, { status: order.status });
    if (!packing) throw new DomainError("packing.error.notStarted", 409);
    if (packing.version !== v.expectedVersion) throw new ConflictError();
    const packed = packing.status === "packed";
    if (packed && v.boxMaterialId !== packing.boxMaterialId) throw new DomainError("packing.error.boxLocked", 409);
    const { changes, patch } = await applyOrderParcel(tx, ctx, order, v, { packingId: packing.id, currentBoxId: packing.boxMaterialId, stage: "packing" });
    const now = ctx.now();
    const [updated] = await tx
      .update(orderPacking)
      .set({
        boxMaterialId: v.boxMaterialId,
        parcelWeightGrams: v.weightGrams,
        parcelLengthMm: v.lengthMm,
        parcelWidthMm: v.widthMm,
        parcelHeightMm: v.heightMm,
        version: sql`${orderPacking.version} + 1`,
        updatedAt: now,
      })
      .where(eq(orderPacking.id, packing.id))
      .returning();
    const fresh = { ...order, ...patch };
    const mismatch = await parcelMismatchFor(tx, fresh, updated!, await findActiveShipment(tx, id));
    return { changed: changes, version: updated!.version, mismatch, weightCheck: await loadParcelWeightCheck(tx, fresh) };
  });
}

/** Статуси, у яких посилку можна виміряти й зважити ДО створення накладної (накладної ще немає). */
export const PRE_WAYBILL_PARCEL_STATUSES = ["paid", "awaiting_review", "needs_correction"] as const satisfies readonly OrderStatus[];

export interface SaveOrderParcelResult {
  changed: string[];
  /** Нова версія замовлення (orders.version) — для наступного збереження форми. */
  version: number;
  /** Як у SaveParcelResult: зважена вага, яку нова накладна не використає без підтвердження власника. */
  weightCheck: ParcelWeightCheck | null;
}

/**
 * Коробка, вага й габарити посилки ДО створення накладної («спершу запакувати й зважити, потім накладна»): ручне
 * коригування замовлення (orders.parcel_*) з історією; його бере наступна накладна (planParcelBox / buildShipmentRequest;
 * застаріле після зміни позицій скидає resetStaleParcelOverride). Пакування ще немає, тож expectedVersion — версія
 * замовлення (orders.version). З активною накладною або розпочатим пакуванням — savePackingParcel (там є порівняння з
 * накладною). Дозвіл — packing.perform (фізичні параметри посилки, див. заголовок файлу).
 */
export async function saveOrderParcel(ctx: ServiceContext, orderId: string, input: ParcelInput): Promise<SaveOrderParcelResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  const v = parcelInputSchema.parse(input);
  return ctx.db.transaction(async (tx) => {
    const { order, packing } = await lockForPacking(tx, id, { withShipment: true });
    if (!(PRE_WAYBILL_PARCEL_STATUSES as readonly OrderStatus[]).includes(order.status)) {
      throw new DomainError("packing.error.status", 409, { status: order.status });
    }
    if (packing) throw new DomainError("packing.error.parcelUsePacking", 409);
    if (await findActiveShipment(tx, id)) throw new DomainError("packing.error.parcelHasWaybill", 409);
    if (order.version !== v.expectedVersion) throw new ConflictError();
    const r = await applyOrderParcel(tx, ctx, order, v, { packingId: null, currentBoxId: order.parcelBoxMaterialId, stage: "before_waybill" });
    return { changed: r.changes, version: r.version, weightCheck: await loadParcelWeightCheck(tx, { ...order, ...r.patch }) };
  });
}

export type ConfirmParcelWeightResult =
  /** Підтверджено: накладна (нова/переоформлена) використає цю вагу. */
  | { kind: "confirmed"; weightGrams: number; goodsGrams: number }
  /** Цю вагу вже підтверджено — нічого не змінено. */
  | { kind: "already_confirmed"; weightGrams: number }
  /** Вага правдоподібна (не менша за 90 % ваги товарів) — підтвердження не потрібне, нічого не змінено. */
  | { kind: "not_needed"; weightGrams: number };

/**
 * Рішення власника: зважена вага посилки правильна, хоча менша за 90 % ваги товарів за даними Shopify (ваги товарів
 * у Shopify завищені, напр. 500 г для товару 400 г). Без цього накладна надсилає розрахункову вагу
 * (buildShipmentRequest), а переоформлення розбіжності не усуває. Запис — order_changes (поле parcel.weightGrams,
 * старе = нове значення, причина PARCEL_WEIGHT_VERIFIED_REASON) і журнал order.parcel_weight_confirmed; діє, доки
 * вагу не змінено (isParcelWeightOwnerVerified). weightGrams — вага, яку бачив власник: інша поточна → ConflictError.
 * Лише власник; наявну накладну не змінює (нова вага — для нової/переоформленої накладної).
 */
export async function confirmParcelWeight(ctx: ServiceContext, orderId: string, input: { weightGrams: number | string }): Promise<ConfirmParcelWeightResult> {
  requirePermission(ctx.actor, "packing.perform");
  if (ctx.actor.role !== "owner") throw new DomainError("packing.error.weightConfirmOwnerOnly", 403);
  const id = normalizeId(orderId, "order");
  const weightGrams = z.coerce.number().int().min(1).max(MAX_PARCEL_WEIGHT_GRAMS).safeParse(trimmed(input.weightGrams));
  if (!weightGrams.success) throw new DomainError("error.validation", 400);
  return ctx.db.transaction(async (tx): Promise<ConfirmParcelWeightResult> => {
    const { order } = await lockForPacking(tx, id);
    if (isShipped(order.status) || order.status === "cancelled") throw new DomainError("packing.error.status", 409, { status: order.status });
    // Підтверджується саме та вага, яку бачив власник (її могли перезважити, поки сторінка була відкрита).
    if (order.parcelWeightGrams !== weightGrams.data) throw new ConflictError();
    const check = await loadParcelWeightCheck(tx, order);
    if (!check) return { kind: "not_needed", weightGrams: weightGrams.data };
    if (check.use === "owner_verified") return { kind: "already_confirmed", weightGrams: weightGrams.data };
    const value = String(weightGrams.data);
    await tx.insert(orderChanges).values({
      orderId: id,
      field: "parcel.weightGrams",
      oldValue: value,
      newValue: value,
      source: "manual",
      reason: PARCEL_WEIGHT_VERIFIED_REASON,
      actorId: ctx.actor.id,
    });
    await writeAudit(tx, ctx.actor, "order.parcel_weight_confirmed", { type: "order", id }, { weightGrams: weightGrams.data, goodsGrams: check.goodsGrams });
    return { kind: "confirmed", weightGrams: weightGrams.data, goodsGrams: check.goodsGrams };
  });
}

// ---------------------------------------------------------------------------
// Підтвердження «Запаковано» і розпакування
// ---------------------------------------------------------------------------

export interface ConfirmPackedOptions {
  /** Рішення власника: підтвердити без повного комплекту (причина — у історії замовлення). */
  override?: { reason: string };
  /**
   * Відбиток плану матеріалів, який бачив пакувальник (materialsPlanKey з екрана пакування). Інший план на сервері →
   * packing.error.materialsChanged (нічого не змінено): сторінка оновлює перелік, пакувальник підтверджує ще раз.
   * Не передано (внутрішні виклики, тести) — без перевірки.
   */
  expectedMaterials?: string | null;
}

export type ConfirmPackedResult =
  | {
      kind: "packed";
      packingId: string;
      override: boolean;
      materials: Pick<ConsumeMaterialsResult, "alreadyConsumed" | "totalShortage"> & {
        lines: Array<{ code: string; name: string; consumed: number; shortage: number; isBox: boolean }>;
      };
      mismatch: ParcelMismatch | null;
    }
  /** Уже запаковано (повторне натискання / паралельний запит) — нічого не змінено. */
  | { kind: "already_packed"; packingId: string | null; mismatch: ParcelMismatch | null };

/**
 * «Запаковано»: лише з повним комплектом (власник може підтвердити без нього з причиною — журнал + історія).
 * Одна транзакція: замовлення → пакування → списання матеріалів (ідемпотентно) → статус (compare-and-set).
 * expectedVersion — версія пакування, яку бачив пакувальник (інакше ConflictError: чекліст змінився).
 */
export async function confirmPacked(
  ctx: ServiceContext,
  orderId: string,
  expectedVersion: number,
  opts: ConfirmPackedOptions = {},
): Promise<ConfirmPackedResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  const overrideReason = opts.override ? opts.override.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : null;
  if (opts.override) {
    if (ctx.actor.role !== "owner") throw new DomainError("packing.error.overrideOwnerOnly", 403);
    if (!overrideReason || overrideReason.length < 3) throw new DomainError("packing.error.overrideReasonRequired", 400);
  }
  return ctx.db.transaction(async (tx): Promise<ConfirmPackedResult> => {
    const { order, packing } = await lockForPacking(tx, id, { withShipment: true });
    const shipment = await findActiveShipment(tx, id);
    if (order.status === "packed" && packing?.status === "packed") {
      return { kind: "already_packed", packingId: packing.id, mismatch: await parcelMismatchFor(tx, order, packing, shipment) };
    }
    if (order.status === "packed") return { kind: "already_packed", packingId: packing?.id ?? null, mismatch: null };
    assertPackingOpen(order, packing);
    if (!Number.isSafeInteger(expectedVersion) || packing.version !== expectedVersion) throw new ConflictError();
    if (!isPackableShipment(shipment)) {
      throw new DomainError(isDeletedAtCarrier(shipment) ? "packing.error.deletedAtCarrier" : "packing.error.noWaybill", 409);
    }
    // Етап 5: неперенесені зміни позицій із Shopify — «Запаковано» лише рішенням власника з причиною.
    const linesPending = shopifyLinesPending(order);
    assertShopifyAllowsPacking(order, ctx.actor, Boolean(overrideReason));

    const items = await loadLineItems(tx, id);
    const lines = toChecklistLines(items);
    const progress = checklistProgress(lines, packing.checklist ?? {});
    // Нічого перевіряти (усі позиції повернено/видалено або жодна не є товаром каталогу) — не «повний комплект»:
    // порожню посилку підтверджує лише власник із причиною.
    const nothingToPack = progress.requiredUnits === 0;
    const override = !progress.complete || nothingToPack || linesPending;
    if (nothingToPack && !overrideReason) throw new DomainError("packing.error.nothingToPack", 409);
    if (!progress.complete && !overrideReason) {
      throw new DomainError("packing.error.checklistIncomplete", 409, { packed: progress.packedUnits, required: progress.requiredUnits, over: progress.overUnits });
    }
    // Списується саме той перелік, який бачив пакувальник (шаблони комплектації могли змінитися, поки екран відкритий).
    if (opts.expectedMaterials !== undefined && opts.expectedMaterials !== null) {
      const plan = await planPackingMaterials(tx, id, packing.boxMaterialId);
      if (materialsPlanKey(plan) !== opts.expectedMaterials) throw new DomainError("packing.error.materialsChanged", 409);
    }

    // Матеріали: коробка + комплектація. Фізичне пакування вже відбулося — нестача не блокує (allowShortage),
    // а видна в результаті й у попередженнях матеріалів.
    const consumed = await consumeMaterialsForPacking(tx, ctx.actor, { packingId: packing.id, orderId: id, boxMaterialId: packing.boxMaterialId }, { allowShortage: true });

    const now = ctx.now();
    const [updated] = await tx
      .update(orderPacking)
      .set({
        status: "packed",
        packedBy: ctx.actor.id,
        packedByName: ctx.actor.displayName,
        packedAt: now,
        version: sql`${orderPacking.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(orderPacking.id, packing.id), eq(orderPacking.status, "in_progress")))
      .returning();
    if (!updated || !(await casOrderStatus(tx, ctx, order, "awaiting_picking", "packed"))) throw new ConflictError();

    const type: PackingEventType = override ? "packed_override" : "packed";
    const message = override ? String(redact(overrideReason ?? "")).slice(0, MAX_OVERRIDE_REASON_LENGTH) : null;
    await addPackingEvent(
      tx,
      id,
      type,
      {
        packingId: packing.id,
        packed: progress.packedUnits,
        required: progress.requiredUnits,
        ...(linesPending ? { shopifyLinesPending: true } : {}),
        ...(nothingToPack ? { nothingToPack: true } : {}),
      },
      message,
    );
    await writeAudit(tx, ctx.actor, override ? "packing.confirmed_override" : "packing.confirmed", { type: "order", id }, {
      packingId: packing.id,
      packedUnits: progress.packedUnits,
      requiredUnits: progress.requiredUnits,
      overUnits: progress.overUnits,
      materialsAlreadyConsumed: consumed.alreadyConsumed,
      materialShortage: consumed.totalShortage,
      ...(linesPending ? { shopifyLinesPendingAcknowledged: true } : {}),
      ...(nothingToPack ? { nothingToPack: true } : {}),
    });
    return {
      kind: "packed",
      packingId: packing.id,
      override,
      materials: {
        alreadyConsumed: consumed.alreadyConsumed,
        totalShortage: consumed.totalShortage,
        lines: consumed.lines.map((l) => ({ code: l.code, name: l.name, consumed: l.consumed, shortage: l.shortage, isBox: l.isBox })),
      },
      mismatch: await parcelMismatchFor(tx, { ...order, status: "packed" }, updated, shipment),
    };
  });
}

export type UnpackResult =
  | {
      kind: "unpacked";
      packingId: string;
      materialsConsumed: boolean;
      /**
       * Новий статус замовлення: «Очікує комплектації»; «Очікує перевірки» — активної накладної немає (її скасовано
       * після «Запаковано»): лише з цього статусу можна створити нову накладну.
       */
      status: Extract<OrderStatus, "awaiting_picking" | "awaiting_review">;
      /**
       * Етап 5: повернуто до «Очікує перевірки», а Shopify змінив позиції під час накладної — поставлено повторне
       * читання замовлення (як після скасування накладної); undefined — не потрібно.
       */
      shopifyResync?: ResyncQueueResult;
    }
  /** Замовлення не запаковане (вже розпаковане паралельним запитом) — нічого не змінено. */
  | { kind: "not_packed" };

/**
 * «Розпакувати» до передачі перевізнику: замовлення → «Очікує комплектації», пакування знову в роботі (те саме
 * пакування: повторне «Запаковано» матеріали вдруге не списує). Матеріали автоматично НЕ повертаються.
 * Без активної накладної (скасовано після «Запаковано» — скасування повертає до перевірки лише «Накладна
 * створена» / «Очікує комплектації») — далі «Очікує комплектації» → «Очікує перевірки» (дозволений перехід), щоб
 * можна було створити нову накладну; пакування лишається в роботі, після нової накладної — «Продовжити пакування».
 */
export async function unpackOrder(ctx: ServiceContext, orderId: string, opts: { resetChecklist?: boolean } = {}): Promise<UnpackResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  return ctx.db.transaction(async (tx): Promise<UnpackResult> => {
    const { order, packing } = await lockForPacking(tx, id, { withShipment: true });
    if (order.status !== "packed") {
      if (isShipped(order.status)) throw new DomainError("packing.error.status", 409, { status: order.status });
      return { kind: "not_packed" };
    }
    const shipment = await findActiveShipment(tx, id);
    if (shipment?.handedOverAt) throw new DomainError("packing.error.status", 409, { status: "handed_to_carrier" });
    if (!(await casOrderStatus(tx, ctx, order, "packed", "awaiting_picking"))) return { kind: "not_packed" };
    // Рядок замовлення заблоковано вище (FOR NO KEY UPDATE), тож другий перехід — у тій самій транзакції без гонок.
    const status = shipment ? "awaiting_picking" : "awaiting_review";
    if (!shipment && !(await casOrderStatus(tx, ctx, order, "awaiting_picking", "awaiting_review"))) throw new ConflictError();
    const now = ctx.now();
    let packingId: string;
    if (packing) {
      await tx
        .update(orderPacking)
        .set({
          status: "in_progress",
          packedBy: null,
          packedByName: null,
          packedAt: null,
          ...(opts.resetChecklist ? { checklist: {} } : {}),
          version: sql`${orderPacking.version} + 1`,
          updatedAt: now,
        })
        .where(eq(orderPacking.id, packing.id));
      packingId = packing.id;
    } else {
      // Запаковано поза модулем (без запису пакування): створюємо пакування для повторної комплектації.
      const [gen] = await tx.select({ g: max(orderPacking.generation) }).from(orderPacking).where(eq(orderPacking.orderId, id));
      const [row] = await tx
        .insert(orderPacking)
        .values({
          orderId: id,
          generation: (gen?.g ?? 0) + 1,
          status: "in_progress",
          boxMaterialId: await defaultBoxFor(tx, order, shipment),
          startedBy: ctx.actor.id,
          startedByName: ctx.actor.displayName,
          startedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: orderPacking.id });
      packingId = row!.id;
    }
    // Етап 5: накладну скасовано, поки замовлення було запаковане (скасування не повертає «Запаковано» до перевірки й
    // тому не ставило повторне читання з Shopify) — тепер позиції можна застосувати.
    const shopifyResync = status === "awaiting_review" && shopifyLinesPending(order) ? await enqueueOrderResync(tx, order) : undefined;
    const materialsConsumed = await materialsConsumedFor(tx, packingId);
    await addPackingEvent(tx, id, "unpacked", { packingId, resetChecklist: Boolean(opts.resetChecklist), status });
    await writeAudit(tx, ctx.actor, "packing.unpacked", { type: "order", id }, {
      packingId,
      resetChecklist: Boolean(opts.resetChecklist),
      materialsConsumed,
      noActiveWaybill: !shipment,
      ...(shopifyResync ? { shopifyResync } : {}),
    });
    return { kind: "unpacked", packingId, materialsConsumed, status, ...(shopifyResync ? { shopifyResync } : {}) };
  });
}

// ---------------------------------------------------------------------------
// Скасовано після пакування: «Повернуто на склад»
// ---------------------------------------------------------------------------

export type ReturnCancelledResult =
  /** Попередження закрито: товар повернуто на полицю, посилку розібрано. */
  | { kind: "returned"; issueId: string }
  /** Немає відкритого попередження (уже закрито) — нічого не змінено. */
  | { kind: "nothing" };

/**
 * Склад підтверджує, що посилку скасованого після пакування замовлення розібрано й товар повернуто на полицю:
 * закриває ORDER_CANCELLED_AFTER_PACKING (подія packing_returned, журнал). Резерв уже знято скасуванням, залишок
 * товару не змінюється (товар не списувався — списання лише при передачі перевізнику). Матеріали автоматично не
 * повертаються — коригування на сторінці матеріалів (як і при розпакуванні).
 */
export async function confirmCancelledPackingReturned(ctx: ServiceContext, orderId: string): Promise<ReturnCancelledResult> {
  requirePermission(ctx.actor, "packing.perform");
  const id = normalizeId(orderId, "order");
  return ctx.db.transaction(async (tx): Promise<ReturnCancelledResult> => {
    const order = await loadOrderRow(tx, id, { forUpdate: true });
    if (order.status !== "cancelled") throw new DomainError("packing.error.status", 409, { status: order.status });
    const [issue] = await tx
      .select({ id: issues.id, params: issues.params })
      .from(issues)
      .where(and(eq(issues.orderId, id), eq(issues.code, ORDER_CANCELLED_AFTER_PACKING), eq(issues.status, "open")))
      .for("update");
    if (!issue) return { kind: "nothing" };
    const now = ctx.now();
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: now, resolvedBy: ctx.actor.id, resolution: "returned_to_stock", updatedAt: now })
      .where(eq(issues.id, issue.id));
    await addPackingEvent(tx, id, "packing_returned", { packingId: typeof issue.params.packingId === "string" ? issue.params.packingId : null });
    await writeAudit(tx, ctx.actor, "packing.returned_to_stock", { type: "order", id }, { issueId: issue.id });
    return { kind: "returned", issueId: issue.id };
  });
}

// ---------------------------------------------------------------------------
// Пріоритет відправлення (orders.edit)
// ---------------------------------------------------------------------------

export interface PriorityResult {
  changed: boolean;
  priority: OrderPriority;
}

/** Пріоритет можна змінити до передачі перевізнику (не для скасованих/відправлених замовлень). */
export async function setOrderPriority(ctx: ServiceContext, orderId: string, priority: OrderPriority): Promise<PriorityResult> {
  requirePermission(ctx.actor, "orders.edit");
  const id = normalizeId(orderId, "order");
  if (![0, 1, 2].includes(priority)) throw new DomainError("packing.error.invalidPriority", 400);
  return ctx.db.transaction(async (tx) => {
    const order = await loadOrderRow(tx, id, { forUpdate: true });
    if (isShipped(order.status) || order.status === "cancelled") throw new DomainError("packing.error.priorityStatus", 409, { status: order.status });
    if (order.priority === priority) return { changed: false, priority };
    await tx
      .update(orders)
      .set({ priority, version: sql`${orders.version} + 1`, updatedAt: ctx.now() })
      .where(eq(orders.id, id));
    await writeAudit(tx, ctx.actor, "order.priority_changed", { type: "order", id }, { from: order.priority, to: priority });
    return { changed: true, priority };
  });
}

export interface BulkPrioritySummary {
  updated: number;
  unchanged: number;
  skipped: Array<{ orderId: string; code: string; params?: Record<string, string | number> }>;
}

export async function setOrdersPriority(ctx: ServiceContext, orderIds: readonly string[], priority: OrderPriority): Promise<BulkPrioritySummary> {
  requirePermission(ctx.actor, "orders.edit");
  const summary: BulkPrioritySummary = { updated: 0, unchanged: 0, skipped: [] };
  for (const raw of [...new Set(orderIds.map((i) => i.toLowerCase()))].slice(0, MAX_BULK_ORDERS)) {
    try {
      const r = await setOrderPriority(ctx, raw, priority);
      if (r.changed) summary.updated += 1;
      else summary.unchanged += 1;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      summary.skipped.push({ orderId: raw, code: e.code, params: e.params });
    }
  }
  return summary;
}

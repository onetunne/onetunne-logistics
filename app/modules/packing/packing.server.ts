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
 * - Матеріали списуються ЛИШЕ при підтвердженні «Запаковано», ідемпотентно (ключ material:<packing>:<material>;
 *   повторне підтвердження того самого пакування після розпакування нічого не списує вдруге). Розпакування
 *   матеріалів автоматично НЕ повертає (фізично їх могли використати) — коригування вручну на сторінці матеріалів.
 * - Створення накладної ≠ пакування ≠ відправлення: «Передано перевізнику» тут не встановлюється.
 * - Журнал (audit_log) — лише ідентифікатори й коди; вільний текст (причина рішення власника) — лише в історії
 *   замовлення (shipment_events.message, з маскуванням телефонів/email).
 */
import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  inventoryMovements,
  orderChanges,
  orderPacking,
  orders,
  packagingMaterials,
  productVariants,
  products,
  shipmentEvents,
  shipments,
  type OrderPriority,
} from "~/db/schema";
import { isShipped, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { redact } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { loadLineItems, loadOrderRow, type LineItemWithVariant, type OrderRow, type ShipmentRow } from "~/modules/orders/repository.server";
import { BOX_KINDS } from "~/modules/packaging/box-selection";
import { consumeMaterialsForPacking, type ConsumeMaterialsResult } from "~/modules/packaging/consumption.server";
import { selectBoxForOrder } from "~/modules/packaging/parcel.server";
import { ACTIVE_SHIPMENT_STATUSES, findActiveShipment } from "~/modules/shipments/waybill.server";
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
import { adjustChecklist, applyScan, checklistProgress, codeKey, normalizeScanCode, type ChecklistLine, type ChecklistProgress } from "./scan";

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

/** Позиції чекліста: лише товари з варіантом (довільні позиції без товару не пакуються — як у «Упаковці»). */
export function toChecklistLines(items: readonly LineItemWithVariant[]): ChecklistLine[] {
  return items
    .filter((i) => i.variant !== null)
    .map((i) => ({
      id: i.id,
      variantId: i.variant!.id,
      sku: i.variant!.sku ?? i.sku,
      barcode: i.variant!.barcode,
      required: effectiveLineQuantity(i),
    }));
}

/** Накладна, з якою можна пакувати: створена й ще не передана перевізнику. */
function isPackableShipment(s: ShipmentRow | null): s is ShipmentRow {
  return Boolean(s && s.status === "created" && s.waybillNumber && !s.handedOverAt);
}

/** Подія пакування в історії замовлення (події активної накладної; без неї — останньої накладної замовлення). */
async function addPackingEvent(
  tx: DbOrTx,
  orderId: string,
  type: PackingEventType,
  data: Record<string, unknown>,
  message: string | null = null,
): Promise<void> {
  const active = await findActiveShipment(tx, orderId);
  const shipmentId =
    active?.id ??
    (await tx.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, orderId)).orderBy(desc(shipments.createdAt)).limit(1))[0]?.id;
  if (!shipmentId) return;
  await tx.insert(shipmentEvents).values({ shipmentId, type, message, data });
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
async function defaultBoxFor(tx: DbOrTx, order: OrderRow, shipment: ShipmentRow | null): Promise<string | null> {
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

/** Розбіжність запакованої посилки з накладною (null — немає або порівнювати нічого). */
export async function parcelMismatchFor(
  db: DbOrTx,
  order: OrderRow,
  packing: PackingRow | null,
  shipment: ShipmentRow | null,
): Promise<ParcelMismatch | null> {
  if (!shipment || shipment.status !== "created") return null;
  return compareParcels(waybillParcel(shipment), await packedParcelOf(db, packing, order));
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
    if (!isPackableShipment(shipment)) throw new DomainError("packing.error.noWaybill", 409);
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
  | { kind: "ambiguous"; code: string }
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

async function findCatalogVariant(db: DbOrTx, code: string): Promise<{ productTitle: string; variantTitle: string | null } | null> {
  const key = codeKey(code);
  if (!key) return null;
  const digits = /^\d+$/.test(key);
  const [row] = await db
    .select({ productTitle: products.title, variantTitle: productVariants.title })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .where(
      digits
        ? sql`ltrim(upper(replace(coalesce(${productVariants.barcode}, ''), ' ', '')), '0') = ${key}
            or upper(replace(coalesce(${productVariants.sku}, ''), ' ', '')) = ${key}`
        : sql`upper(replace(coalesce(${productVariants.barcode}, ''), ' ', '')) = ${key}
            or upper(replace(coalesce(${productVariants.sku}, ''), ' ', '')) = ${key}`,
    )
    .limit(1);
  return row ?? null;
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
        return { kind: "ambiguous", code };
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
}

const PARCEL_FIELDS = [
  ["weightGrams", "parcelWeightGrams"],
  ["lengthMm", "parcelLengthMm"],
  ["widthMm", "parcelWidthMm"],
  ["heightMm", "parcelHeightMm"],
] as const;

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
    let boxCode: string | null = null;
    if (v.boxMaterialId) {
      const box = await loadBox(tx, v.boxMaterialId);
      // Нова коробка — лише активна; уже вибрана (навіть неактивна) — без змін.
      if (!box || (!box.active && v.boxMaterialId !== packing.boxMaterialId)) throw new DomainError("packing.error.invalidBox", 400);
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
    const now = ctx.now();
    if (changes.length > 0) {
      await tx
        .update(orders)
        .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: now })
        .where(eq(orders.id, id));
      await tx.insert(orderChanges).values(
        changes.map((c) => ({ orderId: id, field: c.field, oldValue: c.oldValue, newValue: c.newValue, source: "manual" as const, reason: null, actorId: ctx.actor.id })),
      );
      await writeAudit(tx, ctx.actor, "order.parcel_updated", { type: "order", id }, { packingId: packing.id, fields: changes.map((c) => c.field) });
    }
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
    return { changed: changes.map((c) => c.field), version: updated!.version, mismatch };
  });
}

// ---------------------------------------------------------------------------
// Підтвердження «Запаковано» і розпакування
// ---------------------------------------------------------------------------

export interface ConfirmPackedOptions {
  /** Рішення власника: підтвердити без повного комплекту (причина — у історії замовлення). */
  override?: { reason: string };
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
    if (!isPackableShipment(shipment)) throw new DomainError("packing.error.noWaybill", 409);

    const items = await loadLineItems(tx, id);
    const lines = toChecklistLines(items);
    const progress = checklistProgress(lines, packing.checklist ?? {});
    const override = !progress.complete;
    if (override && !overrideReason) {
      throw new DomainError("packing.error.checklistIncomplete", 409, { packed: progress.packedUnits, required: progress.requiredUnits, over: progress.overUnits });
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
    await addPackingEvent(tx, id, type, { packingId: packing.id, packed: progress.packedUnits, required: progress.requiredUnits }, message);
    await writeAudit(tx, ctx.actor, override ? "packing.confirmed_override" : "packing.confirmed", { type: "order", id }, {
      packingId: packing.id,
      packedUnits: progress.packedUnits,
      requiredUnits: progress.requiredUnits,
      overUnits: progress.overUnits,
      materialsAlreadyConsumed: consumed.alreadyConsumed,
      materialShortage: consumed.totalShortage,
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
    const materialsConsumed = await materialsConsumedFor(tx, packingId);
    await addPackingEvent(tx, id, "unpacked", { packingId, resetChecklist: Boolean(opts.resetChecklist), status });
    await writeAudit(tx, ctx.actor, "packing.unpacked", { type: "order", id }, {
      packingId,
      resetChecklist: Boolean(opts.resetChecklist),
      materialsConsumed,
      noActiveWaybill: !shipment,
    });
    return { kind: "unpacked", packingId, materialsConsumed, status };
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

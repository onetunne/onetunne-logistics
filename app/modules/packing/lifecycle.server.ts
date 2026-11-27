/**
 * Пакування поза звичайним шляхом «Почати → Запаковано» (етап 5): що відбувається з активним пакуванням, коли
 * замовлення скасовують або посилку фактично передають перевізнику без підтвердженої комплектації.
 *
 * Правила (docs/stage5-design.md §6):
 * - Скасування замовлення (у застосунку або в Shopify → cancelOrder): активне пакування закривається (cancelled) з
 *   подією в історії. Якщо пакування вже почали (in_progress) або запакували (packed), склад має фізично розібрати
 *   посилку, повернути товар на полицю й матеріали — відкривається попередження ORDER_CANCELLED_AFTER_PACKING; його
 *   закриває «Повернуто на склад» на екрані пакування (або приховування в «Проблемах»). Матеріали автоматично НЕ
 *   повертаються (як і при розпакуванні: їх могли використати) — коригування на сторінці матеріалів.
 * - Передача перевізнику без «Запаковано» (контроль комплектації не пройдено):
 *   - ручна (markHandedOver): пакування розпочате, але не підтверджене, — лише рішенням власника з причиною
 *     (finalizePackingAtHandover: пакування → packed, матеріали списуються один раз, подія з причиною); пакування не
 *     розпочинали — передача дозволена (склад може не пакувати в застосунку), але не мовчки: подія в історії, журнал,
 *     застереження в діалозі; матеріали не списуються;
 *   - за даними перевізника (відстеження) — факт перевізника головніший, передачу не блокуємо: розпочате пакування
 *     закривається (cancelled) з подією, а якщо комплектацію почали й не завершили — попередження
 *     PACKING_SKIPPED_AT_HANDOVER (перевірити, що поїхало в посилці, і матеріали).
 * Порядок блокувань той самий, що в пакуванні: [накладна] → замовлення → пакування → баланси.
 * Модуль не імпортує сервіси накладних/пакування (його викликають waybill.server і tracking.server — без циклів).
 */
import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { inventoryMovements, issues, orderPacking, packagingMaterials, shipmentEvents, shipments } from "~/db/schema";
import { isShipped, type OrderStatus } from "~/domain/order-status";
import type { Actor } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { redact } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { loadLineItems, type LineItemWithVariant, type OrderRow, type ShipmentRow } from "~/modules/orders/repository.server";
import { BOX_KINDS } from "~/modules/packaging/box-selection";
import { consumeMaterialsForPacking } from "~/modules/packaging/consumption.server";
import { ACTIVE_PACKING_STATUSES, MAX_OVERRIDE_REASON_LENGTH, type PackingEventType } from "./constants";
import { checklistProgress, type ChecklistLine, type ChecklistProgress } from "./scan";

/** Скасоване замовлення, посилку якого вже почали пакувати або запакували: розібрати й повернути на склад. */
export const ORDER_CANCELLED_AFTER_PACKING = "ORDER_CANCELLED_AFTER_PACKING";
/** Перевізник прийняв посилку, а комплектацію почали й не підтвердили «Запаковано». */
export const PACKING_SKIPPED_AT_HANDOVER = "PACKING_SKIPPED_AT_HANDOVER";
/** Коди проблем пакування (склад). */
export const PACKING_ISSUE_CODES = [ORDER_CANCELLED_AFTER_PACKING, PACKING_SKIPPED_AT_HANDOVER] as const;

/** Активні стани накладної (дубль waybill.server ACTIVE_SHIPMENT_STATUSES — без циклічного імпорту). */
const ACTIVE_SHIPMENT = ["creating", "created", "unknown"] as const;

type PackingRow = typeof orderPacking.$inferSelect;

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

/** Подія пакування в історії замовлення (події активної накладної; без неї — останньої накладної замовлення). */
export async function addPackingEvent(
  tx: DbOrTx,
  orderId: string,
  type: PackingEventType,
  data: Record<string, unknown>,
  message: string | null = null,
): Promise<void> {
  const rows = await tx
    .select({ id: shipments.id, status: shipments.status })
    .from(shipments)
    .where(eq(shipments.orderId, orderId))
    .orderBy(desc(shipments.createdAt));
  const shipmentId = (rows.find((r) => (ACTIVE_SHIPMENT as readonly string[]).includes(r.status)) ?? rows[0])?.id;
  if (!shipmentId) return;
  await tx.insert(shipmentEvents).values({ shipmentId, type, message, data });
}

/** Активне пакування з блокуванням FOR NO KEY UPDATE (викликати ПІСЛЯ блокування рядка замовлення). */
async function lockActivePacking(tx: Tx, orderId: string): Promise<PackingRow | null> {
  const [row] = await tx
    .select()
    .from(orderPacking)
    .where(and(eq(orderPacking.orderId, orderId), inArray(orderPacking.status, [...ACTIVE_PACKING_STATUSES])))
    .limit(1)
    .for("no key update");
  return row ?? null;
}

async function materialsConsumed(db: DbOrTx, packingId: string): Promise<boolean> {
  const [row] = await db
    .select({ c: count() })
    .from(inventoryMovements)
    .where(and(eq(inventoryMovements.packingId, packingId), eq(inventoryMovements.type, "material_consume")));
  return Number(row?.c ?? 0) > 0;
}

/** Попередження складу (одне відкрите на замовлення й код; повтор оновлює параметри). */
async function openPackingIssue(
  tx: DbOrTx,
  orderId: string,
  shipmentId: string | null,
  code: (typeof PACKING_ISSUE_CODES)[number],
  params: Record<string, string | number>,
): Promise<void> {
  const fingerprint = `${orderId}:${code}:`;
  const [existing] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.fingerprint, fingerprint), eq(issues.status, "open")));
  if (existing) {
    await tx.update(issues).set({ params, shipmentId, updatedAt: new Date() }).where(eq(issues.id, existing.id));
    return;
  }
  await tx.insert(issues).values({ orderId, shipmentId, code, severity: "warning", field: null, params, fingerprint });
}

async function progressOf(tx: DbOrTx, orderId: string, packing: Pick<PackingRow, "checklist"> | null): Promise<ChecklistProgress> {
  return checklistProgress(toChecklistLines(await loadLineItems(tx, orderId)), packing?.checklist ?? {});
}

// ---------------------------------------------------------------------------
// Скасування замовлення
// ---------------------------------------------------------------------------

export interface CancelledPackingOutcome {
  packingId: string;
  previousStatus: PackingRow["status"];
  /** Відкрито ORDER_CANCELLED_AFTER_PACKING (пакування було розпочате або запаковане). */
  needsReturn: boolean;
  materialsConsumed: boolean;
}

/**
 * Закриває активне пакування скасованого замовлення (у транзакції cancelOrder, ПІСЛЯ блокування рядка замовлення і
 * ДО зміни резервів — порядок блокувань). Проблему відкривати ПІСЛЯ масового закриття проблем замовлення:
 * openCancelledAfterPackingIssue.
 */
export async function closePackingOnOrderCancel(tx: Tx, actor: Actor, orderId: string, now: Date): Promise<CancelledPackingOutcome | null> {
  const packing = await lockActivePacking(tx, orderId);
  if (!packing) return null;
  const consumed = await materialsConsumed(tx, packing.id);
  await tx
    .update(orderPacking)
    .set({ status: "cancelled", version: sql`${orderPacking.version} + 1`, updatedAt: now })
    .where(eq(orderPacking.id, packing.id));
  const needsReturn = packing.status === "in_progress" || packing.status === "packed";
  await addPackingEvent(tx, orderId, "packing_cancelled", { packingId: packing.id, previousStatus: packing.status, materialsConsumed: consumed });
  await writeAudit(tx, actor, "packing.cancelled_with_order", { type: "order", id: orderId }, {
    packingId: packing.id,
    previousStatus: packing.status,
    materialsConsumed: consumed,
  });
  return { packingId: packing.id, previousStatus: packing.status, needsReturn, materialsConsumed: consumed };
}

/** Попередження «скасовано після пакування» (після масового закриття проблем скасованого замовлення). */
export async function openCancelledAfterPackingIssue(tx: Tx, orderId: string, outcome: CancelledPackingOutcome): Promise<void> {
  if (!outcome.needsReturn) return;
  await openPackingIssue(tx, orderId, null, ORDER_CANCELLED_AFTER_PACKING, {
    packingId: outcome.packingId,
    previousStatus: outcome.previousStatus,
    materialsConsumed: outcome.materialsConsumed ? 1 : 0,
  });
}

/** Відкрите попередження «скасовано після пакування» замовлення (для екрана пакування). */
export async function openCancelledAfterPacking(
  db: DbOrTx,
  orderId: string,
): Promise<{ issueId: string; previousStatus: string; materialsConsumed: boolean } | null> {
  const [row] = await db
    .select({ id: issues.id, params: issues.params })
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.code, ORDER_CANCELLED_AFTER_PACKING), eq(issues.status, "open")))
    .limit(1);
  if (!row) return null;
  return {
    issueId: row.id,
    previousStatus: typeof row.params.previousStatus === "string" ? row.params.previousStatus : "in_progress",
    materialsConsumed: Number(row.params.materialsConsumed ?? 0) > 0,
  };
}

// ---------------------------------------------------------------------------
// Передача перевізнику без «Запаковано»
// ---------------------------------------------------------------------------

/** Стан контролю комплектації на момент передачі перевізнику. */
export type HandoverPackingState =
  /** Підтверджено «Запаковано». */
  | "packed"
  /** Пакування не розпочинали (немає пакування або лише заплановане). */
  | "not_started"
  /** Розпочато, але не підтверджено. */
  | "incomplete";

export function handoverPackingState(order: Pick<OrderRow, "status">, packing: Pick<PackingRow, "status"> | null): HandoverPackingState {
  if (order.status === "packed") return "packed";
  if (order.status === "awaiting_picking" || packing?.status === "in_progress" || packing?.status === "packed") return "incomplete";
  return "not_started";
}

export interface HandoverPackingResult {
  state: HandoverPackingState;
  packingId: string | null;
  packedUnits: number;
  requiredUnits: number;
  /** Ручна передача з рішенням власника: пакування підтверджено під час передачі. */
  finalized: boolean;
}

/** Вибрана для замовлення коробка (вручну або з якою створено накладну) — для списання при рішенні власника. */
async function handoverBox(tx: DbOrTx, order: OrderRow, shipment: ShipmentRow | null): Promise<string | null> {
  const snapshot = shipment?.requestSnapshot && typeof shipment.requestSnapshot === "object" ? (shipment.requestSnapshot as Record<string, unknown>) : null;
  const fromWaybill = typeof snapshot?.parcelBoxMaterialId === "string" ? snapshot.parcelBoxMaterialId : null;
  for (const id of [order.parcelBoxMaterialId, fromWaybill]) {
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) continue;
    const [m] = await tx.select({ id: packagingMaterials.id, kind: packagingMaterials.kind }).from(packagingMaterials).where(eq(packagingMaterials.id, id));
    if (m && BOX_KINDS.includes(m.kind)) return m.id;
  }
  return null;
}

/**
 * Ручна передача перевізнику (markHandedOver, у транзакції після блокування накладної й замовлення): перевіряє контроль
 * комплектації й закриває пакування.
 * - «Запаковано» → нічого;
 * - розпочато, але не підтверджено → без override — DomainError shipment.packingIncomplete; з override (лише власник,
 *   причина ≥ 3 символів) — пакування → packed (створюється, якщо записи пакування відсутні), матеріали списуються
 *   один раз (allowShortage), подія packed_at_handover з причиною;
 * - не розпочинали → передача дозволена: заплановане пакування закривається, подія packing_skipped_handover.
 */
export async function settlePackingForManualHandover(
  tx: Tx,
  actor: Actor,
  order: OrderRow,
  shipment: ShipmentRow,
  opts: { override?: { reason: string } | null; now: Date },
): Promise<HandoverPackingResult> {
  const packing = await lockActivePacking(tx, order.id);
  const state = handoverPackingState(order, packing);
  const progress = await progressOf(tx, order.id, packing);
  const base = { state, packingId: packing?.id ?? null, packedUnits: progress.packedUnits, requiredUnits: progress.requiredUnits, finalized: false };
  if (state === "packed") return base;
  if (state === "not_started") {
    if (packing) {
      await tx
        .update(orderPacking)
        .set({ status: "cancelled", version: sql`${orderPacking.version} + 1`, updatedAt: opts.now })
        .where(eq(orderPacking.id, packing.id));
    }
    await addPackingEvent(tx, order.id, "packing_skipped_handover", { packingId: packing?.id ?? null, previousStatus: packing?.status ?? "none", source: "manual" });
    return base;
  }
  const reason = opts.override ? opts.override.reason.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  if (!opts.override) {
    throw new DomainError("shipment.packingIncomplete", 409, { packed: progress.packedUnits, required: progress.requiredUnits });
  }
  if (actor.role !== "owner") throw new DomainError("packing.error.overrideOwnerOnly", 403);
  if (reason.length < 3) throw new DomainError("packing.error.overrideReasonRequired", 400);

  let packingId: string;
  let boxMaterialId: string | null;
  if (packing) {
    packingId = packing.id;
    boxMaterialId = packing.boxMaterialId;
    await tx
      .update(orderPacking)
      .set({
        status: "packed",
        packedBy: actor.id,
        packedByName: actor.displayName,
        packedAt: opts.now,
        version: sql`${orderPacking.version} + 1`,
        updatedAt: opts.now,
      })
      .where(eq(orderPacking.id, packing.id));
  } else {
    // «Очікує комплектації» без запису пакування (статус змінено поза модулем): фіксуємо пакування рішенням власника.
    const [gen] = await tx.select({ g: max(orderPacking.generation) }).from(orderPacking).where(eq(orderPacking.orderId, order.id));
    boxMaterialId = await handoverBox(tx, order, shipment);
    const [row] = await tx
      .insert(orderPacking)
      .values({
        orderId: order.id,
        generation: (gen?.g ?? 0) + 1,
        status: "packed",
        boxMaterialId,
        startedBy: actor.id,
        startedByName: actor.displayName,
        startedAt: opts.now,
        packedBy: actor.id,
        packedByName: actor.displayName,
        packedAt: opts.now,
        createdAt: opts.now,
        updatedAt: opts.now,
      })
      .returning({ id: orderPacking.id });
    packingId = row!.id;
  }
  // Посилка фізично поїхала в коробці — списання тих самих матеріалів, що й при «Запаковано» (ідемпотентно).
  const consumed = await consumeMaterialsForPacking(tx, actor, { packingId, orderId: order.id, boxMaterialId }, { allowShortage: true });
  const message = String(redact(reason)).slice(0, MAX_OVERRIDE_REASON_LENGTH);
  await addPackingEvent(tx, order.id, "packed_at_handover", { packingId, packed: progress.packedUnits, required: progress.requiredUnits }, message);
  await writeAudit(tx, actor, "packing.confirmed_at_handover", { type: "order", id: order.id }, {
    packingId,
    packedUnits: progress.packedUnits,
    requiredUnits: progress.requiredUnits,
    materialsAlreadyConsumed: consumed.alreadyConsumed,
    materialShortage: consumed.totalShortage,
  });
  return { ...base, packingId, finalized: true };
}

/**
 * Передача за даними перевізника (applyTrackingSnapshot; у транзакції після блокування замовлення): факт перевізника
 * не блокується. Пакування без «Запаковано» закривається з подією; розпочата й не завершена комплектація →
 * попередження PACKING_SKIPPED_AT_HANDOVER. previousOrderStatus — статус до переходу «Передано перевізнику».
 */
export async function recordPackingGapAtCarrierHandover(
  tx: Tx,
  actor: Actor,
  order: Pick<OrderRow, "id">,
  previousOrderStatus: OrderStatus,
  shipmentId: string,
  now: Date,
): Promise<HandoverPackingResult | null> {
  if (isShipped(previousOrderStatus) || previousOrderStatus === "cancelled") return null;
  const packing = await lockActivePacking(tx, order.id);
  const state = handoverPackingState({ status: previousOrderStatus }, packing);
  if (state === "packed") return null;
  const progress = await progressOf(tx, order.id, packing);
  if (packing && packing.status !== "packed") {
    await tx
      .update(orderPacking)
      .set({ status: "cancelled", version: sql`${orderPacking.version} + 1`, updatedAt: now })
      .where(eq(orderPacking.id, packing.id));
  }
  await addPackingEvent(tx, order.id, "packing_skipped_handover", {
    packingId: packing?.id ?? null,
    previousStatus: packing?.status ?? "none",
    source: "tracking",
    packed: progress.packedUnits,
    required: progress.requiredUnits,
  });
  if (state === "incomplete") {
    await openPackingIssue(tx, order.id, shipmentId, PACKING_SKIPPED_AT_HANDOVER, {
      previousStatus: packing?.status ?? "none",
      packed: progress.packedUnits,
      required: progress.requiredUnits,
    });
  }
  await writeAudit(tx, actor, "packing.skipped_at_handover", { type: "order", id: order.id }, {
    packingId: packing?.id ?? null,
    state,
    source: "tracking",
    packedUnits: progress.packedUnits,
    requiredUnits: progress.requiredUnits,
  });
  return { state, packingId: packing?.id ?? null, packedUnits: progress.packedUnits, requiredUnits: progress.requiredUnits, finalized: false };
}

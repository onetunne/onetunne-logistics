/**
 * «Переоформити накладну»: скасування активної накладної у перевізника + нове покоління.
 *
 * Гарантії (див. waybill.server.ts):
 * - Дозволено лише для створеної (`created`) накладної, посилку з якою ще НЕ передано перевізнику
 *   (handedOverAt порожній, замовлення не «відправлене»), у статусах «Накладна створена» / «Очікує комплектації».
 * - Перед скасуванням перевіряється, що нову накладну взагалі можна створити (перевізник, налаштування відправника):
 *   інакше нічого не скасовується.
 * - Відмова перевізника скасувати → стара накладна лишається активною, нова не створюється.
 * - Нове покоління створює лише той запит, який сам перевів стару накладну у «скасовано» (compare-and-set);
 *   повторний/паралельний запит отримує `concurrent` і нічого не створює. Одне активне відправлення на замовлення
 *   додатково гарантує частковий унікальний індекс і блокування рядка замовлення в createWaybill.
 * - Нова накладна проходить свіжу перевірку даних; якщо її створення заблоковано — результат прямо каже,
 *   що стару накладну СКАСОВАНО і що саме блокує нову.
 */
import { eq } from "drizzle-orm";
import { shipmentEvents, shipments } from "~/db/schema";
import type { OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { loadOrderRow, type ShipmentRow } from "~/modules/orders/repository.server";
import { REQUIRED_SHIPPER_FIELDS } from "~/modules/settings/schema";
import { getSettings } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import {
  cancelWaybillDetailed,
  createWaybill,
  findActiveShipment,
  isManualLink,
  type BlockedReason,
  type CreateWaybillResult,
} from "./waybill.server";

/** Статуси замовлення, з яких скасування повертає його до «Очікує перевірки» (і нова накладна можлива). */
export const REISSUE_ORDER_STATUSES: readonly OrderStatus[] = ["waybill_created", "awaiting_picking"];

/** Результат створення нової накладної, що НЕ дав нового покоління. */
export type ReissueBlockedNext = Exclude<CreateWaybillResult, { kind: "created" } | { kind: "recovered" } | { kind: "already_exists" }>;

export type ReissueResult =
  /** Стару накладну скасовано, нову створено (або знайдено звіркою). */
  | { kind: "reissued"; cancelled: ShipmentRow; created: ShipmentRow; recovered: boolean }
  /** Стару накладну СКАСОВАНО, нову не створено: `next` пояснює причину (перевірка даних, перевізник тощо). */
  | { kind: "cancelled_only"; cancelled: ShipmentRow; next: ReissueBlockedNext }
  /** Нічого не змінено: нову накладну створити неможливо, тож стару не скасовували. */
  | { kind: "not_started"; reason: Extract<BlockedReason, "no_carrier" | "carrier_not_configured" | "shipper_incomplete">; params?: Record<string, string | number> }
  /** Цю накладну вже скасовує/переоформлює паралельний запит — цей запит нічого не створював. */
  | { kind: "concurrent"; active: ShipmentRow | null };

export interface ReissueOptions {
  /** Звідки запущено (для журналу; вільного тексту немає — журнал без персональних даних). */
  trigger?: "order_page" | "shopify_changed";
}

/** Чи можна запропонувати «Переоформити» для відправлення (без перевірки дозволів і перевізника). */
export function isReissuable(
  shipment: Pick<ShipmentRow, "status" | "waybillNumber" | "handedOverAt">,
  orderStatus: OrderStatus,
): boolean {
  return (
    shipment.status === "created" &&
    Boolean(shipment.waybillNumber) &&
    !shipment.handedOverAt &&
    REISSUE_ORDER_STATUSES.includes(orderStatus)
  );
}

async function addEvent(ctx: ServiceContext, shipmentId: string, type: string, data: Record<string, unknown>) {
  await ctx.db.insert(shipmentEvents).values({ shipmentId, type, message: null, data });
}

export async function reissueWaybill(ctx: ServiceContext, shipmentId: string, opts: ReissueOptions = {}): Promise<ReissueResult> {
  requirePermission(ctx.actor, "waybills.manage");
  // Нове покоління створює createWaybill — дозвіл перевіряємо ДО скасування, щоб не лишити замовлення без накладної.
  requirePermission(ctx.actor, "waybills.create");
  const trigger = opts.trigger ?? "order_page";

  const [shipment] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!shipment) throw new NotFoundError("shipment");
  const order = await loadOrderRow(ctx.db, shipment.orderId);
  if (shipment.status !== "created" || !shipment.waybillNumber) throw new DomainError("waybill.notCancellable", 409);
  if (shipment.handedOverAt) throw new DomainError("waybill.alreadyHandedOver", 409);
  if (!REISSUE_ORDER_STATUSES.includes(order.status)) {
    throw new DomainError("waybill.reissueNotAllowed", 409, { status: order.status });
  }

  // Попередня перевірка: без перевізника, що створює накладні, чи без даних відправника стару не скасовуємо.
  const carrier = ctx.carriers.getDefault();
  if (!carrier) return { kind: "not_started", reason: "no_carrier" };
  if (!carrier.capabilities.createShipment) {
    return { kind: "not_started", reason: "carrier_not_configured", params: { carrier: carrier.displayName } };
  }
  const settings = await getSettings(ctx.db);
  const missing = REQUIRED_SHIPPER_FIELDS.filter((f) => !String(settings.shipper[f] ?? "").trim());
  if (missing.length > 0) return { kind: "not_started", reason: "shipper_incomplete", params: { fields: missing.join(", ") } };

  // 1) Скасування у перевізника (ручна прив'язка — лише локально). Відмова → помилка, нічого не змінено.
  let cancel;
  try {
    cancel = await cancelWaybillDetailed(ctx, shipmentId, { purpose: "reissue" });
  } catch (e) {
    // Паралельний запит міг уже скасувати накладну (тоді перевізник відповідає відмовою на повтор).
    const [latest] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
    if (latest && latest.status === "cancelled") return { kind: "concurrent", active: await findActiveShipment(ctx.db, order.id) };
    throw e;
  }
  if (!cancel.transitioned) return { kind: "concurrent", active: await findActiveShipment(ctx.db, order.id) };

  const auditBase = {
    orderId: order.id,
    previousGeneration: shipment.generation,
    manual: isManualLink(shipment),
    trigger,
  };

  // 2) Нове покоління: свіжа перевірка даних і стабільний новий reference (див. createWaybill).
  let next: CreateWaybillResult;
  try {
    next = await createWaybill(ctx, order.id, { source: "reissue" });
  } catch (e) {
    await addEvent(ctx, shipmentId, "reissue_blocked", { outcome: "error" });
    await writeAudit(ctx.db, ctx.actor, "waybill.reissue_blocked", { type: "shipment", id: shipmentId }, { ...auditBase, outcome: "error" });
    throw e;
  }

  if (next.kind === "created" || next.kind === "recovered" || next.kind === "already_exists") {
    await addEvent(ctx, shipmentId, "reissued", { newShipmentId: next.shipment.id, newGeneration: next.shipment.generation });
    await writeAudit(ctx.db, ctx.actor, "waybill.reissued", { type: "shipment", id: shipmentId }, {
      ...auditBase,
      newShipmentId: next.shipment.id,
      newGeneration: next.shipment.generation,
      outcome: next.kind,
    });
    return { kind: "reissued", cancelled: cancel.shipment, created: next.shipment, recovered: next.kind === "recovered" };
  }

  await addEvent(ctx, shipmentId, "reissue_blocked", {
    outcome: next.kind,
    ...(next.kind === "blocked" ? { reason: next.reason } : {}),
  });
  await writeAudit(ctx.db, ctx.actor, "waybill.reissue_blocked", { type: "shipment", id: shipmentId }, {
    ...auditBase,
    outcome: next.kind,
    ...(next.kind === "blocked" ? { reason: next.reason } : {}),
  });
  return { kind: "cancelled_only", cancelled: cancel.shipment, next };
}

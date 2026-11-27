/**
 * Список посилок для передачі перевізнику (REQUIREMENTS §6, «Формування списку посилок для передачі перевізнику»):
 * друкований реєстр запакованих посилок, з яким склад звіряє посилки під час приїзду кур'єра / у відділенні.
 *
 * - До списку потрапляють лише посилки, що пройшли контроль комплектації: замовлення «Запаковано» з активною
 *   створеною накладною, ще не переданою перевізнику й не видаленою в перевізника (isPackableShipment).
 * - Без вибору (ids) — усі такі посилки; з вибором — лише вибрані, решта вибраних — у переліку «не включено» з причиною.
 * - Групування за перевізником, порядок як у черзі (пріоритет ↓, дата ↑). Тестові накладні позначені TEST.
 * - Дані одержувача — лише країна й місто (як у черзі пакування): кур'єрові для звірки потрібні номери накладних.
 * - Нічого не змінює: «Передано перевізнику» фіксується окремо (відстеження або ручне підтвердження) — список лише
 *   друкований документ для підписів.
 */
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { orderPacking, orders, shipments } from "~/db/schema";
import { isShipped, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import type { ServiceContext } from "~/server/types";
import { ACTIVE_PACKING_STATUSES, MAX_HANDOVER_ORDERS } from "./constants";
import { isDeletedAtCarrier, isPackableShipment } from "./packing.server";
import { parseOrderIds } from "./queue-filters";

export interface HandoverParcel {
  orderId: string;
  orderNumber: string;
  priority: number;
  countryCode: string | null;
  city: string | null;
  waybillNumber: string;
  testMode: boolean;
  /** Вага за накладною (те, що отримав перевізник), г. */
  waybillWeightGrams: number | null;
  /** Зважена при пакуванні, г (якщо вводилась). */
  packedWeightGrams: number | null;
  packedByName: string | null;
  packedAt: Date | null;
}

export interface HandoverGroup {
  carrierCode: string;
  carrierName: string;
  parcels: HandoverParcel[];
  totalWeightGrams: number;
}

/** Чому вибране замовлення не включено до списку (i18n packing.handover.reason.*). */
export const HANDOVER_SKIP_REASONS = ["not_packed", "no_waybill", "handed_over", "deleted_at_carrier", "cancelled"] as const;
export type HandoverSkipReason = (typeof HANDOVER_SKIP_REASONS)[number];

export interface HandoverList {
  groups: HandoverGroup[];
  total: number;
  /** Вибрані замовлення, яких немає в списку (з причиною). */
  skipped: Array<{ orderId: string; orderNumber: string; reason: HandoverSkipReason }>;
  /** Посилок більше, ніж MAX_HANDOVER_ORDERS — показано перші. */
  truncated: boolean;
  /** Є тестові накладні (демо): їх не передають справжньому перевізнику. */
  hasTest: boolean;
  /** Вибір (ids) задано. */
  selection: boolean;
}

function skipReason(status: OrderStatus, shipment: Parameters<typeof isPackableShipment>[0]): HandoverSkipReason {
  if (status === "cancelled") return "cancelled";
  if (isShipped(status) || shipment?.handedOverAt) return "handed_over";
  if (isDeletedAtCarrier(shipment)) return "deleted_at_carrier";
  if (!isPackableShipment(shipment)) return "no_waybill";
  return "not_packed";
}

export async function loadHandoverList(ctx: ServiceContext, opts: { orderIds?: readonly string[] } = {}): Promise<HandoverList> {
  requirePermission(ctx.actor, "packing.perform");
  requirePermission(ctx.actor, "orders.view");
  const ids = opts.orderIds ? parseOrderIds(opts.orderIds, MAX_HANDOVER_ORDERS) : null;
  const selection = ids !== null && ids.length > 0;
  const rows = await ctx.db
    .select({
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      priority: orders.priority,
      countryCode: orders.shipCountryCode,
      city: orders.shipCity,
      orderWeight: orders.parcelWeightGrams,
      shipmentId: shipments.id,
      shipmentStatus: shipments.status,
      waybillNumber: shipments.waybillNumber,
      handedOverAt: shipments.handedOverAt,
      trackingStatus: shipments.trackingStatus,
      carrierCode: shipments.carrierCode,
      mode: shipments.mode,
      waybillWeight: shipments.actualWeightGrams,
      packingWeight: orderPacking.parcelWeightGrams,
      packedByName: orderPacking.packedByName,
      packedAt: orderPacking.packedAt,
    })
    .from(orders)
    .leftJoin(shipments, and(eq(shipments.orderId, orders.id), inArray(shipments.status, ["creating", "created", "unknown"])))
    .leftJoin(orderPacking, and(eq(orderPacking.orderId, orders.id), inArray(orderPacking.status, [...ACTIVE_PACKING_STATUSES])))
    .where(
      selection
        ? inArray(orders.id, ids)
        : and(eq(orders.status, "packed"), eq(shipments.status, "created"), isNull(shipments.handedOverAt)),
    )
    .orderBy(asc(shipments.carrierCode), desc(orders.priority), asc(orders.placedAt), asc(orders.id))
    .limit(MAX_HANDOVER_ORDERS + 1);

  const truncated = rows.length > MAX_HANDOVER_ORDERS;
  const groups = new Map<string, HandoverGroup>();
  const skipped: HandoverList["skipped"] = [];
  let total = 0;
  let hasTest = false;
  for (const r of rows.slice(0, MAX_HANDOVER_ORDERS)) {
    const shipment = r.shipmentId && r.shipmentStatus
      ? { status: r.shipmentStatus, waybillNumber: r.waybillNumber, handedOverAt: r.handedOverAt, trackingStatus: r.trackingStatus }
      : null;
    if (r.status !== "packed" || !isPackableShipment(shipment) || !r.carrierCode || !r.waybillNumber) {
      skipped.push({ orderId: r.orderId, orderNumber: r.orderNumber, reason: skipReason(r.status, shipment) });
      continue;
    }
    const code = r.carrierCode;
    let group = groups.get(code);
    if (!group) {
      group = { carrierCode: code, carrierName: ctx.carriers.get(code)?.displayName ?? code, parcels: [], totalWeightGrams: 0 };
      groups.set(code, group);
    }
    const testMode = r.mode === "test";
    hasTest ||= testMode;
    group.parcels.push({
      orderId: r.orderId,
      orderNumber: r.orderNumber,
      priority: r.priority,
      countryCode: r.countryCode?.trim().toUpperCase() || null,
      city: r.city,
      waybillNumber: r.waybillNumber,
      testMode,
      waybillWeightGrams: r.waybillWeight,
      packedWeightGrams: r.packingWeight ?? r.orderWeight ?? null,
      packedByName: r.packedByName,
      packedAt: r.packedAt,
    });
    group.totalWeightGrams += r.waybillWeight ?? 0;
    total += 1;
  }
  return { groups: [...groups.values()], total, skipped, truncated, hasTest, selection };
}

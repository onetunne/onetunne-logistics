/**
 * Передача трек-номера в Shopify (етап 3): створення виконання (fulfillment) з трек-номером
 * ПІСЛЯ фактичної передачі посилки перевізнику. Фонове завдання shopify.fulfill_shipment.
 *
 * Надійність (у fulfillmentCreate немає ключа ідемпотентності):
 * 1. Перед створенням перечитуються виконання замовлення: якщо вже є виконання з нашим трек-номером —
 *    лише фіксуємо його (повтор після обриву зв'язку не створює дубліката).
 * 2. Виконуються лише fulfillment orders у статусах OPEN/IN_PROGRESS з дією CREATE_FULFILLMENT і залишком > 0;
 *    по одному виконанню на локацію (вимога Shopify: одна локація на виклик).
 * 3. Відмова Shopify (userErrors) — без повторів → проблема SHOPIFY_FULFILLMENT_FAILED.
 * Клієнту лист НЕ надсилається, якщо в налаштуваннях не ввімкнено notifyCustomer (за замовчуванням false).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import { issues, orders, shipmentEvents, shipments } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { getSetting } from "~/modules/settings/settings.server";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  FULFILLMENT_CREATE_MUTATION,
  ORDER_FULFILLMENT_STATE_QUERY,
  type GqlFulfillmentCreateResult,
  type GqlFulfillmentOrder,
  type GqlOrderFulfillmentState,
} from "~/integrations/shopify/fulfillment-graphql";
import type { CarrierRegistry } from "~/integrations/carriers/types";

export type FulfillOutcome =
  | "created"
  | "already_recorded"
  | "found_existing"
  | "already_fulfilled_in_shopify"
  | "not_ready"
  | "not_linked";

const FULFILLABLE_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);
const WAITING_STATUSES = new Set(["ON_HOLD", "SCHEDULED"]);

/** Дані трек-номера для Shopify. Посилання — з шаблону налаштувань або від адаптера перевізника. */
export function trackingInfoFor(
  carriers: CarrierRegistry,
  carrierCode: string,
  number: string,
  urlTemplate: string,
): { company: string; number: string; url?: string } {
  const adapter = carriers.get(carrierCode);
  const fromAdapter = adapter?.trackingInfo?.(number);
  const company = fromAdapter?.company ?? adapter?.displayName ?? carrierCode;
  const url = urlTemplate ? urlTemplate.split("{number}").join(encodeURIComponent(number)) : (fromAdapter?.url ?? null);
  return url ? { company, number, url } : { company, number };
}

/** Fulfillment orders, які можна виконати зараз, згруповані за локацією. */
export function fulfillableGroups(nodes: GqlFulfillmentOrder[]): GqlFulfillmentOrder[][] {
  const groups = new Map<string, GqlFulfillmentOrder[]>();
  for (const fo of nodes) {
    if (!FULFILLABLE_STATUSES.has(fo.status)) continue;
    if (!fo.supportedActions.some((a) => a.action === "CREATE_FULFILLMENT")) continue;
    if (!fo.lineItems.nodes.some((li) => li.remainingQuantity > 0)) continue;
    const location = fo.assignedLocation?.location?.id ?? "unknown";
    groups.set(location, [...(groups.get(location) ?? []), fo]);
  }
  return [...groups.values()];
}

async function recordFulfilled(db: Db, shipmentId: string, orderId: string, fulfillmentId: string | null, outcome: FulfillOutcome) {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(shipments)
      .set({ shopifyFulfillmentId: fulfillmentId, shopifyFulfilledAt: new Date(), updatedAt: new Date() })
      .where(eq(shipments.id, shipmentId))
      .returning({ id: shipments.id });
    if (!row) return;
    await tx.insert(shipmentEvents).values({ shipmentId, type: "shopify_fulfilled", message: outcome, data: { fulfillmentId } });
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: SYSTEM_ACTOR.id, resolution: "shopify_fulfilled", updatedAt: new Date() })
      .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_FULFILLMENT_FAILED")));
    await writeAudit(tx, SYSTEM_ACTOR, "shopify.fulfillment_recorded", { type: "shipment", id: shipmentId }, { orderId, outcome });
  });
}

/** Обробник завдання: створює виконання з трек-номером у Shopify (ідемпотентно). */
export async function fulfillShipment(
  db: Db,
  admin: AdminGraphql,
  carriers: CarrierRegistry,
  input: { shopifyOrderId: string; shipmentId: string },
): Promise<FulfillOutcome> {
  const [row] = await db
    .select({ shipment: shipments, order: orders })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.id, input.shipmentId));
  if (!row) return "not_ready";
  const { shipment, order } = row;
  if (shipment.shopifyFulfilledAt) return "already_recorded";
  if (shipment.status !== "created" || !shipment.handedOverAt) return "not_ready";
  if (!order.shopifyOrderId || order.shopifyOrderId !== input.shopifyOrderId) return "not_linked";
  const number = shipment.trackingNumber ?? shipment.waybillNumber;
  if (!number) return "not_ready";

  const state = await admin<GqlOrderFulfillmentState>(ORDER_FULFILLMENT_STATE_QUERY, { id: order.shopifyOrderId });
  if (!state.order) throw new ShopifyApiError("Shopify order not found (read access or 60-day limit)", false, "NOT_FOUND");

  // 1. Звірка: виконання з цим трек-номером уже існує (напр. попередня спроба виконалася, але відповідь загубилася).
  const existing = state.order.fulfillments.find(
    (f) => f.status !== "CANCELLED" && f.trackingInfo.some((t) => t.number === number),
  );
  if (existing) {
    await recordFulfilled(db, shipment.id, order.id, existing.id, "found_existing");
    return "found_existing";
  }

  const groups = fulfillableGroups(state.order.fulfillmentOrders.nodes);
  if (groups.length === 0) {
    if (state.order.fulfillmentOrders.nodes.some((fo) => WAITING_STATUSES.has(fo.status))) {
      // Замовлення на утриманні/заплановане — повтор пізніше (з паузою черги).
      throw new ShopifyApiError("Shopify fulfillment orders are on hold or scheduled", true, "FO_NOT_READY");
    }
    // Усе вже виконано в Shopify (вручну або іншим застосунком) — трек-номер не дублюємо.
    await recordFulfilled(db, shipment.id, order.id, null, "already_fulfilled_in_shopify");
    return "already_fulfilled_in_shopify";
  }

  const tracking = await getSetting(db, "tracking");
  const trackingInfo = trackingInfoFor(carriers, shipment.carrierCode, number, tracking.trackingUrlTemplate);
  let firstId: string | null = null;
  for (const group of groups) {
    const result = await admin<GqlFulfillmentCreateResult>(FULFILLMENT_CREATE_MUTATION, {
      fulfillment: {
        lineItemsByFulfillmentOrder: group.map((fo) => ({ fulfillmentOrderId: fo.id })),
        trackingInfo,
        notifyCustomer: tracking.notifyCustomer,
      },
    });
    const errors = result.fulfillmentCreate.userErrors;
    if (errors.length > 0 || !result.fulfillmentCreate.fulfillment) {
      const message = errors.map((e) => e.message).join("; ").slice(0, 300) || "fulfillment not created";
      logger.warn("shopify.fulfillment_rejected", { shipmentId: shipment.id, fields: errors.map((e) => (e.field ?? []).join(".")).join(",") });
      throw new ShopifyApiError(`Shopify rejected fulfillment: ${message}`, false, "USER_ERRORS");
    }
    firstId ??= result.fulfillmentCreate.fulfillment.id;
  }
  await recordFulfilled(db, shipment.id, order.id, firstId, "created");
  logger.info("shopify.fulfillment_created", { shipmentId: shipment.id, groups: groups.length, notifyCustomer: tracking.notifyCustomer });
  return "created";
}

/** Після вичерпання спроб — проблема в розділі «Проблеми» (без персональних даних). */
export async function reportFulfillmentFailure(db: Db, shipmentId: string, error: string): Promise<void> {
  const [row] = await db.select({ orderId: shipments.orderId }).from(shipments).where(eq(shipments.id, shipmentId));
  if (!row) return;
  const fingerprint = `${row.orderId}:SHOPIFY_FULFILLMENT_FAILED:`;
  const [existing] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.fingerprint, fingerprint), inArray(issues.status, ["open"])));
  const params = { message: error.slice(0, 200) };
  if (existing) {
    await db.update(issues).set({ params, updatedAt: new Date() }).where(eq(issues.id, existing.id));
    return;
  }
  await db.insert(issues).values({
    orderId: row.orderId,
    shipmentId,
    code: "SHOPIFY_FULFILLMENT_FAILED",
    severity: "error",
    field: null,
    params,
    fingerprint,
  });
}

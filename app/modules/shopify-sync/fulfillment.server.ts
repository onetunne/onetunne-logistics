/**
 * Передача трек-номера в Shopify (етап 3): створення виконання (fulfillment) з трек-номером
 * ПІСЛЯ фактичної передачі посилки перевізнику. Фонове завдання shopify.fulfill_shipment.
 *
 * Надійність (у fulfillmentCreate немає ключа ідемпотентності):
 * 1. Перед КОЖНОЮ спробою перечитується стан fulfillment orders (FO). Створене виконання закриває FO
 *    або обнуляє залишок, тому стан FO сам захищає від дублікатів — і для кожної локації окремо
 *    (повтор після збою між локаціями створює виконання лише для решти локацій).
 * 2. Виконуються лише FO у статусах OPEN/IN_PROGRESS з дією CREATE_FULFILLMENT і залишком > 0;
 *    по одному виконанню на локацію (вимога Shopify: одна локація на виклик).
 * 3. «Вже виконано в Shopify» — лише якщо Shopify так показує (FULFILLED) або всі видимі FO закриті / без залишку.
 *    Порожній чи неповний перелік FO (напр. дозвіл ще не схвалено — Shopify повертає лише частину FO) → помилка
 *    без повторів → проблема SHOPIFY_FULFILLMENT_FAILED (не позначаємо відправлення виконаним мовчки).
 * 4. Відмова Shopify (userErrors) — без повторів → проблема SHOPIFY_FULFILLMENT_FAILED.
 * 5. Налаштування pushToShopify перевіряється і під час виконання завдання (власник міг вимкнути передачу).
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
  | "not_linked"
  | "disabled";

const FULFILLABLE_STATUSES = new Set(["OPEN", "IN_PROGRESS"]);
const WAITING_STATUSES = new Set(["ON_HOLD", "SCHEDULED"]);
const FINISHED_STATUSES = new Set(["CLOSED", "CANCELLED"]);
/** Межа сторінок FO (по FULFILLMENT_ORDERS_PAGE_SIZE). Більше — перелік вважається неповним. */
export const FULFILLMENT_ORDERS_MAX_PAGES = 5;

/** У FO є невиконані одиниці (або позицій більше, ніж на сторінці, — тоді вважаємо, що можуть бути). */
function hasRemaining(fo: GqlFulfillmentOrder): boolean {
  return fo.lineItems.nodes.some((li) => li.remainingQuantity > 0) || Boolean(fo.lineItems.pageInfo?.hasNextPage);
}

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
    if (!hasRemaining(fo)) continue;
    const location = fo.assignedLocation?.location?.id ?? "unknown";
    groups.set(location, [...(groups.get(location) ?? []), fo]);
  }
  return [...groups.values()];
}

/**
 * Чи замовлення справді вже виконане в Shopify: так показує Shopify (FULFILLED) або є видимі FO,
 * і кожне з них закрите/скасоване чи без залишку (хоча б одне — не скасоване). Порожній або неповний
 * перелік FO нічого не доводить (без дозволу Shopify повертає лише частину FO).
 */
export function fulfilledInShopify(state: { displayFulfillmentStatus: string; nodes: GqlFulfillmentOrder[]; complete: boolean }): boolean {
  if (state.displayFulfillmentStatus === "FULFILLED") return true;
  if (!state.complete || state.nodes.length === 0) return false;
  const done = (fo: GqlFulfillmentOrder) => FINISHED_STATUSES.has(fo.status) || !hasRemaining(fo);
  return state.nodes.every(done) && state.nodes.some((fo) => fo.status !== "CANCELLED");
}

interface FulfillmentState {
  displayFulfillmentStatus: string;
  fulfillments: NonNullable<GqlOrderFulfillmentState["order"]>["fulfillments"];
  nodes: GqlFulfillmentOrder[];
  /** false — FO більше, ніж FULFILLMENT_ORDERS_MAX_PAGES сторінок. */
  complete: boolean;
}

/** Стан виконання замовлення з усіма сторінками FO (кожна сторінка — окремий запит у межах ліміту вартості). */
async function readFulfillmentState(admin: AdminGraphql, orderGid: string): Promise<FulfillmentState | null> {
  let after: string | null = null;
  const nodes: GqlFulfillmentOrder[] = [];
  let head: NonNullable<GqlOrderFulfillmentState["order"]> | null = null;
  for (let page = 1; page <= FULFILLMENT_ORDERS_MAX_PAGES; page++) {
    const data: GqlOrderFulfillmentState = await admin<GqlOrderFulfillmentState>(ORDER_FULFILLMENT_STATE_QUERY, { id: orderGid, after });
    if (!data.order) return head ? { ...stateOf(head), nodes, complete: false } : null;
    head ??= data.order;
    nodes.push(...data.order.fulfillmentOrders.nodes);
    const info = data.order.fulfillmentOrders.pageInfo;
    if (!info?.hasNextPage) return { ...stateOf(head), nodes, complete: true };
    if (!info.endCursor) break;
    after = info.endCursor;
  }
  return head ? { ...stateOf(head), nodes, complete: false } : null;
}

function truncatedError(): ShopifyApiError {
  return new ShopifyApiError("Too many Shopify fulfillment orders to verify; check the order in Shopify", false, "FO_LIST_TRUNCATED");
}

function stateOf(order: NonNullable<GqlOrderFulfillmentState["order"]>) {
  return { displayFulfillmentStatus: order.displayFulfillmentStatus, fulfillments: order.fulfillments };
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

  // Власник міг вимкнути передачу, поки завдання чекало/повторювалося: без звернення до Shopify.
  // shopifyFulfilledAt не ставиться — після повторного ввімкнення завдання можна поставити знову.
  const tracking = await getSetting(db, "tracking");
  if (!tracking.pushToShopify) return "disabled";

  const state = await readFulfillmentState(admin, order.shopifyOrderId);
  if (!state) throw new ShopifyApiError("Shopify order not found (read access or 60-day limit)", false, "NOT_FOUND");

  // Виконання з цим трек-номером (напр. попередня спроба виконалася, але відповідь загубилася) — лише для
  // shopifyFulfillmentId. Захист від дублікатів — стан FO: виконане FO закрите або без залишку.
  const existing = state.fulfillments.find((f) => f.status !== "CANCELLED" && f.trackingInfo.some((t) => t.number === number));

  const groups = fulfillableGroups(state.nodes);
  if (groups.length === 0) {
    if (state.nodes.some((fo) => WAITING_STATUSES.has(fo.status))) {
      // Замовлення на утриманні/заплановане — повтор пізніше (з паузою черги).
      throw new ShopifyApiError("Shopify fulfillment orders are on hold or scheduled", true, "FO_NOT_READY");
    }
    // Наше виконання вже є (відповідь попередньої спроби загубилася) і видимих FO для виконання не лишилося,
    // або все виконано в Shopify (вручну чи іншим застосунком) — трек-номер не дублюємо.
    if ((existing && state.complete) || fulfilledInShopify(state)) {
      const outcome: FulfillOutcome = existing ? "found_existing" : "already_fulfilled_in_shopify";
      await recordFulfilled(db, shipment.id, order.id, existing?.id ?? null, outcome);
      return outcome;
    }
    if (!state.complete) throw truncatedError();
    // Немає видимих FO для виконання, але й не доведено, що замовлення виконане (дозвіл ще не схвалено,
    // FO іншої локації/служби виконання) — не позначаємо виконаним: dead → проблема для менеджера.
    logger.warn("shopify.fulfillment_no_fulfillable_fo", {
      shipmentId: shipment.id,
      visible: state.nodes.length,
      complete: state.complete,
      statuses: [...new Set(state.nodes.map((fo) => fo.status))].join(","),
    });
    throw new ShopifyApiError(
      `No fulfillable Shopify fulfillment orders visible (${state.nodes.length} visible, order ${state.displayFulfillmentStatus || "unknown"})`,
      false,
      "NO_FULFILLABLE_FO",
    );
  }

  const trackingInfo = trackingInfoFor(carriers, shipment.carrierCode, number, tracking.trackingUrlTemplate);
  let firstId: string | null = existing?.id ?? null;
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
  // FO більше, ніж переглянуто: решта могла лишитися невиконаною — не позначаємо відправлення виконаним.
  if (!state.complete) throw truncatedError();
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

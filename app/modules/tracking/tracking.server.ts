/**
 * Відстеження посилок (етап 3).
 *
 * - Періодичне опитування перевізників (фонове завдання tracking.poll) і ручне оновлення з картки замовлення.
 * - Події зберігаються без персональних даних (shipment_tracking_events), дедуплікація за (час, код).
 * - Статус замовлення змінюється лише дозволеними переходами (domain/order-status). «Передано перевізнику» —
 *   лише за фактом (статус перевізника «прийнято»/далі або підтвердження менеджера), не після створення накладної.
 * - Після фактичної передачі трек-номер передається в Shopify (через ShopifyGateway → черга), якщо увімкнено.
 * - Проблеми доставки → розділ «Проблеми» (DELIVERY_PROBLEM); видалення накладної у перевізника → CARRIER_SHIPMENT_DELETED.
 */
import { and, asc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { issues, jobs, orders, shipmentEvents, shipments, shipmentTrackingEvents } from "~/db/schema";
import { canTransition, isShipped, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { logger } from "~/lib/logger.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { loadOrderRow, type OrderRow, type ShipmentRow } from "~/modules/orders/repository.server";
import { getSetting } from "~/modules/settings/settings.server";
import { syncOrderReservations } from "~/modules/inventory/reservations.server";
import { JOB } from "~/modules/shopify-sync/sync.server";
import { shopifyLinesPending } from "~/modules/shopify-sync/pending-lines.server";
import { recordPackingGapAtCarrierHandover, settlePackingForManualHandover } from "~/modules/packing/lifecycle.server";
import { FULFILL_DEDUPE_PREFIX } from "~/integrations/shopify/queueing-gateway.server";
import type { CarrierAdapter, TrackingSnapshot, TrackingStatus } from "~/integrations/carriers/types";
import type { ServiceContext } from "~/server/types";

/** Тайм-аут ОДНОГО виклику перевізника (частини до TRACKING_CHUNK_SIZE номерів). */
export const TRACKING_TIMEOUT_MS = 30_000;
/** Не опитувати одне відправлення частіше (ручне оновлення — без обмеження). */
export const MIN_POLL_AGE_MS = 15 * 60 * 1000;
export const POLL_BATCH_LIMIT = 200;
/**
 * Номерів на один виклик getTracking. Кожна частина — окремий виклик зі своїм тайм-аутом: збій/повільна відповідь
 * однієї частини не скасовує вже отриманих результатів інших (вони застосовуються одразу).
 */
export const TRACKING_CHUNK_SIZE = 20;
/** Після цього часу опитування не починає нових частин (решта — у наступному опитуванні; задовго до STALE_LOCK_MS). */
export const POLL_DEADLINE_MS = 4 * 60 * 1000;

/** Статуси, з яких відправлення більше не опитується. */
export const FINAL_TRACKING_STATUSES: readonly TrackingStatus[] = ["delivered", "returned", "cancelled"];

/** Статуси, що означають: посилка фізично у перевізника (передачу виконано). */
export const HANDOVER_TRACKING_STATUSES: readonly TrackingStatus[] = [
  "accepted",
  "in_transit",
  "customs",
  "out_for_delivery",
  "delivered",
  "failed_attempt",
  "returned",
  "lost",
  "exception",
];

const PRE_HANDOVER_ORDER_STATUSES: readonly OrderStatus[] = ["waybill_created", "awaiting_picking", "packed"];
const PROBLEM_TRACKING_STATUSES: readonly TrackingStatus[] = ["failed_attempt", "lost", "exception"];

/** Цільовий статус замовлення для статусу відстеження (null — статус замовлення не змінюється). */
export function orderStatusForTracking(status: TrackingStatus): OrderStatus | null {
  switch (status) {
    case "accepted":
      return "handed_to_carrier";
    case "in_transit":
    case "out_for_delivery":
      return "in_transit";
    case "customs":
      return "customs";
    case "delivered":
      return "delivered";
    case "failed_attempt":
    case "lost":
    case "exception":
      return "delivery_problem";
    case "returned":
      return "returned";
    case "created":
    case "cancelled":
    case "unknown":
      return null;
  }
}

/**
 * Послідовність дозволених переходів від поточного статусу до цільового.
 * До передачі перевізнику спочатку фіксується «Передано перевізнику». Недозволений перехід → [] (без змін).
 */
export function planOrderTransitions(current: OrderStatus, target: OrderStatus | null): OrderStatus[] {
  if (!target || current === target) return [];
  if (PRE_HANDOVER_ORDER_STATUSES.includes(current) && isShipped(target)) {
    if (!canTransition(current, "handed_to_carrier")) return [];
    if (target === "handed_to_carrier") return ["handed_to_carrier"];
    return canTransition("handed_to_carrier", target) ? ["handed_to_carrier", target] : ["handed_to_carrier"];
  }
  return canTransition(current, target) ? [target] : [];
}

function firstHandoverTime(snapshot: TrackingSnapshot): Date | null {
  const ev = snapshot.events.find((e) => HANDOVER_TRACKING_STATUSES.includes(e.status));
  if (ev) return ev.occurredAt;
  return HANDOVER_TRACKING_STATUSES.includes(snapshot.status) ? snapshot.statusAt : null;
}

async function openTrackingIssue(
  tx: DbOrTx,
  orderId: string,
  shipmentId: string,
  code: "DELIVERY_PROBLEM" | "CARRIER_SHIPMENT_DELETED",
  params: Record<string, string | number>,
) {
  const fingerprint = `${orderId}:${code}:`;
  const [existing] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.fingerprint, fingerprint), eq(issues.status, "open")));
  if (existing) {
    await tx.update(issues).set({ params, shipmentId, updatedAt: new Date() }).where(eq(issues.id, existing.id));
    return;
  }
  await tx.insert(issues).values({
    orderId,
    shipmentId,
    code,
    severity: code === "DELIVERY_PROBLEM" ? "warning" : "error",
    field: null,
    params,
    fingerprint,
  });
}

async function resolveIssues(tx: DbOrTx, orderId: string, codes: string[], actorId: string, resolution: string) {
  await tx
    .update(issues)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: actorId, resolution, updatedAt: new Date() })
    .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), inArray(issues.code, codes)));
}

async function applyOrderSteps(tx: DbOrTx, ctx: ServiceContext, order: OrderRow, steps: OrderStatus[], source: string) {
  let version = order.version;
  let from = order.status;
  for (const status of steps) {
    version += 1;
    await tx.update(orders).set({ status, version, updatedAt: ctx.now() }).where(eq(orders.id, order.id));
    await writeAudit(tx, ctx.actor, "order.status_changed", { type: "order", id: order.id }, { from, to: status, source });
    from = status;
  }
}

export interface ApplyTrackingResult {
  changed: boolean;
  newlyHandedOver: boolean;
  orderStatus: OrderStatus;
}

/**
 * Застосовує знімок відстеження до відправлення (одна транзакція, compare-and-set за станом created).
 * Повертає, чи відбулася фактична передача вперше (тоді викликається передача трек-номера в Shopify).
 */
export async function applyTrackingSnapshot(
  ctx: ServiceContext,
  shipmentId: string,
  snapshot: TrackingSnapshot,
  carrierName: string,
): Promise<ApplyTrackingResult | null> {
  return ctx.db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
    if (!shipment) throw new NotFoundError("shipment");
    if (shipment.status !== "created") return null;
    const now = ctx.now();

    if (snapshot.events.length > 0) {
      await tx
        .insert(shipmentTrackingEvents)
        .values(
          snapshot.events.map((e) => ({
            shipmentId,
            status: e.status,
            code: e.code ?? "",
            occurredAt: e.occurredAt,
            location: e.location ? e.location.slice(0, 200) : null,
            description: e.description ? e.description.slice(0, 300) : null,
          })),
        )
        .onConflictDoNothing();
    }

    const handover = shipment.handedOverAt ?? (HANDOVER_TRACKING_STATUSES.includes(snapshot.status) || snapshot.events.some((e) => HANDOVER_TRACKING_STATUSES.includes(e.status))
      ? (firstHandoverTime(snapshot) ?? now)
      : null);
    const deliveredAt = shipment.deliveredAt ?? (snapshot.status === "delivered" ? (snapshot.statusAt ?? now) : null);
    const changed = shipment.carrierStatusCode !== snapshot.carrierStatusCode || shipment.trackingStatus !== snapshot.status;

    await tx
      .update(shipments)
      .set({
        trackingStatus: snapshot.status,
        carrierStatusCode: snapshot.carrierStatusCode,
        carrierStatusText: snapshot.carrierStatusText ? snapshot.carrierStatusText.slice(0, 200) : null,
        carrierStatusAt: snapshot.statusAt,
        lastTrackedAt: now,
        handedOverAt: handover,
        deliveredAt,
        updatedAt: now,
      })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.status, "created")));
    if (changed) {
      await tx.insert(shipmentEvents).values({
        shipmentId,
        type: "tracking_status",
        message: null,
        data: { status: snapshot.status, code: snapshot.carrierStatusCode },
      });
    }

    const order = await loadOrderRow(tx, shipment.orderId, { forUpdate: true });
    let orderStatus = order.status;
    if (order.status !== "cancelled") {
      // Якщо перевізник фактично прийняв посилку — фіксуємо передачу навіть при статусі «створено» зараз.
      const target = orderStatusForTracking(snapshot.status) ?? (handover && !isShipped(order.status) ? "handed_to_carrier" : null);
      const steps = planOrderTransitions(order.status, target);
      // Етап 5: перевізник прийняв посилку без «Запаковано» — факт перевізника не блокуємо, але пакування закриваємо
      // й фіксуємо розрив контролю комплектації (подія; розпочата й не завершена комплектація → попередження).
      // Порядок блокувань: замовлення → пакування → баланси (резерв нижче).
      if (steps.includes("handed_to_carrier")) {
        await recordPackingGapAtCarrierHandover(tx, ctx.actor, order, order.status, shipmentId, now);
      }
      await applyOrderSteps(tx, ctx, order, steps, "tracking");
      orderStatus = steps.at(-1) ?? order.status;
      // Етап 5: фактична передача → списання зарезервованого товару (один раз на позицію) у цій транзакції.
      if (steps.length > 0) await syncOrderReservations(tx, order.id, ctx.actor);
    }

    if (PROBLEM_TRACKING_STATUSES.includes(snapshot.status)) {
      await openTrackingIssue(tx, order.id, shipmentId, "DELIVERY_PROBLEM", {
        carrier: carrierName,
        code: snapshot.carrierStatusCode ?? "—",
        status: snapshot.carrierStatusText ?? snapshot.status,
      });
    } else if (["in_transit", "customs", "out_for_delivery", "delivered"].includes(snapshot.status)) {
      await resolveIssues(tx, order.id, ["DELIVERY_PROBLEM"], ctx.actor.id, "tracking_recovered");
    }
    if (snapshot.status === "cancelled" && !handover) {
      await openTrackingIssue(tx, order.id, shipmentId, "CARRIER_SHIPMENT_DELETED", {
        carrier: carrierName,
        waybill: shipment.waybillNumber ?? "—",
      });
    }

    const newlyHandedOver = !shipment.handedOverAt && Boolean(handover);
    if (newlyHandedOver) {
      await tx.insert(shipmentEvents).values({ shipmentId, type: "handed_over", message: "tracking", data: { code: snapshot.carrierStatusCode } });
      await writeAudit(tx, ctx.actor, "shipment.handed_over", { type: "shipment", id: shipmentId }, { orderId: order.id, source: "tracking" });
    }
    return { changed, newlyHandedOver, orderStatus };
  });
}

/** Передача трек-номера в Shopify після фактичної передачі (якщо увімкнено в налаштуваннях). */
export async function requestShopifyFulfillment(ctx: ServiceContext, shipmentId: string): Promise<string> {
  const tracking = await getSetting(ctx.db, "tracking");
  if (!tracking.pushToShopify) return "disabled";
  const [row] = await ctx.db
    .select({ shipment: shipments, shopifyOrderId: orders.shopifyOrderId })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(eq(shipments.id, shipmentId));
  if (!row || row.shipment.status !== "created" || !row.shipment.handedOverAt || row.shipment.shopifyFulfilledAt) return "skipped";
  const result = await ctx.shopify.requestFulfillment({ shopifyOrderId: row.shopifyOrderId, shipmentId });
  return result.status === "skipped" ? `skipped:${result.reason}` : result.status;
}

export interface MarkHandedOverOptions {
  /**
   * Етап 5: власник свідомо підтверджує передачу, хоча Shopify змінив позиції після створення накладної, а застосунок
   * їх ще не застосував (orders.shopify_lines_pending_at): списання — за позиціями застосунку (тим, що запаковано).
   * Іншим (і без цього прапорця) ручна передача в такому стані заборонена (shipment.shopifyLinesPending).
   */
  acknowledgeShopifyLineChanges?: boolean;
  /**
   * Етап 5: власник свідомо передає посилку, пакування якої розпочато, але не підтверджено «Запаковано» (контроль
   * комплектації не пройдено). Причина — в історії замовлення; пакування фіксується як запаковане під час передачі,
   * матеріали списуються один раз. Без нього (або не власнику) — shipment.packingIncomplete.
   */
  packingOverride?: { reason: string } | null;
}

/**
 * Ручне підтвердження передачі перевізнику (менеджер передав посилку у відділенні),
 * коли перевізник не підтримує відстеження або статус ще не оновився.
 * Передачу за даними перевізника (відстеження) ці блокування не зупиняють — факт перевізника головніший.
 * Етап 5, контроль комплектації (packing/lifecycle.server.ts): «Запаковано» — передача; пакування розпочато, але не
 * підтверджено — лише рішенням власника з причиною (packingOverride); пакування не розпочинали — передача дозволена,
 * розрив фіксується в історії й журналі (packing: "not_started").
 */
export async function markHandedOver(ctx: ServiceContext, shipmentId: string, opts: MarkHandedOverOptions = {}): Promise<string> {
  requirePermission(ctx.actor, "waybills.manage");
  await ctx.db.transaction(async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
    if (!shipment) throw new NotFoundError("shipment");
    if (shipment.status !== "created") throw new DomainError("waybill.notActive", 409);
    // Перевізник повідомив, що накладну видалено — передати таку посилку неможливо.
    if (shipment.trackingStatus === "cancelled") throw new DomainError("shipment.deletedAtCarrier", 409);
    const order = await loadOrderRow(tx, shipment.orderId, { forUpdate: true });
    if (shipment.handedOverAt || isShipped(order.status)) throw new DomainError("shipment.alreadyHandedOver", 409);
    // Етап 5: позиції застаріли щодо Shopify — списання зі старими кількостями лише з явним рішенням власника.
    const linesPending = shopifyLinesPending(order);
    if (linesPending && !(opts.acknowledgeShopifyLineChanges && ctx.actor.role === "owner")) {
      throw new DomainError("shipment.shopifyLinesPending", 409);
    }
    const steps = planOrderTransitions(order.status, "handed_to_carrier");
    if (steps.length === 0) throw new DomainError("order.notEditable", 409, { status: order.status });
    // Етап 5: контроль комплектації (порядок блокувань: накладна → замовлення → пакування → баланси).
    const packing = await settlePackingForManualHandover(tx, ctx.actor, order, shipment, { override: opts.packingOverride ?? null, now: ctx.now() });
    await tx
      .update(shipments)
      .set({ handedOverAt: ctx.now(), updatedAt: ctx.now() })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.status, "created"), isNull(shipments.handedOverAt)));
    await applyOrderSteps(tx, ctx, order, steps, "manual");
    // Етап 5: списання зарезервованого товару при фактичній передачі.
    await syncOrderReservations(tx, order.id, ctx.actor);
    await tx.insert(shipmentEvents).values({ shipmentId, type: "handed_over", message: "manual", data: { packing: packing.state } });
    await writeAudit(tx, ctx.actor, "shipment.handed_over", { type: "shipment", id: shipmentId }, {
      orderId: order.id,
      source: "manual",
      packing: packing.state,
      ...(packing.finalized ? { packingConfirmedAtHandover: true } : {}),
      ...(linesPending ? { shopifyLinesPendingAcknowledged: true } : {}),
    });
  });
  // Передачу вже збережено: збій постановки в чергу не скасовує її (повтор — ensurePendingFulfillments під час опитування).
  return requestShopifyFulfillment(ctx, shipmentId).catch((e: unknown) => {
    logger.warn("tracking.fulfillment_request_failed", { error: e });
    return "failed";
  });
}

function trackable(adapter: CarrierAdapter | undefined): adapter is CarrierAdapter & Required<Pick<CarrierAdapter, "getTracking">> {
  return Boolean(adapter?.capabilities.tracking && adapter.getTracking);
}

export interface PollSummary {
  checked: number;
  updated: number;
  handedOver: number;
  failedCarriers: string[];
  /** Відправлення, чию частину перевізник не повернув (збій/тайм-аут) — спробуємо в наступному опитуванні. */
  failed: number;
}

interface TrackOptions {
  /**
   * Опитування: для відправлень невдалої частини оновлюється lastTrackedAt, щоб наступне опитування
   * почало з інших (інакше та сама «погана» партія вибиралася б першою щоразу).
   */
  rotateFailed?: boolean;
  /** Мітка часу (Date.now()), після якої нові частини не починаються. */
  deadlineAt?: number;
}

async function touchTracked(ctx: ServiceContext, ids: string[]) {
  if (ids.length === 0) return;
  await ctx.db
    .update(shipments)
    .set({ lastTrackedAt: ctx.now() })
    .where(and(inArray(shipments.id, ids), eq(shipments.status, "created")));
}

async function trackShipments(ctx: ServiceContext, rows: ShipmentRow[], opts: TrackOptions = {}): Promise<PollSummary> {
  const summary: PollSummary = { checked: 0, updated: 0, handedOver: 0, failedCarriers: [], failed: 0 };
  const byCarrier = new Map<string, ShipmentRow[]>();
  for (const r of rows) byCarrier.set(r.carrierCode, [...(byCarrier.get(r.carrierCode) ?? []), r]);
  for (const [code, list] of byCarrier) {
    const adapter = ctx.carriers.get(code);
    if (!trackable(adapter)) continue;
    const byNumber = new Map<string, ShipmentRow[]>();
    for (const s of list) if (s.waybillNumber) byNumber.set(s.waybillNumber, [...(byNumber.get(s.waybillNumber) ?? []), s]);
    const numbers = [...byNumber.keys()];
    for (let i = 0; i < numbers.length; i += TRACKING_CHUNK_SIZE) {
      if (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt) {
        logger.warn("tracking.poll_deadline", { carrier: code, remaining: numbers.length - i });
        break;
      }
      const chunk = numbers.slice(i, i + TRACKING_CHUNK_SIZE);
      const chunkShipments = chunk.flatMap((n) => byNumber.get(n) ?? []);
      let snapshots: TrackingSnapshot[];
      try {
        snapshots = await adapter.getTracking(chunk, { signal: AbortSignal.timeout(TRACKING_TIMEOUT_MS) });
      } catch (e) {
        if (!summary.failedCarriers.includes(code)) summary.failedCarriers.push(code);
        summary.failed += chunkShipments.length;
        logger.warn("tracking.carrier_failed", { carrier: code, count: chunk.length, error: e });
        if (opts.rotateFailed) await touchTracked(ctx, chunkShipments.map((s) => s.id));
        continue;
      }
      const snapshotByNumber = new Map(snapshots.map((s) => [s.waybillNumber, s]));
      for (const shipment of chunkShipments) {
        summary.checked++;
        const snapshot = shipment.waybillNumber ? snapshotByNumber.get(shipment.waybillNumber) : undefined;
        if (!snapshot) {
          await touchTracked(ctx, [shipment.id]);
          continue;
        }
        const result = await applyTrackingSnapshot(ctx, shipment.id, snapshot, adapter.displayName);
        if (result?.changed) summary.updated++;
        if (result?.newlyHandedOver) {
          summary.handedOver++;
          await requestShopifyFulfillment(ctx, shipment.id).catch((e) => logger.warn("tracking.fulfillment_request_failed", { error: e }));
        }
      }
    }
  }
  return summary;
}

/** Відправлення, які ще потребують відстеження. */
export async function shipmentsDueForTracking(db: DbOrTx, now: Date, limit = POLL_BATCH_LIMIT, minAgeMs = MIN_POLL_AGE_MS) {
  const before = new Date(now.getTime() - minAgeMs);
  const rows = await db
    .select({ shipment: shipments })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(
      and(
        eq(shipments.status, "created"),
        isNotNull(shipments.waybillNumber),
        or(isNull(shipments.trackingStatus), notInArray(shipments.trackingStatus, [...FINAL_TRACKING_STATUSES])),
        notInArray(orders.status, ["delivered", "returned", "cancelled"]),
        or(isNull(shipments.lastTrackedAt), lt(shipments.lastTrackedAt, before)),
      ),
    )
    .orderBy(sql`${shipments.lastTrackedAt} asc nulls first`, asc(shipments.createdAt))
    .limit(limit);
  return rows.map((r) => r.shipment);
}

/**
 * Повторно ставить у чергу передачу трек-номерів, якщо попередня постановка не відбулася (збій між кроками).
 * Пропускає відправлення, для яких завдання вже чекає/виконується або остаточно не вдалося (dead): остаточна
 * відмова Shopify (userErrors, немає доступу, замовлення не знайдено) не повторюється щогодини — для неї є
 * проблема SHOPIFY_FULFILLMENT_FAILED і кнопка «Повторити» на сторінці синхронізації Shopify.
 */
async function ensurePendingFulfillments(ctx: ServiceContext): Promise<number> {
  const rows = await ctx.db
    .select({ id: shipments.id })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(
      and(
        eq(shipments.status, "created"),
        isNotNull(shipments.handedOverAt),
        isNull(shipments.shopifyFulfilledAt),
        isNotNull(orders.shopifyOrderId),
        eq(orders.source, "shopify"),
        sql`not exists (select 1 from ${jobs} where ${jobs.dedupeKey} = ${FULFILL_DEDUPE_PREFIX} || ${shipments.id}::text
              and ${jobs.status} in ('queued', 'running', 'dead'))`,
      ),
    )
    .orderBy(asc(shipments.handedOverAt))
    .limit(50);
  let queued = 0;
  for (const r of rows) if ((await requestShopifyFulfillment(ctx, r.id)) === "queued") queued++;
  return queued;
}

/** Одне опитування (фонове завдання). Помилки перевізника не зупиняють інших перевізників. */
export async function pollTracking(ctx: ServiceContext, opts: { limit?: number } = {}): Promise<PollSummary> {
  const rows = await shipmentsDueForTracking(ctx.db, ctx.now(), opts.limit ?? POLL_BATCH_LIMIT);
  const summary = await trackShipments(ctx, rows, { rotateFailed: true, deadlineAt: Date.now() + POLL_DEADLINE_MS });
  if (ctx.mode === "production") await ensurePendingFulfillments(ctx);
  logger.info("tracking.poll", { ...summary, failedCarriers: summary.failedCarriers.join(",") });
  return summary;
}

/** Ручне оновлення статусу одного відправлення з картки замовлення. */
export async function refreshShipmentTracking(ctx: ServiceContext, shipmentId: string): Promise<PollSummary> {
  requirePermission(ctx.actor, "waybills.create");
  const [shipment] = await ctx.db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!shipment) throw new NotFoundError("shipment");
  if (shipment.status !== "created" || !shipment.waybillNumber) throw new DomainError("waybill.notActive", 409);
  if (!trackable(ctx.carriers.get(shipment.carrierCode))) throw new DomainError("tracking.notSupported", 409);
  const summary = await trackShipments(ctx, [shipment]);
  if (summary.failedCarriers.length > 0) throw new DomainError("tracking.carrierUnavailable", 503);
  return summary;
}

/** Планує наступне опитування (одне очікуване завдання завдяки dedupeKey). */
export async function scheduleTrackingPoll(db: DbOrTx, runAt: Date): Promise<boolean> {
  return enqueueJob(db, JOB.trackingPoll, {}, { dedupeKey: JOB.trackingPoll, runAt, maxAttempts: 3 });
}

/** Обробник завдання tracking.poll: спершу планує наступне (ланцюжок не обривається при збої), потім опитує. */
export async function runTrackingPollJob(ctx: ServiceContext): Promise<PollSummary | null> {
  const settings = await getSetting(ctx.db, "tracking");
  await scheduleTrackingPoll(ctx.db, new Date(ctx.now().getTime() + settings.intervalMinutes * 60_000));
  if (!settings.enabled) return null;
  return pollTracking(ctx);
}

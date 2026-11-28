/**
 * Етап 6, WP9: сервіси розділу «Повернення» (docs/stage6-design.md §11, §14.2) — без грошей.
 * - читання (список, деталь з повною історією замовлення, підказки перевізника, форма): `orders.view`;
 * - ручні дії (новий випадок, «Відкрити» з підказки, зміна виду / причини / примітки / статусу): `orders.edit`
 *   (працівник або власник); кожна — в транзакції під advisory-блокуванням фінансів замовлення (FINO, як і внутрішня
 *   синхронізація sync.server.ts), зміна — compare-and-set за `version`; журнал `audit_log` — лише id і коди.
 * Суми (повернено, зворотна доставка, обробка, вплив на собівартість, утримані збори) — лише власнику, окремим
 * сервісом amounts.server.ts (`requireFinance`); тут їх немає (loader працівника отримує `null`).
 * Ознаки при читанні (insights.server.ts / attribution.ts): «Очікує надходження на склад» (§6.7), неточна кількість
 * (рядки повернення коштів MIXED — «ще до N од.»), тестове замовлення Shopify.
 */
import { randomUUID } from "node:crypto";
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, ne, notExists, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  auditLog,
  inventoryMovements,
  orderChanges,
  orderLineItems,
  orderPacking,
  orderReturnLines,
  orderReturns,
  orders,
  productVariants,
  products,
  shipments,
  shipmentTrackingEvents,
  stockItems,
} from "~/db/schema";
import { RETURN_KINDS, RETURN_LINE_CONDITIONS, RETURN_REASON_CODES, RETURN_STATUSES } from "~/domain/finance";
import { requirePermission } from "~/domain/permissions";
import { ConflictError, DomainError, NotFoundError } from "~/lib/errors";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { maskFreeTextNote } from "~/modules/privacy/notes";
import { businessDayEnd, businessDayStart } from "~/modules/warehouse/dates";
import type { ServiceContext } from "~/server/types";
import { carrierReturnCodeList, carrierReturnSignal, SIGNAL_CASE_KIND, SIGNAL_REASON, type CarrierReturnSignal } from "./carrier-codes";
import { caseInsight, isUncertainCaseLine, lineOrigins } from "./attribution";
import { CUSTOMER_RETURN_REASON, loadReceiptSources, loadRefundSources, RETURN_DEFECT_SUFFIX } from "./facts.server";
import { caseInsights } from "./insights.server";
import { returnSourceKeys } from "./keys";
import { statusDates, type ReturnKind, type ReturnLineCondition, type ReturnReason, type ReturnStatus } from "./rules";
import { syncReturnCasesForOrder } from "./sync.server";

type Ctx = Pick<ServiceContext, "db" | "actor" | "now">;

export const RETURNS_PAGE_SIZE = 25;
export const MAX_RETURN_NOTE_LENGTH = 300;
export const MAX_MANUAL_LINES = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isKind = (v: unknown): v is ReturnKind => (RETURN_KINDS as readonly unknown[]).includes(v);
const isStatus = (v: unknown): v is ReturnStatus => (RETURN_STATUSES as readonly unknown[]).includes(v);
const isReason = (v: unknown): v is ReturnReason => (RETURN_REASON_CODES as readonly unknown[]).includes(v);
const isCondition = (v: unknown): v is ReturnLineCondition => (RETURN_LINE_CONDITIONS as readonly unknown[]).includes(v);

async function audit(tx: Tx, ctx: Ctx, action: string, caseId: string, details: Record<string, unknown>): Promise<void> {
  await tx.insert(auditLog).values({
    actorType: ctx.actor.kind,
    actorId: ctx.actor.id,
    action,
    entityType: "order_return",
    entityId: caseId,
    details,
  });
}

/** Номер замовлення («1001», «#1001») або id → замовлення. */
export async function resolveReturnOrder(db: DbOrTx, ref: string): Promise<{ id: string; orderNumber: string } | null> {
  const r = ref.trim().slice(0, 64);
  if (!r) return null;
  if (UUID_RE.test(r)) {
    const [row] = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, r));
    return row ?? null;
  }
  const candidates = r.startsWith("#") ? [r, r.slice(1)] : [r, `#${r}`];
  const rows = await db.select({ id: orders.id, orderNumber: orders.orderNumber }).from(orders).where(inArray(orders.orderNumber, candidates));
  return rows.find((x) => x.orderNumber === r) ?? rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Список
// ---------------------------------------------------------------------------

export interface ReturnListFilter {
  status?: string | null;
  kind?: string | null;
  reason?: string | null;
  country?: string | null;
  /** Період за датою першого сигналу (Київ), YYYY-MM-DD включно. */
  from?: string | null;
  to?: string | null;
  /** Номер замовлення (частина). */
  q?: string | null;
  page?: number;
  pageSize?: number;
}

export interface ReturnCaseRow {
  id: string;
  orderId: string;
  orderNumber: string;
  kind: ReturnKind;
  status: ReturnStatus;
  reasonCode: ReturnReason;
  source: string;
  firstSignalAt: Date;
  receivedAt: Date | null;
  closedAt: Date | null;
  countryCode: string | null;
  /** Тестове замовлення Shopify (`orders.shopify_test`) — у статистиці не враховується без `finance.includeTestOrders`. */
  testOrder: boolean;
  /** Точно відомі одиниці. */
  units: number;
  restocked: number;
  damaged: number;
  /** Можливо ще одиниць (рядки повернення коштів MIXED — кількість неточна); 0 — точно. */
  uncertainUnits: number;
  /** §6.7 «Очікує надходження на склад». */
  awaitingReceipt: boolean;
}

export interface ReturnCaseList {
  rows: ReturnCaseRow[];
  total: number;
  page: number;
  pageSize: number;
  /** Країни, у яких є випадки (для фільтра). */
  countries: string[];
}

/** Умови фільтра випадків (спільні для списку й статистики). */
export function returnFilterWhere(filter: ReturnListFilter): SQL | undefined {
  const conds: SQL[] = [eq(orderReturns.storeId, DEFAULT_STORE_ID)];
  if (isStatus(filter.status)) conds.push(eq(orderReturns.status, filter.status));
  if (isKind(filter.kind)) conds.push(eq(orderReturns.kind, filter.kind));
  if (isReason(filter.reason)) conds.push(eq(orderReturns.reasonCode, filter.reason));
  const country = (filter.country ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(country)) conds.push(eq(orders.shipCountryCode, country));
  if (filter.from && /^\d{4}-\d{2}-\d{2}$/.test(filter.from)) conds.push(gte(orderReturns.firstSignalAt, businessDayStart(filter.from)));
  if (filter.to && /^\d{4}-\d{2}-\d{2}$/.test(filter.to)) conds.push(lte(orderReturns.firstSignalAt, businessDayEnd(filter.to)));
  const q = (filter.q ?? "").trim().slice(0, 40);
  if (q) conds.push(ilike(orders.orderNumber, `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`));
  return and(...conds);
}

export async function listReturnCases(ctx: Ctx, filter: ReturnListFilter = {}): Promise<ReturnCaseList> {
  requirePermission(ctx.actor, "orders.view");
  const pageSize = Math.min(Math.max(filter.pageSize ?? RETURNS_PAGE_SIZE, 1), 100);
  const page = Math.max(1, Math.floor(filter.page ?? 1));
  const where = returnFilterWhere(filter);
  const [[totalRow], rows, countryRows] = await Promise.all([
    ctx.db.select({ n: count() }).from(orderReturns).innerJoin(orders, eq(orders.id, orderReturns.orderId)).where(where),
    ctx.db
      .select({
        id: orderReturns.id,
        orderId: orderReturns.orderId,
        orderNumber: orders.orderNumber,
        kind: orderReturns.kind,
        status: orderReturns.status,
        reasonCode: orderReturns.reasonCode,
        source: orderReturns.source,
        firstSignalAt: orderReturns.firstSignalAt,
        receivedAt: orderReturns.receivedAt,
        closedAt: orderReturns.closedAt,
        countryCode: orders.shipCountryCode,
        testOrder: orders.shopifyTest,
      })
      .from(orderReturns)
      .innerJoin(orders, eq(orders.id, orderReturns.orderId))
      .where(where)
      .orderBy(desc(orderReturns.firstSignalAt), desc(orderReturns.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    ctx.db
      .selectDistinct({ c: orders.shipCountryCode })
      .from(orderReturns)
      .innerJoin(orders, eq(orders.id, orderReturns.orderId))
      .where(eq(orderReturns.storeId, DEFAULT_STORE_ID)),
  ]);
  const insights = await caseInsights(ctx.db, rows);
  return {
    rows: rows.map((r) => {
      const i = insights.get(r.id);
      return {
        ...r,
        units: i?.units.units ?? 0,
        restocked: i?.units.restocked ?? 0,
        damaged: i?.units.damaged ?? 0,
        uncertainUnits: i?.units.uncertainUnits ?? 0,
        awaitingReceipt: i?.awaitingReceipt ?? false,
      };
    }),
    total: totalRow?.n ?? 0,
    page,
    pageSize,
    countries: countryRows
      .map((r) => r.c)
      .filter((c): c is string => Boolean(c))
      .sort(),
  };
}

// ---------------------------------------------------------------------------
// Підказки перевізника («Можливе повернення (дані перевізника)»)
// ---------------------------------------------------------------------------

export interface CarrierReturnHint {
  shipmentId: string;
  orderId: string;
  orderNumber: string;
  carrierCode: string;
  waybillNumber: string | null;
  code: string;
  signal: CarrierReturnSignal;
  suggestedKind: ReturnKind;
  at: Date | null;
  countryCode: string | null;
}

function hintMatch(): SQL {
  const parts: SQL[] = [];
  for (const { carrierCode, codes } of carrierReturnCodeList()) {
    parts.push(and(eq(shipments.carrierCode, carrierCode), inArray(shipments.carrierStatusCode, codes))!);
    parts.push(
      and(
        eq(shipments.carrierCode, carrierCode),
        sql`exists (select 1 from ${shipmentTrackingEvents} e where e.shipment_id = ${shipments.id} and e.code in (${sql.join(
          codes.map((c) => sql`${c}`),
          sql`, `,
        )}))`,
      )!,
    );
  }
  return or(...parts)!;
}

/** Сигнал відправлення: поточний код статусу, інакше — остання подія відстеження з кодом повернення. */
async function signalsOf(
  db: DbOrTx,
  rows: ReadonlyArray<{
    id: string;
    carrierCode: string;
    carrierStatusCode: string | null;
    carrierStatusAt: Date | null;
  }>,
): Promise<Map<string, { code: string; signal: CarrierReturnSignal; at: Date | null }>> {
  const out = new Map<string, { code: string; signal: CarrierReturnSignal; at: Date | null }>();
  const pending: string[] = [];
  for (const r of rows) {
    const s = carrierReturnSignal(r.carrierCode, r.carrierStatusCode);
    if (s)
      out.set(r.id, {
        code: r.carrierStatusCode!.trim(),
        signal: s,
        at: r.carrierStatusAt,
      });
    else pending.push(r.id);
  }
  if (pending.length > 0) {
    const carrierOf = new Map(rows.map((r) => [r.id, r.carrierCode]));
    const events = await db
      .select({
        shipmentId: shipmentTrackingEvents.shipmentId,
        code: shipmentTrackingEvents.code,
        at: shipmentTrackingEvents.occurredAt,
      })
      .from(shipmentTrackingEvents)
      .where(inArray(shipmentTrackingEvents.shipmentId, pending))
      .orderBy(desc(shipmentTrackingEvents.occurredAt));
    for (const e of events) {
      if (out.has(e.shipmentId)) continue;
      const s = carrierReturnSignal(carrierOf.get(e.shipmentId), e.code);
      if (s) out.set(e.shipmentId, { code: e.code, signal: s, at: e.at });
    }
  }
  return out;
}

/**
 * Можливі повернення з даних перевізника (CARRIER_RETURN_CODES за ключем перевізника) для відправлень, у замовлення
 * яких немає незакритого випадку і для яких випадок із цієї підказки ще не відкривали. Лише читання.
 */
export async function listCarrierReturnHints(ctx: Ctx, opts: { orderId?: string; limit?: number } = {}): Promise<CarrierReturnHint[]> {
  requirePermission(ctx.actor, "orders.view");
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const rows = await ctx.db
    .select({
      id: shipments.id,
      orderId: shipments.orderId,
      orderNumber: orders.orderNumber,
      carrierCode: shipments.carrierCode,
      waybillNumber: shipments.waybillNumber,
      carrierStatusCode: shipments.carrierStatusCode,
      carrierStatusAt: shipments.carrierStatusAt,
      countryCode: orders.shipCountryCode,
    })
    .from(shipments)
    .innerJoin(orders, eq(orders.id, shipments.orderId))
    .where(
      and(
        opts.orderId ? eq(shipments.orderId, opts.orderId) : undefined,
        inArray(shipments.status, ["created", "unknown"]),
        hintMatch(),
        notExists(
          ctx.db
            .select({ x: sql`1` })
            .from(orderReturns)
            .where(
              and(
                eq(orderReturns.orderId, shipments.orderId),
                or(ne(orderReturns.status, "closed"), eq(orderReturns.sourceKey, sql`'ret:carrier:' || ${shipments.id}::text`)),
              ),
            ),
        ),
      ),
    )
    .orderBy(desc(sql`coalesce(${shipments.carrierStatusAt}, ${shipments.createdAt})`), desc(shipments.id))
    .limit(limit);
  const signals = await signalsOf(ctx.db, rows);
  return rows.flatMap((r) => {
    const s = signals.get(r.id);
    if (!s) return [];
    return [
      {
        shipmentId: r.id,
        orderId: r.orderId,
        orderNumber: r.orderNumber,
        carrierCode: r.carrierCode,
        waybillNumber: r.waybillNumber,
        code: s.code,
        signal: s.signal,
        suggestedKind: SIGNAL_CASE_KIND[s.signal],
        at: s.at,
        countryCode: r.countryCode,
      },
    ];
  });
}

// ---------------------------------------------------------------------------
// Деталь з повною історією замовлення
// ---------------------------------------------------------------------------

export type ReturnLineOrigin = "shopify" | "warehouse" | "manual";

export interface ReturnCaseLineView {
  id: string;
  origin: ReturnLineOrigin;
  orderLineItemId: string | null;
  variantId: string | null;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  quantity: number;
  condition: ReturnLineCondition;
  restockedQty: number;
  /** Кількість неточна (рядок повернення коштів Shopify MIXED — верхня межа). */
  uncertain: boolean;
}

export type ReturnTimelineType =
  | "order_placed"
  | "order_change"
  | "order_status"
  | "order_validated"
  | "order_cancelled"
  | "waybill_created"
  | "waybill_failed"
  | "waybill_cancelled"
  | "handed_over"
  | "delivered"
  | "tracking"
  | "packing_started"
  | "packed"
  | "stock_consumed"
  | "stock_return"
  | "stock_defect"
  | "refund"
  | "case_created"
  | "case_linked"
  | "case_status"
  | "case_updated";

export interface ReturnTimelineEntry {
  id: string;
  at: Date;
  type: ReturnTimelineType;
  /** Цей випадок (а не інший випадок того самого замовлення). */
  current: boolean;
  params: Record<string, string | number>;
}

export interface ReturnShipmentView {
  id: string;
  carrierCode: string;
  waybillNumber: string | null;
  status: string;
  trackingStatus: string | null;
  signal: CarrierReturnSignal | null;
  code: string | null;
  handedOverAt: Date | null;
  deliveredAt: Date | null;
}

export interface ReturnCaseDetail {
  case: {
    id: string;
    orderId: string;
    kind: ReturnKind;
    status: ReturnStatus;
    reasonCode: ReturnReason;
    reasonNote: string | null;
    source: string;
    firstSignalAt: Date;
    receivedAt: Date | null;
    closedAt: Date | null;
    createdAt: Date;
    version: number;
  };
  order: {
    id: string;
    orderNumber: string;
    status: string;
    countryCode: string | null;
    placedAt: Date;
    source: string;
    /** Тестове замовлення Shopify. */
    testOrder: boolean;
  };
  lines: ReturnCaseLineView[];
  /** uncertainUnits — можливо ще одиниць (MIXED), 0 — кількість точна. */
  units: {
    units: number;
    restocked: number;
    damaged: number;
    uncertainUnits: number;
  };
  /** §6.7 «Очікує надходження на склад»: повернення коштів з поверненням товару на склад без надходження. */
  awaitingReceipt: boolean;
  /** Очікування лише можливе (повернення товару видно тільки з рядків MIXED). */
  awaitingReceiptUncertain: boolean;
  /** Є позиції з неточною кількістю (MIXED). */
  quantityUncertain: boolean;
  otherCases: Array<{
    id: string;
    kind: ReturnKind;
    status: ReturnStatus;
    firstSignalAt: Date;
  }>;
  shipments: ReturnShipmentView[];
  timeline: ReturnTimelineEntry[];
}

/**
 * Дії audit_log замовлення, що змінюють або фіксують його статус (§11 «статуси (audit_log)»): `order.status_changed`
 * (відстеження, пакування, «відправлено поза застосунком» — {from, to}), `order.validated` (перевірка даних —
 * {status}), `order.cancelled` (скасування). Статуси, які змінюють події накладної (створено / відмова / скасовано), —
 * у хронології з відправлень.
 */
export const ORDER_STATUS_AUDIT_ACTIONS = ["order.status_changed", "order.validated", "order.cancelled"] as const;

const short = (v: string | null, max = 120) => (v === null ? "" : v.length > max ? `${v.slice(0, max - 1)}…` : v);

export async function getReturnCase(ctx: Ctx, id: string): Promise<ReturnCaseDetail> {
  requirePermission(ctx.actor, "orders.view");
  if (!UUID_RE.test(id)) throw new NotFoundError("return");
  const [c] = await ctx.db.select().from(orderReturns).where(eq(orderReturns.id, id));
  if (!c) throw new NotFoundError("return");
  const db = ctx.db;
  const [orderRow] = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      countryCode: orders.shipCountryCode,
      placedAt: orders.placedAt,
      source: orders.source,
      testOrder: orders.shopifyTest,
    })
    .from(orders)
    .where(eq(orders.id, c.orderId));
  if (!orderRow) throw new NotFoundError("order");
  const [siblings, refunds, receipts, ships, changes, orderAudit, packing, movements] = await Promise.all([
    db.select().from(orderReturns).where(eq(orderReturns.orderId, c.orderId)).orderBy(asc(orderReturns.firstSignalAt), asc(orderReturns.id)),
    loadRefundSources(db, c.orderId),
    loadReceiptSources(db, c.orderId),
    db.select().from(shipments).where(eq(shipments.orderId, c.orderId)).orderBy(asc(shipments.createdAt)),
    db.select().from(orderChanges).where(eq(orderChanges.orderId, c.orderId)).orderBy(desc(orderChanges.createdAt)).limit(200),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "order"), eq(auditLog.entityId, c.orderId), inArray(auditLog.action, [...ORDER_STATUS_AUDIT_ACTIONS])))
      .orderBy(desc(auditLog.createdAt))
      .limit(200),
    db.select().from(orderPacking).where(eq(orderPacking.orderId, c.orderId)).orderBy(asc(orderPacking.generation)),
    db
      .select({
        id: inventoryMovements.id,
        key: inventoryMovements.idempotencyKey,
        type: inventoryMovements.type,
        reason: inventoryMovements.reason,
        onHand: inventoryMovements.onHandDelta,
        defective: inventoryMovements.defectiveDelta,
        createdAt: inventoryMovements.createdAt,
        title: products.title,
        variantTitle: productVariants.title,
      })
      .from(inventoryMovements)
      .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(inventoryMovements.orderId, c.orderId), inArray(inventoryMovements.type, ["consume_sale", "receipt_manual", "defect_mark"])))
      .orderBy(asc(inventoryMovements.seq)),
  ]);
  const caseIds = siblings.map((s) => s.id);
  const [lineRows, caseAudit, events] = await Promise.all([
    db
      .select({
        line: orderReturnLines,
        title: sql<string | null>`coalesce(${products.title}, ${orderLineItems.title})`,
        variantTitle: sql<string | null>`coalesce(${productVariants.title}, ${orderLineItems.variantTitle})`,
        sku: sql<string | null>`coalesce(${productVariants.sku}, ${orderLineItems.sku})`,
        model: productVariants.model,
        color: productVariants.color,
      })
      .from(orderReturnLines)
      .leftJoin(orderLineItems, eq(orderLineItems.id, orderReturnLines.orderLineItemId))
      .leftJoin(productVariants, eq(productVariants.id, sql`coalesce(${orderReturnLines.variantId}, ${orderLineItems.variantId})`))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(eq(orderReturnLines.returnId, c.id))
      .orderBy(asc(orderReturnLines.createdAt), asc(orderReturnLines.id)),
    db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityType, "order_return"), inArray(auditLog.entityId, caseIds)))
      .orderBy(desc(auditLog.createdAt))
      .limit(200),
    ships.length
      ? db
          .select()
          .from(shipmentTrackingEvents)
          .where(
            inArray(
              shipmentTrackingEvents.shipmentId,
              ships.map((s) => s.id),
            ),
          )
          .orderBy(desc(shipmentTrackingEvents.occurredAt))
          .limit(300)
      : Promise.resolve([]),
  ]);

  const origins = lineOrigins(
    refunds,
    receipts.map((r) => r.movementId),
  );
  const lines: ReturnCaseLineView[] = lineRows.map((r) => {
    const o = origins.get(r.line.id);
    return {
      id: r.line.id,
      origin: o?.kind === "refund" ? "shopify" : o?.kind === "receipt" ? "warehouse" : "manual",
      orderLineItemId: r.line.orderLineItemId,
      variantId: r.line.variantId,
      title: r.title,
      variantTitle: r.variantTitle,
      sku: r.sku,
      model: r.model,
      color: r.color,
      quantity: r.line.quantity,
      condition: r.line.condition,
      restockedQty: r.line.restockedQty,
      uncertain: isUncertainCaseLine(o, r.line.quantity),
    };
  });
  const insight = caseInsight(
    c,
    lineRows.map((r) => r.line),
    origins,
  );
  const units = insight.units;

  const shipmentViews: ReturnShipmentView[] = ships.map((s) => {
    const current = carrierReturnSignal(s.carrierCode, s.carrierStatusCode);
    const ev = current ? null : events.find((e) => e.shipmentId === s.id && carrierReturnSignal(s.carrierCode, e.code));
    return {
      id: s.id,
      carrierCode: s.carrierCode,
      waybillNumber: s.waybillNumber,
      status: s.status,
      trackingStatus: s.trackingStatus,
      signal: current ?? (ev ? carrierReturnSignal(s.carrierCode, ev.code) : null),
      code: current ? s.carrierStatusCode : (ev?.code ?? null),
      handedOverAt: s.handedOverAt,
      deliveredAt: s.deliveredAt,
    };
  });

  const tl: ReturnTimelineEntry[] = [];
  const push = (e: Omit<ReturnTimelineEntry, "current"> & { current?: boolean }) => tl.push({ current: false, ...e });
  push({
    id: `order-${orderRow.id}`,
    at: orderRow.placedAt,
    type: "order_placed",
    params: { order: orderRow.orderNumber },
  });
  for (const ch of changes) {
    push({
      id: `change-${ch.id}`,
      at: ch.createdAt,
      type: "order_change",
      params: {
        field: ch.field,
        from: short(ch.oldValue),
        to: short(ch.newValue),
        source: ch.source,
      },
    });
  }
  for (const a of orderAudit) {
    const d = (a.details ?? {}) as Record<string, unknown>;
    if (a.action === "order.validated")
      push({
        id: `audit-${a.id}`,
        at: a.createdAt,
        type: "order_validated",
        params: { to: String(d.status ?? "") },
      });
    else if (a.action === "order.cancelled")
      push({
        id: `audit-${a.id}`,
        at: a.createdAt,
        type: "order_cancelled",
        params: {},
      });
    else
      push({
        id: `audit-${a.id}`,
        at: a.createdAt,
        type: "order_status",
        params: { from: String(d.from ?? ""), to: String(d.to ?? "") },
      });
  }
  const shipNo = new Map(ships.map((s) => [s.id, s.waybillNumber ?? ""]));
  for (const s of ships) {
    // Накладну не створено (перевізник відмовив / точно не створив) — не «Створено накладну».
    push({
      id: `ship-${s.id}`,
      at: s.createdAt,
      type: s.status === "failed" ? "waybill_failed" : "waybill_created",
      params: { number: s.waybillNumber ?? "", carrier: s.carrierCode },
    });
    if (s.status === "cancelled")
      push({
        id: `ship-cancel-${s.id}`,
        at: s.updatedAt,
        type: "waybill_cancelled",
        params: { number: s.waybillNumber ?? "" },
      });
    if (s.handedOverAt)
      push({
        id: `ship-handover-${s.id}`,
        at: s.handedOverAt,
        type: "handed_over",
        params: { number: s.waybillNumber ?? "" },
      });
    if (s.deliveredAt)
      push({
        id: `ship-delivered-${s.id}`,
        at: s.deliveredAt,
        type: "delivered",
        params: { number: s.waybillNumber ?? "" },
      });
  }
  const carrierOf = new Map(ships.map((s) => [s.id, s.carrierCode]));
  for (const e of events) {
    const signal = carrierReturnSignal(carrierOf.get(e.shipmentId), e.code);
    push({
      id: `track-${e.id}`,
      at: e.occurredAt,
      type: "tracking",
      params: {
        status: e.status,
        code: e.code,
        number: shipNo.get(e.shipmentId) ?? "",
        ...(signal ? { signal } : {}),
      },
    });
  }
  for (const p of packing) {
    if (p.startedAt)
      push({
        id: `pack-start-${p.id}`,
        at: p.startedAt,
        type: "packing_started",
        params: { generation: p.generation },
      });
    if (p.packedAt)
      push({
        id: `pack-${p.id}`,
        at: p.packedAt,
        type: "packed",
        params: { generation: p.generation },
      });
  }
  for (const m of movements) {
    const item = [m.title, m.variantTitle].filter(Boolean).join(" · ");
    if (m.type === "consume_sale")
      push({
        id: `mv-${m.id}`,
        at: m.createdAt,
        type: "stock_consumed",
        params: { qty: -m.onHand, item },
      });
    else if (m.type === "receipt_manual" && m.reason === CUSTOMER_RETURN_REASON)
      push({
        id: `mv-${m.id}`,
        at: m.createdAt,
        type: "stock_return",
        params: { good: m.onHand, damaged: m.defective, item },
      });
    else if (m.type === "defect_mark" && m.reason === CUSTOMER_RETURN_REASON)
      push({
        id: `mv-${m.id}`,
        at: m.createdAt,
        type: "stock_defect",
        params: {
          qty: m.defective,
          item,
          split: m.key.endsWith(RETURN_DEFECT_SUFFIX) ? 1 : 0,
        },
      });
  }
  for (const r of refunds) {
    const qty = r.lines.reduce((s, l) => s + l.quantity, 0);
    push({
      id: `refund-${r.refundId}`,
      at: r.at,
      type: "refund",
      params: { units: qty },
    });
  }
  for (const s of siblings) {
    push({
      id: `case-${s.id}`,
      at: s.createdAt,
      type: "case_created",
      current: s.id === c.id,
      params: { kind: s.kind, source: s.source },
    });
  }
  for (const a of caseAudit) {
    const d = a.details as Record<string, unknown>;
    const current = a.entityId === c.id;
    if (a.action === "returns.status_changed")
      push({
        id: `raudit-${a.id}`,
        at: a.createdAt,
        type: "case_status",
        current,
        params: { from: String(d.from ?? ""), to: String(d.to ?? "") },
      });
    else if (a.action === "returns.source_linked")
      push({
        id: `raudit-${a.id}`,
        at: a.createdAt,
        type: "case_linked",
        current,
        params: { source: String(d.source ?? "") },
      });
    else if (a.action === "returns.case_updated")
      push({
        id: `raudit-${a.id}`,
        at: a.createdAt,
        type: "case_updated",
        current,
        params: {
          fields: Array.isArray(d.fields) ? d.fields.map(String).join(",") : "",
        },
      });
  }
  tl.sort((a, b) => b.at.getTime() - a.at.getTime() || a.id.localeCompare(b.id));

  return {
    case: {
      id: c.id,
      orderId: c.orderId,
      kind: c.kind,
      status: c.status,
      reasonCode: c.reasonCode,
      reasonNote: c.reasonNote,
      source: c.source,
      firstSignalAt: c.firstSignalAt,
      receivedAt: c.receivedAt,
      closedAt: c.closedAt,
      createdAt: c.createdAt,
      version: c.version,
    },
    order: orderRow,
    lines,
    units: {
      units: units.units,
      restocked: units.restocked,
      damaged: units.damaged,
      uncertainUnits: units.uncertainUnits,
    },
    awaitingReceipt: insight.awaitingReceipt,
    awaitingReceiptUncertain: insight.awaitingReceiptUncertain,
    quantityUncertain: insight.quantityUncertain,
    otherCases: siblings
      .filter((s) => s.id !== c.id)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        status: s.status,
        firstSignalAt: s.firstSignalAt,
      })),
    shipments: shipmentViews,
    timeline: tl,
  };
}

// ---------------------------------------------------------------------------
// Форма ручного випадку
// ---------------------------------------------------------------------------

export interface ReturnFormOrder {
  id: string;
  orderNumber: string;
  items: Array<{
    id: string;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    quantity: number;
  }>;
  openCaseId: string | null;
}

export async function returnFormOrder(ctx: Ctx, ref: string): Promise<ReturnFormOrder | null> {
  requirePermission(ctx.actor, "orders.view");
  const order = await resolveReturnOrder(ctx.db, ref);
  if (!order) return null;
  const [items, open] = await Promise.all([
    ctx.db
      .select({
        id: orderLineItems.id,
        title: orderLineItems.title,
        variantTitle: orderLineItems.variantTitle,
        sku: orderLineItems.sku,
        quantity: orderLineItems.quantity,
      })
      .from(orderLineItems)
      .where(eq(orderLineItems.orderId, order.id))
      .orderBy(asc(orderLineItems.position), asc(orderLineItems.id)),
    ctx.db
      .select({ id: orderReturns.id })
      .from(orderReturns)
      .where(and(eq(orderReturns.orderId, order.id), ne(orderReturns.status, "closed")))
      .orderBy(asc(orderReturns.firstSignalAt))
      .limit(1),
  ]);
  return { ...order, items, openCaseId: open[0]?.id ?? null };
}

// ---------------------------------------------------------------------------
// Ручні дії (orders.edit)
// ---------------------------------------------------------------------------

export interface ManualReturnInput {
  /** uuid форми (подвійне надсилання не створює другого випадку). */
  operationId: string;
  orderRef: string;
  kind: string;
  reasonCode?: string | null;
  note?: string | null;
  status?: string | null;
  lines?: ReadonlyArray<{
    orderLineItemId: string;
    quantity: number;
    condition?: string | null;
  }>;
}

export interface ManualReturnResult {
  caseId: string;
  /** created — новий ручний випадок; replay — повтор тієї самої форми; existing — у замовлення вже є незакритий випадок
   *  (зокрема щойно створений із даних Shopify / складу), новий не створено. */
  outcome: "created" | "replay" | "existing";
}

async function firstOpenCase(tx: DbOrTx, orderId: string): Promise<string | null> {
  const [row] = await tx
    .select({ id: orderReturns.id })
    .from(orderReturns)
    .where(and(eq(orderReturns.orderId, orderId), ne(orderReturns.status, "closed")))
    .orderBy(asc(orderReturns.firstSignalAt), asc(orderReturns.id))
    .limit(1);
  return row?.id ?? null;
}

export async function createManualReturnCase(ctx: Ctx, input: ManualReturnInput): Promise<ManualReturnResult> {
  requirePermission(ctx.actor, "orders.edit");
  if (!UUID_RE.test(input.operationId ?? "")) throw new DomainError("returns.error.operationInvalid", 400);
  if (!isKind(input.kind)) throw new DomainError("returns.error.kindInvalid", 400);
  const reason = input.reasonCode ? input.reasonCode : "unknown";
  if (!isReason(reason)) throw new DomainError("returns.error.reasonInvalid", 400);
  const status = input.status ? input.status : "open";
  if (!isStatus(status)) throw new DomainError("returns.error.statusInvalid", 400);
  const kind = input.kind;
  const lines = input.lines ?? [];
  if (lines.length > MAX_MANUAL_LINES) throw new DomainError("returns.error.lineInvalid", 400);
  const order = await resolveReturnOrder(ctx.db, input.orderRef ?? "");
  if (!order)
    throw new DomainError("returns.error.orderNotFound", 404, {
      order: (input.orderRef ?? "").trim().slice(0, 40),
    });
  const note = maskFreeTextNote(input.note, MAX_RETURN_NOTE_LENGTH);
  const sourceKey = returnSourceKeys.manual(input.operationId.toLowerCase());
  const now = ctx.now();
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, order.id);
    const [replay] = await tx.select({ id: orderReturns.id, orderId: orderReturns.orderId }).from(orderReturns).where(eq(orderReturns.sourceKey, sourceKey));
    if (replay) {
      if (replay.orderId !== order.id) throw new DomainError("returns.error.operationInvalid", 409);
      return { caseId: replay.id, outcome: "replay" as const };
    }
    // Спершу — дані Shopify й складу: якщо вони вже дають випадок, ручний не дублює його.
    await syncReturnCasesForOrder(tx, ctx.actor, order.id);
    const open = await firstOpenCase(tx, order.id);
    if (open) return { caseId: open, outcome: "existing" as const };
    const items = lines.length
      ? await tx
          .select({
            id: orderLineItems.id,
            variantId: orderLineItems.variantId,
            quantity: orderLineItems.quantity,
          })
          .from(orderLineItems)
          .where(eq(orderLineItems.orderId, order.id))
      : [];
    const byId = new Map(items.map((i) => [i.id, i]));
    const seen = new Set<string>();
    const values = lines.map((l) => {
      const item = byId.get(l.orderLineItemId);
      const condition = l.condition ? l.condition : "unknown";
      if (!item || seen.has(item.id) || !isCondition(condition)) throw new DomainError("returns.error.lineInvalid", 400);
      seen.add(item.id);
      if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > item.quantity) {
        throw new DomainError("returns.error.quantityInvalid", 400, {
          max: item.quantity,
        });
      }
      return {
        orderLineItemId: item.id,
        variantId: item.variantId,
        quantity: l.quantity,
        condition,
        restockedQty: 0,
      };
    });
    const id = randomUUID();
    const dates = statusDates({ receivedAt: null, closedAt: null }, status, now);
    await tx.insert(orderReturns).values({
      id,
      storeId: DEFAULT_STORE_ID,
      orderId: order.id,
      kind,
      status,
      reasonCode: reason,
      reasonNote: note,
      source: "manual",
      sourceKey,
      firstSignalAt: now,
      receivedAt: dates.receivedAt,
      closedAt: dates.closedAt,
      createdBy: ctx.actor.id,
    });
    if (values.length) await tx.insert(orderReturnLines).values(values.map((v) => ({ ...v, returnId: id })));
    await audit(tx, ctx, "returns.case_created", id, {
      orderId: order.id,
      source: "manual",
      kind,
      status,
      lines: values.length,
    });
    return { caseId: id, outcome: "created" as const };
  });
}

/** Кнопка «Відкрити» з підказки перевізника: випадок `ret:carrier:<відправлення>` («Їде назад»). */
export async function openReturnFromCarrierHint(ctx: Ctx, input: { shipmentId: string }): Promise<ManualReturnResult> {
  requirePermission(ctx.actor, "orders.edit");
  if (!UUID_RE.test(input.shipmentId ?? "")) throw new NotFoundError("shipment");
  const [ship] = await ctx.db
    .select({
      id: shipments.id,
      orderId: shipments.orderId,
      carrierCode: shipments.carrierCode,
      carrierStatusCode: shipments.carrierStatusCode,
      carrierStatusAt: shipments.carrierStatusAt,
    })
    .from(shipments)
    .where(eq(shipments.id, input.shipmentId));
  if (!ship) throw new NotFoundError("shipment");
  const sourceKey = returnSourceKeys.carrier(ship.id);
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, ship.orderId);
    const [already] = await tx.select({ id: orderReturns.id }).from(orderReturns).where(eq(orderReturns.sourceKey, sourceKey));
    if (already) return { caseId: already.id, outcome: "replay" as const };
    const signal = (await signalsOf(tx, [ship])).get(ship.id);
    if (!signal) throw new DomainError("returns.error.hintGone", 409);
    await syncReturnCasesForOrder(tx, ctx.actor, ship.orderId);
    const open = await firstOpenCase(tx, ship.orderId);
    if (open) return { caseId: open, outcome: "existing" as const };
    const id = randomUUID();
    const kind = SIGNAL_CASE_KIND[signal.signal];
    await tx.insert(orderReturns).values({
      id,
      storeId: DEFAULT_STORE_ID,
      orderId: ship.orderId,
      kind,
      status: "in_transit",
      reasonCode: SIGNAL_REASON[signal.signal],
      source: "carrier_hint",
      sourceKey,
      firstSignalAt: signal.at ?? ctx.now(),
      createdBy: ctx.actor.id,
    });
    await audit(tx, ctx, "returns.case_created", id, {
      orderId: ship.orderId,
      source: "carrier_hint",
      kind,
      status: "in_transit",
      code: signal.code,
    });
    return { caseId: id, outcome: "created" as const };
  });
}

export interface UpdateReturnInput {
  id: string;
  expectedVersion: number;
  kind?: string;
  reasonCode?: string;
  /** undefined — без змін; "" / null — очистити. */
  note?: string | null;
  status?: string;
}

/** Зміна виду, причини, примітки (маскована, ≤ 300) і статусу — compare-and-set за версією. */
export async function updateReturnCase(ctx: Ctx, input: UpdateReturnInput): Promise<{ version: number; changed: boolean }> {
  requirePermission(ctx.actor, "orders.edit");
  if (!UUID_RE.test(input.id ?? "")) throw new NotFoundError("return");
  if (input.kind !== undefined && !isKind(input.kind)) throw new DomainError("returns.error.kindInvalid", 400);
  if (input.reasonCode !== undefined && !isReason(input.reasonCode)) throw new DomainError("returns.error.reasonInvalid", 400);
  if (input.status !== undefined && !isStatus(input.status)) throw new DomainError("returns.error.statusInvalid", 400);
  const [head] = await ctx.db.select({ orderId: orderReturns.orderId }).from(orderReturns).where(eq(orderReturns.id, input.id));
  if (!head) throw new NotFoundError("return");
  return ctx.db.transaction(async (tx) => {
    await lockFinanceOrder(tx, head.orderId);
    const [c] = await tx.select().from(orderReturns).where(eq(orderReturns.id, input.id));
    if (!c) throw new NotFoundError("return");
    if (c.version !== input.expectedVersion) throw new ConflictError();
    const next = {
      kind: (input.kind as ReturnKind | undefined) ?? c.kind,
      reasonCode: (input.reasonCode as ReturnReason | undefined) ?? c.reasonCode,
      reasonNote: input.note === undefined ? c.reasonNote : maskFreeTextNote(input.note, MAX_RETURN_NOTE_LENGTH),
      status: (input.status as ReturnStatus | undefined) ?? c.status,
    };
    const fields = (["kind", "reasonCode", "reasonNote", "status"] as const).filter((f) => next[f] !== c[f]);
    if (fields.length === 0) return { version: c.version, changed: false };
    const dates = next.status !== c.status ? statusDates(c, next.status, ctx.now()) : { receivedAt: c.receivedAt, closedAt: c.closedAt };
    const [row] = await tx
      .update(orderReturns)
      .set({ ...next, ...dates, version: c.version + 1, updatedAt: ctx.now() })
      .where(and(eq(orderReturns.id, c.id), eq(orderReturns.version, c.version)))
      .returning({ version: orderReturns.version });
    if (!row) throw new ConflictError();
    await audit(tx, ctx, "returns.case_updated", c.id, {
      orderId: c.orderId,
      fields: fields.map((f) => (f === "reasonNote" ? "note" : f === "reasonCode" ? "reason" : f)),
      ...(next.status !== c.status ? { from: c.status, to: next.status } : {}),
      ...(next.kind !== c.kind ? { kindFrom: c.kind, kindTo: next.kind } : {}),
      ...(next.reasonCode !== c.reasonCode ? { reasonFrom: c.reasonCode, reasonTo: next.reasonCode } : {}),
    });
    if (next.status !== c.status) {
      await audit(tx, ctx, "returns.status_changed", c.id, {
        orderId: c.orderId,
        from: c.status,
        to: next.status,
        source: "manual",
      });
    }
    return { version: row.version, changed: true };
  });
}

/** Чи є в замовлення випадки (для інших розділів: посилання «Повернення» в картці замовлення тощо). Без грошей. */
export async function returnCasesOfOrder(
  ctx: Ctx,
  orderId: string,
): Promise<
  Array<{
    id: string;
    kind: ReturnKind;
    status: ReturnStatus;
    firstSignalAt: Date;
  }>
> {
  requirePermission(ctx.actor, "orders.view");
  if (!UUID_RE.test(orderId)) return [];
  return ctx.db
    .select({
      id: orderReturns.id,
      kind: orderReturns.kind,
      status: orderReturns.status,
      firstSignalAt: orderReturns.firstSignalAt,
    })
    .from(orderReturns)
    .where(eq(orderReturns.orderId, orderId))
    .orderBy(asc(orderReturns.firstSignalAt), asc(orderReturns.id));
}

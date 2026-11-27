/**
 * Черга пакування (docs/stage5-design.md §6): замовлення «Накладна створена» / «Очікує комплектації» /
 * «Запаковано» з АКТИВНОЮ СТВОРЕНОЮ накладною (до передачі перевізнику) і окремо — «Потрібна накладна»: перевірені
 * замовлення без накладної та замовлення статусів черги, у яких дійсної накладної немає (напр. накладну скасовано
 * після «Запаковано» — таке замовлення спершу розпаковують, потім створюють нову накладну).
 * Сортування: пріоритет ↓, дата замовлення ↑ (найстаріші спершу), id ↑ (стабільний порядок).
 * Фільтри: статус (вкладка), пріоритет, країна, модель, колір, працівник (хто почав або запакував), номер.
 * Дані покупця в черзі — лише країна й місто (без імен, телефонів, адрес).
 */
import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { orderLineItems, orderPacking, orders, productVariants, products, shipments, type OrderPriority } from "~/db/schema";
import type { OrderStatus } from "~/domain/order-status";
import { can } from "~/domain/permissions";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { availableDocumentKinds } from "~/modules/shipments/documents.server";
import { ACTIVE_SHIPMENT_STATUSES } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import { ACTIVE_PACKING_STATUSES, NEEDS_WAYBILL_STATUSES, PACKING_QUEUE_STATUSES } from "./constants";
import { isDeletedAtCarrier, isPackableShipment } from "./packing.server";
import { QUEUE_PAGE_SIZE, type QueueFilters, type QueueTab } from "./queue-filters";
import { checklistProgress, type Checklist } from "./scan";

const OPTIONS_LIMIT = 200;
const QUEUE_SCOPE_STATUSES: OrderStatus[] = [...PACKING_QUEUE_STATUSES, ...NEEDS_WAYBILL_STATUSES];

const activeShipmentJoin = and(eq(shipments.orderId, orders.id), inArray(shipments.status, [...ACTIVE_SHIPMENT_STATUSES]));
const activePackingJoin = and(eq(orderPacking.orderId, orders.id), inArray(orderPacking.status, [...ACTIVE_PACKING_STATUSES]));

const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Замовлення, у якому є одиниця товару з цією моделлю/кольором (кількість до відправлення > 0). */
function hasVariantWith(column: "model" | "color", value: string): SQL {
  const col = column === "model" ? sql.raw("v.model") : sql.raw("v.color");
  return sql`exists (select 1 from ${orderLineItems} li join ${productVariants} v on v.id = li.variant_id
    where li.order_id = ${orders.id} and ${col} = ${value} and coalesce(li.current_quantity, li.quantity) > 0)`;
}

/** Фільтри, крім вкладки (для лічильників вкладок — ті самі). */
function baseConditions(f: Omit<QueueFilters, "tab" | "page">): SQL[] {
  const out: SQL[] = [];
  if (f.priority !== null) out.push(eq(orders.priority, f.priority));
  if (f.country) out.push(eq(orders.shipCountryCode, f.country));
  if (f.model) out.push(hasVariantWith("model", f.model));
  if (f.color) out.push(hasVariantWith("color", f.color));
  if (f.worker) out.push(or(eq(orderPacking.startedBy, f.worker), eq(orderPacking.packedBy, f.worker))!);
  if (f.q) out.push(ilike(orders.orderNumber, `%${escapeLike(f.q)}%`));
  return out;
}

/** Активна накладна (left join activeShipmentJoin) створена — з нею можна пакувати. */
const hasCreatedWaybill = eq(shipments.status, "created");

/**
 * «Потрібна накладна»: перевірені без активної накладної + статуси черги без створеної активної накладної
 * (скасовано після «Запаковано» тощо — у вкладках черги їх немає: пакувати без накладної не можна).
 */
const needsWaybillCondition = or(
  and(inArray(orders.status, [...NEEDS_WAYBILL_STATUSES]), isNull(shipments.id)),
  and(inArray(orders.status, [...PACKING_QUEUE_STATUSES]), or(isNull(shipments.id), ne(shipments.status, "created"))),
)!;

function tabCondition(tab: QueueTab): SQL {
  if (tab === "needs_waybill") return needsWaybillCondition;
  if (tab === "queue") return and(inArray(orders.status, [...PACKING_QUEUE_STATUSES]), hasCreatedWaybill)!;
  return and(eq(orders.status, tab), hasCreatedWaybill)!;
}

/** Стан активної накладної для лічильників (літерали — однаковий вираз у select і group by). */
const waybillState = sql<"none" | "created" | "other">`case when ${shipments.id} is null then 'none' when ${shipments.status} = 'created' then 'created' else 'other' end`;

export interface QueueLine {
  id: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  quantity: number;
}

export interface QueueRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  priority: OrderPriority;
  placedAt: Date;
  countryCode: string | null;
  city: string | null;
  source: "demo" | "shopify";
  units: number;
  lines: QueueLine[];
  waybill: {
    status: string;
    number: string | null;
    carrierName: string;
    testMode: boolean;
    /** Етикетку перевізника можна отримати (PDF для об'єднаного друку). */
    labelAvailable: boolean;
    /** Накладна придатна для пакування (isPackableShipment: створена, не передана, не видалена у перевізника). */
    packable: boolean;
    /** Перевізник повідомив, що накладну видалено (етикетка недійсна). */
    deletedAtCarrier: boolean;
  } | null;
  /** Етап 5: Shopify змінив позиції, а застосунок їх ще не застосував — пакувати за чеклістом не можна. */
  shopifyLinesPending: boolean;
  packing: {
    status: "queued" | "in_progress" | "packed" | "cancelled";
    startedBy: string | null;
    startedByName: string | null;
    startedAt: Date | null;
    packedBy: string | null;
    packedByName: string | null;
    packedAt: Date | null;
    packedUnits: number;
    requiredUnits: number;
    complete: boolean;
  } | null;
}

export interface QueueOptions {
  countries: string[];
  models: string[];
  colors: string[];
  workers: Array<{ id: string; name: string }>;
}

export interface QueueResult {
  rows: QueueRow[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  counts: Record<QueueTab, number>;
  options: QueueOptions;
}

/**
 * Черга пакування. Місто отримувача — лише з orders.view (як і на екрані пакування): packing.perform сам по собі
 * не відкриває персональних даних; країна лишається (групування посилок, митні документи).
 */
export async function listPackingQueue(ctx: Pick<ServiceContext, "db" | "carriers" | "actor">, filters: QueueFilters, opts: { pageSize?: number } = {}): Promise<QueueResult> {
  const db = ctx.db;
  const showCity = can(ctx.actor, "orders.view");
  const pageSize = Math.min(Math.max(opts.pageSize ?? QUEUE_PAGE_SIZE, 1), 200);
  const base = baseConditions(filters);
  const where = and(...base, tabCondition(filters.tab));

  const [totalRow] = await db
    .select({ c: count() })
    .from(orders)
    .leftJoin(shipments, activeShipmentJoin)
    .leftJoin(orderPacking, activePackingJoin)
    .where(where);
  const total = Number(totalRow?.c ?? 0);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(filters.page, pages);

  const [rows, countRows, options] = await Promise.all([
    db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        status: orders.status,
        priority: orders.priority,
        placedAt: orders.placedAt,
        countryCode: orders.shipCountryCode,
        city: orders.shipCity,
        source: orders.source,
        shipmentId: shipments.id,
        shipmentStatus: shipments.status,
        waybillNumber: shipments.waybillNumber,
        carrierCode: shipments.carrierCode,
        carrierShipmentId: shipments.carrierShipmentId,
        carrierReference: shipments.carrierReference,
        mode: shipments.mode,
        handedOverAt: shipments.handedOverAt,
        trackingStatus: shipments.trackingStatus,
        shopifyLinesPendingAt: orders.shopifyLinesPendingAt,
        packingId: orderPacking.id,
        packingStatus: orderPacking.status,
        checklist: orderPacking.checklist,
        startedBy: orderPacking.startedBy,
        startedByName: orderPacking.startedByName,
        startedAt: orderPacking.startedAt,
        packedBy: orderPacking.packedBy,
        packedByName: orderPacking.packedByName,
        packedAt: orderPacking.packedAt,
      })
      .from(orders)
      .leftJoin(shipments, activeShipmentJoin)
      .leftJoin(orderPacking, activePackingJoin)
      .where(where)
      .orderBy(desc(orders.priority), asc(orders.placedAt), asc(orders.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db
      .select({ status: orders.status, waybill: waybillState, c: count() })
      .from(orders)
      .leftJoin(shipments, activeShipmentJoin)
      .leftJoin(orderPacking, activePackingJoin)
      .where(and(...base, inArray(orders.status, QUEUE_SCOPE_STATUSES)))
      .groupBy(orders.status, waybillState),
    loadQueueOptions(db),
  ]);

  const counts: Record<QueueTab, number> = { queue: 0, waybill_created: 0, awaiting_picking: 0, packed: 0, needs_waybill: 0 };
  for (const r of countRows) {
    const n = Number(r.c);
    if (r.status === "awaiting_review") {
      if (r.waybill === "none") counts.needs_waybill += n;
    } else if (r.status === "waybill_created" || r.status === "awaiting_picking" || r.status === "packed") {
      if (r.waybill === "created") {
        counts[r.status] += n;
        counts.queue += n;
      } else {
        counts.needs_waybill += n;
      }
    }
  }

  const ids = rows.map((r) => r.id);
  const lineRows = ids.length
    ? await db
        .select({
          id: orderLineItems.id,
          orderId: orderLineItems.orderId,
          title: orderLineItems.title,
          variantTitle: orderLineItems.variantTitle,
          sku: orderLineItems.sku,
          quantity: orderLineItems.quantity,
          currentQuantity: orderLineItems.currentQuantity,
          lineImage: orderLineItems.imageUrl,
          variantId: productVariants.id,
          vTitle: productVariants.title,
          vSku: productVariants.sku,
          model: productVariants.model,
          color: productVariants.color,
          vImage: productVariants.imageUrl,
          productTitle: products.title,
          productImage: products.imageUrl,
        })
        .from(orderLineItems)
        .leftJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
        .leftJoin(products, eq(products.id, productVariants.productId))
        .where(inArray(orderLineItems.orderId, ids))
        .orderBy(asc(orderLineItems.orderId), asc(orderLineItems.position))
    : [];

  return {
    rows: rows.map((r) => {
      const own = lineRows.filter((l) => l.orderId === r.id);
      const lines: QueueLine[] = own
        .map((l) => ({
          id: l.id,
          title: l.productTitle ?? l.title,
          variantTitle: l.vTitle ?? l.variantTitle,
          sku: l.vSku ?? l.sku,
          model: l.model,
          color: l.color,
          imageUrl: l.vImage ?? l.productImage ?? l.lineImage,
          quantity: effectiveLineQuantity(l),
          variantId: l.variantId,
        }))
        .filter((l) => l.quantity > 0)
        .map(({ variantId: _v, ...rest }) => rest);
      const checklistLines = own
        .filter((l) => l.variantId)
        .map((l) => ({ id: l.id, variantId: l.variantId, sku: null, barcode: null, required: effectiveLineQuantity(l) }));
      const progress = r.packingId ? checklistProgress(checklistLines, (r.checklist ?? {}) as Checklist) : null;
      const adapter = r.carrierCode ? ctx.carriers.get(r.carrierCode) : undefined;
      const shipment =
        r.shipmentId && r.shipmentStatus && r.carrierCode && r.carrierReference !== null
          ? {
              carrierCode: r.carrierCode,
              status: r.shipmentStatus,
              waybillNumber: r.waybillNumber,
              carrierShipmentId: r.carrierShipmentId,
              carrierReference: r.carrierReference,
            }
          : null;
      return {
        id: r.id,
        orderNumber: r.orderNumber,
        status: r.status,
        priority: r.priority as OrderPriority,
        placedAt: r.placedAt,
        countryCode: r.countryCode?.trim().toUpperCase() || null,
        city: showCity ? r.city : null,
        source: r.source,
        units: lines.reduce((s, l) => s + l.quantity, 0),
        lines,
        waybill: shipment
          ? {
              status: shipment.status,
              number: shipment.waybillNumber,
              carrierName: adapter?.displayName ?? shipment.carrierCode,
              testMode: r.mode === "test",
              labelAvailable: availableDocumentKinds(ctx, shipment).includes("label"),
              packable: isPackableShipment({ ...shipment, handedOverAt: r.handedOverAt, trackingStatus: r.trackingStatus }),
              deletedAtCarrier: isDeletedAtCarrier({ status: shipment.status, handedOverAt: r.handedOverAt, trackingStatus: r.trackingStatus }),
            }
          : null,
        // Рядки черги — лише незавершені замовлення, тож позначка діє (shopifyLinesPending у pending-lines.server).
        shopifyLinesPending: r.shopifyLinesPendingAt !== null,
        packing:
          r.packingId && r.packingStatus && progress
            ? {
                status: r.packingStatus,
                startedBy: r.startedBy,
                startedByName: r.startedByName,
                startedAt: r.startedAt,
                packedBy: r.packedBy,
                packedByName: r.packedByName,
                packedAt: r.packedAt,
                packedUnits: progress.packedUnits,
                requiredUnits: progress.requiredUnits,
                complete: progress.complete,
              }
            : null,
      };
    }),
    total,
    page,
    pageSize,
    pages,
    counts,
    options,
  };
}

/** Значення для фільтрів (з замовлень черги й «Потрібна накладна»). */
export async function loadQueueOptions(db: DbOrTx): Promise<QueueOptions> {
  const scope = inArray(orders.status, QUEUE_SCOPE_STATUSES);
  const [countries, models, colors, starters, packers] = await Promise.all([
    db
      .selectDistinct({ v: orders.shipCountryCode })
      .from(orders)
      .where(and(scope, isNotNull(orders.shipCountryCode)))
      .orderBy(asc(orders.shipCountryCode))
      .limit(OPTIONS_LIMIT),
    db
      .selectDistinct({ v: productVariants.model })
      .from(orderLineItems)
      .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
      .innerJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
      .where(and(scope, isNotNull(productVariants.model)))
      .orderBy(asc(productVariants.model))
      .limit(OPTIONS_LIMIT),
    db
      .selectDistinct({ v: productVariants.color })
      .from(orderLineItems)
      .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
      .innerJoin(productVariants, eq(productVariants.id, orderLineItems.variantId))
      .where(and(scope, isNotNull(productVariants.color)))
      .orderBy(asc(productVariants.color))
      .limit(OPTIONS_LIMIT),
    db
      .selectDistinct({ id: orderPacking.startedBy, name: orderPacking.startedByName })
      .from(orderPacking)
      .innerJoin(orders, eq(orders.id, orderPacking.orderId))
      .where(and(scope, inArray(orderPacking.status, [...ACTIVE_PACKING_STATUSES]), isNotNull(orderPacking.startedBy)))
      .limit(OPTIONS_LIMIT),
    db
      .selectDistinct({ id: orderPacking.packedBy, name: orderPacking.packedByName })
      .from(orderPacking)
      .innerJoin(orders, eq(orders.id, orderPacking.orderId))
      .where(and(scope, inArray(orderPacking.status, [...ACTIVE_PACKING_STATUSES]), isNotNull(orderPacking.packedBy)))
      .limit(OPTIONS_LIMIT),
  ]);
  const workers = new Map<string, string>();
  for (const w of [...starters, ...packers]) if (w.id && !workers.has(w.id)) workers.set(w.id, w.name ?? w.id);
  const clean = (rows: Array<{ v: string | null }>) => [...new Set(rows.map((r) => r.v?.trim() ?? "").filter(Boolean))];
  return {
    countries: clean(countries).map((c) => c.toUpperCase()),
    models: clean(models),
    colors: clean(colors),
    workers: [...workers.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Кількість замовлень у черзі пакування (для дашборду/меню): статуси черги з активною створеною накладною. */
export async function countPackingQueue(db: DbOrTx): Promise<number> {
  const [row] = await db
    .select({ c: count() })
    .from(orders)
    .innerJoin(shipments, activeShipmentJoin)
    .where(and(inArray(orders.status, [...PACKING_QUEUE_STATUSES]), hasCreatedWaybill));
  return Number(row?.c ?? 0);
}

/** Замовлення з переліку, відсортовані як у черзі (пріоритет ↓, дата ↑) — для пакетного друку/етикеток. */
export async function sortOrderIdsLikeQueue(db: DbOrTx, orderIds: readonly string[]): Promise<Array<{ id: string; orderNumber: string; status: OrderStatus }>> {
  if (orderIds.length === 0) return [];
  return db
    .select({ id: orders.id, orderNumber: orders.orderNumber, status: orders.status })
    .from(orders)
    .where(inArray(orders.id, [...orderIds]))
    .orderBy(desc(orders.priority), asc(orders.placedAt), asc(orders.id));
}

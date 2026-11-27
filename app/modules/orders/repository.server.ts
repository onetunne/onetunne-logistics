import { effectiveVariant, type OverrideField } from "~/modules/products/customs-overrides";
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import {
  countryRules,
  issues,
  orderChanges,
  orderLineItems,
  orders,
  productVariants,
  products,
  shipmentEvents,
  shipments,
} from "~/db/schema";
import { ORDER_STATUSES, type OrderStatus } from "~/domain/order-status";
import { NotFoundError } from "~/lib/errors";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { buildCountryRuleMap } from "~/modules/validation";
import type { AddressInput, CountryRule, CountryRules, OrderValidationInput } from "~/modules/validation/types";

export type OrderRow = typeof orders.$inferSelect;
export type LineItemRow = typeof orderLineItems.$inferSelect;
export type VariantRow = typeof productVariants.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type ShipmentRow = typeof shipments.$inferSelect;
export type ShipmentEventRow = typeof shipmentEvents.$inferSelect;
export type OrderChangeRow = typeof orderChanges.$inferSelect;

export interface LineItemWithVariant extends LineItemRow {
  /** Ефективні значення варіанта: митні дані/вага/габарити, змінені в застосунку, мають пріоритет над Shopify. */
  variant: (VariantRow & { productTitle: string; productImageUrl: string | null; overriddenFields: OverrideField[] }) | null;
}

export interface OrderAggregate {
  order: OrderRow;
  items: LineItemWithVariant[];
  openIssues: IssueRow[];
  shipments: ShipmentRow[];
}

/** Поля адреси доставки у вигляді, який очікує валідатор. */
export function shippingAddressOf(order: OrderRow): AddressInput {
  return {
    firstName: order.shipFirstName,
    lastName: order.shipLastName,
    company: order.shipCompany,
    address1: order.shipAddress1,
    address2: order.shipAddress2,
    city: order.shipCity,
    province: order.shipProvince,
    postalCode: order.shipPostalCode,
    countryCode: order.shipCountryCode,
    phone: order.shipPhone,
  };
}

/** Відповідність полів адреси колонкам таблиці orders. */
export const SHIPPING_COLUMN: Record<keyof AddressInput, keyof OrderRow> = {
  firstName: "shipFirstName",
  lastName: "shipLastName",
  company: "shipCompany",
  address1: "shipAddress1",
  address2: "shipAddress2",
  city: "shipCity",
  province: "shipProvince",
  postalCode: "shipPostalCode",
  countryCode: "shipCountryCode",
  phone: "shipPhone",
};

export async function loadLineItems(db: DbOrTx, orderId: string): Promise<LineItemWithVariant[]> {
  const rows = await db
    .select({ item: orderLineItems, variant: productVariants, product: products })
    .from(orderLineItems)
    .leftJoin(productVariants, eq(orderLineItems.variantId, productVariants.id))
    .leftJoin(products, eq(productVariants.productId, products.id))
    .where(eq(orderLineItems.orderId, orderId))
    .orderBy(asc(orderLineItems.position));
  return rows.map(({ item, variant, product }) => ({
    ...item,
    variant: variant
      ? { ...effectiveVariant(variant), productTitle: product?.title ?? item.title, productImageUrl: product?.imageUrl ?? null }
      : null,
  }));
}

/**
 * Завантажує замовлення; з `forUpdate` — блокує рядок до кінця транзакції (контроль одночасної обробки).
 * Блокування FOR NO KEY UPDATE (як у звичайного UPDATE): одночасні зміни замовлення виключені, але вставки
 * пов'язаних рядків іншими транзакціями (перевірка зовнішнього ключа — KEY SHARE, напр. рухи/резерви складу в
 * initializeInventory) не блокуються → без взаємоблокувань «замовлення ↔ склад».
 */
export async function loadOrderRow(db: DbOrTx, orderId: string, opts: { forUpdate?: boolean } = {}): Promise<OrderRow> {
  const query = db.select().from(orders).where(eq(orders.id, orderId));
  const [row] = opts.forUpdate ? await query.for("no key update") : await query;
  if (!row) throw new NotFoundError("order");
  return row;
}

export async function loadOrderAggregate(
  db: DbOrTx,
  orderId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<OrderAggregate> {
  const order = await loadOrderRow(db, orderId, opts);
  const [items, openIssues, orderShipments] = await Promise.all([
    loadLineItems(db, orderId),
    db
      .select()
      .from(issues)
      .where(and(eq(issues.orderId, orderId), eq(issues.status, "open")))
      .orderBy(asc(issues.createdAt)),
    db.select().from(shipments).where(eq(shipments.orderId, orderId)).orderBy(desc(shipments.createdAt)),
  ]);
  return { order, items, openIssues, shipments: orderShipments };
}

export async function loadOrderHistory(db: DbOrTx, orderId: string) {
  const [changes, events, resolvedIssues] = await Promise.all([
    db.select().from(orderChanges).where(eq(orderChanges.orderId, orderId)).orderBy(desc(orderChanges.createdAt)),
    db
      .select({ event: shipmentEvents, waybillNumber: shipments.waybillNumber })
      .from(shipmentEvents)
      .innerJoin(shipments, eq(shipmentEvents.shipmentId, shipments.id))
      .where(eq(shipments.orderId, orderId))
      .orderBy(desc(shipmentEvents.createdAt)),
    db
      .select()
      .from(issues)
      .where(and(eq(issues.orderId, orderId), inArray(issues.status, ["resolved", "dismissed"])))
      .orderBy(desc(issues.resolvedAt)),
  ]);
  return { changes, events, resolvedIssues };
}

export function toValidationInput(agg: Pick<OrderAggregate, "order" | "items">): OrderValidationInput {
  return {
    orderId: agg.order.id,
    email: agg.order.email,
    contactPhone: agg.order.contactPhone,
    shipping: shippingAddressOf(agg.order),
    // Етап 5: перевіряються лише одиниці, що відправляються (effectiveLineQuantity — Shopify currentQuantity), ті
    // самі, що пакуються, зважуються й декларуються в накладній. Повністю повернені/видалені позиції не перевіряються;
    // замовлення без жодної такої позиції (повністю повернене, але не скасоване) — ORDER_NO_ITEMS, що блокує накладну:
    // інакше запит до перевізника пішов би з порожньою посилкою.
    items: agg.items
      .filter((item) => effectiveLineQuantity(item) > 0)
      .map((item) => ({
        lineItemId: item.id,
        title: item.title,
        quantity: effectiveLineQuantity(item),
        unitPrice: item.unitPrice,
        variant: item.variant
          ? {
              variantId: item.variant.id,
              sku: item.variant.sku,
              weightGrams: item.variant.weightGrams,
              hsCode: item.variant.hsCode,
              countryOfOrigin: item.variant.countryOfOrigin,
              customsDescription: item.variant.customsDescription,
            }
          : null,
      })),
  };
}

export async function loadCountryRuleRows(db: DbOrTx): Promise<(typeof countryRules.$inferSelect)[]> {
  return db.select().from(countryRules).orderBy(asc(countryRules.countryCode));
}

export async function loadCountryRules(db: DbOrTx): Promise<CountryRules> {
  const rows = await loadCountryRuleRows(db);
  return buildCountryRuleMap(
    rows.map(
      (r): CountryRule => ({
        countryCode: r.countryCode,
        nameEn: r.nameEn,
        nameUk: r.nameUk,
        shippingEnabled: r.shippingEnabled,
        postalCodeRequired: r.postalCodeRequired,
        postalCodePattern: r.postalCodePattern,
        postalCodeExample: r.postalCodeExample,
        provinceRequired: r.provinceRequired,
        phoneRequired: r.phoneRequired,
      }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Списки
// ---------------------------------------------------------------------------

export interface OrderListFilter {
  status?: OrderStatus | null;
  q?: string | null;
  country?: string | null;
  withProblems?: boolean;
  page?: number;
  pageSize?: number;
}

export interface OrderListRow {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  placedAt: Date;
  customerName: string;
  countryCode: string | null;
  city: string | null;
  total: string;
  currency: string;
  itemCount: number;
  openIssueCount: number;
  openErrorCount: number;
  waybillNumber: string | null;
  automationPaused: boolean;
  source: "demo" | "shopify";
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export async function listOrders(
  db: DbOrTx,
  filter: OrderListFilter = {},
): Promise<{ rows: OrderListRow[]; total: number; page: number; pageSize: number }> {
  const pageSize = Math.min(Math.max(filter.pageSize ?? 25, 1), 100);
  const page = Math.max(filter.page ?? 1, 1);
  const conditions: SQL[] = [];
  if (filter.status) conditions.push(eq(orders.status, filter.status));
  if (filter.country) conditions.push(eq(orders.shipCountryCode, filter.country.toUpperCase()));
  const q = filter.q?.trim();
  if (q) {
    const like = `%${escapeLike(q)}%`;
    conditions.push(
      or(
        ilike(orders.orderNumber, like),
        ilike(orders.shipFirstName, like),
        ilike(orders.shipLastName, like),
        ilike(orders.shipCity, like),
        ilike(orders.email, like),
      )!,
    );
  }
  // Підзапити з явними іменами таблиць: у SELECT Drizzle підставляє колонки без кваліфікатора таблиці.
  const openIssueCount = sql<number>`(select count(*)::int from "issues" i where i."order_id" = "orders"."id" and i."status" = 'open')`;
  const openErrorCount = sql<number>`(select count(*)::int from "issues" i where i."order_id" = "orders"."id" and i."status" = 'open' and i."severity" = 'error')`;
  if (filter.withProblems) conditions.push(sql`${openIssueCount} > 0`);
  const where = conditions.length ? and(...conditions) : undefined;

  const [totalRow] = await db.select({ value: count() }).from(orders).where(where);
  const rows = await db
    .select({
      id: orders.id,
      orderNumber: orders.orderNumber,
      status: orders.status,
      placedAt: orders.placedAt,
      firstName: orders.shipFirstName,
      lastName: orders.shipLastName,
      countryCode: orders.shipCountryCode,
      city: orders.shipCity,
      total: orders.total,
      currency: orders.currency,
      automationPaused: orders.automationPaused,
      source: orders.source,
      itemCount: sql<number>`(select coalesce(sum(li."quantity"), 0)::int from "order_line_items" li where li."order_id" = "orders"."id")`,
      openIssueCount,
      openErrorCount,
      waybillNumber: sql<
        string | null
      >`(select s."waybill_number" from "shipments" s where s."order_id" = "orders"."id" and s."status" = 'created' order by s."created_at" desc limit 1)`,
    })
    .from(orders)
    .where(where)
    .orderBy(desc(orders.placedAt), desc(orders.orderNumber))
    .limit(pageSize)
    .offset((page - 1) * pageSize);

  return {
    rows: rows.map((r) => ({
      id: r.id,
      orderNumber: r.orderNumber,
      status: r.status,
      placedAt: r.placedAt,
      customerName: [r.firstName, r.lastName].filter(Boolean).join(" "),
      countryCode: r.countryCode,
      city: r.city,
      total: r.total,
      currency: r.currency,
      itemCount: Number(r.itemCount),
      openIssueCount: Number(r.openIssueCount),
      openErrorCount: Number(r.openErrorCount),
      waybillNumber: r.waybillNumber,
      automationPaused: r.automationPaused,
      source: r.source,
    })),
    total: Number(totalRow?.value ?? 0),
    page,
    pageSize,
  };
}

export async function countOrdersByStatus(db: DbOrTx): Promise<Record<OrderStatus, number>> {
  const rows = await db.select({ status: orders.status, value: count() }).from(orders).groupBy(orders.status);
  const out = Object.fromEntries(ORDER_STATUSES.map((s) => [s, 0])) as Record<OrderStatus, number>;
  for (const r of rows) out[r.status] = Number(r.value);
  return out;
}

export interface OpenIssueListRow {
  issue: IssueRow;
  orderId: string | null;
  orderNumber: string | null;
  orderStatus: OrderStatus | null;
  countryCode: string | null;
}

export async function listIssues(
  db: DbOrTx,
  filter: { status?: "open" | "resolved" | "dismissed"; severity?: "error" | "warning" | null; code?: string | null; limit?: number } = {},
): Promise<OpenIssueListRow[]> {
  const conditions: SQL[] = [eq(issues.status, filter.status ?? "open")];
  if (filter.severity) conditions.push(eq(issues.severity, filter.severity));
  if (filter.code) conditions.push(eq(issues.code, filter.code));
  const rows = await db
    .select({
      issue: issues,
      orderId: orders.id,
      orderNumber: orders.orderNumber,
      orderStatus: orders.status,
      countryCode: orders.shipCountryCode,
    })
    .from(issues)
    .leftJoin(orders, eq(issues.orderId, orders.id))
    .where(and(...conditions))
    .orderBy(filter.status === "open" || !filter.status ? asc(issues.createdAt) : desc(issues.resolvedAt))
    .limit(Math.min(filter.limit ?? 200, 500));
  return rows;
}

export async function countOpenIssues(db: DbOrTx): Promise<{ total: number; errors: number; warnings: number; orders: number }> {
  const [row] = await db
    .select({
      total: count(),
      errors: sql<number>`count(*) filter (where ${issues.severity} = 'error')::int`,
      warnings: sql<number>`count(*) filter (where ${issues.severity} = 'warning')::int`,
      orders: sql<number>`count(distinct ${issues.orderId})::int`,
    })
    .from(issues)
    .where(eq(issues.status, "open"));
  return {
    total: Number(row?.total ?? 0),
    errors: Number(row?.errors ?? 0),
    warnings: Number(row?.warnings ?? 0),
    orders: Number(row?.orders ?? 0),
  };
}

export async function listShipments(db: DbOrTx, opts: { limit?: number } = {}) {
  return db
    .select({ shipment: shipments, orderNumber: orders.orderNumber, orderStatus: orders.status, countryCode: orders.shipCountryCode })
    .from(shipments)
    .innerJoin(orders, eq(shipments.orderId, orders.id))
    .orderBy(desc(shipments.createdAt))
    .limit(Math.min(opts.limit ?? 100, 500));
}

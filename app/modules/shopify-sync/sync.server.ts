/**
 * Синхронізація з Shopify. Shopify — основне джерело замовлень, товарів і залишків.
 * Webhook лише ставить завдання в чергу; завдання завжди перечитує свіжі дані через GraphQL Admin API,
 * тож порядок і повтори подій не призводять до неузгодженості.
 */
import { and, desc, eq, inArray, like, notLike, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import { issues, jobs, orderChanges, orderLineItems, orders, productVariants, products, shipments, shopInstallations } from "~/db/schema";
import { isShipped } from "~/domain/order-status";
import { SYSTEM_ACTOR, requirePermission } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { loadOrderRow, shippingAddressOf, type OrderRow } from "~/modules/orders/repository.server";
import { VALIDATABLE_STATUSES, validateOrderInTx } from "~/modules/orders/workflow.server";
import { cancelOrder, processPaidOrder } from "~/modules/shipments/waybill.server";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { ShopifyGateway, ShopifySyncResult } from "~/integrations/shopify/types";
import {
  INVENTORY_ITEM_PRODUCT_QUERY,
  ORDER_QUERY,
  ORDER_UPDATE_MUTATION,
  SHOP_SHIPPING_COUNTRIES_QUERY,
  ORDER_ADDRESS_STATE_QUERY,
  ORDERS_PAGE_QUERY,
  PRODUCT_QUERY,
  PRODUCTS_PAGE_QUERY,
  type GqlOrder,
  type GqlProduct,
  type PageInfo,
} from "~/integrations/shopify/graphql";
import type { ServiceContext } from "~/server/types";
import { initialStatus, isPaid, mapOrder, mapProduct, type MappedOrder, type MappedProduct } from "./mappers";
import {
  DIAGNOSTIC_VARIANTS,
  describeOrderUpdateInput,
  inputVariant,
  phoneFormat,
  valueShape,
  type DiagnosticVariant,
  type OrderUpdateInputLike,
} from "./diagnostics";
import { logger } from "~/lib/logger.server";

/** Версія GraphQL Admin API (та сама, що в shopify.server.ts). */
const SHOPIFY_API_VERSION = "2026-10";

export const JOB = {
  syncOrder: "shopify.sync_order",
  syncProduct: "shopify.sync_product",
  syncInventoryItem: "shopify.sync_inventory_item",
  deleteProduct: "shopify.delete_product",
  productsPage: "shopify.products_page",
  importOrdersPage: "shopify.import_orders_page",
  pushOrder: "shopify.push_order",
  /** Етап 3: виконання замовлення з трек-номером після передачі перевізнику. */
  fulfillShipment: "shopify.fulfill_shipment",
  /** Етап 3: періодичне опитування відстеження перевізників. */
  trackingPoll: "tracking.poll",
} as const;

/** Сторінка списку: невелика, щоб запитувана вартість GraphQL не перевищувала ліміт. */
const PAGE_SIZE = 10;

// ---------------------------------------------------------------------------
// Товари
// ---------------------------------------------------------------------------

export async function upsertProduct(db: DbOrTx, p: MappedProduct, currency: string): Promise<"saved" | "stale"> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(products).where(eq(products.shopifyProductId, p.shopifyProductId)).for("update");
    if (existing?.shopifyUpdatedAt && existing.shopifyUpdatedAt > p.shopifyUpdatedAt) return "stale";
    const values = {
      title: p.title,
      handle: p.handle,
      imageUrl: p.imageUrl,
      status: p.status,
      shopifyUpdatedAt: p.shopifyUpdatedAt,
      updatedAt: new Date(),
    };
    let productId: string;
    if (existing) {
      await tx.update(products).set(values).where(eq(products.id, existing.id));
      productId = existing.id;
    } else {
      const [row] = await tx.insert(products).values({ ...values, shopifyProductId: p.shopifyProductId }).returning({ id: products.id });
      productId = row!.id;
    }
    for (const v of p.variants) {
      const data = { ...v, productId, currency, updatedAt: new Date() };
      await tx
        .insert(productVariants)
        .values(data)
        .onConflictDoUpdate({ target: productVariants.shopifyVariantId, set: data });
    }
    return "saved";
  });
}

export async function syncProduct(db: Db, admin: AdminGraphql, productGid: string, currency: string) {
  const data = await admin<{ product: GqlProduct | null }>(PRODUCT_QUERY, { id: productGid });
  if (!data.product) {
    await markProductDeleted(db, productGid);
    return "deleted" as const;
  }
  return upsertProduct(db, mapProduct(data.product), currency);
}

export async function markProductDeleted(db: DbOrTx, productGid: string) {
  await db.update(products).set({ status: "DELETED", updatedAt: new Date() }).where(eq(products.shopifyProductId, productGid));
}

/** Сторінка повної синхронізації товарів; наступна сторінка — окреме завдання (продовжується після перезапуску). */
export async function syncProductsPage(db: Db, admin: AdminGraphql, shop: string, after: string | null, currency: string) {
  const data = await admin<{ products: { pageInfo: PageInfo; nodes: GqlProduct[] } }>(PRODUCTS_PAGE_QUERY, {
    first: PAGE_SIZE,
    after,
  });
  for (const p of data.products.nodes) {
    // Товар із великою кількістю варіантів перечитується окремо (повний список варіантів).
    if (p.variants.pageInfo?.hasNextPage) await syncProduct(db, admin, p.id, currency);
    else await upsertProduct(db, mapProduct(p), currency);
  }
  if (data.products.pageInfo.hasNextPage && data.products.pageInfo.endCursor) {
    await enqueueJob(db, JOB.productsPage, { shop, after: data.products.pageInfo.endCursor }, { dedupeKey: `products:${data.products.pageInfo.endCursor}` });
  } else {
    await db.update(shopInstallations).set({ productsSyncedAt: new Date(), updatedAt: new Date() }).where(eq(shopInstallations.shop, shop));
  }
  return data.products.nodes.length;
}

export async function syncInventoryItem(db: Db, admin: AdminGraphql, shop: string, inventoryItemGid: string) {
  const data = await admin<{ inventoryItem: { variant: { product: { id: string } | null } | null } | null }>(
    INVENTORY_ITEM_PRODUCT_QUERY,
    { id: inventoryItemGid },
  );
  const productGid = data.inventoryItem?.variant?.product?.id;
  if (productGid) await enqueueJob(db, JOB.syncProduct, { shop, productGid }, { dedupeKey: `product:${productGid}` });
}

// ---------------------------------------------------------------------------
// Замовлення
// ---------------------------------------------------------------------------

export type OrderSyncResult =
  | "created"
  | "updated"
  | "unchanged"
  | "stale"
  | "skipped_unpaid"
  | "cancelled"
  | "conflict_reported";

const CONTACT_FIELDS: Array<{ field: string; column: keyof OrderRow; get: (o: MappedOrder) => string | null }> = [
  { field: "email", column: "email", get: (o) => o.email },
  { field: "contactPhone", column: "contactPhone", get: (o) => o.contactPhone },
  { field: "shipping.firstName", column: "shipFirstName", get: (o) => o.shipping.firstName },
  { field: "shipping.lastName", column: "shipLastName", get: (o) => o.shipping.lastName },
  { field: "shipping.company", column: "shipCompany", get: (o) => o.shipping.company },
  { field: "shipping.address1", column: "shipAddress1", get: (o) => o.shipping.address1 },
  { field: "shipping.address2", column: "shipAddress2", get: (o) => o.shipping.address2 },
  { field: "shipping.city", column: "shipCity", get: (o) => o.shipping.city },
  { field: "shipping.province", column: "shipProvince", get: (o) => o.shipping.province },
  { field: "shipping.postalCode", column: "shipPostalCode", get: (o) => o.shipping.postalCode },
  { field: "shipping.countryCode", column: "shipCountryCode", get: (o) => o.shipping.countryCode },
  { field: "shipping.phone", column: "shipPhone", get: (o) => o.shipping.phone },
];

async function resolveVariantIds(tx: DbOrTx, m: MappedOrder): Promise<Map<string, string>> {
  const gids = m.lineItems.map((l) => l.shopifyVariantId).filter((g): g is string => Boolean(g));
  if (gids.length === 0) return new Map();
  const rows = await tx
    .select({ id: productVariants.id, gid: productVariants.shopifyVariantId })
    .from(productVariants)
    .where(inArray(productVariants.shopifyVariantId, gids));
  return new Map(rows.map((r) => [r.gid!, r.id]));
}

async function replaceLineItems(tx: DbOrTx, orderId: string, m: MappedOrder) {
  const variantIds = await resolveVariantIds(tx, m);
  await tx.delete(orderLineItems).where(eq(orderLineItems.orderId, orderId));
  if (m.lineItems.length === 0) return;
  await tx.insert(orderLineItems).values(
    m.lineItems.map((l, position) => ({
      orderId,
      variantId: l.shopifyVariantId ? (variantIds.get(l.shopifyVariantId) ?? null) : null,
      shopifyLineItemId: l.shopifyLineItemId,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      currency: l.currency,
      imageUrl: l.imageUrl,
      position,
    })),
  );
}

async function hasPendingPush(tx: DbOrTx, shopifyOrderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.type, JOB.pushOrder), eq(jobs.dedupeKey, `push:${shopifyOrderId}`), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return Boolean(row);
}

async function hasActiveShipment(tx: DbOrTx, orderId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: shipments.id })
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), inArray(shipments.status, ["creating", "created", "unknown"])))
    .limit(1);
  return Boolean(row);
}

async function openSyncIssue(
  tx: DbOrTx,
  orderId: string,
  code: "SHOPIFY_ORDER_CHANGED" | "SHOPIFY_SYNC_FAILED" | "SHOPIFY_CANCELLED_AFTER_SHIPMENT" | "SHOPIFY_COUNTRY_NOT_SHIPPED",
  params: Record<string, string | number>,
  field: string | null = null,
) {
  const fingerprint = `${orderId}:${code}:${field ?? ""}`;
  const [existing] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.fingerprint, fingerprint), eq(issues.status, "open")));
  if (existing) {
    await tx.update(issues).set({ params, updatedAt: new Date() }).where(eq(issues.id, existing.id));
    return;
  }
  await tx.insert(issues).values({
    orderId,
    code,
    severity: code === "SHOPIFY_ORDER_CHANGED" ? "warning" : "error",
    field,
    params,
    fingerprint,
  });
}

/**
 * Застосовує дані замовлення з Shopify.
 * - Нове неоплачене замовлення не створюється (обробляються лише оплачені).
 * - Застарілі події (updatedAt старіший за збережений) ігноруються.
 * - Контакти/адреса оновлюються лише поки замовлення можна редагувати і немає неперенесених
 *   у Shopify локальних підтверджених змін; інакше — проблема «дані змінено в Shopify».
 */
export async function upsertOrder(
  ctx: ServiceContext,
  m: MappedOrder,
  mode: "live" | "import",
): Promise<{ result: OrderSyncResult; orderId: string | null }> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(orders).where(eq(orders.shopifyOrderId, m.shopifyOrderId)).for("update");
    const common = {
      financialStatus: m.financialStatus,
      fulfillmentStatus: m.fulfillmentStatus,
      currency: m.currency,
      subtotal: m.subtotal,
      shippingPaid: m.shippingPaid,
      total: m.total,
      billingCountryCode: m.billingCountryCode,
      shopifyUpdatedAt: m.shopifyUpdatedAt,
    };

    if (!existing) {
      if (!isPaid({ displayFinancialStatus: m.financialStatus.toUpperCase() }) && !m.cancelledAt) {
        return { result: "skipped_unpaid" as const, orderId: null, process: false };
      }
      const status = initialStatus(m, mode);
      const [row] = await tx
        .insert(orders)
        .values({
          ...common,
          source: "shopify",
          shopifyOrderId: m.shopifyOrderId,
          orderNumber: m.orderNumber,
          status,
          email: m.email,
          contactPhone: m.contactPhone,
          shipFirstName: m.shipping.firstName,
          shipLastName: m.shipping.lastName,
          shipCompany: m.shipping.company,
          shipAddress1: m.shipping.address1,
          shipAddress2: m.shipping.address2,
          shipCity: m.shipping.city,
          shipProvince: m.shipping.province,
          shipPostalCode: m.shipping.postalCode,
          shipCountryCode: m.shipping.countryCode,
          shipPhone: m.shipping.phone,
          note: m.note,
          placedAt: m.placedAt,
          cancelledAt: m.cancelledAt,
        })
        .returning({ id: orders.id });
      await replaceLineItems(tx, row!.id, m);
      await writeAudit(tx, SYSTEM_ACTOR, mode === "import" ? "shopify.order_imported" : "shopify.order_received", {
        type: "order",
        id: row!.id,
      }, { status, test: m.test });
      return { result: "created" as const, orderId: row!.id, process: mode === "live" && status === "paid" };
    }

    if (existing.shopifyUpdatedAt && existing.shopifyUpdatedAt > m.shopifyUpdatedAt) {
      return { result: "stale" as const, orderId: existing.id, process: false };
    }
    await tx.update(orders).set({ ...common, updatedAt: new Date() }).where(eq(orders.id, existing.id));

    if (m.cancelledAt && existing.status !== "cancelled") {
      return { result: "cancelled" as const, orderId: existing.id, process: false, cancel: true };
    }

    const changes = CONTACT_FIELDS.map((f) => ({ ...f, from: (existing[f.column] as string | null) ?? null, to: f.get(m) })).filter(
      (c) => c.from !== c.to,
    );
    if (changes.length === 0) return { result: "unchanged" as const, orderId: existing.id, process: false };

    const editable =
      VALIDATABLE_STATUSES.includes(existing.status) &&
      !(await hasActiveShipment(tx, existing.id)) &&
      !(await hasPendingPush(tx, m.shopifyOrderId));
    if (!editable) {
      await openSyncIssue(tx, existing.id, "SHOPIFY_ORDER_CHANGED", { fields: changes.map((c) => c.field).join(", ") });
      return { result: "conflict_reported" as const, orderId: existing.id, process: false };
    }
    const patch: Record<string, string | null> = {};
    for (const c of changes) patch[c.column as string] = c.to;
    await tx
      .update(orders)
      .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: new Date() })
      .where(eq(orders.id, existing.id));
    await tx.insert(orderChanges).values(
      changes.map((c) => ({
        orderId: existing.id,
        field: c.field,
        oldValue: c.from,
        newValue: c.to,
        source: "shopify_sync" as const,
        reason: "shopify.updated",
        actorId: SYSTEM_ACTOR.id,
      })),
    );
    await replaceLineItems(tx, existing.id, m);
    // Якщо замовлення вже перевірялося — перевіряємо повторно з новими даними.
    if (existing.status !== "paid") await validateOrderInTx(tx, { ...ctx, actor: SYSTEM_ACTOR }, existing.id, "after_edit");
    return { result: "updated" as const, orderId: existing.id, process: false };
  });

  const systemCtx: ServiceContext = { ...ctx, actor: SYSTEM_ACTOR };
  if ("cancel" in outcome && outcome.cancel && outcome.orderId) {
    const order = await loadOrderRow(ctx.db, outcome.orderId);
    try {
      if (isShipped(order.status)) throw new DomainError("order.alreadyShipped", 409);
      await cancelOrder(systemCtx, outcome.orderId);
    } catch (e) {
      // Скасування після відправлення або з накладною на розгляді — потрібне рішення менеджера.
      await openSyncIssue(ctx.db, outcome.orderId, "SHOPIFY_CANCELLED_AFTER_SHIPMENT", {
        reason: e instanceof DomainError ? e.code : "error.generic",
      });
      return { result: "conflict_reported", orderId: outcome.orderId };
    }
  }
  if (outcome.process && outcome.orderId) await processPaidOrder(systemCtx, outcome.orderId);
  return { result: outcome.result, orderId: outcome.orderId };
}

/** Перечитує замовлення з Shopify і застосовує. Невідомі варіанти спершу синхронізуються як товари. */
export async function syncOrder(ctx: ServiceContext, admin: AdminGraphql, orderGid: string, mode: "live" | "import") {
  const data = await admin<{ order: GqlOrder | null }>(ORDER_QUERY, { id: orderGid });
  if (!data.order) return { result: "unchanged" as const, orderId: null };
  return applyOrder(ctx, admin, data.order, mode);
}

async function applyOrder(ctx: ServiceContext, admin: AdminGraphql, order: GqlOrder, mode: "live" | "import") {
  if (order.lineItems.pageInfo?.hasNextPage) {
    // На сторінці списку не всі позиції — перечитуємо замовлення повністю.
    const full = await admin<{ order: GqlOrder | null }>(ORDER_QUERY, { id: order.id });
    if (full.order && !full.order.lineItems.pageInfo?.hasNextPage) order = full.order;
    else throw new DomainError("shopify.tooManyLineItems", 422, { order: order.name });
  }
  const m = mapOrder(order);
  const known = await resolveVariantIds(ctx.db, m);
  const missingProducts = new Set(
    m.lineItems.filter((l) => l.shopifyVariantId && !known.has(l.shopifyVariantId) && l.shopifyProductId).map((l) => l.shopifyProductId!),
  );
  for (const gid of missingProducts) await syncProduct(ctx.db, admin, gid, m.currency);
  return upsertOrder(ctx, m, mode);
}

/** Сторінка імпорту старих замовлень (з дати `since`). Прогрес — у shop_installations.import_state. */
export async function importOrdersPage(
  ctx: ServiceContext,
  admin: AdminGraphql,
  payload: { shop: string; since: string; after?: string | null; imported?: number; skipped?: number; updated?: number; failed?: string[] },
) {
  const data = await admin<{ orders: { pageInfo: PageInfo; nodes: GqlOrder[] } }>(ORDERS_PAGE_QUERY, {
    first: PAGE_SIZE,
    after: payload.after ?? null,
    query: `created_at:>=${payload.since}`,
  });
  let imported = payload.imported ?? 0;
  let skipped = payload.skipped ?? 0;
  let updated = payload.updated ?? 0;
  const failed = [...(payload.failed ?? [])];
  for (const order of data.orders.nodes) {
    // Помилка одного замовлення не зупиняє імпорт: воно повторюється окремим завданням.
    try {
      const r = await applyOrder(ctx, admin, order, "import");
      if (r.result === "created") imported++;
      else if (r.result === "skipped_unpaid") skipped++;
      else updated++;
    } catch (e) {
      if (failed.length < 50) failed.push(order.name);
      await enqueueJob(ctx.db, JOB.syncOrder, { shop: payload.shop, orderGid: order.id, mode: "import" }, { dedupeKey: `order:${order.id}` });
      if (e instanceof Error && !(e instanceof DomainError) && /ECONN|fetch failed|timeout/i.test(e.message)) throw e;
    }
  }
  const { hasNextPage, endCursor } = data.orders.pageInfo;
  const state = {
    status: hasNextPage ? "running" : "done",
    since: payload.since,
    imported,
    updated,
    skipped,
    failed,
    updatedAt: new Date().toISOString(),
  };
  await ctx.db.update(shopInstallations).set({ importState: state, updatedAt: new Date() }).where(eq(shopInstallations.shop, payload.shop));
  if (hasNextPage && endCursor) {
    await enqueueJob(
      ctx.db,
      JOB.importOrdersPage,
      { shop: payload.shop, since: payload.since, after: endCursor, imported, skipped, updated, failed },
      { dedupeKey: `import:${endCursor}` },
    );
  }
  return state;
}

// ---------------------------------------------------------------------------
// Передача підтверджених змін у Shopify
// ---------------------------------------------------------------------------

/**
 * Вхід для orderUpdate. Усі поля адреси передаються явно (порожнє → null): інакше при зміні країни
 * в Shopify лишався б старий регіон/індекс попередньої країни, і Shopify відхиляв би країну та індекс.
 * Регіон передається лише як код (provinceCode, напр. "TX", "ON"); назва регіону без коду → null.
 */
export function buildOrderUpdateInput(order: OrderRow) {
  const a = shippingAddressOf(order);
  const provinceCode = a.province && /^[A-Z0-9]{1,3}$/.test(a.province) ? a.province : null;
  return {
    id: order.shopifyOrderId,
    email: order.email,
    phone: order.contactPhone,
    shippingAddress: {
      firstName: a.firstName,
      lastName: a.lastName,
      company: a.company,
      address1: a.address1,
      address2: a.address2,
      city: a.city,
      provinceCode,
      zip: a.postalCode,
      countryCode: a.countryCode,
      phone: a.phone,
    },
  };
}

/** Поле помилки Shopify (userErrors.field) → поле форми застосунку. */
export function fieldFromShopify(path: string[] | null): string | null {
  if (!path || path.length === 0) return null;
  const last = path[path.length - 1]!;
  const inAddress = path.includes("shippingAddress");
  const map: Record<string, string> = {
    zip: "shipping.postalCode",
    countryCode: "shipping.countryCode",
    country: "shipping.countryCode",
    provinceCode: "shipping.province",
    province: "shipping.province",
    city: "shipping.city",
    address1: "shipping.address1",
    address2: "shipping.address2",
    firstName: "shipping.firstName",
    lastName: "shipping.lastName",
    company: "shipping.company",
  };
  if (inAddress) return last === "phone" ? "shipping.phone" : (map[last] ?? null);
  if (last === "email") return "email";
  if (last === "phone") return "contactPhone";
  return null;
}

export interface ShippingCountries {
  countries: string[];
  restOfWorld: boolean;
}

/** Країни доставки магазину (зони доставки Shopify). */
export async function shopShippingCountries(admin: AdminGraphql): Promise<ShippingCountries> {
  const data = await admin<{
    shop: { shipsToCountries: string[]; countriesInShippingZones: { countryCodes: string[]; includeRestOfWorld: boolean } };
  }>(SHOP_SHIPPING_COUNTRIES_QUERY);
  const countries = new Set([...data.shop.shipsToCountries, ...data.shop.countriesInShippingZones.countryCodes]);
  return { countries: [...countries].sort(), restOfWorld: data.shop.countriesInShippingZones.includeRestOfWorld };
}

/**
 * Надсилає поточні (підтверджені) контакти й адресу замовлення в Shopify через orderUpdate.
 * Перед відправкою перевіряє, що країна є в зонах доставки магазину: інакше Shopify відповідає
 * «Country/region not supported». Валідацію Shopify не обходимо — показуємо точну причину.
 * Після відповіді звіряє, що Shopify справді застосував країну й індекс.
 */
type UpdateError = { field: string[] | null; message: string };

export interface OrderUpdateAttempt {
  variant: DiagnosticVariant;
  ok: boolean;
  errors: UpdateError[];
  appliedCountry: string | null;
  requestId: string | null;
  fields: string[];
}

interface AddressState {
  countryCodeV2: string | null;
  provinceCode: string | null;
  zip: string | null;
  phone: string | null;
}

/** Поточний стан адреси й доставки замовлення в Shopify — лише безпечні для журналу ознаки. */
async function readAddressState(admin: AdminGraphql, orderGid: string) {
  const data = await admin<{
    order: {
      presentmentCurrencyCode: string | null;
      shippingAddress: AddressState | null;
      shippingLine: { title: string | null; source: string | null; code: string | null; carrierIdentifier: string | null; deliveryCategory: string | null } | null;
    } | null;
  }>(ORDER_ADDRESS_STATE_QUERY, { id: orderGid });
  const o = data.order;
  return {
    countryIso: o?.shippingAddress?.countryCodeV2 ?? null,
    regionCode: o?.shippingAddress?.provinceCode ?? null,
    postShape: o?.shippingAddress?.zip ? valueShape(o.shippingAddress.zip) : null,
    telFmt: o?.shippingAddress?.phone ? phoneFormat(o.shippingAddress.phone) : null,
    currency: o?.presentmentCurrencyCode ?? null,
    deliveryMethod: o?.shippingLine
      ? {
          source: o.shippingLine.source,
          code: o.shippingLine.code,
          carrier: o.shippingLine.carrierIdentifier,
          category: o.shippingLine.deliveryCategory,
        }
      : null,
  };
}

/** Один запит orderUpdate з безпечним журналом (форма запиту, помилки, X-Request-Id). */
async function sendOrderUpdate(
  admin: AdminGraphql,
  input: OrderUpdateInputLike,
  variant: DiagnosticVariant,
  context: Record<string, unknown>,
): Promise<OrderUpdateAttempt> {
  const fields = describeOrderUpdateInput(input);
  logger.info("shopify.order_update.request", { variant, apiVersion: SHOPIFY_API_VERSION, fields, ...context });
  const data = await admin<{
    orderUpdate: {
      order: { id: string; updatedAt: string; shippingAddress: { countryCodeV2: string | null; zip: string | null } | null } | null;
      userErrors: UpdateError[];
    };
  }>(ORDER_UPDATE_MUTATION, { input });
  const appliedCountry = data.orderUpdate.order?.shippingAddress?.countryCodeV2 ?? null;
  const errors = [...data.orderUpdate.userErrors];
  const sentCountry = (input.shippingAddress?.countryCode as string | null | undefined) ?? null;
  if (errors.length === 0 && data.orderUpdate.order && sentCountry && appliedCountry !== sentCountry) {
    errors.push({ field: ["shippingAddress", "countryCode"], message: `Shopify kept country ${appliedCountry ?? "—"} instead of ${sentCountry}` });
  }
  const attempt: OrderUpdateAttempt = {
    variant,
    ok: errors.length === 0,
    errors,
    appliedCountry,
    requestId: admin.lastRequestId ?? null,
    fields,
  };
  logger.info("shopify.order_update.response", {
    variant,
    ok: attempt.ok,
    requestId: attempt.requestId,
    appliedCountry,
    errors: errors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`),
    ...context,
  });
  return attempt;
}

async function recordPushSuccess(db: Db, orderId: string, shopifyOrderId: string) {
  await db.transaction(async (tx) => {
    // Успішне оновлення закриває попередні помилки синхронізації й «мертві» завдання для цього замовлення.
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: SYSTEM_ACTOR.id, resolution: "shopify_synced", updatedAt: new Date() })
      .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), inArray(issues.code, ["SHOPIFY_SYNC_FAILED", "SHOPIFY_COUNTRY_NOT_SHIPPED"])));
    await tx
      .update(jobs)
      .set({ status: "failed", lastError: "superseded_by_successful_sync", updatedAt: new Date() })
      .where(and(eq(jobs.type, JOB.pushOrder), eq(jobs.dedupeKey, pushDedupeKey(shopifyOrderId)), eq(jobs.status, "dead")));
    await writeAudit(tx, SYSTEM_ACTOR, "shopify.order_pushed", { type: "order", id: orderId });
  });
}

async function recordPushErrors(db: Db, orderId: string, errors: UpdateError[]) {
  await db.transaction(async (tx) => {
    for (const e of errors) {
      await openSyncIssue(tx, orderId, "SHOPIFY_SYNC_FAILED", { message: e.message.slice(0, 200) }, fieldFromShopify(e.field));
    }
  });
}

/**
 * Надсилає поточні (підтверджені) контакти й адресу замовлення в Shopify через orderUpdate.
 * Перед відправкою перевіряє, що країна є в зонах доставки магазину; після відповіді звіряє застосовану країну.
 * Кожен запит журналюється безпечно (без ПД): див. diagnostics.ts.
 */
export async function pushOrderChanges(db: Db, admin: AdminGraphql, shopifyOrderId: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.shopifyOrderId, shopifyOrderId));
  if (!order) return;
  const input = buildOrderUpdateInput(order);
  const country = input.shippingAddress.countryCode;
  if (country) {
    const shipping = await shopShippingCountries(admin);
    if (!shipping.restOfWorld && !shipping.countries.includes(country)) {
      await openSyncIssue(db, order.id, "SHOPIFY_COUNTRY_NOT_SHIPPED", { country, shipsTo: shipping.countries.join(", ") || "—" }, "shipping.countryCode");
      throw new DomainError("shopify.countryNotShipped", 422, { country });
    }
  }
  const before = await readAddressState(admin, shopifyOrderId);
  const attempt = await sendOrderUpdate(admin, input, "as_sent", {
    orderNo: order.orderNumber,
    before,
    countryChanged: before.countryIso !== country,
  });
  if (!attempt.ok) {
    await recordPushErrors(db, order.id, attempt.errors);
    throw new DomainError("shopify.updateRejected", 422, { message: attempt.errors.map((e) => e.message).join("; ").slice(0, 200) });
  }
  await recordPushSuccess(db, order.id, shopifyOrderId);
}

/**
 * Покрокова діагностика (запускає лише власник для замовлення з помилкою синхронізації адреси).
 * Надсилає ТУ САМУ підтверджену адресу в кількох коректних за схемою 2026-10 форматах — по черзі,
 * до першого успіху — і повертає, який саме елемент запиту Shopify не приймає. Валідацію Shopify не обходить.
 */
export async function diagnoseOrderAddressUpdate(db: Db, admin: AdminGraphql, orderId: string) {
  const [order] = await db.select().from(orders).where(eq(orders.id, orderId));
  if (!order?.shopifyOrderId) throw new DomainError("error.notFound", 404);
  const input = buildOrderUpdateInput(order);
  const before = await readAddressState(admin, order.shopifyOrderId);
  const shipping = await shopShippingCountries(admin);
  const context = {
    orderNo: order.orderNumber,
    diagnostic: true,
    before,
    targetCountry: input.shippingAddress.countryCode,
    countryChanged: before.countryIso !== input.shippingAddress.countryCode,
    targetCountryInZones: shipping.restOfWorld || shipping.countries.includes(input.shippingAddress.countryCode ?? ""),
  };
  logger.info("shopify.address_diagnostic.start", context);
  const attempts: OrderUpdateAttempt[] = [];
  for (const variant of DIAGNOSTIC_VARIANTS) {
    const attempt = await sendOrderUpdate(admin, inputVariant(input, variant), variant, context);
    attempts.push(attempt);
    if (attempt.ok) break;
  }
  const success = attempts.find((a) => a.ok) ?? null;
  if (success) await recordPushSuccess(db, order.id, order.shopifyOrderId);
  logger.info("shopify.address_diagnostic.result", {
    orderNo: order.orderNumber,
    succeededWith: success?.variant ?? null,
    attempts: attempts.map((a) => ({ variant: a.variant, ok: a.ok, requestId: a.requestId, errors: a.errors.map((e) => `${(e.field ?? []).join(".")}: ${e.message}`) })),
  });
  return { context, attempts, succeededWith: success?.variant ?? null };
}

export async function reportPushFailure(db: Db, shopifyOrderId: string, error: string) {
  const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.shopifyOrderId, shopifyOrderId));
  if (!order) return;
  const [existing] = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.orderId, order.id), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_SYNC_FAILED")))
    .limit(1);
  // Помилки полів уже зафіксовано під час відповіді Shopify; загальна — лише для збоїв без деталей.
  if (!existing) await openSyncIssue(db, order.id, "SHOPIFY_SYNC_FAILED", { message: error.slice(0, 200) });
}

// ---------------------------------------------------------------------------
// Етап 4: стан передачі підтверджених змін у Shopify і повторне надсилання
// ---------------------------------------------------------------------------

/** dedupeKey завдання передачі змін замовлення в Shopify (одне очікуване завдання на замовлення). */
export function pushDedupeKey(shopifyOrderId: string): string {
  return `push:${shopifyOrderId}`;
}

/** Поля, підтверджені зміни яких передаються в Shopify (контакти й адреса доставки). */
const PUSHED_CHANGE_SOURCES = ["manual", "suggestion_accepted"] as const;
const PUSH_FAILURE_CODES = ["SHOPIFY_SYNC_FAILED", "SHOPIFY_COUNTRY_NOT_SHIPPED"] as const;

export interface PushFailure {
  code: (typeof PUSH_FAILURE_CODES)[number];
  field: string | null;
  /** Текст помилки Shopify (як повернув Shopify) або null (напр. країна поза зонами доставки — див. params). */
  message: string | null;
  params: Record<string, string | number>;
}

export type ShopifyPushState =
  /** Демо: у Shopify нічого не надсилається. */
  | { state: "demo"; hasChanges: boolean }
  /** Замовлення не пов'язане з Shopify (немає shopifyOrderId). */
  | { state: "not_linked"; hasChanges: boolean }
  /** Підтверджених локальних змін контактів/адреси немає — передавати нічого. */
  | { state: "none" }
  /** Завдання в черзі або виконується; retrying — попередня спроба не вдалася й буде повторена. */
  | { state: "queued"; at: Date; retrying: boolean; lastError: string | null; failures: PushFailure[] }
  /** Shopify прийняв поточні дані (після останньої підтвердженої зміни). */
  | { state: "synced"; at: Date }
  /** Shopify відхилив зміни або спроби вичерпано: текст Shopify у failures / lastError. */
  | { state: "failed"; at: Date | null; lastError: string | null; failures: PushFailure[] }
  /** Є підтверджені зміни, але завдання не ставилося (напр. дані з помилками перевірки) або змінено після синхронізації. */
  | { state: "not_sent"; lastChangeAt: Date };

export interface PushStateInput {
  gateway: ShopifyGateway["kind"];
  shopifyOrderId: string | null;
  /** Час останньої підтвердженої (ручної/прийнятої) зміни контактів або адреси. */
  lastConfirmedChangeAt: Date | null;
  /** Завдання shopify.push_order з dedupeKey цього замовлення (будь-який порядок). */
  jobs: Array<{ status: JobRowStatus; attempts: number; lastError: string | null; updatedAt: Date }>;
  /** Відкриті проблеми синхронізації (SHOPIFY_SYNC_FAILED / SHOPIFY_COUNTRY_NOT_SHIPPED). */
  failures: PushFailure[];
}

type JobRowStatus = (typeof jobs.$inferSelect)["status"];

/** Чиста функція: стан передачі змін у Shopify за завданнями черги та відкритими проблемами. */
export function derivePushState(input: PushStateInput): ShopifyPushState {
  const hasChanges = input.lastConfirmedChangeAt !== null;
  if (input.gateway === "demo") return { state: "demo", hasChanges };
  if (!input.shopifyOrderId) return { state: "not_linked", hasChanges };
  // «failed» у черзі — завдання, замінене новішим або закрите успішною синхронізацією: не враховуємо.
  const relevant = input.jobs.filter((j) => j.status !== "failed").sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  const latest = relevant[0] ?? null;
  if (latest && (latest.status === "queued" || latest.status === "running")) {
    return {
      state: "queued",
      at: latest.updatedAt,
      retrying: latest.attempts > 0 && Boolean(latest.lastError),
      lastError: latest.lastError,
      failures: input.failures,
    };
  }
  if (input.failures.length > 0 || latest?.status === "dead") {
    return {
      state: "failed",
      at: latest?.updatedAt ?? null,
      lastError: latest?.status === "dead" ? latest.lastError : null,
      failures: input.failures,
    };
  }
  if (latest?.status === "succeeded") {
    if (input.lastConfirmedChangeAt && input.lastConfirmedChangeAt.getTime() > latest.updatedAt.getTime()) {
      return { state: "not_sent", lastChangeAt: input.lastConfirmedChangeAt };
    }
    return { state: "synced", at: latest.updatedAt };
  }
  return input.lastConfirmedChangeAt ? { state: "not_sent", lastChangeAt: input.lastConfirmedChangeAt } : { state: "none" };
}

/** Стан передачі підтверджених змін замовлення в Shopify (для сторінки замовлення). */
export async function loadShopifyPushState(
  db: DbOrTx,
  gateway: ShopifyGateway["kind"],
  order: Pick<OrderRow, "id" | "shopifyOrderId">,
): Promise<ShopifyPushState> {
  const [lastChange] = await db
    .select({ at: orderChanges.createdAt })
    .from(orderChanges)
    .where(
      and(
        eq(orderChanges.orderId, order.id),
        inArray(orderChanges.source, [...PUSHED_CHANGE_SOURCES]),
        or(like(orderChanges.field, "shipping.%"), inArray(orderChanges.field, ["email", "contactPhone"])),
      ),
    )
    .orderBy(desc(orderChanges.createdAt))
    .limit(1);
  const jobRows = order.shopifyOrderId
    ? await db
        .select({ status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError, updatedAt: jobs.updatedAt })
        .from(jobs)
        .where(and(eq(jobs.type, JOB.pushOrder), eq(jobs.dedupeKey, pushDedupeKey(order.shopifyOrderId))))
        .orderBy(desc(jobs.updatedAt))
        .limit(20)
    : [];
  const failureRows = await db
    .select({ code: issues.code, field: issues.field, params: issues.params })
    .from(issues)
    .where(and(eq(issues.orderId, order.id), eq(issues.status, "open"), inArray(issues.code, [...PUSH_FAILURE_CODES])));
  const failures: PushFailure[] = failureRows.map((r) => {
    const params = (r.params ?? {}) as Record<string, string | number>;
    return {
      code: r.code as PushFailure["code"],
      field: r.field,
      message: typeof params.message === "string" ? params.message : null,
      params,
    };
  });
  return derivePushState({
    gateway,
    shopifyOrderId: order.shopifyOrderId,
    lastConfirmedChangeAt: lastChange?.at ?? null,
    jobs: jobRows,
    failures,
  });
}

/**
 * «Повторно надіслати в Shopify»: ставить у чергу передачу ПОТОЧНИХ підтверджених контактів і адреси
 * (те саме завдання shopify.push_order, дедуплікація за push:<shopifyOrderId> — повтор не дублює очікуване завдання).
 * Демо: нічого не надсилається. Дані з відкритими помилками перевірки не надсилаються (спершу виправлення).
 */
export async function resendOrderToShopify(ctx: ServiceContext, orderId: string): Promise<ShopifySyncResult> {
  requirePermission(ctx.actor, "orders.edit");
  const order = await loadOrderRow(ctx.db, orderId);
  if (order.status === "cancelled") throw new DomainError("order.notEditable", 409, { status: order.status });
  let result: ShopifySyncResult;
  if (ctx.shopify.kind === "demo") {
    result = { status: "skipped", reason: "demo_mode" };
  } else if (!order.shopifyOrderId) {
    result = { status: "skipped", reason: "not_linked" };
  } else {
    const [invalid] = await ctx.db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.orderId, order.id),
          eq(issues.status, "open"),
          eq(issues.severity, "error"),
          or(like(issues.field, "shipping.%"), inArray(issues.field, ["email", "contactPhone"])),
          notLike(issues.code, "SHOPIFY_%"),
        ),
      )
      .limit(1);
    if (invalid) {
      result = { status: "skipped", reason: "invalid_data" };
    } else {
      try {
        // Одне завдання передає контакти й адресу повністю (QueueingShopifyGateway → shopify.push_order).
        result = await ctx.shopify.updateOrderShippingAddress(order.shopifyOrderId, shippingAddressOf(order));
      } catch {
        result = { status: "failed", error: "shopify.syncFailed" };
      }
    }
  }
  await writeAudit(ctx.db, ctx.actor, "order.shopify_resend", { type: "order", id: order.id }, {
    status: result.status,
    ...(result.status === "skipped" ? { reason: result.reason } : {}),
  });
  return result;
}

// ---------------------------------------------------------------------------
// Встановлення / видалення застосунку
// ---------------------------------------------------------------------------

export async function recordInstallation(db: Db, shop: string, scopes: string | null): Promise<{ firstSync: boolean }> {
  const [existing] = await db.select().from(shopInstallations).where(eq(shopInstallations.shop, shop));
  if (existing) {
    await db
      .update(shopInstallations)
      .set({ scopes, uninstalledAt: null, webhooksRegisteredAt: new Date(), updatedAt: new Date() })
      .where(eq(shopInstallations.shop, shop));
  } else {
    await db.insert(shopInstallations).values({ shop, scopes, webhooksRegisteredAt: new Date() });
  }
  const firstSync = !existing?.productsSyncedAt;
  if (firstSync) await enqueueJob(db, JOB.productsPage, { shop, after: null }, { dedupeKey: "products:start" });
  return { firstSync };
}

export async function recordUninstall(db: DbOrTx, shop: string) {
  await db.update(shopInstallations).set({ uninstalledAt: new Date(), updatedAt: new Date() }).where(eq(shopInstallations.shop, shop));
}

export async function currentShop(db: DbOrTx): Promise<typeof shopInstallations.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(shopInstallations)
    .where(sql`${shopInstallations.uninstalledAt} is null`)
    .orderBy(sql`${shopInstallations.installedAt} desc`)
    .limit(1);
  return row ?? null;
}

/** Запуск імпорту старих замовлень (від дати). */
export async function startOrdersImport(db: Db, shop: string, since: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new DomainError("shopify.invalidDate", 400);
  await db
    .update(shopInstallations)
    .set({ importState: { status: "queued", since, imported: 0, skipped: 0, updatedAt: new Date().toISOString() }, updatedAt: new Date() })
    .where(eq(shopInstallations.shop, shop));
  return enqueueJob(db, JOB.importOrdersPage, { shop, since, after: null, imported: 0, skipped: 0 }, { dedupeKey: `import:start:${since}` });
}

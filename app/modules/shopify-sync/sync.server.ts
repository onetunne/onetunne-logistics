/**
 * Синхронізація з Shopify. Shopify — основне джерело замовлень, товарів і залишків.
 * Webhook лише ставить завдання в чергу; завдання завжди перечитує свіжі дані через GraphQL Admin API,
 * тож порядок і повтори подій не призводять до неузгодженості.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import { issues, jobs, orderChanges, orderLineItems, orders, productVariants, products, shipments, shopInstallations } from "~/db/schema";
import { isShipped } from "~/domain/order-status";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { loadOrderRow, shippingAddressOf, type OrderRow } from "~/modules/orders/repository.server";
import { VALIDATABLE_STATUSES, validateOrderInTx } from "~/modules/orders/workflow.server";
import { cancelOrder, processPaidOrder } from "~/modules/shipments/waybill.server";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  INVENTORY_ITEM_PRODUCT_QUERY,
  ORDER_QUERY,
  ORDER_UPDATE_MUTATION,
  ORDERS_PAGE_QUERY,
  PRODUCT_QUERY,
  PRODUCTS_PAGE_QUERY,
  type GqlOrder,
  type GqlProduct,
  type PageInfo,
} from "~/integrations/shopify/graphql";
import type { ServiceContext } from "~/server/types";
import { initialStatus, isPaid, mapOrder, mapProduct, type MappedOrder, type MappedProduct } from "./mappers";

export const JOB = {
  syncOrder: "shopify.sync_order",
  syncProduct: "shopify.sync_product",
  syncInventoryItem: "shopify.sync_inventory_item",
  deleteProduct: "shopify.delete_product",
  productsPage: "shopify.products_page",
  importOrdersPage: "shopify.import_orders_page",
  pushOrder: "shopify.push_order",
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
  code: "SHOPIFY_ORDER_CHANGED" | "SHOPIFY_SYNC_FAILED" | "SHOPIFY_CANCELLED_AFTER_SHIPMENT",
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

/** Надсилає поточні (підтверджені) контакти й адресу замовлення в Shopify через orderUpdate. */
export async function pushOrderChanges(db: Db, admin: AdminGraphql, shopifyOrderId: string): Promise<void> {
  const [order] = await db.select().from(orders).where(eq(orders.shopifyOrderId, shopifyOrderId));
  if (!order) return;
  const data = await admin<{ orderUpdate: { order: { id: string; updatedAt: string } | null; userErrors: Array<{ field: string[] | null; message: string }> } }>(
    ORDER_UPDATE_MUTATION,
    { input: buildOrderUpdateInput(order) },
  );
  const errors = data.orderUpdate.userErrors;
  if (errors.length > 0) {
    // Кожна помилка Shopify — окрема проблема біля відповідного поля, з текстом Shopify.
    await db.transaction(async (tx) => {
      for (const e of errors) {
        await openSyncIssue(tx, order.id, "SHOPIFY_SYNC_FAILED", { message: e.message.slice(0, 200) }, fieldFromShopify(e.field));
      }
    });
    throw new DomainError("shopify.updateRejected", 422, { message: errors.map((e) => e.message).join("; ").slice(0, 200) });
  }
  await db.transaction(async (tx) => {
    // Успішне оновлення закриває попередні помилки синхронізації й «мертві» завдання для цього замовлення.
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: SYSTEM_ACTOR.id, resolution: "shopify_synced", updatedAt: new Date() })
      .where(and(eq(issues.orderId, order.id), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_SYNC_FAILED")));
    await tx
      .update(jobs)
      .set({ status: "failed", lastError: "superseded_by_successful_sync", updatedAt: new Date() })
      .where(and(eq(jobs.type, JOB.pushOrder), eq(jobs.dedupeKey, `push:${shopifyOrderId}`), eq(jobs.status, "dead")));
    await writeAudit(tx, SYSTEM_ACTOR, "shopify.order_pushed", { type: "order", id: order.id });
  });
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

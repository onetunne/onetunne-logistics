/**
 * Синхронізація з Shopify. Shopify — основне джерело замовлень, товарів і залишків.
 * Webhook лише ставить завдання в чергу; завдання завжди перечитує свіжі дані через GraphQL Admin API,
 * тож порядок і повтори подій не призводять до неузгодженості.
 */
import { and, desc, eq, inArray, isNotNull, isNull, like, ne, notInArray, notLike, or, sql } from "drizzle-orm";
import type { Db, DbOrTx, Tx } from "~/db/client.server";
import { issues, jobs, orderChanges, orderLineItems, orders, productVariants, products, shipments, shopInstallations } from "~/db/schema";
import { isFulfilledInShopify, isShipped } from "~/domain/order-status";
import { SYSTEM_ACTOR, requirePermission } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { writeAudit } from "~/modules/audit/audit.server";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { loadOrderRow, shippingAddressOf, type OrderRow } from "~/modules/orders/repository.server";
import { VALIDATABLE_STATUSES, validateOrderInTx } from "~/modules/orders/workflow.server";
import { cancelOrder, processPaidOrder } from "~/modules/shipments/waybill.server";
import { syncOrderReservations } from "~/modules/inventory/reservations.server";
import { scheduleReconcileForInventoryWebhook } from "~/modules/inventory-sync/schedule.server";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { ShopifyGateway, ShopifySyncResult } from "~/integrations/shopify/types";
import {
  INVENTORY_ITEM_PRODUCT_QUERY,
  ORDER_LINE_ITEMS_MAX_PAGES,
  ORDER_LINE_ITEMS_PAGE_QUERY,
  ORDER_LINE_ITEMS_PAGE_SIZE,
  ORDER_QUERY,
  ORDER_UPDATE_MUTATION,
  ORDERS_PAGE_SIZE,
  SHOP_SHIPPING_COUNTRIES_QUERY,
  ORDER_ADDRESS_STATE_QUERY,
  ORDERS_PAGE_QUERY,
  PRODUCT_QUERY,
  PRODUCT_VARIANTS_MAX_PAGES,
  PRODUCT_VARIANTS_PAGE_QUERY,
  PRODUCT_VARIANTS_PAGE_SIZE,
  PRODUCTS_PAGE_QUERY,
  PRODUCTS_PAGE_SIZE,
  type GqlOrder,
  type GqlOrderLineItemsPage,
  type GqlProduct,
  type GqlProductVariantsPage,
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
import { JOB, orderSyncDedupeKey } from "./jobs";
import { startCollectionsSync } from "./collections.server";

export { JOB } from "./jobs";

/** Версія GraphQL Admin API (та сама, що в shopify.server.ts). */
const SHOPIFY_API_VERSION = "2026-10";

// ---------------------------------------------------------------------------
// Товари
// ---------------------------------------------------------------------------

/**
 * fetchedAt — момент ПЕРЕД запитом до Shopify, яким отримано дані товару (час знімка залишку inventory_synced_at).
 * Знімок, позначений часом до читання, а не після, зсуває похибку в бік заниження (замовлення між запитом і записом
 * не рахуються двічі — див. opening.server.ts).
 *
 * Етап 5 — варіанти, видалені в Shopify: рядки варіантів не видаляються (на них посилаються позиції замовлень і
 * облік складу), а позначаються явно — product_variants.removed_at: варіант, якого немає в ПОВНОМУ переліку варіантів
 * (opts.variantsComplete — прочитано всі сторінки, readAllVariants), отримує час синхронізації; варіант із відповіді —
 * null (знову з'явився в Shopify). Неповний перелік (читання сторінок не завершилося — readAllVariants) — про відсутні
 * нічого не відомо: вони вважаються наявними (позначку знято) — у пакуванні їхній спільний штрихкод лишається
 * «неоднозначним» (безпечніше, ніж мовчки зарахувати сканування не того товару).
 * Сканування в пакуванні не вважає штрихкод видаленого варіанта «спільним» (catalogVariantLive у
 * modules/packing/packing.server.ts). Інші зміни варіанта (митні дані, габарити в застосунку) позначку не зачіпають.
 */
export async function upsertProduct(
  db: DbOrTx,
  p: MappedProduct,
  currency: string,
  fetchedAt: Date = new Date(),
  opts: { variantsComplete?: boolean } = {},
): Promise<"saved" | "stale"> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(products).where(eq(products.shopifyProductId, p.shopifyProductId)).for("update");
    if (existing?.shopifyUpdatedAt && existing.shopifyUpdatedAt > p.shopifyUpdatedAt) return "stale";
    const syncedAt = new Date();
    const values = {
      title: p.title,
      handle: p.handle,
      imageUrl: p.imageUrl,
      status: p.status,
      shopifyUpdatedAt: p.shopifyUpdatedAt,
      updatedAt: syncedAt,
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
      // inventorySyncedAt — час знімка залишку Shopify (opening.server.ts порівнює з ним дату замовлень).
      const data = {
        ...v,
        productId,
        currency,
        inventorySyncedAt: v.inventoryAvailable === null ? null : fetchedAt,
        removedAt: null,
        updatedAt: syncedAt,
      };
      await tx
        .insert(productVariants)
        .values(data)
        .onConflictDoUpdate({ target: productVariants.shopifyVariantId, set: data });
    }
    if (opts.variantsComplete) {
      const present = p.variants.map((v) => v.shopifyVariantId);
      await tx
        .update(productVariants)
        .set({ removedAt: syncedAt, updatedAt: syncedAt })
        .where(
          and(
            eq(productVariants.productId, productId),
            isNull(productVariants.removedAt),
            or(isNull(productVariants.shopifyVariantId), notInArray(productVariants.shopifyVariantId, present)),
          ),
        );
    } else {
      await tx
        .update(productVariants)
        .set({ removedAt: null, updatedAt: syncedAt })
        .where(and(eq(productVariants.productId, productId), isNotNull(productVariants.removedAt)));
    }
    return "saved";
  });
}

/**
 * Усі варіанти товару: перша сторінка вже прочитана (PRODUCT_QUERY), наступні — PRODUCT_VARIANTS_PAGE_QUERY (after).
 * Shopify: «If querying a single product at the root, you can fetch up to 2048 variants» (Product.variants, 2026-10).
 * complete = true лише коли прочитано ВСІ сторінки одного стану товару. Відповідь без курсора, понад
 * PRODUCT_VARIANTS_MAX_PAGES сторінок, товар зник або змінився між сторінками (updatedAt) → перелік неповний: прочитані
 * варіанти зберігаються, а про відсутні нічого не відомо (upsertProduct вважає їх наявними, а не видаленими); зміна
 * товару в Shopify надішле products/update — тоді товар перечитується знову.
 */
export async function readAllVariants(admin: AdminGraphql, first: GqlProduct): Promise<{ product: GqlProduct; complete: boolean }> {
  const nodes = [...first.variants.nodes];
  let info = first.variants.pageInfo;
  let complete = true;
  for (let page = 1; info?.hasNextPage; page++) {
    if (!info.endCursor || page >= PRODUCT_VARIANTS_MAX_PAGES) {
      complete = false;
      break;
    }
    const data: GqlProductVariantsPage = await admin<GqlProductVariantsPage>(PRODUCT_VARIANTS_PAGE_QUERY, {
      id: first.id,
      first: PRODUCT_VARIANTS_PAGE_SIZE,
      after: info.endCursor,
    });
    if (!data.product || data.product.updatedAt !== first.updatedAt) {
      complete = false;
      break;
    }
    nodes.push(...data.product.variants.nodes);
    info = data.product.variants.pageInfo;
  }
  if (!complete) logger.warn("shopify.product_variants_incomplete", { product: first.id, read: nodes.length });
  return { product: { ...first, variants: { pageInfo: { hasNextPage: !complete, endCursor: null }, nodes } }, complete };
}

export async function syncProduct(db: Db, admin: AdminGraphql, productGid: string, currency: string) {
  const fetchedAt = new Date();
  const data = await admin<{ product: GqlProduct | null }>(PRODUCT_QUERY, { id: productGid });
  if (!data.product) {
    await markProductDeleted(db, productGid);
    return "deleted" as const;
  }
  const { product, complete } = await readAllVariants(admin, data.product);
  return upsertProduct(db, mapProduct(product), currency, fetchedAt, { variantsComplete: complete });
}

export async function markProductDeleted(db: DbOrTx, productGid: string) {
  await db.update(products).set({ status: "DELETED", updatedAt: new Date() }).where(eq(products.shopifyProductId, productGid));
}

/** Сторінка повної синхронізації товарів; наступна сторінка — окреме завдання (продовжується після перезапуску). */
export async function syncProductsPage(db: Db, admin: AdminGraphql, shop: string, after: string | null, currency: string) {
  const fetchedAt = new Date();
  const data = await admin<{ products: { pageInfo: PageInfo; nodes: GqlProduct[] } }>(PRODUCTS_PAGE_QUERY, {
    first: PRODUCTS_PAGE_SIZE,
    after,
  });
  for (const p of data.products.nodes) {
    // Товар, варіанти якого не вмістилися на сторінку списку, перечитується окремо (усі сторінки варіантів).
    if (p.variants.pageInfo?.hasNextPage) await syncProduct(db, admin, p.id, currency);
    else await upsertProduct(db, mapProduct(p), currency, fetchedAt, { variantsComplete: true });
  }
  if (data.products.pageInfo.hasNextPage && data.products.pageInfo.endCursor) {
    await enqueueJob(db, JOB.productsPage, { shop, after: data.products.pageInfo.endCursor }, { dedupeKey: `products:${data.products.pageInfo.endCursor}` });
  } else {
    await db.update(shopInstallations).set({ productsSyncedAt: new Date(), updatedAt: new Date() }).where(eq(shopInstallations.shop, shop));
    // Етап 5: після повної синхронізації товарів — колекції й членство (шаблони комплектації «на колекцію»).
    await startCollectionsSync(db, shop);
  }
  return data.products.nodes.length;
}

/**
 * Webhook inventory_levels/update: оновлення знімка залишку товару (shopify.sync_product) і — етап 5 — ВІДКЛАДЕНА
 * звірка цієї позиції зі складом застосунку (~10 хв, щоб замовлення встигло синхронізуватися й зарезервуватися;
 * повторні події відкладають ту саму звірку, dedupe; лише для товарів, відкритих в обліку складу).
 * Значення з webhook напряму не застосовується.
 */
export async function syncInventoryItem(db: Db, admin: AdminGraphql, shop: string, inventoryItemGid: string) {
  const data = await admin<{ inventoryItem: { variant: { product: { id: string } | null } | null } | null }>(
    INVENTORY_ITEM_PRODUCT_QUERY,
    { id: inventoryItemGid },
  );
  const productGid = data.inventoryItem?.variant?.product?.id;
  if (productGid) await enqueueJob(db, JOB.syncProduct, { shop, productGid }, { dedupeKey: `product:${productGid}` });
  await scheduleReconcileForInventoryWebhook(db, shop, inventoryItemGid);
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

/** Контакти й адреса так, як їх щойно повідомив Shopify (orders.shopify_contact_snapshot). */
export function contactSnapshotOf(m: MappedOrder): Record<string, string | null> {
  return Object.fromEntries(CONTACT_FIELDS.map((f) => [f.field, f.get(m)]));
}

/** Порожнє значення й null — одне й те саме (автовиправлення в історії записує порожній рядок, поле зберігає null). */
const sameValue = (a: string | null | undefined, b: string | null | undefined) => (a ?? "") === (b ?? "");

/**
 * Поля, які відрізняються від замовлення в застосунку, але Shopify їх НЕ змінював: різниця — від змін застосунку
 * (автовиправлення формату телефону/індексу, копіювання телефону, прийняті пропозиції, підтверджені правки, які ще не
 * передано або Shopify не прийняв). Автовиправлення в Shopify не передаються (лише підтверджені правки — syncOrderToShopify),
 * тож без цього кожне наступне читання відправленого замовлення повідомляло б власну зміну застосунку як «змінено в
 * Shopify» (SHOPIFY_ORDER_CHANGED), а відкрите замовлення — перезаписувало б автовиправлення сирим значенням Shopify.
 * Знімок (orders.shopify_contact_snapshot) — значення Shopify з попереднього читання; Shopify змінив поле, лише коли
 * нове значення інше. Замовлення без знімка (до міграції 0011): Shopify не змінював поле, якщо його поточне значення —
 * початкове значення якоїсь зміни застосунку цього поля (order_changes, джерело не shopify_sync), тобто те, що
 * застосунок отримав від Shopify і потім змінив. Немає таких змін — поле в застосунку не змінювалося, різниця — від Shopify.
 */
async function fieldsUnchangedInShopify(
  tx: DbOrTx,
  existing: OrderRow,
  differing: ReadonlyArray<{ field: string; to: string | null }>,
): Promise<Set<string>> {
  const unchanged = new Set<string>();
  const snapshot = existing.shopifyContactSnapshot;
  const legacy: Array<{ field: string; to: string | null }> = [];
  for (const c of differing) {
    if (snapshot && Object.prototype.hasOwnProperty.call(snapshot, c.field)) {
      if (sameValue(snapshot[c.field], c.to)) unchanged.add(c.field);
    } else {
      legacy.push(c);
    }
  }
  if (legacy.length === 0) return unchanged;
  const appChanges = await tx
    .select({ field: orderChanges.field, oldValue: orderChanges.oldValue })
    .from(orderChanges)
    .where(
      and(
        eq(orderChanges.orderId, existing.id),
        inArray(
          orderChanges.field,
          legacy.map((c) => c.field),
        ),
        ne(orderChanges.source, "shopify_sync"),
      ),
    );
  for (const c of legacy) {
    if (appChanges.some((r) => r.field === c.field && sameValue(r.oldValue, c.to))) unchanged.add(c.field);
  }
  return unchanged;
}

async function resolveVariantIds(tx: DbOrTx, m: MappedOrder): Promise<Map<string, string>> {
  const gids = m.lineItems.map((l) => l.shopifyVariantId).filter((g): g is string => Boolean(g));
  if (gids.length === 0) return new Map();
  const rows = await tx
    .select({ id: productVariants.id, gid: productVariants.shopifyVariantId })
    .from(productVariants)
    .where(inArray(productVariants.shopifyVariantId, gids));
  return new Map(rows.map((r) => [r.gid!, r.id]));
}

type StoredLine = {
  id: string;
  gid: string | null;
  variantId: string | null;
  title: string;
  sku: string | null;
  quantity: number;
  currentQuantity: number | null;
  shopifyAddedAt: Date | null;
  discountedUnitPrice: string | null;
  position: number;
};

async function loadStoredLines(tx: DbOrTx, orderId: string): Promise<StoredLine[]> {
  return tx
    .select({
      id: orderLineItems.id,
      gid: orderLineItems.shopifyLineItemId,
      variantId: orderLineItems.variantId,
      title: orderLineItems.title,
      sku: orderLineItems.sku,
      quantity: orderLineItems.quantity,
      currentQuantity: orderLineItems.currentQuantity,
      shopifyAddedAt: orderLineItems.shopifyAddedAt,
      discountedUnitPrice: orderLineItems.discountedUnitPrice,
      position: orderLineItems.position,
    })
    .from(orderLineItems)
    .where(eq(orderLineItems.orderId, orderId))
    .orderBy(orderLineItems.position);
}

type MappedLine = MappedOrder["lineItems"][number];

/**
 * Локальний варіант позиції. Shopify повертає `variant: null`, коли варіант (або товар) видалено вже після замовлення:
 * це НЕ зміна позиції — зв'язок із локальним варіантом (митні дані, вага, резерв складу) зберігається.
 * Зміною вважається лише інший непорожній GID варіанта.
 */
function variantResolver(variantIds: ReadonlyMap<string, string>, stored: readonly StoredLine[]) {
  const storedByGid = new Map(stored.filter((e) => e.gid).map((e) => [e.gid!, e.variantId]));
  return (l: MappedLine): string | null =>
    l.shopifyVariantId ? (variantIds.get(l.shopifyVariantId) ?? null) : (storedByGid.get(l.shopifyLineItemId) ?? null);
}

/**
 * Оновлює позиції замовлення за даними Shopify, ЗБЕРІГАЮЧИ id наявних позицій (зіставлення за shopifyLineItemId):
 * на id позиції посилаються резерви складу (stock_reservations), рухи журналу, чекліст пакування й поля проблем
 * перевірки (`lineItem.<id>`). Позиції, яких більше немає в Shopify, видаляються (їхні резерви знімає
 * syncOrderReservations).
 * addedOnUpdate — замовлення вже було збережене (редагування в Shopify): нова позиція без LineItem.createdAt отримує
 * shopify_added_at = updatedAt замовлення (позиція, додана після знімка складу, — новий продаж, без корекції знімка).
 */
async function replaceLineItems(tx: DbOrTx, orderId: string, m: MappedOrder, opts: { addedOnUpdate: boolean }) {
  const variantIds = await resolveVariantIds(tx, m);
  const existing = await loadStoredLines(tx, orderId);
  const variantOf = variantResolver(variantIds, existing);
  const byGid = new Map(existing.filter((e) => e.gid).map((e) => [e.gid!, e]));
  const keep = new Set<string>();
  for (const [position, l] of m.lineItems.entries()) {
    const values = {
      variantId: variantOf(l),
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      currentQuantity: l.currentQuantity,
      unitPrice: l.unitPrice,
      discountedUnitPrice: l.discountedUnitPrice,
      currency: l.currency,
      imageUrl: l.imageUrl,
      position,
    };
    const current = byGid.get(l.shopifyLineItemId);
    if (current && !keep.has(current.id)) {
      await tx
        .update(orderLineItems)
        .set({ ...values, shopifyAddedAt: current.shopifyAddedAt ?? l.shopifyCreatedAt })
        .where(eq(orderLineItems.id, current.id));
      keep.add(current.id);
    } else {
      const [row] = await tx
        .insert(orderLineItems)
        .values({
          ...values,
          orderId,
          shopifyLineItemId: l.shopifyLineItemId,
          shopifyAddedAt: l.shopifyCreatedAt ?? (opts.addedOnUpdate ? m.shopifyUpdatedAt : null),
        })
        .returning({ id: orderLineItems.id });
      keep.add(row!.id);
    }
  }
  const removed = existing.filter((e) => !keep.has(e.id)).map((e) => e.id);
  if (removed.length > 0) await tx.delete(orderLineItems).where(inArray(orderLineItems.id, removed));
}

/**
 * Позиції не змінилися, але збережені до етапу 5 (current_quantity / shopify_added_at = null): тихо заповнює ці
 * поля значеннями Shopify. Ефективна кількість складу не змінюється (current_quantity дорівнює збереженій quantity —
 * інакше diffLineItems повідомив би зміну), тож без історії, проблем і руху складу; безпечно й з активною накладною.
 * Ціна одиниці після всіх знижок (митна вартість) оновлюється так само тихо, як і суми замовлення (subtotal/total):
 * склад вона не змінює, а вже надісланий перевізнику інвойс береться зі знімка запиту (withSentCustomsData).
 */
async function backfillLineDetails(tx: DbOrTx, stored: readonly StoredLine[], m: MappedOrder) {
  const byGid = new Map(m.lineItems.map((l) => [l.shopifyLineItemId, l]));
  for (const e of stored) {
    const l = e.gid ? byGid.get(e.gid) : undefined;
    if (!l) continue;
    const patch: { currentQuantity?: number; shopifyAddedAt?: Date; discountedUnitPrice?: string } = {};
    if (e.currentQuantity === null && l.currentQuantity === e.quantity) patch.currentQuantity = l.currentQuantity;
    if (e.shopifyAddedAt === null && l.shopifyCreatedAt) patch.shopifyAddedAt = l.shopifyCreatedAt;
    if (l.discountedUnitPrice !== null && e.discountedUnitPrice !== l.discountedUnitPrice) patch.discountedUnitPrice = l.discountedUnitPrice;
    if (Object.keys(patch).length > 0) await tx.update(orderLineItems).set(patch).where(eq(orderLineItems.id, e.id));
  }
}

/** Рядок позиції для історії змін (без персональних даних): «SKU×кількість; …». */
function lineSummary(lines: ReadonlyArray<{ sku: string | null; title: string; quantity: number }>): string {
  return lines
    .map((l) => `${l.sku ?? l.title}×${l.quantity}`)
    .join("; ")
    .slice(0, 500);
}

/**
 * Чи змінилися позиції замовлення в Shopify (склад: id позиції Shopify, варіант, кількість до відправлення
 * currentQuantity, замовлена кількість). Ціни/назви не впливають на склад і оновлюються разом із будь-якою зміною.
 * Видалений у Shopify варіант (variant: null) зміною не є — див. variantResolver.
 */
async function diffLineItems(
  tx: DbOrTx,
  orderId: string,
  m: MappedOrder,
): Promise<{ changed: boolean; from: string; to: string; stored: StoredLine[] }> {
  const variantIds = await resolveVariantIds(tx, m);
  const existing = await loadStoredLines(tx, orderId);
  const variantOf = variantResolver(variantIds, existing);
  const key = (gid: string | null, variantId: string | null, quantity: number, current: number) => `${gid}|${variantId}|${quantity}|${current}`;
  const before = existing.map((e) => key(e.gid, e.variantId, e.quantity, e.currentQuantity ?? e.quantity)).sort();
  const after = m.lineItems.map((l) => key(l.shopifyLineItemId, variantOf(l), l.quantity, l.currentQuantity)).sort();
  const changed = before.length !== after.length || before.some((k, i) => k !== after[i]);
  return {
    changed,
    from: lineSummary(existing.map((e) => ({ sku: e.sku, title: e.title, quantity: e.currentQuantity ?? e.quantity }))),
    to: lineSummary(m.lineItems.map((l) => ({ sku: l.sku, title: l.title, quantity: l.currentQuantity }))),
    stored: existing,
  };
}

/** Shopify показує (часткове) виконання замовлення (див. isFulfilledInShopify). */
const fulfilledInShopify = isFulfilledInShopify;

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

/**
 * Зміни з Shopify застосовано (або Shopify знову збігається із застосунком): прибирає ці поля з відкритої проблеми
 * SHOPIFY_ORDER_CHANGED; проблема без полів закривається системою (resolution shopify_applied).
 */
async function settleShopifyChangedIssue(tx: DbOrTx, orderId: string, appliedFields: readonly string[]) {
  if (appliedFields.length === 0) return;
  const fingerprint = `${orderId}:SHOPIFY_ORDER_CHANGED:`;
  const [open] = await tx
    .select({ id: issues.id, params: issues.params })
    .from(issues)
    .where(and(eq(issues.fingerprint, fingerprint), eq(issues.status, "open")))
    .for("update");
  if (!open) return;
  const applied = new Set(appliedFields);
  const raw = typeof open.params?.fields === "string" ? open.params.fields : "";
  const remaining = raw
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f && !applied.has(f));
  const now = new Date();
  if (remaining.length > 0) {
    await tx.update(issues).set({ params: { ...open.params, fields: remaining.join(", ") }, updatedAt: now }).where(eq(issues.id, open.id));
    return;
  }
  await tx
    .update(issues)
    .set({ status: "resolved", resolvedAt: now, resolvedBy: SYSTEM_ACTOR.id, resolution: "shopify_applied", updatedAt: now })
    .where(eq(issues.id, open.id));
}

async function settleFulfilledOutsideIssue(tx: DbOrTx, orderId: string) {
  const now = new Date();
  await tx
    .update(issues)
    .set({ status: "resolved", resolvedAt: now, resolvedBy: SYSTEM_ACTOR.id, resolution: "shopify_applied", updatedAt: now })
    .where(and(eq(issues.orderId, orderId), eq(issues.status, "open"), eq(issues.code, "SHOPIFY_FULFILLED_OUTSIDE_APP")));
}

async function openSyncIssue(
  tx: DbOrTx,
  orderId: string,
  code:
    | "SHOPIFY_ORDER_CHANGED"
    | "SHOPIFY_SYNC_FAILED"
    | "SHOPIFY_CANCELLED_AFTER_SHIPMENT"
    | "SHOPIFY_COUNTRY_NOT_SHIPPED"
    | "SHOPIFY_FULFILLED_OUTSIDE_APP",
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
    severity: code === "SHOPIFY_ORDER_CHANGED" || code === "SHOPIFY_FULFILLED_OUTSIDE_APP" ? "warning" : "error",
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
 *   у Shopify локальних підтверджених змін; інакше — проблема «дані змінено в Shopify». Зміною Shopify вважається лише
 *   поле, яке змінив Shopify (порівняння з orders.shopify_contact_snapshot — fieldsUnchangedInShopify), а не різниця від
 *   змін застосунку (автовиправлення не передаються в Shopify): вона не перезаписується й не повідомляється.
 * - Позиції (кількість, видалення, заміна — редагування замовлення в Shopify) оновлюються, поки замовлення можна
 *   редагувати й немає активної накладної (резерв складу змінюється різницею в тій самій транзакції); інакше —
 *   та сама проблема з полем lineItems (до передачі перевізнику) і позначка orders.shopify_lines_pending_at
 *   (pending-lines.server.ts: блокує нову накладну, переоформлення й ручну передачу). Скасування накладної ставить у
 *   чергу повторне читання; синхронізація, що застосувала позиції або побачила, що вони збігаються, знімає позначку й
 *   частину lineItems проблеми. Рівний updatedAt не вважається застарілим (повторне читання після скасування).
 * - Видалений у Shopify варіант (variant: null) зміною позиції не є: зв'язок із локальним варіантом зберігається.
 * - Виконання в Shopify не застосунком (до передачі перевізнику в застосунку) → проблема SHOPIFY_FULFILLED_OUTSIDE_APP:
 *   резерв лишається, доки менеджер не підтвердить передачу/«Відправлено поза застосунком» (списання) або не скасує
 *   замовлення. Нове замовлення, вже виконане (частково) в Shopify, автоматично НЕ обробляється (накладна була б
 *   повторним відправленням).
 */
export async function upsertOrder(
  ctx: ServiceContext,
  m: MappedOrder,
  mode: "live" | "import",
): Promise<{ result: OrderSyncResult; orderId: string | null }> {
  const outcome = await ctx.db.transaction(async (tx) => {
    const applied = await applyOrderInTx(tx, ctx, m, mode);
    // Етап 5: резерви складу — у тій самій транзакції, що й зміна замовлення (скасування — у cancelOrder нижче).
    if (applied.orderId && applied.result !== "stale") {
      await syncOrderReservations(tx, applied.orderId, SYSTEM_ACTOR);
    }
    return applied;
  });
  return finishUpsert(ctx, outcome);
}

async function applyOrderInTx(tx: Tx, ctx: ServiceContext, m: MappedOrder, mode: "live" | "import") {
  // FOR NO KEY UPDATE: не блокує перевірку зовнішніх ключів (вставки рухів складу цього замовлення в ініціалізації).
  const [existing] = await tx.select().from(orders).where(eq(orders.shopifyOrderId, m.shopifyOrderId)).for("no key update");
  const common = {
    financialStatus: m.financialStatus,
    fulfillmentStatus: m.fulfillmentStatus,
    shopifyShippableFulfilled: m.shippableFulfilled,
    currency: m.currency,
    subtotal: m.subtotal,
    shippingPaid: m.shippingPaid,
    total: m.total,
    billingCountryCode: m.billingCountryCode,
    shopifyUpdatedAt: m.shopifyUpdatedAt,
    // Що повідомив Shopify (і за якими значеннями наступне читання визначає зміни в Shopify — fieldsUnchangedInShopify).
    shopifyContactSnapshot: contactSnapshotOf(m),
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
    await replaceLineItems(tx, row!.id, m, { addedOnUpdate: false });
    await writeAudit(tx, SYSTEM_ACTOR, mode === "import" ? "shopify.order_imported" : "shopify.order_received", {
      type: "order",
      id: row!.id,
    }, { status, test: m.test });
    const fulfilledOutside = status !== "cancelled" && !isShipped(status) && fulfilledInShopify(m.fulfillmentStatus, m.shippableFulfilled);
    if (fulfilledOutside) {
      await openSyncIssue(tx, row!.id, "SHOPIFY_FULFILLED_OUTSIDE_APP", { status: m.fulfillmentStatus ?? "" });
    }
    // Уже виконане (частково) в Shopify — без автоматичної перевірки й накладної: рішення менеджера.
    return { result: "created" as const, orderId: row!.id, process: mode === "live" && status === "paid" && !fulfilledOutside };
  }

  if (existing.shopifyUpdatedAt && existing.shopifyUpdatedAt > m.shopifyUpdatedAt) {
    return { result: "stale" as const, orderId: existing.id, process: false };
  }
  await tx.update(orders).set({ ...common, updatedAt: new Date() }).where(eq(orders.id, existing.id));

  if (m.cancelledAt && existing.status !== "cancelled") {
    return { result: "cancelled" as const, orderId: existing.id, process: false, cancel: true };
  }

  // Зміни з Shopify — лише поля, які змінив сам Shopify (а не застосунок: автовиправлення тощо, fieldsUnchangedInShopify).
  const differing = CONTACT_FIELDS.map((f) => ({ ...f, from: (existing[f.column] as string | null) ?? null, to: f.get(m) })).filter(
    (c) => c.from !== c.to,
  );
  const appSide = await fieldsUnchangedInShopify(tx, existing, differing);
  const changes = differing.filter((c) => !appSide.has(c.field));
  const lineDiff = await diffLineItems(tx, existing.id, m);
  const open = existing.status !== "cancelled" && !isShipped(existing.status);
  // Нове виконання фізичних товарів у Shopify: змінився статус виконання або (за того самого часткового) Shopify уперше
  // виконав позиції з доставкою (раніше — лише цифрові, напр. подарункову картку).
  const fulfilledOutside =
    open &&
    fulfilledInShopify(m.fulfillmentStatus, m.shippableFulfilled) &&
    (existing.fulfillmentStatus !== m.fulfillmentStatus || !fulfilledInShopify(existing.fulfillmentStatus, existing.shopifyShippableFulfilled));
  const pendingBefore = existing.shopifyLinesPendingAt !== null;
  // Shopify більше не показує виконання фізичних товарів (скасовано виконання; або уточнено, що виконано лише цифрові
  // позиції, напр. подарункову картку) — попередження «виконано поза застосунком» уже не діє.
  if (
    open &&
    !fulfilledInShopify(m.fulfillmentStatus, m.shippableFulfilled) &&
    (existing.fulfillmentStatus !== m.fulfillmentStatus || existing.shopifyShippableFulfilled !== m.shippableFulfilled)
  ) {
    await settleFulfilledOutsideIssue(tx, existing.id);
  }
  if (!lineDiff.changed) await backfillLineDetails(tx, lineDiff.stored, m);
  if (changes.length === 0 && !lineDiff.changed && !fulfilledOutside) {
    // Позиції Shopify знову збігаються зі збереженими — неперенесених змін позицій більше немає.
    if (!pendingBefore) return { result: "unchanged" as const, orderId: existing.id, process: false };
    await setLinesPending(tx, existing.id, null);
    await settleShopifyChangedIssue(tx, existing.id, ["lineItems"]);
    return { result: "updated" as const, orderId: existing.id, process: false };
  }

  const linesEditable = VALIDATABLE_STATUSES.includes(existing.status) && !(await hasActiveShipment(tx, existing.id));
  const contactsEditable = linesEditable && !(await hasPendingPush(tx, m.shopifyOrderId));
  const reported: string[] = [];
  const history: Array<{ field: string; from: string | null; to: string | null }> = [];
  const patch: Record<string, string | null> = {};
  if (changes.length > 0) {
    if (contactsEditable) {
      for (const c of changes) {
        patch[c.column as string] = c.to;
        history.push({ field: c.field, from: c.from, to: c.to });
      }
    } else {
      reported.push(...changes.map((c) => c.field));
    }
  }
  const replaceLines = linesEditable && (lineDiff.changed || history.length > 0);
  if (lineDiff.changed) {
    if (linesEditable) history.push({ field: "lineItems", from: lineDiff.from, to: lineDiff.to });
    else if (open) reported.push("lineItems");
  }
  if (history.length > 0) {
    await tx
      .update(orders)
      .set({ ...patch, version: sql`${orders.version} + 1`, updatedAt: new Date() })
      .where(eq(orders.id, existing.id));
    await tx.insert(orderChanges).values(
      history.map((c) => ({
        orderId: existing.id,
        field: c.field,
        oldValue: c.from,
        newValue: c.to,
        source: "shopify_sync" as const,
        reason: "shopify.updated",
        actorId: SYSTEM_ACTOR.id,
      })),
    );
  }
  // Позиції оновлюються зі збереженням id; резерв складу — різницею (syncOrderReservations у upsertOrder).
  if (replaceLines) await replaceLineItems(tx, existing.id, m, { addedOnUpdate: true });
  // Позначка неперенесених позицій: ставиться, поки Shopify і застосунок розходяться, а застосувати не можна;
  // знімається, коли позиції застосовано або вони знову збігаються.
  const linesPendingNow = lineDiff.changed && !replaceLines && open;
  const linesSettled = pendingBefore && (replaceLines || !lineDiff.changed);
  if (linesPendingNow && !pendingBefore) await setLinesPending(tx, existing.id, new Date());
  else if (linesSettled) await setLinesPending(tx, existing.id, null);
  if (reported.length > 0) await openSyncIssue(tx, existing.id, "SHOPIFY_ORDER_CHANGED", { fields: reported.join(", ") });
  else await settleShopifyChangedIssue(tx, existing.id, [...history.map((h) => h.field), ...(linesSettled ? ["lineItems"] : [])]);
  if (fulfilledOutside) await openSyncIssue(tx, existing.id, "SHOPIFY_FULFILLED_OUTSIDE_APP", { status: m.fulfillmentStatus ?? "" });
  // Якщо замовлення вже перевірялося — перевіряємо повторно з новими даними.
  if (history.length > 0 && existing.status !== "paid") await validateOrderInTx(tx, { ...ctx, actor: SYSTEM_ACTOR }, existing.id, "after_edit");
  if (reported.length > 0 || fulfilledOutside) return { result: "conflict_reported" as const, orderId: existing.id, process: false };
  return { result: history.length > 0 || linesSettled ? ("updated" as const) : ("unchanged" as const), orderId: existing.id, process: false };
}

async function setLinesPending(tx: DbOrTx, orderId: string, at: Date | null) {
  await tx.update(orders).set({ shopifyLinesPendingAt: at, updatedAt: new Date() }).where(eq(orders.id, orderId));
}

async function finishUpsert(
  ctx: ServiceContext,
  outcome: Awaited<ReturnType<typeof applyOrderInTx>>,
): Promise<{ result: OrderSyncResult; orderId: string | null }> {
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

/**
 * Усі позиції замовлення: позиції НІКОЛИ не обрізаються. Після першої сторінки (ORDER_QUERY) наступні читаються
 * ORDER_LINE_ITEMS_PAGE_QUERY (after). Неповне читання — помилка, часткові позиції не зберігаються (склад резервував
 * би й списував неповні кількості, а зниклі позиції видалялися б):
 * - замовлення змінилося між сторінками (updatedAt) або зникло → повторювана помилка: завдання повториться зі свіжими даними;
 * - відповідь без курсора → неповторювана помилка відповіді;
 * - понад ORDER_LINE_ITEMS_MAX_PAGES сторінок → shopify.tooManyLineItems (замовлення — вручну).
 */
export async function readAllLineItems(admin: AdminGraphql, order: GqlOrder): Promise<GqlOrder> {
  let info = order.lineItems.pageInfo;
  if (!info?.hasNextPage) return order;
  const nodes = [...order.lineItems.nodes];
  for (let page = 1; info?.hasNextPage; page++) {
    if (page >= ORDER_LINE_ITEMS_MAX_PAGES) {
      throw new DomainError("shopify.tooManyLineItems", 422, { order: order.name, max: ORDER_LINE_ITEMS_MAX_PAGES * ORDER_LINE_ITEMS_PAGE_SIZE });
    }
    if (!info.endCursor) throw new ShopifyApiError("Shopify returned an incomplete line item page (no cursor)", false, "INCOMPLETE_LINE_ITEMS");
    const data: GqlOrderLineItemsPage = await admin<GqlOrderLineItemsPage>(ORDER_LINE_ITEMS_PAGE_QUERY, {
      id: order.id,
      first: ORDER_LINE_ITEMS_PAGE_SIZE,
      after: info.endCursor,
    });
    if (!data.order || data.order.updatedAt !== order.updatedAt) {
      throw new ShopifyApiError("Shopify order changed while its line items were being read", true, "ORDER_CHANGED_DURING_READ");
    }
    nodes.push(...data.order.lineItems.nodes);
    info = data.order.lineItems.pageInfo;
  }
  return { ...order, lineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
}

/**
 * Режим читання замовлення: live — webhook / повторне читання (застосовується завжди, рівний updatedAt теж — напр. після
 * скасування накладної); import — імпорт історії; refresh — планове страхове читання (fulfillment-refresh.server.ts):
 * застосовується лише те, що застосунок пропустив.
 */
export type OrderSyncMode = "live" | "import" | "refresh";

/**
 * refresh: чи є в Shopify щось, чого застосунок ще не бачив. Shopify (Order.updatedAt, 2026-10): «The date and time ...
 * when the order was last modified.»; orders/updated: «Occurs whenever an order is updated.» — загублений webhook означає
 * новіший updatedAt. Додатково — інший статус виконання (саме його й перевіряє планове читання). Інакше нічого не
 * застосовується: повторне застосування тих самих даних нічого б не дало (і раніше відтворювало закриті менеджером
 * проблеми). Замовлення, якого немає в застосунку, плановим читанням не створюється (це не webhook нового замовлення).
 */
async function refreshFindsNews(db: DbOrTx, order: GqlOrder): Promise<{ news: boolean; orderId: string | null }> {
  const [row] = await db
    .select({ id: orders.id, shopifyUpdatedAt: orders.shopifyUpdatedAt, fulfillmentStatus: orders.fulfillmentStatus })
    .from(orders)
    .where(eq(orders.shopifyOrderId, order.id));
  if (!row) return { news: false, orderId: null };
  const updatedAt = new Date(order.updatedAt);
  const newer = !row.shopifyUpdatedAt || Number.isNaN(updatedAt.getTime()) || updatedAt.getTime() > row.shopifyUpdatedAt.getTime();
  const fulfillment = order.displayFulfillmentStatus?.toLowerCase() ?? null;
  return { news: newer || fulfillment !== row.fulfillmentStatus, orderId: row.id };
}

/** Перечитує замовлення з Shopify і застосовує. Невідомі варіанти спершу синхронізуються як товари. */
export async function syncOrder(
  ctx: ServiceContext,
  admin: AdminGraphql,
  orderGid: string,
  mode: OrderSyncMode,
): Promise<{ result: OrderSyncResult; orderId: string | null }> {
  const data = await admin<{ order: GqlOrder | null }>(ORDER_QUERY, { id: orderGid });
  if (!data.order) return { result: "unchanged", orderId: null };
  if (mode === "refresh") {
    const check = await refreshFindsNews(ctx.db, data.order);
    if (!check.news) return { result: "unchanged", orderId: check.orderId };
  }
  return applyOrder(ctx, admin, await readAllLineItems(admin, data.order), mode === "refresh" ? "live" : mode);
}

/** Замовлення зі сторінки списку (імпорт): позиції, що не вмістилися, — повторне читання замовлення й сторінки позицій. */
async function applyListedOrder(ctx: ServiceContext, admin: AdminGraphql, order: GqlOrder, mode: "live" | "import") {
  if (!order.lineItems.pageInfo?.hasNextPage) return applyOrder(ctx, admin, order, mode);
  // Свіжий знімок замовлення (updatedAt, з яким звіряються наступні сторінки позицій).
  const full = await admin<{ order: GqlOrder | null }>(ORDER_QUERY, { id: order.id });
  if (!full.order) return { result: "unchanged" as const, orderId: null };
  return applyOrder(ctx, admin, await readAllLineItems(admin, full.order), mode);
}

/** order — з УСІМА позиціями (readAllLineItems). */
async function applyOrder(ctx: ServiceContext, admin: AdminGraphql, order: GqlOrder, mode: "live" | "import") {
  if (order.lineItems.pageInfo?.hasNextPage) throw new ShopifyApiError("Order line items were not read completely", false, "INCOMPLETE_LINE_ITEMS");
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
    first: ORDERS_PAGE_SIZE,
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
      const r = await applyListedOrder(ctx, admin, order, "import");
      if (r.result === "created") imported++;
      else if (r.result === "skipped_unpaid") skipped++;
      else updated++;
    } catch (e) {
      if (failed.length < 50) failed.push(order.name);
      await enqueueJob(ctx.db, JOB.syncOrder, { shop: payload.shop, orderGid: order.id, mode: "import" }, { dedupeKey: orderSyncDedupeKey(order.id) });
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
      .set({ scopes, uninstalledAt: null, updatedAt: new Date() })
      .where(eq(shopInstallations.shop, shop));
  } else {
    // Час реєстрації підписок записує recordWebhookRegistration (лише після підтвердження Shopify).
    await db.insert(shopInstallations).values({ shop, scopes });
  }
  const firstSync = !existing?.productsSyncedAt;
  if (firstSync) await enqueueJob(db, JOB.productsPage, { shop, after: null }, { dedupeKey: "products:start" });
  return { firstSync };
}

export async function recordUninstall(db: DbOrTx, shop: string) {
  // Підписки застосунку після видалення недійсні: повторне встановлення перереєструє їх (і завдання перевірки теж).
  await db
    .update(shopInstallations)
    .set({ uninstalledAt: new Date(), webhooksConfigKey: null, updatedAt: new Date() })
    .where(eq(shopInstallations.shop, shop));
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

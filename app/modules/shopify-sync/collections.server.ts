/**
 * Етап 5: синхронізація колекцій Shopify (ручних і автоматичних) і членства товарів — для шаблонів комплектації
 * «на колекцію» (modules/packaging/kit-resolution.ts). Дозвіл read_products (Collection, Product.collections,
 * webhooks collections/*) — уже є; нових дозволів не потрібно. Факти перевірено на shopify.dev (2026-10).
 *
 * Хто змінює членство (product_collections) — ЛИШЕ applyProductCollections: повний перелік колекцій ОДНОГО товару,
 * прочитаний за один прохід (Product.collections), замінює його членство. Старіше читання новішого не перезаписує
 * (products.collections_synced_at — момент перед читанням; рядок товару блокується FOR UPDATE).
 *
 * Коли перечитується членство товару:
 * - products/create, products/update (і inventory_levels/update → синхронізація товару): після збереження товару.
 *   Це покриває автоматичні колекції: Shopify НЕ надсилає collections/update, коли товар починає/перестає
 *   відповідати умовам колекції через зміну самого товару («Not fired when attribute changes affect whether a product
 *   matches a collection's rules»), але products/update приходить.
 * - collections/create|update (ручне додавання/вилучення товарів, зміна умов): читається перелік товарів колекції,
 *   і для товарів, членство яких розходиться з базою, ставиться перечитування їхніх колекцій. Shopify оновлює членство
 *   за умовами/джерелами колекції асинхронно («might be processed asynchronously», Job — Collection, collectionUpdate,
 *   2026-10), а нового webhook після завершення не надсилає, тож колекція перечитується ще через 2 і 15 хв
 *   (scheduleCollectionSync).
 * - Повна синхронізація (після повної синхронізації товарів, щодня за розкладом або кнопкою власника): список колекцій
 *   (назви, виявлення видалених без webhook) → сторінки «товари з колекціями».
 * - collections/delete: колекцію позначено видаленою (deleted_at), членство прибрано; шаблони, що на неї посилалися,
 *   лишаються й показують це (ціль не змінюється мовчки).
 *
 * Членство 2026-10 може бути на рівні варіантів (Product.variantsInCollection). Тут воно на рівні товару: товар
 * у колекції — усі його варіанти (для варіантів — фільтр моделі/кольору шаблону). Обмеження задокументоване.
 */
import { and, desc, eq, inArray, isNotNull, isNull, lt, notInArray, or, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import { collections, jobs, productCollections, products, shopInstallations } from "~/db/schema";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  COLLECTION_PRODUCTS_QUERY,
  COLLECTIONS_PAGE_QUERY,
  PRODUCT_COLLECTIONS_QUERY,
  PRODUCT_MEMBERSHIPS_PAGE_QUERY,
  type GqlCollection,
  type GqlCollectionConnection,
  type PageInfo,
} from "~/integrations/shopify/graphql";
import { enqueueJob } from "~/modules/jobs/queue.server";
import { logger } from "~/lib/logger.server";
import { JOB } from "./jobs";

/** Розміри сторінок (вартість запиту < 1000 балів; див. graphql.ts). */
export const PRODUCT_COLLECTIONS_PAGE_SIZE = 50;
export const COLLECTIONS_PAGE_SIZE = 100;
export const COLLECTION_PRODUCTS_PAGE_SIZE = 250;
export const MEMBERSHIP_PRODUCTS_PAGE_SIZE = 25;
export const MEMBERSHIP_COLLECTIONS_FIRST = 20;
/** Запобіжник від нескінченної пагінації (некоректна відповідь): до 2 000 колекцій товару, 50 000 товарів колекції. */
const MAX_PRODUCT_COLLECTION_PAGES = 40;
const MAX_COLLECTION_PRODUCT_PAGES = 200;

export const productCollectionsDedupeKey = (productGid: string) => `product-collections:${productGid}`;
export const collectionSyncDedupeKey = (collectionGid: string) => `collection:${collectionGid}`;
export const collectionRecheckDedupeKey = (collectionGid: string, delayMs: number) =>
  `collection:${collectionGid}:recheck:${Math.round(delayMs / 60_000)}m`;

/**
 * Повторні читання колекції після webhook collections/create|update. Shopify: коли членство змінюється через умови,
 * джерела чи правила колекції, «the operation might be processed asynchronously» (Job; Collection і collectionUpdate,
 * 2026-10). Читання одразу після webhook може повернути старий перелік (для нової автоматичної колекції — порожній),
 * а наступного webhook не буде: collections/update не надсилається, коли товар починає/перестає відповідати умовам,
 * і товари не змінювалися (products/update теж немає). Стан цього Job ззовні не видно (Collection.activeOperations —
 * лише дублювання колекцій), тож колекцію перечитують ще двічі. Решту (дуже довга обробка в Shopify) ловить щоденна
 * повна синхронізація (runScheduledCollectionsSync).
 */
export const COLLECTION_RECHECK_DELAYS_MS = [2 * 60_000, 15 * 60_000] as const;
/** Повторний webhook відкладає вже заплановану перевірку, але не далі ніж на годину від її створення. */
export const COLLECTION_RECHECK_MAX_DEFER_MS = 60 * 60_000;

/** Щоденна повна синхронізація колекцій (страховка: асинхронна обробка умов у Shopify, загублені webhooks). */
export const SCHEDULED_COLLECTIONS_SYNC_DEDUPE_KEY = "collections:scheduled";
export const SCHEDULED_COLLECTIONS_SYNC_INTERVAL_MS = 24 * 60 * 60_000;
/** Перша планова перевірка після старту сервера (якщо в черзі ще немає запланованої). */
export const SCHEDULED_COLLECTIONS_SYNC_FIRST_DELAY_MS = 60 * 60_000;

const iso = (d: Date) => d.toISOString();

/**
 * Назви колекцій (за GID). Новіші дані Shopify (updatedAt) не перезаписуються старішими; last_seen_at — коли колекцію
 * востаннє бачили наявною (для виявлення видалених); позначка «видалено» знімається лише читанням, яке почалося
 * ПІСЛЯ неї (старе читання не «воскрешає» видалену колекцію). Повертає id у базі за GID.
 */
export async function upsertCollections(tx: DbOrTx, nodes: readonly GqlCollection[], fetchedAt: Date): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = new Map(nodes.map((n) => [n.id, n]));
  for (const n of unique.values()) {
    const updatedAt = new Date(n.updatedAt);
    const newer = sql`(${collections.shopifyUpdatedAt} is null or excluded.shopify_updated_at >= ${collections.shopifyUpdatedAt})`;
    const [row] = await tx
      .insert(collections)
      .values({
        shopifyCollectionId: n.id,
        title: n.title,
        handle: n.handle || null,
        shopifyUpdatedAt: Number.isNaN(updatedAt.getTime()) ? null : updatedAt,
        lastSeenAt: fetchedAt,
      })
      .onConflictDoUpdate({
        target: collections.shopifyCollectionId,
        set: {
          title: sql`case when ${newer} then excluded.title else ${collections.title} end`,
          handle: sql`case when ${newer} then excluded.handle else ${collections.handle} end`,
          shopifyUpdatedAt: sql`greatest(${collections.shopifyUpdatedAt}, excluded.shopify_updated_at)`,
          lastSeenAt: sql`greatest(${collections.lastSeenAt}, excluded.last_seen_at)`,
          deletedAt: sql`case when ${collections.deletedAt} is not null and ${collections.deletedAt} < ${iso(fetchedAt)}::timestamptz then null else ${collections.deletedAt} end`,
          updatedAt: new Date(),
        },
      })
      .returning({ id: collections.id });
    out.set(n.id, row!.id);
  }
  return out;
}

export type ApplyMembershipResult = "saved" | "stale" | "unknown_product";

/**
 * Повний перелік колекцій товару (прочитаний починаючи з fetchedAt) → членство товару. Товар, якого ще немає в базі,
 * пропускається (його синхронізація сама перечитає колекції).
 */
export async function applyProductCollections(
  db: DbOrTx,
  productGid: string,
  nodes: readonly GqlCollection[],
  fetchedAt: Date,
): Promise<ApplyMembershipResult> {
  return db.transaction(async (tx) => {
    const [product] = await tx
      .select({ id: products.id, syncedAt: products.collectionsSyncedAt })
      .from(products)
      .where(eq(products.shopifyProductId, productGid))
      .for("update");
    if (!product) return "unknown_product";
    if (product.syncedAt && product.syncedAt > fetchedAt) return "stale";
    const ids = [...(await upsertCollections(tx, nodes, fetchedAt)).values()];
    await tx
      .delete(productCollections)
      .where(and(eq(productCollections.productId, product.id), ids.length ? notInArray(productCollections.collectionId, ids) : undefined));
    if (ids.length) {
      await tx
        .insert(productCollections)
        .values(ids.map((collectionId) => ({ productId: product.id, collectionId })))
        .onConflictDoNothing();
    }
    await tx.update(products).set({ collectionsSyncedAt: fetchedAt }).where(eq(products.id, product.id));
    return "saved";
  });
}

/** Перечитує всі колекції товару й застосовує їх (завдання shopify.sync_product_collections і після синхронізації товару). */
export async function syncProductCollections(db: Db, admin: AdminGraphql, productGid: string): Promise<ApplyMembershipResult | "deleted"> {
  const fetchedAt = new Date();
  const nodes: GqlCollection[] = [];
  let after: string | null = null;
  for (let page = 0; page < MAX_PRODUCT_COLLECTION_PAGES; page++) {
    const data: { product: { id: string; collections: GqlCollectionConnection } | null } = await admin(PRODUCT_COLLECTIONS_QUERY, {
      id: productGid,
      first: PRODUCT_COLLECTIONS_PAGE_SIZE,
      after,
    });
    if (!data.product) return "deleted";
    nodes.push(...data.product.collections.nodes);
    const info = data.product.collections.pageInfo;
    if (!info.hasNextPage || !info.endCursor) {
      after = null;
      break;
    }
    after = info.endCursor;
  }
  if (after) throw new Error("product collections: too many pages");
  return applyProductCollections(db, productGid, nodes, fetchedAt);
}

export function enqueueProductCollectionsSync(db: DbOrTx, shop: string, productGid: string): Promise<boolean> {
  return enqueueJob(db, JOB.syncProductCollections, { shop, productGid }, { dedupeKey: productCollectionsDedupeKey(productGid) });
}

/** Колекцію видалено в Shopify (webhook collections/delete або не знайдено під час читання). */
export async function markCollectionDeleted(db: DbOrTx, collectionGid: string, at: Date = new Date()): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(collections)
      .set({ deletedAt: at, updatedAt: at })
      .where(and(eq(collections.shopifyCollectionId, collectionGid), isNull(collections.deletedAt)))
      .returning({ id: collections.id });
    if (rows.length === 0) return false;
    await tx.delete(productCollections).where(inArray(productCollections.collectionId, rows.map((r) => r.id)));
    return true;
  });
}

/**
 * Webhook collections/create|update: читання колекції зараз і дві відкладені перевірки (COLLECTION_RECHECK_DELAYS_MS;
 * окремі dedupe-ключі — читання «зараз», що вже чекає в черзі, їх не поглинає). Повертає true, якщо поставлено
 * нове читання «зараз».
 */
export async function scheduleCollectionSync(db: DbOrTx, shop: string, collectionGid: string, now: Date = new Date()): Promise<boolean> {
  const queued = await enqueueJob(db, JOB.syncCollection, { shop, collectionGid }, { dedupeKey: collectionSyncDedupeKey(collectionGid) });
  const payload = JSON.stringify({ shop, collectionGid, recheck: true });
  for (const delayMs of COLLECTION_RECHECK_DELAYS_MS) {
    const runAt = new Date(now.getTime() + delayMs).toISOString();
    await db.execute(sql`
      insert into ${jobs} (type, payload, dedupe_key, run_at, max_attempts)
      values (${JOB.syncCollection}, ${payload}::jsonb, ${collectionRecheckDedupeKey(collectionGid, delayMs)}, ${runAt}::timestamptz, 6)
      on conflict (dedupe_key) where status = 'queued'
      do update set run_at = least(greatest(${jobs.runAt}, excluded.run_at),
                                   ${jobs.createdAt} + ${`${COLLECTION_RECHECK_MAX_DEFER_MS} milliseconds`}::interval),
                    updated_at = now()`);
  }
  return queued;
}

/**
 * Webhook collections/create|update: назва колекції і товари, членство яких у базі розходиться з Shopify (додані або
 * вилучені вручну, змінені умови) → перечитування колекцій цих товарів (через applyProductCollections). Невідомі базі
 * товари пропускаються (їхня синхронізація перечитає колекції сама).
 */
export async function syncCollection(
  db: Db,
  admin: AdminGraphql,
  shop: string,
  collectionGid: string,
): Promise<{ result: "synced" | "deleted"; queued: number }> {
  const fetchedAt = new Date();
  const productGids = new Set<string>();
  let meta: GqlCollection | null = null;
  let after: string | null = null;
  for (let page = 0; page < MAX_COLLECTION_PRODUCT_PAGES; page++) {
    const data: { collection: (GqlCollection & { products: { pageInfo: PageInfo; nodes: Array<{ id: string }> } }) | null } = await admin(
      COLLECTION_PRODUCTS_QUERY,
      { id: collectionGid, first: COLLECTION_PRODUCTS_PAGE_SIZE, after },
    );
    if (!data.collection) {
      await markCollectionDeleted(db, collectionGid);
      return { result: "deleted", queued: 0 };
    }
    meta = { id: data.collection.id, title: data.collection.title, handle: data.collection.handle, updatedAt: data.collection.updatedAt };
    for (const p of data.collection.products.nodes) productGids.add(p.id);
    const info = data.collection.products.pageInfo;
    if (!info.hasNextPage || !info.endCursor) {
      after = null;
      break;
    }
    after = info.endCursor;
  }
  if (after) throw new Error("collection products: too many pages");
  const localId = (await upsertCollections(db, [meta!], fetchedAt)).get(meta!.id)!;

  const members = await db
    .select({ gid: products.shopifyProductId })
    .from(productCollections)
    .innerJoin(products, eq(products.id, productCollections.productId))
    .where(and(eq(productCollections.collectionId, localId), isNotNull(products.shopifyProductId)));
  const memberGids = new Set(members.map((m) => m.gid!));
  const candidates = [...productGids].filter((g) => !memberGids.has(g));
  const known = new Set<string>();
  for (let i = 0; i < candidates.length; i += 500) {
    const chunk = candidates.slice(i, i + 500);
    const rows = await db.select({ gid: products.shopifyProductId }).from(products).where(inArray(products.shopifyProductId, chunk));
    for (const r of rows) if (r.gid) known.add(r.gid);
  }
  const changed = [...known, ...[...memberGids].filter((g) => !productGids.has(g))];
  for (const gid of changed) await enqueueProductCollectionsSync(db, shop, gid);
  return { result: "synced", queued: changed.length };
}

// ---------------------------------------------------------------------------
// Повна синхронізація
// ---------------------------------------------------------------------------

/** Запуск повної синхронізації колекцій (після повної синхронізації товарів, за розкладом або кнопкою власника). */
export function startCollectionsSync(db: DbOrTx, shop: string, now: Date = new Date()): Promise<boolean> {
  return enqueueJob(db, JOB.collectionsPage, { shop, after: null, startedAt: iso(now) }, { dedupeKey: "collections:start" });
}

/** Повна синхронізація колекцій уже в черзі або виконується (будь-яка її сторінка). */
export async function collectionsSyncActive(db: DbOrTx): Promise<boolean> {
  const [row] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(inArray(jobs.type, [JOB.collectionsPage, JOB.collectionMembershipsPage]), inArray(jobs.status, ["queued", "running"])))
    .limit(1);
  return Boolean(row);
}

/**
 * Наступна планова перевірка (одне очікуване завдання; уже заплановане не переноситься — перезапуск сервера не
 * відкладає і не множить синхронізації).
 */
export function scheduleCollectionsSyncCheck(db: DbOrTx, opts: { now?: Date; delayMs?: number } = {}): Promise<boolean> {
  const now = opts.now ?? new Date();
  return enqueueJob(db, JOB.scheduledCollectionsSync, {}, {
    dedupeKey: SCHEDULED_COLLECTIONS_SYNC_DEDUPE_KEY,
    maxAttempts: 3,
    runAt: new Date(now.getTime() + (opts.delayMs ?? SCHEDULED_COLLECTIONS_SYNC_INTERVAL_MS)),
  });
}

export type ScheduledCollectionsSyncOutcome = "queued" | "not_installed" | "not_ready" | "already_running";

/**
 * Обробник щоденної перевірки: спершу планує наступну (ланцюжок не обривається), потім ставить повну синхронізацію
 * колекцій — коли застосунок установлено, перша повна синхронізація товарів завершилася (вона сама запускає
 * колекції) і повна синхронізація колекцій ще не йде.
 */
export async function runScheduledCollectionsSync(db: DbOrTx, now: Date = new Date()): Promise<ScheduledCollectionsSyncOutcome> {
  await scheduleCollectionsSyncCheck(db, { now });
  const [shop] = await db
    .select({ shop: shopInstallations.shop, productsSyncedAt: shopInstallations.productsSyncedAt })
    .from(shopInstallations)
    .where(isNull(shopInstallations.uninstalledAt))
    .orderBy(desc(shopInstallations.installedAt))
    .limit(1);
  if (!shop) return "not_installed";
  if (!shop.productsSyncedAt) return "not_ready";
  if (await collectionsSyncActive(db)) return "already_running";
  await startCollectionsSync(db, shop.shop, now);
  return "queued";
}

/**
 * Сторінка списку колекцій. Після останньої: колекції, яких не бачили від початку цієї синхронізації (і створені до
 * неї), позначаються видаленими (видалення без webhook — напр., застосунок не працював); далі — членство товарів.
 */
export async function syncCollectionsPage(db: Db, admin: AdminGraphql, shop: string, after: string | null, startedAt: Date) {
  const fetchedAt = new Date();
  const data: { collections: GqlCollectionConnection } = await admin(COLLECTIONS_PAGE_QUERY, { first: COLLECTIONS_PAGE_SIZE, after });
  await db.transaction((tx) => upsertCollections(tx, data.collections.nodes, fetchedAt));
  const info = data.collections.pageInfo;
  if (info.hasNextPage && info.endCursor) {
    await enqueueJob(db, JOB.collectionsPage, { shop, after: info.endCursor, startedAt: iso(startedAt) }, { dedupeKey: `collections:${info.endCursor}` });
    return { nodes: data.collections.nodes.length, removed: 0 };
  }
  const removed = await db.transaction(async (tx) => {
    const gone = await tx
      .update(collections)
      .set({ deletedAt: fetchedAt, updatedAt: fetchedAt })
      .where(
        and(
          isNotNull(collections.shopifyCollectionId),
          isNull(collections.deletedAt),
          lt(collections.createdAt, startedAt),
          or(isNull(collections.lastSeenAt), lt(collections.lastSeenAt, startedAt)),
        ),
      )
      .returning({ id: collections.id });
    if (gone.length) await tx.delete(productCollections).where(inArray(productCollections.collectionId, gone.map((g) => g.id)));
    return gone.length;
  });
  if (removed > 0) logger.info("shopify.collections_removed", { removed });
  await enqueueJob(db, JOB.collectionMembershipsPage, { shop, after: null }, { dedupeKey: "collection-memberships:start" });
  return { nodes: data.collections.nodes.length, removed };
}

/** Сторінка «товари з колекціями»: членство кожного товару (товар із понад 20 колекціями — окремим завданням). */
export async function syncCollectionMembershipsPage(db: Db, admin: AdminGraphql, shop: string, after: string | null) {
  const fetchedAt = new Date();
  const data: { products: { pageInfo: PageInfo; nodes: Array<{ id: string; collections: GqlCollectionConnection }> } } = await admin(
    PRODUCT_MEMBERSHIPS_PAGE_QUERY,
    { first: MEMBERSHIP_PRODUCTS_PAGE_SIZE, after, collectionsFirst: MEMBERSHIP_COLLECTIONS_FIRST },
  );
  let applied = 0;
  for (const p of data.products.nodes) {
    if (p.collections.pageInfo.hasNextPage) {
      await enqueueProductCollectionsSync(db, shop, p.id);
      continue;
    }
    if ((await applyProductCollections(db, p.id, p.collections.nodes, fetchedAt)) === "saved") applied += 1;
  }
  const info = data.products.pageInfo;
  if (info.hasNextPage && info.endCursor) {
    await enqueueJob(db, JOB.collectionMembershipsPage, { shop, after: info.endCursor }, { dedupeKey: `collection-memberships:${info.endCursor}` });
  } else {
    await db.update(shopInstallations).set({ collectionsSyncedAt: new Date(), updatedAt: new Date() }).where(eq(shopInstallations.shop, shop));
  }
  return { products: data.products.nodes.length, applied };
}

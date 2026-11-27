import type { Db } from "~/db/client.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { adminClientFor, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { SHOP_CURRENCY_QUERY } from "~/integrations/shopify/graphql";
import type { JobHandlers } from "~/modules/jobs/worker.server";
import type { ServiceContext } from "~/server/types";
import { runTrackingPollJob } from "~/modules/tracking/tracking.server";
import { createInventorySyncHandlers } from "~/modules/inventory-sync/handlers.server";
import { logger } from "~/lib/logger.server";
import {
  markCollectionDeleted,
  syncCollection,
  syncCollectionMembershipsPage,
  syncCollectionsPage,
  syncProductCollections,
} from "./collections.server";
import { fulfillShipment, reportFulfillmentFailure } from "./fulfillment.server";
import { openNewVariantsFromShopify } from "./inventory-opening.server";
import {
  JOB,
  importOrdersPage,
  markProductDeleted,
  pushOrderChanges,
  reportPushFailure,
  syncInventoryItem,
  syncOrder,
  syncProduct,
  syncProductsPage,
} from "./sync.server";

export interface SyncDeps {
  db: Db;
  /** Контекст сервісів (перевізники, шлюз Shopify) для обробки нових оплачених замовлень. */
  serviceContext: () => ServiceContext;
  admin: (shop: string) => Promise<AdminGraphql>;
}

const currencyCache = new Map<string, string>();

async function shopCurrency(admin: AdminGraphql, shop: string): Promise<string> {
  const cached = currencyCache.get(shop);
  if (cached) return cached;
  const data = await admin<{ shop: { currencyCode: string } }>(SHOP_CURRENCY_QUERY);
  currencyCache.set(shop, data.shop.currencyCode);
  return data.shop.currencyCode;
}

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Етап 5 (gap-14): варіанти, що з'явилися після ініціалізації складу, відкриваються тією самою формулою (знімок локації
 * складу). Збій відкриття не зриває синхронізацію товару: варіант лишається «невідкритим» (видно на сторінці «Склад»),
 * наступна синхронізація товару спробує знову.
 */
async function autoOpenNewVariants(db: Db, admin: AdminGraphql, productGid: string | null) {
  try {
    const r = await openNewVariantsFromShopify(db, admin, productGid);
    if (r && r.opened > 0) logger.info("inventory.auto_opened", { opened: r.opened, notStocked: r.skippedNotStocked });
  } catch (e) {
    logger.warn("inventory.auto_open_failed", { error: e });
  }
}

/** Обробники фонових завдань синхронізації Shopify. */
export function createSyncHandlers(deps: SyncDeps): JobHandlers {
  const ctx = () => ({ ...deps.serviceContext(), actor: SYSTEM_ACTOR });
  return {
    [JOB.syncOrder]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const admin = await deps.admin(String(p.shop));
        await syncOrder(ctx(), admin, String(p.orderGid), p.mode === "import" ? "import" : "live");
      },
    },
    [JOB.syncProduct]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const shop = String(p.shop);
        const admin = await deps.admin(shop);
        const productGid = String(p.productGid);
        const result = await syncProduct(deps.db, admin, productGid, await shopCurrency(admin, shop));
        if (result === "saved") await autoOpenNewVariants(deps.db, admin, productGid);
        // Етап 5: колекції товару (автоматичні колекції змінюються зі зміною товару — collections/update тоді не приходить).
        if (result !== "deleted") await syncProductCollections(deps.db, admin, productGid);
      },
    },
    [JOB.syncProductCollections]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        await syncProductCollections(deps.db, await deps.admin(String(p.shop)), String(p.productGid));
      },
    },
    [JOB.syncCollection]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const shop = String(p.shop);
        await syncCollection(deps.db, await deps.admin(shop), shop, String(p.collectionGid));
      },
    },
    [JOB.deleteCollection]: {
      run: async (job) => {
        await markCollectionDeleted(deps.db, String((job.payload as Record<string, unknown>).collectionGid));
      },
    },
    [JOB.collectionsPage]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const shop = String(p.shop);
        const startedAt = typeof p.startedAt === "string" && !Number.isNaN(Date.parse(p.startedAt)) ? new Date(p.startedAt) : job.createdAt;
        await syncCollectionsPage(deps.db, await deps.admin(shop), shop, str(p.after), startedAt);
      },
    },
    [JOB.collectionMembershipsPage]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const shop = String(p.shop);
        await syncCollectionMembershipsPage(deps.db, await deps.admin(shop), shop, str(p.after));
      },
    },
    [JOB.syncInventoryItem]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const shop = String(p.shop);
        await syncInventoryItem(deps.db, await deps.admin(shop), shop, String(p.inventoryItemGid));
      },
    },
    [JOB.deleteProduct]: {
      run: async (job) => markProductDeleted(deps.db, String((job.payload as Record<string, unknown>).productGid)),
    },
    [JOB.productsPage]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const shop = String(p.shop);
        const admin = await deps.admin(shop);
        await syncProductsPage(deps.db, admin, shop, str(p.after), await shopCurrency(admin, shop));
        await autoOpenNewVariants(deps.db, admin, null);
      },
    },
    [JOB.importOrdersPage]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        const admin = await deps.admin(String(p.shop));
        await importOrdersPage(ctx(), admin, {
          shop: String(p.shop),
          since: String(p.since),
          after: str(p.after),
          imported: Number(p.imported ?? 0),
          skipped: Number(p.skipped ?? 0),
          updated: Number(p.updated ?? 0),
          failed: Array.isArray(p.failed) ? p.failed.map(String) : [],
        });
      },
    },
    [JOB.pushOrder]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        await pushOrderChanges(deps.db, await deps.admin(String(p.shop)), String(p.shopifyOrderId));
      },
      onDead: async (job, error) => reportPushFailure(deps.db, String((job.payload as Record<string, unknown>).shopifyOrderId), error),
    },
    [JOB.fulfillShipment]: {
      run: async (job) => {
        const p = job.payload as Record<string, unknown>;
        await fulfillShipment(deps.db, await deps.admin(String(p.shop)), deps.serviceContext().carriers, {
          shopifyOrderId: String(p.shopifyOrderId),
          shipmentId: String(p.shipmentId),
        });
      },
      onDead: async (job, error) => reportFulfillmentFailure(deps.db, String((job.payload as Record<string, unknown>).shipmentId), error),
    },
    [JOB.trackingPoll]: {
      run: async () => {
        await runTrackingPollJob(ctx());
      },
    },
    // Етап 5: передача внутрішніх рухів у Shopify (inventory.push) і звірка залишків (inventory.reconcile).
    ...createInventorySyncHandlers({ db: deps.db, admin: deps.admin }),
  };
}

export const defaultAdmin = adminClientFor;

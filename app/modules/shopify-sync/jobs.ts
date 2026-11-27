/**
 * Типи фонових завдань синхронізації Shopify (без залежностей: модулі, що лише ставлять завдання в чергу, —
 * накладні, повторне читання замовлення — імпортують їх без циклів з sync.server.ts, який реекспортує JOB).
 */
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
  /** Етап 5: колекції товару (Product.collections) → product_collections (collections.server.ts). */
  syncProductCollections: "shopify.sync_product_collections",
  /** Етап 5: webhook collections/create|update — назва колекції й товари, членство яких змінилося. */
  syncCollection: "shopify.sync_collection",
  /** Етап 5: webhook collections/delete. */
  deleteCollection: "shopify.delete_collection",
  /** Етап 5: повна синхронізація колекцій — список колекцій (сторінка). */
  collectionsPage: "shopify.collections_page",
  /** Етап 5: повна синхронізація колекцій — членство товарів (сторінка). */
  collectionMembershipsPage: "shopify.collection_memberships_page",
} as const;

/** dedupeKey завдання синхронізації замовлення (webhooks, імпорт, повторне читання після скасування накладної). */
export function orderSyncDedupeKey(orderGid: string): string {
  return `order:${orderGid}`;
}

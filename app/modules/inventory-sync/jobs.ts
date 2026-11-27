/** Фонові завдання синхронізації залишків із Shopify (черга jobs, обробники — handlers.server.ts). */
export const INVENTORY_SYNC_JOB = {
  /** Передача внутрішніх рухів (shopify_sync_state = pending) у Shopify дельтою. */
  push: "inventory.push",
  /** Звірка залишків застосунку з Shopify: одна позиція (після webhook) або всі відкриті (сторінками). */
  reconcile: "inventory.reconcile",
  /** Планова повна звірка (страховка від загублених webhook): ставить повну звірку й планує наступну перевірку. */
  scheduledReconcile: "inventory.reconcile_scheduled",
} as const;

/** Одне очікуване завдання передачі (dedupe серед завдань у черзі). */
export const PUSH_DEDUPE_KEY = "inventory.push";
export const reconcileItemDedupeKey = (inventoryItemGid: string) => `inventory.reconcile:item:${inventoryItemGid}`;
export const reconcileAllDedupeKey = (after: string | null) => `inventory.reconcile:all:${after ?? "start"}`;

/** Звірка позиції після webhook inventory_levels/update — через ~10 хв (замовлення встигає синхронізуватися). */
export const RECONCILE_DELAY_MS = 10 * 60 * 1000;
/** Повторні webhook відкладають звірку (не довше ніж на 30 хв від першого). */
export const RECONCILE_MAX_DEFER_MS = 30 * 60 * 1000;
/** Скільки разів відкласти звірку позиції з неперенесеними рухами / змінами під час читання. */
export const RECONCILE_MAX_RESCHEDULES = 6;
/** Рухів за один запуск передачі (далі — наступне завдання). */
export const PUSH_BATCH = 50;
/**
 * Страховий обхід передачі: поки передачу ввімкнено (shopifyPush = deltas), завдання inventory.push повторюється
 * щонайменше раз на 5 хв — навіть якщо модуль, що створив рух, не поставив передачу в чергу; після вимкнення
 * передачі наступний обхід позначає очікувані рухи skipped і ланцюжок зупиняється.
 */
export const PUSH_SWEEP_MS = 5 * 60 * 1000;

/** Одне очікуване завдання планової звірки (ланцюжок). */
export const SCHEDULED_RECONCILE_DEDUPE_KEY = "inventory.reconcile_scheduled";
/**
 * Планова повна звірка — кожні 6 год: webhook inventory_levels/update не гарантовані (Shopify може не доставити
 * подію), тож розбіжність, яку не помітив webhook, з'явиться на сторінці «Звірка з Shopify» не пізніше ніж за 6 год.
 * Звірка лише читає Shopify; зміни застосовуються за тими самими правилами, що й ручна звірка (externalShopifyChanges).
 */
export const SCHEDULED_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Перша планова перевірка після старту сервера (якщо в черзі ще немає запланованої). */
export const SCHEDULED_RECONCILE_FIRST_DELAY_MS = 30 * 60 * 1000;
/** Хто «запросив» планову звірку (payload.requestedBy повної звірки). */
export const SCHEDULED_RECONCILE_REQUESTER = "system:scheduled";

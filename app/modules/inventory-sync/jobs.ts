/** Фонові завдання синхронізації залишків із Shopify (черга jobs, обробники — handlers.server.ts). */
export const INVENTORY_SYNC_JOB = {
  /** Передача внутрішніх рухів (shopify_sync_state = pending) у Shopify дельтою. */
  push: "inventory.push",
  /** Звірка залишків застосунку з Shopify: одна позиція (після webhook) або всі відкриті (сторінками). */
  reconcile: "inventory.reconcile",
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

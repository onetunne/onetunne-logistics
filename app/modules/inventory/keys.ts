/**
 * Ключі ідемпотентності руху залишків (inventory_movements.idempotency_key, UNIQUE).
 *
 * Правило: ключ однозначно визначає БІЗНЕС-ПОДІЮ, а не спробу її запису. Повтор тієї самої події (повторний webhook,
 * подвійне натискання, повтор завдання після збою) дає той самий ключ → другий рух не створюється.
 * Події, які можуть законно повторюватися для того самого об'єкта (зміна кількості резерву), мають версію (seq).
 * Ключі з форм (ручні операції) — `manual:<uuid форми>`: uuid генерується під час відкриття форми, тож
 * подвійне надсилання тієї самої форми не дублює рух.
 */

const MAX_KEY_LENGTH = 200;

function key(...parts: Array<string | number>): string {
  const value = parts.map(String).join(":");
  if (value.length === 0 || value.length > MAX_KEY_LENGTH) throw new RangeError("invalid idempotency key length");
  return value;
}

export const inventoryKeys = {
  /** Початковий залишок позиції на складі — один раз назавжди. */
  opening: (warehouseId: string, stockItemId: string) => key("opening", warehouseId, stockItemId),
  /**
   * Корекція знімка для позиції замовлення, створеного ДО знімка Shopify, але вперше зарезервованого після відкриття
   * (пізній webhook, імпорт): Shopify уже вилучив її одиниці з «доступно» знімка → on_hand + q. Один раз на позицію.
   */
  openingLine: (lineItemId: string) => key("opening_line", lineItemId),
  /** Резерв позиції замовлення, версія seq (stock_reservations.seq після зміни). */
  reserve: (lineItemId: string, seq: number) => key("reserve", lineItemId, seq),
  /** Зняття резерву позиції, версія seq. */
  release: (lineItemId: string, seq: number) => key("release", lineItemId, seq),
  /** Списання продажу позиції — один раз на позицію замовлення. */
  consume: (lineItemId: string) => key("consume", lineItemId),
  /** Запуск виробництва позиції партії (version — production_batch_lines.version після зміни кількості). */
  productionStart: (batchLineId: string, version: number) => key("production_start", batchLineId, version),
  /** Надходження за рядком надходження (якісні + брак одним рухом). */
  productionReceipt: (receiptLineId: string) => key("receipt_production", receiptLineId),
  /** Закриття незавершеного залишку позиції партії — один раз на позицію. */
  productionClose: (batchLineId: string) => key("production_close", batchLineId),
  /** Витрата матеріалу на пакування — один раз на (пакування, матеріал). */
  materialConsume: (packingId: string, materialId: string) => key("material", packingId, materialId),
  /** Прийняте значення Shopify для розбіжності — один раз на розбіжність. */
  shopifyExternal: (conflictId: string) => key("shopify_external", conflictId),
  /** Ручна операція з форми/команди (uuid генерується при відкритті форми або командою Telegram). */
  manual: (operationId: string, suffix?: string) => (suffix ? key("manual", operationId, suffix) : key("manual", operationId)),
  /**
   * Лише демо-дані: вигадана витрата матеріалу в історії демо (db/seed/demo-history.server.ts) — один раз на
   * (запис плану DEMO_MATERIAL_HISTORY, матеріал). Префікс demo_history: не збігається з жодною подією робочого режиму.
   */
  demoMaterialHistory: (planIndex: number, materialId: string) => key("demo_history", "material", planIndex, materialId),
} as const;

/** Префікс ключів вигаданої історії демо (перевірка «історію вже створено»). */
export const DEMO_HISTORY_KEY_PREFIX = "demo_history:";

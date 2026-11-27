/**
 * Типи руху залишків і правила їх дельт (чисті функції, без БД).
 *
 * Кожен тип може змінювати лише певні кошики й лише в певному напрямку. Так `reserved` змінюють ЛИШЕ
 * резерв/зняття резерву/списання продажу (syncOrderReservations), `in_production` — лише виробництво,
 * а ручне коригування не може «підправити» резерв. Порушення → DomainError("inventory.invalidMovement").
 */
import type { ShopifySyncState, StockItemKind } from "~/db/schema";
import { DomainError } from "~/lib/errors";

export const MOVEMENT_TYPES = [
  /** Початковий залишок (знімок Shopify) — один раз на позицію й склад. */
  "opening",
  /** Надходження з виробничої партії: on_hand + якісні, defective + брак, in_production − отримане. */
  "receipt_production",
  /** Надходження без партії (закупівля, повернення постачальником тощо). */
  "receipt_manual",
  /** Ручне коригування (інвентаризація, знахідка/нестача). */
  "adjustment",
  /** Резерв під оплачене замовлення (reserved +). */
  "reserve",
  /** Зняття резерву (скасування, зменшення кількості, видалення позиції). */
  "release",
  /** Списання продажу при фактичній передачі перевізнику: on_hand −, reserved −. */
  "consume_sale",
  /** Позначення браку/пошкодження: on_hand −, defective +. */
  "defect_mark",
  /** Списання браку (утилізація): defective −. */
  "defect_writeoff",
  /** Брак відремонтовано: defective −, on_hand +. */
  "defect_repair",
  /** Запуск виробництва: in_production +. */
  "production_start",
  /** Закриття залишку партії (не буде виготовлено): in_production −. */
  "production_close",
  /** Витрата пакувальних матеріалів при пакуванні: on_hand −. */
  "material_consume",
  /** Прийняте значення Shopify (розбіжність, зміна зроблена в Shopify не застосунком). */
  "shopify_external",
  /** Переміщення між складами (майбутнє): прихід / розхід. */
  "transfer_in",
  "transfer_out",
] as const;

export type MovementType = (typeof MOVEMENT_TYPES)[number];

export type Bucket = "onHand" | "reserved" | "defective" | "inProduction";
export const BUCKETS: readonly Bucket[] = ["onHand", "reserved", "defective", "inProduction"];

/** Дозволений напрямок дельти кошика: "+" — лише ≥ 0, "-" — лише ≤ 0, "±" — будь-який. Відсутній кошик — лише 0. */
type Sign = "+" | "-" | "±";

export interface MovementRule {
  buckets: Partial<Record<Bucket, Sign>>;
  /** Для яких видів позицій дозволено. */
  kinds: readonly StockItemKind[];
  /** on_hand може стати < 0 (подія вже фізично відбулася) — тоді відкривається попередження negative_on_hand. */
  negativeOnHand: boolean;
  /**
   * Зміна on_hand цим типом — внутрішня подія, про яку Shopify не знає (надходження, брак, коригування), тож її
   * можна надіслати в Shopify дельтою (налаштування warehouse.shopifyPush). false — Shopify знає сам (продаж →
   * committed, виконання → on_hand, знімок, зміна в Shopify) або on_hand не змінюється: не надсилається.
   */
  shopifyPushable: boolean;
}

const BOTH: readonly StockItemKind[] = ["product", "material"];
const PRODUCT: readonly StockItemKind[] = ["product"];

export const MOVEMENT_RULES: Readonly<Record<MovementType, MovementRule>> = {
  opening: { buckets: { onHand: "±" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: false },
  receipt_production: {
    buckets: { onHand: "+", defective: "+", inProduction: "-" },
    kinds: PRODUCT,
    negativeOnHand: false,
    shopifyPushable: true,
  },
  receipt_manual: { buckets: { onHand: "+", defective: "+" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: true },
  adjustment: { buckets: { onHand: "±", defective: "±" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: true },
  reserve: { buckets: { reserved: "+" }, kinds: PRODUCT, negativeOnHand: false, shopifyPushable: false },
  release: { buckets: { reserved: "-" }, kinds: PRODUCT, negativeOnHand: false, shopifyPushable: false },
  consume_sale: { buckets: { onHand: "-", reserved: "-" }, kinds: PRODUCT, negativeOnHand: true, shopifyPushable: false },
  defect_mark: { buckets: { onHand: "-", defective: "+" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: true },
  defect_writeoff: { buckets: { defective: "-" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: false },
  defect_repair: { buckets: { defective: "-", onHand: "+" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: true },
  production_start: { buckets: { inProduction: "+" }, kinds: PRODUCT, negativeOnHand: false, shopifyPushable: false },
  production_close: { buckets: { inProduction: "-" }, kinds: PRODUCT, negativeOnHand: false, shopifyPushable: false },
  material_consume: { buckets: { onHand: "-" }, kinds: ["material"], negativeOnHand: false, shopifyPushable: false },
  shopify_external: { buckets: { onHand: "±" }, kinds: PRODUCT, negativeOnHand: true, shopifyPushable: false },
  transfer_in: { buckets: { onHand: "+" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: true },
  transfer_out: { buckets: { onHand: "-" }, kinds: BOTH, negativeOnHand: false, shopifyPushable: true },
};

/**
 * Усі коди причин руху (inventory_movements.reason), які записує застосунок. Підпис — i18n `warehouse.reason.<код>`
 * (uk/en). Тест tests/stage5/movement-reasons.test.ts перевіряє переклади й те, що кожен літерал причини в модулях,
 * які створюють рухи, є в цьому переліку — новий код без перекладу не пройде перевірку.
 */
export const MOVEMENT_REASON_CODES = [
  // Склад, ручні операції (modules/warehouse/constants.ts: RECEIPT/DEFECT/WRITE_OFF_REASONS, STOCKTAKE/REPAIR_REASON)
  "customer_return",
  "purchase",
  "found",
  "other",
  "damaged_in_warehouse",
  "production",
  "disposed",
  "returned_to_manufacturer",
  "lost",
  "stocktake",
  "repaired",
  // Початкові залишки (inventory/opening.server.ts)
  "shopify_snapshot",
  "shopify_snapshot_clamped",
  // Резерви замовлень (inventory/reservations.server.ts)
  "order_paid",
  "order_cancelled",
  "quantity_changed",
  "variant_changed",
  "line_removed",
  "handed_over",
  "handed_over_unreserved",
  "snapshot_committed",
  // Виробництво (production/batches.server.ts)
  "batch_started",
  "batch_closed",
  "batch_cancelled",
  "production_receipt",
  "production_over_receipt",
  // Пакувальні матеріали (packaging/materials.server.ts, consumption.server.ts)
  "packing_box",
  "packing_kit",
  "material_receipt",
  "write_off",
  "correction",
  "stock_count",
  // Синхронізація залишків Shopify (inventory-sync/accept.server.ts, conflicts.server.ts)
  "shopify_conflict",
  "shopify_auto_accept",
  // Демо-дані
  "demo_seed",
] as const;
export type MovementReasonCode = (typeof MOVEMENT_REASON_CODES)[number];

export function isMovementReasonCode(value: unknown): value is MovementReasonCode {
  return typeof value === "string" && (MOVEMENT_REASON_CODES as readonly string[]).includes(value);
}

export function isMovementType(value: unknown): value is MovementType {
  return typeof value === "string" && (MOVEMENT_TYPES as readonly string[]).includes(value);
}

export interface MovementDeltas {
  onHand: number;
  reserved: number;
  defective: number;
  inProduction: number;
}

/** Перевіряє дельти руху за правилами типу. Кидає DomainError("inventory.invalidMovement"). */
export function assertMovementShape(type: MovementType, kind: StockItemKind, deltas: MovementDeltas): void {
  const rule = MOVEMENT_RULES[type];
  if (!rule) throw new DomainError("inventory.invalidMovement", 400, { type: String(type), bucket: "type" });
  if (!rule.kinds.includes(kind)) throw new DomainError("inventory.invalidMovement", 400, { type, bucket: "kind", kind });
  for (const bucket of BUCKETS) {
    const value = deltas[bucket];
    if (!Number.isSafeInteger(value)) throw new DomainError("inventory.invalidMovement", 400, { type, bucket });
    if (value === 0) continue;
    const sign = rule.buckets[bucket];
    if (!sign || (sign === "+" && value < 0) || (sign === "-" && value > 0)) {
      throw new DomainError("inventory.invalidMovement", 400, { type, bucket });
    }
  }
}

/**
 * Стан передачі руху в Shopify за замовчуванням:
 * - матеріали, рухи без зміни on_hand і події, про які Shopify знає сам → "none" (не надсилається ніколи);
 * - внутрішні зміни on_hand товару → "pending", якщо власник увімкнув передачу дельт (warehouse.shopifyPush = "deltas"),
 *   інакше "skipped" (зафіксовано, що не надсилалося; після ввімкнення старі рухи НЕ надсилаються).
 */
export function defaultShopifySyncState(
  type: MovementType,
  kind: StockItemKind,
  onHandDelta: number,
  pushMode: "off" | "deltas",
): ShopifySyncState {
  if (kind !== "product" || onHandDelta === 0 || !MOVEMENT_RULES[type].shopifyPushable) return "none";
  return pushMode === "deltas" ? "pending" : "skipped";
}

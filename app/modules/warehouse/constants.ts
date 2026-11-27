/**
 * Склад: константи операцій і сторінок (чистий модуль без БД — використовується і сервером, і інтерфейсом).
 *
 * Коди причин — короткі (inventory_movements.reason: [a-z0-9_.-], до 64 символів); підписи — i18n
 * `warehouse.reason.<код>`.
 */
import type { StockAlertKind, StockItemKind } from "~/db/schema";
import type { Permission } from "~/domain/permissions";

/** Надходження без виробничої партії. */
export const RECEIPT_REASONS = ["customer_return", "purchase", "found", "other"] as const;
export type ReceiptReason = (typeof RECEIPT_REASONS)[number];

/** Позначення браку (on_hand → defective): де/чому пошкоджено. */
export const DEFECT_REASONS = ["damaged_in_warehouse", "customer_return", "production", "other"] as const;
export type DefectReason = (typeof DEFECT_REASONS)[number];

/** Списання браку (defective −). */
export const WRITE_OFF_REASONS = ["disposed", "returned_to_manufacturer", "lost", "other"] as const;
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number];

/** Причини, які ставить сам застосунок (не вибираються у формах). */
export const STOCKTAKE_REASON = "stocktake";
export const REPAIR_REASON = "repaired";

/** Причини, для яких форма пропонує номер замовлення (повернення покупця). */
export const ORDER_LINKED_REASONS: readonly string[] = ["customer_return"];

/**
 * Надходження, які Shopify зазвичай поповнює сам (повернення покупця, оформлене в Shopify з поверненням на склад —
 * restock): за замовчуванням НЕ надсилаються в Shopify, щоб не було подвійного збільшення; надіслати — лише явним
 * вибором у формі («у Shopify повернення оформлено без поповнення»). Див. operations.server.ts.
 */
export const SHOPIFY_RESTOCK_REASONS: readonly ReceiptReason[] = ["customer_return"];

/** Кількість однієї операції: 1…MAX. Підрахунок інвентаризації: 0…MAX_COUNTED_QUANTITY. */
export const MAX_OPERATION_QUANTITY = 100_000;
export const MAX_COUNTED_QUANTITY = 1_000_000;
export const MAX_THRESHOLD = 100_000;
export const MAX_NOTE_LENGTH = 500;
/**
 * Валюта собівартості за замовчуванням (виробництво, матеріали, надходження на складі) — валюта витрат, а НЕ валюта
 * продажу в Shopify (EUR тощо): партії й матеріали оплачуються в гривні. Позиція з уже відомою собівартістю
 * пропонує валюту своєї останньої собівартості (stock.server.ts getStockItemCard).
 */
export const DEFAULT_COST_CURRENCY = "UAH";
/** Позицій в одній масовій дії (поріг, лист інвентаризації). */
export const MAX_BULK_ITEMS = 200;
export const MAX_SEARCH_LENGTH = 100;

export const STOCK_PAGE_SIZE = 50;
export const MOVEMENTS_PAGE_SIZE = 50;
/** Останні рухи в картці позиції. */
export const ITEM_RECENT_MOVEMENTS = 20;

/** Сортування переліку залишків. */
export const STOCK_SORTS = [
  "product",
  "sku",
  "available_asc",
  "available_desc",
  "on_hand_desc",
  "reserved_desc",
  "defective_desc",
  "in_production_desc",
  "status",
  "updated_desc",
] as const;
export type StockSort = (typeof STOCK_SORTS)[number];
export const DEFAULT_STOCK_SORT: StockSort = "product";

export function isStockSort(value: unknown): value is StockSort {
  return typeof value === "string" && (STOCK_SORTS as readonly string[]).includes(value);
}

/** Стан обліку варіанта: відкрито (резерви ведуться) / відстежується Shopify, але ще не відкрито / Shopify не веде. */
export const STOCK_TRACKING_STATES = ["opened", "not_opened", "untracked"] as const;
export type StockTrackingState = (typeof STOCK_TRACKING_STATES)[number];

export function isStockTrackingState(value: unknown): value is StockTrackingState {
  return typeof value === "string" && (STOCK_TRACKING_STATES as readonly string[]).includes(value);
}

/**
 * Підрозділи «Складу» (вкладки-посилання на всіх сторінках складу). Сторінки analytics/materials/kits/shopify ведуть
 * інші модулі етапу 5; тут — лише посилання.
 */
export interface WarehouseSectionLink {
  key: "stock" | "movements" | "analytics" | "materials" | "kits" | "shopify";
  path: string;
  labelKey: string;
  permission: Permission;
}

export const WAREHOUSE_SECTION_LINKS: readonly WarehouseSectionLink[] = [
  { key: "stock", path: "warehouse", labelKey: "warehouse.nav.stock", permission: "warehouse.view" },
  { key: "movements", path: "warehouse/movements", labelKey: "warehouse.nav.movements", permission: "warehouse.view" },
  { key: "analytics", path: "warehouse/analytics", labelKey: "warehouseAnalytics.nav", permission: "warehouse.view" },
  { key: "materials", path: "warehouse/materials", labelKey: "warehouse.nav.materials", permission: "warehouse.view" },
  { key: "kits", path: "warehouse/kits", labelKey: "warehouse.nav.kits", permission: "warehouse.view" },
  { key: "shopify", path: "warehouse/shopify", labelKey: "warehouse.nav.shopify", permission: "warehouse.view" },
];

/** Пов'язані розділи поза «Складом». */
export const WAREHOUSE_RELATED_LINKS: ReadonlyArray<{ key: string; path: string; labelKey: string; permission: Permission }> = [
  { key: "production", path: "production", labelKey: "warehouse.nav.production", permission: "warehouse.view" },
  { key: "picking", path: "picking", labelKey: "warehouse.nav.picking", permission: "packing.perform" },
];

/** Види позицій обліку (дублює STOCK_ITEM_KINDS схеми, щоб інтерфейс не тягнув схему БД у браузер). */
export const ITEM_KINDS: readonly StockItemKind[] = ["product", "material"];

/** Попередження від найважливішого. */
export const ALERT_KINDS_BY_SEVERITY: readonly StockAlertKind[] = ["negative_on_hand", "oversold", "out_of_stock", "low_stock"];

/** UUID форми (ключ ідемпотентності manual:<uuid>). */
export const OPERATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const UUID_RE = OPERATION_ID_RE;

/** Shopify називає єдиний варіант товару «Default Title» — не показуємо. */
export const DEFAULT_VARIANT_TITLE = "Default Title";

export function displayVariantTitle(title: string | null | undefined): string | null {
  return title && title !== DEFAULT_VARIANT_TITLE ? title : null;
}

/**
 * Ціле число з поля форми: лише цифри (без знаків, пробілів між цифрами, дробів). Порожнє → null.
 * Не число або поза межами → undefined (помилка перевірки).
 */
export function parseFormInt(raw: unknown, min: number, max: number): number | null | undefined {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (value === "") return null;
  if (!/^\d{1,9}$/.test(value)) return undefined;
  const n = Number(value);
  return n >= min && n <= max ? n : undefined;
}

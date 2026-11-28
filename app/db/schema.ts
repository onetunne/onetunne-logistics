/**
 * Початкова схема бази даних ONE TUNNE Logistics (PostgreSQL).
 *
 * Принципи:
 * - Shopify — основне джерело замовлень/товарів/залишків; тут зберігається робоча копія та стан обробки.
 * - Гроші — тільки numeric(14,2) + валюта (ISO 4217). Ніяких float.
 * - Ідемпотентність накладних гарантується частковим унікальним індексом
 *   (одне активне відправлення на замовлення) + унікальним carrier_reference.
 * - Історія змін даних (order_changes) і технічний журнал (audit_log) — окремо.
 *
 * Зміни схеми → `npm run db:generate` (створює SQL-міграцію у ./drizzle).
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  char,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  ACTIVE_VOIDED,
  AGREEMENT_KINDS,
  ATTRIBUTION_SOURCES,
  ATTRIBUTION_STATUSES,
  CARRIER_DOCUMENT_KINDS,
  CARRIER_INVOICE_STATUSES,
  CHARGE_TYPES,
  COMMISSION_EVENT_KINDS,
  COST_LAYER_KINDS,
  COST_LAYER_REASONS,
  DISCREPANCY_CODES,
  DISCREPANCY_RESOLUTIONS,
  DISCREPANCY_SEVERITIES,
  DISCREPANCY_STATUSES,
  DISPUTE_OUTCOMES,
  DISPUTE_SOURCES,
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORIES_ORDER_FORBIDDEN,
  EXPENSE_CATEGORIES_ORDER_REQUIRED,
  EXPENSE_CHANNELS,
  EXTERNAL_WAYBILL_SOURCES,
  FACTS_SOURCES,
  FEE_RULE_KINDS,
  FINANCE_BASES,
  FINANCE_CATEGORIES,
  FINANCE_CHANGE_ACTIONS,
  FINANCE_CHANGE_ENTITY_TYPES,
  FINANCE_PERIOD_STATUSES,
  FINANCE_SOURCE_TYPES,
  FX_CONVERSION_COUNTERPARTIES,
  FX_RATE_SOURCES,
  IMPORT_FILE_KINDS,
  INVOICE_LINE_KINDS,
  INVOICE_MATCH_STATUSES,
  ORDER_COMPONENTS,
  ORDER_FINANCE_STATES,
  ORDER_SALE_SOURCES,
  PARTNER_CODE_SOURCES,
  PARTNER_KINDS,
  PARTNER_STATUSES,
  PAYOUT_METHODS,
  PROFIT_STATES,
  RECOGNITION_BASES,
  REPORT_KINDS,
  RETURN_KINDS,
  RETURN_LINE_CONDITIONS,
  RETURN_REASON_CODES,
  RETURN_SOURCES,
  RETURN_STATUSES,
  SHIPMENT_ESTIMATE_KINDS,
  SHIPMENT_ESTIMATE_SOURCES,
  SHIPPING_FORECAST_BASES,
  SNAPSHOT_SOURCES,
  STOCK_ITEM_COST_SOURCES,
  VALUATION_KINDS,
  VALUATION_VALUE_SOURCES,
  WAYBILL_NUMBER_CLASSES,
} from "../domain/finance";

const money = (name: string) => numeric(name, { precision: 14, scale: 2 });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const orderStatusEnum = pgEnum("order_status", [
  "paid",
  "awaiting_review",
  "needs_correction",
  "waybill_created",
  "awaiting_picking",
  "packed",
  "handed_to_carrier",
  "in_transit",
  "customs",
  "delivered",
  "delivery_problem",
  "returned",
  "cancelled",
]);

export const orderSourceEnum = pgEnum("order_source", ["demo", "shopify"]);

/** Стан запису накладної (бік перевізника), окремо від статусу замовлення. */
export const shipmentStatusEnum = pgEnum("shipment_status", [
  "creating", // запис створено, запит до перевізника в процесі
  "created", // перевізник підтвердив створення
  "unknown", // результат невідомий (тайм-аут/збій) — потрібна звірка або ручний розгляд
  "failed", // перевізник точно НЕ створив накладну
  "cancelled", // накладну скасовано
]);

export const shipmentModeEnum = pgEnum("shipment_mode", ["test", "live"]);

export const issueSeverityEnum = pgEnum("issue_severity", ["error", "warning"]);
export const issueStatusEnum = pgEnum("issue_status", ["open", "resolved", "dismissed"]);

export const changeSourceEnum = pgEnum("change_source", [
  "auto_fix",
  "manual",
  "suggestion_accepted",
  "shopify_sync",
  "system",
]);

export const roleEnum = pgEnum("staff_role", ["owner", "staff"]);

export const jobStatusEnum = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "dead"]);

export const dutyPayerEnum = pgEnum("duty_payer", ["company", "customer", "unknown"]);

// ---------------------------------------------------------------------------
// Shopify sessions (формат @shopify/shopify-app-session-storage-drizzle)
// ---------------------------------------------------------------------------

export const shopifySessions = pgTable("shopify_sessions", {
  id: text("id").primaryKey(),
  shop: text("shop").notNull(),
  state: text("state").notNull(),
  isOnline: boolean("isOnline").default(false).notNull(),
  scope: text("scope"),
  expires: timestamp("expires", { mode: "date" }),
  accessToken: text("accessToken").notNull(),
  userId: bigint("userId", { mode: "number" }),
  firstName: text("firstName"),
  lastName: text("lastName"),
  email: text("email"),
  accountOwner: boolean("accountOwner"),
  locale: text("locale"),
  collaborator: boolean("collaborator"),
  emailVerified: boolean("emailVerified"),
  refreshToken: text("refreshToken"),
  refreshTokenExpires: timestamp("refreshTokenExpires", { mode: "date" }),
});

// ---------------------------------------------------------------------------
// Довідники: юридичні особи, склади, правила країн
// ---------------------------------------------------------------------------

export const legalEntities = pgTable("legal_entities", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  countryCode: char("country_code", { length: 2 }).notNull(),
  taxId: text("tax_id"),
  baseCurrency: char("base_currency", { length: 3 }).notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const warehouses = pgTable(
  "warehouses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id),
    name: text("name").notNull(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    city: text("city").notNull(),
    address: text("address"),
    shopifyLocationId: text("shopify_location_id"),
    active: boolean("active").notNull().default(true),
    /** Етап 5: склад за замовчуванням («Основний склад»), рівно один (частковий унікальний індекс). */
    isDefault: boolean("is_default").notNull().default(false),
    /**
     * Етап 5: момент ініціалізації складського обліку (початкові залишки зі знімка Shopify). До цього резерви
     * замовлень не ведуться (немає хибних «продано більше, ніж є»); див. modules/inventory/opening.server.ts.
     */
    inventoryInitializedAt: timestamp("inventory_initialized_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("warehouses_one_default_uq").on(t.isDefault).where(sql`${t.isDefault}`)],
);

export const countryRules = pgTable("country_rules", {
  countryCode: char("country_code", { length: 2 }).primaryKey(),
  nameEn: text("name_en").notNull(),
  nameUk: text("name_uk").notNull(),
  shippingEnabled: boolean("shipping_enabled").notNull().default(true),
  postalCodeRequired: boolean("postal_code_required").notNull().default(true),
  postalCodePattern: text("postal_code_pattern"),
  postalCodeExample: text("postal_code_example"),
  provinceRequired: boolean("province_required").notNull().default(false),
  phoneRequired: boolean("phone_required").notNull().default(true),
  dutyPayer: dutyPayerEnum("duty_payer").notNull().default("unknown"),
  notes: text("notes"),
  version: integer("version").notNull().default(1),
  updatedAt: updatedAt(),
});

/**
 * Історія версій правил країн (етап 4). value — повний знімок правила цієї версії.
 * source: initial — стан до першої зміни в застосунку; add — нова країна; update — зміна; reset — повернення до типового.
 */
export const countryRulesHistory = pgTable(
  "country_rules_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    countryCode: char("country_code", { length: 2 }).notNull(),
    version: integer("version").notNull(),
    source: text("source").notNull().default("update"),
    value: jsonb("value").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("country_rules_history_code_version_uq").on(t.countryCode, t.version)],
);

// ---------------------------------------------------------------------------
// Товари (робоча копія з Shopify)
// ---------------------------------------------------------------------------

export const products = pgTable("products", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopifyProductId: text("shopify_product_id").unique(),
  title: text("title").notNull(),
  handle: text("handle"),
  imageUrl: text("image_url"),
  status: text("status"),
  shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
  /**
   * Етап 5: момент ПЕРЕД читанням колекцій товару (Product.collections), дані якого застосовано до product_collections.
   * Старіше читання (паралельне завдання) членство не перезаписує — modules/shopify-sync/collections.server.ts.
   */
  collectionsSyncedAt: timestamp("collections_synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const productVariants = pgTable(
  "product_variants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    shopifyVariantId: text("shopify_variant_id").unique(),
    title: text("title").notNull(),
    sku: text("sku"),
    barcode: text("barcode"),
    color: text("color"),
    model: text("model"),
    price: money("price").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    weightGrams: integer("weight_grams"),
    lengthMm: integer("length_mm"),
    widthMm: integer("width_mm"),
    heightMm: integer("height_mm"),
    hsCode: text("hs_code"),
    countryOfOrigin: char("country_of_origin", { length: 2 }),
    customsDescription: text("customs_description"),
    /** Митний опис українською (метаполе logistics.customs_description_uk). */
    customsDescriptionLocal: text("customs_description_local"),
    /** Основний матеріал англійською (метаполе logistics.material). */
    material: text("material"),
    /**
     * Етап 3: митні дані/вага/габарити, змінені в застосунку (мають пріоритет над даними Shopify).
     * Синхронізація Shopify цю колонку не змінює. Ключі — CustomsOverrides (modules/products/customs-overrides.ts).
     */
    customsOverrides: jsonb("customs_overrides"),
    imageUrl: text("image_url"),
    inventoryAvailable: integer("inventory_available"),
    /**
     * Етап 5: коли застосунок отримав inventory_available із Shopify (час знімка). Замовлення, створені раніше,
     * уже не входять у «доступно» знімка (Shopify закріпив їх одиниці) — див. modules/inventory/opening.server.ts.
     * null — невідомо (демо/дані до етапу 5): за час знімка береться момент відкриття позиції.
     */
    inventorySyncedAt: timestamp("inventory_synced_at", { withTimezone: true }),
    /** Shopify InventoryItem GID — для оновлення залишків за webhook inventory_levels/update. */
    inventoryItemId: text("inventory_item_id"),
    /**
     * Етап 5: коли варіант зник із ПОВНОГО переліку варіантів товару в Shopify (видалено в Shopify). Ставить і знімає
     * лише upsertProduct (modules/shopify-sync/sync.server.ts): повний перелік без варіанта → час синхронізації; варіант
     * знову в переліку → null. Неповний перелік нічого не змінює. Рядок не видаляється (на нього посилаються замовлення
     * й облік складу); сканування в пакуванні не вважає його штрихкод «спільним» (catalogVariantLive). null — наявний
     * (або невідомо: демо, дані з інших джерел).
     */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("product_variants_sku_idx").on(t.sku),
    index("product_variants_barcode_idx").on(t.barcode),
    index("product_variants_inventory_item_idx").on(t.inventoryItemId),
  ],
);

/**
 * Етап 5: колекції Shopify (ручні й автоматичні — обидва види повертає запит `collections`, read_products).
 * Видалена в Shopify колекція не видаляється з бази (deleted_at): шаблони комплектації, що на неї посилаються, не
 * змінюють ціль мовчки — сторінка «Комплектація» показує, що колекцію видалено. Демо-колекції — без shopify_collection_id.
 */
export const collections = pgTable(
  "collections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shopifyCollectionId: text("shopify_collection_id").unique(),
    title: text("title").notNull(),
    handle: text("handle"),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
    /** Коли колекцію востаннє бачили в повному списку Shopify (для виявлення видалених без webhook). */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("collections_title_idx").on(t.title)],
);

/** Етап 5: членство товарів у колекціях (з Product.collections; змінюється лише синхронізацією або демо-даними). */
export const productCollections = pgTable(
  "product_collections",
  {
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.productId, t.collectionId], name: "product_collections_pk" }),
    index("product_collections_collection_idx").on(t.collectionId),
  ],
);

// ---------------------------------------------------------------------------
// Замовлення
// ---------------------------------------------------------------------------

/** Етап 5: пріоритет відправлення (orders.priority). */
export const ORDER_PRIORITIES = { normal: 0, high: 1, urgent: 2 } as const;
export type OrderPriority = (typeof ORDER_PRIORITIES)[keyof typeof ORDER_PRIORITIES];

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: orderSourceEnum("source").notNull(),
    shopifyOrderId: text("shopify_order_id").unique(),
    orderNumber: text("order_number").notNull().unique(),
    status: orderStatusEnum("status").notNull().default("paid"),
    financialStatus: text("financial_status").notNull().default("paid"),
    currency: char("currency", { length: 3 }).notNull(),
    subtotal: money("subtotal").notNull(),
    shippingPaid: money("shipping_paid").notNull().default("0"),
    total: money("total").notNull(),
    email: text("email"),
    contactPhone: text("contact_phone"),
    shipFirstName: text("ship_first_name"),
    shipLastName: text("ship_last_name"),
    shipCompany: text("ship_company"),
    shipAddress1: text("ship_address1"),
    shipAddress2: text("ship_address2"),
    shipCity: text("ship_city"),
    shipProvince: text("ship_province"),
    shipPostalCode: text("ship_postal_code"),
    shipCountryCode: char("ship_country_code", { length: 2 }),
    shipPhone: text("ship_phone"),
    note: text("note"),
    billingCountryCode: char("billing_country_code", { length: 2 }),
    fulfillmentStatus: text("fulfillment_status"),
    /** updatedAt замовлення в Shopify — захист від застосування застарілих подій. */
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
    automationPaused: boolean("automation_paused").notNull().default(false),
    /** Оптимістичне блокування: кожна зміна збільшує версію. */
    version: integer("version").notNull().default(1),
    lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull().defaultNow(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    // --- Етап 5: підготовка замовлень ---
    /** Пріоритет відправлення: 0 — звичайний, 1 — високий, 2 — терміновий (ORDER_PRIORITIES). */
    priority: smallint("priority").notNull().default(0),
    /**
     * Ручне коригування посилки (вага, г; габарити, мм; коробка). Якщо задано — має пріоритет над розрахунком
     * під час створення накладної (buildShipmentRequest). null — розрахунок за товарами й упаковкою.
     */
    parcelWeightGrams: integer("parcel_weight_grams"),
    parcelLengthMm: integer("parcel_length_mm"),
    parcelWidthMm: integer("parcel_width_mm"),
    parcelHeightMm: integer("parcel_height_mm"),
    parcelBoxMaterialId: uuid("parcel_box_material_id").references((): AnyPgColumn => packagingMaterials.id),
    /**
     * Етап 5: Shopify повідомив зміну позицій (кількість/видалення/заміна), яку НЕ застосовано — замовлення мало активну
     * накладну або статус уже не дозволяв змін (modules/shopify-sync/sync.server.ts). Поки значення задане (і замовлення
     * не передане/не скасоване), позиції застосунку застарілі: створення/переоформлення накладної й ручна передача
     * перевізнику заблоковані (modules/shopify-sync/pending-lines.server.ts). Скасування накладної ставить у чергу
     * повторне читання замовлення з Shopify; синхронізація, що застосувала позиції (або побачила, що вони збігаються),
     * очищає значення. null — розбіжностей позицій із Shopify немає.
     */
    shopifyLinesPendingAt: timestamp("shopify_lines_pending_at", { withTimezone: true }),
    /**
     * Етап 5: чи виконав Shopify одиниці позицій, що потребують доставки (LineItem.requiresShipping; виконання —
     * LineItem.unfulfilledQuantity < quantity), — уточнює часткове виконання (partially_fulfilled):
     * false — виконано лише позиції без доставки (цифрові подарункові картки, цифрові товари, які Shopify виконує
     * автоматично), фізичні товари не відправлено → це не «виконано поза застосунком», накладна застосунку дозволена;
     * true — виконано (або могло бути виконано) одиниці фізичних позицій; null — невідомо (дані до етапу 5 / відповідь
     * без цих полів) → як true (безпечніше). domain/order-status.ts isFulfilledInShopify.
     */
    shopifyShippableFulfilled: boolean("shopify_shippable_fulfilled"),
    /**
     * Етап 5: коли застосунок востаннє ставив у чергу повторне читання замовлення з Shopify через застарілий статус
     * виконання (передано перевізнику, а в Shopify ще не «виконано» — webhook міг загубитися;
     * modules/shopify-sync/fulfillment-refresh.server.ts). Обмежує повтори: не частіше ніж раз на інтервал. null — не ставив.
     */
    shopifyFulfillmentCheckedAt: timestamp("shopify_fulfillment_checked_at", { withTimezone: true }),
    /**
     * Етап 5: контакти й адреса доставки, якими їх востаннє повідомив Shopify (поле CONTACT_FIELDS у
     * modules/shopify-sync/sync.server.ts → значення після mapOrder). Синхронізація визначає «змінено в Shopify»,
     * порівнюючи нові дані Shopify з цим знімком, а не з полями замовлення: ті можуть містити зміни застосунку
     * (автовиправлення, прийняті пропозиції, підтверджені правки, ще не передані або не прийняті Shopify), які Shopify
     * не змінював. null — замовлення до міграції 0011 (тоді — за історією змін order_changes).
     */
    shopifyContactSnapshot: jsonb("shopify_contact_snapshot").$type<Record<string, string | null>>(),
    /**
     * Етап 6: тестове замовлення Shopify (Order.test, уже отримуване; записує applyOrderInTx — WP3). Фінанси його не
     * враховують (стан excluded), якщо не ввімкнено finance.includeTestOrders (docs/stage6-design.md §2.5).
     */
    shopifyTest: boolean("shopify_test").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_status_idx").on(t.status),
    index("orders_country_idx").on(t.shipCountryCode),
    index("orders_placed_at_idx").on(t.placedAt),
    index("orders_packing_queue_idx").on(t.status, t.priority, t.placedAt),
    check("orders_priority_chk", sql`${t.priority} between 0 and 2`),
    check(
      "orders_parcel_override_chk",
      sql`(${t.parcelWeightGrams} is null or ${t.parcelWeightGrams} > 0)
        and (${t.parcelLengthMm} is null or ${t.parcelLengthMm} > 0)
        and (${t.parcelWidthMm} is null or ${t.parcelWidthMm} > 0)
        and (${t.parcelHeightMm} is null or ${t.parcelHeightMm} > 0)`,
    ),
  ],
);

export const orderLineItems = pgTable(
  "order_line_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: uuid("variant_id").references(() => productVariants.id),
    shopifyLineItemId: text("shopify_line_item_id"),
    title: text("title").notNull(),
    variantTitle: text("variant_title"),
    sku: text("sku"),
    /** Замовлена кількість (Shopify LineItem.quantity — разом із поверненими й видаленими одиницями). */
    quantity: integer("quantity").notNull(),
    /**
     * Етап 5: кількість до відправлення (Shopify LineItem.currentQuantity — без повернених і видалених одиниць).
     * Саме її резервує й списує склад (effectiveLineQuantity у modules/inventory/quantities.ts). null — як quantity
     * (демо-замовлення й позиції, збережені до етапу 5).
     */
    currentQuantity: integer("current_quantity"),
    /**
     * Етап 5: коли позицію додано в Shopify — LineItem.createdAt (2026-10); для позиції, уперше побаченої під час
     * ОНОВЛЕННЯ вже збереженого замовлення без цього поля, — updatedAt замовлення в Shopify цієї синхронізації (верхня
     * межа). Порівнюється з часом знімка складу: позиція, додана редагуванням ПІСЛЯ знімка, — новий продаж (без
     * корекції opening_line), навіть якщо саме замовлення створене до знімка (modules/inventory/reservations.server.ts).
     * null — невідомо (демо, позиції до етапу 5): діє правило за orders.placed_at.
     */
    shopifyAddedAt: timestamp("shopify_added_at", { withTimezone: true }),
    unitPrice: money("unit_price").notNull(),
    /**
     * Етап 5: ціна одиниці після ВСІХ знижок — Shopify LineItem.discountedUnitPriceAfterAllDiscountsSet (shopMoney, та сама
     * валюта, що й unit_price): «The approximate unit price … includes discounts applied to refunded and removed
     * quantities» (2026-10). Митна вартість одиниці (modules/customs/invoice.ts). null — позиції до етапу 5 / демо:
     * вартість розподіляється з subtotal замовлення, як раніше.
     */
    discountedUnitPrice: money("discounted_unit_price"),
    currency: char("currency", { length: 3 }).notNull(),
    imageUrl: text("image_url"),
    position: integer("position").notNull().default(0),
    /**
     * Етап 6: чи потребує позиція доставки (LineItem.requiresShipping, уже отримуване; записує синхронізація — WP3).
     * null — невідомо → потребує (доставка — обов'язковий складник фінансів замовлення, §2.6).
     */
    requiresShipping: boolean("requires_shipping"),
  },
  (t) => [
    index("order_line_items_order_idx").on(t.orderId),
    uniqueIndex("order_line_items_shopify_uq").on(t.orderId, t.shopifyLineItemId),
    // Етап 5: резерви/аналітика продажів за варіантом.
    index("order_line_items_variant_idx").on(t.variantId),
    check("order_line_items_current_quantity_chk", sql`${t.currentQuantity} is null or ${t.currentQuantity} >= 0`),
  ],
);

/** Історія змін даних замовлення: початкове та нове значення, причина, джерело. */
export const orderChanges = pgTable(
  "order_changes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    field: text("field").notNull(),
    oldValue: text("old_value"),
    newValue: text("new_value"),
    source: changeSourceEnum("source").notNull(),
    ruleId: text("rule_id"),
    reason: text("reason"),
    actorId: text("actor_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("order_changes_order_idx").on(t.orderId, t.createdAt)],
);

// ---------------------------------------------------------------------------
// Проблеми (результати перевірки даних, помилки перевізника)
// ---------------------------------------------------------------------------

export const issues = pgTable(
  "issues",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    shipmentId: uuid("shipment_id"),
    code: text("code").notNull(),
    severity: issueSeverityEnum("severity").notNull(),
    status: issueStatusEnum("status").notNull().default("open"),
    field: text("field"),
    params: jsonb("params").$type<Record<string, string | number>>().notNull().default({}),
    suggestion: jsonb("suggestion").$type<{ field: string; candidates: string[] } | null>(),
    /** Стабільний ключ (замовлення+код+поле) — повторна перевірка не створює дублікатів. */
    fingerprint: text("fingerprint").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
    resolution: text("resolution"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("issues_open_fingerprint_uq").on(t.fingerprint).where(sql`${t.status} = 'open'`),
    index("issues_order_idx").on(t.orderId),
    index("issues_status_idx").on(t.status),
  ],
);

// ---------------------------------------------------------------------------
// Відправлення / накладні
// ---------------------------------------------------------------------------

export const shipments = pgTable(
  "shipments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    carrierCode: text("carrier_code").notNull(),
    mode: shipmentModeEnum("mode").notNull(),
    status: shipmentStatusEnum("status").notNull(),
    /** Ідентифікатор, що передається перевізнику; стабільний для повторних спроб. */
    carrierReference: text("carrier_reference").notNull(),
    /** Покоління: збільшується лише після скасування/підтвердженої відмови. */
    generation: integer("generation").notNull().default(1),
    attempts: integer("attempts").notNull().default(1),
    carrierShipmentId: text("carrier_shipment_id"),
    waybillNumber: text("waybill_number"),
    trackingNumber: text("tracking_number"),
    actualWeightGrams: integer("actual_weight_grams"),
    volumetricWeightGrams: integer("volumetric_weight_grams"),
    chargeableWeightGrams: integer("chargeable_weight_grams"),
    packageCode: text("package_code"),
    declaredValue: money("declared_value"),
    currency: char("currency", { length: 3 }),
    requestSnapshot: jsonb("request_snapshot"),
    lastError: text("last_error"),
    /** Тариф/послуга перевізника, обрана при створенні (напр. deliveryType Nova Post). */
    serviceCode: text("service_code"),
    // --- Відстеження (етап 3) ---
    /** Нормалізований статус відстеження (TrackingStatus). */
    trackingStatus: text("tracking_status"),
    carrierStatusCode: text("carrier_status_code"),
    carrierStatusText: text("carrier_status_text"),
    carrierStatusAt: timestamp("carrier_status_at", { withTimezone: true }),
    lastTrackedAt: timestamp("last_tracked_at", { withTimezone: true }),
    /** Фактична передача перевізнику (за даними відстеження або підтвердженням менеджера). */
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    // --- Передача трек-номера в Shopify ---
    shopifyFulfillmentId: text("shopify_fulfillment_id"),
    shopifyFulfilledAt: timestamp("shopify_fulfilled_at", { withTimezone: true }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("shipments_tracking_idx").on(t.status, t.lastTrackedAt),
    uniqueIndex("shipments_one_active_per_order_uq")
      .on(t.orderId)
      .where(sql`${t.status} in ('creating', 'created', 'unknown')`),
    uniqueIndex("shipments_carrier_reference_uq").on(t.carrierCode, t.carrierReference),
    uniqueIndex("shipments_waybill_uq").on(t.carrierCode, t.waybillNumber),
    index("shipments_order_idx").on(t.orderId),
    // Етап 6: зіставлення рядків рахунків перевізника з накладними за нормалізованим номером (§7.4).
    index("shipments_waybill_norm_idx").on(t.carrierCode, sql`upper(regexp_replace(${t.waybillNumber}, '\\s', '', 'g'))`),
  ],
);

export const shipmentEvents = pgTable(
  "shipment_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message"),
    data: jsonb("data"),
    createdAt: createdAt(),
  },
  (t) => [index("shipment_events_shipment_idx").on(t.shipmentId, t.createdAt)],
);

/** Події відстеження від перевізника (без персональних даних). Дедуплікація за кодом і часом. */
export const shipmentTrackingEvents = pgTable(
  "shipment_tracking_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    /** Код статусу перевізника ("" — немає коду). */
    code: text("code").notNull().default(""),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    location: text("location"),
    description: text("description"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("shipment_tracking_events_uq").on(t.shipmentId, t.occurredAt, t.code),
    index("shipment_tracking_events_shipment_idx").on(t.shipmentId, t.occurredAt),
  ],
);

/**
 * «Віддалена сторона» тестового перевізника. Імітує базу перевізника, щоб можна було
 * перевірити звірку після збою. Використовується лише тестовим адаптером.
 */
export const sandboxCarrierShipments = pgTable("sandbox_carrier_shipments", {
  id: uuid("id").primaryKey().defaultRandom(),
  reference: text("reference").notNull().unique(),
  waybillNumber: text("waybill_number").notNull().unique(),
  payload: jsonb("payload"),
  cancelled: boolean("cancelled").notNull().default(false),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Налаштування (версіоновані) та працівники
// ---------------------------------------------------------------------------

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  version: integer("version").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  updatedAt: updatedAt(),
});

export const settingsHistory = pgTable(
  "settings_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    version: integer("version").notNull(),
    value: jsonb("value").notNull(),
    changedBy: text("changed_by").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("settings_history_key_version_uq").on(t.key, t.version)],
);

export const staffMembers = pgTable("staff_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  shopifyUserId: text("shopify_user_id").unique(),
  displayName: text("display_name").notNull(),
  role: roleEnum("role").notNull().default("staff"),
  /** Додаткові/відібрані дозволи поверх ролі (гнучкі права). */
  permissionOverrides: jsonb("permission_overrides")
    .$type<{ grant?: string[]; revoke?: string[] }>()
    .notNull()
    .default({}),
  active: boolean("active").notNull().default(true),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Стан підключеного магазину Shopify: встановлення, синхронізація, імпорт. */
export const shopInstallations = pgTable("shop_installations", {
  shop: text("shop").primaryKey(),
  installedAt: timestamp("installed_at", { withTimezone: true }).notNull().defaultNow(),
  uninstalledAt: timestamp("uninstalled_at", { withTimezone: true }),
  scopes: text("scopes"),
  /** Остання ПОВНІСТЮ успішна реєстрація підписок на webhooks (modules/shopify-sync/webhook-subscriptions.server.ts). */
  webhooksRegisteredAt: timestamp("webhooks_registered_at", { withTimezone: true }),
  /**
   * Етап 5: теми webhooks, підписку на які Shopify підтвердив під час останньої реєстрації (через кому; показ на
   * сторінці «Синхронізація Shopify»). null — встановлення до етапу 5 (теми не записувалися).
   */
  webhookTopics: text("webhook_topics"),
  /**
   * Етап 5: відбиток конфігурації підписок (теми, адреси, SHOPIFY_APP_URL) на момент останньої повністю успішної
   * реєстрації. Відрізняється від поточного (нові теми після оновлення, null — до етапу 5) → фонове завдання
   * перереєстровує підписки з офлайн-сесією, без повторної авторизації власника.
   */
  webhooksConfigKey: text("webhooks_config_key"),
  productsSyncedAt: timestamp("products_synced_at", { withTimezone: true }),
  /** Етап 5: остання завершена повна синхронізація колекцій і членства товарів (collections.server.ts). */
  collectionsSyncedAt: timestamp("collections_synced_at", { withTimezone: true }),
  ordersSyncedAt: timestamp("orders_synced_at", { withTimezone: true }),
  /** Стан імпорту старих замовлень: { status, since, imported, skipped, startedAt, finishedAt, error }. */
  importState: jsonb("import_state").$type<Record<string, unknown>>(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------------------
// Технічний журнал, webhooks, фонові завдання
// ---------------------------------------------------------------------------

/** Журнал критичних дій. НЕ містить персональних даних (лише ідентифікатори). */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorType: text("actor_type").notNull(), // user | system | ai
    actorId: text("actor_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId), index("audit_log_created_idx").on(t.createdAt)],
);

/** Захист від повторної обробки webhooks (X-Shopify-Webhook-Id). */
export const webhookEvents = pgTable("webhook_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  webhookId: text("webhook_id").notNull().unique(),
  topic: text("topic").notNull(),
  shop: text("shop").notNull(),
  status: text("status").notNull().default("received"),
  error: text("error"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
});

/** Надійна черга фонових завдань (реалізація обробника — наступні етапи). */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: jobStatusEnum("status").notNull().default("queued"),
    /** Унікальний серед завдань у черзі (queued): повторна подія не створює дублікат очікуваного завдання. */
    dedupeKey: text("dedupe_key"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("jobs_pick_idx").on(t.status, t.runAt),
    uniqueIndex("jobs_queued_dedupe_uq").on(t.dedupeKey).where(sql`${t.status} = 'queued'`),
  ],
);

// ---------------------------------------------------------------------------
// Етап 5: склад, виробництво, упаковка, підготовка замовлень
// (docs/stage5-design.md). Журнал руху (inventory_movements) — єдине джерело обліку; баланси змінюються
// лише разом зі вставкою руху (modules/inventory/ledger.server.ts). Кількості — цілі числа; гроші — numeric(14,2)
// + валюта; собівартість — лише власник (finance.view).
// ---------------------------------------------------------------------------

export const STOCK_ITEM_KINDS = ["product", "material"] as const;
export type StockItemKind = (typeof STOCK_ITEM_KINDS)[number];

export const PACKAGING_MATERIAL_KINDS = ["box", "mailer", "sticker", "instruction", "card", "bolt", "filler", "tape", "other"] as const;
export type PackagingMaterialKind = (typeof PACKAGING_MATERIAL_KINDS)[number];

export const MATERIAL_UNITS = ["pcs", "m", "kg"] as const;
export type MaterialUnit = (typeof MATERIAL_UNITS)[number];

export const SHOPIFY_SYNC_STATES = ["none", "pending", "pushed", "failed", "skipped"] as const;
export type ShopifySyncState = (typeof SHOPIFY_SYNC_STATES)[number];

export const RESERVATION_STATUSES = ["reserved", "consumed", "released", "partial"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

export const STOCK_ALERT_KINDS = ["low_stock", "out_of_stock", "negative_on_hand", "oversold"] as const;
export type StockAlertKind = (typeof STOCK_ALERT_KINDS)[number];

export const INVENTORY_CONFLICT_STATUSES = ["open", "accepted_shopify", "pushed_app", "dismissed"] as const;
export type InventoryConflictStatus = (typeof INVENTORY_CONFLICT_STATUSES)[number];

export const KIT_APPLIES_TO = ["all", "products", "collections"] as const;
export type KitAppliesTo = (typeof KIT_APPLIES_TO)[number];
export const KIT_LINE_PER = ["order", "item"] as const;

export const PRODUCTION_BATCH_STATUSES = ["planned", "in_production", "partially_received", "received", "closed", "cancelled"] as const;
export type ProductionBatchStatus = (typeof PRODUCTION_BATCH_STATUSES)[number];

export const PACKING_STATUSES = ["queued", "in_progress", "packed", "cancelled"] as const;
export type PackingStatus = (typeof PACKING_STATUSES)[number];

/** SQL-список значень для CHECK: `in ('a', 'b')` (значення — константи коду, не ввід користувача). */
const inList = (values: readonly string[]) => sql.raw(`(${values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ")})`);

/** Пакувальні матеріали й комплектуючі: коробки (внутрішні габарити, макс. вага, тара), наклейки, інструкції, болти… */
export const packagingMaterials = pgTable(
  "packaging_materials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind", { enum: PACKAGING_MATERIAL_KINDS }).notNull(),
    unit: text("unit", { enum: MATERIAL_UNITS }).notNull().default("pcs"),
    innerLengthMm: integer("inner_length_mm"),
    innerWidthMm: integer("inner_width_mm"),
    innerHeightMm: integer("inner_height_mm"),
    maxWeightGrams: integer("max_weight_grams"),
    tareWeightGrams: integer("tare_weight_grams"),
    /** Собівартість одиниці — лише власник (finance.view). */
    unitCost: money("unit_cost"),
    costCurrency: char("cost_currency", { length: 3 }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("packaging_materials_kind_idx").on(t.kind, t.active),
    check("packaging_materials_kind_chk", sql`${t.kind} in ${inList(PACKAGING_MATERIAL_KINDS)}`),
    check("packaging_materials_unit_chk", sql`${t.unit} in ${inList(MATERIAL_UNITS)}`),
    check(
      "packaging_materials_dims_chk",
      sql`(${t.innerLengthMm} is null or ${t.innerLengthMm} > 0)
        and (${t.innerWidthMm} is null or ${t.innerWidthMm} > 0)
        and (${t.innerHeightMm} is null or ${t.innerHeightMm} > 0)
        and (${t.maxWeightGrams} is null or ${t.maxWeightGrams} > 0)
        and (${t.tareWeightGrams} is null or ${t.tareWeightGrams} >= 0)`,
    ),
    check(
      "packaging_materials_cost_chk",
      sql`${t.unitCost} is null or (${t.unitCost} >= 0 and ${t.costCurrency} is not null)`,
    ),
  ],
);

/** Позиція обліку: варіант товару АБО пакувальний матеріал (рівно одне, відповідно до kind). */
export const stockItems = pgTable(
  "stock_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: text("kind", { enum: STOCK_ITEM_KINDS }).notNull(),
    variantId: uuid("variant_id")
      .unique()
      .references(() => productVariants.id),
    materialId: uuid("material_id")
      .unique()
      .references(() => packagingMaterials.id),
    /** Поріг «мало на складі» для цієї позиції; null — налаштування warehouse.lowStockThreshold. */
    lowStockThreshold: integer("low_stock_threshold"),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "stock_items_kind_chk",
      sql`(${t.kind} = 'product' and ${t.variantId} is not null and ${t.materialId} is null)
        or (${t.kind} = 'material' and ${t.materialId} is not null and ${t.variantId} is null)`,
    ),
    check("stock_items_threshold_chk", sql`${t.lowStockThreshold} is null or ${t.lowStockThreshold} >= 0`),
  ],
);

/**
 * Поточні залишки за кошиками. Змінюються ЛИШЕ разом зі вставкою руху (applyMovements, блокування FOR UPDATE).
 * Доступно для продажу = on_hand − reserved. on_hand < 0 — лише після фізичних подій (передача перевізнику,
 * зміна в Shopify), з попередженням negative_on_hand.
 */
export const inventoryBalances = pgTable(
  "inventory_balances",
  {
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    defective: integer("defective").notNull().default(0),
    inProduction: integer("in_production").notNull().default(0),
    /** Збільшується з кожною зміною (оптимістичне блокування для форм). */
    version: integer("version").notNull().default(0),
    /**
     * Етап 5: товар «відкрито» — облік пов'язано зі знімком Shopify (initializeInventory). Лише відкриті позиції
     * резервуються/списуються під замовлення й надсилаються в Shopify; рухи до відкриття — внутрішні («skipped»).
     * null — не відкрито (матеріали не відкриваються: Shopify їх не веде).
     */
    openedAt: timestamp("opened_at", { withTimezone: true }),
    /**
     * Час знімка Shopify, з якого відкрито позицію (product_variants.inventory_synced_at або момент відкриття).
     * Замовлення, створене раніше, уже враховане знімком: при першому резерві on_hand коригується на його кількість.
     */
    openingSnapshotAt: timestamp("opening_snapshot_at", { withTimezone: true }),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.warehouseId, t.stockItemId], name: "inventory_balances_pk" }),
    index("inventory_balances_item_idx").on(t.stockItemId),
    check("inventory_balances_reserved_chk", sql`${t.reserved} >= 0`),
    check("inventory_balances_defective_chk", sql`${t.defective} >= 0`),
    check("inventory_balances_in_production_chk", sql`${t.inProduction} >= 0`),
    check("inventory_balances_opened_chk", sql`(${t.openedAt} is null) = (${t.openingSnapshotAt} is null)`),
  ],
);

/** Партії виробництва. Номер — PB-<рік>-<0001>. Додаткові витрати — лише власник. */
export const productionBatches = pgTable(
  "production_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    number: text("number").notNull().unique(),
    title: text("title").notNull(),
    status: text("status", { enum: PRODUCTION_BATCH_STATUSES }).notNull().default("planned"),
    plannedReadyDate: date("planned_ready_date", { mode: "string" }),
    manufacturer: text("manufacturer"),
    notes: text("notes"),
    extraCost: money("extra_cost"),
    costCurrency: char("cost_currency", { length: 3 }),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("production_batches_status_idx").on(t.status, t.plannedReadyDate),
    check("production_batches_status_chk", sql`${t.status} in ${inList(PRODUCTION_BATCH_STATUSES)}`),
    check(
      "production_batches_cost_chk",
      sql`${t.extraCost} is null or (${t.extraCost} >= 0 and ${t.costCurrency} is not null)`,
    ),
  ],
);

export const productionBatchLines = pgTable(
  "production_batch_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    variantId: uuid("variant_id")
      .notNull()
      .references(() => productVariants.id),
    quantityOrdered: integer("quantity_ordered").notNull(),
    quantityReceived: integer("quantity_received").notNull().default(0),
    quantityDefective: integer("quantity_defective").notNull().default(0),
    /** Собівартість одиниці — лише власник (finance.view). */
    unitCost: money("unit_cost"),
    costCurrency: char("cost_currency", { length: 3 }),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    index("production_batch_lines_batch_idx").on(t.batchId),
    index("production_batch_lines_variant_idx").on(t.variantId),
    check("production_batch_lines_ordered_chk", sql`${t.quantityOrdered} > 0`),
    check("production_batch_lines_received_chk", sql`${t.quantityReceived} >= 0`),
    check("production_batch_lines_defective_chk", sql`${t.quantityDefective} >= 0`),
    check(
      "production_batch_lines_cost_chk",
      sql`${t.unitCost} is null or (${t.unitCost} >= 0 and ${t.costCurrency} is not null)`,
    ),
  ],
);

/** Надходження з виробництва (часткові). idempotency_key — захист від подвійного натискання/повтору. */
export const productionReceipts = pgTable(
  "production_receipts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => productionBatches.id),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    receivedBy: text("received_by").notNull(),
    receivedByName: text("received_by_name").notNull(),
    note: text("note"),
  },
  (t) => [index("production_receipts_batch_idx").on(t.batchId, t.receivedAt)],
);

export const productionReceiptLines = pgTable(
  "production_receipt_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    receiptId: uuid("receipt_id")
      .notNull()
      .references(() => productionReceipts.id),
    batchLineId: uuid("batch_line_id")
      .notNull()
      .references(() => productionBatchLines.id),
    goodQty: integer("good_qty").notNull().default(0),
    defectiveQty: integer("defective_qty").notNull().default(0),
  },
  (t) => [
    index("production_receipt_lines_receipt_idx").on(t.receiptId),
    index("production_receipt_lines_batch_line_idx").on(t.batchLineId),
    check("production_receipt_lines_good_chk", sql`${t.goodQty} >= 0`),
    check("production_receipt_lines_defective_chk", sql`${t.defectiveQty} >= 0`),
  ],
);

/**
 * Пакування замовлення. Одне незавершене/запаковане пакування на замовлення (частковий унікальний індекс);
 * після скасування — нове покоління. checklist — { [lineItemId]: packedQty }.
 */
export const orderPacking = pgTable(
  "order_packing",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    generation: integer("generation").notNull().default(1),
    status: text("status", { enum: PACKING_STATUSES }).notNull().default("queued"),
    checklist: jsonb("checklist").$type<Record<string, number>>().notNull().default({}),
    boxMaterialId: uuid("box_material_id").references(() => packagingMaterials.id),
    parcelWeightGrams: integer("parcel_weight_grams"),
    parcelLengthMm: integer("parcel_length_mm"),
    parcelWidthMm: integer("parcel_width_mm"),
    parcelHeightMm: integer("parcel_height_mm"),
    startedBy: text("started_by"),
    startedByName: text("started_by_name"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    packedBy: text("packed_by"),
    packedByName: text("packed_by_name"),
    packedAt: timestamp("packed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("order_packing_one_active_uq")
      .on(t.orderId)
      .where(sql`${t.status} in ('queued', 'in_progress', 'packed')`),
    uniqueIndex("order_packing_generation_uq").on(t.orderId, t.generation),
    index("order_packing_status_idx").on(t.status, t.updatedAt),
    check("order_packing_status_chk", sql`${t.status} in ${inList(PACKING_STATUSES)}`),
    check(
      "order_packing_parcel_chk",
      sql`(${t.parcelWeightGrams} is null or ${t.parcelWeightGrams} > 0)
        and (${t.parcelLengthMm} is null or ${t.parcelLengthMm} > 0)
        and (${t.parcelWidthMm} is null or ${t.parcelWidthMm} > 0)
        and (${t.parcelHeightMm} is null or ${t.parcelHeightMm} > 0)`,
    ),
  ],
);

/**
 * Журнал руху залишків (append-only). Кожен рядок — подія з дельтами по кошиках і УНІКАЛЬНИМ ключем
 * ідемпотентності: повтор тієї самої події не створює другого руху (немає подвійного списання/резервування).
 * note — без персональних даних; unit_cost — лише власник. type — MovementType (modules/inventory/ledger.server.ts).
 */
export const inventoryMovements = pgTable(
  "inventory_movements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    type: text("type").notNull(),
    onHandDelta: integer("on_hand_delta").notNull().default(0),
    reservedDelta: integer("reserved_delta").notNull().default(0),
    defectiveDelta: integer("defective_delta").notNull().default(0),
    inProductionDelta: integer("in_production_delta").notNull().default(0),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    orderId: uuid("order_id").references(() => orders.id),
    /** Без зовнішнього ключа: позиції замовлення можуть бути видалені синхронізацією Shopify. */
    orderLineItemId: uuid("order_line_item_id"),
    productionBatchId: uuid("production_batch_id").references(() => productionBatches.id),
    packingId: uuid("packing_id").references(() => orderPacking.id),
    unitCost: money("unit_cost"),
    costCurrency: char("cost_currency", { length: 3 }),
    /** Короткий код причини (напр. stocktake, damaged, shopify_snapshot). */
    reason: text("reason"),
    note: text("note"),
    actorId: text("actor_id").notNull(),
    /** Ім'я виконавця на момент дії (знімок для історії). */
    actorName: text("actor_name").notNull(),
    shopifySyncState: text("shopify_sync_state", { enum: SHOPIFY_SYNC_STATES }).notNull().default("none"),
    createdAt: createdAt(),
    /**
     * Етап 6: детермінований порядок рухів (оцінка собівартості — за (stock_item_id, seq), docs/stage6-design.md §6.4).
     * Баланс позиції блокується до вставки руху, тож seq рухів однієї позиції = порядок їх застосування. Наявні рядки
     * пронумеровано міграцією 0012 (ручні оператори: created_at, входи перед виходами, ключ).
     */
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
  },
  (t) => [
    uniqueIndex("inventory_movements_seq_uq").on(t.seq),
    index("inventory_movements_item_idx").on(t.stockItemId, t.createdAt),
    index("inventory_movements_created_idx").on(t.createdAt),
    index("inventory_movements_order_idx").on(t.orderId),
    index("inventory_movements_batch_idx").on(t.productionBatchId),
    index("inventory_movements_packing_idx").on(t.packingId),
    index("inventory_movements_shopify_pending_idx")
      .on(t.createdAt)
      .where(sql`${t.shopifySyncState} = 'pending'`),
    check("inventory_movements_sync_state_chk", sql`${t.shopifySyncState} in ${inList(SHOPIFY_SYNC_STATES)}`),
    check(
      "inventory_movements_cost_chk",
      sql`${t.unitCost} is null or (${t.unitCost} >= 0 and ${t.costCurrency} is not null)`,
    ),
  ],
);

/**
 * Резерв під позицію оплаченого замовлення (стан, який веде syncOrderReservations). seq — версія для ключів
 * ідемпотентності reserve:/release:<lineItemId>:<seq>. Позиція без варіанта не резервується.
 */
export const stockReservations = pgTable(
  "stock_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Без зовнішнього ключа: позицію можуть видалити в Shopify — резерв тоді знімається. */
    orderLineItemId: uuid("order_line_item_id").notNull().unique(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    reservedQty: integer("reserved_qty").notNull().default(0),
    consumedQty: integer("consumed_qty").notNull().default(0),
    status: text("status", { enum: RESERVATION_STATUSES }).notNull().default("reserved"),
    seq: integer("seq").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("stock_reservations_order_idx").on(t.orderId),
    index("stock_reservations_item_idx").on(t.stockItemId, t.status),
    check("stock_reservations_status_chk", sql`${t.status} in ${inList(RESERVATION_STATUSES)}`),
    check("stock_reservations_qty_chk", sql`${t.reservedQty} >= 0 and ${t.consumedQty} >= 0`),
  ],
);

/** Попередження складу (джерело для сповіщень/Telegram). Одне відкрите на (позиція, склад, вид). */
export const stockAlerts = pgTable(
  "stock_alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    kind: text("kind", { enum: STOCK_ALERT_KINDS }).notNull(),
    status: text("status", { enum: ["open", "resolved"] }).notNull().default("open"),
    details: jsonb("details").$type<Record<string, number | string | null>>().notNull().default({}),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("stock_alerts_open_uq")
      .on(t.stockItemId, t.warehouseId, t.kind)
      .where(sql`${t.status} = 'open'`),
    index("stock_alerts_status_idx").on(t.status, t.createdAt),
    check("stock_alerts_kind_chk", sql`${t.kind} in ${inList(STOCK_ALERT_KINDS)}`),
    check("stock_alerts_status_chk", sql`${t.status} in ('open', 'resolved')`),
  ],
);

/**
 * Розбіжність між складом застосунку й Shopify (зміна, зроблена в Shopify не застосунком). Не перезаписується
 * мовчки: власник обирає «прийняти Shopify» (рух shopify_external) або «надіслати значення складу».
 */
export const inventoryConflicts = pgTable(
  "inventory_conflicts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    source: text("source", { enum: ["shopify"] }).notNull().default("shopify"),
    appOnHand: integer("app_on_hand").notNull(),
    shopifyOnHand: integer("shopify_on_hand").notNull(),
    shopifyAvailable: integer("shopify_available"),
    /** Очікувана різниця, пояснена відомими причинами (напр. неоплачені замовлення в Shopify). */
    expectedDiff: integer("expected_diff").notNull().default(0),
    status: text("status", { enum: INVENTORY_CONFLICT_STATUSES }).notNull().default("open"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedBy: text("resolved_by"),
  },
  (t) => [
    uniqueIndex("inventory_conflicts_open_uq")
      .on(t.stockItemId, t.warehouseId)
      .where(sql`${t.status} = 'open'`),
    index("inventory_conflicts_status_idx").on(t.status, t.createdAt),
    check("inventory_conflicts_status_chk", sql`${t.status} in ${inList(INVENTORY_CONFLICT_STATUSES)}`),
    check("inventory_conflicts_source_chk", sql`${t.source} = 'shopify'`),
  ],
);

/** Шаблони комплектації: що додається до замовлення (per=order) або до кожної одиниці товару (per=item). */
export const kitTemplates = pgTable(
  "kit_templates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /**
     * all — усі товари; products — товари з kit_template_products; collections — товари колекцій з
     * kit_template_collections (членство з Shopify, нові товари колекції — автоматично). Правила — kit-resolution.ts.
     */
    appliesTo: text("applies_to", { enum: KIT_APPLIES_TO }).notNull().default("all"),
    /**
     * Необов'язковий фільтр за атрибутами варіанта (product_variants.model / color) для будь-якої цілі: порожній —
     * без фільтра; інакше рахуються лише одиниці варіантів із моделлю (кольором) зі списку.
     */
    variantModels: text("variant_models").array().notNull().default(sql`'{}'::text[]`),
    variantColors: text("variant_colors").array().notNull().default(sql`'{}'::text[]`),
    /** Більший пріоритет показується пакувальнику першим (застосовуються всі шаблони, що підходять). */
    priority: integer("priority").notNull().default(0),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("kit_templates_applies_to_chk", sql`${t.appliesTo} in ${inList(KIT_APPLIES_TO)}`)],
);

export const kitTemplateLines = pgTable(
  "kit_template_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => kitTemplates.id, { onDelete: "cascade" }),
    materialId: uuid("material_id")
      .notNull()
      .references(() => packagingMaterials.id),
    quantity: integer("quantity").notNull(),
    per: text("per", { enum: KIT_LINE_PER }).notNull().default("order"),
  },
  (t) => [
    uniqueIndex("kit_template_lines_uq").on(t.templateId, t.materialId, t.per),
    check("kit_template_lines_quantity_chk", sql`${t.quantity} > 0`),
    check("kit_template_lines_per_chk", sql`${t.per} in ${inList(KIT_LINE_PER)}`),
  ],
);

export const kitTemplateProducts = pgTable(
  "kit_template_products",
  {
    templateId: uuid("template_id")
      .notNull()
      .references(() => kitTemplates.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.productId], name: "kit_template_products_pk" }),
    index("kit_template_products_product_idx").on(t.productId),
  ],
);

/** Етап 5: колекції шаблону (applies_to = collections). Колекцію не видаляють, лише позначають deleted_at. */
export const kitTemplateCollections = pgTable(
  "kit_template_collections",
  {
    templateId: uuid("template_id")
      .notNull()
      .references(() => kitTemplates.id, { onDelete: "cascade" }),
    collectionId: uuid("collection_id")
      .notNull()
      .references(() => collections.id),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.collectionId], name: "kit_template_collections_pk" }),
    index("kit_template_collections_collection_idx").on(t.collectionId),
  ],
);

// ---------------------------------------------------------------------------
// Етап 6: фінанси, курси, собівартість, доставка, витрати, партнери, повернення (docs/stage6-design.md §17).
// Домовленості: гроші — numeric(14,2) + валюта char(3) з CHECK `^[A-Z]{3}$`; курси — numeric(20,10) за 1 одиницю;
// бізнес-дати — date (Київ); store_id — у кожній фінансовій таблиці, крім винятків §15 (глобальні stores, fx_rates;
// облік собівартості за складом; дочірні таблиці). Без персональних даних покупців (F9). Переліки кодів —
// app/domain/finance.ts. Записи журналу лише доповнюються (сторно — новий рядок), F2.
// ---------------------------------------------------------------------------

/** Курс: numeric(20,10) — гривень за 1 одиницю валюти (rate / units точно). */
const rateNum = (name: string) => numeric(name, { precision: 20, scale: 10 });
const currencyCode = (name: string) => char(name, { length: 3 });
const bizDate = (name: string) => date(name, { mode: "string" });
/** Магазин (етап 6 — завжди 'default'); бізнесові унікальні ключі включають store_id (§15). */
const storeId = () =>
  text("store_id")
    .notNull()
    .default("default")
    .references((): AnyPgColumn => stores.id);
/** CHECK формату коду валюти (NULL проходить — для необов'язкових колонок). */
const currencyChk = (name: string, col: AnyPgColumn) => check(name, sql`${col} ~ '^[A-Z]{3}$'`);

// --- 17.1 Ядро ----------------------------------------------------------------

/**
 * Магазини (глобальна). Рядок 'default' створює міграція 0012; getDefaultStore — єдиний спосіб визначити магазин
 * (modules/finance/core/store.server.ts). Другий магазин не підключається (§15).
 */
export const stores = pgTable(
  "stores",
  {
    id: text("id").primaryKey(),
    shopDomain: text("shop_domain").unique(),
    name: text("name").notNull(),
    shopCurrency: currencyCode("shop_currency"),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("stores_one_default_uq").on(t.isDefault).where(sql`${t.isDefault}`),
    currencyChk("stores_shop_currency_chk", t.shopCurrency),
  ],
);

/** Стан фінансових фонових процесів магазину (водяні знаки звірки, довантаження). */
export const financeState = pgTable("finance_state", {
  storeId: text("store_id")
    .primaryKey()
    .references(() => stores.id),
  reconcileWatermark: timestamp("reconcile_watermark", { withTimezone: true }),
  valuationBackfilledAt: timestamp("valuation_backfilled_at", { withTimezone: true }),
  backfilledAt: timestamp("backfilled_at", { withTimezone: true }),
  backfillCursor: text("backfill_cursor"),
  /** Останнє отримання курсів НБУ (WP1; лише час і код результату, без тексту відповіді). */
  fxFetchedAt: timestamp("fx_fetched_at", { withTimezone: true }),
  fxFetchStatus: text("fx_fetch_status"),
  updatedAt: updatedAt(),
});

/** Деталі запису журналу / розбіжності: лише коди, id, кількості, десяткові рядки, дати (без персональних даних). */
export type FinanceDetails = Record<string, string | number | boolean | null | ReadonlyArray<string | number>>;

/**
 * Фінансовий журнал — єдине джерело кожного грошового числа (F1). Запис = один факт × одна категорія у початковій
 * валюті; сума ≠ 0 (CHECK); виправлення — сторно (reverses_entry_id, ключ `<ключ>:rev`) + новий запис. Прогнози сюди
 * НІКОЛИ не пишуться (order_finance_forecasts). Проведення — лише modules/finance/core/entries.server.ts.
 */
export const financeEntries = pgTable(
  "finance_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    storeId: storeId(),
    idempotencyKey: text("idempotency_key").notNull(),
    category: text("category").notNull(),
    /** Дата періоду звіту (Київ). */
    recognizedOn: bizDate("recognized_on").notNull(),
    /** Економічна дата до перенесення із закритого місяця. */
    originalOn: bizDate("original_on").notNull(),
    /** Дата курсу запису (§3.3); сторно — завжди fx_on оригіналу. */
    fxOn: bizDate("fx_on").notNull(),
    isLate: boolean("is_late").notNull().default(false),
    isLateCompletion: boolean("is_late_completion").notNull().default(false),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    presentmentAmount: money("presentment_amount"),
    presentmentCurrency: currencyCode("presentment_currency"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    /** Без FK: позиції видаляє синхронізація Shopify. */
    orderLineItemId: uuid("order_line_item_id"),
    variantId: uuid("variant_id"),
    stockItemId: uuid("stock_item_id"),
    quantity: integer("quantity"),
    shipmentId: uuid("shipment_id"),
    partnerId: uuid("partner_id"),
    carrierCode: text("carrier_code"),
    /** Країна призначення, зафіксована при проведенні. */
    countryCode: char("country_code", { length: 2 }),
    sourceType: text("source_type").notNull(),
    sourceId: text("source_id").notNull(),
    reversesEntryId: uuid("reverses_entry_id").references((): AnyPgColumn => financeEntries.id),
    details: jsonb("details").$type<FinanceDetails>().notNull().default({}),
    postedAt: timestamp("posted_at", { withTimezone: true }).notNull().defaultNow(),
    postedBy: text("posted_by").notNull(),
  },
  (t) => [
    uniqueIndex("finance_entries_seq_uq").on(t.seq),
    uniqueIndex("finance_entries_key_uq").on(t.storeId, t.idempotencyKey),
    uniqueIndex("finance_entries_reverses_uq").on(t.reversesEntryId),
    index("finance_entries_recognized_idx").on(t.storeId, t.recognizedOn),
    index("finance_entries_order_idx").on(t.orderId),
    index("finance_entries_category_idx").on(t.storeId, t.category, t.recognizedOn),
    index("finance_entries_source_idx").on(t.sourceType, t.sourceId),
    index("finance_entries_partner_idx").on(t.partnerId).where(sql`${t.partnerId} is not null`),
    index("finance_entries_stock_item_idx").on(t.stockItemId).where(sql`${t.stockItemId} is not null`),
    index("finance_entries_fx_on_idx").on(t.fxOn),
    check("finance_entries_amount_chk", sql`${t.amount} <> 0`),
    check("finance_entries_key_len_chk", sql`char_length(${t.idempotencyKey}) between 1 and 200`),
    check("finance_entries_category_chk", sql`${t.category} in ${inList(FINANCE_CATEGORIES)}`),
    check("finance_entries_source_type_chk", sql`${t.sourceType} in ${inList(FINANCE_SOURCE_TYPES)}`),
    currencyChk("finance_entries_currency_chk", t.currency),
    currencyChk("finance_entries_presentment_currency_chk", t.presentmentCurrency),
    check(
      "finance_entries_presentment_chk",
      sql`(${t.presentmentAmount} is null) = (${t.presentmentCurrency} is null)`,
    ),
  ],
);

/** Компоненти фінансів замовлення (zod OrderComponents — modules/finance/core/states.ts). */
export type OrderComponentsJson = Record<string, unknown>;

/** Фінанси замовлення: визнання, стани складників, прибуток (лише власник). Веде syncOrderFinance (WP4). */
export const orderFinance = pgTable(
  "order_finance",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "cascade" }),
    storeId: storeId(),
    state: text("state", { enum: ORDER_FINANCE_STATES }).notNull().default("open"),
    recognizedOn: bizDate("recognized_on"),
    recognizedAt: timestamp("recognized_at", { withTimezone: true }),
    recognitionBasis: text("recognition_basis", { enum: RECOGNITION_BASES }),
    shopCurrency: currencyCode("shop_currency"),
    components: jsonb("components").$type<OrderComponentsJson>().notNull().default({}),
    profitState: text("profit_state", { enum: PROFIT_STATES }).notNull().default("n/a"),
    needsReview: boolean("needs_review").notNull().default(false),
    reviewReasons: text("review_reasons").array().notNull().default(sql`'{}'::text[]`),
    factsSource: text("facts_source", { enum: FACTS_SOURCES }).notNull().default("none"),
    factsFetchedAt: timestamp("facts_fetched_at", { withTimezone: true }),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
    overrides: jsonb("overrides").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("order_finance_state_idx").on(t.state, t.recognizedOn),
    index("order_finance_profit_state_idx").on(t.profitState),
    index("order_finance_review_idx").on(t.needsReview).where(sql`${t.needsReview}`),
    check("order_finance_state_chk", sql`${t.state} in ${inList(ORDER_FINANCE_STATES)}`),
    check("order_finance_profit_state_chk", sql`${t.profitState} in ${inList(PROFIT_STATES)}`),
    check("order_finance_basis_chk", sql`${t.recognitionBasis} in ${inList(RECOGNITION_BASES)}`),
    check("order_finance_facts_source_chk", sql`${t.factsSource} in ${inList(FACTS_SOURCES)}`),
    // Визнане замовлення має дату визнання; дата, раз установлена, не рухається (F6) — і при пізнішому excluded
    // (вимкнено includeTestOrders), тож стан ≠ recognized дату не забороняє.
    check(
      "order_finance_recognized_chk",
      sql`(${t.state} <> 'recognized' or ${t.recognizedOn} is not null) and (${t.recognizedOn} is null) = (${t.recognizedAt} is null)`,
    ),
    currencyChk("order_finance_shop_currency_chk", t.shopCurrency),
  ],
);

/** Прогнози складників замовлення (НІКОЛИ не в журналі; бажаний стан замінюється syncOrderFinance). Дочірня (§15). */
export const orderFinanceForecasts = pgTable(
  "order_finance_forecasts",
  {
    orderId: uuid("order_id")
      .notNull()
      .references(() => orderFinance.orderId, { onDelete: "cascade" }),
    component: text("component", { enum: ORDER_COMPONENTS }).notNull(),
    currency: currencyCode("currency").notNull(),
    amount: money("amount").notNull(),
    basis: text("basis").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.component, t.currency], name: "order_finance_forecasts_pk" }),
    check("order_finance_forecasts_component_chk", sql`${t.component} in ${inList(ORDER_COMPONENTS)}`),
    check("order_finance_forecasts_basis_chk", sql`${t.basis} in ${inList(FINANCE_BASES)}`),
    currencyChk("order_finance_forecasts_currency_chk", t.currency),
  ],
);

/**
 * Історія фінансових змін (§14.4): до → після (десяткові рядки, коди, ISO-дати; ключі обмежені zod на тип сутності —
 * modules/finance/core/change-log.server.ts), причина (маскована, ≤ 300). НЕ проходить через redact() (він маскує
 * суми й дати). Пишеться в тій самій транзакції, що й зміна.
 */
export const financeChangeLog = pgTable(
  "finance_change_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    storeId: storeId(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    action: text("action").notNull(),
    before: jsonb("before").$type<Record<string, unknown>>(),
    after: jsonb("after").$type<Record<string, unknown>>(),
    reason: text("reason"),
    actorId: text("actor_id").notNull(),
    actorRole: text("actor_role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("finance_change_log_entity_idx").on(t.entityType, t.entityId, t.createdAt),
    index("finance_change_log_store_idx").on(t.storeId, t.createdAt),
    check("finance_change_log_entity_chk", sql`${t.entityType} in ${inList(FINANCE_CHANGE_ENTITY_TYPES)}`),
    check("finance_change_log_action_chk", sql`${t.action} in ${inList(FINANCE_CHANGE_ACTIONS)}`),
    check("finance_change_log_reason_chk", sql`${t.reason} is null or char_length(${t.reason}) <= 300`),
  ],
);

/** Реєстр фінансових розбіжностей (лише власник; «Потребує уваги»; ніколи не issues — §14.2). */
export const financeDiscrepancies = pgTable(
  "finance_discrepancies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    type: text("type").notNull(),
    status: text("status", { enum: DISCREPANCY_STATUSES }).notNull().default("open"),
    severity: text("severity", { enum: DISCREPANCY_SEVERITIES }).notNull().default("warning"),
    orderId: uuid("order_id").references(() => orders.id, { onDelete: "cascade" }),
    shipmentId: uuid("shipment_id"),
    invoiceLineId: uuid("invoice_line_id"),
    carrierCode: text("carrier_code"),
    details: jsonb("details").$type<FinanceDetails>().notNull().default({}),
    resolutionCode: text("resolution_code"),
    resolutionNote: text("resolution_note"),
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    dedupeKey: text("dedupe_key").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("finance_discrepancies_dedupe_uq").on(t.storeId, t.dedupeKey),
    index("finance_discrepancies_status_idx").on(t.storeId, t.status, t.type),
    index("finance_discrepancies_order_idx").on(t.orderId).where(sql`${t.orderId} is not null`),
    check("finance_discrepancies_type_chk", sql`${t.type} in ${inList(DISCREPANCY_CODES)}`),
    check("finance_discrepancies_status_chk", sql`${t.status} in ${inList(DISCREPANCY_STATUSES)}`),
    check("finance_discrepancies_severity_chk", sql`${t.severity} in ${inList(DISCREPANCY_SEVERITIES)}`),
    check("finance_discrepancies_resolution_chk", sql`${t.resolutionCode} is null or ${t.resolutionCode} in ${inList(DISCREPANCY_RESOLUTIONS)}`),
  ],
);

/** Місяці (закриття, чек-лист, право на «Чистий прибуток»), §3.4. month — перший день місяця. */
export const financePeriods = pgTable(
  "finance_periods",
  {
    storeId: storeId(),
    month: bizDate("month").notNull(),
    status: text("status", { enum: FINANCE_PERIOD_STATUSES }).notNull().default("open"),
    checklist: jsonb("checklist").$type<Record<string, unknown>>().notNull().default({}),
    netProfitEligible: boolean("net_profit_eligible").notNull().default(false),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    closedBy: text("closed_by"),
    reopenedAt: timestamp("reopened_at", { withTimezone: true }),
    reopenedBy: text("reopened_by"),
    reopenReason: text("reopen_reason"),
    snapshotId: uuid("snapshot_id"),
    version: integer("version").notNull().default(1),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.storeId, t.month], name: "finance_periods_pk" }),
    check("finance_periods_status_chk", sql`${t.status} in ${inList(FINANCE_PERIOD_STATUSES)}`),
    check("finance_periods_month_chk", sql`extract(day from ${t.month}) = 1`),
  ],
);

/**
 * Знімки звітів (§13.1): лише агрегати, без персональних даних і імен партнерів; data_sha256 — канонічний JSON без
 * generatedAt. Повторне формування — version + 1. Зберігає лише ядро (saveReportSnapshot).
 */
export const financeReportSnapshots = pgTable(
  "finance_report_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    kind: text("kind", { enum: REPORT_KINDS }).notNull(),
    periodFrom: bizDate("period_from").notNull(),
    periodTo: bizDate("period_to").notNull(),
    reportingCurrency: currencyCode("reporting_currency").notNull(),
    source: text("source", { enum: SNAPSHOT_SOURCES }).notNull(),
    isFinal: boolean("is_final").notNull().default(false),
    schemaVersion: integer("schema_version").notNull(),
    data: jsonb("data").$type<unknown>().notNull(),
    ratesUsed: jsonb("rates_used").$type<unknown[]>().notNull().default([]),
    dataSha256: char("data_sha256", { length: 64 }).notNull(),
    version: integer("version").notNull(),
    generatedBy: text("generated_by").notNull(),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("finance_report_snapshots_uq").on(t.storeId, t.kind, t.periodFrom, t.reportingCurrency, t.version),
    check("finance_report_snapshots_kind_chk", sql`${t.kind} in ${inList(REPORT_KINDS)}`),
    check("finance_report_snapshots_source_chk", sql`${t.source} in ${inList(SNAPSHOT_SOURCES)}`),
    check("finance_report_snapshots_period_chk", sql`${t.periodFrom} <= ${t.periodTo}`),
    check("finance_report_snapshots_version_chk", sql`${t.version} >= 1`),
    currencyChk("finance_report_snapshots_currency_chk", t.reportingCurrency),
  ],
);

// --- 17.2 Курси ----------------------------------------------------------------

/**
 * Курси (глобальна): гривень за `units` одиниць валюти, як опубліковано; rate_per_unit = rate / units точно. НБУ/демо —
 * лише вставка (один рядок на дату); вручну — версії (попередня is_current = false). Єдине джерело курсу для фінансів —
 * rateFor (modules/fx/rate-for.server.ts).
 */
export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source", { enum: FX_RATE_SOURCES }).notNull(),
    currency: currencyCode("currency").notNull(),
    quoteCurrency: currencyCode("quote_currency").notNull().default("UAH"),
    effectiveDate: bizDate("effective_date").notNull(),
    rate: numeric("rate", { precision: 18, scale: 6 }).notNull(),
    units: integer("units").notNull().default(1),
    ratePerUnit: rateNum("rate_per_unit").notNull(),
    /** calcdate НБУ (пробіл до 05.07.2019 → null). */
    setOn: bizDate("set_on"),
    version: integer("version").notNull().default(1),
    isCurrent: boolean("is_current").notNull().default(true),
    enteredBy: text("entered_by"),
    reason: text("reason"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("fx_rates_auto_uq")
      .on(t.source, t.currency, t.quoteCurrency, t.effectiveDate)
      .where(sql`${t.source} in ('nbu', 'demo')`),
    uniqueIndex("fx_rates_manual_version_uq")
      .on(t.currency, t.quoteCurrency, t.effectiveDate, t.version)
      .where(sql`${t.source} = 'manual'`),
    uniqueIndex("fx_rates_manual_current_uq")
      .on(t.currency, t.quoteCurrency, t.effectiveDate)
      .where(sql`${t.source} = 'manual' and ${t.isCurrent}`),
    index("fx_rates_currency_date_idx").on(t.currency, t.effectiveDate),
    check("fx_rates_source_chk", sql`${t.source} in ${inList(FX_RATE_SOURCES)}`),
    check("fx_rates_units_chk", sql`${t.units} in (1, 10, 100, 1000, 10000)`),
    check("fx_rates_rate_chk", sql`${t.rate} > 0`),
    check("fx_rates_per_unit_chk", sql`${t.ratePerUnit} * ${t.units} = ${t.rate}`),
    check("fx_rates_not_self_chk", sql`${t.currency} <> ${t.quoteCurrency}`),
    check("fx_rates_version_chk", sql`${t.version} >= 1`),
    currencyChk("fx_rates_currency_chk", t.currency),
    currencyChk("fx_rates_quote_currency_chk", t.quoteCurrency),
  ],
);

/** Обмін валюти (§10.4): один запис fx_difference за §5.7. */
export const fxConversions = pgTable(
  "fx_conversions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    occurredOn: bizDate("occurred_on").notNull(),
    soldAmount: money("sold_amount").notNull(),
    soldCurrency: currencyCode("sold_currency").notNull(),
    boughtAmount: money("bought_amount").notNull(),
    boughtCurrency: currencyCode("bought_currency").notNull(),
    counterparty: text("counterparty", { enum: FX_CONVERSION_COUNTERPARTIES }).notNull().default("bank"),
    note: text("note"),
    status: text("status", { enum: ACTIVE_VOIDED }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    operationId: uuid("operation_id").notNull().unique(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("fx_conversions_date_idx").on(t.storeId, t.occurredOn),
    check("fx_conversions_amounts_chk", sql`${t.soldAmount} > 0 and ${t.boughtAmount} > 0`),
    check("fx_conversions_currencies_chk", sql`${t.soldCurrency} <> ${t.boughtCurrency}`),
    check("fx_conversions_counterparty_chk", sql`${t.counterparty} in ${inList(FX_CONVERSION_COUNTERPARTIES)}`),
    check("fx_conversions_status_chk", sql`${t.status} in ${inList(ACTIVE_VOIDED)}`),
    currencyChk("fx_conversions_sold_currency_chk", t.soldCurrency),
    currencyChk("fx_conversions_bought_currency_chk", t.boughtCurrency),
  ],
);

// --- 17.3 Факти Shopify ----------------------------------------------------------

/** Знімок фінансових підсумків замовлення Shopify (звірка RC1–RC5; MoneyBag-и як десяткові рядки). */
export const orderShopifyFinance = pgTable(
  "order_shopify_finance",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "cascade" }),
    storeId: storeId(),
    shopCurrency: currencyCode("shop_currency"),
    presentmentCurrency: currencyCode("presentment_currency"),
    taxesIncluded: boolean("taxes_included"),
    edited: boolean("edited"),
    returnStatus: text("return_status"),
    displayFinancialStatus: text("display_financial_status"),
    paymentGatewayNames: text("payment_gateway_names").array().notNull().default(sql`'{}'::text[]`),
    discountCodes: text("discount_codes").array().notNull().default(sql`'{}'::text[]`),
    referralCode: text("referral_code"),
    journeyReady: boolean("journey_ready"),
    journeyChecks: smallint("journey_checks").notNull().default(0),
    transactionsCount: integer("transactions_count"),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull().default({}),
    reconciliation: jsonb("reconciliation").$type<Record<string, unknown>>().notNull().default({}),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
    shopifyUpdatedAt: timestamp("shopify_updated_at", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    currencyChk("order_shopify_finance_shop_currency_chk", t.shopCurrency),
    currencyChk("order_shopify_finance_presentment_currency_chk", t.presentmentCurrency),
  ],
);

/** Продажі угод Shopify (Order.agreements → Sale). Рядки незмінні; повтор з іншими значеннями → розбіжність. */
export const orderSales = pgTable(
  "order_sales",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifySaleId: text("shopify_sale_id").notNull(),
    agreementId: text("agreement_id").notNull(),
    agreementKind: text("agreement_kind", { enum: AGREEMENT_KINDS }).notNull(),
    agreementReason: text("agreement_reason"),
    happenedAt: timestamp("happened_at", { withTimezone: true }).notNull(),
    refundId: text("refund_id"),
    actionType: text("action_type").notNull(),
    lineType: text("line_type").notNull(),
    quantity: integer("quantity"),
    lineItemGid: text("line_item_gid"),
    /** Без FK: позиції видаляє синхронізація. */
    orderLineItemId: uuid("order_line_item_id"),
    totalAmount: money("total_amount").notNull(),
    totalTax: money("total_tax").notNull(),
    discountBeforeTax: money("discount_before_tax"),
    currency: currencyCode("currency").notNull(),
    pTotalAmount: money("p_total_amount").notNull(),
    pTotalTax: money("p_total_tax").notNull(),
    pCurrency: currencyCode("p_currency").notNull(),
    source: text("source", { enum: ORDER_SALE_SOURCES }).notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_sales_sale_uq").on(t.storeId, t.shopifySaleId),
    index("order_sales_order_idx").on(t.orderId),
    check("order_sales_agreement_kind_chk", sql`${t.agreementKind} in ${inList(AGREEMENT_KINDS)}`),
    check("order_sales_source_chk", sql`${t.source} in ${inList(ORDER_SALE_SOURCES)}`),
    currencyChk("order_sales_currency_chk", t.currency),
    currencyChk("order_sales_p_currency_chk", t.pCurrency),
  ],
);

/** Транзакції замовлення (знімок об'єкта: PENDING → SUCCESS оновлює рядок; проводиться лише SUCCESS). */
export const orderTransactions = pgTable(
  "order_transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyTransactionId: text("shopify_transaction_id").notNull(),
    parentTransactionId: text("parent_transaction_id"),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    test: boolean("test").notNull().default(false),
    gateway: text("gateway"),
    manualGateway: boolean("manual_gateway"),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    pAmount: money("p_amount"),
    pCurrency: currencyCode("p_currency"),
    settlementCurrency: currencyCode("settlement_currency"),
    settlementRate: rateNum("settlement_rate"),
    fxAdjustmentId: text("fx_adjustment_id"),
    fxAdjustment: money("fx_adjustment"),
    fxAdjustmentCurrency: currencyCode("fx_adjustment_currency"),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAtShopify: timestamp("created_at_shopify", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_transactions_uq").on(t.storeId, t.shopifyTransactionId),
    index("order_transactions_order_idx").on(t.orderId),
    currencyChk("order_transactions_currency_chk", t.currency),
    currencyChk("order_transactions_p_currency_chk", t.pCurrency),
    currencyChk("order_transactions_settlement_currency_chk", t.settlementCurrency),
    currencyChk("order_transactions_fx_currency_chk", t.fxAdjustmentCurrency),
  ],
);

/** Комісії транзакцій Shopify Payments (TransactionFee); у P&L — лише amount (D-14). */
export const orderTransactionFees = pgTable(
  "order_transaction_fees",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => orderTransactions.id, { onDelete: "cascade" }),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyFeeId: text("shopify_fee_id").notNull(),
    type: text("type"),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    flatFee: money("flat_fee"),
    flatFeeCurrency: currencyCode("flat_fee_currency"),
    /** Як отримано від Shopify (Decimal-рядок). */
    rate: text("rate"),
    rateName: text("rate_name"),
    taxAmount: money("tax_amount"),
    taxCurrency: currencyCode("tax_currency"),
    createdAtShopify: timestamp("created_at_shopify", { withTimezone: true }),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_transaction_fees_uq").on(t.storeId, t.shopifyFeeId),
    index("order_transaction_fees_order_idx").on(t.orderId),
    currencyChk("order_transaction_fees_currency_chk", t.currency),
    currencyChk("order_transaction_fees_flat_currency_chk", t.flatFeeCurrency),
    currencyChk("order_transaction_fees_tax_currency_chk", t.taxCurrency),
  ],
);

/** Повернення коштів Shopify (заголовки) — розділ «Повернення», статистика, звірка RC3. */
export const orderRefunds = pgTable(
  "order_refunds",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    shopifyRefundId: text("shopify_refund_id").notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAtShopify: timestamp("created_at_shopify", { withTimezone: true }),
    total: money("total").notNull(),
    currency: currencyCode("currency").notNull(),
    pTotal: money("p_total"),
    pCurrency: currencyCode("p_currency"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("order_refunds_uq").on(t.storeId, t.shopifyRefundId),
    index("order_refunds_order_idx").on(t.orderId),
    currencyChk("order_refunds_currency_chk", t.currency),
    currencyChk("order_refunds_p_currency_chk", t.pCurrency),
  ],
);

/** Рядки повернень коштів (дочірня; restockType RETURN + restocked — «повернено на склад Shopify», §14.3 п. 6). */
export const orderRefundLines = pgTable(
  "order_refund_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    refundId: uuid("refund_id")
      .notNull()
      .references(() => orderRefunds.id, { onDelete: "cascade" }),
    shopifyLineItemId: text("shopify_line_item_id").notNull(),
    /** Без FK: позиції видаляє синхронізація. */
    orderLineItemId: uuid("order_line_item_id"),
    quantity: integer("quantity").notNull(),
    restockType: text("restock_type"),
    restocked: boolean("restocked"),
    /**
     * Етап 6 (міграція 0013): розподіл кількості за типом повернення на склад (restockType → кількість), коли кілька
     * рядків повернення ОДНІЄЇ позиції в одному поверненні з РІЗНИМИ типами об'єднано в один рядок `MIXED`
     * (унікальний індекс refund_id + shopify_line_item_id); інакше null. Σ значень = quantity. Пише WP3 (writeRefunds),
     * читає WP9 (classifyRefund: рахує лише RETURN / після передачі).
     */
    restockQuantities: jsonb("restock_quantities").$type<Record<string, number>>(),
    subtotal: money("subtotal"),
    currency: currencyCode("currency"),
  },
  (t) => [
    uniqueIndex("order_refund_lines_uq").on(t.refundId, t.shopifyLineItemId),
    index("order_refund_lines_line_idx").on(t.orderLineItemId),
    currencyChk("order_refund_lines_currency_chk", t.currency),
    check("order_refund_lines_restock_quantities_chk", sql`${t.restockQuantities} is null or jsonb_typeof(${t.restockQuantities}) = 'object'`),
  ],
);

/** Спори / chargeback (з Order.disputes — без суми; суми й результат вносить власник, §8.2). */
export const orderDisputes = pgTable(
  "order_disputes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** id зі зведення Shopify або `manual:<uuid>`. */
    disputeGid: text("dispute_gid").notNull(),
    initiatedAs: text("initiated_as"),
    status: text("status"),
    /** Брутто (як списав банк). */
    amount: money("amount"),
    recoveredAmount: money("recovered_amount"),
    vatReducible: boolean("vat_reducible"),
    fullPartnerCancellation: boolean("full_partner_cancellation").notNull().default(false),
    currency: currencyCode("currency"),
    fee: money("fee"),
    feeCurrency: currencyCode("fee_currency"),
    outcome: text("outcome", { enum: DISPUTE_OUTCOMES }),
    decidedOn: bizDate("decided_on"),
    source: text("source", { enum: DISPUTE_SOURCES }).notNull(),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    statusChangedAt: timestamp("status_changed_at", { withTimezone: true }),
    updatedBy: text("updated_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    uniqueIndex("order_disputes_uq").on(t.storeId, t.disputeGid),
    index("order_disputes_order_idx").on(t.orderId),
    check("order_disputes_outcome_chk", sql`${t.outcome} is null or ${t.outcome} in ${inList(DISPUTE_OUTCOMES)}`),
    check("order_disputes_source_chk", sql`${t.source} in ${inList(DISPUTE_SOURCES)}`),
    check(
      "order_disputes_amounts_chk",
      sql`(${t.amount} is null or ${t.amount} >= 0) and (${t.recoveredAmount} is null or ${t.recoveredAmount} >= 0) and (${t.fee} is null or ${t.fee} >= 0)`,
    ),
    currencyChk("order_disputes_currency_chk", t.currency),
    currencyChk("order_disputes_fee_currency_chk", t.feeCurrency),
  ],
);

// --- 17.4 Собівартість (за складом: без store_id, §15) ----------------------------------

/** Стан пулу ковзної середньої на (склад, позиція) у валюті оцінки (§6.2). C0: on_hand = known + unknown − deficit. */
export const inventoryCostState = pgTable(
  "inventory_cost_state",
  {
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    currency: currencyCode("currency").notNull(),
    knownQty: integer("known_qty").notNull().default(0),
    knownValue: money("known_value").notNull().default("0"),
    unknownQty: integer("unknown_qty").notNull().default(0),
    deficitQty: integer("deficit_qty").notNull().default(0),
    lastAvgUnit: rateNum("last_avg_unit"),
    /** seq останнього оціненого руху (inventory_movements.seq). */
    lastSeq: bigint("last_seq", { mode: "number" }).notNull().default(0),
    version: integer("version").notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.warehouseId, t.stockItemId], name: "inventory_cost_state_pk" }),
    index("inventory_cost_state_item_idx").on(t.stockItemId),
    check(
      "inventory_cost_state_nonneg_chk",
      sql`${t.knownQty} >= 0 and ${t.knownValue} >= 0 and ${t.unknownQty} >= 0 and ${t.deficitQty} >= 0`,
    ),
    currencyChk("inventory_cost_state_currency_chk", t.currency),
  ],
);

/** Шари без вартості / дефіцитні / брак (FIFO за created_seq), §6.2. */
export const inventoryCostLayers = pgTable(
  "inventory_cost_layers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    kind: text("kind", { enum: COST_LAYER_KINDS }).notNull(),
    reason: text("reason", { enum: COST_LAYER_REASONS }).notNull(),
    qtyIn: integer("qty_in").notNull(),
    qtyOpen: integer("qty_open").notNull(),
    /** Лише defect: вартість, визнана збитком, що ще може повернутися ремонтом. */
    valueOpen: money("value_open"),
    /** Лише fx_pending: початкова ціна одиниці у валюті надходження. */
    pendingUnitCost: money("pending_unit_cost"),
    pendingCurrency: currencyCode("pending_currency"),
    /** return_without_cost: оцінка продажу, з якого повернуто. */
    sourceValuationId: uuid("source_valuation_id").references((): AnyPgColumn => inventoryValuations.id),
    /** Оцінка, що створила шар. */
    originValuationId: uuid("origin_valuation_id").references((): AnyPgColumn => inventoryValuations.id),
    createdSeq: bigint("created_seq", { mode: "number" }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("inventory_cost_layers_open_idx")
      .on(t.warehouseId, t.stockItemId, t.kind, t.createdSeq)
      .where(sql`${t.qtyOpen} > 0`),
    check("inventory_cost_layers_kind_chk", sql`${t.kind} in ${inList(COST_LAYER_KINDS)}`),
    check("inventory_cost_layers_reason_chk", sql`${t.reason} in ${inList(COST_LAYER_REASONS)}`),
    check("inventory_cost_layers_qty_chk", sql`${t.qtyIn} > 0 and ${t.qtyOpen} >= 0 and ${t.qtyOpen} <= ${t.qtyIn}`),
    check("inventory_cost_layers_value_chk", sql`${t.valueOpen} is null or (${t.kind} = 'defect' and ${t.valueOpen} >= 0)`),
    check(
      "inventory_cost_layers_pending_chk",
      sql`(${t.pendingUnitCost} is null) = (${t.pendingCurrency} is null) and (${t.pendingUnitCost} is null or ${t.pendingUnitCost} >= 0)`,
    ),
    currencyChk("inventory_cost_layers_pending_currency_chk", t.pendingCurrency),
  ],
);

/** Оцінки рухів (незмінні), порядок — seq (identity), §6.2. */
export const inventoryValuations = pgTable(
  "inventory_valuations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    seq: bigint("seq", { mode: "number" }).generatedAlwaysAsIdentity(),
    movementSeq: bigint("movement_seq", { mode: "number" }),
    /** mv:<movementId> | adj:<movementId>:v<n> | complete:<operationId>:<stockItemId> | fx:<layerId>. */
    eventKey: text("event_key").notNull().unique(),
    /**
     * Рух складу (без FK — свідомо, §17 «Без FK»: журнал складу етапу 5 скидають тести й демо, а зв'язок оцінки з рухом
     * задає унікальний event_key `mv:<movementId>`).
     */
    movementId: uuid("movement_id").unique(),
    warehouseId: uuid("warehouse_id")
      .notNull()
      .references(() => warehouses.id),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    currency: currencyCode("currency").notNull(),
    kind: text("kind", { enum: VALUATION_KINDS }).notNull(),
    qty: integer("qty").notNull(),
    knownQty: integer("known_qty").notNull().default(0),
    unknownQty: integer("unknown_qty").notNull().default(0),
    deficitQty: integer("deficit_qty").notNull().default(0),
    /** Відома частина вартості (null — невідомо). */
    value: money("value"),
    valueSource: text("value_source", { enum: VALUATION_VALUE_SOURCES }).notNull(),
    drawnLayers: jsonb("drawn_layers").$type<Array<{ layerId: string; qty: number }>>().notNull().default([]),
    /** Лише виходи продажу: скільки одиниць уже повернуто. */
    returnedQty: integer("returned_qty").notNull().default(0),
    originalAmount: money("original_amount"),
    originalCurrency: currencyCode("original_currency"),
    rateDate: bizDate("rate_date"),
    rateSource: text("rate_source"),
    orderId: uuid("order_id"),
    orderLineItemId: uuid("order_line_item_id"),
    /** Стан пулу після оцінки; null для sale_completion. */
    knownQtyAfter: integer("known_qty_after"),
    knownValueAfter: money("known_value_after"),
    unknownQtyAfter: integer("unknown_qty_after"),
    deficitQtyAfter: integer("deficit_qty_after"),
    occurredOn: bizDate("occurred_on").notNull(),
    details: jsonb("details").$type<FinanceDetails>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("inventory_valuations_seq_uq").on(t.seq),
    index("inventory_valuations_item_seq_idx").on(t.stockItemId, t.seq),
    index("inventory_valuations_item_date_idx").on(t.stockItemId, t.occurredOn),
    index("inventory_valuations_order_idx").on(t.orderId),
    check("inventory_valuations_kind_chk", sql`${t.kind} in ${inList(VALUATION_KINDS)}`),
    check("inventory_valuations_value_source_chk", sql`${t.valueSource} in ${inList(VALUATION_VALUE_SOURCES)}`),
    check(
      "inventory_valuations_qty_chk",
      sql`${t.qty} >= 0 and ${t.knownQty} >= 0 and ${t.unknownQty} >= 0 and ${t.deficitQty} >= 0 and ${t.returnedQty} >= 0`,
    ),
    currencyChk("inventory_valuations_currency_chk", t.currency),
    currencyChk("inventory_valuations_original_currency_chk", t.originalCurrency),
  ],
);

/** Пізніші завершення невідомих / дефіцитних одиниць виходу (§6.2). */
export const inventoryValuationCompletions = pgTable(
  "inventory_valuation_completions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    valuationId: uuid("valuation_id")
      .notNull()
      .references(() => inventoryValuations.id),
    layerId: uuid("layer_id").references(() => inventoryCostLayers.id),
    qty: integer("qty").notNull(),
    value: money("value").notNull(),
    basis: text("basis").notNull(),
    eventKey: text("event_key").notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [
    index("inventory_valuation_completions_valuation_idx").on(t.valuationId),
    check("inventory_valuation_completions_qty_chk", sql`${t.qty} > 0 and ${t.value} >= 0`),
  ],
);

/** Ручна собівартість власника (лише вставка; останній effective_from ≤ дата, потім created_at), §6.6. */
export const stockItemCosts = pgTable(
  "stock_item_costs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    stockItemId: uuid("stock_item_id")
      .notNull()
      .references(() => stockItems.id),
    unitCost: money("unit_cost").notNull(),
    currency: currencyCode("currency").notNull(),
    effectiveFrom: bizDate("effective_from").notNull(),
    source: text("source", { enum: STOCK_ITEM_COST_SOURCES }).notNull(),
    confirmed: boolean("confirmed").notNull().default(true),
    note: text("note"),
    /** `manual:<operationId>:<variantId>` (масово за моделлю й кольором) — повтор форми не дублює рядки. */
    idempotencyKey: text("idempotency_key").unique(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("stock_item_costs_lookup_idx").on(t.stockItemId, t.effectiveFrom.desc(), t.createdAt.desc()),
    check("stock_item_costs_source_chk", sql`${t.source} in ${inList(STOCK_ITEM_COST_SOURCES)}`),
    check("stock_item_costs_cost_chk", sql`${t.unitCost} >= 0`),
    currencyChk("stock_item_costs_currency_chk", t.currency),
  ],
);

// --- 17.5 Доставка й імпорт --------------------------------------------------------

/** Розрахунок перевізника при створенні накладної («не рахунок»), прогноз №1 (§7.1). */
export const shipmentCostEstimates = pgTable(
  "shipment_cost_estimates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    shipmentId: uuid("shipment_id")
      .notNull()
      .references(() => shipments.id, { onDelete: "cascade" }),
    carrierCode: text("carrier_code").notNull(),
    kind: text("kind", { enum: SHIPMENT_ESTIMATE_KINDS }).notNull().default("carrier_reported"),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    currencyAssumed: boolean("currency_assumed").notNull().default(false),
    serviceCode: text("service_code"),
    payer: text("payer"),
    chargeableWeightGrams: integer("chargeable_weight_grams"),
    source: text("source", { enum: SHIPMENT_ESTIMATE_SOURCES }).notNull(),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipment_cost_estimates_uq").on(t.shipmentId, t.kind),
    check("shipment_cost_estimates_kind_chk", sql`${t.kind} in ${inList(SHIPMENT_ESTIMATE_KINDS)}`),
    check("shipment_cost_estimates_source_chk", sql`${t.source} in ${inList(SHIPMENT_ESTIMATE_SOURCES)}`),
    check("shipment_cost_estimates_amount_chk", sql`${t.amount} >= 0`),
    currencyChk("shipment_cost_estimates_currency_chk", t.currency),
  ],
);

/** Заморожений прогноз доставки на момент визнання (лише вставка), §7.1. */
export const shippingForecastSnapshots = pgTable(
  "shipping_forecast_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** shipment:<id> | external:<id> | order. */
    waybillKey: text("waybill_key").notNull(),
    shipmentId: uuid("shipment_id"),
    externalWaybillId: uuid("external_waybill_id"),
    carrierCode: text("carrier_code"),
    countryCode: char("country_code", { length: 2 }),
    basis: text("basis", { enum: SHIPPING_FORECAST_BASES }).notNull(),
    amount: money("amount"),
    currency: currencyCode("currency"),
    basisDetails: jsonb("basis_details").$type<FinanceDetails>().notNull().default({}),
    lateSnapshot: boolean("late_snapshot").notNull().default(false),
    frozenAt: timestamp("frozen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("shipping_forecast_snapshots_uq").on(t.orderId, t.waybillKey),
    check("shipping_forecast_snapshots_basis_chk", sql`${t.basis} in ${inList(SHIPPING_FORECAST_BASES)}`),
    check(
      "shipping_forecast_snapshots_amount_chk",
      sql`(${t.basis} = 'none') = (${t.amount} is null) and (${t.amount} is null) = (${t.currency} is null)`,
    ),
    currencyChk("shipping_forecast_snapshots_currency_chk", t.currency),
  ],
);

/** Зовнішні номери накладних (відправлено поза застосунком; з Shopify або вручну), §7.4. Пише recordExternalWaybills. */
export const orderExternalWaybills = pgTable(
  "order_external_waybills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    carrierCode: text("carrier_code"),
    numberNorm: text("number_norm").notNull(),
    numberClass: text("number_class", { enum: WAYBILL_NUMBER_CLASSES }).notNull(),
    source: text("source", { enum: EXTERNAL_WAYBILL_SOURCES }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("order_external_waybills_uq").on(t.orderId, t.numberNorm),
    index("order_external_waybills_number_idx").on(t.numberNorm),
    check("order_external_waybills_source_chk", sql`${t.source} in ${inList(EXTERNAL_WAYBILL_SOURCES)}`),
    check("order_external_waybills_class_chk", sql`${t.numberClass} in ${inList(WAYBILL_NUMBER_CLASSES)}`),
  ],
);

/** Профілі колонок імпорту рахунків перевізника (версіоновані), §7.3. */
export const carrierImportProfiles = pgTable(
  "carrier_import_profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    carrierCode: text("carrier_code").notNull(),
    name: text("name").notNull(),
    headerSignature: text("header_signature").notNull(),
    sheet: text("sheet"),
    headerRow: integer("header_row").notNull().default(1),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
    version: integer("version").notNull().default(1),
    active: boolean("active").notNull().default(true),
    builtin: boolean("builtin").notNull().default(false),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("carrier_import_profiles_active_uq")
      .on(t.storeId, t.carrierCode, t.headerSignature)
      .where(sql`${t.active}`),
    check("carrier_import_profiles_header_row_chk", sql`${t.headerRow} >= 1`),
  ],
);

/** Імпортовані рахунки / специфікації / кредит-ноти перевізника (файл НЕ зберігається), §7.3, §7.6. */
export const carrierInvoices = pgTable(
  "carrier_invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    carrierCode: text("carrier_code").notNull(),
    accountRef: text("account_ref").notNull().default(""),
    documentKind: text("document_kind", { enum: CARRIER_DOCUMENT_KINDS }).notNull(),
    parentInvoiceId: uuid("parent_invoice_id").references((): AnyPgColumn => carrierInvoices.id),
    /** Цей документ проводить витрати свого номера (рівно один серед активних). */
    posting: boolean("posting").notNull().default(false),
    invoiceNumber: text("invoice_number").notNull(),
    invoiceNumberNorm: text("invoice_number_norm").notNull(),
    invoiceDate: bizDate("invoice_date"),
    periodFrom: bizDate("period_from"),
    periodTo: bizDate("period_to"),
    currency: currencyCode("currency"),
    controlTotal: money("control_total"),
    totals: jsonb("totals").$type<Record<string, unknown>>().notNull().default({}),
    fileSha256: char("file_sha256", { length: 64 }).notNull(),
    fileSize: integer("file_size").notNull(),
    fileKind: text("file_kind", { enum: IMPORT_FILE_KINDS }).notNull(),
    encoding: text("encoding"),
    delimiter: text("delimiter"),
    profileId: uuid("profile_id").references(() => carrierImportProfiles.id),
    profileVersion: integer("profile_version"),
    status: text("status", { enum: CARRIER_INVOICE_STATUSES }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    replacesId: uuid("replaces_id").references((): AnyPgColumn => carrierInvoices.id),
    rowCount: integer("row_count").notNull().default(0),
    matchedCount: integer("matched_count").notNull().default(0),
    discrepancyCount: integer("discrepancy_count").notNull().default(0),
    operationId: uuid("operation_id").notNull().unique(),
    importedBy: text("imported_by").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    uniqueIndex("carrier_invoices_file_uq")
      .on(t.storeId, t.carrierCode, t.fileSha256)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("carrier_invoices_document_uq")
      .on(t.storeId, t.carrierCode, t.accountRef, t.invoiceNumberNorm, t.documentKind)
      .where(sql`${t.status} = 'active'`),
    uniqueIndex("carrier_invoices_posting_uq")
      .on(t.storeId, t.carrierCode, t.accountRef, t.invoiceNumberNorm)
      .where(sql`${t.status} = 'active' and ${t.posting}`),
    check("carrier_invoices_kind_chk", sql`${t.documentKind} in ${inList(CARRIER_DOCUMENT_KINDS)}`),
    check("carrier_invoices_status_chk", sql`${t.status} in ${inList(CARRIER_INVOICE_STATUSES)}`),
    check("carrier_invoices_file_kind_chk", sql`${t.fileKind} in ${inList(IMPORT_FILE_KINDS)}`),
    check("carrier_invoices_sha_chk", sql`${t.fileSha256} ~ '^[0-9a-f]{64}$'`),
    currencyChk("carrier_invoices_currency_chk", t.currency),
  ],
);

/** Рядки рахунку (лише зіставлені поля; назва послуги ≤ 200, маскована), дочірня (§15). */
export const carrierInvoiceLines = pgTable(
  "carrier_invoice_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => carrierInvoices.id, { onDelete: "cascade" }),
    sheet: text("sheet").notNull().default(""),
    rowNumber: integer("row_number").notNull(),
    waybillRaw: text("waybill_raw"),
    waybillNorm: text("waybill_norm"),
    numberClass: text("number_class"),
    lineKind: text("line_kind", { enum: INVOICE_LINE_KINDS }).notNull(),
    serviceName: text("service_name"),
    chargeType: text("charge_type", { enum: CHARGE_TYPES }).notNull(),
    chargeDate: bizDate("charge_date"),
    amount: money("amount").notNull(),
    amountExclVat: money("amount_excl_vat"),
    vatAmount: money("vat_amount"),
    currency: currencyCode("currency").notNull(),
    billedWeightGrams: integer("billed_weight_grams"),
    shipmentId: uuid("shipment_id"),
    externalWaybillId: uuid("external_waybill_id"),
    orderId: uuid("order_id"),
    matchStatus: text("match_status", { enum: INVOICE_MATCH_STATUSES }).notNull(),
    matchVersion: integer("match_version").notNull().default(1),
    flags: text("flags").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    uniqueIndex("carrier_invoice_lines_uq").on(t.invoiceId, t.sheet, t.rowNumber),
    index("carrier_invoice_lines_waybill_idx").on(t.waybillNorm),
    index("carrier_invoice_lines_shipment_idx").on(t.shipmentId),
    index("carrier_invoice_lines_order_idx").on(t.orderId),
    check("carrier_invoice_lines_kind_chk", sql`${t.lineKind} in ${inList(INVOICE_LINE_KINDS)}`),
    check("carrier_invoice_lines_charge_chk", sql`${t.chargeType} in ${inList(CHARGE_TYPES)}`),
    check("carrier_invoice_lines_match_chk", sql`${t.matchStatus} in ${inList(INVOICE_MATCH_STATUSES)}`),
    check("carrier_invoice_lines_service_chk", sql`${t.serviceName} is null or char_length(${t.serviceName}) <= 200`),
    currencyChk("carrier_invoice_lines_currency_chk", t.currency),
  ],
);

// --- 17.6 Витрати, комісії, партнери, повернення ---------------------------------------

/** Партнери й блогери (§9.1). display_name — лише сторінки й експорти власника (ніколи audit_log/логи/бот/ШІ). */
export const partners = pgTable(
  "partners",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    displayName: text("display_name").notNull(),
    kind: text("kind", { enum: PARTNER_KINDS }).notNull().default("partner"),
    status: text("status", { enum: PARTNER_STATUSES }).notNull().default("active"),
    holdDays: integer("hold_days").notNull().default(30),
    payoutCurrency: currencyCode("payout_currency"),
    note: text("note"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("partners_kind_chk", sql`${t.kind} in ${inList(PARTNER_KINDS)}`),
    check("partners_status_chk", sql`${t.status} in ${inList(PARTNER_STATUSES)}`),
    check("partners_hold_chk", sql`${t.holdDays} between 0 and 365`),
    check("partners_name_chk", sql`char_length(${t.displayName}) between 1 and 120`),
    currencyChk("partners_payout_currency_chk", t.payoutCurrency),
  ],
);

/** Коди партнерів: коди знижок Shopify і реферальні (§9.1). */
export const partnerCodes = pgTable(
  "partner_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    code: text("code").notNull(),
    codeNorm: text("code_norm").notNull(),
    source: text("source", { enum: PARTNER_CODE_SOURCES }).notNull(),
    validFrom: bizDate("valid_from"),
    validTo: bizDate("valid_to"),
    active: boolean("active").notNull().default(true),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("partner_codes_active_uq")
      .on(t.storeId, t.source, t.codeNorm)
      .where(sql`${t.active}`),
    index("partner_codes_partner_idx").on(t.partnerId),
    check("partner_codes_source_chk", sql`${t.source} in ${inList(PARTNER_CODE_SOURCES)}`),
    check("partner_codes_validity_chk", sql`${t.validFrom} is null or ${t.validTo} is null or ${t.validFrom} <= ${t.validTo}`),
  ],
);

/** Історія ставок партнера (дочірня; діє ставка на дату замовлення), §9.1. */
export const partnerRates = pgTable(
  "partner_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    codeId: uuid("code_id").references(() => partnerCodes.id),
    rateBp: integer("rate_bp").notNull(),
    effectiveFrom: bizDate("effective_from").notNull(),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("partner_rates_uq").on(t.partnerId, t.codeId, t.effectiveFrom).nullsNotDistinct(),
    check("partner_rates_rate_chk", sql`${t.rateBp} between 0 and 10000`),
  ],
);

/** Атрибуція замовлення партнеру (одна на замовлення), §9.2. */
export const partnerAttributions = pgTable(
  "partner_attributions",
  {
    orderId: uuid("order_id")
      .primaryKey()
      .references(() => orders.id, { onDelete: "cascade" }),
    storeId: storeId(),
    partnerId: uuid("partner_id").references(() => partners.id),
    codeId: uuid("code_id").references(() => partnerCodes.id),
    source: text("source", { enum: ATTRIBUTION_SOURCES }).notNull(),
    rateBp: integer("rate_bp"),
    holdDays: integer("hold_days"),
    status: text("status", { enum: ATTRIBUTION_STATUSES }).notNull(),
    /** Кандидати неоднозначної атрибуції (id партнерів) тощо — без персональних даних. */
    details: jsonb("details").$type<FinanceDetails>().notNull().default({}),
    decidedBy: text("decided_by"),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    reason: text("reason"),
  },
  (t) => [
    index("partner_attributions_partner_idx").on(t.partnerId),
    check("partner_attributions_source_chk", sql`${t.source} in ${inList(ATTRIBUTION_SOURCES)}`),
    check("partner_attributions_status_chk", sql`${t.status} in ${inList(ATTRIBUTION_STATUSES)}`),
    check(
      "partner_attributions_attributed_chk",
      sql`${t.status} <> 'attributed' or (${t.partnerId} is not null and ${t.rateBp} is not null and ${t.holdDays} is not null)`,
    ),
    check("partner_attributions_rate_chk", sql`${t.rateBp} is null or ${t.rateBp} between 0 and 10000`),
  ],
);

/** Події винагороди партнера (журнал; стан виводиться при читанні), §9.4. */
export const partnerCommissionEvents = pgTable(
  "partner_commission_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    n: integer("n").notNull(),
    kind: text("kind", { enum: COMMISSION_EVENT_KINDS }).notNull(),
    base: money("base").notNull(),
    rateBp: integer("rate_bp").notNull(),
    /** Зі знаком (нарахування +, коригування ±, скасування −). */
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    recognizedOn: bizDate("recognized_on").notNull(),
    holdUntil: bizDate("hold_until"),
    /** pc:<orderId>:<partnerId>:<n> — глобально унікальний (§15). */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    reason: text("reason"),
    createdAt: createdAt(),
  },
  (t) => [
    index("partner_commission_events_partner_idx").on(t.partnerId, t.recognizedOn),
    index("partner_commission_events_order_idx").on(t.orderId),
    check("partner_commission_events_kind_chk", sql`${t.kind} in ${inList(COMMISSION_EVENT_KINDS)}`),
    check("partner_commission_events_rate_chk", sql`${t.rateBp} between 0 and 10000`),
    currencyChk("partner_commission_events_currency_chk", t.currency),
  ],
);

/** Виплати партнерам (гроші, не P&L — partner_payout_memo), §9.5. */
export const partnerPayouts = pgTable(
  "partner_payouts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    partnerId: uuid("partner_id")
      .notNull()
      .references(() => partners.id),
    operationId: uuid("operation_id").notNull().unique(),
    paidOn: bizDate("paid_on").notNull(),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    coversAmount: money("covers_amount").notNull(),
    coversCurrency: currencyCode("covers_currency").notNull(),
    method: text("method", { enum: PAYOUT_METHODS }).notNull().default("bank"),
    reference: text("reference"),
    note: text("note"),
    status: text("status", { enum: ACTIVE_VOIDED }).notNull().default("active"),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("partner_payouts_partner_idx").on(t.partnerId, t.paidOn),
    check("partner_payouts_amount_chk", sql`${t.amount} > 0 and ${t.coversAmount} > 0`),
    check("partner_payouts_method_chk", sql`${t.method} in ${inList(PAYOUT_METHODS)}`),
    check("partner_payouts_status_chk", sql`${t.status} in ${inList(ACTIVE_VOIDED)}`),
    check("partner_payouts_reference_chk", sql`${t.reference} is null or char_length(${t.reference}) <= 100`),
    currencyChk("partner_payouts_currency_chk", t.currency),
    currencyChk("partner_payouts_covers_currency_chk", t.coversCurrency),
  ],
);

/** Випадки повернень (§11). */
export const orderReturns = pgTable(
  "order_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: RETURN_KINDS }).notNull(),
    status: text("status", { enum: RETURN_STATUSES }).notNull().default("open"),
    reasonCode: text("reason_code", { enum: RETURN_REASON_CODES }).notNull().default("unknown"),
    /** Маскована, ≤ 300. */
    reasonNote: text("reason_note"),
    source: text("source", { enum: RETURN_SOURCES }).notNull(),
    /** ret:refund:<refundId> | ret:receipt:<movementId> | ret:manual:<uuid> … — повтор не створює другого випадку. */
    sourceKey: text("source_key").notNull().unique(),
    firstSignalAt: timestamp("first_signal_at", { withTimezone: true }).notNull().defaultNow(),
    receivedAt: timestamp("received_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("order_returns_order_idx").on(t.orderId),
    index("order_returns_status_idx").on(t.status),
    check("order_returns_kind_chk", sql`${t.kind} in ${inList(RETURN_KINDS)}`),
    check("order_returns_status_chk", sql`${t.status} in ${inList(RETURN_STATUSES)}`),
    check("order_returns_reason_chk", sql`${t.reasonCode} in ${inList(RETURN_REASON_CODES)}`),
    check("order_returns_source_chk", sql`${t.source} in ${inList(RETURN_SOURCES)}`),
    check("order_returns_note_chk", sql`${t.reasonNote} is null or char_length(${t.reasonNote}) <= 300`),
  ],
);

/** Позиції випадку повернення (дочірня). */
export const orderReturnLines = pgTable(
  "order_return_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    returnId: uuid("return_id")
      .notNull()
      .references(() => orderReturns.id, { onDelete: "cascade" }),
    /** Без FK: позиції видаляє синхронізація. */
    orderLineItemId: uuid("order_line_item_id"),
    variantId: uuid("variant_id"),
    quantity: integer("quantity").notNull(),
    condition: text("condition", { enum: RETURN_LINE_CONDITIONS }).notNull().default("unknown"),
    restockedQty: integer("restocked_qty").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index("order_return_lines_return_idx").on(t.returnId),
    check("order_return_lines_qty_chk", sql`${t.quantity} > 0 and ${t.restockedQty} >= 0 and ${t.restockedQty} <= ${t.quantity}`),
    check("order_return_lines_condition_chk", sql`${t.condition} in ${inList(RETURN_LINE_CONDITIONS)}`),
  ],
);

/**
 * Ручні витрати й доходи (§10.1). Редагування = новий рядок (supersedes_id) + анулювання старого; у журналі — сторно +
 * нові записи. CHECK: категорії з обов'язковим / забороненим замовленням, inventory_loss ⇔ production_batch_id.
 */
export const financeExpenses = pgTable(
  "finance_expenses",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    category: text("category").notNull(),
    /** ≠ 0; кредит — від'ємна. Знак запису журналу визначає категорія (вид). */
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    expenseDate: bizDate("expense_date"),
    periodFrom: bizDate("period_from"),
    periodTo: bizDate("period_to"),
    /** Маскований, ≤ 200. */
    description: text("description"),
    channel: text("channel", { enum: EXPENSE_CHANNELS }),
    gateway: text("gateway"),
    carrierCode: text("carrier_code"),
    partnerId: uuid("partner_id").references(() => partners.id),
    orderId: uuid("order_id").references(() => orders.id),
    returnId: uuid("return_id").references(() => orderReturns.id),
    productionBatchId: uuid("production_batch_id").references(() => productionBatches.id),
    document: text("document"),
    coversForecast: boolean("covers_forecast").notNull().default(false),
    separateFromForecast: boolean("separate_from_forecast").notNull().default(false),
    separateReason: text("separate_reason"),
    status: text("status", { enum: ACTIVE_VOIDED }).notNull().default("active"),
    version: integer("version").notNull().default(1),
    operationId: uuid("operation_id").notNull().unique(),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => financeExpenses.id),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
    voidedAt: timestamp("voided_at", { withTimezone: true }),
    voidReason: text("void_reason"),
  },
  (t) => [
    index("finance_expenses_date_idx").on(t.storeId, t.expenseDate),
    index("finance_expenses_category_idx").on(t.category),
    index("finance_expenses_order_idx").on(t.orderId).where(sql`${t.orderId} is not null`),
    check("finance_expenses_category_chk", sql`${t.category} in ${inList(EXPENSE_CATEGORIES)}`),
    check("finance_expenses_amount_chk", sql`${t.amount} <> 0`),
    check("finance_expenses_status_chk", sql`${t.status} in ${inList(ACTIVE_VOIDED)}`),
    check("finance_expenses_channel_chk", sql`${t.channel} is null or ${t.channel} in ${inList(EXPENSE_CHANNELS)}`),
    check(
      "finance_expenses_order_required_chk",
      sql`${t.category} not in ${inList(EXPENSE_CATEGORIES_ORDER_REQUIRED)} or ${t.orderId} is not null`,
    ),
    check(
      "finance_expenses_order_forbidden_chk",
      sql`${t.category} not in ${inList(EXPENSE_CATEGORIES_ORDER_FORBIDDEN)} or (${t.orderId} is null and ${t.returnId} is null)`,
    ),
    check(
      "finance_expenses_batch_chk",
      sql`(${t.category} = 'inventory_loss') = (${t.productionBatchId} is not null)`,
    ),
    check("finance_expenses_partner_chk", sql`${t.category} <> 'partner_fixed_fee' or ${t.partnerId} is not null`),
    check("finance_expenses_return_chk", sql`${t.returnId} is null or ${t.orderId} is not null`),
    check(
      "finance_expenses_date_chk",
      sql`(${t.expenseDate} is not null) or (${t.periodFrom} is not null and ${t.periodTo} is not null)`,
    ),
    check(
      "finance_expenses_period_chk",
      sql`(${t.periodFrom} is null) = (${t.periodTo} is null) and (${t.periodFrom} is null or (${t.periodFrom} <= ${t.periodTo} and ${t.periodTo} - ${t.periodFrom} < 366))`,
    ),
    check(
      "finance_expenses_forecast_chk",
      sql`not (${t.coversForecast} and ${t.separateFromForecast}) and (not ${t.separateFromForecast} or ${t.separateReason} is not null)`,
    ),
    check("finance_expenses_description_chk", sql`${t.description} is null or char_length(${t.description}) <= 200`),
    currencyChk("finance_expenses_currency_chk", t.currency),
  ],
);

/** Частки суми періоду, розподілені на замовлення (дочірня; версія), §10.3. */
export const financeExpenseAllocations = pgTable(
  "finance_expense_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expenseId: uuid("expense_id")
      .notNull()
      .references(() => financeExpenses.id),
    expenseVersion: integer("expense_version").notNull(),
    orderId: uuid("order_id")
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    amount: money("amount").notNull(),
    currency: currencyCode("currency").notNull(),
    /** forecast | revenue. */
    weightBasis: text("weight_basis").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("finance_expense_allocations_uq").on(t.expenseId, t.expenseVersion, t.orderId),
    index("finance_expense_allocations_order_idx").on(t.orderId),
    check("finance_expense_allocations_basis_chk", sql`${t.weightBasis} in ('forecast', 'revenue')`),
    currencyChk("finance_expense_allocations_currency_chk", t.currency),
  ],
);

/** Правила комісій шлюзів (рядки незмінні; зміна закриває поточний — applies_to — і додає новий), §8.1. */
export const financeFeeRules = pgTable(
  "finance_fee_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storeId: storeId(),
    gateway: text("gateway").notNull(),
    kind: text("kind", { enum: FEE_RULE_KINDS }).notNull(),
    percentBp: integer("percent_bp").notNull().default(0),
    fixedAmount: money("fixed_amount"),
    fixedCurrency: currencyCode("fixed_currency"),
    noFees: boolean("no_fees").notNull().default(false),
    appliesFrom: bizDate("applies_from").notNull(),
    appliesTo: bizDate("applies_to"),
    createdBy: text("created_by").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("finance_fee_rules_gateway_idx").on(t.gateway, t.appliesFrom),
    check("finance_fee_rules_kind_chk", sql`${t.kind} in ${inList(FEE_RULE_KINDS)}`),
    check("finance_fee_rules_percent_chk", sql`${t.percentBp} between 0 and 10000`),
    check(
      "finance_fee_rules_fixed_chk",
      sql`(${t.fixedAmount} is null) = (${t.fixedCurrency} is null) and (${t.fixedAmount} is null or ${t.fixedAmount} >= 0)`,
    ),
    check("finance_fee_rules_period_chk", sql`${t.appliesTo} is null or ${t.appliesFrom} <= ${t.appliesTo}`),
    currencyChk("finance_fee_rules_currency_chk", t.fixedCurrency),
  ],
);

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
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("product_variants_sku_idx").on(t.sku),
    index("product_variants_barcode_idx").on(t.barcode),
    index("product_variants_inventory_item_idx").on(t.inventoryItemId),
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
    unitPrice: money("unit_price").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    imageUrl: text("image_url"),
    position: integer("position").notNull().default(0),
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
  webhooksRegisteredAt: timestamp("webhooks_registered_at", { withTimezone: true }),
  productsSyncedAt: timestamp("products_synced_at", { withTimezone: true }),
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

export const KIT_APPLIES_TO = ["all", "products"] as const;
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
  },
  (t) => [
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
    /** all — усі замовлення; products — лише замовлення з товарами з kit_template_products. */
    appliesTo: text("applies_to", { enum: KIT_APPLIES_TO }).notNull().default("all"),
    /** Більший пріоритет застосовується першим. */
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

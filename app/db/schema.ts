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
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
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

export const warehouses = pgTable("warehouses", {
  id: uuid("id").primaryKey().defaultRandom(),
  legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id),
  name: text("name").notNull(),
  countryCode: char("country_code", { length: 2 }).notNull(),
  city: text("city").notNull(),
  address: text("address"),
  shopifyLocationId: text("shopify_location_id"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

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
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("orders_status_idx").on(t.status),
    index("orders_country_idx").on(t.shipCountryCode),
    index("orders_placed_at_idx").on(t.placedAt),
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
    quantity: integer("quantity").notNull(),
    unitPrice: money("unit_price").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    imageUrl: text("image_url"),
    position: integer("position").notNull().default(0),
  },
  (t) => [
    index("order_line_items_order_idx").on(t.orderId),
    uniqueIndex("order_line_items_shopify_uq").on(t.orderId, t.shopifyLineItemId),
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

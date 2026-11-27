import { count, eq, inArray, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import {
  auditLog,
  collections,
  countryRules,
  inventoryBalances,
  inventoryConflicts,
  inventoryMovements,
  issues,
  jobs,
  kitTemplateCollections,
  kitTemplateLines,
  kitTemplateProducts,
  kitTemplates,
  orderChanges,
  orderLineItems,
  orderPacking,
  orders,
  packagingMaterials,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  productCollections,
  productVariants,
  products,
  sandboxCarrierShipments,
  settings,
  settingsHistory,
  shipmentEvents,
  shipmentTrackingEvents,
  shipments,
  stockAlerts,
  stockItems,
  stockReservations,
  warehouses,
  legalEntities,
  webhookEvents,
} from "~/db/schema";
import { assertTransition, type OrderStatus } from "~/domain/order-status";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { addMoney, multiplyMoney } from "~/lib/money";
import { writeAudit } from "~/modules/audit/audit.server";
import { DEFAULT_SETTINGS, type AllSettings } from "~/modules/settings/schema";
import { ensureDefaultSettings } from "~/modules/settings/settings.server";
import { cancelOrder, createWaybill } from "~/modules/shipments/waybill.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { DEFAULT_COUNTRY_RULES } from "~/modules/validation/default-country-rules";
import type { ServiceContext } from "~/server/types";
import { ensureDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { syncOrderReservations } from "~/modules/inventory/reservations.server";
import {
  DEMO_COLLECTIONS,
  DEMO_ORDERS,
  DEMO_PRODUCTS,
  DEMO_SALES_HISTORY,
  DEMO_SHIPPER,
  SIMULATED_ORDER_TEMPLATES,
  type DemoOrderSeed,
} from "./demo-data";
import { isDemoWarehouseSeeded, seedDemoWarehouse, upgradeDemoWarehouseForCollections } from "./demo-warehouse.server";

/** Довідкові дані, потрібні в обох режимах (ідемпотентно; наявні записи не перезаписуються). */
export async function seedReferenceData(db: Db, settingsOverrides: Partial<AllSettings> = {}): Promise<void> {
  await db
    .insert(countryRules)
    .values(
      DEFAULT_COUNTRY_RULES.map((r) => ({
        countryCode: r.countryCode,
        nameEn: r.nameEn,
        nameUk: r.nameUk,
        shippingEnabled: r.shippingEnabled,
        postalCodeRequired: r.postalCodeRequired,
        postalCodePattern: r.postalCodePattern,
        postalCodeExample: r.postalCodeExample,
        provinceRequired: r.provinceRequired,
        phoneRequired: r.phoneRequired,
        dutyPayer: r.dutyPayer,
        notes: r.notes,
      })),
    )
    .onConflictDoNothing({ target: countryRules.countryCode });
  await ensureDefaultSettings(db, settingsOverrides);
  // Етап 5: склад за замовчуванням «Основний склад» (один; ідемпотентно).
  await ensureDefaultWarehouse(db);
}

export const DEMO_SETTINGS: Partial<AllSettings> = {
  automation: { mode: "semi", globalPause: false },
  shipper: { ...DEMO_SHIPPER, taxId: "", eori: "", ioss: "" },
  packaging: DEFAULT_SETTINGS.packaging,
  testCarrier: { simulation: "none" },
};

/** Варіант демо-каталогу за ключем DEMO_PRODUCTS (для позицій вигаданих замовлень). */
type DemoCatalog = Map<string, { id: string; title: string; variantTitle: string; sku: string; price: string; imageUrl: string }>;

async function insertDemoCatalog(db: Db): Promise<DemoCatalog> {
  const byKey: DemoCatalog = new Map();
  for (const p of DEMO_PRODUCTS) {
    const [product] = await db
      .insert(products)
      .values({ title: p.title, handle: p.handle, imageUrl: p.imageUrl })
      .returning({ id: products.id });
    for (const v of p.variants) {
      const [variant] = await db
        .insert(productVariants)
        .values({
          productId: product!.id,
          title: v.title,
          sku: v.sku,
          barcode: v.barcode,
          color: v.color,
          model: v.model,
          price: v.price,
          currency: "EUR",
          weightGrams: v.weightGrams,
          lengthMm: v.dimsMm?.[0] ?? null,
          widthMm: v.dimsMm?.[1] ?? null,
          heightMm: v.dimsMm?.[2] ?? null,
          hsCode: v.hsCode,
          countryOfOrigin: v.countryOfOrigin,
          customsDescription: v.customsDescription,
          imageUrl: p.imageUrl,
          inventoryAvailable: v.inventoryAvailable,
        })
        .returning({ id: productVariants.id });
      byKey.set(v.key, { id: variant!.id, title: p.title, variantTitle: v.title, sku: v.sku, price: v.price, imageUrl: p.imageUrl });
    }
  }
  const [entity] = await db
    .insert(legalEntities)
    .values({ name: "ONE TUNNE (демо)", countryCode: "UA", baseCurrency: "UAH" })
    .returning({ id: legalEntities.id });
  // Етап 5: демо використовує склад за замовчуванням (seedReferenceData), прив'язаний до демо-юрособи.
  const warehouse = await ensureDefaultWarehouse(db);
  await db.update(warehouses).set({ legalEntityId: entity!.id, city: "Київ", updatedAt: new Date() }).where(eq(warehouses.id, warehouse.id));
  return byKey;
}

/** Демо-каталог з бази (за SKU демо-варіантів): ключ DEMO_PRODUCTS → варіант. Варіанти, яких немає, пропускаються. */
async function loadDemoCatalog(db: DbOrTx): Promise<DemoCatalog> {
  const catalogRows = await db
    .select({ id: productVariants.id, sku: productVariants.sku, title: products.title, variantTitle: productVariants.title, price: productVariants.price, imageUrl: products.imageUrl })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id));
  const catalog: DemoCatalog = new Map();
  for (const p of DEMO_PRODUCTS) {
    for (const v of p.variants) {
      const row = catalogRows.find((r) => r.sku === v.sku);
      if (row) catalog.set(v.key, { id: row.id, title: row.title, variantTitle: row.variantTitle, sku: v.sku, price: row.price, imageUrl: row.imageUrl ?? "" });
    }
  }
  return catalog;
}

async function insertOrder(
  db: DbOrTx,
  seed: DemoOrderSeed,
  catalog: DemoCatalog,
  now: Date,
  opts: { status?: OrderStatus } = {},
): Promise<string> {
  const lines = seed.items.map((i, position) => {
    const v = catalog.get(i.variant);
    if (!v) throw new Error(`Unknown demo variant ${i.variant}`);
    return { ...v, quantity: i.quantity, position };
  });
  const subtotal = addMoney("0.00", ...lines.map((l) => multiplyMoney(l.price, l.quantity)));
  const placedAt = new Date(now.getTime() - seed.hoursAgo * 3600_000);
  const [order] = await db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: seed.number,
      status: opts.status ?? "paid",
      currency: "EUR",
      subtotal,
      shippingPaid: seed.shippingPaid,
      total: addMoney(subtotal, seed.shippingPaid),
      email: seed.email,
      contactPhone: seed.contactPhone,
      shipFirstName: seed.shipping.firstName,
      shipLastName: seed.shipping.lastName,
      shipCompany: seed.shipping.company ?? null,
      shipAddress1: seed.shipping.address1,
      shipAddress2: seed.shipping.address2 ?? null,
      shipCity: seed.shipping.city,
      shipProvince: seed.shipping.province ?? null,
      shipPostalCode: seed.shipping.postalCode,
      shipCountryCode: seed.shipping.countryCode,
      shipPhone: seed.shipping.phone,
      note: `DEMO · ${seed.scenario}`,
      priority: seed.priority ?? 0,
      placedAt,
      createdAt: placedAt,
    })
    .returning({ id: orders.id });
  await db.insert(orderLineItems).values(
    lines.map((l) => ({
      orderId: order!.id,
      variantId: l.id,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: l.price,
      currency: "EUR",
      imageUrl: l.imageUrl,
      position: l.position,
    })),
  );
  return order!.id;
}

/** Просуває історичне замовлення дозволеними переходами (без обходу автомата станів). */
async function advanceStatus(db: DbOrTx, orderId: string, path: OrderStatus[]): Promise<void> {
  const [row] = await db.select({ status: orders.status }).from(orders).where(eq(orders.id, orderId));
  let current = row!.status;
  for (const next of path) {
    assertTransition(current, next);
    await db.update(orders).set({ status: next, version: sql`${orders.version} + 1` }).where(eq(orders.id, orderId));
    current = next;
  }
}

export async function isDemoSeeded(db: Db): Promise<boolean> {
  const [row] = await db.select({ c: count() }).from(orders);
  return Number(row?.c ?? 0) > 0;
}

/** Заповнює порожню демо-базу. `ctx` повинен містити тестового перевізника. */
export async function seedDemoData(ctx: ServiceContext): Promise<void> {
  const db = ctx.db;
  await seedReferenceData(db, DEMO_SETTINGS);
  if (!(await isDemoSeeded(db))) await seedDemoOrders(ctx);
  // Етап 5: історія продажів для аналітики (окремо ідемпотентно — і для демо-баз, заповнених до її появи). До складу:
  // у новій базі відкриття обліку бачить її як відправлену — нічого не резервує й не враховує.
  await seedDemoSalesHistory(ctx);
  // Етап 5: колекції й склад (окремо ідемпотентно — і для демо-баз, заповнених до етапу 5).
  const collectionsCreated = await seedDemoCollections(db);
  const warehouseSeededBefore = await isDemoWarehouseSeeded(ctx);
  await seedDemoWarehouse(ctx);
  // Демо-база зі складом, заповнена до появи колекцій: шаблони «на колекцію» й габарити варіантів — один раз.
  if (collectionsCreated && warehouseSeededBefore) await upgradeDemoWarehouseForCollections(ctx);
}

/**
 * Вигадані колекції й членство товарів (за handle товару). Ідемпотентно: якщо колекції вже є — нічого не робить.
 * Повертає true, якщо колекції створено зараз.
 */
export async function seedDemoCollections(db: Db): Promise<boolean> {
  const [row] = await db.select({ c: count() }).from(collections);
  if (Number(row?.c ?? 0) > 0) return false;
  const catalog = await db.select({ id: products.id, handle: products.handle }).from(products);
  const byHandle = new Map(catalog.map((p) => [p.handle, p.id]));
  const handleOf = new Map(DEMO_PRODUCTS.map((p) => [p.key, p.handle]));
  await db.transaction(async (tx) => {
    for (const c of DEMO_COLLECTIONS) {
      const [inserted] = await tx.insert(collections).values({ title: c.title, handle: c.handle }).returning({ id: collections.id });
      const members = c.products.map((key) => byHandle.get(handleOf.get(key) ?? "")).filter((id): id is string => Boolean(id));
      if (members.length) await tx.insert(productCollections).values(members.map((productId) => ({ productId, collectionId: inserted!.id })));
    }
  });
  return true;
}

async function seedDemoOrders(ctx: ServiceContext): Promise<void> {
  const db = ctx.db;
  const now = ctx.now();
  const catalog = await insertDemoCatalog(db);
  const systemCtx: ServiceContext = { ...ctx, actor: SYSTEM_ACTOR };
  for (const seed of DEMO_ORDERS) {
    const orderId = await insertOrder(db, seed, catalog, now);
    if (!seed.history) continue;
    await validateOrderById(systemCtx, orderId, "seed");
    const result = await createWaybill(systemCtx, orderId, { source: "manual" });
    if (result.kind !== "created") throw new Error(`Demo seed: waybill for ${seed.number} → ${result.kind}`);
    if (seed.history === "delivered") {
      await advanceStatus(db, orderId, ["awaiting_picking", "packed", "handed_to_carrier", "in_transit", "delivered"]);
    } else if (seed.history === "cancelled") {
      await cancelOrder(systemCtx, orderId);
    }
  }
  await writeAudit(db, SYSTEM_ACTOR, "demo.seeded", { type: "system" }, { orders: DEMO_ORDERS.length });
}

/**
 * Етап 5: вигадана історія продажів (DEMO_SALES_HISTORY) — оплачені й уже доставлені замовлення за 6–85 днів до
 * заповнення, для аналітики складу (тренд, швидкість, прогноз вичерпання, рекомендації партій).
 * Як імпорт історії з Shopify (shopify-sync/mappers.ts initialStatus): виконане раніше замовлення з'являється
 * «Передано перевізнику» без накладної застосунку й далі лише дозволеним переходом стає «Доставлено». Тож воно:
 * - не потрапляє в чергу пакування (лише замовлення з накладною до передачі);
 * - не резервується й не списується: відкриття обліку й резерви пропускають відправлені замовлення
 *   (opening.server.ts NON_RESERVING_STATUSES), а синхронізація резервів його не викликає (немає накладної, Shopify,
 *   скасування) — початкові залишки й наявні сценарії (#0996–#0998, #1001–#1013) не змінюються.
 * Ідемпотентно: якщо хоч одне замовлення історії вже є — нічого не робить. Так демо-база, заповнена до появи історії,
 * отримує її один раз під час запуску (дати — від цього моменту). Позиції варіантів, яких у базі немає (змінено SKU),
 * пропускаються. Повертає кількість створених замовлень.
 */
export async function seedDemoSalesHistory(ctx: ServiceContext): Promise<number> {
  const db = ctx.db;
  const numbers = DEMO_SALES_HISTORY.map((o) => o.number);
  const [existing] = await db.select({ c: count() }).from(orders).where(inArray(orders.orderNumber, numbers));
  if (Number(existing?.c ?? 0) > 0) return 0;
  const catalog = await loadDemoCatalog(db);
  if (catalog.size === 0) return 0;
  const now = ctx.now();
  const created = await db.transaction(async (tx) => {
    let n = 0;
    for (const h of DEMO_SALES_HISTORY) {
      const items = h.items.filter((i) => catalog.has(i.variant));
      if (items.length === 0) continue;
      const seed: DemoOrderSeed = { ...h, items, contactPhone: null, hoursAgo: h.daysAgo * 24, scenario: "history: sales history (delivered)" };
      const orderId = await insertOrder(tx, seed, catalog, now, { status: "handed_to_carrier" });
      await advanceStatus(tx, orderId, ["delivered"]);
      n += 1;
    }
    return n;
  });
  if (created > 0) await writeAudit(db, SYSTEM_ACTOR, "demo.sales_history_seeded", { type: "system" }, { orders: created });
  return created;
}

/** Повне скидання демо-даних (лише демо-режим, лише власник — перевіряється у маршруті). */
export async function resetDemoData(ctx: ServiceContext): Promise<void> {
  const db = ctx.db;
  await db.transaction(async (tx) => {
    for (const table of [
      // Етап 5 (спершу — таблиці, що посилаються на замовлення, товари й матеріали).
      inventoryMovements,
      stockReservations,
      stockAlerts,
      inventoryConflicts,
      inventoryBalances,
      productionReceiptLines,
      productionReceipts,
      productionBatchLines,
      productionBatches,
      orderPacking,
      kitTemplateProducts,
      kitTemplateCollections,
      kitTemplateLines,
      kitTemplates,
      productCollections,
      collections,
      stockItems,
      shipmentTrackingEvents,
      shipmentEvents,
      shipments,
      sandboxCarrierShipments,
      issues,
      orderChanges,
      orderLineItems,
      orders,
      packagingMaterials,
      productVariants,
      products,
      warehouses,
      legalEntities,
      settingsHistory,
      settings,
      auditLog,
      webhookEvents,
      jobs,
    ]) {
      await tx.delete(table);
    }
  });
  await seedDemoData(ctx);
  await writeAudit(db, ctx.actor, "demo.reset", { type: "system" });
}

let simulatedCounter = 0;

/** Створює нове вигадане оплачене замовлення (імітація webhook orders/paid у демо). */
export async function insertSimulatedOrder(ctx: ServiceContext): Promise<string> {
  const db = ctx.db;
  const [maxRow] = await db
    .select({ max: sql<string | null>`max(cast(substring(${orders.orderNumber} from 2) as int))` })
    .from(orders)
    .where(sql`${orders.orderNumber} ~ '^#[0-9]+$'`);
  const next = Math.max(Number(maxRow?.max ?? 1013), 1013) + 1;
  const template = SIMULATED_ORDER_TEMPLATES[simulatedCounter++ % SIMULATED_ORDER_TEMPLATES.length]!;
  const catalog = await loadDemoCatalog(db);
  // Як webhook orders/paid: замовлення й резерв складу — в одній транзакції.
  const orderId = await db.transaction(async (tx) => {
    const id = await insertOrder(tx, { ...template, number: `#${next}`, hoursAgo: 0 }, catalog, ctx.now());
    await syncOrderReservations(tx, id, ctx.actor);
    return id;
  });
  await writeAudit(db, ctx.actor, "demo.order_simulated", { type: "order", id: orderId });
  return orderId;
}

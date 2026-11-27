import { count, eq, sql } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import {
  auditLog,
  countryRules,
  issues,
  jobs,
  orderChanges,
  orderLineItems,
  orders,
  productVariants,
  products,
  sandboxCarrierShipments,
  settings,
  settingsHistory,
  shipmentEvents,
  shipments,
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
import { DEMO_ORDERS, DEMO_PRODUCTS, DEMO_SHIPPER, SIMULATED_ORDER_TEMPLATES, type DemoOrderSeed } from "./demo-data";

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
}

export const DEMO_SETTINGS: Partial<AllSettings> = {
  automation: { mode: "semi", globalPause: false },
  shipper: { ...DEMO_SHIPPER, taxId: "", eori: "", ioss: "" },
  packaging: DEFAULT_SETTINGS.packaging,
  testCarrier: { simulation: "none" },
};

async function insertDemoCatalog(db: Db): Promise<Map<string, { id: string; title: string; variantTitle: string; sku: string; price: string; imageUrl: string }>> {
  const byKey = new Map<string, { id: string; title: string; variantTitle: string; sku: string; price: string; imageUrl: string }>();
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
  await db.insert(warehouses).values({ legalEntityId: entity!.id, name: "Склад Київ (демо)", countryCode: "UA", city: "Київ" });
  return byKey;
}

async function insertOrder(
  db: Db,
  seed: DemoOrderSeed,
  catalog: Awaited<ReturnType<typeof insertDemoCatalog>>,
  now: Date,
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
      status: "paid",
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
async function advanceStatus(db: Db, orderId: string, path: OrderStatus[]): Promise<void> {
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
  if (await isDemoSeeded(db)) return;
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

/** Повне скидання демо-даних (лише демо-режим, лише власник — перевіряється у маршруті). */
export async function resetDemoData(ctx: ServiceContext): Promise<void> {
  const db = ctx.db;
  await db.transaction(async (tx) => {
    for (const table of [
      shipmentEvents,
      shipments,
      sandboxCarrierShipments,
      issues,
      orderChanges,
      orderLineItems,
      orders,
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
  const catalogRows = await db
    .select({ id: productVariants.id, sku: productVariants.sku, title: products.title, variantTitle: productVariants.title, price: productVariants.price, imageUrl: products.imageUrl })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id));
  const catalog = new Map<string, { id: string; title: string; variantTitle: string; sku: string; price: string; imageUrl: string }>();
  for (const p of DEMO_PRODUCTS) {
    for (const v of p.variants) {
      const row = catalogRows.find((r) => r.sku === v.sku);
      if (row) catalog.set(v.key, { id: row.id, title: row.title, variantTitle: row.variantTitle, sku: v.sku, price: row.price, imageUrl: row.imageUrl ?? "" });
    }
  }
  const orderId = await insertOrder(db, { ...template, number: `#${next}`, hoursAgo: 0 }, catalog, ctx.now());
  await writeAudit(db, ctx.actor, "demo.order_simulated", { type: "order", id: orderId });
  return orderId;
}

/**
 * PRE-1 (огляд групи A): зміни застосунку (автовиправлення телефону/індексу тощо) у Shopify не передаються, тож поля
 * замовлення можуть відрізнятися від Shopify, хоча Shopify нічого не змінював. Наступне читання замовлення (webhook
 * після виконання, планове читання) не повинно повідомляти таку різницю як «змінено в Shopify» (SHOPIFY_ORDER_CHANGED)
 * чи перезаписувати автовиправлення сирим значенням Shopify. Справжні зміни в Shopify повідомляються/застосовуються,
 * як і раніше. Знімок значень Shopify — orders.shopify_contact_snapshot (міграція 0011); старі замовлення без знімка —
 * за історією змін (order_changes).
 * Production-контекст з тестовим перевізником (sandbox) — справжніх накладних немає; Admin API не викликається.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { issues, orderChanges, orders, shipments } from "~/db/schema";
import type { DatabaseHandle, Db } from "~/db/client.server";
import { MIGRATIONS_FOLDER } from "~/db/migrate.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import type { GqlOrder } from "~/integrations/shopify/graphql";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { mapOrder, mapProduct } from "~/modules/shopify-sync/mappers";
import { contactSnapshotOf, upsertOrder, upsertProduct } from "~/modules/shopify-sync/sync.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, openTestDatabase } from "../helpers";
import { gqlOrder, gqlProduct } from "../stage2/fixtures";

const LOCAL_PHONE = "015123456789";
const FIXED_PHONE = "+4915123456789";
let h: DatabaseHandle;
let ctx: ServiceContext;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = {
    mode: "production",
    db: h.db,
    actor: OWNER,
    carriers: createDemoCarriers(h.db),
    shopify: new QueueingShopifyGateway(h.db, async () => "ot-app-side.myshopify.com"),
    now: () => new Date(),
  };
  await upsertProduct(h.db, mapProduct(gqlProduct(1)), "EUR");
});
afterAll(async () => {
  await h.close();
});

const gid = (n: number) => `gid://shopify/Order/${n}`;
/** Замовлення Shopify з місцевим німецьким телефоном доставки (застосунок виправляє формат на +49…). */
function shopifyOrder(n: number, minutes: number, over: Partial<GqlOrder> = {}, address: Partial<NonNullable<GqlOrder["shippingAddress"]>> = {}): GqlOrder {
  const base = gqlOrder(n);
  return gqlOrder(n, {
    updatedAt: new Date(Date.parse("2026-11-20T10:00:00Z") + minutes * 60_000).toISOString(),
    shippingAddress: { ...base.shippingAddress!, phone: LOCAL_PHONE, ...address },
    ...over,
  });
}
async function orderRow(n: number) {
  const [o] = await h.db.select().from(orders).where(eq(orders.shopifyOrderId, gid(n)));
  return o!;
}
async function openChanged(orderId: string) {
  return h.db
    .select()
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.code, "SHOPIFY_ORDER_CHANGED"), eq(issues.status, "open")));
}
async function changesOf(orderId: string, source: "auto_fix" | "shopify_sync") {
  const rows = await h.db
    .select({ field: orderChanges.field, oldValue: orderChanges.oldValue, newValue: orderChanges.newValue })
    .from(orderChanges)
    .where(and(eq(orderChanges.orderId, orderId), eq(orderChanges.source, source)));
  return rows.sort((a, b) => a.field.localeCompare(b.field));
}
async function resolveChanged(orderId: string) {
  await h.db
    .update(issues)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: OWNER.id, resolution: "manual" })
    .where(and(eq(issues.orderId, orderId), eq(issues.code, "SHOPIFY_ORDER_CHANGED"), eq(issues.status, "open")));
}
/** Нове оплачене замовлення (live): автоматична перевірка (режим semi) виправляє формат телефону. */
async function paidWithAutoFixedPhone(n: number) {
  await upsertOrder(ctx, mapOrder(shopifyOrder(n, 0)), "live");
  const o = await orderRow(n);
  expect(o.shipPhone).toBe(FIXED_PHONE);
  expect(await changesOf(o.id, "auto_fix")).toContainEqual({ field: "shipping.phone", oldValue: LOCAL_PHONE, newValue: FIXED_PHONE });
  return o;
}

describe("app-side changes are not Shopify changes (PRE-1)", () => {
  it("the Shopify values are stored as the snapshot on create and on every update", async () => {
    const first = shopifyOrder(7100, 0);
    await upsertOrder(ctx, mapOrder(first), "live");
    expect((await orderRow(7100)).shopifyContactSnapshot).toEqual(contactSnapshotOf(mapOrder(first)));
    expect(contactSnapshotOf(mapOrder(first))["shipping.phone"]).toBe(LOCAL_PHONE);
    const next = shopifyOrder(7100, 5, {}, { city: "Potsdam", zip: "14467" });
    await upsertOrder(ctx, mapOrder(next), "live");
    expect((await orderRow(7100)).shopifyContactSnapshot).toMatchObject({ "shipping.city": "Potsdam", "shipping.postalCode": "14467", "shipping.phone": LOCAL_PHONE });
  });

  it("an auto-fixed phone is not reported after handover when Shopify sends the fulfillment update", async () => {
    const o = await paidWithAutoFixedPhone(7101);
    expect((await createWaybill(ctx, o.id)).kind).toBe("created");
    const [shipment] = await h.db.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, o.id));
    await markHandedOver(ctx, shipment!.id);
    expect((await orderRow(7101)).status).toBe("handed_to_carrier");
    // Звичайний orders/updated після виконання: новіший updatedAt, телефон у Shopify — той самий, сирий.
    const r = await upsertOrder(ctx, mapOrder(shopifyOrder(7101, 60, { displayFulfillmentStatus: "FULFILLED" })), "live");
    expect(r.result).not.toBe("conflict_reported");
    expect(await openChanged(o.id)).toEqual([]);
    const after = await orderRow(7101);
    expect(after.shipPhone).toBe(FIXED_PHONE);
    expect(after.fulfillmentStatus).toBe("fulfilled");
    expect(await changesOf(o.id, "shopify_sync")).toEqual([]);
  });

  it("a real Shopify change is still reported (only that field); a resolved report is not re-created for the same Shopify value", async () => {
    const o = await paidWithAutoFixedPhone(7102);
    expect((await createWaybill(ctx, o.id)).kind).toBe("created");
    await upsertOrder(ctx, mapOrder(shopifyOrder(7102, 10, {}, { city: "Hamburg" })), "live");
    const [reported] = await openChanged(o.id);
    expect(reported?.params).toEqual({ fields: "shipping.city" });
    expect((await orderRow(7102)).shipCity).toBe("Berlin");

    // Менеджер розібрався; наступне читання з тими самими даними Shopify проблему не відтворює.
    await resolveChanged(o.id);
    await upsertOrder(ctx, mapOrder(shopifyOrder(7102, 20, {}, { city: "Hamburg" })), "live");
    await upsertOrder(ctx, mapOrder(shopifyOrder(7102, 30, {}, { city: "Hamburg" })), "live");
    expect(await openChanged(o.id)).toEqual([]);

    // Нова зміна в Shopify (інший телефон) — знову проблема, саме з цим полем.
    await upsertOrder(ctx, mapOrder(shopifyOrder(7102, 40, {}, { city: "Hamburg", phone: "+4915199999999" })), "live");
    const [again] = await openChanged(o.id);
    expect(again?.params).toEqual({ fields: "shipping.phone" });
    expect((await orderRow(7102)).shipPhone).toBe(FIXED_PHONE);
    const all = await h.db.select({ id: issues.id }).from(issues).where(and(eq(issues.orderId, o.id), eq(issues.code, "SHOPIFY_ORDER_CHANGED")));
    expect(all).toHaveLength(2);
  });

  it("an editable order: an unrelated Shopify change is applied, the auto-fixed phone is not overwritten with the raw value", async () => {
    const o = await paidWithAutoFixedPhone(7103);
    await upsertOrder(ctx, mapOrder(shopifyOrder(7103, 10, {}, { city: "Potsdam", zip: "14467" })), "live");
    const after = await orderRow(7103);
    expect(after).toMatchObject({ shipCity: "Potsdam", shipPostalCode: "14467", shipPhone: FIXED_PHONE });
    expect((await changesOf(o.id, "shopify_sync")).map((c) => c.field)).toEqual(["shipping.city", "shipping.postalCode"]);
    // Автовиправлення не повторювалося (телефон не перезаписувався сирим значенням Shopify).
    expect((await changesOf(o.id, "auto_fix")).filter((c) => c.field === "shipping.phone")).toHaveLength(1);
    expect(await openChanged(o.id)).toEqual([]);
  });

  it("an order without a snapshot (before migration 0011) uses the change history: an auto-fix is not a Shopify change, other differences are", async () => {
    const o = await paidWithAutoFixedPhone(7104);
    expect((await createWaybill(ctx, o.id)).kind).toBe("created");
    await h.db.update(orders).set({ shopifyContactSnapshot: null }).where(eq(orders.id, o.id));
    await upsertOrder(ctx, mapOrder(shopifyOrder(7104, 10)), "live");
    expect(await openChanged(o.id)).toEqual([]);
    // Тепер знімок є (з цього читання).
    expect((await orderRow(7104)).shopifyContactSnapshot).toMatchObject({ "shipping.phone": LOCAL_PHONE });

    // Без знімка й без змін застосунку в полі — різниця вважається зміною Shopify (як раніше).
    await h.db.update(orders).set({ shopifyContactSnapshot: null }).where(eq(orders.id, o.id));
    await upsertOrder(ctx, mapOrder(shopifyOrder(7104, 20, {}, { city: "Hamburg" })), "live");
    const [reported] = await openChanged(o.id);
    expect(reported?.params).toEqual({ fields: "shipping.city" });
  });
});

describe("migration 0011 on a database migrated to 0010 with rows", () => {
  it("adds orders.shopify_contact_snapshot as NULL; existing rows are unchanged", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ot-mig11-"));
    fs.mkdirSync(path.join(dir, "meta"));
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as { entries: Array<{ idx: number; tag: string }> };
    const target = journal.entries.find((e) => e.tag.includes("shopify_contact_snapshot"));
    expect(target).toBeDefined();
    const previous = { ...journal, entries: journal.entries.filter((e) => e.idx < target!.idx) };
    fs.writeFileSync(path.join(dir, "meta/_journal.json"), JSON.stringify(previous));
    for (const e of previous.entries) fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${e.tag}.sql`), path.join(dir, `${e.tag}.sql`));
    const raw = await openRaw();
    try {
      await raw.migrate(dir);
      await raw.db.execute(sql`insert into orders (source, shopify_order_id, order_number, currency, subtotal, total, status, ship_phone, fulfillment_status)
        values ('shopify', 'gid://shopify/Order/11', '#M-11', 'EUR', '1.00', '1.00', 'handed_to_carrier', ${FIXED_PHONE}, 'unfulfilled')`);
      await raw.db.execute(sql`insert into order_changes (order_id, field, old_value, new_value, source, actor_id)
        select id, 'shipping.phone', ${LOCAL_PHONE}, ${FIXED_PHONE}, 'auto_fix', 'system' from orders where order_number = '#M-11'`);
      await raw.migrate(MIGRATIONS_FOLDER);
      const [o] = await raw.db.select().from(orders);
      expect(o).toMatchObject({ orderNumber: "#M-11", status: "handed_to_carrier", shipPhone: FIXED_PHONE, shopifyContactSnapshot: null });
      const changes = await raw.db.select({ field: orderChanges.field, source: orderChanges.source }).from(orderChanges);
      expect(changes).toEqual([{ field: "shipping.phone", source: "auto_fix" }]);
    } finally {
      await raw.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** База без міграцій (PGlite у пам'яті або тимчасова база PostgreSQL з TEST_DATABASE_URL). */
async function openRaw(): Promise<{ db: Db; migrate: (folder: string) => Promise<void>; close: () => Promise<void> }> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const client = new PGlite();
    const db = drizzle(client) as unknown as Db;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { db, migrate: (folder) => migrate(db as any, { migrationsFolder: folder }), close: () => client.close() };
  }
  const { Client, Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const { migrate } = await import("drizzle-orm/node-postgres/migrator");
  const name = `ot_mig11_${process.pid}_${Date.now()}`;
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  await c.query(`create database ${name}`);
  await c.end();
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 2 });
  const db = drizzle(pool) as unknown as Db;
  return {
    db,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    migrate: (folder) => migrate(db as any, { migrationsFolder: folder }),
    close: async () => {
      await pool.end();
      const d = new Client({ connectionString: adminUrl });
      await d.connect();
      await d.query(`drop database if exists ${name}`);
      await d.end();
    },
  };
}

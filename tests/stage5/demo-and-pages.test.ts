import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, count, eq } from "drizzle-orm";
import {
  inventoryMovements,
  kitTemplateLines,
  kitTemplates,
  packagingMaterials,
  productionBatches,
  stockAlerts,
  stockItems,
  warehouses,
} from "~/db/schema";
import { resetDemoData, seedDemoData } from "~/db/seed/seed.server";
import { makeActor, SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { getBalances } from "~/modules/inventory/ledger.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/** Демо-дані складу та сторінки-заготовки розділів етапу 5 (контекст запиту підмінено). */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

async function countOf(table: typeof packagingMaterials | typeof kitTemplates | typeof productionBatches | typeof warehouses | typeof inventoryMovements) {
  const [row] = await env.handle.db.select({ c: count() }).from(table);
  return Number(row?.c ?? 0);
}

describe("demo warehouse data", () => {
  it("has materials (boxes with dimensions), kit templates and a batch in production", async () => {
    const materials = await env.handle.db.select().from(packagingMaterials);
    const boxes = materials.filter((x) => x.kind === "box");
    expect(boxes.length).toBeGreaterThanOrEqual(2);
    for (const b of boxes) expect(b.innerLengthMm && b.innerWidthMm && b.innerHeightMm && b.maxWeightGrams).toBeTruthy();
    expect(materials.map((x) => x.kind)).toEqual(expect.arrayContaining(["sticker", "instruction", "card", "bolt"]));
    expect(await countOf(kitTemplates)).toBeGreaterThanOrEqual(1);
    expect((await env.handle.db.select().from(kitTemplateLines)).length).toBeGreaterThan(0);
    const [batch] = await env.handle.db.select().from(productionBatches);
    expect(batch).toMatchObject({ status: "in_production" });
    expect(batch!.number).toMatch(/^PB-\d{4}-0001$/);
    const inProduction = (await getBalances(env.handle.db, {}, { limit: 500 })).rows.filter((r) => r.inProduction > 0);
    expect(inProduction.map((r) => [r.sku, r.inProduction]).sort()).toEqual([
      ["OT-FK-S", 30],
      ["OT-PH-WHT", 50],
    ]);
    const materialBalances = await getBalances(env.handle.db, { kind: "material" });
    expect(materialBalances.rows.find((r) => r.sku === "box_m")).toMatchObject({ onHand: 25, available: 25, unit: "pcs" });
    // Мало коробок L і болтів → попередження.
    const lowBoxL = await env.handle.db
      .select({ kind: stockAlerts.kind })
      .from(stockAlerts)
      .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
      .innerJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId))
      .where(and(eq(packagingMaterials.code, "box_l"), eq(stockAlerts.status, "open")));
    expect(lowBoxL.map((r) => r.kind)).toEqual(["low_stock"]);
  });

  it("seeding again is idempotent and there is exactly one default warehouse", async () => {
    const before = [await countOf(packagingMaterials), await countOf(kitTemplates), await countOf(productionBatches), await countOf(inventoryMovements)];
    await seedDemoData(env.ctx(SYSTEM_ACTOR));
    expect([await countOf(packagingMaterials), await countOf(kitTemplates), await countOf(productionBatches), await countOf(inventoryMovements)]).toEqual(before);
    const defaults = await env.handle.db.select().from(warehouses).where(eq(warehouses.isDefault, true));
    expect(defaults).toHaveLength(1);
    expect(defaults[0]!.name).toBe("Основний склад");
    expect(await countOf(warehouses)).toBe(1);
  });
});

describe("stage-5 section pages: access", () => {
  const load = async (path: "warehouse" | "production" | "picking") => {
    const page = await import(`~/pages/${path}.tsx`);
    return page.loader({ request: new Request(`http://localhost/demo/${path}`), params: {}, context: {} } as never);
  };

  it("staff can open warehouse, production and picking", async () => {
    setContext(STAFF);
    expect(await load("warehouse")).toMatchObject({ warehouseName: "Основний склад", initializedAt: expect.any(String) });
    expect(await load("production")).toMatchObject({ activeBatches: 1, canManage: false });
    expect((await load("picking")).queued).toBeGreaterThanOrEqual(1);
  });

  it("an actor without the permissions gets 403", async () => {
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view", "packing.perform"] } }));
    for (const p of ["warehouse", "production", "picking"] as const) {
      await expect(load(p)).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("demo reset", () => {
  it("restores warehouse data from scratch", async () => {
    await resetDemoData(env.ctx(OWNER));
    expect(await countOf(warehouses)).toBe(1);
    expect(await countOf(packagingMaterials)).toBeGreaterThan(0);
    expect(await countOf(productionBatches)).toBe(1);
    const [w] = await env.handle.db.select().from(warehouses);
    expect(w!.inventoryInitializedAt).toBeInstanceOf(Date);
  });
});

describe("manual parcel correction is used by waybill creation", () => {
  it("overrides weight and dimensions only when set", async () => {
    const { loadLineItems, loadOrderRow } = await import("~/modules/orders/repository.server");
    const { loadSettings } = await import("~/modules/settings/settings.server");
    const { buildShipmentRequest } = await import("~/modules/shipments/waybill.server");
    const orderId = await env.orderId("#1001");
    const order = await loadOrderRow(env.handle.db, orderId);
    const items = await loadLineItems(env.handle.db, orderId);
    const settings = (await loadSettings(env.handle.db)).values;
    const plain = buildShipmentRequest(order, items, settings, "OT-T-1", new Date()).parcels[0]!;
    const pkg = settings.packaging.packages.find((p) => p.code === settings.packaging.defaultPackageCode)!;
    expect(plain).toMatchObject({ lengthCm: pkg.lengthCm, widthCm: pkg.widthCm, heightCm: pkg.heightCm });
    const corrected = buildShipmentRequest(
      { ...order, parcelWeightGrams: 1234, parcelLengthMm: 301, parcelWidthMm: 200, parcelHeightMm: 95 },
      items,
      settings,
      "OT-T-2",
      new Date(),
    ).parcels[0]!;
    expect(corrected).toMatchObject({ lengthCm: 31, widthCm: 20, heightCm: 10, actualWeightGrams: 1234 });
    expect(corrected.chargeableWeightGrams).toBe(Math.max(1234, corrected.volumetricWeightGrams ?? 0));
    const weightOnly = buildShipmentRequest({ ...order, parcelWeightGrams: 250 }, items, settings, "OT-T-3", new Date()).parcels[0]!;
    expect(weightOnly).toMatchObject({ lengthCm: pkg.lengthCm, actualWeightGrams: 250 });
    // Вага, менша за вагу самих товарів (210 г), — застаріла або описка: не надсилається (production-3).
    expect(buildShipmentRequest({ ...order, parcelWeightGrams: 50 }, items, settings, "OT-T-4", new Date()).parcels[0]!.actualWeightGrams).toBe(plain.actualWeightGrams);
  });
});

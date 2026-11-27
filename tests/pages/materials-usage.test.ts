import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inventoryMovements } from "~/db/schema";
import { type Actor } from "~/domain/permissions";
import { DICTIONARIES, makeT } from "~/i18n";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { MATERIAL_CONSUMPTION_DAYS, getMaterial, listMaterials, loadMaterialConsumption, materialDaysLeft } from "~/modules/packaging/materials.server";
import { businessDate, businessDayStart } from "~/modules/warehouse/dates";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { apply, insertMaterial, insertProduct, stockItemFor } from "../stage5/helpers";
import { esc, renderPage } from "./insights-render";

/**
 * S5-PKG (R6): витрата пакувальних матеріалів — «Витрачено за 30 днів» (Σ material_consume) і «на скільки днів
 * вистачить» у переліку матеріалів і на картці матеріалу; картка матеріалу не показує нерелевантних
 * «Доступно для продажу / Зарезервовано / У виробництві». Вигадані матеріали (MU-*):
 *   MU-USED: +100, витрати −12 (сьогодні), −18 (−29 днів, ще в періоді), −50 (−30 днів, поза періодом) → 20 на складі,
 *            витрачено 30 за 30 днів → вистачить на 20 днів;
 *   MU-IDLE: +40, без витрат → прогнозу немає;
 *   MU-GONE: +5, витрата −5 сьогодні → залишку немає.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let materialsPage: typeof import("~/pages/materials");
let itemPage: typeof import("~/pages/warehouse-item");
let today: string;
const mat = { used: { materialId: "", stockItemId: "" }, idle: { materialId: "", stockItemId: "" }, gone: { materialId: "", stockItemId: "" } };
let productStockItem = "";

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale };
}

/** Полудень за Києвом у день «сьогодні + offset». */
const at = (offset: number) => {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return new Date(businessDayStart(d.toISOString().slice(0, 10)).getTime() + 12 * 3600 * 1000);
};

async function consume(stockItemId: string, key: string, qty: number, offset = 0) {
  const r = await apply(env.handle.db, { stockItemId, type: "material_consume", idempotencyKey: key, onHandDelta: -qty });
  if (offset !== 0) {
    await env.handle.db.update(inventoryMovements).set({ createdAt: at(offset) }).where(eq(inventoryMovements.idempotencyKey, key));
  }
  return r;
}

beforeAll(async () => {
  env = await createTestEnv();
  today = businessDate(new Date());
  materialsPage = await import("~/pages/materials");
  itemPage = await import("~/pages/warehouse-item");
  const db = env.handle.db;
  mat.used = await insertMaterial(db, "MU-USED");
  mat.idle = await insertMaterial(db, "MU-IDLE");
  mat.gone = await insertMaterial(db, "MU-GONE");
  await apply(db, { stockItemId: mat.used.stockItemId, type: "receipt_manual", idempotencyKey: "mu-used-in", onHandDelta: 100 });
  await apply(db, { stockItemId: mat.idle.stockItemId, type: "receipt_manual", idempotencyKey: "mu-idle-in", onHandDelta: 40 });
  await apply(db, { stockItemId: mat.gone.stockItemId, type: "receipt_manual", idempotencyKey: "mu-gone-in", onHandDelta: 5 });
  await consume(mat.used.stockItemId, "mu-used-c1", 12);
  await consume(mat.used.stockItemId, "mu-used-c2", 18, -(MATERIAL_CONSUMPTION_DAYS - 1));
  await consume(mat.used.stockItemId, "mu-used-c3", 50, -MATERIAL_CONSUMPTION_DAYS);
  await consume(mat.gone.stockItemId, "mu-gone-c1", 5);
  const p = await insertProduct(db, "Usage Product", [{ sku: "MU-PROD", color: "Red" }]);
  productStockItem = await stockItemFor(db, p.variantIds[0]!);
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => setContext());

const loadList = (search = "") =>
  materialsPage.loader({ request: new Request(`http://localhost/demo/warehouse/materials${search}`), params: {}, context: {} } as never);
const loadItem = (id: string) =>
  itemPage.loader({ request: new Request(`http://localhost/demo/warehouse/items/${id}`), params: { stockItemId: id }, context: {} } as never);
const itemRoute = () => ({ path: "warehouse/items/:stockItemId", loader: itemPage.loader, action: itemPage.action, Component: itemPage.default });

describe("materials: usage over 30 days and days left (S5-PKG)", () => {
  it("pure: days left = on hand / average daily usage (whole days); no usage → null; nothing left → 0", () => {
    expect(materialDaysLeft(20, 30)).toBe(20);
    expect(materialDaysLeft(7, 30)).toBe(7);
    expect(materialDaysLeft(10, 7)).toBe(42); // 10 / (7/30) = 42.8 → 42
    expect(materialDaysLeft(40, 0)).toBeNull();
    expect(materialDaysLeft(0, 5)).toBe(0);
    expect(materialDaysLeft(-3, 5)).toBe(0);
  });

  it("sums material_consume movements of the last 30 Kyiv days only (other movement types and older usage excluded)", async () => {
    const w = await getDefaultWarehouse(env.handle.db);
    const usage = await loadMaterialConsumption(env.handle.db, [mat.used.stockItemId, mat.idle.stockItemId, mat.gone.stockItemId], {
      warehouseId: w.id,
    });
    expect(usage.get(mat.used.stockItemId)).toBe(30);
    expect(usage.has(mat.idle.stockItemId)).toBe(false);
    expect(usage.get(mat.gone.stockItemId)).toBe(5);
    // Інший «сьогодні»: через 40 днів витрат за 30 днів уже немає.
    const later = await loadMaterialConsumption(env.handle.db, [mat.used.stockItemId], { warehouseId: w.id, now: at(40) });
    expect(later.size).toBe(0);
  });

  it("listMaterials / getMaterial return consumedRecent and daysLeft", async () => {
    const { rows } = await listMaterials(env.handle.db, { search: "MU-" });
    const by = Object.fromEntries(rows.map((r) => [r.code, r]));
    expect(by["MU-USED"]).toMatchObject({ onHand: 20, consumedRecent: 30, daysLeft: 20 });
    expect(by["MU-IDLE"]).toMatchObject({ onHand: 40, consumedRecent: 0, daysLeft: null });
    expect(by["MU-GONE"]).toMatchObject({ onHand: 0, consumedRecent: 5, daysLeft: 0 });
    expect(await getMaterial(env.handle.db, mat.used.materialId)).toMatchObject({ consumedRecent: 30, daysLeft: 20 });
  });

  it("the materials page shows the usage column for owner and staff (uk + en)", async () => {
    for (const actor of [OWNER, STAFF]) {
      for (const locale of ["uk", "en"] as const) {
        setContext(actor, locale);
        const data = await loadList("?q=MU-");
        expect(data.rows.find((r) => r.code === "MU-USED")).toMatchObject({ consumedRecent: 30, daysLeft: 20 });
        const t = makeT(locale);
        const route = { path: "warehouse/materials", loader: materialsPage.loader, action: materialsPage.action, Component: materialsPage.default };
        const html = await renderPage(route as never, "/demo/warehouse/materials?q=MU-", actor, locale);
        expect(html, `${actor.role} ${locale}`).toContain(esc(t("warehouseInsights.material.consumed", { days: 30 })));
        expect(html).toContain(esc(t("warehouseInsights.material.daysLeftValue", { days: "20" })));
        expect(html).toContain(esc(t("warehouseInsights.material.noUsage")));
        expect(html).toContain(esc(t("warehouseInsights.material.runOut")));
      }
    }
    expect(makeT("uk")("warehouseInsights.material.consumed", { days: 30 })).toBe("Витрачено за 30 днів");
    expect(makeT("en")("warehouseInsights.material.daysLeftValue", { days: 1 })).toBe("Enough for 1 day");
    expect(makeT("uk")("warehouseInsights.material.daysLeftValue", { days: 21 })).toBe("Вистачить на 21 день");
  });

  it("material card: on hand, defective, usage and days left — no available / reserved / in production", async () => {
    for (const actor of [OWNER, STAFF]) {
      setContext(actor);
      const data = await loadItem(mat.used.stockItemId);
      expect(data.materialUsage).toEqual({ days: 30, consumed: 30, daysLeft: 20 });
      expect((await loadItem(mat.idle.stockItemId)).materialUsage).toEqual({ days: 30, consumed: 0, daysLeft: null });
      const html = await renderPage(itemRoute() as never, `/demo/warehouse/items/${mat.used.stockItemId}`, actor);
      const uk = DICTIONARIES.uk;
      expect(html).toContain(esc(uk["inventory.bucket.onHand"]!));
      expect(html).toContain(esc(makeT("uk")("warehouseInsights.material.consumed", { days: 30 })));
      expect(html).toContain(esc(uk["warehouseInsights.material.daysLeft"]!));
      for (const hidden of ["inventory.bucket.available", "inventory.bucket.reserved", "inventory.bucket.inProduction"]) {
        expect(html, hidden).not.toContain(`>${esc(uk[hidden]!)}<`);
      }
      const idle = await renderPage(itemRoute() as never, `/demo/warehouse/items/${mat.idle.stockItemId}`, actor);
      expect(idle).toContain(esc(uk["warehouseInsights.material.noForecast"]!));
    }
  });

  it("product card keeps all buckets and has no material usage", async () => {
    const data = await loadItem(productStockItem);
    expect(data.materialUsage).toBeNull();
    const html = await renderPage(itemRoute() as never, `/demo/warehouse/items/${productStockItem}`, OWNER);
    for (const shown of ["inventory.bucket.available", "inventory.bucket.reserved", "inventory.bucket.inProduction"]) {
      expect(html, shown).toContain(`>${esc(DICTIONARIES.uk[shown]!)}<`);
    }
    expect(html).not.toContain(esc(DICTIONARIES.uk["warehouseInsights.material.daysLeft"]!));
  });
});

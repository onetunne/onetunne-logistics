/**
 * Аналітика складу на БД (PGlite або TEST_DATABASE_URL): продажі за період (оплачені, не скасовані, currentQuantity),
 * швидкість 30/90 днів, днів запасу, ризики, рекомендації (з урахуванням «у виробництві» й «заплановано»), фільтри,
 * собівартість лише з finance.view; сторінка /warehouse/analytics; CSV-експорт (вміст, права, журнал, без ПД).
 *
 * Тестовий товар «Analytics Test» (вигадані дані) з чотирма варіантами й замовленнями в точно визначені дні (полудень
 * за Києвом, щоб межі днів і переходи часу не впливали):
 *   A (Red/M1):  день −2: 3 + 2, день −10: 5, день −45: 6; скасоване (−1: 100) і неоплачене (−1: 50) не рахуються;
 *                залишок 20 (два надходження з виробництва: 10 по 12.50, пізніше 10 по 14.00 UAH)
 *   B (Blue/M1): день −2: 1, день −20: 4 (currentQuantity 2), день −70: 9; залишок 2, у виробництві 10
 *   C (Red/M2):  без продажів, без залишку
 *   D (Blue/M2): день −5: 9; залишку немає; заплановано 5 у партії, ще не запущеній
 */
import { and, eq, like } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { auditLog, inventoryMovements, orderLineItems, orders, productionBatchLines, productionBatches } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { businessDate, businessDayStart } from "~/modules/warehouse/dates";
import { addDays, parseProductionPrefill, resolvePeriod } from "~/modules/warehouse-analytics/calc";
import { exportResponseOutcome } from "~/modules/warehouse-analytics/export-contract";
import { exportMovementsCsv, exportSalesCsv, exportStockCsv } from "~/modules/warehouse-analytics/export.server";
import { WAREHOUSE_SECTION_LINKS } from "~/modules/warehouse/constants";
import {
  computeWarehouseAnalytics,
  loadPeriodSales,
  loadVelocityUnits,
  loadWarehouseAnalytics,
} from "~/modules/warehouse-analytics/queries.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { apply, insertProduct, stockItemFor } from "./helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let today: string;
let page: typeof import("~/pages/warehouse-analytics");
let exportRoute: typeof import("~/pages/warehouse-export");
let productionForm: typeof import("~/pages/production-batch");
let stockPage: typeof import("~/pages/warehouse");
let movementsPage: typeof import("~/pages/warehouse-movements");
const ids = { product: "", a: "", b: "", c: "", d: "", stockA: "", stockB: "" };
const NO_VIEW = makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["warehouse.view"] } });
const PII = ["Hoffmann", "Musterstraße", "Martin", "Exemple", "+49", "+33", "Lyon", "Berlin", "@", "Keller", "Probegasse"];

async function setWarehouse(changes: Record<string, unknown>) {
  const r = await updateSetting(env.handle.db, OWNER, "warehouse", { ...(await getSetting(env.handle.db, "warehouse")), ...changes });
  expect(r.ok).toBe(true);
}

/** Полудень за Києвом у день «сьогодні + offset». */
const at = (offset: number) => new Date(businessDayStart(addDays(today, offset)).getTime() + 12 * 3600 * 1000);

let orderSeq = 0;
async function order(
  offset: number,
  lines: Array<{ variantId: string; quantity: number; currentQuantity?: number | null }>,
  extra: Partial<typeof orders.$inferInsert> = {},
) {
  orderSeq += 1;
  const [o] = await env.handle.db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: `#AT-${orderSeq}`,
      status: "delivered",
      financialStatus: "paid",
      currency: "EUR",
      subtotal: "10.00",
      total: "10.00",
      placedAt: at(offset),
      ...extra,
    })
    .returning({ id: orders.id });
  await env.handle.db.insert(orderLineItems).values(
    lines.map((l, i) => ({
      orderId: o!.id,
      variantId: l.variantId,
      title: "Analytics Test",
      quantity: l.quantity,
      currentQuantity: l.currentQuantity ?? null,
      unitPrice: "10.00",
      currency: "EUR",
      position: i,
    })),
  );
  return o!.id;
}

beforeAll(async () => {
  env = await createTestEnv();
  today = businessDate(new Date());
  page = await import("~/pages/warehouse-analytics");
  exportRoute = await import("~/pages/warehouse-export");
  productionForm = await import("~/pages/production-batch");
  stockPage = await import("~/pages/warehouse");
  movementsPage = await import("~/pages/warehouse-movements");
  const db = env.handle.db;
  await setWarehouse({ lowStockThreshold: 5, productionLeadDays: 30, targetCoverDays: 60, batchRounding: 10 });
  const p = await insertProduct(db, "Analytics Test", [
    { sku: "AT-A", color: "Red", model: "M1" },
    { sku: "AT-B", color: "Blue", model: "M1" },
    { sku: "AT-C", color: "Red", model: "M2" },
    { sku: "AT-D", color: "Blue", model: "M2" },
  ]);
  ids.product = p.productId;
  [ids.a, ids.b, ids.c, ids.d] = p.variantIds as [string, string, string, string];
  ids.stockA = await stockItemFor(db, ids.a);
  ids.stockB = await stockItemFor(db, ids.b);
  await stockItemFor(db, ids.c);
  await stockItemFor(db, ids.d);

  await order(-2, [{ variantId: ids.a, quantity: 3 }]);
  await order(-2, [
    { variantId: ids.a, quantity: 2 },
    { variantId: ids.b, quantity: 1 },
  ]);
  await order(-10, [{ variantId: ids.a, quantity: 5 }]);
  await order(-20, [{ variantId: ids.b, quantity: 4, currentQuantity: 2 }]);
  await order(-45, [{ variantId: ids.a, quantity: 6 }]);
  await order(-70, [{ variantId: ids.b, quantity: 9 }]);
  await order(-5, [{ variantId: ids.d, quantity: 9 }], { status: "awaiting_review" });
  await order(-1, [{ variantId: ids.a, quantity: 100 }], { status: "cancelled", cancelledAt: at(-1) });
  await order(-1, [{ variantId: ids.a, quantity: 50 }], { financialStatus: "pending", status: "paid" });
  await order(-1, [{ variantId: ids.a, quantity: 40 }], { status: "awaiting_review", cancelledAt: at(-1) }); // скасовано в Shopify

  // Залишки: A — два надходження з виробництва з собівартістю (пізніше — 14.00), B — 2 + у виробництві 10.
  await apply(db, { stockItemId: ids.stockA, type: "receipt_production", idempotencyKey: "at:receipt:1", onHandDelta: 10, unitCost: "12.50", costCurrency: "UAH" });
  await db
    .update(inventoryMovements)
    .set({ createdAt: new Date(Date.now() - 86_400_000) })
    .where(eq(inventoryMovements.idempotencyKey, "at:receipt:1"));
  await apply(db, { stockItemId: ids.stockA, type: "receipt_production", idempotencyKey: "at:receipt:2", onHandDelta: 10, unitCost: "14.00", costCurrency: "UAH" });
  await apply(db, { stockItemId: ids.stockB, type: "receipt_manual", idempotencyKey: "at:receipt:3", onHandDelta: 2, note: "call +49 170 1234567" });
  await apply(db, { stockItemId: ids.stockB, type: "production_start", idempotencyKey: "at:start:1", inProductionDelta: 10 });
  const [planned] = await db
    .insert(productionBatches)
    .values({ number: "PB-2099-9001", title: "Analytics planned", status: "planned", createdBy: "test-owner" })
    .returning({ id: productionBatches.id });
  await db.insert(productionBatchLines).values({ batchId: planned!.id, variantId: ids.d, quantityOrdered: 5 });
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

const BASE = "http://localhost/demo";
const loadPage = (search = "") => page.loader({ request: new Request(`${BASE}/warehouse/analytics${search}`), params: {}, context: {} } as never);
const loadExport = (search: string) =>
  exportRoute.loader({ request: new Request(`${BASE}/warehouse/export${search}`), params: {}, context: {} } as never) as Promise<Response>;

const onlyTest = () => ({ productIds: [ids.product] });

function parseCsv(content: string, sep = ";"): Array<Record<string, string>> {
  expect(content.charCodeAt(0)).toBe(0xfeff);
  const [header, ...lines] = content.slice(1).trimEnd().split("\r\n");
  const cols = header!.split(sep);
  return lines.map((l) => Object.fromEntries(l.split(sep).map((v, i) => [cols[i]!, v])));
}

// ---------------------------------------------------------------------------

describe("sales queries", () => {
  it("count paid, not cancelled orders with currentQuantity for the period and the previous one", async () => {
    const p7 = resolvePeriod({ key: "7", today });
    const s7 = await loadPeriodSales(env.handle.db, p7, onlyTest());
    expect(s7.byVariant.get(ids.a)).toEqual({ variantId: ids.a, units: 5, previousUnits: 5, orders: 2 });
    expect(s7.byVariant.get(ids.b)).toMatchObject({ units: 1, previousUnits: 0, orders: 1 });
    expect(s7.byVariant.get(ids.d)).toMatchObject({ units: 9, orders: 1 });
    expect(s7.totals).toMatchObject({ units: 15, previousUnits: 5, orders: 3, previousOrders: 1, unmatchedUnits: 0 });

    const p30 = resolvePeriod({ key: "30", today });
    const s30 = await loadPeriodSales(env.handle.db, p30, onlyTest());
    expect(s30.byVariant.get(ids.a)).toMatchObject({ units: 10, previousUnits: 6 });
    expect(s30.byVariant.get(ids.b)).toMatchObject({ units: 3, previousUnits: 0 }); // 1 + currentQuantity 2
    expect(s30.totals).toMatchObject({ units: 22, orders: 5 });
    expect(s30.byVariant.has(ids.c)).toBe(false);

    const custom = resolvePeriod({ key: "custom", from: addDays(today, -10), to: addDays(today, -10), today });
    expect((await loadPeriodSales(env.handle.db, custom, onlyTest())).totals).toMatchObject({ units: 5, orders: 1 });
  });

  it("velocity units: last 30 and 90 days", async () => {
    const u = await loadVelocityUnits(env.handle.db, today, onlyTest());
    expect(u.get(ids.a)).toEqual({ units30: 10, units90: 16 });
    expect(u.get(ids.b)).toEqual({ units30: 3, units90: 12 });
    expect(u.get(ids.d)).toEqual({ units30: 9, units90: 9 });
    expect(u.has(ids.c)).toBe(false);
    const red = await loadVelocityUnits(env.handle.db, today, { ...onlyTest(), colors: ["Red"] });
    expect([...red.keys()]).toEqual([ids.a]);
  });
});

describe("analytics overview", () => {
  it("forecasts cover, stock-out, risk and recommendations (planned and in-production stock subtracted)", async () => {
    const data = await computeWarehouseAnalytics(env.handle.db, { today, period: resolvePeriod({ key: "30", today }), filters: onlyTest() });
    const byId = new Map(data.variants.map((v) => [v.variantId, v]));
    const a = byId.get(ids.a)!;
    expect(a).toMatchObject({ units: 10, units30: 10, units90: 16, onHand: 20, available: 20, forecast: true, coverDays: 60, risk: "none" });
    expect(a.stockOutDate).toBe(addDays(today, 60));
    expect(a.recommendation).toMatchObject({ horizonDays: 90, demand: 26, supply: 20, shortfall: 6, quantity: 10 });
    expect(a.trend).toMatchObject({ direction: "up", previous: 6 });
    const b = byId.get(ids.b)!;
    expect(b).toMatchObject({ available: 2, inProduction: 10, coverDays: 20, risk: "critical" });
    expect(b.recommendation).toMatchObject({ demand: 10, supply: 12, quantity: 0 });
    const c = byId.get(ids.c)!;
    expect(c).toMatchObject({ units: 0, velocity: 0, coverDays: 0, risk: "none" });
    expect(c.recommendation?.quantity).toBe(0);
    const d = byId.get(ids.d)!;
    expect(d).toMatchObject({ available: 0, planned: 5, risk: "out", stockOutDate: today });
    expect(d.recommendation).toMatchObject({ demand: 21, supply: 5, shortfall: 16, quantity: 20 });

    expect(data.recommendations.map((v) => v.sku)).toEqual(["AT-D", "AT-A"]); // раніше закінчиться — вище
    expect(data.atRisk.map((v) => [v.sku, v.risk])).toEqual([
      ["AT-D", "out"],
      ["AT-B", "critical"],
    ]);
    expect(data.kpi).toMatchObject({
      unitsSold: 22,
      orders: 5,
      variantsSold: 3,
      availableUnits: 22,
      inProductionUnits: 10,
      plannedUnits: 5,
      forecastVariants: 4,
      notForecastVariants: 0,
      atRisk: 2,
      outOfStock: 1,
      recommendations: 2,
      recommendedUnits: 30,
    });
    expect(data.topColors.map((g) => [g.label, g.units])).toEqual([
      ["Blue", 12],
      ["Red", 10],
    ]);
    expect(data.topModels.map((g) => [g.label, g.units])).toEqual([
      ["M1", 13],
      ["M2", 9],
    ]);
    expect(data.topProducts).toHaveLength(1);
    expect(data.topProducts[0]).toMatchObject({ label: "Analytics Test", units: 22, sharePercent: 100 });
    // Без includeCosts — жодної собівартості.
    expect(data.inventoryValue).toBeNull();
    expect(data.variants.every((v) => v.cost === null)).toBe(true);
  });

  it("filters by model and color narrow sales, risks and recommendations", async () => {
    const data = await computeWarehouseAnalytics(env.handle.db, {
      today,
      period: resolvePeriod({ key: "30", today }),
      filters: { ...onlyTest(), models: ["M1"], colors: ["Red"] },
    });
    expect(data.variants.map((v) => v.sku)).toEqual(["AT-A"]);
    expect(data.kpi.unitsSold).toBe(10);
    expect(data.recommendations.map((v) => v.sku)).toEqual(["AT-A"]);
  });

  it("settings drive the recommendation (lead time, cover, rounding)", async () => {
    await setWarehouse({ productionLeadDays: 10, targetCoverDays: 20, batchRounding: 1 });
    try {
      const data = await computeWarehouseAnalytics(env.handle.db, { today, period: resolvePeriod({ today }), filters: onlyTest() });
      const a = data.variants.find((v) => v.variantId === ids.a)!;
      expect(a.recommendation).toMatchObject({ horizonDays: 30, demand: 9, quantity: 0 }); // ⌈76·30/270⌉ = 9 < 20
      const d = data.variants.find((v) => v.variantId === ids.d)!;
      expect(d.recommendation).toMatchObject({ demand: 7, supply: 5, quantity: 2 });
      expect(data.variants.find((v) => v.variantId === ids.b)!.risk).toBe("none"); // 20 днів запасу ≥ 10 днів виробництва
    } finally {
      await setWarehouse({ productionLeadDays: 30, targetCoverDays: 60, batchRounding: 10 });
    }
  });

  it("unit costs (latest production receipt) and inventory value only with finance.view", async () => {
    const owner = await loadWarehouseAnalytics(env.ctx(OWNER), { filters: onlyTest() });
    expect(owner.includeCosts).toBe(true);
    expect(owner.variants.find((v) => v.variantId === ids.a)!.cost).toEqual({ unitCost: "14.00", currency: "UAH" });
    expect(owner.variants.find((v) => v.variantId === ids.b)!.cost).toBeNull();
    expect(owner.inventoryValue).toEqual({
      totals: [{ currency: "UAH", amount: "280.00" }],
      itemsValued: 1,
      unitsValued: 20,
      itemsWithoutCost: 1,
      unitsWithoutCost: 2,
    });
    const staff = await loadWarehouseAnalytics(env.ctx(STAFF), { filters: onlyTest() });
    expect(staff.includeCosts).toBe(false);
    expect(staff.inventoryValue).toBeNull();
    expect(JSON.stringify(staff)).not.toContain("14.00");
    await expect(loadWarehouseAnalytics(env.ctx(NO_VIEW))).rejects.toMatchObject({ permission: "warehouse.view" });
  });

  it("works on the whole demo shop: forecasts only opened items, no customer data", async () => {
    const data = await loadWarehouseAnalytics(env.ctx(STAFF));
    expect(data.kpi.unitsSold).toBeGreaterThan(22);
    expect(data.variants.length).toBeGreaterThanOrEqual(13);
    for (const v of data.variants) {
      if (!v.forecast) {
        expect(v.recommendation).toBeNull();
        expect(v.risk).toBe("none");
      }
    }
    const json = JSON.stringify(data);
    for (const s of PII) expect(json, s).not.toContain(s);
  });
});

// ---------------------------------------------------------------------------

describe("analytics page", () => {
  it("requires warehouse.view", async () => {
    setContext(NO_VIEW);
    await expect(loadPage()).rejects.toMatchObject({ status: 403 });
  });

  it("owner: KPIs, tables, inventory value and a prefilled «create batch» link", async () => {
    const data = await loadPage(`?product=${ids.product}`);
    expect(data.canSeeCosts).toBe(true);
    expect(data.canManageProduction).toBe(true);
    expect(data.kpi.unitsSold).toBe(22);
    expect(data.inventoryValue?.totals).toEqual([{ currency: "UAH", amount: "280.00" }]);
    expect(data.recommendations.map((r) => [r.sku, r.recommendation?.quantity])).toEqual([
      ["AT-D", 20],
      ["AT-A", 10],
    ]);
    expect(data.prefill).toMatchObject({ products: 1, variants: 2, units: 30, truncated: false });
    const params = new URLSearchParams(data.prefill!.search);
    expect(params.getAll("product")).toEqual([ids.product]);
    expect(params.get(`qty.${ids.d}`)).toBe("20");
    expect(params.get(`qty.${ids.a}`)).toBe("10");
    expect(data.variants.find((v) => v.sku === "AT-A")!.cost).toEqual({ unitCost: "14.00", currency: "UAH" });
  });

  it("staff: no costs, no inventory value, no «create batch» (production.manage is the owner's)", async () => {
    setContext(STAFF);
    const data = await loadPage(`?product=${ids.product}&period=7`);
    expect(data.canSeeCosts).toBe(false);
    expect(data.inventoryValue).toBeNull();
    expect(data.prefill).toBeNull();
    expect(data.period).toMatchObject({ key: "7", days: 7 });
    expect(data.kpi).toMatchObject({ unitsSold: 15, previousUnits: 5 });
    const json = JSON.stringify(data);
    expect(json).not.toContain("14.00");
    expect(json).not.toContain("12.50");
  });

  it("invalid custom periods fall back to 30 days with a flag", async () => {
    const data = await loadPage("?period=custom&from=2026-11-10&to=2026-11-01");
    expect(data.period).toMatchObject({ key: "30", invalid: true });
  });

  it("renders on the server (uk) with KPIs, recommendations and the CSV export card", async () => {
    const html = await render(`/demo/warehouse/analytics?product=${ids.product}`);
    expect(html).toContain("Аналітика складу");
    // Кількість — позицій (варіантів) із рекомендацією, а не партій: усі вони йдуть в ОДНУ партію.
    expect(html).toContain("Рекомендації виробництва (2 поз.)");
    expect(html).toContain("Позицій до виробництва");
    expect(html).not.toContain("Рекомендовано партій");
    expect(html).not.toContain("Рекомендовані партії");
    // Форма партії поки лише вибирає товари — кнопка не обіцяє кількостей, примітка каже ввести їх у формі.
    expect(html).toContain("Створити партію (товарів: 1)");
    expect(html).not.toMatch(/Створити партію \([^)]*шт\./);
    expect(html).toContain(esc(uk("warehouseAnalytics.createBatchNote")));
    expect(html).toContain("/demo/production/new?product=");
    expect(html).toContain("Експорт CSV");
    expect(html).toContain("Вартість запасу");
    for (const s of PII) expect(html, s).not.toContain(s);
    setContext(STAFF);
    const staffHtml = await render(`/demo/warehouse/analytics?product=${ids.product}`);
    expect(staffHtml).not.toContain("Вартість запасу");
    expect(staffHtml).not.toContain("Створити партію (");
    expect(staffHtml).not.toContain(esc(uk("warehouseAnalytics.createBatchNote")));
    expect(staffHtml).toContain("Колонки собівартості доступні лише власнику.");
  });

  it("is reachable from the warehouse pages: the shared tabs include «Аналітика» (once, selected on the page)", async () => {
    expect(WAREHOUSE_SECTION_LINKS.find((l) => l.key === "analytics")).toMatchObject({
      path: "warehouse/analytics",
      labelKey: "warehouseAnalytics.nav",
      permission: "warehouse.view",
    });
    const target = "/demo/warehouse/analytics";
    setContext(STAFF);
    const own = tabs(await render(target));
    expect(own.hrefs.filter((x) => x === target)).toHaveLength(1);
    expect(own.selected).toBe(target);
    expect(tabs(await render("/demo/warehouse", { path: "warehouse", loader: stockPage.loader, action: stockPage.action, Component: stockPage.default })).hrefs).toContain(target);
    expect(
      tabs(await render("/demo/warehouse/movements", { path: "warehouse/movements", loader: movementsPage.loader, Component: movementsPage.default })).hrefs,
    ).toContain(target);
  });

  it("«create batch» opens the production form with the recommended products; the form is pre-filled with the recommended quantities", async () => {
    const { prefill } = await loadPage(`?product=${ids.product}`);
    const form = (await productionForm.loader({
      request: new Request(`${BASE}/production/new${prefill!.search}`),
      params: { batchId: "new" },
      context: {},
    } as never)) as { mode: string; editor: { selected: string[]; grid: Array<{ variants: Array<{ id: string }> }>; values: Record<string, { qty: number }> } };
    expect(form.mode).toBe("create");
    expect(form.editor.selected).toEqual([ids.product]);
    const gridVariants = form.editor.grid.flatMap((p) => p.variants.map((v) => v.id));
    expect(gridVariants).toEqual(expect.arrayContaining([ids.a, ids.d]));
    // Що форма має підставити (parseProductionPrefill у loader форми) — саме рекомендовані кількості й лише для сітки.
    expect(parseProductionPrefill(new URLSearchParams(prefill!.search), { allowedVariantIds: gridVariants })).toEqual({ [ids.d]: 20, [ids.a]: 10 });
    // Форма партії підставляє саме ці кількості (лише для варіантів сітки).
    expect(form.editor.values).toEqual({ [ids.d]: { qty: 20 }, [ids.a]: { qty: 10 } });
  });
});

/** Вкладки розділу «Склад» у HTML: посилання й вибрана. */
function tabs(html: string): { hrefs: string[]; selected: string | null } {
  const nav = /<nav class="ot-tabs[^"]*"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? "";
  const links = [...nav.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]);
  const hrefOf = (a: string) => /href="([^"]+)"/.exec(a)?.[1] ?? "";
  return { hrefs: links.map(hrefOf), selected: links.filter((a) => a.includes('aria-current="page"')).map(hrefOf)[0] ?? null };
}

const uk = (key: string) => DICTIONARIES.uk[key]!;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

type TestRoute = { path: string; loader: unknown; action?: unknown; Component: unknown };

async function render(path: string, route?: TestRoute): Promise<string> {
  const actor = m.ctx?.actor ?? OWNER;
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor: { id: actor.id, displayName: actor.displayName, role: actor.role, permissions: [...actor.permissions] },
    nav: [],
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", ...(route ?? { path: "warehouse/analytics", loader: page.loader, Component: page.default }) }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

// ---------------------------------------------------------------------------

describe("CSV export", () => {
  it("stock: owner gets cost columns, staff does not; materials included; no personal data", async () => {
    const owner = await exportStockCsv(env.ctx(OWNER));
    expect(owner).toMatchObject({ dataset: "stock", withCosts: true, truncated: false });
    expect(owner.fileName).toBe(`stock_${today}.csv`);
    const rows = parseCsv(owner.content);
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining(["sku", "on_hand", "available", "unit_cost", "cost_currency", "stock_value", "cost_source"]));
    expect(rows.find((r) => r.sku === "AT-A")).toMatchObject({
      kind: "product",
      on_hand: "20",
      available: "20",
      unit_cost: "14.00",
      cost_currency: "UAH",
      stock_value: "280.00",
      cost_source: "production_receipt",
      tracking: "opened",
    });
    const box = rows.find((r) => r.kind === "material" && r.sku === "box_s");
    expect(box).toMatchObject({ unit_cost: "12.00", cost_source: "material" });
    expect(owner.rows).toBe(rows.length);

    const staff = await exportStockCsv(env.ctx(STAFF), { separator: "comma" });
    expect(staff.withCosts).toBe(false);
    const staffRows = parseCsv(staff.content, ",");
    expect(Object.keys(staffRows[0]!)).not.toContain("unit_cost");
    expect(Object.keys(staffRows[0]!)).not.toContain("stock_value");
    expect(staff.content).not.toContain("14.00");
    for (const s of PII) {
      expect(owner.content, s).not.toContain(s);
      expect(staff.content, s).not.toContain(s);
    }
    await expect(exportStockCsv(env.ctx(NO_VIEW))).rejects.toMatchObject({ permission: "warehouse.view" });
  });

  it("movements: date range, filters, actor id only, no notes; costs only for the owner", async () => {
    const period = resolvePeriod({ key: "7", today });
    const owner = await exportMovementsCsv(env.ctx(OWNER), { period, filters: onlyTest() });
    const rows = parseCsv(owner.content);
    expect(rows).toHaveLength(4); // receipt:1 (перенесено на вчора — теж у 7 днях), receipt:2, receipt:3, start:1
    expect(new Set(rows.map((r) => r.sku))).toEqual(new Set(["AT-A", "AT-B"]));
    expect(Object.keys(rows[0]!)).toEqual(expect.arrayContaining(["created_at", "date", "type", "on_hand_delta", "actor_id", "unit_cost"]));
    expect(Object.keys(rows[0]!)).not.toContain("note");
    expect(Object.keys(rows[0]!)).not.toContain("actor_name");
    expect(rows.find((r) => r.type === "receipt_production" && r.unit_cost === "14.00")).toBeTruthy();
    expect(owner.content).not.toContain("+49"); // примітка з телефоном не експортується
    const staff = await exportMovementsCsv(env.ctx(STAFF), { period, filters: onlyTest() });
    expect(Object.keys(parseCsv(staff.content)[0]!)).not.toContain("unit_cost");
    // Період у минулому без рухів — лише заголовок.
    const old = resolvePeriod({ key: "custom", from: "2020-01-01", to: "2020-01-31", today });
    const empty = await exportMovementsCsv(env.ctx(STAFF), { period: old });
    expect(empty.rows).toBe(0);
    expect(empty.content.trimEnd().split("\r\n")).toHaveLength(1);
  });

  it("movements: a capped file is flagged as truncated (route header → page warning), oldest rows first", async () => {
    const period = resolvePeriod({ key: "7", today });
    const full = await exportMovementsCsv(env.ctx(STAFF), { period, filters: onlyTest() });
    expect(full.truncated).toBe(false);
    expect(full.rows).toBeGreaterThan(2);
    const capped = await exportMovementsCsv(env.ctx(STAFF), { period, filters: onlyTest(), maxRows: 2 });
    expect(capped).toMatchObject({ truncated: true, rows: 2 });
    expect(parseCsv(capped.content).map((r) => r.movement_id)).toEqual(parseCsv(full.content).slice(0, 2).map((r) => r.movement_id));
    expect(await exportMovementsCsv(env.ctx(STAFF), { period, filters: onlyTest(), maxRows: full.rows })).toMatchObject({ truncated: false });
    const audit = await env.handle.db.select().from(auditLog).where(and(eq(auditLog.action, "warehouse.exported"), eq(auditLog.actorId, STAFF.id)));
    expect(audit.some((a) => a.details.dataset === "movements" && a.details.truncated === true && a.details.rows === 2)).toBe(true);
    // Маршрут передає ознаку заголовком, сторінка читає її тим самим контрактом.
    setContext(STAFF);
    const res = await loadExport(`?dataset=movements&period=7&product=${ids.product}`);
    expect(res.headers.get("X-Export-Truncated")).toBe("0");
    expect(exportResponseOutcome(res)).toEqual({ ok: true, truncated: false, rows: full.rows });
  });

  it("sales by variant: period units, velocity, cover, stock-out and recommendation", async () => {
    const res = await exportSalesCsv(env.ctx(STAFF), { period: resolvePeriod({ key: "30", today }), filters: onlyTest() });
    const rows = parseCsv(res.content);
    expect(rows.map((r) => r.sku)).toEqual(["AT-A", "AT-D", "AT-B", "AT-C"]);
    expect(rows[0]).toMatchObject({
      units: "10",
      orders: "3",
      previous_units: "6",
      units_30d: "10",
      units_90d: "16",
      velocity_30d: "0.333",
      velocity_90d: "0.178",
      velocity_weighted: "0.281",
      available: "20",
      days_of_cover: "60.0",
      stockout_date: addDays(today, 60),
      recommended_qty: "10",
      risk: "none",
    });
    expect(rows[1]).toMatchObject({ sku: "AT-D", planned: "5", recommended_qty: "20", risk: "out", stockout_date: today });
    expect(rows[3]).toMatchObject({ sku: "AT-C", units: "0", days_of_cover: "0.0", recommended_qty: "0" });
    expect(Object.keys(rows[0]!)).not.toContain("unit_cost");
    const owner = await exportSalesCsv(env.ctx(OWNER), { period: resolvePeriod({ key: "30", today }), filters: onlyTest() });
    expect(parseCsv(owner.content)[0]).toMatchObject({ sku: "AT-A", unit_cost: "14.00", cost_currency: "UAH" });
  });

  it("resource route: CSV headers, permission checks, invalid parameters and an audit record", async () => {
    const res = await loadExport(`?dataset=sales&period=7&product=${ids.product}&sep=comma`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; filename="sales_\d{4}-\d{2}-\d{2}_\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Export-With-Costs")).toBe("1");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM
    const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
    expect(body.slice(1).split("\r\n")[0]).toMatch(/^period_from,period_to,sku,/);
    expect(parseCsv(body, ",").map((r) => r.sku)).toContain("AT-A");

    setContext(STAFF);
    const staff = await loadExport("?dataset=stock");
    expect(staff.status).toBe(200);
    expect(staff.headers.get("X-Export-With-Costs")).toBe("0");
    expect((await staff.text()).split("\r\n")[0]).not.toContain("unit_cost");
    expect((await loadExport("?dataset=orders")).status).toBe(400);
    expect((await loadExport("?dataset=movements&period=custom&from=2026-11-10&to=2026-11-01")).status).toBe(400);
    setContext(NO_VIEW);
    expect((await loadExport("?dataset=stock")).status).toBe(403);

    const audit = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "warehouse.exported"), like(auditLog.actorId, "test-%")));
    expect(audit.length).toBeGreaterThanOrEqual(3);
    expect(audit.some((a) => a.details.dataset === "sales" && a.details.withCosts === true)).toBe(true);
    expect(audit.some((a) => a.actorId === STAFF.id && a.details.withCosts === false)).toBe(true);
  });
});

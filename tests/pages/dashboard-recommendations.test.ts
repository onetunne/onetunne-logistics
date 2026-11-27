import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { orderLineItems, orders } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES, makeT } from "~/i18n";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { addDays, resolvePeriod } from "~/modules/warehouse-analytics/calc";
import { computeWarehouseAnalytics, loadRecommendationSummary } from "~/modules/warehouse-analytics/queries.server";
import { businessDate, businessDayStart } from "~/modules/warehouse/dates";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { apply, insertProduct, stockItemFor } from "../stage5/helpers";
import { esc, renderPage } from "./insights-render";

/**
 * S5-REC-DASH (R6): головна для того, хто планує виробництво (production.manage + warehouse.view) — кількість позицій
 * під ризиком закінчення й тих, що потребують нової партії, з посиланням на «Аналітику складу». Ті самі числа, що
 * kpi аналітики; без собівартості. Вигаданий товар «Rec Test»:
 *   RT-A — відкрито, 2 на складі, продано 30 за 10 днів → закінчиться раніше, ніж встигне партія (critical);
 *   RT-B — відкрито, 0 на складі, продано 6 → немає в наявності (out);
 *   RT-C — НЕ відкрито (прогнозу немає), продано 50 → не рахується.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/dashboard");
let today: string;
const MANAGER = makeActor({ id: "planner", displayName: "Planner", role: "staff", overrides: { grant: ["production.manage"] } });
const MANAGER_NO_VIEW = makeActor({
  id: "planner-no-view",
  displayName: "Planner without stock",
  role: "staff",
  overrides: { grant: ["production.manage"], revoke: ["warehouse.view"] },
});

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale };
}
const load = () => page.loader({ request: new Request("http://localhost/demo"), params: {}, context: {} } as never);
const at = (offset: number) => new Date(businessDayStart(addDays(today, offset)).getTime() + 12 * 3600 * 1000);

let seq = 0;
async function sale(variantId: string, quantity: number, offset: number) {
  seq += 1;
  const [o] = await env.handle.db
    .insert(orders)
    .values({
      source: "demo",
      orderNumber: `#RT-${seq}`,
      status: "delivered",
      financialStatus: "paid",
      currency: "EUR",
      subtotal: "10.00",
      total: "10.00",
      placedAt: at(offset),
    })
    .returning({ id: orders.id });
  await env.handle.db
    .insert(orderLineItems)
    .values({ orderId: o!.id, variantId, title: "Rec Test", quantity, unitPrice: "10.00", currency: "EUR", position: 0 });
}

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/dashboard");
  today = businessDate(new Date());
  const db = env.handle.db;
  const p = await insertProduct(db, "Rec Test", [{ sku: "RT-A" }, { sku: "RT-B" }, { sku: "RT-C" }]);
  const [a, b, c] = p.variantIds as [string, string, string];
  const stockA = await stockItemFor(db, a);
  await stockItemFor(db, b);
  await ensureStockItemForVariant(db, c); // не відкрито
  await apply(db, { stockItemId: stockA, type: "receipt_manual", idempotencyKey: "rt-a-in", onHandDelta: 2 });
  for (let d = 1; d <= 10; d++) await sale(a, 3, -d);
  await sale(b, 6, -3);
  await sale(c, 50, -2);
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => setContext());

describe("dashboard: stock-out risks and new batch recommendations (S5-REC-DASH)", () => {
  it("summary matches the warehouse analytics KPIs (same rules, opened items only)", async () => {
    const summary = await loadRecommendationSummary(env.handle.db, today);
    const full = await computeWarehouseAnalytics(env.handle.db, { today, period: resolvePeriod({ today }) });
    expect(summary).toEqual({
      atRisk: full.kpi.atRisk,
      outOfStock: full.kpi.outOfStock,
      recommendations: full.kpi.recommendations,
      recommendedUnits: full.kpi.recommendedUnits,
    });
    const skus = (rows: typeof full.atRisk) => rows.map((v) => v.sku).filter((s) => s?.startsWith("RT-"));
    expect(skus(full.atRisk).sort()).toEqual(["RT-A", "RT-B"]);
    expect(skus(full.recommendations).sort()).toEqual(["RT-A", "RT-B"]);
    expect(summary.atRisk).toBeGreaterThanOrEqual(2);
    expect(summary.outOfStock).toBeGreaterThanOrEqual(1);
  });

  it("owner and a staff planner (production.manage) get the counts; staff without it, or without warehouse.view, do not", async () => {
    const expected = await loadRecommendationSummary(env.handle.db, today);
    for (const actor of [OWNER, MANAGER]) {
      setContext(actor);
      const data = await load();
      expect(data.warehouse?.recommendations, actor.id).toEqual(expected);
      // Лише кількості: жодної собівартості чи даних покупців.
      expect(JSON.stringify(data.warehouse?.recommendations)).not.toMatch(/cost|currency|customer|email|phone/i);
    }
    setContext(STAFF);
    expect((await load()).warehouse?.recommendations).toBeNull();
    setContext(MANAGER_NO_VIEW);
    const noView = await load();
    expect(noView.warehouse?.recommendations ?? null).toBeNull();
    expect(noView.warehouse?.alerts ?? null).toBeNull();
  });

  it("renders the card with both counts and a link to the warehouse analytics (uk + en); hidden for staff", async () => {
    const route = { path: "", loader: page.loader, action: page.action, Component: page.default };
    const summary = await loadRecommendationSummary(env.handle.db, today);
    for (const locale of ["uk", "en"] as const) {
      setContext(MANAGER, locale);
      const t = makeT(locale);
      const html = await renderPage({ ...route, path: "" } as never, "/demo", MANAGER, locale);
      expect(html).toContain(esc(t("dashboard.stage5.recommendations.title")));
      expect(html).toContain(esc(t("dashboard.stage5.recommendations.atRisk")));
      expect(html).toContain(esc(t("dashboard.stage5.recommendations.needBatch")));
      expect(html).toContain(esc(t("dashboard.stage5.recommendations.outOfStock", { count: String(summary.outOfStock) })));
      expect(html).toContain('href="/demo/warehouse/analytics"');
      expect(html).not.toContain(esc(t("dashboard.stage5.recommendations.none")));
    }
    setContext(STAFF);
    const staffHtml = await renderPage(route as never, "/demo", STAFF);
    expect(staffHtml).not.toContain(esc(DICTIONARIES.uk["dashboard.stage5.recommendations.title"]!));
    expect(staffHtml).not.toContain('href="/demo/warehouse/analytics"');
  });

  it("plural forms of the recommended units", () => {
    expect(makeT("uk")("dashboard.stage5.recommendations.units", { units: 1 })).toBe("Рекомендовано виготовити: 1 одиницю");
    expect(makeT("uk")("dashboard.stage5.recommendations.units", { units: 3 })).toBe("Рекомендовано виготовити: 3 одиниці");
    expect(makeT("uk")("dashboard.stage5.recommendations.units", { units: 40 })).toBe("Рекомендовано виготовити: 40 одиниць");
    expect(makeT("en")("dashboard.stage5.recommendations.units", { units: 1 })).toBe("Recommended to produce: 1 unit");
    expect(makeT("en")("dashboard.stage5.recommendations.units", { units: 40 })).toBe("Recommended to produce: 40 units");
  });
});

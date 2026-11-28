/**
 * Етап 6, WP2: сторінка «Собівартість» на повному демо (seedDemoData + перебудова оцінки, як наприкінці seedDemoFinance):
 * рендер uk/en без помилок і сирих ключів; розділи заповнені даними демо-історії (партії, вартість запасів, моделі);
 * працівник — 403. Числа демо фінансів закріплює WP11 (тут — лише узгодженість із рушієм).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { inventoryCostState } from "~/db/schema";
import { rebuildValuationForDemo } from "~/modules/costing/backfill.server";
import { toMinor, fromMinor } from "~/lib/money";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../../helpers";
import { renderPage } from "../../pages/insights-render";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/finance-costs");
beforeAll(async () => {
  env = await createTestEnv();
  await env.handle.db.transaction((tx) => rebuildValuationForDemo(tx, { mode: "demo" }));
  page = await import("~/pages/finance-costs");
});
afterAll(async () => {
  await env.close();
});

const text = (html: string) => html.replace(/<script[^]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("costs page on the demo", () => {
  it("owner: batches, stock value and models come from the engine; uk/en render without raw keys; staff → 403", async () => {
    m.ctx = { ...env.ctx(OWNER), basePath: "/demo", locale: "uk" };
    const data = await page.loader({ request: new Request("http://localhost/demo/finance/costs"), params: {}, context: {} } as never);
    expect(data.batches.length).toBeGreaterThan(0);
    expect(data.batches.some((b) => b.booked !== null)).toBe(true);
    // Вартість товарів на сьогодні = Σ відомої вартості пулів товарів (рушій).
    const states = await env.handle.db.select().from(inventoryCostState);
    expect(states.length).toBeGreaterThan(0);
    const total = states.reduce((s, r) => s + toMinor(r.knownValue), 0n);
    expect(toMinor(data.stockValue.products.value) + toMinor(data.stockValue.materials.value)).toBe(total);
    expect(fromMinor(total)).not.toBe("0.00");
    expect(data.models.rows.length).toBeGreaterThan(0);
    const route = { path: "finance/costs", loader: page.loader, action: page.action, Component: page.default };
    const uk = text(await renderPage(route as never, "/demo/finance/costs", OWNER));
    expect(uk).toContain("Вартість запасів");
    expect(uk).toContain("Демо: усі фінансові дані вигадані.");
    expect(uk).not.toMatch(/financeCosts\./);
    m.ctx = { ...env.ctx(OWNER), basePath: "/demo", locale: "en" };
    const en = text(await renderPage(route as never, "/demo/finance/costs", OWNER, "en"));
    expect(en).toContain("Inventory value");
    expect(en).not.toMatch(/financeCosts\.|finance\./);
    m.ctx = { ...env.ctx(STAFF), basePath: "/demo", locale: "uk" };
    await expect(page.loader({ request: new Request("http://localhost/demo/finance/costs"), params: {}, context: {} } as never)).rejects.toMatchObject({ status: 403 });
  });
});

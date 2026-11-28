/**
 * Етап 6, WP2: сторінка «Фінанси → Собівартість» (docs/stage6-design.md §18.7, §14.2): власник — дані й дії; працівник
 * (і підроблений актор із finance.view, але роллю staff) — 403 на loader і action; порожня фінансова база — «Немає
 * даних» (ніде не 0); SSR uk/en без сирих ключів і кирилиці в англійській версії; працівник не бачить сум.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Actor } from "~/domain/permissions";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { move, openCostEnv, product, type CostEnv } from "./db-helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: CostEnv;
let page: typeof import("~/pages/finance-costs");
/** Підроблений актор: дозволи фінансів прямо в наборі (обхід resolvePermissions), роль staff — перевіряє саме роль. */
const FORGED: Actor = { ...STAFF, id: "forged", permissions: new Set([...STAFF.permissions, "finance.view", "finance.manage"]) };

function setContext(actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale };
}
const route = () => ({ path: "finance/costs", loader: page.loader, action: page.action, Component: page.default });
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

beforeAll(async () => {
  env = await openCostEnv();
  page = await import("~/pages/finance-costs");
});
afterAll(async () => {
  await env.close();
});

async function load(url = "http://localhost/demo/finance/costs") {
  return page.loader({ request: new Request(url), params: {}, context: {} } as never);
}
async function act(fields: Record<string, string>) {
  const body = new URLSearchParams(fields);
  return page.action({ request: new Request("http://localhost/demo/finance/costs", { method: "POST", body }), params: {}, context: {} } as never);
}

describe("access", () => {
  it("staff and a forged staff actor get 403 on the loader and the action", async () => {
    expect(FORGED.permissions.has("finance.view") && FORGED.permissions.has("finance.manage")).toBe(true);
    for (const actor of [STAFF, FORGED]) {
      setContext(actor);
      await expect(load()).rejects.toMatchObject({ status: 403 });
      await expect(act({ intent: "saveCost" })).rejects.toMatchObject({ status: 403 });
    }
  });
});

describe("empty finance database", () => {
  it("renders every section with «Немає даних» / empty states, never a fabricated 0 value", async () => {
    setContext(OWNER);
    const data = await load();
    expect(data.attention).toEqual([]);
    expect(data.batches).toEqual([]);
    expect(data.models.rows).toEqual([]);
    expect(data.stockValue.products.value).toBe("0.00");
    const html = text(await renderPage(route() as never, "/demo/finance/costs", OWNER));
    expect(html).toContain("Собівартість");
    expect(html).toContain("Немає даних");
    expect(html).toContain("Усі одиниці мають собівартість.");
    expect(html).not.toMatch(/financeCosts\./);
    const en = text(await renderPage(route() as never, "/demo/finance/costs", OWNER, "en"));
    expect(en).toContain("No data");
    expect(en).not.toMatch(/financeCosts\./);
  });
});

describe("with data", () => {
  it("the owner sees the attention list, the preview and saves a cost; the English page has no Cyrillic in its own texts", async () => {
    const p = await product(env.db, { model: "PG-M", color: "Black" });
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 4, reason: "found" });
    setContext(OWNER);
    const data = await load(`http://localhost/demo/finance/costs?item=${p.stockItemId}&effectiveFrom=2026-11-01`);
    expect(data.attention.find((a) => a.stockItemId === p.stockItemId)).toMatchObject({ onHandWithoutCost: 4, soldWithoutCost: 0 });
    expect(data.preview).toEqual({ items: 1, onHandWithoutCost: 4, soldWithoutCost: 0, orders: 0, soldAwaitingReceipt: 0 });
    const html = text(await renderPage(route() as never, `/demo/finance/costs?item=${p.stockItemId}&effectiveFrom=2026-11-01`, OWNER));
    expect(html).toContain("Без собівартості: на складі 4 од., продано 0 од.");
    const r = await act({
      intent: "saveCost",
      operationId: randomUUID(),
      stockItemId: p.stockItemId,
      unitCost: "12,50",
      currency: "UAH",
      effectiveFrom: "2026-11-01",
      applyToStock: "on",
    });
    expect(r).toMatchObject({ ok: true, message: "financeCosts.result.saved", params: { items: 1, stock: 4, sold: 0 } });
    const after = await load();
    expect(after.attention.find((a) => a.stockItemId === p.stockItemId)).toBeUndefined();
    expect(after.stockValue.products.value).toBe("50.00");
    expect(after.models.rows.find((x) => x.model === "PG-M")).toMatchObject({ stock: { qty: 4, value: "50.00", average: "12.50" } });
    // Невірна сума — помилка розбору, нічого не записано.
    expect(await act({ intent: "saveCost", operationId: randomUUID(), stockItemId: p.stockItemId, unitCost: "1,2.5", currency: "UAH", effectiveFrom: "2026-11-01" })).toMatchObject({
      ok: false,
      error: "finance.error.amountAmbiguous",
    });
    // Підказки Shopify в демо недоступні.
    expect(await act({ intent: "importShopify", operationId: randomUUID() })).toMatchObject({ ok: false, error: "financeCosts.error.shopifyUnavailable" });
    const en = text(await renderPage(route() as never, "/demo/finance/costs", OWNER, "en"));
    expect(en).toContain("Inventory value");
    expect(en).not.toMatch(/financeCosts\./);
  });
});

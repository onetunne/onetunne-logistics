import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { productionBatchLines, productionBatches, productVariants, products } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { getBalance, ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Розділ «Виробництво» (/demo/production, /app/production, …/production/:batchId): loader/action з підміненим
 * контекстом запиту (демо або робочий режим після authenticate.admin), серверний рендер. PGlite з демо-даними
 * (демо-партія PB-<рік>-0001 «у виробництві»: OT-PH-WHT 50 × 210.00, OT-FK-S 30 × 320.00, додатково 1500.00 UAH).
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let list: typeof import("~/pages/production");
let page: typeof import("~/pages/production-batch");
let demoBatchId: string;

const MANAGER_NO_FINANCE = makeActor({ id: "mgr", displayName: "Manager", role: "staff", overrides: { grant: ["production.manage"] } });

beforeAll(async () => {
  env = await createTestEnv();
  list = await import("~/pages/production");
  page = await import("~/pages/production-batch");
  const [b] = await env.handle.db.select().from(productionBatches);
  demoBatchId = b!.id;
});

afterAll(async () => {
  await env.close();
});

type Mode = "demo" | "production";
function setContext(actor: Actor = OWNER, mode: Mode = "demo") {
  m.ctx = { ...env.ctx(actor), mode, basePath: mode === "demo" ? "/demo" : "/app", locale: "uk" };
}
beforeEach(() => setContext());

const base = () => (m.ctx?.mode === "production" ? "http://localhost/app" : "http://localhost/demo");

async function loadList(search = "") {
  return list.loader({ request: new Request(`${base()}/production${search}`), params: {}, context: {} } as never);
}
async function loadBatch(batchId: string, search = "") {
  return page.loader({ request: new Request(`${base()}/production/${batchId}${search}`), params: { batchId }, context: {} } as never);
}
function formOf(fields: Record<string, string | string[]>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return body;
}
async function actBatch(batchId: string, fields: Record<string, string | string[]>) {
  return page.action({
    request: new Request(`${base()}/production/${batchId}`, { method: "POST", body: formOf(fields) }),
    params: { batchId },
    context: {},
  } as never);
}
async function actList(fields: Record<string, string | string[]>) {
  return list.action({ request: new Request(`${base()}/production`, { method: "POST", body: formOf(fields) }), params: {}, context: {} } as never);
}
async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

async function variantId(sku: string) {
  const [row] = await env.handle.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku));
  return row!.id;
}
async function productId(handle: string) {
  const [row] = await env.handle.db.select({ id: products.id }).from(products).where(eq(products.handle, handle));
  return row!.id;
}
async function batch(id: string) {
  const [row] = await env.handle.db.select().from(productionBatches).where(eq(productionBatches.id, id));
  return row!;
}
async function batchLines(id: string) {
  return env.handle.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, id));
}

/** Створення партії через форму (власник). Повертає id з адреси перенаправлення. */
async function createViaForm(fields: Record<string, string | string[]>): Promise<string> {
  const res = (await actBatch("new", { intent: "create", title: "Партія з форми", ...fields })) as Response;
  expect(res).toBeInstanceOf(Response);
  expect(res.status).toBe(302);
  const location = res.headers.get("Location")!;
  expect(location).toMatch(/\/production\/[0-9a-f-]{36}\?notice=created$/);
  return location.split("/production/")[1]!.split("?")[0]!;
}

/** Серверний рендер сторінки в мінімальному дереві маршрутів (root → макет → сторінка). */
async function render(path: string, route: { loader: unknown; action: unknown; Component: unknown; path: string }): Promise<string> {
  const mode = m.ctx?.mode ?? "demo";
  const actor = m.ctx?.actor ?? OWNER;
  const layoutId = mode === "demo" ? "routes/demo-layout" : "routes/app-layout";
  const shell: ShellData = {
    mode,
    basePath: mode === "demo" ? "/demo" : "/app",
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
        { id: layoutId, path: mode === "demo" ? "demo" : "app", loader: () => shell, Component: Outlet, children: [{ id: "page", ...route }] },
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
const listRoute = () => ({ loader: list.loader, action: list.action, Component: list.default, path: "production" });
const batchRoute = () => ({ loader: page.loader, action: page.action, Component: page.default, path: "production/:batchId" });
const uk = (key: string) => DICTIONARIES.uk[key]!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const COST_VALUES = /1500\.00|210\.00|320\.00|21600|unitCost|extraCost|costPerGoodUnit/;

describe("production list", () => {
  it("staff: read-only list with receive hint, demo batch, no cost data at all", async () => {
    setContext(STAFF);
    const data = await loadList();
    expect(data).toMatchObject({ activeBatches: 1, canManage: false, canReceive: true, canSeeCosts: false });
    const row = data.rows.find((r) => r.id === demoBatchId)!;
    expect(row).toMatchObject({
      status: "in_production",
      totals: { ordered: 80, remaining: 80 },
      remainderKind: "inProduction",
      inProduction: 80,
      cost: null,
      productCount: 2,
    });
    expect(JSON.stringify(data)).not.toMatch(COST_VALUES);
  });

  it("owner sees the cost total and both modes work (production after authenticate.admin)", async () => {
    for (const mode of ["demo", "production"] as const) {
      setContext(OWNER, mode);
      const row = (await loadList()).rows.find((r) => r.id === demoBatchId)!;
      // 50 × 210 + 30 × 320 + 1500 = 21 600.
      expect(row.cost).toMatchObject({ total: "21600.00", currency: "UAH", complete: true, costPerGoodUnit: null });
    }
  });

  it("filters by model, colour, product, status tab and overdue", async () => {
    expect((await loadList("?model=Model%20S")).rows.map((r) => r.id)).toContain(demoBatchId);
    expect((await loadList(`?color=${encodeURIComponent("Чорний")}`)).rows.map((r) => r.id)).not.toContain(demoBatchId);
    expect((await loadList(`?product=${await productId("rear-fender")}`)).rows.map((r) => r.id)).toContain(demoBatchId);
    expect((await loadList("?tab=closed")).rows.map((r) => r.id)).not.toContain(demoBatchId);
    const overdue = await loadList("?overdue=1&tab=all");
    expect(overdue.rows.map((r) => r.id)).not.toContain(demoBatchId);
    expect(overdue.isFiltered).toBe(true);
    const data = await loadList("?page=99");
    expect(data.page).toBe(1);
    expect(data.options.models).toEqual(expect.arrayContaining(["Model S"]));
  });

  it("403 without warehouse.view", async () => {
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view"] } }));
    expect(await status(loadList())).toBe(403);
    expect(await status(loadBatch(demoBatchId))).toBe(403);
  });

  it("renders for owner (new batch, cost column) and staff (no cost, read-only banner)", async () => {
    const owner = await render("/demo/production", listRoute());
    expect(owner).toContain(esc(uk("production.new")));
    expect(owner).toContain(esc(uk("production.list.cost")));
    expect(owner).toContain(`/demo/production/${demoBatchId}`);
    setContext(STAFF, "production");
    const staff = await render("/app/production", listRoute());
    expect(staff).not.toContain(esc(uk("production.new")));
    expect(staff).not.toContain(esc(uk("production.list.cost")));
    expect(staff).toContain(esc(uk("production.readOnly.canReceive")));
    expect(staff).toContain(`/app/production/${demoBatchId}`);
    // Без warehouse.receive — лише перегляд; текст не посилається на дозвіл, якого немає в інтерфейсі «Працівники».
    setContext(makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["warehouse.receive"] } }));
    const viewer = await render("/demo/production", listRoute());
    expect(viewer).toContain(esc(uk("production.readOnly")));
    for (const dict of [DICTIONARIES.uk, DICTIONARIES.en]) {
      expect(Object.values(dict).join("\n")).not.toMatch(/Керування виробництвом|Manage production/);
    }
  });

  it("bulk start: confirmation applies to planned batches with the shown version, stale ones are skipped", async () => {
    const a = await createViaForm({ [`qty.${await variantId("OT-GR-BLK")}`]: "4" });
    const b = await createViaForm({ [`qty.${await variantId("OT-GR-GRY")}`]: "2" });
    setContext(STAFF);
    expect(await actList({ intent: "bulkStart", batch: [`${a}:1`] })).toEqual({ ok: false, error: "error.forbidden" });
    setContext(OWNER);
    const res = await actList({ intent: "bulkStart", batch: [`${a}:1`, `${b}:7`, "garbage"] });
    expect(res).toMatchObject({ ok: true, message: "production.result.bulkStarted", params: { done: 1, skipped: 1, units: 4 }, tone: "warning" });
    expect((await batch(a)).status).toBe("in_production");
    expect((await batch(b)).status).toBe("planned");
    expect(await actList({ intent: "bulkStart" })).toEqual({ ok: false, error: "production.error.noneSelected" });
    const close = await actList({ intent: "bulkClose", batch: [`${a}:${(await batch(a)).version}`] });
    expect(close).toMatchObject({ ok: true, params: { done: 1, units: 4 } });
    expect((await batch(a)).status).toBe("closed");
    const stock = await getBalance(env.handle.db, await ensureStockItemForVariant(env.handle.db, await variantId("OT-GR-BLK")));
    expect(stock.inProduction).toBe(0);
  });
});

describe("batch page: create and edit", () => {
  it("owner creates a batch from the model × colour grid; product default cost fills variants without own cost", async () => {
    const [x, s] = [await variantId("OT-FK-X"), await variantId("OT-FK-S")];
    const fender = await productId("rear-fender");
    const id = await createViaForm({
      plannedReadyDate: "2031-03-01",
      manufacturer: "Майстерня",
      costCurrency: "EUR",
      extraCost: "12,5",
      [`qty.${x}`]: "20",
      [`cost.${x}`]: "7.10",
      [`qty.${s}`]: "10",
      [`cost.${s}`]: "",
      [`defaultCost.${fender}`]: "6",
      [`qty.${await variantId("OT-PH-BLK")}`]: "0",
    });
    const b = await batch(id);
    expect(b).toMatchObject({ status: "planned", title: "Партія з форми", manufacturer: "Майстерня", extraCost: "12.50", costCurrency: "EUR" });
    const lines = new Map((await batchLines(id)).map((l) => [l.variantId, l]));
    expect(lines.size).toBe(2);
    expect(lines.get(x)).toMatchObject({ quantityOrdered: 20, unitCost: "7.10", costCurrency: "EUR" });
    expect(lines.get(s)).toMatchObject({ quantityOrdered: 10, unitCost: "6.00" });

    const created = await loadBatch(id, "?notice=created");
    expect(created).toMatchObject({ mode: "view", notice: "created", receiptKey: null });
    expect(created.detail!.costs!.summary).toMatchObject({ total: "214.50", currency: "EUR" });
  });

  it("validation errors map to form fields; qty parse errors before the service", async () => {
    const x = await variantId("OT-FK-X");
    expect(await actBatch("new", { intent: "create", title: "", [`qty.${x}`]: "5" })).toMatchObject({
      ok: false,
      error: "error.validation",
      fieldErrors: { title: "production.fieldError.required" },
    });
    expect(await actBatch("new", { intent: "create", title: "T", [`qty.${x}`]: "1.5" })).toMatchObject({
      fieldErrors: { [`qty.${x}`]: "production.fieldError.invalidQuantity" },
    });
    expect(await actBatch("new", { intent: "create", title: "T" })).toMatchObject({ fieldErrors: { lines: "production.fieldError.noLines" } });
    expect(await actBatch("new", { intent: "create", title: "T", [`qty.${x}`]: "1", [`cost.${x}`]: "abc", costCurrency: "UAH" })).toMatchObject({
      fieldErrors: { [`cost.${x}`]: "production.fieldError.invalidMoney" },
    });
    expect(await actBatch("new", { intent: "dropTables" })).toEqual({ ok: false, error: "error.generic" });
  });

  it("staff cannot open or post the create form; a manager without finance.view creates without costs (cost fields ignored)", async () => {
    setContext(STAFF);
    expect(await status(loadBatch("new"))).toBe(403);
    expect(await actBatch("new", { intent: "create", title: "T", [`qty.${await variantId("OT-FK-X")}`]: "1" })).toEqual({
      ok: false,
      error: "error.forbidden",
    });
    setContext(MANAGER_NO_FINANCE);
    const editor = await loadBatch("new", `?product=${await productId("rear-fender")}`);
    expect(editor.mode).toBe("create");
    expect(editor.canSeeCosts).toBe(false);
    const x = await variantId("OT-FK-X");
    const id = await createViaForm({ [`qty.${x}`]: "3", [`cost.${x}`]: "99.00", extraCost: "50", costCurrency: "UAH" });
    expect(await batch(id)).toMatchObject({ extraCost: null, costCurrency: null });
    expect((await batchLines(id))[0]).toMatchObject({ unitCost: null, quantityOrdered: 3 });
  });

  it("the create page shows the product picker and a grid: models as rows, colours as columns", async () => {
    const holder = await productId("phone-holder-pro");
    const fender = await productId("rear-fender");
    const data = await loadBatch("new", `?product=${holder}&product=${fender}&pq=${encodeURIComponent("Крило")}`);
    expect(data.editor!.picker.map((p) => p.id)).toEqual([fender]);
    const grid = new Map(data.editor!.grid.map((g) => [g.productId, g]));
    // Порядок варіантів з однаковим часом створення (демо-дані) — за SKU; перевіряємо склад рядків і колонок.
    expect(grid.get(holder)!.models).toEqual([null]);
    expect([...grid.get(holder)!.colors].sort()).toEqual(["Білий", "Чорний"]);
    expect([...grid.get(fender)!.models].sort()).toEqual(["Model S", "Model X"]);
    expect(grid.get(fender)!.colors).toEqual([null]);
    const html = await render(`/demo/production/new?product=${holder}&product=${fender}`, batchRoute());
    expect(html).toContain(`name="qty.${await variantId("OT-PH-WHT")}"`);
    expect(html).toContain(`name="cost.${await variantId("OT-FK-S")}"`);
    expect(html).toContain(`name="defaultCost.${fender}"`);
    expect(html).toContain(esc(uk("production.grid.noModel")));
    expect(html).toContain(">Білий<");
    // Вибраний товар поза результатами пошуку зберігається прихованим полем.
    const searched = await render(`/demo/production/new?product=${holder}&pq=${encodeURIComponent("Крило")}`, batchRoute());
    expect(searched).toContain(`type="hidden" name="product" value="${holder}"`);
  });

  it("edit: planned only, prefilled grid, optimistic version; redirect with notice", async () => {
    const x = await variantId("OT-FK-X");
    const id = await createViaForm({ [`qty.${x}`]: "5" });
    const data = await loadBatch(id, "?edit=1");
    expect(data.mode).toBe("edit");
    expect(data.editor!.values[x]).toEqual({ qty: 5, cost: null });
    const html = await render(`/demo/production/${id}?edit=1`, batchRoute());
    expect(html).toMatch(new RegExp(`name="qty\\.${x}"[^>]*value="5"|value="5"[^>]*name="qty\\.${x}"`));
    const stale = await actBatch(id, { intent: "update", version: "9", title: "Нова назва", [`qty.${x}`]: "6" });
    expect(stale).toMatchObject({ ok: false, error: "error.conflict" });
    const res = (await actBatch(id, { intent: "update", version: "1", title: "Нова назва", [`qty.${x}`]: "6" })) as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe(`/demo/production/${id}?notice=updated`);
    expect((await batchLines(id))[0]!.quantityOrdered).toBe(6);
    // Для запущеної партії ?edit=1 ігнорується.
    expect((await loadBatch(demoBatchId, "?edit=1")).mode).toBe("view");
  });
});

/** Клітинка DataTable (мобільна картка/таблиця): «підпис» → «значення». */
const cell = (label: string, value: string) => `<span class="ot-dt__label">${esc(label)}</span><span class="ot-dt__value">${esc(value)}</span>`;

describe("remainder by status: planned, cancelled and closed batches are not shown as in production", () => {
  it("planned → started → cancelled: detail labels and list column follow the ledger (in_production 0)", async () => {
    const grips = await variantId("OT-GR-GRY");
    const id = await createViaForm({ [`qty.${grips}`]: "15" });
    // Заплановано: «до виготовлення», не «у виробництві»; окремої колонки залишку немає (дорівнює «Замовлено»).
    expect((await loadBatch(id)).detail).toMatchObject({ remainderKind: "toProduce", inProduction: 0 });
    const planned = await render(`/demo/production/${id}`, batchRoute());
    expect(planned).toContain(esc(uk("production.totals.toProduce")));
    expect(planned).not.toContain(esc(uk("production.totals.remaining")));
    expect(planned).not.toContain(`<span class="ot-dt__label">${esc(uk("production.lines.remaining"))}</span>`);
    const plannedList = await loadList("?tab=planned");
    expect(plannedList.rows.find((r) => r.id === id)).toMatchObject({ remainderKind: "toProduce", inProduction: 0, totals: { remaining: 15 } });

    expect(await actBatch(id, { intent: "start", version: "1" })).toMatchObject({ ok: true });
    const started = await render(`/demo/production/${id}`, batchRoute());
    expect(started).toContain(esc(uk("production.totals.remaining")));
    expect(started).toContain(cell(uk("production.lines.remaining"), "15"));

    expect(await actBatch(id, { intent: "cancel", version: "2" })).toMatchObject({ ok: true, message: "production.result.cancelled", params: { units: 15 } });
    const stock = await getBalance(env.handle.db, await ensureStockItemForVariant(env.handle.db, grips));
    expect(stock.inProduction).toBe(0);
    const data = await loadBatch(id);
    expect(data.detail).toMatchObject({ remainderKind: "notProduced", inProduction: 0, totals: { remaining: 15 } });
    const html = await render(`/demo/production/${id}`, batchRoute());
    expect(html).toContain(esc(uk("production.totals.notProducedCancelled")));
    expect(html).not.toContain(esc(uk("production.totals.remaining")));
    expect(html).toContain(cell(uk("production.lines.notProduced"), "15"));
    expect(html).not.toContain(cell(uk("production.lines.remaining"), "15"));

    // Перелік (вкладка «Скасовано»): колонка «У виробництві» — «—», а не 15.
    const listed = await loadList("?tab=cancelled");
    expect(listed.rows.find((r) => r.id === id)).toMatchObject({ remainderKind: "notProduced", inProduction: 0 });
    const listHtml = await render("/demo/production?tab=cancelled", listRoute());
    expect(listHtml).toContain(cell(uk("production.list.remaining"), "—"));
    expect(listHtml).not.toContain(cell(uk("production.list.remaining"), "15"));
    // Активна демо-партія — справжні 80 од. у виробництві.
    expect(await render("/demo/production", listRoute())).toContain(cell(uk("production.list.remaining"), "80"));
  });

  it("closed short: «not produced» remainder; owner cost bills only produced units (planned labels while open)", async () => {
    const grips = await variantId("OT-GR-BLK");
    const id = await createViaForm({ [`qty.${grips}`]: "10", [`cost.${grips}`]: "100", costCurrency: "UAH" });
    await actBatch(id, { intent: "start", version: "1" });
    setContext(STAFF);
    const form = await loadBatch(id);
    const lineId = form.detail!.lines[0]!.id;
    expect(await actBatch(id, { intent: "receive", receiptKey: form.receiptKey!, [`good.${lineId}`]: "4" })).toMatchObject({ ok: true });
    setContext(OWNER);
    expect((await loadBatch(id)).detail!.costs!.summary).toMatchObject({ total: "1000.00", producedTotal: "400.00", costPerGoodUnit: "100.00" });
    const open = await render(`/demo/production/${id}`, batchRoute());
    expect(open).toContain(esc(uk("production.cost.totalPlanned")));
    expect(open).toContain(esc(uk("production.cost.perGoodUnitSoFar")));
    expect(open).toContain(cell(uk("production.lines.remaining"), "6"));

    expect(await actBatch(id, { intent: "close", version: String((await batch(id)).version) })).toMatchObject({ ok: true, params: { units: 6 } });
    const closed = await loadBatch(id);
    expect(closed.detail).toMatchObject({ remainderKind: "notProduced", inProduction: 0 });
    // Рецензія: було 1000.00 і 250.00 за якісну од. — тепер оплачується лише виготовлене (4 × 100).
    expect(closed.detail!.costs!.summary).toMatchObject({ total: "400.00", costPerGoodUnit: "100.00" });
    const html = await render(`/demo/production/${id}`, batchRoute());
    expect(html).toContain(esc(uk("production.totals.notProduced")));
    expect(html).toContain(cell(uk("production.lines.notProduced"), "6"));
    expect(html).not.toContain(esc(uk("production.totals.remaining")));
    expect(html).not.toContain(esc(uk("production.cost.totalPlanned")));
    expect(html).toContain(esc(uk("production.cost.perGoodUnit")));
    const listHtml = await render("/demo/production?tab=closed", listRoute());
    expect(listHtml).not.toContain(cell(uk("production.list.remaining"), "6"));
  });
});

describe("batch page: detail, actions and receipts", () => {
  it("staff detail: receipt form key, no cost data; owner: costs", async () => {
    setContext(STAFF);
    const data = await loadBatch(demoBatchId);
    expect(data.mode).toBe("view");
    expect(data.receiptKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(data.detail!.costs).toBeNull();
    expect(data.detail!.allowed).toMatchObject({ receive: true, close: true, start: false, edit: false });
    expect(JSON.stringify(data)).not.toMatch(COST_VALUES);
    const html = await render(`/demo/production/${demoBatchId}`, batchRoute());
    expect(html).toContain(esc(uk("production.receive.submit")));
    expect(html).not.toContain(esc(uk("production.cost.title")));
    expect(html).not.toContain(esc(uk("production.actions.close")));
    expect(html).not.toMatch(/21\s?600/);

    setContext(OWNER);
    const owner = await loadBatch(demoBatchId);
    expect(owner.detail!.costs!.summary).toMatchObject({ total: "21600.00", extraCost: "1500.00" });
    const ownerHtml = await render(`/demo/production/${demoBatchId}`, batchRoute());
    expect(ownerHtml).toContain(esc(uk("production.cost.title")));
    expect(ownerHtml).toContain(esc(uk("production.actions.close")));
    expect(await status(loadBatch("00000000-0000-4000-8000-000000000000"))).toBe(404);
    expect(await status(loadBatch("not-a-uuid"))).toBe(404);
  });

  it("staff receives via the form; double submit is harmless; over-receipt needs the flag", async () => {
    const holder = await variantId("OT-PH-WHT");
    const id = await createViaForm({ [`qty.${holder}`]: "10" });
    expect(await actBatch(id, { intent: "start", version: "1" })).toMatchObject({ ok: true, message: "production.result.started", params: { units: 10 } });
    expect(await actBatch(id, { intent: "start", version: "2" })).toMatchObject({ ok: false, error: "production.error.invalidStatus" });

    setContext(STAFF);
    expect(await actBatch(id, { intent: "close", version: "2" })).toEqual({ ok: false, error: "error.forbidden" });
    const data = await loadBatch(id);
    const lineId = data.detail!.lines[0]!.id;
    const stockItem = await ensureStockItemForVariant(env.handle.db, holder);
    const before = await getBalance(env.handle.db, stockItem);
    const form = { intent: "receive", receiptKey: data.receiptKey!, [`good.${lineId}`]: "7", [`defective.${lineId}`]: "1", [`reason.${lineId}`]: "тріщина", note: "Партія 1/2" };
    expect(await actBatch(id, form)).toMatchObject({ ok: true, message: "production.result.received", params: { good: 7, defective: 1, over: 0 } });
    expect(await actBatch(id, form)).toMatchObject({ ok: true, message: "production.result.receiptDuplicate", tone: "info" });
    const after = await getBalance(env.handle.db, stockItem);
    expect([after.onHand - before.onHand, after.defective - before.defective, after.inProduction - before.inProduction]).toEqual([7, 1, -8]);

    const next = await loadBatch(id);
    expect(next.receiptKey).not.toBe(data.receiptKey);
    expect(next.lastReceiptId).toBe(next.detail!.receipts[0]!.id);
    expect(next.detail!.receipts[0]!.lines[0]!.defectReason).toBe("тріщина");
    const over = await actBatch(id, { intent: "receive", receiptKey: next.receiptKey!, [`good.${lineId}`]: "3" });
    expect(over).toMatchObject({ ok: false, error: "production.error.overReceipt", params: { remaining: 2, requested: 3 } });
    expect(await actBatch(id, { intent: "receive", receiptKey: next.receiptKey!, [`good.${lineId}`]: "x" })).toMatchObject({
      fieldErrors: { [`good.${lineId}`]: "production.fieldError.invalidQuantity" },
    });
    const flagged = await actBatch(id, { intent: "receive", receiptKey: next.receiptKey!, [`good.${lineId}`]: "3", allowOver: "on" });
    expect(flagged).toMatchObject({ ok: true, params: { over: 1 }, extra: ["production.result.overReceived", "production.result.fullyReceived"] });
    expect((await getBalance(env.handle.db, stockItem)).inProduction).toBe(before.inProduction - 10);

    const html = await render(`/demo/production/${id}`, batchRoute());
    expect(html).toContain(esc(uk("production.receive.allReceived")));
    expect(html).toContain("тріщина");
    expect(html).toContain("Партія 1/2");

    setContext(OWNER);
    const v = (await batch(id)).version;
    expect(await actBatch(id, { intent: "close", version: String(v) })).toMatchObject({ ok: true, message: "production.result.closed", params: { units: 0 } });
  });

  it("receive the whole remainder; cancel a planned batch; owner updates costs", async () => {
    const grips = await variantId("OT-GR-BLK");
    const id = await createViaForm({ [`qty.${grips}`]: "5" });
    await actBatch(id, { intent: "start", version: "1" });
    setContext(STAFF);
    const data = await loadBatch(id);
    expect(await actBatch(id, { intent: "receiveRemaining", receiptKey: data.receiptKey!, note: "усе" })).toMatchObject({
      ok: true,
      params: { good: 5, defective: 0 },
    });
    expect((await batch(id)).status).toBe("received");

    setContext(OWNER);
    const planned = await createViaForm({ [`qty.${grips}`]: "1" });
    expect(await actBatch(planned, { intent: "cancel", version: "1" })).toMatchObject({ ok: true, message: "production.result.cancelled", params: { units: 0 } });
    expect((await batch(planned)).status).toBe("cancelled");

    const detail = await loadBatch(id);
    const lineId = detail.detail!.lines[0]!.id;
    expect(
      await actBatch(id, { intent: "updateCosts", version: String(detail.detail!.batch.version), extraCost: "10", costCurrency: "USD", [`lineCost.${lineId}`]: "2.00" }),
    ).toMatchObject({ ok: true, message: "production.result.costsUpdated" });
    expect((await loadBatch(id)).detail!.costs!.summary).toMatchObject({ total: "20.00", costPerGoodUnit: "4.00", currency: "USD" });
    setContext(MANAGER_NO_FINANCE);
    expect(await actBatch(id, { intent: "updateCosts", version: "1", extraCost: "", costCurrency: "UAH" })).toEqual({ ok: false, error: "error.forbidden" });
  });
});

import { and, eq, gt, sql } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import {
  inventoryMovements,
  jobs,
  orderLineItems,
  orders,
  packagingMaterials,
  productVariants,
  products,
  stockItems,
  stockReservations,
  warehouses,
} from "~/db/schema";
import { DEMO_MATERIAL_HISTORY, DEMO_PRODUCTION_HISTORY } from "~/db/seed/demo-history.server";
import { DEMO_MATERIALS } from "~/db/seed/demo-warehouse.server";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { STOCK_LEVEL_STATUSES } from "~/modules/inventory/alerts";
import { inventoryKeys } from "~/modules/inventory/keys";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { MOVEMENT_TYPES } from "~/modules/inventory/movement-types";
import {
  DEFECT_REASONS,
  ITEM_KINDS,
  RECEIPT_REASONS,
  STOCK_SORTS,
  STOCK_TRACKING_STATES,
  WAREHOUSE_RELATED_LINKS,
  WAREHOUSE_SECTION_LINKS,
  WRITE_OFF_REASONS,
} from "~/modules/warehouse/constants";
import { businessDayEnd, businessDayStart, parseIsoDate } from "~/modules/warehouse/dates";
import { newOperationId, receiveStock } from "~/modules/warehouse/operations.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Сторінки складу: «Залишки» (/warehouse, лист інвентаризації ?view=stocktake), картка позиції
 * (/warehouse/items/:id), історія руху (/warehouse/movements). Контекст запиту підмінено; база — PGlite (або
 * TEST_DATABASE_URL) з демо-даними (облік ініціалізовано).
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let stockPage: typeof import("~/pages/warehouse");
let itemPage: typeof import("~/pages/warehouse-item");
let historyPage: typeof import("~/pages/warehouse-movements");

beforeAll(async () => {
  env = await createTestEnv();
  stockPage = await import("~/pages/warehouse");
  itemPage = await import("~/pages/warehouse-item");
  historyPage = await import("~/pages/warehouse-movements");
});
afterAll(async () => {
  await env.close();
});

/** Режим контексту: передача в Shopify діє лише в робочому режимі (у демо Shopify не підключено). */
let ctxMode: "demo" | "production" = "demo";
function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), mode: ctxMode, basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

const BASE = "http://localhost/demo";
const NO_VIEW = makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["warehouse.view"] } });

const loadStock = (search = "") =>
  stockPage.loader({ request: new Request(`${BASE}/warehouse${search}`), params: {}, context: {} } as never);
const loadItem = (id: string) =>
  itemPage.loader({ request: new Request(`${BASE}/warehouse/items/${id}`), params: { stockItemId: id }, context: {} } as never);
const loadHistory = (search = "") =>
  historyPage.loader({ request: new Request(`${BASE}/warehouse/movements${search}`), params: {}, context: {} } as never);

function formOf(fields: Record<string, string | string[]>): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
  return body;
}
const actStock = (fields: Record<string, string | string[]>, search = "") =>
  stockPage.action({
    request: new Request(`${BASE}/warehouse${search}`, { method: "POST", body: formOf(fields) }),
    params: {},
    context: {},
  } as never);
const actItem = (id: string, fields: Record<string, string | string[]>) =>
  itemPage.action({
    request: new Request(`${BASE}/warehouse/items/${id}`, { method: "POST", body: formOf(fields) }),
    params: { stockItemId: id },
    context: {},
  } as never);

async function status(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

async function variantBySku(sku: string): Promise<string> {
  const [row] = await env.handle.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku));
  if (!row) throw new Error(`variant ${sku} not found`);
  return row.id;
}
const stockItemBySku = async (sku: string) => ensureStockItemForVariant(env.handle.db, await variantBySku(sku));

/**
 * Тимчасово інший режим передачі в Shopify (warehouse.shopifyPush). За замовчуванням — у робочому режимі контексту
 * (у демо передача не діє); { demo: true } — перевірка демо.
 */
async function withPushMode<T>(mode: "off" | "deltas", run: () => Promise<T>, opts: { demo?: boolean } = {}): Promise<T> {
  const current = await getSetting(env.handle.db, "warehouse");
  await updateSetting(env.handle.db, OWNER, "warehouse", { ...current, shopifyPush: mode });
  const actor = m.ctx?.actor ?? OWNER;
  ctxMode = opts.demo ? "demo" : "production";
  setContext(actor);
  try {
    return await run();
  } finally {
    ctxMode = "demo";
    setContext(m.ctx?.actor ?? actor);
    await updateSetting(env.handle.db, OWNER, "warehouse", current);
    await env.handle.db.delete(jobs).where(eq(jobs.type, "inventory.push"));
  }
}
const queuedPushJobs = async () =>
  (await env.handle.db.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.type, "inventory.push"), eq(jobs.status, "queued")))).length;

/** Серверний рендер сторінки в мінімальному дереві маршрутів (root → макет → сторінка). */
async function render(path: string, route: { loader: unknown; action: unknown; Component: unknown; path: string }): Promise<string> {
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
      children: [{ id: "routes/demo-layout", path: "demo", loader: () => shell, Component: Outlet, children: [{ id: "page", ...route }] }],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

const uk = (key: string) => DICTIONARIES.uk[key]!;
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

// ---------------------------------------------------------------------------

describe("stock list loader", () => {
  it("lists every demo variant with balances, available = on hand − reserved, Shopify value and status", async () => {
    const data = await loadStock();
    expect(data).toMatchObject({
      warehouseName: "Основний склад",
      initializedAt: expect.any(String),
      view: "list",
      total: 9,
      page: 1,
      pages: 1,
    });
    expect(data.rows).toHaveLength(9);
    for (const r of data.rows) {
      expect(r.available).toBe(r.onHand - r.reserved);
      expect(STOCK_LEVEL_STATUSES).toContain(r.status);
      expect(r.itemPath).toMatch(/^warehouse\/items\/[0-9a-f-]{36}$/);
    }
    const white = data.rows.find((r) => r.sku === "OT-PH-WHT")!;
    expect(white).toMatchObject({
      productTitle: "Тримач телефону Pro",
      variantTitle: "Білий",
      color: "Білий",
      inProduction: 50,
      tracking: "opened",
    });
    expect(white.shopifyAvailable).toBe(7);
    expect(white.imageUrl).toBeTruthy();
    expect(data.canAdjust).toBe(true);
    expect(data.opening.trackedVariants).toBe(9);
    expect(data.options.models).toEqual(expect.arrayContaining(["Model X", "Model S"]));
    expect(data.options.colors).toEqual(expect.arrayContaining(["Чорний", "Білий"]));
    const counts = data.statusCounts!;
    expect(STOCK_LEVEL_STATUSES.reduce((s, k) => s + counts[k], 0)).toBe(9);
  });

  it("filters by search (escaping wildcards), model, color, product, status and tracking", async () => {
    expect((await loadStock("?q=OT-GR")).rows.map((r) => r.sku).sort()).toEqual(["OT-GR-BLK", "OT-GR-GRY"]);
    expect((await loadStock("?q=%25")).total).toBe(0);
    expect((await loadStock("?model=Model%20X")).rows.map((r) => r.sku)).toEqual(["OT-FK-X"]);
    expect((await loadStock("?color=" + encodeURIComponent("Сірий"))).rows.map((r) => r.sku)).toEqual(["OT-GR-GRY"]);
    const [product] = await env.handle.db.select({ id: products.id }).from(products).where(eq(products.title, "Тримач телефону Pro"));
    expect((await loadStock(`?product=${product!.id}`)).rows.map((r) => r.sku).sort()).toEqual(["OT-PH-BLK", "OT-PH-WHT"]);
    const all = await loadStock();
    for (const s of STOCK_LEVEL_STATUSES) {
      const filtered = await loadStock(`?status=${s}`);
      expect(filtered.total).toBe(all.statusCounts![s]);
      for (const r of filtered.rows) expect(r.status).toBe(s);
    }
    expect((await loadStock("?tracking=untracked")).total).toBe(0);
    expect((await loadStock("?status=bogus&model=")).filters).toMatchObject({ status: null, model: null });
    expect((await loadStock("?q=OT")).isFiltered).toBe(true);
  });

  it("sorts and paginates past the end to the last page", async () => {
    const asc = (await loadStock("?sort=available_asc")).rows.map((r) => r.available);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    const desc = (await loadStock("?sort=on_hand_desc")).rows.map((r) => r.onHand);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    const bySku = (await loadStock("?sort=sku")).rows.map((r) => r.sku);
    expect(bySku).toEqual([...bySku].sort());
    const rank = { negative: 0, oversold: 1, out: 2, low: 3, ok: 4 } as const;
    const byStatus = (await loadStock("?sort=status")).rows.map((r) => rank[r.status]);
    expect(byStatus).toEqual([...byStatus].sort((a, b) => a - b));
    for (const s of STOCK_SORTS) expect((await loadStock(`?sort=${s}`)).total).toBe(9);
    expect((await loadStock("?page=99")).page).toBe(1);
  });

  it("summarizes open alerts with the most important product alerts first", async () => {
    const data = await loadStock();
    expect(data.alerts.materials).toBeGreaterThan(0); // демо: мало коробок L і болтів
    expect(data.alerts.total).toBe(Object.values(data.alerts.byKind).reduce((s, n) => s + n, 0));
    expect(data.alerts.top.length).toBeLessThanOrEqual(5);
  });

  it("staff can view (no adjust); without warehouse.view → 403", async () => {
    setContext(STAFF);
    const data = await loadStock();
    expect(data.canAdjust).toBe(false);
    expect(data.rows).toHaveLength(9);
    setContext(NO_VIEW);
    expect(await status(() => loadStock())).toBe(403);
    expect(await status(() => loadHistory())).toBe(403);
    expect(await status(() => loadItem(newOperationId()))).toBe(403);
  });

  it("stocktake sheet: selected items or the current filter, capped", async () => {
    const ids = [await variantBySku("OT-FK-X"), await variantBySku("OT-FK-S")];
    const sel = await loadStock(`?view=stocktake&items=${ids.join(",")},not-a-uuid`);
    expect(sel.view).toBe("stocktake");
    expect(sel.sheet).toMatchObject({ source: "selection", truncated: false });
    expect(sel.sheet!.rows.map((r) => r.sku).sort()).toEqual(["OT-FK-S", "OT-FK-X"]);
    const byFilter = await loadStock("?view=stocktake&q=OT-GR");
    expect(byFilter.sheet).toMatchObject({ source: "filter", total: 2 });
    expect(byFilter.operationIds.stocktake).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("stock list actions", () => {
  it("bulk threshold: owner sets/resets for selected variants (also never-moved ones); staff is forbidden", async () => {
    const a = await variantBySku("OT-BG-BLK");
    const b = await variantBySku("OT-LT-STD");
    const res = await actStock({ intent: "bulkThreshold", variantIds: [a, b, "bogus"], threshold: "40" });
    expect(res).toMatchObject({ ok: true, message: "warehouse.bulk.threshold.done", params: { count: 2, threshold: 40 } });
    const rows = (await loadStock("?q=OT-BG-BLK")).rows;
    expect(rows[0]).toMatchObject({ lowStockThreshold: 40, threshold: 40, status: "low" });
    expect(await actStock({ intent: "bulkThreshold", variantIds: [a, b], threshold: "" })).toMatchObject({
      ok: true,
      message: "warehouse.bulk.threshold.resetDone",
    });
    expect((await loadStock("?q=OT-BG-BLK")).rows[0]!.lowStockThreshold).toBeNull();
    expect(await actStock({ intent: "bulkThreshold", variantIds: [a, newOperationId()], threshold: "1" })).toMatchObject({
      ok: false,
      error: "error.notFound",
    });
    expect(await actStock({ intent: "bulkThreshold", variantIds: [], threshold: "1" })).toMatchObject({
      ok: false,
      error: "warehouse.error.noItems",
    });
    expect(await actStock({ intent: "bulkThreshold", variantIds: [a], threshold: "-3" })).toMatchObject({
      ok: false,
      error: "warehouse.error.threshold",
    });
    setContext(STAFF);
    expect(await actStock({ intent: "bulkThreshold", variantIds: [a], threshold: "3" })).toMatchObject({
      ok: false,
      error: "error.forbidden",
    });
  });

  it("stocktake sheet submit: one operation, skips empty counts, reports conflicts, double submit is a replay", async () => {
    const x = await variantBySku("OT-FK-X");
    const s = await variantBySku("OT-FK-S");
    const sheet = (await loadStock(`?view=stocktake&items=${x},${s}`)).sheet!;
    const rx = sheet.rows.find((r) => r.variantId === x)!;
    const rs = sheet.rows.find((r) => r.variantId === s)!;
    const operationId = newOperationId();
    const fields = {
      intent: "stocktake",
      operationId,
      item: [x, s],
      [`counted.${x}`]: String(rx.onHand + 2),
      [`expected.${x}`]: String(rx.onHand),
      [`counted.${s}`]: "",
      [`expected.${s}`]: String(rs.onHand),
    };
    // Залишок змінився, поки рахували → нічого не збережено, конфлікт показано для позиції.
    const stale = await actStock({ ...fields, [`expected.${x}`]: String(rx.onHand - 1) });
    expect(stale).toMatchObject({
      ok: false,
      error: "warehouse.error.stocktakeChanged",
      conflicts: [{ variantId: x, expected: rx.onHand - 1, current: rx.onHand }],
    });
    const ok = await actStock(fields);
    expect(ok).toMatchObject({ ok: true, message: "warehouse.stocktake.done", params: { counted: 1, changed: 1, added: 2, removed: 0 } });
    expect(await actStock(fields)).toMatchObject({ ok: true, message: "warehouse.op.replay" });
    const after = (await loadStock(`?view=stocktake&items=${x},${s}`)).sheet!.rows;
    expect(after.find((r) => r.variantId === x)!.onHand).toBe(rx.onHand + 2);
    expect(after.find((r) => r.variantId === s)!.onHand).toBe(rs.onHand);
    expect(await actStock({ ...fields, operationId: newOperationId(), [`counted.${x}`]: "" })).toMatchObject({
      ok: false,
      error: "warehouse.error.noCounts",
    });
    expect(await actStock({ ...fields, operationId: newOperationId(), [`counted.${x}`]: "1.5" })).toMatchObject({
      ok: false,
      error: "warehouse.error.countValue",
    });
    setContext(STAFF);
    expect(await actStock({ ...fields, operationId: newOperationId() })).toMatchObject({ ok: false, error: "error.forbidden" });
  });

  it("stocktake sheet resubmit: a corrected value in a saved sheet is rejected with the row highlighted; partial replay is reported", async () => {
    const x = await variantBySku("OT-BG-BLK");
    const s = await variantBySku("OT-LT-STD");
    const sheet = (await loadStock(`?view=stocktake&items=${x},${s}`)).sheet!;
    const rx = sheet.rows.find((r) => r.variantId === x)!;
    const rs = sheet.rows.find((r) => r.variantId === s)!;
    const operationId = newOperationId();
    const base = {
      intent: "stocktake",
      operationId,
      item: [x, s],
      [`expected.${x}`]: String(rx.onHand),
      [`expected.${s}`]: String(rs.onHand),
    };
    expect(await actStock({ ...base, [`counted.${x}`]: String(rx.onHand + 1), [`counted.${s}`]: "" })).toMatchObject({
      ok: true,
      message: "warehouse.stocktake.done",
    });
    // Відповідь загубилася; лист надіслано ще раз із виправленим значенням першої позиції й новою другою.
    const corrected = await actStock({ ...base, [`counted.${x}`]: String(rx.onHand + 3), [`counted.${s}`]: String(rs.onHand + 1) });
    expect(corrected).toMatchObject({
      ok: false,
      error: "warehouse.error.sheetAlreadySaved",
      params: { count: 1 },
      conflicts: [{ variantId: x, current: rx.onHand + 1, counted: rx.onHand + 3, alreadySaved: true }],
    });
    const mid = (await loadStock(`?view=stocktake&items=${x},${s}`)).sheet!.rows;
    expect(mid.find((r) => r.variantId === x)!.onHand).toBe(rx.onHand + 1);
    expect(mid.find((r) => r.variantId === s)!.onHand).toBe(rs.onHand);
    // Той самий лист без виправлення + нова позиція: нова записана, повтор показано в повідомленні.
    const partial = await actStock({ ...base, [`counted.${x}`]: String(rx.onHand + 1), [`counted.${s}`]: String(rs.onHand + 1) });
    expect(partial).toMatchObject({
      ok: true,
      message: "warehouse.stocktake.done",
      params: { counted: 1, changed: 1, replayed: 1 },
      extra: expect.arrayContaining(["warehouse.stocktake.doneReplayed"]),
    });
    expect((await loadStock(`?view=stocktake&items=${s}`)).sheet!.rows[0]!.onHand).toBe(rs.onHand + 1);
  });

  it("stocktake sheet with Shopify push on reports that the change goes to Shopify", async () => {
    const x = await variantBySku("OT-FK-S");
    const row = (await loadStock(`?view=stocktake&items=${x}`)).sheet!.rows[0]!;
    await withPushMode("deltas", async () => {
      const res = await actStock({
        intent: "stocktake",
        operationId: newOperationId(),
        item: [x],
        [`counted.${x}`]: String(row.onHand + 1),
        [`expected.${x}`]: String(row.onHand),
      });
      expect(res).toMatchObject({ ok: true, extra: expect.arrayContaining(["warehouse.op.pushQueued"]) });
      expect(await queuedPushJobs()).toBe(1);
    });
  });

  it("initialize: owner only; repeated run opens nothing new", async () => {
    const res = await actStock({ intent: "initialize" });
    expect(res).toMatchObject({ ok: true, message: "warehouse.init.result.nothing", params: { opened: 0, alreadyOpened: 9 } });
    setContext(STAFF);
    expect(await actStock({ intent: "initialize" })).toMatchObject({ ok: false, error: "error.forbidden" });
    setContext(NO_VIEW);
    expect(await actStock({ intent: "initialize" })).toMatchObject({ ok: false, error: "error.forbidden" });
    setContext(OWNER);
    expect(await actStock({ intent: "nope" })).toMatchObject({ ok: false, error: "error.generic" });
  });
});

describe("item card", () => {
  it("shows balances, reservations by order number, alerts and recent movements", async () => {
    const [reserved] = await env.handle.db
      .select({ stockItemId: stockReservations.stockItemId, orderNumber: orders.orderNumber })
      .from(stockReservations)
      .innerJoin(orders, eq(orders.id, stockReservations.orderId))
      .where(gt(stockReservations.reservedQty, 0))
      .limit(1);
    expect(reserved).toBeTruthy();
    const data = await loadItem(reserved!.stockItemId);
    expect(data.item).toMatchObject({ stockItemId: reserved!.stockItemId, kind: "product", tracking: "opened" });
    expect(data.item.available).toBe(data.item.onHand - data.item.reserved);
    expect(data.reservations.rows.map((r) => r.orderNumber)).toContain(reserved!.orderNumber);
    expect(data.reservations.totalQty).toBe(data.item.reserved);
    expect(data.movements.length).toBeGreaterThan(0);
    expect(data.movements[0]).not.toHaveProperty("customerName");
    expect(Object.values(data.operationIds).every((id) => /^[0-9a-f-]{36}$/.test(id))).toBe(true);
    expect(new Set(Object.values(data.operationIds)).size).toBe(Object.keys(data.operationIds).length);
  });

  it("opens by variant id when the variant never moved; unknown ids → 404", async () => {
    const [p] = await env.handle.db.insert(products).values({ title: "Новий товар", handle: "new-wh" }).returning({ id: products.id });
    const [v] = await env.handle.db
      .insert(productVariants)
      .values({ productId: p!.id, title: "Default Title", sku: "WH-NEW", price: "1.00", currency: "EUR", inventoryAvailable: 4 })
      .returning({ id: productVariants.id });
    const data = await loadItem(v!.id);
    expect(data.item).toMatchObject({
      stockItemId: null,
      variantId: v!.id,
      variantTitle: null,
      onHand: 0,
      tracking: "not_opened",
      shopifyAvailable: 4,
    });
    expect(data.movements).toEqual([]);
    // Перша операція створює позицію обліку.
    const res = await actItem(v!.id, {
      intent: "receive",
      operationId: data.operationIds.receive,
      quantity: "3",
      defectiveQuantity: "",
      reason: "purchase",
    });
    expect(res).toMatchObject({ ok: true, message: "warehouse.op.received", params: { onHand: 3 } });
    const [si] = await env.handle.db.select({ id: stockItems.id }).from(stockItems).where(eq(stockItems.variantId, v!.id));
    expect((await loadItem(si!.id)).item.onHand).toBe(3);
    expect(await status(() => loadItem(newOperationId()))).toBe(404);
    expect(await status(() => loadItem("not-a-uuid"))).toBe(404);
    // Новий варіант видно в «Залишках» як «не відкрито»; повторна ініціалізація відкриває його.
    expect((await loadStock("?tracking=not_opened")).rows.map((r) => r.sku)).toEqual(["WH-NEW"]);
    expect(await actStock({ intent: "initialize" })).toMatchObject({
      ok: true,
      message: "warehouse.init.result.opened",
      params: { opened: 1 },
    });
    expect((await loadItem(si!.id)).item).toMatchObject({ tracking: "opened", onHand: 3 + 4 });
  });

  it("works for packaging materials (by stock item or by material id before the first movement)", async () => {
    const [box] = await env.handle.db.select({ id: packagingMaterials.id }).from(packagingMaterials).where(eq(packagingMaterials.code, "box_m"));
    const [si] = await env.handle.db.select({ id: stockItems.id }).from(stockItems).where(eq(stockItems.materialId, box!.id));
    const card = await loadItem(si!.id);
    expect(card.item).toMatchObject({ kind: "material", materialKind: "box", unit: "pcs", tracking: null, sku: "box_m", onHand: 25 });
    expect((await loadItem(box!.id)).item.stockItemId).toBe(si!.id);
    const [fresh] = await env.handle.db
      .insert(packagingMaterials)
      .values({ code: "wh_test_tape", name: "Тестова стрічка", kind: "tape", unit: "m" })
      .returning({ id: packagingMaterials.id });
    const empty = await loadItem(fresh!.id);
    expect(empty.item).toMatchObject({ stockItemId: null, kind: "material", unit: "m", onHand: 0 });
    setContext(STAFF);
    expect(await actItem(fresh!.id, { intent: "receive", operationId: empty.operationIds.receive, quantity: "30", reason: "purchase" })).toMatchObject({
      ok: true,
      params: { onHand: 30 },
    });
    const [created] = await env.handle.db.select({ id: stockItems.id }).from(stockItems).where(eq(stockItems.materialId, fresh!.id));
    expect((await loadItem(created!.id)).item.onHand).toBe(30);
    const itemRoute = { path: "warehouse/items/:stockItemId", loader: itemPage.loader, action: itemPage.action, Component: itemPage.default };
    const html = await render(`/demo/warehouse/items/${created!.id}`, itemRoute);
    expect(html).toContain("wh_test_tape");
    expect(html).not.toContain(esc(uk("warehouse.item.reservations.title")));
  });

  it("actions: receive (double submit), defect, repair, count with conflict, threshold; staff limits", async () => {
    const id = await stockItemBySku("OT-GR-BLK");
    const start = (await loadItem(id)).item;
    setContext(STAFF);
    let data = await loadItem(id);
    expect(data.canSeeCosts).toBe(false);
    const receive = {
      intent: "receive",
      operationId: data.operationIds.receive,
      quantity: "4",
      defectiveQuantity: "1",
      reason: "customer_return",
      orderNumber: "1001",
    };
    expect(await actItem(id, receive)).toMatchObject({
      ok: true,
      message: "warehouse.op.received",
      params: { quantity: 4, damaged: 1, onHand: start.onHand + 4 },
    });
    expect(await actItem(id, receive)).toMatchObject({ ok: true, message: "warehouse.op.replay", tone: "info" });
    expect(await actItem(id, { ...receive, operationId: newOperationId(), orderNumber: "#99999" })).toMatchObject({
      ok: false,
      error: "warehouse.error.orderNotFound",
      fieldErrors: { orderNumber: "warehouse.error.orderNotFound" },
    });
    expect(await actItem(id, { ...receive, operationId: newOperationId(), unitCost: "5.00", costCurrency: "EUR" })).toMatchObject({
      ok: false,
      error: "error.forbidden",
    });
    expect(await actItem(id, { ...receive, operationId: newOperationId(), quantity: "abc" })).toMatchObject({
      ok: false,
      error: "warehouse.error.quantity",
    });

    data = await loadItem(id);
    expect(data.item.defective).toBe(start.defective + 1);
    expect(
      await actItem(id, { intent: "defect", operationId: data.operationIds.defect, quantity: "2", reason: "damaged_in_warehouse" }),
    ).toMatchObject({
      ok: true,
      message: "warehouse.op.defectMarked",
      params: { defective: start.defective + 3 },
    });
    expect(await actItem(id, { intent: "repair", operationId: data.operationIds.repair, quantity: "1" })).toMatchObject({
      ok: true,
      message: "warehouse.op.repaired",
    });
    for (const intent of ["writeOff", "count", "threshold"]) {
      expect(
        await actItem(id, { intent, operationId: newOperationId(), quantity: "1", reason: "lost", counted: "1", threshold: "1" }),
      ).toMatchObject({
        ok: false,
        error: "error.forbidden",
      });
    }

    setContext(OWNER);
    data = await loadItem(id);
    expect(data.canSeeCosts).toBe(true);
    const onHand = data.item.onHand;
    expect(
      await actItem(id, {
        intent: "count",
        operationId: data.operationIds.count,
        counted: String(onHand - 1),
        expected: String(onHand + 5),
      }),
    ).toMatchObject({
      ok: false,
      error: "warehouse.error.stocktakeChanged",
    });
    expect(
      await actItem(id, { intent: "count", operationId: data.operationIds.count, counted: String(onHand - 1), expected: String(onHand) }),
    ).toMatchObject({
      ok: true,
      message: "warehouse.op.counted",
      params: { previous: onHand, counted: onHand - 1, delta: "−1" },
    });
    expect(
      await actItem(id, { intent: "count", operationId: newOperationId(), counted: String(onHand - 1), expected: String(onHand - 1) }),
    ).toMatchObject({
      ok: true,
      message: "warehouse.op.countedSame",
    });
    expect(
      await actItem(id, { intent: "writeOff", operationId: data.operationIds.writeOff, quantity: "1", reason: "disposed" }),
    ).toMatchObject({
      ok: true,
      message: "warehouse.op.writtenOff",
    });
    expect(await actItem(id, { intent: "threshold", threshold: "15" })).toMatchObject({
      ok: true,
      message: "warehouse.op.thresholdSet",
      params: { threshold: 15 },
    });
    expect((await loadItem(id)).item).toMatchObject({ lowStockThreshold: 15, threshold: 15 });
    expect(await actItem(id, { intent: "threshold", threshold: "" })).toMatchObject({ ok: true, message: "warehouse.op.thresholdReset" });
    expect(await actItem(id, { intent: "threshold", threshold: "x" })).toMatchObject({ ok: false, error: "warehouse.error.threshold" });
    expect(await actItem(id, { intent: "bogus" })).toMatchObject({ ok: false, error: "error.generic" });
    expect(await actItem(newOperationId(), { intent: "repair", operationId: newOperationId(), quantity: "1" })).toMatchObject({
      ok: false,
      error: "error.notFound",
    });
    const last = (await loadItem(id)).lastStocktake;
    expect(last).toMatchObject({ actorName: OWNER.displayName, delta: 0 });
  });
});

describe("item card: customer returns and Shopify", () => {
  it("a customer return is not sent to Shopify by default; the checkbox sends it; other reasons always go", async () => {
    const id = await stockItemBySku("OT-PH-BLK");
    await withPushMode("deltas", async () => {
      setContext(STAFF);
      let data = await loadItem(id);
      expect(data.pushesToShopify).toBe(true);
      const restocked = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "1",
        reason: "customer_return",
      });
      expect(restocked).toMatchObject({ ok: true, message: "warehouse.op.received", extra: ["warehouse.op.returnNotPushed"] });
      expect(await queuedPushJobs()).toBe(0);
      data = await loadItem(id);
      expect(data.movements[0]).toMatchObject({ type: "receipt_manual", reason: "customer_return", shopifySyncState: "skipped" });

      const sent = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "1",
        reason: "customer_return",
        pushToShopify: "on",
      });
      expect(sent).toMatchObject({ ok: true, extra: ["warehouse.op.pushQueued"] });
      expect(await queuedPushJobs()).toBe(1);
      data = await loadItem(id);
      expect(data.movements[0]).toMatchObject({ reason: "customer_return", shopifySyncState: "pending" });

      const purchase = await actItem(id, { intent: "receive", operationId: data.operationIds.receive, quantity: "1", reason: "purchase" });
      expect(purchase).toMatchObject({ ok: true, extra: ["warehouse.op.pushQueued"] });
    });
    setContext(OWNER);
    expect((await loadItem(id)).pushesToShopify).toBe(false); // передачу вимкнено (типово)
  });

  it("demo with «send changes» on: no «will be sent to Shopify» claim, nothing queued (e2e-5)", async () => {
    const id = await stockItemBySku("OT-PH-BLK");
    await withPushMode(
      "deltas",
      async () => {
        let data = await loadItem(id);
        expect(data.pushesToShopify).toBe(false);
        const res = await actItem(id, { intent: "receive", operationId: data.operationIds.receive, quantity: "1", reason: "purchase" });
        expect(res).toMatchObject({ ok: true, message: "warehouse.op.received" });
        expect((res as { extra?: string[] }).extra ?? []).not.toContain("warehouse.op.pushQueued");
        expect(await queuedPushJobs()).toBe(0);
        data = await loadItem(id);
        expect(data.movements[0]).toMatchObject({ reason: "purchase", shopifySyncState: "skipped" });

        // Повернення покупця в демо: жодного тексту про Shopify («Повернення не надсилається в Shopify…», N3) —
        // ні для власника, ні для працівника; з прапорцем «надіслати» — теж нічого не ставиться в чергу.
        for (const actor of [OWNER, STAFF]) {
          setContext(actor);
          data = await loadItem(id);
          const ret = await actItem(id, { intent: "receive", operationId: data.operationIds.receive, quantity: "1", reason: "customer_return" });
          expect(ret, actor.role).toMatchObject({ ok: true, message: "warehouse.op.received" });
          expect((ret as { extra?: string[] }).extra ?? [], actor.role).toEqual([]);
          data = await loadItem(id);
          const forced = await actItem(id, {
            intent: "receive",
            operationId: data.operationIds.receive,
            quantity: "1",
            reason: "customer_return",
            pushToShopify: "on",
          });
          expect((forced as { extra?: string[] }).extra ?? [], actor.role).toEqual([]);
          expect(await queuedPushJobs()).toBe(0);
        }
        setContext(OWNER);
      },
      { demo: true },
    );
  });

  it("receipt cost currency defaults to the cost currency (UAH), not the selling currency; then the item's last cost currency (e2e-2)", async () => {
    const id = await stockItemBySku("OT-FK-S");
    const [variant] = await env.handle.db
      .select({ currency: productVariants.currency })
      .from(productVariants)
      .where(eq(productVariants.sku, "OT-FK-S"));
    expect(variant!.currency).not.toBe("UAH"); // демо продає в EUR
    const [last] = await env.handle.db
      .select({ c: inventoryMovements.costCurrency })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.stockItemId, id), sql`${inventoryMovements.unitCost} is not null`))
      .limit(1);
    if (!last) expect((await loadItem(id)).item.defaultCostCurrency).toBe("UAH");
    await receiveStock(env.ctx(OWNER), {
      operationId: newOperationId(),
      stockItemId: id,
      quantity: 1,
      reason: "purchase",
      unitCost: "3.50",
      costCurrency: "PLN",
    });
    expect((await loadItem(id)).item.defaultCostCurrency).toBe("PLN");
    // Працівник не бачить поля собівартості — і валюти останньої собівартості теж.
    setContext(STAFF);
    expect((await loadItem(id)).item.defaultCostCurrency).toBe("UAH");
    setContext(OWNER);
  });
});

describe("movement history", () => {
  it("filters by type, item, order, actor, kind and date; paginates", async () => {
    const all = await loadHistory();
    expect(all.total).toBeGreaterThan(0);
    const reserves = await loadHistory("?type=reserve");
    expect(reserves.rows.length).toBeGreaterThan(0);
    for (const r of reserves.rows) expect(r.type).toBe("reserve");
    const item = await stockItemBySku("OT-GR-BLK");
    const forItem = await loadHistory(`?item=${item}`);
    expect(forItem.itemLabel).toMatchObject({ stockItemId: item, sku: "OT-GR-BLK" });
    for (const r of forItem.rows) expect(r.stockItemId).toBe(item);
    const bySku = await loadHistory("?q=OT-GR-BLK");
    expect(bySku.total).toBe(forItem.total);
    const order = await loadHistory("?order=1001");
    expect(order.orderRef).toMatchObject({ orderNumber: "#1001" });
    for (const r of order.rows) expect(r.orderNumber).toBe("#1001");
    expect(order.rows.length).toBeGreaterThan(0);
    const orderId = await env.orderId("#1001");
    expect((await loadHistory(`?orderId=${orderId}`)).total).toBe(order.total);
    const missing = await loadHistory("?order=%2399999");
    expect(missing).toMatchObject({ orderMissing: true, total: 0 });
    const byActor = await loadHistory(`?actor=${STAFF.id}`);
    expect(byActor.rows.length).toBeGreaterThan(0);
    for (const r of byActor.rows) expect(r.actorId).toBe(STAFF.id);
    expect(byActor.actors.map((a) => a.id)).toContain(STAFF.id);
    const materials = await loadHistory("?kind=material");
    for (const r of materials.rows) expect(r.itemKind).toBe("material");
    // Дата за Києвом: сьогодні є рухи, завтра — немає. Рухи вигаданої історії демо (виробництво, витрата матеріалів,
    // db/seed/demo-history.server.ts) — у минулих днях: «сьогодні» + «до вчора» = усі.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
    const yesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(Date.now() - 24 * 3600 * 1000));
    const todayTotal = (await loadHistory(`?from=${today}&to=${today}`)).total;
    const earlierTotal = (await loadHistory(`?to=${yesterday}`)).total;
    expect(todayTotal).toBeGreaterThan(0);
    // У минулих днях — рівно рухи історії: запуск кожної позиції, надходження кожного рядка, списання кожного рядка з
    // браком, витрата матеріалів і перенесені назад opening матеріалів (opening товарів — сьогодні, як знімок).
    const plans = DEMO_PRODUCTION_HISTORY;
    const historyMovements =
      plans.reduce((s, b) => s + b.lines.length, 0) +
      plans.reduce((s, b) => s + b.receipts.reduce((n, r) => n + r.lines.length, 0), 0) +
      plans.reduce((s, b) => s + b.receipts.reduce((n, r) => n + r.lines.filter((l) => (l.defective ?? 0) > 0).length, 0), 0) +
      DEMO_MATERIAL_HISTORY.reduce((s, d) => s + Object.keys(d.use).length, 0) +
      DEMO_MATERIALS.length;
    expect(historyMovements).toBe(5 + 6 + 3 + 44 + 9);
    expect(earlierTotal).toBe(historyMovements);
    expect(todayTotal + earlierTotal).toBe(all.total);
    const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date(Date.now() + 36 * 3600 * 1000));
    expect((await loadHistory(`?from=${tomorrow}`)).total).toBe(0);
    expect((await loadHistory("?from=2026-02-30")).filters.from).toBeNull();
    expect((await loadHistory("?page=999")).page).toBe(all.pages);
    expect((await loadHistory("?q=zzz-none")).total).toBe(0);
  });

  it("old demo movements marked «pending» are shown as «not sent» in demo, unchanged in production (e2e-5)", async () => {
    const item = await stockItemBySku("OT-GR-BLK");
    const r = await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId: item, quantity: 1, reason: "purchase" });
    const [before] = await env.handle.db.select({ s: inventoryMovements.shopifySyncState }).from(inventoryMovements).where(eq(inventoryMovements.id, r.movementId));
    // Як у демо-базі, створеній до правила movementOptionsFor.
    await env.handle.db.update(inventoryMovements).set({ shopifySyncState: "pending" }).where(eq(inventoryMovements.id, r.movementId));
    try {
      const inDemo = await loadHistory(`?movement=${r.movementId}`);
      expect(inDemo.rows.map((x) => x.shopifySyncState)).toEqual(["skipped"]);
      expect((await loadItem(item)).movements.find((x) => x.id === r.movementId)?.shopifySyncState).toBe("skipped");
      ctxMode = "production";
      setContext();
      expect((await loadHistory(`?movement=${r.movementId}`)).rows.map((x) => x.shopifySyncState)).toEqual(["pending"]);
    } finally {
      ctxMode = "demo";
      setContext();
      await env.handle.db.update(inventoryMovements).set({ shopifySyncState: before!.s }).where(eq(inventoryMovements.id, r.movementId));
    }
  });

  it("?movement=<id> (Shopify referenceDocumentUri) shows exactly that movement and keeps the link (ui-6)", async () => {
    const item = await stockItemBySku("OT-LT-STD");
    const ops = [newOperationId(), newOperationId()];
    for (const operationId of ops) {
      await receiveStock(env.ctx(OWNER), { operationId, stockItemId: item, quantity: 1, reason: "purchase" });
    }
    const ids: string[] = [];
    for (const operationId of ops) {
      const [mv] = await env.handle.db
        .select({ id: inventoryMovements.id })
        .from(inventoryMovements)
        .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(operationId)));
      ids.push(mv!.id);
    }
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv" }).format(new Date());
    // Посилання як у movementReferenceUri: item + type + день + movement.
    const sameDay = await loadHistory(`?item=${item}&type=receipt_manual&from=${today}&to=${today}`);
    expect(sameDay.rows.filter((r) => ids.includes(r.id))).toHaveLength(2);
    const linked = await loadHistory(`?item=${item}&type=receipt_manual&from=${today}&to=${today}&movement=${ids[1]}`);
    expect(linked.rows.map((r) => r.id)).toEqual([ids[1]]);
    expect(linked.total).toBe(1);
    expect(linked.filters.movement).toBe(ids[1]);
    expect(linked.movementMissing).toBe(false);
    expect(linked.isFiltered).toBe(true);
    // Невідомий id → порожньо з попередженням; некоректний — ігнорується.
    const unknown = await loadHistory(`?movement=00000000-0000-4000-8000-000000000000`);
    expect(unknown).toMatchObject({ total: 0, movementMissing: true });
    expect((await loadHistory("?movement=not-a-uuid")).filters.movement).toBeNull();
    // Сторінка зберігає параметр у посиланнях і пропонує скинути його.
    const historyRoute = { path: "warehouse/movements", loader: historyPage.loader, action: undefined, Component: historyPage.default };
    const html = await render(`/demo/warehouse/movements?item=${item}&from=${today}&to=${today}&movement=${ids[1]}`, historyRoute);
    expect(html).toContain(esc(uk("warehouse.history.forMovement")));
    expect(html).toContain(esc(uk("warehouse.history.clearMovementDay")));
    expect(html).toContain(`name="movement" value="${ids[1]}"`);
  });

  it("unit cost is returned only with finance.view", async () => {
    const item = await stockItemBySku("OT-LT-STD");
    const operationId = newOperationId();
    await receiveStock(env.ctx(OWNER), {
      operationId,
      stockItemId: item,
      quantity: 1,
      reason: "purchase",
      unitCost: "7.25",
      costCurrency: "EUR",
    });
    const [mv] = await env.handle.db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(operationId)));
    const owner = await loadHistory(`?item=${item}`);
    expect(owner.canSeeCosts).toBe(true);
    expect(owner.rows.find((r) => r.id === mv!.id)).toMatchObject({ unitCost: "7.25", costCurrency: "EUR" });
    setContext(STAFF);
    const staff = await loadHistory(`?item=${item}`);
    expect(staff.canSeeCosts).toBe(false);
    expect(staff.rows.find((r) => r.id === mv!.id)).toMatchObject({ unitCost: null, costCurrency: null });
    const card = await loadItem(item);
    expect(card.movements.every((r) => r.unitCost === null)).toBe(true);
  });
});

describe("dates (Europe/Kyiv)", () => {
  it("day boundaries follow Kyiv time including DST", () => {
    expect(businessDayStart("2026-11-27").toISOString()).toBe("2026-11-26T22:00:00.000Z");
    expect(businessDayEnd("2026-11-27").toISOString()).toBe("2026-11-27T21:59:59.999Z");
    expect(businessDayStart("2026-07-01").toISOString()).toBe("2026-06-30T21:00:00.000Z");
    // Перехід на літній час 29.03.2026: доба коротша.
    expect(businessDayEnd("2026-03-29").getTime() - businessDayStart("2026-03-29").getTime()).toBe(23 * 3600 * 1000 - 1);
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate(" 2026-01-05 ")).toBe("2026-01-05");
  });
});

describe("rendering", () => {
  it("stock list renders for owner (bulk + initialization) and staff (read-only)", async () => {
    const route = { path: "warehouse", loader: stockPage.loader, action: stockPage.action, Component: stockPage.default };
    const owner = await render("/demo/warehouse", route);
    expect(owner).toContain(esc(uk("warehouse.bulk.title")));
    expect(owner).toContain(esc(uk("warehouse.stock.col.shopify")));
    expect(owner).toContain("OT-PH-WHT");
    expect(owner).toContain('href="/demo/warehouse/movements"');
    expect(owner).toContain('href="/demo/warehouse/materials"');
    setContext(STAFF);
    const staff = await render("/demo/warehouse", route);
    expect(staff).not.toContain(esc(uk("warehouse.bulk.title")));
    expect(staff).not.toContain(esc(uk("warehouse.init.button")));
    expect(staff).toContain("OT-PH-WHT");
  });

  it("stocktake sheet renders inputs for each row", async () => {
    const route = { path: "warehouse", loader: stockPage.loader, action: stockPage.action, Component: stockPage.default };
    const x = await variantBySku("OT-FK-X");
    const html = await render(`/demo/warehouse?view=stocktake&items=${x}`, route);
    expect(html).toContain(`name="counted.${x}"`);
    expect(html).toContain(esc(uk("warehouse.stocktake.submit")));
  });

  it("stocktake sheet tells to count packed parcels and shows reserved units per row", async () => {
    const route = { path: "warehouse", loader: stockPage.loader, action: stockPage.action, Component: stockPage.default };
    const reservedRow = (await loadStock()).rows.find((r) => r.reserved > 0);
    expect(reservedRow).toBeDefined();
    const html = await render(`/demo/warehouse?view=stocktake&items=${reservedRow!.variantId}`, route);
    expect(html).toContain(esc(uk("warehouse.stocktake.helpPacked")));
    expect(uk("warehouse.stocktake.help")).toMatch(/запакован/);
    expect(html).toContain(esc(uk("warehouse.stocktake.reservedNote").replace("{reserved}", String(reservedRow!.reserved))));
  });

  it("stock list keeps the Shopify value on phones and explains it in visible text", async () => {
    const route = { path: "warehouse", loader: stockPage.loader, action: stockPage.action, Component: stockPage.default };
    const html = await render("/demo/warehouse", route);
    expect(html).not.toContain("ot-dt__cell--hide-mobile");
    // Демо: Shopify не оновлюється — демо-легенда (робочий режим — tests/pages/warehouse-demo-sync.test.ts).
    expect(html).toContain(esc(uk("warehouse.stock.shopify.demoLegend")));
  });

  it("receive form offers 'send this return to Shopify' only when changes of this item go to Shopify", async () => {
    const id = await stockItemBySku("OT-GR-GRY");
    const itemRoute = {
      path: "warehouse/items/:stockItemId",
      loader: itemPage.loader,
      action: itemPage.action,
      Component: itemPage.default,
    };
    expect(await render(`/demo/warehouse/items/${id}`, itemRoute)).not.toContain('name="pushToShopify"');
    await withPushMode("deltas", async () => {
      expect(await render(`/demo/warehouse/items/${id}`, itemRoute)).toContain('name="pushToShopify"');
    });
  });

  it("item card renders operations by permission; history hides the cost column from staff", async () => {
    const id = await stockItemBySku("OT-GR-GRY");
    const itemRoute = {
      path: "warehouse/items/:stockItemId",
      loader: itemPage.loader,
      action: itemPage.action,
      Component: itemPage.default,
    };
    const owner = await render(`/demo/warehouse/items/${id}`, itemRoute);
    expect(owner).toContain(esc(uk("warehouse.op.receive.title")));
    expect(owner).toContain(esc(uk("warehouse.op.count.title")));
    expect(owner).toContain(esc(uk("warehouse.op.receive.unitCost")));
    setContext(STAFF);
    const staff = await render(`/demo/warehouse/items/${id}`, itemRoute);
    expect(staff).toContain(esc(uk("warehouse.op.receive.title")));
    expect(staff).not.toContain(esc(uk("warehouse.op.count.title")));
    expect(staff).not.toContain(esc(uk("warehouse.op.receive.unitCost")));
    const historyRoute = { path: "warehouse/movements", loader: historyPage.loader, action: undefined, Component: historyPage.default };
    expect(await render("/demo/warehouse/movements", historyRoute)).not.toContain(esc(uk("warehouse.history.col.unitCost")));
    setContext(OWNER);
    expect(await render("/demo/warehouse/movements", historyRoute)).toContain(esc(uk("warehouse.history.col.unitCost")));
  });
});

describe("i18n families used dynamically by warehouse pages", () => {
  it("every dynamic key exists in uk and en", () => {
    const keys = [
      ...STOCK_TRACKING_STATES.flatMap((s) => [
        `warehouse.tracking.${s}`,
        `warehouse.tracking.${s}.help`,
        `warehouse.tracking.${s}.filter`,
      ]),
      ...STOCK_SORTS.map((s) => `warehouse.sort.${s}`),
      ...[...RECEIPT_REASONS, ...DEFECT_REASONS, ...WRITE_OFF_REASONS, "stocktake", "repaired"].map((r) => `warehouse.reason.${r}`),
      ...ITEM_KINDS.map((k) => `warehouse.history.kind.${k}`),
      ...STOCK_LEVEL_STATUSES.map((s) => `stockLevel.${s}`),
      ...MOVEMENT_TYPES.map((t) => `movementType.${t}`),
      ...WAREHOUSE_SECTION_LINKS.map((l) => l.labelKey),
      ...WAREHOUSE_RELATED_LINKS.map((l) => l.labelKey),
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Повернення покупця: пошкоджені одиниці (R1) і підказки замовлення (R2)
// ---------------------------------------------------------------------------

describe("item card: damaged customer returns and order suggestions", () => {
  const itemRoute = () => ({ path: "warehouse/items/:stockItemId", loader: itemPage.loader, action: itemPage.action, Component: itemPage.default });
  const extraOf = (r: unknown) => ((r as { extra?: string[] }).extra ?? []).slice().sort();

  it("R1: a damaged return restocked in Shopify says the damaged units leave Shopify's available — no contradictory «will be sent»", async () => {
    const id = await stockItemBySku("OT-PH-WHT");
    await withPushMode("deltas", async () => {
      setContext(STAFF);
      let data = await loadItem(id);
      expect(data.pushesToShopify).toBe(true);
      const res = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "1",
        defectiveQuantity: "1",
        reason: "customer_return",
      });
      expect(res).toMatchObject({ ok: true, message: "warehouse.op.received", params: { quantity: 1, damaged: 1 } });
      expect(extraOf(res)).toEqual(["warehouse.op.returnDamagedPushed", "warehouse.op.returnNotPushed"]);
      expect(await queuedPushJobs()).toBe(1);
      data = await loadItem(id);
      const recent = data.movements.slice(0, 2);
      expect(recent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "receipt_manual", onHandDelta: 2, defectiveDelta: 0, shopifySyncState: "skipped" }),
          expect.objectContaining({ type: "defect_mark", onHandDelta: -1, defectiveDelta: 1, reason: "customer_return", shopifySyncState: "pending" }),
        ]),
      );
      // Лише пошкоджені — те саме.
      const damagedOnly = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "0",
        defectiveQuantity: "1",
        reason: "customer_return",
      });
      expect(extraOf(damagedOnly)).toEqual(["warehouse.op.returnDamagedPushed", "warehouse.op.returnNotPushed"]);
      // «Надіслати в Shopify» (без поповнення в Shopify): як раніше — надходження надсилається, брак одразу в брак.
      data = await loadItem(id);
      const sent = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "1",
        defectiveQuantity: "1",
        reason: "customer_return",
        pushToShopify: "on",
      });
      expect(extraOf(sent)).toEqual(["warehouse.op.pushQueued"]);
    });
    // Тексти зрозумілі з параметрами дії.
    expect(uk("warehouse.op.returnDamagedPushed").replace("{damaged}", "1")).toContain("(1)");
    expect(uk("warehouse.op.receive.pushReturnHelp")).not.toMatch(/не повертайте/);
    setContext(OWNER);
  });

  it("R1 demo: no Shopify texts for a damaged return, nothing queued", async () => {
    const id = await stockItemBySku("OT-PH-WHT");
    await withPushMode(
      "deltas",
      async () => {
        const data = await loadItem(id);
        const res = await actItem(id, {
          intent: "receive",
          operationId: data.operationIds.receive,
          quantity: "1",
          defectiveQuantity: "1",
          reason: "customer_return",
        });
        expect(res).toMatchObject({ ok: true, message: "warehouse.op.received" });
        expect(extraOf(res)).toEqual([]);
        expect(await queuedPushJobs()).toBe(0);
      },
      { demo: true },
    );
  });

  it("R2: suggests recently returned orders not yet received (order number only, links only with orders.view); the number stays optional", async () => {
    const db = env.handle.db;
    const id = await stockItemBySku("OT-GR-BLK");
    const [variant] = await db.select({ variantId: stockItems.variantId }).from(stockItems).where(eq(stockItems.id, id));
    const [order] = await db.select().from(orders).where(eq(orders.orderNumber, "#0997"));
    const [line] = await db
      .select()
      .from(orderLineItems)
      .where(and(eq(orderLineItems.orderId, order!.id), eq(orderLineItems.variantId, variant!.variantId!)));
    expect(line).toBeDefined();
    const [warehouse] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isDefault, true));
    const shopifyUpdatedAt = order!.shopifyUpdatedAt;
    // Передано (списано 2) і повністю повернено/відшкодовано в Shopify (вигадані дані).
    const existing = await db.select({ id: stockReservations.id }).from(stockReservations).where(eq(stockReservations.orderLineItemId, line!.id));
    expect(existing).toEqual([]);
    const [reservation] = await db
      .insert(stockReservations)
      .values({ orderLineItemId: line!.id, orderId: order!.id, stockItemId: id, warehouseId: warehouse!.id, reservedQty: 0, consumedQty: line!.quantity, status: "consumed" })
      .returning({ id: stockReservations.id });
    await db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.id, line!.id));
    await db.update(orders).set({ shopifyUpdatedAt: new Date() }).where(eq(orders.id, order!.id));
    const units = line!.quantity;
    try {
      setContext(OWNER);
      let data = await loadItem(id);
      expect(data.returnSuggestions).toEqual([{ orderNumber: "#0997", units, orderId: order!.id }]);
      let html = await render(`/demo/warehouse/items/${id}`, itemRoute());
      expect(html).toContain(esc(uk("warehouse.op.receive.orderHint")));
      expect(html).toContain(esc(uk("warehouse.op.receive.suggestions")));
      expect(html).toContain(esc(uk("warehouse.op.receive.suggestion").replace("{order}", "#0997").replace("{count}", String(units))));
      expect(html).toContain(`aria-label="${esc(uk("warehouse.op.receive.useSuggestion").replace("{order}", "#0997").replace("{count}", String(units)))}"`);
      expect(html).toContain(`href="/demo/orders/${order!.id}"`);
      // Без персональних даних покупця.
      for (const pd of [order!.shipFirstName, order!.shipLastName, order!.email, order!.shipCity]) if (pd) expect(html).not.toContain(esc(pd));

      // Працівник без доступу до замовлень бачить номер, але не посилання.
      const noOrders = makeActor({ id: "staff-no-orders", displayName: "Склад", role: "staff", overrides: { revoke: ["orders.view"] } });
      setContext(noOrders);
      data = await loadItem(id);
      expect(data.returnSuggestions).toEqual([{ orderNumber: "#0997", units, orderId: null }]);
      html = await render(`/demo/warehouse/items/${id}`, itemRoute());
      expect(html).toContain(esc(uk("warehouse.op.receive.suggestion").replace("{order}", "#0997").replace("{count}", String(units))));
      expect(html).not.toContain(`/demo/orders/${order!.id}`);
      // Без права оприбутковувати — форми й підказок немає.
      const viewOnly = makeActor({ id: "staff-view-only", displayName: "Перегляд", role: "staff", overrides: { revoke: ["warehouse.receive"] } });
      setContext(viewOnly);
      expect((await loadItem(id)).returnSuggestions).toEqual([]);

      setContext(STAFF);
      // Номер не обов'язковий: повернення без замовлення приймається й не «закриває» підказку (невідомо, чиє воно).
      data = await loadItem(id);
      expect(await actItem(id, { intent: "receive", operationId: data.operationIds.receive, quantity: "1", reason: "customer_return" })).toMatchObject({
        ok: true,
        message: "warehouse.op.received",
      });
      data = await loadItem(id);
      expect(data.returnSuggestions).toEqual([{ orderNumber: "#0997", units, orderId: order!.id }]);
      // Повернення з цим замовленням зменшує, а потім знімає підказку.
      expect(
        await actItem(id, { intent: "receive", operationId: data.operationIds.receive, quantity: "1", reason: "customer_return", orderNumber: "#0997" }),
      ).toMatchObject({ ok: true });
      data = await loadItem(id);
      expect(data.returnSuggestions).toEqual(units > 1 ? [{ orderNumber: "#0997", units: units - 1, orderId: order!.id }] : []);
      if (units > 1) {
        await actItem(id, {
          intent: "receive",
          operationId: data.operationIds.receive,
          quantity: String(units - 2),
          defectiveQuantity: "1",
          reason: "customer_return",
          orderNumber: "0997",
        });
        data = await loadItem(id);
        expect(data.returnSuggestions).toEqual([]);
      }
      html = await render(`/demo/warehouse/items/${id}`, itemRoute());
      expect(html).toContain(esc(uk("warehouse.op.receive.orderHint")));
      expect(html).not.toContain(esc(uk("warehouse.op.receive.suggestions")));
    } finally {
      setContext(OWNER);
      await db.delete(stockReservations).where(eq(stockReservations.id, reservation!.id));
      await db.update(orderLineItems).set({ currentQuantity: line!.currentQuantity }).where(eq(orderLineItems.id, line!.id));
      await db.update(orders).set({ shopifyUpdatedAt }).where(eq(orders.id, order!.id));
    }
  });

  it("R2: a material or an item without Shopify returns gets the hint but no suggestions", async () => {
    const [box] = await env.handle.db.select({ id: stockItems.id }).from(stockItems).where(eq(stockItems.kind, "material")).limit(1);
    expect((await loadItem(box!.id)).returnSuggestions).toEqual([]);
    expect((await loadItem(await stockItemBySku("OT-FK-X"))).returnSuggestions).toEqual([]);
  });

  it("NI-2: «the damaged units were not restocked in Shopify» records one receipt, sends nothing and says so", async () => {
    const id = await stockItemBySku("OT-BG-BLK");
    const movementsByKey = async (operationId: string) =>
      env.handle.db
        .select({ type: inventoryMovements.type, onHandDelta: inventoryMovements.onHandDelta, defectiveDelta: inventoryMovements.defectiveDelta, state: inventoryMovements.shopifySyncState })
        .from(inventoryMovements)
        .where(sql`${inventoryMovements.idempotencyKey} in (${inventoryKeys.manual(operationId)}, ${inventoryKeys.manual(operationId, "return_defect")})`);
    await withPushMode("deltas", async () => {
      setContext(STAFF);
      let data = await loadItem(id);
      expect(data.pushesToShopify).toBe(true);
      let operationId = data.operationIds.receive;
      const res = await actItem(id, {
        intent: "receive",
        operationId,
        quantity: "1",
        defectiveQuantity: "1",
        reason: "customer_return",
        damagedNotRestocked: "on",
      });
      expect(res).toMatchObject({ ok: true, message: "warehouse.op.received", params: { quantity: 1, damaged: 1 } });
      expect(extraOf(res)).toEqual(["warehouse.op.returnDamagedKept", "warehouse.op.returnNotPushed"]);
      expect(await queuedPushJobs()).toBe(0);
      expect(await movementsByKey(operationId)).toEqual([{ type: "receipt_manual", onHandDelta: 1, defectiveDelta: 1, state: "skipped" }]);
      // Лише пошкоджені: надходження без зміни on_hand — нічого не надсилається й «не надсилається» не потрібне.
      data = await loadItem(id);
      operationId = data.operationIds.receive;
      const damagedOnly = await actItem(id, {
        intent: "receive",
        operationId,
        quantity: "0",
        defectiveQuantity: "1",
        reason: "customer_return",
        damagedNotRestocked: "on",
      });
      expect(extraOf(damagedOnly)).toEqual(["warehouse.op.returnDamagedKept"]);
      expect(await queuedPushJobs()).toBe(0);
      expect(await movementsByKey(operationId)).toEqual([{ type: "receipt_manual", onHandDelta: 0, defectiveDelta: 1, state: "none" }]);
      // «Надіслати це повернення в Shopify» має перевагу: якісні надсилаються, пошкоджені — у браку (як раніше).
      data = await loadItem(id);
      const sent = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "1",
        defectiveQuantity: "1",
        reason: "customer_return",
        pushToShopify: "on",
        damagedNotRestocked: "on",
      });
      expect(extraOf(sent)).toEqual(["warehouse.op.pushQueued"]);
      // Без позначки — як у R1 (брак знімається з Shopify).
      data = await loadItem(id);
      const all = await actItem(id, { intent: "receive", operationId: data.operationIds.receive, quantity: "1", defectiveQuantity: "1", reason: "customer_return" });
      expect(extraOf(all)).toEqual(["warehouse.op.returnDamagedPushed", "warehouse.op.returnNotPushed"]);
    });
    // Тексти: підказка до «надіслати» більше не вимагає поповнювати в Shopify все повернення; новий вибір пояснено.
    expect(uk("warehouse.op.receive.pushReturnHelp")).not.toMatch(/повертайте на склад усе/);
    expect(DICTIONARIES.en["warehouse.op.receive.pushReturnHelp"]).not.toMatch(/restock the whole return/);
    expect(uk("warehouse.op.receive.damagedNotRestockedHelp")).toMatch(/лише якісні/);
    expect(uk("warehouse.op.returnDamagedKept").replace("{damaged}", "1")).toContain("(1)");
    setContext(OWNER);
  });

  it("NI-3: a return with damaged units recorded with «send to Shopify» clears the order suggestion", async () => {
    const db = env.handle.db;
    const id = await stockItemBySku("OT-PH-BLK");
    const [variant] = await db.select({ variantId: stockItems.variantId }).from(stockItems).where(eq(stockItems.id, id));
    const [order] = await db.select().from(orders).where(eq(orders.orderNumber, "#0996"));
    const [line] = await db
      .select()
      .from(orderLineItems)
      .where(and(eq(orderLineItems.orderId, order!.id), eq(orderLineItems.variantId, variant!.variantId!)));
    expect(line).toBeDefined();
    expect(await db.select({ id: stockReservations.id }).from(stockReservations).where(eq(stockReservations.orderLineItemId, line!.id))).toEqual([]);
    const [warehouse] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isDefault, true));
    const shopifyUpdatedAt = order!.shopifyUpdatedAt;
    // Вигадані дані: позицію списано (передано) і повністю повернено/відшкодовано в Shopify.
    const [reservation] = await db
      .insert(stockReservations)
      .values({ orderLineItemId: line!.id, orderId: order!.id, stockItemId: id, warehouseId: warehouse!.id, reservedQty: 0, consumedQty: line!.quantity, status: "consumed" })
      .returning({ id: stockReservations.id });
    await db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.id, line!.id));
    await db.update(orders).set({ shopifyUpdatedAt: new Date() }).where(eq(orders.id, order!.id));
    try {
      setContext(STAFF);
      let data = await loadItem(id);
      expect(data.returnSuggestions).toEqual([{ orderNumber: "#0996", units: line!.quantity, orderId: order!.id }]);
      // Усе повернення — пошкоджене, «надіслати в Shopify» (у брак, без розділення): отримано все.
      const res = await actItem(id, {
        intent: "receive",
        operationId: data.operationIds.receive,
        quantity: "0",
        defectiveQuantity: String(line!.quantity),
        reason: "customer_return",
        orderNumber: "#0996",
        pushToShopify: "on",
      });
      expect(res).toMatchObject({ ok: true, message: "warehouse.op.received" });
      data = await loadItem(id);
      expect(data.returnSuggestions).toEqual([]);
    } finally {
      setContext(OWNER);
      await db.delete(stockReservations).where(eq(stockReservations.id, reservation!.id));
      await db.update(orderLineItems).set({ currentQuantity: line!.currentQuantity }).where(eq(orderLineItems.id, line!.id));
      await db.update(orders).set({ shopifyUpdatedAt }).where(eq(orders.id, order!.id));
    }
  });
});

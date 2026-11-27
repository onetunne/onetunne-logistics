import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { ActionResult } from "~/components/action-banner";
import type { DatabaseHandle } from "~/db/client.server";
import { inventoryConflicts, jobs, productVariants, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { INVENTORY_SYNC_JOB } from "~/modules/inventory-sync/jobs";
import { RECONCILE_OUTCOMES } from "~/modules/inventory-sync/reconcile.server";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { RequestContext } from "~/server/types";
import { gqlProduct } from "../stage2/fixtures";
import { OWNER, STAFF, openTestDatabase } from "../helpers";
import { apply, balance } from "./helpers";
import { LOC, fakeInventoryAdmin, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Сторінка «Склад → Shopify» (/app/warehouse/shopify): права в loader/action, розбіжності з фільтрами, дії власника,
 * демо (пояснення + відмова дій), SSR-рендер. Контекст запиту й клієнт Admin API підмінено.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null, admin: null as AdminGraphql | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));
vi.mock("~/integrations/shopify/admin-client.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/integrations/shopify/admin-client.server")>();
  return {
    ...actual,
    adminClientFor: async () => {
      if (!m.admin) throw new Error("admin is not set");
      return m.admin;
    },
  };
});

const SHOP = "ot-page.myshopify.com";
const NO_VIEW = makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["warehouse.view"] } });

let db: DatabaseHandle;
let fake: FakeInventoryAdmin;
let page: typeof import("~/pages/inventory-sync");
const items: Array<{ stockItemId: string; gid: string; variantId: string }> = [];

function setContext(actor: Actor = OWNER, mode: "production" | "demo" = "production") {
  m.ctx = {
    mode,
    db: db.db,
    actor,
    carriers: createDemoCarriers(db.db),
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
    basePath: mode === "demo" ? "/demo" : "/app",
    locale: "uk",
  };
}

beforeAll(async () => {
  db = await openTestDatabase();
  await seedReferenceData(db.db, DEMO_SETTINGS);
  await db.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_products,read_inventory,write_inventory" });
  for (let n = 1; n <= 3; n++) await upsertProduct(db.db, mapProduct(gqlProduct(n)), "EUR");
  setContext();
  await initializeInventory(m.ctx!);
  fake = fakeInventoryAdmin();
  m.admin = fake.admin;
  for (let n = 1; n <= 3; n++) {
    const [v] = await db.db
      .select({ id: productVariants.id, gid: productVariants.inventoryItemId })
      .from(productVariants)
      .where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
    items.push({ variantId: v!.id, gid: v!.gid!, stockItemId: await ensureStockItemForVariant(db.db, v!.id) });
    fake.setLevel(v!.gid!, { available: 12, onHand: 12, committed: 0 });
  }
  // Моделі для фільтра (варіанти тестових товарів мають колір Black).
  await db.db.update(productVariants).set({ model: "Phantom" }).where(eq(productVariants.id, items[0]!.variantId));
  await db.db.update(productVariants).set({ model: "Falcon", color: "White" }).where(eq(productVariants.id, items[1]!.variantId));
  page = await import("~/pages/inventory-sync");
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => setContext());

const URL_BASE = "http://localhost/app/warehouse/shopify";
const load = (search = "") => page.loader({ request: new Request(`${URL_BASE}${search}`), params: {}, context: {} } as never);
async function act(fields: Record<string, string | string[]>): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
  return page.action({ request: new Request(URL_BASE, { method: "POST", body }), params: {}, context: {} } as never);
}
async function openConflictId(i: number) {
  const [row] = await db.db
    .select({ id: inventoryConflicts.id })
    .from(inventoryConflicts)
    .where(and(eq(inventoryConflicts.stockItemId, items[i]!.stockItemId), eq(inventoryConflicts.status, "open")));
  return row?.id ?? null;
}

async function render(path: string): Promise<string> {
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: "layout",
          path: path.startsWith("/demo") ? "demo" : "app",
          Component: Outlet,
          children: [{ id: "page", path: "warehouse/shopify", loader: page.loader, action: page.action, Component: page.default }],
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

const uk = (key: string) => DICTIONARIES.uk[key]!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

describe("loader", () => {
  it("requires warehouse.view; staff sees the page read-only", async () => {
    setContext(NO_VIEW);
    await expect(load()).rejects.toMatchObject({ status: 403 });
    setContext(STAFF);
    const data = await load();
    expect(data.permissions).toEqual({ adjust: false, location: false });
    expect(data.overview.shop).toBe(SHOP);
  });

  it("shows sync status, Shopify locations and discrepancies with status/model/color/search filters", async () => {
    fake.setLevel(items[0]!.gid, { available: 10, onHand: 10 });
    fake.setLevel(items[1]!.gid, { available: 15, onHand: 15 });
    const r1 = await act({ intent: "reconcileItem", stockItemId: items[0]!.stockItemId });
    expect(r1).toMatchObject({ ok: true, message: "inventorySync.result.reconciledItem", extra: ["inventorySync.outcome.opened"] });
    await act({ intent: "reconcileItem", stockItemId: items[1]!.stockItemId });
    const data = await load();
    expect(data.mode).toBe("production");
    expect(data.overview).toMatchObject({ canRead: true, canWrite: true, pushMode: "off", locationId: LOC, locationAutoSelected: true });
    expect(data.locations).toEqual([{ id: LOC, name: "Склад Київ", fulfillsOnlineOrders: true }]);
    expect(data.conflicts.map((c) => c.diff).sort()).toEqual([-2, 3]);
    expect(data.facets.models).toEqual(["Falcon", "Phantom"]);
    expect((await load("?model=Phantom")).conflicts.map((c) => c.diff)).toEqual([-2]);
    expect((await load("?color=White")).conflicts.map((c) => c.diff)).toEqual([3]);
    expect((await load("?q=SKU-2")).conflicts.map((c) => c.diff)).toEqual([3]);
    expect((await load("?status=resolved")).conflicts).toEqual([]);
    expect((await load("?status=bogus")).filters.status).toBe("open");
  });
});

describe("actions", () => {
  it("checks permissions on the server for every intent", async () => {
    setContext(STAFF);
    const id = (await openConflictId(0))!;
    const cases: Array<Record<string, string | string[]>> = [
      { intent: "accept", conflictId: id },
      { intent: "pushApp", conflictId: id },
      { intent: "dismiss", conflictId: id, note: "x" },
      { intent: "bulkAccept", ids: [id] },
      { intent: "reconcileAll" },
      { intent: "reconcileItem", stockItemId: items[0]!.stockItemId },
      { intent: "pushNow" },
      { intent: "setLocation", locationId: LOC },
      { intent: "confirmLocation" },
    ];
    for (const fields of cases) {
      expect(await act(fields), String(fields.intent)).toEqual({ ok: false, error: "error.forbidden" });
    }
    expect(await act({ intent: "nope" })).toEqual({ ok: false, error: "error.generic" });
  });

  it("owner resolves discrepancies: accept, push app value, dismiss, bulk accept", async () => {
    const c0 = (await openConflictId(0))!;
    expect(await act({ intent: "accept", conflictId: c0 })).toMatchObject({ ok: true, message: "inventorySync.result.accepted", params: { diff: "−2" } });
    expect((await balance(db.db, items[0]!.stockItemId)).onHand).toBe(10);
    expect(await act({ intent: "accept", conflictId: c0 })).toMatchObject({ ok: true, message: "inventorySync.result.already" });

    const c1 = (await openConflictId(1))!;
    expect(await act({ intent: "dismiss", conflictId: c1, note: "" })).toEqual({ ok: false, error: "inventorySync.noteRequired", params: {} });
    expect(await act({ intent: "pushApp", conflictId: c1 })).toMatchObject({ ok: true, message: "inventorySync.result.pushed", params: { delta: "−3" } });
    expect(fake.levels.get(items[1]!.gid)!.available).toBe(12);

    fake.setLevel(items[2]!.gid, { available: 8, onHand: 8 });
    await act({ intent: "reconcileItem", stockItemId: items[2]!.stockItemId });
    const c2 = (await openConflictId(2))!;
    expect(await act({ intent: "bulkAccept", ids: [c2] })).toMatchObject({
      ok: true,
      message: "inventorySync.result.bulkAccepted",
      params: { accepted: 1, units: "−4", stale: 0 },
    });
    expect(await act({ intent: "bulkAccept", ids: [] })).toMatchObject({ ok: false, error: "inventorySync.nothingSelected" });

    fake.setLevel(items[2]!.gid, { available: 9, onHand: 9 });
    await act({ intent: "reconcileItem", stockItemId: items[2]!.stockItemId });
    expect(await act({ intent: "dismiss", conflictId: (await openConflictId(2))!, note: "Перевірено" })).toMatchObject({
      ok: true,
      message: "inventorySync.result.dismissed",
    });
    const resolved = await load("?status=resolved");
    expect(resolved.conflicts.map((c) => c.status).sort()).toEqual(["accepted_shopify", "accepted_shopify", "dismissed", "pushed_app"]);
    // Посилання з історії залишків Shopify (referenceDocumentUri «надіслати склад») відкриває саме цю розбіжність.
    const single = await load(`?conflict=${c1}`);
    expect(single.filters.conflict).toBe(c1);
    expect(single.conflicts.map((c) => [c.id, c.status])).toEqual([[c1, "pushed_app"]]);
    expect((await load("?conflict=not-a-uuid")).filters.conflict).toBeNull();
  });

  it("queues reconciliation and push, and lets the owner confirm or change the location", async () => {
    expect(await act({ intent: "reconcileAll" })).toMatchObject({ ok: true, message: "inventorySync.result.reconcileQueued" });
    expect(await act({ intent: "reconcileAll" })).toMatchObject({ ok: true, message: "inventorySync.result.reconcileAlreadyQueued" });
    const queued = await db.db.select().from(jobs).where(eq(jobs.type, INVENTORY_SYNC_JOB.reconcile));
    expect(queued.some((j) => (j.payload as { scope?: string }).scope === "all")).toBe(true);
    // Передачу вимкнено: дія не надсилає, а лише ставить завдання, що позначить очікувані рухи skipped.
    expect(await act({ intent: "pushNow" })).toMatchObject({ ok: true, message: "inventorySync.result.pendingWillBeSkipped" });
    const current = await getSetting(db.db, "warehouse");
    await updateSetting(db.db, OWNER, "warehouse", { ...current, shopifyPush: "deltas" });
    expect(await act({ intent: "pushNow" })).toMatchObject({ ok: true, message: "inventorySync.result.pushQueued" });

    expect(await act({ intent: "confirmLocation" })).toMatchObject({ ok: true, message: "inventorySync.result.locationConfirmed" });
    expect((await load()).overview).toMatchObject({ locationAutoSelected: false, locationConfirmation: { actorId: OWNER.id } });
    expect(await act({ intent: "setLocation", locationId: "gid://shopify/Location/404" })).toMatchObject({ ok: false, error: "inventorySync.locationInvalid" });
    expect(await act({ intent: "setLocation", locationId: LOC })).toMatchObject({ ok: true, message: "inventorySync.result.locationSet", params: { name: "Склад Київ" } });
  });

  it("every result/outcome key exists in both locales", () => {
    const keys = [
      ...RECONCILE_OUTCOMES.map((o) => `inventorySync.outcome.${o}`),
      ...["accepted", "already", "stale", "needs_reconcile", "pushed", "inProgress", "unknown", "dismissed", "bulkAccepted"].map((k) => `inventorySync.result.${k}`),
      ...["open", "accepted_shopify", "pushed_app", "dismissed"].map((s) => `inventorySync.conflictStatus.${s}`),
      ...["accepted_shopify", "pushed_app", "dismissed", "auto_resolved", "auto_applied"].map((s) => `inventorySync.resolution.${s}`),
      "inventorySync.overview.pushMode.off",
      "inventorySync.overview.pushMode.deltas",
      "inventorySync.overview.externalMode.review",
      "inventorySync.overview.externalMode.apply",
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });
});

describe("demo and rendering", () => {
  it("demo: the page explains and actions refuse with a clear message", async () => {
    setContext(OWNER, "demo");
    const id = (await openConflictId(0)) ?? "00000000-0000-4000-8000-000000000000";
    expect(await act({ intent: "accept", conflictId: id })).toEqual({ ok: false, error: "inventorySync.demoUnavailable", params: {} });
    expect(await act({ intent: "reconcileAll" })).toEqual({ ok: false, error: "inventorySync.demoUnavailable", params: {} });
    const html = await render("/demo/warehouse/shopify");
    expect(html).toContain(esc(uk("inventorySync.demo")));
    expect(html).not.toContain(esc(uk("inventorySync.action.reconcileAll")));
  });

  it("renders the production page with status, discrepancies and owner actions", async () => {
    fake.setLevel(items[0]!.gid, { available: 7, onHand: 7 });
    await act({ intent: "reconcileItem", stockItemId: items[0]!.stockItemId });
    const html = await render("/app/warehouse/shopify");
    for (const key of ["inventorySync.title", "inventorySync.overview.title", "inventorySync.conflicts.title", "inventorySync.action.accept", "inventorySync.action.pushApp", "inventorySync.bulk.button", "inventorySync.action.reconcileAll"]) {
      expect(html, key).toContain(esc(uk(key)));
    }
    expect(html).toContain("Склад Київ");
    expect(html).toContain("−3");
    setContext(STAFF);
    const staffHtml = await render("/app/warehouse/shopify");
    expect(staffHtml).not.toContain(esc(uk("inventorySync.bulk.button")));
    expect(staffHtml).not.toContain(`value="accept"`);
  });

  it("without write_inventory «send warehouse» is hidden; pending changes can still be processed (marked not sent)", async () => {
    await db.db.update(shopInstallations).set({ scopes: "read_products,read_inventory" });
    try {
      // Рух, що чекає передачі (передачу ввімкнено, але дозволу немає).
      const current = await getSetting(db.db, "warehouse");
      await updateSetting(db.db, OWNER, "warehouse", { ...current, shopifyPush: "deltas" });
      const { applied } = await apply(db.db, { stockItemId: items[2]!.stockItemId, type: "receipt_manual", idempotencyKey: `manual:${crypto.randomUUID()}`, onHandDelta: 1 });
      expect(applied[0]!.shopifySyncState).toBe("pending");
      const html = await render("/app/warehouse/shopify");
      expect(html).toContain(`value="accept"`);
      expect(html).not.toContain(`value="pushApp"`);
      expect(html).toContain(esc(uk("inventorySync.action.pushApp.noScope")));
      expect(html).toContain(esc(uk("inventorySync.action.skipPending")));
      expect(await act({ intent: "pushNow" })).toMatchObject({ ok: true, message: "inventorySync.result.pendingWillBeSkipped" });
    } finally {
      await db.db.update(shopInstallations).set({ scopes: "read_products,read_inventory,write_inventory" });
    }
  });
});

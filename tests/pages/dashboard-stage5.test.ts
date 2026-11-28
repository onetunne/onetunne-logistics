import { and, eq, inArray } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { packagingMaterials, stockAlerts, stockItems } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { ensureStockItemForMaterial } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Головна (gap-10): сигнали етапу 5 поза розділом «Склад» — відкриті попередження складу, черга пакування,
 * партії до готовності. Кожен блок — лише з відповідним дозволом. Контекст запиту підмінено; база — PGlite з демо-даними.
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

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/dashboard");
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

const load = () => page.loader({ request: new Request("http://localhost/demo"), params: {}, context: {} } as never);
const NO_WAREHOUSE = makeActor({ id: "no-wh", displayName: "No warehouse", role: "staff", overrides: { revoke: ["warehouse.view"] } });
const NO_PACKING = makeActor({ id: "no-pack", displayName: "No packing", role: "staff", overrides: { revoke: ["packing.perform"] } });
const NEITHER = makeActor({ id: "none", displayName: "None", role: "staff", overrides: { revoke: ["warehouse.view", "packing.perform"] } });

describe("dashboard: stage-5 signals", () => {
  it("owner and staff see warehouse alerts, the packing queue and production due dates", async () => {
    for (const actor of [OWNER, STAFF]) {
      setContext(actor);
      const data = await load();
      expect(data.warehouse).not.toBeNull();
      expect(data.warehouse!.alerts).toMatchObject({ total: expect.any(Number), byKind: expect.any(Object), materials: expect.any(Number) });
      expect(data.warehouse!.alerts!.top.length).toBeLessThanOrEqual(3);
      expect(data.warehouse!.production).toMatchObject({ active: expect.any(Number), overdue: expect.any(Number), dueSoon: expect.any(Number) });
      expect(data.warehouse!.production!.active).toBeGreaterThanOrEqual(1); // демо-партія
      expect(typeof data.warehouse!.packingQueue).toBe("number");
      // Без собівартості й персональних даних.
      expect(JSON.stringify(data.warehouse)).not.toMatch(/unitCost|customer|email|phone/i);
    }
  });

  it("each block follows its permission", async () => {
    setContext(NO_WAREHOUSE);
    let data = await load();
    expect(data.warehouse).toMatchObject({ alerts: null, production: null, packingQueue: expect.any(Number) });
    setContext(NO_PACKING);
    data = await load();
    expect(data.warehouse).toMatchObject({ packingQueue: null });
    expect(data.warehouse!.alerts).not.toBeNull();
    setContext(NEITHER);
    expect((await load()).warehouse).toBeNull();
  });

  it("renders the section with links to stock, the queue and batches", async () => {
    const html = await renderDashboard();
    expect(html).toContain(DICTIONARIES.uk["dashboard.stage5.title"]!);
    expect(html).toContain('href="/demo/picking"');
    expect(html).toMatch(/href="\/demo\/production(\?overdue=1)?"/);
    expect(html).toMatch(/href="\/demo\/warehouse(\?status=(out|low))?"/);
  });

  it("with only packaging-material alerts open, the card does not say «no open alerts» (N4)", async () => {
    const db = env.handle.db;
    // Тимчасово: жодного відкритого попередження товару, одне відкрите попередження матеріалу.
    const productAlertIds = (
      await db
        .select({ id: stockAlerts.id })
        .from(stockAlerts)
        .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
        .where(and(eq(stockAlerts.status, "open"), eq(stockItems.kind, "product")))
    ).map((r) => r.id);
    if (productAlertIds.length > 0) {
      await db.update(stockAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(inArray(stockAlerts.id, productAlertIds));
    }
    const [material] = await db.select({ id: packagingMaterials.id }).from(packagingMaterials).limit(1);
    const materialItemId = await ensureStockItemForMaterial(db, material!.id);
    const warehouse = await getDefaultWarehouse(db);
    const [existing] = await db
      .select({ id: stockAlerts.id })
      .from(stockAlerts)
      .where(and(eq(stockAlerts.stockItemId, materialItemId), eq(stockAlerts.kind, "low_stock"), eq(stockAlerts.status, "open")));
    const [inserted] = existing
      ? [null]
      : await db.insert(stockAlerts).values({ stockItemId: materialItemId, warehouseId: warehouse.id, kind: "low_stock" }).returning({ id: stockAlerts.id });
    try {
      const data = await load();
      expect(data.warehouse!.alerts).toMatchObject({ total: 0, materials: expect.any(Number) });
      expect(data.warehouse!.alerts!.materials).toBeGreaterThan(0);
      for (const locale of ["uk", "en"] as const) {
        const html = await renderDashboard(locale);
        expect(html, locale).not.toContain(DICTIONARIES[locale]["dashboard.stage5.alerts.none"]!);
        expect(html, locale).toContain(DICTIONARIES[locale]["dashboard.stage5.alerts.noneProducts"]!);
        expect(html, locale).toContain('href="/demo/warehouse/materials"');
      }
    } finally {
      if (inserted) await db.delete(stockAlerts).where(eq(stockAlerts.id, inserted.id));
      if (productAlertIds.length > 0) {
        await db.update(stockAlerts).set({ status: "open", resolvedAt: null }).where(inArray(stockAlerts.id, productAlertIds));
      }
    }
    // Без жодних попереджень (і матеріалів теж) — звичайне «немає».
    const allOpen = (await db.select({ id: stockAlerts.id }).from(stockAlerts).where(eq(stockAlerts.status, "open"))).map((r) => r.id);
    if (allOpen.length > 0) await db.update(stockAlerts).set({ status: "resolved", resolvedAt: new Date() }).where(inArray(stockAlerts.id, allOpen));
    try {
      const html = await renderDashboard();
      expect(html).toContain(DICTIONARIES.uk["dashboard.stage5.alerts.none"]!);
      expect(html).not.toContain(DICTIONARIES.uk["dashboard.stage5.alerts.noneProducts"]!);
    } finally {
      if (allOpen.length > 0) await db.update(stockAlerts).set({ status: "open", resolvedAt: null }).where(inArray(stockAlerts.id, allOpen));
    }
  });
});

/** SSR головної для власника (демо-оболонка) у вибраній мові. */
async function renderDashboard(locale: "uk" | "en" = "uk"): Promise<string> {
  const actor = OWNER;
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale };
  {
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
        loader: () => ({ locale }),
        Component: Outlet,
        children: [
          {
            id: "routes/demo-layout",
            path: "demo",
            loader: () => shell,
            Component: Outlet,
            children: [{ id: "page", index: true, loader: page.loader, action: page.action, Component: page.default }],
          },
        ],
      },
    ];
    const handler = createStaticHandler(routes as never);
    const context = await handler.query(new Request("http://localhost/demo"));
    if (context instanceof Response) throw new Error("unexpected response");
    expect(context.errors).toBeNull();
    return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
  }
}

describe("main menu «Аналітика» (gap-16)", () => {
  const loadPlanned = async (section: string) => {
    const planned = await import("~/pages/planned");
    return planned.loader({ request: new Request(`http://localhost/demo/${section}`), params: { section }, context: {} } as never);
  };
  const loadAnalytics = async () => {
    const analytics = await import("~/pages/analytics");
    return analytics.loader({ request: new Request("http://localhost/demo/analytics"), params: {}, context: {} } as never);
  };

  // Етап 6 (WP0, docs/stage6-design.md §14.2, §18.1): «Аналітика» реалізована (finance.view, fallbackToRelated) — сторінка
  // «Заплановано» її більше не обслуговує; працівника з warehouse.view пряма адреса веде на аналітику складу, без нього — 403.
  it("staff with warehouse.view is sent to Warehouse → Analytics; the planned page no longer serves «Аналітика»", async () => {
    setContext(STAFF);
    const redirected = await loadAnalytics().catch((e: unknown) => e);
    expect(redirected).toBeInstanceOf(Response);
    expect((redirected as Response).status).toBe(302);
    expect((redirected as Response).headers.get("Location")).toBe("/demo/warehouse/analytics");
    setContext(NO_WAREHOUSE);
    expect(((await loadAnalytics().catch((e: unknown) => e)) as Response).status).toBe(403);
    setContext(OWNER);
    expect(await loadAnalytics()).toMatchObject({ demo: true });
    for (const section of ["analytics", "returns", "finance"]) {
      expect(((await loadPlanned(section).catch((e: unknown) => e)) as Response).status, section).toBe(404);
    }
    for (const l of ["uk", "en"] as const) {
      expect(DICTIONARIES[l]["warehouseAnalytics.planned.link"]).toBeTruthy();
      expect(DICTIONARIES[l]["warehouseAnalytics.planned.description"]).toBeTruthy();
    }
  });
});

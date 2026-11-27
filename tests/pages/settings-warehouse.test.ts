import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { and, count, eq, isNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { stockAlerts, stockItems } from "~/db/schema";
import { PERMISSIONS } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { resetEnvCache } from "~/lib/env.server";
import { getSetting } from "~/modules/settings/settings.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Налаштування складу (етап 5, /demo/settings → «Склад»): збереження лише власником, перевірка значень,
 * переоцінка попереджень після зміни загального порогу, відображення розділу.
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };
let page: typeof import("~/pages/settings");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/settings");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

const URL_ = "http://localhost/demo/settings";
type Fields = Record<string, string>;

async function headers(role: "owner" | "staff"): Promise<HeadersInit> {
  return { Cookie: await demoRoleCookie.serialize(role) };
}
async function load(role: "owner" | "staff" = "owner") {
  return page.loader({ request: new Request(URL_, { headers: await headers(role) }), params: {}, context: {} } as never);
}
function formData(fields: Fields): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return body;
}
async function act(fields: Fields, role: "owner" | "staff" = "owner") {
  const request = new Request(URL_, { method: "POST", body: formData(fields), headers: await headers(role) });
  return page.action({ request, params: {}, context: {} } as never);
}
const db = async () => (await getDemoRuntime()).handle.db;

async function openLowAlertsWithoutOwnThreshold(): Promise<number> {
  const [row] = await (await db())
    .select({ c: count() })
    .from(stockAlerts)
    .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
    .where(and(eq(stockAlerts.status, "open"), isNull(stockItems.lowStockThreshold)));
  return Number(row?.c ?? 0);
}

const fields = (version: number, over: Fields = {}): Fields => ({
  intent: "saveWarehouse",
  expectedVersion: String(version),
  lowStockThreshold: "5",
  productionLeadDays: "30",
  targetCoverDays: "60",
  batchRounding: "10",
  shopifyPush: "off",
  externalShopifyChanges: "review",
  allowNegativeOnHand: "on",
  ...over,
});

describe("settings → warehouse", () => {
  it("owner saves all fields; checkboxes and selects are read correctly", async () => {
    const { version } = (await load()).warehouse;
    const r = await act(
      fields(version, { productionLeadDays: "21", targetCoverDays: "90", batchRounding: "25", shopifyPush: "deltas", externalShopifyChanges: "apply" }),
    );
    expect(r).toMatchObject({ ok: true, intent: "saveWarehouse" });
    expect(await getSetting(await db(), "warehouse")).toMatchObject({
      lowStockThreshold: 5,
      productionLeadDays: 21,
      targetCoverDays: 90,
      batchRounding: 25,
      shopifyPush: "deltas",
      externalShopifyChanges: "apply",
      allowNegativeOnHand: true,
    });
    // Знятий прапорець (поля немає у формі) → false; повернення до безпечних значень.
    const v2 = (await load()).warehouse.version;
    const { allowNegativeOnHand: _drop, ...withoutCheckbox } = fields(v2);
    expect(await act(withoutCheckbox)).toMatchObject({ ok: true });
    expect(await getSetting(await db(), "warehouse")).toMatchObject({ shopifyPush: "off", externalShopifyChanges: "review", allowNegativeOnHand: false });
  });

  it("validates ranges and unknown modes; nothing is saved", async () => {
    const { version } = (await load()).warehouse;
    const bad = await act(
      fields(version, { lowStockThreshold: "-1", productionLeadDays: "0", targetCoverDays: "abc", batchRounding: "100001", shopifyPush: "overwrite" }),
    );
    expect(bad.ok).toBe(false);
    expect(Object.keys((!bad.ok && bad.fieldErrors) || {}).sort()).toEqual([
      "batchRounding",
      "lowStockThreshold",
      "productionLeadDays",
      "shopifyPush",
      "targetCoverDays",
    ]);
    expect((await load()).warehouse.version).toBe(version);
  });

  it("staff cannot change warehouse settings (owner-only)", async () => {
    const before = (await load()).warehouse;
    const r = await act(fields(before.version, { shopifyPush: "deltas" }), "staff");
    expect(r).toMatchObject({ ok: false, error: "error.forbidden", intent: "saveWarehouse" });
    expect((await load()).warehouse).toEqual(before);
  });

  it("changing the default low-stock threshold re-evaluates warnings of items without their own threshold", async () => {
    const v1 = (await load()).warehouse.version;
    const high = await act(fields(v1, { lowStockThreshold: "100000" }));
    expect(high).toMatchObject({ ok: true, message: "settings.warehouse.savedWithAlerts" });
    const many = await openLowAlertsWithoutOwnThreshold();
    expect(many).toBeGreaterThan(0);
    const v2 = (await load()).warehouse.version;
    const low = await act(fields(v2, { lowStockThreshold: "0" }));
    expect(low).toMatchObject({ ok: true, message: "settings.warehouse.savedWithAlerts" });
    expect(await openLowAlertsWithoutOwnThreshold()).toBeLessThan(many);
    // Той самий поріг — без переоцінки.
    const v3 = (await load()).warehouse.version;
    expect(await act(fields(v3, { lowStockThreshold: "0" }))).toMatchObject({ ok: true, message: "result.settings.saved" });
    const v4 = (await load()).warehouse.version;
    expect(await act(fields(v4))).toMatchObject({ ok: true });
  });

  it("renders the section with Ukrainian texts", async () => {
    const shell: ShellData = {
      mode: "demo",
      basePath: "/demo",
      actor: { id: "demo-owner", displayName: "Demo Owner", role: "owner", permissions: [...PERMISSIONS] },
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
            children: [{ id: "demo-settings", path: "settings", loader: page.loader, action: page.action, Component: page.default }],
          },
        ],
      },
    ];
    const handler = createStaticHandler(routes);
    const context = await handler.query(new Request(URL_, { headers: await headers("owner") }));
    if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
    const html = renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
    const uk = DICTIONARIES.uk;
    expect(html).toContain(uk["settings.warehouse.title"]!);
    expect(html).toContain('name="shopifyPush"');
    expect(html).toContain('name="allowNegativeOnHand"');
  });
});

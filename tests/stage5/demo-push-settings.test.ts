import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { PERMISSIONS } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { createCarrierRegistry } from "~/integrations/carriers/registry";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { getSetting, updateSetting } from "~/modules/settings/settings.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { RequestContext } from "~/server/types";
import { OWNER, openTestDatabase } from "../helpers";

/**
 * Налаштування → «Склад» у демо й робочій версії (H1, e2e-5): у демо «Передача змін складу в Shopify» і «Зміни залишку,
 * зроблені в Shopify» лишаються редагованими (перегляд), але сторінка чесно каже, що вони не діють (Shopify не
 * підключено, нічого не надсилається), і не показує «Передачу увімкнено…». Робочий текст не змінюється. Збереження в
 * демо зберігає обране значення як є (семантика налаштування та сама). Контекст запиту й середовище підмінено.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));
vi.mock("~/lib/env.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/env.server")>()),
  getEnv: () => ({ NODE_ENV: "test" }),
}));
vi.mock("~/integrations/shopify/admin-client.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/integrations/shopify/admin-client.server")>()),
  adminClientFor: async () => {
    throw new Error("Shopify must not be called");
  },
}));

let handle: DatabaseHandle;
let page: typeof import("~/pages/settings");
type Mode = "demo" | "production";

beforeAll(async () => {
  handle = await openTestDatabase();
  await seedReferenceData(handle.db, DEMO_SETTINGS);
  page = await import("~/pages/settings");
});
afterAll(async () => {
  await handle.close();
});

function setContext(mode: Mode) {
  m.ctx = {
    mode,
    basePath: mode === "demo" ? "/demo" : "/app",
    locale: "uk",
    db: handle.db,
    actor: OWNER,
    carriers: mode === "demo" ? createDemoCarriers(handle.db) : createCarrierRegistry([]),
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
  };
}

async function setWarehouse(patch: Record<string, unknown>) {
  const r = await updateSetting(handle.db, OWNER, "warehouse", { ...(await getSetting(handle.db, "warehouse")), ...patch });
  expect(r.ok).toBe(true);
}

async function render(mode: Mode): Promise<string> {
  setContext(mode);
  const base = mode === "demo" ? "demo" : "app";
  const shell: ShellData = {
    mode,
    basePath: `/${base}`,
    actor: { id: OWNER.id, displayName: OWNER.displayName, role: "owner", permissions: [...PERMISSIONS] },
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
          id: `routes/${base}-layout`,
          path: base,
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "settings", path: "settings", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://localhost/${base}/settings`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const html = renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

async function save(mode: Mode, version: number, over: Record<string, string>) {
  setContext(mode);
  const body = new FormData();
  const fields: Record<string, string> = {
    intent: "saveWarehouse",
    expectedVersion: String(version),
    lowStockThreshold: "5",
    productionLeadDays: "30",
    targetCoverDays: "60",
    batchRounding: "10",
    shopifyPush: "off",
    externalShopifyChanges: "review",
    ...over,
  };
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  const base = mode === "demo" ? "demo" : "app";
  return page.action({ request: new Request(`http://localhost/${base}/settings`, { method: "POST", body }), params: {}, context: {} } as never);
}

const uk = (key: string) => DICTIONARIES.uk[key]!;
const DEMO_KEYS = ["settings.warehouse.demoBanner", "settings.warehouse.shopifyPushDemo", "settings.warehouse.externalShopifyChangesDemo"];

describe("settings → warehouse: Shopify options in the demo (e2e-5)", () => {
  it("demo: push «on» is not presented as active; both options say they have no effect and stay editable", async () => {
    await setWarehouse({ shopifyPush: "deltas", externalShopifyChanges: "apply" });
    const html = await render("demo");
    for (const key of DEMO_KEYS) expect(html, key).toContain(uk(key));
    expect(html).not.toContain(uk("settings.warehouse.pushOnBanner"));
    // Робоча довідка полів лишається (перегляд значень), поля не вимкнені для власника.
    expect(html).toContain(uk("settings.warehouse.shopifyPushHelp"));
    expect(html).toContain(uk("settings.warehouse.externalShopifyChangesHelp"));
    expect(html).toMatch(/<select[^>]*name="shopifyPush"(?![^>]*disabled)[^>]*>/);
    expect(html).toMatch(/<select[^>]*name="externalShopifyChanges"(?![^>]*disabled)[^>]*>/);
    // Опис поля посилається на демо-примітку (aria-describedby → helpText).
    expect(html).toMatch(/<div id="[^"]+-help" class="ot-field__help"><span class="ot-stack[^"]*"><span class="ot-text ot-text--caption[^"]*">Демо: не діє/);
  });

  it("production: unchanged texts — «push is on» banner, no demo notes", async () => {
    await setWarehouse({ shopifyPush: "deltas", externalShopifyChanges: "review" });
    const html = await render("production");
    expect(html).toContain(uk("settings.warehouse.pushOnBanner"));
    expect(html).toContain(uk("settings.warehouse.shopifyPushHelp"));
    for (const key of DEMO_KEYS) expect(html, key).not.toContain(uk(key));
    expect(html).not.toContain("Демо: не діє");
  });

  it("the apply-without-push warning still previews the setting in both modes", async () => {
    await setWarehouse({ shopifyPush: "off", externalShopifyChanges: "apply" });
    for (const mode of ["demo", "production"] as const) {
      expect(await render(mode), mode).toContain(uk("settings.warehouse.applyWithoutPushWarning"));
    }
  });

  it("saving in the demo stores the chosen values as they are (same semantics as production)", async () => {
    setContext("demo");
    const { version } = (await page.loader({ request: new Request("http://localhost/demo/settings"), params: {}, context: {} } as never)).warehouse;
    const r = await save("demo", version, { shopifyPush: "deltas", externalShopifyChanges: "apply" });
    expect(r).toMatchObject({ ok: true, intent: "saveWarehouse" });
    expect(await getSetting(handle.db, "warehouse")).toMatchObject({ shopifyPush: "deltas", externalShopifyChanges: "apply" });
  });
});

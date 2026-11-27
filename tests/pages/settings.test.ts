import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { PERMISSIONS } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { resetEnvCache } from "~/lib/env.server";
import { DEMO_SETTINGS } from "~/db/seed/seed.server";
import { getSetting } from "~/modules/settings/settings.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Налаштування (/demo/settings): loader і дії через справжні запити до демо-середовища (PGlite у пам'яті).
 * Глобальне демо-середовище — окреме для кожного файлу тестів (pool: forks).
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

async function headers(role?: "owner" | "staff"): Promise<HeadersInit> {
  return role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
}

async function load(role?: "owner" | "staff") {
  return page.loader({ request: new Request(URL_, { headers: await headers(role) }), params: {}, context: {} } as never);
}

async function act(fields: Record<string, string>, role?: "owner" | "staff") {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request(URL_, { method: "POST", body, headers: await headers(role) });
  return page.action({ request, params: {}, context: {} } as never);
}

/** Серверний рендер сторінки в мінімальному дереві маршрутів (root → demo-layout → сторінка). */
async function render(init?: { fields?: Record<string, string> }): Promise<string> {
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
  let body: FormData | undefined;
  if (init?.fields) {
    body = new FormData();
    for (const [k, v] of Object.entries(init.fields)) body.set(k, v);
  }
  const context = await handler.query(new Request(URL_, { method: init?.fields ? "POST" : "GET", body }));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

async function db() {
  return (await getDemoRuntime()).handle.db;
}

describe("settings loader", () => {
  it("returns versioned values, options, permissions and honest integration flags only", async () => {
    const data = await load();
    expect(data.mode).toBe("demo");
    expect(data.can).toEqual({ automation: true, manage: true, demoReset: true });
    expect(data.automation.value).toEqual(DEMO_SETTINGS.automation);
    expect(data.automation.version).toBeGreaterThan(0);
    expect(data.shipper.missing).toEqual([]);
    expect(data.testCarrier?.value).toEqual({ simulation: "none" });
    expect(data.integrations.shopifyConnected).toBe(false);
    expect(data.integrations.carriers.map((c) => c.mode)).toEqual(["test"]);
    expect(data.integrations.novaGlobalRegistered).toBe(false);
    // Жодних значень змінних середовища (ключів) у даних сторінки.
    const json = JSON.stringify(data);
    for (const [name, value] of Object.entries(process.env)) {
      if (/SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL/i.test(name) && value && value.length >= 8) {
        expect(json.includes(value), name).toBe(false);
      }
    }
  });

  it("staff gets 403", async () => {
    const res = await load("staff").catch((e: unknown) => e);
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(403);
  });

  it("dynamic i18n keys used by the page exist in both languages", async () => {
    const data = await load();
    const keys = [
      ...data.options.modes.flatMap((m) => [`settings.automation.mode.${m}`, `settings.automation.modeHelp.${m}`]),
      ...data.options.simulations.flatMap((s) => [`settings.testCarrier.simulation.${s}`, `settings.testCarrier.help.${s}`]),
      ...Object.keys(data.shipper.value).map((f) => `settings.shipper.field.${f}`),
      ...Object.keys(data.integrations.carriers[0]?.capabilities ?? {})
        // documentKinds — перелік видів документів, а не ознака (сторінка показує лише CAPABILITY_KEYS).
        .filter((k) => k !== "referenceLookupAuthoritative" && k !== "documentKinds")
        .map((k) => `settings.integrations.capability.${k}`),
    ];
    for (const locale of ["uk", "en"] as const) {
      expect(keys.filter((k) => !(k in DICTIONARIES[locale])), locale).toEqual([]);
    }
  });
});

describe("settings page render", () => {
  it("renders every section in Ukrainian with the demo reset confirmation (E2E contract)", async () => {
    const html = await render();
    for (const key of [
      "settings.automation.title",
      "settings.shipper.title",
      "settings.customs.title",
      "settings.packaging.title",
      "settings.checkoutRates.title",
      "settings.tracking.title",
      "settings.testCarrier.title",
      "settings.integrations.title",
      "settings.integrations.secrets",
      "settings.personal.title",
      "demo.reset.button",
      "demo.reset.title",
      "settings.demo.confirm",
    ]) {
      expect(html, key).toContain(DICTIONARIES.uk[key]);
    }
    expect(DICTIONARIES.uk["settings.demo.confirm"]).toContain("Скинути");
    // Немає неперекладених ключів.
    expect(html).not.toMatch(/>\s*(settings|demo|common|carrierService)\.[a-zA-Z_.]+\s*</);
    expect(html).toContain('name="expectedVersion"');
  });

  it("shows localized field errors only in the submitted form", async () => {
    const { value, version } = (await load()).shipper;
    const html = await render({
      fields: { ...value, intent: "saveShipper", expectedVersion: String(version), email: "broken" },
    });
    expect(html).toContain(DICTIONARIES.uk["settings.error.email"]);
    expect(html.split(DICTIONARIES.uk["error.validation"]!).length - 1).toBe(1);
    // Технічне повідомлення zod не показується користувачу (лише в даних гідратації).
    const visible = html.replace(/<script[\s\S]*?<\/script>/g, "");
    expect(visible).not.toMatch(/Invalid/);
  });
});

describe("settings actions", () => {
  it("saves automation with optimistic locking and echoes the intent", async () => {
    const { version } = (await load()).automation;
    const r = await act({ intent: "saveAutomation", expectedVersion: String(version), mode: "auto", globalPause: "on" });
    expect(r).toEqual({ ok: true, message: "result.settings.saved", intent: "saveAutomation" });
    expect(await getSetting(await db(), "automation")).toEqual({ mode: "auto", globalPause: true });

    // Повтор зі старою версією — конфлікт, а не тихе перезаписування.
    const stale = await act({ intent: "saveAutomation", expectedVersion: String(version), mode: "manual" });
    expect(stale).toMatchObject({ ok: false, error: "error.conflict", intent: "saveAutomation" });

    const bad = await act({ intent: "saveAutomation", expectedVersion: String(version + 1), mode: "turbo" });
    expect(bad).toMatchObject({ ok: false, error: "error.validation", intent: "saveAutomation" });
    expect(bad.ok ? {} : bad.fieldErrors).toHaveProperty("mode");

    expect(await act({ intent: "saveAutomation", mode: "manual" })).toMatchObject({ ok: false, error: "error.generic" });
  });

  it("validates and normalizes shipper fields", async () => {
    const { value, version } = (await load()).shipper;
    const fields = { ...value, intent: "saveShipper", expectedVersion: String(version) };
    const bad = await act({ ...fields, email: "not-an-email", countryCode: "UKR" });
    expect(bad).toMatchObject({ ok: false, error: "error.validation", intent: "saveShipper" });
    expect(Object.keys(bad.ok ? {} : (bad.fieldErrors ?? {})).sort()).toEqual(["countryCode", "email"]);

    const ok = await act({ ...fields, countryCode: "pl", city: "  Warszawa  ", phone: "" });
    expect(ok).toMatchObject({ ok: true, message: "result.settings.saved" });
    const stored = await getSetting(await db(), "shipper");
    expect(stored).toMatchObject({ countryCode: "PL", city: "Warszawa", phone: "" });
    expect((await load()).shipper.missing).toEqual(["phone"]);
  });

  it("saves packaging without touching the package list", async () => {
    const { value, version } = (await load()).packaging;
    const base = { intent: "savePackaging", expectedVersion: String(version), defaultPackageCode: "box_l" };
    const bad = await act({ ...base, volumetricDivisor: "50" });
    expect(bad.ok ? {} : bad.fieldErrors).toHaveProperty("volumetricDivisor");
    const missing = await act({ ...base, defaultPackageCode: "nope", volumetricDivisor: "6000" });
    expect(missing.ok ? {} : missing.fieldErrors).toHaveProperty("defaultPackageCode");

    expect(await act({ ...base, volumetricDivisor: "6000" })).toMatchObject({ ok: true, intent: "savePackaging" });
    const stored = await getSetting(await db(), "packaging");
    expect(stored).toEqual({ ...value, defaultPackageCode: "box_l", volumetricDivisor: 6000 });
  });

  it("saves the test carrier simulation (demo only)", async () => {
    const { version } = (await load()).testCarrier ?? { version: 0 };
    const r = await act({ intent: "saveTestCarrier", expectedVersion: String(version), simulation: "fail_after_create" });
    expect(r).toMatchObject({ ok: true, intent: "saveTestCarrier" });
    expect(await getSetting(await db(), "testCarrier")).toEqual({ simulation: "fail_after_create" });
    const bad = await act({ intent: "saveTestCarrier", expectedVersion: String(version + 1), simulation: "explode" });
    expect(bad.ok ? {} : bad.fieldErrors).toHaveProperty("simulation");
  });

  it("staff cannot change settings or reset demo data", async () => {
    for (const intent of [
      "saveAutomation",
      "saveShipper",
      "saveCustoms",
      "savePackaging",
      "saveNovaPost",
      "saveCheckoutRates",
      "previewRates",
      "enableCheckout",
      "disableCheckout",
      "saveTracking",
      "saveTestCarrier",
      "resetDemo",
    ]) {
      expect(await act({ intent, expectedVersion: "1" }, "staff"), intent).toMatchObject({ ok: false, error: "error.forbidden", intent });
    }
  });

  it("resetDemo restores the initial demo settings", async () => {
    expect(await act({ intent: "resetDemo" })).toEqual({ ok: true, message: "result.demo.reset", intent: "resetDemo" });
    const data = await load();
    expect(data.automation.value).toEqual(DEMO_SETTINGS.automation);
    expect(data.testCarrier?.value).toEqual({ simulation: "none" });
    expect(data.shipper.missing).toEqual([]);
  });

  it("rejects unknown intents", async () => {
    expect(await act({ intent: "dropDatabase" })).toEqual({ ok: false, error: "error.generic", intent: "dropDatabase" });
  });
});

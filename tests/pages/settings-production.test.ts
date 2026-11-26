import { Buffer } from "node:buffer";
import { Writable } from "node:stream";
import { createElement as h, type ReactElement } from "react";
import { renderToPipeableStream, renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter, type LoaderFunction, type ActionFunction } from "react-router";
import type { ComponentType } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import type { DatabaseHandle } from "~/db/client.server";
import { jobs, shopInstallations } from "~/db/schema";
import { PERMISSIONS, makeActor, type Actor } from "~/domain/permissions";
import { createCarrierRegistry } from "~/integrations/carriers/registry";
import type { CarrierAdapter, CarrierCapabilities } from "~/integrations/carriers/types";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlCarrierService } from "~/integrations/shopify/carrier-service-graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { DICTIONARIES } from "~/i18n";
import { carrierServiceCallbackUrl, carrierServiceToken } from "~/modules/rates/carrier-service.server";
import { JOB } from "~/modules/shopify-sync/sync.server";
import type { RequestContext } from "~/server/types";
import { OWNER, openTestDatabase } from "../helpers";

/**
 * Робоча версія (/app/settings, /app/shopify) без Shopify і мережі: контекст запиту (після authenticate.admin),
 * змінні середовища й клієнт Admin GraphQL підмінено. Перевіряється, що сторінки показують чесний стан
 * (ключ задано — без значення, дозволи, CarrierService) і не чекають на Shopify.
 */
const m = vi.hoisted(() => ({
  ctx: null as RequestContext | null,
  env: {} as Record<string, unknown>,
  admin: null as AdminGraphql | null,
  adminShops: [] as string[],
}));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));
vi.mock("~/lib/env.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/env.server")>()),
  getEnv: () => m.env,
}));
vi.mock("~/integrations/shopify/admin-client.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/integrations/shopify/admin-client.server")>()),
  adminClientFor: async (shop: string) => {
    m.adminShops.push(shop);
    if (!m.admin) throw new Error("no admin client in this test");
    return m.admin;
  },
}));

// Тестові значення (не справжні ключі).
const KEY_SENTINEL = "np-key-sentinel-0123456789abcdef";
const SECRET = "shopify-secret-sentinel-0123456789";
const APP_URL = "https://logistics.example.test";
const SHOP = "ot-test.myshopify.com";
const ENV = {
  NODE_ENV: "test",
  SHOPIFY_APP_URL: APP_URL,
  SHOPIFY_API_SECRET: SECRET,
  NOVA_POSHTA_API_KEY: KEY_SENTINEL,
  NOVA_POSHTA_API_BASE: "https://np-api.example.test/v1.0",
};
const OUR_URL = carrierServiceCallbackUrl(APP_URL, carrierServiceToken(SECRET, SHOP));

let page: typeof import("~/pages/settings");
let sync: typeof import("~/pages/shopify-sync");
let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await openTestDatabase();
  page = await import("~/pages/settings");
  sync = await import("~/pages/shopify-sync");
});

afterAll(async () => {
  await handle.close();
});

beforeEach(async () => {
  m.env = { ...ENV };
  m.admin = null;
  m.adminShops = [];
  setContext();
  await handle.db.delete(shopInstallations);
  await handle.db.delete(jobs);
});

const MANAGER = makeActor({ id: "test-manager", displayName: "Manager", role: "staff", overrides: { grant: ["settings.view"] } });

function setContext(opts: { actor?: Actor; carriers?: CarrierAdapter[]; defaultCarrier?: string } = {}) {
  m.ctx = {
    mode: "production",
    basePath: "/app",
    locale: "uk",
    db: handle.db,
    actor: opts.actor ?? OWNER,
    carriers: createCarrierRegistry(opts.carriers ?? [], opts.defaultCarrier),
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
  };
}

async function install(scopes: string) {
  await handle.db.insert(shopInstallations).values({ shop: SHOP, scopes });
}

const CAPS: CarrierCapabilities = {
  rates: true,
  availability: false,
  createShipment: true,
  updateShipment: false,
  cancelShipment: true,
  documents: true,
  tracking: true,
  returns: false,
  findByReference: true,
  referenceLookupAuthoritative: false,
};

function fakeNovaPost(caps: Partial<CarrierCapabilities> = {}): CarrierAdapter {
  return {
    code: "nova_post",
    displayName: "Nova Post",
    mode: "live",
    capabilities: { ...CAPS, ...caps },
    createShipment: async () => {
      throw new Error("must not be called");
    },
    findShipmentByReference: async () => ({ found: false, authoritative: false }),
    cancelShipment: async () => ({ cancelled: false }),
  };
}

/** Імітація Admin GraphQL для CarrierService (список, створення, оновлення). */
function fakeAdmin(initial: GqlCarrierService[] = []) {
  const services = initial.map((s) => ({ ...s }));
  const ops: string[] = [];
  const admin = (async <T,>(query: string, variables?: Record<string, unknown>) => {
    const op = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
    ops.push(op);
    if (op === "OtCarrierServices") return { carrierServices: { nodes: services.map((s) => ({ ...s })) } } as T;
    if (op === "OtCarrierServiceCreate") {
      const created = { id: "gid://shopify/DeliveryCarrierService/1000", ...(variables?.input as Omit<GqlCarrierService, "id">) };
      services.push(created);
      return { carrierServiceCreate: { carrierService: created, userErrors: [] } } as T;
    }
    if (op === "OtCarrierServiceUpdate") {
      const input = variables?.input as Partial<GqlCarrierService> & { id: string };
      const s = services.find((x) => x.id === input.id);
      if (s) Object.assign(s, input);
      return { carrierServiceUpdate: { carrierService: s ?? null, userErrors: [] } } as T;
    }
    throw new Error(`unexpected op ${op}`);
  }) as AdminGraphql;
  return { admin, ops, services };
}

const OURS: GqlCarrierService = {
  id: "gid://shopify/DeliveryCarrierService/7",
  name: "ONE TUNNE Logistics",
  callbackUrl: OUR_URL,
  active: true,
  supportsServiceDiscovery: true,
};

const SETTINGS_URL = "http://localhost/app/settings";

async function load() {
  return page.loader({ request: new Request(SETTINGS_URL), params: {}, context: {} } as never);
}

async function act(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return page.action({ request: new Request(SETTINGS_URL, { method: "POST", body }), params: {}, context: {} } as never);
}

/** Повний потоковий рендер (як entry.server для ботів: onAllReady) — з даними, що надходять окремо. */
function renderAll(element: ReactElement): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _encoding, cb) {
        chunks.push(Buffer.from(chunk));
        cb();
      },
      final(cb) {
        resolve(Buffer.concat(chunks).toString("utf8"));
        cb();
      },
    });
    const { pipe } = renderToPipeableStream(element, { onAllReady: () => pipe(sink), onShellError: reject });
  });
}

/** Сторінка в дереві root → app-layout → сторінка; streaming: true — чекати на всі дані, false — лише оболонка. */
async function renderPage(
  path: string,
  route: { loader: LoaderFunction; action?: ActionFunction; Component: ComponentType },
  opts: { streaming?: boolean } = {},
): Promise<string> {
  const shell: ShellData = {
    mode: "production",
    basePath: "/app",
    actor: { id: "shopify:1", displayName: "Owner", role: "owner", permissions: [...PERMISSIONS] },
    nav: [],
    automation: { mode: "manual", globalPause: false },
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
          id: "routes/app-layout",
          path: "app",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: path.replace(/^\/app\//, ""), ...route }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  const element = h(StaticRouterProvider, { router, context });
  const html = opts.streaming === false ? renderToString(element) : await renderAll(element);
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

const settingsRoute = () => ({ loader: page.loader as LoaderFunction, action: page.action as ActionFunction, Component: page.default });
const uk = (key: string) => DICTIONARIES.uk[key]!;

// ---------------------------------------------------------------- Nova Post і секрети

describe("production settings: Nova Post and secrets", () => {
  it("always shows the Nova Post section; the key is reported as set, its value never leaves the server", async () => {
    await install("read_orders,write_shipping");
    m.admin = fakeAdmin([OURS]).admin;
    const data = await load();
    expect(data.mode).toBe("production");
    expect(data.novaPost).toMatchObject({ registered: false, shipmentsEnabled: false });
    expect(data.integrations.novaPost).toEqual({
      registered: false,
      isDefault: false,
      apiKeyConfigured: true,
      apiHost: "np-api.example.test",
      capabilities: null,
    });
    expect(data.integrations.shopifyConnected).toBe(true);
    expect(data.testCarrier).toBeNull();
    const json = JSON.stringify({ ...data, checkoutConnection: await data.checkoutConnection });
    for (const secret of [KEY_SENTINEL, SECRET, carrierServiceToken(SECRET, SHOP), OUR_URL]) {
      expect(json.includes(secret), secret).toBe(false);
    }

    const html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.novaPost.title"));
    expect(html).toContain(uk("settings.novaPost.notRegistered"));
    expect(html).toContain(uk("settings.integrations.novaPost.keyNotRegistered"));
    expect(html).toContain(uk("settings.integrations.novaPost.key.set"));
    expect(html).toContain("np-api.example.test");
    for (const secret of [KEY_SENTINEL, SECRET, carrierServiceToken(SECRET, SHOP)]) expect(html.includes(secret), secret).toBe(false);
  });

  it("no key → honest «not configured»; a registered Nova Post with creation enabled is shown as such", async () => {
    delete m.env.NOVA_POSHTA_API_KEY;
    expect((await load()).integrations.novaPost).toMatchObject({ registered: false, apiKeyConfigured: false });
    expect(await renderPage("/app/settings", settingsRoute())).toContain(uk("settings.integrations.novaPost.noKey"));

    setContext({ carriers: [fakeNovaPost()], defaultCarrier: "nova_post" });
    m.env.NOVA_POSHTA_API_KEY = KEY_SENTINEL;
    const data = await load();
    expect(data.novaPost).toMatchObject({ registered: true, shipmentsEnabled: true });
    expect(data.integrations.novaPost).toMatchObject({ registered: true, isDefault: true, apiKeyConfigured: true });
    const html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.novaPost.creation.enabledHelp"));
    expect(html).toContain(uk("settings.integrations.novaPost.registered"));
  });
});

// ---------------------------------------------------------------- Підключення до Checkout

describe("production settings: Checkout connection state", () => {
  it("is not awaited by the loader: the page data is ready while Shopify has not answered", async () => {
    await install("write_shipping");
    // Shopify «думає»: відповіді чекають, доки тест їх не відпустить.
    const pending: Array<(v: unknown) => void> = [];
    m.admin = (async () => new Promise<unknown>((resolve) => pending.push(resolve))) as AdminGraphql;
    const data = await load();
    expect(data.checkoutConnection).toBeInstanceOf(Promise);
    // Оболонка сторінки рендериться одразу (без очікування Shopify), стан — «Перевіряємо…».
    const shellOnly = await renderPage("/app/settings", settingsRoute(), { streaming: false });
    expect(shellOnly).toContain(uk("settings.checkoutConnection.loading"));
    expect(shellOnly).toContain(uk("settings.customs.title"));
    await vi.waitFor(() => expect(pending.length).toBe(2));
    for (const answer of pending) answer({ carrierServices: { nodes: [{ ...OURS }] } });
    expect(await data.checkoutConnection).toEqual({ kind: "status", registered: true, active: true, callbackUrlCurrent: true, shop: SHOP });
  });

  it("a slow Shopify answer turns into the «error» state after the timeout instead of holding the page", async () => {
    await install("write_shipping");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    try {
      m.admin = (async () => new Promise(() => undefined)) as AdminGraphql;
      const data = await load();
      await vi.waitFor(() => expect(m.adminShops.length).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(4000);
      expect(await data.checkoutConnection).toEqual({ kind: "error", shop: SHOP });
    } finally {
      vi.useRealTimers();
    }
  });

  it("ownerOnly for a user who may view but not manage settings (no Shopify call)", async () => {
    await install("write_shipping");
    setContext({ actor: MANAGER });
    const data = await load();
    expect(data.checkoutConnection).toEqual({ kind: "ownerOnly" });
    expect(m.adminShops).toEqual([]);
    const html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.title"));
    expect(html).not.toContain(uk("settings.checkoutConnection.enable.button"));
  });

  it("unavailable: not installed, missing write_shipping, not configured — with explanations, no buttons", async () => {
    expect(await (await load()).checkoutConnection).toEqual({ kind: "unavailable", reason: "not_installed", scope: null, shop: null });
    let html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.reason.not_installed"));
    expect(html).not.toContain(uk("settings.checkoutConnection.enable.button"));

    await install("read_orders,write_merchant_managed_fulfillment_orders");
    expect(await (await load()).checkoutConnection).toEqual({ kind: "unavailable", reason: "missing_scope", scope: "write_shipping", shop: SHOP });
    html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.reason.missing_scope").replace("{scope}", "write_shipping"));
    expect(html).not.toContain(uk("settings.checkoutConnection.enable.button"));
    expect(m.adminShops).toEqual([]);

    delete m.env.SHOPIFY_APP_URL;
    expect(await (await load()).checkoutConnection).toMatchObject({ kind: "unavailable", reason: "not_configured" });
  });

  it("status: not registered / active / stale address, each with its badge and the right buttons", async () => {
    await install("write_shipping");
    m.admin = fakeAdmin([]).admin;
    expect(await (await load()).checkoutConnection).toEqual({
      kind: "status",
      registered: false,
      active: false,
      callbackUrlCurrent: false,
      shop: SHOP,
    });
    let html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.state.notRegistered"));
    expect(html).toContain(uk("settings.checkoutConnection.enable.button"));
    expect(html).not.toContain(uk("settings.checkoutConnection.disable.button"));
    expect(html).not.toContain(uk("settings.checkoutConnection.loading"));

    m.admin = fakeAdmin([OURS]).admin;
    html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.state.active"));
    expect(html).toContain(uk("settings.checkoutConnection.badge.active"));
    expect(html).toContain(uk("settings.checkoutConnection.disable.button"));
    // Магазин — у підтвердженні підключення; адреса callback і токен — ніде.
    expect(html).toContain(uk("settings.checkoutConnection.enable.shop").replace("{shop}", SHOP));
    expect(html.includes(carrierServiceToken(SECRET, SHOP))).toBe(false);

    m.admin = fakeAdmin([{ ...OURS, callbackUrl: `https://old.example.test/carrier-service/${carrierServiceToken(SECRET, SHOP)}` }]).admin;
    html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.state.stale"));
  });

  it("error: a failing Shopify call is shown as «could not get the status», the page still renders", async () => {
    await install("write_shipping");
    m.admin = (async () => {
      throw new Error("Shopify is down");
    }) as AdminGraphql;
    expect(await (await load()).checkoutConnection).toEqual({ kind: "error", shop: SHOP });
    const html = await renderPage("/app/settings", settingsRoute());
    expect(html).toContain(uk("settings.checkoutConnection.state.error"));
    expect(html).toContain(uk("settings.checkoutConnection.enable.button"));
    expect(html).toContain(uk("settings.customs.title"));
  });
});

describe("production settings: Checkout connection actions", () => {
  it("enable: created → success, then unchanged → info; disable: deactivated → success, unchanged → info", async () => {
    await install("write_shipping");
    const f = fakeAdmin([]);
    m.admin = f.admin;
    expect(await act({ intent: "enableCheckout" })).toEqual({
      ok: true,
      message: "settings.checkoutConnection.enable.created",
      tone: "success",
      intent: "enableCheckout",
    });
    expect(f.services).toHaveLength(1);
    expect(f.services[0]).toMatchObject({ callbackUrl: OUR_URL, active: true });
    expect(await act({ intent: "enableCheckout" })).toMatchObject({ ok: true, message: "settings.checkoutConnection.enable.unchanged", tone: "info" });

    expect(await act({ intent: "disableCheckout" })).toEqual({
      ok: true,
      message: "settings.checkoutConnection.disable.deactivated",
      tone: "success",
      intent: "disableCheckout",
    });
    expect(f.services[0]?.active).toBe(false);
    expect(await act({ intent: "disableCheckout" })).toMatchObject({ ok: true, message: "settings.checkoutConnection.disable.unchanged", tone: "info" });
    expect(await act({ intent: "enableCheckout" })).toMatchObject({ ok: true, message: "settings.checkoutConnection.enable.updated", tone: "success" });
    for (const key of ["created", "unchanged", "updated"]) expect(DICTIONARIES.uk, key).toHaveProperty([`settings.checkoutConnection.enable.${key}`]);
  });

  it("not found → info; missing scope → error with the scope; a manager cannot connect", async () => {
    await install("write_shipping");
    m.admin = fakeAdmin([]).admin;
    expect(await act({ intent: "disableCheckout" })).toMatchObject({ ok: true, message: "settings.checkoutConnection.disable.not_found", tone: "info" });

    await handle.db.delete(shopInstallations);
    await install("read_orders");
    expect(await act({ intent: "enableCheckout" })).toEqual({
      ok: false,
      error: "settings.checkoutConnection.reason.missing_scope",
      params: { scope: "write_shipping" },
      intent: "enableCheckout",
    });

    setContext({ actor: MANAGER });
    expect(await act({ intent: "enableCheckout" })).toMatchObject({ ok: false, error: "error.forbidden" });
  });

  it("the action result banner is shown next to the connection state", async () => {
    await install("write_shipping");
    m.admin = fakeAdmin([]).admin;
    const handler = createStaticHandler([
      {
        id: "root",
        path: "/",
        loader: () => ({ locale: "uk" }),
        Component: Outlet,
        children: [{ id: "page", path: "app/settings", ...settingsRoute() }],
      },
    ]);
    const body = new FormData();
    body.set("intent", "enableCheckout");
    const context = await handler.query(new Request(SETTINGS_URL, { method: "POST", body }));
    if (context instanceof Response) throw new Error("unexpected response");
    const html = await renderAll(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
    expect(html).toContain(uk("settings.checkoutConnection.enable.created"));
    expect(html).toContain(uk("settings.checkoutConnection.state.active"));
  });
});

// ---------------------------------------------------------------- Синхронізація Shopify

describe("production shopify-sync: stage 3 scopes and job names", () => {
  const syncRoute = () => ({ loader: sync.loader as LoaderFunction, action: sync.action as ActionFunction, Component: sync.default });

  it("computes granted/missing stage 3 scopes from the installation and shows the instructions", async () => {
    await install("read_orders,write_merchant_managed_fulfillment_orders");
    const data = await sync.loader({ request: new Request("http://localhost/app/shopify"), params: {}, context: {} } as never);
    expect(data.stage3Scopes).toEqual([
      { scope: "write_merchant_managed_fulfillment_orders", granted: true },
      { scope: "write_shipping", granted: false },
    ]);
    const html = await renderPage("/app/shopify", syncRoute());
    expect(html).toContain(uk("shopify.scopes.title"));
    expect(html).toContain(uk("shopify.scopes.granted"));
    expect(html).toContain(uk("shopify.scopes.missing"));
    expect(html).toContain(uk("shopify.scopes.purpose.write_shipping"));
    expect(html).toContain(uk("shopify.scopes.instructions"));
    expect(html).not.toContain(uk("shopify.scopes.allGranted"));
  });

  it("all scopes granted → no instructions", async () => {
    await install("read_orders, write_merchant_managed_fulfillment_orders, write_shipping");
    const html = await renderPage("/app/shopify", syncRoute());
    expect(html).toContain(uk("shopify.scopes.allGranted"));
    expect(html).not.toContain(uk("shopify.scopes.instructions"));
  });

  it("localizes job type names (known types) and keeps the raw type for unknown ones", async () => {
    await install("write_shipping");
    await handle.db.insert(jobs).values([
      { type: JOB.fulfillShipment, status: "dead", attempts: 5, lastError: "fulfillment rejected" },
      { type: "custom.unknown_job", status: "dead", attempts: 5, lastError: "boom" },
    ]);
    const data = await sync.loader({ request: new Request("http://localhost/app/shopify"), params: {}, context: {} } as never);
    const byType = Object.fromEntries((data.jobs?.problems ?? []).map((p) => [p.type, p.typeKey]));
    expect(byType).toEqual({ [JOB.fulfillShipment]: "fulfillShipment", "custom.unknown_job": null });
    const html = await renderPage("/app/shopify", syncRoute());
    expect(html).toContain(uk("shopify.jobs.type.fulfillShipment"));
    expect(html).toContain("custom.unknown_job");
    expect(html).not.toContain(JOB.fulfillShipment);
  });
});

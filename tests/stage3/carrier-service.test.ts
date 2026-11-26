import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequestHandler, type ActionFunctionArgs, type ServerBuild } from "react-router";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { auditLog, settings, settingsHistory, shopInstallations } from "~/db/schema";
import { ForbiddenError } from "~/domain/permissions";
import { createCarrierRegistry } from "~/integrations/carriers/registry";
import { CarrierError, type CarrierAdapter, type RateQuote, type RateRequest } from "~/integrations/carriers/types";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import type { GqlCarrierService, GqlCarrierServiceUserError } from "~/integrations/shopify/carrier-service-graphql";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { logger } from "~/lib/logger.server";
import {
  CarrierServiceError,
  carrierServiceCallbackUrl,
  carrierServiceStatus,
  carrierServiceToken,
  deactivateCarrierService,
  disableCarrierService,
  enableCarrierService,
  findOurCarrierService,
  getCarrierServiceStatus,
  hasScope,
  isCarrierServiceTokenFormat,
  registerCarrierService,
  unregisterCarrierService,
  verifyCarrierServiceToken,
} from "~/modules/rates/carrier-service.server";
import { clearCheckoutRatesCache } from "~/modules/rates/checkout-rates.server";
import { DEFAULT_SETTINGS } from "~/modules/settings/schema";
import { updateSetting } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, STAFF, openTestDatabase } from "../helpers";

// Маршрут читає середовище і робочий runtime — підміняємо обидва (жодних реальних ключів і мережі).
const h = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  runtime: null as unknown,
  runtimeError: null as Error | null,
}));
vi.mock("~/lib/env.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/env.server")>()),
  getEnv: () => h.env,
}));
vi.mock("~/server/production-runtime.server", () => ({
  getProductionRuntime: async () => {
    if (h.runtimeError) throw h.runtimeError;
    return h.runtime;
  },
}));

const SECRET = "test-secret-not-real-0123456789abcdef";
const SHOP = "ot-test.myshopify.com";
const APP_URL = "https://logistics.example.com";

// ---------------------------------------------------------------------------
// Токен і адреса
// ---------------------------------------------------------------------------

describe("callback token", () => {
  it("is deterministic, 32 base64url chars, bound to shop and secret", () => {
    const t = carrierServiceToken(SECRET, SHOP);
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(carrierServiceToken(SECRET, SHOP)).toBe(t);
    expect(carrierServiceToken(SECRET, ` ${SHOP.toUpperCase()} `)).toBe(t);
    expect(carrierServiceToken(SECRET, "other.myshopify.com")).not.toBe(t);
    expect(carrierServiceToken(`${SECRET}x`, SHOP)).not.toBe(t);
    expect(() => carrierServiceToken("", SHOP)).toThrow();
  });

  it("verification", () => {
    const t = carrierServiceToken(SECRET, SHOP);
    expect(verifyCarrierServiceToken(SECRET, SHOP, t)).toBe(true);
    expect(verifyCarrierServiceToken(SECRET, "other.myshopify.com", t)).toBe(false);
    expect(verifyCarrierServiceToken(SECRET, SHOP, `${t.slice(0, 31)}${t[31] === "A" ? "B" : "A"}`)).toBe(false);
    expect(verifyCarrierServiceToken(SECRET, SHOP, t.slice(0, 31))).toBe(false);
    expect(verifyCarrierServiceToken(SECRET, SHOP, `${t}x`)).toBe(false);
    expect(verifyCarrierServiceToken("", SHOP, t)).toBe(false);
    expect(isCarrierServiceTokenFormat("../../../../etc/passwd/xxxxxxxxx")).toBe(false);
  });

  it("callback URL: https only, keeps a path prefix, no double slashes", () => {
    expect(carrierServiceCallbackUrl(APP_URL, "tok")).toBe(`${APP_URL}/carrier-service/tok`);
    expect(carrierServiceCallbackUrl(`${APP_URL}/`, "tok")).toBe(`${APP_URL}/carrier-service/tok`);
    expect(carrierServiceCallbackUrl(`${APP_URL}/sub/`, "tok")).toBe(`${APP_URL}/sub/carrier-service/tok`);
    expect(() => carrierServiceCallbackUrl("http://logistics.example.com", "tok")).toThrow(/httpsRequired/);
    expect(() => carrierServiceCallbackUrl("not a url", "tok")).toThrow(/invalidAppUrl/);
  });

  it("scope check", () => {
    expect(hasScope("write_orders, write_shipping,read_products", "write_shipping")).toBe(true);
    expect(hasScope("write_orders,read_shipping", "write_shipping")).toBe(false);
    expect(hasScope(null, "write_shipping")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Реєстрація через Admin GraphQL (імітація)
// ---------------------------------------------------------------------------

function fakeCarrierAdmin(initial: GqlCarrierService[] = []) {
  const services = initial.map((s) => ({ ...s }));
  const calls: Array<{ op: string; variables?: Record<string, unknown> }> = [];
  let userErrors: GqlCarrierServiceUserError[] = [];
  let nextId = 1000;
  const admin: AdminGraphql = async <T,>(query: string, variables?: Record<string, unknown>) => {
    const op = /(query|mutation)\s+(\w+)/.exec(query)?.[2] ?? "unknown";
    calls.push({ op, variables });
    let data: unknown;
    switch (op) {
      case "OtCarrierServices":
        expect(query).toContain("carrierServices(first: 50)");
        data = { carrierServices: { nodes: services.map((s) => ({ ...s })) } };
        break;
      case "OtCarrierServiceCreate": {
        if (userErrors.length) {
          data = { carrierServiceCreate: { carrierService: null, userErrors } };
          break;
        }
        const input = variables?.input as Omit<GqlCarrierService, "id">;
        const created = { id: `gid://shopify/DeliveryCarrierService/${nextId++}`, ...input };
        services.push(created);
        data = { carrierServiceCreate: { carrierService: created, userErrors: [] } };
        break;
      }
      case "OtCarrierServiceUpdate": {
        if (userErrors.length) {
          data = { carrierServiceUpdate: { carrierService: null, userErrors } };
          break;
        }
        const input = variables?.input as Partial<GqlCarrierService> & { id: string };
        const s = services.find((x) => x.id === input.id);
        if (s) Object.assign(s, input);
        data = { carrierServiceUpdate: { carrierService: s ?? null, userErrors: [] } };
        break;
      }
      case "OtCarrierServiceDelete": {
        if (userErrors.length) {
          data = { carrierServiceDelete: { deletedId: null, userErrors } };
          break;
        }
        const i = services.findIndex((x) => x.id === variables?.id);
        if (i >= 0) services.splice(i, 1);
        data = { carrierServiceDelete: { deletedId: variables?.id ?? null, userErrors: [] } };
        break;
      }
      default:
        throw new Error(`unexpected op ${op}`);
    }
    return data as T;
  };
  return {
    admin,
    calls,
    services,
    mutations: () => calls.filter((c) => c.op !== "OtCarrierServices"),
    failWith: (e: GqlCarrierServiceUserError[]) => (userErrors = e),
  };
}

const PARAMS = { appUrl: APP_URL, shop: SHOP, secret: SECRET };
const OUR_URL = carrierServiceCallbackUrl(APP_URL, carrierServiceToken(SECRET, SHOP));
const OTHER_APP: GqlCarrierService = {
  id: "gid://shopify/DeliveryCarrierService/1",
  name: "Other app rates",
  callbackUrl: "https://other.example.com/rates",
  active: true,
  supportsServiceDiscovery: true,
};
const LEGACY: GqlCarrierService = { id: "gid://shopify/DeliveryCarrierService/2", name: "UPS", callbackUrl: null, active: true, supportsServiceDiscovery: false };

describe("carrier service registration", () => {
  it("creates when absent (active, service discovery, our callback URL)", async () => {
    const f = fakeCarrierAdmin([OTHER_APP, LEGACY]);
    const r = await registerCarrierService(f.admin, PARAMS);
    expect(r).toEqual({ id: "gid://shopify/DeliveryCarrierService/1000", result: "created", active: true });
    expect(f.mutations()).toEqual([
      {
        op: "OtCarrierServiceCreate",
        variables: { input: { name: "ONE TUNNE Logistics", callbackUrl: OUR_URL, active: true, supportsServiceDiscovery: true } },
      },
    ]);
    // сервіси інших застосунків не змінюються
    expect(f.services.find((s) => s.id === OTHER_APP.id)).toEqual(OTHER_APP);
  });

  it("is idempotent: second call finds the exact URL and changes nothing", async () => {
    const f = fakeCarrierAdmin([OTHER_APP]);
    await registerCarrierService(f.admin, PARAMS);
    const again = await registerCarrierService(f.admin, PARAMS);
    expect(again.result).toBe("unchanged");
    expect(f.mutations()).toHaveLength(1);
  });

  it("updates an inactive service, or one registered under the previous app host", async () => {
    const inactive = fakeCarrierAdmin([{ id: "gid://shopify/DeliveryCarrierService/5", name: "ONE TUNNE Logistics", callbackUrl: OUR_URL, active: false, supportsServiceDiscovery: true }]);
    expect(await registerCarrierService(inactive.admin, PARAMS)).toEqual({ id: "gid://shopify/DeliveryCarrierService/5", result: "updated", active: true });
    expect(inactive.mutations()[0]!.variables).toEqual({
      input: { id: "gid://shopify/DeliveryCarrierService/5", name: "ONE TUNNE Logistics", callbackUrl: OUR_URL, active: true, supportsServiceDiscovery: true },
    });

    const oldHostUrl = OUR_URL.replace("logistics.example.com", "old-host.example.com");
    const moved = fakeCarrierAdmin([OTHER_APP, { id: "gid://shopify/DeliveryCarrierService/6", name: "ONE TUNNE Logistics", callbackUrl: oldHostUrl, active: true, supportsServiceDiscovery: true }]);
    expect((await findOurCarrierService(moved.admin, OUR_URL))?.match).toBe("token");
    const r = await registerCarrierService(moved.admin, PARAMS);
    expect(r.result).toBe("updated");
    expect(moved.services.find((s) => s.id === "gid://shopify/DeliveryCarrierService/6")?.callbackUrl).toBe(OUR_URL);
  });

  it("after a secret rotation, finds the old service by name + our route path", async () => {
    const stale = carrierServiceCallbackUrl(APP_URL, carrierServiceToken("old-secret-value", SHOP));
    const f = fakeCarrierAdmin([{ id: "gid://shopify/DeliveryCarrierService/7", name: "ONE TUNNE Logistics", callbackUrl: stale, active: true, supportsServiceDiscovery: true }]);
    expect(await carrierServiceStatus(f.admin, PARAMS)).toEqual({
      registered: true,
      active: true,
      id: "gid://shopify/DeliveryCarrierService/7",
      name: "ONE TUNNE Logistics",
      callbackUrlCurrent: false,
    });
    expect((await registerCarrierService(f.admin, PARAMS)).result).toBe("updated");
    expect(f.services[0]!.callbackUrl).toBe(OUR_URL);
    expect((await carrierServiceStatus(f.admin, PARAMS)).callbackUrlCurrent).toBe(true);
  });

  it("after a secret rotation, disable and remove find the same stale service as status", async () => {
    const stale = carrierServiceCallbackUrl(APP_URL, carrierServiceToken("old-secret-value", SHOP));
    const svc = { id: "gid://shopify/DeliveryCarrierService/8", name: "ONE TUNNE Logistics", callbackUrl: stale, active: true, supportsServiceDiscovery: true };
    const f = fakeCarrierAdmin([OTHER_APP, svc]);
    expect(await carrierServiceStatus(f.admin, PARAMS)).toMatchObject({ registered: true, active: true, id: svc.id, callbackUrlCurrent: false });
    expect(await deactivateCarrierService(f.admin, PARAMS)).toEqual({ id: svc.id, result: "deactivated" });
    expect(f.mutations().at(-1)).toEqual({ op: "OtCarrierServiceUpdate", variables: { input: { id: svc.id, active: false } } });
    expect(await unregisterCarrierService(f.admin, PARAMS)).toEqual({ deletedId: svc.id, result: "deleted" });
    expect(f.services).toEqual([OTHER_APP]);

    // власна назва: та сама для статусу, вимкнення й видалення; чужа назва з іншим шляхом не чіпається
    const named = fakeCarrierAdmin([OTHER_APP, { ...svc, name: "Доставка ONE TUNNE" }]);
    const params = { ...PARAMS, name: "Доставка ONE TUNNE" };
    expect(await deactivateCarrierService(named.admin, PARAMS)).toEqual({ id: null, result: "not_found" });
    expect(await deactivateCarrierService(named.admin, params)).toEqual({ id: svc.id, result: "deactivated" });
    expect(await unregisterCarrierService(named.admin, params)).toEqual({ deletedId: svc.id, result: "deleted" });
    expect(named.services).toEqual([OTHER_APP]);
  });

  it("surfaces Shopify userErrors without leaking the callback token", async () => {
    const f = fakeCarrierAdmin();
    f.failWith([{ field: ["callbackUrl"], message: `Callback url ${OUR_URL} is not reachable`, code: "CARRIER_SERVICE_CREATE_FAILED" }]);
    const err = await registerCarrierService(f.admin, PARAMS).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CarrierServiceError);
    const e = err as CarrierServiceError;
    expect(e.code).toBe("carrierService.shopifyError");
    expect(e.status).toBe(502);
    expect(e.params).toMatchObject({ operation: "create", code: "CARRIER_SERVICE_CREATE_FAILED" });
    expect(String(e.params.message)).toContain("is not reachable");
    expect(String(e.params.message)).not.toContain(carrierServiceToken(SECRET, SHOP));
  });

  it("status, deactivate and delete", async () => {
    const f = fakeCarrierAdmin([OTHER_APP]);
    expect(await carrierServiceStatus(f.admin, PARAMS)).toMatchObject({ registered: false, active: false, id: null });
    expect(await deactivateCarrierService(f.admin, PARAMS)).toEqual({ id: null, result: "not_found" });
    expect(await unregisterCarrierService(f.admin, PARAMS)).toEqual({ deletedId: null, result: "not_found" });

    const { id } = await registerCarrierService(f.admin, PARAMS);
    expect(await carrierServiceStatus(f.admin, PARAMS)).toEqual({ registered: true, active: true, id, name: "ONE TUNNE Logistics", callbackUrlCurrent: true });
    expect(await deactivateCarrierService(f.admin, PARAMS)).toEqual({ id, result: "deactivated" });
    expect(f.mutations().at(-1)).toEqual({ op: "OtCarrierServiceUpdate", variables: { input: { id, active: false } } });
    expect(await deactivateCarrierService(f.admin, PARAMS)).toEqual({ id, result: "unchanged" });
    expect((await carrierServiceStatus(f.admin, PARAMS)).active).toBe(false);
    expect(await unregisterCarrierService(f.admin, PARAMS)).toEqual({ deletedId: id, result: "deleted" });
    expect(f.services).toEqual([OTHER_APP]);
  });

  it("delete userErrors are surfaced", async () => {
    const f = fakeCarrierAdmin();
    await registerCarrierService(f.admin, PARAMS);
    f.failWith([{ field: null, message: "Only the app that created it can delete", code: "CARRIER_SERVICE_DELETE_FAILED" }]);
    await expect(unregisterCarrierService(f.admin, PARAMS)).rejects.toMatchObject({
      code: "carrierService.shopifyError",
      params: { operation: "delete", code: "CARRIER_SERVICE_DELETE_FAILED" },
    });
  });
});

// ---------------------------------------------------------------------------
// Операції власника (ServiceContext) і маршрут callback (PGlite)
// ---------------------------------------------------------------------------

let handle: DatabaseHandle;

beforeAll(async () => {
  handle = await openTestDatabase();
});

afterAll(async () => {
  await handle.close();
});

async function installShop(scopes: string | null) {
  await handle.db.delete(shopInstallations);
  await handle.db.insert(shopInstallations).values({ shop: SHOP, scopes });
}

const prodCtx = (actor = OWNER): ServiceContext => ({
  mode: "production",
  db: handle.db,
  actor,
  carriers: createCarrierRegistry([]),
  shopify: new DemoShopifyGateway(),
  now: () => new Date(),
});

describe("owner operations (ServiceContext)", () => {
  beforeEach(async () => {
    await handle.db.delete(shopInstallations);
  });

  it("owner only", async () => {
    const f = fakeCarrierAdmin();
    await installShop("write_shipping");
    await expect(enableCarrierService(prodCtx(STAFF), { ...PARAMS, adminFor: async () => f.admin })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getCarrierServiceStatus(prodCtx(STAFF), { ...PARAMS, adminFor: async () => f.admin })).rejects.toBeInstanceOf(ForbiddenError);
    expect(f.calls).toHaveLength(0);
  });

  it("demo mode or missing keys → not_configured (no Shopify calls)", async () => {
    const f = fakeCarrierAdmin();
    await installShop("write_shipping");
    expect(await enableCarrierService({ ...prodCtx(), mode: "demo" }, { ...PARAMS, adminFor: async () => f.admin })).toEqual({ ok: false, reason: "not_configured" });
    expect(await enableCarrierService(prodCtx(), { appUrl: APP_URL, secret: "", adminFor: async () => f.admin })).toEqual({ ok: false, reason: "not_configured" });
    expect(f.calls).toHaveLength(0);
  });

  it("not installed → not_installed; without write_shipping → missing_scope", async () => {
    const f = fakeCarrierAdmin();
    const env = { ...PARAMS, adminFor: async () => f.admin };
    expect(await enableCarrierService(prodCtx(), env)).toEqual({ ok: false, reason: "not_installed" });
    await installShop("write_orders,read_products,read_inventory");
    expect(await enableCarrierService(prodCtx(), env)).toEqual({ ok: false, reason: "missing_scope", scope: "write_shipping" });
    expect(await getCarrierServiceStatus(prodCtx(), env)).toEqual({ ok: false, reason: "missing_scope", scope: "write_shipping" });
    expect(await disableCarrierService(prodCtx(), {}, env)).toEqual({ ok: false, reason: "missing_scope", scope: "write_shipping" });
    expect(f.calls).toHaveLength(0);
  });

  it("enable → status → disable → remove, with audit entries (no token in audit)", async () => {
    const f = fakeCarrierAdmin();
    const shops: string[] = [];
    const env = {
      ...PARAMS,
      adminFor: async (shop: string) => {
        shops.push(shop);
        return f.admin;
      },
    };
    await installShop("write_orders,write_shipping");
    const enabled = await enableCarrierService(prodCtx(), env);
    expect(enabled).toEqual({ ok: true, value: { id: "gid://shopify/DeliveryCarrierService/1000", result: "created", active: true } });
    expect(shops).toEqual([SHOP]);
    expect(await getCarrierServiceStatus(prodCtx(), env)).toMatchObject({ ok: true, value: { registered: true, active: true } });
    expect(await disableCarrierService(prodCtx(), {}, env)).toEqual({ ok: true, value: { id: "gid://shopify/DeliveryCarrierService/1000", result: "deactivated" } });
    expect(await disableCarrierService(prodCtx(), { remove: true }, env)).toEqual({ ok: true, value: { id: "gid://shopify/DeliveryCarrierService/1000", result: "deleted" } });
    const audit = await handle.db.select().from(auditLog).where(eq(auditLog.entityType, "carrier_service"));
    expect(audit.map((a) => a.action)).toEqual(["carrier_service.register", "carrier_service.deactivate", "carrier_service.delete"]);
    expect(JSON.stringify(audit)).not.toContain(carrierServiceToken(SECRET, SHOP));
  });
});

describe("route /carrier-service/:token", () => {
  const TOKEN = carrierServiceToken(SECRET, SHOP);
  const quotes: RateQuote[] = [
    { serviceCode: "standard", serviceName: "Standard", price: { amount: "900.00", currency: "UAH" }, minDeliveryDays: 5, maxDeliveryDays: 9 },
  ];
  let carrierImpl: (req: RateRequest) => Promise<RateQuote[]> = async () => quotes;
  const carrierCalls: RateRequest[] = [];
  const adapter: CarrierAdapter = {
    code: "fake_post",
    displayName: "Fake Post",
    mode: "test",
    capabilities: {
      rates: true,
      availability: false,
      createShipment: false,
      updateShipment: false,
      cancelShipment: false,
      documents: false,
      tracking: false,
      returns: false,
      findByReference: false,
      referenceLookupAuthoritative: false,
    },
    createShipment: async () => {
      throw new Error("not used");
    },
    findShipmentByReference: async () => ({ found: false, authoritative: false }),
    cancelShipment: async () => ({ cancelled: false }),
    quoteRates: async (req) => {
      carrierCalls.push(req);
      return carrierImpl(req);
    },
  };

  const body = {
    rate: {
      origin: { country: "UA", postal_code: "01001", city: "Kyiv" },
      destination: { country: "DE", postal_code: "10115", city: "Berlin", name: "Test Buyer", address1: "Beispielweg 1" },
      items: [{ name: "Grip", quantity: 1, grams: 400, price: 2500, requires_shipping: true, variant_id: 101, product_id: 1 }],
      currency: "EUR",
      locale: "en",
    },
  };

  const call = async (init: { method?: string; token?: string; body?: string; headers?: Record<string, string> } = {}) => {
    const { action } = await import("~/routes/carrier-service");
    const token = init.token ?? TOKEN;
    const request = new Request(`https://logistics.example.com/carrier-service/${token}`, {
      method: init.method ?? "POST",
      headers: { "Content-Type": "application/json", ...init.headers },
      body: init.method === "GET" ? undefined : (init.body ?? JSON.stringify(body)),
    });
    return action({ request, params: { token }, context: {} } as unknown as ActionFunctionArgs);
  };

  beforeEach(async () => {
    clearCheckoutRatesCache();
    vi.restoreAllMocks();
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    carrierImpl = async () => quotes;
    carrierCalls.length = 0;
    h.env = { DEMO_MODE: false, shopifyConfigured: true, SHOPIFY_API_SECRET: SECRET, SHOPIFY_APP_URL: APP_URL };
    h.runtimeError = null;
    h.runtime = { handle: { db: handle.db }, carriers: createCarrierRegistry([adapter], adapter.code) };
    await installShop("write_shipping");
    await handle.db.delete(settingsHistory);
    await handle.db.delete(settings);
    const r = await updateSetting(handle.db, OWNER, "checkoutRates", {
      ...DEFAULT_SETTINGS.checkoutRates,
      enabled: true,
      fxRates: [{ currency: "EUR", rate: "45" }],
    });
    if (!r.ok) throw new Error("settings");
  });

  it("OK: 200 JSON with rates", async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(await res.json()).toEqual({
      rates: [
        {
          service_name: "Standard",
          description: "Fake Post · Standard",
          service_code: "fake_post_standard",
          currency: "EUR",
          total_price: "2000",
          phone_required: true,
        },
      ],
    });
    expect(carrierCalls).toHaveLength(1);
  });

  it("action itself does not look at Origin: no header and a foreign one both work", async () => {
    expect((await call()).status).toBe(200);
    expect((await call({ headers: { Origin: "https://shopify.example" } })).status).toBe(200);
  });

  it("through React Router's request handler: resource route is not subject to the Origin (CSRF) check", async () => {
    const routeModule = await import("~/routes/carrier-service");
    const handleError = vi.fn();
    // Мінімальна збірка: корінь (сторінка), наш ресурсний маршрут і контрольна сторінка з action.
    const build = {
      routes: {
        root: { id: "root", path: "", module: { default: () => null } },
        "routes/carrier-service": { id: "routes/carrier-service", parentId: "root", path: "carrier-service/:token", module: routeModule },
        "routes/probe": { id: "routes/probe", parentId: "root", path: "probe", module: { default: () => null, action: () => ({ ok: true }) } },
      },
      entry: { module: { default: () => new Response("document"), handleError } },
      assets: { routes: {}, version: "test", entry: { module: "", imports: [] }, url: "" },
      basename: "/",
      publicPath: "/",
      assetsBuildDirectory: "",
      future: {},
      ssr: true,
      isSpaMode: false,
      prerender: [],
      routeDiscovery: { mode: "initial", manifestPath: "/__manifest" },
    } as unknown as ServerBuild;
    const handler = createRequestHandler(build, "test");
    const post = (path: string, headers: Record<string, string> = {}) =>
      handler(
        new Request(`https://logistics.example.com${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify(body),
        }),
      );

    // Shopify: сервер-сервер, без Origin
    const noOrigin = await post(`/carrier-service/${TOKEN}`);
    expect(noOrigin.status).toBe(200);
    expect(await noOrigin.json()).toMatchObject({ rates: [{ service_code: "fake_post_standard", total_price: "2000" }] });
    // чужий Origin теж не відхиляється (ресурсний маршрут)
    const foreign = await post(`/carrier-service/${TOKEN}`, { Origin: "https://shopify.example" });
    expect(foreign.status).toBe(200);
    // контроль: та сама збірка відхиляє чужий Origin для сторінки з action — перевірка в обробнику справді є
    expect((await post("/probe", { Origin: "https://shopify.example" })).status).toBe(400);
    expect(handleError).toHaveBeenCalledTimes(1);
    // неправильний токен — 404 і через обробник React Router
    expect((await post(`/carrier-service/${carrierServiceToken("wrong-secret", SHOP)}`)).status).toBe(404);
    // другий однаковий запит — з кешу тарифів
    expect(carrierCalls).toHaveLength(1);
  });

  it("wrong method → 405 (loader and action)", async () => {
    const { loader } = await import("~/routes/carrier-service");
    const res = loader();
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect((await call({ method: "PUT" })).status).toBe(405);
    expect((await call({ method: "DELETE" })).status).toBe(405);
  });

  it("token mismatch / malformed token / other shop → 404 without calling the carrier", async () => {
    expect((await call({ token: carrierServiceToken(SECRET, "other.myshopify.com") })).status).toBe(404);
    expect((await call({ token: carrierServiceToken("wrong-secret", SHOP) })).status).toBe(404);
    expect((await call({ token: "short" })).status).toBe(404);
    expect((await call({ token: `${TOKEN}x` })).status).toBe(404);
    expect(carrierCalls).toHaveLength(0);
  });

  it("demo mode, Shopify not configured, app not installed → 404", async () => {
    h.env = { ...h.env, DEMO_MODE: true };
    expect((await call()).status).toBe(404);
    h.env = { DEMO_MODE: false, shopifyConfigured: false, SHOPIFY_API_SECRET: SECRET };
    expect((await call()).status).toBe(404);
    h.env = { DEMO_MODE: false, shopifyConfigured: true, SHOPIFY_API_SECRET: SECRET };
    await handle.db.delete(shopInstallations);
    expect((await call()).status).toBe(404);
    expect(carrierCalls).toHaveLength(0);
  });

  it("oversized body → 413 (by Content-Length and by actual size)", async () => {
    expect((await call({ headers: { "Content-Length": String(300 * 1024) } })).status).toBe(413);
    const big = JSON.stringify({ ...body, padding: "x".repeat(300 * 1024) });
    expect((await call({ body: big })).status).toBe(413);
    // заголовок бреше (менший за тіло) — рахуємо фактичні байти
    expect((await call({ body: big, headers: { "Content-Length": "100" } })).status).toBe(413);
    expect((await call({ headers: { "Content-Length": "abc" } })).status).toBe(400);
    expect(carrierCalls).toHaveLength(0);
  });

  it("bad JSON or wrong structure → 400", async () => {
    expect((await call({ body: "{not json" })).status).toBe(400);
    expect((await call({ body: "" })).status).toBe(400);
    expect((await call({ body: JSON.stringify({ rate: { items: [] } }) })).status).toBe(400);
    expect((await call({ body: JSON.stringify([1, 2]) })).status).toBe(400);
    expect(carrierCalls).toHaveLength(0);
  });

  it("carrier failure → 503 { rates: [] }; internal failure → 503 { rates: [] }", async () => {
    carrierImpl = async () => {
      throw new CarrierError("unknown_outcome", "fake_post", "timeout");
    };
    const res = await call();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ rates: [] });

    h.runtimeError = new Error("db down");
    const res2 = await call();
    expect(res2.status).toBe(503);
    expect(await res2.json()).toEqual({ rates: [] });
  });

  it("disabled in settings → 200 { rates: [] }", async () => {
    const r = await updateSetting(handle.db, OWNER, "checkoutRates", { ...DEFAULT_SETTINGS.checkoutRates, enabled: false });
    if (!r.ok) throw new Error("settings");
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ rates: [] });
  });
});

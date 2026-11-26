import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { PERMISSIONS } from "~/domain/permissions";
import { createCarrierRegistry } from "~/integrations/carriers/registry";
import type { CarrierAdapter, CarrierCapabilities, RateQuote, RateRequest } from "~/integrations/carriers/types";
import { DICTIONARIES } from "~/i18n";
import { resetEnvCache } from "~/lib/env.server";
import { JOB } from "~/modules/shopify-sync/sync.server";
import { DEFAULT_SETTINGS } from "~/modules/settings/schema";
import { getSetting } from "~/modules/settings/settings.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Налаштування етапу 3 (/demo/settings): митні документи, Nova Post, розрахунок доставки в Checkout
 * (збереження, тестовий розрахунок, підключення), відстеження, реквізити відправника.
 * Справжні запити до демо-середовища (PGlite у пам'яті); перевізники — підроблені, без мережі.
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/settings");
let sync: typeof import("~/pages/shopify-sync");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/settings");
  sync = await import("~/pages/shopify-sync");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

const URL_ = "http://localhost/demo/settings";
type Fields = Record<string, string | string[]>;

async function headers(role?: "owner" | "staff"): Promise<HeadersInit> {
  return role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
}

async function load() {
  return page.loader({ request: new Request(URL_, { headers: await headers("owner") }), params: {}, context: {} } as never);
}

function formData(fields: Fields): FormData {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const item of Array.isArray(v) ? v : [v]) body.append(k, item);
  }
  return body;
}

async function act(fields: Fields, role: "owner" | "staff" = "owner") {
  const request = new Request(URL_, { method: "POST", body: formData(fields), headers: await headers(role) });
  return page.action({ request, params: {}, context: {} } as never);
}

const errorsOf = (r: Awaited<ReturnType<typeof act>>) => (r.ok ? {} : (r.fieldErrors ?? {}));

/** Серверний рендер сторінки (root → demo-layout → сторінка), як у settings.test.ts. */
async function render(fields?: Fields): Promise<string> {
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
  const request = new Request(URL_, { method: fields ? "POST" : "GET", body: fields ? formData(fields) : undefined });
  const context = await handler.query(request);
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

/** Видимий текст (без даних гідратації в <script>), з декодованими сутностями. */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

async function db() {
  return (await getDemoRuntime()).handle.db;
}

// ---------------------------------------------------------------- підроблені перевізники

const CAPS: CarrierCapabilities = {
  rates: true,
  availability: false,
  createShipment: false,
  updateShipment: false,
  cancelShipment: true,
  documents: true,
  tracking: true,
  returns: false,
  findByReference: true,
  referenceLookupAuthoritative: false,
};

function fakeCarrier(code: string, quotes: () => Promise<RateQuote[]>, caps: Partial<CarrierCapabilities> = {}) {
  const calls: RateRequest[] = [];
  const adapter: CarrierAdapter = {
    code,
    displayName: code === "nova_post" ? "Nova Post" : "Fake Rates",
    mode: "live",
    capabilities: { ...CAPS, ...caps },
    createShipment: async () => {
      throw new Error("must not be called");
    },
    findShipmentByReference: async () => ({ found: false, authoritative: false }),
    cancelShipment: async () => ({ cancelled: false }),
    quoteRates: async (req) => {
      calls.push(structuredClone(req));
      return quotes();
    },
  };
  return { adapter, calls };
}

/** Тимчасово додає перевізника в демо-реєстр (і робить його перевізником за замовчуванням). */
async function withCarrier<T>(adapter: CarrierAdapter, fn: () => Promise<T>): Promise<T> {
  const runtime = await getDemoRuntime();
  const original = runtime.carriers;
  runtime.carriers = createCarrierRegistry([...original.list(), adapter], adapter.code);
  try {
    return await fn();
  } finally {
    runtime.carriers = original;
  }
}

const QUOTE: RateQuote = {
  serviceCode: "standard",
  serviceName: "Standard",
  price: { amount: "910.00", currency: "UAH" },
  minDeliveryDays: 5,
  maxDeliveryDays: 9,
  estimatedDeliveryDate: "2026-12-03",
};

// ---------------------------------------------------------------- loader

describe("stage 3 settings: loader", () => {
  it("returns the new sections with versions, honest demo state and no secrets", async () => {
    const data = await load();
    expect(data.customs.value).toEqual(DEFAULT_SETTINGS.customs);
    expect(data.checkoutRates.value).toEqual(DEFAULT_SETTINGS.checkoutRates);
    expect(data.checkoutRates.baseCurrency).toBe("UAH");
    expect(data.tracking.value).toEqual(DEFAULT_SETTINGS.tracking);
    for (const s of [data.customs, data.checkoutRates, data.tracking]) expect(s.version).toBeGreaterThan(0);
    // Nova Post у демо прихований; підключення до Checkout — лише у вбудованому застосунку.
    expect(data.novaPost).toBeNull();
    expect(data.checkoutConnection).toEqual({ kind: "demo" });
    expect(data.integrations.novaPost).toEqual({
      registered: false,
      isDefault: false,
      apiKeyConfigured: null,
      apiHost: null,
      capabilities: null,
    });
    expect(data.options.deliveryTypes).toEqual(["", "standard", "economy", "express"]);
    expect(data.options.payerTypes).toEqual(["Sender", "Recipient", "ThirdPerson"]);
    const json = JSON.stringify(data);
    for (const [name, value] of Object.entries(process.env)) {
      if (/SECRET|KEY|TOKEN|PASSWORD|DATABASE_URL/i.test(name) && value && value.length >= 8) {
        expect(json.includes(value), name).toBe(false);
      }
    }
  });

  it("shows the Nova Post section and its creation status when a nova_post carrier is registered", async () => {
    const { adapter } = fakeCarrier("nova_post", async () => []);
    const data = await withCarrier(adapter, load);
    expect(data.novaPost).toMatchObject({ value: DEFAULT_SETTINGS.novaPost, registered: true, shipmentsEnabled: false });
    expect(data.integrations.novaPost).toMatchObject({
      registered: true,
      isDefault: true,
      capabilities: { rates: true, documents: true, tracking: true, createShipment: false, cancelShipment: true },
    });
    // Nova Post не дублюється у загальному списку перевізників.
    expect(data.integrations.carriers.map((c) => c.code)).not.toContain("nova_post");
  });

  it("every dynamic i18n key of the new sections exists in both languages", async () => {
    const data = await load();
    const keys = [
      ...data.options.incoterms.map((v) => `settings.customs.incoterm.${v}`),
      ...data.options.exportReasons.map((v) => `settings.customs.exportReason.${v}`),
      ...data.options.invoiceTypes.map((v) => `settings.customs.invoiceType.${v}`),
      ...data.options.payerTypes.map((v) => `settings.novaPost.payerType.${v}`),
      ...data.options.deliveryTypes.filter(Boolean).map((v) => `settings.novaPost.deliveryType.${v}`),
      ...data.options.roundingModes.map((v) => `settings.checkoutRates.rounding.${v}`),
      ...[
        "no_fx_rate",
        "unsupported_currency",
        "no_rates_carrier",
        "origin_not_configured",
        "invalid_weight",
        "carrier_error",
        "carrier_timeout",
        "no_quotes",
        "no_priced_quotes",
      ].map((r) => `settings.checkoutRates.reason.${r}`),
      ...["no_fx_rate", "invalid_price", "unsupported_currency"].map((f) => `settings.checkoutRates.failure.${f}`),
      ...["auth", "rejected", "unavailable", "unknown_outcome", "not_supported", "not_configured", "timeout", "unexpected"].map(
        (k) => `settings.checkoutRates.errorKind.${k}`,
      ),
      ...["not_configured", "not_installed", "missing_scope"].map((r) => `settings.checkoutConnection.reason.${r}`),
      ...["created", "updated", "unchanged"].map((r) => `settings.checkoutConnection.enable.${r}`),
      ...["deactivated", "deleted", "not_found", "unchanged"].map((r) => `settings.checkoutConnection.disable.${r}`),
      ...Object.keys(data.shipper.value).map((f) => `settings.shipper.field.${f}`),
      ...["rates", "documents", "tracking", "createShipment", "cancelShipment"].map((k) => `settings.integrations.capability.${k}`),
      // Сторінка «Синхронізація Shopify»: назви всіх типів фонових завдань і дозволи етапу 3.
      ...Object.keys(JOB).map((k) => `shopify.jobs.type.${k}`),
      ...sync.STAGE3_SCOPES.map((s) => `shopify.scopes.purpose.${s}`),
      // Коди помилок сервісу CarrierService, які показує банер дії.
      "carrierService.shopifyError",
      "carrierService.invalidAppUrl",
      "carrierService.httpsRequired",
    ];
    for (const locale of ["uk", "en"] as const) {
      expect(keys.filter((k) => !(k in DICTIONARIES[locale])), locale).toEqual([]);
    }
  });

  it("shopify-sync lists exactly the stage 3 scopes from shopify.app.toml", async () => {
    const fs = await import("node:fs");
    const toml = fs.readFileSync("shopify.app.toml", "utf8");
    const scopes = /\nscopes\s*=\s*"([^"]+)"/.exec(toml)?.[1]?.split(",") ?? [];
    for (const s of sync.STAGE3_SCOPES) expect(scopes).toContain(s);
  });
});

// ---------------------------------------------------------------- дії

describe("stage 3 settings: saving sections (owner)", () => {
  it("customs: saves, validates and detects stale versions", async () => {
    const { version } = (await load()).customs;
    const base = { intent: "saveCustoms", expectedVersion: String(version) };
    const bad = await act({ ...base, incoterm: "EXW", exportReason: "sale", invoiceType: "commercial" });
    expect(bad).toMatchObject({ ok: false, error: "error.validation", intent: "saveCustoms" });
    expect(Object.keys(errorsOf(bad))).toEqual(["incoterm"]);

    const ok = await act({ ...base, incoterm: "DDP", exportReason: "return", invoiceType: "proforma" });
    expect(ok).toEqual({ ok: true, message: "result.settings.saved", intent: "saveCustoms" });
    expect(await getSetting(await db(), "customs")).toEqual({ incoterm: "DDP", exportReason: "return", invoiceType: "proforma" });
    expect((await load()).customs.version).toBe(version + 1);

    const stale = await act({ ...base, incoterm: "DAP", exportReason: "sale", invoiceType: "commercial" });
    expect(stale).toMatchObject({ ok: false, error: "error.conflict" });
  });

  it("shipper: tax ID, EORI and IOSS are validated and normalized", async () => {
    const { value, version } = (await load()).shipper;
    const fields = { ...value, intent: "saveShipper", expectedVersion: String(version) };
    const bad = await act({ ...fields, taxId: "1234", eori: "12", ioss: "IM12" });
    expect(Object.keys(errorsOf(bad)).sort()).toEqual(["eori", "ioss", "taxId"]);

    expect(await act({ ...fields, taxId: " 12345678 ", eori: "ua12345678", ioss: "im1234567890" })).toMatchObject({ ok: true });
    expect(await getSetting(await db(), "shipper")).toMatchObject({ taxId: "12345678", eori: "UA12345678", ioss: "IM1234567890" });
  });

  it("novaPost: ThirdPerson requires a contract; other rules; saves without the carrier registered", async () => {
    const { adapter } = fakeCarrier("nova_post", async () => []);
    const section = (await withCarrier(adapter, load)).novaPost;
    expect(section?.value).toEqual(DEFAULT_SETTINGS.novaPost);
    const version = section?.version ?? 0;
    const base = { intent: "saveNovaPost", expectedVersion: String(version), deliveryType: "", tariffCurrency: "UAH" };

    const noContract = await act({ ...base, payerType: "ThirdPerson", payerContractNumber: "  " });
    expect(noContract).toMatchObject({ ok: false, error: "error.validation", intent: "saveNovaPost" });
    expect(errorsOf(noContract)).toEqual({ payerContractNumber: "required" });
    expect(await getSetting(await db(), "novaPost")).toEqual(DEFAULT_SETTINGS.novaPost);

    const several = await act({ ...base, payerType: "Boss", payerContractNumber: "X", deliveryType: "turbo", tariffCurrency: "hryvnia" });
    expect(Object.keys(errorsOf(several)).sort()).toEqual(["deliveryType", "payerContractNumber", "payerType", "tariffCurrency"]);
    expect(errorsOf(several).payerContractNumber).toBe("length");

    const ok = await act({ ...base, payerType: "ThirdPerson", payerContractNumber: " 12345/2026 ", deliveryType: "economy", tariffCurrency: "uah" });
    expect(ok).toMatchObject({ ok: true, message: "result.settings.saved", intent: "saveNovaPost" });
    expect(await getSetting(await db(), "novaPost")).toEqual({
      payerType: "ThirdPerson",
      payerContractNumber: "12345/2026",
      deliveryType: "economy",
      tariffCurrency: "UAH",
    });
  });

  it("checkoutRates: parses FX rows (skips empty rows, comma decimals, upper-case codes) and persists", async () => {
    const { version } = (await load()).checkoutRates;
    const r = await act({
      intent: "saveCheckoutRates",
      expectedVersion: String(version),
      enabled: "on",
      markupPercent: "10,5",
      markupFixed: "45,5",
      rounding: "up_99",
      serviceName: "  Доставка Nova Post  ",
      fxCurrency: ["eur", "", " usd "],
      fxRate: ["45,50", "", "41.2"],
    });
    expect(r).toEqual({ ok: true, message: "result.settings.saved", intent: "saveCheckoutRates" });
    expect(await getSetting(await db(), "checkoutRates")).toEqual({
      enabled: true,
      markupPercent: 10.5,
      markupFixed: "45.5",
      rounding: "up_99",
      serviceName: "Доставка Nova Post",
      fxRates: [
        { currency: "EUR", rate: "45.50" },
        { currency: "USD", rate: "41.2" },
      ],
    });
    const data = await load();
    expect(data.checkoutRates.value.fxRates).toHaveLength(2);
  });

  it("checkoutRates: row errors point at the form row; duplicates, base currency, zero and too many rows", async () => {
    const { version } = (await load()).checkoutRates;
    const base = {
      intent: "saveCheckoutRates",
      expectedVersion: String(version),
      markupPercent: "0",
      markupFixed: "0.00",
      rounding: "none",
      serviceName: "",
    };
    // Рядок 1 порожній: помилка рядка 2 має шлях fxRates.2.*, а не fxRates.1.* (індекс у збереженому масиві).
    const shifted = await act({ ...base, fxCurrency: ["EUR", "", "USD"], fxRate: ["45", "", "4x"] });
    expect(errorsOf(shifted)).toEqual({ "fxRates.2.rate": expect.any(String) });

    const rules = await act({ ...base, fxCurrency: ["EUR", "eur", "UAH", "PLN"], fxRate: ["45", "46", "1", "0.000"] });
    expect(errorsOf(rules)).toEqual({
      "fxRates.1.currency": "duplicate",
      "fxRates.2.currency": "base",
      "fxRates.3.rate": "zero",
    });

    const tooMany = Array.from({ length: 21 }, (_, i) => `C${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`);
    const many = await act({ ...base, fxCurrency: tooMany, fxRate: tooMany.map(() => "1.5") });
    expect(errorsOf(many)).toHaveProperty("fxRates");

    const badMarkup = await act({ ...base, markupPercent: "250", markupFixed: "1.234", fxCurrency: [""], fxRate: [""] });
    expect(Object.keys(errorsOf(badMarkup)).sort()).toEqual(["markupFixed", "markupPercent"]);
    // Нічого з цього не збережено.
    expect((await load()).checkoutRates.version).toBe(version);
  });

  it("tracking: saves, validates interval and the https…{number} template", async () => {
    const { version } = (await load()).tracking;
    const base = { intent: "saveTracking", expectedVersion: String(version), enabled: "on", pushToShopify: "on" };
    const bad = await act({ ...base, intervalMinutes: "10", trackingUrlTemplate: "http://track.example/{number}" });
    expect(Object.keys(errorsOf(bad)).sort()).toEqual(["intervalMinutes", "trackingUrlTemplate"]);
    const noPlaceholder = await act({ ...base, intervalMinutes: "120", trackingUrlTemplate: "https://track.example/" });
    expect(Object.keys(errorsOf(noPlaceholder))).toEqual(["trackingUrlTemplate"]);

    const ok = await act({ ...base, intervalMinutes: "120", notifyCustomer: "on", trackingUrlTemplate: "https://track.example/?n={number}" });
    expect(ok).toMatchObject({ ok: true, intent: "saveTracking" });
    expect(await getSetting(await db(), "tracking")).toEqual({
      enabled: true,
      intervalMinutes: 120,
      pushToShopify: true,
      notifyCustomer: true,
      trackingUrlTemplate: "https://track.example/?n={number}",
    });
  });
});

describe("stage 3 settings: test calculation and Checkout connection", () => {
  const previewFields = {
    intent: "previewRates",
    countryCode: "de",
    postalCode: "10115",
    city: "Berlin",
    province: "",
    weightGrams: "800",
    value: "49,90",
    currency: "eur",
  };

  it("previewRates returns quotes from a fake rates carrier (carrier, converted and checkout prices)", async () => {
    // Курс EUR 45.50, націнка 10,5 %, надбавка 45.50 UAH (= 1 EUR), округлення до .99 — збережено раніше.
    const { adapter, calls } = fakeCarrier("fake_rates", async () => [QUOTE]);
    const r = await withCarrier(adapter, () => act(previewFields));
    expect(r).toMatchObject({ ok: true, message: "settings.checkoutRates.preview.ok", params: { count: 1 }, intent: "previewRates" });
    if (!r.ok || !r.preview) throw new Error("expected a preview");
    expect(r.preview).toMatchObject({ reason: null, rateCount: 1, carrier: { code: "fake_rates", displayName: "Fake Rates" } });
    expect(r.preview.quotes).toEqual([
      expect.objectContaining({
        serviceName: "Standard",
        shopifyServiceCode: "fake_rates_standard",
        carrierPrice: { amount: "910.00", currency: "UAH" },
        // 910 / 45.5 = 20.00 EUR; × 1.105 = 22.10; + 45.50 UAH / 45.5 = 1.00 → 23.10 → 23.99
        convertedPrice: { amount: "20.00", currency: "EUR" },
        checkoutPrice: { amount: "23.99", currency: "EUR" },
        failure: null,
      }),
    ]);
    // Адреса й вартість дійшли до перевізника у нормалізованому вигляді; накладна не створюється.
    expect(calls[0]).toMatchObject({ destination: { countryCode: "DE", postalCode: "10115" }, declaredValue: { amount: "49.90", currency: "EUR" } });
  });

  it("previewRates explains why nothing is shown and validates input", async () => {
    // Демо: тестовий перевізник не рахує вартість.
    const none = await act(previewFields);
    expect(none).toMatchObject({ ok: true, preview: { reason: "no_rates_carrier", quotes: [], rateCount: 0 } });

    const { adapter } = fakeCarrier("fake_rates", async () => [QUOTE]);
    const noRate = await withCarrier(adapter, () => act({ ...previewFields, currency: "JPY" }));
    expect(noRate).toMatchObject({ ok: true, preview: { reason: "no_fx_rate" } });

    const bad = await act({ ...previewFields, countryCode: "Germany", weightGrams: "abc", value: "1.234" });
    expect(bad).toMatchObject({ ok: false, error: "error.validation", intent: "previewRates" });
    expect(Object.keys(errorsOf(bad)).sort()).toEqual(["countryCode", "value", "weightGrams"]);
  });

  it("Checkout connection intents return not_configured in the demo", async () => {
    for (const intent of ["enableCheckout", "disableCheckout"]) {
      expect(await act({ intent }), intent).toEqual({
        ok: false,
        error: "settings.checkoutConnection.reason.not_configured",
        intent,
      });
    }
  });

  it("staff cannot save the new sections, run the test calculation or connect Checkout", async () => {
    const intents = ["saveCustoms", "saveNovaPost", "saveCheckoutRates", "saveTracking", "previewRates", "enableCheckout", "disableCheckout"];
    const before = await load();
    for (const intent of intents) {
      expect(await act({ ...previewFields, intent, expectedVersion: "1", payerType: "Sender" }, "staff"), intent).toMatchObject({
        ok: false,
        error: "error.forbidden",
        intent,
      });
    }
    const after = await load();
    expect(after.customs.version).toBe(before.customs.version);
    expect(after.checkoutRates.version).toBe(before.checkoutRates.version);
    expect(after.tracking.version).toBe(before.tracking.version);
  });
});

// ---------------------------------------------------------------- рендер

describe("stage 3 settings: page render", () => {
  it("renders the new sections in Ukrainian; Nova Post hidden in the demo; Checkout connection explained", async () => {
    const html = visible(await render());
    for (const key of [
      "settings.shipper.customsTitle",
      "settings.shipper.field.taxId",
      "settings.shipper.help.carrierBranch",
      "settings.customs.title",
      "settings.customs.hsNote",
      "settings.checkoutRates.title",
      "settings.checkoutRates.fx.title",
      "settings.checkoutRates.preview.title",
      "settings.checkoutConnection.demo",
      "settings.tracking.title",
      "settings.tracking.notifyWarning",
      "settings.integrations.novaPost.demo",
    ]) {
      expect(html, key).toContain(DICTIONARIES.uk[key]);
    }
    expect(DICTIONARIES.uk["settings.shipper.help.carrierBranch"]).toContain("32521/1");
    expect(html).not.toContain(DICTIONARIES.uk["settings.novaPost.payerType"]);
    expect(html).not.toContain(DICTIONARIES.uk["settings.checkoutConnection.enable.button"]);
    // Збережені курси — рядки таблиці.
    expect(html).toContain('name="fxCurrency"');
    expect(html).toContain('value="45.50"');
    expect(html).not.toMatch(/>\s*(settings|shopify|carrierService)\.[a-zA-Z_.]+\s*</);
  });

  it("renders the Nova Post section with the creation status and the ThirdPerson field error", async () => {
    const { adapter } = fakeCarrier("nova_post", async () => []);
    const html = await withCarrier(adapter, async () => {
      const { value, version } = (await load()).novaPost!;
      return visible(
        await render({ ...value, intent: "saveNovaPost", expectedVersion: String(version), payerType: "ThirdPerson", payerContractNumber: "" }),
      );
    });
    expect(html).toContain(DICTIONARIES.uk["settings.novaPost.title"]);
    expect(html).toContain(DICTIONARIES.uk["settings.novaPost.creation.disabledHelp"]);
    expect(html).toContain("NOVA_POST_SHIPMENTS_ENABLED=true");
    expect(html).toContain(DICTIONARIES.uk["settings.novaPost.error.contractRequired"]);
    expect(html).toContain(DICTIONARIES.uk["settings.integrations.status.creationDisabled"]);
  });

  it("renders the test calculation table and localized FX row errors", async () => {
    const { adapter } = fakeCarrier("fake_rates", async () => [QUOTE]);
    const html = await withCarrier(adapter, async () => visible(await render(previewFieldsForRender())));
    expect(html).toContain(DICTIONARIES.uk["settings.checkoutRates.preview.col.checkoutPrice"]);
    expect(html).toContain("fake_rates_standard");
    expect(html).toMatch(/23[.,]99/);

    const { version } = (await load()).checkoutRates;
    const errors = visible(
      await render({
        intent: "saveCheckoutRates",
        expectedVersion: String(version),
        markupPercent: "0",
        markupFixed: "0",
        rounding: "none",
        serviceName: "",
        fxCurrency: ["EUR", "EUR"],
        fxRate: ["45", "abc"],
      }),
    );
    expect(errors).toContain(DICTIONARIES.uk["settings.checkoutRates.error.fxDuplicate"]);
    expect(errors).toContain(DICTIONARIES.uk["settings.checkoutRates.error.fxRate"]);
  });
});

function previewFieldsForRender(): Fields {
  return { intent: "previewRates", countryCode: "DE", postalCode: "10115", city: "Berlin", province: "", weightGrams: "800", value: "49.90", currency: "EUR" };
}

import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { orderLineItems, orders, productVariants } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import type { MappedProduct } from "~/modules/shopify-sync/mappers";
import { upsertProduct } from "~/modules/shopify-sync/sync.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Розділ «Товари» (/demo/products, /app/products) і форма митних даних на сторінці замовлення в робочому режимі.
 * Контекст запиту підмінено (демо або робочий, після authenticate.admin) — база PGlite з демо-даними.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/products");
let orderPage: typeof import("~/pages/order-detail");

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/products");
  orderPage = await import("~/pages/order-detail");
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

async function load(search = "") {
  return page.loader({ request: new Request(`${base()}/products${search}`), params: {}, context: {} } as never);
}

async function act(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return page.action({ request: new Request(`${base()}/products`, { method: "POST", body }), params: {}, context: {} } as never);
}

async function loaderStatus(search = ""): Promise<number> {
  try {
    await load(search);
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

const EMPTY_FORM = {
  hsCode: "",
  countryOfOrigin: "",
  customsDescription: "",
  customsDescriptionLocal: "",
  material: "",
  weightGrams: "",
  lengthMm: "",
  widthMm: "",
  heightMm: "",
};

async function variantIdBySku(sku: string): Promise<string> {
  const [row] = await env.handle.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, sku));
  if (!row) throw new Error(`variant ${sku} not found`);
  return row.id;
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
        {
          id: layoutId,
          path: mode === "demo" ? "demo" : "app",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", ...route }],
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

describe("products loader", () => {
  it("lists all demo variants with product data and effective values", async () => {
    const data = await load();
    expect(data.isDemo).toBe(true);
    expect(data.total).toBe(9);
    expect(data.rows).toHaveLength(9);
    expect(data.pageSize).toBe(50);
    expect(data.pages).toBe(1);
    const holder = data.rows.find((r) => r.sku === "OT-PH-BLK");
    expect(holder).toMatchObject({
      productTitle: "Тримач телефону Pro",
      variantTitle: "Чорний",
      overriddenFields: [],
      overrides: {},
      effective: { hsCode: "8714.10", countryOfOrigin: "UA", weightGrams: 120 },
      shopify: { hsCode: "8714.10", weightGrams: 120 },
    });
    expect(holder?.imageUrl).toBeTruthy();
    expect(holder?.originName).toBeTruthy();
  });

  it("searches by title and SKU and escapes LIKE wildcards", async () => {
    expect((await load("?q=OT-GR")).rows.map((r) => r.sku).sort()).toEqual(["OT-GR-BLK", "OT-GR-GRY"]);
    expect((await load("?q=" + encodeURIComponent("покришка"))).rows.map((r) => r.sku)).toEqual(["OT-TR-1025"]);
    expect((await load("?q=%25")).total).toBe(0);
    expect((await load("?q=_")).total).toBe(0);
  });

  it("filters variants with missing customs data and paginates past the end to the last page", async () => {
    const data = await load("?missing=1");
    expect(data.rows.map((r) => r.sku)).toEqual(["OT-TR-1025"]);
    expect(data.missingTotal).toBe(1);
    expect(data.isFiltered).toBe(true);
    expect((await load("?page=99")).page).toBe(1);
  });

  it("requires orders.view", async () => {
    setContext(makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["orders.view"] } }));
    expect(await loaderStatus()).toBe(403);
  });
});

describe("products action", () => {
  it("staff (orders.edit) saves overrides; the filter and effective values follow; revalidated count is reported", async () => {
    setContext(STAFF);
    const id = await variantIdBySku("OT-TR-1025");
    const res = await act({
      intent: "updateVariant",
      variantId: id,
      ...EMPTY_FORM,
      hsCode: "4011.40.00",
      customsDescription: "Scooter tire 10x2.5",
      customsDescriptionLocal: "Покришка для самоката",
      material: "Rubber",
      lengthMm: "260",
      widthMm: "260",
      heightMm: "65",
    });
    expect(res).toMatchObject({ ok: true, message: "result.product.updated", variantId: id });
    expect(res.ok && typeof res.params?.count).toBe("number");

    const row = (await load("?q=OT-TR-1025")).rows[0];
    expect(row?.effective).toMatchObject({ hsCode: "40114000", customsDescription: "Scooter tire 10x2.5", material: "Rubber", lengthMm: 260 });
    expect(row?.shopify).toMatchObject({ hsCode: null, customsDescription: null, lengthMm: null });
    expect(row?.overriddenFields.sort()).toEqual(
      ["customsDescription", "customsDescriptionLocal", "heightMm", "hsCode", "lengthMm", "material", "widthMm"].sort(),
    );
    expect((await load("?missing=1")).total).toBe(0);

    // Порожні поля → повернення до значень Shopify/демо.
    expect(await act({ intent: "updateVariant", variantId: id, ...EMPTY_FORM })).toMatchObject({ ok: true });
    const reverted = (await load("?q=OT-TR-1025")).rows[0];
    expect(reverted?.overriddenFields).toEqual([]);
    expect(reverted?.effective.hsCode).toBeNull();
    expect((await load("?missing=1")).total).toBe(1);
  });

  it("rejects without orders.edit, unknown intents and unknown variants", async () => {
    setContext(makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["orders.edit"] } }));
    const id = await variantIdBySku("OT-PH-BLK");
    expect(await act({ intent: "updateVariant", variantId: id, ...EMPTY_FORM, hsCode: "87141000" })).toEqual({ ok: false, error: "error.forbidden" });
    const [variant] = await env.handle.db.select().from(productVariants).where(eq(productVariants.id, id));
    expect(variant?.customsOverrides).toBeNull();

    setContext(OWNER);
    expect(await act({ intent: "dropTables" })).toEqual({ ok: false, error: "error.generic" });
    expect(await act({ intent: "updateVariant", variantId: "x' or 1=1" })).toEqual({ ok: false, error: "error.notFound" });
    expect(await act({ intent: "updateVariant", variantId: "00000000-0000-4000-8000-000000000000", ...EMPTY_FORM })).toMatchObject({
      ok: false,
      error: "error.notFound",
    });
  });

  it("maps invalid fields to the form fields of the variant", async () => {
    const id = await variantIdBySku("OT-PH-WHT");
    const res = await act({ intent: "updateVariant", variantId: id, ...EMPTY_FORM, hsCode: "12AB", countryOfOrigin: "UKR", weightGrams: "0", heightMm: "abc" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("error.validation");
    expect(Object.keys(res.fieldErrors ?? {}).sort()).toEqual(
      [`variant.${id}.countryOfOrigin`, `variant.${id}.heightMm`, `variant.${id}.hsCode`, `variant.${id}.weightGrams`].sort(),
    );
    const [variant] = await env.handle.db.select().from(productVariants).where(eq(productVariants.id, id));
    expect(variant?.customsOverrides).toBeNull();
  });

  it("an override survives a Shopify product upsert; clearing it reverts to the new Shopify value", async () => {
    const mapped = (hsCode: string, weightGrams: number, updatedAt: string): MappedProduct => ({
      shopifyProductId: "gid://shopify/Product/9001",
      title: "Тестовий товар Shopify",
      handle: "test-shopify-product",
      status: "ACTIVE",
      imageUrl: null,
      shopifyUpdatedAt: new Date(updatedAt),
      variants: [
        {
          shopifyVariantId: "gid://shopify/ProductVariant/9001",
          title: "Default Title",
          sku: "SHOP-9001",
          barcode: null,
          color: null,
          model: null,
          price: "10.00",
          weightGrams,
          hsCode,
          countryOfOrigin: "UA",
          customsDescription: "Test item",
          customsDescriptionLocal: null,
          material: null,
          imageUrl: null,
          inventoryAvailable: null,
          inventoryItemId: null,
        },
      ],
    });
    expect(await upsertProduct(env.handle.db, mapped("871410", 200, "2026-11-01T10:00:00Z"), "EUR")).toBe("saved");
    const id = await variantIdBySku("SHOP-9001");

    setContext(OWNER, "production");
    expect(await act({ intent: "updateVariant", variantId: id, ...EMPTY_FORM, hsCode: "8714 1000", weightGrams: "500" })).toMatchObject({ ok: true });

    // Синхронізація Shopify: нові значення в Shopify, перевизначення не змінюються.
    expect(await upsertProduct(env.handle.db, mapped("871499", 250, "2026-11-02T10:00:00Z"), "EUR")).toBe("saved");
    let row = (await load("?q=SHOP-9001")).rows[0];
    expect(row?.variantTitle).toBe("");
    expect(row?.effective).toMatchObject({ hsCode: "87141000", weightGrams: 500, customsDescription: "Test item" });
    expect(row?.shopify).toMatchObject({ hsCode: "871499", weightGrams: 250 });
    expect(row?.overriddenFields.sort()).toEqual(["hsCode", "weightGrams"]);

    // Порожнє поле HS → значення з Shopify; вага лишається зміненою.
    expect(await act({ intent: "updateVariant", variantId: id, ...EMPTY_FORM, weightGrams: "500" })).toMatchObject({ ok: true });
    row = (await load("?q=SHOP-9001")).rows[0];
    expect(row?.effective).toMatchObject({ hsCode: "871499", weightGrams: 500 });
    expect(row?.overriddenFields).toEqual(["weightGrams"]);
  });
});

describe("products rendering", () => {
  const route = () => ({ path: "products", loader: page.loader, action: page.action, Component: page.default });

  it("demo: list, badges, edit form and demo wording", async () => {
    const id = await variantIdBySku("OT-LT-STD");
    expect(await act({ intent: "updateVariant", variantId: id, ...EMPTY_FORM, material: "Plastic" })).toMatchObject({ ok: true });
    const html = await render("/demo/products", route());
    expect(html).toContain("OT-LT-STD");
    expect(html).toContain(esc(uk("products.overridden")));
    expect(html).toContain(esc(uk("products.info.demo")));
    expect(html).toContain('name="customsDescriptionLocal"');
    expect(html).toContain('name="lengthMm"');
    expect(html).toContain(esc(uk("products.form.hsHelp")));
    expect(html).toContain(esc(uk("products.form.dimensionsHelp")));
    // 6-значний демо-код → попередження для Nova Post.
    expect(html).toContain(esc(uk("products.hsShort")));
  });

  it("production: explains priority over Shopify; no edit form without orders.edit", async () => {
    setContext(OWNER, "production");
    const html = await render("/app/products", route());
    expect(html).toContain(esc(uk("products.info.production")));
    expect(html).toContain(esc(uk("products.form.help.production")));
    expect(html).toContain('name="hsCode"');

    setContext(makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["orders.edit"] } }), "production");
    const readOnly = await render("/app/products", route());
    expect(readOnly).toContain("OT-PH-BLK");
    expect(readOnly).not.toContain('name="hsCode"');
  });
});

describe("order detail customs editor in production", () => {
  async function orderWithTire(): Promise<string> {
    const tire = await variantIdBySku("OT-TR-1025");
    const [line] = await env.handle.db
      .select({ orderId: orderLineItems.orderId })
      .from(orderLineItems)
      .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
      .where(eq(orderLineItems.variantId, tire));
    if (!line) throw new Error("no order with the tire");
    return line.orderId;
  }

  it("loader exposes all customs fields; updateVariant works; the form renders with a link to Products", async () => {
    setContext(STAFF, "production");
    const orderId = await orderWithTire();
    const request = (init?: RequestInit) => new Request(`http://localhost/app/orders/${orderId}`, init);
    const data = await orderPage.loader({ request: request(), params: { orderId }, context: {} } as never);
    expect(data.isDemo).toBe(false);
    const variant = data.items.find((i) => i.sku === "OT-TR-1025")?.variant;
    expect(variant).toMatchObject({
      customsDescriptionLocal: null,
      material: null,
      lengthMm: null,
      widthMm: null,
      heightMm: null,
      overriddenFields: [],
      overrides: {},
      shopify: { hsCode: null, weightGrams: 900 },
    });

    const body = new FormData();
    for (const [k, v] of Object.entries({ intent: "updateVariant", variantId: variant!.id, ...EMPTY_FORM, hsCode: "40114000", customsDescription: "Scooter tire", material: "Rubber" })) {
      body.set(k, v);
    }
    const res = await orderPage.action({ request: request({ method: "POST", body }), params: { orderId }, context: {} } as never);
    expect(res).toMatchObject({ ok: true, message: "result.product.updated" });

    const after = await orderPage.loader({ request: request(), params: { orderId }, context: {} } as never);
    const v2 = after.items.find((i) => i.sku === "OT-TR-1025")?.variant;
    expect(v2).toMatchObject({ hsCode: "40114000", material: "Rubber", overrides: { hsCode: "40114000", material: "Rubber" } });
    expect(v2?.overriddenFields.sort()).toEqual(["customsDescription", "hsCode", "material"]);

    expect(after.order.editable).toBe(true);
    const html = await render(`/app/orders/${orderId}`, {
      path: "orders/:orderId",
      loader: orderPage.loader,
      action: orderPage.action,
      Component: orderPage.default,
    });
    expect(html).toContain('name="customsDescriptionLocal"');
    expect(html).toContain(esc(uk("products.form.help.production")));
    expect(html).toContain('href="/app/products"');
    expect(html).toContain(esc(uk("products.overridden")));
    // Повернення до значень Shopify.
    const reset = new FormData();
    for (const [k, v] of Object.entries({ intent: "updateVariant", variantId: variant!.id, ...EMPTY_FORM })) reset.set(k, v);
    await orderPage.action({ request: request({ method: "POST", body: reset }), params: { orderId }, context: {} } as never);
  });
});

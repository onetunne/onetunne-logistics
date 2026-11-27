import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { kitTemplates, packagingMaterials, products } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/** «Склад» → «Комплектація» (/demo/warehouse/kits, /app/warehouse/kits): права, форма шаблону, перевірка на замовленні. */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/kits");
const material: Record<string, string> = {};
beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/kits");
  for (const row of await env.handle.db.select().from(packagingMaterials)) material[row.code] = row.id;
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER, mode: "demo" | "production" = "demo") {
  m.ctx = { ...env.ctx(actor), mode, basePath: mode === "demo" ? "/demo" : "/app", locale: "uk" };
}
beforeEach(() => setContext());

const base = () => (m.ctx?.mode === "production" ? "http://localhost/app" : "http://localhost/demo");
const load = (search = "") => page.loader({ request: new Request(`${base()}/warehouse/kits${search}`), params: {}, context: {} } as never);
async function act(fields: Record<string, string | string[]>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return page.action({ request: new Request(`${base()}/warehouse/kits`, { method: "POST", body }), params: {}, context: {} } as never);
}
async function status(search = ""): Promise<number> {
  try {
    await load(search);
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}
async function render(search = ""): Promise<string> {
  const mode = m.ctx?.mode ?? "demo";
  const actor = m.ctx?.actor ?? OWNER;
  const shell: ShellData = {
    mode,
    basePath: mode === "demo" ? "/demo" : "/app",
    actor: { id: actor.id, displayName: actor.displayName, role: actor.role, permissions: [...actor.permissions] },
    nav: [],
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
  const prefix = mode === "demo" ? "demo" : "app";
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: `routes/${prefix}-layout`,
          path: prefix,
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "warehouse/kits", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/${prefix}/warehouse/kits${search}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}
const uk = (key: string) => DICTIONARIES.uk[key]!;

async function fenderProduct() {
  const [p] = await env.handle.db.select({ id: products.id }).from(products).where(eq(products.handle, "rear-fender"));
  return p!.id;
}

describe("kits loader", () => {
  it("requires warehouse.view (403)", async () => {
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view"] } }), "production");
    expect(await status()).toBe(403);
    setContext(STAFF, "production");
    expect(await status()).toBe(200);
  });

  it("lists demo templates; staff cannot open the editor; filters by state, scope and model", async () => {
    setContext(STAFF);
    const data = await load("?edit=new");
    expect(data).toMatchObject({ canEdit: false, creating: false, editing: null, materials: [], productOptions: [] });
    expect(data.templates.map((t) => t.name).sort()).toEqual(["Крило: болти та інструкція", "Стандартний комплект"]);
    expect(data.counts).toEqual({ all: 2, active: 2, inactive: 0 });
    expect(data.models).toEqual(expect.arrayContaining(["Model S", "Model X"]));
    expect((await load("?applies=products")).templates.map((t) => t.name)).toEqual(["Крило: болти та інструкція"]);
    expect((await load("?model=Model%20X")).templates).toHaveLength(2); // «усі» шаблони підходять будь-якій моделі
    expect((await load("?model=10x2.5&applies=products")).templates).toEqual([]);
    expect((await load("?q=болти")).templates.map((t) => t.name)).toEqual(["Крило: болти та інструкція"]);
    expect((await load("?status=inactive")).templates).toEqual([]);
  });

  it("owner opens the editor with materials and product options", async () => {
    const [fender] = await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.appliesTo, "products"));
    const data = await load(`?edit=${fender!.id}`);
    expect(data.editing).toMatchObject({ id: fender!.id, appliesTo: "products" });
    expect(data.materials.map((x) => x.code)).toEqual(expect.arrayContaining(["bolts_m5", "box_m", "sticker_logo"]));
    expect(data.productOptions.find((p) => p.id === (data.editing?.products[0]?.id ?? ""))).toBeTruthy();
  });

  it("order check shows the combined kit and the suggested box (needs orders.view)", async () => {
    const data = await load("?order=1012");
    expect(data.check).toMatchObject({ found: true, orderNumber: "#1012", boxReason: "weight_only" });
    if (data.check?.found) expect(data.check.materials.map((x) => x.code).sort()).toEqual(["bolts_m5", "card_thanks", "instruction_fender", "sticker_logo"]);
    expect((await load("?order=%23424242")).check).toEqual({ found: false, query: "#424242" });
    setContext(makeActor({ id: "y", displayName: "Y", role: "staff", overrides: { revoke: ["orders.view"] } }));
    expect((await load("?order=1012")).check).toBeNull();
  });
});

describe("kits rendering", () => {
  it("owner: list, editor with lines and product picker, order check", async () => {
    const [fender] = await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.appliesTo, "products"));
    const html = await render(`?edit=${fender!.id}&order=1012`);
    expect(html).toContain(uk("packaging.kits.title"));
    expect(html).toContain("Крило: болти та інструкція");
    expect(html).toContain('name="lineMaterialId"');
    expect(html).toContain('name="productIds"');
    expect(html).toContain(uk("packaging.kits.delete"));
    expect(html).toContain(uk("packaging.check.title"));
    expect(html).toContain(uk("packaging.boxReason.weight_only"));
  });

  it("staff: read-only list", async () => {
    setContext(STAFF);
    const html = await render();
    expect(html).not.toContain(uk("packaging.kits.add"));
    expect(html).not.toContain('name="templateIds"');
    expect(html).toContain("Стандартний комплект");
  });
});

describe("kits actions", () => {
  it("owner creates a product template from form arrays; validation errors are field-bound", async () => {
    const fender = await fenderProduct();
    const created = await act({
      intent: "createKit",
      name: "Крило: наклейка на кожне",
      appliesTo: "products",
      priority: "3",
      active: "on",
      lineMaterialId: [material.sticker_logo!, ""],
      lineQuantity: ["2", "1"],
      linePer: ["item", "order"],
      productIds: [fender],
    });
    expect(created).toMatchObject({ ok: true, message: "packaging.kits.result.created" });
    const data = await load(`?edit=${created.templateId}`);
    expect(data.editing).toMatchObject({ priority: 3, appliesTo: "products", active: true });
    expect(data.editing?.lines.map((l) => [l.materialCode, l.quantity, l.per])).toEqual([["sticker_logo", 2, "item"]]);

    const noLines = await act({ intent: "createKit", name: "Порожній", appliesTo: "all", priority: "", lineMaterialId: [""], lineQuantity: ["1"], linePer: ["order"] });
    expect(noLines).toMatchObject({ ok: false, error: "error.validation", fieldErrors: { lines: "packaging.error.kitNoLines" } });
    const dup = await act({
      intent: "createKit",
      name: "Дубль",
      appliesTo: "all",
      lineMaterialId: [material.card_thanks!, material.card_thanks!],
      lineQuantity: ["1", "0"],
      linePer: ["order", "order"],
    });
    expect(dup).toMatchObject({ ok: false, fieldErrors: { "lines.1.materialId": "packaging.error.kitDuplicateLine", "lines.1.quantity": "packaging.error.range" } });

    // Порожній рядок редактора (без матеріалу) пропускається, але помилки — біля СВОГО рядка редактора.
    const shifted = await act({
      intent: "createKit",
      name: "Зсув",
      appliesTo: "all",
      lineMaterialId: ["", material.card_thanks!, "", material.card_thanks!],
      lineQuantity: ["1", "0", "5", "1"],
      linePer: ["order", "order", "order", "order"],
    });
    expect(shifted).toMatchObject({ ok: false, error: "error.validation" });
    expect(shifted.ok ? null : shifted.fieldErrors).toEqual({ "lines.1.quantity": "packaging.error.range", "lines.3.materialId": "packaging.error.kitDuplicateLine" });
  });

  it("update detects stale forms; delete and bulk enable/disable work; staff is forbidden", async () => {
    const [tpl] = await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.name, "Крило: наклейка на кожне"));
    const { editing } = await load(`?edit=${tpl!.id}`);
    const fields = {
      intent: "updateKit",
      templateId: tpl!.id,
      version: editing!.version,
      name: "Крило: наклейка",
      appliesTo: "products",
      priority: "3",
      lineMaterialId: [material.sticker_logo!],
      lineQuantity: ["1"],
      linePer: ["item"],
      productIds: [await fenderProduct()],
    };
    expect(await act(fields)).toMatchObject({ ok: true, message: "packaging.kits.result.updated" });
    expect(await act(fields)).toMatchObject({ ok: false, error: "error.conflict" });
    expect((await load(`?edit=${tpl!.id}`)).editing?.active).toBe(false); // прапорець «Активний» не надіслано

    setContext(STAFF);
    expect(await act({ ...fields, version: "1" })).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act({ intent: "deleteKit", templateId: tpl!.id })).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act({ intent: "setActive", active: "1", templateIds: [tpl!.id] })).toMatchObject({ ok: false, error: "error.forbidden" });

    setContext(OWNER);
    expect(await act({ intent: "setActive", active: "1", templateIds: [tpl!.id, "bad"] })).toMatchObject({ ok: true, params: { count: 1 } });
    expect(await act({ intent: "deleteKit", templateId: tpl!.id })).toMatchObject({ ok: true, message: "packaging.kits.result.deleted" });
    expect(await act({ intent: "deleteKit", templateId: tpl!.id })).toMatchObject({ ok: false, error: "error.notFound" });
  });
});

import { and, eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import fs from "node:fs";
import path from "node:path";
import { auditLog, collections, jobs, kitTemplateProducts, packagingMaterials, productVariants, products, shopInstallations } from "~/db/schema";
import { DICTIONARIES } from "~/i18n";
import { kitProductMatchesQuery } from "~/modules/packaging/kit-options";
import { MAX_KIT_PRODUCT_OPTIONS } from "~/modules/packaging/kits.server";
import { JOB } from "~/modules/shopify-sync/jobs";
import type { RequestContext } from "~/server/types";
import type { Actor } from "~/domain/permissions";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * «Комплектація»: великий каталог (production-6 — призначені товари поза лімітом списку не губляться при збереженні;
 * пошук у каталозі), шаблони на колекції й фільтр моделі/кольору у формі (gap-4, production-7), синхронізація колекцій.
 */
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
let zeta = "";
beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/kits");
  for (const row of await env.handle.db.select().from(packagingMaterials)) material[row.code] = row.id;
  // Каталог більший за ліміт списку форми; «Zeta» — останній за назвою.
  const many = Array.from({ length: MAX_KIT_PRODUCT_OPTIONS + 5 }, (_, i) => ({ title: `A product ${String(i).padStart(5, "0")}`, status: "ACTIVE" }));
  for (let i = 0; i < many.length; i += 500) await env.handle.db.insert(products).values(many.slice(i, i + 500));
  const [z] = await env.handle.db.insert(products).values({ title: "Zeta fender", handle: "zeta-fender", status: "ACTIVE" }).returning({ id: products.id });
  zeta = z!.id;
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
async function render(search = ""): Promise<string> {
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor: { id: OWNER.id, displayName: OWNER.displayName, role: OWNER.role, permissions: [...OWNER.permissions] },
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
          children: [{ id: "page", path: "warehouse/kits", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/demo/warehouse/kits${search}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}
const uk = (key: string) => DICTIONARIES.uk[key]!;
/** Чи відмічено прапорець name=value у розмітці (порядок атрибутів не важливий). */
function isChecked(html: string, name: string, value: string): boolean {
  return [...html.matchAll(/<input [^>]*>/g)].some(([tag]) => tag.includes(`name="${name}"`) && tag.includes(`value="${value}"`) && tag.includes('checked=""'));
}
const linkedProducts = async (templateId: string) =>
  (await env.handle.db.select().from(kitTemplateProducts).where(eq(kitTemplateProducts.templateId, templateId))).map((r) => r.productId);

describe("large catalogue (production-6)", () => {
  let templateId = "";

  it("an assigned product beyond the option limit is in the editor, checked, so a save keeps it", async () => {
    const created = await act({
      intent: "createKit",
      name: "Zeta: болти",
      appliesTo: "products",
      lineMaterialId: [material.bolts_m5!],
      lineQuantity: ["1"],
      linePer: ["item"],
      productIds: [zeta],
    });
    expect(created).toMatchObject({ ok: true });
    templateId = String(created.templateId);
    const data = await load(`?edit=${templateId}`);
    // Регресія: LIMIT 2000 після сортування за назвою відкидав «Zeta», і форма не надсилала його id.
    expect(data.productOptions.map((p) => p.id)).toContain(zeta);
    expect(data.productOptionsInfo).toMatchObject({ truncated: true, limit: MAX_KIT_PRODUCT_OPTIONS });
    expect(data.productOptionsInfo!.total).toBeGreaterThan(MAX_KIT_PRODUCT_OPTIONS);
    const html = await render(`?edit=${templateId}`);
    expect(isChecked(html, "productIds", zeta)).toBe(true);
    expect(html).toContain(uk("packaging.kits.searchCatalog"));
    // Збереження лише зі зміненою назвою (форма надсилає те, що відмічено) — товар лишається в шаблоні.
    const { editing } = data;
    expect(
      await act({
        intent: "updateKit",
        templateId,
        version: editing!.version,
        name: "Zeta: болти M5",
        appliesTo: "products",
        active: "on",
        lineMaterialId: [material.bolts_m5!],
        lineQuantity: ["1"],
        linePer: ["item"],
        productIds: data.productOptions.filter((p) => editing!.products.some((x) => x.id === p.id)).map((p) => p.id),
      }),
    ).toMatchObject({ ok: true });
    expect(await linkedProducts(templateId)).toEqual([zeta]);
  });

  it("server search in the catalogue finds products past the limit (the form merges them without losing its state)", async () => {
    const data = await load(`?edit=new&pq=${encodeURIComponent("zeta")}`);
    expect(data.productOptions.map((p) => p.title)).toEqual(["Zeta fender"]);
    expect(data.productOptionsInfo).toMatchObject({ total: 1, truncated: false, query: "zeta" });
    // SKU / модель варіанта теж шукаються; «%» — звичайний символ.
    expect((await load(`?edit=new&pq=OT-FK-S`)).productOptions.map((p) => p.title)).toEqual(["Крило заднє"]);
    expect((await load(`?edit=new&pq=${encodeURIComponent("%")}`)).productOptions).toEqual([]);
  });

  it("a product the catalogue search finds by barcode, handle or variant title is not hidden by the form's own filter (NEW-G4-3)", async () => {
    await env.handle.db
      .insert(productVariants)
      .values({ productId: zeta, title: "Graphite edition", sku: "OT-ZETA-1", barcode: "4820000099991", price: "10.00", currency: "EUR" });
    for (const text of ["4820000099991", "zeta-fender", "Graphite"]) {
      const { productOptions } = await load(`?edit=new&pq=${encodeURIComponent(text)}`);
      expect(productOptions.map((p) => p.id), text).toEqual([zeta]);
      // Ті самі рядки форма потім фільтрує тим самим текстом (раніше — лише назва/SKU/модель/колір → «Немає товарів»).
      expect(productOptions.every((p) => kitProductMatchesQuery(p, text)), text).toBe(true);
    }
    expect(kitProductMatchesQuery((await load(`?edit=new&pq=zeta`)).productOptions[0]!, "no such text")).toBe(false);
    // Форма використовує саме цей фільтр.
    expect(fs.readFileSync(path.resolve("app/pages/kits.tsx"), "utf8")).toContain("kitProductMatchesQuery(p, q)");
  });
});

describe("collection templates in the editor (gap-4, production-7)", () => {
  it("renders the collection picker and the model/colour filter; creates a collection template with a model filter", async () => {
    const fenders = (await env.handle.db.select().from(collections).where(eq(collections.handle, "fenders-and-protection")))[0]!;
    const data = await load("?edit=new");
    expect(data.collectionOptions.map((c) => c.title)).toEqual(expect.arrayContaining(["Крила та захист", "Шини та колеса"]));
    expect(data.collectionOptions.find((c) => c.id === fenders.id)).toMatchObject({ productsCount: 1, deleted: false });
    expect(data.variantAttributes.models).toEqual(expect.arrayContaining(["Model S", "Model X"]));
    const html = await render("?edit=new");
    expect(html).toContain(uk("packaging.kits.appliesTo.collections"));
    expect(html).toContain('name="models"');
    expect(html).toContain('name="colors"');
    expect(html).toContain(uk("packaging.kits.precedenceHelp"));

    const created = await act({
      intent: "createKit",
      name: "Крило Model X: болти M6",
      appliesTo: "collections",
      active: "on",
      lineMaterialId: [material.bolts_m5!],
      lineQuantity: ["2"],
      linePer: ["item"],
      collectionIds: [fenders.id],
      models: ["Model X"],
    });
    expect(created).toMatchObject({ ok: true });
    const editing = (await load(`?edit=${created.templateId}`)).editing!;
    expect(editing).toMatchObject({ appliesTo: "collections", models: ["Model X"], colors: [], collections: [{ id: fenders.id, title: "Крила та захист" }] });
    const editHtml = await render(`?edit=${created.templateId}`);
    expect(isChecked(editHtml, "collectionIds", fenders.id)).toBe(true);
    expect(isChecked(editHtml, "models", "Model X")).toBe(true);
    expect(isChecked(editHtml, "models", "Model S")).toBe(false);
    // Список: ціль і фільтр видно.
    const list = await render("?applies=collections");
    expect(list).toContain("Крило Model X: болти M6");
    expect(list).toContain("Лише: Model X");

    const empty = await act({ intent: "createKit", name: "Без колекцій", appliesTo: "collections", lineMaterialId: [material.tape!], lineQuantity: ["1"], linePer: ["order"] });
    expect(empty).toMatchObject({ ok: false, fieldErrors: { collectionIds: "packaging.error.kitNoCollections" } });
  });

  it("staff cannot change templates or start a collection sync", async () => {
    setContext(STAFF);
    expect(await act({ intent: "syncCollections" })).toMatchObject({ ok: false, error: "error.forbidden" });
  });
});

describe("collection sync from the kits page", () => {
  it("demo: explains the fictional collections; sync is unavailable", async () => {
    expect((await load()).collectionsSync).toMatchObject({ mode: "demo", canSync: false });
    expect(await render()).toContain(uk("packaging.kits.sync.demo"));
    expect(await act({ intent: "syncCollections" })).toMatchObject({ ok: false, error: "shopify.demoUnavailable" });
  });

  it("production: the owner queues a full collection sync (audited); the last sync time is shown", async () => {
    setContext(OWNER, "production");
    expect(await act({ intent: "syncCollections" })).toMatchObject({ ok: false, error: "shopify.notInstalled" });
    const shop = "ot-kits-page.myshopify.com";
    const syncedAt = new Date("2026-11-20T10:00:00Z");
    await env.handle.db.insert(shopInstallations).values({ shop, scopes: "read_products", collectionsSyncedAt: syncedAt });
    expect((await load()).collectionsSync).toMatchObject({ mode: "production", connected: true, canSync: true, syncedAt });
    expect(await act({ intent: "syncCollections" })).toMatchObject({ ok: true, message: "packaging.kits.result.collectionsQueued" });
    const queued = await env.handle.db.select().from(jobs).where(and(eq(jobs.type, JOB.collectionsPage), eq(jobs.status, "queued")));
    expect(queued).toHaveLength(1);
    expect(queued[0]!.payload).toMatchObject({ shop, after: null });
    const [audit] = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "shopify.collections_sync_requested"));
    expect(audit).toBeDefined();
    setContext(STAFF, "production");
    expect((await load()).collectionsSync.canSync).toBe(false);
  });
});

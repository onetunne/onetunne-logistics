import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { collections, kitTemplateCollections, kitTemplateProducts, kitTemplates, packagingMaterials, productVariants, products } from "~/db/schema";
import { MAX_KIT_COLLECTION_OPTIONS, MAX_KIT_PRODUCT_OPTIONS, resolveKitMaterials } from "~/modules/packaging/kits.server";
import { planParcelBox } from "~/modules/packaging/parcel.server";
import { previewOrderPacking } from "~/modules/packaging/preview.server";
import type { RequestContext } from "~/server/types";
import { OWNER, createTestEnv, type TestEnv } from "../helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("no ctx");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/kits");
const material: Record<string, string> = {};
let zeta = "";
let omega = "";
let lastCollection = "";
beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/kits");
  for (const row of await env.handle.db.select().from(packagingMaterials)) material[row.code] = row.id;
  const many = Array.from({ length: MAX_KIT_PRODUCT_OPTIONS + 5 }, (_, i) => ({ title: `A product ${String(i).padStart(5, "0")}`, status: "ACTIVE" }));
  for (let i = 0; i < many.length; i += 500) await env.handle.db.insert(products).values(many.slice(i, i + 500));
  // assigned products beyond the cap: one ARCHIVED (outside the status filter), one ACTIVE
  zeta = (await env.handle.db.insert(products).values({ title: "Zeta archived", status: "ARCHIVED" }).returning({ id: products.id }))[0]!.id;
  omega = (await env.handle.db.insert(products).values({ title: "Zz omega", status: "ACTIVE" }).returning({ id: products.id }))[0]!.id;
  const cols = Array.from({ length: MAX_KIT_COLLECTION_OPTIONS + 3 }, (_, i) => ({ title: `Col ${String(i).padStart(4, "0")}`, handle: `col-${i}` }));
  await env.handle.db.insert(collections).values(cols);
  lastCollection = (await env.handle.db.insert(collections).values({ title: "Zz deleted col", deletedAt: new Date() }).returning({ id: collections.id }))[0]!.id;
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  m.ctx = { ...env.ctx(OWNER), mode: "demo", basePath: "/demo", locale: "uk" };
});

const load = (search = "") => page.loader({ request: new Request(`http://localhost/demo/warehouse/kits${search}`), params: {}, context: {} } as never);
async function act(fields: Array<[string, string]>) {
  const body = new FormData();
  for (const [k, v] of fields) body.append(k, v);
  return page.action({ request: new Request(`http://localhost/demo/warehouse/kits`, { method: "POST", body }), params: {}, context: {} } as never);
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
  if (context instanceof Response) throw new Error(`unexpected ${context.status}`);
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

/** What a browser would submit for the template form: hidden inputs + checked checkboxes + text/select values. */
function submittedFields(html: string): Array<[string, string]> {
  // only the template form (first <form method="post"> that contains intent updateKit/createKit)
  const start = html.indexOf('value="updateKit"') >= 0 ? html.lastIndexOf("<form", html.indexOf('value="updateKit"')) : html.lastIndexOf("<form", html.indexOf('value="createKit"'));
  const end = html.indexOf("</form>", start);
  const form = html.slice(start, end);
  const out: Array<[string, string]> = [];
  const attr = (tag: string, a: string) => new RegExp(`\\s${a}="([^"]*)"`).exec(tag)?.[1] ?? null;
  const unescape = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  for (const [tag] of form.matchAll(/<input [^>]*>/g)) {
    const name = attr(tag, "name");
    if (!name) continue;
    const type = attr(tag, "type") ?? "text";
    const value = unescape(attr(tag, "value") ?? (type === "checkbox" ? "on" : ""));
    if (type === "checkbox" && !tag.includes('checked=""')) continue;
    out.push([name, value]);
  }
  for (const [, tagAttrs, inner] of form.matchAll(/<select([^>]*)>([\s\S]*?)<\/select>/g)) {
    const name = attr(tagAttrs!, "name");
    if (!name) continue;
    const selected = /<option [^>]*value="([^"]*)"[^>]*selected=""/.exec(inner!)?.[1] ?? /<option [^>]*value="([^"]*)"/.exec(inner!)?.[1] ?? "";
    out.push([name, unescape(selected)]);
  }
  return out;
}

describe("production-6: browser-equivalent round trip with assigned items beyond the caps", () => {
  it("products: ARCHIVED and past-limit assigned products survive a name-only save", async () => {
    const created = await act([
      ["intent", "createKit"],
      ["name", "Big catalogue"],
      ["appliesTo", "products"],
      ["active", "on"],
      ["lineMaterialId", material.bolts_m5!],
      ["lineQuantity", "1"],
      ["linePer", "item"],
      ["productIds", zeta],
      ["productIds", omega],
    ]);
    expect(created).toMatchObject({ ok: true });
    const id = String(created.templateId);
    const html = await render(`?edit=${id}`);
    const fields = submittedFields(html).map(([k, v]) => (k === "name" ? ([k, "Big catalogue renamed"] as [string, string]) : ([k, v] as [string, string])));
    const productIds = fields.filter(([k]) => k === "productIds").map(([, v]) => v);
    expect(productIds.sort()).toEqual([zeta, omega].sort());
    const r = await act(fields);
    expect(r).toMatchObject({ ok: true });
    const linked = (await env.handle.db.select().from(kitTemplateProducts).where(eq(kitTemplateProducts.templateId, id))).map((x) => x.productId).sort();
    expect(linked).toEqual([zeta, omega].sort());
    expect((await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.id, id)))[0]!.name).toBe("Big catalogue renamed");
  });

  it("collections: an assigned deleted collection past the 500 cap survives a save; saved model not in catalogue survives", async () => {
    const created = await act([
      ["intent", "createKit"],
      ["name", "Big collections"],
      ["appliesTo", "collections"],
      ["active", "on"],
      ["lineMaterialId", material.tape!],
      ["lineQuantity", "1"],
      ["linePer", "order"],
      ["collectionIds", lastCollection],
      ["models", "  model q  "],
      ["models", "MODEL Q"],
      ["colors", "Чорний"],
    ]);
    expect(created).toMatchObject({ ok: true });
    const id = String(created.templateId);
    const data = await load(`?edit=${id}`);
    expect(data.editing).toMatchObject({ models: ["model q"], colors: ["Чорний"] });
    expect(data.collectionOptionsInfo).toMatchObject({ truncated: true });
    const html = await render(`?edit=${id}`);
    const fields = submittedFields(html);
    expect(fields.filter(([k]) => k === "collectionIds").map(([, v]) => v)).toEqual([lastCollection]);
    expect(fields.filter(([k]) => k === "models").map(([, v]) => v)).toEqual(["model q"]);
    expect(fields.filter(([k]) => k === "colors").map(([, v]) => v)).toEqual(["Чорний"]);
    expect(await act(fields)).toMatchObject({ ok: true });
    const linked = (await env.handle.db.select().from(kitTemplateCollections).where(eq(kitTemplateCollections.templateId, id))).map((x) => x.collectionId);
    expect(linked).toEqual([lastCollection]);
    const [tpl] = await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.id, id));
    expect(tpl).toMatchObject({ variantModels: ["model q"], variantColors: ["Чорний"] });
  });

  it("an all-products template round trip keeps the variant filter", async () => {
    const created = await act([
      ["intent", "createKit"],
      ["name", "All with filter"],
      ["appliesTo", "all"],
      ["active", "on"],
      ["lineMaterialId", material.tape!],
      ["lineQuantity", "1"],
      ["linePer", "item"],
      ["models", "Model S"],
    ]);
    const id = String(created.templateId);
    const fields = submittedFields(await render(`?edit=${id}`));
    expect(await act(fields)).toMatchObject({ ok: true });
    expect((await env.handle.db.select().from(kitTemplates).where(eq(kitTemplates.id, id)))[0]!.variantModels).toEqual(["Model S"]);
    await env.handle.db.delete(kitTemplates).where(eq(kitTemplates.id, id));
  });
});

describe("production-7: variant model matching normalisation on real data", () => {
  it("variant with ' model s ' (spaces/case) matches a template filtered on 'Model S'; Model X does not", async () => {
    const created = await act([
      ["intent", "createKit"],
      ["name", "S only bolts"],
      ["appliesTo", "all"],
      ["active", "on"],
      ["lineMaterialId", material.bolts_m5!],
      ["lineQuantity", "5"],
      ["linePer", "item"],
      ["models", "Model S"],
    ]);
    const id = String(created.templateId);
    await env.handle.db.update(productVariants).set({ model: "  model s " }).where(eq(productVariants.sku, "OT-FK-S"));
    const sOrder = await env.orderId("#1006");
    const xOrder = await env.orderId("#1002");
    const sNeed = (await resolveKitMaterials(env.handle.db, sOrder)).find((x) => x.materialId === material.bolts_m5)!;
    const xNeed = (await resolveKitMaterials(env.handle.db, xOrder)).find((x) => x.materialId === material.bolts_m5);
    // S: 5 (S-only template) + 1 (products fender template) ; X: 1 (products template only)
    expect(sNeed.templateIds).toContain(id);
    expect(xNeed?.templateIds ?? []).not.toContain(id);
    await env.handle.db.update(productVariants).set({ model: "Model S" }).where(eq(productVariants.sku, "OT-FK-S"));
    await env.handle.db.delete(kitTemplates).where(eq(kitTemplates.id, id));
  });
});

describe("gap-8: demo box selection by dimensions", () => {
  it("distribution of box reasons over all demo orders; fits orders produce an auto_box for the waybill", async () => {
    const { orders } = await import("~/db/schema");
    const all = await env.handle.db.select().from(orders);
    const dist: Record<string, string[]> = {};
    for (const o of all) {
      const p = await previewOrderPacking(env.handle.db, o.id);
      (dist[p.boxReason] ??= []).push(`${o.orderNumber}:${o.status}`);
      if (p.boxReason === "fits") {
        const plan = await planParcelBox(env.handle.db, o);
        expect(plan.box?.source).toBe("auto_box");
      }
    }
    process.stderr.write(`[verify] box reasons: ${JSON.stringify(dist)}\n`);
    expect(Object.keys(dist)).toEqual(expect.arrayContaining(["fits", "weight_only"]));
  });
});

import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { kitTemplates, orders } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { recordScan, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Сторінки (G1b2): лист комплектації (/picking/pick-list), екран пакування без перегляду замовлень (дані покупця
 * приховано), посилка до накладної (форма target=order), «Запаковано» зі старим переліком матеріалів.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

type PageModule = { loader: (args: never) => Promise<unknown>; action?: (args: never) => Promise<unknown>; default?: () => unknown };

let env: TestEnv;
let pickList: typeof import("~/pages/pick-list");
let packingOrder: typeof import("~/pages/packing-order");
let picking: typeof import("~/pages/picking");
const ids: Record<string, string> = {};
const PACKER = makeActor({ id: "packer-only", displayName: "Packer", role: "staff", overrides: { revoke: ["orders.view", "orders.edit"] } });
const NO_PACKING = makeActor({ id: "np", displayName: "NP", role: "staff", overrides: { revoke: ["packing.perform"] } });

beforeAll(async () => {
  env = await createTestEnv();
  for (const number of ["#1001", "#1009", "#1011"]) {
    const id = await env.orderId(number);
    await validateOrderById(env.ctx(OWNER), id);
    const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill ${number}: ${r.kind}`);
    ids[number] = id;
  }
  ids["#1003"] = await env.orderId("#1003");
  await validateOrderById(env.ctx(OWNER), ids["#1003"]);
  [pickList, packingOrder, picking] = await Promise.all([import("~/pages/pick-list"), import("~/pages/packing-order"), import("~/pages/picking")]);
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = STAFF) {
  m.ctx = { ...env.ctx(actor), mode: "demo", basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());
const uk = (key: string) => DICTIONARIES.uk[key]!;
const BASE = "http://localhost/demo";

async function status(mod: PageModule, path: string, params: Record<string, string> = {}): Promise<number> {
  try {
    const r = await mod.loader({ request: new Request(`${BASE}/${path}`), params, context: {} } as never);
    return r instanceof Response ? r.status : 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}
function post(mod: PageModule, path: string, fields: Record<string, string>, params: Record<string, string> = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return mod.action!({ request: new Request(`${BASE}/${path}`, { method: "POST", body }), params, context: {} } as never) as Promise<{
    ok: boolean;
    message?: string;
    error?: string;
    extra?: string[];
    params?: Record<string, unknown>;
  }>;
}
async function render(mod: PageModule, routePath: string, url: string): Promise<string> {
  const actor = m.ctx?.actor ?? OWNER;
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
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
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: routePath, loader: mod.loader, action: mod.action, Component: mod.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/demo/${url}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const hidden = (html: string, name: string) => new RegExp(`<input type="hidden" name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;

describe("pick list page (/picking/pick-list)", () => {
  it("needs packing.perform only; shows the summed items, the split per order and an empty state", async () => {
    setContext(NO_PACKING);
    expect(await status(pickList, "picking/pick-list")).toBe(403);
    // Без перегляду замовлень — дозволено (у листі немає даних покупця).
    setContext(PACKER);
    let html = text(await render(pickList, "picking/pick-list", "picking/pick-list"));
    expect(html).toContain(uk("packing.pickList.empty"));
    html = text(await render(pickList, "picking/pick-list", `picking/pick-list?ids=${ids["#1001"]}&ids=${ids["#1009"]}&ids=${ids["#1003"]}`));
    expect(html).toContain(DICTIONARIES.uk["packing.pickList.title"]!.replace("{count}", "2"));
    expect(html).toContain("OT-PH-BLK");
    expect(html).toMatch(/#1001 × 1, #1009 × 1|#1009 × 1, #1001 × 1/);
    expect(html).toContain(uk("packing.pickList.materials"));
    expect(html).toContain(uk("packing.pickList.reason.not_in_queue"));
  });

  it("the queue offers the pick list for the selection", async () => {
    setContext(STAFF);
    const html = text(await render(picking, "picking", "picking"));
    expect(html).toContain(DICTIONARIES.uk["packing.bulk.pickList"]!.replace("{count}", "0"));
    // «Потрібна накладна»: вага й габарити посилки до накладної — на екрані пакування.
    const needs = await render(picking, "picking", "picking?tab=needs_waybill");
    expect(needs).toContain(`/demo/picking/${ids["#1003"]}`);
    expect(text(needs)).toContain(uk("packing.queue.setParcel"));
  });
});

describe("packing screen (security-3, gap-5, production-5)", () => {
  it("without orders.view the recipient name and city are not rendered", async () => {
    const id = ids["#1001"]!;
    await startPacking(env.ctx(STAFF), id);
    const [order] = await env.handle.db.select({ first: orders.shipFirstName, last: orders.shipLastName, city: orders.shipCity }).from(orders).where(eq(orders.id, id));
    setContext(STAFF);
    let html = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    expect(html).toContain(order!.city!);
    setContext(PACKER);
    html = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    expect(html).not.toContain(order!.city!);
    if (order!.last) expect(html).not.toContain(order!.last);
    expect(html).toContain(uk("packing.screen.customerHidden"));
  });

  it("before a waybill the parcel form saves on the order (target=order)", async () => {
    const id = ids["#1003"]!;
    setContext(STAFF);
    const html = await render(packingOrder, "picking/:orderId", `picking/${id}`);
    expect(hidden(html, "target")).toBe("order");
    expect(text(html)).toContain(uk("packing.parcel.beforeWaybill"));
    const version = hidden(html, "version")!;
    const r = await post(
      packingOrder,
      `picking/${id}`,
      { intent: "parcel", target: "order", version, boxMaterialId: "none", weightGrams: "950", lengthMm: "", widthMm: "", heightMm: "", weightPrefill: "", dimsPrefill: "" },
      { orderId: id },
    );
    expect(r).toMatchObject({ ok: true, message: "packing.parcel.savedOrder", params: { count: 1 } });
    const [row] = await env.handle.db.select({ w: orders.parcelWeightGrams }).from(orders).where(eq(orders.id, id));
    expect(row!.w).toBe(950);
    // Повтор зі старою версією — конфлікт, а не мовчазне перезаписування.
    expect(
      await post(
        packingOrder,
        `picking/${id}`,
        { intent: "parcel", target: "order", version, boxMaterialId: "none", weightGrams: "990", lengthMm: "", widthMm: "", heightMm: "", weightPrefill: "", dimsPrefill: "" },
        { orderId: id },
      ),
    ).toMatchObject({ ok: false });
  });

  it("«Packed» with a stale materials list asks to confirm again", async () => {
    const id = ids["#1011"]!;
    await startPacking(env.ctx(STAFF), id);
    const screen = await loadPackingScreen(env.ctx(), id);
    for (const line of screen.lines) for (let i = line.packed; i < line.required; i += 1) await recordScan(env.ctx(STAFF), id, line.barcode ?? line.sku ?? "");
    setContext(STAFF);
    const html = await render(packingOrder, "picking/:orderId", `picking/${id}`);
    const materialsKey = hidden(html, "materialsKey");
    expect(materialsKey).not.toBeNull();
    const version = String((await loadPackingScreen(env.ctx(), id)).packing!.version);
    const templates = await env.handle.db.select({ id: kitTemplates.id, active: kitTemplates.active }).from(kitTemplates);
    await env.handle.db.update(kitTemplates).set({ active: false });
    try {
      const r = await post(packingOrder, `picking/${id}`, { intent: "confirm", version, materialsKey: materialsKey! }, { orderId: id });
      expect(r).toMatchObject({ ok: false, error: "packing.error.materialsChanged" });
    } finally {
      for (const t of templates) await env.handle.db.update(kitTemplates).set({ active: t.active }).where(eq(kitTemplates.id, t.id));
    }
    const ok = await post(packingOrder, `picking/${id}`, { intent: "confirm", version, materialsKey: materialsKey! }, { orderId: id });
    expect(ok).toMatchObject({ ok: true, message: "packing.confirm.done" });
  });
});

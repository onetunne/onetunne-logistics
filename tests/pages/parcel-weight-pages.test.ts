import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import type { Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { saveOrderParcel, startPacking } from "~/modules/packing/packing.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Сторінки (NEW-1): зважена вага, менша за 90 % ваги товарів за Shopify, — попередження на екрані пакування (власник
 * підтверджує, працівник бачить «попросіть власника»), пояснення в картці накладної й пакування на сторінці
 * замовлення, без поради «Переоформити» для ваги, яку нова накладна теж проігнорувала б.
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
let packingOrder: typeof import("~/pages/packing-order");
let orderDetail: typeof import("~/pages/order-detail");
let id = "";

beforeAll(async () => {
  env = await createTestEnv();
  id = await env.orderId("#1003"); // сумка: 250 г за Shopify
  await validateOrderById(env.ctx(OWNER), id);
  [packingOrder, orderDetail] = await Promise.all([import("~/pages/packing-order"), import("~/pages/order-detail")]);
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = STAFF) {
  m.ctx = { ...env.ctx(actor), mode: "demo", basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());
const uk = (key: string) => DICTIONARIES.uk[key]!;
const fill = (key: string, params: Record<string, string>) => uk(key).replace(/\{(\w+)\}/g, (_, k: string) => params[k] ?? `{${k}}`);
const BASE = "http://localhost/demo";

function post(mod: PageModule, path: string, fields: Record<string, string>, params: Record<string, string> = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return mod.action!({ request: new Request(`${BASE}/${path}`, { method: "POST", body }), params, context: {} } as never) as Promise<{
    ok: boolean;
    message?: string;
    error?: string;
    extra?: string[];
    tone?: string;
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

describe("weighed weight below the goods weight on the pages", () => {
  it("pre-waybill save warns; the order card links to the parcel form and explains", async () => {
    setContext(STAFF);
    const order = await loadOrderRow(env.handle.db, id);
    const r = await post(
      packingOrder,
      `picking/${id}`,
      { intent: "parcel", target: "order", version: String(order.version), boxMaterialId: "none", weightGrams: "212", lengthMm: "", widthMm: "", heightMm: "", weightPrefill: "", dimsPrefill: "" },
      { orderId: id },
    );
    expect(r).toMatchObject({ ok: true, message: "packing.parcel.savedOrder", extra: ["packing.parcel.weightIgnoredSaved"], tone: "warning" });

    const screen = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    expect(screen).toContain(uk("packing.weightCheck.title"));
    expect(screen).toContain(fill("packing.weightCheck.body", { manual: "212 г", goods: "250 г", min: "225 г" }));
    // Працівник не підтверджує — лише просить власника.
    expect(screen).toContain(uk("packing.weightCheck.askOwner"));
    expect(screen).not.toContain(fill("packing.weightCheck.button", { manual: "212 г" }));
    expect(screen).toContain(uk("packing.parcel.savedIgnoredHint"));

    setContext(OWNER);
    const card = text(await render(orderDetail, "orders/:orderId", `orders/${id}`));
    expect(card).toContain(uk("packing.weightCheck.title"));
    expect(card).toContain(uk("packing.summary.openParcel"));
  });

  it("with a waybill: the waybill card and the packing screen say the weighed weight was not used, without re-issue advice", async () => {
    expect((await createWaybill(env.ctx(OWNER), id)).kind).toBe("created");
    await startPacking(env.ctx(STAFF), id);
    setContext(STAFF);
    const screen = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    const ignoredNote = fill("packing.waybillWeight.ignored", { manual: "212 г", goods: "250 г" });
    expect(screen).toContain(ignoredNote);
    expect(screen).toContain(uk("packing.mismatch.title"));
    expect(screen).toContain(fill("packing.mismatch.weightIgnored", { packed: "212 г", goods: "250 г" }));
    expect(screen).not.toContain(uk("packing.mismatch.hint"));
    expect(screen).not.toContain(uk("packing.mismatch.toReissue"));

    setContext(OWNER);
    const order = text(await render(orderDetail, "orders/:orderId", `orders/${id}`));
    expect(order).toContain(ignoredNote);
    expect(order).toContain(fill("packing.mismatch.weightIgnored", { packed: "212 г", goods: "250 г" }));
    expect(order).not.toContain(uk("packing.mismatch.hint"));
    // Власник бачить кнопку підтвердження на екрані пакування.
    const ownerScreen = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    expect(ownerScreen).toContain(fill("packing.weightCheck.button", { manual: "212 г" }));
    expect(ownerScreen).not.toContain(uk("packing.weightCheck.askOwner"));
  });

  it("confirmWeight: staff is refused, the owner confirms; the re-issue advice comes back", async () => {
    setContext(STAFF);
    expect(await post(packingOrder, `picking/${id}`, { intent: "confirmWeight", weightGrams: "212" }, { orderId: id })).toMatchObject({
      ok: false,
      error: "packing.error.weightConfirmOwnerOnly",
    });
    setContext(OWNER);
    expect(await post(packingOrder, `picking/${id}`, { intent: "confirmWeight", weightGrams: "212" }, { orderId: id })).toMatchObject({
      ok: true,
      message: "packing.weightCheck.confirmed",
    });
    const screen = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    expect(screen).toContain(fill("packing.weightCheck.verified", { manual: "212 г", goods: "250 г" }));
    expect(screen).not.toContain(uk("packing.weightCheck.title"));
    // Тепер переоформлення використає зважену вагу — порада повертається.
    expect(screen).toContain(uk("packing.mismatch.hint"));
    expect(screen).not.toContain(fill("packing.mismatch.weightIgnored", { packed: "212 г", goods: "250 г" }));
    // Історія замовлення — рішення власника з причиною.
    const order = text(await render(orderDetail, "orders/:orderId", `orders/${id}`));
    expect(order).toContain(uk("packing.history.weightVerifiedByOwner"));
  });

  it("a plausible weight shows no warning", async () => {
    const other = await env.orderId("#1002");
    await validateOrderById(env.ctx(OWNER), other);
    const order = await loadOrderRow(env.handle.db, other);
    await saveOrderParcel(env.ctx(STAFF), other, { expectedVersion: order.version, boxMaterialId: null, weightGrams: 5000 });
    setContext(STAFF);
    const screen = text(await render(packingOrder, "picking/:orderId", `picking/${other}`));
    expect(screen).not.toContain(uk("packing.weightCheck.title"));
    expect(screen).toContain(uk("packing.parcel.savedHint"));
  });
});

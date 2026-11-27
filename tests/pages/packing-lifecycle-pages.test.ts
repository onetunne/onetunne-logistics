import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { ShellData } from "~/components/shell-types";
import { orders } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { HANDOVER_SKIP_REASONS } from "~/modules/packing/handover-list.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { confirmPacked, recordScan, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { cancelOrder, createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Сторінки (G1b): список передачі перевізнику (/picking/handover), попередження екрана пакування (скасовано після
 * пакування → «Повернуто на склад», позиції змінено в Shopify), сторінка замовлення (передача без «Запаковано» —
 * причина власника; скасування накладної запакованого замовлення — підказка «спершу розпакувати»).
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
let handover: typeof import("~/pages/handover-list");
let packingOrder: typeof import("~/pages/packing-order");
let orderDetail: typeof import("~/pages/order-detail");
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv();
  for (const number of ["#1001", "#1009", "#1011", "#1012"]) {
    const id = await env.orderId(number);
    await validateOrderById(env.ctx(OWNER), id);
    const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill ${number}: ${r.kind}`);
    ids[number] = id;
  }
  [handover, packingOrder, orderDetail] = await Promise.all([import("~/pages/handover-list"), import("~/pages/packing-order"), import("~/pages/order-detail")]);
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

async function pack(orderId: string) {
  await startPacking(env.ctx(STAFF), orderId);
  const screen = await loadPackingScreen(env.ctx(), orderId);
  for (const line of screen.lines) for (let i = line.packed; i < line.required; i += 1) await recordScan(env.ctx(STAFF), orderId, line.barcode ?? line.sku ?? "");
  const fresh = await loadPackingScreen(env.ctx(), orderId);
  expect((await confirmPacked(env.ctx(STAFF), orderId, fresh.packing!.version)).kind).toBe("packed");
}

describe("carrier handover list page (/picking/handover)", () => {
  it("needs packing.perform; shows packed parcels with waybill numbers, the TEST warning and signature lines", async () => {
    setContext(makeActor({ id: "np", displayName: "NP", role: "staff", overrides: { revoke: ["packing.perform"] } }));
    expect(await status(handover, "picking/handover")).toBe(403);
    setContext(STAFF);
    let html = text(await render(handover, "picking/handover", "picking/handover"));
    expect(html).toContain(uk("packing.handover.empty"));
    await pack(ids["#1001"]!);
    const waybill = (await findActiveShipment(env.handle.db, ids["#1001"]!))!.waybillNumber!;
    html = text(await render(handover, "picking/handover", "picking/handover"));
    expect(html).toContain(waybill);
    expect(html).toContain("#1001");
    expect(html).toContain(uk("packing.handover.testWarning"));
    expect(html).toContain(uk("packing.handover.sign.receivedBy"));
    // Вибрані, але не запаковані — з причиною.
    html = text(await render(handover, "picking/handover", `picking/handover?ids=${ids["#1001"]}&ids=${ids["#1009"]}`));
    expect(html).toContain(uk("packing.handover.reason.not_packed"));
    for (const reason of HANDOVER_SKIP_REASONS) {
      expect(DICTIONARIES.uk[`packing.handover.reason.${reason}`], reason).toBeTruthy();
      expect(DICTIONARIES.en[`packing.handover.reason.${reason}`], reason).toBeTruthy();
    }
  });
});

describe("packing screen warnings", () => {
  it("cancelled after packing: the banner offers 'Returned to stock', which closes the warning", async () => {
    await pack(ids["#1011"]!);
    await cancelOrder(env.ctx(OWNER), ids["#1011"]!);
    const path = `picking/${ids["#1011"]}`;
    const html = text(await render(packingOrder, "picking/:orderId", path));
    expect(html).toContain(uk("packing.cancelledAfter.title"));
    expect(html).toContain(uk("packing.cancelledAfter.button"));
    expect(html).not.toContain(uk("packing.screen.cancelled"));
    expect(await post(packingOrder, path, { intent: "returned" }, { orderId: ids["#1011"]! })).toMatchObject({ ok: true, message: "packing.cancelledAfter.returned" });
    expect(text(await render(packingOrder, "picking/:orderId", path))).toContain(uk("packing.screen.cancelled"));
  });

  it("Shopify lines pending: blocking banner, the normal 'Packed' is disabled", async () => {
    const id = ids["#1012"]!;
    await startPacking(env.ctx(STAFF), id);
    await env.handle.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, id));
    const html = text(await render(packingOrder, "picking/:orderId", `picking/${id}`));
    expect(html).toContain(uk("packing.screen.shopifyLinesPending.title"));
    await env.handle.db.update(orders).set({ shopifyLinesPendingAt: null }).where(eq(orders.id, id));
  });
});

describe("order page: handover vs picking control, cancelling the waybill of a packed order", () => {
  it("handover of an unconfirmed packing: the owner gives a reason in the form; without it the server refuses", async () => {
    const id = ids["#1012"]!; // пакування розпочато вище, не підтверджено
    setContext(OWNER);
    const html = text(await render(orderDetail, "orders/:orderId", `orders/${id}`));
    expect(html).toContain(uk("packing.handover.overrideReason"));
    const shipmentId = (await findActiveShipment(env.handle.db, id))!.id;
    expect(await post(orderDetail, `orders/${id}`, { intent: "markHandedOver", shipmentId }, { orderId: id })).toMatchObject({
      ok: false,
      error: "shipment.packingIncomplete",
    });
    expect(
      await post(orderDetail, `orders/${id}`, { intent: "markHandedOver", shipmentId, packingOverride: "1", packingOverrideReason: "checked by hand" }, { orderId: id }),
    ).toMatchObject({ ok: true, message: "tracking.result.handedOver" });
  });

  it("cancelling the waybill of a packed order says to unpack first (not 'correct the data')", async () => {
    setContext(OWNER);
    const id = ids["#1001"]!; // запаковано вище
    const shipmentId = (await findActiveShipment(env.handle.db, id))!.id;
    const html = text(await render(orderDetail, "orders/:orderId", `orders/${id}`));
    expect(html).toContain(uk("packing.cancelWaybill.packedWarning"));
    const r = await post(orderDetail, `orders/${id}`, { intent: "cancelWaybill", shipmentId, purpose: "correction" }, { orderId: id });
    expect(r).toMatchObject({ ok: true, message: "result.waybill.cancelled" });
    expect(r.extra).toContain("packing.cancelWaybill.packedResult");
    expect(r.extra).not.toContain("order.correct.result");
  });
});

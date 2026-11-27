import { and, eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult } from "~/components/action-banner";
import type { ShellData } from "~/components/shell-types";
import { issues, orderLineItems, orders, shipments } from "~/db/schema";
import { PERMISSIONS, makeActor } from "~/domain/permissions";
import { resetEnvCache } from "~/lib/env.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Сторінка замовлення й «Проблеми» (G1a, етап 5): «Відправлено поза застосунком» для замовлення, виконаного в Shopify,
 * і неперенесені зміни позицій із Shopify (банер, блокування ручної передачі/переоформлення). Демо-середовище.
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };
let page: typeof import("~/pages/order-detail");
let problems: typeof import("~/pages/problems");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/order-detail");
  problems = await import("~/pages/problems");
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

type Role = "owner" | "staff";
const headers = async (role?: Role): Promise<HeadersInit> => (role ? { Cookie: await demoRoleCookie.serialize(role) } : {});
const urlOf = (orderId: string) => `http://localhost/demo/orders/${orderId}`;

async function load(orderId: string, role?: Role) {
  return page.loader({ request: new Request(urlOf(orderId), { headers: await headers(role) }), params: { orderId }, context: {} } as never);
}
async function act(orderId: string, fields: Record<string, string>, role?: Role): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  return page.action({ request: new Request(urlOf(orderId), { method: "POST", body, headers: await headers(role) }), params: { orderId }, context: {} } as never);
}
async function actProblems(fields: Record<string, string>, role?: Role): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request("http://localhost/demo/problems", { method: "POST", body, headers: await headers(role) });
  return problems.action({ request, params: {}, context: {} } as never);
}

async function render(orderId: string, role?: Role): Promise<string> {
  const staff = makeActor({ id: "demo-staff", displayName: "Demo Staff", role: "staff" });
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor:
      role === "staff"
        ? { id: staff.id, displayName: staff.displayName, role: "staff", permissions: [...staff.permissions] }
        : { id: "demo-owner", displayName: "Demo Owner", role: "owner", permissions: [...PERMISSIONS] },
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
          children: [{ id: "demo-order", path: "orders/:orderId", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(urlOf(orderId), { headers: await headers(role) }));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

let counter = 0;
/** Копія демо-замовлення #1001 (без накладної) зі зміненими полями. */
async function cloneOrder(patch: Partial<typeof orders.$inferInsert> = {}): Promise<string> {
  const { handle } = await getDemoRuntime();
  const [src] = await handle.db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
  counter++;
  const [row] = await handle.db
    .insert(orders)
    .values({ ...rest, orderNumber: `#G1A-${counter}`, status: "paid", version: 1, automationPaused: false, ...patch })
    .returning({ id: orders.id });
  for (const { id: _i, orderId: _o, ...item } of await handle.db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id))) {
    await handle.db.insert(orderLineItems).values({ ...item, orderId: row!.id, shopifyLineItemId: null });
  }
  return row!.id;
}

describe("shipped outside the app (order card + Problems)", () => {
  it("the order card explains the Shopify fulfillment, hides waybill creation and offers the action to the owner only", async () => {
    const id = await cloneOrder({ status: "awaiting_review", fulfillmentStatus: "fulfilled" });
    const { handle } = await getDemoRuntime();
    const data = await load(id, "owner");
    expect(data.order).toMatchObject({ fulfilledInShopify: true, shippedOutside: "available" });
    const owner = await render(id, "owner");
    expect(owner).toContain("Замовлення виконано в Shopify поза застосунком");
    expect(owner).toContain("Відправлено поза застосунком");
    expect(owner).not.toContain('value="createWaybill"');
    const staff = await render(id, "staff");
    expect(staff).toContain("Замовлення виконано в Shopify поза застосунком");
    expect(staff).not.toContain('value="shippedOutside"');

    expect(await act(id, { intent: "shippedOutside" }, "staff")).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act(id, { intent: "createWaybill" }, "owner")).toMatchObject({ message: "result.waybill.blocked.fulfilled_in_shopify" });
    expect(await act(id, { intent: "shippedOutside" }, "owner")).toMatchObject({ ok: true, message: "order.shippedOutside.result.done" });
    const [o] = await handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
    expect(o!.status).toBe("handed_to_carrier");
    expect(await act(id, { intent: "shippedOutside" }, "owner")).toMatchObject({ ok: true, message: "order.shippedOutside.result.already" });
  });

  it("Problems: the SHOPIFY_FULFILLED_OUTSIDE_APP issue confirms the shipment (waybills.manage) and is resolved", async () => {
    const id = await cloneOrder({ status: "awaiting_review", fulfillmentStatus: "partially_fulfilled" });
    const { handle } = await getDemoRuntime();
    const [issue] = await handle.db
      .insert(issues)
      .values({ orderId: id, code: "SHOPIFY_FULFILLED_OUTSIDE_APP", severity: "warning", params: { status: "partially_fulfilled" }, fingerprint: `${id}:SHOPIFY_FULFILLED_OUTSIDE_APP:` })
      .returning();
    // На картці замовлення кнопка — у самій проблемі (не дублюється в картці накладної).
    const html = await render(id, "owner");
    expect(html.split('value="shippedOutside"').length - 1).toBe(1);
    expect(await actProblems({ intent: "shippedOutside", issueId: issue!.id }, "staff")).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await actProblems({ intent: "shippedOutside", issueId: issue!.id }, "owner")).toMatchObject({
      ok: true,
      message: "order.shippedOutside.result.done",
    });
    const [after] = await handle.db.select().from(issues).where(eq(issues.id, issue!.id));
    expect(after).toMatchObject({ status: "resolved", resolution: "shipped_outside_app" });
    expect(await actProblems({ intent: "shippedOutside", issueId: issue!.id }, "owner")).toMatchObject({ ok: false, error: "problems.error.notFound" });
  });
});

describe("shipped outside the app while Shopify line changes are pending (G1a-NEW-1)", () => {
  async function problemsGroup(orderId: string) {
    const request = new Request("http://localhost/demo/problems?q=%23G1A", { headers: await headers("owner") });
    const data = await problems.loader({ request, params: {}, context: {} } as never);
    return data.groups.find((g) => g.orderId === orderId);
  }

  it("the order card and Problems hide the action and explain the re-read; the action is refused", async () => {
    const id = await cloneOrder({ status: "awaiting_review", fulfillmentStatus: "fulfilled", shopifyLinesPendingAt: new Date() });
    const { handle } = await getDemoRuntime();
    const [issue] = await handle.db
      .insert(issues)
      .values({ orderId: id, code: "SHOPIFY_FULFILLED_OUTSIDE_APP", severity: "warning", params: { status: "fulfilled" }, fingerprint: `${id}:SHOPIFY_FULFILLED_OUTSIDE_APP:` })
      .returning();

    const data = await load(id, "owner");
    expect(data.order).toMatchObject({ fulfilledInShopify: true, shopifyLinesPending: true, shippedOutside: "shopify_lines_pending" });
    const html = await render(id, "owner");
    expect(html).not.toContain('value="shippedOutside"');
    expect(html).toContain("стане доступним після повторного читання замовлення з Shopify");
    expect(html).toContain("Позиції змінено в Shopify — застосунок їх ще не застосував");
    expect(await problemsGroup(id)).toMatchObject({ shippedOutside: "shopify_lines_pending" });

    expect(await act(id, { intent: "shippedOutside" }, "owner")).toMatchObject({ ok: false, error: "order.shippedOutside.shopifyLinesPending" });
    expect(await actProblems({ intent: "shippedOutside", issueId: issue!.id }, "owner")).toMatchObject({
      ok: false,
      error: "order.shippedOutside.shopifyLinesPending",
    });
    const [o] = await handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
    expect(o!.status).toBe("awaiting_review");

    // Позиції застосовано (повторне читання) → дія знову доступна.
    await handle.db.update(orders).set({ shopifyLinesPendingAt: null }).where(eq(orders.id, id));
    expect((await load(id, "owner")).order).toMatchObject({ shippedOutside: "available" });
    expect(await problemsGroup(id)).toMatchObject({ shippedOutside: "available" });
    expect(await actProblems({ intent: "shippedOutside", issueId: issue!.id }, "owner")).toMatchObject({ ok: true, message: "order.shippedOutside.result.done" });
  });

  it("Problems does not offer the action while an app waybill is active", async () => {
    const id = await cloneOrder();
    expect(await act(id, { intent: "validate" }, "owner")).toMatchObject({ ok: true });
    expect(await act(id, { intent: "createWaybill" }, "owner")).toMatchObject({ ok: true, message: "result.waybill.created" });
    const { handle } = await getDemoRuntime();
    await handle.db.update(orders).set({ fulfillmentStatus: "fulfilled" }).where(eq(orders.id, id));
    await handle.db
      .insert(issues)
      .values({ orderId: id, code: "SHOPIFY_FULFILLED_OUTSIDE_APP", severity: "warning", params: { status: "fulfilled" }, fingerprint: `${id}:SHOPIFY_FULFILLED_OUTSIDE_APP:` });
    expect(await problemsGroup(id)).toMatchObject({ shippedOutside: "unavailable" });
  });
});

describe("partially fulfilled in Shopify only by items without shipping (G1a-NEW-3)", () => {
  it("the order card explains it and offers the waybill; no 'shipped outside' action", async () => {
    const id = await cloneOrder({ status: "awaiting_review", fulfillmentStatus: "partially_fulfilled", shopifyShippableFulfilled: false });
    const data = await load(id, "owner");
    expect(data.order).toMatchObject({ fulfilledInShopify: false, nonShippingFulfilledOnly: true, shippedOutside: "unavailable" });
    const html = await render(id, "owner");
    expect(html).toContain("Shopify виконав лише позиції без доставки");
    expect(html).not.toContain("Замовлення виконано в Shopify поза застосунком");
    expect(html).toContain('value="createWaybill"');
    expect(html).not.toContain('value="shippedOutside"');
    expect(await act(id, { intent: "validate" }, "owner")).toMatchObject({ ok: true });
    expect(await act(id, { intent: "createWaybill" }, "owner")).toMatchObject({ ok: true, message: "result.waybill.created" });
  });

  it("unknown per-line facts (data before the change) still block as fulfilled", async () => {
    const id = await cloneOrder({ status: "awaiting_review", fulfillmentStatus: "partially_fulfilled", shopifyShippableFulfilled: null });
    expect((await load(id, "owner")).order).toMatchObject({ fulfilledInShopify: true, nonShippingFulfilledOnly: false });
    expect(await act(id, { intent: "createWaybill" }, "owner")).toMatchObject({ message: "result.waybill.blocked.fulfilled_in_shopify" });
  });
});

describe("Shopify line changes pending on an order with a waybill", () => {
  it("shows the banner; reissue is not started; manual handover needs the owner's explicit confirmation", async () => {
    const id = await cloneOrder();
    expect(await act(id, { intent: "validate" }, "owner")).toMatchObject({ ok: true });
    expect(await act(id, { intent: "createWaybill" }, "owner")).toMatchObject({ ok: true, message: "result.waybill.created" });
    const { handle } = await getDemoRuntime();
    await handle.db.update(orders).set({ shopifyLinesPendingAt: new Date() }).where(eq(orders.id, id));
    const [shipment] = await handle.db.select().from(shipments).where(and(eq(shipments.orderId, id), eq(shipments.status, "created")));

    const html = await render(id, "owner");
    expect(html).toContain("Позиції змінено в Shopify — застосунок їх ще не застосував");
    expect(html).toContain("Увага: Shopify змінив позиції після створення накладної");
    expect(html).toContain('name="acknowledgeShopifyLines"');

    expect(await act(id, { intent: "reissueWaybill", shipmentId: shipment!.id }, "owner")).toMatchObject({
      ok: true,
      message: "order.reissue.result.notStarted",
      extra: ["result.waybill.blocked.shopify_lines_pending"],
    });
    expect(await act(id, { intent: "markHandedOver", shipmentId: shipment!.id }, "owner")).toMatchObject({
      ok: false,
      error: "shipment.shopifyLinesPending",
    });
    expect(await act(id, { intent: "markHandedOver", shipmentId: shipment!.id, acknowledgeShopifyLines: "1" }, "owner")).toMatchObject({
      ok: true,
      message: "tracking.result.handedOver",
    });
  });

  it("the re-read action explains that the demo reads nothing from Shopify", async () => {
    const id = await cloneOrder();
    expect(await act(id, { intent: "resyncShopify" }, "owner")).toMatchObject({ ok: true, message: "order.shopifyLines.resync.demo" });
    expect(await act(id, { intent: "resyncShopify" }, "staff")).toMatchObject({ ok: true, message: "order.shopifyLines.resync.demo" });
  });
});

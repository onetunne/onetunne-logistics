import { and, eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { issues } from "~/db/schema";
import type { TrackingSnapshot } from "~/integrations/carriers/types";
import { DICTIONARIES } from "~/i18n";
import { updateOrderData, validateOrderById } from "~/modules/orders/workflow.server";
import { ORDER_CANCELLED_AFTER_PACKING, PACKING_SKIPPED_AT_HANDOVER } from "~/modules/packing/lifecycle.server";
import { confirmCancelledPackingReturned, startPacking } from "~/modules/packing/packing.server";
import { dismissWarnings, queryProblems } from "~/modules/problems/problems.server";
import { cancelOrder, createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { applyTrackingSnapshot } from "~/modules/tracking/tracking.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("no ctx");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/problems");
const ids: Record<string, string> = {};

async function prepare(number: string) {
  const id = await env.orderId(number);
  await validateOrderById(env.ctx(OWNER), id);
  const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
  if (r.kind !== "created") throw new Error(r.kind);
  ids[number] = id;
  return id;
}

beforeAll(async () => {
  env = await createTestEnv();
  const a = await prepare("#1001");
  await startPacking(env.ctx(STAFF), a);
  await cancelOrder(env.ctx(OWNER), a);
  const b = await prepare("#1002");
  await startPacking(env.ctx(STAFF), b);
  const s = (await findActiveShipment(env.handle.db, b))!;
  const snap: TrackingSnapshot = { waybillNumber: s.waybillNumber!, status: "accepted", carrierStatusCode: "ACCEPTED", carrierStatusText: null, statusAt: new Date(), events: [] };
  await applyTrackingSnapshot(env.ctx(OWNER), s.id, snap, "Test carrier");
  page = await import("~/pages/problems");
});
afterAll(async () => env.close());

async function render(search: string, locale: "uk" | "en") {
  m.ctx = { ...env.ctx(OWNER), mode: "demo", basePath: "/demo", locale };
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
      loader: () => ({ locale }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "problems", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/demo/problems${search}`));
  if (context instanceof Response) throw new Error(String(context.status));
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

describe("verify B1", () => {
  it("en page renders labels; facets with source=warehouse", async () => {
    const html = await render("?source=warehouse", "en");
    expect(html).toContain(DICTIONARIES.en["problems.source.warehouse"]!);
    expect(html).toContain(DICTIONARIES.en["problems.category.warehouse"]!);
    expect(html).toContain(DICTIONARIES.en["issue.ORDER_CANCELLED_AFTER_PACKING.title"]!.replace("—", "—"));
    const r = await queryProblems(env.handle.db, { source: "warehouse" });
    expect(r.facets.categories.warehouse).toBe(2);
    const nonWarehouse = Object.entries(r.facets.categories).filter(([k, v]) => k !== "warehouse" && v > 0);
    expect(nonWarehouse).toEqual([]);
    // source=carrier/shopify/tracking: no warehouse warnings
    for (const source of ["carrier", "shopify", "tracking"] as const) {
      const x = await queryProblems(env.handle.db, { source, pageSize: 100 });
      expect(x.groups.flatMap((g) => g.issues).some((i) => i.category === "warehouse")).toBe(false);
    }
  });

  it("closed tab shows returned_to_stock resolution under warehouse category", async () => {
    await confirmCancelledPackingReturned(env.ctx(STAFF), ids["#1001"]!);
    const r = await queryProblems(env.handle.db, { tab: "closed", category: "warehouse", pageSize: 100 });
    const flat = r.groups.flatMap((g) => g.issues);
    expect(flat.map((i) => [i.code, i.resolution])).toContainEqual([ORDER_CANCELLED_AFTER_PACKING, "returned_to_stock"]);
    const html = await render("?tab=resolved&category=warehouse", "uk");
    expect(html).toContain(DICTIONARIES.uk["problems.resolution.returned_to_stock"]!);
  });

  it("bulk dismiss with source=validation never touches warehouse warnings; with source=warehouse it does", async () => {
    const b = ids["#1002"]!;
    const v = await dismissWarnings(env.ctx(OWNER), [b], { source: "validation" });
    const [still] = await env.handle.db.select().from(issues).where(and(eq(issues.orderId, b), eq(issues.code, PACKING_SKIPPED_AT_HANDOVER)));
    expect(still!.status).toBe("open");
    expect(v.failed).toBe(0);
    const w = await dismissWarnings(env.ctx(OWNER), [b], { category: "warehouse" });
    expect(w.dismissed).toBe(1);
    const [gone] = await env.handle.db.select().from(issues).where(and(eq(issues.orderId, b), eq(issues.code, PACKING_SKIPPED_AT_HANDOVER)));
    expect(gone!.status).toBe("dismissed");
  });
});

describe("verify B2 via edit path", () => {
  it("updateOrderData (after_edit revalidation) keeps packing warnings open", async () => {
    const id = await env.orderId("#1004");
    await validateOrderById(env.ctx(OWNER), id);
    const [row] = await env.handle.db
      .insert(issues)
      .values({ orderId: id, code: ORDER_CANCELLED_AFTER_PACKING, severity: "warning", field: null, params: {}, fingerprint: `${id}:${ORDER_CANCELLED_AFTER_PACKING}:` })
      .returning();
    const { orders } = await import("~/db/schema");
    const [o] = await env.handle.db.select({ version: orders.version }).from(orders).where(eq(orders.id, id));
    const res = await updateOrderData(env.ctx(OWNER), id, { expectedVersion: o!.version, email: "verify-buyer@example.com", reason: "t" });
    expect(res.validation).not.toBeNull();
    const [after] = await env.handle.db.select().from(issues).where(eq(issues.id, row!.id));
    expect(after!.status).toBe("open");
  });
});

import { and, eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { issues, orders } from "~/db/schema";
import type { TrackingSnapshot } from "~/integrations/carriers/types";
import { DICTIONARIES } from "~/i18n";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { ORDER_CANCELLED_AFTER_PACKING, PACKING_ISSUE_CODES, PACKING_SKIPPED_AT_HANDOVER } from "~/modules/packing/lifecycle.server";
import { startPacking } from "~/modules/packing/packing.server";
import {
  PROBLEM_CATEGORIES,
  PROBLEM_SOURCES,
  WAREHOUSE_CODES,
  categoryCodeFilter,
  isProblemSource,
  problemCategory,
  problemSource,
} from "~/modules/problems/categories";
import { queryProblems } from "~/modules/problems/problems.server";
import { cancelOrder, createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { applyTrackingSnapshot } from "~/modules/tracking/tracking.server";
import { ISSUE_CATEGORIES, isIssueCategory, issueCategory } from "~/modules/validation/categories";
import { ISSUE_CODES } from "~/modules/validation/types";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Попередження складу (пакування) у «Проблемах» і при повторній перевірці даних (рев'ю R5, B1/B2):
 * - ORDER_CANCELLED_AFTER_PACKING і PACKING_SKIPPED_AT_HANDOVER зареєстровані в ISSUE_CODES з категорією «Склад» і
 *   джерелом «Склад (пакування)» (раніше — «Інше» / «Перевірка даних»), фільтри категорії й джерела їх знаходять;
 * - повторна перевірка даних замовлення їх НЕ закриває (раніше — resolved/revalidated: склад втрачав нагадування
 *   розібрати посилку чи перевірити передане).
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let problemsPage: typeof import("~/pages/problems");
const ids: Record<string, string> = {};

async function prepare(number: string) {
  const id = await env.orderId(number);
  await validateOrderById(env.ctx(OWNER), id);
  const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
  if (r.kind !== "created") throw new Error(`waybill for ${number}: ${r.kind}`);
  ids[number] = id;
  return id;
}

const snapshot = (waybillNumber: string, status: TrackingSnapshot["status"]): TrackingSnapshot => ({
  waybillNumber,
  status,
  carrierStatusCode: status.toUpperCase(),
  carrierStatusText: null,
  statusAt: new Date(),
  events: [],
});

beforeAll(async () => {
  env = await createTestEnv();
  // Скасовано під час пакування → ORDER_CANCELLED_AFTER_PACKING.
  const cancelled = await prepare("#1001");
  await startPacking(env.ctx(STAFF), cancelled);
  await cancelOrder(env.ctx(OWNER), cancelled);
  // Перевізник прийняв посилку з незавершеним пакуванням → PACKING_SKIPPED_AT_HANDOVER.
  const handed = await prepare("#1002");
  await startPacking(env.ctx(STAFF), handed);
  const shipment = (await findActiveShipment(env.handle.db, handed))!;
  await applyTrackingSnapshot(env.ctx(OWNER), shipment.id, snapshot(shipment.waybillNumber!, "accepted"), "Test carrier");
  problemsPage = await import("~/pages/problems");
});
afterAll(async () => {
  await env.close();
});

function setContext() {
  m.ctx = { ...env.ctx(OWNER), mode: "demo", basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

const uk = (key: string) => DICTIONARIES.uk[key]!;

async function openIssue(orderId: string, code: string) {
  const [row] = await env.handle.db
    .select()
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.code, code)));
  return row ?? null;
}

async function loadPage(search = "") {
  return problemsPage.loader({ request: new Request(`http://localhost/demo/problems${search}`), params: {}, context: {} } as never);
}

async function renderPage(search = ""): Promise<string> {
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
          children: [{ id: "page", path: "problems", loader: problemsPage.loader, action: problemsPage.action, Component: problemsPage.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/demo/problems${search}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

describe("packing warning codes: category and source", () => {
  it("are known issue codes with the warehouse category and source", () => {
    for (const code of PACKING_ISSUE_CODES) {
      expect(ISSUE_CODES as readonly string[], code).toContain(code);
      expect(issueCategory(code), code).toBe("warehouse");
      expect(problemCategory(code), code).toBe("warehouse");
      expect(problemSource(code), code).toBe("warehouse");
    }
    // Категорія «Склад» — рівно коди пакування (без дублювання переліку в коді «Проблем»).
    expect([...WAREHOUSE_CODES].sort()).toEqual([...PACKING_ISSUE_CODES].sort());
    expect(ISSUE_CATEGORIES).toContain("warehouse");
    expect(PROBLEM_CATEGORIES).toContain("warehouse");
    expect(PROBLEM_SOURCES).toContain("warehouse");
    expect(isIssueCategory("warehouse")).toBe(true);
    expect(isProblemSource("warehouse")).toBe(true);
    // «Інше» їх не містить; решта джерел не змінилася.
    const other = categoryCodeFilter("other");
    expect("exclude" in other && other.exclude).toEqual(expect.arrayContaining([...PACKING_ISSUE_CODES]));
    expect(problemSource("PHONE_INVALID")).toBe("validation");
    expect(problemSource("CARRIER_SHIPMENT_DELETED")).toBe("tracking");
    expect(problemSource("SHOPIFY_ORDER_CHANGED")).toBe("shopify");
  });

  it("have uk/en labels for the new category and source", () => {
    for (const key of ["problems.category.warehouse", "problems.source.warehouse"]) {
      expect(DICTIONARIES.uk[key], key).toBeTruthy();
      expect(DICTIONARIES.en[key], key).toBeTruthy();
    }
  });
});

describe("packing warnings in the Problems registry", () => {
  it("appear under the warehouse category/source; the filters find them; other/validation do not", async () => {
    const cancelled = await openIssue(ids["#1001"]!, ORDER_CANCELLED_AFTER_PACKING);
    const skipped = await openIssue(ids["#1002"]!, PACKING_SKIPPED_AT_HANDOVER);
    expect(cancelled).toMatchObject({ status: "open", severity: "warning" });
    expect(skipped).toMatchObject({ status: "open", severity: "warning" });

    const all = await queryProblems(env.handle.db, { pageSize: 100 });
    const flat = all.groups.flatMap((g) => g.issues);
    for (const row of [cancelled!, skipped!]) {
      expect(flat.find((i) => i.id === row.id)).toMatchObject({ category: "warehouse", source: "warehouse" });
    }
    expect(all.facets.categories.warehouse).toBe(2);

    const byCategory = await queryProblems(env.handle.db, { category: "warehouse", pageSize: 100 });
    expect(byCategory.groups.flatMap((g) => g.issues.map((i) => i.id)).sort()).toEqual([cancelled!.id, skipped!.id].sort());
    expect(byCategory.totalIssues).toBe(2);

    const bySource = await queryProblems(env.handle.db, { source: "warehouse", pageSize: 100 });
    expect(bySource.groups.flatMap((g) => g.issues.map((i) => i.id)).sort()).toEqual([cancelled!.id, skipped!.id].sort());

    const otherIds = (await queryProblems(env.handle.db, { category: "other", pageSize: 100 })).groups.flatMap((g) => g.issues.map((i) => i.id));
    expect(otherIds).not.toContain(cancelled!.id);
    expect(otherIds).not.toContain(skipped!.id);
    const validation = (await queryProblems(env.handle.db, { source: "validation", pageSize: 100 })).groups.flatMap((g) => g.issues);
    expect(validation.some((i) => (PACKING_ISSUE_CODES as readonly string[]).includes(i.code))).toBe(false);
    expect(validation.every((i) => i.source === "validation")).toBe(true);
  });

  it("the Problems page filters by ?category=warehouse and ?source=warehouse and shows the labels", async () => {
    const byCategory = await loadPage("?category=warehouse");
    expect(byCategory.filters.category).toBe("warehouse");
    const cat = byCategory.groups.flatMap((g) => g.issues);
    expect(cat.map((i) => i.code).sort()).toEqual([ORDER_CANCELLED_AFTER_PACKING, PACKING_SKIPPED_AT_HANDOVER].sort());
    expect(cat.every((i) => i.category === "warehouse" && i.source === "warehouse")).toBe(true);
    expect(byCategory.facets.categories.warehouse).toBe(2);

    const bySource = await loadPage("?source=warehouse");
    expect(bySource.filters.source).toBe("warehouse");
    expect(bySource.groups.flatMap((g) => g.issues).map((i) => i.code).sort()).toEqual(
      [ORDER_CANCELLED_AFTER_PACKING, PACKING_SKIPPED_AT_HANDOVER].sort(),
    );

    const html = await renderPage("?category=warehouse");
    // Чип категорії, назва категорії в картці проблеми, джерело у фільтрі, назва попередження з packing.ts.
    expect(html).toContain(uk("problems.category.warehouse"));
    expect(html).toContain(uk("problems.source.warehouse"));
    expect(html).toContain(uk("issue.ORDER_CANCELLED_AFTER_PACKING.title"));
    expect(html).toContain(uk("issue.PACKING_SKIPPED_AT_HANDOVER.title"));
    expect(html).not.toContain(`>${uk("problems.category.other")}<`);
  });
});

describe("revalidation keeps warehouse warnings open (B2)", () => {
  it("validateOrder resolves stale validation issues but never a packing warning", async () => {
    const id = await env.orderId("#1003");
    await validateOrderById(env.ctx(OWNER), id);
    const [o] = await env.handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
    expect(["awaiting_review", "needs_correction"]).toContain(o!.status);
    const insert = async (code: string) => {
      const [row] = await env.handle.db
        .insert(issues)
        .values({ orderId: id, code, severity: "warning", field: null, params: { previousStatus: "in_progress" }, fingerprint: `${id}:${code}:` })
        .returning();
      return row!;
    };
    const packingWarnings = await Promise.all(PACKING_ISSUE_CODES.map((c) => insert(c)));
    // Контроль: застаріла проблема перевірки даних (валідатор її більше не знаходить) — закривається як і раніше.
    const stale = await insert("EMAIL_INVALID");

    await validateOrderById(env.ctx(OWNER), id);
    for (const w of packingWarnings) {
      const [row] = await env.handle.db.select().from(issues).where(eq(issues.id, w.id));
      expect(row, w.code).toMatchObject({ status: "open", resolution: null, resolvedAt: null });
    }
    const [closed] = await env.handle.db.select().from(issues).where(eq(issues.id, stale.id));
    expect(closed).toMatchObject({ status: "resolved", resolution: "revalidated" });
  });
});

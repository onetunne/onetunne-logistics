import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { packagingMaterials } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/** «Склад» → «Пакувальні матеріали» (/demo/warehouse/materials, /app/warehouse/materials): права, собівартість, операції. */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/materials");
beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/materials");
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER, mode: "demo" | "production" = "demo") {
  m.ctx = { ...env.ctx(actor), mode, basePath: mode === "demo" ? "/demo" : "/app", locale: "uk" };
}
beforeEach(() => setContext());

const base = () => (m.ctx?.mode === "production" ? "http://localhost/app" : "http://localhost/demo");
const load = (search = "") => page.loader({ request: new Request(`${base()}/warehouse/materials${search}`), params: {}, context: {} } as never);
async function act(fields: Record<string, string | string[]>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return page.action({ request: new Request(`${base()}/warehouse/materials`, { method: "POST", body }), params: {}, context: {} } as never);
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
          children: [{ id: "page", path: "warehouse/materials", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/${prefix}/warehouse/materials${search}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}
const uk = (key: string) => DICTIONARIES.uk[key]!;

async function materialId(code: string) {
  const [row] = await env.handle.db.select({ id: packagingMaterials.id }).from(packagingMaterials).where(eq(packagingMaterials.code, code));
  return row!.id;
}

describe("materials loader", () => {
  it("requires warehouse.view (403) in demo and production", async () => {
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view"] } }));
    expect(await status()).toBe(403);
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view"] } }), "production");
    expect(await status()).toBe(403);
    setContext(STAFF, "production");
    expect(await status()).toBe(200);
  });

  it("staff sees stock but no costs, can only receive and cannot edit", async () => {
    setContext(STAFF);
    const data = await load("?edit=new");
    expect(data).toMatchObject({ canEdit: false, canSeeCosts: false, creating: false, editing: null, operations: ["receive"] });
    expect(data.rows.length).toBeGreaterThanOrEqual(9);
    expect(data.rows.every((r) => r.unitCost === null)).toBe(true);
    expect(data.operationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("owner sees costs, all operations and the edit form; filters by kind, status and activity", async () => {
    const data = await load(`?edit=${await materialId("box_m")}`);
    expect(data).toMatchObject({ canEdit: true, canSeeCosts: true, operations: ["receive", "writeoff", "adjust", "count"] });
    expect(data.editing).toMatchObject({ code: "box_m", unitCost: "18.00" });
    expect((await load("?kind=box")).rows.every((r) => r.kind === "box")).toBe(true);
    const low = await load("?status=low");
    expect(low.rows.length).toBeGreaterThan(0);
    expect(low.rows.every((r) => r.status === "low")).toBe(true);
    expect((await load("?activity=inactive")).rows).toEqual([]);
    expect((await load("?q=скотч")).rows.map((r) => r.code)).toEqual(["tape"]);
    expect((await load("?kind=nonsense&status=bad")).filters).toMatchObject({ kind: null, status: "all" });
  });
});

describe("materials page rendering", () => {
  it("owner: table with cost column, bulk stock form and the material form", async () => {
    const html = await render("?edit=new");
    expect(html).toContain(uk("packaging.materials.title"));
    expect(html).toContain(uk("packaging.materials.col.cost"));
    expect(html).toContain(uk("packaging.stock.title"));
    expect(html).toContain(uk("packaging.field.boxTitle"));
    expect(html).toContain('name="unitCost"');
    expect(html).toContain("Коробка M");
  });

  it("staff: no cost column, no edit buttons, receive only", async () => {
    setContext(STAFF);
    const html = await render();
    expect(html).not.toContain(uk("packaging.materials.col.cost"));
    expect(html).not.toContain('name="unitCost"');
    expect(html).not.toContain(uk("packaging.materials.add"));
    expect(html).toContain(uk("packaging.stock.op.receive"));
    expect(html).not.toContain(uk("packaging.stock.op.writeoff"));
  });
});

describe("materials actions", () => {
  const boxFields = (code: string) => ({
    intent: "createMaterial",
    code,
    name: `Коробка ${code}`,
    kind: "box",
    unit: "pcs",
    innerLengthMm: "220",
    innerWidthMm: "160",
    innerHeightMm: "90",
    maxWeightGrams: "2500",
    tareWeightGrams: "130",
    lowStockThreshold: "",
    unitCost: "11.00",
    costCurrency: "UAH",
    active: "on",
  });

  it("owner creates a material; field errors are returned for invalid input", async () => {
    expect(await act(boxFields("box_page"))).toMatchObject({ ok: true, message: "packaging.materials.result.created" });
    expect(await act(boxFields("box_page"))).toMatchObject({ ok: false, error: "packaging.error.codeTaken", params: { code: "box_page" } });
    const bad = await act({ ...boxFields("box_bad"), innerHeightMm: "" });
    expect(bad).toMatchObject({ ok: false, error: "error.validation", fieldErrors: { innerHeightMm: "packaging.error.dimsIncomplete" } });
  });

  it("update saves changes, detects stale forms and reads the active flag with form.has", async () => {
    const id = await materialId("box_page");
    const data = await load(`?edit=${id}`);
    const fields = { ...boxFields("box_page"), intent: "updateMaterial", materialId: id, version: data.editing!.version, name: "Нова назва" };
    expect(await act(fields)).toMatchObject({ ok: true, message: "packaging.materials.result.updated" });
    expect(await act({ ...fields, name: "Знову" })).toMatchObject({ ok: false, error: "error.conflict" });
    // Прапорець «Активний» не надіслано → деактивовано.
    const fresh = await load(`?edit=${id}&activity=all`);
    const { active: _ignored, ...withoutActive } = { ...fields, version: fresh.editing!.version };
    expect(await act(withoutActive)).toMatchObject({ ok: true });
    expect((await load("?activity=inactive")).rows.map((r) => r.code)).toContain("box_page");
  });

  it("staff: create/edit/bulk-deactivate are forbidden; receipt works and repeats are not applied twice", async () => {
    setContext(STAFF);
    expect(await act(boxFields("box_staff"))).toMatchObject({ ok: false, error: "error.forbidden" });
    const card = await materialId("card_thanks");
    expect(await act({ intent: "setActive", active: "0", materialIds: [card] })).toMatchObject({ ok: false, error: "error.forbidden" });
    const { operationId } = await load();
    const before = (await load()).rows.find((r) => r.id === card)!.onHand;
    const fields = { intent: "stock", operation: "receive", operationId, [`qty.${card}`]: "12", note: "" };
    const r1 = await act(fields);
    expect(r1).toMatchObject({ ok: true, message: "packaging.stock.result.applied", params: { applied: 1, duplicates: 0 } });
    expect(r1.stock?.lines[0]).toMatchObject({ before, after: before + 12, status: "applied" });
    const r2 = await act(fields);
    expect(r2).toMatchObject({ ok: true, message: "packaging.stock.result.nothing", params: { applied: 0, duplicates: 1 } });
    expect((await load()).rows.find((r) => r.id === card)!.onHand).toBe(before + 12);
    expect(await act({ ...fields, operation: "writeoff", operationId: globalThis.crypto.randomUUID() })).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act({ intent: "stock", operation: "receive", operationId: globalThis.crypto.randomUUID() })).toMatchObject({
      ok: false,
      error: "packaging.error.stockNoLines",
    });
    // Собівартість працівника ігнорується (поля у формі немає; підставлене вручну — не застосовується).
    const r3 = await act({ ...fields, operationId: globalThis.crypto.randomUUID(), unitCost: "1.00", costCurrency: "UAH" });
    expect(r3).toMatchObject({ ok: true, params: { applied: 1 } });
  });

  it("owner: bulk write-off refuses negative stock; stock count sets values", async () => {
    const bolts = await materialId("bolts_m5");
    const tape = await materialId("tape");
    const { operationId, rows } = await load();
    const boltsNow = rows.find((r) => r.id === bolts)!.onHand;
    const refused = await act({ intent: "stock", operation: "writeoff", operationId, [`qty.${bolts}`]: String(boltsNow + 5), [`qty.${tape}`]: "1" });
    expect(refused).toMatchObject({ ok: false, error: "packaging.error.insufficient", params: { code: "bolts_m5" } });
    const counted = await act({ intent: "stock", operation: "count", operationId, [`qty.${bolts}`]: "20", [`qty.${tape}`]: "" });
    expect(counted).toMatchObject({ ok: true, params: { applied: 1 } });
    expect((await load()).rows.find((r) => r.id === bolts)!.onHand).toBe(20);
    expect(await act({ intent: "setActive", active: "0", materialIds: [tape, "not-a-uuid"] })).toMatchObject({ ok: true, params: { count: 1 } });
    expect(await act({ intent: "setActive", active: "1", materialIds: [tape] })).toMatchObject({ ok: true, params: { count: 1 } });
  });

  it("a refused bulk operation keeps its operationId (form keeps quantities); only success issues the next one", async () => {
    // Регресія: після відмови сервера сторінка отримувала новий operationId з loader і очищувала всі кількості.
    const bolts = await materialId("bolts_m5");
    const card = await materialId("card_thanks");
    const { operationId, rows } = await load();
    const boltsNow = rows.find((r) => r.id === bolts)!.onHand;
    const cardNow = rows.find((r) => r.id === card)!.onHand;
    const tab1 = { intent: "stock", operation: "writeoff", operationId, [`qty.${bolts}`]: String(boltsNow), [`qty.${card}`]: "2" };
    // Інша вкладка встигла списати 1 болт.
    const other = await act({ intent: "stock", operation: "writeoff", operationId: (await load()).operationId, [`qty.${bolts}`]: "1" });
    expect(other).toMatchObject({ ok: true, params: { applied: 1 } });
    expect(other.nextOperationId).toMatch(/^[0-9a-f-]{36}$/);
    const refused = await act(tab1);
    expect(refused).toMatchObject({ ok: false, error: "packaging.error.insufficient", params: { code: "bolts_m5", current: boltsNow - 1 } });
    expect(refused.nextOperationId).toBeUndefined();
    // Виправлена форма з тим самим operationId застосовується (відмова нічого не записала).
    const fixed = await act({ ...tab1, [`qty.${bolts}`]: String(boltsNow - 1) });
    expect(fixed).toMatchObject({ ok: true, params: { applied: 2, duplicates: 0 } });
    expect(fixed.nextOperationId).toBeTruthy();
    expect(fixed.nextOperationId).not.toBe(operationId);
    // Повтор (подвійне надсилання / збій мережі) — без другого списання.
    expect(await act({ ...tab1, [`qty.${bolts}`]: String(boltsNow - 1) })).toMatchObject({ ok: true, params: { applied: 0, duplicates: 2 } });
    const after = (await load()).rows;
    expect(after.find((r) => r.id === bolts)!.onHand).toBe(0);
    expect(after.find((r) => r.id === card)!.onHand).toBe(cardNow - 2);
    await act({ intent: "stock", operation: "count", operationId: fixed.nextOperationId!, [`qty.${bolts}`]: String(boltsNow), [`qty.${card}`]: String(cardNow) });
  });

  it("the stock delta formula is shared by the form preview and the server", async () => {
    const { materialStockDelta } = await import("~/modules/packaging/schemas");
    expect(materialStockDelta("receive", 5, 10)).toBe(5);
    expect(materialStockDelta("receive", 0, 10)).toBeNull();
    expect(materialStockDelta("writeoff", 3, 10)).toBe(-3);
    expect(materialStockDelta("adjust", -4, 10)).toBe(-4);
    expect(materialStockDelta("adjust", 0, 10)).toBeNull();
    expect(materialStockDelta("count", 7, 10)).toBe(-3);
    expect(materialStockDelta("count", 1.5, 10)).toBeNull();
  });
});

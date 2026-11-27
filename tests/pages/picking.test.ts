import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { orderChanges, orderPacking, orders, packagingMaterials } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { LABEL_SKIP_REASONS, MANUAL_ADJUST_REASONS, PRIORITIES, PRIORITY_KEYS } from "~/modules/packing/constants";
import { QUEUE_TABS } from "~/modules/packing/queue-filters";
import { SELECT_BOX_REASONS } from "~/modules/packaging/box-selection";
import { PACKING_STATUSES } from "~/db/schema";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Сторінки пакування: черга (/picking), екран пакування (/picking/:orderId), пакетний друк (/picking/print),
 * об'єднані етикетки (/picking/labels, ресурсний маршрут) і картка «Пакування» на сторінці замовлення.
 * Права перевіряє сервер (packing.perform; пріоритет — orders.edit), у демо й у робочому режимі.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

type PageModule = {
  loader: (args: never) => Promise<unknown>;
  action?: (args: never) => Promise<unknown>;
  default?: () => unknown;
};

let env: TestEnv;
let picking: typeof import("~/pages/picking");
let packingOrder: typeof import("~/pages/packing-order");
let printBatch: typeof import("~/pages/print-batch");
let labelsBatch: typeof import("~/pages/labels-batch");
let orderDetail: typeof import("~/pages/order-detail");
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv();
  for (const number of ["#1001", "#1009"]) {
    const id = await env.orderId(number);
    await validateOrderById(env.ctx(OWNER), id);
    const r = await createWaybill(env.ctx(OWNER), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill ${number}: ${r.kind}`);
    ids[number] = id;
  }
  ids["#0998"] = await env.orderId("#0998");
  ids["#1004"] = await env.orderId("#1004");
  [picking, packingOrder, printBatch, labelsBatch, orderDetail] = await Promise.all([
    import("~/pages/picking"),
    import("~/pages/packing-order"),
    import("~/pages/print-batch"),
    import("~/pages/labels-batch"),
    import("~/pages/order-detail"),
  ]);
});
afterAll(async () => {
  await env.close();
});

const NO_PACKING = makeActor({ id: "np", displayName: "NP", role: "staff", overrides: { revoke: ["packing.perform"] } });
const NO_EDIT = makeActor({ id: "ne", displayName: "NE", role: "staff", overrides: { revoke: ["orders.edit"] } });

function setContext(actor: Actor = STAFF, mode: "demo" | "production" = "demo") {
  m.ctx = { ...env.ctx(actor), mode, basePath: mode === "demo" ? "/demo" : "/app", locale: "uk" };
}
beforeEach(() => setContext());

const base = () => (m.ctx?.mode === "production" ? "http://localhost/app" : "http://localhost/demo");
const uk = (key: string) => DICTIONARIES.uk[key]!;

function call(mod: PageModule, path: string, params: Record<string, string> = {}, init?: RequestInit) {
  const args = { request: new Request(`${base()}/${path}`, init), params, context: {} } as never;
  return init?.method === "POST" ? mod.action!(args) : mod.loader(args);
}
async function status(mod: PageModule, path: string, params: Record<string, string> = {}): Promise<number> {
  try {
    const r = await call(mod, path, params);
    return r instanceof Response ? r.status : 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}
function post(mod: PageModule, path: string, fields: Record<string, string | string[]>, params: Record<string, string> = {}) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  return call(mod, path, params, { method: "POST", body }) as Promise<{ ok: boolean; message?: string; error?: string; params?: Record<string, unknown> }>;
}

/** Серверний рендер сторінки в макеті демо/застосунку (як у браузері). */
async function render(mod: PageModule, routePath: string, url: string): Promise<string> {
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
          children: [{ id: "page", path: routePath, loader: mod.loader, action: mod.action, Component: mod.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost/${prefix}/${url}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

describe("dynamic i18n key families of the packing pages", () => {
  it("exist in uk and en", () => {
    const keys = [
      ...QUEUE_TABS.map((t) => `packing.tab.${t}`),
      ...PRIORITIES.map((p) => `packing.priority.${PRIORITY_KEYS[p]}`),
      ...MANUAL_ADJUST_REASONS.map((r) => `packing.adjust.reason.${r}`),
      ...LABEL_SKIP_REASONS.map((r) => `packing.labels.reason.${r}`),
      ...SELECT_BOX_REASONS.map((r) => `packing.parcel.reason.${r}`),
      ...PACKING_STATUSES.map((s) => `packing.summary.status.${s}`),
      ...["lengthMm", "widthMm", "heightMm"].map((f) => `packing.parcel.${f}`),
      ...["packing_started", "packed", "packed_override", "unpacked"].map((e) => `order.event.${e}`),
      ...["weightGrams", "lengthMm", "widthMm", "heightMm", "box"].map((f) => `field.parcel.${f}`),
    ];
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
  });
});

describe("packing queue page (/picking)", () => {
  it("requires packing.perform (403) in demo and production", async () => {
    setContext(NO_PACKING);
    expect(await status(picking, "picking")).toBe(403);
    setContext(NO_PACKING, "production");
    expect(await status(picking, "picking")).toBe(403);
    setContext(STAFF, "production");
    expect(await status(picking, "picking")).toBe(200);
  });

  it("lists the queue sorted by priority, with tabs, counts and filter options", async () => {
    const data = (await call(picking, "picking")) as Awaited<ReturnType<typeof picking.loader>>;
    expect(data.queued).toBe(3);
    expect(data.rows.map((r) => r.orderNumber)[0]).toBe("#0998"); // високий пріоритет
    expect(data.counts).toMatchObject({ queue: 3, waybill_created: 3 });
    expect(data.options.countries.map((c) => c.code)).toEqual(expect.arrayContaining(["AT", "DE"]));
    const filtered = (await call(picking, "picking?country=AT")) as Awaited<ReturnType<typeof picking.loader>>;
    expect(filtered.rows.map((r) => r.orderNumber)).toEqual(["#0998"]);
    const html = await render(picking, "picking", "picking");
    expect(html).toContain(uk("packing.bulk.start.button"));
    expect(html).toContain("#0998");
    expect(html).toContain(uk("packing.tab.needs_waybill"));
  });

  it("bulk start and bulk priority (priority requires orders.edit)", async () => {
    expect(await post(picking, "picking", { intent: "bulkStart" })).toMatchObject({ ok: false, error: "packing.bulk.noneSelected" });
    const r = await post(picking, "picking", { intent: "bulkStart", orderIds: [ids["#1009"]!, ids["#1004"]!] });
    expect(r).toMatchObject({ ok: true, message: "packing.bulk.start.result", params: { started: 1, skipped: 1 } });
    setContext(NO_EDIT);
    expect(await post(picking, "picking", { intent: "bulkPriority", priority: "2", orderIds: [ids["#1009"]!] })).toMatchObject({ ok: false, error: "error.forbidden" });
    setContext(STAFF);
    const p = await post(picking, "picking", { intent: "bulkPriority", priority: "2", orderIds: [ids["#1009"]!] });
    expect(p).toMatchObject({ ok: true, params: { updated: 1, priority: uk("packing.priority.urgent") } });
    setContext(NO_PACKING);
    expect(await post(picking, "picking", { intent: "bulkStart", orderIds: [ids["#1001"]!] })).toMatchObject({ ok: false, error: "error.forbidden" });
  });
});

describe("packing screen (/picking/:orderId)", () => {
  it("403 without packing.perform, 404 for unknown/invalid ids", async () => {
    setContext(NO_PACKING);
    expect(await status(packingOrder, `picking/${ids["#1001"]}`, { orderId: ids["#1001"]! })).toBe(403);
    setContext(STAFF);
    expect(await status(packingOrder, "picking/x", { orderId: "x" })).toBe(404);
    const unknown = "99999999-9999-4999-8999-999999999999";
    expect(await status(packingOrder, `picking/${unknown}`, { orderId: unknown })).toBe(404);
  });

  it("start → scan → confirm through the page action; renders the scanning screen and the packed state", async () => {
    const id = ids["#1001"]!;
    const params = { orderId: id };
    const path = `picking/${id}`;
    let html = await render(packingOrder, "picking/:orderId", path);
    expect(html).toContain(uk("packing.start.button"));
    expect(await post(packingOrder, path, { intent: "start" }, params)).toMatchObject({ ok: true, message: "packing.start.started" });
    html = await render(packingOrder, "picking/:orderId", path);
    expect(html).toContain(uk("packing.scan.label"));
    expect(html).toContain("OT-PH-BLK");
    expect(await post(packingOrder, path, { intent: "scan", code: "4820000000017" }, params)).toMatchObject({ ok: true, message: "packing.scan.matched" });
    expect(await post(packingOrder, path, { intent: "scan", code: "4820000000017" }, params)).toMatchObject({ ok: false, error: "packing.scan.overQuantity" });
    expect(await post(packingOrder, path, { intent: "scan", code: "OT-FK-X" }, params)).toMatchObject({ ok: false, error: "packing.scan.wrongItem" });
    const [p1] = await env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
    expect(await post(packingOrder, path, { intent: "confirm", version: String(p1!.version) }, params)).toMatchObject({
      ok: false,
      error: "packing.error.checklistIncomplete",
    });
    expect(await post(packingOrder, path, { intent: "adjust", lineId: "x", delta: "1", reason: "other" }, params)).toMatchObject({ ok: false });
    const screen = (await call(packingOrder, path, params)) as Awaited<ReturnType<typeof packingOrder.loader>>;
    const grips = screen.lines.find((l) => l.sku === "OT-GR-BLK")!;
    expect(await post(packingOrder, path, { intent: "adjust", lineId: grips.id, delta: "1", reason: "" }, params)).toMatchObject({
      ok: false,
      error: "packing.error.reasonRequired",
    });
    expect(await post(packingOrder, path, { intent: "adjust", lineId: grips.id, delta: "1", reason: "no_barcode" }, params)).toMatchObject({ ok: true });
    const [p2] = await env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
    // Застаріла версія (до ручної зміни) → конфлікт; актуальна → «Запаковано».
    expect(await post(packingOrder, path, { intent: "confirm", version: String(p1!.version) }, params)).toMatchObject({ ok: false, error: "error.conflict" });
    expect(await post(packingOrder, path, { intent: "confirm", version: String(p2!.version) }, params)).toMatchObject({ ok: true, message: "packing.confirm.done" });
    expect(await post(packingOrder, path, { intent: "confirm", version: String(p2!.version) }, params)).toMatchObject({ ok: true, message: "packing.confirm.already" });
    html = await render(packingOrder, "picking/:orderId", path);
    expect(html).toContain(uk("packing.unpack.button"));
    // Власник не потрібен для розпакування; пріоритет — лише з orders.edit.
    setContext(NO_EDIT);
    expect(await post(packingOrder, path, { intent: "priority", priority: "1" }, params)).toMatchObject({ ok: false, error: "error.forbidden" });
    setContext(STAFF);
    expect(await post(packingOrder, path, { intent: "unpack", resetChecklist: "on" }, params)).toMatchObject({ ok: true, message: "packing.unpack.done" });
    const [o] = await env.handle.db.select({ status: orders.status }).from(orders).where(eq(orders.id, id));
    expect(o!.status).toBe("awaiting_picking");
  });

  it("parcel form: validation errors are field errors; staff cannot override an incomplete checklist", async () => {
    const id = ids["#1009"]!;
    const params = { orderId: id };
    const path = `picking/${id}`;
    const [p] = await env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
    const bad = await post(packingOrder, path, { intent: "parcel", version: String(p!.version), boxMaterialId: "none", lengthMm: "100" }, params);
    expect(bad).toMatchObject({ ok: false, error: "error.validation", fieldErrors: { lengthMm: "packing.error.dimsAllOrNone" } });
    const ok = await post(packingOrder, path, { intent: "parcel", version: String(p!.version), boxMaterialId: "none", weightGrams: "300" }, params);
    expect(ok).toMatchObject({ ok: true, message: "packing.parcel.saved" });
    const [p2] = await env.handle.db.select().from(orderPacking).where(eq(orderPacking.orderId, id));
    expect(await post(packingOrder, path, { intent: "confirm", version: String(p2!.version), override: "1", overrideReason: "погоджено" }, params)).toMatchObject({
      ok: false,
      error: "packing.error.overrideOwnerOnly",
    });
    setContext(OWNER);
    const html = await render(packingOrder, "picking/:orderId", path);
    expect(html).toContain(uk("packing.override.summary"));
  });
});

describe("packing screen: changing the box (regression)", () => {
  const hidden = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1];

  it("prefilled dimensions/weight are not saved as a manual correction; the new box's dimensions are used", async () => {
    const id = ids["#0998"]!;
    const params = { orderId: id };
    const path = `picking/${id}`;
    expect(await post(packingOrder, path, { intent: "start" }, params)).toMatchObject({ ok: true, message: "packing.start.started" });
    type Screen = Awaited<ReturnType<typeof packingOrder.loader>>;
    let screen = (await call(packingOrder, path, params)) as Screen;
    // Підбір лише за вагою: коробка не підставлена, лише ★-рекомендація; розбіжності одразу після початку немає.
    expect(screen.packing?.boxMaterialId).toBeNull();
    expect(screen.mismatch).toBeNull();
    const box = async (code: string) => (await env.handle.db.select().from(packagingMaterials).where(eq(packagingMaterials.code, code)))[0]!;
    const [boxS, boxL] = [await box("box_s"), await box("box_l")];
    const goods = screen.parcel.goodsWeightGrams;
    expect(goods).toBeGreaterThan(0);

    let html = await render(packingOrder, "picking/:orderId", path);
    expect(hidden(html, "weightPrefill")).toBe(String(goods + screen.parcel.defaultTareGrams));
    expect(hidden(html, "dimsPrefill")).toBe("");
    expect(html).toContain(`★ ${boxS.name}`);
    expect(html).toContain(uk("packing.confirm.noBox"));

    // Без JavaScript: вибрано коробку L, поля лишилися з підказками попереднього стану → зберігається лише коробка.
    const r1 = await post(
      packingOrder,
      path,
      {
        intent: "parcel",
        version: String(screen.packing!.version),
        boxMaterialId: boxL.id,
        weightGrams: hidden(html, "weightPrefill")!,
        lengthMm: "",
        widthMm: "",
        heightMm: "",
        weightPrefill: hidden(html, "weightPrefill")!,
        dimsPrefill: "",
      },
      params,
    );
    expect(r1).toMatchObject({ ok: true, message: "packing.parcel.saved", params: { count: 1 } });
    const orderParcel = async () =>
      (
        await env.handle.db
          .select({ box: orders.parcelBoxMaterialId, w: orders.parcelWeightGrams, l: orders.parcelLengthMm, wd: orders.parcelWidthMm, h: orders.parcelHeightMm })
          .from(orders)
          .where(eq(orders.id, id))
      )[0]!;
    expect(await orderParcel()).toEqual({ box: boxL.id, w: null, l: null, wd: null, h: null });

    // Форма тепер підставляє габарити й тару коробки L.
    screen = (await call(packingOrder, path, params)) as Screen;
    expect(screen.parcel).toMatchObject({ lengthMm: 400, widthMm: 300, heightMm: 200, weightGrams: goods + boxL.tareWeightGrams!, savedWeightGrams: null, savedDimsMm: null });
    expect(screen.mismatch?.dims).toEqual({ waybillMm: [350, 250, 80], packedMm: [400, 300, 200] });
    html = await render(packingOrder, "picking/:orderId", path);
    expect(hidden(html, "dimsPrefill")).toBe("400x300x200");
    expect(hidden(html, "weightPrefill")).toBe(String(goods + boxL.tareWeightGrams!));

    // З JavaScript (сценарій рецензента): L → S оновлює незмінені поля під S → зберігається лише коробка S,
    // розбіжність показує фактичні габарити S, а не попередньої коробки.
    const r2 = await post(
      packingOrder,
      path,
      {
        intent: "parcel",
        version: String(screen.packing!.version),
        boxMaterialId: boxS.id,
        weightGrams: String(goods + boxS.tareWeightGrams!),
        lengthMm: "200",
        widthMm: "150",
        heightMm: "80",
        weightPrefill: String(goods + boxS.tareWeightGrams!),
        dimsPrefill: "200x150x80",
      },
      params,
    );
    expect(r2).toMatchObject({ ok: true, params: { count: 1 }, extra: ["packing.parcel.mismatch"] });
    expect(await orderParcel()).toEqual({ box: boxS.id, w: null, l: null, wd: null, h: null });
    screen = (await call(packingOrder, path, params)) as Screen;
    expect(screen.mismatch?.dims).toEqual({ waybillMm: [350, 250, 80], packedMm: [200, 150, 80] });

    // Зважена вага (≠ підказці) зберігається як ручне коригування; габарити — ні.
    const r3 = await post(
      packingOrder,
      path,
      {
        intent: "parcel",
        version: String(screen.packing!.version),
        boxMaterialId: boxS.id,
        weightGrams: "777",
        lengthMm: "200",
        widthMm: "150",
        heightMm: "80",
        weightPrefill: "",
        dimsPrefill: "200x150x80",
      },
      params,
    );
    expect(r3).toMatchObject({ ok: true, params: { count: 1 } });
    expect(await orderParcel()).toEqual({ box: boxS.id, w: 777, l: null, wd: null, h: null });
    const history = await env.handle.db.select({ field: orderChanges.field }).from(orderChanges).where(eq(orderChanges.orderId, id));
    expect(history.map((h) => h.field).filter((f) => f.startsWith("parcel.")).sort()).toEqual(["parcel.box", "parcel.box", "parcel.weightGrams"]);
    html = await render(packingOrder, "picking/:orderId", path);
    expect(hidden(html, "weightPrefill")).toBe("");
    expect(html).toContain(uk("packing.parcel.savedHint"));
  });
});

describe("print batch (/picking/print)", () => {
  it("requires packing.perform and orders.view; empty selection shows an empty state", async () => {
    setContext(NO_PACKING);
    expect(await status(printBatch, "picking/print")).toBe(403);
    setContext(makeActor({ id: "nv", displayName: "NV", role: "staff", overrides: { revoke: ["orders.view"] } }));
    expect(await status(printBatch, "picking/print")).toBe(403);
    setContext(STAFF);
    expect(await call(printBatch, "picking/print")).toMatchObject({ entries: [], ids: [] });
    const html = await render(printBatch, "picking/print", "picking/print");
    expect(html).toContain(uk("packing.print.empty"));
  });

  it("renders a packing slip and an invoice per order, each on its own sheet", async () => {
    const url = `picking/print?ids=${ids["#0998"]}&ids=${ids["#1009"]}`;
    const data = (await call(printBatch, url)) as Awaited<ReturnType<typeof printBatch.loader>>;
    expect(data.docs).toEqual(["slip", "invoice"]);
    expect(data.entries).toHaveLength(2);
    const html = await render(printBatch, "picking/print", url);
    expect(html.match(/class="ot-invoice ot-print-batch__sheet"/g)?.length).toBe(4);
    expect(html).toContain("COMMERCIAL INVOICE");
    expect(html).toContain(uk("packing.slip.addToParcel"));
    const slipsOnly = (await call(printBatch, `${url}&docs=slip`)) as Awaited<ReturnType<typeof printBatch.loader>>;
    expect(slipsOnly.entries.every((e) => e.slip && !e.invoice)).toBe(true);
  });
});

describe("merged labels (/picking/labels)", () => {
  async function labels(search: string, headers?: HeadersInit): Promise<Response> {
    return (await labelsBatch.loader({ request: new Request(`${base()}/picking/labels${search}`, { headers }), params: {}, context: {} } as never)) as Response;
  }

  it("checks origin, permission and selection", async () => {
    expect((await labels(`?ids=${ids["#0998"]}`, { Origin: "https://evil.example" })).status).toBe(403);
    setContext(NO_PACKING);
    expect((await labels(`?ids=${ids["#0998"]}`)).status).toBe(403);
    setContext(STAFF);
    const empty = await labels("");
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({ error: "packing.bulk.noneSelected" });
  });

  it("demo test carrier has no documents → 409 with every order skipped as not_supported", async () => {
    const r = await labels(`?ids=${ids["#0998"]}&ids=${ids["#1004"]}`);
    expect(r.status).toBe(409);
    expect(r.headers.get("Content-Type")).toContain("application/json");
    expect(await r.json()).toEqual({
      error: "packing.labels.noneAvailable",
      skipped: expect.arrayContaining([
        { n: "#0998", r: "not_supported" },
        { n: "#1004", r: "not_in_queue" },
      ]),
    });
  });
});

describe("order page: packing card and priority intent", () => {
  it("loader returns the packing summary; setPriority needs orders.edit", async () => {
    const id = ids["#1001"]!;
    const data = (await orderDetail.loader({ request: new Request(`${base()}/orders/${id}`), params: { orderId: id }, context: {} } as never)) as Awaited<
      ReturnType<typeof orderDetail.loader>
    >;
    expect(data.packing).toMatchObject({ inQueue: true, packing: { status: "in_progress", startedByName: STAFF.displayName } });
    const act = (actor: Actor, priority: string) => {
      setContext(actor);
      const body = new FormData();
      body.set("intent", "setPriority");
      body.set("priority", priority);
      return orderDetail.action({ request: new Request(`${base()}/orders/${id}`, { method: "POST", body }), params: { orderId: id }, context: {} } as never);
    };
    expect(await act(NO_EDIT, "2")).toMatchObject({ ok: false, error: "error.forbidden" });
    expect(await act(STAFF, "9")).toMatchObject({ ok: false, error: "packing.error.invalidPriority" });
    expect(await act(STAFF, "2")).toMatchObject({ ok: true, message: "packing.priority.saved" });
    const [o] = await env.handle.db.select({ priority: orders.priority }).from(orders).where(eq(orders.id, id));
    expect(o!.priority).toBe(2);
  });
});

import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ActionResult } from "~/components/action-banner";
import type { ShellData } from "~/components/shell-types";
import { issues, orderLineItems, orders, shipments } from "~/db/schema";
import { PERMISSIONS, makeActor } from "~/domain/permissions";
import { TEST_CARRIER_CODE, createCarrierRegistry } from "~/integrations/carriers";
import type {
  CarrierAdapter,
  CarrierCapabilities,
  CarrierDocument,
  CarrierDocumentKind,
  CarrierMode,
  CreatedShipment,
  LookupResult,
  TrackingSnapshot,
} from "~/integrations/carriers/types";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { makeT } from "~/i18n";
import { resetEnvCache } from "~/lib/env.server";
import { DEFAULT_SETTINGS } from "~/modules/settings/schema";
import { updateSetting } from "~/modules/settings/settings.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Сторінка замовлення (/demo/orders/:orderId): loader і дії через справжні запити до демо-середовища
 * (PGlite у пам'яті), а також серверний рендер сторінки (контракти E2E-сценарію).
 * Глобальне демо-середовище — окреме для кожного файлу тестів (pool: forks).
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/order-detail");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/order-detail");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

type Role = "owner" | "staff";

async function headers(role?: Role): Promise<HeadersInit> {
  return role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
}

async function orderIdOf(number: string): Promise<string> {
  const { handle } = await getDemoRuntime();
  const [row] = await handle.db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, number));
  if (!row) throw new Error(`order ${number} not found`);
  return row.id;
}

const urlOf = (orderId: string) => `http://localhost/demo/orders/${orderId}`;

async function load(orderId: string, role?: Role) {
  return page.loader({ request: new Request(urlOf(orderId), { headers: await headers(role) }), params: { orderId }, context: {} } as never);
}

async function act(orderId: string, fields: Record<string, string>, role?: Role): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request(urlOf(orderId), { method: "POST", body, headers: await headers(role) });
  return page.action({ request, params: { orderId }, context: {} } as never);
}

async function loaderStatus(orderId: string): Promise<number> {
  try {
    await load(orderId);
    return 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
}

/** Поля форми «Виправити дані» з поточних даних (як їх надсилає браузер). */
function addressForm(data: Awaited<ReturnType<typeof load>>, overrides: Record<string, string> = {}): Record<string, string> {
  const fields: Record<string, string> = {
    intent: "updateOrder",
    expectedVersion: String(data.order.version),
    email: data.order.email ?? "",
    contactPhone: data.order.contactPhone ?? "",
    reason: "",
  };
  for (const [k, v] of Object.entries(data.order.shipping)) fields[`shipping.${k}`] = v ?? "";
  fields["shipping.countryCode"] = data.order.countryCode ?? "";
  return { ...fields, ...overrides };
}

/** Серверний рендер сторінки в мінімальному дереві маршрутів (root → demo-layout → сторінка). */
async function render(orderId: string, init?: { method?: string; fields?: Record<string, string>; role?: Role }): Promise<string> {
  const staff = makeActor({ id: "demo-staff", displayName: "Demo Staff", role: "staff" });
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor:
      init?.role === "staff"
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
          children: [
            { id: "demo-order", path: "orders/:orderId", loader: page.loader, action: page.action, Component: page.default },
          ],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes);
  let body: FormData | undefined;
  if (init?.fields) {
    body = new FormData();
    for (const [k, v] of Object.entries(init.fields)) body.set(k, v);
  }
  const context = await handler.query(
    new Request(urlOf(orderId), { method: init?.method ?? "GET", body, headers: await headers(init?.role) }),
  );
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

describe("order detail loader", () => {
  it("returns 404 for malformed or unknown ids", async () => {
    expect(await loaderStatus("not-a-uuid")).toBe(404);
    expect(await loaderStatus("00000000-0000-4000-8000-000000000000")).toBe(404);
  });

  it("returns the order, country options, carrier info and no secrets", async () => {
    const id = await orderIdOf("#1004");
    const data = await load(id);
    expect(data.isDemo).toBe(true);
    expect(data.order).toMatchObject({ id, orderNumber: "#1004", status: "paid", editable: true, source: "demo" });
    expect(data.items.length).toBeGreaterThan(0);
    expect(data.shipments).toEqual([]);
    expect(data.missingShipperFields).toEqual([]);
    expect(data.carrier).toEqual({ code: TEST_CARRIER_CODE, displayName: expect.any(String), mode: "test", canCreate: true, isNovaPost: false });
    expect(data.shopifyPushEnabled).toBe(true);
    expect(data.countries.some((c) => c.code === "FR" && c.postalCodeExample)).toBe(true);
    // Відправник — лише перелік незаповнених полів, без значень налаштувань.
    expect(JSON.stringify(data)).not.toMatch(/accessToken|apiKey|password/i);
  });
});

describe("order detail scenario (#1004: FR without postal code)", () => {
  it("validate → problem → manual fix → test waybill → no duplicates → cancel waybill", async () => {
    const id = await orderIdOf("#1004");

    const validated = await act(id, { intent: "validate" });
    expect(validated).toMatchObject({ ok: true, message: "result.order.validated", tone: "warning" });
    let data = await load(id);
    expect(data.order.status).toBe("needs_correction");
    expect(data.openIssues.some((i) => i.code === "POSTAL_CODE_MISSING" && i.field === "shipping.postalCode")).toBe(true);

    // Накладну не можна створити, поки є проблеми (статус перекладається для повідомлення).
    const blocked = await act(id, { intent: "createWaybill" });
    expect(blocked).toMatchObject({ ok: true, message: "result.waybill.blocked.status", tone: "warning" });
    expect(blocked.ok && blocked.params?.status).toBe("Потребує виправлення");

    // Застаріла версія форми → конфлікт, нічого не змінено.
    const conflict = await act(id, addressForm(data, { expectedVersion: String(data.order.version - 1), "shipping.postalCode": "69001" }));
    expect(conflict).toEqual({ ok: false, error: "error.conflict", params: {} });

    const saved = await act(id, addressForm(data, { "shipping.postalCode": "69001", reason: "клієнт уточнив індекс" }));
    expect(saved).toMatchObject({ ok: true, message: "result.order.updated", params: { count: 1 }, tone: "success" });
    expect(saved.ok && saved.extra).toEqual(["sync.skipped.demo_mode"]);
    data = await load(id);
    expect(data.order.status).toBe("awaiting_review");
    expect(data.order.shipping.postalCode).toBe("69001");
    expect(data.history.changes.find((c) => c.field === "shipping.postalCode")).toMatchObject({
      oldValue: null,
      newValue: "69001",
      source: "manual",
      reason: "клієнт уточнив індекс",
      actor: "owner",
    });

    // Повторне збереження без змін.
    const same = await act(id, addressForm(data));
    expect(same).toMatchObject({ ok: true, message: "result.order.noChanges", tone: "info" });

    const created = await act(id, { intent: "createWaybill" });
    expect(created).toMatchObject({ ok: true, message: "result.waybill.created", extra: ["order.result.notShipped"], tone: "success" });
    const number = created.ok ? String(created.params?.number) : "";
    expect(number).toMatch(/^TEST\d{10}$/);

    data = await load(id);
    expect(data.order.status).toBe("waybill_created");
    expect(data.order.editable).toBe(false);
    expect(data.shipments[0]).toMatchObject({ status: "created", mode: "test", waybillNumber: number, active: true, stale: false });
    expect(data.history.events.map((e) => e.type)).toEqual(expect.arrayContaining(["request_started", "created"]));

    const again = await act(id, { intent: "createWaybill" });
    expect(again).toMatchObject({ ok: true, message: "result.waybill.already_exists", params: { number }, tone: "info" });

    // Працівник не може скасувати накладну (перевірка на сервері).
    const shipmentId = data.shipments[0]!.id;
    expect(await act(id, { intent: "cancelWaybill", shipmentId }, "staff")).toEqual({ ok: false, error: "error.forbidden" });
    // Ідентифікатор з іншого замовлення / некоректний — відхиляється.
    expect(await act(id, { intent: "cancelWaybill", shipmentId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      ok: false,
      error: "error.notFound",
    });

    expect(await act(id, { intent: "cancelWaybill", shipmentId })).toEqual({ ok: true, message: "result.waybill.cancelled" });
    data = await load(id);
    expect(data.order.status).toBe("awaiting_review");
    expect(data.shipments.find((s) => s.id === shipmentId)).toMatchObject({ status: "cancelled", active: false });
  });
});

describe("order detail actions", () => {
  it("rejects unknown intents and foreign ids", async () => {
    const id = await orderIdOf("#1001");
    expect(await act(id, { intent: "dropTables" })).toEqual({ ok: false, error: "error.generic" });
    expect(await act(id, { intent: "dismissIssue", issueId: "x' or 1=1" })).toEqual({ ok: false, error: "issue.notActionable" });
    expect(await act(id, { intent: "updateVariant", variantId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      ok: false,
      error: "error.notFound",
    });
  });

  it("pauses and resumes automation", async () => {
    const id = await orderIdOf("#1001");
    expect(await act(id, { intent: "toggleAutomation", paused: "true" })).toEqual({ ok: true, message: "result.order.paused" });
    expect((await load(id)).order.automationPaused).toBe(true);
    expect(await act(id, { intent: "toggleAutomation", paused: "false" })).toEqual({ ok: true, message: "result.order.resumed" });
    expect((await load(id)).order.automationPaused).toBe(false);
  });

  it("scopes customs field errors to the edited variant", async () => {
    const id = await orderIdOf("#1001");
    const variantId = (await load(id)).items.find((i) => i.variant)?.variant?.id ?? "";
    const res = await act(id, { intent: "updateVariant", variantId, weightGrams: "abc", hsCode: "", countryOfOrigin: "", customsDescription: "" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("error.validation");
    expect(Object.keys(res.fieldErrors ?? {})).toEqual([`variant.${variantId}.weightGrams`]);

    // Нові поля (габарити, матеріал) теж прив'язуються до варіанта.
    const dims = await act(id, { intent: "updateVariant", variantId, lengthMm: "-5", material: "x".repeat(51) });
    expect(dims.ok).toBe(false);
    if (dims.ok) return;
    expect(Object.keys(dims.fieldErrors ?? {}).sort()).toEqual([`variant.${variantId}.lengthMm`, `variant.${variantId}.material`]);
  });

  it("staff saves all customs fields as app overrides; empty fields revert to the product values", async () => {
    const id = await orderIdOf("#1001");
    const variant = (await load(id, "staff")).items.find((i) => i.variant)?.variant;
    expect(variant).toMatchObject({ overriddenFields: [], overrides: {}, material: null, lengthMm: null });
    const variantId = variant?.id ?? "";
    const fields = {
      intent: "updateVariant",
      variantId,
      hsCode: "87141000",
      countryOfOrigin: "",
      customsDescription: "",
      customsDescriptionLocal: "Тримач телефону",
      material: "Aluminium",
      weightGrams: "",
      lengthMm: "120",
      widthMm: "80",
      heightMm: "40",
    };
    expect(await act(id, fields, "staff")).toMatchObject({ ok: true, message: "result.product.updated" });
    const saved = (await load(id)).items.find((i) => i.variant?.id === variantId)?.variant;
    expect(saved).toMatchObject({ hsCode: "87141000", material: "Aluminium", lengthMm: 120, weightGrams: variant?.weightGrams });
    expect(saved?.shopify?.hsCode).toBe(variant?.hsCode);
    expect(saved?.overriddenFields.sort()).toEqual(["customsDescriptionLocal", "heightMm", "hsCode", "lengthMm", "material", "widthMm"]);

    const cleared = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, k === "intent" || k === "variantId" ? v : ""]));
    expect(await act(id, cleared, "staff")).toMatchObject({ ok: true });
    const reverted = (await load(id)).items.find((i) => i.variant?.id === variantId)?.variant;
    expect(reverted).toMatchObject({ hsCode: variant?.hsCode, material: null, lengthMm: null, overriddenFields: [] });
  });
});

describe("order detail rendering (E2E contracts)", () => {
  it("renders the validate button, dotted address inputs, save and test waybill buttons", async () => {
    const id = await orderIdOf("#1003");
    const before = await render(id);
    expect(before).toContain("Перевірити дані");
    expect(before).toContain('name="shipping.postalCode"');
    expect(before).toContain('name="shipping.countryCode"');
    expect(before).toContain("Зберегти");
    expect(before).toContain("Дані ще не перевірено");
    // Форма митних даних товару (спільна з розділом «Товари») і посилання на розділ.
    expect(before).toContain('name="customsDescriptionLocal"');
    expect(before).toContain('name="heightMm"');
    expect(before).toContain('href="/demo/products"');
    expect(before).not.toContain("(демо)");

    // #1003: однозначне автовиправлення індексу GB → без проблем.
    expect(await act(id, { intent: "validate" })).toMatchObject({ ok: true, tone: "success" });
    expect((await load(id)).order.status).toBe("awaiting_review");
    const ready = await render(id);
    expect(ready).toContain("Очікує перевірки");
    expect(ready).toContain("Створити тестову накладну");

    const afterCreate = await render(id, { method: "POST", fields: { intent: "createWaybill" } });
    expect(afterCreate).toMatch(/TEST\d{10}/);
    const reloaded = await render(id);
    expect(reloaded).toMatch(/TEST\d{10}/);
    expect(reloaded).not.toContain("Створити тестову накладну");
    expect(reloaded).toContain("Накладна створена");
    expect(reloaded).not.toContain('name="shipping.postalCode"');
  });

  it("handles an unknown waybill outcome: reconcile, manual link, no create button meanwhile", async () => {
    const id = await orderIdOf("#1009");
    expect(await act(id, { intent: "validate" })).toMatchObject({ ok: true });
    expect((await load(id)).order.status).toBe("awaiting_review");
    // Стан після обриву зв'язку: відправлення з невідомим результатом (у тестовому перевізнику запису немає).
    const { handle } = await getDemoRuntime();
    const insertUnknown = async (generation: number) => {
      const [row] = await handle.db
        .insert(shipments)
        .values({
          orderId: id,
          carrierCode: TEST_CARRIER_CODE,
          mode: "test",
          status: "unknown",
          carrierReference: `OT-1009-${generation}`,
          generation,
          createdBy: "test",
        })
        .returning();
      return row!.id;
    };
    const first = await insertUnknown(1);

    const unknownHtml = await render(id);
    expect(unknownHtml).toContain("Результат створення накладної невідомий");
    expect(unknownHtml).toContain("Перевірити у перевізника");
    expect(unknownHtml).toContain("Прив’язати накладну");
    expect(unknownHtml).toContain("Підтвердити, що накладну не створено");
    expect(unknownHtml).not.toContain("Створити тестову накладну");

    // Звірка: тестовий перевізник авторитетно не знайшов відправлення → «не створено», можна повторити.
    const reconciled = await act(id, { intent: "reconcile", shipmentId: first });
    expect(reconciled).toMatchObject({ ok: true, message: "result.waybill.not_created", tone: "warning" });
    const afterReconcile = await render(id);
    expect(afterReconcile).toContain("Створити тестову накладну");
    expect(afterReconcile).toContain("Попередні спроби");
    expect(afterReconcile).toContain("перевізник підтвердив, що накладну не створено");

    // Ручне прив'язування номера, знайденого в кабінеті перевізника.
    await handle.db.update(shipments).set({ status: "cancelled" }).where(eq(shipments.id, first));
    await insertUnknown(2);
    expect(await act(id, { intent: "linkWaybill", waybillNumber: "bad" })).toEqual({ ok: false, error: "waybill.invalidNumber", params: {} });
    expect(await act(id, { intent: "linkWaybill", waybillNumber: "abc-123456" })).toEqual({
      ok: true,
      message: "result.waybill.linked",
      params: { number: "ABC-123456" },
    });
    const data = await load(id);
    expect(data.order.status).toBe("waybill_created");
    expect(data.shipments.find((s) => s.active)).toMatchObject({ status: "created", waybillNumber: "ABC-123456" });
    const linkedHtml = await render(id);
    expect(linkedHtml).toContain("Номер накладної прив’язано вручну.");
    expect(linkedHtml).toContain("Скасувати й виправити дані");
    // Ручна прив'язка: переоформлення знімає прив'язку локально й створює нову накладну через API.
    expect(linkedHtml).toContain("Переоформити накладну");
  });

  it("offers suggestion buttons for an ambiguous phone and renders history orders", async () => {
    const ambiguous = await orderIdOf("#1006");
    await act(ambiguous, { intent: "validate" });
    const issue = (await load(ambiguous)).openIssues.find((i) => i.code === "PHONE_AMBIGUOUS");
    expect(issue?.suggestion?.candidates.length).toBeGreaterThan(1);
    const html = await render(ambiguous);
    for (const candidate of issue?.suggestion?.candidates ?? []) expect(html).toContain(`Застосувати ${candidate}`);

    for (const number of ["#0998", "#0997", "#0996"]) {
      const html = await render(await orderIdOf(number));
      expect(html).toContain(number);
      expect(html).not.toContain("Перевірити дані");
    }
  });
});

// ---------------------------------------------------------------------------
// Етап 3: відстеження, фактична передача перевізнику, документи, трек-номер у Shopify
// ---------------------------------------------------------------------------

const FAKE_CAPABILITIES: CarrierCapabilities = {
  rates: false,
  availability: false,
  createShipment: true,
  updateShipment: false,
  cancelShipment: true,
  documents: true,
  tracking: true,
  returns: false,
  findByReference: false,
  referenceLookupAuthoritative: false,
  documentKinds: ["label", "invoice"],
};

/** Перевізник з відстеженням і документами (лише в тестах; нічого не надсилає). */
class FakeTrackingCarrier implements CarrierAdapter {
  readonly capabilities: CarrierCapabilities;
  constructor(
    readonly code = "fake_trk",
    readonly displayName = "Fake tracking carrier",
    readonly mode: CarrierMode = "test",
    createShipment = true,
  ) {
    this.capabilities = { ...FAKE_CAPABILITIES, createShipment };
  }
  /** Спільний лічильник: номери накладних унікальні для всіх екземплярів (унікальний індекс у БД). */
  private static n = 0;
  snapshots = new Map<string, TrackingSnapshot>();
  fail = false;
  async createShipment(): Promise<CreatedShipment> {
    const n = ++FakeTrackingCarrier.n;
    const num = `FTR${String(n).padStart(8, "0")}`;
    return { carrierShipmentId: `fake-${n}`, waybillNumber: num, trackingNumber: num, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment() {
    return { cancelled: true };
  }
  async getTracking(numbers: string[]): Promise<TrackingSnapshot[]> {
    if (this.fail) throw new Error("carrier down");
    return numbers.flatMap((n) => (this.snapshots.has(n) ? [this.snapshots.get(n)!] : []));
  }
  async getDocument(_ref: unknown, kind: CarrierDocumentKind): Promise<CarrierDocument> {
    return { kind, format: "pdf", contentType: "application/pdf", content: new TextEncoder().encode("%PDF-1.4 fake"), fileName: `${kind}.pdf` };
  }
}

/** Тимчасово додає перевізника в демо-реєстр (і робить його перевізником за замовчуванням). */
async function withCarrier<T>(adapter: CarrierAdapter, fn: () => Promise<T>): Promise<T> {
  const runtime = await getDemoRuntime();
  const original = runtime.carriers;
  runtime.carriers = createCarrierRegistry([...original.list(), adapter], adapter.code);
  try {
    return await fn();
  } finally {
    runtime.carriers = original;
  }
}

let cloneCounter = 0;

/** Копія «чистого» демо-замовлення #1001 з новим номером (не впливає на інші тести). */
async function cleanOrder(patch: Partial<typeof orders.$inferInsert> = {}): Promise<string> {
  const { handle } = await getDemoRuntime();
  const db = handle.db;
  const [src] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
  cloneCounter++;
  const [row] = await db
    .insert(orders)
    .values({ ...rest, orderNumber: `#T3-${cloneCounter}`, status: "paid", version: 1, automationPaused: false, ...patch })
    .returning({ id: orders.id });
  const items = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id));
  for (const { id: _i, orderId: _o, ...item } of items) {
    await db.insert(orderLineItems).values({ ...item, orderId: row!.id, shopifyLineItemId: null });
  }
  return row!.id;
}

async function withWaybill(patch: Partial<typeof orders.$inferInsert> = {}): Promise<{ id: string; shipmentId: string; number: string }> {
  const id = await cleanOrder(patch);
  expect(await act(id, { intent: "validate" })).toMatchObject({ ok: true, tone: "success" });
  const created = await act(id, { intent: "createWaybill" });
  expect(created).toMatchObject({ ok: true, message: "result.waybill.created" });
  const data = await load(id);
  const active = data.shipments.find((s) => s.active);
  if (!active) throw new Error("no active shipment");
  return { id, shipmentId: active.id, number: active.waybillNumber ?? "" };
}

/** Рядки переліку накладних (/demo/waybills) — колонка «Відстеження». */
async function waybillRows() {
  const waybills = await import("~/pages/waybills");
  const data = await waybills.loader({ request: new Request("http://localhost/demo/waybills"), params: {}, context: {} } as never);
  return data.shipments;
}

describe("order detail: tracking and handover (stage 3)", () => {
  it("exposes tracking fields, documents and Shopify state for a test waybill; tracking unsupported", async () => {
    const { id, shipmentId } = await withWaybill();
    const data = await load(id);
    expect(data.shipments[0]).toMatchObject({
      id: shipmentId,
      status: "created",
      trackingStatus: null,
      carrierStatusCode: null,
      carrierStatusText: null,
      lastTrackedAt: null,
      handedOverAt: null,
      deliveredAt: null,
      trackingSupported: false,
      handoverAvailable: true,
      trackingEvents: [],
      documents: ["label"], // етап 5: зразок етикетки тестового перевізника (TEST)
      shopify: { state: "not_applicable", sentAt: null },
    });
    expect(await act(id, { intent: "refreshTracking", shipmentId })).toEqual({ ok: false, error: "tracking.notSupported", params: {} });
    expect(await act(id, { intent: "refreshTracking", shipmentId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      ok: false,
      error: "error.notFound",
    });

    const html = await render(id);
    expect(html).toContain("Посилку фізично передано перевізнику?");
    expect(html).toContain("Натискайте лише після того, як посилку фізично передали перевізнику.");
    expect(html).toContain("Замовлення не з Shopify — у Shopify нічого не надсилається.");
    expect(html).toContain("Перевізник не підтримує відстеження через API.");
    expect(html).toContain("Після фактичної передачі посилки позначте це вручну кнопкою «Передано перевізнику».");
    // Етап 5: тестовий перевізник видає зразок етикетки (TEST) — кнопка документа замість «недоступні».
    expect(html).not.toContain("Документи перевізника недоступні");
    expect(html).toContain("Етикетка (маркування)");
    expect(html).toContain(`/demo/orders/${id}/invoice`);
    expect(html).toContain("Комерційний інвойс для друку");
    expect(html).not.toContain("Оновити статус");

    // Працівник без waybills.manage: кнопки немає — і підказки, що на неї посилається, теж.
    const staffHtml = await render(id, { role: "staff" });
    expect(staffHtml).toContain("Перевізник не підтримує відстеження через API.");
    expect(staffHtml).not.toContain("позначте це вручну");
    expect(staffHtml).not.toContain("Посилку фізично передано перевізнику?");
  });

  it("markHandedOver: staff is refused on the server, owner marks once; Shopify tracking state follows", async () => {
    const { handle } = await getDemoRuntime();
    const { id, shipmentId } = await withWaybill({ source: "shopify", shopifyOrderId: "gid://shopify/Order/730001" });
    expect((await load(id)).shipments[0]?.shopify.state).toBe("after_handover");

    expect(await act(id, { intent: "markHandedOver", shipmentId }, "staff")).toEqual({ ok: false, error: "error.forbidden" });
    expect((await load(id)).order.status).toBe("waybill_created");

    // Демо-шлюз Shopify нічого не надсилає (skipped:demo_mode) — «буде передано в Shopify» не повідомляємо.
    const fulfillment = vi.spyOn(DemoShopifyGateway.prototype, "requestFulfillment");
    try {
      expect(await act(id, { intent: "markHandedOver", shipmentId })).toEqual({
        ok: true,
        message: "tracking.result.handedOver",
        extra: [],
        tone: "success",
      });
      expect(fulfillment).toHaveBeenCalledTimes(1);
      expect(fulfillment).toHaveBeenCalledWith({ shopifyOrderId: "gid://shopify/Order/730001", shipmentId });
    } finally {
      fulfillment.mockRestore();
    }
    let data = await load(id);
    expect(data.order.status).toBe("handed_to_carrier");
    expect(data.shipments[0]).toMatchObject({ handoverAvailable: false, shopify: { state: "pending", sentAt: null } });
    expect(data.shipments[0]?.handedOverAt).toBeInstanceOf(Date);
    expect(data.history.events.find((e) => e.type === "handed_over")).toMatchObject({ message: "manual" });

    expect(await act(id, { intent: "markHandedOver", shipmentId })).toEqual({ ok: false, error: "shipment.alreadyHandedOver", params: {} });

    const sentAt = new Date("2026-11-21T10:00:00Z");
    await handle.db.update(shipments).set({ shopifyFulfilledAt: sentAt }).where(eq(shipments.id, shipmentId));
    data = await load(id);
    expect(data.shipments[0]?.shopify).toEqual({ state: "sent", sentAt });

    const html = await render(id);
    expect(html).toContain("Посилку передано перевізнику");
    expect(html).toContain("підтвердив менеджер");
    expect(html).not.toContain("Посилку фізично передано перевізнику?");
    expect(html).not.toContain("Скасувати й виправити дані");
    expect(html).not.toContain("Переоформити накладну");
    // Передачу вже зафіксовано — підказки про ручну кнопку немає.
    expect(html).toContain("Перевізник не підтримує відстеження через API.");
    expect(html).not.toContain("позначте це вручну");
  });

  it("markHandedOver with Shopify push disabled: nothing is requested, state 'disabled'", async () => {
    const { handle } = await getDemoRuntime();
    const owner = makeActor({ id: "demo-owner", displayName: "Owner", role: "owner" });
    expect(await updateSetting(handle.db, owner, "tracking", { ...DEFAULT_SETTINGS.tracking, pushToShopify: false })).toMatchObject({ ok: true });
    const fulfillment = vi.spyOn(DemoShopifyGateway.prototype, "requestFulfillment");
    try {
      const { id, shipmentId } = await withWaybill({ source: "shopify", shopifyOrderId: "gid://shopify/Order/730003" });
      let data = await load(id);
      expect(data.shopifyPushEnabled).toBe(false);
      expect(data.shipments[0]?.shopify).toEqual({ state: "disabled", sentAt: null });
      expect(await render(id)).toContain("Передачу трек-номера в Shopify вимкнено в налаштуваннях");

      expect(await act(id, { intent: "markHandedOver", shipmentId })).toEqual({
        ok: true,
        message: "tracking.result.handedOver",
        extra: [],
        tone: "success",
      });
      expect(fulfillment).not.toHaveBeenCalled();
      data = await load(id);
      expect(data.order.status).toBe("handed_to_carrier");
      expect(data.shipments[0]).toMatchObject({ handoverAvailable: false, shopify: { state: "disabled", sentAt: null } });
    } finally {
      fulfillment.mockRestore();
      expect(await updateSetting(handle.db, owner, "tracking", DEFAULT_SETTINGS.tracking)).toMatchObject({ ok: true });
    }
  });

  it("handover is unavailable for a cancelled order and for a cancelled waybill", async () => {
    const { handle } = await getDemoRuntime();
    const a = await withWaybill();
    await handle.db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, a.id));
    expect((await load(a.id)).shipments[0]).toMatchObject({ status: "created", handoverAvailable: false });
    expect(await act(a.id, { intent: "markHandedOver", shipmentId: a.shipmentId })).toMatchObject({ ok: false, error: "order.notEditable" });

    const b = await withWaybill();
    expect(await act(b.id, { intent: "cancelWaybill", shipmentId: b.shipmentId })).toMatchObject({ ok: true, message: "result.waybill.cancelled" });
    expect((await load(b.id)).shipments.find((s) => s.id === b.shipmentId)).toMatchObject({
      status: "cancelled",
      active: false,
      handoverAvailable: false,
      deletedAtCarrier: false,
    });
    expect(await act(b.id, { intent: "markHandedOver", shipmentId: b.shipmentId })).toEqual({ ok: false, error: "waybill.notActive", params: {} });
  });

  it("a waybill deleted at the carrier: no handover button, a warning, and the server refuses the handover", async () => {
    const carrier = new FakeTrackingCarrier();
    await withCarrier(carrier, async () => {
      const { id, shipmentId, number } = await withWaybill({ source: "shopify", shopifyOrderId: "gid://shopify/Order/730002" });
      expect((await load(id)).shipments[0]).toMatchObject({ handoverAvailable: true, deletedAtCarrier: false });

      // Nova Post: код 2 («Deleted») → cancelled.
      carrier.snapshots.set(number, {
        waybillNumber: number,
        status: "cancelled",
        carrierStatusCode: "2",
        carrierStatusText: "Видалено",
        statusAt: new Date("2026-11-20T10:00:00Z"),
        events: [],
      });
      expect(await act(id, { intent: "refreshTracking", shipmentId })).toMatchObject({ ok: true, message: "tracking.result.updated" });
      let data = await load(id);
      expect(data.order.status).toBe("waybill_created");
      expect(data.shipments[0]).toMatchObject({
        status: "created",
        trackingStatus: "cancelled",
        handedOverAt: null,
        deletedAtCarrier: true,
        handoverAvailable: false,
      });
      expect(data.openIssues.map((i) => i.code)).toContain("CARRIER_SHIPMENT_DELETED");

      const fulfillment = vi.spyOn(DemoShopifyGateway.prototype, "requestFulfillment");
      try {
        expect(await act(id, { intent: "markHandedOver", shipmentId }, "staff")).toEqual({ ok: false, error: "error.forbidden" });
        expect(await act(id, { intent: "markHandedOver", shipmentId })).toEqual({ ok: false, error: "shipment.deletedAtCarrier", params: {} });
        expect(fulfillment).not.toHaveBeenCalled();
      } finally {
        fulfillment.mockRestore();
      }
      data = await load(id);
      expect(data.order.status).toBe("waybill_created");
      expect(data.shipments[0]?.handedOverAt).toBeNull();

      const html = await render(id);
      expect(html).toContain("Перевізник повідомляє: накладну видалено");
      expect(html).toContain("Скасовано у перевізника");
      expect(html).not.toContain("Посилку фізично передано перевізнику?");
      // Вихід — скасувати накладну й створити нову.
      expect(html).toContain("Скасувати й виправити дані");
      expect(html).toContain("Переоформити накладну");
      expect((await waybillRows()).find((r) => r.id === shipmentId)).toMatchObject({ status: "created", trackingStatus: "cancelled" });

      expect(await act(id, { intent: "cancelWaybill", shipmentId })).toMatchObject({ ok: true, message: "result.waybill.cancelled" });
      // Скасована накладна: статус відстеження в переліку не показується.
      expect((await waybillRows()).find((r) => r.id === shipmentId)).toMatchObject({ status: "cancelled", trackingStatus: null });
      expect((await load(id)).shipments.find((s) => s.id === shipmentId)).toMatchObject({ deletedAtCarrier: false, handoverAvailable: false });
    });
  });

  it("refreshTracking with a tracking carrier: status, events newest first, handover by the carrier, documents", async () => {
    const carrier = new FakeTrackingCarrier();
    await withCarrier(carrier, async () => {
      const { id, shipmentId, number } = await withWaybill();
      let data = await load(id);
      expect(data.shipments[0]).toMatchObject({ trackingSupported: true, documents: ["label", "invoice"], carrierName: "Fake tracking carrier" });

      // Перевізник ще не знає номера — статус не змінився (лише час перевірки).
      expect(await act(id, { intent: "refreshTracking", shipmentId }, "staff")).toEqual({
        ok: true,
        message: "tracking.result.unchanged",
        tone: "info",
      });
      expect((await load(id)).shipments[0]?.lastTrackedAt).toBeInstanceOf(Date);

      carrier.snapshots.set(number, {
        waybillNumber: number,
        status: "in_transit",
        carrierStatusCode: "5",
        carrierStatusText: "Прямує до країни призначення",
        statusAt: new Date("2026-11-20T10:00:00Z"),
        events: [
          { status: "created", code: "1", occurredAt: new Date("2026-11-20T08:00:00Z"), location: null, description: "Створено" },
          { status: "accepted", code: "4", occurredAt: new Date("2026-11-20T09:00:00Z"), location: "Kyiv, UA", description: "Прийнято" },
          { status: "in_transit", code: "5", occurredAt: new Date("2026-11-20T10:00:00Z"), location: "Kyiv, UA", description: "У дорозі" },
        ],
      });
      expect(await act(id, { intent: "refreshTracking", shipmentId })).toEqual({
        ok: true,
        message: "tracking.result.updated",
        extra: ["tracking.result.handedOverByCarrier"],
        tone: "success",
      });
      data = await load(id);
      expect(data.order.status).toBe("in_transit");
      const s = data.shipments[0]!;
      expect(s).toMatchObject({
        trackingStatus: "in_transit",
        carrierStatusCode: "5",
        carrierStatusText: "Прямує до країни призначення",
        handoverAvailable: false,
      });
      expect(s.handedOverAt?.toISOString()).toBe("2026-11-20T09:00:00.000Z");
      expect(s.trackingEvents.map((e) => [e.status, e.code])).toEqual([
        ["in_transit", "5"],
        ["accepted", "4"],
        ["created", "1"],
      ]);
      expect(Object.keys(s.trackingEvents[0]!).sort()).toEqual(["code", "description", "id", "location", "occurredAt", "status"]);
      expect(data.history.events.find((e) => e.type === "tracking_status")).toMatchObject({ trackingStatus: "in_transit" });
      // Перелік накладних показує той самий статус відстеження.
      expect((await waybillRows()).find((r) => r.id === shipmentId)).toMatchObject({ status: "created", trackingStatus: "in_transit" });

      // Повторне оновлення без змін і збій перевізника.
      expect(await act(id, { intent: "refreshTracking", shipmentId })).toMatchObject({ ok: true, message: "tracking.result.unchanged" });
      carrier.fail = true;
      expect(await act(id, { intent: "refreshTracking", shipmentId })).toEqual({ ok: false, error: "tracking.carrierUnavailable", params: {} });
      carrier.fail = false;

      const html = await render(id);
      expect(html).toContain("Оновити статус");
      expect(html).toContain("Події перевізника");
      expect(html).toContain("Прямує до країни призначення (код 5)");
      expect(html).toContain("Прийнято перевізником");
      expect(html).toContain("Етикетка (маркування)");
      expect(html).toContain("Комерційний інвойс перевізника");
      expect(html).not.toContain("Посилку фізично передано перевізнику?");
    });
  });

  it("explains that real Nova Post waybills are disabled until the owner enables them", async () => {
    const id = await cleanOrder();
    expect(await act(id, { intent: "validate" })).toMatchObject({ ok: true });
    // Nova Post без дозволу на створення накладних (як у робочому режимі без NOVA_POST_SHIPMENTS_ENABLED).
    await withCarrier(new FakeTrackingCarrier("nova_post", "Nova Post", "live", false), async () => {
      const data = await load(id);
      expect(data.carrier).toEqual({ code: "nova_post", displayName: "Nova Post", mode: "live", canCreate: false, isNovaPost: true });
      const html = await render(id);
      expect(html).toContain("Nova Post: створення реальних накладних вимкнено");
      expect(html).toContain("NOVA_POST_SHIPMENTS_ENABLED=true");
      expect(html).not.toContain("Створити накладну");
      expect(html).not.toContain("Створити тестову накладну");
    });
    // Тестовий перевізник демо — без змін.
    expect(await render(id)).toContain("Створити тестову накладну");
  });
});

describe("order detail: long suggestion candidates", () => {
  it("accepts a stored candidate longer than 64 characters (address line 2 → line 1)", async () => {
    const line2 = "Musterstraße 12, Hinterhaus, Aufgang B, 3. Etage links, bei Familie Beispiel";
    expect(line2.length).toBeGreaterThan(64);
    const id = await cleanOrder({ shipAddress1: null, shipAddress2: line2 });
    await act(id, { intent: "validate" });
    const issue = (await load(id)).openIssues.find((i) => i.code === "ADDRESS_LINE1_EMPTY_LINE2_FILLED");
    expect(issue?.suggestion?.candidates).toEqual([line2]);
    expect(await act(id, { intent: "acceptSuggestion", issueId: issue!.id, candidate: line2 })).toMatchObject({
      ok: true,
      message: "result.suggestion.accepted",
    });
    expect(await act(id, { intent: "acceptSuggestion", issueId: issue!.id, candidate: "x".repeat(201) })).toMatchObject({ ok: false });
  });
});

describe("order detail: re-issue and Shopify re-sync (stage 4)", () => {
  it("a created waybill shows the waybill view with «Переоформити» and «Скасувати й виправити дані» instead of create", async () => {
    const { id, shipmentId, number } = await withWaybill();
    const data = await load(id);
    expect(data.shipments[0]).toMatchObject({ id: shipmentId, reissuable: true });
    const html = await render(id);
    expect(html).not.toContain("Створити тестову накладну");
    expect(html).toContain("Змінити накладну");
    expect(html).toContain("Переоформити накладну");
    expect(html).toContain("Скасувати й виправити дані");
    // Діалоги пояснюють наслідки (тестова накладна — у реального перевізника нічого не скасовується).
    expect(html).toContain(`Переоформити накладну ${number}?`);
    expect(html).toContain(`Тестову накладну ${number} буде скасовано`);
    expect(html).toContain("стара накладна все одно залишиться скасованою");
    expect(html).toContain("Нову накладну НЕ буде створено автоматично");
    // Кнопки в стеку з перенесенням рядків (мобільний екран без горизонтальної прокрутки).
    expect(html).toMatch(/ot-stack--horizontal[^"]*ot-stack--wrap[^>]*>(?:(?!<\/div>).)*reissueWaybill/s);

    // Працівник (без waybills.manage): кнопок немає, сервер відмовляє.
    const staffHtml = await render(id, { role: "staff" });
    expect(staffHtml).not.toContain("Переоформити накладну");
    expect(staffHtml).not.toContain("Скасувати й виправити дані");
    expect(await act(id, { intent: "reissueWaybill", shipmentId }, "staff")).toEqual({ ok: false, error: "error.forbidden" });
    expect(await act(id, { intent: "reissueWaybill", shipmentId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      ok: false,
      error: "error.notFound",
    });
  });

  it("re-issue: old waybill cancelled, new generation created, no duplicates; the waybills list marks the generation", async () => {
    const { id, shipmentId, number } = await withWaybill();
    const r = await act(id, { intent: "reissueWaybill", shipmentId });
    expect(r).toMatchObject({ ok: true, message: "order.reissue.result.reissued", tone: "success", extra: ["order.result.notShipped"] });
    const params = r.ok ? r.params : undefined;
    expect(params?.old).toBe(number);
    expect(String(params?.number)).toMatch(/^TEST\d{10}$/);
    expect(params?.number).not.toBe(number);

    const data = await load(id);
    expect(data.order.status).toBe("waybill_created");
    expect(data.shipments.filter((s) => s.active)).toHaveLength(1);
    expect(data.shipments.find((s) => s.active)).toMatchObject({ generation: 2, waybillNumber: params?.number, reissuable: true });
    expect(data.shipments.find((s) => s.id === shipmentId)).toMatchObject({ status: "cancelled", active: false });
    expect(data.history.events.map((e) => e.type)).toEqual(expect.arrayContaining(["cancelled", "reissued", "created"]));

    // Повтор форми для старої (уже скасованої) накладної — відмова, дубліката немає.
    expect(await act(id, { intent: "reissueWaybill", shipmentId })).toEqual({ ok: false, error: "waybill.notCancellable", params: {} });
    expect((await load(id)).shipments).toHaveLength(2);

    const rows = (await waybillRows()).filter((row) => row.orderId === id);
    expect(rows.map((row) => row.generation).sort()).toEqual([1, 2]);
    const html = await render(id);
    expect(html).toContain("Накладну переоформлено — створено нове покоління");
  });

  it("re-issue blocked by the dry-run data check: nothing is cancelled, the banner names the problems and the way out", async () => {
    const { id, shipmentId } = await withWaybill();
    const { handle } = await getDemoRuntime();
    await handle.db.update(orders).set({ shipCity: null }).where(eq(orders.id, id));
    const r = await act(id, { intent: "reissueWaybill", shipmentId });
    expect(r).toMatchObject({
      ok: true,
      message: "order.reissue.result.notStarted",
      extra: ["result.waybill.blocked.validation", "order.reissue.result.validationIssues", "order.reissue.result.correctInstead"],
      tone: "warning",
    });
    expect(r.ok && String(r.params?.issues)).toContain("Немає міста");
    const data = await load(id);
    expect(data.shipments.filter((s) => s.active)).toHaveLength(1);
    expect(data.order).toMatchObject({ status: "waybill_created" });
    const html = await render(id, { method: "POST", fields: { intent: "reissueWaybill", shipmentId } });
    expect(html).toContain("стару накладну не скасовано");
    expect(html).toContain("Проблеми з даними: Немає міста");
    expect(html).toContain("«Скасувати й виправити дані»");
  });

  it("re-issue blocked after the cancellation: the banner says the old waybill IS cancelled and shows the real status", async () => {
    const { id, shipmentId, number } = await withWaybill();
    const { handle } = await getDemoRuntime();
    const sim = DEFAULT_SETTINGS.testCarrier;
    const owner = makeActor({ id: "demo-owner", displayName: "Owner", role: "owner" });
    await updateSetting(handle.db, owner, "testCarrier", { ...sim, simulation: "reject" });
    try {
      const r = await act(id, { intent: "reissueWaybill", shipmentId });
      expect(r).toMatchObject({
        ok: true,
        message: "order.reissue.result.cancelledOnly",
        extra: ["result.waybill.rejected", "order.reissue.result.fixAndCreate"],
        tone: "critical",
      });
      expect(r.ok && r.params?.old).toBe(number);
      expect(r.ok && r.params?.orderStatus).toBe("Потребує виправлення");
    } finally {
      await updateSetting(handle.db, owner, "testCarrier", sim);
    }
    const data = await load(id);
    expect(data.shipments.filter((s) => s.active)).toHaveLength(0);
    expect(data.order).toMatchObject({ status: "needs_correction", editable: true });
    expect(makeT("uk")("order.reissue.result.fixAndCreate", { orderStatus: "Потребує виправлення" })).toContain(
      "Статус замовлення зараз — «Потребує виправлення»",
    );
  });

  it("«Скасувати й виправити дані» cancels only and explains the next step", async () => {
    const { id, shipmentId } = await withWaybill();
    expect(await act(id, { intent: "cancelWaybill", shipmentId, purpose: "correction" })).toEqual({
      ok: true,
      message: "result.waybill.cancelled",
      extra: ["order.correct.result"],
    });
    // Банер не повторює «Накладну скасовано.» двічі.
    for (const locale of ["uk", "en"] as const) {
      const t = makeT(locale);
      const first = t("result.waybill.cancelled").replace(/\.$/, "");
      expect(t("order.correct.result"), locale).not.toContain(first);
    }
    const data = await load(id);
    expect(data.shipments.filter((s) => s.active)).toHaveLength(0);
    expect(data.order).toMatchObject({ status: "awaiting_review", editable: true });
    expect(await render(id)).toContain("Створити тестову накладну");
  });

  it("data changed in Shopify after the waybill: a hint explains that re-issue is the way to apply it", async () => {
    const { id } = await withWaybill();
    const { handle } = await getDemoRuntime();
    await handle.db.insert(issues).values({
      orderId: id,
      code: "SHOPIFY_ORDER_CHANGED",
      severity: "warning",
      params: { fields: "shipping.city, email" },
      fingerprint: `${id}:SHOPIFY_ORDER_CHANGED:`,
    });
    const html = await render(id);
    expect(html).toContain("Дані змінено в Shopify після створення накладної");
    expect(html).toContain("У Shopify змінено: Місто, Email");
    expect(html).toContain("накладну потрібно переоформити");
    expect(html).toContain('value="shopify_changed"');
  });

  it("Shopify sync state for confirmed corrections in the demo, and «Повторно надіслати в Shopify» explains nothing is sent", async () => {
    const id = await cleanOrder();
    expect(await act(id, { intent: "validate" })).toMatchObject({ ok: true });
    let data = await load(id);
    expect(data.shopifyPush).toEqual({ state: "demo", hasChanges: false });
    expect(await render(id)).not.toContain("Повторно надіслати в Shopify");

    expect(await act(id, addressForm(data, { "shipping.address2": "Hinterhaus" }))).toMatchObject({ ok: true, message: "result.order.updated" });
    data = await load(id);
    expect(data.shopifyPush).toEqual({ state: "demo", hasChanges: true });
    const html = await render(id);
    expect(html).toContain("Виправлені контакти й адреса в Shopify");
    expect(html).toContain("Демо: у Shopify нічого не надсилається.");
    expect(html).toContain("Повторно надіслати в Shopify");

    const sendSpy = vi.spyOn(DemoShopifyGateway.prototype, "updateOrderShippingAddress");
    try {
      expect(await act(id, { intent: "resendShopify" }, "staff")).toEqual({ ok: true, message: "order.shopifySync.result.demo", tone: "info" });
      expect(sendSpy).not.toHaveBeenCalled();
    } finally {
      sendSpy.mockRestore();
    }
  });
});

import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult } from "~/components/action-banner";
import type { ShellData } from "~/components/shell-types";
import { orders, shipments } from "~/db/schema";
import { PERMISSIONS } from "~/domain/permissions";
import { TEST_CARRIER_CODE } from "~/integrations/carriers";
import { resetEnvCache } from "~/lib/env.server";
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
async function render(orderId: string, init?: { method?: string; fields?: Record<string, string> }): Promise<string> {
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor: { id: "demo-owner", displayName: "Demo Owner", role: "owner", permissions: [...PERMISSIONS] },
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
  const context = await handler.query(new Request(urlOf(orderId), { method: init?.method ?? "GET", body }));
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
    expect(data.carrier).toEqual({ displayName: expect.any(String), mode: "test", canCreate: true });
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
    expect(linkedHtml).toContain("Скасувати накладну");
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

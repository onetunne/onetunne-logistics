import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { orderLineItems, orders } from "~/db/schema";
import { PERMISSIONS, makeActor } from "~/domain/permissions";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { resetEnvCache } from "~/lib/env.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { cancelWaybill, createWaybill } from "~/modules/shipments/waybill.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";

/**
 * Комерційний інвойс для друку (/demo/orders/:orderId/invoice): loader (дозволи, 404) і серверний рендер.
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/order-invoice");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/order-invoice");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

type Role = "owner" | "staff";

async function orderIdOf(number: string): Promise<string> {
  const { handle } = await getDemoRuntime();
  const [row] = await handle.db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, number));
  if (!row) throw new Error(`order ${number} not found`);
  return row.id;
}

const urlOf = (orderId: string) => `http://localhost/demo/orders/${orderId}/invoice`;

async function load(orderId: string, role?: Role) {
  const headers: HeadersInit = role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
  return page.loader({ request: new Request(urlOf(orderId), { headers }), params: { orderId }, context: {} } as never);
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

async function render(orderId: string, locale: "uk" | "en" = "uk"): Promise<string> {
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
      loader: () => ({ locale }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "demo-order-invoice", path: "orders/:orderId/invoice", loader: page.loader, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request(urlOf(orderId)));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(h(StaticRouterProvider, { router, context }));
}

describe("order invoice loader", () => {
  it("returns the commercial invoice for the order", async () => {
    const id = await orderIdOf("#1001");
    const data = await load(id);
    expect(data.orderId).toBe(id);
    expect(data.orderNumber).toBe("#1001");
    expect(data.invoice).toMatchObject({ number: "INV-1001", type: "commercial", incoterm: "DAP", exportReason: "sale", missing: [] });
    expect(data.invoice.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(data.invoice.lines.length).toBeGreaterThan(0);
    expect(data.invoice.lines[0]).toMatchObject({ position: 1, hsCode: expect.any(String), countryOfOrigin: "UA" });
    expect(data.invoice.waybillNumber).toBeNull();
    expect(data.sellerCountry).toBe("Ukraine");
    expect(JSON.stringify(data)).not.toMatch(/accessToken|apiKey|password/i);
  });

  it("is available to staff (orders.view)", async () => {
    const id = await orderIdOf("#1002");
    const data = await load(id, "staff");
    expect(data.invoice.number).toBe("INV-1002");
  });

  it("returns 404 for malformed or unknown order ids", async () => {
    expect(await loaderStatus("not-a-uuid")).toBe(404);
    expect(await loaderStatus("00000000-0000-4000-8000-000000000000")).toBe(404);
  });

  it("reports missing customs data without inventing values", async () => {
    const data = await load(await orderIdOf("#1008"));
    expect(data.invoice.missing).toEqual(
      expect.arrayContaining([
        { position: 1, field: "hsCode" },
        { position: 1, field: "customsDescription" },
      ]),
    );
    expect(data.invoice.lines[0]?.hsCode).toBeNull();
  });
});

describe("order invoice rendering", () => {
  it("renders an English document with localized chrome and a print button", async () => {
    const html = await render(await orderIdOf("#1001"));
    expect(html).toContain("COMMERCIAL INVOICE");
    expect(html).toContain("INV-1001");
    expect(html).toContain("Seller / Exporter");
    expect(html).toContain("Buyer / Consignee");
    expect(html).toContain("HS code");
    expect(html).toContain("Total net weight");
    expect(html).toContain("I declare that the information on this invoice is true and correct");
    expect(html).toContain("Друкувати");
    expect(html).toContain("Комерційний інвойс INV-1001");
    expect(html).toContain("ot-invoice-page");
    expect(html).not.toContain("Бракує митних даних");

    const en = await render(await orderIdOf("#1001"), "en");
    expect(en).toContain("Print");
    expect(en).toContain("COMMERCIAL INVOICE");
  });

  it("warns about missing customs data and links back to the order", async () => {
    const id = await orderIdOf("#1008");
    const html = await render(id);
    expect(html).toContain("Бракує митних даних");
    expect(html).toMatch(/Позиція 1 \([^)]+\): HS-код, Митний опис/);
    expect(html).toContain(`href="/demo/orders/${id}"`);
  });
});

describe("order invoice with a waybill", () => {
  async function serviceCtx(): Promise<ServiceContext> {
    const runtime = await getDemoRuntime();
    return {
      mode: "demo",
      db: runtime.handle.db,
      actor: makeActor({ id: "demo-owner", displayName: "Owner", role: "owner" }),
      carriers: runtime.carriers,
      shopify: new DemoShopifyGateway(),
      now: () => new Date(),
    };
  }

  /** Копія «чистого» демо-замовлення #1001 з новим номером (не впливає на інші тести). */
  async function cleanOrder(): Promise<string> {
    const { handle } = await getDemoRuntime();
    const db = handle.db;
    const [src] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
    const [row] = await db
      .insert(orders)
      .values({ ...rest, orderNumber: "#INV-W1", status: "paid", version: 1, automationPaused: false })
      .returning({ id: orders.id });
    const items = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id));
    for (const { id: _i, orderId: _o, ...item } of items) {
      await db.insert(orderLineItems).values({ ...item, orderId: row!.id, shopifyLineItemId: null });
    }
    return row!.id;
  }

  it("shows the number of the created waybill and drops it after the waybill is cancelled", async () => {
    const ctx = await serviceCtx();
    const id = await cleanOrder();
    expect((await load(id)).invoice.waybillNumber).toBeNull();
    await validateOrderById(ctx, id);
    const created = await createWaybill(ctx, id);
    if (created.kind !== "created") throw new Error(`waybill not created: ${created.kind}`);
    const number = created.shipment.waybillNumber;
    expect(number).toBeTruthy();

    const data = await load(id);
    expect(data.orderNumber).toBe("#INV-W1");
    expect(data.invoice.number).toBe("INV-INV-W1");
    expect(data.invoice.waybillNumber).toBe(number);
    const html = await render(id);
    expect(html).toContain("Waybill / AWB No.");
    expect(html).toContain(number!);
    expect(html).not.toContain("Номер накладної з’явиться в інвойсі");

    await cancelWaybill(ctx, created.shipment.id);
    expect((await load(id)).invoice.waybillNumber).toBeNull();
    expect(await render(id)).toContain("Номер накладної з’явиться в інвойсі");
  });
});

describe("invoice print styles", () => {
  /** Вміст усіх блоків @media print у styles.css (вкладені фігурні дужки враховуються). */
  function printBlocks(css: string): string[] {
    const blocks: string[] = [];
    for (const m of css.matchAll(/@media print\s*\{/g)) {
      let depth = 1;
      let i = m.index + m[0].length;
      const start = i;
      while (i < css.length && depth > 0) {
        if (css[i] === "{") depth++;
        else if (css[i] === "}") depth--;
        i++;
      }
      blocks.push(css.slice(start, i - 1));
    }
    return blocks;
  }

  it("prints the signature lines black even in the dark theme", () => {
    const css = fs.readFileSync(path.resolve("app/ui/styles.css"), "utf8");
    // На екрані лінія — кольору тексту теми (у темній темі майже біла).
    expect(css).toMatch(/\.ot-invoice__line\s*\{[^}]*border-bottom:\s*1px solid var\(--ot-color-text\)/);
    const rules = printBlocks(css).flatMap((b) => [...b.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((r) => ({ selectors: r[1]!, body: r[2]! })));
    const line = rules.filter((r) => r.selectors.split(",").some((sel) => sel.trim() === ".ot-invoice__line"));
    expect(line.some((r) => /border(-bottom)?-color:\s*#000(000)?\b/.test(r.body))).toBe(true);
  });
});

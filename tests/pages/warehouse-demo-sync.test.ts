/**
 * «Залишки» (/warehouse): позначка «розбіжність» Shopify (S5-DEMO-SYNC). У демо Shopify не оновлюється — після операцій
 * складу «доступно» застосунку відрізняється від вигаданого значення «Shopify», і жовта позначка була б тривогою, на
 * яку не можна відреагувати («Звірка з Shopify» в демо недоступна). Тож у демо — нейтральна підказка й демо-легенда;
 * робочий режим без змін (позначка й звичайна легенда).
 */
import { eq } from "drizzle-orm";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import { productVariants } from "~/db/schema";
import { DICTIONARIES, type Locale } from "~/i18n";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { newOperationId, receiveStock } from "~/modules/warehouse/operations.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let stockPage: typeof import("~/pages/warehouse");

beforeAll(async () => {
  env = await createTestEnv();
  stockPage = await import("~/pages/warehouse");
  // Звичайна операція складу: +5 шт. → у застосунку доступно більше, ніж вигадане значення «Shopify».
  const [variant] = await env.handle.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, "OT-GR-BLK"));
  const stockItemId = await ensureStockItemForVariant(env.handle.db, variant!.id);
  await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId, quantity: 5, reason: "purchase" });
});
afterAll(async () => {
  await env.close();
});

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function render(mode: "demo" | "production", locale: Locale = "uk", actor = OWNER): Promise<string> {
  m.ctx = { ...env.ctx(actor), mode, basePath: "/demo", locale };
  const shell: ShellData = {
    mode,
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
      loader: () => ({ locale }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "warehouse", loader: stockPage.loader, action: stockPage.action, Component: stockPage.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request("http://localhost/demo/warehouse"));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

/** Позначка «розбіжність» — бейдж зі словом як вмістом (у легенді воно в лапках). */
const badge = (locale: Locale) => `>${esc(DICTIONARIES[locale]["warehouse.stock.shopify.differsShort"]!)}</span>`;

describe("stock list: Shopify «differs» marker by mode", () => {
  it("the operation made the app and the demo «Shopify» values differ", async () => {
    m.ctx = { ...env.ctx(OWNER), mode: "demo", basePath: "/demo", locale: "uk" };
    const data = (await stockPage.loader({ request: new Request("http://localhost/demo/warehouse?q=OT-GR-BLK"), params: {}, context: {} } as never)) as {
      rows: Array<{ sku: string | null; available: number; shopifyAvailable: number | null; tracking: string | null }>;
    };
    const row = data.rows.find((r) => r.sku === "OT-GR-BLK")!;
    expect(row.tracking).toBe("opened");
    expect(row.available).toBe((row.shopifyAvailable ?? 0) + 5);
  });

  for (const locale of ["uk", "en"] as const) {
    it(`demo (${locale}): no «differs» badge, a neutral hint and the demo legend`, async () => {
      for (const actor of [OWNER, STAFF]) {
        const html = await render("demo", locale, actor);
        const d = DICTIONARIES[locale];
        expect(html, actor.role).not.toContain(badge(locale));
        expect(html, actor.role).toContain(`title="${esc(d["warehouse.stock.shopify.demoHint"]!)}"`);
        expect(html, actor.role).toContain(esc(d["warehouse.stock.shopify.demoLegend"]!));
        expect(html, actor.role).not.toContain(esc(d["warehouse.stock.shopify.legend"]!));
      }
    });

    it(`production (${locale}): unchanged — the «differs» badge and the regular legend`, async () => {
      const html = await render("production", locale);
      const d = DICTIONARIES[locale];
      expect(html).toContain(badge(locale));
      expect(html).toContain(esc(d["warehouse.stock.shopify.legend"]!));
      expect(html).not.toContain(esc(d["warehouse.stock.shopify.demoLegend"]!));
      expect(html).not.toContain(esc(d["warehouse.stock.shopify.demoHint"]!));
    });
  }
});

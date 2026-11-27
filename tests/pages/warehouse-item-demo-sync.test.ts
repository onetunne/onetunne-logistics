/**
 * Картка позиції складу (/warehouse/items/:id): розбіжність із Shopify (A-R6-1, як S5-DEMO-SYNC у списку «Склад»).
 * У демо Shopify не оновлюється — після надходження «доступно» застосунку відрізняється від вигаданого значення «Shopify»,
 * а «Звірка з Shopify» в демо нічого не може зробити. Тож у демо — нейтральна підказка без речення про розбіжність і без
 * посилання на звірку; робочий режим без змін.
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
let itemPage: typeof import("~/pages/warehouse-item");
let stockItemId = "";

beforeAll(async () => {
  env = await createTestEnv();
  itemPage = await import("~/pages/warehouse-item");
  const [variant] = await env.handle.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.sku, "OT-GR-BLK"));
  stockItemId = await ensureStockItemForVariant(env.handle.db, variant!.id);
  // Звичайне надходження: у застосунку доступно на 4 більше, ніж вигадане значення «Shopify» у демо-даних.
  await receiveStock(env.ctx(OWNER), { operationId: newOperationId(), stockItemId, quantity: 4, reason: "purchase" });
});
afterAll(async () => {
  await env.close();
});

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function render(mode: "demo" | "production", locale: Locale, actor = OWNER): Promise<string> {
  const basePath = mode === "production" ? "/app" : "/demo";
  m.ctx = { ...env.ctx(actor), mode, basePath, locale };
  const shell: ShellData = {
    mode,
    basePath,
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
          id: mode === "production" ? "routes/app-layout" : "routes/demo-layout",
          path: basePath.slice(1),
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "warehouse/items/:stockItemId", loader: itemPage.loader, Component: itemPage.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${basePath}/warehouse/items/${stockItemId}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

const links = (html: string, path: string) => html.split(`href="${path}"`).length - 1;

/** Найдовший сталий фрагмент речення про розбіжність (між змінними). */
const differsPrefix = (locale: Locale) => {
  const parts = DICTIONARIES[locale]["warehouse.item.shopifyDiffers"]!.split(/\{[^}]+\}/).map((x) => x.trim());
  const longest = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
  expect(longest.length).toBeGreaterThan(10);
  return esc(longest);
};

describe("item card: Shopify difference by mode", () => {
  it("the receipt made the app and the demo «Shopify» values differ", async () => {
    m.ctx = { ...env.ctx(OWNER), mode: "demo", basePath: "/demo", locale: "uk" };
    const data = (await itemPage.loader({
      request: new Request(`http://localhost/demo/warehouse/items/${stockItemId}`),
      params: { stockItemId },
      context: {},
    } as never)) as { item: { available: number; shopifyAvailable: number | null; tracking: string | null }; isProduction: boolean };
    expect(data.isProduction).toBe(false);
    expect(data.item.tracking).toBe("opened");
    expect(data.item.shopifyAvailable).not.toBeNull();
    expect(data.item.available).not.toBe(data.item.shopifyAvailable);
  });

  for (const locale of ["uk", "en"] as const) {
    it(`demo (${locale}): no «differs» sentence and no link to the reconciliation page, a neutral demo hint instead`, async () => {
      for (const actor of [OWNER, STAFF]) {
        const html = await render("demo", locale, actor);
        expect(html, actor.role).not.toContain(differsPrefix(locale));
        // Посилання на звірку лише у вкладках розділу «Склад», не біля підказки.
        expect(links(html, "/demo/warehouse/shopify"), actor.role).toBe(1);
        expect(html, actor.role).toContain(esc(DICTIONARIES[locale]["warehouse.stock.shopify.demoHint"]!));
      }
    });

    it(`production (${locale}): unchanged — the «differs» sentence with the reconciliation link`, async () => {
      const html = await render("production", locale);
      expect(html).toContain(differsPrefix(locale));
      expect(links(html, "/app/warehouse/shopify")).toBe(2);
      expect(html).not.toContain(esc(DICTIONARIES[locale]["warehouse.stock.shopify.demoHint"]!));
    });
  }
});

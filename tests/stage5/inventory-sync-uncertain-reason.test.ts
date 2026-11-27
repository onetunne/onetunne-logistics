import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { inventoryConflicts, productVariants, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { DICTIONARIES } from "~/i18n";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { initializeInventory } from "~/modules/inventory/opening.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { RequestContext } from "~/server/types";
import { gqlProduct } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";

/**
 * R5B-1: «невизначено» (uncertain) має кілька причин — сторінка «Склад → Shopify» називає справжню: частково виконані
 * замовлення АБО зміни товарів у Shopify, ще не застосовані в застосунку (shopify_lines_pending_at). Спостереження,
 * збережені до появи окремих прапорців, — як раніше (частково виконані). Розбіжності вставлено напряму (вигадані дані).
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

const SHOP = "ot-uncertain.myshopify.com";
let db: DatabaseHandle;
let page: typeof import("~/pages/inventory-sync");
const items: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  await seedReferenceData(db.db, DEMO_SETTINGS);
  await db.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_products,read_inventory,write_inventory" });
  for (let n = 1; n <= 3; n++) await upsertProduct(db.db, mapProduct(gqlProduct(n)), "EUR");
  m.ctx = {
    mode: "production",
    db: db.db,
    actor: OWNER,
    carriers: createDemoCarriers(db.db),
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
    basePath: "/app",
    locale: "uk",
  };
  await initializeInventory(m.ctx);
  for (let n = 1; n <= 3; n++) {
    const [v] = await db.db.select({ id: productVariants.id }).from(productVariants).where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
    items.push(await ensureStockItemForVariant(db.db, v!.id));
  }
  page = await import("~/pages/inventory-sync");
});
afterAll(async () => {
  await db.close();
});

function observation(extra: Record<string, unknown>) {
  return {
    kind: "reconciliation",
    observationSeq: 1,
    observedAt: new Date().toISOString(),
    inventoryItemId: "gid://shopify/InventoryItem/1",
    locationId: "gid://shopify/Location/1",
    appVersion: 1,
    appOnHand: 12,
    appReserved: 2,
    appAvailable: 10,
    shopifyAvailable: 11,
    shopifyOnHand: 12,
    shopifyCommitted: 1,
    diff: 1,
    expectedDiff: 0,
    committedNotReserved: 0,
    reservationExcess: 1,
    shopifyOtherStates: 0,
    inFlight: 0,
    fulfilledOutside: 0,
    failedMovementIds: [],
    failedDelta: 0,
    unsentCount: 0,
    unsentDelta: 0,
    unsentMovementIds: [],
    returnsPending: 0,
    returnsAwaiting: 0,
    ...extra,
  };
}

async function render(): Promise<string> {
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: "layout",
          path: "app",
          Component: Outlet,
          children: [{ id: "page", path: "warehouse/shopify", loader: page.loader, action: page.action, Component: page.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request("http://localhost/app/warehouse/shopify"));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

const uk = (key: string) => DICTIONARIES.uk[key]!;
const en = (key: string) => DICTIONARIES.en[key]!;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const occurrences = (html: string, text: string) => html.split(esc(text)).length - 1;

describe("uncertain discrepancies name their real cause (R5B-1)", () => {
  it("lines pending → «Shopify changed the items» (not «partially fulfilled»); old observation → partially fulfilled", async () => {
    const w = await getDefaultWarehouse(db.db);
    const [pending, legacy, returns] = await db.db
      .insert(inventoryConflicts)
      .values([
        // Зміни позицій Shopify ще не застосовано (є накладна) — частково виконаних замовлень немає.
        { stockItemId: items[0]!, warehouseId: w.id, appOnHand: 12, shopifyOnHand: 12, shopifyAvailable: 11, details: observation({ uncertain: true, partiallyFulfilled: false, linesPending: true }) },
        // Спостереження до появи прапорців: uncertain без повернень — як раніше, «частково виконані».
        { stockItemId: items[1]!, warehouseId: w.id, appOnHand: 12, shopifyOnHand: 12, shopifyAvailable: 11, details: observation({ uncertain: true }) },
        // Лише повернення: окреме пояснення повернень, без «частково виконані» й без «зміни товарів».
        {
          stockItemId: items[2]!,
          warehouseId: w.id,
          appOnHand: 12,
          shopifyOnHand: 12,
          shopifyAvailable: 11,
          details: observation({ uncertain: true, partiallyFulfilled: false, linesPending: false, returnsPending: 1 }),
        },
      ])
      .returning({ id: inventoryConflicts.id });

    const data = await page.loader({ request: new Request("http://localhost/app/warehouse/shopify"), params: {}, context: {} } as never);
    const row = (id: string) => data.conflicts.find((c) => c.id === id)!;
    expect(row(pending!.id)).toMatchObject({ uncertain: true, linesPending: true, partiallyFulfilled: false });
    expect(row(legacy!.id)).toMatchObject({ uncertain: true, linesPending: false, partiallyFulfilled: true });
    expect(row(returns!.id)).toMatchObject({ uncertain: true, linesPending: false, partiallyFulfilled: false });

    const html = await render();
    expect(occurrences(html, uk("inventorySync.why.linesPending"))).toBe(1);
    expect(occurrences(html, uk("inventorySync.why.uncertain"))).toBe(1);
    // Попередження дій «Прийняти Shopify» / «Надіслати склад» називають і неперенесені зміни товарів.
    expect(html).toContain(esc(uk("inventorySync.action.accept.warning")));
    expect(html).toContain(esc(uk("inventorySync.action.pushApp.warning")));
  });

  it("the texts exist in both languages and the warnings mention unapplied Shopify item changes", () => {
    expect(uk("inventorySync.why.linesPending")).toMatch(/Shopify змінив товари/);
    expect(en("inventorySync.why.linesPending")).toMatch(/Shopify changed the items/);
    expect(uk("inventorySync.why.uncertain")).not.toMatch(/змінив товари/);
    for (const key of ["inventorySync.action.accept.warning", "inventorySync.action.pushApp.warning"]) {
      expect(uk(key), key).toMatch(/зміни товарів у Shopify/);
      expect(en(key), key).toMatch(/Shopify item changes/);
    }
  });
});

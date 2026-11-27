/**
 * Демо: вигадана історія продажів (S5-DEMO-REC) — оплачені й доставлені замовлення за 6–85 днів (DEMO_SALES_HISTORY).
 * Аналітика складу в демо показує ризик із датою вичерпання, рекомендації партій (і посилання «Створити партію» з
 * попередньо заповненою формою) та попередній період для тренду. Історія не потрапляє в чергу пакування, не створює
 * резервів і не змінює початкових залишків; стара демо-база отримує її один раз.
 */
import { and, count, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { isValidPhoneNumber } from "libphonenumber-js/max";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ShellData } from "~/components/shell-types";
import {
  auditLog,
  inventoryBalances,
  inventoryMovements,
  orderLineItems,
  orderPacking,
  orders,
  productVariants,
  productionBatches,
  shipments,
  stockReservations,
} from "~/db/schema";
import { DEMO_ORDERS, DEMO_PRODUCTS, DEMO_SALES_HISTORY } from "~/db/seed/demo-data";
import { resetDemoData, seedDemoData, seedDemoSalesHistory } from "~/db/seed/seed.server";
import { SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { getBalances } from "~/modules/inventory/ledger.server";
import { syncAllOpenOrderReservations } from "~/modules/inventory/opening.server";
import { parseQueueFilters } from "~/modules/packing/queue-filters";
import { listPackingQueue } from "~/modules/packing/queue.server";
import { businessDate } from "~/modules/warehouse/dates";
import { addDays } from "~/modules/warehouse-analytics/calc";
import { loadWarehouseAnalytics } from "~/modules/warehouse-analytics/queries.server";
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
let analyticsPage: typeof import("~/pages/warehouse-analytics");
let productionForm: typeof import("~/pages/production-batch");
const HISTORY_NUMBERS = DEMO_SALES_HISTORY.map((o) => o.number);
const SKU_OF = new Map(DEMO_PRODUCTS.flatMap((p) => p.variants.map((v) => [v.key, v.sku] as const)));
const AVAILABLE_OF = new Map(DEMO_PRODUCTS.flatMap((p) => p.variants.map((v) => [v.sku, v.inventoryAvailable] as const)));

beforeAll(async () => {
  env = await createTestEnv();
  analyticsPage = await import("~/pages/warehouse-analytics");
  productionForm = await import("~/pages/production-batch");
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

const historyOrders = () => env.handle.db.select().from(orders).where(inArray(orders.orderNumber, HISTORY_NUMBERS));

async function countWhere(table: typeof inventoryMovements | typeof stockReservations | typeof orders | typeof productionBatches) {
  const [row] = await env.handle.db.select({ c: count() }).from(table);
  return Number(row?.c ?? 0);
}

/** on_hand / reserved / available демо-варіантів за SKU. */
async function variantBalances(): Promise<Record<string, [number, number, number]>> {
  const rows = (await getBalances(env.handle.db, { kind: "product" }, { limit: 500 })).rows;
  return Object.fromEntries(rows.filter((r) => r.sku && AVAILABLE_OF.has(r.sku)).map((r) => [r.sku!, [r.onHand, r.reserved, r.available]]));
}

/** Очікувані початкові залишки: S + відкриті демо-замовлення (усі до знімка), без історії й без відправлених. */
function expectedOpening(): Record<string, [number, number, number]> {
  const reserved = new Map<string, number>();
  for (const o of DEMO_ORDERS) {
    if (o.history === "delivered" || o.history === "cancelled") continue;
    for (const i of o.items) reserved.set(SKU_OF.get(i.variant)!, (reserved.get(SKU_OF.get(i.variant)!) ?? 0) + i.quantity);
  }
  return Object.fromEntries([...AVAILABLE_OF].map(([sku, s]) => [sku, [s + (reserved.get(sku) ?? 0), reserved.get(sku) ?? 0, s]]));
}

async function render(path: string, route: { path: string; loader: unknown; Component: unknown }): Promise<string> {
  const actor = m.ctx?.actor ?? OWNER;
  const shell: ShellData = {
    mode: "demo",
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
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [{ id: "routes/demo-layout", path: "demo", loader: () => shell, Component: Outlet, children: [{ id: "page", ...route }] }],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request(`http://localhost${path}`));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

describe("demo sales history: data", () => {
  it("paid and delivered fictional orders 6–85 days ago, numbered below the scenario orders", async () => {
    const rows = await historyOrders();
    expect(rows).toHaveLength(DEMO_SALES_HISTORY.length);
    expect(DEMO_SALES_HISTORY.length).toBeGreaterThanOrEqual(10);
    expect(DEMO_SALES_HISTORY.length).toBeLessThanOrEqual(20);
    const now = Date.now();
    for (const o of rows) {
      expect(o, o.orderNumber).toMatchObject({ status: "delivered", financialStatus: "paid", source: "demo", cancelledAt: null, priority: 0 });
      const days = (now - o.placedAt.getTime()) / 86_400_000;
      expect(days, o.orderNumber).toBeGreaterThan(5);
      expect(days, o.orderNumber).toBeLessThan(86);
      expect(o.note).toMatch(/^DEMO · /);
      // Номери не перетинаються з наявними сценаріями (#0996–#0998, #1001–#1013) і з імітацією (> #1013).
      expect(Number(o.orderNumber.slice(1)), o.orderNumber).toBeLessThan(996);
    }
    expect(new Set(HISTORY_NUMBERS).size).toBe(HISTORY_NUMBERS.length);
    for (const n of HISTORY_NUMBERS) expect(DEMO_ORDERS.map((o) => o.number)).not.toContain(n);
  });

  it("is clearly fictional: reserved e-mail domains and fictional phone ranges", () => {
    // Кожна країна історії має правило (нова країна без правила — тест падає). GB/US/CA/AU — діапазони для вигаданих
    // номерів; DE/FR/PL (підтвердженого діапазону немає) — заповнювач із нулів, що не є дійсним номером, тобто не може
    // належати абонентові (R6F-2: +49 1512…, +33 6 12…, +48 601… — звичайні мобільні формати).
    const FICTIONAL_PHONE: Record<string, RegExp> = {
      GB: /^\+44 7700 900\d{3}$/,
      US: /^\+1 \d{3} 555 01\d{2}$/,
      CA: /^\+1 \d{3} 555 01\d{2}$/,
      AU: /^\+61 491 570 \d{3}$/,
      DE: /^\+49 000 000000\d$/,
      FR: /^\+33 0 00 00 00 0\d$/,
      PL: /^\+48 000 000 00\d$/,
    };
    const PLACEHOLDER = new Set(["DE", "FR", "PL"]);
    for (const o of DEMO_SALES_HISTORY) {
      expect(o.email, o.number).toMatch(/@example\.(com|org|net)$/);
      const phone = o.shipping.phone ?? "";
      const rule = FICTIONAL_PHONE[o.shipping.countryCode ?? ""];
      expect(rule, `${o.number}: no fictional-phone rule for ${o.shipping.countryCode}`).toBeDefined();
      expect(phone, o.number).toMatch(rule!);
      if (PLACEHOLDER.has(o.shipping.countryCode ?? "")) expect(isValidPhoneNumber(phone), `${o.number}: ${phone}`).toBe(false);
      expect(o.shipping.address1, o.number).toMatch(/Example|Sample|Placeholder|Test|Muster|Exemple|Przykładowa/);
      for (const i of o.items) expect(SKU_OF.has(i.variant), `${o.number}: ${i.variant}`).toBe(true);
    }
  });

  it("not in the packing queue, no waybill, no packing, no reservations; opening balances are unchanged", async () => {
    const ids = (await historyOrders()).map((o) => o.id);
    expect((await env.handle.db.select({ id: shipments.id }).from(shipments).where(inArray(shipments.orderId, ids))).length).toBe(0);
    expect((await env.handle.db.select({ id: orderPacking.orderId }).from(orderPacking).where(inArray(orderPacking.orderId, ids))).length).toBe(0);
    expect((await env.handle.db.select({ id: stockReservations.id }).from(stockReservations).where(inArray(stockReservations.orderId, ids))).length).toBe(0);
    expect(
      (await env.handle.db.select({ id: inventoryMovements.id }).from(inventoryMovements).where(and(isNotNull(inventoryMovements.orderId), inArray(inventoryMovements.orderId, ids))))
        .length,
    ).toBe(0);
    for (const tab of ["queue", "needs_waybill", "awaiting_picking", "packed"]) {
      const q = await listPackingQueue(env.ctx(OWNER), parseQueueFilters(new URLSearchParams(`tab=${tab}`)), { pageSize: 200 });
      expect(q.rows.map((r) => r.orderNumber).filter((n) => HISTORY_NUMBERS.includes(n)), tab).toEqual([]);
    }
    // Початкові залишки — як без історії: доступно = демо-знімок «Shopify», зарезервовано — лише відкриті замовлення.
    expect(await variantBalances()).toEqual(expectedOpening());
  });
});

describe("demo sales history: warehouse analytics in the demo", () => {
  it("shows an at-risk item with a stock-out date, batch recommendations and a previous period for the trend", async () => {
    const today = businessDate(new Date());
    const data = await loadWarehouseAnalytics(env.ctx(STAFF));
    const bySku = (sku: string) => data.variants.find((v) => v.sku === sku)!;
    expect(data.settings).toMatchObject({ productionLeadDays: 30, targetCoverDays: 60, batchRounding: 10 });

    // Сумка Mini чорна: 16 шт. за 30 днів, 30 за 90; доступно 12 → ~22 дні (< 30 днів виробництва) → ризик і партія.
    expect(bySku("OT-BG-BLK")).toMatchObject({
      units30: 16,
      units90: 30,
      available: 12,
      coverDays: 22.5,
      stockOutDate: addDays(today, 22),
      risk: "critical",
      recommendation: expect.objectContaining({ demand: 42, supply: 12, quantity: 30 }),
      trend: expect.objectContaining({ direction: "up", previous: 8 }),
    });
    // Крило Model X: запасу вистачає (~67 днів), але на горизонт 90 днів — ні → 10 шт.; продажі падають.
    expect(bySku("OT-FK-X")).toMatchObject({ units30: 8, units90: 28, risk: "none", recommendation: expect.objectContaining({ quantity: 10 }) });
    expect(bySku("OT-FK-X").trend).toMatchObject({ direction: "down", current: 8, previous: 12 });
    // Тримач білий: закінчиться раніше, ніж нова партія, але 50 шт. уже у виробництві → без рекомендації.
    expect(bySku("OT-PH-WHT")).toMatchObject({ risk: "critical", inProduction: 50, recommendation: expect.objectContaining({ quantity: 0 }) });
    expect(bySku("OT-PH-WHT").stockOutDate).toBe(addDays(today, 23));

    expect(data.atRisk.map((v) => v.sku)).toEqual(["OT-BG-BLK", "OT-PH-WHT"]);
    expect(data.recommendations.map((v) => [v.sku, v.recommendation?.quantity])).toEqual([
      ["OT-BG-BLK", 30],
      ["OT-FK-X", 10],
    ]);
    expect(data.kpi).toMatchObject({ atRisk: 2, recommendations: 2, recommendedUnits: 40 });
    // Попередній період є: тренд — не «нові продажі».
    expect(data.kpi.previousUnits).toBeGreaterThan(0);
    expect(data.kpi.trend.direction).not.toBe("new");
    expect(data.topProducts[0]?.label).toBe("Грипси силіконові");
    expect(data.topColors[0]?.label).toBe("Чорний");
    // Жодних даних покупців.
    const json = JSON.stringify(data);
    for (const s of ["Bloggs", "Mustermann", "Example Road", "example.", "+44", "Springfield"]) expect(json, s).not.toContain(s);
  });

  it("owner: the recommendation row links to a pre-filled new batch (nothing is created)", async () => {
    const [bag] = await env.handle.db.select().from(productVariants).where(eq(productVariants.sku, "OT-BG-BLK"));
    const html = await render("/demo/warehouse/analytics", { path: "warehouse/analytics", loader: analyticsPage.loader, Component: analyticsPage.default });
    const link = `/demo/production/new?product=${bag!.productId}&amp;qty.${bag!.id}=30`;
    expect(html).toContain(`href="${link}"`);
    const batchesBefore = await countWhere(productionBatches);
    const form = (await productionForm.loader({
      request: new Request(`http://localhost${link.replace("&amp;", "&")}`),
      params: { batchId: "new" },
      context: {},
    } as never)) as { mode: string; editor: { selected: string[]; values: Record<string, { qty: number }> } };
    expect(form.mode).toBe("create");
    expect(form.editor.selected).toEqual([bag!.productId]);
    expect(form.editor.values[bag!.id]).toEqual({ qty: 30 });
    expect(await countWhere(productionBatches)).toBe(batchesBefore);
  });
});

describe("demo sales history: idempotent seed and an upgrade of old demo databases", () => {
  it("seeding again adds nothing", async () => {
    const before = [await countWhere(orders), await countWhere(inventoryMovements), await countWhere(stockReservations)];
    expect(await seedDemoSalesHistory(env.ctx(SYSTEM_ACTOR))).toBe(0);
    await seedDemoData(env.ctx(SYSTEM_ACTOR));
    expect([await countWhere(orders), await countWhere(inventoryMovements), await countWhere(stockReservations)]).toEqual(before);
  });

  it("a demo database seeded before the history gets it once, dated from the upgrade, without touching the ledger", async () => {
    const db = env.handle.db;
    const old = (await historyOrders()).map((o) => o.id);
    await db.delete(orderLineItems).where(inArray(orderLineItems.orderId, old));
    await db.delete(orders).where(inArray(orders.id, old));
    const balances = await variantBalances();
    const ledger = [await countWhere(inventoryMovements), await countWhere(stockReservations)];

    const upgradeAt = new Date(Date.now() - 3 * 86_400_000);
    await seedDemoData({ ...env.ctx(SYSTEM_ACTOR), now: () => upgradeAt });
    const rows = await historyOrders();
    expect(rows).toHaveLength(DEMO_SALES_HISTORY.length);
    const newest = rows.find((o) => o.orderNumber === "#0995")!;
    expect(upgradeAt.getTime() - newest.placedAt.getTime()).toBe(DEMO_SALES_HISTORY.find((o) => o.number === "#0995")!.daysAgo * 86_400_000);
    expect(rows.every((o) => o.status === "delivered")).toBe(true);
    const lines = await db.select({ c: count() }).from(orderLineItems).where(inArray(orderLineItems.orderId, rows.map((o) => o.id)));
    expect(Number(lines[0]!.c)).toBe(DEMO_SALES_HISTORY.reduce((s, o) => s + o.items.length, 0));
    // Склад не змінено: ні рухів, ні резервів, баланси ті самі.
    expect([await countWhere(inventoryMovements), await countWhere(stockReservations)]).toEqual(ledger);
    expect(await variantBalances()).toEqual(balances);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "demo.sales_history_seeded"));
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Повторний запуск — без змін.
    await seedDemoData(env.ctx(SYSTEM_ACTOR));
    expect(await historyOrders()).toHaveLength(DEMO_SALES_HISTORY.length);
  });

  it("an old database opened a month before the upgrade: history after the opening snapshot is still never written off", async () => {
    // Стара демо-база: облік відкрито за 30 днів до оновлення, тож новіші замовлення історії (6–29 днів) — ПІСЛЯ знімка.
    // Вони доставлені без накладної й без Shopify: жоден шлях синхронізації резервів їх не бере (відновлення власника
    // пропускає відправлені — NON_RESERVING_STATUSES), тож склад не списується й не змінюється.
    const db = env.handle.db;
    const old = (await historyOrders()).map((o) => o.id);
    await db.delete(orderLineItems).where(inArray(orderLineItems.orderId, old));
    await db.delete(orders).where(inArray(orders.id, old));
    const shift = sql`interval '30 days'`;
    await db.update(inventoryBalances).set({ openingSnapshotAt: sql`${inventoryBalances.openingSnapshotAt} - ${shift}` }).where(isNotNull(inventoryBalances.openingSnapshotAt));
    try {
      const [snap] = await db.select({ at: sql<Date>`max(${inventoryBalances.openingSnapshotAt})` }).from(inventoryBalances);
      const snapshotAt = new Date(snap!.at);
      await seedDemoData(env.ctx(SYSTEM_ACTOR));
      const rows = await historyOrders();
      expect(rows).toHaveLength(DEMO_SALES_HISTORY.length);
      expect(rows.filter((o) => o.placedAt > snapshotAt).length).toBeGreaterThan(0);
      const balances = await variantBalances();
      const ids = rows.map((o) => o.id);

      await syncAllOpenOrderReservations(env.ctx(OWNER));
      const [moved] = await db.select({ c: count() }).from(inventoryMovements).where(inArray(inventoryMovements.orderId, ids));
      const [reserved] = await db.select({ c: count() }).from(stockReservations).where(inArray(stockReservations.orderId, ids));
      expect([Number(moved!.c), Number(reserved!.c)]).toEqual([0, 0]);
      expect(await variantBalances()).toEqual(balances);
    } finally {
      await db.update(inventoryBalances).set({ openingSnapshotAt: sql`${inventoryBalances.openingSnapshotAt} + ${shift}` }).where(isNotNull(inventoryBalances.openingSnapshotAt));
    }
  });

  it("a variant missing in an old demo catalog is skipped; reset restores the full history", async () => {
    const db = env.handle.db;
    const old = (await historyOrders()).map((o) => o.id);
    await db.delete(orderLineItems).where(inArray(orderLineItems.orderId, old));
    await db.delete(orders).where(inArray(orders.id, old));
    await db.update(productVariants).set({ sku: "OT-BG-BLK-RENAMED" }).where(eq(productVariants.sku, "OT-BG-BLK"));
    try {
      expect(await seedDemoSalesHistory(env.ctx(SYSTEM_ACTOR))).toBe(DEMO_SALES_HISTORY.length);
      const ids = (await historyOrders()).map((o) => o.id);
      const lineSkus = (await db.select({ sku: orderLineItems.sku }).from(orderLineItems).where(inArray(orderLineItems.orderId, ids))).map((r) => r.sku);
      expect(lineSkus).not.toContain("OT-BG-BLK");
      expect(lineSkus).not.toContain("OT-BG-BLK-RENAMED");
    } finally {
      await db.update(productVariants).set({ sku: "OT-BG-BLK" }).where(eq(productVariants.sku, "OT-BG-BLK-RENAMED"));
    }
    await resetDemoData(env.ctx(OWNER));
    const rows = await historyOrders();
    expect(rows).toHaveLength(DEMO_SALES_HISTORY.length);
    expect(await variantBalances()).toEqual(expectedOpening());
  });
});

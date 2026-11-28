/**
 * Етап 6, WP4 — регресії другого раунду огляду, інтерфейс (дані сервісів + серверний рендер блоку й списку):
 *  - «0,00» — лише відомий нуль (§2.6, §2.4 «0 (підтверджено)»): комісії zero_confirmed без записів — 0,00 у списку й на
 *    картці; прибуток final із записом без курсу — «без курсу: N», а не «немає даних»;
 *  - «Підтвердити суми замовлення» (§4) — і без «Оцінки» (subtotal 0), поле «Товари» заповнено «Оцінкою»;
 *  - відсутнє — з посиланням на дію (§18.4: «Ввести собівартість», «Імпортувати рахунок», «Вказати номер накладної»);
 *  - рентабельність з прогнозу — з «≈» (F5; §18.4 «рентабельність ≈ 57,3 %») у списку й на картці.
 * Усі ідентифікатори, коди й суми вигадані.
 */
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { orderShopifyFinance, orders } from "~/db/schema";
import { PERMISSIONS } from "~/domain/permissions";
import type { ShellData } from "~/components/shell-types";
import { OrderFinanceCard, canConfirmAmounts, type OrderFinancePanelData } from "~/components/order-finance/finance-card";
import { emptySnapshot } from "~/modules/finance-sync/snapshot";
import { loadOrderFinancePanel } from "~/modules/order-finance/card.server";
import { listOrderFinance } from "~/modules/order-finance/list.server";
import { orderFinanceListParamsOf } from "~/modules/order-finance/list-params";
import FinanceOrdersPage from "~/pages/finance-orders";
import * as G from "../reference/golden";
import type { RefOrderFacts } from "../reference/model";
import { GoldenOrder, openGoldenEnv, prodCtx, type GoldenEnv } from "./golden-helpers";

let env: GoldenEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const G1NR: RefOrderFacts = { ...G.G1_ORDER_NO_RETURN, partner: undefined };
const NBSP = " ";

const shell: ShellData = {
  mode: "demo",
  basePath: "/demo",
  actor: { id: "demo-owner", displayName: "Demo Owner", role: "owner", permissions: [...PERMISSIONS] },
  nav: [],
  automation: { mode: "semi", globalPause: false },
  openProblems: 0,
  demo: null,
};

/** Серверний рендер компонента в мінімальному дереві маршрутів (root → demo-layout → сторінка). */
async function renderRoute(Component: () => unknown, loader: () => unknown = () => null): Promise<string> {
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [{ id: "routes/demo-layout", path: "demo", loader: () => shell, Component: Outlet, children: [{ id: "page", path: "x", loader, Component: Component as never }] }],
    },
  ];
  const handler = createStaticHandler(routes);
  const context = await handler.query(new Request("http://localhost/demo/x"));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

async function renderCard(orderId: string, at: string, currency = "UAH"): Promise<{ html: string; data: OrderFinancePanelData }> {
  const panel = await loadOrderFinancePanel(prodCtx(env!, at), orderId, { currency });
  const data: OrderFinancePanelData = { card: panel.card, canManage: panel.canManage, operationIds: panel.operationIds, partnerOptions: panel.partnerOptions, today: panel.today };
  return { html: await renderRoute(() => h(OrderFinanceCard, { data })), data };
}

async function renderList(at: string, currency = "UAH"): Promise<string> {
  const ctx = prodCtx(env!, at);
  const params = orderFinanceListParamsOf(new URLSearchParams("period=custom&from=2026-10-01&to=2026-12-31"), at.slice(0, 10));
  const list = await listOrderFinance(ctx, { ...params.filter, currency });
  return renderRoute(FinanceOrdersPage as never, () => ({ demo: false, preset: params.preset, range: params.range, filter: params.filter, list, partners: [] }));
}

describe("відомий нуль і «без курсу» (§2.6)", () => {
  it("G8b «Без витрат на доставку», правило «без комісії» → комісії zero_confirmed: список 0,00 (не «—»), картка 0,00", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G.G8B_ORDER_OWNER_MARK).create();
    await o.advance("2026-10-05T12:00:00Z");
    const at = "2026-10-10T00:00:00Z";
    await o.advance(at);
    const f = await o.finance();
    expect(f.componentsParsed.fees).toMatchObject({ state: "zero_confirmed" });
    expect(f.profitState).toBe("final");
    const row = (await listOrderFinance(prodCtx(env, at), { currency: "UAH" })).rows.find((r) => r.orderId === o.orderId)!;
    expect(row.fees).toBe("0.00");
    const { data } = await renderCard(o.orderId, at);
    expect(data.card!.rows.fees.net).toMatchObject({ converted: "0.00", entries: 0 });
  });

  it("final із єдиним рядком рахунку без курсу EUR (послуга 20.12) → profitKind no_rate, «без курсу: 1 запис» замість «немає даних»", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const ref: RefOrderFacts = { ...G1NR, invoiceLines: [{ ...G1NR.invoiceLines[0]!, serviceDate: "2026-12-20", importedAt: "2026-11-10T09:00:00Z" }] };
    const o = await new GoldenOrder(env, ref).create();
    await o.advance("2026-10-05T12:00:00Z");
    const at = G.G1_AS_OF_AFTER_IMPORT;
    await o.advance(at);
    expect((await o.finance()).profitState).toBe("final");
    const row = (await listOrderFinance(prodCtx(env, at), { currency: "EUR" })).rows.find((r) => r.orderId === o.orderId)!;
    expect(row).toMatchObject({ profit: null, profitKind: "no_rate", unconverted: 1, unconvertedColumns: ["shipping"] });
    const html = await renderList(at, "EUR");
    expect(html).toContain("без курсу: 1 запис");
    expect(html).not.toContain("немає даних</span>");
  });
});

describe("«Підтвердити суми замовлення» (§4): і без «Оцінки»", () => {
  const noSales: RefOrderFacts = { ...G1NR, id: "ord-no-sales", sales: [] };
  const setup = async (subtotal: string) => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, noSales).create();
    const snap = emptySnapshot();
    snap.status = { sales: "not_read", transactions: "complete", fees: "complete", refunds: "complete" };
    await env.db.update(orderShopifyFinance).set({ snapshot: snap as unknown as Record<string, unknown> }).where(eq(orderShopifyFinance.orderId, o.orderId));
    await env.db.update(orders).set({ subtotal, total: "129.00" }).where(eq(orders.id, o.orderId));
    await o.advance("2026-10-05T12:00:00Z");
    return o;
  };
  it("subtotal 0 при total ≠ 0 (оцінки немає), виручка «немає даних» → форму показано (раніше — ні), поле порожнє", async () => {
    const o = await setup("0.00");
    const { html, data } = await renderCard(o.orderId, "2026-10-06T00:00:00Z");
    expect(data.card!.estimate).toBeNull();
    expect(data.card!.components.find((c) => c.component === "revenue")).toMatchObject({ state: "missing" });
    expect(canConfirmAmounts(data.card!)).toBe(true);
    expect(html).toContain("Підтвердити суми замовлення");
    expect(html).toContain('value="finance.confirmAmounts"');
  });
  it("є «Оцінка» 117,00 → поле «Товари» заповнено оцінкою (редаговане)", async () => {
    const o = await setup("117.00");
    const { html, data } = await renderCard(o.orderId, "2026-10-06T00:00:00Z");
    expect(data.card!.estimate?.original).toEqual([{ amount: "117.00", currency: "EUR" }]);
    expect(html).toMatch(/name="products"[^>]*value="117.00"|value="117.00"[^>]*name="products"/);
  });
  it("виручка фактична (угоди Shopify) → форми немає", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G1NR).create();
    await o.advance("2026-10-05T12:00:00Z");
    const { html, data } = await renderCard(o.orderId, "2026-10-06T00:00:00Z");
    expect(canConfirmAmounts(data.card!)).toBe(false);
    expect(html).not.toContain('value="finance.confirmAmounts"');
  });
});

describe("відсутнє — з посиланням на дію (§18.4)", () => {
  it("G8: собівартість no_cost → «Ввести собівартість» (finance/costs); комісії no_fee_data → правила комісій; і в «Неможливо розрахувати»", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G.G8_ORDER).create();
    await o.advance("2026-10-05T12:00:00Z");
    const at = "2026-10-10T00:00:00Z";
    await o.advance(at);
    expect((await o.finance()).profitState).toBe("incomplete");
    const { html } = await renderCard(o.orderId, at);
    expect(html).toContain('href="/demo/finance/costs"');
    expect(html).toContain("Ввести собівартість");
    expect(html).toContain('href="/demo/finance/expenses"');
    expect(html.match(/Ввести собівартість/g)?.length).toBeGreaterThanOrEqual(2);
  });
  it("без накладної й прогнозу → «Вказати номер накладної» (якір форми); накладна без прогнозу й рахунку → «Імпортувати рахунок»", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const a = await new GoldenOrder(env, { ...G.G8B_ORDER_NOTHING, id: "ord-nowb", packagingAccountedInBulk: false }).create();
    await a.advance("2026-10-05T12:00:00Z");
    expect((await a.finance()).componentsParsed.shipping_cost).toMatchObject({ state: "missing", reason: "no_waybill", hasForecast: false });
    const ra = await renderCard(a.orderId, "2026-10-06T00:00:00Z");
    expect(ra.html).toContain('href="#order-finance-external-waybill"');
    expect(ra.html).toContain('id="order-finance-external-waybill"');
    expect(ra.html).toContain("Вказати номер накладної");
    const b = await new GoldenOrder(env, { ...G1NR, id: "ord-noinv", waybills: [{ ...G1NR.waybills[0]!, frozenForecast: { basis: "none", amount: null, currency: "UAH" } }], invoiceLines: [] }).create();
    await b.advance("2026-10-05T12:00:00Z");
    expect((await b.finance()).componentsParsed.shipping_cost).toMatchObject({ state: "missing", reason: "no_invoice" });
    const rb = await renderCard(b.orderId, "2026-10-06T00:00:00Z");
    expect(rb.html).toContain('href="/demo/finance/shipping/import"');
    expect(rb.html).toContain("Імпортувати рахунок");
  });
});

describe("рентабельність з прогнозу — з «≈» (F5)", () => {
  it("G1 08.11 (preliminary): список «≈ 57,3 %», картка «рентабельність ≈ 57,3 %»; final — без «≈»", async () => {
    env = await openGoldenEnv(G.G1_RATES);
    const o = await new GoldenOrder(env, G1NR).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance(G.G1_AS_OF_BEFORE_IMPORT);
    const row = (await listOrderFinance(prodCtx(env, G.G1_AS_OF_BEFORE_IMPORT), { currency: "UAH" })).rows.find((r) => r.orderId === o.orderId)!;
    expect(row).toMatchObject({ profitKind: "forecast" });
    const pct = `${row.margin!.replace(".", ",")}${NBSP}%`;
    const list = await renderList(G.G1_AS_OF_BEFORE_IMPORT);
    expect(list).toContain(`≈ ${pct}`);
    const { html } = await renderCard(o.orderId, G.G1_AS_OF_BEFORE_IMPORT);
    expect(html).toContain(`рентабельність ≈ ${pct}`);
    await o.advance(G.G1_AS_OF_AFTER_IMPORT);
    const after = (await listOrderFinance(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT), { currency: "UAH" })).rows.find((r) => r.orderId === o.orderId)!;
    expect(after.profitKind).toBe("fact");
    const finalHtml = await renderList(G.G1_AS_OF_AFTER_IMPORT);
    expect(finalHtml).not.toContain(`≈ ${after.margin!.replace(".", ",")}${NBSP}%`);
    expect(finalHtml).toContain(`${after.margin!.replace(".", ",")}${NBSP}%`);
  });
});

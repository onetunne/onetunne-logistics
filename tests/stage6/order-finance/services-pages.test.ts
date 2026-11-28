/**
 * Етап 6, WP4: сервіси власника й сторінка «Фінанси → Замовлення» (§14.2, §18.2, §18.4).
 * - доступ: працівник і підроблений актор (дозволи фінансів у наборі, роль staff) — ForbiddenError у кожному сервісі
 *   читання й керування, 403 на loader і action сторінки; нічого не записано;
 * - внутрішня синхронізація з дії працівника (передача перевізнику) — працює (F8: внутрішні функції актора не
 *   перевіряють), записи журналу з posted_by працівника;
 * - позначки власника (CAS за версією, взаємовиключність, причина), підтверджені суми (проведення + сторно), ручний
 *   chargeback (ідемпотентність за operationId), зовнішня накладна;
 * - тестові замовлення й «Враховувати тестові замовлення» (сторно / повторне проведення новим поколінням ключа);
 * - список: фільтри, пошук, сортування, валюта показу, порожня база — «Немає даних» (uk/en, без сирих ключів).
 * Усі дані вигадані.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { financeEntries, orderDisputes, orderFinance, orderShopifyFinance, orders, shipments } from "~/db/schema";
import { ForbiddenError, makeActor, type Actor } from "~/domain/permissions";
import { emptySnapshot } from "~/modules/finance-sync/snapshot";
import { loadFinanceSettings, saveFinanceSettings } from "~/modules/finance/core/settings.server";
import {
  addOrderExternalWaybill,
  clearConfirmedAmounts,
  confirmOrderAmounts,
  recalculateOrderFinance,
  resyncTestOrders,
  saveOrderChargeback,
  setOrderFinanceFlag,
} from "~/modules/order-finance/actions.server";
import { loadOrderFinanceCard, loadOrderFinancePanel } from "~/modules/order-finance/card.server";
import { listOrderFinance } from "~/modules/order-finance/list.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import type { RequestContext } from "~/server/types";
import * as G from "../reference/golden";
import { OWNER, STAFF } from "../../helpers";
import { renderPage } from "../../pages/insights-render";
import { GoldenOrder, openGoldenEnv, prodCtx, type GoldenEnv } from "./golden-helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

/** Підроблений актор: дозволи фінансів прямо в наборі, роль staff — перевіряється саме роль. */
const FORGED: Actor = { ...STAFF, id: "forged", permissions: new Set([...STAFF.permissions, "finance.view", "finance.manage"]) };
const NOW = "2026-11-30T12:00:00Z";

let env: GoldenEnv;
let page: typeof import("~/pages/finance-orders");
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;| | /g, " ")
    .replace(/\s+/g, " ");
const route = () => ({ path: "finance/orders", loader: page.loader, action: page.action, Component: page.default });
function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...prodCtx(env, NOW, actor), basePath: "/demo", locale };
}
const load = (query = "") => page.loader({ request: new Request(`http://localhost/demo/finance/orders${query}`), params: {}, context: {} } as never);
const act = (fields: Record<string, string>) =>
  page.action({ request: new Request("http://localhost/demo/finance/orders", { method: "POST", body: new URLSearchParams(fields) }), params: {}, context: {} } as never);

beforeAll(async () => {
  env = await openGoldenEnv(G.G1_RATES);
  page = await import("~/pages/finance-orders");
});
afterAll(async () => {
  await env?.close();
});

describe("empty finance database — «Немає даних», ніде не вигаданий 0", () => {
  it("the list is empty; uk/en render the empty state without raw keys", async () => {
    setContext(OWNER);
    const data = await load();
    expect(data.list.rows).toEqual([]);
    expect(data.list.total).toBe(0);
    const html = text(await renderPage(route() as never, "/demo/finance/orders", OWNER));
    expect(html).toContain("Немає даних");
    expect(html).not.toMatch(/financeOrders\./);
    const en = text(await renderPage(route() as never, "/demo/finance/orders", OWNER, "en"));
    expect(en).toContain("No data");
    expect(en).not.toMatch(/financeOrders\./);
    expect(en).not.toMatch(/[А-Яа-яІіЇїЄєҐґ]{3,}/);
  });
});

describe("access (§14.2): staff and a forged staff actor", () => {
  it("page loader and action → 403 without redirect", async () => {
    for (const actor of [STAFF, FORGED]) {
      setContext(actor);
      await expect(load()).rejects.toMatchObject({ status: 403 });
      await expect(act({ intent: "anything" })).rejects.toMatchObject({ status: 403 });
    }
  });

  it("every read and manage service throws ForbiddenError and writes nothing", async () => {
    const o = await new GoldenOrder(env, G.G2_ORDER).create();
    const before = await env.db.select().from(orderFinance).where(eq(orderFinance.orderId, o.orderId));
    for (const actor of [STAFF, FORGED]) {
      const ctx = prodCtx(env, NOW, actor);
      const calls: Array<() => Promise<unknown>> = [
        () => listOrderFinance(ctx, {}),
        () => loadOrderFinanceCard(ctx, o.orderId),
        () => loadOrderFinancePanel(ctx, o.orderId),
        () => setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "recipient_pays", active: true, reason: "x" }),
        () => confirmOrderAmounts(ctx, { orderId: o.orderId, products: "1.00", shipping: "0.00", reason: "x" }),
        () => clearConfirmedAmounts(ctx, { orderId: o.orderId, reason: "x" }),
        () =>
          saveOrderChargeback(ctx, {
            orderId: o.orderId,
            operationId: randomUUID(),
            amount: "1.00",
            recovered: null,
            currency: "EUR",
            fee: null,
            feeCurrency: null,
            outcome: null,
            decidedOn: null,
            vatReducible: false,
            fullPartnerCancellation: false,
          }),
        () => addOrderExternalWaybill(ctx, { orderId: o.orderId, number: "20450000001234" }),
        () => recalculateOrderFinance(ctx, o.orderId),
        () => resyncTestOrders(ctx),
      ];
      for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await env.db.select().from(orderFinance).where(eq(orderFinance.orderId, o.orderId))).toEqual(before);
    expect(await env.db.select().from(orderDisputes).where(eq(orderDisputes.orderId, o.orderId))).toEqual([]);
  });
});

describe("internal sync from a staff action (F8: internal functions never check the actor)", () => {
  it("manual handover by staff → the order is recognized and its entries are posted (posted_by = staff id)", async () => {
    const o = await new GoldenOrder(env, { ...G.G2_ORDER, id: "ord-staff-handover", handedOverAt: undefined }).create();
    await o.advance("2026-10-05T08:00:00Z");
    expect((await o.finance()).state).toBe("open");
    await env.db.update(orders).set({ status: "waybill_created" }).where(eq(orders.id, o.orderId));
    const [s] = await env.db.select({ id: shipments.id }).from(shipments).where(eq(shipments.orderId, o.orderId));
    const staff = makeActor({ id: "staff-handover", displayName: "Staff", role: "staff", overrides: { grant: ["waybills.manage"] } });
    expect(staff.permissions.has("finance.view")).toBe(false);
    await markHandedOver(prodCtx(env, "2026-10-05T12:00:00Z", staff), s!.id);
    const f = await o.finance();
    expect(f.state).toBe("recognized");
    expect(f.recognitionBasis).toBe("handover");
    const es = await env.db.select().from(financeEntries).where(and(eq(financeEntries.orderId, o.orderId), eq(financeEntries.category, "sales_product")));
    expect(es.map((e) => [e.amount, e.postedBy])).toEqual([["50.00", "staff-handover"]]);
  });
});

describe("owner marks (позначки) — CAS, mutual exclusion, reason, sync", () => {
  it("«Без витрат на доставку» turns an incomplete order final; «Платить отримувач» is exclusive; unset → incomplete again", async () => {
    const o = await new GoldenOrder(env, { ...G.G8B_ORDER_NOTHING, id: "ord-flags" }).create();
    await o.advance("2026-10-05T12:00:00Z");
    await o.advance("2026-10-10T00:00:00Z");
    expect((await o.finance()).profitState).toBe("incomplete");
    const ctx = prodCtx(env, NOW);
    await expect(setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "no_shipping_cost", active: true, reason: "  " })).rejects.toMatchObject({ code: "financeOrders.error.reasonRequired" });
    const v0 = (await o.finance()).version;
    await expect(setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "no_shipping_cost", active: true, reason: "Самовивіз", expectedVersion: v0 + 7 })).rejects.toMatchObject({ code: "error.conflict" });
    const r1 = await setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "no_shipping_cost", active: true, reason: "Самовивіз", expectedVersion: v0 });
    expect(r1.changed).toBe(true);
    let f = await o.finance();
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "not_applicable", reason: "no_shipping_cost" });
    expect(f.profitState).toBe("final");
    // Повтор — без змін.
    expect((await setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "no_shipping_cost", active: true, reason: "Самовивіз" })).changed).toBe(false);
    // «Платить отримувач» знімає «Без витрат на доставку» (взаємовиключні).
    await setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "recipient_pays", active: true, reason: "Отримувач платить" });
    f = await o.finance();
    expect(f.overrides).toHaveProperty("recipient_pays");
    expect(f.overrides).not.toHaveProperty("no_shipping_cost");
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "not_applicable", reason: "recipient_pays" });
    await setOrderFinanceFlag(ctx, { orderId: o.orderId, flag: "recipient_pays", active: false, reason: "Помилка" });
    expect((await o.finance()).profitState).toBe("incomplete");
    const card = (await loadOrderFinanceCard(ctx, o.orderId))!;
    expect(card.history.filter((h) => h.entityType === "order_component_override").length).toBeGreaterThanOrEqual(3);
  });
});

describe("owner-confirmed amounts (no Shopify sales)", () => {
  it("confirm → owner_confirmation entries of the revenue; clear → reversed; negative amount refused", async () => {
    const o = await new GoldenOrder(env, { ...G.G1B_ORDER, id: "ord-confirm", sales: [] }).create();
    const snap = emptySnapshot();
    await env.db.update(orderShopifyFinance).set({ snapshot: snap as unknown as Record<string, unknown> }).where(eq(orderShopifyFinance.orderId, o.orderId));
    await o.advance("2026-10-05T12:00:00Z");
    expect((await o.finance()).componentsParsed.revenue?.state).toBe("missing");
    const ctx = prodCtx(env, "2026-10-10T10:00:00Z");
    await expect(confirmOrderAmounts(ctx, { orderId: o.orderId, products: "-1", shipping: "0", reason: "Старе замовлення" })).rejects.toMatchObject({ code: "financeOrders.error.amountNegative" });
    await confirmOrderAmounts(ctx, { orderId: o.orderId, products: "100,00", shipping: "5", reason: "Старе замовлення" });
    const active = () =>
      env.db
        .select()
        .from(financeEntries)
        .where(and(eq(financeEntries.orderId, o.orderId), eq(financeEntries.sourceType, "owner_confirmation"), isNull(financeEntries.reversesEntryId)));
    const posted = await active();
    expect(posted.map((e) => [e.category, e.amount, e.currency.trim()]).sort()).toEqual([
      ["sales_product", "100.00", "EUR"],
      ["sales_shipping", "5.00", "EUR"],
    ]);
    expect((await o.finance()).componentsParsed.revenue?.state).toBe("actual");
    expect((await clearConfirmedAmounts(ctx, { orderId: o.orderId, reason: "Отримано продажі" })).changed).toBe(true);
    const reversals = await env.db.select().from(financeEntries).where(and(eq(financeEntries.orderId, o.orderId), eq(financeEntries.sourceType, "owner_confirmation")));
    expect(reversals.filter((e) => e.reversesEntryId !== null)).toHaveLength(2);
    expect((await o.finance()).componentsParsed.revenue?.state).toBe("missing");
  });
});

describe("manual chargeback and external waybill", () => {
  it("a manual dispute is idempotent by operationId; a recovered amount above the dispute is refused", async () => {
    const o = await new GoldenOrder(env, { ...G.G1_ORDER_NO_RETURN, id: "ord-manual-cb" }).create();
    await o.advance("2026-10-05T12:00:00Z");
    const ctx = prodCtx(env, "2026-11-12T12:00:00Z");
    const base = {
      orderId: o.orderId,
      amount: "129.00",
      recovered: null,
      currency: "EUR",
      fee: "15.00",
      feeCurrency: "EUR",
      outcome: "lost",
      decidedOn: "2026-11-12",
      vatReducible: false,
      fullPartnerCancellation: false,
    };
    await expect(saveOrderChargeback(ctx, { ...base, operationId: randomUUID(), recovered: "200.00" })).rejects.toMatchObject({ code: "financeOrders.error.recoveredTooLarge" });
    const op = randomUUID();
    const a = await saveOrderChargeback(ctx, { ...base, operationId: op });
    const b = await saveOrderChargeback(ctx, { ...base, operationId: op });
    expect(a.created).toBe(true);
    expect(b.disputeId).toBe(a.disputeId);
    expect(await env.db.select().from(orderDisputes).where(eq(orderDisputes.orderId, o.orderId))).toHaveLength(1);
    const cb = await env.db.select().from(financeEntries).where(and(eq(financeEntries.orderId, o.orderId), eq(financeEntries.category, "chargeback_loss")));
    expect(cb.map((e) => [e.amount, e.recognizedOn])).toEqual([["-129.00", "2026-11-12"]]);
  });

  it("an external waybill: empty / invalid refused, a valid number recorded once", async () => {
    const o = await new GoldenOrder(env, { ...G.G8B_ORDER_TABLE, id: "ord-ext-wb" }).create();
    const ctx = prodCtx(env, NOW);
    await expect(addOrderExternalWaybill(ctx, { orderId: o.orderId, number: " " })).rejects.toMatchObject({ code: "financeOrders.error.waybillRequired" });
    await expect(addOrderExternalWaybill(ctx, { orderId: o.orderId, number: "2.0451E+13" })).rejects.toMatchObject({ code: "financeOrders.error.waybillInvalid" });
    expect(await addOrderExternalWaybill(ctx, { orderId: o.orderId, number: "20450000007777" })).toMatchObject({ inserted: 1 });
    expect(await addOrderExternalWaybill(ctx, { orderId: o.orderId, number: "20450000007777" })).toMatchObject({ inserted: 0 });
  });
});

describe("test orders and «Враховувати тестові замовлення» (§2.5)", () => {
  it("excluded by default (no revenue / COGS / fee entries); on + resync → recognized with entries; off + resync → reversed, excluded", async () => {
    const o = await new GoldenOrder(env, { ...G.G2_ORDER, id: "ord-test", test: true }).create();
    await o.advance("2026-10-05T12:00:00Z");
    // Виручка, собівартість і комісії тестового замовлення — лише з includeTestOrders (вихід зі складу без нього —
    // inventory_loss test_order; використана упаковка — витрата з order_id датою події, як у WP2).
    const pnl = async () => (await o.entries()).filter((e) => ["sales_product", "sales_shipping", "cogs", "payment_fees", "partner_commission"].includes(e.category));
    expect((await o.finance()).state).toBe("excluded");
    expect(await pnl()).toEqual([]);
    const ctx = prodCtx(env, "2026-10-10T10:00:00Z");
    const s = await loadFinanceSettings(env.db);
    await saveFinanceSettings(ctx, { includeTestOrders: true }, { reason: "test" });
    expect((await resyncTestOrders(ctx)).orders).toBeGreaterThanOrEqual(1);
    expect((await o.finance()).state).toBe("recognized");
    expect((await pnl()).map((e) => e.category).sort()).toEqual(expect.arrayContaining(["sales_product", "sales_shipping"]));
    const card = (await loadOrderFinanceCard(ctx, o.orderId))!;
    expect(card.testOrder).toBe(true);
    expect(card.includesTestOrders).toBe(true);
    await saveFinanceSettings(ctx, { includeTestOrders: s.includeTestOrders }, { reason: "test" });
    await resyncTestOrders(ctx);
    expect((await o.finance()).state).toBe("excluded");
    expect(await pnl()).toEqual([]);
  });
});

describe("list «Фінанси → Замовлення» — filters, search, sort, currency", () => {
  let final: GoldenOrder;
  let incomplete: GoldenOrder;
  beforeAll(async () => {
    final = await new GoldenOrder(env, { ...G.G1_ORDER, id: "ord-list-final" }, { partnerCode: "LISTP1" }).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z", NOW]) await final.advance(t);
    incomplete = await new GoldenOrder(env, { ...G.G8_ORDER, id: "ord-list-incomplete" }).create();
    for (const t of ["2026-10-05T12:00:00Z", "2026-10-10T00:00:00Z"]) await incomplete.advance(t);
  });

  it("final: «Факт» = картка; incomplete: прибуток null («немає даних»); state, country, search, period filters", async () => {
    const ctx = prodCtx(env, NOW);
    const all = await listOrderFinance(ctx, { from: "2026-10-01", to: "2026-10-31" });
    const f = all.rows.find((r) => r.orderId === final.orderId)!;
    const i = all.rows.find((r) => r.orderId === incomplete.orderId)!;
    expect(f).toMatchObject({ state: "recognized", profitState: "final", profitKind: "fact", profit: G.ORDER_EXPECTED.G1.allTime.profitFact, margin: G.ORDER_EXPECTED.G1.allTime.orderMargin, country: "DE" });
    expect(i).toMatchObject({ profitState: "incomplete", profit: null, profitKind: "hidden" });
    expect((await listOrderFinance(ctx, { state: "final" })).rows.map((r) => r.orderId)).toContain(final.orderId);
    expect((await listOrderFinance(ctx, { state: "final" })).rows.map((r) => r.orderId)).not.toContain(incomplete.orderId);
    expect((await listOrderFinance(ctx, { state: "incomplete" })).rows.map((r) => r.orderId)).toContain(incomplete.orderId);
    expect((await listOrderFinance(ctx, { country: "PL" })).rows.map((r) => r.orderId)).toEqual([incomplete.orderId]);
    const number = (await env.db.select({ n: orders.orderNumber }).from(orders).where(eq(orders.id, final.orderId)))[0]!.n;
    expect((await listOrderFinance(ctx, { q: number })).rows.map((r) => r.orderId)).toEqual([final.orderId]);
    expect((await listOrderFinance(ctx, { from: "2026-12-01", to: "2026-12-31" })).rows).toEqual([]);
  });

  it("EUR display: each entry at its own rate (47,76); lossOnly excludes profitable orders; sort by profit", async () => {
    const ctx = prodCtx(env, NOW);
    const eur = await listOrderFinance(ctx, { currency: "EUR", from: "2026-10-01", to: "2026-10-31" });
    expect(eur.currency).toBe("EUR");
    expect(eur.rows.find((r) => r.orderId === final.orderId)).toMatchObject({ profit: G.ORDER_EXPECTED.G1.eur.allTime });
    expect((await listOrderFinance(ctx, { lossOnly: true })).rows.map((r) => r.orderId)).not.toContain(final.orderId);
    const sorted = (await listOrderFinance(ctx, { sort: "profit_desc" })).rows.filter((r) => r.profit !== null).map((r) => Number(r.profit));
    expect([...sorted].sort((a, b) => b - a)).toEqual(sorted);
  });

  it("the page: loader parses the query (unknown values → defaults); render shows the rows and «≈»/«—» never a fabricated 0", async () => {
    setContext(OWNER);
    const data = await load("?period=custom&from=2026-10-01&to=2026-10-31&state=bogus&sort=nope&country=pl&page=abc&currency=EUR");
    expect(data.filter).toMatchObject({ state: null, sort: "recognized_desc", country: "PL", page: 1, currency: "EUR" });
    expect(data.list.rows.map((r) => r.orderId)).toEqual([incomplete.orderId]);
    const html = text(await renderPage(route() as never, "/demo/finance/orders?period=custom&from=2026-10-01&to=2026-10-31", OWNER));
    expect(html).toContain("Неповні дані");
    expect(html).toContain("немає даних");
    expect(html).not.toMatch(/financeOrders\./);
    setContext(OWNER);
    await expect(act({ intent: "x" })).resolves.toEqual({ ok: false, error: "error.generic" });
  });
});

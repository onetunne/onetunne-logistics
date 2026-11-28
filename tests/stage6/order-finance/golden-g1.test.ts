/**
 * Етап 6, WP4: золотий випадок G1 (§20.1) — застосунок проти НЕЗАЛЕЖНОЇ еталонної моделі (tests/stage6/reference).
 * Факти додаються в моменти, коли стали відомі (оформлення → передача → повернення → рахунок перевізника); після
 * кожного кроку syncOrderFinance. Порівняння: діючі записи журналу (категорія, сума, валюта, recognized_on, fx_on),
 * стан замовлення, прогнози, що рахуються, картка в UAH і EUR (числа §20.1: 2 325,71 · 57,3 %; 47,76 · 56,9 %), I4 і I3.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { count, eq } from "drizzle-orm";
import { financeEntries } from "~/db/schema";
import { PROFIT_CATEGORIES } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { fromMinor, toMinor } from "~/lib/decimal";
import { loadOrderFinanceCard } from "~/modules/order-finance/card.server";
import { syncOrderFinanceAt } from "~/modules/order-finance/sync.server";
import * as G from "../reference/golden";
import { activeEntries, postOrder } from "../reference/model";
import { GoldenOrder, openGoldenEnv, prodCtx, tuples, type GoldenEnv } from "./golden-helpers";

const E1 = G.ORDER_EXPECTED.G1;
const STEPS = ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z"] as const;

let env: GoldenEnv;
let o: GoldenOrder;
let cardBefore: Awaited<ReturnType<typeof loadOrderFinanceCard>>;

const eurOf = (a: { original: Array<{ amount: string; currency: string }> }) => a.original.find((x) => x.currency === "EUR")?.amount ?? null;
const uahOf = (a: { original: Array<{ amount: string; currency: string }> }) => a.original.find((x) => x.currency === "UAH")?.amount ?? null;

beforeAll(async () => {
  env = await openGoldenEnv(G.G1_RATES);
  o = await new GoldenOrder(env, G.G1_ORDER, { partnerCode: "GOLD10" }).create();
  for (const t of STEPS) await o.advance(t);
  await o.advance(G.G1_AS_OF_BEFORE_IMPORT);
  cardBefore = await loadOrderFinanceCard(prodCtx(env, G.G1_AS_OF_BEFORE_IMPORT), o.orderId, { currency: "UAH" });
});

afterAll(async () => {
  await env?.close();
});

describe("G1 — до імпорту рахунку перевізника (стан на 08.11)", () => {
  it("діючі записи = модель postOrder (категорія, сума, валюта, recognized_on, fx_on)", async () => {
    const model = postOrder(G.G1_ORDER, G.G1_AS_OF_BEFORE_IMPORT);
    expect(tuples(await o.entries())).toEqual(tuples(activeEntries(model.entries)));
  });

  it("визнано 05.10; стан preliminary; доставка — прогноз carrier_reported −520,00 UAH", async () => {
    const f = await o.finance();
    expect(f.state).toBe("recognized");
    expect(f.recognizedOn).toBe("2026-10-05");
    expect(f.profitState).toBe("preliminary");
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "forecast", basis: "carrier_reported" });
    const fc = await o.forecasts();
    expect(fc.filter((x) => x.component === "shipping_cost").map((x) => [x.amount, x.currency])).toEqual([["-520.00", "UAH"]]);
  });

  it("картка UAH: рядки нетто + складники, «≈ Прогноз 2 325,71 · 57,3 %», оплачено 129,00 / 45,00 / 84,00", () => {
    const c = cardBefore!;
    const x = E1.card;
    expect(c.profitState).toBe(x.state);
    expect(eurOf(c.rows.products.net)).toBe(x.productsNet);
    expect(eurOf(c.rows.products.sold)).toBe(x.productsSold);
    expect(eurOf(c.rows.products.returned)).toBe(x.productsReturned);
    expect(eurOf(c.rows.products.beforeDiscounts)).toBe(x.beforeDiscounts);
    expect(eurOf(c.rows.products.discounts)).toBe(x.discounts);
    expect(eurOf(c.rows.shippingPaid)).toBe(x.shippingPaid);
    expect(uahOf(c.rows.cogs.net)).toBe(x.cogsNet);
    expect(uahOf(c.rows.cogs.writtenOff)).toBe(x.cogsWrittenOff);
    expect(uahOf(c.rows.cogs.returns)).toBe(x.cogsReturns);
    expect(uahOf(c.rows.packaging)).toBe(x.packaging);
    // Фактичної доставки ще немає — «—», не 0 (F4); прогноз — окремо.
    expect(c.rows.shippingActual.entries).toBe(0);
    expect(c.rows.shippingActual.converted).toBeNull();
    const ship = c.components.find((k) => k.component === "shipping_cost")!;
    expect(ship.state).toBe("forecast");
    expect(ship.forecast?.original).toEqual([{ amount: x.shippingForecast, currency: "UAH" }]);
    expect(eurOf(c.rows.fees.net)).toBe(x.fees);
    expect(eurOf(c.rows.partner.net)).toBe(x.partnerNet);
    expect(eurOf(c.rows.partner.accrued)).toBe(x.partnerAccrued);
    expect(eurOf(c.rows.partner.adjustments)).toBe(x.partnerAdjustments);
    expect(c.profit).toMatchObject({ kind: "forecast", value: x.profitForecast, margin: x.margin });
    expect(c.paid).toMatchObject({ currency: "EUR", ...x.paid });
  });

  it("I4: «≈ Прогноз» картки = Σ записів (кожен за курсом свого fx_on) + Σ прогнозів, що рахуються", () => {
    const c = cardBefore!;
    const entries = c.entries.filter((e) => !e.reversal && !e.reversed && (PROFIT_CATEGORIES as readonly string[]).includes(e.category));
    const fc = c.components.filter((k) => k.forecast && k.forecast.entries > 0).map((k) => k.forecast!.converted!);
    const total = [...entries.map((e) => e.converted!), ...fc].reduce((a, v) => a + toMinor(v), 0n);
    expect(fromMinor(total)).toBe(c.profit.value);
  });
});

describe("G1 — після імпорту рахунку (стан на 30.11)", () => {
  beforeAll(async () => {
    await o.advance(G.G1_AS_OF_AFTER_IMPORT);
  });

  it("записи = модель; доставка −540,00 датою 05.10 як пізнє завершення; final", async () => {
    const model = postOrder(G.G1_ORDER, G.G1_AS_OF_AFTER_IMPORT);
    const app = await o.entries();
    expect(tuples(app)).toEqual(tuples(activeEntries(model.entries)));
    const ship = app.filter((e) => e.category === "shipping_cost");
    expect(ship).toHaveLength(1);
    expect(ship[0]).toMatchObject({ amount: "-540.00", recognizedOn: "2026-10-05", fxOn: "2026-10-05", isLateCompletion: true, isLate: false });
    const f = await o.finance();
    expect(f.profitState).toBe(E1.octoberAfterImport.state);
    expect(await o.forecasts()).toEqual([]);
  });

  it("картка UAH: «Факт» 2 305,71; EUR: кожен запис за своїм курсом — 47,76 · 56,9 %", async () => {
    const uah = (await loadOrderFinanceCard(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT), o.orderId, { currency: "UAH" }))!;
    expect(uah.profit).toMatchObject({ kind: "fact", value: E1.allTime.profitFact, margin: E1.allTime.orderMargin });
    expect(uah.rows.netRevenue.converted).toBe(E1.allTime.netRevenue);
    const eur = (await loadOrderFinanceCard(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT), o.orderId, { currency: "EUR" }))!;
    expect(eur.currency).toBe("EUR");
    expect(eur.profit).toMatchObject({ kind: "fact", value: E1.eur.allTime, margin: E1.eur.margin });
    expect(eur.rows.shippingActual.converted).toBe(E1.eur.shipping);
    expect(eur.rows.packaging.converted).toBe(E1.eur.packaging);
  });

  it("I3: повторна синхронізація не додає й не сторнує записів", async () => {
    const before = await env.db.select({ n: count() }).from(financeEntries).where(eq(financeEntries.orderId, o.orderId));
    await env.db.transaction((tx) => syncOrderFinanceAt(tx, SYSTEM_ACTOR, o.orderId, { now: new Date(G.G1_AS_OF_AFTER_IMPORT) }));
    await env.db.transaction((tx) => syncOrderFinanceAt(tx, SYSTEM_ACTOR, o.orderId, { now: new Date("2026-12-02T10:00:00Z") }));
    const after = await env.db.select({ n: count() }).from(financeEntries).where(eq(financeEntries.orderId, o.orderId));
    expect(after[0]!.n).toBe(before[0]!.n);
  });

  it("I4: прибуток картки UAH = Σ записів замовлення (кожен за курсом свого fx_on), прогнозів немає", async () => {
    const uah = (await loadOrderFinanceCard(prodCtx(env, G.G1_AS_OF_AFTER_IMPORT), o.orderId, { currency: "UAH" }))!;
    const total = uah.entries
      .filter((e) => !e.reversal && !e.reversed && (PROFIT_CATEGORIES as readonly string[]).includes(e.category))
      .reduce((a, e) => a + toMinor(e.converted!), 0n);
    expect(fromMinor(total)).toBe(uah.profit.value);
  });
});

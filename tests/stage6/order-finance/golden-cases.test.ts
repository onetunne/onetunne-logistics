/**
 * Етап 6, WP4: золоті випадки рівня замовлення G1b, G2, G8, G8b, G10, G10b, G10c, G11, G12 (§20.1) — застосунок проти
 * НЕЗАЛЕЖНОЇ еталонної моделі. Кожен випадок — у власній базі (налаштування, правила комісій і середні доставки не
 * перетинаються). Факти додаються в моменти, коли стали відомі; після кожного кроку syncOrderFinance (now = момент).
 * Порівняння записів — за кортежем (категорія, сума, валюта, recognized_on, fx_on), як у WP12b.
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { financePeriods } from "~/db/schema";
import { loadFinanceSettings, saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { loadOrderFinanceCard } from "~/modules/order-finance/card.server";
import * as G from "../reference/golden";
import { activeEntries, postOrder, type RefEntry, type RefOrderFacts, type RefPostingSettings } from "../reference/model";
import { OWNER } from "../../helpers";
import { GoldenOrder, openGoldenEnv, prodCtx, tuples, type GoldenEnv } from "./golden-helpers";

let env: GoldenEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function run(ref: RefOrderFacts, steps: readonly string[], opts: { partnerCode?: string; before?: (e: GoldenEnv) => Promise<void>; at?: Record<string, (e: GoldenEnv) => Promise<void>> } = {}) {
  env = await openGoldenEnv(G.G1_RATES);
  if (opts.before) await opts.before(env);
  const o = await new GoldenOrder(env, ref, { partnerCode: opts.partnerCode }).create();
  for (const s of steps) {
    const hook = opts.at?.[s];
    if (hook) await hook(env);
    await o.advance(s);
  }
  return o;
}

function expectSameEntries(app: readonly RefEntry[], ref: RefOrderFacts, asOf: string, s: RefPostingSettings = {}) {
  expect(tuples(app)).toEqual(tuples(activeEntries(postOrder(ref, asOf, s).entries)));
}

const only = (es: readonly RefEntry[], category: string) => es.filter((e) => e.category === category);
const AT = "2026-11-30T00:00:00Z";

describe("G1b — передоплата й дата курсу (D-25)", () => {
  const x = G.ORDER_EXPECTED.G1b;
  const at = "2026-10-10T00:00:00Z";

  it("політика «дата оплати» (типово): виручка fx_on 01.10 (4 800,00 грн); собівартість і упаковка — датою визнання", async () => {
    const o = await run(G.G1B_ORDER, ["2026-10-05T12:00:00Z", at]);
    const app = await o.entries();
    expectSameEntries(app, G.G1B_ORDER, at);
    expect(only(app, "sales_product").map((e) => e.fxOn)).toEqual([x.paymentDatePolicy.fxOn]);
    for (const e of [...only(app, "cogs"), ...only(app, "packaging")]) expect([e.recognizedOn, e.fxOn]).toEqual([x.cogs.recognizedOn, x.cogs.fxOn]);
    const card = (await loadOrderFinanceCard(prodCtx(env!, at), o.orderId, { currency: "UAH" }))!;
    expect(card.rows.products.net.converted).toBe(x.paymentDatePolicy.revenue);
  });

  it("політика «дата визнання»: виручка fx_on 05.10 (4 850,00 грн)", async () => {
    const o = await run(G.G1B_ORDER, ["2026-10-05T12:00:00Z", at], {
      before: async (e) => {
        const s = await loadFinanceSettings(e.db);
        await saveFinanceSettings(e.ctx(OWNER), { fx: { ...s.fx, rateDatePolicy: "recognition_date" } });
      },
    });
    const app = await o.entries();
    expectSameEntries(app, G.G1B_ORDER, at, { rateDatePolicy: "recognition_date" });
    expect(only(app, "sales_product").map((e) => e.fxOn)).toEqual([x.recognitionDatePolicy.fxOn]);
    const card = (await loadOrderFinanceCard(prodCtx(env!, at), o.orderId, { currency: "UAH" }))!;
    expect(card.rows.products.net.converted).toBe(x.recognitionDatePolicy.revenue);
  });
});

describe("G2 — ціни з податком (DE, 19 %)", () => {
  it("виручка без податку, податок довідково; база партнера 50,00 → винагорода 5,00; оплачено 69,50", async () => {
    const x = G.ORDER_EXPECTED.G2;
    const at = "2026-10-10T00:00:00Z";
    const o = await run(G.G2_ORDER, ["2026-10-05T12:00:00Z", at], { partnerCode: "GOLDG2" });
    const app = await o.entries();
    expectSameEntries(app, G.G2_ORDER, at);
    expect(only(app, "sales_product").map((e) => e.amount)).toEqual([x.salesProduct]);
    expect(only(app, "sales_shipping").map((e) => e.amount)).toEqual([x.salesShipping]);
    expect(only(app, "tax_collected_memo").map((e) => e.amount).sort()).toEqual([x.taxShipping, x.taxProduct].sort());
    expect(only(app, "partner_commission").map((e) => e.amount)).toEqual([`-${x.partnerCommission}`]);
    const card = (await loadOrderFinanceCard(prodCtx(env!, at), o.orderId, { currency: "EUR" }))!;
    expect(card.paid?.received).toBe(x.paid);
    // Податок — довідково (не у виручці й не в прибутку).
    expect(card.rows.taxCollected.original).toEqual([{ amount: "11.10", currency: "EUR" }]);
  });
});

describe("G8 / G8b — немає даних; відправлено поза застосунком без трек-номера", () => {
  it("G8: incomplete — прибуток не показано («собівартість, комісії»), ніде 0", async () => {
    const x = G.ORDER_EXPECTED.G8;
    const at = "2026-10-10T00:00:00Z";
    const o = await run(G.G8_ORDER, ["2026-10-05T12:00:00Z", "2026-10-06T09:00:00Z", at]);
    expectSameEntries(await o.entries(), G.G8_ORDER, at);
    const f = await o.finance();
    expect(f.profitState).toBe(x.state);
    expect(f.componentsParsed.cogs?.state).toBe("missing");
    expect(f.componentsParsed.fees?.state).toBe("missing");
    const card = (await loadOrderFinanceCard(prodCtx(env!, at), o.orderId, { currency: "UAH" }))!;
    expect(card.profit.kind).toBe("hidden");
    expect(card.profit.value).toBe(x.cardProfit);
    expect(card.profit.missing.map((m) => m.component).sort()).toEqual([...x.missing].sort());
    expect(JSON.parse(JSON.stringify({ profit: card.profit.value }))).toEqual({ profit: null });
  });

  const at = "2026-10-10T00:00:00Z";
  const steps = ["2026-10-05T12:00:00Z", at];

  it("G8b таблиця власника → preliminary (доставка missing no_waybill з прогнозом owner_table; комісії zero_confirmed; упаковка n/a)", async () => {
    const o = await run(G.G8B_ORDER_TABLE, steps);
    expectSameEntries(await o.entries(), G.G8B_ORDER_TABLE, at);
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost).toMatchObject({ state: "missing", reason: "no_waybill", hasForecast: true, basis: "owner_table" });
    expect(f.componentsParsed.fees?.state).toBe("zero_confirmed");
    expect(f.componentsParsed.packaging?.state).toBe("not_applicable");
    expect(f.profitState).toBe(G.ORDER_EXPECTED.G8b.table);
    expect((await o.forecasts()).filter((x) => x.component === "shipping_cost").map((x) => [x.amount, x.currency, x.basis])).toEqual([["-300.00", "UAH", "owner_table"]]);
  });

  it("G8b без таблиці й без середньої → incomplete", async () => {
    const o = await run(G.G8B_ORDER_NOTHING, steps);
    expectSameEntries(await o.entries(), G.G8B_ORDER_NOTHING, at);
    expect((await o.finance()).profitState).toBe(G.ORDER_EXPECTED.G8b.nothing);
  });

  it("G8b «Без витрат на доставку» → final", async () => {
    const o = await run(G.G8B_ORDER_OWNER_MARK, steps);
    expectSameEntries(await o.entries(), G.G8B_ORDER_OWNER_MARK, at);
    const f = await o.finance();
    expect(f.componentsParsed.shipping_cost?.state).toBe("not_applicable");
    expect(f.profitState).toBe(G.ORDER_EXPECTED.G8b.ownerMark);
  });
});

describe("G10 / G10b / G10c — chargeback і повернення без позицій", () => {
  const G10_STEPS = ["2026-10-05T12:00:00Z", "2026-11-10T09:00:00Z", "2026-11-12T12:00:00Z", AT];

  it("G10: −129,00 і −15,00 датою 12.11; винагороду партнера скасовано (нетто 0,00)", async () => {
    const x = G.ORDER_EXPECTED.G10;
    const o = await run(G.G10_ORDER, G10_STEPS, { partnerCode: "GOLDG10" });
    const app = await o.entries();
    expectSameEntries(app, G.G10_ORDER, AT);
    expect(only(app, "chargeback_loss").map((e) => [e.amount, e.recognizedOn])).toEqual([[x.chargebackLoss, x.recognizedOn]]);
    expect(only(app, "chargeback_fees").map((e) => [e.amount, e.recognizedOn])).toEqual([[x.chargebackFee, x.recognizedOn]]);
    const partnerNet = only(app, "partner_commission").reduce((a, e) => a + BigInt(e.amount.replace(".", "")), 0n);
    expect(partnerNet).toBe(0n);
    expect((await o.finance()).reviewReasons).not.toContain(x.overlapFlag);
  });

  it("G10 + повернення коштів → причина перевірки chargeback_refund_overlap", async () => {
    const o = await run(G.G10_ORDER_WITH_REFUND, ["2026-10-05T12:00:00Z", "2026-11-04T10:00:00Z", "2026-11-06T10:00:00Z", ...G10_STEPS.slice(1)], { partnerCode: "GOLDG10R" });
    const f = await o.finance();
    expect(f.needsReview).toBe(true);
    expect(f.reviewReasons).toContain(G.ORDER_EXPECTED.G10.overlapFlag);
  });

  const G10B_STEPS = ["2026-10-05T12:00:00Z", "2026-11-12T12:00:00Z", AT];
  it("G10b типово: 49,50 = 41,59 + 7,91 (обидва chargeback_loss, друга — частка податку); партнер нетто 0,84", async () => {
    const x = G.ORDER_EXPECTED.G10b;
    const o = await run(G.G10B_ORDER, G10B_STEPS, { partnerCode: "GOLDG10B" });
    const app = await o.entries();
    expectSameEntries(app, G.G10B_ORDER, AT);
    expect(only(app, "chargeback_loss").map((e) => e.amount).sort()).toEqual([...x.default.loss].sort());
    expect(only(app, "chargeback_loss").find((e) => e.amount === x.default.loss[1])?.details?.taxPart).toBe(true);
    const partner = only(app, "partner_commission").reduce((a, e) => a + BigInt(e.amount.replace(".", "")), 0n);
    expect(partner).toBe(-84n);
  });

  it("G10b «ПДВ зменшується»: втрата 41,59 + сторно податку −7,91 (tax_collected_memo)", async () => {
    const x = G.ORDER_EXPECTED.G10b;
    const o = await run(G.G10B_ORDER_VAT, G10B_STEPS, { partnerCode: "GOLDG10V" });
    const app = await o.entries();
    expectSameEntries(app, G.G10B_ORDER_VAT, AT);
    expect(only(app, "chargeback_loss").map((e) => e.amount)).toEqual([x.vat.loss]);
    expect(only(app, "tax_collected_memo").map((e) => e.amount)).toContain(x.vat.taxMemoReversal);
  });

  it("G10b «Скасувати винагороду повністю»: партнер нетто 0,00", async () => {
    const o = await run(G.G10B_ORDER_CANCEL, G10B_STEPS, { partnerCode: "GOLDG10C" });
    const app = await o.entries();
    expectSameEntries(app, G.G10B_ORDER_CANCEL, AT);
    expect(only(app, "partner_commission").reduce((a, e) => a + BigInt(e.amount.replace(".", "")), 0n)).toBe(0n);
  });

  it("G10c: refund_adjustment −129,00; база партнера 0 → скасування", async () => {
    const x = G.ORDER_EXPECTED.G10c;
    const o = await run(G.G10C_ORDER, ["2026-10-05T12:00:00Z", "2026-11-10T09:00:00Z", "2026-11-15T10:00:00Z", AT], { partnerCode: "GOLDG10X" });
    const app = await o.entries();
    expectSameEntries(app, G.G10C_ORDER, AT);
    expect(only(app, "refund_adjustment").map((e) => e.amount)).toEqual([x.refundAdjustment]);
    expect(only(app, "partner_commission").reduce((a, e) => a + BigInt(e.amount.replace(".", "")), 0n)).toBe(0n);
  });
});

describe("G11 — закритий жовтень, пізнє повернення", () => {
  it("повернення 31.10, відоме 06.11 → recognized_on 06.11, original_on і fx_on 31.10, «Пізній запис»; final; у жовтень нічого не додано", async () => {
    const closures = G.G11_CLOSURES;
    const close = async (e: GoldenEnv) => {
      await e.db.insert(financePeriods).values({ month: "2026-10-01", status: "closed", closedAt: new Date(closures[0].closedAt), closedBy: "test-owner" });
    };
    const steps = ["2026-10-05T12:00:00Z", "2026-10-20T09:00:00Z", "2026-11-04T00:00:00Z", "2026-11-06T10:00:00Z", AT];
    const o = await run(G.G11_ORDER, steps, { partnerCode: "GOLDG11", at: { "2026-11-06T10:00:00Z": close } });
    const app = await o.entries();
    expectSameEntries(app, G.G11_ORDER, AT, { closures });
    const ret = app.find((e) => e.category === "refund_product")!;
    expect({ recognizedOn: ret.recognizedOn, originalOn: ret.originalOn, fxOn: ret.fxOn, isLate: ret.isLate }).toEqual(G.G11_EXPECTED.lateRefund);
    const adj = app.filter((e) => e.category === "partner_commission" && e.recognizedOn === "2026-11-06");
    expect(adj.map((e) => [e.fxOn, e.isLate])).toEqual([["2026-10-31", true]]);
    expect((await o.finance()).profitState).toBe("final");
    const [p] = await env!.db.select().from(financePeriods).where(eq(financePeriods.month, "2026-10-01"));
    expect(p?.status).toBe("closed");
  });
});

describe("G12 — дата Києва", () => {
  it("оформлено 30.10 23:30 UTC (= 31.10 Київ), передано 02.11 → визнано 02.11; повернення 05.11", async () => {
    const x = G.ORDER_EXPECTED.G12;
    const o = await run(G.G12_ORDER, ["2026-11-02T10:00:00Z", "2026-11-05T09:00:00Z", AT]);
    const app = await o.entries();
    expectSameEntries(app, G.G12_ORDER, AT);
    const f = await o.finance();
    expect(f.recognizedOn).toBe(x.recognizedOn);
    expect(only(app, "refund_product").map((e) => e.recognizedOn)).toEqual([x.refundOn]);
    expect(only(app, "sales_product").map((e) => e.recognizedOn)).toEqual([x.recognizedOn]);
  });
});

/**
 * Етап 6, WP7: доступ (§14.1–§14.2, F8) і «Ефективність партнера» на БД (§9.6, G19).
 * - КОЖЕН сервіс партнерів (читання й керування) → ForbiddenError для працівника й підробленого актора (дозвіл без ролі
 *   owner); внутрішня синхронізація винагороди працює з будь-яким актором і грошей не повертає;
 * - G19 через журнал: прибуток атрибутованих остаточних замовлень до винагороди 4 200,00, винагорода 800,00, фіксована
 *   оплата 200,00 (запис partner_fixed_fee з partner_id) → після 3 400,00, «Окупність» 3,40; попереднє замовлення — лише
 *   у прогнозі, неповне — ніде; конвертація кожного запису за курсом його fx_on, запис без курсу — окремо, не 0.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fxRates, orderFinanceForecasts, partnerAttributions } from "~/db/schema";
import { ForbiddenError, makeActor, SYSTEM_ACTOR } from "~/domain/permissions";
import { postEntries } from "~/modules/finance/core/entries.server";
import {
  addPartnerCode,
  addPartnerRate,
  createPartner,
  deactivatePartnerCode,
  getOrderPartner,
  getPartnerDetail,
  listPartnerOptions,
  listPartners,
  setOrderAttribution,
  updatePartner,
} from "~/modules/partners/partners.server";
import { createPayout, voidPayout } from "~/modules/partners/payouts.server";
import { getPartnerPerformance } from "~/modules/partners/performance.server";
import { createTestEnv, STAFF, type TestEnv } from "../../helpers";
import { insertOrder, makePartner, ownerCtx, setFinance } from "./helpers";

let env: TestEnv;
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const NOW = "2026-11-28T10:00:00Z";

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

describe("access: every partner service requires finance.view / finance.manage AND the owner role", () => {
  it("staff and a forged actor get ForbiddenError everywhere", async () => {
    const id = randomUUID();
    const range = { from: "2026-01-01", to: "2026-12-31" };
    for (const actor of [STAFF, FORGED]) {
      const c = ownerCtx(env, NOW, actor);
      const calls: Array<() => Promise<unknown>> = [
        () => listPartners(c, { range }),
        () => getPartnerDetail(c, id),
        () => listPartnerOptions(c),
        () => getOrderPartner(c, id),
        () => getPartnerPerformance(c, { partnerId: id, range, currency: "UAH" }),
        () => createPartner(c, { displayName: "X", kind: "blogger", rateBp: 1000, holdDays: 30 }),
        () => updatePartner(c, { id, expectedVersion: 1, displayName: "X", kind: "blogger", status: "active", holdDays: 30 }),
        () => addPartnerCode(c, { partnerId: id, source: "discount_code", code: "X" }),
        () => deactivatePartnerCode(c, { codeId: id }),
        () => addPartnerRate(c, { partnerId: id, rateBp: 1000, effectiveFrom: "2026-11-01" }),
        () => setOrderAttribution(c, { orderId: id, mode: "manual", partnerId: null, reason: "x" }),
        () => createPayout(c, { operationId: randomUUID(), partnerId: id, paidOn: "2026-11-01", amount: "1", currency: "EUR", method: "bank" }),
        () => voidPayout(c, { id, reason: "x" }),
      ];
      for (const call of calls) await expect(call()).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});

describe("G19 — partner payback through the journal", () => {
  let partnerId = "";

  beforeAll(async () => {
    const db = env.handle.db;
    partnerId = await makePartner(env, { name: "Окупність" });
    const final = await insertOrder(db, { placedAt: "2026-10-02T09:00:00Z", currency: "UAH" });
    const prelim = await insertOrder(db, { placedAt: "2026-10-03T09:00:00Z", currency: "UAH" });
    const incomplete = await insertOrder(db, { placedAt: "2026-10-04T09:00:00Z", currency: "UAH" });
    const eur = await insertOrder(db, { placedAt: "2026-10-05T09:00:00Z" });
    const outOfPeriod = await insertOrder(db, { placedAt: "2026-08-01T09:00:00Z", currency: "UAH" });
    const states = [
      [final, "final", "2026-10-05"],
      [prelim, "preliminary", "2026-10-06"],
      [incomplete, "incomplete", "2026-10-07"],
      [eur, "final", "2026-11-05"],
      [outOfPeriod, "final", "2026-08-05"],
    ] as const;
    for (const [id, profitState, on] of states) {
      await setFinance(db, id, { state: "recognized", recognizedOn: on, recognizedAt: `${on}T10:00:00Z`, profitState });
      await db.insert(partnerAttributions).values({ orderId: id, partnerId, source: "owner", status: "attributed", rateBp: 1000, holdDays: 30, decidedBy: "t", decidedAt: new Date() });
    }
    const e = (orderId: string, key: string, category: Parameters<typeof postEntries>[2][number]["category"], amount: string, on: string, currency = "UAH") => ({
      idempotencyKey: `demo:g19:${key}`,
      category,
      recognizedOn: on,
      fxOn: on,
      amount,
      currency,
      orderId,
      sourceType: "demo" as const,
      sourceId: key,
    });
    await db.transaction((tx) =>
      postEntries(tx, SYSTEM_ACTOR, [
        e(final, "f1", "sales_product", "6000.00", "2026-10-05"),
        e(final, "f2", "cogs", "-1000.00", "2026-10-05"),
        e(final, "f3", "shipping_cost", "-1000.00", "2026-10-05"),
        e(final, "f4", "partner_commission", "-600.00", "2026-10-05"),
        e(prelim, "p1", "sales_product", "1000.00", "2026-10-06"),
        e(prelim, "p2", "partner_commission", "-100.00", "2026-10-06"),
        e(incomplete, "i1", "sales_product", "500.00", "2026-10-07"),
        e(incomplete, "i2", "refund_product", "-100.00", "2026-11-10"),
        // EUR-замовлення: 100,00 EUR за 05.11 (48,0000) = 4 800,00; винагорода −4,1667 EUR → −200,00 UAH (одне округлення).
        e(eur, "e1", "sales_product", "100.00", "2026-11-05", "EUR"),
        e(eur, "e2", "cogs", "-4600.00", "2026-11-05"),
        e(eur, "e3", "partner_commission", "-4.17", "2026-11-05", "EUR"),
        e(outOfPeriod, "o1", "sales_product", "99999.00", "2026-08-05"),
        { ...e(final, "fee", "partner_fixed_fee", "-200.00", "2026-10-15"), orderId: null, partnerId },
        // Фіксована оплата в PLN без курсу (грудень) — окремо, не 0; окупність періоду з нею невідома.
        { ...e(final, "feepln", "partner_fixed_fee", "-50.00", "2026-12-16", "PLN"), orderId: null, partnerId },
      ]),
    );
    await db.insert(orderFinanceForecasts).values([
      { orderId: prelim, component: "shipping_cost", currency: "UAH", amount: "-300.00", basis: "owner_table" },
      { orderId: prelim, component: "partner", currency: "UAH", amount: "-20.00", basis: "shopify" },
    ]);
    await db.insert(fxRates).values({ source: "demo", currency: "EUR", effectiveDate: "2026-11-05", rate: "48", units: 1, ratePerUnit: "48.0000000000" });
  });

  it("fact: final orders only; payback = 3 400 / (800 + 200) = 3,40; forecast separately; coverage; complete parts", async () => {
    const v = (await getPartnerPerformance(ownerCtx(env, NOW), { partnerId, range: { from: "2026-10-01", to: "2026-11-30" }, currency: "UAH" }))!;
    const s = v.summary;
    // final UAH: 6000 − 1000 − 1000 − 600 = 3400 (до винагороди 4000); final EUR: 4800 − 4600 − 200,16 (4,17 × 48) = −0,16 (до — 200).
    expect(s.fact.commission).toBe("800.16");
    expect(s.fact.profitAfter).toBe("3399.84");
    expect(s.fact.profitBefore).toBe("4200.00");
    expect(s.fact.payback).toBe("3.40");
    expect(s).toMatchObject({ orders: 4, final: 2, preliminary: 1, incomplete: 1, withRevenue: 4, returnOrders: 1, fixedFees: "200.00" });
    // Прогноз: + попереднє (1000 − 100) + прогнози (−300 − 20).
    expect(s.forecast).toMatchObject({ profitAfter: "3979.84", commission: "920.16" });
    expect(v.unconverted).toEqual([]);
    expect(s).toMatchObject({ complete: { revenue: true, commission: true, chargeback: true, fixedFees: true }, paybackMissing: null });
    expect(s.months.map((m) => [m.month, m.orders, m.profit])).toEqual([
      ["2026-10-01", 3, "3400.00"],
      ["2026-11-01", 1, "-0.16"],
    ]);
  });

  it("the same in EUR (each entry converted at its own fx_on); UAH entries without an EUR rate on their date → not in the sums", async () => {
    const v = (await getPartnerPerformance(ownerCtx(env, NOW), { partnerId, range: { from: "2026-11-01", to: "2026-11-30" }, currency: "EUR" }))!;
    expect(v.summary).toMatchObject({ orders: 1, final: 1 });
    // 4 600,00 UAH / 48 = 95,83 EUR; продаж 100,00; винагорода −4,17 → прибуток 0,00.
    expect(v.summary.fact.profitAfter).toBe("0.00");
    expect(v.summary.fact.payback).toBe("0.00");
    const oct = (await getPartnerPerformance(ownerCtx(env, NOW), { partnerId, range: { from: "2026-10-01", to: "2026-10-31" }, currency: "EUR" }))!;
    expect(oct.summary.fact.profitAfter).toBeNull();
    expect(oct.unconverted.map((u) => u.currency).sort()).toEqual(["UAH"]);
    // Фіксована оплата UAH без курсу EUR на 15.10 → повнота частин — false; окупність «—» (немає й остаточних замовлень).
    expect(oct.summary).toMatchObject({ fixedFees: "0.00", complete: { fixedFees: false, revenue: false, commission: false }, paybackMissing: null, fact: { payback: null }, forecast: { payback: null } });
  });

  it("review: a fixed fee without a rate makes payback unknown («—»), never an overstated ratio (F4, §2.6)", async () => {
    const v = (await getPartnerPerformance(ownerCtx(env, NOW), { partnerId, range: { from: "2026-10-01", to: "2026-12-31" }, currency: "UAH" }))!;
    const s = v.summary;
    // Прибуток замовлень відомий, але знаменник (винагорода + фіксовані оплати) — ні: PLN 50,00 без курсу.
    expect(s.fact.profitAfter).toBe("3399.84");
    expect(s.fixedFees).toBe("200.00");
    expect(s).toMatchObject({ complete: { fixedFees: false, revenue: true, commission: true, chargeback: true }, paybackMissing: "fixed_fees_unconverted" });
    expect(s.fact.payback).toBeNull();
    expect(s.forecast.payback).toBeNull();
    expect(v.unconverted).toEqual([{ currency: "PLN", amount: "-50.00", entries: 1 }]);
  });

  it("an empty period → no orders, nothing fabricated", async () => {
    const v = (await getPartnerPerformance(ownerCtx(env, NOW), { partnerId, range: { from: "2026-01-01", to: "2026-01-31" }, currency: "UAH" }))!;
    expect(v.summary).toMatchObject({ orders: 0, averageCheck: null, returnShare: null, fact: { profitAfter: null, payback: null } });
    expect(await getPartnerPerformance(ownerCtx(env, NOW), { partnerId: randomUUID(), range: { from: "2026-01-01", to: "2026-01-31" }, currency: "UAH" })).toBeNull();
  });
});

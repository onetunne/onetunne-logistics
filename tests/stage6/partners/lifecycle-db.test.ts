/**
 * Етап 6, WP7: життєвий цикл винагороди партнера на БД (PGlite / PostgreSQL) — золоті G1 (партнер), G6 (від'ємний баланс
 * після виплати), G10 / G10b / G10c (база: chargeback, chargeback з податком і частковим поверненням, повернення без
 * позицій), I3 (повтор не створює подій), I10 (комісія = round(база × ставка), баланс = Σ подій − Σ виплат), записи
 * журналу partner_commission з ключами pc:<order>:<partner>:<n>, дати R1/R2, прогноз до визнання, «Очікується».
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orderFinanceForecasts } from "~/db/schema";
import { STAFF } from "../../helpers";
import { createTestEnv, type TestEnv } from "../../helpers";
import { getPartnerDetail, listPartners } from "~/modules/partners/partners.server";
import { createPayout } from "~/modules/partners/payouts.server";
import { addDispute, addSale, entriesOf, eventsOf, g1Order, insertOrder, makePartner, ownerCtx, recognize, setFacts, setFinance, sync } from "./helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

const detailOn = async (partnerId: string, now: string) => (await getPartnerDetail(ownerCtx(env, now), partnerId))!;

describe("G1 — discount code, 10 %, partial return in the next month", () => {
  let partnerId = "";
  let orderId = "";

  it("accrual at recognition: 10 % of 117,00 = 11,70 EUR, hold until 04.11, entry −11,70 dated 05.10 (fx_on 05.10)", async () => {
    partnerId = await makePartner(env, { name: "Демо-партнер А", codes: [{ source: "discount_code", code: "PART10" }] });
    orderId = await g1Order(env);
    await setFinance(env.handle.db, orderId, { state: "open" });
    // До визнання — лише прогноз (очікується), жодної події.
    const open = await sync(env, orderId);
    expect(open).toMatchObject({ attribution: "attributed", partnerId, events: 0, entries: 0, component: { state: "forecast", hasForecast: true, required: true } });
    const [fc] = await env.handle.db.select().from(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, orderId), eq(orderFinanceForecasts.component, "partner")));
    expect(fc).toMatchObject({ amount: "-11.70", currency: "EUR" });
    const list = await listPartners(ownerCtx(env, "2026-10-04T10:00:00Z"), { range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(list.partners.find((p) => p.id === partnerId)).toMatchObject({ ordersInPeriod: 1, expected: [{ amount: "11.70", currency: "EUR" }], ledger: [] });

    await recognize(env, orderId, "2026-10-05");
    const r = await sync(env, orderId, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    expect(r).toMatchObject({ attribution: "attributed", events: 1, entries: 1, component: { state: "actual", hasForecast: false, required: true, basis: "demo" } });
    const [ev] = await eventsOf(env.handle.db, orderId);
    expect(ev).toMatchObject({ n: 1, kind: "accrual", base: "117.00", rateBp: 1000, amount: "11.70", currency: "EUR", recognizedOn: "2026-10-05", holdUntil: "2026-11-04" });
    expect(ev!.idempotencyKey).toBe(`pc:${orderId}:${partnerId}:1`);
    const [entry] = await entriesOf(env.handle.db, orderId);
    expect(entry).toMatchObject({
      idempotencyKey: `pc:${orderId}:${partnerId}:1`,
      category: "partner_commission",
      amount: "-11.70",
      currency: "EUR",
      recognizedOn: "2026-10-05",
      fxOn: "2026-10-05",
      isLateCompletion: false,
      partnerId,
      sourceType: "partner_event",
      sourceId: ev!.id,
    });
    // Факт замінює прогноз.
    expect(await env.handle.db.select().from(orderFinanceForecasts).where(eq(orderFinanceForecasts.orderId, orderId))).toHaveLength(0);
  });

  it("repeated syncs add nothing (I3)", async () => {
    for (let i = 0; i < 3; i++) expect(await sync(env, orderId)).toMatchObject({ events: 0, entries: 0 });
    expect(await eventsOf(env.handle.db, orderId)).toHaveLength(1);
  });

  it("return 04.11 (RETURN A −1 × 45,00) → adjustment −4,50 dated 04.11 (base 72,00 → 7,20), fx_on 04.11", async () => {
    await addSale(env.handle.db, orderId, { kind: "return", lineType: "PRODUCT", total: "-45.00", happenedAt: "2026-11-04T09:00:00Z" });
    const r = await sync(env, orderId);
    expect(r).toMatchObject({ events: 1, entries: 1 });
    const evs = await eventsOf(env.handle.db, orderId);
    expect(evs[1]).toMatchObject({ n: 2, kind: "adjustment", base: "72.00", amount: "-4.50", recognizedOn: "2026-11-04", holdUntil: null });
    const entries = await entriesOf(env.handle.db, orderId);
    expect(entries[1]).toMatchObject({ idempotencyKey: `pc:${orderId}:${partnerId}:2`, amount: "4.50", recognizedOn: "2026-11-04", fxOn: "2026-11-04" });
  });

  it("states: accrued (hold) up to 04.11 inclusive, payable 7,20 from 05.11", async () => {
    const before = await detailOn(partnerId, "2026-11-04T12:00:00Z");
    expect(before.commissions[0]).toMatchObject({ state: "accrued", net: "7.20", accrued: "11.70", adjustments: "-4.50", holdUntil: "2026-11-04" });
    expect(before.ledger[0]).toMatchObject({ payable: "0.00", inHold: "7.20", balance: "7.20" });
    const after = await detailOn(partnerId, "2026-11-05T09:00:00Z");
    expect(after.commissions[0]).toMatchObject({ state: "payable", outstanding: "7.20" });
    expect(after.ledger[0]).toMatchObject({ currency: "EUR", accrued: "11.70", adjustments: "-4.50", net: "7.20", paid: "0.00", balance: "7.20", payable: "7.20", owes: "0.00" });
  });
});

describe("G6 — partner after payout: negative balance", () => {
  it("accrued 11,70 (05.10), paid 11,70 (10.11), full refund 15.11 → −11,70 → balance −11,70; next order +8,00 → −3,70, payable 0", async () => {
    const partnerId = await makePartner(env, { codes: [{ source: "discount_code", code: "G6CODE" }] });
    const o1 = await g1Order(env, "G6CODE");
    await recognize(env, o1, "2026-10-05");
    await sync(env, o1, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    expect((await detailOn(partnerId, "2026-11-04T12:00:00Z")).ledger[0]).toMatchObject({ payable: "0.00" });
    expect((await detailOn(partnerId, "2026-11-05T12:00:00Z")).ledger[0]).toMatchObject({ payable: "11.70" });

    const payout = await createPayout(ownerCtx(env, "2026-11-10T10:00:00Z"), {
      operationId: randomUUID(),
      partnerId,
      paidOn: "2026-11-10",
      amount: "11,70",
      currency: "EUR",
      method: "bank",
    });
    expect(payout).toMatchObject({ duplicate: false, advance: false, covers: { amount: "11.70", currency: "EUR" }, payableBefore: { amount: "11.70" } });
    const paid = await detailOn(partnerId, "2026-11-11T10:00:00Z");
    expect(paid.commissions[0]).toMatchObject({ state: "paid", paid: "11.70", outstanding: "0.00" });
    expect(paid.ledger[0]).toMatchObject({ paid: "11.70", balance: "0.00", payable: "0.00" });

    await addSale(env.handle.db, o1, { kind: "return", lineType: "PRODUCT", total: "-117.00", happenedAt: "2026-11-15T09:00:00Z" });
    await addSale(env.handle.db, o1, { kind: "refund", lineType: "SHIPPING", total: "-12.00", happenedAt: "2026-11-15T09:00:00Z" });
    await sync(env, o1);
    const evs = await eventsOf(env.handle.db, o1);
    expect(evs[1]).toMatchObject({ kind: "cancellation", amount: "-11.70", base: "0.00", recognizedOn: "2026-11-15" });
    const neg = await detailOn(partnerId, "2026-11-16T10:00:00Z");
    expect(neg.commissions[0]).toMatchObject({ state: "cancelled", net: "0.00" });
    expect(neg.ledger[0]).toMatchObject({ net: "0.00", paid: "11.70", balance: "-11.70", owes: "11.70", payable: "0.00" });

    const o2 = await insertOrder(env.handle.db, { placedAt: "2026-11-18T09:00:00Z" });
    await setFacts(env.handle.db, o2, { discountCodes: ["G6CODE"] });
    await addSale(env.handle.db, o2, { lineType: "PRODUCT", total: "80.00", happenedAt: "2026-11-18T09:00:00Z" });
    await recognize(env, o2, "2026-11-20");
    await sync(env, o2, { finance: { state: "recognized", recognizedOn: "2026-11-20", recognizedAt: new Date("2026-11-20T10:00:00Z"), newlyRecognized: true } });
    const last = await detailOn(partnerId, "2026-11-21T10:00:00Z");
    expect(last.ledger[0]).toMatchObject({ net: "8.00", paid: "11.70", balance: "-3.70", owes: "3.70", payable: "0.00" });
    // I10: баланс = Σ подій − Σ виплат.
    const all = [...(await eventsOf(env.handle.db, o1)), ...(await eventsOf(env.handle.db, o2))];
    const sum = all.reduce((s, e) => s + Math.round(Number(e.amount) * 100), 0) - 1170;
    expect(sum).toBe(-370);
  });
});

describe("G10 — chargeback lost 129,00 (no tax): base 117 → 0, commission cancelled on the decision date", () => {
  it("cancellation −11,70 dated 12.11", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10CODE" }] });
    const o = await g1Order(env, "G10CODE");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    await addDispute(env.handle.db, o, { outcome: "lost", amount: "129.00", recovered: "0.00", decidedOn: "2026-11-12" });
    expect(await sync(env, o)).toMatchObject({ events: 1 });
    const evs = await eventsOf(env.handle.db, o);
    expect(evs[1]).toMatchObject({ kind: "cancellation", amount: "-11.70", base: "0.00", recognizedOn: "2026-11-12" });
    expect((await entriesOf(env.handle.db, o))[1]).toMatchObject({ amount: "11.70", recognizedOn: "2026-11-12", fxOn: "2026-11-12" });
  });
});

describe("G10b — chargeback with tax and partial recovery (G2 order)", () => {
  async function g2(code: string) {
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-03T08:00:00Z" });
    await setFacts(env.handle.db, o, { discountCodes: [code] });
    await addSale(env.handle.db, o, { lineType: "PRODUCT", total: "59.50", tax: "9.50", happenedAt: "2026-10-03T08:00:00Z" });
    await addSale(env.handle.db, o, { lineType: "SHIPPING", total: "10.00", tax: "1.60", happenedAt: "2026-10-03T08:00:00Z" });
    await recognize(env, o, "2026-10-05");
    await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    return o;
  }

  it("base 50,00 (G2) → 5,00; dispute 69,50 recovered 20,00 → loss 49,50 → net part 41,59 → base 8,41 → 0,84 (adjustment −4,16)", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10B" }] });
    const o = await g2("G10B");
    expect((await eventsOf(env.handle.db, o))[0]).toMatchObject({ base: "50.00", amount: "5.00" });
    await addDispute(env.handle.db, o, { outcome: "lost", amount: "69.50", recovered: "20.00", decidedOn: "2026-11-12" });
    await sync(env, o);
    const evs = await eventsOf(env.handle.db, o);
    expect(evs[1]).toMatchObject({ kind: "adjustment", base: "8.41", amount: "-4.16", recognizedOn: "2026-11-12" });
  });

  it("with «Скасувати винагороду повністю» — 0 (cancellation)", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10BFULL" }] });
    const o = await g2("G10BFULL");
    await addDispute(env.handle.db, o, { outcome: "lost", amount: "69.50", recovered: "20.00", decidedOn: "2026-11-12", full: true });
    await sync(env, o);
    const evs = await eventsOf(env.handle.db, o);
    expect(evs.map((e) => [e.kind, e.amount])).toEqual([
      ["accrual", "5.00"],
      ["cancellation", "-5.00"],
    ]);
  });

  it("an open (undecided) dispute does not change the commission", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10BOPEN" }] });
    const o = await g2("G10BOPEN");
    await addDispute(env.handle.db, o, { outcome: null, amount: null, currency: null });
    expect(await sync(env, o)).toMatchObject({ events: 0 });
  });
});

describe("G10c — refund without items (lost parcel): REFUND ADJUSTMENT −129,00 → base max(0, min(117; −12)) = 0 → cancellation", () => {
  it("cancels the commission", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10C" }] });
    const o = await g1Order(env, "G10C");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    await addSale(env.handle.db, o, { kind: "refund", lineType: "ADJUSTMENT", total: "-129.00", happenedAt: "2026-11-08T10:00:00Z" });
    await sync(env, o);
    const evs = await eventsOf(env.handle.db, o);
    expect(evs[1]).toMatchObject({ kind: "cancellation", amount: "-11.70", base: "0.00", recognizedOn: "2026-11-08" });
  });

  it("a positive no-item adjustment (restocking fee) is not added to the base", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10CPLUS" }] });
    const o = await g1Order(env, "G10CPLUS");
    await recognize(env, o, "2026-10-05");
    await addSale(env.handle.db, o, { kind: "refund", lineType: "ADJUSTMENT", total: "5.00", happenedAt: "2026-10-04T10:00:00Z" });
    await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    expect((await eventsOf(env.handle.db, o))[0]).toMatchObject({ base: "117.00", amount: "11.70" });
  });

  it("displayFinancialStatus = REFUNDED cancels to 0 even if sales were not read", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "G10CREF" }] });
    const o = await g1Order(env, "G10CREF");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    await setFacts(env.handle.db, o, { discountCodes: ["G10CREF"], displayFinancialStatus: "REFUNDED" });
    await sync(env, o, { now: new Date("2026-11-09T10:00:00Z") });
    expect((await eventsOf(env.handle.db, o)).map((e) => e.kind)).toEqual(["accrual", "cancellation"]);
  });
});

describe("missing data never becomes 0 (F4)", () => {
  it("attributed, recognized, but no Shopify sales yet → component missing (awaiting_shopify), no event; facts arrive → accrual as late completion R3", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "NOSALES" }] });
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-02T09:00:00Z" });
    await setFacts(env.handle.db, o, { discountCodes: ["NOSALES"] });
    await recognize(env, o, "2026-10-05");
    const r = await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } });
    expect(r).toMatchObject({ attribution: "attributed", events: 0, component: { state: "missing", reason: "awaiting_shopify", hasForecast: false, required: true } });
    await addSale(env.handle.db, o, { lineType: "PRODUCT", total: "100.00", happenedAt: "2026-10-02T09:00:00Z" });
    await sync(env, o);
    const [entry] = await entriesOf(env.handle.db, o);
    expect(entry).toMatchObject({ amount: "-10.00", recognizedOn: "2026-10-05", isLateCompletion: true });
  });

  it("owner-confirmed product amounts (order without agreements) are the base", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "CONFIRMED" }] });
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-02T09:00:00Z" });
    await setFacts(env.handle.db, o, { discountCodes: ["CONFIRMED"] });
    await recognize(env, o, "2026-10-05");
    const r = await sync(env, o, { confirmedProducts: { amount: "200.00", currency: "EUR" } });
    expect(r.component).toMatchObject({ state: "actual", basis: "owner_confirmed" });
    expect((await eventsOf(env.handle.db, o))[0]).toMatchObject({ base: "200.00", amount: "20.00" });
  });
});

describe("staff flows: posting works without an actor check and returns no money (F8)", () => {
  it("the result has only codes and counts", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "STAFFFLOW" }] });
    const o = await g1Order(env, "STAFFFLOW");
    await recognize(env, o, "2026-10-05");
    const r = await sync(env, o, { finance: { state: "recognized", recognizedOn: "2026-10-05", recognizedAt: new Date("2026-10-05T10:00:00Z"), newlyRecognized: true } }, STAFF);
    expect(r.events).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/\d+\.\d{2}/);
    const [entry] = await entriesOf(env.handle.db, o);
    expect(entry!.postedBy).toBe(STAFF.id);
  });
});

/**
 * Етап 6, WP7: атрибуція на БД (§9.2): усі коди знижок, реферальний лише з ready = true, неоднозначність →
 * partner_attribution_ambiguous (без `issues`, I19) і «Обрати партнера», ручні рішення не перезаписуються, автоматична
 * атрибуція з нарахуванням фіксується, тестові замовлення не атрибутуються (і скасовуються, коли їх виключено),
 * journey_never_ready → «Потребує перевірки», зняття / заміна партнера → скасування й нове нарахування, додавання коду →
 * атрибуція наявних замовлень, вимкнення коду, ставка на дату замовлення, історія змін без імен.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, financeChangeLog, financeDiscrepancies, issues, orderDisputes, partnerAttributions } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { reverseEntries } from "~/modules/finance/core/entries.server";
import { getSetting } from "~/modules/settings/settings.server";
import { writeFinanceSettingsVersion } from "~/modules/settings/settings.server";
import { addPartnerCode, addPartnerRate, deactivatePartnerCode, getOrderPartner, getPartnerDetail, setOrderAttribution, updatePartner } from "~/modules/partners/partners.server";
import { ambiguityKey } from "~/modules/partners/sync.server";
import { resolveDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { createTestEnv, OWNER, type TestEnv } from "../../helpers";
import { addDispute, addSale, entriesOf, eventsOf, g1Order, insertOrder, makePartner, ownerCtx, recognize, setFacts, setFinance, sync } from "./helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

const attrOf = async (orderId: string) => (await env.handle.db.select().from(partnerAttributions).where(eq(partnerAttributions.orderId, orderId)))[0] ?? null;
const recognized = (on: string) => ({ finance: { state: "recognized" as const, recognizedOn: on, recognizedAt: new Date(`${on}T10:00:00Z`), newlyRecognized: true } });
const NOW = "2026-11-28T10:00:00Z";

describe("ambiguity and the owner's choice", () => {
  it("two partners' codes → ambiguous + one discrepancy (no issues); choose → resolved partner_chosen, accrual (late completion), manual kept", async () => {
    const a = await makePartner(env, { codes: [{ source: "discount_code", code: "AMB-A" }] });
    const b = await makePartner(env, { rateBp: 800, codes: [{ source: "discount_code", code: "AMB-B" }] });
    const o = await g1Order(env, "AMB-A");
    await setFacts(env.handle.db, o, { discountCodes: ["amb-a", "AMB-B"] });
    await recognize(env, o, "2026-10-05");
    for (let i = 0; i < 2; i++) {
      const r = await sync(env, o, recognized("2026-10-05"));
      expect(r).toMatchObject({ attribution: "ambiguous", partnerId: null, events: 0, component: { state: "missing", reason: "ambiguous_partner", required: true }, review: ["partner_attribution_ambiguous"] });
    }
    const [d] = await env.handle.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.dedupeKey, ambiguityKey(o)));
    expect(d).toMatchObject({ type: "partner_attribution_ambiguous", status: "open", orderId: o });
    expect((d!.details as { partnerIds: string[] }).partnerIds.sort()).toEqual([a, b].sort());
    const [iss] = await env.handle.db.select({ c: count() }).from(issues);
    expect(Number(iss!.c)).toBe(0);
    expect((await attrOf(o))!.details).toMatchObject({ partnerIds: [a, b].sort() });

    const r = await setOrderAttribution(ownerCtx(env, NOW), { orderId: o, mode: "manual", partnerId: b, reason: "Блогер підтвердив замовлення" });
    expect(r).toMatchObject({ status: "attributed", events: 1 });
    const [resolved] = await env.handle.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.dedupeKey, ambiguityKey(o)));
    expect(resolved).toMatchObject({ status: "resolved", resolutionCode: "partner_chosen" });
    expect(await attrOf(o)).toMatchObject({ source: "owner", status: "attributed", partnerId: b, rateBp: 800, holdDays: 30, decidedBy: OWNER.id });
    expect((await eventsOf(env.handle.db, o))[0]).toMatchObject({ partnerId: b, kind: "accrual", amount: "9.36", recognizedOn: "2026-10-05" });
    expect((await entriesOf(env.handle.db, o))[0]).toMatchObject({ amount: "-9.36", isLateCompletion: true, postedBy: OWNER.id });
    // Ручне рішення не перезаписується автоматикою.
    expect(await sync(env, o)).toMatchObject({ attribution: "attributed", partnerId: b, events: 0 });
    // Історія змін — без імені партнера й без тексту замовлення.
    const [log] = await env.handle.db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "partner_attribution"), eq(financeChangeLog.entityId, o)));
    expect(log).toMatchObject({ action: "update", reason: "Блогер підтвердив замовлення" });
    expect(log!.after).toMatchObject({ orderId: o, partnerId: b, source: "owner", rateBp: 800, holdDays: 30, status: "attributed" });
    expect(JSON.stringify([log!.before, log!.after])).not.toMatch(/Демо-партнер/);
    const order = await getOrderPartner(ownerCtx(env, NOW), o);
    expect(order).toMatchObject({ attribution: { status: "attributed", manual: true, partnerId: b, rateBp: 800 }, commission: { net: "9.36", state: "payable", holdUntil: "2026-11-04" }, expected: null });
  });

  it("owner removes the partner after accrual → cancellation dated the decision; back to automatic → re-attributed and re-accrued", async () => {
    const a = await makePartner(env, { codes: [{ source: "discount_code", code: "RM-A" }] });
    const o = await g1Order(env, "RM-A");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    await setOrderAttribution(ownerCtx(env, "2026-11-20T10:00:00Z"), { orderId: o, mode: "manual", partnerId: null, reason: "Код використано без партнера" });
    let evs = await eventsOf(env.handle.db, o);
    expect(evs.map((e) => [e.kind, e.amount])).toEqual([
      ["accrual", "11.70"],
      ["cancellation", "-11.70"],
    ]);
    expect(await attrOf(o)).toMatchObject({ source: "owner", status: "removed", partnerId: null });
    expect(await sync(env, o)).toMatchObject({ attribution: "removed", component: { state: "not_applicable", reason: "no_partner", required: false } });
    await setOrderAttribution(ownerCtx(env, "2026-11-21T10:00:00Z"), { orderId: o, mode: "auto", reason: "Помилково знято" });
    evs = await eventsOf(env.handle.db, o);
    expect(evs.map((e) => [e.partnerId, e.kind, e.amount])).toEqual([
      [a, "accrual", "11.70"],
      [a, "cancellation", "-11.70"],
      [a, "adjustment", "11.70"],
    ]);
    expect(await attrOf(o)).toMatchObject({ source: "discount_code", status: "attributed", partnerId: a });
  });

  it("owner switches to another partner after accrual → cancellation for the old one, accrual for the new one", async () => {
    const a = await makePartner(env, { codes: [{ source: "discount_code", code: "SW-A" }] });
    const b = await makePartner(env, { rateBp: 500 });
    const o = await g1Order(env, "SW-A");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    await setOrderAttribution(ownerCtx(env, "2026-11-22T10:00:00Z"), { orderId: o, mode: "manual", partnerId: b, reason: "Інший блогер" });
    const evs = await eventsOf(env.handle.db, o);
    expect(evs.map((e) => [e.partnerId, e.kind, e.amount, e.recognizedOn])).toEqual([
      [a, "accrual", "11.70", "2026-10-05"],
      [a, "cancellation", "-11.70", "2026-11-22"],
      [b, "accrual", "5.85", "2026-10-05"],
    ]);
  });

  it("an ambiguity the owner chose to ignore is not reopened by later syncs", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "IGN-A" }] });
    await makePartner(env, { codes: [{ source: "discount_code", code: "IGN-B" }] });
    const o = await g1Order(env, "IGN-A");
    await setFacts(env.handle.db, o, { discountCodes: ["IGN-A", "IGN-B"] });
    await sync(env, o);
    const [d] = await env.handle.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.dedupeKey, ambiguityKey(o)));
    await resolveDiscrepancy(ownerCtx(env, NOW), { id: d!.id, status: "ignored", resolutionCode: "other", note: "Розберуся пізніше" });
    expect(await sync(env, o)).toMatchObject({ attribution: "ambiguous" });
    const [after] = await env.handle.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.dedupeKey, ambiguityKey(o)));
    expect(after).toMatchObject({ status: "ignored" });
  });

  it("the reason is required for a manual decision", async () => {
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-01T10:00:00Z" });
    await expect(setOrderAttribution(ownerCtx(env, NOW), { orderId: o, mode: "manual", partnerId: null, reason: "  " })).rejects.toMatchObject({ code: "partners.error.reasonRequired" });
  });
});

describe("automatic attribution rules", () => {
  it("referral code only with journey ready; discount code wins over referral", async () => {
    const r = await makePartner(env, { codes: [{ source: "referral", code: "maxride" }] });
    const d = await makePartner(env, { codes: [{ source: "discount_code", code: "REF-DISC" }] });
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-03T10:00:00Z" });
    await addSale(env.handle.db, o, { lineType: "PRODUCT", total: "100.00", happenedAt: "2026-10-03T10:00:00Z" });
    await setFinance(env.handle.db, o, { state: "open" });
    await setFacts(env.handle.db, o, { referralCode: null, journeyReady: false });
    expect(await sync(env, o)).toMatchObject({ attribution: "none", component: { state: "not_applicable" } });
    await setFacts(env.handle.db, o, { referralCode: "MaxRide", journeyReady: true });
    expect(await sync(env, o)).toMatchObject({ attribution: "attributed", partnerId: r, component: { state: "forecast" } });
    expect(await attrOf(o)).toMatchObject({ source: "referral", partnerId: r });
    await setFacts(env.handle.db, o, { referralCode: "MaxRide", journeyReady: true, discountCodes: ["ref-disc"] });
    expect(await sync(env, o)).toMatchObject({ attribution: "attributed", partnerId: d });
  });

  it("journey never ready with active referral partners → review reason journey_never_ready", async () => {
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-03T10:00:00Z" });
    await setFacts(env.handle.db, o, { journeyReady: false, flags: ["journey_never_ready"] });
    expect(await sync(env, o)).toMatchObject({ attribution: "none", review: ["journey_never_ready"] });
  });

  it("only codes valid on the order date (Kyiv) count; the rate in force on the order date is fixed", async () => {
    const p = await makePartner(env, { rateBp: 1000, codes: [{ source: "discount_code", code: "OCT-ONLY", validFrom: "2026-10-01", validTo: "2026-10-31" }] });
    await addPartnerRate(ownerCtx(env, NOW), { partnerId: p, rateBp: 1500, effectiveFrom: "2026-10-20", reason: "Нова умова" });
    const early = await insertOrder(env.handle.db, { placedAt: "2026-10-10T10:00:00Z" });
    const late = await insertOrder(env.handle.db, { placedAt: "2026-10-31T22:30:00Z" }); // 01.11 00:30 за Києвом (UTC+2)
    const mid = await insertOrder(env.handle.db, { placedAt: "2026-10-25T10:00:00Z" });
    for (const o of [early, late, mid]) await setFacts(env.handle.db, o, { discountCodes: ["OCT-ONLY"] });
    expect(await sync(env, early)).toMatchObject({ attribution: "attributed" });
    expect((await attrOf(early))!.rateBp).toBe(1000);
    expect(await sync(env, mid)).toMatchObject({ attribution: "attributed" });
    expect((await attrOf(mid))!.rateBp).toBe(1500);
    expect(await sync(env, late)).toMatchObject({ attribution: "none" });
  });

  it("test orders are not attributed; switching includeTestOrders off REVERSES the accrual (F2: original dates and fx_on, I14); back on → reposted", async () => {
    const p = await makePartner(env, { codes: [{ source: "discount_code", code: "TESTORD" }] });
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-03T10:00:00Z", test: true });
    await addSale(env.handle.db, o, { lineType: "PRODUCT", total: "100.00", happenedAt: "2026-10-03T10:00:00Z" });
    await setFacts(env.handle.db, o, { discountCodes: ["TESTORD"] });
    await recognize(env, o, "2026-10-05");
    expect(await sync(env, o, recognized("2026-10-05"))).toMatchObject({ attribution: "none", events: 0 });
    const settings = await getSetting(env.handle.db, "finance");
    await env.handle.db.transaction((tx) => writeFinanceSettingsVersion(tx, OWNER, { ...settings, includeTestOrders: true }));
    expect(await sync(env, o, recognized("2026-10-05"))).toMatchObject({ attribution: "attributed", events: 1 });
    await env.handle.db.transaction((tx) => writeFinanceSettingsVersion(tx, OWNER, { ...settings, includeTestOrders: false }));
    await setFinance(env.handle.db, o, { state: "excluded", recognizedOn: "2026-10-05", recognizedAt: "2026-10-05T10:00:00Z" });
    const r = await sync(env, o, { now: new Date("2026-11-25T10:00:00Z") });
    expect(r).toMatchObject({ events: 0, reversed: 1, component: { state: "not_applicable", required: false } });
    // Жодної нової датованої «скасування» — лише сторно запису журналу з датою й курсом оригіналу.
    expect((await eventsOf(env.handle.db, o)).map((e) => [e.n, e.kind, e.amount, e.recognizedOn])).toEqual([[1, "accrual", "10.00", "2026-10-05"]]);
    const key = `pc:${o}:${p}:1`;
    const rows = await entriesOf(env.handle.db, o);
    expect(rows.map((e) => [e.idempotencyKey, e.amount, e.recognizedOn, e.fxOn])).toEqual([
      [key, "-10.00", "2026-10-05", "2026-10-05"],
      [`${key}:rev`, "10.00", "2026-10-05", "2026-10-05"],
    ]);
    expect(rows[1]!.reversesEntryId).toBe(rows[0]!.id);
    // I14: оригінал + сторно = 0 у будь-якій валюті (той самий fx_on → той самий курс): 48,50 UAH за EUR на 05.10.
    const uah = rows.reduce((sum, e) => sum + BigInt(e.amount.replace(".", "")) * 4850n, 0n);
    expect(uah).toBe(0n);
    // Повтор і подвійне сторно (WP4 теж сторнує записи замовлення) — без нових записів (ключ <ключ>:rev унікальний).
    expect(await sync(env, o, { now: new Date("2026-11-26T10:00:00Z") })).toMatchObject({ reversed: 0, events: 0 });
    const refs = rows.map((e) => e.id);
    await env.handle.db.transaction((tx) => reverseEntries(tx, SYSTEM_ACTOR, [refs[0]!]));
    expect(await entriesOf(env.handle.db, o)).toHaveLength(2);
    // Баланс партнера: подія нечинна — нічого до виплати.
    expect((await getPartnerDetail(ownerCtx(env, NOW), p))!.ledger).toEqual([]);

    // Знову враховується: повторне проведення тієї самої події (покоління :g2) з її датами, без нових подій.
    await env.handle.db.transaction((tx) => writeFinanceSettingsVersion(tx, OWNER, { ...settings, includeTestOrders: true }));
    await recognize(env, o, "2026-10-05");
    expect(await sync(env, o, { now: new Date("2026-11-27T10:00:00Z") })).toMatchObject({ events: 0, reposted: 1, component: { state: "actual" } });
    const again = await entriesOf(env.handle.db, o);
    expect(again.map((e) => [e.idempotencyKey, e.amount, e.recognizedOn, e.fxOn])).toContainEqual([`${key}:g2`, "-10.00", "2026-10-05", "2026-10-05"]);
    expect((await getPartnerDetail(ownerCtx(env, NOW), p))!.ledger[0]).toMatchObject({ net: "10.00", payable: "10.00" });
    // Повтор — нічого.
    expect(await sync(env, o, { now: new Date("2026-11-27T11:00:00Z") })).toMatchObject({ events: 0, reposted: 0, reversed: 0 });
    // Повернення, поки замовлення враховується, — звичайне коригування з наступним номером n.
    await addSale(env.handle.db, o, { kind: "return", lineType: "PRODUCT", total: "-40.00", happenedAt: "2026-11-27T12:00:00Z" });
    expect(await sync(env, o, { now: new Date("2026-11-27T13:00:00Z") })).toMatchObject({ events: 1 });
    expect((await eventsOf(env.handle.db, o)).map((e) => [e.n, e.kind, e.amount, e.recognizedOn])).toEqual([
      [1, "accrual", "10.00", "2026-10-05"],
      [2, "adjustment", "-4.00", "2026-11-27"],
    ]);
    // Знову виключено — сторно обох чинних записів (:g2 і події 2), Σ = 0.
    await env.handle.db.transaction((tx) => writeFinanceSettingsVersion(tx, OWNER, { ...settings, includeTestOrders: false }));
    await setFinance(env.handle.db, o, { state: "excluded", recognizedOn: "2026-10-05", recognizedAt: "2026-10-05T10:00:00Z" });
    expect(await sync(env, o, { now: new Date("2026-11-28T09:00:00Z") })).toMatchObject({ reversed: 2 });
    const final = await entriesOf(env.handle.db, o);
    expect(final.reduce((sum, e) => sum + BigInt(e.amount.replace(".", "")), 0n)).toBe(0n);
    for (const rev of final.filter((e) => e.reversesEntryId)) {
      const orig = final.find((e) => e.id === rev.reversesEntryId)!;
      expect([rev.recognizedOn, rev.fxOn]).toEqual([orig.recognizedOn, orig.fxOn]);
    }
    expect((await getPartnerDetail(ownerCtx(env, NOW), p))!.ledger).toEqual([]);
  });

  it("review: a return booked while the order was excluded → on re-inclusion the accrual is reposted and the adjustment is dated by the return", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "TESTRET" }] });
    const o = await insertOrder(env.handle.db, { placedAt: "2026-10-03T10:00:00Z", test: true });
    await addSale(env.handle.db, o, { lineType: "PRODUCT", total: "100.00", happenedAt: "2026-10-03T10:00:00Z" });
    await setFacts(env.handle.db, o, { discountCodes: ["TESTRET"] });
    const settings = await getSetting(env.handle.db, "finance");
    const include = (on: boolean) => env.handle.db.transaction((tx) => writeFinanceSettingsVersion(tx, OWNER, { ...settings, includeTestOrders: on }));
    await include(true);
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    await include(false);
    await setFinance(env.handle.db, o, { state: "excluded", recognizedOn: "2026-10-05", recognizedAt: "2026-10-05T10:00:00Z" });
    expect(await sync(env, o, { now: new Date("2026-11-01T10:00:00Z") })).toMatchObject({ reversed: 1 });
    await addSale(env.handle.db, o, { kind: "return", lineType: "PRODUCT", total: "-40.00", happenedAt: "2026-11-10T09:00:00Z" });
    expect(await sync(env, o, { now: new Date("2026-11-11T10:00:00Z") })).toMatchObject({ events: 0, reversed: 0 });
    await include(true);
    await recognize(env, o, "2026-10-05");
    expect(await sync(env, o, { now: new Date("2026-11-20T10:00:00Z") })).toMatchObject({ reposted: 1, events: 1 });
    expect((await eventsOf(env.handle.db, o)).map((e) => [e.n, e.kind, e.amount, e.recognizedOn])).toEqual([
      [1, "accrual", "10.00", "2026-10-05"],
      [2, "adjustment", "-4.00", "2026-11-10"],
    ]);
    await include(false);
  });

  it("review: disabling a code keeps already-made attributions (open orders too); its value given to another partner does not move older orders", async () => {
    const a = await makePartner(env, { codes: [{ source: "discount_code", code: "FROZEN" }] });
    const o = await g1Order(env, "FROZEN");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    const codeId = (await attrOf(o))!.codeId!;
    // Ще не відвантажене замовлення з тим самим кодом (оформлене 05.10).
    const open = await g1Order(env, "FROZEN");
    await setFinance(env.handle.db, open, { state: "open" });
    expect(await sync(env, open)).toMatchObject({ attribution: "attributed", component: { state: "forecast" } });
    const r = await deactivatePartnerCode(ownerCtx(env, "2026-10-06T10:00:00Z"), { codeId, reason: "Кампанію завершено" });
    expect(r.resynced).toBe(0);
    expect(await sync(env, o)).toMatchObject({ attribution: "attributed", partnerId: a, events: 0 });
    expect(await eventsOf(env.handle.db, o)).toHaveLength(1);
    expect(await sync(env, open)).toMatchObject({ attribution: "attributed", partnerId: a, component: { state: "forecast" } });
    expect(await getOrderPartner(ownerCtx(env, NOW), open)).toMatchObject({ attribution: { partnerId: a, status: "attributed" }, expected: { amount: "11.70", currency: "EUR" } });
    // Нове замовлення з вимкненим кодом — не атрибутується (і фіксується «не атрибутовано»).
    const after = await insertOrder(env.handle.db, { placedAt: "2026-10-06T12:00:00Z" });
    await setFacts(env.handle.db, after, { discountCodes: ["FROZEN"] });
    expect(await sync(env, after)).toMatchObject({ attribution: "removed", partnerId: null });
    expect((await attrOf(after))!.details).toMatchObject({ autoReason: "code_inactive", blockedCodeIds: [codeId] });
    // Те саме значення коду — іншому партнеру: без дати початку діє з дня додавання; старіші замовлення лишаються за A.
    const b = await makePartner(env, {});
    const added = await addPartnerCode(ownerCtx(env, "2026-10-07T10:00:00Z"), { partnerId: b, source: "discount_code", code: "frozen" });
    expect(added).toMatchObject({ reused: true, validFrom: "2026-10-07", attributed: 0 });
    expect(await attrOf(open)).toMatchObject({ partnerId: a, status: "attributed" });
    expect(await attrOf(after)).toMatchObject({ status: "removed", partnerId: null });
    // Recognition of the open order later → accrual for A.
    await recognize(env, open, "2026-10-08");
    expect(await sync(env, open, recognized("2026-10-08"))).toMatchObject({ attribution: "attributed", partnerId: a, events: 1 });
    // Нове замовлення з дня дії нового коду — партнеру B.
    const fresh = await insertOrder(env.handle.db, { placedAt: "2026-10-08T10:00:00Z" });
    await setFacts(env.handle.db, fresh, { discountCodes: ["FROZEN"] });
    expect(await sync(env, fresh)).toMatchObject({ attribution: "attributed", partnerId: b });
  });

  it("review: pausing / archiving a partner keeps attributions already made; orders placed during the pause stay unattributed after reactivation", async () => {
    const p = await makePartner(env, { codes: [{ source: "discount_code", code: "PAUSE1" }] });
    const o = await g1Order(env, "PAUSE1");
    await setFinance(env.handle.db, o, { state: "open" });
    expect(await sync(env, o)).toMatchObject({ attribution: "attributed", partnerId: p, component: { state: "forecast", hasForecast: true } });
    const detail = async () => (await getPartnerDetail(ownerCtx(env, NOW), p))!.partner;
    const setStatus = async (status: "active" | "paused" | "archived", at: string) => {
      const cur = await detail();
      await updatePartner(ownerCtx(env, at), { id: p, expectedVersion: cur.version, displayName: cur.displayName, kind: cur.kind, status, holdDays: cur.holdDays });
    };
    await setStatus("paused", "2026-10-06T10:00:00Z");
    // Визнання під час паузи — нарахування (атрибуція ухвалена, коли партнер був активний).
    await recognize(env, o, "2026-10-07");
    expect(await sync(env, o, recognized("2026-10-07"))).toMatchObject({ attribution: "attributed", partnerId: p, events: 1, component: { state: "actual" } });
    expect((await eventsOf(env.handle.db, o))[0]).toMatchObject({ kind: "accrual", amount: "11.70", recognizedOn: "2026-10-07" });
    // Замовлення, оформлене під час паузи, — не атрибутується, і реактивація цього не змінює.
    const during = await g1Order(env, "PAUSE1");
    await setFinance(env.handle.db, during, { state: "open" });
    expect(await sync(env, during)).toMatchObject({ attribution: "removed", partnerId: null });
    expect((await attrOf(during))!.details).toMatchObject({ autoReason: "partner_inactive" });
    await setStatus("active", "2026-10-10T10:00:00Z");
    await recognize(env, during, "2026-10-11");
    expect(await sync(env, during, recognized("2026-10-11"))).toMatchObject({ attribution: "removed", events: 0 });
    // Нове замовлення після реактивації — атрибутується.
    const next = await g1Order(env, "PAUSE1");
    await setFinance(env.handle.db, next, { state: "open" });
    expect(await sync(env, next)).toMatchObject({ attribution: "attributed", partnerId: p });
    // Архів: ухвалена атрибуція відкритого замовлення лишається й нараховується при визнанні.
    await setStatus("archived", "2026-10-12T10:00:00Z");
    await recognize(env, next, "2026-10-13");
    expect(await sync(env, next, recognized("2026-10-13"))).toMatchObject({ attribution: "attributed", partnerId: p, events: 1 });
  });

  it("review: the rate and hold days are fixed in the attribution — a back-dated rate or new hold days do not re-price it", async () => {
    const p = await makePartner(env, { rateBp: 1000, holdDays: 30, codes: [{ source: "discount_code", code: "FIXRATE" }] });
    const o = await g1Order(env, "FIXRATE");
    await setFinance(env.handle.db, o, { state: "open" });
    await sync(env, o);
    expect(await attrOf(o)).toMatchObject({ rateBp: 1000, holdDays: 30 });
    await addPartnerRate(ownerCtx(env, "2026-10-06T10:00:00Z"), { partnerId: p, rateBp: 2000, effectiveFrom: "2026-10-01", reason: "Нові умови" });
    const cur = (await getPartnerDetail(ownerCtx(env, NOW), p))!.partner;
    await updatePartner(ownerCtx(env, "2026-10-06T11:00:00Z"), { id: p, expectedVersion: cur.version, displayName: cur.displayName, kind: cur.kind, status: "active", holdDays: 90 });
    expect(await sync(env, o)).toMatchObject({ attribution: "attributed", component: { state: "forecast" } });
    expect(await attrOf(o)).toMatchObject({ rateBp: 1000, holdDays: 30 });
    expect(await getOrderPartner(ownerCtx(env, NOW), o)).toMatchObject({ expected: { amount: "11.70" } });
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    expect((await eventsOf(env.handle.db, o))[0]).toMatchObject({ rateBp: 1000, amount: "11.70", holdUntil: "2026-11-04" });
    // Нове замовлення (з тієї ж дати) — нові умови.
    const n = await g1Order(env, "FIXRATE");
    await setFinance(env.handle.db, n, { state: "open" });
    await sync(env, n);
    expect(await attrOf(n)).toMatchObject({ rateBp: 2000, holdDays: 90 });
  });

  it("review: an adjustment caused by the owner's decision is dated by the decision, not by an older return", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "REDATE" }] });
    const o = await g1Order(env, "REDATE");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    await addSale(env.handle.db, o, { kind: "return", lineType: "PRODUCT", total: "-45.00", happenedAt: "2026-11-04T09:00:00Z" });
    await sync(env, o, { now: new Date("2026-11-05T10:00:00Z") });
    await setOrderAttribution(ownerCtx(env, "2026-11-20T10:00:00Z"), { orderId: o, mode: "manual", partnerId: null, reason: "Помилка" });
    await setOrderAttribution(ownerCtx(env, "2026-11-25T10:00:00Z"), { orderId: o, mode: "auto", reason: "Повернути" });
    expect((await eventsOf(env.handle.db, o)).map((e) => [e.n, e.kind, e.amount, e.recognizedOn, e.holdUntil])).toEqual([
      [1, "accrual", "11.70", "2026-10-05", "2026-11-04"],
      [2, "adjustment", "-4.50", "2026-11-04", null],
      [3, "cancellation", "-7.20", "2026-11-20", null],
      [4, "adjustment", "7.20", "2026-11-25", "2026-12-25"],
    ]);
    // Нове повернення після цього — датою повернення.
    await addSale(env.handle.db, o, { kind: "return", lineType: "PRODUCT", total: "-27.00", happenedAt: "2026-11-26T09:00:00Z" });
    await sync(env, o, { now: new Date("2026-11-28T10:00:00Z") });
    expect((await eventsOf(env.handle.db, o))[4]).toMatchObject({ kind: "adjustment", amount: "-2.70", recognizedOn: "2026-11-26" });
  });

  it("review: a lost dispute without an amount → no event, component missing (dispute_amount_unknown, not «dispute open»); amount entered → adjustment dated the decision", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "DISPNULL" }] });
    const o = await g1Order(env, "DISPNULL");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    const d = await addDispute(env.handle.db, o, { outcome: "lost", amount: null, decidedOn: "2026-11-12" });
    const pending = await sync(env, o);
    expect(pending).toMatchObject({ events: 0, component: { state: "missing", reason: "dispute_amount_unknown", required: true } });
    expect(pending.review).toEqual([]);
    expect(await eventsOf(env.handle.db, o)).toHaveLength(1);
    await env.handle.db.update(orderDisputes).set({ amount: "129.00", recoveredAmount: "0.00" }).where(eq(orderDisputes.id, d));
    expect(await sync(env, o)).toMatchObject({ events: 1, component: { state: "actual" }, review: [] });
    expect((await eventsOf(env.handle.db, o))[1]).toMatchObject({ kind: "cancellation", amount: "-11.70", recognizedOn: "2026-11-12" });
  });

  it("review: «cancel the commission fully» on a lost dispute works without the dispute amount", async () => {
    await makePartner(env, { codes: [{ source: "discount_code", code: "DISPFULL" }] });
    const o = await g1Order(env, "DISPFULL");
    await recognize(env, o, "2026-10-05");
    await sync(env, o, recognized("2026-10-05"));
    await addDispute(env.handle.db, o, { outcome: "lost", amount: null, decidedOn: "2026-11-12", full: true });
    expect(await sync(env, o)).toMatchObject({ events: 1, component: { state: "actual" } });
    expect((await eventsOf(env.handle.db, o))[1]).toMatchObject({ kind: "cancellation", amount: "-11.70", base: "0.00", recognizedOn: "2026-11-12" });
  });

  it("adding a code attributes orders already read from Shopify (not the owner's manual decisions)", async () => {
    const o1 = await g1Order(env, "LATECODE");
    const o2 = await g1Order(env, "latecode");
    const manual = await g1Order(env, "LATECODE");
    for (const o of [o1, o2, manual]) await setFinance(env.handle.db, o, { state: "open" });
    await setOrderAttribution(ownerCtx(env, NOW), { orderId: manual, mode: "manual", partnerId: null, reason: "Без партнера" });
    const p = await makePartner(env, {});
    const r = await addPartnerCode(ownerCtx(env, NOW), { partnerId: p, source: "discount_code", code: "LateCode" });
    expect(r.attributed).toBe(2);
    expect(await attrOf(o1)).toMatchObject({ partnerId: p, status: "attributed" });
    expect(await attrOf(manual)).toMatchObject({ source: "owner", status: "removed" });
    const logs = await env.handle.db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, r.id));
    expect(logs[0]).toMatchObject({ entityType: "partner_code", action: "create" });
    expect(logs[0]!.after).toMatchObject({ code: "LATECODE", source: "discount_code", active: true, partnerId: p });
    const audits = await env.handle.db.select().from(auditLog).where(eq(auditLog.entityId, r.id));
    expect(JSON.stringify(audits)).not.toMatch(/Демо-партнер/);
  });
});

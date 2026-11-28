/**
 * Етап 6, WP1: обмін валюти й курсова різниця (§5.7, §10.4, §14.5; золотий G4). Один запис fx_difference у валюті
 * отримання, recognized_on = fx_on = дата обміну, ключ fxconv:<id>:v<n>; без точного курсу на дату — відмова (запасний
 * не приймається); той самий operationId — один обмін; нульова різниця — без запису; анулювання — сторно (сума = 0);
 * зміна курсу дати — перерахунок новою версією; закритий місяць — відмова; працівник — 403.
 */
import { and, count, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeEntries, fxConversions, fxRates } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { fromMinor, toMinor } from "~/lib/decimal";
import { createFxConversion, listFxConversions, voidFxConversion } from "~/modules/fx/conversions.server";
import { saveManualRate, voidManualRate } from "~/modules/fx/manual-rates.server";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { ALL_20261120, closeMonth, EUR_RANGE, fixtureRows, prodCtx } from "./helpers";

let env: TestEnv;
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  const db = env.handle.db;
  await storeOfficialRates(db, fixtureRows(ALL_20261120, { from: "2026-11-20", to: "2026-11-20" }), { fetchedAt: new Date(), mode: "production" });
  await storeOfficialRates(db, fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }), { fetchedAt: new Date(), mode: "production" });
});
afterAll(async () => {
  await env.close();
});

const entriesOf = (id: string) => env.handle.db.select().from(financeEntries).where(and(eq(financeEntries.sourceType, "fx_conversion"), eq(financeEntries.sourceId, id))).orderBy(financeEntries.seq);
const net = async (id: string) => fromMinor((await entriesOf(id)).reduce((a, e) => a + toMinor(e.amount), 0n));
const G4 = { occurredOn: "2026-11-27", soldAmount: "1 000,00", soldCurrency: "EUR", boughtAmount: "48650", boughtCurrency: "UAH" };

describe("G4 — exchange difference", () => {
  let id = "";
  const op = randomUUID();

  it("1 000,00 EUR → 48 650,00 UAH on 27.11.2026 at NBU 49,4942 → −844,20 UAH as one fx_difference entry", async () => {
    const r = await createFxConversion(prodCtx(env), { operationId: op, ...G4, note: "Обмін у банку" });
    id = r.id;
    expect(r).toMatchObject({
      duplicate: false,
      version: 1,
      occurredOn: "2026-11-27",
      expected: { amount: "49494.20", currency: "UAH" },
      difference: { amount: "-844.20", currency: "UAH" },
      rates: { sold: { currency: "EUR", ratePerUnit: "49.4942", source: "nbu" }, bought: { currency: "UAH", source: "base" } },
    });
    const es = await entriesOf(id);
    expect(es).toHaveLength(1);
    expect(es[0]).toMatchObject({
      idempotencyKey: `fxconv:${id}:v1`,
      category: "fx_difference",
      amount: "-844.20",
      currency: "UAH",
      recognizedOn: "2026-11-27",
      fxOn: "2026-11-27",
      originalOn: "2026-11-27",
      sourceType: "fx_conversion",
      postedBy: OWNER.id,
      isLate: false,
    });
    expect(es[0]!.details).toMatchObject({ soldCurrency: "EUR", boughtCurrency: "UAH", soldRate: "49.4942", boughtRate: "1", counterparty: "bank" });
    const [row] = await env.handle.db.select().from(fxConversions).where(eq(fxConversions.id, id));
    expect(row).toMatchObject({ soldAmount: "1000.00", boughtAmount: "48650.00", status: "active", version: 1, operationId: op, createdBy: OWNER.id, note: "Обмін у банку" });
    const [log] = await env.handle.db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, id));
    expect(log).toMatchObject({ entityType: "fx_conversion", action: "create" });
    expect(log!.after).toMatchObject({ difference: "-844.20", differenceCurrency: "UAH", status: "active", version: 1, soldAmount: "1000.00" });
  });

  it("the same operationId twice → one exchange and one entry", async () => {
    const again = await createFxConversion(prodCtx(env), { operationId: op, ...G4 });
    expect(again).toMatchObject({ id, duplicate: true, difference: { amount: "-844.20", currency: "UAH" }, expected: { amount: "49494.20" } });
    const [n] = await env.handle.db.select({ c: count() }).from(fxConversions).where(eq(fxConversions.operationId, op));
    expect(Number(n!.c)).toBe(1);
    expect(await entriesOf(id)).toHaveLength(1);
  });

  it("a new manual rate for the date reprices the exchange (reversal + v2); voiding it reprices back (v3)", async () => {
    const r = await saveManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-27", rate: "49,5", reason: "Курс банку", expectedVersion: 0 });
    expect(r.repricedConversions).toBe(1);
    expect(await net(id)).toBe("-850.00");
    let es = await entriesOf(id);
    expect(es.map((e) => e.idempotencyKey)).toEqual([`fxconv:${id}:v1`, `fxconv:${id}:v1:rev`, `fxconv:${id}:v2`]);
    expect(es[1]).toMatchObject({ amount: "844.20", fxOn: "2026-11-27" });
    const back = await voidManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-27", reason: "Помилка", expectedVersion: 1 });
    expect(back.repricedConversions).toBe(1);
    expect(await net(id)).toBe("-844.20");
    es = await entriesOf(id);
    expect(es.at(-1)!.idempotencyKey).toBe(`fxconv:${id}:v3`);
    const [row] = await env.handle.db.select().from(fxConversions).where(eq(fxConversions.id, id));
    expect(row!.version).toBe(3);
  });

  it("void needs a reason, reverses the difference (net 0), is idempotent; the list shows no difference for it", async () => {
    await expect(voidFxConversion(prodCtx(env), { id, reason: "" })).rejects.toMatchObject({ code: "financeFx.error.reasonRequired" });
    await expect(voidFxConversion(prodCtx(env), { id, reason: "x", expectedVersion: 1 })).rejects.toMatchObject({ code: "error.conflict" });
    expect(await voidFxConversion(prodCtx(env), { id, reason: "Дубль", expectedVersion: 3 })).toEqual({ voided: true, reversed: 1 });
    expect(await net(id)).toBe("0.00");
    expect(await voidFxConversion(prodCtx(env), { id, reason: "Дубль" })).toEqual({ voided: false, reversed: 0 });
    const list = await listFxConversions(prodCtx(env));
    expect(list.find((c) => c.id === id)).toMatchObject({ status: "voided", difference: null, expected: "49494.20" });
  });
});

describe("rates and inputs", () => {
  it("cross pair: EUR → USD at the NBU rates of the date (no pre-rounded cross); the entry is in the received currency", async () => {
    const r = await createFxConversion(prodCtx(env), {
      operationId: randomUUID(),
      occurredOn: "2026-11-20",
      soldAmount: "100",
      soldCurrency: "EUR",
      boughtAmount: "110,00",
      boughtCurrency: "USD",
      counterparty: "payment_provider",
    });
    expect(r).toMatchObject({ expected: { amount: "109.94", currency: "USD" }, difference: { amount: "0.06", currency: "USD" } });
    expect((await entriesOf(r.id))[0]).toMatchObject({ amount: "0.06", currency: "USD", category: "fx_difference" });
  });

  it("a zero difference saves the exchange without an entry; the list shows a known 0.00", async () => {
    const r = await createFxConversion(prodCtx(env), { operationId: randomUUID(), occurredOn: "2026-11-27", soldAmount: "100", soldCurrency: "EUR", boughtAmount: "4949.42", boughtCurrency: "UAH" });
    expect(r.difference).toEqual({ amount: "0.00", currency: "UAH" });
    expect(await entriesOf(r.id)).toHaveLength(0);
    expect((await listFxConversions(prodCtx(env))).find((c) => c.id === r.id)).toMatchObject({ status: "active", difference: "0.00", expected: "4949.42" });
  });

  it("no exact rate on the date → refusal (a fallback is not accepted); future date; input errors", async () => {
    const ctx = prodCtx(env);
    const op = () => randomUUID();
    // USD є лише на 20.11 — 21.11 був би лише запасний курс.
    await expect(createFxConversion(ctx, { operationId: op(), occurredOn: "2026-11-21", soldAmount: "10", soldCurrency: "USD", boughtAmount: "400", boughtCurrency: "UAH" })).rejects.toMatchObject({
      code: "finance.error.noRate",
      params: { currency: "USD", date: "2026-11-21" },
    });
    await expect(createFxConversion(ctx, { operationId: op(), occurredOn: "2026-11-29", soldAmount: "10", soldCurrency: "EUR", boughtAmount: "400", boughtCurrency: "UAH" })).rejects.toMatchObject({
      code: "financeFx.error.dateInFuture",
    });
    const base = { occurredOn: "2026-11-27", soldCurrency: "EUR", boughtCurrency: "UAH" };
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldAmount: "10", boughtAmount: "400", boughtCurrency: "EUR" })).rejects.toMatchObject({ code: "financeFx.error.sameCurrency" });
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldAmount: "0", boughtAmount: "400" })).rejects.toMatchObject({ code: "financeFx.error.amountNotPositive" });
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldAmount: "-10", boughtAmount: "400" })).rejects.toMatchObject({ code: "financeFx.error.amountNotPositive" });
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldAmount: "1.000,5", boughtAmount: "400" })).rejects.toMatchObject({ code: "finance.error.amountAmbiguous" });
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldCurrency: "JPY", soldAmount: "100,50", boughtAmount: "400" })).rejects.toMatchObject({ code: "finance.error.amountWholeUnits" });
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldCurrency: "KWD", soldAmount: "10", boughtAmount: "400" })).rejects.toMatchObject({ code: "finance.error.unsupportedCurrency" });
    await expect(createFxConversion(ctx, { operationId: "not-a-uuid", ...base, soldAmount: "10", boughtAmount: "400" })).rejects.toMatchObject({ code: "financeFx.error.operationInvalid" });
    await expect(createFxConversion(ctx, { operationId: op(), ...base, soldAmount: "10", boughtAmount: "400", counterparty: "cash" })).rejects.toMatchObject({ code: "financeFx.error.counterpartyInvalid" });
  });

  it("voiding a manual rate that an exchange depends on (no other exact rate) is refused and rolled back", async () => {
    const ctx = prodCtx(env);
    await saveManualRate(ctx, { currency: "ISK", effectiveDate: "2026-11-25", rate: "0.3" });
    const c = await createFxConversion(ctx, { operationId: randomUUID(), occurredOn: "2026-11-25", soldAmount: "1000", soldCurrency: "ISK", boughtAmount: "290", boughtCurrency: "UAH" });
    expect(c.difference).toEqual({ amount: "-10.00", currency: "UAH" });
    await expect(voidManualRate(ctx, { currency: "ISK", effectiveDate: "2026-11-25", reason: "x" })).rejects.toMatchObject({
      code: "financeFx.error.rateUsedByConversion",
      params: { currency: "ISK", date: "2026-11-25" },
    });
    const [m] = await env.handle.db.select().from(fxRates).where(and(eq(fxRates.source, "manual"), eq(fxRates.currency, "ISK"), eq(fxRates.effectiveDate, "2026-11-25")));
    expect(m!.isCurrent).toBe(true);
  });
});

describe("access and closed months", () => {
  it("staff and a forged staff actor get 403 on create, void and list", async () => {
    for (const actor of [STAFF, FORGED]) {
      await expect(createFxConversion(prodCtx(env, actor), { operationId: randomUUID(), ...G4 })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(voidFxConversion(prodCtx(env, actor), { id: randomUUID(), reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(listFxConversions(prodCtx(env, actor))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("a date in a closed month is refused for create and void", async () => {
    const ctx = prodCtx(env);
    const open = await createFxConversion(ctx, { operationId: randomUUID(), occurredOn: "2026-11-19", soldAmount: "10", soldCurrency: "EUR", boughtAmount: "490", boughtCurrency: "UAH" });
    await closeMonth(env.handle.db, "2026-11-01");
    await expect(createFxConversion(ctx, { operationId: randomUUID(), ...G4 })).rejects.toMatchObject({ code: "finance.error.monthClosed", params: { month: "2026-11-01" } });
    await expect(voidFxConversion(ctx, { id: open.id, reason: "x" })).rejects.toMatchObject({ code: "finance.error.monthClosed" });
  });
});

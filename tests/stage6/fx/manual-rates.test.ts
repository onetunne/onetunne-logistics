/**
 * Етап 6, WP1: ручні курси з версіями (§5.3, §3.4, F6, F8). Власник (finance.manage + owner); працівник і підроблений
 * актор → 403 без запису. Причина обов'язкова, якщо на дату є автоматичний курс або це виправлення. Нова версія робить
 * попередню не поточною; той самий курс — повтор без версії; CAS; закритий місяць — відмова. Кожна зміна — історія змін
 * з кількістю зачеплених записів (дата й дати, де курс був запасним) і Δ прибутку у валюті звітності (без memo), зокрема
 * коли змінено курс самої валюти звітності. Після збереження — completeFxPendingLayers (WP2) у тій самій транзакції.
 * Подвійне надсилання форм (та сама очікувана версія) — «без змін», не хибний конфлікт; анулювання в закритому місяці —
 * відмова.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, financeChangeLog, fxRates } from "~/db/schema";
import { ForbiddenError, makeActor, SYSTEM_ACTOR } from "~/domain/permissions";
import { postEntries } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { saveManualRate, voidManualRate } from "~/modules/fx/manual-rates.server";
import { rateFor } from "~/modules/fx/rate-for.server";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { closeMonth, prodCtx } from "./helpers";

const pending = vi.hoisted(() => ({ calls: [] as Array<{ currency?: string; date?: string }> }));
vi.mock("~/modules/costing/fx-pending.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("~/modules/costing/fx-pending.server")>();
  return {
    ...orig,
    completeFxPendingLayers: async (...args: Parameters<typeof orig.completeFxPendingLayers>) => {
      pending.calls.push(args[2]);
      return orig.completeFxPendingLayers(...args);
    },
  };
});

let env: TestEnv;
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
const P = { mode: "production" as const };

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  const db = env.handle.db;
  await storeOfficialRates(
    db,
    [
      { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.5335", units: 1, setOn: "2026-11-19" },
      { currency: "EUR", effectiveDate: "2026-11-10", rate: "49", units: 1, setOn: null },
      { currency: "USD", effectiveDate: "2026-11-10", rate: "45", units: 1, setOn: null },
      { currency: "USD", effectiveDate: "2026-11-20", rate: "45.0532", units: 1, setOn: null },
    ],
    { fetchedAt: new Date(), mode: "production" },
  );
  await db.transaction((tx) =>
    postEntries(tx, SYSTEM_ACTOR, [
      makeEntryInput({ idempotencyKey: "t:e1", category: "sales_product", amount: "100.00", currency: "EUR", recognizedOn: "2026-11-20", fxOn: "2026-11-20" }),
      makeEntryInput({ idempotencyKey: "t:e2", category: "payment_fees", amount: "-5.00", currency: "EUR", recognizedOn: "2026-11-20", fxOn: "2026-11-20" }),
      makeEntryInput({ idempotencyKey: "t:e3", category: "discount_memo", amount: "10.00", currency: "EUR", recognizedOn: "2026-11-20", fxOn: "2026-11-20" }),
      makeEntryInput({ idempotencyKey: "t:e4", category: "sales_product", amount: "50.00", currency: "EUR", recognizedOn: "2026-11-22", fxOn: "2026-11-22" }),
      makeEntryInput({ idempotencyKey: "t:e5", category: "sales_product", amount: "200.00", currency: "USD", recognizedOn: "2026-11-20", fxOn: "2026-11-20" }),
      makeEntryInput({ idempotencyKey: "t:e6", category: "sales_product", amount: "1000.00", currency: "UAH", recognizedOn: "2026-11-10", fxOn: "2026-11-10" }),
      makeEntryInput({ idempotencyKey: "t:e7", category: "sales_product", amount: "100.00", currency: "USD", recognizedOn: "2026-11-10", fxOn: "2026-11-10" }),
      makeEntryInput({ idempotencyKey: "t:e8", category: "sales_product", amount: "10.00", currency: "EUR", recognizedOn: "2026-11-10", fxOn: "2026-11-10" }),
    ]),
  );
});
afterAll(async () => {
  await env.close();
});

const changes = (entityId: string) =>
  env.handle.db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "fx_rate"), eq(financeChangeLog.entityId, entityId))).orderBy(financeChangeLog.id);
const manualRows = (currency: string, date: string) =>
  env.handle.db
    .select()
    .from(fxRates)
    .where(and(eq(fxRates.source, "manual"), eq(fxRates.currency, currency), eq(fxRates.effectiveDate, date)))
    .orderBy(fxRates.version);

describe("access (F8)", () => {
  it("staff and a forged staff actor are refused and nothing is written", async () => {
    for (const actor of [STAFF, FORGED]) {
      await expect(saveManualRate(prodCtx(env, actor), { currency: "EUR", effectiveDate: "2026-11-20", rate: "50", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(voidManualRate(prodCtx(env, actor), { currency: "EUR", effectiveDate: "2026-11-20", reason: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await manualRows("EUR", "2026-11-20")).toHaveLength(0);
  });
});

describe("versions, reasons, history with affected entries and Δ", () => {
  it("over an NBU rate the reason is required; v1 affects the date and the dates where it was the fallback; Δ excludes memo", async () => {
    const ctx = prodCtx(env);
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", rate: "49,6335" })).rejects.toMatchObject({ code: "financeFx.error.reasonRequired" });
    pending.calls.length = 0;
    const r = await saveManualRate(ctx, { currency: "eur", effectiveDate: "2026-11-20", rate: "49,6335", reason: "Курс банку за випискою", expectedVersion: 0 });
    // E1 +10,00; E2 −0,50 (−247,67 → −248,17); E4 (22.11, запасний 20.11) +5,00; E3 — memo (зачеплено, без Δ); USD — ні.
    expect(r).toMatchObject({ duplicate: false, currency: "EUR", effectiveDate: "2026-11-20", version: 1, affectedEntries: 4, deltaReporting: "14.50", reportingCurrency: "UAH" });
    expect(pending.calls).toEqual([{ currency: "EUR" }]);
    expect(await rateFor(env.handle.db, "EUR", "2026-11-20", P)).toMatchObject({ source: "manual", ratePerUnit: "49.6335", version: 1, fallback: false });
    expect(await rateFor(env.handle.db, "EUR", "2026-11-22", P)).toMatchObject({ source: "manual", rateDate: "2026-11-20", fallback: true });
    const log = await changes("EUR:2026-11-20");
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ action: "create", actorId: OWNER.id, actorRole: "owner", reason: "Курс банку за випискою" });
    expect(log[0]!.before).toEqual({ currency: "EUR", quoteCurrency: "UAH", effectiveDate: "2026-11-20", ratePerUnit: "49.5335", source: "nbu", rateVersion: 1 });
    expect(log[0]!.after).toEqual({
      currency: "EUR",
      quoteCurrency: "UAH",
      effectiveDate: "2026-11-20",
      rate: "49.6335",
      units: 1,
      ratePerUnit: "49.6335",
      source: "manual",
      rateVersion: 1,
      affectedEntries: 4,
      deltaReporting: "14.50",
      reportingCurrency: "UAH",
    });
    const [audit] = await env.handle.db.select({ c: count() }).from(auditLog).where(eq(auditLog.action, "finance.fx_rate_saved"));
    expect(Number(audit!.c)).toBe(1);
  });

  it("the same rate again is a repeat (no version); a stale expectedVersion is a conflict", async () => {
    const ctx = prodCtx(env);
    expect(await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.633500", reason: "again", expectedVersion: 1 })).toMatchObject({ duplicate: true, version: 1 });
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.7", reason: "x", expectedVersion: 0 })).rejects.toMatchObject({ code: "error.conflict" });
    expect(await manualRows("EUR", "2026-11-20")).toHaveLength(1);
  });

  it("a correction needs a reason, becomes v2, the previous version stays in history (not current)", async () => {
    const ctx = prodCtx(env);
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.7335", expectedVersion: 1 })).rejects.toMatchObject({ code: "financeFx.error.reasonRequired" });
    const r = await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.7335", reason: "Виправлено", expectedVersion: 1 });
    // Δ відносно v1: E1 +10,00; E2 −0,50; E4 +5,00.
    expect(r).toMatchObject({ version: 2, affectedEntries: 4, deltaReporting: "14.50" });
    const rows = await manualRows("EUR", "2026-11-20");
    expect(rows.map((x) => [x.version, x.isCurrent, x.rate])).toEqual([
      [1, false, "49.633500"],
      [2, true, "49.733500"],
    ]);
    expect(rows[1]!.enteredBy).toBe(OWNER.id);
    const log = await changes("EUR:2026-11-20");
    expect(log.map((l) => l.action)).toEqual(["create", "update"]);
    expect(log[1]!.before).toMatchObject({ source: "manual", rateVersion: 1, ratePerUnit: "49.6335" });
  });

  it("void needs a reason, restores the automatic rate, writes history; voiding again → not found", async () => {
    const ctx = prodCtx(env);
    await expect(voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", reason: "  " })).rejects.toMatchObject({ code: "financeFx.error.reasonRequired" });
    await expect(voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", reason: "x", expectedVersion: 1 })).rejects.toMatchObject({ code: "error.conflict" });
    const r = await voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", reason: "Помилка", expectedVersion: 2 });
    expect(r).toMatchObject({ version: 2, affectedEntries: 4, deltaReporting: "-29.00" });
    expect(await rateFor(env.handle.db, "EUR", "2026-11-20", P)).toMatchObject({ source: "nbu", ratePerUnit: "49.5335" });
    expect((await manualRows("EUR", "2026-11-20")).every((x) => !x.isCurrent)).toBe(true);
    const log = await changes("EUR:2026-11-20");
    expect(log.at(-1)).toMatchObject({ action: "void", reason: "Помилка" });
    expect(log.at(-1)!.after).toMatchObject({ source: "nbu", ratePerUnit: "49.5335", affectedEntries: 4, deltaReporting: "-29.00" });
    await expect(voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", reason: "x" })).rejects.toMatchObject({ code: "error.notFound" });
    // Після анулювання нова ручна версія — v3 (версії не повторюються).
    expect(await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-20", rate: "49.5", reason: "знову", expectedVersion: 0 })).toMatchObject({ version: 3 });
  });

  it("a first manual rate without an automatic one needs no reason; JPY per 10 units", async () => {
    const ctx = prodCtx(env);
    expect(await saveManualRate(ctx, { currency: "ISK", effectiveDate: "2026-11-21", rate: "0,3012" })).toMatchObject({ version: 1, affectedEntries: 0, deltaReporting: "0.00" });
    const r = await saveManualRate(ctx, { currency: "JPY", effectiveDate: "2026-11-21", rate: "2,818", units: "10" });
    expect(r.version).toBe(1);
    const [row] = await manualRows("JPY", "2026-11-21");
    expect(row).toMatchObject({ rate: "2.818000", units: 10, ratePerUnit: "0.2818000000" });
  });

  it("changing the reporting currency's own rate affects entries in every other currency on that date", async () => {
    const ctx = prodCtx(env);
    expect((await saveFinanceSettings(ctx, { reportingCurrency: "EUR" })).ok).toBe(true);
    try {
      const r = await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-10", rate: "50", reason: "звітність у EUR" });
      // 1 000 UAH: 20,41 → 20,00; 100 USD: 91,84 → 90,00 (EUR-запис не зачеплено) → Δ −2,25 EUR.
      expect(r).toMatchObject({ affectedEntries: 2, deltaReporting: "-2.25", reportingCurrency: "EUR" });
    } finally {
      expect((await saveFinanceSettings(ctx, { reportingCurrency: "UAH" })).ok).toBe(true);
    }
  });
});

describe("double submit of the forms (same expected version posted twice)", () => {
  it("saving the same form twice → the second is a repeat (no version, no history), not a false conflict", async () => {
    const ctx = prodCtx(env);
    const form = { currency: "EUR", effectiveDate: "2026-11-24", rate: "49,6", reason: "Курс банку", expectedVersion: 0 };
    expect(await saveManualRate(ctx, form)).toMatchObject({ duplicate: false, version: 1 });
    expect(await saveManualRate(ctx, form)).toMatchObject({ duplicate: true, version: 1, affectedEntries: 0, deltaReporting: "0.00" });
    expect(await manualRows("EUR", "2026-11-24")).toHaveLength(1);
    expect((await changes("EUR:2026-11-24")).map((l) => l.action)).toEqual(["create"]);
    // Інше значення зі старою версією — як і раніше конфлікт.
    await expect(saveManualRate(ctx, { ...form, rate: "49,7" })).rejects.toMatchObject({ code: "error.conflict" });
  });

  it("voiding the same version twice → the second is «already voided» (nothing changed); an unknown version → not found", async () => {
    const ctx = prodCtx(env);
    const form = { currency: "EUR", effectiveDate: "2026-11-24", reason: "Помилка", expectedVersion: 1 };
    expect(await voidManualRate(ctx, form)).toMatchObject({ duplicate: false, version: 1 });
    const logAfterFirst = await changes("EUR:2026-11-24");
    expect(await voidManualRate(ctx, form)).toMatchObject({ duplicate: true, version: 1, affectedEntries: 0, deltaReporting: "0.00", repricedConversions: 0 });
    expect(await changes("EUR:2026-11-24")).toHaveLength(logAfterFirst.length);
    expect((await manualRows("EUR", "2026-11-24")).map((r) => [r.version, r.isCurrent])).toEqual([[1, false]]);
    await expect(voidManualRate(ctx, { ...form, expectedVersion: 2 })).rejects.toMatchObject({ code: "error.notFound" });
    await expect(voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-24", reason: "x" })).rejects.toMatchObject({ code: "error.notFound" });
  });
});

describe("refusals", () => {
  it("voiding a manual rate dated in a closed month is refused; the rate stays current, no history", async () => {
    const ctx = prodCtx(env);
    expect(await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-09-15", rate: "48,1" })).toMatchObject({ duplicate: false, version: 1 });
    await closeMonth(env.handle.db, "2026-09-01");
    await expect(voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-09-15", reason: "Помилка", expectedVersion: 1 })).rejects.toMatchObject({
      code: "finance.error.monthClosed",
      params: { month: "2026-09-01" },
    });
    expect((await manualRows("EUR", "2026-09-15")).map((r) => [r.version, r.isCurrent])).toEqual([[1, true]]);
    expect((await changes("EUR:2026-09-15")).map((l) => l.action)).toEqual(["create"]);
    expect(await rateFor(env.handle.db, "EUR", "2026-09-15", P)).toMatchObject({ source: "manual", ratePerUnit: "48.1" });
  });

  it("closed month, base currency, unsupported currency, far future date, invalid rate", async () => {
    const ctx = prodCtx(env);
    await closeMonth(env.handle.db, "2026-10-01");
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-10-15", rate: "48", reason: "x" })).rejects.toMatchObject({
      code: "finance.error.monthClosed",
      params: { month: "2026-10-01" },
    });
    expect(await manualRows("EUR", "2026-10-15")).toHaveLength(0);
    await expect(saveManualRate(ctx, { currency: "UAH", effectiveDate: "2026-11-20", rate: "1" })).rejects.toMatchObject({ code: "financeFx.error.currencyBase" });
    await expect(saveManualRate(ctx, { currency: "KWD", effectiveDate: "2026-11-20", rate: "150" })).rejects.toMatchObject({ code: "finance.error.unsupportedCurrency" });
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-12-06", rate: "50", reason: "x" })).rejects.toMatchObject({ code: "financeFx.error.dateTooFar" });
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-02-30", rate: "50", reason: "x" })).rejects.toMatchObject({ code: "financeFx.error.dateInvalid" });
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-25", rate: "1.234,5", reason: "x" })).rejects.toMatchObject({ code: "financeFx.error.rateAmbiguous" });
    await expect(saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-25", rate: "50", units: 7, reason: "x" })).rejects.toMatchObject({ code: "financeFx.error.unitsInvalid" });
  });

  it("in the demo the automatic source is demo: a demo row requires a reason, an NBU row does not", async () => {
    const db = env.handle.db;
    await db.insert(fxRates).values({ source: "demo", currency: "GBP", effectiveDate: "2026-11-24", rate: "56.5", units: 1, ratePerUnit: "56.5" });
    const demo = { ...env.ctx(OWNER), now: () => new Date("2026-11-28T10:00:00Z") };
    await expect(saveManualRate(demo, { currency: "GBP", effectiveDate: "2026-11-24", rate: "56.6" })).rejects.toMatchObject({ code: "financeFx.error.reasonRequired" });
    expect(await saveManualRate(demo, { currency: "USD", effectiveDate: "2026-11-20", rate: "45.1" })).toMatchObject({ version: 1 });
  });
});

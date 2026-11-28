/**
 * Етап 6, WP1: Δ і кількість зачеплених записів зміни курсу, коли зміна перераховує курсову різницю обміну цієї дати
 * (§5.3 «з кількістю зачеплених записів … і Δ у валюті звітності», F6). Перевірка — незалежним підрахунком: Δ =
 * Σ(усі записи прибутку після зміни за поточними курсами їхнього fx_on) − Σ(те саме до зміни), у гривнях.
 * Випадки: різниця у валюті, що не змінювалася (продано EUR, отримано UAH), і у валюті, курс якої змінився (продано
 * UAH, отримано EUR), — і для нової версії, і для анулювання.
 */
import { and, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeEntries } from "~/db/schema";
import { FINANCE_CATEGORY_DEFS, isFinanceCategory } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { fromMinor, toMinor } from "~/lib/decimal";
import { postEntries } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { createFxConversion } from "~/modules/fx/conversions.server";
import { convertAmount, UAH_SCALED_RATE } from "~/modules/fx/convert";
import { saveManualRate, voidManualRate } from "~/modules/fx/manual-rates.server";
import { rateFor } from "~/modules/fx/rate-for.server";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { EUR_RANGE, fixtureRows, prodCtx } from "./helpers";

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  await storeOfficialRates(env.handle.db, fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }), { fetchedAt: new Date(), mode: "production" });
});
afterAll(async () => {
  await env.close();
});

/** Незалежно: Σ усіх записів прибутку (без memo) у гривнях за поточним курсом fx_on (rateFor). */
async function profitUah(): Promise<bigint> {
  const rows = await env.handle.db.select().from(financeEntries);
  let sum = 0n;
  for (const e of rows) {
    if (!isFinanceCategory(e.category) || FINANCE_CATEGORY_DEFS[e.category].kind === "memo") continue;
    const r = await rateFor(env.handle.db, e.currency, e.fxOn, { mode: "production" });
    if (!r.ok) continue;
    sum += toMinor(convertAmount(e.amount, e.currency, "UAH", r.scaled, UAH_SCALED_RATE));
  }
  return sum;
}

const rateLog = async (entityId: string) =>
  (await env.handle.db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "fx_rate"), eq(financeChangeLog.entityId, entityId))).orderBy(financeChangeLog.id)).at(-1);

describe("Δ of a rate change includes the repriced exchange difference", () => {
  it("difference in another currency (1 000 EUR → 48 650 UAH): save +494,20 UAH over 3 entries; void −494,20", async () => {
    const ctx = prodCtx(env);
    const c = await createFxConversion(ctx, { operationId: randomUUID(), occurredOn: "2026-11-27", soldAmount: "1000", soldCurrency: "EUR", boughtAmount: "48650", boughtCurrency: "UAH" });
    expect(c.difference).toEqual({ amount: "-844.20", currency: "UAH" });

    const p0 = await profitUah();
    const saved = await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-27", rate: "49,0000", reason: "Курс банку", expectedVersion: 0 });
    const p1 = await profitUah();
    // −844,20 → −350,00 (за 49,0000): сторно v1, нова v2 → Δ = +494,20; зачеплено v1, v1:rev, v2.
    expect(fromMinor(p1 - p0)).toBe("494.20");
    expect(saved).toMatchObject({ repricedConversions: 1, affectedEntries: 3, deltaReporting: "494.20", reportingCurrency: "UAH" });
    expect((await rateLog("EUR:2026-11-27"))!.after).toMatchObject({ affectedEntries: 3, deltaReporting: "494.20", reportingCurrency: "UAH" });

    const voided = await voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-27", reason: "Помилка", expectedVersion: 1 });
    const p2 = await profitUah();
    expect(fromMinor(p2 - p1)).toBe("-494.20");
    expect(voided).toMatchObject({ duplicate: false, repricedConversions: 1, affectedEntries: 3, deltaReporting: "-494.20" });
    expect((await rateLog("EUR:2026-11-27"))!.after).toMatchObject({ affectedEntries: 3, deltaReporting: "-494.20" });
  });

  it("difference in the changed currency (49 000 UAH → 1 000 EUR) plus another EUR entry: Δ is the full change", async () => {
    const ctx = prodCtx(env);
    await env.handle.db.transaction((tx) =>
      postEntries(tx, SYSTEM_ACTOR, [makeEntryInput({ idempotencyKey: "t:imp:sale", category: "sales_product", amount: "100.00", currency: "EUR", recognizedOn: "2026-11-26", fxOn: "2026-11-26" })]),
    );
    const c = await createFxConversion(ctx, { operationId: randomUUID(), occurredOn: "2026-11-26", soldAmount: "49000", soldCurrency: "UAH", boughtAmount: "1000", boughtCurrency: "EUR" });
    // НБУ 49,5346: очікувано 989,21 EUR → +10,79 EUR.
    expect(c).toMatchObject({ expected: { amount: "989.21", currency: "EUR" }, difference: { amount: "10.79", currency: "EUR" } });

    const p0 = await profitUah();
    const saved = await saveManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-26", rate: "49", reason: "Курс банку", expectedVersion: 0 });
    const p1 = await profitUah();
    // Різниця за 49,0000 = 0 → лише сторно (−10,79 EUR): −534,48; продаж 100 EUR: 4 953,46 → 4 900,00 = −53,46.
    expect(fromMinor(p1 - p0)).toBe("-587.94");
    expect(saved).toMatchObject({ repricedConversions: 1, affectedEntries: 3, deltaReporting: "-587.94" });

    const voided = await voidManualRate(ctx, { currency: "EUR", effectiveDate: "2026-11-26", reason: "Помилка", expectedVersion: 1 });
    const p2 = await profitUah();
    // Назад до НБУ: нова v3 +10,79 EUR (534,48) і продаж +53,46 → +587,94; зачеплено продаж, v1, v1:rev, v3.
    expect(fromMinor(p2 - p1)).toBe("587.94");
    expect(voided).toMatchObject({ repricedConversions: 1, affectedEntries: 4, deltaReporting: "587.94" });
  });
});

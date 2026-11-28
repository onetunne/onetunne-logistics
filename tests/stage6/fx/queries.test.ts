/**
 * Етап 6, WP1: requireFinance у КОЖНІЙ функції читання сторінки курсів (§14.1 «не лише в loader», §14.2 «працівник →
 * 403»). Сервіси викликаються напряму (без loader): працівник і підроблений актор з наданими finance.view /
 * finance.manage → ForbiddenError; власник отримує дані (зокрема Δ прибутку версій ручних курсів).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { saveManualRate } from "~/modules/fx/manual-rates.server";
import { getCheckoutRatesView, getNbuState, listManualRateVersions, listRateCurrencies, listRateMatrix } from "~/modules/fx/queries.server";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import { createTestEnv, STAFF, type TestEnv } from "../../helpers";
import { EUR_RANGE, fixtureRows, prodCtx } from "./helpers";

let env: TestEnv;
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  await storeOfficialRates(env.handle.db, fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }), { fetchedAt: new Date(), mode: "production" });
  await saveManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-20", rate: "49,6", reason: "Курс банку", expectedVersion: 0 });
});
afterAll(async () => {
  await env.close();
});

const READS = {
  listRateMatrix: (ctx: ReturnType<typeof prodCtx>) => listRateMatrix(ctx, { from: "2026-11-18", to: "2026-11-27", currencies: ["EUR"] }),
  listRateCurrencies: (ctx: ReturnType<typeof prodCtx>) => listRateCurrencies(ctx),
  listManualRateVersions: (ctx: ReturnType<typeof prodCtx>) => listManualRateVersions(ctx, {}),
  getNbuState: (ctx: ReturnType<typeof prodCtx>) => getNbuState(ctx),
  getCheckoutRatesView: (ctx: ReturnType<typeof prodCtx>) => getCheckoutRatesView(ctx),
};

describe("read services of the rates page check access themselves (F8)", () => {
  for (const [name, read] of Object.entries(READS)) {
    it(`${name}: staff and a forged staff actor → ForbiddenError`, async () => {
      for (const actor of [STAFF, FORGED]) await expect(read(prodCtx(env, actor)), `${name} / ${actor.id}`).rejects.toBeInstanceOf(ForbiddenError);
    });
  }

  it("the owner gets the data", async () => {
    const ctx = prodCtx(env);
    const matrix = await READS.listRateMatrix(ctx);
    expect(matrix.rows.find((r) => r.date === "2026-11-20")!.cells.EUR!.effective).toMatchObject({ source: "manual", ratePerUnit: "49.6" });
    expect(await READS.listRateCurrencies(ctx)).toEqual(["EUR"]);
    const versions = await READS.listManualRateVersions(ctx);
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ currency: "EUR", effectiveDate: "2026-11-20", version: 1, isCurrent: true, affectedEntries: 0, deltaReporting: "0.00", reportingCurrency: "UAH" });
    expect(await READS.getNbuState(ctx)).toMatchObject({ available: true, enabled: false, latestNbuDate: "2026-11-30" });
    expect(await READS.getCheckoutRatesView(ctx)).toHaveProperty("rates");
  });
});

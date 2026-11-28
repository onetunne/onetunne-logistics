/**
 * Етап 6 (інтеграційний раунд ядра): режим курсів для внутрішніх потоків без режиму запиту (хук оцінки WP2,
 * syncOrderFinance WP4, coveringStatusForOrder WP6) — app/modules/finance/core/rate-mode.server.ts.
 * - Робочий сервер (не Vitest, DEMO_MODE вимкнено) → ЗАВЖДИ production, навіть якщо в базі є рядок fx_rates.source =
 *   demo: оцінка в іноземній валюті з одним лише демо-курсом — «немає курсу», ніколи не демо-курс.
 * - Демо-сервер і тести → demo за наявністю демо-курсів (поведінка раунду 1 без змін), інакше production.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fxRates } from "~/db/schema";
import { resetEnvCache } from "~/lib/env.server";
import { convertToValuation, costingRateMode, loadCostingContext } from "~/modules/costing/inputs.server";
import { demoRatesAllowed, resolveRateMode } from "~/modules/finance/core/rate-mode.server";
import { createTestEnv, type TestEnv } from "../../helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

/** Процес «робочого сервера»: не Vitest, DEMO_MODE вимкнено. */
function asProductionServer() {
  vi.stubEnv("VITEST", "");
  vi.stubEnv("DEMO_MODE", "false");
  resetEnvCache();
}

describe("resolveRateMode", () => {
  it("demo server / tests: demo iff the database has demo rates", async () => {
    const db = env.handle.db;
    expect(demoRatesAllowed()).toBe(true);
    expect(await resolveRateMode(db)).toBe("production");
    await db.insert(fxRates).values({ source: "demo", currency: "EUR", quoteCurrency: "UAH", effectiveDate: "2026-11-02", rate: "48.0000", units: 1, ratePerUnit: "48.0000" });
    expect(await resolveRateMode(db)).toBe("demo");
    expect(await costingRateMode(db)).toBe("demo");
    expect(await resolveRateMode(db, { demoAllowed: false })).toBe("production");
  });

  it("production server: always production from the server settings, whatever the tables hold — demo rates are never used", async () => {
    const db = env.handle.db;
    // Демо-курс у базі (попередній тест) — у демо/тестах він діє.
    const demoCtx = await loadCostingContext(db, { valuationCurrency: "UAH" });
    expect(demoCtx.rateMode).toBe("demo");
    expect(await convertToValuation(db, demoCtx, 1000n, "EUR", "2026-11-02")).toMatchObject({ ok: true, minor: 48000n, rateSource: "demo" });
    asProductionServer();
    expect(demoRatesAllowed()).toBe(false);
    expect(await resolveRateMode(db)).toBe("production");
    expect(await costingRateMode(db)).toBe("production");
    const prodCtx = await loadCostingContext(db, { valuationCurrency: "UAH" });
    expect(prodCtx.rateMode).toBe("production");
    expect(await convertToValuation(db, prodCtx, 1000n, "EUR", "2026-11-02")).toEqual({ ok: false, reason: "no_rate" });
    // DEMO_MODE на сервері — знову за вмістом бази.
    vi.stubEnv("DEMO_MODE", "true");
    resetEnvCache();
    expect(demoRatesAllowed()).toBe(true);
    expect(await resolveRateMode(db)).toBe("demo");
  });
});

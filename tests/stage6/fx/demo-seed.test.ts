/**
 * Етап 6, WP1: заповнення демо-курсів для WP11 (§5.8, §19 п. 2): лише демо; ідемпотентно (повтор нічого не додає);
 * source = demo — автоматичне джерело лише в демо-режимі (робочий режим їх не бачить); дві ручні версії EUR (v2 діє).
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fxRates } from "~/db/schema";
import { addDays } from "~/lib/periods";
import { DEMO_MANUAL_RATE_REASONS, DEMO_RATE_SPECS, demoRateOn } from "~/modules/fx/demo-rates";
import { seedDemoRates } from "~/modules/fx/demo-rates.server";
import { listRateMatrix } from "~/modules/fx/queries.server";
import { rateFor } from "~/modules/fx/rate-for.server";
import { createTestEnv, OWNER, type TestEnv } from "../../helpers";
import { prodCtx } from "./helpers";

let env: TestEnv;
const NOW = new Date("2026-11-28T10:00:00Z");
const TODAY = "2026-11-28";

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

describe("seedDemoRates", () => {
  it("demo only; inserts [today − 420, today + 7] × 4 currencies and two manual EUR versions; a repeat adds nothing", async () => {
    await expect(seedDemoRates(prodCtx(env))).rejects.toMatchObject({ code: "finance.error.demoOnly" });
    const demo = { ...env.ctx(OWNER), now: () => NOW };
    expect(await seedDemoRates(demo)).toEqual({ inserted: 428 * 4, manual: 2 });
    expect(await seedDemoRates(demo)).toEqual({ inserted: 0, manual: 0 });
    // Наступного дня додається лише новий день (значення наявних дат ті самі).
    expect(await seedDemoRates({ ...demo, now: () => new Date("2026-11-29T10:00:00Z") })).toEqual({ inserted: 4, manual: 0 });
    const [n] = await env.handle.db.select({ c: count() }).from(fxRates).where(eq(fxRates.source, "demo"));
    expect(Number(n!.c)).toBe(429 * 4);
  });

  it("demo rates are the automatic source in the demo only; the manual v2 wins on its date", async () => {
    const db = env.handle.db;
    const demo = { mode: "demo" as const };
    expect(await rateFor(db, "EUR", TODAY, demo)).toMatchObject({ ok: true, source: "demo", fallback: false, ratePerUnit: demoRateOn(DEMO_RATE_SPECS[0]!, TODAY) });
    expect(await rateFor(db, "PLN", addDays(TODAY, -420), demo)).toMatchObject({ ok: true, source: "demo" });
    expect(await rateFor(db, "EUR", TODAY, { mode: "production" })).toMatchObject({ ok: false, reason: "no_rate" });
    const manualDate = addDays(TODAY, -14);
    const r = await rateFor(db, "EUR", manualDate, demo);
    expect(r).toMatchObject({ ok: true, source: "manual", version: 2 });
    const rows = await db.select().from(fxRates).where(and(eq(fxRates.source, "manual"), eq(fxRates.currency, "EUR"))).orderBy(fxRates.version);
    expect(rows.map((x) => [x.version, x.isCurrent, x.reason])).toEqual([
      [1, false, DEMO_MANUAL_RATE_REASONS[0]],
      [2, true, DEMO_MANUAL_RATE_REASONS[1]],
    ]);
    const m = await listRateMatrix({ ...env.ctx(OWNER) }, { from: addDays(TODAY, -15), to: addDays(TODAY, -13), currencies: ["EUR"] });
    expect(m.automaticSource).toBe("demo");
    const cell = m.rows.find((x) => x.date === manualDate)!.cells.EUR!;
    expect(cell.effective).toMatchObject({ source: "manual", version: 2 });
    expect(cell.automatic).toMatchObject({ units: 1 });
    expect(cell.manual).toMatchObject({ version: 2 });
  });
});

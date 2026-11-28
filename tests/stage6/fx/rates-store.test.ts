/**
 * Етап 6, WP1: збереження курсів НБУ (§5.3) і золотий випадок G3 (§20.1) на рядках із фактів через справжній розбір:
 * лише вставка й ідемпотентність; інше значення → рядок не змінюється + fx_rate_conflict (критична, без `issues`, I19);
 * вихідний — рядок НБУ з курсом п'ятниці; запасний ≤ 7 днів («курс за 20.11»); розрив 8 днів → «Без курсу», поза
 * сумами; новий рядок, що змінює сконвертовані записи, → історія змін з кількістю записів і Δ (F6).
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeDiscrepancies, fxRates, issues } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { fromMinor } from "~/lib/decimal";
import { postEntries } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { convertAmount, sumConverted, UAH_SCALED_RATE } from "~/modules/fx/convert";
import { rateFor } from "~/modules/fx/rate-for.server";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { ALL_20261120, EUR_RANGE, fixtureRows } from "./helpers";

let env: TestEnv;
const P = { mode: "production" as const };
const fetchedAt = new Date("2026-11-27T21:40:00Z");

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  const db = env.handle.db;
  await storeOfficialRates(db, fixtureRows(ALL_20261120, { from: "2026-11-20", to: "2026-11-20" }), { fetchedAt, mode: "production" });
  await storeOfficialRates(db, fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }), { fetchedAt, mode: "production" });
});
afterAll(async () => {
  await env.close();
});

async function scaled(currency: string, date: string): Promise<bigint> {
  const r = await rateFor(env.handle.db, currency, date, P);
  if (!r.ok) throw new Error(`no rate ${currency} ${date}`);
  return r.scaled;
}

describe("storeOfficialRates", () => {
  it("stores the published value, scale, per-unit rate and calcdate; only nbu rows, fetched_at set", async () => {
    const db = env.handle.db;
    const [huf] = await db.select().from(fxRates).where(and(eq(fxRates.currency, "HUF"), eq(fxRates.effectiveDate, "2026-11-20")));
    expect(huf).toMatchObject({ source: "nbu", quoteCurrency: "UAH", units: 100, setOn: "2026-11-19", version: 1, isCurrent: true });
    expect(huf!.rate).toBe("13.430800");
    expect(huf!.ratePerUnit).toBe("0.1343080000");
    expect(huf!.fetchedAt?.toISOString()).toBe(fetchedAt.toISOString());
    const [n] = await db.select({ c: count() }).from(fxRates);
    // 40 валют 20.11 + EUR 18–30.11 без 20.11 (уже був) = 40 + 12.
    expect(Number(n!.c)).toBe(52);
  });

  it("is insert-only and idempotent: a repeated fetch inserts nothing and opens no discrepancy", async () => {
    const db = env.handle.db;
    const again = await storeOfficialRates(db, fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }), { fetchedAt: new Date(), mode: "production" });
    expect(again).toMatchObject({ inserted: 0, unchanged: 13, conflicts: 0, insertedCurrencies: [] });
    const [d] = await db.select({ c: count() }).from(financeDiscrepancies);
    expect(Number(d!.c)).toBe(0);
  });

  it("a different value for a stored date keeps the row and opens one critical fx_rate_conflict (never an issue)", async () => {
    const db = env.handle.db;
    const [issuesBefore] = await db.select({ c: count() }).from(issues);
    const changed = [{ currency: "EUR", effectiveDate: "2026-11-20", rate: "49.6", units: 1, setOn: "2026-11-19" }];
    for (let i = 0; i < 2; i++) {
      const r = await storeOfficialRates(db, changed, { fetchedAt: new Date(), mode: "production" });
      expect(r).toMatchObject({ inserted: 0, conflicts: 1 });
    }
    // Той самий курс за одиницю в іншому масштабі — не конфлікт.
    expect(await storeOfficialRates(db, [{ currency: "EUR", effectiveDate: "2026-11-20", rate: "4953.35", units: 100, setOn: null }], { fetchedAt: new Date(), mode: "production" })).toMatchObject({
      conflicts: 0,
      unchanged: 1,
    });
    const [row] = await db.select().from(fxRates).where(and(eq(fxRates.source, "nbu"), eq(fxRates.currency, "EUR"), eq(fxRates.effectiveDate, "2026-11-20")));
    expect(row!.rate).toBe("49.533500");
    const ds = await db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.type, "fx_rate_conflict"));
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ severity: "critical", status: "open", dedupeKey: "fx_rate_conflict:nbu:EUR:2026-11-20" });
    expect(ds[0]!.details).toEqual({ currency: "EUR", effectiveDate: "2026-11-20", storedRate: "49.5335", storedUnits: 1, fetchedRate: "49.6", fetchedUnits: 1 });
    const [issuesAfter] = await db.select({ c: count() }).from(issues);
    expect(Number(issuesAfter!.c)).toBe(Number(issuesBefore!.c));
  });
});

describe("G3 — currencies with NBU rates from the facts (20.11.2026)", () => {
  it("100,00 EUR → 4 953,35 UAH, → 109,94 USD, → 36 880,53 HUF, → 17 578 JPY; 123 456,78 EUR → 135 733,90 USD; 1 000 JPY → 281,80 UAH", async () => {
    const d = "2026-11-20";
    const [EUR, USD, HUF, JPY] = [await scaled("EUR", d), await scaled("USD", d), await scaled("HUF", d), await scaled("JPY", d)];
    expect(convertAmount("100.00", "EUR", "UAH", EUR, UAH_SCALED_RATE)).toBe("4953.35");
    expect(convertAmount("100.00", "EUR", "USD", EUR, USD)).toBe("109.94");
    expect(convertAmount("100.00", "EUR", "HUF", EUR, HUF)).toBe("36880.53");
    expect(convertAmount("100.00", "EUR", "JPY", EUR, JPY)).toBe("17578.00");
    expect(convertAmount("0.64", "EUR", "JPY", EUR, JPY)).toBe("112.00");
    expect(convertAmount("123456.78", "EUR", "USD", EUR, USD)).toBe("135733.90");
    expect(convertAmount("1000.00", "JPY", "UAH", JPY, UAH_SCALED_RATE)).toBe("281.80");
  });

  it("Saturday 21.11 — the NBU row with Friday's rate (not a fallback); a manual table without 21.11 → «rate of 20.11»; an 8-day gap → no rate", async () => {
    const db = env.handle.db;
    const sat = await rateFor(db, "EUR", "2026-11-21", P);
    expect(sat).toMatchObject({ ok: true, source: "nbu", rateDate: "2026-11-21", fallback: false, ratePerUnit: "49.5335" });
    // Валюта лише з ручним курсом на 20.11 (ISK — НБУ її не публікує).
    await db.insert(fxRates).values({ source: "manual", currency: "ISK", effectiveDate: "2026-11-20", rate: "0.3", units: 1, ratePerUnit: "0.3", enteredBy: "test" });
    expect(await rateFor(db, "ISK", "2026-11-21", P)).toMatchObject({ ok: true, source: "manual", rateDate: "2026-11-20", fallback: true });
    expect(await rateFor(db, "ISK", "2026-11-27", P)).toMatchObject({ ok: true, fallback: true });
    expect(await rateFor(db, "ISK", "2026-11-28", P)).toEqual({ ok: false, currency: "ISK", date: "2026-11-28", reason: "no_rate" });
    // «Без курсу» — поза сумою, перелічено окремо (ніколи не 0).
    const sum = sumConverted(
      [
        { amount: "100.00", currency: "ISK", fxOn: "2026-11-28" },
        { amount: "100.00", currency: "EUR", fxOn: "2026-11-21" },
      ],
      "UAH",
      (c, d) => (c === "EUR" && d === "2026-11-21" && sat.ok ? sat.scaled : null),
    );
    expect(sum).toEqual({ total: "4953.35", converted: 1, unconverted: [{ currency: "ISK", amount: "100.00", entries: 1 }] });
  });
});

describe("holidays are data-driven (no holiday calendar)", () => {
  it("New Year 2026: 01.01 (Thursday) had its own rate; 03–04.01 repeat the rate set on 01.01; rows are stored as returned", async () => {
    const db = env.handle.db;
    const rows = fixtureRows("reconstructed-eur-new-year-2026.json", { from: "2025-12-29", to: "2026-01-05" });
    expect(rows.map((r) => [r.effectiveDate, r.rate, r.setOn])).toEqual([
      ["2025-12-29", "49.5552", "2025-12-26"],
      ["2025-12-30", "49.6525", "2025-12-29"],
      ["2025-12-31", "49.8565", "2025-12-30"],
      ["2026-01-01", "49.7947", "2025-12-31"],
      ["2026-01-02", "49.5499", "2026-01-01"],
      ["2026-01-03", "49.5499", "2026-01-01"],
      ["2026-01-04", "49.5499", "2026-01-01"],
      ["2026-01-05", "49.5794", "2026-01-02"],
    ]);
    expect(await storeOfficialRates(db, rows, { fetchedAt, mode: "production" })).toMatchObject({ inserted: 8, conflicts: 0 });
    expect(await rateFor(db, "EUR", "2026-01-01", P)).toMatchObject({ source: "nbu", fallback: false, ratePerUnit: "49.7947" });
    expect(await rateFor(db, "EUR", "2026-01-04", P)).toMatchObject({ source: "nbu", fallback: false, ratePerUnit: "49.5499" });
  });
});

describe("rate change history for NBU rows (F6)", () => {
  it("a new NBU row that replaces a fallback writes affected entries and Δ profit in the reporting currency (memo excluded from Δ)", async () => {
    const db = env.handle.db;
    await db.transaction((tx) =>
      postEntries(tx, SYSTEM_ACTOR, [
        makeEntryInput({ idempotencyKey: "test:fx:sale", category: "sales_product", amount: "100.00", currency: "EUR", recognizedOn: "2026-12-01", fxOn: "2026-12-01" }),
        makeEntryInput({ idempotencyKey: "test:fx:memo", category: "discount_memo", amount: "10.00", currency: "EUR", recognizedOn: "2026-12-01", fxOn: "2026-12-01" }),
      ]),
    );
    // До нового рядка діє запасний курс 30.11 (49,3532).
    expect(await rateFor(db, "EUR", "2026-12-01", P)).toMatchObject({ fallback: true, rateDate: "2026-11-30" });
    const r = await storeOfficialRates(db, [{ currency: "EUR", effectiveDate: "2026-12-01", rate: "50", units: 1, setOn: "2026-11-30" }], { fetchedAt: new Date(), mode: "production" });
    expect(r).toMatchObject({ inserted: 1, insertedCurrencies: ["EUR"] });
    const log = await db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "fx_rate"), eq(financeChangeLog.entityId, "EUR:2026-12-01")));
    expect(log).toHaveLength(1);
    // Δ = 100 × (50 − 49,3532) = +64,68 грн; запис «довідково» в Δ не входить, але зачеплений.
    expect(log[0]!.after).toMatchObject({ source: "nbu", affectedEntries: 2, deltaReporting: fromMinor(500000n - 493532n), reportingCurrency: "UAH", rate: "50", units: 1 });
    expect(log[0]!.actorId).toBe(SYSTEM_ACTOR.id);
    // Рядки без зачеплених записів (інші валюти/дати) історії не пишуть.
    const all = await db.select().from(financeChangeLog).where(eq(financeChangeLog.entityType, "fx_rate"));
    expect(all).toHaveLength(1);
  });

  it("in the demo the automatic source is demo — NBU rows never change converted values there (no history)", async () => {
    const db = env.handle.db;
    const r = await storeOfficialRates(db, [{ currency: "EUR", effectiveDate: "2026-12-02", rate: "50.1", units: 1, setOn: null }], { fetchedAt: new Date(), mode: "demo" });
    expect(r.inserted).toBe(1);
    const all = await db.select().from(financeChangeLog).where(eq(financeChangeLog.entityId, "EUR:2026-12-02"));
    expect(all).toHaveLength(0);
  });
});

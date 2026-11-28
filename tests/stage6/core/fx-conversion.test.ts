/**
 * Етап 6 (WP0): конвертація (§5.5) і вибір курсу (§5.4). I6 — SQL (sqlConvertMinor) = TS (convertMinor) на 10 000
 * випадків, зокрема валюти з 0 знаками JPY/KRW в обидва боки; на PGlite і (з TEST_DATABASE_URL) на PostgreSQL 16.
 * rateFor і sqlRateScaled — те саме правило (ручний на дату > автоматичний на дату > запасний ≤ N днів > немає).
 */
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fxRates } from "~/db/schema";
import { convertMinor, ratePerUnitScaled, scaledToDecimal } from "~/lib/decimal";
import { fakeRateLookup } from "~/modules/finance/core/fakes";
import { convertAmount, impliedRatio, sumConverted, UAH_SCALED_RATE } from "~/modules/fx/convert";
import { createRateResolver, rateFor, rateWindowOf } from "~/modules/fx/rate-for.server";
import { sqlConvertAmount, sqlConvertMinor, sqlRateScaled } from "~/modules/fx/sql";
import { createTestEnv, type TestEnv } from "../../helpers";

const P = (rate: string, units = 1) => ratePerUnitScaled(rate, units);
const EUR = P("49.5335");
const USD = P("45.0532");
const HUF = P("13.4308", 100);
const JPY = P("2.818", 10);

describe("convert.ts (pure, G3)", () => {
  it("golden conversions of §20.1 G3", () => {
    expect(convertAmount("100.00", "EUR", "UAH", EUR, UAH_SCALED_RATE)).toBe("4953.35");
    expect(convertAmount("100.00", "EUR", "USD", EUR, USD)).toBe("109.94");
    expect(convertAmount("100.00", "EUR", "HUF", EUR, HUF)).toBe("36880.53");
    expect(convertAmount("123456.78", "EUR", "USD", EUR, USD)).toBe("135733.90");
    expect(convertAmount("100.00", "EUR", "JPY", EUR, JPY)).toBe("17578.00");
    expect(convertAmount("0.64", "EUR", "JPY", EUR, JPY)).toBe("112.00");
    expect(convertAmount("1000.00", "JPY", "UAH", JPY, UAH_SCALED_RATE)).toBe("281.80");
    expect(convertAmount("12.30", "EUR", "EUR", 1n, 1n)).toBe("12.30");
    // Заокруглений крос 1,0994 дав би 135 728,38 — доказ, що кросу немає.
    expect(convertAmount("123456.78", "EUR", "USD", EUR, USD)).not.toBe("135728.38");
    expect(() => convertAmount("12.50", "JPY", "UAH", JPY, UAH_SCALED_RATE)).toThrow();
    expect(impliedRatio("86.40", "100.00")).toBe("0.8640");
  });

  it("G4: exchange difference 1 000,00 EUR → 48 650,00 UAH at NBU 49,4942 = −844,20 UAH", () => {
    const expected = convertAmount("1000.00", "EUR", "UAH", P("49.4942"), UAH_SCALED_RATE);
    expect(expected).toBe("49494.20");
    expect((4865000n - 4949420n).toString()).toBe("-84420");
  });

  it("sumConverted: one rounding per entry, then the sum; entries without a rate are listed, never 0", () => {
    const rates = fakeRateLookup({ EUR: { "2026-11-20": "49.5335" }, USD: { "2026-11-20": "45.0532" } });
    const r = sumConverted(
      [
        { amount: "0.01", currency: "EUR", fxOn: "2026-11-20" },
        { amount: "0.01", currency: "EUR", fxOn: "2026-11-20" },
        { amount: "100.00", currency: "UAH", fxOn: "2026-11-20" },
        { amount: "120.00", currency: "PLN", fxOn: "2026-11-20" },
        { amount: "-20.00", currency: "PLN", fxOn: "2026-11-21" },
        { amount: "5.00", currency: "EUR", fxOn: "2026-11-25" },
      ],
      "USD",
      rates,
    );
    // 0,01 EUR → 0,0109… → 0,01 USD (двічі); 100,00 UAH → 2,2196… → 2,22 USD; разом 2,24 (округлення на кожен запис).
    expect(r.converted).toBe(3);
    expect(r.total).toBe("2.24");
    expect(r.unconverted).toEqual([
      { currency: "EUR", amount: "5.00", entries: 1 },
      { currency: "PLN", amount: "100.00", entries: 2 },
    ]);
  });

  it("sumConverted: nothing convertible → total null (unknown, «—»), never a known 0.00 (F4); no entries / known zero → 0.00", () => {
    const none = () => null;
    expect(sumConverted([{ amount: "120.00", currency: "PLN", fxOn: "2026-11-20" }], "UAH", none)).toEqual({
      total: null,
      converted: 0,
      unconverted: [{ currency: "PLN", amount: "120.00", entries: 1 }],
    });
    expect(sumConverted([], "UAH", none)).toEqual({ total: "0.00", converted: 0, unconverted: [] });
    const rates = fakeRateLookup({ EUR: { "2026-11-20": "49.5335" } });
    const zero = sumConverted(
      [
        { amount: "10.00", currency: "EUR", fxOn: "2026-11-20" },
        { amount: "-10.00", currency: "EUR", fxOn: "2026-11-20" },
        { amount: "7.00", currency: "PLN", fxOn: "2026-11-20" },
      ],
      "UAH",
      rates,
    );
    expect(zero.total).toBe("0.00");
    expect(zero.converted).toBe(2);
  });
});

/** Детермінований генератор із зерном (без нової залежності, §20.2). */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("I6: SQL conversion = TS conversion", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ seed: false });
  });
  afterAll(async () => {
    await env.close();
  });

  it("10 000 random cases (0- and 2-decimal targets, JPY/KRW both ways, signs, extreme scales)", async () => {
    const r = rng(20261128);
    const cases: Array<{ a: bigint; px: bigint; py: bigint; dY: 0 | 2 }> = [];
    const pickRate = () => {
      const k = r();
      if (k < 0.15) return 10n ** 10n; // UAH
      if (k < 0.3) return P((r() * 0.5 + 0.01).toFixed(4), 10); // JPY-подібні
      if (k < 0.4) return P((r() * 0.04 + 0.001).toFixed(4), 1); // KRW-подібні
      if (k < 0.5) return P((r() * 20 + 1).toFixed(4), 100); // HUF, масштаб 100
      return P((r() * 80 + 0.5).toFixed(4), 1);
    };
    for (let i = 0; i < 10_000; i++) {
      const magnitude = 10 ** Math.floor(r() * 12);
      let a = BigInt(Math.floor(r() * magnitude)) * (r() < 0.3 ? -1n : 1n);
      const dY = r() < 0.4 ? 0 : 2;
      if (r() < 0.2) a = a - (a % 100n); // суми валют з 0 знаками (цілі одиниці)
      if (a === 0n) a = 1n;
      cases.push({ a, px: pickRate(), py: pickRate(), dY });
    }
    const CHUNK = 500;
    for (let i = 0; i < cases.length; i += CHUNK) {
      const chunk = cases.slice(i, i + CHUNK);
      for (const dY of [0, 2] as const) {
        const subset = chunk.filter((c) => c.dY === dY);
        if (subset.length === 0) continue;
        const values = sql.join(
          subset.map((c, j) => sql`(${j}::int, ${c.a.toString()}::numeric, ${c.px.toString()}::numeric, ${c.py.toString()}::numeric)`),
          sql`, `,
        );
        const expr = sqlConvertMinor(sql.raw("v.a"), sql.raw("v.px"), sql.raw("v.py"), dY);
        const result = await env.handle.db.execute(sql`select v.i, (${expr})::text as r from (values ${values}) as v(i, a, px, py) order by v.i`);
        const rows = ((result as { rows?: Array<{ i: number; r: string }> }).rows ?? (result as unknown as Array<{ i: number; r: string }>));
        expect(rows).toHaveLength(subset.length);
        for (const row of rows) {
          const c = subset[Number(row.i)]!;
          const ts = convertMinor(c.a, c.px, c.py, dY);
          if (BigInt(row.r.replace(/\.0+$/, "")) !== ts) throw new Error(`SQL ≠ TS: a=${c.a} px=${c.px} py=${c.py} dY=${dY}: ${row.r} vs ${ts}`);
        }
      }
    }
  });

  it("NULL rate → NULL (never 0)", async () => {
    const result = await env.handle.db.execute(sql`select (${sqlConvertMinor(sql`100::numeric`, sql`null::numeric`, sql`10000000000::numeric`, 2)})::text as r`);
    const rows = ((result as { rows?: Array<{ r: string | null }> }).rows ?? (result as unknown as Array<{ r: string | null }>));
    expect(rows[0]!.r).toBeNull();
  });
});

describe("rateFor (§5.4) and its SQL twin", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ seed: false });
    const row = (source: "nbu" | "manual" | "demo", currency: string, date: string, rate: string, extra: Partial<typeof fxRates.$inferInsert> = {}) => ({
      source,
      currency,
      effectiveDate: date,
      rate,
      units: 1,
      ratePerUnit: scaledToDecimal(ratePerUnitScaled(rate, 1), 10),
      ...extra,
    });
    await env.handle.db.insert(fxRates).values([
      row("nbu", "EUR", "2026-11-20", "49.5335"),
      row("nbu", "EUR", "2026-11-21", "49.5335"),
      row("manual", "EUR", "2026-11-21", "49.6000", { version: 1, isCurrent: false, reason: "old" }),
      row("manual", "EUR", "2026-11-21", "49.7000", { version: 2, isCurrent: true, reason: "bank" }),
      row("demo", "EUR", "2026-11-22", "40.0000"),
      row("manual", "PLN", "2026-11-20", "11.2000"),
      row("nbu", "USD", "2026-11-10", "45.0000"),
      { source: "nbu", currency: "HUF", effectiveDate: "2026-11-20", rate: "13.4308", units: 100, ratePerUnit: "0.134308" },
    ] as Array<typeof fxRates.$inferInsert>);
  });
  afterAll(async () => {
    await env.close();
  });

  const opts = { mode: "production" as const, fallbackDays: 7 };

  it("UAH is exactly 1; manual on the date beats NBU; NBU otherwise; fallback ≤ N days with a flag; else no rate", async () => {
    const db = env.handle.db;
    expect(await rateFor(db, "UAH", "2026-11-20", opts)).toMatchObject({ ok: true, ratePerUnit: "1", source: "base", fallback: false });
    expect(await rateFor(db, "EUR", "2026-11-20", opts)).toMatchObject({ ok: true, ratePerUnit: "49.5335", source: "nbu", fallback: false, rateDate: "2026-11-20" });
    expect(await rateFor(db, "EUR", "2026-11-21", opts)).toMatchObject({ ok: true, ratePerUnit: "49.7", source: "manual", version: 2, fallback: false });
    // Демо-рядок у робочому режимі не використовується; запасний — останній день із курсом.
    expect(await rateFor(db, "EUR", "2026-11-22", opts)).toMatchObject({ ok: true, ratePerUnit: "49.7", source: "manual", rateDate: "2026-11-21", fallback: true });
    expect(await rateFor(db, "EUR", "2026-11-22", { mode: "demo", fallbackDays: 7 })).toMatchObject({ ok: true, ratePerUnit: "40", source: "demo" });
    expect(await rateFor(db, "PLN", "2026-11-27", opts)).toMatchObject({ ok: true, fallback: true, rateDate: "2026-11-20" });
    expect(await rateFor(db, "PLN", "2026-11-28", opts)).toEqual({ ok: false, currency: "PLN", date: "2026-11-28", reason: "no_rate" });
    // Майбутні дати не припускаються: курсу «наперед» не беремо.
    expect(await rateFor(db, "USD", "2026-11-09", opts)).toMatchObject({ ok: false });
    expect(await rateFor(db, "HUF", "2026-11-20", opts)).toMatchObject({ ok: true, ratePerUnit: "0.134308", scaled: 1343080000n });
  });

  it("createRateResolver gives the same answers and records the rows used", async () => {
    const resolver = await createRateResolver(env.handle.db, { currencies: ["EUR", "PLN", "USD", "UAH"], from: "2026-11-01", to: "2026-11-30" }, opts);
    for (const [c, d] of [["EUR", "2026-11-21"], ["EUR", "2026-11-22"], ["PLN", "2026-11-28"], ["USD", "2026-11-12"], ["UAH", "2026-11-01"]] as const) {
      expect(resolver.rateFor(c, d), `${c} ${d}`).toEqual(await rateFor(env.handle.db, c, d, opts));
    }
    // EUR 21.11 і 22.11 (запасний) — той самий ручний рядок; кожен рядок fx_rates — один раз.
    expect(resolver.used().map((r) => `${r.currency}:${r.rateDate}`).sort()).toEqual(["EUR:2026-11-21", "USD:2026-11-10"]);
  });

  it("createRateResolver refuses a date outside its fx_on window or an unloaded currency (never a false «no rate»)", async () => {
    const db = env.handle.db;
    const resolver = await createRateResolver(db, { currencies: ["EUR"], from: "2026-12-01", to: "2026-12-05" }, opts);
    // Пізній запис / сторно: fx_on 20.11 раніше за період звіту — rateFor знаходить курс, вікно звіту — ні.
    expect((await rateFor(db, "EUR", "2026-11-20", opts)).ok).toBe(true);
    expect(() => resolver.rateFor("EUR", "2026-11-20")).toThrow(RangeError);
    expect(() => resolver.scaled("EUR", "2026-12-06")).toThrow(RangeError);
    expect(() => resolver.rateFor("PLN", "2026-12-02")).toThrow(RangeError);
    expect(resolver.rateFor("UAH", "2020-01-01")).toMatchObject({ ok: true, source: "base" });
    await expect(createRateResolver(db, { currencies: ["EUR"], from: "2026-12-05", to: "2026-12-01" }, opts)).rejects.toThrow(RangeError);
    // Вікно з записів (rateWindowOf): валюти записів + цільові, межі fx_on.
    const entries = [
      { currency: "EUR", fxOn: "2026-12-03" },
      { currency: "EUR", fxOn: "2026-11-20" },
      { currency: "PLN", fxOn: "2026-11-27" },
    ];
    const window = rateWindowOf(entries, ["USD"]);
    expect(window).toEqual({ currencies: ["EUR", "PLN", "USD"], from: "2026-11-20", to: "2026-12-03" });
    expect(rateWindowOf([])).toBeNull();
    const fromEntries = await createRateResolver(db, window!, opts);
    for (const e of entries) expect(fromEntries.rateFor(e.currency, e.fxOn), `${e.currency} ${e.fxOn}`).toEqual(await rateFor(db, e.currency, e.fxOn, opts));
  });

  it("sqlRateScaled / sqlConvertAmount follow the same rule", async () => {
    const dates = ["2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22", "2026-11-28"];
    for (const currency of ["EUR", "PLN", "USD", "UAH"]) {
      for (const date of dates) {
        const result = await env.handle.db.execute(
          sql`select (${sqlRateScaled(sql`${currency}`, sql`${date}`, opts)})::text as p, (${sqlConvertAmount(sql`100.00`, sql`${currency}`, sql`${date}`, "UAH", opts)})::text as uah`,
        );
        const row = (((result as { rows?: Array<{ p: string | null; uah: string | null }> }).rows ?? (result as unknown as Array<{ p: string | null; uah: string | null }>)))[0]!;
        const ts = await rateFor(env.handle.db, currency, date, opts);
        if (ts.ok) {
          expect(BigInt(row.p!.replace(/\.0+$/, "")), `${currency} ${date}`).toBe(ts.scaled);
          expect(row.uah, `${currency} ${date}`).toBe(convertAmount("100.00", currency, "UAH", ts.scaled, UAH_SCALED_RATE));
        } else {
          expect(row.p, `${currency} ${date}`).toBeNull();
          expect(row.uah, `${currency} ${date}`).toBeNull();
        }
      }
    }
  });
});

/**
 * Етап 6, WP1: паралельність на справжньому PostgreSQL (§20.3; лише з TEST_DATABASE_URL): повтор завдання НБУ й
 * дублікати рядків → один рядок на ключ, без помилок; паралельне інше значення → рядок не змінено, одна розбіжність;
 * той самий operationId обміну двічі (і більше) паралельно → один обмін і один запис; паралельні ручні версії з однією
 * очікуваною версією → одна збережена, решта — конфлікт; один поточний рядок. Обмін і зміна ручного курсу тієї самої
 * дати паралельно (обмін уже прочитав курс і чекає на вставку): збереження нового курсу чекає обмін і перераховує його
 * (проведена різниця = за поточним курсом), анулювання єдиного точного курсу — відмова (у обміну лишається курс).
 */
import { and, count, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeDiscrepancies, financeEntries, fxConversions, fxRates } from "~/db/schema";
import type { Db } from "~/db/client.server";
import { fromMinor, toMinor } from "~/lib/decimal";
import { createFxConversion, listFxConversions, type FxConversionResult } from "~/modules/fx/conversions.server";
import { saveManualRate, voidManualRate, type SaveManualRateResult, type VoidManualRateResult } from "~/modules/fx/manual-rates.server";
import { storeOfficialRates } from "~/modules/fx/rates-store.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { ALL_20261120, EUR_RANGE, fixtureRows, prodCtx } from "./helpers";

/** Сеансів, що чекають на блокування (таблиці, рядка або advisory) у цій базі. */
async function lockWaiters(db: Db): Promise<number> {
  const r = (await db.execute(sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`)) as unknown as { rows: Array<{ n: number }> };
  return Number(r.rows[0]?.n ?? 0);
}

async function waitUntil(cond: () => Promise<boolean> | boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/**
 * Третій сеанс тримає `LOCK TABLE fx_conversions IN SHARE MODE`: вставка обміну чекає (курси вже прочитано), а читання
 * сервісу курсу (SELECT … FOR UPDATE) — ні. Повертає функцію, що відпускає блокування й чекає кінця транзакції.
 */
async function holdConversionInserts(db: Db): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let taken!: () => void;
  const ready = new Promise<void>((r) => (taken = r));
  const tx = db.transaction(async (t) => {
    await t.execute(sql`lock table fx_conversions in share mode`);
    taken();
    await gate;
  });
  await ready;
  return async () => {
    release();
    await tx;
  };
}

type Tracked<T> = { promise: Promise<T>; settled: () => boolean };

function track<T>(p: Promise<T>): Tracked<T> {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  return { promise: p, settled: () => done };
}

describe.skipIf(!process.env.TEST_DATABASE_URL)("FX concurrency on PostgreSQL", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ seed: false });
  });
  afterAll(async () => {
    await env.close();
  });

  it("parallel repeats of the NBU fetch store each row once without errors", async () => {
    const rows = [...fixtureRows(ALL_20261120, { from: "2026-11-20", to: "2026-11-20" }), ...fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }).filter((r) => r.effectiveDate !== "2026-11-20")];
    const results = await Promise.all(Array.from({ length: 4 }, () => storeOfficialRates(env.handle.db, rows, { fetchedAt: new Date(), mode: "production" })));
    expect(results.reduce((a, r) => a + r.inserted, 0)).toBe(rows.length);
    expect(results.reduce((a, r) => a + r.conflicts, 0)).toBe(0);
    const [n] = await env.handle.db.select({ c: count() }).from(fxRates).where(eq(fxRates.source, "nbu"));
    expect(Number(n!.c)).toBe(rows.length);
  });

  it("parallel different values for a new date → one row, one discrepancy", async () => {
    const one = (rate: string) => [{ currency: "USD", effectiveDate: "2026-11-23", rate, units: 1, setOn: null }];
    await Promise.all(["45.1", "45.2", "45.3"].map((r) => storeOfficialRates(env.handle.db, one(r), { fetchedAt: new Date(), mode: "production" })));
    const rows = await env.handle.db.select().from(fxRates).where(and(eq(fxRates.currency, "USD"), eq(fxRates.effectiveDate, "2026-11-23")));
    expect(rows).toHaveLength(1);
    const [d] = await env.handle.db.select({ c: count() }).from(financeDiscrepancies).where(eq(financeDiscrepancies.dedupeKey, "fx_rate_conflict:nbu:USD:2026-11-23"));
    expect(Number(d!.c)).toBe(1);
  });

  it("the same operationId submitted in parallel → one exchange and one fx_difference entry", async () => {
    const op = randomUUID();
    const input = { operationId: op, occurredOn: "2026-11-27", soldAmount: "1000", soldCurrency: "EUR", boughtAmount: "48650", boughtCurrency: "UAH" };
    const res = await Promise.all(Array.from({ length: 4 }, () => createFxConversion(prodCtx(env), input)));
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    expect(res.every((r) => r.difference.amount === "-844.20")).toBe(true);
    const [c] = await env.handle.db.select({ c: count() }).from(fxConversions).where(eq(fxConversions.operationId, op));
    expect(Number(c!.c)).toBe(1);
    const [e] = await env.handle.db.select({ c: count() }).from(financeEntries).where(eq(financeEntries.sourceId, res[0]!.id));
    expect(Number(e!.c)).toBe(1);
  });

  it("parallel manual versions with the same expected version → exactly one saved, the others conflict", async () => {
    const settled = await Promise.allSettled(
      ["49.61", "49.62", "49.63"].map((rate) => saveManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-24", rate, reason: "паралельно", expectedVersion: 0 })),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled.filter((x) => x.status === "rejected")) expect((s as PromiseRejectedResult).reason).toMatchObject({ code: "error.conflict" });
    const rows = await env.handle.db.select().from(fxRates).where(and(eq(fxRates.source, "manual"), eq(fxRates.currency, "EUR"), eq(fxRates.effectiveDate, "2026-11-24")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version: 1, isCurrent: true });
  });
  it("an exchange in flight and a new manual rate for its date → the rate change waits and reprices it (difference at the final rate)", async () => {
    const db = env.handle.db;
    const release = await holdConversionInserts(db);
    let exchange: Tracked<FxConversionResult> | undefined;
    let rate: Tracked<SaveManualRateResult> | undefined;
    try {
      // 26.11: НБУ 49,5346 → обмін 1 000 EUR → 48 650 UAH читає курс і чекає на вставку.
      exchange = track(createFxConversion(prodCtx(env), { operationId: randomUUID(), occurredOn: "2026-11-26", soldAmount: "1000", soldCurrency: "EUR", boughtAmount: "48650", boughtCurrency: "UAH" }));
      await waitUntil(async () => (await lockWaiters(db)) >= 1, "exchange waits for its insert");
      rate = track(saveManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-26", rate: "49", reason: "Курс банку", expectedVersion: 0 }));
      // Виправлено: зміна курсу чекає блокування курсу дати, яке тримає обмін. (Без нього вона завершилася б одразу.)
      await waitUntil(async () => rate!.settled() || (await lockWaiters(db)) >= 2, "rate change waits or finishes");
    } finally {
      await release();
    }
    const c = await exchange!.promise;
    const r = await rate!.promise;
    expect(c.rates.sold).toMatchObject({ source: "nbu", ratePerUnit: "49.5346" });
    expect(r.repricedConversions).toBe(1);
    const net = (await db.select().from(financeEntries).where(eq(financeEntries.sourceId, c.id))).reduce((a, e) => a + toMinor(e.amount), 0n);
    // За чинним ручним курсом 49,0000: 48 650,00 − 49 000,00 = −350,00 UAH.
    expect(fromMinor(net)).toBe("-350.00");
    expect((await listFxConversions(prodCtx(env))).find((x) => x.id === c.id)).toMatchObject({ expected: "49000.00", difference: "-350.00" });
  });

  it("an exchange in flight and voiding the only exact rate of its date → the void waits and is refused", async () => {
    const db = env.handle.db;
    // 17.11: курсу НБУ немає — єдиний точний курс ручний.
    expect(await saveManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-17", rate: "49,3" })).toMatchObject({ version: 1 });
    const release = await holdConversionInserts(db);
    let exchange: Tracked<FxConversionResult> | undefined;
    let voiding: Tracked<VoidManualRateResult> | undefined;
    try {
      exchange = track(createFxConversion(prodCtx(env), { operationId: randomUUID(), occurredOn: "2026-11-17", soldAmount: "1000", soldCurrency: "EUR", boughtAmount: "48650", boughtCurrency: "UAH" }));
      await waitUntil(async () => (await lockWaiters(db)) >= 1, "exchange waits for its insert");
      voiding = track(voidManualRate(prodCtx(env), { currency: "EUR", effectiveDate: "2026-11-17", reason: "Помилка", expectedVersion: 1 }));
      await waitUntil(async () => voiding!.settled() || (await lockWaiters(db)) >= 2, "void waits or finishes");
    } finally {
      await release();
    }
    const c = await exchange!.promise;
    expect(c.difference).toEqual({ amount: "-650.00", currency: "UAH" });
    await expect(voiding!.promise).rejects.toMatchObject({ code: "financeFx.error.rateUsedByConversion" });
    const [m] = await db.select().from(fxRates).where(and(eq(fxRates.source, "manual"), eq(fxRates.currency, "EUR"), eq(fxRates.effectiveDate, "2026-11-17")));
    expect(m!.isCurrent).toBe(true);
    expect((await listFxConversions(prodCtx(env))).find((x) => x.id === c.id)).toMatchObject({ expected: "49300.00", difference: "-650.00" });
  });
});

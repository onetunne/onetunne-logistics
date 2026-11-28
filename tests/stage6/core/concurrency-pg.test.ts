/**
 * Етап 6 (WP0): паралельність ядра на справжньому PostgreSQL 16 (§20.3; TEST_DATABASE_URL, інакше пропускається):
 * - два паралельні postEntries з тим самим ключем → один рядок (унікальний індекс + ON CONFLICT DO NOTHING);
 * - закриття місяця (ексклюзивний FINANCE_PERIOD_LOCK) паралельно з проведенням, датованим цим місяцем → запис або до
 *   закриття (у місяці), або після — пізнім записом (датою проведення), ніколи «тихо» в закритий місяць;
 * - assertMonthOpen паралельно із закриттям → відмова або успіх до закриття;
 * - два великі postEntries з тими самими ключами в протилежному порядку → без взаємоблокування (40P01): рядки
 *   вставляються в порядку (store_id, idempotency_key);
 * - два паралельні repostEntries сторнованого факту → рівно одне нове покоління.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, financePeriods } from "~/db/schema";
import { assertMonthOpen } from "~/modules/finance/core/closed-month.server";
import { postEntries, repostEntries, reverseEntry } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { withGeneration } from "~/modules/finance/core/keys";
import { lockFinancePeriodExclusive } from "~/modules/finance/core/locks.server";
import { createTestEnv, type TestEnv } from "../../helpers";

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL: finance core concurrency", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv({ seed: false });
  });
  afterAll(async () => {
    await env.close();
  });

  it("the same idempotency key posted concurrently → exactly one row", async () => {
    const entry = makeEntryInput({ idempotencyKey: "pg:same:1" });
    const results = await Promise.all(Array.from({ length: 6 }, () => env.handle.db.transaction((tx) => postEntries(tx, { id: "w" }, [entry]))));
    expect(results.reduce((a, r) => a + r.inserted, 0)).toBe(1);
    const rows = await env.handle.db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, "pg:same:1"));
    expect(rows).toHaveLength(1);
  });

  it("closing a month while posting into it: never a silent entry in the closed month", async () => {
    const db = env.handle.db;
    const month = "2026-06-01";
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const closing = db.transaction(async (tx) => {
      await lockFinancePeriodExclusive(tx, "default", month);
      locked();
      await held;
      await tx.insert(financePeriods).values({ month, status: "closed", closedAt: new Date(), closedBy: "test" });
    });
    await lockedP;
    const posting = db.transaction((tx) => postEntries(tx, { id: "w" }, [makeEntryInput({ idempotencyKey: "pg:close:1", recognizedOn: "2026-06-15", fxOn: "2026-06-15" })], { now: new Date("2026-11-28T12:00:00Z") }));
    const manual = db.transaction((tx) => assertMonthOpen(tx, "2026-06-20")).then(
      () => "open",
      (e: { code?: string }) => e.code,
    );
    await new Promise((r) => setTimeout(r, 200));
    release();
    await closing;
    expect(await posting).toEqual({ inserted: 1, skipped: 0, skippedReversed: 0, late: 1 });
    expect(await manual).toBe("finance.error.monthClosed");
    const [row] = await db.select().from(financeEntries).where(and(eq(financeEntries.idempotencyKey, "pg:close:1")));
    expect(row).toMatchObject({ recognizedOn: "2026-11-28", originalOn: "2026-06-15", fxOn: "2026-06-15", isLate: true });
  });

  it("overlapping key sets in opposite orders never deadlock (deterministic insert order)", async () => {
    const db = env.handle.db;
    for (let round = 0; round < 3; round++) {
      const keys = Array.from({ length: 2000 }, (_, i) => `pg:order:${round}:${String(i).padStart(5, "0")}`);
      const asc = keys.map((k) => makeEntryInput({ idempotencyKey: k }));
      const desc = [...asc].reverse();
      const results = await Promise.allSettled([
        db.transaction((tx) => postEntries(tx, { id: "a" }, asc)),
        db.transaction((tx) => postEntries(tx, { id: "b" }, desc)),
      ]);
      const errors = results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason?.code ?? r.reason));
      expect(errors, `round ${round}`).toEqual([]);
      const inserted = results.reduce((a, r) => a + (r.status === "fulfilled" ? r.value.inserted : 0), 0);
      expect(inserted).toBe(2000);
    }
  });

  it("two concurrent repostEntries of a reversed fact → exactly one new generation", async () => {
    const db = env.handle.db;
    const entry = makeEntryInput({ idempotencyKey: "pg:repost:1", amount: "10.00" });
    await db.transaction((tx) => postEntries(tx, { id: "w" }, [entry]));
    const [orig] = await db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, "pg:repost:1"));
    await db.transaction((tx) => reverseEntry(tx, { id: "w" }, orig!.id));
    const results = await Promise.all(Array.from({ length: 4 }, () => db.transaction((tx) => repostEntries(tx, { id: "w" }, [entry]))));
    expect(results.reduce((a, r) => a + r.reposted, 0)).toBe(1);
    const g2 = await db.select().from(financeEntries).where(eq(financeEntries.idempotencyKey, withGeneration("pg:repost:1", 2)));
    expect(g2).toHaveLength(1);
  });
});

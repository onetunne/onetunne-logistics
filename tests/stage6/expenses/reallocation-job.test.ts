/**
 * Етап 6, WP6 (інтеграційний раунд ядра): завдання finance.expense_reallocate (§10.3, I16, §17.8/F10).
 * - Пізнє замовлення виміру й місяця суми періоду → awaiting_reallocation; enqueueExpenseReallocation (WP4, у транзакції
 *   синхронізації) ставить ОДНЕ завдання на суму (повтор — без дубля; у демо — нічого); обробник виконує ТОЙ САМИЙ
 *   перерахунок, що кнопка «Перерахувати розподіл», від SYSTEM_ACTOR → allocated (нова версія, частки, історія змін).
 * - Закриті місяці — як кнопка: місяць самої суми закрито → нічого не змінено (код month_closed, завдання завершено без
 *   повтору; кнопка відмовляє finance.error.monthClosed); частка замовлення, визнаного в закритому місяці, — пізній запис.
 * - PostgreSQL: завдання паралельно з синхронізаціями замовлень (FINO(X) → частки → постановка завдання) — без
 *   взаємоблокувань і дублів діючих часток.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, financeChangeLog, financeExpenses, fxRates, jobs } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { coveringStatusForOrder } from "~/modules/expenses/allocation.server";
import { createExpense, recalculateAllocation, type ExpenseInput } from "~/modules/expenses/expenses.server";
import { syncOrderExpenseEntries } from "~/modules/expenses/posting.server";
import { enqueueExpenseReallocation, runExpenseReallocation, scheduleNoRateRetry } from "~/modules/expenses/reallocation.server";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { createFinanceJobHandlers } from "~/modules/finance/jobs.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING, financeJobDedupe } from "~/modules/finance/jobs";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import type { TestEnv } from "../../helpers";
import { activeEntriesOf, closeMonthRow, ctxAt, insertOrder, op, openEnv, recognize, sumMinor } from "./helpers";

const NOW = "2026-12-03T10:00:00Z";

const fees = (over: Partial<ExpenseInput>): ExpenseInput => ({
  operationId: op(),
  category: "payment_fees",
  amount: "7,00",
  currency: "EUR",
  dateMode: "single",
  expenseDate: "2026-08-15",
  gateway: "job-gw",
  ...over,
});

function deps(env: TestEnv) {
  return { db: env.handle.db, serviceContext: () => ctxAt(env, NOW, SYSTEM_ACTOR, "production"), admin: async () => (async () => ({})) as never };
}

const reallocJobs = (env: TestEnv, expenseId: string) =>
  env.handle.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, FINANCE_JOB.expenseReallocate), eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(expenseId))));

/** Завдання «готове зараз» (відкладення 30 с) і один прохід обробника. */
async function runDue(env: TestEnv): Promise<void> {
  await env.handle.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.type, FINANCE_JOB.expenseReallocate));
  await runJobsOnce(env.handle.db, createFinanceJobHandlers(deps(env)));
}

describe("finance.expense_reallocate", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await openEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("late order → awaiting_reallocation → one queued job (duplicates deduped, demo none) → the job reallocates → allocated", async () => {
    const db = env.handle.db;
    const a = await insertOrder(db, { placedOn: "2026-08-03", gateway: "job-gw", state: "recognized", recognizedOn: "2026-08-04", forecasts: [{ component: "fees", amount: "3.00" }] });
    const e = await createExpense(ctxAt(env, "2026-08-15T10:00:00Z"), fees({}));
    const late = await insertOrder(db, { placedOn: "2026-08-25", gateway: "job-gw", state: "recognized", recognizedOn: "2026-08-26", forecasts: [{ component: "fees", amount: "4.00" }] });
    expect(await coveringStatusForOrder(db, late, { mode: "production" })).toMatchObject([{ expenseId: e.id, expenseVersion: 1, state: "awaiting_reallocation" }]);

    // У демо обробника завдань немає — нічого не ставиться (лишається кнопка): явний режим або демо-база з демо-курсами.
    expect(await db.transaction((tx) => enqueueExpenseReallocation(tx, late, { mode: "demo" }))).toEqual({ queued: 0, expenseIds: [] });
    const ROLLBACK = new Error("rollback");
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(fxRates).values({ source: "demo", currency: "PLN", quoteCurrency: "UAH", effectiveDate: "2026-08-01", rate: "11.0000", units: 1, ratePerUnit: "11.0000" });
        expect(await enqueueExpenseReallocation(tx, late)).toEqual({ queued: 0, expenseIds: [] });
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(await reallocJobs(env, e.id)).toHaveLength(0);
    // Як WP4: у транзакції синхронізації замовлення під FINO(late) — лише постановка.
    const first = await db.transaction(async (tx) => {
      await lockFinanceOrder(tx, late);
      return enqueueExpenseReallocation(tx, late, { mode: "production" });
    });
    expect(first).toEqual({ queued: 1, expenseIds: [e.id] });
    // Повтор (інша синхронізація того самого чи іншого замовлення суми) — те саме завдання, без дубля.
    expect(await db.transaction((tx) => enqueueExpenseReallocation(tx, late))).toEqual({ queued: 0, expenseIds: [e.id] });
    const statuses = await coveringStatusForOrder(db, late);
    expect(await enqueueExpenseReallocation(db, late, { statuses })).toEqual({ queued: 0, expenseIds: [e.id] });
    // Замовлення без суми, що чекає, — нічого.
    expect(await enqueueExpenseReallocation(db, a)).toEqual({ queued: 0, expenseIds: [] });
    const queued = await reallocJobs(env, e.id);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ status: "queued", payload: { expenseId: e.id } });
    expect(queued[0]!.runAt.getTime()).toBeGreaterThan(Date.now());

    await runDue(env);
    expect((await reallocJobs(env, e.id))[0]).toMatchObject({ status: "succeeded" });
    expect(await coveringStatusForOrder(db, late, { mode: "production" })).toEqual([{ component: "fees", category: "payment_fees", expenseId: e.id, expenseVersion: 2, state: "allocated" }]);
    expect(await coveringStatusForOrder(db, a, { mode: "production" })).toMatchObject([{ state: "allocated", expenseVersion: 2 }]);
    const [row] = await db.select().from(financeExpenses).where(eq(financeExpenses.id, e.id));
    expect(row!.version).toBe(2);
    const active = await activeEntriesOf(db, e.id);
    expect(active.map((x) => [x.orderId, x.amount, x.idempotencyKey.endsWith(":v2")]).sort()).toEqual(
      [
        [a, "-3.00", true],
        [late, "-4.00", true],
      ].sort(),
    );
    expect(sumMinor(active)).toBe(-700n);
    // Той самий слід, що кнопка: історія змін розподілу й журнал дій — від SYSTEM_ACTOR.
    const log = await db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "expense_allocation"), eq(financeChangeLog.entityId, e.id)));
    expect(log.filter((l) => l.action === "update")).toEqual([expect.objectContaining({ action: "update", actorId: "system", actorRole: "owner" })]);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "finance.expense_reallocated"));
    expect(audit.some((x) => x.actorId === "system")).toBe(true);
    // Повторний запуск — нічого не змінює (той самий розподіл).
    expect(await runExpenseReallocation(db, SYSTEM_ACTOR, e.id, { mode: "production", now: new Date(NOW) })).toMatchObject({ status: "unchanged", allocatedOrders: 2 });
    expect((await db.select().from(financeExpenses).where(eq(financeExpenses.id, e.id)))[0]!.version).toBe(2);
  });

  it("closed months exactly as the button: the expense's own month closed → no change, no retry (the button refuses too); a share recognized in a closed month → a late entry", async () => {
    const db = env.handle.db;
    // Сума вересня; пізнє замовлення вересня визнано в жовтні, жовтень закрито.
    const a = await insertOrder(db, { placedOn: "2026-09-03", gateway: "close-gw", state: "recognized", recognizedOn: "2026-09-04", forecasts: [{ component: "fees", amount: "1.00" }] });
    const e = await createExpense(ctxAt(env, "2026-09-15T10:00:00Z"), fees({ gateway: "close-gw", amount: "5,00", expenseDate: "2026-09-15" }));
    const late = await insertOrder(db, { placedOn: "2026-09-28", gateway: "close-gw", state: "recognized", recognizedOn: "2026-10-02", forecasts: [{ component: "fees", amount: "4.00" }] });
    await closeMonthRow(db, "2026-10-01");
    expect((await enqueueExpenseReallocation(db, late)).queued).toBe(1);
    await runDue(env);
    const shares = await activeEntriesOf(db, e.id);
    const lateShare = shares.find((x) => x.orderId === late)!;
    // Жовтень закрито → частка пізнього замовлення проведена датою проведення як пізня; оригінальна дата збережена.
    expect(lateShare).toMatchObject({ amount: "-4.00", recognizedOn: "2026-12-03", originalOn: "2026-10-02", isLate: true });
    expect(shares.find((x) => x.orderId === a)).toMatchObject({ amount: "-1.00", recognizedOn: "2026-09-04", isLate: false });

    // Тепер закрито сам вересень (місяць суми): нове пізнє замовлення → завдання нічого не змінює, як і кнопка.
    const later = await insertOrder(db, { placedOn: "2026-09-29", gateway: "close-gw", state: "recognized", recognizedOn: "2026-09-30", forecasts: [{ component: "fees", amount: "5.00" }] });
    await closeMonthRow(db, "2026-09-01");
    expect(await coveringStatusForOrder(db, later)).toMatchObject([{ expenseId: e.id, state: "awaiting_reallocation" }]);
    await expect(recalculateAllocation(ctxAt(env, NOW), { expenseId: e.id })).rejects.toMatchObject({ code: "finance.error.monthClosed" });
    expect(await runExpenseReallocation(db, SYSTEM_ACTOR, e.id, { mode: "production", now: new Date(NOW) })).toEqual({ status: "month_closed", allocatedOrders: 0, posted: 0, reversed: 0, awaiting: 0 });
    expect((await enqueueExpenseReallocation(db, later)).queued).toBe(1);
    await runDue(env);
    const jobsNow = await reallocJobs(env, e.id);
    expect(jobsNow.every((j) => j.status === "succeeded")).toBe(true);
    expect((await db.select().from(financeExpenses).where(eq(financeExpenses.id, e.id)))[0]!.version).toBe(2);
    expect(await coveringStatusForOrder(db, later)).toMatchObject([{ state: "awaiting_reallocation" }]);
    expect(await activeEntriesOf(db, e.id)).toHaveLength(2);
  });

  it("voided / not covering / unknown expense → the job finishes without changes; a bad payload is a dead job", async () => {
    const db = env.handle.db;
    expect(await runExpenseReallocation(db, SYSTEM_ACTOR, "00000000-0000-4000-8000-000000000000", { mode: "production", now: new Date(NOW) })).toMatchObject({ status: "not_found" });
    const sep = await createExpense(ctxAt(env, NOW), fees({ gateway: "x-gw", expenseDate: "2026-11-20", coverage: "separate", separateReason: "окремо" }));
    expect(await runExpenseReallocation(db, SYSTEM_ACTOR, sep.id, { mode: "production", now: new Date(NOW) })).toMatchObject({ status: "not_covering" });
    const { enqueueJob } = await import("~/modules/jobs/queue.server");
    await enqueueJob(db, FINANCE_JOB.expenseReallocate, { expenseId: "not-a-uuid" }, { dedupeKey: "bad-payload" });
    await runJobsOnce(db, createFinanceJobHandlers(deps(env)));
    const [bad] = await db.select().from(jobs).where(eq(jobs.dedupeKey, "bad-payload"));
    expect(bad).toMatchObject({ status: "dead" });
  });

  it("no rate for weights in several currencies → not a dead job: no_rate, a delayed retry; once the rate exists the retry reallocates; the retry chain is bounded", async () => {
    const db = env.handle.db;
    // «Зараз» — реальний час: повтор (через годину) не стає готовим у межах тесту.
    const live = { db, serviceContext: () => ({ ...env.ctx(SYSTEM_ACTOR), mode: "production" as const, now: () => new Date() }), admin: async () => (async () => ({})) as never };
    const a = await insertOrder(db, { placedOn: "2026-05-03", gateway: "rate-gw", state: "recognized", recognizedOn: "2026-05-04", forecasts: [{ component: "fees", amount: "3.00" }] });
    const e = await createExpense(ctxAt(env, "2026-05-15T10:00:00Z"), fees({ gateway: "rate-gw", expenseDate: "2026-05-15" }));
    // Пізнє замовлення в іншій валюті: ваги EUR + USD потребують курсів, а їх немає (робочий режим, без НБУ).
    const late = await insertOrder(db, { placedOn: "2026-05-25", currency: "USD", gateway: "rate-gw", state: "recognized", recognizedOn: "2026-05-26", forecasts: [{ component: "fees", amount: "4.00" }] });
    expect(await coveringStatusForOrder(db, late, { mode: "production" })).toMatchObject([{ expenseId: e.id, state: "awaiting_reallocation" }]);
    await expect(recalculateAllocation({ ...ctxAt(env, NOW), mode: "production" }, { expenseId: e.id })).rejects.toMatchObject({ code: "finance.error.noRate" });
    expect(await runExpenseReallocation(db, SYSTEM_ACTOR, e.id, { mode: "production", now: new Date(NOW) })).toEqual({
      status: "no_rate",
      allocatedOrders: 0,
      posted: 0,
      reversed: 0,
      awaiting: 0,
      missingRate: { currency: expect.any(String), date: expect.stringMatching(/^2026-05-/) },
    });
    expect((await enqueueExpenseReallocation(db, late, { mode: "production" })).queued).toBe(1);
    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(e.id)));
    const before = Date.now();
    await runJobsOnce(db, createFinanceJobHandlers(live));
    const afterFirst = await reallocJobs(env, e.id);
    // Не «мертве»: завершене + повтор №1 приблизно через годину (той самий ключ dedupe).
    expect(afterFirst.map((j) => j.status).sort()).toEqual(["queued", "succeeded"]);
    const retry = afterFirst.find((j) => j.status === "queued")!;
    expect(retry.payload).toEqual({ expenseId: e.id, noRateRetry: 1 });
    expect(retry.runAt.getTime()).toBeGreaterThanOrEqual(before + FINANCE_JOB_TIMING.expenseReallocateNoRateRetryMs - 1000);
    expect(afterFirst.some((j) => j.status === "dead")).toBe(false);
    // Нова синхронізація замовлення, що чекає, не дублює повтор, а наближає його (раніший run_at).
    expect((await enqueueExpenseReallocation(db, late, { mode: "production" })).queued).toBe(0);
    const pulled = (await reallocJobs(env, e.id)).find((j) => j.status === "queued")!;
    expect(pulled.runAt.getTime()).toBeLessThan(retry.runAt.getTime());
    // Курс з'явився (НБУ) → повтор перераховує: обидва замовлення отримують частки.
    for (const [currency, date, value] of [
      ["EUR", "2026-05-03", "45.0000"],
      ["USD", "2026-05-25", "41.0000"],
    ] as const) {
      await db.insert(fxRates).values({ source: "nbu", currency, quoteCurrency: "UAH", effectiveDate: date, rate: value, units: 1, ratePerUnit: value });
    }
    await db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(and(eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(e.id)), eq(jobs.status, "queued")));
    await runJobsOnce(db, createFinanceJobHandlers(live));
    expect((await reallocJobs(env, e.id)).every((j) => j.status === "succeeded")).toBe(true);
    expect(await coveringStatusForOrder(db, late, { mode: "production" })).toMatchObject([{ expenseId: e.id, expenseVersion: 2, state: "allocated" }]);
    expect(await coveringStatusForOrder(db, a, { mode: "production" })).toMatchObject([{ expenseId: e.id, expenseVersion: 2, state: "allocated" }]);
    expect(sumMinor(await activeEntriesOf(db, e.id))).toBe(-700n);
    // Межа ланцюжка: понад expenseReallocateNoRateMaxRetries повтор не ставиться (лишаються кнопка і синхронізації WP4).
    expect(await scheduleNoRateRetry(db, e.id, { retry: FINANCE_JOB_TIMING.expenseReallocateNoRateMaxRetries + 1, now: new Date() })).toBe(false);
    expect((await reallocJobs(env, e.id)).some((j) => j.status === "queued")).toBe(false);
    expect(await scheduleNoRateRetry(db, e.id, { retry: FINANCE_JOB_TIMING.expenseReallocateNoRateMaxRetries, now: new Date() })).toBe(true);
    await db.delete(jobs).where(and(eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(e.id)), eq(jobs.status, "queued")));
    await db.delete(fxRates).where(eq(fxRates.source, "nbu"));
  });

  it("enqueue while the job is already running → a new queued job (runs after it); a queued job is held and pulled earlier, never duplicated", async () => {
    const db = env.handle.db;
    await insertOrder(db, { placedOn: "2026-04-03", gateway: "hold-gw", state: "recognized", recognizedOn: "2026-04-04", forecasts: [{ component: "fees", amount: "3.00" }] });
    const e = await createExpense(ctxAt(env, "2026-04-15T10:00:00Z"), fees({ gateway: "hold-gw", expenseDate: "2026-04-15" }));
    const late = await insertOrder(db, { placedOn: "2026-04-25", gateway: "hold-gw", state: "recognized", recognizedOn: "2026-04-26", forecasts: [{ component: "fees", amount: "4.00" }] });
    expect((await enqueueExpenseReallocation(db, late, { mode: "production" })).queued).toBe(1);
    // Обробник захопив завдання (running): нова синхронізація ставить НОВЕ — те, що виконується, могло не бачити її фактів.
    await db.update(jobs).set({ status: "running", lockedAt: new Date(), lockedBy: "test" }).where(eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(e.id)));
    expect((await enqueueExpenseReallocation(db, late, { mode: "production" })).queued).toBe(1);
    expect((await enqueueExpenseReallocation(db, late, { mode: "production" })).queued).toBe(0);
    const rows = await reallocJobs(env, e.id);
    expect(rows.map((j) => j.status).sort()).toEqual(["queued", "running"]);
    // Утримання не відкладає завдання: раніший із run_at.
    const far = new Date(Date.now() + 2 * 3600_000);
    await db.update(jobs).set({ runAt: far }).where(and(eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(e.id)), eq(jobs.status, "queued")));
    expect((await enqueueExpenseReallocation(db, late, { mode: "production" })).queued).toBe(0);
    const [queued] = (await reallocJobs(env, e.id)).filter((j) => j.status === "queued");
    expect(queued!.runAt.getTime()).toBeLessThanOrEqual(Date.now() + FINANCE_JOB_TIMING.expenseReallocateDelayMs + 1000);
    await db.delete(jobs).where(eq(jobs.dedupeKey, financeJobDedupe.expenseReallocate(e.id)));
  });
});

describe.skipIf(!process.env.TEST_DATABASE_URL)("finance.expense_reallocate concurrency (PostgreSQL)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await openEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("the job in parallel with order syncs (FINO(X) → shares → enqueue): no deadlock, exactly one active share per order", async () => {
    const db = env.handle.db;
    for (let round = 0; round < 3; round++) {
      const month = `2026-0${round + 3}`;
      const gw = `pg-gw-${round}`;
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push(await insertOrder(db, { placedOn: `${month}-0${i + 2}`, gateway: gw, state: "open", forecasts: [{ component: "fees", amount: `${i + 1}.00` }] }));
      const e = await createExpense(ctxAt(env, NOW), fees({ gateway: gw, amount: "15", expenseDate: `${month}-28` }));
      const late: string[] = [];
      for (let i = 0; i < 3; i++) late.push(await insertOrder(db, { placedOn: `${month}-2${i}`, gateway: gw, state: "open", forecasts: [{ component: "fees", amount: "1.00" }] }));
      for (const id of [...ids, ...late]) await recognize(db, id, `${month}-27`);
      // Синхронізація замовлення (як WP4): FINO(X), частки суми, постановка перерахунку — паралельно із завданням,
      // що бере FIOP суми → FINO всіх замовлень суми одним упорядкованим набором.
      const orderSync = (id: string) =>
        db.transaction(async (tx) => {
          await lockFinanceOrder(tx, id);
          await syncOrderExpenseEntries(tx, SYSTEM_ACTOR, id);
          await enqueueExpenseReallocation(tx, id);
        });
      const order = round % 2 === 0 ? [...late, ...ids] : [...ids, ...late].reverse();
      await Promise.all([runExpenseReallocation(db, SYSTEM_ACTOR, e.id, { mode: "production", now: new Date(NOW) }), ...order.map(orderSync)]);
      // Ще раз (як наступна синхронізація WP4 і наступне завдання) і перевірка.
      await runExpenseReallocation(db, SYSTEM_ACTOR, e.id, { mode: "production", now: new Date(NOW) });
      for (const id of [...ids, ...late]) await db.transaction((tx) => syncOrderExpenseEntries(tx, SYSTEM_ACTOR, id));
      const active = await activeEntriesOf(db, e.id);
      const byOrder = new Map<string, number>();
      for (const x of active) byOrder.set(x.orderId!, (byOrder.get(x.orderId!) ?? 0) + 1);
      expect(byOrder.size, `round ${round}`).toBe(7);
      expect([...byOrder.values()].every((n) => n === 1), `round ${round}`).toBe(true);
      expect(sumMinor(active), `round ${round}`).toBe(-1500n);
      for (const id of late) expect(await coveringStatusForOrder(db, id, { mode: "production" })).toMatchObject([{ state: "allocated" }]);
    }
  });

  it("an order sync deduped against a queued job holds it until commit: the worker cannot run the job without the order's facts (no lost reallocation)", async () => {
    const db = env.handle.db;
    const deps = { db, serviceContext: () => ctxAt(env, NOW, SYSTEM_ACTOR, "production"), admin: async () => (async () => ({})) as never };
    await insertOrder(db, { placedOn: "2026-07-03", gateway: "race-gw", state: "recognized", recognizedOn: "2026-07-04", forecasts: [{ component: "fees", amount: "3.00" }] });
    const e = await createExpense(ctxAt(env, "2026-07-15T10:00:00Z"), fees({ gateway: "race-gw", expenseDate: "2026-07-15" }));
    const l1 = await insertOrder(db, { placedOn: "2026-07-20", gateway: "race-gw", state: "recognized", recognizedOn: "2026-07-21", forecasts: [{ component: "fees", amount: "2.00" }] });
    // Завдання J у черзі й уже готове (поставлене синхронізацією l1 хвилину тому).
    expect((await enqueueExpenseReallocation(db, l1, { mode: "production", now: new Date(Date.now() - 60_000) })).queued).toBe(1);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inside = new Promise<void>((r) => (entered = r));
    let l2 = "";
    // Синхронізація l2 (як WP4): факти l2 → FINO(l2) → постановка (дедуплікація з J) → ще не зафіксовано.
    const t2 = db.transaction(async (tx) => {
      l2 = await insertOrder(tx as unknown as typeof db, { placedOn: "2026-07-25", gateway: "race-gw", state: "recognized", recognizedOn: "2026-07-26", forecasts: [{ component: "fees", amount: "4.00" }] });
      await lockFinanceOrder(tx, l2);
      expect(await enqueueExpenseReallocation(tx, l2, { mode: "production" })).toEqual({ queued: 0, expenseIds: [e.id] });
      entered();
      await gate;
    });
    await inside;
    // Обробник, поки l2 не зафіксовано: J утримано — не захоплюється (SKIP LOCKED).
    expect(await runJobsOnce(db, createFinanceJobHandlers(deps))).toBe(0);
    release();
    await t2;
    expect(await runJobsOnce(db, createFinanceJobHandlers(deps))).toBe(1);
    expect((await reallocJobs(env, e.id)).map((j) => j.status)).toEqual(["succeeded"]);
    expect(await coveringStatusForOrder(db, l2, { mode: "production" })).toMatchObject([{ expenseId: e.id, expenseVersion: 2, state: "allocated" }]);
    expect(await coveringStatusForOrder(db, l1, { mode: "production" })).toMatchObject([{ expenseId: e.id, expenseVersion: 2, state: "allocated" }]);
  });
});

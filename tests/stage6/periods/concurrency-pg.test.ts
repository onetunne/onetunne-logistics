/**
 * Етап 6, WP6: паралельність на справжньому PostgreSQL (§20.3; лише з TEST_DATABASE_URL — PGlite однопотоковий).
 * - Той самий operationId двічі одночасно → одна витрата й один набір записів.
 * - Закриття місяця паралельно з витратою, датованою цим місяцем → або відмова «Місяць закрито», або витрата до
 *   закриття (її записи бачить знімок закриття) — ніколи після.
 * - Перерахунок розподілу паралельно з проведенням часток замовлення (WP4 syncOrderExpenseEntries) → жодного дубля
 *   діючих часток.
 * - Виправлення (стара частка на одному замовленні, нова — на іншому) паралельно з транзакцією, що блокує ці замовлення
 *   в порядку id, — без взаємоблокування (FINANCE_ORDER_LOCK усіх замовлень — одним упорядкованим набором, F10).
 */
import { count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, financeExpenses, financeReportSnapshots } from "~/db/schema";
import { DomainError } from "~/lib/errors";
import type { BuildReportData } from "~/modules/finance/core/contracts";
import { emptyReportData } from "~/modules/finance/core/fakes";
import { createExpense, recalculateAllocation, replaceExpense } from "~/modules/expenses/expenses.server";
import { syncOrderExpenseEntries } from "~/modules/expenses/posting.server";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { closeMonth, reopenMonth } from "~/modules/finance/periods/periods.server";
import type { TestEnv } from "../../helpers";
import { activeEntriesOf, ctxAt, insertOrder, op, openEnv, recognize } from "../expenses/helpers";

const PG = Boolean(process.env.TEST_DATABASE_URL);
const NOW = "2026-11-28T10:00:00Z";

/** buildReportData-фейк: кількість записів місяця, видимих у транзакції закриття. */
const countingBuild: BuildReportData = async (ctx, input) => {
  const [r] = await ctx.db
    .select({ c: count() })
    .from(financeEntries)
    .where(sql`${financeEntries.recognizedOn} between ${input.period.from} and ${input.period.to}`);
  return { data: { ...emptyReportData(input), metrics: { entries: Number(r?.c ?? 0) } }, ratesUsed: [] };
};

describe.skipIf(!PG)("WP6 concurrency (PostgreSQL)", () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await openEnv();
    // Лише гривня у валютах показу: витрата в UAH не потребує курсів, тож закриття не блокує ■ «курси».
    await saveFinanceSettings(ctxAt(env, NOW), { displayCurrencies: ["UAH"], reportingCurrency: "UAH" }, { reason: "test" });
  });
  afterAll(async () => {
    await env.close();
  });

  it("the same operationId twice in parallel → one expense, one entry", async () => {
    const input = { operationId: op(), category: "rent", amount: "1000", currency: "UAH", dateMode: "single" as const, expenseDate: "2026-11-10" };
    const results = await Promise.all([createExpense(ctxAt(env, NOW), input), createExpense(ctxAt(env, NOW), input), createExpense(ctxAt(env, NOW), input)]);
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.duplicate)).toHaveLength(1);
    const [n] = await env.handle.db.select({ c: count() }).from(financeExpenses).where(eq(financeExpenses.operationId, input.operationId));
    expect(Number(n!.c)).toBe(1);
    expect(await activeEntriesOf(env.handle.db, results[0]!.id)).toHaveLength(1);
  });

  it("closing a month in parallel with an expense dated in it: refusal or before the close — never after", async () => {
    const months = ["2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01", "2026-05-01"];
    for (const month of months) {
      const day = month.replace(/-01$/, "-15");
      const [closeRes, expRes] = await Promise.allSettled([
        closeMonth(ctxAt(env, NOW), { month }, { buildReportData: countingBuild }),
        createExpense(ctxAt(env, NOW), { operationId: op(), category: "salaries", amount: "500", currency: "UAH", dateMode: "single", expenseDate: day }),
      ]);
      expect(closeRes.status).toBe("fulfilled");
      const [snap] = await env.handle.db.select().from(financeReportSnapshots).where(eq(financeReportSnapshots.periodFrom, month)).limit(1);
      const seen = (snap!.data as { metrics: { entries: number } }).metrics.entries;
      const [inMonth] = await env.handle.db
        .select({ c: count() })
        .from(financeEntries)
        .where(sql`${financeEntries.recognizedOn} between ${month} and ${day.replace(/-15$/, "-28")}`);
      if (expRes.status === "fulfilled") {
        // Витрата зафіксована ДО закриття: знімок бачить її запис.
        expect(seen).toBe(Number(inMonth!.c));
        expect(Number(inMonth!.c)).toBe(1);
      } else {
        expect(expRes.reason).toBeInstanceOf(DomainError);
        expect((expRes.reason as DomainError).code).toBe("finance.error.monthClosed");
        expect(Number(inMonth!.c)).toBe(0);
        expect(seen).toBe(0);
      }
      // Повторне закриття після відкриття бачить той самий стан (нічого не з'явилось після закриття).
      await reopenMonth(ctxAt(env, NOW), { month, reason: "перевірка" });
    }
  });

  it("replacing an expense locks old and new orders as ONE ordered set (F10): no deadlock with a transaction locking the same orders in order", async () => {
    const db = env.handle.db;
    for (let round = 0; round < 3; round++) {
      const x = await insertOrder(db, { placedOn: "2026-08-05", gateway: `gx${round}`, state: "recognized", recognizedOn: "2026-08-06", forecasts: [{ component: "fees", amount: "3.00" }] });
      const y = await insertOrder(db, { placedOn: "2026-08-05", gateway: `gy${round}`, state: "recognized", recognizedOn: "2026-08-06", forecasts: [{ component: "fees", amount: "3.00" }] });
      const [lo, hi] = [x, y].sort() as [string, string];
      const gwOf = (id: string) => (id === x ? `gx${round}` : `gy${round}`);
      const base = { category: "payment_fees", amount: "5.00", currency: "EUR", dateMode: "single" as const, expenseDate: "2026-08-31" };
      // Стара частка — на «старшому» замовленні (HI), нова — на «молодшому» (LO).
      const e = await createExpense(ctxAt(env, NOW), { operationId: op(), ...base, gateway: gwOf(hi) });
      let holding!: () => void;
      const held = new Promise<void>((r) => (holding = r));
      const other = db.transaction(async (tx) => {
        await lockFinanceOrder(tx, lo);
        holding();
        // Чекаємо, доки виправлення стане в чергу за блокуванням (будь-яке очікування advisory у цій базі).
        for (let i = 0; i < 200; i++) {
          const r = await db.execute(
            sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())`,
          );
          const rows = (r as unknown as { rows?: Array<{ n: number }> }).rows ?? (r as unknown as Array<{ n: number }>);
          if (Number(rows[0]?.n ?? 0) > 0) break;
          await new Promise((res) => setTimeout(res, 25));
        }
        await lockFinanceOrder(tx, hi);
        return "ok";
      });
      await held;
      const replace = replaceExpense(ctxAt(env, NOW), { operationId: op(), ...base, gateway: gwOf(lo), expenseId: e.id, reason: "інший шлюз" }).then(() => "ok");
      const res = await Promise.allSettled([other, replace]);
      expect(res.map((r) => (r.status === "fulfilled" ? r.value : String((r.reason as { cause?: { code?: string } })?.cause?.code ?? (r.reason as Error).message)))).toEqual(["ok", "ok"]);
      const active = await activeEntriesOf(db, e.id);
      expect(active).toHaveLength(0);
    }
  }, 60_000);

  it("recalculating an allocation in parallel with posting the order's shares → no duplicate active shares", async () => {
    const db = env.handle.db;
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(await insertOrder(db, { placedOn: `2026-06-${String(3 + i).padStart(2, "0")}`, gateway: "paypal", state: "open", forecasts: [{ component: "fees", amount: `${i + 1}.00` }] }));
    }
    const e = await createExpense(ctxAt(env, NOW), { operationId: op(), category: "payment_fees", amount: "21", currency: "EUR", dateMode: "single", expenseDate: "2026-06-30", gateway: "paypal" });
    const extra = await insertOrder(db, { placedOn: "2026-06-20", gateway: "paypal", state: "open", forecasts: [{ component: "fees", amount: "7.00" }] });
    for (const id of [...ids, extra]) await recognize(db, id, "2026-07-01");
    await Promise.all([
      recalculateAllocation(ctxAt(env, NOW), { expenseId: e.id }),
      // Як WP4: syncOrderFinance тримає FINANCE_ORDER_LOCK замовлення.
      ...[...ids, extra].map((id) =>
        db.transaction(async (tx) => {
          await lockFinanceOrder(tx, id);
          return syncOrderExpenseEntries(tx, { id: "system" }, id);
        }),
      ),
    ]);
    // Після всього — ще раз синхронізувати (як зробив би WP4) і перевірити: рівно одна діюча частка на замовлення.
    for (const id of [...ids, extra]) await db.transaction((tx) => syncOrderExpenseEntries(tx, { id: "system" }, id));
    const active = await activeEntriesOf(db, e.id);
    const byOrder = new Map<string, number>();
    for (const a of active) byOrder.set(a.orderId!, (byOrder.get(a.orderId!) ?? 0) + 1);
    expect([...byOrder.values()].every((n) => n === 1)).toBe(true);
    expect(byOrder.size).toBe(7);
    expect(active.reduce((s, a) => s + Number(a.amount) * 100, 0)).toBe(-2100);
    expect(active.every((a) => a.idempotencyKey.endsWith(":v2"))).toBe(true);
  });
});

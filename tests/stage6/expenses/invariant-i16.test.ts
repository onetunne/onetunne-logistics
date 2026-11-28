/**
 * Етап 6, WP6: інваріант I16 (§10.3, §20.2) на випадкових наборах (власний генератор із зерном, без нової залежності):
 * жоден (вимір, місяць) не дає в «≈ Прогноз» водночас прогноз замовлення і суму періоду без позначки «окрема».
 * Перевіряється для кожної діючої суми з covers_forecast:
 * - кожне придатне замовлення виміру й вікна з прогнозом > 0 і без фактичного складника покрите часткою ПОТОЧНОЇ версії;
 * - сума має або частки (Σ = сума точно, жодного запису exp:), або — без кандидатів — один запис періоду;
 * - замовлення, вже фактичні з іншого джерела, скасовані, тестові, поза виміром чи вікном — не покриті;
 * - «окрема» витрата (з причиною) часток не має й проводиться записом періоду.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeExpenseAllocations, financeExpenses } from "~/db/schema";
import { postEntries } from "~/modules/finance/core/entries.server";
import { coveringStatusForOrder } from "~/modules/expenses/allocation.server";
import { createExpense, recalculateAllocation } from "~/modules/expenses/expenses.server";
import type { TestEnv } from "../../helpers";
import { activeEntriesOf, ctxAt, insertOrder, op, openEnv, sumMinor } from "./helpers";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const GATEWAYS = ["paypal", "stripe", "liqpay"] as const;
const MONTHS = ["2026-08", "2026-09"] as const;

interface Gen {
  id: string;
  gateway: string;
  month: string;
  forecast: bigint;
  state: "open" | "recognized" | "closed_unrecognized";
  actual: boolean;
  test: boolean;
}

describe.each([11, 2026, 777])("I16 on a random data set (seed %i)", (seed) => {
  let env: TestEnv;
  const orders: Gen[] = [];
  const covering: Array<{ id: string; gateway: string; month: string }> = [];
  let separateId = "";

  beforeAll(async () => {
    env = await openEnv();
    const db = env.handle.db;
    const r = rng(seed);
    const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
    for (let i = 0; i < 40; i++) {
      const gateway = pick(GATEWAYS);
      const month = pick(MONTHS);
      const day = String(1 + Math.floor(r() * 28)).padStart(2, "0");
      const forecast = r() < 0.2 ? 0n : BigInt(1 + Math.floor(r() * 900));
      const state = r() < 0.15 ? "closed_unrecognized" : r() < 0.5 ? "open" : "recognized";
      const test = r() < 0.08;
      const actual = state === "recognized" && r() < 0.2;
      const id = await insertOrder(db, {
        placedOn: `${month}-${day}`,
        gateway,
        state,
        recognizedOn: `${month}-${day}`,
        shopifyTest: test,
        forecasts: forecast > 0n ? [{ component: "fees", amount: (Number(forecast) / 100).toFixed(2) }] : [],
      });
      if (actual) {
        await db.transaction((tx) =>
          postEntries(tx, { id: "test" }, [
            { idempotencyKey: `fee:i16-${id}`, category: "payment_fees", recognizedOn: `${month}-${day}`, fxOn: `${month}-${day}`, amount: "-1.00", currency: "EUR", orderId: id, sourceType: "shopify_fee", sourceId: "i16" },
          ]),
        );
      }
      orders.push({ id, gateway, month, forecast, state, actual, test });
    }
    for (const gateway of GATEWAYS) {
      for (const month of MONTHS) {
        if (r() < 0.25) continue;
        const amount = (1 + Math.floor(r() * 5000)) / 100;
        const e = await createExpense(ctxAt(env, "2026-11-28T10:00:00Z"), {
          operationId: op(),
          category: "payment_fees",
          amount: amount.toFixed(2),
          currency: "EUR",
          dateMode: "single",
          expenseDate: `${month}-28`,
          gateway,
        });
        covering.push({ id: e.id, gateway, month });
      }
    }
    const sep = await createExpense(ctxAt(env, "2026-11-28T10:00:00Z"), {
      operationId: op(),
      category: "payment_fees",
      amount: "5.00",
      currency: "EUR",
      dateMode: "single",
      expenseDate: "2026-08-15",
      gateway: "paypal",
      coverage: "separate",
      separateReason: "Річна плата",
    });
    separateId = sep.id;
  });
  afterAll(async () => {
    await env.close();
  });

  it("every eligible order with a forecast in a covered (gateway, month) has a share of the current version; Σ shares = sum", async () => {
    const db = env.handle.db;
    expect(covering.length).toBeGreaterThan(0);
    for (const c of covering) {
      const [row] = await db.select().from(financeExpenses).where(eq(financeExpenses.id, c.id));
      const shares = await db
        .select()
        .from(financeExpenseAllocations)
        .where(and(eq(financeExpenseAllocations.expenseId, c.id), eq(financeExpenseAllocations.expenseVersion, row!.version)));
      const covered = new Set(shares.map((s) => s.orderId));
      const eligible = orders.filter((o) => o.gateway === c.gateway && o.month === c.month && o.state !== "closed_unrecognized" && !o.test && !o.actual);
      const withForecast = eligible.filter((o) => o.forecast > 0n);
      const active = await activeEntriesOf(db, c.id);
      if (shares.length > 0) {
        expect(sumMinor(shares)).toBe(BigInt(Math.round(Number(row!.amount) * 100)));
        expect(active.some((e) => e.idempotencyKey.startsWith(`exp:${c.id}`))).toBe(false);
        if (withForecast.length > 0) {
          // I16: кожне замовлення з прогнозом покрите; без прогнозу — не покрите (лишається «Немає даних»).
          for (const o of withForecast) expect(covered.has(o.id), `order with forecast ${o.id}`).toBe(true);
          for (const o of eligible.filter((x) => x.forecast === 0n)) expect(covered.has(o.id)).toBe(false);
        } else {
          // Прогнозів немає — розподіл за виручкою між усіма придатними.
          expect([...covered].sort()).toEqual(eligible.map((o) => o.id).sort());
        }
      } else {
        expect(eligible).toHaveLength(0);
        expect(active.map((e) => e.idempotencyKey)).toEqual([`exp:${c.id}:v1`]);
      }
      // Нічого поза виміром / вікном / придатністю.
      for (const id of covered) {
        const o = orders.find((x) => x.id === id)!;
        expect(o.gateway).toBe(c.gateway);
        expect(o.month).toBe(c.month);
        expect(o.state === "closed_unrecognized" || o.test || o.actual).toBe(false);
      }
    }
  });

  it("shares of recognized orders are posted as actual order entries; open orders' shares wait", async () => {
    const db = env.handle.db;
    for (const c of covering) {
      const [row] = await db.select().from(financeExpenses).where(eq(financeExpenses.id, c.id));
      const shares = await db.select().from(financeExpenseAllocations).where(and(eq(financeExpenseAllocations.expenseId, c.id), eq(financeExpenseAllocations.expenseVersion, row!.version)));
      const active = await activeEntriesOf(db, c.id);
      const posted = new Set(active.filter((e) => e.sourceType === "allocation").map((e) => e.orderId));
      for (const s of shares) {
        const o = orders.find((x) => x.id === s.orderId)!;
        const nonZero = Number(s.amount) !== 0;
        expect(posted.has(s.orderId)).toBe(nonZero && o.state === "recognized");
      }
    }
  });

  it("I16 after the sum was saved: an order that later enters a covered (gateway, month) never keeps its forecast unnoticed — WP4's predicate reports it awaiting reallocation until «Recalculate»", async () => {
    const db = env.handle.db;
    const r = rng(seed + 1);
    const late: Gen[] = [];
    for (let i = 0; i < 8; i++) {
      const c = covering[Math.floor(r() * covering.length)]!;
      const day = String(1 + Math.floor(r() * 28)).padStart(2, "0");
      const forecast = r() < 0.25 ? 0n : BigInt(1 + Math.floor(r() * 900));
      // Пізно оформлене / імпортоване замовлення того самого виміру й місяця.
      const id = await insertOrder(db, {
        placedOn: `${c.month}-${day}`,
        gateway: c.gateway,
        state: "open",
        forecasts: forecast > 0n ? [{ component: "fees", amount: (Number(forecast) / 100).toFixed(2) }] : [],
      });
      late.push({ id, gateway: c.gateway, month: c.month, forecast, state: "open", actual: false, test: false });
    }
    const statusOf = async (id: string) => (await coveringStatusForOrder(db, id, { mode: "demo", includeTestOrders: false })).filter((x) => x.component === "fees");
    for (const o of late) {
      const st = await statusOf(o.id);
      const c = covering.find((x) => x.gateway === o.gateway && x.month === o.month)!;
      if (o.forecast > 0n) {
        // Прогноз НЕ рахується разом із сумою: або частка, або «чекає перерахунку».
        expect(st.map((x) => [x.expenseId, x.state]), `late order ${o.id}`).toEqual([[c.id, "awaiting_reallocation"]]);
      } else {
        // Без прогнозу подвійного обліку немає (частку за прогнозом він не отримає) — не позначається.
        expect(st.every((x) => x.state !== "awaiting_reallocation" || x.expenseId !== c.id) || st.length === 0).toBe(true);
      }
    }
    const touched = [...new Set(late.map((o) => covering.find((x) => x.gateway === o.gateway && x.month === o.month)!.id))];
    for (const id of touched) await recalculateAllocation(ctxAt(env, "2026-11-28T10:00:00Z"), { expenseId: id });
    for (const o of late.filter((x) => x.forecast > 0n)) {
      expect((await statusOf(o.id)).map((x) => x.state)).toEqual(["allocated"]);
    }
    // Старі замовлення з частками — «allocated» поточної версії, ніколи «awaiting».
    for (const o of orders) {
      const st = await statusOf(o.id);
      expect(st.some((x) => x.state === "awaiting_reallocation")).toBe(false);
    }
  });

  it("a «separate» sum has no shares and is one period entry", async () => {
    const db = env.handle.db;
    expect(await db.select().from(financeExpenseAllocations).where(eq(financeExpenseAllocations.expenseId, separateId))).toHaveLength(0);
    expect((await activeEntriesOf(db, separateId)).map((e) => e.amount)).toEqual(["-5.00"]);
  });
});

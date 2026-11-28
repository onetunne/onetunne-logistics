/**
 * Етап 6, WP7: паралельність на справжньому PostgreSQL (§20.3; лише з TEST_DATABASE_URL):
 * - дві виплати одному партнеру паралельно → послідовно під FINANCE_PARTNER_LOCK: кожна на весь «До виплати» без
 *   аванса — рівно одна збережена, друга «перевищує доступний баланс»;
 * - той самий operationId паралельно → одна виплата й один довідковий запис;
 * - паралельні синхронізації винагороди одного замовлення серіалізуються FINANCE_ORDER_LOCK: відкрите замовлення — усі
 *   завершуються, рівно один рядок прогнозу (без блокування delete+insert прогнозу конфліктує за PK); визнане — одне
 *   нарахування, без дублів n; після повернення — рівно одне коригування;
 * - паралельне «Додати партнера» з тим самим ім'ям → один партнер (FINANCE_OP_LOCK назви), решта — «уже є».
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, orderFinanceForecasts, partnerAttributions, partnerPayouts, partners } from "~/db/schema";
import type { Db } from "~/db/client.server";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { createPartner, getPartnerDetail } from "~/modules/partners/partners.server";
import { createPayout } from "~/modules/partners/payouts.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { addSale, entriesOf, eventsOf, g1Order, makePartner, ownerCtx, recognize, setFinance, sync } from "./helpers";

describe.skipIf(!process.env.TEST_DATABASE_URL)("partner concurrency on PostgreSQL", () => {
  let env: TestEnv;
  let partnerId = "";
  const NOW = "2026-11-28T10:00:00Z";
  beforeAll(async () => {
    env = await createTestEnv({ seed: false });
    partnerId = await makePartner(env, { codes: [{ source: "discount_code", code: "PGPAY" }] });
  });
  afterAll(async () => {
    await env.close();
  });

  it("parallel syncs of an open order are serialised: all succeed, exactly one forecast row and one attribution", async () => {
    const o = await g1Order(env, "PGPAY");
    await setFinance(env.handle.db, o, { state: "open" });
    const settled = await Promise.allSettled(Array.from({ length: 8 }, () => sync(env, o)));
    expect(settled.filter((x) => x.status === "rejected")).toEqual([]);
    const fc = await env.handle.db.select().from(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, o), eq(orderFinanceForecasts.component, "partner")));
    expect(fc.map((f) => f.amount)).toEqual(["-11.70"]);
    const [a] = await env.handle.db.select({ c: count() }).from(partnerAttributions).where(eq(partnerAttributions.orderId, o));
    expect(Number(a!.c)).toBe(1);
  });

  it("parallel syncs of one recognized order → one accrual, unique n, one entry; after a return → exactly one adjustment", async () => {
    const o = await g1Order(env, "PGPAY");
    await recognize(env, o, "2026-10-05");
    const first = await Promise.allSettled(Array.from({ length: 6 }, () => sync(env, o)));
    expect(first.filter((x) => x.status === "rejected")).toEqual([]);
    const evs = await eventsOf(env.handle.db, o);
    expect(evs.map((e) => [e.n, e.kind, e.amount])).toEqual([[1, "accrual", "11.70"]]);
    expect(await entriesOf(env.handle.db, o)).toHaveLength(1);
    await addSale(env.handle.db, o, { kind: "return", lineType: "PRODUCT", total: "-45.00", happenedAt: "2026-11-04T09:00:00Z" });
    const second = await Promise.allSettled(Array.from({ length: 6 }, () => sync(env, o)));
    expect(second.filter((x) => x.status === "rejected")).toEqual([]);
    expect((await eventsOf(env.handle.db, o)).map((e) => [e.n, e.kind, e.amount])).toEqual([
      [1, "accrual", "11.70"],
      [2, "adjustment", "-4.50"],
    ]);
    expect(await entriesOf(env.handle.db, o)).toHaveLength(2);
  });

  it("a sync waits for a transaction holding FINANCE_ORDER_LOCK (WP4 writing facts) and then sees its facts", async () => {
    const o = await g1Order(env, "PGPAY");
    await recognize(env, o, "2026-10-05");
    await sync(env, o);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const holder = env.handle.db.transaction(async (tx) => {
      await lockFinanceOrder(tx, o);
      await addSale(tx as unknown as Db, o, { kind: "return", lineType: "PRODUCT", total: "-45.00", happenedAt: "2026-11-04T09:00:00Z" });
      locked();
      await gate;
    });
    await isLocked;
    let finished = false;
    const waiting = sync(env, o).then((r) => {
      finished = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 400));
    // Без блокування синхронізація завершилася б, не побачивши повернення (подій 0).
    expect(finished).toBe(false);
    release();
    await holder;
    expect(await waiting).toMatchObject({ events: 1 });
    expect((await eventsOf(env.handle.db, o)).map((e) => [e.n, e.kind, e.amount])).toEqual([
      [1, "accrual", "11.70"],
      [2, "adjustment", "-4.50"],
    ]);
  });

  it("parallel «Add a partner» with the same name → one partner, the others «already exists»", async () => {
    const ctx = ownerCtx(env, NOW);
    const settled = await Promise.allSettled(Array.from({ length: 4 }, () => createPartner(ctx, { displayName: "Демо-дубль", kind: "blogger", rateBp: 1000, holdDays: 30 })));
    expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    for (const r of settled.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(r.reason).toMatchObject({ code: "partners.error.nameTaken" });
    const [n] = await env.handle.db.select({ c: count() }).from(partners).where(sql`lower(${partners.displayName}) = lower('Демо-дубль')`);
    expect(Number(n!.c)).toBe(1);
  });

  it("two payouts of the whole payable in parallel → exactly one saved, the other needs the advance confirmation", async () => {
    const ctx = ownerCtx(env, NOW);
    const payable = (await getPartnerDetail(ctx, partnerId))!.ledger[0]!.payable;
    expect(payable).toBe("14.40");
    const settled = await Promise.allSettled(
      [randomUUID(), randomUUID()].map((operationId) => createPayout(ctx, { operationId, partnerId, paidOn: "2026-11-20", amount: payable, currency: "EUR", method: "bank" })),
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const rejected = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "partners.error.payoutExceedsPayable" });
    const [n] = await env.handle.db.select({ c: count() }).from(partnerPayouts).where(eq(partnerPayouts.partnerId, partnerId));
    expect(Number(n!.c)).toBe(1);
    expect((await getPartnerDetail(ctx, partnerId))!.ledger[0]).toMatchObject({ balance: "0.00", payable: "0.00" });
  });

  it("the same operationId in parallel → one payout and one memo entry", async () => {
    const ctx = ownerCtx(env, NOW);
    const operationId = randomUUID();
    const res = await Promise.all(
      Array.from({ length: 4 }, () => createPayout(ctx, { operationId, partnerId, paidOn: "2026-11-21", amount: "1.00", currency: "EUR", method: "bank", confirmAdvance: true })),
    );
    expect(res.filter((r) => !r.duplicate)).toHaveLength(1);
    expect(new Set(res.map((r) => r.id)).size).toBe(1);
    const [e] = await env.handle.db.select({ c: count() }).from(financeEntries).where(eq(financeEntries.sourceId, res[0]!.id));
    expect(Number(e!.c)).toBe(1);
  });
});

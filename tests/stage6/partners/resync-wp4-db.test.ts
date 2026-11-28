/**
 * Етап 6, WP7 (огляд): дії власника (вибір / зняття партнера, додавання коду) перераховують замовлення через
 * syncOrderFinance (WP4). Коли WP4 сама проводить винагороду (контракт: syncPartnerCommission з confirmedProducts для
 * замовлень, суми яких підтвердив власник), WP7 НЕ викликає її вдруге без цих сум — інакше прогноз «Очікується»
 * зникав би. Імітація WP4 — записувальний syncOrderFinance з тим самим викликом, що описано в хенд-офі.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orderFinanceForecasts } from "~/db/schema";
import type { PostingActor } from "~/modules/finance/core/contracts";
import type { Tx } from "~/db/client.server";

const wp4 = vi.hoisted(() => ({ calls: [] as string[], confirmed: new Map<string, { amount: string; currency: string }>() }));
vi.mock("~/modules/order-finance/sync.server", async () => {
  const { syncPartnerCommission } = await import("~/modules/partners/sync.server");
  return {
    syncOrderFinance: async (tx: Tx, actor: PostingActor, orderId: string) => {
      wp4.calls.push(orderId);
      await syncPartnerCommission(tx, actor, orderId, { confirmedProducts: wp4.confirmed.get(orderId) ?? null });
    },
  };
});

const { createTestEnv } = await import("../../helpers");
const { addPartnerCode, getOrderPartner, setOrderAttribution } = await import("~/modules/partners/partners.server");
const { insertOrder, makePartner, ownerCtx, setFacts, setFinance } = await import("./helpers");

let env: Awaited<ReturnType<typeof createTestEnv>>;
const NOW = "2026-11-28T10:00:00Z";
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});

const partnerForecasts = (orderId: string) =>
  env.handle.db.select().from(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, orderId), eq(orderFinanceForecasts.component, "partner")));

describe("owner actions with a WP4 that posts the partner part itself", () => {
  it("choose a partner for an open order with owner-confirmed amounts → one WP4 call, the forecast stays (−20,00, owner_confirmed)", async () => {
    const p = await makePartner(env, { rateBp: 1000 });
    const o = await insertOrder(env.handle.db, { placedAt: "2026-11-20T10:00:00Z" });
    await setFinance(env.handle.db, o, { state: "open" });
    wp4.confirmed.set(o, { amount: "200.00", currency: "EUR" });
    wp4.calls.length = 0;
    const r = await setOrderAttribution(ownerCtx(env, NOW), { orderId: o, mode: "manual", partnerId: p, reason: "Блогер підтвердив" });
    expect(r).toMatchObject({ status: "attributed", events: 0 });
    expect(wp4.calls).toEqual([o]);
    const fc = await partnerForecasts(o);
    expect(fc.map((f) => [f.amount, f.currency, f.basis])).toEqual([["-20.00", "EUR", "owner_confirmed"]]);
    expect(await getOrderPartner(ownerCtx(env, NOW), o)).toMatchObject({ expected: { amount: "20.00", currency: "EUR" } });
  });

  it("adding a code re-syncs orders through WP4 only (the confirmed-amount forecast is not wiped)", async () => {
    const o = await insertOrder(env.handle.db, { placedAt: "2026-11-21T10:00:00Z" });
    await setFinance(env.handle.db, o, { state: "open" });
    await setFacts(env.handle.db, o, { discountCodes: ["WP4CODE"] });
    wp4.confirmed.set(o, { amount: "150.00", currency: "EUR" });
    const p = await makePartner(env, { rateBp: 1000 });
    wp4.calls.length = 0;
    const r = await addPartnerCode(ownerCtx(env, NOW), { partnerId: p, source: "discount_code", code: "WP4CODE" });
    expect(r.attributed).toBe(1);
    expect(wp4.calls).toEqual([o]);
    expect((await partnerForecasts(o)).map((f) => f.amount)).toEqual(["-15.00"]);
  });
});

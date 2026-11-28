/**
 * Етап 6 (WP3): доступ (F8, §14.1–§14.2) — сервіси перегляду й керування синхронізацією фінансів вимагають finance.view /
 * finance.manage І роль owner (працівник, зокрема підроблений з дозволом, → ForbiddenError); внутрішні функції
 * синхронізації працюють від SYSTEM_ACTOR і не повертають грошей; у демо мережевих дій немає.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { auditLog, jobs } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import {
  getFinanceSyncStatus,
  getOrderShopifyFinance,
  requestFinanceBackfill,
  requestOrderFinanceResync,
} from "~/modules/finance-sync/facts-view.server";
import { enqueueFinanceOrderSync } from "~/modules/finance-sync/schedule.server";
import { g2Fixture, SHOP } from "../fixtures/shopify-finance";
import { OWNER, STAFF } from "../../helpers";
import { openFinanceSyncEnv, type FinanceSyncEnv } from "./helpers";

vi.mock("~/modules/order-finance/sync.server", () => ({ syncOrderFinance: async () => undefined }));

let env: FinanceSyncEnv;
let orderId: string;
const GID = "gid://shopify/Order/9501";
/** Підроблений актор: має фінансові дозволи, але роль працівника. */
const FORGED = { ...makeActor({ id: "forged", displayName: "Forged", role: "staff" }), permissions: new Set(["finance.view", "finance.manage", "orders.view"] as const) };

beforeAll(async () => {
  env = await openFinanceSyncEnv();
  orderId = await env.createOrder(9501);
  env.store.set(GID, g2Fixture(GID, "gid://shopify/LineItem/95011"));
});
afterAll(async () => {
  await env.close();
});

describe("owner services require finance permission AND the owner role", () => {
  it("staff and a forged staff actor get ForbiddenError on every service", async () => {
    for (const actor of [STAFF, FORGED as never]) {
      const ctx = { ...env.ctx, actor };
      await expect(getOrderShopifyFinance(ctx, orderId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(getFinanceSyncStatus(ctx)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(requestOrderFinanceResync(ctx, orderId)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(requestFinanceBackfill(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    }
    expect(await env.db.select().from(jobs)).toEqual([]);
  });

  it("owner: no facts yet → null (not zeros); after the sync → facts with reconciliation", async () => {
    expect(await getOrderShopifyFinance(env.ctx, orderId)).toBeNull();
    const out = await env.sync(GID);
    // F8: результат внутрішньої синхронізації — кількості й коди, без сум.
    expect(JSON.stringify(out)).not.toMatch(/\d+\.\d{2}/);
    const view = (await getOrderShopifyFinance(env.ctx, orderId))!;
    expect(view.sales.map((s) => s.totalAmount).sort()).toEqual(["10.00", "59.50"]);
    expect(view.transactions[0]).toMatchObject({ kind: "SALE", amount: "69.50", fees: [{ amount: "2.32" }] });
    expect(view.reconciliation?.checks.RC4).toMatchObject({ status: "ok" });
    expect(view).toMatchObject({ flags: [], partialComponents: [], openDiscrepancies: 0, externalWaybills: 0 });
    const status = await getFinanceSyncStatus(env.ctx);
    expect(status).toMatchObject({ installed: true, allOrdersScope: false, ordersWithoutFacts: 0, ordersUnreadable: 0, ordersNeedingReview: 0 });
  });

  it("owner resync: forced finance.sync_order now (audit with ids only); demo — nothing", async () => {
    expect(await requestOrderFinanceResync(env.ctx, orderId)).toEqual({ status: "queued" });
    const [job] = await env.db.select().from(jobs).where(eq(jobs.type, "finance.sync_order"));
    expect(job!.payload).toEqual({ shop: "ot-finance.myshopify.com", orderGid: GID, force: true });
    expect(await requestOrderFinanceResync(env.ctx, orderId)).toEqual({ status: "already_queued" });
    const [audit] = await env.db.select().from(auditLog).where(eq(auditLog.action, "finance.shopify_resync_requested"));
    expect(audit).toMatchObject({ entityType: "order", entityId: orderId });
    expect(JSON.stringify(audit!.details)).not.toMatch(/\d+\.\d{2}/);
    const demo = { ...env.ctx, mode: "demo" as const };
    expect(await requestOrderFinanceResync(demo, orderId)).toEqual({ status: "demo" });
    expect(await requestFinanceBackfill(demo)).toEqual({ status: "demo" });
    expect(await requestFinanceBackfill(env.ctx)).toEqual({ status: "queued" });
    expect(OWNER.role).toBe("owner");
  });

  it("the owner's forced re-read is not swallowed by a queued normal sync: the queued job becomes forced and runs now", async () => {
    await env.db.delete(jobs);
    const t0 = new Date();
    expect(await enqueueFinanceOrderSync(env.db, { shop: SHOP, orderGid: GID }, { now: t0 })).toBe(true); // +30 с після webhook
    expect(await requestOrderFinanceResync(env.ctx, orderId)).toEqual({ status: "queued" });
    let rows = await env.db.select().from(jobs).where(eq(jobs.type, "finance.sync_order"));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ shop: SHOP, orderGid: GID, force: true });
    expect(rows[0]!.runAt.getTime()).toBeLessThanOrEqual(Date.now());
    // Примусове вже чекає — повторна кнопка нічого не додає; звичайна подія його не «знімає».
    expect(await requestOrderFinanceResync(env.ctx, orderId)).toEqual({ status: "already_queued" });
    expect(await enqueueFinanceOrderSync(env.db, { shop: SHOP, orderGid: GID })).toBe(false);
    rows = await env.db.select().from(jobs).where(eq(jobs.type, "finance.sync_order"));
    expect(rows.map((r) => r.payload)).toEqual([{ shop: SHOP, orderGid: GID, force: true }]);
    // Виконання цього завдання справді перечитує угоди (updatedAt не змінився).
    env.fake.calls.length = 0;
    await env.sync(GID, { force: (rows[0]!.payload as { force?: boolean }).force === true });
    expect(env.fake.ops()).toEqual(["OtOrderFinance", "OtOrderAgreements"]);
  });
});

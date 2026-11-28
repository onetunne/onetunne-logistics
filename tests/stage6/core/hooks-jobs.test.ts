/**
 * Етап 6 (WP0): точки підключення (§17.7) і реєстр завдань (§21.1).
 * - applyMovements → valueInsertedMovements(tx, inserted): лише щойно вставлені рухи, з seq (порядок оцінки), у тій самій
 *   транзакції; повтор (той самий ключ) — без виклику;
 * - syncOrderReservations → syncOrderFinance(tx, actor, orderId) на кожному шляху (зокрема «облік не відкрито»);
 * - заглушки не змінюють наявних потоків (накладна, передача — повний набір тестів етапів 1–5);
 * - реєстр завдань: лише завдання свого модуля, ланцюжки не кидають винятків.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { orders, warehouses } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import type { InsertedMovement } from "~/modules/finance/core/contracts";
import { createTestEnv, type TestEnv } from "../../helpers";
import { ACTOR, apply, insertProduct, stockItemFor } from "../../stage5/helpers";

const calls = vi.hoisted(() => ({
  valued: [] as InsertedMovement[][],
  finance: [] as Array<{ actorId: string; orderId: string }>,
  fxHandlers: {} as Record<string, { run: () => Promise<void> }>,
  fxSchedules: 0,
  syncSchedulesThrow: false,
}));
vi.mock("~/modules/costing/hook.server", () => ({
  valueInsertedMovements: async (_tx: unknown, inserted: readonly InsertedMovement[]) => {
    calls.valued.push([...inserted]);
  },
}));
vi.mock("~/modules/order-finance/sync.server", () => ({
  syncOrderFinance: async (_tx: unknown, actor: { id: string }, orderId: string) => {
    calls.finance.push({ actorId: actor.id, orderId });
  },
}));
vi.mock("~/modules/fx/jobs.server", () => ({
  handlers: () => calls.fxHandlers,
  ensureSchedules: async () => {
    calls.fxSchedules++;
  },
}));
vi.mock("~/modules/finance-sync/jobs.server", () => ({
  handlers: () => ({}),
  ensureSchedules: async () => {
    if (calls.syncSchedulesThrow) throw new Error("boom");
  },
}));

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => {
  calls.valued.length = 0;
  calls.finance.length = 0;
  calls.fxHandlers = {};
  calls.fxSchedules = 0;
  calls.syncSchedulesThrow = false;
});

describe("hook: applyMovements → valueInsertedMovements", () => {
  it("passes only inserted movements with their seq, in lock order, inside the same transaction", async () => {
    const db = env.handle.db;
    const { variantIds } = await insertProduct(db, "Hook test", [{ sku: "HK-1" }, { sku: "HK-2" }]);
    const a = await stockItemFor(db, variantIds[0]!);
    const b = await stockItemFor(db, variantIds[1]!);
    const [w] = await db.select({ id: warehouses.id }).from(warehouses).where(eq(warehouses.isDefault, true));
    const { applyMovements } = await import("~/modules/inventory/ledger.server");
    await db.transaction((tx) =>
      applyMovements(tx, ACTOR, [
        { warehouseId: w!.id, stockItemId: b, type: "receipt_manual", onHandDelta: 4, idempotencyKey: "hook:b", unitCost: "12.50", costCurrency: "EUR", reason: "purchase" },
        { warehouseId: w!.id, stockItemId: a, type: "receipt_manual", onHandDelta: 2, idempotencyKey: "hook:a" },
      ]),
    );
    expect(calls.valued).toHaveLength(1);
    const inserted = calls.valued[0]!;
    expect(inserted.map((m) => m.idempotencyKey).sort()).toEqual(["hook:a", "hook:b"]);
    const sorted = [...inserted].sort((x, y) => (x.stockItemId < y.stockItemId ? -1 : 1));
    expect(inserted.map((m) => m.id)).toEqual(sorted.map((m) => m.id));
    expect(inserted[0]!.seq).toBeLessThan(inserted[1]!.seq);
    const bMove = inserted.find((m) => m.idempotencyKey === "hook:b")!;
    expect(bMove).toMatchObject({ type: "receipt_manual", onHandDelta: 4, unitCost: "12.50", costCurrency: "EUR", reason: "purchase", actorId: ACTOR.id, orderId: null });
    // Повтор того самого ключа — рух не вставлено, оцінки немає.
    await apply(db, { stockItemId: a, type: "receipt_manual", onHandDelta: 2, idempotencyKey: "hook:a" });
    expect(calls.valued).toHaveLength(1);
  });
});

describe("hook: syncOrderReservations → syncOrderFinance", () => {
  it("is called on every return path (synced and not_initialized), with the caller's actor", async () => {
    const db = env.handle.db;
    const { syncOrderReservations } = await import("~/modules/inventory/reservations.server");
    const orderId = await env.orderId("#1001");
    const r = await db.transaction((tx) => syncOrderReservations(tx, orderId, ACTOR));
    expect(r.orderId).toBe(orderId);
    expect(calls.finance).toEqual([{ actorId: ACTOR.id, orderId }]);
    // Облік не відкрито → той самий виклик фінансів (відкат змін тесту).
    const ROLLBACK = new Error("rollback");
    await expect(
      db.transaction(async (tx) => {
        await tx.update(warehouses).set({ inventoryInitializedAt: null });
        const res = await syncOrderReservations(tx, orderId, SYSTEM_ACTOR);
        expect(res.state).toBe("not_initialized");
        throw ROLLBACK;
      }),
    ).rejects.toBe(ROLLBACK);
    expect(calls.finance.at(-1)).toEqual({ actorId: "system", orderId });
    const [order] = await db.select({ id: orders.id }).from(orders).where(eq(orders.id, orderId));
    expect(order).toBeTruthy();
  });
});

describe("finance job registry", () => {
  it("collects handlers statically from the package modules; foreign or unknown names are rejected", async () => {
    const { createFinanceJobHandlers, ensureFinanceSchedules, FINANCE_JOB_MODULES } = await import("~/modules/finance/jobs.server");
    expect(Object.keys(FINANCE_JOB_MODULES).sort()).toEqual(["costing", "finance-reports", "finance-sync", "fx"]);
    const deps = { db: env.handle.db, serviceContext: () => env.ctx(SYSTEM_ACTOR), admin: async () => (async () => ({})) as never };
    expect(createFinanceJobHandlers(deps)).toEqual({});
    const handler = { run: async () => undefined };
    calls.fxHandlers = { "finance.fx_fetch": handler };
    expect(createFinanceJobHandlers(deps)).toEqual({ "finance.fx_fetch": handler });
    calls.fxHandlers = { "finance.sync_order": handler };
    expect(() => createFinanceJobHandlers(deps)).toThrow(/not registered for module fx/);
    calls.fxHandlers = { "finance.bogus": handler };
    expect(() => createFinanceJobHandlers(deps)).toThrow();
    // Ланцюжки: кожен модуль викликано, збій одного не зупиняє інших і не кидає виняток.
    calls.syncSchedulesThrow = true;
    await expect(ensureFinanceSchedules(env.handle.db)).resolves.toBeUndefined();
    expect(calls.fxSchedules).toBe(1);
  });

  it("the Shopify job handler map includes the finance handlers (hook point in handlers.server.ts)", async () => {
    const handler = { run: async () => undefined };
    calls.fxHandlers = { "finance.fx_fetch": handler };
    const { createSyncHandlers } = await import("~/modules/shopify-sync/handlers.server");
    const map = createSyncHandlers({ db: env.handle.db, serviceContext: () => env.ctx(SYSTEM_ACTOR), admin: async () => (async () => ({})) as never });
    expect(map["finance.fx_fetch"]).toBe(handler);
    expect(map["shopify.sync_order"]).toBeDefined();
  });
});

describe("stubs are no-ops that never break existing flows", () => {
  it("the real stub modules do nothing and return no money", async () => {
    const real = await vi.importActual<typeof import("~/modules/order-finance/sync.server")>("~/modules/order-finance/sync.server");
    const hook = await vi.importActual<typeof import("~/modules/costing/hook.server")>("~/modules/costing/hook.server");
    const pending = await import("~/modules/costing/fx-pending.server");
    const backfill = await import("~/modules/costing/backfill.server");
    const demo = await import("~/db/seed/demo-finance.server");
    const tx = {} as never;
    expect(await real.syncOrderFinance(tx, ACTOR, "x")).toBeUndefined();
    expect(await hook.valueInsertedMovements(tx, [])).toBeUndefined();
    expect(await pending.completeFxPendingLayers(tx, ACTOR, {})).toEqual({ completed: 0 });
    expect(await backfill.ensureValuationBackfill(env.handle.db)).toBeUndefined();
    await expect(backfill.rebuildValuationForDemo(tx, { mode: "demo" })).resolves.toBeUndefined();
    expect(await demo.seedDemoFinance(env.ctx(SYSTEM_ACTOR))).toBeUndefined();
    const report = await import("~/modules/finance-analytics/report-data.server");
    await expect(report.buildReportData(env.ctx(SYSTEM_ACTOR), { kind: "month", period: { from: "2026-10-01", to: "2026-10-31" }, reportingCurrency: "UAH" })).rejects.toMatchObject({
      code: "finance.error.notImplemented",
    });
  });
});

/**
 * Етап 6 (WP0): точки підключення (§17.7) і реєстр завдань (§21.1).
 * - applyMovements → valueInsertedMovements(tx, inserted): лише щойно вставлені рухи, з seq (порядок оцінки), у тій самій
 *   транзакції; повтор (той самий ключ) — без виклику;
 * - syncOrderReservations → syncOrderFinance(tx, actor, orderId) на кожному шляху (зокрема «облік не відкрито»);
 * - заглушки (WP4, WP10, WP11, WP8) не змінюють наявних потоків; реалізовані точки (WP2, WP9) — у справжній транзакції;
 * - реєстр завдань: СПРАВЖНІ обробники пакетів (точні набори за модулем), лише завдання свого модуля (чуже чи невідоме
 *   ім'я — помилка), ланцюжки не кидають винятків.
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
  /** null — справжні обробники модуля fx (WP1); інакше підміна для перевірки відмов реєстру. */
  fxHandlers: null as Record<string, { run: () => Promise<void> }> | null,
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
vi.mock("~/modules/fx/jobs.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/fx/jobs.server")>();
  return {
    handlers: (...a: Parameters<typeof actual.handlers>) => calls.fxHandlers ?? actual.handlers(...a),
    ensureSchedules: async () => {
      calls.fxSchedules++;
    },
  };
});
vi.mock("~/modules/finance-sync/jobs.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/finance-sync/jobs.server")>();
  return {
    handlers: actual.handlers,
    ensureSchedules: async () => {
      if (calls.syncSchedulesThrow) throw new Error("boom");
    },
  };
});

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
  calls.fxHandlers = null;
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

/** Справжні назви завдань кожного модуля-власника (FINANCE_JOB_OWNER); finance-reports (WP10) — ще заглушка. */
const EXPECTED_HANDLERS: Record<string, string[]> = {
  fx: ["finance.fx_backfill", "finance.fx_fetch", "finance.fx_fetch_scheduled"],
  costing: ["finance.valuation_pending"],
  "finance-sync": ["finance.backfill_orders", "finance.reconcile", "finance.reconcile_scheduled", "finance.sync_order"],
  "finance-reports": [],
  expenses: ["finance.expense_reallocate"],
};

describe("finance job registry", () => {
  const depsOf = () => ({ db: env.handle.db, serviceContext: () => env.ctx(SYSTEM_ACTOR), admin: async () => (async () => ({})) as never });

  it("collects the REAL handlers of every package module (exact sets per module, each owned by its module)", async () => {
    const { createFinanceJobHandlers, FINANCE_JOB_MODULES } = await import("~/modules/finance/jobs.server");
    const { FINANCE_JOB_NAMES, FINANCE_JOB_OWNER } = await import("~/modules/finance/jobs");
    expect(Object.keys(FINANCE_JOB_MODULES).sort()).toEqual(Object.keys(EXPECTED_HANDLERS).sort());
    const deps = depsOf();
    for (const [owner, mod] of Object.entries(FINANCE_JOB_MODULES)) {
      const names = Object.keys(mod.handlers(deps)).sort();
      expect(names, owner).toEqual(EXPECTED_HANDLERS[owner]);
      for (const n of names) expect(FINANCE_JOB_OWNER[n as keyof typeof FINANCE_JOB_OWNER], n).toBe(owner);
    }
    const all = createFinanceJobHandlers(deps);
    expect(Object.keys(all).sort()).toEqual(Object.values(EXPECTED_HANDLERS).flat().sort());
    for (const h of Object.values(all)) expect(typeof h.run).toBe("function");
    // Кожна назва переліку має власника; без обробника — лише завдання ще не реалізованого WP10.
    expect(FINANCE_JOB_NAMES.filter((n) => !(n in all)).sort()).toEqual(["finance.snapshot", "finance.snapshot_scheduled"]);
  });

  it("foreign or unknown names are rejected; one failing schedule chain never stops the others", async () => {
    const { createFinanceJobHandlers, ensureFinanceSchedules } = await import("~/modules/finance/jobs.server");
    const deps = depsOf();
    const handler = { run: async () => undefined };
    calls.fxHandlers = { "finance.fx_fetch": handler };
    expect(createFinanceJobHandlers(deps)["finance.fx_fetch"]).toBe(handler);
    for (const foreign of ["finance.sync_order", "finance.valuation_pending", "finance.expense_reallocate", "finance.snapshot"]) {
      calls.fxHandlers = { [foreign]: handler };
      expect(() => createFinanceJobHandlers(deps), foreign).toThrow(/not registered for module fx/);
    }
    calls.fxHandlers = { "finance.bogus": handler };
    expect(() => createFinanceJobHandlers(deps)).toThrow(/not registered/);
    calls.fxHandlers = null;
    // Ланцюжки: кожен модуль викликано, збій одного не зупиняє інших і не кидає виняток.
    calls.syncSchedulesThrow = true;
    await expect(ensureFinanceSchedules(env.handle.db)).resolves.toBeUndefined();
    expect(calls.fxSchedules).toBe(1);
  });

  it("the Shopify job handler map includes the finance handlers (hook point in handlers.server.ts)", async () => {
    const handler = { run: async () => undefined };
    calls.fxHandlers = { "finance.fx_fetch": handler };
    const { createSyncHandlers } = await import("~/modules/shopify-sync/handlers.server");
    const map = createSyncHandlers(depsOf());
    expect(map["finance.fx_fetch"]).toBe(handler);
    expect(map["shopify.sync_order"]).toBeDefined();
    expect(map["finance.valuation_pending"]).toBeDefined();
    expect(map["finance.sync_order"]).toBeDefined();
    expect(map["finance.expense_reallocate"]).toBeDefined();
  });
});

describe("stubs are no-ops; implemented hooks run in a real transaction", () => {
  it("still-stub modules (order-finance sync, finance-reports jobs, demo finance, report data) do nothing and return no money", async () => {
    const real = await vi.importActual<typeof import("~/modules/order-finance/sync.server")>("~/modules/order-finance/sync.server");
    const reportsJobs = await import("~/modules/finance-reports/jobs.server");
    const demo = await import("~/db/seed/demo-finance.server");
    const tx = {} as never;
    expect(await real.syncOrderFinance(tx, ACTOR, "x")).toBeUndefined();
    expect(reportsJobs.handlers({ db: env.handle.db, serviceContext: () => env.ctx(SYSTEM_ACTOR), admin: async () => (async () => ({})) as never })).toEqual({});
    await expect(reportsJobs.ensureSchedules(env.handle.db)).resolves.toBeUndefined();
    expect(await demo.seedDemoFinance(env.ctx(SYSTEM_ACTOR))).toBeUndefined();
    const report = await import("~/modules/finance-analytics/report-data.server");
    await expect(report.buildReportData(env.ctx(SYSTEM_ACTOR), { kind: "month", period: { from: "2026-10-01", to: "2026-10-31" }, reportingCurrency: "UAH" })).rejects.toMatchObject({
      code: "finance.error.notImplemented",
    });
  });

  it("implemented hooks (WP2 costing, WP9 returns) on an EMPTY database: real transaction, nothing written, no money returned", async () => {
    const empty = await createTestEnv({ seed: false });
    try {
      const db = empty.handle.db;
      const { inventoryCostLayers, inventoryValuations, orderReturns } = await import("~/db/schema");
      const hook = await vi.importActual<typeof import("~/modules/costing/hook.server")>("~/modules/costing/hook.server");
      const pending = await import("~/modules/costing/fx-pending.server");
      const backfill = await import("~/modules/costing/backfill.server");
      const revalue = await import("~/modules/costing/revalue.server");
      const returnsSync = await import("~/modules/returns/sync.server");
      const missing = "00000000-0000-4000-8000-000000000000";
      await db.transaction(async (tx) => {
        expect(await pending.completeFxPendingLayers(tx, ACTOR, {})).toEqual({ completed: 0 });
        expect(await pending.completeFxPendingLayers(tx, ACTOR, { currency: "EUR", date: "2026-10-01" })).toEqual({ completed: 0 });
        expect(await hook.valueInsertedMovements(tx, [])).toBeUndefined();
        expect(await revalue.revalueBatchLines(tx, ACTOR, missing)).toBeUndefined();
        expect(await returnsSync.syncReturnCasesForOrder(tx, ACTOR, missing)).toBeUndefined();
        await expect(backfill.rebuildValuationForDemo(tx, { mode: "demo" })).resolves.toBeUndefined();
      });
      expect(await backfill.ensureValuationBackfill(db)).toBeUndefined();
      for (const t of [inventoryValuations, inventoryCostLayers, orderReturns]) expect(await db.select().from(t)).toEqual([]);
    } finally {
      await empty.close();
    }
  });
});

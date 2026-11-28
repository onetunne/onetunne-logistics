/**
 * Етап 6, WP2: паралельність рушія собівартості на справжньому PostgreSQL 16 (docs/stage6-design.md §20.3; лише з
 * TEST_DATABASE_URL, інакше пропускається):
 * - два паралельні applyMovements однієї позиції з РІЗНИМ часом початку транзакцій (раніше почата застосовується
 *   пізніше): оцінка йде за seq (порядок застосування), не за created_at; потім довантаження з нуля → той самий стан
 *   (I9);
 * - довантаження оцінки паралельно з applyMovements → без втрачених / подвійних оцінок, C0;
 * - паралельна передача двох замовлень з одним варіантом + коригування партії → без взаємоблокувань (40P01),
 *   детермінований підсумок (збереження вартості, C0);
 * - завершення fx_pending з переоцінкою партії паралельно з упорядкованою транзакцією над тими самими позиціями →
 *   без взаємоблокувань (баланси всіх позицій береться одним викликом у порядку stock_item_id, F10 / §17.8).
 */
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, inventoryCostLayers, inventoryCostState, inventoryMovements, inventoryValuationCompletions, inventoryValuations, productionBatchLines, productionBatches } from "~/db/schema";
import { ensureValuationBackfill } from "~/modules/costing/backfill.server";
import { completeFxPendingLayers } from "~/modules/costing/fx-pending.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { businessDate } from "~/lib/periods";
import { applyMovements, lockBalances } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { createBatch, receiveProduction, startProduction, updateBatchCosts } from "~/modules/production/batches.server";
import { toMinor } from "~/lib/money";
import { OWNER } from "../../helpers";
import { ACTOR } from "../../stage5/helpers";
import { costState, layersOf, manualRate, move, openCostEnv, order, product, valuationsOf, type CostEnv } from "./db-helpers";

describe.skipIf(!process.env.TEST_DATABASE_URL)("PostgreSQL: costing engine concurrency", () => {
  let env: CostEnv;
  beforeAll(async () => {
    env = await openCostEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  const snapshot = async (stockItemId: string) => ({
    vals: (await valuationsOf(env.db, stockItemId)).map((v) => [v.eventKey, v.kind, v.qty, v.knownQty, v.unknownQty, v.deficitQty, v.value, v.knownQtyAfter, v.knownValueAfter]),
    layers: (await layersOf(env.db, stockItemId)).map((l) => [l.kind, l.reason, l.qtyIn, l.qtyOpen]),
    state: await costState(env.db, stockItemId).then((s) => [s!.knownQty, s!.knownValue, s!.unknownQty, s!.deficitQty, s!.lastSeq]),
  });

  async function wipeValuation(stockItemId: string) {
    const ids = (await valuationsOf(env.db, stockItemId)).map((v) => v.id);
    if (ids.length) {
      await env.db.delete(financeEntries).where(inArray(financeEntries.sourceId, ids));
      await env.db.delete(inventoryValuationCompletions).where(inArray(inventoryValuationCompletions.valuationId, ids));
    }
    await env.db.delete(inventoryCostLayers).where(eq(inventoryCostLayers.stockItemId, stockItemId));
    await env.db.delete(inventoryValuations).where(eq(inventoryValuations.stockItemId, stockItemId));
    await env.db.delete(inventoryCostState).where(eq(inventoryCostState.stockItemId, stockItemId));
  }

  it("two concurrent applyMovements with different transaction start times: valued in seq order; backfill from zero = the same (I9)", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 3);
    const w = await getDefaultWarehouse(env.db);
    let startedA!: () => void;
    const aStarted = new Promise<void>((r) => (startedA = r));
    let goA!: () => void;
    const aGo = new Promise<void>((r) => (goA = r));
    let bLocked!: () => void;
    const bHasLock = new Promise<void>((r) => (bLocked = r));
    let releaseB!: () => void;
    const bRelease = new Promise<void>((r) => (releaseB = r));
    // A починає транзакцію першою (created_at = now() — раніше), але застосовує продаж ПІСЛЯ надходження B.
    const a = env.db.transaction(async (tx) => {
      await tx.execute("select 1");
      startedA();
      await aGo;
      await applyMovements(tx, ACTOR, [{ warehouseId: w.id, stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o.orderId, idempotencyKey: `pg:a:${randomUUID()}` }]);
    });
    await aStarted;
    await new Promise((r) => setTimeout(r, 20));
    const b = env.db.transaction(async (tx) => {
      await applyMovements(tx, ACTOR, [
        { warehouseId: w.id, stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase", idempotencyKey: `pg:b:${randomUUID()}` },
      ]);
      bLocked();
      await bRelease;
    });
    await bHasLock;
    goA();
    await new Promise((r) => setTimeout(r, 200));
    releaseB();
    await Promise.all([a, b]);
    const movements = await env.db.select().from(inventoryMovements).where(eq(inventoryMovements.stockItemId, p.stockItemId));
    const sale = movements.find((m) => m.type === "consume_sale")!;
    const receipt = movements.find((m) => m.type === "receipt_manual")!;
    expect(sale.createdAt.getTime()).toBeLessThan(receipt.createdAt.getTime());
    expect(Number(sale.seq)).toBeGreaterThan(Number(receipt.seq));
    // Продаж оцінено ПІСЛЯ надходження: 3 × 100 з пулу, без дефіциту.
    const [saleVal] = await env.db.select().from(inventoryValuations).where(eq(inventoryValuations.movementId, sale.id));
    expect(saleVal).toMatchObject({ knownQty: 3, deficitQty: 0, value: "300.00" });
    const stepwise = await snapshot(p.stockItemId);
    await wipeValuation(p.stockItemId);
    await ensureValuationBackfill(env.db);
    expect(await snapshot(p.stockItemId)).toEqual(stepwise);
  });

  it("backfill running concurrently with applyMovements: each movement valued exactly once, C0", async () => {
    const p = await product(env.db);
    for (let i = 0; i < 5; i++) await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 2, unitCost: `${10 + i}.00`, costCurrency: "UAH", reason: "purchase" });
    await wipeValuation(p.stockItemId);
    const w = await getDefaultWarehouse(env.db);
    await Promise.all([
      ensureValuationBackfill(env.db),
      ...Array.from({ length: 4 }, (_, i) =>
        env.db.transaction((tx) =>
          applyMovements(tx, ACTOR, [{ warehouseId: w.id, stockItemId: p.stockItemId, type: "adjustment", onHandDelta: -1, reason: "stocktake", idempotencyKey: `pg:bf:${i}:${randomUUID()}` }]),
        ),
      ),
    ]);
    const vals = await valuationsOf(env.db, p.stockItemId);
    const movements = await env.db.select().from(inventoryMovements).where(eq(inventoryMovements.stockItemId, p.stockItemId));
    expect(vals.filter((v) => v.movementId).length).toBe(movements.length);
    expect(new Set(vals.map((v) => v.movementId)).size).toBe(vals.length);
    const s = (await costState(env.db, p.stockItemId))!;
    expect(s.knownQty + s.unknownQty - s.deficitQty).toBe(6);
    // Σ надходжень 2 × (10+11+12+13+14) = 120.00 = пул + Σ виходів.
    const out = vals.filter((v) => v.kind === "outflow").reduce((a, v) => a + toMinor(v.value ?? "0.00"), 0n);
    expect(toMinor(s.knownValue) + out).toBe(12000n);
  });

  it("completeFxPendingLayers (batch revaluation of both lines) concurrently with a well-ordered transaction holding the smaller item → no deadlock (40P01)", async () => {
    const a = await product(env.db);
    const b = await product(env.db);
    const [first, second] = [a, b].sort((x, y) => (x.stockItemId < y.stockItemId ? -1 : 1)) as [typeof a, typeof b];
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, {
      title: "PG fx batch",
      costCurrency: "PLN",
      lines: [
        { variantId: first.variantId, quantity: 2, unitCost: "10.00" },
        { variantId: second.variantId, quantity: 2, unitCost: "10.00" },
      ],
    });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    const lines = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    const lineOf = (variantId: string) => lines.find((l) => l.variantId === variantId)!.id;
    // «second» надходить без курсу (fx_pending), потім з'являється курс, потім надходить «first» (з вартістю).
    await receiveProduction(ctx, batchId, { idempotencyKey: randomUUID(), lines: [{ batchLineId: lineOf(second.variantId), good: 2, defective: 0 }] });
    expect(await costState(env.db, second.stockItemId)).toMatchObject({ unknownQty: 2 });
    await manualRate(env.db, "PLN", businessDate(new Date()), "10.0000");
    await receiveProduction(ctx, batchId, { idempotencyKey: randomUUID(), lines: [{ batchLineId: lineOf(first.variantId), good: 2, defective: 0 }] });
    const w = await getDefaultWarehouse(env.db);
    let t2HasFirst!: () => void;
    const hasFirst = new Promise<void>((r) => (t2HasFirst = r));
    const t2 = env.db.transaction(async (tx) => {
      await lockBalances(tx, [{ warehouseId: w.id, stockItemId: first.stockItemId }]);
      t2HasFirst();
      await new Promise((r) => setTimeout(r, 300));
      await lockBalances(tx, [{ warehouseId: w.id, stockItemId: second.stockItemId }]);
    });
    await hasFirst;
    const t1 = env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, { currency: "PLN" }));
    const runs = await Promise.allSettled([t1, t2]);
    for (const r of runs) expect(r.status, r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : "").toBe("fulfilled");
    expect((runs[0] as PromiseFulfilledResult<{ completed: number }>).value.completed).toBe(1);
    expect(await costState(env.db, second.stockItemId)).toMatchObject({ knownQty: 2, knownValue: "200.00", unknownQty: 0 });
    expect(await costState(env.db, first.stockItemId)).toMatchObject({ knownQty: 2, knownValue: "200.00" });
  });

  it("two orders handed over concurrently (same variant) + a batch cost change → no deadlock, value conserved, C0", async () => {
    const p = await product(env.db);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "PG batch", costCurrency: "UAH", lines: [{ variantId: p.variantId, quantity: 20, unitCost: "100.00" }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    await receiveProduction(ctx, batchId, { idempotencyKey: randomUUID(), lines: "remaining" });
    const [line] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    const w = await getDefaultWarehouse(env.db);
    const orders = await Promise.all([order(env.db, p.variantId, 3), order(env.db, p.variantId, 4)]);
    const runs = await Promise.allSettled([
      ...orders.map((o) =>
        env.db.transaction((tx) =>
          applyMovements(tx, ACTOR, [{ warehouseId: w.id, stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -(o === orders[0] ? 3 : 4), orderId: o.orderId, idempotencyKey: `pg:sale:${o.orderId}` }]),
        ),
      ),
      version().then((v) => updateBatchCosts(ctx, batchId, v, { extraCost: null, costCurrency: "UAH", lines: [{ batchLineId: line!.id, unitCost: "110.00" }] })),
    ]);
    for (const r of runs) expect(r.status, r.status === "rejected" ? String((r as PromiseRejectedResult).reason) : "").toBe("fulfilled");
    const s = (await costState(env.db, p.stockItemId))!;
    expect(s.knownQty).toBe(13);
    // Ціль 20 × 110 = 2200.00 = пул + Σ виходів + коригування продажів (у будь-якому порядку подій).
    const vals = await valuationsOf(env.db, p.stockItemId);
    const outflows = vals.filter((v) => v.kind === "outflow").reduce((a, v) => a + toMinor(v.value ?? "0.00"), 0n);
    const adjSales = vals.filter((v) => v.kind === "revaluation").reduce((a, v) => a + toMinor(String((v.details as Record<string, unknown>).deltaSales ?? "0.00")), 0n);
    expect(toMinor(s.knownValue) + outflows + adjSales).toBe(220000n);
  });
});

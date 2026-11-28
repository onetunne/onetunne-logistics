/**
 * Етап 6, WP2: хук оцінки в applyMovements на БД (docs/stage6-design.md §6.4) — оцінки, шари, стан пулу, C0,
 * ідемпотентність (I3), наслідки без замовлення (val:<id>), вбудоване довантаження, I9 (довантаження з нуля = покрокова
 * оцінка), fx_pending і його завершення курсом, перевірка C0 / розбіжність cost_state_out_of_sync.
 */
import { eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  financeDiscrepancies,
  financeEntries,
  inventoryBalances,
  inventoryCostLayers,
  inventoryCostState,
  inventoryValuationCompletions,
  inventoryValuations,
} from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { ensureValuationBackfill, rebuildValuationForDemo } from "~/modules/costing/backfill.server";
import { completeFxPendingLayers } from "~/modules/costing/fx-pending.server";
import { costingEntriesForOrder, loadOrderCostingFacts } from "~/modules/costing/order-facts.server";
import { postEntries } from "~/modules/finance/core/entries.server";
import { costState, entriesOf, layersOf, manualRate, move, moves, openCostEnv, order, product, valuationsOf, type CostEnv } from "./db-helpers";

let env: CostEnv;
beforeAll(async () => {
  env = await openCostEnv();
});
afterAll(async () => {
  await env.close();
});

describe("hook valueInsertedMovements", () => {
  it("production receipt: valuation mv:<id>, state, memo entry; replay of the same key adds nothing (I3)", async () => {
    const p = await product(env.db);
    const a = await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase", idempotencyKey: "test:i3:1" });
    const vals = await valuationsOf(env.db, p.stockItemId);
    expect(vals).toHaveLength(1);
    expect(vals[0]).toMatchObject({ eventKey: `mv:${a.id}`, kind: "inflow", qty: 10, value: "1000.00", valueSource: "movement_cost", knownQtyAfter: 10, knownValueAfter: "1000.00" });
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 10, knownValue: "1000.00", unknownQty: 0, deficitQty: 0 });
    const memo = await entriesOf(env.db, { stockItemId: p.stockItemId });
    expect(memo).toMatchObject([{ idempotencyKey: `val:${vals[0]!.id}:memo`, category: "production_capitalized_memo", amount: "1000.00", currency: "UAH", orderId: null }]);
    // Повтор (той самий ключ руху) — без нового руху, оцінки й запису.
    const replay = await moves(env.db, [{ stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase", idempotencyKey: "test:i3:1" }]);
    expect(replay.applied).toHaveLength(0);
    expect(await valuationsOf(env.db, p.stockItemId)).toHaveLength(1);
    expect(await entriesOf(env.db, { stockItemId: p.stockItemId })).toHaveLength(1);
  });

  it("defect_mark → inventory_loss val:<id> (R6, no order), defect layer; staff can run it (no finance check)", async () => {
    const p = await product(env.db);
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
    const staffActor = { id: "test-staff", displayName: "Staff" };
    const m = await move(env.db, { stockItemId: p.stockItemId, type: "defect_mark", onHandDelta: -1, defectiveDelta: 1, reason: "damaged_in_warehouse" }, staffActor);
    const loss = (await entriesOf(env.db, { stockItemId: p.stockItemId })).find((e) => e.category === "inventory_loss")!;
    expect(loss).toMatchObject({ amount: "-100.00", postedBy: "test-staff", sourceType: "valuation", orderId: null });
    expect(loss.details).toMatchObject({ kind: "defect", movementType: "defect_mark" });
    const [v] = await env.db.select().from(inventoryValuations).where(eq(inventoryValuations.movementId, m.id));
    expect(loss.idempotencyKey).toBe(`val:${v!.id}`);
    expect(await layersOf(env.db, p.stockItemId)).toMatchObject([{ kind: "defect", qtyOpen: 1, valueOpen: "100.00" }]);
  });

  it("consume_sale with an order: valuation carries order_id; order facts → cogs entries (WP4 contract); test order → inventory_loss test_order", async () => {
    const p = await product(env.db);
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 4, unitCost: "50.00", costCurrency: "UAH", reason: "purchase" });
    const o = await order(env.db, p.variantId, 2);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    // Наслідки замовлення хук НЕ проводить сам (WP4 — syncOrderFinance).
    expect((await entriesOf(env.db, { orderId: o.orderId })).length).toBe(0);
    const facts = await loadOrderCostingFacts(env.db, o.orderId);
    expect(facts.facts).toMatchObject([{ kind: "sale", qty: 2, knownQty: 2, value: "100.00", unvaluedRemaining: 0, orderLineItemId: o.lineId }]);
    const recognized = costingEntriesForOrder(o.orderId, facts.facts, { recognizedOn: "2026-11-20", excludedTestOrder: false });
    expect(recognized).toMatchObject([{ category: "cogs", amount: "-100.00", recognizedOn: "2026-11-20", quantity: 2, idempotencyKey: `cogs:${facts.facts[0]!.valuationId}` }]);
    const test = costingEntriesForOrder(o.orderId, facts.facts, { recognizedOn: "2026-11-20", excludedTestOrder: true });
    expect(test).toMatchObject([{ category: "inventory_loss", amount: "-100.00", recognizedOn: facts.facts[0]!.occurredOn, details: { kind: "test_order" } }]);
    // Ключі ті самі (перемикання includeTestOrders — сторно + нове покоління через repostEntries).
    expect(test[0]!.idempotencyKey).toBe(recognized[0]!.idempotencyKey);
    const posted = await env.db.transaction((tx) => postEntries(tx, SYSTEM_ACTOR, test));
    expect(posted.inserted).toBe(1);
  });

  it("negative stock then receipt: completion row for the sale (R3) and the order fact carries it", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 2);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ deficitQty: 2, knownQty: 0 });
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ deficitQty: 0, knownQty: 8, knownValue: "800.00" });
    const facts = await loadOrderCostingFacts(env.db, o.orderId);
    expect(facts.facts[0]).toMatchObject({ value: null, deficitQty: 2, unvaluedRemaining: 0, completions: [{ qty: 2, value: "200.00", basis: "movement_cost" }] });
    const entries = costingEntriesForOrder(o.orderId, facts.facts, { recognizedOn: "2026-11-20", excludedTestOrder: false });
    expect(entries).toMatchObject([{ category: "cogs", amount: "-200.00", isLateCompletion: true, recognizedOn: "2026-11-20", fxOn: facts.facts[0]!.occurredOn }]);
  });

  it("C0 holds after every flow (on_hand = known + unknown − deficit)", async () => {
    const rows = await env.db
      .select({ s: inventoryCostState, onHand: inventoryBalances.onHand })
      .from(inventoryCostState)
      .innerJoin(inventoryBalances, sql`${inventoryBalances.warehouseId} = ${inventoryCostState.warehouseId} and ${inventoryBalances.stockItemId} = ${inventoryCostState.stockItemId}`);
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.s.knownQty + r.s.unknownQty - r.s.deficitQty).toBe(r.onHand);
  });
});

describe("C0 guard", () => {
  it("an externally changed balance (state already out of sync) → cost_state_out_of_sync discrepancy, the movement is still recorded", async () => {
    const p = await product(env.db);
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 3, reason: "found" });
    await env.db.update(inventoryBalances).set({ onHand: 5 }).where(eq(inventoryBalances.stockItemId, p.stockItemId));
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 1, reason: "found" });
    const d = await env.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.type, "cost_state_out_of_sync"));
    expect(d.some((x) => (x.details as Record<string, unknown>).stockItemId === p.stockItemId && x.status === "open")).toBe(true);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ unknownQty: 4 });
    // Відновлення балансу через рух журналу неможливе (журнал = Σ рухів), тож лише перебудова (демо/тест) або виправлення
    // даних узгоджує стан: після узгодження розбіжність закривається автоматично.
    await env.db.update(inventoryBalances).set({ onHand: 4 }).where(eq(inventoryBalances.stockItemId, p.stockItemId));
    await env.db.transaction((tx) => rebuildValuationForDemo(tx, { mode: "demo" }));
    const after = await env.db.select().from(financeDiscrepancies).where(eq(financeDiscrepancies.type, "cost_state_out_of_sync"));
    expect(after.find((x) => (x.details as Record<string, unknown>).stockItemId === p.stockItemId)!.status).toBe("resolved");
  });

  it("rebuildValuationForDemo refuses outside demo / tests", async () => {
    const prev = process.env.VITEST;
    delete process.env.VITEST;
    try {
      await expect(env.db.transaction((tx) => rebuildValuationForDemo(tx, { mode: "production" }))).rejects.toMatchObject({ code: "finance.error.demoOnly" });
    } finally {
      process.env.VITEST = prev;
    }
  });
});

describe("backfill (I9)", () => {
  it("valuation from zero = step-by-step valuation (same values, layers and state, by seq)", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 7);
    await move(env.db, { stockItemId: p.stockItemId, type: "opening", onHandDelta: 3, idempotencyKey: `opening:test:${p.stockItemId}` });
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -4, orderId: o.orderId });
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_production", onHandDelta: 9, defectiveDelta: 1, unitCost: "100.00", costCurrency: "UAH", reason: "production_receipt" });
    await move(env.db, { stockItemId: p.stockItemId, type: "defect_mark", onHandDelta: -1, defectiveDelta: 1, reason: "damaged_in_warehouse" });
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o.orderId });
    await move(env.db, { stockItemId: p.stockItemId, type: "defect_repair", onHandDelta: 1, defectiveDelta: -1, reason: "repaired" });
    const snapshot = async () => ({
      vals: (await valuationsOf(env.db, p.stockItemId)).map((v) => ({
        eventKey: v.eventKey,
        kind: v.kind,
        qty: v.qty,
        knownQty: v.knownQty,
        unknownQty: v.unknownQty,
        deficitQty: v.deficitQty,
        value: v.value,
        after: [v.knownQtyAfter, v.knownValueAfter, v.unknownQtyAfter, v.deficitQtyAfter],
      })),
      layers: (await layersOf(env.db, p.stockItemId)).map((l) => [l.kind, l.reason, l.qtyIn, l.qtyOpen, l.valueOpen]),
      state: await costState(env.db, p.stockItemId).then((s) => [s!.knownQty, s!.knownValue, s!.unknownQty, s!.deficitQty, s!.lastSeq]),
      completions: (await env.db.select().from(inventoryValuationCompletions)).length,
    });
    const stepwise = await snapshot();
    // Довантаження з нуля: стан, шари й оцінки позиції видаляються, ensureValuationBackfill оцінює всю історію за seq.
    const ids = (await valuationsOf(env.db, p.stockItemId)).map((v) => v.id);
    await env.db.delete(financeEntries).where(inArray(financeEntries.sourceId, ids));
    await env.db.delete(inventoryValuationCompletions).where(inArray(inventoryValuationCompletions.valuationId, ids));
    await env.db.delete(inventoryCostLayers).where(eq(inventoryCostLayers.stockItemId, p.stockItemId));
    await env.db.delete(inventoryValuations).where(eq(inventoryValuations.stockItemId, p.stockItemId));
    await env.db.delete(inventoryCostState).where(eq(inventoryCostState.stockItemId, p.stockItemId));
    await ensureValuationBackfill(env.db);
    const backfilled = await snapshot();
    expect(backfilled.vals).toEqual(stepwise.vals);
    expect(backfilled.layers).toEqual(stepwise.layers);
    expect(backfilled.state).toEqual(stepwise.state);
    expect(backfilled.completions).toBe(stepwise.completions);
    // Повторне довантаження нічого не змінює (ідемпотентно).
    await ensureValuationBackfill(env.db);
    expect(await snapshot()).toEqual(backfilled);
  });
});

describe("fx_pending (§6.3 «Валюта надходження»)", () => {
  it("EUR receipt without a rate → fx_pending; sale draws it; a manual rate completes: rest → pool, sold → completion; memo at receipt date", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 1);
    const r = await move(env.db, { stockItemId: p.stockItemId, type: "receipt_production", onHandDelta: 4, unitCost: "10.00", costCurrency: "EUR", reason: "production_receipt" });
    expect(await layersOf(env.db, p.stockItemId)).toMatchObject([{ reason: "fx_pending", qtyOpen: 4, pendingUnitCost: "10.00", pendingCurrency: "EUR" }]);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -1, orderId: o.orderId });
    const [recv] = await env.db.select().from(inventoryValuations).where(eq(inventoryValuations.movementId, r.id));
    expect(recv).toMatchObject({ value: null, originalAmount: "40.00", originalCurrency: "EUR" });
    // Без курсу — нічого не завершено.
    expect((await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, {}))).completed).toBe(0);
    await manualRate(env.db, "EUR", recv!.occurredOn, "48.5000");
    const done = await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, { currency: "EUR" }));
    expect(done.completed).toBe(1);
    // V = 40.00 EUR × 48.50 = 1940.00 UAH: 3 на складі (1455.00), 1 продано (485.00).
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 3, knownValue: "1455.00", unknownQty: 0 });
    const facts = await loadOrderCostingFacts(env.db, o.orderId);
    expect(facts.facts[0]!.completions).toMatchObject([{ qty: 1, value: "485.00", basis: "movement_cost" }]);
    const memo = (await entriesOf(env.db, { stockItemId: p.stockItemId })).find((e) => e.idempotencyKey.endsWith(":fxmemo"))!;
    expect(memo).toMatchObject({ category: "production_capitalized_memo", amount: "1940.00", recognizedOn: recv!.occurredOn, isLateCompletion: true });
    // Повтор — без змін.
    expect((await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, {}))).completed).toBe(0);
  });
});

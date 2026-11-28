/**
 * Етап 6, WP2 — регресійні тести раунду огляду (docs/stage6-design.md §6.2–§6.7, D-20): повернення дефіцитного продажу
 * й закриття дефіциту (§6.2 «частка повернутих одиниць завершує свій шар»), ручна собівартість лише як прогноз для
 * дефіциту, чинний рядок ручної собівартості (§6.6 «останній effective_from ≤ дата»), курс на дату кожного руху,
 * перерахунок завершень за попередньою ручною собівартістю, майбутня дата дії, попередній перегляд (лише одиниці, які
 * справді отримають собівартість), (в) моделі × кольору з завершеннями, «в обліку» партії після курсу, надходження
 * лише з браком без курсу, валюта оцінки з 0 знаками (JPY). Вигадані дані, без персональних даних.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeEntries, inventoryValuations, productionBatchLines, productionBatches } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { toMinor } from "~/lib/money";
import { businessDate } from "~/lib/periods";
import { rebuildValuationForDemo } from "~/modules/costing/backfill.server";
import { completeFxPendingLayers } from "~/modules/costing/fx-pending.server";
import { manualCostPreview, saveManualCost, type SaveManualCostInput } from "~/modules/costing/manual-costs.server";
import { costingEntriesForOrder, loadOrderCostingFacts } from "~/modules/costing/order-facts.server";
import { batchCosts, costsAttention, defectsSummary, modelColorCosts } from "~/modules/costing/queries.server";
import { postEntries } from "~/modules/finance/core/entries.server";
import { saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { createBatch, receiveProduction, startProduction, updateBatchCosts } from "~/modules/production/batches.server";
import { receiveStock } from "~/modules/warehouse/operations.server";
import { OWNER, STAFF } from "../../helpers";
import { insertProduct, stockItemFor } from "../../stage5/helpers";
import { backdate, costState, entriesOf, layersOf, manualRate, move, openCostEnv, order, product, valuationsOf, type CostEnv } from "./db-helpers";

let env: CostEnv;
beforeAll(async () => {
  env = await openCostEnv();
});
afterAll(async () => {
  await env.close();
});

const today = () => businessDate(new Date());

async function rebuild(): Promise<void> {
  await env.db.transaction((tx) => rebuildValuationForDemo(tx, { mode: "demo" }));
}

function costInput(stockItemId: string, unitCost: string, effectiveFrom: string, extra: Partial<SaveManualCostInput> = {}): SaveManualCostInput {
  return {
    operationId: randomUUID(),
    target: { kind: "stockItems", stockItemIds: [stockItemId] },
    unitCost,
    currency: "UAH",
    effectiveFrom,
    applyToStock: false,
    applyToSold: false,
    ...extra,
  };
}

async function saleFact(orderId: string) {
  const facts = (await loadOrderCostingFacts(env.db, orderId)).facts;
  return { facts, sale: facts.find((f) => f.kind === "sale")! };
}

function orderSum(orderId: string, facts: Awaited<ReturnType<typeof saleFact>>["facts"], recognizedOn = today()): bigint {
  return costingEntriesForOrder(orderId, facts, { recognizedOn, excludedTestOrder: false }).reduce((s, e) => s + toMinor(e.amount), 0n);
}

async function returnUnits(stockItemId: string, orderId: string, quantity: number) {
  return receiveStock(env.ctx(STAFF), { operationId: randomUUID(), stockItemId, quantity, reason: "customer_return", orderId });
}

describe("F1 — a deficit sale partly returned: the receipt value goes only to the still-sold units (§6.2)", () => {
  it("sale 2 on an empty pool, return 1, receipt 10 × 100 → sale completion 1 × 100.00; order COGS −100.00; pool 9 / 900.00", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 2);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    await returnUnits(p.stockItemId, o.orderId, 1);
    // Повернена одиниця без вартості гасить дефіцит свого продажу (від'ємний залишок −1), а не висить окремим шаром.
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 0, unknownQty: 0, deficitQty: 1 });
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
    const { facts, sale } = await saleFact(o.orderId);
    expect(sale.completions.map((c) => [c.qty, c.value])).toEqual([[1, "100.00"]]);
    expect(sale.unvaluedRemaining).toBe(0);
    expect(orderSum(o.orderId, facts)).toBe(-10000n);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 9, knownValue: "900.00", unknownQty: 0, deficitQty: 0 });
    expect((await layersOf(env.db, p.stockItemId)).filter((l) => l.reason === "return_without_cost" && l.qtyOpen > 0)).toEqual([]);
  });

  it("batch receipt without cost closes the deficit by quantity, 1 unit returned, then the batch cost arrives → the returned unit's layer completes into the pool, the sale gets 1 × 100.00", async () => {
    const { variantIds } = await insertProduct(env.db, `F1 batch ${randomUUID().slice(0, 6)}`, [{ sku: `F1B-${randomUUID().slice(0, 8)}` }]);
    const variantId = variantIds[0]!;
    const stockItemId = await stockItemFor(env.db, variantId);
    const o = await order(env.db, variantId, 2);
    await move(env.db, { stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "F1 batch", costCurrency: "UAH", lines: [{ variantId, quantity: 10, unitCost: null }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: randomUUID(), lines: "remaining" });
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 0, unknownQty: 8, deficitQty: 0 });
    await returnUnits(stockItemId, o.orderId, 1);
    expect(await costState(env.db, stockItemId)).toMatchObject({ unknownQty: 9, deficitQty: 0 });
    const [line] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    await updateBatchCosts(ctx, batchId, await version(), { extraCost: null, costCurrency: "UAH", lines: [{ batchLineId: line!.id, unitCost: "100.00" }] });
    const { facts, sale } = await saleFact(o.orderId);
    expect(sale.completions.map((c) => [c.qty, c.value])).toEqual([[1, "100.00"]]);
    expect(orderSum(o.orderId, facts)).toBe(-10000n);
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 9, knownValue: "900.00", unknownQty: 0, deficitQty: 0 });
  });
});

describe("F8 / D-20 — owner manual cost is only a forecast for a deficit", () => {
  it("sale 2 on an empty pool, return 1, «до залишку» 90.00 → nothing completed, the deficit waits for a receipt", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 2);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    await returnUnits(p.stockItemId, o.orderId, 1);
    const r = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "90.00", today(), { applyToStock: true, applyToSold: true }));
    expect(r).toMatchObject({ completedStockUnits: 0, completedSoldUnits: 0 });
    expect((await saleFact(o.orderId)).sale.completions).toEqual([]);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 0, unknownQty: 0, deficitQty: 1 });
  });

  it("another sale's returned unit valued «до залишку» goes to the pool; the open deficit of sale B is closed only by the next real receipt", async () => {
    const p = await product(env.db);
    const a = await order(env.db, p.variantId, 1);
    const b = await order(env.db, p.variantId, 1);
    await move(env.db, { stockItemId: p.stockItemId, type: "opening", onHandDelta: 1, idempotencyKey: `opening:f8:${p.stockItemId}` });
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -1, orderId: a.orderId, orderLineItemId: a.lineId });
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -1, orderId: b.orderId, orderLineItemId: b.lineId });
    await returnUnits(p.stockItemId, a.orderId, 1);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 0, unknownQty: 1, deficitQty: 1 });
    const r = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "90.00", today(), { applyToStock: true }));
    expect(r).toMatchObject({ completedStockUnits: 1, completedSoldUnits: 0 });
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 1, knownValue: "90.00", unknownQty: 0, deficitQty: 1 });
    expect((await saleFact(b.orderId)).sale.completions).toEqual([]);
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
    expect((await saleFact(b.orderId)).sale.completions.map((c) => [c.qty, c.value, c.basis])).toEqual([[1, "100.00", "movement_cost"]]);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 10, knownValue: "990.00", deficitQty: 0 });
  });
});

describe("F9 — the preview counts only units the manual cost will complete", () => {
  it("sale 2 on an empty pool: preview «продано без собівартості» 0, 2 units awaiting a receipt; the attention list says the same", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 2);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    const preview = await manualCostPreview(env.ctx(OWNER), { target: { kind: "stockItems", stockItemIds: [p.stockItemId] }, effectiveFrom: today() });
    expect(preview).toMatchObject({ items: 1, onHandWithoutCost: 0, soldWithoutCost: 0, orders: 0, soldAwaitingReceipt: 2 });
    const r = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "90.00", today(), { applyToSold: true }));
    expect(r.completedSoldUnits).toBe(preview.soldWithoutCost);
    const row = (await costsAttention(env.ctx(OWNER))).find((x) => x.stockItemId === p.stockItemId);
    expect(row).toMatchObject({ soldWithoutCost: 0, soldAwaitingReceipt: 2, orders: 0 });
  });
});

describe("F17 — effective_from in the future is refused", () => {
  it("saveManualCost with effectiveFrom after today → financeCosts.error.invalid {field: effectiveFrom}; nothing valued", async () => {
    const p = await product(env.db);
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 3, reason: "found" });
    await expect(saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "50.00", "2099-01-01", { applyToStock: true }))).rejects.toMatchObject({
      code: "financeCosts.error.invalid",
      params: { field: "effectiveFrom" },
    });
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 0, unknownQty: 3 });
  });
});

describe("F11 — a foreign-currency receipt with only defective units and no rate is recognised when the rate arrives (§6.3 g = 0)", () => {
  it("empty pool → inventory_loss production_defect; pool with known units → value to the pool + memo", async () => {
    const day = today();
    const empty = await product(env.db);
    await move(env.db, { stockItemId: empty.stockItemId, type: "receipt_production", onHandDelta: 0, defectiveDelta: 2, unitCost: "10.00", costCurrency: "PLN", reason: "production_receipt" });
    const pooled = await product(env.db);
    await move(env.db, { stockItemId: pooled.stockItemId, type: "receipt_manual", onHandDelta: 1, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
    await move(env.db, { stockItemId: pooled.stockItemId, type: "receipt_production", onHandDelta: 0, defectiveDelta: 2, unitCost: "10.00", costCurrency: "PLN", reason: "production_receipt" });
    await manualRate(env.db, "PLN", day, "10.0000");
    const r = await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, { currency: "PLN" }));
    expect(r.completed).toBe(2);
    const loss = await entriesOf(env.db, { stockItemId: empty.stockItemId });
    expect(loss.map((e) => [e.category, e.amount, (e.details as Record<string, unknown>).kind ?? null])).toEqual([["inventory_loss", "-200.00", "production_defect"]]);
    expect(await costState(env.db, empty.stockItemId)).toMatchObject({ knownQty: 0, knownValue: "0.00", unknownQty: 0 });
    expect(await costState(env.db, pooled.stockItemId)).toMatchObject({ knownQty: 1, knownValue: "300.00", unknownQty: 0 });
    const pooledEntries = await entriesOf(env.db, { stockItemId: pooled.stockItemId });
    expect(pooledEntries.filter((e) => e.category === "production_capitalized_memo").map((e) => e.amount).sort()).toEqual(["100.00", "200.00"]);
    // Повтор — нічого нового.
    expect((await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, { currency: "PLN" }))).completed).toBe(0);
  });
});

describe("F7 — a foreign-currency batch receipt completed by a rate is «in the books»", () => {
  it("EUR batch 4 × 10.00 received without a rate; manual rate 48.50 → batchCosts.booked 1940.00", async () => {
    const { variantIds } = await insertProduct(env.db, `F7 ${randomUUID().slice(0, 6)}`, [{ sku: `F7-${randomUUID().slice(0, 8)}` }]);
    const variantId = variantIds[0]!;
    const stockItemId = await stockItemFor(env.db, variantId);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "F7 EUR", costCurrency: "EUR", lines: [{ variantId, quantity: 4, unitCost: "10.00" }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: randomUUID(), lines: "remaining" });
    expect((await batchCosts(env.ctx(OWNER))).find((b) => b.batchId === batchId)!.booked).toBeNull();
    const receiptDate = (await valuationsOf(env.db, stockItemId)).find((v) => v.kind === "inflow")!.occurredOn;
    await manualRate(env.db, "EUR", receiptDate, "48.5000");
    await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, { currency: "EUR" }));
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 4, knownValue: "1940.00" });
    const row = (await batchCosts(env.ctx(OWNER))).find((b) => b.batchId === batchId)!;
    expect(row).toMatchObject({ booked: "1940.00", bookedCurrency: "UAH", currency: "EUR", plannedTotal: "40.00", producedInValuation: "1940.00" });
  });
});

describe("F12 — batch defect value, valuation-currency equivalent; defects summary counts production defects and damaged returns", () => {
  it("batch 9 good + 1 defective × 100.00 → defect value 100.00, equivalent 1000.00; production defect 1 and a damaged return 1 in the units", async () => {
    const { variantIds } = await insertProduct(env.db, `F12 ${randomUUID().slice(0, 6)}`, [{ sku: `F12-${randomUUID().slice(0, 8)}` }]);
    const variantId = variantIds[0]!;
    const stockItemId = await stockItemFor(env.db, variantId);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "F12", costCurrency: "UAH", lines: [{ variantId, quantity: 10, unitCost: "100.00" }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    const [line] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: randomUUID(), lines: [{ batchLineId: line!.id, good: 9, defective: 1 }] });
    const row = (await batchCosts(env.ctx(OWNER))).find((b) => b.batchId === batchId)!;
    expect(row).toMatchObject({ defectValue: "100.00", producedInValuation: "1000.00", booked: "1000.00" });
    const before = await defectsSummary(env.ctx(OWNER), { from: today(), to: today() });
    const o = await order(env.db, variantId, 1);
    await move(env.db, { stockItemId, type: "consume_sale", onHandDelta: -1, orderId: o.orderId, orderLineItemId: o.lineId });
    await receiveStock(env.ctx(STAFF), { operationId: randomUUID(), stockItemId, quantity: 0, defectiveQuantity: 1, reason: "customer_return", orderId: o.orderId });
    const after = await defectsSummary(env.ctx(OWNER), { from: today(), to: today() });
    expect(before.units.production).toBeGreaterThanOrEqual(1);
    expect(after.units.returnsDamaged - before.units.returnsDamaged).toBe(1);
  });
});

describe("F3 / F4 / F10 — manual cost: governing row, rate of each movement date, recompute of completions", () => {
  it("F3 recompute: a new row 95.00 from 15.09 does not touch the 10.10 sale governed by the 01.10 row (100.00) → 0 adjustments", async () => {
    const p = await product(env.db);
    const o1 = await order(env.db, p.variantId, 2);
    const o2 = await order(env.db, p.variantId, 3);
    await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "90.00", "2026-09-01"));
    await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "100.00", "2026-10-01"));
    const r = await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 5, reason: "found" });
    const s1 = await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o1.orderId, orderLineItemId: o1.lineId });
    const s2 = await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o2.orderId, orderLineItemId: o2.lineId });
    await backdate(env.db, [r.id], "2026-08-20");
    await backdate(env.db, [s1.id], "2026-09-10");
    await backdate(env.db, [s2.id], "2026-10-10");
    await rebuild();
    const sales = (await valuationsOf(env.db, p.stockItemId)).filter((v) => v.kind === "outflow");
    expect(sales.map((s) => [s.occurredOn, s.value, s.valueSource])).toEqual([
      ["2026-09-10", "180.00", "owner_standard"],
      ["2026-10-10", "300.00", "owner_standard"],
    ]);
    const res = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "95.00", "2026-09-15", { recomputeStandard: true }));
    expect(res.recomputed).toBe(0);
    expect((await entriesOf(env.db, { stockItemId: p.stockItemId })).filter((e) => e.sourceType === "cost_adjustment")).toEqual([]);
  });

  it("F3 «до вже проданих»: a back-dated row 90.00 from 01.09 completes only the 10.09 sale; the 10.10 sale belongs to the 01.10 row", async () => {
    const p = await product(env.db);
    const o1 = await order(env.db, p.variantId, 2);
    const o2 = await order(env.db, p.variantId, 3);
    const r = await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 5, reason: "found" });
    const s1 = await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o1.orderId, orderLineItemId: o1.lineId });
    const s2 = await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o2.orderId, orderLineItemId: o2.lineId });
    await backdate(env.db, [r.id], "2026-08-20");
    await backdate(env.db, [s1.id], "2026-09-10");
    await backdate(env.db, [s2.id], "2026-10-10");
    await rebuild();
    await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "100.00", "2026-10-01"));
    const preview = await manualCostPreview(env.ctx(OWNER), { target: { kind: "stockItems", stockItemIds: [p.stockItemId] }, effectiveFrom: "2026-09-01" });
    expect(preview).toMatchObject({ soldWithoutCost: 2, orders: 1 });
    const res = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "90.00", "2026-09-01", { applyToSold: true }));
    expect(res.completedSoldUnits).toBe(2);
    const completions = (await valuationsOf(env.db, p.stockItemId)).filter((v) => v.kind === "sale_completion");
    expect(completions.map((c) => [c.occurredOn, c.value])).toEqual([["2026-09-10", "180.00"]]);
  });

  it("F4: a manual cost in EUR is converted at each sale's date — «до вже проданих» = rebuild from zero; the same cost re-saved with «recompute» → no adjustment", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 1);
    await manualRate(env.db, "CHF", "2026-09-01", "45.0000");
    await manualRate(env.db, "CHF", "2026-10-10", "48.0000");
    const r = await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 1, reason: "found" });
    const s = await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -1, orderId: o.orderId, orderLineItemId: o.lineId });
    await backdate(env.db, [r.id], "2026-08-20");
    await backdate(env.db, [s.id], "2026-10-10");
    await rebuild();
    await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "10.00", "2026-09-01", { currency: "CHF", applyToSold: true }));
    const completion = (await valuationsOf(env.db, p.stockItemId)).find((v) => v.kind === "sale_completion")!;
    expect(completion).toMatchObject({ occurredOn: "2026-10-10", value: "480.00" });
    const again = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "10.00", "2026-09-01", { currency: "CHF", recomputeStandard: true }));
    expect(again.recomputed).toBe(0);
    await rebuild();
    const sale = (await valuationsOf(env.db, p.stockItemId)).find((v) => v.kind === "outflow")!;
    expect(sale).toMatchObject({ value: "480.00", valueSource: "owner_standard" });
  });

  it("F10: recompute also covers sold units completed «до вже проданих» at the previous manual cost (R2, change date)", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 5);
    const a = await move(env.db, { stockItemId: p.stockItemId, type: "opening", onHandDelta: 5, idempotencyKey: `opening:f10:${p.stockItemId}` });
    const s = await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -5, orderId: o.orderId, orderLineItemId: o.lineId });
    await backdate(env.db, [a.id], "2026-09-01");
    await backdate(env.db, [s.id], "2026-09-10");
    await rebuild();
    const first = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "90.00", "2026-09-01", { applyToSold: true }));
    expect(first.completedSoldUnits).toBe(5);
    const second = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "100.00", "2026-09-01", { recomputeStandard: true }));
    expect(second.recomputed).toBe(1);
    const adj = (await entriesOf(env.db, { orderId: o.orderId })).filter((e) => e.sourceType === "cost_adjustment");
    expect(adj.map((e) => [e.category, e.amount, e.quantity, e.recognizedOn])).toEqual([["cogs_adjustment", "-50.00", 5, today()]]);
    // Ще раз ту саму 100.00 — нічого нового (попередні коригування враховано).
    const third = await saveManualCost(env.ctx(OWNER), costInput(p.stockItemId, "100.00", "2026-09-01", { recomputeStandard: true }));
    expect(third.recomputed).toBe(0);
  });
});

describe("F5 — model × colour (в) counts units completed later (Σ cogs / Σ quantity)", () => {
  it("G18 sequence + owner 90.00 «до вже проданих», entries posted as WP4 → sold 7 units, 650.00, average 92.86", async () => {
    const item = await product(env.db, { model: "F5-M", color: "Blue" });
    const o = await order(env.db, item.variantId, 7);
    const a = await move(env.db, { stockItemId: item.stockItemId, type: "opening", onHandDelta: 5, idempotencyKey: `opening:f5:${item.stockItemId}` });
    const b = await move(env.db, { stockItemId: item.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o.orderId, orderLineItemId: o.lineId });
    const c = await move(env.db, { stockItemId: item.stockItemId, type: "receipt_production", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "production_receipt" });
    const d = await move(env.db, { stockItemId: item.stockItemId, type: "consume_sale", onHandDelta: -4, orderId: o.orderId, orderLineItemId: o.lineId });
    await backdate(env.db, [a.id], "2026-09-01");
    await backdate(env.db, [b.id], "2026-09-10");
    await backdate(env.db, [c.id], "2026-09-15");
    await backdate(env.db, [d.id], "2026-09-20");
    await rebuild();
    await saveManualCost(env.ctx(OWNER), costInput(item.stockItemId, "90.00", "2026-09-01", { applyToSold: true }));
    const facts = (await loadOrderCostingFacts(env.db, o.orderId)).facts;
    await env.db.transaction((tx) => postEntries(tx, SYSTEM_ACTOR, costingEntriesForOrder(o.orderId, facts, { recognizedOn: "2026-09-20", excludedTestOrder: false })));
    const rows = (await modelColorCosts(env.ctx(OWNER), { from: "2026-09-01", to: "2026-09-30", today: today() })).rows;
    expect(rows.find((r) => r.model === "F5-M" && r.color === "Blue")!.sold).toEqual({ qty: 7, value: "650.00", average: "92.86" });
  });
});

describe("F6 — valuation currency with 0 decimals (JPY): every share is whole yen, the stock flow never fails", () => {
  let jpy: CostEnv;
  beforeAll(async () => {
    jpy = await openCostEnv();
    await saveFinanceSettings(jpy.ctx(OWNER), { valuationCurrency: "JPY" });
  });
  afterAll(async () => {
    await jpy.close();
  });

  it("receipts 3 × 1000 and 1 × 1001 JPY, adjustment −1, sale 2 → whole-yen values, Σ = 4001", async () => {
    const p = await product(jpy.db);
    await move(jpy.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 3, unitCost: "1000.00", costCurrency: "JPY", reason: "purchase" });
    await move(jpy.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 1, unitCost: "1001.00", costCurrency: "JPY", reason: "purchase" });
    await move(jpy.db, { stockItemId: p.stockItemId, type: "adjustment", onHandDelta: -1, reason: "stocktake" });
    const o = await order(jpy.db, p.variantId, 2);
    await move(jpy.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
    const vals = await valuationsOf(jpy.db, p.stockItemId);
    for (const v of vals) {
      if (v.value !== null) expect(toMinor(v.value) % 100n, `${v.kind} ${v.value}`).toBe(0n);
      if (v.knownValueAfter !== null) expect(toMinor(v.knownValueAfter) % 100n).toBe(0n);
    }
    const loss = (await entriesOf(jpy.db, { stockItemId: p.stockItemId })).filter((e) => e.category === "inventory_loss");
    expect(loss.map((e) => [e.amount, e.currency])).toEqual([["-1000.00", "JPY"]]);
    const s = (await costState(jpy.db, p.stockItemId))!;
    expect(s).toMatchObject({ currency: "JPY", knownQty: 1 });
    const out = vals.filter((v) => v.kind === "outflow").reduce((a, v) => a + toMinor(v.value ?? "0.00"), 0n);
    expect(out + toMinor(s.knownValue)).toBe(400100n);
    const [entryRow] = await jpy.db.select().from(financeEntries).where(and(eq(financeEntries.stockItemId, p.stockItemId), eq(financeEntries.category, "inventory_loss")));
    expect(entryRow).toBeTruthy();
    expect((await jpy.db.select().from(inventoryValuations).where(eq(inventoryValuations.stockItemId, p.stockItemId))).length).toBe(4);
  });
});

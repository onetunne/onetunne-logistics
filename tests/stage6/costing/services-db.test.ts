/**
 * Етап 6, WP2: сервіси собівартості на БД (docs/stage6-design.md §6.5–§6.7, §6.8; золоті G5, G18; F8 — працівник 403):
 * ручна собівартість «до вже проданих» / «до залишку», завершення повернутих одиниць, переоцінка партії через справжні
 * потоки виробництва (updateBatchCosts / closeBatch), повернення через receiveStock (обидва записи етапу 5), «Списати
 * невикористані витрати партії», вартість запасів на дату, собівартість моделі × кольору.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { financeChangeLog, financeEntries, financeExpenses, inventoryValuations, productionBatchLines, productionBatches, stockItemCosts } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { rebuildValuationForDemo } from "~/modules/costing/backfill.server";
import { completeFxPendingLayers } from "~/modules/costing/fx-pending.server";
import { writeOffBatchCosts } from "~/modules/costing/batch-writeoff.server";
import { manualCostPreview, saveManualCost } from "~/modules/costing/manual-costs.server";
import { costingEntriesForOrder, loadOrderCostingFacts } from "~/modules/costing/order-facts.server";
import { costsAttention, inventoryValueAt, modelColorCosts } from "~/modules/costing/queries.server";
import { ownerStandardCost } from "~/modules/costing/forecast.server";
import { postEntries } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { cancelBatch, closeBatch, createBatch, receiveProduction, startProduction, updateBatchCosts } from "~/modules/production/batches.server";
import { receiveStock } from "~/modules/warehouse/operations.server";
import { OWNER, STAFF } from "../../helpers";
import { ensureStockItemForVariant } from "~/modules/inventory/ledger.server";
import { insertProduct, stockItemFor } from "../../stage5/helpers";
import { backdate, costState, entriesOf, manualRate, move, openCostEnv, order, product, valuationsOf, type CostEnv } from "./db-helpers";
import { toMinor as toMinorStr } from "~/lib/money";

let env: CostEnv;
beforeAll(async () => {
  env = await openCostEnv();
});
afterAll(async () => {
  await env.close();
});

const NOV25 = new Date("2026-11-25T10:00:00Z");

async function rebuild() {
  await env.db.transaction((tx) => rebuildValuationForDemo(tx, { mode: "demo" }));
}

describe("G5 / G18 — opening completion «до вже проданих», stock value on a date, model × colour", () => {
  let item: Awaited<ReturnType<typeof product>>;
  let sales: { s1: string; s2: string };
  beforeAll(async () => {
    item = await product(env.db, { model: "M1", color: "Black" });
    const o = await order(env.db, item.variantId, 7);
    const a = await move(env.db, { stockItemId: item.stockItemId, type: "opening", onHandDelta: 5, idempotencyKey: `opening:g18:${item.stockItemId}` });
    const b = await move(env.db, { stockItemId: item.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o.orderId });
    const c = await move(env.db, { stockItemId: item.stockItemId, type: "receipt_production", onHandDelta: 10, unitCost: "100.00", costCurrency: "UAH", reason: "production_receipt" });
    const d = await move(env.db, { stockItemId: item.stockItemId, type: "consume_sale", onHandDelta: -4, orderId: o.orderId });
    await backdate(env.db, [a.id], "2026-09-01");
    await backdate(env.db, [b.id], "2026-09-10");
    await backdate(env.db, [c.id], "2026-09-15");
    await backdate(env.db, [d.id], "2026-09-20");
    // Білий колір тієї самої моделі: 2 × 115.00.
    const white = await product(env.db, { model: "M1", color: "White" });
    const w = await move(env.db, { stockItemId: white.stockItemId, type: "receipt_manual", onHandDelta: 2, unitCost: "115.00", costCurrency: "UAH", reason: "purchase" });
    await backdate(env.db, [w.id], "2026-09-15");
    await rebuild();
    const vals = await valuationsOf(env.db, item.stockItemId);
    sales = { s1: vals.find((v) => v.movementId === b.id)!.id, s2: vals.find((v) => v.movementId === d.id)!.id };
  });

  it("before completion: sale 4 = 2 unknown + 200.00; pool 8 on 800.00", async () => {
    const vals = await valuationsOf(env.db, item.stockItemId);
    expect(vals.find((v) => v.id === sales.s2)).toMatchObject({ unknownQty: 2, knownQty: 2, value: "200.00", occurredOn: "2026-09-20" });
    expect(await costState(env.db, item.stockItemId)).toMatchObject({ knownQty: 8, knownValue: "800.00", unknownQty: 0 });
  });

  it("preview: «Без собівартості: на складі 0, продано 5 (1 замовлення)»", async () => {
    const p = await manualCostPreview(env.ctx(OWNER), { target: { kind: "stockItems", stockItemIds: [item.stockItemId] }, effectiveFrom: "2026-09-01" });
    expect(p).toEqual({ items: 1, onHandWithoutCost: 0, soldWithoutCost: 5, orders: 1, soldAwaitingReceipt: 0 });
  });

  it("staff (and a forged staff with finance.view) → 403 on every costing service", async () => {
    await expect(saveManualCost(env.ctx(STAFF), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [item.stockItemId] },
      unitCost: "90.00",
      currency: "UAH",
      effectiveFrom: "2026-09-01",
      applyToStock: false,
      applyToSold: true,
    })).rejects.toMatchObject({ status: 403 });
    await expect(manualCostPreview(env.ctx(STAFF), { target: { kind: "stockItems", stockItemIds: [item.stockItemId] }, effectiveFrom: "2026-09-01" })).rejects.toMatchObject({ status: 403 });
    await expect(inventoryValueAt(env.ctx(STAFF), { date: "2026-11-30" })).rejects.toMatchObject({ status: 403 });
  });

  it("owner 90.00 from 01.09 «до вже проданих» → completions 270.00 (10.09) and 180.00 (20.09); 5 × 90 + 1000 = 270 + 180 + 200 + 800", async () => {
    const op = randomUUID();
    const r = await saveManualCost(env.ctx(OWNER, { now: NOV25 }), {
      operationId: op,
      target: { kind: "stockItems", stockItemIds: [item.stockItemId] },
      unitCost: "90.00",
      currency: "UAH",
      effectiveFrom: "2026-09-01",
      applyToStock: false,
      applyToSold: true,
    });
    expect(r).toMatchObject({ duplicate: false, items: 1, completedSoldUnits: 5, completedStockUnits: 0 });
    const completions = (await valuationsOf(env.db, item.stockItemId)).filter((v) => v.kind === "sale_completion");
    expect(completions.map((c) => [c.occurredOn, c.value, c.knownQtyAfter])).toEqual([
      ["2026-09-10", "270.00", null],
      ["2026-09-20", "180.00", null],
    ]);
    expect(await costState(env.db, item.stockItemId)).toMatchObject({ knownQty: 8, knownValue: "800.00" });
    // Повтор тієї самої форми — duplicate, нічого нового.
    const again = await saveManualCost(env.ctx(OWNER, { now: NOV25 }), {
      operationId: op,
      target: { kind: "stockItems", stockItemIds: [item.stockItemId] },
      unitCost: "90.00",
      currency: "UAH",
      effectiveFrom: "2026-09-01",
      applyToStock: false,
      applyToSold: true,
    });
    expect(again.duplicate).toBe(true);
    // Історія змін (до → після) і рядок stock_item_costs.
    const log = await env.db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "stock_item_cost"), eq(financeChangeLog.entityId, item.stockItemId)));
    expect(log[0]!.after).toMatchObject({ unitCost: "90.00", currency: "UAH", effectiveFrom: "2026-09-01", applyToSold: true });
    expect(await ownerStandardCost(env.db, item.stockItemId, "2026-09-05")).toMatchObject({ unitCost: "90.00", currency: "UAH" });
    // Факти замовлення (WP4): собівартість −100 (2 × 0 + …) → −200 + завершення −270 −180.
    const o = (await env.db.select().from(inventoryValuations).where(eq(inventoryValuations.id, sales.s1)))[0]!.orderId!;
    const entries = costingEntriesForOrder(o, (await loadOrderCostingFacts(env.db, o)).facts, { recognizedOn: "2026-09-20", excludedTestOrder: false });
    expect(entries.map((e) => [e.category, e.amount, e.isLateCompletion ?? false]).sort()).toEqual([
      ["cogs", "-180.00", true],
      ["cogs", "-200.00", false],
      ["cogs", "-270.00", true],
    ]);
    const total = entries.reduce((s, e) => s + Number(e.amount.replace(".", "")), 0);
    // 5 × 90 + 1000 = 1450 = 270 + 180 + 200 + 800 (пул).
    expect(-total + 80000).toBe(145000);
  });

  it("G18: stock value on 12.09 = 0.00 + 2 without cost (the 25.11 completion does not change the pool); 16.09 = 1000.00 + 2; 21.09 and 30.11 = 800.00", async () => {
    const at = async (date: string) => inventoryValueAt(env.ctx(OWNER), { date });
    const v12 = await at("2026-09-12");
    // Лише ця позиція має рухи до 15.09 (білий — з 15.09).
    expect(v12.products).toMatchObject({ value: "0.00", units: 0 });
    expect(v12.unitsWithoutCost).toBe(2);
    const v16 = await at("2026-09-16");
    expect(v16.products.value).toBe("1230.00"); // 1000.00 чорний + 230.00 білий
    expect(v16.unitsWithoutCost).toBe(2);
    const v21 = await at("2026-09-21");
    expect(v21.products.value).toBe("1030.00");
    expect(v21.unitsWithoutCost).toBe(0);
    const v30 = await at("2026-11-30");
    expect(v30.products.value).toBe("1030.00");
    expect(v30.currency).toBe("UAH");
  });

  it("G18: model M1 — black 8 / 800.00, white 2 / 230.00 → model average in stock 1030 / 10 = 103.00; manual cost — own column", async () => {
    const r = await modelColorCosts(env.ctx(OWNER), { from: "2026-09-01", to: "2026-11-30", today: "2026-11-28" });
    const black = r.rows.find((x) => x.model === "M1" && x.color === "Black")!;
    const white = r.rows.find((x) => x.model === "M1" && x.color === "White")!;
    expect(black.stock).toEqual({ qty: 8, value: "800.00", average: "100.00" });
    expect(white.stock).toEqual({ qty: 2, value: "230.00", average: "115.00" });
    expect(black.manual).toEqual({ min: "90.00", max: "90.00", currency: "UAH" });
    expect(white.manual).toBeNull();
    expect(r.models.find((m) => m.model === "M1")).toEqual({ model: "M1", productTitle: null, qty: 10, value: "1030.00", average: "103.00" });
  });
});

describe("G5 — returns through receiveStock (stage-5 flows)", () => {
  it("(b) sale 3 = 2 unknown + 1 × 100; return 1 → +100; return 1 more → layer; owner 90 «до вже проданих» → sale 90 for the 1 still sold, the returned unit completes its layer (pool +2 on 190.00)", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 3);
    await move(env.db, { stockItemId: p.stockItemId, type: "opening", onHandDelta: 2, idempotencyKey: `opening:b:${p.stockItemId}` });
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 1, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -3, orderId: o.orderId, orderLineItemId: o.lineId });
    const ret = (qty: number) =>
      receiveStock(env.ctx(STAFF), { operationId: randomUUID(), stockItemId: p.stockItemId, quantity: qty, reason: "customer_return", orderId: o.orderId });
    await ret(1);
    await ret(1);
    const facts1 = (await loadOrderCostingFacts(env.db, o.orderId)).facts;
    expect(facts1.map((f) => [f.kind, f.value, f.unvaluedRemaining])).toEqual([
      ["sale", "100.00", 1],
      ["return", "100.00", 0],
      ["return", null, 0],
    ]);
    await saveManualCost(env.ctx(OWNER), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [p.stockItemId] },
      unitCost: "90.00",
      currency: "UAH",
      effectiveFrom: "2026-01-01",
      applyToStock: false,
      applyToSold: true,
    });
    const facts = (await loadOrderCostingFacts(env.db, o.orderId)).facts;
    const entries = costingEntriesForOrder(o.orderId, facts, { recognizedOn: facts[0]!.occurredOn, excludedTestOrder: false });
    const sum = entries.reduce((s, e) => s + BigInt(e.amount.replace(".", "")), 0n);
    // Собівартість замовлення 100 − 100 + 90 = 90.00 за 1 продану одиницю.
    expect(sum).toBe(-9000n);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 2, knownValue: "190.00", unknownQty: 0 });
  });

  it("damaged unit, both stage-5 records (split by Shopify restock / unsplit) → cogs_return +100.00 only; order COGS −100.00", async () => {
    for (const damagedRestockedInShopify of [true, false]) {
      const p = await product(env.db);
      const o = await order(env.db, p.variantId, 2);
      await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 2, unitCost: "100.00", costCurrency: "UAH", reason: "purchase" });
      await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId, orderLineItemId: o.lineId });
      const r = await receiveStock(env.ctx(STAFF), {
        operationId: randomUUID(),
        stockItemId: p.stockItemId,
        quantity: 1,
        defectiveQuantity: 1,
        reason: "customer_return",
        orderId: o.orderId,
        damagedRestockedInShopify,
      });
      expect(Boolean(r.returnDefect)).toBe(damagedRestockedInShopify);
      const facts = (await loadOrderCostingFacts(env.db, o.orderId)).facts;
      const entries = costingEntriesForOrder(o.orderId, facts, { recognizedOn: facts[0]!.occurredOn, excludedTestOrder: false });
      expect(entries.map((e) => [e.category, e.amount])).toEqual([
        ["cogs", "-200.00"],
        ["cogs_return", "100.00"],
      ]);
      // Парний брак повернення — не збиток.
      expect((await entriesOf(env.db, { stockItemId: p.stockItemId })).filter((e) => e.category === "inventory_loss")).toEqual([]);
      expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 1, knownValue: "100.00" });
    }
  });

  it("(a) line without consumption: stdcogs (WP4 entry) −210.00 → good return +210.00 (owner_standard); resale 210.00, total 210 not 420", async () => {
    const p = await product(env.db);
    const o = await order(env.db, p.variantId, 1);
    // Запис stdcogs позиції без списання (як проводить WP4: ключ stdcogs:<lineId>:v1, quantity 1).
    await env.db.transaction((tx) =>
      postEntries(tx, SYSTEM_ACTOR, [
        {
          idempotencyKey: financeKeys.standardCogs(o.lineId, 1),
          category: "cogs",
          recognizedOn: "2026-11-01",
          fxOn: "2026-11-01",
          amount: "-210.00",
          currency: "UAH",
          orderId: o.orderId,
          orderLineItemId: o.lineId,
          stockItemId: p.stockItemId,
          variantId: p.variantId,
          quantity: 1,
          sourceType: "owner_standard",
          sourceId: o.lineId,
          details: { quantity: 1 },
        },
      ]),
    );
    await receiveStock(env.ctx(STAFF), { operationId: randomUUID(), stockItemId: p.stockItemId, quantity: 1, reason: "customer_return", orderId: o.orderId });
    const facts = (await loadOrderCostingFacts(env.db, o.orderId)).facts;
    expect(facts).toMatchObject([{ kind: "return", value: "210.00", valueSource: "owner_standard" }]);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 1, knownValue: "210.00" });
    const o2 = await order(env.db, p.variantId, 1);
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -1, orderId: o2.orderId });
    expect((await loadOrderCostingFacts(env.db, o2.orderId)).facts[0]!.value).toBe("210.00");
  });
});

describe("G5 — batch revaluation through the production flow (§6.7)", () => {
  async function batchWithReceipt(unit: string, qty: number, extra: { extraCost?: string | null } = {}) {
    const { variantIds } = await insertProduct(env.db, `Batch item ${randomUUID().slice(0, 6)}`, [{ sku: `BI-${randomUUID().slice(0, 8)}` }]);
    const variantId = variantIds[0]!;
    const stockItemId = await stockItemFor(env.db, variantId);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "Test batch", costCurrency: "UAH", extraCost: extra.extraCost ?? null, lines: [{ variantId, quantity: qty, unitCost: unit }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: randomUUID(), lines: "remaining" });
    const [line] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    return { batchId, variantId, stockItemId, lineId: line!.id, version };
  }

  it("10 × 100, sold 4; cost → 110: Δ 100 → +60.00 to stock (pool 6 on 660.00), cogs_adjustment −40.00 (period, change date)", async () => {
    const b = await batchWithReceipt("100.00", 10);
    const o = await order(env.db, b.variantId, 4);
    await move(env.db, { stockItemId: b.stockItemId, type: "consume_sale", onHandDelta: -4, orderId: o.orderId });
    await updateBatchCosts(env.ctx(OWNER), b.batchId, await b.version(), { extraCost: null, costCurrency: "UAH", lines: [{ batchLineId: b.lineId, unitCost: "110.00" }] });
    expect(await costState(env.db, b.stockItemId)).toMatchObject({ knownQty: 6, knownValue: "660.00" });
    const adj = (await valuationsOf(env.db, b.stockItemId)).find((v) => v.kind === "revaluation")!;
    expect(adj).toMatchObject({ value: "100.00", knownValueAfter: "660.00" });
    expect(adj.details).toMatchObject({ deltaStock: "60.00", deltaSales: "40.00", deltaLoss: "0.00" });
    const e = (await entriesOf(env.db, { stockItemId: b.stockItemId })).filter((x) => x.sourceType === "cost_adjustment");
    expect(e).toMatchObject([{ category: "cogs_adjustment", amount: "-40.00", orderId: null }]);
    expect(e[0]!.idempotencyKey).toMatch(/^adj:[0-9a-f-]+:v1:sales$/);
    // Історія змін: ціна рядка до → після, Δ до залишку / до продажів.
    const log = await env.db.select().from(financeChangeLog).where(and(eq(financeChangeLog.entityType, "batch_cost"), eq(financeChangeLog.entityId, b.batchId)));
    expect(log.some((l) => (l.before as Record<string, unknown> | null)?.unitCost === "100.00" && (l.after as Record<string, unknown>).unitCost === "110.00")).toBe(true);
    expect(log.some((l) => (l.after as Record<string, unknown>).deltaStock === "60.00" && (l.after as Record<string, unknown>).deltaSales === "40.00")).toBe(true);
    // Повтор без зміни — нічого нового (Δ = 0).
    await updateBatchCosts(env.ctx(OWNER), b.batchId, await b.version(), { extraCost: null, costCurrency: "UAH", lines: [] });
    expect((await valuationsOf(env.db, b.stockItemId)).filter((v) => v.kind === "revaluation")).toHaveLength(1);
  });

  it("(В) pool 5 × 10, then A 10 × 100, sold 10, A → 0: Δ_stock −333.33 (pool 5 on 16.67), cogs +666.67", async () => {
    const b = await batchWithReceipt("100.00", 10);
    // Пул до A: 5 × 10 — окреме надходження раніше за партію неможливе після неї, тож кладемо його й переоцінюємо історію.
    const pre = await move(env.db, { stockItemId: b.stockItemId, type: "receipt_manual", onHandDelta: 5, unitCost: "10.00", costCurrency: "UAH", reason: "purchase" });
    const receiptMv = (await valuationsOf(env.db, b.stockItemId)).find((v) => v.kind === "inflow" && v.movementId !== pre.id)!.movementId!;
    await backdate(env.db, [pre.id], "2026-10-01");
    await backdate(env.db, [receiptMv], "2026-10-02");
    const o = await order(env.db, b.variantId, 10);
    const sale = await move(env.db, { stockItemId: b.stockItemId, type: "consume_sale", onHandDelta: -10, orderId: o.orderId });
    await backdate(env.db, [sale.id], "2026-10-03");
    await rebuild();
    expect(await costState(env.db, b.stockItemId)).toMatchObject({ knownQty: 5, knownValue: "350.00" });
    await updateBatchCosts(env.ctx(OWNER), b.batchId, await b.version(), { extraCost: null, costCurrency: "UAH", lines: [{ batchLineId: b.lineId, unitCost: "0.00" }] });
    expect(await costState(env.db, b.stockItemId)).toMatchObject({ knownQty: 5, knownValue: "16.67" });
    const e = (await entriesOf(env.db, { stockItemId: b.stockItemId })).filter((x) => x.sourceType === "cost_adjustment" && x.idempotencyKey.includes(":v1:"));
    expect(e).toMatchObject([{ category: "cogs_adjustment", amount: "666.67" }]);
  });

  it("EUR batch without a rate (fx_pending) → completed by a manual rate; a later cost change revalues from the completion: pool share and sold share", async () => {
    const { variantIds } = await insertProduct(env.db, `EUR item ${randomUUID().slice(0, 6)}`, [{ sku: `EU-${randomUUID().slice(0, 8)}` }]);
    const variantId = variantIds[0]!;
    const stockItemId = await stockItemFor(env.db, variantId);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "EUR batch", costCurrency: "EUR", lines: [{ variantId, quantity: 4, unitCost: "10.00" }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: randomUUID(), lines: "remaining" });
    const o = await order(env.db, variantId, 1);
    await move(env.db, { stockItemId, type: "consume_sale", onHandDelta: -1, orderId: o.orderId });
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 0, unknownQty: 3 });
    const receiptDate = (await valuationsOf(env.db, stockItemId)).find((v) => v.kind === "inflow")!.occurredOn;
    await manualRate(env.db, "EUR", receiptDate, "48.5000");
    await env.db.transaction((tx) => completeFxPendingLayers(tx, SYSTEM_ACTOR, { currency: "EUR" }));
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 3, knownValue: "1455.00" });
    const [line] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    await updateBatchCosts(env.ctx(OWNER), batchId, await version(), { extraCost: null, costCurrency: "EUR", lines: [{ batchLineId: line!.id, unitCost: "11.00" }] });
    // Ціль 44.00 EUR × 48.50 = 2134.00; проведено 1940.00 → Δ 194.00: 3 з 4 одиниць — у пул (+145.50), 1 продана — −48.50.
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 3, knownValue: "1600.50" });
    const adj = (await entriesOf(env.db, { stockItemId })).filter((e) => e.sourceType === "cost_adjustment");
    expect(adj).toMatchObject([{ category: "cogs_adjustment", amount: "-48.50" }]);
  });

  it("extra cost on two lines: Σ line targets = producedTotal exactly (batchCostSummary.lines[].producedValue)", async () => {
    const { batchCostSummary } = await import("~/modules/production/calc");
    const s = batchCostSummary(
      [
        { id: "a", ordered: 3, received: 3, defective: 0, unitCost: "10.00", costCurrency: "UAH" },
        { id: "b", ordered: 7, received: 6, defective: 1, unitCost: "20.00", costCurrency: "UAH" },
      ],
      "10.00",
      "UAH",
      "received",
    );
    expect(s.lines.map((l) => l.producedValue)).toEqual(["33.00", "147.00"]);
    expect(s.producedTotal).toBe("180.00");
    const odd = batchCostSummary(
      [
        { id: "a", ordered: 1, received: 1, defective: 0, unitCost: "1.00", costCurrency: "UAH" },
        { id: "b", ordered: 1, received: 1, defective: 0, unitCost: "1.00", costCurrency: "UAH" },
        { id: "c", ordered: 1, received: 1, defective: 0, unitCost: "1.00", costCurrency: "UAH" },
      ],
      "1.00",
      "UAH",
      "received",
    );
    expect(odd.lines.map((l) => l.producedValue)).toEqual(["1.34", "1.33", "1.33"]);
    expect(odd.lines.reduce((a, l) => a + Number(l.producedValue!.replace(".", "")), 0)).toBe(400);
  });

  it("closeBatch with under-delivery (staff with delegated production.manage) revalues without a finance check; write-off of unused batch costs → inventory_loss production_cancelled", async () => {
    const { variantIds } = await insertProduct(env.db, `Close item ${randomUUID().slice(0, 6)}`, [{ sku: `CI-${randomUUID().slice(0, 8)}` }]);
    const variantId = variantIds[0]!;
    await ensureStockItemForVariant(env.db, variantId);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "Under-delivery", costCurrency: "UAH", extraCost: "100.00", lines: [{ variantId, quantity: 10, unitCost: "50.00" }] });
    const version = async () => (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await startProduction(ctx, batchId, await version());
    const [line] = await env.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
    await receiveProduction(env.ctx(STAFF), batchId, { idempotencyKey: randomUUID(), lines: [{ batchLineId: line!.id, good: 5, defective: 0 }] });
    const delegated = { ...STAFF, permissions: new Set([...STAFF.permissions, "production.manage" as const]) };
    await closeBatch(env.ctx(delegated), batchId, await version());
    // Закрито: оплачується лише виготовлене (5): ціль = 5 × 50 + 100 = 350; проведено 5 × (50 + 100/10) = 300 → +50 у пул.
    const stockItemId = (await valuationsOf(env.db, (await ensureStockItemForVariant(env.db, variantId))))[0]!.stockItemId;
    expect(await costState(env.db, stockItemId)).toMatchObject({ knownQty: 5, knownValue: "350.00" });
    // Працівник не може списати витрати (finance.manage).
    await expect(writeOffBatchCosts(env.ctx(STAFF), { operationId: randomUUID(), batchId, amount: "120.00", currency: "UAH", date: "2026-11-20", reason: "Оплачено виробнику за невироблене" })).rejects.toMatchObject({ status: 403 });
    const op = randomUUID();
    const w = await writeOffBatchCosts(env.ctx(OWNER), { operationId: op, batchId, amount: "120.00", currency: "UAH", date: "2026-11-20", reason: "Оплачено виробнику за невироблене" });
    expect(w.duplicate).toBe(false);
    const [exp] = await env.db.select().from(financeExpenses).where(eq(financeExpenses.id, w.expenseId));
    expect(exp).toMatchObject({ category: "inventory_loss", amount: "120.00", productionBatchId: batchId, operationId: op });
    const [entry] = await env.db.select().from(financeEntries).where(eq(financeEntries.sourceId, w.expenseId));
    expect(entry).toMatchObject({ category: "inventory_loss", amount: "-120.00", recognizedOn: "2026-11-20", idempotencyKey: `exp:${w.expenseId}:v1` });
    expect(entry!.details).toMatchObject({ kind: "production_cancelled", productionBatchId: batchId });
    expect((await writeOffBatchCosts(env.ctx(OWNER), { operationId: op, batchId, amount: "120.00", currency: "UAH", date: "2026-11-20", reason: "x" })).duplicate).toBe(true);
  });

  it("cancelled batch → write-off allowed; an active (received) batch → refused", async () => {
    const { variantIds } = await insertProduct(env.db, `Cancel item ${randomUUID().slice(0, 6)}`, [{ sku: `CA-${randomUUID().slice(0, 8)}` }]);
    const ctx = env.ctx(OWNER);
    const { batchId } = await createBatch(ctx, { title: "Cancelled", costCurrency: "UAH", lines: [{ variantId: variantIds[0]!, quantity: 3, unitCost: "10.00" }] });
    const v = (await env.db.select().from(productionBatches).where(eq(productionBatches.id, batchId)))[0]!.version;
    await cancelBatch(ctx, batchId, v);
    const ok = await writeOffBatchCosts(ctx, { operationId: randomUUID(), batchId, amount: "30.00", currency: "UAH", date: "2026-11-20", reason: "Передоплата" });
    expect(ok.duplicate).toBe(false);
    const active = await batchWithReceipt("10.00", 2);
    await expect(writeOffBatchCosts(ctx, { operationId: randomUUID(), batchId: active.batchId, amount: "10.00", currency: "UAH", date: "2026-11-20", reason: "x" })).rejects.toMatchObject({ code: "financeCosts.error.writeOffNotAllowed" });
  });
});

describe("attention list and model × colour bulk cost", () => {
  it("items without cost on hand are listed; bulk model × colour writes one row per variant (manual:<op>:<variantId>) and completes the stock", async () => {
    const { variantIds } = await insertProduct(env.db, "Bulk model", [
      { sku: `BM-1-${randomUUID().slice(0, 6)}`, model: "BULK-M", color: "Red" },
      { sku: `BM-2-${randomUUID().slice(0, 6)}`, model: "BULK-M", color: "Red" },
    ]);
    const items = await Promise.all(variantIds.map((v) => ensureStockItemForVariant(env.db, v)));
    for (const s of items) await move(env.db, { stockItemId: s, type: "receipt_manual", onHandDelta: 3, reason: "found" });
    const attention = await costsAttention(env.ctx(OWNER));
    expect(attention.filter((a) => items.includes(a.stockItemId)).map((a) => a.onHandWithoutCost)).toEqual([3, 3]);
    const op = randomUUID();
    const r = await saveManualCost(env.ctx(OWNER), {
      operationId: op,
      target: { kind: "modelColor", model: "BULK-M", color: "Red" },
      unitCost: "25.00",
      currency: "UAH",
      effectiveFrom: "2026-11-01",
      applyToStock: true,
      applyToSold: false,
    });
    expect(r).toMatchObject({ items: 2, completedStockUnits: 6 });
    const rows = await env.db.select().from(stockItemCosts).where(eq(stockItemCosts.source, "bulk_model_color"));
    expect(rows.map((x) => x.idempotencyKey).sort()).toEqual(variantIds.map((v) => `manual:${op}:${v}`).sort());
    for (const s of items) expect(await costState(env.db, s)).toMatchObject({ knownQty: 3, knownValue: "75.00", unknownQty: 0 });
    expect((await costsAttention(env.ctx(OWNER))).filter((a) => items.includes(a.stockItemId))).toEqual([]);
  });
});

describe("manual cost as a fact (§6.5 item 2, D-20) and «recompute» (§6.6)", () => {
  it("line without consumption: manual cost 210.00 effective before shipment × 2 units = −420.00 (owner_standard, WP4 stdcogs)", async () => {
    const { variantIds } = await insertProduct(env.db, `Std item ${randomUUID().slice(0, 6)}`, [{ sku: `ST-${randomUUID().slice(0, 8)}` }]);
    const stockItemId = await ensureStockItemForVariant(env.db, variantIds[0]!);
    await saveManualCost(env.ctx(OWNER), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [stockItemId] },
      unitCost: "210.00",
      currency: "UAH",
      effectiveFrom: "2026-09-01",
      applyToStock: false,
      applyToSold: false,
    });
    const cost = await ownerStandardCost(env.db, stockItemId, "2026-09-10");
    expect(cost).toMatchObject({ unitCost: "210.00", currency: "UAH", effectiveFrom: "2026-09-01" });
    expect(-(toMinorStr(cost!.unitCost) * 2n)).toBe(-42000n);
    // Раніше за effective_from — ручної собівартості немає (не 0).
    expect(await ownerStandardCost(env.db, stockItemId, "2026-08-31")).toBeNull();
  });

  it("outflows valued at the previous manual cost are recalculated on the change date when «recompute» is on (R2)", async () => {
    const p = await product(env.db);
    await saveManualCost(env.ctx(OWNER), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [p.stockItemId] },
      unitCost: "90.00",
      currency: "UAH",
      effectiveFrom: "2026-01-01",
      applyToStock: false,
      applyToSold: false,
    });
    const o = await order(env.db, p.variantId, 2);
    await move(env.db, { stockItemId: p.stockItemId, type: "opening", onHandDelta: 3, idempotencyKey: `opening:std:${p.stockItemId}` });
    await move(env.db, { stockItemId: p.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o.orderId });
    // Відкриття оцінено за ручною собівартістю (відомі одиниці): продаж 2 × 90 = 180.00 з пулу.
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ knownQty: 1, knownValue: "90.00" });
    const r = await saveManualCost(env.ctx(OWNER), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [p.stockItemId] },
      unitCost: "100.00",
      currency: "UAH",
      effectiveFrom: "2026-01-01",
      applyToStock: false,
      applyToSold: false,
      recomputeStandard: true,
    });
    // Пул (відкриття за ручною собівартістю) не має одиниць «за стандартом у виходах» — перерахунок стосується лише
    // виходів, оцінених ручною собівартістю з невідомих шарів (details.standardQty); тут таких немає.
    expect(r.recomputed).toBe(0);
    const q = await product(env.db);
    const o2 = await order(env.db, q.variantId, 2);
    await move(env.db, { stockItemId: q.stockItemId, type: "opening", onHandDelta: 3, idempotencyKey: `opening:std2:${q.stockItemId}` });
    await saveManualCost(env.ctx(OWNER), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [q.stockItemId] },
      unitCost: "90.00",
      currency: "UAH",
      effectiveFrom: "2026-01-01",
      applyToStock: false,
      applyToSold: false,
    });
    await move(env.db, { stockItemId: q.stockItemId, type: "consume_sale", onHandDelta: -2, orderId: o2.orderId });
    const sale = (await valuationsOf(env.db, q.stockItemId)).find((v) => v.kind === "outflow")!;
    expect(sale).toMatchObject({ value: "180.00", valueSource: "owner_standard" });
    const r2 = await saveManualCost(env.ctx(OWNER), {
      operationId: randomUUID(),
      target: { kind: "stockItems", stockItemIds: [q.stockItemId] },
      unitCost: "100.00",
      currency: "UAH",
      effectiveFrom: "2026-01-01",
      applyToStock: false,
      applyToSold: false,
      recomputeStandard: true,
    });
    expect(r2.recomputed).toBe(1);
    const adj = (await entriesOf(env.db, { orderId: o2.orderId })).filter((e) => e.sourceType === "cost_adjustment");
    expect(adj).toMatchObject([{ category: "cogs_adjustment", amount: "-20.00", quantity: 2 }]);
  });
});

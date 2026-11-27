/**
 * R6 follow-up (C-R6-1, C-R6-2, C-R6-4): «один operationId — одна операція» для write-команд складу діє й при
 * ПАРАЛЕЛЬНИХ викликах. Перевірка uuid і запис сервісу виконуються в одній транзакції під блокуванням за operationId
 * (pg_advisory_xact_lock), тож:
 * - той самий uuid для іншої позиції партії одночасно → одне надходження, другий запит — operationReused (не «replay»
 *   з чужими кількостями);
 * - той самий uuid у двох різних командах одночасно → записано лише одну операцію; повтор переможця — replay;
 * - запис іншого викликача (не команди) між перевіркою й сервісом не видається за повтор цього запиту (лише PostgreSQL:
 *   детерміноване перемежування через блокування рядка партії/балансу).
 * C-R6-4: невідомий номер партії / замовлення — зрозумілий текст бота, а не «Сторінку не знайдено».
 * Дані вигадані.
 */
import { randomUUID } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inventoryMovements, productionBatchLines, productionBatches, productionReceipts } from "~/db/schema";
import { applyMaterialStock } from "~/modules/packaging/materials.server";
import { createBatch, receiveProduction, startProduction } from "~/modules/production/batches.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import {
  formatWarehouseCommandOutcome,
  runWarehouseCommand,
  type MaterialReceiveResult,
  type ProductionReceiptCommandResult,
  type StockChangeResult,
  type WarehouseCommandOutcome,
} from "~/modules/warehouse/commands.server";
import type { Db } from "~/db/client.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { balance, insertMaterial, insertProduct, stockItemFor } from "./helpers";

let env: TestEnv;
const items = { a: "", b: "", aStock: "", bStock: "" };
let boxA: { materialId: string; stockItemId: string };
let boxB: { materialId: string; stockItemId: string };
const onPostgres = Boolean(process.env.TEST_DATABASE_URL);

beforeAll(async () => {
  env = await createTestEnv();
  const db = env.handle.db;
  const p = await insertProduct(db, "Operation Lock Test", [
    { sku: "OPL-A", color: "Amber" },
    { sku: "OPL-B", color: "Basalt" },
  ]);
  [items.a, items.b] = p.variantIds as [string, string];
  items.aStock = await stockItemFor(db, items.a);
  items.bStock = await stockItemFor(db, items.b);
  boxA = await insertMaterial(db, "opl_box_a");
  boxB = await insertMaterial(db, "opl_box_b");
});
afterAll(async () => {
  await env.close();
});

const run = (name: string, input: unknown, opts: { confirmed?: boolean } = {}) =>
  runWarehouseCommand(env.ctx(STAFF), name, input, { via: "telegram", ...opts });

const outcomeOf = (o: WarehouseCommandOutcome): string =>
  o.status === "ok" ? String((o.data as { result: string }).result) : o.status === "error" ? o.code : o.status;

async function newBatch(): Promise<{ id: string; number: string }> {
  const ctx = env.ctx(OWNER);
  const b = await createBatch(ctx, {
    title: "Operation lock batch",
    lines: [
      { variantId: items.a, quantity: 10, unitCost: "50.00" },
      { variantId: items.b, quantity: 10, unitCost: "50.00" },
    ],
    costCurrency: "UAH",
  });
  await startProduction(ctx, b.batchId, 1);
  return { id: b.batchId, number: b.number };
}

const receiptsFor = (operationId: string) => env.handle.db.select().from(productionReceipts).where(eq(productionReceipts.idempotencyKey, operationId));
const manualMovements = (operationId: string) =>
  env.handle.db
    .select({ key: inventoryMovements.idempotencyKey, onHandDelta: inventoryMovements.onHandDelta })
    .from(inventoryMovements)
    .where(like(inventoryMovements.idempotencyKey, `${inventoryKeys.manual(operationId)}%`));

describe("parallel write commands with one operationId", () => {
  it("receive_production: the same uuid for other lines at the same time — one receipt, the other request is operationReused", async () => {
    for (let round = 0; round < 3; round++) {
      const batch = await newBatch();
      const operationId = randomUUID();
      const before = { a: await balance(env.handle.db, items.aStock), b: await balance(env.handle.db, items.bStock) };
      const results = await Promise.all([
        run("receive_production", { batchNumber: batch.number, lines: [{ sku: "OPL-A", good: 2 }], operationId }, { confirmed: true }),
        run("receive_production", { batchNumber: batch.number, lines: [{ sku: "OPL-B", good: 3 }], operationId }, { confirmed: true }),
      ]);
      expect(results.map(outcomeOf).sort()).toEqual(["received", "warehouse.error.operationReused"]);
      // Переможець отримав СВОЇ кількості; переможений нічого не записав.
      const winner = results.findIndex((r) => r.status === "ok");
      const data = (results[winner] as { data: ProductionReceiptCommandResult }).data;
      expect(data.good).toBe(winner === 0 ? 2 : 3);
      expect(await receiptsFor(operationId)).toHaveLength(1);
      const after = { a: await balance(env.handle.db, items.aStock), b: await balance(env.handle.db, items.bStock) };
      expect(after.a.onHand - before.a.onHand).toBe(winner === 0 ? 2 : 0);
      expect(after.b.onHand - before.b.onHand).toBe(winner === 0 ? 0 : 3);
      // Повтор переможця — replay, переможеного — і далі operationReused.
      const retry = [
        { batchNumber: batch.number, lines: [{ sku: "OPL-A", good: 2 }], operationId },
        { batchNumber: batch.number, lines: [{ sku: "OPL-B", good: 3 }], operationId },
      ];
      expect(outcomeOf(await run("receive_production", retry[winner], { confirmed: true }))).toBe("replay");
      expect(outcomeOf(await run("receive_production", retry[1 - winner], { confirmed: true }))).toBe("warehouse.error.operationReused");
    }
  });

  it("receive_stock + material_receive with one uuid at the same time: only one is recorded; the winner's retry is a replay", async () => {
    for (let round = 0; round < 3; round++) {
      const operationId = randomUUID();
      const stock = { sku: "OPL-A", quantity: 1, reason: "found", operationId };
      const material = { code: "opl_box_a", quantity: 5, operationId };
      const before = { a: await balance(env.handle.db, items.aStock), box: await balance(env.handle.db, boxA.stockItemId) };
      const results = await Promise.all([run("receive_stock", stock, { confirmed: true }), run("material_receive", material, { confirmed: true })]);
      expect(results.map(outcomeOf).sort()).toEqual(["received", "warehouse.error.operationReused"]);
      expect(await manualMovements(operationId)).toHaveLength(1);
      const stockWon = results[0]!.status === "ok";
      const after = { a: await balance(env.handle.db, items.aStock), box: await balance(env.handle.db, boxA.stockItemId) };
      expect(after.a.onHand - before.a.onHand).toBe(stockWon ? 1 : 0);
      expect(after.box.onHand - before.box.onHand).toBe(stockWon ? 0 : 5);
      // Повтор після тайм-ауту бота — «уже виконано», а не «почніть нову операцію» (яка оприбуткувала б удруге).
      const retry = stockWon ? await run("receive_stock", stock, { confirmed: true }) : await run("material_receive", material, { confirmed: true });
      expect(outcomeOf(retry)).toBe("replay");
      if (stockWon) expect((retry as { data: StockChangeResult }).data.balance.onHand).toBe(after.a.onHand);
      else expect((retry as { data: MaterialReceiveResult }).data.onHand).toBe(after.box.onHand);
    }
  });

  it("material_receive: one uuid for two materials at the same time — only one movement", async () => {
    const operationId = randomUUID();
    const results = await Promise.all([
      run("material_receive", { code: "opl_box_a", quantity: 4, operationId }, { confirmed: true }),
      run("material_receive", { code: "opl_box_b", quantity: 6, operationId }, { confirmed: true }),
    ]);
    expect(results.map(outcomeOf).sort()).toEqual(["received", "warehouse.error.operationReused"]);
    expect(await manualMovements(operationId)).toHaveLength(1);
  });
});

/** Транзакція іншого викликача, яка тримає блокування до gate(); started — коли запис уже зроблено (без фіксації). */
function holdTransaction(db: Db, body: (tx: Db) => Promise<void>) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let started!: () => void;
  const ready = new Promise<void>((r) => (started = r));
  const done = db.transaction(async (tx) => {
    await body(tx as unknown as Db);
    started();
    await gate;
  });
  return { ready, release, done };
}

async function waitForLockWaiter(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    const r = await env.handle.db.execute(
      sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    const n = Number((r as unknown as { rows: Array<{ n: number }> }).rows[0]?.n ?? 0);
    if (n > 0) return;
    await new Promise((res) => setTimeout(res, 25));
  }
  throw new Error("the command never waited for the other transaction's lock");
}

describe.skipIf(!onPostgres)("a write by another caller between the command's check and the service (PostgreSQL)", () => {
  it("receive_production: a receipt with other lines committed under the batch lock is operationReused, not replay", async () => {
    const batch = await newBatch();
    const operationId = randomUUID();
    const [lineB] = await env.handle.db
      .select({ id: productionBatchLines.id })
      .from(productionBatchLines)
      .where(sql`${productionBatchLines.batchId} = ${batch.id} and ${productionBatchLines.variantId} = ${items.b}`);
    // Інший викликач (не команда) записує надходження OPL-B з тим самим ключем і тримає блокування партії.
    const other = holdTransaction(env.handle.db, async (tx) => {
      await receiveProduction({ ...env.ctx(STAFF), db: tx }, batch.id, { idempotencyKey: operationId, lines: [{ batchLineId: lineB!.id, good: 3, defective: 0 }] });
    });
    await other.ready;
    const command = run("receive_production", { batchNumber: batch.number, lines: [{ sku: "OPL-A", good: 2 }], operationId }, { confirmed: true });
    await waitForLockWaiter();
    other.release();
    await other.done;
    expect(outcomeOf(await command)).toBe("warehouse.error.operationReused");
    expect(await receiptsFor(operationId)).toHaveLength(1);
    const [b] = await env.handle.db.select({ status: productionBatches.status }).from(productionBatches).where(eq(productionBatches.id, batch.id));
    expect(b?.status).toBe("partially_received");
  });

  it("material_receive: a movement with another quantity committed under the balance lock is operationReused, not replay", async () => {
    const operationId = randomUUID();
    const before = await balance(env.handle.db, boxB.stockItemId);
    const other = holdTransaction(env.handle.db, async (tx) => {
      await applyMaterialStock({ ...env.ctx(STAFF), db: tx }, { operationId, operation: "receive", lines: [{ materialId: boxB.materialId, quantity: 7 }] });
    });
    await other.ready;
    const command = run("material_receive", { code: "opl_box_b", quantity: 5, operationId }, { confirmed: true });
    await waitForLockWaiter();
    other.release();
    await other.done;
    expect(outcomeOf(await command)).toBe("warehouse.error.operationReused");
    expect((await balance(env.handle.db, boxB.stockItemId)).onHand).toBe(before.onHand + 7);
  });
});

describe("unknown batch / order number: a clear bot text (C-R6-4)", () => {
  it("receive_production, production_status and start_packing name what was not found; the code stays error.notFound", async () => {
    const missingBatch = await run("receive_production", { batchNumber: "PB-2099-0777", lines: "remaining", operationId: randomUUID() });
    expect(missingBatch).toMatchObject({ status: "error", code: "error.notFound", params: { entity: "productionBatch" } });
    expect(formatWarehouseCommandOutcome(missingBatch)).toBe("Не виконано: партію з таким номером не знайдено — перевірте номер (наприклад, PB-2026-0001).");
    expect(formatWarehouseCommandOutcome(missingBatch, "en")).toBe("Not done: no production batch with this number — check the number (e.g. PB-2026-0001).");
    const status = await run("production_status", { batchNumber: "PB-2099-0777" });
    expect(formatWarehouseCommandOutcome(status, "en")).toBe("Not done: no production batch with this number — check the number (e.g. PB-2026-0001).");
    const order = await run("start_packing", { orderNumber: "#999777" });
    expect(order).toMatchObject({ status: "error", code: "error.notFound", params: { entity: "order" } });
    expect(formatWarehouseCommandOutcome(order)).toBe("Не виконано: замовлення з таким номером не знайдено — перевірте номер.");
    expect(formatWarehouseCommandOutcome(order, "en")).toBe("Not done: no order with this number — check the number.");
    // Інші сутності — як і раніше, загальний текст.
    const other: WarehouseCommandOutcome = { status: "error", command: "stock_summary", risk: "read", code: "error.notFound", params: { entity: "somethingElse" } };
    expect(formatWarehouseCommandOutcome(other)).toBe("Не виконано: Сторінку не знайдено");
  });
});

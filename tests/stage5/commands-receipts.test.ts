/**
 * S5-TG: команди складу для Telegram-бота / асистента — надходження з виробничої партії (receive_production) і
 * пакувальних матеріалів (material_receive): попередній перегляд без змін, підтвердження, ідемпотентність за
 * operationId (повтор — «replay», той самий uuid для іншої операції — operationReused), дозволи, тексти uk/en без
 * собівартості й персональних даних; асистент: надходження з виробництва підтверджується людиною навіть у режимі auto.
 * Дані вигадані.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auditLog, inventoryMovements, productionReceipts } from "~/db/schema";
import { makeActor } from "~/domain/permissions";
import { runAssistantTool } from "~/modules/assistant/tools.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import { createBatch, startProduction } from "~/modules/production/batches.server";
import { updateSetting } from "~/modules/settings/settings.server";
import {
  formatWarehouseCommandOutcome,
  runWarehouseCommand,
  type MaterialReceivePreview,
  type MaterialReceiveResult,
  type ProductionReceiptCommandResult,
  type ProductionReceiptPreview,
  type WarehouseCommandOutcome,
} from "~/modules/warehouse/commands.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { balance, insertMaterial, insertProduct, stockItemFor } from "./helpers";

let env: TestEnv;
const VIEWER = makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["warehouse.receive", "packing.perform"] } });
const items = { red: "", blue: "", redStock: "", blueStock: "" };
let material: { materialId: string; stockItemId: string };

async function newBatch(lines: Array<{ variantId: string; quantity: number }>, start = true): Promise<string> {
  const ctx = env.ctx(OWNER);
  const b = await createBatch(ctx, { title: "Command receipt batch", lines: lines.map((l) => ({ ...l, unitCost: "40.00" })), costCurrency: "UAH", extraCost: "15.00" });
  if (start) await startProduction(ctx, b.batchId, 1);
  return b.number;
}

beforeAll(async () => {
  env = await createTestEnv();
  const db = env.handle.db;
  const p = await insertProduct(db, "Command Receipt Test", [
    { sku: "CR-RED", color: "Red" },
    { sku: "CR-BLUE", color: "Blue" },
  ]);
  [items.red, items.blue] = p.variantIds as [string, string];
  items.redStock = await stockItemFor(db, items.red);
  items.blueStock = await stockItemFor(db, items.blue);
  material = await insertMaterial(db, "cr_box_test");
});
afterAll(async () => {
  await env.close();
});

const run = (actor: typeof STAFF, name: string, input: unknown, opts: { confirmed?: boolean } = {}) =>
  runWarehouseCommand(env.ctx(actor), name, input, { via: "telegram", ...opts });

function ok<T>(o: WarehouseCommandOutcome): T {
  if (o.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.data as T;
}
function preview<T>(o: WarehouseCommandOutcome): T {
  if (o.status !== "confirmation_required") throw new Error(`expected confirmation_required, got ${JSON.stringify(o)}`);
  return o.preview as T;
}
const receipts = async () => Number((await env.handle.db.select({ c: count() }).from(productionReceipts))[0]!.c);

describe("receive_production", () => {
  it("preview changes nothing; confirmed write receives good + defective; the same operationId is a replay", async () => {
    const number = await newBatch([
      { variantId: items.red, quantity: 10 },
      { variantId: items.blue, quantity: 4 },
    ]);
    const operationId = randomUUID();
    const input = { batchNumber: number.toLowerCase(), lines: [{ sku: "cr-red", good: 6, defective: 1, defectReason: "scratch" }], operationId };
    const before = { red: await balance(env.handle.db, items.redStock), receipts: await receipts() };

    const p = preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", input));
    expect(p).toMatchObject({
      kind: "receive_production",
      batchNumber: number,
      status: "in_production",
      statusAfter: "partially_received",
      good: 6,
      defective: 1,
      overReceived: 0,
      blockedReason: null,
      alreadyApplied: false,
      lines: [{ sku: "CR-RED", remaining: 10, good: 6, defective: 1, over: 0 }],
    });
    expect(await receipts()).toBe(before.receipts);
    expect(await balance(env.handle.db, items.redStock)).toMatchObject({ onHand: before.red.onHand, inProduction: before.red.inProduction });
    expect(formatWarehouseCommandOutcome(await run(STAFF, "receive_production", input))).toContain(`Оприбуткувати надходження з партії ${number}: якісних 6, браку 1?`);

    const done = ok<ProductionReceiptCommandResult>(await run(STAFF, "receive_production", input, { confirmed: true }));
    expect(done).toMatchObject({ kind: "receive_production", result: "received", batchNumber: number, status: "partially_received", lines: 1, good: 6, defective: 1 });
    const after = await balance(env.handle.db, items.redStock);
    expect(after).toMatchObject({ onHand: before.red.onHand + 6, defective: before.red.defective + 1, inProduction: before.red.inProduction - 7 });
    expect(await receipts()).toBe(before.receipts + 1);
    // Ключ надходження — operationId.
    expect(await env.handle.db.select().from(productionReceipts).where(eq(productionReceipts.idempotencyKey, operationId))).toHaveLength(1);

    // Повтор (той самий намір): перегляд — «уже виконано», підтвердження — replay, залишок не змінено вдруге.
    const again = preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", input));
    expect(again).toMatchObject({ alreadyApplied: true, statusAfter: null, blockedReason: null });
    const replay = ok<ProductionReceiptCommandResult>(await run(STAFF, "receive_production", input, { confirmed: true }));
    expect(replay.result).toBe("replay");
    expect(await balance(env.handle.db, items.redStock)).toMatchObject({ onHand: after.onHand, defective: after.defective, inProduction: after.inProduction });
    expect(await receipts()).toBe(before.receipts + 1);
    expect(formatWarehouseCommandOutcome(await run(STAFF, "receive_production", input, { confirmed: true }))).toBe(
      "Цю операцію вже виконано раніше — залишок не змінено вдруге.",
    );

    // Решта партії: «remaining» → «Отримано»; новий намір після цього — нічого оприбутковувати.
    const rest = { batchNumber: number, lines: "remaining", operationId: randomUUID() };
    expect(preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", rest))).toMatchObject({
      statusAfter: "received",
      good: 7,
      lines: [
        { sku: "CR-BLUE", remaining: 4, good: 4 },
        { sku: "CR-RED", remaining: 3, good: 3 },
      ],
    });
    const restDone = ok<ProductionReceiptCommandResult>(await run(STAFF, "receive_production", rest, { confirmed: true }));
    expect(restDone).toMatchObject({ result: "received", status: "received", good: 7 });
    expect(ok<ProductionReceiptCommandResult>(await run(STAFF, "receive_production", rest, { confirmed: true })).result).toBe("replay");
    const nothing = { batchNumber: number, lines: "remaining", operationId: randomUUID() };
    expect(preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", nothing))).toMatchObject({ blockedReason: "nothing_remaining", lines: [] });
    expect(await run(STAFF, "receive_production", nothing, { confirmed: true })).toMatchObject({ status: "error", code: "production.error.emptyReceipt" });
  });

  it("parallel confirmations of the same operationId record one receipt", async () => {
    const number = await newBatch([{ variantId: items.blue, quantity: 5 }]);
    const input = { batchNumber: number, lines: [{ sku: "CR-BLUE", good: 2 }], operationId: randomUUID() };
    const before = await balance(env.handle.db, items.blueStock);
    const results = await Promise.all([1, 2, 3].map(() => run(STAFF, "receive_production", input, { confirmed: true })));
    expect(results.map((r) => (r.status === "ok" ? (r.data as ProductionReceiptCommandResult).result : r.status)).sort()).toEqual(["received", "replay", "replay"]);
    expect((await balance(env.handle.db, items.blueStock)).onHand).toBe(before.onHand + 2);
    expect(await env.handle.db.select().from(productionReceipts).where(eq(productionReceipts.idempotencyKey, input.operationId))).toHaveLength(1);
  });

  it("more than the remainder: flagged in preview and rejected; allowed only explicitly", async () => {
    const number = await newBatch([{ variantId: items.red, quantity: 2 }]);
    const over = { batchNumber: number, lines: [{ sku: "CR-RED", good: 3 }], operationId: randomUUID() };
    expect(preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", over))).toMatchObject({ blockedReason: "over_receipt", overReceived: 1, statusAfter: null });
    expect(formatWarehouseCommandOutcome(await run(STAFF, "receive_production", over))).toContain("підтвердження буде відхилено");
    expect(await run(STAFF, "receive_production", over, { confirmed: true })).toMatchObject({ status: "error", code: "production.error.overReceipt" });
    const allowed = { ...over, operationId: randomUUID(), allowOverReceipt: true };
    expect(preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", allowed))).toMatchObject({ blockedReason: null, overReceived: 1, statusAfter: "received" });
    expect(ok<ProductionReceiptCommandResult>(await run(STAFF, "receive_production", allowed, { confirmed: true }))).toMatchObject({ result: "received", overReceived: 1, status: "received" });
  });

  it("a planned (not started) batch cannot be received", async () => {
    const number = await newBatch([{ variantId: items.red, quantity: 2 }], false);
    const input = { batchNumber: number, lines: "remaining", operationId: randomUUID() };
    const p = preview<ProductionReceiptPreview>(await run(STAFF, "receive_production", input));
    expect(p).toMatchObject({ status: "planned", blockedReason: "status" });
    expect(formatWarehouseCommandOutcome(await run(STAFF, "receive_production", input, {}), "en")).toContain("Cannot receive: the batch is «Planned».");
    expect(await run(STAFF, "receive_production", input, { confirmed: true })).toMatchObject({ status: "error", code: "production.error.invalidStatus" });
  });

  it("one operationId — one operation: another batch, other quantities or another command is an error, not a replay", async () => {
    const a = await newBatch([{ variantId: items.red, quantity: 5 }]);
    const b = await newBatch([{ variantId: items.red, quantity: 5 }]);
    const operationId = randomUUID();
    ok(await run(STAFF, "receive_production", { batchNumber: a, lines: [{ sku: "CR-RED", good: 1 }], operationId }, { confirmed: true }));
    const reused = { status: "error", code: "warehouse.error.operationReused" };
    expect(await run(STAFF, "receive_production", { batchNumber: b, lines: [{ sku: "CR-RED", good: 1 }], operationId })).toMatchObject(reused);
    expect(await run(STAFF, "receive_production", { batchNumber: b, lines: [{ sku: "CR-RED", good: 1 }], operationId }, { confirmed: true })).toMatchObject(reused);
    expect(await run(STAFF, "receive_production", { batchNumber: a, lines: [{ sku: "CR-RED", good: 2 }], operationId }, { confirmed: true })).toMatchObject(reused);
    // Той самий uuid у команді надходження без партії / матеріалів — теж помилка (нічого не записано).
    expect(await run(STAFF, "receive_stock", { sku: "CR-RED", quantity: 1, reason: "found", operationId })).toMatchObject(reused);
    expect(await run(STAFF, "receive_stock", { sku: "CR-RED", quantity: 1, reason: "found", operationId }, { confirmed: true })).toMatchObject(reused);
    expect(await run(STAFF, "material_receive", { code: "cr_box_test", quantity: 1, operationId }, { confirmed: true })).toMatchObject(reused);
    expect(await env.handle.db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(operationId)))).toEqual([]);
    // Навпаки: uuid ручного надходження не стає ключем надходження з виробництва.
    const manualId = randomUUID();
    ok(await run(STAFF, "receive_stock", { sku: "CR-BLUE", quantity: 1, reason: "found", operationId: manualId }, { confirmed: true }));
    expect(await run(STAFF, "receive_production", { batchNumber: a, lines: "remaining", operationId: manualId }, { confirmed: true })).toMatchObject(reused);
    expect(await env.handle.db.select().from(productionReceipts).where(eq(productionReceipts.idempotencyKey, manualId))).toEqual([]);
  });

  it("validation, unknown batch/item, duplicates and permissions", async () => {
    const number = await newBatch([{ variantId: items.red, quantity: 3 }]);
    const base = { batchNumber: number, operationId: randomUUID() };
    expect(await run(STAFF, "receive_production", { ...base, lines: [{ sku: "CR-RED", barcode: "123", good: 1 }] })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await run(STAFF, "receive_production", { ...base, lines: [{ sku: "CR-RED", good: 0, defective: 0 }] })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await run(STAFF, "receive_production", { ...base, lines: [] })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await run(STAFF, "receive_production", { ...base, batchNumber: "PB-2099-0042", lines: "remaining" })).toMatchObject({ status: "error", code: "error.notFound" });
    expect(await run(STAFF, "receive_production", { ...base, lines: [{ sku: "CR-BLUE", good: 1 }] })).toMatchObject({
      status: "error",
      code: "warehouseCommands.error.batchLineNotFound",
      params: { item: "CR-BLUE" },
    });
    expect(
      await run(STAFF, "receive_production", {
        ...base,
        lines: [
          { sku: "CR-RED", good: 1 },
          { sku: "cr-red", defective: 1 },
        ],
      }),
    ).toMatchObject({ status: "error", code: "warehouseCommands.error.batchLineDuplicate" });
    expect(await run(VIEWER, "receive_production", { ...base, lines: "remaining" }, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "forbidden",
      permission: "warehouse.receive",
    });
  });

  it("texts: uk/en, no costs or personal data; changes are audited", async () => {
    const number = await newBatch([{ variantId: items.blue, quantity: 3 }]);
    const input = { batchNumber: number, lines: [{ sku: "CR-BLUE", good: 2, defective: 1 }], operationId: randomUUID() };
    const confirm = await run(STAFF, "receive_production", input);
    const en = formatWarehouseCommandOutcome(confirm, "en");
    expect(en).toBe(
      [
        `Receive from batch ${number}: good 2, defective 1?`,
        "• Command Receipt Test Blue (CR-BLUE): good 2, defective 1 (left in production 3)",
        "Batch status: In production → Received",
      ].join("\n"),
    );
    const done = await run(STAFF, "receive_production", input, { confirmed: true });
    expect(formatWarehouseCommandOutcome(done)).toBe(`Оприбутковано з партії ${number}: якісних 2, браку 1. Стан партії: Отримано.`);
    for (const text of [en, formatWarehouseCommandOutcome(confirm), JSON.stringify(confirm), JSON.stringify(done)]) {
      expect(text).not.toMatch(/40\.00|15\.00|UAH|unitCost|cost/i);
    }
    const audit = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "warehouse.command_executed"), eq(auditLog.actorId, STAFF.id)));
    expect(audit.filter((a) => a.details.command === "receive_production").map((a) => a.details.outcome)).toEqual(expect.arrayContaining(["received", "replay"]));
  });
});

describe("material_receive", () => {
  it("preview, confirmed receipt by material code, replay; another quantity with the same id is an error", async () => {
    const operationId = randomUUID();
    const input = { code: "CR_BOX_TEST", quantity: 25, operationId, note: "call +380 50 123 4567" };
    const before = await balance(env.handle.db, material.stockItemId);
    const p = preview<MaterialReceivePreview>(await run(STAFF, "material_receive", input));
    expect(p).toMatchObject({ kind: "material_receive", material: { code: "cr_box_test", unit: "pcs" }, quantity: 25, current: { onHand: before.onHand }, after: { onHand: before.onHand + 25 }, alreadyApplied: false });
    expect((await balance(env.handle.db, material.stockItemId)).onHand).toBe(before.onHand);
    expect(formatWarehouseCommandOutcome(await run(STAFF, "material_receive", input))).toBe(
      [`Оприбуткувати матеріал cr_box_test (cr_box_test): +25 шт.?`, `На складі: ${before.onHand} → ${before.onHand + 25}`].join("\n"),
    );
    const done = ok<MaterialReceiveResult>(await run(STAFF, "material_receive", input, { confirmed: true }));
    expect(done).toMatchObject({ result: "received", onHand: before.onHand + 25 });
    const [movement] = await env.handle.db
      .select()
      .from(inventoryMovements)
      .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(operationId, material.materialId)));
    expect(movement).toMatchObject({ type: "receipt_manual", onHandDelta: 25, unitCost: null });
    expect(movement!.note).not.toContain("123 4567");
    expect(preview<MaterialReceivePreview>(await run(STAFF, "material_receive", input))).toMatchObject({ alreadyApplied: true, after: { onHand: before.onHand + 25 } });
    expect(ok<MaterialReceiveResult>(await run(STAFF, "material_receive", input, { confirmed: true })).result).toBe("replay");
    expect((await balance(env.handle.db, material.stockItemId)).onHand).toBe(before.onHand + 25);
    expect(formatWarehouseCommandOutcome(await run(STAFF, "material_receive", input, { confirmed: true }), "en")).toBe("This operation was already done — stock was not changed twice.");
    expect(await run(STAFF, "material_receive", { ...input, quantity: 26 }, { confirmed: true })).toMatchObject({ status: "error", code: "warehouse.error.operationReused" });
    expect(await run(STAFF, "mark_defective", { sku: "CR-RED", quantity: 1, reason: "other", operationId })).toMatchObject({ status: "error", code: "warehouse.error.operationReused" });
    expect((await balance(env.handle.db, material.stockItemId)).onHand).toBe(before.onHand + 25);
  });

  it("unknown code, invalid quantity and permissions", async () => {
    const operationId = randomUUID();
    expect(await run(STAFF, "material_receive", { code: "nope", quantity: 1, operationId })).toMatchObject({ status: "error", code: "warehouseCommands.error.materialNotFound" });
    expect(await run(STAFF, "material_receive", { code: "cr_box_test", quantity: 0, operationId })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await run(VIEWER, "material_receive", { code: "cr_box_test", quantity: 1, operationId }, { confirmed: true })).toMatchObject({ status: "refused", reason: "forbidden" });
    const en = formatWarehouseCommandOutcome(await run(STAFF, "material_receive", { code: "nope", quantity: 1, operationId }), "en");
    expect(en).toBe("Not done: no packaging material with this code.");
  });
});

describe("assistant tools", () => {
  it("warehouse_receive_production always needs a human confirmation, even in auto mode; material receipts follow the mode", async () => {
    expect((await updateSetting(env.handle.db, OWNER, "automation", { mode: "auto", globalPause: false })).ok).toBe(true);
    const number = await newBatch([{ variantId: items.red, quantity: 2 }]);
    const input = { batchNumber: number, lines: "remaining", operationId: randomUUID() };
    const r = await runAssistantTool(env.ctx(STAFF), "warehouse_receive_production", input);
    expect(r).toMatchObject({ status: "confirmation_required", risk: "critical", reason: "critical_or_financial", preview: { kind: "receive_production", statusAfter: "received" } });
    expect(await runAssistantTool(env.ctx(STAFF), "warehouse_receive_production", input, { confirmed: true })).toMatchObject({ status: "ok", data: { result: "received" } });
    expect(await runAssistantTool(env.ctx(STAFF), "warehouse_receive_production", input, { confirmed: true })).toMatchObject({ status: "ok", data: { result: "replay" } });
    const m = await runAssistantTool(env.ctx(STAFF), "warehouse_material_receive", { code: "cr_box_test", quantity: 3, operationId: randomUUID() });
    expect(m).toMatchObject({ status: "ok", risk: "write", data: { result: "received" } });
    expect(await runAssistantTool(env.ctx(VIEWER), "warehouse_receive_production", input, { confirmed: true })).toMatchObject({ status: "refused", reason: "forbidden" });
    expect((await updateSetting(env.handle.db, OWNER, "automation", { mode: "manual", globalPause: false })).ok).toBe(true);
  });
});

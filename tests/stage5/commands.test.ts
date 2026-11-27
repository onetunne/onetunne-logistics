/**
 * Команди складу (майбутній Telegram-бот / асистент): реєстр, дозволи, схеми, підтвердження змін, ідемпотентність
 * за operationId від викликача, текстові результати без персональних даних; реєстрація warehouse_* в інструментах
 * асистента (правила виконавця етапу 4: режими, пауза, журнал). База — PGlite або TEST_DATABASE_URL з демо-даними.
 */
import { randomUUID } from "node:crypto";
import { and, count, eq, like } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditLog, inventoryMovements, orders } from "~/db/schema";
import { makeActor } from "~/domain/permissions";
import { inventoryKeys } from "~/modules/inventory/keys";
import { setOrderAutomationPaused } from "~/modules/orders/workflow.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { ASSISTANT_TOOLS, runAssistantTool, toolDefinitionsFor } from "~/modules/assistant/tools.server";
import {
  formatWarehouseCommandOutcome,
  newCommandOperationId,
  runWarehouseCommand,
  WAREHOUSE_COMMAND_NAMES,
  WAREHOUSE_COMMANDS,
  warehouseCommandsFor,
  type ItemStockResult,
  type StockChangePreview,
  type StockChangeResult,
  type WarehouseCommandOutcome,
} from "~/modules/warehouse/commands.server";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { insertProduct } from "./helpers";

let env: TestEnv;
let batchNumber: string;
beforeAll(async () => {
  env = await createTestEnv();
  batchNumber = `PB-${new Date().getUTCFullYear()}-0001`;
  await insertProduct(env.handle.db, "Duplicate SKU one", [{ sku: "DUP-1" }]);
  await insertProduct(env.handle.db, "Duplicate SKU two", [{ sku: "dup-1" }]);
});
afterAll(async () => {
  await env.close();
});

const VIEWER = makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["warehouse.receive", "packing.perform"] } });
const NO_VIEW = makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["warehouse.view"] } });
/** Персональні дані демо-замовлень, які не повинні потрапляти в результати команд і журнал. */
const PII = ["Hoffmann", "Musterstraße", "Martin", "Exemple", "Keller", "Probegasse", "+49", "+43", "+33", "Wien", "@"];

const run = (actor = STAFF, name: string, input: unknown, opts: { confirmed?: boolean; via?: "telegram" | "command" } = {}) =>
  runWarehouseCommand(env.ctx(actor), name, input, opts);

function ok<T>(o: WarehouseCommandOutcome): T {
  if (o.status !== "ok") throw new Error(`expected ok, got ${JSON.stringify(o)}`);
  return o.data as T;
}

async function itemBySku(sku: string) {
  const data = ok<ItemStockResult>(await run(STAFF, "item_stock", { sku }));
  expect(data.matches).toHaveLength(1);
  return data.matches[0]!;
}

async function setAutomation(mode: "manual" | "semi" | "auto", globalPause = false) {
  expect((await updateSetting(env.handle.db, OWNER, "automation", { mode, globalPause })).ok).toBe(true);
}

// ---------------------------------------------------------------------------

describe("registry", () => {
  it("has typed commands with permission, risk and confirmation; every write needs confirmation and a preview", () => {
    expect([...WAREHOUSE_COMMANDS.keys()]).toEqual([...WAREHOUSE_COMMAND_NAMES]);
    const meta = Object.fromEntries([...WAREHOUSE_COMMANDS.values()].map((c) => [c.name, [c.permission, c.risk, c.requiresConfirmation]]));
    expect(meta).toEqual({
      stock_summary: ["warehouse.view", "read", false],
      low_stock: ["warehouse.view", "read", false],
      item_stock: ["warehouse.view", "read", false],
      production_status: ["warehouse.view", "read", false],
      recommendations: ["warehouse.view", "read", false],
      receive_stock: ["warehouse.receive", "write", true],
      mark_defective: ["warehouse.receive", "write", true],
      start_packing: ["packing.perform", "write", true],
    });
    for (const c of WAREHOUSE_COMMANDS.values()) {
      if (c.risk === "write") expect(typeof c.preview, c.name).toBe("function");
      expect(c.permission).not.toBe("finance.view");
    }
  });

  it("lists the commands an actor may run", () => {
    expect(warehouseCommandsFor(STAFF).map((c) => c.name)).toEqual([...WAREHOUSE_COMMAND_NAMES]);
    expect(warehouseCommandsFor(VIEWER).map((c) => c.name)).toEqual(["stock_summary", "low_stock", "item_stock", "production_status", "recommendations"]);
    expect(warehouseCommandsFor(NO_VIEW).map((c) => c.name)).not.toContain("stock_summary");
  });

  it("generates UUID operation ids", () => {
    expect(newCommandOperationId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(newCommandOperationId()).not.toBe(newCommandOperationId());
  });
});

describe("read commands", () => {
  it("stock_summary: totals and alerts, text-friendly, no personal data", async () => {
    const o = await run(STAFF, "stock_summary", {});
    const d = ok<{ variants: number; onHand: number; reserved: number; available: number; opened: number; openAlerts: Record<string, number> }>(o);
    expect(d.variants).toBeGreaterThanOrEqual(9);
    expect(d.available).toBe(d.onHand - d.reserved);
    expect(d.opened).toBeGreaterThanOrEqual(9);
    expect(Object.keys(d.openAlerts).sort()).toEqual(["low_stock", "negative_on_hand", "out_of_stock", "oversold"]);
    const text = formatWarehouseCommandOutcome(o);
    expect(text).toMatch(/^Склад: \d+ позицій\. Доступно/);
    expect(formatWarehouseCommandOutcome(o, "en")).toMatch(/^Warehouse: \d+ items\./);
    for (const s of PII) expect(JSON.stringify(o) + text, s).not.toContain(s);
    // Читання не журналюється як зміна.
    const [row] = await env.handle.db.select({ c: count() }).from(auditLog).where(like(auditLog.action, "warehouse.command%"));
    expect(Number(row?.c)).toBe(0);
  });

  it("low_stock: only low/out/oversold/negative opened items, most critical first; limit validated", async () => {
    const d = ok<{ total: number; items: Array<{ status: string; available: number }> }>(await run(STAFF, "low_stock", { limit: 50 }));
    expect(d.items.length).toBeGreaterThan(0);
    for (const i of d.items) expect(["low", "out", "oversold", "negative"]).toContain(i.status);
    expect(await run(STAFF, "low_stock", { limit: 0 })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await run(STAFF, "low_stock", { limit: 5, extra: 1 })).toMatchObject({ status: "refused", reason: "invalid_input" });
  });

  it("item_stock: exact SKU (case-insensitive) or barcode; exactly one of them", async () => {
    const bySku = await itemBySku("ot-ph-wht");
    expect(bySku).toMatchObject({ sku: "OT-PH-WHT", title: "Тримач телефону Pro", variant: "Білий", inProduction: 50, tracking: "opened" });
    expect(bySku.available).toBe(bySku.onHand - bySku.reserved);
    const byBarcode = ok<ItemStockResult>(await run(STAFF, "item_stock", { barcode: "4820000000024" }));
    expect(byBarcode.matches.map((m) => m.sku)).toEqual(["OT-PH-WHT"]);
    expect(await run(STAFF, "item_stock", { sku: "OT-PH-WHT", barcode: "4820000000024" })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await run(STAFF, "item_stock", {})).toMatchObject({ status: "refused", reason: "invalid_input" });
    const none = await run(STAFF, "item_stock", { sku: "NO-SUCH" });
    expect(ok<ItemStockResult>(none).matches).toEqual([]);
    expect(formatWarehouseCommandOutcome(none)).toBe("Товар із таким SKU або штрихкодом не знайдено.");
    expect(ok<ItemStockResult>(await run(STAFF, "item_stock", { sku: "DUP-1" }))).toMatchObject({ total: 2, truncated: false });
    expect(ok<ItemStockResult>(await run(STAFF, "item_stock", { sku: "DUP-1" })).matches).toHaveLength(2);
    expect(formatWarehouseCommandOutcome(await run(STAFF, "item_stock", { sku: "OT-PH-WHT" }))).toMatch(/^Тримач телефону Pro Білий \(OT-PH-WHT\): доступно \d+/);
  });

  it("item_stock: more matches than shown → exact total and a truncated flag for the bot", async () => {
    await insertProduct(
      env.handle.db,
      "Many same SKU",
      Array.from({ length: 7 }, (_, i) => ({ sku: i % 2 === 0 ? "MANY-1" : "many-1", color: `C${i}` })),
    );
    const o = await run(STAFF, "item_stock", { sku: "Many-1" });
    const d = ok<ItemStockResult>(o);
    expect(d).toMatchObject({ total: 7, truncated: true });
    expect(d.matches).toHaveLength(5);
    expect(formatWarehouseCommandOutcome(o).split("\n").at(-1)).toBe("Знайдено 7 позицій, показано 5 — уточніть SKU або штрихкод.");
    expect(formatWarehouseCommandOutcome(o, "en")).toContain("Found 7 items, showing 5");
    // Зміна для неоднозначного SKU — відмова з кількістю «5+».
    expect(await run(STAFF, "mark_defective", { sku: "MANY-1", quantity: 1, reason: "other", operationId: randomUUID() })).toMatchObject({
      status: "error",
      code: "warehouseCommands.error.itemAmbiguous",
      params: { count: "5+" },
    });
    const single = ok<ItemStockResult>(await run(STAFF, "item_stock", { sku: "OT-PH-WHT" }));
    expect(single).toMatchObject({ total: 1, truncated: false });
    expect(formatWarehouseCommandOutcome(await run(STAFF, "item_stock", { sku: "OT-PH-WHT" }))).not.toContain("Знайдено");
  });

  it("production_status: by batch number, without costs or manufacturer", async () => {
    const o = await run(STAFF, "production_status", { batchNumber: batchNumber.toLowerCase() });
    const d = ok<{ number: string; status: string; ordered: number; remaining: number; lines: Array<{ sku: string }> }>(o);
    expect(d).toMatchObject({ number: batchNumber, status: "in_production" });
    expect(d.ordered).toBeGreaterThan(0);
    expect(d.lines.some((l) => l.sku === "OT-PH-WHT")).toBe(true);
    const json = JSON.stringify(o);
    for (const k of ["unitCost", "cost", "manufacturer", "notes", "extraCost"]) expect(json).not.toContain(`"${k}"`);
    expect(formatWarehouseCommandOutcome(o)).toContain(`Партія ${batchNumber}: У виробництві`);
    expect(await run(STAFF, "production_status", { batchNumber: "PB-2000-0001" })).toMatchObject({ status: "error", code: "error.notFound" });
    expect(await run(STAFF, "production_status", { batchNumber: "1; drop" })).toMatchObject({ status: "refused", reason: "invalid_input" });
  });

  it("recommendations: positive quantities only, settings echoed, optional filters", async () => {
    const d = ok<{ settings: { productionLeadDays: number }; items: Array<{ quantity: number }>; total: number }>(await run(STAFF, "recommendations", {}));
    expect(d.settings.productionLeadDays).toBeGreaterThan(0);
    for (const i of d.items) expect(i.quantity).toBeGreaterThan(0);
    const filtered = ok<{ total: number }>(await run(STAFF, "recommendations", { color: "Немає такого кольору" }));
    expect(filtered.total).toBe(0);
    expect(formatWarehouseCommandOutcome(await run(STAFF, "recommendations", { color: "Немає такого кольору" }))).toBe("Нові партії зараз не потрібні.");
  });

  it("permissions are enforced per command", async () => {
    expect(await run(NO_VIEW, "stock_summary", {})).toMatchObject({ status: "refused", reason: "forbidden", permission: "warehouse.view" });
    expect(await run(STAFF, "drop_table", {})).toMatchObject({ status: "refused", reason: "unknown_command" });
    expect(formatWarehouseCommandOutcome(await run(NO_VIEW, "low_stock", {}))).toBe("Недостатньо прав для цієї команди.");
  });
});

describe("write commands", () => {
  it("receive_stock: preview without changes, confirmed write, idempotent replay by operationId", async () => {
    const before = await itemBySku("OT-GR-BLK");
    const operationId = randomUUID();
    const input = { sku: "OT-GR-BLK", quantity: 3, defectiveQuantity: 1, reason: "purchase", operationId };
    const pending = await run(STAFF, "receive_stock", input, { via: "telegram" });
    expect(pending).toMatchObject({ status: "confirmation_required", command: "receive_stock" });
    const preview = (pending as { preview: StockChangePreview }).preview;
    expect(preview).toMatchObject({
      kind: "receive_stock",
      item: { sku: "OT-GR-BLK" },
      current: { available: before.available, defective: before.defective },
      after: { available: before.available + 3, defective: before.defective + 1 },
      insufficient: false,
      alreadyApplied: false,
    });
    expect(formatWarehouseCommandOutcome(pending)).toContain(`Доступно: ${before.available} → ${before.available + 3}`);
    expect((await itemBySku("OT-GR-BLK")).available).toBe(before.available);

    const done = await run(STAFF, "receive_stock", input, { confirmed: true, via: "telegram" });
    const r = ok<StockChangeResult>(done);
    expect(r).toMatchObject({ result: "received", quantity: 3, defectiveQuantity: 1, balance: { available: before.available + 3, defective: before.defective + 1 } });
    expect(formatWarehouseCommandOutcome(done)).toMatch(/^Оприбутковано: Грипси силіконові Чорні \(OT-GR-BLK\) \+3 \(брак 1\)/);

    // Повтор того самого operationId (повторне натискання / повтор після збою) — без другого руху.
    const again = ok<StockChangeResult>(await run(STAFF, "receive_stock", input, { confirmed: true }));
    expect(again.result).toBe("replay");
    expect((await itemBySku("OT-GR-BLK")).available).toBe(before.available + 3);
    const [moves] = await env.handle.db
      .select({ c: count() })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(operationId)));
    expect(Number(moves?.c)).toBe(1);
    // Перегляд повтору: та сама операція вже записана — «стане» = «зараз» (підтвердження нічого не змінить).
    const replayPreview = await run(STAFF, "receive_stock", input);
    expect(replayPreview).toMatchObject({
      status: "confirmation_required",
      preview: { alreadyApplied: true, current: { available: before.available + 3 }, after: { available: before.available + 3 } },
    });
    expect(formatWarehouseCommandOutcome(replayPreview)).toContain(`Доступно: ${before.available + 3} → ${before.available + 3}`);
    expect(formatWarehouseCommandOutcome(replayPreview)).toContain("Цю операцію вже виконано раніше");
    expect(formatWarehouseCommandOutcome(await run(STAFF, "receive_stock", input, { confirmed: true }))).toBe(
      "Цю операцію вже виконано раніше — залишок не змінено вдруге.",
    );

    // Той самий operationId для іншої операції — помилка, нічого не записано.
    const reused = await run(STAFF, "receive_stock", { ...input, quantity: 5 }, { confirmed: true });
    expect(reused).toMatchObject({ status: "error", code: "warehouse.error.operationReused" });
    expect(formatWarehouseCommandOutcome(reused)).toContain("ідентифікатор операції вже використано");
    expect((await itemBySku("OT-GR-BLK")).available).toBe(before.available + 3);

    const audit = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "warehouse.command_executed"));
    expect(audit.some((a) => a.details.via === "telegram" && a.details.command === "receive_stock" && a.details.outcome === "received")).toBe(true);
    expect(audit.some((a) => a.details.outcome === "replay")).toBe(true);
  });

  it("preview: an operationId already used for a DIFFERENT operation is an error, not a «replay»", async () => {
    const operationId = randomUUID();
    const marked = await run(STAFF, "mark_defective", { sku: "OT-GR-BLK", quantity: 1, reason: "damaged_in_warehouse", operationId }, { confirmed: true });
    expect(ok<StockChangeResult>(marked).result).toBe("marked");
    const before = await itemBySku("OT-PH-WHT");
    for (const [name, other] of [
      ["receive_stock", { sku: "OT-PH-WHT", quantity: 2, reason: "purchase", operationId }], // інша позиція й вид
      ["receive_stock", { sku: "OT-GR-BLK", quantity: 1, reason: "purchase", operationId }], // та сама позиція, інший вид
      ["mark_defective", { sku: "OT-GR-BLK", quantity: 2, reason: "damaged_in_warehouse", operationId }], // інша кількість
    ] as const) {
      const preview = await run(STAFF, name, other);
      expect(preview, JSON.stringify(other)).toMatchObject({ status: "error", code: "warehouse.error.operationReused" });
      const text = formatWarehouseCommandOutcome(preview);
      expect(text).toContain("ідентифікатор операції вже використано");
      expect(text).not.toContain("Цю операцію вже виконано");
      // Те саме, що й після підтвердження: нічого не записано.
      expect(await run(STAFF, name, other, { confirmed: true })).toMatchObject({ status: "error", code: "warehouse.error.operationReused" });
    }
    expect((await itemBySku("OT-PH-WHT")).available).toBe(before.available);
    // Та сама операція — справжній повтор.
    expect(await run(STAFF, "mark_defective", { sku: "OT-GR-BLK", quantity: 1, reason: "damaged_in_warehouse", operationId })).toMatchObject({
      status: "confirmation_required",
      preview: { alreadyApplied: true },
    });
  });

  it("receive_stock: input validation, unknown and ambiguous SKUs, permissions", async () => {
    const base = { sku: "OT-GR-BLK", quantity: 1, reason: "purchase", operationId: randomUUID() };
    for (const bad of [
      { ...base, quantity: 0 },
      { ...base, operationId: "not-a-uuid" },
      { ...base, operationId: undefined },
      { ...base, reason: "gift" },
      { ...base, barcode: "4820000000055" },
      { ...base, unitCost: "10.00" }, // собівартість через команду не передається
      { ...base, quantity: 1.5 },
    ]) {
      expect(await run(STAFF, "receive_stock", bad, { confirmed: true }), JSON.stringify(bad)).toMatchObject({ status: "refused", reason: "invalid_input" });
    }
    expect(await run(STAFF, "receive_stock", { ...base, sku: "NO-SUCH" }, { confirmed: true })).toMatchObject({
      status: "error",
      code: "warehouseCommands.error.itemNotFound",
    });
    const ambiguous = await run(STAFF, "receive_stock", { ...base, sku: "DUP-1" });
    expect(ambiguous).toMatchObject({ status: "error", code: "warehouseCommands.error.itemAmbiguous", params: { count: 2 } });
    expect(formatWarehouseCommandOutcome(ambiguous)).toBe("Не виконано: знайдено кілька товарів (2) — уточніть SKU або штрихкод.");
    expect(await run(VIEWER, "receive_stock", base, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "forbidden",
      permission: "warehouse.receive",
    });
    const refused = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "warehouse.command_refused"), eq(auditLog.actorId, VIEWER.id)));
    expect(refused).toHaveLength(1);
  });

  it("receive_stock by barcode with defective-only units", async () => {
    const before = await itemBySku("OT-GR-GRY");
    const r = ok<StockChangeResult>(
      await run(STAFF, "receive_stock", { barcode: "4820000000062", quantity: 0, defectiveQuantity: 2, reason: "customer_return", operationId: randomUUID() }, { confirmed: true }),
    );
    expect(r).toMatchObject({ result: "received", sku: "OT-GR-GRY", balance: { available: before.available, defective: before.defective + 2 } });
  });

  it("mark_defective: preview flags insufficient stock; confirmed write moves units to defective", async () => {
    const before = await itemBySku("OT-BG-BLK");
    const tooMany = { sku: "OT-BG-BLK", quantity: before.onHand + 1, reason: "damaged_in_warehouse", operationId: randomUUID() };
    const pending = await run(STAFF, "mark_defective", tooMany);
    expect(pending).toMatchObject({ status: "confirmation_required", preview: { insufficient: true } });
    expect(formatWarehouseCommandOutcome(pending)).toContain("операцію буде відхилено");
    expect(await run(STAFF, "mark_defective", tooMany, { confirmed: true })).toMatchObject({ status: "error", code: "inventory.insufficient" });

    const done = ok<StockChangeResult>(
      await run(STAFF, "mark_defective", { sku: "OT-BG-BLK", quantity: 1, reason: "damaged_in_warehouse", operationId: randomUUID(), note: "Подряпина, тел. +380 67 123 45 67" }, { confirmed: true }),
    );
    expect(done).toMatchObject({ result: "marked", balance: { onHand: before.onHand - 1, defective: before.defective + 1 } });
    const [movement] = await env.handle.db
      .select({ note: inventoryMovements.note })
      .from(inventoryMovements)
      .where(and(eq(inventoryMovements.type, "defect_mark"), like(inventoryMovements.note, "Подряпина%")));
    expect(movement?.note).not.toContain("123 45 67"); // примітка — без телефонів (privacy/redact)
  });

  it("start_packing: preview, confirmed start through the packing module, repeat continues the same packing", async () => {
    const preview = await run(STAFF, "start_packing", { orderNumber: "0998" });
    expect(preview).toMatchObject({
      status: "confirmation_required",
      preview: { kind: "start_packing", orderNumber: "#0998", status: "waybill_created", startable: true, blockedReason: null },
    });
    expect(formatWarehouseCommandOutcome(preview)).toContain("Почати пакування замовлення #0998");
    const started = await run(STAFF, "start_packing", { orderNumber: "#0998" }, { confirmed: true });
    expect(started).toMatchObject({ status: "ok", data: { result: "started", orderNumber: "#0998", status: "awaiting_picking" } });
    expect(formatWarehouseCommandOutcome(started)).toBe("Пакування замовлення #0998 розпочато.");
    expect(await run(STAFF, "start_packing", { orderNumber: "#0998" }, { confirmed: true })).toMatchObject({
      status: "ok",
      data: { result: "already_started" },
    });
    for (const s of PII) expect(JSON.stringify(started), s).not.toContain(s);

    const blocked = await run(STAFF, "start_packing", { orderNumber: "#1001" });
    expect(blocked).toMatchObject({ preview: { startable: false, blockedReason: "status" } });
    expect(await run(STAFF, "start_packing", { orderNumber: "#1001" }, { confirmed: true })).toMatchObject({ status: "error", code: "packing.error.status" });
    expect(await run(STAFF, "start_packing", { orderNumber: "#9999" })).toMatchObject({ status: "error", code: "error.notFound" });
    expect(await run(VIEWER, "start_packing", { orderNumber: "#0998" }, { confirmed: true })).toMatchObject({
      status: "refused",
      permission: "packing.perform",
    });
  });

  it("command audit entries contain no personal data", async () => {
    const rows = await env.handle.db.select().from(auditLog).where(like(auditLog.action, "warehouse.command%"));
    expect(rows.length).toBeGreaterThan(3);
    const json = JSON.stringify(rows.map((r) => r.details));
    for (const s of PII) expect(json, s).not.toContain(s);
  });
});

// ---------------------------------------------------------------------------

describe("assistant tools", () => {
  beforeEach(async () => {
    await setAutomation("manual");
  });

  it("registers every warehouse command as warehouse_<name> with the same permission, risk and schema", () => {
    for (const c of WAREHOUSE_COMMANDS.values()) {
      const tool = ASSISTANT_TOOLS.get(`warehouse_${c.name}`);
      expect(tool, c.name).toBeTruthy();
      expect(tool).toMatchObject({ requiredPermission: c.permission, risk: c.risk, requiresConfirmation: c.requiresConfirmation });
    }
    // Інструменти етапу 4 на місці.
    for (const name of ["find_orders", "get_order", "create_waybill", "reissue_waybill"]) expect(ASSISTANT_TOOLS.has(name)).toBe(true);
    const staffTools = toolDefinitionsFor(STAFF).map((d) => d.name);
    expect(staffTools).toEqual(expect.arrayContaining(["warehouse_stock_summary", "warehouse_receive_stock", "warehouse_start_packing"]));
    expect(toolDefinitionsFor(VIEWER).map((d) => d.name)).not.toContain("warehouse_receive_stock");
    const itemTool = toolDefinitionsFor(STAFF).find((d) => d.name === "warehouse_item_stock")!;
    expect(itemTool.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Object.keys(itemTool.inputSchema.properties as object).sort()).toEqual(["barcode", "sku"]);
    const receive = toolDefinitionsFor(STAFF).find((d) => d.name === "warehouse_receive_stock")!;
    expect(receive).toMatchObject({ risk: "write", requiresConfirmation: true, requiredPermission: "warehouse.receive" });
    expect((receive.inputSchema.required as string[]).sort()).toEqual(["operationId", "quantity", "reason"]);
  });

  it("read tools run in any mode without confirmation and are not logged as changes", async () => {
    const r = await runAssistantTool(env.ctx(STAFF), "warehouse_low_stock", { limit: 3 });
    expect(r).toMatchObject({ status: "ok", tool: "warehouse_low_stock", risk: "read" });
    const rows = await env.handle.db.select().from(auditLog).where(like(auditLog.action, "assistant.%"));
    expect(rows.some((a) => a.details.tool === "warehouse_low_stock")).toBe(false);
  });

  it("a reused operationId is reported as an error by the assistant preview too (not as a replay)", async () => {
    const ctx = env.ctx(STAFF);
    const operationId = randomUUID();
    await setAutomation("auto");
    expect(await runAssistantTool(ctx, "warehouse_receive_stock", { sku: "OT-LT-STD", quantity: 1, reason: "found", operationId })).toMatchObject({
      status: "ok",
      data: { result: "received" },
    });
    await setAutomation("manual");
    expect(
      await runAssistantTool(ctx, "warehouse_mark_defective", { sku: "OT-LT-STD", quantity: 1, reason: "other", operationId }),
    ).toMatchObject({ status: "error", code: "warehouse.error.operationReused" });
  });

  it("write tools follow the mode rules (manual/semi confirm, auto runs) with idempotent operation ids", async () => {
    const ctx = env.ctx(STAFF);
    const before = await itemBySku("OT-LT-STD");
    const input = { sku: "OT-LT-STD", quantity: 2, reason: "found", operationId: randomUUID() };
    const manual = await runAssistantTool(ctx, "warehouse_receive_stock", input, { mode: "auto" });
    expect(manual).toMatchObject({ status: "confirmation_required", reason: "manual_mode", preview: { kind: "receive_stock", alreadyApplied: false } });
    await setAutomation("semi");
    expect(await runAssistantTool(ctx, "warehouse_receive_stock", input)).toMatchObject({ status: "confirmation_required", reason: "tool_requires_confirmation" });
    expect((await itemBySku("OT-LT-STD")).available).toBe(before.available);
    const confirmed = await runAssistantTool(ctx, "warehouse_receive_stock", input, { confirmed: true });
    expect(confirmed).toMatchObject({ status: "ok", data: { result: "received" } });
    await setAutomation("auto");
    expect(await runAssistantTool(ctx, "warehouse_receive_stock", input)).toMatchObject({ status: "ok", data: { result: "replay" } });
    expect((await itemBySku("OT-LT-STD")).available).toBe(before.available + 2);
    const audit = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "assistant.tool_executed"), eq(auditLog.actorId, STAFF.id)));
    const outcomes = audit.filter((a) => a.details.tool === "warehouse_receive_stock").map((a) => a.details.outcome);
    expect(outcomes).toEqual(expect.arrayContaining(["received", "replay"]));
  });

  it("global pause refuses warehouse changes; reads keep working; forbidden is refused", async () => {
    await setAutomation("auto", true);
    const ctx = env.ctx(STAFF);
    const input = { sku: "OT-LT-STD", quantity: 1, reason: "found", operationId: randomUUID() };
    expect(await runAssistantTool(ctx, "warehouse_receive_stock", input, { confirmed: true })).toMatchObject({ status: "refused", reason: "global_pause" });
    expect(await runAssistantTool(ctx, "warehouse_stock_summary", {})).toMatchObject({ status: "ok" });
    await setAutomation("auto");
    expect(await runAssistantTool(env.ctx(VIEWER), "warehouse_receive_stock", input, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "forbidden",
      permission: "warehouse.receive",
    });
    expect(await runAssistantTool(ctx, "warehouse_item_stock", { sku: "OT-LT-STD", sql: "1" })).toMatchObject({ status: "refused", reason: "invalid_input" });
  });

  it("start_packing respects the per-order automation pause", async () => {
    await setAutomation("auto");
    const ctx = env.ctx(OWNER);
    const [o] = await env.handle.db.select({ id: orders.id }).from(orders).where(eq(orders.orderNumber, "#1001"));
    await setOrderAutomationPaused(ctx, o!.id, true);
    try {
      expect(await runAssistantTool(ctx, "warehouse_start_packing", { orderNumber: "1001" }, { confirmed: true })).toMatchObject({
        status: "refused",
        reason: "order_paused",
      });
    } finally {
      await setOrderAutomationPaused(ctx, o!.id, false);
    }
  });

  it("assistant results and audit contain no personal data", async () => {
    const rows = await env.handle.db.select().from(auditLog).where(like(auditLog.action, "assistant.%"));
    const json = JSON.stringify(rows.map((r) => r.details));
    for (const s of PII) expect(json, s).not.toContain(s);
  });
});

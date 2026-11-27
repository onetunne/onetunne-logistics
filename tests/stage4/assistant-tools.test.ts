/**
 * Виконавець інструментів асистента: дозволи, схеми, підтвердження за режимами, пауза автоматизації, журнал.
 * Мовна модель не використовується — виклики імітують «пропозицію» моделі.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import { z } from "zod";
import { auditLog, orders } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { setOrderAutomationPaused, validateOrderById } from "~/modules/orders/workflow.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { findActiveShipment } from "~/modules/shipments/waybill.server";
import {
  ASSISTANT_TOOLS,
  confirmationReason,
  createToolRegistry,
  defineTool,
  runAssistantTool,
  stricterMode,
  toolDefinitionsFor,
} from "~/modules/assistant/tools.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function setAutomation(mode: "manual" | "semi" | "auto", globalPause = false) {
  const r = await updateSetting(env.handle.db, OWNER, "automation", { mode, globalPause });
  expect(r.ok).toBe(true);
}

async function assistantAudit() {
  return env.handle.db.select().from(auditLog).where(like(auditLog.action, "assistant.%"));
}

/** Персональні дані демо-замовлень, які не повинні потрапляти в журнал. */
const PII_SNIPPETS = ["Hoffmann", "Musterstraße", "Martin", "Exemple", "+49", "+33", "Lyon", "Berlin", "@"];

describe("pure rules", () => {
  it("confirmation rules follow REQUIREMENTS §10 modes", () => {
    const read = { risk: "read" as const, requiresConfirmation: false };
    const lowWrite = { risk: "write" as const, requiresConfirmation: false };
    const write = { risk: "write" as const, requiresConfirmation: true };
    const critical = { risk: "critical" as const, requiresConfirmation: true };
    const financial = { risk: "financial" as const, requiresConfirmation: true };
    for (const mode of ["manual", "semi", "auto"] as const) {
      expect(confirmationReason(read, mode)).toBeNull();
      expect(confirmationReason(critical, mode)).toBe("critical_or_financial");
      expect(confirmationReason(financial, mode)).toBe("critical_or_financial");
    }
    expect(confirmationReason(lowWrite, "manual")).toBe("manual_mode");
    expect(confirmationReason(write, "manual")).toBe("manual_mode");
    expect(confirmationReason(lowWrite, "semi")).toBeNull();
    expect(confirmationReason(write, "semi")).toBe("tool_requires_confirmation");
    expect(confirmationReason(lowWrite, "auto")).toBeNull();
    expect(confirmationReason(write, "auto")).toBeNull();
  });

  it("requested mode can never exceed the owner's setting", () => {
    expect(stricterMode("auto", "manual")).toBe("manual");
    expect(stricterMode("semi", "auto")).toBe("semi");
    expect(stricterMode("auto", "auto")).toBe("auto");
  });

  it("critical/financial tools without confirmation cannot be defined", () => {
    expect(() =>
      defineTool({
        name: "bad_tool",
        description: "x",
        input: z.object({}),
        requiredPermission: "waybills.create",
        risk: "critical",
        requiresConfirmation: false,
        handler: async () => null,
      }),
    ).toThrow(/must require confirmation/);
  });

  it("registry: every critical tool requires confirmation; no financial tools at this stage", () => {
    for (const t of ASSISTANT_TOOLS.values()) {
      if (t.risk === "critical" || t.risk === "financial") expect(t.requiresConfirmation, t.name).toBe(true);
      expect(t.risk).not.toBe("financial");
      expect(t.requiredPermission).not.toBe("finance.view");
    }
  });
});

describe("tool definitions", () => {
  it("are filtered by the actor's permissions and carry JSON schemas", () => {
    const ownerNames = toolDefinitionsFor(OWNER).map((d) => d.name);
    // Інструменти складу (етап 5, warehouse_*) перевіряє tests/stage5/commands.test.ts.
    expect(ownerNames.filter((name) => !name.startsWith("warehouse_"))).toEqual([
      "find_orders",
      "get_order",
      "list_problems",
      "revalidate_order",
      "propose_address_change",
      "update_order_address",
      "create_waybill",
      "cancel_waybill",
      "reissue_waybill",
    ]);
    const staffNames = toolDefinitionsFor(STAFF).map((d) => d.name);
    expect(staffNames).not.toContain("cancel_waybill"); // waybills.manage — лише власник
    expect(staffNames).not.toContain("reissue_waybill");
    expect(staffNames).toContain("create_waybill");

    const getOrder = toolDefinitionsFor(OWNER).find((d) => d.name === "get_order")!;
    expect(getOrder.inputSchema).toMatchObject({ type: "object", required: ["orderNumber"], additionalProperties: false });
    expect(getOrder.inputSchema).not.toHaveProperty("$schema");
    const update = toolDefinitionsFor(OWNER).find((d) => d.name === "update_order_address")!;
    expect(update).toMatchObject({ risk: "write", requiresConfirmation: true, requiredPermission: "orders.edit" });
    expect((update.inputSchema.properties as Record<string, unknown>).shipping).toBeTruthy();
    const views = makeActor({ id: "viewer", displayName: "V", role: "staff", overrides: { revoke: ["orders.edit"] } });
    expect(toolDefinitionsFor(views).map((d) => d.name)).not.toContain("update_order_address");
  });

  it("staff never sees owner-only or financial tools, even with a forged permission set", () => {
    const registry = createToolRegistry([
      defineTool({
        name: "monthly_profit",
        description: "Profit for a month",
        input: z.object({}).strict(),
        requiredPermission: "finance.view",
        risk: "financial",
        requiresConfirmation: true,
        handler: async () => ({ profit: "1000.00" }),
      }),
      defineTool({
        name: "change_markup",
        description: "Change shipping markup",
        input: z.object({}).strict(),
        requiredPermission: "settings.manage",
        risk: "write",
        requiresConfirmation: true,
        handler: async () => null,
      }),
    ]);
    expect(toolDefinitionsFor(STAFF, registry)).toEqual([]);
    expect(toolDefinitionsFor(OWNER, registry).map((d) => d.name)).toEqual(["monthly_profit", "change_markup"]);
    // Грант через перевизначення ігнорується resolvePermissions; підроблений набір — відсікається за роллю.
    const forged: Actor = { ...STAFF, permissions: new Set([...STAFF.permissions, "finance.view", "settings.manage"]) };
    expect(toolDefinitionsFor(forged, registry)).toEqual([]);
  });

  it("forged staff actor cannot run an owner-only tool", async () => {
    let ran = false;
    const registry = createToolRegistry([
      defineTool({
        name: "monthly_profit",
        description: "Profit",
        input: z.object({}).strict(),
        requiredPermission: "finance.view",
        risk: "financial",
        requiresConfirmation: true,
        handler: async () => {
          ran = true;
          return null;
        },
      }),
    ]);
    const forged: Actor = { ...STAFF, permissions: new Set([...STAFF.permissions, "finance.view"]) };
    const r = await runAssistantTool(env.ctx(forged), "monthly_profit", {}, { confirmed: true }, registry);
    expect(r).toMatchObject({ status: "refused", reason: "forbidden", permission: "finance.view" });
    expect(ran).toBe(false);
  });
});

describe("executor", () => {
  beforeEach(async () => {
    await setAutomation("manual");
  });

  it("unknown tool and invalid input are refused before anything runs", async () => {
    const ctx = env.ctx(OWNER);
    expect(await runAssistantTool(ctx, "drop_database", {})).toMatchObject({ status: "refused", reason: "unknown_tool" });
    expect(await runAssistantTool(ctx, "get_order", { orderNumber: 1001 })).toMatchObject({ status: "refused", reason: "invalid_input" });
    expect(await runAssistantTool(ctx, "get_order", { orderNumber: "#1001", sql: "select 1" })).toMatchObject({
      status: "refused",
      reason: "invalid_input",
    });
    expect(await runAssistantTool(ctx, "find_orders", { country: "Germany" })).toMatchObject({ status: "refused", reason: "invalid_input" });
    const r = await runAssistantTool(ctx, "update_order_address", { orderNumber: "#1001", expectedVersion: 1 });
    expect(r).toMatchObject({ status: "refused", reason: "invalid_input" });
    if (r.status === "refused") expect(r.issues?.[0]?.message).toMatch(/at least one field/);
  });

  it("enforces the actor's permissions and logs refused changes", async () => {
    const r = await runAssistantTool(env.ctx(STAFF), "cancel_waybill", { orderNumber: "#0998" }, { confirmed: true });
    expect(r).toMatchObject({ status: "refused", reason: "forbidden", permission: "waybills.manage" });
    const noEdit = makeActor({ id: "no-edit", displayName: "N", role: "staff", overrides: { revoke: ["orders.edit"] } });
    expect(await runAssistantTool(env.ctx(noEdit), "revalidate_order", { orderNumber: "#1001" }, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "forbidden",
      permission: "orders.edit",
    });
    const rows = (await assistantAudit()).filter((a) => a.action === "assistant.tool_refused" && a.actorId === STAFF.id);
    expect(rows.some((a) => a.details.tool === "cancel_waybill" && a.details.reason === "forbidden")).toBe(true);
  });

  it("find_orders returns minimal data and supports the «no waybill» filter", async () => {
    const r = await runAssistantTool(env.ctx(STAFF), "find_orders", { noWaybill: true, limit: 50 });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    const data = r.data as { orders: { orderNumber: string; status: string; hasActiveWaybill: boolean }[] };
    const numbers = data.orders.map((o) => o.orderNumber);
    expect(numbers).toContain("#1001");
    expect(numbers).not.toContain("#0998"); // має накладну
    expect(numbers).not.toContain("#0996"); // скасоване
    expect(data.orders.every((o) => !o.hasActiveWaybill)).toBe(true);
    const json = JSON.stringify(r.data);
    for (const s of ["Hoffmann", "Musterstraße", "Berlin", "+49", "currency", "customerName"]) expect(json).not.toContain(s);

    const de = await runAssistantTool(env.ctx(STAFF), "find_orders", { country: "de" });
    if (de.status !== "ok") throw new Error("expected ok");
    const deOrders = (de.data as { orders: { countryCode: string }[] }).orders;
    expect(deOrders.length).toBeGreaterThan(0);
    expect(deOrders.every((o) => o.countryCode === "DE")).toBe(true);
  });

  it("get_order includes address/contacts only on explicit request, marked untrusted", async () => {
    const ctx = env.ctx(STAFF);
    const plain = await runAssistantTool(ctx, "get_order", { orderNumber: "1001" });
    expect(plain).toMatchObject({ status: "ok", data: { orderNumber: "#1001", countryCode: "DE" } });
    expect(JSON.stringify(plain)).not.toMatch(/Hoffmann|Musterstraße|\+49|@/);
    const full = await runAssistantTool(ctx, "get_order", { orderNumber: "#1001", includeAddress: true });
    expect(full).toMatchObject({ status: "ok", data: { shippingAddress: { untrusted: true, lastName: "Hoffmann" } } });
    expect(JSON.stringify(full)).not.toContain("+49"); // контакти не запитано
    expect(await runAssistantTool(ctx, "get_order", { orderNumber: "#9999" })).toMatchObject({ status: "error", code: "error.notFound" });
  });

  it("list_problems returns codes without customer data", async () => {
    await validateOrderById(env.ctx(OWNER), await env.orderId("#1004"));
    const r = await runAssistantTool(env.ctx(STAFF), "list_problems", { code: "POSTAL_CODE_MISSING" });
    if (r.status !== "ok") throw new Error("expected ok");
    const problems = (r.data as { problems: { orderNumber: string; code: string }[] }).problems;
    expect(problems.some((p) => p.orderNumber === "#1004")).toBe(true);
    expect(JSON.stringify(r.data)).not.toMatch(/Martin|Lyon|Exemple/);
  });

  it("manual mode: every write needs confirmation; nothing changes until confirmed", async () => {
    const ctx = env.ctx(STAFF);
    const id = await env.orderId("#1001");
    // Запит режиму auto не підвищує режим власника (manual).
    const pending = await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1001" }, { mode: "auto" });
    expect(pending).toMatchObject({ status: "confirmation_required", reason: "manual_mode", risk: "write" });
    expect((await loadOrderRow(ctx.db, id)).status).toBe("paid");

    const done = await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1001" }, { confirmed: true });
    expect(done).toMatchObject({ status: "ok", data: { status: "awaiting_review", blocking: false } });
    const audit = (await assistantAudit()).filter((a) => a.action === "assistant.tool_executed" && a.entityId === id);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toMatchObject({ via: "assistant", tool: "revalidate_order", mode: "manual", confirmed: true, outcome: "ok" });
  });

  it("semi mode: low-risk writes run, address changes and waybills need confirmation", async () => {
    await setAutomation("semi");
    const ctx = env.ctx(STAFF);
    expect(await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1004" })).toMatchObject({ status: "ok" });
    const id = await env.orderId("#1004");
    const version = (await loadOrderRow(ctx.db, id)).version;
    const r = await runAssistantTool(ctx, "update_order_address", {
      orderNumber: "#1004",
      expectedVersion: version,
      shipping: { postalCode: "69001" },
    });
    expect(r).toMatchObject({ status: "confirmation_required", reason: "tool_requires_confirmation" });
    if (r.status === "confirmation_required") {
      expect(r.preview).toMatchObject({
        versionMismatch: false,
        editable: true,
        changes: [{ field: "shipping.postalCode", from: null, to: "69001" }],
      });
    }
    expect((await loadOrderRow(ctx.db, id)).shipPostalCode).toBeNull();
    expect(await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1001" })).toMatchObject({
      status: "confirmation_required",
      reason: "critical_or_financial",
    });
  });

  it("auto mode: writes run without confirmation, critical actions still need it", async () => {
    await setAutomation("auto");
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1004");
    const version = (await loadOrderRow(ctx.db, id)).version;
    const r = await runAssistantTool(ctx, "update_order_address", {
      orderNumber: "#1004",
      expectedVersion: version,
      shipping: { postalCode: " 69001 " },
      reason: "Customer confirmed",
    });
    expect(r).toMatchObject({ status: "ok", data: { changedFields: ["shipping.postalCode"], status: "awaiting_review" } });
    expect((await loadOrderRow(ctx.db, id)).shipPostalCode).toBe("69001");
    // Застаріла версія → конфлікт (оптимістичне блокування сервісу).
    expect(
      await runAssistantTool(ctx, "update_order_address", { orderNumber: "#1004", expectedVersion: version, shipping: { city: "Paris" } }),
    ).toMatchObject({ status: "error", code: "error.conflict" });
    expect(await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1004" })).toMatchObject({ status: "confirmation_required" });
    expect(await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1004" }, { mode: "manual", confirmed: false })).toMatchObject({
      status: "confirmation_required",
    });
    // Бажаний режим manual суворіший за налаштування auto.
    expect(await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1011" }, { mode: "manual" })).toMatchObject({
      status: "confirmation_required",
      reason: "manual_mode",
    });
  });

  it("propose_address_change previews the diff and remaining problems without saving", async () => {
    const ctx = env.ctx(STAFF);
    const id = await env.orderId("#1013"); // SE: немає міста + телефон з літерою
    await validateOrderById(env.ctx(OWNER), id);
    const before = await loadOrderRow(ctx.db, id);
    const r = await runAssistantTool(ctx, "propose_address_change", { orderNumber: "#1013", shipping: { city: "Stockholm" } });
    if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
    const p = r.data as { changes: unknown[]; expectedVersion: number; after: { issues: { code: string }[] } };
    expect(p.changes).toEqual([{ field: "shipping.city", from: null, to: "Stockholm" }]);
    expect(p.expectedVersion).toBe(before.version);
    const codes = p.after.issues.map((i) => i.code);
    expect(codes).not.toContain("CITY_MISSING");
    expect(codes).toContain("PHONE_INVALID");
    const after = await loadOrderRow(ctx.db, id);
    expect(after.version).toBe(before.version);
    expect(after.shipCity).toBeNull();
    // Читання не журналюється як зміна.
    expect((await assistantAudit()).some((a) => a.details.tool === "propose_address_change")).toBe(false);
  });

  it("global pause refuses changes but keeps read tools working", async () => {
    await setAutomation("auto", true);
    const ctx = env.ctx(OWNER);
    expect(await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1011" }, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "global_pause",
    });
    expect(await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1001" }, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "global_pause",
    });
    expect(await runAssistantTool(ctx, "find_orders", {})).toMatchObject({ status: "ok" });
    const refused = (await assistantAudit()).filter((a) => a.action === "assistant.tool_refused" && a.details.reason === "global_pause");
    expect(refused.length).toBeGreaterThanOrEqual(2);
  });

  it("per-order pause refuses changes to that order only", async () => {
    await setAutomation("auto");
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1011");
    await setOrderAutomationPaused(ctx, id, true);
    expect(await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1011" }, { confirmed: true })).toMatchObject({
      status: "refused",
      reason: "order_paused",
    });
    expect(await runAssistantTool(ctx, "get_order", { orderNumber: "#1011" })).toMatchObject({ status: "ok" });
    expect(await runAssistantTool(ctx, "revalidate_order", { orderNumber: "#1009" })).toMatchObject({ status: "ok" });
    await setOrderAutomationPaused(ctx, id, false);
  });

  it("create_waybill and cancel_waybill run through the existing services after confirmation", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1001"); // уже awaiting_review (тест manual mode)
    expect((await loadOrderRow(ctx.db, id)).status).toBe("awaiting_review");
    const pending = await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1001" });
    expect(pending).toMatchObject({ status: "confirmation_required", preview: { orderNumber: "#1001", activeWaybill: null } });
    const created = await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1001" }, { confirmed: true });
    expect(created).toMatchObject({ status: "ok", data: { result: "created", shipmentStatus: "created" } });
    // Повтор не створює дубліката.
    expect(await runAssistantTool(ctx, "create_waybill", { orderNumber: "#1001" }, { confirmed: true })).toMatchObject({
      status: "ok",
      data: { result: "already_exists" },
    });
    // Адресу з накладною змінити не можна.
    const version = (await loadOrderRow(ctx.db, id)).version;
    expect(
      await runAssistantTool(ctx, "update_order_address", { orderNumber: "#1001", expectedVersion: version, shipping: { city: "Bonn" } }, { confirmed: true }),
    ).toMatchObject({ status: "error", code: "order.notEditable" });

    // Переоформлення: скасування + нове покоління (одне активне відправлення).
    const first = created.status === "ok" ? (created.data as { waybillNumber: string }).waybillNumber : "";
    // Номер накладної обов'язковий: підтвердження прив'язане до конкретної накладної.
    expect(await runAssistantTool(ctx, "reissue_waybill", { orderNumber: "#1001" })).toMatchObject({
      status: "refused",
      reason: "invalid_input",
    });
    expect(await runAssistantTool(ctx, "reissue_waybill", { orderNumber: "#1001", waybillNumber: first })).toMatchObject({
      status: "confirmation_required",
      reason: "critical_or_financial",
      preview: { reissuable: true, waybillMatches: true, activeWaybill: { waybillNumber: first } },
    });
    const reissued = await runAssistantTool(ctx, "reissue_waybill", { orderNumber: "#1001", waybillNumber: first }, { confirmed: true });
    expect(reissued).toMatchObject({ status: "ok", data: { result: "reissued", cancelledWaybill: first } });
    const second = reissued.status === "ok" ? (reissued.data as { newWaybill: string }).newWaybill : "";
    expect(second).not.toBe(first);

    // Застаріле підтвердження (людина бачила стару накладну) — відмова, активну накладну не скасовано.
    expect(await runAssistantTool(ctx, "cancel_waybill", { orderNumber: "#1001", waybillNumber: first })).toMatchObject({
      status: "confirmation_required",
      preview: { waybillMatches: false, activeWaybill: { waybillNumber: second } },
    });
    for (const tool of ["cancel_waybill", "reissue_waybill"]) {
      expect(await runAssistantTool(ctx, tool, { orderNumber: "#1001", waybillNumber: first }, { confirmed: true }), tool).toMatchObject({
        status: "refused",
        reason: "stale_confirmation",
      });
    }
    expect((await findActiveShipment(ctx.db, id))?.waybillNumber).toBe(second);
    const stale = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "assistant.tool_refused"), eq(auditLog.entityId, id)));
    expect(stale.filter((a) => a.details.reason === "stale_confirmation")).toHaveLength(2);

    const cancelled = await runAssistantTool(ctx, "cancel_waybill", { orderNumber: "#1001", waybillNumber: second.toLowerCase() }, { confirmed: true });
    expect(cancelled).toMatchObject({ status: "ok", data: { cancelled: true, waybillNumber: second } });
    expect(await runAssistantTool(ctx, "cancel_waybill", { orderNumber: "#1001", waybillNumber: second }, { confirmed: true })).toMatchObject({
      status: "error",
      code: "waybill.notCancellable",
    });
    const rows = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "assistant.tool_executed"), eq(auditLog.entityId, id)));
    expect(rows.map((r) => r.details.outcome)).toEqual(expect.arrayContaining(["created", "already_exists", "reissued", "ok"]));
    expect(await runAssistantTool(ctx, "reissue_waybill", { orderNumber: "#1001", waybillNumber: second }, { confirmed: true })).toMatchObject({
      status: "error",
      code: "waybill.reissueNotAllowed",
    });
  });

  it("assistant audit entries contain no personal data", async () => {
    const rows = await assistantAudit();
    expect(rows.length).toBeGreaterThan(5);
    const json = JSON.stringify(rows.map((r) => r.details));
    for (const s of PII_SNIPPETS) expect(json, s).not.toContain(s);
    expect(json).not.toContain("69001");
    expect(json).not.toContain("Stockholm");
  });

  it("order rows are untouched by refused calls", async () => {
    const [row] = await env.handle.db.select().from(orders).where(eq(orders.orderNumber, "#1011"));
    expect(row?.status).toBe("paid");
  });
});

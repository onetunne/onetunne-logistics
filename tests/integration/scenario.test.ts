/**
 * Повний тестовий сценарій етапу 1:
 * оплачене замовлення → перевірка даних → виявлення проблеми → ручне виправлення → тестова накладна,
 * плюс захист від дублікатів накладної.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orderChanges, orders, sandboxCarrierShipments, shipments, auditLog } from "~/db/schema";
import { ForbiddenError } from "~/domain/permissions";
import { ConflictError } from "~/lib/errors";
import { loadOrderAggregate } from "~/modules/orders/repository.server";
import { acceptSuggestion, updateOrderData, validateOrderById } from "~/modules/orders/workflow.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("stage 1 scenario: paid → validate → problem → manual fix → test waybill", () => {
  it("runs end-to-end and never duplicates the waybill", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1004"); // FR, missing postal code

    let agg = await loadOrderAggregate(ctx.db, id);
    expect(agg.order.status).toBe("paid");

    // 1) Перевірка даних → проблема.
    const v1 = await validateOrderById(ctx, id);
    expect(v1.status).toBe("needs_correction");
    expect(v1.blocking).toBe(true);
    agg = await loadOrderAggregate(ctx.db, id);
    expect(agg.openIssues.map((i) => i.code)).toContain("POSTAL_CODE_MISSING");
    // Однозначне автовиправлення формату телефону збережено з історією.
    expect(agg.order.shipPhone).toBe("+33612345678");
    const autoChanges = await ctx.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, id), eq(orderChanges.source, "auto_fix")));
    expect(autoChanges.find((c) => c.field === "shipping.phone")).toMatchObject({ oldValue: "+33 6 12 34 56 78", newValue: "+33612345678" });

    // Повторна перевірка не дублює проблеми.
    await validateOrderById(ctx, id);
    const openIssues = await ctx.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.status, "open")));
    expect(openIssues.filter((i) => i.code === "POSTAL_CODE_MISSING")).toHaveLength(1);

    // Накладну не можна створити, поки є проблеми.
    const blocked = await createWaybill(ctx, id);
    expect(blocked).toMatchObject({ kind: "blocked", reason: "status" });

    // 2) Ручне виправлення (з версією для захисту від одночасних змін).
    agg = await loadOrderAggregate(ctx.db, id);
    await expect(
      updateOrderData(ctx, id, { expectedVersion: agg.order.version - 1, shipping: { postalCode: "69001" } }),
    ).rejects.toBeInstanceOf(ConflictError);
    const upd = await updateOrderData(ctx, id, {
      expectedVersion: agg.order.version,
      reason: "Клієнт підтвердив індекс",
      shipping: { postalCode: "69001" },
    });
    expect(upd.changedFields).toEqual(["shipping.postalCode"]);
    expect(upd.sync).toEqual({ status: "skipped", reason: "demo_mode" });
    expect(upd.validation?.status).toBe("awaiting_review");
    const manual = await ctx.db.select().from(orderChanges).where(and(eq(orderChanges.orderId, id), eq(orderChanges.source, "manual")));
    expect(manual).toHaveLength(1);
    expect(manual[0]).toMatchObject({ field: "shipping.postalCode", oldValue: null, newValue: "69001", reason: "Клієнт підтвердив індекс" });
    const resolved = await ctx.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.code, "POSTAL_CODE_MISSING")));
    expect(resolved[0]?.status).toBe("resolved");

    // 3) Тестова накладна.
    const created = await createWaybill(ctx, id);
    expect(created.kind).toBe("created");
    if (created.kind !== "created") throw new Error("unreachable");
    expect(created.shipment.waybillNumber).toMatch(/^TEST\d{10}$/);
    expect(created.shipment.mode).toBe("test");
    agg = await loadOrderAggregate(ctx.db, id);
    expect(agg.order.status).toBe("waybill_created"); // НЕ «відправлено»

    // 4) Повторна обробка → без дубліката, без звернення до перевізника.
    const again = await createWaybill(ctx, id);
    expect(again.kind).toBe("already_exists");
    if (again.kind === "already_exists") expect(again.shipment.id).toBe(created.shipment.id);
    const all = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(all).toHaveLength(1);
    const remote = await ctx.db
      .select()
      .from(sandboxCarrierShipments)
      .where(eq(sandboxCarrierShipments.reference, created.shipment.carrierReference));
    expect(remote).toHaveLength(1);
  });

  it("parallel create requests produce exactly one waybill", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1001");
    await validateOrderById(ctx, id);
    const results = await Promise.all(Array.from({ length: 5 }, () => createWaybill(ctx, id).catch((e) => e)));
    const kinds = results.map((r) => (r instanceof Error ? "error" : r.kind));
    expect(kinds.filter((k) => k === "created")).toHaveLength(1);
    const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(rows.filter((s) => s.status === "created")).toHaveLength(1);
    expect(rows).toHaveLength(1);
  });

  it("manager resolves an ambiguous phone by choosing a candidate", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1006");
    await validateOrderById(ctx, id);
    const agg = await loadOrderAggregate(ctx.db, id);
    const amb = agg.openIssues.find((i) => i.code === "PHONE_AMBIGUOUS");
    expect(amb?.suggestion?.candidates.length).toBeGreaterThan(1);
    const it = amb!.suggestion!.candidates.find((c) => c.startsWith("+39"))!;
    const summary = await acceptSuggestion(ctx, amb!.id, it);
    expect(summary.status).toBe("awaiting_review");
    const [row] = await ctx.db.select().from(orders).where(eq(orders.id, id));
    expect(row?.shipPhone).toBe(it);
  });
});

describe("carrier failures do not create duplicates", () => {
  it("fail_after_create → reconciled via lookup, single waybill", async () => {
    const ctx = env.ctx(OWNER);
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "fail_after_create" });
    const id = await env.orderId("#1009"); // AE, clean
    await validateOrderById(ctx, id);
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("recovered");
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "none" });
    const again = await createWaybill(ctx, id);
    expect(again.kind).toBe("already_exists");
    const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(rows).toHaveLength(1);
    const remote = await ctx.db.select().from(sandboxCarrierShipments).where(eq(sandboxCarrierShipments.reference, rows[0]!.carrierReference));
    expect(remote).toHaveLength(1);
  });

  it("timeout_before_create → confirmed not created → safe retry with same reference", async () => {
    const ctx = env.ctx(OWNER);
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "timeout_before_create" });
    const id = await env.orderId("#1012");
    await validateOrderById(ctx, id);
    const r1 = await createWaybill(ctx, id);
    expect(r1.kind).toBe("not_created");
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "none" });
    const r2 = await createWaybill(ctx, id);
    expect(r2.kind).toBe("created");
    const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(2);
    const open = await ctx.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.status, "open")));
    expect(open.filter((i) => i.code.startsWith("CARRIER_"))).toHaveLength(0);
  });

  it("carrier rejection → problem shown, order needs correction, no waybill", async () => {
    const ctx = env.ctx(OWNER);
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "reject" });
    const id = await env.orderId("#1002");
    await validateOrderById(ctx, id);
    const r = await createWaybill(ctx, id);
    expect(r.kind).toBe("rejected");
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "none" });
    const [o] = await ctx.db.select().from(orders).where(eq(orders.id, id));
    expect(o?.status).toBe("needs_correction");
    const open = await ctx.db.select().from(issues).where(and(eq(issues.orderId, id), eq(issues.status, "open")));
    expect(open.map((i) => i.code)).toContain("CARRIER_REJECTED");
  });
});

describe("permissions are enforced server-side", () => {
  it("staff cannot change settings or automation", async () => {
    const ctx = env.ctx(STAFF);
    await expect(updateSetting(ctx.db, STAFF, "automation", { mode: "auto", globalPause: false })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSetting(ctx.db, STAFF, "shipper", {})).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("audit log contains no customer personal data", async () => {
    const rows = await env.handle.db.select().from(auditLog);
    const text = JSON.stringify(rows.map((r) => r.details));
    expect(text).not.toMatch(/@example\.(com|org)/);
    expect(text).not.toMatch(/\+\d{8,}/);
    expect(text).not.toMatch(/Hoffmann|Martin|Rossi/);
  });
});

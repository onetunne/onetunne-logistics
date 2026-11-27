import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { orders, settingsHistory, shipments } from "~/db/schema";
import { DEMO_SALES_HISTORY } from "~/db/seed/demo-data";
import { insertSimulatedOrder, resetDemoData } from "~/db/seed/seed.server";
import { ConflictError } from "~/lib/errors";
import { listOrders, countOrdersByStatus } from "~/modules/orders/repository.server";
import { dismissIssue, setOrderAutomationPaused, updateVariantCustomsData, validateOrderById, validateOrders, listOrderIdsByStatus } from "~/modules/orders/workflow.server";
import { getSetting, loadSettings, updateSetting } from "~/modules/settings/settings.server";
import { cancelOrder, cancelWaybill, createWaybill, processPaidOrder } from "~/modules/shipments/waybill.server";
import { claimWebhook, completeWebhook } from "~/modules/webhooks/dedupe.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../helpers";
import { ForbiddenError } from "~/domain/permissions";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe("demo seed", () => {
  it("contains fictional orders in the expected initial states", async () => {
    const counts = await countOrdersByStatus(env.handle.db);
    expect(counts.paid).toBe(13);
    expect(counts.waybill_created).toBe(1);
    // #0997 + вигадана історія продажів для аналітики (без накладних; tests/stage5/seed-sales-history.test.ts).
    expect(counts.delivered).toBe(1 + DEMO_SALES_HISTORY.length);
    expect(counts.handed_to_carrier).toBe(0);
    expect(counts.cancelled).toBe(1);
    const cancelled = await env.orderId("#0996");
    const s = await env.handle.db.select().from(shipments).where(eq(shipments.orderId, cancelled));
    expect(s[0]?.status).toBe("cancelled");
  });

  it("bulk validation produces the documented scenario outcomes", async () => {
    const ctx = env.ctx(OWNER);
    const ids = await listOrderIdsByStatus(ctx.db, ["paid"]);
    const res = await validateOrders(ctx, ids);
    expect(res.failed).toEqual([]);
    const byNumber = async (n: string) => (await ctx.db.select().from(orders).where(eq(orders.id, await env.orderId(n))))[0]!;
    expect((await byNumber("#1001")).status).toBe("awaiting_review");
    expect((await byNumber("#1002")).shipPostalCode).toBe("00-950");
    expect((await byNumber("#1002")).shipPhone).toBe("+48512345678");
    expect((await byNumber("#1003")).shipPostalCode).toBe("SW1A 1AA");
    expect((await byNumber("#1003")).shipCountryCode).toBe("GB");
    expect((await byNumber("#1004")).status).toBe("needs_correction");
    expect((await byNumber("#1005")).status).toBe("needs_correction");
    expect((await byNumber("#1006")).status).toBe("needs_correction");
    expect((await byNumber("#1007")).shipPostalCode).toBe("1012 AB");
    expect((await byNumber("#1008")).status).toBe("needs_correction");
    expect((await byNumber("#1009")).status).toBe("awaiting_review");
    expect((await byNumber("#1010")).status).toBe("needs_correction");
    expect((await byNumber("#1011")).shipPostalCode).toBe("K1A 0B1");
    expect((await byNumber("#1012")).shipPhone).toBe("+491701234567");
    expect((await byNumber("#1013")).status).toBe("needs_correction");
    const list = await listOrders(ctx.db, { withProblems: true });
    expect(list.rows.map((r) => r.orderNumber).sort()).toEqual(["#1004", "#1005", "#1006", "#1008", "#1010", "#1013"]);
  });

  it("demo product fix revalidates affected orders", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1008");
    const [line] = await ctx.db.query.orderLineItems.findMany({ where: (t, { eq }) => eq(t.orderId, id) });
    const r = await updateVariantCustomsData(ctx, line!.variantId!, {
      weightGrams: 900,
      hsCode: "4011.50",
      countryOfOrigin: "ua",
      customsDescription: "Scooter tire 10x2.5",
    });
    expect(r.revalidated).toBe(1);
    const [o] = await ctx.db.select().from(orders).where(eq(orders.id, id));
    expect(o?.status).toBe("awaiting_review");
  });

  it("search escapes LIKE wildcards", async () => {
    const res = await listOrders(env.handle.db, { q: "%" });
    expect(res.total).toBe(0);
    const res2 = await listOrders(env.handle.db, { q: "berlin" });
    expect(res2.rows.map((r) => r.orderNumber)).toContain("#1001");
  });
});

describe("settings", () => {
  it("versioned updates with history and optimistic locking", async () => {
    const db = env.handle.db;
    const { versions } = await loadSettings(db);
    const r = await updateSetting(db, OWNER, "automation", { mode: "auto", globalPause: false }, versions.automation);
    expect(r.ok).toBe(true);
    await expect(updateSetting(db, OWNER, "automation", { mode: "manual", globalPause: false }, versions.automation)).rejects.toBeInstanceOf(ConflictError);
    const history = await db.select().from(settingsHistory).where(eq(settingsHistory.key, "automation"));
    expect(history.length).toBeGreaterThanOrEqual(2);
    const bad = await updateSetting(db, OWNER, "shipper", { companyName: "x" });
    expect(bad.ok).toBe(false);
  });

  it("automation modes and global pause control processing of new orders", async () => {
    const ctx = env.ctx(OWNER);
    await updateSetting(ctx.db, OWNER, "automation", { mode: "auto", globalPause: true });
    const a = await insertSimulatedOrder(ctx);
    const r1 = await processPaidOrder(ctx, a);
    expect(r1.validated).toBe(false);
    await updateSetting(ctx.db, OWNER, "automation", { mode: "auto", globalPause: false });
    const r2 = await processPaidOrder(ctx, a);
    expect(r2.validated).toBe(true);
    expect(r2.waybill?.kind).toBe("created");
    await updateSetting(ctx.db, OWNER, "automation", { mode: "manual", globalPause: false });
    const b = await insertSimulatedOrder(ctx);
    expect((await processPaidOrder(ctx, b)).validated).toBe(false);
    await updateSetting(ctx.db, OWNER, "automation", { mode: "semi", globalPause: false });
    await setOrderAutomationPaused(ctx, b, true);
    expect((await processPaidOrder(ctx, b)).validated).toBe(false);
    await setOrderAutomationPaused(ctx, b, false);
    const r3 = await processPaidOrder(ctx, b);
    expect(r3.validated).toBe(true);
    expect(r3.waybill).toBeNull();
    expect((await getSetting(ctx.db, "automation")).mode).toBe("semi");
  });
});

describe("cancellation and re-issue", () => {
  it("cancel waybill → re-create gets a new generation, never two active", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1011");
    await validateOrderById(ctx, id);
    const first = await createWaybill(ctx, id);
    expect(first.kind).toBe("created");
    if (first.kind !== "created") return;
    await cancelWaybill(ctx, first.shipment.id);
    const second = await createWaybill(ctx, id);
    expect(second.kind).toBe("created");
    if (second.kind !== "created") return;
    expect(second.shipment.generation).toBe(2);
    expect(second.shipment.waybillNumber).not.toBe(first.shipment.waybillNumber);
    await cancelOrder(ctx, id);
    const rows = await ctx.db.select().from(shipments).where(eq(shipments.orderId, id));
    expect(rows.every((r) => r.status === "cancelled")).toBe(true);
  });

  it("staff cannot cancel orders or manage waybills", async () => {
    const ctx = env.ctx(STAFF);
    await expect(cancelOrder(ctx, await env.orderId("#1001"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("errors cannot be dismissed", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1010");
    const [issue] = await ctx.db.query.issues.findMany({ where: (t, { and, eq }) => and(eq(t.orderId, id), eq(t.status, "open")) });
    await expect(dismissIssue(ctx, issue!.id)).rejects.toThrow();
  });
});

describe("webhook dedupe", () => {
  it("claims a webhook id only once", async () => {
    const db = env.handle.db;
    expect(await claimWebhook(db, { webhookId: "w-1", topic: "orders/paid", shop: "x.myshopify.com" })).toBe(true);
    await completeWebhook(db, "w-1");
    expect(await claimWebhook(db, { webhookId: "w-1", topic: "orders/paid", shop: "x.myshopify.com" })).toBe(false);
  });
});

describe("demo reset", () => {
  it("restores the initial dataset", async () => {
    const ctx = env.ctx(OWNER);
    await resetDemoData(ctx);
    const counts = await countOrdersByStatus(ctx.db);
    expect(counts.paid).toBe(13);
    expect((await getSetting(ctx.db, "automation")).mode).toBe("semi");
  });
});

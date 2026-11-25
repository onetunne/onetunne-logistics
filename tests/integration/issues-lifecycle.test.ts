import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { issues, orders } from "~/db/schema";
import { dismissIssue, updateOrderData, validateOrderById } from "~/modules/orders/workflow.server";
import { loadOrderRow } from "~/modules/orders/repository.server";
import { updateSetting } from "~/modules/settings/settings.server";
import { cancelOrder, createWaybill } from "~/modules/shipments/waybill.server";
import { createTestEnv, OWNER, type TestEnv } from "../helpers";

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

const openIssues = (orderId: string) =>
  env.handle.db.select().from(issues).where(and(eq(issues.orderId, orderId), eq(issues.status, "open")));

describe("issue lifecycle", () => {
  it("a dismissed warning does not come back on re-check", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1001");
    const o = await loadOrderRow(ctx.db, id);
    await updateOrderData(ctx, id, { expectedVersion: o.version, email: "not-an-email" });
    const warn = (await openIssues(id)).find((i) => i.code === "EMAIL_INVALID");
    expect(warn?.severity).toBe("warning");
    await dismissIssue(ctx, warn!.id);
    await validateOrderById(ctx, id);
    expect((await openIssues(id)).filter((i) => i.code === "EMAIL_INVALID")).toHaveLength(0);
  });

  it("cancelling an order closes its open problems", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1010"); // RU — доставку заборонено
    await validateOrderById(ctx, id);
    expect((await openIssues(id)).length).toBeGreaterThan(0);
    await cancelOrder(ctx, id);
    expect(await openIssues(id)).toHaveLength(0);
    const [row] = await ctx.db.select().from(issues).where(eq(issues.orderId, id));
    expect(row?.resolution).toBe("order_cancelled");
  });

  it("a carrier rejection keeps the order blocked until data is edited or the rejection is closed", async () => {
    const ctx = env.ctx(OWNER);
    const id = await env.orderId("#1009");
    await validateOrderById(ctx, id);
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "reject" });
    expect((await createWaybill(ctx, id)).kind).toBe("rejected");
    await updateSetting(ctx.db, OWNER, "testCarrier", { simulation: "none" });
    // Повторна перевірка без змін не робить замовлення «готовим».
    expect((await validateOrderById(ctx, id)).status).toBe("needs_correction");
    const rejection = (await openIssues(id)).find((i) => i.code === "CARRIER_REJECTED")!;
    // Менеджер свідомо закриває відмову → замовлення знову готове, накладна створюється.
    await dismissIssue(ctx, rejection.id);
    const [o] = await ctx.db.select().from(orders).where(eq(orders.id, id));
    expect(o?.status).toBe("awaiting_review");
    expect((await createWaybill(ctx, id)).kind).toBe("created");
  });
});

import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { issues, orderLineItems, productVariants, shipments } from "~/db/schema";
import { loadLineItems, loadOrderRow, toValidationInput } from "~/modules/orders/repository.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { OWNER, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресія packing-2 (повторна рецензія G1b, RV3): перевірка даних — з тих самих ефективних кількостей (Shopify
 * currentQuantity), що й пакування, митні позиції й вага. Повністю повернене, але не скасоване замовлення не проходить
 * перевірку (ORDER_NO_ITEMS) і не доходить до перевізника; повернені/видалені позиції не перевіряються.
 */
let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

async function openCodes(orderId: string): Promise<string[]> {
  const rows = await env.handle.db
    .select({ code: issues.code })
    .from(issues)
    .where(and(eq(issues.orderId, orderId), eq(issues.status, "open")));
  return rows.map((r) => r.code);
}

describe("validation uses the quantities that are shipped", () => {
  it("a fully refunded (every currentQuantity 0) but not cancelled order is blocked and never reaches the carrier", async () => {
    const id = await env.orderId("#1009");
    await validateOrderById(env.ctx(OWNER), id);
    expect((await loadOrderRow(env.handle.db, id)).status).toBe("awaiting_review");
    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, id));

    const items = await loadLineItems(env.handle.db, id);
    expect(toValidationInput({ order: await loadOrderRow(env.handle.db, id), items }).items).toEqual([]);
    const summary = await validateOrderById(env.ctx(OWNER), id);
    expect(summary.blocking).toBe(true);
    expect(await openCodes(id)).toContain("ORDER_NO_ITEMS");

    // Блокувальна проблема → замовлення не «Очікує перевірки»: накладну не створити, запиту до перевізника немає.
    expect((await loadOrderRow(env.handle.db, id)).status).not.toBe("awaiting_review");
    const r = await createWaybill(env.ctx(OWNER), id);
    expect(r).toMatchObject({ kind: "blocked", reason: "status" });
    expect(await env.handle.db.select().from(shipments).where(eq(shipments.orderId, id))).toEqual([]);
  });

  it("createWaybill re-validates: lines refunded after the check block the waybill (no carrier request)", async () => {
    const id = await env.orderId("#1001");
    await validateOrderById(env.ctx(OWNER), id);
    expect((await loadOrderRow(env.handle.db, id)).status).toBe("awaiting_review");
    // Повернення в Shopify після перевірки (ще до накладної).
    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.orderId, id));
    const r = await createWaybill(env.ctx(OWNER), id);
    expect(r).toMatchObject({ kind: "blocked", reason: "validation" });
    expect(await env.handle.db.select().from(shipments).where(eq(shipments.orderId, id))).toEqual([]);
    expect(await openCodes(id)).toContain("ORDER_NO_ITEMS");
  });

  it("a removed line is not validated (its missing product data does not block); the remaining line is, with its shipped quantity", async () => {
    const id = await env.orderId("#1012");
    const items = await loadLineItems(env.handle.db, id);
    expect(items.length).toBeGreaterThanOrEqual(2);
    const [kept, removed] = [items[0]!, items[1]!];
    await env.handle.db.update(productVariants).set({ weightGrams: null }).where(eq(productVariants.id, removed.variant!.id));
    await env.handle.db.update(orderLineItems).set({ quantity: 3, currentQuantity: 1 }).where(eq(orderLineItems.id, kept.id));

    await validateOrderById(env.ctx(OWNER), id);
    expect(await openCodes(id)).toContain("PRODUCT_WEIGHT_MISSING");

    await env.handle.db.update(orderLineItems).set({ currentQuantity: 0 }).where(eq(orderLineItems.id, removed.id));
    const input = toValidationInput({ order: await loadOrderRow(env.handle.db, id), items: await loadLineItems(env.handle.db, id) });
    expect(input.items.map((i) => [i.lineItemId, i.quantity])).toEqual([[kept.id, 1]]);
    await validateOrderById(env.ctx(OWNER), id);
    const codes = await openCodes(id);
    expect(codes).not.toContain("PRODUCT_WEIGHT_MISSING");
    expect(codes).not.toContain("ORDER_NO_ITEMS");
  });
});

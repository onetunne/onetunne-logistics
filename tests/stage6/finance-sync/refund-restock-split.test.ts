/**
 * Етап 6 (інтеграційний раунд ядра, міграція 0013): writeRefunds зберігає розподіл кількості за видом повернення на
 * склад, коли кілька рядків повернення ОДНІЄЇ позиції з РІЗНИМИ видами об'єднано в рядок `MIXED`
 * (`order_refund_lines.restock_quantities` = {вид → кількість}, Σ = quantity); інакше — null. Вигадані дані.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { orderRefundLines, orderRefunds } from "~/db/schema";
import { agreement, bag, financeNode, refund, refundLine, sale, transaction, type FinanceOrderFixture } from "../fixtures/shopify-finance";
import { openFinanceSyncEnv, type FinanceSyncEnv } from "./helpers";

vi.mock("~/modules/order-finance/sync.server", () => ({ syncOrderFinance: async () => undefined }));

let env: FinanceSyncEnv;
beforeAll(async () => {
  env = await openFinanceSyncEnv();
});
afterAll(async () => {
  await env.close();
});

const gid = (n: number) => `gid://shopify/Order/${n}`;

describe("order_refund_lines.restock_quantities (0013)", () => {
  it("MIXED keeps the per-restock-type split; same-type merges and single lines keep null", async () => {
    const { gqlOrder } = await import("../../stage2/fixtures");
    const base = gqlOrder(9231).lineItems.nodes[0]!;
    const orderId = await env.createOrder(9231, {
      lineItems: {
        nodes: [
          { ...base, id: "gid://shopify/LineItem/923101", quantity: 4 },
          { ...base, id: "gid://shopify/LineItem/923102", quantity: 3 },
          { ...base, id: "gid://shopify/LineItem/923103", quantity: 1 },
        ],
      },
    });
    const ref = refund({
      amount: "120.00",
      lines: [
        // Позиція 1: CANCEL 1 + RETURN 2 + NO_RESTOCK 1 → MIXED 4 з розподілом.
        refundLine("gid://shopify/LineItem/923101", 1, "CANCEL", false, "10.00"),
        refundLine("gid://shopify/LineItem/923101", 2, "RETURN", true, "40.00"),
        refundLine("gid://shopify/LineItem/923101", 1, "NO_RESTOCK", false, "20.00"),
        // Позиція 2: RETURN 1 + RETURN 2 — той самий вид → RETURN 3, розподілу немає.
        refundLine("gid://shopify/LineItem/923102", 1, "RETURN", true, "15.00"),
        refundLine("gid://shopify/LineItem/923102", 2, "RETURN", true, "30.00"),
        // Позиція 3: один рядок.
        refundLine("gid://shopify/LineItem/923103", 1, "LEGACY_RESTOCK", true, "5.00"),
      ],
    });
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9231), {
        transactions: [transaction({ amount: "200.00" }), transaction({ kind: "REFUND", amount: "120.00", processedAt: "2026-11-04T10:00:00Z" })],
        totals: { currentTotalPriceSet: bag("80.00"), netPaymentSet: bag("80.00"), totalRefundedSet: bag("120.00") },
      }),
      agreements: [
        agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "200.00", quantity: 8, lineItem: "gid://shopify/LineItem/923101" })]),
        agreement("RefundAgreement", "2026-11-04T10:00:00Z", [sale({ total: "-120.00", quantity: -8, actionType: "RETURN", lineItem: "gid://shopify/LineItem/923101" })], {
          refund: { id: ref.id },
        }),
      ],
      refunds: [ref],
    };
    env.store.set(gid(9231), fx);
    const r = await env.sync(gid(9231));
    expect(r).toMatchObject({ status: "synced", refundsRead: true, refunds: 1, refundLines: 3 });
    const rows = await env.db
      .select({ line: orderRefundLines })
      .from(orderRefundLines)
      .innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId))
      .where(eq(orderRefunds.orderId, orderId));
    const byLine = new Map(rows.map((x) => [x.line.shopifyLineItemId, x.line]));
    expect(byLine.get("gid://shopify/LineItem/923101")).toMatchObject({
      quantity: 4,
      restockType: "MIXED",
      restocked: null,
      restockQuantities: { CANCEL: 1, NO_RESTOCK: 1, RETURN: 2 },
      subtotal: "70.00",
    });
    expect(byLine.get("gid://shopify/LineItem/923102")).toMatchObject({ quantity: 3, restockType: "RETURN", restocked: true, restockQuantities: null });
    expect(byLine.get("gid://shopify/LineItem/923103")).toMatchObject({ quantity: 1, restockType: "LEGACY_RESTOCK", restockQuantities: null });
    // Σ розподілу = кількість рядка.
    const split = byLine.get("gid://shopify/LineItem/923101")!.restockQuantities!;
    expect(Object.values(split).reduce((a, b) => a + b, 0)).toBe(4);
  });

  it("the column rejects a non-object value (CHECK)", async () => {
    const [row] = await env.db.select({ id: orderRefundLines.id }).from(orderRefundLines).limit(1);
    await expect(env.db.update(orderRefundLines).set({ restockQuantities: [1, 2] as never }).where(eq(orderRefundLines.id, row!.id))).rejects.toThrow();
  });
});

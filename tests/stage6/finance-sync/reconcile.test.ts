/**
 * Етап 6 (WP3): звірка RC1–RC5 (docs/stage6-design.md §16.5) — чиста функція, без допуску; кандидати (RC1, RC4) лише
 * позначають, підтверджені (RC2, RC3, RC5) роблять складник partial, доки розбіжність відкрита. Золотий G2 — RC4 без
 * розбіжності (податок доставки 1,60 у currentTotalTaxSet не входить).
 */
import { describe, expect, it } from "vitest";
import { RECONCILIATION_CANDIDATES } from "~/domain/finance";
import {
  factChangeDedupeParts,
  factChangeKeyPrefix,
  mismatchedChecks,
  parseReconciliation,
  partialComponentsOf,
  reconcileOrder,
  reconciliationDedupeParts,
  unknownReconciliation,
  type ReconcileInput,
} from "~/modules/finance-sync/reconcile";

const s = (agreementKind: ReconcileInput["sales"][number]["agreementKind"], lineType: string, totalAmount: string, totalTax = "0.00", quantity: number | null = 1) => ({
  agreementKind,
  lineType,
  quantity,
  totalAmount,
  totalTax,
  currency: "EUR",
});
const t = (kind: string, amount: string, status = "SUCCESS") => ({ kind, status, amount, currency: "EUR" });

/** G2: товар 59,50 (податок 9,50), доставка 10,00 (податок 1,60), оплачено 69,50. */
function g2(over: Partial<ReconcileInput> = {}): ReconcileInput {
  return {
    shopCurrency: "EUR",
    currentTotalPrice: "69.50",
    currentTotalTax: "9.50",
    netPayment: "69.50",
    totalRefunded: "0.00",
    sales: [s("order", "PRODUCT", "59.50", "9.50"), s("order", "SHIPPING", "10.00", "1.60", null)],
    salesStatus: "complete",
    transactions: [t("SALE", "69.50")],
    transactionsStatus: "complete",
    refundHeaders: [],
    ...over,
  };
}

describe("RC1–RC5", () => {
  it("golden G2: all checks pass, RC4 counts only PRODUCT tax (shipping tax 1.60 gives no mismatch)", () => {
    const r = reconcileOrder(g2());
    expect(r.checks.RC1).toMatchObject({ status: "ok", candidate: true, expected: "69.50", actual: "69.50" });
    expect(r.checks.RC2).toMatchObject({ status: "ok", candidate: false, expected: "69.50", actual: "69.50" });
    expect(r.checks.RC3).toMatchObject({ status: "ok", expected: "0.00", actual: "0.00" });
    expect(r.checks.RC4).toMatchObject({ status: "ok", candidate: true, expected: "9.50", actual: "9.50" });
    expect(r.checks.RC5).toMatchObject({ status: "not_applicable" });
    expect(mismatchedChecks(r)).toEqual([]);
    // Контроль: якби RC4 враховував податок доставки, була б розбіжність 11,10 ≠ 9,50.
    expect(reconcileOrder(g2({ currentTotalTax: "11.10" })).checks.RC4).toMatchObject({ status: "mismatch", actual: "9.50" });
  });

  it("candidates are exactly RC1 and RC4 (one constant)", () => {
    expect([...RECONCILIATION_CANDIDATES].sort()).toEqual(["RC1", "RC4"]);
  });

  it("RC2: SUCCESS SALE/CAPTURE − SUCCESS REFUND = netPayment; PENDING/FAILURE and AUTHORIZATION do not count", () => {
    const tx = [t("AUTHORIZATION", "69.50"), t("CAPTURE", "69.50"), t("SALE", "5.00", "FAILURE"), t("REFUND", "20.00"), t("REFUND", "1.00", "PENDING")];
    expect(reconcileOrder(g2({ transactions: tx, netPayment: "49.50", totalRefunded: "20.00" })).checks.RC2).toMatchObject({ status: "ok", actual: "49.50" });
    expect(reconcileOrder(g2({ transactions: tx, netPayment: "69.50", totalRefunded: "20.00" })).checks.RC2).toMatchObject({ status: "mismatch", expected: "69.50", actual: "49.50" });
  });

  it("RC3: Σ SUCCESS REFUND = totalRefunded; and the refund headers when fully read", () => {
    const tx = [t("SALE", "69.50"), t("REFUND", "45.00")];
    const sales = [...g2().sales, s("refund", "PRODUCT", "-45.00", "0.00", -1)];
    const base = g2({ transactions: tx, netPayment: "24.50", totalRefunded: "45.00", sales, currentTotalPrice: "24.50" });
    expect(reconcileOrder({ ...base, refundHeaders: [{ total: "45.00", currency: "EUR" }] }).checks.RC3).toMatchObject({ status: "ok" });
    expect(reconcileOrder({ ...base, refundHeaders: [{ total: "40.00", currency: "EUR" }] }).checks.RC3).toMatchObject({
      status: "mismatch",
      reason: "refund_headers_mismatch",
    });
    expect(reconcileOrder({ ...base, totalRefunded: "50.00", refundHeaders: null }).checks.RC3).toMatchObject({ status: "mismatch", expected: "50.00", actual: "45.00" });
  });

  it("RC5: refund/return sales must be ≤ 0 (amount and quantity); a positive refund sale is a mismatch", () => {
    const ok = reconcileOrder(g2({ sales: [...g2().sales, s("return", "PRODUCT", "-45.00", "0.00", -1), s("refund", "ADJUSTMENT", "-5.00", "0.00", null)] }));
    expect(ok.checks.RC5).toMatchObject({ status: "ok", violations: 0 });
    const bad = reconcileOrder(g2({ sales: [...g2().sales, s("refund", "PRODUCT", "45.00", "0.00", 1), s("refund", "PRODUCT", "-1.00", "0.00", 1)] }));
    expect(bad.checks.RC5).toMatchObject({ status: "mismatch", violations: 2, candidate: false });
  });

  it("incomplete or damaged data → unknown, never a pass", () => {
    const truncated = reconcileOrder(g2({ transactionsStatus: "truncated" }));
    expect(truncated.checks.RC2).toMatchObject({ status: "unknown", reason: "transactions_truncated" });
    expect(truncated.checks.RC3).toMatchObject({ status: "unknown", reason: "transactions_truncated" });
    const damaged = reconcileOrder(g2({ salesStatus: "damaged" }));
    for (const c of ["RC1", "RC4", "RC5"] as const) expect(damaged.checks[c]).toMatchObject({ status: "unknown", reason: "sales_damaged" });
    expect(reconcileOrder(g2({ salesStatus: "not_read" })).checks.RC1).toMatchObject({ status: "unknown", reason: "sales_not_read" });
    expect(reconcileOrder(g2({ netPayment: null })).checks.RC2).toMatchObject({ status: "unknown", reason: "total_missing" });
    expect(unknownReconciliation().checks.RC3.status).toBe("unknown");
  });

  it("partialComponentsOf: confirmed mismatch with an OPEN discrepancy → partial; candidate or owner-resolved → not", () => {
    const r = reconcileOrder(g2({ netPayment: "60.00", currentTotalPrice: "70.00" })); // RC2 і RC1
    expect(mismatchedChecks(r)).toEqual(["RC1", "RC2"]);
    expect(partialComponentsOf(r, [{ check: "RC2", status: "open" }, { check: "RC1", status: "open" }])).toEqual(["fees"]);
    expect(partialComponentsOf(r, [{ check: "RC2", status: "resolved" }])).toEqual([]);
    expect(partialComponentsOf(r, [{ check: "sale", status: "open" }, { check: "fee", status: "open" }]).sort()).toEqual(["fees", "revenue"]);
    const rc3 = reconcileOrder(g2({ totalRefunded: "1.00" }));
    expect(partialComponentsOf(rc3, [{ check: "RC3", status: "open" }])).toEqual(["revenue"]);
    expect(partialComponentsOf(null, [])).toEqual([]);
  });

  it("dedupe parts carry the values: another mismatch is another discrepancy; stored JSON round-trips", () => {
    const a = reconcileOrder(g2({ netPayment: "60.00" }));
    const b = reconcileOrder(g2({ netPayment: "61.00" }));
    expect(reconciliationDedupeParts("o1", "RC2", a.checks.RC2)).not.toEqual(reconciliationDedupeParts("o1", "RC2", b.checks.RC2));
    expect(parseReconciliation(JSON.parse(JSON.stringify(a)))).toEqual(a);
    expect(parseReconciliation({ version: 2 })).toBeNull();
    expect(parseReconciliation(null)).toBeNull();
  });

  it("§16.3: a changed immutable fact key carries the observed values — another value of the same Sale.id is another discrepancy", () => {
    const sale = "gid://shopify/ProductSale/1";
    const a = factChangeDedupeParts("o1", "sale", sale, ["totalAmount", "59.00"]);
    expect(factChangeDedupeParts("o1", "sale", sale, ["totalAmount", "59.00"])).toEqual(a);
    expect(factChangeDedupeParts("o1", "sale", sale, ["totalAmount", "10.00"])).not.toEqual(a);
    expect(factChangeDedupeParts("o1", "sale", sale, ["totalTax", "59.00"])).not.toEqual(a);
    expect(a.slice(0, 3)).toEqual(["o1", "sale", sale]);
    expect(a[3]).toMatch(/^[0-9a-f]{16}$/);
    // Префікс одного факту не захоплює інший id з тим самим початком.
    const key = ["reconciliation_mismatch", ...a].join(":");
    expect(key.startsWith(factChangeKeyPrefix("o1", "sale", sale))).toBe(true);
    expect(key.startsWith(factChangeKeyPrefix("o1", "sale", "gid://shopify/ProductSale/12"))).toBe(false);
    expect(["reconciliation_mismatch", ...factChangeDedupeParts("o1", "sale", "gid://shopify/ProductSale/12", ["x"])].join(":").startsWith(factChangeKeyPrefix("o1", "sale", sale))).toBe(false);
  });
});

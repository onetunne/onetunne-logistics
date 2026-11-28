/**
 * Етап 6, WP9 (ревізія): чисте віднесення джерел до випадків (app/modules/returns/attribution.ts).
 * - походження позицій за детермінованими id (повернення коштів з видом / надходження);
 * - власник джерела: випадок із ключем джерела, інакше — випадок з його позиціями; джерело без випадку — нічиє;
 * - «Очікує надходження на склад» (§6.7): RETURN / LEGACY_RESTOCK без надходження; MIXED — «можливо»; закритий,
 *   «Лише повернення коштів», «Втрачено», NO_RESTOCK — ні;
 * - запис журналу → випадок за джерелом (продаж угоди повернення, оцінка складу, ручна витрата); інакше null.
 */
import { describe, expect, it } from "vitest";
import { caseInsight, entryCase, lineOrigins, sourceOwners, type EntrySourceMaps } from "~/modules/returns/attribution";
import { returnLineId, returnSourceKeys } from "~/modules/returns/keys";
import { receiptLineIds, type RefundSource } from "~/modules/returns/rules";

const T = new Date("2026-11-01T10:00:00Z");
const refund = (id: string, types: Array<string | null>): RefundSource => ({
  refundId: id,
  at: T,
  lines: types.map((t, i) => ({
    shopifyLineItemId: `gid://shopify/LineItem/${i + 1}`,
    orderLineItemId: `li-${i + 1}`,
    variantId: `v-${i + 1}`,
    quantity: 2,
    restockType: t,
  })),
});
const refundLine = (refundId: string, n: number) => returnLineId(returnSourceKeys.refund(refundId), `gid://shopify/LineItem/${n}`);
const line = (id: string, over: Partial<{ condition: "unknown" | "resellable" | "damaged"; quantity: number }> = {}) => ({
  id,
  orderLineItemId: "li-1",
  variantId: "v-1",
  quantity: over.quantity ?? 2,
  condition: over.condition ?? ("unknown" as const),
  restockedQty: over.condition === "resellable" ? (over.quantity ?? 2) : 0,
});

describe("line origins and source owners", () => {
  it("deterministic ids tell refund lines (with restock type) from receipt lines; other ids are manual", () => {
    const o = lineOrigins([refund("r1", ["RETURN", "MIXED"])], ["m1"]);
    expect(o.get(refundLine("r1", 1))).toEqual({ kind: "refund", refundId: "r1", restockType: "RETURN" });
    expect(o.get(refundLine("r1", 2))).toEqual({ kind: "refund", refundId: "r1", restockType: "MIXED" });
    const [good, damaged] = receiptLineIds({ movementId: "m1" });
    expect(o.get(good!)).toEqual({ kind: "receipt", movementId: "m1" });
    expect(o.get(damaged!)).toEqual({ kind: "receipt", movementId: "m1" });
    expect(o.get("manual-line")).toBeUndefined();
  });

  it("an owner is the case keyed by the source, else the case holding its lines; a source without a case has no owner", () => {
    const origins = lineOrigins([refund("r1", ["RETURN"]), refund("r2", ["RETURN"]), refund("r3", ["CANCEL"])], ["m1", "m2"]);
    const [m2good] = receiptLineIds({ movementId: "m2" });
    const owners = sourceOwners({
      cases: [
        { id: "A", sourceKey: returnSourceKeys.refund("r1") },
        { id: "B", sourceKey: returnSourceKeys.receipt("m1") },
      ],
      lines: [
        { id: refundLine("r1", 1), returnId: "A" },
        { id: refundLine("r2", 1), returnId: "B" }, // r2 приєднано до випадку надходження
        { id: m2good!, returnId: "A" }, // m2 приєднано до випадку повернення коштів
      ],
      origins,
    });
    expect(Object.fromEntries(owners.refundCase)).toEqual({ r1: "A", r2: "B" });
    expect(Object.fromEntries(owners.receiptCase)).toEqual({ m1: "B", m2: "A" });
    expect(owners.refundCase.has("r3")).toBe(false);
  });
});

describe("case insight: «Awaiting stock receipt» (§6.7) and uncertain units", () => {
  const origins = lineOrigins([refund("ret", ["RETURN"]), refund("mix", ["MIXED"]), refund("nr", ["NO_RESTOCK"]), refund("leg", ["LEGACY_RESTOCK"])], ["m1"]);
  const [good] = receiptLineIds({ movementId: "m1" });
  const open = { kind: "customer_return" as const, status: "open" as const };

  it("a RETURN refund without a stock receipt is awaiting; with the receipt it is not", () => {
    expect(caseInsight(open, [line(refundLine("ret", 1))], origins)).toMatchObject({ awaitingReceipt: true, awaitingReceiptUncertain: false, quantityUncertain: false });
    expect(caseInsight(open, [line(refundLine("leg", 1))], origins).awaitingReceipt).toBe(true);
    expect(caseInsight({ ...open, status: "received" }, [line(refundLine("ret", 1)), line(good!, { condition: "resellable" })], origins).awaitingReceipt).toBe(false);
  });

  it("closed, refund-only, lost and NO_RESTOCK-only cases are not awaiting; manual lines never count as a receipt", () => {
    expect(caseInsight({ ...open, status: "closed" }, [line(refundLine("ret", 1))], origins).awaitingReceipt).toBe(false);
    expect(caseInsight({ ...open, kind: "refund_only" }, [line(refundLine("ret", 1))], origins).awaitingReceipt).toBe(false);
    expect(caseInsight({ ...open, kind: "lost" }, [line(refundLine("ret", 1))], origins).awaitingReceipt).toBe(false);
    expect(caseInsight(open, [line(refundLine("nr", 1))], origins).awaitingReceipt).toBe(false);
    // Позиція, внесена вручну зі станом «придатний», — не надходження на склад.
    expect(caseInsight(open, [line(refundLine("ret", 1)), line("manual", { condition: "resellable" })], origins).awaitingReceipt).toBe(true);
    // Статус «Отримано на склад», виставлений вручну без надходження, — товар на склад не внесено.
    expect(caseInsight({ ...open, status: "received" }, [line(refundLine("ret", 1))], origins).awaitingReceipt).toBe(true);
  });

  it("a MIXED refund line: possibly awaiting, quantity uncertain (not in the exact units)", () => {
    const i = caseInsight(open, [line(refundLine("mix", 1), { quantity: 3 })], origins);
    expect(i).toMatchObject({ awaitingReceipt: true, awaitingReceiptUncertain: true, quantityUncertain: true });
    expect(i.units).toMatchObject({ units: 0, uncertainUnits: 3 });
    const withReturn = caseInsight(open, [line(refundLine("mix", 1), { quantity: 3 }), { ...line(refundLine("ret", 1)), orderLineItemId: "li-2" }], origins);
    expect(withReturn).toMatchObject({ awaitingReceipt: true, awaitingReceiptUncertain: false });
    expect(withReturn.units).toMatchObject({ units: 2, uncertainUnits: 3 });
  });
});

describe("journal entry → case", () => {
  const maps: EntrySourceMaps = {
    saleRefundGid: new Map([
      ["sale-1", "gid://shopify/Refund/1"],
      ["gid://shopify/Sale/1", "gid://shopify/Refund/1"],
      ["sale-2", "gid://shopify/Refund/2"],
      ["sale-order", null],
      ["sale-3", "gid://shopify/Refund/3"],
    ]),
    refundIdByGid: new Map([
      ["gid://shopify/Refund/1", "r1"],
      ["gid://shopify/Refund/2", "r2"],
      ["gid://shopify/Refund/3", "r3"],
    ]),
    valuationMovement: new Map([
      ["val-1", "m1"],
      ["val-x", "m-other"],
      ["val-null", null],
    ]),
    expenseReturn: new Map([
      ["exp-A", "A"],
      ["exp-none", null],
      ["exp-foreign", "Z"],
    ]),
    owners: { refundCase: new Map([["r1", "A"], ["r2", "B"]]), receiptCase: new Map([["m1", "B"]]) },
    caseIds: new Set(["A", "B"]),
  };
  it("sale of a refund → the case holding the refund (by sale id or Shopify sale id); valuation → receipt case; expense → return_id", () => {
    expect(entryCase({ sourceType: "shopify_sale", sourceId: "sale-1" }, maps)).toBe("A");
    expect(entryCase({ sourceType: "shopify_sale", sourceId: "gid://shopify/Sale/1" }, maps)).toBe("A");
    expect(entryCase({ sourceType: "shopify_sale", sourceId: "sale-2" }, maps)).toBe("B");
    expect(entryCase({ sourceType: "valuation", sourceId: "val-1" }, maps)).toBe("B");
    expect(entryCase({ sourceType: "expense", sourceId: "exp-A" }, maps)).toBe("A");
    expect(entryCase({ sourceType: "allocation", sourceId: "exp-A" }, maps)).toBe("A");
  });
  it("anything else stays at order level (null): order sales, refunds without a case, other movements, fees, invoices, demo, foreign cases", () => {
    for (const e of [
      { sourceType: "shopify_sale", sourceId: "sale-order" },
      { sourceType: "shopify_sale", sourceId: "sale-3" },
      { sourceType: "shopify_sale", sourceId: "unknown" },
      { sourceType: "valuation", sourceId: "val-x" },
      { sourceType: "valuation", sourceId: "val-null" },
      { sourceType: "expense", sourceId: "exp-none" },
      { sourceType: "expense", sourceId: "exp-foreign" },
      { sourceType: "shopify_fee", sourceId: "fee-1" },
      { sourceType: "invoice_line", sourceId: "line-1" },
      { sourceType: "demo", sourceId: "x" },
    ])
      expect(entryCase(e, maps), JSON.stringify(e)).toBeNull();
  });
});

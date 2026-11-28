/**
 * Етап 6, WP7: чисті правила партнерської програми — коди (нормалізація, дійсність), атрибуція (§9.2: усі коди знижок,
 * пріоритет код знижки > реферальний, дійсність на дату замовлення, неоднозначність, тестові замовлення), ставка на дату,
 * база й сума (§9.3: G1, G2, G10, G10b, G10c, скасування, валюти з 0 знаками), план подій (§9.4), стани й FIFO виплат
 * (G1, G6, аванс), окупність (G19), розбір форм. Числа — точно (BigInt), відсутнє ≠ 0.
 */
import { describe, expect, it } from "vitest";
import { rateOn, resolveAttribution, type CandidateCode } from "~/modules/partners/attribution";
import { isCodeValidOn, normalizeCode, normalizeOrderCodes, parsePartnerCode, parseValidity } from "~/modules/partners/codes";
import { chargebackNetPart, commissionOf, computeCommission, disputeNetLoss, planCommissionEvents, type CommissionDispute, type CommissionSale } from "~/modules/partners/commission";
import { bpToPercent, parseHoldDays, parsePercentBp } from "~/modules/partners/input";
import { deriveLedger, type LedgerEvent } from "~/modules/partners/ledger";
import { paybackRatio, summarizePerformance } from "~/modules/partners/performance";
import { partnerPeriodOf } from "~/modules/partners/period";

const sale = (lineType: string, total: string, tax = "0.00", agreementKind: CommissionSale["agreementKind"] = "order", currency = "EUR"): CommissionSale => ({
  agreementKind,
  lineType,
  totalAmount: total,
  totalTax: tax,
  currency,
});
const G1_SALES = [sale("PRODUCT", "90.00"), sale("PRODUCT", "27.00"), sale("SHIPPING", "12.00")];
const base = { displayFinancialStatus: "PAID", disputes: [], rateBp: 1000 } as const;

describe("codes", () => {
  it("normalizes (trim, upper case) and validates owner input", () => {
    expect(normalizeCode("  part10 ")).toBe("PART10");
    expect(normalizeOrderCodes(["part10", "PART10", " max15", ""])).toEqual(["PART10", "MAX15"]);
    expect(parsePartnerCode(" Part10 ")).toEqual({ ok: true, code: "Part10", norm: "PART10" });
    expect(parsePartnerCode("")).toEqual({ ok: false, error: "partners.error.codeEmpty" });
    expect(parsePartnerCode("two words")).toEqual({ ok: false, error: "partners.error.codeInvalid" });
    expect(parsePartnerCode("a@b.c")).toEqual({ ok: false, error: "partners.error.codeInvalid" });
    expect(parsePartnerCode("x".repeat(65))).toEqual({ ok: false, error: "partners.error.codeInvalid" });
  });

  it("validity on the order date is inclusive; from > to is refused", () => {
    expect(isCodeValidOn({ validFrom: "2026-10-01", validTo: "2026-10-31" }, "2026-10-01")).toBe(true);
    expect(isCodeValidOn({ validFrom: "2026-10-01", validTo: "2026-10-31" }, "2026-10-31")).toBe(true);
    expect(isCodeValidOn({ validFrom: "2026-10-01", validTo: "2026-10-31" }, "2026-11-01")).toBe(false);
    expect(isCodeValidOn({ validFrom: null, validTo: null }, "2020-01-01")).toBe(true);
    expect(parseValidity("2026-10-02", "2026-10-01")).toEqual({ ok: false });
    expect(parseValidity("", "")).toEqual({ ok: true, validFrom: null, validTo: null });
    expect(parseValidity("bad", null)).toEqual({ ok: false });
  });
});

describe("attribution (§9.2)", () => {
  const A = "aaaaaaaa-0000-4000-8000-000000000001";
  const B = "bbbbbbbb-0000-4000-8000-000000000002";
  const codes: CandidateCode[] = [
    { id: "c1", partnerId: A, source: "discount_code", codeNorm: "PART10", validFrom: null, validTo: null },
    { id: "c2", partnerId: A, source: "discount_code", codeNorm: "PARTVIP", validFrom: null, validTo: null },
    { id: "c3", partnerId: B, source: "discount_code", codeNorm: "MAX15", validFrom: null, validTo: null },
    { id: "c4", partnerId: B, source: "referral", codeNorm: "MAXRIDE", validFrom: null, validTo: null },
    { id: "c5", partnerId: B, source: "discount_code", codeNorm: "SUMMER", validFrom: "2026-06-01", validTo: "2026-08-31" },
  ];
  const input = { referralCode: null, placedOn: "2026-10-05", excludedTest: false, codes };

  it("uses ALL discount codes (not only the first) and is case-insensitive", () => {
    expect(resolveAttribution({ ...input, discountCodes: ["welcome", "part10"] })).toEqual({ status: "attributed", partnerId: A, codeId: "c1", source: "discount_code" });
  });

  it("two codes of the same partner → that partner, the first code in Shopify order", () => {
    expect(resolveAttribution({ ...input, discountCodes: ["PARTVIP", "PART10"] })).toEqual({ status: "attributed", partnerId: A, codeId: "c2", source: "discount_code" });
  });

  it("codes of two different partners → ambiguous (both candidates)", () => {
    expect(resolveAttribution({ ...input, discountCodes: ["PART10", "MAX15"] })).toEqual({
      status: "ambiguous",
      partnerIds: [A, B].sort(),
      codeIds: ["c1", "c3"],
      source: "discount_code",
    });
  });

  it("discount code > referral code; referral used only when given (ready = true)", () => {
    expect(resolveAttribution({ ...input, discountCodes: ["PART10"], referralCode: "maxride" })).toMatchObject({ status: "attributed", partnerId: A });
    expect(resolveAttribution({ ...input, discountCodes: [], referralCode: "maxride" })).toEqual({ status: "attributed", partnerId: B, codeId: "c4", source: "referral" });
    expect(resolveAttribution({ ...input, discountCodes: [], referralCode: null })).toEqual({ status: "none", reason: "no_code" });
  });

  it("only codes valid on the order date; test orders are not attributed", () => {
    expect(resolveAttribution({ ...input, discountCodes: ["SUMMER"] })).toEqual({ status: "none", reason: "no_code" });
    expect(resolveAttribution({ ...input, placedOn: "2026-07-01", discountCodes: ["SUMMER"] })).toMatchObject({ status: "attributed", codeId: "c5" });
    expect(resolveAttribution({ ...input, excludedTest: true, discountCodes: ["PART10"] })).toEqual({ status: "none", reason: "test_order" });
  });

  it("rate on the order date: code rate > partner rate; before the first rate — the initial rate", () => {
    const rates = [
      { codeId: null, rateBp: 1000, effectiveFrom: "2026-09-01" },
      { codeId: null, rateBp: 1200, effectiveFrom: "2026-11-01" },
      { codeId: "c2", rateBp: 1500, effectiveFrom: "2026-10-01" },
    ];
    expect(rateOn(rates, "c1", "2026-10-05")).toBe(1000);
    expect(rateOn(rates, "c1", "2026-11-01")).toBe(1200);
    expect(rateOn(rates, "c2", "2026-10-05")).toBe(1500);
    expect(rateOn(rates, "c2", "2026-09-15")).toBe(1000);
    expect(rateOn(rates, null, "2026-01-01")).toBe(1000);
    expect(rateOn([], null, "2026-01-01")).toBeNull();
  });
});

describe("base and commission (§9.3)", () => {
  it("G1: 10 % of 117,00 = 11,70; after RETURN −45,00 → base 72,00 → 7,20", () => {
    expect(computeCommission({ ...base, sales: G1_SALES })).toMatchObject({ known: true, currency: "EUR", products: "117.00", base: "117.00", commission: "11.70", cancelled: null });
    expect(computeCommission({ ...base, sales: [...G1_SALES, sale("PRODUCT", "-45.00", "0.00", "return")] })).toMatchObject({ base: "72.00", commission: "7.20" });
  });

  it("G2: prices with tax → base 50,00 (without tax and shipping)", () => {
    expect(computeCommission({ ...base, sales: [sale("PRODUCT", "59.50", "9.50"), sale("SHIPPING", "10.00", "1.60")] })).toMatchObject({ base: "50.00", commission: "5.00" });
  });

  it("G10c: refund without items (REFUND ADJUSTMENT −129,00) → max(0, min(117; −12)) = 0 → cancelled", () => {
    const r = computeCommission({ ...base, sales: [...G1_SALES, sale("ADJUSTMENT", "-129.00", "0.00", "refund")] });
    expect(r).toMatchObject({ known: true, base: "0.00", commission: "0.00", noItemRefunds: "-129.00", cancelled: "net_sales_not_positive" });
  });

  it("a partial no-item refund reduces the base; a positive adjustment is not added; UNKNOWN lines of refunds count", () => {
    expect(computeCommission({ ...base, sales: [...G1_SALES, sale("ADJUSTMENT", "-17.00", "0.00", "refund")] })).toMatchObject({ base: "100.00", commission: "10.00", cancelled: null });
    expect(computeCommission({ ...base, sales: [...G1_SALES, sale("ADJUSTMENT", "5.00", "0.00", "refund")] })).toMatchObject({ base: "117.00" });
    expect(computeCommission({ ...base, sales: [...G1_SALES, sale("UNKNOWN", "-7.00", "0.00", "return")] })).toMatchObject({ base: "110.00", commission: "11.00" });
    // ADJUSTMENT у звичайній угоді (не повернення) базу не змінює.
    expect(computeCommission({ ...base, sales: [...G1_SALES, sale("ADJUSTMENT", "-5.00", "0.00", "order")] })).toMatchObject({ base: "117.00" });
  });

  it("tips, duties, fees and gift cards are not in the base; gift cards do not count for the cancellation sum", () => {
    const r = computeCommission({ ...base, sales: [sale("PRODUCT", "50.00"), sale("TIP", "5.00"), sale("DUTY", "3.00"), sale("FEE", "2.00"), sale("GIFT_CARD", "100.00")] });
    expect(r).toMatchObject({ base: "50.00", commission: "5.00" });
    const giftOnly = computeCommission({ ...base, sales: [sale("PRODUCT", "50.00"), sale("PRODUCT", "-50.00", "0.00", "return"), sale("GIFT_CARD", "100.00")] });
    expect(giftOnly).toMatchObject({ cancelled: "net_sales_not_positive", commission: "0.00" });
  });

  it("REFUNDED financial status cancels to 0", () => {
    expect(computeCommission({ ...base, displayFinancialStatus: "REFUNDED", sales: G1_SALES })).toMatchObject({ cancelled: "refunded", base: "0.00", commission: "0.00" });
  });

  it("G10: lost chargeback 129,00 (no tax) → base reduced by min(129; 117) → 0", () => {
    const r = computeCommission({ ...base, sales: G1_SALES, disputes: [{ outcome: "lost", amount: "129.00", recoveredAmount: "0.00", currency: "EUR", fullPartnerCancellation: false }] });
    expect(r).toMatchObject({ base: "0.00", commission: "0.00", chargebackReduction: "117.00", cancelled: null });
  });

  it("G10b: dispute 69,50 recovered 20,00 → loss 49,50 → 41,59 / 7,91 → base 8,41 → 0,84; full cancellation → 0", () => {
    expect(disputeNetLoss({ outcome: "lost", amount: "69.50", recoveredAmount: "20.00" }, "EUR")).toBe(4950n);
    expect(chargebackNetPart(4950n, 5840n, 1110n, "EUR")).toEqual({ net: 4159n, tax: 791n });
    const sales = [sale("PRODUCT", "59.50", "9.50"), sale("SHIPPING", "10.00", "1.60")];
    const d = { outcome: "lost" as const, amount: "69.50", recoveredAmount: "20.00", currency: "EUR", fullPartnerCancellation: false };
    expect(computeCommission({ ...base, sales, disputes: [d] })).toMatchObject({ chargebackReduction: "41.59", base: "8.41", commission: "0.84" });
    expect(computeCommission({ ...base, sales, disputes: [{ ...d, fullPartnerCancellation: true }] })).toMatchObject({ cancelled: "chargeback_full", commission: "0.00" });
  });

  it("won / prevented / open disputes → no loss; accepted counts like lost", () => {
    for (const outcome of ["won", "prevented", null] as const) {
      expect(disputeNetLoss({ outcome, amount: "69.50", recoveredAmount: "0.00" }, "EUR")).toBe(0n);
    }
    expect(disputeNetLoss({ outcome: "accepted", amount: "69.50", recoveredAmount: null }, "EUR")).toBe(6950n);
    // Програно без суми — НЕВІДОМО (null), не 0 (F4); відкритий спір без суми — без втрати.
    expect(disputeNetLoss({ outcome: "lost", amount: null, recoveredAmount: null }, "EUR")).toBeNull();
    expect(disputeNetLoss({ outcome: null, amount: null, recoveredAmount: null }, "EUR")).toBe(0n);
    expect(disputeNetLoss({ outcome: "lost", amount: "10.00", recoveredAmount: "12.00" }, "EUR")).toBe(0n);
  });

  it("review: a lost / accepted dispute without an amount → base unknown (not 0); «cancel fully» → 0 even without an amount (§2.3, §9.3, F4)", () => {
    const sales = [sale("PRODUCT", "117.00"), sale("SHIPPING", "12.00")];
    const dispute = (over: Partial<CommissionDispute>): CommissionDispute => ({ outcome: "lost", amount: null, recoveredAmount: null, currency: "EUR", fullPartnerCancellation: false, ...over });
    for (const outcome of ["lost", "accepted"] as const) {
      expect(computeCommission({ sales, displayFinancialStatus: "PAID", disputes: [dispute({ outcome })], rateBp: 1000 })).toEqual({ known: false, reason: "dispute_amount_unknown" });
    }
    expect(computeCommission({ sales, displayFinancialStatus: "PAID", disputes: [dispute({ fullPartnerCancellation: true })], rateBp: 1000 })).toMatchObject({
      known: true,
      base: "0.00",
      commission: "0.00",
      cancelled: "chargeback_full",
    });
    // «Скасувати повністю» діє й для спору в іншій валюті; невідома сума іншого спору тоді не важлива (0 відомий).
    expect(computeCommission({ sales, displayFinancialStatus: "PAID", disputes: [dispute({ fullPartnerCancellation: true, amount: "10.00", currency: "USD" }), dispute({})], rateBp: 1000 })).toMatchObject({
      known: true,
      commission: "0.00",
      cancelled: "chargeback_full",
    });
    // Відкритий / виграний спір без суми базу не змінює.
    expect(computeCommission({ sales, displayFinancialStatus: "PAID", disputes: [dispute({ outcome: null }), dispute({ outcome: "won" })], rateBp: 1000 })).toMatchObject({ known: true, commission: "11.70" });
    // REFUNDED — 0 відомий навіть із невідомою сумою спору.
    expect(computeCommission({ sales, displayFinancialStatus: "REFUNDED", disputes: [dispute({})], rateBp: 1000 })).toMatchObject({ known: true, commission: "0.00", cancelled: "refunded" });
  });

  it("missing facts never become 0: no sales → known false; mixed currencies, dispute in another currency, unsupported currency", () => {
    expect(computeCommission({ ...base, sales: [] })).toEqual({ known: false, reason: "no_sales" });
    expect(computeCommission({ ...base, sales: [sale("PRODUCT", "10.00"), sale("PRODUCT", "10.00", "0.00", "order", "USD")] })).toEqual({ known: false, reason: "mixed_currency" });
    expect(computeCommission({ ...base, sales: G1_SALES, disputes: [{ outcome: "lost", amount: "10.00", recoveredAmount: null, currency: "USD", fullPartnerCancellation: false }] })).toEqual({
      known: false,
      reason: "dispute_currency",
    });
    expect(computeCommission({ ...base, sales: [sale("PRODUCT", "10.000", "0.000", "order", "KWD")] })).toEqual({ known: false, reason: "unsupported_currency" });
  });

  it("owner-confirmed products amount is the base when there are no agreements", () => {
    expect(computeCommission({ ...base, sales: [], confirmedProducts: { amount: "200.00", currency: "EUR" } })).toMatchObject({ known: true, base: "200.00", commission: "20.00", from: "confirmed" });
  });

  it("commission rounds half away from zero to the currency's minor units (JPY — whole yen); never below 0", () => {
    expect(commissionOf(1005n, 1000, "EUR")).toBe(101n); // 10,05 × 10 % = 1,005 → 1,01
    expect(commissionOf(1004n, 1000, "EUR")).toBe(100n);
    expect(commissionOf(100500n, 1000, "JPY")).toBe(10100n); // 1 005 JPY × 10 % = 100,5 → 101 JPY
    expect(commissionOf(-500n, 1000, "EUR")).toBe(0n);
    expect(commissionOf(11700n, 0, "EUR")).toBe(0n);
    expect(() => commissionOf(100n, 10001, "EUR")).toThrow(RangeError);
    expect(computeCommission({ ...base, sales: [sale("PRODUCT", "1005.00", "0.00", "order", "JPY")] })).toMatchObject({ commission: "101.00" });
    expect(chargebackNetPart(4900n, 5000n, 1000n, "JPY")).toEqual({ net: 4100n, tax: 800n });
  });
});

describe("event plan (§9.4)", () => {
  const P = "pppppppp-0000-4000-8000-000000000001";
  const Q = "qqqqqqqq-0000-4000-8000-000000000002";
  const target = (commission: string, base = "117.00") => ({ partnerId: P, currency: "EUR", commission, base, rateBp: 1000, holdDays: 30 });

  it("first event → accrual dated at recognition, hold until recognition + hold days", () => {
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: target("11.70"), existing: [], changeDate: "2026-11-28", removalDate: "2026-11-28" })).toEqual([
      { partnerId: P, n: 1, kind: "accrual", base: "117.00", rateBp: 1000, amount: "11.70", currency: "EUR", recognizedOn: "2026-10-05", holdUntil: "2026-11-04" },
    ]);
  });

  it("review: reversed (inactive) events are not in «desired − Σ»; new numbers continue after every event (lastN)", () => {
    // Події 1–2 сторновано (замовлення виключали) і не передано в existing: нове нарахування отримує n = 3.
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: target("11.70"), existing: [], lastN: 2, changeDate: "2026-11-28", removalDate: "2026-11-28" })).toEqual([
      { partnerId: P, n: 3, kind: "accrual", base: "117.00", rateBp: 1000, amount: "11.70", currency: "EUR", recognizedOn: "2026-10-05", holdUntil: "2026-11-04" },
    ]);
  });

  it("desired − Σ events → adjustment at the change date (≥ recognition); nothing when equal (I3)", () => {
    const existing = [{ partnerId: P, n: 1, kind: "accrual" as const, amount: "11.70", currency: "EUR", rateBp: 1000, recognizedOn: "2026-10-05" }];
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: target("11.70"), existing, changeDate: "2026-11-04", removalDate: "2026-11-04" })).toEqual([]);
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: target("7.20", "72.00"), existing, changeDate: "2026-11-04", removalDate: "2026-11-04" })).toEqual([
      { partnerId: P, n: 2, kind: "adjustment", base: "72.00", rateBp: 1000, amount: "-4.50", currency: "EUR", recognizedOn: "2026-11-04", holdUntil: null },
    ]);
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: target("0.00", "0.00"), existing, changeDate: "2026-10-01", removalDate: "2026-10-01" })[0]).toMatchObject({
      kind: "cancellation",
      amount: "-11.70",
      recognizedOn: "2026-10-05",
    });
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: target("13.00", "130.00"), existing, changeDate: "2026-11-10", removalDate: "2026-11-10" })[0]).toMatchObject({
      kind: "adjustment",
      amount: "1.30",
      holdUntil: "2026-12-10",
    });
  });

  it("attribution moved P → Q: cancellation for P (removal date), accrual for Q (recognition date); manual events are kept", () => {
    const existing = [
      { partnerId: P, n: 1, kind: "accrual" as const, amount: "11.70", currency: "EUR", rateBp: 1000, recognizedOn: "2026-10-05" },
      { partnerId: P, n: 2, kind: "manual" as const, amount: "1.00", currency: "EUR", rateBp: 1000, recognizedOn: "2026-10-20" },
    ];
    const plan = planCommissionEvents({
      recognizedOn: "2026-10-05",
      target: { partnerId: Q, currency: "EUR", commission: "9.36", base: "117.00", rateBp: 800, holdDays: 14 },
      existing,
      changeDate: "2026-11-20",
      removalDate: "2026-11-21",
    });
    expect(plan).toEqual([
      { partnerId: P, n: 3, kind: "cancellation", base: "0.00", rateBp: 1000, amount: "-11.70", currency: "EUR", recognizedOn: "2026-11-21", holdUntil: null },
      { partnerId: Q, n: 4, kind: "accrual", base: "117.00", rateBp: 800, amount: "9.36", currency: "EUR", recognizedOn: "2026-10-05", holdUntil: "2026-10-19" },
    ]);
    expect(planCommissionEvents({ recognizedOn: "2026-10-05", target: null, existing, changeDate: "2026-11-20", removalDate: "2026-11-21" })).toHaveLength(1);
  });
});

describe("states, FIFO and balance (§9.4, §9.5, I10)", () => {
  const ev = (orderId: string, n: number, kind: LedgerEvent["kind"], amount: string, recognizedOn: string, holdUntil: string | null): LedgerEvent => ({
    orderId,
    n,
    kind,
    amount,
    currency: "EUR",
    base: "0.00",
    rateBp: 1000,
    recognizedOn,
    holdUntil,
  });

  it("G1: accrued (hold) through 04.11, payable 7,20 from 05.11", () => {
    const events = [ev("o1", 1, "accrual", "11.70", "2026-10-05", "2026-11-04"), ev("o1", 2, "adjustment", "-4.50", "2026-11-04", null)];
    expect(deriveLedger(events, [], "2026-11-04")[0]).toMatchObject({ payable: "0.00", inHold: "7.20", balance: "7.20", orders: [{ state: "accrued", net: "7.20" }] });
    expect(deriveLedger(events, [], "2026-11-05")[0]).toMatchObject({ accrued: "11.70", adjustments: "-4.50", net: "7.20", payable: "7.20", orders: [{ state: "payable", outstanding: "7.20" }] });
  });

  it("G6: payout 11,70, full refund −11,70 → balance −11,70; next order +8,00 → −3,70, payable 0", () => {
    const payouts = [{ id: "p1", coversAmount: "11.70", coversCurrency: "EUR", status: "active" as const }];
    const one = [ev("o1", 1, "accrual", "11.70", "2026-10-05", "2026-11-04")];
    expect(deriveLedger(one, payouts, "2026-11-10")[0]).toMatchObject({ balance: "0.00", payable: "0.00", orders: [{ state: "paid" }] });
    const refunded = [...one, ev("o1", 2, "cancellation", "-11.70", "2026-11-15", null)];
    expect(deriveLedger(refunded, payouts, "2026-11-16")[0]).toMatchObject({ balance: "-11.70", owes: "11.70", payable: "0.00", orders: [{ state: "cancelled" }] });
    const next = [...refunded, ev("o2", 1, "accrual", "8.00", "2026-11-20", "2026-12-20")];
    expect(deriveLedger(next, payouts, "2026-11-21")[0]).toMatchObject({ balance: "-3.70", owes: "3.70", payable: "0.00" });
    expect(deriveLedger(next, payouts, "2026-12-21")[0]).toMatchObject({ balance: "-3.70", payable: "0.00" });
    // Анульована виплата не покриває.
    expect(deriveLedger(next, [{ ...payouts[0]!, status: "voided" }], "2026-12-21")[0]).toMatchObject({ balance: "8.00", payable: "8.00", paid: "0.00" });
  });

  it("review: hold is per positive event — a later positive adjustment does not put the matured part back on hold", () => {
    const events = [ev("o1", 1, "accrual", "10.00", "2026-10-05", "2026-11-04"), ev("o1", 2, "adjustment", "1.00", "2026-11-20", "2026-12-20")];
    const l = deriveLedger(events, [], "2026-11-21")[0]!;
    expect(l).toMatchObject({ net: "11.00", payable: "10.00", inHold: "1.00" });
    expect(l.orders[0]).toMatchObject({ state: "payable", payable: "10.00", inHold: "1.00", holdUntil: "2026-12-20", outstanding: "11.00" });
    // Після утримання коригування — уся сума до виплати.
    expect(deriveLedger(events, [], "2026-12-21")[0]).toMatchObject({ payable: "11.00", inHold: "0.00" });
    // Виплата спершу закриває дозрілу частину: 10,00 виплачено → лишається 1,00 в утриманні, «До виплати» 0.
    const paid = deriveLedger(events, [{ id: "p", coversAmount: "10.00", coversCurrency: "EUR", status: "active" }], "2026-11-21")[0]!;
    expect(paid).toMatchObject({ payable: "0.00", inHold: "1.00", balance: "1.00" });
    expect(paid.orders[0]).toMatchObject({ state: "accrued", payable: "0.00", inHold: "1.00", paid: "10.00" });
    // Від'ємне коригування зменшує спершу частину в утриманні? Ні — утримання не більше чистої суми: 10 (утримання) − 4,5.
    const neg = deriveLedger([ev("o2", 1, "accrual", "10.00", "2026-10-05", "2026-11-04"), ev("o2", 2, "adjustment", "-4.50", "2026-10-20", null)], [], "2026-10-21")[0]!;
    expect(neg).toMatchObject({ net: "5.50", payable: "0.00", inHold: "5.50" });
  });

  it("review: events whose journal entry is reversed (order excluded, F2) are not in the ledger", () => {
    const events = [{ ...ev("o1", 1, "accrual", "10.00", "2026-10-05", "2026-11-04"), active: false }, ev("o2", 1, "accrual", "3.00", "2026-10-05", "2026-11-04")];
    expect(deriveLedger(events, [], "2026-11-21")[0]).toMatchObject({ net: "3.00", payable: "3.00", orders: [{ orderId: "o2" }] });
    expect(deriveLedger([events[0]!], [], "2026-11-21")).toEqual([]);
  });

  it("payouts cover FIFO by hold date: the earliest-maturing commission is paid first", () => {
    const events = [ev("late", 1, "accrual", "5.00", "2026-11-01", "2026-12-01"), ev("early", 1, "accrual", "3.00", "2026-10-01", "2026-10-31")];
    const l = deriveLedger(events, [{ id: "p", coversAmount: "4.00", coversCurrency: "EUR", status: "active" }], "2026-11-10")[0]!;
    const byId = Object.fromEntries(l.orders.map((o) => [o.orderId, o]));
    expect(byId.early).toMatchObject({ state: "paid", paid: "3.00" });
    expect(byId.late).toMatchObject({ state: "accrued", paid: "1.00", outstanding: "4.00" });
    expect(l).toMatchObject({ balance: "4.00", payable: "0.00", inHold: "4.00" });
  });

  it("I10 on seeded random journals: balance = Σ events − Σ payouts; payable ≤ max(0, balance)", () => {
    let seed = 20261128;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const events: LedgerEvent[] = [];
      let sum = 0;
      for (let o = 0; o < 1 + rnd(5); o++) {
        const acc = 1 + rnd(5000);
        events.push(ev(`o${o}`, 1, "accrual", (acc / 100).toFixed(2), "2026-10-01", `2026-10-${String(1 + rnd(28)).padStart(2, "0")}`));
        sum += acc;
        if (rnd(2)) {
          const adj = -rnd(acc + 1);
          if (adj !== 0) {
            events.push(ev(`o${o}`, 2, adj === -acc ? "cancellation" : "adjustment", (adj / 100).toFixed(2), "2026-10-15", null));
            sum += adj;
          }
        }
      }
      let paid = 0;
      const payouts = Array.from({ length: rnd(3) }, (_, i) => {
        const a = 1 + rnd(6000);
        paid += a;
        return { id: `p${i}`, coversAmount: (a / 100).toFixed(2), coversCurrency: "EUR", status: "active" as const };
      });
      const l = deriveLedger(events, payouts, "2026-10-20")[0]!;
      expect(Math.round(Number(l.balance) * 100)).toBe(sum - paid);
      expect(Math.round(Number(l.net) * 100)).toBe(sum);
      expect(Number(l.payable)).toBeLessThanOrEqual(Math.max(0, Number(l.balance)) + 1e-9);
      expect(Math.round(Number(l.owes) * 100)).toBe(Math.max(0, paid - sum));
    }
  });

  it("I10: commission = round(base × rate / 10000) on seeded random bases and rates (independent formula)", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 48271) % 2147483647;
      return seed % n;
    };
    for (let i = 0; i < 2000; i++) {
      const cents = BigInt(rnd(10_000_000));
      const bp = rnd(10_001);
      const expected = (cents * BigInt(bp) * 2n + 10_000n) / 20_000n; // половина від нуля для невід'ємних
      expect(commissionOf(cents, bp, "EUR")).toBe(expected);
    }
  });
});

describe("payback (§9.6, G19)", () => {
  it("(4 200 − 800) / (800 + 200) = 3,40; denominator 0 → null", () => {
    expect(paybackRatio(340000n, 80000n, 20000n)).toBe("3.40");
    expect(paybackRatio(-50000n, 80000n, 20000n)).toBe("-0.50");
    expect(paybackRatio(100n, 0n, 0n)).toBeNull();
  });

  it("G19 summary: only final orders in the fact; preliminary in the forecast; incomplete in neither; coverage", () => {
    const s = summarizePerformance(
      [
        { orderId: "f", month: "2026-10-01", profitState: "final", unconverted: false, forecastTotal: 0n, forecastPartner: 0n, byCategory: { sales_product: 600000n, cogs: -100000n, shipping_cost: -80000n, partner_commission: -80000n } },
        { orderId: "p", month: "2026-10-01", profitState: "preliminary", unconverted: false, forecastTotal: -5000n, forecastPartner: 0n, byCategory: { sales_product: 10000n, partner_commission: -1000n } },
        { orderId: "i", month: "2026-11-01", profitState: "incomplete", unconverted: false, forecastTotal: 0n, forecastPartner: 0n, byCategory: { sales_product: 20000n, refund_product: -5000n } },
      ],
      20000n,
    );
    expect(s.fact).toEqual({ profitBefore: "4200.00", profitAfter: "3400.00", commission: "800.00", payback: "3.40" });
    expect(s.forecast).toEqual({ profitBefore: "4250.00", profitAfter: "3440.00", commission: "810.00", payback: "3.41" });
    expect(s).toMatchObject({ orders: 3, final: 1, preliminary: 1, incomplete: 1, withRevenue: 3, netProducts: "6250.00", turnover: "6300.00", returnOrders: 1, returnShare: "33.3", fixedFees: "200.00", commission: "810.00" });
    expect(s.months).toEqual([
      { month: "2026-10-01", orders: 2, netProducts: "6100.00", commission: "810.00", profit: "3400.00", finalOrders: 1 },
      { month: "2026-11-01", orders: 1, netProducts: "150.00", commission: "0.00", profit: null, finalOrders: 0 },
    ]);
  });

  it("no final orders → fact profit and payback are «—» (null), never 0", () => {
    const s = summarizePerformance([{ orderId: "p", month: "2026-10-01", profitState: "incomplete", unconverted: false, forecastTotal: 0n, forecastPartner: 0n, byCategory: { sales_product: 100n } }], 0n);
    expect(s.fact).toEqual({ profitBefore: null, profitAfter: null, commission: "0.00", payback: null });
    expect(s.forecast.profitAfter).toBeNull();
    expect(summarizePerformance([], 0n)).toMatchObject({ orders: 0, averageCheck: null, returnShare: null });
  });

  it("an order with unconverted entries is not in the profit", () => {
    const s = summarizePerformance([{ orderId: "f", month: "2026-10-01", profitState: "final", unconverted: true, forecastTotal: 0n, forecastPartner: 0n, byCategory: { sales_product: 100n } }], 0n);
    expect(s).toMatchObject({ final: 0, incomplete: 1 });
    expect(s.fact.profitAfter).toBeNull();
  });
});

describe("form input", () => {
  it("percent → basis points without float; hold days 0…365", () => {
    expect(parsePercentBp("10")).toBe(1000);
    expect(parsePercentBp("10,5")).toBe(1050);
    expect(parsePercentBp(" 8.25 % ")).toBe(825);
    expect(parsePercentBp("100")).toBe(10000);
    expect(parsePercentBp("100.01")).toBeNull();
    expect(parsePercentBp("1.234")).toBeNull();
    expect(parsePercentBp("-1")).toBeNull();
    expect(parsePercentBp("")).toBeNull();
    expect(bpToPercent(1000)).toBe("10");
    expect(bpToPercent(1050)).toBe("10.5");
    expect(bpToPercent(825)).toBe("8.25");
    expect(parseHoldDays("30")).toBe(30);
    expect(parseHoldDays("366")).toBeNull();
    expect(parseHoldDays("3.5")).toBeNull();
  });

  it("period from the query: presets, a valid custom range, fallback", () => {
    expect(partnerPeriodOf(new URLSearchParams(""), "2026-11-28")).toEqual({ preset: "thisYear", range: { from: "2026-01-01", to: "2026-11-28" } });
    expect(partnerPeriodOf(new URLSearchParams("period=lastMonth"), "2026-11-28")).toEqual({ preset: "lastMonth", range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(partnerPeriodOf(new URLSearchParams("period=custom&from=2026-10-05&to=2026-11-04"), "2026-11-28")).toEqual({ preset: "custom", range: { from: "2026-10-05", to: "2026-11-04" } });
    expect(partnerPeriodOf(new URLSearchParams("period=custom&from=2026-12-05&to=2026-11-04"), "2026-11-28").preset).toBe("thisYear");
  });
});

/**
 * Етап 6 (WP3): строгий розбір грошей і відповідей Shopify (docs/stage6-design.md §14.3 п. 5, §16.3, F4): пошкоджене →
 * null з кодом, НІКОЛИ "0.00"; продажі — «усе або нічого»; обрізання транзакцій — лише за transactionsCount > 20.
 */
import { describe, expect, it } from "vitest";
import { parseShopifyAmount, parseShopifyMoney, parseShopifyRate, shopifyMoneyOrNull } from "~/modules/finance-sync/money";
import { FINANCE_TOTAL_KEYS, parseAgreements, parseOrderFinance, parseRefunds, signOf } from "~/modules/finance-sync/parse";
import { normalizeAmount } from "~/modules/shopify-sync/mappers";
import { agreement as rawAgreement, agreementNode, bag, fee, financeNode, mv2, refund, refundLine, sale, transaction } from "../fixtures/shopify-finance";

const agreement = (...args: Parameters<typeof rawAgreement>) => agreementNode(rawAgreement(...args));

const GID = "gid://shopify/Order/9100";

describe("parseShopifyMoney (strict)", () => {
  it("accepts Shopify Decimal strings and normalises to 2 decimals", () => {
    expect(parseShopifyMoney(mv2("59.5"))).toEqual({ ok: true, value: { amount: "59.50", currency: "EUR" } });
    expect(parseShopifyMoney(mv2("10"))).toEqual({ ok: true, value: { amount: "10.00", currency: "EUR" } });
    expect(parseShopifyMoney(mv2("-45.0"))).toEqual({ ok: true, value: { amount: "-45.00", currency: "EUR" } });
    expect(parseShopifyMoney(mv2("59.500000"))).toEqual({ ok: true, value: { amount: "59.50", currency: "EUR" } });
    expect(parseShopifyMoney(mv2("-0.00"))).toEqual({ ok: true, value: { amount: "0.00", currency: "EUR" } });
    expect(parseShopifyMoney(mv2("007.10"))).toEqual({ ok: true, value: { amount: "7.10", currency: "EUR" } });
    expect(parseShopifyMoney(mv2("1500.0", "JPY"))).toEqual({ ok: true, value: { amount: "1500.00", currency: "JPY" } });
    expect(parseShopifyMoney(mv2("999999999999.99"))).toMatchObject({ ok: true });
  });

  it("damaged values give a code and null — never 0.00 (unlike stage-2 normalizeAmount)", () => {
    const bad: Array<[unknown, string]> = [
      [mv2("abc"), "invalid_amount"],
      [mv2(""), "invalid_amount"],
      [mv2("1e3"), "invalid_amount"],
      [mv2(" 5.00"), "invalid_amount"],
      [mv2("5,00"), "invalid_amount"],
      [mv2("+5.00"), "invalid_amount"],
      [{ amount: 5, currencyCode: "EUR" }, "invalid_amount"],
      [{ amount: null, currencyCode: "EUR" }, "invalid_amount"],
      [mv2("1.005"), "amount_precision"],
      [mv2("12.5", "JPY"), "amount_precision"],
      [mv2("1000000000000.00"), "amount_range"],
      [mv2("5.00", "eur"), "invalid_currency"],
      [mv2("5.00", "EURO"), "invalid_currency"],
      [mv2("5.000", "KWD"), "unsupported_currency"],
      [null, "invalid_amount"],
    ];
    for (const [value, code] of bad) {
      expect(parseShopifyMoney(value), JSON.stringify(value)).toEqual({ ok: false, code });
      expect(shopifyMoneyOrNull(value)).toBeNull();
    }
    // Контроль: хелпер етапу 2 перетворює пошкоджене на нуль — саме тому він у фінансах заборонений.
    expect(normalizeAmount("abc")).toBe("0.00");
  });

  it("amount without currency and rates", () => {
    expect(parseShopifyAmount("12.34")).toEqual({ ok: true, amount: "12.34" });
    expect(parseShopifyAmount("12.34", 0)).toEqual({ ok: false, code: "amount_precision" });
    expect(parseShopifyRate("1.0994")).toBe("1.0994");
    expect(parseShopifyRate("0.86400000000")).toBe("0.8640000000");
    expect(parseShopifyRate("1.12345678901")).toBeNull();
    expect(parseShopifyRate("0")).toBeNull();
    expect(parseShopifyRate("-1")).toBeNull();
    expect(parseShopifyRate(1.2)).toBeNull();
    expect(signOf("-45.00")).toBe(-1);
    expect(signOf("0.00")).toBe(0);
    expect(signOf("-0.00")).toBe(0);
    expect(signOf("1.00")).toBe(1);
  });
});

describe("parseOrderFinance", () => {
  it("parses totals, transactions with fees, journey, disputes, tracking numbers", () => {
    const p = parseOrderFinance(
      financeNode(GID, {
        presentment: "GBP",
        totals: { currentTotalPriceSet: bag("69.50", "EUR", "60.05", "GBP"), netPaymentSet: bag("69.50", "EUR", "60.05", "GBP") },
        transactions: [{ ...transaction({ amount: "69.50", fees: [fee("2.32", { taxAmount: mv2("0.40") })] }), amountSet: bag("69.50", "EUR", "60.05", "GBP") }],
        customerJourneySummary: { ready: true, lastVisit: { referralCode: " BLOG10 " } },
        disputes: [{ id: "gid://shopify/ShopifyPaymentsDispute/1", initiatedAs: "CHARGEBACK", status: "NEEDS_RESPONSE" }],
        fulfillments: [{ trackingInfo: [{ number: "20450000000011", company: "Nova Poshta" }, { number: null, company: null }] }, { trackingInfo: [{ number: "20450000000011", company: "x" }] }],
        discountCodes: ["PART10", "PART10", " ", "SUMMER"],
      }),
    );
    expect(p.errors).toEqual([]);
    expect(p.totals.currentTotalPrice).toEqual({ shop: { amount: "69.50", currency: "EUR" }, presentment: { amount: "60.05", currency: "GBP" } });
    expect(p.totals.currentTotalDuties).toBeNull();
    expect(Object.keys(p.totals).sort()).toEqual([...FINANCE_TOTAL_KEYS].sort());
    expect(p.transactions[0]).toMatchObject({ kind: "SALE", status: "SUCCESS", amount: { shop: { amount: "69.50" } } });
    expect(p.transactions[0]!.fees[0]).toMatchObject({ amount: { amount: "2.32", currency: "EUR" }, taxAmount: { amount: "0.40" }, rate: "0.029" });
    expect(p.transactionsStatus).toBe("complete");
    expect(p.journey).toEqual({ ready: true, referralCode: "BLOG10" });
    expect(p.disputes).toEqual([{ gid: "gid://shopify/ShopifyPaymentsDispute/1", initiatedAs: "CHARGEBACK", status: "NEEDS_RESPONSE" }]);
    expect(p.trackingNumbers).toEqual(["20450000000011"]);
    expect(p.discountCodes).toEqual(["PART10", "SUMMER"]);
  });

  it("referral code only when ready = true (§9.2)", () => {
    const notReady = parseOrderFinance(financeNode(GID, { customerJourneySummary: { ready: false, lastVisit: { referralCode: "BLOG10" } } }));
    expect(notReady.journey).toEqual({ ready: false, referralCode: null });
    expect(parseOrderFinance(financeNode(GID, { customerJourneySummary: null })).journey).toEqual({ ready: null, referralCode: null });
  });

  it("transactions_truncated only when transactionsCount > 20 (exactly 20 is complete)", () => {
    const txs = Array.from({ length: 20 }, () => transaction({ amount: "1.00" }));
    expect(parseOrderFinance(financeNode(GID, { transactions: txs, transactionsCount: { count: 20 } })).transactionsStatus).toBe("complete");
    expect(parseOrderFinance(financeNode(GID, { transactions: txs, transactionsCount: { count: 21 } })).transactionsStatus).toBe("truncated");
    // Без лічильника — за довжиною списку (консервативно).
    expect(parseOrderFinance(financeNode(GID, { transactions: txs, transactionsCount: null })).transactionsStatus).toBe("truncated");
  });

  it("a damaged amount skips only that element and is reported with its path", () => {
    const p = parseOrderFinance(
      financeNode(GID, {
        totals: { netPaymentSet: bag("abc") },
        transactions: [transaction({ amount: "1,00" }), transaction({ amount: "5.00", fees: [fee("x")] })],
      }),
    );
    expect(p.totals.netPayment).toBeNull();
    expect(p.transactions).toHaveLength(1);
    expect(p.transactions[0]!.fees).toEqual([]);
    expect(p.transactionsStatus).toBe("damaged");
    expect(p.errors).toEqual(
      expect.arrayContaining([
        { area: "totals", path: "netPaymentSet.shopMoney", code: "invalid_amount" },
        { area: "transactions", path: "transactions[0].amountSet.shopMoney", code: "invalid_amount" },
        { area: "fees", path: "transactions[1].fees[0].amount", code: "invalid_amount" },
      ]),
    );
  });

  it("F4/§8.1: a damaged fee is never hidden — the fee set is «damaged», not a complete smaller set", () => {
    // Дві комісії, одна пошкоджена (кома замість крапки): транзакція ціла, але комісії — НЕ повний набір.
    const one = parseOrderFinance(financeNode(GID, { transactions: [transaction({ amount: "69.50", fees: [fee("2.32"), fee("2,10")] })] }));
    expect(one.transactions[0]!.fees.map((f) => f.amount.amount)).toEqual(["2.32"]);
    expect(one.transactions[0]!.feesComplete).toBe(false);
    expect(one.transactionsStatus).toBe("complete"); // суми транзакцій (RC2/RC3) — цілі
    expect(one.feesStatus).toBe("damaged");
    expect(one.errors).toEqual([{ area: "fees", path: "transactions[0].fees[1].amount", code: "invalid_amount" }]);
    // Пошкоджені фіксована частина, податок чи ставка — комісія відкидається цілком (рядок незмінний; без часткових значень).
    for (const over of [{ flatFee: mv2("0,30") }, { taxAmount: mv2("abc") }, { rate: "2.9%" }]) {
      const p = parseOrderFinance(financeNode(GID, { transactions: [transaction({ amount: "10.00", fees: [fee("0.59", over)] })] }));
      expect(p.transactions[0]!.fees, JSON.stringify(over)).toEqual([]);
      expect(p.feesStatus).toBe("damaged");
    }
    // Пошкоджена форма комісії — так само.
    const shape = parseOrderFinance(financeNode(GID, { transactions: [transaction({ amount: "10.00", fees: [{ id: "x" } as never] })] }));
    expect(shape.feesStatus).toBe("damaged");
    // Пошкоджена транзакція — її комісії невідомі.
    expect(parseOrderFinance(financeNode(GID, { transactions: [transaction({ amount: "1,00", fees: [fee("0.10")] })] })).feesStatus).toBe("damaged");
    // Комісії не-SUCCESS транзакцій не проводяться — їх пошкодження не робить набір неповним.
    expect(parseOrderFinance(financeNode(GID, { transactions: [transaction({ amount: "5.00", status: "PENDING", fees: [fee("x")] })] })).feesStatus).toBe("complete");
    // Обрізаний список транзакцій — комісії теж неповні; ціле — complete.
    const txs = Array.from({ length: 20 }, () => transaction({ amount: "1.00" }));
    expect(parseOrderFinance(financeNode(GID, { transactions: txs, transactionsCount: { count: 21 } })).feesStatus).toBe("truncated");
    expect(parseOrderFinance(financeNode(GID, { transactions: [transaction({ amount: "69.50", fees: [fee("2.32")] })] })).feesStatus).toBe("complete");
  });

  it("shop money in another currency is a mismatch, not a value", () => {
    const p = parseOrderFinance(financeNode(GID, { totals: { currentTotalPriceSet: bag("10.00", "USD") } }));
    expect(p.totals.currentTotalPrice).toBeNull();
    expect(p.errors).toContainEqual({ area: "totals", path: "currentTotalPriceSet.shopMoney", code: "currency_mismatch" });
  });

  it("unsupported shop currency (3 decimals) stores no money", () => {
    const p = parseOrderFinance(financeNode(GID, { currency: "KWD", totals: { currentTotalPriceSet: bag("1.234", "KWD") }, transactions: [transaction({ amount: "1.234", currency: "KWD" })] }));
    expect(p.currencyStatus).toBe("unsupported");
    expect(p.shopCurrency).toBeNull();
    expect(p.transactions).toEqual([]);
    expect(p.transactionsStatus).toBe("damaged");
    expect(Object.values(p.totals).every((v) => v === null)).toBe(true);
  });

  it("a response without id/updatedAt is a non-retryable error (nothing is stored)", () => {
    expect(() => parseOrderFinance({ id: GID } as never)).toThrow(/invalid finance order/);
  });
});

describe("parseAgreements / parseRefunds", () => {
  const cur = { shopCurrency: "EUR", presentmentCurrency: "EUR", currencyStatus: "ok" as const };

  it("maps typename to agreement kind, normalises unknown line types, collects refund ids", () => {
    const r = parseAgreements(
      [
        agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "90.00" }), sale({ lineType: "SERVICE_FEE", total: "1.00" })]),
        agreement("RefundAgreement", "2026-11-04T10:00:00Z", [sale({ total: "-45.00", quantity: -1, actionType: "RETURN" })]),
        agreement("SomethingNewAgreement", "2026-11-05T10:00:00Z", []),
      ],
      cur,
    );
    expect(r.status).toBe("complete");
    expect(r.agreements.map((a) => a.kind)).toEqual(["order", "refund", "unknown"]);
    expect(r.agreements[0]!.sales.map((s) => s.lineType)).toEqual(["PRODUCT", "UNKNOWN"]);
    expect(r.refundGids).toHaveLength(1);
    expect(r.agreements[1]!.sales[0]).toMatchObject({ quantity: -1, total: { shop: { amount: "-45.00" } }, actionType: "RETURN" });
  });

  it("ANY damaged sale marks the whole read damaged (all-or-nothing)", () => {
    const r = parseAgreements([agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "90.00" }), sale({ total: "9O.00" })])], cur);
    expect(r.status).toBe("damaged");
    expect(r.errors).toContainEqual({ area: "sales", path: "agreements[0].sales[1].totalAmount.shopMoney", code: "invalid_amount" });
    const pres = parseAgreements([agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "90.00", pTotal: "1.234", pCurrency: "KWD" })])], {
      ...cur,
      presentmentCurrency: null,
    });
    expect(pres.status).toBe("unsupported_currency");
    const badDate = parseAgreements([agreement("OrderAgreement", "not a date", [])], cur);
    expect(badDate.status).toBe("damaged");
  });

  it("refunds: complete below the page size, incomplete at 10 refunds or more lines", () => {
    const lines = [refundLine("gid://shopify/LineItem/1", 1, "RETURN", true, "45.00")];
    const ok = parseRefunds({ totalRefundedSet: bag("45.00"), refunds: [refund({ amount: "45.00", lines })].map(asGql) }, cur);
    expect(ok.status).toBe("complete");
    expect(ok.refunds[0]!.lines[0]).toMatchObject({ lineItemGid: "gid://shopify/LineItem/1", quantity: 1, restockType: "RETURN", restocked: true });
    const ten = parseRefunds({ totalRefundedSet: bag("10.00"), refunds: Array.from({ length: 10 }, () => asGql(refund({ amount: "1.00" }))) }, cur);
    expect(ten.status).toBe("incomplete");
    const many = asGql(refund({ amount: "1.00", lines: Array.from({ length: 11 }, (_, i) => refundLine(`gid://shopify/LineItem/${i}`, 1, "NO_RESTOCK", false)) }));
    expect(parseRefunds({ totalRefundedSet: bag("1.00"), refunds: [many] }, cur).status).toBe("incomplete");
    const damaged = parseRefunds({ totalRefundedSet: bag("1.00"), refunds: [asGql(refund({ amount: "x" }))] }, cur);
    expect(damaged.status).toBe("damaged");
  });
});

/** FixtureRefund → форма відповіді (як віддає імітація). */
function asGql(r: ReturnType<typeof refund>) {
  return {
    id: r.id,
    createdAt: r.createdAt,
    processedAt: r.processedAt,
    totalRefundedSet: r.totalRefundedSet,
    refundLineItems: { pageInfo: { hasNextPage: r.lines.length > 10 }, nodes: r.lines.slice(0, 10) },
  };
}

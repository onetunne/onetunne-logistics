/**
 * Етап 6 (WP3): finance.sync_order на базі (PGlite; PostgreSQL — TEST_DATABASE_URL) з імітацією Admin API
 * (docs/stage6-design.md §16.3–§16.5, §8, §9.2, F2, F4, F8, I3, I19). Вигадані дані.
 */
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Tx } from "~/db/client.server";
import { issues, jobs, orderDisputes, orderExternalWaybills, orderRefundLines, orderRefunds, orderSales, orderShopifyFinance, orderTransactionFees, orderTransactions, orders, stores } from "~/db/schema";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import { resolveDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { loadReconciliationState } from "~/modules/finance-sync/facts-view.server";
import { FINANCE_JOB_TIMING } from "~/modules/finance/jobs";
import { parseSnapshot } from "~/modules/finance-sync/snapshot";
import { agreement, bag, fee, financeNode, g2Fixture, refund, refundLine, sale, transaction, type FinanceOrderFixture } from "../fixtures/shopify-finance";
import { discrepanciesOf, factCounts, lineIdOf, openFinanceSyncEnv, osfOf, type FinanceSyncEnv } from "./helpers";

const rec = vi.hoisted(() => ({ calls: [] as Array<{ orderId: string; actorId: string; salesInTx: number }> }));
vi.mock("~/modules/order-finance/sync.server", async () => {
  const { count: c, eq: e } = await import("drizzle-orm");
  const { orderSales: s } = await import("~/db/schema");
  return {
    // Записує виклик і кількість продажів, видиму В ТІЙ САМІЙ транзакції (факти вже записано до виклику).
    syncOrderFinance: async (tx: Tx, actor: { id: string }, orderId: string) => {
      const [row] = await tx.select({ n: c() }).from(s).where(e(s.orderId, orderId));
      rec.calls.push({ orderId, actorId: actor.id, salesInTx: Number(row?.n ?? 0) });
    },
  };
});

let env: FinanceSyncEnv;
beforeAll(async () => {
  env = await openFinanceSyncEnv();
});
afterAll(async () => {
  await env.close();
});

const gid = (n: number) => `gid://shopify/Order/${n}`;
const callsFor = (orderId: string) => rec.calls.filter((c) => c.orderId === orderId);
const bump = (fx: FinanceOrderFixture, iso: string) => {
  fx.finance.updatedAt = iso;
};

describe("golden G2 order: facts, reconciliation, one transaction with syncOrderFinance", () => {
  let orderId: string;
  let fx: FinanceOrderFixture;
  beforeAll(async () => {
    orderId = await env.createOrder(9201);
    fx = g2Fixture(gid(9201));
    env.store.set(gid(9201), fx);
  });

  it("stores sales (net/tax per line), transactions with fees and the snapshot; RC1–RC5 without a discrepancy (RC4 = G2)", async () => {
    rec.calls.length = 0;
    env.fake.calls.length = 0;
    const r = await env.sync(gid(9201));
    expect(r).toMatchObject({ status: "synced", agreementsRead: true, refundsRead: false, mismatches: [], flags: [] });
    expect(env.fake.ops()).toEqual(["OtOrderFinance", "OtOrderAgreements"]);
    expect(env.fake.calls.every((c) => c.cost <= 950)).toBe(true);

    const sales = await env.db.select().from(orderSales).where(eq(orderSales.orderId, orderId)).orderBy(orderSales.lineType);
    expect(sales.map((s) => [s.lineType, s.agreementKind, s.totalAmount, s.totalTax, s.currency, s.source])).toEqual([
      ["PRODUCT", "order", "59.50", "9.50", "EUR", "shopify"],
      ["SHIPPING", "order", "10.00", "1.60", "EUR", "shopify"],
    ]);
    expect(sales[0]!.orderLineItemId).toBe(await lineIdOf(env.db, orderId, "gid://shopify/LineItem/92011"));
    const [tx] = await env.db.select().from(orderTransactions).where(eq(orderTransactions.orderId, orderId));
    expect(tx).toMatchObject({ kind: "SALE", status: "SUCCESS", amount: "69.50", currency: "EUR", gateway: "shopify_payments" });
    const fees = await env.db.select().from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId));
    expect(fees.map((f) => [f.amount, f.currency, f.flatFee, f.rate, f.transactionId])).toEqual([["2.32", "EUR", "0.30", "0.029", tx!.id]]);

    const osf = (await osfOf(env.db, orderId))!;
    expect(osf).toMatchObject({ shopCurrency: "EUR", taxesIncluded: true, journeyReady: true, journeyChecks: 0, transactionsCount: 1, flags: [] });
    const snap = parseSnapshot(osf.snapshot);
    expect(snap.status).toEqual({ sales: "complete", transactions: "complete", fees: "complete", refunds: "none" });
    expect(snap.totals.currentTotalTax).toMatchObject({ amount: "9.50", currency: "EUR" });
    const rcStatus = Object.fromEntries(Object.entries((osf.reconciliation as { checks: Record<string, { status: string }> }).checks).map(([k, v]) => [k, v.status]));
    expect(rcStatus).toEqual({ RC1: "ok", RC2: "ok", RC3: "ok", RC4: "ok", RC5: "not_applicable" });
    expect(await discrepanciesOf(env.db, orderId)).toEqual([]);

    // syncOrderFinance — один раз, у тій самій транзакції ПІСЛЯ запису фактів, від SYSTEM_ACTOR.
    expect(callsFor(orderId)).toEqual([{ orderId, actorId: "system", salesInTx: 2 }]);
    // §15: shop_domain і валюта магазину — з першої фінансової синхронізації.
    const [store] = await env.db.select().from(stores).where(eq(stores.id, "default"));
    expect(store).toMatchObject({ shopDomain: "ot-finance.myshopify.com", shopCurrency: "EUR" });
  });

  it("I3/F2: a repeat (webhook redelivery, job retry, forced re-read) adds no rows", async () => {
    const before = await factCounts(env.db, orderId);
    env.fake.calls.length = 0;
    await env.sync(gid(9201));
    expect(env.fake.ops()).toEqual(["OtOrderFinance"]); // updatedAt не змінився — угоди не перечитуються
    await env.sync(gid(9201), { force: true });
    expect(env.fake.ops()).toEqual(["OtOrderFinance", "OtOrderFinance", "OtOrderAgreements"]);
    expect(await factCounts(env.db, orderId)).toEqual(before);
  });

  it("the same Sale.id with other values → reconciliation_mismatch, the stored row is NOT changed; back to equal → closed by the system", async () => {
    const product = fx.agreements[0]!.sales[0]!;
    product.totalAmount = bag("59.00");
    bump(fx, "2026-10-06T10:00:00Z");
    const r = await env.sync(gid(9201));
    expect(r).toMatchObject({ status: "synced", sales: { changed: 1, inserted: 0 } });
    const [stored] = await env.db.select().from(orderSales).where(and(eq(orderSales.orderId, orderId), eq(orderSales.lineType, "PRODUCT")));
    expect(stored!.totalAmount).toBe("59.50");
    const [d] = await discrepanciesOf(env.db, orderId);
    expect(d).toMatchObject({ type: "reconciliation_mismatch", status: "open", severity: "critical" });
    expect(d!.dedupeKey).toMatch(new RegExp(`^reconciliation_mismatch:${orderId}:sale:${product.id.replace(/[/]/g, "\\/")}:[0-9a-f]{16}$`));
    expect(d!.details).toMatchObject({ check: "sale", fields: ["totalAmount", "pTotalAmount"], stored: ["59.50", "59.50"], observed: ["59.00", "59.00"] });
    expect((await osfOf(env.db, orderId))!.flags).toContain("reconciliation_mismatch");
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual(["revenue"]);
    // I19: фінансові пункти — лише в реєстрі фінансів, ніколи в «Проблемах».
    expect((await env.db.select({ n: count() }).from(issues).where(eq(issues.orderId, orderId)))[0]!.n).toBe(0);

    product.totalAmount = bag("59.50");
    bump(fx, "2026-10-07T10:00:00Z");
    await env.sync(gid(9201));
    expect((await discrepanciesOf(env.db, orderId))[0]).toMatchObject({ status: "resolved", resolutionCode: "auto_resolved" });
    expect((await osfOf(env.db, orderId))!.flags).toEqual([]);
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual([]);
  });
});

describe("parallel reads: an older read never overwrites a newer snapshot", () => {
  it("a read with an older Order.updatedAt than the stored snapshot writes nothing (status stale)", async () => {
    const orderId = (await (await import("./helpers")).orderIdOf(env.db, gid(9201)))!;
    const before = await factCounts(env.db, orderId);
    const osfBefore = await osfOf(env.db, orderId);
    const fx = env.store.get(gid(9201))!;
    const newer = fx.finance.updatedAt;
    fx.finance.updatedAt = "2026-10-01T10:00:00Z";
    rec.calls.length = 0;
    try {
      expect(await env.sync(gid(9201), { force: true })).toEqual({ status: "stale" });
    } finally {
      fx.finance.updatedAt = newer;
    }
    expect(await factCounts(env.db, orderId)).toEqual(before);
    expect((await osfOf(env.db, orderId))!.snapshot).toEqual(osfBefore!.snapshot);
    expect(callsFor(orderId)).toEqual([]);
  });
});

describe("transactions and fees", () => {
  it("PENDING → SUCCESS updates the same row; fees only for SUCCESS; a changed fee is a discrepancy", async () => {
    const orderId = await env.createOrder(9202);
    const t = transaction({ amount: "30.00", status: "PENDING", fees: [fee("1.17")] });
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9202), { transactions: [t], totals: { currentTotalPriceSet: bag("30.00"), netPaymentSet: bag("0.00") } }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "30.00", lineItem: "gid://shopify/LineItem/92021" })])],
      refunds: [],
    };
    env.store.set(gid(9202), fx);
    await env.sync(gid(9202));
    const [pending] = await env.db.select().from(orderTransactions).where(eq(orderTransactions.orderId, orderId));
    expect(pending!.status).toBe("PENDING");
    expect((await factCounts(env.db, orderId)).fees).toBe(0);

    t.status = "SUCCESS";
    fx.finance.netPaymentSet = bag("30.00");
    bump(fx, "2026-10-06T10:00:00Z");
    await env.sync(gid(9202));
    const rows = await env.db.select().from(orderTransactions).where(eq(orderTransactions.orderId, orderId));
    expect(rows.map((r) => [r.id, r.status])).toEqual([[pending!.id, "SUCCESS"]]);
    expect((await factCounts(env.db, orderId)).fees).toBe(1);
    expect((await osfOf(env.db, orderId))!.flags).toEqual([]);

    t.fees![0]!.amount = { amount: "1.20", currencyCode: "EUR" };
    bump(fx, "2026-10-07T10:00:00Z");
    const r = await env.sync(gid(9202));
    expect(r).toMatchObject({ fees: { inserted: 0, changed: 1 } });
    const [f] = await env.db.select().from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId));
    expect(f!.amount).toBe("1.17");
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual(["fees"]);
  });

  it("transactions_truncated only when transactionsCount > 20; then RC2/RC3 are unknown, not «ok»", async () => {
    const orderId = await env.createOrder(9203);
    const txs = Array.from({ length: 20 }, () => transaction({ amount: "1.00" }));
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9203), { transactions: txs, totals: { currentTotalPriceSet: bag("20.00"), netPaymentSet: bag("20.00") } }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "20.00", lineItem: "gid://shopify/LineItem/92031" })])],
      refunds: [],
      transactionsTotal: 20,
    };
    env.store.set(gid(9203), fx);
    await env.sync(gid(9203));
    expect((await osfOf(env.db, orderId))!.flags).toEqual([]);

    fx.transactionsTotal = 21;
    bump(fx, "2026-10-06T10:00:00Z");
    await env.sync(gid(9203));
    const osf = (await osfOf(env.db, orderId))!;
    expect(osf.flags).toEqual(["transactions_truncated"]);
    expect(osf.transactionsCount).toBe(21);
    const checks = (osf.reconciliation as { checks: Record<string, { status: string; reason?: string }> }).checks;
    expect(checks.RC2).toMatchObject({ status: "unknown", reason: "transactions_truncated" });
    expect(checks.RC3).toMatchObject({ status: "unknown" });
    expect(parseSnapshot(osf.snapshot).status.transactions).toBe("truncated");
  });
});

describe("F4: a damaged amount from Shopify", () => {
  it("stores no sales of that read (all-or-nothing), flags amount_parse_error with the path, and does not retry", async () => {
    const orderId = await env.createOrder(9204);
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9204), { totals: { currentTotalPriceSet: bag("40.00"), netPaymentSet: bag("40.00") }, transactions: [transaction({ amount: "40.00" })] }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "30.00", lineItem: "gid://shopify/LineItem/92041" }), sale({ lineType: "SHIPPING", total: "1O.00" })])],
      refunds: [],
    };
    env.store.set(gid(9204), fx);
    const r = await env.sync(gid(9204));
    expect(r).toMatchObject({ status: "synced", sales: { inserted: 0, skipped: true } });
    expect((await factCounts(env.db, orderId)).sales).toBe(0);
    const osf = (await osfOf(env.db, orderId))!;
    expect(osf.flags).toEqual(["amount_parse_error"]);
    const snap = parseSnapshot(osf.snapshot);
    expect(snap.status.sales).toBe("damaged");
    expect(snap.parseErrors.sales).toEqual([{ area: "sales", path: "agreements[0].sales[1].totalAmount.shopMoney", code: "invalid_amount" }]);
    expect((await loadReconciliationState(env.db, orderId)).salesStatus).toBe("damaged");
    // Без повторів: те саме updatedAt — угоди не перечитуються, позначка лишається.
    env.fake.calls.length = 0;
    await env.sync(gid(9204));
    expect(env.fake.ops()).toEqual(["OtOrderFinance"]);
    expect((await osfOf(env.db, orderId))!.flags).toEqual(["amount_parse_error"]);
    // Наступна зміна в Shopify з коректними даними — продажі збережено, позначку знято.
    fx.agreements[0]!.sales[1]!.totalAmount = bag("10.00");
    bump(fx, "2026-10-06T10:00:00Z");
    await env.sync(gid(9204));
    expect((await factCounts(env.db, orderId)).sales).toBe(2);
    expect((await osfOf(env.db, orderId))!.flags).toEqual([]);
  });
});

describe("RC discrepancies: confirmed vs candidates, owner decisions, auto-resolution", () => {
  it("RC2 mismatch → critical, partial fees while open; the owner's resolution is respected; new values → new discrepancy; ok → closed", async () => {
    const orderId = await env.createOrder(9205);
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9205), { transactions: [transaction({ amount: "69.50" })], totals: { currentTotalPriceSet: bag("69.50"), netPaymentSet: bag("60.00") } }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "69.50", lineItem: "gid://shopify/LineItem/92051" })])],
      refunds: [],
    };
    env.store.set(gid(9205), fx);
    const r1 = await env.sync(gid(9205));
    expect(r1).toMatchObject({ mismatches: ["RC2"] });
    let ds = await discrepanciesOf(env.db, orderId);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ status: "open", severity: "critical", details: { check: "RC2", expected: "60.00", actual: "69.50", currency: "EUR", candidate: false } });
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual(["fees"]);

    await resolveDiscrepancy(env.ctx, { id: ds[0]!.id, status: "resolved", resolutionCode: "accepted", note: "перевірено" });
    bump(fx, "2026-10-06T10:00:00Z");
    await env.sync(gid(9205));
    ds = await discrepanciesOf(env.db, orderId);
    expect(ds.map((d) => [d.status, d.resolutionCode])).toEqual([["resolved", "accepted"]]);
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual([]);
    expect((await osfOf(env.db, orderId))!.flags).toContain("reconciliation_mismatch");

    fx.finance.netPaymentSet = bag("61.00");
    bump(fx, "2026-10-07T10:00:00Z");
    await env.sync(gid(9205));
    ds = await discrepanciesOf(env.db, orderId);
    expect(ds.map((d) => [d.status, (d.details as { expected: string }).expected])).toEqual([
      ["resolved", "60.00"],
      ["open", "61.00"],
    ]);

    fx.finance.netPaymentSet = bag("69.50");
    bump(fx, "2026-10-08T10:00:00Z");
    expect(await env.sync(gid(9205))).toMatchObject({ mismatches: [], flags: [] });
    ds = await discrepanciesOf(env.db, orderId);
    expect(ds.map((d) => d.status)).toEqual(["resolved", "resolved"]);
    expect(ds[1]!.resolutionCode).toBe("auto_resolved");
  });

  it("candidate RC1 mismatch → warning only (no partial component)", async () => {
    const orderId = await env.createOrder(9208);
    env.store.set(gid(9208), {
      finance: financeNode(gid(9208), { transactions: [transaction({ amount: "52.00" })], totals: { currentTotalPriceSet: bag("52.00"), netPaymentSet: bag("52.00") } }),
      // Чайові 2,00 у підсумку, але не в продажах — саме те, що звірка-кандидат має показати (не підганяючи).
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "50.00", lineItem: "gid://shopify/LineItem/92081" })])],
      refunds: [],
    });
    expect(await env.sync(gid(9208))).toMatchObject({ mismatches: ["RC1"] });
    const [d] = await discrepanciesOf(env.db, orderId);
    expect(d).toMatchObject({ severity: "warning", details: { check: "RC1", candidate: true } });
    const state = await loadReconciliationState(env.db, orderId);
    expect(state.partialComponents).toEqual([]);
    expect(state.checks?.RC1).toEqual({ status: "mismatch", candidate: true });
  });
});

describe("reading completely (§16.2): agreement and sales pages, changes during the read", () => {
  it("4 agreements (2 pages) and 20 sales on one agreement (OtAgreementSales) → all 23 sales stored", async () => {
    const orderId = await env.createOrder(9209);
    const many = Array.from({ length: 20 }, () => sale({ total: "1.00", lineItem: "gid://shopify/LineItem/92091" }));
    env.store.set(gid(9209), {
      finance: financeNode(gid(9209), { transactions: [transaction({ amount: "23.00" })], totals: { currentTotalPriceSet: bag("23.00"), netPaymentSet: bag("23.00") } }),
      agreements: [
        agreement("OrderAgreement", "2026-10-05T09:00:00Z", many),
        agreement("OrderEditAgreement", "2026-10-05T09:10:00Z", [sale({ total: "1.00", lineItem: "gid://shopify/LineItem/92091" })]),
        agreement("OrderEditAgreement", "2026-10-05T09:20:00Z", [sale({ total: "1.00", lineItem: "gid://shopify/LineItem/92091" })]),
        agreement("OrderEditAgreement", "2026-10-05T09:30:00Z", [sale({ total: "1.00", lineItem: "gid://shopify/LineItem/92091" })]),
      ],
      refunds: [],
    });
    env.fake.calls.length = 0;
    expect(await env.sync(gid(9209))).toMatchObject({ status: "synced", sales: { inserted: 23 }, mismatches: [] });
    expect(env.fake.ops()).toEqual(["OtOrderFinance", "OtOrderAgreements", "OtAgreementSales", "OtOrderAgreements"]);
    expect(env.fake.calls.find((c) => c.op === "OtAgreementSales")?.variables).toMatchObject({ after: "15" });
    expect(env.fake.calls.every((c) => c.cost <= 950)).toBe(true);
    expect((await factCounts(env.db, orderId)).sales).toBe(23);
  });

  it("order changed between pages → retryable error, nothing stored (the job repeats with fresh data)", async () => {
    const orderId = await env.createOrder(9210);
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9210)),
      agreements: Array.from({ length: 4 }, (_, i) => agreement("OrderAgreement", `2026-10-05T09:0${i}:00Z`, [sale({ total: "1.00" })])),
      refunds: [],
    };
    env.store.set(gid(9210), fx);
    env.fake.beforeResponse = (op, vars) => {
      if (op === "OtOrderAgreements" && vars?.after) fx.finance.updatedAt = "2026-10-05T11:00:00Z";
    };
    try {
      const err = await env.sync(gid(9210)).catch((e) => e);
      expect(err).toBeInstanceOf(ShopifyApiError);
      expect(err).toMatchObject({ retryable: true, code: "ORDER_CHANGED_DURING_READ" });
    } finally {
      env.fake.beforeResponse = null;
    }
    expect(await factCounts(env.db, orderId)).toMatchObject({ osf: 0, sales: 0, transactions: 0 });
  });
});

describe("refunds (§8.3, §14.3 п. 6), disputes (§8.2), external waybills (§16.1)", () => {
  it("refunds are read only when their ids change; lines keep restockType/restocked and the app line link", async () => {
    const orderId = await env.createOrder(9211, { lineItems: { nodes: [{ ...(await import("../../stage2/fixtures")).gqlOrder(9211).lineItems.nodes[0]!, quantity: 2 }] } });
    const ref = refund({ amount: "45.00", lines: [refundLine("gid://shopify/LineItem/92111", 1, "NO_RESTOCK", false, "45.00")] });
    const refundAgreement = agreement("RefundAgreement", "2026-11-04T10:00:00Z", [sale({ total: "-45.00", quantity: -1, actionType: "RETURN", lineItem: "gid://shopify/LineItem/92111" })], {
      refund: { id: ref.id },
    });
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9211), {
        transactions: [transaction({ amount: "90.00" }), transaction({ kind: "REFUND", amount: "45.00", processedAt: "2026-11-04T10:00:00Z" })],
        totals: { currentTotalPriceSet: bag("45.00"), netPaymentSet: bag("45.00"), totalRefundedSet: bag("45.00") },
        disputes: [{ id: "gid://shopify/ShopifyPaymentsDispute/71", initiatedAs: "CHARGEBACK", status: "NEEDS_RESPONSE" }],
        fulfillments: [{ trackingInfo: [{ number: "2045 0000 0000 11", company: "Nova Poshta" }, { number: "2.0451E+13", company: null }] }],
      }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "90.00", quantity: 2, lineItem: "gid://shopify/LineItem/92111" })]), refundAgreement],
      refunds: [ref],
    };
    env.store.set(gid(9211), fx);
    env.fake.calls.length = 0;
    const r = await env.sync(gid(9211));
    expect(r).toMatchObject({ refundsRead: true, refunds: 1, refundLines: 1, disputes: 1, mismatches: [], externalWaybills: { inserted: 1, invalid: 1 } });
    expect(env.fake.ops()).toContain("OtOrderRefunds");
    const [line] = await env.db.select().from(orderRefundLines).innerJoin(orderRefunds, eq(orderRefunds.id, orderRefundLines.refundId)).where(eq(orderRefunds.orderId, orderId));
    expect(line!.order_refund_lines).toMatchObject({ quantity: 1, restockType: "NO_RESTOCK", restocked: false, subtotal: "45.00", orderLineItemId: await lineIdOf(env.db, orderId, "gid://shopify/LineItem/92111") });
    expect(parseSnapshot((await osfOf(env.db, orderId))!.snapshot).status.refunds).toBe("complete");
    const [w] = await env.db.select().from(orderExternalWaybills).where(eq(orderExternalWaybills.orderId, orderId));
    expect(w).toMatchObject({ numberNorm: "20450000000011", source: "shopify_fulfillment", carrierCode: null });
    const [d] = await env.db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId));
    expect(d).toMatchObject({ status: "NEEDS_RESPONSE", amount: null, outcome: null, source: "shopify", version: 1 });

    // Нова зміна без нових повернень — OtOrderRefunds не читається; статус спору змінився — версія +1, суми власника не чіпаються.
    await env.db.update(orderDisputes).set({ amount: "90.00", currency: "EUR" }).where(eq(orderDisputes.orderId, orderId));
    fx.finance.disputes = [{ id: "gid://shopify/ShopifyPaymentsDispute/71", initiatedAs: "CHARGEBACK", status: "LOST" }];
    bump(fx, "2026-11-05T10:00:00Z");
    env.fake.calls.length = 0;
    const r2 = await env.sync(gid(9211));
    expect(r2.status === "synced" && r2.refundsRead).toBe(false);
    expect(env.fake.ops()).toEqual(["OtOrderFinance", "OtOrderAgreements"]);
    const [d2] = await env.db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId));
    expect(d2).toMatchObject({ status: "LOST", amount: "90.00", version: 2 });
    expect(d2!.statusChangedAt).toBeTruthy();
    expect(parseSnapshot((await osfOf(env.db, orderId))!.snapshot).status.refunds).toBe("complete");
    expect(await factCounts(env.db, orderId)).toMatchObject({ refunds: 1, refundLines: 1, waybills: 1, disputes: 1 });
  });
});

describe("orders the app does not store or Shopify does not return", () => {
  it("an unknown (unpaid, not stored) order is skipped without any read", async () => {
    env.fake.calls.length = 0;
    expect(await env.sync(gid(9999))).toEqual({ status: "not_stored" });
    expect(env.fake.ops()).toEqual([]);
  });

  it("Shopify returns null: older than 60 days without read_all_orders → order_unreadable; recent → not_found", async () => {
    const old = await env.createOrder(9212, { createdAt: "2026-01-05T10:00:00Z", processedAt: "2026-01-05T10:00:00Z" });
    expect(await env.sync(gid(9212))).toEqual({ status: "unreadable", marked: true, factsKept: false });
    expect((await osfOf(env.db, old))!.flags).toEqual(["order_unreadable"]);
    const [d] = await discrepanciesOf(env.db, old);
    expect(d).toMatchObject({ type: "order_unreadable", status: "open", dedupeKey: `order_unreadable:${old}` });
    expect(parseSnapshot((await osfOf(env.db, old))!.snapshot).status.sales).toBe("not_read");
    // Повтор — без нових рядків.
    expect(await env.sync(gid(9212))).toEqual({ status: "unreadable", marked: true, factsKept: false });
    expect(await discrepanciesOf(env.db, old)).toHaveLength(1);

    const recent = await env.createOrder(9213, { createdAt: new Date().toISOString(), processedAt: new Date().toISOString() });
    expect(await env.sync(gid(9213))).toEqual({ status: "not_found" });
    expect(await osfOf(env.db, recent)).toBeUndefined();
  });

  it("ACCESS_DENIED on an old order is the same as an empty answer (no retries)", async () => {
    const old = await env.createOrder(9214, { createdAt: "2026-02-05T10:00:00Z", processedAt: "2026-02-05T10:00:00Z" });
    env.fake.failNext("OtOrderFinance", new ShopifyApiError("access denied", false, "ACCESS_DENIED"));
    expect(await env.sync(gid(9214))).toEqual({ status: "unreadable", marked: true, factsKept: false });
    expect((await osfOf(env.db, old))!.flags).toEqual(["order_unreadable"]);
  });

  it("a later successful read clears order_unreadable (closed by the system)", async () => {
    const old = (await import("./helpers")).orderIdOf;
    const id = (await old(env.db, gid(9212)))!;
    env.store.set(gid(9212), {
      finance: financeNode(gid(9212), { transactions: [transaction({ amount: "5.00" })], totals: { currentTotalPriceSet: bag("5.00"), netPaymentSet: bag("5.00") } }),
      agreements: [agreement("OrderAgreement", "2026-01-05T10:00:00Z", [sale({ total: "5.00", lineItem: "gid://shopify/LineItem/92121" })])],
      refunds: [],
    });
    expect(await env.sync(gid(9212))).toMatchObject({ status: "synced", flags: [] });
    expect((await discrepanciesOf(env.db, id))[0]).toMatchObject({ status: "resolved", resolutionCode: "auto_resolved" });
  });
});

describe("review round: Shopify facts that are incomplete or unreadable are never shown as complete", () => {
  it("F4/§8.1: one damaged fee of two → fees «damaged» (not a smaller complete set), amount_parse_error; a correct re-read stores it", async () => {
    const orderId = await env.createOrder(9218);
    const t = transaction({ amount: "69.50", fees: [fee("2.32"), fee("2,10")] });
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9218), { transactions: [t], totals: { currentTotalPriceSet: bag("69.50"), netPaymentSet: bag("69.50") } }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "69.50", lineItem: "gid://shopify/LineItem/92181" })])],
      refunds: [],
    };
    env.store.set(gid(9218), fx);
    expect(await env.sync(gid(9218))).toMatchObject({ status: "synced", fees: { inserted: 1 }, flags: ["amount_parse_error"] });
    expect((await env.db.select().from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId))).map((f) => f.amount)).toEqual(["2.32"]);
    let state = await loadReconciliationState(env.db, orderId);
    expect(state).toMatchObject({ transactionsStatus: "complete", feesStatus: "damaged", flags: ["amount_parse_error"] });
    expect(state.checks?.RC2).toEqual({ status: "ok", candidate: false }); // суми транзакцій цілі
    expect(parseSnapshot((await osfOf(env.db, orderId))!.snapshot).parseErrors.order).toEqual([{ area: "fees", path: "transactions[0].fees[1].amount", code: "invalid_amount" }]);

    // Shopify віддає коректне значення (транзакції перечитуються щоразу) — комісію збережено, набір повний.
    t.fees![1]!.amount = { amount: "2.10", currencyCode: "EUR" };
    expect(await env.sync(gid(9218))).toMatchObject({ fees: { inserted: 1, changed: 0 }, flags: [] });
    state = await loadReconciliationState(env.db, orderId);
    expect(state).toMatchObject({ feesStatus: "complete", flags: [] });
    expect((await env.db.select().from(orderTransactionFees).where(eq(orderTransactionFees.orderId, orderId))).map((f) => f.amount).sort()).toEqual(["2.10", "2.32"]);
  });

  it("§16.3: the owner resolves one change of a Sale.id; ANOTHER value of the same Sale.id is a new discrepancy (partial again); the accepted value stays accepted", async () => {
    const orderId = await env.createOrder(9219);
    const fx = g2Fixture(gid(9219), "gid://shopify/LineItem/92191");
    env.store.set(gid(9219), fx);
    await env.sync(gid(9219));
    const product = fx.agreements[0]!.sales[0]!;
    product.totalAmount = bag("59.00");
    bump(fx, "2026-10-06T10:00:00Z");
    await env.sync(gid(9219));
    let ds = await discrepanciesOf(env.db, orderId);
    expect(ds.map((d) => d.status)).toEqual(["open"]);
    await resolveDiscrepancy(env.ctx, { id: ds[0]!.id, status: "resolved", resolutionCode: "accepted", note: "перевірено" });
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual([]);

    product.totalAmount = bag("10.00");
    bump(fx, "2026-10-07T10:00:00Z");
    expect(await env.sync(gid(9219))).toMatchObject({ sales: { changed: 1 }, flags: ["reconciliation_mismatch"] });
    ds = await discrepanciesOf(env.db, orderId);
    expect(ds.map((d) => [d.status, d.resolutionCode, (d.details as { observed: string[] }).observed[0]])).toEqual([
      ["resolved", "accepted", "59.00"],
      ["open", null, "10.00"],
    ]);
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual(["revenue"]);
    const [stored] = await env.db.select().from(orderSales).where(and(eq(orderSales.orderId, orderId), eq(orderSales.lineType, "PRODUCT")));
    expect(stored!.totalAmount).toBe("59.50"); // рядок незмінний

    // Знову значення, яке власник уже прийняв: відкриту (10.00) закриває система, рішення власника лишається чинним.
    product.totalAmount = bag("59.00");
    bump(fx, "2026-10-08T10:00:00Z");
    expect(await env.sync(gid(9219))).toMatchObject({ sales: { changed: 1 }, flags: [] });
    ds = await discrepanciesOf(env.db, orderId);
    expect(ds.map((d) => [d.status, d.resolutionCode])).toEqual([
      ["resolved", "accepted"],
      ["resolved", "auto_resolved"],
    ]);
    expect((await loadReconciliationState(env.db, orderId)).partialComponents).toEqual([]);
  });

  it("§22.1: a later change of an order with facts that Shopify no longer returns → facts kept + order_unreadable (later); reopened on the next unread change; cleared by a successful read", async () => {
    const orderId = await env.createOrder(9220, { createdAt: "2026-01-05T10:00:00Z", processedAt: "2026-01-05T10:00:00Z" });
    const fx = g2Fixture(gid(9220), "gid://shopify/LineItem/92201");
    env.store.set(gid(9220), fx);
    await env.sync(gid(9220));
    const before = await factCounts(env.db, orderId);
    const snapBefore = parseSnapshot((await osfOf(env.db, orderId))!.snapshot);
    const fetchedBefore = (await osfOf(env.db, orderId))!.fetchedAt;

    // Повернення коштів (webhook) за замовленням > 60 днів без read_all_orders: Shopify більше не віддає замовлення.
    env.store.delete(gid(9220));
    expect(await env.sync(gid(9220))).toEqual({ status: "unreadable", marked: true, factsKept: true });
    let osf = (await osfOf(env.db, orderId))!;
    expect(osf.flags).toEqual(["order_unreadable"]);
    expect(osf.fetchedAt).toEqual(fetchedBefore);
    expect(parseSnapshot(osf.snapshot)).toEqual(snapBefore); // продажі лишаються «complete» — виручка не стає «Оцінкою»
    const { discrepancies: _d0, changeLog: _c0, ...factsBefore } = before;
    const { discrepancies: _d1, changeLog: _c1, ...factsAfter } = await factCounts(env.db, orderId);
    expect(factsAfter).toEqual(factsBefore); // жодного факту не видалено й не додано
    let [d] = await discrepanciesOf(env.db, orderId);
    expect(d).toMatchObject({ type: "order_unreadable", status: "open", dedupeKey: `order_unreadable:${orderId}:later`, details: { reason: "later_change_unreadable", scope: "read_all_orders" } });
    expect((await loadReconciliationState(env.db, orderId)).salesStatus).toBe("complete");

    // Власник розглянув; наступна непрочитана зміна — розбіжність знову відкрита (рішення стосувалося попередньої).
    await resolveDiscrepancy(env.ctx, { id: d!.id, status: "resolved", resolutionCode: "accepted", note: "внесено вручну" });
    expect(await env.sync(gid(9220))).toMatchObject({ status: "unreadable", factsKept: true });
    [d] = await discrepanciesOf(env.db, orderId);
    expect(d).toMatchObject({ status: "open" });
    expect(await discrepanciesOf(env.db, orderId)).toHaveLength(1);

    // Успішне читання (напр. після надання read_all_orders) — позначку й розбіжність знімає система.
    env.store.set(gid(9220), fx);
    bump(fx, "2026-10-09T10:00:00Z");
    expect(await env.sync(gid(9220))).toMatchObject({ status: "synced", flags: [] });
    osf = (await osfOf(env.db, orderId))!;
    expect(osf.flags).toEqual([]);
    [d] = await discrepanciesOf(env.db, orderId);
    expect(d).toMatchObject({ status: "resolved", resolutionCode: "auto_resolved" });
  });

  it("§16.4/§16.6: ACCESS_DENIED for an order INSIDE the read window is an explicit non-retryable error — never a silent skip", async () => {
    const now = new Date().toISOString();
    const orderId = await env.createOrder(9221, { createdAt: now, processedAt: now });
    env.store.set(gid(9221), g2Fixture(gid(9221), "gid://shopify/LineItem/92211"));
    env.fake.failNext("OtOrderFinance", new ShopifyApiError("Access denied for disputes field", false, "ACCESS_DENIED"));
    const err = await env.sync(gid(9221)).catch((e) => e);
    expect(err).toBeInstanceOf(ShopifyApiError);
    expect(err).toMatchObject({ retryable: false, code: "ACCESS_DENIED" });
    expect(await factCounts(env.db, orderId)).toMatchObject({ osf: 0, sales: 0, discrepancies: 0 });
  });

  it("§2.5: Order.test from the finance read fixes orders.shopify_test of an order stored before stage 6 (column default false)", async () => {
    const orderId = await env.createOrder(9222, { test: true });
    await env.db.update(orders).set({ shopifyTest: false }).where(eq(orders.id, orderId)); // як рядок до етапу 6
    const fx = g2Fixture(gid(9222), "gid://shopify/LineItem/92221");
    fx.finance.test = true;
    env.store.set(gid(9222), fx);
    rec.calls.length = 0;
    await env.sync(gid(9222));
    expect((await env.db.select({ t: orders.shopifyTest }).from(orders).where(eq(orders.id, orderId)))[0]!.t).toBe(true);
    // Позначку записано до syncOrderFinance (WP4) у тій самій транзакції — виклик один.
    expect(callsFor(orderId)).toHaveLength(1);
  });
});

describe("late customerJourneySummary (§9.2): re-reads after 1 / 6 / 24 h, at most 3", () => {
  const journeyJob = async (orderGid: string) =>
    (await env.db.select().from(jobs).where(and(eq(jobs.dedupeKey, `finance-journey:${orderGid}`), eq(jobs.status, "queued"))))[0];
  /** Імітація запуску відкладеного читання: завдання вже не «в черзі» (виконується). */
  const startJourneyJob = async (orderGid: string) => {
    await env.db.update(jobs).set({ status: "running" }).where(and(eq(jobs.dedupeKey, `finance-journey:${orderGid}`), eq(jobs.status, "queued")));
  };

  it("ready=false → +1 h, +6 h, +24 h, then journey_never_ready; ready=true → referral code, flag cleared", async () => {
    const orderId = await env.createOrder(9215);
    const fx: FinanceOrderFixture = {
      finance: financeNode(gid(9215), {
        transactions: [transaction({ amount: "10.00" })],
        totals: { currentTotalPriceSet: bag("10.00"), netPaymentSet: bag("10.00") },
        customerJourneySummary: { ready: false, lastVisit: null },
        discountCodes: ["PART10"],
      }),
      agreements: [agreement("OrderAgreement", "2026-10-05T09:00:00Z", [sale({ total: "10.00", lineItem: "gid://shopify/LineItem/92151" })])],
      refunds: [],
    };
    env.store.set(gid(9215), fx);
    const t0 = Date.now();
    expect(await env.sync(gid(9215))).toMatchObject({ journeyScheduled: true });
    let job = await journeyJob(gid(9215));
    expect(job!.payload).toEqual({ shop: "ot-finance.myshopify.com", orderGid: gid(9215), journey: true });
    expect(job!.runAt.getTime() - t0).toBeGreaterThanOrEqual(FINANCE_JOB_TIMING.journeyRetryDelaysMs[0] - 5_000);
    expect((await osfOf(env.db, orderId))).toMatchObject({ journeyReady: false, journeyChecks: 1, referralCode: null, discountCodes: ["PART10"] });

    // Звичайне читання (webhook), поки повторне чекає, лічильник не збільшує.
    await env.sync(gid(9215));
    expect((await osfOf(env.db, orderId))!.journeyChecks).toBe(1);

    for (const [i, delay] of [[2, FINANCE_JOB_TIMING.journeyRetryDelaysMs[1]], [3, FINANCE_JOB_TIMING.journeyRetryDelaysMs[2]]] as const) {
      await startJourneyJob(gid(9215));
      const t = Date.now();
      await env.sync(gid(9215), { journey: true });
      job = await journeyJob(gid(9215));
      expect(job!.runAt.getTime() - t).toBeGreaterThanOrEqual(delay - 5_000);
      expect((await osfOf(env.db, orderId))!.journeyChecks).toBe(i);
      expect((await osfOf(env.db, orderId))!.flags).not.toContain("journey_never_ready");
    }
    await startJourneyJob(gid(9215));
    expect(await env.sync(gid(9215), { journey: true })).toMatchObject({ journeyScheduled: false });
    expect(await journeyJob(gid(9215))).toBeUndefined();
    expect((await osfOf(env.db, orderId))).toMatchObject({ journeyChecks: 3, flags: ["journey_never_ready"] });

    fx.finance.customerJourneySummary = { ready: true, lastVisit: { referralCode: "BLOG10" } };
    await env.sync(gid(9215));
    expect((await osfOf(env.db, orderId))).toMatchObject({ journeyReady: true, referralCode: "BLOG10", flags: [] });
  });

  it("test orders are not attributed — no journey re-reads (without includeTestOrders)", async () => {
    const orderId = await env.createOrder(9216, { test: true });
    env.store.set(gid(9216), {
      finance: financeNode(gid(9216), { test: true, customerJourneySummary: { ready: false, lastVisit: null } }),
      agreements: [],
      refunds: [],
    });
    expect(await env.sync(gid(9216))).toMatchObject({ journeyScheduled: false });
    expect(await journeyJob(gid(9216))).toBeUndefined();
    expect((await osfOf(env.db, orderId))!.journeyChecks).toBe(0);
  });
});

describe("I19 and F9", () => {
  it("no finance sync event creates an issue; fact tables hold no personal data columns", async () => {
    expect((await env.db.select({ n: count() }).from(issues))[0]!.n).toBe(0);
    const osf = await env.db.select().from(orderShopifyFinance);
    const text = JSON.stringify(osf);
    for (const pii of ["buyer@example.com", "Beispielweg", "Berlin", "+4915123456789", "Test Buyer"]) expect(text).not.toContain(pii);
  });
});

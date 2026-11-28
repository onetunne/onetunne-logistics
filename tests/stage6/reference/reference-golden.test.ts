/**
 * Етап 6 (WP12a): самоперевірка НЕЗАЛЕЖНОЇ еталонної моделі на числах золотих випадків G1–G19 (§20.1).
 * Модель відтворює кожне число точно; ті самі дані й очікування WP12b порівнює із застосунком.
 */
import { describe, expect, it } from "vitest";
import {
  activeEntries,
  activeOrderLines,
  allocateDaily,
  allocatePeriodSum,
  amountVsForecast,
  averageCheck,
  averageOrderProfit,
  batchLineTargets,
  cents,
  closeMonth,
  convert,
  countryRanking,
  divRound,
  duplicatesInFile,
  effectTotals,
  emptyImportLedger,
  forecast,
  fxConversionDifference,
  impliedRatio,
  invoiceTotalMismatch,
  journalFrom,
  kyivDate,
  manualCostExists,
  manualEntryAllowed,
  matchImportLine,
  matchWaybill,
  modelStockCost,
  monthReport,
  mulDiv,
  normalizeWaybill,
  orderCard,
  orderInvoiceLines,
  orderProfit,
  partnerBase,
  partnerLedger,
  partnerPayback,
  parseDecimal,
  pnlReport,
  postBatchWriteOff,
  postExpense,
  postOrder,
  previewImport,
  productRanking,
  profitByStates,
  profitLabel,
  rateFor,
  rangeReport,
  reconcile,
  runCosting,
  saveImport,
  shippingLoss,
  shippingStats,
  similarDocument,
  splitTargetByReceipts,
  stockValueAt,
  str,
  weightMismatch,
  type ImportContext,
  type RefEntry,
  type RefJournal,
  type RefMonthClosure,
  type ReportSources,
} from "./model";
import * as G from "./golden";

const ctx1 = { rates: G.G1_RATES };
const ALL = { from: "2026-01-01", to: "2026-12-31" };
const OCT = { from: "2026-10-01", to: "2026-10-31" };
const NOV = { from: "2026-11-01", to: "2026-11-30" };
const E1 = G.ORDER_EXPECTED.G1;

const only = (es: readonly RefEntry[], category: string) => es.filter((e) => e.category === category);
const conv = (e: RefEntry, to: string, ctx = ctx1) => {
  const v = convert(cents(e.amount), e.currency, to, e.fxOn, ctx);
  return v === null ? null : str(v);
};

describe("G1 — знижка, партнер, комісія, часткове повернення в наступному місяці, пізній рахунок", () => {
  const before = postOrder(G.G1_ORDER, G.G1_AS_OF_BEFORE_IMPORT);
  const after = postOrder(G.G1_ORDER, G.G1_AS_OF_AFTER_IMPORT);
  const jb = journalFrom([before]);
  const ja = journalFrom([after]);

  it("визнано 05.10; fx_on виручки й комісії — 05.10", () => {
    expect(before.order.recognizedOn).toBe("2026-10-05");
    for (const e of [...only(before.entries, "sales_product"), ...only(before.entries, "payment_fees")]) expect(e.fxOn).toBe("2026-10-05");
  });

  it("жовтень до імпорту: оборот 6 256,50, валовий 5 206,50, «Факт» — (0 з 1), «≈ Прогноз» 3 902,11", () => {
    const r = pnlReport(jb, { ...OCT, currency: "UAH", ctx: ctx1 });
    const x = E1.octoberBeforeImport;
    expect(before.order.state).toBe("preliminary");
    expect(r.turnover).toBe(x.turnover);
    expect(r.columns.total.A).toBe(x.A);
    expect(r.columns.total.B).toBe(x.B);
    expect(r.grossProfit.value).toBe(x.grossProfit);
    expect(r.profit.fact).toBe(x.profitFact);
    expect(r.profit.factOrders).toBe(x.profitFactOrders);
    expect(r.profit.orders).toBe(x.orders);
    expect(r.profit.forecast).toBe(x.profitForecast);
  });

  it("жовтень після імпорту: пізнє завершення датою 05.10, final, «Факт» 3 882,11; розбіжності немає", () => {
    const ship = only(after.entries, "shipping_cost");
    expect(ship).toHaveLength(1);
    expect(ship[0]).toMatchObject({ amount: "-540.00", recognizedOn: "2026-10-05", fxOn: "2026-10-05", isLateCompletion: true, isLate: false });
    expect(after.order.state).toBe(E1.octoberAfterImport.state);
    const r = pnlReport(ja, { ...OCT, currency: "UAH", ctx: ctx1 });
    expect(r.profit.fact).toBe(E1.octoberAfterImport.profitFact);
    expect(amountVsForecast(cents("540.00"), cents("520.00"))).toBe(E1.octoberAfterImport.amountVsForecast);
  });

  it("листопад: −2 196,00 + 400,00 + 219,60 = −1 576,40", () => {
    const r = pnlReport(ja, { ...NOV, currency: "UAH", ctx: ctx1 });
    expect(r.columns.total.D).toBe(E1.november.D);
    expect(r.profit.fact).toBe(E1.november.profitFact);
    const ret = only(after.entries, "cogs_return");
    expect(ret[0]).toMatchObject({ amount: E1.november.cogsReturn, recognizedOn: "2026-11-06" });
    const adj = after.entries.filter((e) => e.category === "partner_commission" && e.recognizedOn === "2026-11-04");
    expect(conv(adj[0]!, "UAH")).toBe(E1.november.partner);
  });

  it("за весь час: 2 305,71; чиста виручка 4 060,50; рентабельність 56,8 %", () => {
    const r = pnlReport(ja, { ...ALL, currency: "UAH", ctx: ctx1 });
    expect(r.profit.fact).toBe(E1.allTime.profitFact);
    expect(r.netRevenue).toBe(E1.allTime.netRevenue);
    expect(r.orderMargin.fact).toBe(E1.allTime.orderMargin);
    expect(r.periodMargin.fact).toBe(E1.allTime.periodMargin);
    // I13: Σ за станами = прибуток.
    const s = profitByStates(ja, { ...ALL, currency: "UAH", ctx: ctx1 });
    expect(str(cents(s.final) + cents(s.period))).toBe(r.profit.fact);
  });

  it("картка між 06.11 і 10.11 — рядки (нетто + складники), «≈ Прогноз 2 325,71 · ≈ 57,3 %»", () => {
    const c = orderCard(jb, G.G1_ORDER.id, "UAH", ctx1, G.G1_ORDER.transactions);
    const x = E1.card;
    expect(c.state).toBe(x.state);
    expect(c.products.net.byCurrency.EUR).toBe(x.productsNet);
    expect(c.products.sold.byCurrency.EUR).toBe(x.productsSold);
    expect(c.products.returned.byCurrency.EUR).toBe(x.productsReturned);
    expect(c.products.beforeDiscounts.byCurrency.EUR).toBe(x.beforeDiscounts);
    expect(c.products.discounts.byCurrency.EUR).toBe(x.discounts);
    expect(c.shippingPaid.byCurrency.EUR).toBe(x.shippingPaid);
    expect(c.cogs.net.byCurrency.UAH).toBe(x.cogsNet);
    expect(c.cogs.writtenOff.byCurrency.UAH).toBe(x.cogsWrittenOff);
    expect(c.cogs.returns.byCurrency.UAH).toBe(x.cogsReturns);
    expect(c.packaging.byCurrency.UAH).toBe(x.packaging);
    expect(c.shippingActual.converted).toBeNull(); // фактичної доставки ще немає — не «0,00» (F4)
    expect(c.shippingActual.byCurrency).toEqual({});
    expect(c.shippingActual.state).toBe("forecast");
    expect(c.shippingActual.forecast?.byCurrency.UAH).toBe(x.shippingForecast);
    expect(c.shippingActual.basis).toBe("carrier_reported");
    expect(c.fees.byCurrency.EUR).toBe(x.fees);
    expect(c.partner.net.byCurrency.EUR).toBe(x.partnerNet);
    expect(c.partner.accrued.byCurrency.EUR).toBe(x.partnerAccrued);
    expect(c.partner.adjustments.byCurrency.EUR).toBe(x.partnerAdjustments);
    expect(c.profit).toMatchObject({ kind: "forecast", value: x.profitForecast, margin: x.margin });
    expect(c.paidByCustomer).toEqual(x.paid);
    // I4: прибуток картки = Σ записів замовлення (сконвертованих) + прогноз.
    const op = orderProfit(jb, G.G1_ORDER.id, "UAH", ctx1);
    expect(str(op.entriesProfit + op.forecast)).toBe(x.profitForecast);
  });

  it("звітність EUR: кожен запис окремо — 80,06 (а не 80,04), до імпорту 80,47; листопад −32,30; разом 47,76 · 56,9 %", () => {
    const x = E1.eur;
    const cogs = only(after.entries, "cogs");
    expect(cogs.map((e) => conv(e, "EUR"))).toEqual([x.cogsA, x.cogsB]);
    expect(conv(only(after.entries, "packaging")[0]!, "EUR")).toBe(x.packaging);
    expect(conv(only(after.entries, "shipping_cost")[0]!, "EUR")).toBe(x.shipping);
    expect(conv(only(after.entries, "cogs_return")[0]!, "EUR")).toBe(x.cogsReturn);
    expect(pnlReport(ja, { ...OCT, currency: "EUR", ctx: ctx1 }).profit.fact).toBe(x.octoberAfterImport);
    expect(str(convert(cents(E1.octoberAfterImport.profitFact), "UAH", "EUR", "2026-10-05", ctx1)!)).toBe(x.octoberTotalConvertedOnce);
    expect(pnlReport(jb, { ...OCT, currency: "EUR", ctx: ctx1 }).profit.forecast).toBe(x.octoberBeforeImport);
    expect(str(convert(cents("-520.00"), "UAH", "EUR", "2026-10-05", ctx1)!)).toBe(x.shippingForecast);
    expect(pnlReport(ja, { ...NOV, currency: "EUR", ctx: ctx1 }).profit.fact).toBe(x.november);
    const all = pnlReport(ja, { ...ALL, currency: "EUR", ctx: ctx1 });
    expect(all.profit.fact).toBe(x.allTime);
    expect(all.orderMargin.fact).toBe(x.margin);
  });

  it("партнер: нараховано 11,70 (утримання до 04.11) → коригування −4,50 → до виплати 7,20 з 05.11", () => {
    const x = E1.partner;
    expect(after.order.partnerEvents.map((e) => [e.kind, str(e.amount), e.date])).toEqual([
      ["accrual", x.accrual, "2026-10-05"],
      ["adjustment", x.adjustment, "2026-11-04"],
    ]);
    expect(after.order.partnerHoldUntil).toBe(x.holdUntil);
    const ledger = (today: string) =>
      partnerLedger([{ orderId: G.G1_ORDER.id, recognizedOn: after.order.recognizedOn, holdDays: 30, events: after.order.partnerEvents }], [], today);
    expect(ledger("2026-11-04").orders[0]!.state).toBe(x.stateOn0411);
    expect(ledger("2026-11-05").orders[0]!.state).toBe(x.stateOn0511);
    expect(ledger("2026-11-05").payable).toBe(x.payableOn0511);
    expect(ledger("2026-11-05").balance).toBe(x.net);
  });

  it("повтор проведення не додає записів (F2, I3): ключі унікальні й однакові між прогонами", () => {
    const again = postOrder(G.G1_ORDER, G.G1_AS_OF_AFTER_IMPORT);
    expect(again.entries.map((e) => e.key)).toEqual(after.entries.map((e) => e.key));
    expect(new Set(after.entries.map((e) => e.key)).size).toBe(after.entries.length);
  });
});

describe("G1b — передоплата й дата курсу (D-25)", () => {
  it("виручка 4 800,00 (дата оплати 01.10) / 4 850,00 (дата визнання); собівартість і упаковка — датою визнання", () => {
    const x = G.ORDER_EXPECTED.G1b;
    const p = postOrder(G.G1B_ORDER, "2026-10-10T00:00:00Z");
    const r = postOrder(G.G1B_ORDER, "2026-10-10T00:00:00Z", { rateDatePolicy: "recognition_date" });
    expect(p.order.recognizedOn).toBe("2026-10-05");
    const sp = only(p.entries, "sales_product")[0]!;
    const sr = only(r.entries, "sales_product")[0]!;
    expect([sp.fxOn, conv(sp, "UAH")]).toEqual([x.paymentDatePolicy.fxOn, x.paymentDatePolicy.revenue]);
    expect([sr.fxOn, conv(sr, "UAH")]).toEqual([x.recognitionDatePolicy.fxOn, x.recognitionDatePolicy.revenue]);
    for (const e of [...only(p.entries, "cogs"), ...only(p.entries, "packaging")]) expect([e.recognizedOn, e.fxOn]).toEqual([x.cogs.recognizedOn, x.cogs.fxOn]);
  });
});

describe("G2 — ціни з податком (DE, 19 %)", () => {
  const x = G.ORDER_EXPECTED.G2;
  const p = postOrder(G.G2_ORDER, "2026-10-10T00:00:00Z");
  it("виручка без податку, податок довідково; оборот 58,40; оплачено 69,50", () => {
    expect(only(p.entries, "sales_product").map((e) => e.amount)).toEqual([x.salesProduct]);
    expect(only(p.entries, "sales_shipping").map((e) => e.amount)).toEqual([x.salesShipping]);
    expect(only(p.entries, "tax_collected_memo").map((e) => e.amount)).toEqual([x.taxProduct, x.taxShipping]);
    const r = pnlReport(journalFrom([p]), { ...OCT, currency: "EUR", ctx: ctx1 });
    expect(r.turnover).toBe(x.turnover);
    const card = orderCard(journalFrom([p]), G.G2_ORDER.id, "EUR", ctx1, G.G2_ORDER.transactions);
    expect(card.paidByCustomer?.received).toBe(x.paid);
  });
  it("база партнера 50,00 (без податку й доставки), винагорода 5,00; RC4 без розбіжності", () => {
    expect(str(partnerBase(G.G2_ORDER.sales))).toBe(x.partnerBase);
    expect(str(p.order.partnerEvents[0]!.amount)).toBe(x.partnerCommission);
    expect(reconcile({ sales: G.G2_ORDER.sales, transactions: G.G2_ORDER.transactions, ...G.G2_TOTALS })).toEqual(x.reconcileFailures);
    // Податок доставки в RC4 не входить: якби входив, 11,10 ≠ 9,50.
    expect(reconcile({ sales: G.G2_ORDER.sales, transactions: [], currentTotalTax: "11.10" })).toEqual(["RC4"]);
  });
});

describe("G3 — валюти (НБУ 20.11.2026), запасний курс, валюти з 0 знаками", () => {
  const x = G.G3_EXPECTED;
  const c3 = { rates: G.G3_RATES };
  const cv = (amount: string, from: string, to: string) => {
    const v = convert(cents(amount), from, to, x.date, c3);
    return v === null ? null : str(v);
  };
  it("EUR → UAH / USD / HUF; велика сума без попереднього округлення кросу", () => {
    expect(cv(x.eurToUah.amount, "EUR", "UAH")).toBe(x.eurToUah.expected);
    expect(cv(x.eurToUsd.amount, "EUR", "USD")).toBe(x.eurToUsd.expected);
    expect(cv(x.eurToHuf.amount, "EUR", "HUF")).toBe(x.eurToHuf.expected);
    expect(cv(x.bigEurToUsd.amount, "EUR", "USD")).toBe(x.bigEurToUsd.expected);
    const cross = parseDecimal(x.bigEurToUsd.crossRate);
    const crossed = mulDiv(cents(x.bigEurToUsd.amount), cross.num, cross.den);
    expect(str(crossed)).toBe(x.bigEurToUsd.crossRounded);
    expect(impliedRatio(x.implied.presentmentGbp, x.implied.shopEur)).toBe(x.implied.expected);
  });
  it("субота — рядок НБУ з курсом п'ятниці; ручна таблиця — «курс за 20.11»; розрив 8 днів — без курсу", () => {
    expect(rateFor(G.G3_RATES, "EUR", x.saturday.date)).toMatchObject({ rateDate: x.saturday.rateDate, fallback: x.saturday.fallback, source: "nbu" });
    expect(rateFor(G.G3_MANUAL_RATES, "EUR", x.manualFallback.date)).toMatchObject({ rateDate: x.manualFallback.rateDate, fallback: x.manualFallback.fallback, source: "manual" });
    expect(rateFor(G.G3_MANUAL_RATES, x.gap8Days.currency, x.gap8Days.date)).toBe(x.gap8Days.rate);
    expect(rateFor(G.G3_MANUAL_RATES, "GBP", "2026-11-19")).toMatchObject({ rateDate: "2026-11-12", fallback: true });
  });
  it("JPY: 100 EUR → 17 578; 0,64 EUR → 112 (одне округлення, не 113); 1 000 JPY → 281,80 UAH; KRW в обидва боки", () => {
    expect(cv(x.jpy.eurToJpy.amount, "EUR", "JPY")).toBe(x.jpy.eurToJpy.expected);
    expect(cv(x.jpy.smallEurToJpy.amount, "EUR", "JPY")).toBe(x.jpy.smallEurToJpy.expected);
    expect(cv(x.jpy.jpyToUah.amount, "JPY", "UAH")).toBe(x.jpy.jpyToUah.expected);
    expect(cv(x.krw.eurToKrw.amount, "EUR", "KRW")).toBe(x.krw.eurToKrw.expected);
    expect(cv(x.krw.krwToUah.amount, "KRW", "UAH")).toBe(x.krw.krwToUah.expected);
    expect(cv(x.krw.krwToEur.amount, "KRW", "EUR")).toBe(x.krw.krwToEur.expected);
    expect(cv(x.krw.jpyToKrw.amount, "JPY", "KRW")).toBe(x.krw.jpyToKrw.expected);
    expect(cv(x.krw.krwToJpy.amount, "KRW", "JPY")).toBe(x.krw.krwToJpy.expected);
    // Подвійне округлення (спершу до сотих JPY — 112,50, потім до цілих) дало б 113.
    const pe = rateFor(G.G3_RATES, "EUR", x.date)!.perUnit;
    const pj = rateFor(G.G3_RATES, "JPY", x.date)!.perUnit;
    const jpyHundredths = divRound(cents(x.jpy.smallEurToJpy.amount) * pe.num * pj.den, pe.den * pj.num);
    expect(str(jpyHundredths)).toBe("112.50");
    expect(str(divRound(jpyHundredths, 100n) * 100n)).toBe(x.jpy.smallEurToJpy.twoStep);
  });
});

describe("G4 — обмін валюти", () => {
  it("1 000,00 EUR → 48 650,00 UAH, НБУ 49,4942 → −844,20 UAH; без курсу — відмова", () => {
    expect(fxConversionDifference(G.G4_INPUT.sold, G.G4_INPUT.received, G.G4_INPUT.date, { rates: G.G4_RATES })).toBe(G.G4_EXPECTED.difference);
    expect(fxConversionDifference(G.G4_INPUT.sold, G.G4_INPUT.received, "2026-12-27", { rates: G.G4_RATES })).toBeNull();
  });
});

describe("G5 — рушій собівартості (§6.8)", () => {
  const cogsOf = (r: ReturnType<typeof runCosting>, kind = "sale") => r.effects.filter((e) => e.category === "cogs" && e.kind === kind);
  it("партія 9 + 1 брак × 100 → 9 продажів = 1 000,00 точно", () => {
    const r = runCosting(G.G5_BATCH_9_1);
    expect(cogsOf(r).map((e) => str(-e.amount))).toEqual(G.G5_BATCH_9_1_EXPECTED.sales);
    expect(str(-cogsOf(r).reduce((a, e) => a + e.amount, 0n))).toBe(G.G5_BATCH_9_1_EXPECTED.total);
    expect(str(r.state.knownValue)).toBe(G.G5_BATCH_9_1_EXPECTED.poolValue);
  });
  it("брак складу: з утилізацією 900,00; з ремонтом 1 000,00 і N = 0", () => {
    const w = effectTotals(runCosting(G.G5_DEFECT_WRITEOFF).effects);
    expect([w.inventory_loss, str(-cents(w.cogs!))]).toEqual([G.G5_DEFECT_EXPECTED.writeoff.loss, G.G5_DEFECT_EXPECTED.writeoff.sale]);
    const rp = effectTotals(runCosting(G.G5_DEFECT_REPAIR).effects);
    expect([rp.inventory_loss, rp.inventory_gain, str(-cents(rp.cogs!))]).toEqual([G.G5_DEFECT_EXPECTED.repair.loss, G.G5_DEFECT_EXPECTED.repair.gain, G.G5_DEFECT_EXPECTED.repair.sale]);
    expect(str(cents(rp.inventory_loss!) + cents(rp.inventory_gain!))).toBe(G.G5_DEFECT_EXPECTED.repair.n);
  });
  it("завершення відкриття: 270,00 (10.09) / 180,00 (20.09) / 200,00; пул 8 на 800,00; Σ = 1 450", () => {
    const r = runCosting(G.G5_OPENING_COMPLETION);
    const x = G.G5_OPENING_EXPECTED;
    expect(cogsOf(r).map((e) => [e.orderId, str(-e.amount)])).toEqual([["o2", x.sale2Known]]);
    expect(cogsOf(r, "completion").map((e) => ({ date: e.date, orderId: e.orderId, amount: str(e.amount) }))).toEqual(x.completions);
    expect({ knownQty: r.state.knownQty, knownValue: str(r.state.knownValue) }).toEqual(x.pool);
    const sold = r.effects.filter((e) => e.category === "cogs").reduce((a, e) => a - e.amount, 0n);
    expect(str(sold + r.state.knownValue)).toBe(x.conservation);
  });
  it("від'ємний залишок: завершення 200,00 датою продажу 10.09; пул 8 на 800,00", () => {
    const r = runCosting(G.G5_DEFICIT);
    expect(cogsOf(r)).toHaveLength(0);
    expect(cogsOf(r, "completion").map((e) => ({ date: e.date, amount: str(e.amount) }))).toEqual([G.G5_DEFICIT_EXPECTED.completion]);
    expect({ knownQty: r.state.knownQty, knownValue: str(r.state.knownValue) }).toEqual(G.G5_DEFICIT_EXPECTED.pool);
  });
  it("коригування партії: 60,00 до залишку, −40,00 cogs_adjustment; 1 100 = 400 + 40 + 660", () => {
    const r = runCosting(G.G5_REVALUE_BASIC);
    const x = G.G5_REVALUE_BASIC_EXPECTED;
    expect(str(r.valuations.find((v) => v.kind === "revaluation")!.value)).toBe(x.stock);
    expect(effectTotals(r.effects).cogs_adjustment).toBe(x.cogsAdjustment);
    expect({ knownQty: r.state.knownQty, knownValue: str(r.state.knownValue) }).toEqual(x.pool);
  });
  it("коригування після інших партій: (А) 0 / −100,00; (Б) 7,50 / −92,50; (В) −333,33 / +666,67, пул 16,67", () => {
    const x = G.G5_REVALUE_ABC_EXPECTED;
    const a = runCosting(G.G5_REVALUE_A);
    expect([str(a.valuations.find((v) => v.kind === "revaluation")!.value), effectTotals(a.effects).cogs_adjustment]).toEqual([x.A.stock, x.A.cogsAdjustment]);
    expect({ knownQty: a.state.knownQty, knownValue: str(a.state.knownValue) }).toEqual(x.A.pool);
    const b = runCosting(G.G5_REVALUE_B);
    expect([str(b.valuations.find((v) => v.kind === "revaluation")!.value), effectTotals(b.effects).cogs_adjustment]).toEqual([x.B.stock, x.B.cogsAdjustment]);
    const c = runCosting(G.G5_REVALUE_C);
    expect(str(-cogsOf(c)[0]!.amount)).toBe(x.C.sale);
    expect([str(c.valuations.find((v) => v.kind === "revaluation")!.value), effectTotals(c.effects).cogs_adjustment]).toEqual([x.C.stock, x.C.cogsAdjustment]);
    expect({ knownQty: c.state.knownQty, knownValue: str(c.state.knownValue) }).toEqual(x.C.pool);
  });
  it("рядки партії з extra_cost: Σ цілей = producedTotal точно; ціль ділиться між надходженнями", () => {
    const t = batchLineTargets(G.G5_BATCH_LINES.lines, G.G5_BATCH_LINES.extraCost);
    expect(t.map(str)).toEqual(G.G5_BATCH_LINES.expectedTargets);
    expect(str(t.reduce((a, b) => a + b, 0n))).toBe(G.G5_BATCH_LINES.producedTotal);
    expect(splitTargetByReceipts(t[0]!, [3, 4]).reduce((a, b) => a + b, 0n)).toBe(t[0]);
  });
  it("позиція без списання −420,00 (owner_standard), стан «Факт (за ручною собівартістю)»; повернення (а) 210,00, а не 420,00; (б) 90,00", () => {
    const x = G.G5_NO_WRITEOFF;
    const std = postOrder(G.G5_NO_WRITEOFF_ORDER, "2026-10-10T00:00:00Z");
    const cogs = only(std.entries, "cogs");
    expect(cogs.map((e) => [e.amount, e.details?.basis, e.details?.quantity])).toEqual([[x.expectedCogs, x.entryBasis, x.quantity]]);
    expect(std.order.components.cogs).toMatchObject({ state: x.state, basis: x.basis });
    // Картка показує основу поруч зі значенням (§2.6): owner_standard → «Факт (за ручною собівартістю)».
    expect(orderCard(journalFrom([std]), std.order.orderId, "UAH", ctx1).cogs).toMatchObject({ state: x.state, basis: x.basis, writtenOff: { converted: x.expectedCogs } });
    // Позиція зі складу — основа valuation; змішане замовлення — owner_standard (частина факту — дані власника).
    expect(postOrder(G.G1_ORDER_NO_RETURN, "2026-10-10T00:00:00Z").order.components.cogs).toMatchObject({ state: "actual", basis: "valuation" });
    expect(postOrder(G.G5_MIXED_BASIS_ORDER, "2026-10-10T00:00:00Z").order.components.cogs).toMatchObject({ state: "actual", basis: "owner_standard" });
    const a = runCosting(G.G5_RETURN_A, { orderStandards: G.G5_RETURN_A_STANDARDS });
    const ex = G.G5_RETURN_A_EXPECTED;
    const totals = effectTotals(a.effects);
    expect(totals.cogs_return).toBe(ex.cogsReturn);
    expect(totals.cogs).toBe(ex.resale);
    expect(str(cents(ex.stdcogs) + cents(totals.cogs_return!) + cents(totals.cogs!))).toBe(ex.total);
    const b = runCosting(G.G5_RETURN_B);
    const o1 = b.effects.filter((e) => e.orderId === "o1" && (e.category === "cogs" || e.category === "cogs_return")).reduce((s, e) => s + e.amount, 0n);
    expect(str(o1)).toBe(G.G5_RETURN_B_EXPECTED.orderCogs);
    expect(b.state.knownQty - 0).toBe(G.G5_RETURN_B_EXPECTED.pool.knownQty);
    expect(str(b.state.knownValue)).toBe(G.G5_RETURN_B_EXPECTED.pool.knownValue);
  });
  it("пошкоджене повернення — однаково в обох записах етапу 5: собівартість замовлення −100,00", () => {
    const split = runCosting(G.G5_DAMAGED_SPLIT);
    const plain = runCosting(G.G5_DAMAGED_PLAIN);
    for (const r of [split, plain]) {
      const t = effectTotals(r.effects);
      expect(t.cogs_return).toBe(G.G5_DAMAGED_EXPECTED.cogsReturn);
      expect(str(cents(t.cogs!) + cents(t.cogs_return!))).toBe(G.G5_DAMAGED_EXPECTED.orderCogs);
    }
    expect(split.effects.map((e) => [e.category, e.amount])).toEqual(plain.effects.map((e) => [e.category, e.amount]));
    expect(split.state).toEqual(plain.state);
  });
  it("вихід тестового замовлення → inventory_loss test_order; скасована партія → inventory_loss production_cancelled (R6)", () => {
    const t = runCosting(G.G5_TEST_ORDER);
    expect(t.effects.filter((e) => e.category === "inventory_loss").map((e) => [str(e.amount), e.kind])).toEqual([[G.G5_TEST_ORDER_EXPECTED.inventoryLoss, G.G5_TEST_ORDER_EXPECTED.kind]]);
    const b = G.G5_CANCELLED_BATCH;
    const exp = postBatchWriteOff(b, []);
    if (!exp.ok) throw new Error("expected ok");
    expect(exp.entries.map((e) => ({ category: e.category, amount: e.amount, currency: e.currency, recognizedOn: e.recognizedOn, fxOn: e.fxOn, orderId: e.orderId, details: e.details }))).toEqual([
      { category: "inventory_loss", amount: b.expectedEntry, currency: b.currency, recognizedOn: b.date, fxOn: b.date, orderId: null, details: b.expectedDetails },
    ]);
    // «іншим шляхом ця категорія недоступна» (§6.7, §10.1): звичайна витрата inventory_loss без партії — відмова.
    expect(postExpense({ id: "x", versions: [{ version: 1, category: "inventory_loss", amount: b.amount, currency: "UAH", date: b.date, enteredAt: b.enteredAt }] }, [])).toEqual({ ok: false, error: "categoryNotAllowed", category: "inventory_loss" });
    // Рядок партії — лише inventory_loss.
    expect(postExpense({ id: "y", productionBatchId: b.productionBatchId, versions: [{ version: 1, category: "advertising", amount: b.amount, currency: "UAH", date: b.date, enteredAt: b.enteredAt }] }, []).ok).toBe(false);
  });
});

describe("G6 — партнер після виплати", () => {
  it("баланс −11,70 після повного повернення; наступне +8,00 → −3,70, до виплати 0", () => {
    for (const [day, x] of Object.entries(G.G6_EXPECTED)) {
      const r = partnerLedger(G.G6_ORDERS, G.G6_PAYOUTS, day);
      expect({ day, balance: r.balance, payable: r.payable, o1: r.orders.find((o) => o.orderId === "o1")!.state }).toEqual({ day, ...x });
    }
  });
});

describe("G7 — розподіл витрати за періодом послуги", () => {
  it("1 000,00 UAH за 01–30.11 → 10 × 33,34 + 20 × 33,33", () => {
    const parts = allocateDaily(cents(G.G7_INPUT.amount), G.G7_INPUT.from, G.G7_INPUT.to);
    expect(parts).toHaveLength(30);
    expect(parts.slice(0, 10).every((p) => str(p.amount) === G.G7_EXPECTED.first10)).toBe(true);
    expect(parts.slice(10).every((p) => str(p.amount) === G.G7_EXPECTED.rest20)).toBe(true);
    expect(str(parts.reduce((a, p) => a + p.amount, 0n))).toBe(G.G7_EXPECTED.total);
  });
});

describe("G8 / G8b — немає даних; відправлено поза застосунком без трек-номера", () => {
  it("G8: incomplete — прибуток не показано («собівартість, комісії»), поза фактом і прогнозом; у JSON null, ніде 0", () => {
    const x = G.ORDER_EXPECTED.G8;
    const p = postOrder(G.G8_ORDER, "2026-10-10T00:00:00Z");
    expect(p.order.state).toBe(x.state);
    expect(p.order.missing).toEqual(x.missing);
    const j = journalFrom([p]);
    const card = orderCard(j, G.G8_ORDER.id, "UAH", ctx1);
    expect(card.profit.value).toBe(x.cardProfit);
    expect(card.profit.missing).toEqual(x.missing);
    const r = pnlReport(j, { ...OCT, currency: "EUR", ctx: ctx1 });
    expect([r.profit.fact, r.profit.forecast]).toEqual([x.profitFact, x.profitForecast]);
    expect(r.notCounted.orders).toBe(x.notCountedOrders);
    expect(r.turnover).toBe(x.turnoverEur);
    expect(r.notCounted.turnover).toBe(x.turnoverEur);
    expect(JSON.parse(JSON.stringify({ profit: card.profit.value, fact: r.profit.fact }))).toEqual({ profit: null, fact: null });
  });
  it("G8b: таблиця власника → preliminary; без таблиці й середньої → incomplete; «Без витрат на доставку» → final", () => {
    const x = G.ORDER_EXPECTED.G8b;
    const at = "2026-10-10T00:00:00Z";
    const t = postOrder(G.G8B_ORDER_TABLE, at);
    expect(t.order.components.shipping_cost).toMatchObject({ state: "missing", reason: "no_waybill", hasForecast: true, basis: "owner_table" });
    expect(t.order.components.fees?.state).toBe("zero_confirmed");
    expect(t.order.components.packaging?.state).toBe("not_applicable");
    expect(t.order.state).toBe(x.table);
    expect(postOrder(G.G8B_ORDER_NOTHING, at).order.state).toBe(x.nothing);
    expect(postOrder(G.G8B_ORDER_OWNER_MARK, at).order.state).toBe(x.ownerMark);
  });
});

describe("G9 — імпорт рахунків", () => {
  const x = G.G9_EXPECTED;
  const lines = G.G9_FILE_LINES;
  const ictx: ImportContext = { candidates: G.G9_CANDIDATES, orders: G.G9_ORDER_INFO, fx: { rates: G.G9_RATES } };
  const pickEntry = (e: RefEntry) => ({ category: e.category, amount: e.amount, recognizedOn: e.recognizedOn, fxOn: e.fxOn });
  const m = (i: number) => matchWaybill(lines[i]!.number, "nova_post", G.G9_CANDIDATES);
  it("зіставлення, нормалізація, пошкоджене число, скасоване відправлення, незіставлене → нерозподілене", () => {
    expect(m(0).code).toBe(x.a.code);
    expect(amountVsForecast(cents("540.00"), cents("520.00"))).toBe(x.a.amountVsForecast);
    expect(m(1).code).toBe(x.b.code);
    expect(amountVsForecast(cents("700.00"), cents("500.00"))).toBe(x.b.amountVsForecast);
    expect(m(2).code).toBe(x.c.code);
    expect(duplicatesInFile(lines)).toEqual(x.d.duplicateIndices);
    expect(m(4).code).toBe(x.e.code);
    expect(m(5)).toMatchObject({ code: x.f.code, norm: x.f.norm });
    expect(matchWaybill(x.g.raw, "nova_post", G.G9_CANDIDATES).code).toBe(x.g.code);
    expect(normalizeWaybill(20450000000011)).toEqual({ ok: true, norm: "20450000000011", cls: "ua14" });
    expect(normalizeWaybill(2.0451e13 + 0.5)).toEqual({ ok: false, error: "invalid_number" });
  });
  it("(и) підсумок 2 000,00 → специфікація 1 990,00: сторно підсумку + рядки, invoice_total_mismatch 10,00 (через реєстр імпорту)", () => {
    const y = x.totalThenSpec;
    const t = saveImport(emptyImportLedger(), G.G9_DOC_1234_TOTAL, ictx);
    if (!t.ok) throw new Error(t.error);
    expect(t.summary).toMatchObject({ lines: 0, posting: true, controlTotal: null, replaces: null });
    expect(t.ledger.entries.map(pickEntry)).toEqual([y.totalEntry]);
    expect(t.ledger.entries[0]!.amount).toBe(x.i.totalOnlyEntry);
    const sp = saveImport(t.ledger, G.G9_DOC_1234_SPEC, ictx);
    if (!sp.ok) throw new Error(sp.error);
    expect(sp.document.numberNorm).toBe(y.numberNorm);
    // Крок 3: «Специфікація замінить проведений підсумок рахунку № 1234: −2 000,00 грн, +1 990,00 грн за 3 рядками».
    expect(previewImport(t.ledger, G.G9_DOC_1234_SPEC, ictx)).toEqual({ refusal: null, summary: sp.summary });
    expect(sp.summary.replaces).toEqual(y.replaces);
    expect(sp.summary.controlTotal).toEqual(y.controlTotal);
    expect(sp.discrepancies.map((d) => [d.type, d.amount])).toEqual([["invoice_total_mismatch", x.i.mismatch]]);
    const rev = sp.ledger.entries.find((e) => e.reversesKey === t.ledger.entries[0]!.key)!;
    expect({ amount: rev.amount, recognizedOn: rev.recognizedOn, fxOn: rev.fxOn }).toEqual(y.reversal);
    // У журналі періоду лишилося 0 (підсумок сторновано); рядки специфікації — факти замовлень.
    expect(activeEntries(sp.ledger.entries)).toEqual([]);
    expect(activeOrderLines(sp.ledger).map((l) => l.amount)).toEqual(x.i.specLines);
    expect(sp.ledger.documents.map((d) => [d.id, d.posting])).toEqual([[G.G9_DOC_1234_TOTAL.id, false], [G.G9_DOC_1234_SPEC.id, true]]);
    expect(invoiceTotalMismatch(x.i.specLines, x.i.controlTotal)).toBe(x.i.mismatch);
  });
  it("(і) той самий набір рядків під іншим номером → similar_document, збереження заблоковано; «окремий» з причиною → possible_double_billing", () => {
    const t = saveImport(emptyImportLedger(), G.G9_DOC_1234_TOTAL, ictx);
    if (!t.ok) throw new Error(t.error);
    const sp = saveImport(t.ledger, G.G9_DOC_1234_SPEC, ictx);
    if (!sp.ok) throw new Error(sp.error);
    const blocked = saveImport(sp.ledger, G.G9_DOC_1235, ictx);
    expect(blocked.ok ? null : [blocked.error, blocked.existingDocumentId]).toEqual([x.similar.error, x.similar.existingDocumentId]);
    expect(previewImport(sp.ledger, G.G9_DOC_1235, ictx).refusal).toEqual({ error: x.similar.error, existingDocumentId: x.similar.existingDocumentId });
    expect(saveImport(sp.ledger, G.G9_DOC_1235, ictx, { confirmSeparate: { reason: " " } }).ok).toBe(false);
    const ok = saveImport(sp.ledger, G.G9_DOC_1235, ictx, { confirmSeparate: { reason: "Окремий рахунок за інший період" } });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.discrepancies.filter((d) => d.type === "possible_double_billing")).toHaveLength(x.similar.doubleBilling);
    expect(similarDocument(lines.slice(0, 2), lines.slice(0, 2).map((l) => ({ ...l })))).toBe(true);
    expect(similarDocument(lines.slice(0, 2), [lines[2]!])).toBe(false);
  });
  it("рахунок № 7001 через реєстр: крок 3 («Без номера: 1, 40,00», «Разом» — лише звірка), (в)(д)(є)(к) → shipping_unallocated R4, решта — рядки замовлень", () => {
    const f = x.file;
    const r = saveImport(emptyImportLedger(), G.G9_DOC_FILE, ictx);
    if (!r.ok) throw new Error(r.error);
    expect(r.summary).toEqual(f.summary);
    expect(previewImport(emptyImportLedger(), G.G9_DOC_FILE, ictx)).toEqual({ refusal: null, summary: f.summary });
    expect(r.discrepancies.map((d) => d.type).sort()).toEqual(f.discrepancyTypes);
    expect(r.discrepancies.find((d) => d.type === "amount_vs_forecast")).toMatchObject(f.amountVsForecast);
    expect(r.discrepancies.find((d) => d.type === "shipping_loss")).toMatchObject(f.shippingLoss);
    const rowOf = (e: RefEntry) => Number(String(e.details?.lineId).split(":").at(-1));
    expect(r.ledger.entries.map((e) => ({ row: rowOf(e), ...pickEntry(e) }))).toEqual(f.unallocated);
    // (в) незіставлене …99 і (к) зберігання без номера — нерозподілені записи, вартість не губиться.
    expect(r.ledger.entries.find((e) => rowOf(e) === 4)!.amount).toBe(x.c.unallocatedEntry);
    expect(r.ledger.entries.find((e) => rowOf(e) === 8)!.amount).toBe(x.storage.unallocatedEntry);
    expect(r.ledger.orderLines.map((l) => ({ orderId: l.orderId, waybillId: l.waybillId, chargeType: l.chargeType, amount: l.amount }))).toEqual(f.orderLines);
    // Σ проведеного (нерозподілене + замовлення) = Σ рядків = «Сума за рахунком»; «Разом» не проводиться.
    const posted = -r.ledger.entries.reduce((a, e) => a + cents(e.amount), 0n) + r.ledger.orderLines.reduce((a, l) => a + cents(l.amount), 0n);
    expect(str(posted)).toBe(G.G9_DOC_FILE.total!.amount);
  });
  it("повтор тих самих байтів → відмова; той самий номер і вид, інші байти → відмова без «Замінити»; заміна → у журналі лише записи нової версії", () => {
    const y = x.replacement;
    const r1 = saveImport(emptyImportLedger(), G.G9_DOC_FILE, ictx);
    if (!r1.ok) throw new Error(r1.error);
    const again = saveImport(r1.ledger, G.G9_DOC_FILE_AGAIN, ictx);
    expect(again.ok ? null : { error: again.error, existingDocumentId: again.existingDocumentId }).toEqual(x.sameBytes);
    const other = saveImport(r1.ledger, G.G9_DOC_FILE_V2, ictx);
    expect(other.ok ? null : { error: other.error, existingDocumentId: other.existingDocumentId }).toEqual(x.sameNumberOtherBytes);
    expect(saveImport(r1.ledger, G.G9_DOC_FILE_V2, ictx, { replace: { reason: "" } }).ok).toBe(false);
    // (з) кредит-нота до того самого номера — окремий вид, проводить свій рядок (R2), заміна рахунку її не чіпає.
    const cn = saveImport(r1.ledger, G.G9_DOC_CREDIT, ictx);
    if (!cn.ok) throw new Error(cn.error);
    expect(cn.discrepancies).toEqual([]);
    const v2 = saveImport(cn.ledger, G.G9_DOC_FILE_V2, ictx, { replace: { reason: "Перевізник виправив рахунок" } });
    if (!v2.ok) throw new Error(v2.error);
    expect(v2.document.version).toBe(y.version);
    expect(v2.ledger.documents.find((d) => d.id === G.G9_DOC_FILE.id)).toMatchObject({ status: y.oldStatus, posting: false, replaceReason: "Перевізник виправив рахунок" });
    expect(v2.ledger.entries.filter((e) => e.reversesKey !== null).map((e) => e.amount)).toEqual(y.reversedUnallocated);
    expect([...new Set(activeEntries(v2.ledger.entries).map((e) => e.details?.documentId))]).toEqual(y.activeEntryDocuments);
    expect(new Set(activeOrderLines(v2.ledger).map((l) => l.documentId))).toEqual(new Set([G.G9_DOC_FILE_V2.id, G.G9_DOC_CREDIT.id]));
    // Замовлення o-a: перша версія (R3) сторнована датою й курсом оригіналу; чинні — нова версія (R2) і кредит (R2).
    const p = postOrder({ ...G.G9_ORDER_A, invoiceLines: orderInvoiceLines(v2.ledger, "o-a") }, "2026-11-30T00:00:00Z");
    const ship = only(p.entries, "shipping_cost");
    expect(activeEntries(ship).map(pickEntry).sort((a, b) => (a.recognizedOn < b.recognizedOn ? -1 : 1))).toEqual(y.orderA);
    const first = ship.find((e) => e.key === `inv:${G.G9_DOC_FILE.id}:1:2:m1`)!;
    const firstRev = ship.find((e) => e.reversesKey === first.key)!;
    expect({ amount: first.amount, reversal: firstRev.amount, recognizedOn: firstRev.recognizedOn, fxOn: firstRev.fxOn, isLateCompletion: first.isLateCompletion }).toEqual(y.orderAReversed);
    expect(p.order.components.shipping_cost?.state).toBe("actual");
    // Сторновано все з першої версії → складник повертається до прогнозу.
    const gone = postOrder({ ...G.G9_ORDER_A, invoiceLines: orderInvoiceLines(v2.ledger, "o-a").filter((l) => l.documentId === G.G9_DOC_FILE.id) }, "2026-11-30T00:00:00Z");
    expect(gone.order.components.shipping_cost).toMatchObject({ state: "forecast", basis: "carrier_reported" });
    expect(activeEntries(only(gone.entries, "shipping_cost"))).toEqual([]);
  });
  it("(г) крок 3: дубль (а) у файлі → «Дублікати: 1» (обидва рядки зберігаються до рішення власника)", () => {
    const pv = previewImport(emptyImportLedger(), G.G9_DOC_DUPLICATE, ictx);
    expect(pv.refusal).toBeNull();
    expect({ duplicates: pv.summary.duplicates, lines: pv.summary.lines }).toEqual(x.duplicateFile);
    const r = saveImport(emptyImportLedger(), G.G9_DOC_DUPLICATE, ictx);
    if (!r.ok) throw new Error(r.error);
    expect(r.discrepancies.filter((d) => d.type === "duplicate_in_file").map((d) => d.lineId)).toEqual([`${G.G9_DOC_DUPLICATE.id}:1:3`]);
  });
  it("пізніше ручне зіставлення (в) і «Прийняти як витрату замовлення» (д): сторно нерозподіленого + рядок замовлення m2", () => {
    const r = saveImport(emptyImportLedger(), G.G9_DOC_FILE, ictx);
    if (!r.ok) throw new Error(r.error);
    const lineC = `${G.G9_DOC_FILE.id}:1:4`;
    const lineD = `${G.G9_DOC_FILE.id}:1:5`;
    const m1 = matchImportLine(r.ledger, lineC, { orderId: "o-c", waybillId: "wb-c" }, "2026-11-15T09:00:00Z");
    const m2 = matchImportLine(m1, lineD, { orderId: "o-d", waybillId: "wb-d" }, "2026-11-16T09:00:00Z");
    expect(activeEntries(m2.entries).map((e) => e.amount)).toEqual(["-50.00", "-40.00"]);
    expect(m2.entries.filter((e) => e.reversesKey !== null).map((e) => [e.reversesKey, e.amount, e.recognizedOn])).toEqual([
      [`inv:${lineC}:m1`, "300.00", "2026-11-10"],
      [`inv:${lineD}:m1`, "350.00", "2026-11-10"],
    ]);
    expect(activeOrderLines(m2, "o-c").map((l) => [l.id, l.matchVersion, l.importedAt, l.amount])).toEqual([[lineC, 2, "2026-11-15T09:00:00Z", "300.00"]]);
    const p = postOrder({ ...G.G9_ORDER_A, id: "o-c", waybills: [{ ...G.G9_ORDER_A.waybills[0]!, id: "wb-c" }], invoiceLines: orderInvoiceLines(m2, "o-c") }, "2026-11-30T00:00:00Z");
    expect(only(p.entries, "shipping_cost").map((e) => [e.key, e.amount, e.recognizedOn, e.isLateCompletion])).toEqual([[`inv:${lineC}:m2`, "-300.00", "2026-10-05", true]]);
    expect(() => matchImportLine(m2, lineC, { orderId: "o-x", waybillId: "wb-x" }, "2026-11-17T09:00:00Z")).toThrow(RangeError);
  });
  it("(ї) вага, (й) збиткова доставка, (к) зберігання без номера, (л) ручна вартість існує", () => {
    expect(weightMismatch(x.weight.charged, x.weight.shipment)).toBe(x.weight.mismatch);
    expect(weightMismatch(2150, 2000)).toBe(false);
    const paid = convert(cents(x.loss.paidEur), "EUR", "UAH", "2026-10-05", { rates: G.G9_RATES })!;
    expect(str(paid)).toBe(x.loss.paidUah);
    const loss = shippingLoss(cents(x.loss.actual), paid);
    expect([str(loss.loss), loss.flagged]).toEqual([x.loss.loss, x.loss.flagged]);
    expect(manualCostExists({ duties: true }, "customs_duty")).toBe(true);
    expect(manualCostExists({ duties: true }, "delivery")).toBe(false);
  });
  it("(з) кредит −20,00 пізнішим документом → R2 (датою події, не визнання)", () => {
    const order = {
      ...G.G1_ORDER_NO_RETURN,
      id: "ord-credit",
      invoiceLines: [
        { ...G.G1_ORDER.invoiceLines[0]!, importedAt: "2026-10-06T09:00:00Z" },
        { id: "il-credit", waybillId: "wb-g1", documentId: "cn-1", chargeType: "credit" as const, amount: "-20.00", currency: "UAH", serviceDate: "2026-11-03", importedAt: "2026-11-04T09:00:00Z" },
      ],
    };
    const p = postOrder(order, "2026-11-30T00:00:00Z");
    const credit = p.entries.find((e) => e.key === "inv:il-credit:m1")!;
    expect(credit).toMatchObject({ amount: "20.00", recognizedOn: "2026-11-03", fxOn: "2026-11-03", isLateCompletion: false });
  });
});

describe("G10 / G10b / G10c — chargeback і повернення без позицій", () => {
  const at = "2026-11-30T00:00:00Z";
  it("G10: −129,00 і −15,00 датою 12.11; база партнера 117 → 0, винагороду скасовано; + повернення → перевірка", () => {
    const x = G.ORDER_EXPECTED.G10;
    const p = postOrder(G.G10_ORDER, at);
    expect(only(p.entries, "chargeback_loss").map((e) => [e.amount, e.recognizedOn])).toEqual([[x.chargebackLoss, x.recognizedOn]]);
    expect(only(p.entries, "chargeback_fees").map((e) => [e.amount, e.recognizedOn])).toEqual([[x.chargebackFee, x.recognizedOn]]);
    expect(p.order.partnerEvents.map((e) => e.kind)).toEqual(["accrual", "cancellation"]);
    expect(str(-p.order.partnerEvents[1]!.amount)).toBe(x.partnerCancellation);
    expect(str(p.order.partnerEvents.reduce((a, e) => a + e.amount, 0n))).toBe(x.partnerNet);
    expect(p.order.flags).not.toContain(x.overlapFlag);
    expect(postOrder(G.G10_ORDER_WITH_REFUND, at).order.flags).toContain(x.overlapFlag);
  });
  it("G10b: 49,50 = 41,59 / 7,91; типово обидва — chargeback_loss; «ПДВ зменшується» — сторно податку; база 8,41 → 0,84", () => {
    const x = G.ORDER_EXPECTED.G10b;
    const d = postOrder(G.G10B_ORDER, at);
    expect(only(d.entries, "chargeback_loss").map((e) => e.amount)).toEqual(x.default.loss);
    expect(only(d.entries, "chargeback_loss")[1]!.details?.taxPart).toBe(true);
    expect(str(-d.order.partnerEvents[1]!.amount)).toBe(x.default.partnerAdjustment);
    expect(str(d.order.partnerEvents.reduce((a, e) => a + e.amount, 0n))).toBe(x.default.partnerNet);
    const v = postOrder(G.G10B_ORDER_VAT, at);
    expect(only(v.entries, "chargeback_loss").map((e) => e.amount)).toEqual([x.vat.loss]);
    expect(v.entries.find((e) => e.key === "cb:dsp-g10b:tax:v1")).toMatchObject({ category: "tax_collected_memo", amount: x.vat.taxMemoReversal });
    const c = postOrder(G.G10B_ORDER_CANCEL, at);
    expect(str(c.order.partnerEvents.reduce((a, e) => a + e.amount, 0n))).toBe(x.cancel.partnerNet);
  });
  it("G10c: refund_adjustment −129,00; база max(0, min(117; 117 − 129)) = 0 → скасування", () => {
    const x = G.ORDER_EXPECTED.G10c;
    const p = postOrder(G.G10C_ORDER, at);
    expect(only(p.entries, "refund_adjustment").map((e) => e.amount)).toEqual([x.refundAdjustment]);
    expect(str(partnerBase(G.G10C_ORDER.sales))).toBe(x.partnerBase);
    expect(str(p.order.partnerEvents.reduce((a, e) => a + e.amount, 0n))).toBe(x.partnerNet);
    expect(p.order.partnerEvents.at(-1)!.kind).toBe("cancellation");
  });
});

describe("G11 / G11b — закриття місяця, пізній запис, сторно в іншій валюті", () => {
  const closures = G.G11_CLOSURES;
  it("пізнє повернення: recognized_on 06.11, «Пізній запис», fx_on 31.10; I12 — нічого в закритий місяць після закриття", () => {
    const p = postOrder(G.G11_ORDER, "2026-11-30T00:00:00Z", { closures });
    const ret = p.entries.find((e) => e.key === "sale:s-g11-ret:net")!;
    expect({ recognizedOn: ret.recognizedOn, originalOn: ret.originalOn, fxOn: ret.fxOn, isLate: ret.isLate }).toEqual(G.G11_EXPECTED.lateRefund);
    expect(p.order.state).toBe("final");
    const adj = p.entries.find((e) => e.category === "partner_commission" && e.details?.event === "adjustment")!;
    expect([adj.recognizedOn, adj.fxOn, adj.isLate]).toEqual(["2026-11-06", "2026-10-31", true]);
    // До закриття всі записи жовтня проведено датами жовтня; після — жоден не потрапив у жовтень.
    const before = postOrder(G.G11_ORDER, "2026-11-04T00:00:00Z", { closures });
    const lateOnes = p.entries.filter((e) => !before.entries.some((b) => b.key === e.key));
    expect(lateOnes.length).toBeGreaterThan(0);
    for (const e of lateOnes) expect(e.recognizedOn.startsWith("2026-10")).toBe(false);
  });
  it("«Чистий прибуток» лише для жовтня; ручна реклама датою 20.10, введена 06.11 → відмова", () => {
    expect(profitLabel("2026-10-01", "2026-10-31", closures, "2026-11-30T00:00:00Z")).toBe(G.G11_EXPECTED.labelOctober);
    expect(profitLabel("2026-10-01", "2026-11-30", closures, "2026-11-30T00:00:00Z")).toBe(G.G11_EXPECTED.labelOctNov);
    expect(profitLabel("2026-10-01", "2026-10-31", [{ ...closures[0], allConfirmedWithTaxes: false }], "2026-11-30T00:00:00Z")).toBe("profit_after_costs");
    expect(postExpense(G.G11_LATE_AD, closures)).toEqual(G.G11_EXPECTED.lateAd);
    expect(manualEntryAllowed("2026-10-20", "2026-11-06T09:00:00Z", closures)).toBe(false);
    expect(manualEntryAllowed("2026-10-20", "2026-11-04T09:00:00Z", closures)).toBe(true);
  });
  describe("знімки закритого місяця (§3.4, §13.1, §2.6)", () => {
    const x = G.G11_EXPECTED;
    const sx = x.snapshots;
    const exp = postExpense(G.G11_SERVICES_EXPENSE, []);
    if (!exp.ok) throw new Error("expected ok");
    const journalAt = (at: string, cl: readonly RefMonthClosure[] = closures) => journalFrom([postOrder(G.G11_ORDER, at, { closures: cl })], exp.entries);
    const AT = x.addedCurrency.at;
    const close = closeMonth(journalAt(sx.closedAt), { month: sx.month, closedAt: sx.closedAt, displayCurrencies: sx.displayCurrencies, ctx: ctx1, allConfirmedWithTaxes: true });
    if (!close.ok) throw new Error(JSON.stringify(close.blockers));
    const later: ReportSources = { journal: journalAt(AT), ctx: { rates: G.G11_RATES_LATER }, snapshots: close.snapshots, closures, at: AT };

    it("закриття 05.11 → по знімку на кожну валюту показу (денні рядки = звіт місяця)", () => {
      expect(close.closure).toEqual(closures[0]);
      expect(close.snapshots.map((s) => [s.currency, s.version, s.report.profit.fact, s.report.turnover])).toEqual([
        ["UAH", sx.UAH.version, sx.UAH.profit, sx.UAH.turnover],
        ["EUR", sx.EUR.version, sx.EUR.profit, sx.EUR.turnover],
      ]);
      for (const snap of close.snapshots) {
        expect(snap.days).toHaveLength(31);
        expect(str(snap.days.reduce((a, d) => a + cents(d.factValue), 0n))).toBe(snap.report.raw.factValue);
        for (const [k, v] of Object.entries(snap.report.columns.total)) expect(str(snap.days.reduce((a, d) => a + cents(d.columns.total[k] ?? "0.00"), 0n))).toBe(v);
      }
    });
    it("звіт жовтня = знімок у кожній валюті показу — після пізнього повернення 06.11 і курсу, отриманого пізніше", () => {
      for (const cur of sx.displayCurrencies) {
        const r = monthReport(sx.month, cur, later);
        expect([r.source, r.liveNotSnapshot, r.version]).toEqual(["snapshot", false, 1]);
        expect(r.report).toEqual(close.snapshots.find((s) => s.currency === cur)!.report);
      }
      expect(monthReport(sx.month, "EUR", later).report.profit.fact).toBe(sx.EUR.profit);
      // Живий перерахунок EUR змінився б через курс 10.10, отриманий після закриття; знімок — ні.
      expect(pnlReport(later.journal, { ...OCT, currency: "EUR", ctx: later.ctx }).profit.fact).toBe(sx.EUR.liveWouldBe);
      // Пізнє повернення проведено в листопад (I12): жовтень наживо у UAH теж не змінився.
      expect(pnlReport(later.journal, { ...OCT, currency: "UAH", ctx: later.ctx }).profit.fact).toBe(sx.UAH.profit);
    });
    it("валюта, додана до показу після закриття (USD), — «Живий перерахунок, не знімок»; відкритий листопад — наживо", () => {
      const a = x.addedCurrency;
      const usd = monthReport(sx.month, a.currency, later);
      expect({ source: usd.source, liveNotSnapshot: usd.liveNotSnapshot, profit: usd.report.profit.fact }).toEqual({ source: a.source, liveNotSnapshot: a.liveNotSnapshot, profit: a.profit });
      for (const cur of ["EUR", "UAH"] as const) {
        const nov = monthReport("2026-11", cur, later);
        expect([nov.source, nov.liveNotSnapshot, nov.report.profit.fact]).toEqual(["live", false, x.november[cur]]);
      }
    });
    it("діапазон жовтень–листопад = знімок жовтня + живий листопад (I15), зокрема неповні місяці", () => {
      const r = rangeReport("2026-10-01", "2026-11-30", "EUR", later);
      expect(r.parts.map((p) => [p.month, p.source, p.liveNotSnapshot])).toEqual([["2026-10", "snapshot", false], ["2026-11", "live", false]]);
      expect(r.profit.fact).toBe(x.octNovEur);
      const oct = monthReport("2026-10", "EUR", later).report.columns.total;
      const nov = monthReport("2026-11", "EUR", later).report.columns.total;
      for (const k of new Set([...Object.keys(oct), ...Object.keys(nov)])) expect(r.columns.total[k] ?? "0.00").toBe(str(cents(oct[k] ?? "0.00") + cents(nov[k] ?? "0.00")));
      // Неповний діапазон 05.10–06.11: денні рядки знімка жовтня + живі дні листопада.
      const part = rangeReport("2026-10-05", "2026-11-06", "EUR", later);
      expect(part.profit.fact).toBe(x.octNovEur);
      expect(rangeReport("2026-10-06", "2026-10-31", "EUR", later).profit.fact).toBe("-6.19");
      expect(rangeReport("2026-10-01", "2026-11-30", "USD", later).parts.map((p) => p.liveNotSnapshot)).toEqual([true, false]);
    });
    it("повторне відкриття → наживо; наступне закриття — нова версія знімка, стара зберігається", () => {
      const ro = x.reopen;
      const reopened: RefMonthClosure[] = [{ ...closures[0], reopenedAt: ro.reopenedAt }];
      const between = { ...later, closures: reopened, at: "2026-11-12T00:00:00Z" };
      expect(monthReport(sx.month, "EUR", between)).toMatchObject({ source: "live", liveNotSnapshot: false });
      expect(monthReport(sx.month, "EUR", between).report.profit.fact).toBe(ro.liveEur);
      const again = closeMonth(journalAt(ro.reclosedAt, reopened), { month: sx.month, closedAt: ro.reclosedAt, displayCurrencies: sx.displayCurrencies, ctx: later.ctx, allConfirmedWithTaxes: true, previous: close.snapshots });
      if (!again.ok) throw new Error(JSON.stringify(again.blockers));
      const all = [...close.snapshots, ...again.snapshots];
      const cl2 = [...reopened, again.closure];
      const r = monthReport(sx.month, "EUR", { ...later, snapshots: all, closures: cl2 });
      expect([r.source, r.version, r.report.profit.fact]).toEqual(["snapshot", ro.versionEur, ro.profitEurV2]);
      // Версія 1 зберігається й показується для моменту до повторного відкриття.
      expect(monthReport(sx.month, "EUR", { ...later, snapshots: all, closures: cl2, at: "2026-11-08T00:00:00Z" })).toMatchObject({ source: "snapshot", version: 1 });
      expect(all.filter((s) => s.currency === "EUR").map((s) => s.version)).toEqual([1, 2]);
    });
    it("закриття блокують: неостаточне замовлення, запис без курсу для валюти показу, неминулий місяць", () => {
      const pre = journalFrom([postOrder(G.G1_ORDER, G.G1_AS_OF_BEFORE_IMPORT)]);
      const blocked = closeMonth(pre, { month: "2026-10", closedAt: "2026-11-08T10:00:00Z", displayCurrencies: ["UAH", "USD"], ctx: ctx1, allConfirmedWithTaxes: true });
      expect(blocked.ok ? [] : blocked.blockers.map((b) => b.code)).toEqual(["order_not_final", "missing_rate"]);
      expect(closeMonth(journalAt(AT), { month: "2026-11", closedAt: AT, displayCurrencies: ["UAH"], ctx: ctx1, allConfirmedWithTaxes: true })).toMatchObject({ ok: false, blockers: [{ code: "month_not_past" }] });
    });
  });
  it("G11b: сторно датою й курсом 20.10 → жовтень −4 365,00, листопад 0; фантомних +30,00 немає (I14)", () => {
    const r = postExpense(G.G11B_EXPENSE, []);
    if (!r.ok) throw new Error("expected ok");
    const x = G.G11B_EXPECTED;
    const [first, rev, second] = r.entries;
    expect(conv(first!, "UAH")).toBe(x.first);
    expect([conv(rev!, "UAH"), rev!.recognizedOn, rev!.fxOn]).toEqual([x.reversal, x.reversalOn, x.reversalFxOn]);
    expect(conv(second!, "UAH")).toBe(x.second);
    const j: RefJournal = { entries: r.entries, orders: [], forecasts: [] };
    expect(pnlReport(j, { ...OCT, currency: "UAH", ctx: ctx1 }).profit.fact).toBe(x.october);
    expect(pnlReport(j, { ...NOV, currency: "UAH", ctx: ctx1 }).profit.fact).toBe(x.november);
    for (const cur of ["UAH", "EUR"]) expect(cents(conv(first!, cur)!) + cents(conv(rev!, cur)!)).toBe(0n);
  });
});

describe("G12 — дата Києва", () => {
  it("30.10.2026 23:30 UTC = 31.10 Київ; передано 02.11 → листопад; повернення 05.11 — листопад", () => {
    const x = G.ORDER_EXPECTED.G12;
    expect(kyivDate("2026-10-30T23:30:00Z")).toBe(x.placedOn);
    expect(kyivDate("2026-10-24T21:30:00Z")).toBe("2026-10-25"); // ще літній час (UTC+3)
    expect(kyivDate("2026-10-25T21:30:00Z")).toBe("2026-10-25"); // уже зимовий (UTC+2)
    const p = postOrder(G.G12_ORDER, "2026-11-30T00:00:00Z");
    expect(p.order.placedOn).toBe(x.placedOn);
    expect(p.order.recognizedOn).toBe(x.recognizedOn);
    expect(only(p.entries, "refund_product").map((e) => e.recognizedOn)).toEqual([x.refundOn]);
    expect(only(p.entries, "sales_product").map((e) => e.recognizedOn)).toEqual([x.recognizedOn]);
  });
});

describe("G13 — сума періоду замість прогнозу", () => {
  it("7,00 EUR за прогнозами 3,00 / 2,00 / 1,00 → 3,50 / 2,33 / 1,17 (Σ = 7,00)", () => {
    const parts = allocatePeriodSum(
      cents(G.G13_INPUT.amount),
      G.G13_INPUT.forecasts.map((f, i) => ({ orderId: `pp${i}`, forecast: cents(f), revenue: 0n })),
    )!;
    expect(parts.map((p) => str(p.amount))).toEqual(G.G13_EXPECTED);
    expect(allocatePeriodSum(cents("7.00"), [{ orderId: "a", forecast: 0n, revenue: cents("100.00") }, { orderId: "b", forecast: 0n, revenue: cents("300.00") }])!.map((p) => str(p.amount))).toEqual(["1.75", "5.25"]);
    expect(allocatePeriodSum(cents("7.00"), [{ orderId: "a", forecast: cents("1.00"), revenue: 0n, alreadyActual: true }])).toBeNull();
  });
});

describe("G14 / G14b — повнота на панелі, середній чек з «Оцінкою»", () => {
  const o = { ...NOV, currency: "UAH", ctx: { rates: [] } };
  it("G14: оборот 650, валовий 300 (60,0 %), «Факт» 60 (1 з 3), «≈ Прогноз» 150 (2 з 3), рентабельності й «Не враховано»", () => {
    const x = G.G14_EXPECTED;
    const r = pnlReport(G.G14_JOURNAL, o);
    expect(r.turnover).toBe(x.turnover);
    expect(r.completeness.orders).toBe(x.orders);
    expect(r.grossProfit.value).toBe(x.grossProfit);
    expect(r.grossProfit.margin).toBe(x.grossMargin);
    expect([r.profit.fact, r.profit.factOrders]).toEqual([x.profitFact, x.profitFactOrders]);
    expect([r.profit.forecast, r.profit.forecastOrders]).toEqual([x.profitForecast, x.profitForecastOrders]);
    expect(r.orderMargin).toEqual({ fact: x.orderMarginFact, forecast: x.orderMarginForecast });
    expect(r.periodMargin).toEqual({ fact: x.periodMarginFact, factCoveragePct: x.periodMarginFactCoveragePct, forecast: x.periodMarginForecast, forecastCoveragePct: x.periodMarginForecastCoveragePct });
    expect([r.notCounted.orders, r.notCounted.turnover]).toEqual([x.notCountedOrders, x.notCountedRevenue]);
    expect(averageCheck(G.G14_JOURNAL, o).fact).toBe(x.averageCheck);
    expect(averageOrderProfit(G.G14_JOURNAL, o)).toMatchObject({ fact: x.averageOrderProfitFact, forecast: x.averageOrderProfitForecast });
    // I13: Σ прибутку замовлень за станами + записи періоду = «Факт» / «≈ Прогноз».
    const s = profitByStates(G.G14_JOURNAL, o);
    expect(str(cents(s.final) + cents(s.period))).toBe(x.profitFact);
    expect(str(cents(s.final) + cents(s.period) + cents(s.preliminary) - 1500n)).toBe(x.profitForecast);
  });
  it("рентабельність періоду показується при покритті ≥ 90 %", () => {
    const j: RefJournal = { ...G.G14_JOURNAL, orders: G.G14_JOURNAL.orders.map((m) => (m.orderId === "I" ? { ...m, state: "final" as const } : m)) };
    const r = pnlReport(j, o);
    // final = F + I: NR 450 з 650 (69 %) → ще «—»; з P також final — 100 %.
    expect(r.periodMargin.fact).toBeNull();
    const all: RefJournal = { ...j, orders: j.orders.map((m) => ({ ...m, state: "final" as const })) };
    const r2 = pnlReport(all, o);
    expect(r2.profit.fact).toBe("315.00");
    expect(r2.periodMargin).toMatchObject({ fact: "48.5", factCoveragePct: 100 });
  });
  it("G14b: «Факт» 1 000,00 (за 8 з 10), «≈ з оцінками» 900,00; «Оцінка» окремим рядком", () => {
    const x = G.G14B_EXPECTED;
    const a = averageCheck(G.G14B_JOURNAL, o);
    expect(a).toMatchObject({ fact: x.averageCheckFact, factOrders: x.factOrders, orders: x.orders, withEstimates: x.averageCheckWithEstimates, turnoverFact: x.turnoverFact });
    const r = pnlReport(G.G14B_JOURNAL, o);
    expect(r.turnover).toBe(x.turnoverFact);
    expect(r.estimate).toEqual({ orders: x.estimateOrders, amount: x.estimate });
  });
});

describe("G15 — статистика доставки за накладними", () => {
  it("середня 530,00 (3 з 4); DE 570,00 (2 з 3), 380,00 за кг; PL 450,00; прогноз vs факт +110,00, 7,8 %, за основами", () => {
    const x = G.G15_EXPECTED;
    const s = shippingStats(G.G15_WAYBILLS, { ...NOV, currency: "UAH", ctx: { rates: [] } });
    expect([s.waybills, s.withActual, s.averageCost]).toEqual([x.waybills, x.withActual, x.averageCost]);
    expect(s.byCountry.DE).toMatchObject(x.DE);
    expect(s.byCountry.PL).toMatchObject(x.PL);
    expect(s.forecastVsActual).toMatchObject({ forecast: x.forecast, actual: x.actual, delta: x.delta, meanAbsDeltaPct: x.meanAbsDeltaPct, overThreshold: x.overThreshold });
    expect(Object.fromEntries(Object.entries(s.forecastVsActual.byBasis).map(([k, v]) => [k, v!.delta]))).toEqual(x.byBasis);
    expect(s.returns).toBe(x.returns);
  });
});

describe("G16 — рейтинг товарів і країн з розподілом", () => {
  const o = { ...NOV, currency: "UAH", ctx: { rates: [] } };
  it("замовлення X: розподіл −154,01 = −92,41 / −61,60 (остача — P1); валовий 400,00 (66,7 %) і 250,00 (62,5 %)", () => {
    const j: RefJournal = { ...G.G16_JOURNAL, entries: G.G16_JOURNAL.entries.filter((e) => e.orderId === "X"), orders: G.G16_JOURNAL.orders.filter((m) => m.orderId === "X") };
    const r = productRanking(j, G.G16_LINES, o);
    for (const p of ["P1", "P2"] as const) expect(r.rows.find((x) => x.productId === p)).toMatchObject({ ...G.G16_EXPECTED.orderX[p], complete: true });
  });
  it("X + Y: P1 900,00 / −300,00 / 600,00 (66,7 %); P3 без собівартості — поза рейтингом; країни за станами", () => {
    const r = productRanking(G.G16_JOURNAL, G.G16_LINES, o);
    expect(r.rows.find((x) => x.productId === "P1")).toMatchObject(G.G16_EXPECTED.all.P1);
    expect(r.hiddenIncomplete).toEqual(G.G16_EXPECTED.all.hiddenIncomplete);
    expect(r.rows.some((x) => x.productId === "P3")).toBe(false);
    expect(productRanking(G.G16_JOURNAL, G.G16_LINES, { ...o, showIncomplete: true }).rows.some((x) => x.productId === "P3")).toBe(true);
    const c = countryRanking(G.G16_JOURNAL, o);
    expect(c.rows.find((x) => x.country === "DE")).toMatchObject(G.G16_EXPECTED.countries.DE);
    expect(c.rows.find((x) => x.country === "PL")).toMatchObject(G.G16_EXPECTED.countries.PL);
    expect(c.unallocated).toBe(G.G16_EXPECTED.countries.unallocated);
  });
  it("Топ-N + «Інші»", () => {
    const r = productRanking(G.G16_JOURNAL, G.G16_LINES, { ...o, top: 1 });
    expect(r.rows.map((x) => x.productId)).toEqual(["P1"]);
    expect(r.others).toMatchObject({ netRevenue: "400.00", gross: "250.00" });
  });
});

describe("G17 — прогноз доходів і витрат (§12.3)", () => {
  it("(а) доставка з повнотою 60 % → прибуток неможливий; (б) 85 % і 10 % → 4 200,00", () => {
    const a = forecast(G.G17_INPUT_A);
    const xa = G.G17_EXPECTED.a;
    expect(a.status).toBe("ok");
    expect(a.currentMonthRevenue).toBe(xa.currentMonthRevenue);
    expect(a.nextMonth.revenue).toBe(xa.revenue);
    expect(a.nextMonth.variable).toMatchObject({ cogs: xa.cogs, packaging: xa.packaging, fees: xa.fees, partners: xa.partners, shipping: xa.shipping });
    expect([a.nextMonth.profit, a.nextMonth.missing]).toEqual([xa.profit, xa.missing]);
    const b = forecast(G.G17_INPUT_B);
    const xb = G.G17_EXPECTED.b;
    expect(b.nextMonth.variable.shipping).toBe(xb.shipping);
    expect(str(Object.values(b.nextMonth.fixed).reduce((s, v) => s + cents(v!), 0n))).toBe(xb.fixed);
    expect([b.nextMonth.profit, b.nextMonth.totalCosts]).toEqual([xb.profit, xb.totalCosts]);
    expect(forecast({ ...G.G17_INPUT_B, recognizedOrders: 9 }).status).toBe("insufficient");
    expect(forecast({ ...G.G17_INPUT_B, fixed: { ...G.G17_INPUT_B.fixed, taxes: { months: [0n, 0n, 0n] } } }).nextMonth.missing).toEqual(["taxes"]);
  });
});

describe("G18 — вартість запасів на дату й собівартість моделі", () => {
  it("на 12.09 — 0,00 і 2 од. без собівартості (не 800,00); 16.09 — 1 000,00 + 2; 21.09 і 30.11 — 800,00", () => {
    const r = runCosting(G.G5_OPENING_COMPLETION);
    for (const [day, x] of Object.entries(G.G18_EXPECTED.at)) {
      const v = stockValueAt(r.valuations, day);
      expect({ day, knownValue: v.knownValue, unknownQty: v.unknownQty }).toEqual({ day, ...x });
    }
  });
  it("модель M1: чорний 8 / 800,00, білий 2 / 230,00 → 103,00; ручна собівартість — окремо", () => {
    const black = runCosting(G.G5_OPENING_COMPLETION).state;
    const white = runCosting(G.G18_EXPECTED.white).state;
    const m = modelStockCost([
      { model: "M1", color: "black", knownQty: black.knownQty, knownValue: str(black.knownValue), manualCost: G.G18_EXPECTED.model.manualBlack },
      { model: "M1", color: "white", knownQty: white.knownQty, knownValue: str(white.knownValue) },
    ]);
    expect(m.M1).toEqual({
      average: G.G18_EXPECTED.model.average,
      byColor: { black: { average: G.G18_EXPECTED.model.black, manualCost: G.G18_EXPECTED.model.manualBlack }, white: { average: G.G18_EXPECTED.model.white, manualCost: null } },
    });
  });
});

describe("G19 — окупність партнера", () => {
  it("4 200 − 800 = 3 400; 3 400 / (800 + 200) = 3,40", () => {
    expect(partnerPayback(G.G19_INPUT)).toEqual(G.G19_EXPECTED);
    expect(partnerPayback({ profitBeforeCommission: "100.00", commission: "0.00", fixedFees: "0.00" }).payback).toBeNull();
  });
});

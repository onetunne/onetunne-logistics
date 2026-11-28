/**
 * Етап 6 (WP12a): правила еталонної моделі поза числами §20.1 — визнання й виключення (§2.5, §3.2), продажі до/після
 * визнання (§2.1), складники й стани (§2.6), курси (§5.4), прогноз доставки (§7.1), динаміка й порівняння (§12),
 * закриття місяця (§3.4), ідемпотентність (F2). Кожне правило «МАЄ / НІКОЛИ» з цих розділів має тут перевірку.
 */
import { describe, expect, it } from "vitest";
import {
  appendIdempotent,
  cents,
  chooseFrozenForecast,
  compareValues,
  convert,
  countryAverage,
  digitsOf,
  emptyImportLedger,
  isValidAmountFor,
  journalFrom,
  orderCard,
  pnlReport,
  postOrder,
  profitLabel,
  rateFor,
  returnRate,
  salesDynamics,
  saveImport,
  str,
  type RefCarrierDocument,
  type RefEntry,
  type RefOrderFacts,
  type RefRate,
} from "./model";
import { G1_ORDER, G1_ORDER_NO_RETURN, G1_RATES, G2_ORDER } from "./golden";

const AT = "2026-11-30T00:00:00Z";
const ctx = { rates: G1_RATES };
const base: RefOrderFacts = { ...G1_ORDER_NO_RETURN, id: "ord-rules" };

describe("визнання й виключення (§2.5, §3.2)", () => {
  it("тестове замовлення: стан excluded, жодного запису виручки; вихід складу — inventory_loss test_order", () => {
    const p = postOrder({ ...base, test: true }, AT);
    expect(p.order.state).toBe("excluded");
    expect(p.entries.map((e) => [e.category, e.details?.kind])).toEqual([
      ["inventory_loss", "test_order"],
      ["inventory_loss", "test_order"],
    ]);
    const included = postOrder({ ...base, test: true }, AT, { includeTestOrders: true });
    expect(included.order.state).toBe(postOrder(base, AT).order.state);
    expect(included.entries.length).toBe(postOrder(base, AT).entries.length);
  });
  it("скасоване до відвантаження: closed_unrecognized, лише понесені витрати (R5) датою події з order_id", () => {
    const p = postOrder({ ...base, handedOverAt: null, cancelledBeforeHandover: true, valuations: base.valuations.filter((v) => v.kind === "material") }, AT);
    expect(p.order.state).toBe("closed_unrecognized");
    expect(p.entries.map((e) => e.category).sort()).toEqual(["packaging", "payment_fees", "shipping_cost"]);
    expect(p.entries.every((e) => e.orderId === base.id)).toBe(true);
    // У P&L — стовпець «Витрати періоду».
    const r = pnlReport(journalFrom([p]), { from: "2026-10-01", to: "2026-11-30", currency: "UAH", ctx });
    expect(r.columns.period.PR).toBeUndefined();
    expect(r.profit.fact).not.toBeNull();
    expect(r.completeness.orders).toBe(0);
  });
  it("ще не передане — open, без записів; визнання за першим доказом; імпортоване виконаним — placed_fallback", () => {
    expect(postOrder({ ...base, handedOverAt: null }, AT).order.state).toBe("open");
    expect(postOrder({ ...base, handedOverAt: null }, AT).entries).toEqual([]);
    const both = postOrder({ ...base, handedOverAt: "2026-10-07T10:00:00Z", consumeAt: "2026-10-06T10:00:00Z" }, AT);
    expect([both.order.recognizedOn, both.order.recognitionBasis]).toEqual(["2026-10-06", "consume"]);
    const imp = postOrder({ ...base, handedOverAt: null, fulfilledImported: true }, AT);
    expect([imp.order.recognizedOn, imp.order.recognitionBasis]).toEqual(["2026-10-05", "placed_fallback"]);
    // Дата визнання, раз установлена, не рухається від пізніших фактів (F6).
    expect(postOrder(G1_ORDER, AT).order.recognizedOn).toBe(postOrder(G1_ORDER, "2026-10-06T00:00:00Z").order.recognizedOn);
  });
});

describe("продажі угод (§2.1)", () => {
  it("повернення ДО визнання — sales_* з від'ємною сумою (preRecognitionRefund), нетто в обороті; ПІСЛЯ — refund_*", () => {
    const before = { id: "s-pre", agreement: "refund" as const, lineType: "PRODUCT" as const, lineId: "li-g1-a", productId: "prod-a", totalAmount: "-45.00", taxAmount: "0.00", happenedAt: "2026-10-05T08:00:00Z" };
    const p = postOrder({ ...base, sales: [...base.sales, before] }, AT);
    const e = p.entries.find((x) => x.key === "sale:s-pre:net")!;
    expect([e.category, e.amount, e.details?.preRecognitionRefund, e.recognizedOn]).toEqual(["sales_product", "-45.00", true, "2026-10-05"]);
    const r = pnlReport(journalFrom([p]), { from: "2026-10-01", to: "2026-10-31", currency: "EUR", ctx });
    expect(r.turnover).toBe("84.00");
    expect(r.columns.total.D).toBe("0.00");
  });
  it("правка після визнання — R2 + «Потребує перевірки»; невідома угода й рядок UNKNOWN — перевірка; подарункова картка — довідково", () => {
    const p = postOrder(
      {
        ...base,
        sales: [
          ...base.sales,
          { id: "s-edit", agreement: "order_edit", lineType: "PRODUCT", totalAmount: "20.00", taxAmount: "0.00", happenedAt: "2026-10-20T10:00:00Z" },
          { id: "s-unk", agreement: "unknown", lineType: "UNKNOWN", totalAmount: "-3.00", taxAmount: "0.00", happenedAt: "2026-10-21T10:00:00Z" },
          { id: "s-gc", agreement: "order", lineType: "GIFT_CARD", totalAmount: "25.00", taxAmount: "0.00", happenedAt: "2026-10-05T07:00:00Z" },
        ],
      },
      AT,
    );
    expect(p.entries.find((e) => e.key === "sale:s-edit:net")).toMatchObject({ category: "sales_product", recognizedOn: "2026-10-20", fxOn: "2026-10-20" });
    expect(p.entries.find((e) => e.key === "sale:s-unk:net")?.category).toBe("refund_unknown");
    expect(p.entries.find((e) => e.key === "sale:s-gc:net")?.category).toBe("gift_card_memo");
    expect(p.order.flags).toEqual(expect.arrayContaining(["edited_after_recognition", "unknown_agreement", "unknown_line_type"]));
  });
});

describe("складники й стани (§2.6, F4 — відсутнє НІКОЛИ не 0)", () => {
  it("«Оцінка» без угод — incomplete, окремим рядком, ніколи не у факті", () => {
    const p = postOrder({ ...base, sales: [], revenueEstimate: "120.00" }, AT);
    expect(p.order.state).toBe("incomplete");
    expect(p.order.missing).toContain("revenue");
    const r = pnlReport(journalFrom([p]), { from: "2026-10-01", to: "2026-10-31", currency: "EUR", ctx });
    expect(r.turnover).toBe("0.00");
    expect(r.estimate).toEqual({ orders: 1, amount: "120.00" });
  });
  it("розбіжність звірки RC2/RC3/RC5 → виручка partial → не final (preliminary)", () => {
    const p = postOrder({ ...base, reconciliationMismatch: true }, AT);
    expect(p.order.components.revenue).toMatchObject({ state: "partial", reason: "reconciliation_mismatch" });
    expect(p.order.state).toBe("preliminary");
  });
  it("частина накладних без рахунку — partial з прогнозом; без прогнозу — incomplete; скасована накладна не обов'язкова", () => {
    const second = { id: "wb-2", source: "app" as const, number: "20450000000099", country: "DE", frozenForecast: { basis: "country_average" as const, amount: "300.00", currency: "UAH" } };
    const p = postOrder({ ...base, waybills: [...base.waybills, second] }, AT);
    expect(p.order.components.shipping_cost).toMatchObject({ state: "partial", hasForecast: true });
    expect(p.order.state).toBe("preliminary");
    expect(p.forecasts.filter((f) => f.component === "shipping_cost").map((f) => [f.waybillId, f.amount])).toEqual([["wb-2", "-300.00"]]);
    const none = postOrder({ ...base, waybills: [...base.waybills, { ...second, frozenForecast: { basis: "none" as const, amount: null, currency: "UAH" } }] }, AT);
    expect(none.order.state).toBe("incomplete");
    const cancelled = postOrder({ ...base, waybills: [...base.waybills, { ...second, cancelled: true }] }, AT);
    expect(cancelled.order.components.shipping_cost?.state).toBe("actual");
  });
  it("факт замінює прогноз (ніколи не додається): прогноз доставки зникає після рахунку", () => {
    const before = postOrder(G1_ORDER, "2026-11-08T00:00:00Z");
    const after = postOrder(G1_ORDER, AT);
    expect(before.forecasts.map((f) => f.component)).toEqual(["shipping_cost"]);
    expect(after.forecasts).toEqual([]);
  });
  it("платник Recipient / позначка власника / жодна позиція не потребує доставки → not_applicable", () => {
    expect(postOrder({ ...base, invoiceLines: [], waybills: base.waybills.map((w) => ({ ...w, payerRecipient: true })) }, AT).order.components.shipping_cost?.state).toBe("not_applicable");
    expect(postOrder({ ...base, invoiceLines: [], waybills: [], shippingOwnerMark: "recipient_pays" }, AT).order.components.shipping_cost?.state).toBe("not_applicable");
    expect(postOrder({ ...base, invoiceLines: [], waybills: [], lines: base.lines.map((l) => ({ ...l, requiresShipping: false })) }, AT).order.components.shipping_cost?.state).toBe("not_applicable");
  });
  it("комісії: правило шлюзу — прогноз від суми SUCCESS SALE/CAPTURE; «без комісії» — 0 (підтверджено); нічого — missing", () => {
    const noFees = { ...base, transactions: base.transactions.map((t) => ({ ...t, fees: [] })) };
    const pct = postOrder({ ...noFees, feeRule: { kind: "percent", percentBp: 290, fixed: "0.30" } }, AT);
    expect(pct.order.components.fees?.state).toBe("forecast");
    expect(pct.forecasts.find((f) => f.component === "fees")?.amount).toBe("-4.04");
    expect(postOrder({ ...noFees, feeRule: { kind: "no_fees" } }, AT).order.components.fees?.state).toBe("zero_confirmed");
    expect(postOrder(noFees, AT).order.components.fees).toMatchObject({ state: "missing", reason: "no_fee_data" });
  });
  it("DDP — мито обов'язкове; неоднозначний партнер — «Немає даних»; картка incomplete показує, чого бракує", () => {
    const ddp = postOrder({ ...base, ddp: true }, AT);
    expect(ddp.order.components.duties_paid).toMatchObject({ state: "missing", required: true });
    expect(ddp.order.state).toBe("incomplete");
    const amb = postOrder({ ...base, partner: "ambiguous" }, AT);
    expect(amb.order.components.partner).toMatchObject({ state: "missing", reason: "ambiguous_partner" });
    const card = orderCard(journalFrom([amb]), base.id, "UAH", ctx);
    expect(card.profit).toEqual({ kind: "hidden", value: null, margin: null, missing: ["partner"] });
  });
  it("частина одиниць без собівартості — partial; прогноз робить preliminary, без прогнозу — incomplete", () => {
    const partial = { ...base, valuations: base.valuations.map((v) => (v.id === "v-g1-a" ? { ...v, value: "400.00", unknownQty: 1 } : v)) };
    expect(postOrder(partial, AT).order.components.cogs).toMatchObject({ state: "partial", reason: "no_cost" });
    expect(postOrder(partial, AT).order.state).toBe("incomplete");
    expect(postOrder({ ...partial, cogsForecast: "400.00" }, AT).order.state).toBe("preliminary");
  });
});

describe("курси (§5.1, §5.4)", () => {
  const rates: RefRate[] = [
    { currency: "EUR", date: "2026-11-20", rate: "49.5335", source: "nbu" },
    { currency: "EUR", date: "2026-11-20", rate: "49.9000", source: "manual", version: 1, isCurrent: false },
    { currency: "EUR", date: "2026-11-20", rate: "49.6000", source: "manual", version: 2, isCurrent: true },
    { currency: "EUR", date: "2026-11-25", rate: "50.0000", source: "demo" },
  ];
  it("поточний ручний має перевагу над НБУ; неактуальна версія ігнорується; демо-курс — лише в демо", () => {
    expect(rateFor(rates, "EUR", "2026-11-20")).toMatchObject({ source: "manual", fallback: false });
    expect(convert(cents("1.00"), "EUR", "UAH", "2026-11-20", { rates })).toBe(cents("49.60"));
    expect(rateFor(rates, "EUR", "2026-11-25")).toMatchObject({ rateDate: "2026-11-20", fallback: true });
    expect(rateFor(rates, "EUR", "2026-11-25", { mode: "demo" })).toMatchObject({ source: "demo", fallback: false });
  });
  it("курс на майбутню дату не припускається; запасний — до fallbackDays", () => {
    expect(rateFor(rates, "EUR", "2026-11-19")).toBeNull();
    expect(rateFor(rates, "EUR", "2026-11-27")).toMatchObject({ rateDate: "2026-11-20" });
    expect(rateFor(rates, "EUR", "2026-11-28")).toBeNull();
    expect(rateFor(rates, "EUR", "2026-11-28", { fallbackDays: 8 })).toMatchObject({ rateDate: "2026-11-20" });
  });
  it("валюти з 3–4 знаками не підтримуються; соті у валюті з 0 знаками — помилка розбору, не округлення", () => {
    expect(() => digitsOf("BHD")).toThrow(/unsupported/);
    expect(() => digitsOf("CLF")).toThrow(/unsupported/);
    expect(digitsOf("JPY")).toBe(0);
    expect(digitsOf("HUF")).toBe(2);
    expect(isValidAmountFor(cents("100.50"), "JPY")).toBe(false);
    expect(isValidAmountFor(cents("100.00"), "JPY")).toBe(true);
  });
});

describe("заморожений прогноз доставки (§4, §7.1)", () => {
  it("перша основа: carrier_reported → country_average (≥ 3 за 90 днів) → owner_table → none", () => {
    const history = [
      { country: "DE", recognizedOn: "2026-10-01", actual: cents("500.00") },
      { country: "DE", recognizedOn: "2026-10-10", actual: cents("600.00") },
      { country: "DE", recognizedOn: "2026-06-01", actual: cents("900.00") },
      { country: "PL", recognizedOn: "2026-10-10", actual: cents("400.00") },
    ];
    expect(countryAverage(history, "DE", "2026-11-01")).toBeNull();
    const more = [...history, { country: "DE", recognizedOn: "2026-10-20", actual: cents("700.00") }];
    expect(str(countryAverage(more, "DE", "2026-11-01")!)).toBe("600.00");
    expect(chooseFrozenForecast({ carrierReported: { amount: "520.00", currency: "UAH" }, ownerTable: { amount: "300.00", currency: "UAH" } }).basis).toBe("carrier_reported");
    expect(chooseFrozenForecast({ countryAverage: { amount: "600.00", currency: "UAH" }, ownerTable: { amount: "300.00", currency: "UAH" } }).basis).toBe("country_average");
    expect(chooseFrozenForecast({ ownerTable: { amount: "300.00", currency: "UAH" } }).basis).toBe("owner_table");
    expect(chooseFrozenForecast({})).toEqual({ basis: "none", amount: null, currency: null });
  });
});

describe("динаміка продажів, частка повернень, порівняння (§12.1–§12.2, §2.6)", () => {
  it("за датою замовлення (Київ); ще не визнані — окремою сумою; середнє — за замовленнями з угодами", () => {
    const r = salesDynamics(
      [
        { ...G1_ORDER, recognizedAt: "2026-10-05T12:00:00Z" },
        { ...G2_ORDER, id: "o2", placedAt: "2026-10-30T23:30:00Z", recognizedAt: null },
        { ...G2_ORDER, id: "o3", sales: [], placedAt: "2026-10-06T10:00:00Z", recognizedAt: null },
      ],
      { from: "2026-10-01", to: "2026-10-31", granularity: "month", currency: "EUR", ctx },
    );
    expect(r.buckets).toEqual([{ bucket: "2026-10", orders: 3, units: 4, netSales: "187.40", unrecognizedNetSales: "58.40", averageCheck: "93.70", ordersWithSales: 2 }]);
    const byDay = salesDynamics([{ ...G2_ORDER, placedAt: "2026-10-30T23:30:00Z" }], { from: "2026-10-01", to: "2026-10-31", granularity: "day", currency: "EUR", ctx });
    expect(byDay.buckets[0]!.bucket).toBe("2026-10-31");
  });
  it("частка повернень — без order_unreadable у знаменнику", () => {
    expect(returnRate([
      { recognized: true, returnsKnown: true, hasReturn: true },
      { recognized: true, returnsKnown: true, hasReturn: false },
      { recognized: true, returnsKnown: false, hasReturn: false },
      { recognized: false, returnsKnown: true, hasReturn: true },
    ])).toEqual({ rate: "50.0", withReturn: 1, known: 2, recognized: 3 });
  });
  it("Δ і Δ %: «—», якщо база ≤ 0 або неповна; невідоме не стає нулем", () => {
    expect(compareValues("150.00", "100.00")).toEqual({ delta: "50.00", deltaPct: "50.0" });
    expect(compareValues("150.00", "-10.00")).toEqual({ delta: "160.00", deltaPct: null });
    expect(compareValues("150.00", "100.00", false)).toEqual({ delta: "50.00", deltaPct: null });
    expect(compareValues(null, "100.00")).toEqual({ delta: null, deltaPct: null });
  });
});

describe("закриття місяця й ідемпотентність (§3.4, F2)", () => {
  it("повторно відкритий місяць не дає права на «Чистий прибуток»; ручні записи знову дозволені", () => {
    const reopened = [{ month: "2026-10", closedAt: "2026-11-05T10:00:00Z", reopenedAt: "2026-11-07T10:00:00Z", allConfirmedWithTaxes: true }];
    expect(profitLabel("2026-10-01", "2026-10-31", reopened, "2026-11-06T00:00:00Z")).toBe("net_profit");
    expect(profitLabel("2026-10-01", "2026-10-31", reopened, "2026-11-08T00:00:00Z")).toBe("profit_after_costs");
  });
  it("повтор вставки з тим самим ключем — пропуск; нульова сума — відмова (CHECK amount <> 0)", () => {
    const e: RefEntry = { key: "k1", orderId: null, category: "advertising", amount: "-10.00", currency: "UAH", recognizedOn: "2026-11-01", fxOn: "2026-11-01", originalOn: "2026-11-01", isLate: false, isLateCompletion: false, reversesKey: null };
    const journal: RefEntry[] = [];
    expect(appendIdempotent(journal, [e, e])).toBe(1);
    expect(appendIdempotent(journal, [e])).toBe(0);
    expect(() => appendIdempotent(journal, [{ ...e, key: "k2", amount: "0.00" }])).toThrow(/amount <> 0/);
  });
});

describe("моделі й кольори, собівартість проданої одиниці, вхід прогнозу з журналу", () => {
  it("рентабельність моделей і кольорів: лише позиції з відомою собівартістю (G16)", async () => {
    const { G16_JOURNAL, G16_LINES } = await import("./golden");
    const { modelColorRanking } = await import("./model");
    expect(modelColorRanking(G16_JOURNAL, G16_LINES, { from: "2026-11-01", to: "2026-11-30", currency: "UAH", ctx: { rates: [] } })).toEqual([
      { model: "M1", color: "black", netRevenue: "900.00", gross: "600.00", margin: "66.7" },
      { model: "M1", color: "white", netRevenue: "400.00", gross: "250.00", margin: "62.5" },
    ]);
  });
  it("собівартість проданої одиниці = Σ cogs / Σ кількість", async () => {
    const { soldUnitCost } = await import("./model");
    expect(soldUnitCost(postOrder(G1_ORDER, AT).entries)).toBe("350.00");
    expect(soldUnitCost([])).toBeNull();
  });
  it("forecastInputsFromJournal: відношення за final, повнота за складниками, постійні за 3 місяці", async () => {
    const { forecast, forecastInputsFromJournal } = await import("./model");
    const entries: RefEntry[] = [];
    const orders = [];
    const mk = (orderId: string | null, category: RefEntry["category"], amount: string, d: string): RefEntry => ({ key: `${orderId}:${category}:${d}:${amount}`, orderId, category, amount, currency: "UAH", recognizedOn: d, fxOn: d, originalOn: d, isLate: false, isLateCompletion: false, reversesKey: null });
    for (let i = 0; i < 12; i++) {
      const d = `2026-09-${String(10 + i).padStart(2, "0")}`;
      const id = `f${i}`;
      entries.push(mk(id, "sales_product", "1000.00", d), mk(id, "cogs", "-350.00", d), mk(id, "shipping_cost", "-100.00", d), mk(id, "packaging", "-10.00", d), mk(id, "payment_fees", "-30.00", d));
      orders.push({ orderId: id, state: "final" as const, recognizedOn: d, components: { revenue: { state: "actual" as const }, cogs: { state: "actual" as const }, shipping_cost: { state: "actual" as const }, packaging: { state: "actual" as const }, fees: { state: "actual" as const } } });
    }
    for (const m of ["2026-07", "2026-08", "2026-09"]) entries.push(mk(null, "advertising", "-900.00", `${m}-15`), mk(null, "platform_fees", "-300.00", `${m}-01`), mk(null, "services", "-60.00", `${m}-05`));
    const inputs = forecastInputsFromJournal({ entries, orders, forecasts: [] }, "2026-10-15", "UAH", { rates: [] }, { firstDataOn: "2026-07-01", confirmedNone: ["taxes", "salaries", "other"] });
    expect(inputs.recognizedOrders).toBe(12);
    expect(str(inputs.windowNR)).toBe("12000.00");
    expect(inputs.historyDays).toBe(90);
    const f = forecast(inputs);
    // NR 12 000 за 90 днів → 4 000 на 30 днів листопада; відношення 35 % / 10 % / 1 % / 3 %; партнерів немає → 0.
    expect(f.nextMonth.revenue).toBe("4000.00");
    expect(f.nextMonth.variable).toEqual({ cogs: "1400.00", shipping: "400.00", packaging: "40.00", fees: "120.00", partners: "0.00" });
    expect(f.nextMonth.fixed).toMatchObject({ advertising: "900.00", platform: "300.00", services: "60.00", taxes: "0.00" });
    expect(f.nextMonth.profit).toBe("780.00");
  });
});

describe("ефективність партнера й доставка на замовлення (з журналу)", () => {
  it("G19 через журнал: прибуток до 4 200,00, винагорода 800,00, фіксована 200,00 → після 3 400,00, окупність 3,40", async () => {
    const { partnerPerformance } = await import("./model");
    const mk = (orderId: string | null, category: RefEntry["category"], amount: string, details?: RefEntry["details"]): RefEntry => ({ key: `${orderId}:${category}:${amount}`, orderId, category, amount, currency: "UAH", recognizedOn: "2026-11-10", fxOn: "2026-11-10", originalOn: "2026-11-10", isLate: false, isLateCompletion: false, reversesKey: null, details });
    const entries = [
      mk("a", "sales_product", "5000.00"), mk("a", "cogs", "-2000.00"), mk("a", "partner_commission", "-500.00"),
      mk("b", "sales_product", "2000.00"), mk("b", "cogs", "-800.00"), mk("b", "partner_commission", "-300.00"),
      mk("c", "sales_product", "999.00"), mk("c", "partner_commission", "-99.90"),
      mk(null, "partner_fixed_fee", "-200.00", { partnerId: "pa" }),
      mk(null, "partner_fixed_fee", "-50.00", { partnerId: "other" }),
    ];
    const orders = [
      { orderId: "a", state: "final" as const, recognizedOn: "2026-11-10", components: { revenue: { state: "actual" as const } } },
      { orderId: "b", state: "final" as const, recognizedOn: "2026-11-10", components: { revenue: { state: "actual" as const } } },
      { orderId: "c", state: "incomplete" as const, recognizedOn: "2026-11-10", components: { revenue: { state: "actual" as const } } },
    ];
    const r = partnerPerformance({ entries, orders, forecasts: [] }, ["a", "b", "c"], { from: "2026-11-01", to: "2026-11-30", currency: "UAH", ctx: { rates: [] }, partnerId: "pa" });
    expect(r).toEqual({ orders: 3, finalOrders: 2, turnover: "7999.00", averageCheck: "2666.33", commission: "800.00", fixedFees: "200.00", profitBefore: "4200.00", profitAfter: "3400.00", payback: "3.40" });
  });
  it("середня фактична доставка на замовлення, «без накладної», сплачено vs фактично (G1)", async () => {
    const { orderShippingSummary } = await import("./model");
    const g1 = postOrder(G1_ORDER, AT);
    const noWb = postOrder({ ...base, id: "nowb", waybills: [], invoiceLines: [] }, AT);
    const r = orderShippingSummary(journalFrom([g1, noWb]), { from: "2026-10-01", to: "2026-10-31", currency: "UAH", ctx });
    // G1: сплачено 12,00 EUR = 582,00 грн, факт 540,00 → +42,00.
    expect(r).toEqual({ averageActual: "540.00", ordersWithActual: 1, withoutWaybill: 1, paidMinusActual: "42.00" });
  });
});

describe("«Оплачено, ще не відвантажено» (§3.6)", () => {
  it("лише оплачені, не скасовані, не визнані; тестові — ні; сума — чисті продажі угод", async () => {
    const { paidNotShipped } = await import("./model");
    const r = paidNotShipped(
      [
        { ...G2_ORDER, id: "open-1", recognizedAt: null },
        { ...G2_ORDER, id: "open-test", test: true, recognizedAt: null },
        { ...G2_ORDER, id: "cancelled", cancelledBeforeHandover: true, recognizedAt: null },
        { ...G2_ORDER, id: "shipped", recognizedAt: "2026-10-05T12:00:00Z" },
        { ...G2_ORDER, id: "unpaid", transactions: [], recognizedAt: null },
      ],
      "EUR",
      ctx,
    );
    expect(r).toEqual({ orders: 1, amount: "58.40", unconverted: 0 });
  });
});

describe("рушій: повернена частка дефіцитного продажу завершує свій шар, а не продаж (§6.2)", () => {
  it("продаж 2 з порожнього пулу, повернення 1, надходження 10 × 100 → собівартість замовлення −100,00; пул 9 на 900,00", async () => {
    const { runCosting, effectTotals } = await import("./model");
    const r = runCosting([
      { kind: "outflow", id: "s1", date: "2026-09-10", qty: 2, reason: "sale", orderId: "o1" },
      { kind: "customer_return", id: "ret", date: "2026-09-12", orderId: "o1", good: 1 },
      { kind: "receipt", id: "r1", date: "2026-09-15", good: 10, unitCost: "100.00" },
    ]);
    const t = effectTotals(r.effects.filter((e) => e.orderId === "o1"));
    expect(str(cents(t.cogs ?? "0.00") + cents(t.cogs_return ?? "0.00"))).toBe("-100.00");
    expect({ knownQty: r.state.knownQty, knownValue: str(r.state.knownValue), unknownQty: r.state.unknownQty, deficitQty: r.state.deficitQty }).toEqual({ knownQty: 9, knownValue: "900.00", unknownQty: 0, deficitQty: 0 });
    expect(r.onHand).toBe(9);
  });
});

describe("відрізки (§3.1): ISO-тиждень пн–нд, місяць, рік", () => {
  it("ISO-тижні на межах років", async () => {
    const { isoWeek, bucketKey } = await import("./model");
    expect(isoWeek("2026-11-28")).toBe("2026-W48");
    expect(isoWeek("2026-11-23")).toBe("2026-W48");
    expect(isoWeek("2026-11-22")).toBe("2026-W47");
    expect(isoWeek("2027-01-01")).toBe("2026-W53");
    expect(isoWeek("2025-12-29")).toBe("2026-W01");
    expect(bucketKey("2026-11-28", "month")).toBe("2026-11");
    expect(bucketKey("2026-11-28", "year")).toBe("2026");
  });
});

describe("події партнера з бажаної винагороди (§9.4)", () => {
  it("бажана − Σ попередніх → нова подія; 0 → скасування", async () => {
    const { partnerEventsFrom } = await import("./model");
    expect(partnerEventsFrom([{ date: "2026-10-05", desired: 1170n }, { date: "2026-11-04", desired: 720n }, { date: "2026-11-04", desired: 720n }, { date: "2026-11-15", desired: 0n, cancelled: true }])).toEqual([
      { n: 1, kind: "accrual", amount: 1170n, date: "2026-10-05" },
      { n: 2, kind: "adjustment", amount: -450n, date: "2026-11-04" },
      { n: 3, kind: "cancellation", amount: -720n, date: "2026-11-15" },
    ]);
  });
});

describe("імпорт рахунків перевізника (§7.2, §7.3, §7.6)", () => {
  const cands = [{ number: "20450000000011", carrier: "nova_post", orderId: "o-a", waybillId: "wb-a", handedOver: true, orderRecognized: true }];
  const doc = (over: Partial<RefCarrierDocument> = {}): RefCarrierDocument => ({
    id: "d1",
    carrier: "nova_post",
    accountRef: "acc",
    invoiceNumber: "R-1",
    kind: "invoice",
    sha256: "sha-1",
    invoiceDate: "2026-10-30",
    total: null,
    importedAt: "2026-11-06T09:00:00Z",
    rows: [],
    ...over,
  });
  const closures = [{ month: "2026-10", closedAt: "2026-11-05T10:00:00Z", allConfirmedWithTaxes: true }];

  it("нерозподілений рядок, що належить закритому місяцю → пізній запис (recognized_on = дата імпорту, fx_on — справжня дата)", () => {
    const r = saveImport(emptyImportLedger(), doc({ rows: [{ rowNumber: 2, number: "20450000000099", service: "Доставка", amount: "300.00", currency: "UAH", chargeDate: "2026-10-28" }] }), { candidates: cands, closures });
    if (!r.ok) throw new Error(r.error);
    expect(r.ledger.entries.map((e) => [e.category, e.amount, e.recognizedOn, e.originalOn, e.fxOn, e.isLate])).toEqual([["shipping_unallocated", "-300.00", "2026-11-06", "2026-10-28", "2026-10-28", true]]);
  });
  it("НІКОЛИ не проводиться: рядок «Разом» і нульовий рядок; мито без замовлення → duties_paid (не доставка)", () => {
    const r = saveImport(
      emptyImportLedger(),
      doc({
        rows: [
          { rowNumber: 2, number: null, service: "Мито", amount: "70.00", currency: "UAH", chargeType: "customs_duty" },
          { rowNumber: 3, number: "20450000000099", service: "Доставка", amount: "0.00", currency: "UAH" },
          { rowNumber: 4, number: null, service: "Всього", amount: "70.00", currency: "UAH", lineKind: "total" },
        ],
      }),
      { candidates: cands },
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.ledger.entries.map((e) => [e.category, e.amount, e.orderId])).toEqual([["duties_paid", "-70.00", null]]);
    expect(r.summary).toMatchObject({ lines: 1, totalRows: 1, noNumber: { count: 1, amount: "70.00" } });
  });
  it("ті самі байти — відмова навіть під іншим номером (рівень а); інший рахунок клієнта — інший документ (рівень б)", () => {
    const r = saveImport(emptyImportLedger(), doc({ total: { amount: "10.00", currency: "UAH" } }), { candidates: cands });
    if (!r.ok) throw new Error(r.error);
    const again = saveImport(r.ledger, doc({ id: "d2", invoiceNumber: "R-2" }), { candidates: cands });
    expect(again.ok ? null : again.error).toBe("same_file");
    const otherAccount = saveImport(r.ledger, doc({ id: "d3", accountRef: "acc-2", sha256: "sha-3", total: { amount: "10.00", currency: "UAH" } }), { candidates: cands });
    expect(otherAccount.ok).toBe(true);
    // Номер: обрізати, верхній регістр, без внутрішніх пробілів (NBSP теж) → той самий номер і вид.
    expect(saveImport(r.ledger, doc({ id: "d5", invoiceNumber: " r-\u00a01 ", sha256: "sha-5" }), { candidates: cands })).toMatchObject({ ok: false, error: "same_number_kind" });
  });
  it("рядок, замінений ще до визнання замовлення, НІКОЛИ не проводиться (ні запису, ні сторно); нова версія — перше фактичне (R1)", () => {
    const line = { id: "l1", waybillId: "wb-g1", documentId: "v1", chargeType: "delivery" as const, amount: "540.00", currency: "UAH", serviceDate: "2026-10-02", importedAt: "2026-10-03T09:00:00Z", reversedAt: "2026-10-04T09:00:00Z" };
    const p = postOrder({ ...base, invoiceLines: [line, { ...line, id: "l2", documentId: "v2", amount: "530.00", importedAt: "2026-10-04T09:00:00Z", reversedAt: null }] }, AT);
    expect(p.entries.filter((e) => e.category === "shipping_cost").map((e) => [e.key, e.amount, e.recognizedOn, e.fxOn, e.isLateCompletion])).toEqual([["inv:l2:m1", "-530.00", "2026-10-05", "2026-10-02", false]]);
    // Замінений після визнання — запис і його сторно (датою й курсом оригіналу).
    const q = postOrder({ ...base, invoiceLines: [{ ...line, reversedAt: "2026-10-20T09:00:00Z" }] }, AT);
    expect(q.entries.filter((e) => e.category === "shipping_cost").map((e) => [e.amount, e.recognizedOn, e.fxOn])).toEqual([["-540.00", "2026-10-05", "2026-10-02"], ["540.00", "2026-10-05", "2026-10-02"]]);
    expect(q.order.components.shipping_cost?.state).not.toBe("actual");
  });
  it("заміна версії з записами в закритому місяці: сторно — пізній запис з fx_on оригіналу (I14)", () => {
    const v1 = doc({ rows: [{ rowNumber: 2, number: "20450000000099", service: "Доставка", amount: "300.00", currency: "UAH" }], importedAt: "2026-10-31T09:00:00Z" });
    const r = saveImport(emptyImportLedger(), v1, { candidates: cands, closures });
    if (!r.ok) throw new Error(r.error);
    const v2 = saveImport(r.ledger, { ...v1, id: "d1-v2", sha256: "sha-2", importedAt: "2026-11-07T09:00:00Z" }, { candidates: cands, closures }, { replace: { reason: "виправлення" } });
    if (!v2.ok) throw new Error(v2.error);
    expect(v2.ledger.entries.map((e) => [e.amount, e.recognizedOn, e.fxOn, e.isLate, e.reversesKey !== null])).toEqual([
      ["-300.00", "2026-10-30", "2026-10-30", false, false],
      ["300.00", "2026-11-07", "2026-10-30", true, true],
      ["-300.00", "2026-11-07", "2026-10-30", true, false],
    ]);
  });
});

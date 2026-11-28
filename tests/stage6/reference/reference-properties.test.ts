/**
 * Етап 6 (WP12a): власні властивості еталонної моделі на випадкових наборах (генератор із зерном, без нової
 * залежності) — I1/I2 (C0 і збереження вартості рушія), I6-частина (валюти з 0 знаками), I7 (allocate), I8 (довідкові
 * не впливають на прибуток), I10 (партнер), I13 (стани + період = прибуток), I14 (сторно = 0), I15 (наживо й із
 * знімками закритих місяців), а також дати Києва.
 * Ці самі генератори WP12b використовує для I5 (застосунок = модель).
 */
import { describe, expect, it } from "vitest";
import {
  allocate,
  cents,
  closeMonth,
  commissionFor,
  convert,
  divRound,
  kyivDate,
  monthReport,
  partnerLedger,
  pnlReport,
  productRanking,
  profitByStates,
  rangeReport,
  REF_CATEGORY_NAMES,
  affectsProfit,
  reverseEntry,
  runCosting,
  str,
  sumConverted,
  type CostMovement,
  type RefCategory,
  type RefEntry,
  type RefJournal,
  type RefMonthClosure,
  type RefOrderMeta,
  type RefRate,
  type RefReportSnapshot,
  type ReportSources,
} from "./model";

/** mulberry32 — детермінований генератор (зерно фіксоване, падіння відтворюється). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

const CURRENCIES = ["UAH", "EUR", "USD", "GBP", "PLN", "JPY", "KRW"] as const;
const DAYS = Array.from({ length: 10 }, (_, i) => `2026-11-${String(i + 1).padStart(2, "0")}`);

function randomRates(r: () => number): RefRate[] {
  const out: RefRate[] = [];
  for (const d of DAYS) {
    out.push({ currency: "EUR", date: d, rate: `${int(r, 45, 52)}.${String(int(r, 0, 9999)).padStart(4, "0")}`, source: "nbu" });
    out.push({ currency: "USD", date: d, rate: `${int(r, 40, 46)}.${String(int(r, 0, 9999)).padStart(4, "0")}`, source: "nbu" });
    out.push({ currency: "GBP", date: d, rate: `${int(r, 52, 58)}.${String(int(r, 0, 9999)).padStart(4, "0")}`, source: "nbu" });
    out.push({ currency: "PLN", date: d, rate: `${int(r, 10, 12)}.${String(int(r, 0, 9999)).padStart(4, "0")}`, source: "nbu" });
    out.push({ currency: "JPY", date: d, rate: `2.${String(int(r, 500, 999)).padStart(3, "0")}`, units: 10, source: "nbu" });
    out.push({ currency: "KRW", date: d, rate: `3.${String(int(r, 0, 9999)).padStart(4, "0")}`, units: 100, source: "nbu" });
  }
  return out;
}

function randomAmount(r: () => number, currency: string): string {
  const v = BigInt(int(r, 1, 5_000_000)) * (currency === "JPY" || currency === "KRW" ? 100n : 1n);
  return str(r() < 0.5 ? -v : v);
}

describe("I7 — allocate сумує точно, найбільші остачі, нічия — менший індекс", () => {
  it("10 000 випадкових розподілів", () => {
    const r = rng(7);
    for (let i = 0; i < 10_000; i++) {
      const n = int(r, 1, 12);
      const weights = Array.from({ length: n }, () => BigInt(int(r, 0, 1000)));
      if (!weights.some((w) => w > 0n)) weights[0] = 1n;
      const total = BigInt(int(r, -1_000_000, 1_000_000));
      const parts = allocate(total, weights);
      expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
      const W = weights.reduce((a, b) => a + b, 0n);
      parts.forEach((p, k) => {
        const exact = (total < 0n ? -total : total) * weights[k]!;
        const lo = exact / W;
        const mag = p < 0n ? -p : p;
        expect(mag === lo || mag === lo + 1n).toBe(true);
      });
    }
    expect(allocate(1n, [1n, 1n])).toEqual([1n, 0n]);
    expect(allocate(-1n, [1n, 1n])).toEqual([-1n, 0n]);
  });
});

describe("конвертація: валюти з 0 знаками, Σ сконвертованих, одне округлення на запис", () => {
  it("результат у JPY/KRW завжди цілий; тотожна валюта — без змін; sumConverted = Σ окремих", () => {
    const r = rng(11);
    const rates = randomRates(r);
    const ctx = { rates };
    for (let i = 0; i < 3_000; i++) {
      const from = pick(r, CURRENCIES);
      const to = pick(r, CURRENCIES);
      const d = pick(r, DAYS);
      const a = cents(randomAmount(r, from));
      const c = convert(a, from, to, d, ctx)!;
      expect(c).not.toBeNull();
      if (to === "JPY" || to === "KRW") expect(c % 100n).toBe(0n);
      if (from === to) expect(c).toBe(a);
      // Знак зберігається, нуль — лише з нуля.
      expect(c === 0n || (c < 0n) === (a < 0n)).toBe(true);
    }
    const items = Array.from({ length: 50 }, () => {
      const cur = pick(r, CURRENCIES);
      return { amount: randomAmount(r, cur), currency: cur, fxOn: pick(r, DAYS) };
    });
    const s = sumConverted(items, "EUR", ctx);
    const manual = items.reduce((acc, it) => acc + convert(cents(it.amount), it.currency, "EUR", it.fxOn, ctx)!, 0n);
    expect(s.total).toBe(str(manual));
    const withMissing = sumConverted([...items, { amount: "5.00", currency: "CHF", fxOn: DAYS[0]! }], "EUR", ctx);
    expect(withMissing.total).toBe(str(manual));
    expect(withMissing.unconverted).toEqual([{ currency: "CHF", amount: "5.00", entries: 1 }]);
    expect(sumConverted([{ amount: "5.00", currency: "CHF", fxOn: DAYS[0]! }], "EUR", ctx).total).toBeNull();
  });
});

function randomEntry(r: () => number, i: number, orderIds: readonly string[]): RefEntry {
  const category = pick(r, REF_CATEGORY_NAMES) as RefCategory;
  const currency = pick(r, CURRENCIES);
  const d = pick(r, DAYS);
  return {
    key: `e${i}`,
    orderId: r() < 0.7 ? pick(r, orderIds) : null,
    category,
    amount: randomAmount(r, currency),
    currency,
    recognizedOn: d,
    fxOn: pick(r, DAYS),
    originalOn: d,
    isLate: false,
    isLateCompletion: false,
    reversesKey: null,
  };
}

describe("I14 — запис + сторно = 0 у кожній валюті показу (fx_on копіюється)", () => {
  it("2 000 випадкових пар", () => {
    const r = rng(14);
    const ctx = { rates: randomRates(r) };
    for (let i = 0; i < 2_000; i++) {
      const e = randomEntry(r, i, ["o1"]);
      const rev = reverseEntry(e, "2026-11-20T10:00:00Z", r() < 0.5 ? [] : [{ month: "2026-11", closedAt: "2026-11-15T00:00:00Z", allConfirmedWithTaxes: true }]);
      expect(rev.fxOn).toBe(e.fxOn);
      for (const cur of CURRENCIES) {
        const a = convert(cents(e.amount), e.currency, cur, e.fxOn, ctx)!;
        const b = convert(cents(rev.amount), rev.currency, cur, rev.fxOn, ctx)!;
        expect(a + b).toBe(0n);
      }
    }
  });
});

describe("P&L моделі: стовпці = разом, I8, I13", () => {
  it("на 300 випадкових журналах", () => {
    const r = rng(13);
    const ctx = { rates: randomRates(r) };
    const states: RefOrderMeta["state"][] = ["final", "preliminary", "incomplete", "closed_unrecognized", "excluded"];
    for (let k = 0; k < 300; k++) {
      const ids = Array.from({ length: int(r, 1, 6) }, (_, i) => `o${i}`);
      const orders: RefOrderMeta[] = ids.map((id) => ({ orderId: id, state: pick(r, states), recognizedOn: pick(r, DAYS), components: { revenue: { state: "actual" }, cogs: { state: r() < 0.7 ? "actual" : "missing" } } }));
      const entries = Array.from({ length: int(r, 0, 40) }, (_, i) => randomEntry(r, i, ids));
      const j: RefJournal = { entries, orders, forecasts: [] };
      const o = { from: DAYS[0]!, to: DAYS[9]!, currency: pick(r, ["UAH", "EUR", "JPY"] as const), ctx };
      const p = pnlReport(j, o);
      for (const line of Object.keys(p.columns.total)) {
        const sumCols = (["final", "preliminary", "incomplete", "period"] as const).reduce((a, c) => a + cents(p.columns[c][line] ?? "0.00"), 0n);
        expect(sumCols).toBe(cents(p.columns.total[line]!));
      }
      const profitTotal = entries.filter((e) => affectsProfit(e.category)).reduce((a, e) => a + convert(cents(e.amount), e.currency, o.currency, e.fxOn, ctx)!, 0n);
      const s = profitByStates(j, o);
      expect(cents(s.final) + cents(s.preliminary) + cents(s.incomplete) + cents(s.period)).toBe(profitTotal);
      if (p.profit.fact !== null) expect(cents(p.profit.fact)).toBe(cents(s.final) + cents(s.period));
      // I8: додані довідкові записи не змінюють прибуток.
      const memo: RefEntry[] = Array.from({ length: 5 }, (_, i) => ({ ...randomEntry(r, 1000 + i, ids), category: "tax_collected_memo" as const }));
      const p2 = pnlReport({ ...j, entries: [...entries, ...memo] }, o);
      expect(p2.profit).toEqual(p.profit);
      expect(p2.turnover).toBe(p.turnover);
    }
  });
});

describe("I10 — винагорода = round(база × ставка); баланс = Σ подій − Σ виплат", () => {
  it("на випадкових даних", () => {
    const r = rng(10);
    for (let k = 0; k < 500; k++) {
      const base = BigInt(int(r, 0, 10_000_000));
      const bp = int(r, 0, 5000);
      expect(commissionFor(base, bp)).toBe(divRound(base * BigInt(bp), 10000n));
      const orders = Array.from({ length: int(r, 1, 5) }, (_, i) => ({
        orderId: `o${i}`,
        recognizedOn: pick(r, DAYS),
        holdDays: int(r, 0, 5),
        events: Array.from({ length: int(r, 1, 3) }, (_, n) => ({ n: n + 1, kind: (n === 0 ? "accrual" : "adjustment") as "accrual" | "adjustment", amount: BigInt(int(r, -500, 2000)), date: pick(r, DAYS) })),
      }));
      const payouts = Array.from({ length: int(r, 0, 3) }, (_, i) => ({ id: `p${i}`, paidOn: pick(r, DAYS), covers: str(BigInt(int(r, 1, 3000))) }));
      const today = "2026-11-30";
      const res = partnerLedger(orders, payouts, today);
      const events = orders.flatMap((o) => o.events).reduce((a, e) => a + e.amount, 0n);
      const paid = payouts.reduce((a, p) => a + cents(p.covers), 0n);
      expect(cents(res.balance)).toBe(events - paid);
      expect(cents(res.payable) >= 0n).toBe(true);
    }
  });
});

describe("I1/I2 — рушій собівартості: C0 після кожного руху, вартість зберігається", () => {
  it("1 000 випадкових послідовностей", () => {
    const r = rng(2);
    const seen = { revaluation: 0, saleCompletion: 0, returnLayer: 0, deficit: 0, customerReturn: 0 };
    for (let k = 0; k < 1_000; k++) {
      const moves: CostMovement[] = [];
      const orders: string[] = [];
      const receipts: Array<{ id: string; posted: bigint }> = [];
      const n = int(r, 1, 25);
      for (let i = 0; i < n; i++) {
        const d = `2026-09-${String(1 + Math.floor((i * 28) / n)).padStart(2, "0")}`;
        const x = r();
        if (x < 0.25) {
          const good = int(r, 0, 10);
          const defect = int(r, 0, 2);
          const unitCost = r() < 0.8 ? str(BigInt(int(r, 1000, 20000))) : null;
          moves.push({ kind: "receipt", id: `r${i}`, date: d, good, defect, unitCost });
          if (unitCost !== null && good > 0) receipts.push({ id: `r${i}`, posted: cents(unitCost) * BigInt(good + defect) });
        } else if (x < 0.55) {
          const orderId = `o${i}`;
          orders.push(orderId);
          moves.push({ kind: "outflow", id: `s${i}`, date: d, qty: int(r, 1, 6), reason: pick(r, ["sale", "sale", "sale", "defect_mark", "adjustment", "test_sale"] as const), orderId });
        } else if (x < 0.62) moves.push({ kind: "opening", id: `op${i}`, date: d, qty: int(r, 1, 5) });
        else if (x < 0.7 && orders.length) moves.push({ kind: "customer_return", id: `ret${i}`, date: d, orderId: pick(r, orders), good: int(r, 1, 2), damaged: int(r, 0, 1) });
        else if (x < 0.76) moves.push({ kind: "defect_repair", id: `dr${i}`, date: d, qty: int(r, 1, 2) });
        else if (x < 0.8) moves.push({ kind: "defect_writeoff", id: `dw${i}`, date: d, qty: int(r, 1, 2) });
        else if (x < 0.86) moves.push({ kind: "surplus", id: `sp${i}`, date: d, qty: int(r, 1, 3) });
        else if (x < 0.93) moves.push({ kind: "completion", id: `c${i}`, date: d, unitCost: str(BigInt(int(r, 1000, 20000))), effectiveFrom: "2026-09-01", toStock: r() < 0.5, toSold: r() < 0.7 });
        else if (receipts.length) {
          const rc = pick(r, receipts);
          moves.push({ kind: "revalue", id: `rv${i}`, date: "2026-10-15", receiptId: rc.id, target: str(BigInt(int(r, 0, 300000))) });
        }
      }
      const res = runCosting(moves); // C0 — виняток усередині рушія
      // I2: Σ входів (надходження, доходи, повернення, завершення власника, Δ коригувань) = Σ виходів + вартість пулу.
      let input = 0n;
      for (const e of res.effects) {
        if (e.category === "production_capitalized_memo" || e.category === "materials_purchased_memo" || e.category === "inventory_gain" || e.category === "cogs_return") input += e.amount;
      }
      const ownerCompletionIds = new Set(moves.filter((m) => m.kind === "completion").map((m) => m.id));
      for (const v of res.valuations) if (ownerCompletionIds.has(v.movementId) && (v.kind === "sale_completion" || v.kind === "stock_completion")) input += v.value;
      const posted = new Map(receipts.map((x) => [x.id, x.posted]));
      for (const m of moves) {
        if (m.kind !== "revalue") continue;
        const prev = posted.get(m.receiptId)!;
        input += cents(m.target) - prev;
        posted.set(m.receiptId, cents(m.target));
      }
      let output = 0n;
      for (const e of res.effects) {
        if (["cogs", "cogs_adjustment", "inventory_loss", "packaging", "packaging_unlinked"].includes(e.category)) output += -e.amount;
      }
      expect(input).toBe(output + res.state.knownValue);
      expect(res.state.knownValue >= 0n).toBe(true);
      seen.revaluation += res.valuations.filter((v) => v.kind === "revaluation").length;
      seen.saleCompletion += res.valuations.filter((v) => v.kind === "sale_completion").length;
      seen.returnLayer += res.layers.filter((l) => l.reason === "return_without_cost").length;
      seen.deficit += res.layers.filter((l) => l.kind === "deficit").length;
      seen.customerReturn += res.valuations.filter((v) => v.reason === "customer_return").length;
    }
    // Генератор справді покриває складні шляхи (не порожня перевірка).
    for (const [k, v] of Object.entries(seen)) expect(v, k).toBeGreaterThan(20);
  });
});

describe("рейтинг товарів: розподілені витрати замовлення сумуються точно", () => {
  it("на випадкових замовленнях", () => {
    const r = rng(16);
    for (let k = 0; k < 300; k++) {
      const entries: RefEntry[] = [];
      const lines = [];
      let costs = 0n;
      const nProducts = int(r, 1, 4);
      for (let p = 0; p < nProducts; p++) {
        const lineId = `L${p}`;
        lines.push({ orderId: "X", lineId, productId: `P${p}`, cogsSettled: true });
        entries.push({ key: `s${p}`, orderId: "X", lineId, productId: `P${p}`, category: "sales_product", amount: str(BigInt(int(r, 100, 100000))), currency: "UAH", recognizedOn: DAYS[0]!, fxOn: DAYS[0]!, originalOn: DAYS[0]!, isLate: false, isLateCompletion: false, reversesKey: null });
      }
      for (let c = 0; c < int(r, 1, 4); c++) {
        const v = -BigInt(int(r, 1, 50000));
        costs += v;
        entries.push({ key: `c${c}`, orderId: "X", category: pick(r, ["shipping_cost", "packaging", "payment_fees", "partner_commission"] as const), amount: str(v), currency: "UAH", recognizedOn: DAYS[0]!, fxOn: DAYS[0]!, originalOn: DAYS[0]!, isLate: false, isLateCompletion: false, reversesKey: null });
      }
      const res = productRanking({ entries, orders: [{ orderId: "X", state: "final", recognizedOn: DAYS[0]! }], forecasts: [] }, lines, { from: DAYS[0]!, to: DAYS[9]!, currency: "UAH", ctx: { rates: [] }, top: 100 });
      expect(res.rows.reduce((a, x) => a + cents(x.allocatedCosts), 0n)).toBe(costs);
    }
  });
});

describe("дати Києва = Intl (Europe/Kyiv) на випадкових моментах 2020–2032", () => {
  it("20 000 моментів, зокрема навколо переходів часу", () => {
    const r = rng(3);
    const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" });
    const from = Date.UTC(2020, 0, 1);
    const to = Date.UTC(2032, 11, 31);
    for (let i = 0; i < 20_000; i++) {
      const ms = from + Math.floor(r() * (to - from));
      const iso = new Date(ms).toISOString();
      expect(kyivDate(iso)).toBe(fmt.format(new Date(ms)));
    }
    for (const iso of ["2026-03-29T00:59:59Z", "2026-03-29T01:00:00Z", "2026-10-25T00:59:59Z", "2026-10-25T01:00:00Z", "2026-10-24T21:00:00Z", "2026-10-25T21:59:59Z", "2026-10-25T22:00:00Z"]) {
      expect(kyivDate(iso)).toBe(fmt.format(new Date(iso)));
    }
  });
});

describe("I15 (живий перерахунок) — рядки діапазону = Σ рядків його місяців", () => {
  it("на 200 випадкових журналах за 3 місяці", () => {
    const r = rng(15);
    const rates: RefRate[] = [];
    const days: string[] = [];
    for (const m of ["2026-09", "2026-10", "2026-11"]) for (const d of ["03", "15", "28"]) days.push(`${m}-${d}`);
    for (const d of days) {
      rates.push({ currency: "EUR", date: d, rate: `${int(r, 45, 52)}.${String(int(r, 0, 9999)).padStart(4, "0")}`, source: "nbu" });
      rates.push({ currency: "JPY", date: d, rate: `2.${String(int(r, 500, 999)).padStart(3, "0")}`, units: 10, source: "nbu" });
    }
    const ctx = { rates };
    for (let k = 0; k < 200; k++) {
      const entries: RefEntry[] = Array.from({ length: int(r, 0, 30) }, (_, i) => {
        const cur = pick(r, ["UAH", "EUR", "JPY"] as const);
        const d = pick(r, days);
        return { key: `e${i}`, orderId: r() < 0.5 ? `o${int(r, 0, 3)}` : null, category: pick(r, REF_CATEGORY_NAMES) as RefCategory, amount: randomAmount(r, cur), currency: cur, recognizedOn: d, fxOn: d, originalOn: d, isLate: false, isLateCompletion: false, reversesKey: null };
      });
      const orders: RefOrderMeta[] = [0, 1, 2, 3].map((i) => ({ orderId: `o${i}`, state: pick(r, ["final", "preliminary", "incomplete"] as const), recognizedOn: pick(r, days) }));
      const j: RefJournal = { entries, orders, forecasts: [] };
      const cur = pick(r, ["UAH", "EUR"] as const);
      const range = pnlReport(j, { from: "2026-09-01", to: "2026-11-30", currency: cur, ctx });
      const months = ["2026-09", "2026-10", "2026-11"].map((m) => pnlReport(j, { from: `${m}-01`, to: `${m}-${m === "2026-09" || m === "2026-11" ? "30" : "31"}`, currency: cur, ctx }));
      for (const line of Object.keys(range.columns.total)) {
        expect(months.reduce((a, p) => a + cents(p.columns.total[line] ?? "0.00"), 0n)).toBe(cents(range.columns.total[line]!));
      }
    }
  });
});

describe("I15 (закриті місяці зі знімків) — закритий місяць = його знімок; діапазон = Σ місяців", () => {
  it("на 40 випадкових журналах: курси після закриття змінено, листопад відкритий", () => {
    const r = rng(1515);
    const months = ["2026-09", "2026-10", "2026-11"] as const;
    const days: string[] = [];
    for (const m of months) for (const d of ["03", "15", "28"]) days.push(`${m}-${d}`);
    let differs = 0;
    for (let k = 0; k < 40; k++) {
      const atClose: RefRate[] = [];
      const later: RefRate[] = [];
      for (const d of days) {
        const eur = `${int(r, 45, 52)}.${String(int(r, 0, 9999)).padStart(4, "0")}`;
        const jpy = `2.${String(int(r, 500, 998)).padStart(3, "0")}`;
        atClose.push({ currency: "EUR", date: d, rate: eur, source: "nbu" }, { currency: "JPY", date: d, rate: jpy, units: 10, source: "nbu" });
        // «Отримано пізніше»: ручні курси інших значень на ті самі дати (живий перерахунок змінюється, знімок — ні).
        later.push({ currency: "EUR", date: d, rate: `${int(r, 45, 52)}.${String(int(r, 0, 9999)).padStart(4, "0")}`, source: "manual" }, { currency: "JPY", date: d, rate: jpy, units: 10, source: "nbu" });
      }
      // Неостаточні замовлення — лише у відкритому листопаді (інакше закриття заблоковано чек-листом).
      const orders: RefOrderMeta[] = [0, 1, 2, 3].map((i) => {
        const state = pick(r, ["final", "preliminary", "incomplete"] as const);
        return { orderId: `o${i}`, state, recognizedOn: state === "final" ? pick(r, days) : pick(r, days.slice(6)) };
      });
      const entries: RefEntry[] = Array.from({ length: int(r, 0, 30) }, (_, i) => {
        const cur = pick(r, ["UAH", "EUR", "JPY"] as const);
        const d = pick(r, days);
        return { key: `e${i}`, orderId: r() < 0.5 ? `o${int(r, 0, 3)}` : null, category: pick(r, REF_CATEGORY_NAMES) as RefCategory, amount: randomAmount(r, cur), currency: cur, recognizedOn: d, fxOn: d, originalOn: d, isLate: false, isLateCompletion: false, reversesKey: null };
      });
      const closed = months.slice(0, 2).filter(() => r() < 0.6);
      const closures: RefMonthClosure[] = [];
      const snapshots: RefReportSnapshot[] = [];
      for (const m of closed) {
        const c = closeMonth({ entries, orders, forecasts: [] }, { month: m, closedAt: "2026-12-01T10:00:00Z", displayCurrencies: ["UAH", "EUR"], ctx: { rates: atClose }, allConfirmedWithTaxes: true });
        if (!c.ok) throw new Error(JSON.stringify(c.blockers));
        closures.push(c.closure);
        snapshots.push(...c.snapshots);
      }
      const src: ReportSources = { journal: { entries, orders, forecasts: [] }, ctx: { rates: later }, snapshots, closures, at: "2026-12-05T00:00:00Z" };
      for (const cur of ["UAH", "EUR"] as const) {
        const reports = months.map((m) => monthReport(m, cur, src));
        for (const [i, m] of months.entries()) {
          const rep = reports[i]!;
          expect(rep.source).toBe(closed.includes(m) ? "snapshot" : "live");
          if (rep.source === "snapshot") {
            expect(rep.report).toEqual(snapshots.find((s) => s.month === m && s.currency === cur)!.report);
            const live = pnlReport(src.journal, { from: `${m}-01`, to: `${m}-30`, currency: cur, ctx: src.ctx });
            if (live.raw.factValue !== rep.report.raw.factValue) differs += 1;
          }
        }
        const range = rangeReport("2026-09-01", "2026-11-30", cur, src);
        for (const line of new Set(reports.flatMap((p) => Object.keys(p.report.columns.total)))) {
          expect(range.columns.total[line] ?? "0.00").toBe(str(reports.reduce((a, p) => a + cents(p.report.columns.total[line] ?? "0.00"), 0n)));
        }
        expect(range.raw.factValue).toBe(str(reports.reduce((a, p) => a + cents(p.report.raw.factValue), 0n)));
        expect(range.raw.forecastValue).toBe(str(reports.reduce((a, p) => a + cents(p.report.raw.forecastValue), 0n)));
      }
    }
    // Генератор справді створює випадки, де живий перерахунок закритого місяця відрізняється від знімка.
    expect(differs).toBeGreaterThan(0);
  });
});

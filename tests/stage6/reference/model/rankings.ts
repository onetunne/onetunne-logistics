/**
 * Еталонна модель (WP12a): рейтинги «замовлення періоду» (§12.1–§12.2) — товари з розподілом витрат замовлення за
 * часткою чистої виручки (найбільші остачі), країни за станами, моделі й кольори; собівартість моделі (§6.7).
 */
import { allocate, cents, divRound, percent1, str, type Cents } from "./money";
import { affectsProfit, kindOf, type RefCategory } from "./categories";
import { Converter, orderProfit, type RefJournal, type ReportOptions } from "./pnl";

export interface RankLine {
  orderId: string;
  lineId: string;
  productId: string;
  model?: string | null;
  color?: string | null;
  /** Стан собівартості позиції: лише settled-позиції входять у рейтинг (інакше — «показати неповні»). */
  cogsSettled: boolean;
}

/** Категорії витрат замовлення, що розподіляються на товари (доставка, упаковка, комісії, партнер, мито). */
const ALLOCATED_KINDS = new Set(["order_cost"]);

export interface ProductRow {
  productId: string;
  netRevenue: string;
  cogs: string;
  gross: string;
  margin: string | null;
  allocatedCosts: string;
  grossAfterAllocation: string;
  complete: boolean;
}

const RECOGNIZED = new Set(["final", "preliminary", "incomplete"]);

/** Рейтинг товарів: валовий прибуток точно (без розподілу) + другорядно з розподіленими витратами замовлення. */
export function productRanking(j: RefJournal, lines: readonly RankLine[], o: ReportOptions & { showIncomplete?: boolean; top?: number }): { rows: ProductRow[]; others: ProductRow | null; hiddenIncomplete: string[] } {
  const orders = j.orders.filter((m) => RECOGNIZED.has(m.state) && m.recognizedOn !== null && m.recognizedOn >= o.from && m.recognizedOn <= o.to);
  const ids = new Set(orders.map((m) => m.orderId));
  const conv = new Converter(o.currency, o.ctx);
  const productOfLine = new Map(lines.map((l) => [l.lineId, l]));
  const acc = new Map<string, { nr: Cents; cogs: Cents; alloc: Cents; complete: boolean }>();
  const row = (p: string) => {
    let r = acc.get(p);
    if (!r) acc.set(p, (r = { nr: 0n, cogs: 0n, alloc: 0n, complete: true }));
    return r;
  };
  for (const l of lines) if (ids.has(l.orderId) && !l.cogsSettled) row(l.productId).complete = false;
  for (const orderId of ids) {
    const nrByProduct = new Map<string, Cents>();
    let orderCosts = 0n;
    for (const e of j.entries) {
      if (e.orderId !== orderId) continue;
      const v = conv.of(e);
      if (v === null) continue;
      const productId = e.productId ?? (e.lineId ? productOfLine.get(e.lineId)?.productId : undefined) ?? null;
      if ((e.category === "sales_product" || e.category === "refund_product") && productId) {
        row(productId).nr += v;
        nrByProduct.set(productId, (nrByProduct.get(productId) ?? 0n) + v);
      } else if ((e.category === "cogs" || e.category === "cogs_return") && productId) row(productId).cogs += v;
      else if (ALLOCATED_KINDS.has(kindOf(e.category))) orderCosts += v;
    }
    const products = [...nrByProduct.keys()].sort();
    const weights = products.map((p) => {
      const w = nrByProduct.get(p)!;
      return w > 0n ? w : 0n;
    });
    if (orderCosts !== 0n && weights.some((w) => w > 0n)) {
      const parts = allocate(orderCosts, weights);
      products.forEach((p, i) => (row(p).alloc += parts[i]!));
    }
  }
  const render = (productId: string, r: { nr: Cents; cogs: Cents; alloc: Cents; complete: boolean }): ProductRow => ({
    productId,
    netRevenue: str(r.nr),
    cogs: str(r.cogs),
    gross: str(r.nr + r.cogs),
    margin: percent1(r.nr + r.cogs, r.nr),
    allocatedCosts: str(r.alloc),
    grossAfterAllocation: str(r.nr + r.cogs + r.alloc),
    complete: r.complete,
  });
  const all = [...acc.entries()].map(([p, r]) => render(p, r));
  const hiddenIncomplete = all.filter((r) => !r.complete).map((r) => r.productId).sort();
  const visible = all.filter((r) => r.complete || o.showIncomplete).sort((a, b) => {
    const d = cents(b.gross) - cents(a.gross);
    return d === 0n ? (a.productId < b.productId ? -1 : 1) : d > 0n ? 1 : -1;
  });
  const top = o.top ?? 10;
  const rows = visible.slice(0, top);
  const rest = visible.slice(top);
  let others: ProductRow | null = null;
  if (rest.length) {
    const s = (k: keyof ProductRow) => rest.reduce((a, r) => a + cents(r[k] as string), 0n);
    const nr = s("netRevenue");
    const gross = s("gross");
    others = { productId: "__others__", netRevenue: str(nr), cogs: str(s("cogs")), gross: str(gross), margin: percent1(gross, nr), allocatedCosts: str(s("allocatedCosts")), grossAfterAllocation: str(s("grossAfterAllocation")), complete: rest.every((r) => r.complete) };
  }
  return { rows, others, hiddenIncomplete };
}

export interface CountryRow {
  country: string;
  orders: number;
  turnover: string;
  averageCheck: string | null;
  profitFact: string | null;
  profitForecast: string | null;
  factOrders: number;
  margin: string | null;
  averageShipping: string | null;
}

/** Країни (§12.2): прибуток замовлень за станами (факт — final), витрати періоду — рядком «Не розподілено». */
export function countryRanking(j: RefJournal, o: ReportOptions): { rows: CountryRow[]; unallocated: string } {
  const orders = j.orders.filter((m) => RECOGNIZED.has(m.state) && m.recognizedOn !== null && m.recognizedOn >= o.from && m.recognizedOn <= o.to);
  const by = new Map<string, typeof orders>();
  for (const m of orders) {
    const k = m.country ?? "??";
    by.set(k, [...(by.get(k) ?? []), m]);
  }
  const conv = new Converter(o.currency, o.ctx);
  const rows: CountryRow[] = [];
  for (const [country, ms] of [...by.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    let t = 0n;
    let nActual = 0;
    let fact = 0n;
    let factNr = 0n;
    let nFinal = 0;
    let fc = 0n;
    let nFc = 0;
    let ship = 0n;
    let nShip = 0;
    for (const m of ms) {
      const op = orderProfit(j, m.orderId, o.currency, o.ctx);
      if (m.components?.revenue?.state === "actual") {
        t += op.turnover;
        nActual += 1;
      }
      if (m.state === "final") {
        fact += op.entriesProfit;
        factNr += op.netRevenue;
        nFinal += 1;
      }
      if (m.state === "final" || m.state === "preliminary") {
        fc += op.entriesProfit + (m.state === "preliminary" ? op.forecast : 0n);
        nFc += 1;
      }
      if (m.components?.shipping_cost?.state === "actual") {
        let s = 0n;
        for (const e of j.entries) {
          if (e.orderId === m.orderId && (e.category === "shipping_cost" || e.category === "return_shipping_cost")) {
            const v = conv.of(e);
            if (v !== null) s += v;
          }
        }
        ship += s;
        nShip += 1;
      }
    }
    rows.push({
      country,
      orders: ms.length,
      turnover: str(t),
      averageCheck: nActual > 0 ? str(divRound(t, BigInt(nActual))) : null,
      profitFact: nFinal > 0 ? str(fact) : null,
      profitForecast: nFc > 0 ? str(fc) : null,
      factOrders: nFinal,
      margin: nFinal > 0 ? percent1(fact, factNr) : null,
      averageShipping: nShip > 0 ? str(divRound(ship, BigInt(nShip))) : null,
    });
  }
  let unallocated = 0n;
  for (const e of j.entries) {
    if (e.orderId || e.recognizedOn < o.from || e.recognizedOn > o.to || !affectsProfit(e.category)) continue;
    const v = conv.of(e);
    if (v !== null) unallocated += v;
  }
  return { rows, unallocated: str(unallocated) };
}

/** Рентабельність моделей і кольорів (§12.2): валовий прибуток / чиста виручка за model × color. */
export function modelColorRanking(j: RefJournal, lines: readonly RankLine[], o: ReportOptions): Array<{ model: string; color: string; netRevenue: string; gross: string; margin: string | null }> {
  const orders = new Set(j.orders.filter((m) => RECOGNIZED.has(m.state) && m.recognizedOn !== null && m.recognizedOn >= o.from && m.recognizedOn <= o.to).map((m) => m.orderId));
  const byLine = new Map(lines.map((l) => [l.lineId, l]));
  const conv = new Converter(o.currency, o.ctx);
  const acc = new Map<string, { nr: Cents; g: Cents }>();
  for (const e of j.entries) {
    if (!e.orderId || !orders.has(e.orderId) || !e.lineId) continue;
    const l = byLine.get(e.lineId);
    if (!l || !l.cogsSettled) continue;
    const isNr = e.category === "sales_product" || e.category === "refund_product";
    const isCogs = e.category === "cogs" || e.category === "cogs_return";
    if (!isNr && !isCogs) continue;
    const v = conv.of(e);
    if (v === null) continue;
    const k = `${l.model ?? ""}\u0000${l.color ?? ""}`;
    const r = acc.get(k) ?? { nr: 0n, g: 0n };
    if (isNr) r.nr += v;
    r.g += v;
    acc.set(k, r);
  }
  return [...acc.entries()]
    .map(([k, r]) => {
      const [model, color] = k.split("\u0000") as [string, string];
      return { model, color, netRevenue: str(r.nr), gross: str(r.g), margin: percent1(r.g, r.nr) };
    })
    .sort((a, b) => (a.model + a.color < b.model + b.color ? -1 : 1));
}

/** Собівартість моделі (§6.7 б): середня на складі = Σ known_value / Σ known_qty (зважено за кількістю). */
export function modelStockCost(items: ReadonlyArray<{ model: string; color: string; knownQty: number; knownValue: string; manualCost?: string | null }>): Record<string, { average: string | null; byColor: Record<string, { average: string | null; manualCost: string | null }> }> {
  const out: Record<string, { average: string | null; byColor: Record<string, { average: string | null; manualCost: string | null }> }> = {};
  const models = [...new Set(items.map((i) => i.model))].sort();
  for (const m of models) {
    const xs = items.filter((i) => i.model === m);
    const q = xs.reduce((a, i) => a + i.knownQty, 0);
    const v = xs.reduce((a, i) => a + cents(i.knownValue), 0n);
    const byColor: Record<string, { average: string | null; manualCost: string | null }> = {};
    for (const c of [...new Set(xs.map((i) => i.color))].sort()) {
      const cs = xs.filter((i) => i.color === c);
      const cq = cs.reduce((a, i) => a + i.knownQty, 0);
      const cvv = cs.reduce((a, i) => a + cents(i.knownValue), 0n);
      byColor[c] = { average: cq > 0 ? str(divRound(cvv, BigInt(cq))) : null, manualCost: cs.find((i) => i.manualCost)?.manualCost ?? null };
    }
    out[m] = { average: q > 0 ? str(divRound(v, BigInt(q))) : null, byColor };
  }
  return out;
}

/** Собівартість проданої одиниці за період (§6.7 в): Σ cogs / Σ кількість (кількість — details.quantity записів cogs). */
export function soldUnitCost(entries: ReadonlyArray<{ category: RefCategory; amount: string; details?: Record<string, unknown> }>): string | null {
  let v = 0n;
  let q = 0;
  for (const e of entries) {
    if (e.category !== "cogs") continue;
    v += -cents(e.amount);
    q += Number(e.details?.quantity ?? 0);
  }
  return q > 0 ? str(divRound(v, BigInt(q))) : null;
}


// ---------------------------------------------------------------------------------------------------------------
// Ефективність партнера (§9.6) і доставка на замовлення (§7.7) — «замовлення періоду»
// ---------------------------------------------------------------------------------------------------------------

/**
 * Ефективність партнера: атрибутовані замовлення, визнані в P (усі їхні записи). Факт — лише final (покриття
 * показано); «Окупність» = прибуток після всіх витрат (з винагородою) ÷ (винагорода + фіксовані оплати періоду).
 */
export function partnerPerformance(
  j: RefJournal,
  attributedOrderIds: readonly string[],
  o: ReportOptions & { partnerId: string },
): { orders: number; finalOrders: number; turnover: string; averageCheck: string | null; commission: string; fixedFees: string; profitBefore: string | null; profitAfter: string | null; payback: string | null } {
  const ids = new Set(attributedOrderIds);
  const list = j.orders.filter((m) => ids.has(m.orderId) && RECOGNIZED.has(m.state) && m.recognizedOn !== null && m.recognizedOn >= o.from && m.recognizedOn <= o.to);
  const conv = new Converter(o.currency, o.ctx);
  let t = 0n;
  let nT = 0;
  let after = 0n;
  let commission = 0n;
  let nFinal = 0;
  for (const m of list) {
    const op = orderProfit(j, m.orderId, o.currency, o.ctx);
    if (m.components?.revenue?.state === "actual") {
      t += op.turnover;
      nT += 1;
    }
    if (m.state !== "final") continue;
    nFinal += 1;
    after += op.entriesProfit;
    for (const e of j.entries) {
      if (e.orderId !== m.orderId || e.category !== "partner_commission") continue;
      const v = conv.of(e);
      if (v !== null) commission += -v;
    }
  }
  let fixed = 0n;
  for (const e of j.entries) {
    if (e.category !== "partner_fixed_fee" || e.details?.partnerId !== o.partnerId || e.recognizedOn < o.from || e.recognizedOn > o.to) continue;
    const v = conv.of(e);
    if (v !== null) fixed += -v;
  }
  const denom = commission + fixed;
  return {
    orders: list.length,
    finalOrders: nFinal,
    turnover: str(t),
    averageCheck: nT > 0 ? str(divRound(t, BigInt(nT))) : null,
    commission: str(commission),
    fixedFees: str(fixed),
    profitBefore: nFinal > 0 ? str(after + commission) : null,
    profitAfter: nFinal > 0 ? str(after) : null,
    payback: nFinal > 0 && denom > 0n ? ratioStr(after, denom) : null,
  };
}

function ratioStr(num: Cents, den: Cents): string {
  const scaled = divRound(num * 100n, den);
  const neg = scaled < 0n;
  const a = neg ? -scaled : scaled;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

/**
 * Доставка на замовлення (§7.7): «Середня фактична доставка на замовлення» (лише складник actual), «без накладної: N»,
 * «сплачено покупцями vs фактично» = Σ (сплачено − факт) за замовленнями з фактом.
 */
export function orderShippingSummary(
  j: RefJournal & { orders: ReadonlyArray<RefJournal["orders"][number] & { components?: Partial<Record<string, { state: string; reason?: string | null }>> }> },
  o: ReportOptions,
): { averageActual: string | null; ordersWithActual: number; withoutWaybill: number; paidMinusActual: string } {
  const list = j.orders.filter((m) => RECOGNIZED.has(m.state) && m.recognizedOn !== null && m.recognizedOn >= o.from && m.recognizedOn <= o.to);
  const conv = new Converter(o.currency, o.ctx);
  let total = 0n;
  let n = 0;
  let noWaybill = 0;
  let diff = 0n;
  for (const m of list) {
    const c = m.components?.shipping_cost as { state: string; reason?: string | null } | undefined;
    if (c?.reason === "no_waybill") noWaybill += 1;
    if (c?.state !== "actual") continue;
    let actual = 0n;
    let paid = 0n;
    for (const e of j.entries) {
      if (e.orderId !== m.orderId) continue;
      const isCost = e.category === "shipping_cost" || e.category === "return_shipping_cost";
      const isPaid = e.category === "sales_shipping" || e.category === "refund_shipping";
      if (!isCost && !isPaid) continue;
      const v = conv.of(e);
      if (v === null) continue;
      if (isCost) actual += -v;
      else paid += v;
    }
    total += actual;
    n += 1;
    diff += paid - actual;
  }
  return { averageActual: n > 0 ? str(divRound(total, BigInt(n))) : null, ordersWithActual: n, withoutWaybill: noWaybill, paidMinusActual: str(diff) };
}

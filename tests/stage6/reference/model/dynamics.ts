/**
 * Еталонна модель (WP12a): «Динаміка продажів» за датою замовлення (§12.2) і частка повернень (§2.6).
 * Продажі — з сирих угод (ще не визнані — окремою сумою з підписом), без податку, без подарункових карток.
 */
import { cents, divRound, percent1, str, type Cents } from "./money";
import { bucketKey, kyivDate, type Granularity } from "./dates";
import type { RefOrderFacts } from "./order-posting";
import { convert, type ConvertContext } from "./fx";

export interface DynamicsBucket {
  bucket: string;
  orders: number;
  units: number;
  netSales: string;
  /** Частина netSales замовлень, ще не визнаних (підпис «ще не відвантажено»). */
  unrecognizedNetSales: string;
  /** Середній чек за правилом повноти: Σ / замовлення з угодами (null — немає таких). */
  averageCheck: string | null;
  ordersWithSales: number;
}

/**
 * Відрізки за `placed_at` (Київ); чисті продажі — угоди order/order_edit і повернення до визнання (нетто), у валюті
 * звітності за датою оплати (fx_on виручки за типовою політикою). `recognized` — визнані на момент звіту.
 */
export function salesDynamics(
  orders: ReadonlyArray<RefOrderFacts & { recognizedAt?: string | null }>,
  o: { from: string; to: string; granularity: Granularity; currency: string; ctx: ConvertContext },
): { buckets: DynamicsBucket[]; best: string | null; worst: string | null; unconverted: number } {
  const acc = new Map<string, { orders: number; units: number; net: Cents; unrec: Cents; withSales: number }>();
  let unconverted = 0;
  for (const ord of orders) {
    const placed = kyivDate(ord.placedAt);
    if (placed < o.from || placed > o.to) continue;
    const key = bucketKey(placed, o.granularity);
    const b = acc.get(key) ?? { orders: 0, units: 0, net: 0n, unrec: 0n, withSales: 0 };
    b.orders += 1;
    const pay = ord.transactions.filter((t) => t.status === "SUCCESS" && !t.test && (t.kind === "SALE" || t.kind === "CAPTURE")).map((t) => t.processedAt).sort()[0];
    const fxOn = pay ? kyivDate(pay) : placed;
    const recT = ord.recognizedAt ? Date.parse(ord.recognizedAt) : Number.POSITIVE_INFINITY;
    let net = 0n;
    let has = false;
    for (const s of ord.sales) {
      if (s.lineType === "GIFT_CARD") continue;
      const before = Date.parse(s.happenedAt) <= recT;
      if (!(s.agreement === "order" || s.agreement === "order_edit" || before)) continue;
      const v = convert(cents(s.totalAmount) - cents(s.taxAmount), ord.currency, o.currency, fxOn, o.ctx);
      if (v === null) {
        unconverted += 1;
        continue;
      }
      has = true;
      net += v;
      if (s.lineType === "PRODUCT") b.units += s.quantity ?? 0;
    }
    if (has) b.withSales += 1;
    b.net += net;
    if (!ord.recognizedAt) b.unrec += net;
    acc.set(key, b);
  }
  const buckets = [...acc.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([bucket, b]) => ({
      bucket,
      orders: b.orders,
      units: b.units,
      netSales: str(b.net),
      unrecognizedNetSales: str(b.unrec),
      averageCheck: b.withSales > 0 ? str(divRound(b.net, BigInt(b.withSales))) : null,
      ordersWithSales: b.withSales,
    }));
  const ranked = [...buckets].sort((a, b) => {
    const d = cents(b.netSales) - cents(a.netSales);
    return d === 0n ? (a.bucket < b.bucket ? -1 : 1) : d > 0n ? 1 : -1;
  });
  return { buckets, best: ranked[0]?.bucket ?? null, worst: ranked.at(-1)?.bucket ?? null, unconverted };
}

/** Частка повернень (§2.6): замовлення з поверненням / визнані з відомими даними повернень (без order_unreadable). */
export function returnRate(orders: ReadonlyArray<{ recognized: boolean; returnsKnown: boolean; hasReturn: boolean }>): { rate: string | null; withReturn: number; known: number; recognized: number } {
  const rec = orders.filter((x) => x.recognized);
  const known = rec.filter((x) => x.returnsKnown);
  const withReturn = known.filter((x) => x.hasReturn).length;
  return { rate: percent1(BigInt(withReturn), BigInt(known.length)), withReturn, known: known.length, recognized: rec.length };
}

/**
 * «Оплачено, ще не відвантажено» (§3.6): оплачені, не скасовані, не визнані замовлення — кількість + Σ чистих продажів
 * з угод (стан «Прогноз»), довідково, ніколи не в P&L. `recognizedAt` — момент визнання (null — ще не визнано).
 */
export function paidNotShipped(
  orders: ReadonlyArray<RefOrderFacts & { recognizedAt?: string | null }>,
  currency: string,
  ctx: ConvertContext,
): { orders: number; amount: string; unconverted: number } {
  let n = 0;
  let total = 0n;
  let unconverted = 0;
  for (const o of orders) {
    if (o.recognizedAt || o.cancelledBeforeHandover || o.test) continue;
    const pay = o.transactions.filter((t) => t.status === "SUCCESS" && !t.test && (t.kind === "SALE" || t.kind === "CAPTURE")).map((t) => t.processedAt).sort()[0];
    if (!pay) continue;
    n += 1;
    for (const s of o.sales) {
      if (s.lineType === "GIFT_CARD") continue;
      const v = convert(cents(s.totalAmount) - cents(s.taxAmount), o.currency, currency, kyivDate(pay), ctx);
      if (v === null) unconverted += 1;
      else total += v;
    }
  }
  return { orders: n, amount: str(total), unconverted };
}

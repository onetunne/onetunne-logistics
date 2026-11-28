/**
 * Етап 6, WP7: стани винагороди й баланс партнера (docs/stage6-design.md §9.4, §9.5, I10). ЧИСТА функція: стан
 * ВИВОДИТЬСЯ при читанні з журналу подій і виплат (працює в демо без завдань), нічого не зберігається.
 *
 * Події — лише ЧИННІ (`active !== false`: запис журналу події не сторновано; сторновані — замовлення виключено, F2).
 * Утримання — ДЛЯ КОЖНОЇ ДОДАТНОЇ ПОДІЇ окремо (нарахування: дата визнання + hold_days; додатне коригування — своя дата
 * + hold_days): дозріла частина лишається «До виплати», чекає лише нова додатна різниця.
 * На замовлення (у валюті комісії): чиста сума = Σ подій; в утриманні = Σ додатних подій, чиє hold_until ≥ сьогодні
 * (не більше чистої суми); дозріло = чиста сума − в утриманні.
 * - «Нараховано (утримання)» — непокрита сума, вся ще в утриманні;
 * - «До виплати» — є непокрита дозріла частина (сьогодні > hold_until), чиста сума > 0;
 * - «Виплачено» — покрито виплатами: Σ активних виплат (covers_amount у валюті комісії) розподіляється FIFO за
 *   найранішим утриманням замовлення (далі — дата першої події, id замовлення); покриття спершу закриває дозрілу частину;
 * - «Скасовано» — чиста сума 0 (або менше) після скасування.
 * На партнера: баланс = Σ подій − Σ виплат (I10); від'ємний — «Партнер винен … — буде утримано з наступної виплати»
 * (автоматично не стягується); до виплати = max(0, min(баланс, Σ непокритих дозрілих частин)).
 */
import { fromMinor, toMinorForCurrency } from "~/lib/decimal";
import type { CommissionEventKind } from "./types";

export interface LedgerEvent {
  orderId: string;
  n: number;
  kind: CommissionEventKind;
  amount: string;
  currency: string;
  base: string;
  rateBp: number;
  recognizedOn: string;
  holdUntil: string | null;
  /** false — запис журналу події сторновано (замовлення виключено, F2): подія не діє. Типово — діє. */
  active?: boolean;
}

export interface LedgerPayout {
  id: string;
  coversAmount: string;
  coversCurrency: string;
  status: "active" | "voided";
}

export type CommissionState = "accrued" | "payable" | "paid" | "cancelled";

export interface OrderCommission {
  orderId: string;
  currency: string;
  /** Σ подій. */
  net: string;
  /** Σ нарахувань. */
  accrued: string;
  /** Σ коригувань, скасувань і ручних подій. */
  adjustments: string;
  /** Остання (чинна) база й ставка. */
  base: string;
  rateBp: number;
  firstOn: string;
  lastOn: string;
  /** Найпізніше утримання серед додатних подій (показ «Утримання до»). */
  holdUntil: string | null;
  /** Непокрита дозріла частина (≥ 0). */
  payable: string;
  /** Непокрита частина, що ще в утриманні (≥ 0). */
  inHold: string;
  /** Покрито виплатами (FIFO). */
  paid: string;
  /** Не покрито (≥ 0). */
  outstanding: string;
  state: CommissionState;
  events: number;
}

export interface CurrencyLedger {
  currency: string;
  accrued: string;
  adjustments: string;
  net: string;
  paid: string;
  balance: string;
  payable: string;
  inHold: string;
  /** Партнер винен (від'ємний баланс, ≥ 0). */
  owes: string;
  orders: OrderCommission[];
}

const minor = (amount: string, currency: string) => toMinorForCurrency(amount, currency);
const cmp = (a: string | null, b: string | null) => (a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1);

/** Стани й баланс за валютами комісії. `today` — дата Києва. */
export function deriveLedger(events: readonly LedgerEvent[], payouts: readonly LedgerPayout[], today: string): CurrencyLedger[] {
  const live = events.filter((e) => e.active !== false);
  const currencies = [...new Set([...live.map((e) => e.currency), ...payouts.filter((p) => p.status === "active").map((p) => p.coversCurrency)])].sort();
  return currencies.map((currency) => ledgerFor(currency, live.filter((e) => e.currency === currency), payouts, today));
}

function ledgerFor(currency: string, events: readonly LedgerEvent[], payouts: readonly LedgerPayout[], today: string): CurrencyLedger {
  const byOrder = new Map<string, LedgerEvent[]>();
  for (const e of events) byOrder.set(e.orderId, [...(byOrder.get(e.orderId) ?? []), e]);
  const rows = [...byOrder.entries()].map(([orderId, list]) => {
    const sorted = [...list].sort((a, b) => a.n - b.n);
    let net = 0n;
    let accrued = 0n;
    let heldPositive = 0n;
    let lastHold: string | null = null;
    let firstHold: string | null = null;
    for (const e of sorted) {
      const a = minor(e.amount, currency);
      net += a;
      if (e.kind === "accrual") accrued += a;
      if (a > 0n && e.holdUntil) {
        if (lastHold === null || e.holdUntil > lastHold) lastHold = e.holdUntil;
        if (firstHold === null || e.holdUntil < firstHold) firstHold = e.holdUntil;
        // Утримання кожної додатної події окремо: «сьогодні > hold_until» — дозріла.
        if (!(today > e.holdUntil)) heldPositive += a;
      }
    }
    const positive = net > 0n ? net : 0n;
    const held = heldPositive < positive ? heldPositive : positive;
    const last = sorted[sorted.length - 1]!;
    return {
      orderId,
      net,
      accrued,
      positive,
      matured: positive - held,
      lastHold,
      firstHold,
      first: sorted[0]!.recognizedOn,
      lastOn: last.recognizedOn,
      base: last.base,
      rateBp: last.rateBp,
      events: sorted.length,
    };
  });
  let pool = payouts.filter((p) => p.status === "active" && p.coversCurrency === currency).reduce((s, p) => s + minor(p.coversAmount, currency), 0n);
  const paidTotal = pool;
  const fifo = rows.filter((r) => r.positive > 0n).sort((a, b) => cmp(a.firstHold, b.firstHold) || cmp(a.first, b.first) || (a.orderId < b.orderId ? -1 : 1));
  const paidOf = new Map<string, bigint>();
  for (const r of fifo) {
    const take = pool < r.positive ? (pool > 0n ? pool : 0n) : r.positive;
    paidOf.set(r.orderId, take);
    pool -= take;
  }
  let net = 0n;
  let accrued = 0n;
  let matured = 0n;
  let inHold = 0n;
  const orders: OrderCommission[] = rows
    .map((r) => {
      net += r.net;
      accrued += r.accrued;
      const paid = paidOf.get(r.orderId) ?? 0n;
      const outstanding = r.positive - paid;
      // Покриття спершу закриває дозрілу частину.
      const payableOut = r.matured > paid ? r.matured - paid : 0n;
      const holdOut = outstanding - payableOut;
      matured += payableOut;
      inHold += holdOut;
      const state: CommissionState = r.net <= 0n ? "cancelled" : outstanding === 0n ? "paid" : payableOut > 0n ? "payable" : "accrued";
      return {
        orderId: r.orderId,
        currency,
        net: fromMinor(r.net),
        accrued: fromMinor(r.accrued),
        adjustments: fromMinor(r.net - r.accrued),
        base: r.base,
        rateBp: r.rateBp,
        firstOn: r.first,
        lastOn: r.lastOn,
        holdUntil: r.lastHold,
        payable: fromMinor(payableOut),
        inHold: fromMinor(holdOut),
        paid: fromMinor(paid),
        outstanding: fromMinor(outstanding),
        state,
        events: r.events,
      };
    })
    .sort((a, b) => (a.firstOn === b.firstOn ? (a.orderId < b.orderId ? 1 : -1) : a.firstOn < b.firstOn ? 1 : -1));
  const balance = net - paidTotal;
  const payableRaw = balance < matured ? balance : matured;
  return {
    currency,
    accrued: fromMinor(accrued),
    adjustments: fromMinor(net - accrued),
    net: fromMinor(net),
    paid: fromMinor(paidTotal),
    balance: fromMinor(balance),
    payable: fromMinor(payableRaw > 0n ? payableRaw : 0n),
    inHold: fromMinor(inHold),
    owes: fromMinor(balance < 0n ? -balance : 0n),
    orders,
  };
}

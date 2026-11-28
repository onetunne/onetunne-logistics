/**
 * Еталонна модель (WP12a): партнерська винагорода (§9.3–§9.6) — база, сума, події, стани, виплати FIFO, окупність.
 */
import { cents, mulDiv, ratio, str, type Cents } from "./money";
import { addDays } from "./dates";
import type { Agreement, SaleLineType } from "./categories";

export interface PartnerSaleInput {
  agreement: Agreement;
  lineType: SaleLineType;
  totalAmount: string;
  taxAmount: string;
}

export interface PartnerBaseOptions {
  /** displayFinancialStatus = REFUNDED → скасування до 0. */
  refundedFully?: boolean;
  /** Нетто-частини чистих втрат chargeback (Σ), зменшують базу (§9.3). */
  chargebackNetLoss?: Cents;
  /** Власник обрав «Скасувати винагороду повністю» при chargeback. */
  cancelOnChargeback?: boolean;
}

/**
 * База (§9.3): P = Σ PRODUCT (усі угоди) без податку; A = Σ ВІД'ЄМНИХ ADJUSTMENT/UNKNOWN угод refund/return;
 * база = max(0, min(P, P + A)); скасування до 0 — Σ усіх продажів без податку (крім подарункових карток) ≤ 0 або
 * REFUNDED; chargeback — мінус min(нетто-втрата, база) або 0 («скасувати повністю»).
 */
export function partnerBase(sales: readonly PartnerSaleInput[], opts: PartnerBaseOptions = {}): Cents {
  let p = 0n;
  let a = 0n;
  let all = 0n;
  for (const s of sales) {
    const net = cents(s.totalAmount) - cents(s.taxAmount);
    if (s.lineType === "PRODUCT") p += net;
    if ((s.lineType === "ADJUSTMENT" || s.lineType === "UNKNOWN") && (s.agreement === "refund" || s.agreement === "return") && net < 0n) a += net;
    if (s.lineType !== "GIFT_CARD") all += net;
  }
  if (all <= 0n || opts.refundedFully) return 0n;
  let base = p + a < p ? p + a : p;
  if (base < 0n) base = 0n;
  if (opts.cancelOnChargeback) return 0n;
  if (opts.chargebackNetLoss && opts.chargebackNetLoss > 0n) base -= opts.chargebackNetLoss < base ? opts.chargebackNetLoss : base;
  return base;
}

/** Винагорода = round(база × ставка / 10000), не менше 0 (I10). */
export function commissionFor(base: Cents, rateBp: number): Cents {
  const c = mulDiv(base, BigInt(rateBp), 10000n);
  return c < 0n ? 0n : c;
}

export type PartnerEventKind = "accrual" | "adjustment" | "cancellation";

export interface PartnerEvent {
  n: number;
  kind: PartnerEventKind;
  /** Сума винагороди (додатна — нараховано партнеру), валюта магазину. */
  amount: Cents;
  date: string;
}

/**
 * Події одного замовлення: бажана винагорода в кожен момент − Σ попередніх подій → нова подія, якщо ≠ 0 (§9.4).
 * `steps` — бажана винагорода в хронологічному порядку (перший — визнання); `cancelled` — правило скасування.
 */
export function partnerEventsFrom(steps: ReadonlyArray<{ date: string; desired: Cents; cancelled?: boolean }>): PartnerEvent[] {
  const events: PartnerEvent[] = [];
  let total = 0n;
  steps.forEach((s, i) => {
    const desired = s.cancelled ? 0n : s.desired;
    const delta = desired - total;
    if (i === 0) {
      if (delta !== 0n) events.push({ n: events.length + 1, kind: "accrual", amount: delta, date: s.date });
    } else if (delta !== 0n) {
      events.push({ n: events.length + 1, kind: desired === 0n ? "cancellation" : "adjustment", amount: delta, date: s.date });
    }
    total = desired;
  });
  return events;
}

export interface PartnerOrderLedger {
  orderId: string;
  /** null — замовлення ще не визнане (стан «Очікується»). */
  recognizedOn: string | null;
  holdDays: number;
  events: readonly PartnerEvent[];
  /** Очікувана винагорода до визнання (прогноз). */
  expected?: Cents | null;
}

export interface PartnerPayout {
  id: string;
  paidOn: string;
  /** Скільки балансу комісії закрито (covers_amount), валюта комісії. */
  covers: string;
  voided?: boolean;
}

export type PartnerOrderState = "expected" | "accrued_hold" | "payable" | "paid" | "cancelled";

export interface PartnerLedgerResult {
  /** Σ подій − Σ виплат (може бути від'ємним — «Партнер винен…»). */
  balance: string;
  /** До виплати: незакрита частина замовлень після утримання. */
  payable: string;
  accruedHold: string;
  paid: string;
  orders: Array<{ orderId: string; state: PartnerOrderState; net: string; holdUntil: string | null; covered: string }>;
}

/** Стан винагороди на дату `today` (§9.4–§9.5): виплати розподіляються FIFO за hold_until; надлишок — аванс далі. */
export function partnerLedger(orders: readonly PartnerOrderLedger[], payouts: readonly PartnerPayout[], today: string): PartnerLedgerResult {
  const active = payouts.filter((p) => !p.voided && p.paidOn <= today);
  let pool = active.reduce((s, p) => s + cents(p.covers), 0n);
  const totalPaid = pool;
  const rows = orders
    .map((o) => {
      const events = o.events.filter((e) => e.date <= today);
      const net = events.reduce((s, e) => s + e.amount, 0n);
      const holdUntil = o.recognizedOn ? addDays(o.recognizedOn, o.holdDays) : null;
      return { o, events, net, holdUntil };
    })
    .sort((a, b) => ((a.holdUntil ?? "9999") < (b.holdUntil ?? "9999") ? -1 : (a.holdUntil ?? "9999") > (b.holdUntil ?? "9999") ? 1 : a.o.orderId < b.o.orderId ? -1 : 1));
  let payable = 0n;
  let hold = 0n;
  const out: PartnerLedgerResult["orders"] = [];
  let eventsTotal = 0n;
  for (const r of rows) {
    eventsTotal += r.net;
    const need = r.net > 0n ? r.net : 0n;
    // Від'ємна чиста сума (повернення після виплати) повертає частину вже покритого в «аванс».
    if (r.net < 0n) pool -= r.net;
    const covered = pool >= need ? need : pool > 0n ? pool : 0n;
    pool -= covered;
    let state: PartnerOrderState;
    if (!r.o.recognizedOn) state = "expected";
    else if (r.net <= 0n && r.events.some((e) => e.kind === "cancellation")) state = "cancelled";
    else if (need > 0n && covered >= need) state = "paid";
    else if (r.holdUntil !== null && today > r.holdUntil) state = "payable";
    else state = "accrued_hold";
    if (state === "payable") payable += need - covered;
    if (state === "accrued_hold") hold += need - covered;
    out.push({ orderId: r.o.orderId, state, net: str(r.net), holdUntil: r.holdUntil, covered: str(covered) });
  }
  return { balance: str(eventsTotal - totalPaid), payable: str(payable), accruedHold: str(hold), paid: str(totalPaid), orders: out };
}

/**
 * Окупність партнера (§9.6, G19): прибуток атрибутованих замовлень після всіх їхніх витрат (з винагородою) ÷
 * (винагорода + фіксовані оплати), 2 знаки; знаменник ≤ 0 → null.
 */
export function partnerPayback(input: { profitBeforeCommission: string; commission: string; fixedFees: string }): { profitAfter: string; payback: string | null } {
  const after = cents(input.profitBeforeCommission) - cents(input.commission);
  return { profitAfter: str(after), payback: ratio(after, cents(input.commission) + cents(input.fixedFees), 2) };
}

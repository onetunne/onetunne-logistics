/**
 * Етап 6, WP7: база й сума винагороди партнера (docs/stage6-design.md §9.3) і план подій (§9.4). ЧИСТІ функції;
 * гроші — BigInt у сотих (app/lib/decimal.ts), жодної арифметики float.
 *
 * База (валюта магазину = валюта продажів):
 *   P = Σ продажів lineType = PRODUCT усіх угод (ORDER, ORDER_EDIT, REFUND, RETURN) як totalAmount − totalTaxAmount;
 *   A = Σ ВІД'ЄМНИХ продажів ADJUSTMENT / UNKNOWN угод REFUND / RETURN (і невідомого виду — як повернення, §2.1):
 *       повернення коштів без позицій (втрачена посилка, жест доброї волі); додатні коригування не додаються;
 *   база = max(0, min(P, P + A)) — без податків, доставки, чайових, мит, зборів, подарункових карток.
 * Скасування до 0: Σ усіх продажів без податку (крім подарункових карток) ≤ 0 або displayFinancialStatus = REFUNDED.
 * Chargeback (програно / прийнято): чиста втрата L = сума спору − повернено (> 0) ділиться за співвідношенням
 *   нетто / податок замовлення (allocateMinor; ваги — Σ продажів без податку і Σ податку); база зменшується на
 *   min(Σ нетто-частин, база), або до 0 з «Скасувати винагороду повністю» (це рішення діє й без суми спору). Сума
 *   програного / прийнятого спору ще не внесена → база НЕВІДОМА (`known: false`, `dispute_amount_unknown`), не 0
 *   (§2.3 «сума спору невідома → у «Потребує уваги», не 0», F4).
 * Комісія = round(база × rate_bp / 10000) (половина від нуля, до мінорних одиниць валюти), не менше 0.
 * Відсутні факти НІКОЛИ не стають 0: без продажів (і без підтверджених власником сум) — `known: false`.
 */
import type { AgreementKind, DisputeOutcome } from "~/domain/finance";
import { addDays } from "~/lib/periods";
import { allocateMinor, assertSupportedCurrency, fromMinor, mulDivHalfAwayFromZero, toMinorForCurrency, UnsupportedCurrencyError } from "~/lib/decimal";
import type { CommissionEventKind, Money } from "./types";

/** Продаж угоди Shopify (order_sales) — лише поля, потрібні базі. */
export interface CommissionSale {
  agreementKind: AgreementKind;
  lineType: string;
  totalAmount: string;
  totalTax: string;
  currency: string;
}

/** Спір / chargeback замовлення (order_disputes). */
export interface CommissionDispute {
  outcome: DisputeOutcome | null;
  /** Брутто (як списав банк); null — суму ще не внесено. */
  amount: string | null;
  recoveredAmount: string | null;
  /** null — валюта магазину. */
  currency: string | null;
  fullPartnerCancellation: boolean;
}

export interface CommissionInput {
  sales: readonly CommissionSale[];
  displayFinancialStatus: string | null;
  disputes: readonly CommissionDispute[];
  rateBp: number;
  /** Суми товарів без податків, підтверджені власником (замовлення без угод Shopify, §4) — замість P. */
  confirmedProducts?: Money | null;
}

export type CommissionCancel = "refunded" | "net_sales_not_positive" | "chargeback_full";

export type CommissionComputation =
  | {
      known: true;
      currency: string;
      /** P. */
      products: string;
      /** A (≤ 0). */
      noItemRefunds: string;
      /** На скільки chargeback зменшив базу (≥ 0). */
      chargebackReduction: string;
      base: string;
      commission: string;
      cancelled: CommissionCancel | null;
      /** Джерело бази: продажі Shopify / демо або підтверджені власником суми. */
      from: "sales" | "confirmed";
    }
  | { known: false; reason: CommissionUnknownReason };

export type CommissionUnknownReason = "no_sales" | "mixed_currency" | "dispute_currency" | "dispute_amount_unknown" | "unsupported_currency";

const REFUND_LIKE: readonly AgreementKind[] = ["refund", "return", "unknown"];
const NO_ITEM_LINES = new Set(["ADJUSTMENT", "UNKNOWN"]);
const OUTCOMES_WITH_LOSS: readonly DisputeOutcome[] = ["lost", "accepted"];

/** Нетто продажу (без податку) у сотих. */
function saleNet(s: CommissionSale): bigint {
  return toMinorForCurrency(s.totalAmount, s.currency) - toMinorForCurrency(s.totalTax, s.currency);
}

/** Комісія від бази (соті) за ставкою (bp), округлення до мінорних одиниць валюти; не менше 0. */
export function commissionOf(baseMinor: bigint, rateBp: number, currency: string): bigint {
  if (!Number.isInteger(rateBp) || rateBp < 0 || rateBp > 10_000) throw new RangeError(`rate_bp ${rateBp}`);
  if (baseMinor <= 0n) return 0n;
  const d = assertSupportedCurrency(currency);
  const k = d === 0 ? 100n : 1n;
  return mulDivHalfAwayFromZero(baseMinor / k, BigInt(rateBp), 10_000n) * k;
}

/** Спір із втратою (програно / прийнято). */
export function isLossOutcome(outcome: DisputeOutcome | null): boolean {
  return outcome !== null && OUTCOMES_WITH_LOSS.includes(outcome);
}

/**
 * Чиста втрата спору L = сума − повернено (> 0) для програного / прийнятого; інший результат (виграно, запобігли,
 * відкрито) → 0; програно / прийнято без суми → null (НЕВІДОМО, не 0 — F4).
 */
export function disputeNetLoss(d: Pick<CommissionDispute, "outcome" | "amount" | "recoveredAmount">, currency: string): bigint | null {
  if (!isLossOutcome(d.outcome)) return 0n;
  if (d.amount === null) return null;
  const loss = toMinorForCurrency(d.amount, currency) - (d.recoveredAmount === null ? 0n : toMinorForCurrency(d.recoveredAmount, currency));
  return loss > 0n ? loss : 0n;
}

/**
 * Нетто-частина втрати L за співвідношенням нетто / податок замовлення (найбільші остачі; валюта з 0 знаками — цілими
 * одиницями). Немає податку → уся втрата; немає додатних ваг → уся втрата (обережно: база зменшується повністю).
 * Та сама функція — для chargeback_loss / сторно tax_collected_memo (WP4). G10b: 49,50 за 58,40 : 11,10 → 41,59 / 7,91.
 */
export function chargebackNetPart(lossMinor: bigint, netMinor: bigint, taxMinor: bigint, currency: string): { net: bigint; tax: bigint } {
  if (lossMinor <= 0n) return { net: 0n, tax: 0n };
  const w0 = netMinor > 0n ? netMinor : 0n;
  const w1 = taxMinor > 0n ? taxMinor : 0n;
  if (w0 + w1 === 0n || w1 === 0n) return { net: lossMinor, tax: 0n };
  const d = assertSupportedCurrency(currency);
  const k = d === 0 ? 100n : 1n;
  const [net, tax] = allocateMinor(lossMinor / k, [w0, w1]);
  return { net: net! * k, tax: tax! * k };
}

/** База й бажана комісія замовлення за поточними фактами (див. вгорі файла). */
export function computeCommission(input: CommissionInput): CommissionComputation {
  try {
    return compute(input);
  } catch (e) {
    if (e instanceof UnsupportedCurrencyError) return { known: false, reason: "unsupported_currency" };
    throw e;
  }
}

function compute(input: CommissionInput): CommissionComputation {
  let currency: string;
  let products: bigint;
  let noItem = 0n;
  let netAll: bigint;
  let taxAll = 0n;
  let from: "sales" | "confirmed";
  if (input.sales.length > 0) {
    const currencies = new Set(input.sales.map((s) => s.currency));
    if (currencies.size !== 1) return { known: false, reason: "mixed_currency" };
    currency = input.sales[0]!.currency;
    products = 0n;
    netAll = 0n;
    for (const s of input.sales) {
      const net = saleNet(s);
      if (s.lineType === "PRODUCT") products += net;
      if (REFUND_LIKE.includes(s.agreementKind) && NO_ITEM_LINES.has(s.lineType) && net < 0n) noItem += net;
      if (s.lineType !== "GIFT_CARD") {
        netAll += net;
        taxAll += toMinorForCurrency(s.totalTax, s.currency);
      }
    }
    from = "sales";
  } else if (input.confirmedProducts) {
    currency = input.confirmedProducts.currency;
    products = toMinorForCurrency(input.confirmedProducts.amount, currency);
    netAll = products;
    from = "confirmed";
  } else {
    return { known: false, reason: "no_sales" };
  }
  const minP = products < products + noItem ? products : products + noItem;
  const base0 = minP > 0n ? minP : 0n;
  let cancelled: CommissionCancel | null = null;
  if (input.displayFinancialStatus === "REFUNDED") cancelled = "refunded";
  else if (from === "sales" && netAll <= 0n) cancelled = "net_sales_not_positive";
  let reduction = 0n;
  let foreignDispute = false;
  let unknownDispute = false;
  for (const d of input.disputes) {
    if (!isLossOutcome(d.outcome)) continue;
    // «Скасувати винагороду повністю» — рішення власника: 0 незалежно від суми (і її валюти).
    if (d.fullPartnerCancellation) {
      cancelled ??= "chargeback_full";
      continue;
    }
    if (d.amount === null) {
      unknownDispute = true;
      continue;
    }
    if (d.currency !== null && d.currency !== currency) {
      foreignDispute = true;
      continue;
    }
    const loss = disputeNetLoss(d, currency)!;
    if (loss === 0n) continue;
    reduction += chargebackNetPart(loss, netAll, taxAll, currency).net;
  }
  // Скасування до 0 відоме без сум спорів; інакше невідома сума / інша валюта спору — база невідома (не 0).
  if (!cancelled && foreignDispute) return { known: false, reason: "dispute_currency" };
  if (!cancelled && unknownDispute) return { known: false, reason: "dispute_amount_unknown" };
  if (reduction > base0) reduction = base0;
  const base = cancelled ? 0n : base0 - reduction;
  const commission = cancelled ? 0n : commissionOf(base, input.rateBp, currency);
  return {
    known: true,
    currency,
    products: fromMinor(products),
    noItemRefunds: fromMinor(noItem),
    chargebackReduction: fromMinor(cancelled ? 0n : reduction),
    base: fromMinor(base),
    commission: fromMinor(commission),
    cancelled,
    from,
  };
}

// ---------------------------------------------------------------------------
// План подій (§9.4): бажана комісія − Σ подій → нова подія, якщо ≠ 0
// ---------------------------------------------------------------------------

export interface ExistingEvent {
  partnerId: string;
  n: number;
  kind: CommissionEventKind;
  amount: string;
  currency: string;
  rateBp: number;
  recognizedOn: string;
}

export interface CommissionTarget {
  partnerId: string;
  currency: string;
  commission: string;
  base: string;
  rateBp: number;
  holdDays: number;
}

export interface PlanInput {
  /** Дата визнання замовлення (R1): дата нарахування. */
  recognizedOn: string;
  /** Чинна бажана комісія (атрибутований партнер); null — усім партнерам 0 (атрибуцію знято). */
  target: CommissionTarget | null;
  /** ЧИННІ події замовлення (запис журналу не сторновано). Сторновані (замовлення виключено, F2) не входять. */
  existing: readonly ExistingEvent[];
  /** Найбільший n серед УСІХ подій замовлення (і сторнованих) — нові номери продовжують його (ключі унікальні). */
  lastN?: number;
  /** Дата коригування / скасування поточного партнера (R2: дата події, не раніше визнання). */
  changeDate: string;
  /** Дата скасування партнера, з якого знято атрибуцію (рішення власника). */
  removalDate: string;
}

export interface PlannedEvent {
  partnerId: string;
  n: number;
  kind: CommissionEventKind;
  base: string;
  rateBp: number;
  /** Зі знаком (нарахування +, коригування ±, скасування −). */
  amount: string;
  currency: string;
  recognizedOn: string;
  holdUntil: string | null;
}

const maxDate = (a: string, b: string) => (a > b ? a : b);

/**
 * Події, які приводять Σ подій кожного (партнер, валюта) до бажаної суми. Ручні події (`manual`) не входять у різницю —
 * бажаний стан їх не скасовує. n — наступні номери замовлення (послідовно). Повтор із тими самими даними → [] (I3).
 */
export function planCommissionEvents(input: PlanInput): PlannedEvent[] {
  const groups = new Map<string, { partnerId: string; currency: string; sum: bigint; count: number; rateBp: number }>();
  const key = (p: string, c: string) => `${p}|${c}`;
  for (const e of input.existing) {
    const k = key(e.partnerId, e.currency);
    const g = groups.get(k) ?? { partnerId: e.partnerId, currency: e.currency, sum: 0n, count: 0, rateBp: e.rateBp };
    if (e.kind !== "manual") g.sum += toMinorForCurrency(e.amount, e.currency);
    g.count++;
    g.rateBp = e.rateBp;
    groups.set(k, g);
  }
  const t = input.target;
  if (t && !groups.has(key(t.partnerId, t.currency))) groups.set(key(t.partnerId, t.currency), { partnerId: t.partnerId, currency: t.currency, sum: 0n, count: 0, rateBp: t.rateBp });
  let n = input.existing.reduce((m, e) => Math.max(m, e.n), input.lastN ?? 0);
  const out: PlannedEvent[] = [];
  const ordered = [...groups.values()].sort((a, b) => (a.partnerId === b.partnerId ? (a.currency < b.currency ? -1 : 1) : a.partnerId < b.partnerId ? -1 : 1));
  // Спершу скасування (знята атрибуція), потім поточний партнер — стабільний порядок номерів.
  ordered.sort((a, b) => Number(isTarget(a, t)) - Number(isTarget(b, t)));
  for (const g of ordered) {
    const current = isTarget(g, t);
    const desired = current && t ? toMinorForCurrency(t.commission, t.currency) : 0n;
    const diff = desired - g.sum;
    if (diff === 0n) continue;
    n += 1;
    const first = g.count === 0;
    const kind: CommissionEventKind = first && diff > 0n ? "accrual" : desired === 0n ? "cancellation" : "adjustment";
    const date = kind === "accrual" ? input.recognizedOn : maxDate(current ? input.changeDate : input.removalDate, input.recognizedOn);
    const holdDays = current && t ? t.holdDays : 0;
    out.push({
      partnerId: g.partnerId,
      n,
      kind,
      base: current && t ? t.base : "0.00",
      rateBp: current && t ? t.rateBp : g.rateBp,
      amount: fromMinor(diff),
      currency: g.currency,
      recognizedOn: date,
      holdUntil: diff > 0n ? addDays(date, holdDays) : null,
    });
  }
  return out;
}

function isTarget(g: { partnerId: string; currency: string }, t: CommissionTarget | null): boolean {
  return Boolean(t && t.partnerId === g.partnerId && t.currency === g.currency);
}

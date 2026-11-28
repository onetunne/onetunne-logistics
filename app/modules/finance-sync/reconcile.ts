/**
 * Етап 6 (WP3): звірка кожного замовлення з Shopify RC1–RC5 (docs/stage6-design.md §16.5). Чиста функція, суми — BigInt
 * (мінорні одиниці numeric(14,2)), без допуску: значення НЕ підганяються.
 *
 * - RC1 (кандидат): Σ totalAmount усіх продажів (магазин) = currentTotalPriceSet;
 * - RC2: Σ SUCCESS SALE/CAPTURE − Σ SUCCESS REFUND = netPaymentSet;
 * - RC3: Σ SUCCESS REFUND = totalRefundedSet (і, коли повернення прочитано повністю — кількість < розміру сторінки, —
 *   Σ заголовків повернень = totalRefundedSet);
 * - RC4 (кандидат): Σ totalTaxAmount продажів з lineType = PRODUCT = currentTotalTaxSet (податок доставки не входить —
 *   золотий G2);
 * - RC5: знаки продажів угод REFUND/RETURN (зокрема ADJUSTMENT — повернення без позицій) узгоджені з RC1: сума й кількість
 *   ≤ 0 (RETURN_SALE_SIGN, приклад Shopify — від'ємні).
 * Кандидати (RECONCILIATION_CANDIDATES) лише позначають ▲ «Потребує перевірки»; підтверджені (RC2, RC3, RC5) роблять
 * складник RECONCILIATION_AFFECTS `partial` (`reconciliation_mismatch`), доки власник не розв'яже розбіжність (WP4).
 * Неможливо перевірити (дані неповні/пошкоджені) — `unknown`, ніколи не «збіг».
 */
import {
  RECONCILIATION_AFFECTS,
  RECONCILIATION_CANDIDATES,
  RECONCILIATION_CHECKS,
  RETURN_SALE_SIGN,
  type AgreementKind,
  type DiscrepancyStatus,
  type OrderComponent,
  type ReconciliationCheck,
} from "~/domain/finance";
import { fromMinor, toMinor } from "~/lib/money";
import { signOf } from "./parse";

export const RECONCILIATION_VERSION = 1;

export type CheckStatus = "ok" | "mismatch" | "unknown" | "not_applicable";

/** Причини unknown / not_applicable (коди, без сум). */
export const CHECK_REASONS = [
  "sales_not_read",
  "sales_damaged",
  "transactions_truncated",
  "transactions_damaged",
  "total_missing",
  "currency_mismatch",
  "no_refund_sales",
  "refund_headers_mismatch",
] as const;
export type CheckReason = (typeof CHECK_REASONS)[number];

export interface CheckResult {
  status: CheckStatus;
  /** Кандидат (лише ▲, не впливає на стан складника). */
  candidate: boolean;
  /** Значення Shopify (підсумок замовлення), десятковий рядок у валюті магазину. */
  expected: string | null;
  /** Значення з фактів (продажі/транзакції). */
  actual: string | null;
  currency: string | null;
  reason?: CheckReason;
  /** RC5: кількість продажів з неочікуваним знаком. */
  violations?: number;
}

export interface ReconciliationResult {
  version: typeof RECONCILIATION_VERSION;
  checks: Record<ReconciliationCheck, CheckResult>;
}

export interface ReconcileSale {
  agreementKind: AgreementKind;
  lineType: string;
  quantity: number | null;
  totalAmount: string;
  totalTax: string;
  currency: string;
}

export interface ReconcileTransaction {
  kind: string;
  status: string;
  amount: string;
  currency: string;
}

export interface ReconcileInput {
  shopCurrency: string | null;
  /** Підсумки замовлення (shopMoney) — null, якщо немає / пошкоджено. */
  currentTotalPrice: string | null;
  currentTotalTax: string | null;
  netPayment: string | null;
  totalRefunded: string | null;
  sales: readonly ReconcileSale[];
  /** "complete" — продажі прочитано без помилок; інакше RC1/RC4/RC5 — unknown. */
  salesStatus: "complete" | "damaged" | "unsupported_currency" | "not_read";
  transactions: readonly ReconcileTransaction[];
  transactionsStatus: "complete" | "truncated" | "damaged";
  /** Заголовки повернень (лише коли прочитано повністю — для другої частини RC3). */
  refundHeaders: readonly { total: string; currency: string }[] | null;
}

const minor = (s: string) => toMinor(s);
const sumMinor = (xs: readonly string[]) => xs.reduce((acc, x) => acc + minor(x), 0n);

function cmp(check: ReconciliationCheck, expected: string | null, actual: bigint | null, currency: string | null): CheckResult {
  const candidate = RECONCILIATION_CANDIDATES.includes(check);
  if (expected === null) return { status: "unknown", candidate, expected: null, actual: actual === null ? null : fromMinor(actual), currency, reason: "total_missing" };
  if (actual === null) return { status: "unknown", candidate, expected, actual: null, currency };
  return { status: minor(expected) === actual ? "ok" : "mismatch", candidate, expected, actual: fromMinor(actual), currency };
}

function unknown(check: ReconciliationCheck, reason: CheckReason, currency: string | null, expected: string | null = null): CheckResult {
  return { status: "unknown", candidate: RECONCILIATION_CANDIDATES.includes(check), expected, actual: null, currency, reason };
}

const PAYMENT_KINDS = new Set(["SALE", "CAPTURE"]);
const REFUND_AGREEMENTS = new Set<AgreementKind>(["refund", "return"]);

export function reconcileOrder(input: ReconcileInput): ReconciliationResult {
  const cur = input.shopCurrency;
  const salesOk = input.salesStatus === "complete" && input.sales.every((s) => s.currency === cur);
  const salesReason: CheckReason = input.salesStatus === "not_read" ? "sales_not_read" : input.salesStatus === "complete" ? "currency_mismatch" : "sales_damaged";
  const txOk = input.transactionsStatus === "complete" && input.transactions.every((t) => t.currency === cur);
  const txReason: CheckReason =
    input.transactionsStatus === "truncated" ? "transactions_truncated" : input.transactionsStatus === "damaged" ? "transactions_damaged" : "currency_mismatch";
  const success = input.transactions.filter((t) => t.status === "SUCCESS");

  const rc1 = salesOk ? cmp("RC1", input.currentTotalPrice, sumMinor(input.sales.map((s) => s.totalAmount)), cur) : unknown("RC1", salesReason, cur, input.currentTotalPrice);

  const rc2 = txOk
    ? cmp(
        "RC2",
        input.netPayment,
        sumMinor(success.filter((t) => PAYMENT_KINDS.has(t.kind)).map((t) => t.amount)) - sumMinor(success.filter((t) => t.kind === "REFUND").map((t) => t.amount)),
        cur,
      )
    : unknown("RC2", txReason, cur, input.netPayment);

  let rc3 = txOk ? cmp("RC3", input.totalRefunded, sumMinor(success.filter((t) => t.kind === "REFUND").map((t) => t.amount)), cur) : unknown("RC3", txReason, cur, input.totalRefunded);
  if (input.refundHeaders && input.totalRefunded !== null && input.refundHeaders.every((h) => h.currency === cur)) {
    const headers = sumMinor(input.refundHeaders.map((h) => h.total));
    if (headers !== minor(input.totalRefunded)) {
      rc3 = { status: "mismatch", candidate: false, expected: input.totalRefunded, actual: rc3.actual ?? fromMinor(headers), currency: cur, reason: "refund_headers_mismatch" };
    }
  }

  const rc4 = salesOk
    ? cmp("RC4", input.currentTotalTax, sumMinor(input.sales.filter((s) => s.lineType === "PRODUCT").map((s) => s.totalTax)), cur)
    : unknown("RC4", salesReason, cur, input.currentTotalTax);

  let rc5: CheckResult;
  if (!salesOk) rc5 = unknown("RC5", salesReason, cur);
  else {
    const refundSales = input.sales.filter((s) => REFUND_AGREEMENTS.has(s.agreementKind));
    if (refundSales.length === 0) rc5 = { status: "not_applicable", candidate: false, expected: null, actual: null, currency: cur, reason: "no_refund_sales" };
    else {
      const allowed = new Set<number>([0, RETURN_SALE_SIGN]);
      const violations = refundSales.filter(
        (s) => !allowed.has(signOf(s.totalAmount)) || (s.quantity !== null && !allowed.has(Math.sign(s.quantity))),
      ).length;
      rc5 = { status: violations === 0 ? "ok" : "mismatch", candidate: false, expected: null, actual: null, currency: cur, violations };
    }
  }
  return { version: RECONCILIATION_VERSION, checks: { RC1: rc1, RC2: rc2, RC3: rc3, RC4: rc4, RC5: rc5 } };
}

/** Невідомий стан усіх перевірок (замовлення ще не читалося / недоступне). */
export function unknownReconciliation(reason: CheckReason = "sales_not_read"): ReconciliationResult {
  const checks = {} as Record<ReconciliationCheck, CheckResult>;
  for (const c of RECONCILIATION_CHECKS) checks[c] = unknown(c, reason, null);
  return { version: RECONCILIATION_VERSION, checks };
}

export function mismatchedChecks(r: ReconciliationResult): ReconciliationCheck[] {
  return RECONCILIATION_CHECKS.filter((c) => r.checks[c].status === "mismatch");
}

/**
 * Ключ розбіжності перевірки: значення входять у ключ — рішення власника стосується саме цієї розбіжності; інші значення
 * (Shopify змінив підсумок) — нова розбіжність, стара закривається системою.
 */
export function reconciliationDedupeParts(orderId: string, check: ReconciliationCheck, result: CheckResult): Array<string | number> {
  return [orderId, check, result.expected ?? "-", result.actual ?? "-", result.violations ?? 0, result.reason ?? "-"];
}

/** Шаблон LIKE «починається з» (екрановані \\, %, _ — типовий символ екранування PostgreSQL). */
export function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, "\\$&")}%`;
}

/** Префікс ключів розбіжностей перевірки замовлення (для закриття системою). */
export function reconciliationKeyPrefix(orderId: string, check: ReconciliationCheck | "sale" | "fee"): string {
  return `reconciliation_mismatch:${orderId}:${check}:`;
}

/** Значення поля факту для ключа й деталей розбіжності (десяткові рядки, коди, id, ISO-дати; null → "-"). */
export function factValueText(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** FNV-1a 64 (BigInt) — короткий детермінований відбиток значень (не криптографія: лише розрізнити набори значень). */
export function valuesDigest(values: readonly string[]): string {
  let h = 0xcbf29ce484222325n;
  for (const ch of JSON.stringify(values)) {
    h ^= BigInt(ch.codePointAt(0)!);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Зміна незмінного факту (той самий Sale.id / TransactionFee.id з іншими значеннями). Відбиток ПОБАЧЕНИХ значень полів,
 * що відрізняються, входить у ключ (як у reconciliationDedupeParts): рішення власника стосується саме цієї зміни; інші
 * значення того самого id — нова розбіжність (стара відкрита закривається системою).
 */
export function factChangeDedupeParts(orderId: string, kind: "sale" | "fee", shopifyId: string, observed: readonly string[]): Array<string> {
  return [orderId, kind, shopifyId, valuesDigest(observed)];
}

/** Префікс ключів змін одного факту (усі відбитки значень). */
export function factChangeKeyPrefix(orderId: string, kind: "sale" | "fee", shopifyId: string): string {
  return `${reconciliationKeyPrefix(orderId, kind)}${shopifyId}:`;
}

export interface ReconciliationDiscrepancyState {
  check: ReconciliationCheck | "sale" | "fee";
  status: DiscrepancyStatus;
}

/**
 * Складники, які мають бути `partial` (`reconciliation_mismatch`) — для WP4 (§2.6, §16.5): підтверджена перевірка
 * (RC2/RC3/RC5) з розбіжністю, розбіжність якої ще відкрита; змінений незмінний продаж → виручка; комісія → комісії.
 * Кандидати (RC1, RC4) складник не змінюють. Розв'язана/проігнорована власником розбіжність — не partial.
 */
export function partialComponentsOf(r: ReconciliationResult | null, open: readonly ReconciliationDiscrepancyState[]): OrderComponent[] {
  const out = new Set<OrderComponent>();
  const isOpen = (check: ReconciliationDiscrepancyState["check"]) => open.some((d) => d.check === check && d.status === "open");
  if (r) {
    for (const c of RECONCILIATION_CHECKS) {
      if (RECONCILIATION_CANDIDATES.includes(c) || r.checks[c].status !== "mismatch" || !isOpen(c)) continue;
      for (const comp of RECONCILIATION_AFFECTS[c]) out.add(comp);
    }
  }
  if (isOpen("sale")) out.add("revenue");
  if (isOpen("fee")) out.add("fees");
  return [...out];
}

/** Розбір збереженого JSON (order_shopify_finance.reconciliation); невідома форма → null. */
export function parseReconciliation(value: unknown): ReconciliationResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { version?: unknown; checks?: Record<string, unknown> };
  if (v.version !== RECONCILIATION_VERSION || !v.checks || typeof v.checks !== "object") return null;
  for (const c of RECONCILIATION_CHECKS) {
    const r = v.checks[c] as { status?: unknown } | undefined;
    if (!r || !["ok", "mismatch", "unknown", "not_applicable"].includes(String(r.status))) return null;
  }
  return value as ReconciliationResult;
}

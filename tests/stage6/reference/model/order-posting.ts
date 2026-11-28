/**
 * Еталонна модель (WP12a): сирі факти замовлення → записи журналу, стани складників, прогнози (§2.1, §2.6, §3.2,
 * §3.3, §4, §7.1–§7.2, §8.1–§8.3, §9.3–§9.4, §16.5).
 *
 * Модель «стан на момент asOf»: факт враховується, лише якщо він відомий (`knownAt` ≤ asOf; типово — момент самої
 * події). Факти, що надійшли до визнання, проводяться під час визнання (R1). Ключі записів — ілюстративні (у форматі
 * §14.5), тож WP12b порівнює записи за (orderId, category, amount, currency, recognizedOn, fxOn), а не за ключами.
 */
import { allocate, cents, mulDiv, str, type Cents } from "./money";
import { addDays, instantMs, kyivDate } from "./dates";
import { saleCategory, type Agreement, type RefCategory, type RefComponent, type SaleLineType } from "./categories";
import { postingDates, reverseEntry, type RefEntry, type RefMonthClosure } from "./journal";
import { commissionFor, partnerBase, type PartnerEvent, type PartnerSaleInput } from "./partners";

export type ComponentState = "actual" | "partial" | "forecast" | "missing" | "zero_confirmed" | "not_applicable";
export type ProfitState = "final" | "preliminary" | "incomplete";
export type OrderState = ProfitState | "open" | "closed_unrecognized" | "excluded";

export interface RefComponentValue {
  state: ComponentState;
  reason: string | null;
  basis: string | null;
  hasForecast: boolean;
  required: boolean;
}

export interface RefSaleFact {
  id: string;
  agreement: Agreement;
  lineType: SaleLineType;
  lineId?: string | null;
  productId?: string | null;
  quantity?: number | null;
  /** `Sale.totalAmount` (з податком), зі знаком Shopify (повернення — від'ємні). */
  totalAmount: string;
  taxAmount: string;
  /** Знижка до податків, природний знак (додатна на продажі угоди order). */
  discountAmount?: string | null;
  happenedAt: string;
  knownAt?: string;
}

export interface RefTransactionFact {
  id: string;
  kind: "SALE" | "CAPTURE" | "AUTHORIZATION" | "REFUND" | "VOID" | "CHANGE";
  status: "SUCCESS" | "FAILURE" | "PENDING" | "ERROR";
  test?: boolean;
  amount: string;
  processedAt: string;
  gateway: string;
  fees?: Array<{ id: string; amount: string; currency: string }>;
  knownAt?: string;
}

/** Оцінка руху складу замовлення (або ручна собівартість рядка) у валюті оцінки; `value` — додатна величина. */
export interface RefValuationFact {
  id: string;
  kind: "consume" | "material" | "return" | "stdcogs" | "completion";
  lineId?: string | null;
  productId?: string | null;
  quantity: number;
  value: string | null;
  /** Одиниць без вартості (невідомі / дефіцитні) у виході consume. */
  unknownQty?: number;
  currency: string;
  occurredAt: string;
  knownAt?: string;
}

export type ForecastBasis = "carrier_reported" | "country_average" | "owner_table" | "none";

export interface RefWaybillFact {
  id: string;
  source: "app" | "external";
  number: string;
  country: string;
  chargeableWeightGrams?: number | null;
  cancelled?: boolean;
  /** Заморожений прогноз (знімок при визнанні / при додаванні зовнішнього номера). */
  frozenForecast: { basis: ForecastBasis; amount: string | null; currency: string };
  /** Платник Recipient записано в оцінці відправлення (факт перевізника). */
  payerRecipient?: boolean;
}

export type ChargeType = "delivery" | "additional_service" | "customs_duty" | "return_delivery" | "redirect" | "storage" | "insurance" | "other" | "credit";

export interface RefInvoiceLineFact {
  id: string;
  waybillId: string | null;
  documentId: string;
  chargeType: ChargeType;
  /** Сума рахунку як нараховано (кредит — від'ємна). */
  amount: string;
  currency: string;
  /** charge_date ?? invoice_date. */
  serviceDate: string;
  importedAt: string;
  /** Версія зіставлення (ключ `inv:<lineId>:m<n>`): 1 — під час імпорту, +1 — пізніше ручне зіставлення (§7.3). */
  matchVersion?: number;
  /** Документ замінено новою версією / вищим пріоритетом (§7.3, §7.6): запис рядка сторновано в цей момент (F2). */
  reversedAt?: string | null;
}

export interface RefDisputeFact {
  id: string;
  outcome: "lost" | "accepted" | "won" | "prevented";
  decidedOn: string;
  /** Сума спору брутто (як списав банк) і повернено (DISPUTE_REVERSAL), валюта магазину. */
  disputed: string;
  reversed: string;
  fee?: { amount: string; currency: string; date: string } | null;
  vatReduces?: boolean;
  cancelCommission?: boolean;
  enteredAt: string;
}

export type FeeRule = { kind: "percent"; percentBp: number; fixed?: string } | { kind: "no_fees" };

export interface RefOrderFacts {
  id: string;
  /** Валюта магазину замовлення. */
  currency: string;
  country: string;
  placedAt: string;
  test?: boolean;
  handedOverAt?: string | null;
  consumeAt?: string | null;
  /** Імпортоване вже виконаним без руху → визнання за placed_at (placed_fallback). */
  fulfilledImported?: boolean;
  cancelledBeforeHandover?: boolean;
  displayFinancialStatus?: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED";
  sales: RefSaleFact[];
  transactions: RefTransactionFact[];
  valuations: RefValuationFact[];
  lines: Array<{ id: string; productId: string; quantity: number; requiresShipping?: boolean | null }>;
  waybills: RefWaybillFact[];
  invoiceLines: RefInvoiceLineFact[];
  /** Прогноз доставки замовлення без накладної (рядок `order` знімка). */
  noWaybillForecast?: { basis: ForecastBasis; amount: string | null; currency: string } | null;
  shippingOwnerMark?: "recipient_pays" | "no_shipping_cost" | null;
  /** DDP (умова зі знімка відправлення / налаштування). */
  ddp?: boolean;
  feeRule?: FeeRule | null;
  /** Частки суми періоду (§10.3, факт `allocated`), додатна величина витрати. */
  feeAllocations?: Array<{ expenseId: string; amount: string; currency: string; knownAt: string }>;
  partner?: { partnerId: string; rateBp: number; holdDays?: number } | "ambiguous" | null;
  disputes?: RefDisputeFact[];
  packagingForecast?: string | null;
  /** Власник: «Упаковку цих замовлень обліковано загальною сумою» (місяць підтверджено) → not_applicable. */
  packagingAccountedInBulk?: boolean;
  /** Прогноз собівартості для невідомої частини (додатна величина, валюта оцінки). */
  cogsForecast?: string | null;
  valuationCurrency?: string;
  /** «Оцінка» за orders.subtotal (без угод Shopify), basis order_snapshot. */
  revenueEstimate?: string | null;
  /** Відкрита підтверджена розбіжність звірки (RC2/RC3/RC5) → складник partial. */
  reconciliationMismatch?: boolean;
}

export interface RefPostingSettings {
  rateDatePolicy?: "payment_date" | "recognition_date";
  includeTestOrders?: boolean;
  closures?: readonly RefMonthClosure[];
  partnerHoldDays?: number;
}

export interface RefForecast {
  orderId: string;
  component: RefComponent;
  /** Зі знаком впливу на прибуток (витрата «−», оцінка виручки «+»). */
  amount: string;
  currency: string;
  fxOn: string;
  recognizedOn: string;
  basis: string;
  waybillId?: string | null;
}

export interface RefOrderResult {
  orderId: string;
  state: OrderState;
  recognizedOn: string | null;
  recognizedAt: string | null;
  recognitionBasis: "handover" | "consume" | "placed_fallback" | null;
  placedOn: string;
  paymentDate: string;
  country: string;
  currency: string;
  components: Partial<Record<RefComponent, RefComponentValue>>;
  /** Складники без значення й без прогнозу (для «Неможливо розрахувати: …»). */
  missing: RefComponent[];
  flags: string[];
  partnerEvents: PartnerEvent[];
  partnerHoldUntil: string | null;
}

export interface OrderPosting {
  order: RefOrderResult;
  entries: RefEntry[];
  forecasts: RefForecast[];
}

const known = (knownAt: string | undefined, eventAt: string, asOf: string) => instantMs(knownAt ?? eventAt) <= instantMs(asOf);
const laterOf = (a: string, b: string) => (instantMs(a) >= instantMs(b) ? a : b);
const maxDate = (a: string, b: string) => (a >= b ? a : b);

function entry(e: Omit<RefEntry, "originalOn" | "isLate" | "isLateCompletion" | "reversesKey"> & { isLateCompletion?: boolean }, postedAt: string, closures: readonly RefMonthClosure[]): RefEntry {
  const d = postingDates({ recognizedOn: e.recognizedOn, fxOn: e.fxOn }, postedAt, closures);
  return { ...e, recognizedOn: d.recognizedOn, fxOn: d.fxOn, originalOn: d.originalOn, isLate: d.isLate, isLateCompletion: e.isLateCompletion ?? false, reversesKey: null };
}

function settled(s: ComponentState): boolean {
  return s === "actual" || s === "zero_confirmed" || s === "not_applicable";
}

function missingWithoutForecast(c: RefComponentValue): boolean {
  if (c.state === "missing") return !c.hasForecast;
  if (c.state === "partial") return c.reason !== "reconciliation_mismatch" && !c.hasForecast;
  return false;
}

/** Стан прибутку замовлення (§2.6). */
export function profitStateOf(components: Partial<Record<RefComponent, RefComponentValue>>): ProfitState {
  const req = Object.values(components).filter((c): c is RefComponentValue => Boolean(c && c.required));
  if (req.length === 0) return "incomplete";
  if (req.every((c) => settled(c.state))) return "final";
  if (req.some(missingWithoutForecast)) return "incomplete";
  return "preliminary";
}

const cv = (state: ComponentState, extra: Partial<RefComponentValue> = {}): RefComponentValue => ({
  state,
  reason: null,
  basis: null,
  hasForecast: false,
  required: true,
  ...extra,
});

/**
 * Проведення одного замовлення станом на `asOf` (момент ISO). Рахується визнання (§3.2), записи R1/R2/R3/R5,
 * складники й прогнози (§2.6, §4), події партнера (§9.4), chargeback (§8.2).
 */
export function postOrder(o: RefOrderFacts, asOf: string, s: RefPostingSettings = {}): OrderPosting {
  const closures = s.closures ?? [];
  const sales = o.sales.filter((x) => known(x.knownAt, x.happenedAt, asOf));
  const txs = o.transactions.filter((x) => known(x.knownAt, x.processedAt, asOf));
  const vals = o.valuations.filter((x) => known(x.knownAt, x.occurredAt, asOf));
  const invLines = o.invoiceLines.filter((x) => known(x.importedAt, x.importedAt, asOf));
  const disputes = (o.disputes ?? []).filter((x) => known(x.enteredAt, x.enteredAt, asOf));
  const placedOn = kyivDate(o.placedAt);
  const firstPayment = txs
    .filter((t) => t.status === "SUCCESS" && !t.test && (t.kind === "SALE" || t.kind === "CAPTURE"))
    .map((t) => t.processedAt)
    .sort((a, b) => instantMs(a) - instantMs(b))[0];
  const paymentDate = firstPayment ? kyivDate(firstPayment) : placedOn;
  const evidence: Array<[string, "handover" | "consume"]> = [];
  if (o.handedOverAt && instantMs(o.handedOverAt) <= instantMs(asOf)) evidence.push([o.handedOverAt, "handover"]);
  if (o.consumeAt && instantMs(o.consumeAt) <= instantMs(asOf)) evidence.push([o.consumeAt, "consume"]);
  evidence.sort((a, b) => instantMs(a[0]) - instantMs(b[0]));
  let recognizedAt: string | null = evidence[0]?.[0] ?? null;
  let basis: RefOrderResult["recognitionBasis"] = evidence[0]?.[1] ?? null;
  if (!recognizedAt && o.fulfilledImported) {
    recognizedAt = o.placedAt;
    basis = "placed_fallback";
  }
  const result: RefOrderResult = {
    orderId: o.id,
    state: "open",
    recognizedOn: null,
    recognizedAt: null,
    recognitionBasis: null,
    placedOn,
    paymentDate,
    country: o.country,
    currency: o.currency,
    components: {},
    missing: [],
    flags: [],
    partnerEvents: [],
    partnerHoldUntil: null,
  };
  const valuationCurrency = o.valuationCurrency ?? "UAH";
  const entries: RefEntry[] = [];
  const forecasts: RefForecast[] = [];

  if (o.test && !s.includeTestOrders) {
    // Тестове замовлення не враховується (F6/§2.5); фізичний вихід складу — inventory_loss test_order (R6).
    result.state = "excluded";
    for (const v of vals.filter((x) => x.kind === "consume" && x.value !== null && cents(x.value) !== 0n)) {
      const d = kyivDate(v.occurredAt);
      entries.push(entry({ key: `val:${v.id}`, orderId: o.id, category: "inventory_loss", amount: str(-cents(v.value!)), currency: v.currency, recognizedOn: d, fxOn: d, details: { kind: "test_order" } }, laterOf(v.knownAt ?? v.occurredAt, v.occurredAt), closures));
    }
    return { order: result, entries, forecasts };
  }

  if (!recognizedAt) {
    if (o.cancelledBeforeHandover) {
      // R5: понесені витрати скасованого до відвантаження — витрати періоду з order_id, датою події.
      result.state = "closed_unrecognized";
      for (const t of txs.filter((x) => x.status === "SUCCESS" && !x.test)) {
        for (const f of t.fees ?? []) {
          const d = kyivDate(t.processedAt);
          entries.push(entry({ key: `fee:${f.id}`, orderId: o.id, category: "payment_fees", amount: str(-cents(f.amount)), currency: f.currency, recognizedOn: d, fxOn: d }, t.knownAt ?? t.processedAt, closures));
        }
      }
      for (const v of vals.filter((x) => x.kind === "material" && x.value !== null)) {
        const d = kyivDate(v.occurredAt);
        entries.push(entry({ key: `pkg:${v.id}`, orderId: o.id, category: "packaging", amount: str(-cents(v.value!)), currency: v.currency, recognizedOn: d, fxOn: d }, v.knownAt ?? v.occurredAt, closures));
      }
      for (const l of invLines) {
        const e = entry({ key: invKey(l), orderId: o.id, category: l.chargeType === "customs_duty" ? "duties_paid" : "shipping_cost", amount: str(-cents(l.amount)), currency: l.currency, recognizedOn: l.serviceDate, fxOn: l.serviceDate }, l.importedAt, closures);
        entries.push(e);
        if (lineReversed(l, asOf)) entries.push(reverseEntry(e, laterOf(l.reversedAt!, l.importedAt), closures));
      }
    }
    return { order: result, entries, forecasts };
  }

  const recognizedOn = kyivDate(recognizedAt);
  result.state = "preliminary";
  result.recognizedOn = recognizedOn;
  result.recognizedAt = recognizedAt;
  result.recognitionBasis = basis;
  const revenueFx = (s.rateDatePolicy ?? "payment_date") === "payment_date" ? paymentDate : recognizedOn;
  const recT = instantMs(recognizedAt);
  const postAt = (knownAt: string) => laterOf(knownAt, recognizedAt!);

  // --- Продажі угод (§2.1, R1/R2) ---
  for (const sale of sales) {
    const after = instantMs(sale.happenedAt) > recT;
    const category = saleCategory(sale.agreement, after, sale.lineType);
    const eventOn = kyivDate(sale.happenedAt);
    const target = after ? { recognizedOn: maxDate(eventOn, recognizedOn), fxOn: eventOn } : { recognizedOn, fxOn: revenueFx };
    const net = cents(sale.totalAmount) - cents(sale.taxAmount);
    const tax = cents(sale.taxAmount);
    const disc = sale.discountAmount ? cents(sale.discountAmount) : 0n;
    const posted = postAt(sale.knownAt ?? sale.happenedAt);
    const common = { orderId: o.id, lineId: sale.lineId ?? null, productId: sale.productId ?? null, currency: o.currency, ...target };
    const preRefund = !after && (sale.agreement === "refund" || sale.agreement === "return");
    if (net !== 0n)
      entries.push(entry({ ...common, key: `sale:${sale.id}:net`, category, amount: str(net), details: { lineType: sale.lineType, agreement: sale.agreement, preRecognitionRefund: preRefund, quantity: sale.quantity ?? null } }, posted, closures));
    if (tax !== 0n) entries.push(entry({ ...common, key: `sale:${sale.id}:tax`, category: "tax_collected_memo", amount: str(tax), details: { lineType: sale.lineType } }, posted, closures));
    if (disc !== 0n) entries.push(entry({ ...common, key: `sale:${sale.id}:disc`, category: "discount_memo", amount: str(disc), details: { lineType: sale.lineType } }, posted, closures));
    if (after && sale.agreement === "order_edit") result.flags.push("edited_after_recognition");
    if (sale.agreement === "unknown") result.flags.push("unknown_agreement");
    if (sale.lineType === "UNKNOWN") result.flags.push("unknown_line_type");
  }

  // --- Комісії транзакцій (§8.1): SALE/CAPTURE — R1 (пізніше визнання — R3), інші види — R2 ---
  let feeFacts = 0;
  for (const t of txs.filter((x) => x.status === "SUCCESS" && !x.test)) {
    for (const f of t.fees ?? []) {
      feeFacts += 1;
      const own = kyivDate(t.processedAt);
      const knownAtFee = t.knownAt ?? t.processedAt;
      let target: { recognizedOn: string; fxOn: string; isLateCompletion?: boolean };
      if (t.kind === "SALE" || t.kind === "CAPTURE") {
        target = instantMs(knownAtFee) <= recT ? { recognizedOn, fxOn: revenueFx } : { recognizedOn, fxOn: own, isLateCompletion: true };
      } else target = { recognizedOn: maxDate(own, recognizedOn), fxOn: own };
      entries.push(entry({ key: `fee:${f.id}`, orderId: o.id, category: "payment_fees", amount: str(-cents(f.amount)), currency: f.currency, ...target }, postAt(knownAtFee), closures));
    }
  }
  for (const a of o.feeAllocations ?? []) {
    if (!known(a.knownAt, a.knownAt, asOf)) continue;
    feeFacts += 1;
    const late = instantMs(a.knownAt) > recT;
    entries.push(entry({ key: `alloc:${a.expenseId}:${o.id}:v1`, orderId: o.id, category: "payment_fees", amount: str(-cents(a.amount)), currency: a.currency, recognizedOn, fxOn: recognizedOn, isLateCompletion: late, details: { basis: "allocated" } }, postAt(a.knownAt), closures));
  }

  // --- Собівартість і упаковка з оцінок складу (§6.5): R1; повернення — R2; завершення — R3 ---
  for (const v of vals) {
    const value = v.value === null ? 0n : cents(v.value);
    const own = kyivDate(v.occurredAt);
    const kAt = v.knownAt ?? v.occurredAt;
    const common = { orderId: o.id, lineId: v.lineId ?? null, productId: v.productId ?? null, currency: v.currency };
    if (value === 0n) continue;
    if (v.kind === "consume") entries.push(entry({ ...common, key: `cogs:${v.id}`, category: "cogs", amount: str(-value), recognizedOn, fxOn: recognizedOn, details: { quantity: v.quantity } }, postAt(kAt), closures));
    else if (v.kind === "stdcogs") entries.push(entry({ ...common, key: `stdcogs:${v.lineId ?? v.id}:v1`, category: "cogs", amount: str(-value), recognizedOn, fxOn: recognizedOn, details: { quantity: v.quantity, basis: "owner_standard" } }, postAt(kAt), closures));
    else if (v.kind === "material") entries.push(entry({ ...common, key: `pkg:${v.id}`, category: "packaging", amount: str(-value), recognizedOn, fxOn: recognizedOn }, postAt(kAt), closures));
    else if (v.kind === "return") entries.push(entry({ ...common, key: `cogsret:${v.id}`, category: "cogs_return", amount: str(value), recognizedOn: maxDate(own, recognizedOn), fxOn: own, details: { quantity: v.quantity } }, postAt(kAt), closures));
    else entries.push(entry({ ...common, key: `valc:${v.id}`, category: "cogs", amount: str(-value), recognizedOn, fxOn: own, isLateCompletion: instantMs(kAt) > recT }, postAt(kAt), closures));
  }

  // --- Доставка з рахунків (§7.1–§7.2) ---
  // Рядок, сторнований (замінений) ще до визнання, ніколи не проводився: факти до визнання чекають визнання (R1), тож
  // на момент визнання його вже немає — ні запису, ні сторно, і першим документом накладної він не є.
  const shipLines = invLines.filter((l) => !(lineReversed(l, asOf) && instantMs(l.reversedAt!) <= recT));
  const orderWaybills = new Set(o.waybills.map((w) => w.id));
  const firstDocByWaybill = new Map<string, number>();
  for (const l of shipLines) {
    if (!l.waybillId || !orderWaybills.has(l.waybillId) || isR2Charge(l)) continue;
    const t = instantMs(l.importedAt);
    const prev = firstDocByWaybill.get(l.waybillId);
    if (prev === undefined || t < prev) firstDocByWaybill.set(l.waybillId, t);
  }
  // Перший документ накладної лишається першим і після заміни (його записи сторновано): нові версії й пізніші
  // документи — R2 (§7.3 «кредити й нові версії — R2»). Фактична доставка накладної — є чинний (не сторнований)
  // рядок вартості, не R2-типу.
  const actualWaybills = new Set<string>();
  let dutyLines = 0;
  for (const l of shipLines) {
    if (l.waybillId && !orderWaybills.has(l.waybillId)) continue;
    const reversed = lineReversed(l, asOf);
    const category: RefCategory = l.chargeType === "customs_duty" ? "duties_paid" : l.chargeType === "return_delivery" || l.chargeType === "redirect" ? "return_shipping_cost" : "shipping_cost";
    if (category === "duties_paid" && !reversed) dutyLines += 1;
    let target: { recognizedOn: string; fxOn: string; isLateCompletion?: boolean };
    const first = l.waybillId ? firstDocByWaybill.get(l.waybillId) : undefined;
    if (!isR2Charge(l) && first !== undefined && instantMs(l.importedAt) === first) {
      target = instantMs(l.importedAt) <= recT ? { recognizedOn, fxOn: l.serviceDate } : { recognizedOn, fxOn: l.serviceDate, isLateCompletion: true };
    } else target = { recognizedOn: maxDate(l.serviceDate, recognizedOn), fxOn: l.serviceDate };
    if (!isR2Charge(l) && !reversed && l.waybillId) actualWaybills.add(l.waybillId);
    const e = entry({ key: invKey(l), orderId: o.id, category, amount: str(-cents(l.amount)), currency: l.currency, ...target, details: { chargeType: l.chargeType, waybillId: l.waybillId } }, postAt(l.importedAt), closures);
    entries.push(e);
    if (reversed) entries.push(reverseEntry(e, postAt(laterOf(l.reversedAt!, l.importedAt)), closures));
  }

  // --- Chargeback (§8.2): втрата L ділиться за нетто/податок замовлення ---
  const netSales = sales.filter((x) => x.lineType !== "GIFT_CARD").reduce((a, x) => a + cents(x.totalAmount) - cents(x.taxAmount), 0n);
  const taxSales = sales.filter((x) => x.lineType !== "GIFT_CARD").reduce((a, x) => a + cents(x.taxAmount), 0n);
  const chargebacks: Array<{ date: string; at: string; netPart: Cents; cancel: boolean }> = [];
  for (const d of [...disputes].sort((a, b) => (a.decidedOn < b.decidedOn ? -1 : a.decidedOn > b.decidedOn ? 1 : 0))) {
    const posted = postAt(d.enteredAt);
    const target = { recognizedOn: maxDate(d.decidedOn, recognizedOn), fxOn: d.decidedOn };
    const loss = cents(d.disputed) - cents(d.reversed);
    if ((d.outcome === "lost" || d.outcome === "accepted") && loss > 0n) {
      const weights = [netSales > 0n ? netSales : 0n, taxSales > 0n ? taxSales : 0n];
      const [netPart, taxPart] = weights[0]! + weights[1]! > 0n ? (allocate(loss, weights) as [Cents, Cents]) : [loss, 0n];
      if (netPart !== 0n) entries.push(entry({ key: `cb:${d.id}:loss:v1`, orderId: o.id, category: "chargeback_loss", amount: str(-netPart), currency: o.currency, ...target }, posted, closures));
      if (taxPart !== 0n) {
        entries.push(
          d.vatReduces
            ? entry({ key: `cb:${d.id}:tax:v1`, orderId: o.id, category: "tax_collected_memo", amount: str(-taxPart), currency: o.currency, ...target }, posted, closures)
            : entry({ key: `cb:${d.id}:tax:v1`, orderId: o.id, category: "chargeback_loss", amount: str(-taxPart), currency: o.currency, ...target, details: { taxPart: true } }, posted, closures),
        );
      }
      chargebacks.push({ date: target.recognizedOn, at: posted, netPart, cancel: Boolean(d.cancelCommission) });
      if (sales.some((x) => instantMs(x.happenedAt) > recT && (x.agreement === "refund" || x.agreement === "return"))) result.flags.push("chargeback_refund_overlap");
    }
    if (d.fee && cents(d.fee.amount) !== 0n) {
      entries.push(entry({ key: `cb:${d.id}:fee:v1`, orderId: o.id, category: "chargeback_fees", amount: str(-cents(d.fee.amount)), currency: d.fee.currency, recognizedOn: maxDate(d.fee.date, recognizedOn), fxOn: d.fee.date }, posted, closures));
    }
  }

  // --- Партнер (§9.3–§9.4): нарахування при визнанні, коригування датою кожної пізнішої події ---
  let partnerComponent: RefComponentValue | null = null;
  if (o.partner === "ambiguous") partnerComponent = cv("missing", { reason: "ambiguous_partner" });
  else if (o.partner) {
    const p = o.partner;
    const asInput = (xs: readonly RefSaleFact[]): PartnerSaleInput[] => xs.map((x) => ({ agreement: x.agreement, lineType: x.lineType, totalAmount: x.totalAmount, taxAmount: x.taxAmount }));
    type Point = { date: string; at: string; sales: RefSaleFact[]; cb: typeof chargebacks; refunded: boolean };
    const points: Point[] = [{ date: recognizedOn, at: recognizedAt, sales: sales.filter((x) => instantMs(x.happenedAt) <= recT), cb: [], refunded: false }];
    const later = sales.filter((x) => instantMs(x.happenedAt) > recT);
    const timeline = [
      ...later.map((x) => ({ date: maxDate(kyivDate(x.happenedAt), recognizedOn), at: postAt(x.knownAt ?? x.happenedAt), sale: x as RefSaleFact | null, cb: null as (typeof chargebacks)[number] | null })),
      ...chargebacks.map((c) => ({ date: c.date, at: c.at, sale: null as RefSaleFact | null, cb: c as (typeof chargebacks)[number] | null })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.sale && !b.sale ? -1 : !a.sale && b.sale ? 1 : 0));
    for (const ev of timeline) {
      const prev = points[points.length - 1]!;
      points.push({ date: ev.date, at: ev.at, sales: ev.sale ? [...prev.sales, ev.sale] : prev.sales, cb: ev.cb ? [...prev.cb, ev.cb] : prev.cb, refunded: false });
    }
    if (o.displayFinancialStatus === "REFUNDED") {
      const last = points[points.length - 1]!;
      points.push({ ...last, refunded: true });
    }
    const events: PartnerEvent[] = [];
    let total = 0n;
    for (const pt of points) {
      const base = partnerBase(asInput(pt.sales), {
        refundedFully: pt.refunded,
        chargebackNetLoss: pt.cb.reduce((a, c) => a + c.netPart, 0n),
        cancelOnChargeback: pt.cb.some((c) => c.cancel),
      });
      const desired = commissionFor(base, p.rateBp);
      const delta = desired - total;
      if (delta === 0n) continue;
      const n = events.length + 1;
      const kind = n === 1 ? "accrual" : desired === 0n ? "cancellation" : "adjustment";
      events.push({ n, kind, amount: delta, date: pt.date });
      entries.push(entry({ key: `pc:${o.id}:${p.partnerId}:${n}`, orderId: o.id, category: "partner_commission", amount: str(-delta), currency: o.currency, recognizedOn: pt.date, fxOn: pt.date, details: { event: kind } }, pt.at, closures));
      total = desired;
    }
    result.partnerEvents = events;
    result.partnerHoldUntil = addDays(recognizedOn, p.holdDays ?? s.partnerHoldDays ?? 30);
    partnerComponent = cv("actual", { basis: "shopify" });
  }

  // --- Складники (§2.6) і прогнози (§4) ---
  const comps: Partial<Record<RefComponent, RefComponentValue>> = {};
  if (sales.length > 0) comps.revenue = o.reconciliationMismatch ? cv("partial", { reason: "reconciliation_mismatch", basis: "shopify" }) : cv("actual", { basis: "shopify" });
  else if (o.revenueEstimate && cents(o.revenueEstimate) !== 0n) {
    // «Оцінка» (order_snapshot) — окремим рядком, НІКОЛИ не факт; без підтвердження власника замовлення incomplete (§4).
    comps.revenue = cv("missing", { reason: "awaiting_shopify", basis: "order_snapshot" });
    forecasts.push({ orderId: o.id, component: "revenue", amount: o.revenueEstimate, currency: o.currency, fxOn: revenueFx, recognizedOn, basis: "order_snapshot" });
  } else comps.revenue = cv("missing", { reason: "awaiting_shopify" });

  if (o.lines.length > 0) {
    let valued = 0;
    let required = 0;
    let fromStandard = 0;
    for (const line of o.lines) {
      required += line.quantity;
      const lv = vals.filter((v) => v.lineId === line.id);
      const std = lv.filter((v) => v.kind === "stdcogs").reduce((a, v) => a + v.quantity, 0);
      const q =
        lv.filter((v) => v.kind === "consume").reduce((a, v) => a + v.quantity - (v.unknownQty ?? 0), 0) +
        lv.filter((v) => v.kind === "completion").reduce((a, v) => a + v.quantity, 0) +
        std;
      valued += Math.min(q, line.quantity);
      fromStandard += Math.min(std, line.quantity);
    }
    const hasForecast = o.cogsForecast !== undefined && o.cogsForecast !== null;
    // «Факт (за ручною собівартістю)» (§6.5 п. 2, §6.8): позиції без списання оцінено ручною собівартістю власника —
    // основа owner_standard; якщо хоч одну одиницю оцінено так (решта — зі складу), основа теж owner_standard,
    // бо факт частково спирається на дані власника (тлумачення моделі).
    if (valued >= required) comps.cogs = cv("actual", { basis: fromStandard > 0 ? "owner_standard" : "valuation" });
    else comps.cogs = cv(valued > 0 ? "partial" : "missing", { reason: "no_cost", hasForecast, basis: hasForecast ? "pool_average" : null });
    if (valued < required && hasForecast) forecasts.push({ orderId: o.id, component: "cogs", amount: str(-cents(o.cogsForecast!)), currency: valuationCurrency, fxOn: recognizedOn, recognizedOn, basis: "pool_average" });
  }

  if (vals.some((v) => v.kind === "material" && v.value !== null)) comps.packaging = cv("actual", { basis: "valuation" });
  else if (o.packagingAccountedInBulk) comps.packaging = cv("not_applicable", { reason: "accounted_in_bulk" });
  else if (o.packagingForecast) {
    comps.packaging = cv("forecast", { basis: "kit_plan", hasForecast: true });
    forecasts.push({ orderId: o.id, component: "packaging", amount: str(-cents(o.packagingForecast)), currency: valuationCurrency, fxOn: recognizedOn, recognizedOn, basis: "kit_plan" });
  } else comps.packaging = cv("missing", { reason: "no_cost" });

  const needsShipping = o.lines.length === 0 || o.lines.some((l) => l.requiresShipping !== false);
  const activeWaybills = o.waybills.filter((w) => !w.cancelled);
  if (!needsShipping) comps.shipping_cost = cv("not_applicable", { reason: "no_shipping_required" });
  else if (o.shippingOwnerMark) comps.shipping_cost = cv("not_applicable", { reason: o.shippingOwnerMark, basis: "manual" });
  else if (activeWaybills.length > 0 && activeWaybills.every((w) => w.payerRecipient)) comps.shipping_cost = cv("not_applicable", { reason: "recipient_pays", basis: "carrier_reported" });
  else if (activeWaybills.length === 0) {
    const f = o.noWaybillForecast;
    const has = Boolean(f && f.amount !== null && f.basis !== "none");
    comps.shipping_cost = cv("missing", { reason: "no_waybill", hasForecast: has, basis: has ? f!.basis : null });
    if (has) forecasts.push({ orderId: o.id, component: "shipping_cost", amount: str(-cents(f!.amount!)), currency: f!.currency, fxOn: recognizedOn, recognizedOn, basis: f!.basis, waybillId: null });
  } else {
    const pending = activeWaybills.filter((w) => !actualWaybills.has(w.id));
    const has = pending.every((w) => w.frozenForecast.amount !== null && w.frozenForecast.basis !== "none");
    if (pending.length === 0) comps.shipping_cost = cv("actual", { basis: "invoice" });
    else {
      const st: ComponentState = pending.length < activeWaybills.length ? "partial" : has ? "forecast" : "missing";
      comps.shipping_cost = cv(st, { reason: has && st === "forecast" ? null : "no_invoice", hasForecast: has, basis: has ? pending[0]!.frozenForecast.basis : null });
      if (has) {
        for (const w of pending) forecasts.push({ orderId: o.id, component: "shipping_cost", amount: str(-cents(w.frozenForecast.amount!)), currency: w.frozenForecast.currency, fxOn: recognizedOn, recognizedOn, basis: w.frozenForecast.basis, waybillId: w.id });
      }
    }
  }

  if (feeFacts > 0) comps.fees = cv("actual", { basis: o.feeAllocations?.length ? "allocated" : "shopify" });
  else if (o.feeRule?.kind === "no_fees") comps.fees = cv("zero_confirmed", { basis: "fee_rule" });
  else if (o.feeRule?.kind === "percent") {
    const paid = txs.filter((t) => t.status === "SUCCESS" && !t.test && (t.kind === "SALE" || t.kind === "CAPTURE")).reduce((a, t) => a + cents(t.amount), 0n);
    const amount = mulDiv(paid, BigInt(o.feeRule.percentBp), 10000n) + (o.feeRule.fixed ? cents(o.feeRule.fixed) : 0n);
    comps.fees = cv("forecast", { basis: "fee_rule", hasForecast: true });
    forecasts.push({ orderId: o.id, component: "fees", amount: str(-amount), currency: o.currency, fxOn: revenueFx, recognizedOn, basis: "fee_rule" });
  } else comps.fees = cv("missing", { reason: "no_fee_data" });

  if (partnerComponent) comps.partner = partnerComponent;
  if (o.ddp) comps.duties_paid = dutyLines > 0 ? cv("actual", { basis: "invoice" }) : cv("missing", { reason: "no_invoice" });

  result.components = comps;
  result.state = profitStateOf(comps);
  result.missing = (Object.keys(comps) as RefComponent[]).filter((k) => comps[k]!.required && missingWithoutForecast(comps[k]!));
  // Прогноз складника, що вже фактичний, не враховується (факт замінює прогноз, §4).
  const out = forecasts.filter((f) => !settled(comps[f.component]?.state ?? "missing"));
  result.flags = [...new Set(result.flags)];
  return { order: result, entries, forecasts: out };
}

const invKey = (l: RefInvoiceLineFact) => `inv:${l.id}:m${l.matchVersion ?? 1}`;
const lineReversed = (l: RefInvoiceLineFact, asOf: string) => Boolean(l.reversedAt) && instantMs(l.reversedAt!) <= instantMs(asOf);

function isR2Charge(l: RefInvoiceLineFact): boolean {
  return l.chargeType === "return_delivery" || l.chargeType === "redirect" || l.chargeType === "credit" || cents(l.amount) < 0n;
}

// ---------------------------------------------------------------------------------------------------------------
// Звірка (§16.5): формули перевірок у одному місці моделі
// ---------------------------------------------------------------------------------------------------------------

export interface ReconcileInput {
  sales: readonly RefSaleFact[];
  transactions: readonly RefTransactionFact[];
  currentTotalPrice?: string;
  netPayment?: string;
  totalRefunded?: string;
  currentTotalTax?: string;
}

/** Перелік перевірок, що НЕ зійшлися (RC1–RC5); перевірка без вхідного підсумку пропускається. */
export function reconcile(i: ReconcileInput): string[] {
  const bad: string[] = [];
  const ok = (tx: RefTransactionFact) => tx.status === "SUCCESS" && !tx.test;
  const sumSales = i.sales.reduce((a, x) => a + cents(x.totalAmount), 0n);
  const paid = i.transactions.filter((t) => ok(t) && (t.kind === "SALE" || t.kind === "CAPTURE")).reduce((a, t) => a + cents(t.amount), 0n);
  const refunded = i.transactions.filter((t) => ok(t) && t.kind === "REFUND").reduce((a, t) => a + cents(t.amount), 0n);
  if (i.currentTotalPrice !== undefined && sumSales !== cents(i.currentTotalPrice)) bad.push("RC1");
  if (i.netPayment !== undefined && paid - refunded !== cents(i.netPayment)) bad.push("RC2");
  if (i.totalRefunded !== undefined && refunded !== cents(i.totalRefunded)) bad.push("RC3");
  const productTax = i.sales.filter((x) => x.lineType === "PRODUCT").reduce((a, x) => a + cents(x.taxAmount), 0n);
  if (i.currentTotalTax !== undefined && productTax !== cents(i.currentTotalTax)) bad.push("RC4");
  if (i.sales.some((x) => (x.agreement === "refund" || x.agreement === "return") && cents(x.totalAmount) > 0n && x.lineType !== "ADJUSTMENT")) bad.push("RC5");
  return bad;
}

/** «Оплачено покупцем» (§2.4): Σ SUCCESS SALE/CAPTURE − Σ SUCCESS REFUND (не тестові). */
export function paidByCustomer(transactions: readonly RefTransactionFact[]): { received: string; refunded: string; net: string } {
  const ok = (t: RefTransactionFact) => t.status === "SUCCESS" && !t.test;
  const received = transactions.filter((t) => ok(t) && (t.kind === "SALE" || t.kind === "CAPTURE")).reduce((a, t) => a + cents(t.amount), 0n);
  const refunded = transactions.filter((t) => ok(t) && t.kind === "REFUND").reduce((a, t) => a + cents(t.amount), 0n);
  return { received: str(received), refunded: str(refunded), net: str(received - refunded) };
}

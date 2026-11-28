/**
 * Етап 6, WP4: план записів журналу замовлення з фактів (docs/stage6-design.md §2.1, §3.3, §7.2, §8.1–§8.3, §4) —
 * ЧИСТІ функції (без БД). syncOrderFinance (sync.server.ts) складає бажаний набір записів, diff.ts порівнює його з
 * діючими записами замовлення й проводить різницю (сторно + repostEntries, F2).
 *
 * Правила дат (§3.3):
 * - R1 складники (продажі угод ORDER/ORDER_EDIT і повернення коштів ДО визнання, комісії SALE/CAPTURE, ручна
 *   собівартість, підтверджені суми, перший документ доставки накладної): `recognized_on` = дата визнання;
 *   `fx_on` виручки й комісій оплати — за політикою D-25 (дата оплати / дата визнання), доставки — дата послуги;
 * - R2 пізніші події (продажі REFUND/RETURN/ORDER_EDIT після визнання, комісії інших видів, chargeback, нові версії й
 *   кредити рахунків): `recognized_on` = max(дата події, дата визнання), `fx_on` = дата події;
 * - R3 пізнє завершення (перша комісія / ручна собівартість / підтверджені суми / перший документ, що надійшли ПІСЛЯ
 *   визнання): дата визнання, `is_late_completion`, `fx_on` — власна дата значення;
 * - R5 скасоване до відвантаження: понесені комісії й доставка — дата події, `order_id` зберігається.
 * Записи закритого місяця переносить ядро (postEntries: `is_late`). Суми — десяткові рядки; нульових записів немає.
 * Валюти з 3–4 знаками не проводяться (замовлення «Потребує перевірки» `unsupported_currency`, §5.1).
 */
import {
  AGREEMENT_KINDS,
  SALE_LINE_TYPES,
  classifySale,
  type AgreementKind,
  type FinanceCategory,
  type OrderFinanceState,
  type ReviewReason,
  type SaleLineType,
} from "~/domain/finance";
import { fromMinor, isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import type { EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { chargebackNetPart } from "~/modules/partners/commission";

// ---------------------------------------------------------------------------------------------------------------
// Факти (рядки БД у формі, незалежній від drizzle)
// ---------------------------------------------------------------------------------------------------------------

export interface SaleFact {
  /** order_sales.id (ключ запису `sale:<id>:net|tax|disc`, source_id — для WP9). */
  id: string;
  agreementKind: AgreementKind;
  happenedAt: Date;
  actionType: string;
  lineType: string;
  quantity: number | null;
  orderLineItemId: string | null;
  totalAmount: string;
  totalTax: string;
  discountBeforeTax: string | null;
  currency: string;
  pTotalAmount: string;
  pTotalTax: string;
  pCurrency: string;
  source: "shopify" | "demo";
}

export interface TransactionFact {
  id: string;
  kind: string;
  status: string;
  test: boolean;
  gateway: string | null;
  amount: string;
  currency: string;
  processedAt: Date | null;
  fxAdjustment: string | null;
  fxAdjustmentCurrency: string | null;
  /** Shopify gid транзакції й батьківської (CAPTURE → AUTHORIZATION): комісії авторизації стосуються її списань. */
  shopifyId?: string | null;
  parentShopifyId?: string | null;
}

export interface FeeFact {
  id: string;
  transactionId: string;
  type: string | null;
  amount: string;
  currency: string;
  taxAmount: string | null;
  taxCurrency: string | null;
}

export interface DisputeFact {
  id: string;
  version: number;
  outcome: "lost" | "accepted" | "won" | "prevented" | null;
  /** Брутто (як списав банк); null — суми ще немає. */
  amount: string | null;
  recoveredAmount: string | null;
  currency: string | null;
  fee: string | null;
  feeCurrency: string | null;
  decidedOn: string | null;
  vatReducible: boolean | null;
  source: "shopify" | "manual" | "demo";
}

export interface InvoiceLineFact {
  id: string;
  invoiceId: string;
  /** carrier_invoices.imported_at документа рядка. */
  importedAt: Date;
  chargeType: string;
  /** Дата послуги: charge_date ?? invoice_date (§3.3). */
  serviceDate: string;
  amount: string;
  amountExclVat: string | null;
  currency: string;
  carrierCode: string;
  shipmentId: string | null;
  externalWaybillId: string | null;
  matchVersion: number;
  /** Документ діючий і проводить (`status = active`, `posting`), рядок зіставлено з цим замовленням. */
  active: boolean;
  /**
   * За рядком уже проводився запис `inv:` цього замовлення (зокрема згодом сторнований). Недіючий рядок, що ніколи не
   * проводився (документ замінено / анульовано ще до визнання), першим документом накладної не є (§3.3).
   */
  posted?: boolean;
}

/** Ключ накладної (одиниця обліку доставки, §7.1). */
export function waybillKeyOf(l: { shipmentId: string | null; externalWaybillId: string | null }): string | null {
  if (l.shipmentId) return `shipment:${l.shipmentId}`;
  if (l.externalWaybillId) return `external:${l.externalWaybillId}`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Контекст проведення
// ---------------------------------------------------------------------------------------------------------------

export interface PlanContext {
  orderId: string;
  storeId: string;
  state: OrderFinanceState;
  recognizedOn: string | null;
  recognizedAt: Date | null;
  /** Дата курсу виручки й комісій оплати (D-25). */
  revenueFxOn: string;
  /** Цей виклик уперше враховує замовлення (визнання або повторне ввімкнення): факти — R1, не «пізнє завершення». */
  newlyCounted: boolean;
  /** Країна призначення (finance_entries.country_code). */
  countryCode: string | null;
  /** Позиція → варіант (виміри записів для рейтингів). */
  lineVariants?: ReadonlyMap<string, string | null>;
  /**
   * Виручка визнаного замовлення ще не фактична (угоди не прочитано повністю під час визнання, діючих записів продажів і
   * підтверджених сум немає): перші продажі до визнання — R3 «пізнє завершення» (дата визнання, `is_late_completion`).
   */
  revenueLate?: boolean;
}

const maxDate = (a: string, b: string) => (a >= b ? a : b);
const neg = (amount: string, currency: string) => fromMinor(-toMinorForCurrency(amount, currency));
const isZero = (amount: string, currency: string) => toMinorForCurrency(amount, currency) === 0n;

export function normalizeLineType(value: string): SaleLineType {
  return (SALE_LINE_TYPES as readonly string[]).includes(value) ? (value as SaleLineType) : "UNKNOWN";
}

export function normalizeAgreementKind(value: string): AgreementKind {
  return (AGREEMENT_KINDS as readonly string[]).includes(value) ? (value as AgreementKind) : "unknown";
}

function signOf(amount: string, currency: string): -1 | 0 | 1 {
  const m = toMinorForCurrency(amount, currency);
  return m < 0n ? -1 : m > 0n ? 1 : 0;
}

/** Продаж після визнання (момент угоди пізніший за recognized_at). */
export function isAfterRecognition(happenedAt: Date, recognizedAt: Date | null): boolean {
  return recognizedAt !== null && happenedAt.getTime() > recognizedAt.getTime();
}

export interface PlanPart {
  entries: EntryInput[];
  review: ReviewReason[];
}

// ---------------------------------------------------------------------------------------------------------------
// Продажі угод (§2.1, SALE_CATEGORY_MAP)
// ---------------------------------------------------------------------------------------------------------------

/** Записи продажів визнаного замовлення: нетто (без податку) + податок (довідково) + знижка (довідково). */
export function saleEntries(sales: readonly SaleFact[], ctx: PlanContext): PlanPart {
  const entries: EntryInput[] = [];
  const review = new Set<ReviewReason>();
  if (ctx.state !== "recognized" || !ctx.recognizedOn) return { entries, review: [] };
  for (const s of sales) {
    const lineType = normalizeLineType(s.lineType);
    const agreementKind = normalizeAgreementKind(s.agreementKind);
    if (!isSupportedCurrency(s.currency)) {
      review.add("unsupported_currency");
      continue;
    }
    const after = isAfterRecognition(s.happenedAt, ctx.recognizedAt);
    const cls = classifySale({ agreementKind, timing: after ? "after_recognition" : "before_recognition", lineType, sign: signOf(s.totalAmount, s.currency) });
    for (const r of cls.review) review.add(r);
    const eventOn = businessDate(s.happenedAt);
    const dates: { recognizedOn: string; fxOn: string; isLateCompletion?: boolean } = after
      ? { recognizedOn: maxDate(eventOn, ctx.recognizedOn), fxOn: eventOn }
      : ctx.revenueLate && !ctx.newlyCounted
        ? { recognizedOn: ctx.recognizedOn, fxOn: ctx.revenueFxOn, isLateCompletion: true }
        : { recognizedOn: ctx.recognizedOn, fxOn: ctx.revenueFxOn };
    const total = toMinorForCurrency(s.totalAmount, s.currency);
    const tax = toMinorForCurrency(s.totalTax, s.currency);
    const net = total - tax;
    const pSupported = isSupportedCurrency(s.pCurrency);
    const pNet = pSupported ? toMinorForCurrency(s.pTotalAmount, s.pCurrency) - toMinorForCurrency(s.pTotalTax, s.pCurrency) : null;
    const common = {
      ...dates,
      orderId: ctx.orderId,
      orderLineItemId: s.orderLineItemId,
      variantId: s.orderLineItemId ? (ctx.lineVariants?.get(s.orderLineItemId) ?? null) : null,
      quantity: s.quantity,
      countryCode: ctx.countryCode,
      currency: s.currency,
      sourceType: "shopify_sale" as const,
      sourceId: s.id,
      storeId: ctx.storeId,
    };
    const baseDetails = { lineType, agreement: agreementKind, actionType: s.actionType.slice(0, 60), source: s.source };
    if (net !== 0n) {
      entries.push({
        ...common,
        idempotencyKey: financeKeys.sale(s.id, "net"),
        category: cls.category,
        amount: fromMinor(net),
        presentmentAmount: pNet !== null && pNet !== 0n ? fromMinor(pNet) : null,
        presentmentCurrency: pNet !== null && pNet !== 0n ? s.pCurrency : null,
        details: { ...baseDetails, preRecognitionRefund: cls.preRecognitionRefund },
      });
    }
    if (tax !== 0n) {
      entries.push({ ...common, idempotencyKey: financeKeys.sale(s.id, "tax"), category: "tax_collected_memo", amount: fromMinor(tax), details: baseDetails });
    }
    if (s.discountBeforeTax && !isZero(s.discountBeforeTax, s.currency)) {
      entries.push({ ...common, idempotencyKey: financeKeys.sale(s.id, "disc"), category: "discount_memo", amount: s.discountBeforeTax, details: baseDetails });
    }
  }
  return { entries, review: [...review] };
}

// ---------------------------------------------------------------------------------------------------------------
// Комісії транзакцій (§8.1)
// ---------------------------------------------------------------------------------------------------------------

/** Тип комісії Shopify, що стосується спору (§8.2 chargeback_fee_overlap; типи НЕДОКУМЕНТОВАНІ). */
export const DISPUTE_FEE_TYPE_RE = /dispute|chargeback/i;

export function feeEntries(fees: readonly FeeFact[], transactions: readonly TransactionFact[], ctx: PlanContext): PlanPart {
  const entries: EntryInput[] = [];
  const review = new Set<ReviewReason>();
  const counted = ctx.state === "recognized" || ctx.state === "closed_unrecognized";
  if (!counted) return { entries, review: [] };
  const txById = new Map(transactions.map((t) => [t.id, t]));
  for (const f of fees) {
    const t = txById.get(f.transactionId);
    if (!t || t.status !== "SUCCESS" || t.test) continue;
    if (!isSupportedCurrency(f.currency)) {
      review.add("unsupported_currency");
      continue;
    }
    if (isZero(f.amount, f.currency)) continue;
    const own = businessDate(t.processedAt ?? ctx.recognizedAt ?? new Date(0));
    const disputeFee = Boolean(f.type && DISPUTE_FEE_TYPE_RE.test(f.type));
    let dates: { recognizedOn: string; fxOn: string; isLateCompletion?: boolean };
    if (ctx.state === "closed_unrecognized" || !ctx.recognizedOn) dates = { recognizedOn: own, fxOn: own };
    else if ((t.kind === "SALE" || t.kind === "CAPTURE") && !disputeFee) {
      dates = ctx.newlyCounted ? { recognizedOn: ctx.recognizedOn, fxOn: ctx.revenueFxOn } : { recognizedOn: ctx.recognizedOn, fxOn: own, isLateCompletion: true };
    } else dates = { recognizedOn: maxDate(own, ctx.recognizedOn), fxOn: own };
    entries.push({
      idempotencyKey: financeKeys.fee(f.id),
      category: disputeFee ? "chargeback_fees" : "payment_fees",
      ...dates,
      amount: neg(f.amount, f.currency),
      currency: f.currency,
      orderId: ctx.orderId,
      countryCode: ctx.countryCode,
      sourceType: "shopify_fee",
      sourceId: f.id,
      storeId: ctx.storeId,
      details: {
        transactionKind: t.kind.slice(0, 40),
        ...(t.gateway ? { gateway: t.gateway.slice(0, 120) } : {}),
        ...(f.type ? { feeType: f.type.slice(0, 60) } : {}),
        ...(f.taxAmount !== null && f.taxCurrency ? { feeTax: f.taxAmount, feeTaxCurrency: f.taxCurrency } : {}),
      },
    });
  }
  return { entries, review: [...review] };
}

/** Коригування курсу транзакцій Shopify — лише довідково (§5.7, `shopify_fx_adjustment_memo`). */
export function fxAdjustmentEntries(transactions: readonly TransactionFact[], ctx: PlanContext): EntryInput[] {
  const out: EntryInput[] = [];
  if (ctx.state !== "recognized" && ctx.state !== "closed_unrecognized") return out;
  for (const t of transactions) {
    if (t.status !== "SUCCESS" || t.test || !t.fxAdjustment || !t.fxAdjustmentCurrency) continue;
    if (!isSupportedCurrency(t.fxAdjustmentCurrency) || isZero(t.fxAdjustment, t.fxAdjustmentCurrency)) continue;
    const own = businessDate(t.processedAt ?? ctx.recognizedAt ?? new Date(0));
    const recognizedOn = ctx.state === "recognized" && ctx.recognizedOn ? maxDate(own, ctx.recognizedOn) : own;
    out.push({
      idempotencyKey: financeKeys.fxAdjustment(t.id),
      category: "shopify_fx_adjustment_memo",
      recognizedOn,
      fxOn: own,
      amount: t.fxAdjustment,
      currency: t.fxAdjustmentCurrency,
      orderId: ctx.orderId,
      countryCode: ctx.countryCode,
      sourceType: "shopify_transaction",
      sourceId: t.id,
      storeId: ctx.storeId,
      details: { transactionKind: t.kind.slice(0, 40) },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Chargeback (§8.2, D-26)
// ---------------------------------------------------------------------------------------------------------------

export function isLostDispute(d: Pick<DisputeFact, "outcome">): boolean {
  return d.outcome === "lost" || d.outcome === "accepted";
}

/** Нетто/брутто продажів замовлення (усі угоди, без подарункових карток) — ваги розподілу втрати. */
export function netAndTaxOf(sales: readonly SaleFact[], currency: string): { net: bigint; tax: bigint } {
  let net = 0n;
  let tax = 0n;
  for (const s of sales) {
    if (normalizeLineType(s.lineType) === "GIFT_CARD" || s.currency !== currency) continue;
    const t = toMinorForCurrency(s.totalTax, s.currency);
    net += toMinorForCurrency(s.totalAmount, s.currency) - t;
    tax += t;
  }
  return { net, tax };
}

export interface ChargebackPlan extends PlanPart {
  /** Програний спір + повернення коштів після визнання (можлива подвійна втрата → розбіжність). */
  refundOverlap: boolean;
  /** Ручна комісія спору поряд із комісією Shopify типу спору (розбіжність chargeback_fee_overlap). */
  feeOverlapDisputeIds: string[];
}

/**
 * Записи chargeback: чиста втрата L = сума − повернено (> 0) ділиться за нетто/податок замовлення (WP7
 * chargebackNetPart: allocateMinor у кванті валюти — JPY/KRW цілими одиницями);
 * нетто → chargeback_loss; податкова частина → сторно tax_collected_memo, якщо «ПДВ зменшується», інакше теж
 * chargeback_loss з details.taxPart. Дата — рішення (R2). Комісія — chargeback_fees датою рішення. Ручна комісія спору
 * НЕ проводиться, якщо в замовлення є комісія Shopify типу спору (типово «Замінити ручну»), доки власник не обрав
 * «Залишити обидва» (`keepBothFeeDisputeIds`).
 */
export function chargebackEntries(
  disputes: readonly DisputeFact[],
  sales: readonly SaleFact[],
  ctx: PlanContext & { shopCurrency: string },
  opts: { shopifyDisputeFee: boolean; keepBothFeeDisputeIds: ReadonlySet<string> },
): ChargebackPlan {
  const entries: EntryInput[] = [];
  const review = new Set<ReviewReason>();
  let refundOverlap = false;
  const feeOverlap: string[] = [];
  if (disputes.some((d) => d.outcome === null)) review.add("dispute_open");
  const counted = ctx.state === "recognized" || ctx.state === "closed_unrecognized";
  if (!counted) return { entries, review: [...review], refundOverlap, feeOverlapDisputeIds: feeOverlap };
  const refundsAfter = sales.some(
    (s) => (s.agreementKind === "refund" || s.agreementKind === "return") && isAfterRecognition(s.happenedAt, ctx.recognizedAt),
  );
  for (const d of [...disputes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    if (!d.decidedOn) continue;
    const recognizedOn = ctx.state === "recognized" && ctx.recognizedOn ? maxDate(d.decidedOn, ctx.recognizedOn) : d.decidedOn;
    const dates = { recognizedOn, fxOn: d.decidedOn };
    const common = { orderId: ctx.orderId, countryCode: ctx.countryCode, sourceType: "chargeback" as const, sourceId: d.id, storeId: ctx.storeId, ...dates };
    if (isLostDispute(d) && d.amount !== null && d.currency && isSupportedCurrency(d.currency)) {
      const loss = toMinorForCurrency(d.amount, d.currency) - (d.recoveredAmount ? toMinorForCurrency(d.recoveredAmount, d.currency) : 0n);
      if (loss > 0n) {
        const w = d.currency === ctx.shopCurrency ? netAndTaxOf(sales, d.currency) : { net: 0n, tax: 0n };
        // Та сама функція, що база партнера (WP7): найбільші остачі в кванті валюти (0 знаків — цілі одиниці, §5.1).
        const { net: netPart, tax: taxPart } = chargebackNetPart(loss, w.net, w.tax, d.currency);
        if (netPart !== 0n) {
          entries.push({ ...common, idempotencyKey: financeKeys.chargeback(d.id, "loss", d.version), category: "chargeback_loss", amount: fromMinor(-netPart), currency: d.currency, details: { outcome: d.outcome } });
        }
        if (taxPart !== 0n) {
          entries.push({
            ...common,
            idempotencyKey: financeKeys.chargeback(d.id, "tax", d.version),
            category: d.vatReducible ? "tax_collected_memo" : "chargeback_loss",
            amount: fromMinor(-taxPart),
            currency: d.currency,
            details: { outcome: d.outcome, taxPart: true },
          });
        }
        if (refundsAfter) refundOverlap = true;
      }
    }
    if (d.fee !== null && d.feeCurrency && isSupportedCurrency(d.feeCurrency) && !isZero(d.fee, d.feeCurrency)) {
      const manual = d.source !== "shopify";
      if (manual && opts.shopifyDisputeFee) {
        feeOverlap.push(d.id);
        if (!opts.keepBothFeeDisputeIds.has(d.id)) continue;
      }
      entries.push({ ...common, idempotencyKey: financeKeys.chargeback(d.id, "fee", d.version), category: "chargeback_fees", amount: neg(d.fee, d.feeCurrency), currency: d.feeCurrency, details: { outcome: d.outcome } });
    }
  }
  if (refundOverlap) review.add("chargeback_refund_overlap");
  return { entries, review: [...review], refundOverlap, feeOverlapDisputeIds: feeOverlap };
}

// ---------------------------------------------------------------------------------------------------------------
// Доставка з рахунків перевізника (§7.1–§7.2)
// ---------------------------------------------------------------------------------------------------------------

/** Типи нарахувань, що проводяться як пізніші події (R2), а не перше фактичне значення накладної. */
export function isLaterChargeType(chargeType: string, amount: string, currency: string): boolean {
  return chargeType === "return_delivery" || chargeType === "redirect" || chargeType === "credit" || toMinorForCurrency(amount, currency) < 0n;
}

export function invoiceCategoryOf(chargeType: string): FinanceCategory {
  if (chargeType === "customs_duty") return "duties_paid";
  if (chargeType === "return_delivery" || chargeType === "redirect") return "return_shipping_cost";
  return "shipping_cost";
}

/**
 * Записи рядків рахунків, зіставлених із замовленням (ключ `inv:<lineId>:m<n>`). `lines` — УСІ рядки замовлення,
 * зокрема замінених документів (для «першого документа» накладної); проводяться лише діючі (`active`). Перший документ
 * накладної (найраніший імпорт її рядків вартості не R2-типу серед діючих або вже проведених — `posted`) — R1 / R3;
 * інші документи, кредити, повернення й переадресація — R2. Рядок документа, заміненого чи анульованого ще до визнання,
 * не проводився ніколи (відкрите замовлення записів не має) — першим фактичним значенням він не був, тож пізніший
 * перший документ — R3 (дата визнання, пізнє завершення). Скасоване до відвантаження / виключене — R5 (дата послуги).
 */
export function invoiceLineEntries(lines: readonly InvoiceLineFact[], ctx: PlanContext, opts: { vatPayer: boolean }): EntryInput[] {
  const out: EntryInput[] = [];
  if (ctx.state === "open") return out;
  // Перший документ — окремо для доставки й для мита накладної: мито (DDP) — окремий складник duties_paid (§2.6, §7.2),
  // тож документ лише з митом не є «першою фактичною доставкою» (як і sync.server hasActual), і пізніший перший рядок
  // доставки — R3 (дата визнання, пізнє завершення), а не R2; перший рядок мита — так само R1/R3 складника мита.
  const firstKey = (wb: string, chargeType: string) => `${wb}|${chargeType === "customs_duty" ? "duty" : "ship"}`;
  const firstByWaybill = new Map<string, number>();
  for (const l of lines) {
    const wb = waybillKeyOf(l);
    if (!wb || (!l.active && !l.posted) || isLaterChargeType(l.chargeType, l.amount, l.currency)) continue;
    const k = firstKey(wb, l.chargeType);
    const t = l.importedAt.getTime();
    const prev = firstByWaybill.get(k);
    if (prev === undefined || t < prev) firstByWaybill.set(k, t);
  }
  for (const l of lines) {
    if (!l.active || !isSupportedCurrency(l.currency)) continue;
    const amount = opts.vatPayer && l.amountExclVat !== null ? l.amountExclVat : l.amount;
    if (isZero(amount, l.currency)) continue;
    const wb = waybillKeyOf(l);
    let dates: { recognizedOn: string; fxOn: string; isLateCompletion?: boolean };
    if (ctx.state !== "recognized" || !ctx.recognizedOn || !ctx.recognizedAt) dates = { recognizedOn: l.serviceDate, fxOn: l.serviceDate };
    else if (wb && !isLaterChargeType(l.chargeType, l.amount, l.currency) && firstByWaybill.get(firstKey(wb, l.chargeType)) === l.importedAt.getTime()) {
      dates = { recognizedOn: ctx.recognizedOn, fxOn: l.serviceDate, isLateCompletion: l.importedAt.getTime() > ctx.recognizedAt.getTime() };
    } else dates = { recognizedOn: maxDate(l.serviceDate, ctx.recognizedOn), fxOn: l.serviceDate };
    out.push({
      idempotencyKey: financeKeys.invoiceLine(l.id, l.matchVersion),
      category: invoiceCategoryOf(l.chargeType),
      ...dates,
      amount: neg(amount, l.currency),
      currency: l.currency,
      orderId: ctx.orderId,
      shipmentId: l.shipmentId,
      carrierCode: l.carrierCode,
      countryCode: ctx.countryCode,
      sourceType: "invoice_line",
      sourceId: l.id,
      storeId: ctx.storeId,
      details: { chargeType: l.chargeType, invoiceId: l.invoiceId, ...(wb ? { waybillKey: wb } : {}), vatExcluded: opts.vatPayer && l.amountExclVat !== null },
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Підтверджені власником суми замовлення (§4 «Підтвердити суми замовлення»)
// ---------------------------------------------------------------------------------------------------------------

export interface ConfirmedAmounts {
  version: number;
  /** Товари без податків (після знижок), валюта магазину. */
  products: string;
  /** Доставка без податків. */
  shipping: string;
  currency: string;
}

/** Записи підтверджених сум (лише визнане замовлення без повних угод Shopify). */
export function confirmationEntries(c: ConfirmedAmounts | null, ctx: PlanContext): EntryInput[] {
  if (!c || ctx.state !== "recognized" || !ctx.recognizedOn || !isSupportedCurrency(c.currency)) return [];
  const out: EntryInput[] = [];
  const common = {
    recognizedOn: ctx.recognizedOn,
    fxOn: ctx.revenueFxOn,
    isLateCompletion: !ctx.newlyCounted,
    currency: c.currency,
    orderId: ctx.orderId,
    countryCode: ctx.countryCode,
    sourceType: "owner_confirmation" as const,
    sourceId: ctx.orderId,
    storeId: ctx.storeId,
    details: { basis: "owner_confirmed", confirmationVersion: c.version },
  };
  if (!isZero(c.products, c.currency)) out.push({ ...common, idempotencyKey: financeKeys.ownerConfirmation(ctx.orderId, c.version, "products"), category: "sales_product", amount: fromMinor(toMinorForCurrency(c.products, c.currency)) });
  if (!isZero(c.shipping, c.currency)) out.push({ ...common, idempotencyKey: financeKeys.ownerConfirmation(ctx.orderId, c.version, "shipping"), category: "sales_shipping", amount: fromMinor(toMinorForCurrency(c.shipping, c.currency)) });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Ручна собівартість позицій без списання (§6.5 п. 2, `stdcogs`)
// ---------------------------------------------------------------------------------------------------------------

export interface StandardCogsLine {
  lineId: string;
  variantId: string | null;
  stockItemId: string | null;
  /** Кількість, передана при визнанні (фіксується в записі). */
  quantity: number;
  /** Підтверджена ручна собівартість на дату визнання (null — немає). */
  standard: { unitCost: string; currency: string; costId: string } | null;
}

/** Записи stdcogs (ключ `stdcogs:<lineId>:v1`); діючий запис позиції НЕ перераховується (F6) — це робить diff.ts. */
export function standardCogsEntries(lines: readonly StandardCogsLine[], ctx: PlanContext): EntryInput[] {
  const out: EntryInput[] = [];
  if (ctx.state !== "recognized" || !ctx.recognizedOn) return out;
  for (const l of lines) {
    if (!l.standard || l.quantity <= 0 || !isSupportedCurrency(l.standard.currency)) continue;
    const minor = toMinorForCurrency(l.standard.unitCost, l.standard.currency) * BigInt(l.quantity);
    if (minor === 0n) continue;
    out.push({
      idempotencyKey: financeKeys.standardCogs(l.lineId, 1),
      category: "cogs",
      recognizedOn: ctx.recognizedOn,
      fxOn: ctx.recognizedOn,
      isLateCompletion: !ctx.newlyCounted,
      amount: fromMinor(-minor),
      currency: l.standard.currency,
      orderId: ctx.orderId,
      orderLineItemId: l.lineId,
      variantId: l.variantId,
      stockItemId: l.stockItemId,
      quantity: l.quantity,
      countryCode: ctx.countryCode,
      sourceType: "owner_standard",
      sourceId: l.standard.costId,
      storeId: ctx.storeId,
      details: { basis: "owner_standard", unitCost: l.standard.unitCost, quantity: l.quantity },
    });
  }
  return out;
}

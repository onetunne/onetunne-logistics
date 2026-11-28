/**
 * Етап 6 (WP3): розбір фінансових відповідей Admin API (docs/stage6-design.md §16.3). Відповіді НЕ довіряються: форма —
 * zod (поелементно: пошкоджений елемент → помилка з шляхом і кодом, решта розбирається), гроші — строгий
 * parseShopifyMoney (пошкоджене → null, НІКОЛИ 0). Чисті функції без мережі й бази.
 *
 * Наслідки для фактів (контракт для WP4 — `order_shopify_finance.snapshot.status`):
 * - продажі угод — «усе або нічого»: будь-яка помилка продажу/угоди → продажі цього читання НЕ зберігаються,
 *   status.sales = "damaged" (виручка — missing `awaiting_shopify` + «Потребує перевірки» `amount_parse_error`, без
 *   повторів; наступна зміна замовлення в Shopify перечитає угоди);
 * - транзакції — поелементно: пошкоджена транзакція не зберігається, status.transactions = "damaged" (RC2/RC3 — unknown);
 * - комісії — поелементно, але НЕПОВНИЙ набір ніколи не видається за повний (F4, §8.1): пошкоджена комісія (форма, сума,
 *   фіксована частина, податок чи ставка) не зберігається, transaction.feesComplete = false, status.fees = "damaged"
 *   (так само, коли пошкоджено саму транзакцію — її комісії невідомі); складник комісій тоді не може бути фактичним;
 * - валюта з 3–4 знаками → `unsupported_currency` (грошові факти в ній не зберігаються).
 * Персональні дані не розбираються взагалі (документи їх не вибирають).
 */
import { z } from "zod";
import { AGREEMENT_TYPENAME_KIND, SALE_LINE_TYPES, type AgreementKind, type SaleLineType } from "~/domain/finance";
import {
  FINANCE_REFUNDS_PAGE,
  FINANCE_TOTAL_FIELDS,
  FINANCE_TRANSACTIONS_PAGE,
  type FinanceTotalField,
  type GqlAgreement,
  type GqlOrderFinanceNode,
  type GqlRefund,
  type GqlSale,
} from "~/integrations/shopify/finance-graphql";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";
import { checkCurrency, parseShopifyMoney, parseShopifyRate, type Money, type MoneyErrorCode } from "./money";

// ---------------------------------------------------------------------------
// Помилки розбору
// ---------------------------------------------------------------------------

export const PARSE_AREAS = ["order", "totals", "transactions", "fees", "sales", "refunds", "disputes", "shipping_lines", "tracking", "journey"] as const;
export type ParseArea = (typeof PARSE_AREAS)[number];
export type ParseErrorCode = MoneyErrorCode | "invalid_shape" | "currency_mismatch" | "invalid_date";

/** Помилка розбору: область, шлях у відповіді (без значень) і код. Без персональних даних. */
export interface FinanceParseError {
  area: ParseArea;
  path: string;
  code: ParseErrorCode;
}

/** Найбільше помилок, що зберігаються в знімку (решта — лише лічильник). */
export const MAX_STORED_PARSE_ERRORS = 30;

class Collector {
  readonly errors: FinanceParseError[] = [];
  add(area: ParseArea, path: string, code: ParseErrorCode) {
    this.errors.push({ area, path, code });
  }
  has(area: ParseArea) {
    return this.errors.some((e) => e.area === area);
  }
}

// ---------------------------------------------------------------------------
// Підсумки (MoneyBag)
// ---------------------------------------------------------------------------

/** Ключі підсумків звірки (FINANCE_TOTAL_FIELDS без суфікса Set). */
export const FINANCE_TOTAL_KEYS = FINANCE_TOTAL_FIELDS.map((f) => f.replace(/Set$/, "")) as Array<TotalKeyOf<FinanceTotalField>>;
type TotalKeyOf<F extends string> = F extends `${infer K}Set` ? K : never;
export type FinanceTotalKey = TotalKeyOf<FinanceTotalField>;
/** Підсумки, які Shopify може не повертати (null — не помилка). */
const NULLABLE_TOTALS: ReadonlySet<FinanceTotalKey> = new Set<FinanceTotalKey>(["currentTotalDuties"]);

/** Гроші магазину й покупця (presentment — null, якщо Shopify не дав або значення пошкоджене там, де воно довідкове). */
export interface MoneyPair {
  shop: Money;
  presentment: Money | null;
}

interface BagContext {
  area: ParseArea;
  errors: Collector;
  shopCurrency: string | null;
  presentmentCurrency: string | null;
}

/**
 * MoneyBag → MoneyPair. shopMoney обов'язковий і має бути у валюті магазину; presentmentMoney — обов'язковий лише за
 * requirePresentment (продажі: p_total_amount NOT NULL), інакше пошкоджений → null + помилка.
 */
function moneyBag(bag: unknown, path: string, ctx: BagContext, opts: { nullable?: boolean; requirePresentment?: boolean } = {}): MoneyPair | null {
  if (bag === null || bag === undefined) {
    if (!opts.nullable) ctx.errors.add(ctx.area, path, "invalid_shape");
    return null;
  }
  if (typeof bag !== "object") {
    ctx.errors.add(ctx.area, path, "invalid_shape");
    return null;
  }
  const b = bag as { shopMoney?: unknown; presentmentMoney?: unknown };
  const shop = parseShopifyMoney(b.shopMoney);
  if (!shop.ok) {
    ctx.errors.add(ctx.area, `${path}.shopMoney`, shop.code);
    return null;
  }
  if (ctx.shopCurrency && shop.value.currency !== ctx.shopCurrency) {
    ctx.errors.add(ctx.area, `${path}.shopMoney`, "currency_mismatch");
    return null;
  }
  if (b.presentmentMoney === null || b.presentmentMoney === undefined) {
    if (opts.requirePresentment) {
      ctx.errors.add(ctx.area, `${path}.presentmentMoney`, "invalid_shape");
      return null;
    }
    return { shop: shop.value, presentment: null };
  }
  const p = parseShopifyMoney(b.presentmentMoney);
  if (!p.ok || (ctx.presentmentCurrency && p.value.currency !== ctx.presentmentCurrency)) {
    ctx.errors.add(ctx.area, `${path}.presentmentMoney`, p.ok ? "currency_mismatch" : p.code);
    if (opts.requirePresentment) return null;
    return { shop: shop.value, presentment: null };
  }
  return { shop: shop.value, presentment: p.value };
}

function moneyV2(value: unknown, path: string, area: ParseArea, errors: Collector, nullable = false): Money | null {
  if (value === null || value === undefined) {
    if (!nullable) errors.add(area, path, "invalid_shape");
    return null;
  }
  const r = parseShopifyMoney(value);
  if (!r.ok) {
    errors.add(area, path, r.code);
    return null;
  }
  return r.value;
}

// ---------------------------------------------------------------------------
// Дрібні перевірки форми
// ---------------------------------------------------------------------------

const gid = z.string().min(1).max(200).regex(/^gid:\/\/shopify\/[A-Za-z]+\/[^\s]+$/);
const shortText = (max: number) => z.string().max(max);

function isoDate(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function optionalDate(value: unknown, path: string, area: ParseArea, errors: Collector): Date | null {
  if (value === null || value === undefined) return null;
  const d = isoDate(value);
  if (!d) errors.add(area, path, "invalid_date");
  return d;
}

/** Рядки-коди (коди знижок, назви шлюзів): обрізати, порожні й задовгі відкинути, без повторів, порядок Shopify. */
function codeList(value: unknown, max = 100, limit = 50): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (!t || t.length > max || out.includes(t)) continue;
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const t = value.trim();
  return t && t.length <= max ? t : null;
}

// ---------------------------------------------------------------------------
// OtOrderFinance
// ---------------------------------------------------------------------------

export interface ParsedFee {
  gid: string;
  type: string | null;
  amount: Money;
  flatFee: Money | null;
  /** Як отримано від Shopify (Decimal-рядок), або null. */
  rate: string | null;
  rateName: string | null;
  taxAmount: Money | null;
}

export interface ParsedTransaction {
  gid: string;
  parentGid: string | null;
  kind: string;
  status: string;
  test: boolean;
  gateway: string | null;
  manualGateway: boolean | null;
  amount: MoneyPair;
  settlementCurrency: string | null;
  settlementRate: string | null;
  fxAdjustment: { gid: string; amount: Money | null } | null;
  processedAt: Date | null;
  createdAt: Date | null;
  fees: ParsedFee[];
  /** Усі комісії транзакції розібрано (false — хоч одну відкинуто як пошкоджену: `fees` — НЕ повний набір). */
  feesComplete: boolean;
}

export interface ParsedDispute {
  gid: string;
  initiatedAs: string | null;
  status: string | null;
}

export interface ParsedShippingLine {
  title: string | null;
  code: string | null;
  source: string | null;
  carrierIdentifier: string | null;
  isRemoved: boolean | null;
  discountedPrice: MoneyPair | null;
  currentDiscountedPrice: MoneyPair | null;
}

export type TransactionsStatus = "complete" | "truncated" | "damaged";
/**
 * Стан комісій SUCCESS-транзакцій (§8.1): complete — кожну комісію кожної прочитаної SUCCESS-транзакції розібрано, а
 * транзакції прочитано всі й без помилок; truncated — транзакцій більше за сторінку; damaged — пошкоджена комісія або
 * транзакція (її комісії невідомі). Лише "complete" дозволяє вважати збережені комісії повним фактом.
 */
export type FeesStatus = "complete" | "truncated" | "damaged";

export interface ParsedOrderFinance {
  orderGid: string;
  updatedAt: Date;
  createdAt: Date | null;
  processedAt: Date | null;
  cancelledAt: Date | null;
  test: boolean;
  edited: boolean | null;
  taxesIncluded: boolean | null;
  /** Валюта магазину (null — пошкоджена або непідтримувана: див. currencyStatus). */
  shopCurrency: string | null;
  presentmentCurrency: string | null;
  currencyStatus: "ok" | "unsupported" | "invalid";
  displayFinancialStatus: string | null;
  returnStatus: string | null;
  paymentGatewayNames: string[];
  discountCodes: string[];
  journey: { ready: boolean | null; referralCode: string | null };
  totals: Record<FinanceTotalKey, MoneyPair | null>;
  shippingLines: ParsedShippingLine[];
  transactions: ParsedTransaction[];
  transactionsCount: number | null;
  transactionsStatus: TransactionsStatus;
  feesStatus: FeesStatus;
  disputes: ParsedDispute[];
  /** Трек-номери виконань Shopify (сирі; нормалізує recordExternalWaybills). */
  trackingNumbers: string[];
  errors: FinanceParseError[];
}

const orderHeadSchema = z.object({ id: gid, updatedAt: z.string() });

const transactionSchema = z.object({
  id: gid,
  kind: shortText(40),
  status: shortText(40),
  test: z.boolean().nullish(),
  gateway: shortText(120).nullish(),
  manualPaymentGateway: z.boolean().nullish(),
  createdAt: z.string().nullish(),
  processedAt: z.string().nullish(),
  parentTransaction: z.object({ id: gid }).nullish(),
  amountSet: z.unknown(),
  settlementCurrency: z.string().nullish(),
  settlementCurrencyRate: z.unknown(),
  currencyExchangeAdjustment: z.object({ id: gid, adjustment: z.unknown() }).nullish(),
  fees: z.array(z.unknown()).nullish(),
});

const feeSchema = z.object({
  id: gid,
  type: shortText(80).nullish(),
  amount: z.unknown(),
  flatFee: z.unknown(),
  rate: z.unknown(),
  rateName: shortText(120).nullish(),
  taxAmount: z.unknown(),
});

const disputeSchema = z.object({ id: gid, initiatedAs: shortText(40).nullish(), status: shortText(40).nullish() });

/**
 * Комісія — цілком або ніяк: будь-яке пошкоджене поле (форма, amount, flatFee, taxAmount, rate) → null + помилка області
 * "fees" (рядок незмінний, тож частковий запис дав би хибну «зміну» при наступному коректному читанні).
 */
function parseFee(raw: unknown, path: string, errors: Collector): ParsedFee | null {
  const f = feeSchema.safeParse(raw);
  if (!f.success) {
    errors.add("fees", path, "invalid_shape");
    return null;
  }
  const before = errors.errors.length;
  const amount = moneyV2(f.data.amount, `${path}.amount`, "fees", errors);
  const flatFee = moneyV2(f.data.flatFee, `${path}.flatFee`, "fees", errors, true);
  const taxAmount = moneyV2(f.data.taxAmount, `${path}.taxAmount`, "fees", errors, true);
  const rate = typeof f.data.rate === "string" && /^-?\d+(\.\d+)?$/.test(f.data.rate) && f.data.rate.length <= 32 ? f.data.rate : null;
  if (f.data.rate !== null && f.data.rate !== undefined && rate === null) errors.add("fees", `${path}.rate`, "invalid_amount");
  if (!amount || errors.errors.length > before) return null;
  return { gid: f.data.id, type: f.data.type ?? null, amount, flatFee, rate, rateName: f.data.rateName ?? null, taxAmount };
}

function parseTransaction(raw: unknown, i: number, ctx: BagContext): ParsedTransaction | null {
  const path = `transactions[${i}]`;
  const t = transactionSchema.safeParse(raw);
  if (!t.success) {
    ctx.errors.add("transactions", path, "invalid_shape");
    return null;
  }
  const d = t.data;
  const amount = moneyBag(d.amountSet, `${path}.amountSet`, { ...ctx, area: "transactions", presentmentCurrency: null });
  if (!amount) return null;
  const settlement = d.settlementCurrency ? checkCurrency(d.settlementCurrency) : null;
  if (settlement && !settlement.ok) ctx.errors.add("transactions", `${path}.settlementCurrency`, settlement.code);
  const settlementRate = d.settlementCurrencyRate === null || d.settlementCurrencyRate === undefined ? null : parseShopifyRate(d.settlementCurrencyRate);
  if (d.settlementCurrencyRate !== null && d.settlementCurrencyRate !== undefined && settlementRate === null) {
    ctx.errors.add("transactions", `${path}.settlementCurrencyRate`, "invalid_amount");
  }
  const fees: ParsedFee[] = [];
  let feesComplete = true;
  for (const [j, f] of (d.fees ?? []).entries()) {
    const fee = parseFee(f, `${path}.fees[${j}]`, ctx.errors);
    if (fee) fees.push(fee);
    else feesComplete = false;
  }
  return {
    gid: d.id,
    parentGid: d.parentTransaction?.id ?? null,
    kind: d.kind,
    status: d.status,
    test: d.test === true,
    gateway: d.gateway ?? null,
    manualGateway: d.manualPaymentGateway ?? null,
    amount,
    settlementCurrency: settlement?.ok ? settlement.currency : null,
    settlementRate,
    fxAdjustment: d.currencyExchangeAdjustment
      ? {
          gid: d.currencyExchangeAdjustment.id,
          amount: moneyV2(d.currencyExchangeAdjustment.adjustment, `${path}.currencyExchangeAdjustment.adjustment`, "transactions", ctx.errors, true),
        }
      : null,
    processedAt: optionalDate(d.processedAt, `${path}.processedAt`, "transactions", ctx.errors),
    createdAt: optionalDate(d.createdAt, `${path}.createdAt`, "transactions", ctx.errors),
    fees,
    feesComplete,
  };
}

/**
 * Розбір OtOrderFinance. Відсутні id/updatedAt (сама відповідь пошкоджена) — неповторювана помилка відповіді (нічого не
 * зберігається); решта — поелементно з помилками.
 */
export function parseOrderFinance(node: GqlOrderFinanceNode | Record<string, unknown>): ParsedOrderFinance {
  const head = orderHeadSchema.safeParse(node);
  const updatedAt = head.success ? isoDate(head.data.updatedAt) : null;
  if (!head.success || !updatedAt) throw new ShopifyApiError("Shopify returned an invalid finance order", false, "FINANCE_RESPONSE_INVALID");
  const o = node as Record<string, unknown>;
  const errors = new Collector();

  const currency = checkCurrency(o.currencyCode);
  const shopCurrency = currency.ok ? currency.currency : null;
  if (!currency.ok) errors.add("order", "currencyCode", currency.code);
  const pc = o.presentmentCurrencyCode === null || o.presentmentCurrencyCode === undefined ? null : checkCurrency(o.presentmentCurrencyCode);
  if (pc && !pc.ok) errors.add("order", "presentmentCurrencyCode", pc.code);
  const presentmentCurrency = pc?.ok ? pc.currency : null;
  const bag: BagContext = { area: "totals", errors, shopCurrency, presentmentCurrency };

  const totals = {} as Record<FinanceTotalKey, MoneyPair | null>;
  for (const [i, field] of FINANCE_TOTAL_FIELDS.entries()) {
    const key = FINANCE_TOTAL_KEYS[i]!;
    totals[key] = shopCurrency ? moneyBag(o[field], field, bag, { nullable: NULLABLE_TOTALS.has(key) }) : null;
  }

  const transactions: ParsedTransaction[] = [];
  const rawTransactions = Array.isArray(o.transactions) ? o.transactions : [];
  if (!Array.isArray(o.transactions)) errors.add("transactions", "transactions", "invalid_shape");
  if (shopCurrency) {
    for (const [i, raw] of rawTransactions.entries()) {
      const t = parseTransaction(raw, i, bag);
      if (t) transactions.push(t);
    }
  }
  const countRaw = (o.transactionsCount as { count?: unknown } | null | undefined)?.count;
  const transactionsCount = typeof countRaw === "number" && Number.isSafeInteger(countRaw) && countRaw >= 0 ? countRaw : null;
  // Обрізання видно точно лише з transactionsCount.count > розміру сторінки (§16.1); без лічильника — за довжиною списку.
  const truncated = transactionsCount !== null ? transactionsCount > FINANCE_TRANSACTIONS_PAGE : rawTransactions.length >= FINANCE_TRANSACTIONS_PAGE;
  const transactionsStatus: TransactionsStatus =
    !shopCurrency || errors.has("transactions") ? "damaged" : truncated ? "truncated" : "complete";
  // Комісії: пошкоджена транзакція (її комісії невідомі) або відкинута комісія SUCCESS-транзакції — НЕ повний набір.
  const feesStatus: FeesStatus =
    transactionsStatus === "damaged" || transactions.some((t) => t.status === "SUCCESS" && !t.feesComplete)
      ? "damaged"
      : transactionsStatus === "truncated"
        ? "truncated"
        : "complete";

  const disputes: ParsedDispute[] = [];
  for (const [i, raw] of (Array.isArray(o.disputes) ? o.disputes : []).entries()) {
    const d = disputeSchema.safeParse(raw);
    if (d.success) disputes.push({ gid: d.data.id, initiatedAs: d.data.initiatedAs ?? null, status: d.data.status ?? null });
    else errors.add("disputes", `disputes[${i}]`, "invalid_shape");
  }

  const shippingLines: ParsedShippingLine[] = [];
  const slNodes = (o.shippingLines as { nodes?: unknown } | null | undefined)?.nodes;
  for (const [i, raw] of (Array.isArray(slNodes) ? slNodes : []).entries()) {
    if (!raw || typeof raw !== "object") {
      errors.add("shipping_lines", `shippingLines[${i}]`, "invalid_shape");
      continue;
    }
    const s = raw as Record<string, unknown>;
    const ctx: BagContext = { ...bag, area: "shipping_lines" };
    shippingLines.push({
      title: text(s.title, 120),
      code: text(s.code, 120),
      source: text(s.source, 120),
      carrierIdentifier: text(s.carrierIdentifier, 120),
      isRemoved: typeof s.isRemoved === "boolean" ? s.isRemoved : null,
      discountedPrice: shopCurrency ? moneyBag(s.discountedPriceSet, `shippingLines[${i}].discountedPriceSet`, ctx) : null,
      currentDiscountedPrice: shopCurrency ? moneyBag(s.currentDiscountedPriceSet, `shippingLines[${i}].currentDiscountedPriceSet`, ctx) : null,
    });
  }

  const trackingNumbers: string[] = [];
  for (const f of Array.isArray(o.fulfillments) ? o.fulfillments : []) {
    const info = (f as { trackingInfo?: unknown } | null)?.trackingInfo;
    for (const t of Array.isArray(info) ? info : []) {
      const n = text((t as { number?: unknown } | null)?.number, 64);
      if (n && !trackingNumbers.includes(n)) trackingNumbers.push(n);
    }
  }

  const journeyRaw = o.customerJourneySummary as { ready?: unknown; lastVisit?: { referralCode?: unknown } | null } | null | undefined;
  const ready = typeof journeyRaw?.ready === "boolean" ? journeyRaw.ready : null;
  // Реферальний код — лише коли ready = true (§9.2: інакше сесії ще не створено).
  const referralCode = ready === true ? text(journeyRaw?.lastVisit?.referralCode, 100) : null;

  return {
    orderGid: head.data.id,
    updatedAt,
    createdAt: optionalDate(o.createdAt, "createdAt", "order", errors),
    processedAt: optionalDate(o.processedAt, "processedAt", "order", errors),
    cancelledAt: optionalDate(o.cancelledAt, "cancelledAt", "order", errors),
    test: o.test === true,
    edited: typeof o.edited === "boolean" ? o.edited : null,
    taxesIncluded: typeof o.taxesIncluded === "boolean" ? o.taxesIncluded : null,
    shopCurrency,
    presentmentCurrency,
    currencyStatus: currency.ok ? "ok" : currency.code === "unsupported_currency" ? "unsupported" : "invalid",
    displayFinancialStatus: text(o.displayFinancialStatus, 40),
    returnStatus: text(o.returnStatus, 40),
    paymentGatewayNames: codeList(o.paymentGatewayNames, 120),
    discountCodes: codeList(o.discountCodes, 100),
    journey: { ready, referralCode },
    totals,
    shippingLines,
    transactions,
    transactionsCount,
    transactionsStatus,
    feesStatus,
    disputes,
    trackingNumbers,
    errors: errors.errors,
  };
}

// ---------------------------------------------------------------------------
// Угоди продажу й продажі
// ---------------------------------------------------------------------------

export interface ParsedSale {
  gid: string;
  actionType: string;
  /** Нормалізований тип рядка (невідоме значення Shopify → UNKNOWN; WP4 → sales_unknown/refund_unknown + перевірка). */
  lineType: SaleLineType;
  quantity: number | null;
  lineItemGid: string | null;
  total: MoneyPair & { presentment: Money };
  tax: MoneyPair & { presentment: Money };
  discountBeforeTax: MoneyPair | null;
}

export interface ParsedAgreement {
  gid: string;
  typename: string;
  kind: AgreementKind;
  reason: string | null;
  happenedAt: Date;
  refundGid: string | null;
  sales: ParsedSale[];
}

export type SalesStatus = "complete" | "damaged" | "unsupported_currency";

export interface ParsedAgreements {
  agreements: ParsedAgreement[];
  /** Id повернень коштів з угод RefundAgreement (без повторів). */
  refundGids: string[];
  status: SalesStatus;
  errors: FinanceParseError[];
}

const agreementSchema = z.object({
  __typename: shortText(80),
  id: gid,
  happenedAt: z.string(),
  reason: shortText(64).nullish(),
  refund: z.object({ id: gid }).nullish(),
});

const saleSchema = z.object({
  __typename: shortText(80).nullish(),
  id: gid,
  actionType: shortText(64),
  lineType: shortText(64),
  quantity: z.number().int().nullish(),
  totalAmount: z.unknown(),
  totalTaxAmount: z.unknown(),
  totalDiscountAmountBeforeTaxes: z.unknown(),
  lineItem: z.object({ id: gid }).nullish(),
});

const LINE_TYPES = new Set<string>(SALE_LINE_TYPES);

function parseSale(raw: GqlSale | unknown, path: string, bag: BagContext): ParsedSale | null {
  const s = saleSchema.safeParse(raw);
  if (!s.success) {
    bag.errors.add("sales", path, "invalid_shape");
    return null;
  }
  const d = s.data;
  const total = moneyBag(d.totalAmount, `${path}.totalAmount`, bag, { requirePresentment: true });
  const tax = moneyBag(d.totalTaxAmount, `${path}.totalTaxAmount`, bag, { requirePresentment: true });
  const discount =
    d.totalDiscountAmountBeforeTaxes === null || d.totalDiscountAmountBeforeTaxes === undefined
      ? null
      : moneyBag(d.totalDiscountAmountBeforeTaxes, `${path}.totalDiscountAmountBeforeTaxes`, bag);
  if (!total || !tax) return null;
  if (d.totalDiscountAmountBeforeTaxes !== null && d.totalDiscountAmountBeforeTaxes !== undefined && !discount) return null;
  return {
    gid: d.id,
    actionType: d.actionType,
    lineType: (LINE_TYPES.has(d.lineType) ? d.lineType : "UNKNOWN") as SaleLineType,
    quantity: d.quantity ?? null,
    lineItemGid: d.lineItem?.id ?? null,
    total: total as ParsedSale["total"],
    tax: tax as ParsedSale["tax"],
    discountBeforeTax: discount,
  };
}

/**
 * Угоди (усі сторінки й усі продажі — їх зібрав читач, read.server.ts) → факти. Будь-яка помилка угоди чи продажу —
 * status "damaged" (продажі цього читання не зберігаються); непідтримувана валюта магазину/покупця — "unsupported_currency".
 */
export function parseAgreements(
  nodes: ReadonlyArray<GqlAgreement | unknown>,
  currencies: { shopCurrency: string | null; presentmentCurrency: string | null; currencyStatus: ParsedOrderFinance["currencyStatus"] },
): ParsedAgreements {
  const errors = new Collector();
  const bag: BagContext = { area: "sales", errors, shopCurrency: currencies.shopCurrency, presentmentCurrency: currencies.presentmentCurrency };
  const agreements: ParsedAgreement[] = [];
  const refundGids: string[] = [];
  if (!currencies.shopCurrency) {
    return {
      agreements: [],
      refundGids: [],
      status: currencies.currencyStatus === "unsupported" ? "unsupported_currency" : "damaged",
      errors: [{ area: "sales", path: "currencyCode", code: currencies.currencyStatus === "unsupported" ? "unsupported_currency" : "invalid_currency" }],
    };
  }
  for (const [i, raw] of nodes.entries()) {
    const path = `agreements[${i}]`;
    const a = agreementSchema.safeParse(raw);
    const happenedAt = a.success ? isoDate(a.data.happenedAt) : null;
    if (!a.success || !happenedAt) {
      errors.add("sales", path, a.success ? "invalid_date" : "invalid_shape");
      continue;
    }
    const salesNodes = (raw as { sales?: { nodes?: unknown } }).sales?.nodes;
    if (!Array.isArray(salesNodes)) {
      errors.add("sales", `${path}.sales`, "invalid_shape");
      continue;
    }
    const sales: ParsedSale[] = [];
    for (const [j, s] of salesNodes.entries()) {
      const sale = parseSale(s, `${path}.sales[${j}]`, bag);
      if (sale) sales.push(sale);
    }
    const refundGid = a.data.refund?.id ?? null;
    if (refundGid && !refundGids.includes(refundGid)) refundGids.push(refundGid);
    agreements.push({
      gid: a.data.id,
      typename: a.data.__typename,
      kind: AGREEMENT_TYPENAME_KIND[a.data.__typename] ?? "unknown",
      reason: a.data.reason ?? null,
      happenedAt,
      refundGid,
      sales,
    });
  }
  const unsupported = errors.errors.some((e) => e.code === "unsupported_currency");
  const status: SalesStatus = errors.errors.length === 0 ? "complete" : unsupported ? "unsupported_currency" : "damaged";
  return { agreements, refundGids, status, errors: errors.errors };
}

// ---------------------------------------------------------------------------
// Повернення коштів
// ---------------------------------------------------------------------------

export interface ParsedRefundLine {
  lineItemGid: string;
  quantity: number;
  restockType: string | null;
  restocked: boolean | null;
  subtotal: MoneyPair | null;
}

export interface ParsedRefund {
  gid: string;
  createdAt: Date | null;
  processedAt: Date | null;
  total: MoneyPair;
  lines: ParsedRefundLine[];
  /** Рядки прочитано всі (refundLineItems.pageInfo.hasNextPage = false). */
  linesComplete: boolean;
}

export type RefundsStatus = "complete" | "incomplete" | "damaged";

export interface ParsedRefunds {
  refunds: ParsedRefund[];
  totalRefunded: MoneyPair | null;
  /**
   * complete — усі повернення й рядки прочитано (кількість < розміру сторінки, §16.5 RC3); incomplete — можливо, є ще
   * (refunds_incomplete); damaged — пошкоджене значення.
   */
  status: RefundsStatus;
  errors: FinanceParseError[];
}

const refundSchema = z.object({ id: gid, createdAt: z.string().nullish(), processedAt: z.string().nullish(), totalRefundedSet: z.unknown() });
const refundLineSchema = z.object({
  quantity: z.number().int().min(0),
  restockType: shortText(40).nullish(),
  restocked: z.boolean().nullish(),
  lineItem: z.object({ id: gid }).nullish(),
  subtotalSet: z.unknown(),
});

export function parseRefunds(
  input: { totalRefundedSet: unknown; refunds: ReadonlyArray<GqlRefund | unknown> | null },
  currencies: { shopCurrency: string | null; presentmentCurrency: string | null },
): ParsedRefunds {
  const errors = new Collector();
  const bag: BagContext = { area: "refunds", errors, shopCurrency: currencies.shopCurrency, presentmentCurrency: currencies.presentmentCurrency };
  if (!currencies.shopCurrency) return { refunds: [], totalRefunded: null, status: "damaged", errors: [{ area: "refunds", path: "currencyCode", code: "invalid_currency" }] };
  const totalRefunded = moneyBag(input.totalRefundedSet, "totalRefundedSet", bag);
  const list = Array.isArray(input.refunds) ? input.refunds : [];
  if (!Array.isArray(input.refunds)) errors.add("refunds", "refunds", "invalid_shape");
  let incomplete = list.length >= FINANCE_REFUNDS_PAGE;
  const refunds: ParsedRefund[] = [];
  for (const [i, raw] of list.entries()) {
    const path = `refunds[${i}]`;
    const r = refundSchema.safeParse(raw);
    if (!r.success) {
      errors.add("refunds", path, "invalid_shape");
      continue;
    }
    const total = moneyBag(r.data.totalRefundedSet, `${path}.totalRefundedSet`, bag);
    if (!total) continue;
    const conn = (raw as { refundLineItems?: { pageInfo?: { hasNextPage?: unknown }; nodes?: unknown } | null }).refundLineItems;
    const linesComplete = conn?.pageInfo?.hasNextPage !== true;
    if (!linesComplete) incomplete = true;
    const lines: ParsedRefundLine[] = [];
    for (const [j, rawLine] of (Array.isArray(conn?.nodes) ? conn.nodes : []).entries()) {
      const lp = `${path}.refundLineItems[${j}]`;
      const l = refundLineSchema.safeParse(rawLine);
      if (!l.success || !l.data.lineItem) {
        errors.add("refunds", lp, "invalid_shape");
        continue;
      }
      const subtotal =
        l.data.subtotalSet === null || l.data.subtotalSet === undefined ? null : moneyBag(l.data.subtotalSet, `${lp}.subtotalSet`, bag);
      lines.push({
        lineItemGid: l.data.lineItem.id,
        quantity: l.data.quantity,
        restockType: l.data.restockType ?? null,
        restocked: l.data.restocked ?? null,
        subtotal,
      });
    }
    refunds.push({
      gid: r.data.id,
      createdAt: optionalDate(r.data.createdAt, `${path}.createdAt`, "refunds", errors),
      processedAt: optionalDate(r.data.processedAt, `${path}.processedAt`, "refunds", errors),
      total,
      lines,
      linesComplete,
    });
  }
  const status: RefundsStatus = errors.errors.length > 0 ? "damaged" : incomplete ? "incomplete" : "complete";
  return { refunds, totalRefunded, status, errors: errors.errors };
}

/** Знак десяткового рядка (−1, 0, 1). */
export function signOf(amount: string): -1 | 0 | 1 {
  if (/^-?0+(\.0+)?$/.test(amount)) return 0;
  return amount.startsWith("-") ? -1 : 1;
}

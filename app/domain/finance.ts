/**
 * Етап 6: ЄДИНИЙ перелік фінансових кодів (docs/stage6-design.md §2, §7, §9–§11, §14, §17).
 *
 * Правило володіння (§21.1): цей файл належить ядру (WP0) і заповнений повністю з першого раунду. Пакети НЕ додають сюди
 * кодів — новий код (категорія, причина, розбіжність, джерело…) = запит до інтеграційного раунду ядра (з міграцією CHECK).
 * Перелік чистий (без БД і React): його імпортують схема (CHECK), ядро, пакети, сторінки й тести.
 *
 * Знак суми запису (`finance_entries.amount`) — за впливом на прибуток: дохід «+», витрата «−» (§0 п. 2);
 * прибуток = Σ amount записів видів revenue…tax. Довідкові (`memo`) — природний знак, у прибуток не входять.
 */

// ---------------------------------------------------------------------------
// Види й категорії журналу (§2.1)
// ---------------------------------------------------------------------------

export const FINANCE_KINDS = [
  "revenue",
  "contra_revenue",
  "cogs",
  "order_cost",
  "period_cost",
  "other_income",
  "fx",
  "tax",
  "memo",
] as const;
export type FinanceKind = (typeof FINANCE_KINDS)[number];

/** Рядки звіту «Прибутки і збитки» (§2.2). Підсумки T, NR, GP, PR — обчислюються з рядків (PNL_TOTALS). */
export const PNL_LINES = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q"] as const;
export type PnlLine = (typeof PNL_LINES)[number];

/** Довідкові рядки (не входять у прибуток), §2.2 «Довідково». */
export const PNL_MEMO_LINES = [
  "memo_tax_collected",
  "memo_discounts",
  "memo_gift_cards",
  "memo_produced",
  "memo_materials",
  "memo_partner_payouts",
  "memo_shopify_fx",
] as const;
export type PnlMemoLine = (typeof PNL_MEMO_LINES)[number];

export const PNL_TOTALS = ["T", "NR", "GP", "PR"] as const;
export type PnlTotal = (typeof PNL_TOTALS)[number];

/**
 * Склад підсумків (§2.2): T = A + B + C; NR = T + D + E; GP = NR + F; PR = Σ усіх рядків A…Q (усі записи видів
 * revenue…tax). Рядки PR — саме PNL_LINES (довідкові не входять).
 */
export const PNL_TOTAL_PARTS: Readonly<Record<PnlTotal, readonly (PnlLine | PnlTotal)[]>> = {
  T: ["A", "B", "C"],
  NR: ["T", "D", "E"],
  GP: ["NR", "F"],
  PR: PNL_LINES,
};

/** Підрядки «у т.ч.» звіту (§2.2) — ключі для сторінок/експорту; визначення — в агрегаторі P&L (WP8). */
export const PNL_SUBLINES = [
  "discounts_product", // довідково: знижки на товари (discount_memo, lineType PRODUCT)
  "gross_product_sales", // довідково: продажі до знижок = A + знижки на товари
  "discounts_shipping", // довідково: знижки на доставку (discount_memo, lineType SHIPPING)
  "gross_shipping", // довідково: доставка до знижок
  "batch_cost_adjustments", // у т.ч. коригування собівартості партій (cogs_adjustment без order_id)
  "return_handling", // у т.ч. обробка повернень
  "profit_from_orders", // у т.ч. прибуток із замовлень
  "period_items", // у т.ч. витрати й доходи періоду
  "paid_not_shipped", // довідково: оплачено, ще не відвантажено (§3.6)
  "open_disputes", // довідково: відкриті спори (кількість)
] as const;
export type PnlSubline = (typeof PNL_SUBLINES)[number];

/** Знак за впливом на прибуток (довідково для інтерфейсу й тестів; не обмеження БД — див. §2.1, продажі до визнання). */
export type CategorySign = "+" | "-" | "±" | "natural";

export interface FinanceCategoryDef {
  kind: FinanceKind;
  /** Рядок P&L (для memo — довідковий рядок). */
  line: PnlLine | PnlMemoLine;
  sign: CategorySign;
}

export const FINANCE_CATEGORY_DEFS = {
  // revenue (+)
  sales_product: { kind: "revenue", line: "A", sign: "+" },
  sales_shipping: { kind: "revenue", line: "B", sign: "+" },
  /** Чайові, мита й збори, сплачені покупцем, FEE, ADDITIONAL_FEE; підтип — details.lineType. */
  sales_other: { kind: "revenue", line: "C", sign: "+" },
  sales_adjustment: { kind: "revenue", line: "C", sign: "±" },
  /** Рядок UNKNOWN → «Потребує перевірки». */
  sales_unknown: { kind: "revenue", line: "C", sign: "±" },
  // contra_revenue (−)
  refund_product: { kind: "contra_revenue", line: "D", sign: "-" },
  refund_shipping: { kind: "contra_revenue", line: "D", sign: "-" },
  refund_other: { kind: "contra_revenue", line: "D", sign: "-" },
  refund_adjustment: { kind: "contra_revenue", line: "D", sign: "±" },
  refund_unknown: { kind: "contra_revenue", line: "D", sign: "-" },
  chargeback_loss: { kind: "contra_revenue", line: "E", sign: "-" },
  // cogs
  cogs: { kind: "cogs", line: "F", sign: "-" },
  cogs_return: { kind: "cogs", line: "F", sign: "+" },
  cogs_adjustment: { kind: "cogs", line: "F", sign: "±" },
  // order_cost (−); без order_id — витрати періоду (ручні суми періоду)
  shipping_cost: { kind: "order_cost", line: "G", sign: "-" },
  return_shipping_cost: { kind: "order_cost", line: "G", sign: "-" },
  return_handling: { kind: "order_cost", line: "O", sign: "-" },
  duties_paid: { kind: "order_cost", line: "H", sign: "-" },
  packaging: { kind: "order_cost", line: "I", sign: "-" },
  payment_fees: { kind: "order_cost", line: "J", sign: "-" },
  platform_fees: { kind: "order_cost", line: "J", sign: "-" },
  chargeback_fees: { kind: "order_cost", line: "K", sign: "-" },
  partner_commission: { kind: "order_cost", line: "L", sign: "±" },
  // period_cost (−)
  shipping_unallocated: { kind: "period_cost", line: "G", sign: "-" },
  packaging_unlinked: { kind: "period_cost", line: "I", sign: "-" },
  advertising: { kind: "period_cost", line: "M", sign: "-" },
  partner_fixed_fee: { kind: "period_cost", line: "L", sign: "-" },
  inventory_loss: { kind: "period_cost", line: "N", sign: "-" },
  salaries: { kind: "period_cost", line: "O", sign: "-" },
  rent: { kind: "period_cost", line: "O", sign: "-" },
  services: { kind: "period_cost", line: "O", sign: "-" },
  bank_fees: { kind: "period_cost", line: "O", sign: "-" },
  other_expense: { kind: "period_cost", line: "O", sign: "-" },
  // other_income (+)
  inventory_gain: { kind: "other_income", line: "N", sign: "+" },
  other_income: { kind: "other_income", line: "O", sign: "+" },
  // fx (±)
  fx_difference: { kind: "fx", line: "P", sign: "±" },
  // tax (−)
  taxes_company: { kind: "tax", line: "Q", sign: "-" },
  // memo (природний знак; не прибуток)
  tax_collected_memo: { kind: "memo", line: "memo_tax_collected", sign: "natural" },
  discount_memo: { kind: "memo", line: "memo_discounts", sign: "natural" },
  gift_card_memo: { kind: "memo", line: "memo_gift_cards", sign: "natural" },
  production_capitalized_memo: { kind: "memo", line: "memo_produced", sign: "natural" },
  materials_purchased_memo: { kind: "memo", line: "memo_materials", sign: "natural" },
  partner_payout_memo: { kind: "memo", line: "memo_partner_payouts", sign: "natural" },
  shopify_fx_adjustment_memo: { kind: "memo", line: "memo_shopify_fx", sign: "natural" },
} as const satisfies Record<string, FinanceCategoryDef>;

export type FinanceCategory = keyof typeof FINANCE_CATEGORY_DEFS;
export const FINANCE_CATEGORIES = Object.keys(FINANCE_CATEGORY_DEFS) as FinanceCategory[];

export function isFinanceCategory(value: string): value is FinanceCategory {
  return Object.prototype.hasOwnProperty.call(FINANCE_CATEGORY_DEFS, value);
}
export function kindOf(category: FinanceCategory): FinanceKind {
  return FINANCE_CATEGORY_DEFS[category].kind;
}
export function pnlLineOf(category: FinanceCategory): PnlLine | PnlMemoLine {
  return FINANCE_CATEGORY_DEFS[category].line;
}
/** Чи входить категорія в прибуток (усе, крім memo; I8). */
export function affectsProfit(category: FinanceCategory): boolean {
  return FINANCE_CATEGORY_DEFS[category].kind !== "memo";
}
export const PROFIT_CATEGORIES = FINANCE_CATEGORIES.filter(affectsProfit);
export const MEMO_CATEGORIES = FINANCE_CATEGORIES.filter((c) => !affectsProfit(c));
export function categoriesOfLine(line: PnlLine | PnlMemoLine): FinanceCategory[] {
  return FINANCE_CATEGORIES.filter((c) => FINANCE_CATEGORY_DEFS[c].line === line);
}

/** Категорії витрат замовлення, які без order_id є витратами періоду (§2.1, рядок period_cost). */
export const ORDER_COST_ALSO_PERIOD: readonly FinanceCategory[] = ["payment_fees", "platform_fees", "shipping_cost", "packaging", "duties_paid"];

// ---------------------------------------------------------------------------
// Джерела записів (finance_entries.source_type)
// ---------------------------------------------------------------------------

/**
 * §17.1 + три доповнення ядра (WP0): shopify_transaction (коригування курсу транзакції, `fxadj:`), partner_payout
 * (довідкова виплата `pay:`), owner_confirmation (суми замовлення, підтверджені власником замість «Оцінки», §4).
 */
export const FINANCE_SOURCE_TYPES = [
  "shopify_sale",
  "shopify_fee",
  "shopify_transaction",
  "valuation",
  "owner_standard",
  "cost_adjustment",
  "invoice_line",
  "expense",
  "allocation",
  "partner_event",
  "partner_payout",
  "chargeback",
  "fx_conversion",
  "owner_confirmation",
  "demo",
] as const;
export type FinanceSourceType = (typeof FINANCE_SOURCE_TYPES)[number];

// ---------------------------------------------------------------------------
// Угоди продажу Shopify → категорії (SALE_CATEGORY_MAP, §2.1)
// ---------------------------------------------------------------------------

export const AGREEMENT_KINDS = ["order", "order_edit", "refund", "return", "unknown"] as const;
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

/** Shopify SalesAgreement.__typename → вид угоди (невідомий тип → unknown + «Потребує перевірки»). */
export const AGREEMENT_TYPENAME_KIND: Readonly<Record<string, AgreementKind>> = {
  OrderAgreement: "order",
  OrderEditAgreement: "order_edit",
  RefundAgreement: "refund",
  ReturnAgreement: "return",
};

export const SALE_LINE_TYPES = ["PRODUCT", "SHIPPING", "TIP", "DUTY", "FEE", "ADDITIONAL_FEE", "ADJUSTMENT", "GIFT_CARD", "UNKNOWN"] as const;
export type SaleLineType = (typeof SALE_LINE_TYPES)[number];

export const SALE_TIMINGS = ["before_recognition", "after_recognition"] as const;
export type SaleTiming = (typeof SALE_TIMINGS)[number];

/**
 * Знак продажів угод RETURN/REFUND у Shopify (приклад документації — від'ємні кількість і сума). Знак НЕДОКУМЕНТОВАНИЙ як
 * контракт → константа в одному місці + звірка RC5 (§8.3, §16.5).
 */
export const RETURN_SALE_SIGN = -1 as const;

const SALES_BY_LINE: Readonly<Record<SaleLineType, FinanceCategory>> = {
  PRODUCT: "sales_product",
  SHIPPING: "sales_shipping",
  TIP: "sales_other",
  DUTY: "sales_other",
  FEE: "sales_other",
  ADDITIONAL_FEE: "sales_other",
  ADJUSTMENT: "sales_adjustment",
  GIFT_CARD: "gift_card_memo",
  UNKNOWN: "sales_unknown",
};
const REFUNDS_BY_LINE: Readonly<Record<SaleLineType, FinanceCategory>> = {
  PRODUCT: "refund_product",
  SHIPPING: "refund_shipping",
  TIP: "refund_other",
  DUTY: "refund_other",
  FEE: "refund_other",
  ADDITIONAL_FEE: "refund_other",
  ADJUSTMENT: "refund_adjustment",
  GIFT_CARD: "gift_card_memo",
  UNKNOWN: "refund_unknown",
};

/**
 * Категорію визначає вид угоди й час (до / після `order_finance.recognized_at`), НЕ actionType (§2.1).
 * - order / order_edit: завжди sales_* (до визнання — R1; після — R2);
 * - refund / return до визнання: ті самі sales_* (від'ємні; зменшення продажу, не повернення коштів);
 * - refund / return після визнання: refund_*;
 * - unknown: як refund / return відповідного часу («як рядок вище за часом») + перевірка unknown_agreement.
 */
export const SALE_CATEGORY_MAP: Readonly<Record<AgreementKind, Readonly<Record<SaleTiming, Readonly<Record<SaleLineType, FinanceCategory>>>>>> = {
  order: { before_recognition: SALES_BY_LINE, after_recognition: SALES_BY_LINE },
  order_edit: { before_recognition: SALES_BY_LINE, after_recognition: SALES_BY_LINE },
  refund: { before_recognition: SALES_BY_LINE, after_recognition: REFUNDS_BY_LINE },
  return: { before_recognition: SALES_BY_LINE, after_recognition: REFUNDS_BY_LINE },
  unknown: { before_recognition: SALES_BY_LINE, after_recognition: REFUNDS_BY_LINE },
};

export interface SaleClassification {
  category: FinanceCategory;
  /** Причини «Потребує перевірки», які дає сам продаж. */
  review: ReviewReason[];
  /** details.preRecognitionRefund (§2.1): повернення коштів до відвантаження — зменшення продажу, не D. */
  preRecognitionRefund: boolean;
}

/**
 * Класифікація одного продажу угоди. `sign` — знак `totalAmount` (−1, 0, 1): категорія від нього НЕ залежить; він
 * визначає лише позначку preRecognitionRefund для угоди невідомого виду (від'ємний продаж до визнання).
 */
export function classifySale(input: { agreementKind: AgreementKind; timing: SaleTiming; lineType: SaleLineType; sign: -1 | 0 | 1 }): SaleClassification {
  const category = SALE_CATEGORY_MAP[input.agreementKind][input.timing][input.lineType];
  const review: ReviewReason[] = [];
  if (input.lineType === "UNKNOWN") review.push("unknown_line_type");
  if (input.agreementKind === "unknown") review.push("unknown_agreement");
  if (input.agreementKind === "order_edit" && input.timing === "after_recognition") review.push("edited_after_recognition");
  const refundLike = input.agreementKind === "refund" || input.agreementKind === "return" || (input.agreementKind === "unknown" && input.sign < 0);
  return { category, review, preRecognitionRefund: input.timing === "before_recognition" && refundLike };
}

// ---------------------------------------------------------------------------
// Звірка з Shopify (§16.5)
// ---------------------------------------------------------------------------

export const RECONCILIATION_CHECKS = ["RC1", "RC2", "RC3", "RC4", "RC5"] as const;
export type ReconciliationCheck = (typeof RECONCILIATION_CHECKS)[number];
/** Кандидати (лише ▲ «Потребує перевірки», доки формулу не підтверджено на тестовому магазині) — в одному місці. */
export const RECONCILIATION_CANDIDATES: readonly ReconciliationCheck[] = ["RC1", "RC4"];
/** Підтверджені перевірки: на який складник впливає розбіжність (стан partial, причина reconciliation_mismatch). */
export const RECONCILIATION_AFFECTS: Readonly<Record<ReconciliationCheck, readonly OrderComponent[]>> = {
  RC1: [],
  RC2: ["fees"],
  RC3: ["revenue"],
  RC4: [],
  RC5: ["revenue"],
};

// ---------------------------------------------------------------------------
// Складники, стани, причини, основи (§2.6)
// ---------------------------------------------------------------------------

/** Обов'язкові (за умовами §2.6) складники прибутку замовлення. */
export const ORDER_COMPONENTS = ["revenue", "cogs", "packaging", "shipping_cost", "fees", "partner", "duties_paid"] as const;
export type OrderComponent = (typeof ORDER_COMPONENTS)[number];

export const COMPONENT_STATES = ["actual", "partial", "forecast", "missing", "zero_confirmed", "not_applicable"] as const;
export type ComponentState = (typeof COMPONENT_STATES)[number];

/** Причини стану missing / partial (§2.6). */
export const MISSING_REASONS = [
  "awaiting_shopify",
  "no_cost",
  "no_invoice",
  "no_waybill",
  "no_fee_data",
  "no_rate",
  "ambiguous_partner",
  "order_unreadable",
] as const;
export type MissingReason = (typeof MISSING_REASONS)[number];
export const PARTIAL_REASONS = ["reconciliation_mismatch"] as const;
/** Причини not_applicable (§2.6 «Особливі випадки»: кожна позначка власника — з причиною в історії змін). */
export const NOT_APPLICABLE_REASONS = [
  "recipient_pays", // платник Recipient (оцінка відправлення) або позначка власника «Платить отримувач»
  "no_shipping_cost", // позначка власника «Без витрат на доставку»
  "no_shippable_lines", // жодна позиція не потребує доставки
  "packaging_accounted_in_total", // «Упаковку цих замовлень обліковано загальною сумою» (місяць)
  "no_partner", // атрибуції немає
  "no_product_lines", // немає позицій товарів (собівартість)
  "not_ddp", // не DDP — мито компанії не очікується
] as const;
/** Причини zero_confirmed. */
export const ZERO_CONFIRMED_REASONS = ["fee_rule_no_fees", "owner_confirmed"] as const;

export const COMPONENT_REASONS = [...MISSING_REASONS, ...PARTIAL_REASONS, ...NOT_APPLICABLE_REASONS, ...ZERO_CONFIRMED_REASONS] as const;
export type ComponentReason = (typeof COMPONENT_REASONS)[number];

/** Основа (джерело) значення складника — показується поруч зі значенням (§2.6). */
export const FINANCE_BASES = [
  "shopify",
  "demo",
  "invoice",
  "valuation",
  "owner_standard",
  "unconfirmed_standard",
  "allocated",
  "carrier_reported",
  "country_average",
  "owner_table",
  "fee_rule",
  "kit_plan",
  "pool_average",
  "last_batch",
  "catalogue",
  "order_snapshot",
  "owner_confirmed",
  "manual",
] as const;
export type FinanceBasis = (typeof FINANCE_BASES)[number];

export const ORDER_FINANCE_STATES = ["open", "recognized", "closed_unrecognized", "excluded"] as const;
export type OrderFinanceState = (typeof ORDER_FINANCE_STATES)[number];

export const PROFIT_STATES = ["final", "preliminary", "incomplete", "n/a"] as const;
export type ProfitState = (typeof PROFIT_STATES)[number];

export const RECOGNITION_BASES = ["handover", "consume", "placed_fallback"] as const;
export type RecognitionBasis = (typeof RECOGNITION_BASES)[number];

export const FACTS_SOURCES = ["shopify", "demo", "order_snapshot", "none"] as const;
export type FactsSource = (typeof FACTS_SOURCES)[number];

/** Маркер плитки (§2.6). */
export const COMPLETENESS_MARKERS = ["complete", "with_forecast", "incomplete"] as const;
export type CompletenessMarker = (typeof COMPLETENESS_MARKERS)[number];

/** Рентабельність періоду показується, лише якщо NR замовлень із відомим прибутком ≥ 90 % NR усіх визнаних (§2.6). */
export const PERIOD_MARGIN_MIN_COVERAGE = 90;

/** Причини «Потребує перевірки» замовлення (`order_finance.review_reasons`). */
export const REVIEW_REASONS = [
  "edited_after_recognition",
  "unknown_agreement",
  "unknown_line_type",
  "unsupported_currency",
  "amount_parse_error",
  "transactions_truncated",
  "refunds_incomplete",
  "reconciliation_mismatch",
  "order_unreadable",
  "journey_never_ready",
  "dispute_open",
  "chargeback_refund_overlap",
  "partner_attribution_ambiguous",
  "recognition_date_unknown",
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** Позначки власника на замовленні (`order_finance.overrides`, §2.6, §4) — кожна з причиною в історії змін. */
export const ORDER_OVERRIDE_KINDS = [
  "recipient_pays",
  "no_shipping_cost",
  "confirmed_amounts",
  "fees_zero_confirmed",
  "packaging_accounted_in_total",
] as const;
export type OrderOverrideKind = (typeof ORDER_OVERRIDE_KINDS)[number];

// ---------------------------------------------------------------------------
// Розбіжності (§7.5; реєстр finance_discrepancies)
// ---------------------------------------------------------------------------

export const DISCREPANCY_CODES = [
  "unmatched_waybill",
  "unrecognized_number",
  "invalid_number",
  "ambiguous_match",
  "carrier_mismatch",
  "shipment_cancelled",
  "shipment_not_handed_over",
  "order_not_recognized",
  "currency_mismatch",
  "amount_vs_forecast",
  "weight_mismatch",
  "shipping_loss",
  "duplicate_in_file",
  "possible_double_billing",
  "similar_document",
  "credit_without_charge",
  "invoice_total_mismatch",
  "manual_cost_exists",
  "test_waybill_in_production",
  // інші (той самий реєстр)
  "fx_rate_conflict",
  "cost_state_out_of_sync",
  "reconciliation_mismatch",
  "partner_attribution_ambiguous",
  "chargeback_refund_overlap",
  "chargeback_fee_overlap",
  "order_unreadable",
] as const;
export type DiscrepancyCode = (typeof DISCREPANCY_CODES)[number];

export const DISCREPANCY_STATUSES = ["open", "resolved", "ignored"] as const;
export type DiscrepancyStatus = (typeof DISCREPANCY_STATUSES)[number];
export const DISCREPANCY_SEVERITIES = ["warning", "critical"] as const;
export type DiscrepancySeverity = (typeof DISCREPANCY_SEVERITIES)[number];

/** Типова важливість (критичні — попередження чек-листа закриття місяця); викликач може задати іншу. */
export const DISCREPANCY_DEFAULT_SEVERITY: Readonly<Record<DiscrepancyCode, DiscrepancySeverity>> = {
  unmatched_waybill: "warning",
  unrecognized_number: "warning",
  invalid_number: "warning",
  ambiguous_match: "warning",
  carrier_mismatch: "warning",
  shipment_cancelled: "warning",
  shipment_not_handed_over: "warning",
  order_not_recognized: "warning",
  currency_mismatch: "warning",
  amount_vs_forecast: "warning",
  weight_mismatch: "warning",
  shipping_loss: "warning",
  duplicate_in_file: "warning",
  possible_double_billing: "critical",
  similar_document: "critical",
  credit_without_charge: "warning",
  invoice_total_mismatch: "critical",
  manual_cost_exists: "warning",
  test_waybill_in_production: "critical",
  fx_rate_conflict: "critical",
  cost_state_out_of_sync: "critical",
  reconciliation_mismatch: "critical",
  partner_attribution_ambiguous: "warning",
  chargeback_refund_overlap: "critical",
  chargeback_fee_overlap: "warning",
  order_unreadable: "warning",
};

/** Коди рішень розбіжностей (дії §7.5). */
export const DISCREPANCY_RESOLUTIONS = [
  "accepted", // прийнято (як витрату замовлення / відхилення від прогнозу / вага)
  "matched", // зіставлено вручну
  "expense_without_order", // витрата без замовлення
  "replaced_manual", // замінено ручну суму
  "kept_both", // залишити обидва
  "marked_duplicate", // позначено дублем
  "credit_expected", // очікується кредит-нота
  "confirmed", // підтверджено (окремий документ, повторне нарахування законне)
  "linked_as_specification", // прив'язано як специфікацію рахунку
  "not_ours", // не наша витрата
  "fixed_file", // виправлено файл
  "partner_chosen", // обрано партнера
  "auto_resolved", // умова зникла (система)
  "other",
] as const;
export type DiscrepancyResolution = (typeof DISCREPANCY_RESOLUTIONS)[number];

// ---------------------------------------------------------------------------
// Курси (§5)
// ---------------------------------------------------------------------------

export const FX_RATE_SOURCES = ["nbu", "manual", "demo"] as const;
export type FxRateSource = (typeof FX_RATE_SOURCES)[number];
/** Масштаби НБУ (fx_rates.units), CHECK у схемі. */
export const FX_RATE_UNITS = [1, 10, 100, 1000, 10000] as const;
/** Валюта котирування етапу 6 (усі джерела — гривні за одиницю). */
export const FX_QUOTE_CURRENCY = "UAH";
/** Швидкий вибір валют на сторінках (§5.1). */
export const QUICK_CURRENCIES = ["UAH", "EUR", "USD", "GBP", "PLN"] as const;
export const MAX_DISPLAY_CURRENCIES = 10;
export const FX_RATE_DATE_POLICIES = ["payment_date", "recognition_date"] as const;
export type FxRateDatePolicy = (typeof FX_RATE_DATE_POLICIES)[number];

export const FX_CONVERSION_COUNTERPARTIES = ["bank", "payment_provider", "other"] as const;
export const ACTIVE_VOIDED = ["active", "voided"] as const;

// ---------------------------------------------------------------------------
// Закриття місяця, знімки, історія змін (§3.4, §13.1, §14.4)
// ---------------------------------------------------------------------------

export const FINANCE_PERIOD_STATUSES = ["open", "closed"] as const;
export type FinancePeriodStatus = (typeof FINANCE_PERIOD_STATUSES)[number];

/** Чек-лист закриття: ■ блокує, ▲ попереджає, ☐ підтвердження власника (§3.4). */
export const PERIOD_CHECKLIST = {
  blocking: ["orders_final", "rates_for_display_currencies"],
  warning: ["open_discrepancies", "orders_need_review", "unknown_cost_units", "packaging_forecast_with_total"],
  confirm: ["advertising", "payment_fees", "platform_fees", "salaries", "rent_services", "taxes_company", "other_expenses", "packaging_total_accounted"],
} as const;
export type PeriodChecklistItem =
  | (typeof PERIOD_CHECKLIST.blocking)[number]
  | (typeof PERIOD_CHECKLIST.warning)[number]
  | (typeof PERIOD_CHECKLIST.confirm)[number];
export const PERIOD_CHECKLIST_ITEMS: readonly PeriodChecklistItem[] = [
  ...PERIOD_CHECKLIST.blocking,
  ...PERIOD_CHECKLIST.warning,
  ...PERIOD_CHECKLIST.confirm,
];
/** Пункт «Податки компанії»: «внесено» або «податків за місяць немає»; «Упаковку…» — лише за потреби. */
export const PERIOD_CONFIRM_VALUES = ["entered", "none_this_month", "not_needed"] as const;

export const REPORT_KINDS = ["day", "week", "month", "year", "custom"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const SNAPSHOT_SOURCES = ["manual", "scheduled", "close"] as const;
export type SnapshotSource = (typeof SNAPSHOT_SOURCES)[number];

/** Назва прибутку (§2.7, profitLabelFor). */
export const PROFIT_LABELS = ["net_profit", "profit_after_recorded_costs"] as const;
export type ProfitLabel = (typeof PROFIT_LABELS)[number];

export const FINANCE_CHANGE_ENTITY_TYPES = [
  "expense",
  "expense_allocation",
  "stock_item_cost",
  "batch_cost",
  "material_cost",
  "fx_rate",
  "fx_conversion",
  "fee_rule",
  "partner",
  "partner_code",
  "partner_rate",
  "partner_attribution",
  "payout",
  "import_profile",
  "carrier_invoice",
  "invoice_line_match",
  "discrepancy",
  "chargeback",
  "order_component_override",
  "period",
  "report_snapshot",
  "settings_finance",
  "valuation_completion",
] as const;
export type FinanceChangeEntityType = (typeof FINANCE_CHANGE_ENTITY_TYPES)[number];

export const FINANCE_CHANGE_ACTIONS = ["create", "update", "void", "replace", "resolve", "match", "unmatch", "close", "reopen", "confirm"] as const;
export type FinanceChangeAction = (typeof FINANCE_CHANGE_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Собівартість (§6)
// ---------------------------------------------------------------------------

export const COST_LAYER_KINDS = ["unknown", "deficit", "defect"] as const;
export type CostLayerKind = (typeof COST_LAYER_KINDS)[number];
export const COST_LAYER_REASONS = [
  "opening",
  "receipt_without_cost",
  "fx_pending",
  "surplus_without_cost",
  "return_without_cost",
  "deficit",
  "defect_mark",
] as const;
export type CostLayerReason = (typeof COST_LAYER_REASONS)[number];
export const VALUATION_KINDS = ["inflow", "outflow", "revaluation", "stock_completion", "sale_completion"] as const;
export type ValuationKind = (typeof VALUATION_KINDS)[number];
/** Оцінки, що змінюють пул (вартість запасів на дату, §6.7; sale_completion — ні). */
export const POOL_CHANGING_VALUATION_KINDS: readonly ValuationKind[] = ["inflow", "outflow", "revaluation", "stock_completion"];
export const VALUATION_VALUE_SOURCES = ["movement_cost", "batch", "original_sale", "pool_average", "owner_standard", "catalogue", "zero", "none"] as const;
export type ValuationValueSource = (typeof VALUATION_VALUE_SOURCES)[number];
export const STOCK_ITEM_COST_SOURCES = ["manual", "bulk_model_color", "material_catalogue", "shopify_unit_cost", "demo"] as const;
export type StockItemCostSource = (typeof STOCK_ITEM_COST_SOURCES)[number];
/** Валюта оцінки запасів за замовчуванням (§5.1, D-3). */
export const DEFAULT_VALUATION_CURRENCY = "UAH";

// ---------------------------------------------------------------------------
// Доставка й імпорт (§7)
// ---------------------------------------------------------------------------

export const SHIPPING_FORECAST_BASES = ["carrier_reported", "country_average", "owner_table", "none"] as const;
export type ShippingForecastBasis = (typeof SHIPPING_FORECAST_BASES)[number];
export const SHIPMENT_ESTIMATE_KINDS = ["carrier_reported"] as const;
export const SHIPMENT_ESTIMATE_SOURCES = ["nova_post_create", "test_carrier", "demo"] as const;
export const EXTERNAL_WAYBILL_SOURCES = ["shopify_fulfillment", "manual", "demo"] as const;
export type ExternalWaybillSource = (typeof EXTERNAL_WAYBILL_SOURCES)[number];
/** Класи нормалізованих номерів (§7.4). */
export const WAYBILL_NUMBER_CLASSES = ["ua14", "eu", "test", "unrecognized"] as const;
export type WaybillNumberClass = (typeof WAYBILL_NUMBER_CLASSES)[number];
export const CARRIER_DOCUMENT_KINDS = ["invoice", "specification", "credit_note"] as const;
export type CarrierDocumentKind = (typeof CARRIER_DOCUMENT_KINDS)[number];
export const CARRIER_INVOICE_STATUSES = ["active", "replaced", "voided"] as const;
export const INVOICE_LINE_KINDS = ["charge", "credit", "total", "ignored"] as const;
export const CHARGE_TYPES = ["delivery", "additional_service", "customs_duty", "return_delivery", "redirect", "storage", "insurance", "other", "credit"] as const;
export type ChargeType = (typeof CHARGE_TYPES)[number];
export const INVOICE_MATCH_STATUSES = ["matched", "unmatched", "ambiguous", "invalid", "manual", "ignored"] as const;
export const IMPORT_FILE_KINDS = ["xlsx", "csv", "csv_text"] as const;

// ---------------------------------------------------------------------------
// Витрати, комісії (§10, §8)
// ---------------------------------------------------------------------------

/** Як категорія ручної витрати ставиться до замовлення (§10.1). */
export type ExpenseOrderRule = "required" | "optional" | "forbidden" | "batch_only";

/** Категорії, доступні для ручних витрат і доходів (`finance_expenses.category`), з правилом замовлення (§10.1). */
export const EXPENSE_CATEGORY_RULES = {
  return_shipping_cost: "required",
  return_handling: "required",
  shipping_cost: "optional",
  duties_paid: "optional",
  packaging: "optional",
  payment_fees: "optional",
  platform_fees: "optional",
  chargeback_fees: "optional",
  other_expense: "optional",
  advertising: "forbidden",
  partner_fixed_fee: "forbidden",
  salaries: "forbidden",
  rent: "forbidden",
  services: "forbidden",
  bank_fees: "forbidden",
  taxes_company: "forbidden",
  fx_difference: "forbidden",
  other_income: "forbidden",
  /** Лише через «Списати невикористані витрати партії» (§6.7), з production_batch_id. */
  inventory_loss: "batch_only",
} as const satisfies Partial<Record<FinanceCategory, ExpenseOrderRule>>;
export type ExpenseCategory = keyof typeof EXPENSE_CATEGORY_RULES;
export const EXPENSE_CATEGORIES = Object.keys(EXPENSE_CATEGORY_RULES) as ExpenseCategory[];
export const EXPENSE_CATEGORIES_ORDER_REQUIRED = EXPENSE_CATEGORIES.filter((c) => EXPENSE_CATEGORY_RULES[c] === "required");
export const EXPENSE_CATEGORIES_ORDER_FORBIDDEN = EXPENSE_CATEGORIES.filter(
  (c) => EXPENSE_CATEGORY_RULES[c] === "forbidden" || EXPENSE_CATEGORY_RULES[c] === "batch_only",
);
/** Категорії ручних сум періоду, що можуть замінювати прогнози замовлень (§10.3). */
export const COVERS_FORECAST_CATEGORIES: readonly ExpenseCategory[] = ["payment_fees", "platform_fees", "shipping_cost", "packaging"];
export const EXPENSE_CHANNELS = ["meta", "google", "tiktok", "instagram", "influencer", "other"] as const;
export const EXPENSE_STATUSES = ACTIVE_VOIDED;
/** Найдовший період послуги витрати (§10.1). */
export const EXPENSE_MAX_PERIOD_DAYS = 366;
export const FEE_RULE_KINDS = ["payment", "platform"] as const;

// ---------------------------------------------------------------------------
// Chargeback і спори (§8.2)
// ---------------------------------------------------------------------------

export const DISPUTE_OUTCOMES = ["lost", "accepted", "won", "prevented"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
export const DISPUTE_SOURCES = ["shopify", "manual", "demo"] as const;
export const ORDER_SALE_SOURCES = ["shopify", "demo"] as const;

// ---------------------------------------------------------------------------
// Партнери (§9)
// ---------------------------------------------------------------------------

export const PARTNER_KINDS = ["blogger", "affiliate", "partner", "other"] as const;
export const PARTNER_STATUSES = ["active", "paused", "archived"] as const;
export const PARTNER_CODE_SOURCES = ["discount_code", "referral"] as const;
export const ATTRIBUTION_SOURCES = ["discount_code", "referral", "owner"] as const;
export const ATTRIBUTION_STATUSES = ["attributed", "ambiguous", "removed"] as const;
export const COMMISSION_EVENT_KINDS = ["accrual", "adjustment", "cancellation", "manual"] as const;
/** Стан винагороди (виводиться при читанні, §9.4). */
export const PARTNER_COMMISSION_STATES = ["expected", "accrued", "payable", "paid", "cancelled"] as const;
export type PartnerCommissionState = (typeof PARTNER_COMMISSION_STATES)[number];
export const PAYOUT_METHODS = ["bank", "card", "cash", "other"] as const;
export const PAYOUT_STATUSES = ACTIVE_VOIDED;
/** Типові утримання й ставка (D-10). */
export const DEFAULT_PARTNER_HOLD_DAYS = 30;
export const DEFAULT_PARTNER_RATE_BP = 1000;

// ---------------------------------------------------------------------------
// Повернення (§11)
// ---------------------------------------------------------------------------

export const RETURN_KINDS = ["customer_return", "carrier_return", "refused", "lost", "refund_only", "other"] as const;
export const RETURN_STATUSES = ["open", "in_transit", "received", "closed"] as const;
export const RETURN_REASON_CODES = [
  "defective",
  "damaged_in_transit",
  "wrong_item",
  "not_as_described",
  "size_or_fit",
  "changed_mind",
  "too_late",
  "refused_delivery",
  "customs_refused",
  "address_problem",
  "other",
  "unknown",
] as const;
export const RETURN_LINE_CONDITIONS = ["resellable", "damaged", "unknown"] as const;
export const RETURN_SOURCES = ["shopify_refund", "stock_receipt", "carrier_hint", "manual", "demo"] as const;

// ---------------------------------------------------------------------------
// Інтерфейс: вкладки фінансів, набори експорту (§18.1, §13.2)
// ---------------------------------------------------------------------------

/** Вкладки фінансів (§18.1): ключ (i18n finance.tab.<key>) і шлях відносно basePath. */
export const FINANCE_TABS = [
  { key: "overview", path: "finance" },
  { key: "orders", path: "finance/orders" },
  { key: "shipping", path: "finance/shipping" },
  { key: "expenses", path: "finance/expenses" },
  { key: "partners", path: "finance/partners" },
  { key: "costs", path: "finance/costs" },
  { key: "rates", path: "finance/rates" },
  { key: "reports", path: "finance/reports" },
  { key: "periods", path: "finance/periods" },
  { key: "settings", path: "finance/settings" },
] as const;
export type FinanceTab = (typeof FINANCE_TABS)[number]["key"];

/**
 * Назви наборів експорту `FINANCE_EXPORT_DATASETS` (§13.2) — тут, щоб аналітика (WP8) і звіти (WP10) посилалися на той
 * самий перелік; реєстр із реалізаціями — `app/modules/finance-reports/**` (WP10). Кожен — finance.view.
 */
export const FINANCE_EXPORT_DATASET_NAMES = [
  "pnl",
  "entries",
  "orders",
  "shipping",
  "invoice_lines",
  "expenses",
  "partners",
  "partner_performance",
  "fx_rates",
  "returns",
  "products",
  "countries",
  "sales_dynamics",
  "logistics",
  "automation",
  "forecast",
  "comparison",
  "inventory_valuation",
  "accounting",
] as const;
export type FinanceExportDatasetName = (typeof FINANCE_EXPORT_DATASET_NAMES)[number];

/** Глосарій (§18.10): терміни інтерфейсу — i18n finance.term.<key>. */
export const FINANCE_TERMS = [
  "turnover",
  "netRevenue",
  "cogs",
  "grossProfit",
  "profitAfterRecordedCosts",
  "netProfit",
  "forecastProfit",
  "margin",
  "averageOrderValue",
  "averageProfitPerOrder",
  "producedValue",
  "shippingCharged",
  "shippingCostActual",
  "fees",
  "partners",
  "defectsWriteOffs",
  "exchangeDifferences",
  "companyTaxes",
  "lateEntry",
  "lateCompletion",
  "closeMonth",
  "reopenMonth",
  "carrierEstimate",
  "manualUnitCost",
  "estimate",
  "noRate",
  "paidNotShipped",
] as const;
export type FinanceTerm = (typeof FINANCE_TERMS)[number];

/** Банери/примітки, спільні для фінансових сторінок (i18n finance.notice.<key>). */
export const FINANCE_NOTICES = [
  "demo",
  "testOrdersIncluded",
  "netProfitHint",
  "forecastNotFact",
  "rounding",
  "nbuSource",
  "demoRates",
  "liveRecalculation",
  "inDevelopment",
] as const;
export type FinanceNotice = (typeof FINANCE_NOTICES)[number];

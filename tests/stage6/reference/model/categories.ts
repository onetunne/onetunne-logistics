/**
 * Еталонна модель (WP12a): категорії журналу, види, рядки P&L і відображення продажів Shopify (§2.1, §2.2) —
 * власна копія з проєкту (не з app/domain/finance.ts; тест reference-enumerations звіряє лише перелік назв).
 */

export const REF_CATEGORIES = {
  sales_product: { kind: "revenue", line: "A" },
  sales_shipping: { kind: "revenue", line: "B" },
  sales_other: { kind: "revenue", line: "C" },
  sales_adjustment: { kind: "revenue", line: "C" },
  sales_unknown: { kind: "revenue", line: "C" },
  refund_product: { kind: "contra_revenue", line: "D" },
  refund_shipping: { kind: "contra_revenue", line: "D" },
  refund_other: { kind: "contra_revenue", line: "D" },
  refund_adjustment: { kind: "contra_revenue", line: "D" },
  refund_unknown: { kind: "contra_revenue", line: "D" },
  chargeback_loss: { kind: "contra_revenue", line: "E" },
  cogs: { kind: "cogs", line: "F" },
  cogs_return: { kind: "cogs", line: "F" },
  cogs_adjustment: { kind: "cogs", line: "F" },
  shipping_cost: { kind: "order_cost", line: "G" },
  return_shipping_cost: { kind: "order_cost", line: "G" },
  return_handling: { kind: "order_cost", line: "O" },
  duties_paid: { kind: "order_cost", line: "H" },
  packaging: { kind: "order_cost", line: "I" },
  payment_fees: { kind: "order_cost", line: "J" },
  platform_fees: { kind: "order_cost", line: "J" },
  chargeback_fees: { kind: "order_cost", line: "K" },
  partner_commission: { kind: "order_cost", line: "L" },
  shipping_unallocated: { kind: "period_cost", line: "G" },
  packaging_unlinked: { kind: "period_cost", line: "I" },
  advertising: { kind: "period_cost", line: "M" },
  partner_fixed_fee: { kind: "period_cost", line: "L" },
  inventory_loss: { kind: "period_cost", line: "N" },
  salaries: { kind: "period_cost", line: "O" },
  rent: { kind: "period_cost", line: "O" },
  services: { kind: "period_cost", line: "O" },
  bank_fees: { kind: "period_cost", line: "O" },
  other_expense: { kind: "period_cost", line: "O" },
  inventory_gain: { kind: "other_income", line: "N" },
  other_income: { kind: "other_income", line: "O" },
  fx_difference: { kind: "fx", line: "P" },
  taxes_company: { kind: "tax", line: "Q" },
  tax_collected_memo: { kind: "memo", line: "memo" },
  discount_memo: { kind: "memo", line: "memo" },
  gift_card_memo: { kind: "memo", line: "memo" },
  production_capitalized_memo: { kind: "memo", line: "memo" },
  materials_purchased_memo: { kind: "memo", line: "memo" },
  partner_payout_memo: { kind: "memo", line: "memo" },
  shopify_fx_adjustment_memo: { kind: "memo", line: "memo" },
} as const;

export type RefCategory = keyof typeof REF_CATEGORIES;
export type RefKind = (typeof REF_CATEGORIES)[RefCategory]["kind"];
export const PNL_LINE_KEYS = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q"] as const;
export type PnlLineKey = (typeof PNL_LINE_KEYS)[number];

export const REF_CATEGORY_NAMES = Object.keys(REF_CATEGORIES) as RefCategory[];

export function kindOf(c: RefCategory): RefKind {
  return REF_CATEGORIES[c].kind;
}

export function lineOf(c: RefCategory): PnlLineKey | "memo" {
  return REF_CATEGORIES[c].line;
}

/** Довідкові категорії у прибуток не входять (I8). */
export function affectsProfit(c: RefCategory): boolean {
  return REF_CATEGORIES[c].kind !== "memo";
}

/** Чиста виручка NR = виручка + повернення + chargeback. */
export function isNetRevenue(c: RefCategory): boolean {
  const k = REF_CATEGORIES[c].kind;
  return k === "revenue" || k === "contra_revenue";
}

export type Agreement = "order" | "order_edit" | "refund" | "return" | "unknown";
export type SaleLineType = "PRODUCT" | "SHIPPING" | "TIP" | "DUTY" | "FEE" | "ADDITIONAL_FEE" | "ADJUSTMENT" | "GIFT_CARD" | "UNKNOWN";
export const SALE_LINE_TYPE_NAMES: readonly SaleLineType[] = ["PRODUCT", "SHIPPING", "TIP", "DUTY", "FEE", "ADDITIONAL_FEE", "ADJUSTMENT", "GIFT_CARD", "UNKNOWN"];
export const AGREEMENT_NAMES: readonly Agreement[] = ["order", "order_edit", "refund", "return", "unknown"];

/**
 * Категорія продажу Shopify за видом угоди, часом і типом рядка (§2.1). `refund`/`return` ДО визнання — ті самі
 * `sales_*` з від'ємною сумою (зменшення продажу, не повернення); `unknown` — як `refund`/`return` за часом (знак
 * суми вирішує лише довідкову позначку preRecognitionRefund).
 */
export function saleCategory(agreement: Agreement, afterRecognition: boolean, lineType: SaleLineType): RefCategory {
  const asRefund = (agreement === "refund" || agreement === "return" || agreement === "unknown") && afterRecognition;
  if (lineType === "GIFT_CARD") return "gift_card_memo";
  if (asRefund) {
    switch (lineType) {
      case "PRODUCT":
        return "refund_product";
      case "SHIPPING":
        return "refund_shipping";
      case "ADJUSTMENT":
        return "refund_adjustment";
      case "UNKNOWN":
        return "refund_unknown";
      default:
        return "refund_other";
    }
  }
  switch (lineType) {
    case "PRODUCT":
      return "sales_product";
    case "SHIPPING":
      return "sales_shipping";
    case "ADJUSTMENT":
      return "sales_adjustment";
    case "UNKNOWN":
      return "sales_unknown";
    default:
      return "sales_other";
  }
}

/** Складники замовлення (§2.6). */
export const REF_COMPONENTS = ["revenue", "cogs", "packaging", "shipping_cost", "fees", "partner", "duties_paid"] as const;
export type RefComponent = (typeof REF_COMPONENTS)[number];

/** До якого складника належить категорія запису замовлення (для «факт замінює прогноз»). */
export function componentOf(c: RefCategory): RefComponent | null {
  switch (c) {
    case "sales_product":
    case "sales_shipping":
    case "sales_other":
    case "sales_adjustment":
    case "sales_unknown":
    case "refund_product":
    case "refund_shipping":
    case "refund_other":
    case "refund_adjustment":
    case "refund_unknown":
    case "chargeback_loss":
      return "revenue";
    case "cogs":
    case "cogs_return":
    case "cogs_adjustment":
      return "cogs";
    case "packaging":
      return "packaging";
    case "shipping_cost":
    case "return_shipping_cost":
      return "shipping_cost";
    case "payment_fees":
    case "platform_fees":
    case "chargeback_fees":
      return "fees";
    case "partner_commission":
      return "partner";
    case "duties_paid":
      return "duties_paid";
    default:
      return null;
  }
}

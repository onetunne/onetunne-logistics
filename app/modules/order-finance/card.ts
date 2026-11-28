/**
 * Етап 6, WP4: рядки блоку «Фінанси замовлення» (docs/stage6-design.md §2.4, §18.4) — ЧИСТІ функції над діючими
 * записами журналу замовлення, прогнозами, що рахуються, і курсами. Рядки показують НЕТТО-значення, складники — підрядком
 * («у т.ч. …»); кожна сума — у початкових валютах + у валюті звітності (кожен запис — за курсом свого fx_on, одне
 * округлення на запис, потім сума). Відсутнє (немає записів / немає курсу) — null («—»), НІКОЛИ не 0 (F4); прогноз —
 * окремим числом із позначкою «≈» (F5). Прибуток: «Факт» (final), «≈ Прогноз» (preliminary: записи + прогнози, що
 * рахуються, без «Оцінки» виручки) або не показується з переліком відсутнього (incomplete); рентабельність = прибуток /
 * чиста виручка × 100 % у валюті показу («—», якщо виручка ≤ 0 або прибуток не показано).
 */
import { affectsProfit, FINANCE_CATEGORY_DEFS, isFinanceCategory, type ComponentReason, type FinanceCategory, type OrderComponent, type ProfitState } from "~/domain/finance";
import { marginPercent, toMinorForCurrency } from "~/lib/decimal";
import { sumConverted, type ScaledRateLookup, type UnconvertedTotal } from "~/modules/fx/convert";

export interface MoneyAmountLike {
  amount: string;
  currency: string;
}

export interface CardEntryInput {
  category: string;
  amount: string;
  currency: string;
  fxOn: string;
  details?: Record<string, unknown> | null;
}

export interface CardForecastInput {
  component: OrderComponent;
  amount: string;
  currency: string;
  fxOn: string;
  basis: string;
}

export interface CardAmount {
  /** Σ у початкових валютах (порядок валют — алфавітний). */
  original: MoneyAmountLike[];
  /** Σ у валюті показу; null — записів немає або є записи без курсу. */
  converted: string | null;
  /** Записи без курсу (у суму не входять). */
  unconverted: UnconvertedTotal[];
  entries: number;
}

/** Сума набору (кожен запис окремо за курсом свого fx_on). */
export function cardAmount(items: ReadonlyArray<{ amount: string; currency: string; fxOn: string }>, currency: string, rateOf: ScaledRateLookup): CardAmount {
  const by = new Map<string, bigint>();
  for (const it of items) by.set(it.currency, (by.get(it.currency) ?? 0n) + toMinorForCurrency(it.amount, it.currency));
  const original = [...by.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([c, minor]) => ({ currency: c, amount: fromMinorString(minor) }));
  if (items.length === 0) return { original, converted: null, unconverted: [], entries: 0 };
  const s = sumConverted(items, currency, rateOf);
  return { original, converted: s.unconverted.length > 0 ? null : s.total, unconverted: s.unconverted, entries: items.length };
}

function fromMinorString(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

const cat = (e: CardEntryInput): FinanceCategory | null => (isFinanceCategory(e.category) ? e.category : null);
const inCats = (cats: readonly FinanceCategory[]) => (e: CardEntryInput) => {
  const c = cat(e);
  return c !== null && cats.includes(c);
};
const lineTypeOf = (e: CardEntryInput) => (e.details && typeof e.details.lineType === "string" ? e.details.lineType : null);
const negate = (e: CardEntryInput): CardEntryInput => ({ ...e, amount: fromMinorString(-toMinorForCurrency(e.amount, e.currency)) });

export interface CardRows {
  products: { net: CardAmount; sold: CardAmount; returned: CardAmount; beforeDiscounts: CardAmount; discounts: CardAmount };
  shippingPaid: CardAmount;
  otherRevenue: CardAmount;
  chargebackLoss: CardAmount;
  netRevenue: CardAmount;
  cogs: { net: CardAmount; writtenOff: CardAmount; returns: CardAmount; adjustments: CardAmount };
  packaging: CardAmount;
  shippingActual: CardAmount;
  returnShipping: CardAmount;
  duties: CardAmount;
  fees: { net: CardAmount; payment: CardAmount; platform: CardAmount; chargeback: CardAmount };
  partner: { net: CardAmount; accrued: CardAmount; adjustments: CardAmount };
  otherCosts: CardAmount;
  taxCollected: CardAmount;
  discountsMemo: CardAmount;
  giftCards: CardAmount;
}

/** Рядки блоку з діючих записів замовлення (§2.4). */
export function cardRows(entries: readonly CardEntryInput[], currency: string, rateOf: ScaledRateLookup): CardRows {
  const a = (pred: (e: CardEntryInput) => boolean, map: (e: CardEntryInput) => CardEntryInput = (e) => e) => cardAmount(entries.filter(pred).map(map), currency, rateOf);
  const productDisc = (e: CardEntryInput) => cat(e) === "discount_memo" && lineTypeOf(e) === "PRODUCT";
  const sold = entries.filter(inCats(["sales_product"]));
  const isRevenue = (e: CardEntryInput) => {
    const c = cat(e);
    return c !== null && (FINANCE_CATEGORY_DEFS[c].kind === "revenue" || FINANCE_CATEGORY_DEFS[c].kind === "contra_revenue");
  };
  const accrual = (e: CardEntryInput) => e.details?.kind === "accrual";
  return {
    products: {
      net: a(inCats(["sales_product", "refund_product"])),
      sold: cardAmount(sold, currency, rateOf),
      returned: a(inCats(["refund_product"])),
      beforeDiscounts: cardAmount([...sold, ...entries.filter(productDisc)], currency, rateOf),
      discounts: a(productDisc, negate),
    },
    shippingPaid: a(inCats(["sales_shipping", "refund_shipping"])),
    otherRevenue: a(inCats(["sales_other", "sales_adjustment", "sales_unknown", "refund_other", "refund_adjustment", "refund_unknown"])),
    chargebackLoss: a(inCats(["chargeback_loss"])),
    netRevenue: a(isRevenue),
    cogs: {
      net: a(inCats(["cogs", "cogs_return", "cogs_adjustment"])),
      writtenOff: a(inCats(["cogs"])),
      returns: a(inCats(["cogs_return"])),
      adjustments: a(inCats(["cogs_adjustment"])),
    },
    packaging: a(inCats(["packaging"])),
    shippingActual: a(inCats(["shipping_cost", "return_shipping_cost"])),
    returnShipping: a(inCats(["return_shipping_cost"])),
    duties: a(inCats(["duties_paid"])),
    fees: {
      net: a(inCats(["payment_fees", "platform_fees", "chargeback_fees"])),
      payment: a(inCats(["payment_fees"])),
      platform: a(inCats(["platform_fees"])),
      chargeback: a(inCats(["chargeback_fees"])),
    },
    partner: {
      net: a(inCats(["partner_commission"])),
      accrued: a((e) => cat(e) === "partner_commission" && accrual(e)),
      adjustments: a((e) => cat(e) === "partner_commission" && !accrual(e)),
    },
    otherCosts: a(inCats(["return_handling", "other_expense", "inventory_loss", "inventory_gain"])),
    taxCollected: a(inCats(["tax_collected_memo"])),
    discountsMemo: a(inCats(["discount_memo"]), negate),
    giftCards: a(inCats(["gift_card_memo"])),
  };
}

export interface CardProfit {
  kind: "fact" | "forecast" | "hidden" | "not_applicable";
  /** Прибуток у валюті показу; null — не показується / немає курсу. */
  value: string | null;
  /** Рентабельність, 1 знак («56.8»); null — «—». */
  margin: string | null;
  /** Чиста виручка (база рентабельності) у валюті показу. */
  netRevenue: string | null;
  /** Відсутні складники (incomplete): «Неможливо розрахувати: немає даних — …». */
  missing: Array<{ component: OrderComponent; reason: ComponentReason | null }>;
  unconverted: UnconvertedTotal[];
}

/**
 * Прибуток замовлення (I4: = Σ сконвертованих записів замовлення + для «≈ Прогноз» — прогнози, що рахуються).
 * `forecasts` — ЛИШЕ ті, що рахуються (components.ts isForecastCounted).
 */
export function cardProfit(input: {
  orderState: "open" | "recognized" | "closed_unrecognized" | "excluded";
  profitState: ProfitState;
  entries: readonly CardEntryInput[];
  forecasts: readonly CardForecastInput[];
  missing: Array<{ component: OrderComponent; reason: ComponentReason | null }>;
  currency: string;
  rateOf: ScaledRateLookup;
}): CardProfit {
  const profitItems = input.entries.filter((e) => {
    const c = cat(e);
    return c !== null && affectsProfit(c);
  });
  const nrItems = input.entries.filter((e) => {
    const c = cat(e);
    return c !== null && (FINANCE_CATEGORY_DEFS[c].kind === "revenue" || FINANCE_CATEGORY_DEFS[c].kind === "contra_revenue");
  });
  const nr = cardAmount(nrItems, input.currency, input.rateOf);
  if (input.orderState !== "recognized" || input.profitState === "n/a") {
    return { kind: "not_applicable", value: null, margin: null, netRevenue: nr.converted, missing: [], unconverted: [] };
  }
  if (input.profitState === "incomplete") return { kind: "hidden", value: null, margin: null, netRevenue: nr.converted, missing: input.missing, unconverted: [] };
  const items: CardEntryInput[] = [...profitItems];
  if (input.profitState === "preliminary") items.push(...input.forecasts.filter((f) => f.component !== "revenue").map((f) => ({ category: f.component, amount: f.amount, currency: f.currency, fxOn: f.fxOn })));
  const total = cardAmount(items, input.currency, input.rateOf);
  const value = total.converted ?? (items.length === 0 ? "0.00" : null);
  const margin = value !== null && nr.converted !== null ? marginPercent(toMinorForCurrency(value, input.currency), toMinorForCurrency(nr.converted, input.currency)) : null;
  return { kind: input.profitState === "final" ? "fact" : "forecast", value, margin, netRevenue: nr.converted, missing: [], unconverted: total.unconverted };
}

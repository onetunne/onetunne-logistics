/**
 * Еталонна модель (WP12a): блок «Фінанси замовлення» (§2.4, §18.4) — рядки нетто + складники, прибуток за станом,
 * рентабельність у валюті звітності. Суми — зі знаком впливу на прибуток (витрата «−»); картка показує модулі.
 */
import { cents, percent1, str, type Cents } from "./money";
import type { RefCategory, RefComponent } from "./categories";
import type { ConvertContext } from "./fx";
import { orderProfit, Converter, type RefJournal } from "./pnl";
import { paidByCustomer, type RefTransactionFact } from "./order-posting";

export interface CardAmount {
  /** Σ у початкових валютах (валюта → сума). */
  byCurrency: Record<string, string>;
  /** Σ записів, кожен за курсом свого fx_on; null — записів немає (не «0», F4) або є записи без курсу. */
  converted: string | null;
}

export interface OrderCard {
  state: string;
  products: { net: CardAmount; sold: CardAmount; returned: CardAmount; beforeDiscounts: CardAmount; discounts: CardAmount };
  shippingPaid: CardAmount;
  /** basis: valuation — «Склад (факт)»; owner_standard — «Факт (за ручною собівартістю)» (§6.5, §6.8). */
  cogs: { net: CardAmount; writtenOff: CardAmount; returns: CardAmount; state: string | null; basis: string | null };
  packaging: CardAmount & { state: string | null };
  shippingActual: CardAmount & { state: string | null; forecast: CardAmount | null; basis: string | null };
  fees: CardAmount & { state: string | null };
  partner: { net: CardAmount; accrued: CardAmount; adjustments: CardAmount; state: string | null };
  taxCollected: CardAmount;
  paidByCustomer: { received: string; refunded: string; net: string } | null;
  /** Прибуток: Факт (final), «≈ Прогноз» (preliminary) або null з переліком відсутнього (incomplete). */
  profit: { kind: "fact" | "forecast" | "hidden"; value: string | null; margin: string | null; missing: RefComponent[] };
}

function amountOf(items: ReadonlyArray<{ amount: string; currency: string; fxOn: string }>, currency: string, ctx: ConvertContext): CardAmount {
  const by = new Map<string, Cents>();
  const conv = new Converter(currency, ctx);
  let total = 0n;
  let missing = false;
  for (const it of items) {
    by.set(it.currency, (by.get(it.currency) ?? 0n) + cents(it.amount));
    const v = conv.of(it);
    if (v === null) missing = true;
    else total += v;
  }
  return { byCurrency: Object.fromEntries([...by.entries()].map(([c, v]) => [c, str(v)])), converted: missing || items.length === 0 ? null : str(total) };
}

export function orderCard(j: RefJournal, orderId: string, currency: string, ctx: ConvertContext, transactions?: readonly RefTransactionFact[]): OrderCard {
  const meta = j.orders.find((m) => m.orderId === orderId);
  const es = j.entries.filter((e) => e.orderId === orderId);
  const pick = (cats: readonly RefCategory[], pred?: (e: (typeof es)[number]) => boolean) => es.filter((e) => cats.includes(e.category) && (!pred || pred(e)));
  const a = (cats: readonly RefCategory[], pred?: (e: (typeof es)[number]) => boolean) => amountOf(pick(cats, pred), currency, ctx);
  const productDisc = pick(["discount_memo"], (e) => e.details?.lineType === "PRODUCT");
  const sold = pick(["sales_product"]);
  const st = (c: RefComponent) => meta?.components?.[c]?.state ?? null;
  const fcShipping = j.forecasts.filter((f) => f.orderId === orderId && f.component === "shipping_cost");
  const op = orderProfit(j, orderId, currency, ctx);
  let profit: OrderCard["profit"];
  if (meta?.state === "final") profit = { kind: "fact", value: str(op.entriesProfit), margin: percent1(op.entriesProfit, op.netRevenue), missing: [] };
  else if (meta?.state === "preliminary") {
    const v = op.entriesProfit + op.forecast;
    profit = { kind: "forecast", value: str(v), margin: percent1(v, op.netRevenue), missing: [] };
  } else profit = { kind: "hidden", value: null, margin: null, missing: [...(meta?.missing ?? [])] };
  return {
    state: meta?.state ?? "open",
    products: {
      net: a(["sales_product", "refund_product"]),
      sold: amountOf(sold, currency, ctx),
      returned: a(["refund_product"]),
      beforeDiscounts: amountOf([...sold, ...productDisc], currency, ctx),
      discounts: amountOf(productDisc.map((e) => ({ ...e, amount: str(-cents(e.amount)) })), currency, ctx),
    },
    shippingPaid: a(["sales_shipping", "refund_shipping"]),
    cogs: { net: a(["cogs", "cogs_return"]), writtenOff: a(["cogs"]), returns: a(["cogs_return"]), state: st("cogs"), basis: meta?.components?.cogs?.basis ?? null },
    packaging: { ...a(["packaging"]), state: st("packaging") },
    shippingActual: {
      ...a(["shipping_cost", "return_shipping_cost"]),
      state: st("shipping_cost"),
      forecast: fcShipping.length ? amountOf(fcShipping, currency, ctx) : null,
      basis: fcShipping[0]?.basis ?? null,
    },
    fees: { ...a(["payment_fees", "platform_fees", "chargeback_fees"]), state: st("fees") },
    partner: {
      net: a(["partner_commission"]),
      accrued: a(["partner_commission"], (e) => e.details?.event === "accrual"),
      adjustments: a(["partner_commission"], (e) => e.details?.event !== "accrual"),
      state: st("partner"),
    },
    taxCollected: a(["tax_collected_memo"]),
    paidByCustomer: transactions ? paidByCustomer(transactions) : null,
    profit,
  };
}

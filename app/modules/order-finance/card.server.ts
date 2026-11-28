/**
 * Етап 6, WP4: дані блоку «Фінанси замовлення» (docs/stage6-design.md §2.4, §18.4) — СЕРВІС ЧИТАННЯ власника:
 * requireFinance(ctx, "view") (дозвіл finance.view + роль owner) першим рядком; працівник і підроблений актор отримують
 * ForbiddenError. Сторінка замовлення бере його через financeFieldOrNull (працівнику — поле `finance = null`).
 *
 * Усі суми — з журналу (F1): діючі записи замовлення у початкових валютах + у валюті показу (типово — валюта
 * звітності `finance.reportingCurrency`; `?currency=` — одна з валют показу), кожен запис за курсом свого fx_on;
 * прогноз — окремим числом (лише ті, що рахуються: components.ts isForecastCounted) за курсом дати визнання (виручка й
 * комісії — дата курсу виручки, D-25); відсутнє — null (F4). «Оплачено покупцем» — грошовий вигляд із транзакцій
 * (не P&L).
 */
import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  financeChangeLog,
  financeDiscrepancies,
  financeEntries,
  orderDisputes,
  orderFinance,
  orderFinanceForecasts,
  orderShopifyFinance,
  orderTransactions,
  orders,
  shipmentCostEstimates,
  shipments,
  shippingForecastSnapshots,
} from "~/db/schema";
import {
  ORDER_COMPONENTS,
  type ComponentReason,
  type ComponentState,
  type DiscrepancyCode,
  type DiscrepancySeverity,
  type DiscrepancyStatus,
  type FinanceBasis,
  type OrderComponent,
  type OrderFinanceState,
  type ProfitState,
  type RecognitionBasis,
  type ReviewReason,
} from "~/domain/finance";
import { NotFoundError } from "~/lib/errors";
import { isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import { loadReconciliationState } from "~/modules/finance-sync/facts-view.server";
import { canFinance, requireFinance } from "~/modules/finance/core/access.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { missingComponents, parseOrderComponents, type ComponentValue } from "~/modules/finance/core/states";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { impliedRatio, type UnconvertedTotal } from "~/modules/fx/convert";
import { createRateResolver, rateWindowOf, type RateResolver } from "~/modules/fx/rate-for.server";
import { getOrderPartner, listPartnerOptions } from "~/modules/partners/partners.server";
import type { ServiceContext } from "~/server/types";
import { cardAmount, cardProfit, cardRows, type CardAmount, type CardProfit, type CardRows } from "./card";
import { isForecastCounted } from "./components";
import { parseOrderOverrides } from "./overrides";
import { paymentDateOf, revenueFxDateOf } from "./recognition";

type Ctx = Pick<ServiceContext, "db" | "actor" | "mode" | "now">;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface CardComponentView {
  component: OrderComponent;
  state: ComponentState;
  reason: ComponentReason | null;
  basis: FinanceBasis | null;
  hasForecast: boolean;
  required: boolean;
  /** Прогноз, що рахується в «≈ Прогноз» (null — немає). */
  forecast: (CardAmount & { basis: string | null }) | null;
}

export interface CardEntryView {
  id: string;
  category: string;
  amount: string;
  currency: string;
  recognizedOn: string;
  originalOn: string;
  fxOn: string;
  isLate: boolean;
  isLateCompletion: boolean;
  /** Це сторно іншого запису. */
  reversal: boolean;
  /** Запис сторновано (не діє). */
  reversed: boolean;
  /** Сума у валюті показу (null — немає курсу). */
  converted: string | null;
  rate: { rateDate: string; source: "base" | "nbu" | "manual" | "demo"; fallback: boolean } | null;
}

export interface OrderFinanceCardData {
  orderId: string;
  orderNumber: string;
  /** Валюта показу (звітності або обрана з валют показу). */
  currency: string;
  reportingCurrency: string;
  displayCurrencies: string[];
  shopCurrency: string;
  state: OrderFinanceState | "none";
  profitState: ProfitState;
  recognizedOn: string | null;
  recognitionBasis: RecognitionBasis | null;
  testOrder: boolean;
  includesTestOrders: boolean;
  needsReview: boolean;
  reviewReasons: ReviewReason[];
  version: number;
  components: CardComponentView[];
  rows: CardRows;
  profit: CardProfit;
  /** «Оцінка» виручки (order_snapshot) — окремим рядком, ніколи не факт. */
  estimate: CardAmount | null;
  paid: {
    currency: string;
    received: string;
    refunded: string;
    net: string;
    /** Транзакції прочитано повністю (інакше «неповно»). */
    complete: boolean;
    /** Відкрита розбіжність звірки RC2 (Σ платежів ≠ netPaymentSet, §16.5): «Оплачено покупцем» не підтверджено. */
    reconciliationMismatch: boolean;
    presentment: { currency: string; received: string; impliedRatio: string | null } | null;
  } | null;
  discountCodes: string[];
  /** Останнє повернення товарів (дата Києва) — для підрядка «повернено … (дата)». */
  lastReturnOn: string | null;
  shipping: {
    /** Заморожені прогнози (§7.1) за накладними. */
    snapshots: Array<{ waybillKey: string; basis: string; amount: string | null; currency: string | null; late: boolean }>;
    /** «Розрахунок перевізника (не рахунок)» — довідково. */
    carrierReported: Array<{ shipmentId: string; amount: string; currency: string; currencyAssumed: boolean; payer: string | null }>;
  };
  reconciliation: { hasFacts: boolean; checks: Array<{ check: string; status: string; candidate: boolean }>; partial: OrderComponent[] } | null;
  discrepancies: Array<{ id: string; type: DiscrepancyCode; status: DiscrepancyStatus; severity: DiscrepancySeverity; createdAt: string }>;
  disputes: Array<{
    id: string;
    source: string;
    status: string | null;
    outcome: string | null;
    amount: string | null;
    recoveredAmount: string | null;
    currency: string | null;
    fee: string | null;
    feeCurrency: string | null;
    decidedOn: string | null;
    vatReducible: boolean | null;
    fullPartnerCancellation: boolean;
    version: number;
  }>;
  partner: {
    displayName: string | null;
    code: string | null;
    rateBp: number | null;
    status: string;
    manual: boolean;
    commissionState: string | null;
    expected: { amount: string; currency: string } | null;
  } | null;
  overrides: {
    recipientPays: boolean;
    noShippingCost: boolean;
    feesZeroConfirmed: boolean;
    packagingAccountedInTotal: boolean;
    confirmedAmounts: { version: number; products: string; shipping: string; currency: string } | null;
  };
  entries: CardEntryView[];
  history: Array<{ id: number; entityType: string; action: string; reason: string | null; createdAt: string; actorRole: string; after: Record<string, unknown> | null }>;
  unconverted: UnconvertedTotal[];
}

/** Максимум записів у розгортанні «Записи й курси». */
export const CARD_ENTRIES_LIMIT = 300;

function entryRate(resolver: RateResolver | null, currency: string, target: string, fxOn: string): CardEntryView["rate"] {
  if (!resolver || currency === target) return null;
  const c = currency === "UAH" ? target : currency;
  const r = resolver.rateFor(c, fxOn);
  return r.ok ? { rateDate: r.rateDate, source: r.source, fallback: r.fallback } : null;
}

/**
 * Дані блоку (null — фінансів замовлення ще немає: рядок order_finance не створено). `currency` — валюта показу
 * (не зберігається); недопустима → валюта звітності.
 */
export async function loadOrderFinanceCard(ctx: Ctx, orderId: string, opts: { currency?: string | null } = {}): Promise<OrderFinanceCardData | null> {
  requireFinance(ctx, "view");
  if (!UUID_RE.test(orderId)) throw new NotFoundError("order");
  const [order] = await ctx.db
    .select({ id: orders.id, orderNumber: orders.orderNumber, currency: orders.currency, shopifyTest: orders.shopifyTest, placedAt: orders.placedAt })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) throw new NotFoundError("order");
  const settings = await loadFinanceSettings(ctx.db);
  const display = [...new Set([settings.reportingCurrency, ...settings.displayCurrencies])];
  const currency = opts.currency && display.includes(opts.currency) ? opts.currency : settings.reportingCurrency;
  const [fin] = await ctx.db.select().from(orderFinance).where(eq(orderFinance.orderId, orderId));
  const components = parseOrderComponents(fin?.components) ?? {};
  const all = await ctx.db.select().from(financeEntries).where(and(eq(financeEntries.storeId, DEFAULT_STORE_ID), eq(financeEntries.orderId, orderId))).orderBy(asc(financeEntries.seq));
  const reversedIds = new Set(all.filter((e) => e.reversesEntryId).map((e) => e.reversesEntryId!));
  const active = all.filter((e) => !e.reversesEntryId && !reversedIds.has(e.id)).map((e) => ({ ...e, currency: e.currency.trim() }));
  const txs = await ctx.db.select().from(orderTransactions).where(eq(orderTransactions.orderId, orderId));
  const paymentDate = paymentDateOf(txs.map((t) => ({ kind: t.kind, status: t.status, test: t.test, processedAt: t.processedAt })), order.placedAt);
  const revenueFx = revenueFxDateOf(settings.fx.rateDatePolicy, paymentDate, fin?.recognizedOn ?? null);
  const today = businessDate(ctx.now());
  const forecastFx = (component: string) => (component === "fees" || component === "revenue" ? (fin?.recognizedOn ? revenueFx : today) : (fin?.recognizedOn ?? today));
  const forecastRows = await ctx.db.select().from(orderFinanceForecasts).where(eq(orderFinanceForecasts.orderId, orderId));
  const forecasts = forecastRows.map((f) => ({ component: f.component as OrderComponent, amount: f.amount, currency: f.currency.trim(), fxOn: forecastFx(f.component), basis: f.basis }));
  const counted = forecasts.filter((f) => isForecastCounted(f.component, components[f.component]));
  const estimateRows = forecasts.filter((f) => f.component === "revenue" && f.basis === "order_snapshot");
  const convertible = [...all.map((e) => ({ currency: e.currency.trim(), fxOn: e.fxOn })), ...forecasts.map((f) => ({ currency: f.currency, fxOn: f.fxOn }))].filter((x) => isSupportedCurrency(x.currency));
  const window = rateWindowOf(convertible, [currency]);
  const resolver = window ? await createRateResolver(ctx.db, window, { mode: ctx.mode }) : null;
  const rateOf = (c: string, d: string) => (resolver ? resolver.scaled(c, d) : c === "UAH" ? 10n ** 10n : null);
  const rows = cardRows(active, currency, rateOf);
  // «0,00» — лише відомий нуль (§2.6, F4): виручка фактична (угоди прочитано повністю / суми підтверджено), а рядка
  // немає (нульові записи не проводяться — напр. безкоштовна доставка) → відомий 0; невідоме — «—».
  const revenueKnown = fin?.state === "recognized" && (components.revenue?.state === "actual" || components.revenue?.state === "partial");
  if (revenueKnown) {
    if (rows.shippingPaid.entries === 0) rows.shippingPaid = knownZero();
    if (rows.products.net.entries === 0) rows.products.net = knownZero();
  }
  // Складник визнаного замовлення фактичний або «0 (підтверджено)» (правило «без комісії», «Шлюз без комісії», частка 0),
  // а записів немає — відомий 0,00, не «—» (§2.4 «0 (підтверджено)», §2.6).
  const settledEmpty = (c: OrderComponent, a: CardAmount) => fin?.state === "recognized" && (components[c]?.state === "actual" || components[c]?.state === "zero_confirmed") && a.entries === 0;
  if (settledEmpty("fees", rows.fees.net)) rows.fees.net = knownZero();
  if (settledEmpty("cogs", rows.cogs.net)) rows.cogs.net = knownZero();
  if (settledEmpty("packaging", rows.packaging)) rows.packaging = knownZero();
  if (settledEmpty("shipping_cost", rows.shippingActual)) rows.shippingActual = knownZero();
  if (settledEmpty("duties_paid", rows.duties)) rows.duties = knownZero();
  if (settledEmpty("partner", rows.partner.net)) rows.partner.net = knownZero();
  const profit = cardProfit({
    orderState: fin?.state ?? "open",
    profitState: fin?.profitState ?? "n/a",
    entries: active,
    forecasts: counted,
    missing: missingComponents(components),
    currency,
    rateOf,
  });
  const componentsView: CardComponentView[] = ORDER_COMPONENTS.flatMap((c) => {
    const v: ComponentValue | undefined = components[c];
    if (!v) return [];
    const own = counted.filter((f) => f.component === c);
    return [{ component: c, state: v.state, reason: v.reason, basis: v.basis, hasForecast: v.hasForecast, required: v.required, forecast: own.length ? { ...cardAmount(own, currency, rateOf), basis: own[0]!.basis } : null }];
  });
  // «Оплачено покупцем» (§2.4): SUCCESS SALE/CAPTURE − SUCCESS REFUND, не тестові; у валюті магазину й покупця.
  const [facts] = await ctx.db.select().from(orderShopifyFinance).where(eq(orderShopifyFinance.orderId, orderId));
  const reconciliation = facts ? await loadReconciliationState(ctx.db, orderId) : null;
  const rc2Mismatch = Boolean(reconciliation?.checks?.RC2?.status === "mismatch" && reconciliation.discrepancies.some((d) => d.check === "RC2" && d.status === "open"));
  const shopCurrency = facts?.shopCurrency?.trim() ?? order.currency.trim();
  let paid: OrderFinanceCardData["paid"] = null;
  const ok = txs.filter((t) => t.status === "SUCCESS" && !t.test && t.currency.trim() === shopCurrency && isSupportedCurrency(shopCurrency));
  if (txs.length > 0 && isSupportedCurrency(shopCurrency)) {
    const sum = (kinds: readonly string[]) => ok.filter((t) => kinds.includes(t.kind)).reduce((a, t) => a + toMinorForCurrency(t.amount, shopCurrency), 0n);
    const received = sum(["SALE", "CAPTURE"]);
    const refunded = sum(["REFUND"]);
    const pCur = facts?.presentmentCurrency?.trim() ?? null;
    let presentment: NonNullable<OrderFinanceCardData["paid"]>["presentment"] = null;
    if (pCur && pCur !== shopCurrency && isSupportedCurrency(pCur)) {
      const pReceived = ok.filter((t) => (t.kind === "SALE" || t.kind === "CAPTURE") && t.pAmount && t.pCurrency?.trim() === pCur).reduce((a, t) => a + toMinorForCurrency(t.pAmount!, pCur), 0n);
      presentment = { currency: pCur, received: minorToString(pReceived), impliedRatio: received > 0n ? impliedRatio(minorToString(pReceived), minorToString(received)) : null };
    }
    const snapshotStatus = (facts?.snapshot as { status?: { transactions?: string } } | undefined)?.status?.transactions;
    paid = {
      currency: shopCurrency,
      received: minorToString(received),
      refunded: minorToString(refunded),
      net: minorToString(received - refunded),
      complete: (!facts || snapshotStatus === "complete") && !rc2Mismatch,
      reconciliationMismatch: rc2Mismatch,
      presentment,
    };
  }
  const discrepancies = await ctx.db
    .select({ id: financeDiscrepancies.id, type: financeDiscrepancies.type, status: financeDiscrepancies.status, severity: financeDiscrepancies.severity, createdAt: financeDiscrepancies.createdAt })
    .from(financeDiscrepancies)
    .where(and(eq(financeDiscrepancies.storeId, DEFAULT_STORE_ID), eq(financeDiscrepancies.orderId, orderId)))
    .orderBy(sql`case ${financeDiscrepancies.status} when 'open' then 0 else 1 end`, desc(financeDiscrepancies.createdAt))
    .limit(50);
  const disputes = await ctx.db.select().from(orderDisputes).where(eq(orderDisputes.orderId, orderId)).orderBy(asc(orderDisputes.firstSeenAt), asc(orderDisputes.id));
  const partnerView = await getOrderPartner(ctx, orderId);
  const snapshots = await ctx.db.select().from(shippingForecastSnapshots).where(eq(shippingForecastSnapshots.orderId, orderId)).orderBy(asc(shippingForecastSnapshots.frozenAt));
  const estimates = await ctx.db
    .select({ shipmentId: shipmentCostEstimates.shipmentId, amount: shipmentCostEstimates.amount, currency: shipmentCostEstimates.currency, currencyAssumed: shipmentCostEstimates.currencyAssumed, payer: shipmentCostEstimates.payer })
    .from(shipmentCostEstimates)
    .innerJoin(shipments, eq(shipments.id, shipmentCostEstimates.shipmentId))
    .where(eq(shipments.orderId, orderId));
  const historyIds = [orderId, ...disputes.map((d) => d.id)];
  const history = await ctx.db
    .select()
    .from(financeChangeLog)
    .where(
      and(
        eq(financeChangeLog.storeId, DEFAULT_STORE_ID),
        inArray(financeChangeLog.entityId, historyIds),
        or(inArray(financeChangeLog.entityType, ["order_component_override", "chargeback", "partner_attribution"]))!,
      ),
    )
    .orderBy(desc(financeChangeLog.createdAt), desc(financeChangeLog.id))
    .limit(50);
  const overrides = parseOrderOverrides(fin?.overrides);
  const returnSales = active.filter((e) => e.category === "refund_product").map((e) => e.originalOn).sort();
  return {
    orderId,
    orderNumber: order.orderNumber,
    currency,
    reportingCurrency: settings.reportingCurrency,
    displayCurrencies: display,
    shopCurrency,
    state: fin?.state ?? "none",
    profitState: fin?.profitState ?? "n/a",
    recognizedOn: fin?.recognizedOn ?? null,
    recognitionBasis: fin?.recognitionBasis ?? null,
    testOrder: order.shopifyTest,
    includesTestOrders: settings.includeTestOrders,
    needsReview: fin?.needsReview ?? false,
    reviewReasons: (fin?.reviewReasons ?? []) as ReviewReason[],
    version: fin?.version ?? 0,
    components: componentsView,
    rows,
    profit,
    estimate: estimateRows.length ? cardAmount(estimateRows, currency, rateOf) : null,
    paid,
    discountCodes: facts?.discountCodes ?? [],
    lastReturnOn: returnSales.length ? returnSales[returnSales.length - 1]! : null,
    shipping: {
      snapshots: snapshots.map((s) => ({ waybillKey: s.waybillKey, basis: s.basis, amount: s.amount, currency: s.currency?.trim() ?? null, late: s.lateSnapshot })),
      carrierReported: estimates.map((e) => ({ shipmentId: e.shipmentId, amount: e.amount, currency: e.currency.trim(), currencyAssumed: e.currencyAssumed, payer: e.payer })),
    },
    reconciliation: reconciliation
      ? {
          hasFacts: reconciliation.hasFacts,
          checks: reconciliation.checks ? Object.entries(reconciliation.checks).map(([check, v]) => ({ check, status: v.status, candidate: v.candidate })) : [],
          partial: reconciliation.partialComponents,
        }
      : null,
    discrepancies: discrepancies.map((d) => ({ id: d.id, type: d.type as DiscrepancyCode, status: d.status as DiscrepancyStatus, severity: d.severity as DiscrepancySeverity, createdAt: d.createdAt.toISOString() })),
    disputes: disputes.map((d) => ({
      id: d.id,
      source: d.source,
      status: d.status,
      outcome: d.outcome,
      amount: d.amount,
      recoveredAmount: d.recoveredAmount,
      currency: d.currency?.trim() ?? null,
      fee: d.fee,
      feeCurrency: d.feeCurrency?.trim() ?? null,
      decidedOn: d.decidedOn,
      vatReducible: d.vatReducible,
      fullPartnerCancellation: d.fullPartnerCancellation,
      version: d.version,
    })),
    partner: partnerView?.attribution
      ? {
          displayName: partnerView.attribution.displayName,
          code: partnerView.attribution.code,
          rateBp: partnerView.attribution.rateBp,
          status: partnerView.attribution.status,
          manual: partnerView.attribution.manual,
          commissionState: partnerView.commission?.state ?? null,
          expected: partnerView.expected ? { amount: partnerView.expected.amount, currency: partnerView.expected.currency } : null,
        }
      : null,
    overrides: {
      recipientPays: Boolean(overrides.recipient_pays),
      noShippingCost: Boolean(overrides.no_shipping_cost),
      feesZeroConfirmed: Boolean(overrides.fees_zero_confirmed),
      packagingAccountedInTotal: Boolean(overrides.packaging_accounted_in_total),
      confirmedAmounts: overrides.confirmed_amounts
        ? { version: overrides.confirmed_amounts.version, products: overrides.confirmed_amounts.products, shipping: overrides.confirmed_amounts.shipping, currency: overrides.confirmed_amounts.currency }
        : null,
    },
    entries: all.slice(-CARD_ENTRIES_LIMIT).map((e) => {
      const c = e.currency.trim();
      const conv = isSupportedCurrency(c) ? cardAmount([{ amount: e.amount, currency: c, fxOn: e.fxOn }], currency, rateOf).converted : null;
      return {
        id: e.id,
        category: e.category,
        amount: e.amount,
        currency: c,
        recognizedOn: e.recognizedOn,
        originalOn: e.originalOn,
        fxOn: e.fxOn,
        isLate: e.isLate,
        isLateCompletion: e.isLateCompletion,
        reversal: Boolean(e.reversesEntryId),
        reversed: reversedIds.has(e.id),
        converted: conv,
        rate: isSupportedCurrency(c) ? entryRate(resolver, c, currency, e.fxOn) : null,
      };
    }),
    history: history.map((h) => ({ id: h.id, entityType: h.entityType, action: h.action, reason: h.reason, createdAt: h.createdAt.toISOString(), actorRole: h.actorRole, after: (h.after as Record<string, unknown> | null) ?? null })),
    unconverted: profit.unconverted,
  };
}

/** Відомий нуль (записів немає, бо нульові записи не проводяться). */
function knownZero(): CardAmount {
  return { original: [], converted: "0.00", unconverted: [], entries: 0 };
}

function minorToString(minor: bigint): string {
  const neg = minor < 0n;
  const a = neg ? -minor : minor;
  return `${neg ? "-" : ""}${a / 100n}.${(a % 100n).toString().padStart(2, "0")}`;
}

export interface OrderFinancePanel {
  card: OrderFinanceCardData | null;
  /** finance.manage + роль owner — дії картки. */
  canManage: boolean;
  /** uuid форм (новий після кожної успішної дії — перезавантаження loader). */
  operationIds: { chargeback: string; shipping: string };
  partnerOptions: Array<{ id: string; displayName: string }>;
  today: string;
}

/**
 * Поле `finance` сторінки замовлення (лише власник; працівнику сторінка повертає null через financeFieldOrNull):
 * дані блоку + дозволи дій + uuid форм + партнери для «Партнер: змінити».
 */
export async function loadOrderFinancePanel(ctx: Ctx, orderId: string, opts: { currency?: string | null } = {}): Promise<OrderFinancePanel> {
  requireFinance(ctx, "view");
  const [exists] = await ctx.db.select({ orderId: orderFinance.orderId }).from(orderFinance).where(eq(orderFinance.orderId, orderId));
  const card = exists ? await loadOrderFinanceCard(ctx, orderId, opts) : null;
  const canManage = canFinance(ctx.actor, "manage");
  const partnerOptions = canManage ? (await listPartnerOptions(ctx)).filter((p) => p.status === "active").map((p) => ({ id: p.id, displayName: p.displayName })) : [];
  return { card, canManage, operationIds: { chargeback: randomUUID(), shipping: randomUUID() }, partnerOptions, today: businessDate(ctx.now()) };
}

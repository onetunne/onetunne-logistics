/**
 * Етап 6, WP4: фінанси замовлення — бажаний стан (docs/stage6-design.md §2.4–§2.6, §3, §4, §6.5, §7.1, §8, §9.4, §10.3).
 * ВНУТРІШНЯ функція проведення (F8, contracts.ts SyncOrderFinance): актора НЕ перевіряє (її запускають потоки
 * працівників — накладна, передача, відстеження, «відправлено поза застосунком», пакування, надходження, синхронізація
 * Shopify, відкриття обліку, демо), пише лише `posted_by = actor.id` і нічого не повертає. Сторінки, маршрути, команди й
 * інструменти ШІ модуль не імпортують (тест-сканер); точки підключення — кінець syncOrderReservations, хук оцінки складу
 * (WP2), запис фактів Shopify (WP3), дії власника (картка замовлення, витрати, правила комісій, місяці, партнери).
 *
 * Один виклик (у транзакції викликача, під `pg_advisory_xact_lock(FINANCE_ORDER_LOCK)` — після стану собівартості, F10;
 * рядок замовлення НЕ блокується):
 *  1. визнання (recognition.ts): дата, раз установлена, не рухається; стан open / recognized / closed_unrecognized /
 *     excluded (тестове без includeTestOrders); голова order_finance — до виклику пакетів (WP6/WP7/WP9 читають її);
 *  2. журнал (plan.ts + diff.ts): продажі угод (SALE_CATEGORY_MAP, R1/R2, D-25), комісії (R1/R2/R3/R5), коригування курсу
 *     (довідково), собівартість і упаковка з оцінок складу (WP2 costingEntriesForOrder), ручна собівартість позицій без
 *     списання (stdcogs, кількість при визнанні), рахунки перевізника (`inv:`), chargeback (брутто / повернено / ПДВ),
 *     підтверджені власником суми — бажаний набір проти діючих записів: різниця сторнується / проводиться (F2,
 *     repostEntries — нове покоління ключа, коли факт знову чинний: тестове замовлення при перемиканні includeTestOrders);
 *  3. ручні витрати й частки сум періоду (WP6 syncOrderExpenseEntries), заморожені прогнози доставки (визнання),
 *     винагорода партнера (WP7 syncPartnerCommission — confirmedProducts), випадки повернень (WP9);
 *  4. складники й прогнози (components.ts): стан, основа, «≈ Прогноз»; покриття сумою періоду (WP6
 *     coveringStatusForOrder): allocated → факт, awaiting_reallocation → missing (I16); стан прибутку, «Потребує перевірки»;
 *  5. ОСТАННІМ записом — постановка перерахунку розподілу (WP6 enqueueExpenseReallocation: утримання рядка завдання до
 *     фіксації транзакції — §10.3).
 * Ідемпотентно: повтор без змін фактів не додає записів (I3). Відсутнє НІКОЛИ не стає 0 (F4).
 */
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { financeDiscrepancies, financeEntries, orderFinance, orderFinanceForecasts, orders, shippingForecastSnapshots } from "~/db/schema";
import { ORDER_COMPONENTS, REVIEW_REASONS, type FactsSource, type FinanceCategory, type OrderComponent, type ReviewReason } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { DomainError } from "~/lib/errors";
import { fromMinor, isSupportedCurrency, toMinorForCurrency } from "~/lib/decimal";
import { businessDate, monthStart } from "~/lib/periods";
import { costingEntriesForOrder, loadOrderCostingFacts, type OrderCostFact } from "~/modules/costing/order-facts.server";
import { ownerStandardCost } from "~/modules/costing/forecast.server";
import { coveringStatusForOrder, type OrderCoveringStatus } from "~/modules/expenses/allocation.server";
import { loadFeeRules } from "~/modules/expenses/fee-rules.server";
import { feeForecast } from "~/modules/expenses/fee-rules";
import { syncOrderExpenseEntries } from "~/modules/expenses/posting.server";
import { enqueueExpenseReallocation } from "~/modules/expenses/reallocation.server";
import { confirmItemEntries, isPackagingAccountedInTotal } from "~/modules/finance/periods/periods.server";
import type { PostingActor, SyncOrderFinance } from "~/modules/finance/core/contracts";
import { autoResolveDiscrepancy, discrepancyKey, openDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { repostEntries, reverseEntries, type EntryInput } from "~/modules/finance/core/entries.server";
import { lockFinanceOrder, lockFinanceOrders } from "~/modules/finance/core/locks.server";
import { resolveRateMode } from "~/modules/finance/core/rate-mode.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { componentValueSchema, profitStateOf, type ComponentValue, type OrderComponents } from "~/modules/finance/core/states";
import { DEFAULT_STORE_ID } from "~/modules/finance/core/store.server";
import { syncPartnerCommission } from "~/modules/partners/sync.server";
import { syncReturnCasesForOrder } from "~/modules/returns/sync.server";
import { getSetting } from "~/modules/settings/settings.server";
import type { ServiceContext } from "~/server/types";
import {
  cogsComponent,
  dutiesComponent,
  feesComponent,
  packagingComponent,
  revenueComponent,
  shippingComponent,
  sumByCurrency,
  type ComponentDraft,
  type CogsLineInput,
  type FeeRuleOutcome,
  type FeesInput,
  type ForecastRow,
  type Money,
  type PackagingInput,
  type ShippingInput,
  type WaybillForecastInput,
} from "./components";
import { diffEntries } from "./diff";
import { loadManagedEntries, loadOrderEntryTotals, loadOrderFinanceFacts, type OrderFinanceFacts } from "./facts.server";
import { freezeShippingSnapshots, kitPackagingForecast, shippingForecastChain, unitForecastOf, type ShippingForecast, type WaybillRef } from "./forecast.server";
import { parseOrderOverrides, shippingOverrideOf, type OrderOverrides } from "./overrides";
import {
  DISPUTE_FEE_TYPE_RE,
  chargebackEntries,
  confirmationEntries,
  feeEntries,
  fxAdjustmentEntries,
  invoiceLineEntries,
  isLaterChargeType,
  normalizeLineType,
  saleEntries,
  standardCogsEntries,
  waybillKeyOf,
  type PlanContext,
  type StandardCogsLine,
} from "./plan";
import { paymentDateOf, recognizeOrder, revenueFxDateOf } from "./recognition";

export interface SyncOrderFinanceOptions {
  /** Момент синхронізації (дата проведення пізніх записів, сьогоднішня дата прогнозів). */
  now?: Date;
}

const ORDER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Контракт ядра (contracts.ts): `(tx, actor, orderId) → void`. Необов'язковий четвертий аргумент — годинник сервісу
 * викликача (`{ now: ctx.now() }`): пізні записи й події, спричинені рішенням власника, датуються моментом рішення.
 */
export const syncOrderFinance = ((tx: Tx, actor: PostingActor, orderId: string, opts?: SyncOrderFinanceOptions): Promise<void> =>
  syncOrderFinanceAt(tx, actor, orderId, opts)) satisfies SyncOrderFinance;

/** Складник → категорії журналу (Σ діючих записів — `actual` складника). */
export const COMPONENT_CATEGORIES: Readonly<Record<OrderComponent, readonly FinanceCategory[]>> = {
  revenue: [
    "sales_product",
    "sales_shipping",
    "sales_other",
    "sales_adjustment",
    "sales_unknown",
    "refund_product",
    "refund_shipping",
    "refund_other",
    "refund_adjustment",
    "refund_unknown",
    "chargeback_loss",
  ],
  cogs: ["cogs", "cogs_return", "cogs_adjustment"],
  packaging: ["packaging"],
  shipping_cost: ["shipping_cost", "return_shipping_cost"],
  fees: ["payment_fees", "platform_fees", "chargeback_fees"],
  partner: ["partner_commission"],
  duties_paid: ["duties_paid"],
};

const REVIEW_SET = new Set<string>(REVIEW_REASONS);

/** Дата країни призначення: знімок відправлення → адреса замовлення. */
function destinationOf(facts: OrderFinanceFacts): string | null {
  for (const s of facts.shipments) if (s.destinationCountry && /^[A-Z]{2}$/.test(s.destinationCountry)) return s.destinationCountry;
  return facts.order.shipCountryCode && /^[A-Z]{2}$/.test(facts.order.shipCountryCode) ? facts.order.shipCountryCode : null;
}

/** Ефективна кількість позиції (current_quantity ?? quantity). */
const effectiveQty = (l: { quantity: number; currentQuantity: number | null }) => l.currentQuantity ?? l.quantity;

/** Угоди прочитано повністю (WP3: snapshot.status.sales; демо-продажі без рядка фактів — так само). */
function salesCompleteOf(facts: OrderFinanceFacts): boolean {
  if (facts.shopify) return facts.shopify.snapshot.status.sales === "complete";
  return facts.sales.length > 0 && facts.sales.every((s) => s.source === "demo");
}

/**
 * Кількість позиції, передана при визнанні: Σ кількостей продажів PRODUCT угод до визнання (повні угоди), інакше —
 * ефективна кількість позиції (current_quantity ?? quantity).
 */
function quantityAtRecognition(facts: OrderFinanceFacts, lineId: string, recognizedAt: Date | null, complete: boolean): number {
  const line = facts.lines.find((l) => l.id === lineId);
  const fallback = line ? effectiveQty(line) : 0;
  if (!complete || !recognizedAt) return fallback;
  const sales = facts.sales.filter((s) => s.orderLineItemId === lineId && normalizeLineType(s.lineType) === "PRODUCT" && s.quantity !== null && s.happenedAt.getTime() <= recognizedAt.getTime());
  if (sales.length === 0) return fallback;
  const q = sales.reduce((a, s) => a + (s.quantity ?? 0), 0);
  return q > 0 ? q : 0;
}

/** Деталі розбіжностей, розв'язаних власником як «Залишити обидва» (ручна комісія chargeback поряд із Shopify). */
async function keepBothFeeDisputes(tx: Tx, orderId: string): Promise<Set<string>> {
  const prefix = `${discrepancyKey("chargeback_fee_overlap", orderId)}:`;
  const rows = await tx
    .select({ key: financeDiscrepancies.dedupeKey, status: financeDiscrepancies.status, resolution: financeDiscrepancies.resolutionCode })
    .from(financeDiscrepancies)
    .where(and(eq(financeDiscrepancies.storeId, DEFAULT_STORE_ID), eq(financeDiscrepancies.type, "chargeback_fee_overlap"), eq(financeDiscrepancies.orderId, orderId)));
  const out = new Set<string>();
  for (const r of rows) if (r.key.startsWith(prefix) && r.status === "resolved" && r.resolution === "kept_both") out.add(r.key.slice(prefix.length));
  return out;
}

/**
 * Прогноз правила шлюзів (база — SUCCESS SALE/CAPTURE шлюзу; без транзакцій — сума замовлення, §4). `only` — лише ці
 * оплати (§8.1 по транзакції: оплати без жодного рядка комісії поряд з оплатами, що мають комісії Shopify); оплата без
 * назви шлюзу серед них — правила не знайти (none).
 */
async function feeRuleOutcome(tx: Tx, facts: OrderFinanceFacts, date: string, only?: ReadonlySet<string>): Promise<FeeRuleOutcome> {
  const success = facts.transactions.filter((t) => t.status === "SUCCESS" && !t.test && (t.kind === "SALE" || t.kind === "CAPTURE"));
  if (only && success.some((t) => only.has(t.id) && !t.gateway)) return { state: "none" };
  const paid = success.filter((t) => t.gateway && (!only || only.has(t.id)));
  const bases = new Map<string, { minor: bigint; currency: string }>();
  for (const t of paid) {
    if (!isSupportedCurrency(t.currency)) return { state: "none" };
    const b = bases.get(t.gateway!) ?? { minor: 0n, currency: t.currency };
    if (b.currency !== t.currency) return { state: "none" };
    b.minor += toMinorForCurrency(t.amount, t.currency);
    bases.set(t.gateway!, b);
  }
  if (bases.size === 0) {
    if (only) return { state: "none" };
    const gateways = facts.shopify?.paymentGatewayNames ?? [];
    if (gateways.length !== 1 || !isSupportedCurrency(facts.order.currency)) return { state: "none" };
    bases.set(gateways[0]!, { minor: toMinorForCurrency(facts.order.total, facts.order.currency), currency: facts.order.currency });
  }
  const rules = await loadFeeRules(tx, { gateways: [...bases.keys()] });
  const lines: Money[] = [];
  let zero = 0;
  for (const [gateway, b] of [...bases].sort(([a], [c]) => (a < c ? -1 : 1))) {
    const f = feeForecast(rules, { gateway, date, base: { amount: fromMinor(b.minor), currency: b.currency } });
    if (f.state === "none") return { state: "none" };
    if (f.state === "zero_confirmed") zero++;
    else lines.push(...f.lines.map((l) => ({ amount: l.amount, currency: l.currency })));
  }
  if (zero === bases.size) return { state: "zero_confirmed" };
  return { state: "forecast", lines };
}

/** Сума ненульова (валюта, що не проводиться, або пошкоджена сума — вважається ненульовою: факт є, але невідомий). */
function nonZeroAmount(amount: string, currency: string): boolean {
  if (!isSupportedCurrency(currency)) return true;
  try {
    return toMinorForCurrency(amount, currency) !== 0n;
  } catch {
    return true;
  }
}

/** Прогнози (усі, крім partner — їх веде WP7): бажаний стан → заміна рядків замовлення (§4). */
async function writeForecastRows(tx: Tx, orderId: string, forecastRows: readonly ForecastRow[], now: Date): Promise<void> {
  await tx.delete(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, orderId), ne(orderFinanceForecasts.component, "partner")));
  const merged = new Map<string, ForecastRow>();
  for (const r of forecastRows) {
    if (r.component === "partner" || !isSupportedCurrency(r.currency)) continue;
    const k = `${r.component}|${r.currency}`;
    const prev = merged.get(k);
    merged.set(k, prev ? { ...prev, amount: fromMinor(toMinorForCurrency(prev.amount, prev.currency) + toMinorForCurrency(r.amount, r.currency)) } : r);
  }
  const rows = [...merged.values()].filter((r) => toMinorForCurrency(r.amount, r.currency) !== 0n);
  if (rows.length > 0) {
    await tx.insert(orderFinanceForecasts).values(rows.map((r) => ({ orderId, component: r.component, currency: r.currency, amount: r.amount, basis: r.basis, computedAt: now })));
  }
}

/** Бажаний стан фінансів замовлення (див. шапку). `opts.now` — для тестів і дій з фіксованим часом. */
export async function syncOrderFinanceAt(tx: Tx, actor: PostingActor, orderId: string, opts: SyncOrderFinanceOptions = {}): Promise<void> {
  // Ідентифікатор не UUID — такого замовлення немає (контракт: відсутні дані — не виняток); база не зачіпається.
  if (!ORDER_ID_RE.test(orderId)) return;
  await lockFinanceOrder(tx, orderId);
  const now = opts.now ?? new Date();
  const today = businessDate(now);
  const facts = await loadOrderFinanceFacts(tx, orderId);
  if (!facts) return;
  const settings = await loadFinanceSettings(tx);
  const mode = await resolveRateMode(tx);
  const overrides: OrderOverrides = parseOrderOverrides(facts.existing?.overrides);
  const shopCurrency = facts.shopify?.shopCurrency ?? facts.order.currency;
  const salesComplete = salesCompleteOf(facts);

  // 1. Визнання й голова order_finance.
  const rec = recognizeOrder({
    status: facts.order.status,
    test: facts.order.shopifyTest,
    includeTestOrders: settings.includeTestOrders,
    fullyRefunded: facts.shopify?.displayFinancialStatus === "REFUNDED",
    existing: facts.existing ? { recognizedOn: facts.existing.recognizedOn, recognizedAt: facts.existing.recognizedAt, basis: facts.existing.recognitionBasis } : null,
    handoverAt: facts.shipments.reduce<Date | null>((m, s) => (s.handedOverAt && (!m || s.handedOverAt < m) ? s.handedOverAt : m), null),
    consumeAt: facts.consumeAt,
    placedAt: facts.order.placedAt,
  });
  const newlyCounted = rec.state === "recognized" && facts.existing?.state !== "recognized";
  const paymentDate = paymentDateOf(facts.transactions, facts.order.placedAt);
  const revenueFxOn = revenueFxDateOf(settings.fx.rateDatePolicy, paymentDate, rec.recognizedOn);
  const countryCode = destinationOf(facts);
  await tx
    .insert(orderFinance)
    .values({
      orderId,
      storeId: DEFAULT_STORE_ID,
      state: rec.state,
      recognizedOn: rec.recognizedOn,
      recognizedAt: rec.recognizedAt,
      recognitionBasis: rec.basis,
      shopCurrency: isSupportedCurrency(shopCurrency) ? shopCurrency : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: orderFinance.orderId,
      set: { state: rec.state, recognizedOn: rec.recognizedOn, recognizedAt: rec.recognizedAt, recognitionBasis: rec.basis, shopCurrency: isSupportedCurrency(shopCurrency) ? shopCurrency : null, updatedAt: now },
    });

  // 2. Журнал: бажані записи → різниця з діючими.
  const managed = await loadManagedEntries(tx, orderId);
  const ctx: PlanContext = {
    orderId,
    storeId: DEFAULT_STORE_ID,
    state: rec.state,
    recognizedOn: rec.recognizedOn,
    recognizedAt: rec.recognizedAt,
    revenueFxOn,
    newlyCounted,
    countryCode,
    lineVariants: new Map(facts.lines.map((l) => [l.id, l.variantId])),
    revenueLate: !newlyCounted && !managed.some((a) => a.idempotencyKey.startsWith("sale:") || a.idempotencyKey.startsWith("confirm:")),
  };
  const review = new Set<ReviewReason>();
  const desired: EntryInput[] = [];
  const unsupportedSales = facts.shopify?.snapshot.status.sales === "unsupported_currency";
  if (salesComplete) {
    const s = saleEntries(facts.sales, ctx);
    desired.push(...s.entries);
    for (const r of s.review) review.add(r);
  }
  const f = feeEntries(facts.fees, facts.transactions, ctx);
  desired.push(...f.entries);
  for (const r of f.review) review.add(r);
  desired.push(...fxAdjustmentEntries(facts.transactions, ctx));

  // Собівартість і упаковка з оцінок складу (WP2).
  const costing = await loadOrderCostingFacts(tx, orderId);
  const costingCounted = rec.state === "recognized" || rec.state === "closed_unrecognized" || rec.state === "excluded";
  if (costingCounted) {
    desired.push(
      ...costingEntriesForOrder(orderId, costing.facts, { recognizedOn: rec.state === "recognized" ? rec.recognizedOn : null, excludedTestOrder: rec.state === "excluded" }).map((e) => ({
        ...e,
        countryCode,
        storeId: DEFAULT_STORE_ID,
      })),
    );
  }

  // Ручна собівартість позицій без списання (§6.5 п. 2). Діючий запис stdcogs позиції ЗАМОРОЖЕНИЙ (F6): кількість і
  // ручна собівартість на дату визнання не перераховуються (зміна ручної собівартості — коригування WP2, повернення —
  // cogs_return); він сторнується, лише коли позиція більше не підходить (з'явилося списання зі складу, замовлення
  // виключено).
  const saleFactsByLine = new Map<string, OrderCostFact[]>();
  for (const cf of costing.facts) if (cf.kind === "sale" && cf.orderLineItemId) saleFactsByLine.set(cf.orderLineItemId, [...(saleFactsByLine.get(cf.orderLineItemId) ?? []), cf]);
  const productLines = facts.lines.filter((l) => l.requiresShipping !== false);
  const stdLineOf = (key: string) => /^stdcogs:([^:]+):/.exec(key)?.[1]?.toLowerCase() ?? null;
  const activeStdLines = new Set(managed.map((a) => stdLineOf(a.idempotencyKey)).filter((x): x is string => x !== null));
  const frozenStd = new Set<string>();
  const stdLines: StandardCogsLine[] = [];
  if (rec.state === "recognized" && rec.recognizedOn) {
    for (const l of productLines) {
      if (saleFactsByLine.has(l.id) || !l.stockItemId) continue;
      if (activeStdLines.has(l.id.toLowerCase())) {
        frozenStd.add(l.id.toLowerCase());
        continue;
      }
      const qty = quantityAtRecognition(facts, l.id, rec.recognizedAt, salesComplete);
      if (qty <= 0) continue;
      const std = await ownerStandardCost(tx, l.stockItemId, rec.recognizedOn);
      stdLines.push({ lineId: l.id, variantId: l.variantId, stockItemId: l.stockItemId, quantity: qty, standard: std ? { unitCost: std.unitCost, currency: std.currency.trim(), costId: std.costId } : null });
    }
  }
  desired.push(...standardCogsEntries(stdLines, ctx));
  const standardValued = new Set([...frozenStd, ...stdLines.filter((l) => l.standard).map((l) => l.lineId.toLowerCase())]);

  // Рахунки перевізника (WP5 пише рядки, тут — проведення за R1/R2/R3/R5).
  desired.push(...invoiceLineEntries(facts.invoiceLines, ctx, { vatPayer: settings.vatPayer }));

  // Chargeback (§8.2).
  const shopifyDisputeFee = facts.fees.some((x) => x.type && DISPUTE_FEE_TYPE_RE.test(x.type));
  const cb = chargebackEntries(facts.disputes, facts.sales, { ...ctx, shopCurrency }, { shopifyDisputeFee, keepBothFeeDisputeIds: await keepBothFeeDisputes(tx, orderId) });
  desired.push(...cb.entries);
  for (const r of cb.review) review.add(r);

  // Підтверджені власником суми (лише без повних угод Shopify).
  const confirmed = !salesComplete && overrides.confirmed_amounts ? overrides.confirmed_amounts : null;
  desired.push(...confirmationEntries(confirmed, ctx));

  const diff = diffEntries(
    desired,
    managed.filter((a) => {
      const line = stdLineOf(a.idempotencyKey);
      return !(line && frozenStd.has(line));
    }),
  );
  if (diff.reverse.length > 0) await reverseEntries(tx, actor, diff.reverse, { reasonCode: "order_finance_changed", now });
  if (diff.post.length > 0) await repostEntries(tx, actor, diff.post, { now });

  // Розбіжності chargeback (§8.2): ніколи не `issues` (I19).
  const overlapKey = discrepancyKey("chargeback_refund_overlap", orderId);
  if (cb.refundOverlap) await openDiscrepancy(tx, SYSTEM_ACTOR, { type: "chargeback_refund_overlap", dedupeKey: overlapKey, orderId, details: { reason: "refund_and_lost_dispute" } });
  else await autoResolveDiscrepancy(tx, SYSTEM_ACTOR, overlapKey);
  for (const d of facts.disputes) {
    const key = discrepancyKey("chargeback_fee_overlap", orderId, d.id);
    if (cb.feeOverlapDisputeIds.includes(d.id)) await openDiscrepancy(tx, SYSTEM_ACTOR, { type: "chargeback_fee_overlap", dedupeKey: key, orderId, details: { disputeId: d.id } });
    else await autoResolveDiscrepancy(tx, SYSTEM_ACTOR, key);
  }

  // 3. Пакети: ручні витрати й частки (WP6).
  await syncOrderExpenseEntries(tx, actor, orderId, { now });

  // Заморожені прогнози доставки (§7.1) — під час визнання; накладна, додана пізніше, — late_snapshot.
  const activeShipments = facts.shipments.filter((s) => s.status === "created");
  const waybillRefs: WaybillRef[] = [
    ...activeShipments.map((s) => ({
      waybillKey: `shipment:${s.id}`,
      shipmentId: s.id,
      externalWaybillId: null,
      carrierCode: s.carrierCode,
      country: s.destinationCountry ?? countryCode,
      estimate: s.estimate,
    })),
    ...facts.externalWaybills.map((w) => ({ waybillKey: `external:${w.id}`, shipmentId: null, externalWaybillId: w.id, carrierCode: w.carrierCode, country: countryCode, estimate: null })),
  ];
  const forecastCache = new Map<string, ShippingForecast | null>();
  const snapshotKeys = new Set(facts.snapshots.map((s) => s.waybillKey));
  let snapshots = facts.snapshots;
  if (rec.state === "recognized" && rec.recognizedOn) {
    const toFreeze = waybillRefs.length > 0 ? waybillRefs : snapshotKeys.size === 0 ? [{ waybillKey: "order", shipmentId: null, externalWaybillId: null, carrierCode: null, country: countryCode, estimate: null }] : [];
    const added = await freezeShippingSnapshots(tx, {
      orderId,
      date: rec.recognizedOn,
      waybills: toFreeze,
      existing: snapshotKeys,
      late: !newlyCounted,
      settings,
      mode,
      now,
      cache: forecastCache,
    });
    if (added > 0) snapshots = await tx.select().from(shippingForecastSnapshots).where(eq(shippingForecastSnapshots.orderId, orderId));
  }

  // Винагорода партнера (WP7) — після голови order_finance; підтверджені суми — база замість продажів.
  const partner = await syncPartnerCommission(tx, actor, orderId, {
    finance: { state: rec.state, recognizedOn: rec.recognizedOn, recognizedAt: rec.recognizedAt, newlyRecognized: newlyCounted },
    confirmedProducts: confirmed ? { amount: confirmed.products, currency: confirmed.currency } : null,
    now,
  });
  for (const r of partner.review) review.add(r);

  // Випадки повернень (WP9).
  await syncReturnCasesForOrder(tx, actor, orderId);

  // 4. Складники й прогнози. Покриття сумою періоду (WP6 coveringStatusForOrder) — ПІСЛЯ запису прогнозів цього
  // замовлення: розподіл «пропорційно прогнозам» (§10.3) бере ваги з order_finance_forecasts, тож замовлення, уперше
  // синхронізоване вже після збереження суми (прогнозу-ваги ще немає), інакше не було б «awaiting_reallocation» і його
  // прогноз рахувався б поряд із сумою періоду (I16). Покриття є → складники комісій / доставки / упаковки — наново.
  let covering: OrderCoveringStatus[] = [];
  const coveringOf = (c: OrderComponent): "allocated" | "awaiting_reallocation" | null => {
    const list = covering.filter((x) => x.component === c);
    if (list.some((x) => x.state === "allocated")) return "allocated";
    if (list.some((x) => x.state === "awaiting_reallocation")) return "awaiting_reallocation";
    return null;
  };
  const totals = await loadOrderEntryTotals(tx, orderId);
  const actualOf = (c: OrderComponent) =>
    sumByCurrency(totals.filter((t) => (COMPONENT_CATEGORIES[c] as readonly string[]).includes(t.category)).map((t) => ({ amount: t.amount, currency: t.currency })));
  const hasCategory = (cats: readonly string[]) => totals.some((t) => cats.includes(t.category) && t.count > 0);
  const forecastDate = rec.recognizedOn ?? today;
  const drafts = new Map<OrderComponent, ComponentDraft>();
  let forecastRows: ForecastRow[] = [];
  const put = (c: OrderComponent, r: { value: ComponentDraft; forecasts: ForecastRow[] }) => {
    drafts.set(c, r.value);
    forecastRows = [...forecastRows.filter((x) => x.component !== c), ...r.forecasts];
  };

  // Виручка.
  const estimate =
    isSupportedCurrency(facts.order.currency) && toMinorForCurrency(facts.order.subtotal, facts.order.currency) !== 0n
      ? { amount: facts.order.subtotal, currency: facts.order.currency }
      : null;
  const openSales: Money[] = [];
  if (rec.state === "open" && salesComplete) {
    for (const s of facts.sales) {
      const lt = normalizeLineType(s.lineType);
      if (lt === "GIFT_CARD" || !isSupportedCurrency(s.currency)) continue;
      openSales.push({ amount: fromMinor(toMinorForCurrency(s.totalAmount, s.currency) - toMinorForCurrency(s.totalTax, s.currency)), currency: s.currency });
    }
  }
  put(
    "revenue",
    revenueComponent({
      state: rec.state,
      salesComplete,
      salesSource: facts.sales[0]?.source ?? (facts.shopify ? "shopify" : null),
      unsupportedCurrency: unsupportedSales,
      confirmed: confirmed ? [{ amount: confirmed.products, currency: confirmed.currency }, { amount: confirmed.shipping, currency: confirmed.currency }] : null,
      unreadable: Boolean(facts.shopify?.flags.includes("order_unreadable")),
      reconciliationPartial: facts.reconciliation.partialComponents.includes("revenue"),
      estimate,
      openSales,
    }),
  );
  if (unsupportedSales) review.add("unsupported_currency");

  // Собівартість.
  const cogsLines: CogsLineInput[] = [];
  for (const l of productLines) {
    const saleFacts = saleFactsByLine.get(l.id) ?? [];
    let required: number;
    let valued = 0;
    let fromStandard = 0;
    if (saleFacts.length > 0) {
      required = saleFacts.reduce((a, x) => a + x.qty, 0);
      valued = saleFacts.reduce((a, x) => a + Math.max(0, x.qty - x.unvaluedRemaining), 0);
    } else if (rec.state === "recognized") {
      required = quantityAtRecognition(facts, l.id, rec.recognizedAt, salesComplete);
      if (standardValued.has(l.id.toLowerCase())) {
        valued = required;
        fromStandard = required;
      }
    } else required = effectiveQty(l);
    if (rec.state !== "recognized" && rec.state !== "open") required = 0;
    const unitForecast = valued < required ? await unitForecastOf(tx, l.stockItemId, forecastDate) : null;
    cogsLines.push({ required, valued, fromStandard, unitForecast });
  }
  put("cogs", cogsComponent(rec.state, cogsLines));

  // Відкрите замовлення: відомі суми ручних витрат із замовленням (WP6 проводить їх лише при визнанні, §3.3).
  const pendingManualOf = (...categories: string[]): Money[] | undefined =>
    rec.state === "open" ? sumByCurrency(categories.flatMap((c) => facts.manualExpenseAmounts.get(c) ?? [])) : undefined;

  // Упаковка.
  const packagingFacts = costing.facts.filter((x) => x.kind === "packaging");
  const unvaluedPackaging = packagingFacts.map((x) => ({ stockItemId: x.stockItemId, units: Math.max(0, x.unknownQty + x.deficitQty - x.completions.reduce((a, c) => a + c.qty, 0)) }));
  const unvaluedUnits = unvaluedPackaging.reduce((a, x) => a + x.units, 0);
  let unvaluedForecast: Money[] | null = null;
  if (unvaluedUnits > 0) {
    unvaluedForecast = [];
    for (const u of unvaluedPackaging) {
      if (u.units === 0) continue;
      const unit = await unitForecastOf(tx, u.stockItemId, forecastDate);
      if (!unit) {
        unvaluedForecast = null;
        break;
      }
      unvaluedForecast.push({ amount: fromMinor(toMinorForCurrency(unit.unitCost, unit.currency) * BigInt(u.units)), currency: unit.currency });
    }
  }
  const manualPackaging = facts.manualExpenseCategories.has("packaging");
  const noPackagingFacts = packagingFacts.length === 0;
  // «Упаковку обліковано загальною сумою» (§2.6): лише коли за місяць визнання Є загальна сума упаковки (packaging_unlinked
  // або упаковка без замовлення) — і для підтвердження місяця, і для позначки власника на замовленні (сума анульована —
  // позначка більше не діє, упаковка знову «немає даних»).
  const accountedInTotal =
    noPackagingFacts &&
    rec.state === "recognized" &&
    rec.recognizedOn !== null &&
    ((Boolean(overrides.packaging_accounted_in_total) && (await confirmItemEntries(tx, monthStart(rec.recognizedOn), "packaging_total_accounted")) > 0) ||
      (await isPackagingAccountedInTotal(tx, rec.recognizedOn)));
  const kitForecast =
    noPackagingFacts && !manualPackaging && (rec.state === "open" || rec.state === "recognized") ? await kitPackagingForecast(tx, orderId, facts.packingBoxMaterialId ?? facts.order.parcelBoxMaterialId, forecastDate) : null;
  const packagingInput: Omit<PackagingInput, "covering"> = {
    state: rec.state,
    hasValuedFacts: packagingFacts.some((x) => x.value !== null),
    unvaluedUnits,
    unvaluedForecast,
    manual: manualPackaging,
    accountedInTotal,
    kitForecast,
    pendingValued:
      rec.state === "open" ? packagingFacts.filter((x) => x.value !== null && isSupportedCurrency(x.currency)).map((x) => ({ amount: x.value!, currency: x.currency })) : [],
    pendingManual: pendingManualOf("packaging"),
  };
  put("packaging", packagingComponent({ ...packagingInput, covering: coveringOf("packaging") }));

  // Доставка.
  const activeLines = facts.invoiceLines.filter((l) => l.active);
  const snapshotOf = (key: string) => snapshots.find((s) => s.waybillKey === key) ?? null;
  const waybillInputs: WaybillForecastInput[] = [];
  for (const w of waybillRefs) {
    let forecast: WaybillForecastInput["forecast"];
    if (rec.state === "recognized") {
      const snap = snapshotOf(w.waybillKey);
      forecast = snap ? { basis: snap.basis, amount: snap.amount, currency: snap.currency?.trim() ?? null } : null;
    } else {
      const live = await shippingForecastChain(tx, { country: w.country, date: today, estimate: w.estimate, settings, mode, cache: forecastCache });
      forecast = { basis: live.basis, amount: live.amount, currency: live.currency };
    }
    const ship = w.shipmentId ? activeShipments.find((s) => s.id === w.shipmentId) : null;
    const own = activeLines.filter((l) => waybillKeyOf(l) === w.waybillKey && l.chargeType !== "customs_duty" && isSupportedCurrency(l.currency));
    waybillInputs.push({
      key: w.waybillKey,
      hasActual: own.some((l) => !isLaterChargeType(l.chargeType, l.amount, l.currency)),
      payerRecipient: Boolean(ship?.estimate?.payer && /^recipient$/i.test(ship.estimate.payer)),
      forecast,
      invoiced: rec.state === "open" ? sumByCurrency(own.map((l) => ({ amount: settings.vatPayer && l.amountExclVat !== null ? l.amountExclVat : l.amount, currency: l.currency }))) : undefined,
    });
  }
  let orderForecast: WaybillForecastInput["forecast"] = null;
  if (waybillRefs.length === 0) {
    if (rec.state === "recognized") {
      const snap = snapshotOf("order");
      orderForecast = snap ? { basis: snap.basis, amount: snap.amount, currency: snap.currency?.trim() ?? null } : null;
    } else if (rec.state === "open") {
      const live = await shippingForecastChain(tx, { country: countryCode, date: today, estimate: null, settings, mode, cache: forecastCache });
      orderForecast = { basis: live.basis, amount: live.amount, currency: live.currency };
    }
  }
  const shippingInput: Omit<ShippingInput, "covering"> = {
    state: rec.state,
    needsShipping: facts.lines.length === 0 || facts.lines.some((l) => l.requiresShipping !== false),
    override: shippingOverrideOf(overrides),
    manual: facts.manualExpenseCategories.has("shipping_cost"),
    waybills: waybillInputs,
    orderForecast,
    pendingManual: pendingManualOf("shipping_cost"),
  };
  put("shipping_cost", shippingComponent({ ...shippingInput, covering: coveringOf("shipping_cost") }));

  // Комісії. §8.1 «Порожній fees = немає даних» — по транзакції: SUCCESS-оплата SALE/CAPTURE без жодного рядка комісії
  // (у валюті, що проводиться) має невідому комісію навіть поряд з оплатою, що має комісії Shopify (Shopify Payments +
  // PayPal, дві оплати) — для неї правило шлюзу (прогноз / «без комісії») або «немає даних», НІКОЛИ не 0.
  const feesStatus = facts.shopify?.snapshot.status.fees ?? "not_read";
  const isDisputeFee = (x: { type: string | null }) => Boolean(x.type && DISPUTE_FEE_TYPE_RE.test(x.type));
  const shopifyFees: Money[] =
    rec.state === "recognized"
      ? desired.filter((e) => e.sourceType === "shopify_fee" && e.category === "payment_fees").map((e) => ({ amount: fromMinor(-toMinorForCurrency(e.amount, e.currency)), currency: e.currency }))
      : facts.fees
          .filter((x) => {
            const t = facts.transactions.find((tt) => tt.id === x.transactionId);
            return t && t.status === "SUCCESS" && !t.test && isSupportedCurrency(x.currency) && !isDisputeFee(x);
          })
          .map((x) => ({ amount: x.amount, currency: x.currency }));
  const paidTx = facts.transactions.filter((t) => t.status === "SUCCESS" && !t.test && (t.kind === "SALE" || t.kind === "CAPTURE") && nonZeroAmount(t.amount, t.currency));
  const successTx = new Set(facts.transactions.filter((t) => t.status === "SUCCESS" && !t.test).map((t) => t.id));
  const feeTxIds = new Set(facts.fees.filter((x) => !isDisputeFee(x) && isSupportedCurrency(x.currency) && successTx.has(x.transactionId)).map((x) => x.transactionId));
  // Комісії, записані на авторизації (AUTHORIZATION → CAPTURE; на якому виді транзакції Shopify записує комісію —
  // НЕДОКУМЕНТОВАНО, §8.1), покривають її списання: оплата CAPTURE з батьківською авторизацією, що має комісії, — відома.
  const byShopifyId = new Map(facts.transactions.filter((t) => t.shopifyId).map((t) => [t.shopifyId!, t.id]));
  const hasFeeRows = (t: { id: string; parentShopifyId?: string | null }) => feeTxIds.has(t.id) || Boolean(t.parentShopifyId && feeTxIds.has(byShopifyId.get(t.parentShopifyId) ?? ""));
  const uncoveredTx = paidTx.filter((t) => !hasFeeRows(t));
  const knownFees = paidTx.length > 0 ? uncoveredTx.length < paidTx.length : shopifyFees.length > 0;
  const ownerZero = Boolean(overrides.fees_zero_confirmed);
  const manualFees = facts.manualExpenseCategories.has("payment_fees") || facts.manualExpenseCategories.has("platform_fees");
  const needRule = !ownerZero && !manualFees && (!knownFees || uncoveredTx.length > 0);
  const uncoveredIds = knownFees && uncoveredTx.length > 0 ? new Set(uncoveredTx.map((t) => t.id)) : undefined;
  let rule: FeeRuleOutcome = needRule ? await feeRuleOutcome(tx, facts, paymentDate, uncoveredIds) : { state: "none" };
  const feesInput: Omit<FeesInput, "covering" | "rule"> = {
    state: rec.state,
    shopifyFees,
    feesComplete: facts.shopify ? feesStatus === "complete" : facts.order.source !== "shopify",
    shopifyFacts: facts.order.source === "shopify",
    manual: manualFees,
    ownerZero,
    reconciliationPartial: facts.reconciliation.partialComponents.includes("fees"),
    knownFees,
    uncoveredPayments: uncoveredTx.length,
    pendingManual: pendingManualOf("payment_fees", "platform_fees"),
  };
  put("fees", feesComponent({ ...feesInput, rule, covering: coveringOf("fees") }));

  // Прогнози цього замовлення — до перевірки покриття (ваги розподілу), потім покриття й складники, яких воно стосується.
  await writeForecastRows(tx, orderId, forecastRows, now);
  if (rec.state === "open" || rec.state === "recognized") {
    covering = await coveringStatusForOrder(tx, orderId, { mode, includeTestOrders: settings.includeTestOrders });
    if (covering.length > 0) {
      if (!needRule && coveringOf("fees") !== null) rule = await feeRuleOutcome(tx, facts, paymentDate, uncoveredIds);
      put("packaging", packagingComponent({ ...packagingInput, covering: coveringOf("packaging") }));
      put("shipping_cost", shippingComponent({ ...shippingInput, covering: coveringOf("shipping_cost") }));
      put("fees", feesComponent({ ...feesInput, rule, covering: coveringOf("fees") }));
      await writeForecastRows(tx, orderId, forecastRows, now);
    }
  }

  // Мито компанії (DDP: умова зі знімка відправлення; без відправлення — налаштування customs.incoterm).
  const incoterm = activeShipments.find((s) => s.incoterm)?.incoterm ?? (facts.shipments.length === 0 ? (await getSetting(tx, "customs")).incoterm : null);
  const dutiesActual = hasCategory(["duties_paid"]);
  put(
    "duties_paid",
    dutiesComponent(rec.state, {
      ddp: incoterm === "DDP",
      actual: dutiesActual,
      basis: activeLines.some((l) => l.chargeType === "customs_duty") ? "invoice" : facts.manualExpenseCategories.has("duties_paid") ? "manual" : null,
    }),
  );

  // Партнер (WP7: без `actual` — його рахує WP4 із записів).
  drafts.set("partner", { state: partner.component.state, reason: partner.component.reason, basis: partner.component.basis, hasForecast: partner.component.hasForecast, required: partner.component.required });

  const components: OrderComponents = {};
  for (const c of ORDER_COMPONENTS) {
    const d = drafts.get(c);
    if (!d) continue;
    const value: ComponentValue = componentValueSchema.parse({ ...d, actual: actualOf(c).slice(0, 10) });
    components[c] = value;
  }


  // Причини «Потребує перевірки».
  for (const flag of facts.shopify?.flags ?? []) if (REVIEW_SET.has(flag)) review.add(flag as ReviewReason);
  if (rec.basis === "placed_fallback" && rec.recognizedOn) review.add("recognition_date_unknown");
  const reasons = REVIEW_REASONS.filter((r) => review.has(r));
  const profitState = rec.state === "recognized" ? profitStateOf(components) : "n/a";
  const factsSource: FactsSource = salesComplete ? (facts.sales[0]?.source === "demo" ? "demo" : facts.shopify ? "shopify" : "demo") : estimate || confirmed ? "order_snapshot" : "none";
  await tx
    .update(orderFinance)
    .set({
      components,
      profitState,
      needsReview: reasons.length > 0,
      reviewReasons: [...reasons],
      factsSource,
      factsFetchedAt: facts.shopify?.fetchedAt ?? null,
      shopifyUpdatedAt: facts.shopify?.shopifyUpdatedAt ?? null,
      updatedAt: now,
    })
    .where(eq(orderFinance.orderId, orderId));

  // 5. ОСТАННІЙ запис транзакції: постановка (утримання) перерахунку розподілу сум, що чекають (§10.3).
  if (covering.some((c) => c.state === "awaiting_reallocation")) await enqueueExpenseReallocation(tx, orderId, { mode, statuses: covering, now });
}

// ---------------------------------------------------------------------------------------------------------------
// Кілька замовлень в одній транзакції (§17.8, §10.3)
// ---------------------------------------------------------------------------------------------------------------

/**
 * ВНУТРІШНЯ: синхронізація кількох замовлень в ОДНІЙ транзакції викликача. Спершу FINANCE_ORDER_LOCK усіх замовлень
 * ОДНИМ упорядкованим набором (lockFinanceOrders), потім syncOrderFinanceAt кожного в порядку id. Це обов'язковий шаблон
 * для кожного викликача, що синхронізує більше одного замовлення в транзакції: кожна синхронізація ОСТАННІМ записом ставить
 * або утримує завдання перерахунку розподілу (enqueueExpenseReallocation — блокування рядка `jobs` до фіксації); якби
 * FINO наступного замовлення бралося вже після такого утримання, паралельна синхронізація того замовлення (вона тримає
 * його FINO і чекає той самий рядок `jobs`) дала б взаємоблокування. Після попереднього блокування нових очікувань FINO
 * у транзакції немає (повторне блокування взятого — миттєве).
 */
export async function syncOrderFinanceMany(tx: Tx, actor: PostingActor, orderIds: readonly string[], opts: SyncOrderFinanceOptions = {}): Promise<number> {
  const ids = [...new Set(orderIds.filter((id) => ORDER_ID_RE.test(id)))].sort();
  await lockFinanceOrders(tx, ids);
  for (const id of ids) await syncOrderFinanceAt(tx, actor, id, opts);
  return ids.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Демо: перебудова фінансів замовлень після перенесення дат історії (WP11)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Лише демо / Vitest: заповнення демо переносить дати рухів і відправлень ПІСЛЯ вставки, а визнання (дата, раз
 * установлена, не рухається, F6) уже зафіксовано за часом вставки. Видаляє фінанси замовлень (order_finance з
 * прогнозами, заморожені прогнози доставки, записи журналу, якими керує syncOrderFinance) і синхронізує всі замовлення
 * наново в порядку id. Записи пакетів (витрати WP6, винагорода WP7) не чіпає — WP11 засіває їх після цього виклику.
 */
export async function rebuildOrderFinanceForDemo(tx: Tx, ctx: Pick<ServiceContext, "mode">, actor: PostingActor, opts: SyncOrderFinanceOptions = {}): Promise<number> {
  if (ctx.mode !== "demo" && !process.env.VITEST) throw new DomainError("finance.error.demoOnly", 403);
  const managed = ["shopify_sale", "shopify_fee", "shopify_transaction", "valuation", "owner_standard", "invoice_line", "chargeback", "owner_confirmation"] as const;
  // Сторно посилаються на оригінали (FK reverses_entry_id): спершу сторно, потім оригінали.
  await tx.delete(financeEntries).where(and(sql`${financeEntries.orderId} is not null`, inArray(financeEntries.sourceType, [...managed]), sql`${financeEntries.reversesEntryId} is not null`));
  await tx.delete(financeEntries).where(and(sql`${financeEntries.orderId} is not null`, inArray(financeEntries.sourceType, [...managed])));
  await tx.delete(shippingForecastSnapshots);
  await tx.delete(orderFinanceForecasts).where(ne(orderFinanceForecasts.component, "partner"));
  await tx.update(orderFinance).set({ state: "open", recognizedOn: null, recognizedAt: null, recognitionBasis: null });
  const ids = await tx.select({ id: orders.id }).from(orders).orderBy(asc(orders.id));
  return syncOrderFinanceMany(tx, actor, ids.map((r) => r.id), opts);
}

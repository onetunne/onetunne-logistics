/**
 * Етап 6, WP7: ВНУТРІШНЯ функція проведення партнерської винагороди замовлення (docs/stage6-design.md §9.2–§9.4, F8).
 * Модуль містить ЛИШЕ внутрішні функції: актора не перевіряють (їх запускає syncOrderFinance — WP4 — у потоках
 * працівників: передача, пакування, надходження), пишуть лише posted_by і НЕ повертають грошей (кількості й коди).
 * Імпорт у app/pages/**, app/routes/**, команди й інструменти ШІ заборонено (запит до ядра: додати в
 * INTERNAL_POSTING_FUNCTIONS / INTERNAL_ONLY_MODULES).
 *
 * syncPartnerCommission(tx, actor, orderId, opts) — бажаний стан партнерської частини замовлення під
 * FINANCE_ORDER_LOCK (бере сама, повторно — безпечно; викликач тримає його після стану собівартості, F10):
 * 1. Атрибуція (attribution.ts): ручні рішення власника (source = owner) НЕ перезаписуються. Автоматична атрибуція,
 *    раз ухвалена, ФІКСУЄТЬСЯ разом зі ставкою й днями утримання на дату замовлення (§9.1 «Новий відсоток діятиме для
 *    нових замовлень»): пізніше вимкнення коду, пауза чи архів партнера, нова ставка чи нові дні утримання її не
 *    змінюють — лише зміна кодів самого замовлення (Shopify) або поява ще одного придатного коду іншого партнера
 *    (неоднозначність, §9.2). Нові рішення — лише за кодами, придатними на момент рішення (активний код активного
 *    партнера, дійсний на дату замовлення). Код, що збігся, але непридатний (вимкнений код / партнер на паузі чи в
 *    архіві), фіксує «не атрибутовано» (status removed, details.blockedCodeIds) — повторна активація партнера не
 *    приписує йому замовлень, оформлених під час паузи. Неоднозначно → розбіжність partner_attribution_ambiguous (без
 *    `issues`, I19); зникла неоднозначність → розбіжність закривається.
 * 2. Бажана комісія (commission.ts) і події (§9.4): нарахування при визнанні (R1: дата визнання, утримання = дата +
 *    hold_days), далі «бажана − Σ ЧИННИХ подій» → коригування (R2) або скасування до 0; ключ події й запису журналу —
 *    `pc:<orderId>:<partnerId>:<n>` (n — наступний номер під блокуванням замовлення серед УСІХ подій). Запис
 *    `partner_commission` = −сума події (витрата). Повтор — нуль нових подій (I3). Дата коригування поточного
 *    партнера — найпізніша дата фактів, не старіших за його останню чинну подію (продажі після визнання — дата Києва
 *    happened_at; спори — decided_on) і рішення про атрибуцію (ухвалене цим викликом або рішення власника, не раніше
 *    тієї події); інакше — сьогодні; не раніше дати визнання. Невідома бажана сума (немає продажів, сума програного спору не внесена, інша валюта спору) чи
 *    неоднозначна атрибуція → подій не створює (проведене не змінюється).
 * 3. Замовлення виключено (тестове, вимкнено includeTestOrders, §2.5) → СТОРНО (F2, reverseEntries: дата й fx_on
 *    оригіналу — оригінал + сторно = 0 у будь-якій валюті, I14) усіх чинних записів винагороди замовлення; події
 *    стають нечинними (events.server.ts). Знову враховується → повторне проведення тих самих подій (repostEntries,
 *    покоління ключа `:g<n>`) з їхніми датами, потім звичайне «бажана − Σ». Записи pc:* сторнує й проводить ЛИШЕ цей
 *    модуль (WP4 їх не чіпає; повторне сторно того самого запису неможливе — ключ `<ключ>:rev` унікальний).
 * 4. Прогноз (`order_finance_forecasts`, складник partner) — лише до визнання; після — факт замінює прогноз.
 *    Цей модуль ВЛАСНИК рядків component = 'partner' (WP4 їх не замінює).
 * 5. Повертає стан складника partner (без грошей: `actual` WP4 бере з журналу) і причини «Потребує перевірки».
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import {
  financeDiscrepancies,
  orderDisputes,
  orderFinance,
  orderFinanceForecasts,
  orderSales,
  orderShopifyFinance,
  orders,
  partnerAttributions,
  partnerCodes,
  partnerCommissionEvents,
  partnerRates,
  partners,
} from "~/db/schema";
import type { AgreementKind, ComponentReason, ComponentState, DisputeOutcome, FinanceBasis, OrderFinanceState, ReviewReason } from "~/domain/finance";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import type { PostingActor } from "~/modules/finance/core/contracts";
import { autoResolveDiscrepancy, discrepancyKey, openDiscrepancy } from "~/modules/finance/core/discrepancies.server";
import { activeEntryRefs, postEntries, repostEntries, reverseEntries, type EntryInput } from "~/modules/finance/core/entries.server";
import { financeKeys } from "~/modules/finance/core/keys";
import { lockFinanceOrder } from "~/modules/finance/core/locks.server";
import { loadFinanceSettings } from "~/modules/finance/core/settings.server";
import { fromMinor, toMinorForCurrency } from "~/lib/decimal";
import { businessDate } from "~/lib/periods";
import { resolveAttribution, rateOn, type AttributionDecision, type CandidateCode } from "./attribution";
import { isCodeValidOn, normalizeCode, normalizeOrderCodes } from "./codes";
import { computeCommission, planCommissionEvents, type CommissionComputation, type CommissionTarget } from "./commission";
import { loadOrderEvents, type EventRow } from "./events.server";
import type { Money, PartnerCodeSource, PartnerStatus } from "./types";

/** Стан фінансів замовлення на момент виклику (WP4 передає щойно обчислений; інакше — з order_finance). */
export interface PartnerSyncFinance {
  state: OrderFinanceState;
  recognizedOn: string | null;
  recognizedAt: Date | null;
  /** Цей виклик щойно визнав замовлення (нарахування — R1, не «пізнє завершення» R3). */
  newlyRecognized: boolean;
}

export interface PartnerSyncOptions {
  finance?: PartnerSyncFinance;
  /** Суми товарів без податків, підтверджені власником (замовлення без угод Shopify, §4) — база замість продажів. */
  confirmedProducts?: Money | null;
  now?: Date;
}

/** Стан складника partner для order_finance.components (без `actual` — його рахує WP4 із записів журналу). */
export interface PartnerComponent {
  state: ComponentState;
  reason: ComponentReason | null;
  basis: FinanceBasis | null;
  hasForecast: boolean;
  required: boolean;
}

/** Результат — лише коди й кількості (F8). */
export interface PartnerSyncResult {
  attribution: "none" | "attributed" | "ambiguous" | "removed";
  partnerId: string | null;
  /** Нових подій partner_commission_events. */
  events: number;
  /** Нових записів журналу (partner_commission). */
  entries: number;
  /** Сторновано записів винагороди (замовлення виключено). */
  reversed: number;
  /** Повторно проведено записів винагороди (замовлення знову враховується). */
  reposted: number;
  component: PartnerComponent;
  review: ReviewReason[];
}

type AttributionRow = typeof partnerAttributions.$inferSelect;

const maxIsoDate = (a: string | null, b: string) => (a === null || b > a ? b : a);

const NOT_APPLICABLE: PartnerComponent = { state: "not_applicable", reason: "no_partner", basis: null, hasForecast: false, required: false };

/** Ключ розбіжності неоднозначної атрибуції (один на замовлення). */
export function ambiguityKey(orderId: string): string {
  return discrepancyKey("partner_attribution_ambiguous", orderId);
}

/**
 * Замовлення, для яких syncPartnerCommission виконалась усередині `fn` (той самий асинхронний ланцюжок). Дії власника
 * (partners.server.ts) так дізнаються, чи syncOrderFinance (WP4) уже провела винагороду своїм викликом із повними
 * вхідними даними (confirmedProducts) — і тоді не викликають її вдруге без них.
 */
const syncWatch = new AsyncLocalStorage<Set<string>>();
export async function watchPartnerSyncs<T>(fn: () => Promise<T>): Promise<{ result: T; synced: ReadonlySet<string> }> {
  const seen = new Set<string>();
  const result = await syncWatch.run(seen, fn);
  return { result, synced: seen };
}

/** Запис журналу події (той самий ключ, що й у події; −сума — витрата). */
function entryOfEvent(e: EventRow, isLateCompletion: boolean): EntryInput {
  return {
    idempotencyKey: e.idempotencyKey,
    category: "partner_commission",
    recognizedOn: e.recognizedOn,
    fxOn: e.recognizedOn,
    isLateCompletion,
    amount: fromMinor(-toMinorForCurrency(e.amount, e.currency)),
    currency: e.currency,
    orderId: e.orderId,
    partnerId: e.partnerId,
    sourceType: "partner_event",
    sourceId: e.id,
    details: { kind: e.kind, n: e.n, rateBp: e.rateBp, base: e.base },
    storeId: e.storeId,
  };
}

/** Бажаний стан партнерської частини замовлення (див. вгорі файла). */
export async function syncPartnerCommission(tx: Tx, actor: PostingActor, orderId: string, opts: PartnerSyncOptions = {}): Promise<PartnerSyncResult> {
  await lockFinanceOrder(tx, orderId);
  syncWatch.getStore()?.add(orderId);
  const now = opts.now ?? new Date();
  const today = businessDate(now);
  const [order] = await tx
    .select({ id: orders.id, placedAt: orders.placedAt, shopifyTest: orders.shopifyTest })
    .from(orders)
    .where(eq(orders.id, orderId));
  if (!order) return { attribution: "none", partnerId: null, events: 0, entries: 0, reversed: 0, reposted: 0, component: NOT_APPLICABLE, review: [] };
  const settings = await loadFinanceSettings(tx);
  const [financeRow] = await tx
    .select({ state: orderFinance.state, recognizedOn: orderFinance.recognizedOn, recognizedAt: orderFinance.recognizedAt })
    .from(orderFinance)
    .where(eq(orderFinance.orderId, orderId));
  const [facts] = await tx
    .select({
      discountCodes: orderShopifyFinance.discountCodes,
      referralCode: orderShopifyFinance.referralCode,
      journeyReady: orderShopifyFinance.journeyReady,
      flags: orderShopifyFinance.flags,
      displayFinancialStatus: orderShopifyFinance.displayFinancialStatus,
    })
    .from(orderShopifyFinance)
    .where(eq(orderShopifyFinance.orderId, orderId));
  const [existingAttr] = await tx.select().from(partnerAttributions).where(eq(partnerAttributions.orderId, orderId)).for("update");
  const finance: PartnerSyncFinance = opts.finance ?? {
    state: financeRow?.state ?? "open",
    recognizedOn: financeRow?.recognizedOn ?? null,
    recognizedAt: financeRow?.recognizedAt ?? null,
    newlyRecognized: false,
  };
  const placedOn = businessDate(order.placedAt);
  const excludedTest = order.shopifyTest && !settings.includeTestOrders;
  const allEvents = await loadOrderEvents(tx, orderId);

  // 1. Атрибуція.
  const attr = await settleAttribution(tx, {
    orderId,
    placedOn,
    excludedTest,
    existing: existingAttr ?? null,
    hasEventsFor: (partnerId) => allEvents.some((e) => e.partnerId === partnerId),
    discountCodes: facts?.discountCodes ?? [],
    referralCode: facts?.referralCode ?? null,
    defaultRateBp: settings.partners.defaultRateBp,
    now,
  });
  const review: ReviewReason[] = [];
  if (attr?.status === "ambiguous") review.push("partner_attribution_ambiguous");
  if (facts?.flags.includes("journey_never_ready") && attr?.status !== "attributed" && (await hasActiveReferralCodes(tx))) review.push("journey_never_ready");

  // 2. Бажана комісія.
  const attributed = attr?.status === "attributed" && attr.partnerId && attr.rateBp !== null && attr.holdDays !== null ? attr : null;
  const counted = finance.state === "open" || finance.state === "recognized";
  let comp: CommissionComputation | null = null;
  let salesSource: "shopify" | "demo" | null = null;
  let lastFactOn: string | null = null;
  if (attributed && counted) {
    const sales = await tx
      .select({
        agreementKind: orderSales.agreementKind,
        lineType: orderSales.lineType,
        totalAmount: orderSales.totalAmount,
        totalTax: orderSales.totalTax,
        currency: orderSales.currency,
        happenedAt: orderSales.happenedAt,
        source: orderSales.source,
      })
      .from(orderSales)
      .where(eq(orderSales.orderId, orderId));
    const disputes = await tx
      .select({
        outcome: orderDisputes.outcome,
        amount: orderDisputes.amount,
        recoveredAmount: orderDisputes.recoveredAmount,
        currency: orderDisputes.currency,
        decidedOn: orderDisputes.decidedOn,
        fullPartnerCancellation: orderDisputes.fullPartnerCancellation,
      })
      .from(orderDisputes)
      .where(eq(orderDisputes.orderId, orderId));
    comp = computeCommission({
      sales: sales.map((s) => ({ agreementKind: s.agreementKind as AgreementKind, lineType: s.lineType, totalAmount: s.totalAmount, totalTax: s.totalTax, currency: s.currency })),
      displayFinancialStatus: facts?.displayFinancialStatus ?? null,
      disputes: disputes.map((d) => ({ ...d, outcome: d.outcome as DisputeOutcome | null })),
      rateBp: attributed.rateBp!,
      confirmedProducts: opts.confirmedProducts ?? null,
    });
    salesSource = sales[0]?.source ?? null;
    if (!comp.known && comp.reason === "dispute_amount_unknown") review.push("dispute_open");
    // Дата коригування (R2): лише факти, новіші за останню чинну подію поточного партнера (старі вже враховано);
    // рішення про атрибуцію після неї — теж «подія» (§3.3).
    // Визнане замовлення: сторновані події нижче проводяться повторно (знову чинні) — враховуються й вони.
    let since: string | null = null;
    for (const e of allEvents) if ((e.active || finance.state === "recognized") && e.partnerId === attributed.partnerId) since = maxIsoDate(since, e.recognizedOn);
    if (finance.recognizedAt && since !== null) {
      const recognizedAt = finance.recognizedAt;
      const fresh = (d: string) => d >= since!;
      for (const s of sales) {
        if (s.happenedAt <= recognizedAt) continue;
        const d = businessDate(s.happenedAt);
        if (fresh(d)) lastFactOn = maxIsoDate(lastFactOn, d);
      }
      for (const d of disputes) if (d.decidedOn && d.outcome && fresh(d.decidedOn)) lastFactOn = maxIsoDate(lastFactOn, d.decidedOn);
      // Рішення про атрибуцію: ухвалене цим викликом (автоматика змінила атрибуцію) або рішення власника.
      const decisionIsNew = attr !== (existingAttr ?? null) || attributed.source === "owner";
      if (attributed.decidedAt && decisionIsNew) {
        const decided = businessDate(attributed.decidedAt);
        if (fresh(decided)) lastFactOn = maxIsoDate(lastFactOn, decided);
      }
    }
  }

  // 3. Події й записи журналу.
  let events = 0;
  let entries = 0;
  let reversed = 0;
  let reposted = 0;
  if (finance.state === "excluded") {
    // Замовлення більше не враховується: сторно F2 усіх чинних записів винагороди (дата й fx_on оригіналу).
    const refs = await activeEntryRefs(tx, { orderId, sourceType: "partner_event", categories: ["partner_commission"] });
    if (refs.length > 0) reversed = (await reverseEntries(tx, actor, refs.map((r) => r.id), { reasonCode: "order_excluded", now })).reversed;
  } else if (finance.state === "recognized" && finance.recognizedOn) {
    // Знову враховується: повторне проведення сторнованих подій їхніми датами (покоління ключа, repostEntries).
    const inactive = allEvents.filter((e) => !e.active);
    if (inactive.length > 0) {
      reposted = (await repostEntries(tx, actor, inactive.map((e) => entryOfEvent(e, false)), { now })).inserted;
      for (const e of inactive) e.active = true;
    }
    const live = allEvents.filter((e) => e.active);
    const target: CommissionTarget | null =
      attributed && comp?.known
        ? { partnerId: attributed.partnerId!, currency: comp.currency, commission: comp.commission, base: comp.base, rateBp: attributed.rateBp!, holdDays: attributed.holdDays! }
        : null;
    // Бажана сума невідома (немає даних) або атрибуція неоднозначна — проведене не змінюється.
    const unknownCurrent = attributed && comp && !comp.known ? attributed.partnerId : null;
    const planned =
      attr?.status === "ambiguous"
        ? []
        : planCommissionEvents({
            recognizedOn: finance.recognizedOn,
            target,
            existing: live.map((e) => ({ partnerId: e.partnerId, n: e.n, kind: e.kind, amount: e.amount, currency: e.currency, rateBp: e.rateBp, recognizedOn: e.recognizedOn })),
            lastN: allEvents.reduce((m, e) => Math.max(m, e.n), 0),
            changeDate: lastFactOn ?? today,
            removalDate: attr?.source === "owner" && attr.decidedAt ? businessDate(attr.decidedAt) : today,
          }).filter((p) => p.partnerId !== unknownCurrent);
    if (planned.length > 0) {
      const rows = await tx
        .insert(partnerCommissionEvents)
        .values(
          planned.map((p) => ({
            partnerId: p.partnerId,
            orderId,
            n: p.n,
            kind: p.kind,
            base: p.base,
            rateBp: p.rateBp,
            amount: p.amount,
            currency: p.currency,
            recognizedOn: p.recognizedOn,
            holdUntil: p.holdUntil,
            idempotencyKey: financeKeys.partnerEvent(orderId, p.partnerId, p.n),
          })),
        )
        .onConflictDoNothing({ target: partnerCommissionEvents.idempotencyKey })
        .returning();
      events = rows.length;
      const toPost = rows.map((r) => entryOfEvent({ ...r, active: true }, r.kind === "accrual" && !finance.newlyRecognized));
      if (toPost.length > 0) entries = (await postEntries(tx, actor, toPost, { now })).inserted;
    }
  }

  // 4. Прогноз (лише до визнання).
  await tx.delete(orderFinanceForecasts).where(and(eq(orderFinanceForecasts.orderId, orderId), eq(orderFinanceForecasts.component, "partner")));
  const basis: FinanceBasis | null = comp?.known ? (comp.from === "confirmed" ? "owner_confirmed" : (salesSource ?? "shopify")) : null;
  let hasForecast = false;
  if (finance.state === "open" && attributed && comp?.known && financeRow) {
    await tx.insert(orderFinanceForecasts).values({
      orderId,
      component: "partner",
      currency: comp.currency,
      amount: fromMinor(-toMinorForCurrency(comp.commission, comp.currency)),
      basis: basis ?? "shopify",
      computedAt: now,
    });
    hasForecast = true;
  }

  // 5. Стан складника.
  const component = componentOf({ finance, attr, comp, basis, hasForecast });
  return {
    attribution: attr ? (attr.status === "attributed" ? "attributed" : attr.status === "ambiguous" ? "ambiguous" : "removed") : "none",
    partnerId: attributed?.partnerId ?? null,
    events,
    entries,
    reversed,
    reposted,
    component,
    review,
  };
}

function componentOf(input: {
  finance: PartnerSyncFinance;
  attr: AttributionRow | null;
  comp: CommissionComputation | null;
  basis: FinanceBasis | null;
  hasForecast: boolean;
}): PartnerComponent {
  const { finance, attr, comp } = input;
  if (finance.state === "excluded" || finance.state === "closed_unrecognized") return { state: "not_applicable", reason: null, basis: null, hasForecast: false, required: false };
  if (!attr || attr.status === "removed") return NOT_APPLICABLE;
  if (attr.status === "ambiguous") return { state: "missing", reason: "ambiguous_partner", basis: null, hasForecast: false, required: true };
  if (!comp || !comp.known) {
    // Немає продажів / суми програного спору ще немає — очікуємо дані (Shopify або власника); інша валюта спору — курс.
    const reason: ComponentReason =
      !comp || comp.reason === "no_sales" || comp.reason === "dispute_amount_unknown" ? "awaiting_shopify" : comp.reason === "dispute_currency" ? "no_rate" : "order_unreadable";
    return { state: "missing", reason, basis: null, hasForecast: false, required: true };
  }
  if (finance.state === "open") return { state: "forecast", reason: null, basis: input.basis, hasForecast: input.hasForecast, required: true };
  return { state: "actual", reason: null, basis: input.basis, hasForecast: false, required: true };
}

async function hasActiveReferralCodes(tx: Tx): Promise<boolean> {
  const [row] = await tx
    .select({ id: partnerCodes.id })
    .from(partnerCodes)
    .innerJoin(partners, eq(partners.id, partnerCodes.partnerId))
    .where(and(eq(partnerCodes.source, "referral"), eq(partnerCodes.active, true), eq(partners.status, "active")))
    .limit(1);
  return Boolean(row);
}

/** Код партнера зі станом (активний код, статус партнера) — для рішення про придатність. */
interface CodeRow extends CandidateCode {
  active: boolean;
  partnerStatus: PartnerStatus;
}

/** Усі коди (будь-якого стану) серед нормалізованих кодів замовлення (усі джерела). */
async function codesMatching(tx: Tx, norms: readonly string[]): Promise<CodeRow[]> {
  if (norms.length === 0) return [];
  const rows = await tx
    .select({
      id: partnerCodes.id,
      partnerId: partnerCodes.partnerId,
      source: partnerCodes.source,
      codeNorm: partnerCodes.codeNorm,
      validFrom: partnerCodes.validFrom,
      validTo: partnerCodes.validTo,
      active: partnerCodes.active,
      partnerStatus: partners.status,
    })
    .from(partnerCodes)
    .innerJoin(partners, eq(partners.id, partnerCodes.partnerId))
    .where(inArray(partnerCodes.codeNorm, [...norms]));
  return rows.map((r) => ({ ...r, source: r.source as PartnerCodeSource }));
}

/** Коди, які автоматика «заблокувала» для замовлення (непридатні на момент рішення). */
function blockedCodeIdsOf(row: AttributionRow | null): string[] {
  if (!row || row.source === "owner" || row.status !== "removed") return [];
  const ids = (row.details as { blockedCodeIds?: unknown }).blockedCodeIds;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string") : [];
}

/** Ставка й дні утримання партнера на дату замовлення (фіксуються в атрибуції). */
export async function partnerTermsOn(tx: Tx, partnerId: string, codeId: string | null, placedOn: string, defaultRateBp: number): Promise<{ rateBp: number; holdDays: number } | null> {
  const [partner] = await tx.select({ holdDays: partners.holdDays }).from(partners).where(eq(partners.id, partnerId));
  if (!partner) return null;
  const rates = await tx.select({ codeId: partnerRates.codeId, rateBp: partnerRates.rateBp, effectiveFrom: partnerRates.effectiveFrom }).from(partnerRates).where(eq(partnerRates.partnerId, partnerId));
  return { rateBp: rateOn(rates, codeId, placedOn) ?? defaultRateBp, holdDays: partner.holdDays };
}

async function settleAttribution(
  tx: Tx,
  input: {
    orderId: string;
    placedOn: string;
    excludedTest: boolean;
    existing: AttributionRow | null;
    hasEventsFor: (partnerId: string) => boolean;
    discountCodes: readonly string[];
    referralCode: string | null;
    defaultRateBp: number;
    now: Date;
  },
): Promise<AttributionRow | null> {
  const ex = input.existing;
  // Ручне рішення власника не перезаписується; нарахована автоматична атрибуція фіксується.
  if (ex && ex.source === "owner") {
    await autoResolveDiscrepancy(tx, SYSTEM_ACTOR, ambiguityKey(input.orderId));
    return ex;
  }
  if (ex && ex.status === "attributed" && ex.partnerId && input.hasEventsFor(ex.partnerId)) return ex;
  const discountNorms = normalizeOrderCodes(input.discountCodes);
  const refNorm = normalizeCode(input.referralCode);
  const all = await codesMatching(tx, [...new Set([...discountNorms, ...(refNorm ? [refNorm] : [])])]);
  // Придатні для рішення: активний код активного партнера; код чинної автоматичної атрибуції — завжди (фіксація:
  // пізніше вимкнення коду / пауза партнера її не знімають); коди, «заблоковані» попереднім рішенням, — ніколи.
  const frozenCodeId = ex && ex.status === "attributed" ? ex.codeId : null;
  const blockedBefore = blockedCodeIdsOf(ex);
  const usable = all.filter((c) => !blockedBefore.includes(c.id) && (c.id === frozenCodeId || (c.active && c.partnerStatus === "active")));
  const decision: AttributionDecision = resolveAttribution({
    discountCodes: input.discountCodes,
    referralCode: input.referralCode,
    placedOn: input.placedOn,
    excludedTest: input.excludedTest,
    codes: usable,
  });
  if (decision.status === "attributed") {
    await autoResolveDiscrepancy(tx, SYSTEM_ACTOR, ambiguityKey(input.orderId));
    // Та сама атрибуція (партнер, код, джерело) — ставка й дні утримання зафіксовані на дату рішення (§9.1).
    if (ex && ex.status === "attributed" && ex.partnerId === decision.partnerId && ex.codeId === decision.codeId && ex.source === decision.source) return ex;
    const terms = await partnerTermsOn(tx, decision.partnerId, decision.codeId, input.placedOn, input.defaultRateBp);
    if (!terms) return ex;
    return upsertAttribution(tx, input.orderId, {
      partnerId: decision.partnerId,
      codeId: decision.codeId,
      source: decision.source,
      rateBp: terms.rateBp,
      holdDays: terms.holdDays,
      status: "attributed",
      details: {},
      decidedBy: null,
      decidedAt: input.now,
      reason: null,
    });
  }
  if (decision.status === "ambiguous") {
    const details = { partnerIds: decision.partnerIds, codeIds: decision.codeIds };
    // Повторно відкривається лише розбіжність, яку закрила система (умова зникала) або вибір партнера, від якого власник
    // відмовився («повернути автоматичну»); «Ігнорувати» та інші рішення власника не перекриваються.
    const [prev] = await tx
      .select({ status: financeDiscrepancies.status, resolutionCode: financeDiscrepancies.resolutionCode })
      .from(financeDiscrepancies)
      .where(eq(financeDiscrepancies.dedupeKey, ambiguityKey(input.orderId)));
    const reopenable = !prev || prev.status === "open" || (prev.status === "resolved" && (prev.resolutionCode === "auto_resolved" || prev.resolutionCode === "partner_chosen"));
    if (reopenable) {
      await openDiscrepancy(tx, SYSTEM_ACTOR, {
        type: "partner_attribution_ambiguous",
        dedupeKey: ambiguityKey(input.orderId),
        orderId: input.orderId,
        details: { partnerIds: decision.partnerIds, candidates: decision.partnerIds.length },
        reopen: Boolean(prev),
      });
    }
    const same = ex && ex.status === "ambiguous" && JSON.stringify(ex.details) === JSON.stringify(details);
    if (same) return ex;
    return upsertAttribution(tx, input.orderId, {
      partnerId: null,
      codeId: null,
      source: decision.source,
      rateBp: null,
      holdDays: null,
      status: "ambiguous",
      details,
      decidedBy: null,
      decidedAt: input.now,
      reason: null,
    });
  }
  await autoResolveDiscrepancy(tx, SYSTEM_ACTOR, ambiguityKey(input.orderId));
  // Код замовлення збігся з кодом партнера, але непридатний (вимкнений / партнер на паузі чи в архіві): фіксуємо
  // «не атрибутовано», щоб пізніша активація не приписала партнеру замовлення, оформлене без чинного коду.
  const matches = (c: CodeRow) => (c.source === "discount_code" ? discountNorms.includes(c.codeNorm) : c.source === "referral" && refNorm !== "" && c.codeNorm === refNorm);
  const blocked =
    decision.reason === "test_order" ? [] : all.filter((c) => !usable.includes(c) && isCodeValidOn(c, input.placedOn) && matches(c)).sort((x, y) => (x.id < y.id ? -1 : 1));
  if (blocked.length > 0) {
    const details = { autoReason: blocked.some((c) => !c.active) ? "code_inactive" : "partner_inactive", blockedCodeIds: blocked.map((c) => c.id) };
    if (ex && ex.status === "removed" && JSON.stringify(ex.details) === JSON.stringify(details)) return ex;
    return upsertAttribution(tx, input.orderId, {
      partnerId: null,
      codeId: null,
      source: blocked[0]!.source,
      rateBp: null,
      holdDays: null,
      status: "removed",
      details,
      decidedBy: null,
      decidedAt: input.now,
      reason: null,
    });
  }
  if (!ex || (ex.status === "removed" && blockedBefore.length === 0)) return ex;
  // Автоматична атрибуція без нарахувань зникла (коди замовлення змінено / тестове замовлення) — позначка «знято системою».
  return upsertAttribution(tx, input.orderId, {
    partnerId: null,
    codeId: null,
    source: ex.source,
    rateBp: null,
    holdDays: null,
    status: "removed",
    details: { autoReason: decision.reason },
    decidedBy: null,
    decidedAt: input.now,
    reason: null,
  });
}

async function upsertAttribution(
  tx: Tx,
  orderId: string,
  values: Omit<typeof partnerAttributions.$inferInsert, "orderId" | "storeId">,
): Promise<AttributionRow> {
  const [row] = await tx
    .insert(partnerAttributions)
    .values({ orderId, ...values })
    .onConflictDoUpdate({ target: partnerAttributions.orderId, set: { ...values } })
    .returning();
  return row!;
}

/**
 * Замовлення, у яких є нормалізований код (код знижки серед Order.discountCodes або реферальний) і немає ручного
 * рішення власника — для повторної атрибуції після додавання коду (найновіші першими, не більше limit).
 */
export async function ordersWithCode(tx: Tx, source: PartnerCodeSource, codeNorm: string, limit = 500): Promise<string[]> {
  const match =
    source === "discount_code"
      ? sql`exists (select 1 from unnest(${orderShopifyFinance.discountCodes}) as c(code) where upper(btrim(c.code)) = ${codeNorm})`
      : sql`upper(btrim(${orderShopifyFinance.referralCode})) = ${codeNorm}`;
  const rows = await tx
    .select({ orderId: orderShopifyFinance.orderId })
    .from(orderShopifyFinance)
    .innerJoin(orders, eq(orders.id, orderShopifyFinance.orderId))
    .leftJoin(partnerAttributions, eq(partnerAttributions.orderId, orderShopifyFinance.orderId))
    .where(and(match, sql`(${partnerAttributions.source} is null or ${partnerAttributions.source} <> 'owner')`))
    .orderBy(sql`${orders.placedAt} desc`)
    .limit(limit);
  return rows.map((r) => r.orderId).sort();
}

/**
 * Чисті правила синхронізації залишків із Shopify (docs/stage5-design.md §10). Без БД і мережі — для тестів.
 */
import { BUSINESS_TIME_ZONE } from "~/lib/format";
import type { MovementType } from "~/modules/inventory/movement-types";
import {
  ADJUST_ERROR,
  type GqlAdjustUserError,
  type GqlLocation,
  type ShopifyAdjustReason,
  type ShopifyLevelQuantities,
} from "~/integrations/shopify/inventory-graphql";

// ---------------------------------------------------------------------------
// Ключі ідемпотентності Shopify (@idempotent) і посилання
// ---------------------------------------------------------------------------

/** Ключ передачі руху: один рух — одна спроба-намір, тож повтор завдання не застосує дельту двічі. */
export function pushIdempotencyKey(movementId: string): string {
  return `ot-mv-${movementId}`;
}

/**
 * Ключ «надіслати значення складу» для розбіжності: свій для кожного спостереження (observationSeq), бо
 * changeFromQuantity змінюється разом зі спостереженням (той самий ключ з іншими параметрами Shopify відхиляє).
 */
export function conflictPushKey(conflictId: string, observationSeq: number): string {
  return `ot-cf-${conflictId}-${observationSeq}`;
}

/**
 * Shopify пам'ятає ключ 24 год від першого запиту. Рух, створений понад 23 год тому й досі не підтверджений,
 * НЕ надсилається: повтор після вікна вважався б новою операцією (подвійна дельта). Такий рух → failed (звірка).
 */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

export function isOutsideIdempotencyWindow(createdAt: Date, now: Date): boolean {
  return now.getTime() - createdAt.getTime() > IDEMPOTENCY_WINDOW_MS;
}

/** Причина Shopify для внутрішнього руху (лише задокументовані значення). */
export function shopifyReasonFor(type: MovementType, reason: string | null): ShopifyAdjustReason {
  switch (type) {
    case "receipt_production":
    case "receipt_manual":
      return "received";
    case "adjustment":
      return reason === "stocktake" ? "cycle_count_available" : "correction";
    case "defect_mark":
      return "damaged";
    case "transfer_in":
    case "transfer_out":
      return "other";
    default:
      return "correction";
  }
}

function appOrigin(appUrl: string | null | undefined): string | null {
  if (!appUrl) return null;
  try {
    const url = new URL(appUrl);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

const kyivDate = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export interface MovementRef {
  id: string;
  stockItemId: string;
  type: MovementType | string;
  createdAt: Date;
}

/**
 * referenceDocumentUri руху: посилання на журнал руху застосунку (не gid://shopify), звужене фільтрами, які журнал
 * розуміє (позиція, тип, день за Києвом) — зазвичай рівно один рядок; `movement` — id руху (ідентифікатор документа).
 * null — адреса застосунку невідома або не https.
 */
export function movementReferenceUri(appUrl: string | null | undefined, m: MovementRef): string | null {
  const origin = appOrigin(appUrl);
  if (!origin) return null;
  const day = kyivDate.format(m.createdAt);
  const params = new URLSearchParams({ item: m.stockItemId, type: String(m.type), from: day, to: day, movement: m.id });
  return `${origin}/app/warehouse/movements?${params.toString()}`;
}

/** referenceDocumentUri для «надіслати значення складу»: посилання на розбіжність (сторінка «Склад → Shopify» фільтрує за нею). */
export function conflictReferenceUri(appUrl: string | null | undefined, conflictId: string): string | null {
  const origin = appOrigin(appUrl);
  return origin ? `${origin}/app/warehouse/shopify?conflict=${encodeURIComponent(conflictId)}` : null;
}

// ---------------------------------------------------------------------------
// Класифікація помилок мутації
// ---------------------------------------------------------------------------

/** Тимчасові: повтор із ТИМ САМИМ ключем безпечний (успіх → кешована відповідь, збій → PREVIOUS_ATTEMPT_FAILED). */
const RETRY_SAME_KEY = new Set<string>([ADJUST_ERROR.concurrent, ADJUST_ERROR.tryAgain, ADJUST_ERROR.unavailable]);

export type AdjustErrorClass = { kind: "retry"; code: string } | { kind: "failed"; code: string; field: string | null };

export function classifyAdjustErrors(errors: readonly GqlAdjustUserError[]): AdjustErrorClass | null {
  if (errors.length === 0) return null;
  const codes = errors.map((e) => e.code ?? "UNKNOWN");
  if (codes.every((c) => RETRY_SAME_KEY.has(c))) return { kind: "retry", code: codes[0]! };
  const first = errors.find((e) => !RETRY_SAME_KEY.has(e.code ?? "UNKNOWN")) ?? errors[0]!;
  return { kind: "failed", code: first.code ?? "UNKNOWN", field: first.field?.join(".") ?? null };
}

// ---------------------------------------------------------------------------
// Вибір локації
// ---------------------------------------------------------------------------

export type LocationPick =
  | { kind: "single"; location: GqlLocation }
  | { kind: "ambiguous"; candidates: GqlLocation[] }
  | { kind: "none" };

/**
 * Локація складу Shopify: лише однозначна — єдина активна локація магазину (не fulfillment-сервісу).
 * Кілька локацій → вибір власника (неправильна локація = зміна залишку не там).
 */
export function pickLocation(nodes: readonly GqlLocation[], hasMore: boolean): LocationPick {
  const candidates = nodes.filter((l) => l.isActive && !l.isFulfillmentService);
  if (candidates.length === 0) return hasMore ? { kind: "ambiguous", candidates: [] } : { kind: "none" };
  if (candidates.length === 1 && !hasMore) return { kind: "single", location: candidates[0]! };
  return { kind: "ambiguous", candidates };
}

// ---------------------------------------------------------------------------
// Порівняння залишків
// ---------------------------------------------------------------------------

/**
 * Відомі з даних застосунку причини різниці committed/on_hand, що НЕ змінюють «доступно»:
 * inFlight — передано перевізнику (у застосунку списано), але в Shopify замовлення ще не виконано (committed і on_hand
 * Shopify ще містять ці одиниці); fulfilledOutside — виконано в Shopify, а в застосунку ще зарезервовано.
 * uncertain — частково виконані замовлення або повернення (Shopify міг поповнити залишок до того, як склад оприбуткував
 * повернення): розподіл одиниць невідомий (автоприйняття вимкнено). returnsPending — повернені/відшкодовані після
 * відправлення одиниці, яких склад ще не оприбуткував як повернення покупця.
 */
export interface FulfillmentTiming {
  inFlight: number;
  fulfilledOutside: number;
  uncertain: boolean;
  returnsPending?: number;
}

export interface AppLevel {
  onHand: number;
  reserved: number;
}

export interface LevelComparison {
  appOnHand: number;
  appReserved: number;
  appAvailable: number;
  shopifyAvailable: number;
  shopifyOnHand: number;
  shopifyCommitted: number;
  /** Shopify «доступно» − «доступно» застосунку. */
  diff: number;
  /**
   * Очікувана різниця (пояснена замовленнями): −committedNotReserved (Shopify закріпив одиниці, яких застосунок не
   * резервує, — «доступно» Shopify менше) + частина reservationExcess, яку Shopify уже звільнив (зміна/скасування
   * замовлення ще не застосовані в застосунку — «доступно» Shopify більше).
   */
  expectedDiff: number;
  committedNotReserved: number;
  /**
   * Застосунок резервує більше, ніж Shopify закріпив (з поправкою на передані/виконані замовлення): Shopify уже звільнив
   * одиниці (замовлення змінено/скасовано в Shopify, а в застосунку — ще ні, напр. через активну накладну) або виконав
   * замовлення, яке застосунок ще не синхронізував. Розподіл між цими причинами — за on_hand (див. compareLevels);
   * будь-який reservationExcess > 0 вимикає автоприйняття.
   */
  reservationExcess: number;
  /** Shopify on_hand − available − committed: одиниці в станах reserved/damaged/safety_stock/quality_control Shopify. */
  shopifyOtherStates: number;
  inFlight: number;
  fulfilledOutside: number;
  uncertain: boolean;
  /** Повернені/відшкодовані після відправлення одиниці, яких склад ще не оприбуткував (див. FulfillmentTiming). */
  returnsPending: number;
}

/**
 * Порівняння. Позначення: S — Shopify, A — застосунок, t = inFlight − fulfilledOutside, raw = S.committed − A.reserved − t.
 * raw > 0 — Shopify закріпив одиниці, яких застосунок не резервує (committedNotReserved = raw, очікувано −raw).
 * raw < 0 — застосунок резервує більше (reservationExcess = −raw). Якщо on_hand узгоджений (S.available + S.committed =
 * A.on_hand + t), Shopify звільнив ці одиниці → очікувано +reservationExcess («доступно» Shopify більше); якщо on_hand
 * Shopify менший — Shopify виконав замовлення раніше, ніж застосунок це побачив → «доступно» однакове (очікувано 0).
 * Непояснена частина (diff − expectedDiff) — розбіжність фізичного залишку: S.available + S.committed − (A.on_hand + t)
 * (+ частина reservationExcess, віднесена до виконання в Shopify).
 */
export function compareLevels(shopify: ShopifyLevelQuantities, app: AppLevel, timing: FulfillmentTiming): LevelComparison {
  const appAvailable = app.onHand - app.reserved;
  const diff = shopify.available - appAvailable;
  const timingAdj = timing.inFlight - timing.fulfilledOutside;
  const raw = shopify.committed - app.reserved - timingAdj;
  const committedNotReserved = Math.max(0, raw);
  const reservationExcess = Math.max(0, -raw);
  const onHandGap = shopify.available + shopify.committed - (app.onHand + timingAdj);
  const fulfilledFirst = Math.min(reservationExcess, Math.max(0, -onHandGap));
  const releasedFirst = reservationExcess - fulfilledFirst;
  const expectedDiff = releasedFirst - committedNotReserved;
  return {
    appOnHand: app.onHand,
    appReserved: app.reserved,
    appAvailable,
    shopifyAvailable: shopify.available,
    shopifyOnHand: shopify.onHand,
    shopifyCommitted: shopify.committed,
    diff,
    expectedDiff: expectedDiff === 0 ? 0 : expectedDiff,
    committedNotReserved,
    reservationExcess,
    shopifyOtherStates: shopify.onHand - shopify.available - shopify.committed,
    inFlight: timing.inFlight,
    fulfilledOutside: timing.fulfilledOutside,
    uncertain: timing.uncertain,
    returnsPending: timing.returnsPending ?? 0,
  };
}

/**
 * match — однаково; explained — різниця повністю пояснена (expectedDiff); conflict — розбіжність.
 * diff = 0 при expectedDiff ≠ 0 — РОЗБІЖНІСТЬ: Shopify закріпив одиниці, яких застосунок не резервує, тож його
 * «доступно» мало б бути меншим; рівність означає, що в Shopify на |expectedDiff| одиниць більше, ніж очікується
 * (напр. туди не дійшла внутрішня зміна).
 */
export type ReconcileVerdict = "match" | "explained" | "conflict";

export function verdictOf(c: Pick<LevelComparison, "diff" | "expectedDiff">): ReconcileVerdict {
  if (c.diff === c.expectedDiff) return c.diff === 0 ? "match" : "explained";
  return "conflict";
}

/**
 * Непояснена частина різниці (diff − expectedDiff) — саме її розв'язують дії власника: «прийняти Shopify»
 * (on_hand += непояснене) і «надіслати склад» (available −= непояснене). Пояснену частину (одиниці, закріплені Shopify
 * під неоплачені/ще не синхронізовані замовлення) не чіпаємо: вона зникне сама, коли замовлення оплатять або скасують.
 */
export function unexplainedDiff(c: Pick<LevelComparison, "diff" | "expectedDiff">): number {
  return c.diff - c.expectedDiff;
}

/** Походження розбіжності з ініціалізації обліку (внутрішні зміни до запуску обліку). */
export const OPENING_HISTORY_ORIGIN = "opened_with_internal_history";

/**
 * Причини, з яких автоприйняття значення Shopify (externalShopifyChanges = apply) НЕ виконується — різниця має інше
 * можливе пояснення, ніж зміна, зроблена в Shopify:
 * - explained_part — частину різниці пояснюють замовлення (expectedDiff ≠ 0);
 * - uncertain — частково виконані замовлення / повернення, не оприбутковані складом;
 * - reservation_excess — застосунок резервує більше, ніж закріпив Shopify (замовлення змінено/скасовано/виконано
 *   в Shopify, а в застосунку — ще ні);
 * - other_states — у Shopify є одиниці в станах reserved/damaged/safety_stock/quality_control (переміщення між станами
 *   змінює «доступно», але не on_hand: прийняття «зменшило» б фізичний залишок);
 * - failed_pushes — невдалі передачі (Shopify, імовірно, їх не отримав);
 * - unsent_movements — внутрішні зміни on_hand, яких Shopify не отримав від останнього узгодження (передачу вимкнено,
 *   немає дозволу, повернення, рухи до відкриття, відхилені невдалі передачі): прийняття скасувало б їх;
 * - opening_history — розбіжність із запуску обліку (внутрішня історія до відкриття — лише рішення власника);
 * - push_pending — результат «надіслати склад» ще невідомий (тайм-аут / обробляється).
 */
export const AUTO_APPLY_BLOCKERS = [
  "explained_part",
  "uncertain",
  "reservation_excess",
  "other_states",
  "failed_pushes",
  "unsent_movements",
  "opening_history",
  "push_pending",
] as const;
export type AutoApplyBlocker = (typeof AUTO_APPLY_BLOCKERS)[number];

export interface AutoApplyContext {
  failedPushes: number;
  /** Сума on_hand неотриманих Shopify внутрішніх рухів від останнього узгодження (unsentSinceAgreement). */
  unsentDelta: number;
  origin?: string | null;
  pushPending?: boolean;
}

export function autoApplyBlockers(
  c: Pick<LevelComparison, "expectedDiff" | "uncertain" | "reservationExcess" | "shopifyOtherStates">,
  ctx: AutoApplyContext,
): AutoApplyBlocker[] {
  const out: AutoApplyBlocker[] = [];
  if (c.expectedDiff !== 0) out.push("explained_part");
  if (c.uncertain) out.push("uncertain");
  if (c.reservationExcess !== 0) out.push("reservation_excess");
  if (c.shopifyOtherStates !== 0) out.push("other_states");
  if (ctx.failedPushes > 0) out.push("failed_pushes");
  if (ctx.unsentDelta !== 0) out.push("unsent_movements");
  if (ctx.origin === OPENING_HISTORY_ORIGIN) out.push("opening_history");
  if (ctx.pushPending) out.push("push_pending");
  return out;
}

/** Автоматичне прийняття значення Shopify — лише коли різниця не має інших пояснень (autoApplyBlockers порожній). */
export function canAutoApply(
  c: Pick<LevelComparison, "expectedDiff" | "uncertain" | "reservationExcess" | "shopifyOtherStates">,
  ctx: AutoApplyContext,
): boolean {
  return autoApplyBlockers(c, ctx).length === 0;
}

/**
 * Автоприйняття діє, лише коли зміни складу надсилаються в Shopify (shopifyPush = deltas) і є дозвіл write_inventory.
 * Інакше кожна внутрішня зміна лишається поза Shopify, і різниця майже завжди має інше пояснення — розгляд власником.
 */
export function autoApplyEffective(env: { externalMode: "review" | "apply"; pushMode: "off" | "deltas"; canWrite: boolean }): boolean {
  return env.externalMode === "apply" && env.pushMode === "deltas" && env.canWrite;
}

/**
 * «Надіслати склад» змінює available дельтою, а Shopify змінює on_hand на ту саму дельту. Якщо частина одиниць Shopify
 * у станах reserved/damaged/safety_stock/quality_control, збільшення available додало б on_hand понад фізичний залишок
 * (і продаж одиниць, які Shopify вважає непридатними). Такі одиниці власник звільняє в Shopify або позначає брак на складі.
 */
export function pushBlockedByOtherStates(c: Pick<LevelComparison, "shopifyOtherStates" | "diff" | "expectedDiff">): boolean {
  return c.shopifyOtherStates > 0 && -unexplainedDiff(c) > 0;
}

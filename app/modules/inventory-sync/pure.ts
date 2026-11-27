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
 * withReturns — варіант із поверненнями, які Shopify мав поповнити сам (інша дельта того самого спостереження, див.
 * pushPlan): окремий ключ, бо той самий ключ з іншою дельтою Shopify відхилив би як IDEMPOTENCY_KEY_PARAMETER_MISMATCH,
 * а попередня спроба могла бути застосована. Подвійного застосування не буде: обидва варіанти мають CAS
 * changeFromQuantity = те саме побачене значення Shopify.
 */
export function conflictPushKey(conflictId: string, observationSeq: number, withReturns = false): string {
  return `ot-cf-${conflictId}-${observationSeq}${withReturns ? "-r" : ""}`;
}

/**
 * Shopify пам'ятає ключ 24 год від першого запиту. Рух, створений понад 23 год тому й досі не підтверджений,
 * НЕ надсилається: повтор після вікна вважався б новою операцією (подвійна дельта). Такий рух → failed (звірка).
 */
export const IDEMPOTENCY_WINDOW_MS = 23 * 60 * 60 * 1000;

/** Спроба «надіслати склад» із невідомим результатом вважається можливою, поки Shopify пам'ятає її ключ (24 год). */
export const PUSH_ATTEMPT_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Після «надіслати склад» із невідомим результатом «прийняти Shopify» недоступне, поки спостереження те саме, і ще
 * PUSH_SETTLE_MS після спроби навіть зі свіжою звіркою (запит міг ще оброблятися, коли звірка читала Shopify).
 */
export const PUSH_SETTLE_MS = 5 * 60 * 1000;

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
 * uncertain — частково виконані замовлення (крім виконання лише позицій без доставки), повернення (Shopify міг поповнити
 * залишок до того, як склад оприбуткував повернення) або резерви відкритих замовлень із неперенесеними змінами позицій
 * Shopify (orders.shopify_lines_pending_at: резерв застосунку — за старими позиціями, committed Shopify — за новими):
 * розподіл одиниць невідомий (автоприйняття вимкнено). returnsPending — повернені/відшкодовані після
 * відправлення одиниці, яких склад ще не оприбуткував як повернення покупця (від останнього узгодження).
 * returnsAwaiting — навпаки: склад оприбуткував повернення покупця (Shopify поповнює сам), а відшкодування з
 * поверненням на склад у Shopify ще немає — Shopify має додати ці одиниці сам (returns.server.ts).
 * partiallyFulfilled / linesPending — окремі причини uncertain (для пояснення власнику, яку саме перевірку зробити):
 * частково виконані (або старі «restocked») замовлення / резерви відкритих замовлень із неперенесеними змінами позицій
 * Shopify. uncertain = partiallyFulfilled || linesPending || returnsPending > 0 (orderTiming/fulfillmentTiming);
 * не передано — невідомо (старі спостереження).
 */
export interface FulfillmentTiming {
  inFlight: number;
  fulfilledOutside: number;
  uncertain: boolean;
  partiallyFulfilled?: boolean;
  linesPending?: boolean;
  returnsPending?: number;
  returnsAwaiting?: number;
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
  /**
   * Причини uncertain (див. FulfillmentTiming): частково виконані замовлення / резерви відкритих замовлень із
   * неперенесеними змінами позицій Shopify. compareLevels задає завжди; у спостереженнях, збережених до появи полів
   * (inventory_conflicts.details), їх немає — причина невідома.
   */
  partiallyFulfilled?: boolean;
  linesPending?: boolean;
  /** Повернені/відшкодовані після відправлення одиниці, яких склад ще не оприбуткував (див. FulfillmentTiming). */
  returnsPending: number;
  /** Оприбутковані складом повернення, які Shopify ще має поповнити сам (див. FulfillmentTiming). */
  returnsAwaiting: number;
}

/**
 * Порівняння. Позначення: S — Shopify, A — застосунок, t = inFlight − fulfilledOutside, raw = S.committed − A.reserved − t.
 * raw > 0 — Shopify закріпив одиниці, яких застосунок не резервує (committedNotReserved = raw, очікувано −raw).
 * raw < 0 — застосунок резервує більше (reservationExcess = −raw). Розподіл — за on_hand Shopify (S.on_hand = A.on_hand + t,
 * якщо фізичний залишок узгоджений; стани reserved/damaged/… on_hand не змінюють, тож їх тут не враховано):
 * on_hand Shopify менший — Shopify виконав замовлення раніше, ніж застосунок це побачив → «доступно» однакове
 * (fulfilledFirst, очікувано 0); решта — Shopify звільнив одиниці (замовлення змінено/скасовано) → очікувано
 * +releasedFirst («доступно» Shopify більше). Звільнити Shopify міг лише одиниці, які застосунок резервує й Shopify ще
 * закріплює (A.reserved − fulfilledOutside): передані перевізнику одиниці, яких Shopify не закріплює, — це виконання
 * (у застосунку ще не оновлене), а не звільнення. Непояснена частина решти reservationExcess лишається в unexplained.
 * Непояснена частина (diff − expectedDiff) — розбіжність фізичного залишку: S.on_hand − (A.on_hand + t), стани Shopify
 * reserved/damaged/… (−shopifyOtherStates) і частина reservationExcess, віднесена до виконання в Shopify.
 */
export function compareLevels(shopify: ShopifyLevelQuantities, app: AppLevel, timing: FulfillmentTiming): LevelComparison {
  const appAvailable = app.onHand - app.reserved;
  const diff = shopify.available - appAvailable;
  const timingAdj = timing.inFlight - timing.fulfilledOutside;
  const raw = shopify.committed - app.reserved - timingAdj;
  const committedNotReserved = Math.max(0, raw);
  const reservationExcess = Math.max(0, -raw);
  const onHandGap = shopify.onHand - (app.onHand + timingAdj);
  const fulfilledFirst = Math.min(reservationExcess, Math.max(0, -onHandGap));
  const releasable = Math.max(0, app.reserved - timing.fulfilledOutside);
  const releasedFirst = Math.min(reservationExcess - fulfilledFirst, releasable);
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
    partiallyFulfilled: timing.partiallyFulfilled ?? false,
    linesPending: timing.linesPending ?? false,
    returnsPending: timing.returnsPending ?? 0,
    returnsAwaiting: timing.returnsAwaiting ?? 0,
  };
}

/**
 * Чи узгоджує збіг/пояснена різниця докази (невдалі передачі → pushed, точка узгодження неотриманих рухів і повернень).
 * Точний збіг (diff = 0, expectedDiff = 0) — так, навіть із невизначеністю повернень/часткових виконань: «доступно»
 * Shopify і складу однакові, і committed Shopify = резерв + передане (інакше expectedDiff ≠ 0), — без цього правила
 * відшкодування без повернення на склад блокувало б докази до 60 днів. Але НЕ при reservationExcess > 0: тоді збіг може
 * бути випадковим (звільнені Shopify одиниці замовлення «покривають» неотримане надходження). Пояснена різниця
 * (diff = expectedDiff ≠ 0) — лише без невизначеності.
 */
export function settlesEvidence(
  c: Pick<LevelComparison, "diff" | "expectedDiff" | "reservationExcess" | "uncertain" | "returnsAwaiting">,
): boolean {
  if (c.diff !== c.expectedDiff || c.reservationExcess !== 0) return false;
  if (c.diff === 0) return true;
  return !c.uncertain && c.returnsAwaiting === 0;
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
 * - uncertain — частково виконані замовлення / повернення, не оприбутковані складом / неперенесені зміни позицій Shopify
 *   у відкритих замовленнях із резервом (резерв застосунку застарів щодо committed Shopify);
 * - reservation_excess — застосунок резервує більше, ніж закріпив Shopify (замовлення змінено/скасовано/виконано
 *   в Shopify, а в застосунку — ще ні);
 * - other_states — у Shopify є одиниці в станах reserved/damaged/safety_stock/quality_control (переміщення між станами
 *   змінює «доступно», але не on_hand: прийняття «зменшило» б фізичний залишок);
 * - failed_pushes — невдалі передачі (Shopify, імовірно, їх не отримав);
 * - unsent_movements — внутрішні зміни on_hand, яких Shopify не отримав від останнього узгодження (передачу вимкнено,
 *   немає дозволу, повернення, рухи до відкриття, відхилені невдалі передачі): прийняття скасувало б їх;
 * - opening_history — розбіжність із запуску обліку (внутрішня історія до відкриття — лише рішення власника);
 * - push_pending — результат «надіслати склад» ще невідомий (тайм-аут / обробляється; також після відхилення чи
 *   закриття розбіжності — спроба переноситься в нову розбіжність до 24 год);
 * - awaiting_restock — склад оприбуткував повернення, які Shopify ще має поповнити сам (зміна Shopify може бути саме
 *   цим поповненням або різниця зникне з ним).
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
  "awaiting_restock",
] as const;
export type AutoApplyBlocker = (typeof AUTO_APPLY_BLOCKERS)[number];

export interface AutoApplyContext {
  failedPushes: number;
  /** Сума on_hand неотриманих Shopify внутрішніх рухів від останнього узгодження (unsentSinceAgreement). */
  unsentDelta: number;
  origin?: string | null;
  pushPending?: boolean;
}

type BlockerInput = Pick<LevelComparison, "expectedDiff" | "uncertain" | "reservationExcess" | "shopifyOtherStates"> &
  Partial<Pick<LevelComparison, "returnsAwaiting">>;

export function autoApplyBlockers(c: BlockerInput, ctx: AutoApplyContext): AutoApplyBlocker[] {
  const out: AutoApplyBlocker[] = [];
  if (c.expectedDiff !== 0) out.push("explained_part");
  if (c.uncertain) out.push("uncertain");
  if (c.reservationExcess !== 0) out.push("reservation_excess");
  if (c.shopifyOtherStates !== 0) out.push("other_states");
  if (ctx.failedPushes > 0) out.push("failed_pushes");
  if (ctx.unsentDelta !== 0) out.push("unsent_movements");
  if (ctx.origin === OPENING_HISTORY_ORIGIN) out.push("opening_history");
  if (ctx.pushPending) out.push("push_pending");
  if ((c.returnsAwaiting ?? 0) > 0) out.push("awaiting_restock");
  return out;
}

/** Автоматичне прийняття значення Shopify — лише коли різниця не має інших пояснень (autoApplyBlockers порожній). */
export function canAutoApply(c: BlockerInput, ctx: AutoApplyContext): boolean {
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
 * Що надсилає «Надіслати склад» (available += delta; Shopify змінює on_hand на ту саму дельту).
 * Повна зміна — −unexplained. Збільшення зменшується на:
 * - heldOtherStates — одиниці Shopify у станах reserved/damaged/safety_stock/quality_control: вони вже в on_hand Shopify,
 *   тож їх додавання до available підняло б on_hand понад фізичний залишок (і продаж непридатних). Після надсилання решти
 *   on_hand Shopify = on_hand складу, а різниця «доступно» на ці одиниці лишається (брак → позначити на складі; резерв /
 *   безпечний запас — Shopify тримає їх свідомо);
 * - heldAwaiting — оприбутковані складом повернення, які Shopify поповнить сам (returnsAwaiting): надіслані зараз, вони
 *   після поповнення порахувалися б двічі. includeReturns — власник підтвердив, що Shopify їх не поповнить.
 * Зменшення available надсилається повністю (on_hand Shopify не зростає).
 */
export interface PushPlan {
  /** Повна зміна (−unexplained). */
  full: number;
  /** Зміна, яку буде надіслано. */
  delta: number;
  heldOtherStates: number;
  heldAwaiting: number;
}

export function pushPlan(
  c: Pick<LevelComparison, "shopifyOtherStates" | "diff" | "expectedDiff"> & Partial<Pick<LevelComparison, "returnsAwaiting">>,
  opts: { includeReturns?: boolean } = {},
): PushPlan {
  const full = -unexplainedDiff(c);
  if (full <= 0) return { full, delta: full, heldOtherStates: 0, heldAwaiting: 0 };
  const heldOtherStates = Math.min(full, Math.max(0, c.shopifyOtherStates));
  const awaiting = opts.includeReturns ? 0 : Math.max(0, c.returnsAwaiting ?? 0);
  const heldAwaiting = Math.min(full - heldOtherStates, awaiting);
  return { full, delta: full - heldOtherStates - heldAwaiting, heldOtherStates, heldAwaiting };
}

/** «Надіслати склад» нічого не надіслало б навіть із поверненнями: уся різниця — одиниці в інших станах Shopify. */
export function pushBlockedByOtherStates(c: Pick<LevelComparison, "shopifyOtherStates" | "diff" | "expectedDiff">): boolean {
  const plan = pushPlan(c, { includeReturns: true });
  return plan.full > 0 && plan.delta === 0;
}

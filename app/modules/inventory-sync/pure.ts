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
 * uncertain — частково виконані/повернені замовлення: розподіл за позиціями невідомий (автоприйняття вимкнено).
 */
export interface FulfillmentTiming {
  inFlight: number;
  fulfilledOutside: number;
  uncertain: boolean;
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
   * Очікувана різниця: одиниці, які Shopify закріпив (committed), а застосунок не резервує — неоплачені замовлення
   * (застосунок їх не імпортує), чернетки, ще не синхронізовані замовлення. Shopify «доступно» менше на цю кількість.
   */
  expectedDiff: number;
  committedNotReserved: number;
  /** Shopify on_hand − available − committed: одиниці в станах reserved/damaged/safety_stock/quality_control Shopify. */
  shopifyOtherStates: number;
  inFlight: number;
  fulfilledOutside: number;
  uncertain: boolean;
}

export function compareLevels(shopify: ShopifyLevelQuantities, app: AppLevel, timing: FulfillmentTiming): LevelComparison {
  const appAvailable = app.onHand - app.reserved;
  const diff = shopify.available - appAvailable;
  const committedExcess = shopify.committed - app.reserved;
  const committedNotReserved = Math.max(0, committedExcess - (timing.inFlight - timing.fulfilledOutside));
  return {
    appOnHand: app.onHand,
    appReserved: app.reserved,
    appAvailable,
    shopifyAvailable: shopify.available,
    shopifyOnHand: shopify.onHand,
    shopifyCommitted: shopify.committed,
    diff,
    expectedDiff: committedNotReserved === 0 ? 0 : -committedNotReserved,
    committedNotReserved,
    shopifyOtherStates: shopify.onHand - shopify.available - shopify.committed,
    inFlight: timing.inFlight,
    fulfilledOutside: timing.fulfilledOutside,
    uncertain: timing.uncertain,
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

/**
 * Автоматичне прийняття значення Shopify (externalShopifyChanges = apply) — лише коли різниця не має інших
 * пояснень: немає очікуваної різниці, невдалих передач і невизначеності. Інакше — розгляд власником.
 */
export function canAutoApply(c: Pick<LevelComparison, "expectedDiff" | "uncertain">, failedPushes: number): boolean {
  return c.expectedDiff === 0 && failedPushes === 0 && !c.uncertain;
}

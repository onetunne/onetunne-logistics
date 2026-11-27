/**
 * Спостереження звірки, збережене в inventory_conflicts.details (kind = "reconciliation"). Від нього залежать дії
 * власника: «прийняти Shopify» (on_hand += diff, якщо баланс не змінився — appVersion) і «надіслати значення
 * складу» (changeFromQuantity = shopifyAvailable, ключ за observationSeq).
 * Розбіжності іншого походження (напр. opened_with_internal_history з ініціалізації) спершу звіряються.
 */
import type { LevelComparison } from "./pure";

export interface ConflictObservation extends LevelComparison {
  kind: "reconciliation";
  /** Зростає з кожним оновленням розбіжності звіркою (ключ «надіслати значення складу»). */
  observationSeq: number;
  observedAt: string;
  inventoryItemId: string;
  locationId: string;
  /** inventory_balances.version на момент порівняння (CAS для «прийняти Shopify»/«надіслати склад»). */
  appVersion: number;
  /** Рухи з невдалою передачею (Shopify, імовірно, їх не отримав). */
  failedMovementIds: string[];
  failedDelta: number;
  /**
   * Внутрішні зміни on_hand, яких Shopify не отримав від останнього узгодження (skipped: передачу вимкнено, немає
   * дозволу, повернення покупця, рухи до відкриття, відхилені невдалі передачі) — див. unsent.server.ts.
   * unsentMovementIds — останні з них (для показу, не більше UNSENT_LIST_LIMIT).
   */
  unsentCount: number;
  unsentDelta: number;
  unsentMovementIds: string[];
  /** Причини, з яких автоприйняття не виконано (лише в режимі apply). */
  autoApplyBlockers?: string[];
  /** Спроба «надіслати склад» із невідомим результатом (переноситься в нові спостереження, поки не мине 24 год). */
  pushAttempt?: PushAttempt;
  /** Походження розбіжності до першої звірки (напр. opened_with_internal_history). */
  origin?: string;
  internalOnHand?: number;
  /** Автоприйняття не виконано (напр. on_hand став би від'ємним, а це заборонено налаштуванням). */
  autoApplyBlocked?: string;
}

export interface PushAttempt {
  key: string;
  seq: number;
  at: string;
  by: string;
}

const NUMBER_FIELDS = [
  "observationSeq",
  "appVersion",
  "appOnHand",
  "appReserved",
  "appAvailable",
  "shopifyAvailable",
  "shopifyOnHand",
  "shopifyCommitted",
  "diff",
  "expectedDiff",
  "committedNotReserved",
  "shopifyOtherStates",
  "inFlight",
  "fulfilledOutside",
  "failedDelta",
] as const;

/** Поля, додані пізніше (спостереження, збережені раніше, їх не мають — тоді 0). */
const OPTIONAL_NUMBER_FIELDS = ["reservationExcess", "returnsPending", "unsentCount", "unsentDelta"] as const;

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Спостереження з details або null (інше походження / пошкоджені дані). */
export function parseObservation(details: unknown): ConflictObservation | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (d.kind !== "reconciliation") return null;
  for (const f of NUMBER_FIELDS) if (!isInt(d[f])) return null;
  if (typeof d.inventoryItemId !== "string" || typeof d.locationId !== "string" || typeof d.observedAt !== "string") return null;
  if (!isStringArray(d.failedMovementIds)) return null;
  const extra: Record<string, unknown> = {};
  for (const f of OPTIONAL_NUMBER_FIELDS) {
    if (d[f] === undefined) extra[f] = 0;
    else if (!isInt(d[f])) return null;
  }
  if (d.unsentMovementIds === undefined) extra.unsentMovementIds = [];
  else if (!isStringArray(d.unsentMovementIds)) return null;
  const attempt = parsePushAttempt(d.pushAttempt);
  return { ...(d as unknown as ConflictObservation), ...extra, pushAttempt: attempt ?? undefined };
}

/** Спроба «надіслати склад» із details (null — немає / пошкоджено). */
export function parsePushAttempt(v: unknown): PushAttempt | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.key !== "string" || typeof a.at !== "string" || Number.isNaN(Date.parse(a.at))) return null;
  return { key: a.key, seq: isInt(a.seq) ? a.seq : -1, at: a.at, by: typeof a.by === "string" ? a.by : "" };
}

/** Причина розбіжності для інтерфейсу. */
export function conflictOrigin(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (typeof d.origin === "string") return d.origin;
  if (typeof d.reason === "string") return d.reason;
  return null;
}

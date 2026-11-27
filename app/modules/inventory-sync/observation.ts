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
  /** Походження розбіжності до першої звірки (напр. opened_with_internal_history). */
  origin?: string;
  internalOnHand?: number;
  /** Автоприйняття не виконано (напр. on_hand став би від'ємним, а це заборонено налаштуванням). */
  autoApplyBlocked?: string;
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

/** Спостереження з details або null (інше походження / пошкоджені дані). */
export function parseObservation(details: unknown): ConflictObservation | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (d.kind !== "reconciliation") return null;
  for (const f of NUMBER_FIELDS) if (typeof d[f] !== "number" || !Number.isSafeInteger(d[f])) return null;
  if (typeof d.inventoryItemId !== "string" || typeof d.locationId !== "string" || typeof d.observedAt !== "string") return null;
  if (!Array.isArray(d.failedMovementIds) || !d.failedMovementIds.every((x) => typeof x === "string")) return null;
  return d as unknown as ConflictObservation;
}

/** Причина розбіжності для інтерфейсу. */
export function conflictOrigin(details: unknown): string | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (typeof d.origin === "string") return d.origin;
  if (typeof d.reason === "string") return d.reason;
  return null;
}

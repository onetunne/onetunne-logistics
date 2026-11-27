/**
 * Рівень залишку й попередження складу (чисті функції).
 *
 * - доступно = on_hand − reserved;
 * - out_of_stock — доступно ≤ 0; low_stock — 0 < доступно ≤ поріг (взаємовиключні, щоб не дублювати сповіщення);
 * - oversold — зарезервовано більше, ніж фізично є (reserved > 0 і reserved > on_hand);
 * - negative_on_hand — on_hand < 0 (після фізичної події, коли облік розійшовся з реальністю).
 */
import type { StockAlertKind } from "~/db/schema";

export const STOCK_LEVEL_STATUSES = ["ok", "low", "out", "oversold", "negative"] as const;
export type StockLevelStatus = (typeof STOCK_LEVEL_STATUSES)[number];

export interface LevelInput {
  onHand: number;
  reserved: number;
  threshold: number;
}

export function availableOf(b: { onHand: number; reserved: number }): number {
  return b.onHand - b.reserved;
}

/** Відкриті попередження, які мають бути для цього балансу. */
export function alertKindsFor(b: LevelInput): StockAlertKind[] {
  const available = availableOf(b);
  const kinds: StockAlertKind[] = [];
  if (available <= 0) kinds.push("out_of_stock");
  else if (available <= b.threshold) kinds.push("low_stock");
  if (b.reserved > 0 && b.reserved > b.onHand) kinds.push("oversold");
  if (b.onHand < 0) kinds.push("negative_on_hand");
  return kinds;
}

/** Найважливіший стан для списків і фільтрів: negative > oversold > out > low > ok. */
export function stockLevelStatus(b: LevelInput): StockLevelStatus {
  if (b.onHand < 0) return "negative";
  if (b.reserved > 0 && b.reserved > b.onHand) return "oversold";
  const available = availableOf(b);
  if (available <= 0) return "out";
  if (available <= b.threshold) return "low";
  return "ok";
}

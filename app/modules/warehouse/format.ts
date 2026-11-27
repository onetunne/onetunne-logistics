/**
 * Подання руху залишку для інтерфейсу (чисті функції, без БД): ненульові дельти кошиків, знак числа,
 * ключ підпису причини.
 */
import type { Bucket } from "~/modules/inventory/movement-types";

export interface MovementDeltas {
  onHandDelta: number;
  reservedDelta: number;
  defectiveDelta: number;
  inProductionDelta: number;
}

const ORDER: ReadonlyArray<{ bucket: Bucket; field: keyof MovementDeltas }> = [
  { bucket: "onHand", field: "onHandDelta" },
  { bucket: "reserved", field: "reservedDelta" },
  { bucket: "defective", field: "defectiveDelta" },
  { bucket: "inProduction", field: "inProductionDelta" },
];

/** Ненульові дельти у фіксованому порядку (фактично, резерв, брак, у виробництві). */
export function movementDeltaParts(m: MovementDeltas): Array<{ bucket: Bucket; delta: number }> {
  return ORDER.filter(({ field }) => m[field] !== 0).map(({ bucket, field }) => ({ bucket, delta: m[field] }));
}

/** «+5» / «−3» / «0» (справжній знак мінус для читабельності). */
export function signedNumber(value: number, format: (n: number) => string = String): string {
  if (value > 0) return `+${format(value)}`;
  if (value < 0) return `−${format(-value)}`;
  return format(0);
}

/** Ключ i18n причини руху (warehouse.reason.<код>); невідомий код показується як є. */
export function reasonKey(reason: string | null | undefined): string | null {
  return reason ? `warehouse.reason.${reason}` : null;
}

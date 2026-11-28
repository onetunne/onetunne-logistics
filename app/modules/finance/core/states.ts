/**
 * Етап 6: стани складників, прибутку й повноти (docs/stage6-design.md §2.6). Чисті правила — одне місце для картки
 * замовлення (WP4), агрегатора P&L і панелі (WP8), звітів (WP10).
 *
 * Стан прибутку замовлення: final — усі обов'язкові складники actual / zero_confirmed / not_applicable; incomplete —
 * є складник без значення й без прогнозу (missing або partial, решта якого не має прогнозу); інакше preliminary (є
 * прогноз або розбіжність звірки, але нічого відсутнього). Відсутнє НІКОЛИ не стає 0 (F4).
 */
import { z } from "zod";
import {
  COMPONENT_REASONS,
  COMPONENT_STATES,
  FINANCE_BASES,
  ORDER_COMPONENTS,
  type CompletenessMarker,
  type ComponentReason,
  type ComponentState,
  type FinanceBasis,
  type OrderComponent,
  type ProfitState,
} from "~/domain/finance";

const decimal = z.string().regex(/^-?\d{1,14}\.\d{2}$/);
const currency = z.string().regex(/^[A-Z]{3}$/);

/** Значення складника в order_finance.components (zod — перевіряється при записі й читанні). */
export const componentValueSchema = z
  .object({
    state: z.enum(COMPONENT_STATES),
    /** Причина missing / partial / not_applicable / zero_confirmed. */
    reason: z.enum(COMPONENT_REASONS).nullable().default(null),
    /** Основа значення (показується поруч зі значенням). */
    basis: z.enum(FINANCE_BASES).nullable().default(null),
    /** Чи є прогноз для невідомої частини (order_finance_forecasts). */
    hasForecast: z.boolean().default(false),
    /** Фактичні суми за валютами (Σ записів складника в початкових валютах). */
    actual: z.array(z.object({ currency, amount: decimal })).max(10).default([]),
    /** Обов'язковий для цього замовлення (§2.6). */
    required: z.boolean().default(true),
  })
  .strict();
export type ComponentValue = z.infer<typeof componentValueSchema>;

export const orderComponentsSchema = z.partialRecord(z.enum(ORDER_COMPONENTS), componentValueSchema);
export type OrderComponents = z.infer<typeof orderComponentsSchema>;

/** Розбір components з БД; пошкоджене → null (викликач показує «Немає даних»). */
export function parseOrderComponents(value: unknown): OrderComponents | null {
  const parsed = orderComponentsSchema.safeParse(value ?? {});
  return parsed.success ? parsed.data : null;
}

export const SETTLED_STATES: readonly ComponentState[] = ["actual", "zero_confirmed", "not_applicable"];

export function isSettled(state: ComponentState): boolean {
  return SETTLED_STATES.includes(state);
}

/** Невідоме без прогнозу (робить замовлення incomplete). */
export function isMissingWithoutForecast(c: Pick<ComponentValue, "state" | "hasForecast" | "reason">): boolean {
  if (c.state === "missing") return !c.hasForecast;
  if (c.state === "partial") return c.reason !== "reconciliation_mismatch" && !c.hasForecast;
  return false;
}

/** Стан прибутку замовлення зі складників (лише обов'язкові). Без складників — incomplete. */
export function profitStateOf(components: OrderComponents): Exclude<ProfitState, "n/a"> {
  const required = ORDER_COMPONENTS.map((k) => components[k]).filter((c): c is ComponentValue => Boolean(c && c.required));
  if (required.length === 0) return "incomplete";
  if (required.every((c) => isSettled(c.state))) return "final";
  if (required.some(isMissingWithoutForecast)) return "incomplete";
  return "preliminary";
}

/** Відсутні складники з причинами (для «Чого бракує»). */
export function missingComponents(components: OrderComponents): Array<{ component: OrderComponent; reason: ComponentReason | null }> {
  return ORDER_COMPONENTS.flatMap((k) => {
    const c = components[k];
    return c && c.required && isMissingWithoutForecast(c) ? [{ component: k, reason: c.reason }] : [];
  });
}

/** Складники з прогнозом. */
export function forecastComponents(components: OrderComponents): OrderComponent[] {
  return ORDER_COMPONENTS.filter((k) => {
    const c = components[k];
    return Boolean(c && c.required && !isSettled(c.state) && !isMissingWithoutForecast(c));
  });
}

export function componentBasis(c: ComponentValue | undefined): FinanceBasis | null {
  return c?.basis ?? null;
}

/**
 * Об'єкт повноти — повертається з кожним результатом P&L (§2.6). Кількості й коди; суми без курсу — у початковій валюті.
 */
export interface CompletenessSummary {
  orders: number;
  final: number;
  preliminary: number;
  incomplete: number;
  open: number;
  excluded: number;
  missingByComponent: Partial<Record<OrderComponent, number>>;
  forecastByComponent: Partial<Record<OrderComponent, number>>;
  needsReview: number;
  unconverted: Array<{ currency: string; amount: string; entries: number }>;
  staleRates: number;
  openDiscrepancies: number;
  unknownCostUnitsOnHand: number;
  lateEntries: number;
  closedMonths: string[];
  netProfitEligible: boolean;
}

export function emptyCompleteness(): CompletenessSummary {
  return {
    orders: 0,
    final: 0,
    preliminary: 0,
    incomplete: 0,
    open: 0,
    excluded: 0,
    missingByComponent: {},
    forecastByComponent: {},
    needsReview: 0,
    unconverted: [],
    staleRates: 0,
    openDiscrepancies: 0,
    unknownCostUnitsOnHand: 0,
    lateEntries: 0,
    closedMonths: [],
    netProfitEligible: false,
  };
}

/** Маркер плитки (§2.6): «Повні дані» / «З прогнозом» / «Неповні дані». */
export function completenessMarker(c: Pick<CompletenessSummary, "final" | "preliminary" | "incomplete" | "unconverted">): CompletenessMarker {
  if (c.incomplete > 0 || c.unconverted.length > 0) return "incomplete";
  if (c.preliminary > 0) return "with_forecast";
  return "complete";
}

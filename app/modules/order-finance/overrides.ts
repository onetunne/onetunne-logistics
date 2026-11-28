/**
 * Етап 6, WP4: позначки власника на замовленні (`order_finance.overrides`, docs/stage6-design.md §2.6, §4, §18.4) —
 * чиста схема. Кожна позначка ставиться/знімається лише сервісом власника (finance.manage) з причиною в історії змін
 * (finance_change_log, entity `order_component_override`); у самому JSON — лише прапорець, момент і хто (id), без
 * вільного тексту й персональних даних.
 *
 * - `recipient_pays` «Платить отримувач» / `no_shipping_cost` «Без витрат на доставку» → доставка `not_applicable`;
 * - `fees_zero_confirmed` «Шлюз без комісії» (для цього замовлення) → комісії `zero_confirmed` (owner_confirmed);
 * - `packaging_accounted_in_total` «Упаковку обліковано загальною сумою» (замовлення не пакувалося в застосунку) →
 *   упаковка `not_applicable`;
 * - `confirmed_amounts` «Підтвердити суми замовлення» (замовлення без угод Shopify — замість «Оцінки»): товари й
 *   доставка БЕЗ податків у валюті магазину; версія — у ключі записів `confirm:<orderId>:v<n>:<частина>`.
 */
import { z } from "zod";
import type { OrderOverrideKind } from "~/domain/finance";

const decimal = z.string().regex(/^-?\d{1,12}\.\d{2}$/);
const mark = z.object({ at: z.string().max(40), by: z.string().max(120) }).strict();

export const orderOverridesSchema = z
  .object({
    recipient_pays: mark.optional(),
    no_shipping_cost: mark.optional(),
    fees_zero_confirmed: mark.optional(),
    packaging_accounted_in_total: mark.optional(),
    confirmed_amounts: z
      .object({
        version: z.number().int().min(1),
        products: decimal,
        shipping: decimal,
        currency: z.string().regex(/^[A-Z]{3}$/),
        at: z.string().max(40),
        by: z.string().max(120),
      })
      .strict()
      .optional(),
  })
  .strict();

export type OrderOverrides = z.infer<typeof orderOverridesSchema>;

/** Розбір збереженого JSON; пошкоджене — порожньо (позначки не діють, а не вигадуються). */
export function parseOrderOverrides(value: unknown): OrderOverrides {
  const r = orderOverridesSchema.safeParse(value ?? {});
  return r.success ? r.data : {};
}

/** Прапорцеві позначки (без сум). */
export const FLAG_OVERRIDES = ["recipient_pays", "no_shipping_cost", "fees_zero_confirmed", "packaging_accounted_in_total"] as const satisfies readonly OrderOverrideKind[];
export type FlagOverride = (typeof FLAG_OVERRIDES)[number];

export function isFlagOverride(value: string): value is FlagOverride {
  return (FLAG_OVERRIDES as readonly string[]).includes(value);
}

/** Складник, якого стосується позначка (для історії змін). */
export const OVERRIDE_COMPONENT: Readonly<Record<OrderOverrideKind, "shipping_cost" | "fees" | "packaging" | "revenue">> = {
  recipient_pays: "shipping_cost",
  no_shipping_cost: "shipping_cost",
  fees_zero_confirmed: "fees",
  packaging_accounted_in_total: "packaging",
  confirmed_amounts: "revenue",
};

/** Позначка доставки (одна з двох або null). */
export function shippingOverrideOf(o: OrderOverrides): "recipient_pays" | "no_shipping_cost" | null {
  if (o.recipient_pays) return "recipient_pays";
  if (o.no_shipping_cost) return "no_shipping_cost";
  return null;
}

/**
 * Етап 6 (WP3): вікно читання замовлень Shopify (docs/stage6-design.md §16.3, §16.4). Без read_all_orders Admin API віддає
 * лише замовлення, створені за останні 60 днів (shopify.dev: «orders created within the last 60 days»). Без грошей і без
 * записів — можна імпортувати й зі сторінок (напр. «Недоступно: потрібен дозвіл Shopify `read_all_orders`», WP10).
 */
import { ORDERS_DEFAULT_READ_WINDOW_MS } from "~/modules/shopify-sync/fulfillment-refresh.server";

export const ALL_ORDERS_SCOPE = "read_all_orders";

/** Чи надано scope (рядок scopes встановлення через кому). */
export function hasScope(scopes: string | null | undefined, scope: string): boolean {
  return (scopes ?? "")
    .split(",")
    .map((s) => s.trim())
    .includes(scope);
}

/** Замовлення поза вікном читання без read_all_orders. */
export function outsideReadWindow(placedAt: Date, now: Date, scopes: string | null | undefined): boolean {
  return !hasScope(scopes, ALL_ORDERS_SCOPE) && placedAt.getTime() < now.getTime() - ORDERS_DEFAULT_READ_WINDOW_MS;
}

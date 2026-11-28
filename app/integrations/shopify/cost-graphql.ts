/**
 * Етап 6: GraphQL Admin API 2026-10 — підказки собівартості з Shopify (InventoryItem.unitCost; docs/stage6-design.md
 * §6.6, §16.2). Розмір сторінки (вбудований у документ) і змінні зафіксувало ядро (WP0; рядок SIZES у
 * tests/stage5/shopify-query-cost.test.ts); документ — WP2. Дочитує всі сторінки (modules/costing/shopify-costs.server.ts).
 * Оцінка — 402 = 2 + VARIANT_COSTS_PAGE × (pageInfo 1 + вузол 1 + inventoryItem 1 + unitCost 1) (точна формула —
 * tests/stage6/costing/shopify-costs.test.ts). Значення — лише НЕПІДТВЕРДЖЕНІ підказки (D-22): поточна ціна у валюті
 * магазину; історичної собівартості на дату продажу Shopify не дає. Доступ до unitCost для офлайн-токена без «View
 * product costs» — ПЕРЕВІРИТИ НА ТЕСТОВОМУ МАГАЗИНІ (поле може повернутися null — тоді підказки немає, не 0).
 */

/** OtVariantCosts($after): productVariants(first: 100) { … inventoryItem { id unitCost { amount currencyCode } } }. */
export const VARIANT_COSTS_PAGE = 100;

/** Запобіжник: найбільше сторінок за один запуск (100 × 200 = 20 000 варіантів). */
export const VARIANT_COSTS_MAX_PAGES = 200;

export const COST_QUERY_COST_ESTIMATES = { OtVariantCosts: 402 } as const;

export const VARIANT_COSTS_QUERY = `#graphql
  query OtVariantCosts($after: String) {
    productVariants(first: ${VARIANT_COSTS_PAGE}, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { id inventoryItem { id unitCost { amount currencyCode } } }
    }
  }`;

export interface VariantCostsPage {
  productVariants: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; inventoryItem: { id: string; unitCost: { amount: string; currencyCode: string } | null } | null }>;
  };
}

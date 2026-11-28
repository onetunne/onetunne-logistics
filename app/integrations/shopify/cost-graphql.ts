/**
 * Етап 6: GraphQL Admin API 2026-10 — підказки собівартості з Shopify (InventoryItem.unitCost; docs/stage6-design.md
 * §6.6, §16.2). Документ OtVariantCosts($after) додає WP2 у цей файл; ядро (WP0) зафіксувало розмір сторінки (вбудовується
 * в документ) і змінні (рядок SIZES у tests/stage5/shopify-query-cost.test.ts). Дочитує всі сторінки. Оцінка — 402.
 * Значення — лише непідтверджені підказки (D-22), поточна ціна у валюті магазину.
 */

/** OtVariantCosts($after): productVariants(first: 100) { … inventoryItem { id unitCost { amount currencyCode } } }. */
export const VARIANT_COSTS_PAGE = 100;

export const COST_QUERY_COST_ESTIMATES = { OtVariantCosts: 402 } as const;

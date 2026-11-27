/**
 * Кількість позиції замовлення для складу (чиста функція).
 *
 * Shopify LineItem.quantity містить повернені й видалені (редагування замовлення) одиниці, а currentQuantity — ні.
 * Shopify сам повертає такі одиниці в «доступно», тож резерв, списання, початковий залишок, черга пакування й
 * аналітика продажів використовують currentQuantity; quantity лишається для історії/документів замовлення.
 * currentQuantity = null (демо-замовлення, позиції до етапу 5) → quantity.
 */
export function effectiveLineQuantity(line: { quantity: number; currentQuantity?: number | null }): number {
  const q = line.currentQuantity ?? line.quantity;
  return Number.isSafeInteger(q) && q > 0 ? q : 0;
}

/**
 * Перетворення відповідей GraphQL Admin API у внутрішні записи (чисті функції).
 * Нічого не вигадуємо: відсутнє значення в Shopify → null (перевірка даних покаже проблему).
 */
import type { OrderStatus } from "~/domain/order-status";
import type { GqlOrder, GqlProduct, GqlVariant } from "~/integrations/shopify/graphql";

const WEIGHT_TO_GRAMS: Record<string, number> = {
  GRAMS: 1,
  KILOGRAMS: 1000,
  OUNCES: 28.349523125,
  POUNDS: 453.59237,
};

export function weightToGrams(weight: { unit: string; value: number } | null | undefined): number | null {
  if (!weight || typeof weight.value !== "number" || !Number.isFinite(weight.value) || weight.value <= 0) return null;
  const factor = WEIGHT_TO_GRAMS[weight.unit];
  if (!factor) return null;
  return Math.max(1, Math.round(weight.value * factor));
}

/** Десятковий рядок Shopify → рядок з 2 знаками (округлення half-up), без float. */
export function normalizeAmount(value: string | null | undefined): string {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec((value ?? "0").trim());
  if (!m) return "0.00";
  const [, sign = "", int, frac = ""] = m;
  let cents = BigInt(int!) * 100n + BigInt((frac + "00").slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) cents += 1n;
  const abs = `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
  return sign && cents !== 0n ? `-${abs}` : abs;
}

const COLOR_OPTION = /^(colou?r|колір|цвет|farbe)$/i;
const MODEL_OPTION = /^(model|модель)$/i;

const blank = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export interface MappedVariant {
  shopifyVariantId: string;
  title: string;
  sku: string | null;
  barcode: string | null;
  color: string | null;
  model: string | null;
  price: string;
  weightGrams: number | null;
  hsCode: string | null;
  countryOfOrigin: string | null;
  customsDescription: string | null;
  customsDescriptionLocal: string | null;
  material: string | null;
  imageUrl: string | null;
  inventoryAvailable: number | null;
  inventoryItemId: string | null;
}

export interface MappedProduct {
  shopifyProductId: string;
  title: string;
  handle: string;
  status: string;
  imageUrl: string | null;
  shopifyUpdatedAt: Date;
  variants: MappedVariant[];
}

function mapVariant(v: GqlVariant, product: GqlProduct, productImage: string | null): MappedVariant {
  const option = (re: RegExp) => blank(v.selectedOptions.find((o) => re.test(o.name))?.value);
  return {
    shopifyVariantId: v.id,
    title: v.title,
    sku: blank(v.sku),
    barcode: blank(v.barcode),
    color: option(COLOR_OPTION),
    model: option(MODEL_OPTION),
    price: normalizeAmount(v.price),
    weightGrams: weightToGrams(v.inventoryItem?.measurement?.weight),
    hsCode: blank(v.inventoryItem?.harmonizedSystemCode),
    countryOfOrigin: blank(v.inventoryItem?.countryCodeOfOrigin)?.toUpperCase() ?? null,
    customsDescription: blank(product.customsDescription?.value),
    customsDescriptionLocal: blank(product.customsDescriptionUk?.value),
    material: blank(product.material?.value),
    imageUrl: v.image?.url ?? productImage,
    // Доступна для продажу кількість (сума по локаціях). Якщо Shopify не відстежує залишок — null, а не 0.
    inventoryAvailable: v.inventoryItem?.tracked === false ? null : typeof v.inventoryQuantity === "number" ? v.inventoryQuantity : null,
    inventoryItemId: v.inventoryItem?.id ?? null,
  };
}

export function mapProduct(p: GqlProduct): MappedProduct {
  const imageUrl = p.featuredMedia?.preview?.image?.url ?? null;
  return {
    shopifyProductId: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    imageUrl,
    shopifyUpdatedAt: new Date(p.updatedAt),
    variants: p.variants.nodes.map((v) => mapVariant(v, p, imageUrl)),
  };
}

/**
 * Оплачені (у т. ч. частково/повністю повернені) замовлення потрапляють в обробку; неоплачені — ні.
 * Склад резервує лише currentQuantity, тож повернені одиниці (і повністю повернене замовлення) не резервуються.
 */
const PAID_STATUSES = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

export function isPaid(order: Pick<GqlOrder, "displayFinancialStatus">): boolean {
  return PAID_STATUSES.has(order.displayFinancialStatus ?? "");
}

export interface MappedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
  /**
   * Етап 5: Shopify виконав (або міг виконати) одиниці позицій, що потребують доставки; false — виконано лише позиції
   * без доставки (цифрові подарункові картки тощо); null — у відповіді немає полів позицій (shippableFulfilled).
   */
  shippableFulfilled: boolean | null;
  currency: string;
  subtotal: string;
  shippingPaid: string;
  total: string;
  email: string | null;
  contactPhone: string | null;
  shipping: {
    firstName: string | null;
    lastName: string | null;
    company: string | null;
    address1: string | null;
    address2: string | null;
    city: string | null;
    province: string | null;
    postalCode: string | null;
    countryCode: string | null;
    phone: string | null;
  };
  billingCountryCode: string | null;
  note: string | null;
  placedAt: Date;
  cancelledAt: Date | null;
  shopifyUpdatedAt: Date;
  test: boolean;
  lineItems: Array<{
    shopifyLineItemId: string;
    shopifyVariantId: string | null;
    shopifyProductId: string | null;
    title: string;
    variantTitle: string | null;
    sku: string | null;
    /** Замовлено (разом із поверненими/видаленими одиницями). */
    quantity: number;
    /** До відправлення: Shopify currentQuantity (без повернених і видалених); резервує й списує склад. */
    currentQuantity: number;
    /** Коли позицію створено в Shopify (LineItem.createdAt); null — немає в даних (старі відповіді/тести). */
    shopifyCreatedAt: Date | null;
    /**
     * Етап 6: чи потребує позиція доставки (LineItem.requiresShipping, Boolean!, уже отримуване) — складник «Доставка»
     * фінансів (§2.6). null — немає в даних (старі відповіді/тести; фінанси вважають «потребує»).
     */
    requiresShipping: boolean | null;
    unitPrice: string;
    /**
     * Ціна одиниці після всіх знижок (LineItem.discountedUnitPriceAfterAllDiscountsSet.shopMoney) — митна вартість
     * одиниці (customs/invoice.ts). null — немає в даних, інша валюта, ніж у ціни позиції, або некоректне значення.
     */
    discountedUnitPrice: string | null;
    currency: string;
    imageUrl: string | null;
  }>;
}

/**
 * Ціна одиниці після всіх знижок. Shopify (LineItem, 2026-10): «The approximate unit price of the line item in shop and
 * presentment currencies. This value includes discounts applied to refunded and removed quantities.» Береться shopMoney —
 * та сама валюта, що й originalUnitPriceSet.shopMoney (ціни позицій) і суми замовлення (orders.currency); якщо валюти
 * різні або сума некоректна — null (інвойс тоді розподіляє знижку з subtotal, як раніше). Нічого не вигадуємо:
 * normalizeAmount перетворив би некоректне значення на 0.00 і занизив митну вартість.
 */
export function discountedUnitPriceOf(li: GqlOrder["lineItems"]["nodes"][number]): string | null {
  const money = li.discountedUnitPriceAfterAllDiscountsSet?.shopMoney;
  if (!money || money.currencyCode !== li.originalUnitPriceSet.shopMoney.currencyCode) return null;
  if (typeof money.amount !== "string" || !/^\d+(?:\.\d+)?$/.test(money.amount.trim())) return null;
  return normalizeAmount(money.amount);
}

function validDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Чи виконав Shopify одиниці позицій, що потребують доставки (orders.shopify_shippable_fulfilled). Позиція «не
 * торкнута виконанням», лише коли unfulfilledQuantity ≥ quantity (див. GqlOrder: тоді жодної одиниці не виконано, хоч
 * як Shopify враховує повернення); інакше — виконано або неоднозначно (повернення) → true (накладна не створюється).
 * Не враховуються позиції без доставки (requiresShipping: false) і без одиниць до відправлення (currentQuantity 0:
 * накладна, пакування й митні позиції застосунку — за поточною кількістю). Немає полів хоча б в одній позиції → null.
 */
export function shippableFulfilled(nodes: GqlOrder["lineItems"]["nodes"]): boolean | null {
  let fulfilled = false;
  for (const li of nodes) {
    if (typeof li.unfulfilledQuantity !== "number" || typeof li.requiresShipping !== "boolean") return null;
    // Позиція без одиниць до відправлення (повністю повернена/видалена) застосунком не відправляється.
    const current = typeof li.currentQuantity === "number" ? li.currentQuantity : li.quantity;
    if (li.requiresShipping && current > 0 && li.unfulfilledQuantity < li.quantity) fulfilled = true;
  }
  return fulfilled;
}

export function mapOrder(o: GqlOrder): MappedOrder {
  const total = o.totalPriceSet.shopMoney;
  const shippingPaid = normalizeAmount(o.totalShippingPriceSet?.shopMoney.amount ?? "0");
  const a = o.shippingAddress;
  return {
    shopifyOrderId: o.id,
    orderNumber: o.name,
    financialStatus: (o.displayFinancialStatus ?? "UNKNOWN").toLowerCase(),
    fulfillmentStatus: o.displayFulfillmentStatus?.toLowerCase() ?? null,
    shippableFulfilled: shippableFulfilled(o.lineItems.nodes),
    currency: total.currencyCode,
    subtotal: normalizeAmount(o.subtotalPriceSet?.shopMoney.amount ?? total.amount),
    shippingPaid,
    total: normalizeAmount(total.amount),
    email: blank(o.email),
    contactPhone: blank(o.phone),
    shipping: {
      firstName: blank(a?.firstName),
      lastName: blank(a?.lastName),
      company: blank(a?.company),
      address1: blank(a?.address1),
      address2: blank(a?.address2),
      city: blank(a?.city),
      // Для зворотного оновлення Shopify потрібен provinceCode, тому зберігаємо саме його (якщо є).
      province: blank(a?.provinceCode) ?? blank(a?.province),
      postalCode: blank(a?.zip),
      countryCode: blank(a?.countryCodeV2)?.toUpperCase() ?? null,
      phone: blank(a?.phone),
    },
    billingCountryCode: blank(o.billingAddress?.countryCodeV2)?.toUpperCase() ?? null,
    note: blank(o.note),
    placedAt: new Date(o.processedAt ?? o.createdAt),
    cancelledAt: o.cancelledAt ? new Date(o.cancelledAt) : null,
    shopifyUpdatedAt: new Date(o.updatedAt),
    test: o.test,
    lineItems: o.lineItems.nodes.map((li) => ({
      shopifyLineItemId: li.id,
      shopifyVariantId: li.variant?.id ?? null,
      shopifyProductId: li.variant?.product?.id ?? null,
      title: li.title,
      variantTitle: blank(li.variantTitle),
      sku: blank(li.sku),
      quantity: li.quantity,
      // Старі відповіді/тести без currentQuantity → quantity.
      currentQuantity: typeof li.currentQuantity === "number" ? Math.max(0, li.currentQuantity) : li.quantity,
      shopifyCreatedAt: validDate(li.createdAt),
      requiresShipping: typeof li.requiresShipping === "boolean" ? li.requiresShipping : null,
      unitPrice: normalizeAmount(li.originalUnitPriceSet.shopMoney.amount),
      discountedUnitPrice: discountedUnitPriceOf(li),
      currency: li.originalUnitPriceSet.shopMoney.currencyCode,
      imageUrl: li.image?.url ?? null,
    })),
  };
}

/**
 * Початковий статус нового замовлення. Під час імпорту історії виконані в Shopify замовлення
 * позначаються «Передано перевізнику» (фактично відправлені раніше), скасовані — «Скасовано».
 */
export function initialStatus(order: MappedOrder, mode: "live" | "import"): OrderStatus {
  if (order.cancelledAt) return "cancelled";
  if (mode === "import" && order.fulfillmentStatus === "fulfilled") return "handed_to_carrier";
  return "paid";
}

/**
 * Числовий id із payload webhook → GID. Число JSON понад 2^53 після JSON.parse уже неточне — не приймається (null), як і
 * нецифровий рядок.
 */
function gidFromNumericId(id: unknown, type: string): string | null {
  if (typeof id === "number" && Number.isSafeInteger(id) && id > 0) return `gid://shopify/${type}/${id}`;
  if (typeof id === "string" && /^\d{1,20}$/.test(id)) return `gid://shopify/${type}/${id}`;
  return null;
}

/**
 * Етап 6: webhook refunds/create — замовлення з `order_id` (`admin_graphql_api_id` корисного навантаження — id САМОГО
 * повернення, не замовлення; docs/stage6-design.md §16.4).
 */
export function orderGidFromRefundPayload(payload: Record<string, unknown>): string | null {
  return gidFromNumericId(payload.order_id, "Order");
}

/** Етап 6: webhook orders/edited — корінь корисного навантаження — правка (`order_edit`), id замовлення — `order_edit.order_id`. */
export function orderGidFromOrderEditPayload(payload: Record<string, unknown>): string | null {
  const edit = payload.order_edit;
  if (!edit || typeof edit !== "object") return null;
  return gidFromNumericId((edit as Record<string, unknown>).order_id, "Order");
}

/** GID ресурсу з REST-подібного payload webhook. */
export function gidFromPayload(payload: Record<string, unknown>, type: string, idField = "id"): string | null {
  const gid = payload.admin_graphql_api_id;
  if (typeof gid === "string" && gid.startsWith("gid://shopify/")) return gid;
  const id = payload[idField];
  if (typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) return `gid://shopify/${type}/${id}`;
  return null;
}

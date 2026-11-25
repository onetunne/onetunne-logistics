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

/** Оплачені (у т. ч. частково повернені) замовлення потрапляють в обробку; неоплачені — ні. */
const PAID_STATUSES = new Set(["PAID", "PARTIALLY_REFUNDED", "REFUNDED"]);

export function isPaid(order: Pick<GqlOrder, "displayFinancialStatus">): boolean {
  return PAID_STATUSES.has(order.displayFinancialStatus ?? "");
}

export interface MappedOrder {
  shopifyOrderId: string;
  orderNumber: string;
  financialStatus: string;
  fulfillmentStatus: string | null;
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
    quantity: number;
    unitPrice: string;
    currency: string;
    imageUrl: string | null;
  }>;
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
      unitPrice: normalizeAmount(li.originalUnitPriceSet.shopMoney.amount),
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

/** GID ресурсу з REST-подібного payload webhook. */
export function gidFromPayload(payload: Record<string, unknown>, type: string, idField = "id"): string | null {
  const gid = payload.admin_graphql_api_id;
  if (typeof gid === "string" && gid.startsWith("gid://shopify/")) return gid;
  const id = payload[idField];
  if (typeof id === "number" || (typeof id === "string" && /^\d+$/.test(id))) return `gid://shopify/${type}/${id}`;
  return null;
}

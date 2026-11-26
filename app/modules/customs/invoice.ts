/**
 * Комерційний інвойс / проформа для міжнародного відправлення (митні дані товарів).
 *
 * Чистий модуль (без БД/мережі): замовлення + товари + налаштування → модель інвойсу.
 * Використовується для: друку інвойсу застосунку, митних даних запиту до перевізника
 * (CreateShipmentRequest.customs + customsItems) і перевірки повноти митних даних.
 *
 * Дані не вигадуються: відсутні HS-код/країна походження/опис позначаються в `missing`.
 */
import { addMoney, multiplyMoney } from "~/lib/money";
import { normalizeHsCode } from "~/modules/validation";
import type { AllSettings } from "~/modules/settings/schema";
import type { CustomsDeclaration, CustomsItem, ExportReason, Incoterm } from "~/integrations/carriers/types";

export interface InvoiceOrderInput {
  orderNumber: string;
  currency: string;
  shippingPaid: string;
  email: string | null;
  shipFirstName: string | null;
  shipLastName: string | null;
  shipCompany: string | null;
  shipAddress1: string | null;
  shipAddress2: string | null;
  shipCity: string | null;
  shipProvince: string | null;
  shipPostalCode: string | null;
  shipCountryCode: string | null;
  shipPhone: string | null;
}

export interface InvoiceItemInput {
  title: string;
  sku: string | null;
  quantity: number;
  unitPrice: string;
  currency: string;
  variant: {
    sku: string | null;
    weightGrams: number | null;
    hsCode: string | null;
    countryOfOrigin: string | null;
    customsDescription: string | null;
    customsDescriptionLocal?: string | null;
    material?: string | null;
  } | null;
}

export interface InvoiceParty {
  name: string;
  company: string | null;
  taxId: string | null;
  eori: string | null;
  ioss: string | null;
  phone: string | null;
  email: string | null;
  addressLines: string[];
  countryCode: string;
}

export interface InvoiceLine {
  position: number;
  sku: string | null;
  title: string;
  /** Митний опис англійською (або назва товару, якщо опису немає — тоді є в missing). */
  description: string;
  descriptionLocal: string | null;
  material: string | null;
  hsCode: string | null;
  countryOfOrigin: string | null;
  quantity: number;
  unitValue: string;
  lineValue: string;
  unitWeightGrams: number | null;
  lineWeightGrams: number | null;
}

export type InvoiceMissingField = "hsCode" | "countryOfOrigin" | "customsDescription" | "weight";

export interface CommercialInvoice {
  number: string;
  /** YYYY-MM-DD (Europe/Kyiv). */
  date: string;
  type: "commercial" | "proforma";
  incoterm: Incoterm;
  exportReason: ExportReason;
  currency: string;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  goodsTotal: string;
  shippingCharge: string;
  total: string;
  totalWeightGrams: number;
  waybillNumber: string | null;
  /** Відсутні митні дані по позиціях: [{position, field}]. Порожньо — інвойс повний. */
  missing: { position: number; field: InvoiceMissingField }[];
}

/** Дата у часовому поясі Києва, YYYY-MM-DD. */
export function kyivDate(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Kyiv", year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
}

/** Номер інвойсу: стабільний для замовлення (лише латиниця/цифри/дефіс). */
export function invoiceNumberFor(orderNumber: string): string {
  return `INV-${orderNumber.replace(/[^A-Za-z0-9-]/g, "")}`;
}

const clean = (v: string | null | undefined): string | null => {
  const t = (v ?? "").trim();
  return t === "" ? null : t;
};

export function buildCommercialInvoice(input: {
  order: InvoiceOrderInput;
  items: InvoiceItemInput[];
  settings: Pick<AllSettings, "shipper" | "customs">;
  issuedAt: Date;
  waybillNumber?: string | null;
}): CommercialInvoice {
  const { order, items, settings } = input;
  const s = settings.shipper;
  const missing: CommercialInvoice["missing"] = [];
  const lines: InvoiceLine[] = items.map((item, index) => {
    const position = index + 1;
    const v = item.variant;
    const hsCode = normalizeHsCode(v?.hsCode ?? "") ?? null;
    const origin = clean(v?.countryOfOrigin)?.toUpperCase() ?? null;
    const description = clean(v?.customsDescription);
    const weight = v?.weightGrams && v.weightGrams > 0 ? v.weightGrams : null;
    if (!hsCode) missing.push({ position, field: "hsCode" });
    if (!origin) missing.push({ position, field: "countryOfOrigin" });
    if (!description) missing.push({ position, field: "customsDescription" });
    if (weight === null) missing.push({ position, field: "weight" });
    return {
      position,
      sku: clean(v?.sku) ?? clean(item.sku),
      title: item.title,
      description: description ?? item.title,
      descriptionLocal: clean(v?.customsDescriptionLocal),
      material: clean(v?.material),
      hsCode,
      countryOfOrigin: origin,
      quantity: item.quantity,
      unitValue: item.unitPrice,
      lineValue: multiplyMoney(item.unitPrice, item.quantity),
      unitWeightGrams: weight,
      lineWeightGrams: weight === null ? null : weight * item.quantity,
    };
  });
  const goodsTotal = addMoney("0.00", ...lines.map((l) => l.lineValue));
  const shippingCharge = addMoney("0.00", order.shippingPaid || "0");
  const buyerName = [order.shipFirstName, order.shipLastName].filter((x) => clean(x)).join(" ");
  return {
    number: invoiceNumberFor(order.orderNumber),
    date: kyivDate(input.issuedAt),
    type: settings.customs.invoiceType,
    incoterm: settings.customs.incoterm,
    exportReason: settings.customs.exportReason,
    currency: order.currency,
    seller: {
      name: s.contactName,
      company: clean(s.companyName),
      taxId: clean(s.taxId),
      eori: clean(s.eori),
      ioss: null,
      phone: clean(s.phone),
      email: clean(s.email),
      addressLines: [s.address1, s.address2, [s.postalCode, s.city].filter((x) => clean(x)).join(" ")].filter((x) => clean(x)),
      countryCode: s.countryCode,
    },
    buyer: {
      name: buyerName,
      company: clean(order.shipCompany),
      taxId: null,
      eori: null,
      // IOSS відправника вказується для посилок до ЄС (імпортний ПДВ сплачено при продажу).
      ioss: clean(s.ioss),
      phone: clean(order.shipPhone),
      email: clean(order.email),
      addressLines: [
        order.shipAddress1 ?? "",
        order.shipAddress2 ?? "",
        [order.shipPostalCode, order.shipCity].filter((x) => clean(x)).join(" "),
        order.shipProvince ?? "",
      ].filter((x) => clean(x)),
      countryCode: order.shipCountryCode ?? "",
    },
    lines,
    goodsTotal,
    shippingCharge,
    total: addMoney(goodsTotal, shippingCharge),
    totalWeightGrams: lines.reduce((sum, l) => sum + (l.lineWeightGrams ?? 0), 0),
    waybillNumber: input.waybillNumber ?? null,
    missing,
  };
}

/** Митна декларація для запиту до перевізника. */
export function toCustomsDeclaration(invoice: CommercialInvoice): CustomsDeclaration {
  return {
    invoiceNumber: invoice.number,
    invoiceDate: invoice.date,
    invoiceType: invoice.type,
    incoterm: invoice.incoterm,
    exportReason: invoice.exportReason,
    totalValue: { amount: invoice.goodsTotal, currency: invoice.currency },
  };
}

/** Позиції інвойсу → митні позиції запиту до перевізника. */
export function toCustomsItems(invoice: CommercialInvoice): CustomsItem[] {
  return invoice.lines.map((l) => ({
    sku: l.sku,
    description: l.description,
    descriptionLocal: l.descriptionLocal,
    hsCode: l.hsCode ?? "",
    countryOfOrigin: l.countryOfOrigin ?? "",
    quantity: l.quantity,
    unitValue: { amount: l.unitValue, currency: invoice.currency },
    weightGrams: l.unitWeightGrams ?? 0,
    material: l.material,
    materialLocal: null,
    producerAndModel: null,
  }));
}

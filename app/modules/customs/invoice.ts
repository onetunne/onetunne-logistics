/**
 * Комерційний інвойс / проформа для міжнародного відправлення (митні дані товарів).
 *
 * Чистий модуль (без БД/мережі): замовлення + товари + налаштування → модель інвойсу.
 * Використовується для: друку інвойсу застосунку, митних даних запиту до перевізника
 * (CreateShipmentRequest.customs + customsItems) і перевірки повноти митних даних.
 *
 * Дані не вигадуються: відсутні HS-код/країна походження/опис позначаються в `missing`.
 */
import { addMoney, fromMinor, isDecimalString, multiplyMoney, toMinor } from "~/lib/money";
import { normalizeHsCode } from "~/modules/validation";
import type { AllSettings } from "~/modules/settings/schema";
import type { CustomsDeclaration, CustomsItem, ExportReason, Incoterm } from "~/integrations/carriers/types";

export interface InvoiceOrderInput {
  orderNumber: string;
  currency: string;
  /**
   * Сума позицій ПІСЛЯ всіх знижок (Shopify Order.subtotalPriceSet: «after discounts»; податок включено так само,
   * як у цінах позицій). Ціни позицій — ДО знижок (LineItem.originalUnitPriceSet), тому різниця — знижка.
   * Відсутнє значення → ціни позицій без змін.
   */
  subtotal?: string | null;
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

/**
 * Митна вартість одиниці = ціна угоди (фактично сплачена, після знижок). Знижка (Σ ціна до знижок × кількість −
 * subtotal) розподіляється між рядками пропорційно їхній вартості (BigInt, метод найбільших залишків), потім
 * ділиться на кількість з округленням до цента (рядок = ціна × кількість, тож сума може відрізнятися від subtotal
 * не більше ніж на половину цента на одиницю). Без знижки або без subtotal — ціни без змін.
 * Обмеження: рядки, що не входять у subtotal (подарункові картки, чайові), Shopify не позначено в наших даних —
 * для них розподіл неточний (такі позиції й без того не мають бути в митному інвойсі).
 */
export function transactionUnitValues(items: readonly { unitPrice: string; quantity: number }[], subtotal: string | null | undefined): string[] {
  const original = items.map((i) => i.unitPrice);
  if (!subtotal || !isDecimalString(subtotal) || !items.every((i) => isDecimalString(i.unitPrice))) return original;
  const lines = items.map((i) => (i.quantity > 0 ? toMinor(i.unitPrice) * BigInt(i.quantity) : 0n));
  const sum = lines.reduce((a, b) => a + b, 0n);
  let discount = sum - toMinor(subtotal);
  if (sum <= 0n || discount <= 0n) return original;
  if (discount > sum) discount = sum;
  const shares = lines.map((l) => (discount * l) / sum);
  let rest = discount - shares.reduce((a, b) => a + b, 0n);
  const byRemainder = lines
    .map((l, index) => ({ index, rem: (discount * l) % sum }))
    .sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const { index } of byRemainder) {
    if (rest <= 0n) break;
    if (lines[index]! - shares[index]! <= 0n) continue;
    shares[index]! += 1n;
    rest -= 1n;
  }
  return items.map((item, i) => {
    if (item.quantity <= 0) return item.unitPrice;
    const q = BigInt(item.quantity);
    const lineAfter = lines[i]! - shares[i]!;
    return fromMinor((2n * lineAfter + q) / (2n * q));
  });
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
  const unitValues = transactionUnitValues(items, order.subtotal);
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
      unitValue: unitValues[index]!,
      lineValue: multiplyMoney(unitValues[index]!, item.quantity),
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
      // IOSS продавця — для посилок до ЄС до 150 EUR (ПДВ сплачено при продажу).
      ioss: clean(s.ioss),
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
      ioss: null,
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

/** Митні дані, фактично надіслані перевізнику (знімок запиту відправлення shipments.requestSnapshot). */
export interface SentCustomsData {
  customs?: CustomsDeclaration | null;
  customsItems?: CustomsItem[] | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isMoney = (m: unknown): m is { amount: string; currency: string } =>
  Boolean(m) && typeof (m as { amount?: unknown }).amount === "string" && isDecimalString((m as { amount: string }).amount);

/**
 * Друкований інвойс має збігатися з електронним інвойсом перевізника (той самий номер). Якщо запит уже надіслано,
 * дата, тип, Incoterms, причина експорту і митні дані позицій (HS-код, походження, опис, кількість, вартість, вага)
 * беруться зі знімка запиту, а не з поточних налаштувань/товарів (вони могли змінитися після створення накладної,
 * а повтор після збою міг надіслати іншу дату). Дані сторін (адреси) — поточні: у знімку їх немає (без персональних даних).
 * Немає знімка або він іншого формату — інвойс без змін.
 */
export function withSentCustomsData(invoice: CommercialInvoice, sent: SentCustomsData | null | undefined): CommercialInvoice {
  const customs = sent?.customs;
  if (!customs || typeof customs !== "object" || !DATE_RE.test(String(customs.invoiceDate ?? ""))) return invoice;
  const out: CommercialInvoice = {
    ...invoice,
    number: typeof customs.invoiceNumber === "string" && customs.invoiceNumber ? customs.invoiceNumber : invoice.number,
    date: customs.invoiceDate,
    type: customs.invoiceType ?? invoice.type,
    incoterm: customs.incoterm ?? invoice.incoterm,
    exportReason: customs.exportReason ?? invoice.exportReason,
  };
  const items = Array.isArray(sent?.customsItems) ? sent.customsItems : null;
  if (!items || items.length !== invoice.lines.length || !items.every((i) => isMoney(i?.unitValue) && Number.isInteger(i.quantity))) {
    return out;
  }
  const lines = invoice.lines.map((line, index): InvoiceLine => {
    const item = items[index]!;
    const weight = Number.isFinite(item.weightGrams) && item.weightGrams > 0 ? item.weightGrams : null;
    return {
      ...line,
      sku: clean(item.sku) ?? line.sku,
      description: clean(item.description) ?? line.description,
      descriptionLocal: clean(item.descriptionLocal),
      material: clean(item.material),
      hsCode: clean(item.hsCode),
      countryOfOrigin: clean(item.countryOfOrigin),
      quantity: item.quantity,
      unitValue: item.unitValue.amount,
      lineValue: multiplyMoney(item.unitValue.amount, item.quantity),
      unitWeightGrams: weight,
      lineWeightGrams: weight === null ? null : weight * item.quantity,
    };
  });
  const missing: CommercialInvoice["missing"] = [];
  for (const l of lines) {
    if (!l.hsCode) missing.push({ position: l.position, field: "hsCode" });
    if (!l.countryOfOrigin) missing.push({ position: l.position, field: "countryOfOrigin" });
    // Опис у знімку вже містить назву товару як запасний варіант — відсутність опису беремо з поточних даних.
    if (invoice.missing.some((m) => m.position === l.position && m.field === "customsDescription")) {
      missing.push({ position: l.position, field: "customsDescription" });
    }
    if (l.unitWeightGrams === null) missing.push({ position: l.position, field: "weight" });
  }
  const goodsTotal = addMoney("0.00", ...lines.map((l) => l.lineValue));
  return {
    ...out,
    currency: isMoney(customs.totalValue) ? customs.totalValue.currency : out.currency,
    lines,
    goodsTotal,
    total: addMoney(goodsTotal, invoice.shippingCharge),
    totalWeightGrams: lines.reduce((sum, l) => sum + (l.lineWeightGrams ?? 0), 0),
    missing,
  };
}

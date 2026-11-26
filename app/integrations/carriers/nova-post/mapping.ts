/**
 * Чисте зіставлення даних Nova Post API v1.0 (без мережі й побічних ефектів).
 *
 * - CreateShipmentRequest → тіло POST /shipments (міжнародне відправлення з України);
 * - тіло помилки перевізника → CarrierErrorDetail[] з полями нашої моделі (FieldPath);
 * - відповіді розрахунку (POST /shipments/calculations) → RateQuote[];
 * - відповідь FullTracking (GET /shipments/tracking) → TrackingSnapshot[];
 * - параметри друку (GET /shipments/print).
 *
 * Джерело фактів: https://api-portal.novapost.com/methods/methods/shipments/create-shipments/cross-border-shipments-from-ukraine.md
 * (таблиця полів + OpenAPI), …/shipments.md, …/print-documents/*.md, …/tracking-shipment.md, …/delivery-cost.md.
 * У OpenAPI деякі назви полів мають «*» (позначка обов'язковості, напр. `payerType*`) — на дроті назва без «*».
 *
 * Персональні дані НЕ обрізаються мовчки: якщо значення довше за документований ліміт — помилка "rejected"
 * з полем нашої моделі, щоб менеджер виправив дані. Тексти помилок не містять самих значень.
 */
import { fromMinor, isDecimalString, toMinor } from "~/lib/money";
import { mapNovaPostTrackingCode } from "./tracking-codes";
import {
  CarrierError,
  type CarrierAddress,
  type CarrierDocumentKind,
  type CarrierErrorDetail,
  type CarrierParty,
  type CreateShipmentRequest,
  type CreatedShipment,
  type CustomsDeclaration,
  type CustomsItem,
  type ExportReason,
  type Incoterm,
  type Money,
  type RateQuote,
  type TrackingEvent,
  type TrackingSnapshot,
} from "../types";

export const NOVA_POST_CODE = "nova_post";

/** Документовані значення deliveryType для POST /shipments і deliveryTypes для розрахунку. */
export const NOVA_POST_DELIVERY_TYPES = ["standard", "economy", "express"] as const;
export type NovaPostDeliveryType = (typeof NOVA_POST_DELIVERY_TYPES)[number];
export const isNovaPostDeliveryType = (v: string): v is NovaPostDeliveryType => (NOVA_POST_DELIVERY_TYPES as readonly string[]).includes(v);

export type NovaPostPayerType = "Sender" | "Recipient" | "ThirdPerson";

/** Країни ЄС (ISO 3166-1 alpha-2) — для полів, які документація дозволяє лише для напрямку UA → ЄС. */
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU",
  "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

const EXPORT_REASONS: Record<ExportReason, "ForPersonalPurposes" | "Selling" | "Repair" | "Return" | "Other"> = {
  sale: "Selling",
  personal: "ForPersonalPurposes",
  repair: "Repair",
  return: "Return",
  other: "Other",
};

/** Ліміт IOSS (ЄС): посилки з внутрішньою вартістю до 150 EUR. */
const IOSS_MAX_EUR_MINOR = 15000n;
/** Макс. значення сум у інвойсі (документація: Max 9999999.99). */
const INVOICE_MAX_MINOR = 999999999n;
/** Макс. габарит, мм (помилка API: «must be less than or equal to 32767»). */
const MAX_DIMENSION_MM = 32767;
/** addressParts.region обов'язковий, якщо країна відправника АБО одержувача — США, Ірландія чи Канада. */
const REGION_REQUIRED_COUNTRIES: ReadonlySet<string> = new Set(["US", "IE", "CA"]);
/**
 * recipient.registrationAddressRecipient (адреса реєстрації одержувача) обов'язковий для країн з особливими
 * митними вимогами — документація називає Німеччину, Словаччину, Угорщину й Францію («such as» — перелік може бути неповним).
 */
export const REGISTRATION_ADDRESS_COUNTRIES: ReadonlySet<string> = new Set(["DE", "SK", "HU", "FR"]);
/** hsCode: рівно 10 цифр, якщо країна відправника або одержувача — Молдова чи Канада; інакше 8–10 цифр. */
const HS_CODE_10_DIGIT_COUNTRIES: ReadonlySet<string> = new Set(["MD", "CA"]);
/** Коди, для яких документація вимагає measurementCode = kg, кількість ≤ 10 і лише один такий товар в інвойсі. */
const HS_CODES_MEASURED_IN_KG = ["210690", "630900"] as const;

// --- Типи тіла запиту POST /shipments ---

export interface NovaPostAddressParts {
  city?: string;
  region?: string;
  street?: string;
  building?: string;
  postCode?: string;
  note?: string;
}

/** recipient.registrationAddressRecipient: увага — індекс тут `zipCode`, а не `postCode`. */
export interface NovaPostRegistrationAddress {
  city?: string;
  street?: string;
  zipCode?: string;
  building?: string;
  state?: string;
}

export interface NovaPostPartyBody {
  name?: string;
  phone?: string;
  email?: string;
  companyName?: string;
  companyTin?: string;
  eoriCode?: string;
  ioss?: string;
  countryCode?: string;
  divisionNumber?: string;
  addressParts?: NovaPostAddressParts;
  registrationAddressRecipient?: NovaPostRegistrationAddress;
}

export interface NovaPostParcelBody {
  rowNumber: number;
  cargoCategory: "parcel";
  parcelDescription: string;
  insuranceCost: number;
  insuranceCurrencyCode?: string;
  length: number;
  width: number;
  height: number;
  actualWeight: number;
}

export interface NovaPostInvoiceItemBody {
  customerId?: string;
  hsCode?: string;
  name?: string;
  nameEng?: string;
  material?: string;
  materialEng?: string;
  madeInCountryCode?: string;
  producerAndModel?: string;
  actualWeight: number;
  measurementCode: string;
  amount: number;
  cost: number;
}

export interface NovaPostInvoiceBody {
  customerNumber?: string;
  customerCreatedAt?: string;
  type: "Invoice" | "ProformaInvoice";
  incoterm: Incoterm;
  exportReason: (typeof EXPORT_REASONS)[ExportReason];
  cost: number;
  currency?: string;
  payerFeesCustoms?: "Sender" | "Recipient";
  items: NovaPostInvoiceItemBody[];
}

export interface NovaPostCreateShipmentBody {
  status: "ReadyToShip";
  clientOrder: string;
  note: string;
  deliveryType?: NovaPostDeliveryType;
  payerType: NovaPostPayerType;
  payerContractNumber?: string;
  parcels: NovaPostParcelBody[];
  sender: NovaPostPartyBody;
  recipient: NovaPostPartyBody;
  invoice?: NovaPostInvoiceBody;
}

/** Параметри Nova Post з налаштувань, потрібні для створення накладної. */
export interface NovaPostShipmentSettings {
  payerType: NovaPostPayerType;
  payerContractNumber: string;
  /** "" — тариф визначає перевізник. */
  deliveryType: string;
}

// --- Відповіді API (лише поля, які ми читаємо; усі необов'язкові — схема не має required) ---

export interface NovaPostCreatedResponse {
  id?: string | number | null;
  number?: string | null;
  status?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
}

export interface NovaPostShipmentListItem {
  id?: string | number | null;
  number?: string | null;
  clientOrder?: string | null;
  status?: string | null;
  createdAt?: string | null;
  deletedAt?: string | null;
}

export interface NovaPostShipmentList {
  current_page?: number;
  last_page?: number;
  per_page?: number;
  total?: number;
  items?: NovaPostShipmentListItem[] | null;
}

export interface NovaPostCalculationService {
  cost?: number | string | null;
  price?: number | string | null;
  discount?: number | string | null;
  deliveryType?: string | null;
  deliveryTypeName?: string | null;
  serviceName?: string | null;
  recipientPayerFeesCustomsCost?: number | string | null;
  senderPayerFeesCustomsCost?: number | string | null;
}

export interface NovaPostCalculationResult {
  scheduledDeliveryDate?: string | null;
  services?: NovaPostCalculationService[] | null;
}

export interface NovaPostTrackRecord {
  number?: string | null;
  date?: string | null;
  event?: string | null;
  eventName?: string | null;
  eventStatus?: string | null;
  countryCode?: string | null;
  code?: string | number | null;
  settlementName?: string | null;
  divisionName?: string | null;
}

export interface NovaPostCurrentStatus {
  number?: string | null;
  statusCode?: string | number | null;
  status?: string | null;
  statusDate?: string | null;
}

export interface NovaPostFullTracking {
  currentStatus?: NovaPostCurrentStatus[] | null;
  historyOnlineTracking?: NovaPostTrackRecord[] | null;
}

// --- Допоміжне ---

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Видаляє ключі зі значенням undefined (чисте JSON-тіло без «порожніх» полів). */
function compact<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** Довжина в символах (кодових точках), як рахує валідація перевізника (mb_strlen), а не в UTF-16. */
const charLength = (s: string) => [...s].length;

class RequestProblems {
  readonly details: CarrierErrorDetail[] = [];

  add(path: string, message: string): void {
    const field = mapNovaPostErrorField(path);
    this.details.push({ ...(field ? { field } : {}), carrierCode: path, message: `${path}: ${message}` });
  }
}

interface TextRule {
  required?: boolean;
  /** Пояснення для менеджера замість «required» (що саме заповнити). */
  requiredMessage?: string;
  max?: number;
  min?: number;
  pattern?: RegExp;
}

/** Обрізає пробіли по краях; порожнє → undefined. Порушення лімітів → проблема (значення НЕ обрізається). */
function text(value: string | null | undefined, path: string, problems: RequestProblems, rule: TextRule = {}): string | undefined {
  const v = (value ?? "").trim();
  if (!v) {
    if (rule.required) problems.add(path, rule.requiredMessage ?? "required");
    return undefined;
  }
  const len = charLength(v);
  if (rule.max !== undefined && len > rule.max) problems.add(path, `longer than ${rule.max} characters (${len}); shorten it`);
  if (rule.min !== undefined && len < rule.min) problems.add(path, `shorter than ${rule.min} characters`);
  if (rule.pattern && !rule.pattern.test(v)) problems.add(path, "invalid format");
  return v;
}

/** Десятковий рядок грошей → число для JSON (точне: через мінорні одиниці BigInt). */
function moneyNumber(amount: string, path: string, problems: RequestProblems, opts: { positive?: boolean } = {}): number {
  if (!isDecimalString(amount)) {
    problems.add(path, "invalid amount");
    return 0;
  }
  const minor = toMinor(amount);
  if (minor < 0n || (opts.positive && minor === 0n)) problems.add(path, opts.positive ? "must be greater than 0" : "must not be negative");
  if (minor > INVOICE_MAX_MINOR) problems.add(path, "must not exceed 9999999.99");
  return Number(fromMinor(minor));
}

/** Документація: точність ваги 10 г, менші значення перевізник округлює ВНИЗ. Округлюємо вгору самі, щоб не занижувати. */
export const ceilTo10Grams = (grams: number) => Math.ceil(grams / 10) * 10;

/**
 * Розподіл загальної ваги посилок між товарами інвойсу (кроком 10 г).
 * Документація (invoice.items[].actualWeight): сума ваг товарів має ТОЧНО дорівнювати сумі parcels[].actualWeight,
 * інакше помилка валідації. Вага посилки включає пакування, тому кожен товар отримує частку пакування
 * пропорційно своїй вазі нетто (метод найбільших залишків), але не менше 10 г.
 * Немає ваг нетто → рівними частками. Повертає null, якщо загальної ваги не вистачає на 10 г на товар.
 */
export function allocateItemWeights(totalGrams: number, netWeights: readonly number[]): number[] | null {
  const n = netWeights.length;
  if (n === 0) return [];
  const units = BigInt(Math.floor(totalGrams / 10));
  if (units < BigInt(n)) return null;
  const clean = netWeights.map((w) => (Number.isFinite(w) && w > 0 ? BigInt(Math.round(w)) : 0n));
  const sum = clean.reduce((a, b) => a + b, 0n);
  const basis = sum > 0n ? clean : clean.map(() => 1n);
  const basisSum = sum > 0n ? sum : BigInt(n);
  const rest = units - BigInt(n); // по 1 одиниці (10 г) кожному товару гарантовано
  const base = basis.map((w) => (rest * w) / basisSum);
  const remainders = basis.map((w, i) => ({ i, r: (rest * w) % basisSum }));
  let left = rest - base.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  const result = base.map((b) => b + 1n);
  for (const { i } of remainders) {
    if (left <= 0n) break;
    result[i] = result[i]! + 1n;
    left -= 1n;
  }
  return result.map((u) => Number(u) * 10);
}

/** Розподіл суми (мінорні одиниці) між N посилками: рівні частки, залишок — першим. */
function splitMinor(total: bigint, n: number): bigint[] {
  const count = BigInt(n);
  const per = total / count;
  const rem = total % count;
  return Array.from({ length: n }, (_, i) => per + (BigInt(i) < rem ? 1n : 0n));
}

function truncateChars(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

/** Короткий англійський опис вмісту (згенерований нами, не персональні дані — тому його можна скоротити до 255). */
function describeContents(items: readonly CustomsItem[]): string {
  const names = [...new Set(items.map((i) => i.description.trim()).filter(Boolean))];
  // parcelDescription обов'язковий; якщо товарів немає (внутрішнє відправлення без митних даних) — загальний опис.
  return truncateChars(names.join(", ") || "Goods", 255);
}

function cmToMm(cm: number | null, path: string, problems: RequestProblems): number {
  if (cm === null || !Number.isFinite(cm) || cm <= 0) {
    problems.add(path, "parcel dimensions are required");
    return 0;
  }
  const mm = Math.max(1, Math.round(cm * 10));
  if (mm > MAX_DIMENSION_MM) problems.add(path, `must not exceed ${MAX_DIMENSION_MM} mm`);
  return mm;
}

/** Дата інвойсу YYYY-MM-DD → формат документації `Y-m-d\TH:i:s.u\Z` (6 знаків мікросекунд). */
function invoiceDateTime(date: string, problems: RequestProblems): string | undefined {
  const d = date.trim();
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(`${d}T00:00:00Z`))) {
    problems.add("invoice.customerCreatedAt", "invoice date must be YYYY-MM-DD");
    return undefined;
  }
  return `${d}T00:00:00.000000Z`;
}

const BUILDING_REQUIRED =
  'house/building number is required as a separate field: write address line 1 as "Street 12" or "12 Street" (one number only)';

interface AddressRules {
  /** Країна відправника або одержувача — US/IE/CA (документація: region обов'язковий). */
  regionRequired: boolean;
}

/**
 * Адреса без відділення. Документація (рядки addressParts.*): city, street, postCode і building обов'язкові, якщо
 * немає divisionNumber/divisionID; значення вкладених полів не повинні дублювати одне одного — тому вулиця й номер
 * будинку передаються ЛИШЕ окремо (CarrierAddress.street/building, однозначне розділення address1). Не розділено →
 * помилка до запиту (поле address1), а не address1 у двох полях.
 */
function addressParts(address: CarrierAddress, path: string, problems: RequestProblems, rules: AddressRules): NovaPostAddressParts {
  const country = (address.countryCode ?? "").trim().toUpperCase();
  const building = (address.building ?? "").trim();
  return compact({
    city: text(address.city, `${path}.city`, problems, { required: true, max: 100 }),
    region: text(address.province, `${path}.region`, problems, {
      required: rules.regionRequired,
      requiredMessage: "region/state is required for shipments from or to the USA, Ireland or Canada",
      max: 100,
      // США: двобуквений код штату ISO 3166-2:US (напр. "WA").
      pattern: country === "US" ? /^[A-Z]{2}$/ : undefined,
    }),
    street: text(building ? address.street?.trim() || address.address1 : address.address1, `${path}.street`, problems, { required: true, max: 100 }),
    building: text(building, `${path}.building`, problems, { required: true, requiredMessage: BUILDING_REQUIRED, max: 100 }),
    postCode: text(address.postalCode, `${path}.postCode`, problems, { required: true, max: 10 }),
    // address2 (квартира/офіс/примітка) передається як примітка: flat має ліміт 10 символів і не завжди є номером.
    note: text(address.address2, `${path}.note`, problems, { max: 100 }),
  });
}

/**
 * recipient.registrationAddressRecipient для DE/SK/HU/FR — з адреси РЕЄСТРАЦІЇ одержувача (CarrierParty.registrationAddress).
 * Адресу доставки замість неї НЕ підставляємо: чи це допустимо, має підтвердити власник. Немає → помилка до запиту.
 */
function registrationAddress(p: CarrierParty, problems: RequestProblems): NovaPostRegistrationAddress | undefined {
  const path = "recipient.registrationAddressRecipient";
  const reg = p.registrationAddress;
  if (!reg) {
    problems.add(
      path,
      "Nova Post requires the recipient's registered address for shipments to Germany, Slovakia, Hungary and France; it is not available for this order yet",
    );
    return undefined;
  }
  return compact({
    city: text(reg.city, `${path}.city`, problems, { required: true, max: 100 }),
    street: text(reg.street?.trim() || reg.address1, `${path}.street`, problems, { required: true, max: 100 }),
    zipCode: text(reg.postalCode, `${path}.zipCode`, problems, { required: true, max: 10 }),
    building: text(reg.building, `${path}.building`, problems, { required: true, requiredMessage: BUILDING_REQUIRED, max: 100 }),
    state: text(reg.province, `${path}.state`, problems, { max: 100 }),
  });
}

interface PartyOptions {
  ioss: boolean;
  /** Документація: email обов'язковий для відправлень через кордон ЄС або за межі ЄС (тобто будь-яке міжнародне з України). */
  emailRequired: boolean;
  regionRequired: boolean;
}

function party(p: CarrierParty, path: "sender" | "recipient", problems: RequestProblems, opts: PartyOptions): NovaPostPartyBody {
  const branch = (p.branchCode ?? "").trim();
  return compact({
    name: text(p.name, `${path}.name`, problems, { required: true, max: 100 }),
    // Телефон — як є (E.164 після перевірки замовлення). Ліміт 50 — з переліку помилок API.
    phone: text(p.phone, `${path}.phone`, problems, { required: true, max: 50 }),
    email: text(p.email, `${path}.email`, problems, {
      required: opts.emailRequired,
      requiredMessage: "email is required for international shipments",
      max: 255,
    }),
    companyName: text(p.company, `${path}.companyName`, problems, { max: 100 }),
    companyTin: text(p.taxId, `${path}.companyTin`, problems, { max: 20 }),
    eoriCode: text(p.eori, `${path}.eoriCode`, problems, { min: 3, max: 17 }),
    ioss: opts.ioss ? text(p.ioss, `${path}.ioss`, problems, { max: 12, pattern: /^[A-Za-z0-9]+$/ }) : undefined,
    countryCode: text((p.address.countryCode ?? "").toUpperCase(), `${path}.countryCode`, problems, { required: true, pattern: /^[A-Z]{2}$/ }),
    // Відділення (divisionNumber, напр. "32521/1") АБО адреса: документація вимагає одне з двох.
    divisionNumber: branch || undefined,
    addressParts: branch ? undefined : addressParts(p.address, `${path}.addressParts`, problems, { regionRequired: opts.regionRequired }),
    registrationAddressRecipient:
      path === "recipient" && REGISTRATION_ADDRESS_COUNTRIES.has((p.address.countryCode ?? "").trim().toUpperCase())
        ? registrationAddress(p, problems)
        : undefined,
  });
}

/**
 * hsCode (документація): нецифрові символи прибираються перед перевіркою; MD або CA (відправник чи одержувач) —
 * рівно 10 цифр, інші країни — 8–10 цифр. Коди 210690/630900 вимагають measurementCode = kg і кількість у кг —
 * такий формат інвойсу ми не формуємо (кількість у нас — штуки), тому відмова до запиту з поясненням.
 */
function hsCode(raw: string | null | undefined, path: string, problems: RequestProblems, tenDigits: boolean): string | undefined {
  const value = (raw ?? "").trim();
  if (!value) {
    problems.add(path, "required");
    return undefined;
  }
  const digits = value.replace(/\D/g, "");
  if (tenDigits ? digits.length !== 10 : digits.length < 8 || digits.length > 10) {
    problems.add(path, tenDigits ? "HS code must have exactly 10 digits for Moldova or Canada" : "HS code must have 8 to 10 digits (UKT ZED)");
  }
  if (HS_CODES_MEASURED_IN_KG.some((code) => digits.startsWith(code))) {
    problems.add(path, "HS codes 210690/630900 must be declared in kilograms (measurementCode kg); not supported, create this waybill manually");
  }
  return digits || undefined;
}

function buildInvoice(
  req: CreateShipmentRequest,
  customs: CustomsDeclaration,
  totalParcelGrams: number,
  toEu: boolean,
  tenDigitHs: boolean,
  problems: RequestProblems,
): NovaPostInvoiceBody {
  const currency = text(customs.totalValue.currency, "invoice.currency", problems, { required: true, pattern: /^[A-Z]{3}$/ });
  const weights = allocateItemWeights(
    totalParcelGrams,
    req.customsItems.map((i) => (Number.isFinite(i.weightGrams) && i.weightGrams > 0 ? i.weightGrams : 0) * Math.max(0, i.quantity)),
  );
  if (!weights) problems.add("invoice.items", "parcel weight is too small to declare at least 10 g per customs item");

  const items = req.customsItems.map((item, i): NovaPostInvoiceItemBody => {
    const path = `invoice.items.${i}`;
    if (currency && item.unitValue.currency !== currency) problems.add(`${path}.cost`, "all customs items must use the invoice currency");
    if (!Number.isInteger(item.quantity) || item.quantity < 1) problems.add(`${path}.amount`, "quantity must be a positive integer");
    return compact({
      customerId: text(item.sku, `${path}.customerId`, problems),
      hsCode: hsCode(item.hsCode, `${path}.hsCode`, problems, tenDigitHs),
      name: text(item.descriptionLocal?.trim() || item.description, `${path}.name`, problems, { required: true, max: 512 }),
      nameEng: text(item.description, `${path}.nameEng`, problems, { required: true, max: 512 }),
      // Без матеріалу перевізник підставляє власне значення за замовчуванням (документація) — тому лише якщо відомий.
      material: text(item.materialLocal?.trim() || item.material, `${path}.material`, problems, { max: 50 }),
      materialEng: text(item.material, `${path}.materialEng`, problems, { max: 255 }),
      madeInCountryCode: text((item.countryOfOrigin ?? "").toUpperCase(), `${path}.madeInCountryCode`, problems, { pattern: /^[A-Z]{2}$/ }),
      producerAndModel: text(item.producerAndModel, `${path}.producerAndModel`, problems, { max: 255 }),
      actualWeight: weights?.[i] ?? 0,
      // Перелік допустимих measurementCode не документований; "pieces" — значення з офіційного прикладу запиту
      // (чек-лист «Sender's Registration Address for UA–World Direction»). Кількість у нас — штуки
      // (коди 210690/630900, що вимагають kg, відхиляються вище — hsCode()).
      measurementCode: "pieces",
      amount: item.quantity,
      cost: moneyNumber(item.unitValue.amount, `${path}.cost`, problems),
    });
  });

  return compact({
    customerNumber: text(customs.invoiceNumber, "invoice.customerNumber", problems, { required: true, max: 50 }),
    customerCreatedAt: invoiceDateTime(customs.invoiceDate, problems),
    type: customs.invoiceType === "proforma" ? "ProformaInvoice" : "Invoice",
    incoterm: customs.incoterm,
    exportReason: EXPORT_REASONS[customs.exportReason],
    // exportReasonId не передаємо: зіставлення id → причина не документоване («Possible values: 1»).
    cost: moneyNumber(customs.totalValue.amount, "invoice.cost", problems),
    currency,
    // Документація: payerFeesCustoms «обов'язковий і дійсний лише для напрямку UA-EU». DAP — мита платить одержувач, DDP — відправник.
    payerFeesCustoms: toEu ? (customs.incoterm === "DDP" ? "Sender" : "Recipient") : undefined,
    items,
  });
}

/** IOSS — лише для UA → ЄС і внутрішньої вартості до 150 EUR (документація поля sender.ioss). Інша валюта → не перевірити → не передаємо. */
function iossApplicable(req: CreateShipmentRequest, toEu: boolean, international: boolean): boolean {
  const total = req.customs?.totalValue;
  if (!toEu || !international || !total || total.currency !== "EUR" || !isDecimalString(total.amount)) return false;
  if (EU_COUNTRY_CODES.has(req.sender.address.countryCode.toUpperCase())) return false;
  return toMinor(total.amount) <= IOSS_MAX_EUR_MINOR;
}

/**
 * deliveryType: тариф запиту (serviceCode обраної пропозиції) → тариф з налаштувань → не передається (перевізник
 * визначає сам). Передаються ЛИШЕ документовані значення standard/economy/express (помилка API «The selected delivery
 * type is invalid»); UUID тарифу з відповіді розрахунку сюди не потрапляє — інше значення → відмова до запиту.
 */
function resolveDeliveryType(serviceCode: string | null | undefined, configured: string | null | undefined, problems: RequestProblems): NovaPostDeliveryType | undefined {
  const fromRequest = (serviceCode ?? "").trim().toLowerCase();
  if (fromRequest) {
    if (isNovaPostDeliveryType(fromRequest)) return fromRequest;
    problems.add("serviceCode", "selected tariff is not a Nova Post delivery type (standard, economy, express)");
    return undefined;
  }
  const fromSettings = (configured ?? "").trim().toLowerCase();
  if (!fromSettings) return undefined;
  if (isNovaPostDeliveryType(fromSettings)) return fromSettings;
  problems.add("deliveryType", "Nova Post tariff in settings must be standard, economy or express");
  return undefined;
}

/**
 * CreateShipmentRequest → тіло POST /shipments. Кидає CarrierError("rejected") з усіма знайденими проблемами
 * (поле зіставлене з нашою моделлю), якщо дані не відповідають документованим вимогам. Мережі не торкається.
 */
export function buildCreateShipmentBody(req: CreateShipmentRequest, settings: NovaPostShipmentSettings): NovaPostCreateShipmentBody {
  const problems = new RequestProblems();
  const senderCountry = (req.sender.address.countryCode ?? "").trim().toUpperCase();
  const recipientCountry = (req.recipient.address.countryCode ?? "").trim().toUpperCase();
  const international = senderCountry !== recipientCountry;
  const toEu = EU_COUNTRY_CODES.has(recipientCountry);

  // clientOrder — наш стабільний reference (до 50 символів за документацією).
  const clientOrder = text(req.reference, "clientOrder", problems, { required: true, max: 50 }) ?? "";
  const note = text(req.orderNumber, "note", problems, { max: 255 }) ?? "";

  if (!["Sender", "Recipient", "ThirdPerson"].includes(settings.payerType)) problems.add("payerType", "unsupported payer type");
  const payerContractNumber = text(settings.payerContractNumber, "payerContractNumber", problems, { min: 2, max: 20 });
  if (settings.payerType === "ThirdPerson" && !payerContractNumber) problems.add("payerContractNumber", "required for payer type ThirdPerson");
  const deliveryType = resolveDeliveryType(req.serviceCode, settings.deliveryType, problems);

  if (international && !req.customs) problems.add("invoice", "customs data required for an international shipment");
  if (international && req.customs && req.customsItems.length === 0) problems.add("invoice.items", "customs items required for an international shipment");

  if (req.parcels.length === 0) problems.add("parcels", "at least one parcel is required");
  const insuranceCurrency = text(req.declaredValue.currency, "parcels.insuranceCurrencyCode", problems, { required: true, pattern: /^[A-Z]{3}$/ });
  let insurance: bigint[] = [];
  if (!isDecimalString(req.declaredValue.amount)) {
    problems.add("parcels.insuranceCost", "invalid declared value");
  } else if (req.parcels.length > 0) {
    const total = toMinor(req.declaredValue.amount);
    insurance = splitMinor(total > 0n ? total : 0n, req.parcels.length);
    // Документація: insuranceCost «завжди більше 0».
    if (insurance.some((v) => v <= 0n)) problems.add("parcels.insuranceCost", "declared value must be greater than 0");
  }
  const parcelDescription = describeContents(req.customsItems);
  const parcels = req.parcels.map((parcel, i): NovaPostParcelBody => {
    const path = `parcels.${i}`;
    if (!Number.isFinite(parcel.actualWeightGrams) || parcel.actualWeightGrams <= 0) problems.add(`${path}.actualWeight`, "parcel weight is required");
    return compact({
      rowNumber: i + 1,
      cargoCategory: "parcel" as const,
      parcelDescription,
      insuranceCost: Number(fromMinor(insurance[i] ?? 0n)),
      // З кодом валюти сума може бути в будь-якій підтримуваній валюті — перевізник сам перерахує у валюту країни відправника.
      insuranceCurrencyCode: insuranceCurrency,
      length: cmToMm(parcel.lengthCm, `${path}.length`, problems),
      width: cmToMm(parcel.widthCm, `${path}.width`, problems),
      height: cmToMm(parcel.heightCm, `${path}.height`, problems),
      // Фактична вага (об'ємну перевізник рахує сам), кратна 10 г.
      actualWeight: parcel.actualWeightGrams > 0 ? ceilTo10Grams(parcel.actualWeightGrams) : 0,
    });
  });
  const totalParcelGrams = parcels.reduce((sum, p) => sum + p.actualWeight, 0);

  const regionRequired = REGION_REQUIRED_COUNTRIES.has(senderCountry) || REGION_REQUIRED_COUNTRIES.has(recipientCountry);
  const sender = party(req.sender, "sender", problems, { ioss: iossApplicable(req, toEu, international), emailRequired: international, regionRequired });
  const recipient = party(req.recipient, "recipient", problems, { ioss: false, emailRequired: international, regionRequired });
  const tenDigitHs = HS_CODE_10_DIGIT_COUNTRIES.has(senderCountry) || HS_CODE_10_DIGIT_COUNTRIES.has(recipientCountry);
  const invoice = international && req.customs ? buildInvoice(req, req.customs, totalParcelGrams, toEu, tenDigitHs, problems) : undefined;

  if (problems.details.length > 0) {
    const summary = problems.details.map((d) => d.message).join("; ");
    throw new CarrierError("rejected", NOVA_POST_CODE, truncateChars(`Nova Post request is invalid: ${summary}`, 500), problems.details);
  }

  return compact({
    status: "ReadyToShip" as const,
    clientOrder,
    note,
    deliveryType,
    payerType: settings.payerType,
    payerContractNumber,
    parcels,
    sender,
    recipient,
    invoice,
  });
}

// --- Помилки перевізника ---

/** Поле Nova Post → поле нашої моделі (FieldPath). Ключі — у нижньому регістрі (divisionID/divisionId). */
const ERROR_FIELD_MAP: Readonly<Record<string, string>> = {
  "recipient.phone": "shipping.phone",
  // Перелік помилок API прив'язує validation.phone також до ключів recipientPhone/senderPhone.
  recipientphone: "shipping.phone",
  senderphone: "shipper.phone",
  // Ім'я одержувача — це firstName + lastName разом, тому зіставляємо з замовленням загалом.
  "recipient.name": "order",
  "recipient.email": "email",
  "recipient.companyname": "shipping.company",
  "recipient.countrycode": "shipping.countryCode",
  "recipient.addressparts": "shipping.address1",
  "recipient.addressparts.city": "shipping.city",
  "recipient.addressparts.postcode": "shipping.postalCode",
  "recipient.addressparts.street": "shipping.address1",
  "recipient.addressparts.building": "shipping.address1",
  "recipient.addressparts.region": "shipping.province",
  "recipient.addressparts.note": "shipping.address2",
  "recipient.addressparts.flat": "shipping.address2",
  "sender.phone": "shipper.phone",
  "sender.name": "shipper.contactName",
  "sender.email": "shipper.email",
  "sender.companyname": "shipper.companyName",
  "sender.companytin": "shipper.taxId",
  "sender.eoricode": "shipper.eori",
  "sender.ioss": "shipper.ioss",
  "sender.countrycode": "shipper.countryCode",
  "sender.divisionnumber": "shipper.carrierBranch",
  "sender.divisionid": "shipper.carrierBranch",
  "sender.addressparts": "shipper.address1",
  "sender.addressparts.city": "shipper.city",
  "sender.addressparts.postcode": "shipper.postalCode",
  "sender.addressparts.street": "shipper.address1",
  "sender.addressparts.building": "shipper.address1",
  "sender.addressparts.note": "shipper.address2",
  "sender.addressparts.flat": "shipper.address2",
  payertype: "novaPost.payerType",
  payercontractnumber: "novaPost.payerContractNumber",
  deliverytype: "novaPost.deliveryType",
};

/** Ключ помилки Nova Post (напр. "recipient.addressParts.city", "parcels.0.width") → наш FieldPath або undefined. */
export function mapNovaPostErrorField(key: string): string | undefined {
  return ERROR_FIELD_MAP[key.trim().toLowerCase()];
}

function messageOf(v: unknown): string | null {
  if (typeof v === "string") return v.trim().slice(0, 300) || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}

/**
 * Тіло помилки → деталі. Документована схема: {"errors": {<ключ>: string}} (ключі не документовані: шлях поля
 * на кшталт "parcels.0.rowNumber" або "errorMessage"). Розбираємо захисно: значення-масив, масив об'єктів, рядок,
 * {"message": …} (метод перевірки UA→World), або сирий текст.
 */
export function parseNovaPostErrors(body: unknown, fallbackText?: string | null): CarrierErrorDetail[] {
  const out: CarrierErrorDetail[] = [];
  const push = (key: string | null, value: unknown) => {
    const message = messageOf(value);
    if (!message) return;
    const k = key?.trim() || null;
    const field = k ? mapNovaPostErrorField(k) : undefined;
    out.push({ ...(field ? { field } : {}), ...(k ? { carrierCode: k } : {}), message });
  };
  const errors = isObject(body) ? body.errors : undefined;
  if (Array.isArray(errors)) {
    for (const e of errors) {
      if (isObject(e)) {
        const key = [e.field, e.key, e.path, e.code].find((x): x is string => typeof x === "string") ?? null;
        push(key, e.message ?? e.error ?? e.description);
      } else push(null, e);
    }
  } else if (isObject(errors)) {
    for (const [key, value] of Object.entries(errors)) {
      if (Array.isArray(value)) value.forEach((v) => push(key, v));
      else push(key, value);
    }
  } else if (typeof errors === "string") {
    push(null, errors);
  }
  if (out.length === 0 && isObject(body)) push(null, body.message ?? body.error);
  if (out.length === 0 && typeof body === "string") push(null, body);
  if (out.length === 0 && fallbackText) push(null, fallbackText);
  return out.slice(0, 20);
}

/** Короткий текст деталей для повідомлення CarrierError. */
export function summarizeErrorDetails(details: readonly CarrierErrorDetail[]): string {
  return truncateChars(details.map((d) => (d.carrierCode && !d.message.startsWith(d.carrierCode) ? `${d.carrierCode}: ${d.message}` : d.message)).join("; "), 300);
}

// --- Друк документів ---

export const NOVA_POST_PRINT_TYPES: Readonly<Record<CarrierDocumentKind, "marking" | "invoice" | "international">> = {
  label: "marking",
  invoice: "invoice", // комерційний інвойс
  customs_declaration: "international", // митна декларація / інвойс для митниці
};

/**
 * Параметри GET /shipments/print. Документація: для type=marking — РІВНО один номер у запиті;
 * printSizeType: marking → size_100_100 (остаточний формат PDF визначає перевізник), international/invoice → size_A4.
 * deliveryType (Pickup/Shipment, лише для marking) не передаємо: необов'язковий, без нього діє внутрішня логіка друку.
 */
export function buildPrintQuery(kind: CarrierDocumentKind, numbers: readonly string[]): Record<string, string | string[]> {
  const type = NOVA_POST_PRINT_TYPES[kind];
  const list = numbers.map((n) => n.trim()).filter(Boolean);
  if (list.length === 0) throw new CarrierError("rejected", NOVA_POST_CODE, "Nova Post print: shipment number is required");
  if (type === "marking" && list.length !== 1) {
    throw new CarrierError("rejected", NOVA_POST_CODE, "Nova Post prints marking labels for exactly one shipment number per request");
  }
  return { "numbers[]": list, type, printSizeType: type === "marking" ? "size_100_100" : "size_A4" };
}

export function documentFileName(kind: CarrierDocumentKind, waybillNumber: string): string {
  const safe = waybillNumber.replace(/[^A-Za-z0-9_-]/g, "") || "shipment";
  const prefix = kind === "customs_declaration" ? "customs-declaration" : kind;
  return `${prefix}-${safe}.pdf`;
}

/** PDF: за content-type або сигнатурою "%PDF". */
export function looksLikePdf(contentType: string | null, bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const signature = bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  return signature || /^application\/pdf\b/i.test(contentType ?? "");
}

// --- Відправлення: пошук і відповіді ---

function parseDate(value: string | null | undefined): Date | null {
  if (!value || typeof value !== "string") return null;
  let v = value.trim();
  // Документація: дати ISO 8601 в UTC. Без зони — трактуємо як UTC (не як локальний час сервера).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(v)) v = `${v.replace(" ", "T")}Z`;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Відповідь створення/рядок списку → CreatedShipment; без id або номера → null. */
export function toCreatedShipment(item: NovaPostCreatedResponse | NovaPostShipmentListItem, fallbackCreatedAt: Date): CreatedShipment | null {
  const id = typeof item.id === "number" ? String(item.id) : typeof item.id === "string" ? item.id.trim() : "";
  const number = typeof item.number === "string" ? item.number.trim() : "";
  // Номер не перевіряємо за шаблоном ^[A-Z]{4}\d{10}$ зі схеми: для України це 14-значна експрес-накладна.
  if (!id || !number) return null;
  return { carrierShipmentId: id, waybillNumber: number, trackingNumber: number, createdAt: parseDate(item.createdAt) ?? fallbackCreatedAt };
}

/**
 * Чи відповідає clientOrder нашому reference. Документація: clientOrder «може містити всі можливі ідентифікатори замовлення»,
 * формат/роздільник не документовані — збігом вважаємо точний збіг або окремий токен, відокремлений комою/пробілом/крапкою з комою.
 */
export function clientOrderMatches(clientOrder: string | null | undefined, reference: string): boolean {
  if (!clientOrder) return false;
  const value = clientOrder.trim();
  if (value === reference) return true;
  return value.split(/[\s,;]+/).some((token) => token === reference);
}

export function isDeletedListItem(item: NovaPostShipmentListItem): boolean {
  return Boolean(item.deletedAt) || item.status === "Deleted";
}

// --- Розрахунок вартості ---

/** Число/десятковий рядок → мінорні одиниці (округлення half-up до 2 знаків, без накопичення float). */
export function amountToMinor(value: unknown): bigint | null {
  let s: string;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    s = String(value);
    if (/e/i.test(s)) s = value.toFixed(6);
  } else if (typeof value === "string") {
    s = value.trim();
  } else return null;
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const frac = (m[2] ?? "").padEnd(3, "0");
  let minor = BigInt(m[1]!) * 100n + BigInt(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) minor += 1n;
  return minor;
}

/**
 * Перерахунок оголошеної вартості у валюту тарифу (для insuranceCost розрахунку: «у валюті країни відправника»).
 * fxRates — «скільки одиниць валюти перевізника коштує 1 одиниця валюти» (налаштування checkoutRates), до 6 знаків.
 * Округлення вгору до копійки (не занижувати страхову вартість). Немає курсу → null.
 */
export function convertMoney(value: Money, target: string, fxRates?: ReadonlyArray<{ currency: string; rate: string }>): Money | null {
  if (!isDecimalString(value.amount)) return null;
  if (value.currency === target) return { amount: fromMinor(toMinor(value.amount)), currency: target };
  const fx = fxRates?.find((r) => r.currency === value.currency);
  const m = fx ? /^(\d+)(?:\.(\d{1,6}))?$/.exec(fx.rate.trim()) : null;
  if (!m) return null;
  const rate = BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0"));
  if (rate <= 0n) return null;
  const scaled = toMinor(value.amount) * rate;
  const minor = scaled / 1_000_000n + (scaled % 1_000_000n > 0n ? 1n : 0n);
  return { amount: fromMinor(minor), currency: target };
}

export interface QuoteMappingOptions {
  /** Валюта сум розрахунку (у відповіді API валюти немає) — settings.novaPost.tariffCurrency. */
  tariffCurrency: string;
  incoterm: Incoterm;
  /** Чи передавали інвойс (без нього оцінка мит не має сенсу). */
  invoiceSent: boolean;
}

/**
 * Відповідь розрахунку → RateQuote[] (одна пропозиція на тариф). Кілька рядків одного тарифу — сума `cost`
 * (як summarizeCalculation). `cost` — «вартість доставки без мит після персональних знижок».
 * serviceCode — код тарифу з `deliveryTypeName` (документовано: standard/economy/express — саме ці значення приймає
 * deliveryType у POST /shipments). `deliveryType` відповіді — UUID тарифу, у POST /shipments він не документований,
 * тому рядки без документованого deliveryTypeName пропускаються: пропозиція, за якою не можна створити накладну
 * з тим самим тарифом, покупцю не показується.
 * Мита: DDP → senderPayerFeesCustomsCost, DAP → recipientPayerFeesCustomsCost; чи повторюються вони в кожному рядку
 * тарифу — не документовано, тому беремо максимум, а не суму.
 */
export function mapCalculationToQuotes(result: NovaPostCalculationResult | null, opts: QuoteMappingOptions): RateQuote[] {
  const services = Array.isArray(result?.services) ? result.services : [];
  const groups = new Map<NovaPostDeliveryType, { code: NovaPostDeliveryType; name: string; cost: bigint; hasCost: boolean; duties: bigint | null }>();
  for (const s of services) {
    if (!isObject(s)) continue;
    const code = typeof s.deliveryTypeName === "string" ? s.deliveryTypeName.trim().toLowerCase() : "";
    if (!isNovaPostDeliveryType(code)) continue;
    const g = groups.get(code) ?? { code, name: code, cost: 0n, hasCost: false, duties: null };
    const cost = amountToMinor(s.cost);
    if (cost !== null) {
      g.cost += cost;
      g.hasCost = true;
    }
    const duties = amountToMinor(opts.incoterm === "DDP" ? s.senderPayerFeesCustomsCost : s.recipientPayerFeesCustomsCost);
    if (duties !== null) g.duties = g.duties === null || duties > g.duties ? duties : g.duties;
    groups.set(code, g);
  }
  const date = typeof result?.scheduledDeliveryDate === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(result.scheduledDeliveryDate)?.[1] ?? null : null;
  const quotes: RateQuote[] = [];
  for (const g of groups.values()) {
    if (!g.hasCost) continue;
    quotes.push({
      serviceCode: g.code,
      serviceName: g.name,
      price: { amount: fromMinor(g.cost), currency: opts.tariffCurrency },
      minDeliveryDays: null,
      maxDeliveryDays: null,
      estimatedDeliveryDate: date,
      dutiesEstimate: opts.invoiceSent && g.duties !== null ? { amount: fromMinor(g.duties), currency: opts.tariffCurrency } : null,
    });
  }
  return quotes;
}

// --- Відстеження ---

const normNumber = (n: string) => n.replace(/\s+/g, "");

/**
 * Відповідь FullTracking (один об'єкт для всіх номерів, кожен запис має `number`) → знімки для запитаних номерів.
 * Статус — з currentStatus[].statusCode (числовий код, не назва). Події — historyOnlineTracking зі статусом
 * Passed/Now (Future відкидаються), за зростанням дати; записи без дати пропускаються.
 * Номер без поточного статусу й без подій пропускається (невідомий перевізнику).
 */
export function buildTrackingSnapshots(response: NovaPostFullTracking | null, numbers: readonly string[]): TrackingSnapshot[] {
  const current = Array.isArray(response?.currentStatus) ? response.currentStatus.filter((c): c is NovaPostCurrentStatus => isObject(c)) : [];
  const history = Array.isArray(response?.historyOnlineTracking)
    ? response.historyOnlineTracking.filter((r): r is NovaPostTrackRecord => isObject(r))
    : [];
  const out: TrackingSnapshot[] = [];
  for (const requested of numbers) {
    const key = normNumber(requested);
    const records = history.filter((r) => typeof r.number === "string" && normNumber(r.number) === key);
    const events: TrackingEvent[] = [];
    for (const r of records) {
      if (r.eventStatus && r.eventStatus !== "Passed" && r.eventStatus !== "Now") continue;
      const occurredAt = parseDate(r.date);
      if (!occurredAt) continue;
      const code = r.code === null || r.code === undefined || String(r.code).trim() === "" ? null : String(r.code).trim();
      // Місце події — settlementName («населений пункт, де відбувається подія») і divisionName («склад події»).
      // countryCode запису НЕ використовується: документація описує його як країну ВІДПРАВНИКА, а не країну події.
      const settlement = typeof r.settlementName === "string" ? r.settlementName.trim() : "";
      const division = typeof r.divisionName === "string" ? r.divisionName.trim() : "";
      events.push({
        status: mapNovaPostTrackingCode(code),
        code,
        occurredAt,
        location: [settlement, division].filter(Boolean).join(", ") || null,
        description: (typeof r.eventName === "string" && r.eventName.trim()) || (typeof r.event === "string" && r.event.trim()) || null,
      });
    }
    events.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
    const now = current.find((c) => typeof c.number === "string" && normNumber(c.number) === key);
    const last = events[events.length - 1];
    if (!now && !last) continue;
    const statusCode = now && now.statusCode !== null && now.statusCode !== undefined && String(now.statusCode).trim() !== "" ? String(now.statusCode).trim() : null;
    out.push({
      waybillNumber: requested,
      status: now ? mapNovaPostTrackingCode(statusCode) : last!.status,
      carrierStatusCode: now ? statusCode : last!.code,
      carrierStatusText: now ? (typeof now.status === "string" && now.status.trim()) || null : last!.description,
      statusAt: (now ? parseDate(now.statusDate) : null) ?? last?.occurredAt ?? null,
      events,
    });
  }
  return out;
}

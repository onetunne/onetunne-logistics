/**
 * Незалежний інтерфейс інтеграцій перевізників.
 *
 * Кожен перевізник (тестовий, Nova Global, у майбутньому DHL/UPS/DPD/GLS…) — окремий адаптер.
 * Можливості різних перевізників відрізняються, тому адаптер явно декларує `capabilities`,
 * а необов'язкові методи викликаються лише якщо відповідна можливість = true.
 *
 * НЕ додавайте методи, яких немає в підтвердженій документації конкретного перевізника.
 */

export type CarrierCode = string;
export type CarrierMode = "test" | "live";

export interface CarrierCapabilities {
  /** Розрахунок вартості доставки (Checkout/CarrierService). */
  rates: boolean;
  /** Перевірка доступності доставки до країни/адреси. */
  availability: boolean;
  createShipment: boolean;
  updateShipment: boolean;
  cancelShipment: boolean;
  /** Друк накладних/інвойсів у форматі перевізника. */
  documents: boolean;
  tracking: boolean;
  returns: boolean;
  /** Пошук раніше створеного відправлення за нашим reference (потрібно для звірки після збою). */
  findByReference: boolean;
  /**
   * true — відповідь «не знайдено» від findShipmentByReference гарантує, що відправлення
   * НЕ існує (можна безпечно повторити створення). false — потрібен ручний розгляд.
   */
  referenceLookupAuthoritative: boolean;
  /** Види документів, які можна отримати через getDocument (якщо documents = true). */
  documentKinds?: readonly CarrierDocumentKind[];
}

export interface CarrierAddress {
  countryCode: string;
  city: string;
  postalCode: string | null;
  province: string | null;
  address1: string;
  address2: string | null;
  /**
   * Вулиця й номер будинку окремо — лише якщо однозначно виділяються з address1
   * (modules/customs/address-parts.ts). null — не виділено (адаптер вирішує: відмова з поясненням або address1).
   */
  street?: string | null;
  building?: string | null;
}

export interface CarrierParty {
  name: string;
  company: string | null;
  phone: string;
  email: string | null;
  address: CarrierAddress;
  /** Відділення/склад перевізника (для відправника), якщо застосовно. */
  branchCode?: string | null;
  /** Податковий номер компанії (ЄДРПОУ/ІПН) — для митних документів, якщо відомий. */
  taxId?: string | null;
  /** EORI (ЄС), IOSS (ЄС, посилки до 150 EUR) — якщо відомі. */
  eori?: string | null;
  ioss?: string | null;
  /**
   * Адреса реєстрації (не доставки), якщо відома. Nova Post вимагає її для одержувачів у DE/SK/HU/FR
   * (recipient.registrationAddressRecipient). null/відсутня — адаптер не підставляє адресу доставки сам.
   */
  registrationAddress?: CarrierAddress | null;
}

export interface Money {
  /** Десятковий рядок, напр. "49.80". */
  amount: string;
  currency: string;
}

export interface ParcelSpec {
  packageCode: string | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  actualWeightGrams: number;
  volumetricWeightGrams: number | null;
  chargeableWeightGrams: number;
}

export interface CustomsItem {
  sku: string | null;
  /** Опис товару англійською (митний опис). */
  description: string;
  /** Опис товару мовою країни відправлення (укр.), якщо є. */
  descriptionLocal?: string | null;
  hsCode: string;
  countryOfOrigin: string;
  quantity: number;
  unitValue: Money;
  /** Вага ОДНІЄЇ одиниці, г. */
  weightGrams: number;
  /** Основний матеріал англійською / мовою відправника, якщо відомий. */
  material?: string | null;
  materialLocal?: string | null;
  /** Виробник і модель (для техніки), якщо відомі. */
  producerAndModel?: string | null;
}

/** Умови поставки: DAP — мита сплачує одержувач, DDP — відправник. */
export const INCOTERMS = ["DAP", "DDP"] as const;
export type Incoterm = (typeof INCOTERMS)[number];

/** Мета експорту (адаптер зіставляє з кодами перевізника). */
export const EXPORT_REASONS = ["sale", "personal", "repair", "return", "other"] as const;
export type ExportReason = (typeof EXPORT_REASONS)[number];

/** Дані комерційного інвойсу для митного оформлення. */
export interface CustomsDeclaration {
  /** Номер інвойсу (наш), напр. номер замовлення. */
  invoiceNumber: string;
  /** Дата інвойсу, YYYY-MM-DD. */
  invoiceDate: string;
  invoiceType: "commercial" | "proforma";
  incoterm: Incoterm;
  exportReason: ExportReason;
  /** Загальна вартість товарів (валюта інвойсу). */
  totalValue: Money;
}

export interface CreateShipmentRequest {
  /** Наш стабільний ідентифікатор відправлення (ідемпотентність/звірка). */
  reference: string;
  orderNumber: string;
  sender: CarrierParty;
  recipient: CarrierParty;
  parcels: ParcelSpec[];
  customsItems: CustomsItem[];
  declaredValue: Money;
  serviceCode?: string | null;
  /** Митні дані інвойсу (міжнародні відправлення). */
  customs?: CustomsDeclaration | null;
}

export interface CreatedShipment {
  carrierShipmentId: string;
  waybillNumber: string;
  trackingNumber: string | null;
  createdAt: Date;
}

export type LookupResult =
  | { found: true; shipment: CreatedShipment; cancelled: boolean }
  | { found: false; authoritative: boolean };

/**
 * Типи помилок перевізника:
 * - rejected — перевізник точно відхилив запит, накладна НЕ створена (помилка даних, 4xx);
 * - unavailable — запит точно не дійшов до перевізника (немає з'єднання до відправки, вимкнено);
 * - unknown_outcome — запит міг бути виконаний (тайм-аут, 5xx, обрив після відправки) → звірка;
 * - not_supported — можливість не підтримується адаптером;
 * - not_configured — немає ключів/документації (напр. Nova Global до отримання API);
 * - auth — помилка автентифікації.
 */
export type CarrierErrorKind =
  | "rejected"
  | "unavailable"
  | "unknown_outcome"
  | "not_supported"
  | "not_configured"
  | "auth";

export interface CarrierErrorDetail {
  /** Поле, якого стосується помилка (наш FieldPath, якщо адаптер зміг зіставити). */
  field?: string;
  /** Код помилки перевізника. */
  carrierCode?: string;
  message: string;
}

export class CarrierError extends Error {
  constructor(
    readonly kind: CarrierErrorKind,
    readonly carrier: CarrierCode,
    message: string,
    readonly details: CarrierErrorDetail[] = [],
  ) {
    super(message);
    this.name = "CarrierError";
  }

  /** true, якщо перевізник МІГ створити відправлення. */
  get outcomeUnknown(): boolean {
    return this.kind === "unknown_outcome";
  }
}

export interface CarrierCallOptions {
  signal?: AbortSignal;
}

export interface CarrierAdapter {
  readonly code: CarrierCode;
  readonly displayName: string;
  readonly mode: CarrierMode;
  readonly capabilities: CarrierCapabilities;

  createShipment(req: CreateShipmentRequest, opts?: CarrierCallOptions): Promise<CreatedShipment>;
  findShipmentByReference(reference: string, opts?: CarrierCallOptions): Promise<LookupResult>;
  cancelShipment(waybillNumber: string, opts?: CarrierCallOptions): Promise<{ cancelled: boolean }>;

  // --- Додаткові можливості. Викликати лише якщо відповідне capabilities.* = true. ---
  quoteRates?(req: RateRequest, opts?: CarrierCallOptions): Promise<RateQuote[]>;
  checkAvailability?(countryCode: string, opts?: CarrierCallOptions): Promise<{ available: boolean }>;
  /** Пакетне відстеження: результат для кожного знайденого номера (невідомі номери пропускаються). */
  getTracking?(waybillNumbers: string[], opts?: CarrierCallOptions): Promise<TrackingSnapshot[]>;
  /** Документ перевізника (PDF тощо) для створеного відправлення. Види — capabilities.documentKinds. */
  getDocument?(shipment: ShipmentRef, kind: CarrierDocumentKind, opts?: CarrierCallOptions): Promise<CarrierDocument>;
  /** Дані для передачі трек-номера в Shopify (назва перевізника зі списку Shopify і публічне посилання). */
  trackingInfo?(trackingNumber: string): ShopifyTrackingInfo;
}

// --- Типи для додаткових можливостей ---

export interface ShipmentRef {
  carrierShipmentId: string | null;
  waybillNumber: string;
}

export interface RateItem {
  hsCode: string | null;
  quantity: number;
  unitValue: Money;
  weightGrams: number;
}

export interface RateRequest {
  /** Адреса відправника (з налаштувань). */
  origin: CarrierAddress;
  destination: CarrierAddress;
  parcels: ParcelSpec[];
  declaredValue: Money;
  /** Товари (для оцінки мит і податків, якщо перевізник це підтримує). */
  items?: RateItem[];
  incoterm?: Incoterm;
}

export interface RateQuote {
  serviceCode: string;
  serviceName: string;
  price: Money;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
  /** Орієнтовна дата доставки від перевізника (YYYY-MM-DD), якщо є. */
  estimatedDeliveryDate?: string | null;
  /** Оцінка мит/податків, якщо перевізник повертає. */
  dutiesEstimate?: Money | null;
}

export interface ShopifyTrackingInfo {
  /** Назва перевізника для Shopify (бажано зі списку підтримуваних Shopify). */
  company: string;
  number: string;
  url: string | null;
}

export type TrackingStatus =
  | "created"
  | "accepted"
  | "in_transit"
  | "customs"
  | "out_for_delivery"
  | "delivered"
  | "failed_attempt"
  | "returned"
  | "lost"
  | "exception"
  | "cancelled"
  | "unknown";

export interface TrackingEvent {
  status: TrackingStatus;
  /** Код статусу перевізника (стабільний, на ньому будується логіка адаптера). */
  code: string | null;
  occurredAt: Date;
  location: string | null;
  description: string | null;
}

export interface TrackingSnapshot {
  waybillNumber: string;
  status: TrackingStatus;
  carrierStatusCode: string | null;
  carrierStatusText: string | null;
  /** Час останньої зміни статусу у перевізника. */
  statusAt: Date | null;
  /** Події в хронологічному порядку (найстаріша перша). */
  events: TrackingEvent[];
}

export const CARRIER_DOCUMENT_KINDS = ["label", "invoice", "customs_declaration"] as const;
export type CarrierDocumentKind = (typeof CARRIER_DOCUMENT_KINDS)[number];

export interface CarrierDocument {
  kind: CarrierDocumentKind;
  format: "pdf" | "zpl" | "png";
  contentType: string;
  content: Uint8Array;
  fileName: string;
}

export interface CarrierRegistry {
  get(code: CarrierCode): CarrierAdapter | undefined;
  list(): CarrierAdapter[];
  /** Перевізник за замовчуванням для створення накладних (з налаштувань). */
  getDefault(): CarrierAdapter | undefined;
}

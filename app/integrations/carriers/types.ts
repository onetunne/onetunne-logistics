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
}

export interface CarrierAddress {
  countryCode: string;
  city: string;
  postalCode: string | null;
  province: string | null;
  address1: string;
  address2: string | null;
}

export interface CarrierParty {
  name: string;
  company: string | null;
  phone: string;
  email: string | null;
  address: CarrierAddress;
  /** Відділення/склад перевізника (для відправника), якщо застосовно. */
  branchCode?: string | null;
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
  description: string;
  hsCode: string;
  countryOfOrigin: string;
  quantity: number;
  unitValue: Money;
  weightGrams: number;
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

  // --- Заплановані можливості (етап 3+). Викликати лише якщо capabilities.* = true. ---
  quoteRates?(req: RateRequest, opts?: CarrierCallOptions): Promise<RateQuote[]>;
  checkAvailability?(countryCode: string, opts?: CarrierCallOptions): Promise<{ available: boolean }>;
  getTracking?(waybillNumber: string, opts?: CarrierCallOptions): Promise<TrackingEvent[]>;
  getDocuments?(waybillNumber: string, opts?: CarrierCallOptions): Promise<CarrierDocument[]>;
}

// --- Типи для запланованих можливостей ---

export interface RateRequest {
  destination: CarrierAddress;
  parcels: ParcelSpec[];
  declaredValue: Money;
}

export interface RateQuote {
  serviceCode: string;
  serviceName: string;
  price: Money;
  minDeliveryDays: number | null;
  maxDeliveryDays: number | null;
}

export type TrackingStatus =
  | "accepted"
  | "in_transit"
  | "customs"
  | "out_for_delivery"
  | "delivered"
  | "failed_attempt"
  | "returned"
  | "lost"
  | "unknown";

export interface TrackingEvent {
  status: TrackingStatus;
  occurredAt: Date;
  location: string | null;
  description: string | null;
}

export interface CarrierDocument {
  kind: "label" | "invoice" | "customs_declaration";
  format: "pdf" | "zpl" | "png";
  url: string | null;
  content: Uint8Array | null;
}

export interface CarrierRegistry {
  get(code: CarrierCode): CarrierAdapter | undefined;
  list(): CarrierAdapter[];
  /** Перевізник за замовчуванням для створення накладних (з налаштувань). */
  getDefault(): CarrierAdapter | undefined;
}

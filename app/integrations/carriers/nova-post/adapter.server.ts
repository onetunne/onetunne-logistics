/**
 * Адаптер Nova Post API v1.0 (міжнародні відправлення з України; ендпоінт для клієнтів з України —
 * https://api.novaposhta.ua/v.1.0). Реалізує CarrierAdapter.
 *
 * Методи API (https://api-portal.novapost.com):
 * - POST /shipments — створення накладної (cross-border shipments from Ukraine);
 * - GET /shipments — список відправлень (фільтра за clientOrder НЕМАЄ → пошук за reference переглядає сторінки
 *   і НЕ є авторитетним: «не знайдено» не гарантує відсутність);
 * - DELETE /shipments/{id} — видалення (для України — Ref ID або 14-значний номер експрес-накладної);
 * - GET /shipments/print — PDF (marking — етикетка, invoice — комерційний інвойс, international — митна декларація);
 * - GET /shipments/tracking — FullTracking;
 * - POST /shipments/calculations — розрахунок вартості (нічого не створює).
 *
 * Безпека: справжні накладні створюються ЛИШЕ коли allowShipmentCreation = true (власник вмикає
 * NOVA_POST_SHIPMENTS_ENABLED=true). Інакше createShipment кидає not_configured без жодного мережевого запиту.
 * Персональні дані й секрети не логуються; тексти помилок — через safeErrorText клієнта.
 */
import { fromMinor, toMinor } from "~/lib/money";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierCallOptions,
  type CarrierCapabilities,
  type CarrierDocument,
  type CarrierDocumentKind,
  type CreatedShipment,
  type CreateShipmentRequest,
  type ExportReason,
  type Incoterm,
  type LookupResult,
  type RateQuote,
  type RateRequest,
  type ShipmentRef,
  type ShopifyTrackingInfo,
  type TrackingSnapshot,
} from "../types";
import { buildCalculationRequest, type CalculationInput } from "./calculations";
import { isTransientGatewayMessage, type NovaPostClient, type NovaPostResponse } from "./client.server";
import {
  EU_COUNTRY_CODES,
  NOVA_POST_CODE,
  buildCreateShipmentBody,
  buildPrintQuery,
  buildTrackingSnapshots,
  clientOrderMatches,
  convertMoney,
  documentFileName,
  isDeletedListItem,
  isNovaPostDeliveryType,
  looksLikePdf,
  mapCalculationToQuotes,
  parseNovaPostErrors,
  summarizeErrorDetails,
  toCreatedShipment,
  type NovaPostCalculationResult,
  type NovaPostCreateShipmentBody,
  type NovaPostCreatedResponse,
  type NovaPostFullTracking,
  type NovaPostPayerType,
  type NovaPostShipmentList,
  type NovaPostShipmentListItem,
} from "./mapping";

export { NOVA_POST_CODE } from "./mapping";

export const NOVA_POST_SHIPMENTS_DISABLED_MESSAGE =
  "Nova Post waybill creation is disabled: real waybills are created only after the owner enables it (NOVA_POST_SHIPMENTS_ENABLED=true)";

/** Розмір пакета номерів для FullTracking: ліміт не документований — консервативно 20. */
export const NOVA_POST_TRACKING_BATCH = 20;
/** Пошук за reference: limit 100 (помилки API: «must not be greater than 100»), не більше 5 сторінок. */
export const NOVA_POST_LOOKUP_PAGE_SIZE = 100;
export const NOVA_POST_LOOKUP_MAX_PAGES = 5;

/** Налаштування, потрібні адаптеру (структурно сумісні з AllSettings). */
export interface NovaPostAdapterSettings {
  novaPost: {
    payerType: NovaPostPayerType;
    payerContractNumber: string;
    deliveryType: string;
    tariffCurrency: string;
  };
  customs: {
    incoterm: Incoterm;
    exportReason: ExportReason;
    invoiceType: "commercial" | "proforma";
  };
  /** Для розрахунку: відділення відправника (divisionNumber) і реквізити юрособи (індивідуальна знижка). */
  shipper?: { companyName?: string; taxId?: string; carrierBranch?: string };
  /** Курси «одиниць валюти перевізника за 1 одиницю валюти» — перерахунок оголошеної вартості в розрахунку. */
  checkoutRates?: { fxRates: ReadonlyArray<{ currency: string; rate: string }> };
}

export interface NovaPostAdapterOptions {
  client: NovaPostClient;
  settings: () => Promise<NovaPostAdapterSettings>;
  /** true — дозволено створювати СПРАВЖНІ накладні (NOVA_POST_SHIPMENTS_ENABLED=true). */
  allowShipmentCreation: boolean;
  now?: () => Date;
}

const DOCUMENT_KINDS: readonly CarrierDocumentKind[] = ["label", "invoice", "customs_declaration"];

type ErrorDetails = ReturnType<typeof parseNovaPostErrors>;

function hasMessage(details: ErrorDetails, needle: string): boolean {
  return details.some((d) => d.message.toLowerCase().includes(needle));
}

/**
 * Документовані тимчасові збої шлюзу (сторінка API errors, без прив'язки до методу): 422 «Cid profile timeout»
 * (тимчасовий збій отримання профілю клієнта під час авторизації) і 400 «Internal TypeError error» (внутрішня помилка
 * обробки на боці сервісу). Це НЕ відмова в даних.
 */
function isTransientGatewayError(details: ErrorDetails): boolean {
  return details.some((d) => isTransientGatewayMessage(d.message));
}

/** 422 «Cid profile not found» — профіль клієнта для токена не знайдено (помилка облікового запису, не даних). */
function isProfileError(details: ErrorDetails): boolean {
  return hasMessage(details, "cid profile not found");
}

/** Ключі загального повідомлення у {"errors": {...}} — не поле запиту. */
const GENERIC_ERROR_KEYS = new Set(["", "errormessage", "message", "error"]);

/**
 * 400 від POST /shipments доводить, що запит відхилено ДО обробки, лише якщо тіло містить помилки полів
 * або документоване «Invalid JSON format». Інший документований 400 — «Internal TypeError error» (внутрішня помилка
 * сервісу) — не гарантує, що відправлення не збережено.
 */
function isClientSide400(details: ErrorDetails): boolean {
  return details.some(
    (d) => (d.carrierCode !== undefined && !GENERIC_ERROR_KEYS.has(d.carrierCode.trim().toLowerCase())) || /^invalid json format\.?$/i.test(d.message.trim()),
  );
}

/** Класифікація відповіді методу читання/зміни (не створення). */
function readError(action: string, res: NovaPostResponse<unknown> | { status: number; errorBody: unknown; errorText: string | null }): CarrierError {
  const details = parseNovaPostErrors(res.errorBody, res.errorText);
  const text = summarizeErrorDetails(details);
  const message = `Nova Post ${action} failed (${res.status})${text ? `: ${text}` : ""}`;
  if (res.status === 401 || res.status === 403 || isProfileError(details)) return new CarrierError("auth", NOVA_POST_CODE, message, details);
  if (res.status === 429 || res.status >= 500 || res.status < 400 || isTransientGatewayError(details)) {
    return new CarrierError("unavailable", NOVA_POST_CODE, message, details);
  }
  return new CarrierError("rejected", NOVA_POST_CODE, message, details);
}

export class NovaPostAdapter implements CarrierAdapter {
  readonly code = NOVA_POST_CODE;
  readonly displayName = "Nova Post";
  readonly mode = "live" as const;
  readonly capabilities: CarrierCapabilities;
  private readonly client: NovaPostClient;
  private readonly loadSettings: () => Promise<NovaPostAdapterSettings>;
  private readonly allowShipmentCreation: boolean;
  private readonly now: () => Date;

  constructor(opts: NovaPostAdapterOptions) {
    this.client = opts.client;
    this.loadSettings = opts.settings;
    this.allowShipmentCreation = opts.allowShipmentCreation;
    this.now = opts.now ?? (() => new Date());
    this.capabilities = {
      rates: true,
      availability: false,
      createShipment: opts.allowShipmentCreation,
      updateShipment: false,
      cancelShipment: true,
      documents: true,
      tracking: true,
      returns: false,
      findByReference: true,
      referenceLookupAuthoritative: false,
      documentKinds: DOCUMENT_KINDS,
    };
  }

  /** Налаштування до будь-якого запиту: збій читання → "unavailable" (до перевізника нічого не відправлено). */
  private async settings(): Promise<NovaPostAdapterSettings> {
    try {
      return await this.loadSettings();
    } catch (e) {
      throw new CarrierError("unavailable", NOVA_POST_CODE, `Nova Post settings unavailable: ${e instanceof Error ? e.name : "error"}`);
    }
  }

  async createShipment(req: CreateShipmentRequest, opts?: CarrierCallOptions): Promise<CreatedShipment> {
    if (!this.allowShipmentCreation) throw new CarrierError("not_configured", NOVA_POST_CODE, NOVA_POST_SHIPMENTS_DISABLED_MESSAGE);
    const settings = await this.settings();
    let body: NovaPostCreateShipmentBody;
    try {
      body = buildCreateShipmentBody(req, settings.novaPost);
    } catch (e) {
      if (e instanceof CarrierError) throw e;
      // Непередбачена помилка зіставлення — запит не відправлено, накладна точно не створена.
      throw new CarrierError("rejected", NOVA_POST_CODE, `Nova Post request could not be built: ${e instanceof Error ? e.name : "error"}`);
    }

    // Мережева помилка/тайм-аут ПІСЛЯ початку відправки → unknown_outcome (перевізник міг створити накладну).
    const res = await this.client.request<NovaPostCreatedResponse>("POST", "/shipments", body, {
      signal: opts?.signal,
      networkErrorKind: "unknown_outcome",
    });

    if (res.status >= 200 && res.status < 300) {
      const created = res.body && typeof res.body === "object" ? toCreatedShipment(res.body, this.now()) : null;
      if (!created) {
        throw new CarrierError("unknown_outcome", NOVA_POST_CODE, `Nova Post returned ${res.status} without shipment id/number`);
      }
      return created;
    }
    throw classifyCreateFailure(res.status, parseNovaPostErrors(res.errorBody, res.errorText));
  }

  /**
   * Пошук за нашим reference (clientOrder) — перегляд сторінок GET /shipments (limit 100, до 5 сторінок).
   * Порядок сортування списку не документований, тому «не знайдено» завжди НЕ авторитетне.
   * Якщо API вимагає numbers[]/ids[] (у переліку помилок є «numbers field is required when ids is not present»,
   * метод не вказано) — помилка → викликач переводить відправлення на ручний розгляд.
   */
  async findShipmentByReference(reference: string, opts?: CarrierCallOptions): Promise<LookupResult> {
    let cancelledMatch: NovaPostShipmentListItem | null = null;
    // true — переглянуто ВСІ сторінки (до числового last_page). Лише тоді видалений збіг означає «скасовано»:
    // активне відправлення з тим самим clientOrder могло лишитися на непереглянутій сторінці.
    let scannedAll = false;
    for (let page = 1; page <= NOVA_POST_LOOKUP_MAX_PAGES; page++) {
      const res = await this.client.request<NovaPostShipmentList>("GET", "/shipments", undefined, {
        query: { limit: NOVA_POST_LOOKUP_PAGE_SIZE, page },
        signal: opts?.signal,
      });
      if (res.status !== 200 || !res.body || typeof res.body !== "object") throw readError("shipment lookup", res);
      const items = Array.isArray(res.body.items) ? res.body.items : [];
      for (const item of items) {
        if (!item || typeof item !== "object" || !clientOrderMatches(item.clientOrder, reference)) continue;
        if (isDeletedListItem(item)) {
          cancelledMatch ??= item;
          continue;
        }
        const shipment = toCreatedShipment(item, this.now());
        if (!shipment) throw new CarrierError("unavailable", NOVA_POST_CODE, "Nova Post lookup: matching shipment has no id/number");
        return { found: true, cancelled: false, shipment };
      }
      const lastPage = typeof res.body.last_page === "number" && Number.isInteger(res.body.last_page) ? res.body.last_page : null;
      if (lastPage !== null && page >= lastPage) {
        scannedAll = true;
        break;
      }
      // Без last_page або порожня сторінка до last_page — зупиняємось, але перегляд НЕ вважається повним.
      if (lastPage === null || items.length === 0) break;
    }
    if (cancelledMatch && scannedAll) {
      const shipment = toCreatedShipment(cancelledMatch, this.now());
      if (shipment) return { found: true, cancelled: true, shipment };
    }
    return { found: false, authoritative: false };
  }

  /**
   * Видалення накладної: DELETE /shipments/{номер}. Документація для України: Ref ID (GUID) або 14-значний номер
   * (таблиця методів містить застарілу суперечливу примітку «лише Ref»). Повторне видалення → 422 shipment_was_deleted
   * (вважаємо скасованою). Інші 4xx-відмови (стан не дозволяє, «deletion not allowed») → { cancelled: false }.
   */
  async cancelShipment(waybillNumber: string, opts?: CarrierCallOptions): Promise<{ cancelled: boolean }> {
    const number = waybillNumber.trim();
    if (!number) throw new CarrierError("rejected", NOVA_POST_CODE, "Nova Post cancel: waybill number is required");
    const res = await this.client.request<unknown>("DELETE", `/shipments/${encodeURIComponent(number)}`, undefined, { signal: opts?.signal });
    if (res.status >= 200 && res.status < 300) return { cancelled: true };
    const details = parseNovaPostErrors(res.errorBody, res.errorText);
    if (res.status === 404) throw new CarrierError("rejected", NOVA_POST_CODE, "shipment not found at Nova Post", details);
    // Тимчасовий збій шлюзу / профілю — не відмова перевізника скасувати.
    if (isTransientGatewayError(details) || isProfileError(details)) throw readError("cancel shipment", res);
    if ([400, 409, 422].includes(res.status)) {
      if (hasMessage(details, "shipment_was_deleted")) return { cancelled: true };
      return { cancelled: false };
    }
    throw readError("cancel shipment", res);
  }

  async getDocument(shipment: ShipmentRef, kind: CarrierDocumentKind, opts?: CarrierCallOptions): Promise<CarrierDocument> {
    if (!DOCUMENT_KINDS.includes(kind)) throw new CarrierError("not_supported", NOVA_POST_CODE, `Nova Post document kind not supported: ${kind}`);
    const query = buildPrintQuery(kind, [shipment.waybillNumber]);
    const res = await this.client.requestBinary("/shipments/print", { query, signal: opts?.signal });
    if (res.status >= 200 && res.status < 300) {
      const bytes = res.bytes ?? new Uint8Array(0);
      if (!looksLikePdf(res.contentType, bytes)) {
        throw new CarrierError("unavailable", NOVA_POST_CODE, `Nova Post print returned a non-PDF response (${res.contentType ?? "no content-type"})`);
      }
      return {
        kind,
        format: "pdf",
        contentType: "application/pdf",
        content: bytes,
        fileName: documentFileName(kind, shipment.waybillNumber),
      };
    }
    throw readError("print", res);
  }

  /** FullTracking пакетами по NOVA_POST_TRACKING_BATCH. 404/422 для пакета → повтор по одному номеру; для одного номера → пропуск. */
  async getTracking(waybillNumbers: string[], opts?: CarrierCallOptions): Promise<TrackingSnapshot[]> {
    const numbers = [...new Set(waybillNumbers.map((n) => n.trim()).filter(Boolean))];
    const out: TrackingSnapshot[] = [];
    for (let i = 0; i < numbers.length; i += NOVA_POST_TRACKING_BATCH) {
      out.push(...(await this.trackChunk(numbers.slice(i, i + NOVA_POST_TRACKING_BATCH), opts)));
    }
    return out;
  }

  private async trackChunk(numbers: string[], opts?: CarrierCallOptions): Promise<TrackingSnapshot[]> {
    const res = await this.client.request<NovaPostFullTracking>("GET", "/shipments/tracking", undefined, {
      query: { "numbers[]": numbers },
      signal: opts?.signal,
    });
    if (res.status === 200) return buildTrackingSnapshots(res.body, numbers);
    if (res.status === 404 || res.status === 422) {
      // Поведінка для невідомих номерів у пакеті не документована: не втрачаємо відомі номери через один невідомий.
      if (numbers.length === 1) return [];
      const out: TrackingSnapshot[] = [];
      for (const n of numbers) out.push(...(await this.trackChunk([n], opts)));
      return out;
    }
    throw readError("tracking", res);
  }

  /**
   * Розрахунок вартості (POST /shipments/calculations). Суми у відповіді без валюти → settings.novaPost.tariffCurrency
   * (лише для читання відповіді). insuranceCost документовано «у валюті країни відправника» (поля валюти для розрахунку
   * немає) — це окреме від tariffCurrency поняття: оголошена вартість перераховується саме у валюту країни відправника.
   */
  async quoteRates(req: RateRequest, opts?: CarrierCallOptions): Promise<RateQuote[]> {
    const settings = await this.settings();
    const np = settings.novaPost;
    const incoterm = req.incoterm ?? settings.customs.incoterm;
    if (req.parcels.length === 0) throw new CarrierError("rejected", NOVA_POST_CODE, "Nova Post calculation: at least one parcel is required");
    const insured = insuranceInSenderCurrency(req, np.tariffCurrency, settings.checkoutRates?.fxRates);
    const insuranceMinor = toMinor(insured.amount);
    const parcelsCount = BigInt(req.parcels.length);
    // Документація: insuranceCost строго більше 0.
    if (insuranceMinor < parcelsCount) {
      throw new CarrierError("rejected", NOVA_POST_CODE, "Nova Post calculation: declared value must be greater than 0");
    }
    const branch = settings.shipper?.carrierBranch?.trim() || null;
    const contract = (np.payerContractNumber ?? "").trim() || null;
    const deliveryType = (np.deliveryType ?? "").trim().toLowerCase();
    const international = req.origin.countryCode.toUpperCase() !== req.destination.countryCode.toUpperCase();
    const toEu = EU_COUNTRY_CODES.has(req.destination.countryCode.toUpperCase());
    const invoice = international ? rateInvoice(req, incoterm, toEu) : undefined;

    const input: CalculationInput = {
      senderCountry: req.origin.countryCode,
      senderDivisionNumber: branch,
      senderCity: branch ? null : req.origin.city,
      senderPostCode: branch ? null : req.origin.postalCode,
      recipientCountry: req.destination.countryCode,
      recipientCity: req.destination.city,
      recipientPostCode: req.destination.postalCode,
      recipientRegion: req.destination.province,
      parcels: req.parcels.map((p, i) => {
        const share = insuranceMinor / parcelsCount + (BigInt(i) < insuranceMinor % parcelsCount ? 1n : 0n);
        return {
          weightGrams: p.actualWeightGrams,
          lengthMm: (p.lengthCm ?? 0) * 10,
          widthMm: (p.widthCm ?? 0) * 10,
          heightMm: (p.heightCm ?? 0) * 10,
          insuranceCost: Number(fromMinor(share)),
        };
      }),
      payerType: np.payerType,
      payerContractNumber: contract,
      // Документація: при платнику-відправнику юрособі companyTin + companyName застосовують індивідуальну знижку.
      senderCompanyTin: np.payerType === "Sender" && settings.shipper?.taxId && settings.shipper.companyName ? settings.shipper.taxId : null,
      senderCompanyName: np.payerType === "Sender" && settings.shipper?.taxId && settings.shipper.companyName ? settings.shipper.companyName : null,
      // Тариф з налаштувань (якщо задано документоване значення); інакше перевізник обирає сам.
      deliveryTypes: isNovaPostDeliveryType(deliveryType) ? [deliveryType] : undefined,
      invoice,
    };
    if (input.parcels.some((p) => p.lengthMm <= 0 || p.widthMm <= 0 || p.heightMm <= 0 || p.weightGrams <= 0)) {
      throw new CarrierError("rejected", NOVA_POST_CODE, "Nova Post calculation: parcel dimensions and weight are required");
    }
    const res = await this.client.request<NovaPostCalculationResult>("POST", "/shipments/calculations", buildCalculationRequest(input), {
      signal: opts?.signal,
    });
    if (res.status !== 200 || !res.body) throw readError("calculation", res);
    const quotes = mapCalculationToQuotes(res.body, { tariffCurrency: np.tariffCurrency, incoterm, invoiceSent: Boolean(invoice) });
    // Варіант B (рішення власника): один тариф із налаштувань — і в Checkout, і в накладній. Інші тарифи не показуються,
    // навіть якщо API їх повернув.
    return isNovaPostDeliveryType(deliveryType) ? quotes.filter((q) => q.serviceCode === deliveryType) : quotes;
  }

  /**
   * Дані для Shopify. Nova Post/Nova Poshta немає в списку перевізників Shopify (перевірено за документацією
   * FulfillmentTrackingInfo), тому company — довільний текст, а посилання — з шаблону в налаштуваннях відстеження
   * (публічна адреса відстеження в документації Nova Post API не наведена).
   */
  trackingInfo(trackingNumber: string): ShopifyTrackingInfo {
    return { company: "Nova Post", number: trackingNumber, url: null };
  }
}

/**
 * Помилка POST /shipments → CarrierError. Головне питання — чи МІГ перевізник зберегти відправлення:
 * - 401/403, 422 «Cid profile not found» → auth; 429, 422 «Cid profile timeout» → unavailable (запит не оброблено);
 * - 408, 5xx (502 «timeout error», 503 «Connection time-out»), 409 (не документований для цього методу — «конфлікт» може
 *   означати, що відправлення вже існує) і 400 без доказу помилки клієнта (документований 400 «Internal TypeError error» —
 *   внутрішня помилка сервісу) → unknown_outcome: звірка, а не повтор з тим самим reference;
 * - 400 з помилками полів або «Invalid JSON format», 404, 422 та інші 4xx → rejected (накладна не створена).
 */
function classifyCreateFailure(status: number, details: ErrorDetails): CarrierError {
  const text = summarizeErrorDetails(details);
  const message = `Nova Post create shipment failed (${status})${text ? `: ${text}` : ""}`;
  if (status === 401 || status === 403 || (status === 422 && isProfileError(details))) return new CarrierError("auth", NOVA_POST_CODE, message, details);
  if (status === 429 || (status === 422 && hasMessage(details, "cid profile timeout"))) return new CarrierError("unavailable", NOVA_POST_CODE, message, details);
  if (status === 408 || status === 409 || status >= 500 || status < 400 || (status === 400 && !isClientSide400(details))) {
    return new CarrierError("unknown_outcome", NOVA_POST_CODE, message, details);
  }
  return new CarrierError("rejected", NOVA_POST_CODE, message, details);
}

/** Валюта країни відправника для insuranceCost розрахунку. Адаптер працює з ендпоінтом для клієнтів з України. */
const SENDER_COUNTRY_CURRENCY: Readonly<Record<string, string>> = { UA: "UAH" };

/**
 * Оголошена вартість → валюта країни відправника. Курси checkoutRates.fxRates задані відносно tariffCurrency
 * («одиниць валюти перевізника за 1 одиницю валюти»), тому перерахунок можливий, лише коли вартість уже у валюті
 * відправника або tariffCurrency = валюта відправника. Інакше — not_configured (без запиту), а не сума в чужій валюті.
 */
function insuranceInSenderCurrency(
  req: RateRequest,
  tariffCurrency: string,
  fxRates: ReadonlyArray<{ currency: string; rate: string }> | undefined,
): { amount: string; currency: string } {
  const origin = req.origin.countryCode.trim().toUpperCase();
  const senderCurrency = SENDER_COUNTRY_CURRENCY[origin];
  if (!senderCurrency) {
    throw new CarrierError("not_configured", NOVA_POST_CODE, `Nova Post calculation: sender-country currency for ${origin || "?"} is not known`);
  }
  const declared = req.declaredValue;
  const converted =
    declared.currency === senderCurrency || tariffCurrency === senderCurrency ? convertMoney(declared, senderCurrency, fxRates) : null;
  if (!converted) {
    throw new CarrierError(
      "not_configured",
      NOVA_POST_CODE,
      tariffCurrency === senderCurrency || declared.currency === senderCurrency
        ? `Nova Post calculation: no exchange rate ${declared.currency} → ${senderCurrency} for the declared value`
        : `Nova Post calculation: the declared value must be converted to ${senderCurrency} (sender-country currency), but exchange rates are set against ${tariffCurrency}`,
    );
  }
  return converted;
}

/**
 * Інвойс для розрахунку мит: лише для міжнародних відправлень, якщо cost ≥ 1 (мінімум у документації).
 * Товари — лише коли в усіх є HS-код і валюта інвойсу (items[].hsCode/amount/cost обов'язкові, якщо items передано).
 * Без товарів інвойс потрібен тільки для DDP («cost required if incoterm = DDP»).
 */
function rateInvoice(req: RateRequest, incoterm: Incoterm, toEu: boolean): CalculationInput["invoice"] {
  const cost = Number(req.declaredValue.amount);
  if (!Number.isFinite(cost) || cost < 1 || !/^[A-Z]{3}$/.test(req.declaredValue.currency)) return undefined;
  const items =
    req.items && req.items.length > 0 && req.items.every((i) => i.hsCode && i.unitValue.currency === req.declaredValue.currency)
      ? req.items.map((i) => ({ hsCode: i.hsCode!, amount: i.quantity, cost: Number(i.unitValue.amount) }))
      : undefined;
  if (!items && incoterm !== "DDP") return undefined;
  return {
    incoterm,
    currency: req.declaredValue.currency,
    cost,
    payerFeesCustoms: toEu ? (incoterm === "DDP" ? "Sender" : "Recipient") : undefined,
    items,
  };
}

/**
 * Тестовий перевізник (sandbox, mode "test").
 *
 * Поводиться як справжній перевізник: базова перевірка запиту, ідемпотентність за reference,
 * пошук за reference (авторитетний), скасування. Імітація збоїв керується налаштуванням
 * testCarrier.simulation — для перевірки захисту від дублікатів і звірки після збою.
 * Реальних зовнішніх запитів не робить.
 */
import { createHash } from "node:crypto";
import type { TestCarrierSimulation } from "~/modules/settings/schema";
import { SandboxWaybillConflictError, type SandboxPayload, type SandboxRecord, type SandboxStore } from "./sandbox-store";
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierCallOptions,
  type CarrierCapabilities,
  type CarrierErrorDetail,
  type CarrierErrorKind,
  type CreatedShipment,
  type CreateShipmentRequest,
  type LookupResult,
} from "./types";

export const TEST_CARRIER_CODE = "test";

const PHONE_RE = /^\+[1-9]\d{6,14}$/;
const HS_CODE_RE = /^\d{6,10}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;
/** Ліміт спроб підбору вільного номера накладної (на практиці колізії поодинокі). */
const MAX_WAYBILL_ATTEMPTS = 50;

/**
 * Детермінований номер накладної: "TEST" + 10 цифр із sha256(reference)
 * (attempt ≥ 1 → sha256(reference + ":" + attempt) — при колізії з іншим reference).
 */
export function deriveTestWaybillNumber(reference: string, attempt = 0): string {
  const input = attempt === 0 ? reference : `${reference}:${attempt}`;
  const hex = createHash("sha256").update(input, "utf8").digest("hex");
  const digits = (BigInt(`0x${hex.slice(0, 16)}`) % 10_000_000_000n).toString().padStart(10, "0");
  return `TEST${digits}`;
}

/** Мінімізований payload для sandbox-сховища: без імен, телефонів та адрес. */
export function toSandboxPayload(req: CreateShipmentRequest): SandboxPayload {
  return {
    orderNumber: req.orderNumber,
    parcelCount: req.parcels.length,
    itemCount: req.customsItems.reduce((sum, item) => sum + item.quantity, 0),
    chargeableWeightGrams: req.parcels.reduce((sum, p) => sum + p.chargeableWeightGrams, 0),
    destinationCountry: req.recipient.address.countryCode,
  };
}

/** Базова перевірка запиту «як у справжнього перевізника». Порожній масив — запит коректний. */
export function validateTestCarrierRequest(req: CreateShipmentRequest): CarrierErrorDetail[] {
  const details: CarrierErrorDetail[] = [];
  const blank = (v: string | null | undefined) => (v ?? "").trim() === "";
  const required = (value: string | null | undefined, label: string, field?: string) => {
    if (blank(value)) details.push({ field, carrierCode: "REQUIRED", message: `${label} is required` });
  };

  // Одержувач → поля адреси доставки (shipping.*). Ім'я — склеєне з кількох полів, тому без field.
  const r = req.recipient;
  if (blank(r.phone)) {
    details.push({ field: "shipping.phone", carrierCode: "REQUIRED", message: "recipient.phone is required" });
  } else if (!PHONE_RE.test(r.phone)) {
    details.push({
      field: "shipping.phone",
      carrierCode: "INVALID_PHONE",
      message: "recipient.phone must be in E.164 format (+<country><number>)",
    });
  }
  required(r.name, "recipient.name");
  required(r.address.address1, "recipient.address.address1", "shipping.address1");
  required(r.address.city, "recipient.address.city", "shipping.city");
  required(r.address.countryCode, "recipient.address.countryCode", "shipping.countryCode");

  // Відправник → налаштування shipper.* (ім'я відправника береться з shipper.contactName).
  const s = req.sender;
  required(s.name, "sender.name", "shipper.contactName");
  required(s.phone, "sender.phone", "shipper.phone");
  required(s.address.city, "sender.address.city", "shipper.city");
  required(s.address.address1, "sender.address.address1", "shipper.address1");
  required(s.address.countryCode, "sender.address.countryCode", "shipper.countryCode");

  if (req.parcels.length === 0) {
    details.push({ carrierCode: "NO_PARCELS", message: "at least one parcel is required" });
  }
  req.parcels.forEach((p, i) => {
    if (!(Number.isFinite(p.chargeableWeightGrams) && p.chargeableWeightGrams > 0)) {
      details.push({ carrierCode: "INVALID_WEIGHT", message: `parcels[${i}].chargeableWeightGrams must be > 0` });
    }
  });

  if (req.customsItems.length === 0) {
    details.push({ carrierCode: "NO_CUSTOMS_ITEMS", message: "at least one customs item is required" });
  }
  req.customsItems.forEach((item, i) => {
    if (!HS_CODE_RE.test(item.hsCode)) {
      details.push({ carrierCode: "INVALID_HS_CODE", message: `customsItems[${i}].hsCode must be 6-10 digits` });
    }
    if (!COUNTRY_RE.test(item.countryOfOrigin)) {
      details.push({
        carrierCode: "INVALID_ORIGIN",
        message: `customsItems[${i}].countryOfOrigin must be ISO-3166 alpha-2`,
      });
    }
    if (!(Number.isFinite(item.quantity) && item.quantity > 0)) {
      details.push({ carrierCode: "INVALID_QUANTITY", message: `customsItems[${i}].quantity must be > 0` });
    }
  });

  return details;
}

export interface TestCarrierOptions {
  store: SandboxStore;
  getSimulation: () => Promise<TestCarrierSimulation> | TestCarrierSimulation;
}

export class TestCarrierAdapter implements CarrierAdapter {
  readonly code = TEST_CARRIER_CODE;
  readonly displayName = "Test carrier (sandbox)";
  readonly mode = "test" as const;
  readonly capabilities: CarrierCapabilities = {
    rates: false,
    availability: false,
    createShipment: true,
    updateShipment: false,
    cancelShipment: true,
    documents: false,
    tracking: false,
    returns: false,
    findByReference: true,
    referenceLookupAuthoritative: true,
  };

  private readonly store: SandboxStore;
  private readonly getSimulation: TestCarrierOptions["getSimulation"];

  constructor(opts: TestCarrierOptions) {
    this.store = opts.store;
    this.getSimulation = opts.getSimulation;
  }

  async createShipment(req: CreateShipmentRequest, opts?: CarrierCallOptions): Promise<CreatedShipment> {
    this.ensureNotAborted(opts);

    const details = validateTestCarrierRequest(req);
    if (details.length > 0) {
      throw this.error("rejected", `Request rejected by test carrier: ${details.length} validation error(s)`, details);
    }

    const simulation = await this.guard("unavailable", "Test carrier settings unavailable", () =>
      Promise.resolve(this.getSimulation()),
    );
    switch (simulation) {
      case "reject":
        throw this.error("rejected", "Simulated rejection", [{ carrierCode: "SIMULATED", message: "Simulated rejection" }]);
      case "unavailable":
        throw this.error("unavailable", "Simulated carrier unavailability (nothing created)");
      case "timeout_before_create":
        throw this.error("unknown_outcome", "Simulated timeout (request lost before creation)");
      case "fail_after_create": {
        await this.createRecord(req, opts);
        throw this.error("unknown_outcome", "Simulated failure after creation (response lost)");
      }
      case "none":
        return toCreated(await this.createRecord(req, opts));
      default: {
        const unexpected: never = simulation;
        throw this.error("unavailable", `Unknown test carrier simulation: ${String(unexpected)}`);
      }
    }
  }

  async findShipmentByReference(reference: string, opts?: CarrierCallOptions): Promise<LookupResult> {
    this.ensureNotAborted(opts);
    const rec = await this.guard("unavailable", "Test carrier lookup failed", () => this.store.findByReference(reference));
    if (!rec) return { found: false, authoritative: true };
    return { found: true, shipment: toCreated(rec), cancelled: rec.cancelled };
  }

  async cancelShipment(waybillNumber: string, opts?: CarrierCallOptions): Promise<{ cancelled: boolean }> {
    this.ensureNotAborted(opts);
    const rec = await this.guard("unavailable", "Test carrier lookup failed", () => this.store.findByWaybill(waybillNumber));
    if (!rec) {
      throw this.error("rejected", `Waybill not found: ${waybillNumber}`, [
        { carrierCode: "NOT_FOUND", message: "waybill not found" },
      ]);
    }
    if (rec.cancelled) return { cancelled: true };
    const ok = await this.guard("unknown_outcome", "Test carrier cancellation failed", () =>
      this.store.markCancelled(waybillNumber),
    );
    if (!ok) throw this.error("rejected", `Waybill not found: ${waybillNumber}`);
    return { cancelled: true };
  }

  /** Створює запис у sandbox (ідемпотентно за reference) з підбором вільного номера накладної. */
  private async createRecord(req: CreateShipmentRequest, opts?: CarrierCallOptions): Promise<SandboxRecord> {
    const existing = await this.guard("unavailable", "Test carrier lookup failed", () =>
      this.store.findByReference(req.reference),
    );
    if (existing) return this.ensureActive(existing);

    const payload = toSandboxPayload(req);
    for (let attempt = 0; attempt < MAX_WAYBILL_ATTEMPTS; attempt++) {
      const waybillNumber = deriveTestWaybillNumber(req.reference, attempt);
      const holder = await this.guard("unavailable", "Test carrier lookup failed", () =>
        this.store.findByWaybill(waybillNumber),
      );
      if (holder) {
        if (holder.reference === req.reference) return this.ensureActive(holder);
        continue; // номер зайнятий іншим reference → наступний кандидат
      }

      this.ensureNotAborted(opts);
      try {
        const { record } = await this.store.insert({ reference: req.reference, waybillNumber, payload });
        return this.ensureActive(record);
      } catch (err) {
        if (err instanceof SandboxWaybillConflictError) continue; // гонка за номер з іншим reference
        if (err instanceof CarrierError) throw err;
        // Збій запису: невідомо, чи створено відправлення → звірка за reference.
        throw this.error("unknown_outcome", "Test carrier storage failure during creation");
      }
    }
    throw this.error("unavailable", "Test carrier could not allocate a waybill number");
  }

  /** Reference уже використаний скасованим відправленням — не повертаємо його як нове. */
  private ensureActive(rec: SandboxRecord): SandboxRecord {
    if (rec.cancelled) {
      throw this.error("rejected", `Reference already used by a cancelled shipment: ${rec.reference}`, [
        { carrierCode: "REFERENCE_CANCELLED", message: "reference belongs to a cancelled shipment" },
      ]);
    }
    return rec;
  }

  private ensureNotAborted(opts?: CarrierCallOptions): void {
    if (opts?.signal?.aborted) throw this.error("unavailable", "Request aborted before it was sent to the carrier");
  }

  /** Обгортає збої сховища у CarrierError потрібного типу. */
  private async guard<T>(kind: CarrierErrorKind, message: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof CarrierError) throw err;
      throw this.error(kind, message);
    }
  }

  private error(kind: CarrierErrorKind, message: string, details: CarrierErrorDetail[] = []): CarrierError {
    return new CarrierError(kind, this.code, message, details);
  }
}

function toCreated(rec: SandboxRecord): CreatedShipment {
  return {
    carrierShipmentId: rec.id,
    waybillNumber: rec.waybillNumber,
    trackingNumber: rec.waybillNumber,
    createdAt: rec.createdAt,
  };
}

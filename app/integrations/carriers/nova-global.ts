/**
 * Nova Global Partners API (офіційна документація v2.8 від 30.04.2026: https://nova.global/partners_api/).
 * Перевірені факти (2026-11-26):
 * - Доступ лише після підписання договору співпраці; авторизація — HTTP Basic (login:password),
 *   окремі облікові дані для тестового і робочого середовищ; у кожному запиті — company_id (напр. "npi").
 * - Хости: тест https://test-api.novaposhta.international:8243, робочий https://api.novaposhta.international:8243.
 * - Методи: POST /v.2.0/IEW/create (api_order — унікальний ідентифікатор партнера; повтор → 422 COR7 "Duplicated reference"),
 *   POST /v.2.0/IEW/cancel (COR202 — стан не дозволяє, COR125 — не знайдено), POST /v.2.0/IEW/print (label_format, base64 PDF),
 *   POST /npi/IEW/getTrackingHistory (iew_num_in | api_order_in | references), POST /npi/Dictionary/getWarehouses,
 *   маніфести/консолідація. Метода розрахунку вартості в поточній версії документації немає.
 * - API-ключ Нової пошти (NOVA_POSHTA_API_KEY) НЕ підходить: потрібні login/password і company_id від Nova Global.
 * Поки облікових даних немає — усі можливості вимкнені (not_configured).
 */
import {
  CarrierError,
  type CarrierAdapter,
  type CarrierCallOptions,
  type CarrierCapabilities,
  type CreatedShipment,
  type CreateShipmentRequest,
  type LookupResult,
} from "./types";

export const NOVA_GLOBAL_CODE = "nova_global";

export const NOVA_GLOBAL_NOT_CONFIGURED_MESSAGE =
  "Nova Global Partners API is not configured: partner login/password and company_id from the Nova Global agreement are required";

export class NovaGlobalAdapter implements CarrierAdapter {
  readonly code = NOVA_GLOBAL_CODE;
  readonly displayName = "Nova Global";
  readonly mode = "live" as const;
  readonly capabilities: CarrierCapabilities = {
    rates: false,
    availability: false,
    createShipment: false,
    updateShipment: false,
    cancelShipment: false,
    documents: false,
    tracking: false,
    returns: false,
    findByReference: false,
    referenceLookupAuthoritative: false,
  };

  async createShipment(_req: CreateShipmentRequest, _opts?: CarrierCallOptions): Promise<CreatedShipment> {
    throw notConfigured();
  }

  async findShipmentByReference(_reference: string, _opts?: CarrierCallOptions): Promise<LookupResult> {
    throw notConfigured();
  }

  async cancelShipment(_waybillNumber: string, _opts?: CarrierCallOptions): Promise<{ cancelled: boolean }> {
    throw notConfigured();
  }
}

function notConfigured(): CarrierError {
  return new CarrierError("not_configured", NOVA_GLOBAL_CODE, NOVA_GLOBAL_NOT_CONFIGURED_MESSAGE);
}

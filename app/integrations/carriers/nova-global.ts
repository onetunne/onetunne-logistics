/**
 * Nova Global — заглушка адаптера (етап 3).
 *
 * Офіційна документація партнерського API: https://nova.global/partners_api/
 *
 * Правила реалізації:
 * - Методи/ендпоінти реалізувати ЛИШЕ після підтвердження офіційної документації та отримання
 *   API-ключів. Не вигадувати методи, поля чи коди помилок.
 * - НЕ підставляти внутрішній український API Nova Post (https://api-portal.novapost.com/)
 *   без підтвердженої сумісності — це інший продукт.
 * - Перед повторним створенням після помилки API ЗАВЖДИ виконувати звірку через пошук за
 *   reference; якщо результат неможливо перевірити — відправлення йде на ручний розгляд.
 *
 * До того часу всі можливості вимкнені, а кожен метод кидає CarrierError("not_configured").
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
  "Nova Global API is not configured: official documentation and API keys pending (stage 3)";

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

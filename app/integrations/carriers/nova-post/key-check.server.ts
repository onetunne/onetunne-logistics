/**
 * Перевірка сумісності API-ключа Nova Post з міжнародними відправленнями — ЛИШЕ читання:
 * 1) отримання JWT; 2) розрахунок вартості зразкової посилки UA → DE (вигадана адреса, відправлення не створюється).
 * Результат — безпечний запис у журнал (без ключа, JWT і персональних даних).
 */
import { logger } from "~/lib/logger.server";
import { CarrierError } from "../types";
import { buildCalculationRequest, summarizeCalculation, type CalculationResponse } from "./calculations";
import { NovaPostClient, type FetchLike } from "./client.server";

export interface KeyCheckResult {
  endpoint: string;
  authorized: boolean;
  authError: string | null;
  calculationStatus: number | null;
  calculation: ReturnType<typeof summarizeCalculation> | null;
  calculationError: string | null;
}

export async function checkNovaPostKey(apiKey: string, baseUrl: string, fetchFn?: FetchLike): Promise<KeyCheckResult> {
  const client = new NovaPostClient({ apiKey, baseUrl, fetch: fetchFn });
  const result: KeyCheckResult = {
    endpoint: baseUrl,
    authorized: false,
    authError: null,
    calculationStatus: null,
    calculation: null,
    calculationError: null,
  };
  try {
    await client.authorize();
    result.authorized = true;
  } catch (e) {
    result.authError = e instanceof CarrierError ? `${e.kind}: ${e.message}` : "error";
    return result;
  }
  try {
    const res = await client.request<CalculationResponse>(
      "POST",
      "/shipments/calculations",
      buildCalculationRequest({
        senderCountry: "UA",
        senderCity: "Київ",
        senderPostCode: "01001",
        recipientCountry: "DE",
        recipientCity: "Berlin",
        recipientPostCode: "10178",
        parcels: [{ weightGrams: 500, lengthMm: 300, widthMm: 200, heightMm: 100 }],
      }),
    );
    result.calculationStatus = res.status;
    if (res.body) result.calculation = summarizeCalculation(res.body);
    else result.calculationError = res.errorText;
  } catch (e) {
    result.calculationError = e instanceof CarrierError ? `${e.kind}: ${e.message}` : "error";
  }
  return result;
}

/** Запуск під час старту сервера (якщо задано NOVA_POSHTA_API_KEY). Ключ не логуються. */
export async function logNovaPostKeyCheck(apiKey: string, baseUrl: string): Promise<KeyCheckResult> {
  const r = await checkNovaPostKey(apiKey, baseUrl);
  logger.info("nova_post.key_check", {
    endpoint: r.endpoint,
    authorized: r.authorized,
    authError: r.authError,
    calcHttp: r.calculationStatus,
    calc: r.calculation,
    calcError: r.calculationError,
  });
  return r;
}

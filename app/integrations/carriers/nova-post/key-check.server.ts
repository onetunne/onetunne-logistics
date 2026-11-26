/**
 * Перевірка сумісності API-ключа Nova Post з міжнародними відправленнями — ЛИШЕ читання:
 * 1) отримання JWT; 2) розрахунок вартості зразкової посилки UA → DE (вигадана адреса, відправлення не створюється).
 * Результат — безпечний запис у журнал (без ключа, JWT і персональних даних).
 */
import { logger, redact } from "~/lib/logger.server";
import { CarrierError } from "../types";
import { buildCalculationRequest, summarizeCalculation, type CalculationResponse } from "./calculations";
import { NovaPostClient, type FetchLike } from "./client.server";

export interface CalculationAttempt {
  variant: "minimal" | "with_invoice";
  status: number | null;
  summary: ReturnType<typeof summarizeCalculation> | null;
  error: string | null;
}

export interface KeyCheckResult {
  endpoint: string;
  authorized: boolean;
  authError: string | null;
  attempts: CalculationAttempt[];
}

const SAMPLE = {
  senderCountry: "UA",
  senderCity: "Київ",
  senderPostCode: "01001",
  recipientCountry: "DE",
  recipientCity: "Berlin",
  recipientPostCode: "10178",
  parcels: [{ weightGrams: 500, lengthMm: 300, widthMm: 200, heightMm: 100 }],
} as const;

/** Лише читання: JWT + розрахунок вартості зразкової посилки UA → DE у двох варіантах. Нічого не створюється. */
export async function checkNovaPostKey(apiKey: string, baseUrl: string, fetchFn?: FetchLike): Promise<KeyCheckResult> {
  const client = new NovaPostClient({ apiKey, baseUrl, fetch: fetchFn });
  const result: KeyCheckResult = { endpoint: baseUrl, authorized: false, authError: null, attempts: [] };
  try {
    await client.authorize();
    result.authorized = true;
  } catch (e) {
    result.authError = e instanceof CarrierError ? `${e.kind}: ${e.message}` : "error";
    return result;
  }
  const variants: Array<[CalculationAttempt["variant"], Parameters<typeof buildCalculationRequest>[0]]> = [
    ["minimal", { ...SAMPLE, parcels: [...SAMPLE.parcels] }],
    [
      "with_invoice",
      {
        ...SAMPLE,
        parcels: [...SAMPLE.parcels],
        deliveryTypes: ["standard"],
        invoice: { incoterm: "DAP", currency: "EUR", cost: 30, items: [{ hsCode: "8714100090", amount: 1, cost: 30 }] },
      },
    ],
  ];
  for (const [variant, input] of variants) {
    const attempt: CalculationAttempt = { variant, status: null, summary: null, error: null };
    try {
      const res = await client.request<CalculationResponse>("POST", "/shipments/calculations", buildCalculationRequest(input));
      attempt.status = res.status;
      if (res.body) attempt.summary = summarizeCalculation(res.body);
      else attempt.error = res.errorText;
    } catch (e) {
      attempt.error = e instanceof CarrierError ? `${e.kind}: ${e.message}` : "error";
    }
    result.attempts.push(attempt);
    if (attempt.summary) break;
  }
  return result;
}

/** Короткі рядки з міткою NOVA-CHECK — їх легко знайти пошуком у журналі Render. Без ключа, токена й ПД. */
export function formatKeyCheckLines(r: KeyCheckResult): string[] {
  const lines = [
    `NOVA-CHECK 1. Адреса API: ${r.endpoint}`,
    r.authorized ? "NOVA-CHECK 2. Вхід за ключем: OK (ключ прийнято)" : `NOVA-CHECK 2. Вхід за ключем: ПОМИЛКА — ${r.authError ?? "невідомо"}`,
  ];
  r.attempts.forEach((a, i) => {
    const label = a.variant === "minimal" ? "без інвойсу" : "з інвойсом";
    lines.push(
      a.summary
        ? `NOVA-CHECK ${3 + i}. Розрахунок UA→DE (${label}): OK — послуг ${a.summary.services}, суми ${JSON.stringify(a.summary.totals)}`
        : `NOVA-CHECK ${3 + i}. Розрахунок UA→DE (${label}): HTTP ${a.status ?? "—"} — ${(a.error ?? "").slice(0, 300)}`,
    );
  });
  return lines;
}

/** Запуск під час старту сервера (якщо задано NOVA_POSHTA_API_KEY). */
export async function logNovaPostKeyCheck(apiKey: string, baseUrl: string): Promise<KeyCheckResult> {
  const r = await checkNovaPostKey(apiKey, baseUrl);
  for (const line of formatKeyCheckLines(r)) console.log(String(redact(line)));
  logger.info("nova_post.key_check", { endpoint: r.endpoint, authorized: r.authorized, authError: r.authError, attempts: r.attempts });
  return r;
}

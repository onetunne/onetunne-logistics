/**
 * Етап 6, WP1: джерело офіційних курсів НБУ за контрактом OfficialFxRateSource (app/integrations/directories/types.ts,
 * docs/stage6-design.md §5.6). Запит: `GET https://bank.gov.ua/NBU_Exchange/exchange_site?start=…&end=…&json` (усі
 * валюти — коротке вікно; одна валюта `&valcode=` — довантаження історії ≤ 1 року). Без ключів і авторизації.
 *
 * НІКОЛИ не викликається без увімкненого власником `finance.fx.nbuEnabled` — це перевіряють викликачі (сервіси кнопок і
 * обробники завдань, modules/fx/nbu-fetch.server.ts; I18). Демо й тести — без мережі (фікстури tests/fixtures/nbu).
 * Довідковий курс 12:00 (`dollar_info`) НІКОЛИ не запитується.
 *
 * Помилки — NbuFetchError лише з кодом (без тексту відповіді й адреси: jobs.last_error не маскується, §14.2):
 * мережа / тайм-аут / HTTP 5xx / 429 — повторювані; формат відповіді (NbuResponseError) і інші HTTP — ні.
 */
import type { OfficialFxRate, OfficialFxRateSource } from "~/integrations/directories/types";
import { logger } from "~/lib/logger.server";
import { buildExchangeSiteUrl, NbuResponseError, parseNbuExchangeSite } from "~/modules/fx/nbu-parse";

export const NBU_TIMEOUT_MS = 15_000;
/** Відповідь довша за це — помилка (рік однієї валюти ≈ 100 КБ, 11 днів усіх валют ≈ 110 КБ). */
export const NBU_MAX_BODY_BYTES = 4 * 1024 * 1024;

export type NbuFetchErrorCode = "network" | "timeout" | "too_large" | `http_${number}` | NbuResponseError["code"];

export class NbuFetchError extends Error {
  constructor(
    readonly code: NbuFetchErrorCode,
    readonly retryable: boolean,
  ) {
    super(`nbu.${code}`);
    this.name = "NbuFetchError";
  }
}

export interface NbuSourceOptions {
  /** Для тестів — підміна fetch (типово — globalThis.fetch у момент виклику). */
  fetch?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new NbuFetchError("too_large", false);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new NbuFetchError("too_large", false);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Джерело НБУ. Кожен виклик fetchRates — один HTTP-запит (вікно перевіряє buildExchangeSiteUrl). */
export function createNbuSource(opts: NbuSourceOptions = {}): OfficialFxRateSource {
  const timeoutMs = opts.timeoutMs ?? NBU_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? NBU_MAX_BODY_BYTES;
  return {
    source: "nbu",
    async fetchRates(input): Promise<OfficialFxRate[]> {
      const url = buildExchangeSiteUrl(input);
      const doFetch = opts.fetch ?? globalThis.fetch;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "GET",
          headers: { Accept: "application/json" },
          redirect: "error",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        const name = (error as { name?: string } | null)?.name;
        throw new NbuFetchError(name === "TimeoutError" || name === "AbortError" ? "timeout" : "network", true);
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        throw new NbuFetchError(`http_${res.status}`, res.status >= 500 || res.status === 429);
      }
      let text: string;
      try {
        text = await readLimited(res, maxBytes);
      } catch (error) {
        if (error instanceof NbuFetchError) throw error;
        throw new NbuFetchError("network", true);
      }
      try {
        const parsed = parseNbuExchangeSite(text, { from: input.from, to: input.to });
        if (parsed.skippedUnits > 0) logger.warn("fx.nbu_unsupported_units", { skipped: parsed.skippedUnits });
        if (input.currency !== undefined && parsed.rows.some((r) => r.currency !== input.currency)) {
          throw new NbuResponseError("invalid_row");
        }
        return parsed.rows;
      } catch (error) {
        if (error instanceof NbuResponseError) throw new NbuFetchError(error.code, false);
        throw error;
      }
    },
  };
}

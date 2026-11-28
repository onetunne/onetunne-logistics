/**
 * Етап 6, WP1: чистий розбір відповідей НБУ `NBU_Exchange/exchange_site` (docs/stage6-design.md §5.6). Без мережі й БД.
 *
 * Правила (МАЄ, тести tests/stage6/fx/nbu-parse.test.ts на сирих відповідях НБУ з фактів):
 * - тіло МАЄ бути JSON-масивом об'єктів: HTTP 200 з «Wrong date format» (невалідний JSON) → помилка `invalid_json`;
 *   `[{"message":…}]` → помилка `nbu_message`; `[]` → «ще не встановлено» (порожній результат, НЕ помилка);
 * - ключ валюти — `cc` (`^[A-Z]{3}$`), НЕ `r030` (у 1996 р. USD мав r030 = 1);
 * - `rate` береться з СИРОГО тексту JSON як десятковий рядок (власний токенізатор, не `Number`); `rate_per_unit` (float)
 *   ігнорується — курс за одиницю рахується точно (rate / units);
 * - `units` — ціле > 0 (масштаби НБУ змінювалися: до 28.12.2019 USD/EUR — за 100); масштаб поза {1, 10, 100, 1000,
 *   10000} (CHECK fx_rates) → рядок пропускається з лічильником;
 * - `exchangedate` dd.mm.yyyy у межах запитаного вікна; `calcdate` dd.mm.yyyy або пробіл (до 05.07.2019) → null;
 * - метали (XAU, XAG, XPT, XPD) і XDR пропускаються. Довідковий курс 12:00 (`dollar_info`) НІКОЛИ не використовується —
 *   цей модуль будує лише адреси `exchange_site` (buildExchangeSiteUrl).
 */
import type { OfficialFxRate } from "~/integrations/directories/types";
import { FX_RATE_UNITS } from "~/domain/finance";
import { decimalToScaled, parseDecimalStrict, scaledToDecimal } from "~/lib/decimal";
import { addDays, parseIsoDate } from "~/lib/periods";

/** Базова адреса НБУ (єдина кінцева точка, яку використовує застосунок). */
export const NBU_EXCHANGE_SITE_URL = "https://bank.gov.ua/NBU_Exchange/exchange_site";
/** Метали й СПЗ — не валюти фінансів. */
export const NBU_SKIPPED_CODES: readonly string[] = ["XAU", "XAG", "XPT", "XPD", "XDR"];
/** Вікно регулярного отримання: [сьогодні − 3, сьогодні + 7] (після п'ятниці 15:30 уже є рядки на сб, нд і пн). */
export const NBU_FETCH_BACK_DAYS = 3;
export const NBU_FETCH_AHEAD_DAYS = 7;
/** Довантаження історії — одна валюта, вікнами ≤ 1 року (запит > 3 років для всіх валют НБУ блокує). */
export const NBU_BACKFILL_WINDOW_DAYS = 366;
/** Найраніша дата довантаження (календарні функції застосунку працюють з 2000 р.). */
export const NBU_BACKFILL_EARLIEST = "2000-01-01";
/** Найдовший період одного довантаження (≤ 5 вікон по року). */
export const NBU_BACKFILL_MAX_YEARS = 5;
/** Запит для всіх валют — не довше за це (регулярне вікно — 11 днів). */
export const NBU_ALL_CURRENCIES_MAX_DAYS = 31;
/** Знаків після коми в опублікованому курсі (fx_rates.rate numeric(18,6)). */
export const NBU_RATE_MAX_SCALE = 6;
/** Найбільше цілих розрядів опублікованого курсу (numeric(18,6)). */
const NBU_RATE_MAX_INT_DIGITS = 12;
const MAX_JSON_DEPTH = 8;

export type NbuResponseErrorCode = "invalid_json" | "not_array" | "nbu_message" | "invalid_row" | "date_outside_window" | "duplicate_row";

/** Помилка формату відповіді НБУ: лише код (без тексту відповіді — він потрапив би в jobs.last_error). */
export class NbuResponseError extends Error {
  constructor(readonly code: NbuResponseErrorCode) {
    super(`nbu.${code}`);
    this.name = "NbuResponseError";
  }
}

/** Число JSON у сирому вигляді (як записано у відповіді), без перетворення на float. */
export class RawNumber {
  constructor(readonly raw: string) {}
}

const NUMBER_RE = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;

/**
 * Розбір JSON, у якому числа лишаються сирими рядками (RawNumber). Строгий синтаксис JSON (RFC 8259): помилка →
 * NbuResponseError("invalid_json"). Глибина — не більше 8 (відповідь НБУ — масив плоских об'єктів).
 */
export function parseJsonKeepingNumbers(text: string): unknown {
  let i = 0;
  const n = text.length;
  const fail = (): never => {
    throw new NbuResponseError("invalid_json");
  };
  const ws = () => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };
  const str = (): string => {
    const start = i;
    i++; // "
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        i++;
        try {
          return JSON.parse(text.slice(start, i)) as string;
        } catch {
          return fail();
        }
      }
      if (c === 0x5c) i += 2;
      else if (c < 0x20) return fail();
      else i++;
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    ws();
    if (i >= n) return fail();
    const c = text[i];
    if (c === "{") {
      if (depth >= MAX_JSON_DEPTH) return fail();
      i++;
      const obj: Record<string, unknown> = {};
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') return fail();
        const key = str();
        ws();
        if (text[i] !== ":") return fail();
        i++;
        const v = value(depth + 1);
        // Власна властивість навіть для «__proto__» (без забруднення прототипу).
        Object.defineProperty(obj, key, { value: v, enumerable: true, writable: true, configurable: true });
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        return fail();
      }
    }
    if (c === "[") {
      if (depth >= MAX_JSON_DEPTH) return fail();
      i++;
      const arr: unknown[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        arr.push(value(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        return fail();
      }
    }
    if (c === '"') return str();
    if (text.startsWith("true", i)) {
      i += 4;
      return true;
    }
    if (text.startsWith("false", i)) {
      i += 5;
      return false;
    }
    if (text.startsWith("null", i)) {
      i += 4;
      return null;
    }
    NUMBER_RE.lastIndex = i;
    const m = NUMBER_RE.exec(text);
    if (!m) return fail();
    i += m[0].length;
    return new RawNumber(m[0]);
  };
  // BOM на початку не очікується, але не є помилкою формату.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  const result = value(0);
  ws();
  if (i !== n) fail();
  return result;
}

const DDMMYYYY_RE = /^(\d{2})\.(\d{2})\.(\d{4})$/;

/** «20.11.2026» → «2026-11-20» (справжня календарна дата 2000–2100) або null. */
export function nbuDateToIso(value: string): string | null {
  const m = DDMMYYYY_RE.exec(value);
  if (!m) return null;
  return parseIsoDate(`${m[3]}-${m[2]}-${m[1]}`);
}

/** «2026-11-20» → «20261120» (параметри start / end). */
export function isoToNbuQueryDate(iso: string): string {
  const d = parseIsoDate(iso);
  if (!d) throw new RangeError(`invalid date ${iso}`);
  return d.replace(/-/g, "");
}

export interface NbuWindow {
  from: string;
  to: string;
}

/** Вікно регулярного отримання для дати Києва `today`. */
export function nbuFetchWindow(today: string): NbuWindow {
  return { from: addDays(today, -NBU_FETCH_BACK_DAYS), to: addDays(today, NBU_FETCH_AHEAD_DAYS) };
}

/** Ділить [from, to] на послідовні вікна ≤ maxDays днів (включно). */
export function splitWindows(from: string, to: string, maxDays: number = NBU_BACKFILL_WINDOW_DAYS): NbuWindow[] {
  if (!parseIsoDate(from) || !parseIsoDate(to) || from > to) throw new RangeError(`invalid window ${from}..${to}`);
  if (!Number.isSafeInteger(maxDays) || maxDays < 1) throw new RangeError("maxDays");
  const out: NbuWindow[] = [];
  let start = from;
  while (start <= to) {
    const end = addDays(start, maxDays - 1);
    out.push({ from: start, to: end < to ? end : to });
    start = addDays(end, 1);
  }
  return out;
}

/**
 * Адреса запиту `exchange_site` (ЄДИНА, яку будує застосунок). Одна валюта (`valcode`) — довантаження історії
 * (≤ 1 рік); усі валюти — лише коротке вікно (≤ 31 день). Порушення — помилка програміста (RangeError).
 */
export function buildExchangeSiteUrl(input: { from: string; to: string; currency?: string }): string {
  const days = Math.round((Date.parse(`${input.to}T00:00:00Z`) - Date.parse(`${input.from}T00:00:00Z`)) / 86_400_000) + 1;
  if (!parseIsoDate(input.from) || !parseIsoDate(input.to) || days < 1) throw new RangeError(`invalid window ${input.from}..${input.to}`);
  const params = new URLSearchParams({ start: isoToNbuQueryDate(input.from), end: isoToNbuQueryDate(input.to) });
  if (input.currency !== undefined) {
    if (!/^[A-Z]{3}$/.test(input.currency)) throw new RangeError("currency");
    if (days > NBU_BACKFILL_WINDOW_DAYS) throw new RangeError("single-currency window is longer than one year");
    params.set("valcode", input.currency);
  } else if (days > NBU_ALL_CURRENCIES_MAX_DAYS) {
    throw new RangeError("all-currency window is too long");
  }
  params.set("sort", "exchangedate");
  params.set("order", "asc");
  // `json` — прапорець без значення (без нього НБУ відповідає XML).
  return `${NBU_EXCHANGE_SITE_URL}?${params.toString()}&json`;
}

export interface NbuParseResult {
  rows: OfficialFxRate[];
  /** Пропущено: метали й XDR. */
  skippedNonCurrency: number;
  /** Пропущено: масштаб поза {1, 10, 100, 1000, 10000}. */
  skippedUnits: number;
}

const RATE_RE = /^\d+(?:\.\d+)?$/;
const UNITS_RE = /^[1-9]\d{0,8}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof RawNumber);
}

/** Опублікований курс → канонічний десятковий рядок (без зайвих нулів) або null (недопустимий). */
export function canonicalRate(raw: string): string | null {
  if (!RATE_RE.test(raw)) return null;
  const r = parseDecimalStrict(raw, NBU_RATE_MAX_SCALE);
  if (!r || r.num <= 0n) return null;
  if (raw.split(".")[0]!.replace(/^0+(?=\d)/, "").length > NBU_RATE_MAX_INT_DIGITS) return null;
  const scaled = decimalToScaled(raw, NBU_RATE_MAX_SCALE);
  return scaled === null ? null : scaledToDecimal(scaled, NBU_RATE_MAX_SCALE);
}

/**
 * Розбирає тіло відповіді `exchange_site` для вікна [from, to]. Помилка формату → NbuResponseError (лише код).
 * Порожній масив — порожній результат (курс ще не встановлено).
 */
export function parseNbuExchangeSite(text: string, window: NbuWindow): NbuParseResult {
  const doc = parseJsonKeepingNumbers(text);
  if (!Array.isArray(doc)) throw new NbuResponseError("not_array");
  if (doc.some((el) => isPlainObject(el) && "message" in el)) throw new NbuResponseError("nbu_message");
  const rows: OfficialFxRate[] = [];
  const seen = new Map<string, OfficialFxRate>();
  let skippedNonCurrency = 0;
  let skippedUnits = 0;
  for (const el of doc) {
    if (!isPlainObject(el)) throw new NbuResponseError("invalid_row");
    const { cc, exchangedate, rate, units, calcdate } = el;
    if (typeof cc !== "string" || !/^[A-Z]{3}$/.test(cc)) throw new NbuResponseError("invalid_row");
    if (typeof exchangedate !== "string") throw new NbuResponseError("invalid_row");
    const effectiveDate = nbuDateToIso(exchangedate);
    if (!effectiveDate) throw new NbuResponseError("invalid_row");
    if (effectiveDate < window.from || effectiveDate > window.to) throw new NbuResponseError("date_outside_window");
    if (NBU_SKIPPED_CODES.includes(cc)) {
      skippedNonCurrency++;
      continue;
    }
    if (!(rate instanceof RawNumber) || !(units instanceof RawNumber)) throw new NbuResponseError("invalid_row");
    const canonical = canonicalRate(rate.raw);
    if (!canonical) throw new NbuResponseError("invalid_row");
    if (!UNITS_RE.test(units.raw)) throw new NbuResponseError("invalid_row");
    const u = Number(units.raw);
    if (!(FX_RATE_UNITS as readonly number[]).includes(u)) {
      skippedUnits++;
      continue;
    }
    let setOn: string | null = null;
    if (calcdate !== undefined && calcdate !== null) {
      if (typeof calcdate !== "string") throw new NbuResponseError("invalid_row");
      if (calcdate.trim() !== "") {
        setOn = nbuDateToIso(calcdate.trim());
        if (!setOn) throw new NbuResponseError("invalid_row");
      }
    }
    const parsed: OfficialFxRate = { currency: cc, effectiveDate, rate: canonical, units: u, setOn };
    const key = `${cc}|${effectiveDate}`;
    const prev = seen.get(key);
    if (prev) {
      if (prev.rate !== parsed.rate || prev.units !== parsed.units) throw new NbuResponseError("duplicate_row");
      continue;
    }
    seen.set(key, parsed);
    rows.push(parsed);
  }
  return { rows, skippedNonCurrency, skippedUnits };
}

/**
 * Клієнт Nova Post API v1.0 (документація: https://api-portal.novapost.com).
 * Авторизація: API-ключ → GET /clients/authorization?apiKey=… → JWT (діє ~1 год) → заголовок Authorization: {jwt}.
 * Ендпоінти: для клієнтів з України — https://api.novaposhta.ua/v.1.0 («відправлення по Україні або міжнародні з України»);
 * для інших — https://api.novapost.com/v.1.0; пісочниця — https://api-stage.novapost.com/v.1.0 (ключі UA там не видаються).
 * Ключ і JWT ніколи не потрапляють у журнали.
 *
 * Мережеві помилки:
 * - за замовчуванням → CarrierError("unavailable") (читання, друк, відстеження — повтор безпечний);
 * - для запитів, що створюють дані (POST /shipments), викликач передає networkErrorKind: "unknown_outcome":
 *   тайм-аут/обрив/скасування ПІСЛЯ початку відправки означають, що перевізник МІГ створити відправлення.
 *   Помилки, що гарантовано сталися до встановлення з'єднання (DNS, відмова в з'єднанні, тайм-аут з'єднання),
 *   і скасування до відправки лишаються "unavailable".
 */
import { CarrierError, type CarrierErrorKind } from "../types";

export const NOVA_POST_ENDPOINTS = {
  ua: "https://api.novaposhta.ua/v.1.0",
  world: "https://api.novapost.com/v.1.0",
  sandbox: "https://api-stage.novapost.com/v.1.0",
} as const;

const CARRIER = "nova_post";
const JWT_TTL_MS = 50 * 60 * 1000; // документація: ~1 година; оновлюємо із запасом
const TIMEOUT_MS = 15_000;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface NovaPostClientOptions {
  apiKey: string;
  baseUrl: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Тайм-аут одного HTTP-запиту, мс (за замовчуванням 15 с). */
  timeoutMs?: number;
}

export interface NovaPostResponse<T> {
  status: number;
  /** Розібране JSON-тіло успішної відповіді (2xx), інакше null. */
  body: T | null;
  /** Текст помилки без секретів (для не-2xx), інакше null. */
  errorText: string | null;
  /** Розібране JSON-тіло помилки (для не-2xx), якщо це JSON. */
  errorBody: unknown;
  contentType: string | null;
}

export interface NovaPostBinaryResponse {
  status: number;
  contentType: string | null;
  /** Тіло успішної відповіді (2xx) як байти, інакше null. */
  bytes: Uint8Array | null;
  errorText: string | null;
  errorBody: unknown;
}

export type NovaPostQueryValue = string | number | boolean | null | undefined | ReadonlyArray<string | number>;
export type NovaPostQuery = Record<string, NovaPostQueryValue>;

export interface NovaPostRequestOptions {
  /** Параметри query. Масив → повторювані параметри: { "numbers[]": ["A", "B"] } → numbers[]=A&numbers[]=B. */
  query?: NovaPostQuery;
  /** Скасування від викликача (поєднується з тайм-аутом клієнта). */
  signal?: AbortSignal;
  /** Як класифікувати мережеву помилку після початку відправки запиту (див. опис модуля). */
  networkErrorKind?: Extract<CarrierErrorKind, "unavailable" | "unknown_outcome">;
}

/** Текст без секретів (ключ, JWT), без обрізання — для розбору тіла помилки. */
export function redactSecrets(text: string, apiKey: string): string {
  let out = text;
  if (apiKey) out = out.split(apiKey).join("[apiKey]");
  return out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]");
}

/** Ліміт тексту помилки в повідомленнях і журналах. */
const ERROR_TEXT_LIMIT = 400;

/**
 * Текст помилки без секретів (ключ у query, JWT). Спершу прибираються секрети з ПОВНОГО тексту, потім обрізання:
 * обрізаний раніше ключ/JWT (на межі ліміту) вже не впізнати. Хвіст, схожий на початок JWT, на межі обрізання прибирається.
 */
export function safeErrorText(text: string, apiKey: string): string {
  const redacted = redactSecrets(text, apiKey);
  if (redacted.length <= ERROR_TEXT_LIMIT) return redacted;
  return redacted.slice(0, ERROR_TEXT_LIMIT).replace(/eyJ[\w-]*(?:\.[\w-]*)?$/, "[jwt]");
}

/** Документовані тимчасові збої шлюзу (сторінка API errors): запит не оброблено, повтор безпечний. */
export function isTransientGatewayMessage(text: string | null | undefined): boolean {
  return /cid profile timeout|internal typeerror error/i.test(text ?? "");
}

/**
 * Рядок query. Ключі з `[]` залишаються буквальними (як у прикладах документації: `refs[]=…`, `numbers[]=…`),
 * значення кодуються. null/undefined пропускаються.
 */
export function buildQuery(query?: NovaPostQuery): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values: ReadonlyArray<string | number | boolean> = isReadonlyArray(value) ? value : [value];
    const encodedKey = encodeURIComponent(key).replace(/%5B%5D$/i, "[]");
    for (const v of values) parts.push(`${encodedKey}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function isReadonlyArray(v: NovaPostQueryValue): v is ReadonlyArray<string | number> {
  return Array.isArray(v);
}

/** Коди помилок undici/Node, за яких з'єднання гарантовано не було встановлене (запит не відправлено). */
const PRE_CONNECT_ERROR_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

function errorCode(e: unknown): string | null {
  if (!e || typeof e !== "object") return null;
  const direct = (e as { code?: unknown }).code;
  if (typeof direct === "string") return direct;
  const cause = (e as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return null;
}

function networkError(e: unknown, kind: "unavailable" | "unknown_outcome"): CarrierError {
  const name = e instanceof Error ? e.name : "error";
  const code = errorCode(e);
  const label = code ? `${name}/${code}` : name;
  if (kind === "unknown_outcome" && !(code && PRE_CONNECT_ERROR_CODES.has(code))) {
    return new CarrierError("unknown_outcome", CARRIER, `Nova Post: no response, the request may have been processed (${label})`);
  }
  return new CarrierError("unavailable", CARRIER, `Nova Post unreachable: ${label}`);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export class NovaPostClient {
  private jwt: { token: string; expiresAt: number } | null = null;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: NovaPostClientOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private signalFor(signal: AbortSignal | undefined): AbortSignal {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private async rawFetch(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
    kind: "unavailable" | "unknown_outcome",
  ): Promise<Response> {
    // Скасовано ще до відправки — запит точно не дійшов до перевізника.
    if (signal?.aborted) throw new CarrierError("unavailable", CARRIER, "Nova Post request aborted before sending");
    try {
      return await this.fetchFn(`${this.opts.baseUrl}${path}`, { ...init, signal: this.signalFor(signal) });
    } catch (e) {
      throw networkError(e, kind);
    }
  }

  /** Тіло відповіді; обрив під час читання успішної/5xx відповіді класифікується як мережева помилка. */
  private async readBody<T>(res: Response, kind: "unavailable" | "unknown_outcome", read: (r: Response) => Promise<T>, empty: T): Promise<T> {
    try {
      return await read(res);
    } catch (e) {
      // 4xx: статус отримано — тіло помилки необов'язкове (порожнє тіло адаптер класифікує сам; для POST /shipments
      // 400/409 без доказу помилки клієнта — unknown_outcome).
      if (res.status >= 400 && res.status < 500) return empty;
      throw networkError(e, kind === "unknown_outcome" ? "unknown_outcome" : "unavailable");
    }
  }

  /** Отримує JWT за API-ключем (кешується до завершення терміну дії). */
  async authorize(force = false, signal?: AbortSignal): Promise<string> {
    if (!force && this.jwt && this.jwt.expiresAt > this.now()) return this.jwt.token;
    // Авторизація нічого не створює: мережеві помилки тут завжди "unavailable".
    const res = await this.rawFetch(`/clients/authorization?apiKey=${encodeURIComponent(this.opts.apiKey)}`, { method: "GET" }, signal, "unavailable");
    const text = await this.readBody(res, "unavailable", (r) => r.text(), "");
    if (res.status === 401 || res.status === 403) throw new CarrierError("auth", CARRIER, `Nova Post authorization failed (${res.status})`);
    if (!res.ok) {
      // Збій авторизації НІКОЛИ не "rejected": "rejected" означає, що перевізник відхилив дані відправлення.
      // Тимчасові (5xx, 429, 408, «Cid profile timeout», «Internal TypeError error») → "unavailable", інші → "auth".
      const safe = safeErrorText(text, this.opts.apiKey);
      const transient = res.status >= 500 || res.status === 429 || res.status === 408 || isTransientGatewayMessage(redactSecrets(text, this.opts.apiKey));
      throw new CarrierError(transient ? "unavailable" : "auth", CARRIER, `Nova Post authorization error (${res.status}): ${safe}`);
    }
    const parsed = parseJson(text);
    const token = parsed && typeof parsed === "object" ? (parsed as { jwt?: unknown }).jwt : undefined;
    if (typeof token !== "string" || !token) throw new CarrierError("auth", CARRIER, "Nova Post authorization: no jwt in response");
    this.jwt = { token, expiresAt: this.now() + JWT_TTL_MS };
    return token;
  }

  /** Запит з JWT; при 401 — одне повторне отримання JWT (401 означає, що запит не оброблено). */
  private async send(method: string, path: string, body: unknown, opts: NovaPostRequestOptions, accept: string): Promise<Response> {
    const kind = opts.networkErrorKind ?? "unavailable";
    const fullPath = `${path}${buildQuery(opts.query)}`;
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const jwt = await this.authorize(attempt > 0, opts.signal);
      res = await this.rawFetch(
        fullPath,
        {
          method,
          headers: { Authorization: jwt, "Content-Type": "application/json", Accept: accept },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        opts.signal,
        kind,
      );
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel().catch(() => undefined);
        continue;
      }
      return res;
    }
    if (res) return res;
    throw new CarrierError("auth", CARRIER, "Nova Post: JWT rejected");
  }

  /** JSON-запит. Повертає статус і розібране тіло (успіх) або безпечний текст/тіло помилки. */
  async request<T>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    opts: NovaPostRequestOptions = {},
  ): Promise<NovaPostResponse<T>> {
    const kind = opts.networkErrorKind ?? "unavailable";
    const res = await this.send(method, path, body, opts, "application/json");
    const text = await this.readBody(res, kind, (r) => r.text(), "");
    return {
      status: res.status,
      body: res.ok ? ((parseJson(text) as T | null) ?? null) : null,
      errorText: res.ok ? null : safeErrorText(text, this.opts.apiKey),
      // Тіло помилки розбирається з тексту, з якого вже прибрано ключ і JWT.
      errorBody: res.ok ? null : parseJson(redactSecrets(text, this.opts.apiKey)),
      contentType: res.headers.get("content-type"),
    };
  }

  /** GET двійкового документа (напр. PDF). Помилки перевізника приходять як JSON. */
  async requestBinary(path: string, opts: Omit<NovaPostRequestOptions, "networkErrorKind"> = {}): Promise<NovaPostBinaryResponse> {
    const res = await this.send("GET", path, undefined, opts, "application/pdf, application/json");
    const contentType = res.headers.get("content-type");
    if (res.ok) {
      const buf = await this.readBody(res, "unavailable", (r) => r.arrayBuffer(), new ArrayBuffer(0));
      return { status: res.status, contentType, bytes: new Uint8Array(buf), errorText: null, errorBody: null };
    }
    const text = await this.readBody(res, "unavailable", (r) => r.text(), "");
    return {
      status: res.status,
      contentType,
      bytes: null,
      errorText: safeErrorText(text, this.opts.apiKey),
      errorBody: parseJson(redactSecrets(text, this.opts.apiKey)),
    };
  }
}

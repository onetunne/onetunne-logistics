/**
 * Клієнт Nova Post API v1.0 (документація: https://api-portal.novapost.com).
 * Авторизація: API-ключ → GET /clients/authorization?apiKey=… → JWT (діє ~1 год) → заголовок Authorization: {jwt}.
 * Ендпоінти: для клієнтів з України — https://api.novaposhta.ua/v.1.0 («відправлення по Україні або міжнародні з України»);
 * для інших — https://api.novapost.com/v.1.0; пісочниця — https://api-stage.novapost.com/v.1.0 (ключі UA там не видаються).
 * Ключ і JWT ніколи не потрапляють у журнали.
 */
import { CarrierError } from "../types";

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
}

export interface NovaPostResponse<T> {
  status: number;
  body: T | null;
  errorText: string | null;
}

/** Текст помилки без секретів (ключ у query, JWT). */
export function safeErrorText(text: string, apiKey: string): string {
  let out = text.slice(0, 400);
  if (apiKey) out = out.split(apiKey).join("[apiKey]");
  return out.replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[jwt]");
}

export class NovaPostClient {
  private jwt: { token: string; expiresAt: number } | null = null;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: NovaPostClientOptions) {
    this.fetchFn = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? (() => Date.now());
  }

  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  private async rawFetch(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(`${this.opts.baseUrl}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      throw new CarrierError("unavailable", CARRIER, `Nova Post unreachable: ${e instanceof Error ? e.name : "error"}`);
    }
  }

  /** Отримує JWT за API-ключем (кешується до завершення терміну дії). */
  async authorize(force = false): Promise<string> {
    if (!force && this.jwt && this.jwt.expiresAt > this.now()) return this.jwt.token;
    const res = await this.rawFetch(`/clients/authorization?apiKey=${encodeURIComponent(this.opts.apiKey)}`, { method: "GET" });
    const text = await res.text();
    if (res.status === 401 || res.status === 403) throw new CarrierError("auth", CARRIER, `Nova Post authorization failed (${res.status})`);
    if (!res.ok) {
      throw new CarrierError(res.status >= 500 ? "unavailable" : "rejected", CARRIER, `Nova Post authorization error (${res.status}): ${safeErrorText(text, this.opts.apiKey)}`);
    }
    let token: unknown;
    try {
      token = (JSON.parse(text) as { jwt?: unknown }).jwt;
    } catch {
      token = undefined;
    }
    if (typeof token !== "string" || !token) throw new CarrierError("auth", CARRIER, "Nova Post authorization: no jwt in response");
    this.jwt = { token, expiresAt: this.now() + JWT_TTL_MS };
    return token;
  }

  /** Запит з JWT; при 401 — одне повторне отримання JWT. */
  async request<T>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<NovaPostResponse<T>> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const jwt = await this.authorize(attempt > 0);
      const res = await this.rawFetch(path, {
        method,
        headers: { Authorization: jwt, "Content-Type": "application/json", Accept: "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.status === 401 && attempt === 0) continue;
      let parsed: T | null = null;
      try {
        parsed = text ? (JSON.parse(text) as T) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: res.ok ? parsed : null, errorText: res.ok ? null : safeErrorText(text, this.opts.apiKey) };
    }
    throw new CarrierError("auth", CARRIER, "Nova Post: JWT rejected");
  }
}

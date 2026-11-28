/**
 * Етап 6, WP1: джерело НБУ (OfficialFxRateSource, app/integrations/fx/nbu.server.ts) з підміненим fetch — без мережі.
 * Один запит на виклик, лише exchange_site; помилки — лише коди (без тексту відповіді): мережа / тайм-аут / 5xx / 429 —
 * повторювані, формат і 4xx — ні; завелика відповідь; «Wrong date format» при HTTP 200 — помилка, `[]` — порожньо.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNbuSource, NbuFetchError } from "~/integrations/fx/nbu.server";
import { ALL_20261120, EUR_RANGE, fixture } from "./helpers";

const respond = (body: string, status = 200, headers: Record<string, string> = {}) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } }));

async function codeOf(p: Promise<unknown>): Promise<{ code: string; retryable: boolean } | null> {
  try {
    await p;
    return null;
  } catch (e) {
    if (e instanceof NbuFetchError) return { code: e.code, retryable: e.retryable };
    throw e;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("createNbuSource", () => {
  it("one GET to exchange_site per call; rows parsed from the raw body", async () => {
    const f = respond(fixture(ALL_20261120));
    const src = createNbuSource({ fetch: f as unknown as typeof fetch });
    const rows = await src.fetchRates({ from: "2026-11-20", to: "2026-11-20" });
    expect(rows).toHaveLength(40);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe("https://bank.gov.ua/NBU_Exchange/exchange_site?start=20261120&end=20261120&sort=exchangedate&order=asc&json");
    expect(init?.method).toBe("GET");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(src.source).toBe("nbu");
  });

  it("single currency (backfill) adds valcode; a row of another currency is a format error", async () => {
    const f = respond(fixture(EUR_RANGE));
    const rows = await createNbuSource({ fetch: f as unknown as typeof fetch }).fetchRates({ from: "2026-11-18", to: "2026-11-30", currency: "EUR" });
    expect(rows.every((r) => r.currency === "EUR")).toBe(true);
    expect(String(f.mock.calls[0]![0])).toContain("valcode=EUR");
    const g = respond(fixture(ALL_20261120));
    expect(await codeOf(createNbuSource({ fetch: g as unknown as typeof fetch }).fetchRates({ from: "2026-11-20", to: "2026-11-20", currency: "EUR" }))).toEqual({
      code: "invalid_row",
      retryable: false,
    });
  });

  it("error shapes → codes only; empty array → no rows (not an error)", async () => {
    const src = (body: string, status = 200, headers?: Record<string, string>) => createNbuSource({ fetch: respond(body, status, headers) as unknown as typeof fetch });
    const w = { from: "2026-11-20", to: "2026-11-20" };
    expect(await codeOf(src(fixture("wrong-date-format.txt")).fetchRates(w))).toEqual({ code: "invalid_json", retryable: false });
    expect(await codeOf(src(fixture("wrong-parameters-format.json")).fetchRates(w))).toEqual({ code: "nbu_message", retryable: false });
    expect(await src(fixture("empty.json")).fetchRates(w)).toEqual([]);
    expect(await codeOf(src("oops", 503).fetchRates(w))).toEqual({ code: "http_503", retryable: true });
    expect(await codeOf(src("slow down", 429).fetchRates(w))).toEqual({ code: "http_429", retryable: true });
    expect(await codeOf(src("nope", 404).fetchRates(w))).toEqual({ code: "http_404", retryable: false });
    expect(await codeOf(src("[]", 200, { "content-length": String(10 * 1024 * 1024) }).fetchRates(w))).toEqual({ code: "too_large", retryable: false });
    expect(await codeOf(createNbuSource({ fetch: respond(fixture(ALL_20261120)) as unknown as typeof fetch, maxBytes: 100 }).fetchRates(w))).toEqual({ code: "too_large", retryable: false });
    // Помилка не містить тексту відповіді.
    try {
      await src("SECRET-BODY", 500).fetchRates(w);
    } catch (e) {
      expect((e as Error).message).toBe("nbu.http_500");
    }
  });

  it("network failure and timeout are retryable", async () => {
    const down = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await codeOf(createNbuSource({ fetch: down as unknown as typeof fetch }).fetchRates({ from: "2026-11-20", to: "2026-11-20" }))).toEqual({ code: "network", retryable: true });
    const hang = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
        }),
    );
    expect(await codeOf(createNbuSource({ fetch: hang as unknown as typeof fetch, timeoutMs: 20 }).fetchRates({ from: "2026-11-20", to: "2026-11-20" }))).toEqual({
      code: "timeout",
      retryable: true,
    });
  });

  it("uses globalThis.fetch at call time when none is injected (lets tests prove no request is made)", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("[]", { status: 200 }));
    await createNbuSource().fetchRates({ from: "2026-11-20", to: "2026-11-20" });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

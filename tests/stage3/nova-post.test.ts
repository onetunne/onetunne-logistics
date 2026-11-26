import { describe, expect, it, vi } from "vitest";
import { NovaPostClient, safeErrorText } from "~/integrations/carriers/nova-post/client.server";
import { buildCalculationRequest, summarizeCalculation } from "~/integrations/carriers/nova-post/calculations";
import { checkNovaPostKey, formatKeyCheckLines } from "~/integrations/carriers/nova-post/key-check.server";
import { CarrierError } from "~/integrations/carriers/types";

const KEY = "test-key-1234567890abcdef";
const BASE = "https://api.example.invalid/v.1.0";

function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = handler(url, init);
    return new Response(typeof r.body === "string" ? r.body : JSON.stringify(r.body), { status: r.status });
  });
  return { fn, calls };
}

describe("Nova Post API client", () => {
  it("gets a JWT by API key, caches it, sends it as Authorization", async () => {
    const { fn, calls } = mockFetch((url) =>
      url.includes("/clients/authorization") ? { status: 200, body: { jwt: "eyJa.eyJb.sig" } } : { status: 200, body: { ok: true } },
    );
    const c = new NovaPostClient({ apiKey: KEY, baseUrl: BASE, fetch: fn });
    await c.request("GET", "/x");
    await c.request("GET", "/y");
    expect(calls.filter((x) => x.url.includes("/clients/authorization"))).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${BASE}/clients/authorization?apiKey=${KEY}`);
    expect((calls[1]!.init!.headers as Record<string, string>).Authorization).toBe("eyJa.eyJb.sig");
  });

  it("refreshes the JWT once on 401", async () => {
    let n = 0;
    const { fn, calls } = mockFetch((url) => {
      if (url.includes("/clients/authorization")) return { status: 200, body: { jwt: `eyJa.eyJb.s${++n}` } };
      return n === 1 ? { status: 401, body: {} } : { status: 200, body: { ok: 1 } };
    });
    const res = await new NovaPostClient({ apiKey: KEY, baseUrl: BASE, fetch: fn }).request("GET", "/z");
    expect(res.status).toBe(200);
    expect(calls.filter((x) => x.url.includes("/clients/authorization"))).toHaveLength(2);
  });

  it("invalid key → auth error; secrets never appear in error text", async () => {
    const { fn } = mockFetch(() => ({ status: 401, body: { errors: { apiKey: `invalid ${KEY}` } } }));
    await expect(new NovaPostClient({ apiKey: KEY, baseUrl: BASE, fetch: fn }).authorize()).rejects.toMatchObject({ kind: "auth" });
    expect(safeErrorText(`bad ${KEY} eyJhbGc.eyJzdWI.abc`, KEY)).toBe("bad [apiKey] [jwt]");
  });

  it("network failure → unavailable (nothing was sent)", async () => {
    const fn = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const err = await new NovaPostClient({ apiKey: KEY, baseUrl: BASE, fetch: fn }).authorize().catch((e) => e);
    expect(err).toBeInstanceOf(CarrierError);
    expect(err.kind).toBe("unavailable");
  });
});

describe("delivery cost calculation request", () => {
  it("uses documented units (grams rounded up to 10 g, millimetres) and omits empty fields", () => {
    const req = buildCalculationRequest({
      senderCountry: "UA",
      senderCity: "Київ",
      senderPostCode: null,
      recipientCountry: "DE",
      recipientCity: "Berlin",
      recipientPostCode: "10178",
      parcels: [{ weightGrams: 453, lengthMm: 300, widthMm: 200, heightMm: 100, insuranceCost: 1000 }],
    });
    expect(req).toEqual({
      payerType: "Sender",
      sender: { countryCode: "UA", addressParts: { city: "Київ" } },
      recipient: { countryCode: "DE", addressParts: { city: "Berlin", postCode: "10178" } },
      parcels: [{ rowNumber: 1, cargoCategory: "parcel", actualWeight: 460, length: 300, width: 200, height: 100, insuranceCost: 1000 }],
    });
  });

  it("summarizes services without personal data", () => {
    expect(summarizeCalculation({ scheduledDeliveryDate: "2026-12-01", services: [{ deliveryType: "standard", cost: 300 }, { deliveryType: "standard", cost: 25 }] }))
      .toEqual({ services: 2, totals: { standard: 325 }, scheduledDeliveryDate: "2026-12-01" });
  });
});

describe("key compatibility check (read-only)", () => {
  it("tries the invoice variant when the minimal calculation is rejected", async () => {
    const { fn, calls } = mockFetch((url, init) => {
      if (url.includes("/clients/authorization")) return { status: 200, body: { jwt: "eyJa.eyJb.c" } };
      const body = JSON.parse(String(init?.body));
      return body.invoice ? { status: 200, body: { services: [{ deliveryType: "standard", cost: 500 }] } } : { status: 422, body: { errors: { invoice: "required" } } };
    });
    const r = await checkNovaPostKey(KEY, BASE, fn);
    expect(r.attempts.map((a) => [a.variant, a.status])).toEqual([["minimal", 422], ["with_invoice", 200]]);
    expect(calls.filter((c) => c.url.includes("/shipments/calculations"))).toHaveLength(2);
    expect(formatKeyCheckLines(r)).toHaveLength(4);
  });

  it("authorizes and calculates UA → DE without creating shipments", async () => {
    const { fn, calls } = mockFetch((url) =>
      url.includes("/clients/authorization")
        ? { status: 200, body: { jwt: "eyJa.eyJb.c" } }
        : { status: 200, body: { services: [{ deliveryType: "standard", cost: 410 }], scheduledDeliveryDate: null } },
    );
    const r = await checkNovaPostKey(KEY, BASE, fn);
    expect(r).toMatchObject({ authorized: true, attempts: [{ variant: "minimal", status: 200, summary: { services: 1 } }] });
    expect(formatKeyCheckLines(r).join("\n")).toContain("NOVA-CHECK 3. Розрахунок UA→DE (без інвойсу): OK");
    expect(calls.map((c) => `${c.init?.method} ${c.url.replace(BASE, "").split("?")[0]}`)).toEqual([
      "GET /clients/authorization",
      "POST /shipments/calculations",
    ]);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });

  it("reports an incompatible key without throwing", async () => {
    const { fn } = mockFetch(() => ({ status: 401, body: {} }));
    const r = await checkNovaPostKey(KEY, BASE, fn);
    expect(r).toMatchObject({ authorized: false, attempts: [] });
    expect(r.authError).toContain("auth");
    expect(formatKeyCheckLines(r)[1]).toContain("ПОМИЛКА");
  });
});

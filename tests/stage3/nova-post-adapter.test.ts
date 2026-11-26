import { describe, expect, it, vi } from "vitest";
import {
  NOVA_POST_CODE,
  NOVA_POST_SHIPMENTS_DISABLED_MESSAGE,
  NovaPostAdapter,
  type NovaPostAdapterSettings,
} from "~/integrations/carriers/nova-post/adapter.server";
import { NovaPostClient } from "~/integrations/carriers/nova-post/client.server";
import { CarrierError, type CreateShipmentRequest, type RateRequest } from "~/integrations/carriers/types";

// Лише вигадані тестові дані. Мережа не використовується: fetch підмінено.
const KEY = "test-key-1234567890abcdef";
const BASE = "https://api.example.invalid/v.1.0";
const JWT = "eyJa.eyJb.sig";
const NOW = new Date("2026-11-26T12:00:00Z");
const WAYBILL = "20450000000001";

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  rawUrl: string;
  body: unknown;
  headers: Record<string, string>;
}

type Reply = { status: number; json?: unknown; text?: string; bytes?: Uint8Array; contentType?: string; response?: Response };

function fakeApi(handler: (call: Call) => Reply | Error, opts: { authError?: Error } = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? "GET",
      path: u.pathname.replace(/^\/v\.1\.0/, ""),
      query: u.searchParams,
      rawUrl: url,
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    if (call.path === "/clients/authorization") {
      if (opts.authError) throw opts.authError;
      return new Response(JSON.stringify({ jwt: JWT }), { status: 200 });
    }
    const r = handler(call);
    if (r instanceof Error) throw r;
    if (r.response) return r.response;
    if (r.status === 204) return new Response(null, { status: 204 });
    const payload = r.bytes ? new Uint8Array(r.bytes) : (r.text ?? (r.json === undefined ? "" : JSON.stringify(r.json)));
    return new Response(payload, { status: r.status, headers: { "content-type": r.contentType ?? "application/json" } });
  });
  return {
    fetch,
    calls,
    apiCalls: () => calls.filter((c) => c.path !== "/clients/authorization"),
    authCalls: () => calls.filter((c) => c.path === "/clients/authorization"),
  };
}

const SETTINGS: NovaPostAdapterSettings = {
  novaPost: { payerType: "Sender", payerContractNumber: "", deliveryType: "", tariffCurrency: "UAH" },
  customs: { incoterm: "DAP", exportReason: "sale", invoiceType: "commercial" },
  shipper: { companyName: "Test Shop LLC", taxId: "12345678", carrierBranch: "32521/1" },
  checkoutRates: { fxRates: [{ currency: "EUR", rate: "45" }] },
};

function setup(handler: (call: Call) => Reply | Error, opts: { allow?: boolean; settings?: Partial<NovaPostAdapterSettings>; authError?: Error } = {}) {
  const api = fakeApi(handler, { authError: opts.authError });
  const client = new NovaPostClient({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch });
  const adapter = new NovaPostAdapter({
    client,
    settings: async () => ({ ...SETTINGS, ...opts.settings }),
    allowShipmentCreation: opts.allow ?? true,
    now: () => NOW,
  });
  return { adapter, api };
}

function request(): CreateShipmentRequest {
  return {
    reference: "OT-1001-1",
    orderNumber: "#1001",
    sender: {
      name: "Test Sender",
      company: "Test Shop LLC",
      phone: "+380501234567",
      email: "shop@example.test",
      address: { countryCode: "UA", city: "Kyiv", postalCode: "01001", province: null, address1: "Test street 1", address2: null },
      branchCode: "32521/1",
      taxId: "12345678",
    },
    recipient: {
      name: "Test Recipient",
      company: null,
      phone: "+491511234567",
      email: "recipient@example.test",
      address: { countryCode: "DE", city: "Berlin", postalCode: "10178", province: null, address1: "Teststrasse 5", address2: null, street: "Teststrasse", building: "5" },
      registrationAddress: { countryCode: "DE", city: "Berlin", postalCode: "10178", province: null, address1: "Teststrasse 5", address2: null, street: "Teststrasse", building: "5" },
    },
    parcels: [{ packageCode: "m", lengthCm: 35, widthCm: 25, heightCm: 8, actualWeightGrams: 473, volumetricWeightGrams: 1400, chargeableWeightGrams: 1400 }],
    customsItems: [
      { sku: "SKU-1", description: "Cotton T-shirt", hsCode: "6109100010", countryOfOrigin: "UA", quantity: 2, unitValue: { amount: "24.90", currency: "EUR" }, weightGrams: 150 },
    ],
    declaredValue: { amount: "49.80", currency: "EUR" },
    customs: {
      invoiceNumber: "1001",
      invoiceDate: "2026-11-26",
      invoiceType: "commercial",
      incoterm: "DAP",
      exportReason: "sale",
      totalValue: { amount: "49.80", currency: "EUR" },
    },
  };
}

const CREATED = { id: "0b6e2c1a-1111-4222-8333-444455556666", number: WAYBILL, status: "ReadyToShip", cost: 410, createdAt: "2026-11-26T10:00:00Z", deletedAt: null };

async function carrierError(p: Promise<unknown>): Promise<CarrierError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(CarrierError);
  return e as CarrierError;
}

describe("NovaPostAdapter: identity and capabilities", () => {
  it("declares live Nova Post capabilities; creation follows the owner switch", () => {
    const { adapter } = setup(() => ({ status: 200 }));
    expect(adapter.code).toBe(NOVA_POST_CODE);
    expect(NOVA_POST_CODE).toBe("nova_post");
    expect(adapter.displayName).toBe("Nova Post");
    expect(adapter.mode).toBe("live");
    expect(adapter.capabilities).toEqual({
      rates: true,
      availability: false,
      createShipment: true,
      updateShipment: false,
      cancelShipment: true,
      documents: true,
      tracking: true,
      returns: false,
      findByReference: true,
      referenceLookupAuthoritative: false,
      documentKinds: ["label", "invoice", "customs_declaration"],
    });
    expect(setup(() => ({ status: 200 }), { allow: false }).adapter.capabilities.createShipment).toBe(false);
    expect(adapter.trackingInfo(WAYBILL)).toEqual({ company: "Nova Post", number: WAYBILL, url: null });
  });
});

describe("NovaPostAdapter.createShipment", () => {
  it("creation disabled → not_configured without any network call", async () => {
    const { adapter, api } = setup(() => ({ status: 201, json: CREATED }), { allow: false });
    const err = await carrierError(adapter.createShipment(request()));
    expect(err.kind).toBe("not_configured");
    expect(err.message).toBe(NOVA_POST_SHIPMENTS_DISABLED_MESSAGE);
    expect(err.message).toContain("NOVA_POST_SHIPMENTS_ENABLED=true");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("201 → created shipment; JWT obtained once and reused", async () => {
    const { adapter, api } = setup((c) => (c.method === "POST" && c.path === "/shipments" ? { status: 201, json: CREATED } : { status: 500 }));
    const created = await adapter.createShipment(request());
    expect(created).toEqual({
      carrierShipmentId: CREATED.id,
      waybillNumber: WAYBILL,
      trackingNumber: WAYBILL,
      createdAt: new Date("2026-11-26T10:00:00Z"),
    });
    await adapter.createShipment(request());
    expect(api.authCalls()).toHaveLength(1);
    const post = api.apiCalls()[0]!;
    expect(post.headers.Authorization).toBe(JWT);
    expect(post.body).toMatchObject({
      status: "ReadyToShip",
      clientOrder: "OT-1001-1",
      note: "#1001",
      payerType: "Sender",
      parcels: [{ actualWeight: 480, length: 350, width: 250, height: 80, insuranceCost: 49.8, insuranceCurrencyCode: "EUR" }],
      sender: { divisionNumber: "32521/1", countryCode: "UA" },
      recipient: {
        countryCode: "DE",
        addressParts: { city: "Berlin", street: "Teststrasse", building: "5", postCode: "10178" },
        registrationAddressRecipient: { city: "Berlin", street: "Teststrasse", zipCode: "10178", building: "5" },
      },
      invoice: { incoterm: "DAP", exportReason: "Selling", payerFeesCustoms: "Recipient", items: [{ actualWeight: 480, amount: 2, cost: 24.9 }] },
    });
    expect(post.body).not.toHaveProperty("payerContractNumber");
  });

  it("uses serviceCode, then settings deliveryType; passes the contract number", async () => {
    const { adapter, api } = setup(() => ({ status: 201, json: CREATED }), {
      settings: { novaPost: { ...SETTINGS.novaPost, deliveryType: "economy", payerContractNumber: "CN-12345" } },
    });
    await adapter.createShipment(request());
    await adapter.createShipment({ ...request(), serviceCode: "express" });
    expect(api.apiCalls().map((c) => (c.body as { deliveryType?: string }).deliveryType)).toEqual(["economy", "express"]);
    expect(api.apiCalls()[0]!.body).toMatchObject({ payerContractNumber: "CN-12345" });
  });

  it("2xx without id/number → unknown_outcome (must be reconciled)", async () => {
    const { adapter } = setup(() => ({ status: 201, json: { id: CREATED.id } }));
    expect((await carrierError(adapter.createShipment(request()))).kind).toBe("unknown_outcome");
    const empty = setup(() => ({ status: 201, text: "" }));
    expect((await carrierError(empty.adapter.createShipment(request()))).kind).toBe("unknown_outcome");
  });

  it.each([
    // 400 без помилок полів — не доказ відмови (документований 400 «Internal TypeError error»): звірка, а не повтор.
    [400, "unknown_outcome"],
    [404, "rejected"],
    // 409 для POST /shipments не документований: «конфлікт» може означати, що відправлення вже існує.
    [409, "unknown_outcome"],
    [422, "rejected"],
    [401, "auth"],
    [403, "auth"],
    [429, "unavailable"],
    [408, "unknown_outcome"],
    [500, "unknown_outcome"],
    [502, "unknown_outcome"],
    [503, "unknown_outcome"],
  ] as const)("HTTP %i → %s", async (status, kind) => {
    const { adapter, api } = setup(() => ({ status, json: { errors: { errorMessage: "test" } } }));
    const err = await carrierError(adapter.createShipment(request()));
    expect(err.kind).toBe(kind);
    expect(err.carrier).toBe("nova_post");
    // 401 → одне повторне отримання JWT, далі відмова.
    expect(api.authCalls()).toHaveLength(status === 401 ? 2 : 1);
  });

  it.each([
    ["Internal TypeError error (documented gateway 400)", { status: 400, json: { errors: { errorMessage: "Internal TypeError error" } } }, "unknown_outcome"],
    ["empty body", { status: 400, text: "" }, "unknown_outcome"],
    ["unparseable body", { status: 400, text: "<html>Bad Request</html>", contentType: "text/html" }, "unknown_outcome"],
    ["field validation errors", { status: 400, json: { errors: { "parcels.0.width": "The parcels.0.width field must be at least 1." } } }, "rejected"],
    ["Invalid JSON format", { status: 400, json: { errors: { errorMessage: "Invalid JSON format" } } }, "rejected"],
    ["Cid profile timeout", { status: 422, json: { errors: { errorMessage: "Cid profile timeout" } } }, "unavailable"],
    ["Cid profile not found", { status: 422, json: { errors: { errorMessage: "Cid profile not found" } } }, "auth"],
  ] as const)("POST /shipments %s → %s", async (_name, reply, kind) => {
    const { adapter } = setup(() => reply);
    expect((await carrierError(adapter.createShipment(request()))).kind).toBe(kind);
  });

  it("422 validation errors → rejected with details mapped to our fields, no secrets in message", async () => {
    const { adapter } = setup(() => ({
      status: 422,
      json: { errors: { "recipient.addressParts.city": "validation.condition.recipient_settlement_not_defined", "recipient.phone": `bad ${KEY}` } },
    }));
    const err = await carrierError(adapter.createShipment(request()));
    expect(err.kind).toBe("rejected");
    expect(err.details.map((d) => d.field)).toEqual(["shipping.city", "shipping.phone"]);
    expect(err.message).toContain("recipient_settlement_not_defined");
    expect(err.message).not.toContain(KEY);
  });

  it("network error / timeout / abort after the request was sent → unknown_outcome", async () => {
    for (const error of [
      new TypeError("fetch failed"),
      new DOMException("The operation timed out.", "TimeoutError"),
      new DOMException("This operation was aborted", "AbortError"),
      Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
    ]) {
      const { adapter } = setup(() => error);
      expect((await carrierError(adapter.createShipment(request()))).kind).toBe("unknown_outcome");
    }
  });

  it.each([
    ["ENOTFOUND", "unavailable"],
    ["EAI_AGAIN", "unavailable"],
    ["ECONNREFUSED", "unavailable"],
    ["UND_ERR_CONNECT_TIMEOUT", "unavailable"],
    // Не з переліку «до з'єднання» (обрив сокета після відправки) → результат невідомий.
    ["UND_ERR_SOCKET", "unknown_outcome"],
  ] as const)("network error code %s → %s", async (code, kind) => {
    const { adapter } = setup(() => Object.assign(new TypeError("fetch failed"), { cause: { code } }));
    expect((await carrierError(adapter.createShipment(request()))).kind).toBe(kind);
  });

  it("body stream fails after the status was received → unknown_outcome (2xx and 5xx)", async () => {
    const broken = (status: number) =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"id":"'));
            controller.error(new TypeError("terminated"));
          },
        }),
        { status, headers: { "content-type": "application/json" } },
      );
    for (const status of [201, 503]) {
      const { adapter } = setup(() => ({ status, response: broken(status) }));
      expect((await carrierError(adapter.createShipment(request()))).kind, `status ${status}`).toBe("unknown_outcome");
    }
  });

  it("401 → JWT refreshed → the repeated POST fails on the network → unknown_outcome", async () => {
    let posts = 0;
    const { adapter, api } = setup(() => (++posts === 1 ? { status: 401, json: { errors: { errorMessage: "Expired token" } } } : new TypeError("fetch failed")));
    expect((await carrierError(adapter.createShipment(request()))).kind).toBe("unknown_outcome");
    expect(api.authCalls()).toHaveLength(2);
    expect(api.apiCalls()).toHaveLength(2);
  });

  it("errors that guarantee nothing was sent → unavailable", async () => {

    const authDown = setup(() => ({ status: 201, json: CREATED }), { authError: new TypeError("fetch failed") });
    expect((await carrierError(authDown.adapter.createShipment(request()))).kind).toBe("unavailable");
    expect(authDown.api.apiCalls()).toHaveLength(0);

    const aborted = setup(() => ({ status: 201, json: CREATED }));
    const ac = new AbortController();
    ac.abort();
    expect((await carrierError(aborted.adapter.createShipment(request(), { signal: ac.signal }))).kind).toBe("unavailable");
    expect(aborted.api.fetch).not.toHaveBeenCalled();

    const api = fakeApi(() => ({ status: 201, json: CREATED }));
    const noSettings = new NovaPostAdapter({
      client: new NovaPostClient({ apiKey: KEY, baseUrl: BASE, fetch: api.fetch }),
      settings: async () => {
        throw new Error("db down");
      },
      allowShipmentCreation: true,
    });
    expect((await carrierError(noSettings.createShipment(request()))).kind).toBe("unavailable");
    expect(api.fetch).not.toHaveBeenCalled();
  });

  it("invalid data → rejected before any network call", async () => {
    const { adapter, api } = setup(() => ({ status: 201, json: CREATED }));
    const req = request();
    req.recipient = { ...req.recipient, name: "x".repeat(101) };
    const err = await carrierError(adapter.createShipment(req));
    expect(err.kind).toBe("rejected");
    expect(err.details[0]).toMatchObject({ field: "order", carrierCode: "recipient.name" });
    expect(api.fetch).not.toHaveBeenCalled();
  });
});

describe("NovaPostAdapter.findShipmentByReference", () => {
  const item = (id: string, clientOrder: string, extra: Record<string, unknown> = {}) => ({
    id,
    number: `2045000000${id.padStart(4, "0")}`,
    clientOrder,
    status: "ReadyToShip",
    createdAt: "2026-11-26T10:00:00Z",
    deletedAt: null,
    ...extra,
  });

  function pages(data: Array<Array<ReturnType<typeof item>>>, lastPage = data.length) {
    return (c: Call): Reply => {
      const page = Number(c.query.get("page"));
      return { status: 200, json: { current_page: page, last_page: lastPage, per_page: 100, total: 0, items: data[page - 1] ?? [] } };
    };
  }

  it("scans pages (limit 100) and stops when found", async () => {
    const { adapter, api } = setup(pages([[item("1", "OT-1000-1")], [item("2", "#1001 OT-1001-1")], [item("3", "OT-1002-1")]]));
    const r = await adapter.findShipmentByReference("OT-1001-1");
    expect(r).toEqual({
      found: true,
      cancelled: false,
      shipment: { carrierShipmentId: "2", waybillNumber: "20450000000002", trackingNumber: "20450000000002", createdAt: new Date("2026-11-26T10:00:00Z") },
    });
    expect(api.apiCalls().map((c) => [c.method, c.path, c.query.get("limit"), c.query.get("page")])).toEqual([
      ["GET", "/shipments", "100", "1"],
      ["GET", "/shipments", "100", "2"],
    ]);
  });

  it("deleted match → cancelled; an active match wins over a deleted one", async () => {
    const deleted = setup(pages([[item("1", "OT-1001-1", { deletedAt: "2026-11-26T11:00:00Z" })]]));
    expect(await deleted.adapter.findShipmentByReference("OT-1001-1")).toMatchObject({ found: true, cancelled: true });
    const statusDeleted = setup(pages([[item("1", "OT-1001-1", { status: "Deleted" })]]));
    expect(await statusDeleted.adapter.findShipmentByReference("OT-1001-1")).toMatchObject({ found: true, cancelled: true });
    const both = setup(pages([[item("1", "OT-1001-1", { deletedAt: "2026-11-26T11:00:00Z" })], [item("2", "OT-1001-1")]]));
    expect(await both.adapter.findShipmentByReference("OT-1001-1")).toMatchObject({ found: true, cancelled: false, shipment: { carrierShipmentId: "2" } });
  });

  it("deleted match is 'cancelled' only after a complete scan; otherwise not authoritative (manual review)", async () => {
    // last_page > 5: активне відправлення з тим самим reference могло лишитися на непереглянутій сторінці.
    const beyond = setup(pages([[item("1", "OT-1001-1", { deletedAt: "2026-11-26T11:00:00Z" })], ...Array.from({ length: 9 }, (_, i) => [item(String(i + 2), "OTHER")])], 10));
    expect(await beyond.adapter.findShipmentByReference("OT-1001-1")).toEqual({ found: false, authoritative: false });
    expect(beyond.api.apiCalls()).toHaveLength(5);
    // Без last_page повноту перегляду не підтвердити.
    const noLastPage = setup(() => ({ status: 200, json: { items: [item("1", "OT-1001-1", { deletedAt: "2026-11-26T11:00:00Z" })] } }));
    expect(await noLastPage.adapter.findShipmentByReference("OT-1001-1")).toEqual({ found: false, authoritative: false });
    // Порожня сторінка до last_page — теж неповний перегляд.
    const gap = setup(pages([[item("1", "OT-1001-1", { deletedAt: "2026-11-26T11:00:00Z" })], []], 3));
    expect(await gap.adapter.findShipmentByReference("OT-1001-1")).toEqual({ found: false, authoritative: false });
  });

  it("not found → non-authoritative; stops at last_page and at 5 pages max", async () => {
    const two = setup(pages([[item("1", "OT-1000-1")], [item("2", "OT-1001-12")]]));
    expect(await two.adapter.findShipmentByReference("OT-1001-1")).toEqual({ found: false, authoritative: false });
    expect(two.api.apiCalls()).toHaveLength(2);
    const many = setup(pages(Array.from({ length: 10 }, (_, i) => [item(String(i + 1), "OTHER")]), 10));
    expect(await many.adapter.findShipmentByReference("OT-1001-1")).toEqual({ found: false, authoritative: false });
    expect(many.api.apiCalls()).toHaveLength(5);
    const empty = setup(() => ({ status: 200, json: { current_page: 1, last_page: 3, items: [] } }));
    expect(await empty.adapter.findShipmentByReference("OT-1001-1")).toEqual({ found: false, authoritative: false });
    expect(empty.api.apiCalls()).toHaveLength(1);
  });

  it("errors are thrown (caller moves the shipment to manual review)", async () => {
    expect((await carrierError(setup(() => ({ status: 422, json: { errors: { numbers: "required" } } })).adapter.findShipmentByReference("R"))).kind).toBe("rejected");
    expect((await carrierError(setup(() => ({ status: 503 })).adapter.findShipmentByReference("R"))).kind).toBe("unavailable");
    expect((await carrierError(setup(() => new TypeError("fetch failed")).adapter.findShipmentByReference("R"))).kind).toBe("unavailable");
  });
});

describe("NovaPostAdapter.cancelShipment", () => {
  it("DELETE /shipments/{number}: 200/204 → cancelled", async () => {
    const ok = setup(() => ({ status: 200, json: { deletedAt: "2026-11-26T12:00:00Z" } }));
    expect(await ok.adapter.cancelShipment(WAYBILL)).toEqual({ cancelled: true });
    expect(ok.api.apiCalls().map((c) => [c.method, c.path])).toEqual([["DELETE", `/shipments/${WAYBILL}`]]);
    expect(await setup(() => ({ status: 204 })).adapter.cancelShipment(WAYBILL)).toEqual({ cancelled: true });
    const encoded = setup(() => ({ status: 200, json: {} }));
    await encoded.adapter.cancelShipment("AB/1");
    expect(encoded.api.apiCalls()[0]!.rawUrl).toBe(`${BASE}/shipments/AB%2F1`);
  });

  it("repeated delete (422 shipment_was_deleted) → cancelled; other refusals → not cancelled", async () => {
    expect(await setup(() => ({ status: 422, json: { errors: { errorMessage: "shipment_was_deleted" } } })).adapter.cancelShipment(WAYBILL)).toEqual({ cancelled: true });
    expect(await setup(() => ({ status: 422, json: { errors: { errorMessage: "deletion not allowed" } } })).adapter.cancelShipment(WAYBILL)).toEqual({ cancelled: false });
    expect(await setup(() => ({ status: 409, json: {} })).adapter.cancelShipment(WAYBILL)).toEqual({ cancelled: false });
    expect(await setup(() => ({ status: 400, text: "bad" })).adapter.cancelShipment(WAYBILL)).toEqual({ cancelled: false });
  });

  it("transient gateway errors are thrown as unavailable, not reported as a refusal", async () => {
    const timeout = await carrierError(setup(() => ({ status: 422, json: { errors: { errorMessage: "Cid profile timeout" } } })).adapter.cancelShipment(WAYBILL));
    expect(timeout.kind).toBe("unavailable");
    const internal = await carrierError(setup(() => ({ status: 400, json: { errors: { errorMessage: "Internal TypeError error" } } })).adapter.cancelShipment(WAYBILL));
    expect(internal.kind).toBe("unavailable");
    const profile = await carrierError(setup(() => ({ status: 422, json: { errors: { errorMessage: "Cid profile not found" } } })).adapter.cancelShipment(WAYBILL));
    expect(profile.kind).toBe("auth");
  });

  it("404 → rejected (not found); 401 → auth; 5xx/network → unavailable", async () => {
    const nf = await carrierError(setup(() => ({ status: 404, json: { errors: { errorMessage: "shipment_not_found" } } })).adapter.cancelShipment(WAYBILL));
    expect(nf.kind).toBe("rejected");
    expect(nf.message).toBe("shipment not found at Nova Post");
    expect((await carrierError(setup(() => ({ status: 401 })).adapter.cancelShipment(WAYBILL))).kind).toBe("auth");
    expect((await carrierError(setup(() => ({ status: 503 })).adapter.cancelShipment(WAYBILL))).kind).toBe("unavailable");
    expect((await carrierError(setup(() => new TypeError("fetch failed")).adapter.cancelShipment(WAYBILL))).kind).toBe("unavailable");
  });
});

describe("NovaPostAdapter.getDocument", () => {
  const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]);
  const ref = { carrierShipmentId: CREATED.id, waybillNumber: WAYBILL };

  it("label → GET /shipments/print type=marking, one number, size_100_100; returns PDF bytes", async () => {
    const { adapter, api } = setup(() => ({ status: 200, bytes: PDF, contentType: "application/pdf" }));
    const doc = await adapter.getDocument(ref, "label");
    expect(doc).toEqual({ kind: "label", format: "pdf", contentType: "application/pdf", content: PDF, fileName: `label-${WAYBILL}.pdf` });
    const call = api.apiCalls()[0]!;
    expect([call.method, call.path]).toEqual(["GET", "/shipments/print"]);
    expect(call.query.getAll("numbers[]")).toEqual([WAYBILL]);
    expect(call.query.get("type")).toBe("marking");
    expect(call.query.get("printSizeType")).toBe("size_100_100");
    expect(call.rawUrl).toContain(`numbers[]=${WAYBILL}`);
    expect(call.headers.Accept).toContain("application/pdf");
  });

  it("invoice → type=invoice, customs declaration → type=international (A4)", async () => {
    const { adapter, api } = setup(() => ({ status: 200, bytes: PDF, contentType: "application/octet-stream" }));
    expect((await adapter.getDocument(ref, "invoice")).fileName).toBe(`invoice-${WAYBILL}.pdf`);
    expect((await adapter.getDocument(ref, "customs_declaration")).fileName).toBe(`customs-declaration-${WAYBILL}.pdf`);
    expect(api.apiCalls().map((c) => [c.query.get("type"), c.query.get("printSizeType")])).toEqual([
      ["invoice", "size_A4"],
      ["international", "size_A4"],
    ]);
  });

  it("non-PDF 200 response → CarrierError; 404/422 → rejected; 5xx/network → unavailable", async () => {
    const json = await carrierError(setup(() => ({ status: 200, json: { errors: {} } })).adapter.getDocument(ref, "label"));
    expect(json.kind).toBe("unavailable");
    expect(json.message).toContain("non-PDF");
    expect((await carrierError(setup(() => ({ status: 200, text: "", contentType: "application/pdf" })).adapter.getDocument(ref, "label"))).kind).toBe("unavailable");
    expect((await carrierError(setup(() => ({ status: 404, json: { errors: { errorMessage: "not_found" } } })).adapter.getDocument(ref, "label"))).kind).toBe("rejected");
    expect((await carrierError(setup(() => ({ status: 422, json: { errors: { numbers: "invalid" } } })).adapter.getDocument(ref, "invoice"))).kind).toBe("rejected");
    expect((await carrierError(setup(() => ({ status: 503 })).adapter.getDocument(ref, "label"))).kind).toBe("unavailable");
    expect((await carrierError(setup(() => new TypeError("fetch failed")).adapter.getDocument(ref, "label"))).kind).toBe("unavailable");
  });
});

describe("NovaPostAdapter.getTracking", () => {
  const A = "20450000000001";
  const B = "20450000000002";
  const FULL_TRACKING = {
    currentStatus: [
      { number: A, createdDate: "2026-11-20T09:00:00Z", statusCode: "120", status: "Customs clearance completed", statusDate: "2026-11-24T15:30:00Z", deliveryCountry: "DE" },
      { number: B, createdDate: "2026-11-21T09:00:00Z", statusCode: "9", status: "Closed", statusDate: "2026-11-25T11:00:00Z", deliveryCountry: "PL" },
    ],
    historyOnlineTracking: [
      { number: B, date: "2026-11-25T11:00:00Z", event: "ReceivedWarehouse", eventName: "Received at warehouse", eventStatus: "Now", code: "9", countryCode: "PL", settlementName: "Warszawa", divisionName: "Test 1" },
      { number: A, date: "2026-11-21T08:00:00Z", event: "DepartureSenderWarehouse", eventName: "Dispatched", eventStatus: "Passed", code: "5", countryCode: "UA", settlementName: "Kyiv" },
      { number: A, date: "2026-11-20T09:00:00Z", event: "CreateID", eventName: "Shipment ID created", eventStatus: "Passed", code: "1", countryCode: "UA", settlementName: "Kyiv" },
      { number: A, date: "2026-11-23T10:00:00Z", event: "DeclarationCustomsClearanceInitiated", eventName: "Customs clearance in progress", eventStatus: "Passed", code: "119", countryCode: "DE", settlementName: "Leipzig" },
      { number: A, date: "2026-11-24T15:30:00Z", event: "DeclarationCustomClearanceIsCompleted", eventName: "Customs clearance completed", eventStatus: "Now", code: "120", countryCode: "DE", settlementName: "Leipzig" },
      { number: B, date: "2026-11-21T09:00:00Z", event: "CreateID", eventName: "Shipment ID created", eventStatus: "Passed", code: "1", countryCode: "UA", settlementName: "Lviv" },
      { number: A, date: "2026-11-27T10:00:00Z", event: "ArrivalRecipientWarehouseFuture", eventStatus: "Future", code: "7" },
    ],
    parcels: [],
  };

  it("maps a realistic FullTracking payload for two numbers", async () => {
    const { adapter, api } = setup(() => ({ status: 200, json: FULL_TRACKING }));
    const snaps = await adapter.getTracking([A, B, "20450000000099"]);
    expect(api.apiCalls()[0]!.query.getAll("numbers[]")).toEqual([A, B, "20450000000099"]);
    expect(snaps).toHaveLength(2);
    expect(snaps[0]).toEqual({
      waybillNumber: A,
      status: "customs",
      carrierStatusCode: "120",
      carrierStatusText: "Customs clearance completed",
      statusAt: new Date("2026-11-24T15:30:00Z"),
      events: [
        { status: "created", code: "1", occurredAt: new Date("2026-11-20T09:00:00Z"), location: "Kyiv", description: "Shipment ID created" },
        { status: "in_transit", code: "5", occurredAt: new Date("2026-11-21T08:00:00Z"), location: "Kyiv", description: "Dispatched" },
        { status: "customs", code: "119", occurredAt: new Date("2026-11-23T10:00:00Z"), location: "Leipzig", description: "Customs clearance in progress" },
        { status: "customs", code: "120", occurredAt: new Date("2026-11-24T15:30:00Z"), location: "Leipzig", description: "Customs clearance completed" },
      ],
    });
    expect(snaps[1]).toMatchObject({ waybillNumber: B, status: "delivered", carrierStatusCode: "9", events: [{ code: "1" }, { code: "9", location: "Warszawa, Test 1" }] });
  });

  it("chunks requests (20 numbers) and de-duplicates", async () => {
    const { adapter, api } = setup(() => ({ status: 200, json: { currentStatus: [], historyOnlineTracking: [] } }));
    const numbers = Array.from({ length: 45 }, (_, i) => `2045${String(i).padStart(10, "0")}`);
    expect(await adapter.getTracking([...numbers, numbers[0]!, " "])).toEqual([]);
    expect(api.apiCalls().map((c) => c.query.getAll("numbers[]").length)).toEqual([20, 20, 5]);
  });

  it("404 for a batch → retries one by one, unknown numbers are skipped", async () => {
    const { adapter, api } = setup((c) => {
      const nums = c.query.getAll("numbers[]");
      if (nums.length > 1 || nums[0] !== A) return { status: 404, json: { errors: { errorMessage: "not_found" } } };
      return { status: 200, json: { currentStatus: [FULL_TRACKING.currentStatus[0]], historyOnlineTracking: [] } };
    });
    const snaps = await adapter.getTracking([B, A]);
    expect(snaps.map((s) => [s.waybillNumber, s.status, s.events.length])).toEqual([[A, "customs", 0]]);
    expect(api.apiCalls()).toHaveLength(3);
  });

  it("auth and availability errors are thrown", async () => {
    expect((await carrierError(setup(() => ({ status: 403 })).adapter.getTracking([A]))).kind).toBe("auth");
    expect((await carrierError(setup(() => ({ status: 500 })).adapter.getTracking([A]))).kind).toBe("unavailable");
  });
});

describe("NovaPostAdapter.quoteRates", () => {
  const rateRequest = (overrides: Partial<RateRequest> = {}): RateRequest => ({
    origin: { countryCode: "UA", city: "Kyiv", postalCode: "01001", province: null, address1: "Test street 1", address2: null },
    destination: { countryCode: "DE", city: "Berlin", postalCode: "10178", province: null, address1: "", address2: null },
    parcels: [{ packageCode: "m", lengthCm: 35, widthCm: 25, heightCm: 8, actualWeightGrams: 473, volumetricWeightGrams: 1400, chargeableWeightGrams: 1400 }],
    declaredValue: { amount: "49.80", currency: "EUR" },
    items: [{ hsCode: "6109100010", quantity: 2, unitValue: { amount: "24.90", currency: "EUR" }, weightGrams: 150 }],
    ...overrides,
  });
  const CALC = {
    scheduledDeliveryDate: "2026-12-02T00:00:00.000000Z",
    services: [
      { deliveryType: "4f6e-uuid", deliveryTypeName: "standard", cost: 615.4, price: 650, discount: 34.6, recipientPayerFeesCustomsCost: 0 },
    ],
  };

  it("builds the calculation request and maps quotes in the settings tariff currency", async () => {
    const { adapter, api } = setup(() => ({ status: 200, json: CALC }), {
      settings: { novaPost: { ...SETTINGS.novaPost, deliveryType: "standard", payerContractNumber: "CN-1" } },
    });
    const quotes = await adapter.quoteRates(rateRequest());
    expect(quotes).toEqual([
      {
        serviceCode: "standard",
        serviceName: "standard",
        price: { amount: "615.40", currency: "UAH" },
        minDeliveryDays: null,
        maxDeliveryDays: null,
        estimatedDeliveryDate: "2026-12-02",
        dutiesEstimate: { amount: "0.00", currency: "UAH" },
      },
    ]);
    const call = api.apiCalls()[0]!;
    expect([call.method, call.path]).toEqual(["POST", "/shipments/calculations"]);
    expect(call.body).toEqual({
      payerType: "Sender",
      payerContractNumber: "CN-1",
      deliveryTypes: ["standard"],
      invoice: { incoterm: "DAP", currency: "EUR", cost: 49.8, payerFeesCustoms: "Recipient", items: [{ hsCode: "6109100010", amount: 2, cost: 24.9 }] },
      sender: { companyTin: "12345678", companyName: "Test Shop LLC", countryCode: "UA", divisionNumber: "32521/1", addressParts: {} },
      recipient: { countryCode: "DE", addressParts: { city: "Berlin", postCode: "10178" } },
      // 49.80 EUR × 45 = 2241.00 UAH (insuranceCost — у валюті країни відправника).
      parcels: [{ rowNumber: 1, cargoCategory: "parcel", actualWeight: 480, length: 350, width: 250, height: 80, insuranceCost: 2241 }],
    });
  });

  it("response currency comes from settings; insuranceCost stays in the sender-country currency; no invoice for a domestic route", async () => {
    const { adapter, api } = setup(() => ({ status: 200, json: CALC }), {
      settings: { novaPost: { ...SETTINGS.novaPost, tariffCurrency: "PLN" }, shipper: {} },
    });
    const quotes = await adapter.quoteRates(
      rateRequest({ destination: { countryCode: "UA", city: "Lviv", postalCode: "79000", province: null, address1: "", address2: null }, declaredValue: { amount: "100.00", currency: "UAH" } }),
    );
    expect(quotes[0]).toMatchObject({ price: { amount: "615.40", currency: "PLN" }, dutiesEstimate: null });
    const body = api.apiCalls()[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty("invoice");
    expect(body).not.toHaveProperty("deliveryTypes");
    expect(body.sender).toEqual({ countryCode: "UA", addressParts: { city: "Kyiv", postCode: "01001" } });
    // 100 UAH передаються як 100 (валюта країни відправника), а не перераховуються у валюту тарифу PLN.
    expect((body.parcels as Array<{ insuranceCost: number }>)[0]!.insuranceCost).toBe(100);
  });

  it("declared value that cannot be expressed in the sender-country currency → not_configured, no request", async () => {
    // Курси задані відносно валюти тарифу (EUR), а insuranceCost має бути в UAH: 100 EUR не можна надіслати як «100».
    const eurTariff = setup(() => ({ status: 200, json: CALC }), {
      settings: { novaPost: { ...SETTINGS.novaPost, tariffCurrency: "EUR" }, checkoutRates: { fxRates: [{ currency: "USD", rate: "0.9" }] } },
    });
    const err = await carrierError(eurTariff.adapter.quoteRates(rateRequest({ declaredValue: { amount: "100.00", currency: "EUR" } })));
    expect(err.kind).toBe("not_configured");
    expect(err.message).toContain("UAH");
    expect(eurTariff.api.fetch).not.toHaveBeenCalled();
    // Відправник не з України — валюта країни відправника невідома адаптеру.
    const foreign = setup(() => ({ status: 200, json: CALC }));
    const origin = { countryCode: "PL", city: "Warszawa", postalCode: "00-001", province: null, address1: "", address2: null };
    expect((await carrierError(foreign.adapter.quoteRates(rateRequest({ origin })))).kind).toBe("not_configured");
    expect(foreign.api.fetch).not.toHaveBeenCalled();
  });

  it("missing exchange rate → not_configured without a network call; API errors are classified", async () => {
    const noRate = setup(() => ({ status: 200, json: CALC }), { settings: { checkoutRates: { fxRates: [] } } });
    expect((await carrierError(noRate.adapter.quoteRates(rateRequest()))).kind).toBe("not_configured");
    expect(noRate.api.fetch).not.toHaveBeenCalled();
    expect((await carrierError(setup(() => ({ status: 422, json: { errors: { "parcels.0.insuranceCost": "required" } } })).adapter.quoteRates(rateRequest()))).kind).toBe(
      "rejected",
    );
    expect((await carrierError(setup(() => ({ status: 503 })).adapter.quoteRates(rateRequest()))).kind).toBe("unavailable");
  });
});

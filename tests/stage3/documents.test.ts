/**
 * Етап 3: документи відправлення — які документи перевізника доступні, отримання PDF через адаптер
 * і ресурсний маршрут …/orders/:orderId/shipments/:shipmentId/documents/:kind (демо-середовище).
 */
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { REVOKE_AFTER_MS, documentErrorKey, downloadCarrierDocument, readDocumentResponse } from "~/components/carrier-documents";
import { TRACKING_STATUSES } from "~/components/tracking-badge";
import { orderLineItems, orders } from "~/db/schema";
import { makeActor } from "~/domain/permissions";
import { DICTIONARIES, hasKey } from "~/i18n";
import { CarrierError, TEST_CARRIER_CODE, createCarrierRegistry } from "~/integrations/carriers";
import {
  CARRIER_DOCUMENT_KINDS,
  type CarrierAdapter,
  type CarrierCapabilities,
  type CarrierDocument,
  type CarrierDocumentKind,
  type CreatedShipment,
  type LookupResult,
  type ShipmentRef,
} from "~/integrations/carriers/types";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { resetEnvCache } from "~/lib/env.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { availableDocumentKinds, fetchCarrierDocument } from "~/modules/shipments/documents.server";
import { createWaybill } from "~/modules/shipments/waybill.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";

const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

const OWNER = makeActor({ id: "demo-owner", displayName: "Owner", role: "owner" });
const STAFF = makeActor({ id: "demo-staff", displayName: "Staff", role: "staff" });

class DocumentsCarrier implements CarrierAdapter {
  readonly mode = "test" as const;
  readonly displayName = "Documents carrier";
  readonly capabilities: CarrierCapabilities;
  private n = 0;
  calls: { ref: ShipmentRef; kind: CarrierDocumentKind }[] = [];
  failWith: CarrierError | null = null;
  constructor(
    readonly code: string,
    documents: boolean,
  ) {
    this.capabilities = {
      rates: false,
      availability: false,
      createShipment: true,
      updateShipment: false,
      cancelShipment: true,
      documents,
      tracking: false,
      returns: false,
      findByReference: false,
      referenceLookupAuthoritative: false,
      documentKinds: documents ? ["label", "invoice"] : [],
    };
    if (!documents) this.getDocument = undefined;
  }
  async createShipment(): Promise<CreatedShipment> {
    this.n++;
    const num = `${this.code.toUpperCase()}${String(this.n).padStart(8, "0")}`;
    return { carrierShipmentId: `${this.code}-${this.n}`, waybillNumber: num, trackingNumber: num, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment() {
    return { cancelled: true };
  }
  getDocument?: (ref: ShipmentRef, kind: CarrierDocumentKind) => Promise<CarrierDocument> = async (ref, kind) => {
    this.calls.push({ ref, kind });
    if (this.failWith) throw this.failWith;
    return {
      kind,
      format: "pdf",
      contentType: "application/pdf",
      content: new TextEncoder().encode(`%PDF-1.4 ${kind}`),
      fileName: `${ref.waybillNumber} ${kind}.pdf`,
    };
  };
}

const withDocs = new DocumentsCarrier("docs", true);
const withoutDocs = new DocumentsCarrier("nodocs", false);
let route: typeof import("~/pages/order-document");
let restore: () => void = () => {};

async function ctxFor(actor = OWNER, defaultCode = withDocs.code): Promise<ServiceContext> {
  const runtime = await getDemoRuntime();
  return {
    mode: "demo",
    db: runtime.handle.db,
    actor,
    // Демо-реєстр уже містить тестових адаптерів (beforeAll); тут лише інший перевізник за замовчуванням.
    carriers: createCarrierRegistry(runtime.carriers.list(), defaultCode),
    shopify: new DemoShopifyGateway(),
    now: () => new Date(),
  };
}

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  route = await import("~/pages/order-document");
  // Ресурсний маршрут бере перевізників із демо-середовища — додаємо тестових адаптерів.
  const runtime = await getDemoRuntime();
  const original = runtime.carriers;
  runtime.carriers = createCarrierRegistry([...original.list(), withDocs, withoutDocs], original.getDefault()?.code);
  restore = () => {
    runtime.carriers = original;
  };
});

afterAll(() => {
  restore();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

let counter = 0;

/** Копія «чистого» демо-замовлення #1001 (кожен тест — окреме замовлення). */
async function cleanOrder(): Promise<string> {
  const { handle } = await getDemoRuntime();
  const db = handle.db;
  const [src] = await db.select().from(orders).where(eq(orders.orderNumber, "#1001"));
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src!;
  counter++;
  const [row] = await db
    .insert(orders)
    .values({ ...rest, orderNumber: `#D-${counter}`, status: "paid", version: 1, automationPaused: false })
    .returning({ id: orders.id });
  const items = await db.select().from(orderLineItems).where(eq(orderLineItems.orderId, src!.id));
  for (const { id: _i, orderId: _o, ...item } of items) {
    await db.insert(orderLineItems).values({ ...item, orderId: row!.id, shopifyLineItemId: null });
  }
  return row!.id;
}

async function orderWithWaybill(carrierCode = withDocs.code) {
  const ctx = await ctxFor(OWNER, carrierCode);
  const orderId = await cleanOrder();
  await validateOrderById(ctx, orderId);
  const r = await createWaybill(ctx, orderId);
  if (r.kind !== "created") throw new Error(`waybill not created: ${r.kind}`);
  return { orderId, shipment: r.shipment };
}

async function get(orderId: string, shipmentId: string, kind: string, role?: "owner" | "staff"): Promise<Response> {
  const headers: HeadersInit = role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
  const request = new Request(`http://localhost/demo/orders/${orderId}/shipments/${shipmentId}/documents/${kind}`, { headers });
  return route.loader({ request, params: { orderId, shipmentId, kind }, context: {} } as never) as Promise<Response>;
}

const base = { carrierCode: "docs", status: "created", waybillNumber: "DOCS00000001", carrierShipmentId: "docs-1", carrierReference: "OT-1001-1" };

describe("availableDocumentKinds", () => {
  it("returns the carrier's kinds only for a created waybill made through the carrier API", async () => {
    const ctx = await ctxFor();
    expect(availableDocumentKinds(ctx, base)).toEqual(["label", "invoice"]);
    // Ручне прив'язування номера → у перевізника немає нашого відправлення.
    expect(availableDocumentKinds(ctx, { ...base, carrierShipmentId: "manual:ABC-123456", carrierReference: "MANUAL-ABC-123456" })).toEqual([]);
    expect(availableDocumentKinds(ctx, { ...base, carrierShipmentId: null, carrierReference: "MANUAL-ABC-123456" })).toEqual([]);
    // Не створена / скасована / без номера.
    for (const status of ["creating", "unknown", "failed", "cancelled"]) {
      expect(availableDocumentKinds(ctx, { ...base, status })).toEqual([]);
    }
    expect(availableDocumentKinds(ctx, { ...base, waybillNumber: null })).toEqual([]);
    // Перевізник без документів, невідомий перевізник, тестовий перевізник демо.
    expect(availableDocumentKinds(ctx, { ...base, carrierCode: "nodocs" })).toEqual([]);
    expect(availableDocumentKinds(ctx, { ...base, carrierCode: "missing" })).toEqual([]);
    expect(availableDocumentKinds(ctx, { ...base, carrierCode: TEST_CARRIER_CODE })).toEqual([]);
  });
});

describe("fetchCarrierDocument", () => {
  it("gets the PDF from the adapter by the shipment's carrier ids; staff may view", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    withDocs.calls = [];
    const doc = await fetchCarrierDocument(await ctxFor(STAFF), orderId, shipment.id, "label");
    expect(doc).toMatchObject({ kind: "label", contentType: "application/pdf" });
    expect(new TextDecoder().decode(doc.content)).toBe("%PDF-1.4 label");
    expect(withDocs.calls).toEqual([{ ref: { carrierShipmentId: shipment.carrierShipmentId, waybillNumber: shipment.waybillNumber }, kind: "label" }]);
  });

  it("refuses unavailable kinds, foreign orders and carriers without documents", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    const ctx = await ctxFor();
    await expect(fetchCarrierDocument(ctx, orderId, shipment.id, "customs_declaration")).rejects.toMatchObject({ code: "document.notAvailable" });
    const other = await cleanOrder();
    await expect(fetchCarrierDocument(ctx, other, shipment.id, "label")).rejects.toMatchObject({ code: "error.notFound" });

    const plain = await orderWithWaybill(withoutDocs.code);
    await expect(fetchCarrierDocument(ctx, plain.orderId, plain.shipment.id, "label")).rejects.toMatchObject({ code: "document.notAvailable" });
  });
});

describe("document resource route", () => {
  it("returns application/pdf inline with a safe file name", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    const res = await get(orderId, shipment.id, "invoice", "staff");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe(`inline; filename="${shipment.waybillNumber}_invoice.pdf"`);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe("%PDF-1.4 invoice");
  });

  it("409 for a kind the carrier does not provide, 404 for unknown kinds and shipments", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    const unavailable = await get(orderId, shipment.id, "customs_declaration");
    expect(unavailable.status).toBe(409);
    expect(await unavailable.text()).toBe("document.notAvailable");

    const unknownKind = await get(orderId, shipment.id, "receipt");
    expect(unknownKind.status).toBe(404);
    const unknownShipment = await get(orderId, "00000000-0000-4000-8000-000000000000", "label");
    expect(unknownShipment.status).toBe(404);
    const foreignOrder = await get(await cleanOrder(), shipment.id, "label");
    expect(foreignOrder.status).toBe(404);
  });

  it("maps carrier errors to 409/503 text codes without details", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    withDocs.failWith = new CarrierError("unavailable", "docs", "connection refused: secret details");
    try {
      const res = await get(orderId, shipment.id, "label");
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("carrier.unavailable");
      withDocs.failWith = new CarrierError("rejected", "docs", "not printable");
      const rejected = await get(orderId, shipment.id, "label");
      expect(rejected.status).toBe(409);
      expect(await rejected.text()).toBe("carrier.rejected");
    } finally {
      withDocs.failWith = null;
    }
  });
});

describe("document errors and tracking i18n (UI)", () => {
  it("maps every response code to an existing message", () => {
    const cases: [number, string, string][] = [
      [409, "document.notAvailable", "tracking.documents.error.notAvailable"],
      [409, "carrier.rejected", "tracking.documents.error.rejected"],
      [503, "carrier.unavailable", "tracking.documents.error.unavailable"],
      [503, "carrier.unknown_outcome", "tracking.documents.error.unavailable"],
      [503, "carrier.auth", "tracking.documents.error.auth"],
      [503, "carrier.not_configured", "tracking.documents.error.notConfigured"],
      [409, "carrier.not_supported", "tracking.documents.error.notAvailable"],
      [403, "Forbidden", "tracking.documents.error.forbidden"],
      [404, "Not Found", "tracking.documents.error.notFound"],
      [401, "", "tracking.documents.error.session"],
      [500, "error.generic", "tracking.documents.error.generic"],
      [502, "<html>bad gateway</html>", "tracking.documents.error.generic"],
    ];
    for (const [status, body, key] of cases) {
      expect(documentErrorKey(status, body), `${status} ${body}`).toBe(key);
      expect(hasKey(key), key).toBe(true);
    }
  });

  it("has uk/en labels for every tracking status, document kind and Shopify outcome", () => {
    const keys = [
      ...TRACKING_STATUSES.map((s) => `tracking.status.${s}`),
      "tracking.status.none",
      ...CARRIER_DOCUMENT_KINDS.map((k) => `tracking.documents.kind.${k}`),
      ...["created", "already_recorded", "found_existing", "already_fulfilled_in_shopify", "not_ready", "not_linked"].map(
        (o) => `tracking.shopify.outcome.${o}`,
      ),
      ...["manual", "tracking"].map((s) => `tracking.handover.source.${s}`),
      ...["tracking_status", "handed_over", "shopify_fulfilled"].map((e) => `order.event.${e}`),
    ];
    expect(TRACKING_STATUSES).toHaveLength(12);
    expect(keys.filter((k) => !(k in DICTIONARIES.uk) || !(k in DICTIONARIES.en))).toEqual([]);
    // До фактичної передачі посилку не називаємо відправленою.
    expect(DICTIONARIES.uk["tracking.status.created"]).not.toMatch(/відправлен/i);
    expect(DICTIONARIES.en["tracking.status.created"]).not.toMatch(/shipped/i);
  });
});

// ---------------------------------------------------------------------------
// Клієнт: CarrierDocumentButtons → downloadCarrierDocument (fetch → перевірка відповіді → blob → нова вкладка).
// Без DOM-середовища: window/document/URL підмінено мінімальними заглушками.
// ---------------------------------------------------------------------------

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

function stubBrowser(fetchImpl: (url: string, init?: RequestInit) => Promise<Response>, { popupBlocked = false } = {}) {
  const fetch = vi.fn(fetchImpl);
  const open = vi.fn((_url: string, _target: string) => (popupBlocked ? null : {}));
  const setTimeout = vi.fn();
  vi.stubGlobal("window", { fetch, open, setTimeout });
  const anchors: FakeAnchor[] = [];
  const appendChild = vi.fn();
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const a: FakeAnchor = { href: "", download: "", rel: "", click: vi.fn(), remove: vi.fn() };
      anchors.push(a);
      return a;
    }),
    body: { appendChild },
  });
  const blobs: Blob[] = [];
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    blobs.push(blob as Blob);
    return `blob:test/${blobs.length}`;
  });
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return { fetch, open, setTimeout, anchors, appendChild, blobs, revoke };
}

const docUrl = (orderId: string, shipmentId: string, kind: string) => `/demo/orders/${orderId}/shipments/${shipmentId}/documents/${kind}`;

describe("carrier document download (client)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens the PDF from the resource route in a new tab; fetch does not follow redirects", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    const b = stubBrowser(() => get(orderId, shipment.id, "label"));
    const url = docUrl(orderId, shipment.id, "label");
    expect(await downloadCarrierDocument(url, "label.pdf")).toBeNull();
    expect(b.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: "same-origin", redirect: "manual" }));
    expect(b.blobs).toHaveLength(1);
    expect(b.blobs[0]!.type).toBe("application/pdf");
    expect(await b.blobs[0]!.text()).toBe("%PDF-1.4 label");
    expect(b.open).toHaveBeenCalledWith("blob:test/1", "_blank");
    expect(b.anchors).toEqual([]);
    // Посилання на blob звільняється згодом.
    expect(b.setTimeout).toHaveBeenCalledWith(expect.any(Function), REVOKE_AFTER_MS);
    (b.setTimeout.mock.calls[0]![0] as () => void)();
    expect(b.revoke).toHaveBeenCalledWith("blob:test/1");
  });

  it("downloads the file under the server's safe name when the new tab is blocked", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    const b = stubBrowser(() => get(orderId, shipment.id, "invoice"), { popupBlocked: true });
    expect(await downloadCarrierDocument(docUrl(orderId, shipment.id, "invoice"), "invoice.pdf")).toBeNull();
    expect(b.open).toHaveBeenCalledTimes(1);
    expect(b.anchors).toHaveLength(1);
    expect(b.anchors[0]).toMatchObject({ href: "blob:test/1", download: `${shipment.waybillNumber}_invoice.pdf`, rel: "noopener" });
    expect(b.appendChild).toHaveBeenCalledWith(b.anchors[0]);
    expect(b.anchors[0]!.click).toHaveBeenCalledTimes(1);
    expect(b.anchors[0]!.remove).toHaveBeenCalledTimes(1);
  });

  it("returns the inline error for a non-200 response and opens nothing", async () => {
    const { orderId, shipment } = await orderWithWaybill();
    const b = stubBrowser(() => get(orderId, shipment.id, "customs_declaration"));
    expect(await downloadCarrierDocument(docUrl(orderId, shipment.id, "customs_declaration"), "customs_declaration.pdf")).toBe(
      "tracking.documents.error.notAvailable",
    );
    b.fetch.mockImplementation(() => get(orderId, shipment.id, "label"));
    withDocs.failWith = new CarrierError("unavailable", "docs", "down");
    try {
      expect(await downloadCarrierDocument(docUrl(orderId, shipment.id, "label"), "label.pdf")).toBe("tracking.documents.error.unavailable");
    } finally {
      withDocs.failWith = null;
    }
    expect(b.open).not.toHaveBeenCalled();
    expect(b.blobs).toEqual([]);
  });

  it("an expired session (redirect to the login page or HTML instead of a PDF) is reported, never opened", async () => {
    // Демо з паролем без cookie доступу: ресурсний маршрут перенаправляє на вхід (у браузері fetch з
    // redirect: "manual" отримує opaqueredirect, а не HTML сторінки входу зі статусом 200).
    const { orderId, shipment } = await orderWithWaybill();
    const env = { DEMO_PASSWORD: process.env.DEMO_PASSWORD, SESSION_SECRET: process.env.SESSION_SECRET };
    process.env.DEMO_PASSWORD = "test-password";
    process.env.SESSION_SECRET = "s".repeat(40);
    resetEnvCache();
    try {
      const thrown = await get(orderId, shipment.id, "label").catch((e: unknown) => e);
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(302);
      expect((thrown as Response).headers.get("Location")).toMatch(/^\/demo\/login\?next=/);
    } finally {
      for (const [k, v] of Object.entries(env)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetEnvCache();
    }

    const opaque = { type: "opaqueredirect", redirected: false, ok: false, status: 0, headers: new Headers(), text: async () => "" };
    const followed = new Response("<!doctype html><title>Login</title>", { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
    Object.defineProperty(followed, "redirected", { value: true });
    const html = () => new Response("<!doctype html><title>Login</title>", { status: 200, headers: { "Content-Type": "text/html" } });
    const json = () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });

    const b = stubBrowser(async () => opaque as unknown as Response);
    expect(await downloadCarrierDocument("/demo/x", "label.pdf")).toBe("tracking.documents.error.session");
    b.fetch.mockImplementation(async () => followed);
    expect(await downloadCarrierDocument("/demo/x", "label.pdf")).toBe("tracking.documents.error.session");
    b.fetch.mockImplementation(async () => html());
    expect(await downloadCarrierDocument("/demo/x", "label.pdf")).toBe("tracking.documents.error.session");
    b.fetch.mockImplementation(async () => new Response("", { status: 401 }));
    expect(await downloadCarrierDocument("/demo/x", "label.pdf")).toBe("tracking.documents.error.session");
    b.fetch.mockImplementation(async () => json());
    expect(await downloadCarrierDocument("/demo/x", "label.pdf")).toBe("tracking.documents.error.generic");
    expect(b.open).not.toHaveBeenCalled();
    expect(b.blobs).toEqual([]);
  });

  it("reports a network failure", async () => {
    const b = stubBrowser(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await downloadCarrierDocument("/demo/x", "label.pdf")).toBe("tracking.documents.error.network");
    expect(b.open).not.toHaveBeenCalled();
  });

  it("rebuilds the blob with the checked type and keeps only a safe file name", async () => {
    const ok = await readDocumentResponse(
      new Response(new TextEncoder().encode("%PDF-1.4"), {
        status: 200,
        headers: { "Content-Type": "application/pdf; charset=binary", "Content-Disposition": 'inline; filename="../evil<script>.pdf"' },
      }),
      "label.pdf",
    );
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.blob.type).toBe("application/pdf");
    expect(ok.fileName).toBe("label.pdf");
  });
});

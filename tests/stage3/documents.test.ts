/**
 * Етап 3: документи відправлення — які документи перевізника доступні, отримання PDF через адаптер
 * і ресурсний маршрут …/orders/:orderId/shipments/:shipmentId/documents/:kind (демо-середовище).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { documentErrorKey } from "~/components/carrier-documents";
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

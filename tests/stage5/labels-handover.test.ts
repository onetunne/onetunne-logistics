import { PDFDocument } from "pdf-lib";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { orders } from "~/db/schema";
import { ForbiddenError, makeActor, type Actor } from "~/domain/permissions";
import {
  createCarrierRegistry,
  type CarrierAdapter,
  type CarrierCallOptions,
  type CarrierCapabilities,
  type CarrierDocument,
  type CreatedShipment,
  type LookupResult,
} from "~/integrations/carriers";
import { DOCUMENT_TOO_LARGE_CODE, MAX_DOCUMENT_BYTES, NovaPostClient } from "~/integrations/carriers/nova-post/client.server";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { MAX_LABEL_PAGES } from "~/modules/packing/constants";
import { appendLabel, mergeCarrierLabels, pngDimensions } from "~/modules/packing/documents.server";
import { loadHandoverList } from "~/modules/packing/handover-list.server";
import { confirmPacked, recordScan, startPacking } from "~/modules/packing/packing.server";
import { loadPackingScreen } from "~/modules/packing/view.server";
import { createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Регресії рецензії G1b: межі об'єднаного PDF етикеток (security-4), загальний час пакета (packing-12), зразок
 * етикетки тестового перевізника в демо (gap-9) і список посилок для передачі перевізнику (gap-12).
 */

async function pdfWithPages(n: number): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < n; i += 1) doc.addPage([100, 100]);
  return doc.save();
}

/** Заголовок PNG (сигнатура + IHDR) із заданими розмірами — без пікселів (декодування не потрібне для перевірки). */
function pngHeader(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

describe("label limits (security-4)", () => {
  it("appendLabel refuses PDFs over the page limit, PNGs over the pixel limit (read from IHDR, not decoded) and oversized files", async () => {
    const merged = await PDFDocument.create();
    expect(await appendLabel(merged, { format: "pdf", content: await pdfWithPages(MAX_LABEL_PAGES + 1) })).toBe("too_large");
    expect(await appendLabel(merged, { format: "pdf", content: await pdfWithPages(MAX_LABEL_PAGES) })).toBe(MAX_LABEL_PAGES);
    expect(await appendLabel(merged, { format: "png", content: pngHeader(20_000, 20_000) })).toBe("too_large");
    expect(await appendLabel(merged, { format: "png", content: pngHeader(0, 10) })).toBe("invalid_pdf");
    expect(await appendLabel(merged, { format: "pdf", content: new Uint8Array(6 * 1024 * 1024) })).toBe("too_large");
    expect(merged.getPageCount()).toBe(MAX_LABEL_PAGES);
    expect(pngDimensions(pngHeader(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeNull();
  });

  it("the Nova Post client stops reading a document over the byte cap (Content-Length and streamed size)", async () => {
    const auth = () => new Response(JSON.stringify({ jwt: "eyJa.eyJb.sig" }), { status: 200 });
    const client = (doc: () => Response) =>
      new NovaPostClient({
        apiKey: "test-key-1234567890abcdef",
        baseUrl: "https://api.example.invalid/v.1.0",
        fetch: async (url) => (url.includes("/clients/authorization") ? auth() : doc()),
      });
    const declared = client(() => new Response("%PDF-1.4", { status: 200, headers: { "content-type": "application/pdf", "content-length": String(MAX_DOCUMENT_BYTES + 1) } }));
    await expect(declared.requestBinary("/shipments/print")).rejects.toMatchObject({ kind: "unavailable", details: [{ carrierCode: DOCUMENT_TOO_LARGE_CODE }] });
    let pulled = 0;
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            controller.enqueue(new Uint8Array(64 * 1024));
            if (pulled > 10_000) controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "application/pdf" } },
      );
    await expect(client(endless).requestBinary("/shipments/print", { maxBytes: 256 * 1024 })).rejects.toMatchObject({
      details: [{ carrierCode: DOCUMENT_TOO_LARGE_CODE }],
    });
    expect(pulled).toBeLessThan(20); // читання зупинено одразу після перевищення
    const small = await client(() => new Response("%PDF-1.4 ok", { status: 200, headers: { "content-type": "application/pdf" } })).requestBinary("/x");
    expect(new TextDecoder().decode(small.bytes!)).toBe("%PDF-1.4 ok");
  });
});

// ---------------------------------------------------------------------------

const CAPS: CarrierCapabilities = {
  rates: false,
  availability: false,
  createShipment: true,
  updateShipment: false,
  cancelShipment: true,
  documents: true,
  tracking: false,
  returns: false,
  findByReference: false,
  referenceLookupAuthoritative: false,
  documentKinds: ["label"],
};

/** Перевізник, чиї етикетки «зависають» (не відповідають і ігнорують скасування) — для загального часу пакета. */
class HangingLabelCarrier implements CarrierAdapter {
  readonly code = "hang_lbl";
  readonly displayName = "Hanging label carrier";
  readonly mode = "test" as const;
  readonly capabilities = CAPS;
  private n = 0;
  calls = 0;
  async createShipment(): Promise<CreatedShipment> {
    const n = ++this.n;
    return { carrierShipmentId: `hang-${n}`, waybillNumber: `HNG${String(n).padStart(8, "0")}`, trackingNumber: null, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment() {
    return { cancelled: true };
  }
  getDocument(_ref: unknown, _kind: unknown, _opts?: CarrierCallOptions): Promise<CarrierDocument> {
    this.calls += 1;
    return new Promise(() => undefined);
  }
}

let env: TestEnv;
const hanging = new HangingLabelCarrier();
let ctxOf: (actor?: Actor, carrier?: "demo" | "hanging") => ServiceContext;
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv();
  const base = env.ctx(OWNER);
  const hangingRegistry = createCarrierRegistry([...base.carriers.list(), hanging], hanging.code);
  ctxOf = (actor = OWNER, carrier = "demo") => (carrier === "hanging" ? { ...env.ctx(actor), carriers: hangingRegistry } : env.ctx(actor));
  for (const [number, carrier] of [
    ["#1001", "demo"],
    ["#1009", "demo"],
    ["#1011", "demo"],
    ["#1002", "hanging"],
    ["#1012", "hanging"],
  ] as const) {
    const id = await env.orderId(number);
    await validateOrderById(ctxOf(OWNER, carrier), id);
    const r = await createWaybill(ctxOf(OWNER, carrier), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill ${number}: ${r.kind}`);
    ids[number] = id;
  }
});
afterAll(async () => {
  await env.close();
});

async function pack(orderId: string) {
  await startPacking(env.ctx(STAFF), orderId);
  const screen = await loadPackingScreen(env.ctx(), orderId);
  for (const line of screen.lines) for (let i = line.packed; i < line.required; i += 1) await recordScan(env.ctx(STAFF), orderId, line.barcode ?? line.sku ?? "");
  const fresh = await loadPackingScreen(env.ctx(), orderId);
  expect((await confirmPacked(env.ctx(STAFF), orderId, fresh.packing!.version)).kind).toBe("packed");
}

describe("merged labels: overall deadline (packing-12) and demo sample labels (gap-9)", () => {
  it("a hanging carrier does not hold the request beyond the deadline; unfetched labels are skipped as timeout", async () => {
    const started = Date.now();
    const r = await mergeCarrierLabels(ctxOf(STAFF, "hanging"), [ids["#1002"]!, ids["#1012"]!, ids["#1001"]!], { deadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(Object.fromEntries(r.skipped.map((s) => [s.orderNumber, s.reason]))).toEqual({ "#1002": "timeout", "#1012": "timeout" });
    // Етикетку тестового перевізника (демо) отримано до вичерпання часу.
    expect(r.included.map((i) => i.orderNumber)).toEqual(["#1001"]);
  });

  it("demo test carrier labels are merged (each a one-page TEST sample)", async () => {
    const r = await mergeCarrierLabels(ctxOf(STAFF), [ids["#1001"]!, ids["#1009"]!]);
    expect(r.included.map((i) => [i.orderNumber, i.pages]).sort()).toEqual([
      ["#1001", 1],
      ["#1009", 1],
    ]);
    const merged = await PDFDocument.load(r.pdf!);
    expect(merged.getPageCount()).toBe(2);
  });
});

describe("carrier handover list (gap-12)", () => {
  it("lists only packed parcels with a valid, not handed over waybill, grouped by carrier; selection lists the rest with a reason", async () => {
    expect((await loadHandoverList(ctxOf(STAFF))).total).toBe(0);
    await pack(ids["#1001"]!);
    await pack(ids["#1009"]!);
    const all = await loadHandoverList(ctxOf(STAFF));
    expect(all).toMatchObject({ total: 2, hasTest: true, selection: false, truncated: false, skipped: [] });
    expect(all.groups).toHaveLength(1);
    expect(all.groups[0]!.parcels.map((p) => p.orderNumber).sort()).toEqual(["#1001", "#1009"]);
    expect(all.groups[0]!.totalWeightGrams).toBe(all.groups[0]!.parcels.reduce((s, p) => s + (p.waybillWeightGrams ?? 0), 0));
    const parcel = all.groups[0]!.parcels.find((p) => p.orderNumber === "#1001")!;
    const shipment = (await findActiveShipment(env.handle.db, ids["#1001"]!))!;
    expect(parcel).toMatchObject({ waybillNumber: shipment.waybillNumber, testMode: true, packedByName: STAFF.displayName });
    // Без персональних даних, крім країни й міста (як у черзі пакування).
    expect(Object.keys(parcel).sort()).toEqual(
      ["city", "countryCode", "orderId", "orderNumber", "packedAt", "packedByName", "packedWeightGrams", "priority", "testMode", "waybillNumber", "waybillWeightGrams"].sort(),
    );

    await markHandedOver(env.ctx(OWNER), (await findActiveShipment(env.handle.db, ids["#1009"]!))!.id);
    const selected = await loadHandoverList(ctxOf(STAFF), { orderIds: [ids["#1001"]!, ids["#1009"]!, ids["#1011"]!] });
    expect(selected.total).toBe(1);
    expect(Object.fromEntries(selected.skipped.map((s) => [s.orderNumber, s.reason]))).toEqual({ "#1009": "handed_over", "#1011": "not_packed" });
    await env.handle.db.update(orders).set({ status: "cancelled" }).where(eq(orders.id, ids["#1011"]!));
    const again = await loadHandoverList(ctxOf(STAFF), { orderIds: [ids["#1011"]!] });
    expect(again.skipped).toEqual([{ orderId: ids["#1011"], orderNumber: "#1011", reason: "cancelled" }]);
  });

  it("requires packing.perform and orders.view", async () => {
    const noPacking = makeActor({ id: "np", displayName: "NP", role: "staff", overrides: { revoke: ["packing.perform"] } });
    await expect(loadHandoverList(ctxOf(noPacking))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

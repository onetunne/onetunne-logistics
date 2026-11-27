import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ForbiddenError, makeActor, type Actor } from "~/domain/permissions";
import {
  CarrierError,
  createCarrierRegistry,
  type CarrierAdapter,
  type CarrierCapabilities,
  type CarrierDocument,
  type CarrierDocumentKind,
  type CreatedShipment,
  type LookupResult,
  type ShipmentRef,
} from "~/integrations/carriers";
import { validateOrderById } from "~/modules/orders/workflow.server";
import { appendLabel, loadPrintBatch, mergeCarrierLabels } from "~/modules/packing/documents.server";
import { createWaybill, findActiveShipment } from "~/modules/shipments/waybill.server";
import { markHandedOver } from "~/modules/tracking/tracking.server";
import type { ServiceContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * Масовий друк: об'єднаний PDF етикеток перевізника (pdf-lib) з пропуском зашифрованих/пошкоджених/недоступних
 * етикеток, і пакувальні листи + інвойси. Перевізник з етикетками — тестовий двійник (нічого не надсилає).
 */

type Behaviour = "pdf" | "pdf2" | "png" | "encrypted" | "invalid" | "error" | "zpl";

async function makePdf(pages: number, text: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) doc.addPage([288, 432]).drawText(`${text} ${i + 1}`, { x: 20, y: 400, size: 16, font });
  return doc.save({ useObjectStreams: false });
}

/** PDF з /Encrypt у трейлері (pdf-lib не шифрує — достатньо позначки, яку бачить завантажувач). */
async function makeEncryptedPdf(): Promise<Uint8Array> {
  const text = Buffer.from(await makePdf(1, "SECRET")).toString("latin1");
  return new Uint8Array(Buffer.from(text.replace(/trailer\s*<</, "trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O (x) /U (y) /P -4 >>"), "latin1"));
}

/** Найменший коректний PNG 1×1. */
const PNG_1X1 = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64"),
);

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

class FakeLabelCarrier implements CarrierAdapter {
  readonly code = "fake_lbl";
  readonly displayName = "Fake label carrier";
  readonly mode = "test" as const;
  readonly capabilities = CAPS;
  private n = 0;
  readonly behaviour = new Map<string, Behaviour>();
  calls = 0;
  async createShipment(): Promise<CreatedShipment> {
    const n = ++this.n;
    const num = `FLB${String(n).padStart(8, "0")}`;
    return { carrierShipmentId: `fake-lbl-${n}`, waybillNumber: num, trackingNumber: num, createdAt: new Date() };
  }
  async findShipmentByReference(): Promise<LookupResult> {
    return { found: false, authoritative: false };
  }
  async cancelShipment() {
    return { cancelled: true };
  }
  async getDocument(ref: ShipmentRef, kind: CarrierDocumentKind): Promise<CarrierDocument> {
    this.calls += 1;
    const b = this.behaviour.get(ref.waybillNumber) ?? "pdf";
    const doc = (content: Uint8Array, format: CarrierDocument["format"] = "pdf", contentType = "application/pdf"): CarrierDocument => ({
      kind,
      format,
      contentType,
      content,
      fileName: `${ref.waybillNumber}.pdf`,
    });
    switch (b) {
      case "pdf":
        return doc(await makePdf(1, ref.waybillNumber));
      case "pdf2":
        return doc(await makePdf(2, ref.waybillNumber));
      case "png":
        return doc(PNG_1X1, "png", "image/png");
      case "encrypted":
        return doc(await makeEncryptedPdf());
      case "invalid":
        return doc(new TextEncoder().encode("%PDF-1.4 broken"));
      case "zpl":
        return doc(new TextEncoder().encode("^XA^XZ"), "zpl", "application/zpl");
      case "error":
        throw new CarrierError("unavailable", this.code, "down");
    }
  }
}

let env: TestEnv;
const carrier = new FakeLabelCarrier();
let ctxOf: (actor?: Actor) => ServiceContext;
const ids: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv();
  const base = env.ctx(OWNER);
  const carriers = createCarrierRegistry([...base.carriers.list(), carrier], carrier.code);
  ctxOf = (actor = OWNER) => ({ ...env.ctx(actor), carriers });
  const plan: Array<[string, Behaviour]> = [
    ["#1001", "pdf"],
    ["#1002", "pdf2"],
    ["#1009", "png"],
    ["#1011", "encrypted"],
    ["#1012", "invalid"],
    ["#1007", "error"],
    ["#1003", "zpl"],
  ];
  for (const [number, behaviour] of plan) {
    const id = await env.orderId(number);
    await validateOrderById(ctxOf(), id);
    const r = await createWaybill(ctxOf(), id, { source: "manual" });
    if (r.kind !== "created") throw new Error(`waybill ${number}: ${r.kind}`);
    carrier.behaviour.set(r.shipment.waybillNumber!, behaviour);
    ids[number] = id;
  }
  ids["#0998"] = await env.orderId("#0998"); // накладна тестового перевізника демо (зразок етикетки TEST)
  ids["#1004"] = await env.orderId("#1004"); // без накладної
});
afterAll(async () => {
  await env.close();
});

describe("merged carrier labels", () => {
  it("merges PDF/PNG labels and lists every skipped order with a reason", async () => {
    const missing = "99999999-9999-4999-8999-999999999999";
    const all = [...Object.values(ids), missing];
    const r = await mergeCarrierLabels(ctxOf(STAFF), all);
    expect(r.missing).toBe(1);
    expect(r.included.map((i) => [i.orderNumber, i.pages]).sort()).toEqual([
      // Етап 5: тестовий перевізник демо видає зразок етикетки (1 сторінка, позначка TEST).
      ["#0998", 1],
      ["#1001", 1],
      ["#1002", 2],
      ["#1009", 1],
    ]);
    expect(Object.fromEntries(r.skipped.map((s) => [s.orderNumber, s.reason]))).toEqual({
      "#1011": "encrypted",
      "#1012": "invalid_pdf",
      "#1007": "carrier_error",
      "#1003": "unsupported_format",
      "#1004": "not_in_queue",
    });
    const merged = await PDFDocument.load(r.pdf!);
    expect(merged.getPageCount()).toBe(5);
  });

  it("nothing mergeable → no PDF; permissions are checked", async () => {
    const r = await mergeCarrierLabels(ctxOf(STAFF), [ids["#1012"]!, ids["#1011"]!]);
    expect(r.pdf).toBeNull();
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(["encrypted", "invalid_pdf"]);
    const noPacking = makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["packing.perform"] } });
    await expect(mergeCarrierLabels(ctxOf(noPacking), [ids["#1001"]!])).rejects.toBeInstanceOf(ForbiddenError);
    const calls = carrier.calls;
    expect((await mergeCarrierLabels(ctxOf(STAFF), [])).included).toEqual([]);
    expect(carrier.calls).toBe(calls);
  });

  it("a label of an order handed over (not in the queue) is not fetched", async () => {
    const shipment = await findActiveShipment(env.handle.db, ids["#1001"]!);
    await markHandedOver(ctxOf(OWNER), shipment!.id);
    const calls = carrier.calls;
    const r = await mergeCarrierLabels(ctxOf(STAFF), [ids["#1001"]!]);
    expect(r.skipped).toEqual([{ orderId: ids["#1001"], orderNumber: "#1001", reason: "not_in_queue" }]);
    expect(carrier.calls).toBe(calls);
  });

  it("appendLabel rejects broken input without throwing", async () => {
    const doc = await PDFDocument.create();
    expect(await appendLabel(doc, { format: "png", content: new Uint8Array([1, 2, 3]) })).toBe("invalid_pdf");
    expect(await appendLabel(doc, { format: "pdf", content: new Uint8Array() })).toBe("invalid_pdf");
    expect(await appendLabel(doc, { format: "pdf", content: await makeEncryptedPdf() })).toBe("encrypted");
    expect(doc.getPageCount()).toBe(0);
  });
});

describe("packing slips and invoices", () => {
  it("loads slips (items, kit materials, recipient) and invoices in queue order, one entry per order", async () => {
    const batch = await loadPrintBatch(ctxOf(STAFF), [ids["#1009"]!, ids["#1002"]!], ["slip", "invoice"], "uk");
    expect(batch).toMatchObject({ missing: 0, truncated: false });
    expect(batch.entries).toHaveLength(2);
    const slip = batch.entries.find((e) => e.slip?.orderNumber === "#1002")!.slip!;
    expect(slip.lines).toEqual([expect.objectContaining({ sku: "OT-FK-X", quantity: 1, model: "Model X" })]);
    expect(slip.materials.map((m) => m.code).sort()).toEqual(expect.arrayContaining(["bolts_m5", "card_thanks", "instruction_fender", "sticker_logo"]));
    expect(slip.recipient).toMatchObject({ countryCode: "PL", city: expect.any(String) });
    expect(slip.waybillNumber).toMatch(/^FLB/);
    expect(batch.entries.every((e) => e.invoice?.data.lines.length)).toBe(true);
    const slipsOnly = await loadPrintBatch(ctxOf(STAFF), [ids["#1009"]!], ["slip"], "en");
    expect(slipsOnly.entries[0]).toMatchObject({ invoice: null, slip: { orderNumber: "#1009" } });
  });

  it("caps the batch size and reports unknown ids", async () => {
    const fake = Array.from({ length: 55 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
    const r = await loadPrintBatch(ctxOf(STAFF), [ids["#1009"]!, ...fake], ["slip"], "uk");
    expect(r.truncated).toBe(true);
    expect(r.entries).toHaveLength(1);
    expect(r.missing).toBe(49);
    const noView = makeActor({ id: "y", displayName: "Y", role: "staff", overrides: { revoke: ["orders.view"] } });
    await expect(loadPrintBatch(ctxOf(noView), [ids["#1009"]!], ["slip"], "uk")).rejects.toBeInstanceOf(ForbiddenError);
  });
});

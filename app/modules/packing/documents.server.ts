/**
 * Масовий друк для черги пакування:
 * - пакувальні листи + інвойси застосунку (HTML для друку, сторінка picking/print) — loadPrintBatch;
 * - етикетки перевізника, об'єднані в один PDF на сервері (pdf-lib, MIT) — mergeCarrierLabels.
 *
 * Етикетки отримуються ТИМ САМИМ шляхом, що й кнопка «Етикетка» на сторінці замовлення
 * (modules/shipments/documents.server.ts → fetchCarrierDocument: перевірка дозволу, накладна належить
 * замовленню, тайм-аут). Зашифровані/пошкоджені PDF, помилки перевізника й непідтримувані формати не
 * переривають пакет — вони повертаються у переліку «пропущено» з причиною (такі етикетки друкуються по одній).
 * Тестовий перевізник (демо) повертає зразок етикетки з позначкою TEST (не дійсна для відправлення) — щоб
 * об'єднаний друк можна було перевірити в демо.
 * Межі (захист пам'яті й часу запиту): етикетка ≤ MAX_LABEL_BYTES, ≤ MAX_LABEL_PAGES сторінок, PNG ≤ MAX_LABEL_PNG_PIXELS
 * (розміри читаються із заголовка IHDR до декодування) — інакше too_large; загальний час отримання пакета —
 * LABEL_BATCH_DEADLINE_MS: решта замовлень пропускається з причиною timeout. Етикетки додаються до PDF одразу після
 * отримання кожної частини (усі тіла одночасно в пам'яті не тримаються).
 */
import { PDFDocument } from "pdf-lib";
import { isShipped, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { CarrierError } from "~/integrations/carriers/types";
import { countryName } from "~/lib/format";
import { logger } from "~/lib/logger.server";
import type { Locale } from "~/i18n/types";
import type { CommercialInvoice } from "~/modules/customs/invoice";
import { effectiveLineQuantity } from "~/modules/inventory/quantities";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { planPackingMaterials } from "~/modules/packaging/consumption.server";
import { availableDocumentKinds, fetchCarrierDocument, loadOrderInvoice } from "~/modules/shipments/documents.server";
import { findActiveShipment } from "~/modules/shipments/waybill.server";
import type { ServiceContext } from "~/server/types";
import {
  LABEL_BATCH_DEADLINE_MS,
  MAX_LABEL_BYTES,
  MAX_LABEL_ORDERS,
  MAX_LABEL_PAGES,
  MAX_LABEL_PNG_PIXELS,
  MAX_PRINT_ORDERS,
  PACKING_QUEUE_STATUSES,
  type LabelSkipReason,
  type PrintDocument,
} from "./constants";
import { loadActivePacking } from "./packing.server";
import { parseOrderIds } from "./queue-filters";
import { sortOrderIdsLikeQueue } from "./queue.server";

// ---------------------------------------------------------------------------
// Пакувальні листи й інвойси
// ---------------------------------------------------------------------------

export interface PackingSlip {
  orderId: string;
  orderNumber: string;
  status: OrderStatus;
  priority: number;
  placedAt: Date;
  recipient: { name: string; city: string | null; postalCode: string | null; countryCode: string | null; countryName: string | null };
  waybillNumber: string | null;
  carrierName: string | null;
  testMode: boolean;
  lines: Array<{ id: string; title: string; variantTitle: string | null; sku: string | null; model: string | null; color: string | null; imageUrl: string | null; quantity: number }>;
  /** Позиції без товару в каталозі (не пакуються). */
  otherLines: Array<{ id: string; title: string; quantity: number }>;
  materials: Array<{ code: string; name: string; quantity: number; isBox: boolean }>;
  startedByName: string | null;
  packedByName: string | null;
  note: string | null;
}

export interface PrintBatchEntry {
  slip: PackingSlip | null;
  invoice: { data: CommercialInvoice; sellerCountry: string | null; buyerCountry: string | null } | null;
}

export interface PrintBatch {
  entries: PrintBatchEntry[];
  /** Ідентифікатори, яких немає в базі. */
  missing: number;
  truncated: boolean;
}

export async function loadPrintBatch(
  ctx: ServiceContext,
  orderIds: readonly string[],
  docs: readonly PrintDocument[],
  locale: Locale,
): Promise<PrintBatch> {
  requirePermission(ctx.actor, "packing.perform");
  requirePermission(ctx.actor, "orders.view");
  const ids = parseOrderIds(orderIds, MAX_PRINT_ORDERS + 1);
  const truncated = ids.length > MAX_PRINT_ORDERS;
  const sorted = await sortOrderIdsLikeQueue(ctx.db, ids.slice(0, MAX_PRINT_ORDERS));
  const entries: PrintBatchEntry[] = [];
  for (const { id } of sorted) {
    const entry: PrintBatchEntry = { slip: null, invoice: null };
    if (docs.includes("slip")) entry.slip = await loadPackingSlip(ctx, id, locale);
    if (docs.includes("invoice")) {
      const data = await loadOrderInvoice(ctx, id);
      // Мова документа — англійська (його читає митниця), як на сторінці інвойсу.
      entry.invoice = {
        data,
        sellerCountry: data.seller.countryCode ? countryName(data.seller.countryCode, "en") : null,
        buyerCountry: data.buyer.countryCode ? countryName(data.buyer.countryCode, "en") : null,
      };
    }
    entries.push(entry);
  }
  return { entries, missing: Math.min(ids.length, MAX_PRINT_ORDERS) - sorted.length, truncated };
}

async function loadPackingSlip(ctx: ServiceContext, orderId: string, locale: Locale): Promise<PackingSlip> {
  const [order, items, packing, shipment] = await Promise.all([
    loadOrderRow(ctx.db, orderId),
    loadLineItems(ctx.db, orderId),
    loadActivePacking(ctx.db, orderId),
    findActiveShipment(ctx.db, orderId),
  ]);
  const materials = await planPackingMaterials(ctx.db, orderId, packing?.boxMaterialId ?? order.parcelBoxMaterialId ?? null);
  const country = order.shipCountryCode?.trim().toUpperCase() || null;
  const adapter = shipment ? ctx.carriers.get(shipment.carrierCode) : undefined;
  return {
    orderId,
    orderNumber: order.orderNumber,
    status: order.status,
    priority: order.priority,
    placedAt: order.placedAt,
    recipient: {
      name: [order.shipFirstName, order.shipLastName].filter(Boolean).join(" "),
      city: order.shipCity,
      postalCode: order.shipPostalCode,
      countryCode: country,
      countryName: country ? countryName(country, locale) : null,
    },
    waybillNumber: shipment?.status === "created" ? shipment.waybillNumber : null,
    carrierName: adapter?.displayName ?? shipment?.carrierCode ?? null,
    testMode: shipment?.mode === "test",
    lines: items
      .filter((i) => i.variant !== null && effectiveLineQuantity(i) > 0)
      .map((i) => ({
        id: i.id,
        title: i.variant!.productTitle,
        variantTitle: i.variant!.title ?? i.variantTitle,
        sku: i.variant!.sku ?? i.sku,
        model: i.variant!.model,
        color: i.variant!.color,
        imageUrl: i.variant!.imageUrl ?? i.variant!.productImageUrl ?? i.imageUrl,
        quantity: effectiveLineQuantity(i),
      })),
    otherLines: items.filter((i) => i.variant === null).map((i) => ({ id: i.id, title: i.title, quantity: effectiveLineQuantity(i) })),
    materials: materials.map((m) => ({ code: m.code, name: m.name, quantity: m.required, isBox: m.isBox })),
    startedByName: packing?.startedByName ?? null,
    packedByName: packing?.packedByName ?? null,
    note: order.note,
  };
}

// ---------------------------------------------------------------------------
// Об'єднані етикетки перевізника (PDF)
// ---------------------------------------------------------------------------

export interface LabelBatchItem {
  orderId: string;
  orderNumber: string;
}

export interface LabelBatchResult {
  /** Об'єднаний PDF (null — жодної етикетки не додано). */
  pdf: Uint8Array | null;
  included: Array<LabelBatchItem & { pages: number }>;
  skipped: Array<LabelBatchItem & { reason: LabelSkipReason }>;
  /** Ідентифікатори, яких немає в базі. */
  missing: number;
}

/** A6 у пунктах — розмір сторінки для етикетки-зображення (PNG). */
const A6: [number, number] = [297.64, 419.53];
const LABEL_CONCURRENCY = 3;

type FetchedLabel =
  | { ok: true; item: LabelBatchItem; format: "pdf" | "png"; content: Uint8Array }
  | { ok: false; item: LabelBatchItem; reason: LabelSkipReason };

async function fetchLabel(
  ctx: ServiceContext,
  order: { id: string; orderNumber: string; status: OrderStatus },
  deadline: AbortSignal,
): Promise<FetchedLabel> {
  const item = { orderId: order.id, orderNumber: order.orderNumber };
  if (!(PACKING_QUEUE_STATUSES as readonly OrderStatus[]).includes(order.status) || isShipped(order.status)) {
    return { ok: false, item, reason: "not_in_queue" };
  }
  const shipment = await findActiveShipment(ctx.db, order.id);
  if (!shipment || shipment.status !== "created" || !shipment.waybillNumber) return { ok: false, item, reason: "no_waybill" };
  if (!availableDocumentKinds(ctx, shipment).includes("label")) return { ok: false, item, reason: "not_supported" };
  if (deadline.aborted) return { ok: false, item, reason: "timeout" };
  try {
    // Адаптер, що ігнорує скасування, не затримує відповідь довше за загальний час пакета.
    const doc = await Promise.race([fetchCarrierDocument(ctx, order.id, shipment.id, "label", { signal: deadline }), rejectOnAbort(deadline)]);
    if (doc.content.byteLength > MAX_LABEL_BYTES) return { ok: false, item, reason: "too_large" };
    if (doc.format === "pdf" || doc.contentType === "application/pdf") return { ok: true, item, format: "pdf", content: doc.content };
    if (doc.format === "png" || doc.contentType === "image/png") return { ok: true, item, format: "png", content: doc.content };
    return { ok: false, item, reason: "unsupported_format" };
  } catch (e) {
    if (deadline.aborted) return { ok: false, item, reason: "timeout" };
    if (e instanceof CarrierError) {
      logger.warn("packing.label_carrier_error", { kind: e.kind, carrier: e.carrier, error: e });
      if (e.details.some((d) => d.carrierCode === "DOCUMENT_TOO_LARGE")) return { ok: false, item, reason: "too_large" };
      return { ok: false, item, reason: e.kind === "not_supported" ? "not_supported" : "carrier_error" };
    }
    logger.warn("packing.label_failed", { error: e });
    return { ok: false, item, reason: "carrier_error" };
  }
}

/** Проміс, що відхиляється, коли сигнал скасовано (для Promise.race з викликом перевізника). */
function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const fail = () => reject(new DOMException("Label batch deadline exceeded", "TimeoutError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  });
}

/**
 * Розміри PNG із заголовка IHDR (без декодування; pdf-lib embedPng декодує все зображення в RGBA одразу).
 * null — не PNG або пошкоджений заголовок.
 */
export function pngDimensions(content: Uint8Array): { width: number; height: number } | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (content.byteLength < 24 || !signature.every((b, i) => content[i] === b)) return null;
  // Перший блок — IHDR: довжина (4) + тип "IHDR" (4) + ширина (4) + висота (4), big-endian.
  if (String.fromCharCode(content[12]!, content[13]!, content[14]!, content[15]!) !== "IHDR") return null;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Додає етикетку до об'єднаного документа; повертає кількість сторінок або причину пропуску. */
export async function appendLabel(merged: PDFDocument, label: { format: "pdf" | "png"; content: Uint8Array }): Promise<number | LabelSkipReason> {
  if (label.content.byteLength > MAX_LABEL_BYTES) return "too_large";
  if (label.format === "png") {
    const dims = pngDimensions(label.content);
    if (!dims || dims.width === 0 || dims.height === 0) return "invalid_pdf";
    if (dims.width * dims.height > MAX_LABEL_PNG_PIXELS) return "too_large";
    try {
      const image = await merged.embedPng(label.content);
      const scale = Math.min(A6[0] / image.width, A6[1] / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      const page = merged.addPage([Math.max(w, 1), Math.max(h, 1)]);
      page.drawImage(image, { x: 0, y: 0, width: w, height: h });
      return 1;
    } catch {
      return "invalid_pdf";
    }
  }
  let source: PDFDocument;
  try {
    // ignoreEncryption: щоб відрізнити зашифрований документ (isEncrypted) від пошкодженого; зашифровані не
    // копіюються (вміст був би непридатний) — друк окремо з картки замовлення.
    source = await PDFDocument.load(label.content, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return "invalid_pdf";
  }
  if (source.isEncrypted) return "encrypted";
  try {
    // Пошкоджений файл може завантажитися «порожнім» (без каталогу сторінок) — тоді getPageCount кидає помилку.
    const count = source.getPageCount();
    if (count === 0) return "invalid_pdf";
    if (count > MAX_LABEL_PAGES) return "too_large";
    const pages = await merged.copyPages(source, source.getPageIndices());
    for (const p of pages) merged.addPage(p);
    return count;
  } catch {
    return "invalid_pdf";
  }
}

export async function mergeCarrierLabels(
  ctx: ServiceContext,
  orderIds: readonly string[],
  /** deadlineMs — загальний час отримання етикеток (за замовчуванням LABEL_BATCH_DEADLINE_MS; менший — для тестів). */
  opts: { deadlineMs?: number } = {},
): Promise<LabelBatchResult> {
  requirePermission(ctx.actor, "packing.perform");
  requirePermission(ctx.actor, "orders.view");
  const ids = parseOrderIds(orderIds, MAX_LABEL_ORDERS);
  const sorted = await sortOrderIdsLikeQueue(ctx.db, ids);
  const deadline = AbortSignal.timeout(Math.max(1, opts.deadlineMs ?? LABEL_BATCH_DEADLINE_MS));
  const included: LabelBatchResult["included"] = [];
  const skipped: LabelBatchResult["skipped"] = [];
  const merged = await PDFDocument.create();
  for (let i = 0; i < sorted.length; i += LABEL_CONCURRENCY) {
    const part = sorted.slice(i, i + LABEL_CONCURRENCY);
    const fetched = deadline.aborted
      ? part.map((o): FetchedLabel => ({ ok: false, item: { orderId: o.id, orderNumber: o.orderNumber }, reason: "timeout" }))
      : await Promise.all(part.map((o) => fetchLabel(ctx, o, deadline)));
    // Одразу в PDF (у порядку черги) — тіла етикеток не накопичуються в пам'яті.
    for (const f of fetched) {
      if (!f.ok) {
        skipped.push({ ...f.item, reason: f.reason });
        continue;
      }
      const r = await appendLabel(merged, f);
      if (typeof r === "number") included.push({ ...f.item, pages: r });
      else skipped.push({ ...f.item, reason: r });
    }
  }
  const pdf = included.length > 0 ? await merged.save() : null;
  return { pdf, included, skipped, missing: ids.length - sorted.length };
}


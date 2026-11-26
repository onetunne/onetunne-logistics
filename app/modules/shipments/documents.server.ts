/**
 * Документи відправлення (етап 3): PDF перевізника (етикетка/маркування, комерційний інвойс, митна декларація)
 * і дані інвойсу застосунку для друку.
 * Документи перевізника доступні лише для накладної, створеної через API перевізника (не для ручного прив'язування).
 */
import { and, eq } from "drizzle-orm";
import { shipments } from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { buildCommercialInvoice, withSentCustomsData, type CommercialInvoice, type SentCustomsData } from "~/modules/customs/invoice";
import { loadLineItems, loadOrderRow } from "~/modules/orders/repository.server";
import { getSettings } from "~/modules/settings/settings.server";
import { CARRIER_DOCUMENT_KINDS, type CarrierDocument, type CarrierDocumentKind } from "~/integrations/carriers/types";
import type { ServiceContext } from "~/server/types";
import { ACTIVE_SHIPMENT_STATUSES, CARRIER_TIMEOUT_MS, isManualLink } from "./waybill.server";

export function isCarrierDocumentKind(value: string): value is CarrierDocumentKind {
  return (CARRIER_DOCUMENT_KINDS as readonly string[]).includes(value);
}

/** Які документи перевізника можна отримати для відправлення. */
export function availableDocumentKinds(
  ctx: Pick<ServiceContext, "carriers">,
  shipment: { carrierCode: string; status: string; waybillNumber: string | null; carrierShipmentId: string | null; carrierReference: string },
): CarrierDocumentKind[] {
  if (shipment.status !== "created" || !shipment.waybillNumber || isManualLink(shipment)) return [];
  const adapter = ctx.carriers.get(shipment.carrierCode);
  if (!adapter?.capabilities.documents || !adapter.getDocument) return [];
  return [...(adapter.capabilities.documentKinds ?? [])];
}

export async function fetchCarrierDocument(
  ctx: ServiceContext,
  orderId: string,
  shipmentId: string,
  kind: CarrierDocumentKind,
): Promise<CarrierDocument> {
  requirePermission(ctx.actor, "orders.view");
  const [shipment] = await ctx.db
    .select()
    .from(shipments)
    .where(and(eq(shipments.id, shipmentId), eq(shipments.orderId, orderId)));
  if (!shipment) throw new NotFoundError("shipment");
  if (!availableDocumentKinds(ctx, shipment).includes(kind)) throw new DomainError("document.notAvailable", 409);
  const adapter = ctx.carriers.get(shipment.carrierCode)!;
  return adapter.getDocument!(
    { carrierShipmentId: shipment.carrierShipmentId, waybillNumber: shipment.waybillNumber! },
    kind,
    { signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) },
  );
}

/**
 * Комерційний інвойс застосунку (друк у браузері). Номер накладної — з активного відправлення, якщо є.
 * Якщо запит до перевізника вже надіслано — митні дані й дата з його знімка (друк = електронний інвойс перевізника).
 */
export async function loadOrderInvoice(ctx: ServiceContext, orderId: string): Promise<CommercialInvoice> {
  requirePermission(ctx.actor, "orders.view");
  const order = await loadOrderRow(ctx.db, orderId);
  const [items, settings, rows] = await Promise.all([
    loadLineItems(ctx.db, orderId),
    getSettings(ctx.db),
    ctx.db.select().from(shipments).where(eq(shipments.orderId, orderId)),
  ]);
  const active = rows.find((s) => (ACTIVE_SHIPMENT_STATUSES as readonly string[]).includes(s.status));
  const invoice = buildCommercialInvoice({
    order,
    items,
    settings,
    issuedAt: active?.createdAt ?? ctx.now(),
    waybillNumber: active?.status === "created" ? active.waybillNumber : null,
  });
  return withSentCustomsData(invoice, (active?.requestSnapshot ?? null) as SentCustomsData | null);
}

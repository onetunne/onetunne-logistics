/**
 * Створення накладних із захистом від дублікатів.
 *
 * Гарантії:
 * 1. Одне активне відправлення на замовлення (частковий унікальний індекс у БД + блокування рядка замовлення).
 * 2. Стабільний `carrierReference` для повторних спроб того самого покоління — перевізник може
 *    дедуплікувати, а ми — знайти відправлення після збою.
 * 3. Запис `creating` фіксується ДО запиту до перевізника. Якщо результат невідомий
 *    (тайм-аут/збій/перезапуск сервера) — звірка через пошук за reference; якщо перевірити неможливо —
 *    ручний розгляд (розділ «Проблеми»), автоматизацію замовлення призупинено.
 * 4. Повторне натискання/повторний запит повертає наявну накладну без звернення до перевізника.
 */
import { and, desc, eq, inArray, like } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { issues, orders, shipmentEvents, shipments } from "~/db/schema";
import { assertTransition, isShipped } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { redact } from "~/lib/logger.server";
import { addMoney, multiplyMoney } from "~/lib/money";
import { writeAudit } from "~/modules/audit/audit.server";
import {
  loadCountryRules,
  loadLineItems,
  loadOrderRow,
  toValidationInput,
  type OrderRow,
  type ShipmentRow,
} from "~/modules/orders/repository.server";
import { automationDecision, validateOrderInTx, validationOptions } from "~/modules/orders/workflow.server";
import { REQUIRED_SHIPPER_FIELDS, type AllSettings } from "~/modules/settings/schema";
import { getSettings } from "~/modules/settings/settings.server";
import { computeParcelWeights } from "~/modules/shipments/weight";
import { validateOrder } from "~/modules/validation";
import { buildCommercialInvoice, toCustomsDeclaration, toCustomsItems } from "~/modules/customs/invoice";
import {
  CarrierError,
  type CarrierAdapter,
  type CreateShipmentRequest,
  type CreatedShipment,
} from "~/integrations/carriers/types";
import type { ServiceContext } from "~/server/types";

export const ACTIVE_SHIPMENT_STATUSES = ["creating", "created", "unknown"] as const;
/** Після цього часу запис `creating` вважається «завислим» (збій сервера) і підлягає звірці. */
export const STALE_CREATING_MS = 2 * 60 * 1000;
export const CARRIER_TIMEOUT_MS = 15_000;

export type WaybillSource = "manual" | "bulk" | "automation";

export type BlockedReason =
  | "validation"
  | "status"
  | "automation_paused"
  | "shipper_incomplete"
  | "no_carrier"
  | "carrier_not_configured"
  | "in_progress";

export type CreateWaybillResult =
  | { kind: "created"; shipment: ShipmentRow }
  | { kind: "already_exists"; shipment: ShipmentRow }
  | { kind: "recovered"; shipment: ShipmentRow }
  | { kind: "blocked"; reason: BlockedReason; params?: Record<string, string | number> }
  | { kind: "rejected"; shipment: ShipmentRow; message: string }
  | { kind: "not_created"; shipment: ShipmentRow | null; message: string }
  | { kind: "unknown"; shipment: ShipmentRow };

function referenceFor(order: OrderRow, generation: number): string {
  return `OT-${order.orderNumber.replace(/[^A-Za-z0-9]/g, "")}-${generation}`;
}

function safeMessage(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return String(redact(msg)).slice(0, 300);
}

async function addEvent(tx: DbOrTx, shipmentId: string, type: string, message?: string | null, data?: Record<string, unknown>) {
  await tx.insert(shipmentEvents).values({ shipmentId, type, message: message ?? null, data: data ?? null });
}

async function openCarrierIssue(
  tx: DbOrTx,
  orderId: string,
  shipmentId: string | null,
  code: "CARRIER_REJECTED" | "CARRIER_RESULT_UNKNOWN" | "CARRIER_UNAVAILABLE",
  params: Record<string, string | number>,
) {
  const fingerprint = `${orderId}:${code}:`;
  const [existing] = await tx
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.fingerprint, fingerprint), eq(issues.status, "open")));
  if (existing) {
    await tx.update(issues).set({ params, shipmentId, updatedAt: new Date() }).where(eq(issues.id, existing.id));
    return;
  }
  await tx.insert(issues).values({
    orderId,
    shipmentId,
    code,
    severity: code === "CARRIER_UNAVAILABLE" ? "warning" : "error",
    field: null,
    params,
    fingerprint,
  });
}

async function resolveCarrierIssues(tx: DbOrTx, orderId: string, actorId: string, resolution: string, codes?: string[]) {
  await tx
    .update(issues)
    .set({ status: "resolved", resolvedAt: new Date(), resolvedBy: actorId, resolution, updatedAt: new Date() })
    .where(
      and(
        eq(issues.orderId, orderId),
        eq(issues.status, "open"),
        codes ? inArray(issues.code, codes) : like(issues.code, "CARRIER_%"),
      ),
    );
}

async function setOrderStatus(tx: DbOrTx, order: OrderRow, status: OrderRow["status"], extra: Partial<OrderRow> = {}) {
  assertTransition(order.status, status);
  await tx
    .update(orders)
    .set({ ...extra, status, version: order.version + 1, updatedAt: new Date() })
    .where(eq(orders.id, order.id));
}

export async function findActiveShipment(db: DbOrTx, orderId: string): Promise<ShipmentRow | null> {
  const [row] = await db
    .select()
    .from(shipments)
    .where(and(eq(shipments.orderId, orderId), inArray(shipments.status, [...ACTIVE_SHIPMENT_STATUSES])))
    .limit(1);
  return row ?? null;
}

function missingShipperFields(settings: AllSettings): string[] {
  return REQUIRED_SHIPPER_FIELDS.filter((f) => !String(settings.shipper[f] ?? "").trim());
}

export function buildShipmentRequest(
  order: OrderRow,
  items: Awaited<ReturnType<typeof loadLineItems>>,
  settings: AllSettings,
  reference: string,
  issuedAt?: Date,
): CreateShipmentRequest & { packageCode: string } {
  const pkg =
    settings.packaging.packages.find((p) => p.code === settings.packaging.defaultPackageCode) ??
    settings.packaging.packages[0]!;
  const weights = computeParcelWeights({
    items: items.map((i) => ({ weightGrams: i.variant?.weightGrams ?? 0, quantity: i.quantity })),
    pkg,
    volumetricDivisor: settings.packaging.volumetricDivisor,
  });
  const declared = addMoney("0.00", ...items.map((i) => multiplyMoney(i.unitPrice, i.quantity)));
  const invoice = buildCommercialInvoice({ order, items, settings, issuedAt: issuedAt ?? new Date() });
  const s = settings.shipper;
  return {
    reference,
    orderNumber: order.orderNumber,
    packageCode: pkg.code,
    sender: {
      name: s.contactName,
      company: s.companyName || null,
      phone: s.phone,
      email: s.email || null,
      address: {
        countryCode: s.countryCode,
        city: s.city,
        postalCode: s.postalCode || null,
        province: null,
        address1: s.address1,
        address2: s.address2 || null,
      },
      branchCode: s.carrierBranch || null,
      taxId: s.taxId || null,
      eori: s.eori || null,
      ioss: s.ioss || null,
    },
    recipient: {
      name: [order.shipFirstName, order.shipLastName].filter(Boolean).join(" "),
      company: order.shipCompany,
      phone: order.shipPhone ?? "",
      email: order.email,
      address: {
        countryCode: order.shipCountryCode ?? "",
        city: order.shipCity ?? "",
        postalCode: order.shipPostalCode,
        province: order.shipProvince,
        address1: order.shipAddress1 ?? "",
        address2: order.shipAddress2,
      },
    },
    parcels: [
      {
        packageCode: pkg.code,
        lengthCm: pkg.lengthCm,
        widthCm: pkg.widthCm,
        heightCm: pkg.heightCm,
        ...weights,
      },
    ],
    customsItems: toCustomsItems(invoice),
    customs: toCustomsDeclaration(invoice),
    declaredValue: { amount: declared, currency: order.currency },
  };
}

/** Знімок запиту для історії — без персональних даних отримувача. */
function requestSnapshot(req: CreateShipmentRequest & { packageCode: string }) {
  return {
    reference: req.reference,
    orderNumber: req.orderNumber,
    packageCode: req.packageCode,
    destinationCountry: req.recipient.address.countryCode,
    parcels: req.parcels,
    customsItems: req.customsItems,
    customs: req.customs ?? null,
    declaredValue: req.declaredValue,
  };
}

type Prepared =
  | { kind: "result"; result: CreateWaybillResult }
  | { kind: "reconcile"; shipmentId: string }
  | { kind: "call"; shipment: ShipmentRow; request: CreateShipmentRequest; carrier: CarrierAdapter };

/**
 * Створює (тестову) накладну для замовлення. Безпечна для повторних викликів.
 */
export async function createWaybill(
  ctx: ServiceContext,
  orderId: string,
  opts: { source?: WaybillSource } = {},
): Promise<CreateWaybillResult> {
  requirePermission(ctx.actor, "waybills.create");
  const source = opts.source ?? "manual";
  const carrier = ctx.carriers.getDefault();

  const prepared: Prepared = await ctx.db.transaction(async (tx): Promise<Prepared> => {
    const order = await loadOrderRow(tx, orderId, { forUpdate: true });
    const active = await findActiveShipment(tx, orderId);
    if (active) {
      if (active.status === "created") return { kind: "result", result: { kind: "already_exists", shipment: active } };
      const stale = active.status === "creating" && ctx.now().getTime() - active.updatedAt.getTime() > STALE_CREATING_MS;
      if (active.status === "unknown" || stale) return { kind: "reconcile", shipmentId: active.id };
      return { kind: "result", result: { kind: "blocked", reason: "in_progress" } };
    }
    if (!carrier) return { kind: "result", result: { kind: "blocked", reason: "no_carrier" } };
    if (!carrier.capabilities.createShipment) {
      return { kind: "result", result: { kind: "blocked", reason: "carrier_not_configured", params: { carrier: carrier.displayName } } };
    }
    if (order.status !== "awaiting_review") {
      return { kind: "result", result: { kind: "blocked", reason: "status", params: { status: order.status } } };
    }
    if (source === "automation") {
      const decision = await automationDecision(tx, order);
      if (!decision.run || decision.mode !== "auto") {
        return { kind: "result", result: { kind: "blocked", reason: "automation_paused" } };
      }
    }
    const settings = await getSettings(tx);
    const missing = missingShipperFields(settings);
    if (missing.length > 0) {
      return { kind: "result", result: { kind: "blocked", reason: "shipper_incomplete", params: { fields: missing.join(", ") } } };
    }
    // Свіжа перевірка даних безпосередньо перед створенням (дані могли змінитися).
    const items = await loadLineItems(tx, orderId);
    const check = validateOrder(toValidationInput({ order, items }), await loadCountryRules(tx), await validationOptions(tx));
    if (check.blocking || check.autoFixes.length > 0) {
      const summary = await validateOrderInTx(tx, ctx, orderId, "automation");
      if (summary.blocking) return { kind: "result", result: { kind: "blocked", reason: "validation" } };
      return { kind: "result", result: { kind: "blocked", reason: "validation", params: { revalidated: 1 } } };
    }

    // Наступне покоління/спроба. Невдала (точно не створена) спроба повторюється з тим самим reference.
    const [last] = await tx
      .select()
      .from(shipments)
      .where(and(eq(shipments.orderId, orderId), eq(shipments.carrierCode, carrier.code)))
      .orderBy(desc(shipments.generation))
      .limit(1);
    const freshOrder = await loadOrderRow(tx, orderId);
    let shipment: ShipmentRow;
    let request: CreateShipmentRequest & { packageCode: string };
    if (last && last.status === "failed") {
      request = buildShipmentRequest(freshOrder, items, settings, last.carrierReference, ctx.now());
      const [row] = await tx
        .update(shipments)
        .set({
          status: "creating",
          attempts: last.attempts + 1,
          lastError: null,
          packageCode: request.packageCode,
          actualWeightGrams: request.parcels[0]!.actualWeightGrams,
          volumetricWeightGrams: request.parcels[0]!.volumetricWeightGrams,
          chargeableWeightGrams: request.parcels[0]!.chargeableWeightGrams,
          declaredValue: request.declaredValue.amount,
          currency: request.declaredValue.currency,
          requestSnapshot: requestSnapshot(request),
          updatedAt: ctx.now(),
        })
        .where(and(eq(shipments.id, last.id), eq(shipments.status, "failed")))
        .returning();
      shipment = row!;
    } else {
      const generation = (last?.generation ?? 0) + 1;
      request = buildShipmentRequest(freshOrder, items, settings, referenceFor(freshOrder, generation), ctx.now());
      const [row] = await tx
        .insert(shipments)
        .values({
          orderId,
          carrierCode: carrier.code,
          mode: carrier.mode,
          status: "creating",
          carrierReference: request.reference,
          generation,
          packageCode: request.packageCode,
          actualWeightGrams: request.parcels[0]!.actualWeightGrams,
          volumetricWeightGrams: request.parcels[0]!.volumetricWeightGrams,
          chargeableWeightGrams: request.parcels[0]!.chargeableWeightGrams,
          declaredValue: request.declaredValue.amount,
          currency: request.declaredValue.currency,
          requestSnapshot: requestSnapshot(request),
          createdBy: ctx.actor.id,
        })
        .returning();
      shipment = row!;
    }
    await addEvent(tx, shipment.id, "request_started", null, { attempt: shipment.attempts, source });
    await writeAudit(tx, ctx.actor, "waybill.create_requested", { type: "shipment", id: shipment.id }, {
      orderId,
      carrier: carrier.code,
      reference: shipment.carrierReference,
      attempt: shipment.attempts,
      source,
    });
    return { kind: "call", shipment, request, carrier };
  });

  if (prepared.kind === "result") return prepared.result;
  if (prepared.kind === "reconcile") return reconcileShipmentInternal(ctx, prepared.shipmentId);

  const { shipment, request, carrier: adapter } = prepared;
  let created: CreatedShipment;
  try {
    created = await adapter.createShipment(request, { signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) });
  } catch (error) {
    return handleCreateFailure(ctx, shipment, adapter, error);
  }
  return markCreated(ctx, shipment.id, created, "created");
}

/** Ручне прив'язування позначається в carrierShipmentId (скасування — лише в кабінеті перевізника). */
export function isManualLink(shipment: Pick<ShipmentRow, "carrierShipmentId" | "carrierReference">): boolean {
  return Boolean(shipment.carrierShipmentId?.startsWith("manual:")) || shipment.carrierReference.startsWith("MANUAL-");
}

/**
 * Фіксує підтверджений результат перевізника. Приймається ЛИШЕ для відправлення у стані
 * creating/unknown (compare-and-set). Пізній результат для вже закритого відправлення
 * не прив'язується мовчки — створюється проблема для ручного розгляду.
 */
async function markCreated(
  ctx: ServiceContext,
  shipmentId: string,
  created: CreatedShipment,
  eventType: "created" | "recovered",
): Promise<CreateWaybillResult> {
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
    if (!current) throw new NotFoundError("shipment");
    if (current.status === "created") return { kind: "already_exists", shipment: current };
    const order = await loadOrderRow(tx, current.orderId, { forUpdate: true });
    if (current.status !== "creating" && current.status !== "unknown") {
      // Напр. менеджер підтвердив «не створено», а відповідь перевізника прийшла пізніше.
      await addEvent(tx, shipmentId, "late_carrier_result", null, { waybillNumber: created.waybillNumber });
      await openCarrierIssue(tx, current.orderId, shipmentId, "CARRIER_RESULT_UNKNOWN", {
        carrier: ctx.carriers.get(current.carrierCode)?.displayName ?? current.carrierCode,
        reference: current.carrierReference,
        waybill: created.waybillNumber,
      });
      await writeAudit(tx, ctx.actor, "waybill.late_result", { type: "shipment", id: shipmentId }, {
        orderId: current.orderId,
        waybillNumber: created.waybillNumber,
      });
      return { kind: "unknown", shipment: current };
    }
    const [row] = await tx
      .update(shipments)
      .set({
        status: "created",
        carrierShipmentId: created.carrierShipmentId,
        waybillNumber: created.waybillNumber,
        trackingNumber: created.trackingNumber,
        lastError: null,
        updatedAt: ctx.now(),
      })
      .where(and(eq(shipments.id, shipmentId), inArray(shipments.status, ["creating", "unknown"])))
      .returning();
    if (order.status === "awaiting_review") await setOrderStatus(tx, order, "waybill_created");
    await addEvent(tx, shipmentId, eventType, null, { waybillNumber: created.waybillNumber });
    await resolveCarrierIssues(tx, current.orderId, ctx.actor.id, eventType);
    await writeAudit(tx, ctx.actor, `waybill.${eventType}`, { type: "shipment", id: shipmentId }, {
      orderId: current.orderId,
      waybillNumber: created.waybillNumber,
    });
    return eventType === "created" ? { kind: "created", shipment: row! } : { kind: "recovered", shipment: row! };
  });
}

async function currentShipment(db: DbOrTx, shipmentId: string): Promise<ShipmentRow> {
  const [row] = await db.select().from(shipments).where(eq(shipments.id, shipmentId));
  if (!row) throw new NotFoundError("shipment");
  return row;
}

/** Відповідь для відправлення, яке вже не очікує результату (стан змінився паралельно). */
function resultForSettled(shipment: ShipmentRow): CreateWaybillResult {
  if (shipment.status === "created") return { kind: "already_exists", shipment };
  if (shipment.status === "unknown") return { kind: "unknown", shipment };
  if (shipment.status === "creating") return { kind: "blocked", reason: "in_progress" };
  return { kind: "not_created", shipment, message: shipment.lastError ?? shipment.status };
}

async function handleCreateFailure(
  ctx: ServiceContext,
  shipment: ShipmentRow,
  adapter: CarrierAdapter,
  error: unknown,
): Promise<CreateWaybillResult> {
  const message = safeMessage(error);
  const definitelyNotCreated =
    error instanceof CarrierError && ["rejected", "unavailable", "not_configured", "auth", "not_supported"].includes(error.kind);

  if (!definitelyNotCreated) {
    // Результат невідомий (тайм-аут, 5xx, неочікуваний виняток) — НЕ повторюємо створення наосліп.
    const moved = await ctx.db.transaction(async (tx) => {
      const [row] = await tx
        .update(shipments)
        .set({ status: "unknown", lastError: message, updatedAt: ctx.now() })
        .where(and(eq(shipments.id, shipment.id), eq(shipments.status, "creating")))
        .returning();
      if (row) await addEvent(tx, shipment.id, "outcome_unknown", message);
      return Boolean(row);
    });
    if (!moved) return resultForSettled(await currentShipment(ctx.db, shipment.id));
    return reconcileShipmentInternal(ctx, shipment.id);
  }

  const rejected = error instanceof CarrierError && error.kind === "rejected";
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(shipments)
      .set({ status: "failed", lastError: message, updatedAt: ctx.now() })
      .where(and(eq(shipments.id, shipment.id), eq(shipments.status, "creating")))
      .returning();
    if (!row) return resultForSettled(await currentShipment(tx, shipment.id));
    await addEvent(tx, shipment.id, rejected ? "rejected" : "not_created", message, {
      kind: error instanceof CarrierError ? error.kind : "unknown",
      fields: error instanceof CarrierError ? error.details.map((d) => d.field).filter(Boolean) : [],
    });
    const order = await loadOrderRow(tx, shipment.orderId, { forUpdate: true });
    if (rejected) {
      await openCarrierIssue(tx, order.id, shipment.id, "CARRIER_REJECTED", { carrier: adapter.displayName, message });
      if (order.status === "awaiting_review") await setOrderStatus(tx, order, "needs_correction");
    } else {
      await openCarrierIssue(tx, order.id, shipment.id, "CARRIER_UNAVAILABLE", { carrier: adapter.displayName, message });
    }
    await writeAudit(tx, ctx.actor, rejected ? "waybill.rejected" : "waybill.not_created", { type: "shipment", id: shipment.id }, {
      orderId: order.id,
      kind: error instanceof CarrierError ? error.kind : "unknown",
    });
    return rejected
      ? { kind: "rejected", shipment: row, message }
      : { kind: "not_created", shipment: row, message };
  });
}

/**
 * Звірка відправлення з невідомим результатом: шукаємо у перевізника за reference.
 * Знайдено → прив'язуємо; знайдено, але скасовано → «скасовано»; точно не знайдено → «не створено»
 * (можна безпечно повторити); перевірити неможливо → ручний розгляд.
 * Звіряються ЛИШЕ відправлення у стані creating/unknown.
 */
async function reconcileShipmentInternal(ctx: ServiceContext, shipmentId: string): Promise<CreateWaybillResult> {
  const shipment = await currentShipment(ctx.db, shipmentId);
  if (shipment.status !== "creating" && shipment.status !== "unknown") return resultForSettled(shipment);
  if (shipment.status === "creating" && ctx.now().getTime() - shipment.updatedAt.getTime() <= STALE_CREATING_MS) {
    return { kind: "blocked", reason: "in_progress" };
  }
  const adapter = ctx.carriers.get(shipment.carrierCode);

  if (adapter?.capabilities.findByReference) {
    try {
      const lookup = await adapter.findShipmentByReference(shipment.carrierReference, {
        signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS),
      });
      if (lookup.found && !lookup.cancelled) return markCreated(ctx, shipmentId, lookup.shipment, "recovered");
      const confirmedAbsent = !lookup.found && lookup.authoritative && adapter.capabilities.referenceLookupAuthoritative;
      if ((lookup.found && lookup.cancelled) || confirmedAbsent) {
        const nextStatus = lookup.found ? "cancelled" : "failed";
        const note = lookup.found ? "found_cancelled" : "confirmed_not_created";
        return ctx.db.transaction(async (tx) => {
          const [row] = await tx
            .update(shipments)
            .set({ status: nextStatus, lastError: note, updatedAt: ctx.now() })
            .where(and(eq(shipments.id, shipmentId), inArray(shipments.status, ["creating", "unknown"])))
            .returning();
          if (!row) return resultForSettled(await currentShipment(tx, shipmentId));
          await addEvent(tx, shipmentId, note);
          await resolveCarrierIssues(tx, shipment.orderId, ctx.actor.id, note, ["CARRIER_RESULT_UNKNOWN"]);
          await openCarrierIssue(tx, shipment.orderId, shipmentId, "CARRIER_UNAVAILABLE", {
            carrier: adapter.displayName,
            message: note,
          });
          return { kind: "not_created", shipment: row, message: note } as const;
        });
      }
    } catch {
      // Перевірити не вдалося — переходимо до ручного розгляду.
    }
  }

  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(shipments)
      .set({ status: "unknown", updatedAt: ctx.now() })
      .where(and(eq(shipments.id, shipmentId), inArray(shipments.status, ["creating", "unknown"])))
      .returning();
    if (!row) return resultForSettled(await currentShipment(tx, shipmentId));
    await addEvent(tx, shipmentId, "manual_review_required");
    await openCarrierIssue(tx, shipment.orderId, shipmentId, "CARRIER_RESULT_UNKNOWN", {
      carrier: adapter?.displayName ?? shipment.carrierCode,
      reference: shipment.carrierReference,
    });
    const order = await loadOrderRow(tx, shipment.orderId, { forUpdate: true });
    if (!order.automationPaused) {
      await tx
        .update(orders)
        .set({ automationPaused: true, version: order.version + 1, updatedAt: ctx.now() })
        .where(eq(orders.id, order.id));
    }
    await writeAudit(tx, ctx.actor, "waybill.manual_review_required", { type: "shipment", id: shipmentId }, {
      orderId: shipment.orderId,
    });
    return { kind: "unknown", shipment: row };
  });
}

/** Повторна звірка з UI (кнопка «Перевірити у перевізника»). */
export async function reconcileShipment(ctx: ServiceContext, shipmentId: string): Promise<CreateWaybillResult> {
  requirePermission(ctx.actor, "waybills.create");
  return reconcileShipmentInternal(ctx, shipmentId);
}

/**
 * Ручне прив'язування номера накладної (накладну створено вручну в кабінеті перевізника
 * або результат невідомий і менеджер знайшов номер). Виконується в одній транзакції.
 */
export async function linkWaybillManually(
  ctx: ServiceContext,
  orderId: string,
  waybillNumberInput: string,
): Promise<CreateWaybillResult> {
  requirePermission(ctx.actor, "waybills.manage");
  const waybillNumber = waybillNumberInput.trim().toUpperCase();
  if (!/^[A-Z0-9-]{6,40}$/.test(waybillNumber)) throw new DomainError("waybill.invalidNumber", 400);
  const carrier = ctx.carriers.getDefault();
  if (!carrier) throw new DomainError("waybill.noCarrier", 409);

  return ctx.db.transaction(async (tx) => {
    const order = await loadOrderRow(tx, orderId, { forUpdate: true });
    if (isShipped(order.status) || order.status === "cancelled") {
      throw new DomainError("order.notEditable", 409, { status: order.status });
    }
    // Номер не можна прив'язати повторно, навіть до того самого замовлення після скасування.
    const [taken] = await tx
      .select({ id: shipments.id })
      .from(shipments)
      .where(and(eq(shipments.carrierCode, carrier.code), eq(shipments.waybillNumber, waybillNumber)));
    if (taken) throw new DomainError("waybill.alreadyLinked", 409);
    const active = await findActiveShipment(tx, orderId);
    if (active?.status === "created") throw new DomainError("waybill.alreadyExists", 409);
    if (active?.status === "creating" && ctx.now().getTime() - active.updatedAt.getTime() <= STALE_CREATING_MS) {
      throw new DomainError("waybill.inProgress", 409);
    }
    if (!active && order.status !== "awaiting_review") {
      throw new DomainError("waybill.linkRequiresReview", 409, { status: order.status });
    }
    const values = {
      status: "created" as const,
      carrierShipmentId: `manual:${waybillNumber}`,
      waybillNumber,
      trackingNumber: waybillNumber,
      lastError: null,
      updatedAt: ctx.now(),
    };
    let row: ShipmentRow | undefined;
    if (active) {
      [row] = await tx
        .update(shipments)
        .set(values)
        .where(and(eq(shipments.id, active.id), inArray(shipments.status, ["creating", "unknown"])))
        .returning();
      if (!row) throw new DomainError("waybill.inProgress", 409);
    } else {
      [row] = await tx
        .insert(shipments)
        .values({
          ...values,
          orderId,
          carrierCode: carrier.code,
          mode: carrier.mode,
          carrierReference: `MANUAL-${waybillNumber}`,
          generation: 0,
          createdBy: ctx.actor.id,
        })
        .returning();
    }
    if (order.status === "awaiting_review") await setOrderStatus(tx, order, "waybill_created");
    await addEvent(tx, row!.id, "manually_linked", null, { waybillNumber });
    await resolveCarrierIssues(tx, orderId, ctx.actor.id, "manually_linked");
    await writeAudit(tx, ctx.actor, "waybill.manually_linked", { type: "shipment", id: row!.id }, { orderId, waybillNumber });
    return { kind: "created", shipment: row! };
  });
}

/** Менеджер підтверджує, що перевізник НЕ створив накладну (після перевірки в кабінеті). */
export async function confirmNotCreated(ctx: ServiceContext, shipmentId: string): Promise<void> {
  requirePermission(ctx.actor, "waybills.manage");
  await ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId)).for("update");
    if (!current) throw new NotFoundError("shipment");
    // Запит, що ще виконується, не можна оголосити «не створеним».
    if (current.status === "creating" && ctx.now().getTime() - current.updatedAt.getTime() <= STALE_CREATING_MS) {
      throw new DomainError("waybill.inProgress", 409);
    }
    const [row] = await tx
      .update(shipments)
      .set({ status: "failed", lastError: "confirmed_not_created_manually", updatedAt: ctx.now() })
      .where(and(eq(shipments.id, shipmentId), inArray(shipments.status, ["creating", "unknown"])))
      .returning();
    if (!row) throw new DomainError("waybill.notInReview", 409);
    await addEvent(tx, shipmentId, "confirmed_not_created_manually");
    await resolveCarrierIssues(tx, row.orderId, ctx.actor.id, "confirmed_not_created", ["CARRIER_RESULT_UNKNOWN"]);
    await writeAudit(tx, ctx.actor, "waybill.confirmed_not_created", { type: "shipment", id: shipmentId }, {
      orderId: row.orderId,
    });
  });
}

/**
 * Скасування накладної до передачі перевізнику (переоформлення створить нове покоління).
 * Відмова перевізника скасувати → накладна залишається активною.
 */
export async function cancelWaybill(ctx: ServiceContext, shipmentId: string): Promise<void> {
  requirePermission(ctx.actor, "waybills.manage");
  const shipment = await currentShipment(ctx.db, shipmentId);
  if (shipment.status !== "created" || !shipment.waybillNumber) throw new DomainError("waybill.notCancellable", 409);
  const order = await loadOrderRow(ctx.db, shipment.orderId);
  if (isShipped(order.status)) throw new DomainError("waybill.alreadyHandedOver", 409);
  const adapter = ctx.carriers.get(shipment.carrierCode);
  const manual = isManualLink(shipment);
  if (!manual) {
    if (!adapter?.capabilities.cancelShipment) throw new DomainError("waybill.cancelNotSupported", 409);
    const res = await adapter.cancelShipment(shipment.waybillNumber, { signal: AbortSignal.timeout(CARRIER_TIMEOUT_MS) });
    if (!res.cancelled) throw new DomainError("waybill.cancelRefused", 409);
  }
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(shipments)
      .set({ status: "cancelled", updatedAt: ctx.now() })
      .where(and(eq(shipments.id, shipmentId), eq(shipments.status, "created")))
      .returning();
    if (!row) return; // уже скасовано паралельним запитом
    await addEvent(tx, shipmentId, "cancelled", manual ? "manual_link_removed" : null);
    const fresh = await loadOrderRow(tx, shipment.orderId, { forUpdate: true });
    const stillActive = await findActiveShipment(tx, shipment.orderId);
    if (!stillActive && (fresh.status === "waybill_created" || fresh.status === "awaiting_picking")) {
      await setOrderStatus(tx, fresh, "awaiting_review");
    }
    await writeAudit(tx, ctx.actor, "waybill.cancelled", { type: "shipment", id: shipmentId }, {
      orderId: shipment.orderId,
      manual,
    });
  });
}

/** Скасування замовлення до відправлення (з автоматичним скасуванням тестової накладної). */
export async function cancelOrder(ctx: ServiceContext, orderId: string): Promise<void> {
  requirePermission(ctx.actor, "orders.cancel");
  const order = await loadOrderRow(ctx.db, orderId);
  if (order.status === "cancelled") return;
  if (isShipped(order.status)) throw new DomainError("order.alreadyShipped", 409);
  const active = await findActiveShipment(ctx.db, orderId);
  if (active && active.status !== "created") throw new DomainError("waybill.resolveFirst", 409);
  if (active?.status === "created") await cancelWaybill(ctx, active.id);
  await ctx.db.transaction(async (tx) => {
    const fresh = await loadOrderRow(tx, orderId, { forUpdate: true });
    await setOrderStatus(tx, fresh, "cancelled", { cancelledAt: ctx.now() });
    // Проблеми скасованого замовлення більше не потребують дій.
    await tx
      .update(issues)
      .set({ status: "resolved", resolvedAt: ctx.now(), resolvedBy: ctx.actor.id, resolution: "order_cancelled", updatedAt: ctx.now() })
      .where(and(eq(issues.orderId, orderId), eq(issues.status, "open")));
    await writeAudit(tx, ctx.actor, "order.cancelled", { type: "order", id: orderId });
  });
}

export interface BulkWaybillSummary {
  results: { orderId: string; result: CreateWaybillResult["kind"]; reason?: string }[];
}

export async function createWaybills(ctx: ServiceContext, orderIds: string[]): Promise<BulkWaybillSummary> {
  requirePermission(ctx.actor, "orders.bulk");
  const results: BulkWaybillSummary["results"] = [];
  for (const id of [...new Set(orderIds)].slice(0, 100)) {
    try {
      const r = await createWaybill(ctx, id, { source: "bulk" });
      results.push({ orderId: id, result: r.kind, ...(r.kind === "blocked" ? { reason: r.reason } : {}) });
    } catch (e) {
      results.push({ orderId: id, result: "blocked", reason: e instanceof DomainError ? e.code : "error.generic" });
    }
  }
  return { results };
}

/**
 * Обробка нового оплаченого замовлення відповідно до режиму автоматизації:
 * manual — нічого автоматично; semi — перевірка й однозначні автовиправлення;
 * auto — ще й створення накладної, якщо проблем немає.
 */
export async function processPaidOrder(ctx: ServiceContext, orderId: string) {
  const order = await loadOrderRow(ctx.db, orderId);
  const decision = await automationDecision(ctx.db, order);
  if (!decision.run) return { validated: false, waybill: null, reason: decision.reason } as const;
  const summary = await ctx.db.transaction((tx: Tx) => validateOrderInTx(tx, ctx, orderId, "automation"));
  if (decision.mode !== "auto" || summary.blocking) return { validated: true, waybill: null, summary } as const;
  const waybill = await createWaybill(ctx, orderId, { source: "automation" });
  return { validated: true, waybill, summary } as const;
}

import { useState, type ReactNode } from "react";
import { desc, eq } from "drizzle-orm";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type Params,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { CarrierDocumentButtons } from "~/components/carrier-documents";
import { CustomerRequestPanel, type CustomerRequestDraftView } from "~/components/customer-request-panel";
import { buildCustomerRequestDraft, type IssueLike } from "~/modules/customer-requests/requests";
import { useCan, useHref } from "~/components/shell";
import { OverriddenBadge, VariantCustomsForm } from "~/components/variant-customs-form";
import { OrderStatusBadge, SeverityBadge, ShipmentStatusBadge, TestBadge } from "~/components/status-badge";
import { TrackingStatusBadge, isTrackingStatus, trackingTimelineTone } from "~/components/tracking-badge";
import { shipmentTrackingEvents } from "~/db/schema";
import { isShipped, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { hasKey, makeT, useLocale, useT, type TFunction } from "~/i18n";
import { localizeCode, localizeParams } from "~/i18n/localize";
// Лише в loader (серверний код): у клієнтський бандл модуль зіставлення Nova Post не потрапляє.
import { NOVA_POST_CODE } from "~/integrations/carriers/nova-post/mapping";
import { DomainError, NotFoundError } from "~/lib/errors";
import { countryName, formatDateTime, formatMoney, formatWeight } from "~/lib/format";
import { isDecimalString, multiplyMoney } from "~/lib/money";
import {
  loadCountryRuleRows,
  loadOrderAggregate,
  loadOrderHistory,
  shippingAddressOf,
} from "~/modules/orders/repository.server";
import {
  VALIDATABLE_STATUSES,
  acceptSuggestion,
  dismissIssue,
  setOrderAutomationPaused,
  updateOrderData,
  updateVariantCustomsData,
  validateOrderById,
} from "~/modules/orders/workflow.server";
import { MANUALLY_CLOSABLE_ISSUE_CODES } from "~/modules/problems/categories";
import { OVERRIDE_FIELDS, type OverrideField } from "~/modules/products/customs-overrides";
import { loadVariantCustomsParts } from "~/modules/products/repository.server";
import { REQUIRED_SHIPPER_FIELDS } from "~/modules/settings/schema";
import { getSettings } from "~/modules/settings/settings.server";
import { availableDocumentKinds } from "~/modules/shipments/documents.server";
import {
  ACTIVE_SHIPMENT_STATUSES,
  STALE_CREATING_MS,
  cancelOrder,
  cancelWaybill,
  confirmNotCreated,
  createWaybill,
  isManualLink,
  linkWaybillManually,
  reconcileShipment,
  type CreateWaybillResult,
} from "~/modules/shipments/waybill.server";
import { isReissuable, reissueWaybill, type ReissueResult } from "~/modules/shipments/reissue.server";
import { loadShopifyPushState, resendOrderToShopify } from "~/modules/shopify-sync/sync.server";
import { markHandedOver, refreshShipmentTracking } from "~/modules/tracking/tracking.server";
import { SHIPPING_FIELDS, type ShippingField } from "~/modules/validation/types";
import { getRequestContext } from "~/server/context.server";
import { formString, toActionError } from "~/server/http.server";
import type { RequestContext } from "~/server/types";
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSubmitButton,
  Divider,
  FormLayout,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Select,
  Stack,
  Text,
  TextField,
  Thumbnail,
  Timeline,
  type BadgeTone,
  type KeyValueItem,
  type TimelineItem,
} from "~/ui";

/**
 * Сторінка замовлення — основний сценарій етапу 1:
 * перевірка даних → проблеми → виправлення (з історією) → (тестова) накладна.
 * Етап 3: відстеження, фактична передача перевізнику, документи перевізника (PDF), інвойс для друку.
 * Уся бізнес-логіка — у сервісах (orders/workflow, shipments/waybill); тут лише виклики та відображення.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CANDIDATE_LENGTH = 200;
const MAX_WAYBILL_INPUT = 60;

/** Поля форми «Виправити дані»: ім'я input → максимальна довжина (як у orderDataPatchSchema). */
const SHIPPING_MAX_LENGTH: Record<ShippingField, number> = {
  firstName: 80,
  lastName: 80,
  company: 120,
  address1: 200,
  address2: 200,
  city: 120,
  province: 120,
  postalCode: 20,
  countryCode: 2,
  phone: 40,
};

/** Подій відстеження в картці (найновіші). */
const TRACKING_EVENTS_LIMIT = 50;
/** Статуси замовлення, з яких можна вручну підтвердити фактичну передачу перевізнику. */
const HANDOVER_ORDER_STATUSES: readonly OrderStatus[] = ["waybill_created", "awaiting_picking", "packed"];

/** Перевізник повідомив, що накладну видалено (відстеження «cancelled»), а посилку ще не передано. */
function deletedAtCarrier(s: { status: string; handedOverAt: Date | null; trackingStatus: string | null }): boolean {
  return s.status === "created" && !s.handedOverAt && s.trackingStatus === "cancelled";
}

/** Стан передачі трек-номера в Shopify для відправлення. */
type ShopifyTrackingState = "sent" | "pending" | "after_handover" | "disabled" | "not_applicable";

function shopifyTrackingState(
  s: { handedOverAt: Date | null; shopifyFulfilledAt: Date | null },
  source: string,
  pushEnabled: boolean,
): ShopifyTrackingState {
  if (source !== "shopify") return "not_applicable";
  if (s.shopifyFulfilledAt) return "sent";
  if (!pushEnabled) return "disabled";
  return s.handedOverAt ? "pending" : "after_handover";
}

function orderIdFrom(params: Params): string {
  const id = params.orderId ?? "";
  if (!UUID_RE.test(id)) throw new Response("Not Found", { status: 404 });
  return id.toLowerCase();
}

function uuidField(form: FormData, name: string): string | null {
  const v = formString(form, name).trim();
  return UUID_RE.test(v) ? v.toLowerCase() : null;
}

/** Хто виконав зміну — без ідентифікаторів користувачів у відповіді. */
function actorKind(actorId: string, ctx: RequestContext): "system" | "owner" | "staff" | "user" {
  if (actorId === "system") return "system";
  if (actorId === "demo-owner") return "owner";
  if (actorId === "demo-staff") return "staff";
  if (actorId === ctx.actor.id) return ctx.actor.role;
  return "user";
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** Лише для замовлень до передачі перевізнику й не скасованих; лише якщо є що запитати в клієнта. */
function customerRequestDrafts(
  issues: readonly IssueLike[],
  order: { status: OrderStatus; orderNumber: string },
): { uk: CustomerRequestDraftView | null; en: CustomerRequestDraftView | null } | null {
  if (isShipped(order.status) || order.status === "cancelled") return null;
  const view = (locale: "uk" | "en"): CustomerRequestDraftView | null => {
    const d = buildCustomerRequestDraft(issues, locale, { orderNumber: order.orderNumber });
    return d ? { text: d.text, fields: d.requests.map((r) => r.field) } : null;
  };
  const uk = view("uk");
  const en = view("en");
  return uk || en ? { uk, en } : null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  try {
    requirePermission(ctx.actor, "orders.view");
  } catch {
    throw new Response("Forbidden", { status: 403 });
  }
  const orderId = orderIdFrom(params);
  const agg = await loadOrderAggregate(ctx.db, orderId).catch((e: unknown) => {
    if (e instanceof NotFoundError) throw new Response("Not Found", { status: 404 });
    throw e;
  });
  const variantIds = [...new Set(agg.items.flatMap((i) => (i.variant ? [i.variant.id] : [])))];
  const [history, ruleRows, settings, trackingEvents, variantParts, shopifyPush] = await Promise.all([
    loadOrderHistory(ctx.db, orderId),
    loadCountryRuleRows(ctx.db),
    getSettings(ctx.db),
    // Події відстеження — лише для створених накладних; без персональних даних (статус, код, місце, опис).
    Promise.all(
      agg.shipments.map((s) =>
        s.status === "created"
          ? ctx.db
              .select({
                id: shipmentTrackingEvents.id,
                status: shipmentTrackingEvents.status,
                code: shipmentTrackingEvents.code,
                occurredAt: shipmentTrackingEvents.occurredAt,
                location: shipmentTrackingEvents.location,
                description: shipmentTrackingEvents.description,
              })
              .from(shipmentTrackingEvents)
              .where(eq(shipmentTrackingEvents.shipmentId, s.id))
              .orderBy(desc(shipmentTrackingEvents.occurredAt), desc(shipmentTrackingEvents.createdAt))
              .limit(TRACKING_EVENTS_LIMIT)
          : Promise.resolve([]),
      ),
    ),
    // Значення Shopify і збережені в застосунку — для форми митних даних товару.
    loadVariantCustomsParts(ctx.db, variantIds),
    // Етап 4: стан передачі підтверджених змін контактів/адреси в Shopify (черга + відкриті помилки синхронізації).
    loadShopifyPushState(ctx.db, ctx.shopify.kind, agg.order),
  ]);
  const { order } = agg;
  const now = ctx.now().getTime();
  const carrier = ctx.carriers.getDefault();
  const packageNames = new Map(settings.packaging.packages.map((p) => [p.code, p.name]));
  const linkedManually = new Set(
    history.events.filter(({ event }) => event.type === "manually_linked").map(({ event }) => event.shipmentId),
  );

  // Назви країн обчислюються на сервері — однаковий текст під час гідратації.
  const countries = ruleRows.map((r) => ({
    code: r.countryCode,
    name: ctx.locale === "uk" ? r.nameUk : r.nameEn,
    postalCodeExample: r.postalCodeExample,
    hasRule: true,
  }));
  const currentCountry = order.shipCountryCode?.trim().toUpperCase() || null;
  if (currentCountry && !countries.some((c) => c.code === currentCountry)) {
    countries.push({ code: currentCountry, name: countryName(currentCountry, ctx.locale), postalCodeExample: null, hasRule: false });
  }
  const collator = new Intl.Collator(ctx.locale === "uk" ? "uk" : "en");
  countries.sort((a, b) => collator.compare(a.name, b.name));

  const severityRank = { error: 0, warning: 1 } as const;
  const openIssues = [...agg.openIssues]
    .sort((a, b) => severityRank[a.severity] - severityRank[b.severity])
    .map((i) => ({
      id: i.id,
      code: i.code,
      severity: i.severity,
      field: i.field,
      params: i.params ?? {},
      suggestion: i.suggestion ?? null,
    }));

  return {
    isDemo: ctx.mode === "demo",
    order: {
      id: order.id,
      orderNumber: order.orderNumber,
      status: order.status,
      source: order.source,
      version: order.version,
      automationPaused: order.automationPaused,
      lastValidatedAt: order.lastValidatedAt,
      placedAt: order.placedAt,
      cancelledAt: order.cancelledAt,
      currency: order.currency,
      subtotal: order.subtotal,
      shippingPaid: order.shippingPaid,
      total: order.total,
      note: order.note,
      email: order.email,
      contactPhone: order.contactPhone,
      shipping: shippingAddressOf(order),
      countryCode: currentCountry,
      /** Дані можна перевіряти й редагувати (до створення накладної). */
      editable: VALIDATABLE_STATUSES.includes(order.status),
    },
    items: agg.items.map((i) => ({
      id: i.id,
      title: i.title,
      variantTitle: i.variantTitle,
      sku: i.variant?.sku ?? i.sku,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      currency: i.currency,
      lineTotal: isDecimalString(i.unitPrice) ? multiplyMoney(i.unitPrice, i.quantity) : null,
      imageUrl: i.variant?.imageUrl ?? i.variant?.productImageUrl ?? i.imageUrl ?? null,
      variant: i.variant
        ? {
            id: i.variant.id,
            title: i.variant.title,
            productTitle: i.variant.productTitle,
            weightGrams: i.variant.weightGrams,
            hsCode: i.variant.hsCode,
            countryOfOrigin: i.variant.countryOfOrigin?.trim().toUpperCase() || null,
            originName: i.variant.countryOfOrigin ? countryName(i.variant.countryOfOrigin.trim(), ctx.locale) : null,
            customsDescription: i.variant.customsDescription,
            customsDescriptionLocal: i.variant.customsDescriptionLocal,
            material: i.variant.material,
            lengthMm: i.variant.lengthMm,
            widthMm: i.variant.widthMm,
            heightMm: i.variant.heightMm,
            overriddenFields: i.variant.overriddenFields,
            /** Збережені в застосунку значення (поля форми) і значення з Shopify (підказки). */
            overrides: variantParts.get(i.variant.id)?.overrides ?? {},
            shopify: variantParts.get(i.variant.id)?.shopify ?? null,
          }
        : null,
    })),
    openIssues,
    /** Чернетки запиту даних у клієнта (лише шаблони + номер замовлення; нічого не надсилається). */
    customerRequestDrafts: customerRequestDrafts(agg.openIssues, order),
    shipments: agg.shipments.map((s, index) => {
      const adapter = ctx.carriers.get(s.carrierCode);
      const events = trackingEvents[index] ?? [];
      return {
        id: s.id,
        status: s.status,
        mode: s.mode,
        carrierName: adapter?.displayName ?? s.carrierCode,
        carrierReference: s.carrierReference,
        generation: s.generation,
        attempts: s.attempts,
        waybillNumber: s.waybillNumber,
        trackingNumber: s.trackingNumber,
        packageName: s.packageCode ? (packageNames.get(s.packageCode) ?? s.packageCode) : null,
        actualWeightGrams: s.actualWeightGrams,
        volumetricWeightGrams: s.volumetricWeightGrams,
        chargeableWeightGrams: s.chargeableWeightGrams,
        declaredValue: s.declaredValue,
        currency: s.currency,
        lastError: s.lastError,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        active: (ACTIVE_SHIPMENT_STATUSES as readonly string[]).includes(s.status),
        stale: s.status === "creating" && now - s.updatedAt.getTime() > STALE_CREATING_MS,
        /** Запис створено ручним прив'язуванням: скасування лише знімає прив'язку (у перевізника нічого не скасовується). */
        manual: isManualLink(s),
        /** Номер накладної внесено вручну (у т. ч. до відправлення з невідомим результатом). */
        linkedManually: isManualLink(s) || linkedManually.has(s.id),
        canCancel: Boolean(adapter?.capabilities.cancelShipment),
        canLookup: Boolean(adapter?.capabilities.findByReference),
        // --- Відстеження (етап 3) ---
        trackingStatus: s.trackingStatus === null ? null : isTrackingStatus(s.trackingStatus) ? s.trackingStatus : ("unknown" as const),
        carrierStatusCode: s.carrierStatusCode,
        carrierStatusText: s.carrierStatusText,
        carrierStatusAt: s.carrierStatusAt,
        lastTrackedAt: s.lastTrackedAt,
        handedOverAt: s.handedOverAt,
        deliveredAt: s.deliveredAt,
        trackingSupported: Boolean(adapter?.capabilities.tracking && adapter.getTracking),
        /** Перевізник повідомив, що накладну видалено: передавати посилку з нею не можна (скасувати й створити нову). */
        deletedAtCarrier: deletedAtCarrier(s),
        /** Стан дозволяє вручну підтвердити фактичну передачу (право waybills.manage перевіряє сервер і UI). */
        handoverAvailable:
          s.status === "created" && !s.handedOverAt && !deletedAtCarrier(s) && HANDOVER_ORDER_STATUSES.includes(order.status),
        /** Етап 4: можна «Переоформити» (created, не передано, статус замовлення дозволяє); дозволи — сервер і UI. */
        reissuable: isReissuable(s, order.status),
        trackingEvents: events.map((e) => ({
          id: e.id,
          status: isTrackingStatus(e.status) ? e.status : ("unknown" as const),
          code: e.code || null,
          occurredAt: e.occurredAt,
          location: e.location,
          description: e.description,
        })),
        /** Документи перевізника (PDF), які можна отримати для цієї накладної. */
        documents: availableDocumentKinds(ctx, s),
        shopify: {
          state: shopifyTrackingState(s, order.source, settings.tracking.pushToShopify),
          sentAt: s.shopifyFulfilledAt,
        },
      };
    }),
    history: {
      changes: history.changes.map((c) => ({
        id: c.id,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        source: c.source,
        reason: c.reason,
        actor: actorKind(c.actorId, ctx),
        createdAt: c.createdAt,
      })),
      events: history.events.map(({ event, waybillNumber }) => {
        const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
        return {
          id: event.id,
          type: event.type,
          message: event.message,
          waybillNumber,
          /** Для подій tracking_status — новий статус відстеження (без інших даних події). */
          trackingStatus: event.type === "tracking_status" && isTrackingStatus(data.status) ? data.status : null,
          createdAt: event.createdAt,
        };
      }),
      resolvedIssues: history.resolvedIssues.map((i) => ({
        id: i.id,
        code: i.code,
        status: i.status,
        resolution: i.resolution,
        at: i.resolvedAt ?? i.updatedAt,
      })),
    },
    countries,
    carrier: carrier
      ? {
          code: carrier.code,
          displayName: carrier.displayName,
          mode: carrier.mode,
          canCreate: carrier.capabilities.createShipment,
          /** Nova Post: створення реальних накладних вмикає власник змінною середовища (окреме пояснення). */
          isNovaPost: carrier.code === NOVA_POST_CODE,
        }
      : null,
    /** Передача трек-номера в Shopify після фактичної передачі (налаштування «Відстеження»). */
    shopifyPushEnabled: settings.tracking.pushToShopify,
    /** Етап 4: стан передачі виправлених контактів/адреси в Shopify (без персональних даних, лише тексти Shopify). */
    shopifyPush,
    /** Лише назви незаповнених полів відправника — без значень. */
    missingShipperFields: REQUIRED_SHIPPER_FIELDS.filter((f) => !String(settings.shipper[f] ?? "").trim()),
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

function syncKey(sync: NonNullable<Awaited<ReturnType<typeof updateOrderData>>["sync"]>): string {
  if (sync.status === "synced") return "sync.synced";
  if (sync.status === "queued") return "sync.queued";
  if (sync.status === "skipped") return `sync.skipped.${sync.reason}`;
  return "sync.failed";
}

const WAYBILL_TONE = {
  created: "success",
  already_exists: "info",
  recovered: "success",
  rejected: "critical",
  unknown: "critical",
  not_created: "warning",
} as const;

/** Результат створення/звірки накладної → повідомлення для ActionBanner. */
function waybillResult(r: CreateWaybillResult, t: TFunction): ActionResult {
  if (r.kind === "blocked") {
    const params: Record<string, string | number> = { number: "", message: "", ...(r.params ?? {}) };
    if (r.reason === "shipper_incomplete" && typeof params.fields === "string") {
      params.fields = params.fields
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => t(`order.waybill.shipperField.${f}`))
        .join(", ");
    }
    if (typeof params.status === "string") params.status = t(`status.${params.status}`);
    return { ok: true, message: `result.waybill.blocked.${r.reason}`, params, tone: "warning" };
  }
  const params = {
    number: r.shipment?.waybillNumber ?? "",
    message: r.kind === "rejected" || r.kind === "not_created" ? r.message : "",
  };
  if (r.kind === "created") {
    return {
      ok: true,
      message: r.shipment.mode === "live" ? "order.result.createdLive" : "result.waybill.created",
      params,
      extra: ["order.result.notShipped"],
      tone: "success",
    };
  }
  return { ok: true, message: `result.waybill.${r.kind}`, params, tone: WAYBILL_TONE[r.kind] };
}

/** Результат «Переоформити накладну» → повідомлення. Якщо нову не створено — прямо кажемо, що стару СКАСОВАНО. */
function reissueResult(r: ReissueResult, t: TFunction): ActionResult {
  if (r.kind === "concurrent") return { ok: true, message: "order.reissue.result.concurrent", tone: "info" };
  if (r.kind === "not_started") {
    const inner = waybillResult({ kind: "blocked", reason: r.reason, params: r.params }, t);
    const params: Record<string, string | number> = { ...(inner.ok ? (inner.params ?? {}) : {}) };
    const validation = r.reason === "validation";
    if (validation) {
      // Коди проблем пробної перевірки → назви (дані замовлення з накладною не редагуються — шлях через «Скасувати й виправити»).
      params.issues = String(r.params?.issues ?? "")
        .split(",")
        .filter(Boolean)
        .map((code) => (hasKey(`issue.${code}.title`) ? t(`issue.${code}.title`) : code))
        .join(", ");
    }
    return {
      ok: true,
      message: "order.reissue.result.notStarted",
      params,
      extra: [
        ...(inner.ok ? [inner.message] : []),
        ...(validation && params.issues ? ["order.reissue.result.validationIssues"] : []),
        ...(validation ? ["order.reissue.result.correctInstead"] : []),
      ],
      tone: "warning",
    };
  }
  const old = r.cancelled.waybillNumber ?? "";
  if (r.kind === "reissued") {
    return {
      ok: true,
      message: r.recovered ? "order.reissue.result.recovered" : "order.reissue.result.reissued",
      params: { old, number: r.created.waybillNumber ?? "" },
      extra: ["order.result.notShipped"],
      tone: "success",
    };
  }
  if (r.next.kind === "error") {
    // Створення нової накладної завершилося помилкою, але стару вже СКАСОВАНО — кажемо це прямо.
    return {
      ok: true,
      message: "order.reissue.result.cancelledOnly",
      params: { old, code: r.next.code },
      extra: ["order.reissue.result.createError"],
      tone: "critical",
    };
  }
  const inner = waybillResult(r.next, t);
  const innerParams = inner.ok ? (inner.params ?? {}) : {};
  const unknown = r.next.kind === "unknown";
  return {
    ok: true,
    message: "order.reissue.result.cancelledOnly",
    params: { ...innerParams, old },
    extra: [
      ...(inner.ok ? [inner.message, ...(inner.extra ?? [])] : []),
      unknown ? "order.reissue.result.unknownNext" : "order.reissue.result.fixAndCreate",
    ],
    tone: unknown || r.next.kind === "rejected" ? "critical" : "warning",
  };
}

/** Результат «Повторно надіслати в Shopify». */
function resendResult(r: Awaited<ReturnType<typeof resendOrderToShopify>>): ActionResult {
  if (r.status === "queued") return { ok: true, message: "order.shopifySync.result.queued", tone: "success" };
  if (r.status === "synced") return { ok: true, message: "order.shopifySync.result.synced", tone: "success" };
  if (r.status === "failed") return { ok: true, message: "order.shopifySync.result.failed", tone: "critical" };
  const key = r.reason === "demo_mode" ? "demo" : r.reason;
  return { ok: true, message: `order.shopifySync.result.${key}`, tone: r.reason === "invalid_data" ? "warning" : "info" };
}

export async function action({ request, params }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  const orderId = orderIdFrom(params);
  const t = makeT(ctx.locale);
  try {
    requirePermission(ctx.actor, "orders.view");
    const form = await request.formData();
    const intent = formString(form, "intent");
    // Перевірка, що ідентифікатор із форми належить саме цьому замовленню.
    const aggregate = () => loadOrderAggregate(ctx.db, orderId);
    const ownShipment = async () => {
      const id = uuidField(form, "shipmentId");
      if (!id) return null;
      const { shipments } = await aggregate();
      return shipments.find((s) => s.id === id) ?? null;
    };
    const ownShipmentId = async () => (await ownShipment())?.id ?? null;
    const ownOpenIssueId = async () => {
      const id = uuidField(form, "issueId");
      if (!id) return null;
      const { openIssues } = await aggregate();
      return openIssues.some((i) => i.id === id) ? id : null;
    };

    switch (intent) {
      case "validate": {
        const s = await validateOrderById(ctx, orderId);
        return {
          ok: true,
          message: "result.order.validated",
          params: { fixes: s.autoFixes.length, issues: s.issueCount },
          extra: s.blocking ? ["order.result.stillProblems"] : [],
          tone: s.blocking ? "warning" : "success",
        };
      }

      case "updateOrder": {
        // Поле, якого немає у формі, не змінюється (undefined); порожнє → null (обрізає сервіс).
        const field = (name: string) => (form.has(name) ? formString(form, name) : undefined);
        const shipping: Partial<Record<ShippingField, string>> = {};
        for (const f of SHIPPING_FIELDS) {
          const v = field(`shipping.${f}`);
          if (v !== undefined) shipping[f] = v;
        }
        const reason = formString(form, "reason").trim();
        const result = await updateOrderData(ctx, orderId, {
          expectedVersion: Number(formString(form, "expectedVersion")),
          reason: reason || undefined,
          email: field("email"),
          contactPhone: field("contactPhone"),
          shipping,
        });
        const count = result.changedFields.length;
        const extra: string[] = [];
        if (result.sync) extra.push(syncKey(result.sync));
        if (result.validation?.blocking) extra.push("order.result.stillProblems");
        return {
          ok: true,
          message: count > 0 ? "result.order.updated" : "result.order.noChanges",
          params: { count },
          extra,
          tone: count === 0 ? "info" : result.validation?.blocking ? "warning" : "success",
        };
      }

      case "toggleAutomation": {
        const paused = formString(form, "paused") === "true";
        await setOrderAutomationPaused(ctx, orderId, paused);
        return { ok: true, message: paused ? "result.order.paused" : "result.order.resumed" };
      }

      case "cancelOrder": {
        await cancelOrder(ctx, orderId);
        return { ok: true, message: "result.order.cancelled" };
      }

      case "dismissIssue": {
        const issueId = await ownOpenIssueId();
        if (!issueId) return { ok: false, error: "issue.notActionable" };
        await dismissIssue(ctx, issueId);
        return { ok: true, message: "result.issue.dismissed" };
      }

      case "acceptSuggestion": {
        const issueId = await ownOpenIssueId();
        if (!issueId) return { ok: false, error: "issue.notActionable" };
        const candidate = formString(form, "candidate");
        if (!candidate || candidate.length > MAX_CANDIDATE_LENGTH) return { ok: false, error: "issue.invalidCandidate" };
        const s = await acceptSuggestion(ctx, issueId, candidate);
        return {
          ok: true,
          message: "result.suggestion.accepted",
          extra: s.blocking ? ["order.result.stillProblems"] : [],
          tone: s.blocking ? "warning" : "success",
        };
      }

      case "updateVariant": {
        const variantId = uuidField(form, "variantId");
        const { items } = await aggregate();
        if (!variantId || !items.some((i) => i.variant?.id === variantId)) return { ok: false, error: "error.notFound" };
        try {
          // Усі поля форми — рядки; порожнє поле = значення з Shopify.
          const input = Object.fromEntries(OVERRIDE_FIELDS.map((f) => [f, formString(form, f)])) as Record<OverrideField, string>;
          const r = await updateVariantCustomsData(ctx, variantId, input);
          return { ok: true, message: "result.product.updated", params: { count: r.revalidated } };
        } catch (e) {
          // Помилки полів прив'язуємо до конкретного варіанта (на сторінці кілька форм товарів).
          const err = toActionError(e);
          if (err.fieldErrors) {
            err.fieldErrors = Object.fromEntries(
              Object.entries(err.fieldErrors).map(([k, v]) => [`variant.${variantId}.${k}`, v]),
            );
          }
          return err;
        }
      }

      case "createWaybill":
        return waybillResult(await createWaybill(ctx, orderId, { source: "manual" }), t);

      case "reconcile": {
        const shipmentId = await ownShipmentId();
        if (!shipmentId) return { ok: false, error: "error.notFound" };
        return waybillResult(await reconcileShipment(ctx, shipmentId), t);
      }

      case "linkWaybill": {
        const input = formString(form, "waybillNumber").trim().slice(0, MAX_WAYBILL_INPUT);
        const r = await linkWaybillManually(ctx, orderId, input);
        if (r.kind !== "recovered" && r.kind !== "created") return waybillResult(r, t);
        return { ok: true, message: "result.waybill.linked", params: { number: r.shipment.waybillNumber ?? input } };
      }

      case "confirmNotCreated": {
        const shipmentId = await ownShipmentId();
        if (!shipmentId) return { ok: false, error: "error.notFound" };
        await confirmNotCreated(ctx, shipmentId);
        return { ok: true, message: "result.waybill.confirmedNotCreated", tone: "info" };
      }

      case "cancelWaybill": {
        const shipmentId = await ownShipmentId();
        if (!shipmentId) return { ok: false, error: "error.notFound" };
        // «Скасувати й виправити дані»: лише скасування (нове покоління — вручну після виправлення).
        const correction = formString(form, "purpose") === "correction";
        await cancelWaybill(ctx, shipmentId, { purpose: "correction" });
        return correction
          ? { ok: true, message: "result.waybill.cancelled", extra: ["order.correct.result"] }
          : { ok: true, message: "result.waybill.cancelled" };
      }

      case "reissueWaybill": {
        const shipmentId = await ownShipmentId();
        if (!shipmentId) return { ok: false, error: "error.notFound" };
        const trigger = formString(form, "trigger") === "shopify_changed" ? "shopify_changed" : "order_page";
        return reissueResult(await reissueWaybill(ctx, shipmentId, { trigger }), t);
      }

      case "resendShopify":
        return resendResult(await resendOrderToShopify(ctx, orderId));

      case "refreshTracking": {
        const shipmentId = await ownShipmentId();
        if (!shipmentId) return { ok: false, error: "error.notFound" };
        const summary = await refreshShipmentTracking(ctx, shipmentId);
        if (summary.updated === 0 && summary.handedOver === 0) {
          return { ok: true, message: "tracking.result.unchanged", tone: "info" };
        }
        return {
          ok: true,
          message: "tracking.result.updated",
          extra: summary.handedOver > 0 ? ["tracking.result.handedOverByCarrier"] : [],
          tone: "success",
        };
      }

      case "markHandedOver": {
        const shipment = await ownShipment();
        if (!shipment) return { ok: false, error: "error.notFound" };
        requirePermission(ctx.actor, "waybills.manage");
        // Накладну видалено у перевізника — трек-номер «мертвий», передачу (і трек-номер у Shopify) не фіксуємо.
        // Ту саму перевірку в транзакції має робити markHandedOver (сервіс відстеження).
        if (deletedAtCarrier(shipment)) throw new DomainError("shipment.deletedAtCarrier", 409);
        // Допустимий стан перевіряє сервіс. «Буде передано в Shopify» — лише якщо завдання справді поставлено
        // в чергу: markHandedOver має повертати результат requestShopifyFulfillment ("queued" | "disabled" | "skipped…").
        // Поки сервіс нічого не повертає, повідомлення не показується (не обіцяємо того, чого не знаємо).
        const shopifyOutcome: unknown = await markHandedOver(ctx, shipment.id);
        return {
          ok: true,
          message: "tracking.result.handedOver",
          extra: shopifyOutcome === "queued" ? ["tracking.result.shopifyQueued"] : [],
          tone: "success",
        };
      }

      default:
        return { ok: false, error: "error.generic" };
    }
  } catch (e) {
    return toActionError(e);
  }
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

type Data = ReturnType<typeof useLoaderData<typeof loader>>;
type OrderData = Data["order"];
type Item = Data["items"][number];
type Issue = Data["openIssues"][number];
type Shipment = Data["shipments"][number];
type FieldErrors = Record<string, string> | undefined;

/** Поточна відправка форми: intent і (необов'язково) додаткове поле для розрізнення кнопок. */
function useBusy() {
  const navigation = useNavigation();
  const submitting = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  return (intent: string, match?: [name: string, value: string]) => {
    if (!submitting || navigation.formData?.get("intent") !== intent) return false;
    return match ? navigation.formData?.get(match[0]) === match[1] : true;
  };
}

function Hidden({ intent, fields }: { intent: string; fields?: Record<string, string | number> }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
    </>
  );
}

function Missing({ critical }: { critical?: boolean }) {
  const t = useT();
  return critical ? (
    <Badge tone="critical" size="sm">
      {t("order.missing")}
    </Badge>
  ) : (
    <Text as="span" tone="subdued">
      {t("order.missing")}
    </Text>
  );
}

function TimeText({ value }: { value: Date | null | undefined }) {
  const locale = useLocale();
  if (!value) return <>{formatDateTime(value, locale)}</>;
  return <time dateTime={value.toISOString()}>{formatDateTime(value, locale)}</time>;
}

/** Назва поля для проблеми / історії: shipping.*, email, contactPhone, variant.<id>.<f>, lineItem.<id>, order. */
function fieldLabel(field: string | null, items: Item[], t: TFunction): string | null {
  if (!field) return null;
  const variant = /^variant\.([^.]+)\.([A-Za-z]+)$/.exec(field);
  if (variant) {
    const label = t(`field.variant.${variant[2]}`);
    const item = items.find((i) => i.variant?.id === variant[1]);
    return item ? t("order.issues.fieldOfItem", { field: label, item: item.variant?.productTitle ?? item.title }) : label;
  }
  const line = /^lineItem\.(.+)$/.exec(field);
  if (line) {
    const item = items.find((i) => i.id === line[1]);
    return item ? t("order.issues.fieldOfItem", { field: t("field.lineItem"), item: item.title }) : t("field.lineItem");
  }
  const key = `field.${field}`;
  return hasKey(key) ? t(key) : field;
}

/** Причина зміни: ключі autofix.* / issue.* перекладаються, довільний текст — як є. */
function reasonText(reason: string | null, t: TFunction): string | null {
  if (!reason) return null;
  if ((reason.startsWith("autofix.") || reason.startsWith("issue.")) && hasKey(reason)) return t(reason);
  return reason;
}

/** Службові коди в повідомленнях накладної (напр. confirmed_not_created) → текст; решта — як є. */
function codeText(value: string, t: TFunction): string {
  const key = `order.code.${value}`;
  return hasKey(key) ? t(key) : value;
}

function carrierLabel(name: string, mode: string, t: TFunction): string {
  return mode === "test" ? t("demo.testCarrier") : name;
}

export default function OrderDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const busy = useBusy();
  const { order } = data;

  const shipped = isShipped(order.status);
  const active = data.shipments.find((s) => s.active) ?? null;
  const unresolvedWaybill = Boolean(active && active.status !== "created");
  const fieldErrors: FieldErrors = actionData && !actionData.ok ? actionData.fieldErrors : undefined;

  const primaryAction =
    order.editable && can("orders.edit") ? (
      <Form method="post">
        <Hidden intent="validate" />
        <Button type="submit" variant="primary" loading={busy("validate")}>
          {t("order.validate.button")}
        </Button>
      </Form>
    ) : null;

  const canToggle = can("orders.edit") && !shipped && order.status !== "cancelled";
  const canCancelOrder = can("orders.cancel") && !shipped && order.status !== "cancelled";
  const secondaryActions =
    canToggle || canCancelOrder ? (
      <Stack direction="horizontal" gap={2}>
        {canToggle ? (
          <Form method="post">
            <Hidden intent="toggleAutomation" fields={{ paused: order.automationPaused ? "false" : "true" }} />
            <Button type="submit" loading={busy("toggleAutomation")}>
              {t(order.automationPaused ? "order.automation.resume" : "order.automation.pause")}
            </Button>
          </Form>
        ) : null}
        {canCancelOrder ? (
          <Form method="post">
            <Hidden intent="cancelOrder" />
            <ConfirmSubmitButton
              variant="critical"
              disabled={unresolvedWaybill}
              loading={busy("cancelOrder")}
              title={t("order.cancel.title", { number: order.orderNumber })}
              confirmLabel={t("order.cancel.confirm")}
              cancelLabel={t("order.dialog.keep")}
              message={
                <Stack gap={2}>
                  <Text>{t("order.cancel.body")}</Text>
                  {active?.status === "created" ? (
                    <Text weight="semibold">
                      {t(active.mode === "test" ? "order.cancel.withTestWaybill" : "order.cancel.withWaybill", {
                        number: active.waybillNumber ?? "",
                      })}
                    </Text>
                  ) : null}
                  <Text variant="body-sm" tone="subdued">
                    {t("order.cancel.shopifyNote")}
                  </Text>
                </Stack>
              }
            >
              {t("order.cancel.button")}
            </ConfirmSubmitButton>
          </Form>
        ) : null}
      </Stack>
    ) : null;

  return (
    <Page
      title={order.orderNumber}
      subtitle={t("order.subtitle", { date: formatDateTime(order.placedAt, locale) })}
      backHref={href("orders")}
      backLabel={t("order.backToOrders")}
      titleMeta={
        <Stack as="span" direction="horizontal" gap={1} align="center">
          <OrderStatusBadge status={order.status} />
          {order.source === "demo" ? (
            <Badge tone="outline" title={t("order.demoOrderHint")}>
              {t("common.demo")}
            </Badge>
          ) : null}
          {order.automationPaused ? <Badge tone="warning">{t("order.automationPaused")}</Badge> : null}
        </Stack>
      }
      primaryAction={primaryAction}
      secondaryActions={secondaryActions}
    >
      <Stack gap={4}>
        <ActionBanner data={actionData} />
        <ProgressCard data={data} />
        <Grid columns={{ xs: 1, lg: 2 }} gap={4}>
          <Stack gap={4}>
            <IssuesCard data={data} />
            {data.customerRequestDrafts ? (
              <CustomerRequestPanel
                drafts={data.customerRequestDrafts}
                defaultLocale={data.order.countryCode === "UA" ? "uk" : "en"}
              />
            ) : null}
            <AddressCard data={data} fieldErrors={fieldErrors} />
            <ShopifySyncCard data={data} />
            <ItemsCard data={data} fieldErrors={fieldErrors} />
          </Stack>
          <Stack gap={4}>
            <WaybillCard data={data} />
            <SummaryCard order={order} />
            <HistoryCard data={data} />
          </Stack>
        </Grid>
      </Stack>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// 2. Хід обробки
// ---------------------------------------------------------------------------

type StepState = "done" | "current" | "attention" | "todo";
const STEP_TONE: Record<StepState, BadgeTone> = {
  done: "success",
  current: "strong",
  attention: "critical",
  todo: "outline",
};

function ProgressCard({ data }: { data: Data }) {
  const t = useT();
  const { order } = data;
  if (order.status === "cancelled") {
    return (
      <Card title={t("order.progress.title")}>
        <Text>{t("order.progress.cancelled")}</Text>
      </Card>
    );
  }
  const active = data.shipments.find((s) => s.active) ?? null;
  const pastWaybill = !order.editable;
  const hasWaybill = active?.status === "created" || pastWaybill;
  const validated = Boolean(order.lastValidatedAt) || pastWaybill;
  const openErrors = data.openIssues.filter((i) => i.severity === "error").length;
  const fixed = validated && openErrors === 0 && order.status !== "needs_correction";
  // Результат невідомий або запит «завис» — потрібна дія менеджера; звичайне «створюється» — у процесі.
  const waybillNeedsAttention = Boolean(active && (active.status === "unknown" || active.stale));
  const steps: { key: string; state: StepState }[] = [
    { key: "paid", state: "done" },
    { key: "validated", state: validated ? "done" : "current" },
    { key: "fixed", state: fixed ? "done" : validated ? "attention" : "todo" },
    {
      key: "waybill",
      state: hasWaybill ? "done" : waybillNeedsAttention ? "attention" : active || fixed ? "current" : "todo",
    },
  ];
  return (
    <Card title={t("order.progress.title")}>
      <Stack gap={3}>
        <Stack as="ol" direction="horizontal" gap={5} align="center">
          {steps.map((step, index) => (
            <Stack as="li" key={step.key} direction="horizontal" gap={2} align="center" wrap={false}>
              <Badge tone={STEP_TONE[step.state]}>{index + 1}</Badge>
              <Stack gap={0}>
                <Text as="span" variant="body-sm" weight="semibold">
                  {t(`order.progress.${step.key}`)}
                </Text>
                <Text as="span" variant="caption" tone={step.state === "attention" ? "critical" : "subdued"}>
                  {t(`order.progress.state.${step.state}`)}
                </Text>
              </Stack>
            </Stack>
          ))}
        </Stack>
        <Text variant="caption" tone="subdued">
          {t("order.progress.note")}
        </Text>
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 3. Проблеми
// ---------------------------------------------------------------------------

function IssuesCard({ data }: { data: Data }) {
  const t = useT();
  const locale = useLocale();
  const { order, openIssues } = data;
  const validated = Boolean(order.lastValidatedAt) || !order.editable;
  return (
    <Card
      title={t("order.issues.title")}
      description={openIssues.length > 0 ? t("order.issues.count", { count: openIssues.length }) : undefined}
    >
      {openIssues.length === 0 ? (
        validated ? (
          <Banner tone="success" title={t("order.issues.none.title")}>
            {order.lastValidatedAt
              ? t("order.issues.none.body", { time: formatDateTime(order.lastValidatedAt, locale) })
              : null}
          </Banner>
        ) : (
          <Banner tone="info" title={t("order.issues.notValidated.title")}>
            {t("order.issues.notValidated.body")}
          </Banner>
        )
      ) : (
        <Stack as="ul" gap={4}>
          {openIssues.map((issue, index) => (
            <Stack as="li" key={issue.id} gap={2}>
              {index > 0 ? <Divider /> : null}
              <IssueItem issue={issue} data={data} />
            </Stack>
          ))}
        </Stack>
      )}
    </Card>
  );
}

function IssueItem({ issue, data }: { issue: Issue; data: Data }) {
  const t = useT();
  const can = useCan();
  const busy = useBusy();
  const label = fieldLabel(issue.field, data.items, t);
  const isCarrier = issue.code.startsWith("CARRIER_");
  const canEdit = can("orders.edit");
  const candidates = issue.suggestion?.candidates ?? [];
  const message = typeof issue.params.message === "string" ? issue.params.message : null;
  const reference = typeof issue.params.reference === "string" ? issue.params.reference : null;
  const nextKey = `order.issues.next.${issue.code}`;

  return (
    <Stack gap={2}>
      <Stack direction="horizontal" gap={2} align="center">
        <SeverityBadge severity={issue.severity} />
        <Text as="h3" variant="heading-sm">
          {t(`issue.${issue.code}.title`)}
        </Text>
      </Stack>
      {label ? (
        <Text variant="body-sm" tone="subdued">
          {t("order.issues.field", { field: label })}
        </Text>
      ) : null}
      <Text variant="body-sm">{t(`issue.${issue.code}.help`, localizeParams(issue.params, t))}</Text>

      {isCarrier && message ? (
        <Text variant="body-sm">{t("order.issues.carrierMessage", { message: codeText(message, t) })}</Text>
      ) : null}
      {isCarrier && reference ? (
        <Text variant="body-sm">
          {t("order.issues.carrierReference", { reference })}
        </Text>
      ) : null}
      {isCarrier && hasKey(nextKey) ? (
        <Text variant="body-sm" weight="medium">
          {t(nextKey)}
        </Text>
      ) : null}

      {candidates.length > 0 && canEdit && data.order.editable ? (
        <Form method="post">
          <Hidden intent="acceptSuggestion" fields={{ issueId: issue.id }} />
          <Stack gap={2}>
            <Text variant="body-sm" weight="medium">
              {t(candidates.length > 1 ? "order.issues.suggestion.many" : "order.issues.suggestion.one")}
            </Text>
            <Stack direction="horizontal" gap={2}>
              {candidates.map((candidate) => (
                <Button
                  key={candidate}
                  type="submit"
                  name="candidate"
                  value={candidate}
                  loading={busy("acceptSuggestion", ["candidate", candidate]) && busy("acceptSuggestion", ["issueId", issue.id])}
                >
                  {t("order.issues.apply", { value: candidate })}
                </Button>
              ))}
            </Stack>
          </Stack>
        </Form>
      ) : null}

      {(issue.severity === "warning" || MANUALLY_CLOSABLE_ISSUE_CODES.includes(issue.code)) && canEdit ? (
        <Form method="post">
          <Hidden intent="dismissIssue" fields={{ issueId: issue.id }} />
          <Button type="submit" variant="plain" size="sm" loading={busy("dismissIssue", ["issueId", issue.id])}>
            {issue.code === "CARRIER_REJECTED"
              ? t("order.issues.retryAsIs")
              : issue.severity === "warning"
                ? t("order.issues.dismiss")
                : t("order.issues.closeChecked")}
          </Button>
        </Form>
      ) : null}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 4. Отримувач і адреса
// ---------------------------------------------------------------------------

/** Помилки полів форми: спершу помилки останньої дії, далі відкриті проблеми з цим полем. */
function useFieldError(issues: Issue[], fieldErrors: FieldErrors) {
  const t = useT();
  return (name: string): string | null => {
    if (fieldErrors?.[name]) return t("order.address.fieldInvalid");
    const titles = issues
      .filter((i) => i.field === name)
      .map((i) =>
        // Помилку Shopify показуємо його власним текстом біля поля.
        i.code === "SHOPIFY_SYNC_FAILED" && typeof i.params?.message === "string"
          ? t("order.address.shopifyRejected", { message: i.params.message })
          : t(`issue.${i.code}.title`),
      );
    return titles.length > 0 ? titles.join("; ") : null;
  };
}

function AddressCard({ data, fieldErrors }: { data: Data; fieldErrors: FieldErrors }) {
  const t = useT();
  const can = useCan();
  const { order, openIssues } = data;
  const s = order.shipping;
  const issueFields = new Set(openIssues.filter((i) => i.severity === "error").map((i) => i.field));
  const country = data.countries.find((c) => c.code === order.countryCode);

  const value = (v: string | null | undefined, field: string): ReactNode =>
    v && v.trim() ? v : <Missing critical={issueFields.has(field)} />;
  const optional = (v: string | null | undefined, field: string, key: string): KeyValueItem[] =>
    v && v.trim() ? [{ key, label: t(`field.${field}`), value: v }] : [];

  const name = [s.firstName, s.lastName].filter((v) => v && v.trim()).join(" ");
  const items: KeyValueItem[] = [
    {
      key: "recipient",
      label: t("order.address.recipient"),
      value: name || <Missing critical={issueFields.has("shipping.lastName")} />,
    },
    ...optional(s.company, "shipping.company", "company"),
    { key: "address1", label: t("field.shipping.address1"), value: value(s.address1, "shipping.address1") },
    ...optional(s.address2, "shipping.address2", "address2"),
    { key: "city", label: t("field.shipping.city"), value: value(s.city, "shipping.city") },
    ...(s.province || issueFields.has("shipping.province")
      ? [{ key: "province", label: t("field.shipping.province"), value: value(s.province, "shipping.province") }]
      : []),
    { key: "postal", label: t("field.shipping.postalCode"), value: value(s.postalCode, "shipping.postalCode") },
    {
      key: "country",
      label: t("field.shipping.countryCode"),
      value: order.countryCode ? (
        <Stack as="span" direction="horizontal" gap={1} align="center">
          <InlineCode>{order.countryCode}</InlineCode>
          {country ? <span>{country.name}</span> : null}
        </Stack>
      ) : (
        <Missing critical={issueFields.has("shipping.countryCode")} />
      ),
    },
    { key: "phone", label: t("field.shipping.phone"), value: value(s.phone, "shipping.phone") },
    { key: "email", label: t("field.email"), value: value(order.email, "email") },
    ...optional(order.contactPhone, "contactPhone", "contactPhone"),
  ];

  let readOnly: string | null = null;
  if (!order.editable) {
    readOnly =
      order.status === "cancelled"
        ? "order.address.readOnly.cancelled"
        : isShipped(order.status)
          ? "order.address.readOnly.shipped"
          : "order.address.readOnly.waybill";
  } else if (!can("orders.edit")) {
    readOnly = "order.address.readOnly.permission";
  }

  return (
    <Card title={t("order.address.title")}>
      <Stack gap={4}>
        <KeyValueList items={items} />
        <Divider />
        {readOnly ? (
          <Banner tone="info">{t(readOnly)}</Banner>
        ) : (
          <AddressForm key={order.version} data={data} fieldErrors={fieldErrors} />
        )}
      </Stack>
    </Card>
  );
}

/** Форма виправлення даних. key={version} — після збереження поля заповнюються новими значеннями. */
function AddressForm({ data, fieldErrors }: { data: Data; fieldErrors: FieldErrors }) {
  const t = useT();
  const busy = useBusy();
  const { order } = data;
  const s = order.shipping;
  const errorFor = useFieldError(data.openIssues, fieldErrors);
  const [countryCode, setCountryCode] = useState(order.countryCode ?? "");
  const rule = data.countries.find((c) => c.code === countryCode);
  const example = rule?.postalCodeExample ?? null;

  const text = (field: ShippingField, extra: Partial<Parameters<typeof TextField>[0]> = {}) => {
    const name = `shipping.${field}`;
    return (
      <TextField
        name={name}
        label={t(`field.${name}`)}
        defaultValue={s[field] ?? ""}
        error={errorFor(name)}
        maxLength={SHIPPING_MAX_LENGTH[field]}
        autoComplete="off"
        {...extra}
      />
    );
  };

  return (
    <Form method="post" aria-labelledby="order-edit-title">
      <Hidden intent="updateOrder" fields={{ expectedVersion: order.version }} />
      <Stack gap={4}>
        <Stack gap={1}>
          <Text as="h3" variant="heading-sm" id="order-edit-title">
            {t("order.address.edit.title")}
          </Text>
          <Text variant="body-sm" tone="subdued">
            {t("order.address.edit.help")}
          </Text>
        </Stack>

        <Text as="h4" variant="body-sm" weight="semibold">
          {t("order.address.shippingSection")}
        </Text>
        <FormLayout columns={2}>
          {text("firstName")}
          {text("lastName")}
          {text("company")}
          {text("address1")}
          {text("address2")}
          {text("city")}
          {text("province")}
          {text("postalCode", {
            placeholder: example ?? undefined,
            helpText: example ? t("order.address.postalExample", { example }) : undefined,
            autoCapitalize: "characters",
            spellCheck: false,
          })}
          <Select
            name="shipping.countryCode"
            label={t("field.shipping.countryCode")}
            placeholder={t("order.address.countryPlaceholder")}
            options={data.countries.map((c) => ({
              value: c.code,
              label: c.hasRule ? `${c.code} — ${c.name}` : t("order.address.countryNoRules", { name: `${c.code} — ${c.name}` }),
            }))}
            value={countryCode}
            onChange={(e) => setCountryCode(e.target.value)}
            error={errorFor("shipping.countryCode")}
          />
          {text("phone", { type: "tel", inputMode: "tel", helpText: t("order.address.phoneHelp"), spellCheck: false })}
        </FormLayout>

        <Text as="h4" variant="body-sm" weight="semibold">
          {t("order.address.contactSection")}
        </Text>
        <FormLayout columns={2}>
          {/* type="text": некоректний email не повинен блокувати збереження інших полів (це лише попередження). */}
          <TextField
            name="email"
            label={t("field.email")}
            defaultValue={order.email ?? ""}
            error={errorFor("email")}
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            maxLength={160}
          />
          <TextField
            name="contactPhone"
            label={t("field.contactPhone")}
            defaultValue={order.contactPhone ?? ""}
            error={errorFor("contactPhone")}
            type="tel"
            inputMode="tel"
            spellCheck={false}
            autoComplete="off"
            maxLength={40}
          />
        </FormLayout>

        <TextField
          name="reason"
          label={t("order.address.reason")}
          placeholder={t("order.address.reasonPlaceholder")}
          error={fieldErrors?.reason ? t("order.address.fieldInvalid") : null}
          autoComplete="off"
          maxLength={300}
        />

        <Stack direction="horizontal" gap={2}>
          <Button type="submit" variant="primary" loading={busy("updateOrder")}>
            {t("common.save")}
          </Button>
        </Stack>
      </Stack>
    </Form>
  );
}

// ---------------------------------------------------------------------------
// 5. Товари
// ---------------------------------------------------------------------------

function ItemsCard({ data, fieldErrors }: { data: Data; fieldErrors: FieldErrors }) {
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const href = useHref();
  const { items, isDemo } = data;
  const units = items.reduce((sum, i) => sum + i.quantity, 0);
  // Дані товару змінюємо лише поки замовлення можна перевіряти (після накладної — спершу скасувати її).
  // Демо й робоча версія: зміни зберігаються в застосунку і мають пріоритет над Shopify.
  const canEditCustoms = can("orders.edit") && data.order.editable;
  const seenVariants = new Set<string>();

  return (
    <Card title={t("order.items.title")} description={t("order.items.summary", { lines: items.length, units })}>
      <Stack gap={4}>
        <Stack as="ul" gap={4}>
          {items.map((item, index) => {
            const v = item.variant;
            const firstOfVariant = v ? !seenVariants.has(v.id) : false;
            if (v) seenVariants.add(v.id);
            const mark = (field: OverrideField) => (v?.overriddenFields.includes(field) ? <OverriddenBadge /> : null);
            const withMark = (field: OverrideField, value: ReactNode) =>
              v?.overriddenFields.includes(field) ? (
                <Stack as="span" direction="horizontal" gap={1} align="center">
                  {value}
                  {mark(field)}
                </Stack>
              ) : (
                value
              );
            const kv: KeyValueItem[] = v
              ? [
                  { key: "sku", label: t("order.items.sku"), value: item.sku ? <InlineCode>{item.sku}</InlineCode> : <Missing /> },
                  {
                    key: "weight",
                    label: t("order.items.weight"),
                    value: v.weightGrams !== null ? withMark("weightGrams", formatWeight(v.weightGrams, locale)) : <Missing critical />,
                  },
                  {
                    key: "hs",
                    label: t("field.variant.hsCode"),
                    value: v.hsCode ? withMark("hsCode", <InlineCode>{v.hsCode}</InlineCode>) : <Missing critical />,
                  },
                  {
                    key: "origin",
                    label: t("field.variant.countryOfOrigin"),
                    value: v.countryOfOrigin ? (
                      <Stack as="span" direction="horizontal" gap={1} align="center">
                        <InlineCode>{v.countryOfOrigin}</InlineCode>
                        {v.originName ? <span>{v.originName}</span> : null}
                        {mark("countryOfOrigin")}
                      </Stack>
                    ) : (
                      <Missing critical />
                    ),
                  },
                  {
                    key: "description",
                    label: t("field.variant.customsDescription"),
                    value: v.customsDescription ? withMark("customsDescription", v.customsDescription) : <Missing critical />,
                  },
                ]
              : [];
            return (
              <Stack as="li" key={item.id} gap={3}>
                {index > 0 ? <Divider /> : null}
                <Stack direction="horizontal" gap={3} align="start" wrap={false}>
                  <Thumbnail src={item.imageUrl} alt="" size="md" />
                  <Stack gap={1}>
                    <Text weight="semibold">{item.title}</Text>
                    {item.variantTitle ? (
                      <Text variant="body-sm" tone="subdued">
                        {item.variantTitle}
                      </Text>
                    ) : null}
                    <Text variant="body-sm" numeric>
                      {t("order.items.qtyPrice", {
                        qty: item.quantity,
                        price: formatMoney(item.unitPrice, item.currency, locale),
                        total: formatMoney(item.lineTotal, item.currency, locale),
                      })}
                    </Text>
                  </Stack>
                </Stack>
                {v ? <KeyValueList items={kv} /> : <Banner tone="critical">{t("order.items.notLinked")}</Banner>}
                {v && firstOfVariant && canEditCustoms ? (
                  <CustomsEditor variant={v} isDemo={isDemo} openIssues={data.openIssues} fieldErrors={fieldErrors} />
                ) : null}
              </Stack>
            );
          })}
        </Stack>
        <Stack direction="horizontal" gap={2} align="center">
          <Text variant="body-sm" tone="subdued">
            {t("products.order.allProducts")}
          </Text>
          <Button to={href("products")} variant="plain" size="sm">
            {t("products.order.openProducts")}
          </Button>
        </Stack>
      </Stack>
    </Card>
  );
}

/** Форма митних даних товару (спільний компонент) з помилками дії та відкритими проблемами цього варіанта. */
function CustomsEditor({
  variant,
  isDemo,
  openIssues,
  fieldErrors,
}: {
  variant: NonNullable<Item["variant"]>;
  isDemo: boolean;
  openIssues: Issue[];
  fieldErrors: FieldErrors;
}) {
  const t = useT();
  const prefix = `variant.${variant.id}.`;
  // Назви відкритих проблем за полями варіанта (OVERRIDE_FIELDS не імпортуємо в клієнтський код — там zod і перевірки).
  const issueErrors: Partial<Record<OverrideField, string>> = {};
  for (const issue of openIssues) {
    if (!issue.field?.startsWith(prefix)) continue;
    const field = issue.field.slice(prefix.length) as OverrideField;
    const title = t(`issue.${issue.code}.title`);
    issueErrors[field] = issueErrors[field] ? `${issueErrors[field]}; ${title}` : title;
  }
  return (
    <VariantCustomsForm
      variant={{ id: variant.id, overrides: variant.overrides, shopify: variant.shopify }}
      isDemo={isDemo}
      fieldErrors={fieldErrors}
      issueErrors={issueErrors}
      open={openIssues.some((i) => i.field?.startsWith(prefix))}
    />
  );
}

// ---------------------------------------------------------------------------
// 6. Накладна
// ---------------------------------------------------------------------------

function WaybillCard({ data }: { data: Data }) {
  const t = useT();
  const active = data.shipments.find((s) => s.active) ?? null;
  const previous = data.shipments.filter((s) => !s.active);
  let body: ReactNode;
  // Етап 4: дані змінено в Shopify після створення накладної — підказка, що застосувати їх можна лише переоформленням.
  const shopifyChange = active?.status === "created" ? data.openIssues.find((i) => i.code === "SHOPIFY_ORDER_CHANGED") : undefined;
  if (active?.status === "created") {
    body = (
      <>
        {shopifyChange ? <ShopifyChangedHint issue={shopifyChange} shipment={active} data={data} /> : null}
        <CreatedWaybill
          shipment={active}
          order={data.order}
          shopifyPushEnabled={data.shopifyPushEnabled}
          shopifyChanged={Boolean(shopifyChange)}
        />
      </>
    );
  }
  else if (active && (active.status === "unknown" || active.stale)) body = <UnknownWaybill shipment={active} />;
  else if (active) body = <CreatingWaybill order={data.order} />;
  else body = <NoWaybill data={data} />;

  return (
    <Card title={t("order.waybill.title")}>
      <Stack gap={4}>
        {body}
        {previous.length > 0 ? <PreviousShipments shipments={previous} /> : null}
      </Stack>
    </Card>
  );
}

function CreatedWaybill({
  shipment: s,
  order,
  shopifyPushEnabled,
  shopifyChanged,
}: {
  shipment: Shipment;
  order: OrderData;
  shopifyPushEnabled: boolean;
  shopifyChanged: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const busy = useBusy();
  const shipped = isShipped(order.status);
  const kv: KeyValueItem[] = [
    { key: "carrier", label: t("order.waybill.carrier"), value: carrierLabel(s.carrierName, s.mode, t) },
    ...(s.trackingNumber && s.trackingNumber !== s.waybillNumber
      ? [{ key: "tracking", label: t("order.waybill.tracking"), value: <InlineCode>{s.trackingNumber}</InlineCode> }]
      : []),
    { key: "reference", label: t("order.waybill.reference"), value: <InlineCode>{s.carrierReference}</InlineCode> },
    ...(s.packageName ? [{ key: "package", label: t("order.waybill.package"), value: s.packageName }] : []),
    { key: "actual", label: t("order.waybill.weightActual"), value: formatWeight(s.actualWeightGrams, locale) },
    { key: "volumetric", label: t("order.waybill.weightVolumetric"), value: formatWeight(s.volumetricWeightGrams, locale) },
    { key: "chargeable", label: t("order.waybill.weightChargeable"), value: formatWeight(s.chargeableWeightGrams, locale) },
    { key: "declared", label: t("order.waybill.declaredValue"), value: formatMoney(s.declaredValue, s.currency, locale) },
    { key: "created", label: t("order.waybill.createdAt"), value: <TimeText value={s.updatedAt} /> },
    { key: "attempts", label: t("order.waybill.attempts"), value: s.attempts },
  ];
  const canCancel = can("waybills.manage") && !shipped && order.status !== "cancelled";
  const canHandOver = can("waybills.manage") && s.handoverAvailable;
  const canRefresh = can("waybills.create") && s.trackingSupported;

  let shopifyNote: string;
  if (order.source !== "shopify") shopifyNote = t("tracking.handover.notShopify");
  else if (shopifyPushEnabled) shopifyNote = t("tracking.handover.shopify");
  else shopifyNote = t("tracking.handover.shopifyDisabled");

  return (
    <Stack gap={3}>
      <Stack direction="horizontal" gap={2} align="center">
        <ShipmentStatusBadge status={s.status} />
        {s.mode === "test" ? <TestBadge /> : null}
        {s.trackingStatus ? <TrackingStatusBadge status={s.trackingStatus} /> : null}
      </Stack>
      <Stack gap={1}>
        <Text variant="caption" tone="subdued">
          {t("order.waybill.number")}
        </Text>
        <Text as="p" variant="heading-lg">
          <InlineCode>{s.waybillNumber}</InlineCode>
        </Text>
      </Stack>
      <KeyValueList items={kv} />
      {s.mode === "test" ? (
        <Text variant="body-sm" tone="subdued">
          {t("order.waybill.testNote")}
        </Text>
      ) : null}
      {s.linkedManually ? (
        <Text variant="body-sm" tone="subdued">
          {t("order.waybill.manualNote")}
        </Text>
      ) : null}
      {!shipped ? <Banner tone="info">{t("order.waybill.notShipped")}</Banner> : null}
      {s.deletedAtCarrier ? (
        <Banner tone="critical" title={t("tracking.deleted.title")}>
          {t("tracking.deleted.body")}
        </Banner>
      ) : null}
      {canHandOver || canRefresh ? (
        <Stack gap={2}>
          <Stack direction="horizontal" gap={2}>
            {canHandOver ? (
              <Form method="post">
                <Hidden intent="markHandedOver" fields={{ shipmentId: s.id }} />
                <ConfirmSubmitButton
                  variant="primary"
                  loading={busy("markHandedOver")}
                  title={t("tracking.handover.title")}
                  confirmLabel={t("tracking.handover.confirm")}
                  cancelLabel={t("common.cancel")}
                  message={
                    <Stack gap={2}>
                      <Text>{t("tracking.handover.body")}</Text>
                      <Text weight="semibold">{shopifyNote}</Text>
                    </Stack>
                  }
                >
                  {t("tracking.handover.button")}
                </ConfirmSubmitButton>
              </Form>
            ) : null}
            {canRefresh ? (
              <Form method="post">
                <Hidden intent="refreshTracking" fields={{ shipmentId: s.id }} />
                <Button type="submit" loading={busy("refreshTracking")}>
                  {t("tracking.refresh.button")}
                </Button>
              </Form>
            ) : null}
          </Stack>
          {canHandOver ? (
            <Text variant="body-sm" tone="subdued">
              {t("tracking.handover.help")}
            </Text>
          ) : null}
        </Stack>
      ) : null}

      <Divider />
      <TrackingSection shipment={s} canHandOver={canHandOver} />
      <Divider />
      <DocumentsSection shipment={s} orderId={order.id} />

      {canCancel && (s.manual || s.canCancel) ? (
        <>
          <Divider />
          <ChangeWaybillSection shipment={s} order={order} shopifyChanged={shopifyChanged} />
        </>
      ) : null}
      {canCancel && !s.manual && !s.canCancel ? (
        <Text variant="body-sm" tone="subdued">
          {t("order.waybill.cancel.unsupported")}
        </Text>
      ) : null}
    </Stack>
  );
}

/** Відстеження: статус перевізника, фактична передача, доставка, трек-номер у Shopify, події. */
function TrackingSection({ shipment: s, canHandOver }: { shipment: Shipment; canHandOver: boolean }) {
  const t = useT();
  const locale = useLocale();

  let carrierStatus: ReactNode = null;
  if (s.carrierStatusText && s.carrierStatusCode) {
    carrierStatus = t("tracking.field.carrierStatusValue", { text: s.carrierStatusText, code: s.carrierStatusCode });
  } else if (s.carrierStatusText) {
    carrierStatus = s.carrierStatusText;
  } else if (s.carrierStatusCode) {
    carrierStatus = <InlineCode>{s.carrierStatusCode}</InlineCode>;
  }

  let shopify: string;
  switch (s.shopify.state) {
    case "sent":
      shopify = t("tracking.shopify.sent", { time: formatDateTime(s.shopify.sentAt, locale) });
      break;
    case "pending":
      shopify = t("tracking.shopify.pending");
      break;
    case "after_handover":
      shopify = t("tracking.shopify.afterHandover");
      break;
    case "disabled":
      shopify = t("tracking.shopify.disabled");
      break;
    default:
      shopify = t("tracking.shopify.notApplicable");
  }

  const kv: KeyValueItem[] = [
    { key: "status", label: t("tracking.field.status"), value: <TrackingStatusBadge status={s.trackingStatus} /> },
    ...(carrierStatus ? [{ key: "carrierStatus", label: t("tracking.field.carrierStatus"), value: carrierStatus }] : []),
    ...(s.carrierStatusAt ? [{ key: "statusAt", label: t("tracking.field.statusAt"), value: <TimeText value={s.carrierStatusAt} /> }] : []),
    ...(s.trackingSupported
      ? [
          {
            key: "lastChecked",
            label: t("tracking.field.lastChecked"),
            value: s.lastTrackedAt ? <TimeText value={s.lastTrackedAt} /> : t("tracking.notChecked"),
          },
        ]
      : []),
    {
      key: "handedOver",
      label: t("tracking.field.handedOver"),
      value: s.handedOverAt ? <TimeText value={s.handedOverAt} /> : t("tracking.notYet"),
    },
    ...(s.deliveredAt ? [{ key: "delivered", label: t("tracking.field.delivered"), value: <TimeText value={s.deliveredAt} /> }] : []),
    { key: "shopify", label: t("tracking.shopify.label"), value: shopify },
  ];

  const events: TimelineItem[] = s.trackingEvents.map((e) => ({
    id: e.id,
    title: t(`tracking.status.${e.status}`),
    description: [e.description, e.location, e.code ? t("tracking.event.code", { code: e.code }) : null].filter(Boolean).join(" · ") || undefined,
    time: <TimeText value={e.occurredAt} />,
    tone: trackingTimelineTone(e.status),
  }));

  return (
    <Stack gap={3}>
      <Text as="h3" variant="heading-sm">
        {t("tracking.section.title")}
      </Text>
      <KeyValueList items={kv} />
      <Text variant="body-sm" tone="subdued">
        {s.trackingSupported ? t("tracking.refresh.help") : t("tracking.unsupported")}
        {/* Підказка про ручну передачу — лише коли кнопка «Передано перевізнику» є на екрані. */}
        {!s.trackingSupported && canHandOver ? ` ${t("tracking.unsupportedManual")}` : null}
      </Text>
      {s.trackingSupported || events.length > 0 ? (
        <Stack gap={2}>
          <Text as="h4" variant="body-sm" weight="semibold">
            {t("tracking.events.title")}
          </Text>
          {events.length > 0 ? (
            <Timeline items={events} />
          ) : (
            <Text variant="body-sm" tone="subdued">
              {t("tracking.events.empty")}
            </Text>
          )}
        </Stack>
      ) : null}
    </Stack>
  );
}

/** Документи перевізника (PDF через fetch) і комерційний інвойс застосунку для друку. */
function DocumentsSection({ shipment: s, orderId }: { shipment: Shipment; orderId: string }) {
  const t = useT();
  const href = useHref();
  return (
    <Stack gap={2}>
      <Text as="h3" variant="heading-sm">
        {t("tracking.documents.title")}
      </Text>
      {s.documents.length > 0 ? (
        <>
          <CarrierDocumentButtons orderId={orderId} shipmentId={s.id} kinds={s.documents} />
          <Text variant="caption" tone="subdued">
            {t("tracking.documents.help")}
          </Text>
        </>
      ) : (
        <Text variant="body-sm" tone="subdued">
          {t("tracking.documents.none")}
        </Text>
      )}
      <Stack direction="horizontal" gap={2}>
        <Button size="sm" to={href(`orders/${orderId}/invoice`)}>
          {t("tracking.documents.appInvoice")}
        </Button>
      </Stack>
    </Stack>
  );
}

/**
 * Етап 4: «Переоформити накладну» (скасування + нове покоління одразу) і «Скасувати й виправити дані»
 * (лише скасування). Обидві дії — з підтвердженням: реальну накладну буде скасовано у перевізника.
 */
function ChangeWaybillSection({ shipment: s, order, shopifyChanged }: { shipment: Shipment; order: OrderData; shopifyChanged: boolean }) {
  const t = useT();
  const can = useCan();
  const busy = useBusy();
  const params = { number: s.waybillNumber ?? "", carrier: s.carrierName };
  const kind = s.manual ? "Manual" : s.mode === "test" ? "Test" : "Live";
  const canReissue = s.reissuable && can("waybills.create");
  let reissueNote: string | null = null;
  if (!s.reissuable) reissueNote = t("order.reissue.unavailable.status");
  else if (!can("waybills.create")) reissueNote = t("order.reissue.unavailable.permission");

  return (
    <Stack gap={3}>
      <Stack gap={1}>
        <Text as="h3" variant="heading-sm">
          {t("order.reissue.section")}
        </Text>
        <Text variant="body-sm" tone="subdued">
          {t("order.reissue.sectionHelp")}
        </Text>
      </Stack>
      {/* Кнопки переносяться на новий рядок на вузькому екрані (без горизонтальної прокрутки). */}
      <Stack direction="horizontal" gap={2} wrap>
        {canReissue ? (
          <Form method="post">
            <Hidden
              intent="reissueWaybill"
              fields={{ shipmentId: s.id, trigger: shopifyChanged ? "shopify_changed" : "order_page" }}
            />
            <ConfirmSubmitButton
              variant="primary"
              loading={busy("reissueWaybill")}
              title={t("order.reissue.title", params)}
              confirmLabel={t("order.reissue.confirm")}
              cancelLabel={t("order.dialog.keep")}
              message={
                <Stack gap={2}>
                  <Text weight={kind === "Live" ? "semibold" : undefined}>{t(`order.reissue.body${kind}`, params)}</Text>
                  <Text>{t("order.reissue.dataNote")}</Text>
                  <Text variant="body-sm" tone="subdued">
                    {t("order.reissue.labelsNote")}
                  </Text>
                </Stack>
              }
            >
              {t("order.reissue.button")}
            </ConfirmSubmitButton>
          </Form>
        ) : null}
        <Form method="post">
          <Hidden intent="cancelWaybill" fields={{ shipmentId: s.id, purpose: "correction" }} />
          <ConfirmSubmitButton
            variant="critical"
            loading={busy("cancelWaybill")}
            title={t("order.correct.title", params)}
            confirmLabel={t("order.correct.confirm")}
            cancelLabel={t("order.dialog.keep")}
            message={
              <Stack gap={2}>
                <Text weight={kind === "Live" ? "semibold" : undefined}>{t(`order.correct.body${kind}`, params)}</Text>
                <Text>{t("order.correct.next")}</Text>
                <Text variant="body-sm" tone="subdued">
                  {t("order.reissue.labelsNote")}
                </Text>
              </Stack>
            }
          >
            {t("order.correct.button")}
          </ConfirmSubmitButton>
        </Form>
      </Stack>
      {reissueNote ? (
        <Text variant="body-sm" tone="subdued">
          {reissueNote}
        </Text>
      ) : null}
    </Stack>
  );
}

/** Дані змінено в Shopify, коли накладна вже існує: як застосувати (лише через переоформлення). */
function ShopifyChangedHint({ issue, shipment: s, data }: { issue: Issue; shipment: Shipment; data: Data }) {
  const t = useT();
  const raw = typeof issue.params.fields === "string" ? issue.params.fields : "";
  const fields = raw
    .split(",")
    .map((f) => f.trim())
    .filter(Boolean)
    .map((f) => fieldLabel(f, data.items, t) ?? f)
    .join(", ");
  const shipped = isShipped(data.order.status) || Boolean(s.handedOverAt);
  return (
    <Banner tone="warning" title={t("order.shopifyChanged.title")}>
      <p>{t("order.shopifyChanged.body", { fields: fields || "—" })}</p>
      <p>{t(shipped ? "order.shopifyChanged.shipped" : "order.shopifyChanged.how")}</p>
    </Banner>
  );
}

// ---------------------------------------------------------------------------
// Синхронізація виправлених даних із Shopify (етап 4)
// ---------------------------------------------------------------------------

function ShopifySyncCard({ data }: { data: Data }) {
  const t = useT();
  const locale = useLocale();
  const can = useCan();
  const busy = useBusy();
  const p = data.shopifyPush;
  if (p.state === "none") return null;
  if ((p.state === "demo" || p.state === "not_linked") && !p.hasChanges) return null;

  const time = (d: Date | null) => formatDateTime(d, locale);
  const lines: { key: string; text: string; tone?: "critical" | "subdued" }[] = [];
  let tone: "info" | "success" | "warning" | "critical" = "info";
  switch (p.state) {
    case "demo":
      lines.push({ key: "state", text: t("order.shopifySync.state.demo") });
      break;
    case "not_linked":
      lines.push({ key: "state", text: t("order.shopifySync.state.not_linked") });
      break;
    case "queued":
      lines.push({ key: "state", text: t(p.retrying ? "order.shopifySync.state.retrying" : "order.shopifySync.state.queued", { time: time(p.at) }) });
      if (p.lastError) lines.push({ key: "err", text: t("order.shopifySync.lastError", { message: p.lastError }), tone: "subdued" });
      tone = p.retrying ? "warning" : "info";
      break;
    case "synced":
      lines.push({ key: "state", text: t("order.shopifySync.state.synced", { time: time(p.at) }) });
      tone = "success";
      break;
    case "failed":
      lines.push({ key: "state", text: t("order.shopifySync.state.failed") });
      if (p.failures.length === 0 && p.lastError) {
        lines.push({ key: "err", text: t("order.shopifySync.lastError", { message: p.lastError }), tone: "critical" });
      }
      tone = "critical";
      break;
    case "not_sent":
      lines.push({ key: "state", text: t("order.shopifySync.state.not_sent", { time: time(p.lastChangeAt) }) });
      lines.push({ key: "help", text: t("order.shopifySync.state.not_sentHelp"), tone: "subdued" });
      tone = "warning";
      break;
  }
  const failures = p.state === "failed" || p.state === "queued" ? p.failures : [];
  for (const [index, f] of failures.entries()) {
    const label = fieldLabel(f.field, data.items, t);
    let text: string;
    if (f.code === "SHOPIFY_COUNTRY_NOT_SHIPPED") {
      text = t("order.shopifySync.countryNotShipped", { country: String(f.params.country ?? "—") });
    } else {
      // Текст Shopify показуємо як є (без перекладу) — так власник бачить точну причину.
      const message = f.message ?? t("issue.SHOPIFY_SYNC_FAILED.title");
      text = label ? t("order.shopifySync.fieldMessage", { field: label, message }) : t("order.shopifySync.shopifyMessage", { message });
    }
    lines.push({ key: `f${index}`, text, tone: "critical" });
  }

  const resendable = p.state === "failed" || p.state === "not_sent" || p.state === "demo";
  const canResend = resendable && can("orders.edit") && data.order.status !== "cancelled";
  return (
    <Card title={t("order.shopifySync.title")}>
      <Stack gap={3}>
        <Text variant="body-sm" weight="semibold">
          {t("order.shopifySync.label")}
        </Text>
        <Banner tone={tone}>
          {lines.map((l) => (
            <p key={l.key}>{l.text}</p>
          ))}
        </Banner>
        {canResend ? (
          <Form method="post">
            <Hidden intent="resendShopify" />
            <Stack gap={2}>
              <Stack direction="horizontal" gap={2} wrap>
                <Button type="submit" loading={busy("resendShopify")}>
                  {t("order.shopifySync.resend")}
                </Button>
              </Stack>
              <Text variant="body-sm" tone="subdued">
                {t(p.state === "demo" ? "order.shopifySync.resendDemoHelp" : "order.shopifySync.resendHelp")}
              </Text>
            </Stack>
          </Form>
        ) : null}
      </Stack>
    </Card>
  );
}

function UnknownWaybill({ shipment: s }: { shipment: Shipment }) {
  const t = useT();
  const can = useCan();
  const busy = useBusy();
  return (
    <Stack gap={4}>
      <Banner tone="critical" title={t("order.waybill.unknown.title")}>
        <p>{t(s.stale ? "order.waybill.stale.body" : "order.waybill.unknown.body")}</p>
        <p>{t("order.issues.carrierReference", { reference: s.carrierReference })}</p>
      </Banner>
      <KeyValueList
        items={[
          { key: "status", label: t("order.waybill.title"), value: <ShipmentStatusBadge status={s.status} /> },
          { key: "carrier", label: t("order.waybill.carrier"), value: carrierLabel(s.carrierName, s.mode, t) },
          { key: "attempts", label: t("order.waybill.attempts"), value: s.attempts },
          { key: "updated", label: t("order.waybill.createdAt"), value: <TimeText value={s.createdAt} /> },
        ]}
      />
      {can("waybills.create") ? (
        s.canLookup ? (
          <Form method="post">
            <Hidden intent="reconcile" fields={{ shipmentId: s.id }} />
            <Button type="submit" variant="primary" loading={busy("reconcile")}>
              {t("order.waybill.reconcile")}
            </Button>
          </Form>
        ) : (
          <Text variant="body-sm" tone="subdued">
            {t("order.waybill.reconcileUnsupported")}
          </Text>
        )
      ) : null}
      {can("waybills.manage") ? (
        <>
          <Divider />
          <Form method="post">
            <Hidden intent="linkWaybill" />
            <Stack gap={3}>
              <Text as="h3" variant="heading-sm">
                {t("order.waybill.link.title")}
              </Text>
              <TextField
                id="order-link-waybill"
                name="waybillNumber"
                label={t("order.waybill.number")}
                helpText={t("order.waybill.link.help")}
                required
                maxLength={40}
                pattern="[A-Za-z0-9\-]{6,40}"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
              />
              <Stack direction="horizontal" gap={2}>
                <Button type="submit" loading={busy("linkWaybill")}>
                  {t("order.waybill.link.submit")}
                </Button>
              </Stack>
            </Stack>
          </Form>
          <Form method="post">
            <Hidden intent="confirmNotCreated" fields={{ shipmentId: s.id }} />
            <ConfirmSubmitButton
              variant="critical"
              loading={busy("confirmNotCreated")}
              title={t("order.waybill.notCreated.title")}
              confirmLabel={t("order.waybill.notCreated.confirm")}
              cancelLabel={t("order.dialog.keep")}
              message={
                <Stack gap={2}>
                  <Text>{t("order.waybill.notCreated.body", { reference: s.carrierReference })}</Text>
                  <Text weight="semibold">{t("order.waybill.notCreated.risk")}</Text>
                </Stack>
              }
            >
              {t("order.waybill.notCreated.button")}
            </ConfirmSubmitButton>
          </Form>
        </>
      ) : null}
    </Stack>
  );
}

function CreatingWaybill({ order }: { order: OrderData }) {
  const t = useT();
  const href = useHref();
  return (
    <Banner
      tone="info"
      title={t("order.waybill.creating.title")}
      action={<Button to={href(`orders/${order.id}`)}>{t("order.waybill.refresh")}</Button>}
    >
      {t("order.waybill.creating.body")}
    </Banner>
  );
}

function NoWaybill({ data }: { data: Data }) {
  const t = useT();
  const can = useCan();
  const href = useHref();
  const busy = useBusy();
  const { order, carrier, missingShipperFields } = data;

  if (order.status === "cancelled") {
    return <Text tone="subdued">{t("order.waybill.blocked.cancelled")}</Text>;
  }

  const setup: ReactNode[] = [];
  if (missingShipperFields.length > 0) {
    setup.push(
      <Banner
        key="shipper"
        tone="warning"
        title={t("order.waybill.blocked.shipper.title")}
        action={
          can("settings.view") ? <Button to={href("settings")}>{t("order.waybill.blocked.shipper.link")}</Button> : undefined
        }
      >
        <p>
          {t("order.waybill.blocked.shipper.body", {
            fields: missingShipperFields.map((f) => t(`order.waybill.shipperField.${f}`)).join(", "),
          })}
        </p>
        {!can("settings.view") ? <p>{t("order.waybill.blocked.shipper.askOwner")}</p> : null}
      </Banner>,
    );
  }
  if (!carrier) {
    setup.push(
      <Banner key="carrier" tone="info">
        {t("order.waybill.blocked.noCarrier")}
      </Banner>,
    );
  } else if (!carrier.canCreate) {
    setup.push(
      carrier.isNovaPost ? (
        // Nova Post: реальні накладні вимкнено, доки власник свідомо не ввімкне їх змінною середовища.
        <Banner key="carrier" tone="info" title={t("tracking.waybill.novaPostDisabled.title", { carrier: carrier.displayName })}>
          <p>{t("tracking.waybill.novaPostDisabled.body")}</p>
          <p>{t("tracking.waybill.novaPostDisabled.owner")}</p>
        </Banner>
      ) : (
        <Banner key="carrier" tone="info" title={t("order.waybill.blocked.notConfigured.title", { carrier: carrier.displayName })}>
          {t("order.waybill.blocked.notConfigured.body")}
        </Banner>
      ),
    );
  }

  let next: ReactNode;
  if (order.status === "needs_correction") {
    next = <Text variant="body-sm">{t("order.waybill.blocked.needsCorrection")}</Text>;
  } else if (order.status === "paid") {
    next = <Text variant="body-sm">{t("order.waybill.blocked.notValidated")}</Text>;
  } else if (order.status !== "awaiting_review") {
    next = <Text variant="body-sm">{t("order.waybill.blocked.status", { status: t(`status.${order.status}`) })}</Text>;
  } else if (!can("waybills.create")) {
    next = (
      <Text variant="body-sm" tone="subdued">
        {t("order.waybill.blocked.permission")}
      </Text>
    );
  } else if (setup.length === 0 && carrier) {
    const isTest = carrier.mode === "test";
    next = (
      <Form method="post">
        <Hidden intent="createWaybill" />
        <Stack gap={2}>
          {isTest ? (
            <Button type="submit" variant="primary" loading={busy("createWaybill")}>
              {t("order.waybill.create.test")}
            </Button>
          ) : (
            <ConfirmSubmitButton
              variant="primary"
              loading={busy("createWaybill")}
              title={t("order.waybill.create.liveTitle", { carrier: carrier.displayName })}
              confirmLabel={t("order.waybill.create.live")}
              cancelLabel={t("common.cancel")}
              message={
                <Stack gap={2}>
                  <Text>{t("order.waybill.create.liveBody")}</Text>
                  <Text weight="semibold">{t("order.waybill.create.notShipped")}</Text>
                </Stack>
              }
            >
              {t("order.waybill.create.live")}
            </ConfirmSubmitButton>
          )}
          <Text variant="body-sm" tone="subdued">
            {isTest ? `${t("order.waybill.create.testHelp")} ${t("order.waybill.create.notShipped")}` : t("order.waybill.create.notShipped")}
          </Text>
        </Stack>
      </Form>
    );
  }

  return (
    <Stack gap={3}>
      <Text tone="subdued">{t("order.waybill.none")}</Text>
      {setup}
      {next}
    </Stack>
  );
}

function PreviousShipments({ shipments }: { shipments: Shipment[] }) {
  const t = useT();
  const locale = useLocale();
  return (
    <Stack gap={3}>
      <Divider />
      <Text as="h3" variant="heading-sm">
        {t("order.waybill.previous.title")}
      </Text>
      <Stack as="ul" gap={3}>
        {shipments.map((s) => (
          <Stack as="li" key={s.id} gap={1}>
            <Stack direction="horizontal" gap={2} align="center">
              <ShipmentStatusBadge status={s.status} />
              {s.mode === "test" ? <TestBadge /> : null}
              {s.waybillNumber ? <InlineCode>{s.waybillNumber}</InlineCode> : null}
            </Stack>
            <Text variant="body-sm">{t("order.issues.carrierReference", { reference: s.carrierReference })}</Text>
            <Text variant="caption" tone="subdued">
              {t("order.waybill.previous.meta", { generation: s.generation, attempts: s.attempts })}
              {" · "}
              {formatDateTime(s.updatedAt, locale)}
            </Text>
            {s.lastError ? (
              <Text variant="body-sm" tone="subdued">
                {t("order.waybill.previous.error", { error: codeText(s.lastError, t) })}
              </Text>
            ) : null}
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// 7. Підсумок
// ---------------------------------------------------------------------------

function SummaryCard({ order }: { order: OrderData }) {
  const t = useT();
  const locale = useLocale();
  const money = (amount: string) => (
    <Text as="span" numeric>
      {formatMoney(amount, order.currency, locale)}
    </Text>
  );
  const items: KeyValueItem[] = [
    { key: "placed", label: t("order.summary.placedAt"), value: <TimeText value={order.placedAt} /> },
    { key: "subtotal", label: t("order.summary.subtotal"), value: money(order.subtotal) },
    { key: "shipping", label: t("order.summary.shipping"), value: money(order.shippingPaid) },
    {
      key: "total",
      label: t("order.summary.total"),
      value: (
        <Text as="span" numeric weight="semibold">
          {formatMoney(order.total, order.currency, locale)}
        </Text>
      ),
    },
    ...(order.lastValidatedAt
      ? [{ key: "validated", label: t("order.summary.lastValidated"), value: <TimeText value={order.lastValidatedAt} /> }]
      : []),
    ...(order.cancelledAt
      ? [{ key: "cancelled", label: t("order.summary.cancelledAt"), value: <TimeText value={order.cancelledAt} /> }]
      : []),
    ...(order.note ? [{ key: "note", label: t("order.summary.note"), value: order.note }] : []),
    {
      key: "source",
      label: t("order.summary.source"),
      value: t(order.source === "demo" ? "order.summary.source.demo" : "order.summary.source.shopify"),
    },
  ];
  return (
    <Card title={t("order.summary.title")}>
      <KeyValueList items={items} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// 8. Історія
// ---------------------------------------------------------------------------

const EVENT_TONE: Record<string, TimelineItem["tone"]> = {
  created: "success",
  recovered: "success",
  manually_linked: "success",
  rejected: "critical",
  outcome_unknown: "critical",
  manual_review_required: "critical",
  not_created: "warning",
  confirmed_not_created: "warning",
  confirmed_not_created_manually: "warning",
  cancelled: "warning",
  handed_over: "success",
  shopify_fulfilled: "success",
};
const EVENT_WITH_NUMBER = new Set(["created", "recovered", "manually_linked", "cancelled", "handed_over"]);

/** Повідомлення події: джерело передачі, результат передачі в Shopify або службовий код накладної. */
function eventMessageText(type: string, message: string, t: TFunction): string {
  const key =
    type === "handed_over" ? `tracking.handover.source.${message}` : type === "shopify_fulfilled" ? `tracking.shopify.outcome.${message}` : null;
  if (key) return hasKey(key) ? t(key) : message;
  return codeText(message, t);
}

function HistoryCard({ data }: { data: Data }) {
  const t = useT();
  const { changes, events, resolvedIssues } = data.history;
  const empty = t("order.history.emptyValue");
  const actorLabel = (actor: (typeof changes)[number]["actor"]) =>
    actor === "owner" || actor === "staff" ? t(`role.${actor}`) : t(`order.history.actor.${actor}`);

  const entries: { item: TimelineItem; at: number }[] = [
    ...changes.map((c) => {
      const reason = reasonText(c.reason, t);
      const description = [
        t(`order.history.source.${c.source}`),
        reason ? t("order.history.reason", { reason }) : null,
        t("order.history.by", { actor: actorLabel(c.actor) }),
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        at: c.createdAt.getTime(),
        item: {
          id: `change-${c.id}`,
          title: t("order.history.change", {
            field: fieldLabel(c.field, data.items, t) ?? c.field,
            from: c.oldValue ?? empty,
            to: c.newValue ?? empty,
          }),
          description,
          time: <TimeText value={c.createdAt} />,
          tone: c.source === "suggestion_accepted" ? ("success" as const) : ("default" as const),
        },
      };
    }),
    ...events.map((e) => {
      const key = `order.event.${e.type}`;
      const parts = [
        e.waybillNumber && EVENT_WITH_NUMBER.has(e.type) ? t("order.history.waybill", { number: e.waybillNumber }) : null,
        e.trackingStatus ? t(`tracking.status.${e.trackingStatus}`) : null,
        e.message ? eventMessageText(e.type, e.message, t) : null,
      ].filter(Boolean);
      return {
        at: e.createdAt.getTime(),
        item: {
          id: `event-${e.id}`,
          title: hasKey(key) ? t(key) : t("order.event.other", { type: e.type }),
          description: parts.length > 0 ? parts.join(" · ") : undefined,
          time: <TimeText value={e.createdAt} />,
          tone: EVENT_TONE[e.type] ?? "default",
        },
      };
    }),
    ...resolvedIssues.map((i) => {
      const resolutionKey = `order.history.resolution.${i.resolution ?? ""}`;
      const title = t(`issue.${i.code}.title`);
      return {
        at: i.at.getTime(),
        item: {
          id: `issue-${i.id}`,
          title: t(i.status === "dismissed" ? "order.history.issueDismissed" : "order.history.issueResolved", { title }),
          description: i.resolution && hasKey(resolutionKey) ? t(resolutionKey) : undefined,
          time: <TimeText value={i.at} />,
          tone: i.status === "dismissed" ? ("default" as const) : ("success" as const),
        },
      };
    }),
  ];
  entries.sort((a, b) => b.at - a.at);

  return (
    <Card title={t("order.history.title")}>
      {entries.length === 0 ? (
        <Text tone="subdued">{t("order.history.empty")}</Text>
      ) : (
        <Timeline items={entries.map((e) => e.item)} />
      )}
    </Card>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

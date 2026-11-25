import { useState, type ReactNode } from "react";
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
import { useCan, useHref } from "~/components/shell";
import { OrderStatusBadge, SeverityBadge, ShipmentStatusBadge, TestBadge } from "~/components/status-badge";
import { isShipped } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { hasKey, makeT, useLocale, useT, type TFunction } from "~/i18n";
import { NotFoundError } from "~/lib/errors";
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
import { REQUIRED_SHIPPER_FIELDS } from "~/modules/settings/schema";
import { getSettings } from "~/modules/settings/settings.server";
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
 * Уся бізнес-логіка — у сервісах (orders/workflow, shipments/waybill); тут лише виклики та відображення.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CANDIDATE_LENGTH = 64;
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

const CUSTOMS_FIELDS = ["weightGrams", "hsCode", "countryOfOrigin", "customsDescription"] as const;

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
  const [history, ruleRows, settings] = await Promise.all([
    loadOrderHistory(ctx.db, orderId),
    loadCountryRuleRows(ctx.db),
    getSettings(ctx.db),
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
          }
        : null,
    })),
    openIssues,
    shipments: agg.shipments.map((s) => {
      const adapter = ctx.carriers.get(s.carrierCode);
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
      events: history.events.map(({ event, waybillNumber }) => ({
        id: event.id,
        type: event.type,
        message: event.message,
        waybillNumber,
        createdAt: event.createdAt,
      })),
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
          displayName: carrier.displayName,
          mode: carrier.mode,
          canCreate: carrier.capabilities.createShipment,
        }
      : null,
    /** Лише назви незаповнених полів відправника — без значень. */
    missingShipperFields: REQUIRED_SHIPPER_FIELDS.filter((f) => !String(settings.shipper[f] ?? "").trim()),
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

function syncKey(sync: NonNullable<Awaited<ReturnType<typeof updateOrderData>>["sync"]>): string {
  if (sync.status === "synced") return "sync.synced";
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
    const ownShipmentId = async () => {
      const id = uuidField(form, "shipmentId");
      if (!id) return null;
      const { shipments } = await aggregate();
      return shipments.some((s) => s.id === id) ? id : null;
    };
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
        const weightRaw = formString(form, "weightGrams").trim();
        try {
          const r = await updateVariantCustomsData(ctx, variantId, {
            weightGrams: weightRaw === "" ? null : Number(weightRaw),
            hsCode: formString(form, "hsCode"),
            countryOfOrigin: formString(form, "countryOfOrigin"),
            customsDescription: formString(form, "customsDescription"),
          });
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
        await cancelWaybill(ctx, shipmentId);
        return { ok: true, message: "result.waybill.cancelled" };
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
            <AddressCard data={data} fieldErrors={fieldErrors} />
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
      <Text variant="body-sm">{t(`issue.${issue.code}.help`, issue.params)}</Text>

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

      {(issue.severity === "warning" || issue.code === "CARRIER_REJECTED") && canEdit ? (
        <Form method="post">
          <Hidden intent="dismissIssue" fields={{ issueId: issue.id }} />
          <Button type="submit" variant="plain" size="sm" loading={busy("dismissIssue", ["issueId", issue.id])}>
            {issue.code === "CARRIER_REJECTED" ? t("order.issues.retryAsIs") : t("order.issues.dismiss")}
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
    const titles = issues.filter((i) => i.field === name).map((i) => t(`issue.${i.code}.title`));
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
  const { items, isDemo } = data;
  const units = items.reduce((sum, i) => sum + i.quantity, 0);
  // Дані товару змінюємо лише поки замовлення можна перевіряти (після накладної — спершу скасувати її).
  const canEditCustoms = isDemo && can("orders.edit") && data.order.editable;
  const seenVariants = new Set<string>();

  return (
    <Card title={t("order.items.title")} description={t("order.items.summary", { lines: items.length, units })}>
      <Stack gap={4}>
        <Stack as="ul" gap={4}>
          {items.map((item, index) => {
            const v = item.variant;
            const firstOfVariant = v ? !seenVariants.has(v.id) : false;
            if (v) seenVariants.add(v.id);
            const kv: KeyValueItem[] = v
              ? [
                  { key: "sku", label: t("order.items.sku"), value: item.sku ? <InlineCode>{item.sku}</InlineCode> : <Missing /> },
                  {
                    key: "weight",
                    label: t("order.items.weight"),
                    value: v.weightGrams !== null ? formatWeight(v.weightGrams, locale) : <Missing critical />,
                  },
                  { key: "hs", label: t("field.variant.hsCode"), value: v.hsCode ? <InlineCode>{v.hsCode}</InlineCode> : <Missing critical /> },
                  {
                    key: "origin",
                    label: t("field.variant.countryOfOrigin"),
                    value: v.countryOfOrigin ? (
                      <Stack as="span" direction="horizontal" gap={1} align="center">
                        <InlineCode>{v.countryOfOrigin}</InlineCode>
                        {v.originName ? <span>{v.originName}</span> : null}
                      </Stack>
                    ) : (
                      <Missing critical />
                    ),
                  },
                  {
                    key: "description",
                    label: t("field.variant.customsDescription"),
                    value: v.customsDescription ? v.customsDescription : <Missing critical />,
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
                  <CustomsEditor variant={v} openIssues={data.openIssues} fieldErrors={fieldErrors} />
                ) : null}
              </Stack>
            );
          })}
        </Stack>
        {!isDemo ? (
          <Text variant="body-sm" tone="subdued">
            {t("order.items.editInShopify")}
          </Text>
        ) : null}
      </Stack>
    </Card>
  );
}

function CustomsEditor({
  variant,
  openIssues,
  fieldErrors,
}: {
  variant: NonNullable<Item["variant"]>;
  openIssues: Issue[];
  fieldErrors: FieldErrors;
}) {
  const t = useT();
  const busy = useBusy();
  const prefix = `variant.${variant.id}.`;
  const hasIssue = openIssues.some((i) => i.field?.startsWith(prefix));
  const hasFieldError = Object.keys(fieldErrors ?? {}).some((k) => k.startsWith(prefix));
  const errorFor = (field: (typeof CUSTOMS_FIELDS)[number]): string | null => {
    if (fieldErrors?.[`${prefix}${field}`]) return t("order.address.fieldInvalid");
    const titles = openIssues.filter((i) => i.field === `${prefix}${field}`).map((i) => t(`issue.${i.code}.title`));
    return titles.length > 0 ? titles.join("; ") : null;
  };
  const id = (field: string) => `variant-${variant.id}-${field}`;
  // Нова версія даних товару → поля створюються заново зі збереженими значеннями.
  const formKey = [variant.weightGrams, variant.hsCode, variant.countryOfOrigin, variant.customsDescription].join("|");

  return (
    <details open={hasIssue || hasFieldError || undefined}>
      <summary>
        <Text as="span" variant="body-sm" weight="semibold">
          {t("order.items.customs.edit")}
        </Text>
      </summary>
      <Form method="post" key={formKey}>
        <Hidden intent="updateVariant" fields={{ variantId: variant.id }} />
        <Stack gap={3}>
          <Text variant="body-sm" tone="subdued">
            {t("order.items.customs.help")}
          </Text>
          <FormLayout columns={2}>
            <TextField
              id={id("weightGrams")}
              name="weightGrams"
              type="number"
              min={1}
              max={30000}
              step={1}
              inputMode="numeric"
              label={t("field.variant.weightGrams")}
              defaultValue={variant.weightGrams ?? ""}
              error={errorFor("weightGrams")}
            />
            <TextField
              id={id("hsCode")}
              name="hsCode"
              label={t("field.variant.hsCode")}
              helpText={t("order.items.customs.hsHelp")}
              defaultValue={variant.hsCode ?? ""}
              error={errorFor("hsCode")}
              maxLength={20}
              spellCheck={false}
              autoComplete="off"
            />
            <TextField
              id={id("countryOfOrigin")}
              name="countryOfOrigin"
              label={t("field.variant.countryOfOrigin")}
              helpText={t("order.items.customs.originHelp")}
              defaultValue={variant.countryOfOrigin ?? ""}
              error={errorFor("countryOfOrigin")}
              maxLength={2}
              autoCapitalize="characters"
              spellCheck={false}
              autoComplete="off"
            />
            <TextField
              id={id("customsDescription")}
              name="customsDescription"
              label={t("field.variant.customsDescription")}
              helpText={t("order.items.customs.descriptionHelp")}
              defaultValue={variant.customsDescription ?? ""}
              error={errorFor("customsDescription")}
              maxLength={200}
              autoComplete="off"
            />
          </FormLayout>
          <Stack direction="horizontal" gap={2}>
            <Button type="submit" loading={busy("updateVariant", ["variantId", variant.id])}>
              {t("order.items.customs.save")}
            </Button>
          </Stack>
        </Stack>
      </Form>
    </details>
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
  if (active?.status === "created") body = <CreatedWaybill shipment={active} order={data.order} />;
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

function CreatedWaybill({ shipment: s, order }: { shipment: Shipment; order: OrderData }) {
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

  return (
    <Stack gap={3}>
      <Stack direction="horizontal" gap={2} align="center">
        <ShipmentStatusBadge status={s.status} />
        {s.mode === "test" ? <TestBadge /> : null}
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
      {canCancel && (s.manual || s.canCancel) ? (
        <Form method="post">
          <Hidden intent="cancelWaybill" fields={{ shipmentId: s.id }} />
          <ConfirmSubmitButton
            variant="critical"
            loading={busy("cancelWaybill")}
            title={t("order.waybill.cancel.title", { number: s.waybillNumber ?? "" })}
            confirmLabel={t("order.waybill.cancel.confirm")}
            cancelLabel={t("order.dialog.keep")}
            message={
              <Stack gap={2}>
                <Text>{t(s.manual ? "order.waybill.cancel.bodyManual" : "order.waybill.cancel.body")}</Text>
                <Text weight="semibold">{t("order.waybill.cancel.regenerate")}</Text>
              </Stack>
            }
          >
            {t("order.waybill.cancel.button")}
          </ConfirmSubmitButton>
        </Form>
      ) : null}
      {canCancel && !s.manual && !s.canCancel ? (
        <Text variant="body-sm" tone="subdued">
          {t("order.waybill.cancel.unsupported")}
        </Text>
      ) : null}
    </Stack>
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
      <Banner key="carrier" tone="info" title={t("order.waybill.blocked.notConfigured.title", { carrier: carrier.displayName })}>
        {t("order.waybill.blocked.notConfigured.body")}
      </Banner>,
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
};
const EVENT_WITH_NUMBER = new Set(["created", "recovered", "manually_linked", "cancelled"]);

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
        e.message ? codeText(e.message, t) : null,
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

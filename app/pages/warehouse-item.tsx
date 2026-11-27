import { useEffect, useState, type ReactNode } from "react";
import { Form, Link, useActionData, useLoaderData, useNavigation, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { useCan, useHref } from "~/components/shell";
import { OrderStatusBadge } from "~/components/status-badge";
import { can, requirePermission, type Permission } from "~/domain/permissions";
import { hasKey, useLocale, useT, type Locale, type TFunction } from "~/i18n";
import { formatDateTime, formatMoney, formatNumber } from "~/lib/format";
import type { StockLevelStatus } from "~/modules/inventory/alerts";
import { ensureStockItemForMaterial, ensureStockItemForVariant, movementHistory, type MovementView } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { returnOrderSuggestions } from "~/modules/inventory-sync/returns.server";
import { MATERIAL_CONSUMPTION_DAYS, loadMaterialConsumption, materialDaysLeft } from "~/modules/packaging/materials.server";
import { getSetting } from "~/modules/settings/settings.server";
import {
  DEFAULT_COST_CURRENCY,
  DEFECT_REASONS,
  ITEM_RECENT_MOVEMENTS,
  MAX_COUNTED_QUANTITY,
  MAX_NOTE_LENGTH,
  MAX_OPERATION_QUANTITY,
  MAX_THRESHOLD,
  ORDER_LINKED_REASONS,
  RECEIPT_REASONS,
  SHOPIFY_RESTOCK_REASONS,
  UUID_RE,
  WAREHOUSE_RELATED_LINKS,
  WAREHOUSE_SECTION_LINKS,
  WRITE_OFF_REASONS,
  displayVariantTitle,
  parseFormInt,
  type DefectReason,
  type ReceiptReason,
  type StockTrackingState,
  type WriteOffReason,
} from "~/modules/warehouse/constants";
import { movementDeltaParts, reasonKey, signedNumber } from "~/modules/warehouse/format";
import { findOrderByNumber } from "~/modules/warehouse/lookup.server";
import {
  OPERATION_PERMISSIONS,
  adjustToCount,
  markDefective,
  newOperationId,
  receiveStock,
  repairDefective,
  setLowStockThreshold,
  writeOffDefective,
  type OperationResult,
} from "~/modules/warehouse/operations.server";
import { getStockItemCard, lastStocktake, listItemAlerts, listItemReservations } from "~/modules/warehouse/stock.server";
import { getRequestContext } from "~/server/context.server";
import { shopifySyncStateForDisplay } from "~/modules/inventory/movement-types";
import { formString, toActionError } from "~/server/http.server";
import {
  Badge,
  Banner,
  Button,
  Card,
  Checkbox,
  ConfirmSubmitButton,
  DataTable,
  Disclosure,
  Grid,
  InlineCode,
  KeyValueList,
  Page,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  Timeline,
  type BadgeTone,
  type DataTableColumn,
  type TabItem,
  type TimelineItem,
} from "~/ui";

/**
 * Картка позиції складу (warehouse/items/:stockItemId — id позиції обліку або варіанта без руху):
 * баланси, попередження, резерви за замовленнями, останні рухи й форми операцій (надходження, брак, ремонт,
 * списання браку, інвентаризація, поріг). Кожна форма має власний uuid (ключ ідемпотентності) з loader.
 */

/** Собівартість форматується на сервері: символ гривні в ICU Node і браузера різний (₴ / грн) — без розбіжності гідратації. */
/**
 * Чи надсилаються внутрішні зміни цього товару в Shopify: робочий режим (у демо Shopify не підключено — ledger
 * movementOptionsFor нічого не надсилає), товар, відкритий в обліку, передачу ввімкнено. Одне правило для підказок
 * картки (loader) і для повідомлень після операції (action), щоб у демо не з'являлися тексти про Shopify.
 */
function itemPushesToShopify(
  mode: string,
  card: { kind: string; tracking: string | null },
  shopifyPush: string,
): boolean {
  return mode === "production" && card.kind === "product" && card.tracking === "opened" && shopifyPush === "deltas";
}

function serializeMovement(m: MovementView, locale: Locale, mode: "demo" | "production") {
  return {
    id: m.id,
    createdAt: m.createdAt.toISOString(),
    type: m.type,
    onHandDelta: m.onHandDelta,
    reservedDelta: m.reservedDelta,
    defectiveDelta: m.defectiveDelta,
    inProductionDelta: m.inProductionDelta,
    orderId: m.orderId,
    orderNumber: m.orderNumber,
    batchNumber: m.batchNumber,
    reason: m.reason,
    note: m.note,
    actorName: m.actorName,
    shopifySyncState: shopifySyncStateForDisplay(mode, m.shopifySyncState),
    unitCost: m.unitCost,
    costCurrency: m.costCurrency,
    unitCostText: m.unitCost && m.costCurrency ? formatMoney(m.unitCost, m.costCurrency, locale) : null,
  };
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const id = (params.stockItemId ?? "").toLowerCase();
  if (!UUID_RE.test(id)) throw new Response("Not Found", { status: 404 });
  const card = await getStockItemCard(ctx.db, id);
  if (!card) throw new Response("Not Found", { status: 404 });
  const includeCosts = can(ctx.actor, "finance.view");
  const warehouse = await getDefaultWarehouse(ctx.db);
  const settings = await getSetting(ctx.db, "warehouse");
  const sid = card.stockItemId;
  const [alerts, reservations, history, last] = sid
    ? await Promise.all([
        listItemAlerts(ctx.db, sid),
        listItemReservations(ctx.db, sid),
        movementHistory(ctx.db, { stockItemIds: [sid] }, { limit: ITEM_RECENT_MOVEMENTS }, { includeCosts }),
        lastStocktake(ctx.db, sid),
      ])
    : [[], { rows: [], total: 0, totalQty: 0 }, { rows: [], total: 0 }, null];
  // Матеріал: витрата при пакуванні за 30 днів і на скільки днів вистачить фактичного залишку (як у «Матеріалах»).
  const consumedRecent =
    card.kind === "material" && sid
      ? ((await loadMaterialConsumption(ctx.db, [sid], { warehouseId: warehouse.id, now: ctx.now() })).get(sid) ?? 0)
      : 0;
  const materialUsage =
    card.kind === "material"
      ? { days: MATERIAL_CONSUMPTION_DAYS, consumed: consumedRecent, daysLeft: materialDaysLeft(card.onHand, consumedRecent) }
      : null;
  // Підказки замовлення для повернення покупця (форма надходження): лише номер; посилання — лише з orders.view.
  const canSeeOrders = can(ctx.actor, "orders.view");
  const returnSuggestions =
    sid && card.kind === "product" && can(ctx.actor, "warehouse.receive")
      ? (await returnOrderSuggestions(ctx.db, warehouse.id, sid)).map((s) => ({
          orderNumber: s.orderNumber,
          units: s.units,
          orderId: canSeeOrders ? s.orderId : null,
        }))
      : [];
  return {
    item: {
      ...card,
      // Валюта останньої собівартості — лише власнику (поле собівартості бачить лише finance.view).
      defaultCostCurrency: includeCosts ? card.defaultCostCurrency : DEFAULT_COST_CURRENCY,
      variantTitle: displayVariantTitle(card.variantTitle),
      shopifySyncedAt: card.shopifySyncedAt?.toISOString() ?? null,
      openedAt: card.openedAt?.toISOString() ?? null,
      openingSnapshotAt: card.openingSnapshotAt?.toISOString() ?? null,
      updatedAt: card.updatedAt?.toISOString() ?? null,
    },
    initializedAt: warehouse.inventoryInitializedAt?.toISOString() ?? null,
    alerts: alerts.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
    reservations: {
      total: reservations.total,
      totalQty: reservations.totalQty,
      rows: reservations.rows.map((r) => ({ ...r, placedAt: r.placedAt.toISOString(), updatedAt: r.updatedAt.toISOString() })),
    },
    movements: history.rows.map((r) => serializeMovement(r, ctx.locale, ctx.mode)),
    movementsTotal: history.total,
    lastStocktake: last ? { at: last.at.toISOString(), actorName: last.actorName, delta: last.delta } : null,
    /** Лише для матеріалу: витрата за MATERIAL_CONSUMPTION_DAYS днів і прогноз (днів); для товару — null. */
    materialUsage,
    canSeeCosts: includeCosts,
    /** Робочий режим: позначка розбіжності з Shopify і посилання на звірку. У демо Shopify не оновлюється — лише підказка. */
    isProduction: ctx.mode === "production",
    /** Внутрішні зміни цього товару надсилаються в Shopify (передачу ввімкнено, товар відкрито). */
    // У демо Shopify не підключено: нічого не надсилається (ledger movementOptionsFor), тож і підказок про передачу немає.
    pushesToShopify: itemPushesToShopify(ctx.mode, card, settings.shopifyPush),
    /** Нещодавні повернення в Shopify, яких склад ще не отримав (returns.server.ts) — без звернень до Shopify. */
    returnSuggestions,
    operationIds: {
      receive: newOperationId(),
      defect: newOperationId(),
      repair: newOperationId(),
      writeOff: newOperationId(),
      count: newOperationId(),
    },
  };
}

type ItemIntent = "receive" | "defect" | "repair" | "writeOff" | "count" | "threshold";

const INTENT_PERMISSIONS: Record<ItemIntent, Permission> = {
  receive: OPERATION_PERMISSIONS.receiveStock,
  defect: OPERATION_PERMISSIONS.markDefective,
  repair: OPERATION_PERMISSIONS.repairDefective,
  writeOff: OPERATION_PERMISSIONS.writeOffDefective,
  count: OPERATION_PERMISSIONS.adjustToCount,
  threshold: OPERATION_PERMISSIONS.setLowStockThreshold,
};

const isIntent = (v: string): v is ItemIntent => v in INTENT_PERMISSIONS;

export type ItemActionResult = ActionResult & { intent?: string };

function quantityError(intent: string, field: string, min: number, max: number): ItemActionResult {
  return {
    ok: false,
    intent,
    error: "warehouse.error.quantity",
    params: { min, max },
    fieldErrors: { [field]: "warehouse.error.quantity" },
  };
}

function operationResult(
  intent: string,
  r: OperationResult,
  message: string,
  params: Record<string, string | number>,
  more: string[] = [],
): ItemActionResult {
  if (r.replay) return { ok: true, intent, message: "warehouse.op.replay", tone: "info" };
  const extra = r.openedAlerts.length > 0 ? ["warehouse.op.alertsOpened"] : [];
  if (r.shopifyPushQueued) extra.push("warehouse.op.pushQueued");
  extra.push(...more);
  return {
    ok: true,
    intent,
    message,
    params: {
      ...params,
      onHand: r.balance.onHand,
      available: r.balance.available,
      defective: r.balance.defective,
      alerts: r.openedAlerts.length,
    },
    extra,
    tone: r.openedAlerts.length > 0 ? "warning" : "success",
  };
}

async function orderIdFromForm(ctx: Awaited<ReturnType<typeof getRequestContext>>, form: FormData): Promise<string | null | false> {
  const number = formString(form, "orderNumber").trim();
  if (!number) return null;
  const order = await findOrderByNumber(ctx.db, number);
  return order ? order.id : false;
}

export async function action({ request, params }: ActionFunctionArgs): Promise<ItemActionResult> {
  const ctx = await getRequestContext(request);
  let intent = "";
  try {
    requirePermission(ctx.actor, "warehouse.view");
    const form = await request.formData();
    intent = formString(form, "intent");
    if (!isIntent(intent)) return { ok: false, error: "error.generic" };
    requirePermission(ctx.actor, INTENT_PERMISSIONS[intent]);
    const id = (params.stockItemId ?? "").toLowerCase();
    const card = UUID_RE.test(id) ? await getStockItemCard(ctx.db, id) : null;
    if (!card) return { ok: false, intent, error: "error.notFound" };
    // Варіант/матеріал без руху: позиція обліку створюється з першою операцією.
    const stockItemId =
      card.stockItemId ??
      (card.variantId ? await ensureStockItemForVariant(ctx.db, card.variantId) : await ensureStockItemForMaterial(ctx.db, card.materialId!));
    const operationId = formString(form, "operationId");
    const note = formString(form, "note");

    switch (intent) {
      case "receive": {
        const quantity = parseFormInt(formString(form, "quantity"), 0, MAX_OPERATION_QUANTITY);
        const defective = parseFormInt(formString(form, "defectiveQuantity"), 0, MAX_OPERATION_QUANTITY);
        if (quantity === undefined) return quantityError(intent, "quantity", 0, MAX_OPERATION_QUANTITY);
        if (defective === undefined) return quantityError(intent, "defectiveQuantity", 0, MAX_OPERATION_QUANTITY);
        const orderId = await orderIdFromForm(ctx, form);
        if (orderId === false)
          return {
            ok: false,
            intent,
            error: "warehouse.error.orderNotFound",
            fieldErrors: { orderNumber: "warehouse.error.orderNotFound" },
          };
        const reason = formString(form, "reason") as ReceiptReason;
        // Повернення покупця: за замовчуванням Shopify поповнює сам (не надсилаємо); прапорець — повернення без поповнення.
        const restockedInShopify = !form.has("pushToShopify");
        // Пошкоджені одиниці в Shopify на склад не повертали (лише якісні): у Shopify нічого не знімаємо.
        const damagedRestockedInShopify = !form.has("damagedNotRestocked");
        const r = await receiveStock(ctx, {
          operationId,
          stockItemId,
          quantity: quantity ?? 0,
          defectiveQuantity: defective ?? 0,
          reason,
          orderId,
          restockedInShopify,
          damagedRestockedInShopify,
          unitCost: formString(form, "unitCost") || null,
          costCurrency: formString(form, "costCurrency") || null,
          note,
        });
        // «Повернення не надсилається в Shopify…» — лише коли передача справді діє (не в демо: N3).
        const pushes = itemPushesToShopify(ctx.mode, card, (await getSetting(ctx.db, "warehouse")).shopifyPush);
        const restockReturn = (SHOPIFY_RESTOCK_REASONS as readonly string[]).includes(reason) && restockedInShopify;
        const notPushed = restockReturn && r.shopifySyncState === "skipped" && pushes;
        // Пошкоджені одиниці такого повернення Shopify теж поповнив — їх знімає з «доступно» Shopify окремий рух браку
        // (operations.server.ts). Загальне «Зміну буде надіслано…» поруч із «не надсилається» суперечило б — замість нього.
        const damagedPushed = notPushed && r.returnDefect?.shopifySyncState === "pending";
        // Обрано «пошкоджені в Shopify на склад не повертали»: брак лише на складі, у Shopify нічого не змінюється.
        const damagedKept = restockReturn && !damagedRestockedInShopify && (defective ?? 0) > 0 && !r.returnDefect && pushes;
        const result = operationResult(
          intent,
          r,
          "warehouse.op.received",
          { quantity: quantity ?? 0, damaged: defective ?? 0 },
          [
            ...(notPushed ? ["warehouse.op.returnNotPushed"] : []),
            ...(damagedPushed ? ["warehouse.op.returnDamagedPushed"] : []),
            ...(damagedKept ? ["warehouse.op.returnDamagedKept"] : []),
          ],
        );
        if (damagedPushed && result.ok && result.extra) result.extra = result.extra.filter((k) => k !== "warehouse.op.pushQueued");
        return result;
      }
      case "defect": {
        const quantity = parseFormInt(formString(form, "quantity"), 1, MAX_OPERATION_QUANTITY);
        if (quantity == null) return quantityError(intent, "quantity", 1, MAX_OPERATION_QUANTITY);
        const orderId = await orderIdFromForm(ctx, form);
        if (orderId === false)
          return {
            ok: false,
            intent,
            error: "warehouse.error.orderNotFound",
            fieldErrors: { orderNumber: "warehouse.error.orderNotFound" },
          };
        const r = await markDefective(ctx, {
          operationId,
          stockItemId,
          quantity,
          reason: formString(form, "reason") as DefectReason,
          orderId,
          note,
        });
        return operationResult(intent, r, "warehouse.op.defectMarked", { quantity });
      }
      case "repair": {
        const quantity = parseFormInt(formString(form, "quantity"), 1, MAX_OPERATION_QUANTITY);
        if (quantity == null) return quantityError(intent, "quantity", 1, MAX_OPERATION_QUANTITY);
        const r = await repairDefective(ctx, { operationId, stockItemId, quantity, note });
        return operationResult(intent, r, "warehouse.op.repaired", { quantity });
      }
      case "writeOff": {
        const quantity = parseFormInt(formString(form, "quantity"), 1, MAX_OPERATION_QUANTITY);
        if (quantity == null) return quantityError(intent, "quantity", 1, MAX_OPERATION_QUANTITY);
        const r = await writeOffDefective(ctx, {
          operationId,
          stockItemId,
          quantity,
          reason: formString(form, "reason") as WriteOffReason,
          note,
        });
        return operationResult(intent, r, "warehouse.op.writtenOff", { quantity });
      }
      case "count": {
        const counted = parseFormInt(formString(form, "counted"), 0, MAX_COUNTED_QUANTITY);
        if (counted == null) return quantityError(intent, "counted", 0, MAX_COUNTED_QUANTITY);
        const expectedRaw = formString(form, "expected").trim();
        const expected = /^-?\d{1,9}$/.test(expectedRaw) ? Number(expectedRaw) : null;
        const r = await adjustToCount(ctx, { operationId, stockItemId, countedOnHand: counted, expectedOnHand: expected, note });
        return operationResult(intent, r, r.delta === 0 ? "warehouse.op.countedSame" : "warehouse.op.counted", {
          previous: r.previousOnHand ?? "—",
          counted: r.countedOnHand,
          delta: signedNumber(r.delta),
        });
      }
      case "threshold": {
        const threshold = parseFormInt(formString(form, "threshold"), 0, MAX_THRESHOLD);
        if (threshold === undefined) {
          return {
            ok: false,
            intent,
            error: "warehouse.error.threshold",
            params: { max: MAX_THRESHOLD },
            fieldErrors: { threshold: "warehouse.error.threshold" },
          };
        }
        await setLowStockThreshold(ctx, { stockItemId, threshold });
        return threshold === null
          ? { ok: true, intent, message: "warehouse.op.thresholdReset" }
          : { ok: true, intent, message: "warehouse.op.thresholdSet", params: { threshold } };
      }
    }
  } catch (e) {
    return { ...toActionError(e), intent };
  }
}

// ---------------------------------------------------------------------------
// Інтерфейс
// ---------------------------------------------------------------------------

type LoaderData = Awaited<ReturnType<typeof loader>>;
type Item = LoaderData["item"];
type MovementRow = LoaderData["movements"][number];

const LEVEL_TONE: Record<StockLevelStatus, BadgeTone> = {
  ok: "success",
  low: "warning",
  out: "critical",
  oversold: "critical",
  negative: "critical",
};

function WarehouseNav() {
  const t = useT();
  const href = useHref();
  const can = useCan();
  const tabs: TabItem[] = WAREHOUSE_SECTION_LINKS.filter((l) => can(l.permission)).map((l) => ({
    key: l.key,
    label: t(l.labelKey),
    href: href(l.path),
  }));
  return <Tabs items={tabs} selected="stock" ariaLabel={t("warehouse.nav.label")} preventScrollReset={false} />;
}

function reasonText(t: TFunction, reason: string | null): string | null {
  const key = reasonKey(reason);
  if (!key) return null;
  return hasKey(key) ? t(key) : reason;
}

/** «Фактично +5 · Брак +1». */
function deltaSummary(t: TFunction, m: MovementRow, format: (n: number) => string): string {
  const parts = movementDeltaParts(m);
  if (parts.length === 0) return t("warehouse.movement.noChange");
  return parts.map((p) => `${t(`inventory.bucket.${p.bucket}`)} ${signedNumber(p.delta, format)}`).join(" · ");
}

function Stat({
  label,
  value,
  text,
  emphasis,
  tone,
}: {
  label: string;
  value: number;
  /** Текст замість числа (напр. «прогнозу немає»). */
  text?: string;
  emphasis?: boolean;
  tone?: "critical";
}) {
  const locale = useLocale();
  return (
    <Stack gap={0}>
      <Text as="span" variant={text ? "body-sm" : emphasis ? "heading-lg" : "heading-md"} numeric={!text} tone={tone}>
        {text ?? formatNumber(value, locale)}
      </Text>
      <Text as="span" variant="caption" tone="subdued">
        {label}
      </Text>
    </Stack>
  );
}

export default function WarehouseItemPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const t = useT();
  const locale = useLocale();
  const href = useHref();
  const can = useCan();
  const { item } = data;
  const [formVersion, setFormVersion] = useState(0);

  // Після успішної операції форми очищаються (нові uuid уже прийшли з loader).
  useEffect(() => {
    if (actionData?.ok) setFormVersion((v) => v + 1);
  }, [actionData]);

  const unit = item.kind === "material" ? t(`materialUnit.${item.unit}`) : t("materialUnit.pcs");
  const subtitle = [item.variantTitle, item.sku].filter(Boolean).join(" · ") || undefined;
  const fmt = (n: number) => formatNumber(n, locale);
  /** Помилка поля лише для форми, яку надсилали (поля різних форм мають однакові імена). */
  const fieldErrorFor =
    (intent: ItemIntent): FieldErrorFn =>
    (name) =>
      actionData && !actionData.ok && actionData.intent === intent && actionData.fieldErrors?.[name]
        ? t(actionData.fieldErrors[name]!, actionData.params)
        : null;

  const canReceive = can("warehouse.receive");
  const canAdjust = can("warehouse.adjust");
  const anyAction = canReceive || canAdjust;
  const timeline: TimelineItem[] = data.movements.map((m) => {
    const reason = reasonText(t, m.reason);
    const details: ReactNode[] = [];
    if (reason) details.push(<span key="reason">{reason}</span>);
    if (m.orderId && m.orderNumber) {
      details.push(
        <span key="order">
          {t("warehouse.movement.order")}{" "}
          {can("orders.view") ? <Link to={href(`orders/${m.orderId}`)}>{m.orderNumber}</Link> : m.orderNumber}
        </span>,
      );
    }
    if (m.batchNumber) details.push(<span key="batch">{t("warehouse.movement.batch", { number: m.batchNumber })}</span>);
    if (m.unitCostText) details.push(<span key="cost">{t("warehouse.movement.unitCost", { cost: m.unitCostText })}</span>);
    details.push(<span key="actor">{m.actorName}</span>);
    return {
      id: m.id,
      title: `${t(`movementType.${m.type}`)}: ${deltaSummary(t, m, fmt)}`,
      time: formatDateTime(m.createdAt, locale),
      tone: m.type === "defect_mark" || m.type === "defect_writeoff" ? "warning" : m.onHandDelta > 0 ? "success" : "default",
      description: (
        <Stack gap={1}>
          <Text as="span" variant="body-sm" tone="subdued">
            {details.reduce<ReactNode[]>((acc, d, i) => (i === 0 ? [d] : [...acc, " · ", d]), [])}
          </Text>
          {m.note ? (
            <Text as="span" variant="body-sm">
              {m.note}
            </Text>
          ) : null}
        </Stack>
      ),
    };
  });

  const reservationColumns: Array<DataTableColumn<LoaderData["reservations"]["rows"][number]>> = [
    {
      key: "order",
      header: t("warehouse.item.reservations.order"),
      primary: true,
      render: (r) => r.orderNumber,
    },
    { key: "status", header: t("warehouse.item.reservations.status"), render: (r) => <OrderStatusBadge status={r.orderStatus} /> },
    { key: "placed", header: t("warehouse.item.reservations.placedAt"), render: (r) => formatDateTime(r.placedAt, locale) },
    {
      key: "qty",
      header: t("warehouse.item.reservations.qty"),
      align: "end",
      render: (r) => (
        <Text as="span" numeric>
          {fmt(r.reservedQty)}
        </Text>
      ),
    },
  ];

  return (
    <Page
      title={item.title}
      subtitle={subtitle}
      backHref={href("warehouse")}
      backLabel={t("warehouse.item.back")}
      titleMeta={
        <Stack as="span" direction="horizontal" gap={1} align="center">
          <Badge tone={LEVEL_TONE[item.status]}>{t(`stockLevel.${item.status}`)}</Badge>
          {item.tracking && item.tracking !== "opened" ? <Badge tone="outline">{t(`warehouse.tracking.${item.tracking}`)}</Badge> : null}
        </Stack>
      }
      secondaryActions={
        <>
          {WAREHOUSE_RELATED_LINKS.filter((l) => can(l.permission)).map((l) => (
            <Button key={l.key} to={href(l.path)} size="sm">
              {t(l.labelKey)}
            </Button>
          ))}
        </>
      }
    >
      <Stack gap={4}>
        <WarehouseNav />
        <ActionBanner data={actionData} />
        <TrackingBanner item={item} initialized={Boolean(data.initializedAt)} />

        <Card title={t("warehouse.item.balance")} titleAs="h2">
          <Stack gap={4}>
            <Stack direction="horizontal" gap={3} align="center" wrap={false}>
              <Thumbnail src={item.imageUrl} alt={item.title} size="lg" />
              <Stack gap={1}>
                {item.sku ? (
                  <span>
                    <InlineCode>{item.sku}</InlineCode>
                  </span>
                ) : null}
                {item.kind === "material" && item.materialKind ? (
                  <Text as="span" variant="body-sm" tone="subdued">
                    {t(`materialKind.${item.materialKind}`)} · {unit}
                  </Text>
                ) : (
                  <Text as="span" variant="body-sm" tone="subdued">
                    {[item.model, item.color, item.barcode].filter(Boolean).join(" · ") || "—"}
                  </Text>
                )}
              </Stack>
            </Stack>
            {data.materialUsage ? (
              // Матеріал: продажу, резервів і виробництва немає — лише фактичний залишок, брак і витрата при пакуванні.
              <Stack gap={2}>
                <Grid columns={{ xs: 2, md: 4 }} gap={3}>
                  <Stat label={t("inventory.bucket.onHand")} value={item.onHand} emphasis tone={item.onHand < 0 ? "critical" : undefined} />
                  <Stat label={t("inventory.bucket.defective")} value={item.defective} />
                  <Stat label={t("warehouseInsights.material.consumed", { days: data.materialUsage.days })} value={data.materialUsage.consumed} />
                  <Stat
                    label={t("warehouseInsights.material.daysLeft")}
                    value={data.materialUsage.daysLeft ?? 0}
                    text={data.materialUsage.daysLeft === null ? t("warehouseInsights.material.noForecast") : undefined}
                    tone={data.materialUsage.daysLeft === 0 ? "critical" : undefined}
                  />
                </Grid>
                <Text variant="caption" tone="subdued">
                  {t("warehouseInsights.material.forecastHint", { days: data.materialUsage.days })}
                </Text>
              </Stack>
            ) : (
              <Grid columns={{ xs: 2, md: 5 }} gap={3}>
                <Stat
                  label={t("inventory.bucket.available")}
                  value={item.available}
                  emphasis
                  tone={item.available < 0 ? "critical" : undefined}
                />
                <Stat label={t("inventory.bucket.onHand")} value={item.onHand} tone={item.onHand < 0 ? "critical" : undefined} />
                <Stat label={t("inventory.bucket.reserved")} value={item.reserved} />
                <Stat label={t("inventory.bucket.inProduction")} value={item.inProduction} />
                <Stat label={t("inventory.bucket.defective")} value={item.defective} />
              </Grid>
            )}
            <KeyValueList
              items={[
                {
                  key: "threshold",
                  label: t("warehouse.item.threshold"),
                  value:
                    item.lowStockThreshold === null
                      ? t("warehouse.item.thresholdDefault", { threshold: item.defaultThreshold })
                      : t("warehouse.item.thresholdOwn", { threshold: item.lowStockThreshold }),
                },
                ...(item.kind === "product"
                  ? [
                      {
                        key: "shopify",
                        label: t("warehouse.item.shopify"),
                        value:
                          item.shopifyAvailable === null
                            ? t("warehouse.stock.shopify.untracked")
                            : `${fmt(item.shopifyAvailable)}${item.shopifySyncedAt ? ` · ${t("warehouse.stock.shopify.asOf", { time: formatDateTime(item.shopifySyncedAt, locale) })}` : ""}`,
                      },
                      {
                        key: "opened",
                        label: t("warehouse.item.opened"),
                        value: item.openedAt ? formatDateTime(item.openedAt, locale) : t("warehouse.item.notOpened"),
                      },
                    ]
                  : []),
                {
                  key: "stocktake",
                  label: t("warehouse.item.lastStocktake"),
                  value: data.lastStocktake
                    ? t("warehouse.item.lastStocktakeValue", {
                        time: formatDateTime(data.lastStocktake.at, locale),
                        actor: data.lastStocktake.actorName,
                        delta: signedNumber(data.lastStocktake.delta, fmt),
                      })
                    : t("warehouse.item.neverCounted"),
                },
                { key: "updated", label: t("warehouse.item.updatedAt"), value: formatDateTime(item.updatedAt, locale) },
              ]}
            />
            {item.kind === "product" && item.shopifyAvailable !== null && !data.isProduction ? (
              // Демо: значення Shopify вигадане й не оновлюється — розбіжність не позначаємо (як у списку «Склад»).
              <Text variant="body-sm" tone="subdued">
                {t("warehouse.stock.shopify.demoHint")}
              </Text>
            ) : null}
            {data.isProduction &&
            item.kind === "product" &&
            item.shopifyAvailable !== null &&
            item.tracking === "opened" &&
            item.shopifyAvailable !== item.available ? (
              <Text variant="body-sm" tone="subdued">
                {t("warehouse.item.shopifyDiffers", { app: item.available, shopify: item.shopifyAvailable })}{" "}
                <Link to={href("warehouse/shopify")}>{t("warehouse.nav.shopify")}</Link>
              </Text>
            ) : null}
          </Stack>
        </Card>

        {data.alerts.length > 0 ? (
          <Banner tone={data.alerts.some((a) => a.kind !== "low_stock") ? "critical" : "warning"} title={t("warehouse.item.alerts")}>
            <Stack as="ul" gap={1}>
              {data.alerts.map((a) => (
                <li key={a.id}>
                  {t(`stockAlert.${a.kind}`)} — {t("warehouse.item.alertSince", { time: formatDateTime(a.createdAt, locale) })}
                </li>
              ))}
            </Stack>
          </Banner>
        ) : null}

        {anyAction ? (
          <Card title={t("warehouse.item.operations")} titleAs="h2" description={t("warehouse.item.operationsHelp")}>
            <Stack gap={2}>
              {canReceive ? (
                <Disclosure summary={t("warehouse.op.receive.title")}>
                  <ReceiveForm
                    key={`receive-${formVersion}`}
                    item={item}
                    operationId={data.operationIds.receive}
                    canSeeCosts={data.canSeeCosts}
                    pushesToShopify={data.pushesToShopify}
                    returnSuggestions={data.returnSuggestions}
                    fieldError={fieldErrorFor("receive")}
                  />
                </Disclosure>
              ) : null}
              {canReceive ? (
                <Disclosure summary={t("warehouse.op.defect.title")}>
                  <DefectForm
                    key={`defect-${formVersion}`}
                    item={item}
                    operationId={data.operationIds.defect}
                    fieldError={fieldErrorFor("defect")}
                  />
                </Disclosure>
              ) : null}
              {canReceive && item.defective > 0 ? (
                <Disclosure summary={t("warehouse.op.repair.title", { count: item.defective })}>
                  <QuantityForm
                    key={`repair-${formVersion}`}
                    intent="repair"
                    operationId={data.operationIds.repair}
                    max={item.defective}
                    help={t("warehouse.op.repair.help")}
                    submitLabel={t("warehouse.op.repair.submit")}
                    preview={(q) => t("warehouse.op.repair.preview", { onHand: item.onHand + q, defective: item.defective - q })}
                    fieldError={fieldErrorFor("repair")}
                  />
                </Disclosure>
              ) : null}
              {canAdjust && item.defective > 0 ? (
                <Disclosure summary={t("warehouse.op.writeOff.title", { count: item.defective })}>
                  <WriteOffForm
                    key={`writeoff-${formVersion}`}
                    item={item}
                    operationId={data.operationIds.writeOff}
                    fieldError={fieldErrorFor("writeOff")}
                  />
                </Disclosure>
              ) : null}
              {canAdjust ? (
                <Disclosure summary={t("warehouse.op.count.title")}>
                  <CountForm
                    key={`count-${formVersion}`}
                    item={item}
                    operationId={data.operationIds.count}
                    fieldError={fieldErrorFor("count")}
                  />
                </Disclosure>
              ) : null}
              {canAdjust ? (
                <Disclosure summary={t("warehouse.op.threshold.title")}>
                  <ThresholdForm key={`threshold-${formVersion}`} item={item} fieldError={fieldErrorFor("threshold")} />
                </Disclosure>
              ) : null}
            </Stack>
          </Card>
        ) : null}

        {item.kind === "product" ? (
          <Card
            title={t("warehouse.item.reservations.title")}
            titleAs="h2"
            description={
              data.reservations.total > 0
                ? t("warehouse.item.reservations.summary", { orders: data.reservations.total, qty: data.reservations.totalQty })
                : t("warehouse.item.reservations.none")
            }
            padded={data.reservations.rows.length === 0}
          >
            {data.reservations.rows.length > 0 ? (
              <DataTable
                caption={t("warehouse.item.reservations.title")}
                columns={reservationColumns}
                rows={data.reservations.rows}
                rowKey={(r) => r.orderId}
                rowHref={can("orders.view") ? (r) => href(`orders/${r.orderId}`) : undefined}
              />
            ) : null}
          </Card>
        ) : null}

        <Card
          title={t("warehouse.item.movements")}
          titleAs="h2"
          actions={
            item.stockItemId && data.movementsTotal > 0 ? (
              <Button to={href(`warehouse/movements?item=${item.stockItemId}`)} size="sm">
                {t("warehouse.item.allMovements", { count: data.movementsTotal })}
              </Button>
            ) : null
          }
        >
          {timeline.length > 0 ? <Timeline items={timeline} /> : <Text tone="subdued">{t("warehouse.item.noMovements")}</Text>}
        </Card>
      </Stack>
    </Page>
  );
}

function TrackingBanner({ item, initialized }: { item: Item; initialized: boolean }) {
  const t = useT();
  if (item.kind !== "product") return null;
  if (item.productStatus && !["ACTIVE", "active", "DRAFT", "draft"].includes(item.productStatus)) {
    return <Banner tone="info">{t("warehouse.item.archived")}</Banner>;
  }
  const tracking: StockTrackingState | null = item.tracking;
  if (tracking === "not_opened")
    return <Banner tone="warning">{t(initialized ? "warehouse.item.notOpenedHelp" : "warehouse.item.notInitializedHelp")}</Banner>;
  if (tracking === "untracked") return <Banner tone="info">{t("warehouse.item.untrackedHelp")}</Banner>;
  return null;
}

type FieldErrorFn = (name: string) => string | null;

function useBusy(intent: string): boolean {
  const navigation = useNavigation();
  return navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST" && navigation.formData?.get("intent") === intent;
}

function OperationFields({ intent, operationId }: { intent: string; operationId: string }) {
  return (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="operationId" value={operationId} />
    </>
  );
}

function NoteField({ id }: { id: string }) {
  const t = useT();
  return (
    <TextField
      id={id}
      name="note"
      label={t("warehouse.op.note")}
      helpText={t("warehouse.op.noteHelp")}
      maxLength={MAX_NOTE_LENGTH}
      multiline={2}
    />
  );
}

function QuantityField({
  id,
  name = "quantity",
  label,
  min = 1,
  max = MAX_OPERATION_QUANTITY,
  value,
  onChange,
  required = true,
  helpText,
  error,
}: {
  id: string;
  name?: string;
  label: string;
  min?: number;
  max?: number;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  helpText?: ReactNode;
  error: string | null;
}) {
  return (
    <TextField
      id={id}
      name={name}
      type="number"
      inputMode="numeric"
      min={min}
      max={max}
      step={1}
      label={label}
      required={required}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
      helpText={helpText}
      error={error}
    />
  );
}

const asInt = (raw: string): number | null => (/^\d{1,7}$/.test(raw.trim()) ? Number(raw.trim()) : null);

type ReturnSuggestion = LoaderData["returnSuggestions"][number];

function ReceiveForm({
  item,
  operationId,
  canSeeCosts,
  pushesToShopify,
  returnSuggestions,
  fieldError,
}: {
  item: Item;
  operationId: string;
  canSeeCosts: boolean;
  pushesToShopify: boolean;
  returnSuggestions: ReturnSuggestion[];
  fieldError: FieldErrorFn;
}) {
  const t = useT();
  const busy = useBusy("receive");
  const [quantity, setQuantity] = useState("");
  const [damaged, setDamaged] = useState("");
  const [reason, setReason] = useState<string>(RECEIPT_REASONS[0]);
  const [orderNumber, setOrderNumber] = useState("");
  const [pushReturn, setPushReturn] = useState(false);
  const q = asInt(quantity) ?? 0;
  const d = asInt(damaged) ?? 0;
  const orderLinked = ORDER_LINKED_REASONS.includes(reason);
  const shopifyReturn = pushesToShopify && (SHOPIFY_RESTOCK_REASONS as readonly string[]).includes(reason);
  return (
    <Form method="post">
      <OperationFields intent="receive" operationId={operationId} />
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {t("warehouse.op.receive.help")}
        </Text>
        <Grid columns={{ xs: 1, md: 2 }} gap={3}>
          <QuantityField
            id="wh-receive-qty"
            label={t("warehouse.op.receive.quantity")}
            min={0}
            required={false}
            value={quantity}
            onChange={setQuantity}
            error={fieldError("quantity")}
          />
          <QuantityField
            id="wh-receive-damaged"
            name="defectiveQuantity"
            label={t("warehouse.op.receive.damaged")}
            min={0}
            required={false}
            value={damaged}
            onChange={setDamaged}
            helpText={t("warehouse.op.receive.damagedHelp")}
            error={fieldError("defectiveQuantity")}
          />
          <Select
            id="wh-receive-reason"
            name="reason"
            label={t("warehouse.op.reason")}
            options={RECEIPT_REASONS.map((r) => ({ value: r, label: t(`warehouse.reason.${r}`) }))}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
          {orderLinked ? (
            <Stack gap={2}>
              <TextField
                id="wh-receive-order"
                name="orderNumber"
                label={t("warehouse.op.orderNumber")}
                helpText={t("warehouse.op.orderNumberHelp")}
                maxLength={64}
                autoComplete="off"
                value={orderNumber}
                onChange={(e) => setOrderNumber(e.currentTarget.value)}
                error={fieldError("orderNumber")}
              />
              {orderNumber.trim() === "" ? (
                <ReturnOrderHint
                  suggestions={returnSuggestions}
                  onPick={(value) => {
                    setOrderNumber(value);
                    // Підказка зникає разом із кнопкою — фокус переходить у заповнене поле (клавіатура, екранні читачі).
                    document.getElementById("wh-receive-order")?.focus();
                  }}
                />
              ) : null}
            </Stack>
          ) : null}
          {canSeeCosts ? (
            <>
              <TextField
                id="wh-receive-cost"
                name="unitCost"
                label={t("warehouse.op.receive.unitCost")}
                inputMode="decimal"
                maxLength={16}
                helpText={t("warehouse.op.receive.unitCostHelp")}
              />
              <TextField
                id="wh-receive-currency"
                name="costCurrency"
                label={t("warehouse.op.receive.currency")}
                defaultValue={item.defaultCostCurrency}
                maxLength={3}
                autoCapitalize="characters"
              />
            </>
          ) : null}
        </Grid>
        {shopifyReturn ? (
          <Checkbox
            id="wh-receive-push"
            name="pushToShopify"
            label={t("warehouse.op.receive.pushReturn")}
            helpText={t("warehouse.op.receive.pushReturnHelp")}
            checked={pushReturn}
            onChange={(e) => setPushReturn(e.currentTarget.checked)}
          />
        ) : null}
        {/* Shopify поповнив лише якісні одиниці (пошкоджені не відшкодовано / без поповнення) — тоді брак не знімається
            з «доступно» Shopify (operations.server.ts damagedRestockedInShopify). Лише коли є пошкоджені й повернення
            не надсилається (інакше пошкоджені в Shopify не надсилаються й так). */}
        {shopifyReturn && !pushReturn && d > 0 ? (
          <Checkbox
            id="wh-receive-damaged-kept"
            name="damagedNotRestocked"
            label={t("warehouse.op.receive.damagedNotRestocked")}
            helpText={t("warehouse.op.receive.damagedNotRestockedHelp")}
          />
        ) : null}
        <NoteField id="wh-receive-note" />
        {q + d > 0 ? (
          <Text variant="body-sm">
            {t("warehouse.op.receive.preview", { onHand: item.onHand + q, available: item.available + q, defective: item.defective + d })}
          </Text>
        ) : null}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || q + d === 0}>
            {t("warehouse.op.receive.submit")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}

/**
 * Повернення покупця без номера замовлення зіставляється з поверненнями в Shopify лише за кількістю
 * (docs/stage5-design.md §10.1): підказка вказати замовлення і нещодавні повернення в Shopify, яких склад ще не отримав
 * (лише номер замовлення — без даних покупця). Кнопка підставляє номер у поле; посилання на замовлення — лише з
 * orders.view (orderId приходить із loader лише тоді). Номер необов'язковий.
 */
function ReturnOrderHint({ suggestions, onPick }: { suggestions: ReturnSuggestion[]; onPick: (orderNumber: string) => void }) {
  const t = useT();
  const href = useHref();
  return (
    <Stack gap={2}>
      <Text variant="body-sm" tone="subdued">
        {t("warehouse.op.receive.orderHint")}
      </Text>
      {suggestions.length > 0 ? (
        <Stack gap={1}>
          <Text variant="body-sm">{t("warehouse.op.receive.suggestions")}</Text>
          <Stack as="ul" direction="horizontal" gap={2}>
            {suggestions.map((s) => (
              <Stack as="li" key={s.orderNumber} direction="horizontal" gap={1} align="center">
                <Button
                  size="sm"
                  onClick={() => onPick(s.orderNumber)}
                  aria-label={t("warehouse.op.receive.useSuggestion", { order: s.orderNumber, count: s.units })}
                >
                  {t("warehouse.op.receive.suggestion", { order: s.orderNumber, count: s.units })}
                </Button>
                {s.orderId ? (
                  <Link to={href(`orders/${s.orderId}`)} aria-label={t("warehouse.op.receive.openOrder", { order: s.orderNumber })}>
                    {t("warehouse.op.receive.openOrderShort")}
                  </Link>
                ) : null}
              </Stack>
            ))}
          </Stack>
        </Stack>
      ) : null}
    </Stack>
  );
}

function DefectForm({ item, operationId, fieldError }: { item: Item; operationId: string; fieldError: FieldErrorFn }) {
  const t = useT();
  const busy = useBusy("defect");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<string>(DEFECT_REASONS[0]);
  const q = asInt(quantity) ?? 0;
  const max = Math.max(0, item.onHand);
  return (
    <Form method="post">
      <OperationFields intent="defect" operationId={operationId} />
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {t("warehouse.op.defect.help")}
        </Text>
        <Grid columns={{ xs: 1, md: 2 }} gap={3}>
          <QuantityField
            id="wh-defect-qty"
            label={t("warehouse.op.quantity")}
            max={Math.max(1, max)}
            value={quantity}
            onChange={setQuantity}
            error={fieldError("quantity")}
          />
          <Select
            id="wh-defect-reason"
            name="reason"
            label={t("warehouse.op.reason")}
            options={DEFECT_REASONS.map((r) => ({ value: r, label: t(`warehouse.reason.${r}`) }))}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
          {ORDER_LINKED_REASONS.includes(reason) ? (
            <TextField
              id="wh-defect-order"
              name="orderNumber"
              label={t("warehouse.op.orderNumber")}
              helpText={t("warehouse.op.orderNumberHelp")}
              maxLength={64}
              autoComplete="off"
              error={fieldError("orderNumber")}
            />
          ) : null}
        </Grid>
        <NoteField id="wh-defect-note" />
        {q > 0 ? (
          <Text variant="body-sm">{t("warehouse.op.defect.preview", { onHand: item.onHand - q, defective: item.defective + q })}</Text>
        ) : null}
        {q > 0 && q > item.available ? (
          <Banner tone="warning">{t("warehouse.op.defect.reservedWarning", { available: Math.max(0, item.available) })}</Banner>
        ) : null}
        {q > max ? (
          <Text variant="body-sm" tone="critical">
            {t("warehouse.op.defect.tooMany", { max })}
          </Text>
        ) : null}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || q === 0 || q > max}>
            {t("warehouse.op.defect.submit")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}

function QuantityForm({
  intent,
  operationId,
  max,
  help,
  submitLabel,
  preview,
  fieldError,
}: {
  intent: string;
  operationId: string;
  max: number;
  help: string;
  submitLabel: string;
  preview: (q: number) => string;
  fieldError: FieldErrorFn;
}) {
  const t = useT();
  const busy = useBusy(intent);
  const [quantity, setQuantity] = useState("");
  const q = asInt(quantity) ?? 0;
  return (
    <Form method="post">
      <OperationFields intent={intent} operationId={operationId} />
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {help}
        </Text>
        <QuantityField
          id={`wh-${intent}-qty`}
          label={t("warehouse.op.quantity")}
          max={Math.max(1, max)}
          value={quantity}
          onChange={setQuantity}
          error={fieldError("quantity")}
        />
        <NoteField id={`wh-${intent}-note`} />
        {q > 0 && q <= max ? <Text variant="body-sm">{preview(q)}</Text> : null}
        {q > max ? (
          <Text variant="body-sm" tone="critical">
            {t("warehouse.op.tooMany", { max })}
          </Text>
        ) : null}
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={busy || q === 0 || q > max}>
            {submitLabel}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}

function WriteOffForm({ item, operationId, fieldError }: { item: Item; operationId: string; fieldError: FieldErrorFn }) {
  const t = useT();
  const busy = useBusy("writeOff");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState<string>(WRITE_OFF_REASONS[0]);
  const q = asInt(quantity) ?? 0;
  return (
    <Form method="post">
      <OperationFields intent="writeOff" operationId={operationId} />
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {t("warehouse.op.writeOff.help")}
        </Text>
        <Grid columns={{ xs: 1, md: 2 }} gap={3}>
          <QuantityField
            id="wh-writeoff-qty"
            label={t("warehouse.op.quantity")}
            max={Math.max(1, item.defective)}
            value={quantity}
            onChange={setQuantity}
            error={fieldError("quantity")}
          />
          <Select
            id="wh-writeoff-reason"
            name="reason"
            label={t("warehouse.op.reason")}
            options={WRITE_OFF_REASONS.map((r) => ({ value: r, label: t(`warehouse.reason.${r}`) }))}
            value={reason}
            onChange={(e) => setReason(e.currentTarget.value)}
          />
        </Grid>
        <NoteField id="wh-writeoff-note" />
        {q > item.defective ? (
          <Text variant="body-sm" tone="critical">
            {t("warehouse.op.tooMany", { max: item.defective })}
          </Text>
        ) : null}
        <div>
          <ConfirmSubmitButton
            variant="critical"
            disabled={busy || q === 0 || q > item.defective}
            loading={busy}
            title={t("warehouse.op.writeOff.confirmTitle")}
            confirmLabel={t("warehouse.op.writeOff.confirm")}
            cancelLabel={t("common.cancel")}
            message={
              <Text>
                {t("warehouse.op.writeOff.preview", {
                  quantity: q,
                  defective: item.defective - q,
                  reason: t(`warehouse.reason.${reason}`),
                })}
              </Text>
            }
          >
            {t("warehouse.op.writeOff.submit")}
          </ConfirmSubmitButton>
        </div>
      </Stack>
    </Form>
  );
}

function CountForm({ item, operationId, fieldError }: { item: Item; operationId: string; fieldError: FieldErrorFn }) {
  const t = useT();
  const locale = useLocale();
  const busy = useBusy("count");
  const [counted, setCounted] = useState("");
  const c = asInt(counted);
  const delta = c === null ? 0 : c - item.onHand;
  return (
    <Form method="post">
      <OperationFields intent="count" operationId={operationId} />
      <input type="hidden" name="expected" value={String(item.onHand)} />
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {t("warehouse.op.count.help", { onHand: item.onHand })}
        </Text>
        <QuantityField
          id="wh-count-qty"
          name="counted"
          label={t("warehouse.op.count.counted")}
          min={0}
          max={MAX_COUNTED_QUANTITY}
          value={counted}
          onChange={setCounted}
          error={fieldError("counted")}
        />
        <NoteField id="wh-count-note" />
        {c !== null ? (
          <Text variant="body-sm">
            {t("warehouse.op.count.preview", { from: item.onHand, to: c, delta: signedNumber(delta, (n) => formatNumber(n, locale)) })}
          </Text>
        ) : null}
        {c !== null && c < item.reserved ? (
          <Banner tone="warning">{t("warehouse.op.count.belowReserved", { reserved: item.reserved })}</Banner>
        ) : null}
        <div>
          <ConfirmSubmitButton
            variant="primary"
            disabled={busy || c === null}
            loading={busy}
            title={t("warehouse.op.count.confirmTitle")}
            confirmLabel={t("warehouse.op.count.confirm")}
            cancelLabel={t("common.cancel")}
            message={
              <Stack gap={2}>
                <Text weight="semibold">
                  {t("warehouse.op.count.preview", {
                    from: item.onHand,
                    to: c ?? 0,
                    delta: signedNumber(delta, (n) => formatNumber(n, locale)),
                  })}
                </Text>
                <Text>{t("warehouse.op.count.confirmHelp")}</Text>
              </Stack>
            }
          >
            {t("warehouse.op.count.submit")}
          </ConfirmSubmitButton>
        </div>
      </Stack>
    </Form>
  );
}

function ThresholdForm({ item, fieldError }: { item: Item; fieldError: FieldErrorFn }) {
  const t = useT();
  const busy = useBusy("threshold");
  return (
    <Form method="post">
      <input type="hidden" name="intent" value="threshold" />
      <Stack gap={3}>
        <TextField
          id="wh-threshold"
          name="threshold"
          type="number"
          inputMode="numeric"
          min={0}
          max={MAX_THRESHOLD}
          step={1}
          label={t("warehouse.op.threshold.label")}
          defaultValue={item.lowStockThreshold ?? ""}
          helpText={t("warehouse.op.threshold.help", { default: item.defaultThreshold })}
          error={fieldError("threshold")}
        />
        <div>
          <Button type="submit" variant="primary" loading={busy} disabled={busy}>
            {t("common.save")}
          </Button>
        </div>
      </Stack>
    </Form>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

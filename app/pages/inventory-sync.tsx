import { useMemo, useState } from "react";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ActionBanner, type ActionResult } from "~/components/action-banner";
import { can, requirePermission, type Permission } from "~/domain/permissions";
import { useLocale, useT, type TFunction } from "~/i18n";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { DomainError } from "~/lib/errors";
import { formatDateTime, formatNumber } from "~/lib/format";
import {
  acceptShopifyValue,
  acceptShopifyValues,
  conflictFacets,
  dismissConflict,
  isConflictStatusFilter,
  listConflicts,
  pushAppValue,
  type ConflictStatusFilter,
  type ConflictView,
} from "~/modules/inventory-sync/conflicts.server";
import { loadSyncEnvironment } from "~/modules/inventory-sync/environment.server";
import {
  confirmWarehouseLocation,
  fetchLocations,
  setWarehouseLocation,
  type LocationOption,
} from "~/modules/inventory-sync/location.server";
import { reconcileStockItemNow } from "~/modules/inventory-sync/reconcile.server";
import { enqueueFullReconcile, enqueueInventoryPush } from "~/modules/inventory-sync/schedule.server";
import { getInventorySyncOverview } from "~/modules/inventory-sync/status.server";
import { writeAudit } from "~/modules/audit/audit.server";
import { getRequestContext } from "~/server/context.server";
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
  KeyValueList,
  Page,
  Pagination,
  Select,
  Stack,
  Tabs,
  Text,
  TextField,
  Thumbnail,
  type DataTableColumn,
} from "~/ui";

/**
 * Склад → Shopify (етап 5): стан синхронізації залишків, розбіжності зі Shopify та їх розв'язання, звірка.
 * Перегляд — warehouse.view; розв'язання, звірка, передача — warehouse.adjust; локація — settings.manage (власник).
 * Демо (без Shopify): сторінка пояснює, дії відхиляються.
 */
const PAGE_SIZE = 50;
const BULK_FORM_ID = "inventory-sync-bulk";
const MAX_QUERY = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Filters {
  status: ConflictStatusFilter;
  model: string | null;
  color: string | null;
  q: string;
  page: number;
  /** Одна розбіжність (посилання referenceDocumentUri з історії залишків Shopify). */
  conflict: string | null;
}

function parseFilters(url: URL): Filters {
  const status = url.searchParams.get("status");
  const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
  const conflict = (url.searchParams.get("conflict") ?? "").trim().toLowerCase();
  return {
    conflict: UUID_RE.test(conflict) ? conflict : null,
    status: isConflictStatusFilter(status) ? status : "open",
    model: url.searchParams.get("model")?.slice(0, 120) || null,
    color: url.searchParams.get("color")?.slice(0, 120) || null,
    q: (url.searchParams.get("q") ?? "").trim().slice(0, MAX_QUERY),
    page: Number.isFinite(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

async function adminFor(shop: string): Promise<AdminGraphql> {
  const { adminClientFor } = await import("~/integrations/shopify/admin-client.server");
  return adminClientFor(shop);
}

async function appUrl(): Promise<string | null> {
  const { getEnv } = await import("~/lib/env.server");
  return getEnv().SHOPIFY_APP_URL ?? null;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await getRequestContext(request);
  if (!can(ctx.actor, "warehouse.view")) throw new Response("Forbidden", { status: 403 });
  const url = new URL(request.url);
  const filters = parseFilters(url);
  const overview = await getInventorySyncOverview(ctx.db);
  const facets = await conflictFacets(ctx.db);
  const list = await listConflicts(
    ctx.db,
    filters.conflict
      ? { conflictId: filters.conflict }
      : {
          status: filters.status,
          models: filters.model ? [filters.model] : undefined,
          colors: filters.color ? [filters.color] : undefined,
          search: filters.q || undefined,
        },
    { limit: PAGE_SIZE, offset: (filters.page - 1) * PAGE_SIZE },
  );
  // Назви локацій — з Shopify (необов'язково: помилка не заважає сторінці).
  let locations: LocationOption[] | null = null;
  if (ctx.mode === "production" && overview.shop && overview.canRead) {
    try {
      const { nodes } = await fetchLocations(await adminFor(overview.shop));
      locations = nodes
        .filter((l) => l.isActive && !l.isFulfillmentService)
        .map((l) => ({ id: l.id, name: l.name, fulfillsOnlineOrders: l.fulfillsOnlineOrders }));
    } catch {
      locations = null;
    }
  }
  return {
    mode: ctx.mode,
    basePath: ctx.basePath,
    overview,
    facets,
    conflicts: list.rows,
    total: list.total,
    pages: Math.max(1, Math.ceil(list.total / PAGE_SIZE)),
    filters,
    locations,
    permissions: { adjust: can(ctx.actor, "warehouse.adjust"), location: can(ctx.actor, "settings.manage") },
  };
}

const INTENT_PERMISSION: Readonly<Record<string, Permission>> = {
  accept: "warehouse.adjust",
  pushApp: "warehouse.adjust",
  dismiss: "warehouse.adjust",
  bulkAccept: "warehouse.adjust",
  reconcileItem: "warehouse.adjust",
  reconcileAll: "warehouse.adjust",
  pushNow: "warehouse.adjust",
  setLocation: "settings.manage",
  confirmLocation: "settings.manage",
};

const outcomeExtra = (outcome: string | null | undefined) => (outcome ? [`inventorySync.outcome.${outcome}`] : []);

export async function action({ request }: ActionFunctionArgs): Promise<ActionResult> {
  const ctx = await getRequestContext(request);
  try {
    const form = await request.formData();
    const intent = formString(form, "intent");
    const permission = INTENT_PERMISSION[intent];
    if (!permission) return { ok: false, error: "error.generic" };
    requirePermission(ctx.actor, permission);
    if (ctx.mode !== "production") throw new DomainError("inventorySync.demoUnavailable", 409);
    const env = await loadSyncEnvironment(ctx.db);
    if (!env.shop) throw new DomainError("shopify.notInstalled", 409);
    const shop = env.shop;
    const conflictId = formString(form, "conflictId");

    switch (intent) {
      case "accept": {
        const r = await acceptShopifyValue(ctx, conflictId, { admin: () => adminFor(shop) });
        if (r.status === "accepted") return { ok: true, message: "inventorySync.result.accepted", params: { diff: signed(r.delta) } };
        if (r.status === "already") return { ok: true, message: "inventorySync.result.already", tone: "info" };
        if (r.status === "push_pending") return { ok: true, message: "inventorySync.result.push_pending", tone: "warning" };
        return { ok: true, message: `inventorySync.result.${r.status}`, tone: "warning", extra: outcomeExtra(r.reconciled) };
      }
      case "pushApp": {
        // Прапорець «Shopify не поповнить ці повернення» (Checkbox без value — браузер надсилає "on").
        const r = await pushAppValue(ctx, await adminFor(shop), conflictId, { appUrl: await appUrl(), includeReturns: form.has("includeReturns") });
        if (r.status === "pushed") {
          const held = (r.heldOtherStates ?? 0) + (r.heldAwaiting ?? 0);
          return held > 0
            ? { ok: true, message: "inventorySync.result.pushedHeld", params: { delta: signed(r.delta), held }, tone: "info" }
            : { ok: true, message: "inventorySync.result.pushed", params: { delta: signed(r.delta) } };
        }
        if (r.status === "failed") return { ok: false, error: "inventorySync.pushFailed", params: { code: r.code } };
        if (r.status === "other_states") return { ok: false, error: "inventorySync.pushOtherStates", params: { count: r.count } };
        if (r.status === "awaiting_restock") return { ok: false, error: "inventorySync.pushAwaitingReturns", params: { count: r.count } };
        if (r.status === "resolved_concurrently") {
          return { ok: true, message: "inventorySync.result.resolved_concurrently", params: { delta: signed(r.delta) }, tone: "info" };
        }
        if (r.status === "stale" || r.status === "needs_reconcile") {
          return { ok: true, message: `inventorySync.result.${r.status}`, tone: "warning", extra: outcomeExtra(r.reconciled) };
        }
        return { ok: true, message: `inventorySync.result.${r.status === "in_progress" ? "inProgress" : r.status}`, tone: "info" };
      }
      case "dismiss": {
        const r = await dismissConflict(ctx, conflictId, formString(form, "note"));
        return { ok: true, message: r.status === "already" ? "inventorySync.result.already" : "inventorySync.result.dismissed" };
      }
      case "bulkAccept": {
        const ids = form.getAll("ids").filter((v): v is string => typeof v === "string");
        const r = await acceptShopifyValues(ctx, ids, { admin: () => adminFor(shop) });
        return {
          ok: true,
          message: "inventorySync.result.bulkAccepted",
          params: { accepted: r.accepted, units: signed(r.units), stale: r.stale, already: r.already, pending: r.pending, failed: r.failed },
          tone: r.stale + r.failed + r.pending > 0 ? "warning" : "success",
        };
      }
      case "reconcileItem": {
        const stockItemId = formString(form, "stockItemId");
        if (!UUID_RE.test(stockItemId)) return { ok: false, error: "inventorySync.reconcileUnavailable" };
        const outcome = await reconcileStockItemNow(ctx.db, await adminFor(shop), stockItemId);
        if (!outcome) return { ok: false, error: "inventorySync.reconcileUnavailable" };
        return { ok: true, message: "inventorySync.result.reconciledItem", extra: outcomeExtra(outcome), tone: "info" };
      }
      case "reconcileAll": {
        if (!env.canRead) throw new DomainError("inventorySync.missingReadScope", 409);
        const queued = await enqueueFullReconcile(ctx.db, shop, ctx.actor.id);
        await writeAudit(ctx.db, ctx.actor, "inventory_sync.reconcile_requested", { type: "warehouse", id: env.warehouse.id });
        return { ok: true, message: queued ? "inventorySync.result.reconcileQueued" : "inventorySync.result.reconcileAlreadyQueued", tone: "info" };
      }
      case "pushNow": {
        // Працює й коли передачу вимкнено / немає write_inventory: завдання позначить очікувані рухи skipped
        // (з причиною), щоб вони не блокували звірку й дії з розбіжностями.
        await enqueueInventoryPush(ctx.db);
        const sending = env.pushMode === "deltas" && env.canWrite;
        return { ok: true, message: sending ? "inventorySync.result.pushQueued" : "inventorySync.result.pendingWillBeSkipped", tone: "info" };
      }
      case "setLocation": {
        const chosen = await setWarehouseLocation(ctx, await adminFor(shop), env.warehouse, formString(form, "locationId"));
        return { ok: true, message: "inventorySync.result.locationSet", params: { name: chosen.name } };
      }
      case "confirmLocation": {
        await confirmWarehouseLocation(ctx, env.warehouse);
        return { ok: true, message: "inventorySync.result.locationConfirmed" };
      }
    }
    return { ok: false, error: "error.generic" };
  } catch (e) {
    return toActionError(e);
  }
}

/** Число зі знаком: +3 / −2 / 0. */
function signed(n: number): string {
  return n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0";
}

type LoaderData = ReturnType<typeof useLoaderData<typeof loader>>;

export default function InventorySyncPage() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const t = useT();
  const href = (path: string) => `${data.basePath}/${path}`;
  const listHref = (over: Partial<Filters>) => {
    const f = { ...data.filters, page: 1, ...over };
    const p = new URLSearchParams();
    if (f.status !== "open") p.set("status", f.status);
    if (f.model) p.set("model", f.model);
    if (f.color) p.set("color", f.color);
    if (f.q) p.set("q", f.q);
    if (f.page > 1) p.set("page", String(f.page));
    const qs = p.toString();
    return `${data.basePath}/warehouse/shopify${qs ? `?${qs}` : ""}`;
  };
  const counts = data.facets.counts;
  const resolvedCount = counts.accepted_shopify + counts.pushed_app + counts.dismissed;
  const isFiltered = Boolean(data.filters.model || data.filters.color || data.filters.q);

  return (
    <Page title={t("inventorySync.title")} subtitle={t("inventorySync.subtitle")} backHref={href("warehouse")} backLabel={t("nav.warehouse")}>
      <Stack gap={4}>
        <ActionBanner data={result} />
        {data.mode === "demo" ? <Banner tone="info">{t("inventorySync.demo")}</Banner> : null}
        <StatusBanners data={data} />
        {data.filters.conflict ? (
          <Banner tone="info">
            <Stack gap={2}>
              <span>{t("inventorySync.conflicts.single")}</span>
              <span>
                <Button to={listHref({ status: "open" })} size="sm">
                  {t("inventorySync.conflicts.showAll")}
                </Button>
              </span>
            </Stack>
          </Banner>
        ) : null}
        <OverviewCard data={data} />
        {data.overview.recentFailures.length > 0 ? <FailuresCard data={data} /> : null}

        <Stack gap={3} as="section">
          <Text as="h2" variant="heading-md">
            {t("inventorySync.conflicts.title")}
          </Text>
          <Text variant="body-sm" tone="subdued">
            {t("inventorySync.conflicts.help")}
          </Text>
          <Tabs
            ariaLabel={t("inventorySync.tabs.label")}
            selected={data.filters.status === "open" || data.filters.status === "all" ? data.filters.status : "resolved"}
            items={[
              { key: "open", label: t("inventorySync.tab.open"), href: listHref({ status: "open" }), count: counts.open },
              { key: "resolved", label: t("inventorySync.tab.resolved"), href: listHref({ status: "resolved" }), count: resolvedCount },
              { key: "all", label: t("inventorySync.tab.all"), href: listHref({ status: "all" }), count: counts.open + resolvedCount },
            ]}
          />
          <FiltersCard data={data} isFiltered={isFiltered} resetHref={listHref({ model: null, color: null, q: "" })} />
          <ConflictsTable data={data} />
          <Pagination
            prevHref={data.filters.page > 1 ? listHref({ page: data.filters.page - 1 }) : null}
            nextHref={data.filters.page < data.pages ? listHref({ page: data.filters.page + 1 }) : null}
            label={t("common.pageOf", { page: data.filters.page, pages: data.pages })}
            prevLabel={t("common.previous")}
            nextLabel={t("common.next")}
            ariaLabel={t("common.pagination")}
          />
        </Stack>
      </Stack>
    </Page>
  );
}

function StatusBanners({ data }: { data: LoaderData }) {
  const t = useT();
  if (data.mode === "demo") return null;
  const o = data.overview;
  const banners: Array<{ key: string; tone: "info" | "warning"; text: string }> = [];
  if (!o.shop) banners.push({ key: "shop", tone: "warning", text: t("shopify.notInstalled") });
  if (o.shop && !o.canWrite) banners.push({ key: "scope", tone: o.pushMode === "deltas" ? "warning" : "info", text: t("inventorySync.banner.missingWrite") });
  if (o.pushMode === "off") banners.push({ key: "off", tone: "info", text: t("inventorySync.banner.pushOff") });
  // Автоприйняття діє лише з передачею змін і write_inventory (autoApplyEffective) — інакше все на розгляд власника.
  if (o.externalMode === "apply" && !(o.pushMode === "deltas" && o.canWrite)) {
    banners.push({ key: "autoApply", tone: "warning", text: t("inventorySync.banner.autoApplyPaused") });
  }
  if (!o.inventoryInitializedAt) banners.push({ key: "init", tone: "info", text: t("inventorySync.banner.notInitialized") });
  if (o.shop && !o.locationId) banners.push({ key: "location", tone: "warning", text: t("inventorySync.banner.chooseLocation") });
  if (o.locationAutoSelected) banners.push({ key: "auto", tone: "info", text: t("inventorySync.banner.confirmLocation") });
  return (
    <>
      {banners.map((b) => (
        <Banner key={b.key} tone={b.tone}>
          {b.text}
        </Banner>
      ))}
    </>
  );
}

function OverviewCard({ data }: { data: LoaderData }) {
  const t = useT();
  const locale = useLocale();
  const busy = useNavigation().state !== "idle";
  const o = data.overview;
  const demo = data.mode === "demo";
  const locationName = o.locationId ? (data.locations?.find((l) => l.id === o.locationId)?.name ?? o.locationId) : null;
  const scopeBadge = (granted: boolean) => <Badge tone={granted ? "success" : "warning"}>{granted ? t("inventorySync.overview.granted") : t("inventorySync.overview.missing")}</Badge>;
  const s = o.lastReconcile?.summary;
  // Демо: Shopify не підключено — передача, зміни з Shopify, планова звірка й черга не діють. Збережене налаштування
  // показуємо лише як «обрано в налаштуваннях» (діятиме в робочому застосунку), а не як поточний стан.
  const demoRow = (note: string, setting: string | null, hint?: string) => (
    <Stack gap={1}>
      <span>{note}</span>
      {setting ? (
        <Text variant="caption" tone="subdued">
          {t("inventorySync.overview.demo.setting", { value: setting })}
        </Text>
      ) : null}
      {hint ? (
        <Text variant="caption" tone="subdued">
          {hint}
        </Text>
      ) : null}
    </Stack>
  );
  const queueText =
    [o.queued.push ? t("inventorySync.overview.queuedPush") : null, o.queued.reconcile ? t("inventorySync.overview.queuedReconcile", { count: o.queued.reconcile }) : null]
      .filter(Boolean)
      .join(" · ") || "—";
  return (
    <Card title={t("inventorySync.overview.title")}>
      <Stack gap={4}>
        <KeyValueList
          items={[
            { key: "shop", label: t("inventorySync.overview.shop"), value: o.shop ?? "—" },
            {
              key: "scopes",
              label: t("inventorySync.overview.scopes"),
              value: (
                <Stack direction="horizontal" gap={2}>
                  <span>read_inventory {scopeBadge(o.canRead)}</span>
                  <span>write_inventory {scopeBadge(o.canWrite)}</span>
                </Stack>
              ),
            },
            {
              key: "push",
              label: t("inventorySync.overview.pushMode"),
              value: demo ? (
                demoRow(t("inventorySync.overview.demo.push"), t(`settings.warehouse.shopifyPush.${o.pushMode}`), t("inventorySync.overview.settingsHint"))
              ) : (
                <Stack gap={1}>
                  <span>{t(`inventorySync.overview.pushMode.${o.pushMode}`)}</span>
                  <Text variant="caption" tone="subdued">
                    {t("inventorySync.overview.settingsHint")}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "external",
              label: t("inventorySync.overview.externalMode"),
              value: demo
                ? demoRow(t("inventorySync.overview.demo.external"), t(`settings.warehouse.externalShopifyChanges.${o.externalMode}`))
                : t(`inventorySync.overview.externalMode.${o.externalMode}`),
            },
            {
              key: "location",
              label: t("inventorySync.overview.location"),
              value: locationName ? (
                <Stack gap={1}>
                  <span>{locationName}</span>
                  {o.locationConfirmation ? (
                    <Badge tone="success">{t("inventorySync.overview.locationConfirmed", { date: formatDateTime(o.locationConfirmation.confirmedAt, locale) })}</Badge>
                  ) : (
                    <Badge tone="warning">{t(o.locationAutoSelected ? "inventorySync.overview.locationAuto" : "inventorySync.overview.locationUnconfirmed")}</Badge>
                  )}
                </Stack>
              ) : (
                t("inventorySync.overview.locationNone")
              ),
            },
            // Демо: нові рухи не отримують «Очікує надсилання» (movementOptionsFor); такі позначки можуть лишитися лише в
            // старій демо-базі — показуємо їх як ті, що НЕ будуть надіслані (а без них рядок не потрібен).
            ...(demo
              ? o.push.pending > 0
                ? [
                    {
                      key: "pending",
                      label: t("inventorySync.overview.demo.pending"),
                      value: demoRow(formatNumber(o.push.pending, locale), null, t("inventorySync.overview.demo.pendingHint")),
                    },
                  ]
                : []
              : [
                  {
                    key: "pending",
                    label: t("inventorySync.overview.pending"),
                    value: o.push.pending
                      ? `${formatNumber(o.push.pending, locale)} · ${t("inventorySync.overview.oldestPending", { date: formatDateTime(o.push.oldestPendingAt, locale) })}`
                      : "0",
                  },
                ]),
            { key: "failed", label: t("inventorySync.overview.failed"), value: formatNumber(o.push.failed, locale) },
            {
              key: "lastPush",
              label: t("inventorySync.overview.lastPush"),
              value: o.lastPushRun
                ? `${formatDateTime(o.lastPushRun.at, locale)} · ${t("inventorySync.overview.lastPushSummary", { pushed: o.lastPushRun.pushed, failed: o.lastPushRun.failed })}`
                : "—",
            },
            {
              key: "lastReconcile",
              label: t("inventorySync.overview.lastReconcile"),
              value:
                o.lastReconcile && s ? (
                  <Stack gap={1}>
                    <span>{formatDateTime(o.lastReconcile.at, locale)}</span>
                    <Text variant="caption" tone="subdued">
                      {t("inventorySync.overview.lastReconcileSummary", {
                        checked: s.checked,
                        match: s.match + s.explained,
                        conflicts: s.opened + s.updated,
                        autoApplied: s.auto_applied,
                        closed: s.closed,
                        skipped: s.skipped_pending + s.skipped_busy + s.not_stocked + s.untracked + s.missing,
                      })}
                    </Text>
                  </Stack>
                ) : (
                  t("inventorySync.overview.lastReconcileNever")
                ),
            },
            {
              key: "nextReconcile",
              label: t("inventorySync.overview.nextReconcile"),
              value: demo ? (
                demoRow(t("inventorySync.overview.demo.nextReconcile"), null)
              ) : (
                <Stack gap={1}>
                  <span>
                    {o.nextScheduledReconcileAt ? formatDateTime(o.nextScheduledReconcileAt, locale) : t("inventorySync.overview.nextReconcileNone")}
                  </span>
                  <Text variant="caption" tone="subdued">
                    {t("inventorySync.overview.nextReconcileHint")}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "queued",
              label: t("inventorySync.overview.queue"),
              // Демо: обробник черги не запускається (немає Shopify) — завдання зі старої демо-бази не виконаються.
              value: demo && queueText !== "—" ? demoRow(queueText, null, t("inventorySync.overview.demo.queue")) : queueText,
            },
          ]}
        />
        {!demo && data.permissions.adjust && o.shop ? (
          <Form method="post">
            <Stack direction="horizontal" gap={2}>
              <ConfirmSubmitButton
                name="intent"
                value="reconcileAll"
                size="sm"
                disabled={busy || !o.canRead}
                title={t("inventorySync.action.reconcileAll.title")}
                message={t("inventorySync.action.reconcileAll.message")}
                confirmLabel={t("inventorySync.action.reconcileAll")}
                cancelLabel={t("common.cancel")}
              >
                {t("inventorySync.action.reconcileAll")}
              </ConfirmSubmitButton>
              {o.push.pending > 0 ? (
                o.pushMode === "deltas" && o.canWrite ? (
                  <Button type="submit" name="intent" value="pushNow" size="sm" disabled={busy}>
                    {t("inventorySync.action.pushNow")}
                  </Button>
                ) : (
                  <ConfirmSubmitButton
                    name="intent"
                    value="pushNow"
                    size="sm"
                    disabled={busy}
                    title={t("inventorySync.action.skipPending.title")}
                    message={t("inventorySync.action.skipPending.message", { count: o.push.pending })}
                    confirmLabel={t("inventorySync.action.skipPending")}
                    cancelLabel={t("common.cancel")}
                  >
                    {t("inventorySync.action.skipPending")}
                  </ConfirmSubmitButton>
                )
              ) : null}
            </Stack>
          </Form>
        ) : null}
        {!demo && data.permissions.location && o.shop ? <LocationForm data={data} /> : null}
      </Stack>
    </Card>
  );
}

function LocationForm({ data }: { data: LoaderData }) {
  const t = useT();
  const busy = useNavigation().state !== "idle";
  const o = data.overview;
  if (!data.locations) {
    return (
      <Text variant="body-sm" tone="subdued">
        {t("inventorySync.location.unavailable")}
      </Text>
    );
  }
  return (
    <Disclosure summary={t("inventorySync.location.title")} defaultOpen={!o.locationId}>
      <Stack gap={3}>
        <Text variant="body-sm" tone="subdued">
          {t("inventorySync.location.help")}
        </Text>
        <Form method="post">
          <Stack gap={2}>
            <Select
              id="inventory-sync-location"
              name="locationId"
              label={t("inventorySync.location.label")}
              placeholder={t("inventorySync.location.placeholder")}
              options={data.locations.map((l) => ({ value: l.id, label: l.name }))}
              defaultValue={o.locationId ?? ""}
              required
            />
            <Stack direction="horizontal" gap={2}>
              <ConfirmSubmitButton
                name="intent"
                value="setLocation"
                size="sm"
                variant="primary"
                disabled={busy || data.locations.length === 0}
                title={t("inventorySync.location.confirmTitle")}
                message={t("inventorySync.location.confirmMessage")}
                confirmLabel={t("inventorySync.location.save")}
                cancelLabel={t("common.cancel")}
              >
                {t("inventorySync.location.save")}
              </ConfirmSubmitButton>
              {o.locationId && !o.locationConfirmation ? (
                <Button type="submit" name="intent" value="confirmLocation" size="sm" disabled={busy} formNoValidate>
                  {t("inventorySync.location.confirmCurrent")}
                </Button>
              ) : null}
            </Stack>
          </Stack>
        </Form>
      </Stack>
    </Disclosure>
  );
}

function FailuresCard({ data }: { data: LoaderData }) {
  const t = useT();
  const locale = useLocale();
  type Row = LoaderData["overview"]["recentFailures"][number];
  const columns: Array<DataTableColumn<Row>> = [
    {
      key: "product",
      header: t("inventorySync.col.product"),
      primary: true,
      render: (r) => (
        <Stack gap={1}>
          <Text weight="semibold">{r.title}</Text>
          <Text variant="caption" tone="subdued">
            {[r.variantTitle, r.sku].filter(Boolean).join(" · ") || "—"}
          </Text>
        </Stack>
      ),
    },
    { key: "change", header: t("inventorySync.col.change"), align: "end", render: (r) => <Text numeric>{signed(r.delta)}</Text> },
    { key: "type", header: t("inventorySync.col.type"), render: (r) => t(`movementType.${r.type}`) },
    { key: "code", header: t("inventorySync.col.error"), render: (r) => failureText(t, r.code) },
    { key: "date", header: t("inventorySync.col.date"), render: (r) => formatDateTime(r.createdAt, locale) },
  ];
  return (
    <Card title={t("inventorySync.failures.title")} description={t("inventorySync.failures.help")}>
      <DataTable columns={columns} rows={data.overview.recentFailures} rowKey={(r) => r.movementId} caption={t("inventorySync.failures.title")} />
    </Card>
  );
}

function failureText(t: TFunction, code: string | null): string {
  if (!code) return "—";
  if (code === "idempotency_window") return t("inventorySync.failure.idempotency_window");
  return `${t("inventorySync.failure.shopify")} (${code})`;
}

function FiltersCard({ data, isFiltered, resetHref }: { data: LoaderData; isFiltered: boolean; resetHref: string }) {
  const t = useT();
  const busy = useNavigation().state === "loading";
  return (
    <Card>
      <Disclosure collapsedOnMobile summary={t("common.filters")}>
        <Form method="get" role="search">
          {data.filters.status !== "open" ? <input type="hidden" name="status" value={data.filters.status} /> : null}
          <Stack gap={3}>
            <Grid columns={{ xs: 1, md: 3 }} gap={3}>
              <TextField
                id="inventory-sync-q"
                type="search"
                name="q"
                label={t("inventorySync.filters.search")}
                placeholder={t("inventorySync.filters.searchPlaceholder")}
                defaultValue={data.filters.q}
                maxLength={MAX_QUERY}
                autoComplete="off"
              />
              <Select
                id="inventory-sync-model"
                name="model"
                label={t("inventorySync.filters.model")}
                placeholder={t("inventorySync.filters.allModels")}
                options={data.facets.models.map((m) => ({ value: m, label: m }))}
                defaultValue={data.filters.model ?? ""}
              />
              <Select
                id="inventory-sync-color"
                name="color"
                label={t("inventorySync.filters.color")}
                placeholder={t("inventorySync.filters.allColors")}
                options={data.facets.colors.map((c) => ({ value: c, label: c }))}
                defaultValue={data.filters.color ?? ""}
              />
            </Grid>
            <Stack direction="horizontal" gap={2}>
              <Button type="submit" variant="primary" size="sm" loading={busy}>
                {t("common.apply")}
              </Button>
              <Button to={resetHref} size="sm" disabled={!isFiltered}>
                {t("common.reset")}
              </Button>
            </Stack>
          </Stack>
        </Form>
      </Disclosure>
    </Card>
  );
}

function ConflictsTable({ data }: { data: LoaderData }) {
  const t = useT();
  const locale = useLocale();
  const busy = useNavigation().state !== "idle";
  const [selected, setSelected] = useState<readonly string[]>([]);
  const canAct = data.mode === "production" && data.permissions.adjust;
  const rows = data.conflicts;
  const selectable = canAct && data.filters.status === "open" && rows.some((r) => r.resolvable);
  const preview = useMemo(() => {
    const chosen = rows.filter((r) => selected.includes(r.id));
    const resolvable = chosen.filter((r) => r.resolvable);
    return {
      count: resolvable.length,
      skipped: chosen.length - resolvable.length,
      // Зміна фактичного залишку — лише непояснена частина (так само рахує сервер).
      units: resolvable.reduce((s, r) => s + (r.unexplained ?? 0), 0),
      explained: resolvable.filter((r) => r.expectedDiff !== 0).length,
      risky: resolvable.filter(
        (r) =>
          r.failedPushes > 0 ||
          r.uncertain ||
          r.unsentDelta !== 0 ||
          r.reservationExcess > 0 ||
          r.shopifyOtherStates > 0 ||
          r.returnsAwaiting > 0 ||
          r.pushAttemptAt !== null,
      ).length,
    };
  }, [rows, selected]);

  const columns: Array<DataTableColumn<ConflictView>> = [
    {
      key: "product",
      header: t("inventorySync.col.product"),
      primary: true,
      render: (r) => (
        <Stack as="span" direction="horizontal" gap={2} align="center" wrap={false}>
          <Thumbnail src={r.imageUrl} alt="" size="sm" />
          <Stack as="span" gap={0}>
            <Text as="span" weight="semibold">
              {r.title}
            </Text>
            <Text as="span" variant="caption" tone="subdued">
              {[r.variantTitle, r.sku].filter(Boolean).join(" · ") || "—"}
            </Text>
          </Stack>
        </Stack>
      ),
    },
    {
      key: "app",
      header: t("inventorySync.col.app"),
      align: "end",
      render: (r) => <Text numeric>{r.appAvailable === null ? "—" : formatNumber(r.appAvailable, locale)}</Text>,
    },
    {
      key: "shopify",
      header: t("inventorySync.col.shopify"),
      align: "end",
      render: (r) => <Text numeric>{r.shopifyAvailable === null ? "—" : formatNumber(r.shopifyAvailable, locale)}</Text>,
    },
    {
      key: "diff",
      header: t("inventorySync.col.diff"),
      align: "end",
      render: (r) =>
        r.diff === null ? (
          "—"
        ) : (
          <Stack as="span" gap={1} align="end">
            <Badge tone={r.diff === 0 ? "neutral" : r.diff > 0 ? "info" : "warning"}>{signed(r.diff)}</Badge>
            {r.expectedDiff !== 0 && r.unexplained !== null ? (
              <Text as="span" variant="caption" tone="subdued">
                {t("inventorySync.col.unexplained", { count: signed(r.unexplained) })}
              </Text>
            ) : null}
          </Stack>
        ),
    },
    { key: "why", header: t("inventorySync.col.explanation"), render: (r) => <Explanation row={r} /> },
    {
      key: "observed",
      header: t("inventorySync.col.observed"),
      hideOnMobile: true,
      render: (r) => formatDateTime(r.observedAt ?? r.createdAt, locale),
    },
    {
      key: "actions",
      header: t("inventorySync.col.actions"),
      render: (r) =>
        r.status === "open" ? (
          canAct ? (
            <RowActions row={r} busy={busy} canWrite={data.overview.canWrite} />
          ) : (
            <Badge>{t("inventorySync.conflictStatus.open")}</Badge>
          )
        ) : (
          <Resolved row={r} />
        ),
    },
  ];

  return (
    <Stack gap={3}>
      {selectable ? (
        <Card>
          <Form id={BULK_FORM_ID} method="post" aria-label={t("inventorySync.bulk.label")}>
            <Stack direction="horizontal" gap={3} align="center" justify="between">
              <Text variant="body-sm" tone="subdued" as="span">
                {preview.count + preview.skipped === 0 ? t("inventorySync.bulk.hint") : t("common.selected", { count: preview.count + preview.skipped })}
              </Text>
              <ConfirmSubmitButton
                name="intent"
                value="bulkAccept"
                size="sm"
                disabled={preview.count === 0 || busy}
                title={t("inventorySync.bulk.title")}
                confirmLabel={t("inventorySync.bulk.confirm")}
                cancelLabel={t("common.cancel")}
                message={
                  <Stack gap={2}>
                    <Text weight="semibold">{t("inventorySync.bulk.count", { count: preview.count, units: signed(preview.units) })}</Text>
                    {preview.skipped > 0 ? <Text>{t("inventorySync.bulk.skipped", { count: preview.skipped })}</Text> : null}
                    {preview.explained > 0 ? <Text>{t("inventorySync.bulk.explained", { count: preview.explained })}</Text> : null}
                    {preview.risky > 0 ? <Text tone="warning">{t("inventorySync.bulk.warning", { count: preview.risky })}</Text> : null}
                    <Text>{t("inventorySync.bulk.help")}</Text>
                  </Stack>
                }
              >
                {t("inventorySync.bulk.button")}
              </ConfirmSubmitButton>
            </Stack>
          </Form>
        </Card>
      ) : null}
      <Card padded={false}>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          caption={t("inventorySync.conflicts.title")}
          selection={
            selectable
              ? {
                  name: "ids",
                  value: (r) => r.id,
                  label: (r) => t("inventorySync.bulk.select", { title: r.title }),
                  formId: BULK_FORM_ID,
                  allLabel: t("common.selectAll"),
                  onChange: setSelected,
                }
              : undefined
          }
          emptyState={
            <Text tone="subdued">{data.filters.status === "open" ? t("inventorySync.conflicts.empty") : t("inventorySync.conflicts.emptyOther")}</Text>
          }
        />
      </Card>
    </Stack>
  );
}

function Explanation({ row }: { row: ConflictView }) {
  const t = useT();
  const locale = useLocale();
  const lines: string[] = [];
  if (row.origin === "opened_with_internal_history") lines.push(t("inventorySync.why.openedWithHistory"));
  if (!row.resolvable && row.status === "open") lines.push(t("inventorySync.why.needsReconcile"));
  if (row.pushAttemptAt) lines.push(t("inventorySync.why.pushPending", { date: formatDateTime(row.pushAttemptAt, locale) }));
  if (row.unsentDelta !== 0) lines.push(t("inventorySync.why.unsent", { count: row.unsentCount, delta: signed(row.unsentDelta) }));
  if (row.committedNotReserved > 0) lines.push(t("inventorySync.why.committed", { count: row.committedNotReserved }));
  if (row.reservationExcess > 0) lines.push(t("inventorySync.why.reservationExcess", { count: row.reservationExcess }));
  if (row.failedPushes > 0) lines.push(t("inventorySync.why.failedPushes", { count: row.failedPushes, delta: signed(row.failedDelta) }));
  if (row.inFlight > 0) lines.push(t("inventorySync.why.inFlight", { count: row.inFlight }));
  if (row.returnsPending > 0) lines.push(t("inventorySync.why.returnsPending", { count: row.returnsPending }));
  if (row.returnsAwaiting > 0) lines.push(t("inventorySync.why.returnsAwaiting", { count: row.returnsAwaiting }));
  if (row.shopifyOtherStates > 0) lines.push(t("inventorySync.why.otherStates", { count: row.shopifyOtherStates }));
  if (row.uncertain && row.returnsPending === 0) lines.push(t("inventorySync.why.uncertain"));
  if (row.autoApplyBlocked) lines.push(t("inventorySync.why.autoBlocked"));
  if (lines.length === 0) lines.push(t("inventorySync.why.external"));
  if (row.autoApplyBlockers.length > 0) lines.push(t("inventorySync.why.autoSkipped"));
  return (
    <Stack gap={1}>
      {lines.map((l) => (
        <Text key={l} variant="caption">
          {l}
        </Text>
      ))}
    </Stack>
  );
}

function Resolved({ row }: { row: ConflictView }) {
  const t = useT();
  const locale = useLocale();
  return (
    <Stack gap={1}>
      <Badge tone={row.status === "dismissed" ? "neutral" : "success"}>{t(`inventorySync.conflictStatus.${row.status}`)}</Badge>
      {row.resolution ? (
        <Text variant="caption" tone="subdued">
          {t(`inventorySync.resolution.${row.resolution}`)} · {formatDateTime(row.resolvedAt, locale)}
        </Text>
      ) : null}
    </Stack>
  );
}

function RowActions({ row, busy, canWrite }: { row: ConflictView; busy: boolean; canWrite: boolean }) {
  const t = useT();
  if (!row.resolvable) {
    return (
      <Form method="post">
        <input type="hidden" name="stockItemId" value={row.stockItemId} />
        <Button type="submit" name="intent" value="reconcileItem" size="sm" disabled={busy}>
          {t("inventorySync.action.reconcileItem")}
        </Button>
      </Form>
    );
  }
  // Дії змінюють лише непояснену частину різниці (див. conflicts.server.ts); «Надіслати склад» — без одиниць, які
  // Shopify тримає в інших станах, і без повернень, які Shopify поповнить сам (pure.ts pushPlan).
  const change = row.unexplained ?? 0;
  const pushDelta = row.pushDelta ?? -change;
  const shopifyTarget = row.shopifyAvailable === null ? null : row.shopifyAvailable + pushDelta;
  return (
    <Stack gap={2}>
      <Form method="post">
        <input type="hidden" name="conflictId" value={row.id} />
        <Stack direction="horizontal" gap={2}>
          <ConfirmSubmitButton
            name="intent"
            value="accept"
            size="sm"
            disabled={busy}
            title={t("inventorySync.action.accept.title")}
            message={
              <Stack gap={2}>
                <Text>{t("inventorySync.action.accept.message", { diff: signed(change) })}</Text>
                {row.expectedDiff !== 0 ? <Text>{t("inventorySync.action.explainedKept", { count: Math.abs(row.expectedDiff) })}</Text> : null}
                {row.unsentDelta !== 0 ? <Text tone="warning">{t("inventorySync.action.accept.unsentWarning", { delta: signed(row.unsentDelta) })}</Text> : null}
                {row.returnsAwaiting > 0 ? (
                  <Text tone="warning">{t("inventorySync.action.accept.awaitingWarning", { count: row.returnsAwaiting })}</Text>
                ) : null}
                {row.shopifyOtherStates > 0 ? (
                  <Text tone="warning">{t("inventorySync.action.accept.otherStatesWarning", { count: row.shopifyOtherStates })}</Text>
                ) : null}
                {row.reservationExcess > 0 ? (
                  <Text tone="warning">{t("inventorySync.action.reservationWarning", { count: row.reservationExcess })}</Text>
                ) : null}
                {row.failedPushes > 0 || row.uncertain ? <Text tone="warning">{t("inventorySync.action.accept.warning")}</Text> : null}
              </Stack>
            }
            confirmLabel={t("inventorySync.action.accept")}
            cancelLabel={t("common.cancel")}
          >
            {t("inventorySync.action.accept")}
          </ConfirmSubmitButton>
          {canWrite && !row.pushBlockedOtherStates ? (
            <ConfirmSubmitButton
              name="intent"
              value="pushApp"
              size="sm"
              disabled={busy}
              title={t("inventorySync.action.pushApp.title")}
              message={
                <Stack gap={2}>
                  {pushDelta !== 0 ? (
                    <Text>
                      {t("inventorySync.action.pushApp.message", { delta: signed(pushDelta), to: shopifyTarget ?? "—", shopify: row.shopifyAvailable ?? "—" })}
                    </Text>
                  ) : (
                    <Text>{t("inventorySync.action.pushApp.onlyReturns")}</Text>
                  )}
                  {row.expectedDiff !== 0 ? <Text>{t("inventorySync.action.explainedKept", { count: Math.abs(row.expectedDiff) })}</Text> : null}
                  {row.pushHeldOtherStates > 0 ? (
                    <Text>{t("inventorySync.action.pushApp.heldOtherStates", { count: row.pushHeldOtherStates })}</Text>
                  ) : null}
                  {row.pushHeldAwaiting > 0 ? (
                    <>
                      <Text tone="warning">{t("inventorySync.action.pushApp.heldAwaiting", { count: row.pushHeldAwaiting })}</Text>
                      <Checkbox
                        id={`include-returns-${row.id}`}
                        name="includeReturns"
                        label={t("inventorySync.action.pushApp.includeReturns", { count: row.pushHeldAwaiting })}
                      />
                    </>
                  ) : null}
                  {row.reservationExcess > 0 ? (
                    <Text tone="warning">{t("inventorySync.action.reservationWarning", { count: row.reservationExcess })}</Text>
                  ) : null}
                  {row.uncertain ? <Text tone="warning">{t("inventorySync.action.pushApp.warning")}</Text> : null}
                </Stack>
              }
              confirmLabel={t("inventorySync.action.pushApp")}
              cancelLabel={t("common.cancel")}
            >
              {t("inventorySync.action.pushApp")}
            </ConfirmSubmitButton>
          ) : null}
        </Stack>
      </Form>
      {canWrite ? null : (
        <Text variant="caption" tone="subdued">
          {t("inventorySync.action.pushApp.noScope")}
        </Text>
      )}
      {canWrite && row.pushBlockedOtherStates ? (
        <Text variant="caption" tone="subdued">
          {t("inventorySync.action.pushApp.otherStates", { count: row.shopifyOtherStates })}
        </Text>
      ) : null}
      {row.pushAttemptAt ? (
        <Text variant="caption" tone="subdued">
          {t("inventorySync.action.dismiss.pushPending")}
        </Text>
      ) : null}
      <Disclosure summary={t("inventorySync.action.dismiss")}>
        <Form method="post">
          <input type="hidden" name="conflictId" value={row.id} />
          <Stack gap={2}>
            <TextField
              id={`dismiss-note-${row.id}`}
              name="note"
              label={t("inventorySync.action.dismiss.note")}
              multiline={2}
              maxLength={500}
              required
            />
            <Button type="submit" name="intent" value="dismiss" size="sm" disabled={busy}>
              {t("inventorySync.action.dismiss.submit")}
            </Button>
          </Stack>
        </Form>
      </Disclosure>
    </Stack>
  );
}

export { RouteErrorBoundary as ErrorBoundary } from "~/components/route-error";

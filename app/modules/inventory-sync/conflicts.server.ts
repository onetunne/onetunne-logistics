/**
 * Розбіжності залишків із Shopify: дії власника (warehouse.adjust) і перелік для сторінки «Склад → Shopify».
 *
 * Обидві дії розв'язують лише НЕПОЯСНЕНУ частину різниці (unexplainedDiff = diff − expectedDiff): одиниці, які Shopify
 * закріпив під неоплачені/ще не синхронізовані замовлення, фізично на складі й зникнуть із різниці самі.
 * - «Прийняти Shopify»: рух shopify_external (on_hand += непояснене) через lockBalances + applyMovements,
 *   ключ shopify_external:<id розбіжності> — повтор/подвійне натискання не створює другого руху. Якщо баланс
 *   змінився після звірки (inventory_balances.version) або змінилася локація складу, спостереження застаріло → нова
 *   звірка позиції.
 * - «Надіслати значення складу»: inventoryAdjustQuantities (available, delta = −непояснене, changeFromQuantity =
 *   побачене значення Shopify — CAS; ключ ot-cf-<id>-<observationSeq>). CHANGE_FROM_QUANTITY_STALE → нова звірка.
 *   Явна дія власника: працює за наявності write_inventory незалежно від налаштування автоматичної передачі.
 * - «Відхилити» (з приміткою): розбіжність закривається без змін залишку.
 * Демо (без Shopify) — дії відхиляються (inventorySync.demoUnavailable).
 */
import { and, count, desc, eq, ilike, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import {
  INVENTORY_CONFLICT_STATUSES,
  inventoryConflicts,
  inventoryMovements,
  productVariants,
  products,
  stockItems,
  warehouses,
  type InventoryConflictStatus,
} from "~/db/schema";
import { requirePermission } from "~/domain/permissions";
import { DomainError, NotFoundError } from "~/lib/errors";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  ADJUST_ERROR,
  INVENTORY_ADJUST_MUTATION,
  buildAdjustInput,
  type GqlInventoryAdjustResult,
} from "~/integrations/shopify/inventory-graphql";
import { writeAudit } from "~/modules/audit/audit.server";
import { lockBalances } from "~/modules/inventory/ledger.server";
import type { ServiceContext } from "~/server/types";
import { acceptInTx, settleFailedMovements, type ConflictRow } from "./accept.server";
import { loadSyncEnvironment } from "./environment.server";
import { conflictOrigin, parseObservation, type ConflictObservation } from "./observation";
import { classifyAdjustErrors, conflictPushKey, conflictReferenceUri, unexplainedDiff } from "./pure";
import { reconcileStockItemNow, type ReconcileOutcome } from "./reconcile.server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_BULK_CONFLICTS = 200;
export const MAX_DISMISS_NOTE = 500;

function assertShopifyMode(ctx: ServiceContext) {
  if (ctx.mode !== "production") throw new DomainError("inventorySync.demoUnavailable", 409);
}

async function conflictHead(db: DbOrTx, conflictId: string) {
  if (!UUID_RE.test(conflictId)) throw new NotFoundError("inventoryConflict");
  const [row] = await db
    .select({ id: inventoryConflicts.id, stockItemId: inventoryConflicts.stockItemId, warehouseId: inventoryConflicts.warehouseId })
    .from(inventoryConflicts)
    .where(eq(inventoryConflicts.id, conflictId));
  if (!row) throw new NotFoundError("inventoryConflict");
  return row;
}

type LockedCheck =
  | { status: "ok"; conflict: ConflictRow; obs: ConflictObservation }
  | { status: "already" | "stale" | "needs_reconcile" };

/**
 * Блокування (баланс → розбіжність) і перевірки, спільні для «прийняти» й «надіслати»: спостереження актуальне, якщо
 * баланс не змінився, у позиції немає неперенесених рухів і локація складу та сама, де Shopify прочитано.
 */
async function lockForResolution(
  tx: Tx,
  head: { id: string; stockItemId: string; warehouseId: string },
  doneStatus: InventoryConflictStatus,
): Promise<LockedCheck> {
  const locked = await lockBalances(tx, [{ warehouseId: head.warehouseId, stockItemId: head.stockItemId }]);
  const balance = [...locked.values()][0]!;
  const [conflict] = await tx.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, head.id)).for("update");
  if (!conflict) throw new NotFoundError("inventoryConflict");
  if (conflict.status === doneStatus) return { status: "already" };
  if (conflict.status !== "open") throw new DomainError("inventorySync.conflictResolved", 409);
  const obs = parseObservation(conflict.details);
  if (!obs) return { status: "needs_reconcile" };
  if (balance.version !== obs.appVersion) return { status: "stale" };
  // Локацію складу змінено після звірки: різниця виміряна не там (і «надіслати склад» пішло б у стару локацію).
  const [warehouse] = await tx
    .select({ locationId: warehouses.shopifyLocationId })
    .from(warehouses)
    .where(eq(warehouses.id, head.warehouseId));
  if (!warehouse?.locationId || warehouse.locationId !== obs.locationId) return { status: "needs_reconcile" };
  if (unexplainedDiff(obs) === 0) return { status: "needs_reconcile" };
  const [pending] = await tx
    .select({ c: count() })
    .from(inventoryMovements)
    .where(
      and(
        eq(inventoryMovements.warehouseId, head.warehouseId),
        eq(inventoryMovements.stockItemId, head.stockItemId),
        eq(inventoryMovements.shopifySyncState, "pending"),
      ),
    );
  if (Number(pending?.c ?? 0) > 0) return { status: "stale" };
  return { status: "ok", conflict, obs };
}

// ---------------------------------------------------------------------------
// Прийняти значення Shopify
// ---------------------------------------------------------------------------

export type AcceptResult =
  /** delta — фактична зміна on_hand (непояснена частина різниці). */
  | { status: "accepted"; movementId: string | null; delta: number }
  | { status: "already" }
  | { status: "stale" | "needs_reconcile"; reconciled?: ReconcileOutcome | null };

/**
 * «Прийняти значення Shopify». Застаріле спостереження → stale (з admin — одразу нова звірка позиції, результат у
 * reconciled). Кидає DomainError("inventory.insufficient"), якщо on_hand став би від'ємним, а це заборонено.
 */
export async function acceptShopifyValue(
  ctx: ServiceContext,
  conflictId: string,
  opts: { admin?: () => Promise<AdminGraphql> } = {},
): Promise<AcceptResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const head = await conflictHead(ctx.db, conflictId);
  const result = await ctx.db.transaction(async (tx): Promise<AcceptResult> => {
    const check = await lockForResolution(tx, head, "accepted_shopify");
    if (check.status !== "ok") return { status: check.status };
    const { movementId, delta } = await acceptInTx(tx, ctx.actor, check.conflict, check.obs, "manual", ctx.now());
    return { status: "accepted", movementId, delta };
  });
  if ((result.status === "stale" || result.status === "needs_reconcile") && opts.admin) {
    return { ...result, reconciled: await reconcileStockItemNow(ctx.db, await opts.admin(), head.stockItemId) };
  }
  return result;
}

export interface BulkAcceptResult {
  accepted: number;
  already: number;
  stale: number;
  failed: number;
  /** Сумарна зміна on_hand прийнятих. */
  units: number;
}

/**
 * Масове «прийняти Shopify» (кожна розбіжність — окрема транзакція). Застарілі пропускаються (з admin — одразу
 * звіряються заново, щоб власник побачив свіжі значення).
 */
export async function acceptShopifyValues(
  ctx: ServiceContext,
  conflictIds: readonly string[],
  opts: { admin?: () => Promise<AdminGraphql> } = {},
): Promise<BulkAcceptResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const ids = [...new Set(conflictIds)].filter((id) => UUID_RE.test(id));
  if (ids.length === 0) throw new DomainError("inventorySync.nothingSelected", 400);
  if (ids.length > MAX_BULK_CONFLICTS) throw new DomainError("inventorySync.tooMany", 400, { max: MAX_BULK_CONFLICTS });
  const out: BulkAcceptResult = { accepted: 0, already: 0, stale: 0, failed: 0, units: 0 };
  for (const id of ids) {
    try {
      const r = await acceptShopifyValue(ctx, id, opts);
      if (r.status === "accepted") {
        out.accepted++;
        out.units += r.delta;
      } else if (r.status === "already") out.already++;
      else out.stale++;
    } catch (e) {
      if (!(e instanceof DomainError)) throw e;
      out.failed++;
    }
  }
  await writeAudit(ctx.db, ctx.actor, "inventory_sync.conflicts_bulk_accepted", { type: "inventory_conflict" }, { ...out });
  return out;
}

// ---------------------------------------------------------------------------
// Надіслати значення складу
// ---------------------------------------------------------------------------

export type PushAppResult =
  | { status: "pushed"; delta: number }
  | { status: "already" }
  | { status: "stale" | "needs_reconcile"; reconciled: ReconcileOutcome | null }
  | { status: "in_progress" }
  | { status: "unknown" }
  | { status: "failed"; code: string };

/**
 * «Надіслати значення складу» в Shopify: available −= непояснена різниця (Shopify стане «доступно» складу мінус
 * одиниці, які він закріпив під неоплачені замовлення) з CAS на побачене значення. Повтор із тим самим спостереженням —
 * той самий ключ (Shopify не застосує вдруге). Застаріле → нова звірка.
 */
export async function pushAppValue(
  ctx: ServiceContext,
  admin: AdminGraphql,
  conflictId: string,
  opts: { appUrl: string | null },
): Promise<PushAppResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const env = await loadSyncEnvironment(ctx.db);
  if (!env.shop) throw new DomainError("shopify.notInstalled", 409);
  if (!env.canWrite) throw new DomainError("inventorySync.missingWriteScope", 409);
  const head = await conflictHead(ctx.db, conflictId);
  const now = ctx.now();
  const prepared = await ctx.db.transaction(async (tx) => {
    const check = await lockForResolution(tx, head, "pushed_app");
    if (check.status !== "ok") return check;
    const key = conflictPushKey(check.conflict.id, check.obs.observationSeq);
    await tx
      .update(inventoryConflicts)
      .set({ details: { ...check.obs, pushAttempt: { key, at: now.toISOString(), by: ctx.actor.id } } })
      .where(eq(inventoryConflicts.id, check.conflict.id));
    return { ...check, key };
  });
  if (prepared.status === "already") return { status: "already" };
  if (prepared.status !== "ok") {
    return { status: prepared.status, reconciled: await reconcileStockItemNow(ctx.db, admin, head.stockItemId) };
  }
  const { obs, key, conflict } = prepared;
  const delta = -unexplainedDiff(obs);
  const input = buildAdjustInput({
    reason: "correction",
    referenceDocumentUri: conflictReferenceUri(opts.appUrl, conflict.id),
    inventoryItemId: obs.inventoryItemId,
    locationId: obs.locationId,
    delta,
    changeFromQuantity: obs.shopifyAvailable,
  });
  let data: GqlInventoryAdjustResult;
  try {
    data = await admin<GqlInventoryAdjustResult>(INVENTORY_ADJUST_MUTATION, { input, idempotencyKey: key });
  } catch (e) {
    if (!(e instanceof ShopifyApiError)) throw e;
    // Результат невідомий (тайм-аут/обмеження): повтор із тим самим ключем безпечний.
    return e.retryable ? { status: "unknown" } : { status: "failed", code: (e.code ?? "API_ERROR").slice(0, 64) };
  }
  const payload = data.inventoryAdjustQuantities;
  if (!payload) return { status: "unknown" };
  const error = classifyAdjustErrors(payload.userErrors ?? []);
  if (error?.kind === "retry") return error.code === ADJUST_ERROR.concurrent ? { status: "in_progress" } : { status: "unknown" };
  if (error) {
    if (error.code === ADJUST_ERROR.stale || error.code === ADJUST_ERROR.previousFailed) {
      await writeAudit(ctx.db, ctx.actor, "inventory_sync.conflict_push_stale", { type: "inventory_conflict", id: conflict.id }, { code: error.code });
      return { status: "stale", reconciled: await reconcileStockItemNow(ctx.db, admin, head.stockItemId) };
    }
    await writeAudit(ctx.db, ctx.actor, "inventory_sync.conflict_push_failed", { type: "inventory_conflict", id: conflict.id }, {
      code: error.code,
      field: error.field,
    });
    return { status: "failed", code: error.code.slice(0, 64) };
  }
  if (!payload.inventoryAdjustmentGroup) return { status: "unknown" };
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(inventoryConflicts)
      .set({
        status: "pushed_app",
        resolvedAt: now,
        resolvedBy: ctx.actor.id,
        details: { ...obs, resolution: "pushed_app", pushKey: key },
      })
      .where(and(eq(inventoryConflicts.id, conflict.id), eq(inventoryConflicts.status, "open")));
    const settled = await settleFailedMovements(tx, obs.failedMovementIds, "pushed");
    await writeAudit(tx, ctx.actor, "inventory_sync.conflict_pushed", { type: "inventory_conflict", id: conflict.id }, { delta, settledFailed: settled });
  });
  return { status: "pushed", delta };
}

// ---------------------------------------------------------------------------
// Відхилити
// ---------------------------------------------------------------------------

export async function dismissConflict(ctx: ServiceContext, conflictId: string, note: string): Promise<{ status: "dismissed" | "already" }> {
  requirePermission(ctx.actor, "warehouse.adjust");
  assertShopifyMode(ctx);
  const text = note.trim();
  if (text.length === 0) throw new DomainError("inventorySync.noteRequired", 400);
  if (text.length > MAX_DISMISS_NOTE) throw new DomainError("inventorySync.noteTooLong", 400, { max: MAX_DISMISS_NOTE });
  const head = await conflictHead(ctx.db, conflictId);
  return ctx.db.transaction(async (tx) => {
    const [conflict] = await tx.select().from(inventoryConflicts).where(eq(inventoryConflicts.id, head.id)).for("update");
    if (!conflict) throw new NotFoundError("inventoryConflict");
    if (conflict.status === "dismissed") return { status: "already" as const };
    if (conflict.status !== "open") throw new DomainError("inventorySync.conflictResolved", 409);
    const obs = parseObservation(conflict.details);
    await tx
      .update(inventoryConflicts)
      .set({
        status: "dismissed",
        resolvedAt: ctx.now(),
        resolvedBy: ctx.actor.id,
        details: { ...(conflict.details ?? {}), resolution: "dismissed", dismissNote: text },
      })
      .where(eq(inventoryConflicts.id, conflict.id));
    const settled = obs ? await settleFailedMovements(tx, obs.failedMovementIds, "skipped") : 0;
    // Примітку власника в журнал не пишемо (вільний текст) — вона в самій розбіжності.
    await writeAudit(tx, ctx.actor, "inventory_sync.conflict_dismissed", { type: "inventory_conflict", id: conflict.id }, { settledFailed: settled });
    return { status: "dismissed" as const };
  });
}

// ---------------------------------------------------------------------------
// Перелік
// ---------------------------------------------------------------------------

export const CONFLICT_STATUS_FILTERS = ["open", "resolved", "all", ...INVENTORY_CONFLICT_STATUSES.filter((s) => s !== "open")] as const;
export type ConflictStatusFilter = (typeof CONFLICT_STATUS_FILTERS)[number];

export function isConflictStatusFilter(v: unknown): v is ConflictStatusFilter {
  return typeof v === "string" && (CONFLICT_STATUS_FILTERS as readonly string[]).includes(v);
}

export interface ConflictFilters {
  status?: ConflictStatusFilter;
  /** Одна розбіжність за id (посилання з історії залишків Shopify); статус тоді не фільтрується. */
  conflictId?: string;
  models?: string[];
  colors?: string[];
  search?: string;
}

export interface ConflictView {
  id: string;
  status: InventoryConflictStatus;
  createdAt: Date;
  resolvedAt: Date | null;
  stockItemId: string;
  variantId: string | null;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  imageUrl: string | null;
  /** null — розбіжність без спостереження звірки (спершу «Звірити»). */
  appAvailable: number | null;
  shopifyAvailable: number | null;
  appOnHand: number;
  shopifyOnHand: number;
  diff: number | null;
  /** Непояснена частина різниці (diff − expectedDiff) — її змінюють «прийняти Shopify» / «надіслати склад». */
  unexplained: number | null;
  expectedDiff: number;
  committedNotReserved: number;
  inFlight: number;
  shopifyOtherStates: number;
  failedPushes: number;
  failedDelta: number;
  uncertain: boolean;
  observedAt: string | null;
  origin: string | null;
  resolution: string | null;
  autoApplyBlocked: string | null;
  /** Можна прийняти/надіслати (є спостереження звірки). */
  resolvable: boolean;
}

function statusCondition(status: ConflictStatusFilter): SQL | undefined {
  if (status === "all") return undefined;
  if (status === "resolved") return sql`${inventoryConflicts.status} <> 'open'`;
  return eq(inventoryConflicts.status, status);
}

const likePattern = (search: string) => `%${search.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function filterConditions(filters: ConflictFilters): SQL | undefined {
  const search = filters.search?.trim() ? likePattern(filters.search) : null;
  if (filters.conflictId !== undefined) {
    return UUID_RE.test(filters.conflictId) ? eq(inventoryConflicts.id, filters.conflictId) : sql`false`;
  }
  return and(
    statusCondition(filters.status ?? "open"),
    filters.models?.length ? inArray(productVariants.model, filters.models) : undefined,
    filters.colors?.length ? inArray(productVariants.color, filters.colors) : undefined,
    search
      ? or(ilike(products.title, search), ilike(productVariants.title, search), ilike(productVariants.sku, search), ilike(productVariants.barcode, search))
      : undefined,
  );
}

type ListRow = {
  c: ConflictRow;
  variantId: string | null;
  title: string | null;
  variantTitle: string | null;
  sku: string | null;
  model: string | null;
  color: string | null;
  variantImage: string | null;
  productImage: string | null;
};

export async function listConflicts(
  db: DbOrTx,
  filters: ConflictFilters = {},
  page: { limit?: number; offset?: number } = {},
): Promise<{ rows: ConflictView[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(page.limit ?? 50), 1), 200);
  const offset = Math.max(Math.trunc(page.offset ?? 0), 0);
  const where = filterConditions(filters);
  const [rows, [totalRow]] = await Promise.all([
    db
      .select({
        c: inventoryConflicts,
        variantId: productVariants.id,
        title: products.title,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
        model: productVariants.model,
        color: productVariants.color,
        variantImage: productVariants.imageUrl,
        productImage: products.imageUrl,
      })
      .from(inventoryConflicts)
      .innerJoin(stockItems, eq(stockItems.id, inventoryConflicts.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(where)
      .orderBy(desc(inventoryConflicts.createdAt), desc(inventoryConflicts.id))
      .limit(limit)
      .offset(offset),
    db
      .select({ c: count() })
      .from(inventoryConflicts)
      .innerJoin(stockItems, eq(stockItems.id, inventoryConflicts.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(where),
  ]);
  return { total: Number(totalRow?.c ?? 0), rows: rows.map(toView) };
}

function toView(r: ListRow): ConflictView {
  const obs = parseObservation(r.c.details);
  const d = (r.c.details ?? {}) as Record<string, unknown>;
  return {
    id: r.c.id,
    status: r.c.status,
    createdAt: r.c.createdAt,
    resolvedAt: r.c.resolvedAt,
    stockItemId: r.c.stockItemId,
    variantId: r.variantId,
    title: r.title ?? "—",
    variantTitle: r.variantTitle,
    sku: r.sku,
    model: r.model,
    color: r.color,
    imageUrl: r.variantImage ?? r.productImage,
    appAvailable: obs?.appAvailable ?? null,
    shopifyAvailable: obs?.shopifyAvailable ?? r.c.shopifyAvailable,
    appOnHand: r.c.appOnHand,
    shopifyOnHand: r.c.shopifyOnHand,
    diff: obs ? obs.diff : null,
    unexplained: obs ? unexplainedDiff(obs) : null,
    expectedDiff: obs?.expectedDiff ?? r.c.expectedDiff,
    committedNotReserved: obs?.committedNotReserved ?? 0,
    inFlight: obs?.inFlight ?? 0,
    shopifyOtherStates: obs?.shopifyOtherStates ?? 0,
    failedPushes: obs?.failedMovementIds.length ?? 0,
    failedDelta: obs?.failedDelta ?? 0,
    uncertain: obs?.uncertain ?? false,
    observedAt: obs?.observedAt ?? null,
    origin: obs?.origin ?? conflictOrigin(r.c.details),
    resolution: typeof d.resolution === "string" ? d.resolution : null,
    autoApplyBlocked: typeof d.autoApplyBlocked === "string" ? d.autoApplyBlocked : null,
    resolvable: r.c.status === "open" && obs !== null,
  };
}

/** Значення фільтрів (моделі/кольори товарів, що мають розбіжності) і лічильники за станом. */
export async function conflictFacets(db: DbOrTx): Promise<{ models: string[]; colors: string[]; counts: Record<InventoryConflictStatus, number> }> {
  const facet = (column: typeof productVariants.model | typeof productVariants.color) =>
    db
      .selectDistinct({ v: column })
      .from(inventoryConflicts)
      .innerJoin(stockItems, eq(stockItems.id, inventoryConflicts.stockItemId))
      .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .where(isNotNull(column))
      .orderBy(column);
  const [models, colors, counts] = await Promise.all([
    facet(productVariants.model),
    facet(productVariants.color),
    db.select({ status: inventoryConflicts.status, c: count() }).from(inventoryConflicts).groupBy(inventoryConflicts.status),
  ]);
  const byStatus = Object.fromEntries(INVENTORY_CONFLICT_STATUSES.map((s) => [s, 0])) as Record<InventoryConflictStatus, number>;
  for (const r of counts) byStatus[r.status] = Number(r.c);
  return {
    models: models.map((m) => m.v).filter((v): v is string => Boolean(v)),
    colors: colors.map((c) => c.v).filter((v): v is string => Boolean(v)),
    counts: byStatus,
  };
}

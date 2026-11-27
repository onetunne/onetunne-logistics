/**
 * Передача внутрішніх змін залишку в Shopify (docs/stage5-design.md §10): завдання `inventory.push`.
 *
 * Що надсилається: рухи inventory_movements зі станом shopify_sync_state = pending (внутрішні зміни on_hand
 * відкритих товарів: надходження, коригування, брак, ремонт браку — див. movement-types.ts). Продажі й виконання
 * Shopify рахує сам — вони сюди не потрапляють.
 *
 * Як: для кожного руху (по позиціях, у порядку створення) — inventoryAdjustQuantities, name "available",
 * delta = on_hand_delta, changeFromQuantity: null (дельти комутативні, нічого не перезаписується),
 * @idempotent(key: "ot-mv-<id руху>"), referenceDocumentUri — посилання на рух у застосунку.
 * Повтор завдання (тайм-аут, збій мережі, IDEMPOTENCY_CONCURRENT_REQUEST, «Try again») — з ТИМ САМИМ ключем:
 * Shopify не застосує дельту вдруге. Рух, не підтверджений протягом 23 год від створення, не надсилається
 * (ключ живе 24 год) → failed «idempotency_window», власник звіряє.
 *
 * Стан: pending → pushed (успіх) / failed (помилка даних, IDEMPOTENCY_PREVIOUS_ATTEMPT_FAILED, вікно ключа) /
 * skipped (передачу вимкнено, немає дозволу write_inventory або зв'язку з товаром Shopify). Переходи — лише
 * compare-and-set (WHERE shopify_sync_state = 'pending'). Після невдалої передачі позиція одразу ставиться на звірку:
 * розбіжність покаже, що Shopify не отримав зміну, і власник обере «надіслати значення складу».
 */
import { and, asc, eq, inArray, lt, sql } from "drizzle-orm";
import type { Db, DbOrTx } from "~/db/client.server";
import { inventoryMovements, productVariants, stockItems } from "~/db/schema";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { logger } from "~/lib/logger.server";
import { ShopifyApiError, type AdminGraphql } from "~/integrations/shopify/admin-client.server";
import {
  INVENTORY_ADJUST_MUTATION,
  buildAdjustInput,
  type GqlInventoryAdjustResult,
} from "~/integrations/shopify/inventory-graphql";
import { writeAudit } from "~/modules/audit/audit.server";
import type { MovementType } from "~/modules/inventory/movement-types";
import { loadSyncEnvironment } from "./environment.server";
import { PUSH_BATCH } from "./jobs";
import { ensureWarehouseLocation } from "./location.server";
import {
  IDEMPOTENCY_WINDOW_MS,
  classifyAdjustErrors,
  movementReferenceUri,
  pushIdempotencyKey,
  shopifyReasonFor,
} from "./pure";
import { enqueueInventoryPush, scheduleItemReconcile } from "./schedule.server";

export type PushSkipReason = "push_off" | "missing_scope" | "not_installed" | "no_inventory_item";

export interface PushDeps {
  db: Db;
  admin: (shop: string) => Promise<AdminGraphql>;
  /** SHOPIFY_APP_URL (для referenceDocumentUri). */
  appUrl: string | null;
  now?: () => Date;
  /** Рухів за запуск (далі — наступне завдання). */
  limit?: number;
}

export interface PushRunResult {
  status: "done" | "more" | "skipped" | "location_required";
  pushed: number;
  failed: number;
  skipped: number;
  /** Не надіслано через вікно ключа (> 23 год). */
  expired: number;
  skipReason?: PushSkipReason;
}

/** Спроба передачі, яку слід повторити пізніше тим самим ключем (завдання → повтор із паузою). */
export class InventoryPushRetry extends ShopifyApiError {
  constructor(code: string) {
    super(`Shopify inventory push must be retried (${code})`, true, code);
    this.name = "InventoryPushRetry";
  }
}

type SyncTarget = "pushed" | "failed" | "skipped";

/** CAS: змінює стан лише рухів, які досі pending. Повертає id змінених. */
async function transition(db: DbOrTx, ids: readonly string[], to: SyncTarget): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .update(inventoryMovements)
    .set({ shopifySyncState: to })
    .where(and(inArray(inventoryMovements.id, [...ids]), eq(inventoryMovements.shopifySyncState, "pending")))
    .returning({ id: inventoryMovements.id });
  return rows.map((r) => r.id);
}

/** Позначити всі pending як skipped (передачу вимкнено / немає дозволу / магазин не встановлено). */
async function skipAllPending(db: Db, reason: PushSkipReason): Promise<number> {
  let total = 0;
  for (;;) {
    const batch = await db
      .select({ id: inventoryMovements.id })
      .from(inventoryMovements)
      .where(eq(inventoryMovements.shopifySyncState, "pending"))
      .limit(500);
    if (batch.length === 0) break;
    const changed = await transition(db, batch.map((b) => b.id), "skipped");
    total += changed.length;
    if (changed.length === 0) break;
  }
  if (total > 0) await writeAudit(db, SYSTEM_ACTOR, "inventory_sync.push_skipped", { type: "inventory_movement" }, { reason, count: total });
  return total;
}

async function recordFailure(db: DbOrTx, movementId: string, code: string, field: string | null = null) {
  await writeAudit(db, SYSTEM_ACTOR, "inventory_sync.push_failed", { type: "inventory_movement", id: movementId }, { code, field });
}

interface PendingRow {
  id: string;
  stockItemId: string;
  warehouseId: string;
  type: string;
  onHandDelta: number;
  reason: string | null;
  createdAt: Date;
  inventoryItemId: string | null;
}

/**
 * Один запуск передачі. Тимчасова помилка Shopify (обмеження, 5xx, мережа, «спробуйте ще раз») → кидає
 * ShopifyApiError(retryable): завдання повториться з паузою, рух лишиться pending і піде з тим самим ключем.
 */
export async function runInventoryPush(deps: PushDeps): Promise<PushRunResult> {
  const { db } = deps;
  const now = deps.now?.() ?? new Date();
  const result: PushRunResult = { status: "done", pushed: 0, failed: 0, skipped: 0, expired: 0 };
  const env = await loadSyncEnvironment(db);
  const skipReason: PushSkipReason | null =
    env.pushMode !== "deltas" ? "push_off" : !env.shop ? "not_installed" : !env.canWrite ? "missing_scope" : null;
  if (skipReason || !env.shop) {
    result.skipped = await skipAllPending(db, skipReason ?? "not_installed");
    return { ...result, status: "skipped", skipReason: skipReason ?? "not_installed" };
  }
  const shop = env.shop;

  // 1. Вікно ключа: старші за 23 год — не надсилаються (власник звіряє).
  const expiredRows = await db
    .update(inventoryMovements)
    .set({ shopifySyncState: "failed" })
    .where(
      and(
        eq(inventoryMovements.shopifySyncState, "pending"),
        lt(inventoryMovements.createdAt, new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS)),
      ),
    )
    .returning({ id: inventoryMovements.id, stockItemId: inventoryMovements.stockItemId });
  for (const row of expiredRows) await recordFailure(db, row.id, "idempotency_window");
  result.expired = expiredRows.length;
  result.failed += expiredRows.length;
  const failedItems = new Set(expiredRows.map((r) => r.stockItemId));

  // 2. Наступна порція pending (склад за замовчуванням; інші склади — коли з'являться локації для них).
  const limit = deps.limit ?? PUSH_BATCH;
  const pending: PendingRow[] = await db
    .select({
      id: inventoryMovements.id,
      stockItemId: inventoryMovements.stockItemId,
      warehouseId: inventoryMovements.warehouseId,
      type: inventoryMovements.type,
      onHandDelta: inventoryMovements.onHandDelta,
      reason: inventoryMovements.reason,
      createdAt: inventoryMovements.createdAt,
      inventoryItemId: productVariants.inventoryItemId,
    })
    .from(inventoryMovements)
    .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
    .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
    .where(and(eq(inventoryMovements.shopifySyncState, "pending"), eq(inventoryMovements.warehouseId, env.warehouse.id)))
    .orderBy(asc(inventoryMovements.stockItemId), asc(inventoryMovements.createdAt), asc(inventoryMovements.id))
    .limit(limit);

  const unlinked = pending.filter((p) => !p.inventoryItemId || p.onHandDelta === 0);
  if (unlinked.length > 0) {
    const changed = await transition(db, unlinked.map((p) => p.id), "skipped");
    result.skipped += changed.length;
    if (changed.length > 0) {
      await writeAudit(db, SYSTEM_ACTOR, "inventory_sync.push_skipped", { type: "inventory_movement" }, {
        reason: "no_inventory_item",
        count: changed.length,
      });
    }
  }
  const toPush = pending.filter((p) => p.inventoryItemId && p.onHandDelta !== 0);
  const itemGid = new Map(toPush.map((p) => [p.stockItemId, p.inventoryItemId!]));

  if (toPush.length > 0) {
    const admin = await deps.admin(shop);
    const location = await ensureWarehouseLocation(db, admin, env.warehouse);
    if (location.status !== "ready") {
      // Рухи лишаються pending: власник обирає локацію на сторінці «Склад → Shopify».
      logger.warn("inventory_sync.push_location_required", { status: location.status });
      await scheduleReconcileForFailures(db, shop, failedItems, itemGid);
      return { ...result, status: "location_required" };
    }
    try {
      for (const m of toPush) {
        const outcome = await pushOne(db, admin, m, location.locationId, deps.appUrl, now);
        if (outcome === "pushed") result.pushed++;
        else if (outcome === "failed") {
          result.failed++;
          failedItems.add(m.stockItemId);
        }
      }
    } finally {
      await scheduleReconcileForFailures(db, shop, failedItems, itemGid);
    }
  } else {
    await scheduleReconcileForFailures(db, shop, failedItems, itemGid);
  }

  if (pending.length >= limit) {
    await enqueueInventoryPush(db);
    result.status = "more";
  }
  if (result.pushed > 0 || result.failed > 0) {
    await writeAudit(db, SYSTEM_ACTOR, "inventory_sync.push_run", { type: "inventory_movement" }, {
      pushed: result.pushed,
      failed: result.failed,
      expired: result.expired,
      skipped: result.skipped,
    });
  }
  return result;
}

async function pushOne(
  db: Db,
  admin: AdminGraphql,
  m: PendingRow,
  locationId: string,
  appUrl: string | null,
  now: Date,
): Promise<"pushed" | "failed" | "gone"> {
  // Рух міг змінити стан (паралельний запуск, звірка) — надсилаємо лише досі pending і ще у вікні ключа.
  const [fresh] = await db
    .select({ state: inventoryMovements.shopifySyncState })
    .from(inventoryMovements)
    .where(eq(inventoryMovements.id, m.id));
  if (fresh?.state !== "pending") return "gone";
  if (now.getTime() - m.createdAt.getTime() > IDEMPOTENCY_WINDOW_MS) {
    const changed = await transition(db, [m.id], "failed");
    if (changed.length > 0) await recordFailure(db, m.id, "idempotency_window");
    return changed.length > 0 ? "failed" : "gone";
  }
  const input = buildAdjustInput({
    reason: shopifyReasonFor(m.type as MovementType, m.reason),
    referenceDocumentUri: movementReferenceUri(appUrl, m),
    inventoryItemId: m.inventoryItemId!,
    locationId,
    delta: m.onHandDelta,
    changeFromQuantity: null,
  });
  let data: GqlInventoryAdjustResult;
  try {
    data = await admin<GqlInventoryAdjustResult>(INVENTORY_ADJUST_MUTATION, { input, idempotencyKey: pushIdempotencyKey(m.id) });
  } catch (e) {
    // Тимчасова помилка: результат невідомий → повтор тим самим ключем (без подвійної дельти).
    if (!(e instanceof ShopifyApiError) || e.retryable) throw e;
    const changed = await transition(db, [m.id], "failed");
    if (changed.length > 0) await recordFailure(db, m.id, (e.code ?? "API_ERROR").slice(0, 64));
    return changed.length > 0 ? "failed" : "gone";
  }
  const payload = data.inventoryAdjustQuantities;
  if (!payload) throw new InventoryPushRetry("EMPTY_PAYLOAD");
  const error = classifyAdjustErrors(payload.userErrors ?? []);
  if (!error && payload.inventoryAdjustmentGroup) {
    const changed = await transition(db, [m.id], "pushed");
    return changed.length > 0 ? "pushed" : "gone";
  }
  if (!error) throw new InventoryPushRetry("EMPTY_GROUP");
  if (error.kind === "retry") throw new InventoryPushRetry(error.code);
  const changed = await transition(db, [m.id], "failed");
  if (changed.length > 0) await recordFailure(db, m.id, error.code.slice(0, 64), error.field);
  return changed.length > 0 ? "failed" : "gone";
}

/** Позиції з невдалою передачею — на звірку одразу (asap): розбіжність покаже, чого бракує в Shopify. */
async function scheduleReconcileForFailures(db: Db, shop: string, stockItemIds: ReadonlySet<string>, known: Map<string, string>) {
  if (stockItemIds.size === 0) return;
  const missing = [...stockItemIds].filter((id) => !known.has(id));
  if (missing.length > 0) {
    const rows = await db
      .select({ stockItemId: stockItems.id, gid: productVariants.inventoryItemId })
      .from(stockItems)
      .innerJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .where(inArray(stockItems.id, missing));
    for (const r of rows) if (r.gid) known.set(r.stockItemId, r.gid);
  }
  for (const id of stockItemIds) {
    const gid = known.get(id);
    if (gid) await scheduleItemReconcile(db, { shop, inventoryItemGid: gid, delayMs: 60_000, mode: "asap" });
  }
}

/** Лічильники станів передачі (для сторінки). */
export async function pushStateCounts(db: DbOrTx): Promise<{ pending: number; failed: number; oldestPendingAt: Date | null }> {
  const [row] = await db
    .select({
      pending: sql<number>`count(*) filter (where ${inventoryMovements.shopifySyncState} = 'pending')`.mapWith(Number),
      failed: sql<number>`count(*) filter (where ${inventoryMovements.shopifySyncState} = 'failed')`.mapWith(Number),
      oldest: sql<string | null>`min(${inventoryMovements.createdAt}) filter (where ${inventoryMovements.shopifySyncState} = 'pending')`,
    })
    .from(inventoryMovements)
    .where(inArray(inventoryMovements.shopifySyncState, ["pending", "failed"]));
  return {
    pending: row?.pending ?? 0,
    failed: row?.failed ?? 0,
    oldestPendingAt: row?.oldest ? new Date(row.oldest) : null,
  };
}

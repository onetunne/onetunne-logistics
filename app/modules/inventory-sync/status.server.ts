/** Стан синхронізації залишків для сторінки «Склад → Shopify» (без звернень до Shopify). */
import { and, desc, eq, inArray } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { auditLog, inventoryMovements, jobs, productVariants, products, stockItems } from "~/db/schema";
import { loadSyncEnvironment } from "./environment.server";
import { INVENTORY_SYNC_JOB } from "./jobs";
import { locationConfirmation, type LocationConfirmation } from "./location.server";
import { pushStateCounts } from "./push.server";
import { RECONCILE_OUTCOMES, emptySummary, type ReconcileSummary } from "./reconcile.server";

export interface PushFailureView {
  movementId: string;
  createdAt: Date;
  type: string;
  delta: number;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  /** Код помилки Shopify або idempotency_window / API-код (з журналу). */
  code: string | null;
}

export interface InventorySyncOverview {
  shop: string | null;
  canRead: boolean;
  canWrite: boolean;
  pushMode: "off" | "deltas";
  externalMode: "review" | "apply";
  warehouseId: string;
  warehouseName: string;
  inventoryInitializedAt: Date | null;
  locationId: string | null;
  locationConfirmation: LocationConfirmation | null;
  /** Локацію обрано автоматично (єдина в магазині) і ще не підтверджено власником. */
  locationAutoSelected: boolean;
  push: { pending: number; failed: number; oldestPendingAt: Date | null };
  queued: { push: boolean; reconcile: number };
  /** Наступна планова повна звірка (завдання в черзі); null — не заплановано (демо, обробник не запущено). */
  nextScheduledReconcileAt: Date | null;
  lastReconcile: { at: Date; summary: ReconcileSummary } | null;
  lastPushRun: { at: Date; pushed: number; failed: number } | null;
  recentFailures: PushFailureView[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export async function getInventorySyncOverview(db: DbOrTx): Promise<InventorySyncOverview> {
  const env = await loadSyncEnvironment(db);
  const w = env.warehouse;
  const [confirmation, push, queuedRows, lastReconcileRow, lastPushRow, autoRow, failures] = await Promise.all([
    locationConfirmation(db, w),
    pushStateCounts(db),
    db
      .select({ type: jobs.type, runAt: jobs.runAt, status: jobs.status })
      .from(jobs)
      .where(
        and(
          inArray(jobs.type, [INVENTORY_SYNC_JOB.push, INVENTORY_SYNC_JOB.reconcile, INVENTORY_SYNC_JOB.scheduledReconcile]),
          inArray(jobs.status, ["queued", "running"]),
        ),
      ),
    db
      .select({ createdAt: auditLog.createdAt, details: auditLog.details })
      .from(auditLog)
      .where(and(eq(auditLog.action, "inventory_sync.reconcile_finished"), eq(auditLog.entityId, w.id)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1),
    db
      .select({ createdAt: auditLog.createdAt, details: auditLog.details })
      .from(auditLog)
      .where(eq(auditLog.action, "inventory_sync.push_run"))
      .orderBy(desc(auditLog.createdAt))
      .limit(1),
    db
      .select({ createdAt: auditLog.createdAt })
      .from(auditLog)
      .where(and(eq(auditLog.action, "inventory_sync.location_auto_selected"), eq(auditLog.entityId, w.id)))
      .orderBy(desc(auditLog.createdAt))
      .limit(1),
    db
      .select({
        movementId: inventoryMovements.id,
        createdAt: inventoryMovements.createdAt,
        type: inventoryMovements.type,
        delta: inventoryMovements.onHandDelta,
        title: products.title,
        variantTitle: productVariants.title,
        sku: productVariants.sku,
      })
      .from(inventoryMovements)
      .innerJoin(stockItems, eq(stockItems.id, inventoryMovements.stockItemId))
      .leftJoin(productVariants, eq(productVariants.id, stockItems.variantId))
      .leftJoin(products, eq(products.id, productVariants.productId))
      .where(eq(inventoryMovements.shopifySyncState, "failed"))
      .orderBy(desc(inventoryMovements.createdAt))
      .limit(20),
  ]);
  const codes = new Map<string, string>();
  if (failures.length > 0) {
    const audits = await db
      .select({ entityId: auditLog.entityId, details: auditLog.details })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "inventory_sync.push_failed"),
          eq(auditLog.entityType, "inventory_movement"),
          inArray(
            auditLog.entityId,
            failures.map((f) => f.movementId),
          ),
        ),
      )
      .orderBy(desc(auditLog.createdAt));
    for (const a of audits) {
      const code = (a.details as Record<string, unknown>)?.code;
      if (a.entityId && !codes.has(a.entityId) && typeof code === "string") codes.set(a.entityId, code);
    }
  }
  const reconcileDetails = (lastReconcileRow[0]?.details ?? null) as Record<string, unknown> | null;
  const summary = emptySummary();
  if (reconcileDetails) {
    for (const k of [...RECONCILE_OUTCOMES, "checked"] as const) summary[k] = num(reconcileDetails[k]);
  }
  const pushDetails = (lastPushRow[0]?.details ?? null) as Record<string, unknown> | null;
  return {
    shop: env.shop,
    canRead: env.canRead,
    canWrite: env.canWrite,
    pushMode: env.pushMode,
    externalMode: env.externalMode,
    warehouseId: w.id,
    warehouseName: w.name,
    inventoryInitializedAt: w.inventoryInitializedAt,
    locationId: w.shopifyLocationId,
    locationConfirmation: confirmation,
    locationAutoSelected: Boolean(w.shopifyLocationId && !confirmation && autoRow[0]),
    push,
    queued: {
      push: queuedRows.some((r) => r.type === INVENTORY_SYNC_JOB.push),
      reconcile: queuedRows.filter((r) => r.type === INVENTORY_SYNC_JOB.reconcile).length,
    },
    nextScheduledReconcileAt:
      queuedRows
        .filter((r) => r.type === INVENTORY_SYNC_JOB.scheduledReconcile && r.status === "queued")
        .map((r) => r.runAt)
        .sort((a, b) => a.getTime() - b.getTime())[0] ?? null,
    lastReconcile: lastReconcileRow[0] ? { at: lastReconcileRow[0].createdAt, summary } : null,
    lastPushRun: lastPushRow[0] ? { at: lastPushRow[0].createdAt, pushed: num(pushDetails?.pushed), failed: num(pushDetails?.failed) } : null,
    recentFailures: failures.map((f) => ({
      movementId: f.movementId,
      createdAt: f.createdAt,
      type: f.type,
      delta: f.delta,
      title: f.title ?? "—",
      variantTitle: f.variantTitle,
      sku: f.sku,
      code: codes.get(f.movementId) ?? null,
    })),
  };
}

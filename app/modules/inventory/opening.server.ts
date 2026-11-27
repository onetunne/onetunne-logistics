/**
 * Ініціалізація складського обліку: початкові залишки зі знімка Shopify (docs/stage5-design.md §1–2).
 *
 * Формула початкового on_hand для варіанта:
 *     on_hand = max(0, product_variants.inventory_available + Σ quantity позицій ВІДКРИТИХ оплачених замовлень)
 * Чому: «available» Shopify (inventoryQuantity) уже НЕ містить одиниць, закріплених за незавершеними замовленнями
 * (committed). У застосунку ці одиниці фізично ще на складі (on_hand) і зарезервовані (reserved), тож
 * доступно застосунку (on_hand − reserved) = available Shopify. Відкрите замовлення — не скасоване й не передане
 * перевізнику (reservationModeFor = reserve).
 *
 * Семантика «встановити значення»: рух opening = (ціль − поточний on_hand), один раз на позицію й склад (ключ
 * opening:<warehouse>:<stockItem>). Повторний виклик ідемпотентний: уже відкриті позиції не змінюються, нові
 * варіанти (з'явилися пізніше) відкриваються. inventory_available = null (Shopify не відстежує) → пропуск.
 * Від'ємна ціль (Shopify «перепродав», або одиниці закріплені за неоплаченими замовленнями, яких немає в
 * застосунку) обрізається до 0 (причина shopify_snapshot_clamped) — розбіжність покаже звірка з Shopify.
 *
 * Обмеження (документовано): Shopify також закріплює одиниці за НЕОПЛАЧЕНИМИ замовленнями, яких застосунок не
 * імпортує; знімок «available» їх не містить, тож on_hand застосунку може бути меншим за on_hand Shopify на цю
 * кількість. Точніше — знімок on_hand Shopify за локацією (InventoryLevel.quantities) у модулі звірки.
 *
 * Після знімка: позначка warehouses.inventory_initialized_at і резервування всіх відкритих замовлень
 * (syncOrderReservations, кожне — окрема транзакція). Лише власник (warehouse.adjust).
 */
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import { inventoryMovements, orderLineItems, orders, productVariants, warehouses } from "~/db/schema";
import { SHIPPED_STATUSES, type OrderStatus } from "~/domain/order-status";
import { requirePermission } from "~/domain/permissions";
import { writeAudit } from "~/modules/audit/audit.server";
import type { ServiceContext } from "~/server/types";
import { inventoryKeys } from "./keys";
import { applyMovements, ensureStockItemsForVariants, lockBalances, type MovementInput } from "./ledger.server";
import { syncOrderReservations } from "./reservations.server";
import { getDefaultWarehouse } from "./warehouse.server";

/** Статуси, у яких замовлення НЕ резервується (скасоване або вже передане перевізнику). */
export const NON_RESERVING_STATUSES: readonly OrderStatus[] = ["cancelled", ...SHIPPED_STATUSES];

export interface InitializeInventoryResult {
  warehouseId: string;
  /** true — склад уже був ініціалізований раніше (відкрито лише нові позиції). */
  alreadyInitialized: boolean;
  initializedAt: Date;
  opened: number;
  alreadyOpened: number;
  /** Варіанти без кількості в Shopify (не відстежуються) — не відкриті. */
  skippedUntracked: number;
  /** Від'ємна ціль обрізана до 0. */
  clampedNegative: number;
  /** Відкриті замовлення, для яких синхронізовано резерви. */
  ordersSynced: number;
}

const OPENING_CHUNK = 500;

export async function initializeInventory(
  ctx: ServiceContext,
  opts: { source: "shopify_snapshot" } = { source: "shopify_snapshot" },
): Promise<InitializeInventoryResult> {
  requirePermission(ctx.actor, "warehouse.adjust");
  const now = ctx.now();
  const snapshot = await ctx.db.transaction(async (tx) => {
    const warehouse = await getDefaultWarehouse(tx);
    const [locked] = await tx.select().from(warehouses).where(eq(warehouses.id, warehouse.id)).for("update");
    const alreadyInitialized = Boolean(locked?.inventoryInitializedAt);

    const variants = await tx
      .select({ id: productVariants.id, available: productVariants.inventoryAvailable })
      .from(productVariants)
      .orderBy(productVariants.id);
    const tracked = variants.filter((v): v is { id: string; available: number } => v.available !== null);
    const skippedUntracked = variants.length - tracked.length;
    const stockByVariant = await ensureStockItemsForVariants(tx, tracked.map((v) => v.id));

    const openRows = tracked.length
      ? await tx
          .select({ variantId: orderLineItems.variantId, qty: sql<number>`sum(${orderLineItems.quantity})`.mapWith(Number) })
          .from(orderLineItems)
          .innerJoin(orders, eq(orders.id, orderLineItems.orderId))
          .where(and(isNotNull(orderLineItems.variantId), notInArray(orders.status, [...NON_RESERVING_STATUSES])))
          .groupBy(orderLineItems.variantId)
      : [];
    const openReserved = new Map(openRows.map((r) => [r.variantId!, r.qty]));

    let opened = 0;
    let alreadyOpened = 0;
    let clampedNegative = 0;
    for (let i = 0; i < tracked.length; i += OPENING_CHUNK) {
      const chunk = tracked.slice(i, i + OPENING_CHUNK);
      const keys = chunk.map((v) => inventoryKeys.opening(warehouse.id, stockByVariant.get(v.id)!));
      const existing = new Set(
        (
          await tx
            .select({ key: inventoryMovements.idempotencyKey })
            .from(inventoryMovements)
            .where(inArray(inventoryMovements.idempotencyKey, keys))
        ).map((r) => r.key),
      );
      const toOpen = chunk.filter((v) => !existing.has(inventoryKeys.opening(warehouse.id, stockByVariant.get(v.id)!)));
      alreadyOpened += chunk.length - toOpen.length;
      if (toOpen.length === 0) continue;
      const balances = await lockBalances(
        tx,
        toOpen.map((v) => ({ warehouseId: warehouse.id, stockItemId: stockByVariant.get(v.id)! })),
      );
      const movements: MovementInput[] = toOpen.map((v) => {
        const stockItemId = stockByVariant.get(v.id)!;
        const raw = v.available + (openReserved.get(v.id) ?? 0);
        const target = Math.max(0, raw);
        if (raw < 0) clampedNegative++;
        const current = balances.get(`${warehouse.id}|${stockItemId}`)?.onHand ?? 0;
        return {
          warehouseId: warehouse.id,
          stockItemId,
          type: "opening",
          idempotencyKey: inventoryKeys.opening(warehouse.id, stockItemId),
          onHandDelta: target - current,
          reason: raw < 0 ? "shopify_snapshot_clamped" : "shopify_snapshot",
        };
      });
      const result = await applyMovements(tx, ctx.actor, movements);
      opened += result.applied.length;
      alreadyOpened += result.skipped.length;
    }

    const initializedAt = locked?.inventoryInitializedAt ?? now;
    if (!alreadyInitialized) {
      await tx.update(warehouses).set({ inventoryInitializedAt: initializedAt, updatedAt: now }).where(eq(warehouses.id, warehouse.id));
    }
    await writeAudit(tx, ctx.actor, "inventory.initialized", { type: "warehouse", id: warehouse.id }, {
      source: opts.source,
      opened,
      alreadyOpened,
      skippedUntracked,
      clampedNegative,
      alreadyInitialized,
    });
    return { warehouseId: warehouse.id, alreadyInitialized, initializedAt, opened, alreadyOpened, skippedUntracked, clampedNegative };
  });

  const ordersSynced = await syncAllOpenOrderReservations(ctx);
  return { ...snapshot, ordersSynced };
}

/**
 * Синхронізує резерви всіх відкритих замовлень (кожне — окрема транзакція; ідемпотентно). Використовується
 * після ініціалізації та як відновлення (напр. після збою посеред ініціалізації).
 */
export async function syncAllOpenOrderReservations(ctx: ServiceContext): Promise<number> {
  const open = await ctx.db
    .select({ id: orders.id })
    .from(orders)
    .where(notInArray(orders.status, [...NON_RESERVING_STATUSES]))
    .orderBy(orders.placedAt);
  for (const o of open) {
    await ctx.db.transaction((tx) => syncOrderReservations(tx, o.id, ctx.actor));
  }
  return open.length;
}

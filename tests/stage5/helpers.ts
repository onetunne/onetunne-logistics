import { and, count, eq, isNull } from "drizzle-orm";
import type { Db } from "~/db/client.server";
import { inventoryBalances, inventoryMovements, packagingMaterials, productVariants, products, stockAlerts } from "~/db/schema";
import {
  applyMovements,
  ensureStockItemForMaterial,
  ensureStockItemForVariant,
  lockBalances,
  type MovementActor,
  type MovementInput,
} from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";

export const ACTOR: MovementActor = { id: "test-owner", displayName: "Owner" };

/** Вигаданий товар із варіантами (без реальних даних). */
export async function insertProduct(db: Db, title: string, variants: Array<{ sku: string; color?: string; model?: string; available?: number | null }>) {
  const [p] = await db.insert(products).values({ title, handle: title.toLowerCase().replace(/\W+/g, "-") }).returning({ id: products.id });
  const ids: string[] = [];
  for (const v of variants) {
    const [row] = await db
      .insert(productVariants)
      .values({
        productId: p!.id,
        title: v.color ?? v.model ?? v.sku,
        sku: v.sku,
        color: v.color ?? null,
        model: v.model ?? null,
        price: "10.00",
        currency: "EUR",
        inventoryAvailable: v.available === undefined ? 10 : v.available,
      })
      .returning({ id: productVariants.id });
    ids.push(row!.id);
  }
  return { productId: p!.id, variantIds: ids };
}

export async function insertMaterial(db: Db, code: string) {
  const [m] = await db.insert(packagingMaterials).values({ code, name: code, kind: "box" }).returning({ id: packagingMaterials.id });
  return { materialId: m!.id, stockItemId: await ensureStockItemForMaterial(db, m!.id) };
}

/**
 * Позиція обліку варіанта, ВІДКРИТА для тестів ядра (резерви/списання дозволені лише для відкритих товарів).
 * Уже відкриту (ініціалізація складу) не змінює. Для невідкритих товарів — ensureStockItemForVariant.
 */
export async function stockItemFor(db: Db, variantId: string) {
  const stockItemId = await ensureStockItemForVariant(db, variantId);
  const w = await getDefaultWarehouse(db);
  await db.transaction(async (tx) => {
    await lockBalances(tx, [{ warehouseId: w.id, stockItemId }]);
    const at = new Date();
    await tx
      .update(inventoryBalances)
      .set({ openedAt: at, openingSnapshotAt: at })
      .where(and(eq(inventoryBalances.warehouseId, w.id), eq(inventoryBalances.stockItemId, stockItemId), isNull(inventoryBalances.openedAt)));
  });
  return stockItemId;
}

export async function balance(db: Db, stockItemId: string) {
  const w = await getDefaultWarehouse(db);
  const [b] = await db
    .select()
    .from(inventoryBalances)
    .where(and(eq(inventoryBalances.warehouseId, w.id), eq(inventoryBalances.stockItemId, stockItemId)));
  return b ?? { onHand: 0, reserved: 0, defective: 0, inProduction: 0, version: 0 };
}

export async function movementCount(db: Db, where?: { stockItemId?: string; key?: string; type?: string }) {
  const [row] = await db
    .select({ c: count() })
    .from(inventoryMovements)
    .where(
      and(
        where?.stockItemId ? eq(inventoryMovements.stockItemId, where.stockItemId) : undefined,
        where?.key ? eq(inventoryMovements.idempotencyKey, where.key) : undefined,
        where?.type ? eq(inventoryMovements.type, where.type) : undefined,
      ),
    );
  return Number(row?.c ?? 0);
}

export async function openAlertKinds(db: Db, stockItemId: string) {
  const rows = await db
    .select({ kind: stockAlerts.kind })
    .from(stockAlerts)
    .where(and(eq(stockAlerts.stockItemId, stockItemId), eq(stockAlerts.status, "open")));
  return rows.map((r) => r.kind).sort();
}

/** Один рух у власній транзакції. */
export async function apply(db: Db, input: Omit<MovementInput, "warehouseId"> & { warehouseId?: string }, actor: MovementActor = ACTOR) {
  const w = input.warehouseId ?? (await getDefaultWarehouse(db)).id;
  return db.transaction((tx) => applyMovements(tx, actor, [{ ...input, warehouseId: w }]));
}

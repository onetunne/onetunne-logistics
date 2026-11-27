import { and, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { warehouses } from "~/db/schema";
import { NotFoundError } from "~/lib/errors";
import { getSetting } from "~/modules/settings/settings.server";

export type WarehouseRow = typeof warehouses.$inferSelect;

/** Назва складу за замовчуванням (створюється seedReferenceData; може бути перейменований власником). */
export const DEFAULT_WAREHOUSE_NAME = "Основний склад";

/**
 * Створює склад за замовчуванням, якщо його немає (ідемпотентно: частковий унікальний індекс is_default).
 * Країна/місто — з налаштувань відправника (порожнє місто допустиме).
 */
export async function ensureDefaultWarehouse(db: DbOrTx): Promise<WarehouseRow> {
  const [existing] = await db.select().from(warehouses).where(eq(warehouses.isDefault, true));
  if (existing) return existing;
  const shipper = await getSetting(db, "shipper");
  await db
    .insert(warehouses)
    .values({
      name: DEFAULT_WAREHOUSE_NAME,
      countryCode: (shipper.countryCode || "UA").slice(0, 2),
      city: shipper.city ?? "",
      active: true,
      isDefault: true,
    })
    .onConflictDoNothing({ target: warehouses.isDefault, where: sql`${warehouses.isDefault}` });
  const [row] = await db.select().from(warehouses).where(eq(warehouses.isDefault, true));
  if (!row) throw new NotFoundError("warehouse");
  return row;
}

/** Склад за замовчуванням (створюється за потреби). Усі складські операції етапу 5 — на ньому. */
export async function getDefaultWarehouse(db: DbOrTx): Promise<WarehouseRow> {
  return ensureDefaultWarehouse(db);
}

export async function getWarehouse(db: DbOrTx, warehouseId: string): Promise<WarehouseRow> {
  const [row] = await db.select().from(warehouses).where(eq(warehouses.id, warehouseId));
  if (!row) throw new NotFoundError("warehouse");
  return row;
}

/**
 * Чи ведеться облік резервів на складі (після initializeInventory). Блокування FOR SHARE: ініціалізація
 * (FOR UPDATE) і синхронізація резервів замовлень не перетинаються — замовлення, що надійшло під час
 * ініціалізації, буде зарезервоване одразу після неї.
 */
export async function lockWarehouseForTracking(tx: Tx, warehouseId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ initializedAt: warehouses.inventoryInitializedAt })
    .from(warehouses)
    .where(and(eq(warehouses.id, warehouseId)))
    .for("share");
  if (!row) throw new NotFoundError("warehouse");
  return row.initializedAt;
}

import { and, asc, eq, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { warehouses } from "~/db/schema";
import { NotFoundError } from "~/lib/errors";
import { getSetting } from "~/modules/settings/settings.server";

export type WarehouseRow = typeof warehouses.$inferSelect;

/** Назва складу за замовчуванням (створюється seedReferenceData; може бути перейменований власником). */
export const DEFAULT_WAREHOUSE_NAME = "Основний склад";

/**
 * Склад за замовчуванням: наявний (is_default), інакше — ПРИЙНЯТИЙ наявний активний склад (бази, заповнені до
 * етапу 5: напр. демо «Склад Київ (демо)»; кілька — найстаріший), інакше — новий «Основний склад».
 * Ідемпотентно й безпечно паралельно: частковий унікальний індекс is_default. Країна/місто нового — з налаштувань
 * відправника (порожнє місто допустиме).
 */
export async function ensureDefaultWarehouse(db: DbOrTx): Promise<WarehouseRow> {
  const [existing] = await db.select().from(warehouses).where(eq(warehouses.isDefault, true));
  if (existing) return existing;
  const [candidate] = await db
    .select({ id: warehouses.id })
    .from(warehouses)
    .where(eq(warehouses.active, true))
    .orderBy(asc(warehouses.createdAt), asc(warehouses.id))
    .limit(1);
  if (candidate) {
    // Інша транзакція могла вже призначити склад за замовчуванням — тоді індекс відхилить другий (і це нормально).
    // Точка збереження: помилка унікальності не псує транзакцію викликача.
    await db
      .transaction((sp) =>
        sp
          .update(warehouses)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(and(eq(warehouses.id, candidate.id), sql`not exists (select 1 from ${warehouses} w2 where w2.is_default)`)),
      )
      .catch((e: unknown) => {
        if (!isUniqueViolation(e)) throw e;
      });
  } else {
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
  }
  const [row] = await db.select().from(warehouses).where(eq(warehouses.isDefault, true));
  if (!row) throw new NotFoundError("warehouse");
  return row;
}

function isUniqueViolation(e: unknown): boolean {
  const code = (e as { code?: string; cause?: { code?: string } } | null)?.code ?? (e as { cause?: { code?: string } } | null)?.cause?.code;
  return code === "23505";
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
 * (lockWarehouseForInitialization, FOR NO KEY UPDATE) і синхронізація резервів замовлень не перетинаються —
 * замовлення, змінене під час ініціалізації, синхронізується одразу після неї (різницею від її резервів).
 * FOR SHARE/NO KEY UPDATE не конфліктують із KEY SHARE (перевірка зовнішніх ключів при вставці рухів).
 */
export async function lockWarehouseForTracking(tx: Tx, warehouseId: string): Promise<Date | null> {
  const [row] = await tx
    .select({ initializedAt: warehouses.inventoryInitializedAt })
    .from(warehouses)
    .where(eq(warehouses.id, warehouseId))
    .for("share");
  if (!row) throw new NotFoundError("warehouse");
  return row.initializedAt;
}

/**
 * Виключне блокування складу для ініціалізації обліку: чекає на всі незавершені синхронізації резервів (FOR SHARE)
 * і блокує нові до кінця транзакції. FOR NO KEY UPDATE (не FOR UPDATE): вставки рухів/балансів інших операцій
 * (перевірка зовнішнього ключа warehouse_id — KEY SHARE) не блокуються → без взаємоблокувань і глобальної зупинки.
 */
export async function lockWarehouseForInitialization(tx: Tx, warehouseId: string): Promise<WarehouseRow> {
  const [row] = await tx.select().from(warehouses).where(eq(warehouses.id, warehouseId)).for("no key update");
  if (!row) throw new NotFoundError("warehouse");
  return row;
}

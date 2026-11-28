/**
 * Етап 6: магазин (docs/stage6-design.md §15). Рядок 'default' створює міграція 0012; getDefaultStore — ЄДИНИЙ спосіб
 * визначити магазин зараз (другий магазин не підключається). Кожна фінансова таблиця має store_id з типовим
 * значенням 'default'.
 */
import { eq, ne } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financeState, stores } from "~/db/schema";

export const DEFAULT_STORE_ID = "default";

export type StoreRow = typeof stores.$inferSelect;
export type FinanceStateRow = typeof financeState.$inferSelect;

/** Магазин за замовчуванням (створюється, якщо міграцію застосовано до порожньої бази без рядка — ідемпотентно). */
export async function getDefaultStore(db: DbOrTx): Promise<StoreRow> {
  const [row] = await db.select().from(stores).where(eq(stores.isDefault, true));
  if (row) return row;
  await db.insert(stores).values({ id: DEFAULT_STORE_ID, name: DEFAULT_STORE_ID, isDefault: true }).onConflictDoNothing();
  const [created] = await db.select().from(stores).where(eq(stores.id, DEFAULT_STORE_ID));
  if (!created) throw new Error("default store is missing");
  return created;
}

/** Стан фінансів магазину (рядок створюється за потреби). */
export async function ensureFinanceState(db: DbOrTx, storeId: string = DEFAULT_STORE_ID): Promise<FinanceStateRow> {
  await db.insert(financeState).values({ storeId }).onConflictDoNothing({ target: financeState.storeId });
  const [row] = await db.select().from(financeState).where(eq(financeState.storeId, storeId));
  return row!;
}

/** Оновлення стану фінансів магазину (лише передані поля). */
export async function updateFinanceState(
  db: DbOrTx,
  patch: Partial<Omit<FinanceStateRow, "storeId" | "updatedAt">>,
  storeId: string = DEFAULT_STORE_ID,
): Promise<void> {
  await ensureFinanceState(db, storeId);
  await db
    .update(financeState)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(financeState.storeId, storeId));
}

/**
 * Скидання демо: магазин 'default' лишається (на нього посилаються всі фінансові таблиці), його поля повертаються до
 * значень міграції; інші магазини видаляються. Викликати ПІСЛЯ видалення фінансових таблиць і ДО legal_entities.
 */
export async function resetStoresForDemo(db: DbOrTx): Promise<void> {
  await db.delete(financeState);
  await db
    .update(stores)
    .set({ shopDomain: null, name: DEFAULT_STORE_ID, shopCurrency: null, legalEntityId: null, isDefault: true })
    .where(eq(stores.id, DEFAULT_STORE_ID));
  await db.delete(stores).where(ne(stores.id, DEFAULT_STORE_ID));
  await db.insert(stores).values({ id: DEFAULT_STORE_ID, name: DEFAULT_STORE_ID, isDefault: true }).onConflictDoNothing();
  await db.insert(financeState).values({ storeId: DEFAULT_STORE_ID }).onConflictDoNothing();
}

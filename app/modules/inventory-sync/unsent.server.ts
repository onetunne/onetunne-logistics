/**
 * Внутрішні зміни залишку, яких Shopify не отримав, і точка узгодження (docs/stage5-design.md §10).
 *
 * Рух товару зі зміною on_hand і станом shopify_sync_state = skipped не надіслано в Shopify: передачу вимкнено, немає
 * дозволу write_inventory, повернення покупця (Shopify поповнює сам), рух до відкриття товару, невдала передача,
 * відхилена власником. Різниця з Shopify, яку такі рухи пояснюють, — НЕ зміна, зроблена в Shopify: автоприйняття
 * скасувало б їх (рух shopify_external −дельта). Тому звірка рахує такі рухи від останнього УЗГОДЖЕННЯ позиції:
 * збіг/пояснена різниця, прийняття значення Shopify, успішне «надіслати склад» — тоді Shopify і склад мають одне значення,
 * і ці рухи вже враховано. Відхилення розбіжності — не узгодження (різниця лишається).
 *
 * Стан skipped кінцевий (з нього рух не виходить), рухи не видаляються, тож множина skipped-рухів позиції лише зростає.
 * Точка узгодження зберігає КІЛЬКІСТЬ і СУМУ skipped-рухів на той момент (запис журналу inventory_sync.in_sync,
 * сутність inventory_balance «<склад>:<позиція>»); рухи після неї = поточні підсумки − збережені. Час не порівнюється:
 * created_at руху — початок його транзакції, тож рух, що чекав на блокування балансу, міг би мати час, раніший за
 * узгодження. Записується лише тоді, коли є що узгоджувати (кількість змінилася), — не на кожну звірку.
 * Точка узгодження зберігає й стан повернень покупця на той момент (returns.server.ts, ReturnsSnapshot): повернення,
 * уже узгоджені з Shopify, не пояснюють нових різниць.
 * Викликати в транзакції після lockBalances позиції (рухи позиції серіалізовані блокуванням балансу).
 */
import { and, desc, eq, ne, sql } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { auditLog, inventoryMovements } from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { writeAudit } from "~/modules/audit/audit.server";
import {
  EMPTY_RETURNS_SNAPSHOT,
  emptyReturnsState,
  loadReturnsState,
  parseReturnsSnapshot,
  returnsSnapshotOf,
  sameReturnsSnapshot,
  type ReturnsSnapshot,
} from "./returns.server";

export const IN_SYNC_ACTION = "inventory_sync.in_sync";
/** Скільки останніх неотриманих рухів показувати в розбіжності. */
export const UNSENT_LIST_LIMIT = 20;

export const balanceEntityId = (warehouseId: string, stockItemId: string) => `${warehouseId}:${stockItemId}`;

export interface UnsentTotals {
  count: number;
  delta: number;
}

export interface UnsentSinceAgreement extends UnsentTotals {
  /** Підсумки всіх skipped-рухів позиції (для запису нової точки узгодження). */
  totals: UnsentTotals;
  /** Останні неотримані рухи після узгодження (для показу). */
  movementIds: string[];
}

const skippedWhere = (warehouseId: string, stockItemId: string) =>
  and(
    eq(inventoryMovements.warehouseId, warehouseId),
    eq(inventoryMovements.stockItemId, stockItemId),
    eq(inventoryMovements.shopifySyncState, "skipped"),
    ne(inventoryMovements.onHandDelta, 0),
  );

async function skippedTotals(db: DbOrTx, warehouseId: string, stockItemId: string): Promise<UnsentTotals> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)`.mapWith(Number),
      delta: sql<number>`coalesce(sum(${inventoryMovements.onHandDelta}), 0)`.mapWith(Number),
    })
    .from(inventoryMovements)
    .where(skippedWhere(warehouseId, stockItemId));
  return { count: row?.count ?? 0, delta: row?.delta ?? 0 };
}

export interface Agreement extends UnsentTotals {
  returns: ReturnsSnapshot;
}

/** Остання точка узгодження позиції (null — не було або запис пошкоджено). */
export async function lastAgreement(db: DbOrTx, warehouseId: string, stockItemId: string): Promise<Agreement | null> {
  const [row] = await db
    .select({ details: auditLog.details })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "inventory_balance"),
        eq(auditLog.entityId, balanceEntityId(warehouseId, stockItemId)),
        eq(auditLog.action, IN_SYNC_ACTION),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(1);
  const d = (row?.details ?? null) as Record<string, unknown> | null;
  if (!d) return null;
  const count = d.skippedCount;
  const delta = d.skippedDelta;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || typeof delta !== "number" || !Number.isSafeInteger(delta)) return null;
  return { count, delta, returns: parseReturnsSnapshot(d.returns) };
}

/** Неотримані Shopify внутрішні зміни позиції від останнього узгодження. */
export async function unsentSinceAgreement(db: DbOrTx, warehouseId: string, stockItemId: string): Promise<UnsentSinceAgreement> {
  const totals = await skippedTotals(db, warehouseId, stockItemId);
  const agreed = await lastAgreement(db, warehouseId, stockItemId);
  // Пошкоджений запис або підсумки, менші за збережені (неможливо, бо skipped кінцевий), — усе вважається неотриманим.
  const valid = agreed !== null && agreed.count <= totals.count;
  const count = valid ? totals.count - agreed.count : totals.count;
  const delta = valid ? totals.delta - agreed.delta : totals.delta;
  if (count === 0) return { count: 0, delta: 0, totals, movementIds: [] };
  const rows = await db
    .select({ id: inventoryMovements.id })
    .from(inventoryMovements)
    .where(skippedWhere(warehouseId, stockItemId))
    .orderBy(desc(inventoryMovements.createdAt), desc(inventoryMovements.id))
    .limit(Math.min(count, UNSENT_LIST_LIMIT));
  return { count, delta, totals, movementIds: rows.map((r) => r.id) };
}

export type AgreementSource = "match" | "explained" | "accepted" | "auto_applied" | "pushed";

/**
 * Записати точку узгодження, якщо після попередньої з'явилися неотримані рухи або змінився стан повернень. Викликати
 * лише тоді, коли значення Shopify і складу узгоджені НАПЕВНО (баланс заблоковано й він не змінився від
 * порівняння/спостереження). now — для вікна повернень (returns.server.ts).
 */
export async function recordAgreement(
  tx: Tx,
  actor: Actor,
  warehouseId: string,
  stockItemId: string,
  source: AgreementSource,
  now: Date = new Date(),
): Promise<boolean> {
  const totals = await skippedTotals(tx, warehouseId, stockItemId);
  const agreed = await lastAgreement(tx, warehouseId, stockItemId);
  const state = (await loadReturnsState(tx, warehouseId, [stockItemId], now)).get(stockItemId) ?? emptyReturnsState();
  const returns = returnsSnapshotOf(state);
  const sameReturns = sameReturnsSnapshot(agreed?.returns ?? EMPTY_RETURNS_SNAPSHOT, returns);
  const sameTotals = agreed ? agreed.count === totals.count && agreed.delta === totals.delta : totals.count === 0;
  if (sameTotals && sameReturns) return false;
  await writeAudit(tx, actor, IN_SYNC_ACTION, { type: "inventory_balance", id: balanceEntityId(warehouseId, stockItemId) }, {
    source,
    skippedCount: totals.count,
    skippedDelta: totals.delta,
    settledCount: totals.count - (agreed?.count ?? 0),
    settledDelta: totals.delta - (agreed?.delta ?? 0),
    returns,
  });
  return true;
}

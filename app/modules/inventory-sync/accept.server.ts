/**
 * Спільні кроки розв'язання розбіжностей (звірка й дії власника): прийняття значення Shopify (рух shopify_external)
 * і закриття невдалих передач. Викликати в транзакції, ПІСЛЯ lockBalances позиції (порядок блокувань:
 * баланс → розбіжність, як у звірці й ініціалізації).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "~/db/client.server";
import { inventoryConflicts, inventoryMovements } from "~/db/schema";
import type { Actor } from "~/domain/permissions";
import { writeAudit } from "~/modules/audit/audit.server";
import { inventoryKeys } from "~/modules/inventory/keys";
import { applyMovements } from "~/modules/inventory/ledger.server";
import type { ConflictObservation } from "./observation";
import { unexplainedDiff } from "./pure";
import { recordAgreement } from "./unsent.server";

export type ConflictRow = typeof inventoryConflicts.$inferSelect;

/**
 * Невдалі передачі позиції після розв'язання: pushed — Shopify має значення складу (збіг або «надіслати склад»);
 * skipped — прийнято значення Shopify / відхилено власником (повторно не надсилаються).
 */
export async function settleFailedMovements(tx: Tx, ids: readonly string[], to: "pushed" | "skipped"): Promise<number> {
  if (ids.length === 0) return 0;
  const rows = await tx
    .update(inventoryMovements)
    .set({ shopifySyncState: to })
    .where(and(inArray(inventoryMovements.id, [...ids]), eq(inventoryMovements.shopifySyncState, "failed")))
    .returning({ id: inventoryMovements.id });
  return rows.length;
}

/**
 * «Прийняти значення Shopify»: on_hand += НЕПОЯСНЕНА різниця (diff − expectedDiff, див. unexplainedDiff) рухом
 * shopify_external з ключем shopify_external:<id розбіжності> (повтор не створює другого руху), розбіжність →
 * accepted_shopify. Одиниці, які Shopify закріпив під неоплачені/ще не синхронізовані замовлення (expectedDiff), фізично
 * на складі — їх не віднімаємо. Склад тепер дорівнює Shopify — точка узгодження (неотримані Shopify рухи до неї
 * скасовано прийняттям і більше не враховуються). Кидає DomainError("inventory.insufficient"), якщо on_hand став би
 * від'ємним, а налаштування це забороняє (точка збереження applyMovements — транзакція придатна).
 */
export async function acceptInTx(
  tx: Tx,
  actor: Actor,
  conflict: ConflictRow,
  obs: ConflictObservation,
  mode: "manual" | "auto",
  now: Date,
): Promise<{ movementId: string | null; delta: number }> {
  let movementId: string | null = null;
  const delta = unexplainedDiff(obs);
  if (delta !== 0) {
    // Стан передачі: зміна прийшла З Shopify, тож shopify_external не надсилається назад (MOVEMENT_RULES.shopifyPushable =
    // false → defaultShopifySyncState = "none") — рух ніколи не стає pending і не ставить inventory.push, незалежно від
    // warehouse.shopifyPush і режиму (демо/робочий). Тому movementOptionsFor тут не потрібен (у шляху автоприйняття
    // звіркою ServiceContext і немає). Перевіряє tests/stage5/demo-push-ledger.test.ts.
    const res = await applyMovements(tx, { id: actor.id, displayName: actor.displayName }, [
      {
        warehouseId: conflict.warehouseId,
        stockItemId: conflict.stockItemId,
        type: "shopify_external",
        idempotencyKey: inventoryKeys.shopifyExternal(conflict.id),
        onHandDelta: delta,
        reason: mode === "auto" ? "shopify_auto_accept" : "shopify_conflict",
      },
    ]);
    movementId = res.applied[0]?.id ?? null;
  }
  await tx
    .update(inventoryConflicts)
    .set({
      status: "accepted_shopify",
      resolvedAt: now,
      resolvedBy: actor.id,
      details: { ...obs, resolution: mode === "auto" ? "auto_applied" : "accepted_shopify", movementId },
    })
    .where(eq(inventoryConflicts.id, conflict.id));
  const settled = await settleFailedMovements(tx, obs.failedMovementIds, "skipped");
  await recordAgreement(tx, actor, conflict.warehouseId, conflict.stockItemId, mode === "auto" ? "auto_applied" : "accepted", now);
  await writeAudit(tx, actor, mode === "auto" ? "inventory_sync.conflict_auto_applied" : "inventory_sync.conflict_accepted", {
    type: "inventory_conflict",
    id: conflict.id,
  }, { diff: obs.diff, expectedDiff: obs.expectedDiff, delta, movementId, settledFailed: settled });
  return { movementId, delta };
}

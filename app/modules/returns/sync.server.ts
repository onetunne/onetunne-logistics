/**
 * Етап 6, WP9 (заглушка ядра, інтеграційний раунд 0): випадки повернень замовлення (docs/stage6-design.md §11;
 * ідемпотентно, `ret:refund:<id>`, надходження-повернення). Сигнатура остаточна (contracts.ts SyncReturnCasesForOrder).
 * ВНУТРІШНЯ функція (INTERNAL_POSTING_FUNCTIONS): без перевірки актора, нічого не повертає; сторінки/маршрути/команди/
 * ШІ її не імпортують (тест-сканер).
 *
 * Заглушка нічого не робить.
 */
import type { Tx } from "~/db/client.server";
import type { PostingActor, SyncReturnCasesForOrder } from "~/modules/finance/core/contracts";

export const syncReturnCasesForOrder: SyncReturnCasesForOrder = async (_tx: Tx, _actor: PostingActor, _orderId: string): Promise<void> => {
  // WP9: реалізація.
};

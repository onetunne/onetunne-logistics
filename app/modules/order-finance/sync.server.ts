/**
 * Етап 6, WP4 (заглушка ядра, раунд 0): фінанси замовлення — визнання, складники, прогнози, проведення
 * (docs/stage6-design.md §3, §4, §2.6). Сигнатура остаточна (contracts.ts SyncOrderFinance). ВНУТРІШНЯ функція
 * проведення: без перевірки актора, нічого не повертає. Точка підключення — кінець syncOrderReservations (усі шляхи) і
 * хук оцінки складу; викликається в транзакції викликача.
 *
 * Заглушка нічого не робить (існуючі потоки — накладна, передача, пакування, надходження — не змінюються).
 */
import type { Tx } from "~/db/client.server";
import type { PostingActor, SyncOrderFinance } from "~/modules/finance/core/contracts";

export const syncOrderFinance: SyncOrderFinance = async (_tx: Tx, _actor: PostingActor, _orderId: string): Promise<void> => {
  // WP4: реалізація.
};

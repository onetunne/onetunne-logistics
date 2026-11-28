/**
 * Етап 6, WP2 (заглушка ядра, раунд 0): оцінка собівартості щойно вставлених рухів (docs/stage6-design.md §6.3, §6.4).
 * Сигнатура остаточна (contracts.ts ValueInsertedMovements). Точка підключення — applyMovements
 * (modules/inventory/ledger.server.ts) після оновлення балансів, у тій самій транзакції (точці збереження).
 * ВНУТРІШНЯ функція: без перевірки актора, нічого не повертає; НІКОЛИ не кидає виняток через відсутні дані.
 *
 * Заглушка нічого не робить (рухи складу записуються як і раніше).
 */
import type { Tx } from "~/db/client.server";
import type { InsertedMovement, ValueInsertedMovements } from "~/modules/finance/core/contracts";

export const valueInsertedMovements: ValueInsertedMovements = async (_tx: Tx, _inserted: readonly InsertedMovement[]): Promise<void> => {
  // WP2: реалізація.
};

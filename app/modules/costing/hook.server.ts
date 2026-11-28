/**
 * Етап 6, WP2: оцінка собівартості щойно вставлених рухів (docs/stage6-design.md §6.3, §6.4). Точка підключення —
 * applyMovements (modules/inventory/ledger.server.ts) після оновлення балансів, у тій самій точці збереження.
 * ВНУТРІШНЯ функція (contracts.ts INTERNAL_POSTING_FUNCTIONS): без перевірки актора, нічого не повертає; НІКОЛИ не
 * кидає виняток через відсутні дані (невідома вартість — стан, не помилка).
 *
 * Позиції оцінюються в порядку блокувань ledger (stock_item_id, warehouse_id), рухи позиції — за seq; стан пулу —
 * FOR UPDATE після балансів (без взаємоблокувань). Якщо стану позиції ще немає — вбудоване довантаження всієї історії
 * за seq. Наслідки без замовлення (inventory_loss/gain, packaging_unlinked, довідкові) проводяться одразу (val:<id>);
 * наслідки замовлення — syncOrderFinance (WP4) у порядку order_id, у тій самій транзакції.
 */
import type { Tx } from "~/db/client.server";
import type { InsertedMovement, ValueInsertedMovements } from "~/modules/finance/core/contracts";
import { loadCostingContext } from "./inputs.server";
import { flushValuationResults, itemPairsInLockOrder, valueItemMovements, type ValueItemResult } from "./valuation.server";

/** Рухи без впливу на вартість (резерви, запуск / закриття виробництва): окремої оцінки не потребують. */
const NO_VALUE_TYPES: ReadonlySet<InsertedMovement["type"]> = new Set<InsertedMovement["type"]>(["reserve", "release", "production_start", "production_close"]);

export const valueInsertedMovements: ValueInsertedMovements = async (tx: Tx, inserted: readonly InsertedMovement[]): Promise<void> => {
  // Позиції лише з резервами / виробництвом у процесі не оцінюються зараз (стан не змінюється; last_seq наздожене
  // наступна оцінка позиції — ці рухи для рушія без наслідків). Так потоки резервів не беруть блокування стану.
  const valued = inserted.filter((m) => !NO_VALUE_TYPES.has(m.type));
  if (valued.length === 0) return;
  const cctx = await loadCostingContext(tx);
  const results: ValueItemResult[] = [];
  for (const pair of itemPairsInLockOrder(valued)) {
    results.push(await valueItemMovements(tx, cctx, pair.warehouseId, pair.stockItemId));
  }
  await flushValuationResults(tx, results);
};

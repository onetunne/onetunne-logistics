/**
 * Етап 6, WP2 (заглушка ядра, інтеграційний раунд 0): переоцінка рядків партії після зміни собівартості
 * (docs/stage6-design.md §6.7; виклики з updateBatchCosts / closeBatch / cancelBatch додає WP2). Сигнатура остаточна
 * (contracts.ts RevalueBatchLines). ВНУТРІШНЯ функція (INTERNAL_POSTING_FUNCTIONS): без перевірки актора, нічого не
 * повертає; сторінки/маршрути/команди/ШІ її не імпортують (тест-сканер).
 *
 * Заглушка нічого не робить.
 */
import type { Tx } from "~/db/client.server";
import type { PostingActor, RevalueBatchLines } from "~/modules/finance/core/contracts";

export const revalueBatchLines: RevalueBatchLines = async (_tx: Tx, _actor: PostingActor, _batchId: string): Promise<void> => {
  // WP2: реалізація.
};

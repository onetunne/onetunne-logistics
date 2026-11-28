/**
 * Етап 6, WP2 (заглушка ядра, раунд 0): завершення шарів fx_pending, коли з'явився курс (docs/stage6-design.md §6.3).
 * Викликає WP1 після збереження ручного курсу (у тій самій транзакції) і завдання finance.valuation_pending.
 * Сигнатура остаточна (contracts.ts CompleteFxPendingLayers); результат — лише кількість.
 */
import type { Tx } from "~/db/client.server";
import type { CompleteFxPendingLayers, PostingActor } from "~/modules/finance/core/contracts";

export const completeFxPendingLayers: CompleteFxPendingLayers = async (
  _tx: Tx,
  _actor: PostingActor,
  _scope: { currency?: string; date?: string },
): Promise<{ completed: number }> => {
  // WP2: реалізація.
  return { completed: 0 };
};

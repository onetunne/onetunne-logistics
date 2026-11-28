/**
 * Етап 6, WP11 (заглушка ядра, раунд 0): вигадані фінансові демо-дані (docs/stage6-design.md §19). Сигнатура остаточна
 * (contracts.ts SeedDemoFinance). Точка підключення — кінець seedDemoData (app/db/seed/seed.server.ts). Кожен крок —
 * ідемпотентний (демо-ключі demo:*, детерміновані id), дати — від ctx.now(); лише демо.
 *
 * Заглушка нічого не робить.
 */
import type { SeedDemoFinance } from "~/modules/finance/core/contracts";
import type { ServiceContext } from "~/server/types";

export const seedDemoFinance: SeedDemoFinance = async (_ctx: ServiceContext): Promise<void> => {
  // WP11: реалізація.
};

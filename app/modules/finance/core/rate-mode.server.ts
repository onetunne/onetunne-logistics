/**
 * Етап 6 (інтеграційний раунд ядра): режим автоматичного джерела курсів (rateFor / sqlRateScaled / createRateResolver:
 * production → nbu, demo → demo; ручні — в обох) для ВНУТРІШНІХ потоків, які не знають режиму запиту: хук оцінки
 * applyMovements (WP2 costingRateMode), syncOrderFinance (WP4), coveringStatusForOrder (WP6). Режим не передається
 * через InsertedMovement / ValueInsertedMovements: applyMovements викликають ~15 місць етапів 2–5 без режиму
 * (резерви, пакування, відкриття обліку, надходження, демо-заповнення), а контракт SyncOrderFinance режиму не має.
 *
 * Безпека (I: робочий режим НІКОЛИ не бере демо-курсів):
 * - робочий сервер — не Vitest і DEMO_MODE вимкнено (єдина дозволена конфігурація з ключами Shopify у production,
 *   assertSafeConfiguration) → ЗАВЖДИ "production" з налаштувань сервера, вміст таблиць не читається: навіть рядок
 *   fx_rates.source = demo у робочій базі не змінить джерела;
 * - демо-сервер (DEMO_MODE) і тести (Vitest): демо-курси засіваються лише в окремій демо-базі PGlite (WP1 seedDemoRates
 *   відмовляє поза демо) → "demo", якщо в базі є демо-курси, інакше "production" (поведінка WP2/WP6 раунду 1 без змін).
 *   Обмеження: локальна розробка з DEMO_MODE і ключами Shopify одночасно (NODE_ENV ≠ production) розрізняє бази за
 *   вмістом — у робочій базі демо-курсів немає ніколи.
 */
import { eq, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { fxRates } from "~/db/schema";
import { getEnv } from "~/lib/env.server";
import type { AppMode } from "~/server/types";

/** Чи цей процес узагалі може обслуговувати демо (DEMO_MODE) або це тести (Vitest). Помилка конфігурації → ні. */
export function demoRatesAllowed(): boolean {
  if (process.env.VITEST) return true;
  try {
    return getEnv().DEMO_MODE;
  } catch {
    return false;
  }
}

/** Режим автоматичного джерела курсів для потоку без режиму запиту (див. шапку). `demoAllowed` — для тестів. */
export async function resolveRateMode(db: DbOrTx, opts: { demoAllowed?: boolean } = {}): Promise<AppMode> {
  if (!(opts.demoAllowed ?? demoRatesAllowed())) return "production";
  const [row] = await db.select({ one: sql<number>`1` }).from(fxRates).where(eq(fxRates.source, "demo")).limit(1);
  return row ? "demo" : "production";
}

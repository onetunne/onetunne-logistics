/**
 * Етап 6: класи advisory-блокувань фінансів (docs/stage6-design.md §17.8). Порядок у транзакції: замовлення →
 * операція → баланси (наявні, етап 5) → стан собівартості → фінанси замовлення → записи. Проведення в закритий місяць
 * перевіряється під FINANCE_PERIOD_LOCK у спільному режимі; закриття місяця бере його ексклюзивно.
 * Друге число — hashtext(ключ): збіг хешів різних ключів лише ставить їх у чергу (без хибних помилок).
 */
import { sql } from "drizzle-orm";
import type { Tx } from "~/db/client.server";

export const FINANCE_LOCKS = {
  /** «FINO» — фінанси замовлення (orderId). */
  order: 0x46494e4f,
  /** «FIOP» — ручна операція (operationId), як withOperationLock складу. */
  operation: 0x46494f50,
  /** «FIMP» — імпорт рахунку (carrier|account|номер). */
  import: 0x46494d50,
  /** «FIPA» — партнер (виплата). */
  partner: 0x46495041,
  /** «FIPE» — місяць (закриття / проведення). */
  period: 0x46495045,
  /** «VALU» — довантаження оцінки складу. */
  valuation: 0x56414c55,
} as const;

export type FinanceLockClass = keyof typeof FINANCE_LOCKS;

async function xactLock(tx: Tx, cls: FinanceLockClass, key: string, shared = false): Promise<void> {
  const fn = sql.raw(shared ? "pg_advisory_xact_lock_shared" : "pg_advisory_xact_lock");
  await tx.execute(sql`select ${fn}(${FINANCE_LOCKS[cls]}::int, hashtext(${key}))`);
}

/** Фінанси замовлення (після стану собівартості — F10). */
export function lockFinanceOrder(tx: Tx, orderId: string): Promise<void> {
  return xactLock(tx, "order", orderId);
}

/** Кілька замовлень — у порядку order_id (без взаємоблокувань). */
export async function lockFinanceOrders(tx: Tx, orderIds: readonly string[]): Promise<void> {
  for (const id of [...new Set(orderIds)].sort()) await lockFinanceOrder(tx, id);
}

/** Ручна операція (operationId форми): один operationId — одна операція. */
export function lockFinanceOperation(tx: Tx, operationId: string): Promise<void> {
  return xactLock(tx, "operation", operationId);
}

/** Імпорт документа перевізника (номер — нормалізований). */
export function lockFinanceImport(tx: Tx, carrierCode: string, accountRef: string, invoiceNumberNorm: string): Promise<void> {
  return xactLock(tx, "import", `${carrierCode}|${accountRef}|${invoiceNumberNorm}`);
}

/** Партнер (послідовні виплати). */
export function lockFinancePartner(tx: Tx, partnerId: string): Promise<void> {
  return xactLock(tx, "partner", partnerId);
}

/** Місяць (YYYY-MM-01) у спільному режимі — проведення / ручні зміни, датовані місяцем. */
export function lockFinancePeriodShared(tx: Tx, storeId: string, month: string): Promise<void> {
  return xactLock(tx, "period", `${storeId}|${month}`, true);
}

/** Місяць ексклюзивно — закриття / повторне відкриття. */
export function lockFinancePeriodExclusive(tx: Tx, storeId: string, month: string): Promise<void> {
  return xactLock(tx, "period", `${storeId}|${month}`);
}

/** Довантаження оцінки складу (ensureValuationBackfill) — один ключ на базу. */
export function lockValuation(tx: Tx): Promise<void> {
  return xactLock(tx, "valuation", "backfill");
}

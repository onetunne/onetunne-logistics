/**
 * Етап 6: перевірка закритого місяця (docs/stage6-design.md §3.4). Закритий місяць не змінюється:
 * - ручні записи, курси, ручна собівартість, датовані закритим місяцем, ВІДХИЛЯЮТЬСЯ (assertMonthOpen →
 *   finance.error.monthClosed);
 * - системні факти проводяться датою проведення з is_late = true (postEntries робить це сам — postingDateFor).
 * Перевірка — під FINANCE_PERIOD_LOCK у спільному режимі (закриття бере його ексклюзивно), тож закриття паралельно з
 * витратою, датованою цим місяцем, дає або відмову, або запис до закриття — ніколи після (§20.3).
 */
import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { DbOrTx, Tx } from "~/db/client.server";
import { financePeriods } from "~/db/schema";
import { DomainError } from "~/lib/errors";
import { monthStart } from "~/lib/periods";
import { lockFinancePeriodShared } from "./locks.server";
import { DEFAULT_STORE_ID } from "./store.server";

/** Перший день місяця дати. */
export function monthOf(date: string): string {
  return monthStart(date);
}

/** Закриті місяці серед переданих (YYYY-MM-01). */
export async function closedMonthsAmong(db: DbOrTx, months: readonly string[], storeId: string = DEFAULT_STORE_ID): Promise<Set<string>> {
  const unique = [...new Set(months)];
  if (unique.length === 0) return new Set();
  const rows = await db
    .select({ month: financePeriods.month })
    .from(financePeriods)
    .where(and(eq(financePeriods.storeId, storeId), inArray(financePeriods.month, unique), eq(financePeriods.status, "closed")));
  return new Set(rows.map((r) => r.month));
}

/** Закриті місяці в діапазоні дат (включно). */
export async function closedMonthsBetween(db: DbOrTx, from: string, to: string, storeId: string = DEFAULT_STORE_ID): Promise<string[]> {
  const rows = await db
    .select({ month: financePeriods.month })
    .from(financePeriods)
    .where(
      and(
        eq(financePeriods.storeId, storeId),
        eq(financePeriods.status, "closed"),
        gte(financePeriods.month, monthOf(from)),
        lte(financePeriods.month, monthOf(to)),
      ),
    );
  return rows.map((r) => r.month).sort();
}

export async function isMonthClosed(db: DbOrTx, date: string, storeId: string = DEFAULT_STORE_ID): Promise<boolean> {
  return (await closedMonthsAmong(db, [monthOf(date)], storeId)).size > 0;
}

/**
 * Ручна зміна, датована `date` (витрата, курс, ручна собівартість, обмін…): під спільним блокуванням місяця; закритий —
 * DomainError("finance.error.monthClosed", 409, { month }) («Жовтень 2026 закрито. Щоб змінити, відкрийте місяць
 * повторно (з причиною).»).
 */
export async function assertMonthOpen(tx: Tx, date: string, storeId: string = DEFAULT_STORE_ID): Promise<void> {
  const month = monthOf(date);
  await lockFinancePeriodShared(tx, storeId, month);
  if (await isMonthClosed(tx, date, storeId)) throw new DomainError("finance.error.monthClosed", 409, { month });
}

/** Те саме для кількох дат (блокування — у порядку місяців). */
export async function assertMonthsOpen(tx: Tx, dates: readonly string[], storeId: string = DEFAULT_STORE_ID): Promise<void> {
  const months = [...new Set(dates.map(monthOf))].sort();
  for (const m of months) await lockFinancePeriodShared(tx, storeId, m);
  const closed = await closedMonthsAmong(tx, months, storeId);
  const first = months.find((m) => closed.has(m));
  if (first) throw new DomainError("finance.error.monthClosed", 409, { month: first });
}

/** Етап 6: назва прибутку для періоду з даних finance_periods (§2.7; чисте правило — profit-label.ts). */
import { and, eq, gte, lte } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { financePeriods } from "~/db/schema";
import type { ProfitLabel } from "~/domain/finance";
import { monthStart, type DateRange } from "~/lib/periods";
import { profitLabelFor, type MonthStatus } from "./profit-label";
import { DEFAULT_STORE_ID } from "./store.server";

export async function loadMonthStatuses(db: DbOrTx, range: DateRange, storeId: string = DEFAULT_STORE_ID): Promise<MonthStatus[]> {
  const rows = await db
    .select({ month: financePeriods.month, status: financePeriods.status, netProfitEligible: financePeriods.netProfitEligible })
    .from(financePeriods)
    .where(and(eq(financePeriods.storeId, storeId), gte(financePeriods.month, monthStart(range.from)), lte(financePeriods.month, monthStart(range.to))));
  return rows.map((r) => ({ month: r.month, status: r.status, netProfitEligible: r.netProfitEligible }));
}

export async function loadProfitLabel(db: DbOrTx, range: DateRange, storeId: string = DEFAULT_STORE_ID): Promise<ProfitLabel> {
  return profitLabelFor(range, await loadMonthStatuses(db, range, storeId));
}

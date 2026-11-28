/**
 * Етап 6: назва прибутку (docs/stage6-design.md §2.7). «Чистий прибуток» — лише якщо КОЖЕН місяць періоду закритий і в
 * його чек-листі підтверджено всі категорії витрат і податки (finance_periods.net_profit_eligible). Інакше «Прибуток
 * після врахованих витрат» з підказкою (finance.notice.netProfitHint). Однаково для сторінок, звітів, експорту, тексту
 * бота й набору для ШІ. Серверна обгортка — profit-label.server.ts.
 */
import type { ProfitLabel } from "~/domain/finance";
import { monthsInRange, type DateRange } from "~/lib/periods";

export interface MonthStatus {
  /** YYYY-MM-01 */
  month: string;
  status: "open" | "closed";
  netProfitEligible: boolean;
}

export function profitLabelFor(range: DateRange, months: readonly MonthStatus[]): ProfitLabel {
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const needed = monthsInRange(range);
  if (needed.length === 0) return "profit_after_recorded_costs";
  const eligible = needed.every((m) => {
    const s = byMonth.get(m);
    return s?.status === "closed" && s.netProfitEligible;
  });
  return eligible ? "net_profit" : "profit_after_recorded_costs";
}

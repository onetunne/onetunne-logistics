/**
 * Етап 6, WP8 (заглушка ядра, раунд 0): дані звіту для знімків (закриття місяця WP6, ручні/за розкладом WP10), експорту,
 * бота й набору для ШІ (docs/stage6-design.md §13.1). Сигнатура остаточна (contracts.ts BuildReportData, ReportData).
 * Сервіс читання — requireFinance(view). Заглушка відмовляє («ще в розробці»): жоден наявний потік її не викликає, а
 * порожній звіт замість справжнього був би неправдою.
 */
import { DomainError } from "~/lib/errors";
import { requireFinance } from "~/modules/finance/core/access.server";
import type { BuildReportData, BuildReportInput } from "~/modules/finance/core/contracts";
import type { ServiceContext } from "~/server/types";

export const buildReportData: BuildReportData = async (ctx: ServiceContext, _input: BuildReportInput) => {
  requireFinance(ctx, "view");
  throw new DomainError("finance.error.notImplemented", 501);
};

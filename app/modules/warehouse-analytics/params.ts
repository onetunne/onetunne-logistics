/**
 * Параметри рядка запиту аналітики складу й експорту (чисті функції; спільні для сторінки й ресурсного маршруту).
 * ?period=7|30|90|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&model=…&color=…&product=<uuid>
 * Експорт додатково: &dataset=stock|movements|sales|production&sep=semicolon|comma.
 */
import type { Permission } from "~/domain/permissions";
import { isPeriodKey, DEFAULT_PERIOD, type PeriodKey } from "./calc";
import { isCsvSeparatorKey, DEFAULT_CSV_SEPARATOR, type CsvSeparatorKey } from "./csv";

export const EXPORT_DATASETS = ["stock", "movements", "sales", "production"] as const;
export type ExportDataset = (typeof EXPORT_DATASETS)[number];

/**
 * Дозвіл на набір: stock/movements/sales — warehouse.view (колонки собівартості в них — лише з finance.view);
 * production (партії виробництва із собівартістю) — увесь набір лише finance.view (власник). Сервер перевіряє сам
 * (export.server.ts, маршрут warehouse/export); сторінка лише ховає недоступні кнопки.
 */
export const EXPORT_DATASET_PERMISSIONS: Readonly<Record<ExportDataset, Permission>> = {
  stock: "warehouse.view",
  movements: "warehouse.view",
  sales: "warehouse.view",
  production: "finance.view",
};

/** Набори, доступні актору (для кнопок сторінки). */
export function exportDatasetsFor(can: (permission: Permission) => boolean): ExportDataset[] {
  return EXPORT_DATASETS.filter((d) => can(EXPORT_DATASET_PERMISSIONS[d]));
}

export function isExportDataset(value: unknown): value is ExportDataset {
  return typeof value === "string" && (EXPORT_DATASETS as readonly string[]).includes(value);
}

const MAX_TEXT = 100;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AnalyticsQuery {
  period: PeriodKey;
  from: string | null;
  to: string | null;
  model: string | null;
  color: string | null;
  product: string | null;
}

export function parseAnalyticsQuery(params: URLSearchParams): AnalyticsQuery {
  const text = (name: string) => {
    const v = (params.get(name) ?? "").trim().slice(0, MAX_TEXT);
    return v === "" ? null : v;
  };
  const date = (name: string) => {
    const v = text(name);
    return v && ISO_RE.test(v) ? v : null;
  };
  const period = params.get("period");
  const product = text("product");
  return {
    period: isPeriodKey(period) ? period : DEFAULT_PERIOD,
    from: date("from"),
    to: date("to"),
    model: text("model"),
    color: text("color"),
    product: product && UUID_RE.test(product) ? product.toLowerCase() : null,
  };
}

export function parseExportParams(params: URLSearchParams): { dataset: ExportDataset | null; separator: CsvSeparatorKey } {
  const dataset = params.get("dataset");
  const sep = params.get("sep");
  return { dataset: isExportDataset(dataset) ? dataset : null, separator: isCsvSeparatorKey(sep) ? sep : DEFAULT_CSV_SEPARATOR };
}

/** Фільтри для запитів аналітики. */
export function filtersOf(q: Pick<AnalyticsQuery, "model" | "color" | "product">): { productIds?: string[]; models?: string[]; colors?: string[] } {
  return {
    ...(q.product ? { productIds: [q.product] } : {}),
    ...(q.model ? { models: [q.model] } : {}),
    ...(q.color ? { colors: [q.color] } : {}),
  };
}

/** Рядок запиту (значення за замовчуванням не пишемо). */
export function analyticsSearch(q: Partial<AnalyticsQuery> & { dataset?: ExportDataset; sep?: CsvSeparatorKey }): string {
  const params = new URLSearchParams();
  if (q.dataset) params.set("dataset", q.dataset);
  if (q.period && q.period !== DEFAULT_PERIOD) params.set("period", q.period);
  if (q.period === "custom") {
    if (q.from) params.set("from", q.from);
    if (q.to) params.set("to", q.to);
  }
  if (q.model) params.set("model", q.model);
  if (q.color) params.set("color", q.color);
  if (q.product) params.set("product", q.product);
  if (q.sep && q.sep !== DEFAULT_CSV_SEPARATOR) params.set("sep", q.sep);
  const s = params.toString();
  return s ? `?${s}` : "";
}

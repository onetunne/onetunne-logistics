/**
 * Фільтри черги пакування (чисті функції, без БД): розбір параметрів адреси й побудова посилань.
 * Вкладки: уся черга, за статусом («Накладна створена» / «Очікує комплектації» / «Запаковано»),
 * «Потрібна накладна» (перевірені замовлення без активної накладної).
 */
import type { OrderPriority } from "~/db/schema";
import { PACKING_QUEUE_STATUSES, parsePriority, type PackingQueueStatus } from "./constants";

export const QUEUE_TABS = ["queue", ...PACKING_QUEUE_STATUSES, "needs_waybill"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

export const QUEUE_PAGE_SIZE = 50;
export const MAX_FILTER_LENGTH = 80;

export interface QueueFilters {
  tab: QueueTab;
  priority: OrderPriority | null;
  country: string | null;
  model: string | null;
  color: string | null;
  /** Ідентифікатор працівника (хто почав або запакував). */
  worker: string | null;
  /** Номер замовлення (частина). */
  q: string;
  page: number;
}

export function isQueueTab(v: unknown): v is QueueTab {
  return typeof v === "string" && (QUEUE_TABS as readonly string[]).includes(v);
}

export function isQueueStatus(v: unknown): v is PackingQueueStatus {
  return typeof v === "string" && (PACKING_QUEUE_STATUSES as readonly string[]).includes(v);
}

const text = (v: string | null) => (v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, MAX_FILTER_LENGTH);

export function parseQueueFilters(params: URLSearchParams): QueueFilters {
  const tab = params.get("tab");
  const country = text(params.get("country")).toUpperCase();
  const page = text(params.get("page"));
  return {
    tab: isQueueTab(tab) ? tab : "queue",
    priority: parsePriority(params.get("priority")),
    country: /^[A-Z]{2}$/.test(country) ? country : null,
    model: text(params.get("model")) || null,
    color: text(params.get("color")) || null,
    worker: text(params.get("worker")) || null,
    q: text(params.get("q")),
    page: /^\d{1,6}$/.test(page) ? Math.max(1, Number(page)) : 1,
  };
}

/** Рядок запиту (лише задані параметри; вкладка «queue» і сторінка 1 не пишуться). */
export function buildQueueSearch(f: Partial<QueueFilters>): string {
  const params = new URLSearchParams();
  if (f.tab && f.tab !== "queue") params.set("tab", f.tab);
  if (f.priority !== null && f.priority !== undefined) params.set("priority", String(f.priority));
  if (f.country) params.set("country", f.country);
  if (f.model) params.set("model", f.model);
  if (f.color) params.set("color", f.color);
  if (f.worker) params.set("worker", f.worker);
  if (f.q) params.set("q", f.q);
  if (f.page && f.page > 1) params.set("page", String(f.page));
  const s = params.toString();
  return s ? `?${s}` : "";
}

/** Кількість активних фільтрів (без вкладки й сторінки). */
export function activeFilterCount(f: QueueFilters): number {
  return [f.priority !== null, f.country, f.model, f.color, f.worker, f.q].filter(Boolean).length;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ідентифікатори замовлень з форми/адреси (повторювані поля або через кому): лише UUID, без повторів, ≤ limit. */
export function parseOrderIds(values: readonly unknown[], limit: number): string[] {
  const out = new Set<string>();
  for (const v of values) {
    if (typeof v !== "string") continue;
    for (const part of v.split(",")) {
      const id = part.trim();
      if (UUID_RE.test(id)) out.add(id.toLowerCase());
      if (out.size >= limit) return [...out];
    }
  }
  return [...out];
}

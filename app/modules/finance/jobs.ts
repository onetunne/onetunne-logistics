/**
 * Етап 6: фонові завдання фінансів (черга jobs; docs/stage6-design.md §5.6, §6.3, §13.1, §16.3). ПОВНИЙ перелік назв —
 * тут (ядро, WP0); обробники й розклади — у модулях пакетів (fx, costing, finance-sync, finance-reports, expenses), які статично
 * збирає jobs.server.ts. Корисне навантаження й помилки — лише id і коди (§14.2: jobs.last_error не маскується).
 * У демо обробника немає: усе обчислюється при читанні/дії, курси й знімки засіваються.
 */

export const FINANCE_JOB = {
  /** Ланцюжок курсів НБУ: кожні 6 год (перший — через 5 хв після старту); спершу планує наступний. WP1. */
  fxFetchScheduled: "finance.fx_fetch_scheduled",
  /** Отримання курсів НБУ (вікно [сьогодні − 3, сьогодні + 7]); обробник повторно перевіряє fx.nbuEnabled. WP1. */
  fxFetch: "finance.fx_fetch",
  /** Довантаження історії однієї валюти {currency, from, to} вікнами ≤ 1 рік. WP1. */
  fxBackfill: "finance.fx_backfill",
  /** Фінансова синхронізація замовлення {shop, orderGid}. WP3. */
  syncOrder: "finance.sync_order",
  /** Ланцюжок звірки: кожні 6 год (перший через 10 хв). WP3. */
  reconcileScheduled: "finance.reconcile_scheduled",
  /** Звірка змінених замовлень від водяного знаку (≤ 20 сторінок за запуск). WP3. */
  reconcile: "finance.reconcile",
  /** Одноразове початкове заповнення збережених до етапу 6 замовлень. WP3. */
  backfillOrders: "finance.backfill_orders",
  /** Ланцюжок знімків: щогодини → знімки завершених періодів без знімка. WP10. */
  snapshotScheduled: "finance.snapshot_scheduled",
  /** Знімок {kind, from}. WP10. */
  snapshot: "finance.snapshot",
  /** Завершення шарів fx_pending, коли з'явився курс. WP2. */
  valuationPending: "finance.valuation_pending",
  /**
   * Перерахунок розподілу суми періоду {expenseId} (той самий, що кнопка «Перерахувати розподіл»), коли замовлення
   * чекає перерозподілу (awaiting_reallocation, I16). Ставить WP4 (enqueueExpenseReallocation). WP6.
   */
  expenseReallocate: "finance.expense_reallocate",
} as const;

export type FinanceJobName = (typeof FINANCE_JOB)[keyof typeof FINANCE_JOB];
export const FINANCE_JOB_NAMES: readonly FinanceJobName[] = Object.values(FINANCE_JOB);

/** Власник модуля кожного завдання (статичний реєстр jobs.server.ts перевіряє відповідність). */
export type FinanceJobOwner = "fx" | "costing" | "finance-sync" | "finance-reports" | "expenses";

export const FINANCE_JOB_OWNER: Readonly<Record<FinanceJobName, FinanceJobOwner>> = {
  "finance.fx_fetch_scheduled": "fx",
  "finance.fx_fetch": "fx",
  "finance.fx_backfill": "fx",
  "finance.sync_order": "finance-sync",
  "finance.reconcile_scheduled": "finance-sync",
  "finance.reconcile": "finance-sync",
  "finance.backfill_orders": "finance-sync",
  "finance.snapshot_scheduled": "finance-reports",
  "finance.snapshot": "finance-reports",
  "finance.valuation_pending": "costing",
  "finance.expense_reallocate": "expenses",
};

/** Ключі дедуплікації (серед завдань у черзі). */
export const financeJobDedupe = {
  /** Слот 6-годинного вікна дати Києва: fx:<дата>:<0..3>. */
  fxFetch: (kyivDate: string, slot: number) => `fx:${kyivDate}:${slot}`,
  fxFetchScheduled: () => "finance.fx_fetch_scheduled",
  fxBackfill: (currency: string, from: string, to: string) => `fx-backfill:${currency}:${from}:${to}`,
  syncOrder: (orderGid: string) => `finance-order:${orderGid}`,
  /** Відкладені повторні читання customerJourneySummary (≤ 3 спроби, §9.2). */
  journey: (orderGid: string) => `finance-journey:${orderGid}`,
  reconcileScheduled: () => "finance.reconcile_scheduled",
  reconcile: (after: string | null) => `finance.reconcile:${after ?? "start"}`,
  backfillOrders: () => "finance.backfill_orders",
  snapshotScheduled: () => "finance.snapshot_scheduled",
  snapshot: (kind: string, from: string) => `finance-snapshot:${kind}:${from}`,
  valuationPending: () => "finance.valuation_pending",
  /** Одне завдання перерахунку на суму періоду серед завдань у черзі. */
  expenseReallocate: (expenseId: string) => `finance-expense-reallocate:${expenseId.toLowerCase()}`,
} as const;

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

/** Інтервали ланцюжків і перші запуски після старту сервера. */
export const FINANCE_JOB_TIMING = {
  fxFetchIntervalMs: 6 * HOUR,
  fxFetchFirstDelayMs: 5 * MINUTE,
  reconcileIntervalMs: 6 * HOUR,
  reconcileFirstDelayMs: 10 * MINUTE,
  /** Відкладення finance.sync_order для об'єднання сплесків webhook. */
  syncOrderDelayMs: 30 * 1000,
  /** Повторні читання customerJourneySummary: через 1 / 6 / 24 год. */
  journeyRetryDelaysMs: [1 * HOUR, 6 * HOUR, 24 * HOUR] as const,
  snapshotIntervalMs: 1 * HOUR,
  /** Відкладення finance.expense_reallocate: сплеск синхронізацій замовлень однієї суми → один перерахунок. */
  expenseReallocateDelayMs: 30 * 1000,
  /** Немає курсу для ваг різних валют: повтор перерахунку через годину, не більше 168 разів поспіль (≈ 7 діб). */
  expenseReallocateNoRateRetryMs: 1 * HOUR,
  expenseReallocateNoRateMaxRetries: 168,
  reconcileMaxPages: 20,
} as const;

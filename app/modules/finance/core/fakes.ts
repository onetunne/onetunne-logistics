/**
 * Етап 6: фейки контрактів для тестів пакетів (docs/stage6-design.md §21.1) — щоб пакет перевіряв свою логіку до
 * реалізації залежностей (підставляються через vi.mock відповідного модуля-заглушки). У застосунку не використовуються.
 */
import { decimalToScaled, RATE_SCALE } from "~/lib/decimal";
import type { ScaledRateLookup } from "~/modules/fx/convert";
import type {
  BuildReportData,
  BuildReportInput,
  InsertedMovement,
  PostingActor,
  ReportData,
  SyncOrderFinance,
  ValueInsertedMovements,
} from "./contracts";
import { REPORT_DATA_SCHEMA_VERSION } from "./contracts";
import type { EntryInput } from "./entries.server";
import { emptyCompleteness } from "./states";

export const FAKE_POSTING_ACTOR: PostingActor = { id: "test-posting" };

/**
 * Таблиця курсів для чистих тестів: { EUR: { "2026-11-20": "49.4942" } } → P (× 10^10); UAH — завжди 1; немає → null.
 */
export function fakeRateLookup(table: Readonly<Record<string, Readonly<Record<string, string>>>>): ScaledRateLookup {
  return (currency, date) => {
    if (currency === "UAH") return 10n ** BigInt(RATE_SCALE);
    const rate = table[currency]?.[date];
    return rate === undefined ? null : decimalToScaled(rate, RATE_SCALE);
  };
}

/** Запис журналу з типовими значеннями (перевизначте потрібні поля). */
export function makeEntryInput(overrides: Partial<EntryInput> = {}): EntryInput {
  return {
    idempotencyKey: `test:${Math.random().toString(36).slice(2)}`,
    category: "sales_product",
    recognizedOn: "2026-11-10",
    fxOn: "2026-11-10",
    amount: "100.00",
    currency: "EUR",
    sourceType: "demo",
    sourceId: "test",
    ...overrides,
  };
}

/** Порожні дані звіту (структура ReportData) — для тестів знімків до реалізації buildReportData (WP8). */
export function emptyReportData(input: BuildReportInput, generatedAt = "2026-11-28T00:00:00.000Z"): ReportData {
  return {
    schemaVersion: REPORT_DATA_SCHEMA_VERSION,
    generatedAt,
    kind: input.kind,
    period: input.period,
    reportingCurrency: input.reportingCurrency,
    profitLabel: "profit_after_recorded_costs",
    includesTestOrders: false,
    pnl: [],
    daily: [],
    completeness: emptyCompleteness(),
    metrics: {},
    top: { products: [], countries: [], partners: [] },
    shipping: {},
    returns: {},
    forecast: null,
    limitations: [],
  };
}

/** buildReportData, що повертає задані (або порожні) дані. */
export function fakeBuildReportData(make: (input: BuildReportInput) => ReportData = (i) => emptyReportData(i)): BuildReportData {
  return async (_ctx, input) => ({ data: make(input), ratesUsed: [] });
}

/** syncOrderFinance, що запам'ятовує виклики. */
export function recordingSyncOrderFinance(): { fn: SyncOrderFinance; calls: Array<{ actorId: string; orderId: string }> } {
  const calls: Array<{ actorId: string; orderId: string }> = [];
  return {
    calls,
    fn: async (_tx, actor, orderId) => {
      calls.push({ actorId: actor.id, orderId });
    },
  };
}

/** valueInsertedMovements, що запам'ятовує вставлені рухи. */
export function recordingValueInsertedMovements(): { fn: ValueInsertedMovements; calls: InsertedMovement[][] } {
  const calls: InsertedMovement[][] = [];
  return {
    calls,
    fn: async (_tx, inserted) => {
      calls.push([...inserted]);
    },
  };
}

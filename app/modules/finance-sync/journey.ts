/**
 * Етап 6 (WP3): пізній customerJourneySummary (docs/stage6-design.md §9.2, §16.3). Shopify: `ready: false` — «attributed
 * sessions … not created yet»; реферальний код тоді невідомий → відкладені повторні читання finance.sync_order через
 * 1 / 6 / 24 год (dedupe finance-journey:<gid>, не більше 3; лічильник order_shopify_finance.journey_checks). Після
 * третього повторного читання з ready = false — позначка journey_never_ready (реферальний код не врахується, коди
 * знижок — так). Тестові замовлення не атрибутуються (без includeTestOrders) — повторних читань для них немає.
 * Чиста функція.
 */
import { FINANCE_JOB_TIMING } from "~/modules/finance/jobs";

export const JOURNEY_MAX_CHECKS = FINANCE_JOB_TIMING.journeyRetryDelaysMs.length;

export interface JourneyDecision {
  /** Поставити відкладене читання через стільки мс (якщо такого ще немає в черзі); null — ні. */
  scheduleDelayMs: number | null;
  /** Позначити journey_never_ready. */
  neverReady: boolean;
}

export function journeyDecision(input: {
  ready: boolean | null;
  /** Скільки відкладених читань уже поставлено (0..3). */
  checks: number;
  isTest: boolean;
  includeTestOrders: boolean;
  /** Відкладене читання цього замовлення вже чекає в черзі (не поточне). */
  retryQueued: boolean;
}): JourneyDecision {
  if (input.ready !== false) return { scheduleDelayMs: null, neverReady: false };
  if (input.isTest && !input.includeTestOrders) return { scheduleDelayMs: null, neverReady: false };
  if (input.checks < JOURNEY_MAX_CHECKS) {
    return { scheduleDelayMs: FINANCE_JOB_TIMING.journeyRetryDelaysMs[Math.max(0, input.checks)] ?? null, neverReady: false };
  }
  return { scheduleDelayMs: null, neverReady: !input.retryQueued };
}

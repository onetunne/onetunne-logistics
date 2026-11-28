/**
 * Етап 6 (WP3): рішення про відкладені читання customerJourneySummary (docs/stage6-design.md §9.2) — чиста функція;
 * і шаблон LIKE для ключів розбіжностей (екранування `_` / `%`).
 */
import { describe, expect, it } from "vitest";
import { likePrefix } from "~/modules/finance-sync/reconcile";
import { JOURNEY_MAX_CHECKS, journeyDecision } from "~/modules/finance-sync/journey";
import { FINANCE_JOB_TIMING } from "~/modules/finance/jobs";

const base = { ready: false as boolean | null, checks: 0, isTest: false, includeTestOrders: false, retryQueued: false };

describe("journeyDecision", () => {
  it("ready=false: 1 h, 6 h, 24 h, then never_ready once nothing is queued", () => {
    expect(JOURNEY_MAX_CHECKS).toBe(3);
    expect([0, 1, 2].map((checks) => journeyDecision({ ...base, checks }).scheduleDelayMs)).toEqual([...FINANCE_JOB_TIMING.journeyRetryDelaysMs]);
    expect(FINANCE_JOB_TIMING.journeyRetryDelaysMs).toEqual([3_600_000, 21_600_000, 86_400_000]);
    expect(journeyDecision({ ...base, checks: 3 })).toEqual({ scheduleDelayMs: null, neverReady: true });
    // Третє повторне читання ще чекає — позначки ще немає.
    expect(journeyDecision({ ...base, checks: 3, retryQueued: true })).toEqual({ scheduleDelayMs: null, neverReady: false });
  });

  it("ready=true / null: nothing; test orders — nothing unless includeTestOrders", () => {
    expect(journeyDecision({ ...base, ready: true })).toEqual({ scheduleDelayMs: null, neverReady: false });
    expect(journeyDecision({ ...base, ready: null })).toEqual({ scheduleDelayMs: null, neverReady: false });
    expect(journeyDecision({ ...base, isTest: true })).toEqual({ scheduleDelayMs: null, neverReady: false });
    expect(journeyDecision({ ...base, isTest: true, includeTestOrders: true }).scheduleDelayMs).toBe(3_600_000);
  });
});

describe("likePrefix", () => {
  it("escapes LIKE wildcards in dedupe keys", () => {
    expect(likePrefix("reconciliation_mismatch:o1:RC1:")).toBe("reconciliation\\_mismatch:o1:RC1:%");
    expect(likePrefix("a%b\\c")).toBe("a\\%b\\\\c%");
  });
});

/**
 * Етап 6, WP1: завдання курсів НБУ (§5.6) та інваріант I18: з вимкненим `finance.fx.nbuEnabled` жоден шлях (розклад,
 * кнопка, довантаження, уже поставлене завдання) не робить мережевого запиту (globalThis.fetch під наглядом — будь-який
 * виклик провалює тест). Ланцюжок: fx_fetch_scheduled спершу планує наступний, потім (якщо nbuEnabled і autoFetch) ставить
 * fx_fetch з дедуплікацією `fx:<дата Києва>:<слот>`; отримання — вікно [сьогодні − 3, сьогодні + 7], стан у finance_state,
 * після нових рядків — finance.valuation_pending (WP2); помилки — лише коди (повторювані / ні); довантаження — вікнами
 * ≤ 1 року; у демо НБУ немає; працівник — 403.
 */
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { financeChangeLog, financeState, fxRates, jobs } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import type { OfficialFxRateSource } from "~/integrations/directories/types";
import { NbuFetchError } from "~/integrations/fx/nbu.server";
import { DomainError } from "~/lib/errors";
import { loadFinanceSettings, saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { FINANCE_JOB, FINANCE_JOB_TIMING, financeJobDedupe } from "~/modules/finance/jobs";
import { createFinanceJobHandlers } from "~/modules/finance/jobs.server";
import { ensureSchedules, handlers } from "~/modules/fx/jobs.server";
import { fxFetchSlot, requestNbuBackfill, requestNbuFetch, runFxBackfill, runFxFetch, setNbuEnabled } from "~/modules/fx/nbu-fetch.server";
import type { JobRow } from "~/modules/jobs/queue.server";
import { isRetryable, runJobsOnce } from "~/modules/jobs/worker.server";
import { createTestEnv, OWNER, STAFF, type TestEnv } from "../../helpers";
import { EUR_RANGE, fixtureRows, fixtureSource, prodCtx } from "./helpers";

let env: TestEnv;
const NOW = new Date("2026-11-28T10:00:00Z");
const FORGED = makeActor({ id: "forged", displayName: "Forged", role: "staff", overrides: { grant: ["finance.view", "finance.manage"] } });
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  env = await createTestEnv({ seed: false });
});
afterAll(async () => {
  await env.close();
});
beforeEach(async () => {
  await env.handle.db.delete(jobs);
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    throw new Error("network is forbidden in this test");
  });
});
afterEach(() => vi.restoreAllMocks());

const deps = (mode: "production" | "demo" = "production") => ({ db: env.handle.db, serviceContext: () => (mode === "production" ? prodCtx(env) : env.ctx()), admin: async () => { throw new Error("no Shopify"); } });
const jobRow = (type: string, payload: Record<string, unknown> = {}) => ({ id: "x", type, payload, attempts: 1 }) as unknown as JobRow;
const queued = (type: string) => env.handle.db.select().from(jobs).where(and(eq(jobs.type, type), eq(jobs.status, "queued")));
async function setFx(patch: { nbuEnabled?: boolean; autoFetch?: boolean }) {
  const fx = (await loadFinanceSettings(env.handle.db)).fx;
  expect((await saveFinanceSettings(prodCtx(env), { fx: { ...fx, ...patch } })).ok).toBe(true);
}

describe("I18 — NBU switched off (default): no network request on any path", () => {
  it("ensureSchedules only plans the local chain (first run in 5 min, not duplicated)", async () => {
    const before = Date.now();
    await ensureSchedules(env.handle.db);
    await ensureSchedules(env.handle.db);
    const q = await queued(FINANCE_JOB.fxFetchScheduled);
    expect(q).toHaveLength(1);
    expect(q[0]!.dedupeKey).toBe(financeJobDedupe.fxFetchScheduled());
    expect(q[0]!.runAt.getTime()).toBeGreaterThanOrEqual(before + FINANCE_JOB_TIMING.fxFetchFirstDelayMs - 1000);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("schedule, already-queued fetch, backfill job, and the owner's buttons do nothing on the network", async () => {
    const h = handlers(deps());
    await h[FINANCE_JOB.fxFetchScheduled]!.run(jobRow(FINANCE_JOB.fxFetchScheduled));
    expect(await queued(FINANCE_JOB.fxFetchScheduled)).toHaveLength(1);
    expect(await queued(FINANCE_JOB.fxFetch)).toHaveLength(0);
    // Завдання, поставлене до вимкнення, виконується без запиту (обробник ще раз перевіряє вимикач).
    await h[FINANCE_JOB.fxFetch]!.run(jobRow(FINANCE_JOB.fxFetch));
    await h[FINANCE_JOB.fxBackfill]!.run(jobRow(FINANCE_JOB.fxBackfill, { currency: "EUR", from: "2026-01-01", to: "2026-06-30" }));
    // Через справжній цикл обробника черги й реєстр ядра.
    await env.handle.db.insert(jobs).values([
      { type: FINANCE_JOB.fxFetch, payload: {} },
      { type: FINANCE_JOB.fxBackfill, payload: { currency: "USD", from: "2025-01-01", to: "2025-12-31" } },
    ]);
    await runJobsOnce(env.handle.db, createFinanceJobHandlers(deps()), { limit: 5 });
    const done = await env.handle.db.select().from(jobs).where(eq(jobs.type, FINANCE_JOB.fxFetch));
    expect(done.every((j) => j.status === "succeeded")).toBe(true);
    await expect(requestNbuFetch(prodCtx(env))).rejects.toMatchObject({ code: "finance.error.nbuDisabled" });
    await expect(requestNbuBackfill(prodCtx(env), { currency: "EUR", from: "2026-01-01", to: "2026-02-01" })).rejects.toMatchObject({ code: "finance.error.nbuDisabled" });
    expect(await queued(FINANCE_JOB.fxFetch)).toHaveLength(0);
    expect(await queued(FINANCE_JOB.fxBackfill)).toHaveLength(0);
    const src = fixtureSource([]);
    expect(await runFxFetch(env.handle.db, { source: src })).toEqual({ status: "disabled" });
    expect(await runFxBackfill(env.handle.db, { source: src, currency: "EUR", from: "2026-01-01", to: "2026-01-31" })).toEqual({ status: "disabled" });
    expect(src.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    const [state] = await env.handle.db.select().from(financeState);
    expect(state!.fxFetchedAt).toBeNull();
  });
});

describe("switched on", () => {
  it("owner turns NBU on from the rates page: settings history + change log; the chain is planned", async () => {
    for (const actor of [STAFF, FORGED]) await expect(setNbuEnabled(prodCtx(env, actor), { enabled: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(setNbuEnabled({ ...env.ctx(OWNER), now: () => NOW }, { enabled: true })).rejects.toMatchObject({ code: "financeFx.error.demoNoNbu" });
    expect(await setNbuEnabled(prodCtx(env), { enabled: true, reason: "Дозволяю НБУ" })).toMatchObject({ ok: true });
    const [log] = await env.handle.db.select().from(financeChangeLog).where(eq(financeChangeLog.entityType, "settings_finance"));
    expect(log!.after).toMatchObject({ settings: { fx: { nbuEnabled: true } } });
    expect(log!.reason).toBe("Дозволяю НБУ");
    expect(await queued(FINANCE_JOB.fxFetchScheduled)).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the schedule queues fx_fetch once per 6-hour Kyiv slot; autoFetch off → the schedule does not fetch", async () => {
    const h = handlers(deps());
    await h[FINANCE_JOB.fxFetchScheduled]!.run(jobRow(FINANCE_JOB.fxFetchScheduled));
    await h[FINANCE_JOB.fxFetchScheduled]!.run(jobRow(FINANCE_JOB.fxFetchScheduled));
    const q = await queued(FINANCE_JOB.fxFetch);
    expect(q).toHaveLength(1);
    const { date, slot } = fxFetchSlot(new Date());
    expect(q[0]!.dedupeKey).toBe(financeJobDedupe.fxFetch(date, slot));
    expect(fxFetchSlot(new Date("2026-11-28T03:59:00Z"))).toEqual({ date: "2026-11-28", slot: 0 });
    expect(fxFetchSlot(new Date("2026-11-28T04:00:00Z"))).toEqual({ date: "2026-11-28", slot: 1 });
    expect(fxFetchSlot(new Date("2026-11-27T22:30:00Z"))).toEqual({ date: "2026-11-28", slot: 0 });
    await env.handle.db.delete(jobs);
    await setFx({ autoFetch: false });
    await h[FINANCE_JOB.fxFetchScheduled]!.run(jobRow(FINANCE_JOB.fxFetchScheduled));
    expect(await queued(FINANCE_JOB.fxFetch)).toHaveLength(0);
    expect(await queued(FINANCE_JOB.fxFetchScheduled)).toHaveLength(1);
    // Кнопка працює й без розкладу.
    expect(await requestNbuFetch(prodCtx(env))).toEqual({ queued: true });
    expect(await requestNbuFetch(prodCtx(env))).toEqual({ queued: false });
    await setFx({ autoFetch: true });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fx_fetch: window [today − 3, today + 7], rows stored, state ok, valuation_pending queued; empty → state empty", async () => {
    const src = fixtureSource(fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }));
    const r = await runFxFetch(env.handle.db, { source: src, now: NOW });
    expect(src.calls).toEqual([{ from: "2026-11-25", to: "2026-12-05" }]);
    expect(r).toMatchObject({ status: "ok", inserted: 6, conflicts: 0 });
    const rows = await env.handle.db.select().from(fxRates).where(eq(fxRates.source, "nbu"));
    expect(rows.map((x) => x.effectiveDate).sort()).toEqual(["2026-11-25", "2026-11-26", "2026-11-27", "2026-11-28", "2026-11-29", "2026-11-30"]);
    const [state] = await env.handle.db.select().from(financeState);
    expect(state).toMatchObject({ fxFetchStatus: "ok" });
    expect(state!.fxFetchedAt?.toISOString()).toBe(NOW.toISOString());
    expect(await queued(FINANCE_JOB.valuationPending)).toHaveLength(1);
    await env.handle.db.delete(jobs);
    expect(await runFxFetch(env.handle.db, { source: fixtureSource([]), now: NOW })).toMatchObject({ status: "empty", inserted: 0 });
    expect((await env.handle.db.select().from(financeState))[0]!.fxFetchStatus).toBe("empty");
    expect(await queued(FINANCE_JOB.valuationPending)).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("errors are codes only: transient → retryable, format → not retryable; the state records the code", async () => {
    const failing = (e: Error): OfficialFxRateSource => ({ source: "nbu", fetchRates: async () => Promise.reject(e) });
    const transient = await runFxFetch(env.handle.db, { source: failing(new NbuFetchError("http_503", true)), now: NOW }).catch((e: unknown) => e);
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(DomainError);
    expect((transient as Error).message).toBe("nbu.http_503");
    expect(isRetryable(transient)).toBe(true);
    expect((await env.handle.db.select().from(financeState))[0]!.fxFetchStatus).toBe("error:http_503");
    const format = await runFxFetch(env.handle.db, { source: failing(new NbuFetchError("invalid_json", false)), now: NOW }).catch((e: unknown) => e);
    expect(format).toBeInstanceOf(DomainError);
    expect((format as DomainError).code).toBe("nbu.invalid_json");
    expect(isRetryable(format)).toBe(false);
    expect((await env.handle.db.select().from(financeState))[0]!.fxFetchStatus).toBe("error:invalid_json");
  });

  it("backfill: one currency in ≤ 1-year windows, spaced, deduplicated; input limits; the job fetches one currency", async () => {
    const ctx = prodCtx(env);
    expect(await requestNbuBackfill(ctx, { currency: "eur", from: "2024-01-01", to: "2026-03-01" })).toEqual({ windows: 3, queued: 3 });
    expect(await requestNbuBackfill(ctx, { currency: "EUR", from: "2024-01-01", to: "2026-03-01" })).toEqual({ windows: 3, queued: 0 });
    const q = (await queued(FINANCE_JOB.fxBackfill)).sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
    expect(q.map((j) => j.payload)).toEqual([
      { currency: "EUR", from: "2024-01-01", to: "2024-12-31" },
      { currency: "EUR", from: "2025-01-01", to: "2026-01-01" },
      { currency: "EUR", from: "2026-01-02", to: "2026-03-01" },
    ]);
    expect(q[0]!.dedupeKey).toBe(financeJobDedupe.fxBackfill("EUR", "2024-01-01", "2024-12-31"));
    await expect(requestNbuBackfill(ctx, { currency: "EUR", from: "2026-03-01", to: "2026-01-01" })).rejects.toMatchObject({ code: "financeFx.error.periodInvalid" });
    await expect(requestNbuBackfill(ctx, { currency: "EUR", from: "1999-01-04", to: "1999-12-31" })).rejects.toMatchObject({
      code: "financeFx.error.backfillTooEarly",
      params: { date: "2000-01-01" },
    });
    await expect(requestNbuBackfill(ctx, { currency: "EUR", from: "2026-02-30", to: "2026-03-01" })).rejects.toMatchObject({ code: "financeFx.error.periodInvalid" });
    await expect(requestNbuBackfill(ctx, { currency: "EUR", from: "2000-01-01", to: "2006-01-01" })).rejects.toMatchObject({ code: "financeFx.error.backfillTooLong" });
    await expect(requestNbuBackfill(ctx, { currency: "UAH", from: "2026-01-01", to: "2026-02-01" })).rejects.toMatchObject({ code: "financeFx.error.currencyBase" });
    await expect(requestNbuBackfill(ctx, { currency: "EUR", from: "2026-11-01", to: "2026-12-31" })).rejects.toMatchObject({ code: "financeFx.error.dateTooFar" });
    for (const actor of [STAFF, FORGED]) {
      await expect(requestNbuBackfill(prodCtx(env, actor), { currency: "EUR", from: "2026-01-01", to: "2026-02-01" })).rejects.toBeInstanceOf(ForbiddenError);
      await expect(requestNbuFetch(prodCtx(env, actor))).rejects.toBeInstanceOf(ForbiddenError);
    }
    const src = fixtureSource(fixtureRows(EUR_RANGE, { from: "2026-11-18", to: "2026-11-30" }));
    await handlers(deps(), { source: src })[FINANCE_JOB.fxBackfill]!.run(jobRow(FINANCE_JOB.fxBackfill, { currency: "EUR", from: "2026-11-18", to: "2026-11-24" }));
    expect(src.calls).toEqual([{ currency: "EUR", from: "2026-11-18", to: "2026-11-24" }]);
    await expect(handlers(deps(), { source: src })[FINANCE_JOB.fxBackfill]!.run(jobRow(FINANCE_JOB.fxBackfill, { currency: "EUR", from: "2024-01-01", to: "2026-01-01" }))).rejects.toMatchObject({
      code: "job.invalidPayload",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the demo has no NBU: buttons refuse even when switched on, the job does not fetch", async () => {
    const demo = { ...env.ctx(OWNER), now: () => NOW };
    await expect(requestNbuFetch(demo)).rejects.toMatchObject({ code: "financeFx.error.demoNoNbu" });
    await expect(requestNbuBackfill(demo, { currency: "EUR", from: "2026-01-01", to: "2026-02-01" })).rejects.toMatchObject({ code: "financeFx.error.demoNoNbu" });
    const src = fixtureSource([]);
    await handlers(deps("demo"), { source: src })[FINANCE_JOB.fxFetch]!.run(jobRow(FINANCE_JOB.fxFetch));
    expect(src.calls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("the core registry exposes exactly the three FX jobs from this module", () => {
    const all = createFinanceJobHandlers(deps());
    for (const n of [FINANCE_JOB.fxFetchScheduled, FINANCE_JOB.fxFetch, FINANCE_JOB.fxBackfill]) expect(all[n]).toBeDefined();
    expect(Object.keys(handlers(deps())).sort()).toEqual([FINANCE_JOB.fxBackfill, FINANCE_JOB.fxFetch, FINANCE_JOB.fxFetchScheduled].sort());
  });

  it("switching off again stops every path before the network", async () => {
    await setNbuEnabled(prodCtx(env), { enabled: false });
    await env.handle.db.insert(jobs).values({ type: FINANCE_JOB.fxFetch, payload: {} });
    await runJobsOnce(env.handle.db, handlers(deps()), { limit: 5 });
    await expect(requestNbuFetch(prodCtx(env))).rejects.toMatchObject({ code: "finance.error.nbuDisabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

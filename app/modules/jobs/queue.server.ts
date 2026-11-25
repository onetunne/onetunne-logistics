/**
 * Надійна черга фонових завдань у PostgreSQL (таблиця jobs).
 * - Стан зберігається в БД: після перезапуску сервера завдання продовжуються.
 * - Захоплення завдання: FOR UPDATE SKIP LOCKED (кілька обробників не беруть одне завдання).
 * - «Зависле» running (сервер упав) повертається в роботу через STALE_LOCK_MS.
 * - Повтори з експоненційною паузою; після maxAttempts — dead (видно на сторінці синхронізації).
 * - dedupeKey: серед завдань у стані queued не буває двох однакових.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbOrTx } from "~/db/client.server";
import { jobs } from "~/db/schema";

export type JobRow = typeof jobs.$inferSelect;
export const STALE_LOCK_MS = 10 * 60 * 1000;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;

export interface EnqueueOptions {
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
}

/** Додає завдання. Повертає false, якщо таке саме (dedupeKey) уже чекає в черзі. */
export async function enqueueJob(
  db: DbOrTx,
  type: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<boolean> {
  const result = await db.execute(sql`
    insert into ${jobs} (type, payload, dedupe_key, run_at, max_attempts)
    values (${type}, ${JSON.stringify(payload)}::jsonb, ${opts.dedupeKey ?? null},
            ${(opts.runAt ?? new Date()).toISOString()}::timestamptz, ${opts.maxAttempts ?? 6})
    on conflict (dedupe_key) where status = 'queued' do nothing
    returning id`);
  return rowsOf(result).length > 0;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const r = result as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
  return Array.isArray(r) ? r : (r.rows ?? []);
}

/** Захоплює наступне готове завдання (або «зависле» після збою). */
export async function claimJob(db: DbOrTx, workerId: string, now = new Date()): Promise<JobRow | null> {
  const staleBefore = new Date(now.getTime() - STALE_LOCK_MS).toISOString();
  const result = await db.execute(sql`
    update ${jobs} set status = 'running', locked_at = ${now.toISOString()}::timestamptz, locked_by = ${workerId},
      attempts = attempts + 1, updated_at = ${now.toISOString()}::timestamptz
    where id = (
      select id from ${jobs}
      where (status = 'queued' and run_at <= ${now.toISOString()}::timestamptz)
         or (status = 'running' and locked_at < ${staleBefore}::timestamptz)
      order by run_at
      limit 1
      for update skip locked
    )
    returning id`);
  const id = rowsOf(result)[0]?.id as string | undefined;
  if (!id) return null;
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ?? null;
}

export async function completeJob(db: DbOrTx, job: JobRow): Promise<void> {
  await db
    .update(jobs)
    .set({ status: "succeeded", lockedAt: null, lockedBy: null, lastError: null, updatedAt: new Date() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "running")));
}

export function backoffMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), MAX_BACKOFF_MS);
}

/**
 * Невдала спроба. retryable=false або вичерпано спроби → dead.
 * Якщо поки завдання виконувалося, у черзі з'явилося нове з тим самим dedupeKey — це завдання
 * завершується як failed (нове виконає ту саму роботу зі свіжими даними).
 */
export async function failJob(
  db: DbOrTx,
  job: JobRow,
  error: string,
  retryable: boolean,
  now = new Date(),
): Promise<"retry" | "dead" | "superseded"> {
  const message = error.slice(0, 500);
  if (!retryable || job.attempts >= job.maxAttempts) {
    await db
      .update(jobs)
      .set({ status: "dead", lastError: message, lockedAt: null, lockedBy: null, updatedAt: now })
      .where(eq(jobs.id, job.id));
    return "dead";
  }
  if (job.dedupeKey) {
    const [dup] = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.dedupeKey, job.dedupeKey), eq(jobs.status, "queued")))
      .limit(1);
    if (dup) {
      await db
        .update(jobs)
        .set({ status: "failed", lastError: message, lockedAt: null, lockedBy: null, updatedAt: now })
        .where(eq(jobs.id, job.id));
      return "superseded";
    }
  }
  await db
    .update(jobs)
    .set({
      status: "queued",
      lastError: message,
      lockedAt: null,
      lockedBy: null,
      runAt: new Date(now.getTime() + backoffMs(job.attempts)),
      updatedAt: now,
    })
    .where(eq(jobs.id, job.id));
  return "retry";
}

/** Повторити «мертві» завдання (кнопка на сторінці синхронізації). */
export async function retryDeadJobs(db: DbOrTx): Promise<number> {
  const dead = await db.select().from(jobs).where(eq(jobs.status, "dead"));
  let n = 0;
  for (const job of dead) {
    const ok = await enqueueJob(db, job.type, job.payload as Record<string, unknown>, {
      dedupeKey: job.dedupeKey ?? undefined,
      maxAttempts: job.maxAttempts,
    });
    await db.update(jobs).set({ status: "failed", updatedAt: new Date() }).where(eq(jobs.id, job.id));
    if (ok) n++;
  }
  return n;
}

export async function jobStats(db: DbOrTx) {
  const rows = await db
    .select({ status: jobs.status, count: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  const stats = { queued: 0, running: 0, succeeded: 0, failed: 0, dead: 0 };
  for (const r of rows) stats[r.status] = Number(r.count);
  const problems = await db
    .select({ id: jobs.id, type: jobs.type, status: jobs.status, attempts: jobs.attempts, lastError: jobs.lastError, updatedAt: jobs.updatedAt })
    .from(jobs)
    .where(inArray(jobs.status, ["dead", "queued"]))
    .orderBy(desc(jobs.updatedAt))
    .limit(20);
  return { stats, problems: problems.filter((p) => p.status === "dead" || p.lastError) };
}

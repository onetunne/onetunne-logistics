import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { openTestDatabase } from "../helpers";
import { jobs } from "~/db/schema";
import { DomainError } from "~/lib/errors";
import { claimJob, enqueueJob, failJob, retryDeadJobs, STALE_LOCK_MS } from "~/modules/jobs/queue.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { ShopifyApiError } from "~/integrations/shopify/admin-client.server";

let h: DatabaseHandle;
beforeAll(async () => {
  h = await openTestDatabase();
});
afterAll(async () => {
  await h.close();
});

describe("job queue", () => {
  it("dedupes queued jobs by key but allows a new one after it ran", async () => {
    expect(await enqueueJob(h.db, "t.a", { n: 1 }, { dedupeKey: "k1" })).toBe(true);
    expect(await enqueueJob(h.db, "t.a", { n: 2 }, { dedupeKey: "k1" })).toBe(false);
    const done: unknown[] = [];
    await runJobsOnce(h.db, { "t.a": { run: async (j) => void done.push(j.payload) } });
    expect(done).toEqual([{ n: 1 }]);
    expect(await enqueueJob(h.db, "t.a", { n: 3 }, { dedupeKey: "k1" })).toBe(true);
    await runJobsOnce(h.db, { "t.a": { run: async () => undefined } });
  });

  it("retries retryable errors with backoff and goes dead after max attempts", async () => {
    await enqueueJob(h.db, "t.flaky", {}, { maxAttempts: 2 });
    let calls = 0;
    const handlers = {
      "t.flaky": {
        run: async () => {
          calls++;
          throw new ShopifyApiError("throttled", true, "THROTTLED");
        },
      },
    };
    await runJobsOnce(h.db, handlers);
    const [after1] = await h.db.select().from(jobs).where(eq(jobs.type, "t.flaky"));
    expect(after1?.status).toBe("queued");
    expect(after1!.runAt.getTime()).toBeGreaterThan(Date.now());
    // Наступна спроба — після паузи: імітуємо, що час настав.
    await h.db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.id, after1!.id));
    let deadCalled = false;
    await runJobsOnce(h.db, { "t.flaky": { ...handlers["t.flaky"], onDead: async () => void (deadCalled = true) } });
    const [after2] = await h.db.select().from(jobs).where(eq(jobs.id, after1!.id));
    expect(after2?.status).toBe("dead");
    expect(calls).toBe(2);
    expect(deadCalled).toBe(true);
    expect(await retryDeadJobs(h.db)).toBe(1);
  });

  it("non-retryable errors go dead immediately", async () => {
    await enqueueJob(h.db, "t.bad", {});
    await runJobsOnce(h.db, {
      "t.bad": {
        run: async () => {
          throw new DomainError("shopify.updateRejected", 422);
        },
      },
    });
    const [row] = await h.db.select().from(jobs).where(eq(jobs.type, "t.bad"));
    expect(row?.status).toBe("dead");
  });

  it("recovers a job stuck in running after a crash", async () => {
    await h.db.delete(jobs);
    await enqueueJob(h.db, "t.crash", {});
    const job = await claimJob(h.db, "dead-worker");
    expect(job?.status).toBe("running");
    expect(await claimJob(h.db, "other")).toBeNull();
    const later = new Date(Date.now() + STALE_LOCK_MS + 1000);
    const reclaimed = await claimJob(h.db, "other", later);
    expect(reclaimed?.id).toBe(job?.id);
    expect(reclaimed?.attempts).toBe(2);
  });

  it("a failed job is superseded when a newer one with the same key is queued", async () => {
    await h.db.delete(jobs);
    await enqueueJob(h.db, "t.sup", {}, { dedupeKey: "s1" });
    const job = (await claimJob(h.db, "w"))!;
    await enqueueJob(h.db, "t.sup", { newer: true }, { dedupeKey: "s1" });
    expect(await failJob(h.db, job, "boom", true)).toBe("superseded");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult } from "~/components/action-banner";
import { resetEnvCache } from "~/lib/env.server";
import { getSetting } from "~/modules/settings/settings.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Головна (/demo): loader і дії через справжні запити до демо-середовища (PGlite у пам'яті).
 * Глобальне демо-середовище — окреме для кожного файлу тестів (pool: forks).
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/dashboard");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/dashboard");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

const URL_ = "http://localhost/demo";

async function headers(role?: "owner" | "staff"): Promise<HeadersInit> {
  return role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
}

async function load(role?: "owner" | "staff") {
  return page.loader({ request: new Request(URL_, { headers: await headers(role) }), params: {}, context: {} } as never);
}

async function act(fields: Record<string, string>, role?: "owner" | "staff"): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const request = new Request(URL_, { method: "POST", body, headers: await headers(role) });
  return page.action({ request, params: {}, context: {} } as never);
}

describe("dashboard loader", () => {
  it("returns counts, problems, shipments, automation and honest carrier info", async () => {
    const data = await load();
    expect(data.mode).toBe("demo");
    expect(data.kpi).not.toBeNull();
    expect(Object.keys(data.kpi ?? {}).sort()).toEqual(["awaiting_review", "needs_correction", "paid", "waybill_created"]);
    expect(data.paidCount).toBe(data.kpi?.paid);
    expect(data.issues?.length ?? 0).toBeLessThanOrEqual(5);
    expect(data.shipments?.length ?? 0).toBeLessThanOrEqual(5);
    expect(data.automation).toEqual({ mode: "semi", globalPause: false });
    expect(data.carrier).toEqual({ displayName: expect.any(String), mode: "test", canCreateShipment: true });
  });
});

describe("dashboard actions", () => {
  it("validateAllPaid checks every paid order and reports the outcome", async () => {
    const before = await load();
    const paid = before.paidCount ?? 0;
    const r = await act({ intent: "validateAllPaid" });
    if (paid === 0) {
      expect(r).toMatchObject({ ok: true, message: "dashboard.quick.validateAll.none" });
    } else {
      expect(r).toMatchObject({ ok: true, message: "result.bulk.validated", params: { ok: paid, failed: 0 } });
    }
    expect((await load()).kpi?.paid).toBe(0);
    expect(await act({ intent: "validateAllPaid" })).toMatchObject({ ok: true, message: "dashboard.quick.validateAll.none" });
  });

  it("staff cannot pause automation; owner pause is idempotent", async () => {
    expect(await act({ intent: "toggleGlobalPause", globalPause: "true" }, "staff")).toEqual({ ok: false, error: "error.forbidden" });
    expect(await act({ intent: "toggleGlobalPause", globalPause: "maybe" })).toMatchObject({ ok: false, error: "error.validation" });

    expect(await act({ intent: "toggleGlobalPause", globalPause: "true" })).toMatchObject({ ok: true, message: "dashboard.automation.result.paused" });
    expect(await act({ intent: "toggleGlobalPause", globalPause: "true" })).toMatchObject({ ok: true, message: "dashboard.automation.result.unchanged" });
    const db = (await getDemoRuntime()).handle.db;
    expect(await getSetting(db, "automation")).toEqual({ mode: "semi", globalPause: true });
  });

  it("simulateOrder reports what automation did (paused → skipped, semi → validated)", async () => {
    const paused = await act({ intent: "simulateOrder" });
    expect(paused).toMatchObject({ ok: true, message: "result.demo.simulated", extra: ["dashboard.simulate.skipped.global_pause"] });
    expect(paused.ok && paused.params?.number).toMatch(/^#\d+$/);

    expect(await act({ intent: "toggleGlobalPause", globalPause: "false" })).toMatchObject({ ok: true, message: "dashboard.automation.result.resumed" });
    const semi = await act({ intent: "simulateOrder" }, "staff");
    expect(semi.ok).toBe(true);
    if (!semi.ok) return;
    expect(semi.extra?.[0]).toMatch(/^dashboard\.simulate\.validated\.(semi|blocking)$/);
    expect(semi.params).toMatchObject({ number: expect.any(String), fixes: expect.any(Number), issues: expect.any(Number) });
  });

  it("rejects unknown intents", async () => {
    expect(await act({ intent: "dropDatabase" })).toEqual({ ok: false, error: "error.generic" });
  });
});

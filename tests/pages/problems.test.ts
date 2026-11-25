import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult } from "~/components/action-banner";
import { issues } from "~/db/schema";
import { makeActor } from "~/domain/permissions";
import { resetEnvCache } from "~/lib/env.server";
import { listOrderIdsByStatus, validateOrders } from "~/modules/orders/workflow.server";
import { demoRoleCookie } from "~/server/cookies.server";
import { demoServiceContext, getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Проблеми (/demo/problems): групування за замовленнями, фільтри, застосування пропозиції,
 * приховування попередження. Справжні запити до демо-середовища (PGlite у пам'яті, окреме для файлу).
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/problems");

const BASE = "http://localhost/demo/problems";
const OWNER = makeActor({ id: "test-owner", displayName: "Owner", role: "owner" });

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/problems");
  // Перевіряємо всі оплачені демо-замовлення, щоб з'явилися проблеми.
  const runtime = await getDemoRuntime();
  const ctx = demoServiceContext(runtime, OWNER);
  await validateOrders(ctx, await listOrderIdsByStatus(ctx.db, ["paid"]));
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

async function load(search = "") {
  return page.loader({ request: new Request(`${BASE}${search}`), params: {}, context: {} } as never);
}

async function act(fields: Record<string, string>, role?: "owner" | "staff"): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.set(k, v);
  const headers: HeadersInit = role ? { Cookie: await demoRoleCookie.serialize(role) } : {};
  return page.action({ request: new Request(BASE, { method: "POST", body, headers }), params: {}, context: {} } as never);
}

type Data = Awaited<ReturnType<typeof load>>;
const allIssues = (data: Data) => data.groups.flatMap((g) => g.issues);

describe("problems loader", () => {
  it("groups open issues by order, errors first, with matching totals", async () => {
    const data = await load();
    expect(data.filters).toEqual({ tab: "open", severity: null });
    expect(data.counts.total).toBeGreaterThan(0);
    expect(allIssues(data)).toHaveLength(data.counts.total);
    expect(data.groups).toHaveLength(data.counts.orders);
    expect(new Set(data.groups.map((g) => g.orderId)).size).toBe(data.groups.length);
    const firstWithoutErrors = data.groups.findIndex((g) => !g.hasErrors);
    if (firstWithoutErrors !== -1) expect(data.groups.slice(firstWithoutErrors).every((g) => !g.hasErrors)).toBe(true);
    for (const g of data.groups) {
      expect(g.orderNumber).toMatch(/^#\d+$/);
      expect(g.editable).toBe(true);
      if (g.countryCode) expect(g.countryLabel).toBeTruthy();
    }
  });

  it("filters by severity and ignores invalid params", async () => {
    const errors = await load("?severity=error");
    expect(allIssues(errors).every((i) => i.severity === "error")).toBe(true);
    expect(allIssues(errors)).toHaveLength(errors.counts.errors);

    const bogus = await load("?tab=archive&severity=fatal");
    expect(bogus.filters).toEqual({ tab: "open", severity: null });
  });
});

describe("problems actions", () => {
  it("rejects unknown intents and invalid or unknown ids", async () => {
    expect(await act({ intent: "deleteEverything" })).toEqual({ ok: false, error: "error.generic" });
    expect(await act({ intent: "dismissIssue", issueId: "not-a-uuid" })).toEqual({ ok: false, error: "problems.error.notFound" });
    expect(await act({ intent: "dismissIssue", issueId: "00000000-0000-4000-8000-000000000000" })).toEqual({
      ok: false,
      error: "problems.error.notFound",
    });
  });

  it("applies a suggested candidate, re-validates and shows it under Resolved", async () => {
    const data = await load();
    const issue = allIssues(data).find((i) => i.code === "PHONE_AMBIGUOUS");
    expect(issue).toBeDefined();
    if (!issue) return;
    expect(issue.candidates.length).toBeGreaterThan(1);

    expect(await act({ intent: "acceptSuggestion", issueId: issue.id, candidate: "+10000000000" })).toMatchObject({
      ok: false,
      error: "issue.invalidCandidate",
    });

    const result = await act({ intent: "acceptSuggestion", issueId: issue.id, candidate: issue.candidates[0]! }, "staff");
    expect(result).toMatchObject({ ok: true, message: "result.suggestion.accepted" });
    expect(result.ok && result.extra?.[0]).toMatch(/^problems\.result\.revalidated\.(ready|blocking)$/);

    expect(allIssues(await load()).some((i) => i.id === issue.id)).toBe(false);
    const resolved = allIssues(await load("?tab=resolved")).find((i) => i.id === issue.id);
    expect(resolved).toMatchObject({ resolution: "suggestion_accepted", candidates: [] });
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);

    // Повторне застосування до вже вирішеної проблеми — зрозуміла помилка.
    expect(await act({ intent: "acceptSuggestion", issueId: issue.id, candidate: issue.candidates[0]! })).toMatchObject({
      ok: false,
      error: "issue.notActionable",
    });
  });

  it("dismisses warnings only", async () => {
    const data = await load();
    const error = allIssues(data).find((i) => i.severity === "error");
    expect(error).toBeDefined();
    if (!error) return;
    expect(await act({ intent: "dismissIssue", issueId: error.id })).toMatchObject({ ok: false, error: "issue.cannotDismissError" });

    // Попередження додаємо напряму, щоб тест не залежав від складу демо-даних.
    const group = data.groups[0]!;
    const db = (await getDemoRuntime()).handle.db;
    const [warning] = await db
      .insert(issues)
      .values({
        orderId: group.orderId,
        code: "EMAIL_INVALID",
        severity: "warning",
        field: "email",
        params: {},
        fingerprint: `${group.orderId}:EMAIL_INVALID:test`,
      })
      .returning();
    expect(await act({ intent: "dismissIssue", issueId: warning!.id }, "staff")).toEqual({ ok: true, message: "result.issue.dismissed" });
    const resolved = allIssues(await load("?tab=resolved&severity=warning")).find((i) => i.id === warning!.id);
    expect(resolved).toMatchObject({ resolution: "dismissed", severity: "warning" });
  });
});

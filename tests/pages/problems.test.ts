import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { ActionResult } from "~/components/action-banner";
import { issues, orders } from "~/db/schema";
import { makeActor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { resetEnvCache } from "~/lib/env.server";
import { listOrderIdsByStatus, validateOrders } from "~/modules/orders/workflow.server";
import { PROBLEM_CATEGORIES, PROBLEM_SOURCES } from "~/modules/problems/categories";
import { demoRoleCookie } from "~/server/cookies.server";
import { demoServiceContext, getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Проблеми (/demo/problems): групування за замовленнями, швидкі фільтри й фільтри, застосування пропозиції,
 * приховування попередження, масові дії. Справжні запити до демо-середовища (PGlite у пам'яті, окреме для файлу).
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

async function act(
  fields: Record<string, string | string[]>,
  opts: { role?: "owner" | "staff"; search?: string } = {},
): Promise<ActionResult> {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    for (const value of Array.isArray(v) ? v : [v]) body.append(k, value);
  }
  const headers: HeadersInit = opts.role ? { Cookie: await demoRoleCookie.serialize(opts.role) } : {};
  return page.action({
    request: new Request(`${BASE}${opts.search ?? ""}`, { method: "POST", body, headers }),
    params: {},
    context: {},
  } as never);
}

async function db() {
  return (await getDemoRuntime()).handle.db;
}

async function addWarning(orderId: string, code = "EMAIL_INVALID", field: string | null = "email") {
  const [row] = await (await db())
    .insert(issues)
    .values({ orderId, code, severity: "warning", field, params: {}, fingerprint: `${orderId}:${code}:${Math.random()}` })
    .returning();
  return row!;
}

async function issueStatus(id: string) {
  const [row] = await (await db()).select({ s: issues.status }).from(issues).where(eq(issues.id, id));
  return row?.s;
}

type Data = Awaited<ReturnType<typeof load>>;
const allIssues = (data: Data) => data.groups.flatMap((g) => g.issues);

describe("problems loader", () => {
  it("groups open issues by order, errors first, with matching totals and chip counts", async () => {
    const data = await load();
    expect(data.filters).toEqual({
      tab: "open",
      category: null,
      severity: null,
      country: null,
      source: null,
      suggestion: false,
      q: "",
      page: 1,
    });
    expect(data.isFiltered).toBe(false);
    expect(data.totals.total).toBeGreaterThan(0);
    expect(data.totalIssues).toBe(data.totals.total);
    expect(data.totalGroups).toBe(data.totals.orders);
    // Демо-даних менше за одну сторінку (20 замовлень) — показано всі проблеми.
    expect(data.pages).toBe(1);
    expect(allIssues(data)).toHaveLength(data.totalIssues);
    expect(new Set(data.groups.map((g) => g.orderId)).size).toBe(data.groups.length);
    const firstWithoutErrors = data.groups.findIndex((g) => g.errorCount === 0);
    if (firstWithoutErrors !== -1) expect(data.groups.slice(firstWithoutErrors).every((g) => g.errorCount === 0)).toBe(true);
    for (const g of data.groups) {
      expect(g.orderNumber).toMatch(/^#\d+$/);
      expect(g.editable).toBe(true);
      if (g.countryCode) expect(g.countryLabel).toBeTruthy();
    }
    const chips = PROBLEM_CATEGORIES.reduce((sum, c) => sum + data.facets.categories[c], 0);
    expect(chips).toBe(data.totals.total);
    expect(data.facets.severities).toEqual({ error: data.totals.errors, warning: data.totals.warnings });
  });

  it("does not expose customer PII in the list (only order number and country; values only in suggestions)", async () => {
    const data = await load();
    const ids = data.groups.map((g) => g.orderId!).filter(Boolean);
    const rows = await (await db())
      .select({ email: orders.email, last: orders.shipLastName, address: orders.shipAddress1 })
      .from(orders)
      .where(inArray(orders.id, ids));
    const json = JSON.stringify(data);
    for (const r of rows) {
      for (const v of [r.email, r.last, r.address]) if (v && v.length > 3) expect(json).not.toContain(v);
    }
    for (const g of data.groups) expect(Object.keys(g).sort()).not.toContain("customerName");
  });

  it("filters by category, severity, country, order number and suggestion; ignores invalid params", async () => {
    const errors = await load("?severity=error");
    expect(allIssues(errors).every((i) => i.severity === "error")).toBe(true);
    expect(errors.totalIssues).toBe(errors.totals.errors);
    expect(errors.isFiltered).toBe(true);

    const phone = await load("?category=phone");
    expect(allIssues(phone).length).toBeGreaterThan(0);
    expect(allIssues(phone).every((i) => i.category === "phone")).toBe(true);
    expect(phone.totalIssues).toBe(phone.facets.categories.phone);

    const suggested = await load("?suggestion=1");
    expect(allIssues(suggested).length).toBeGreaterThan(0);
    expect(allIssues(suggested).every((i) => i.candidates.length > 0)).toBe(true);

    const all = await load();
    const group = all.groups[0]!;
    const byNumber = await load(`?q=${encodeURIComponent(group.orderNumber!)}`);
    expect(byNumber.groups.map((g) => g.orderNumber)).toEqual([group.orderNumber]);
    if (group.countryCode) {
      const byCountry = await load(`?country=${group.countryCode.toLowerCase()}`);
      expect(byCountry.filters.country).toBe(group.countryCode);
      expect(byCountry.groups.every((g) => g.countryCode === group.countryCode)).toBe(true);
      expect(byCountry.countries.some((c) => c.code === group.countryCode)).toBe(true);
    }
    expect((await load("?source=carrier")).groups).toEqual([]);

    const bogus = await load(`?tab=archive&severity=fatal&category=x&source=y&country=1X&suggestion=yes&page=-1&q=${"9".repeat(80)}`);
    expect(bogus.filters).toMatchObject({ tab: "open", category: null, severity: null, source: null, country: null, suggestion: false, page: 1 });
    expect(bogus.filters.q).toHaveLength(40);
  });

  it("has texts for every category and source", () => {
    const keys = [...PROBLEM_CATEGORIES.map((c) => `problems.category.${c}`), ...PROBLEM_SOURCES.map((s) => `problems.source.${s}`)];
    expect(keys.filter((k) => !DICTIONARIES.uk[k] || !DICTIONARIES.en[k])).toEqual([]);
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
    expect(await act({ intent: "bulkRevalidate", orderIds: ["x", "1' or 1=1"] })).toEqual({
      ok: false,
      error: "problems.bulk.noneSelected",
    });
  });

  it("applies a stored candidate; a tampered candidate is rejected server-side", async () => {
    const data = await load();
    const issue = allIssues(data).find((i) => i.code === "PHONE_AMBIGUOUS");
    expect(issue).toBeDefined();
    if (!issue) return;
    expect(issue.candidates.length).toBeGreaterThan(1);

    // Значення, якого немає серед збережених варіантів (підмінене в формі), — відхиляється, дані не змінюються.
    expect(await act({ intent: "acceptSuggestion", issueId: issue.id, candidate: "+10000000000" })).toMatchObject({
      ok: false,
      error: "issue.invalidCandidate",
    });
    expect(await act({ intent: "acceptSuggestion", issueId: issue.id, candidate: "x".repeat(500) })).toMatchObject({
      ok: false,
      error: "issue.invalidCandidate",
    });
    expect(await issueStatus(issue.id)).toBe("open");

    const result = await act({ intent: "acceptSuggestion", issueId: issue.id, candidate: issue.candidates[0]! }, { role: "staff" });
    expect(result).toMatchObject({ ok: true, message: "result.suggestion.accepted" });
    expect(result.ok && result.extra?.[0]).toMatch(/^problems\.result\.revalidated\.(ready|blocking)$/);

    expect(allIssues(await load()).some((i) => i.id === issue.id)).toBe(false);
    const resolved = allIssues(await load("?tab=resolved&category=phone")).find((i) => i.id === issue.id);
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
    expect(await issueStatus(error.id)).toBe("open");

    const warning = await addWarning(data.groups[0]!.orderId!);
    expect(await act({ intent: "dismissIssue", issueId: warning.id }, { role: "staff" })).toEqual({
      ok: true,
      message: "result.issue.dismissed",
    });
    const resolved = allIssues(await load("?tab=resolved&severity=warning")).find((i) => i.id === warning.id);
    expect(resolved).toMatchObject({ resolution: "dismissed", severity: "warning" });
  });

  it("bulk: re-validates selected orders", async () => {
    const data = await load();
    const ids = data.groups.slice(0, 2).map((g) => g.orderId!);
    const res = await act({ intent: "bulkRevalidate", orderIds: ids }, { role: "staff" });
    expect(res).toMatchObject({ ok: true, message: "problems.bulk.revalidated", params: { ok: ids.length, failed: 0 } });
    if (res.ok && Number(res.params?.blocking) > 0) expect(res.extra).toContain("problems.bulk.revalidated.blocking");
  });

  it("bulk: dismisses only warnings matching the current filters; errors stay", async () => {
    const data = await load();
    const [a, b] = data.groups;
    const contactWarning = await addWarning(a!.orderId!);
    const otherWarning = await addWarning(a!.orderId!, "SHOPIFY_SYNC_FAILED", null);
    const notSelected = await addWarning(b!.orderId!);
    const errorsBefore = allIssues(await load("?severity=error")).length;

    // Фільтр «лише помилки» — попереджень не видно, нічого не приховується.
    expect(await act({ intent: "bulkDismissWarnings", orderIds: [a!.orderId!] }, { search: "?severity=error" })).toMatchObject({
      ok: true,
      message: "problems.bulk.dismissed.none",
    });
    expect(await issueStatus(contactWarning.id)).toBe("open");

    const res = await act({ intent: "bulkDismissWarnings", orderIds: [a!.orderId!] }, { role: "staff", search: "?category=contact" });
    expect(res).toMatchObject({ ok: true, message: "problems.bulk.dismissed", params: { dismissed: 1, orders: 1, failed: 0 } });
    expect(await issueStatus(contactWarning.id)).toBe("dismissed");
    expect(await issueStatus(otherWarning.id)).toBe("open");
    expect(await issueStatus(notSelected.id)).toBe("open");

    const rest = await act({ intent: "bulkDismissWarnings", orderIds: [a!.orderId!] });
    expect(rest.ok).toBe(true);
    expect(await issueStatus(otherWarning.id)).toBe("dismissed");
    expect(allIssues(await load("?severity=error")).length).toBe(errorsBefore);
    // Масові дії — лише на вкладці відкритих проблем.
    expect(await act({ intent: "bulkDismissWarnings", orderIds: [b!.orderId!] }, { search: "?tab=resolved" })).toEqual({
      ok: false,
      error: "error.generic",
    });
    expect(await issueStatus(notSelected.id)).toBe("open");
  });

  it("paginates groups", async () => {
    const data = await load("?page=999");
    expect(data.page).toBe(data.pages);
    expect(data.filters.page).toBe(data.pages);
    expect(data.groups.length).toBeGreaterThan(0);
  });
});

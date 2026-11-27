import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { auditLog, issues, orders } from "~/db/schema";
import { ForbiddenError, makeActor } from "~/domain/permissions";
import { listOrderIdsByStatus, validateOrders } from "~/modules/orders/workflow.server";
import {
  PROBLEM_CATEGORIES,
  categoryCodeFilter,
  problemCategory,
  problemSource,
} from "~/modules/problems/categories";
import { dismissWarnings, queryProblems } from "~/modules/problems/problems.server";
import { ISSUE_CODES } from "~/modules/validation/types";
import { createTestEnv, STAFF, type TestEnv } from "../helpers";

/** Розділ «Проблеми»: запит із фільтрами, лічильники фасетів, сторінки, масове приховування попереджень. */
let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
  const ctx = env.ctx();
  await validateOrders(ctx, await listOrderIdsByStatus(ctx.db, ["paid"]));
});

afterAll(async () => {
  await env.close();
});

async function insertIssue(orderNumber: string, values: Partial<typeof issues.$inferInsert> & { code: string }) {
  const orderId = await env.orderId(orderNumber);
  const [row] = await env.handle.db
    .insert(issues)
    .values({
      orderId,
      severity: "warning",
      field: null,
      params: {},
      fingerprint: `${orderId}:${values.code}:${Math.random()}`,
      ...values,
    })
    .returning();
  return row!;
}

async function firstOrderNumbers(n: number): Promise<string[]> {
  const rows = await env.handle.db.select({ n: orders.orderNumber }).from(orders).orderBy(orders.orderNumber).limit(n);
  return rows.map((r) => r.n);
}

describe("categories", () => {
  it("maps every known code to a category; unknown codes → other", () => {
    for (const code of ISSUE_CODES) expect(PROBLEM_CATEGORIES).toContain(problemCategory(code));
    expect(problemCategory("PHONE_AMBIGUOUS")).toBe("phone");
    expect(problemCategory("POSTAL_CODE_INVALID")).toBe("address");
    expect(problemCategory("PRODUCT_HS_CODE_MISSING")).toBe("customs");
    expect(problemCategory("SOMETHING_NEW_FROM_STAGE_5")).toBe("other");
    expect(problemCategory("constructor")).toBe("other");
  });

  it("derives the source from the code", () => {
    expect(problemSource("PHONE_INVALID")).toBe("validation");
    expect(problemSource("CARRIER_REJECTED")).toBe("carrier");
    expect(problemSource("CARRIER_SHIPMENT_DELETED")).toBe("tracking");
    expect(problemSource("DELIVERY_PROBLEM")).toBe("tracking");
    expect(problemSource("SHOPIFY_ORDER_CHANGED")).toBe("shopify");
  });

  it("other = everything not in a named category (including future codes)", () => {
    const f = categoryCodeFilter("other");
    expect("exclude" in f && f.exclude).toContain("PHONE_INVALID");
    const p = categoryCodeFilter("phone");
    expect("include" in p && p.include.sort()).toEqual(["PHONE_AMBIGUOUS", "PHONE_INVALID", "PHONE_MISSING"]);
  });
});

describe("queryProblems", () => {
  it("groups open issues by order with consistent totals and facets", async () => {
    const all = await queryProblems(env.handle.db, { pageSize: 100 });
    expect(all.totalGroups).toBeGreaterThan(0);
    expect(all.groups).toHaveLength(all.totalGroups);
    const flat = all.groups.flatMap((g) => g.issues);
    expect(flat).toHaveLength(all.totalIssues);
    expect(new Set(all.groups.map((g) => g.orderId)).size).toBe(all.groups.length);
    for (const g of all.groups) {
      expect(g.issues.length).toBe(g.errorCount + g.warningCount);
      // Помилки першими всередині групи.
      const firstWarning = g.issues.findIndex((i) => i.severity === "warning");
      if (firstWarning !== -1) expect(g.issues.slice(firstWarning).every((i) => i.severity === "warning")).toBe(true);
    }
    // Замовлення з помилками — першими.
    const firstNoErrors = all.groups.findIndex((g) => g.errorCount === 0);
    if (firstNoErrors !== -1) expect(all.groups.slice(firstNoErrors).every((g) => g.errorCount === 0)).toBe(true);

    const sumCategories = Object.values(all.facets.categories).reduce((a, b) => a + b, 0);
    expect(sumCategories).toBe(all.totalIssues);
    expect(all.facets.severities.error + all.facets.severities.warning).toBe(all.totalIssues);
    expect(all.countries.every((c) => /^[A-Z]{2}$/.test(c))).toBe(true);
  });

  it("filters by category and severity; facets ignore their own dimension", async () => {
    const all = await queryProblems(env.handle.db, { pageSize: 100 });
    for (const category of PROBLEM_CATEGORIES) {
      const res = await queryProblems(env.handle.db, { category, pageSize: 100 });
      expect(res.totalIssues, category).toBe(all.facets.categories[category]);
      expect(res.groups.flatMap((g) => g.issues).every((i) => i.category === category)).toBe(true);
      // Лічильники категорій не залежать від вибраної категорії.
      expect(res.facets.categories).toEqual(all.facets.categories);
    }
    const errors = await queryProblems(env.handle.db, { severity: "error", pageSize: 100 });
    expect(errors.totalIssues).toBe(all.facets.severities.error);
    expect(errors.groups.flatMap((g) => g.issues).every((i) => i.severity === "error")).toBe(true);
    expect(errors.facets.severities).toEqual(all.facets.severities);
    const errorCategoriesSum = Object.values(errors.facets.categories).reduce((a, b) => a + b, 0);
    expect(errorCategoriesSum).toBe(all.facets.severities.error);
  });

  it("filters by country, order number, source and suggestion", async () => {
    const all = await queryProblems(env.handle.db, { pageSize: 100 });
    const country = all.countries[0]!;
    const byCountry = await queryProblems(env.handle.db, { country: country.toLowerCase(), pageSize: 100 });
    expect(byCountry.groups.length).toBeGreaterThan(0);
    expect(byCountry.groups.every((g) => g.countryCode === country)).toBe(true);

    const number = all.groups[0]!.orderNumber!;
    const byNumber = await queryProblems(env.handle.db, { q: number.replace("#", "") });
    expect(byNumber.groups.map((g) => g.orderNumber)).toContain(number);
    expect(byNumber.groups.every((g) => g.orderNumber!.includes(number.replace("#", "")))).toBe(true);
    // Символи LIKE не є шаблоном.
    expect((await queryProblems(env.handle.db, { q: "%" })).totalGroups).toBe(0);

    const suggested = await queryProblems(env.handle.db, { hasSuggestion: true, pageSize: 100 });
    expect(suggested.totalIssues).toBeGreaterThan(0);
    expect(suggested.groups.flatMap((g) => g.issues).every((i) => (i.suggestion?.candidates.length ?? 0) > 0)).toBe(true);

    const [a, b] = await firstOrderNumbers(2);
    const carrier = await insertIssue(a!, { code: "CARRIER_REJECTED", severity: "error" });
    const shopify = await insertIssue(b!, { code: "SHOPIFY_SYNC_FAILED", severity: "warning" });
    const tracking = await insertIssue(b!, { code: "CARRIER_SHIPMENT_DELETED", severity: "warning" });
    const future = await insertIssue(b!, { code: "FUTURE_CODE_X", severity: "warning" });
    const ids = (r: Awaited<ReturnType<typeof queryProblems>>) => r.groups.flatMap((g) => g.issues.map((i) => i.id));

    expect(ids(await queryProblems(env.handle.db, { source: "carrier", pageSize: 100 }))).toEqual([carrier.id]);
    expect(ids(await queryProblems(env.handle.db, { source: "shopify", pageSize: 100 }))).toEqual([shopify.id]);
    expect(ids(await queryProblems(env.handle.db, { source: "tracking", pageSize: 100 }))).toEqual([tracking.id]);
    const validation = ids(await queryProblems(env.handle.db, { source: "validation", pageSize: 100 }));
    expect(validation).toContain(future.id);
    expect(validation).not.toContain(carrier.id);
    expect(ids(await queryProblems(env.handle.db, { category: "other", pageSize: 100 }))).toContain(future.id);
    expect(ids(await queryProblems(env.handle.db, { category: "delivery", pageSize: 100 }))).toEqual([tracking.id]);

    await env.handle.db.delete(issues).where(eq(issues.code, "CARRIER_REJECTED"));
    for (const id of [shopify.id, tracking.id, future.id]) await env.handle.db.delete(issues).where(eq(issues.id, id));
  });

  it("paginates by order and clamps the page", async () => {
    const all = await queryProblems(env.handle.db, { pageSize: 100 });
    const pageSize = 2;
    const seen: (string | null)[] = [];
    const first = await queryProblems(env.handle.db, { pageSize });
    expect(first.pages).toBe(Math.ceil(all.totalGroups / pageSize));
    for (let p = 1; p <= first.pages; p++) {
      const res = await queryProblems(env.handle.db, { pageSize, page: p });
      expect(res.groups.length).toBeLessThanOrEqual(pageSize);
      seen.push(...res.groups.map((g) => g.orderId));
    }
    expect(seen).toEqual(all.groups.map((g) => g.orderId));
    const far = await queryProblems(env.handle.db, { pageSize, page: 999 });
    expect(far.page).toBe(first.pages);
    expect(far.groups.length).toBeGreaterThan(0);
  });
});

describe("dismissWarnings", () => {
  it("requires orders.edit", async () => {
    const viewer = makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { revoke: ["orders.edit"] } });
    await expect(dismissWarnings(env.ctx(viewer), [await env.orderId("#1001")])).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("dismisses only open warnings of the selected orders matching the filter; errors stay", async () => {
    const [a, b] = await firstOrderNumbers(2);
    const w1 = await insertIssue(a!, { code: "EMAIL_INVALID", field: "email" });
    const w2 = await insertIssue(a!, { code: "SHOPIFY_SYNC_FAILED" });
    const other = await insertIssue(b!, { code: "EMAIL_INVALID", field: "email" });
    const err = await insertIssue(a!, { code: "CARRIER_UNAVAILABLE", severity: "error" });

    // Фільтр категорії: лише «contact».
    const res = await dismissWarnings(env.ctx(STAFF), [w1.orderId!], { category: "contact" });
    expect(res).toEqual({ dismissed: 1, orders: 1, failed: 0 });
    const status = async (id: string) =>
      (await env.handle.db.select({ s: issues.status }).from(issues).where(eq(issues.id, id)))[0]!.s;
    expect(await status(w1.id)).toBe("dismissed");
    expect(await status(w2.id)).toBe("open");
    expect(await status(other.id)).toBe("open");
    expect(await status(err.id)).toBe("open");

    const rest = await dismissWarnings(env.ctx(STAFF), [w1.orderId!]);
    expect(rest.dismissed).toBeGreaterThanOrEqual(1);
    expect(await status(w2.id)).toBe("dismissed");
    expect(await status(err.id)).toBe("open");
    expect(await status(other.id)).toBe("open");

    const audit = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "issue.dismissed"));
    expect(audit.map((r) => r.entityId)).toEqual(expect.arrayContaining([w1.id, w2.id]));

    for (const id of [other.id, err.id]) await env.handle.db.delete(issues).where(eq(issues.id, id));
  });

  it("closed tab lists resolved and dismissed issues", async () => {
    const closed = await queryProblems(env.handle.db, { tab: "closed", pageSize: 100 });
    const flat = closed.groups.flatMap((g) => g.issues);
    expect(flat.length).toBeGreaterThan(0);
    expect(flat.every((i) => i.resolvedAt !== null)).toBe(true);
    expect(flat.some((i) => i.resolution === "dismissed")).toBe(true);
  });
});

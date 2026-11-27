import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ActionResult } from "~/components/action-banner";
import { resetEnvCache } from "~/lib/env.server";

/**
 * Замовлення (/demo/orders): loader (фільтри, вкладки, сторінки) і масові дії через справжні запити
 * до демо-середовища (PGlite у пам'яті). Глобальне демо-середовище — окреме для кожного файлу (pool: forks).
 */
const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };

let page: typeof import("~/pages/orders");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/orders");
});

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetEnvCache();
});

const BASE = "http://localhost/demo/orders";

async function load(search = "") {
  return page.loader({ request: new Request(`${BASE}${search}`), params: {}, context: {} } as never);
}

async function act(intent: string, ids: string[]): Promise<ActionResult> {
  const body = new FormData();
  body.set("intent", intent);
  for (const id of ids) body.append("orderIds", id);
  return page.action({ request: new Request(BASE, { method: "POST", body }), params: {}, context: {} } as never);
}

describe("orders loader", () => {
  it("lists orders with tab counts and country options", async () => {
    const data = await load();
    expect(data.isFiltered).toBe(false);
    expect(data.counts.all).toBe(data.total);
    expect(data.counts.byStatus.paid).toBe(13);
    expect(data.rows.length).toBe(Math.min(data.total, 25));
    expect(data.page).toBe(1);
    expect(data.countries.length).toBeGreaterThan(0);
    expect(data.countries.every((c) => /^[A-Z]{2}$/.test(c.code) && c.name.length > 0)).toBe(true);
  });

  it("ignores invalid params and clamps the page", async () => {
    const data = await load("?status=bogus&country=1X&page=abc&problems=yes");
    expect(data.isFiltered).toBe(false);
    expect(data.filters).toMatchObject({ status: null, country: null, problems: false, page: 1 });

    const far = await load("?page=999");
    expect(far.page).toBe(far.pages);
    expect(far.rows.length).toBeGreaterThan(0);

    const long = await load(`?q=${"x".repeat(300)}`);
    expect(long.filters.q.length).toBe(100);
    expect(long.rows).toEqual([]);
  });

  it("filters by status, search and country", async () => {
    const paid = await load("?status=paid");
    expect(paid.rows.length).toBe(13);
    expect(paid.rows.every((r) => r.status === "paid")).toBe(true);

    const found = await load(`?q=${encodeURIComponent("#1001")}`);
    expect(found.rows.map((r) => r.orderNumber)).toContain("#1001");

    const first = paid.rows[0]!;
    const byCountry = await load(`?country=${first.countryCode!.toLowerCase()}`);
    expect(byCountry.filters.country).toBe(first.countryCode);
    expect(byCountry.rows.every((r) => r.countryCode === first.countryCode)).toBe(true);
  });
});

describe("orders filters (compact filter block)", () => {
  it("combines status, country, search and problems filters and keeps them across pages", async () => {
    const all = await load();
    const first = all.rows.find((r) => r.countryCode)!;
    const combined = await load(`?status=${first.status}&country=${first.countryCode}&q=${encodeURIComponent(first.orderNumber)}`);
    expect(combined.isFiltered).toBe(true);
    expect(combined.filters).toMatchObject({ status: first.status, country: first.countryCode, q: first.orderNumber, problems: false });
    expect(combined.rows.map((r) => r.id)).toContain(first.id);
    expect(combined.rows.every((r) => r.status === first.status && r.countryCode === first.countryCode)).toBe(true);

    const withProblems = await load("?problems=1");
    expect(withProblems.isFiltered).toBe(true);
    expect(withProblems.rows.every((r) => r.openIssueCount > 0)).toBe(true);
  });
});

describe("orders bulk actions", () => {
  it("rejects empty or malformed selections and unknown intents", async () => {
    expect(await act("bulkValidate", ["not-a-uuid", "1' or 1=1"])).toEqual({ ok: false, error: "orders.bulk.noneSelected" });
    expect(await act("dropTables", ["00000000-0000-4000-8000-000000000000"])).toEqual({ ok: false, error: "error.generic" });
  });

  it("validates selected orders and summarizes the outcome", async () => {
    const paid = await load("?status=paid");
    const res = await act("bulkValidate", paid.rows.map((r) => r.id));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toBe("result.bulk.validated");
    expect(res.params).toMatchObject({ ok: 13, failed: 0, needsCorrection: 6 });
    expect(res.extra).toContain("orders.bulk.validated.needsCorrection");
    expect(res.tone).toBe("warning");

    const problems = await load("?problems=1");
    expect(problems.rows.length).toBe(6);
    expect(problems.counts.problems).toBe(6);
    expect(problems.rows.every((r) => r.openIssueCount > 0)).toBe(true);
  });

  it("creates test waybills only for eligible orders and never duplicates them", async () => {
    const ready = await load("?status=awaiting_review");
    const blocked = await load("?status=needs_correction");
    const readyIds = ready.rows.map((r) => r.id);
    expect(readyIds.length).toBeGreaterThan(0);

    const res = await act("bulkWaybills", [...readyIds, blocked.rows[0]!.id]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.message).toBe("result.bulk.waybills");
    expect(res.params).toMatchObject({ created: readyIds.length, existing: 0, skipped: 1, notEligible: 1 });
    expect(res.extra).toEqual(expect.arrayContaining(["orders.bulk.waybills.testCreated", "orders.bulk.waybills.notEligible"]));

    const again = await act("bulkWaybills", readyIds);
    expect(again.ok && again.params).toMatchObject({ created: 0, existing: readyIds.length, skipped: 0 });

    const created = await load("?status=waybill_created");
    const mine = created.rows.filter((r) => readyIds.includes(r.id));
    expect(mine.length).toBe(readyIds.length);
    expect(mine.every((r) => r.waybillNumber)).toBe(true);
  });
});

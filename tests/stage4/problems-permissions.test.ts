import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { issues } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { resetEnvCache } from "~/lib/env.server";
import { listOrderIdsByStatus, validateOrders } from "~/modules/orders/workflow.server";
import { demoServiceContext, getDemoRuntime } from "~/server/demo-runtime.server";

/**
 * Дозволи розділу «Проблеми» перевіряються на сервері: перегляд — problems.view,
 * будь-яка зміна — orders.edit, масова повторна перевірка — ще й orders.bulk.
 * Роль у демо обирається лише як owner/staff, тому діяча з обмеженими правами підставляємо через мок контексту.
 */
let actorOverride: Actor | null = null;

vi.mock("~/server/context.server", async (importOriginal) => {
  const original = await importOriginal<typeof import("~/server/context.server")>();
  return {
    ...original,
    getRequestContext: async (request: Request) => {
      const ctx = await original.getRequestContext(request);
      return actorOverride ? { ...ctx, actor: actorOverride } : ctx;
    },
  };
});

const saved = { DEMO_MODE: process.env.DEMO_MODE, DEMO_DATA_DIR: process.env.DEMO_DATA_DIR, DEMO_PASSWORD: process.env.DEMO_PASSWORD };
const OWNER = makeActor({ id: "test-owner", displayName: "Owner", role: "owner" });
const staffWithout = (...revoke: string[]) => makeActor({ id: "limited", displayName: "Limited", role: "staff", overrides: { revoke } });
const BASE = "http://localhost/demo/problems";

let page: typeof import("~/pages/problems");

beforeAll(async () => {
  process.env.DEMO_MODE = "true";
  process.env.DEMO_DATA_DIR = "memory";
  delete process.env.DEMO_PASSWORD;
  resetEnvCache();
  page = await import("~/pages/problems");
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

async function load(actor: Actor | null) {
  actorOverride = actor;
  try {
    return await page.loader({ request: new Request(BASE), params: {}, context: {} } as never);
  } finally {
    actorOverride = null;
  }
}

async function act(actor: Actor | null, fields: Record<string, string>) {
  actorOverride = actor;
  try {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) body.append(k, v);
    return await page.action({ request: new Request(BASE, { method: "POST", body }), params: {}, context: {} } as never);
  } finally {
    actorOverride = null;
  }
}

describe("problems permissions", () => {
  it("staff sees the list; without problems.view the loader answers 403", async () => {
    const staff = makeActor({ id: "staff", displayName: "Staff", role: "staff" });
    expect((await load(staff)).groups.length).toBeGreaterThan(0);
    const denied = await load(staffWithout("problems.view")).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(Response);
    expect((denied as Response).status).toBe(403);
  });

  it("without orders.edit every change is refused and nothing changes", async () => {
    const data = await load(OWNER);
    const all = data.groups.flatMap((g) => g.issues);
    const suggestion = all.find((i) => i.candidates.length > 0)!;
    const orderId = data.groups[0]!.orderId!;
    const viewer = staffWithout("orders.edit");
    const cases: Array<Record<string, string>> = [
      { intent: "acceptSuggestion", issueId: suggestion.id, candidate: suggestion.candidates[0]! },
      { intent: "dismissIssue", issueId: suggestion.id },
      { intent: "bulkRevalidate", orderIds: orderId },
      { intent: "bulkDismissWarnings", orderIds: orderId },
    ];
    for (const fields of cases) {
      expect(await act(viewer, fields), fields.intent).toEqual({ ok: false, error: "error.forbidden" });
    }
    const db = (await getDemoRuntime()).handle.db;
    const [row] = await db.select({ status: issues.status }).from(issues).where(eq(issues.id, suggestion.id));
    expect(row?.status).toBe("open");
  });

  it("bulk re-validation additionally requires orders.bulk; bulk dismiss needs only orders.edit", async () => {
    const data = await load(OWNER);
    const orderId = data.groups[0]!.orderId!;
    const noBulk = staffWithout("orders.bulk");
    expect(await act(noBulk, { intent: "bulkRevalidate", orderIds: orderId })).toEqual({ ok: false, error: "error.forbidden" });
    expect(await act(noBulk, { intent: "bulkDismissWarnings", orderIds: orderId })).toMatchObject({ ok: true });
  });
});

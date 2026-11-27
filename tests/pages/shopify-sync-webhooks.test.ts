import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { auditLog, jobs, shopInstallations } from "~/db/schema";
import { JOB } from "~/modules/shopify-sync/jobs";
import { WEBHOOK_SUBSCRIPTIONS, webhookConfigKey } from "~/modules/shopify-sync/webhook-subscriptions.server";
import { getEnv } from "~/lib/env.server";
import type { RequestContext } from "~/server/types";
import type { Actor } from "~/domain/permissions";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";

/**
 * «Синхронізація Shopify» (NEW-G4-2): стан підписок на webhooks наявного встановлення і кнопка «Оновити підписки»
 * (лише власник). Контекст запиту підмінено (робочий режим без Shopify — діагностика доставки необов'язкова).
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

const SHOP = "ot-sync-page.myshopify.com";
let env: TestEnv;
let page: typeof import("~/pages/shopify-sync");
beforeAll(async () => {
  env = await createTestEnv({ seed: false });
  page = await import("~/pages/shopify-sync");
  await env.handle.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_products", webhookTopics: "ORDERS_CREATE,PRODUCTS_UPDATE" });
});
afterAll(async () => {
  await env.close();
});
function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), mode: "production", basePath: "/app", locale: "uk" };
}
beforeEach(() => setContext());

const load = () => page.loader({ request: new Request("http://localhost/app/shopify-sync"), params: {}, context: {} } as never);
async function act(fields: Record<string, string>) {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return page.action({ request: new Request("http://localhost/app/shopify-sync", { method: "POST", body }), params: {}, context: {} } as never);
}

describe("shopify sync page: webhook subscriptions", () => {
  it("shows the topics Shopify confirmed and which topics (collections) are still missing", async () => {
    const data = await load();
    expect(data.webhooks).toMatchObject({ state: "outdated", registered: ["ORDERS_CREATE", "PRODUCTS_UPDATE"] });
    expect(data.webhooks!.missing).toEqual(expect.arrayContaining(["COLLECTIONS_CREATE", "COLLECTIONS_UPDATE", "COLLECTIONS_DELETE"]));
    // Після реєстрації з поточною конфігурацією — «актуальні».
    await env.handle.db
      .update(shopInstallations)
      .set({ webhookTopics: WEBHOOK_SUBSCRIPTIONS.map((s) => s.topic).join(","), webhooksConfigKey: webhookConfigKey(getEnv().SHOPIFY_APP_URL ?? "") })
      .where(eq(shopInstallations.shop, SHOP));
    expect((await load()).webhooks).toMatchObject({ state: "up_to_date", missing: [] });
  });

  it("the owner queues a forced re-registration (audited); staff cannot", async () => {
    expect(await act({ intent: "registerWebhooks" })).toMatchObject({ ok: true, message: "shopify.result.webhooksQueued" });
    const queued = await env.handle.db.select().from(jobs).where(and(eq(jobs.type, JOB.ensureWebhooks), eq(jobs.status, "queued")));
    expect(queued.map((j) => j.payload)).toEqual([{ force: true }]);
    const audit = await env.handle.db.select().from(auditLog).where(eq(auditLog.action, "shopify.webhooks_register_requested"));
    expect(audit).toHaveLength(1);
    setContext(STAFF);
    expect(await act({ intent: "registerWebhooks" })).toMatchObject({ ok: false });
    expect(await env.handle.db.select().from(jobs).where(eq(jobs.type, JOB.ensureWebhooks))).toHaveLength(1);
  });
});

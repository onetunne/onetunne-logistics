import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { jobs, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { QueueingShopifyGateway } from "~/integrations/shopify/queueing-gateway.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { JOB } from "~/modules/shopify-sync/jobs";
import { recordInstallation, recordUninstall } from "~/modules/shopify-sync/sync.server";
import {
  ENSURE_WEBHOOKS_DEDUPE_KEY,
  WEBHOOK_SUBSCRIPTIONS,
  enqueueWebhookSubscriptionCheck,
  ensureWebhookSubscriptions,
  recordWebhookRegistration,
  webhookConfigKey,
  webhookSubscriptionStatus,
  type WebhookRegisterReturn,
} from "~/modules/shopify-sync/webhook-subscriptions.server";
import { WEBHOOK_TOPICS } from "~/modules/shopify-sync/webhooks.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { fakeAdmin } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";

/**
 * Етап 5 (NEW-G4-2): нові теми webhooks (collections/*) для ВЖЕ встановленого застосунку. afterAuth для наявного
 * встановлення не гарантований, тож фоновий обробник порівнює відбиток конфігурації підписок і перереєстровує їх з
 * офлайн-сесією — без повторної авторизації власника.
 */
const SHOP = "ot-webhooks.myshopify.com";
const APP_URL = "https://ot-test.example.com";
const KEY = webhookConfigKey(APP_URL);
const ALL = WEBHOOK_SUBSCRIPTIONS.map((s) => s.topic);

let h: DatabaseHandle;
let calls: string[];
let nextResult: (topics: string[]) => WebhookRegisterReturn;
let handlers: ReturnType<typeof createSyncHandlers>;

/** Відповідь registerWebhooks: теми, яких ще немає (у «Shopify»), створюються; наявні — без операцій. */
const shopifySubscriptions = new Set<string>();
const okResult = (topics: string[]): WebhookRegisterReturn =>
  Object.fromEntries(
    topics.map((t) => {
      const created = !shopifySubscriptions.has(t);
      shopifySubscriptions.add(t);
      return [t, created ? [{ success: true }] : []];
    }),
  );
const registrar = (configKey = KEY) => ({
  configKey,
  register: async (shop: string) => {
    calls.push(shop);
    return nextResult(ALL);
  },
});

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  const ctx: ServiceContext = {
    mode: "production",
    db: h.db,
    actor: OWNER,
    carriers: createDemoCarriers(h.db),
    shopify: new QueueingShopifyGateway(h.db, async () => SHOP),
    now: () => new Date(),
  };
  const fake = fakeAdmin({ orders: new Map(), products: new Map() });
  handlers = createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin, webhooks: registrar() });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  calls = [];
  nextResult = okResult;
  await h.db.delete(jobs);
});

const install = async () => (await h.db.select().from(shopInstallations).where(eq(shopInstallations.shop, SHOP)))[0]!;
const run = () => runJobsOnce(h.db, handlers, { limit: 50 });
const checkJobs = () => h.db.select().from(jobs).where(eq(jobs.type, JOB.ensureWebhooks));

describe("webhook subscriptions of an existing installation", () => {
  it("covers every webhook topic the app handles, including collections, plus the app lifecycle topics", () => {
    expect(ALL).toEqual(expect.arrayContaining([...WEBHOOK_TOPICS, "APP_UNINSTALLED", "APP_SCOPES_UPDATE"]));
    expect(ALL).toEqual(expect.arrayContaining(["COLLECTIONS_CREATE", "COLLECTIONS_UPDATE", "COLLECTIONS_DELETE"]));
    expect(new Set(ALL).size).toBe(ALL.length);
  });

  it("the config key changes with the app address and is stable otherwise", () => {
    expect(webhookConfigKey(`${APP_URL}/`)).toBe(KEY);
    expect(webhookConfigKey("https://other.example.com")).not.toBe(KEY);
  });

  it("not installed → nothing to register", async () => {
    expect(await ensureWebhookSubscriptions(h.db, registrar())).toBe("not_installed");
    expect(calls).toEqual([]);
  });

  it("an installation from before stage 5 (afterAuth does not run again) gets the new topics at worker start, without reinstalling", async () => {
    // Встановлення етапу 2: підписки без collections/*, відбитка немає.
    await recordInstallation(h.db, SHOP, "read_products");
    for (const t of ALL.filter((t) => !t.startsWith("COLLECTIONS_"))) shopifySubscriptions.add(t);
    expect(webhookSubscriptionStatus(await install(), KEY)).toMatchObject({ state: "unknown", missing: [] });

    expect(await enqueueWebhookSubscriptionCheck(h.db)).toBe(true);
    expect(await enqueueWebhookSubscriptionCheck(h.db)).toBe(false); // один очікуваний на всіх
    await run();
    expect(calls).toEqual([SHOP]);
    expect(shopifySubscriptions).toEqual(new Set(ALL));
    const row = await install();
    expect(row.webhooksConfigKey).toBe(KEY);
    expect(row.webhooksRegisteredAt).toBeInstanceOf(Date);
    expect(row.webhookTopics?.split(",").sort()).toEqual([...ALL].sort());
    const status = webhookSubscriptionStatus(row, KEY);
    expect(status).toMatchObject({ state: "up_to_date", missing: [] });
    expect(status.registered).toEqual(expect.arrayContaining(["COLLECTIONS_CREATE", "COLLECTIONS_UPDATE", "COLLECTIONS_DELETE"]));
    expect((await checkJobs()).map((j) => j.status)).toEqual(["succeeded"]);
  });

  it("an up-to-date installation is not re-registered on every start; a changed configuration is", async () => {
    await enqueueWebhookSubscriptionCheck(h.db);
    await run();
    expect(calls).toEqual([]);
    // Нова конфігурація (інша адреса застосунку / нові теми після оновлення) → перереєстрація.
    expect(await ensureWebhookSubscriptions(h.db, registrar(webhookConfigKey("https://moved.example.com")))).toBe("registered");
    expect(calls).toEqual([SHOP]);
    // Повернення до поточної конфігурації.
    expect(await ensureWebhookSubscriptions(h.db, registrar())).toBe("registered");
    expect((await install()).webhooksConfigKey).toBe(KEY);
  });

  it("the owner's button forces a re-registration even when the key matches", async () => {
    await enqueueWebhookSubscriptionCheck(h.db, { force: true });
    await run();
    expect(calls).toEqual([SHOP]);
    expect((await checkJobs())[0]!.dedupeKey).toBe(`${ENSURE_WEBHOOKS_DEDUPE_KEY}:force`);
  });

  it("a partially failed registration is retried and shows which topics are missing", async () => {
    await h.db.update(shopInstallations).set({ webhooksConfigKey: null }).where(eq(shopInstallations.shop, SHOP));
    nextResult = (topics) => ({
      ...(okResult(topics) as Record<string, Array<{ success: boolean }>>),
      COLLECTIONS_UPDATE: [{ success: false }],
    });
    await enqueueWebhookSubscriptionCheck(h.db);
    await run();
    const [job] = await checkJobs();
    expect(job).toMatchObject({ status: "queued", attempts: 1 });
    expect(job!.lastError).toContain("COLLECTIONS_UPDATE");
    const row = await install();
    expect(row.webhooksConfigKey).toBeNull();
    expect(webhookSubscriptionStatus(row, KEY)).toMatchObject({ state: "outdated", missing: ["COLLECTIONS_UPDATE"] });
    // Повтор вдається.
    nextResult = okResult;
    await h.db.update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, job!.id));
    await run();
    expect(webhookSubscriptionStatus(await install(), KEY)).toMatchObject({ state: "up_to_date", missing: [] });
  });

  it("THROTTLED (the library returns nothing) stores nothing and retries", async () => {
    await h.db.update(shopInstallations).set({ webhooksConfigKey: null }).where(eq(shopInstallations.shop, SHOP));
    const before = (await install()).webhookTopics;
    nextResult = () => undefined;
    await enqueueWebhookSubscriptionCheck(h.db);
    await run();
    expect((await checkJobs())[0]).toMatchObject({ status: "queued" });
    expect((await install()).webhookTopics).toBe(before);
    nextResult = okResult;
    expect(await ensureWebhookSubscriptions(h.db, registrar())).toBe("registered");
  });

  it("after uninstall the key is cleared, so a reinstall that fails to register in afterAuth is fixed by the check", async () => {
    await recordUninstall(h.db, SHOP);
    expect((await install()).webhooksConfigKey).toBeNull();
    shopifySubscriptions.clear();
    await recordInstallation(h.db, SHOP, "read_products");
    // afterAuth: registerWebhooks кинув помилку → лише запис встановлення; час реєстрації не підмінено.
    expect(webhookSubscriptionStatus(await install(), KEY).state).not.toBe("up_to_date");
    await enqueueWebhookSubscriptionCheck(h.db);
    await run();
    expect(calls).toEqual([SHOP]);
    expect(shopifySubscriptions).toEqual(new Set(ALL));
    expect(webhookSubscriptionStatus(await install(), KEY).state).toBe("up_to_date");
  });

  it("recordWebhookRegistration (afterAuth) records the confirmed topics", async () => {
    const at = new Date("2026-11-27T10:00:00Z");
    const outcome = await recordWebhookRegistration(h.db, SHOP, KEY, okResult(ALL), at);
    expect(outcome).toMatchObject({ complete: true, failed: [] });
    expect((await install()).webhooksRegisteredAt).toEqual(at);
  });

  it("without a registrar (demo, tests) the check job is a no-op", async () => {
    const fake = fakeAdmin({ orders: new Map(), products: new Map() });
    const bare = createSyncHandlers({ db: h.db, serviceContext: () => ({}) as ServiceContext, admin: async () => fake.admin });
    await h.db.update(shopInstallations).set({ webhooksConfigKey: null }).where(eq(shopInstallations.shop, SHOP));
    await enqueueWebhookSubscriptionCheck(h.db);
    await runJobsOnce(h.db, bare, { limit: 5 });
    expect(calls).toEqual([]);
    expect((await checkJobs())[0]).toMatchObject({ status: "succeeded" });
  });
});

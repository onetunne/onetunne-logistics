import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, like } from "drizzle-orm";
import type { DatabaseHandle } from "~/db/client.server";
import { auditLog, jobs, productVariants, shopInstallations } from "~/db/schema";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { DemoShopifyGateway } from "~/integrations/shopify/types";
import { initializeInventory } from "~/modules/inventory/opening.server";
import {
  INVENTORY_SYNC_JOB,
  SCHEDULED_RECONCILE_DEDUPE_KEY,
  SCHEDULED_RECONCILE_FIRST_DELAY_MS,
  SCHEDULED_RECONCILE_INTERVAL_MS,
  SCHEDULED_RECONCILE_REQUESTER,
} from "~/modules/inventory-sync/jobs";
import { fullReconcileActive, runScheduledReconcile, scheduleFullReconcileCheck } from "~/modules/inventory-sync/schedule.server";
import { getInventorySyncOverview } from "~/modules/inventory-sync/status.server";
import { runJobsOnce } from "~/modules/jobs/worker.server";
import { createSyncHandlers } from "~/modules/shopify-sync/handlers.server";
import { mapProduct } from "~/modules/shopify-sync/mappers";
import { upsertProduct } from "~/modules/shopify-sync/sync.server";
import { createDemoCarriers } from "~/server/demo-runtime.server";
import type { ServiceContext } from "~/server/types";
import { gqlProduct } from "../stage2/fixtures";
import { OWNER, openTestDatabase } from "../helpers";
import { fakeInventoryAdmin, type FakeInventoryAdmin } from "./inventory-sync-fixtures";

/**
 * Планова повна звірка залишків із Shopify (страховка від загублених webhook): ланцюжок одного завдання кожні 6 год,
 * повна звірка ставиться лише коли застосунок установлено, є read_inventory, облік відкрито й звірка ще не йде.
 * Перезапуск сервера не переносить і не множить заплановану перевірку. PGlite або TEST_DATABASE_URL.
 */
const SHOP = "ot-scheduled.myshopify.com";
const N = 3;

let h: DatabaseHandle;
let ctx: ServiceContext;
let fake: FakeInventoryAdmin;

beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
  ctx = { mode: "production", db: h.db, actor: OWNER, carriers: createDemoCarriers(h.db), shopify: new DemoShopifyGateway(), now: () => new Date() };
  for (let n = 1; n <= N; n++) await upsertProduct(h.db, mapProduct(gqlProduct(n)), "EUR"); // inventoryQuantity 12
  fake = fakeInventoryAdmin();
  for (let n = 1; n <= N; n++) {
    const [v] = await h.db
      .select({ gid: productVariants.inventoryItemId })
      .from(productVariants)
      .where(eq(productVariants.shopifyVariantId, `gid://shopify/ProductVariant/${n}01`));
    fake.setLevel(v!.gid!, { available: 12, onHand: 12, committed: 0 });
  }
});
afterAll(async () => {
  await h.close();
});

const queued = (type: string) => h.db.select().from(jobs).where(and(eq(jobs.type, type), eq(jobs.status, "queued")));
const fullJobs = () =>
  h.db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, INVENTORY_SYNC_JOB.reconcile), like(jobs.dedupeKey, "inventory.reconcile:all:%"), eq(jobs.status, "queued")));
const makeDue = (type: string) =>
  h.db
    .update(jobs)
    .set({ runAt: new Date(Date.now() - 1000) })
    .where(and(eq(jobs.type, type), eq(jobs.status, "queued")));
const handlers = () => createSyncHandlers({ db: h.db, serviceContext: () => ctx, admin: async () => fake.admin });

describe("scheduled full reconciliation with Shopify", () => {
  it("keeps one queued check; a server restart neither postpones nor duplicates it", async () => {
    const t0 = new Date("2030-03-01T10:00:00Z");
    expect(await scheduleFullReconcileCheck(h.db, { now: t0, delayMs: SCHEDULED_RECONCILE_FIRST_DELAY_MS })).toBe(true);
    expect(await scheduleFullReconcileCheck(h.db, { now: new Date(t0.getTime() + 60_000), delayMs: SCHEDULED_RECONCILE_FIRST_DELAY_MS })).toBe(false);
    const rows = await queued(INVENTORY_SYNC_JOB.scheduledReconcile);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dedupeKey).toBe(SCHEDULED_RECONCILE_DEDUPE_KEY);
    expect(rows[0]!.runAt.getTime()).toBe(t0.getTime() + SCHEDULED_RECONCILE_FIRST_DELAY_MS);
    await h.db.delete(jobs);
  });

  it("does nothing but reschedule while the app is not installed, lacks read_inventory or accounting is not opened", async () => {
    const now = new Date("2030-03-01T12:00:00Z");
    expect(await runScheduledReconcile(h.db, now)).toBe("not_installed");
    const [next] = await queued(INVENTORY_SYNC_JOB.scheduledReconcile);
    expect(next!.runAt.getTime()).toBe(now.getTime() + SCHEDULED_RECONCILE_INTERVAL_MS);

    await h.db.insert(shopInstallations).values({ shop: SHOP, scopes: "read_products" });
    expect(await runScheduledReconcile(h.db, now)).toBe("missing_scope");
    await h.db.update(shopInstallations).set({ scopes: "read_products,read_inventory" }).where(eq(shopInstallations.shop, SHOP));
    expect(await runScheduledReconcile(h.db, now)).toBe("not_opened");

    expect(await fullJobs()).toHaveLength(0);
    expect(await queued(INVENTORY_SYNC_JOB.scheduledReconcile)).toHaveLength(1);
    expect(fake.calls).toHaveLength(0); // жодного звернення до Shopify
    await h.db.delete(jobs);
  });

  it("queues exactly one full reconciliation once accounting is opened, and none while one is in progress", async () => {
    await initializeInventory(ctx);
    expect(await runScheduledReconcile(h.db)).toBe("queued");
    const [full] = await fullJobs();
    expect(full!.payload).toMatchObject({ scope: "all", shop: SHOP, after: null, requestedBy: SCHEDULED_RECONCILE_REQUESTER });
    expect(await fullReconcileActive(h.db)).toBe(true);

    expect(await runScheduledReconcile(h.db)).toBe("already_running");
    expect(await fullJobs()).toHaveLength(1);
    expect(await queued(INVENTORY_SYNC_JOB.scheduledReconcile)).toHaveLength(1);
    await h.db.delete(jobs);
  });

  it("runs end to end through the job worker: check → full reconcile (read-only) → next check in 6 h", async () => {
    await scheduleFullReconcileCheck(h.db, { delayMs: 0 });
    await makeDue(INVENTORY_SYNC_JOB.scheduledReconcile);
    const before = Date.now();
    await runJobsOnce(h.db, handlers(), { limit: 1 });
    expect(await fullJobs()).toHaveLength(1);
    const [next] = await queued(INVENTORY_SYNC_JOB.scheduledReconcile);
    expect(next!.runAt.getTime()).toBeGreaterThanOrEqual(before + SCHEDULED_RECONCILE_INTERVAL_MS - 1000);

    await runJobsOnce(h.db, handlers());
    expect(await fullJobs()).toHaveLength(0);
    const [finished] = await h.db.select().from(auditLog).where(eq(auditLog.action, "inventory_sync.reconcile_finished"));
    expect(finished!.details).toMatchObject({ scope: "all", checked: N, match: N });
    // Лише читання Shopify: жодної зміни залишків.
    expect(fake.adjustCalls()).toHaveLength(0);

    const overview = await getInventorySyncOverview(h.db);
    expect(overview.nextScheduledReconcileAt?.getTime()).toBe(next!.runAt.getTime());
    expect(overview.lastReconcile?.summary.checked).toBe(N);
  });
});

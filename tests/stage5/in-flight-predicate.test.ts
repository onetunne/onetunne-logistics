import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray, sql } from "drizzle-orm";
import { orders } from "~/db/schema";
import type { DatabaseHandle } from "~/db/client.server";
import { DEMO_SETTINGS, seedReferenceData } from "~/db/seed/seed.server";
import { isFulfilledInShopify } from "~/domain/order-status";
import { NOT_FULFILLED_IN_SHOPIFY_SQL, PARTIAL_PHYSICAL_FULFILLMENT_SQL } from "~/modules/inventory-sync/reconcile.server";
import { openTestDatabase } from "../helpers";

/**
 * Спільне правило «фізичні позиції ще не виконано в Shopify» (в дорозі): звірка складу (orderTiming) і планове
 * перечитування статусу виконання (fulfillment-refresh.server.ts) беруть ОДИН предикат з reconcile.server.ts — копії
 * правила в fulfillment-refresh немає (раніше зміну orderTiming треба було дублювати вручну).
 */
let h: DatabaseHandle;
beforeAll(async () => {
  h = await openTestDatabase();
  await seedReferenceData(h.db, DEMO_SETTINGS);
});
afterAll(async () => {
  await h.close();
});

const STATUSES = [null, "unfulfilled", "partially_fulfilled", "fulfilled", "restocked", "in_progress", "on_hold"] as const;
const SHIPPABLE = [null, true, false] as const;

describe("NOT_FULFILLED_IN_SHOPIFY_SQL (shared in-flight rule)", () => {
  it("matches the documented rule for every fulfillment status × shopify_shippable_fulfilled", async () => {
    const cases: Array<{ id: string; status: string | null; shippable: boolean | null }> = [];
    let n = 0;
    for (const status of STATUSES) {
      for (const shippable of SHIPPABLE) {
        n += 1;
        const [o] = await h.db
          .insert(orders)
          .values({
            source: "demo",
            orderNumber: `#T-INF-${n}`,
            currency: "EUR",
            subtotal: "1.00",
            total: "1.00",
            fulfillmentStatus: status,
            shopifyShippableFulfilled: shippable,
          })
          .returning({ id: orders.id });
        cases.push({ id: o!.id, status, shippable });
      }
    }
    const ids = cases.map((c) => c.id);
    const rows = await h.db
      .select({ id: orders.id, inFlight: sql<boolean>`${NOT_FULFILLED_IN_SHOPIFY_SQL}`, partial: sql<boolean>`${PARTIAL_PHYSICAL_FULFILLMENT_SQL}` })
      .from(orders)
      .where(inArray(orders.id, ids));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const c of cases) {
      // Не «в дорозі»: виконано в Shopify (isFulfilledInShopify: fulfilled або часткове виконання фізичних позицій,
      // null — як true) або старий статус restocked.
      const expected = !(isFulfilledInShopify(c.status, c.shippable) || c.status === "restocked");
      expect({ ...c, inFlight: Boolean(byId.get(c.id)!.inFlight) }).toEqual({ ...c, inFlight: expected });
      expect(Boolean(byId.get(c.id)!.partial)).toBe(c.status === "partially_fulfilled" && c.shippable !== false);
    }
  });

  it("fulfillment-refresh imports the shared predicate and keeps no copy of the rule", () => {
    const src = fs.readFileSync(path.resolve("app/modules/shopify-sync/fulfillment-refresh.server.ts"), "utf8");
    expect(src).toMatch(/import \{[^}]*\bNOT_FULFILLED_IN_SHOPIFY_SQL\b[^}]*\} from "~\/modules\/inventory-sync\/reconcile\.server"/);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/partially_fulfilled|'restocked'|shopifyShippableFulfilled|fulfillmentStatus/);
    const reconcile = fs.readFileSync(path.resolve("app/modules/inventory-sync/reconcile.server.ts"), "utf8");
    // orderTiming бере ті самі константи (правило визначено один раз).
    expect(reconcile.match(/= 'partially_fulfilled'/g)?.length).toBe(1);
  });
});

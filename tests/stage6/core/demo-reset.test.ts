/**
 * Етап 6 (WP0): скидання демо покриває КОЖНУ таблицю схеми (фінансові — у FINANCE_DEMO_RESET_TABLES, діти → батьки) і
 * повертає магазин 'default' до значень міграції; скидання журналу складу тестами етапу 5 (DELETE inventory_movements
 * без фільтра) не блокується оцінками етапу 6 (inventory_valuations.movement_id — без FK, §17 «Без FK — свідомо»).
 */
import { count, eq } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as schema from "~/db/schema";
import { DEMO_RESET_KEPT_TABLES, DEMO_RESET_TABLES, FINANCE_DEMO_RESET_TABLES, resetDemoData } from "~/db/seed/seed.server";
import { SYSTEM_ACTOR } from "~/domain/permissions";
import { postEntries } from "~/modules/finance/core/entries.server";
import { makeEntryInput } from "~/modules/finance/core/fakes";
import { getDefaultStore } from "~/modules/finance/core/store.server";
import { createTestEnv, type TestEnv } from "../../helpers";
import { allTables, nameOf, STAGE6_TABLES } from "./stage6-tables";

describe("demo reset covers every table", () => {
  it("each schema table is reset (finance list, stage 1–5 list) or documented as kept", () => {
    const covered = new Set([...FINANCE_DEMO_RESET_TABLES, ...DEMO_RESET_TABLES, ...DEMO_RESET_KEPT_TABLES].map((t) => nameOf(t as PgTable)));
    expect(allTables.map(nameOf).filter((n) => !covered.has(n))).toEqual([]);
    const finance = FINANCE_DEMO_RESET_TABLES.map((t) => nameOf(t as PgTable)).sort();
    expect(finance).toEqual(STAGE6_TABLES.filter((n) => n !== "stores" && n !== "finance_state"));
    expect(DEMO_RESET_KEPT_TABLES.map((t) => nameOf(t as PgTable))).toEqual(expect.arrayContaining(["stores", "finance_state"]));
  });

  let env: TestEnv;
  beforeAll(async () => {
    env = await createTestEnv();
  });
  afterAll(async () => {
    await env.close();
  });

  it("resetDemoData empties the finance tables and restores the default store", async () => {
    const db = env.handle.db;
    const orderId = await env.orderId("#1001");
    await db.update(schema.stores).set({ shopCurrency: "EUR", name: "demo" }).where(eq(schema.stores.id, "default"));
    await db.transaction((tx) => postEntries(tx, SYSTEM_ACTOR, [makeEntryInput({ idempotencyKey: "reset:1", orderId })]));
    await db.insert(schema.fxRates).values({ source: "demo", currency: "EUR", effectiveDate: "2026-11-01", rate: "48.5", units: 1, ratePerUnit: "48.5" });
    await db.insert(schema.financeDiscrepancies).values({ type: "order_unreadable", dedupeKey: "reset:d", orderId });
    await db.insert(schema.orderFinance).values({ orderId });
    await db.insert(schema.orderFinanceForecasts).values({ orderId, component: "fees", currency: "EUR", amount: "1.00", basis: "fee_rule" });
    await db.insert(schema.partners).values({ displayName: "Demo partner", createdBy: "test" });
    await resetDemoData(env.ctx(SYSTEM_ACTOR));
    for (const t of FINANCE_DEMO_RESET_TABLES) {
      const [row] = await db.select({ c: count() }).from(t as PgTable);
      expect(Number(row!.c), nameOf(t as PgTable)).toBe(0);
    }
    const store = await getDefaultStore(db);
    expect(store).toMatchObject({ id: "default", isDefault: true, shopCurrency: null, legalEntityId: null });
    const [state] = await db.select().from(schema.financeState);
    expect(state).toMatchObject({ storeId: "default", backfilledAt: null });
    // Повторне заповнення демо працює (замовлення знову є).
    expect(await env.orderId("#1001")).toBeTruthy();
  });

  it("an unfiltered DELETE of inventory_movements (stage-5 test resetLedger) is not blocked by stage-6 valuations", async () => {
    const db = env.handle.db;
    const [mv] = await db.select().from(schema.inventoryMovements).limit(1);
    expect(mv, "demo seed has movements").toBeTruthy();
    await db.insert(schema.inventoryValuations).values({
      eventKey: `mv:${mv!.id}`,
      movementId: mv!.id,
      movementSeq: mv!.seq,
      warehouseId: mv!.warehouseId,
      stockItemId: mv!.stockItemId,
      currency: "UAH",
      kind: "inflow",
      qty: 1,
      valueSource: "none",
      occurredOn: "2026-11-01",
    });
    // Як tests/stage5/opening.test.ts resetLedger і shippable-partial-opening.test.ts: без фільтра й без оцінок.
    await db.delete(schema.inventoryMovements);
    const [left] = await db.select({ c: count() }).from(schema.inventoryMovements);
    expect(Number(left!.c)).toBe(0);
    await db.delete(schema.inventoryValuations);
  });
});

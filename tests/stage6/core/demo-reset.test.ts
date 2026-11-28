/**
 * Етап 6 (WP0): скидання демо покриває КОЖНУ таблицю схеми (фінансові — у FINANCE_DEMO_RESET_TABLES, діти → батьки) і
 * повертає магазин 'default' до значень міграції; жоден рядок до скидання не вціліє, а стан фінансових таблиць після
 * скидання = свіже заповнення демо (WP2 законно засіває оцінки, шари, стани й історію змін — вони відтворюються точно);
 * скидання журналу складу тестами етапу 5 (DELETE inventory_movements без фільтра) не блокується рядками етапу 6
 * (inventory_valuations.movement_id — без FK, §17 «Без FK — свідомо»).
 */
import { count, eq, isNotNull } from "drizzle-orm";
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

  /**
   * Нормалізований знімок таблиці: без власного id (uuid чи лічильник), uuid у значеннях → <uuid>, часові мітки (Date і
   * ISO-рядки) → <ts>, без лічильників ідентичності (*seq — нові після повторного заповнення) і проміжних знімків стану
   * після події (*After: порядок переоцінки рядків однієї партії однієї дати — за id рядка, тобто випадковий; кінцевий
   * стан inventory_cost_state порівнюється повністю); мультимножина рядків.
   */
  const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
  const TS_G = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
  const normalize = (v: unknown): unknown => {
    if (v instanceof Date) return "<ts>";
    if (typeof v === "string") return v.replace(TS_G, "<ts>").replace(UUID_G, "<uuid>");
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) if (k !== "id" && !/seq$/i.test(k) && !/After$/.test(k)) out[k] = normalize((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  async function financeState(): Promise<Record<string, string[]>> {
    const db = env.handle.db;
    const out: Record<string, string[]> = {};
    for (const t of [...FINANCE_DEMO_RESET_TABLES, schema.stores, schema.financeState]) {
      const rows = await db.select().from(t as PgTable);
      out[nameOf(t as PgTable)] = rows.map((r) => JSON.stringify(normalize(r))).sort();
    }
    return out;
  }

  it("resetDemoData empties every finance table of pre-reset rows; the result equals a fresh seed; the default store is restored", async () => {
    const db = env.handle.db;
    // Стан одразу після першого заповнення демо (= свіже заповнення): у тому числі рядки, які демо засіває законно
    // (оцінка собівартості WP2 — оцінки, шари, стани; історія змін фінансів).
    const fresh = await financeState();
    const orderId = await env.orderId("#1001");
    await db.update(schema.stores).set({ shopCurrency: "EUR", name: "demo" }).where(eq(schema.stores.id, "default"));
    await db.update(schema.financeState).set({ backfilledAt: new Date() }).where(eq(schema.financeState.storeId, "default"));
    await db.transaction((tx) => postEntries(tx, SYSTEM_ACTOR, [makeEntryInput({ idempotencyKey: "reset:1", orderId })]));
    await db.insert(schema.fxRates).values({ source: "demo", currency: "EUR", effectiveDate: "2026-11-01", rate: "48.5", units: 1, ratePerUnit: "48.5" });
    await db.insert(schema.financeDiscrepancies).values({ type: "order_unreadable", dedupeKey: "reset:d", orderId });
    await db.insert(schema.orderFinance).values({ orderId });
    await db.insert(schema.orderFinanceForecasts).values({ orderId, component: "fees", currency: "EUR", amount: "1.00", basis: "fee_rule" });
    await db.insert(schema.partners).values({ displayName: "Demo partner", createdBy: "test" });
    await db.insert(schema.financeChangeLog).values({ entityType: "fx_rate", entityId: "EUR:2026-11-01", action: "create", actorId: "reset-sentinel", actorRole: "owner" });
    const [mv] = await db.select().from(schema.inventoryMovements).limit(1);
    await db.insert(schema.inventoryValuations).values({
      eventKey: "reset:sentinel-valuation",
      warehouseId: mv!.warehouseId,
      stockItemId: mv!.stockItemId,
      currency: "UAH",
      kind: "inflow",
      qty: 1,
      valueSource: "none",
      occurredOn: "2026-11-01",
    });
    const before = await financeState();
    expect(before).not.toEqual(fresh);

    await resetDemoData(env.ctx(SYSTEM_ACTOR));

    // Жоден рядок, створений до скидання, не вцілів (контрольні ключі й актори).
    expect(await db.select().from(schema.financeEntries).where(eq(schema.financeEntries.idempotencyKey, "reset:1"))).toEqual([]);
    expect(await db.select().from(schema.fxRates).where(eq(schema.fxRates.rate, "48.5"))).toEqual([]);
    expect(await db.select().from(schema.financeDiscrepancies).where(eq(schema.financeDiscrepancies.dedupeKey, "reset:d"))).toEqual([]);
    expect(await db.select().from(schema.partners).where(eq(schema.partners.displayName, "Demo partner"))).toEqual([]);
    expect(await db.select().from(schema.financeChangeLog).where(eq(schema.financeChangeLog.actorId, "reset-sentinel"))).toEqual([]);
    expect(await db.select().from(schema.inventoryValuations).where(eq(schema.inventoryValuations.eventKey, "reset:sentinel-valuation"))).toEqual([]);
    // Посилання на замовлення / рухи до скидання не лишилися (нові id після повторного заповнення).
    const [{ c: stale } = { c: 0 }] = await db
      .select({ c: count() })
      .from(schema.orderFinance)
      .where(eq(schema.orderFinance.orderId, orderId));
    expect(Number(stale)).toBe(0);
    const [{ c: staleMv } = { c: 0 }] = await db
      .select({ c: count() })
      .from(schema.inventoryValuations)
      .where(eq(schema.inventoryValuations.movementId, mv!.id));
    expect(Number(staleMv)).toBe(0);
    // Повний стан фінансових таблиць = свіже заповнення (порожні таблиці лишаються порожніми, засіяні — відтворено точно).
    expect(await financeState()).toEqual(fresh);
    const store = await getDefaultStore(db);
    expect(store).toMatchObject({ id: "default", isDefault: true, shopCurrency: null, legalEntityId: null });
    const [state] = await db.select().from(schema.financeState);
    expect(state).toMatchObject({ storeId: "default", backfilledAt: null });
    // Повторне заповнення демо працює (замовлення знову є).
    expect(await env.orderId("#1001")).toBeTruthy();
  });

  it("an unfiltered DELETE of inventory_movements (stage-5 test resetLedger) is not blocked by stage-6 rows", async () => {
    const db = env.handle.db;
    // Жодна таблиця етапу 6 не має FK на inventory_movements (оцінки — movement_id без FK, §17 «Без FK — свідомо»).
    const { getTableConfig } = await import("drizzle-orm/pg-core");
    for (const t of allTables) {
      for (const fk of getTableConfig(t).foreignKeys) {
        const target = getTableConfig(fk.reference().foreignTable).name;
        if (STAGE6_TABLES.includes(nameOf(t))) expect(target, `${nameOf(t)} → ${target}`).not.toBe("inventory_movements");
      }
    }
    // Справжній стан демо після оцінки WP2: оцінки рухів, шари, стани собівартості — і їх видалення не потрібне.
    const [valued] = await db.select({ c: count() }).from(schema.inventoryValuations).where(isNotNull(schema.inventoryValuations.movementId));
    expect(Number(valued!.c), "demo seed valued its movements").toBeGreaterThan(0);
    // Як tests/stage5/opening.test.ts resetLedger і shippable-partial-opening.test.ts: без фільтра й без оцінок.
    await db.delete(schema.inventoryMovements);
    const [left] = await db.select({ c: count() }).from(schema.inventoryMovements);
    expect(Number(left!.c)).toBe(0);
    // У застосунку рухи видаляє лише resetDemoData — після фінансових таблиць (FINANCE_DEMO_RESET_TABLES першими).
    const offenders: string[] = [];
    const fs = await import("node:fs");
    const path = await import("node:path");
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(e.name) ? [p] : [];
      });
    for (const f of walk(path.resolve("app"))) {
      const src = fs.readFileSync(f, "utf8");
      if (/delete\(\s*inventoryMovements\s*\)|delete\s+from\s+inventory_movements/i.test(src)) offenders.push(path.relative(path.resolve("."), f));
    }
    expect(offenders).toEqual([]);
  });
});

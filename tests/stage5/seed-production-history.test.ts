/**
 * Демо: вигадана історія виробництва (90 днів) і витрати матеріалів (30 днів) — db/seed/demo-history.server.ts.
 * У новому демо статистика виробництва (період 90 днів) і «Витрачено за 30 днів» / «Вистачить на» матеріалів не
 * порожні; журнал узгоджений (баланс = сума рухів), кінцеві залишки, резерви й попередження — ті самі, що без історії;
 * нічого не потрапляє в чергу пакування, резерви чи передачу в Shopify; повторне заповнення нічого не додає; скидання
 * відновлює історію; стара демо-база (склад уже заповнено, історії немає) отримує її один раз.
 */
import { and, count, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  auditLog,
  inventoryBalances,
  inventoryConflicts,
  inventoryMovements,
  jobs,
  packagingMaterials,
  productionBatchLines,
  productionBatches,
  productionReceiptLines,
  productionReceipts,
  stockAlerts,
  stockItems,
  stockReservations,
} from "~/db/schema";
import { DEMO_ORDERS, DEMO_PRODUCTS } from "~/db/seed/demo-data";
import { DEMO_HISTORY_NOTE, DEMO_MATERIAL_HISTORY, DEMO_PRODUCTION_HISTORY, demoUuid, seedDemoWarehouseHistory } from "~/db/seed/demo-history.server";
import { DEMO_MATERIALS } from "~/db/seed/demo-warehouse.server";
import { resetDemoData, seedDemoData } from "~/db/seed/seed.server";
import { SYSTEM_ACTOR, type Actor } from "~/domain/permissions";
import { makeT } from "~/i18n";
import { inventoryKeys } from "~/modules/inventory/keys";
import { getBalances } from "~/modules/inventory/ledger.server";
import { getDefaultWarehouse } from "~/modules/inventory/warehouse.server";
import { listMaterials, materialDaysLeft } from "~/modules/packaging/materials.server";
import { createBatch } from "~/modules/production/batches.server";
import { parseBatchNumber } from "~/modules/production/calc";
import { loadProductionStats } from "~/modules/production/stats.server";
import { businessDate } from "~/modules/warehouse/dates";
import { adjustToCount, newOperationId, setLowStockThreshold } from "~/modules/warehouse/operations.server";
import { exportProductionCsv } from "~/modules/warehouse-analytics/export.server";
import { loadWarehouseAnalytics } from "~/modules/warehouse-analytics/queries.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { esc, renderPage } from "../pages/insights-render";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null, skipHistory: false }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));
// Стара демо-база: склад заповнено кодом без історії (seedDemoData без seedDemoWarehouseHistory).
vi.mock("~/db/seed/demo-history.server", async (importOriginal) => {
  const orig = await importOriginal<typeof import("~/db/seed/demo-history.server")>();
  return {
    ...orig,
    seedDemoWarehouseHistory: (ctx: Parameters<typeof orig.seedDemoWarehouseHistory>[0]) =>
      m.skipHistory ? Promise.resolve({ batches: 0, receipts: 0, materialMovements: 0 }) : orig.seedDemoWarehouseHistory(ctx),
  };
});

let env: TestEnv;
let productionPage: typeof import("~/pages/production");
const SKU_OF = new Map(DEMO_PRODUCTS.flatMap((p) => p.variants.map((v) => [v.key, v.sku] as const)));
const AVAILABLE_OF = new Map(DEMO_PRODUCTS.flatMap((p) => p.variants.map((v) => [v.sku, v.inventoryAvailable] as const)));
const HISTORY_SKUS = new Set(DEMO_PRODUCTION_HISTORY.flatMap((b) => b.lines.map((l) => l.sku)));
const today = () => businessDate(new Date());
const DAY = 86_400_000;

beforeAll(async () => {
  env = await createTestEnv();
  productionPage = await import("~/pages/production");
});
afterAll(async () => {
  await env.close();
});
function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale };
}
beforeEach(() => setContext());

type Db = TestEnv["handle"]["db"];
const rowsOf = <T,>(r: unknown): T[] => ((r as { rows?: T[] }).rows ?? (r as T[]));

/** Позиції, баланс яких не дорівнює сумі рухів (за кожним кошиком), і позиції з від'ємним кошиком. */
async function ledgerProblems(db: Db): Promise<unknown[]> {
  const res = await db.execute(sql`
    select b.stock_item_id, b.on_hand, b.reserved, b.defective, b.in_production,
           coalesce(sum(m.on_hand_delta), 0)::int as oh, coalesce(sum(m.reserved_delta), 0)::int as r,
           coalesce(sum(m.defective_delta), 0)::int as d, coalesce(sum(m.in_production_delta), 0)::int as ip
    from ${inventoryBalances} b
    left join ${inventoryMovements} m on m.stock_item_id = b.stock_item_id and m.warehouse_id = b.warehouse_id
    group by b.stock_item_id, b.on_hand, b.reserved, b.defective, b.in_production
    having b.on_hand <> coalesce(sum(m.on_hand_delta), 0) or b.reserved <> coalesce(sum(m.reserved_delta), 0)
        or b.defective <> coalesce(sum(m.defective_delta), 0) or b.in_production <> coalesce(sum(m.in_production_delta), 0)
        or b.on_hand < 0 or b.reserved < 0 or b.defective < 0 or b.in_production < 0`);
  return rowsOf(res);
}

async function countOf(db: Db, table: typeof productionBatches | typeof productionReceipts | typeof inventoryMovements | typeof stockAlerts | typeof jobs) {
  const [row] = await db.select({ c: count() }).from(table);
  return Number(row?.c ?? 0);
}

/** Усі баланси (товари й матеріали) за SKU/кодом: [on_hand, reserved, defective, in_production]. */
async function allBalances(db: Db): Promise<Record<string, [number, number, number, number]>> {
  const rows = [...(await getBalances(db, { kind: "product" }, { limit: 500 })).rows, ...(await getBalances(db, { kind: "material" }, { limit: 500 })).rows];
  return Object.fromEntries(rows.map((r) => [r.sku ?? r.stockItemId, [r.onHand, r.reserved, r.defective, r.inProduction]]));
}

/** Очікувані кінцеві залишки демо без історії: товари — знімок + відкриті замовлення, матеріали — DEMO_MATERIALS.stock. */
function expectedBalances(): Record<string, [number, number, number, number]> {
  const reserved = new Map<string, number>();
  for (const o of DEMO_ORDERS) {
    if (o.history === "delivered" || o.history === "cancelled") continue;
    for (const i of o.items) reserved.set(SKU_OF.get(i.variant)!, (reserved.get(SKU_OF.get(i.variant)!) ?? 0) + i.quantity);
  }
  const inProduction: Record<string, number> = { "OT-PH-WHT": 50, "OT-FK-S": 30 };
  return {
    ...Object.fromEntries([...AVAILABLE_OF].map(([sku, s]) => [sku, [s + (reserved.get(sku) ?? 0), reserved.get(sku) ?? 0, 0, inProduction[sku] ?? 0]])),
    ...Object.fromEntries(DEMO_MATERIALS.map((x) => [x.code, [x.stock, 0, 0, 0]])),
  };
}

/** Відкриті попередження за SKU/кодом і загальна кількість рядків попереджень (з закритими). */
async function alertState(db: Db) {
  const open = await db
    .select({ kind: stockAlerts.kind, stockItemId: stockAlerts.stockItemId })
    .from(stockAlerts)
    .where(eq(stockAlerts.status, "open"));
  return { open: open.map((a) => `${a.stockItemId}:${a.kind}`).sort(), total: await countOf(db, stockAlerts) };
}

const historyBatches = (db: Db) => db.select().from(productionBatches).where(eq(productionBatches.notes, DEMO_HISTORY_NOTE)).orderBy(productionBatches.createdAt);

function consumedByCode(): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of DEMO_MATERIAL_HISTORY) for (const [code, q] of Object.entries(d.use)) out.set(code, (out.get(code) ?? 0) + q);
  return out;
}

/** «Витрачено за 30 днів» кожного демо-матеріалу дорівнює плану історії (не частково). */
async function expectConsumptionAsPlanned(db: Db) {
  const used = consumedByCode();
  const { rows } = await listMaterials(db, {}, { now: new Date() });
  expect(Object.fromEntries(DEMO_MATERIALS.map((x) => [x.code, rows.find((r) => r.code === x.code)?.consumedRecent]))).toEqual(
    Object.fromEntries(DEMO_MATERIALS.map((x) => [x.code, used.get(x.code)])),
  );
}

/** Усі рядки попереджень (з закритими): той самий id, стан і «з якого часу». */
async function alertRows(db: Db) {
  return (await db.select().from(stockAlerts).orderBy(stockAlerts.id)).map((a) => ({
    id: a.id,
    stockItemId: a.stockItemId,
    kind: a.kind,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    resolvedAt: a.resolvedAt?.toISOString() ?? null,
    details: a.details,
  }));
}

describe("demo production history: production statistics on a fresh demo", () => {
  it("90 days (default): receipts, good/defective, defect rate, on-time and late batches, defects by model and colour", async () => {
    const s = await loadProductionStats(env.handle.db, { today: today(), period: "90", includeCosts: true });
    expect(s.totals).toEqual({ good: 114, defective: 4, produced: 118, defectRate: 3.4, receipts: 3, batches: 2 });
    expect(s.timeliness).toEqual({ completed: 2, onTime: 1, late: 1, withoutDate: 0, onTimeRate: 50 });
    // «Без моделі» — останнім (groupDefects), решта — більше виготовлено вище.
    expect(s.byModel).toEqual([
      { value: "Model X", good: 14, defective: 1, produced: 15, defectRate: 6.7 },
      { value: "10x2.5", good: 8, defective: 0, produced: 8, defectRate: 0 },
      { value: null, good: 92, defective: 3, produced: 95, defectRate: 3.2 },
    ]);
    expect(s.byColor).toEqual([
      { value: "Чорний", good: 69, defective: 1, produced: 70, defectRate: 1.4 },
      { value: "Сірий", good: 23, defective: 2, produced: 25, defectRate: 8 },
      { value: null, good: 22, defective: 1, produced: 23, defectRate: 4.3 },
    ]);
    expect(s.overdueOpen).toBe(0);
    // Собівартість отриманого: Σ unit_cost рухів надходження × (якісні + брак), UAH.
    expect(s.costs).toEqual({ totals: [{ currency: "UAH", amount: "20694.92", goodUnits: 114, perGoodUnit: "181.53" }], unitsWithoutCost: 0 });
  });

  it("30 days: only the late batch received 19 days ago; a year: the same as 90 days", async () => {
    const s30 = await loadProductionStats(env.handle.db, { today: today(), period: "30" });
    expect(s30.totals).toMatchObject({ good: 22, defective: 1, receipts: 1, batches: 1 });
    expect(s30.timeliness).toMatchObject({ completed: 1, onTime: 0, late: 1 });
    expect(s30.costs).toBeNull();
    const s365 = await loadProductionStats(env.handle.db, { today: today(), period: "365" });
    expect(s365.totals).toMatchObject({ good: 114, defective: 4, receipts: 3, batches: 2 });
  });

  it("page: the owner sees the cost of units received, staff does not (finance.view)", async () => {
    const owner = (await productionPage.loader({ request: new Request("http://localhost/demo/production"), params: {}, context: {} } as never)) as {
      stats: Awaited<ReturnType<typeof loadProductionStats>>;
      canSeeCosts: boolean;
      rows: Array<Record<string, unknown>>;
    };
    expect(owner.stats.totals.good).toBe(114);
    expect(owner.stats.costs?.totals[0]?.amount).toBe("20694.92");
    setContext(STAFF);
    const staff = (await productionPage.loader({ request: new Request("http://localhost/demo/production?tab=all"), params: {}, context: {} } as never)) as typeof owner;
    expect(staff.canSeeCosts).toBe(false);
    expect(staff.stats.totals).toEqual(owner.stats.totals);
    expect(staff.stats.costs).toBeNull();
    const json = JSON.stringify(staff);
    for (const money of ["20694.92", "181.53", "1200.00", "600.00", "95.00", "210.00", "300.00", "240.00"]) expect(json, money).not.toContain(money);
    // Перелік «Усі»: демо-партія у виробництві й дві партії історії — без собівартості.
    expect(staff.rows.map((r) => r.status).sort()).toEqual(["closed", "in_production", "received"]);
  });

  it("batches: fictional, finished, numbered after PB-<year>-0001, backdated and consistent with receipts and movements", async () => {
    const db = env.handle.db;
    const batches = await historyBatches(db);
    expect(batches.map((b) => [b.title, b.status, b.manufacturer, b.costCurrency, b.extraCost])).toEqual([
      ["Грипси й тримачі чорні", "closed", "Демо-виробник", "UAH", "1200.00"],
      ["Крила Model X і покришки", "received", "Демо-виробник", "UAH", "600.00"],
    ]);
    const now = Date.now();
    const [seeded] = await db.select().from(productionBatches).where(eq(productionBatches.status, "in_production"));
    const seededSeq = parseBatchNumber(seeded!.number)!;
    for (const [i, b] of batches.entries()) {
      const plan = DEMO_PRODUCTION_HISTORY[i]!;
      const parsed = parseBatchNumber(b.number)!;
      expect(parsed.year, b.number).toBe(Number(businessDate(b.createdAt).slice(0, 4)));
      if (parsed.year === seededSeq.year) expect(parsed.seq, b.number).toBeGreaterThan(seededSeq.seq);
      expect(Math.round((now - b.createdAt.getTime()) / 86_400_000), b.number).toBe(plan.createdDaysAgo);
      expect(b.plannedReadyDate).toBe(businessDate(new Date(now - plan.readyDaysAgo * 86_400_000)));
      const lines = await db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, b.id));
      const receiptLines = await db
        .select({ batchLineId: productionReceiptLines.batchLineId, good: productionReceiptLines.goodQty, defective: productionReceiptLines.defectiveQty, receivedAt: productionReceipts.receivedAt, id: productionReceiptLines.id })
        .from(productionReceiptLines)
        .innerJoin(productionReceipts, eq(productionReceipts.id, productionReceiptLines.receiptId))
        .where(eq(productionReceipts.batchId, b.id));
      for (const l of lines) {
        const mine = receiptLines.filter((r) => r.batchLineId === l.id);
        expect(l.quantityReceived).toBe(mine.reduce((s, r) => s + r.good, 0));
        expect(l.quantityDefective).toBe(mine.reduce((s, r) => s + r.defective, 0));
        expect(l.quantityReceived + l.quantityDefective).toBe(l.quantityOrdered);
        expect(l.unitCost).not.toBeNull();
      }
      for (const r of receiptLines) {
        // Рух надходження — той самий момент, що й надходження; уже в знімку Shopify (стан "none").
        const [mv] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, inventoryKeys.productionReceipt(r.id)));
        expect(mv).toMatchObject({ type: "receipt_production", onHandDelta: r.good, defectiveDelta: r.defective, shopifySyncState: "none", productionBatchId: b.id });
        expect(mv!.createdAt.getTime()).toBe(r.receivedAt.getTime());
        expect(now - r.receivedAt.getTime()).toBeLessThan(90 * 86_400_000);
        // Брак повернуто виробнику через writeOffAfterDays днів після надходження (рух списання — у той день, не сьогодні).
        const [writeOff] = await db
          .select()
          .from(inventoryMovements)
          .where(eq(inventoryMovements.idempotencyKey, inventoryKeys.manual(demoUuid(`defect-writeoff:${r.id}`))));
        if (r.defective === 0) {
          expect(writeOff, r.id).toBeUndefined();
          continue;
        }
        expect(writeOff).toMatchObject({ type: "defect_writeoff", onHandDelta: 0, defectiveDelta: -r.defective, reason: "returned_to_manufacturer", note: "DEMO", orderId: null });
        expect(writeOff!.createdAt.getTime()).toBe(r.receivedAt.getTime() + plan.writeOffAfterDays * DAY);
      }
      const starts = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.productionBatchId, b.id), eq(inventoryMovements.type, "production_start")));
      expect(starts.length).toBe(lines.length);
      for (const s of starts) expect(Math.round((now - s.createdAt.getTime()) / 86_400_000)).toBe(plan.startedDaysAgo);
    }
  });

  it("production CSV and the audit journal carry the history's own dates: closed on the close day, not on the seed day", async () => {
    const db = env.handle.db;
    const now = Date.now();
    const csv = await exportProductionCsv(env.ctx(OWNER), { separator: "semicolon" });
    const [header, ...lines] = csv.content.slice(1).trimEnd().split("\r\n");
    const cols = header!.split(";");
    const rows = lines.map((l) => Object.fromEntries(l.split(";").map((v, i) => [cols[i]!, v])));
    for (const [i, b] of (await historyBatches(db)).entries()) {
      const plan = DEMO_PRODUCTION_HISTORY[i]!;
      const starts = await db.select().from(inventoryMovements).where(and(eq(inventoryMovements.productionBatchId, b.id), eq(inventoryMovements.type, "production_start")));
      const receipts = await db.select().from(productionReceipts).where(eq(productionReceipts.batchId, b.id));
      const lastReceived = businessDate(new Date(Math.max(...receipts.map((r) => r.receivedAt.getTime()))));
      const mine = rows.filter((r) => r.batch_number === b.number);
      expect(mine.length, b.number).toBe(plan.lines.length);
      for (const r of mine) {
        expect(r, b.number).toMatchObject({
          status: b.status,
          created_date: businessDate(b.createdAt),
          planned_ready_date: b.plannedReadyDate,
          started_date: businessDate(starts[0]!.createdAt),
          last_received_date: lastReceived,
          // Закрито — день закриття партії (updated_at closeBatch), не день заповнення демо.
          closed_date: plan.closeDaysAgo === null ? "" : businessDate(b.updatedAt),
        });
      }
      if (plan.closeDaysAgo !== null) {
        expect(Math.round((now - b.updatedAt.getTime()) / DAY)).toBe(plan.closeDaysAgo);
        expect(mine[0]!.closed_date! >= lastReceived).toBe(true);
        expect(mine[0]!.closed_date).not.toBe(today());
      }
      // Записи журналу дій партії — у момент своєї події.
      const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "production_batch"), eq(auditLog.entityId, b.id)));
      const times = (action: string) => audit.filter((a) => a.action === action).map((a) => a.createdAt.getTime()).sort();
      expect(times("production.batch_created")).toEqual([b.createdAt.getTime()]);
      expect(times("production.batch_started")).toEqual([starts[0]!.createdAt.getTime()]);
      expect(times("production.received")).toEqual(receipts.map((r) => r.receivedAt.getTime()).sort());
      expect(times("production.batch_closed")).toEqual(plan.closeDaysAgo === null ? [] : [b.updatedAt.getTime()]);
      for (const a of audit) expect(now - a.createdAt.getTime(), a.action).toBeGreaterThan(DAY);
    }
    // Списання браку — у журналі дій у день списання (той самий момент, що й рух).
    const writeOffs = await db.select().from(auditLog).where(eq(auditLog.action, "inventory.defect_written_off"));
    expect(writeOffs).toHaveLength(3);
    for (const a of writeOffs) {
      const [mv] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.id, String(a.details.movementId)));
      expect(mv!.note).toBe("DEMO");
      expect(a.createdAt.getTime()).toBe(mv!.createdAt.getTime());
    }
    // Запис про саму історію — у момент заповнення (справжній час запису).
    const [seeded] = await db.select().from(auditLog).where(eq(auditLog.action, "demo.production_history_seeded"));
    expect(now - seeded!.createdAt.getTime()).toBeLessThan(DAY);
  });

  it("renders the statistics block of the fresh demo (uk + en): figures, timeliness and the cost line only for the owner", async () => {
    const route = { path: "production", loader: productionPage.loader, action: productionPage.action, Component: productionPage.default };
    const expected = {
      uk: { defective: "4 (3,4%)", cost: "20 694,92 грн", perUnit: "181,53 грн", rate: "6,7%" },
      en: { defective: "4 (3.4%)", cost: "UAH 20,694.92", perUnit: "UAH 181.53", rate: "6.7%" },
    };
    for (const locale of ["uk", "en"] as const) {
      const t = makeT(locale);
      const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/[\u00a0\u202f]/g, " ");
      setContext(OWNER, locale);
      const owner = text(await renderPage(route as never, "/demo/production", OWNER, locale));
      expect(owner).not.toContain(esc(t("production.stats.empty")));
      expect(owner).toContain(esc(t("production.stats.onTimeValue", { onTime: "1", total: "2" })));
      expect(owner).toContain(esc(t("production.stats.late", { count: "1" })));
      expect(owner).toContain(esc(t("production.stats.receipts", { count: "3", batches: "2" })));
      expect(owner).toContain(expected[locale].defective);
      expect(owner).toContain(expected[locale].rate);
      expect(owner).toContain(esc(t("production.stats.cost")));
      expect(owner).toContain(expected[locale].cost);
      expect(owner).toContain(expected[locale].perUnit);
      expect(owner).toContain("Model X");
      expect(owner).toContain("10x2.5");
      setContext(STAFF, locale);
      const staff = text(await renderPage(route as never, "/demo/production", STAFF, locale));
      expect(staff).toContain(esc(t("production.stats.onTimeValue", { onTime: "1", total: "2" })));
      expect(staff).toContain(expected[locale].defective);
      expect(staff).not.toContain(esc(t("production.stats.cost")));
      expect(staff).not.toContain(expected[locale].cost);
      expect(staff).not.toContain(expected[locale].perUnit);
    }
    setContext(OWNER);
  });

  it("analytics: the owner's inventory value counts the history's landed unit costs; staff gets no cost (finance.view)", async () => {
    const owner = await loadWarehouseAnalytics(env.ctx(OWNER));
    // Собівартість одиниці — з останнього надходження історії: ціна позиції + додаткові витрати партії на одиницю
    // (1200.00 / 95 = 12.63; 600.00 / 23 = 26.09). Решта демо-товарів — без собівартості.
    const costs = Object.fromEntries(owner.variants.filter((v) => v.cost).map((v) => [v.sku, v.cost]));
    expect(costs).toEqual({
      "OT-GR-BLK": { unitCost: "107.63", currency: "UAH" },
      "OT-GR-GRY": { unitCost: "107.63", currency: "UAH" },
      "OT-PH-BLK": { unitCost: "222.63", currency: "UAH" },
      "OT-FK-X": { unitCost: "326.09", currency: "UAH" },
      "OT-TR-1025": { unitCost: "266.09", currency: "UAH" },
    });
    const expected = expectedBalances();
    const unitsValued = [...HISTORY_SKUS].reduce((s, sku) => s + expected[sku]![0], 0);
    expect(owner.inventoryValue).toEqual({
      totals: [{ currency: "UAH", amount: "28931.21" }],
      itemsValued: HISTORY_SKUS.size,
      unitsValued,
      itemsWithoutCost: 4,
      unitsWithoutCost: 61,
    });
    expect(unitsValued).toBe(165);
    expect(owner.recommendations.find((v) => v.sku === "OT-FK-X")?.cost).toEqual({ unitCost: "326.09", currency: "UAH" });
    const staff = await loadWarehouseAnalytics(env.ctx(STAFF));
    expect(staff.inventoryValue).toBeNull();
    expect(staff.variants.every((v) => v.cost === null)).toBe(true);
    expect(JSON.stringify(staff)).not.toMatch(/107\.63|222\.63|326\.09|266\.09|28931/);
    // Сторінка аналітики: KPI «Вартість запасу» власника (той самий текст перевіряє E2E), у працівника KPI немає.
    const analyticsPage = await import("~/pages/warehouse-analytics");
    const route = { path: "warehouse/analytics", loader: analyticsPage.loader, Component: analyticsPage.default };
    const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    const ownerHtml = text(await renderPage(route as never, "/demo/warehouse/analytics", OWNER));
    expect(ownerHtml).toContain("Вартість запасу");
    expect(ownerHtml).toContain("28 931,21 грн");
    expect(ownerHtml).toContain("Без собівартості: 4 позиції (61 шт.)");
    setContext(STAFF);
    const staffHtml = text(await renderPage(route as never, "/demo/warehouse/analytics", STAFF));
    expect(staffHtml).not.toContain("Вартість запасу");
    expect(staffHtml).not.toContain("28 931,21");
    setContext(OWNER);
  });
});

describe("demo production history: materials used in the last 30 days", () => {
  it("every demo material has usage and a days-of-stock forecast; balances and low-stock alerts are as before", async () => {
    const used = consumedByCode();
    const { rows } = await listMaterials(env.handle.db, {}, { now: new Date() });
    for (const mat of DEMO_MATERIALS) {
      const row = rows.find((r) => r.code === mat.code)!;
      expect(row.onHand, mat.code).toBe(mat.stock);
      expect(row.consumedRecent, mat.code).toBe(used.get(mat.code));
      expect(row.consumedRecent, mat.code).toBeGreaterThan(0);
      expect(row.daysLeft, mat.code).toBe(materialDaysLeft(mat.stock, used.get(mat.code)!));
    }
    expect(Object.fromEntries(rows.map((r) => [r.code, r.daysLeft]))).toMatchObject({ bolts_m5: 15, box_l: 40, box_m: 187, tape: 136 });
    expect(rows.filter((r) => r.status !== "ok").map((r) => [r.code, r.status]).sort()).toEqual([
      ["bolts_m5", "low"],
      ["box_l", "low"],
    ]);
    // Попередження «мало» — ті самі й без «закрито й знову відкрито» (по одному рядку на матеріал).
    const lows = await env.handle.db
      .select({ code: packagingMaterials.code, status: stockAlerts.status })
      .from(stockAlerts)
      .innerJoin(stockItems, eq(stockItems.id, stockAlerts.stockItemId))
      .innerJoin(packagingMaterials, eq(packagingMaterials.id, stockItems.materialId));
    expect(lows.map((a) => [a.code, a.status]).sort()).toEqual([
      ["bolts_m5", "open"],
      ["box_l", "open"],
    ]);
  });

  it("consumption is dated across the last 30 days after the (backdated) material opening, never linked to orders or packings", async () => {
    const db = env.handle.db;
    const now = Date.now();
    const movements = await db.select().from(inventoryMovements).where(like(inventoryMovements.idempotencyKey, "demo_history:%"));
    expect(movements.length).toBe(DEMO_MATERIAL_HISTORY.reduce((s, d) => s + Object.keys(d.use).length, 0));
    const days = new Set<number>();
    for (const mv of movements) {
      expect(mv).toMatchObject({ type: "material_consume", reason: "demo_history", note: "DEMO", orderId: null, packingId: null, shopifySyncState: "none" });
      const d = Math.round((now - mv.createdAt.getTime()) / 86_400_000);
      expect(d).toBeGreaterThan(0);
      expect(d).toBeLessThan(30);
      days.add(d);
      const [opening] = await db
        .select()
        .from(inventoryMovements)
        .where(and(eq(inventoryMovements.stockItemId, mv.stockItemId), eq(inventoryMovements.type, "opening")));
      expect(opening!.createdAt.getTime()).toBeLessThan(mv.createdAt.getTime());
    }
    expect(days.size).toBe(DEMO_MATERIAL_HISTORY.length);
  });
});

describe("demo production history: ledger and final balances", () => {
  it("balances equal the sum of movements, nothing negative, keys unique", async () => {
    const db = env.handle.db;
    // Журнал містить історію (надходження, списання браку, витрату матеріалів) — і все одно узгоджений.
    const [history] = await db
      .select({ c: count() })
      .from(inventoryMovements)
      .where(sql`${inventoryMovements.type} in ('receipt_production', 'defect_writeoff') or ${inventoryMovements.idempotencyKey} like 'demo_history:%'`);
    expect(Number(history!.c)).toBe(6 + 3 + 44);
    expect(await ledgerProblems(db)).toEqual([]);
    const [keys] = rowsOf<{ total: number; distinct: number }>(
      await db.execute(sql`select count(*)::int as total, count(distinct idempotency_key)::int as distinct from ${inventoryMovements}`),
    );
    expect(keys!.distinct).toBe(keys!.total);
  });

  it("final balances, reservations and in-production equal the demo values without history; no conflicts", async () => {
    const db = env.handle.db;
    const balances = await allBalances(db);
    const expected = expectedBalances();
    for (const [code, value] of Object.entries(expected)) expect(balances[code], code).toEqual(value);
    // Opening товарів з історією = знімок + відкриті замовлення − отримане історією (знімок уже містить надходження).
    const warehouse = await getDefaultWarehouse(db);
    const goodBySku = new Map<string, number>();
    for (const b of DEMO_PRODUCTION_HISTORY) for (const r of b.receipts) for (const l of r.lines) goodBySku.set(l.sku, (goodBySku.get(l.sku) ?? 0) + l.good);
    const rows = (await getBalances(db, { kind: "product" }, { limit: 500 })).rows;
    for (const sku of HISTORY_SKUS) {
      const row = rows.find((r) => r.sku === sku)!;
      const [opening] = await db.select().from(inventoryMovements).where(eq(inventoryMovements.idempotencyKey, inventoryKeys.opening(warehouse.id, row.stockItemId!)));
      expect(opening!.onHandDelta, sku).toBe(expected[sku]![0] - goodBySku.get(sku)!);
      expect(opening!.onHandDelta, sku).toBeGreaterThanOrEqual(0);
    }
    expect(await db.select().from(inventoryConflicts)).toEqual([]);
  });

  it("nothing enters the packing queue, reservations or the Shopify push", async () => {
    const db = env.handle.db;
    const ids = (await historyBatches(db)).map((b) => b.id);
    const historyMovements = await db
      .select()
      .from(inventoryMovements)
      .where(sql`${inventoryMovements.productionBatchId} in ${ids} or ${inventoryMovements.idempotencyKey} like 'demo_history:%' or ${inventoryMovements.type} = 'defect_writeoff'`);
    expect(historyMovements.length).toBeGreaterThan(0);
    for (const mv of historyMovements) {
      expect(mv.orderId, mv.idempotencyKey).toBeNull();
      expect(mv.packingId, mv.idempotencyKey).toBeNull();
      expect(["none", "skipped"], mv.idempotencyKey).toContain(mv.shopifySyncState);
      expect(mv.reservedDelta).toBe(0);
    }
    expect(await db.select().from(inventoryMovements).where(eq(inventoryMovements.shopifySyncState, "pending"))).toEqual([]);
    expect(await countOf(db, jobs)).toBe(0);
    // Резерви — лише відкритих демо-замовлень.
    const [reservations] = await db.select({ c: count() }).from(stockReservations).where(isNotNull(stockReservations.orderId));
    expect(Number(reservations!.c)).toBe(DEMO_ORDERS.filter((o) => o.history !== "delivered" && o.history !== "cancelled").reduce((s, o) => s + o.items.length, 0));
  });
});

describe("demo production history: idempotent seed, reset", () => {
  it("seeding again adds nothing", async () => {
    const db = env.handle.db;
    const before = [await countOf(db, productionBatches), await countOf(db, productionReceipts), await countOf(db, inventoryMovements), await countOf(db, stockAlerts)];
    const balances = await allBalances(db);
    expect(await seedDemoWarehouseHistory(env.ctx(SYSTEM_ACTOR))).toEqual({ batches: 0, receipts: 0, materialMovements: 0 });
    await seedDemoData(env.ctx(SYSTEM_ACTOR));
    expect([await countOf(db, productionBatches), await countOf(db, productionReceipts), await countOf(db, inventoryMovements), await countOf(db, stockAlerts)]).toEqual(before);
    expect(await allBalances(db)).toEqual(balances);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "demo.production_history_seeded"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.details).toEqual({ batches: 2, receipts: 3, materialMovements: 44, goodUnits: 114, defectiveUnits: 4 });
  });

  it("reset restores the history with the same statistics and balances", async () => {
    await resetDemoData(env.ctx(OWNER));
    const db = env.handle.db;
    expect((await historyBatches(db)).map((b) => b.status)).toEqual(["closed", "received"]);
    const s = await loadProductionStats(db, { today: today(), period: "90" });
    expect(s.totals).toMatchObject({ good: 114, defective: 4, receipts: 3, batches: 2 });
    await expectConsumptionAsPlanned(db);
    const balances = await allBalances(db);
    for (const [code, value] of Object.entries(expectedBalances())) expect(balances[code], code).toEqual(value);
    expect(await ledgerProblems(db)).toEqual([]);
  });
});

describe("demo production history: an old demo database gets it once on start-up", () => {
  let old: TestEnv;
  beforeAll(async () => {
    m.skipHistory = true;
    try {
      old = await createTestEnv();
    } finally {
      m.skipHistory = false;
    }
  });
  afterAll(async () => {
    await old.close();
  });

  it("start-up adds the history once without changing final balances or alerts; batch numbers continue the sequence", async () => {
    const db = old.handle.db;
    // До оновлення — як стара демо-база: статистика порожня, витрат матеріалів немає.
    expect((await loadProductionStats(db, { today: today(), period: "90" })).totals.receipts).toBe(0);
    expect((await listMaterials(db, {}, { now: new Date() })).rows.every((r) => r.consumedRecent === 0)).toBe(true);
    // Власник уже створив партію в старому демо: її номер лишається, історія отримує наступні.
    const own = await createBatch(old.ctx(OWNER), { title: "Партія власника", lines: [{ variantId: (await getBalances(db, { kind: "product" }, { limit: 1 })).rows[0]!.variantId!, quantity: 5 }] });
    // Власник порахував товари історії: покришок лишилось 3 доступних («мало»), крил Model X — 0 («немає», свій поріг 20).
    // Надходження історії тимчасово піднімають залишок (до поглинання opening) — відкриті попередження мають лишитися
    // тими самими рядками (id, «з якого часу»), без закритих дублів.
    const product = async (sku: string) => (await getBalances(db, { kind: "product" }, { limit: 500 })).rows.find((r) => r.sku === sku)!;
    const tires = await product("OT-TR-1025");
    await adjustToCount(old.ctx(OWNER), { operationId: newOperationId(), stockItemId: tires.stockItemId!, countedOnHand: tires.reserved + 3 });
    const fenders = await product("OT-FK-X");
    await setLowStockThreshold(old.ctx(OWNER), { stockItemId: fenders.stockItemId!, threshold: 20 });
    await adjustToCount(old.ctx(OWNER), { operationId: newOperationId(), stockItemId: fenders.stockItemId!, countedOnHand: fenders.reserved });
    const rowsBefore = await alertRows(db);
    expect(rowsBefore.filter((a) => a.status === "open" && [tires.stockItemId, fenders.stockItemId].includes(a.stockItemId)).map((a) => a.kind).sort()).toEqual([
      "low_stock",
      "out_of_stock",
    ]);
    const balances = await allBalances(db);
    const alerts = await alertState(db);
    const reservations = await db.select({ c: count() }).from(stockReservations);

    await seedDemoData(old.ctx(SYSTEM_ACTOR));
    const batches = await historyBatches(db);
    expect(batches).toHaveLength(2);
    const ownSeq = parseBatchNumber(own.number)!;
    for (const b of batches) {
      const p = parseBatchNumber(b.number)!;
      if (p.year === ownSeq.year) expect(p.seq).toBeGreaterThan(ownSeq.seq);
    }
    const s = await loadProductionStats(db, { today: today(), period: "90" });
    expect(s.totals).toMatchObject({ good: 114, defective: 4, receipts: 3, batches: 2 });
    expect(s.timeliness).toMatchObject({ onTime: 1, late: 1 });
    await expectConsumptionAsPlanned(db);
    expect(await allBalances(db)).toEqual(balances);
    expect(await alertState(db)).toEqual(alerts);
    expect(await alertRows(db)).toEqual(rowsBefore);
    expect(await db.select({ c: count() }).from(stockReservations)).toEqual(reservations);
    expect(await ledgerProblems(db)).toEqual([]);
    expect(await countOf(db, jobs)).toBe(0);

    // Наступна партія власника — після номерів історії (послідовність узгоджена).
    const next = await createBatch(old.ctx(OWNER), { title: "Ще одна партія", lines: [{ variantId: (await getBalances(db, { kind: "product" }, { limit: 1 })).rows[0]!.variantId!, quantity: 3 }] });
    const all = (await db.select({ number: productionBatches.number }).from(productionBatches)).map((r) => r.number);
    expect(new Set(all).size).toBe(all.length);
    const nextSeq = parseBatchNumber(next.number)!;
    for (const b of batches) {
      const p = parseBatchNumber(b.number)!;
      if (p.year === nextSeq.year) expect(nextSeq.seq).toBeGreaterThan(p.seq);
    }

    // Повторний запуск — без змін.
    const counts = [await countOf(db, productionBatches), await countOf(db, inventoryMovements), await countOf(db, stockAlerts)];
    await seedDemoData(old.ctx(SYSTEM_ACTOR));
    expect([await countOf(db, productionBatches), await countOf(db, inventoryMovements), await countOf(db, stockAlerts)]).toEqual(counts);
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "demo.production_history_seeded"));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.details)).not.toMatch(/@|\+\d{6,}/);
  });

  it("history movements are only for the demo SKUs and materials", async () => {
    const db = old.handle.db;
    const ids = (await historyBatches(db)).map((b) => b.id);
    const items = await db
      .selectDistinct({ stockItemId: inventoryMovements.stockItemId })
      .from(inventoryMovements)
      .where(inArray(inventoryMovements.productionBatchId, ids));
    const skus = (await getBalances(db, { kind: "product" }, { limit: 500 })).rows.filter((r) => items.some((i) => i.stockItemId === r.stockItemId)).map((r) => r.sku);
    expect(new Set(skus)).toEqual(HISTORY_SKUS);
  });
});

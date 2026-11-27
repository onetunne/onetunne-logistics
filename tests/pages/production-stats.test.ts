import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { productionBatchLines, productionBatches } from "~/db/schema";
import { makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES, makeT } from "~/i18n";
import { createBatch, receiveProduction, startProduction, type BatchInput } from "~/modules/production/batches.server";
import { countProductionDue } from "~/modules/production/queries.server";
import {
  addIsoDays,
  batchCompletionTime,
  groupDefects,
  isStatsPeriod,
  statsPeriod,
  summarizeTimeliness,
  timelinessOf,
} from "~/modules/production/stats";
import { loadProductionStats } from "~/modules/production/stats.server";
import { businessDate, businessDayStart } from "~/modules/warehouse/dates";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { insertProduct } from "../stage5/helpers";
import { esc, renderPage } from "./insights-render";

/**
 * S5-PROD-STATS (R6): статистика виробництва за період на сторінці «Виробництво» — отримано якісних і браку, частка
 * браку за моделями й кольорами, частка партій, отриманих вчасно (за плановою датою), прострочені зараз; собівартість —
 * лише finance.view. Вигаданий товар «Stats Test»: PS-BX (Black/X), PS-WX (White/X), PS-BY (Black/Y). Сьогодні = T:
 *   B1 план T−10: BX 10 × 10.00, WX 10 × 20.00 UAH; надходження T−12: BX 9 + 1 брак, WX 10 → отримано вчасно;
 *   B2 план T−20: BY 20 × 5.00 UAH; T−35: 5; T−15: 13 + 2 брак → отримано із запізненням;
 *   B3 без дати: BX 4 без ціни; T−3: 4 → без планової дати;
 *   B4 план T−5: WX 6, запущено, нічого не отримано → прострочено зараз;
 *   B5 план T+30: BY 2; T−200: 2 → лише в періоді «рік», вчасно.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let page: typeof import("~/pages/production");
let today: string;
const v = { bx: "", wx: "", by: "" };
const MANAGER_NO_FINANCE = makeActor({ id: "mgr", displayName: "Manager", role: "staff", overrides: { grant: ["production.manage"] } });

function setContext(actor: Actor = OWNER, locale: "uk" | "en" = "uk") {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale };
}
const load = (search = "") => page.loader({ request: new Request(`http://localhost/demo/production${search}`), params: {}, context: {} } as never);
const at = (offset: number) => new Date(businessDayStart(addIsoDays(today, offset)).getTime() + 12 * 3600 * 1000);
const ctxAt = (offset: number) => ({ ...env.ctx(OWNER), now: () => at(offset) });

async function batch(input: Omit<BatchInput, "title"> & { title?: string }) {
  const { batchId } = await createBatch(env.ctx(OWNER), { title: "Статистика", ...input });
  const [b] = await env.handle.db.select().from(productionBatches).where(eq(productionBatches.id, batchId));
  await startProduction(env.ctx(OWNER), batchId, b!.version);
  const lines = await env.handle.db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, batchId));
  const line = (variantId: string) => lines.find((l) => l.variantId === variantId)!.id;
  return { batchId, line };
}
async function receive(offset: number, batchId: string, lines: Array<{ batchLineId: string; good: number; defective?: number }>) {
  await receiveProduction(ctxAt(offset), batchId, {
    idempotencyKey: globalThis.crypto.randomUUID(),
    lines: lines.map((l) => ({ batchLineId: l.batchLineId, good: l.good, defective: l.defective ?? 0, defectReason: l.defective ? "подряпина" : null })),
  });
}

beforeAll(async () => {
  env = await createTestEnv();
  page = await import("~/pages/production");
  today = businessDate(new Date());
  const p = await insertProduct(env.handle.db, "Stats Test", [
    { sku: "PS-BX", color: "Black", model: "X" },
    { sku: "PS-WX", color: "White", model: "X" },
    { sku: "PS-BY", color: "Black", model: "Y" },
  ]);
  [v.bx, v.wx, v.by] = p.variantIds as [string, string, string];
  const b1 = await batch({
    plannedReadyDate: addIsoDays(today, -10),
    costCurrency: "UAH",
    lines: [
      { variantId: v.bx, quantity: 10, unitCost: "10.00" },
      { variantId: v.wx, quantity: 10, unitCost: "20.00" },
    ],
  });
  await receive(-12, b1.batchId, [
    { batchLineId: b1.line(v.bx), good: 9, defective: 1 },
    { batchLineId: b1.line(v.wx), good: 10 },
  ]);
  const b2 = await batch({ plannedReadyDate: addIsoDays(today, -20), costCurrency: "UAH", lines: [{ variantId: v.by, quantity: 20, unitCost: "5.00" }] });
  await receive(-35, b2.batchId, [{ batchLineId: b2.line(v.by), good: 5 }]);
  await receive(-15, b2.batchId, [{ batchLineId: b2.line(v.by), good: 13, defective: 2 }]);
  const b3 = await batch({ plannedReadyDate: null, lines: [{ variantId: v.bx, quantity: 4 }] });
  await receive(-3, b3.batchId, [{ batchLineId: b3.line(v.bx), good: 4 }]);
  await batch({ plannedReadyDate: addIsoDays(today, -5), lines: [{ variantId: v.wx, quantity: 6 }] });
  const b5 = await batch({ plannedReadyDate: addIsoDays(today, 30), lines: [{ variantId: v.by, quantity: 2 }] });
  await receive(-200, b5.batchId, [{ batchLineId: b5.line(v.by), good: 2 }]);
});
afterAll(async () => {
  await env.close();
});
beforeEach(() => setContext());

describe("production statistics: pure helpers", () => {
  it("period, completion moment, timeliness and grouping", () => {
    expect(statsPeriod("30", "2026-11-27")).toEqual({ key: "30", days: 30, from: "2026-10-29", to: "2026-11-27" });
    expect(isStatsPeriod("365")).toBe(true);
    expect(isStatsPeriod("7")).toBe(false);
    const d = (iso: string) => new Date(`${iso}T10:00:00Z`);
    const one = [{ lineId: "a", ordered: 10 }];
    // Перше надходження, після якого виготовлено ≥ замовлено; пізніший надлишок не змінює момент завершення.
    expect(
      batchCompletionTime(one, [
        { lineId: "a", receivedAt: d("2026-11-10"), produced: 12 },
        { lineId: "a", receivedAt: d("2026-11-01"), produced: 4 },
        { lineId: "a", receivedAt: d("2026-11-20"), produced: 3 },
      ]),
    ).toEqual(d("2026-11-10"));
    // Закрито, не виготовивши все — останнє надходження.
    expect(
      batchCompletionTime(one, [
        { lineId: "a", receivedAt: d("2026-11-01"), produced: 4 },
        { lineId: "a", receivedAt: d("2026-11-05"), produced: 1 },
      ]),
    ).toEqual(d("2026-11-05"));
    expect(batchCompletionTime(one, [])).toBeNull();
    // NEW-1: завершення — за кожною позицією (як стан «Отримано»), а не за сумою партії. Надлишок A (20 із 10) раніше
    // за B не завершує партію: момент — коли виготовлено й B.
    const two = [
      { lineId: "a", ordered: 10 },
      { lineId: "b", ordered: 10 },
    ];
    expect(
      batchCompletionTime(two, [
        { lineId: "a", receivedAt: d("2026-11-01"), produced: 20 },
        { lineId: "b", receivedAt: d("2026-11-08"), produced: 6 },
        { lineId: "b", receivedAt: d("2026-11-12"), produced: 4 },
        { lineId: "a", receivedAt: d("2026-11-15"), produced: 1 },
      ]),
    ).toEqual(d("2026-11-12"));
    // B так і не виготовлено повністю (партію закрили) — останнє надходження, попри суму 25 ≥ 20.
    expect(
      batchCompletionTime(two, [
        { lineId: "a", receivedAt: d("2026-11-01"), produced: 20 },
        { lineId: "b", receivedAt: d("2026-11-03"), produced: 5 },
      ]),
    ).toEqual(d("2026-11-03"));
    expect(timelinessOf("2026-11-10", "2026-11-10")).toBe("onTime");
    expect(timelinessOf("2026-11-11", "2026-11-10")).toBe("late");
    expect(timelinessOf("2026-11-11", null)).toBe("noDate");
    expect(summarizeTimeliness(["onTime", "late", "noDate", "onTime"])).toEqual({ completed: 4, onTime: 2, late: 1, withoutDate: 1, onTimeRate: 66.7 });
    expect(summarizeTimeliness(["noDate"]).onTimeRate).toBeNull();
    expect(
      groupDefects([
        { value: "Black", good: 5, defective: 1 },
        { value: null, good: 50, defective: 0 },
        { value: " Black ", good: 4, defective: 0 },
        { value: "White", good: 20, defective: 5 },
        { value: "Empty", good: 0, defective: 0 },
      ]),
    ).toEqual([
      { value: "White", good: 20, defective: 5, produced: 25, defectRate: 20 },
      { value: "Black", good: 9, defective: 1, produced: 10, defectRate: 10 },
      { value: null, good: 50, defective: 0, produced: 50, defectRate: 0 },
    ]);
  });
});

describe("production statistics: queries and the production page (S5-PROD-STATS)", () => {
  it("90 days: good/defective totals, defect % by model and colour, on-time share; costs only on request", async () => {
    const s = await loadProductionStats(env.handle.db, { today, period: "90", includeCosts: true });
    expect(s.period).toEqual({ key: "90", days: 90, from: addIsoDays(today, -89), to: today });
    expect(s.totals).toEqual({ good: 41, defective: 3, produced: 44, defectRate: 6.8, receipts: 4, batches: 3 });
    expect(s.byModel).toEqual([
      { value: "X", good: 23, defective: 1, produced: 24, defectRate: 4.2 },
      { value: "Y", good: 18, defective: 2, produced: 20, defectRate: 10 },
    ]);
    expect(s.byColor).toEqual([
      { value: "Black", good: 31, defective: 3, produced: 34, defectRate: 8.8 },
      { value: "White", good: 10, defective: 0, produced: 10, defectRate: 0 },
    ]);
    expect(s.timeliness).toEqual({ completed: 3, onTime: 1, late: 1, withoutDate: 1, onTimeRate: 50 });
    expect(s.overdueOpen).toBe((await countProductionDue(env.handle.db, today)).overdue);
    expect(s.overdueOpen).toBeGreaterThanOrEqual(1);
    // 10×10.00 + 10×20.00 (B1) + 20×5.00 (B2) = 400.00 UAH за 37 якісних одиниць із ціною; B3 — 4 одиниці без ціни.
    expect(s.costs).toEqual({ totals: [{ currency: "UAH", amount: "400.00", goodUnits: 37, perGoodUnit: "10.81" }], unitsWithoutCost: 4 });
    expect((await loadProductionStats(env.handle.db, { today, period: "90" })).costs).toBeNull();
  });

  it("30 days and a year: the period decides which receipts and completed batches count", async () => {
    const month = await loadProductionStats(env.handle.db, { today, period: "30", includeCosts: true });
    expect(month.totals).toMatchObject({ good: 36, defective: 3, receipts: 3 });
    expect(month.timeliness).toMatchObject({ completed: 3, onTime: 1, late: 1, withoutDate: 1 });
    expect(month.costs?.totals).toEqual([{ currency: "UAH", amount: "375.00", goodUnits: 32, perGoodUnit: "11.72" }]);
    const year = await loadProductionStats(env.handle.db, { today, period: "365" });
    expect(year.totals).toMatchObject({ good: 43, defective: 3, batches: 4 });
    expect(year.timeliness).toEqual({ completed: 4, onTime: 2, late: 1, withoutDate: 1, onTimeRate: 66.7 });
  });

  it("page loader: ?stats period (default 90, invalid → default); cost figures only for finance.view", async () => {
    setContext(OWNER);
    const owner = await load("?stats=30&tab=all");
    expect(owner.filters).toMatchObject({ stats: "30", tab: "all" });
    expect(owner.stats.totals.good).toBe(36);
    expect(owner.stats.costs?.totals[0]?.amount).toBe("375.00");
    expect((await load("?stats=bogus")).stats.period.key).toBe("90");
    for (const actor of [STAFF, MANAGER_NO_FINANCE]) {
      setContext(actor);
      const data = await load();
      expect(data.stats.totals.good, actor.id).toBe(41);
      expect(data.stats.costs).toBeNull();
      expect(JSON.stringify(data.stats)).not.toMatch(/amount|perGoodUnit|unitCost|UAH/);
    }
  });

  it("renders the statistics card (uk + en): period tabs keep the list filters, cost only for the owner", async () => {
    const route = { path: "production", loader: page.loader, action: page.action, Component: page.default };
    for (const locale of ["uk", "en"] as const) {
      const t = makeT(locale);
      setContext(OWNER, locale);
      const html = await renderPage(route as never, "/demo/production?tab=all&stats=30", OWNER, locale);
      expect(html).toContain(esc(t("production.stats.title")));
      expect(html).toContain(esc(t("production.stats.byModel")));
      expect(html).toContain(esc(t("production.stats.byColor")));
      expect(html).toContain(esc(t("production.stats.onTimeValue", { onTime: "1", total: "2" })));
      expect(html).toContain(esc(t("production.stats.cost")));
      // Вкладки періоду зберігають вкладку стану переліку; фільтри переліку зберігають період.
      expect(html).toContain('href="/demo/production?tab=all&amp;stats=365"');
      expect(html).toContain('href="/demo/production?tab=all"');
      expect(html).toContain('<input type="hidden" name="stats" value="30"/>');
      setContext(STAFF, locale);
      const staff = await renderPage(route as never, "/demo/production", STAFF, locale);
      expect(staff).toContain(esc(t("production.stats.title")));
      expect(staff).not.toContain(esc(t("production.stats.cost")));
    }
    expect(DICTIONARIES.uk["production.stats.period.365"]).toBe("Рік");
  });

  it("NEW-1: over-receipt of one line before another line is complete does not make a late batch on time", async () => {
    // Окремий вигаданий «сьогодні» далеко в минулому (T′ = T − 1000), щоб не зачепити решту фікстури й демо-історію.
    // План T′−10: A 10 і B 10. T′−40: A 20 (з надлишком) — стан «Частково отримано»; T′−5: B 10 — «Отримано».
    // Партія отримана повністю T′−5 → із запізненням; за сумою партії (20 ≥ 20 уже T′−40) вона вийшла б «вчасно»,
    // а за 30 днів не потрапила б у період зовсім.
    const base = addIsoDays(today, -1000);
    const atBase = (offset: number) => new Date(businessDayStart(addIsoDays(base, offset)).getTime() + 12 * 3600 * 1000);
    const late = await batch({
      plannedReadyDate: addIsoDays(base, -10),
      lines: [
        { variantId: v.bx, quantity: 10 },
        { variantId: v.wx, quantity: 10 },
      ],
    });
    const receiveAt = async (offset: number, batchLineId: string, good: number) =>
      receiveProduction(
        { ...env.ctx(OWNER), now: () => atBase(offset) },
        late.batchId,
        { idempotencyKey: globalThis.crypto.randomUUID(), allowOverReceipt: true, lines: [{ batchLineId, good, defective: 0, defectReason: null }] },
      );
    expect((await receiveAt(-40, late.line(v.bx), 20)).status).toBe("partially_received");
    expect((await receiveAt(-5, late.line(v.wx), 10)).status).toBe("received");
    const quarter = await loadProductionStats(env.handle.db, { today: base, period: "90" });
    expect(quarter.totals).toMatchObject({ good: 30, defective: 0, receipts: 2, batches: 1 });
    expect(quarter.timeliness).toEqual({ completed: 1, onTime: 0, late: 1, withoutDate: 0, onTimeRate: 0 });
    const month = await loadProductionStats(env.handle.db, { today: base, period: "30" });
    expect(month.timeliness).toEqual({ completed: 1, onTime: 0, late: 1, withoutDate: 0, onTimeRate: 0 });
  });

  it("403 without warehouse.view", async () => {
    setContext(makeActor({ id: "x", displayName: "X", role: "staff", overrides: { revoke: ["warehouse.view"] } }));
    await expect(load()).rejects.toMatchObject({ status: 403 });
  });
});

import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { Outlet, StaticRouterProvider, createStaticHandler, createStaticRouter } from "react-router";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { auditLog, productionBatchLines } from "~/db/schema";
import type { ShellData } from "~/components/shell-types";
import { can, makeActor, type Actor } from "~/domain/permissions";
import { DICTIONARIES } from "~/i18n";
import { cancelBatch, closeBatch, createBatch, receiveProduction, startProduction } from "~/modules/production/batches.server";
import { exportProductionCsv } from "~/modules/warehouse-analytics/export.server";
import { EXPORT_DATASETS, exportDatasetsFor, parseExportParams } from "~/modules/warehouse-analytics/params";
import { businessDate } from "~/modules/warehouse/dates";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../helpers";
import { insertProduct } from "./helpers";

/**
 * S5-FIN: CSV-набір «production» — партії виробництва із собівартістю для майбутнього фінансового модуля/ШІ.
 * Лише власник (finance.view): працівник отримує 403 і не бачить кнопки. Рядок — позиція партії; собівартість —
 * batchCostSummary за всіма позиціями партії. Без приміток, виробника й імен працівників. Дані вигадані.
 */
const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
let exportRoute: typeof import("~/pages/warehouse-export");
let analyticsPage: typeof import("~/pages/warehouse-analytics");
const ids = { product: "", closed: "", cancelled: "", closedNumber: "", cancelledNumber: "" };
const NO_VIEW = makeActor({ id: "no-view", displayName: "No view", role: "staff", overrides: { revoke: ["warehouse.view"] } });
const SECRETS = ["Maker Secret Ltd", "Private batch note", "Receipt note text", "scratched corner", "Owner"];

beforeAll(async () => {
  env = await createTestEnv();
  exportRoute = await import("~/pages/warehouse-export");
  analyticsPage = await import("~/pages/warehouse-analytics");
  const db = env.handle.db;
  const owner = env.ctx(OWNER);
  const p = await insertProduct(db, "Export Production Test", [
    { sku: "EP-RED", color: "Red", model: "EP1" },
    { sku: "EP-BLUE", color: "Blue", model: "EP1" },
    { sku: "EP-GREEN", color: "Green", model: "EP2" },
  ]);
  ids.product = p.productId;
  const [red, blue, green] = p.variantIds as [string, string, string];

  // Партія 1: червоні 10 × 100.00, сині 5 × 50.00, додаткові витрати 30.00 UAH → часткове надходження з браком,
  // решта, закриття.
  const b1 = await createBatch(owner, {
    title: "Export Batch One",
    plannedReadyDate: "2026-12-20",
    manufacturer: "Maker Secret Ltd",
    notes: "Private batch note",
    extraCost: "30.00",
    costCurrency: "UAH",
    lines: [
      { variantId: red, quantity: 10, unitCost: "100.00" },
      { variantId: blue, quantity: 5, unitCost: "50.00" },
    ],
  });
  ids.closed = b1.batchId;
  ids.closedNumber = b1.number;
  await startProduction(owner, b1.batchId, 1);
  const lines = await db.select().from(productionBatchLines).where(eq(productionBatchLines.batchId, b1.batchId));
  const redLine = lines.find((l) => l.variantId === red)!;
  await receiveProduction(env.ctx(STAFF), b1.batchId, {
    idempotencyKey: crypto.randomUUID(),
    note: "Receipt note text",
    lines: [{ batchLineId: redLine.id, good: 4, defective: 1, defectReason: "scratched corner" }],
  });
  await receiveProduction(env.ctx(STAFF), b1.batchId, { idempotencyKey: crypto.randomUUID(), lines: "remaining" });
  const version = async (id: string) =>
    (await db.query.productionBatches.findFirst({ where: (t, { eq: e }) => e(t.id, id) }))!.version;
  await closeBatch(owner, b1.batchId, await version(b1.batchId));

  // Партія 2: заплановано без цін → скасовано.
  const b2 = await createBatch(owner, { title: "Export Batch Two", lines: [{ variantId: green, quantity: 3 }] });
  ids.cancelled = b2.batchId;
  ids.cancelledNumber = b2.number;
  await cancelBatch(owner, b2.batchId, await version(b2.batchId));
});
afterAll(async () => {
  await env.close();
});

function setContext(actor: Actor = OWNER) {
  m.ctx = { ...env.ctx(actor), basePath: "/demo", locale: "uk" };
}
beforeEach(() => setContext());

function parseCsv(content: string, sep: string): Array<Record<string, string>> {
  expect(content.charCodeAt(0)).toBe(0xfeff);
  const [header, ...rows] = content.slice(1).trimEnd().split("\r\n");
  const cols = header!.split(sep);
  return rows.map((l) => Object.fromEntries(l.split(sep).map((v, i) => [cols[i]!, v])));
}

const onlyTest = () => ({ productIds: [ids.product] });
const loadExport = (search: string) =>
  exportRoute.loader({ request: new Request(`http://localhost/demo/warehouse/export${search}`), params: {}, context: {} } as never) as Promise<Response>;

describe("production dataset (owner only)", () => {
  it("one row per batch line with dates, quantities and costs (batchCostSummary over all lines)", async () => {
    const today = businessDate(new Date());
    const csv = await exportProductionCsv(env.ctx(OWNER), { separator: "comma", filters: onlyTest() });
    expect(csv).toMatchObject({ dataset: "production", rows: 3, truncated: false, withCosts: true });
    expect(csv.fileName).toBe(`production_${today}.csv`);
    const rows = parseCsv(csv.content, ",");
    const red = rows.find((r) => r.sku === "EP-RED")!;
    const blue = rows.find((r) => r.sku === "EP-BLUE")!;
    const green = rows.find((r) => r.sku === "EP-GREEN")!;
    expect(red).toMatchObject({
      batch_number: ids.closedNumber,
      batch_title: "Export Batch One",
      status: "closed",
      created_date: today,
      planned_ready_date: "2026-12-20",
      started_date: today,
      first_received_date: today,
      last_received_date: today,
      closed_date: today,
      product: "Export Production Test",
      model: "EP1",
      color: "Red",
      ordered: "10",
      received_good: "9",
      received_defective: "1",
      remaining: "0",
      billed_qty: "10",
      cost_currency: "UAH",
      unit_cost: "100.00",
      line_total: "1000.00",
      // Частка додаткових витрат: 30 × 10 / 15; планова собівартість одиниці виготовленого: 100 + 30 / 15.
      extra_cost_share: "20.00",
      landed_unit_cost: "102.00",
      // Брак «оплачують» якісні: (10 × 100 + 20) / 9.
      cost_per_good_unit: "113.33",
      batch_extra_cost: "30.00",
      batch_total_cost: "1280.00",
      batch_produced_cost: "1280.00",
      batch_good_received: "14",
      // 1280 / 14 якісних.
      batch_cost_per_good_unit: "91.43",
      batch_cost_complete: "true",
    });
    expect(blue).toMatchObject({ received_good: "5", received_defective: "0", unit_cost: "50.00", extra_cost_share: "10.00", cost_per_good_unit: "52.00" });
    expect(green).toMatchObject({
      batch_number: ids.cancelledNumber,
      status: "cancelled",
      started_date: "",
      first_received_date: "",
      closed_date: today,
      ordered: "3",
      remaining: "3",
      billed_qty: "0",
      cost_currency: "",
      unit_cost: "",
      batch_cost_per_good_unit: "",
      batch_cost_complete: "false",
    });
    // Без приміток, виробника, причин браку й імен працівників.
    for (const s of SECRETS) expect(csv.content, s).not.toContain(s);
    // Журнал експорту (без персональних даних).
    const [audit] = await env.handle.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "warehouse.exported"), eq(auditLog.actorId, OWNER.id)))
      .orderBy(desc(auditLog.id))
      .limit(1);
    expect(audit!.details).toMatchObject({ dataset: "production", rows: 3, withCosts: true, truncated: false });
  });

  it("filters apply to lines, but costs are computed over the whole batch; the Excel profile uses a decimal comma", async () => {
    const csv = await exportProductionCsv(env.ctx(OWNER), { filters: { ...onlyTest(), colors: ["Blue"] } });
    const rows = parseCsv(csv.content, ";");
    expect(rows.map((r) => r.sku)).toEqual(["EP-BLUE"]);
    expect(rows[0]).toMatchObject({ extra_cost_share: "10,00", batch_cost_per_good_unit: "91,43", batch_total_cost: "1280,00" });
  });

  it("is capped like the movement history (truncated flag)", async () => {
    const csv = await exportProductionCsv(env.ctx(OWNER), { filters: onlyTest(), maxRows: 2 });
    expect(csv).toMatchObject({ rows: 2, truncated: true });
  });

  it("staff and actors without warehouse.view are refused on the server", async () => {
    await expect(exportProductionCsv(env.ctx(STAFF))).rejects.toMatchObject({ permission: "finance.view" });
    await expect(exportProductionCsv(env.ctx(NO_VIEW))).rejects.toMatchObject({ permission: "warehouse.view" });
  });
});

describe("export route and page", () => {
  it("route: owner gets the CSV with costs; staff gets 403 (no file)", async () => {
    const owner = await loadExport(`?dataset=production&sep=comma&product=${ids.product}`);
    expect(owner.status).toBe(200);
    expect(owner.headers.get("Content-Type")).toMatch(/^text\/csv/);
    expect(owner.headers.get("X-Export-With-Costs")).toBe("1");
    expect(owner.headers.get("X-Export-Rows")).toBe("3");
    expect(await owner.text()).toContain("batch_cost_per_good_unit");
    setContext(STAFF);
    const staff = await loadExport("?dataset=production");
    expect(staff.status).toBe(403);
    expect(staff.headers.get("X-Export-Error")).toBe("warehouseAnalytics.export.error.forbidden");
    expect(await staff.text()).not.toContain("batch_number");
    // Інші набори працівнику доступні (без колонок собівартості).
    expect((await loadExport("?dataset=stock")).status).toBe(200);
  });

  it("params: the dataset is recognised; only finance.view actors get its button", () => {
    expect(parseExportParams(new URLSearchParams("dataset=production")).dataset).toBe("production");
    expect(EXPORT_DATASETS).toContain("production");
    expect(exportDatasetsFor((p) => can(OWNER, p))).toEqual(["stock", "movements", "sales", "production"]);
    expect(exportDatasetsFor((p) => can(STAFF, p))).toEqual(["stock", "movements", "sales"]);
  });

  it("analytics page: owner sees the «Production batches» export and its help; staff does not", async () => {
    const uk = (k: string) => DICTIONARIES.uk[k]!;
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
    const owner = await renderAnalytics(OWNER);
    expect(owner).toContain(esc(uk("warehouseAnalytics.export.dataset.production")));
    expect(owner).toContain(esc(uk("warehouseAnalytics.export.productionHelp")));
    setContext(STAFF);
    const staff = await renderAnalytics(STAFF);
    expect(staff).toContain(esc(uk("warehouseAnalytics.export.dataset.stock")));
    expect(staff).not.toContain(esc(uk("warehouseAnalytics.export.dataset.production")));
    expect(staff).not.toContain(esc(uk("warehouseAnalytics.export.productionHelp")));
  });
});

async function renderAnalytics(actor: Actor): Promise<string> {
  const shell: ShellData = {
    mode: "demo",
    basePath: "/demo",
    actor: { id: actor.id, displayName: actor.displayName, role: actor.role, permissions: [...actor.permissions] },
    nav: [],
    automation: { mode: "semi", globalPause: false },
    openProblems: 0,
    demo: null,
  };
  const routes = [
    {
      id: "root",
      path: "/",
      loader: () => ({ locale: "uk" }),
      Component: Outlet,
      children: [
        {
          id: "routes/demo-layout",
          path: "demo",
          loader: () => shell,
          Component: Outlet,
          children: [{ id: "page", path: "warehouse/analytics", loader: analyticsPage.loader, Component: analyticsPage.default }],
        },
      ],
    },
  ];
  const handler = createStaticHandler(routes as never);
  const context = await handler.query(new Request("http://localhost/demo/warehouse/analytics"));
  if (context instanceof Response) throw new Error(`unexpected response ${context.status}`);
  expect(context.errors).toBeNull();
  return renderToString(h(StaticRouterProvider, { router: createStaticRouter(handler.dataRoutes, context), context }));
}

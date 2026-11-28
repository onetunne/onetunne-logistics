/**
 * Етап 6 (WP0): ключ налаштувань finance (§5.2) і маршрути-заглушки з остаточною перевіркою доступу (§14.2, §20.4):
 * - сторінка «Налаштування» НІКОЛИ не повертає finance (працівник із settings.view і власник);
 * - PERMISSION_FOR_KEY.finance = finance.manage; підроблений працівник не змінює фінансові налаштування;
 *   saveFinanceSettings — settings_history + finance_change_log; валюта оцінки блокується після першої оцінки;
 *   загальний updateSetting ключ finance відхиляє (без обходу історії змін), writeFinanceSettingsVersion імпортує лише
 *   ядро; суми з сотими у валюті з 0 знаками — помилка amountWholeUnits (§5.1);
 * - кожен /finance/* loader і action: працівник → 403; власник → 200; експорт/зразок — 403/404; /analytics —
 *   переадресація працівника; /returns — orders.view, без сум.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { financeChangeLog, inventoryValuations, settingsHistory } from "~/db/schema";
import { ForbiddenError, makeActor, type Actor } from "~/domain/permissions";
import { getFinanceSettings, saveFinanceSettings } from "~/modules/finance/core/settings.server";
import { DEFAULT_SETTINGS, financeSchema } from "~/modules/settings/schema";
import { getSetting, permissionForSettingsKey, updateSetting } from "~/modules/settings/settings.server";
import type { RequestContext } from "~/server/types";
import { OWNER, STAFF, createTestEnv, type TestEnv } from "../../helpers";

const m = vi.hoisted(() => ({ ctx: null as RequestContext | null }));
vi.mock("~/server/context.server", () => ({
  getRequestContext: async () => {
    if (!m.ctx) throw new Error("test context is not set");
    return m.ctx;
  },
}));

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});
function setContext(actor: Actor, mode: "demo" | "production" = "demo") {
  m.ctx = { ...env.ctx(actor), mode, basePath: mode === "demo" ? "/demo" : "/app", locale: "uk" };
}
beforeEach(() => setContext(OWNER));

const SETTINGS_VIEWER = makeActor({ id: "viewer", displayName: "Viewer", role: "staff", overrides: { grant: ["settings.view"] } });
const FORGED: Actor = { ...STAFF, id: "forged", permissions: new Set([...STAFF.permissions, "finance.view", "finance.manage"]) };

describe("settings key finance", () => {
  it("defaults of §5.2 (every field with .default())", () => {
    expect(DEFAULT_SETTINGS.finance).toEqual({
      reportingCurrency: "UAH",
      valuationCurrency: "UAH",
      displayCurrencies: ["UAH", "EUR", "USD", "GBP", "PLN"],
      fx: { nbuEnabled: false, autoFetch: true, fallbackDays: 7, rateDatePolicy: "payment_date" },
      vatPayer: false,
      includeTestOrders: false,
      shippingVariance: { percent: 15, minAmount: "50.00", currency: "UAH", weightPercent: 10, weightMinGrams: 100, lossMinAmount: "50.00" },
      shippingForecast: { historyDays: 90, minSamples: 3, byCountry: [] },
      partners: { defaultRateBp: 1000, holdDays: 30 },
      reports: { scheduledSnapshots: true },
    });
    // Збережене раніше часткове значення лишається дійсним.
    expect(financeSchema.parse({ fx: { nbuEnabled: true } }).fx).toEqual({ nbuEnabled: true, autoFetch: true, fallbackDays: 7, rateDatePolicy: "payment_date" });
    expect(financeSchema.safeParse({ reportingCurrency: "KWD" }).success).toBe(false);
    expect(financeSchema.safeParse({ displayCurrencies: ["EUR", "EUR"] }).success).toBe(false);
    expect(permissionForSettingsKey("finance")).toBe("finance.manage");
  });

  it("the Settings page loader NEVER returns finance (staff with settings.view and the owner)", async () => {
    const page = await import("~/pages/settings");
    for (const actor of [SETTINGS_VIEWER, OWNER]) {
      setContext(actor);
      const data = (await page.loader({ request: new Request("http://localhost/demo/settings"), params: {}, context: {} } as never)) as Record<string, unknown>;
      expect(Object.keys(data)).not.toContain("finance");
      const json = JSON.stringify(data);
      expect(json).not.toMatch(/reportingCurrency|valuationCurrency|displayCurrencies|nbuEnabled|includeTestOrders|shippingVariance/);
    }
  });

  it("only the owner role changes finance settings; each change → settings_history + finance_change_log", async () => {
    const db = env.handle.db;
    await expect(updateSetting(db, FORGED, "finance", DEFAULT_SETTINGS.finance)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(updateSetting(db, STAFF, "finance", DEFAULT_SETTINGS.finance)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(saveFinanceSettings({ db, actor: FORGED }, { vatPayer: true })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(getFinanceSettings({ db, actor: FORGED })).rejects.toBeInstanceOf(ForbiddenError);
    const before = await getFinanceSettings({ db, actor: OWNER });
    const r = await saveFinanceSettings({ db, actor: OWNER }, { vatPayer: true, fx: { ...before.value.fx, fallbackDays: 5 } }, { expectedVersion: before.version, reason: "Бухгалтер +380671234567" });
    expect(r.ok).toBe(true);
    expect((await getSetting(db, "finance")).vatPayer).toBe(true);
    const history = await db.select().from(settingsHistory).where(eq(settingsHistory.key, "finance"));
    expect(history.map((h) => h.version)).toContain(before.version + 1);
    const [log] = await db.select().from(financeChangeLog).where(eq(financeChangeLog.entityType, "settings_finance"));
    expect(log).toMatchObject({ action: "update", actorId: OWNER.id, actorRole: "owner" });
    expect(log!.before).toEqual({ settings: { vatPayer: false, fx: before.value.fx } });
    expect(log!.after).toMatchObject({ settings: { vatPayer: true, fx: { ...before.value.fx, fallbackDays: 5 } }, settingsVersion: before.version + 1 });
    expect(log!.reason).not.toContain("380671234567");
  });

  it("the generic updateSetting refuses key finance even for the owner (no bypass of finance_change_log / valuation lock)", async () => {
    const db = env.handle.db;
    const historyBefore = (await db.select().from(settingsHistory).where(eq(settingsHistory.key, "finance"))).length;
    const logBefore = (await db.select().from(financeChangeLog)).length;
    await expect(
      updateSetting(db, OWNER, "finance", { ...DEFAULT_SETTINGS.finance, valuationCurrency: "EUR", fx: { ...DEFAULT_SETTINGS.finance.fx, nbuEnabled: true } }),
    ).rejects.toThrow(/saveFinanceSettings/);
    expect((await db.select().from(settingsHistory).where(eq(settingsHistory.key, "finance"))).length).toBe(historyBefore);
    expect((await db.select().from(financeChangeLog)).length).toBe(logBefore);
    expect((await getSetting(db, "finance")).fx.nbuEnabled).toBe(false);
    // Інші ключі — як раніше.
    expect((await updateSetting(db, OWNER, "tracking", await getSetting(db, "tracking"))).ok).toBe(true);
  });

  it("writeFinanceSettingsVersion is imported only by the finance core settings service", () => {
    const walk = (dir: string): string[] =>
      fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        return e.isDirectory() ? walk(p) : /\.(tsx?|mjs)$/.test(e.name) ? [p] : [];
      });
    const users = walk(path.resolve("app"))
      .filter((f) => /\bwriteFinanceSettingsVersion\b/.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(path.resolve("."), f).split(path.sep).join("/"))
      .sort();
    expect(users).toEqual(["app/modules/finance/core/settings.server.ts", "app/modules/settings/settings.server.ts"]);
  });

  it("amounts with minor units in a 0-decimal currency are a parse error, not rounding (§5.1)", () => {
    const bad = financeSchema.safeParse({
      shippingForecast: { byCountry: [{ country: "JP", amount: "12.50", currency: "JPY" }] },
      shippingVariance: { currency: "JPY", minAmount: "50.75", lossMinAmount: "10.01" },
    });
    expect(bad.success).toBe(false);
    const issues = bad.success ? [] : bad.error.issues.map((i) => `${i.path.join(".")}:${i.message}`).sort();
    expect(issues).toEqual([
      "shippingForecast.byCountry.0.amount:amountWholeUnits",
      "shippingVariance.lossMinAmount:amountWholeUnits",
      "shippingVariance.minAmount:amountWholeUnits",
    ]);
    // Цілі суми в JPY (з «.00» чи без) і соті в EUR — дійсні.
    const ok = financeSchema.safeParse({
      shippingForecast: { byCountry: [{ country: "JP", amount: "1250", currency: "JPY" }, { country: "DE", amount: "12.50", currency: "EUR" }] },
      shippingVariance: { currency: "JPY", minAmount: "5000.00", lossMinAmount: "300" },
    });
    expect(ok.success).toBe(true);
  });

  it("the valuation currency is locked after the first valuation", async () => {
    const db = env.handle.db;
    const { stockItems, warehouses } = await import("~/db/schema");
    const [item] = await db.select({ id: stockItems.id }).from(stockItems).limit(1);
    const [wh] = await db.select({ id: warehouses.id }).from(warehouses).limit(1);
    await db.insert(inventoryValuations).values({
      eventKey: "test:lock",
      warehouseId: wh!.id,
      stockItemId: item!.id,
      currency: "UAH",
      kind: "inflow",
      qty: 1,
      valueSource: "none",
      occurredOn: "2026-11-01",
    });
    await expect(saveFinanceSettings({ db, actor: OWNER }, { valuationCurrency: "EUR" })).rejects.toMatchObject({ code: "finance.error.valuationCurrencyLocked" });
    expect((await saveFinanceSettings({ db, actor: OWNER }, { reportingCurrency: "EUR" })).ok).toBe(true);
    await db.delete(inventoryValuations).where(eq(inventoryValuations.eventKey, "test:lock"));
  });
});

const FINANCE_PAGES = [
  "finance",
  "finance-pnl",
  "finance-orders",
  "finance-shipping",
  "finance-shipping-import",
  "finance-shipping-invoice",
  "finance-expenses",
  "finance-partners",
  "finance-partner",
  "finance-costs",
  "finance-rates",
  "finance-reports",
  "finance-periods",
  "finance-settings",
] as const;

type PageModule = {
  loader: (args: unknown) => Promise<unknown>;
  action?: (args: unknown) => Promise<unknown>;
};
const args = (url: string, method = "GET") => ({ request: new Request(url, { method }), params: {}, context: {} });
const statusOf = async (p: Promise<unknown>) => {
  try {
    const v = await p;
    return v instanceof Response ? v.status : 200;
  } catch (e) {
    if (e instanceof Response) return e.status;
    throw e;
  }
};

describe("stage-6 routes: every stub enforces its permission (§14.2)", () => {
  it("all routes are mounted for /demo and /app before the planned catch-all", async () => {
    const routes = (await import("~/routes")).default as Array<{ path?: string; children?: Array<{ path?: string; id?: string; file: string }> }>;
    const expected = [
      "finance",
      "finance/pnl",
      "finance/orders",
      "finance/shipping",
      "finance/shipping/import",
      "finance/shipping/invoices/:invoiceId",
      "finance/shipping/sample",
      "finance/expenses",
      "finance/partners",
      "finance/partners/:partnerId",
      "finance/costs",
      "finance/rates",
      "finance/reports",
      "finance/periods",
      "finance/settings",
      "finance/export",
      "analytics",
      "returns",
      "returns/:returnId",
    ];
    for (const prefix of ["demo", "app"]) {
      const layout = routes.find((r) => r.path === prefix)!;
      const paths = layout.children!.map((c) => c.path);
      for (const p of expected) expect(paths, `${prefix}/${p}`).toContain(p);
      expect(paths.indexOf(":section")).toBe(paths.length - 1);
      expect(new Set(layout.children!.map((c) => c.id)).size).toBe(layout.children!.length);
    }
  });

  it("staff (and a forged staff actor with finance permissions) → 403 on every /finance/* loader and action; owner → 200", async () => {
    for (const name of FINANCE_PAGES) {
      const mod = (await import(`~/pages/${name}.tsx`)) as PageModule;
      for (const actor of [STAFF, FORGED]) {
        setContext(actor);
        expect(await statusOf(mod.loader(args(`http://localhost/demo/${name}`))), `${name} loader ${actor.id}`).toBe(403);
        expect(await statusOf(mod.action!(args(`http://localhost/demo/${name}`, "POST"))), `${name} action ${actor.id}`).toBe(403);
      }
      setContext(OWNER);
      const data = await mod.loader(args(`http://localhost/demo/${name}`));
      expect(data, name).toEqual({ demo: true });
      expect(await mod.action!(args(`http://localhost/demo/${name}`, "POST"))).toEqual({ ok: false, error: "finance.error.notImplemented" });
    }
  });

  it("resource routes: export → 403 for staff, 501 for the owner (no-store); sample → demo only", async () => {
    const exp = (await import("~/pages/finance-export")) as PageModule;
    setContext(STAFF);
    const denied = (await exp.loader(args("http://localhost/demo/finance/export"))) as Response;
    expect(denied.status).toBe(403);
    expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
    setContext(OWNER);
    expect(((await exp.loader(args("http://localhost/demo/finance/export"))) as Response).status).toBe(501);
    const sample = (await import("~/pages/finance-shipping-sample")) as PageModule;
    setContext(STAFF);
    expect(((await sample.loader(args("http://localhost/demo/finance/shipping/sample"))) as Response).status).toBe(403);
    setContext(OWNER, "production");
    expect(await statusOf(sample.loader(args("http://localhost/app/finance/shipping/sample")))).toBe(404);
  });

  it("returns: orders.view; amounts are null (never an empty object) — and nothing financial reaches staff", async () => {
    for (const name of ["returns", "return-detail"]) {
      const mod = (await import(`~/pages/${name}.tsx`)) as PageModule;
      setContext(STAFF);
      const data = await mod.loader(args(`http://localhost/demo/${name}`));
      expect(data).toEqual({ amounts: null });
      expect(JSON.stringify(data)).not.toMatch(/(profit|прибут|cogs|собіварт|margin|rentab|рентаб|revenue|оборот|turnover)/i);
      setContext(makeActor({ id: "no-orders", displayName: "N", role: "staff", overrides: { revoke: ["orders.view"] } }));
      expect(await statusOf(mod.loader(args(`http://localhost/demo/${name}`)))).toBe(403);
    }
  });
});

/**
 * Етап 6, WP2: підказки собівартості з Shopify (docs/stage6-design.md §6.6, §16.2, D-22) з імітацією Admin API 2026-10:
 * документ OtVariantCosts (точна оцінка вартості формулою, ≤ 950), дочитування всіх сторінок, строгий розбір (null /
 * пошкоджене — без підказки, не 0), непідтверджені рядки (лише прогноз), масове підтвердження → факт і завершення
 * «до залишку». Лише робочий режим; працівник — 403. Завдання finance.valuation_pending — реєстр і розклад.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jobs, productVariants, stockItemCosts } from "~/db/schema";
import { COST_QUERY_COST_ESTIMATES, VARIANT_COSTS_PAGE, VARIANT_COSTS_QUERY, type VariantCostsPage } from "~/integrations/shopify/cost-graphql";
import type { AdminGraphql } from "~/integrations/shopify/admin-client.server";
import { handlers as costingHandlers, ensureSchedules, valuationPendingScope } from "~/modules/costing/jobs.server";
import { manualCostAt } from "~/modules/costing/inputs.server";
import { confirmCostSuggestions, importShopifyCostSuggestions, listCostSuggestions, parseVariantCosts } from "~/modules/costing/shopify-costs.server";
import { unitCostForecast } from "~/modules/costing/forecast.server";
import { FINANCE_JOB } from "~/modules/finance/jobs";
import { createFinanceJobHandlers } from "~/modules/finance/jobs.server";
import { OWNER, STAFF } from "../../helpers";
import { requestedQueryCost } from "../../helpers/shopify-query-cost";
import { costState, move, openCostEnv, product, type CostEnv } from "./db-helpers";

let env: CostEnv;
beforeAll(async () => {
  env = await openCostEnv();
});
afterAll(async () => {
  await env.close();
});

describe("OtVariantCosts document", () => {
  it("exact estimate 2 + VARIANT_COSTS_PAGE × (pageInfo 1 + node 1 + inventoryItem 1 + unitCost 1) = 402 ≤ 950", () => {
    expect(requestedQueryCost(VARIANT_COSTS_QUERY, { after: null })).toBe(2 + VARIANT_COSTS_PAGE * 4);
    expect(requestedQueryCost(VARIANT_COSTS_QUERY, { after: null })).toBe(COST_QUERY_COST_ESTIMATES.OtVariantCosts);
    expect(VARIANT_COSTS_QUERY).toContain(`productVariants(first: ${VARIANT_COSTS_PAGE}, after: $after)`);
    // Свідомо без персональних даних і без зайвих полів.
    expect(VARIANT_COSTS_QUERY).not.toMatch(/customer|email|phone|address/i);
  });

  it("strict parse: null or malformed cost → no suggestion (not 0); 0-decimal currency with cents → no suggestion", () => {
    const page: VariantCostsPage = {
      productVariants: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [
          { id: "a", inventoryItem: { id: "i", unitCost: { amount: "12.5", currencyCode: "EUR" } } },
          { id: "b", inventoryItem: { id: "i", unitCost: null } },
          { id: "c", inventoryItem: null },
          { id: "d", inventoryItem: { id: "i", unitCost: { amount: "1e3", currencyCode: "EUR" } } },
          { id: "e", inventoryItem: { id: "i", unitCost: { amount: "10.50", currencyCode: "JPY" } } },
          { id: "f", inventoryItem: { id: "i", unitCost: { amount: "1000", currencyCode: "JPY" } } },
        ],
      },
    };
    expect(parseVariantCosts(page)).toEqual([
      { gid: "a", amount: "12.50", currency: "EUR" },
      { gid: "b", amount: null, currency: null },
      { gid: "c", amount: null, currency: null },
      { gid: "d", amount: null, currency: null },
      { gid: "e", amount: null, currency: null },
      { gid: "f", amount: "1000.00", currency: "JPY" },
    ]);
  });
});

describe("import → suggestions → confirm", () => {
  it("reads all pages, writes unconfirmed rows (forecast only), the owner confirms → fact + completion to stock", async () => {
    const a = await product(env.db);
    const b = await product(env.db);
    await env.db.update(productVariants).set({ shopifyVariantId: "gid://shopify/ProductVariant/9001" }).where(eq(productVariants.id, a.variantId));
    await env.db.update(productVariants).set({ shopifyVariantId: "gid://shopify/ProductVariant/9002" }).where(eq(productVariants.id, b.variantId));
    await move(env.db, { stockItemId: a.stockItemId, type: "receipt_manual", onHandDelta: 3, reason: "found" });
    const calls: Array<Record<string, unknown> | undefined> = [];
    const pages: VariantCostsPage[] = [
      {
        productVariants: {
          pageInfo: { hasNextPage: true, endCursor: "c1" },
          nodes: [{ id: "gid://shopify/ProductVariant/9001", inventoryItem: { id: "gid://shopify/InventoryItem/1", unitCost: { amount: "205.00", currencyCode: "UAH" } } }],
        },
      },
      {
        productVariants: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            { id: "gid://shopify/ProductVariant/9002", inventoryItem: { id: "gid://shopify/InventoryItem/2", unitCost: null } },
            { id: "gid://shopify/ProductVariant/404", inventoryItem: { id: "gid://shopify/InventoryItem/3", unitCost: { amount: "1.00", currencyCode: "UAH" } } },
          ],
        },
      },
    ];
    const admin = (async (query: string, variables?: Record<string, unknown>) => {
      expect(query).toBe(VARIANT_COSTS_QUERY);
      calls.push(variables);
      return pages[calls.length - 1];
    }) as AdminGraphql;
    const prod = env.ctx(OWNER, { mode: "production" });
    await expect(importShopifyCostSuggestions(env.ctx(STAFF, { mode: "production" }), admin)).rejects.toMatchObject({ status: 403 });
    await expect(importShopifyCostSuggestions(env.ctx(OWNER), admin)).rejects.toMatchObject({ code: "financeCosts.error.shopifyUnavailable" });
    const r = await importShopifyCostSuggestions(prod, admin);
    expect(calls).toEqual([{ after: null }, { after: "c1" }]);
    expect(r).toEqual({ variants: 3, suggestions: 1, withoutCost: 1, unknownVariants: 1, truncated: false });
    // Непідтверджена підказка — лише прогноз (не факт оцінки).
    expect(await manualCostAt(env.db, a.stockItemId, "2100-01-01", { confirmedOnly: true })).toBeNull();
    expect(await unitCostForecast(env.db, a.stockItemId, "2100-01-01")).toEqual({ unitCost: "205.00", currency: "UAH", basis: "owner_standard" });
    const suggestions = await listCostSuggestions(env.ctx(OWNER));
    expect(suggestions).toMatchObject([{ stockItemId: a.stockItemId, unitCost: "205.00", currency: "UAH", current: null }]);
    // Повторне завантаження тієї самої ціни — без нового рядка.
    calls.length = 0;
    expect((await importShopifyCostSuggestions(prod, admin)).suggestions).toBe(0);
    await expect(confirmCostSuggestions(env.ctx(STAFF), { operationId: randomUUID(), suggestionIds: [suggestions[0]!.id], effectiveFrom: "2026-11-01", applyToStock: true, applyToSold: false })).rejects.toMatchObject({ status: 403 });
    const c = await confirmCostSuggestions(env.ctx(OWNER), { operationId: randomUUID(), suggestionIds: [suggestions[0]!.id], effectiveFrom: "2026-11-01", applyToStock: true, applyToSold: false });
    expect(c).toMatchObject({ confirmed: 1, completedStockUnits: 3 });
    expect(await costState(env.db, a.stockItemId)).toMatchObject({ knownQty: 3, knownValue: "615.00", unknownQty: 0 });
    const rows = await env.db.select().from(stockItemCosts).where(eq(stockItemCosts.stockItemId, a.stockItemId));
    expect(rows.map((x) => [x.source, x.confirmed]).sort()).toEqual([
      ["shopify_unit_cost", false],
      ["shopify_unit_cost", true],
    ]);
    expect(await listCostSuggestions(env.ctx(OWNER))).toEqual([]);
  });
});

describe("jobs (finance.valuation_pending)", () => {
  it("the handler is registered for the costing module; the scope is parsed strictly; ensureSchedules enqueues only when layers await a rate", async () => {
    const h = costingHandlers({ db: env.db, serviceContext: () => env.ctx(), admin: async () => (async () => ({})) as unknown as AdminGraphql });
    expect(Object.keys(h)).toEqual([FINANCE_JOB.valuationPending]);
    expect(Object.keys(createFinanceJobHandlers({ db: env.db, serviceContext: () => env.ctx(), admin: async () => (async () => ({})) as unknown as AdminGraphql }))).toContain(FINANCE_JOB.valuationPending);
    expect(valuationPendingScope({ currency: "EUR", date: "2026-11-01", extra: "x" })).toEqual({ currency: "EUR", date: "2026-11-01" });
    expect(valuationPendingScope({ currency: "eur'; drop", date: "2026" })).toEqual({});
    await env.db.delete(jobs);
    await ensureSchedules(env.db);
    expect(await env.db.select().from(jobs)).toHaveLength(0);
    const p = await product(env.db);
    await move(env.db, { stockItemId: p.stockItemId, type: "receipt_manual", onHandDelta: 2, unitCost: "5.00", costCurrency: "PLN", reason: "purchase" });
    await ensureSchedules(env.db);
    await ensureSchedules(env.db);
    const queued = await env.db.select().from(jobs);
    expect(queued.map((j) => j.type)).toEqual([FINANCE_JOB.valuationPending]);
    await h[FINANCE_JOB.valuationPending]!.run(queued[0]!);
    expect(await costState(env.db, p.stockItemId)).toMatchObject({ unknownQty: 2 });
  });
});

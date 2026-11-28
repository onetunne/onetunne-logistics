/**
 * Етап 6 (WP0): I17 (docs/stage6-design.md §15) — перелік таблиць без store_id = рівно винятки §15; кожна інша нова
 * фінансова таблиця має store_id (text, not null, default 'default', FK stores); бізнесові унікальні ключі фінансових
 * таблиць включають store_id (або це задокументовані глобальні id).
 */
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { allTables, nameOf, STAGE6_TABLES } from "./stage6-tables";

/** §15: рівно ці фінансові таблиці без store_id (а) глобальні, (б) облік собівартості за складом, (в) дочірні. */
const WITHOUT_STORE_ID = [
  "stores",
  "fx_rates",
  "inventory_cost_state",
  "inventory_cost_layers",
  "inventory_valuations",
  "inventory_valuation_completions",
  "stock_item_costs",
  "order_finance_forecasts",
  "carrier_invoice_lines",
  "finance_expense_allocations",
  "order_refund_lines",
  "order_return_lines",
  "partner_rates",
].sort();

/** Навмисно глобальні унікальні ключі (§15): uuid форми, event_key з глобальних id, GID/uuid у ключах. */
const GLOBAL_UNIQUE_OK = new Set([
  "fx_conversions.operation_id",
  "carrier_invoices.operation_id",
  "finance_expenses.operation_id",
  "partner_payouts.operation_id",
  "partner_commission_events.idempotency_key",
  "order_returns.source_key",
  "stores.shop_domain",
]);

describe("I17: store scope of the stage-6 tables", () => {
  const stage6 = allTables.filter((t) => STAGE6_TABLES.includes(nameOf(t)));

  it("the schema has exactly the stage-6 tables of §17", () => {
    expect(stage6.map(nameOf).sort()).toEqual(STAGE6_TABLES);
  });

  it("every new finance table has store_id (text, not null, default 'default', FK stores) — except exactly §15", () => {
    const without = stage6.filter((t) => !getTableConfig(t).columns.some((c) => c.name === "store_id")).map(nameOf).sort();
    expect(without).toEqual(WITHOUT_STORE_ID);
    for (const t of stage6) {
      const cfg = getTableConfig(t);
      const col = cfg.columns.find((c) => c.name === "store_id");
      if (!col) continue;
      expect(col.notNull, cfg.name).toBe(true);
      // finance_state: store_id — первинний ключ (рядок на магазин), без типового значення.
      if (cfg.name !== "finance_state") expect(col.default, cfg.name).toBe("default");
      expect(
        cfg.foreignKeys.some((fk) => fk.reference().columns.some((c) => c.name === "store_id") && getTableConfig(fk.reference().foreignTable).name === "stores"),
        cfg.name,
      ).toBe(true);
    }
  });

  it("business unique keys of store-scoped tables include store_id (or are documented global ids)", () => {
    const offenders: string[] = [];
    for (const t of stage6) {
      const cfg = getTableConfig(t);
      if (!cfg.columns.some((c) => c.name === "store_id")) continue;
      for (const c of cfg.columns) if (c.isUnique && !GLOBAL_UNIQUE_OK.has(`${cfg.name}.${c.name}`)) offenders.push(`${cfg.name}.${c.name}`);
      for (const idx of cfg.indexes) {
        if (!idx.config.unique) continue;
        const cols = idx.config.columns.map((c) => ("name" in c ? (c as { name: string }).name : "expr"));
        const pkLike = cols.length === 1 && cols[0] === "seq";
        if (!cols.includes("store_id") && !pkLike) offenders.push(`${cfg.name}: ${idx.config.name}`);
      }
    }
    // Унікальність у межах батьківського рядка (замовлення/відправлення одного магазину) — успадковує магазин.
    expect(offenders.sort()).toEqual([
      "finance_entries: finance_entries_reverses_uq",
      "order_external_waybills: order_external_waybills_uq",
      "shipment_cost_estimates: shipment_cost_estimates_uq",
      "shipping_forecast_snapshots: shipping_forecast_snapshots_uq",
    ]);
  });
});

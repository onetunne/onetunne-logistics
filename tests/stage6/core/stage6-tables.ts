/**
 * Етап 6 (WP0): спільний перелік таблиць етапу 6 (міграція 0012) для тестів схеми store-scope.test.ts (I17) і
 * demo-reset.test.ts. Нова таблиця етапу 6 → рядок тут (інакше обидва тести впадуть).
 */
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "~/db/schema";

export const allTables = (Object.values(schema) as unknown[]).filter((v): v is PgTable => v instanceof PgTable);
export const nameOf = (t: PgTable) => getTableConfig(t).name;

/** Таблиці етапу 6 (міграція 0012). */
export const STAGE6_TABLES = [
  "stores",
  "finance_state",
  "finance_entries",
  "order_finance",
  "order_finance_forecasts",
  "finance_change_log",
  "finance_discrepancies",
  "finance_periods",
  "finance_report_snapshots",
  "fx_rates",
  "fx_conversions",
  "order_shopify_finance",
  "order_sales",
  "order_transactions",
  "order_transaction_fees",
  "order_refunds",
  "order_refund_lines",
  "order_disputes",
  "inventory_cost_state",
  "inventory_cost_layers",
  "inventory_valuations",
  "inventory_valuation_completions",
  "stock_item_costs",
  "shipment_cost_estimates",
  "shipping_forecast_snapshots",
  "order_external_waybills",
  "carrier_import_profiles",
  "carrier_invoices",
  "carrier_invoice_lines",
  "finance_expenses",
  "finance_expense_allocations",
  "finance_fee_rules",
  "partners",
  "partner_codes",
  "partner_rates",
  "partner_attributions",
  "partner_commission_events",
  "partner_payouts",
  "order_returns",
  "order_return_lines",
].sort();
